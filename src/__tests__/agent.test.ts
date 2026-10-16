/**
 * linux.js — agent sandbox tests.
 *
 * Exercises the policy + ergonomics layer against the same stub LklAdapter
 * used by linux.test.ts. License: MIT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Linux, type LinuxInternalConfig } from '../linux.js';
import type { LklAdapter } from '../lkl-adapter.js';
import { ExecNotSupportedError } from '../errors.js';

class StubAdapter {
  initialized = false;
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(['/', '/tmp', '/proc']);
  private outputQueue: string[] = [];
  /** Captures every command line the agent forwarded. */
  history: string[] = [];
  /** Track simulated $PWD per session for __PWD__ reflection. */
  private pwd = '/';

  async load(): Promise<void> {}
  boot(): void {
    this.initialized = true;
  }

  kernelPanicked(): boolean { return false; }

  sendInput(bytes: Uint8Array): number {
    const text = new TextDecoder().decode(bytes);
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length >= 3) {
      const startEcho = lines[0].match(/^echo '(.+)'$/);
      const endEcho = lines[2].match(/^__lkl_rc=\$\?; echo "(.+?)\$\{__lkl_rc\}(.+?)"$/);
      if (startEcho && endEcho) {
        const cmd = lines[1];
        this.history.push(cmd);
        const { rc, stdout } = this.simulate(cmd);
        this.outputQueue.push(`${startEcho[1]}\n`);
        if (stdout) this.outputQueue.push(`${stdout}\n`);
        this.outputQueue.push(`${endEcho[1]}${rc}${endEcho[2]}\n# `);
      }
    }
    return bytes.length;
  }

  /** Synthesize plausible behavior for the commands the tests issue. */
  private simulate(line: string): { rc: number; stdout: string } {
    if (line.startsWith('export ')) return { rc: 0, stdout: '' };

    // Agent wraps everything as: cd 'dir' && ( ... ); __agent_rc=$?; printf '\n__PWD__:%s' "$(pwd)"; exit $rc
    const sessionMatch = line.match(/^cd '([^']*)' && \((.*)\); __agent_rc=\$\?; printf '\\n__PWD__:%s' "\$\(pwd\)"; exit \$__agent_rc$/);
    if (sessionMatch) {
      const targetDir = sessionMatch[1];
      const inner = sessionMatch[2];
      this.pwd = targetDir;
      const innerResult = this.simulate(inner);
      // Apply any `cd <dir>` inside the inner command to our pwd. The
      // session wrap does not quote the user's argument, so handle both
      // forms: `cd /tmp` and `cd 'sub'`.
      const cdMatch = inner.match(/^cd\s+(?:'([^']+)'|(\S+))$/);
      if (cdMatch) {
        const arg = cdMatch[1] ?? cdMatch[2];
        this.pwd = arg.startsWith('/') ? arg : `${this.pwd}/${arg}`.replace(/\/+/g, '/');
      }
      return {
        rc: innerResult.rc,
        stdout: `${innerResult.stdout}\n__PWD__:${this.pwd}`,
      };
    }

    // Non-session run() wrapper: cd '<dir>' && <cmd>
    const runMatch = line.match(/^cd '([^']*)' && (.*)$/);
    if (runMatch) {
      return this.simulate(runMatch[2]);
    }

    if (line === 'pwd') return { rc: 0, stdout: this.pwd };
    if (line.startsWith('echo ')) {
      return { rc: 0, stdout: line.slice(5).replace(/^'(.*)'$/, '$1') };
    }
    if (line === 'true') return { rc: 0, stdout: '' };
    if (line === 'false') return { rc: 1, stdout: '' };
    return { rc: 0, stdout: '' };
  }

  drainOutput(): string {
    const j = this.outputQueue.join('');
    this.outputQueue.length = 0;
    return j;
  }

  writeFile(path: string, data: Uint8Array | string): number {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.files.set(path, bytes);
    return bytes.length;
  }
  readFile(path: string): Uint8Array {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f;
  }
  readTextFile(path: string): string {
    if (path === '/proc/version') return 'Linux version 6.x.x (stub)\n';
    return new TextDecoder().decode(this.readFile(path));
  }
  stat(path: string): { mode: number; size: number } | null {
    if (this.dirs.has(path)) return { mode: 0o040755, size: 0 };
    const f = this.files.get(path);
    return f ? { mode: 0o100644, size: f.length } : null;
  }
  readdir(path: string): string[] {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: string[] = [];
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        out.push(f.slice(prefix.length));
      }
    }
    return out;
  }
  mkdir(path: string): void { this.dirs.add(path); }
  rm(path: string): void { this.files.delete(path); this.dirs.delete(path); }
  mount(): void {}
  shutdown(): void { this.initialized = false; }
  isRunning(): boolean { return this.initialized; }
  getKernelVersion(): string { return 'Linux version 6.x.x (stub)'; }
}

async function bootWithStub(): Promise<{ linux: Linux; stub: StubAdapter }> {
  const stub = new StubAdapter();
  const linux = await Linux.create({
    bootTimeout: 2_000,
    commandTimeout: 2_000,
    __adapter: stub as unknown as LklAdapter,
  } as LinuxInternalConfig);
  return { linux, stub };
}

test('agent.run() checks the allowlist before anything else', async () => {
  const { linux } = await bootWithStub();
  const agent = linux.agent({ allowedCommands: ['echo', 'cat'] });
  // Allowed by policy, but there is no guest userland to run it.
  await assert.rejects(() => agent.run('echo hi'), ExecNotSupportedError);
  await assert.rejects(() => agent.run('python script.py'), /not in the allowlist/);
  await linux.shutdown();
});

test('agent.run() honors the denylist even without an allowlist', async () => {
  const { linux } = await bootWithStub();
  const agent = linux.agent({ deniedCommands: ['rm', 'mkfs'] });
  await assert.rejects(() => agent.run('rm -rf /'), /denied/);
  await assert.rejects(() => agent.run('/usr/bin/rm foo'), /denied/);
  await linux.shutdown();
});

test('shell surfaces reject with ExecNotSupportedError', async () => {
  const { linux } = await bootWithStub();
  const agent = linux.agent({ workdir: '/workspace' });
  const session = await agent.session();
  await assert.rejects(() => session.send('ls'), ExecNotSupportedError);
  await session.close();
  await assert.rejects(async () => { for await (const _ of agent.stream('ls')) { /* drain */ } }, ExecNotSupportedError);
  assert.throws(() => agent.toolDefinition(), ExecNotSupportedError);
  await linux.shutdown();
});

test('agent.fileToolDefinitions() + handleToolCall() round-trip', async () => {
  const { linux } = await bootWithStub();
  const agent = linux.agent({ workdir: '/workspace', maxOutputBytes: 8 });
  const names = agent.fileToolDefinitions().map((t) => t.name);
  assert.deepEqual(names, ['read_file', 'write_file', 'list_files']);
  for (const t of agent.fileToolDefinitions()) {
    assert.equal((t.input_schema as { type: string }).type, 'object');
  }

  assert.equal(await agent.handleToolCall('write_file', { path: 'notes.txt', content: '0123456789' }), 'ok');
  assert.equal(await agent.handleToolCall('read_file', { path: 'notes.txt' }), '01234567\n[truncated]');
  assert.equal(await agent.handleToolCall('list_files', {}), 'notes.txt');
  assert.match(await agent.handleToolCall('read_file', { path: '../etc/passwd' }), /^error: .*outside the workdir/);
  assert.match(await agent.handleToolCall('nope', {}), /^error: unknown tool/);
  await linux.shutdown();
});

test('agent.putFile / getFile / listFiles round-trip and stay in the workdir', async () => {
  const { linux } = await bootWithStub();
  const agent = linux.agent({ workdir: '/workspace' });
  await agent.putFile('hello.txt', 'world');
  assert.equal(await agent.getFile('hello.txt'), 'world');
  assert.equal(await agent.getFile('./sub/../hello.txt'), 'world');
  const list = await agent.listFiles();
  assert.ok(list.some((e) => e.name === 'hello.txt' && !e.isDirectory));
  for (const escape of ['/etc/passwd', '../etc/passwd', '/workspace/../etc/passwd', 'a/../../etc', '/workspacefoo/x']) {
    await assert.rejects(() => agent.putFile(escape, 'pwned'), /outside the workdir/, escape);
  }
  await linux.shutdown();
});
