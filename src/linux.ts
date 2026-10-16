/**
 * linux.js — Public API.
 *
 * Wraps the LKL kernel running inside WebAssembly with a small,
 * sql.js-style API. License: MIT.
 */

import type { LinuxConfig, ExecResult, DirEntry, LinuxStats } from './types.js';
import { LklAdapter } from './lkl-adapter.js';
import { buildAgent, type AgentConfig, type AgentSandbox } from './agent.js';
import { SnapshotNotSupportedError, type SnapshotV1 } from './snapshot.js';
import { ExecNotSupportedError } from './errors.js';

/**
 * Internal injection hook for tests. Not part of the public API.
 * Pass an object that quacks like LklAdapter and Linux will use it
 * instead of instantiating a real one.
 */
export interface LinuxInternalConfig extends LinuxConfig {
  /** @internal */
  __adapter?: LklAdapter;
}

const DEFAULTS: { memory: number; commandTimeout: number; bootTimeout: number } = {
  memory: 128,
  commandTimeout: 30_000,
  bootTimeout: 60_000,
};

const MIN_MEM_MB = 32;
const MAX_MEM_MB = 4096;

/** A running Linux instance backed by the real Linux kernel inside WASM. */
export class Linux {
  private adapter: LklAdapter;
  private config: LinuxConfig & typeof DEFAULTS;
  private startTime = 0;
  private cmdCount = 0;
  private _running = false;
  private _kernelVersion?: string;
  /** Kernel console output captured so far (see {@link kernelLog}). */
  private consoleLog = '';

  private constructor(adapter: LklAdapter, config: LinuxConfig & typeof DEFAULTS) {
    this.adapter = adapter;
    this.config = config;
  }

  /**
   * Create a new Linux instance.
   *
   * Boots the real Linux kernel (LKL compiled to WASM). Resolves once the
   * kernel has run all initcalls and mounted /proc, /sys, /dev, /tmp and
   * /run; the filesystem API is usable immediately. There is no guest
   * shell (see {@link ExecNotSupportedError}).
   */
  static async create(config: LinuxConfig = {}): Promise<Linux> {
    const cfg = { ...DEFAULTS, ...config };
    const memoryMb = Math.max(MIN_MEM_MB, Math.min(cfg.memory, MAX_MEM_MB));

    const adapter = (config as LinuxInternalConfig).__adapter ?? new LklAdapter();
    const linux = new Linux(adapter, cfg);

    try {
      const wasmSource = typeof cfg.wasmBinary === 'string' ? cfg.wasmBinary : undefined;
      await adapter.load(wasmSource);
      adapter.boot(memoryMb, cfg.kernelCmdline, cfg.debug === true);
      linux.captureConsole();
    } catch (err) {
      cfg.onCrash?.(err as Error);
      try { adapter.shutdown(); } catch { /* ignore */ }
      throw err;
    }

    linux.startTime = Date.now();
    linux._running = true;

    try {
      linux._kernelVersion = adapter.getKernelVersion();
    } catch { /* /proc not mounted yet — ignore */ }

    cfg.onReady?.();
    return linux;
  }

  /**
   * Execute a shell command inside the guest.
   *
   * Not available in this build: the kernel runs in library mode with no
   * userland, so this always rejects with {@link ExecNotSupportedError}.
   * The signature is kept so callers can feature-detect.
   */
  async exec(_command: string, _timeout?: number): Promise<ExecResult> {
    this.assertRunning();
    throw new ExecNotSupportedError('exec()');
  }

  /** Write a file via direct kernel syscalls (no shell roundtrip). */
  async writeFile(path: string, content: string | Uint8Array): Promise<ExecResult> {
    this.assertRunning();
    const startTime = Date.now();

    try {
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir && !(await this.exists(dir))) {
        this.adapter.mkdir(dir);
      }
      this.adapter.writeFile(path, content);
      return ok(startTime);
    } catch (err) {
      return fail(startTime, err as Error);
    }
  }

  async readFile(path: string): Promise<string> {
    this.assertRunning();
    return this.adapter.readTextFile(path);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    this.assertRunning();
    return this.adapter.readFile(path);
  }

  /** Stat a path through the kernel. Resolves to null if it does not exist. */
  async stat(path: string): Promise<{ mode: number; size: number; isDirectory: boolean } | null> {
    this.assertRunning();
    const st = this.adapter.stat(path);
    if (!st) return null;
    return { ...st, isDirectory: (st.mode & 0o170000) === 0o040000 };
  }

  async readdir(path: string): Promise<DirEntry[]> {
    this.assertRunning();
    const names = this.adapter.readdir(path);
    const out: DirEntry[] = [];
    for (const name of names) {
      const full = path === '/' ? `/${name}` : `${path}/${name}`;
      const st = this.adapter.stat(full);
      out.push({
        name,
        isDirectory: st ? (st.mode & 0o170000) === 0o040000 : false,
        size: st?.size ?? 0,
        mode: st?.mode ?? 0,
      });
    }
    return out;
  }

  async exists(path: string): Promise<boolean> {
    this.assertRunning();
    return this.adapter.stat(path) !== null;
  }

  async rm(path: string, recursive = false): Promise<ExecResult> {
    this.assertRunning();
    const startTime = Date.now();
    try {
      this.adapter.rm(path, recursive);
      return ok(startTime);
    } catch (err) {
      return fail(startTime, err as Error);
    }
  }

  async mkdir(path: string): Promise<ExecResult> {
    this.assertRunning();
    const startTime = Date.now();
    try {
      this.adapter.mkdir(path);
      return ok(startTime);
    } catch (err) {
      return fail(startTime, err as Error);
    }
  }

  /**
   * Copy a file (or, with `recursive`, a directory tree) through kernel
   * syscalls. Copying a directory without `recursive` fails, like cp(1).
   */
  async cp(src: string, dest: string, recursive = false): Promise<ExecResult> {
    this.assertRunning();
    const startTime = Date.now();
    try {
      this.copyPath(src, dest, recursive);
      return ok(startTime);
    } catch (err) {
      return fail(startTime, err as Error);
    }
  }

  /**
   * Is `command` resolvable on the guest PATH? Always false in this build:
   * there is no guest userland to run.
   */
  async which(_command: string): Promise<boolean> {
    this.assertRunning();
    return false;
  }

  /**
   * Kernel console output (printk) captured since boot. With the default
   * `quiet` cmdline this is warnings and worse; pass
   * `kernelCmdline: 'loglevel=8'` for everything.
   */
  kernelLog(): string {
    if (this._running) this.captureConsole();
    return this.consoleLog;
  }

  getKernelVersion(): string {
    return this._kernelVersion || 'unknown';
  }

  get running(): boolean {
    return this._running;
  }

  get kernelVersion(): string {
    return this._kernelVersion || 'unknown';
  }

  getStats(): LinuxStats {
    return {
      uptime: this._running ? Date.now() - this.startTime : 0,
      memoryTotal: this.config.memory * 1024 * 1024,
      running: this._running,
      commandsExecuted: this.cmdCount,
      kernelVersion: this._kernelVersion,
      hostThreads: this._running ? this.adapter.hostThreads?.() : undefined,
    };
  }

  async shutdown(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this.adapter.shutdown();
  }

  async kill(): Promise<void> {
    this._running = false;
    this.adapter.shutdown();
  }

  // ─── Agent sandbox ──────────────────────────────────────────────────

  /**
   * Build an AI-agent sandbox bound to this instance.
   * Multiple agents can share the same Linux; they serialize on the shell.
   */
  agent(config: AgentConfig = {}): AgentSandbox {
    this.assertRunning();
    return buildAgent(this, config);
  }

  // ─── Snapshot / restore ─────────────────────────────────────────────

  /**
   * Capture a snapshot for sub-100ms cold starts.
   * Not yet supported by upstream LKL; throws {@link SnapshotNotSupportedError}.
   */
  async snapshot(): Promise<SnapshotV1> {
    throw new SnapshotNotSupportedError();
  }

  /**
   * Restore from a snapshot produced by {@link snapshot}.
   * Not yet supported by upstream LKL; throws {@link SnapshotNotSupportedError}.
   */
  static async restore(_snapshot: SnapshotV1, _config?: LinuxConfig): Promise<Linux> {
    throw new SnapshotNotSupportedError();
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private assertRunning(): void {
    if (!this._running) {
      throw new Error('Linux instance is not running. Create one with Linux.create()');
    }
  }

  /** Pull pending console output into the log and the onOutput hook. */
  private captureConsole(): void {
    const chunk = this.adapter.drainOutput();
    if (chunk) {
      this.consoleLog += chunk;
      this.config.onOutput?.(chunk);
    }
  }

  private copyPath(src: string, dest: string, recursive: boolean): void {
    const st = this.adapter.stat(src);
    if (!st) throw new Error(`cp: '${src}': No such file or directory`);
    if ((st.mode & 0o170000) === 0o040000) {
      if (!recursive) throw new Error(`cp: -r not specified; omitting directory '${src}'`);
      this.adapter.mkdir(dest);
      for (const name of this.adapter.readdir(src)) {
        this.copyPath(joinPath(src, name), joinPath(dest, name), true);
      }
      return;
    }
    this.adapter.writeFile(dest, this.adapter.readFile(src));
  }
}

function ok(start: number): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, timedOut: false, duration: Date.now() - start };
}

function fail(start: number, err: Error): ExecResult {
  return { stdout: '', stderr: err.message, exitCode: 1, timedOut: false, duration: Date.now() - start };
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export default Linux;
