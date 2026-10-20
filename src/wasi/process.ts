/**
 * linux.js — a WASI preview1 process backed by the guest Linux kernel.
 *
 * Each WASI call a program makes (path_open, fd_read, fd_readdir, ...) is
 * served by a real syscall in the LKL kernel through KernelSyscalls. The
 * process has its own fd table; kernel fds it opens are closed when it
 * exits. stdio is either an in-memory buffer (pipes / captured output) or a
 * kernel fd the shell opened (redirections).
 *
 * Programs run synchronously on the calling thread. A deadline is checked
 * on every WASI call, so a timed-out program is stopped at its next
 * syscall; a pure CPU loop that never calls into WASI cannot be preempted.
 *
 * License: MIT.
 */

import {
  AT_EMPTY_PATH, AT_FDCWD, AT_REMOVEDIR, AT_SYMLINK_FOLLOW, AT_SYMLINK_NOFOLLOW,
  E, KernelSyscalls, O, type Dirent, type Statx,
} from './kernel.js';
import {
  Clock, EventType, FdFlags, Filetype, FstFlags, LOOKUP_SYMLINK_FOLLOW, OFlags,
  Rights, WasiErrno, filetypeFromDtype, filetypeFromMode, wasiErrno,
} from './constants.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Destination for a process's output. `write` returns false once the reader is gone (EPIPE). */
export interface OutputSink {
  write(data: Uint8Array): boolean;
}

/** Collects output up to `limit` bytes; past that, writes fail with EPIPE. */
export class BufferSink implements OutputSink {
  private chunks: Uint8Array[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit = 64 * 1024 * 1024, private readonly onData?: (d: Uint8Array) => void) {}

  write(data: Uint8Array): boolean {
    if (this.size >= this.limit) { this.truncated = true; return false; }
    const room = this.limit - this.size;
    const part = data.length > room ? data.slice(0, room) : data.slice();
    this.chunks.push(part);
    this.size += part.length;
    this.onData?.(part);
    if (part.length < data.length) { this.truncated = true; return false; }
    return true;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  text(): string {
    return dec.decode(this.bytes());
  }
}

/** An fd table entry. */
export type FdEntry =
  | { kind: 'input'; data: Uint8Array; pos: number }
  | { kind: 'sink'; sink: OutputSink }
  | { kind: 'kernel'; fd: number; isDir: boolean; owned: boolean; append: boolean; preopen?: string; dirents?: Dirent[] };

export interface ProcessOptions {
  args: string[];
  env: Record<string, string>;
  stdin: FdEntry;
  stdout: FdEntry;
  stderr: FdEntry;
  /** Absolute ms timestamp after which the process is stopped (exit 124). */
  deadline?: number;
}

/** Thrown by proc_exit to unwind out of the program. */
export class WasiExit {
  constructor(readonly code: number) {}
}

/** Thrown when the process passes its deadline. */
export class WasiTimeout extends Error {
  constructor() { super('process timed out'); this.name = 'WasiTimeout'; }
}

const SLEEP_CELL = typeof SharedArrayBuffer !== 'undefined' ? new Int32Array(new SharedArrayBuffer(4)) : null;

export class WasiProcess {
  private readonly fds = new Map<number, FdEntry>();
  private memory: WebAssembly.Memory | null = null;
  private nextFd = 3;

  constructor(private readonly k: KernelSyscalls, private readonly opts: ProcessOptions) {
    this.fds.set(0, opts.stdin);
    this.fds.set(1, opts.stdout);
    this.fds.set(2, opts.stderr);
    const root = k.openat(AT_FDCWD, '/', O.RDONLY | O.DIRECTORY);
    if (root < 0) throw new Error(`linux.js: cannot open / for WASI preopen (errno ${-root})`);
    this.fds.set(this.nextFd++, { kind: 'kernel', fd: root, isDir: true, owned: true, append: false, preopen: '/' });
  }

  /**
   * Run the program to completion. Returns its exit status (124 on
   * timeout, 134 if the program trapped — the trap is reported on stderr).
   */
  run(module: WebAssembly.Module): number {
    try {
      const instance = new WebAssembly.Instance(module, this.imports(module));
      const exp = instance.exports as Record<string, unknown>;
      this.memory = exp.memory as WebAssembly.Memory;
      if (typeof exp._start === 'function') {
        (exp._start as () => void)();
      } else if (typeof exp._initialize === 'function') {
        (exp._initialize as () => void)();
      } else {
        throw new Error('not a WASI command module (no _start export)');
      }
      return 0;
    } catch (err) {
      if (err instanceof WasiExit) return err.code;
      if (err instanceof WasiTimeout) {
        this.writeStderr(`${this.opts.args[0]}: timed out\n`);
        return 124;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.writeStderr(`${this.opts.args[0]}: ${err instanceof WebAssembly.RuntimeError ? 'crashed' : 'failed'}: ${msg}\n`);
      return 134;
    } finally {
      this.closeAll();
    }
  }

  // ─── plumbing ──────────────────────────────────────────────────────

  private closeAll(): void {
    for (const e of this.fds.values()) {
      if (e.kind === 'kernel' && e.owned) this.k.close(e.fd);
    }
    this.fds.clear();
  }

  private writeStderr(text: string): void {
    const e = this.opts.stderr;
    const data = enc.encode(text);
    if (e.kind === 'sink') e.sink.write(data);
    else if (e.kind === 'kernel') this.k.write(e.fd, data);
  }

  private u8(): Uint8Array { return new Uint8Array(this.memory!.buffer); }
  private dv(): DataView { return new DataView(this.memory!.buffer); }
  private str(ptr: number, len: number): string { return dec.decode(this.u8().subarray(ptr, ptr + len)); }

  private checkDeadline(): void {
    if (this.opts.deadline !== undefined && Date.now() > this.opts.deadline) throw new WasiTimeout();
  }

  private dir(fd: number): number | null {
    const e = this.fds.get(fd);
    return e && e.kind === 'kernel' && e.isDir ? e.fd : null;
  }

  private alloc(entry: FdEntry): number {
    while (this.fds.has(this.nextFd)) this.nextFd++;
    const fd = this.nextFd++;
    this.fds.set(fd, entry);
    return fd;
  }

  private writeFilestat(ptr: number, st: Statx): void {
    const v = this.dv();
    v.setBigUint64(ptr, st.dev, true);
    v.setBigUint64(ptr + 8, st.ino, true);
    v.setUint8(ptr + 16, filetypeFromMode(st.mode));
    v.setBigUint64(ptr + 24, BigInt(st.nlink), true);
    v.setBigUint64(ptr + 32, st.size, true);
    v.setBigUint64(ptr + 40, st.atimeNs, true);
    v.setBigUint64(ptr + 48, st.mtimeNs, true);
    v.setBigUint64(ptr + 56, st.ctimeNs, true);
  }

  private iovs(ptr: number, len: number): Array<[number, number]> {
    const v = this.dv();
    const out: Array<[number, number]> = [];
    for (let i = 0; i < len; i++) out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]);
    return out;
  }

  private timeArg(flags: number, setBit: number, nowBit: number, value: bigint): bigint | 'now' | null {
    if (flags & nowBit) return 'now';
    if (flags & setBit) return value;
    return null;
  }

  // ─── imports ───────────────────────────────────────────────────────

  private imports(module: WebAssembly.Module): WebAssembly.Imports {
    const impl = this.impl();
    const wrapped: Record<string, (...a: never[]) => number> = {};
    for (const [name, fn] of Object.entries(impl)) {
      wrapped[name] = (...a: never[]) => { this.checkDeadline(); return (fn as (...x: never[]) => number)(...a); };
    }
    // Anything the module imports that we don't implement → ENOSYS stub.
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === 'wasi_snapshot_preview1' && imp.kind === 'function' && !(imp.name in wrapped)) {
        wrapped[imp.name] = () => WasiErrno.NOSYS;
      }
    }
    return { wasi_snapshot_preview1: wrapped };
  }

  private impl(): Record<string, (...args: never[]) => number> {
    const k = this.k;
    const S = WasiErrno.SUCCESS;

    const fns = {
      // ── args / env ──
      args_sizes_get: (argcPtr: number, bufSizePtr: number) => {
        const v = this.dv();
        v.setUint32(argcPtr, this.opts.args.length, true);
        v.setUint32(bufSizePtr, this.opts.args.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
        return S;
      },
      args_get: (argvPtr: number, bufPtr: number) => this.putStrings(this.opts.args, argvPtr, bufPtr),
      environ_sizes_get: (countPtr: number, bufSizePtr: number) => {
        const env = this.envList();
        const v = this.dv();
        v.setUint32(countPtr, env.length, true);
        v.setUint32(bufSizePtr, env.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
        return S;
      },
      environ_get: (envPtr: number, bufPtr: number) => this.putStrings(this.envList(), envPtr, bufPtr),

      // ── clocks / random / sched ──
      clock_res_get: (_id: number, resPtr: number) => { this.dv().setBigUint64(resPtr, 1000n, true); return S; },
      clock_time_get: (id: number, _precision: bigint, timePtr: number) => {
        this.dv().setBigUint64(timePtr, nowNs(id), true);
        return S;
      },
      random_get: (ptr: number, len: number) => {
        const buf = this.u8();
        for (let off = 0; off < len; off += 65536) {
          const n = Math.min(65536, len - off);
          const tmp = new Uint8Array(n);
          globalThis.crypto.getRandomValues(tmp);
          buf.set(tmp, ptr + off);
        }
        return S;
      },
      sched_yield: () => S,
      proc_exit: (code: number) => { throw new WasiExit(code); },
      proc_raise: () => WasiErrno.NOTSUP,

      // ── fd ops ──
      fd_read: (fd: number, iovPtr: number, iovLen: number, nreadPtr: number) => {
        const e = this.fds.get(fd);
        if (!e) return WasiErrno.BADF;
        let total = 0;
        for (const [buf, len] of this.iovs(iovPtr, iovLen)) {
          if (len === 0) continue;
          const dest = this.u8().subarray(buf, buf + len);
          let n: number;
          if (e.kind === 'input') {
            n = Math.min(len, e.data.length - e.pos);
            dest.set(e.data.subarray(e.pos, e.pos + n));
            e.pos += n;
          } else if (e.kind === 'kernel') {
            if (e.isDir) return WasiErrno.ISDIR;
            n = k.read(e.fd, dest);
            if (n < 0) return total > 0 ? this.setU32(nreadPtr, total) : wasiErrno(n);
          } else {
            return WasiErrno.BADF;
          }
          total += n;
          if (n < len) break;
        }
        return this.setU32(nreadPtr, total);
      },
      fd_pread: (fd: number, iovPtr: number, iovLen: number, offset: bigint, nreadPtr: number) => {
        const e = this.fds.get(fd);
        if (!e) return WasiErrno.BADF;
        if (e.kind !== 'kernel') return WasiErrno.SPIPE;
        let total = 0;
        for (const [buf, len] of this.iovs(iovPtr, iovLen)) {
          if (len === 0) continue;
          const n = k.pread(e.fd, this.u8().subarray(buf, buf + len), offset + BigInt(total));
          if (n < 0) return total > 0 ? this.setU32(nreadPtr, total) : wasiErrno(n);
          total += n;
          if (n < len) break;
        }
        return this.setU32(nreadPtr, total);
      },
      fd_write: (fd: number, iovPtr: number, iovLen: number, nwrittenPtr: number) => {
        const e = this.fds.get(fd);
        if (!e) return WasiErrno.BADF;
        let total = 0;
        for (const [buf, len] of this.iovs(iovPtr, iovLen)) {
          if (len === 0) continue;
          const src = this.u8().subarray(buf, buf + len);
          if (e.kind === 'sink') {
            if (!e.sink.write(src)) return total > 0 ? this.setU32(nwrittenPtr, total) : WasiErrno.PIPE;
            total += len;
          } else if (e.kind === 'kernel') {
            const n = k.write(e.fd, src);
            if (n < 0) return total > 0 ? this.setU32(nwrittenPtr, total) : wasiErrno(n);
            total += n;
            if (n < len) break;
          } else {
            return WasiErrno.BADF;
          }
        }
        return this.setU32(nwrittenPtr, total);
      },
      fd_pwrite: (fd: number, iovPtr: number, iovLen: number, offset: bigint, nwrittenPtr: number) => {
        const e = this.fds.get(fd);
        if (!e) return WasiErrno.BADF;
        if (e.kind !== 'kernel') return WasiErrno.SPIPE;
        let total = 0;
        for (const [buf, len] of this.iovs(iovPtr, iovLen)) {
          if (len === 0) continue;
          const n = k.pwrite(e.fd, this.u8().subarray(buf, buf + len), offset + BigInt(total));
          if (n < 0) return total > 0 ? this.setU32(nwrittenPtr, total) : wasiErrno(n);
          total += n;
          if (n < len) break;
        }
        return this.setU32(nwrittenPtr, total);
      },
      fd_seek: (fd: number, offset: bigint, whence: number, newOffsetPtr: number) => {
        const e = this.fds.get(fd);
        if (!e) return WasiErrno.BADF;
        if (e.kind !== 'kernel') return WasiErrno.SPIPE;
        const r = k.seek(e.fd, offset, whence);
        if (typeof r === 'number') return wasiErrno(r);
        this.dv().setBigUint64(newOffsetPtr, BigInt.asUintN(64, r), true);
        return S;
      },
      fd_tell: (fd: number, offsetPtr: number) => fns.fd_seek(fd, 0n, 1, offsetPtr),
      fd_close: (fd: number) => {
        const e = this.fds.get(fd);
        if (!e) return WasiErrno.BADF;
        if (e.kind === 'kernel' && e.owned) k.close(e.fd);
        this.fds.delete(fd);
        return S;
      },
      fd_renumber: (from: number, to: number) => {
        const e = this.fds.get(from);
        if (!e || !this.fds.has(to)) return WasiErrno.BADF;
        if (from === to) return S;
        fns.fd_close(to);
        this.fds.set(to, e);
        this.fds.delete(from);
        return S;
      },
      fd_sync: (fd: number) => this.onKernelFd(fd, (kfd) => k.fsync(kfd)),
      fd_datasync: (fd: number) => this.onKernelFd(fd, (kfd) => k.fdatasync(kfd)),
      fd_advise: (fd: number, offset: bigint, len: bigint, advice: number) =>
        this.onKernelFd(fd, (kfd) => k.fadvise(kfd, offset, len, advice)),
      fd_allocate: () => WasiErrno.NOTSUP,
      fd_fdstat_get: (fd: number, ptr: number) => {
        const e = this.fds.get(fd);
        if (!e) return WasiErrno.BADF;
        let filetype: number = Filetype.UNKNOWN; // stdio buffers: not a tty, not seekable files
        let flags = 0;
        if (e.kind === 'kernel') {
          const st = k.statx(e.fd, '', AT_EMPTY_PATH);
          if (typeof st === 'number') return wasiErrno(st);
          filetype = filetypeFromMode(st.mode);
          if (e.append) flags |= FdFlags.APPEND;
        }
        const v = this.dv();
        v.setUint8(ptr, filetype);
        v.setUint16(ptr + 2, flags, true);
        v.setBigUint64(ptr + 8, Rights.ALL, true);
        v.setBigUint64(ptr + 16, Rights.ALL, true);
        return S;
      },
      fd_fdstat_set_flags: (fd: number, flags: number) => {
        const e = this.fds.get(fd);
        if (!e) return WasiErrno.BADF;
        if (e.kind !== 'kernel') return S;
        // Only toggling O_APPEND would matter; it isn't supported after open.
        return (flags & FdFlags.APPEND ? 1 : 0) === (e.append ? 1 : 0) ? S : WasiErrno.NOTSUP;
      },
      fd_fdstat_set_rights: () => S,
      fd_filestat_get: (fd: number, ptr: number) => {
        const e = this.fds.get(fd);
        if (!e) return WasiErrno.BADF;
        if (e.kind !== 'kernel') {
          this.u8().fill(0, ptr, ptr + 64);
          this.dv().setUint8(ptr + 16, Filetype.UNKNOWN);
          return S;
        }
        const st = k.statx(e.fd, '', AT_EMPTY_PATH);
        if (typeof st === 'number') return wasiErrno(st);
        this.writeFilestat(ptr, st);
        return S;
      },
      fd_filestat_set_size: (fd: number, size: bigint) => this.onKernelFd(fd, (kfd) => k.ftruncate(kfd, size)),
      fd_filestat_set_times: (fd: number, atim: bigint, mtim: bigint, fst: number) =>
        this.onKernelFd(fd, (kfd) => k.utimensat(kfd, null,
          this.timeArg(fst, FstFlags.ATIM, FstFlags.ATIM_NOW, atim),
          this.timeArg(fst, FstFlags.MTIM, FstFlags.MTIM_NOW, mtim))),
      fd_prestat_get: (fd: number, ptr: number) => {
        const e = this.fds.get(fd);
        if (!e || e.kind !== 'kernel' || !e.preopen) return WasiErrno.BADF;
        const v = this.dv();
        v.setUint8(ptr, 0);
        v.setUint32(ptr + 4, enc.encode(e.preopen).length, true);
        return S;
      },
      fd_prestat_dir_name: (fd: number, pathPtr: number, len: number) => {
        const e = this.fds.get(fd);
        if (!e || e.kind !== 'kernel' || !e.preopen) return WasiErrno.BADF;
        this.u8().set(enc.encode(e.preopen).subarray(0, len), pathPtr);
        return S;
      },
      fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, usedPtr: number) => {
        const e = this.fds.get(fd);
        if (!e || e.kind !== 'kernel') return WasiErrno.BADF;
        if (!e.isDir) return WasiErrno.NOTDIR;
        if (cookie === 0n || !e.dirents) {
          const list = k.readdirAll(e.fd);
          if (typeof list === 'number') return wasiErrno(list);
          e.dirents = list;
        }
        const mem = this.u8();
        const v = this.dv();
        let used = 0;
        for (let i = Number(cookie); i < e.dirents.length && used < bufLen; i++) {
          const d = e.dirents[i];
          const name = enc.encode(d.name);
          const header = new Uint8Array(24);
          const hv = new DataView(header.buffer);
          hv.setBigUint64(0, BigInt(i + 1), true);
          hv.setBigUint64(8, d.ino, true);
          hv.setUint32(16, name.length, true);
          hv.setUint8(20, filetypeFromDtype(d.type));
          const rec = new Uint8Array(24 + name.length);
          rec.set(header);
          rec.set(name, 24);
          const n = Math.min(rec.length, bufLen - used);
          mem.set(rec.subarray(0, n), buf + used);
          used += n;
        }
        v.setUint32(usedPtr, used, true);
        return S;
      },

      // ── path ops ──
      path_open: (dirfd: number, lookupFlags: number, pathPtr: number, pathLen: number,
        oflags: number, rightsBase: bigint, _rightsInh: bigint, fdflags: number, fdPtr: number) => {
        const kdir = this.dir(dirfd);
        if (kdir === null) return WasiErrno.BADF;
        const path = this.str(pathPtr, pathLen);
        let flags = 0;
        if (oflags & OFlags.DIRECTORY) {
          flags = O.RDONLY | O.DIRECTORY;
        } else {
          const wantWrite = (rightsBase & Rights.FD_WRITE) !== 0n;
          const wantRead = (rightsBase & Rights.FD_READ) !== 0n;
          flags = wantWrite ? (wantRead ? O.RDWR : O.WRONLY) : O.RDONLY;
        }
        if (oflags & OFlags.CREAT) flags |= O.CREAT;
        if (oflags & OFlags.EXCL) flags |= O.EXCL;
        if (oflags & OFlags.TRUNC) flags |= O.TRUNC;
        if (fdflags & FdFlags.APPEND) flags |= O.APPEND;
        if (fdflags & FdFlags.NONBLOCK) flags |= O.NONBLOCK;
        if (fdflags & (FdFlags.SYNC | FdFlags.RSYNC)) flags |= O.SYNC;
        else if (fdflags & FdFlags.DSYNC) flags |= O.DSYNC;
        if (!(lookupFlags & LOOKUP_SYMLINK_FOLLOW)) flags |= O.NOFOLLOW;

        let kfd = k.openat(kdir, path, flags, 0o644);
        // Read+write was only implied by rights; retry read-only on EISDIR
        // so directories opened without O_DIRECTORY still work.
        if (kfd === -E.ISDIR && (flags & 3) !== O.RDONLY && !(flags & (O.CREAT | O.TRUNC))) {
          kfd = k.openat(kdir, path, (flags & ~3) | O.RDONLY, 0o644);
        }
        if (kfd < 0) return wasiErrno(kfd);
        const st = k.statx(kfd, '', AT_EMPTY_PATH);
        const isDir = typeof st !== 'number' && filetypeFromMode(st.mode) === Filetype.DIRECTORY;
        const fd = this.alloc({ kind: 'kernel', fd: kfd, isDir, owned: true, append: (flags & O.APPEND) !== 0 });
        this.dv().setUint32(fdPtr, fd, true);
        return S;
      },
      path_filestat_get: (dirfd: number, lookupFlags: number, pathPtr: number, pathLen: number, ptr: number) => {
        const kdir = this.dir(dirfd);
        if (kdir === null) return WasiErrno.BADF;
        const st = k.statx(kdir, this.str(pathPtr, pathLen), lookupFlags & LOOKUP_SYMLINK_FOLLOW ? 0 : AT_SYMLINK_NOFOLLOW);
        if (typeof st === 'number') return wasiErrno(st);
        this.writeFilestat(ptr, st);
        return S;
      },
      path_filestat_set_times: (dirfd: number, lookupFlags: number, pathPtr: number, pathLen: number,
        atim: bigint, mtim: bigint, fst: number) => {
        const kdir = this.dir(dirfd);
        if (kdir === null) return WasiErrno.BADF;
        const r = k.utimensat(kdir, this.str(pathPtr, pathLen),
          this.timeArg(fst, FstFlags.ATIM, FstFlags.ATIM_NOW, atim),
          this.timeArg(fst, FstFlags.MTIM, FstFlags.MTIM_NOW, mtim),
          lookupFlags & LOOKUP_SYMLINK_FOLLOW ? 0 : AT_SYMLINK_NOFOLLOW);
        return r < 0 ? wasiErrno(r) : S;
      },
      path_create_directory: (dirfd: number, pathPtr: number, pathLen: number) =>
        this.onDir(dirfd, (kdir) => k.mkdirat(kdir, this.str(pathPtr, pathLen), 0o755)),
      path_remove_directory: (dirfd: number, pathPtr: number, pathLen: number) =>
        this.onDir(dirfd, (kdir) => k.unlinkat(kdir, this.str(pathPtr, pathLen), AT_REMOVEDIR)),
      path_unlink_file: (dirfd: number, pathPtr: number, pathLen: number) =>
        this.onDir(dirfd, (kdir) => k.unlinkat(kdir, this.str(pathPtr, pathLen), 0)),
      path_rename: (oldDir: number, oldPtr: number, oldLen: number, newDir: number, newPtr: number, newLen: number) => {
        const a = this.dir(oldDir);
        const b = this.dir(newDir);
        if (a === null || b === null) return WasiErrno.BADF;
        const r = k.renameat(a, this.str(oldPtr, oldLen), b, this.str(newPtr, newLen));
        return r < 0 ? wasiErrno(r) : S;
      },
      path_symlink: (oldPtr: number, oldLen: number, dirfd: number, newPtr: number, newLen: number) =>
        this.onDir(dirfd, (kdir) => k.symlinkat(this.str(oldPtr, oldLen), kdir, this.str(newPtr, newLen))),
      path_link: (oldDir: number, oldFlags: number, oldPtr: number, oldLen: number,
        newDir: number, newPtr: number, newLen: number) => {
        const a = this.dir(oldDir);
        const b = this.dir(newDir);
        if (a === null || b === null) return WasiErrno.BADF;
        const r = k.linkat(a, this.str(oldPtr, oldLen), b, this.str(newPtr, newLen),
          oldFlags & LOOKUP_SYMLINK_FOLLOW ? AT_SYMLINK_FOLLOW : 0);
        return r < 0 ? wasiErrno(r) : S;
      },
      path_readlink: (dirfd: number, pathPtr: number, pathLen: number, buf: number, bufLen: number, usedPtr: number) => {
        const kdir = this.dir(dirfd);
        if (kdir === null) return WasiErrno.BADF;
        const target = k.readlinkat(kdir, this.str(pathPtr, pathLen));
        if (typeof target === 'number') return wasiErrno(target);
        const bytes = enc.encode(target).subarray(0, bufLen);
        this.u8().set(bytes, buf);
        return this.setU32(usedPtr, bytes.length);
      },

      // ── poll ──
      poll_oneoff: (inPtr: number, outPtr: number, nsubs: number, neventsPtr: number) => {
        const v = this.dv();
        type Sub = { userdata: bigint; tag: number; fd?: number; deadlineNs?: bigint };
        const subs: Sub[] = [];
        for (let i = 0; i < nsubs; i++) {
          const b = inPtr + i * 48;
          const userdata = v.getBigUint64(b, true);
          const tag = v.getUint8(b + 8);
          if (tag === EventType.CLOCK) {
            const id = v.getUint32(b + 16, true);
            const timeout = v.getBigUint64(b + 24, true);
            const abs = (v.getUint16(b + 40, true) & 1) !== 0;
            subs.push({ userdata, tag, deadlineNs: abs ? timeout - nowNs(id) + nowNs(Clock.MONOTONIC) : nowNs(Clock.MONOTONIC) + timeout });
          } else {
            subs.push({ userdata, tag, fd: v.getUint32(b + 16, true) });
          }
        }
        const fdSubs = subs.filter((s) => s.tag !== EventType.CLOCK);
        let ready: Sub[];
        if (fdSubs.length > 0) {
          ready = fdSubs; // buffers and kernel files never block here
        } else {
          const earliest = subs.reduce((m, s) => (s.deadlineNs! < m ? s.deadlineNs! : m), BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000n);
          this.sleepUntil(earliest);
          const now = nowNs(Clock.MONOTONIC);
          ready = subs.filter((s) => s.deadlineNs! <= now);
        }
        for (let i = 0; i < ready.length; i++) {
          const b = outPtr + i * 32;
          const s = ready[i];
          v.setBigUint64(b, s.userdata, true);
          v.setUint16(b + 8, s.tag !== EventType.CLOCK && !this.fds.has(s.fd!) ? WasiErrno.BADF : S, true);
          v.setUint8(b + 10, s.tag);
          v.setBigUint64(b + 16, s.tag === EventType.CLOCK ? 0n : 1n, true);
          v.setUint16(b + 24, 0, true);
        }
        return this.setU32(neventsPtr, ready.length);
      },

      // ── sockets: not available ──
      sock_accept: () => WasiErrno.NOTSUP,
      sock_recv: () => WasiErrno.NOTSUP,
      sock_send: () => WasiErrno.NOTSUP,
      sock_shutdown: () => WasiErrno.NOTSUP,
    };
    return fns as unknown as Record<string, (...args: never[]) => number>;
  }

  private envList(): string[] {
    return Object.entries(this.opts.env).map(([k, v]) => `${k}=${v}`);
  }

  private putStrings(list: string[], ptrsPtr: number, bufPtr: number): number {
    const v = this.dv();
    const mem = this.u8();
    let off = bufPtr;
    list.forEach((s, i) => {
      v.setUint32(ptrsPtr + i * 4, off, true);
      const b = enc.encode(s);
      mem.set(b, off);
      mem[off + b.length] = 0;
      off += b.length + 1;
    });
    return WasiErrno.SUCCESS;
  }

  private setU32(ptr: number, value: number): number {
    this.dv().setUint32(ptr, value, true);
    return WasiErrno.SUCCESS;
  }

  private onKernelFd(fd: number, op: (kfd: number) => number): number {
    const e = this.fds.get(fd);
    if (!e) return WasiErrno.BADF;
    if (e.kind !== 'kernel') return WasiErrno.SUCCESS;
    const r = op(e.fd);
    return r < 0 ? wasiErrno(r) : WasiErrno.SUCCESS;
  }

  private onDir(dirfd: number, op: (kdir: number) => number): number {
    const kdir = this.dir(dirfd);
    if (kdir === null) return WasiErrno.BADF;
    const r = op(kdir);
    return r < 0 ? wasiErrno(r) : WasiErrno.SUCCESS;
  }

  private sleepUntil(monoNs: bigint): void {
    for (;;) {
      this.checkDeadline();
      const remainingMs = Number((monoNs - nowNs(Clock.MONOTONIC)) / 1_000_000n);
      if (remainingMs <= 0) return;
      const slice = Math.min(remainingMs, 50);
      if (SLEEP_CELL) {
        try { Atomics.wait(SLEEP_CELL, 0, 0, slice); continue; } catch { /* main browser thread: fall through */ }
      }
      const until = Date.now() + slice;
      while (Date.now() < until) { /* busy-wait fallback */ }
    }
  }
}

const MONO_ORIGIN = BigInt(Date.now()) * 1_000_000n;
function nowNs(clock: number): bigint {
  if (clock === Clock.REALTIME) {
    return BigInt(Date.now()) * 1_000_000n;
  }
  return MONO_ORIGIN + BigInt(Math.round(performance.now() * 1e6));
}
