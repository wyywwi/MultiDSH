// Integration test: real dsh web + fake Directory + sidecar admin/pair/proxy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signNonce, newId } from '../../protocol/index.js';
import { initHost } from '../src/init.js';
import { DshSupervisor, assertDshBin } from '../src/supervisor.js';
import { createAdminServer } from '../src/admin.js';
import { createProxy } from '../src/proxy.js';
import { Heartbeat } from '../src/heartbeat.js';
import { defaultDshBin, loadConfig } from '../src/config.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TMP = path.join(ROOT, '.tmp', 'host-test');
const DIR_PORT = 8199;
const DSH_PORT = 3094;
const ADMIN_PORT = 4094;

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startFakeDirectory() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/pools/join') {
      jsonResponse(res, 202, {
        device: {
          id: 'dev_test',
          poolId: 'pool_test',
          kind: 'host',
          role: 'member',
          name: 'test-host',
          platform: 'win32',
          version: '0.1.0',
          status: 'pending',
          createdAt: Date.now(),
          approvedAt: null,
          lastSeenAt: null,
          publicUrl: `http://127.0.0.1:${ADMIN_PORT}`,
          health: null,
          meta: {},
        },
        deviceToken: 'mdt_test',
        pairSecret: 'mps_test_secret',
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/heartbeat') {
      jsonResponse(res, 200, { ok: true, status: 'active' });
      return;
    }
    jsonResponse(res, 404, { error: { code: 'not_found', message: req.url } });
  });
  return new Promise((resolve) => server.listen(DIR_PORT, '127.0.0.1', () => resolve(server)));
}

async function waitForToken(supervisor, timeoutMs = 120_000) {
  if (supervisor.token) return supervisor.token;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for dsh token')), timeoutMs);
    supervisor.once('token', ({ token }) => {
      clearTimeout(timer);
      resolve(token);
    });
  });
}

test('host sidecar: init, token, pair nonce, replay rejection, proxy', { timeout: 180_000 }, async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const fakeDirectory = await startFakeDirectory();
  let supervisor;
  let adminServer;
  let heartbeat;

  try {
    const dshBin = assertDshBin(defaultDshBin());
    const { config } = await initHost({
      directoryUrl: `http://127.0.0.1:${DIR_PORT}`,
      poolCode: 'TESTCODE',
      name: 'test-host',
      platform: 'win32',
      version: '0.1.0',
      publicUrl: `http://127.0.0.1:${ADMIN_PORT}`,
      adminPort: ADMIN_PORT,
      dshPort: DSH_PORT,
      dshBin,
      dshHome: path.join(TMP, 'dshhome'),
      configPath: path.join(TMP, 'host.json'),
    });
    assert.equal(config.deviceId, 'dev_test');
    assert.equal(config.status, 'pending');
    assert.match(config.machineId, /^machine_[0-9a-f]+$/);
    assert.ok(config.machineName);
    assert.ok(loadConfig(path.join(TMP, 'host.json')).pairSecret);

    supervisor = new DshSupervisor({
      dshBin,
      dshPort: config.dshPort,
      publicUrl: config.publicUrl,
      dshHome: config.dshHome,
      log: () => {},
    });
    const proxy = createProxy({ targetPort: config.dshPort, log: () => {} });
    heartbeat = new Heartbeat({
      directoryUrl: config.directoryUrl,
      deviceToken: config.deviceToken,
      config,
      supervisor,
      log: () => {},
    });
    const admin = createAdminServer({ config, supervisor, heartbeat, proxy, log: () => {} });
    adminServer = admin.server;
    await new Promise((resolve, reject) => {
      adminServer.once('error', reject);
      adminServer.listen(config.adminPort, '127.0.0.1', resolve);
    });

    supervisor.start();
    heartbeat.start();
    const token = await waitForToken(supervisor);
    assert.ok(token.length > 10, 'token captured');

    const health = await (await fetch(`http://127.0.0.1:${ADMIN_PORT}/__fleet/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.deviceId, 'dev_test');
    assert.equal(health.dsh.tokenCaptured, true);

    const nonce = signNonce(config.pairSecret, {
      hostId: config.deviceId,
      clientId: 'dev_client',
      exp: Date.now() + 60_000,
      jti: newId('jti'),
    });
    const pairUrl = `http://127.0.0.1:${ADMIN_PORT}/__fleet/pair?nonce=${encodeURIComponent(nonce)}`;
    const pairRes = await fetch(pairUrl, { redirect: 'manual' });
    assert.equal(pairRes.status, 303);
    assert.ok((pairRes.headers.get('location') || '').startsWith('/?token='));

    const replay = await fetch(pairUrl, { redirect: 'manual' });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error.code, 'pair_replayed');

    const ui = await fetch(`http://127.0.0.1:${ADMIN_PORT}/`, { redirect: 'manual' });
    assert.ok([200, 303, 401].includes(ui.status), `proxy status ${ui.status}`);
  } finally {
    heartbeat?.stop();
    if (adminServer) await new Promise((resolve) => adminServer.close(resolve));
    if (supervisor) await supervisor.stop();
    await new Promise((resolve) => fakeDirectory.close(resolve));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});
