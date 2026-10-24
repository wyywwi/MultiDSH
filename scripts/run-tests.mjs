// Runs all package test suites sequentially.
// Usage: .\bin\node.cmd scripts\run-tests.mjs [suiteDirOrFile ...]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE =
  process.env.MULTIDSH_NODE ||
  path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');

const suites = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['packages/directory/test', 'packages/directory-worker/test', 'packages/host/test'];

/** Node 24 does not expand a directory argument for --test, so do it here. */
function expand(suite) {
  const abs = path.resolve(ROOT, suite);
  if (!fs.existsSync(abs)) throw new Error(`test path not found: ${suite}`);
  if (!fs.statSync(abs).isDirectory()) return [abs];
  return fs
    .readdirSync(abs)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join(abs, name));
}

let failed = false;
for (const suite of suites) {
  const files = expand(suite);
  console.log(`\n=== ${suite} (${files.length} file${files.length === 1 ? '' : 's'}) ===`);
  const res = spawnSync(NODE, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
