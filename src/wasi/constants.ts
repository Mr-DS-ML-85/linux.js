/**
 * linux.js — WASI preview1 constants and Linux ↔ WASI translations.
 * License: MIT.
 */

import { S_IFBLK, S_IFCHR, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG, S_IFSOCK } from './kernel.js';

/** WASI errno (wasi_snapshot_preview1). */
export const WasiErrno = {
  SUCCESS: 0, TOOBIG: 1, ACCES: 2, AGAIN: 6, BADF: 8, EXIST: 20, FAULT: 21,
  INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54,
  NOTEMPTY: 55, NOTSUP: 58, PIPE: 64, SPIPE: 70, NOTCAPABLE: 76,
} as const;

/** Linux errno → WASI errno. Unlisted values map to EIO. */
const LINUX_TO_WASI: Record<number, number> = {
  1: 63,   // EPERM
  2: 44,   // ENOENT
  3: 71,   // ESRCH
  4: 27,   // EINTR
  5: 29,   // EIO
  6: 60,   // ENXIO
  7: 1,    // E2BIG
  8: 45,   // ENOEXEC
  9: 8,    // EBADF
  10: 12,  // ECHILD
  11: 6,   // EAGAIN
  12: 48,  // ENOMEM
  13: 2,   // EACCES
  14: 21,  // EFAULT
  16: 10,  // EBUSY
  17: 20,  // EEXIST
  18: 75,  // EXDEV
  19: 43,  // ENODEV
  20: 54,  // ENOTDIR
  21: 31,  // EISDIR
  22: 28,  // EINVAL
  23: 41,  // ENFILE
  24: 33,  // EMFILE
  25: 59,  // ENOTTY
  26: 74,  // ETXTBSY
  27: 22,  // EFBIG
  28: 51,  // ENOSPC
  29: 70,  // ESPIPE
  30: 69,  // EROFS
  31: 34,  // EMLINK
  32: 64,  // EPIPE
  33: 18,  // EDOM
  34: 68,  // ERANGE
  35: 16,  // EDEADLK
  36: 37,  // ENAMETOOLONG
  37: 46,  // ENOLCK
  38: 52,  // ENOSYS
  39: 55,  // ENOTEMPTY
  40: 32,  // ELOOP
  42: 49,  // ENOMSG
  43: 24,  // EIDRM
  67: 47,  // ENOLINK
  71: 65,  // EPROTO
  72: 36,  // EMULTIHOP
  74: 9,   // EBADMSG
  75: 61,  // EOVERFLOW
  84: 25,  // EILSEQ
  88: 57,  // ENOTSOCK
  89: 17,  // EDESTADDRREQ
  90: 35,  // EMSGSIZE
  91: 67,  // EPROTOTYPE
  92: 50,  // ENOPROTOOPT
  93: 66,  // EPROTONOSUPPORT
  95: 58,  // EOPNOTSUPP
  97: 5,   // EAFNOSUPPORT
  98: 3,   // EADDRINUSE
  99: 4,   // EADDRNOTAVAIL
  100: 38, // ENETDOWN
  101: 40, // ENETUNREACH
  102: 39, // ENETRESET
  103: 13, // ECONNABORTED
  104: 15, // ECONNRESET
  105: 42, // ENOBUFS
  106: 30, // EISCONN
  107: 53, // ENOTCONN
  110: 73, // ETIMEDOUT
  111: 14, // ECONNREFUSED
  113: 23, // EHOSTUNREACH
  114: 7,  // EALREADY
  115: 26, // EINPROGRESS
  116: 72, // ESTALE
  122: 19, // EDQUOT
  125: 11, // ECANCELED
  130: 62, // EOWNERDEAD
  131: 56, // ENOTRECOVERABLE
};

/** Translate a negative kernel result (-errno) to a WASI errno. */
export function wasiErrno(negLinuxErrno: number): number {
  return LINUX_TO_WASI[-negLinuxErrno] ?? WasiErrno.IO;
}

/** WASI filetype. */
export const Filetype = {
  UNKNOWN: 0, BLOCK_DEVICE: 1, CHARACTER_DEVICE: 2, DIRECTORY: 3,
  REGULAR_FILE: 4, SOCKET_DGRAM: 5, SOCKET_STREAM: 6, SYMBOLIC_LINK: 7,
} as const;

export function filetypeFromMode(mode: number): number {
  switch (mode & S_IFMT) {
    case S_IFDIR: return Filetype.DIRECTORY;
    case S_IFREG: return Filetype.REGULAR_FILE;
    case S_IFLNK: return Filetype.SYMBOLIC_LINK;
    case S_IFCHR: return Filetype.CHARACTER_DEVICE;
    case S_IFBLK: return Filetype.BLOCK_DEVICE;
    case S_IFSOCK: return Filetype.SOCKET_STREAM;
    default: return Filetype.UNKNOWN;
  }
}

/** Linux DT_* (getdents64 d_type) → WASI filetype. */
export function filetypeFromDtype(dt: number): number {
  switch (dt) {
    case 4: return Filetype.DIRECTORY;
    case 8: return Filetype.REGULAR_FILE;
    case 10: return Filetype.SYMBOLIC_LINK;
    case 2: return Filetype.CHARACTER_DEVICE;
    case 6: return Filetype.BLOCK_DEVICE;
    case 12: return Filetype.SOCKET_STREAM;
    default: return Filetype.UNKNOWN;
  }
}

export const OFlags = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const;
export const FdFlags = { APPEND: 1, DSYNC: 2, NONBLOCK: 4, RSYNC: 8, SYNC: 16 } as const;
export const LOOKUP_SYMLINK_FOLLOW = 1;
export const FstFlags = { ATIM: 1, ATIM_NOW: 2, MTIM: 4, MTIM_NOW: 8 } as const;

/** Rights bits we inspect when deciding open(2) access mode. */
export const Rights = {
  FD_READ: 1n << 1n,
  FD_WRITE: 1n << 6n,
  /** Everything: this runtime does not enforce WASI capabilities beyond the kernel's own checks. */
  ALL: 0x1fffffffn,
} as const;

export const Clock = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME: 2, THREAD_CPUTIME: 3 } as const;
export const EventType = { CLOCK: 0, FD_READ: 1, FD_WRITE: 2 } as const;
export const Whence = { SET: 0, CUR: 1, END: 2 } as const;
