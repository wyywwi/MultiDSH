// Stable identity for the physical machine that runs one or more MultiDSH hosts.
//
// The desktop client groups host devices by `machineId`, so all host profiles on
// the same box must report the same value. The identity is intentionally stored
// outside any single host profile, under ~/.multidsh/machine.json (or
// $MULTIDSH_HOME/machine.json), and shared by every `multidsh init` on the box.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE_NAME = 'machine.json';

function homeDir() {
  return process.env.MULTIDSH_HOME
    ? path.resolve(process.env.MULTIDSH_HOME)
    : path.join(os.homedir(), '.multidsh');
}

function readIdentity(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (raw && typeof raw.id === 'string' && raw.id.trim()) {
      return {
        id: raw.id.trim(),
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : os.hostname(),
      };
    }
  } catch {
    /* missing or corrupt: recreate below */
  }
  return null;
}

/**
 * Return (and lazily persist) this machine's stable identity.
 *
 * Environment overrides are useful for tests and for machines whose hostname is
 * not meaningful to the user: MULTIDSH_MACHINE_ID / MULTIDSH_MACHINE_NAME.
 */
export function machineIdentity() {
  const envId = String(process.env.MULTIDSH_MACHINE_ID || '').trim();
  const envName = String(process.env.MULTIDSH_MACHINE_NAME || '').trim();
  if (envId) {
    return { id: envId, name: envName || os.hostname() };
  }

  const file = path.join(homeDir(), FILE_NAME);
  const existing = readIdentity(file);
  if (existing && !envName) return existing;

  const identity = {
    id: envId || `machine_${crypto.randomBytes(8).toString('hex')}`,
    name: envName || (existing && existing.name) || os.hostname(),
    createdAt: (existing && existing.createdAt) || Date.now(),
  };
  if (existing && existing.id) identity.id = existing.id;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows ignores POSIX modes */
    }
  } catch {
    /* A read-only home still gets a usable in-memory identity. */
  }
  return { id: identity.id, name: identity.name };
}

export function machineStatePath() {
  return path.join(homeDir(), FILE_NAME);
}
