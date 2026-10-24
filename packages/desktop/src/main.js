'use strict';

/**
 * MultiDSH desktop client — Electron main process (M0).
 *
 * Responsibilities:
 *  - owns the BrowserWindow and the embedded host view (WebContentsView/BrowserView)
 *  - performs ALL Directory HTTP calls (the renderer never talks to the network)
 *  - persists client state in <userData>/config.json
 *  - polls the Directory every 30s while the window is focused
 *
 * Renderer <-> main IPC is exposed through src/preload.js as `window.fleet`.
 */

const {
  app,
  session,
  BrowserWindow,
  WebContentsView,
  BrowserView,
  ipcMain,
  clipboard,
  shell,
  Tray,
  Menu,
  nativeImage,
} = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_DIRECTORY_URL,
  DirectoryClient,
  DirectoryError,
  errorForRenderer,
  isOnline,
  normalizeBaseUrl,
  normalizeJoinCode,
} = require('./directory-client');

const VERSION = require('../package.json').version;

const APP_NAME = 'MultiDSH';
const SIDEBAR_WIDTH = 300;
/** Collapsed sidebar rail width (the expand button lives here). */
const COLLAPSED_SIDEBAR_WIDTH = 32;
const POLL_INTERVAL_MS = 30000;
const HOST_PARTITION = 'persist:multidsh-host';

/**
 * Prefer IPv4 for the app's own Directory calls. Measured 2026-10-24: the IPv4
 * anycast path lands on the HKG edge consistently, while IPv6 was routed to
 * SIN/NRT in 6/10 samples and cost 85-170 ms more per request. Chromium keeps
 * its own Happy Eyeballs for the embedded page; this only affects main-process
 * fetch() (DirectoryClient).
 */
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* older Node: keep the default order */
}

const PACKAGE_ROOT = path.resolve(__dirname, '..');
/** multidsh/.tmp — used for smoke screenshots. */
const TMP_DIR = path.resolve(PACKAGE_ROOT, '..', '..', '.tmp');

const SMOKE = process.argv.includes('--smoke');
const SMOKE_DEMO = process.argv.includes('--smoke-demo') || process.env.MULTIDSH_SMOKE_DEMO === '1';
/**
 * Live smoke: point the real app at a running Directory + Host (config from env
 * variables), open a host through the normal pair -> cookie -> DSH UI path and
 * write screenshots + assertions. Driven by scripts/e2e-desktop.mjs.
 */
const LIVE_SMOKE = process.argv.includes('--live-smoke');

/**
 * First-run demo: when the app starts without a pool, show the real UI filled
 * with clearly-labelled sample data instead of an empty onboarding screen, so
 * a double-click is enough to see what the client looks like. Nothing is sent
 * anywhere; the settings panel has "退出演示，开始使用".
 *
 * `--demo` forces it, `--no-demo` disables it, MULTIDSH_DESKTOP_DEMO=1/0 wins
 * over both. Once the user leaves the demo (or joins a real pool) the choice is
 * persisted as `demoDismissed` in config.json and the demo never shows again.
 */
const DEMO_FLAG = process.argv.includes('--demo') || process.env.MULTIDSH_DESKTOP_DEMO === '1';
const NO_DEMO = process.argv.includes('--no-demo') || process.env.MULTIDSH_DESKTOP_DEMO === '0';
let demoActive = false;

const HAS_WEB_CONTENTS_VIEW = typeof WebContentsView === 'function';
const HAS_BROWSER_VIEW = typeof BrowserView === 'function';

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.multidsh.desktop');

if (SMOKE || LIVE_SMOKE) {
  // Deterministic, isolated profile and software rendering: these modes must
  // work on machines without a GPU (live mode still talks to a real Directory).
  app.setPath('userData', path.join(TMP_DIR, LIVE_SMOKE ? 'desktop-live-userdata' : 'desktop-smoke-userdata'));
  app.disableHardwareAcceleration();
  // Hard watchdog: never leave an electron process behind, even if a renderer
  // or capturePage hangs.
  const watchdogMs = LIVE_SMOKE ? 120_000 : 15_000;
  setTimeout(() => {
    console.error(`[${LIVE_SMOKE ? 'live' : 'smoke'}] watchdog: forcing exit after ${watchdogMs / 1000}s`);
    try {
      app.exit(1);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        process.exit(1);
      } catch {
        /* ignore */
      }
    }, 300);
  }, watchdogMs);
}

// ---------------------------------------------------------------------------
// Config (<userData>/config.json)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  directoryUrl: DEFAULT_DIRECTORY_URL,
  poolId: null,
  deviceId: null,
  deviceToken: null,
  deviceName: null,
  // Extras kept for a better UI (not part of the minimal M0 schema).
  poolName: null,
  role: null, // 'owner' | 'member'
  joinCode: null,
  joinCodeExpiresAt: null,
  selfStatus: null, // 'pending' | 'active' | 'revoked'
  createPoolKey: null,
  theme: 'light', // 'light' (day mode, default) | 'dark'
  autoStartLocalHost: false, // remember "this machine is a host" across app restarts
  // How many DSH pages stay alive in memory: closing a host detaches its view
  // instead of destroying it, so the next open is instant. Each cached page
  // keeps a renderer (~100-200 MB), so this is user-configurable (1-6, default 3).
  hostViewCacheSize: 3,
};

function defaultDeviceName() {
  const fromEnv = (process.env.MULTIDSH_DEVICE_NAME || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const host = os.hostname();
    return host && host.trim() ? host.trim() : 'MultiDSH Desktop';
  } catch {
    return 'MultiDSH Desktop';
  }
}

/** Legacy (0.1.0 and earlier) portable data location next to the exe. */
function legacyConfigFilePath() {
  return path.join(path.dirname(process.execPath), 'multidsh-config.json');
}

/**
 * Opt-in portable mode: create a `multidsh-portable.txt` next to the exe and the
 * app keeps config/local-host beside the exe again. Default is a stable
 * %APPDATA%\MultiDSH folder so upgrading/extracting a new build never wipes the
 * pool session.
 */
function isPortableMode() {
  if (!app.isPackaged) return false;
  try {
    return fs.existsSync(path.join(path.dirname(process.execPath), 'multidsh-portable.txt'));
  } catch {
    return false;
  }
}

function configFilePath() {
  if (app.isPackaged && !isPortableMode()) return path.join(app.getPath('userData'), 'config.json');
  if (app.isPackaged) return legacyConfigFilePath();
  return path.join(app.getPath('userData'), 'config.json');
}

/** One-time migration from the old beside-the-exe layout to the stable app dir. */
function migrateLegacyData() {
  if (!app.isPackaged || isPortableMode()) return;
  const userData = app.getPath('userData');
  try {
    fs.mkdirSync(userData, { recursive: true });
  } catch (err) {
    console.warn('[config] cannot create userData:', err && err.message);
    return;
  }
  const legacyConfig = legacyConfigFilePath();
  const newConfig = path.join(userData, 'config.json');
  try {
    if (fs.existsSync(legacyConfig) && !fs.existsSync(newConfig)) {
      fs.copyFileSync(legacyConfig, newConfig);
      console.log('[config] migrated legacy multidsh-config.json -> %APPDATA%\\MultiDSH');
    }
  } catch (err) {
    console.warn('[config] legacy config migration failed:', err && err.message);
  }

  const legacyHost = path.join(path.dirname(process.execPath), 'local-host');
  const newHost = path.join(userData, 'local-host');
  try {
    if (fs.existsSync(legacyHost) && !fs.existsSync(newHost)) {
      fs.cpSync(legacyHost, newHost, { recursive: true });
      // Absolute dshHome paths inside host.json still point at the old folder.
      const hostConfigPath = path.join(newHost, 'host.json');
      if (fs.existsSync(hostConfigPath)) {
        const hostConfig = JSON.parse(fs.readFileSync(hostConfigPath, 'utf8').replace(/^\uFEFF/, ''));
        if (typeof hostConfig.dshHome === 'string' && hostConfig.dshHome.startsWith(legacyHost)) {
          hostConfig.dshHome = hostConfig.dshHome.replace(legacyHost, newHost);
          fs.writeFileSync(hostConfigPath, `${JSON.stringify(hostConfig, null, 2)}\n`, 'utf8');
        }
      }
      console.log('[config] migrated legacy local-host -> %APPDATA%\\MultiDSH\\local-host');
    }
  } catch (err) {
    console.warn('[config] legacy local-host migration failed:', err && err.message);
  }
}

function loadConfig() {
  let parsed = {};
  try {
    const raw = fs.readFileSync(configFilePath(), 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') parsed = data;
  } catch {
    parsed = {};
  }
  const config = { ...DEFAULT_CONFIG, ...parsed };
  config.theme = config.theme === 'dark' ? 'dark' : 'light';
  const cachedViews = Number(config.hostViewCacheSize);
  config.hostViewCacheSize =
    Number.isInteger(cachedViews) && cachedViews >= 1 && cachedViews <= 6
      ? cachedViews
      : DEFAULT_CONFIG.hostViewCacheSize;
  config.deviceName =
    typeof config.deviceName === 'string' && config.deviceName.trim()
      ? config.deviceName.trim()
      : defaultDeviceName();
  try {
    config.directoryUrl = normalizeBaseUrl(config.directoryUrl);
  } catch {
    config.directoryUrl = DEFAULT_DIRECTORY_URL;
  }
  return config;
}

function saveConfig(config) {
  const file = configFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[config] failed to save:', err && err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Local host sidecar: the app can start a host for THIS machine's DSH itself,
// so joining a pool no longer requires a separate terminal command.
// ---------------------------------------------------------------------------

const LOCAL_HOST_DEFAULTS = { adminPort: 4080, dshPort: 3080 };

const localHost = {
  child: null,
  startedAt: null,
  name: null,
  lastError: null,
  lines: [],
};

function localHostDir() {
  if (app.isPackaged) {
    if (isPortableMode()) return path.join(path.dirname(process.execPath), 'local-host');
    return path.join(app.getPath('userData'), 'local-host');
  }
  // dev: multidsh/.tmp/local-host (writable even when %APPDATA% is locked down)
  return path.resolve(__dirname, '..', '..', '..', '.tmp', 'local-host');
}

function localHostConfigPath() {
  return path.join(localHostDir(), 'host.json');
}

/** Admin port of the configured local host, or null. */
function localHostPort() {
  try {
    const config = JSON.parse(fs.readFileSync(localHostConfigPath(), 'utf8'));
    return Number(config.adminPort) || null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/** Validate/normalize an admin base URL typed by the user (no trailing slash). */

/** Resolve true once something listens on 127.0.0.1:<port>, or timeout. */
function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(700);
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (ok) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 250);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
    };
    attempt();
  });
}

/** host CLI: bundled under resources/app/host in the packaged app, repo path in dev. */
function runtimeHostBin() {
  if (app.isPackaged) return path.join(PACKAGE_ROOT, 'host', 'bin.js');
  return path.resolve(__dirname, '..', '..', 'host', 'bin.js');
}

/** Best candidate for @deepseek-ai/dsh's bin.js on this machine. */
function detectDshBin() {
  const rel = path.join('dsh_out', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const candidates = [];
  const fromEnv = (process.env.MULTIDSH_DSH_BIN || '').trim();
  if (fromEnv) candidates.push(fromEnv);
  // Prefer the bin.js already used by an existing host. This matters when the
  // desktop app lives outside the repository (for example D:\ProgramFiles):
  // path.resolve() can otherwise guess a non-existent D:\dsh_out.
  try {
    for (const id of hostInstanceIds()) {
      const existing = readHostConfig(id);
      if (existing && existing.dshBin) candidates.push(String(existing.dshBin));
    }
  } catch {
    /* no host instances yet */
  }
  // Common npm/global installs.
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (base) candidates.push(path.join(base, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  // Runtime installed by the desktop "install Node/DSH" button.
  try {
    candidates.push(path.join(app.getPath('userData'), 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  } catch {
    /* app paths are unavailable very early during startup */
  }
  // packaged: dist/MultiDSH-win/resources -> workspace/dsh_out
  if (app.isPackaged) candidates.push(path.resolve(process.resourcesPath, '..', '..', '..', '..', rel));
  // dev: packages/desktop/src -> workspace/dsh_out
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', rel));
  candidates.push(path.resolve(PACKAGE_ROOT, '..', '..', '..', rel));
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  // Do not return a made-up path: the UI should show an empty field and ask
  // the user to pick the real bin.js instead of failing with a confusing path.
  return '';
}

/** Real node.exe for running dsh: Electron's binary-as-node is too limited for dsh. */
function detectNodeBin() {
  const candidates = [];
  const fromEnv = (process.env.MULTIDSH_NODE_BIN || '').trim();
  if (fromEnv) candidates.push(fromEnv);
  const localAppData = process.env.LOCALAPPDATA || '';
  try {
    candidates.push(path.join(app.getPath('userData'), 'runtime', 'node', 'node.exe'));
  } catch {
    /* app paths are unavailable very early during startup */
  }
  if (localAppData) {
    candidates.push(
      path.join(
        localAppData,
        'Programs',
        'DeepSeek Harness',
        'resources',
        'runtime',
        'primary-runtime',
        'dependencies',
        'node',
        'bin',
        'node.exe',
      ),
    );
  }
  const runtimesDir = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
  try {
    for (const entry of fs.readdirSync(runtimesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(runtimesDir, entry.name, 'dependencies', 'node', 'bin', 'node.exe'));
      }
    }
  } catch {
    /* no dsh runtimes */
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return '';
}

function localHostInfo() {
  const dshBin = detectDshBin();
  const nodeBin = detectNodeBin();
  const hostBin = runtimeHostBin();
  const configPath = localHostConfigPath();
  let hostConfig = null;
  try {
    hostConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    hostConfig = null;
  }
  return {
    running: Boolean(localHost.child),
    startedAt: localHost.startedAt,
    name: localHost.name || (hostConfig && hostConfig.name) || null,
    lastError: localHost.lastError,
    log: localHost.lines.slice(-40),
    configPath,
    dshBin,
    dshBinExists: Boolean(dshBin && fs.existsSync(dshBin)),
    nodeBin,
    nodeBinExists: Boolean(nodeBin && fs.existsSync(nodeBin)),
    hostBin,
    hostBinExists: fs.existsSync(hostBin),
    deviceId: (hostConfig && hostConfig.deviceId) || null,
    hostStatus: (hostConfig && hostConfig.status) || null,
    adminPort: (hostConfig && hostConfig.adminPort) || LOCAL_HOST_DEFAULTS.adminPort,
    dshPort: (hostConfig && hostConfig.dshPort) || LOCAL_HOST_DEFAULTS.dshPort,
    publicUrl: (hostConfig && hostConfig.publicUrl) || null,
    joinCode: (state.config && state.config.joinCode) || null,
    isOwner: Boolean(state.config && state.config.role === 'owner'),
    autoStart: Boolean(state.config && state.config.autoStartLocalHost),
    directoryUrl: (state.config && state.config.directoryUrl) || DEFAULT_DIRECTORY_URL,
    defaultName: `${os.hostname()}-dsh`,
    defaultPublicUrl: `http://127.0.0.1:${LOCAL_HOST_DEFAULTS.adminPort}`,
  };
}

function hostSpawnEnv() {
  // Electron's binary doubles as Node when ELECTRON_RUN_AS_NODE=1.
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
}

function runHostCommand(args, onLine) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: hostSpawnEnv(),
      cwd: PACKAGE_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    const collect = (chunk) => {
      const text = chunk.toString('utf8');
      output.push(text);
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onLine(line.trim());
        }
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => resolve({ code: -1, output: `${output.join('')}\n${err.message}` }));
    child.on('exit', (code) => resolve({ code: code == null ? -1 : code, output: output.join('') }));
  });
}

async function startLocalHost(options = {}) {
  if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：不能启动本机主机');
  if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
  if (localHost.child) throw new DirectoryError('host_running', '本机主机已经在运行，先停止再启动');
  // Once an instance has been initialised, "start" must reuse its persisted
  // host.json (device identity + pair secret). Re-running `host init` here is
  // what used to create a brand-new device on every launch.
  if (fs.existsSync(localHostConfigPath())) {
    return startHostInstance('default', options);
  }

  const hostBin = runtimeHostBin();
  if (!fs.existsSync(hostBin)) throw new DirectoryError('host_bin_missing', `找不到 host 侧车：${hostBin}`);

  const dshBin = String(options.dshBin || detectDshBin()).trim();
  if (!dshBin || !fs.existsSync(dshBin)) {
    throw new DirectoryError(
      'dsh_not_found',
      '没有找到 DSH 的 bin.js，请在「高级」里填写本机 @deepseek-ai/dsh/lib/bin.js 的路径',
    );
  }
  const nodeBin = String(options.nodeBin || detectNodeBin()).trim();
  if (!nodeBin || !fs.existsSync(nodeBin)) {
    throw new DirectoryError(
      'node_not_found',
      '没有找到 node.exe（DSH 运行时），请先安装 DeepSeek Harness 或把 MULTIDSH_NODE_BIN 指向 node.exe',
    );
  }
  const directoryUrl = String(options.directoryUrl || (state.config && state.config.directoryUrl) || DEFAULT_DIRECTORY_URL);
  const poolCode = normalizeJoinCode(options.poolCode || (state.config && state.config.joinCode) || '');
  if (!poolCode || poolCode.length !== 8) {
    throw new DirectoryError('validation', '需要 8 位池码（池主可从卡片复制，成员向池主索取）');
  }
  const name = String(options.name || '').trim() || `${os.hostname()}-dsh`;
  const adminPort = Number(options.adminPort) || LOCAL_HOST_DEFAULTS.adminPort;
  const dshPort = Number(options.dshPort) || LOCAL_HOST_DEFAULTS.dshPort;
  const publicUrl = String(options.publicUrl || '').trim() || `http://127.0.0.1:${adminPort}`;

  const dir = localHostDir();
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'host.json');
  const dshHome = path.join(dir, 'dsh-home');

  localHost.lines = [];
  localHost.lastError = null;
  const log = (line) => {
    localHost.lines.push(line);
    if (localHost.lines.length > 200) localHost.lines.shift();
  };

  const initArgs = [
    hostBin,
    'init',
    '--directory', directoryUrl,
    '--pool-code', poolCode,
    '--name', name,
    '--public-url', publicUrl,
    '--admin-port', String(adminPort),
    '--dsh-port', String(dshPort),
    '--dsh-home', dshHome,
    '--dsh-bin', dshBin,
    '--node-bin', nodeBin,
    '--config', configPath,
  ];
  log(`init ${name} -> ${directoryUrl}`);
  const init = await runHostCommand(initArgs, log);
  if (init.code !== 0) {
    localHost.lastError = init.output.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    throw new DirectoryError('host_init_failed', `加入池失败：${localHost.lastError || 'unknown error'}`);
  }
  log(`init ok -> ${configPath}`);

  launchLocalHostSidecar(configPath, name);
  updateTrayMenu();
  // Remember it so the next app launch can bring the host back automatically.
  try {
    state.config = { ...state.config, autoStartLocalHost: true };
    saveConfig(state.config);
  } catch (err) {
    console.warn('[local-host] could not persist autoStart flag:', err && err.message);
  }

  // Give the sidecar a moment to register/heartbeat before the UI refreshes.
  setTimeout(() => {
    if (!SMOKE) refresh().catch(() => {});
  }, 1200);
  return localHostInfo();
}

function pushLocalHostLog(line) {
  localHost.lines.push(line);
  if (localHost.lines.length > 200) localHost.lines.shift();
}

/** Start the long-running sidecar (`host run`) and wire its output/exit. */
function launchLocalHostSidecar(configPath, name) {
  const hostBin = runtimeHostBin();
  const child = spawn(process.execPath, [hostBin, 'run', '--config', configPath], {
    env: hostSpawnEnv(),
    cwd: PACKAGE_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  localHost.child = child;
  localHost.startedAt = Date.now();
  localHost.name = name;
  const onLog = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) pushLocalHostLog(line.trim());
    }
  };
  child.stdout.on('data', onLog);
  child.stderr.on('data', onLog);
  child.on('error', (err) => {
    localHost.lastError = err.message;
    if (localHost.child === child) localHost.child = null;
  });
  child.on('exit', (code) => {
    pushLocalHostLog(`host sidecar exited (code=${code})`);
    if (localHost.child === child) localHost.child = null;
    updateTrayMenu();
  });
  pushLocalHostLog(`sidecar running (pid=${child.pid})`);
  return child;
}

/**
 * Called on app startup: if the user had a local host running when the app was
 * closed, bring it back so the local DSH stays reachable (the sidecar is a
 * child process, so closing the app necessarily stops it).
 */
async function resumeLocalHost() {
  if (SMOKE || LIVE_SMOKE) return;
  const config = state.config || loadConfig();
  if (!config.autoStartLocalHost || !config.poolId) return;
  if (localHost.child) return;

  const configPath = localHostConfigPath();
  if (!fs.existsSync(configPath)) return;
  let hostConfig;
  try {
    hostConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
  if (!hostConfig || !hostConfig.poolId || hostConfig.status === 'revoked') return;
  if (!fs.existsSync(runtimeHostBin())) return;
  if (!fs.existsSync(String(hostConfig.dshBin || ''))) {
    localHost.lastError = '本机主机之前配置的 DSH bin.js 已不存在';
    return;
  }
  if (hostConfig.nodeBin && !fs.existsSync(hostConfig.nodeBin)) {
    localHost.lastError = '本机主机之前配置的 node.exe 已不存在';
    return;
  }
  pushLocalHostLog(`resuming local host "${hostConfig.name}" on app startup`);
  launchLocalHostSidecar(configPath, hostConfig.name || `${os.hostname()}-dsh`);
  updateTrayMenu();
  setTimeout(() => {
    refresh().catch(() => {});
  }, 1500);
}

async function stopLocalHost() {
  return stopHostInstance('default');
}

// ---------------------------------------------------------------------------
// Named local host instances (multiple DSH hosts per machine).
//
// The legacy single-host setup lives in <userData>/local-host and keeps the id
// "default". New instances live in <userData>/local-hosts/<id>/. Every instance
// has its own persisted host.json (Directory identity + pair secret), its own
// DSH_HOME (DSH login/API key/session data) and its own pair of ports. Starting
// an existing instance NEVER runs host init again: the device identity and DSH
// credentials stay the same across app restarts.
// ---------------------------------------------------------------------------

const hostRuntimes = new Map();

function hostInstancesRoot() {
  if (app.isPackaged) {
    if (isPortableMode()) return path.join(path.dirname(process.execPath), 'local-hosts');
    return path.join(app.getPath('userData'), 'local-hosts');
  }
  return path.resolve(__dirname, '..', '..', '..', '.tmp', 'local-hosts');
}

function hostInstanceDir(id) {
  if (id === 'default') return localHostDir();
  return path.join(hostInstancesRoot(), id);
}

function hostInstanceConfigPath(id) {
  return path.join(hostInstanceDir(id), 'host.json');
}

function hostRuntime(id) {
  if (id === 'default') return localHost;
  let runtime = hostRuntimes.get(id);
  if (!runtime) {
    runtime = { child: null, startedAt: null, name: null, lastError: null, lines: [] };
    hostRuntimes.set(id, runtime);
  }
  return runtime;
}

function validHostId(raw) {
  const id = String(raw == null ? '' : raw).trim();
  if (id === 'default' || /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return id;
  throw new DirectoryError('validation', '无效的实例 ID');
}

function hostInstanceIds() {
  const ids = [];
  try {
    if (fs.existsSync(hostInstanceConfigPath('default'))) ids.push('default');
  } catch {
    /* ignore */
  }
  try {
    for (const entry of fs.readdirSync(hostInstancesRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!fs.existsSync(path.join(hostInstancesRoot(), entry.name, 'host.json'))) continue;
      ids.push(entry.name);
    }
  } catch {
    /* directory does not exist yet */
  }
  return ids;
}

function hostInstanceIdByAdminPort(port) {
  const wanted = Number(port);
  if (!Number.isInteger(wanted)) return null;
  for (const id of hostInstanceIds()) {
    const config = readHostConfig(id);
    if (config && Number(config.adminPort) === wanted) return id;
  }
  return null;
}

function readHostConfig(id) {
  try {
    const raw = fs.readFileSync(hostInstanceConfigPath(id), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeHostConfig(id, config) {
  const file = hostInstanceConfigPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
  return file;
}

function hostDisplayName(id, config) {
  return (config && config.name) || hostRuntime(id).name || id;
}

function hostIsJoined(config) {
  return Boolean(config && config.poolId && config.deviceId && config.deviceToken && config.pairSecret);
}

function hostAutoStart(id, config) {
  if (id === 'default') {
    // The global flag remains the source of truth for the legacy instance so a
    // stop from either the old sidebar or the new settings window is respected.
    return Boolean(
      state.config ? state.config.autoStartLocalHost : config && config.autoStart,
    );
  }
  return Boolean(config && config.autoStart);
}

function hostDshStatus(home) {
  if (!home) return { dshHomeExists: false, hasDshCredentials: false, hasDshApiKey: false, hasDshProfile: false };
  const credentialsPath = path.join(home, '.credentials.yaml');
  let hasDshCredentials = false;
  let hasDshApiKey = false;
  try {
    const raw = fs.readFileSync(credentialsPath, 'utf8');
    hasDshCredentials = raw.trim().length > 0;
    hasDshApiKey = /api[_-]?key|refs:/i.test(raw);
  } catch {
    /* DSH has not created its credentials yet */
  }
  let hasDshProfile = false;
  try {
    hasDshProfile = fs.existsSync(path.join(home, 'profiles'));
  } catch {
    /* ignore */
  }
  return {
    dshHomeExists: fs.existsSync(home),
    hasDshCredentials,
    hasDshApiKey,
    hasDshProfile,
  };
}

function hostSummary(id) {
  const config = readHostConfig(id);
  const runtime = hostRuntime(id);
  const joined = hostIsJoined(config);
  const dshStatus = hostDshStatus(config && config.dshHome);
  const liveDevice =
    config && config.deviceId
      ? (state.devices || []).find((device) => device.id === config.deviceId)
      : null;
  const status = (liveDevice && liveDevice.status) || (config && config.status) || (joined ? 'active' : 'left');
  return {
    id,
    name: hostDisplayName(id, config),
    running: Boolean(runtime.child),
    startedAt: runtime.startedAt,
    lastError: runtime.lastError,
    logs: runtime.lines.slice(-30),
    configPath: hostInstanceConfigPath(id),
    dshHome: (config && config.dshHome) || null,
    ...dshStatus,
    dshBin: (config && config.dshBin) || null,
    nodeBin: (config && config.nodeBin) || null,
    adminPort: (config && config.adminPort) || null,
    dshPort: (config && config.dshPort) || null,
    publicUrl: (config && config.publicUrl) || null,
    joined,
    poolId: (config && config.poolId) || null,
    deviceId: (config && config.deviceId) || null,
    status,
    autoStart: hostAutoStart(id, config),
    isLegacy: id === 'default',
    canStart: joined && Boolean(config && config.dshBin),
  };
}

function hostDefaults() {
  const dshBin = detectDshBin();
  const nodeBin = detectNodeBin();
  const hostBin = runtimeHostBin();
  const ids = hostInstanceIds();
  const config = state.config || loadConfig();
  const hasPool = Boolean(config.poolId || config.hasPool);
  return {
    directoryUrl: config.directoryUrl || DEFAULT_DIRECTORY_URL,
    poolCode: config.joinCode || '',
    hasPool,
    isOwner: config.role === 'owner',
    dshBin,
    dshBinExists: Boolean(dshBin && fs.existsSync(dshBin)),
    nodeBin,
    nodeBinExists: Boolean(nodeBin && fs.existsSync(nodeBin)),
    hostBin,
    hostBinExists: fs.existsSync(hostBin),
    defaultName: `${os.hostname()}-dsh-${ids.length + 1}`,
    existingCount: ids.length,
  };
}

function hostManagerInfo() {
  return {
    instances: hostInstanceIds().map(hostSummary),
    defaults: hostDefaults(),
  };
}

function hostPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    server.once('error', () => finish(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => finish(true));
  });
}

async function hostPickPorts({ adminPort, dshPort } = {}) {
  const used = new Set();
  for (const id of hostInstanceIds()) {
    const config = readHostConfig(id);
    for (const port of [config && config.adminPort, config && config.dshPort]) {
      if (Number.isInteger(Number(port))) used.add(Number(port));
    }
  }
  let admin = Number(adminPort) || LOCAL_HOST_DEFAULTS.adminPort;
  let dsh = Number(dshPort) || LOCAL_HOST_DEFAULTS.dshPort;
  if (adminPort && used.has(admin)) throw new DirectoryError('port_in_use', `admin 端口 ${admin} 已被本机另一个实例使用`);
  if (dshPort && used.has(dsh)) throw new DirectoryError('port_in_use', `dsh 端口 ${dsh} 已被本机另一个实例使用`);
  while (admin <= 4600 && (used.has(admin) || !(await hostPortFree(admin)))) admin += 1;
  while (dsh <= 4600 && (used.has(dsh) || dsh === admin || !(await hostPortFree(dsh)))) dsh += 1;
  if (admin > 4600 || dsh > 4600) {
    throw new DirectoryError('port_in_use', '没有找到空闲端口，请手动指定 admin/dsh 端口');
  }
  return { adminPort: admin, dshPort: dsh };
}

function assertUniqueHostName(name, exceptId) {
  const wanted = String(name || '').trim().toLowerCase();
  for (const id of hostInstanceIds()) {
    if (id === exceptId) continue;
    const config = readHostConfig(id);
    if (config && String(config.name || '').trim().toLowerCase() === wanted) {
      throw new DirectoryError('host_name_taken', `已有同名实例「${name}」，请换一个名字`);
    }
  }
}

function setHostAutoStart(id, enabled) {
  const config = readHostConfig(id);
  if (config) {
    try {
      writeHostConfig(id, { ...config, autoStart: Boolean(enabled) });
    } catch (err) {
      console.warn(`[local-host] could not persist autoStart for ${id}:`, err && err.message);
    }
  }
  if (id === 'default' && state.config) {
    try {
      state.config = { ...state.config, autoStartLocalHost: Boolean(enabled) };
      saveConfig(state.config);
    } catch (err) {
      console.warn('[local-host] could not persist autoStart flag:', err && err.message);
    }
  }
}

function pushHostLog(id, line) {
  const runtime = hostRuntime(id);
  runtime.lines.push(line);
  if (runtime.lines.length > 200) runtime.lines.shift();
}

function launchHostSidecar(id, configPath, name) {
  const runtime = hostRuntime(id);
  const child = spawn(process.execPath, [runtimeHostBin(), 'run', '--config', configPath], {
    env: hostSpawnEnv(),
    cwd: PACKAGE_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runtime.child = child;
  runtime.startedAt = Date.now();
  runtime.name = name;
  runtime.lastError = null;
  const onLog = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) pushHostLog(id, line.trim());
    }
  };
  child.stdout.on('data', onLog);
  child.stderr.on('data', onLog);
  child.on('error', (err) => {
    runtime.lastError = err.message;
    if (runtime.child === child) runtime.child = null;
  });
  child.on('exit', (code) => {
    pushHostLog(id, `host sidecar exited (code=${code})`);
    if (runtime.child === child) runtime.child = null;
    updateTrayMenu();
  });
  pushHostLog(id, `sidecar running (pid=${child.pid})`);
  return child;
}

async function startHostInstance(rawId, options = {}) {
  if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：不能启动本机实例');
  if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
  const id = validHostId(rawId);
  const runtime = hostRuntime(id);
  if (runtime.child) throw new DirectoryError('host_running', '这个实例已经在运行，先停止再启动');

  const config = readHostConfig(id);
  if (!config) throw new DirectoryError('host_not_found', '实例不存在，请先在设置里创建');
  if (!hostIsJoined(config)) {
    throw new DirectoryError('host_not_joined', '这个实例还没有加入池，请先点「加入池」');
  }
  if (config.status === 'revoked') {
    throw new DirectoryError('host_revoked', '这个实例已被移出池，请先重新加入池');
  }
  const dshBin = String(options.dshBin || config.dshBin || detectDshBin()).trim();
  if (!dshBin || !fs.existsSync(dshBin)) {
    throw new DirectoryError('dsh_not_found', '找不到该实例的 DSH bin.js，请在高级设置里填写路径');
  }
  const nodeBin = String(options.nodeBin || config.nodeBin || detectNodeBin()).trim();
  if (!nodeBin || !fs.existsSync(nodeBin)) {
    throw new DirectoryError('node_not_found', '找不到 node.exe，请先安装 DeepSeek Harness');
  }
  const next = {
    ...config,
    dshBin,
    nodeBin,
    ...(options.publicUrl ? { publicUrl: String(options.publicUrl).trim() } : {}),
  };
  if (next.dshBin !== config.dshBin || next.nodeBin !== config.nodeBin || next.publicUrl !== config.publicUrl) {
    writeHostConfig(id, next);
  }
  runtime.lines = [];
  runtime.lastError = null;
  launchHostSidecar(id, hostInstanceConfigPath(id), hostDisplayName(id, next));
  setHostAutoStart(id, true);
  updateTrayMenu();
  setTimeout(() => {
    if (!SMOKE) refresh().catch(() => {});
  }, 1200);
  return hostSummary(id);
}

async function stopHostInstance(rawId) {
  const id = validHostId(rawId);
  const runtime = hostRuntime(id);
  const child = runtime.child;
  runtime.child = null;
  runtime.startedAt = null;
  try {
    if (child) child.kill();
  } catch (err) {
    console.warn('[local-host] kill failed:', err && err.message);
  }
  setHostAutoStart(id, false);
  await new Promise((resolve) => setTimeout(resolve, 400));
  updateTrayMenu();
  return hostSummary(id);
}

function copyDshCredentialsTo(sourceId, targetHome) {
  const source = validHostId(sourceId);
  const sourceConfig = readHostConfig(source);
  if (!sourceConfig || !sourceConfig.dshHome) {
    throw new DirectoryError('credentials_not_found', '来源实例没有可用的 DSH_HOME');
  }
  const sourceHome = sourceConfig.dshHome;
  const files = ['.credentials.yaml', '.anonymous-user-id'];
  let copied = 0;
  fs.mkdirSync(targetHome, { recursive: true });
  for (const name of files) {
    const from = path.join(sourceHome, name);
    const to = path.join(targetHome, name);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) continue; // never overwrite a target that already has DSH data
    fs.copyFileSync(from, to);
    copied += 1;
  }
  if (!copied) {
    throw new DirectoryError('credentials_not_found', '来源实例还没有 DSH 登录/API key 数据');
  }
  return copied;
}

async function createHostInstance(options = {}) {
  if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：不能创建本机实例');
  if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
  const config = state.config || loadConfig();
  const poolCode = normalizeJoinCode(options.poolCode || config.joinCode || '');
  if (!poolCode || poolCode.length !== 8) {
    throw new DirectoryError('validation', '需要 8 位池码；请先在主界面创建或加入一个池');
  }
  const name = String(options.name || hostDefaults().defaultName).trim().slice(0, 60);
  if (!name) throw new DirectoryError('validation', '请填写实例名称');
  assertUniqueHostName(name);
  const dshBin = String(options.dshBin || detectDshBin()).trim();
  if (!dshBin || !fs.existsSync(dshBin)) {
    throw new DirectoryError('dsh_not_found', '找不到 DSH 的 bin.js，请填写正确路径');
  }
  const nodeBin = String(options.nodeBin || detectNodeBin()).trim();
  if (!nodeBin || !fs.existsSync(nodeBin)) {
    throw new DirectoryError('node_not_found', '找不到 node.exe');
  }
  const id = `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = hostInstanceDir(id);
  const configPath = hostInstanceConfigPath(id);
  const dshHome = options.dshHome
    ? path.resolve(String(options.dshHome))
    : path.join(dir, 'dsh-home');
  const ports = await hostPickPorts(options);
  const publicUrl = String(options.publicUrl || '').trim() || `http://127.0.0.1:${ports.adminPort}`;

  fs.mkdirSync(dir, { recursive: true });
  const logs = [];
  const log = (line) => {
    logs.push(line);
    pushHostLog(id, line);
  };
  const initArgs = [
    runtimeHostBin(),
    'init',
    '--directory',
    config.directoryUrl || DEFAULT_DIRECTORY_URL,
    '--pool-code',
    poolCode,
    '--name',
    name,
    '--public-url',
    publicUrl,
    '--admin-port',
    String(ports.adminPort),
    '--dsh-port',
    String(ports.dshPort),
    '--dsh-home',
    dshHome,
    '--dsh-bin',
    dshBin,
    '--node-bin',
    nodeBin,
    '--config',
    configPath,
  ];
  log(`init ${name} -> ${config.directoryUrl || DEFAULT_DIRECTORY_URL}`);
  const init = await runHostCommand(initArgs, log);
  if (init.code !== 0) {
    hostRuntime(id).lastError = init.output.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new DirectoryError('host_init_failed', `创建实例失败：${hostRuntime(id).lastError || 'unknown error'}`);
  }
  const created = readHostConfig(id);
  if (!created) {
    throw new DirectoryError('host_init_failed', 'host init 成功但没有写出 host.json');
  }
  if (options.copyCredentialsFrom) {
    try {
      copyDshCredentialsTo(options.copyCredentialsFrom, dshHome);
      log(`copied DSH credentials from ${options.copyCredentialsFrom}`);
    } catch (err) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
  writeHostConfig(id, { ...created, autoStart: options.start !== false });
  if (options.start !== false) {
    await startHostInstance(id);
  }
  setTimeout(() => {
    if (!SMOKE) refresh().catch(() => {});
  }, 800);
  return hostSummary(id);
}

async function updateHostInstance(rawId, options = {}) {
  if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：不能修改本机实例');
  if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
  const id = validHostId(rawId);
  const config = readHostConfig(id);
  if (!config) throw new DirectoryError('host_not_found', '实例不存在');

  const next = { ...config };
  if (options.name !== undefined) {
    const name = String(options.name).trim();
    if (!name) throw new DirectoryError('validation', '请填写实例名称');
    if (name.length > 60) throw new DirectoryError('validation', '实例名称最多 60 个字符');
    assertUniqueHostName(name, id);
    next.name = name;
  }
  if (options.dshBin !== undefined) {
    const dshBin = String(options.dshBin).trim();
    if (!dshBin || !fs.existsSync(dshBin)) {
      throw new DirectoryError('dsh_not_found', 'DSH bin.js 不存在，请检查路径');
    }
    next.dshBin = dshBin;
  }
  if (options.nodeBin !== undefined) {
    const nodeBin = String(options.nodeBin).trim();
    if (!nodeBin || !fs.existsSync(nodeBin)) {
      throw new DirectoryError('node_not_found', 'node.exe 不存在，请检查路径');
    }
    next.nodeBin = nodeBin;
  }
  if (options.dshHome !== undefined) {
    const dshHome = String(options.dshHome).trim();
    if (!dshHome || !path.isAbsolute(dshHome)) {
      throw new DirectoryError('validation', 'DSH_HOME 必须是绝对路径');
    }
    next.dshHome = dshHome;
  }
  const adminPort = options.adminPort === undefined ? config.adminPort : Number(options.adminPort);
  const dshPort = options.dshPort === undefined ? config.dshPort : Number(options.dshPort);
  for (const [label, port] of [['admin', adminPort], ['dsh', dshPort]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new DirectoryError('validation', `无效的 ${label} 端口`);
    }
  }
  if (adminPort === dshPort) throw new DirectoryError('port_in_use', 'admin 和 dsh 端口不能相同');
  for (const otherId of hostInstanceIds()) {
    if (otherId === id) continue;
    const other = readHostConfig(otherId);
    if (!other) continue;
    if (Number(other.adminPort) === adminPort || Number(other.dshPort) === adminPort || Number(other.adminPort) === dshPort || Number(other.dshPort) === dshPort) {
      throw new DirectoryError('port_in_use', '端口已被本机另一个实例使用');
    }
  }
  next.adminPort = adminPort;
  next.dshPort = dshPort;
  if (options.publicUrl !== undefined) {
    const publicUrl = String(options.publicUrl).trim();
    if (publicUrl) {
      let parsed;
      try {
        parsed = new URL(publicUrl);
      } catch {
        throw new DirectoryError('validation', 'Public URL 不是合法地址');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new DirectoryError('validation', 'Public URL 必须是 http/https 地址');
      }
      next.publicUrl = publicUrl.replace(/\/+$/, '');
    } else {
      next.publicUrl = `http://127.0.0.1:${adminPort}`;
    }
  } else if (adminPort !== config.adminPort && String(config.publicUrl || '').includes('127.0.0.1')) {
    next.publicUrl = `http://127.0.0.1:${adminPort}`;
  }

  const runtime = hostRuntime(id);
  const wasRunning = Boolean(runtime.child);
  const wasAutoStart = hostAutoStart(id, config);
  if (wasRunning) await stopHostInstance(id);
  if (adminPort !== Number(config.adminPort) || dshPort !== Number(config.dshPort)) {
    if (!(await hostPortFree(adminPort)) || !(await hostPortFree(dshPort))) {
      if (wasRunning) await startHostInstance(id).catch(() => {});
      throw new DirectoryError('port_in_use', '新端口已被其他程序占用');
    }
  }
  writeHostConfig(id, next);
  if (wasRunning) {
    await startHostInstance(id);
    if (!wasAutoStart) setHostAutoStart(id, false);
  } else {
    setHostAutoStart(id, wasAutoStart);
  }
  updateTrayMenu();
  setTimeout(() => {
    if (!SMOKE) refresh().catch(() => {});
  }, 800);
  return hostSummary(id);
}

let runtimeInstallPromise = null;

function runtimeRootDir() {
  return path.join(app.getPath('userData'), 'runtime');
}

function installRuntimeScript() {
  return `param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Version
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$nodeDir = Join-Path $Root 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'
$npmCmd = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path $nodeExe) -or -not (Test-Path $npmCmd)) {
  $zip = Join-Path $Root 'node.zip'
  Write-Output 'NODE_DOWNLOAD https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip' -OutFile $zip
  Write-Output 'NODE_EXTRACT'
  Remove-Item -LiteralPath $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $zip -DestinationPath $nodeDir -Force
  $inner = Get-ChildItem -LiteralPath $nodeDir -Directory | Where-Object { $_.Name -like 'node-v*-win-x64' } | Select-Object -First 1
  if ($inner) {
    Get-ChildItem -LiteralPath $inner.FullName | Move-Item -Destination $nodeDir -Force
    Remove-Item -LiteralPath $inner.FullName -Recurse -Force
  }
  Remove-Item -LiteralPath $zip -Force
}
if (-not (Test-Path $nodeExe)) { throw "node.exe install failed: $nodeExe" }
if (-not (Test-Path $npmCmd)) { throw "npm.cmd not found in Node zip: $npmCmd" }
$dshRoot = Join-Path $Root 'dsh'
New-Item -ItemType Directory -Force -Path $dshRoot | Out-Null
Write-Output "DSH_INSTALL @deepseek-ai/dsh@$Version"
& $npmCmd install --prefix $dshRoot --no-audit --no-fund "@deepseek-ai/dsh@$Version" 2>&1 | ForEach-Object { Write-Output $_ }
$dshBin = Join-Path $dshRoot 'node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
if (-not (Test-Path $dshBin)) { throw "dsh bin.js not found: $dshBin" }
@{ nodeBin = $nodeExe; dshBin = $dshBin; npm = $npmCmd; version = $Version } |
  ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $Root 'install-result.json') -Encoding utf8
Write-Output 'DONE'
`;
}

async function installDshRuntime() {
  if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：不能安装运行时');
  if (runtimeInstallPromise) return runtimeInstallPromise;
  runtimeInstallPromise = (async () => {
    const root = runtimeRootDir();
    fs.mkdirSync(root, { recursive: true });
    const scriptPath = path.join(root, 'install-dsh-runtime.ps1');
    fs.writeFileSync(scriptPath, installRuntimeScript(), 'utf8');
    const version = String(process.env.MULTIDSH_DSH_VERSION || '0.2.1-rc.2').trim();
    const resultPath = path.join(root, 'install-result.json');
    try { fs.rmSync(resultPath, { force: true }); } catch { /* ignore */ }
    sendToRenderer('fleet:runtimeProgress', { line: '准备下载 Node 24（约 30 MB）…' });
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Root', root, '-Version', version],
      { windowsHide: true },
    );
    const collect = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) sendToRenderer('fleet:runtimeProgress', { line: line.trim() });
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const code = await new Promise((resolve) => child.on('close', resolve));
    if (code !== 0) throw new DirectoryError('runtime_install_failed', `安装失败（PowerShell 退出码 ${code}）`);
    let result;
    try {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw new DirectoryError('runtime_install_failed', '安装结束但没有生成结果文件');
    }
    if (!result.dshBin || !fs.existsSync(result.dshBin)) {
      throw new DirectoryError('runtime_install_failed', '安装完成但找不到 DSH bin.js');
    }
    sendToRenderer('fleet:runtimeProgress', { line: '安装完成' });
    setTimeout(() => { if (!SMOKE) refresh().catch(() => {}); }, 300);
    return {
      dshBin: result.dshBin,
      nodeBin: result.nodeBin,
      npm: result.npm,
      version,
    };
  })().finally(() => {
    runtimeInstallPromise = null;
  });
  return runtimeInstallPromise;
}

async function joinHostInstance(rawId, options = {}) {
  if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：不能加入池');
  if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
  const id = validHostId(rawId);
  const config = readHostConfig(id);
  if (!config) throw new DirectoryError('host_not_found', '实例不存在');
  if (hostIsJoined(config) && config.status !== 'left' && config.status !== 'revoked') {
    throw new DirectoryError('host_already_joined', '这个实例已经在池中；如需重新加入，请先「脱离池」');
  }
  const appConfig = state.config || loadConfig();
  const poolCode = normalizeJoinCode(options.poolCode || appConfig.joinCode || '');
  if (!poolCode || poolCode.length !== 8) {
    throw new DirectoryError('validation', '需要 8 位池码；请先在主界面创建或加入一个池');
  }
  if (hostRuntime(id).child) await stopHostInstance(id);
  const dshBin = String(config.dshBin || detectDshBin()).trim();
  const nodeBin = String(config.nodeBin || detectNodeBin()).trim();
  const logs = [];
  const init = await runHostCommand(
    [
      runtimeHostBin(),
      'init',
      '--directory',
      appConfig.directoryUrl || config.directoryUrl || DEFAULT_DIRECTORY_URL,
      '--pool-code',
      poolCode,
      '--name',
      hostDisplayName(id, config),
      '--public-url',
      config.publicUrl || `http://127.0.0.1:${config.adminPort}`,
      '--admin-port',
      String(config.adminPort),
      '--dsh-port',
      String(config.dshPort),
      '--dsh-home',
      config.dshHome || path.join(hostInstanceDir(id), 'dsh-home'),
      '--dsh-bin',
      dshBin,
      '--node-bin',
      nodeBin,
      '--config',
      hostInstanceConfigPath(id),
    ],
    (line) => {
      logs.push(line);
      pushHostLog(id, line);
    },
  );
  if (init.code !== 0) {
    hostRuntime(id).lastError = init.output.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    throw new DirectoryError('host_init_failed', `加入池失败：${hostRuntime(id).lastError || 'unknown error'}`);
  }
  writeHostConfig(id, { ...(readHostConfig(id) || {}), autoStart: true });
  await startHostInstance(id);
  return hostSummary(id);
}

async function revokeHostDevice(config) {
  const appConfig = state.config || loadConfig();
  if (
    !config ||
    !config.poolId ||
    !config.deviceId ||
    !appConfig ||
    appConfig.role !== 'owner' ||
    appConfig.poolId !== config.poolId ||
    !appConfig.deviceToken
  ) {
    return { revoked: false, warning: '已在本机脱离；云端设备记录需要池主在设备列表里移除。' };
  }
  try {
    await new DirectoryClient(config.directoryUrl || appConfig.directoryUrl).revokeDevice(
      config.poolId,
      appConfig.deviceToken,
      config.deviceId,
    );
    return { revoked: true, warning: null };
  } catch (err) {
    return { revoked: false, warning: `云端移除失败：${err && err.message ? err.message : err}` };
  }
}

async function leaveHostInstance(rawId) {
  if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：不能脱离池');
  if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
  const id = validHostId(rawId);
  const config = readHostConfig(id);
  if (!config) throw new DirectoryError('host_not_found', '实例不存在');
  if (hostRuntime(id).child) await stopHostInstance(id);
  setHostAutoStart(id, false);
  const removal = await revokeHostDevice(config);
  writeHostConfig(id, {
    ...config,
    poolId: null,
    deviceId: null,
    deviceToken: null,
    pairSecret: null,
    status: 'left',
    autoStart: false,
    leftAt: Date.now(),
  });
  updateTrayMenu();
  try {
    await refresh();
  } catch {
    /* keep the local detach even if the Directory is offline */
  }
  return { ...hostSummary(id), ...removal };
}

async function deleteHostInstance(rawId) {
  if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：不能删除实例');
  if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
  const id = validHostId(rawId);
  const config = readHostConfig(id);
  if (!config) throw new DirectoryError('host_not_found', '实例不存在');
  if (hostRuntime(id).child) await stopHostInstance(id);
  const removal = await revokeHostDevice(config);
  const dir = hostInstanceDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
  hostRuntimes.delete(id);
  if (id === 'default' && state.config) {
    state.config = { ...state.config, autoStartLocalHost: false };
    saveConfig(state.config);
  }
  updateTrayMenu();
  try {
    await refresh();
  } catch {
    /* keep the local delete even if the Directory is offline */
  }
  return { deleted: true, id, ...removal };
}

async function resumeAllHostInstances() {
  if (SMOKE || LIVE_SMOKE || demoActive) return;
  for (const id of hostInstanceIds()) {
    const config = readHostConfig(id);
    if (!config || !hostIsJoined(config)) continue;
    if (!hostAutoStart(id, config)) continue;
    if (config.status === 'revoked') continue;
    try {
      await startHostInstance(id);
    } catch (err) {
      hostRuntime(id).lastError = err && err.message ? err.message : String(err);
      console.warn(`[local-host] resume "${id}" failed:`, hostRuntime(id).lastError);
    }
  }
  updateTrayMenu();
  if (hostInstanceIds().some((id) => hostRuntime(id).child)) {
    setTimeout(() => {
      refresh().catch(() => {});
    }, 1500);
  }
}

/** Forget the pool session locally (does not call the Directory). */
function clearPoolSession(config) {
  return {
    ...config,
    poolId: null,
    deviceId: null,
    deviceToken: null,
    poolName: null,
    role: null,
    joinCode: null,
    joinCodeExpiresAt: null,
    selfStatus: null,
  };
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const state = {
  config: null,
  window: null,
  settingsWindow: null,
  hostView: null,
  /** hostId -> detached-but-alive WebContentsView (LRU, see hostViewCacheSize). */
  hostViews: new Map(),
  host: null, // { id, name, url, online }
  devices: [],
  health: { ok: false, checkedAt: 0, error: null },
  authPending: false,
  authError: null,
  sidebarCollapsed: false,
  tray: null,
  quitting: false,
  lastRefreshAt: 0,
  refreshing: false,
  refreshPromise: null,
  pollTimer: null,
  smoke: { captured: false, finished: false, exitCode: 0, screenshot: null },
};

// ---------------------------------------------------------------------------
// Snapshot (the single shape the renderer renders)
// ---------------------------------------------------------------------------

function composeSnapshot(input) {
  const {
    config,
    devices = [],
    health = null,
    authPending = false,
    authError = null,
    refreshing = false,
    lastRefreshAt = 0,
    smoke = false,
    simulated = false,
    demo = false,
    activeHostId = null,
  } = input;
  const now = Date.now();
  const list = Array.isArray(devices) ? devices.filter((d) => d && typeof d === 'object') : [];
  const active = list.filter((d) => d.status === 'active');
  const hosts = active.filter((d) => d.kind === 'host');
  const onlineHosts = hosts.filter((d) => isOnline(d, now));
  const offlineHosts = hosts.filter((d) => !isOnline(d, now));
  const pendingDevices = config.role === 'owner' ? list.filter((d) => d.status === 'pending') : [];
  const self = list.find((d) => d.id === config.deviceId) || null;
  const isOwner = config.role === 'owner';
  const hasPool = Boolean(config.poolId && config.deviceToken);

  return {
    version: VERSION,
    smoke,
    simulated,
    demo,
    activeHostId,
    now,
    config: {
      directoryUrl: config.directoryUrl,
      deviceName: config.deviceName,
      deviceId: config.deviceId,
      poolId: config.poolId,
      poolName: config.poolName,
      role: config.role,
      isOwner,
      hasPool,
      theme: config.theme === 'dark' ? 'dark' : 'light',
      hostViewCacheSize: Number.isInteger(config.hostViewCacheSize) ? config.hostViewCacheSize : 3,
      joinCode: isOwner ? config.joinCode || null : null,
      joinCodeExpiresAt: isOwner ? config.joinCodeExpiresAt || null : null,
      selfStatus: (self && self.status) || config.selfStatus || null,
    },
    pool: hasPool
      ? {
          id: config.poolId,
          name: config.poolName,
          role: config.role,
          joinCode: isOwner ? config.joinCode || null : null,
          joinCodeExpiresAt: isOwner ? config.joinCodeExpiresAt || null : null,
        }
      : null,
    health: health || { ok: false, checkedAt: 0, error: null },
    authPending,
    authError,
    devices: list,
    onlineHosts,
    offlineHosts,
    pendingDevices,
    self,
    lastRefreshAt,
    refreshing,
  };
}

function applyLocalHostNames(devices) {
  if (!Array.isArray(devices)) return devices;
  for (const id of hostInstanceIds()) {
    const config = readHostConfig(id);
    if (!config || !config.deviceId || !config.name) continue;
    const device = devices.find((entry) => entry.id === config.deviceId);
    if (device && device.name !== config.name) device.name = config.name;
  }
  return devices;
}

function buildSnapshot() {
  return composeSnapshot({
    config: state.config || loadConfig(),
    devices: state.devices,
    health: state.health,
    authPending: state.authPending,
    authError: state.authError,
    refreshing: state.refreshing,
    lastRefreshAt: state.lastRefreshAt,
    smoke: SMOKE,
    simulated: SMOKE || demoActive,
    demo: demoActive,
    activeHostId: state.host ? state.host.id : null,
  });
}

function broadcastState() {
  const snapshot = buildSnapshot();
  for (const win of [state.window, state.settingsWindow]) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send('fleet:state', snapshot);
    } catch (err) {
      console.warn('[ipc] broadcast failed:', err && err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Smoke demo data (screenshot only; nothing is persisted or sent anywhere)
// ---------------------------------------------------------------------------

function demoDevice(overrides) {
  const now = Date.now();
  return {
    id: 'dev_demo00000001',
    poolId: 'pool_demo00000001',
    kind: 'host',
    role: 'member',
    name: 'host',
    platform: 'win32',
    version: '0.1.0',
    status: 'active',
    createdAt: now - 3 * 86400000,
    approvedAt: now - 3 * 86400000,
    lastSeenAt: now - 5000,
    publicUrl: 'http://127.0.0.1:4092',
    machineId: null,
    machineName: null,
    health: { runningSessions: 0, dshPort: 3080 },
    meta: {},
    ...overrides,
  };
}

function demoGuardMessage() {
  return '演示模式：当前是示例数据。请在 设置 → 演示模式 中退出后再操作。';
}

/** Shared sample data for the smoke screenshot and the first-run demo tour. */
function demoFixture() {
  const now = Date.now();
  const saved = loadConfig();
  const config = {
    ...DEFAULT_CONFIG,
    theme: saved.theme,
    directoryUrl: DEFAULT_DIRECTORY_URL,
    poolId: 'pool_demo00000001',
    poolName: '家庭主机池（演示）',
    role: 'owner',
    deviceId: 'dev_demo0000self',
    deviceToken: 'mdt_demo',
    deviceName: defaultDeviceName(),
    joinCode: '7K3M9Q2X',
    joinCodeExpiresAt: now + 20 * 3600 * 1000,
    selfStatus: 'active',
  };
  const devices = [
    demoDevice({
      id: 'dev_demo0000self',
      kind: 'client',
      role: 'owner',
      name: 'user-win',
      platform: 'win32',
      lastSeenAt: now - 2000,
      publicUrl: undefined,
    }),
    demoDevice({
      id: 'dev_demo00000001',
      name: 'dsh-main',
      machineId: 'machine_demo_desktop',
      machineName: 'user-desktop',
      platform: 'win32',
      lastSeenAt: now - 4200,
      health: { runningSessions: null, dshPort: 3080, dshRunning: true },
    }),
    demoDevice({
      id: 'dev_demo00000002',
      name: 'dsh-purge',
      machineId: 'machine_demo_desktop',
      machineName: 'user-desktop',
      platform: 'win32',
      lastSeenAt: now - 18000,
      health: { runningSessions: null, dshPort: 3281, dshRunning: false },
    }),
    demoDevice({
      id: 'dev_demo00000003',
      name: 'dsh-gpu',
      machineId: 'machine_demo_l40',
      machineName: 'GPU-L40',
      platform: 'linux',
      lastSeenAt: now - 3 * 3600 * 1000,
    }),
    demoDevice({
      id: 'dev_demo00000004',
      name: 'win-02 · 卧室',
      machineId: 'machine_demo_bedroom',
      machineName: 'bedroom-pc',
      platform: 'win32',
      status: 'pending',
      approvedAt: null,
      lastSeenAt: now - 6000,
      publicUrl: undefined,
    }),
    demoDevice({
      id: 'dev_demo00000005',
      kind: 'client',
      name: 'ipad · 客厅',
      platform: 'darwin',
      status: 'pending',
      approvedAt: null,
      lastSeenAt: now - 24000,
      publicUrl: undefined,
    }),
  ];
  return {
    config,
    devices,
    health: { ok: true, checkedAt: now, app: APP_NAME, protocol: 1, error: null },
    now,
  };
}

function smokeSnapshot() {
  const smokeTheme = process.env.MULTIDSH_SMOKE_THEME === 'light' ? 'light' : null;
  if (!SMOKE_DEMO) {
    const config = { ...loadConfig(), ...(smokeTheme ? { theme: smokeTheme } : {}) };
    return composeSnapshot({
      config,
      devices: [],
      health: { ok: false, checkedAt: 0, error: null },
      smoke: true,
      simulated: false,
    });
  }
  const fixture = demoFixture();
  return composeSnapshot({
    config: { ...fixture.config, ...(smokeTheme ? { theme: smokeTheme } : {}) },
    devices: fixture.devices,
    health: fixture.health,
    smoke: true,
    simulated: true,
    lastRefreshAt: fixture.now,
  });
}

/**
 * Swap the live state for the sample-data tour. No network calls happen while
 * demoActive is true (refresh() short-circuits), so the tour works offline.
 */
function enterDemo() {
  const fixture = demoFixture();
  demoActive = true;
  state.config = fixture.config;
  state.devices = fixture.devices;
  state.health = fixture.health;
  state.authPending = false;
  state.authError = null;
  state.lastRefreshAt = fixture.now;
  console.log(
    `[demo] sample tour active: pool=${fixture.config.poolId} devices=${fixture.devices.length} (offline, no network)`,
  );
}

/** Leave the tour; the next launch starts on the real onboarding screen. */
function exitDemo() {
  demoActive = false;
  const config = { ...loadConfig(), demoDismissed: true };
  state.config = config;
  saveConfig(config);
  state.devices = [];
  state.health = { ok: false, checkedAt: 0, error: null };
  state.authPending = false;
  state.authError = null;
  state.lastRefreshAt = 0;
  broadcastState();
  refresh();
  return { demo: false };
}

// ---------------------------------------------------------------------------
// Host view (right side, 300px to the right of the sidebar)
// ---------------------------------------------------------------------------

function applyHostBounds() {
  const win = state.window;
  const view = state.hostView;
  if (!win || win.isDestroyed() || !view) return;
  const [width, height] = win.getContentSize();
  const sidebarWidth = state.sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
  view.setBounds({
    x: sidebarWidth,
    y: 0,
    width: Math.max(0, width - sidebarWidth),
    height: Math.max(0, height),
  });
}

function sendToRenderer(channel, payload) {
  for (const win of [state.window, state.settingsWindow]) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* window is going away */
    }
  }
}

/**
 * Host views are cached instead of destroyed.
 *
 * Closing a host (or switching to another host) detaches its WebContentsView
 * from the window but keeps the renderer alive, so reopening the same host
 * skips renderer boot, the ~13 MiB DSH bundle parse and the WebSocket
 * handshake (measured 1.7-4.6 s per reopen before). A live page costs roughly
 * 100-200 MB, so the number of views is bounded by `hostViewCacheSize`
 * (1-6, default 3, editable in Settings) and evicted least-recently-used first.
 */
function hostViewCacheSize() {
  const raw = Number(state.config ? state.config.hostViewCacheSize : DEFAULT_CONFIG.hostViewCacheSize);
  return Number.isInteger(raw) ? Math.min(6, Math.max(1, raw)) : DEFAULT_CONFIG.hostViewCacheSize;
}

function viewIsUsable(view) {
  if (!view || view.__multidshDead) return false;
  try {
    const wc = view.webContents;
    return Boolean(wc) && !wc.isDestroyed();
  } catch {
    return false;
  }
}

function attachHostView(view) {
  const win = state.window;
  if (!win || win.isDestroyed() || !view) return;
  try {
    if (HAS_WEB_CONTENTS_VIEW) win.contentView.addChildView(view);
    else if (HAS_BROWSER_VIEW) win.setBrowserView(view);
  } catch (err) {
    console.warn('[host] failed to attach view:', err && err.message);
  }
}

function detachHostView(view) {
  const win = state.window;
  if (!win || win.isDestroyed() || !view) return;
  try {
    if (HAS_WEB_CONTENTS_VIEW) win.contentView.removeChildView(view);
    else if (HAS_BROWSER_VIEW) win.setBrowserView(null);
  } catch (err) {
    console.warn('[host] failed to detach view:', err && err.message);
  }
}

function destroyHostView(view) {
  if (!view) return;
  view.__multidshDead = true;
  detachHostView(view);
  try {
    if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
  } catch (err) {
    console.warn('[host] failed to close webContents:', err && err.message);
  }
}

/** Mark a cached view as most recently used (Map keeps insertion order). */
function touchHostView(hostId, view) {
  if (!hostId || !view) return;
  state.hostViews.delete(hostId);
  state.hostViews.set(hostId, view);
}

function evictHostViews() {
  const limit = hostViewCacheSize();
  while (state.hostViews.size > limit) {
    let victimId = null;
    for (const [id, view] of state.hostViews) {
      if (view === state.hostView) continue;
      victimId = id;
      break;
    }
    if (!victimId) return;
    const victim = state.hostViews.get(victimId);
    state.hostViews.delete(victimId);
    destroyHostView(victim);
  }
}

/** Hard-close one host's page and forget it (used on failures / pool changes). */
function discardHostView(rawHostId) {
  const hostId = rawHostId || (state.host && state.host.id) || null;
  if (!hostId) return;
  const view = state.hostViews.get(hostId) || null;
  state.hostViews.delete(hostId);
  if (view && view === state.hostView) state.hostView = null;
  if (view) destroyHostView(view);
  if (state.host && state.host.id === hostId) state.host = null;
  broadcastState();
}

function destroyAllHostViews() {
  const views = new Set(state.hostViews.values());
  if (state.hostView) views.add(state.hostView);
  const hadHost = Boolean(state.host);
  state.hostViews.clear();
  state.hostView = null;
  state.host = null;
  for (const view of views) destroyHostView(view);
  if (hadHost) broadcastState();
}

function safeWebContentsUrl(view) {
  if (!viewIsUsable(view)) return null;
  try {
    const url = view.webContents.getURL();
    return url && url !== 'about:blank' ? url : null;
  } catch {
    return null;
  }
}

function createHostView() {
  const win = state.window;
  if (!win || win.isDestroyed()) throw new DirectoryError('host_view_unavailable', '窗口已关闭');

  const webPreferences = {
    partition: HOST_PARTITION,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };

  let view;
  if (HAS_WEB_CONTENTS_VIEW) {
    view = new WebContentsView({ webPreferences });
  } else if (HAS_BROWSER_VIEW) {
    view = new BrowserView({ webPreferences });
  } else {
    throw new DirectoryError('host_view_unavailable', '当前 Electron 版本不支持内嵌主机视图');
  }

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = aborted (redirects)
    console.warn(`[host] load failed (${errorCode} ${errorDescription}): ${validatedURL}`);
    const friendly =
      errorCode === -102 /* ERR_CONNECTION_REFUSED */
        ? '无法连接主机（连接被拒绝）：主机可能已离线，或本机主机侧车没有启动。请刷新设备列表后重试，或在 设置 → 本机主机 里启动。'
        : `主机界面加载失败：${errorDescription || `错误 ${errorCode}`}`;
    sendToRenderer('fleet:hostError', { message: friendly, url: validatedURL });
    // Don't leave Chromium's raw error page in the embedded view.
    setTimeout(() => {
      const hostId = state.host && state.host.id;
      if (hostId) {
        discardHostView(hostId);
        sendToRenderer('fleet:hostClosed', {});
      }
    }, 0);
  });
  wc.on('render-process-gone', (_event, details) => {
    view.__multidshDead = true;
    console.warn('[host] renderer gone:', details && details.reason);
    sendToRenderer('fleet:hostError', { message: `主机界面进程异常退出（${(details && details.reason) || 'unknown'}）` });
  });

  return view;
}

/**
 * Reuse the live page for `hostId` when there is one, otherwise create a view.
 * A view that is still attached to the window is returned as-is; a cached one
 * is re-attached in place of the currently shown view.
 */
function getOrCreateHostView(hostId) {
  const cached = hostId ? state.hostViews.get(hostId) : null;
  if (cached && !viewIsUsable(cached)) {
    state.hostViews.delete(hostId);
  } else if (cached) {
    if (state.hostView !== cached) {
      if (state.hostView) detachHostView(state.hostView);
      attachHostView(cached);
      state.hostView = cached;
    }
    touchHostView(hostId, cached);
    evictHostViews();
    applyHostBounds();
    return cached;
  }

  if (state.hostView) {
    // Keep the page that is on screen now in the LRU instead of destroying it.
    detachHostView(state.hostView);
    if (state.host && state.host.id) touchHostView(state.host.id, state.hostView);
  }
  const view = createHostView();
  attachHostView(view);
  state.hostView = view;
  if (hostId) {
    state.hostViews.set(hostId, view);
    evictHostViews();
  }
  applyHostBounds();
  return view;
}

/**
 * Navigate and report the final HTTP status. `loadURL` resolves for 4xx/5xx
 * responses too, so the status is what tells a valid page from "401 no cookie"
 * or "503 DSH still starting".
 */
function navigateHostView(view, url) {
  const wc = view.webContents;
  return new Promise((resolve) => {
    let httpCode = null;
    let lastUrl = url;
    const onNavigate = (_event, navUrl, httpResponseCode) => {
      if (typeof httpResponseCode === 'number' && httpResponseCode > 0) httpCode = httpResponseCode;
      if (navUrl) lastUrl = navUrl;
    };
    const finish = (result) => {
      try {
        wc.off('did-navigate', onNavigate);
      } catch {
        /* ignore */
      }
      resolve({ ...result, code: httpCode, url: lastUrl });
    };
    wc.on('did-navigate', onNavigate);
    wc.loadURL(url).then(
      () => finish({ ok: httpCode === null || httpCode < 400 }),
      (err) => finish({ ok: false, error: err }),
    );
  });
}

function describeHostLoadFailure(result) {
  const code = result && result.code;
  if (code === 503) return '主机正在启动（DSH 尚未就绪），请等几秒后重试。';
  if (code === 401 || code === 403) return '主机拒绝了登录请求，请重试；如持续失败请刷新设备列表。';
  if (code === 502 || code === 504) return '主机暂时不可达（隧道或本机侧车没有响应），请稍后重试。';
  const message = result && result.error && result.error.message;
  return `无法加载主机界面：${message || (code ? `HTTP ${code}` : '未知错误')}`;
}

/**
 * Close the host page but keep it alive in the LRU cache, so the next open of
 * this host is instant. See discardHostView() for the hard close.
 */
function closeHostView() {
  const view = state.hostView;
  const hostId = state.host && state.host.id;
  state.hostView = null;
  state.host = null;
  broadcastState();
  if (!view) return;
  detachHostView(view);
  if (hostId) {
    touchHostView(hostId, view);
    evictHostViews();
  } else if (view) {
    destroyHostView(view);
  }
}

// ---------------------------------------------------------------------------
// Directory operations
// ---------------------------------------------------------------------------

function requireConfig() {
  if (!state.config) state.config = loadConfig();
  return state.config;
}

function requireOwner() {
  const config = requireConfig();
  if (!config.poolId || !config.deviceToken) throw new DirectoryError('no_pool', '尚未加入任何池');
  if (config.role !== 'owner') throw new DirectoryError('forbidden', '只有池主可以管理设备');
  return config;
}

function client() {
  return new DirectoryClient(requireConfig().directoryUrl);
}

/** Refresh health + device list. Never throws: failures are stored in state. */
function refresh() {
  if (demoActive) {
    // Demo tour is offline by design: never touch the network.
    state.lastRefreshAt = Date.now();
    broadcastState();
    return Promise.resolve(buildSnapshot());
  }
  if (state.refreshPromise) return state.refreshPromise;
  state.refreshing = true;
  state.refreshPromise = doRefresh()
    .catch((err) => {
      console.error('[refresh] unexpected failure:', err);
    })
    .finally(() => {
      state.refreshing = false;
      state.refreshPromise = null;
      state.lastRefreshAt = Date.now();
      broadcastState();
    });
  return state.refreshPromise;
}

async function doRefresh() {
  const config = requireConfig();
  const api = new DirectoryClient(config.directoryUrl);

  // health and devices are independent requests: fire both at once instead of
  // paying a full Directory round trip twice (measured ~90-115 ms saved per
  // refresh; refresh happens on startup, on focus and every 30 s).
  const healthTask = (async () => {
    try {
      const health = await api.health();
      const healthy = Boolean(health && health.ok !== false);
      state.health = {
        ok: healthy,
        checkedAt: Date.now(),
        app: (health && health.app) || null,
        protocol: (health && health.protocol) || null,
        error: healthy ? null : 'Directory 健康检查失败',
      };
    } catch (err) {
      const info = errorForRenderer(err);
      state.health = { ok: false, checkedAt: Date.now(), error: info.message };
    }
  })();

  if (!config.poolId || !config.deviceToken) {
    await healthTask;
    state.devices = [];
    state.authPending = false;
    state.authError = null;
    return;
  }

  const devicesTask = (async () => {
    try {
      const result = await api.listDevices(config.poolId, config.deviceToken, {
        includePending: config.role === 'owner',
      });
      const devices = result && Array.isArray(result.devices) ? result.devices : [];
      state.devices = applyLocalHostNames(devices);
      state.authPending = false;
      state.authError = null;
      const self = devices.find((device) => device.id === config.deviceId);
      if (self && self.status && self.status !== config.selfStatus) {
        config.selfStatus = self.status;
        saveConfig(config);
      }
    } catch (err) {
      const info = errorForRenderer(err);
      const unauthorized = err && (err.status === 401 || err.status === 403);
      if (unauthorized) {
        if (config.selfStatus === 'pending' || state.authPending) {
          state.authPending = true;
          state.authError = null;
        } else if (info.code === 'device_revoked') {
          state.authPending = false;
          state.authError = { code: 'revoked', message: '本设备已被移出该池' };
        } else {
          state.authPending = false;
          state.authError = info;
        }
      } else if (info.code !== 'network' && info.code !== 'timeout') {
        state.authError = info;
        state.authPending = false;
      }
      // Network/offline errors are already surfaced through state.health.
    }
  })();

  await Promise.all([healthTask, devicesTask]);
}

async function setDirectory(rawUrl) {
  const config = requireConfig();
  const nextUrl = normalizeBaseUrl(rawUrl);
  if (nextUrl === config.directoryUrl) {
    await refresh();
    return buildSnapshot();
  }
  const hadPool = Boolean(config.poolId);
  state.config = clearPoolSession({ ...config, directoryUrl: nextUrl });
  saveConfig(state.config);
  state.devices = [];
  state.authPending = false;
  state.authError = null;
  state.health = { ok: false, checkedAt: 0, error: null };
  state.lastRefreshAt = 0;
  destroyAllHostViews();
  sendToRenderer('fleet:hostClosed', {});
  await refresh();
  if (hadPool) console.log('[config] directory changed, local pool session cleared');
  return buildSnapshot();
}

async function createPool(rawName, rawCreateKey) {
  const config = requireConfig();
  if (config.poolId) throw new DirectoryError('already_in_pool', '已在一个池中，请先离开当前池');
  const name = String(rawName == null ? '' : rawName).trim();
  if (!name) throw new DirectoryError('validation', '请输入池名称');
  if (name.length > 60) throw new DirectoryError('validation', '池名称最多 60 个字符');
  const createPoolKey = String(rawCreateKey == null ? config.createPoolKey || '' : rawCreateKey).trim();

  const result = await new DirectoryClient(config.directoryUrl).createPool({
    name,
    deviceName: config.deviceName,
    platform: process.platform,
    createKey: createPoolKey,
  });
  if (!result || !result.pool || !result.device || !result.deviceToken) {
    throw new DirectoryError('bad_response', 'Directory 返回的创建结果不完整');
  }

  state.config = {
    ...config,
    createPoolKey: createPoolKey || config.createPoolKey || null,
    poolId: result.pool.id,
    poolName: result.pool.name || name,
    deviceId: result.device.id,
    deviceToken: result.deviceToken,
    role: 'owner',
    joinCode: result.pool.joinCode || null,
    joinCodeExpiresAt: result.pool.joinCodeExpiresAt || null,
    selfStatus: result.device.status || 'active',
  };
  saveConfig(state.config);
  state.devices = [result.device];
  state.authPending = false;
  state.authError = null;
  await refresh();
  return buildSnapshot();
}

async function joinPool(rawCode) {
  const config = requireConfig();
  if (config.poolId) throw new DirectoryError('already_in_pool', '已在一个池中，请先离开当前池');
  const code = normalizeJoinCode(rawCode);
  if (code.length !== 8) throw new DirectoryError('validation', '池码应为 8 位字符');

  const result = await new DirectoryClient(config.directoryUrl).joinPool({
    code,
    name: config.deviceName,
    platform: process.platform,
    kind: 'client',
    version: VERSION,
  });
  if (!result || !result.device || !result.deviceToken) {
    throw new DirectoryError('bad_response', 'Directory 返回的加入结果不完整');
  }

  state.config = {
    ...config,
    poolId: result.device.poolId || result.poolId || null,
    deviceId: result.device.id,
    deviceToken: result.deviceToken,
    role: 'member',
    joinCode: null,
    joinCodeExpiresAt: null,
    selfStatus: result.device.status || 'pending',
  };
  saveConfig(state.config);
  state.devices = [result.device];
  state.authPending = state.config.selfStatus === 'pending';
  state.authError = null;
  await refresh();
  return buildSnapshot();
}

function updateLocalHostDeviceStatus(deviceId, status) {
  if (!deviceId) return 0;
  let changed = 0;
  for (const id of hostInstanceIds()) {
    const config = readHostConfig(id);
    if (!config || config.deviceId !== deviceId || config.status === status) continue;
    try {
      writeHostConfig(id, { ...config, status });
      changed += 1;
    } catch (err) {
      console.warn(`[local-host] could not update status for ${id}:`, err && err.message);
    }
  }
  return changed;
}

async function approveDevice(rawDeviceId) {
  const config = requireOwner();
  const deviceId = String(rawDeviceId == null ? '' : rawDeviceId);
  if (!deviceId) throw new DirectoryError('validation', '缺少设备 ID');
  await new DirectoryClient(config.directoryUrl).approveDevice(config.poolId, config.deviceToken, deviceId);
  updateLocalHostDeviceStatus(deviceId, 'active');
  await refresh();
  return buildSnapshot();
}

async function revokeDevice(rawDeviceId) {
  const config = requireOwner();
  const deviceId = String(rawDeviceId == null ? '' : rawDeviceId);
  if (!deviceId) throw new DirectoryError('validation', '缺少设备 ID');
  await new DirectoryClient(config.directoryUrl).revokeDevice(config.poolId, config.deviceToken, deviceId);
  updateLocalHostDeviceStatus(deviceId, 'revoked');
  await refresh();
  return buildSnapshot();
}

/**
 * A host is "local" when this app owns the instance that registered the
 * device: one of our <userData> host.json files carries the same deviceId (the
 * device code shown in the UI). Such a host is opened through
 * 127.0.0.1:<adminPort> instead of the tunnel: measured ~60-100 ms instead of
 * 1.8-2.4 s for the first page, and 2-10 ms instead of 200-500 ms for every
 * RPC afterwards. Other machines keep using the public URL from the Directory,
 * so multi-device access is unchanged.
 */
function findLocalHostForDevice(device) {
  if (!device || !device.id) return null;
  for (const id of hostInstanceIds()) {
    const hostConfig = readHostConfig(id);
    if (!hostConfig) continue;
    if (hostConfig.deviceId !== device.id) continue;
    if (!hostConfig.pairSecret || !Number(hostConfig.adminPort)) continue;
    // Guard against a host.json copied from another machine: the Directory
    // reports the machineId from the host's last heartbeat.
    if (device.machineId && hostConfig.machineId && device.machineId !== hostConfig.machineId) continue;
    return { id, config: hostConfig };
  }
  return null;
}

/** Make sure the local sidecar for this instance is up before we point at it. */
async function ensureLocalHostReady(local) {
  const instanceId = local.id;
  const runtime = hostRuntime(instanceId);
  if (!runtime.child && hostAutoStart(instanceId, local.config)) {
    try {
      await startHostInstance(instanceId, { resuming: true });
    } catch (err) {
      throw new DirectoryError(
        'local_host_down',
        `本机实例「${hostDisplayName(instanceId, local.config)}」启动失败：${err && err.message ? err.message : err}`,
      );
    }
  }
  if (!runtime.child) {
    throw new DirectoryError(
      'local_host_down',
      `本机实例「${hostDisplayName(instanceId, local.config)}」当前没有运行。请到 设置 →「DSH 主机实例」里点启动。`,
    );
  }
  const ready = await waitForPort(Number(local.config.adminPort), 8000);
  if (!ready) {
    throw new DirectoryError(
      'local_host_starting',
      '本机主机正在启动，DSH 还没就绪；等几秒后刷新设备列表再点「打开」。',
    );
  }
}

/**
 * Sign a pairing nonce in-process with the host's pair secret from host.json.
 * Same wire format as packages/protocol/index.js `signNonce()`; the sidecar
 * verifies it exactly like a Directory-issued nonce. This removes the last
 * network round trip (~400-650 ms) from opening a host on this machine.
 */
function signLocalPairNonce(pairSecret, hostDeviceId, clientDeviceId) {
  const body = Buffer.from(
    JSON.stringify({
      v: 1, // PROTOCOL_VERSION
      hostId: hostDeviceId,
      clientId: clientDeviceId,
      exp: Date.now() + 120_000, // Directory's NONCE_TTL_MS
      jti: `jti_${crypto.randomBytes(6).toString('hex')}`,
    }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', pairSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function localOrigin(local) {
  return `http://127.0.0.1:${Number(local.config.adminPort)}`;
}

/**
 * Does the Electron partition already hold a valid DSH auth cookie for this
 * origin? DSH issues `dsh-auth-<hash>` for 30 days (HttpOnly, bound to the
 * request authority), so a repeat open needs no pairing at all.
 */
async function hasHostAuthCookie(origin) {
  try {
    let target;
    try {
      target = new URL(origin).toString();
    } catch {
      return false;
    }
    const ses = session.fromPartition(HOST_PARTITION);
    const cookies = await ses.cookies.get({ url: target });
    const now = Date.now();
    return cookies.some(
      (cookie) =>
        /^dsh-auth-/.test(cookie.name) &&
        (!cookie.expirationDate || cookie.expirationDate * 1000 > now + 60_000),
    );
  } catch (err) {
    console.warn('[host] cookie lookup failed:', err && err.message);
    return false;
  }
}

function parsePairUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DirectoryError('bad_pair_url', 'Directory 返回的配对地址无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DirectoryError('bad_pair_url', '配对地址协议不受支持');
  }
  return url;
}

/** Keep the nonce/query but send it to the loopback sidecar port. */
function loopbackPairUrl(pairUrl, origin) {
  const url = new URL(pairUrl);
  const base = new URL(origin);
  url.protocol = base.protocol;
  url.hostname = base.hostname;
  url.port = base.port;
  return url.toString();
}

/** Ask the Directory for a fresh pair URL (remote hosts, local fallback). */
async function requestPairFromDirectory(config, device) {
  const pair = await new DirectoryClient(config.directoryUrl).pair(config.poolId, config.deviceToken, device.id);
  return { url: parsePairUrl(pair.url).toString(), online: pair.online !== false };
}

/**
 * Load a host page with the cheapest path that works:
 *   1. same-machine host      -> 127.0.0.1 sidecar with a locally signed nonce
 *   2. valid dsh-auth cookie  -> load the page directly (no pair at all)
 *   3. otherwise              -> Directory pair + token redirect
 * A rejected cookie/nonce falls back to the next step; 503 means the DSH is
 * still booting and is reported as such.
 */
async function openHostPage({ view, device, local }) {
  const config = requireConfig();
  const origin = local ? localOrigin(local) : device.publicUrl || null;

  if (origin && (await hasHostAuthCookie(origin))) {
    const result = await navigateHostView(view, `${origin.replace(/\/+$/, '')}/`);
    if (result.ok) return { url: result.url, online: true, via: 'cookie' };
    console.log(`[host] cookie open rejected (HTTP ${result.code || 'error'}), falling back to pairing`);
  }

  if (local) {
    const nonce = signLocalPairNonce(local.config.pairSecret, local.config.deviceId, config.deviceId);
    const pairUrl = `${localOrigin(local)}/__fleet/pair?nonce=${encodeURIComponent(nonce)}`;
    const result = await navigateHostView(view, pairUrl);
    if (result.ok) return { url: result.url, online: true, via: 'local-pair' };
    if (result.code !== 503) {
      // A stale/foreign pair secret must not brick the instance: ask the
      // Directory for a nonce and replay that against the loopback sidecar.
      try {
        const pair = await requestPairFromDirectory(config, device);
        const retry = await navigateHostView(view, loopbackPairUrl(pair.url, origin));
        if (retry.ok) return { url: retry.url, online: pair.online, via: 'local-pair-directory' };
        throw new DirectoryError('host_load_failed', describeHostLoadFailure(retry));
      } catch (err) {
        if (err instanceof DirectoryError) throw err;
        throw new DirectoryError('host_load_failed', describeHostLoadFailure(result));
      }
    }
    throw new DirectoryError('host_load_failed', describeHostLoadFailure(result));
  }

  const pair = await requestPairFromDirectory(config, device);
  const result = await navigateHostView(view, pair.url);
  if (!result.ok) throw new DirectoryError('host_load_failed', describeHostLoadFailure(result));
  return { url: result.url, online: pair.online, via: 'pair' };
}

async function openHost(rawHostId) {
  const config = requireConfig();
  if (!config.poolId || !config.deviceToken) throw new DirectoryError('no_pool', '尚未加入任何池');
  if (config.role !== 'owner' && config.selfStatus === 'pending') {
    throw new DirectoryError('device_pending', '本设备尚未通过审批，暂时无法打开主机');
  }

  const hostId = String(rawHostId == null ? '' : rawHostId);
  const device = state.devices.find((entry) => entry.id === hostId);
  if (!device) throw new DirectoryError('host_not_found', '主机不存在或已离开该池');
  if (device.kind !== 'host') throw new DirectoryError('not_a_host', '该设备不是主机');
  if (device.status !== 'active') throw new DirectoryError('host_not_active', '主机尚未通过审批或已被停用');

  const local = findLocalHostForDevice(device);
  if (local) await ensureLocalHostReady(local);

  const info = { id: hostId, name: device.name || hostId, online: local ? true : isOnline(device) };

  // Fast path: this host is still open in memory (attached or detached by a
  // previous close). Re-showing it costs nothing: no pair, no renderer boot.
  const cached = state.hostViews.get(hostId);
  const cachedUrl = cached && viewIsUsable(cached) ? safeWebContentsUrl(cached) : null;
  if (cached && cachedUrl) {
    state.host = { ...info, url: cachedUrl };
    broadcastState();
    getOrCreateHostView(hostId);
    sendToRenderer('fleet:hostOpened', { hostId: info.id, name: info.name, online: info.online });
    return { hostId: info.id, name: info.name, online: info.online, url: cachedUrl, reused: true };
  }

  state.host = { ...info, url: local ? `${localOrigin(local)}/` : device.publicUrl || null };
  broadcastState();
  let opened;
  try {
    const view = getOrCreateHostView(hostId);
    opened = await openHostPage({ view, device, local });
  } catch (err) {
    discardHostView(hostId);
    throw err;
  }
  const finalUrl = opened.url || safeWebContentsUrl(state.hostView) || state.host.url;
  state.host = { ...info, url: finalUrl, online: opened.online !== false };
  broadcastState();
  sendToRenderer('fleet:hostOpened', { hostId: info.id, name: info.name, online: state.host.online });
  return { hostId: info.id, name: info.name, online: state.host.online, url: finalUrl };
}

function leavePool() {
  const config = requireConfig();
  state.config = clearPoolSession(config);
  saveConfig(state.config);
  state.devices = [];
  state.authPending = false;
  state.authError = null;
  destroyAllHostViews();
  sendToRenderer('fleet:hostClosed', {});
  refresh();
  return buildSnapshot();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function windowIconPath() {
  const candidates = [
    path.join(PACKAGE_ROOT, 'assets', 'icon.ico'), // packaged (black icon)
    path.join(PACKAGE_ROOT, '..', '..', 'assets', 'icon', 'icon-black.ico'), // dev checkout
    path.join(PACKAGE_ROOT, '..', '..', 'assets', 'icon', 'icon.ico'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** Small PNG is more reliable than a 256px .ico for the Windows tray area. */
function trayIconPath() {
  const candidates = [
    path.join(PACKAGE_ROOT, 'assets', 'tray.png'), // packaged
    path.join(PACKAGE_ROOT, '..', '..', 'assets', 'icon', 'tray.png'), // dev checkout
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return windowIconPath();
}

// ---------------------------------------------------------------------------
// Tray: closing the window hides it; only "退出 MultiDSH" in the tray menu quits.
// Keeping the app (and the local host sidecar) alive in the tray is also what
// keeps this machine reachable as a pool host.
// ---------------------------------------------------------------------------

function showMainWindow() {
  let win = state.window;
  if (!win || win.isDestroyed()) {
    createWindow();
    win = state.window;
  }
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTrayMenu() {
  const tray = state.tray;
  if (!tray) return;
  const running = hostInstanceIds().filter((id) => Boolean(hostRuntime(id).child));
  const hostRunning = running.length > 0;
  const hostLabel = hostRunning
    ? running.length === 1
      ? `本机主机：运行中（${hostDisplayName(running[0], readHostConfig(running[0]))}）`
      : `本机主机：${running.length} 个实例运行中`
    : '本机主机：未运行';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 MultiDSH', click: showMainWindow },
      { label: '设置 / 管理 DSH 实例…', click: () => { openSettingsWindow(); } },
      { label: hostLabel, enabled: false },
      { type: 'separator' },
      {
        label: '退出 MultiDSH（停止本机主机）',
        click: () => {
          state.quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.setToolTip(hostRunning ? 'MultiDSH 正在后台运行（本机主机在线）' : 'MultiDSH 正在后台运行');
}

function createTray() {
  if (SMOKE || LIVE_SMOKE || state.tray) return;
  const iconPath = trayIconPath();
  let icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  // The tray PNG is already a small, white-backed 32px image. Only the .ico
  // fallback carries a 256px representation and needs an explicit resize.
  if (!icon.isEmpty() && /\.ico$/i.test(iconPath || '')) {
    icon = icon.resize({ width: 16, height: 16 });
  }
  try {
    state.tray = new Tray(icon);
  } catch (err) {
    console.warn('[tray] create failed:', err && err.message);
    return;
  }
  state.tray.on('double-click', showMainWindow);
  state.tray.on('click', showMainWindow);
  updateTrayMenu();
  console.log('[tray] created (closing the window keeps MultiDSH in the tray)');
}

function destroyTray() {
  if (!state.tray) return;
  try {
    state.tray.destroy();
  } catch {
    /* ignore */
  }
  state.tray = null;
}

/**
 * Pick a writable userData directory *before* Chromium/single-instance use it.
 * Rare but real: %APPDATA%\MultiDSH can exist with an ACL that the current
 * (possibly restricted) token cannot write. Chromium then fails to create its
 * cache/lock and the app would exit silently, so fall back to LOCALAPPDATA.
 */
function ensureWritableUserData() {
  if (SMOKE || LIVE_SMOKE) return app.getPath('userData'); // smoke pins it to .tmp already
  const preferred = app.getPath('userData');
  const candidates = [preferred];
  if (process.env.LOCALAPPDATA) {
    const local = path.join(process.env.LOCALAPPDATA, APP_NAME);
    if (local !== preferred) candidates.push(local);
  }
  // Last-resort profile: works in restricted/AppContainer shells where both
  // Roaming and Local AppData are read-only. It keeps the UI usable instead of
  // failing the Chromium single-instance lock and quitting without a window.
  const temp = path.join(os.tmpdir(), `${APP_NAME}-userdata`);
  if (!candidates.includes(temp)) candidates.push(temp);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.multidsh-write-test');
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.rmSync(probe, { force: true });
      if (dir !== preferred) {
        app.setPath('userData', dir);
        console.warn(`[app] %APPDATA% userData is not writable; using ${dir}`);
      }
      return dir;
    } catch (err) {
      console.warn(`[app] userData candidate not writable (${dir}):`, err && err.message);
    }
  }
  return preferred;
}

function setupSingleInstance() {
  if (SMOKE || LIVE_SMOKE) return;
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    showMainWindow();
  });
}

ensureWritableUserData();
setupSingleInstance();

/**
 * Windows uses the Start Menu shortcut that carries the AppUserModelID to
 * resolve the taskbar name/icon. Without it the taskbar shows the Electron
 * runtime's own name ("Electron"), which makes a double-clicked app hard to
 * identify. Keep the shortcut pointed at this extracted copy.
 */
function ensureStartMenuShortcut() {
  if (SMOKE || LIVE_SMOKE || !app.isPackaged || process.platform !== 'win32') return;
  const shortcut = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    `${APP_NAME}.lnk`,
  );
  const launcher = path.join(path.dirname(process.execPath), 'MultiDSH.exe');
  const target = fs.existsSync(launcher) ? launcher : process.execPath;
  try {
    let existing = null;
    try {
      existing = shell.readShortcutLink(shortcut);
    } catch {
      /* not created yet */
    }
    if (existing && path.resolve(existing.target) === path.resolve(target)) return;
    fs.mkdirSync(path.dirname(shortcut), { recursive: true });
    shell.writeShortcutLink(shortcut, 'create', {
      target,
      cwd: path.dirname(process.execPath),
      icon: windowIconPath(),
      iconIndex: 0,
      appUserModelId: 'com.multidsh.desktop',
      description: 'MultiDSH',
    });
  } catch (err) {
    console.warn('[shortcut] could not create Start Menu shortcut:', err && err.message);
  }
}

function openSettingsWindow() {
  if (SMOKE || LIVE_SMOKE) {
    throw new DirectoryError('demo_mode', 'Smoke 模式：设置窗口不可用');
  }
  if (state.settingsWindow && !state.settingsWindow.isDestroyed()) {
    if (state.settingsWindow.isMinimized()) state.settingsWindow.restore();
    state.settingsWindow.show();
    state.settingsWindow.focus();
    return { opened: true, focused: true };
  }
  const theme = (state.config && state.config.theme) || 'light';
  const background = theme === 'light' ? '#f5f7fa' : '#0b0d10';
  const win = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 780,
    minHeight: 600,
    title: `${APP_NAME} 设置`,
    icon: windowIconPath(),
    backgroundColor: background,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  state.settingsWindow = win;
  win.setMenuBarVisibility(false);
  win.setTitle(`${APP_NAME} 设置`);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    if (state.settingsWindow === win) state.settingsWindow = null;
  });
  return { opened: true };
}

function createWindow() {
  const initialTheme = (state.config && state.config.theme) || loadConfig().theme;
  const initialBackground = initialTheme === 'light' ? '#f5f7fa' : '#0b0d10';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: windowIconPath(),
    backgroundColor: initialBackground,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  state.window = win;
  win.setTitle(APP_NAME);
  win.setMenuBarVisibility(false);
  win.setBackgroundColor(initialBackground);

  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(APP_NAME);
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    if (!SMOKE && !LIVE_SMOKE) createTray();
    if (SMOKE) {
      // Fallback in case the renderer never signals ready (e.g. a JS error).
      setTimeout(() => finishSmoke('load-fallback'), 6000);
    }
  });

  win.on('resize', () => applyHostBounds());

  win.on('focus', () => {
    if (SMOKE) return;
    // Alt-tabbing back and forth used to fire two Directory round trips in a
    // row; one refresh per second is plenty.
    if (Date.now() - state.lastRefreshAt < 1000) return;
    refresh();
  });

  win.on('close', (event) => {
    if (SMOKE || LIVE_SMOKE || state.quitting) return;
    event.preventDefault();
    win.hide();
    createTray();
    updateTrayMenu();
  });

  win.on('closed', () => {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    // The window (and its contentView) is gone: release every cached renderer.
    destroyAllHostViews();
    state.window = null;
  });

  state.pollTimer = setInterval(() => {
    const current = state.window;
    if (!current || current.isDestroyed()) return;
    if (!current.isFocused()) return;
    refresh();
  }, POLL_INTERVAL_MS);

  return win;
}

// ---------------------------------------------------------------------------
// Smoke mode: screenshot and exit
// ---------------------------------------------------------------------------

async function captureSmoke() {
  if (state.smoke.captured) return;
  state.smoke.captured = true;
  const win = state.window;
  try {
    if (!win || win.isDestroyed()) throw new Error('主窗口不存在');
    if (!win.isVisible()) win.show();
    const image = await Promise.race([
      win.webContents.capturePage(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('capturePage 超时（8s）')), 8000),
      ),
    ]);
    if (!image || image.isEmpty()) throw new Error('capturePage 返回空图像');
    const png = image.toPNG();
    if (!png || png.length < 5000) throw new Error(`截图数据过小（${png ? png.length : 0} 字节）`);
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const file = path.join(TMP_DIR, SMOKE_DEMO ? 'desktop-smoke-demo.png' : 'desktop-smoke.png');
    fs.writeFileSync(file, png);
    state.smoke.screenshot = file;
    const size = image.getSize();
    console.log(
      `[smoke] screenshot written: ${file} (${png.length} bytes, ${size.width}x${size.height})`,
    );
  } catch (err) {
    state.smoke.exitCode = 1;
    console.error('[smoke] capture failed:', err);
  }
}

/**
 * DOM-level assertions. This session's model cannot view images, so the smoke
 * run also records concrete layout facts to prove the UI rendered correctly.
 */
async function collectSmokeMetrics() {
  const win = state.window;
  if (!win || win.isDestroyed()) {
    state.smoke.exitCode = 1;
    console.error('[smoke] metrics: window is gone');
    return;
  }
  let metrics = null;
  try {
    metrics = await Promise.race([
      win.webContents.executeJavaScript(`(() => {
        const rectOf = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            visible: !el.hidden && style.display !== 'none' && style.visibility !== 'hidden',
          };
        };
        return {
          title: document.title,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          sidebar: rectOf('#sidebar'),
          hostArea: rectOf('#host-area'),
          onboarding: rectOf('#onboarding'),
          fleet: rectOf('#fleet'),
          banners: rectOf('#banners'),
          deviceCards: document.querySelectorAll('.device-card').length,
          onlineCards: document.querySelectorAll('#online-list .device-card').length,
          offlineCards: document.querySelectorAll('#offline-list .device-card').length,
          pendingCards: document.querySelectorAll('#pending-list .device-card').length,
          machineGroups: document.querySelectorAll('.machine-group').length,
          groupedCards: document.querySelectorAll('.machine-group .device-card').length,
          machineNames: Array.from(document.querySelectorAll('.machine-name')).map(
            (el) => el.textContent,
          ),
          emptyStates: document.querySelectorAll('.empty-state').length,
          poolName: (document.querySelector('.pool-name') || {}).textContent || null,
          brand: (document.querySelector('.brand h1') || {}).textContent || null,
          poolSub: (document.getElementById('pool-name') || {}).textContent || null,
          joinCode: (document.querySelector('.join-code') || {}).textContent || null,
          footerText: (document.getElementById('conn-text') || {}).textContent || null,
          deviceNames: Array.from(document.querySelectorAll('.device-name')).map((el) => el.textContent),
          deviceCardsFit: Array.from(document.querySelectorAll('.device-card')).every((el) => {
            const rect = el.getBoundingClientRect();
            const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
            return rect.left >= sidebar.left - 0.5 && rect.right <= sidebar.right + 0.5;
          }),
          sidebarHOverflow: Array.from(
            document.querySelectorAll(
              '#sidebar .panel, #sidebar .pool-card, #sidebar .device-card, #sidebar .settings-panel',
            ),
          ).filter((el) => el.scrollWidth > el.clientWidth + 1).length,
          docScrollWidth: document.documentElement.scrollWidth,
          docScrollHeight: document.documentElement.scrollHeight,
          bodyBackground: getComputedStyle(document.body).backgroundColor,
        };
      })()`),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('页面度量超时（5s）')), 5000),
      ),
    ]);
  } catch (err) {
    state.smoke.exitCode = 1;
    console.error('[smoke] metrics failed:', err);
    return;
  }

  const failures = [];
  if (!metrics || !metrics.innerWidth) failures.push('页面度量缺失');
  if (metrics) {
    if (Math.round(metrics.sidebar.width) !== SIDEBAR_WIDTH) {
      failures.push(`侧边栏宽度 ${metrics.sidebar.width}px ≠ ${SIDEBAR_WIDTH}px`);
    }
    if (Math.round(metrics.sidebar.width + metrics.hostArea.width) !== metrics.innerWidth) {
      failures.push('侧边栏 + 主机区宽度 ≠ 窗口内容宽度');
    }
    if (metrics.docScrollWidth > metrics.innerWidth + 1) {
      failures.push(`出现横向溢出（scrollWidth ${metrics.docScrollWidth} > ${metrics.innerWidth}）`);
    }
    if (metrics.deviceCardsFit !== true) failures.push('设备卡片超出侧边栏边界');
    if (metrics.sidebarHOverflow > 0) failures.push(`侧边栏 ${metrics.sidebarHOverflow} 个容器横向溢出`);
    if (metrics.brand !== 'MultiDSH') failures.push('品牌标题缺失');
    if (SMOKE_DEMO) {
      if (metrics.deviceCards !== 5) failures.push(`设备卡片数 ${metrics.deviceCards} ≠ 5`);
      if (metrics.onlineCards !== 2) failures.push(`在线主机卡片数 ${metrics.onlineCards} ≠ 2`);
      if (metrics.offlineCards !== 1) failures.push(`离线主机卡片数 ${metrics.offlineCards} ≠ 1`);
      if (metrics.pendingCards !== 2) failures.push(`待审批卡片数 ${metrics.pendingCards} ≠ 2`);
      if (metrics.machineGroups !== 3) failures.push(`机器分组数 ${metrics.machineGroups} ≠ 3`);
      if (metrics.groupedCards !== 4) failures.push(`分组内设备卡片数 ${metrics.groupedCards} ≠ 4`);
      if (!metrics.machineNames.includes('user-desktop')) failures.push('未显示 user-desktop 机器名');
      if (metrics.joinCode !== '••••••••') failures.push('池码默认未隐藏');
      if (metrics.onboarding.visible) failures.push('演示模式下仍显示引导页');
      if (!metrics.fleet.visible) failures.push('演示模式下设备页不可见');
    } else {
      if (metrics.deviceCards !== 0) failures.push(`空状态设备卡片数 ${metrics.deviceCards} ≠ 0`);
      if (metrics.machineGroups !== 0) failures.push(`空状态机器分组数 ${metrics.machineGroups} ≠ 0`);
      if (!metrics.onboarding.visible) failures.push('空状态引导页不可见');
      if (metrics.fleet.visible) failures.push('空状态下设备页不应可见');
    }
    if (failures.length) {
      state.smoke.exitCode = 1;
      console.error('[smoke] layout assertions FAILED:', failures.join('; '));
    }
  }

  const file = path.join(
    TMP_DIR,
    SMOKE_DEMO ? 'desktop-smoke-demo-metrics.json' : 'desktop-smoke-metrics.json',
  );
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ assertions: failures, metrics }, null, 2)}\n`, 'utf8');
    console.log(`[smoke] metrics written: ${file} (${failures.length} failures)`);
  } catch (err) {
    console.error('[smoke] failed to write metrics:', err);
  }
  if (failures.length === 0) console.log('[smoke] layout assertions OK');
}

async function finishSmoke(reason) {
  if (state.smoke.finished) return;
  state.smoke.finished = true;
  console.log(`[smoke] finishing (${reason})`);
  try {
    await captureSmoke();
    await collectSmokeMetrics();
  } catch (err) {
    state.smoke.exitCode = 1;
    console.error('[smoke] finishing failed:', err);
  }
  const exitCode = state.smoke.exitCode;
  setTimeout(() => {
    console.log(`[smoke] exit=${exitCode} screenshot=${state.smoke.screenshot || '(none)'}`);
    try {
      app.exit(exitCode);
    } catch {
      /* ignore */
    }
    // Hard fallback: app.exit() can be delayed while Chromium tears down.
    setTimeout(() => {
      try {
        process.exit(exitCode);
      } catch {
        /* ignore */
      }
    }, 1000);
  }, 200);
}

// ---------------------------------------------------------------------------
// Live smoke: real Directory + real Host, opened through the normal UI path
// ---------------------------------------------------------------------------

/** Build the pool session from env so the app starts already "installed". */
function applyLiveConfigFromEnv() {
  const env = process.env;
  const config = {
    directoryUrl: env.MULTIDSH_LIVE_DIRECTORY,
    poolId: env.MULTIDSH_LIVE_POOL_ID,
    deviceId: env.MULTIDSH_LIVE_DEVICE_ID,
    deviceToken: env.MULTIDSH_LIVE_DEVICE_TOKEN,
    deviceName: env.MULTIDSH_LIVE_DEVICE_NAME || 'live-desktop',
    poolName: 'live',
    role: env.MULTIDSH_LIVE_ROLE || 'owner',
    joinCode: null,
    joinCodeExpiresAt: null,
    selfStatus: 'active',
  };
  try {
    fs.mkdirSync(path.dirname(configFilePath()), { recursive: true });
    fs.writeFileSync(configFilePath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    console.log('[live] session config written for', config.directoryUrl, config.poolId);
  } catch (err) {
    console.error('[live] could not write session config:', err && err.message);
  }
}

/** Poll the embedded host view until the DSH UI has rendered. */
async function waitForHostUi(wc, baseUrl, timeoutMs) {
  const start = Date.now();
  let last = { url: '', title: '', textLength: 0 };
  while (Date.now() - start < timeoutMs) {
    try {
      const url = wc.getURL();
      const title = await wc.executeJavaScript('document.title');
      const textLength = await wc.executeJavaScript(
        'document.body ? document.body.innerText.length : 0',
      );
      last = { url, title, textLength };
      if (url && (!baseUrl || url.startsWith(baseUrl)) && !/[?&]token=/.test(url) && textLength > 100) {
        return last;
      }
    } catch {
      /* navigation in progress */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`host UI not ready after ${timeoutMs}ms (${JSON.stringify(last)})`);
}

function finishLiveSmoke({ failures, metrics }) {
  const file = path.join(TMP_DIR, 'desktop-live-metrics.json');
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ assertions: failures, metrics }, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error('[live] failed to write metrics:', err && err.message);
  }
  const exitCode = failures.length ? 1 : 0;
  if (failures.length) console.error('[live] FAIL:', failures.join('; '));
  else console.log('[live] PASS');
  console.log(`[live] metrics: ${file} (${failures.length} failures)`);
  setTimeout(() => {
    console.log(`[live] exit=${exitCode}`);
    try {
      app.exit(exitCode);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        process.exit(exitCode);
      } catch {
        /* ignore */
      }
    }, 1000);
  }, 300);
}

/** Capture the window + embedded host view. Screenshot failure is non-fatal. */
async function captureLiveScreenshots(wc) {
  const shots = {};
  try {
    state.window.show();
    state.window.focus();
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    const image = await wc.capturePage();
    const file = path.join(TMP_DIR, 'desktop-live-host.png');
    fs.writeFileSync(file, image.toPNG());
    shots.host = file;
  } catch (err) {
    console.warn('[live] host view capture failed:', err && err.message);
  }
  try {
    const image = await state.window.capturePage();
    const file = path.join(TMP_DIR, 'desktop-live-window.png');
    fs.writeFileSync(file, image.toPNG());
    shots.window = file;
  } catch (err) {
    console.warn('[live] window capture failed:', err && err.message);
  }
  return shots;
}

async function runLiveSmoke() {
  const failures = [];
  const hostId = String(process.env.MULTIDSH_LIVE_HOST_ID || '').trim();
  const publicUrl = String(process.env.MULTIDSH_LIVE_PUBLIC_URL || '').replace(/\/+$/, '');
  const metrics = {
    hostId,
    directoryUrl: process.env.MULTIDSH_LIVE_DIRECTORY || null,
    devices: 0,
    onlineHosts: 0,
    hostUrl: null,
    hostTitle: null,
    uiTextLength: 0,
    authCookies: [],
    screenshots: {},
  };

  try {
    if (!hostId) throw new Error('MULTIDSH_LIVE_HOST_ID is missing');
    await refresh();
    metrics.devices = state.devices.length;
    metrics.onlineHosts = state.devices.filter(
      (device) => device.kind === 'host' && device.status === 'active',
    ).length;
    if (!metrics.devices) throw new Error('Directory returned no devices');
    if (!metrics.onlineHosts) throw new Error('no active host in the pool');

    const opened = await openHost(hostId);
    metrics.openedUrl = opened.url;
    const view = state.hostView;
    if (!view) throw new Error('host view was not created');
    const wc = view.webContents;

    const cookies = await wc.session.cookies.get({ url: publicUrl || opened.url });
    metrics.authCookies = cookies
      .filter((cookie) => cookie.name.startsWith('dsh-auth-'))
      .map((cookie) => cookie.name);
    if (!metrics.authCookies.length) failures.push('WebContentsView session has no dsh-auth-* cookie');

    const ui = await waitForHostUi(wc, publicUrl, 60_000);
    metrics.hostUrl = ui.url;
    metrics.hostTitle = ui.title;
    metrics.uiTextLength = ui.textLength;
    if (ui.textLength < 100) failures.push(`DSH UI text too short (${ui.textLength})`);

    fs.mkdirSync(TMP_DIR, { recursive: true });
    metrics.screenshots = await captureLiveScreenshots(wc);

    console.log('[live] host UI loaded:', ui.url, `title="${ui.title}"`, `text=${ui.textLength}`);
  } catch (err) {
    failures.push(err && err.message ? err.message : String(err));
  }

  finishLiveSmoke({ failures, metrics });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function isTrustedSender(event) {
  const sender = event && event.sender;
  return [state.window, state.settingsWindow].some(
    (win) => Boolean(win && !win.isDestroyed() && sender === win.webContents),
  );
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, arg) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: { code: 'forbidden', message: '非法的请求来源', status: 0 } };
    }
    try {
      const data = await fn(arg || {});
      return { ok: true, data };
    } catch (err) {
      if (!(err instanceof DirectoryError)) console.error(`[ipc] ${channel} failed:`, err);
      return { ok: false, error: errorForRenderer(err) };
    }
  });
}

function registerIpc() {
  handle('fleet:getState', async () => {
    if (demoActive) return buildSnapshot();
    if (SMOKE) return smokeSnapshot();
    return buildSnapshot();
  });

  handle('fleet:refresh', async () => {
    if (SMOKE) return smokeSnapshot();
    await refresh();
    return buildSnapshot();
  });

  handle('fleet:setDirectory', async (arg) => {
    if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：设置不可用');
    if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
    return setDirectory(arg.url);
  });

  handle('fleet:createPool', async (arg) => {
    if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：无法创建池');
    if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
    return createPool(arg.name, arg.createKey);
  });

  handle('fleet:joinPool', async (arg) => {
    if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：无法加入池');
    if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
    return joinPool(arg.code);
  });

  handle('fleet:approve', async (arg) => {
    if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：无法审批设备');
    if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
    return approveDevice(arg.deviceId);
  });

  handle('fleet:revoke', async (arg) => {
    if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：无法移除设备');
    if (demoActive) throw new DirectoryError('demo_mode', demoGuardMessage());
    return revokeDevice(arg.deviceId);
  });

  handle('fleet:openHost', async (arg) => {
    if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：没有可打开的主机');
    if (demoActive) {
      throw new DirectoryError('demo_mode', '演示模式：示例主机不可打开。真实环境里这里会内嵌该主机的 DSH Web UI。');
    }
    return openHost(arg.hostId);
  });

  handle('fleet:closeHost', async () => {
    closeHostView();
    sendToRenderer('fleet:hostClosed', {});
    return { closed: true };
  });

  handle('fleet:leavePool', async () => {
    if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：无法离开池');
    if (demoActive) return exitDemo();
    return leavePool();
  });

  handle('fleet:enterDemo', async () => {
    if (SMOKE) throw new DirectoryError('demo_mode', 'Smoke 模式：演示不可用');
    if (!demoActive) {
      enterDemo();
      broadcastState();
    }
    return buildSnapshot();
  });

  handle('fleet:exitDemo', async () => exitDemo());

  handle('fleet:getLocalHost', async () => localHostInfo());

  handle('fleet:openSettings', async () => openSettingsWindow());

  handle('fleet:getHostInstances', async () => hostManagerInfo());

  handle('fleet:createHostInstance', async (arg) => createHostInstance(arg || {}));

  handle('fleet:updateHostInstance', async (arg) => updateHostInstance(arg && arg.id, arg || {}));

  handle('fleet:installDshRuntime', async () => installDshRuntime());

  handle('fleet:startHostInstance', async (arg) => startHostInstance(arg && arg.id, arg || {}));

  handle('fleet:stopHostInstance', async (arg) => stopHostInstance(arg && arg.id));

  handle('fleet:joinHostInstance', async (arg) => joinHostInstance(arg && arg.id, arg || {}));

  handle('fleet:leaveHostInstance', async (arg) => leaveHostInstance(arg && arg.id));

  handle('fleet:deleteHostInstance', async (arg) => deleteHostInstance(arg && arg.id));

  handle('fleet:setSidebarCollapsed', async (arg) => {
    state.sidebarCollapsed = Boolean(arg && arg.collapsed);
    applyHostBounds();
    return { collapsed: state.sidebarCollapsed };
  });

  handle('fleet:startLocalHost', async (arg) => startLocalHost(arg || {}));

  handle('fleet:stopLocalHost', async () => stopLocalHost());

  handle('fleet:setTheme', async (arg) => {
    const theme = arg && arg.theme === 'dark' ? 'dark' : 'light';
    if (state.config) state.config.theme = theme;
    // In demo mode state.config carries the sample pool; persist only the theme
    // on top of the real on-disk config so demo data never leaks to disk.
    const persisted = demoActive ? { ...loadConfig(), theme } : { ...(state.config || loadConfig()), theme };
    saveConfig(persisted);
    if (state.window) state.window.setBackgroundColor(theme === 'light' ? '#f5f7fa' : '#0b0d10');
    return buildSnapshot();
  });

  handle('fleet:setViewCacheSize', async (arg) => {
    const size = Number(arg && arg.size);
    if (!Number.isInteger(size) || size < 1 || size > 6) {
      throw new DirectoryError('validation', '主机页签缓存数量需要在 1-6 之间');
    }
    if (state.config) state.config.hostViewCacheSize = size;
    // Demo mode: persist only the preference on top of the real on-disk config.
    const persisted = demoActive
      ? { ...loadConfig(), hostViewCacheSize: size }
      : { ...(state.config || loadConfig()), hostViewCacheSize: size };
    saveConfig(persisted);
    evictHostViews();
    return buildSnapshot();
  });

  handle('fleet:copyText', async (arg) => {
    const text = String((arg && arg.text) || '').slice(0, 4096);
    if (!text) throw new DirectoryError('validation', '没有可复制的内容');
    clipboard.writeText(text);
    return { copied: true };
  });

  ipcMain.on('fleet:rendererReady', (event) => {
    if (!isTrustedSender(event)) return;
    if (SMOKE) {
      console.log('[smoke] renderer ready');
      setTimeout(() => finishSmoke('renderer-ready'), 4000);
      return;
    }
    if (LIVE_SMOKE) {
      console.log('[live] renderer ready');
      runLiveSmoke();
      return;
    }
    if (demoActive) {
      sendToRenderer('fleet:state', buildSnapshot());
      return;
    }
    refresh();
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

registerIpc();

app.whenReady().then(() => {
  migrateLegacyData();
  if (LIVE_SMOKE) applyLiveConfigFromEnv();
  state.config = loadConfig();
  if (!LIVE_SMOKE) {
    // Demo is opt-in only (--demo / settings); a fresh install starts on the
    // real onboarding screen and never shows sample data automatically.
    if (DEMO_FLAG) enterDemo();
  }
  ensureStartMenuShortcut();
  createWindow();

  if (!SMOKE && !LIVE_SMOKE) {
    // Restore every local host instance that was running when the app closed.
    setTimeout(() => {
      resumeAllHostInstances().catch((err) => {
        console.warn('[local-host] resume failed:', err && err.message);
      });
    }, 1200);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (state.quitting || SMOKE || LIVE_SMOKE) {
    if (process.platform !== 'darwin') app.quit();
  }
  // Otherwise keep running in the tray (the window was hidden, not closed).
});

app.on('before-quit', () => {
  state.quitting = true;
  destroyTray();
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  destroyAllHostViews();
  for (const id of hostInstanceIds()) {
    const runtime = hostRuntime(id);
    if (!runtime.child) continue;
    try {
      runtime.child.kill();
    } catch {
      /* ignore */
    }
    runtime.child = null;
  }
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
});
