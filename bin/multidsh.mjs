#!/usr/bin/env node
// MultiDSH host manager CLI — a friendly wrapper around packages/host/bin.js.
//
// Design goals:
//   * one obvious command, no `node packages/host/bin.js` path juggling;
//   * interactive wizard with sensible defaults when run in a terminal;
//   * every prompt can be skipped with flags for scripts/systemd/CI;
//   * multiple named profiles per machine (each = one host / one DSH version).
//
// Usage: ./multidsh [init|run|start|stop|status|list|logs|remove|doctor]

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';

import { ADMIN_PREFIX, normalizeJoinCode } from '../packages/protocol/index.js';
import { initHost } from '../packages/host/src/init.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOST_BIN = path.join(ROOT, 'packages', 'host', 'bin.js');
const HOME = path.resolve(process.env.MULTIDSH_HOME || path.join(os.homedir(), '.multidsh'));
const INSTANCES_DIR = path.join(HOME, 'instances');
const PREFS_FILE = path.join(HOME, 'cli.json');
const DEFAULT_DIRECTORY = process.env.MULTIDSH_DIRECTORY || 'https://multidsh.example.com';
const DEFAULT_ADMIN_PORT = 4080;
const DEFAULT_DSH_PORT = 3080;
const VERSION = '0.1.0';

const color = (() => {
  const on = process.stdout.isTTY && !process.env.NO_COLOR;
  const wrap = (code) => (text) => (on ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('36'),
  };
})();

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function sanitizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function fail(message) {
  throw new Error(message);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readPrefs() {
  return readJson(PREFS_FILE, {}) || {};
}

function savePrefs(patch) {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  const prefs = { ...readPrefs(), ...patch };
  fs.writeFileSync(PREFS_FILE, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
}

function printHeader(title) {
  console.log(`\n${color.bold('MultiDSH')} ${color.dim(`· ${title}`)}\n`);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(profile) {
  return Number(readJson(path.join(instanceDir(profile), 'pid.json'), {})?.pid) || null;
}

function writePid(profile, pid) {
  fs.mkdirSync(instanceDir(profile), { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir(profile), 'pid.json'),
    `${JSON.stringify({ pid, startedAt: Date.now(), command: `${process.execPath} ${HOST_BIN} run` }, null, 2)}\n`,
    'utf8',
  );
}

function clearPid(profile) {
  fs.rmSync(path.join(instanceDir(profile), 'pid.json'), { force: true });
}

function instanceDir(profile) {
  return path.join(INSTANCES_DIR, profile);
}

function profileConfigPath(profile) {
  return path.join(instanceDir(profile), 'host.json');
}

function legacyProfile() {
  // Hosts created by the old `node packages/host/bin.js init` live at
  // ~/.multidsh/host.json (no instances/<name>/ directory). Keep them visible
  // and manageable instead of stranding existing deployments.
  const file = path.join(HOME, 'host.json');
  const config = readJson(file, null);
  if (!config || !config.deviceId) return null;
  const name = sanitizeName(config.name || 'default') || 'default';
  const pid = readPid(name);
  return { name, config, configPath: file, pid, running: isAlive(pid), legacy: true };
}

function listProfiles() {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    /* no instances yet */
  }
  for (const name of names.sort()) {
    const file = profileConfigPath(name);
    const config = readJson(file, null);
    if (!config) continue;
    out.push({ name, config, configPath: file, pid: readPid(name), running: isAlive(readPid(name)) });
  }
  const legacy = legacyProfile();
  if (legacy && !out.some((p) => p.name === legacy.name)) out.push(legacy);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveProfile(name) {
  const profiles = listProfiles();
  if (!profiles.length) {
    fail('还没有 host。先运行 `multidsh init` 创建一个（或 `multidsh` 进入交互菜单）。');
  }
  if (name) {
    const found = profiles.find((p) => p.name === name);
    if (!found) fail(`找不到 host "${name}"。可用：${profiles.map((p) => p.name).join(', ')}`);
    return found;
  }
  if (profiles.length === 1) return profiles[0];
  fail(`有多个 host，请指定名字：${profiles.map((p) => p.name).join(', ')}`);
}

// ---------------------------------------------------------------------------
// binary / port detection
// ---------------------------------------------------------------------------

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function detectDshBin(explicit) {
  if (explicit) return path.resolve(expandHome(explicit));
  if (process.env.MULTIDSH_DSH_BIN) return path.resolve(expandHome(process.env.MULTIDSH_DSH_BIN));
  const home = os.homedir();
  const candidates = [
    path.join(ROOT, 'dsh_out', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(home, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(home, 'multidsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(home, 'dsh-a', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(home, 'dsh-b', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    path.join(home, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  if (process.platform === 'win32') {
    candidates.unshift(
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(home, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    );
  }
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  // Install locations people actually use on GPU boxes: ~/dsh-<variant>/node_modules/...
  try {
    for (const entry of fs.readdirSync(home)) {
      if (!/^dsh/i.test(entry)) continue;
      const candidate = path.join(home, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (isFile(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  // nvm-style global installs.
  try {
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
    for (const version of fs.readdirSync(nvmRoot)) {
      const candidate = path.join(nvmRoot, version, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (isFile(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  // `dsh` on PATH (npm link / global install): resolve the symlink to the real bin.js.
  const pathDirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const exe = path.join(dir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
    if (!isFile(exe)) continue;
    try {
      const real = fs.realpathSync(exe);
      if (real.endsWith('.js')) return real;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readDshVersion(dshBin) {
  if (!dshBin) return '?';
  let dir = path.dirname(dshBin);
  for (let i = 0; i < 5; i += 1) {
    const pkgFile = path.join(dir, 'package.json');
    const pkg = readJson(pkgFile, null);
    if (pkg?.name === '@deepseek-ai/dsh' && pkg.version) return pkg.version;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '?';
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => server.close(() => resolve(true)));
  });
}

async function pickPorts({ adminPort, dshPort } = {}) {
  // Existing profiles own their ports even while stopped: don't hand the same
  // default port to a second profile (it would collide when both start).
  const used = new Set();
  for (const profile of listProfiles()) {
    for (const port of [profile.config.adminPort, profile.config.dshPort]) {
      if (Number.isInteger(Number(port))) used.add(Number(port));
    }
  }
  let admin = adminPort ? Number(adminPort) : DEFAULT_ADMIN_PORT;
  let dsh = dshPort ? Number(dshPort) : DEFAULT_DSH_PORT;
  if (adminPort && used.has(admin)) fail(`admin 端口 ${admin} 已被本机另一个 host 使用`);
  if (dshPort && used.has(dsh)) fail(`dsh 端口 ${dsh} 已被本机另一个 host 使用`);
  if (adminPort && dshPort) {
    if (!(await portFree(admin))) fail(`admin 端口 ${admin} 已被占用`);
    if (!(await portFree(dsh))) fail(`dsh 端口 ${dsh} 已被占用`);
    if (admin === dsh) fail('admin 端口和 dsh 端口不能相同');
    return { adminPort: admin, dshPort: dsh };
  }
  while (admin < 4300 && (!(await portFree(admin)) || used.has(admin))) admin += 1;
  if (dsh === admin || used.has(dsh)) dsh += 1;
  while (dsh < 3300 && (!(await portFree(dsh)) || dsh === admin || used.has(dsh))) dsh += 1;
  if (admin >= 4300 || dsh >= 3300) fail('找不到空闲端口，请用 --admin-port/--dsh-port 指定');
  return { adminPort: admin, dshPort: dsh };
}

async function directoryHealthy(directoryUrl) {
  try {
    const res = await fetch(`${String(directoryUrl).replace(/\/+$/, '')}/api/health`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return { ok: true, detail: body };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function waitForHealth(adminPort, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${adminPort}${ADMIN_PREFIX}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

function healthOf(adminPort) {
  return fetch(`http://127.0.0.1:${adminPort}${ADMIN_PREFIX}/health`, { signal: AbortSignal.timeout(1500) })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// interactive prompt
// ---------------------------------------------------------------------------

async function withPrompt(fn, enabled = true) {
  if (!enabled || !process.stdin.isTTY) return fn(null);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

async function ask(rl, question, defaultValue, { required = false, validate } = {}) {
  const suffix = defaultValue ? color.dim(` [${defaultValue}]`) : '';
  for (;;) {
    let answer = '';
    if (rl) {
      answer = (await rl.question(`${question}${suffix}: `)).trim();
    }
    answer = answer || defaultValue || '';
    if (!answer && required) {
      console.log(color.yellow('  需要填写这一项。'));
      if (!rl) fail(`${question} 是必填项（非交互模式请用对应的 --flag）`);
      continue;
    }
    if (validate) {
      const error = validate(answer);
      if (error) {
        console.log(color.yellow(`  ${error}`));
        if (!rl) fail(error);
        continue;
      }
    }
    return answer;
  }
}

async function confirm(rl, question, defaultValue = true) {
  if (!rl) return defaultValue;
  const answer = (await rl.question(`${question} ${defaultValue ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes' || answer === '是';
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdInit(args) {
  const interactive = !args.yes && !args['no-interactive'] && Boolean(process.stdin.isTTY);
  const prefs = readPrefs();
  return withPrompt(async (rl) => {
    printHeader('创建 host（入池）');
    console.log(
      '会创建一个独立的 host：自己的配置、DSH_HOME 和端口；多建几个就能在同一台机器上跑多个 DSH 实例（可指向不同版本/插件）。\n',
    );
    const directoryUrl = String(
      args.directory ||
        (await ask(rl, 'Directory 地址', prefs.directoryUrl || DEFAULT_DIRECTORY, {
          validate: (v) => (/^https?:\/\//.test(v) ? null : '需要 http(s):// 开头的地址'),
        })),
    ).replace(/\/+$/, '');

    const health = await directoryHealthy(directoryUrl);
    if (health.ok) {
      console.log(color.green(`  Directory 已连接（protocol=${health.detail?.protocol ?? '?'}）`));
    } else {
      console.log(color.yellow(`  Directory 健康检查失败：${health.detail}`));
      if (interactive && !(await confirm(rl, '仍然继续？', false))) return 1;
    }

    let poolCode = args['pool-code'] ? normalizeJoinCode(args['pool-code']) : '';
    if (!poolCode) {
      if (!rl) fail('非交互模式需要 --pool-code');
      poolCode = normalizeJoinCode(await ask(rl, '池码（在 MultiDSH 客户端创建池得到）', null, { required: true }));
    }
    if (poolCode.length < 6) fail(`池码 "${poolCode}" 看起来不对（至少 6 位）`);

    const baseName = sanitizeName(args.name || `${os.hostname()}-dsh`);
    let name = args.profile ? sanitizeName(args.profile) : baseName;
    if (!args.name && !args.profile && rl) {
      name = sanitizeName(await ask(rl, 'host 名字（同一台机器上要唯一）', baseName));
    }
    if (!name) fail('host 名字不能为空');
    if (listProfiles().some((p) => p.name === name)) {
      fail(`这台机器上已有同名 host "${name}"，请换一个名字（例如 ${name}-2）`);
    }

    const detectedDsh = detectDshBin(args['dsh-bin']);
    let dshBin = detectedDsh || '';
    if (rl) {
      dshBin = path.resolve(
        expandHome(
          await ask(rl, 'DSH CLI（bin.js）路径', detectedDsh || undefined, {
            required: true,
            validate: (v) => {
              const p = path.resolve(expandHome(v));
              return isFile(p) ? null : `找不到文件：${p}`;
            },
          }),
        ),
      );
    }
    if (!dshBin || !isFile(dshBin)) fail(`dsh CLI 不存在：${dshBin || '(未检测到)'}；用 --dsh-bin 指定`);
    const dshVersion = readDshVersion(dshBin);

    let adminPort = args['admin-port'] ? Number(args['admin-port']) : null;
    let dshPort = args['dsh-port'] ? Number(args['dsh-port']) : null;
    if (rl && !adminPort && !dshPort) {
      console.log(color.dim(`  默认端口：admin ${DEFAULT_ADMIN_PORT} / dsh ${DEFAULT_DSH_PORT}（已被占用会自动 +1）`));
    }
    const ports = await pickPorts({ adminPort, dshPort });

    const publicUrl = String(
      args['public-url'] ||
        (rl
          ? await ask(
              rl,
              'Public URL（客户端从这里打开 DSH UI；同机/SSH 隧道可用 127.0.0.1）',
              `http://127.0.0.1:${ports.adminPort}`,
            )
          : `http://127.0.0.1:${ports.adminPort}`),
    ).replace(/\/+$/, '');

    let dshHome = args['dsh-home'] ? path.resolve(expandHome(args['dsh-home'])) : path.join(instanceDir(name), 'dsh-home');
    if (rl && !args['dsh-home']) {
      dshHome = path.resolve(
        expandHome(await ask(rl, 'DSH_HOME（该实例自己的 DSH 数据目录）', dshHome)),
      );
    }
    const configPath = args.config
      ? path.resolve(expandHome(args.config))
      : profileConfigPath(name);

    console.log(`\n${color.bold('即将创建：')}`);
    console.log(`  name        ${name}`);
    console.log(`  directory   ${directoryUrl}`);
    console.log(`  dsh         ${dshBin} ${color.dim(`(@deepseek-ai/dsh ${dshVersion})`)}`);
    console.log(`  dsh home    ${dshHome}`);
    console.log(`  ports       admin ${ports.adminPort} / dsh ${ports.dshPort}`);
    console.log(`  public url  ${publicUrl}`);
    console.log(`  config      ${configPath}\n`);
    if (interactive && !(await confirm(rl, '确认入池？'))) return 1;

    const { config, file } = await initHost({
      directoryUrl,
      poolCode,
      name,
      platform: args.platform || process.platform,
      version: VERSION,
      machineId: args['machine-id'] || undefined,
      machineName: args['machine-name'] || undefined,
      publicUrl,
      adminPort: ports.adminPort,
      dshPort: ports.dshPort,
      dshBin,
      dshHome,
      nodeBin: args['node-bin'] ? path.resolve(expandHome(args['node-bin'])) : process.execPath,
      configPath,
    });
    savePrefs({ directoryUrl });

    console.log(color.green(`\n已加入池 ${config.poolId}`));
    console.log(`  device   ${config.deviceId}`);
    console.log(`  状态     ${config.status === 'pending' ? color.yellow('待 owner 审批（在 MultiDSH 客户端里批准）') : color.green(config.status)}`);
    console.log(`  配置     ${file}\n`);
    console.log('接下来：');
    console.log(`  ./multidsh status ${name}    # 看状态`);
    console.log(`  ./multidsh start ${name}     # 后台启动（日志在 ${path.join(instanceDir(name), 'run.log')}）`);
    console.log(`  ./multidsh run ${name}       # 前台启动（Ctrl-C 停止）\n`);
    if (config.status === 'pending') {
      console.log(color.dim('  批准之前 host 不会出现在「在线主机」里，但可以先启动，审批后自动上线。\n'));
    }
    return 0;
  }, interactive);
}

function spawnRun(profile, { detached }) {
  const { configPath } = profile;
  const logFile = path.join(instanceDir(profile.name), 'run.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [HOST_BIN, 'run', '--config', configPath], {
    cwd: ROOT,
    detached,
    windowsHide: true,
    stdio: detached ? ['ignore', out, out] : ['inherit', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  fs.closeSync(out);
  child.on('error', (err) => {
    try {
      fs.appendFileSync(logFile, `[multidsh] failed to spawn host: ${err.message}\n`);
    } catch {
      /* ignore */
    }
  });
  writePid(profile.name, child.pid);
  return { child, logFile };
}

async function cmdRun(args) {
  const profile = resolveProfile(args._[0] || args.profile);
  if (profile.running) fail(`host "${profile.name}" 已经在运行（pid ${profile.pid}）。要重启先 stop。`);
  printHeader(`前台启动 ${profile.name}`);
  const { child } = spawnRun(profile, { detached: false });
  const cleanup = () => clearPid(profile.name);
  child.on('exit', (code) => {
    cleanup();
    process.exitCode = code ?? 0;
  });
  process.on('SIGINT', () => {
    try {
      child.kill('SIGINT');
    } catch {
      /* ignore */
    }
  });
  process.on('SIGTERM', () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  });
  await new Promise((resolve) => child.once('exit', resolve));
  return 0;
}

async function cmdStart(args) {
  const profile = resolveProfile(args._[0] || args.profile);
  if (profile.running) {
    console.log(`host "${profile.name}" 已经在运行（pid ${profile.pid}）。`);
    return 0;
  }
  const { child, logFile } = spawnRun(profile, { detached: true });
  child.unref();
  process.stdout.write(`已启动 ${profile.name} (pid ${child.pid})，等待就绪…`);
  const health = await waitForHealth(profile.config.adminPort, 12_000);
  if (health) {
    console.log(color.green(' OK'));
    console.log(`  admin  http://127.0.0.1:${profile.config.adminPort}${ADMIN_PREFIX}/health`);
    console.log(`  日志   ${logFile}`);
    console.log(`  停止   ./multidsh stop ${profile.name}`);
    return 0;
  }
  if (!isAlive(child.pid)) {
    clearPid(profile.name);
    fail(`启动失败，日志：\n${tailFile(logFile, 20)}`);
  }
  console.log(color.yellow(' 未在 12s 内拿到健康响应（可能还在等审批/启动 dsh），用 status 再看。'));
  return 0;
}

function tailFile(file, lines = 30) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(无日志)';
  }
}

async function cmdStop(args) {
  const profile = resolveProfile(args._[0] || args.profile);
  const pid = profile.pid;
  if (!profile.running || !pid) {
    clearPid(profile.name);
    console.log(`host "${profile.name}" 没有在运行。`);
    return 0;
  }
  process.stdout.write(`停止 ${profile.name} (pid ${pid})…`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.log(color.yellow(` 发送 SIGTERM 失败：${err.message}`));
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isAlive(pid)) await new Promise((r) => setTimeout(r, 300));
  if (isAlive(pid)) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    console.log(color.yellow(' 已强制结束'));
  } else {
    console.log(color.green(' 已停止'));
  }
  clearPid(profile.name);
  return 0;
}

async function cmdStatus(args) {
  const profiles = args._[0] || args.profile ? [resolveProfile(args._[0] || args.profile)] : listProfiles();
  if (!profiles.length) fail('还没有 host。');
  for (const profile of profiles) {
    const health = await healthOf(profile.config.adminPort);
    const running = profile.running;
    console.log(`\n${color.bold(profile.name)}  ${running ? color.green('running') : color.dim('stopped')}`);
    console.log(`  device    ${profile.config.deviceId}  (${profile.config.status || '?'})`);
    console.log(`  directory ${profile.config.directoryUrl}`);
    console.log(`  ports     admin ${profile.config.adminPort} / dsh ${profile.config.dshPort}`);
    console.log(`  public    ${profile.config.publicUrl}`);
    console.log(`  dsh       ${profile.config.dshBin} ${color.dim(`v${readDshVersion(profile.config.dshBin)}`)}`);
    console.log(`  dsh home  ${profile.config.dshHome || '(默认)'}`);
    if (health) console.log(`  health    ${color.green('OK')} ${color.dim(JSON.stringify(health))}`);
    else if (running) console.log(`  health    ${color.yellow('无响应（可能 dsh 正在启动）')}`);
  }
  console.log('');
  return 0;
}

function cmdList() {
  const profiles = listProfiles();
  if (!profiles.length) {
    console.log('还没有 host。运行 `./multidsh init` 创建一个。');
    return 0;
  }
  printHeader('本机 host');
  const rows = profiles.map((p) => ({
    name: p.name,
    state: p.running ? 'running' : 'stopped',
    device: String(p.config.deviceId || '').slice(0, 12),
    admin: p.config.adminPort,
    dsh: p.config.dshPort,
    version: readDshVersion(p.config.dshBin),
  }));
  const headers = ['NAME', 'STATE', 'DEVICE', 'ADMIN', 'DSH', 'DSH VERSION'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(color.dim(line(headers)));
  for (const row of rows) {
    const cells = [row.name, row.state, row.device, row.admin, row.dsh, row.version];
    console.log(line(cells.map((c, i) => (i === 1 && row.state === 'running' ? color.green(c) : c))));
  }
  console.log('');
  return 0;
}

function cmdLogs(args) {
  const profile = resolveProfile(args._[0] || args.profile);
  const lines = Number(args.lines || args.n || 40);
  console.log(tailFile(path.join(instanceDir(profile.name), 'run.log'), lines));
  return 0;
}

async function cmdRemove(args) {
  const profile = resolveProfile(args._[0] || args.profile);
  const ok = args.yes ? true : await withPrompt((rl) => confirm(rl, `删除 host "${profile.name}" 的本地配置和 DSH_HOME？`, false));
  if (!ok) {
    console.log('已取消。');
    return 1;
  }
  if (profile.running && profile.pid) {
    try {
      process.kill(profile.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  fs.rmSync(instanceDir(profile.name), { recursive: true, force: true });
  if (profile.legacy) {
    console.log(`已删除 ${profile.name} 的本地运行数据；旧格式配置仍保留在 ${profile.configPath}。`);
  } else {
    console.log(`已删除 ${profile.name}（云端设备记录需要用 Desktop / Directory API 吊销，CLI 不代删）。`);
  }
  return 0;
}

async function cmdDoctor() {
  printHeader('环境检查');
  console.log(`node        ${process.version} (${process.execPath})`);
  console.log(`platform    ${process.platform} ${process.arch}`);
  console.log(`home        ${HOME}`);
  const dshBin = detectDshBin();
  if (dshBin) {
    console.log(`dsh         ${dshBin}`);
    console.log(`dsh version ${readDshVersion(dshBin)}`);
  } else {
    console.log(color.yellow('dsh         未检测到（用 --dsh-bin 指定，或 npm install @deepseek-ai/dsh）'));
  }
  const health = await directoryHealthy(readPrefs().directoryUrl || DEFAULT_DIRECTORY);
  console.log(`directory   ${readPrefs().directoryUrl || DEFAULT_DIRECTORY} ${health.ok ? color.green('OK') : color.yellow(health.detail)}`);
  const profiles = listProfiles();
  console.log(`hosts       ${profiles.length} 个${profiles.length ? `（${profiles.map((p) => p.name).join(', ')}）` : ''}`);
  if (dshBin && isFile(path.join(ROOT, 'packages', 'host', 'bin.js'))) {
    console.log(color.green('\n结论：这台机器可以运行 MultiDSH host。'));
  } else {
    console.log(color.yellow('\n缺少 dsh CLI 或 host 代码不完整。'));
  }
  return 0;
}

async function interactiveMenu() {
  printHeader('host 管理器');
  const profiles = listProfiles();
  if (profiles.length) {
    console.log('本机 host：');
    for (const p of profiles) console.log(`  ${p.name.padEnd(16)} ${p.running ? color.green('running') : 'stopped'}`);
    console.log('');
  } else {
    console.log('还没有 host，先创建第一个。\n');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      console.log('  1) 创建 / 加入新 host');
      console.log('  2) 启动 host');
      console.log('  3) 查看状态');
      console.log('  4) 列出所有 host');
      console.log('  5) 停止 host');
      console.log('  6) 环境检查');
      console.log('  0) 退出');
      const choice = (await rl.question('\n选择: ')).trim();
      if (!choice || choice === '0' || choice.toLowerCase() === 'q') {
        rl.close();
        return 0;
      }
      if (choice === '1') {
        rl.close();
        return cmdInit({ _: [] });
      }
      if (choice === '2') {
        const profiles = listProfiles();
        if (!profiles.length) {
          console.log(color.yellow('还没有 host，请先选 1 创建。'));
          continue;
        }
        let target = profiles.find((p) => p.running);
        if (!target && profiles.length === 1) target = profiles[0];
        if (!target) {
          const answer = (await rl.question(`启动哪个 host？(${profiles.map((p) => p.name).join(', ')}): `)).trim();
          target = profiles.find((p) => p.name === answer);
          if (!target) {
            console.log(color.yellow(`找不到 "${answer}"`));
            continue;
          }
        }
        rl.close();
        return cmdStart({ _: [target.name] });
      }
      if (choice === '3') {
        rl.close();
        return cmdStatus({ _: [] });
      }
      if (choice === '4') {
        rl.close();
        return cmdList();
      }
      if (choice === '5') {
        const profiles = listProfiles();
        if (!profiles.length) {
          console.log(color.yellow('还没有 host。'));
          continue;
        }
        let target = profiles.find((p) => p.running);
        if (!target && profiles.length === 1) target = profiles[0];
        if (!target) {
          const answer = (await rl.question(`停止哪个 host？(${profiles.map((p) => p.name).join(', ')}): `)).trim();
          target = profiles.find((p) => p.name === answer);
          if (!target) {
            console.log(color.yellow(`找不到 "${answer}"`));
            continue;
          }
        }
        rl.close();
        return cmdStop({ _: [target.name] });
      }
      if (choice === '6') {
        rl.close();
        return cmdDoctor();
      }
      console.log(color.yellow('无效选择'));
    }
  } finally {
    if (!rl.closed) rl.close();
  }
}

function usage() {
  console.log(`MultiDSH host manager v${VERSION}

用法:
  ./multidsh                    交互式菜单
  ./multidsh init               创建 host（入池；有默认值的交互向导）
  ./multidsh run [name]         前台运行（Ctrl-C 停止）
  ./multidsh start [name]       后台运行
  ./multidsh stop [name]        停止
  ./multidsh status [name]      健康/配置状态
  ./multidsh list               本机所有 host
  ./multidsh logs [name]        查看后台日志
  ./multidsh remove [name]      删除本地实例（不含云端记录）
  ./multidsh doctor             检查 node/dsh/directory

init 常用参数（不给就走交互向导）:
  --pool-code <code>            池码（必填）
  --directory <url>             Directory（默认 ${DEFAULT_DIRECTORY}）
  --name <name>                 host 名字（默认 <hostname>-dsh）
  --dsh-bin <path>              DSH 的 lib/bin.js（自动探测）
  --dsh-home <dir>              该实例 DSH 数据目录（默认 ~/.multidsh/instances/<name>/dsh-home）
  --admin-port/--dsh-port       端口（默认 ${DEFAULT_ADMIN_PORT}/${DEFAULT_DSH_PORT}，占用自动 +1）
  --public-url <url>            客户端打开 UI 的地址（默认 http://127.0.0.1:<admin>）
  --machine-id <id>             同一台机器的稳定 ID（默认自动生成并写入 ~/.multidsh/machine.json）
  --machine-name <name>         客户端显示的机器名（默认 hostname）
  --node-bin <path>             运行 dsh 的 node（默认当前 node）
  --yes                         全部用默认值（自动化/CI）
  --no-interactive              禁止交互（缺参数即报错）

示例（同一台机器跑两个不同 DSH 版本/插件）:
  ./multidsh init --name dsh-vanilla --pool-code ABCD1234 \\
    --dsh-bin ~/dsh-a/node_modules/@deepseek-ai/dsh/lib/bin.js
  ./multidsh init --name dsh-purge --pool-code ABCD1234 \\
    --dsh-bin ~/dsh-b/node_modules/@deepseek-ai/dsh/lib/bin.js
  ./multidsh start dsh-vanilla
  ./multidsh start dsh-purge
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const args = parseArgs(command ? argv.slice(1) : argv);
  if (args.help || args.h || command === 'help' || (!command && (args._?.length || args.help))) {
    usage();
    return 0;
  }
  if (!command && (args.version || args.v)) {
    console.log(`multidsh ${VERSION}`);
    return 0;
  }
  switch (command) {
    case undefined:
      if (process.stdin.isTTY) return interactiveMenu();
      usage();
      return 0;
    case 'init':
    case 'add':
      return cmdInit(args);
    case 'run':
      return cmdRun(args);
    case 'start':
      return cmdStart(args);
    case 'stop':
      return cmdStop(args);
    case 'status':
      return cmdStatus(args);
    case 'list':
    case 'ls':
      return cmdList();
    case 'logs':
      return cmdLogs(args);
    case 'remove':
    case 'rm':
      return cmdRemove(args);
    case 'doctor':
      return cmdDoctor();
    case 'version':
    case '--version':
    case '-v':
      console.log(`multidsh ${VERSION}`);
      return 0;
    default:
      fail(`未知命令: ${command}\n运行 ./multidsh --help 查看用法`);
  }
}

main().catch((err) => {
  console.error(`${color.red('错误:')} ${err.message}`);
  process.exit(1);
});
