#!/usr/bin/env node

/**
 * linux.js — benchmark harness.
 *
 * Measures the metrics that matter for the AI-agent / serverless pitch:
 *
 *   1. Cold-boot latency       (Linux.create → kernel ready)
 *   2. Syscall latency         (stat of an existing path; warm avg over N)
 *   3. File I/O throughput     (4 KB / 64 KB / 1 MB write+read)
 *   4. Metadata ops            (create + list + remove many small files)
 *   5. Memory footprint        (process RSS before/after boot)
 *   6. Reliability             (N write/read/verify round-trips)
 *
 * Prints a human-readable table AND a machine-readable JSON line at the
 * bottom (`{"bench_results": ...}`) for CI consumption.
 *
 *   node scripts/bench.mjs
 *   node scripts/bench.mjs --json > results.json
 *   node scripts/bench.mjs --warm-runs 500 --reliability-runs 5000
 *
 * License: MIT.
 */

import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import Linux from '../dist/index.js';

const { values: opts } = parseArgs({
  options: {
    'warm-runs':        { type: 'string', default: '100' },
    'reliability-runs': { type: 'string', default: '1000' },
    'memory-mb':        { type: 'string', default: '256' },
    'json':             { type: 'boolean', default: false },
  },
});

const WARM_RUNS = Number.parseInt(opts['warm-runs'], 10);
const RELIABILITY_RUNS = Number.parseInt(opts['reliability-runs'], 10);
const MEMORY_MB = Number.parseInt(opts['memory-mb'], 10);

function fmt(n, unit = 'ms') {
  if (typeof n !== 'number') return String(n);
  if (n >= 1000 && unit === 'ms') return `${(n / 1000).toFixed(2)} s`;
  if (n >= 1000 && unit === 'KB') return `${(n / 1024).toFixed(2)} MB`;
  return `${n.toFixed(2)} ${unit}`;
}

function rss() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    n: samples.length,
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted[sorted.length - 1],
    mean: sum / samples.length,
  };
}

async function main() {
  const results = {};

  if (!opts.json) {
    console.log('🐧 linux.js benchmark');
    console.log(`Host:   ${process.platform} ${process.arch}, Node ${process.version}`);
    console.log(`Kernel: ${MEMORY_MB} MB RAM, warm=${WARM_RUNS}, reliability=${RELIABILITY_RUNS}\n`);
  }

  // ── 1. Cold boot ───────────────────────────────────────────────────
  const rssBefore = rss();
  const bootStart = performance.now();
  const linux = await Linux.create({ memory: MEMORY_MB });
  const bootMs = performance.now() - bootStart;
  const rssAfterBoot = rss();
  results.boot = { ms: bootMs, kernelVersion: linux.getKernelVersion() };
  results.rss = { beforeMb: rssBefore, afterBootMb: rssAfterBoot, deltaMb: rssAfterBoot - rssBefore };

  if (!opts.json) {
    console.log(`Boot:               ${fmt(bootMs)}`);
    console.log(`Kernel:             ${linux.getKernelVersion()}`);
    console.log(`RSS:                ${rssBefore} MB → ${rssAfterBoot} MB (Δ ${rssAfterBoot - rssBefore} MB)\n`);
  }

  // ── 2. Syscall latency (statx round-trip) ─────────────────────────
  {
    const samples = [];
    for (let i = 0; i < WARM_RUNS; i++) {
      const t = performance.now();
      await linux.stat('/proc/meminfo');
      samples.push(performance.now() - t);
    }
    results.syscall = stats(samples);
    if (!opts.json) {
      const st = results.syscall;
      console.log(`stat() latency:     p50 ${fmt(st.p50)}  p95 ${fmt(st.p95)}  max ${fmt(st.max)}  (n=${st.n})\n`);
    }
  }

  // ── 3. File I/O throughput ────────────────────────────────────────
  results.io = {};
  for (const size of [4 * 1024, 64 * 1024, 1024 * 1024]) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i & 0xff;
    const reps = size >= 1024 * 1024 ? 10 : 50;
    const tw = performance.now();
    for (let r = 0; r < reps; r++) await linux.writeFile(`/tmp/bench-${size}.bin`, data);
    const writeMs = (performance.now() - tw) / reps;
    const tr = performance.now();
    for (let r = 0; r < reps; r++) await linux.readBinary(`/tmp/bench-${size}.bin`);
    const readMs = (performance.now() - tr) / reps;
    const mbps = (ms) => (size / 1024 / 1024) / (ms / 1000);
    results.io[size] = { writeMs, readMs, writeMBps: mbps(writeMs), readMBps: mbps(readMs) };
    if (!opts.json) {
      console.log(`I/O ${String(size / 1024).padStart(5)} KB:       write ${fmt(writeMs)} (${mbps(writeMs).toFixed(1)} MB/s)  read ${fmt(readMs)} (${mbps(readMs).toFixed(1)} MB/s)`);
    }
  }
  if (!opts.json) console.log();

  // ── 4. Metadata ops ───────────────────────────────────────────────
  {
    const N = 1000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await linux.writeFile(`/tmp/meta/f${i}`, '');
    const createMs = performance.now() - t0;
    const t1 = performance.now();
    const listed = (await linux.readdir('/tmp/meta')).length;
    const listMs = performance.now() - t1;
    const t2 = performance.now();
    await linux.rm('/tmp/meta', true);
    const rmMs = performance.now() - t2;
    results.metadata = { files: N, listed, createMs, listMs, rmMs };
    if (!opts.json) {
      console.log(`Metadata (${N} files): create ${fmt(createMs)}  readdir ${fmt(listMs)}  rm -r ${fmt(rmMs)}\n`);
    }
  }

  // ── 6. Reliability ────────────────────────────────────────────────
  let ok = 0;
  let fail = 0;
  const failures = [];
  const relStart = performance.now();
  for (let i = 0; i < RELIABILITY_RUNS; i++) {
    try {
      const body = `round-trip ${i} ${'x'.repeat(i % 512)}`;
      await linux.writeFile('/tmp/rel.txt', body);
      if ((await linux.readFile('/tmp/rel.txt')) !== body) throw new Error('content mismatch');
      ok++;
    } catch (err) {
      fail++;
      if (failures.length < 5) failures.push({ i, error: err.message });
    }
  }
  const relMs = performance.now() - relStart;
  results.reliability = {
    runs: RELIABILITY_RUNS,
    ok,
    fail,
    passRate: ok / RELIABILITY_RUNS,
    totalMs: relMs,
    samples: failures,
  };
  if (!opts.json) {
    console.log(`Reliability:        ${ok}/${RELIABILITY_RUNS} passed (${((ok / RELIABILITY_RUNS) * 100).toFixed(2)}%) in ${fmt(relMs)}`);
    if (failures.length > 0) {
      console.log('  First failures:');
      for (const f of failures) console.log(`    ${JSON.stringify(f)}`);
    }
    console.log();
  }

  const rssFinal = rss();
  results.rss.finalMb = rssFinal;
  if (!opts.json) console.log(`RSS final:          ${rssFinal} MB\n`);

  await linux.shutdown();

  if (opts.json) {
    console.log(JSON.stringify({ bench_results: results }, null, 2));
  } else {
    console.log('Done. Machine-readable summary:');
    console.log(`{"bench_results":${JSON.stringify(results)}}`);
  }
}

main().catch((err) => {
  console.error('❌ benchmark failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
