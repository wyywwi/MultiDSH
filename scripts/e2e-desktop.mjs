// MultiDSH desktop live E2E (M0).
//
// Full chain: Directory -> create pool (owner = this desktop) -> host joins
// (pending) -> owner approves -> host sidecar runs real dsh -> desktop app
// starts with that session config -> Device list shows the host -> open the host
// (pair -> 303 -> dsh-auth cookie -> DSH UI inside WebContentsView) -> screenshots
// and assertions in .tmp/desktop-live-metrics.json.
//
// Run from the multidsh directory:
//   .\bin\node.cmd scripts\e2e-desktop.mjs
//   .\bin\node.cmd scripts\e2e-desktop.mjs --worker   # Worker directory adapter

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE =
  process.env.MULTIDSH_NODE ||
  path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
const ELECTRON = path.join(ROOT, 'packages', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');

const WORKER = process.argv.includes('--worker');
const TMP = path.join(ROOT, '.tmp', 'e2e-desktop');
const DIR_PORT = 8787;
const DSH_PORT = 3093;
const ADMIN_PORT = 4093;
const PUBLIC_URL = `http://127.0.0.1:${ADMIN_PORT}`;
const DIRECTORY = `http://127.0.0.1:${DIR_PORT}`;

const children = [];
let failed = false;

function log(...args) {
  console.log('[e2e-desktop]', ...args);
}

function start(name, command, args, extraEnv = {}, cwd = ROOT) {
  const out = path.join(TMP, `${name}.log`);
  const err = path.join(TMP, `${name}.err.log`);
  const env = { ...process.env, ...extraEnv };
  // The harness shell sometimes exports ELECTRON_RUN_AS_NODE=1, which turns
  // electron.exe into plain Node; an empty value still counts as set.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
    writeFileSync(out, stdout);
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    writeFileSync(err, stderr);
  });
  children.push({ name, child });
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function cleanup() {
  for (const { child } of children.reverse()) {
    try {
      killTree(child.pid);
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(label, fn, timeoutMs = 150_000, intervalMs = 500) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function json(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${url} -> ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  if (!readFileSyncSafe(ELECTRON)) throw new Error(`electron binary not found: ${ELECTRON}`);

  // 1. Directory
  if (WORKER) {
    start('directory-worker', NODE, ['packages/directory-worker/bin.js', '--port', String(DIR_PORT)]);
  } else {
    start('directory', NODE, [
      'packages/directory/bin.js',
      '--port',
      String(DIR_PORT),
      '--data',
      path.join(TMP, 'directory.json'),
    ]);
  }
  await waitFor(
    'directory health',
    async () => {
      const r = await fetch(`${DIRECTORY}/api/health`);
      return r.ok;
    },
    30_000,
    250,
  );
  log('directory up');

  // 2. Owner pool; the returned token/id is what the desktop app will use.
  const created = await json(`${DIRECTORY}/api/pools`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'desktop-e2e', deviceName: 'live-desktop', platform: 'win32' }),
  });
  const ownerToken = created.deviceToken;
  const poolId = created.pool.id;
  const code = created.pool.joinCode;
  log('pool created', poolId);

  // 3. Host joins (pending) and is approved by the owner.
  const initRun = start('host-init', NODE, [
    'packages/host/bin.js',
    'init',
    '--directory',
    DIRECTORY,
    '--pool-code',
    code,
    '--name',
    'live-win',
    '--platform',
    'win32',
    '--version',
    '0.1.0',
    '--public-url',
    PUBLIC_URL,
    '--admin-port',
    String(ADMIN_PORT),
    '--dsh-port',
    String(DSH_PORT),
    '--dsh-home',
    path.join(TMP, 'dshhome'),
    '--config',
    path.join(TMP, 'host.json'),
  ]);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host init timed out')), 30_000);
    initRun.child.on('exit', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) resolve();
      else reject(new Error(`host init exited ${exitCode}: ${initRun.getStderr()}`));
    });
  });
  log('host joined pending');

  const pendingList = await json(`${DIRECTORY}/api/pools/${poolId}/devices?includePending=1`, {
    headers: bearer(ownerToken),
  });
  const host = pendingList.devices.find((d) => d.kind === 'host');
  if (!host) throw new Error('pending host not found');
  await json(`${DIRECTORY}/api/pools/${poolId}/devices/${host.id}/approve`, {
    method: 'POST',
    headers: bearer(ownerToken),
  });
  log('host approved', host.id);

  // 4. Host sidecar runs real dsh; wait for the token + heartbeat.
  start('host-run', NODE, ['packages/host/bin.js', 'run', '--config', path.join(TMP, 'host.json')]);
  await waitFor(
    'host token captured',
    async () => {
      const res = await fetch(`${PUBLIC_URL}/__fleet/health`);
      if (!res.ok) return null;
      const body = await res.json();
      return body && body.dsh && body.dsh.tokenCaptured ? body : null;
    },
    150_000,
    500,
  );
  const onlineHost = await waitFor(
    'host heartbeat visible',
    async () => {
      const list = await json(`${DIRECTORY}/api/pools/${poolId}/devices`, { headers: bearer(ownerToken) });
      const found = list.devices.find((d) => d.id === host.id);
      return found && Date.now() - (found.lastSeenAt || 0) < 90_000 ? found : null;
    },
    60_000,
    1000,
  );
  if (onlineHost.status !== 'active') throw new Error('host is not active');
  log('host up and heartbeat visible');

  // 5. Desktop app: start with the owner session, open the host, verify the UI.
  const metricsFile = path.join(ROOT, '.tmp', 'desktop-live-metrics.json');
  rmSync(metricsFile, { force: true });
  const electron = start('desktop', ELECTRON, ['.', '--live-smoke', '--no-sandbox'], {
    MULTIDSH_LIVE_DIRECTORY: DIRECTORY,
    MULTIDSH_LIVE_POOL_ID: poolId,
    MULTIDSH_LIVE_DEVICE_ID: created.device.id,
    MULTIDSH_LIVE_DEVICE_TOKEN: ownerToken,
    MULTIDSH_LIVE_DEVICE_NAME: 'live-desktop',
    MULTIDSH_LIVE_ROLE: 'owner',
    MULTIDSH_LIVE_HOST_ID: host.id,
    MULTIDSH_LIVE_PUBLIC_URL: PUBLIC_URL,
  }, path.join(ROOT, 'packages', 'desktop'));

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('desktop timed out; killing');
      killTree(electron.child.pid);
      resolve('timeout');
    }, 150_000);
    electron.child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  log('desktop exit code:', exitCode);
  if (exitCode !== 0) {
    throw new Error(`desktop exited ${exitCode}\n--- stdout ---\n${electron.getStdout()}\n--- stderr ---\n${electron.getStderr()}`);
  }

  if (!readFileSyncSafe(metricsFile)) throw new Error('desktop metrics file missing');
  const metrics = JSON.parse(readFileSync(metricsFile, 'utf8'));
  if (metrics.assertions && metrics.assertions.length) {
    throw new Error(`desktop assertions failed: ${metrics.assertions.join('; ')}`);
  }
  const m = metrics.metrics || {};
  if (!(m.devices >= 2)) throw new Error(`desktop did not list the pool devices (devices=${m.devices})`);
  if (!(m.onlineHosts >= 1)) throw new Error('desktop did not see an online host');
  if (!m.hostUrl || !m.hostUrl.startsWith(PUBLIC_URL)) {
    throw new Error(`host view did not land on the sidecar origin: ${m.hostUrl}`);
  }
  if (!m.authCookies || !m.authCookies.length) throw new Error('desktop host view has no dsh-auth cookie');
  if (!(m.uiTextLength > 100)) throw new Error(`DSH UI text too short: ${m.uiTextLength}`);

  log(`desktop listed ${m.devices} devices (${m.onlineHosts} online hosts)`);
  log('desktop opened host:', m.hostUrl, `title="${m.hostTitle}"`);
  log('dsh-auth cookies in host view:', m.authCookies.join(','));
  log('screenshots:', m.screenshots && m.screenshots.host, '|', m.screenshots && m.screenshots.window);
  log('PASS');
}

function readFileSyncSafe(file) {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

main()
  .catch((err) => {
    failed = true;
    console.error('[e2e-desktop] FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    cleanup();
    await delay(500);
    if (!failed) log('done, processes stopped');
  });
