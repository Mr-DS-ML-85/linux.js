#!/usr/bin/env node

/**
 * linux.js — minimal WebSocket-to-TCP relay (reference implementation).
 *
 * Pairs with the `WebSocketRelayTransport` in `src/transport.ts`. Lets a
 * browser-hosted linux.js instance open arbitrary outbound TCP connections
 * through a server you control.
 *
 * Usage:
 *   node scripts/relay.mjs --port 8787 --bind 0.0.0.0
 *
 * Wire format (binary frames only):
 *   First client frame: JSON `{ host, port }`
 *   First server reply: JSON `{ ok: true }` or `{ error: string }`
 *   Subsequent frames:  raw bytes, both directions
 *
 * Operational notes:
 *   - Add an allowlist (env `RELAY_ALLOWED_HOSTS` = comma-separated) so the
 *     relay isn't an open egress proxy.
 *   - Run behind TLS (Caddy, Cloudflare, etc.) for production deployments.
 *
 * License: MIT.
 */

import { createServer } from 'node:net';
import { createConnection } from 'node:net';
import { WebSocketServer } from 'ws';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    port:  { type: 'string', short: 'p', default: '8787' },
    bind:  { type: 'string', short: 'b', default: '0.0.0.0' },
    quiet: { type: 'boolean', default: false },
  },
});

const PORT = Number.parseInt(opts.port, 10);
const ALLOWED = (process.env.RELAY_ALLOWED_HOSTS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function log(...args) { if (!opts.quiet) console.log('[relay]', ...args); }

const wss = new WebSocketServer({ host: opts.bind, port: PORT });
log(`listening ws://${opts.bind}:${PORT}`);

if (ALLOWED.length > 0) log('allowlist:', ALLOWED.join(', '));
else log('no allowlist set — accepting any outbound host (dev mode)');

wss.on('connection', (ws, req) => {
  const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  log('client connected:', peer);
  let target = null;

  ws.once('message', (raw) => {
    let header;
    try {
      header = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ ok: false, error: 'malformed handshake' }));
      ws.close();
      return;
    }
    const { host, port } = header;
    if (typeof host !== 'string' || typeof port !== 'number') {
      ws.send(JSON.stringify({ ok: false, error: 'host/port required' }));
      ws.close();
      return;
    }
    if (ALLOWED.length > 0 && !ALLOWED.includes(host)) {
      ws.send(JSON.stringify({ ok: false, error: `host '${host}' not allowed` }));
      ws.close();
      return;
    }

    log(`-> ${host}:${port}  (from ${peer})`);
    target = createConnection({ host, port }, () => {
      ws.send(JSON.stringify({ ok: true }));
    });

    target.on('data', (chunk) => {
      try { ws.send(chunk); } catch { /* ignore */ }
    });
    target.on('error', (err) => {
      try { ws.send(JSON.stringify({ ok: false, error: err.message })); } catch {}
      try { ws.close(); } catch {}
    });
    target.on('close', () => {
      try { ws.close(); } catch {}
    });

    ws.on('message', (chunk) => {
      if (!target.destroyed) target.write(chunk);
    });
  });

  ws.on('close', () => {
    log('client disconnected:', peer);
    if (target && !target.destroyed) target.destroy();
  });
});

process.on('SIGINT', () => { log('shutting down'); wss.close(); process.exit(0); });
