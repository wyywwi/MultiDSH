// MultiDSH Directory store (M0).
//
// A tiny JSON-file store with an in-memory index:
//   - pools:        Map<poolId, Pool>
//   - devices:      Map<deviceId, Device>          (Device also carries tokenHash/pairSecret)
//   - poolCodeIndex: Map<joinCode, poolId>
//   - devicesByTokenHash: Map<sha256(token), deviceId>  (rebuilt on load, never persisted)
//
// On startup the state file is read synchronously (so `createApp()` can return a
// ready http.Server). Every mutation is persisted with an atomic write:
// write `<state>.tmp.<pid>.<rand>` then `rename()` it over the real file.
//
// Data path may be either a directory (state file: `<dir>/directory.json`) or an
// explicit `*.json` file path. `dataPath: null` keeps the store memory-only.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  hashToken,
  newDeviceToken,
  newId,
  newJoinCode,
  newPairSecret,
  normalizeJoinCode,
  nowMs,
} from '../../protocol/index.js';

/** File name used when `dataPath` points at a directory. */
export const STATE_FILE_NAME = 'directory.json';

/** Pool codes are valid for 24 hours (PROTOCOL.md §1). */
export const DEFAULT_JOIN_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** Defensive default shape for pending devices. */
const DEVICE_DEFAULTS = Object.freeze({
  kind: 'client',
  role: 'member',
  name: null,
  platform: null,
  version: null,
  publicUrl: null,
  machineId: null,
  machineName: null,
  health: {},
  meta: {},
});

function resolvePaths(dataPath) {
  if (dataPath === null || dataPath === undefined || dataPath === '') {
    return { dirPath: null, filePath: null };
  }
  const absolute = resolve(String(dataPath));
  if (extname(absolute).toLowerCase() === '.json') {
    return { dirPath: dirname(absolute), filePath: absolute };
  }
  return { dirPath: absolute, filePath: join(absolute, STATE_FILE_NAME) };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class Store {
  /**
   * @param {object} [options]
   * @param {string|null} [options.dataPath] directory or `*.json` file; null = memory only
   * @param {() => number} [options.now] clock (injectable for tests)
   * @param {number} [options.joinCodeTtlMs] pool code lifetime (default 24h)
   */
  constructor({ dataPath = null, now = nowMs, joinCodeTtlMs = DEFAULT_JOIN_CODE_TTL_MS } = {}) {
    this.now = typeof now === 'function' ? now : () => Number(now);
    this.joinCodeTtlMs = joinCodeTtlMs;
    const { dirPath, filePath } = resolvePaths(dataPath);
    this.dirPath = dirPath;
    this.filePath = filePath;

    /** @type {Map<string, object>} */
    this.pools = new Map();
    /** @type {Map<string, object>} */
    this.devices = new Map();
    /** @type {Map<string, string>} */
    this.poolCodeIndex = new Map();
    /** @type {Map<string, string>} */
    this.devicesByTokenHash = new Map();

    this._writeQueue = Promise.resolve();
    this._loadSync();
  }

  // ---------------------------------------------------------------------------
  // Loading / persistence
  // ---------------------------------------------------------------------------

  _loadSync() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`MultiDSH directory state file is corrupt (${this.filePath}): ${err.message}`);
    }
    if (!isPlainObject(data)) {
      throw new Error(`MultiDSH directory state file is corrupt (${this.filePath}): expected an object`);
    }
    for (const pool of Object.values(isPlainObject(data.pools) ? data.pools : {})) {
      if (!pool || typeof pool.id !== 'string') continue;
      this.pools.set(pool.id, pool);
      if (typeof pool.joinCode === 'string' && pool.joinCode) {
        this.poolCodeIndex.set(normalizeJoinCode(pool.joinCode), pool.id);
      }
    }
    for (const device of Object.values(isPlainObject(data.devices) ? data.devices : {})) {
      if (!device || typeof device.id !== 'string' || typeof device.tokenHash !== 'string') continue;
      this.devices.set(device.id, device);
      this.devicesByTokenHash.set(device.tokenHash, device.id);
    }
  }

  /** Snapshot persisted to disk (never contains token plaintext). */
  serialize() {
    return {
      version: 1,
      app: 'MultiDSH',
      savedAt: this.now(),
      pools: Object.fromEntries(this.pools),
      devices: Object.fromEntries(this.devices),
    };
  }

  async _writeAtomic() {
    if (!this.filePath) return;
    mkdirSync(this.dirPath, { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    const payload = `${JSON.stringify(this.serialize(), null, 2)}\n`;
    try {
      await writeFile(tmpPath, payload, 'utf8');
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  /** Queue an atomic write; resolves once the state is on disk. */
  save() {
    const run = this._writeQueue.then(() => this._writeAtomic());
    // Keep the chain alive even when a write fails, so later writes still run.
    this._writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Resolve when all queued writes have settled. */
  flush() {
    return this._writeQueue;
  }

  // ---------------------------------------------------------------------------
  // Pools
  // ---------------------------------------------------------------------------

  createPool({ name = 'pool' } = {}) {
    const createdAt = this.now();
    let joinCode = newJoinCode();
    while (this.poolCodeIndex.has(joinCode)) joinCode = newJoinCode();
    const pool = {
      id: newId('pool'),
      name,
      createdAt,
      joinCode,
      joinCodeExpiresAt: createdAt + this.joinCodeTtlMs,
      ownerDeviceId: null,
    };
    this.pools.set(pool.id, pool);
    this.poolCodeIndex.set(joinCode, pool.id);
    return pool;
  }

  getPool(poolId) {
    if (!poolId) return null;
    return this.pools.get(String(poolId)) ?? null;
  }

  getPoolByJoinCode(code) {
    const normalized = normalizeJoinCode(code);
    if (!normalized) return null;
    const poolId = this.poolCodeIndex.get(normalized);
    return poolId ? this.getPool(poolId) : null;
  }

  /** True when the pool code exists and has not expired at the current clock. */
  isJoinCodeValid(pool) {
    return Boolean(pool && Number.isFinite(pool.joinCodeExpiresAt) && pool.joinCodeExpiresAt > this.now());
  }

  setPoolOwner(poolId, deviceId) {
    const pool = this.getPool(poolId);
    if (!pool) return null;
    pool.ownerDeviceId = deviceId;
    return pool;
  }

  /** Replace the pool code, invalidating the previous one. Returns the pool. */
  rotateJoinCode(poolId) {
    const pool = this.getPool(poolId);
    if (!pool) return null;
    if (pool.joinCode) this.poolCodeIndex.delete(normalizeJoinCode(pool.joinCode));
    let joinCode = newJoinCode();
    while (this.poolCodeIndex.has(joinCode)) joinCode = newJoinCode();
    pool.joinCode = joinCode;
    pool.joinCodeExpiresAt = this.now() + this.joinCodeTtlMs;
    this.poolCodeIndex.set(joinCode, pool.id);
    return pool;
  }

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  /**
   * Create a device and return `{ device, token }`. Only the sha256(token) is kept.
   * @param {object} fields
   */
  addDevice({
    poolId,
    kind = DEVICE_DEFAULTS.kind,
    role = DEVICE_DEFAULTS.role,
    name = DEVICE_DEFAULTS.name,
    platform = DEVICE_DEFAULTS.platform,
    version = DEVICE_DEFAULTS.version,
    status = 'pending',
    publicUrl = DEVICE_DEFAULTS.publicUrl,
    machineId = DEVICE_DEFAULTS.machineId,
    machineName = DEVICE_DEFAULTS.machineName,
    health = DEVICE_DEFAULTS.health,
    meta = DEVICE_DEFAULTS.meta,
  } = {}) {
    const createdAt = this.now();
    const token = newDeviceToken();
    const approved = status === 'active';
    const device = {
      id: newId('dev'),
      poolId,
      kind,
      role,
      name,
      platform,
      version,
      status,
      createdAt,
      approvedAt: approved ? createdAt : null,
      lastSeenAt: approved ? createdAt : null,
      publicUrl,
      machineId,
      machineName,
      health: isPlainObject(health) ? health : {},
      meta: isPlainObject(meta) ? meta : {},
      tokenHash: hashToken(token),
      pairSecret: kind === 'host' ? newPairSecret() : null,
    };
    this.devices.set(device.id, device);
    this.devicesByTokenHash.set(device.tokenHash, device.id);
    return { device, token };
  }

  getDevice(deviceId) {
    if (!deviceId) return null;
    return this.devices.get(String(deviceId)) ?? null;
  }

  /** Look up a device by the bearer token it was issued (hashed lookup). */
  getDeviceByToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const deviceId = this.devicesByTokenHash.get(hashToken(token));
    return deviceId ? this.getDevice(deviceId) : null;
  }

  updateDevice(deviceId, patch) {
    const device = this.getDevice(deviceId);
    if (!device || !isPlainObject(patch)) return device;
    Object.assign(device, patch);
    return device;
  }

  listDevices(poolId) {
    const out = [];
    for (const device of this.devices.values()) {
      if (device.poolId === poolId) out.push(device);
    }
    return out;
  }
}

/** Convenience factory: `createStore({ dataPath })`. */
export function createStore(options = {}) {
  return new Store(options);
}
