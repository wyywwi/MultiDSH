// MultiDSH Directory M0 test suite (node:test, no dependencies).
//
// Run from the `multidsh/` directory:
//   .\bin\node.cmd --test packages\directory\test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { hashToken, verifyNonce } from '../../protocol/index.js';

const HOST_PUBLIC_URL = 'http://127.0.0.1:4092';
const CODE_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'multidsh-directory-'));
}

/** Start an app on an ephemeral port and return `{ server, store, base, dataPath, stop }`. */
async function startApp({ dataPath = makeTempDir(), now } = {}) {
  const app = createApp(now === undefined ? { dataPath } : { dataPath, now });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      app.server.removeListener('error', reject);
      resolve();
    });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let stopped = false;
  async function stop({ keepData = false } = {}) {
    if (!stopped) {
      stopped = true;
      await new Promise((resolve) => app.server.close(resolve));
      await app.store.flush();
    }
    if (!keepData) rmSync(dataPath, { recursive: true, force: true });
  }
  return { ...app, base, dataPath, stop };
}

/** Minimal JSON HTTP client. */
async function api(ctx, path, { method = 'GET', token, body, rawBody, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token !== undefined) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (rawBody !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = rawBody;
  }
  const res = await fetch(ctx.base + path, init);
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, text, json };
}

function assertError(result, status, code) {
  assert.equal(result.status, status, `expected HTTP ${status}, got ${result.status}: ${result.text}`);
  assert.equal(result.json?.error?.code, code, `unexpected error payload: ${result.text}`);
  assert.equal(typeof result.json?.error?.message, 'string');
  assert.equal(result.headers.get('cache-control'), 'no-store');
}

async function createPool(ctx, overrides = {}) {
  const res = await api(ctx, '/api/pools', {
    method: 'POST',
    body: { name: 'home', deviceName: 'user-win', platform: 'win32', ...overrides },
  });
  assert.equal(res.status, 201, res.text);
  return { pool: res.json.pool, device: res.json.device, token: res.json.deviceToken };
}

async function joinPool(ctx, pool, overrides = {}) {
  return api(ctx, '/api/pools/join', {
    method: 'POST',
    body: {
      code: pool.joinCode,
      kind: 'host',
      name: 'win-01',
      platform: 'win32',
      version: '0.1.0',
      publicUrl: HOST_PUBLIC_URL,
      machineId: 'machine_test_box',
      machineName: 'test-box',
      ...overrides,
    },
  });
}

async function joinHost(ctx, pool, overrides = {}) {
  const res = await joinPool(ctx, pool, overrides);
  assert.equal(res.status, 202, res.text);
  return { device: res.json.device, token: res.json.deviceToken, pairSecret: res.json.pairSecret };
}

async function approve(ctx, poolId, ownerToken, deviceId) {
  const res = await api(ctx, `/api/pools/${poolId}/devices/${deviceId}/approve`, {
    method: 'POST',
    token: ownerToken,
  });
  assert.equal(res.status, 200, res.text);
  return res.json.device;
}

async function heartbeat(ctx, token, body = {}) {
  return api(ctx, '/api/heartbeat', { method: 'POST', token, body });
}

function nonceFromUrl(url) {
  return new URL(url).searchParams.get('nonce');
}

// ---------------------------------------------------------------------------
// Health & routing basics
// ---------------------------------------------------------------------------

test('GET /api/health reports protocol info and never caches', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  assert.equal(ctx.server.listening, true); // startApp listens; createApp alone does not
  assert.equal(createApp({ dataPath: null }).server.listening, false);

  const res = await api(ctx, '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.app, 'MultiDSH');
  assert.equal(res.json.protocol, 1);
  assert.equal(typeof res.json.time, 'number');
});

test('unknown routes, wrong methods and malformed bodies use the standard error shape', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());

  assertError(await api(ctx, '/api/nope'), 404, 'not_found');
  assertError(await api(ctx, '/api/pools'), 405, 'method_not_allowed');
  assertError(await api(ctx, '/api/pools', { method: 'POST', rawBody: '{ not json' }), 400, 'invalid_json');
  assertError(await api(ctx, '/api/pools', { method: 'POST', rawBody: '[1,2,3]' }), 400, 'invalid_json');

  const huge = `{"name":"${'x'.repeat(1024 * 1024 + 64)}"}`;
  assertError(await api(ctx, '/api/pools', { method: 'POST', rawBody: huge }), 413, 'payload_too_large');
});

// ---------------------------------------------------------------------------
// Pools / owner
// ---------------------------------------------------------------------------

test('POST /api/pools creates a pool owned by an active client device', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());

  const { pool, device, token } = await createPool(ctx);
  assert.match(pool.id, /^pool_[0-9a-f]{12}$/);
  assert.equal(pool.name, 'home');
  assert.match(pool.joinCode, CODE_RE);
  assert.equal(pool.joinCodeExpiresAt - pool.createdAt, 24 * 60 * 60 * 1000);
  assert.equal(pool.ownerDeviceId, device.id);

  assert.match(device.id, /^dev_[0-9a-f]{12}$/);
  assert.equal(device.poolId, pool.id);
  assert.equal(device.kind, 'client');
  assert.equal(device.role, 'owner');
  assert.equal(device.name, 'user-win');
  assert.equal(device.platform, 'win32');
  assert.equal(device.status, 'active');
  assert.equal(device.approvedAt, device.createdAt);
  assert.equal(device.lastSeenAt, device.createdAt);
  assert.equal('tokenHash' in device, false);
  assert.equal('pairSecret' in device, false);

  assert.match(token, /^mdt_/);

  const list = await api(ctx, `/api/pools/${pool.id}/devices`, { token });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(list.json.devices.map((d) => d.id), [device.id]);
  assert.equal('tokenHash' in list.json.devices[0], false);
});

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

test('POST /api/pools/join creates a pending host, normalizes the code, and only returns pairSecret for hosts', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  const { pool } = await createPool(ctx);

  // Lowercase + dashed code must still resolve (normalizeJoinCode).
  const messyCode = `${pool.joinCode.slice(0, 4)}-${pool.joinCode.slice(4)}`.toLowerCase();
  const hostRes = await joinPool(ctx, pool, { code: messyCode });
  assert.equal(hostRes.status, 202, hostRes.text);
  assert.equal(hostRes.json.pool.name, 'home');
  assert.match(hostRes.headers.get('cache-control'), /no-store/);
  const hostDevice = hostRes.json.device;
  assert.equal(hostDevice.status, 'pending');
  assert.equal(hostDevice.role, 'member');
  assert.equal(hostDevice.kind, 'host');
  assert.equal(hostDevice.poolId, pool.id);
  assert.equal(hostDevice.name, 'win-01');
  assert.equal(hostDevice.platform, 'win32');
  assert.equal(hostDevice.version, '0.1.0');
  assert.equal(hostDevice.publicUrl, HOST_PUBLIC_URL);
  assert.equal(hostDevice.machineId, 'machine_test_box');
  assert.equal(hostDevice.machineName, 'test-box');
  assert.equal(hostDevice.approvedAt, null);
  assert.equal(hostDevice.lastSeenAt, null);
  assert.equal('pairSecret' in hostDevice, false);
  assert.match(hostRes.json.pairSecret, /^mps_/);
  assert.match(hostRes.json.deviceToken, /^mdt_/);

  const clientRes = await joinPool(ctx, pool, { code: messyCode, kind: 'client', name: 'mac' });
  assert.equal(clientRes.status, 202, clientRes.text);
  assert.equal(clientRes.json.pool.name, 'home');
  assert.equal(clientRes.json.device.kind, 'client');
  assert.equal('pairSecret' in clientRes.json, false);
});

test('join rejects unknown, malformed and expired pool codes', async (t) => {
  const clock = { time: 1_700_000_000_000 };
  const ctx = await startApp({ now: () => clock.time });
  t.after(() => ctx.stop());
  const { pool } = await createPool(ctx);

  assertError(await joinPool(ctx, pool, { code: 'ZZZZZZZZ' }), 404, 'pool_code_invalid');
  assertError(await joinPool(ctx, pool, { code: '' }), 404, 'pool_code_invalid');
  assertError(await joinPool(ctx, pool, { code: undefined }), 404, 'pool_code_invalid');
  assertError(await joinPool(ctx, pool, { kind: 'tablet' }), 400, 'invalid_request');

  // Fresh code still works.
  assert.equal((await joinPool(ctx, pool)).status, 202);

  // Jump to exactly 24h after creation: the code expires (strictly greater check).
  clock.time = pool.joinCodeExpiresAt;
  assertError(await joinPool(ctx, pool), 410, 'pool_code_expired');
});

// ---------------------------------------------------------------------------
// Device visibility & approval
// ---------------------------------------------------------------------------

test('pending devices stay invisible to non-owners, especially with includePending', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  const { pool, device: owner, token: ownerToken } = await createPool(ctx);
  const host1 = await joinHost(ctx, pool);
  const host2 = await joinHost(ctx, pool, { name: 'win-02' });

  const ownerDefault = await api(ctx, `/api/pools/${pool.id}/devices`, { token: ownerToken });
  assert.deepEqual(ownerDefault.json.devices.map((d) => d.id), [owner.id]);

  const ownerAll = await api(ctx, `/api/pools/${pool.id}/devices?includePending=1`, { token: ownerToken });
  assert.deepEqual(
    ownerAll.json.devices.map((d) => d.id).sort(),
    [owner.id, host1.device.id, host2.device.id].sort(),
  );

  await approve(ctx, pool.id, ownerToken, host1.device.id);

  // Active non-owner sees only active devices, even when asking for pending ones.
  const memberAll = await api(ctx, `/api/pools/${pool.id}/devices?includePending=1`, { token: host1.token });
  assert.deepEqual(memberAll.json.devices.map((d) => d.id).sort(), [owner.id, host1.device.id].sort());

  // A pending device cannot even list devices.
  assertError(await api(ctx, `/api/pools/${pool.id}/devices`, { token: host2.token }), 403, 'device_pending');
});

test('approve flips pending -> active and is owner-only', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  const { pool, token: ownerToken } = await createPool(ctx);
  const host = await joinHost(ctx, pool);
  const other = await joinHost(ctx, pool, { name: 'win-02' });

  // A pending device cannot approve anything.
  assertError(
    await api(ctx, `/api/pools/${pool.id}/devices/${other.device.id}/approve`, {
      method: 'POST',
      token: host.token,
    }),
    403,
    'device_pending',
  );

  const approved = await approve(ctx, pool.id, ownerToken, host.device.id);
  assert.equal(approved.status, 'active');
  assert.equal(typeof approved.approvedAt, 'number');
  assert.equal(approved.id, host.device.id);

  // Idempotent.
  const again = await approve(ctx, pool.id, ownerToken, host.device.id);
  assert.equal(again.status, 'active');

  // Active non-owner still cannot approve.
  assertError(
    await api(ctx, `/api/pools/${pool.id}/devices/${other.device.id}/approve`, {
      method: 'POST',
      token: host.token,
    }),
    403,
    'forbidden',
  );

  // Unknown device id.
  assertError(
    await api(ctx, `/api/pools/${pool.id}/devices/dev_000000000000/approve`, {
      method: 'POST',
      token: ownerToken,
    }),
    404,
    'device_not_found',
  );

  const list = await api(ctx, `/api/pools/${pool.id}/devices`, { token: ownerToken });
  assert.deepEqual(list.json.devices.map((d) => d.id).sort(), [host.device.id, pool.ownerDeviceId].sort());
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

test('heartbeat refreshes lastSeenAt/status for active and pending devices', async (t) => {
  const clock = { time: 1_700_000_000_000 };
  const ctx = await startApp({ now: () => clock.time });
  t.after(() => ctx.stop());
  const { pool, device: owner, token: ownerToken } = await createPool(ctx);
  const host = await joinHost(ctx, pool);
  await approve(ctx, pool.id, ownerToken, host.device.id);

  clock.time += 5_000;
  const beat = await heartbeat(ctx, host.token, {
    version: '0.2.0',
    publicUrl: `${HOST_PUBLIC_URL}/`,
    machineId: 'machine_test_box',
    machineName: 'test-box-renamed',
    health: { runningSessions: 2, dshPort: 3080 },
  });
  assert.equal(beat.status, 200, beat.text);
  assert.equal(beat.json.ok, true);
  assert.equal(beat.json.status, 'active');
  assert.equal(beat.json.device.id, host.device.id);
  assert.equal(beat.json.device.lastSeenAt, clock.time);
  assert.equal(beat.json.device.version, '0.2.0');
  assert.equal(beat.json.device.publicUrl, HOST_PUBLIC_URL, 'trailing slash is normalized');
  assert.equal(beat.json.device.machineName, 'test-box-renamed');
  assert.deepEqual(beat.json.device.health, { runningSessions: 2, dshPort: 3080 });
  assert.equal('pairSecret' in beat.json.device, false);

  // Pending devices may heartbeat; their status stays pending.
  const pending = await joinPool(ctx, pool, { kind: 'client', name: 'pending-client' });
  assert.equal(pending.status, 202);
  const pendingBeat = await heartbeat(ctx, pending.json.deviceToken, {});
  assert.equal(pendingBeat.status, 200);
  assert.equal(pendingBeat.json.status, 'pending');

  // Unknown token.
  assertError(await heartbeat(ctx, 'mdt_not_a_real_token'), 401, 'unauthorized');
  assertError(await api(ctx, '/api/heartbeat', { method: 'POST', body: {} }), 401, 'unauthorized');

  // Owner heartbeat keeps it active.
  clock.time += 1_000;
  const ownerBeat = await heartbeat(ctx, ownerToken, {});
  assert.equal(ownerBeat.status, 200);
  assert.equal(ownerBeat.json.device.lastSeenAt, clock.time);
  assert.equal(ownerBeat.json.device.id, owner.id);
});

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

test('revoke marks a device revoked; revoked devices get 403 on heartbeat', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  const { pool, token: ownerToken } = await createPool(ctx);
  const host = await joinHost(ctx, pool);
  await approve(ctx, pool.id, ownerToken, host.device.id);

  // Non-owner cannot revoke.
  assertError(
    await api(ctx, `/api/pools/${pool.id}/devices/${host.device.id}/revoke`, {
      method: 'POST',
      token: host.token,
    }),
    403,
    'forbidden',
  );

  const revoked = await api(ctx, `/api/pools/${pool.id}/devices/${host.device.id}/revoke`, {
    method: 'POST',
    token: ownerToken,
  });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.json.device.status, 'revoked');

  assertError(await heartbeat(ctx, host.token), 403, 'device_revoked');
  assertError(await api(ctx, `/api/pools/${pool.id}/devices`, { token: host.token }), 403, 'device_revoked');

  // Revoking again is idempotent; unknown target is 404.
  const again = await api(ctx, `/api/pools/${pool.id}/devices/${host.device.id}/revoke`, {
    method: 'POST',
    token: ownerToken,
  });
  assert.equal(again.status, 200);
  assertError(
    await api(ctx, `/api/pools/${pool.id}/devices/dev_000000000000/revoke`, {
      method: 'POST',
      token: ownerToken,
    }),
    404,
    'device_not_found',
  );

  // A revoked device cannot be approved back to life.
  assertError(
    await api(ctx, `/api/pools/${pool.id}/devices/${host.device.id}/approve`, {
      method: 'POST',
      token: ownerToken,
    }),
    409,
    'device_revoked',
  );

  // Revoked devices disappear from the owner's device list.
  const list = await api(ctx, `/api/pools/${pool.id}/devices?includePending=1`, { token: ownerToken });
  assert.equal(list.json.devices.some((d) => d.id === host.device.id), false);
});

// ---------------------------------------------------------------------------
// Pair
// ---------------------------------------------------------------------------

test('pair signs a verifiable nonce with the host pairSecret and reports online state', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  const { pool, device: owner, token: ownerToken } = await createPool(ctx);
  const host = await joinHost(ctx, pool);

  // Pending host cannot be paired yet.
  assertError(
    await api(ctx, `/api/pools/${pool.id}/pair`, { method: 'POST', token: ownerToken, body: { hostId: host.device.id } }),
    409,
    'host_not_active',
  );

  await approve(ctx, pool.id, ownerToken, host.device.id);

  const pairBeforeHeartbeat = await api(ctx, `/api/pools/${pool.id}/pair`, {
    method: 'POST',
    token: ownerToken,
    body: { hostId: host.device.id },
  });
  assert.equal(pairBeforeHeartbeat.status, 200, pairBeforeHeartbeat.text);
  assert.equal(pairBeforeHeartbeat.json.online, false);
  assert.match(pairBeforeHeartbeat.json.url, new RegExp(`^${HOST_PUBLIC_URL}/__fleet/pair\\?nonce=`));

  const nonce = nonceFromUrl(pairBeforeHeartbeat.json.url);
  const payload = verifyNonce(host.pairSecret, nonce, { hostId: host.device.id });
  assert.equal(payload.hostId, host.device.id);
  assert.equal(payload.clientId, owner.id);
  assert.equal(payload.v, 1);
  assert.match(payload.jti, /^jti_[0-9a-f]{12}$/);
  const ttl = payload.exp - Date.now();
  assert.ok(ttl > 0 && ttl <= 120_000, `exp should be ~120s ahead, got ${ttl}`);
  // A nonce signed for this host must not verify for another host.
  assert.throws(() => verifyNonce('mps_wrong_secret', nonce, { hostId: host.device.id }));

  await heartbeat(ctx, host.token, {});
  const pairOnline = await api(ctx, `/api/pools/${pool.id}/pair`, {
    method: 'POST',
    token: ownerToken,
    body: { hostId: host.device.id },
  });
  assert.equal(pairOnline.status, 200, pairOnline.text);
  assert.equal(pairOnline.json.online, true);
  verifyNonce(host.pairSecret, nonceFromUrl(pairOnline.json.url), { hostId: host.device.id });
});

test('pair rejects bad hosts and unauthorized clients', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  const { pool, token: ownerToken } = await createPool(ctx);
  const host = await joinHost(ctx, pool);
  await approve(ctx, pool.id, ownerToken, host.device.id);

  // Missing hostId.
  assertError(
    await api(ctx, `/api/pools/${pool.id}/pair`, { method: 'POST', token: ownerToken, body: {} }),
    400,
    'invalid_request',
  );
  // Unknown host.
  assertError(
    await api(ctx, `/api/pools/${pool.id}/pair`, {
      method: 'POST',
      token: ownerToken,
      body: { hostId: 'dev_000000000000' },
    }),
    404,
    'host_not_found',
  );
  // Host without publicUrl/pairSecret readiness cannot be paired.
  const noUrl = await joinHost(ctx, pool, { name: 'win-nourl', publicUrl: undefined });
  assert.equal(noUrl.device.publicUrl, null);
  await approve(ctx, pool.id, ownerToken, noUrl.device.id);
  assertError(
    await api(ctx, `/api/pools/${pool.id}/pair`, {
      method: 'POST',
      token: ownerToken,
      body: { hostId: noUrl.device.id },
    }),
    409,
    'host_not_active',
  );

  // Revoked host cannot be paired.
  await api(ctx, `/api/pools/${pool.id}/devices/${host.device.id}/revoke`, {
    method: 'POST',
    token: ownerToken,
  });
  assertError(
    await api(ctx, `/api/pools/${pool.id}/pair`, {
      method: 'POST',
      token: ownerToken,
      body: { hostId: host.device.id },
    }),
    409,
    'host_not_active',
  );

  // Pending client cannot pair; active host (wrong kind) cannot pair.
  const pendingClient = await joinPool(ctx, pool, { kind: 'client', name: 'mac' });
  assertError(
    await api(ctx, `/api/pools/${pool.id}/pair`, {
      method: 'POST',
      token: pendingClient.json.deviceToken,
      body: { hostId: host.device.id },
    }),
    403,
    'device_pending',
  );
  const secondHost = await joinHost(ctx, pool, { name: 'win-02' });
  await approve(ctx, pool.id, ownerToken, secondHost.device.id);
  assertError(
    await api(ctx, `/api/pools/${pool.id}/pair`, {
      method: 'POST',
      token: secondHost.token,
      body: { hostId: host.device.id },
    }),
    403,
    'forbidden',
  );

  // Revoked client cannot pair either.
  await api(ctx, `/api/pools/${pool.id}/devices/${pendingClient.json.device.id}/approve`, {
    method: 'POST',
    token: ownerToken,
  });
  await api(ctx, `/api/pools/${pool.id}/devices/${pendingClient.json.device.id}/revoke`, {
    method: 'POST',
    token: ownerToken,
  });
  assertError(
    await api(ctx, `/api/pools/${pool.id}/pair`, {
      method: 'POST',
      token: pendingClient.json.deviceToken,
      body: { hostId: secondHost.device.id },
    }),
    403,
    'device_revoked',
  );
});

test('a host from another pool cannot be paired into this pool', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  const first = await createPool(ctx, { name: 'home' });
  const second = await createPool(ctx, { name: 'office' });
  const foreignHost = await joinHost(ctx, second.pool);

  // The client is not a member of the second pool.
  assertError(
    await api(ctx, `/api/pools/${second.pool.id}/pair`, {
      method: 'POST',
      token: first.token,
      body: { hostId: foreignHost.device.id },
    }),
    403,
    'forbidden',
  );
  // The first pool owner naming a device from the second pool sees 404.
  assertError(
    await api(ctx, `/api/pools/${first.pool.id}/pair`, {
      method: 'POST',
      token: first.token,
      body: { hostId: foreignHost.device.id },
    }),
    404,
    'host_not_found',
  );
});

// ---------------------------------------------------------------------------
// Join code rotation
// ---------------------------------------------------------------------------

test('rotate join code invalidates the previous code', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  const { pool, token: ownerToken } = await createPool(ctx);
  const oldCode = pool.joinCode;

  const rotated = await api(ctx, `/api/pools/${pool.id}/join-code/rotate`, {
    method: 'POST',
    token: ownerToken,
  });
  assert.equal(rotated.status, 200, rotated.text);
  assert.match(rotated.json.joinCode, CODE_RE);
  assert.notEqual(rotated.json.joinCode, oldCode);
  assert.equal(typeof rotated.json.joinCodeExpiresAt, 'number');

  assertError(await joinPool(ctx, pool, { code: oldCode }), 404, 'pool_code_invalid');
  assert.equal((await joinPool(ctx, pool, { code: rotated.json.joinCode })).status, 202);
});

// ---------------------------------------------------------------------------
// Cross-pool access & auth
// ---------------------------------------------------------------------------

test('bearer auth: unknown tokens are 401 and cross-pool access is 403/404', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.stop());
  const first = await createPool(ctx, { name: 'home' });
  const second = await createPool(ctx, { name: 'office' });

  assertError(await api(ctx, `/api/pools/${first.pool.id}/devices`), 401, 'unauthorized');
  assertError(await api(ctx, `/api/pools/${first.pool.id}/devices`, { token: 'mdt_bogus' }), 401, 'unauthorized');
  assertError(await api(ctx, `/api/pools/${first.pool.id}/devices`, { token: '' }), 401, 'unauthorized');

  // Token from the other pool.
  assertError(await api(ctx, `/api/pools/${first.pool.id}/devices`, { token: second.token }), 403, 'forbidden');
  assertError(
    await api(ctx, `/api/pools/${second.pool.id}/devices/${first.device.id}/approve`, {
      method: 'POST',
      token: second.token,
    }),
    404,
    'device_not_found',
  );
  // Unknown pool.
  assertError(await api(ctx, '/api/pools/pool_000000000000/devices', { token: first.token }), 404, 'pool_not_found');
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('state persists across restarts and never stores device token plaintext', async () => {
  const dataPath = makeTempDir();
  let ctx = null;
  let reopened = null;
  try {
    ctx = await startApp({ dataPath });
    const { pool, token: ownerToken } = await createPool(ctx);
    const host = await joinHost(ctx, pool);
    await approve(ctx, pool.id, ownerToken, host.device.id);
    await heartbeat(ctx, host.token, { version: '0.1.0' });

    const created = { pool, host, ownerToken };
    await ctx.stop({ keepData: true });
    ctx = null;

    const stateFile = join(dataPath, 'directory.json');
    assert.ok(existsSync(stateFile), 'state file should exist after saving');
    const raw = readFileSync(stateFile, 'utf8');
    const state = JSON.parse(raw);
    assert.equal(state.pools[created.pool.id].name, 'home');
    assert.equal(state.devices[created.host.device.id].tokenHash, hashToken(created.host.token));
    assert.equal(raw.includes(created.host.token), false, 'device token plaintext must not be stored');
    assert.equal(raw.includes(created.ownerToken), false);
    assert.deepEqual(
      readdirSync(dataPath).filter((name) => name.includes('.tmp')),
      [],
      'no temporary files should be left behind',
    );

    reopened = await startApp({ dataPath });
    // Token hashes survived, so auth still works.
    const ownerBeat = await heartbeat(reopened, created.ownerToken, {});
    assert.equal(ownerBeat.status, 200, ownerBeat.text);
    assert.equal(ownerBeat.json.status, 'active');
    const hostBeat = await heartbeat(reopened, created.host.token, {});
    assert.equal(hostBeat.status, 200, hostBeat.text);
    assert.equal(hostBeat.json.status, 'active');

    // The join code survived too, and the pairSecret still signs valid nonces.
    const joined = await joinHost(reopened, created.pool, { name: 'win-03' });
    assert.equal(joined.device.status, 'pending');
    const pairRes = await api(reopened, `/api/pools/${created.pool.id}/pair`, {
      method: 'POST',
      token: created.ownerToken,
      body: { hostId: created.host.device.id },
    });
    assert.equal(pairRes.status, 200, pairRes.text);
    assert.equal(pairRes.json.online, true);
    verifyNonce(created.host.pairSecret, nonceFromUrl(pairRes.json.url), {
      hostId: created.host.device.id,
    });
  } finally {
    await reopened?.stop();
    await ctx?.stop();
    rmSync(dataPath, { recursive: true, force: true });
  }
});

test('store: atomic JSON writes and sha256(token) device lookup', async () => {
  const dir = makeTempDir();
  try {
    const store = createStore({ dataPath: dir });
    const pool = store.createPool({ name: 'home' });
    const { device, token } = store.addDevice({
      poolId: pool.id,
      kind: 'host',
      name: 'win-01',
      status: 'pending',
      publicUrl: HOST_PUBLIC_URL,
    });
    store.setPoolOwner(pool.id, device.id);
    await store.save();

    const stateFile = join(dir, 'directory.json');
    assert.ok(existsSync(stateFile));
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.pools[pool.id].joinCode, pool.joinCode);
    assert.equal(state.devices[device.id].tokenHash, hashToken(token));
    assert.equal(state.devices[device.id].pairSecret, device.pairSecret); // M0: plaintext pairSecret
    assert.equal(store.getDeviceByToken(token).id, device.id);
    assert.equal(store.getDeviceByToken('mdt_nope'), null);
    assert.equal(store.getPoolByJoinCode(pool.joinCode.toLowerCase()).id, pool.id);

    const reloaded = createStore({ dataPath: dir });
    assert.equal(reloaded.getDeviceByToken(token).id, device.id);
    assert.equal(reloaded.getPool(pool.id).ownerDeviceId, device.id);

    const oldCode = pool.joinCode;
    const rotated = reloaded.rotateJoinCode(pool.id);
    await reloaded.save();
    assert.notEqual(rotated.joinCode, oldCode);
    assert.equal(reloaded.getPoolByJoinCode(oldCode), null);
    assert.equal(reloaded.getPoolByJoinCode(rotated.joinCode).id, pool.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
