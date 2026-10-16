#!/usr/bin/env node

/**
 * linux.js — basic example.
 *
 * Boots the real Linux kernel (LKL→WASM), reads kernel state from /proc
 * and /sys, and does file I/O through real kernel syscalls.
 *
 * Prerequisites:
 *   node scripts/build-lkl.mjs   # builds lkl.wasm (Docker)
 *   npm run build
 */

import Linux from '../dist/index.js';

async function main() {
  console.log('🐧 linux.js — basic example (real Linux kernel via LKL+WASM)\n');

  const t0 = Date.now();
  const linux = await Linux.create({ memory: 128 });
  console.log(`✅ Kernel booted in ${Date.now() - t0} ms`);
  console.log(`   ${linux.getKernelVersion()}\n`);

  // Kernel state, straight from procfs/sysfs.
  const meminfo = await linux.readFile('/proc/meminfo');
  console.log('/proc/meminfo:');
  for (const line of meminfo.split('\n').slice(0, 4)) console.log(`  ${line}`);

  console.log('\n/proc/mounts:');
  for (const line of (await linux.readFile('/proc/mounts')).trim().split('\n')) console.log(`  ${line}`);

  console.log(`\n/sys/kernel/hostname-ish: ${(await linux.readFile('/proc/sys/kernel/hostname')).trim()}`);

  // File I/O — every call is a real kernel syscall (openat/write/pread64/...).
  await linux.writeFile('/home/demo/hello.txt', 'Hello from the Linux kernel!\n');
  await linux.writeFile('/home/demo/data.json', JSON.stringify({ kernel: 'lkl', arch: 'wasm32' }));
  console.log('\n/home/demo:');
  for (const e of await linux.readdir('/home/demo')) {
    console.log(`  ${e.isDirectory ? 'd' : '-'} ${String(e.size).padStart(6)}  ${e.name}`);
  }
  console.log(`\nhello.txt → ${JSON.stringify(await linux.readFile('/home/demo/hello.txt'))}`);

  await linux.cp('/home/demo', '/home/demo-backup', true);
  await linux.rm('/home/demo', true);
  console.log(`after cp -r + rm -r: ${(await linux.readdir('/home')).map((e) => e.name).join(', ')}`);

  console.log('\nStats:', linux.getStats());
  await linux.shutdown();
  console.log('\n👋 Shut down cleanly.');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
