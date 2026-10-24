// MultiDSH end-to-end smoke test (M0).
// Starts Directory + Host sidecar (real dsh web), then exercises:
// create pool -> host joins (pending) -> owner approves -> heartbeat ->
// device list -> pair (nonce) -> 303 /?token= -> DSH sets dsh-auth cookie.
//
// Run from the multidsh directory:
//   .\bin\node.cmd scripts\e2e.mjs            # Node directory (JSON persistence)
//   .\bin\node.cmd scripts\e2e.mjs --worker   # Worker directory served by its Node adapter
//   .\bin\node.cmd scripts\e2e.mjs --directory https://multidsh.example.com   # deployed Worker

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE =
  process.env.MULTIDSH_NODE ||
  path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const WORKER = process.argv.includes('--worker');
const EXTERNAL_DIRECTORY = argValue('--directory', null);
const TMP = path.join(
  ROOT,
  '.tmp',
  EXTERNAL_DIRECTORY ? 'e2e-cloud' : WORKER ? 'e2e-worker' : 'e2e',
);
const DIR_PORT = 8787;
const DSH_PORT = 3093;
const ADMIN_PORT = 4093;
const PUBLIC_URL = `http://127.0.0.1:${ADMIN_PORT}`;
const DIRECTORY = EXTERNAL_DIRECTORY ? EXTERNAL_DIRECTORY.replace(/\/+$/, '') : `http://127.0.0.1:${DIR_PORT}`;

const children = [];
let failed = false;

function log(...args) {
  console.log('[e2e]', ...args);
}

function start(name, args, extraEnv = {}) {
  const out = path.join(TMP, `${name}.log`);
  const err = path.join(TMP, `${name}.err.log`);
  const child = spawn(NODE, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
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
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
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

  // 1. Directory: local Node implementation, Worker via Node adapter, or a deployed Worker.
  if (!EXTERNAL_DIRECTORY) {
    if (WORKER) {
      start('directory-worker', ['packages/directory-worker/bin.js', '--port', String(DIR_PORT)]);
    } else {
      start('directory', [
        'packages/directory/bin.js',
        '--port',
        String(DIR_PORT),
        '--data',
        path.join(TMP, 'directory.json'),
      ]);
    }
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
  log(
    `directory up (${EXTERNAL_DIRECTORY ? `deployed ${DIRECTORY}` : WORKER ? 'worker + node adapter' : 'node'})`,
  );

  // 2. Create pool (owner = desktop client)
  const created = await json(`${DIRECTORY}/api/pools`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e', deviceName: 'e2e-desktop', platform: 'win32' }),
  });
  const ownerToken = created.deviceToken;
  const poolId = created.pool.id;
  const code = created.pool.joinCode;
  log('pool created', poolId, 'code', code);

  // 3. Host init (pending). Retry: a deployed Worker may not have propagated the
  // freshly created join code to every edge yet (KV is eventually consistent).
  for (let attempt = 1; ; attempt += 1) {
    const initRun = start(`host-init-${attempt}`, [
      'packages/host/bin.js',
      'init',
      '--directory',
      DIRECTORY,
      '--pool-code',
      code,
      '--name',
      'e2e-win',
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
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host init timed out')), 30_000);
      initRun.child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (exitCode === 0) break;
    const stderr = initRun.getStderr();
    if (attempt >= 6) throw new Error(`host init exited ${exitCode}: ${stderr}`);
    log(`host init attempt ${attempt} failed, retrying (join code not visible yet): ${stderr.split('\n')[0]}`);
    await delay(4000);
  }
  log('host joined as pending');

  // 4. Owner sees pending host, approves it
  const pendingList = await json(`${DIRECTORY}/api/pools/${poolId}/devices?includePending=1`, {
    headers: bearer(ownerToken),
  });
  const host = pendingList.devices.find((d) => d.kind === 'host');
  if (!host) throw new Error('pending host not found');
  if (host.status !== 'pending') throw new Error(`expected pending, got ${host.status}`);
  if (!host.machineId || !host.machineName) throw new Error('host machine identity missing from Directory');
  await json(`${DIRECTORY}/api/pools/${poolId}/devices/${host.id}/approve`, {
    method: 'POST',
    headers: bearer(ownerToken),
  });
  log('host approved', host.id);

  // 5. Host run
  const hostRun = start('host-run', ['packages/host/bin.js', 'run', '--config', path.join(TMP, 'host.json')]);
  const health = await waitFor(
    'host token captured',
    async () => {
      const res = await fetch(`${PUBLIC_URL}/__fleet/health`);
      if (!res.ok) return null;
      const body = await res.json();
      return body?.dsh?.tokenCaptured ? body : null;
    },
    150_000,
    500,
  );
  log('host up, dsh pid', health.dsh.pid, 'port', health.dsh.port);

  // 6. Heartbeat reflected in device list
  const activeHost = await waitFor(
    'host heartbeat visible',
    async () => {
      const list = await json(`${DIRECTORY}/api/pools/${poolId}/devices`, { headers: bearer(ownerToken) });
      const d = list.devices.find((x) => x.id === host.id);
      return d && Date.now() - (d.lastSeenAt || 0) < 90_000 ? d : null;
    },
    60_000,
    1000,
  );
  if (activeHost.status !== 'active') throw new Error('host not active');
  if (activeHost.machineId !== host.machineId) throw new Error('machineId changed across heartbeat');
  log('heartbeat ok, lastSeenAt set');

  // 7. Pair -> nonce URL -> 303 to /?token=
  const paired = await json(`${DIRECTORY}/api/pools/${poolId}/pair`, {
    method: 'POST',
    headers: { ...bearer(ownerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ hostId: host.id }),
  });
  log('pair url', paired.url);
  const pairRes = await fetch(paired.url, { redirect: 'manual' });
  if (pairRes.status !== 303) throw new Error(`expected 303 from pair, got ${pairRes.status}`);
  const location = pairRes.headers.get('location');
  if (!location || !location.startsWith('/?token=')) throw new Error(`unexpected pair Location: ${location}`);
  log('pair 303 ->', location.slice(0, 24) + '…');

  // 8. Token -> DSH cookie (via sidecar proxy, Host preserved)
  const tokenUrl = new URL(location, PUBLIC_URL).toString();
  const tokenRes = await fetch(tokenUrl, { redirect: 'manual' });
  if (tokenRes.status !== 303) throw new Error(`expected 303 from token, got ${tokenRes.status}`);
  const cookies = tokenRes.headers.getSetCookie ? tokenRes.headers.getSetCookie() : [];
  const authCookie = cookies.find((c) => c.startsWith('dsh-auth-'));
  if (!authCookie) throw new Error('missing dsh-auth cookie');
  log('dsh cookie set:', authCookie.split(';')[0].slice(0, 24) + '…');

  // 9. Load UI with cookie through the sidecar proxy
  const cookiePair = authCookie.split(';')[0];
  const uiRes = await fetch(`${PUBLIC_URL}/`, { headers: { cookie: cookiePair }, redirect: 'manual' });
  if (!(uiRes.status === 200 || uiRes.status === 303)) throw new Error(`expected UI 200/303, got ${uiRes.status}`);
  const html = await uiRes.text();
  if (uiRes.status === 200 && !html.includes('<')) throw new Error('UI response does not look like html');
  log('UI served through sidecar proxy, status', uiRes.status, 'bytes', html.length);

  // 10. Replay must fail
  const replay = await fetch(paired.url, { redirect: 'manual' });
  if (replay.status !== 400 && replay.status !== 410) throw new Error(`replay should fail, got ${replay.status}`);
  log('nonce replay rejected with', replay.status);

  log('PASS');
}

main()
  .catch((err) => {
    failed = true;
    console.error('[e2e] FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    cleanup();
    await delay(500);
    if (!failed) log('done, processes stopped');
  });
