// HTTP + WebSocket reverse proxy from the public sidecar port to the local dsh port.
// The Host header is preserved so dsh derives the correct cookie authority.
//
// It also fixes the one thing the DSH static server does not send: cache
// headers. `dsh-host-frontend-static` only writes `content-type`
// (lib/index.js:73), so without this every client that talks to the sidecar
// directly (127.0.0.1, LAN, anything bypassing Cloudflare) re-downloads and
// re-gzips the 1.7 MB shell on every open. Cloudflare masks this by adding
// `max-age=14400` at the edge, but the loopback path has no edge. Filenames
// under /assets/ are content-hashed by Vite, so they are immutable for real.

import http from 'node:http';
import net from 'node:net';

/** Vite's `name-<hash>.ext` files never change under the same URL. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MANIFEST_CACHE = 'public, max-age=300';
const HASHED_ASSET_RE =
  /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf)$/i;

/** Cache-Control the sidecar adds for a request path, or null to leave it. */
export function cacheControlFor(rawUrl) {
  const path = String(rawUrl || '').split('?')[0].split('#')[0];
  if (HASHED_ASSET_RE.test(path)) return IMMUTABLE;
  if (path === '/manifest.webmanifest' || path.endsWith('.webmanifest')) return MANIFEST_CACHE;
  return null;
}

/**
 * DSH's MIME table has no `.woff2` entry, so fonts go out as
 * `application/octet-stream` (and get pointless gzipped). Fix the header when
 * upstream did not know better.
 */
export function contentTypeFor(rawUrl) {
  const path = String(rawUrl || '').split('?')[0].split('#')[0];
  if (/\.woff2$/i.test(path)) return 'font/woff2';
  if (/\.woff$/i.test(path)) return 'font/woff';
  return null;
}

export function createProxy({ targetPort, targetHost = '127.0.0.1', log = () => {} }) {
  function handleRequest(req, res) {
    const headers = { ...req.headers, host: req.headers.host };
    const upstream = http.request(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        const outHeaders = { ...upstreamRes.headers };
        if (status >= 200 && status < 300) {
          const cacheControl = cacheControlFor(req.url);
          if (cacheControl) {
            outHeaders['cache-control'] = cacheControl;
            delete outHeaders.expires;
            delete outHeaders.pragma;
          }
          const contentType = contentTypeFor(req.url);
          const upstreamType = String(outHeaders['content-type'] || '');
          if (contentType && (!upstreamType || /octet-stream/i.test(upstreamType))) {
            outHeaders['content-type'] = contentType;
          }
        }
        res.writeHead(status, outHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      log(`proxy error ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      }
      res.end(JSON.stringify({ error: { code: 'dsh_unreachable', message: 'DSH is not reachable' } }));
    });
    req.pipe(upstream);
  }

  function handleUpgrade(req, socket, head) {
    const upstream = net.connect({ host: targetHost, port: targetPort }, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`);
        } else if (value !== undefined) {
          lines.push(`${key}: ${value}`);
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', (err) => {
      log(`proxy upgrade error ${req.url}: ${err.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  }

  return { handleRequest, handleUpgrade };
}
