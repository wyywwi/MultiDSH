#!/usr/bin/env node
// Local Node adapter for the Worker directory: serves the same fetch handler
// over node:http so the E2E script and the desktop app can point at it without
// a Cloudflare account. Storage is in-memory (MemoryKv) by design.
//
//   node packages/directory-worker/bin.js --port 8788

import http from 'node:http';

import { createDirectoryApp } from './src/app.js';
import { MemoryKv, Repository } from './src/storage.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    out[arg.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function toRequest(req, port) {
  const url = `http://127.0.0.1:${port}${req.url || '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    body: hasBody ? req : undefined,
    duplex: 'half',
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || 0);
  const kv = new MemoryKv();
  const repo = new Repository({ kv });
  const app = createDirectoryApp({ repo });

  const server = http.createServer(async (req, res) => {
    try {
      const response = await app.fetch(toRequest(req, server.address().port));
      const headers = {};
      for (const [key, value] of response.headers) headers[key] = value;
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, headers);
      res.end(body);
    } catch (err) {
      console.error('[multidsh-worker-directory] adapter error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal_error', message: 'adapter error' } }));
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`multidsh directory-worker listening on http://127.0.0.1:${server.address().port}`);
  console.log('storage: in-memory (MemoryKv) — start over for a clean state');

  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(`multidsh-worker-directory: ${err.message}`);
  process.exit(1);
});
