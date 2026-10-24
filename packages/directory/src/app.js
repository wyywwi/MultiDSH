// MultiDSH Directory HTTP API (M0), implementing packages/protocol/PROTOCOL.md §3.
//
// `createApp({ dataPath, now })` returns `{ server, store }` where `server` is an
// `http.Server` that is NOT listening yet: tests can call `server.listen(0)`.
//
// Plain ESM, Node built-ins only. All responses are JSON (except health checks are
// JSON too) and always carry `Cache-Control: no-store`.

import http from 'node:http';

import {
  APP_NAME,
  PROTOCOL_VERSION,
  newId,
  normalizeBaseUrl,
  nowMs,
  sanitizeDevice,
  signNonce,
} from '../../protocol/index.js';
import { createStore } from './store.js';

/** JSON request bodies are capped at 1 MB. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Pairing nonce lifetime: `exp = now + 120s` (PROTOCOL.md §3). */
export const NONCE_TTL_MS = 120 * 1000;
/** A host whose last heartbeat is older than this is reported offline. */
export const ONLINE_WINDOW_MS = 90 * 1000;

/** Uniform API error, rendered as `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new ApiError(status, code, message);
}

function asClock(now) {
  if (typeof now === 'function') return now;
  if (typeof now === 'number' && Number.isFinite(now)) return () => now;
  return nowMs;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // Keep draining (no backpressure, no buffering) so the socket stays healthy,
      // but never hold more than the 1 MB limit in memory.
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new ApiError(413, 'payload_too_large', 'JSON body must not exceed 1 MB'));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => reject(err));
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(400, 'invalid_json', 'Request body must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(400, 'invalid_json', 'Request body must be a JSON object');
  }
  return parsed;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeUrlOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return normalizeBaseUrl(value);
}

function publicPool(pool) {
  return {
    id: pool.id,
    name: pool.name,
    createdAt: pool.createdAt,
    joinCode: pool.joinCode,
    joinCodeExpiresAt: pool.joinCodeExpiresAt,
    ownerDeviceId: pool.ownerDeviceId,
  };
}

function deviceFromRequest(req, store) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  if (!match) fail(401, 'unauthorized', 'Missing or invalid Authorization header');
  const device = store.getDeviceByToken(match[1]);
  if (!device) fail(401, 'unauthorized', 'Unknown or invalid device token');
  return device;
}

function poolOrThrow(store, poolId) {
  const pool = store.getPool(poolId);
  if (!pool) fail(404, 'pool_not_found', 'Pool not found');
  return pool;
}

/**
 * Ensure the authenticated device belongs to the pool and is in good standing.
 * Pending devices are rejected for normal member operations by default.
 */
function requireMember(device, poolId, { active = true } = {}) {
  if (device.poolId !== poolId) fail(403, 'forbidden', 'Device does not belong to this pool');
  if (device.status === 'revoked') fail(403, 'device_revoked', 'Device has been revoked');
  if (active && device.status !== 'active') fail(403, 'device_pending', 'Device is awaiting owner approval');
  return device;
}

function requireOwner(device) {
  if (device.role !== 'owner') fail(403, 'forbidden', 'Owner role required');
  return device;
}

function findDeviceInPool(store, poolId, deviceId) {
  const device = store.getDevice(deviceId);
  if (!device || device.poolId !== poolId) fail(404, 'device_not_found', 'Device not found in this pool');
  return device;
}

function findHost(store, poolId, hostId) {
  const host = store.getDevice(hostId);
  if (!host || host.poolId !== poolId || host.kind !== 'host') {
    fail(404, 'host_not_found', 'Host not found in this pool');
  }
  return host;
}

function isOnline(device, now) {
  return Number.isFinite(device.lastSeenAt) && now - device.lastSeenAt <= ONLINE_WINDOW_MS;
}

// -----------------------------------------------------------------------------
// Route handlers
// -----------------------------------------------------------------------------

function handleHealth(req, res, { clock }) {
  sendJson(res, 200, {
    ok: true,
    app: APP_NAME,
    protocol: PROTOCOL_VERSION,
    time: clock(),
  });
}

async function handleCreatePool(req, res, { store }) {
  const body = await readJson(req);
  const name = stringOr(body.name, 'pool');
  const deviceName = stringOr(body.deviceName, 'owner');
  const platform = stringOr(body.platform, process.platform);
  const version = stringOr(body.version, '0.1.0');

  const pool = store.createPool({ name });
  const { device, token } = store.addDevice({
    poolId: pool.id,
    kind: 'client',
    role: 'owner',
    name: deviceName,
    platform,
    version,
    status: 'active',
  });
  store.setPoolOwner(pool.id, device.id);
  await store.save();

  sendJson(res, 201, {
    pool: publicPool(pool),
    device: sanitizeDevice(device),
    deviceToken: token,
  });
}

async function handleJoin(req, res, { store }) {
  const body = await readJson(req);

  const kind = body.kind === undefined ? 'client' : body.kind;
  if (kind !== 'host' && kind !== 'client') {
    fail(400, 'invalid_request', 'kind must be "host" or "client"');
  }

  const pool = store.getPoolByJoinCode(body.code);
  if (!pool) fail(404, 'pool_code_invalid', 'Pool code is invalid');
  if (!store.isJoinCodeValid(pool)) fail(410, 'pool_code_expired', 'Pool code has expired');

  const { device, token } = store.addDevice({
    poolId: pool.id,
    kind,
    role: 'member',
    name: stringOr(body.name, kind === 'host' ? 'host' : 'client'),
    platform: stringOr(body.platform, process.platform),
    version: stringOr(body.version, null),
    status: 'pending',
    publicUrl: kind === 'host' ? normalizeUrlOrNull(body.publicUrl) : null,
    machineId: stringOr(body.machineId, null),
    machineName: stringOr(body.machineName, null),
    meta: body.meta,
  });
  await store.save();

  const response = {
    device: sanitizeDevice(device),
    deviceToken: token,
    pool: { id: pool.id, name: pool.name },
  };
  // Per protocol: pairSecret is only ever returned to host devices.
  if (kind === 'host') response.pairSecret = device.pairSecret;

  sendJson(res, 202, response);
}

function handleListDevices(req, res, { store }, poolId, url) {
  const device = deviceFromRequest(req, store);
  poolOrThrow(store, poolId);
  requireMember(device, poolId, { active: true });

  const includePending = url.searchParams.get('includePending') === '1';
  const showPending = includePending && device.role === 'owner';

  const devices = store
    .listDevices(poolId)
    .filter((entry) => {
      // Non-owners only ever see active devices; owners get pending ones on request.
      if (showPending) return entry.status !== 'revoked';
      return entry.status === 'active';
    })
    .map((entry) => sanitizeDevice(entry));

  sendJson(res, 200, { devices });
}

async function handleApprove(req, res, { store }, poolId, deviceId) {
  const owner = deviceFromRequest(req, store);
  poolOrThrow(store, poolId);
  requireMember(owner, poolId, { active: true });
  requireOwner(owner);

  const target = findDeviceInPool(store, poolId, deviceId);
  if (target.status === 'revoked') {
    fail(409, 'device_revoked', 'Cannot approve a revoked device');
  }
  if (target.status !== 'active') {
    store.updateDevice(target.id, { status: 'active', approvedAt: store.now() });
    await store.save();
  }
  sendJson(res, 200, { device: sanitizeDevice(target) });
}

async function handleRevoke(req, res, { store }, poolId, deviceId) {
  const owner = deviceFromRequest(req, store);
  poolOrThrow(store, poolId);
  requireMember(owner, poolId, { active: true });
  requireOwner(owner);

  const target = findDeviceInPool(store, poolId, deviceId);
  if (target.status !== 'revoked') {
    store.updateDevice(target.id, { status: 'revoked' });
    await store.save();
  }
  sendJson(res, 200, { device: sanitizeDevice(target) });
}

async function handleRotateJoinCode(req, res, { store }, poolId) {
  const owner = deviceFromRequest(req, store);
  poolOrThrow(store, poolId);
  requireMember(owner, poolId, { active: true });
  requireOwner(owner);

  const pool = store.rotateJoinCode(poolId);
  await store.save();
  sendJson(res, 200, {
    joinCode: pool.joinCode,
    joinCodeExpiresAt: pool.joinCodeExpiresAt,
  });
}

async function handleHeartbeat(req, res, { store, clock }) {
  const device = deviceFromRequest(req, store);
  if (device.status === 'revoked') fail(403, 'device_revoked', 'Device has been revoked');

  const body = await readJson(req);
  const patch = { lastSeenAt: clock() };
  if (typeof body.version === 'string') patch.version = body.version;
  const publicUrl = normalizeUrlOrNull(body.publicUrl);
  if (publicUrl) patch.publicUrl = publicUrl;
  const machineId = stringOr(body.machineId, null);
  if (machineId) patch.machineId = machineId;
  const machineName = stringOr(body.machineName, null);
  if (machineName) patch.machineName = machineName;
  if (body.health !== null && typeof body.health === 'object' && !Array.isArray(body.health)) {
    patch.health = body.health;
  }

  store.updateDevice(device.id, patch);
  await store.save();

  sendJson(res, 200, {
    ok: true,
    status: device.status,
    device: sanitizeDevice(device),
  });
}

async function handlePair(req, res, { store, clock }, poolId) {
  const client = deviceFromRequest(req, store);
  poolOrThrow(store, poolId);
  requireMember(client, poolId, { active: true });
  if (client.kind !== 'client') fail(403, 'forbidden', 'Only client devices can request a pairing URL');

  const body = await readJson(req);
  if (typeof body.hostId !== 'string' || !body.hostId) {
    fail(400, 'invalid_request', 'hostId is required');
  }

  const host = findHost(store, poolId, body.hostId);
  if (host.status !== 'active' || !host.pairSecret || !host.publicUrl) {
    fail(409, 'host_not_active', 'Host is not active or is missing pairing information');
  }

  const exp = clock() + NONCE_TTL_MS;
  const nonce = signNonce(host.pairSecret, {
    hostId: host.id,
    clientId: client.id,
    exp,
    jti: newId('jti'),
  });
  const url = `${normalizeBaseUrl(host.publicUrl)}/__fleet/pair?nonce=${encodeURIComponent(nonce)}`;

  sendJson(res, 200, { url, online: isOnline(host, clock()) });
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

async function handleRequest(req, res, ctx) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter(Boolean);
  const method = (req.method ?? 'GET').toUpperCase();
  const [root, area, poolId, third, fourth, fifth] = segments;

  if (root !== 'api') fail(404, 'not_found', `No route for ${method} ${url.pathname}`);

  // GET /api/health
  if (area === 'health' && segments.length === 2) {
    if (method !== 'GET') fail(405, 'method_not_allowed', 'Use GET');
    return handleHealth(req, res, ctx);
  }

  // POST /api/heartbeat
  if (area === 'heartbeat' && segments.length === 2) {
    if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
    return handleHeartbeat(req, res, ctx);
  }

  if (area === 'pools') {
    // POST /api/pools
    if (segments.length === 2) {
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      return handleCreatePool(req, res, ctx);
    }

    // POST /api/pools/join
    if (poolId === 'join' && segments.length === 3) {
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      return handleJoin(req, res, ctx);
    }

    // GET /api/pools/:poolId/devices
    if (segments.length === 4 && third === 'devices') {
      if (method !== 'GET') fail(405, 'method_not_allowed', 'Use GET');
      return handleListDevices(req, res, ctx, poolId, url);
    }

    // POST /api/pools/:poolId/pair
    if (segments.length === 4 && third === 'pair') {
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      return handlePair(req, res, ctx, poolId);
    }

    // POST /api/pools/:poolId/join-code/rotate
    if (segments.length === 5 && third === 'join-code' && fourth === 'rotate') {
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      return handleRotateJoinCode(req, res, ctx, poolId);
    }

    // POST /api/pools/:poolId/devices/:deviceId/(approve|revoke)
    if (segments.length === 6 && third === 'devices') {
      const deviceId = fourth;
      const action = fifth;
      if (action !== 'approve' && action !== 'revoke') {
        fail(404, 'not_found', `No route for ${method} ${url.pathname}`);
      }
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      if (action === 'approve') return handleApprove(req, res, ctx, poolId, deviceId);
      return handleRevoke(req, res, ctx, poolId, deviceId);
    }
  }

  fail(404, 'not_found', `No route for ${method} ${url.pathname}`);
}

/**
 * Build the Directory app.
 *
 * @param {object} [options]
 * @param {string|null} [options.dataPath] directory (or `*.json` file) for persisted state
 * @param {() => number|number} [options.now] clock, injectable for tests
 * @returns {{ server: import('node:http').Server, store: import('./store.js').Store }}
 */
export function createApp({ dataPath = null, now = nowMs } = {}) {
  const clock = asClock(now);
  const store = createStore({ dataPath, now: clock });

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { store, clock }).catch((err) => {
      if (res.writableEnded) {
        res.destroy();
        return;
      }
      if (err instanceof ApiError) {
        sendError(res, err.status, err.code, err.message);
      } else {
        console.error('[multidsh-directory] unhandled error:', err);
        sendError(res, 500, 'internal_error', 'Internal server error');
      }
    });
  });

  // Malformed HTTP from the client: answer simply, still with no-store.
  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n');
    }
  });

  return { server, store };
}
