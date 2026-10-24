// Worker directory tests, run under Node against MemoryKv.
//
// These exercise the exact fetch handler deployed to Cloudflare (src/app.js)
// and cross-check the HMAC nonce format with the Node protocol helpers used by
// the host sidecar (packages/protocol/index.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyNonce } from '../../protocol/index.js';
import { createDirectoryApp } from '../src/app.js';
import { MemoryKv, Repository } from '../src/storage.js';

function makeApp({ now } = {}) {
  const kv = new MemoryKv();
  let clock = now ?? Date.now();
  const repo = new Repository({ kv, now: () => clock });
  const app = createDirectoryApp({ repo, now: () => clock });
  return {
    app,
    kv,
    repo,
    tick(ms) {
      clock += ms;
    },
    setClock(value) {
      clock = value;
    },
    get clock() {
      return clock;
    },
  };
}

async function call(app, method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`http://directory.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await app.fetch(request);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function bootstrapHost(app) {
  const created = await call(app, 'POST', '/api/pools', {
    body: { name: 'home', deviceName: 'desktop', platform: 'win32' },
  });
  assert.equal(created.status, 201);
  const ownerToken = created.body.deviceToken;

  const joined = await call(app, 'POST', '/api/pools/join', {
    body: {
      code: created.body.pool.joinCode,
      kind: 'host',
      name: 'win-01',
      platform: 'win32',
      publicUrl: 'http://127.0.0.1:4092',
      machineId: 'machine_worker_box',
      machineName: 'worker-box',
    },
  });
  assert.equal(joined.status, 202);
  assert.equal(joined.body.device.status, 'pending');
  assert.ok(joined.body.pairSecret.startsWith('mps_'));

  return {
    pool: created.body.pool,
    ownerToken,
    ownerDevice: created.body.device,
    hostToken: joined.body.deviceToken,
    host: joined.body.device,
    pairSecret: joined.body.pairSecret,
  };
}

test('health never caches and reports protocol info', async () => {
  const { app } = makeApp();
  const res = await call(app, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.app, 'MultiDSH');
  assert.equal(res.body.protocol, 1);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('create pool, join as pending host, approve, heartbeat, pair nonce', async () => {
  const { app } = makeApp();
  const { pool, ownerToken, hostToken, host, pairSecret } = await bootstrapHost(app);

  // Pending host cannot list devices yet.
  const forbidden = await call(app, 'GET', `/api/pools/${pool.id}/devices`, { token: hostToken });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'device_pending');

  // Owner sees the pending host only with includePending=1.
  const activeOnly = await call(app, 'GET', `/api/pools/${pool.id}/devices`, { token: ownerToken });
  assert.equal(activeOnly.status, 200);
  assert.equal(activeOnly.body.devices.length, 1);
  assert.equal(activeOnly.body.devices[0].role, 'owner');

  const withPending = await call(app, 'GET', `/api/pools/${pool.id}/devices?includePending=1`, {
    token: ownerToken,
  });
  assert.equal(withPending.body.devices.length, 2);
  const pendingHost = withPending.body.devices.find((d) => d.id === host.id);
  assert.equal(pendingHost.status, 'pending');
  assert.equal(pendingHost.machineId, 'machine_worker_box');
  assert.equal(pendingHost.machineName, 'worker-box');
  assert.equal(pendingHost.tokenHash, undefined, 'never leak token hash');
  assert.equal(pendingHost.pairSecret, undefined, 'never leak pair secret');

  // Approve.
  const approved = await call(app, 'POST', `/api/pools/${pool.id}/devices/${host.id}/approve`, {
    token: ownerToken,
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.device.status, 'active');

  // Heartbeat updates lastSeenAt and is visible as online.
  const heartbeat = await call(app, 'POST', '/api/heartbeat', {
    token: hostToken,
    body: {
      version: '0.1.0',
      machineId: 'machine_worker_box',
      machineName: 'worker-box-renamed',
      health: { dshRunning: true },
    },
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.status, 'active');

  const devices = await call(app, 'GET', `/api/pools/${pool.id}/devices`, { token: ownerToken });
  const onlineHost = devices.body.devices.find((d) => d.id === host.id);
  assert.equal(onlineHost.status, 'active');
  assert.equal(onlineHost.machineName, 'worker-box-renamed');
  assert.ok(Number.isFinite(onlineHost.lastSeenAt));

  // Pairing: the returned nonce must verify with the Node protocol helpers.
  const pair = await call(app, 'POST', `/api/pools/${pool.id}/pair`, {
    token: ownerToken,
    body: { hostId: host.id },
  });
  assert.equal(pair.status, 200);
  assert.equal(pair.body.online, true);
  const nonce = new URL(pair.body.url).searchParams.get('nonce');
  assert.ok(nonce, 'pair url contains a nonce');
  const payload = verifyNonce(pairSecret, nonce, { hostId: host.id });
  assert.equal(payload.hostId, host.id);
  assert.ok(payload.clientId.startsWith('dev_'));

  // Hosts cannot request pairing URLs.
  const hostPair = await call(app, 'POST', `/api/pools/${pool.id}/pair`, {
    token: hostToken,
    body: { hostId: host.id },
  });
  assert.equal(hostPair.status, 403);
});

test('heartbeat never rewrites the device record (approval cannot be reverted)', async () => {
  const { app, repo } = makeApp();
  const { pool, ownerToken, hostToken, host } = await bootstrapHost(app);

  // Real sequence on a host that starts before the owner approves: heartbeat
  // arrives while pending, then the owner approves, then heartbeats resume.
  const pendingBeat = await call(app, 'POST', '/api/heartbeat', { token: hostToken, body: {} });
  assert.equal(pendingBeat.status, 200);
  assert.equal(pendingBeat.body.status, 'pending');

  const approved = await call(app, 'POST', `/api/pools/${pool.id}/devices/${host.id}/approve`, {
    token: ownerToken,
  });
  assert.equal(approved.body.device.status, 'active');

  const activeBeat = await call(app, 'POST', '/api/heartbeat', {
    token: hostToken,
    body: { version: '0.1.0', health: { dshRunning: true } },
  });
  assert.equal(activeBeat.body.status, 'active');

  // The durable device record kept the approved status; only hb:<id> changed.
  const raw = await repo.getDevice(host.id);
  assert.equal(raw.status, 'active');
  assert.ok(Number.isFinite((await repo._getJson(`hb:${host.id}`)).lastSeenAt));

  const list = await call(app, 'GET', `/api/pools/${pool.id}/devices`, { token: ownerToken });
  const listed = list.body.devices.find((d) => d.id === host.id);
  assert.equal(listed.status, 'active');
  assert.ok(Number.isFinite(listed.lastSeenAt));
  assert.equal(listed.health.dshRunning, true);
});

test('join code expiry, rotation, and revocation', async () => {
  const { app, tick } = makeApp();
  const { pool, ownerToken, hostToken, host } = await bootstrapHost(app);

  // Expire the code by moving the clock > 24h.
  tick(25 * 60 * 60 * 1000);
  const expired = await call(app, 'POST', '/api/pools/join', {
    body: { code: pool.joinCode, kind: 'client', name: 'late-client' },
  });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error.code, 'pool_code_expired');

  // Rotate gives a fresh code and invalidates the old one.
  const rotated = await call(app, 'POST', `/api/pools/${pool.id}/join-code/rotate`, { token: ownerToken });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.joinCode, pool.joinCode);

  const oldCode = await call(app, 'POST', '/api/pools/join', {
    body: { code: pool.joinCode, kind: 'client', name: 'x' },
  });
  assert.equal(oldCode.status, 404);

  // Revoke: heartbeat gets 403 and pair refuses the host.
  const revoked = await call(app, 'POST', `/api/pools/${pool.id}/devices/${host.id}/revoke`, {
    token: ownerToken,
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.device.status, 'revoked');

  const heartbeat = await call(app, 'POST', '/api/heartbeat', { token: hostToken, body: {} });
  assert.equal(heartbeat.status, 403);
  assert.equal(heartbeat.body.error.code, 'device_revoked');

  const pair = await call(app, 'POST', `/api/pools/${pool.id}/pair`, {
    token: ownerToken,
    body: { hostId: host.id },
  });
  assert.equal(pair.status, 409);
  assert.equal(pair.body.error.code, 'host_not_active');
});

test('state survives a fresh app instance on the same KV (no process memory)', async () => {
  const kv = new MemoryKv();
  const repo = new Repository({ kv, now: () => 1_700_000_000_000 });
  const first = createDirectoryApp({ repo });
  const created = await call(first, 'POST', '/api/pools', {
    body: { name: 'shared', deviceName: 'owner', platform: 'android' },
  });
  assert.equal(created.status, 201);

  // New Repository + app, same KV namespace: device token lookup must still work.
  const second = createDirectoryApp({ repo: new Repository({ kv, now: () => 1_700_000_000_000 }) });
  const devices = await call(second, 'GET', `/api/pools/${created.body.pool.id}/devices`, {
    token: created.body.deviceToken,
  });
  assert.equal(devices.status, 200);
  assert.equal(devices.body.devices.length, 1);
});

test('auth and routing errors use the standard shape', async () => {
  const { app } = makeApp();
  const noAuth = await call(app, 'GET', '/api/pools/pool_x/devices');
  assert.equal(noAuth.status, 401);

  const unknownToken = await call(app, 'GET', '/api/pools/pool_x/devices', { token: 'mdt_nope' });
  assert.equal(unknownToken.status, 401);

  const unknownRoute = await call(app, 'GET', '/api/nope');
  assert.equal(unknownRoute.status, 404);
  assert.equal(unknownRoute.body.error.code, 'not_found');

  const wrongMethod = await call(app, 'GET', '/api/heartbeat');
  assert.equal(wrongMethod.status, 405);
});

test('oversized bodies are rejected with 413', async () => {
  const { app } = makeApp();
  const huge = 'x'.repeat(1024 * 1024 + 16);
  const request = new Request('http://directory.test/api/pools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: huge }),
  });
  const response = await app.fetch(request);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, 'payload_too_large');
});

test('pool creation can be rejected by a rate limiter', async () => {
  const kv = new MemoryKv();
  const repo = new Repository({ kv });
  const app = createDirectoryApp({
    repo,
    rateLimiters: {
      createPool: { limit: async () => ({ success: false }) },
    },
  });
  const created = await call(app, 'POST', '/api/pools', {
    body: { name: 'blocked', deviceName: 'bot', platform: 'test' },
  });
  assert.equal(created.status, 429);
  assert.equal(created.body.error.code, 'rate_limited');
});

test('pool creation requires the configured key', async () => {
  const kv = new MemoryKv();
  const repo = new Repository({ kv });
  const app = createDirectoryApp({ repo, createPoolKey: 'correct-horse' });
  const request = (headers) =>
    new Request('http://directory.test/api/pools', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'keyed', deviceName: 'owner', platform: 'test' }),
    });

  const missing = await app.fetch(request({}));
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).error.code, 'create_key_invalid');

  const wrong = await app.fetch(request({ 'x-multidsh-create-key': 'wrong' }));
  assert.equal(wrong.status, 403);

  const allowed = await app.fetch(request({ 'x-multidsh-create-key': 'correct-horse' }));
  assert.equal(allowed.status, 201);
});
