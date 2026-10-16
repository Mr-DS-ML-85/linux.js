/**
 * linux.js — runtime detection + per-runtime loader selection.
 *
 * The same lkl.wasm is loaded differently in each host:
 *   - Node:        dynamic import of the Emscripten loader, file URL
 *   - Browser:     fetch the loader URL, instantiate with the worker file alongside
 *   - Cloudflare:  unsupported (no SharedArrayBuffer/Workers; LKL needs threads)
 *   - Deno:        like Node but with explicit --allow-net for the relay
 *   - Bun:         like Node
 *
 * License: MIT.
 */

export type Runtime =
  | 'node'
  | 'bun'
  | 'deno'
  | 'cloudflare-workers'
  | 'browser'
  | 'unknown';

/**
 * Detect the current JS runtime. Result is cached on first call.
 *
 * The checks are ordered so the most specific runtime wins:
 * Bun/Deno/CF Workers all set globals that *also* satisfy looser checks.
 */
let cached: Runtime | undefined;
export function detectRuntime(): Runtime {
  if (cached) return cached;
  cached = computeRuntime();
  return cached;
}

function computeRuntime(): Runtime {
  const g = globalThis as Record<string, unknown>;

  if (typeof g.Bun !== 'undefined') return 'bun';
  if (typeof g.Deno !== 'undefined') return 'deno';

  // Cloudflare Workers expose `WebSocketPair` and `caches.default`, and the
  // navigator.userAgent contains "Cloudflare-Workers".
  const nav = g.navigator as { userAgent?: string } | undefined;
  if (nav?.userAgent?.includes('Cloudflare-Workers')) return 'cloudflare-workers';
  if (typeof g.WebSocketPair !== 'undefined' && typeof g.caches !== 'undefined' && typeof window === 'undefined') {
    return 'cloudflare-workers';
  }

  // Node sets process.versions.node.
  const proc = g.process as { versions?: { node?: string } } | undefined;
  if (proc?.versions?.node) return 'node';

  if (typeof g.window !== 'undefined' && typeof g.document !== 'undefined') return 'browser';

  return 'unknown';
}

/** Capabilities the runtime offers that linux.js cares about. */
export interface RuntimeCapabilities {
  /** Can we spawn pthreads via Web Workers + SharedArrayBuffer? */
  threads: boolean;
  /** Can we open raw TCP sockets, or do we need a WebSocket relay? */
  rawTcp: boolean;
  /** Is `import.meta.url` resolvable as a real file path? */
  filesystemImport: boolean;
  /** Is WebAssembly.Memory growable? Workers cap it. */
  growableMemory: boolean;
}

export function capabilities(): RuntimeCapabilities {
  const r = detectRuntime();
  const g = globalThis as Record<string, unknown>;
  const hasSAB = typeof g.SharedArrayBuffer !== 'undefined';
  const crossOriginIsolated = (g.crossOriginIsolated as boolean | undefined) === true;

  switch (r) {
    case 'node':
    case 'bun':
      return { threads: true, rawTcp: true, filesystemImport: true, growableMemory: true };
    case 'deno':
      return { threads: true, rawTcp: true, filesystemImport: true, growableMemory: true };
    case 'cloudflare-workers':
      // Workers: no pthreads, no Worker spawning, no fs, no raw TCP for arbitrary hosts.
      return { threads: false, rawTcp: false, filesystemImport: false, growableMemory: false };
    case 'browser':
      return {
        threads: hasSAB && crossOriginIsolated,
        rawTcp: false,
        filesystemImport: false,
        growableMemory: true,
      };
    default:
      return { threads: false, rawTcp: false, filesystemImport: false, growableMemory: false };
  }
}

/**
 * Pick the loader URL the LklAdapter should import.
 *
 * There is one build: `lkl.js` (pthreads + workers). LKL needs host threads,
 * so runtimes without SharedArrayBuffer + Workers (plain browsers, Cloudflare
 * Workers) are unsupported; LklAdapter.load() reports that explicitly.
 * A caller-supplied `wasmBinary` always wins.
 */
export function defaultLoaderHint(): 'lkl.js' {
  return 'lkl.js';
}
