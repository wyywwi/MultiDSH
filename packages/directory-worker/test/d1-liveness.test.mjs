// D1-backed liveness tests. Uses Node's built-in SQLite as a D1 stand-in so the
// exact SQL (upsert/COALESCE/list IN) is exercised without deploying.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDirectoryApp } from '../src/app.js';
import { D1Liveness, MemoryKv, Repository } from '../src/storage.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS device_liveness (
  device_id    TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  public_url   TEXT,
  version      TEXT,
  health_json  TEXT,
  machine_id   TEXT,
  machine_name TEXT
);
`;

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

test('D1 liveness: heartbeat upsert, preserve fields, and list status', async () => {
  const d1 = makeD1();
  const now = 1_700_000_000_000;
  const repo = new Repository({ kv: new MemoryKv(), now: () => now, liveness: new D1Liveness(d1, { now: () => now }) });
  const app = createDirectoryApp({ repo, now: () => now });

  const created = await call(app, 'POST', '/api/pools', {
    body: { name: 'd1-pool', deviceName: 'owner', platform: 'test' },
  });
  assert.equal(created.status, 201);
  const pool = created.body.pool;
  const ownerToken = created.body.deviceToken;

  const joined = await call(app, 'POST', '/api/pools/join', {
    body: {
      code: pool.joinCode,
      kind: 'host',
      name: 'd1-host',
      platform: 'linux',
      publicUrl: 'https://d1-host.example.com',
      machineId: 'machine_d1',
      machineName: 'd1-box',
    },
  });
  assert.equal(joined.status, 202);
  const host = joined.body.device;
  const hostToken = joined.body.deviceToken;

  const approved = await call(app, 'POST', `/api/pools/${pool.id}/devices/${host.id}/approve`, { token: ownerToken });
  assert.equal(approved.status, 200);

  const beat = await call(app, 'POST', '/api/heartbeat', {
    token: hostToken,
    body: { version: '0.2.0', health: { dshRunning: true, dshPort: 3080 } },
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.body.status, 'active');
  assert.equal(beat.body.device.lastSeenAt, now);
  assert.equal(beat.body.device.health.dshRunning, true);

  // A later heartbeat without publicUrl/machineName must not erase them.
  const later = now + 30_000;
  const repoLater = new Repository({ kv: repo.kv, now: () => later, liveness: repo.liveness });
  const appLater = createDirectoryApp({ repo: repoLater, now: () => later });
  const beat2 = await call(appLater, 'POST', '/api/heartbeat', {
    token: hostToken,
    body: { health: { dshRunning: false } },
  });
  assert.equal(beat2.status, 200);
  assert.equal(beat2.body.device.lastSeenAt, later);
  assert.equal(beat2.body.device.publicUrl, 'https://d1-host.example.com');
  assert.equal(beat2.body.device.machineName, 'd1-box');
  assert.equal(beat2.body.device.health.dshRunning, false);

  const list = await call(appLater, 'GET', `/api/pools/${pool.id}/devices`, { token: ownerToken });
  assert.equal(list.status, 200);
  const listed = list.body.devices.find((device) => device.id === host.id);
  assert.equal(listed.lastSeenAt, later);
  assert.equal(listed.health.dshRunning, false);
  assert.equal(listed.machineName, 'd1-box');

  // No hb:<id> key should be written when D1 is configured.
  assert.equal(await repo._getJson(`hb:${host.id}`), null);
});

test('D1 liveness: getMany returns only matching rows', async () => {
  const d1 = makeD1();
  const now = 1_700_000_000_000;
  const liveness = new D1Liveness(d1, { now: () => now });
  const repo = new Repository({ kv: new MemoryKv(), now: () => now, liveness });

  await liveness.record('dev_a', { lastSeenAt: 10, publicUrl: 'https://a.example' });
  await liveness.record('dev_b', { lastSeenAt: 20, health: { ok: true } });
  const map = await liveness.getMany(['dev_a', 'dev_b', 'missing', 'dev_a']);
  assert.equal(map.size, 2);
  assert.equal(map.get('dev_a').lastSeenAt, 10);
  assert.equal(map.get('dev_a').publicUrl, 'https://a.example');
  assert.deepEqual(map.get('dev_b').health, { ok: true });

  const single = await liveness.get('dev_b');
  assert.equal(single.lastSeenAt, 20);
  assert.equal(await liveness.get('missing'), null);
});
