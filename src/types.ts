/**
 * linux.js — Type definitions.
 *
 * The TypeScript wrapper around the LKL WASM kernel binary.
 * License: MIT (this file is the arm's-length JS API; the kernel binary
 * is GPL v2 and lives separately as lkl.wasm).
 */

/** Configuration options for creating a Linux instance. */
export interface LinuxConfig {
  /** Kernel RAM in MB. Default 128, clamped to [32, 4096]. */
  memory?: number;

  /**
   * URL or path to the Emscripten-generated loader (`lkl.js`).
   * The loader, in turn, references `lkl.wasm` and the pthread worker.
   * Default: resolved relative to the package, then `./lkl.js`.
   */
  wasmBinary?: string;

  /** Extra kernel command-line parameters appended after the defaults. */
  kernelCmdline?: string;
  /**
   * Mirror kernel console output to stderr as it is produced (including
   * during boot, before `kernelLog()` is reachable). Off by default.
   */
  debug?: boolean;

  /**
   * @deprecated Unused: exec() is unavailable in this build (no guest
   * userland). Kept so existing configs type-check.
   */
  commandTimeout?: number;

  /**
   * @deprecated Unused: boot runs synchronously to completion (or throws
   * KernelPanicError) and there is no shell prompt to wait for.
   */
  bootTimeout?: number;

  /**
   * Enable networking. Maps to LKL's host network ops.
   * In Node this uses the host's TCP stack; in a browser this requires a
   * WebSocket relay (set `networkProxyUrl`).
   */
  networking?: boolean;

  /** WebSocket URL for the networking relay (browser mode). */
  networkProxyUrl?: string;

  /** Receives raw bytes the kernel writes to the host console. */
  onOutput?: (data: string) => void;

  /** Fired once when init's shell prompt is detected. */
  onReady?: () => void;

  /** Fired if the kernel panics or the WASM module aborts. */
  onCrash?: (err: Error) => void;
}

/** Result of a command execution inside the kernel. */
export interface ExecResult {
  /** Combined stdout (LKL exposes a single console stream). */
  stdout: string;
  /** Always empty in the current console-multiplexed mode; kept for API stability. */
  stderr: string;
  /** Exit code from `$?` inside the guest shell. -1 if the call failed before exit was captured. */
  exitCode: number;
  /** True if the command did not produce a sentinel within `timeout` ms. */
  timedOut: boolean;
  /** Wall-clock duration in ms. */
  duration: number;
}

/** Filesystem entry returned by `readdir`. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  /** Unix `st_mode` (permissions + type bits). */
  mode: number;
}

/** Stats about a running Linux instance. */
export interface LinuxStats {
  /** ms since boot completed. */
  uptime: number;
  /** Total guest RAM in bytes. */
  memoryTotal: number;
  /** True between successful boot and shutdown. */
  running: boolean;
  /** Number of `exec()` calls completed (always 0: no guest userland). */
  commandsExecuted: number;
  /** Cached value of /proc/version. */
  kernelVersion?: string;
  /** Host threads backing the kernel (kernel threads + timers): live and peak. */
  hostThreads?: { live: number; peak: number };
}

/**
 * Low-level interface to the Emscripten-compiled LKL kernel module.
 *
 * Function names with a leading underscore are the raw C exports.
 * The non-underscored ones come from Emscripten's runtime helpers.
 */
export interface LklWasmModule {
  /** Boot the kernel. Returns 0 on success, negative on failure. */
  _linuxjs_boot(memoryMb: number, cmdline: number): number;

  /**
   * Write bytes to init's stdin. Returns bytes written, or negative on error.
   * Non-blocking; the kernel buffers up to ~64 KB.
   */
  _lkl_send_input(data: number, len: number): number;

  /**
   * Copy pending kernel console output into a host buffer. Returns bytes copied.
   * Drains the buffer; subsequent calls return only new output.
   */
  _lkl_drain_output(buf: number, bufSize: number): number;

  /** Write a file using `lkl_sys_open`/`lkl_sys_write`. */
  _lkl_write_file(path: number, data: number, len: number, append: number): number;

  /** Read a file using `lkl_sys_open`/`lkl_sys_read`. */
  _lkl_read_file(path: number, data: number, len: number, offLo: number, offHi: number): number;
  _linuxjs_kernel_panicked(): number;
  _linuxjs_host_threads(): number;
  _linuxjs_peak_host_threads(): number;
  _linuxjs_set_debug(on: number): void;

  /** Stat a path via `lkl_sys_statx`. */
  _lkl_stat(path: number, modeOut: number, sizeOut: number): number;

  /** List a directory via `lkl_sys_getdents64`. */
  _lkl_readdir(path: number, entriesBuf: number, bufSize: number): number;

  /** Create a directory (with parents, mkdir -p semantics). */
  _lkl_mkdir(path: number): number;

  /** Remove a file or directory (set `recursive` to 1 for rm -rf). */
  _lkl_rm(path: number, recursive: number): number;

  /** Mount a filesystem via `lkl_sys_mount`. */
  _lkl_mount(source: number, target: number, fstype: number, flags: number, options: number): number;

  /** Halt the kernel and release the WASM instance. */
  _lkl_shutdown(): void;

  /** Pointer to the most recent error string (null-terminated, static lifetime). */
  _lkl_get_last_error(): number;

  /** Heap allocation in WASM linear memory. */
  _malloc(size: number): number;
  /** Heap free. */
  _free(ptr: number): void;

  /** WASM linear memory. */
  /** Exported via EXPORTED_RUNTIME_METHODS; always reflects the current size. */
  wasmMemory: WebAssembly.Memory;

  /** Emscripten string helpers. */
  stringToUTF8(str: string, ptr: number, maxBytes: number): void;
  UTF8ToString(ptr: number, maxBytesToRead?: number): string;
  lengthBytesUTF8(str: string): number;
  ccall(ident: string, returnType: string, argTypes: string[], args: unknown[]): unknown;
  cwrap(ident: string, returnType: string, argTypes: string[]): (...args: unknown[]) => unknown;
}

/** Emscripten module factory. */
export type LklWasmModuleFactory = (
  moduleOverrides?: Partial<LklWasmModule>,
) => Promise<LklWasmModule>;

/** Event names emitted by the Linux instance (reserved for future EventEmitter API). */
export interface LinuxEvents {
  ready: [];
  output: [data: string];
  exit: [code: number];
  crash: [error: Error];
  boot: [];
}
