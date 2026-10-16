#!/usr/bin/env node

/**
 * linux.js — server example.
 *
 * Stores a small site in the guest kernel's filesystem and serves it with
 * a Node HTTP server: every request is answered by reading the file
 * through real kernel syscalls. (The guest has no userland, so there is
 * no in-guest httpd.)
 *
 *   node examples/server.mjs        # then open http://localhost:8080
 *
 * Prerequisites:
 *   node scripts/build-lkl.mjs
 *   npm run build
 */

import http from 'node:http';
import Linux from '../dist/index.js';

const PORT = Number(process.env.PORT ?? 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>linux.js</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px;
           margin: 80px auto; padding: 0 20px;
           background: #0a0a0a; color: #e0e0e0; line-height: 1.6; }
    h1 { color: #00d4aa; }
    .card { background: #1a1a1a; border: 1px solid #333;
            border-radius: 8px; padding: 16px 20px;
            font-family: monospace; font-size: 14px; }
    .prompt { color: #00d4aa; }
  </style>
</head>
<body>
  <h1>🐧 linux.js</h1>
  <p>Served by the real Linux kernel running inside WebAssembly.</p>
  <div class="card">
    <span class="prompt">/proc/version</span><br>
    <span>__KERNEL__</span>
  </div>
</body>
</html>
`;

async function main() {
  console.log('🐧 linux.js — server example\n');
  const linux = await Linux.create({ memory: 128 });
  const version = linux.getKernelVersion();
  console.log(`Kernel: ${version}\n`);

  await linux.writeFile('/var/www/index.html', HTML.replace('__KERNEL__', version));
  await linux.writeFile('/var/www/status.json', JSON.stringify({ kernel: version }));

  const server = http.createServer(async (req, res) => {
    // Map the URL onto /var/www, refusing anything that escapes it.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/index.html';
    if (rel.split('/').includes('..')) { res.writeHead(400).end('bad path'); return; }
    const path = `/var/www${rel}`;
    try {
      const st = await linux.stat(path);
      if (!st || st.isDirectory) { res.writeHead(404).end('not found'); return; }
      const body = await linux.readBinary(path);
      const ext = path.slice(path.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(body);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });

  server.listen(PORT, () => console.log(`🚀 Serving /var/www from the guest kernel on http://localhost:${PORT}`));

  const stop = async () => {
    server.close();
    await linux.shutdown();
    console.log('\n👋 Shut down cleanly.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
