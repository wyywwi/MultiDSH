// Host sidecar configuration handling.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_ADMIN_PORT = 4080;
export const DEFAULT_DSH_PORT = 3080;

export function defaultConfigPath() {
  return path.join(os.homedir(), '.multidsh', 'host.json');
}

/** Locate the DSH CLI shipped next to this repo (or from the environment). */
export function defaultDshBin() {
  if (process.env.MULTIDSH_DSH_BIN) return process.env.MULTIDSH_DSH_BIN;
  return path.resolve(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'dsh_out',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
}

export function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function loadConfig(configPath = defaultConfigPath()) {
  const file = path.resolve(expandHome(configPath));
  const raw = fs.readFileSync(file, 'utf8');
  const config = JSON.parse(raw);
  for (const key of ['directoryUrl', 'poolId', 'deviceId', 'deviceToken', 'pairSecret', 'adminPort', 'dshPort']) {
    if (config[key] === undefined) throw new Error(`config ${file} is missing "${key}"`);
  }
  return { ...config, configPath: file };
}

export function saveConfig(config, configPath = config?.configPath || defaultConfigPath()) {
  const file = path.resolve(expandHome(configPath));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { configPath: _ignored, ...body } = config;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

/** Safe summary for logs. */
export function describeConfig(config) {
  return {
    directoryUrl: config.directoryUrl,
    poolId: config.poolId,
    deviceId: config.deviceId,
    name: config.name,
    adminPort: config.adminPort,
    dshPort: config.dshPort,
    publicUrl: config.publicUrl,
    status: config.status,
  };
}
