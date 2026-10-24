import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(REPO, '..');
const CLI = path.join(REPO, 'bin', 'multidsh.mjs');
const NODE = process.execPath;
const HOME = path.join(REPO, '.tmp', 'cli-home');
const DIRECTORY_PORT = 8791;
const DIRECTORY_URL = `http://127.0.0.1:${DIRECTORY_PORT}`;
const fakeDsh = path.join(REPO, 'scripts', 'fixtures', 'fake-dsh.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile(NODE, [CLI, ...args], { cwd: REPO, env: { ...process.env, MULTIDSH_HOME: HOME, ...extraEnv }, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`multidsh ${args.join(' ')} failed:\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function waitForDirectory() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${DIRECTORY_URL}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  throw new Error('directory did not start');
}

async function main() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '.tmp', 'cli-dir'), { recursive: true, force: true });
  const dirLog = fs.openSync(path.join(ROOT, '.tmp', 'cli-dir.log'), 'w');
  const directory = spawn(NODE, [path.join(REPO, 'packages', 'directory', 'bin.js'), '--port', String(DIRECTORY_PORT), '--data', path.join(ROOT, '.tmp', 'cli-dir')], {
    cwd: REPO,
    stdio: ['ignore', dirLog, dirLog],
  });
  try {
    await waitForDirectory();
    const created = await (await fetch(`${DIRECTORY_URL}/api/pools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cli-test', deviceName: 'cli-owner', platform: 'win32' }),
    })).json();
    const poolCode = created.pool.joinCode;
    const ownerToken = created.deviceToken;
    console.log('pool', created.pool.id, 'code', poolCode);

    const profiles = [
      { name: 'cli-a', adminPort: 4280, dshPort: 3280 },
      { name: 'cli-b', adminPort: 4281, dshPort: 3281 },
    ];
    for (const p of profiles) {
      const init = await run([
        'init', '--no-interactive', '--yes',
        '--directory', DIRECTORY_URL,
        '--pool-code', poolCode,
        '--name', p.name,
        '--dsh-bin', fakeDsh,
        '--dsh-home', path.join(HOME, 'instances', p.name, 'dsh-home'),
        '--admin-port', String(p.adminPort),
        '--dsh-port', String(p.dshPort),
        '--public-url', `http://127.0.0.1:${p.adminPort}`,
      ]);
      process.stdout.write(init.stdout);
      const config = JSON.parse(fs.readFileSync(path.join(HOME, 'instances', p.name, 'host.json'), 'utf8'));
      p.deviceId = config.deviceId;
      p.config = config;
      if (!/^machine_[0-9a-f]+$/.test(config.machineId || '')) {
        throw new Error(`${p.name} missing machineId: ${config.machineId}`);
      }
      if (!config.machineName) throw new Error(`${p.name} missing machineName`);
      console.log(`${p.name} machine ${config.machineId} (${config.machineName})`);
      const approve = await fetch(`${DIRECTORY_URL}/api/pools/${created.pool.id}/devices/${config.deviceId}/approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      if (!approve.ok) throw new Error(`approve ${p.name} failed: ${approve.status} ${await approve.text()}`);
      console.log(`approved ${p.name} (${config.deviceId})`);
    }

    for (const p of profiles) {
      const started = await run(['start', p.name]);
      process.stdout.write(started.stdout);
    }

    let ok = true;
    for (const p of profiles) {
      const health = await (await fetch(`http://127.0.0.1:${p.adminPort}/__fleet/health`)).json();
      console.log(`${p.name} health`, JSON.stringify(health));
      if (health.dshRunning !== true && health.dsh !== true && health.ok !== true) ok = false;
    }

    const list = await run(['list']);
    process.stdout.write(list.stdout);
    for (const p of profiles) if (!list.stdout.includes(p.name)) throw new Error(`list missing ${p.name}`);
    const status = await run(['status']);
    process.stdout.write(status.stdout);
    for (const p of profiles) {
      if (!status.stdout.includes(`admin ${p.adminPort}`)) throw new Error(`status missing ${p.name}`);
      if (!status.stdout.includes('OK')) throw new Error(`status not OK for ${p.name}`);
    }

    const devices = await (await fetch(`${DIRECTORY_URL}/api/pools/${created.pool.id}/devices`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    })).json();
    const active = (devices.devices || []).filter((d) => d.kind === 'host' && d.status === 'active');
    console.log('directory active hosts:', active.map((d) => `${d.name}:${d.deviceId}`).join(', '));
    if (active.length !== 2) throw new Error(`expected 2 active hosts, got ${active.length}`);
    const machineIds = new Set(active.map((d) => d.machineId));
    if (machineIds.size !== 1 || !machineIds.has(profiles[0].config.machineId)) {
      throw new Error(`hosts were not grouped on one machine: ${JSON.stringify(active.map((d) => d.machineId))}`);
    }
    if (active.some((d) => d.machineName !== profiles[0].config.machineName)) {
      throw new Error('hosts report inconsistent machineName');
    }

    for (const p of profiles) {
      const stopped = await run(['stop', p.name]);
      process.stdout.write(stopped.stdout);
    }
    for (const p of profiles) {
      await run(['remove', p.name, '--yes']);
      if (fs.existsSync(path.join(HOME, 'instances', p.name))) throw new Error(`remove did not delete ${p.name}`);
    }
    if (!ok) throw new Error('health check failed');
    console.log('\nCLI INTEGRATION PASS: two hosts on one machine share machineId, separate ports/DSH_HOME, both active.');
  } finally {
    fs.closeSync(dirLog);
    directory.kill();
    await sleep(300);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
