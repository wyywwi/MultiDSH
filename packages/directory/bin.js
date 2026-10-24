#!/usr/bin/env node
// MultiDSH Directory CLI.
//
//   node bin.js --port 8787 --data <dir>
//
// Prints `multidsh directory listening on http://127.0.0.1:<port>` once the
// server is accepting connections, then stays in the foreground until SIGINT
// or SIGTERM, at which point it stops accepting and flushes pending state.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp } from './src/app.js';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DATA_DIR = resolve(process.cwd(), '.tmp', 'directory');

const HELP = `MultiDSH Directory (M0)

Usage:
  node bin.js [--port <port>] [--data <dir|file.json>] [--host <host>]

Options:
  --port, -p   TCP port to listen on (default ${DEFAULT_PORT}; 0 picks a free port)
  --data, -d   state directory (or *.json file) (default <cwd>/.tmp/directory)
  --host       bind address (default ${DEFAULT_HOST})
  --help, -h   show this help

Endpoints (PROTOCOL.md §3):
  GET  /api/health
  POST /api/pools
  POST /api/pools/join
  GET  /api/pools/:poolId/devices?includePending=1
  POST /api/pools/:poolId/devices/:deviceId/approve
  POST /api/pools/:poolId/devices/:deviceId/revoke
  POST /api/pools/:poolId/join-code/rotate
  POST /api/heartbeat
  POST /api/pools/:poolId/pair
`;

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    data: DEFAULT_DATA_DIR,
    help: false,
  };

  const readValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];

    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--port':
      case '-p': {
        const value = inline ?? readValue(i, flag);
        if (inline === undefined) i += 1;
        options.port = Number(value);
        break;
      }
      case '--data':
      case '-d':
        options.data = inline ?? readValue(i, flag);
        if (inline === undefined) i += 1;
        break;
      case '--host':
        options.host = inline ?? readValue(i, flag);
        if (inline === undefined) i += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`invalid port: ${options.port}`);
  }
  options.data = resolve(options.data);
  return options;
}

export function startDirectory({ port = DEFAULT_PORT, host = DEFAULT_HOST, data } = {}) {
  const { server, store } = createApp({ dataPath: data ?? DEFAULT_DATA_DIR });
  return { server, store };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`multidsh directory: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  let server;
  let store;
  try {
    ({ server, store } = createApp({ dataPath: options.data }));
  } catch (err) {
    console.error(`multidsh directory: failed to load state: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await new Promise((resolveClose) => {
        server.close(() => resolveClose());
        // Node >= 18.2: cut idle keep-alive connections so close() can finish.
        server.closeIdleConnections?.();
      });
      await store.flush();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  server.on('error', (err) => {
    console.error(`multidsh directory: ${err.code === 'EADDRINUSE' ? `port ${options.port} is already in use` : err.message}`);
    process.exit(1);
  });

  await new Promise((resolveListen) => {
    server.listen(options.port, options.host, resolveListen);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : options.port;
  console.log(`multidsh directory listening on http://${options.host}:${actualPort}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  await main(process.argv.slice(2));
}
