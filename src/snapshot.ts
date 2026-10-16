/**
 * linux.js — snapshot / restore.
 *
 * The public API is in place so integrators can wire snapshot orchestration
 * (object storage, caching, cold-start prewarm) ahead of the kernel-side
 * support landing.
 *
 * Today: `snapshot()` and `restore()` throw a `SnapshotNotSupportedError`
 * because LKL upstream does not yet expose a deterministic checkpoint API
 * we can call into. Subscribe to the GitHub release notes — when this
 * lights up, the API contract here will not change.
 *
 * License: MIT.
 */

/** Versioned snapshot envelope. Backwards-compatible additions only. */
export interface SnapshotV1 {
  version: 1;
  /** ISO timestamp at capture. */
  createdAt: string;
  /** Kernel cmdline used at boot. */
  kernelCmdline: string;
  /** Configured memory size at boot (MB). */
  memoryMb: number;
  /** Captured kernel version from /proc/version. */
  kernelVersion: string;
  /** Raw WASM linear memory (zlib-friendly; consider compressing before storing). */
  memory: Uint8Array;
  /** Implementation-defined kernel checkpoint blob produced by LKL. */
  state: Uint8Array;
}

export class SnapshotNotSupportedError extends Error {
  constructor(detail = 'snapshot/restore needs LKL kernel-side checkpoint support') {
    super(`linux.js: ${detail}. Track https://github.com/linux-js/linux.js/issues for status.`);
    this.name = 'SnapshotNotSupportedError';
  }
}

/** Magic header so on-disk snapshots are self-identifying. */
const MAGIC = new TextEncoder().encode('LINUXJS1');

/** Serialize a snapshot to a single buffer suitable for KV / blob storage. */
export function serializeSnapshot(snap: SnapshotV1): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({
    version: snap.version,
    createdAt: snap.createdAt,
    kernelCmdline: snap.kernelCmdline,
    memoryMb: snap.memoryMb,
    kernelVersion: snap.kernelVersion,
    memoryLen: snap.memory.length,
    stateLen: snap.state.length,
  }));

  const out = new Uint8Array(MAGIC.length + 4 + meta.length + snap.memory.length + snap.state.length);
  let off = 0;
  out.set(MAGIC, off); off += MAGIC.length;
  new DataView(out.buffer).setUint32(off, meta.length, true); off += 4;
  out.set(meta, off); off += meta.length;
  out.set(snap.memory, off); off += snap.memory.length;
  out.set(snap.state, off);
  return out;
}

/** Inverse of serializeSnapshot. Throws if the buffer is not a v1 snapshot. */
export function deserializeSnapshot(buf: Uint8Array): SnapshotV1 {
  for (let i = 0; i < MAGIC.length; i++) {
    if (buf[i] !== MAGIC[i]) {
      throw new Error('linux.js: buffer is not a snapshot (bad magic)');
    }
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const metaLen = view.getUint32(MAGIC.length, true);
  let off = MAGIC.length + 4;
  const meta = JSON.parse(new TextDecoder().decode(buf.subarray(off, off + metaLen))) as {
    version: number;
    createdAt: string;
    kernelCmdline: string;
    memoryMb: number;
    kernelVersion: string;
    memoryLen: number;
    stateLen: number;
  };
  if (meta.version !== 1) {
    throw new Error(`linux.js: unsupported snapshot version ${meta.version}`);
  }
  off += metaLen;
  const memory = buf.subarray(off, off + meta.memoryLen);
  off += meta.memoryLen;
  const state = buf.subarray(off, off + meta.stateLen);
  return {
    version: 1,
    createdAt: meta.createdAt,
    kernelCmdline: meta.kernelCmdline,
    memoryMb: meta.memoryMb,
    kernelVersion: meta.kernelVersion,
    memory,
    state,
  };
}
