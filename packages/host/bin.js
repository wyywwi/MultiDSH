#!/usr/bin/env node
// MultiDSH Host sidecar CLI.
//
//   multidsh-host init --directory <url> --pool-code <code> --name <name> [...]
//   multidsh-host run  [--config <path>]
//   multidsh-host status [--config <path>]

import path from 'node:path';
import { ADMIN_PREFIX } from '../protocol/index.js';
import {
  DEFAULT_ADMIN_PORT,
  DEFAULT_DSH_PORT,
  defaultConfigPath,
  defaultDshBin,
  describeConfig,
  loadConfig,
  saveConfig,
  expandHome,
} from './src/config.js';
import { initHost } from './src/init.js';
import { DshSupervisor, assertDshBin } from './src/supervisor.js';
import { createAdminServer } from './src/admin.js';
import { createProxy } from './src/proxy.js';
import { Heartbeat } from './src/heartbeat.js';
import { machineIdentity } from './src/machine.js';

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

function log(...args) {
  console.log(`[multidsh-host ${new Date().toISOString()}]`, ...args);
}

async function cmdInit(args) {
  const directoryUrl = args.directory;
  const poolCode = args['pool-code'];
  const name = args.name;
  if (!directoryUrl || !poolCode || !name) {
    throw new Error('init requires --directory <url> --pool-code <code> --name <name>');
  }
  const adminPort = Number(args['admin-port'] || DEFAULT_ADMIN_PORT);
  const dshPort = Number(args['dsh-port'] || DEFAULT_DSH_PORT);
  const publicUrl = args['public-url'] || `http://127.0.0.1:${adminPort}`;
  const dshBin = path.resolve(expandHome(args['dsh-bin'] || defaultDshBin()));
  const { config, file } = await initHost({
    directoryUrl,
    poolCode,
    name,
    platform: args.platform || process.platform,
    version: args.version || '0.1.0',
    machineId: args['machine-id'] || undefined,
    machineName: args['machine-name'] || undefined,
    publicUrl,
    adminPort,
    dshPort,
    dshBin,
    dshHome: args['dsh-home'] ? path.resolve(expandHome(args['dsh-home'])) : null,
    nodeBin: args['node-bin'] ? path.resolve(expandHome(args['node-bin'])) : null,
    configPath: path.resolve(expandHome(args.config || defaultConfigPath())),
  });
  console.log(`joined pool ${config.poolId} as ${config.deviceId} (status: ${config.status})`);
  console.log(`config written to ${file}`);
  if (config.status === 'pending') {
    console.log('waiting for owner approval in the MultiDSH app, then run:');
    console.log(`  node "${path.resolve(import.meta.dirname, 'bin.js')}" run --config "${file}"`);
  }
  return 0;
}

async function cmdRun(args) {
  const configPath = path.resolve(expandHome(args.config || defaultConfigPath()));
  let config = loadConfig(configPath);
  // Backfill machine identity for host.json files created before desktop
  // grouping existed; the next heartbeat then lets clients group this host.
  if (!config.machineId || !config.machineName) {
    const identity = machineIdentity();
    config = {
      ...config,
      machineId: config.machineId || identity.id,
      machineName: config.machineName || identity.name,
    };
    saveConfig(config, configPath);
    log(`machine identity backfilled: ${config.machineId} (${config.machineName})`);
  }
  const dshBin = path.resolve(expandHome(args['dsh-bin'] || config.dshBin || defaultDshBin()));
  assertDshBin(dshBin);

  const supervisor = new DshSupervisor({
    dshBin,
    nodeBin: config.nodeBin || (args['node-bin'] ? path.resolve(expandHome(args['node-bin'])) : null),
    dshPort: config.dshPort,
    publicUrl: config.publicUrl,
    dshHome: config.dshHome,
    log,
  });
  const proxy = createProxy({ targetPort: config.dshPort, log });
  const heartbeat = new Heartbeat({
    directoryUrl: config.directoryUrl,
    deviceToken: config.deviceToken,
    config,
    supervisor,
    log,
    onStatusChange: (status) => {
      log(`device status changed to ${status}`);
      try {
        saveConfig({ ...config, status }, configPath);
      } catch (err) {
        log(`could not persist status: ${err.message}`);
      }
    },
  });
  const { server } = createAdminServer({ config, supervisor, heartbeat, proxy, log });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.adminPort, '127.0.0.1', resolve);
  });
  console.log(`multidsh host listening on http://127.0.0.1:${config.adminPort} (dsh on ${config.dshPort})`);
  log('config', JSON.stringify(describeConfig(config)));

  supervisor.start();
  heartbeat.start();

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, shutting down`);
    heartbeat.stop();
    await new Promise((resolve) => server.close(resolve));
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  // Keep the process alive; the server and child handles do that already.
  return new Promise(() => {});
}

async function cmdStatus(args) {
  const config = loadConfig(path.resolve(expandHome(args.config || defaultConfigPath())));
  const res = await fetch(`http://127.0.0.1:${config.adminPort}${ADMIN_PREFIX}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`status failed: ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 2));
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (command) {
    case 'init':
      return cmdInit(args);
    case 'run':
      return cmdRun(args);
    case 'status':
      return cmdStatus(args);
    case '--help':
    case '-h':
    case undefined:
      console.log('usage: multidsh-host <init|run|status> [options]');
      return 0;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error(`multidsh-host: ${err.message}`);
  process.exit(1);
});
