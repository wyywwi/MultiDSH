# MultiDSH Protocol v1 (M0)

所有服务之间只交换 JSON（配对跳转除外）。本文是 Directory、Host sidecar、桌面端三方共同的契约；实现必须与此一致，改动需同步更新本文件。

## 1. 约定

- 时间戳：Unix 毫秒（number）。
- 认证：`Authorization: Bearer <deviceToken>`；设备令牌只在加入池时返回一次，服务端只存 `sha256(token)`。
- 错误响应统一为 `{ "error": { "code": "...", "message": "..." } }`，HTTP 状态码见各接口。
- 标识符：`pool_<hex12>`、`dev_<hex12>`、`jti_<hex12>`；设备令牌 `mdt_...`；主机配对密钥 `mps_...`。
- 池码：8 位 Crockford base32（去掉 I/L/O/U），24 小时有效，可轮换。
- 配对 nonce：`base64url(payload) + "." + base64url(HMAC-SHA256(pairSecret, base64url(payload)))`，payload 为 `{v:1, hostId, clientId, exp, jti}`。
- 所有响应 `Cache-Control: no-store`。

## 2. 数据形状

### Device（对外，永不含 tokenHash / pairSecret）

```json
{
  "id": "dev_ab12cd34ef56",
  "poolId": "pool_1234abcd5678",
  "kind": "host",
  "role": "member",
  "name": "win-01",
  "platform": "win32",
  "version": "0.1.0",
  "status": "pending",
  "createdAt": 1792500000000,
  "approvedAt": null,
  "lastSeenAt": null,
  "publicUrl": "https://win01-9f3a2c7d.fleet.example.com",
  "machineId": "machine_9f3a2c7d1b4e6a80",
  "machineName": "user-desktop",
  "health": { "runningSessions": 0, "dshPort": 3080 },
  "meta": {}
}
```

- `kind`：`host` | `client`
- `role`：`owner` | `member`（创建池的设备是 owner）
- `status`：`pending` | `active` | `revoked`
- `publicUrl`：仅 host 使用，指向该 host 的 `/__fleet` 可达根（本地联调为 `http://127.0.0.1:4092`）
- `machineId` / `machineName`：可选。同一台物理机器上多个 host profile 共享同一个 `machineId`，客户端据此把多个 host 归到一台机器下展示。旧设备可以没有这两个字段，客户端会按单台主机降级显示；host 后续心跳带上后即可补全。
- pending 设备对其他成员不可见、不可配对；owner 可见并可审批。

### Pool

```json
{
  "id": "pool_1234abcd5678",
  "name": "home",
  "createdAt": 1792500000000,
  "joinCode": "7K3M9Q2X",
  "joinCodeExpiresAt": 1792586400000,
  "ownerDeviceId": "dev_ab12cd34ef56"
}
```

## 3. Directory HTTP API

Base URL 由部署决定（本地联调 `http://127.0.0.1:8787`）。

### GET /api/health

→ `200 { "ok": true, "app": "MultiDSH", "protocol": 1, "time": 1792500000000 }`

### POST /api/pools

创建池，创建者成为 owner（kind=client）。

请求：

```json
{ "name": "home", "deviceName": "user-win", "platform": "win32" }
```

→ `201`

```json
{
  "pool": { "id": "...", "name": "home", "joinCode": "7K3M9Q2X", "joinCodeExpiresAt": 1792586400000 },
  "device": { "...Device": "owner, active" },
  "deviceToken": "mdt_..."
}
```

### POST /api/pools/join

凭池码加入。新设备一律 `pending`，必须由 owner 审批。

请求：

```json
{ "code": "7K3M9Q2X", "kind": "host", "name": "win-01", "platform": "win32", "version": "0.1.0", "publicUrl": "http://127.0.0.1:4092", "machineId": "machine_9f3a2c7d1b4e6a80", "machineName": "user-desktop" }
```

→ `202`

```json
{
  "device": { "...Device": "pending" },
  "deviceToken": "mdt_...",
  "pool": { "id": "pool_...", "name": "home" },
  "pairSecret": "mps_..."
}
```

- `pairSecret` **仅 kind=host 返回**，用于 sidecar 本地校验配对 nonce。
- `pool` 仅包含 `id` 和 `name`，供加入方显示池名；不含 join code。
- 错误：`404 pool_code_invalid`、`410 pool_code_expired`。

### GET /api/pools/:poolId/devices

认证：该池任意 active 成员。

查询参数：`includePending=1`（仅 owner 有效）。

→ `200 { "devices": [ ...Device ] }`

- 非 owner 只返回 active 设备。
- 在线判定：`lastSeenAt` 在 90 秒内视为在线（客户端自行计算）。

### POST /api/pools/:poolId/devices/:deviceId/approve

认证：owner。→ `200 { "device": { ...active } }`

### POST /api/pools/:poolId/devices/:deviceId/revoke

认证：owner。→ `200 { "device": { ...revoked } }`

### POST /api/pools/:poolId/join-code/rotate

认证：owner。→ `200 { "joinCode": "...", "joinCodeExpiresAt": ... }`

### POST /api/heartbeat

认证：任意设备（pending 也可以心跳，便于 owner 看到待审批设备的存活）。

请求：

```json
{ "version": "0.1.0", "publicUrl": "https://win01-...", "machineId": "machine_9f3a2c7d1b4e6a80", "machineName": "user-desktop", "health": { "runningSessions": 0, "dshPort": 3080 } }
```

→ `200 { "ok": true, "status": "active", "device": { ...Device } }`

- 被吊销的设备返回 `403 device_revoked`。
- `machineId` / `machineName` 可选；host 每次心跳携带，旧设备可借此补全机器信息。
- 心跳间隔建议 15 秒；90 秒未心跳视为离线。

### POST /api/pools/:poolId/pair

认证：该池 active client。请求 `{ "hostId": "dev_..." }`。

→ `200`

```json
{ "url": "http://127.0.0.1:4092/__fleet/pair?nonce=...", "online": true }
```

- Directory 用该 host 的 `pairSecret` 签 nonce（`exp = now + 120s`）。
- `online: false` 表示 host 超过 90 秒未心跳，URL 仍返回（客户端可提示）。
- 错误：`404 host_not_found`、`409 host_not_active`。

## 4. Host sidecar Admin API

监听 `127.0.0.1:<adminPort>`（默认 4080），只允许本机访问；路径前缀 `/__fleet`。

### GET /__fleet/health

```json
{
  "ok": true,
  "deviceId": "dev_...",
  "poolId": "pool_...",
  "status": "active",
  "dsh": { "pid": 1234, "port": 3080, "tokenCaptured": true, "startedAt": 1792500000000, "restarts": 0 },
  "directory": { "url": "http://127.0.0.1:8787", "lastHeartbeatAt": 1792500000000, "lastError": null }
}
```

### GET /__fleet/pair?nonce=...

校验 nonce（签名、exp、hostId、jti 未使用）后：

- 成功 → `303 Location: /?token=<dshToken>`（token 只在此刻出现一次）
- 失败 → `400 pair_invalid`；过期 → `410 pair_expired`
- 响应头 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`

### GET /__fleet/events

SSE 流（M0 占位）：连接后发送 `event: hello` + `data: {...}`，之后每 15 秒发送注释 `: ping`。桌面端 M0 不依赖它。

## 5. 配对时序

```
Desktop(client)            Directory                 Host sidecar            dsh web
     |  POST /pools/:id/pair  |                          |                     |
     |----------------------->|  sign nonce(pairSecret)  |                     |
     |<---- {url} ------------|                          |                     |
     |  GET {url} (WebContentsView)                       |                     |
     |--------------------------------------------------->|  verify nonce       |
     |<------------------- 303 /?token=dsh... ------------|                     |
     |  GET /?token=...                                   |                     |
     |----------------------------------------------------|-------------------->|
     |<------------------- 303 + Set-Cookie dsh-auth-* ---|                     |
     |  GET /  (带 Cookie)                                 |                     |
     |<---------------------------------------------------| 完整 DSH UI --------|
```

## 6. 本地联调约定（E2E 使用）

| 组件 | 端口 / URL |
|---|---|
| Directory | `http://127.0.0.1:8787` |
| dsh web | `127.0.0.1:3092` |
| host sidecar admin | `http://127.0.0.1:4092`（即 host `publicUrl`） |
| 临时 DSH_HOME | `multidsh/.tmp/dshhome-e2e` |

E2E 流程：创建池 → host 加入（pending）→ owner 审批 → heartbeat → 设备列表出现 active host → pair 拿 URL → 请求 URL 得到 303 + `Location: /?token=` → 用该 token 请求 `/?token=` 得到 `Set-Cookie: dsh-auth-*`。

## 7. M0 已知简化

- Directory 的 Node 实现把池码、`pairSecret` 以明文存本地 JSON（后续 Worker/D1 版本加密或改用签名密钥）。
- 没有会话摘要、事件推送、快速派发（M3）。
- 桌面端只做设备列表、审批、打开 host、轮询状态。
