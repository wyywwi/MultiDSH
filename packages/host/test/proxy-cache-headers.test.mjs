// The host sidecar proxy injects the cache headers DSH's static server omits.
// These tests pin the exact behaviour (what gets rewritten, what is left alone).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createProxy, cacheControlFor, contentTypeFor } from '../src/proxy.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

function startUpstream() {
  const server = http.createServer((req, res) => {
    const path = String(req.url || '').split('?')[0];
    const headers = {
      'content-type': /\.woff2?$/i.test(path) ? 'application/octet-stream' : 'text/javascript',
    };
    if (path === '/') {
      headers['content-type'] = 'text/html; charset=utf-8';
      headers['cache-control'] = 'no-store';
    }
    res.writeHead(200, headers);
    res.end('ok');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startProxy(targetPort) {
  const proxy = createProxy({ targetPort });
  const server = http.createServer(proxy.handleRequest);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
  });
}

test('cacheControlFor only rewrites content-hashed assets and the manifest', () => {
  assert.equal(cacheControlFor('/assets/index-CN7NIWNw.js'), IMMUTABLE);
  assert.equal(cacheControlFor('/assets/index-BxpfOGf3.css?v=2'), IMMUTABLE);
  assert.equal(cacheControlFor('/manifest.webmanifest'), 'public, max-age=300');
  assert.equal(cacheControlFor('/assets/app.js'), null, 'non-hashed file must keep upstream headers');
  assert.equal(cacheControlFor('/assets/nested/index-12345678.js'), null, 'only flat asset names');
  assert.equal(cacheControlFor('/'), null);
  assert.equal(cacheControlFor('/plugins/??a/client.js'), null);
  assert.equal(cacheControlFor(undefined), null);
});

test('contentTypeFor repairs the missing woff2 MIME entry', () => {
  assert.equal(contentTypeFor('/assets/inter-latin-1234abcd.woff2'), 'font/woff2');
  assert.equal(contentTypeFor('/assets/inter-latin-1234abcd.woff'), 'font/woff');
  assert.equal(contentTypeFor('/assets/index-CN7NIWNw.js'), null);
});

test('proxy forwards the page headers but makes hashed assets immutable', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.address().port);
  const port = proxy.address().port;
  try {
    const page = await request(port, '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store', 'HTML must stay uncached');

    const asset = await request(port, '/assets/index-CN7NIWNw.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['cache-control'], IMMUTABLE);
    assert.equal(asset.body, 'ok');

    const font = await request(port, '/assets/inter-latin-1234abcd.woff2');
    assert.equal(font.headers['content-type'], 'font/woff2', 'octet-stream must be repaired');
    assert.equal(font.headers['cache-control'], IMMUTABLE);

    const manifest = await request(port, '/manifest.webmanifest');
    assert.equal(manifest.headers['cache-control'], 'public, max-age=300');

    const plain = await request(port, '/assets/app.js');
    assert.equal(plain.headers['cache-control'], undefined, 'unknown names must not be cached for a year');
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
