/**
 * linux.js — unit tests for the TS layer.
 *
 * These exercise the wrapper against a stub LklAdapter — no lkl.wasm
 * needed. They cover:
 *   - create() resolves without a guest shell (library mode)
 *   - exec()/which() report the missing userland
 *   - cp() over the filesystem API
 *   - writeFile creates parent directories
 *   - readdir maps st_mode to isDirectory
 *   - shutdown is idempotent
 *
 * License: MIT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Linux, type LinuxInternalConfig } from '../linux.js';
import type { LklAdapter } from '../lkl-adapter.js';
import { ExecNotSupportedError } from '../errors.js';

/** Drop-in stub that imitates an init shell with sentinel echo. */
class StubAdapter {
  initialized = false;
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(['/', '/tmp', '/proc']);

  private outputQueue: string[] = [];

  async load(): Promise<void> {}

  boot(): void {
    this.initialized = true;
    // Kernel console output; deliberately no shell prompt.
    this.outputQueue.push('Linux version 6.x.x (linux.js stub)\n');
  }

  kernelPanicked(): boolean { return false; }

  sendInput(bytes: Uint8Array): number {
    const text = new TextDecoder().decode(bytes);
    const lines = text.split('\n').filter((l) => l.length > 0);

    // The exec wrapper always sends three lines:
    //   echo '<START_SENTINEL>'
    //   <command>
    //   __lkl_rc=$?; echo "<END_SENTINEL>${__lkl_rc}__END__"
    if (lines.length >= 3) {
      const startEcho = lines[0].match(/^echo '(.+)'$/);
      const endEcho = lines[2].match(/^__lkl_rc=\$\?; echo "(.+?)\$\{__lkl_rc\}(.+?)"$/);
      if (startEcho && endEcho) {
        const cmd = lines[1];
        const rc = this.simulate(cmd);
        this.outputQueue.push(`${startEcho[1]}\n`);
        this.outputQueue.push(`${endEcho[1]}${rc}${endEcho[2]}\n# `);
      }
    }
    return bytes.length;
  }

  private simulate(line: string): number {
    if (line.startsWith('export ')) return 0;
    if (line === 'true' || line === 'exit 0') return 0;
    if (line === 'false') return 1;
    if (line.startsWith('command -v ')) return line.includes('nonexistent') ? 1 : 0;
    return 0;
  }

  drainOutput(): string {
    const joined = this.outputQueue.join('');
    this.outputQueue.length = 0;
    return joined;
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
    if (path === '/proc/version') return 'Linux version 6.x.x (linux.js stub)\n';
    return new TextDecoder().decode(this.readFile(path));
  }

  stat(path: string): { mode: number; size: number } | null {
    if (this.dirs.has(path)) return { mode: 0o040755, size: 0 };
    const f = this.files.get(path);
    if (!f) return null;
    return { mode: 0o100644, size: f.length };
  }

  readdir(path: string): string[] {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: string[] = [];
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        out.push(f.slice(prefix.length));
      }
    }
    for (const d of this.dirs) {
      if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
        const name = d.slice(prefix.length);
        if (name && !out.includes(name)) out.push(name);
      }
    }
    return out;
  }

  mkdir(path: string): void { this.dirs.add(path); }

  rm(path: string): void {
    this.files.delete(path);
    this.dirs.delete(path);
  }

  mount(): void {}

  shutdown(): void { this.initialized = false; }

  isRunning(): boolean { return this.initialized; }

  getKernelVersion(): string { return 'Linux version 6.x.x (linux.js stub)'; }
}

async function bootWithStub(overrides: Partial<LinuxInternalConfig> = {}): Promise<{ linux: Linux; stub: StubAdapter }> {
  const stub = new StubAdapter();
  const linux = await Linux.create({
    bootTimeout: 2_000,
    commandTimeout: 2_000,
    ...overrides,
    __adapter: stub as unknown as LklAdapter,
  } as LinuxInternalConfig);
  return { linux, stub };
}

test('create resolves in library mode and captures the kernel log', async () => {
  const chunks: string[] = [];
  const { linux } = await bootWithStub({ onOutput: (c) => chunks.push(c) });
  assert.equal(linux.running, true);
  assert.match(linux.kernelLog(), /Linux version/);
  assert.match(chunks.join(''), /Linux version/);
  await linux.shutdown();
});

test('exec rejects with ExecNotSupportedError and which() is false', async () => {
  const { linux } = await bootWithStub();
  await assert.rejects(() => linux.exec('true'), ExecNotSupportedError);
  assert.equal(await linux.which('sh'), false);
  await linux.shutdown();
});

test('stat reports size and directory-ness, null when missing', async () => {
  const { linux, stub } = await bootWithStub();
  stub.files.set('/tmp/f', new TextEncoder().encode('abc'));
  assert.deepEqual(await linux.stat('/tmp/f'), { mode: 0o100644, size: 3, isDirectory: false });
  assert.equal((await linux.stat('/tmp'))?.isDirectory, true);
  assert.equal(await linux.stat('/nope'), null);
  await linux.shutdown();
});

test('cp copies files, and directories only with recursive', async () => {
  const { linux, stub } = await bootWithStub();
  stub.dirs.add('/src');
  stub.files.set('/src/a.txt', new TextEncoder().encode('A'));
  assert.equal((await linux.cp('/src/a.txt', '/tmp/a.txt')).exitCode, 0);
  assert.equal(await linux.readFile('/tmp/a.txt'), 'A');

  const noRecurse = await linux.cp('/src', '/dst');
  assert.equal(noRecurse.exitCode, 1);
  assert.match(noRecurse.stderr, /-r not specified/);

  assert.equal((await linux.cp('/src', '/dst', true)).exitCode, 0);
  assert.ok(stub.dirs.has('/dst'));
  assert.equal(await linux.readFile('/dst/a.txt'), 'A');

  assert.equal((await linux.cp('/missing', '/x')).exitCode, 1);
  await linux.shutdown();
});

test('writeFile creates the parent directory if missing', async () => {
  const { linux, stub } = await bootWithStub();
  await linux.writeFile('/var/www/index.html', 'hi');
  assert.ok(stub.dirs.has('/var/www'), 'parent dir should be created');
  assert.equal(
    new TextDecoder().decode(stub.files.get('/var/www/index.html')!),
    'hi',
  );
  await linux.shutdown();
});

test('readdir reports directories vs files via mode bits', async () => {
  const { linux, stub } = await bootWithStub();
  stub.files.set('/tmp/a.txt', new TextEncoder().encode('a'));
  stub.dirs.add('/tmp/sub');
  const entries = await linux.readdir('/tmp');
  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.equal(byName.get('a.txt')?.isDirectory, false);
  assert.equal(byName.get('sub')?.isDirectory, true);
  await linux.shutdown();
});

test('shutdown is idempotent', async () => {
  const { linux } = await bootWithStub();
  await linux.shutdown();
  await linux.shutdown();
  assert.equal(linux.running, false);
});
