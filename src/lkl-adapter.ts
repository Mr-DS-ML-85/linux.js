/**
 * linux.js — Low-level bridge to the LKL WASM kernel module.
 *
 * Loads the Emscripten-built loader (lkl.js), boots the real Linux kernel
 * inside WASM, and exposes a small synchronous API that the higher-level
 * `Linux` class wraps.
 *
 * License: MIT. The kernel binary it loads is GPL v2; this file talks to
 * it through a documented C ABI and is not a derivative work.
 */

import type { LklWasmModule, LklWasmModuleFactory } from './types.js';
import { capabilities, defaultLoaderHint } from './runtime.js';
import { KernelPanicError } from './errors.js';
import { KernelSyscalls } from './wasi/kernel.js';

/** Buffer for short UTF-8 string arguments (paths, commands < 4 KB). */
const FIXED_BUF_SIZE = 4096;

/** Drained kernel console capacity per call. 1 MB matches the host-side buffer. */
const OUTPUT_BUF_SIZE = 1024 * 1024;

/** Initial `readdir` result buffer; grown on demand up to READDIR_MAX_SIZE. */
const READDIR_BUF_SIZE = 64 * 1024;
const READDIR_MAX_SIZE = 64 * 1024 * 1024;

/** Buffer size for a single file read/write chunk. */
const FILE_BUF_SIZE = 64 * 1024;

/**
 * Bridge between TS and the LKL WASM module.
 *
 * Owns the WASM linear-memory scratch buffers. All methods are synchronous
 * because the underlying C calls block until the kernel finishes the syscall.
 */
export class LklAdapter {
  private module: LklWasmModule | null = null;
  private initialized = false;

  // Pre-allocated scratch pointers (single malloc per buffer, freed at shutdown).
  private fixedBufPtr = 0;
  private outputBufPtr = 0;
  private readdirBufPtr = 0;
  private fileBufPtr = 0;
  private statModePtr = 0;
  private statSizePtr = 0;

  private allocatedPtrs: number[] = [];
  private syscalls: KernelSyscalls | null = null;

  /**
   * Resolve and load the Emscripten loader, then run it to instantiate the
   * WASM kernel module.
   *
   * @param wasmSource Optional explicit path to `lkl.js` (the Emscripten loader,
   * not the raw `.wasm`). If omitted, the loader is resolved next to this
   * file inside the published package.
   */
  async load(wasmSource?: string): Promise<void> {
    if (this.module) return;
    if (!capabilities().threads) {
      throw new Error(
        'linux.js: this runtime lacks SharedArrayBuffer/Worker support, which the kernel ' +
        'needs for its threads. In browsers, serve the page with ' +
        '"Cross-Origin-Opener-Policy: same-origin" and ' +
        '"Cross-Origin-Embedder-Policy: require-corp".',
      );
    }

    const loaderUrl = await this.resolveLoaderUrl(wasmSource);
    const mod = await this.instantiate(loaderUrl);

    this.module = mod;
    this.allocateScratchBuffers(mod);
  }

  /** Boot the LKL kernel. Must be called after `load()`. */
  boot(memoryMb: number, cmdline?: string, debug = false): void {
    const mod = this.assertLoaded();
    if (this.initialized) return;
    mod._linuxjs_set_debug(debug ? 1 : 0);

    const cmdlinePtr = cmdline ? this.encodeStringInto(mod, cmdline, this.fixedBufPtr) : 0;
    let result: number;
    try {
      result = mod._linuxjs_boot(memoryMb, cmdlinePtr);
    } catch (err) {
      // A kernel panic traps the calling thread (see host_panic in the C
      // adapter). Surface it with the console log instead of a bare trap.
      if (this.kernelPanicked()) throw new KernelPanicError(this.drainOutput(), err);
      throw err;
    }

    if (result < 0) {
      throw new Error(`LKL kernel boot failed: ${this.lastError(mod)}\n${this.drainOutput().slice(-4096)}`);
    }
    this.initialized = true;
  }

  /**
   * Write raw bytes to init's stdin (the guest shell).
   * Used by `Linux.exec` to inject commands + sentinels.
   */
  sendInput(bytes: Uint8Array): number {
    const mod = this.assertReady();

    // For short inputs we reuse the fixed buffer to avoid malloc churn.
    if (bytes.length <= FIXED_BUF_SIZE) {
      new Uint8Array(mod.wasmMemory.buffer).set(bytes, this.fixedBufPtr);
      const n = mod._lkl_send_input(this.fixedBufPtr, bytes.length);
      if (n < 0) throw new Error(`send_input failed: ${this.lastError(mod)}`);
      return n;
    }

    // Larger payloads (e.g. base64-encoded file blobs) use the file buffer.
    let total = 0;
    for (let off = 0; off < bytes.length; off += FILE_BUF_SIZE) {
      const chunk = bytes.subarray(off, off + FILE_BUF_SIZE);
      new Uint8Array(mod.wasmMemory.buffer).set(chunk, this.fileBufPtr);
      const n = mod._lkl_send_input(this.fileBufPtr, chunk.length);
      if (n < 0) throw new Error(`send_input failed: ${this.lastError(mod)}`);
      total += n;
    }
    return total;
  }

  /** Typed raw-syscall access for the WASI userland (created on first use). */
  kernel(): KernelSyscalls {
    if (!this.syscalls) this.syscalls = new KernelSyscalls(this.assertReady());
    return this.syscalls;
  }

  /** Host threads backing the kernel: currently live and the peak so far. */
  hostThreads(): { live: number; peak: number } {
    const mod = this.assertLoaded();
    return { live: mod._linuxjs_host_threads(), peak: mod._linuxjs_peak_host_threads() };
  }

  /** True once the guest kernel has panicked; the instance is unusable after that. */
  kernelPanicked(): boolean {
    return this.module ? this.module._linuxjs_kernel_panicked() !== 0 : false;
  }

  /** Drain any output the kernel console has produced since the last call. */
  drainOutput(): string {
    const mod = this.assertLoaded();
    const n = mod._lkl_drain_output(this.outputBufPtr, OUTPUT_BUF_SIZE);
    if (n <= 0) return '';
    // slice(): wasm memory is a SharedArrayBuffer under pthreads, and
    // browsers' TextDecoder rejects shared views.
    const bytes = new Uint8Array(mod.wasmMemory.buffer, this.outputBufPtr, n).slice();
    return new TextDecoder().decode(bytes);
  }

  /** Write a file via direct `lkl_sys_write`. */
  writeFile(path: string, data: Uint8Array | string): number {
    const mod = this.assertReady();
    const pathPtr = this.encodeStringInto(mod, path, this.fixedBufPtr);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

    // First chunk creates/truncates, later chunks append. (Truncating on
    // every chunk used to leave only the last 64 KB of large files.) An
    // empty payload still runs once so the file is created/truncated.
    let cursor = 0;
    do {
      const chunk = bytes.subarray(cursor, cursor + FILE_BUF_SIZE);
      new Uint8Array(mod.wasmMemory.buffer).set(chunk, this.fileBufPtr);
      const written = mod._lkl_write_file(pathPtr, this.fileBufPtr, chunk.length, cursor === 0 ? 0 : 1);
      if (written < 0) {
        throw new Error(`writeFile('${path}') failed at offset ${cursor}: ${this.lastError(mod)}`);
      }
      if (written !== chunk.length) {
        throw new Error(`writeFile('${path}') short write at offset ${cursor}: ${written}/${chunk.length}`);
      }
      cursor += written;
    } while (cursor < bytes.length);
    return cursor;
  }

  /** Read a file via direct `lkl_sys_read`. Streams in 64 KB chunks. */
  readFile(path: string): Uint8Array {
    const mod = this.assertReady();
    const pathPtr = this.encodeStringInto(mod, path, this.fixedBufPtr);

    // Read chunk by chunk at an advancing offset. (Without the offset every
    // call re-read the first chunk, so files >= 64 KB looped forever.)
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (true) {
      const lo = offset % 0x1_0000_0000;
      const hi = Math.floor(offset / 0x1_0000_0000);
      const n = mod._lkl_read_file(pathPtr, this.fileBufPtr, FILE_BUF_SIZE, lo, hi);
      if (n < 0) {
        throw new Error(`readFile('${path}') failed: ${this.lastError(mod)}`);
      }
      if (n === 0) break;
      // Copy out before the next call overwrites the buffer.
      chunks.push(new Uint8Array(mod.wasmMemory.buffer, this.fileBufPtr, n).slice());
      offset += n;
      if (n < FILE_BUF_SIZE) break;
    }

    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /** Read a text file (UTF-8). */
  readTextFile(path: string): string {
    return new TextDecoder().decode(this.readFile(path));
  }

  /** Stat a path. Returns null if it does not exist. */
  stat(path: string): { mode: number; size: number } | null {
    const mod = this.assertReady();
    const pathPtr = this.encodeStringInto(mod, path, this.fixedBufPtr);
    const result = mod._lkl_stat(pathPtr, this.statModePtr, this.statSizePtr);
    if (result < 0) return null;

    const view = new DataView(mod.wasmMemory.buffer);
    return {
      mode: view.getInt32(this.statModePtr, true),
      size: Number(view.getBigInt64(this.statSizePtr, true)),
    };
  }

  /** List a directory. Returns just the names; callers can stat each entry. */
  readdir(path: string): string[] {
    const mod = this.assertReady();
    const pathPtr = this.encodeStringInto(mod, path, this.fixedBufPtr);
    // Start with the scratch buffer; on -2 (too small) retry with a
    // doubling one-shot buffer instead of returning a truncated listing.
    let bufPtr = this.readdirBufPtr;
    let bufSize = READDIR_BUF_SIZE;
    let n = mod._lkl_readdir(pathPtr, bufPtr, bufSize);
    while (n === -2 && bufSize < READDIR_MAX_SIZE) {
      if (bufPtr !== this.readdirBufPtr) mod._free(bufPtr);
      bufSize *= 2;
      bufPtr = mod._malloc(bufSize);
      if (!bufPtr) throw new Error(`readdir('${path}') failed: out of memory`);
      n = mod._lkl_readdir(pathPtr, bufPtr, bufSize);
    }
    let buf: Uint8Array;
    try {
      if (n < 0) throw new Error(`readdir('${path}') failed: ${this.lastError(mod)}`);
      buf = new Uint8Array(mod.wasmMemory.buffer, bufPtr, n).slice();
    } finally {
      if (bufPtr !== this.readdirBufPtr) mod._free(bufPtr);
    }
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0) {
        if (i > start) {
          out.push(new TextDecoder().decode(buf.subarray(start, i)));
        }
        start = i + 1;
      }
    }
    return out;
  }

  mkdir(path: string): void {
    const mod = this.assertReady();
    const pathPtr = this.encodeStringInto(mod, path, this.fixedBufPtr);
    if (mod._lkl_mkdir(pathPtr) < 0) {
      throw new Error(`mkdir('${path}') failed: ${this.lastError(mod)}`);
    }
  }

  rm(path: string, recursive = false): void {
    const mod = this.assertReady();
    const pathPtr = this.encodeStringInto(mod, path, this.fixedBufPtr);
    if (mod._lkl_rm(pathPtr, recursive ? 1 : 0) < 0) {
      throw new Error(`rm('${path}') failed: ${this.lastError(mod)}`);
    }
  }

  mount(source: string, target: string, fstype: string, flags = 0, options?: string): void {
    const mod = this.assertReady();
    // Each string needs its own slot — the fixed buffer is single-use per call,
    // so we allocate one-shot buffers and free them at shutdown.
    const srcPtr = this.allocCString(mod, source);
    const tgtPtr = this.allocCString(mod, target);
    const typePtr = this.allocCString(mod, fstype);
    const optsPtr = options ? this.allocCString(mod, options) : 0;
    try {
      if (mod._lkl_mount(srcPtr, tgtPtr, typePtr, flags, optsPtr) < 0) {
        throw new Error(`mount(${source} -> ${target}, ${fstype}) failed: ${this.lastError(mod)}`);
      }
    } finally {
      this.freePtr(mod, srcPtr);
      this.freePtr(mod, tgtPtr);
      this.freePtr(mod, typePtr);
      if (optsPtr) this.freePtr(mod, optsPtr);
    }
  }

  shutdown(): void {
    if (this.module && this.initialized) {
      this.module._lkl_shutdown();
      this.initialized = false;
    }
    this.releaseScratchBuffers();
  }

  isRunning(): boolean {
    return this.initialized && this.module !== null;
  }

  getKernelVersion(): string {
    try {
      return this.readTextFile('/proc/version').trim();
    } catch {
      return 'unknown';
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private assertLoaded(): LklWasmModule {
    if (!this.module) {
      throw new Error('linux.js: WASM module not loaded. Call load() first.');
    }
    return this.module;
  }

  private assertReady(): LklWasmModule {
    const mod = this.assertLoaded();
    if (!this.initialized) {
      throw new Error('linux.js: kernel not booted. Call boot() first.');
    }
    return mod;
  }

  private allocateScratchBuffers(mod: LklWasmModule): void {
    this.fixedBufPtr = mod._malloc(FIXED_BUF_SIZE);
    this.outputBufPtr = mod._malloc(OUTPUT_BUF_SIZE);
    this.readdirBufPtr = mod._malloc(READDIR_BUF_SIZE);
    this.fileBufPtr = mod._malloc(FILE_BUF_SIZE);
    this.statModePtr = mod._malloc(4);
    this.statSizePtr = mod._malloc(8);
    this.allocatedPtrs.push(
      this.fixedBufPtr,
      this.outputBufPtr,
      this.readdirBufPtr,
      this.fileBufPtr,
      this.statModePtr,
      this.statSizePtr,
    );
  }

  private releaseScratchBuffers(): void {
    if (!this.module) return;
    const mod = this.module;
    for (const ptr of this.allocatedPtrs) {
      try { mod._free(ptr); } catch { /* shutdown is best-effort */ }
    }
    this.allocatedPtrs.length = 0;
  }

  /** Write a string into a caller-supplied scratch slot. Returns the slot pointer. */
  private encodeStringInto(mod: LklWasmModule, str: string, slot: number): number {
    const needed = mod.lengthBytesUTF8(str) + 1;
    if (needed > FIXED_BUF_SIZE) {
      // Should be rare — paths > 4 KB. Fall through to a one-shot alloc.
      return this.allocCString(mod, str);
    }
    mod.stringToUTF8(str, slot, FIXED_BUF_SIZE);
    return slot;
  }

  private allocCString(mod: LklWasmModule, str: string): number {
    const needed = mod.lengthBytesUTF8(str) + 1;
    const ptr = mod._malloc(needed);
    this.allocatedPtrs.push(ptr);
    mod.stringToUTF8(str, ptr, needed);
    return ptr;
  }

  private freePtr(mod: LklWasmModule, ptr: number): void {
    mod._free(ptr);
    const idx = this.allocatedPtrs.indexOf(ptr);
    if (idx >= 0) this.allocatedPtrs.splice(idx, 1);
  }

  private lastError(mod: LklWasmModule): string {
    const errPtr = mod._lkl_get_last_error();
    if (!errPtr) return 'unknown error';
    return mod.UTF8ToString(errPtr, 256);
  }

  /**
   * Resolve the loader URL. We prefer a path next to this module (so the
   * published `dist/lkl.js` works in Node and bundlers), falling back to
   * `./lkl.js` when no hint is available.
   */
  private async resolveLoaderUrl(wasmSource?: string): Promise<string> {
    if (wasmSource) {
      return wasmSource.endsWith('.wasm') ? wasmSource.replace(/\.wasm$/, '.js') : wasmSource;
    }

    const preferred = defaultLoaderHint();

    // In Node, resolve relative to the package root so consumers don't have
    // to know the dist layout.
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { fileURLToPath, pathToFileURL } = await import('node:url');
      const { existsSync } = await import('node:fs');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const roots = [join(here, '..'), here, join(here, '..', '..')];
      for (const root of roots) {
        const p = join(root, preferred);
        if (existsSync(p)) return pathToFileURL(p).href;
      }
    }

    return `./${preferred}`;
  }

  private async instantiate(loaderUrl: string): Promise<LklWasmModule> {
    try {
      const mod = (await import(/* @vite-ignore */ loaderUrl)) as { default?: LklWasmModuleFactory } & Record<string, unknown>;
      const factory = (mod.default ?? (mod as unknown as LklWasmModuleFactory));
      if (typeof factory !== 'function') {
        throw new Error(`loader at ${loaderUrl} did not export a module factory`);
      }
      return await factory();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `linux.js: failed to load the LKL WASM module.\n` +
        `  Tried: ${loaderUrl}\n` +
        `  Reason: ${reason}\n\n` +
        `Build the kernel:        node scripts/build-lkl.mjs\n` +
        `Or download a prebuilt:  node scripts/build-lkl.mjs --download`,
      );
    }
  }
}
