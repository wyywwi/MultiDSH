# @multidsh/directory

MultiDSH **Directory** service (M0): the registry every MultiDSH client, host sidecar and
desktop app talks to. It implements [`PROTOCOL.md`](../protocol/PROTOCOL.md) §3 with
Node built-ins only — no dependencies, no build step, plain ESM.

It manages:

- pools (a group of devices, addressed by `pool_<hex12>`),
- human-typed 8-character join codes (24h TTL, rotatable),
- device membership: `pending` → `active` → `revoked`,
- bearer-token device auth (only `sha256(token)` and, for hosts, the `pairSecret` are stored),
- heartbeats / last-seen tracking,
- pairing URLs: the Directory signs a short-lived nonce with a host's `pairSecret`; the
  host sidecar verifies it before handing out a dsh token.

## Layout

| File | Purpose |
|---|---|
| `bin.js` | CLI: listen on `--port`/`--host`, persist to `--data`. |
| `src/app.js` | `createApp({ dataPath, now })` → `{ server, store }`; all HTTP routes. |
| `src/store.js` | JSON-file store, sync load, atomic write (tmp file + rename), token-hash index. |
| `test/directory.test.mjs` | `node:test` suite (temp dirs, ephemeral ports). |

## Run

From the `multidsh/` directory (bundled Node is not on PATH):

```powershell
# start on http://127.0.0.1:8787, state in .tmp/dir-smoke
.\bin\node.cmd packages\directory\bin.js --port 8787 --data .tmp\dir-smoke

# --port 0 picks a free port and prints the actual one
.\bin\node.cmd packages\directory\bin.js --port 0 --data .tmp\dir-smoke
```

Output:

```
multidsh directory listening on http://127.0.0.1:8787
```

`Ctrl+C` (SIGINT) or SIGTERM stops accepting connections and flushes state before exit.
`--data` may be a directory (state file `<dir>/directory.json`) or an explicit `*.json`
file. The file is rewritten atomically (`<file>.tmp.<pid>.<rand>` + `rename`) after each
mutation, so a crash cannot leave a half-written state file.

Node (`node` ≥ 20) is also fine if you have it on PATH:

```powershell
node packages/directory/bin.js --port 8787 --data .tmp/dir-smoke
```

## Test

```powershell
# from multidsh/
.\bin\node.cmd --test packages\directory\test
```

16 tests, everything on temp dirs and `server.listen(0)`; the server and temp dirs are
always closed/removed. (The bundled Node v24.21 does not expand a *directory* passed to
`--test`; `test/package.json` has `"main": "directory.test.mjs"` so the directory resolves
to the suite. `.\bin\node.cmd --test packages\directory\test\directory.test.mjs` works too.)

## API

All bodies are JSON, all responses are JSON with `Cache-Control: no-store`, and all
errors look like `{ "error": { "code": "...", "message": "..." } }`.
Authenticated routes use `Authorization: Bearer <deviceToken>`; the token is returned
only once at pool creation / join time.

### GET /api/health

```powershell
curl.exe http://127.0.0.1:8787/api/health
# {"ok":true,"app":"MultiDSH","protocol":1,"time":1792500000000}
```

### POST /api/pools — create a pool (creator becomes owner)

```powershell
curl.exe -s -X POST http://127.0.0.1:8787/api/pools -H "Content-Type: application/json" `
  -d '{\"name\":\"home\",\"deviceName\":\"user-win\",\"platform\":\"win32\"}'
```

→ `201`

```json
{
  "pool": {
    "id": "pool_1234abcd5678",
    "name": "home",
    "createdAt": 1792500000000,
    "joinCode": "7K3M9Q2X",
    "joinCodeExpiresAt": 1792586400000,
    "ownerDeviceId": "dev_ab12cd34ef56"
  },
  "device": { "id": "dev_ab12cd34ef56", "kind": "client", "role": "owner", "status": "active", "...": "..." },
  "deviceToken": "mdt_..."
}
```

### POST /api/pools/join — join with a pool code (always `pending`)

```json
{
  "code": "7k3m-9q2x",
  "kind": "host",
  "name": "win-01",
  "platform": "win32",
  "version": "0.1.0",
  "publicUrl": "http://127.0.0.1:4092"
}
```

→ `202 { "device": {...}, "deviceToken": "mdt_...", "pairSecret": "mps_..." }`

- The code is normalized (case/`-`/spaces insensitive, Crockford `I/L/O/U` aliases).
- `pairSecret` is returned **only** for `kind: "host"`.
- Errors: `404 pool_code_invalid`, `410 pool_code_expired`.

### GET /api/pools/:poolId/devices[?includePending=1]

Auth: any active member. Non-owners only ever get `active` devices; the owner can add
pending ones with `includePending=1`. Revoked devices are never listed.

→ `200 { "devices": [ ...Device ] }`

A device is `online` when its `lastSeenAt` is within 90 s (clients compute this).

```powershell
curl.exe -s "http://127.0.0.1:8787/api/pools/pool_1234abcd5678/devices?includePending=1" `
  -H "Authorization: Bearer mdt_..."
```

### POST /api/pools/:poolId/devices/:deviceId/approve

Auth: owner. → `200 { "device": { "...": "status=active, approvedAt=..." } }`
(unknown device → `404 device_not_found`; revoked device → `409 device_revoked`).

### POST /api/pools/:poolId/devices/:deviceId/revoke

Auth: owner. → `200 { "device": { "...": "status=revoked" } }`.
A revoked device gets `403 device_revoked` on heartbeat and is invisible to everyone.

### POST /api/pools/:poolId/join-code/rotate

Auth: owner. → `200 { "joinCode": "NEWCODE1", "joinCodeExpiresAt": 1792586400000 }`.
The previous code stops working immediately (`404 pool_code_invalid`).

### POST /api/heartbeat

Auth: any device in the pool — pending devices may heartbeat too.

```json
{ "version": "0.1.0", "publicUrl": "http://127.0.0.1:4092", "health": { "runningSessions": 0, "dshPort": 3080 } }
```

→ `200 { "ok": true, "status": "active", "device": {...} }`
Recommended interval 15 s; 90 s without a heartbeat means offline. Revoked device → `403 device_revoked`.

### POST /api/pools/:poolId/pair — get a host pairing URL

Auth: active `client` device in the pool. Body `{ "hostId": "dev_..." }`.

→ `200`

```json
{ "url": "http://127.0.0.1:4092/__fleet/pair?nonce=...", "online": true }
```

The nonce is `base64url(payload) + "." + base64url(HMAC-SHA256(pairSecret, payload))` with
payload `{ v: 1, hostId, clientId, exp: now + 120000, jti }`. `online` is `false` when the
host has not heartbeat within 90 s (the URL is still returned). Errors: `404 host_not_found`,
`409 host_not_active`.

## Error codes

| HTTP | code | when |
|---|---|---|
| 400 | `invalid_json` | body is not valid JSON / not a JSON object |
| 400 | `invalid_request` | e.g. bad `kind`, missing `hostId` |
| 401 | `unauthorized` | missing/unknown bearer token |
| 403 | `forbidden` | wrong role, cross-pool access, wrong device kind |
| 403 | `device_pending` | pending device tried a member-only operation |
| 403 | `device_revoked` | revoked device tried to act |
| 404 | `pool_not_found`, `device_not_found`, `host_not_found`, `not_found` | |
| 404 | `pool_code_invalid` | unknown/rotated pool code |
| 409 | `host_not_active` | host is pending/revoked or missing `publicUrl`/`pairSecret` |
| 410 | `pool_code_expired` | code older than 24 h |
| 413 | `payload_too_large` | JSON body > 1 MB |
| 405 | `method_not_allowed` | known path, wrong HTTP method |

## M0 notes / deviations

- No deviations from `PROTOCOL.md` §2/§3 are known.
- As documented in PROTOCOL §7, the Node store keeps the pool `joinCode` and host
  `pairSecret` in plaintext in the local state file. Device bearer tokens are **never**
  stored, only `sha256(token)`; the plaintext token exists only in the join/create response.
- Pairing nonces are signed by the Directory but replay protection (`jti`) is the host
  sidecar's job.
- No CORS headers: the Directory is called by native/Electron-main-process and sidecars.
- `createApp()` and the store load state synchronously so tests can get a ready
  non-listening `http.Server` and call `listen(0)` directly.
