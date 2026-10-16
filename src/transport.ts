/**
 * linux.js — network transport abstraction.
 *
 * LKL's virtio-net needs raw TCP/UDP socket primitives. Each runtime supplies
 * them differently:
 *   - Node / Bun / Deno: `net.Socket` etc.
 *   - Browser:           no raw sockets — tunnel through a WebSocket relay.
 *   - Cloudflare:        `connect()` from `cloudflare:sockets`.
 *
 * The kernel binary will call into these transports through host ops once the
 * networking-enabled build is published. Today this module ships the API so
 * higher layers (and integrators) can plug in transports ahead of time.
 *
 * License: MIT.
 */

import { detectRuntime } from './runtime.js';

export interface NetworkSocket {
  /** Send bytes. Returns the number actually written (may be < len). */
  send(data: Uint8Array): Promise<number>;
  /** Read up to `maxBytes`; returns an empty array when the peer is half-closed. */
  recv(maxBytes: number): Promise<Uint8Array>;
  /** Close both directions. Idempotent. */
  close(): Promise<void>;
  /** `true` once close() has run or the peer fully closed. */
  readonly closed: boolean;
}

export interface NetworkTransport {
  connect(host: string, port: number): Promise<NetworkSocket>;
  /** Optional: DNS resolution. Returns IP strings or rejects. */
  resolve?(hostname: string): Promise<string[]>;
  /** Close the transport and any pooled resources. */
  close(): Promise<void>;
}

/* ─── WebSocket relay transport ──────────────────────────────────────── */

/**
 * Tunnels TCP through a WebSocket. Each `connect()` opens one WS and the
 * relay forwards bytes both ways.
 *
 * Wire format (binary frames only):
 *   First frame from client: JSON `{ host, port }`
 *   First frame from server: JSON `{ ok: true }` or `{ error: string }`
 *   Subsequent frames: raw payload, both directions
 *
 * The relay implementation is left to the deployer. A minimal Node reference
 * implementation lives under `scripts/relay.mjs`.
 */
export class WebSocketRelayTransport implements NetworkTransport {
  constructor(private relayUrl: string) {}

  async connect(host: string, port: number): Promise<NetworkSocket> {
    const ws = new WebSocket(this.relayUrl);
    ws.binaryType = 'arraybuffer';

    await waitForOpen(ws);
    ws.send(JSON.stringify({ host, port }));

    const handshake = await readOneFrame(ws);
    const ack = parseHandshake(handshake);
    if (!ack.ok) {
      ws.close();
      throw new Error(`relay rejected ${host}:${port}: ${ack.error}`);
    }

    return new WebSocketSocket(ws);
  }

  async close(): Promise<void> { /* nothing pooled */ }
}

class WebSocketSocket implements NetworkSocket {
  closed = false;
  private incoming: Uint8Array[] = [];
  private waiting?: { resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void };

  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const data = ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : typeof ev.data === 'string'
        ? new TextEncoder().encode(ev.data)
        : new Uint8Array(0);
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w.resolve(data);
      } else {
        this.incoming.push(data);
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      if (this.waiting) {
        this.waiting.resolve(new Uint8Array(0));
        this.waiting = undefined;
      }
    });
    ws.addEventListener('error', () => {
      if (this.waiting) {
        this.waiting.reject(new Error('relay socket error'));
        this.waiting = undefined;
      }
    });
  }

  async send(data: Uint8Array): Promise<number> {
    if (this.closed) throw new Error('socket closed');
    this.ws.send(data);
    return data.length;
  }

  async recv(maxBytes: number): Promise<Uint8Array> {
    if (this.incoming.length > 0) {
      const head = this.incoming.shift()!;
      if (head.length <= maxBytes) return head;
      this.incoming.unshift(head.subarray(maxBytes));
      return head.subarray(0, maxBytes);
    }
    if (this.closed) return new Uint8Array(0);
    return new Promise<Uint8Array>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.OPEN) return resolve();
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('failed to open relay WebSocket')), { once: true });
  });
}

function readOneFrame(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('error', onErr);
      resolve(ev.data);
    };
    const onErr = () => {
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('error', onErr);
      reject(new Error('relay error during handshake'));
    };
    ws.addEventListener('message', onMsg);
    ws.addEventListener('error', onErr);
  });
}

function parseHandshake(raw: unknown): { ok: true } | { ok: false; error: string } {
  try {
    const text = typeof raw === 'string'
      ? raw
      : raw instanceof ArrayBuffer
      ? new TextDecoder().decode(new Uint8Array(raw))
      : '';
    const obj = JSON.parse(text) as { ok?: boolean; error?: string };
    if (obj.ok) return { ok: true };
    return { ok: false, error: obj.error ?? 'unknown' };
  } catch {
    return { ok: false, error: 'malformed handshake from relay' };
  }
}

/* ─── Node raw TCP transport ─────────────────────────────────────────── */

export class NodeNetTransport implements NetworkTransport {
  async connect(host: string, port: number): Promise<NetworkSocket> {
    const { createConnection } = await import('node:net');
    const sock = createConnection({ host, port });

    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', (err: Error) => reject(err));
    });

    return new NodeSocket(sock);
  }

  async resolve(hostname: string): Promise<string[]> {
    const dns = await import('node:dns/promises');
    const r = await dns.lookup(hostname, { all: true });
    return r.map((x: { address: string }) => x.address);
  }

  async close(): Promise<void> { /* nothing pooled */ }
}

class NodeSocket implements NetworkSocket {
  closed = false;
  private incoming: Uint8Array[] = [];
  private waiting?: { resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void };
  // Loosely typed because we import node:net dynamically.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private sock: any) {
    sock.on('data', (chunk: Uint8Array) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w.resolve(chunk);
      } else {
        this.incoming.push(chunk);
      }
    });
    sock.on('close', () => {
      this.closed = true;
      if (this.waiting) {
        this.waiting.resolve(new Uint8Array(0));
        this.waiting = undefined;
      }
    });
    sock.on('error', (err: Error) => {
      if (this.waiting) {
        this.waiting.reject(err);
        this.waiting = undefined;
      }
    });
  }

  async send(data: Uint8Array): Promise<number> {
    if (this.closed) throw new Error('socket closed');
    return new Promise((resolve, reject) => {
      this.sock.write(data, (err?: Error | null) => {
        if (err) reject(err);
        else resolve(data.length);
      });
    });
  }

  async recv(maxBytes: number): Promise<Uint8Array> {
    if (this.incoming.length > 0) {
      const head = this.incoming.shift()!;
      if (head.length <= maxBytes) return head;
      this.incoming.unshift(head.subarray(maxBytes));
      return head.subarray(0, maxBytes);
    }
    if (this.closed) return new Uint8Array(0);
    return new Promise<Uint8Array>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
  }
}

/* ─── Cloudflare Workers transport ───────────────────────────────────── */

/**
 * Uses `connect()` from `cloudflare:sockets`. Requires the Worker to have
 * `compatibility_flag = ["nodejs_compat"]` or to import `cloudflare:sockets`
 * directly. The import is deferred so the module can still be loaded in
 * Node without crashing.
 */
export class CloudflareSocketsTransport implements NetworkTransport {
  async connect(host: string, port: number): Promise<NetworkSocket> {
    const sockets = await import('cloudflare:sockets' as string).catch(() => {
      throw new Error('CloudflareSocketsTransport requires the cloudflare:sockets binding.');
    });
    const { connect } = sockets as { connect: (addr: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close: () => Promise<void> } };
    const conn = connect(`${host}:${port}`);
    return new CloudflareSocket(conn);
  }

  async close(): Promise<void> { /* nothing pooled */ }
}

class CloudflareSocket implements NetworkSocket {
  closed = false;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private pending: Uint8Array[] = [];

  constructor(private conn: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close: () => Promise<void> }) {
    this.reader = conn.readable.getReader();
    this.writer = conn.writable.getWriter();
  }

  async send(data: Uint8Array): Promise<number> {
    if (this.closed) throw new Error('socket closed');
    await this.writer.write(data);
    return data.length;
  }

  async recv(maxBytes: number): Promise<Uint8Array> {
    if (this.pending.length > 0) {
      const head = this.pending.shift()!;
      if (head.length <= maxBytes) return head;
      this.pending.unshift(head.subarray(maxBytes));
      return head.subarray(0, maxBytes);
    }
    if (this.closed) return new Uint8Array(0);
    const { value, done } = await this.reader.read();
    if (done || !value) {
      this.closed = true;
      return new Uint8Array(0);
    }
    if (value.length <= maxBytes) return value;
    this.pending.push(value.subarray(maxBytes));
    return value.subarray(0, maxBytes);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.writer.close(); } catch { /* ignore */ }
    try { await this.conn.close(); } catch { /* ignore */ }
  }
}

/* ─── Auto-pick the right transport for the host runtime ─────────────── */

/**
 * Convenience factory: returns a Node transport on Node/Bun/Deno, a CF
 * transport on Workers, or a WebSocket relay (requires `relayUrl`) in the
 * browser.
 */
export function autoTransport(opts: { relayUrl?: string } = {}): NetworkTransport {
  const r = detectRuntime();
  switch (r) {
    case 'node':
    case 'bun':
    case 'deno':
      return new NodeNetTransport();
    case 'cloudflare-workers':
      return new CloudflareSocketsTransport();
    case 'browser':
      if (!opts.relayUrl) {
        throw new Error(
          'autoTransport: browser networking requires `relayUrl` for the WebSocket relay.',
        );
      }
      return new WebSocketRelayTransport(opts.relayUrl);
    default:
      throw new Error(`autoTransport: cannot pick a transport for runtime "${r}"`);
  }
}
