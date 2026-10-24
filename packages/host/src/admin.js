// Sidecar admin endpoints + reverse proxy entry point.
//
// Public port layout (the Cloudflare Tunnel points at this server):
//   /__fleet/health      sidecar health
//   /__fleet/pair        one-time nonce -> 303 /?token=<dsh token>
//   /__fleet/events      SSE placeholder
//   everything else      proxied to the local dsh web port (Host preserved)

import http from 'node:http';
import { ADMIN_PREFIX, verifyNonce } from '../../protocol/index.js';

const NO_STORE = 'no-store';

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': NO_STORE,
  });
  res.end(JSON.stringify(body));
}

export function createAdminServer({ config, supervisor, heartbeat, proxy, log = () => {} }) {
  const consumed = new Map(); // jti -> exp

  function sweep() {
    const now = Date.now();
    for (const [jti, exp] of consumed) {
      if (exp < now) consumed.delete(jti);
    }
  }

  async function handleAdmin(req, res, url) {
    if (req.method === 'GET' && url.pathname === `${ADMIN_PREFIX}/health`) {
      return sendJson(res, 200, {
        ok: true,
        deviceId: config.deviceId,
        poolId: config.poolId,
        name: config.name,
        status: config.status,
        publicUrl: config.publicUrl,
        dsh: supervisor.getState(),
        directory: {
          url: config.directoryUrl,
          lastHeartbeatAt: heartbeat?.getState().lastHeartbeatAt ?? null,
          lastError: heartbeat?.getState().lastError ?? null,
          status: heartbeat?.getState().status ?? config.status,
        },
      });
    }

    if (req.method === 'GET' && url.pathname === `${ADMIN_PREFIX}/pair`) {
      const nonce = url.searchParams.get('nonce');
      if (!nonce) return sendJson(res, 400, { error: { code: 'pair_invalid', message: 'missing nonce' } });
      let payload;
      try {
        payload = verifyNonce(config.pairSecret, nonce, { hostId: config.deviceId });
      } catch (err) {
        const expired = /expired/i.test(err.message);
        return sendJson(res, expired ? 410 : 400, {
          error: { code: expired ? 'pair_expired' : 'pair_invalid', message: err.message },
        });
      }
      if (consumed.has(payload.jti)) {
        return sendJson(res, 400, { error: { code: 'pair_replayed', message: 'nonce already used' } });
      }
      consumed.set(payload.jti, payload.exp);
      sweep();
      if (!supervisor.token) {
        return sendJson(res, 503, { error: { code: 'dsh_starting', message: 'DSH is still starting' } });
      }
      log(`pair accepted for client ${payload.clientId}`);
      res.writeHead(303, {
        location: `/?token=${encodeURIComponent(supervisor.token)}`,
        'cache-control': NO_STORE,
        'referrer-policy': 'no-referrer',
      });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === `${ADMIN_PREFIX}/events`) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': NO_STORE,
        connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ deviceId: config.deviceId, status: config.status })}\n\n`);
      const timer = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 15_000);
      req.on('close', () => clearInterval(timer));
      return undefined;
    }

    return sendJson(res, 404, { error: { code: 'not_found', message: 'unknown admin route' } });
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return sendJson(res, 400, { error: { code: 'bad_request', message: 'bad url' } });
    }
    if (url.pathname === ADMIN_PREFIX || url.pathname.startsWith(`${ADMIN_PREFIX}/`)) {
      handleAdmin(req, res, url).catch((err) => {
        log(`admin error: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: err.message } });
        else res.end();
      });
      return undefined;
    }
    return proxy.handleRequest(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    const path = String(req.url || '').split('?')[0];
    if (path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`)) {
      socket.destroy();
      return;
    }
    proxy.handleUpgrade(req, socket, head);
  });

  return { server, consumed };
}
