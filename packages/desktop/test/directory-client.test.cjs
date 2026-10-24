'use strict';

/**
 * Directory client tests against an in-memory mock that follows
 * multidsh/packages/protocol/PROTOCOL.md (section 3).
 *
 * Run: node --test test/   (or the bundled node.exe directly)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  DirectoryClient,
  DirectoryError,
  errorForRenderer,
  isOnline,
  normalizeBaseUrl,
  normalizeJoinCode,
} = require('../src/directory-client');

// ---------------------------------------------------------------------------
// Mock Directory
// ---------------------------------------------------------------------------

function createMockDirectory() {
  let seq = 0;
  const pools = new Map();
  const poolByCode = new Map();
  const tokens = new Map();

  const newId = (prefix) => `${prefix}_${(++seq).toString(16).padStart(12, '0')}`;
  const sendJson = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };
  const sendError = (res, status, code, message) =>
    sendJson(res, status, { error: { code, message } });

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const auth = (req) => {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return null;
    const entry = tokens.get(header.slice('Bearer '.length));
    if (!entry) return null;
    const pool = pools.get(entry.poolId);
    if (!pool) return null;
    return { pool, device: pool.devices.get(entry.deviceId) };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean); // e.g. api, pools, pool_x, devices
    const method = req.method || 'GET';

    if (method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, app: 'MultiDSH', protocol: 1, time: Date.now() });
    }

    if (method === 'POST' && url.pathname === '/api/pools') {
      const body = await readBody(req);
      const pool = {
        id: newId('pool'),
        name: String(body.name || ''),
        joinCode: '7K3M9Q2X',
        joinCodeExpiresAt: Date.now() + 24 * 3600 * 1000,
        ownerDeviceId: null,
        devices: new Map(),
      };
      const device = {
        id: newId('dev'),
        poolId: pool.id,
        kind: 'client',
        role: 'owner',
        name: String(body.deviceName || 'owner'),
        platform: String(body.platform || 'win32'),
        version: '0.1.0',
        status: 'active',
        createdAt: Date.now(),
        approvedAt: Date.now(),
        lastSeenAt: null,
        publicUrl: undefined,
        health: {},
        meta: {},
      };
      const token = `mdt_owner_${seq}`;
      pool.ownerDeviceId = device.id;
      pool.devices.set(device.id, device);
      pools.set(pool.id, pool);
      poolByCode.set(pool.joinCode, pool);
      tokens.set(token, { poolId: pool.id, deviceId: device.id });
      return sendJson(res, 201, { pool, device, deviceToken: token });
    }

    if (method === 'POST' && url.pathname === '/api/pools/join') {
      const body = await readBody(req);
      const code = normalizeJoinCode(body.code);
      const pool = poolByCode.get(code);
      if (!pool) return sendError(res, 404, 'pool_code_invalid', 'invalid pool code');
      const device = {
        id: newId('dev'),
        poolId: pool.id,
        kind: body.kind === 'host' ? 'host' : 'client',
        role: 'member',
        name: String(body.name || 'member'),
        platform: String(body.platform || 'win32'),
        version: String(body.version || '0.1.0'),
        status: 'pending',
        createdAt: Date.now(),
        approvedAt: null,
        lastSeenAt: null,
        publicUrl: body.publicUrl,
        health: {},
        meta: {},
      };
      const token = `mdt_member_${seq}`;
      pool.devices.set(device.id, device);
      tokens.set(token, { poolId: pool.id, deviceId: device.id });
      const response = { device, deviceToken: token };
      if (device.kind === 'host') response.pairSecret = `mps_secret_${seq}`;
      return sendJson(res, 202, response);
    }

    // /api/pools/:poolId/devices... / pair / devices/:deviceId/approve|revoke
    if (parts[0] === 'api' && parts[1] === 'pools' && parts[2]) {
      const pool = pools.get(parts[2]);
      if (!pool) return sendError(res, 404, 'pool_not_found', 'pool not found');
      const session = auth(req);
      if (!session || session.pool.id !== pool.id) {
        return sendError(res, 401, 'unauthorized', 'missing or invalid device token');
      }
      // Protocol: only active members may read devices or pair.
      if (session.device.status !== 'active') {
        return sendError(res, 403, 'device_pending', 'device is not active');
      }

      if (method === 'GET' && parts[3] === 'devices') {
        const includePending = url.searchParams.get('includePending') === '1';
        const isOwner = session.device.role === 'owner';
        const devices = Array.from(pool.devices.values()).filter((device) => {
          if (device.status === 'active') return true;
          if (includePending && isOwner && device.status === 'pending') return true;
          return false;
        });
        return sendJson(res, 200, { devices });
      }

      if (method === 'POST' && parts[3] === 'devices' && parts[5] === 'approve') {
        if (session.device.role !== 'owner') return sendError(res, 403, 'forbidden', 'owner only');
        const device = pool.devices.get(parts[4]);
        if (!device) return sendError(res, 404, 'device_not_found', 'device not found');
        device.status = 'active';
        device.approvedAt = Date.now();
        return sendJson(res, 200, { device });
      }

      if (method === 'POST' && parts[3] === 'devices' && parts[5] === 'revoke') {
        if (session.device.role !== 'owner') return sendError(res, 403, 'forbidden', 'owner only');
        const device = pool.devices.get(parts[4]);
        if (!device) return sendError(res, 404, 'device_not_found', 'device not found');
        device.status = 'revoked';
        return sendJson(res, 200, { device });
      }

      if (method === 'POST' && parts[3] === 'pair') {
        if (session.device.status !== 'active') {
          return sendError(res, 403, 'device_pending', 'device is not active');
        }
        const body = await readBody(req);
        const host = pool.devices.get(String(body.hostId || ''));
        if (!host) return sendError(res, 404, 'host_not_found', 'host not found');
        if (host.status !== 'active') return sendError(res, 409, 'host_not_active', 'host not active');
        return sendJson(res, 200, {
          url: `http://127.0.0.1:4092/__fleet/pair?nonce=mock.${host.id}`,
          online: isOnline(host),
        });
      }
    }

    if (method === 'POST' && url.pathname === '/api/heartbeat') {
      const session = auth(req);
      if (!session) return sendError(res, 401, 'unauthorized', 'missing or invalid device token');
      session.device.lastSeenAt = Date.now();
      return sendJson(res, 200, { ok: true, status: session.device.status, device: session.device });
    }

    return sendError(res, 404, 'not_found', 'not found');
  });

  return {
    pools,
    tokens,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve(`http://127.0.0.1:${server.address().port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('normalizeBaseUrl removes trailing slashes and rejects bad schemes', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(normalizeBaseUrl(' https://fleet.example.com/base/ '), 'https://fleet.example.com/base');
  assert.throws(() => normalizeBaseUrl(''), (err) => err.code === 'invalid_url');
  assert.throws(() => normalizeBaseUrl('ftp://example.com'), (err) => err.code === 'invalid_url');
  assert.throws(() => normalizeBaseUrl('not a url'), (err) => err.code === 'invalid_url');
});

test('normalizeJoinCode forgives Crockford typo characters', () => {
  assert.equal(normalizeJoinCode(' 7k3m-9q2x '), '7K3M9Q2X');
  assert.equal(normalizeJoinCode('I L O U'), '110V');
});

test('isOnline requires active status and a heartbeat within 90s', () => {
  const now = Date.now();
  assert.equal(isOnline({ status: 'active', lastSeenAt: now - 1000 }, now), true);
  assert.equal(isOnline({ status: 'active', lastSeenAt: now - 90 * 1000 }, now), true);
  assert.equal(isOnline({ status: 'active', lastSeenAt: now - 91 * 1000 }, now), false);
  assert.equal(isOnline({ status: 'pending', lastSeenAt: now }, now), false);
  assert.equal(isOnline({ status: 'active', lastSeenAt: null }, now), false);
  assert.equal(isOnline(null, now), false);
});

test('network failures map to a friendly network error', async () => {
  const client = new DirectoryClient('http://127.0.0.1:1');
  await assert.rejects(
    client.health(),
    (err) =>
      err instanceof DirectoryError &&
      (err.code === 'network' || err.code === 'timeout') &&
      errorForRenderer(err).code === err.code,
  );
});

// ---------------------------------------------------------------------------
// Protocol flow
// ---------------------------------------------------------------------------

let mock;
let baseUrl;
let client;

before(async () => {
  mock = createMockDirectory();
  baseUrl = await mock.listen();
  client = new DirectoryClient(baseUrl);
});

after(async () => {
  await mock.close();
});

test('create pool, join pending host, approve, list and pair', async () => {
  const created = await client.createPool({
    name: 'home',
    deviceName: 'desktop-test',
    platform: 'win32',
  });
  assert.equal(created.pool.name, 'home');
  assert.equal(created.device.role, 'owner');
  assert.equal(created.device.status, 'active');
  assert.ok(created.deviceToken.startsWith('mdt_'));
  assert.equal(created.pool.joinCode, '7K3M9Q2X');

  const { id: poolId, joinCode } = created.pool;
  const ownerToken = created.deviceToken;

  const initial = await client.listDevices(poolId, ownerToken);
  assert.equal(initial.devices.length, 1);

  const joined = await client.joinPool({
    code: joinCode,
    name: 'win-01',
    platform: 'win32',
    kind: 'host',
    version: '0.1.0',
  });
  assert.equal(joined.device.status, 'pending');
  assert.equal(joined.device.kind, 'host');
  assert.ok(joined.deviceToken.startsWith('mdt_'));
  assert.ok(joined.pairSecret.startsWith('mps_'));

  // A pending device cannot read the device list yet.
  await assert.rejects(
    client.listDevices(poolId, joined.deviceToken),
    (err) => err instanceof DirectoryError && err.status === 403,
  );

  // The owner sees pending devices with includePending=1.
  const withPending = await client.listDevices(poolId, ownerToken, { includePending: true });
  assert.ok(withPending.devices.some((d) => d.id === joined.device.id && d.status === 'pending'));

  // Approve the host, then it becomes visible and can list devices.
  const approved = await client.approveDevice(poolId, ownerToken, joined.device.id);
  assert.equal(approved.device.status, 'active');
  const afterApprove = await client.listDevices(poolId, ownerToken);
  assert.equal(afterApprove.devices.length, 2);
  const hostList = await client.listDevices(poolId, joined.deviceToken);
  assert.equal(hostList.devices.length, 2);

  // Pair returns a URL; still offline until the host heartbeats.
  const pair = await client.pair(poolId, ownerToken, joined.device.id);
  assert.match(pair.url, /^http:\/\/127\.0\.0\.1:4092\/__fleet\/pair\?nonce=/);
  assert.equal(pair.online, false);

  await client.request('/api/heartbeat', {
    method: 'POST',
    token: joined.deviceToken,
    body: { version: '0.1.0', publicUrl: 'http://127.0.0.1:4092' },
  });
  const pairOnline = await client.pair(poolId, ownerToken, joined.device.id);
  assert.equal(pairOnline.online, true);

  // Revoking removes the host from the active list.
  await client.revokeDevice(poolId, ownerToken, joined.device.id);
  const afterRevoke = await client.listDevices(poolId, ownerToken);
  assert.ok(!afterRevoke.devices.some((d) => d.id === joined.device.id));
});

test('invalid join code surfaces pool_code_invalid', async () => {
  await assert.rejects(
    client.joinPool({ code: 'ZZZZZZZZ', name: 'x', platform: 'win32' }),
    (err) =>
      err instanceof DirectoryError &&
      err.code === 'pool_code_invalid' &&
      err.status === 404 &&
      errorForRenderer(err).message.includes('池码'),
  );
});

test('pair rejects unknown or non-active hosts', async () => {
  const created = await client.createPool({
    name: 'second',
    deviceName: 'desktop-test',
    platform: 'win32',
  });
  await assert.rejects(
    client.pair(created.pool.id, created.deviceToken, 'dev_doesnotexist'),
    (err) => err instanceof DirectoryError && err.code === 'host_not_found',
  );
});
