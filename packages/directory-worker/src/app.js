// MultiDSH Directory API on Workers (M0 skeleton).
//
// Implements the same routes as packages/directory/src/app.js (PROTOCOL.md §3)
// but against Web-standard Request/Response and an async KV repository.
// `createDirectoryApp({ repo, now })` is framework-free so it can be tested
// under Node with `MemoryKv` and mounted in a Worker via src/index.js.

import {
  APP_NAME,
  PROTOCOL_VERSION,
  newId,
  normalizeBaseUrl,
  sanitizeDevice,
  signNonce,
} from './crypto.js';

export const MAX_BODY_BYTES = 1024 * 1024;
export const NONCE_TTL_MS = 120 * 1000;
export const ONLINE_WINDOW_MS = 90 * 1000;

const NO_STORE = 'no-store';

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

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': NO_STORE,
    },
  });
}

function sendError(status, code, message) {
  return json(status, { error: { code, message } });
}

function requestIp(request) {
  const connecting = request.headers.get('cf-connecting-ip');
  if (connecting) return connecting;
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

function constantTimeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function enforceRateLimit(limiter, key, message) {
  if (!limiter || typeof limiter.limit !== 'function') return;
  let result;
  try {
    result = await limiter.limit({ key });
  } catch (err) {
    // A rate-limiter outage must not take the whole Directory down. Log and
    // fail open; D1 remains the source of truth.
    console.error('[multidsh-worker-directory] rate limiter failed:', err);
    return;
  }
  if (!result || !result.success) fail(429, 'rate_limited', message);
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

function isOnline(device, now) {
  return Number.isFinite(device.lastSeenAt) && now - device.lastSeenAt <= ONLINE_WINDOW_MS;
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) {
    fail(413, 'payload_too_large', 'JSON body must not exceed 1 MB');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    fail(413, 'payload_too_large', 'JSON body must not exceed 1 MB');
  }
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

// ----------------------------------------------------------------------------
// Auth / membership helpers (same semantics as the Node directory)
// ----------------------------------------------------------------------------

async function deviceFromRequest(request, repo) {
  const header = request.headers.get('authorization');
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  if (!match) fail(401, 'unauthorized', 'Missing or invalid Authorization header');
  const device = await repo.getDeviceByToken(match[1]);
  if (!device) fail(401, 'unauthorized', 'Unknown or invalid device token');
  return device;
}

async function poolOrThrow(repo, poolId) {
  const pool = await repo.getPool(poolId);
  if (!pool) fail(404, 'pool_not_found', 'Pool not found');
  return pool;
}

function requireMember(device, poolId, { active = true } = {}) {
  if (device.poolId !== poolId) fail(403, 'forbidden', 'Device does not belong to this pool');
  if (device.status === 'revoked') fail(403, 'device_revoked', 'Device has been revoked');
  if (active && device.status !== 'active') {
    fail(403, 'device_pending', 'Device is awaiting owner approval');
  }
  return device;
}

function requireOwner(device) {
  if (device.role !== 'owner') fail(403, 'forbidden', 'Owner role required');
  return device;
}

async function findDeviceInPool(repo, poolId, deviceId) {
  const device = await repo.getDevice(deviceId);
  if (!device || device.poolId !== poolId) {
    fail(404, 'device_not_found', 'Device not found in this pool');
  }
  return device;
}

async function findHost(repo, poolId, hostId) {
  const host = await repo.withHeartbeat(await repo.getDevice(hostId));
  if (!host || host.poolId !== poolId || host.kind !== 'host') {
    fail(404, 'host_not_found', 'Host not found in this pool');
  }
  return host;
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

async function handleCreatePool(request, repo, clock, rateLimiters = {}, createPoolKey = '') {
  await enforceRateLimit(
    rateLimiters.createPool,
    `create:${requestIp(request)}`,
    'Too many pool creation attempts; try again in a minute',
  );
  if (createPoolKey) {
    const provided = request.headers.get('x-multidsh-create-key') || '';
    if (!constantTimeEqual(provided, createPoolKey)) {
      fail(403, 'create_key_invalid', 'A valid pool creation key is required');
    }
  }
  const body = await readJson(request);
  const name = stringOr(body.name, 'pool');
  const deviceName = stringOr(body.deviceName, 'owner');
  const platform = stringOr(body.platform, 'worker');
  const version = stringOr(body.version, '0.1.0');

  const pool = await repo.createPool({ name });
  const { device, token } = await repo.addDevice({
    poolId: pool.id,
    kind: 'client',
    role: 'owner',
    name: deviceName,
    platform,
    version,
    status: 'active',
  });
  await repo.setPoolOwner(pool.id, device.id);
  const ownedPool = await repo.getPool(pool.id);

  return json(201, {
    pool: publicPool(ownedPool || pool),
    device: sanitizeDevice(device),
    deviceToken: token,
  });
}

async function handleJoin(request, repo, rateLimiters = {}) {
  await enforceRateLimit(
    rateLimiters.join,
    `join:${requestIp(request)}`,
    'Too many join attempts; try again in a minute',
  );
  const body = await readJson(request);

  const kind = body.kind === undefined ? 'client' : body.kind;
  if (kind !== 'host' && kind !== 'client') {
    fail(400, 'invalid_request', 'kind must be "host" or "client"');
  }

  const pool = await repo.getPoolByJoinCode(body.code);
  if (!pool) fail(404, 'pool_code_invalid', 'Pool code is invalid');
  if (!repo.isJoinCodeValid(pool)) fail(410, 'pool_code_expired', 'Pool code has expired');

  const { device, token } = await repo.addDevice({
    poolId: pool.id,
    kind,
    role: 'member',
    name: stringOr(body.name, kind === 'host' ? 'host' : 'client'),
    platform: stringOr(body.platform, 'worker'),
    version: stringOr(body.version, null),
    status: 'pending',
    publicUrl: kind === 'host' ? normalizeUrlOrNull(body.publicUrl) : null,
    machineId: stringOr(body.machineId, null),
    machineName: stringOr(body.machineName, null),
    meta: body.meta,
  });

  const payload = {
    device: sanitizeDevice(device),
    deviceToken: token,
    pool: { id: pool.id, name: pool.name },
  };
  if (kind === 'host') payload.pairSecret = device.pairSecret;
  return json(202, payload);
}

async function handleListDevices(request, repo, poolId, url) {
  // The device token already identifies the pool; a separate pool lookup would
  // add one D1 query to the hottest polling path.
  const device = await deviceFromRequest(request, repo);
  requireMember(device, poolId, { active: true });

  const includePending = url.searchParams.get('includePending') === '1';
  const showPending = includePending && device.role === 'owner';

  const devices = (await repo.listDevices(poolId, { includePending: showPending })).map((entry) =>
    sanitizeDevice(entry),
  );

  return json(200, { devices });
}

async function handleApprove(request, repo, clock, poolId, deviceId) {
  const owner = await deviceFromRequest(request, repo);
  await poolOrThrow(repo, poolId);
  requireMember(owner, poolId, { active: true });
  requireOwner(owner);

  const target = await findDeviceInPool(repo, poolId, deviceId);
  if (target.status === 'revoked') fail(409, 'device_revoked', 'Cannot approve a revoked device');
  if (target.status !== 'active') {
    await repo.updateDevice(target.id, { status: 'active', approvedAt: clock() });
    Object.assign(target, { status: 'active', approvedAt: clock() });
  }
  return json(200, { device: sanitizeDevice(target) });
}

async function handleRevoke(request, repo, poolId, deviceId) {
  const owner = await deviceFromRequest(request, repo);
  await poolOrThrow(repo, poolId);
  requireMember(owner, poolId, { active: true });
  requireOwner(owner);

  const target = await findDeviceInPool(repo, poolId, deviceId);
  if (target.status !== 'revoked') {
    await repo.updateDevice(target.id, { status: 'revoked' });
    Object.assign(target, { status: 'revoked' });
  }
  return json(200, { device: sanitizeDevice(target) });
}

async function handleRotateJoinCode(request, repo, poolId) {
  const owner = await deviceFromRequest(request, repo);
  await poolOrThrow(repo, poolId);
  requireMember(owner, poolId, { active: true });
  requireOwner(owner);

  const pool = await repo.rotateJoinCode(poolId);
  return json(200, { joinCode: pool.joinCode, joinCodeExpiresAt: pool.joinCodeExpiresAt });
}

async function handleHeartbeat(request, repo, clock) {
  const device = await deviceFromRequest(request, repo);
  if (device.status === 'revoked') fail(403, 'device_revoked', 'Device has been revoked');

  const body = await readJson(request);
  const patch = { lastSeenAt: clock() };
  if (typeof body.version === 'string') patch.version = body.version;
  const publicUrl = normalizeUrlOrNull(body.publicUrl);
  if (publicUrl) patch.publicUrl = publicUrl;
  const machineId = stringOr(body.machineId, null);
  if (machineId) patch.machineId = machineId;
  const machineName = stringOr(body.machineName, null);
  if (machineName) patch.machineName = machineName;
  const displayName = stringOr(body.name, null);
  if (displayName && displayName !== device.name) {
    // Rename is rare; only write the devices row when it actually changed.
    await repo.updateDevice(device.id, { name: displayName });
    device.name = displayName;
  }
  if (body.health !== null && typeof body.health === 'object' && !Array.isArray(body.health)) {
    patch.health = body.health;
  }

  // Liveness lives in a separate `hb:<deviceId>` key so a heartbeat can never
  // clobber an owner's approve/revoke (KV has no transactions).
  await repo.recordHeartbeat(device.id, patch);
  // The token lookup already returned the device. Reusing it here avoids a
  // second device read plus a liveness read on every 30s heartbeat.
  const updated = { ...device, ...patch };
  return json(200, { ok: true, status: updated.status, device: sanitizeDevice(updated) });
}

async function handlePair(request, repo, clock, poolId) {
  // Parse the body first, then run the three independent D1 reads in parallel.
  // allSettled keeps the original error precedence: auth -> pool -> membership
  // -> host lookup, while saving up to two serial D1 round trips on the hot
  // path (pair is latency-sensitive and called on every client open).
  const body = await readJson(request);
  const hostId = typeof body.hostId === 'string' && body.hostId ? body.hostId : null;
  const [clientResult, poolResult, hostResult] = await Promise.allSettled([
    deviceFromRequest(request, repo),
    poolOrThrow(repo, poolId),
    hostId ? findHost(repo, poolId, hostId) : Promise.resolve(null),
  ]);
  if (clientResult.status === 'rejected') throw clientResult.reason;
  const client = clientResult.value;
  if (poolResult.status === 'rejected') throw poolResult.reason;
  requireMember(client, poolId, { active: true });
  if (client.kind !== 'client') {
    fail(403, 'forbidden', 'Only client devices can request a pairing URL');
  }
  if (!hostId) {
    fail(400, 'invalid_request', 'hostId is required');
  }
  if (hostResult.status === 'rejected') throw hostResult.reason;
  const host = hostResult.value;

  if (host.status !== 'active' || !host.pairSecret || !host.publicUrl) {
    fail(409, 'host_not_active', 'Host is not active or is missing pairing information');
  }

  const exp = clock() + NONCE_TTL_MS;
  const nonce = await signNonce(host.pairSecret, {
    hostId: host.id,
    clientId: client.id,
    exp,
    jti: newId('jti'),
  });
  const url = `${normalizeBaseUrl(host.publicUrl)}/__fleet/pair?nonce=${encodeURIComponent(nonce)}`;
  return json(200, { url, online: isOnline(host, clock()) });
}

async function handleHealth(clock) {
  return json(200, { ok: true, app: APP_NAME, protocol: PROTOCOL_VERSION, time: clock() });
}

// ----------------------------------------------------------------------------
// Router
// ----------------------------------------------------------------------------

async function route(request, repo, clock, rateLimiters = {}, createPoolKey = '') {
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const method = request.method.toUpperCase();
  const [root, area, poolId, third, fourth, fifth] = segments;

  if (root !== 'api') fail(404, 'not_found', `No route for ${method} ${url.pathname}`);

  if (area === 'health' && segments.length === 2) {
    if (method !== 'GET') fail(405, 'method_not_allowed', 'Use GET');
    return handleHealth(clock);
  }

  if (area === 'heartbeat' && segments.length === 2) {
    if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
    return handleHeartbeat(request, repo, clock);
  }

  if (area === 'pools') {
    if (segments.length === 2) {
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      return handleCreatePool(request, repo, clock, rateLimiters, createPoolKey);
    }

    if (poolId === 'join' && segments.length === 3) {
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      return handleJoin(request, repo, rateLimiters);
    }

    if (segments.length === 4 && third === 'devices') {
      if (method !== 'GET') fail(405, 'method_not_allowed', 'Use GET');
      return handleListDevices(request, repo, poolId, url);
    }

    if (segments.length === 4 && third === 'pair') {
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      return handlePair(request, repo, clock, poolId);
    }

    if (segments.length === 5 && third === 'join-code' && fourth === 'rotate') {
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      return handleRotateJoinCode(request, repo, poolId);
    }

    if (segments.length === 6 && third === 'devices') {
      const deviceId = fourth;
      const action = fifth;
      if (action !== 'approve' && action !== 'revoke') {
        fail(404, 'not_found', `No route for ${method} ${url.pathname}`);
      }
      if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST');
      if (action === 'approve') return handleApprove(request, repo, clock, poolId, deviceId);
      return handleRevoke(request, repo, poolId, deviceId);
    }
  }

  fail(404, 'not_found', `No route for ${method} ${url.pathname}`);
}

/**
 * Build the Worker directory app.
 *
 * @param {object} options
 * @param {{getPool:Function, getPoolByJoinCode:Function, isJoinCodeValid:Function,
 *          createPool:Function, setPoolOwner:Function, rotateJoinCode:Function,
 *          addDevice:Function, getDevice:Function, getDeviceByToken:Function,
 *          updateDevice:Function, listDevices:Function}} options.repo
 * @param {() => number} [options.now]
 */
export function createDirectoryApp({ repo, now = () => Date.now(), rateLimiters = {}, createPoolKey = '' }) {
  const clock = now;
  async function fetchHandler(request) {
    try {
      return await route(request, repo, clock, rateLimiters, createPoolKey);
    } catch (err) {
      if (err instanceof ApiError) return sendError(err.status, err.code, err.message);
      console.error('[multidsh-worker-directory] unhandled error:', err);
      return sendError(500, 'internal_error', 'Internal server error');
    }
  }
  return { fetch: fetchHandler, repo };
}
