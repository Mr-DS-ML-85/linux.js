/**
 * linux.js — AI agent sandbox API.
 *
 * Built on top of `Linux` to give agent frameworks the shape they want:
 *   - File staging confined to a workdir (`putFile`, `getFile`, `listFiles`)
 *   - LLM file tools (`fileToolDefinitions`, `handleToolCall`)
 *   - Command policy (allow/deny lists) and output caps
 *
 * ```ts
 * const linux = await Linux.create({ memory: 256 });
 * const agent = linux.agent({ workdir: '/workspace' });
 *
 * // Hand these to your model's `tools`, route its calls back:
 * const tools = agent.fileToolDefinitions();
 * const reply = await agent.handleToolCall('write_file', { path: 'a.txt', content: 'hi' });
 * ```
 *
 * `run` / `stream` / `session` keep their signatures but reject with
 * ExecNotSupportedError: this build has no guest userland (see errors.ts).
 *
 * License: MIT.
 */

import type { Linux } from './linux.js';
import { ExecNotSupportedError } from './errors.js';

/** An LLM function-calling tool schema (OpenAI / Anthropic shaped). */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgentConfig {
  /** Working directory inside the guest. Created on first use. Default `/workspace`. */
  workdir?: string;

  /**
   * Allowlist for binary names that may be executed. When set, the agent
   * rejects any run() whose first token is not in the list. `undefined`
   * (the default) means "no allowlist — anything goes".
   */
  allowedCommands?: string[];

  /**
   * Denylist applied after the allowlist. First token in the denylist =>
   * the call is rejected. Useful for `rm`, `mkfs`, `dd`, etc.
   */
  deniedCommands?: string[];

  /** Default per-call timeout in ms. Default 30_000. */
  defaultTimeout?: number;

  /**
   * Hard cap on bytes returned from a single run(). Anything over the cap
   * is truncated and `truncated: true` is set on the result. Default 1 MB.
   */
  maxOutputBytes?: number;

  /** Optional environment variables injected for every run(). */
  env?: Record<string, string>;
}

export interface AgentRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  /** True if maxOutputBytes was hit and trailing bytes were dropped. */
  truncated: boolean;
  /** True if the call hit the timeout. */
  killed: boolean;
  /** The command as the agent invoked it (after policy rewrites). */
  command: string;
}

export interface AgentSession {
  /** Send a command and await its result. */
  send(command: string, timeout?: number): Promise<AgentRunResult>;
  /** Read the current working directory inside the session. */
  cwd(): Promise<string>;
  /** Close the session and release resources. Idempotent. */
  close(): Promise<void>;
  /** True once close() has run. */
  readonly closed: boolean;
}

/**
 * The agent sandbox. Build one via `linux.agent(config)`.
 *
 * All methods enforce the configured policy (allowedCommands, deniedCommands,
 * defaultTimeout, maxOutputBytes) before delegating to the underlying Linux.
 */
export class AgentSandbox {
  private workdirReady = false;

  constructor(private linux: Linux, private cfg: Required<AgentConfig>) {}

  /** One-shot exec with policy + output cap applied. */
  async run(command: string, opts: { timeout?: number; cwd?: string } = {}): Promise<AgentRunResult> {
    this.checkPolicy(command);
    await this.ensureWorkdir();

    const cwd = opts.cwd ?? this.cfg.workdir;
    const wrapped = this.wrapWithEnvAndCwd(command, cwd);
    const startedAt = Date.now();
    const timeout = opts.timeout ?? this.cfg.defaultTimeout;

    const result = await this.linux.exec(wrapped, timeout);
    let stdout = result.stdout;
    let truncated = false;
    if (stdout.length > this.cfg.maxOutputBytes) {
      stdout = stdout.slice(0, this.cfg.maxOutputBytes);
      truncated = true;
    }

    return {
      stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      duration: Date.now() - startedAt,
      truncated,
      killed: result.timedOut,
      command,
    };
  }

  /**
   * Stream stdout chunks for a long-running command. The returned iterator
   * yields whatever new bytes arrive between polls; consumers can break early
   * to "kill" the command (best-effort — the timeout still applies).
   */
  async *stream(command: string, opts: { timeout?: number; cwd?: string } = {}): AsyncIterableIterator<string> {
    this.checkPolicy(command);
    await this.ensureWorkdir();

    const cwd = opts.cwd ?? this.cfg.workdir;
    const timeout = opts.timeout ?? this.cfg.defaultTimeout;
    const wrapped = this.wrapWithEnvAndCwd(command, cwd);

    // Run the whole command, then yield its stdout in chunks. True streaming
    // requires a kernel-side pty fan-out; that's a follow-up once lkl.wasm
    // exposes a second output channel. The chunked yield still lets agents
    // react quickly because exec returns as soon as the sentinel arrives.
    const result = await this.linux.exec(wrapped, timeout);
    let remaining = result.stdout;
    if (remaining.length > this.cfg.maxOutputBytes) {
      remaining = remaining.slice(0, this.cfg.maxOutputBytes);
    }

    const CHUNK = 8192;
    while (remaining.length > 0) {
      yield remaining.slice(0, CHUNK);
      remaining = remaining.slice(CHUNK);
    }
  }

  /**
   * Open a long-lived session. State (cwd, env, shell variables) persists
   * across `send()` calls. Backed by the same Linux instance — multiple
   * sessions share the underlying guest shell, so they're serialized.
   */
  async session(): Promise<AgentSession> {
    this.checkPolicy('true'); // policy precheck: ensure sessions are allowed
    await this.ensureWorkdir();

    const cfg = this.cfg;
    const linux = this.linux;
    let cwd = cfg.workdir;
    let closed = false;
    let busy: Promise<void> = Promise.resolve();

    return {
      get closed() { return closed; },

      async send(command: string, timeout?: number): Promise<AgentRunResult> {
        if (closed) throw new Error('session closed');
        // Serialize to preserve cwd transitions across `cd`.
        const myTurn = busy.then(async () => {
          const startedAt = Date.now();
          const wrapped = wrapForSession(command, cwd, cfg.env);
          const result = await linux.exec(wrapped, timeout ?? cfg.defaultTimeout);
          let stdout = result.stdout;
          let truncated = false;
          // Extract the trailing __PWD__ marker so we can track cwd.
          const pwdMatch = stdout.match(/\n__PWD__:([^\n]+)\s*$/);
          if (pwdMatch) {
            cwd = pwdMatch[1].trim();
            stdout = stdout.slice(0, pwdMatch.index ?? stdout.length);
          }
          if (stdout.length > cfg.maxOutputBytes) {
            stdout = stdout.slice(0, cfg.maxOutputBytes);
            truncated = true;
          }
          return {
            stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            duration: Date.now() - startedAt,
            truncated,
            killed: result.timedOut,
            command,
          };
        });
        busy = myTurn.then(() => {}, () => {});
        return myTurn;
      },

      async cwd() { return cwd; },

      async close() {
        if (closed) return;
        closed = true;
        // Nothing to free at the guest level — sessions are pure host bookkeeping.
      },
    };
  }

  /** Upload a file (string or bytes) to the workdir. */
  async putFile(relativePath: string, content: string | Uint8Array): Promise<void> {
    await this.ensureWorkdir();
    const path = this.resolveInWorkdir(relativePath);
    await this.linux.writeFile(path, content);
  }

  /** Read a file from the workdir as text. */
  async getFile(relativePath: string): Promise<string> {
    const path = this.resolveInWorkdir(relativePath);
    return this.linux.readFile(path);
  }

  /** List the workdir contents (non-recursive). */
  async listFiles(relativePath = ''): Promise<{ name: string; size: number; isDirectory: boolean }[]> {
    const path = relativePath ? this.resolveInWorkdir(relativePath) : this.cfg.workdir;
    const entries = await this.linux.readdir(path);
    return entries.map((e) => ({ name: e.name, size: e.size, isDirectory: e.isDirectory }));
  }

  /**
   * Function-call schema for a shell tool (OpenAI / Anthropic format).
   *
   * Throws {@link ExecNotSupportedError}: this build has no guest userland,
   * so advertising a shell tool to a model would only produce failing
   * calls. Use {@link fileToolDefinitions} + {@link handleToolCall}.
   */
  toolDefinition(): ToolDefinition {
    throw new ExecNotSupportedError('the linux_shell tool');
  }

  /**
   * Function-call schemas for the filesystem tools that work in this build
   * (read_file, write_file, list_files), confined to the workdir. Dispatch
   * the model's calls with {@link handleToolCall}.
   */
  fileToolDefinitions(): ToolDefinition[] {
    const path = { type: 'string', description: `Path relative to ${this.cfg.workdir} (or absolute inside it).` };
    return [
      {
        name: 'read_file',
        description: `Read a UTF-8 text file from the sandbox. Output is truncated past ${this.cfg.maxOutputBytes} bytes.`,
        input_schema: { type: 'object', properties: { path }, required: ['path'] },
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a text file in the sandbox (parent directories are created).',
        input_schema: {
          type: 'object',
          properties: { path, content: { type: 'string', description: 'Full file contents.' } },
          required: ['path', 'content'],
        },
      },
      {
        name: 'list_files',
        description: 'List a directory in the sandbox. Directories end with "/".',
        input_schema: { type: 'object', properties: { path: { ...path, description: path.description + ' Defaults to the workdir.' } } },
      },
    ];
  }

  /**
   * Execute one tool call produced from {@link fileToolDefinitions}. Returns
   * the text to hand back to the model; errors are returned as text too
   * (prefixed "error:") so the model can recover.
   */
  async handleToolCall(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case 'read_file': {
          const text = await this.getFile(String(input.path ?? ''));
          return text.length > this.cfg.maxOutputBytes
            ? text.slice(0, this.cfg.maxOutputBytes) + '\n[truncated]'
            : text;
        }
        case 'write_file':
          await this.putFile(String(input.path ?? ''), String(input.content ?? ''));
          return 'ok';
        case 'list_files': {
          const entries = await this.listFiles(input.path === undefined ? '.' : String(input.path));
          return entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).sort().join('\n');
        }
        default:
          return `error: unknown tool '${name}'`;
      }
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private checkPolicy(command: string): void {
    const head = firstToken(command);
    if (!head) throw new Error('agent: empty command');
    if (this.cfg.allowedCommands && this.cfg.allowedCommands.length > 0 &&
        !this.cfg.allowedCommands.includes(head)) {
      throw new Error(`agent: command '${head}' is not in the allowlist`);
    }
    if (this.cfg.deniedCommands.includes(head)) {
      throw new Error(`agent: command '${head}' is denied`);
    }
  }

  private async ensureWorkdir(): Promise<void> {
    if (this.workdirReady) return;
    const exists = await this.linux.exists(this.cfg.workdir);
    if (!exists) await this.linux.mkdir(this.cfg.workdir);
    this.workdirReady = true;
  }

  private wrapWithEnvAndCwd(command: string, cwd: string): string {
    const envPart = Object.entries(this.cfg.env)
      .map(([k, v]) => `${k}=${shQuote(v)}`)
      .join(' ');
    const prefix = envPart ? `env ${envPart} ` : '';
    return `cd ${shQuote(cwd)} && ${prefix}${command}`;
  }

  /**
   * Resolve a caller path against the workdir and confine it there.
   * Normalizes `.`/`..` first — a plain prefix check let
   * `../etc/passwd` and `/workspace/../etc/passwd` escape.
   */
  private resolveInWorkdir(rel: string): string {
    const root = normalizePosix(this.cfg.workdir);
    const full = normalizePosix(rel.startsWith('/') ? rel : `${root}/${rel}`);
    if (full !== root && !full.startsWith(root === '/' ? '/' : `${root}/`)) {
      throw new Error(`agent: path '${rel}' is outside the workdir`);
    }
    return full;
  }
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

/** Collapse `.`, `..` and duplicate slashes in an absolute POSIX path. */
function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

function firstToken(command: string): string {
  const trimmed = command.trim();
  // Strip leading env assignments (FOO=bar BAZ=qux real-cmd ...).
  let i = 0;
  while (i < trimmed.length) {
    const space = trimmed.indexOf(' ', i);
    const token = space === -1 ? trimmed.slice(i) : trimmed.slice(i, space);
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      // Strip a leading path: `/bin/cat` -> `cat`.
      const slash = token.lastIndexOf('/');
      return slash >= 0 ? token.slice(slash + 1) : token;
    }
    if (space === -1) break;
    i = space + 1;
  }
  return '';
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function wrapForSession(command: string, cwd: string, env: Record<string, string>): string {
  const envPart = Object.entries(env)
    .map(([k, v]) => `${k}=${shQuote(v)}`)
    .join(' ');
  const prefix = envPart ? `env ${envPart} ` : '';
  return `cd ${shQuote(cwd)} && (${prefix}${command}); __agent_rc=$?; printf '\\n__PWD__:%s' "$(pwd)"; exit $__agent_rc`;
}

/** Build an AgentSandbox with fully-resolved defaults. */
export function buildAgent(linux: Linux, cfg: AgentConfig = {}): AgentSandbox {
  const resolved: Required<AgentConfig> = {
    workdir: cfg.workdir ?? '/workspace',
    allowedCommands: cfg.allowedCommands ?? [],
    deniedCommands: cfg.deniedCommands ?? [],
    defaultTimeout: cfg.defaultTimeout ?? 30_000,
    maxOutputBytes: cfg.maxOutputBytes ?? 1_048_576,
    env: cfg.env ?? {},
  };
  return new AgentSandbox(linux, resolved);
}
