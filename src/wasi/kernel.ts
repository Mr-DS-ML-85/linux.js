/**
 * linux.js — typed access to the guest kernel's syscalls.
 *
 * Everything the WASI userland does to files goes through here, into the
 * real Linux kernel (LKL) via the adapter's `linuxjs_syscall` gate. Pointer
 * arguments live in the kernel module's linear memory, so data is staged in
 * malloc()ed scratch buffers there and copied to/from the caller.
 *
 * Numbers are the asm-generic table LKL uses (include/uapi/asm-generic/
 * unistd.h). On wasm32 the 64-bit-offset syscalls go through LKL's
 * split-argument shims (lo, hi). Results follow the kernel convention:
 * >= 0 on success, -errno (Linux numbering) on failure.
 *
 * License: MIT.
 */

import type { LklWasmModule } from '../types.js';

export const NR = {
  dup3: 24,
  mkdirat: 34,
  unlinkat: 35,
  symlinkat: 36,
  linkat: 37,
  ftruncate: 46,
  faccessat: 48,
  fchmodat: 53,
  openat: 56,
  close: 57,
  pipe2: 59,
  getdents64: 61,
  llseek: 62,
  read: 63,
  write: 64,
  pread64: 67,
  pwrite64: 68,
  readlinkat: 78,
  fsync: 82,
  fdatasync: 83,
  utimensat: 88,
  fadvise64: 223,
  renameat2: 276,
  statx: 291,
} as const;

/** Linux open(2) flags (asm-generic). */
export const O = {
  RDONLY: 0o0,
  WRONLY: 0o1,
  RDWR: 0o2,
  CREAT: 0o100,
  EXCL: 0o200,
  TRUNC: 0o1000,
  APPEND: 0o2000,
  NONBLOCK: 0o4000,
  DSYNC: 0o10000,
  LARGEFILE: 0o100000,
  DIRECTORY: 0o200000,
  NOFOLLOW: 0o400000,
  CLOEXEC: 0o2000000,
  SYNC: 0o4010000,
} as const;

export const AT_FDCWD = -100;
export const AT_SYMLINK_NOFOLLOW = 0x100;
export const AT_REMOVEDIR = 0x200;
export const AT_SYMLINK_FOLLOW = 0x400;
export const AT_EMPTY_PATH = 0x1000;
export const UTIME_NOW = (1 << 30) - 1;
export const UTIME_OMIT = (1 << 30) - 2;

/** Linux errno values used by the runtime itself. */
export const E = {
  PERM: 1, NOENT: 2, IO: 5, BADF: 9, AGAIN: 11, NOMEM: 12, ACCES: 13,
  EXIST: 17, NOTDIR: 20, ISDIR: 21, INVAL: 22, SPIPE: 29, NAMETOOLONG: 36,
  NOSYS: 38, NOTEMPTY: 39, LOOP: 40, NOTSUP: 95,
} as const;

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;
export const S_IFCHR = 0o020000;
export const S_IFBLK = 0o060000;
export const S_IFIFO = 0o010000;
export const S_IFSOCK = 0o140000;

/** Decoded `struct statx` (only the fields the runtime uses). */
export interface Statx {
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  ino: bigint;
  size: bigint;
  /** Nanoseconds since the epoch. */
  atimeNs: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
}

/** One directory entry from getdents64. */
export interface Dirent {
  ino: bigint;
  /** Linux DT_* type. */
  type: number;
  name: string;
}

const SCRATCH_SIZE = 256 * 1024;
const PATH_MAX = 4096;
const STATX_SIZE = 256;
const STATX_BASIC_STATS = 0x7ff;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Thrown for kernel errors where a caller prefers exceptions. */
export class KernelError extends Error {
  constructor(readonly errno: number, op: string) {
    super(`${op}: errno ${errno}`);
    this.name = 'KernelError';
  }
}

export class KernelSyscalls {
  private readonly scratch: number;
  private readonly pathA: number;
  private readonly pathB: number;
  private readonly small: number; // 256 B: statx, loff_t, timespecs, pipe fds

  constructor(private readonly mod: LklWasmModule) {
    this.scratch = this.alloc(SCRATCH_SIZE);
    this.pathA = this.alloc(PATH_MAX + 1);
    this.pathB = this.alloc(PATH_MAX + 1);
    this.small = this.alloc(STATX_SIZE);
  }

  private alloc(n: number): number {
    const p = this.mod._malloc(n);
    if (!p) throw new Error('linux.js: kernel heap exhausted');
    return p;
  }

  private heap(): Uint8Array {
    return new Uint8Array(this.mod.wasmMemory.buffer);
  }

  private view(): DataView {
    return new DataView(this.mod.wasmMemory.buffer);
  }

  private sys(no: number, a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0): number {
    return this.mod._linuxjs_syscall(no, a0, a1, a2, a3, a4, a5);
  }

  /** Copy a path (UTF-8, NUL-terminated) into one of the path slots. */
  private putPath(path: string, slot: number): number | -36 {
    const bytes = enc.encode(path);
    if (bytes.length > PATH_MAX) return -E.NAMETOOLONG as -36;
    const h = this.heap();
    h.set(bytes, slot);
    h[slot + bytes.length] = 0;
    return slot;
  }

  // ─── fds ───────────────────────────────────────────────────────────

  openat(dirfd: number, path: string, flags: number, mode = 0o644): number {
    const p = this.putPath(path, this.pathA);
    if (p < 0) return p;
    return this.sys(NR.openat, dirfd, p, flags | O.LARGEFILE | O.CLOEXEC, mode);
  }

  close(fd: number): number {
    return this.sys(NR.close, fd);
  }

  /** read(2) into `dest`; at most one kernel read per scratch-sized chunk, stops at a short read. */
  read(fd: number, dest: Uint8Array): number {
    return this.transferIn(dest, (ptr, len) => this.sys(NR.read, fd, ptr, len));
  }

  pread(fd: number, dest: Uint8Array, offset: bigint): number {
    return this.transferIn(dest, (ptr, len, done) =>
      this.sys(NR.pread64, fd, ptr, len, ...splitOffset(offset + BigInt(done))));
  }

  write(fd: number, src: Uint8Array): number {
    return this.transferOut(src, (ptr, len) => this.sys(NR.write, fd, ptr, len));
  }

  pwrite(fd: number, src: Uint8Array, offset: bigint): number {
    return this.transferOut(src, (ptr, len, done) =>
      this.sys(NR.pwrite64, fd, ptr, len, ...splitOffset(offset + BigInt(done))));
  }

  /** lseek via llseek; returns the new offset or a negative errno. */
  seek(fd: number, offset: bigint, whence: number): bigint | number {
    const u = BigInt.asUintN(64, offset);
    const r = this.sys(NR.llseek, fd, Number(u >> 32n) | 0, Number(u & 0xffffffffn) | 0, this.small, whence);
    if (r < 0) return r;
    return this.view().getBigInt64(this.small, true);
  }

  ftruncate(fd: number, size: bigint): number {
    return this.sys(NR.ftruncate, fd, ...splitOffset(size));
  }

  fsync(fd: number): number { return this.sys(NR.fsync, fd); }
  fdatasync(fd: number): number { return this.sys(NR.fdatasync, fd); }

  fadvise(fd: number, offset: bigint, len: bigint, advice: number): number {
    return this.sys(NR.fadvise64, fd, ...splitOffset(offset), ...splitOffset(len), advice);
  }

  // ─── metadata ──────────────────────────────────────────────────────

  /** statx(dirfd, path, flags). Use path '' + AT_EMPTY_PATH for an fd. */
  statx(dirfd: number, path: string, flags: number): Statx | number {
    const p = this.putPath(path, this.pathA);
    if (p < 0) return p;
    const r = this.sys(NR.statx, dirfd, p, flags, STATX_BASIC_STATS, this.small);
    if (r < 0) return r;
    const v = this.view();
    const b = this.small;
    const ts = (o: number) => v.getBigInt64(b + o, true) * 1_000_000_000n + BigInt(v.getUint32(b + o + 8, true));
    return {
      nlink: v.getUint32(b + 16, true),
      uid: v.getUint32(b + 20, true),
      gid: v.getUint32(b + 24, true),
      mode: v.getUint16(b + 28, true),
      ino: v.getBigUint64(b + 32, true),
      size: v.getBigUint64(b + 40, true),
      atimeNs: ts(64),
      ctimeNs: ts(96),
      mtimeNs: ts(112),
      dev: (BigInt(v.getUint32(b + 136, true)) << 32n) | BigInt(v.getUint32(b + 140, true)),
    };
  }

  /**
   * utimensat with per-field control. `null` = leave unchanged, 'now' =
   * current time, bigint = nanoseconds since the epoch.
   */
  utimensat(dirfd: number, path: string | null, atime: bigint | 'now' | null, mtime: bigint | 'now' | null, flags = 0): number {
    let p = 0;
    if (path !== null) {
      const r = this.putPath(path, this.pathA);
      if (r < 0) return r;
      p = r;
    }
    const v = this.view();
    const put = (off: number, t: bigint | 'now' | null) => {
      const b = this.small + off;
      if (t === null) { v.setBigInt64(b, 0n, true); v.setInt32(b + 8, UTIME_OMIT, true); v.setInt32(b + 12, 0, true); }
      else if (t === 'now') { v.setBigInt64(b, 0n, true); v.setInt32(b + 8, UTIME_NOW, true); v.setInt32(b + 12, 0, true); }
      else { v.setBigInt64(b, t / 1_000_000_000n, true); v.setInt32(b + 8, Number(t % 1_000_000_000n), true); v.setInt32(b + 12, 0, true); }
    };
    // struct __kernel_timespec { s64 tv_sec; long long tv_nsec; } — 16 bytes each.
    put(0, atime);
    put(16, mtime);
    return this.sys(NR.utimensat, dirfd, p, this.small, flags);
  }

  /** Read all entries of an open directory fd (rewinds first). */
  readdirAll(fd: number): Dirent[] | number {
    const r0 = this.seek(fd, 0n, 0);
    if (typeof r0 === 'number' && r0 < 0) return r0;
    const out: Dirent[] = [];
    for (;;) {
      const n = this.sys(NR.getdents64, fd, this.scratch, SCRATCH_SIZE);
      if (n < 0) return n;
      if (n === 0) break;
      const v = this.view();
      const h = this.heap();
      for (let off = 0; off < n;) {
        const base = this.scratch + off;
        const reclen = v.getUint16(base + 16, true);
        const type = h[base + 18];
        let end = base + 19;
        while (h[end] !== 0) end++;
        out.push({ ino: v.getBigUint64(base, true), type, name: dec.decode(h.subarray(base + 19, end)) });
        off += reclen;
      }
    }
    return out;
  }

  // ─── namespace ops ─────────────────────────────────────────────────

  mkdirat(dirfd: number, path: string, mode = 0o755): number {
    const p = this.putPath(path, this.pathA);
    return p < 0 ? p : this.sys(NR.mkdirat, dirfd, p, mode);
  }

  unlinkat(dirfd: number, path: string, flags = 0): number {
    const p = this.putPath(path, this.pathA);
    return p < 0 ? p : this.sys(NR.unlinkat, dirfd, p, flags);
  }

  renameat(olddir: number, oldpath: string, newdir: number, newpath: string): number {
    const a = this.putPath(oldpath, this.pathA);
    if (a < 0) return a;
    const b = this.putPath(newpath, this.pathB);
    if (b < 0) return b;
    return this.sys(NR.renameat2, olddir, a, newdir, b, 0);
  }

  symlinkat(target: string, dirfd: number, linkpath: string): number {
    const a = this.putPath(target, this.pathA);
    if (a < 0) return a;
    const b = this.putPath(linkpath, this.pathB);
    if (b < 0) return b;
    return this.sys(NR.symlinkat, a, dirfd, b);
  }

  linkat(olddir: number, oldpath: string, newdir: number, newpath: string, flags = 0): number {
    const a = this.putPath(oldpath, this.pathA);
    if (a < 0) return a;
    const b = this.putPath(newpath, this.pathB);
    if (b < 0) return b;
    return this.sys(NR.linkat, olddir, a, newdir, b, flags);
  }

  readlinkat(dirfd: number, path: string): string | number {
    const p = this.putPath(path, this.pathA);
    if (p < 0) return p;
    const n = this.sys(NR.readlinkat, dirfd, p, this.scratch, PATH_MAX);
    if (n < 0) return n;
    return dec.decode(this.heap().subarray(this.scratch, this.scratch + n));
  }

  fchmodat(dirfd: number, path: string, mode: number): number {
    const p = this.putPath(path, this.pathA);
    return p < 0 ? p : this.sys(NR.fchmodat, dirfd, p, mode);
  }

  faccessat(dirfd: number, path: string, mode: number): number {
    const p = this.putPath(path, this.pathA);
    return p < 0 ? p : this.sys(NR.faccessat, dirfd, p, mode);
  }

  // ─── convenience ───────────────────────────────────────────────────

  /** Read a whole file (absolute path). Throws KernelError. */
  readFile(path: string): Uint8Array {
    const fd = this.openat(AT_FDCWD, path, O.RDONLY);
    if (fd < 0) throw new KernelError(-fd, `open ${path}`);
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const buf = new Uint8Array(SCRATCH_SIZE);
        const n = this.read(fd, buf);
        if (n < 0) throw new KernelError(-n, `read ${path}`);
        if (n === 0) break;
        chunks.push(n === buf.length ? buf : buf.subarray(0, n));
        total += n;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } finally {
      this.close(fd);
    }
  }

  /** Create/truncate and write a whole file (absolute path). Throws KernelError. */
  writeFile(path: string, data: Uint8Array, mode = 0o644): void {
    const fd = this.openat(AT_FDCWD, path, O.WRONLY | O.CREAT | O.TRUNC, mode);
    if (fd < 0) throw new KernelError(-fd, `open ${path}`);
    try {
      const n = this.write(fd, data);
      if (n < 0) throw new KernelError(-n, `write ${path}`);
      if (n !== data.length) throw new KernelError(E.IO, `short write ${path}`);
    } finally {
      this.close(fd);
    }
  }

  // ─── staging ───────────────────────────────────────────────────────

  private transferIn(dest: Uint8Array, op: (ptr: number, len: number, done: number) => number): number {
    let done = 0;
    while (done < dest.length) {
      const len = Math.min(SCRATCH_SIZE, dest.length - done);
      const n = op(this.scratch, len, done);
      if (n < 0) return done > 0 ? done : n;
      dest.set(this.heap().subarray(this.scratch, this.scratch + n), done);
      done += n;
      if (n < len) break;
    }
    return done;
  }

  private transferOut(src: Uint8Array, op: (ptr: number, len: number, done: number) => number): number {
    let done = 0;
    while (done < src.length) {
      const len = Math.min(SCRATCH_SIZE, src.length - done);
      this.heap().set(src.subarray(done, done + len), this.scratch);
      const n = op(this.scratch, len, done);
      if (n < 0) return done > 0 ? done : n;
      done += n;
      if (n < len) break;
    }
    return done;
  }
}

/** Split a 64-bit offset into the (lo, hi) pair LKL's sys32 shims take. */
function splitOffset(off: bigint): [number, number] {
  const u = BigInt.asUintN(64, off);
  return [Number(u & 0xffffffffn) | 0, Number(u >> 32n) | 0];
}
