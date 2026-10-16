/**
 * linux.js — Run the real Linux kernel anywhere WebAssembly runs.
 *
 * ```ts
 * import Linux from 'linux.js';
 *
 * const linux = await Linux.create({ memory: 256 });
 * const agent = linux.agent({ workdir: '/workspace', maxOutputBytes: 256_000 });
 * const result = await agent.run('grep -r TODO .');
 * console.log(result.stdout);
 * await linux.shutdown();
 * ```
 *
 * License: MIT for this JS API. The kernel binary it loads is GPL v2.
 */

export { Linux, default } from './linux.js';
export type { LinuxInternalConfig } from './linux.js';
export { LklAdapter } from './lkl-adapter.js';

export type {
  LinuxConfig,
  ExecResult,
  DirEntry,
  LinuxStats,
  LklWasmModule,
  LklWasmModuleFactory,
  LinuxEvents,
} from './types.js';

// AI agent sandbox
export { AgentSandbox, buildAgent } from './agent.js';
export type { AgentConfig, AgentRunResult, AgentSession, ToolDefinition } from './agent.js';

// Networking transport abstraction
export {
  WebSocketRelayTransport,
  NodeNetTransport,
  CloudflareSocketsTransport,
  autoTransport,
} from './transport.js';
export type { NetworkTransport, NetworkSocket } from './transport.js';

// Runtime detection
export { detectRuntime, capabilities, defaultLoaderHint } from './runtime.js';
export type { Runtime, RuntimeCapabilities } from './runtime.js';

// Error types
export { ExecNotSupportedError, KernelPanicError } from './errors.js';

// Snapshot API (interface stable; implementation pending kernel support)
export { SnapshotNotSupportedError, serializeSnapshot, deserializeSnapshot } from './snapshot.js';
export type { SnapshotV1 } from './snapshot.js';

export const VERSION = '0.4.0';
export const BACKEND = 'lkl-wasm' as const;
