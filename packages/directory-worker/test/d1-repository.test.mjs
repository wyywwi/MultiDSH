// Full D1 repository tests: pools/devices/tokens + liveness, exercised through
// the same fetch app used by the Worker. node:sqlite is a stand-in for D1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createDirectoryApp } from '../src/app.js';
import { D1Repository } from '../src/storage.js';

const SCHEMA = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

/** Minimal D1Database/PreparedStatement adapter over node:sqlite. */
function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) {
          params = values;
          return statement;
        },
        async run() {
          const result = db.prepare(sql).run(...params);
          return { success: true, meta: result };
        },
        async first() {
          return db.prepare(sql).get(...params) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...params), success: true };
        },
      };
      return statement;
    },
  };
}

async function call(app, method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.fetch(
    new Request(`http://directory.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('D1 repository: pool/device/token lifecycle survives a restart', async () => {
  const d1 = makeD1();
  const now = 1_700_000_000_000;
  const repo = new D1Repository({ db: d1, now: () => now });
  const app = createDirectoryApp({ repo, now: () => now });

  const created = await call(app, 'POST', '/api/pools', {
    body: { name: 'd1-home', deviceName: 'owner', platform: 'test' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.pool.name, 'd1-home');
  const pool = created.body.pool;
  const ownerToken = created.body.deviceToken;

  // Re-read through a fresh repository instance (D1 persistence).
  const repo2 = new D1Repository({ db: d1, now: () => now });
  const persistedPool = await repo2.getPool(pool.id);
  assert.equal(persistedPool.ownerDeviceId, created.body.device.id);
  assert.equal(persistedPool.joinCode, pool.joinCode);
  assert.equal((await repo2.getDevice(created.body.device.id)).role, 'owner');
  assert.equal((await repo2.getDeviceByToken(ownerToken)).id, created.body.device.id);

  const joined = await call(app, 'POST', '/api/pools/join', {
    body: {
      code: pool.joinCode.toLowerCase(),
      kind: 'host',
      name: 'd1-linux',
      platform: 'linux',
      publicUrl: 'https://d1-linux.example.com',
      machineId: 'machine_d1',
      machineName: 'd1-box',
    },
  });
  assert.equal(joined.status, 202);
  assert.equal(joined.body.pool.name, 'd1-home');
  assert.equal(joined.body.device.status, 'pending');
  assert.ok(joined.body.pairSecret.startsWith('mps_'));
  const host = joined.body.device;

  const approved = await call(app, 'POST', `/api/pools/${pool.id}/devices/${host.id}/approve`, {
    token: ownerToken,
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.device.status, 'active');

  const beatAt = now + 30_000;
  const app2 = createDirectoryApp({ repo: new D1Repository({ db: d1, now: () => beatAt }), now: () => beatAt });
  const beat = await call(app2, 'POST', '/api/heartbeat', {
    token: joined.body.deviceToken,
    body: { version: '0.2.0', health: { dshRunning: true } },
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.body.device.status, 'active');
  assert.equal(beat.body.device.lastSeenAt, beatAt);
  assert.equal(beat.body.device.health.dshRunning, true);

  const list = await call(app2, 'GET', `/api/pools/${pool.id}/devices?includePending=1`, { token: ownerToken });
  assert.equal(list.status, 200);
  const listed = list.body.devices.find((device) => device.id === host.id);
  assert.equal(listed.lastSeenAt, beatAt);
  assert.equal(listed.machineName, 'd1-box');
  assert.equal('tokenHash' in listed, false);
  assert.equal('pairSecret' in listed, false);

  const pair = await call(app2, 'POST', `/api/pools/${pool.id}/pair`, {
    token: ownerToken,
    body: { hostId: host.id },
  });
  assert.equal(pair.status, 200);
  assert.equal(pair.body.online, true);
  assert.match(pair.body.url, /^https:\/\/d1-linux\.example\.com\/__fleet\/pair\?nonce=/);

  // Rotate invalidates the old code and keeps the pool usable.
  const rotated = await call(app2, 'POST', `/api/pools/${pool.id}/join-code/rotate`, { token: ownerToken });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.joinCode, pool.joinCode);
  const oldCode = await call(app2, 'POST', '/api/pools/join', {
    body: { code: pool.joinCode, kind: 'host', name: 'old-code' },
  });
  assert.equal(oldCode.status, 404);
  const newCode = await call(app2, 'POST', '/api/pools/join', {
    body: { code: rotated.body.joinCode, kind: 'client', name: 'new-client' },
  });
  assert.equal(newCode.status, 202);
});

test('D1 repository: revoke blocks heartbeat and pair', async () => {
  const d1 = makeD1();
  const now = 1_700_000_000_000;
  const repo = new D1Repository({ db: d1, now: () => now });
  const app = createDirectoryApp({ repo, now: () => now });
  const created = await call(app, 'POST', '/api/pools', { body: { name: 'revoke-pool' } });
  const ownerToken = created.body.deviceToken;
  const pool = created.body.pool;
  const joined = await call(app, 'POST', '/api/pools/join', {
    body: { code: pool.joinCode, kind: 'host', name: 'host', publicUrl: 'https://h.example' },
  });
  const hostToken = joined.body.deviceToken;
  await call(app, 'POST', `/api/pools/${pool.id}/devices/${joined.body.device.id}/approve`, { token: ownerToken });

  await call(app, 'POST', `/api/pools/${pool.id}/devices/${joined.body.device.id}/revoke`, { token: ownerToken });
  const beat = await call(app, 'POST', '/api/heartbeat', { token: hostToken, body: {} });
  assert.equal(beat.status, 403);
  assert.equal(beat.body.error.code, 'device_revoked');
  const pair = await call(app, 'POST', `/api/pools/${pool.id}/pair`, {
    token: ownerToken,
    body: { hostId: joined.body.device.id },
  });
  assert.equal(pair.status, 409);
  assert.equal(pair.body.error.code, 'host_not_active');
});
