// Async storage for the MultiDSH Worker directory.
//
// `Repository` talks to a minimal KV interface:
//   get(key) -> string | null
//   put(key, value) -> void
//   delete(key) -> void
//   list({ prefix }) -> { keys: [{ name }] }
//
// Two implementations are provided:
//   - `MemoryKv`: Node tests / local dev adapter (bin.js)
//   - `WorkerKv`: wraps a Cloudflare KV namespace binding
//
// The key layout is deliberately flat:
//   pool:<poolId>                 -> Pool JSON
//   code:<JOINCODE>               -> poolId
//   device:<deviceId>             -> Device JSON (tokenHash + pairSecret included)
//   token:<sha256(token)>         -> deviceId
//   pooldev:<poolId>:<deviceId>   -> "1"
//
// M0 uses KV for a zero-setup skeleton. KV is eventually consistent, so
// read-modify-write races are possible (documented in README); D1 with a real
// schema is the M1 hardening step.

import {
  hashToken,
  newDeviceToken,
  newId,
  newJoinCode,
  newPairSecret,
  normalizeJoinCode,
  nowMs,
} from './crypto.js';

export const DEFAULT_JOIN_CODE_TTL_MS = 24 * 60 * 60 * 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function livenessFromRow(row) {
  if (!row) return null;
  let health = {};
  if (row.health_json) {
    try {
      health = JSON.parse(row.health_json);
    } catch {
      health = {};
    }
  }
  return {
    lastSeenAt: row.last_seen_at,
    publicUrl: row.public_url ?? null,
    version: row.version ?? null,
    health: isPlainObject(health) ? health : {},
    machineId: row.machine_id ?? null,
    machineName: row.machine_name ?? null,
  };
}

function livenessFromJoinedRow(row) {
  if (!row || !row.liveness_device_id) return null;
  let health = {};
  if (row.liveness_health_json) {
    try {
      health = JSON.parse(row.liveness_health_json);
    } catch {
      health = {};
    }
  }
  return {
    lastSeenAt: row.liveness_last_seen_at,
    publicUrl: row.liveness_public_url ?? null,
    version: row.liveness_version ?? null,
    health: isPlainObject(health) ? health : {},
    machineId: row.liveness_machine_id ?? null,
    machineName: row.liveness_machine_name ?? null,
  };
}

function mergeLiveness(device, hb) {
  if (!device || !hb) return device;
  return {
    ...device,
    lastSeenAt: hb.lastSeenAt ?? device.lastSeenAt,
    health: hb.health !== undefined ? hb.health : device.health,
    version: hb.version ?? device.version,
    publicUrl: hb.publicUrl ?? device.publicUrl,
    machineId: hb.machineId ?? device.machineId,
    machineName: hb.machineName ?? device.machineName,
  };
}

/**
 * D1-backed liveness store. Heartbeats are high-frequency writes; keeping them
 * out of KV avoids exhausting the free KV write allowance (1,000 writes/day).
 *
 * Table (`schema.sql`):
 *   device_liveness(device_id PRIMARY KEY, last_seen_at, public_url, version,
 *                   health_json, machine_id, machine_name)
 */
export class D1Liveness {
  constructor(db, { now = nowMs } = {}) {
    this.db = db;
    this.now = typeof now === 'function' ? now : () => Number(now);
  }

  async record(deviceId, patch = {}) {
    const lastSeenAt = Number.isFinite(patch.lastSeenAt) ? patch.lastSeenAt : this.now();
    const publicUrl = typeof patch.publicUrl === 'string' ? patch.publicUrl : null;
    const version = typeof patch.version === 'string' ? patch.version : null;
    const healthJson = patch.health !== undefined ? JSON.stringify(patch.health) : null;
    const machineId = typeof patch.machineId === 'string' ? patch.machineId : null;
    const machineName = typeof patch.machineName === 'string' ? patch.machineName : null;
    await this.db
      .prepare(
        `INSERT INTO device_liveness
           (device_id, last_seen_at, public_url, version, health_json, machine_id, machine_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           public_url = COALESCE(excluded.public_url, device_liveness.public_url),
           version = COALESCE(excluded.version, device_liveness.version),
           health_json = COALESCE(excluded.health_json, device_liveness.health_json),
           machine_id = COALESCE(excluded.machine_id, device_liveness.machine_id),
           machine_name = COALESCE(excluded.machine_name, device_liveness.machine_name)`,
      )
      .bind(deviceId, lastSeenAt, publicUrl, version, healthJson, machineId, machineName)
      .run();
    return {
      lastSeenAt,
      publicUrl,
      version,
      health: patch.health !== undefined ? patch.health : {},
      machineId,
      machineName,
    };
  }

  async get(deviceId) {
    if (!deviceId) return null;
    const row = await this.db
      .prepare(
        `SELECT device_id, last_seen_at, public_url, version, health_json, machine_id, machine_name
           FROM device_liveness WHERE device_id = ?`,
      )
      .bind(deviceId)
      .first();
    return livenessFromRow(row);
  }

  async getMany(deviceIds) {
    const ids = [...new Set(deviceIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(', ');
    const { results = [] } = await this.db
      .prepare(
        `SELECT device_id, last_seen_at, public_url, version, health_json, machine_id, machine_name
           FROM device_liveness WHERE device_id IN (${placeholders})`,
      )
      .bind(...ids)
      .all();
    return new Map(results.map((row) => [row.device_id, livenessFromRow(row)]));
  }
}

/** In-memory KV for tests and the local Node adapter. */
export class MemoryKv {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async put(key, value) {
    this.map.set(key, String(value));
  }

  async delete(key) {
    this.map.delete(key);
  }

  async list({ prefix = '' } = {}) {
    const keys = [...this.map.keys()]
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

/** Cloudflare KV binding adapter. */
export class WorkerKv {
  constructor(namespace) {
    this.namespace = namespace;
  }

  async get(key) {
    return this.namespace.get(key);
  }

  async put(key, value) {
    await this.namespace.put(key, String(value));
  }

  async delete(key) {
    await this.namespace.delete(key);
  }

  async list(options = {}) {
    return this.namespace.list(options);
  }
}

export class Repository {
  constructor({ kv, now = nowMs, joinCodeTtlMs = DEFAULT_JOIN_CODE_TTL_MS, liveness = null }) {
    this.kv = kv;
    this.now = typeof now === 'function' ? now : () => Number(now);
    this.joinCodeTtlMs = joinCodeTtlMs;
    this.liveness = liveness;
  }

  async _getJson(key) {
    const raw = await this.kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async _putJson(key, value) {
    await this.kv.put(key, JSON.stringify(value));
  }

  // ---------------------------------------------------------------- pools ---

  async createPool({ name = 'pool' } = {}) {
    const createdAt = this.now();
    let joinCode = newJoinCode();
    while (await this.kv.get(`code:${joinCode}`)) joinCode = newJoinCode();
    const pool = {
      id: newId('pool'),
      name,
      createdAt,
      joinCode,
      joinCodeExpiresAt: createdAt + this.joinCodeTtlMs,
      ownerDeviceId: null,
    };
    await this._putJson(`pool:${pool.id}`, pool);
    await this.kv.put(`code:${normalizeJoinCode(joinCode)}`, pool.id);
    return pool;
  }

  async getPool(poolId) {
    if (!poolId) return null;
    return this._getJson(`pool:${poolId}`);
  }

  async getPoolByJoinCode(code) {
    const normalized = normalizeJoinCode(code);
    if (!normalized) return null;
    const poolId = await this.kv.get(`code:${normalized}`);
    return poolId ? this.getPool(poolId) : null;
  }

  isJoinCodeValid(pool) {
    return Boolean(pool && Number.isFinite(pool.joinCodeExpiresAt) && pool.joinCodeExpiresAt > this.now());
  }

  async setPoolOwner(poolId, deviceId) {
    const pool = await this.getPool(poolId);
    if (!pool) return null;
    pool.ownerDeviceId = deviceId;
    await this._putJson(`pool:${pool.id}`, pool);
    return pool;
  }

  async rotateJoinCode(poolId) {
    const pool = await this.getPool(poolId);
    if (!pool) return null;
    if (pool.joinCode) await this.kv.delete(`code:${normalizeJoinCode(pool.joinCode)}`);
    let joinCode = newJoinCode();
    while (await this.kv.get(`code:${joinCode}`)) joinCode = newJoinCode();
    pool.joinCode = joinCode;
    pool.joinCodeExpiresAt = this.now() + this.joinCodeTtlMs;
    await this._putJson(`pool:${pool.id}`, pool);
    await this.kv.put(`code:${normalizeJoinCode(joinCode)}`, pool.id);
    return pool;
  }

  // -------------------------------------------------------------- devices ---

  async addDevice({
    poolId,
    kind = 'client',
    role = 'member',
    name = null,
    platform = null,
    version = null,
    status = 'pending',
    publicUrl = null,
    machineId = null,
    machineName = null,
    health = {},
    meta = {},
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
      tokenHash: await hashToken(token),
      pairSecret: kind === 'host' ? newPairSecret() : null,
    };
    await this._putJson(`device:${device.id}`, device);
    await this.kv.put(`token:${device.tokenHash}`, device.id);
    await this.kv.put(`pooldev:${poolId}:${device.id}`, '1');
    return { device, token };
  }

  async getDevice(deviceId) {
    if (!deviceId) return null;
    return this._getJson(`device:${deviceId}`);
  }

  async getDeviceByToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const deviceId = await this.kv.get(`token:${await hashToken(token)}`);
    return deviceId ? this.getDevice(deviceId) : null;
  }

  async updateDevice(deviceId, patch) {
    const device = await this.getDevice(deviceId);
    if (!device || !isPlainObject(patch)) return device;
    Object.assign(device, patch);
    await this._putJson(`device:${device.id}`, device);
    return device;
  }

  /**
   * Heartbeats write a separate record on purpose. On the Worker deployment the
   * record lives in D1 (high-frequency writes); the KV path remains for local
   * Node/MemoryKv usage and as a fallback when no D1 binding is available.
   *
   * KV has no transactions, so a read-modify-write of the device record from the
   * 15s heartbeat could race an owner approval and write the old `status:
   * "pending"` back (observed on the first Linux deployment). Keeping liveness
   * separate means only owner actions ever mutate `device:<deviceId>`.
   */
  async recordHeartbeat(deviceId, patch = {}) {
    if (this.liveness) return this.liveness.record(deviceId, patch);
    const key = `hb:${deviceId}`;
    const previous = (await this._getJson(key)) || {};
    const next = {
      ...previous,
      ...patch,
      lastSeenAt: Number.isFinite(patch.lastSeenAt) ? patch.lastSeenAt : this.now(),
    };
    await this._putJson(key, next);
    return next;
  }

  async withHeartbeat(device) {
    if (!device) return null;
    if (this.liveness) {
      return mergeLiveness(device, await this.liveness.get(device.id));
    }
    const hb = await this._getJson(`hb:${device.id}`);
    if (!hb) return device;
    return mergeLiveness(device, hb);
  }

  async listDevices(poolId, { includePending = false } = {}) {
    const visible = (device) =>
      device.status === 'active' || (includePending && device.status === 'pending');
    const { keys } = await this.kv.list({ prefix: `pooldev:${poolId}:` });
    const devices = [];
    for (const key of keys) {
      const deviceId = key.name.slice(`pooldev:${poolId}:`.length);
      const device = await this.getDevice(deviceId);
      if (device) devices.push(device);
    }
    if (!this.liveness) {
      const listed = await Promise.all(devices.map((device) => this.withHeartbeat(device)));
      return listed.filter(visible);
    }
    const heartbeats = await this.liveness.getMany(devices.map((device) => device.id));
    return devices.map((device) => mergeLiveness(device, heartbeats.get(device.id))).filter(visible);
  }
}

function parseJsonObject(raw, fallback = {}) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function poolFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    joinCode: row.join_code,
    joinCodeExpiresAt: row.join_code_expires_at,
    ownerDeviceId: row.owner_device_id ?? null,
  };
}

function deviceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    poolId: row.pool_id,
    kind: row.kind,
    role: row.role,
    name: row.name ?? null,
    platform: row.platform ?? null,
    version: row.version ?? null,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    publicUrl: row.public_url ?? null,
    machineId: row.machine_id ?? null,
    machineName: row.machine_name ?? null,
    health: parseJsonObject(row.health_json),
    meta: parseJsonObject(row.meta_json),
    tokenHash: row.token_hash,
    pairSecret: row.pair_secret ?? null,
  };
}

/**
 * D1-backed metadata repository. This is the production Worker path when
 * FLEET_DB is bound: pools/devices/tokens and high-frequency liveness all live
 * in D1, so free-tier KV write limits cannot break create/join.
 */
export class D1Repository {
  constructor({ db, now = nowMs, joinCodeTtlMs = DEFAULT_JOIN_CODE_TTL_MS, liveness = null }) {
    this.db = db;
    this.now = typeof now === 'function' ? now : () => Number(now);
    this.joinCodeTtlMs = joinCodeTtlMs;
    this.liveness = liveness || new D1Liveness(db, { now: this.now });
  }

  // ---------------------------------------------------------------- pools ---

  async createPool({ name = 'pool' } = {}) {
    const createdAt = this.now();
    let joinCode = newJoinCode();
    while (await this.getPoolByJoinCode(joinCode)) joinCode = newJoinCode();
    const pool = {
      id: newId('pool'),
      name,
      createdAt,
      joinCode,
      joinCodeExpiresAt: createdAt + this.joinCodeTtlMs,
      ownerDeviceId: null,
    };
    await this.db
      .prepare(
        `INSERT INTO pools (id, name, created_at, join_code, join_code_expires_at, owner_device_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(pool.id, pool.name, pool.createdAt, pool.joinCode, pool.joinCodeExpiresAt, null)
      .run();
    return pool;
  }

  async getPool(poolId) {
    if (!poolId) return null;
    const row = await this.db.prepare(`SELECT * FROM pools WHERE id = ?`).bind(poolId).first();
    return poolFromRow(row);
  }

  async getPoolByJoinCode(code) {
    const normalized = normalizeJoinCode(code);
    if (!normalized) return null;
    const row = await this.db.prepare(`SELECT * FROM pools WHERE join_code = ?`).bind(normalized).first();
    return poolFromRow(row);
  }

  isJoinCodeValid(pool) {
    return Boolean(pool && Number.isFinite(pool.joinCodeExpiresAt) && pool.joinCodeExpiresAt > this.now());
  }

  async setPoolOwner(poolId, deviceId) {
    const result = await this.db
      .prepare(`UPDATE pools SET owner_device_id = ? WHERE id = ?`)
      .bind(deviceId, poolId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getPool(poolId);
  }

  async rotateJoinCode(poolId) {
    const pool = await this.getPool(poolId);
    if (!pool) return null;
    let joinCode = newJoinCode();
    while (await this.getPoolByJoinCode(joinCode)) joinCode = newJoinCode();
    const joinCodeExpiresAt = this.now() + this.joinCodeTtlMs;
    await this.db
      .prepare(`UPDATE pools SET join_code = ?, join_code_expires_at = ? WHERE id = ?`)
      .bind(joinCode, joinCodeExpiresAt, poolId)
      .run();
    return this.getPool(poolId);
  }

  // -------------------------------------------------------------- devices ---

  async addDevice({
    poolId,
    kind = 'client',
    role = 'member',
    name = null,
    platform = null,
    version = null,
    status = 'pending',
    publicUrl = null,
    machineId = null,
    machineName = null,
    health = {},
    meta = {},
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
      tokenHash: await hashToken(token),
      pairSecret: kind === 'host' ? newPairSecret() : null,
    };
    await this.db
      .prepare(
        `INSERT INTO devices
           (id, pool_id, kind, role, name, platform, version, status, created_at,
            approved_at, last_seen_at, public_url, machine_id, machine_name,
            health_json, meta_json, token_hash, pair_secret)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        device.id,
        device.poolId,
        device.kind,
        device.role,
        device.name,
        device.platform,
        device.version,
        device.status,
        device.createdAt,
        device.approvedAt,
        device.lastSeenAt,
        device.publicUrl,
        device.machineId,
        device.machineName,
        JSON.stringify(device.health),
        JSON.stringify(device.meta),
        device.tokenHash,
        device.pairSecret,
      )
      .run();
    return { device, token };
  }

  async getDevice(deviceId) {
    if (!deviceId) return null;
    const row = await this.db.prepare(`SELECT * FROM devices WHERE id = ?`).bind(deviceId).first();
    return deviceFromRow(row);
  }

  async getDeviceByToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const row = await this.db
      .prepare(`SELECT * FROM devices WHERE token_hash = ?`)
      .bind(await hashToken(token))
      .first();
    return deviceFromRow(row);
  }

  async updateDevice(deviceId, patch) {
    const device = await this.getDevice(deviceId);
    if (!device || !isPlainObject(patch)) return device;
    const next = { ...device, ...patch };
    await this.db
      .prepare(
        `UPDATE devices SET
           pool_id = ?, kind = ?, role = ?, name = ?, platform = ?, version = ?,
           status = ?, created_at = ?, approved_at = ?, last_seen_at = ?,
           public_url = ?, machine_id = ?, machine_name = ?, health_json = ?,
           meta_json = ?, token_hash = ?, pair_secret = ?
         WHERE id = ?`,
      )
      .bind(
        next.poolId,
        next.kind,
        next.role,
        next.name,
        next.platform,
        next.version,
        next.status,
        next.createdAt,
        next.approvedAt,
        next.lastSeenAt,
        next.publicUrl,
        next.machineId,
        next.machineName,
        JSON.stringify(next.health || {}),
        JSON.stringify(next.meta || {}),
        next.tokenHash,
        next.pairSecret,
        deviceId,
      )
      .run();
    return next;
  }

  async recordHeartbeat(deviceId, patch = {}) {
    return this.liveness.record(deviceId, patch);
  }

  async withHeartbeat(device) {
    if (!device) return null;
    return mergeLiveness(device, await this.liveness.get(device.id));
  }

  async listDevices(poolId, { includePending = false } = {}) {
    // One round trip instead of devices + liveness.getMany(). The status filter
    // is in SQL so revoked test rows do not get read on every client poll.
    const statusClause = includePending ? "d.status IN ('active', 'pending')" : "d.status = 'active'";
    const { results = [] } = await this.db
      .prepare(
        `SELECT d.*,
                l.device_id AS liveness_device_id,
                l.last_seen_at AS liveness_last_seen_at,
                l.public_url AS liveness_public_url,
                l.version AS liveness_version,
                l.health_json AS liveness_health_json,
                l.machine_id AS liveness_machine_id,
                l.machine_name AS liveness_machine_name
           FROM devices d
           LEFT JOIN device_liveness l ON l.device_id = d.id
          WHERE d.pool_id = ? AND ${statusClause}`,
      )
      .bind(poolId)
      .all();
    return results.map((row) => mergeLiveness(deviceFromRow(row), livenessFromJoinedRow(row)));
  }
}

export function createRepository({ kv, now = nowMs }) {
  return new Repository({ kv, now });
}
