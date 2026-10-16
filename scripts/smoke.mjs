#!/usr/bin/env node

/**
 * linux.js — post-build smoke test.
 *
 * Boots the kernel, exercises every public API surface, and reports a
 * pass/fail matrix. Run this immediately after the build to confirm the
 * artifact actually works before benchmarking.
 *
 *   npm run build      # tsc
 *   node scripts/smoke.mjs
 *
 * Exit code is non-zero if any check fails, so this is CI-safe.
 *
 * License: MIT.
 */

import Linux, { ExecNotSupportedError } from '../dist/index.js';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

check('kernel boots within bootTimeout', async (linux) => {
  if (!linux.running) throw new Error('not running after create()');
});

check('/proc/version is readable and looks like Linux', async (linux) => {
  const v = await linux.readFile('/proc/version');
  if (!/Linux version /.test(v)) throw new Error(`unexpected /proc/version: ${v.slice(0, 100)}`);
});

check('/proc, /sys, /dev, /tmp are mounted', async (linux) => {
  if (!(await linux.readdir('/proc')).some((e) => e.name === 'meminfo')) throw new Error('/proc not mounted');
  if (!(await linux.readdir('/sys')).some((e) => e.name === 'kernel')) throw new Error('/sys not mounted');
  if (!(await linux.exists('/dev/null'))) throw new Error('/dev not populated (devtmpfs)');
  if (!(await linux.stat('/tmp'))?.isDirectory) throw new Error('/tmp missing');
});

check('/proc/meminfo reports MemTotal', async (linux) => {
  const m = await linux.readFile('/proc/meminfo');
  if (!/MemTotal:\s+\d+ kB/.test(m)) throw new Error(m.slice(0, 120));
});

check('writeFile/readFile round-trip (creates parents)', async (linux) => {
  await linux.writeFile('/tmp/smoke/a/b/hello.txt', 'hello kernel');
  const r = await linux.readFile('/tmp/smoke/a/b/hello.txt');
  if (r !== 'hello kernel') throw new Error(`got ${JSON.stringify(r)}`);
});

check('binary round-trip larger than one 64 KB chunk', async (linux) => {
  const data = new Uint8Array(300_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 131 + 17) & 0xff;
  await linux.writeFile('/tmp/smoke/big.bin', data);
  const back = await linux.readBinary('/tmp/smoke/big.bin');
  if (!same(back, data)) throw new Error(`mismatch: wrote ${data.length}, read ${back.length}`);
  const st = await linux.stat('/tmp/smoke/big.bin');
  if (st?.size !== data.length) throw new Error(`stat size ${st?.size}`);
});

check('overwrite truncates', async (linux) => {
  await linux.writeFile('/tmp/smoke/t.txt', 'a much longer first version');
  await linux.writeFile('/tmp/smoke/t.txt', 'short');
  const r = await linux.readFile('/tmp/smoke/t.txt');
  if (r !== 'short') throw new Error(`got ${JSON.stringify(r)}`);
});

check('readdir distinguishes files and directories', async (linux) => {
  const e = await linux.readdir('/tmp/smoke');
  const byName = new Map(e.map((x) => [x.name, x]));
  if (!byName.get('a')?.isDirectory) throw new Error('a should be a directory');
  if (byName.get('big.bin')?.isDirectory !== false) throw new Error('big.bin should be a file');
});

check('readdir of a large directory (buffer growth)', async (linux) => {
  for (let i = 0; i < 4000; i++) await linux.writeFile(`/tmp/smoke/many/f-${String(i).padStart(5, '0')}.txt`, '');
  const n = (await linux.readdir('/tmp/smoke/many')).length;
  if (n !== 4000) throw new Error(`expected 4000 entries, got ${n}`);
});

check('cp -r copies a tree', async (linux) => {
  const r = await linux.cp('/tmp/smoke/a', '/tmp/smoke/a-copy', true);
  if (r.exitCode !== 0) throw new Error(r.stderr);
  if ((await linux.readFile('/tmp/smoke/a-copy/b/hello.txt')) !== 'hello kernel') throw new Error('content');
});

check('rm -r removes a tree; missing paths fail cleanly', async (linux) => {
  const r = await linux.rm('/tmp/smoke', true);
  if (r.exitCode !== 0) throw new Error(r.stderr);
  if (await linux.exists('/tmp/smoke')) throw new Error('still exists');
  if (await linux.stat('/tmp/smoke/nope') !== null) throw new Error('stat of missing path should be null');
  let threw = false;
  try { await linux.readFile('/tmp/smoke/nope'); } catch { threw = true; }
  if (!threw) throw new Error('readFile of a missing file should throw');
});

check('exec() rejects with ExecNotSupportedError (no userland)', async (linux) => {
  let err;
  try { await linux.exec('uname -a'); } catch (e) { err = e; }
  if (!(err instanceof ExecNotSupportedError)) throw new Error(`got ${err}`);
});

check('agent file tools stay inside the workdir', async (linux) => {
  const agent = linux.agent({ workdir: '/workspace' });
  if (await agent.handleToolCall('write_file', { path: 'notes.md', content: '# hi' }) !== 'ok') throw new Error('write');
  if (await agent.handleToolCall('read_file', { path: 'notes.md' }) !== '# hi') throw new Error('read');
  const esc = await agent.handleToolCall('read_file', { path: '../proc/version' });
  if (!esc.startsWith('error:')) throw new Error(`escape not blocked: ${esc.slice(0, 60)}`);
});

check('shutdown is clean', async (linux) => {
  await linux.shutdown();
  if (linux.running) throw new Error('still running');
});

async function main() {
  console.log('🐧 linux.js smoke test\n');
  const t0 = Date.now();
  const linux = await Linux.create({ memory: 256 });
  console.log(`Kernel:  ${linux.getKernelVersion()}`);
  console.log(`Boot:    ${Date.now() - t0} ms\n`);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const { name, fn } of checks) {
    process.stdout.write(`  ${name} … `);
    const t0 = Date.now();
    try {
      await fn(linux);
      const dt = Date.now() - t0;
      console.log(`✅ (${dt}ms)`);
      passed++;
    } catch (err) {
      const dt = Date.now() - t0;
      console.log(`❌ (${dt}ms)`);
      console.log(`     → ${err.message}`);
      failed++;
      failures.push({ name, error: err.message });
    }
  }

  if (linux.running) {
    try { await linux.shutdown(); } catch { /* already covered */ }
  }

  console.log(`\nResult: ${passed}/${passed + failed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ smoke test crashed:', err.message);
  console.error(err.stack);
  process.exit(2);
});
