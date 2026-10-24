-- Directory metadata. Pool/device/token rows live here so create/join/approval
-- are not limited by Workers KV's free tier (1,000 writes/day).
CREATE TABLE IF NOT EXISTS pools (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  join_code           TEXT NOT NULL,
  join_code_expires_at INTEGER NOT NULL,
  owner_device_id     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pools_join_code
  ON pools (join_code);

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  pool_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  role          TEXT NOT NULL,
  name          TEXT,
  platform      TEXT,
  version       TEXT,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,
  last_seen_at  INTEGER,
  public_url    TEXT,
  machine_id    TEXT,
  machine_name  TEXT,
  health_json   TEXT NOT NULL DEFAULT '{}',
  meta_json     TEXT NOT NULL DEFAULT '{}',
  token_hash    TEXT NOT NULL,
  pair_secret   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token_hash
  ON devices (token_hash);

CREATE INDEX IF NOT EXISTS idx_devices_pool
  ON devices (pool_id);

CREATE INDEX IF NOT EXISTS idx_devices_pool_status
  ON devices (pool_id, status);

CREATE TABLE IF NOT EXISTS device_liveness (
  device_id    TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  public_url   TEXT,
  version      TEXT,
  health_json  TEXT,
  machine_id   TEXT,
  machine_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_liveness_last_seen
  ON device_liveness (last_seen_at);
