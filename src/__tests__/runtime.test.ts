/**
 * linux.js — runtime detection + transport tests.
 * License: MIT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntime, capabilities, defaultLoaderHint } from '../runtime.js';
import {
  WebSocketRelayTransport,
  NodeNetTransport,
  CloudflareSocketsTransport,
  autoTransport,
} from '../transport.js';

test('detectRuntime returns "node" when running under Node', () => {
  // The test harness IS Node.
  const r = detectRuntime();
  assert.ok(r === 'node' || r === 'bun', `expected node or bun, got ${r}`);
});

test('capabilities for node grant raw TCP + threads', () => {
  const caps = capabilities();
  assert.equal(caps.rawTcp, true);
  assert.equal(caps.threads, true);
});

test('defaultLoaderHint is lkl.js when threads are available', () => {
  assert.equal(defaultLoaderHint(), 'lkl.js');
});

test('autoTransport returns NodeNetTransport under Node', () => {
  const t = autoTransport();
  assert.ok(t instanceof NodeNetTransport);
});

test('transport classes are constructible (smoke)', () => {
  assert.ok(new WebSocketRelayTransport('wss://example.test/relay'));
  assert.ok(new NodeNetTransport());
  assert.ok(new CloudflareSocketsTransport());
});

test('serializeSnapshot round-trips through deserializeSnapshot', async () => {
  const { serializeSnapshot, deserializeSnapshot } = await import('../snapshot.js');
  const snap = {
    version: 1 as const,
    createdAt: new Date(0).toISOString(),
    kernelCmdline: 'quiet',
    memoryMb: 128,
    kernelVersion: 'Linux 6.x',
    memory: new Uint8Array([1, 2, 3, 4]),
    state: new Uint8Array([9, 8, 7]),
  };
  const buf = serializeSnapshot(snap);
  const round = deserializeSnapshot(buf);
  assert.equal(round.kernelCmdline, 'quiet');
  assert.deepEqual(Array.from(round.memory), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(round.state), [9, 8, 7]);
});

test('Linux.snapshot throws SnapshotNotSupportedError', async () => {
  const { Linux } = await import('../linux.js');
  const { SnapshotNotSupportedError } = await import('../snapshot.js');
  // We don't need a real boot — invoke directly on a synthetic instance.
  const instance = Object.create(Linux.prototype) as { snapshot(): Promise<unknown> };
  await assert.rejects(() => instance.snapshot(), SnapshotNotSupportedError);
});
