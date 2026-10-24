# MultiDSH Directory on Cloudflare Workers

与 `packages/directory`（Node 版）**同一套 HTTP API**（见 [`../protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) §3）的 Worker 实现。
**部署后的地址示例：https://multidsh.example.com**（Worker `multidsh-directory` + D1 `multidsh_directory` + 自定义域）。

- `src/app.js`：纯 `Request -> Response` 路由，不依赖 Node 内置模块，Node 下可直接测试；
- `src/crypto.js`：WebCrypto 版 id / token / 池码 / HMAC nonce，**线格式与 `packages/protocol` 完全一致**（Host sidecar 用 Node 版 `verifyNonce` 验签，测试里有交叉验证）；
- `src/storage.js`：D1 仓储（pool/device/token/liveness）；无 D1 的本地开发退回内存；
- `src/index.js`：Worker 入口，`env.FLEET_DB` 存在时用 D1Repository；本地无 binding 时用内存仓库；
- `schema.sql`：D1 `pools` / `devices` / `device_liveness` 表；
- `bin.js`：本地 Node 适配器，把同一 fetch handler 挂到 `node:http`，让 E2E / 桌面端无需 Cloudflare 账号即可联调；
- `wrangler.toml`：D1 绑定模板；`test/worker.test.mjs`、`test/d1-liveness.test.mjs`、`test/d1-repository.test.mjs`。

## 本地跑

```powershell
cd multidsh
.\bin\node.cmd packages\directory-worker\bin.js --port 8788
# 另开终端
Invoke-RestMethod http://127.0.0.1:8788/api/health
```

与 E2E 联合验证（Worker 目录 + 真实 Host sidecar + 真实 dsh）：

```powershell
.\bin\node.cmd scripts\e2e.mjs --worker
.\bin\node.cmd scripts\e2e.mjs --directory https://multidsh.example.com   # 换成你的实例地址
.\bin\node.cmd scripts\e2e-desktop.mjs --worker   # 再带桌面端完整链路
```

单元测试：

```powershell
.\bin\node.cmd --test packages\directory-worker\test\worker.test.mjs
.\bin\node.cmd --test packages\directory-worker\test\d1-liveness.test.mjs
.\bin\node.cmd --test packages\directory-worker\test\d1-repository.test.mjs
```

## 部署到 Cloudflare

完整的 Wrangler / Dashboard 教程见 [`docs/CLOUDFLARE-DEPLOY.md`](../../docs/CLOUDFLARE-DEPLOY.md)。最短 Wrangler 路径：

```bash
cd multidsh/packages/directory-worker
npx wrangler login
npx wrangler d1 create multidsh_directory      # 把返回的 uuid 填进 wrangler.toml
npx wrangler d1 execute multidsh_directory --file schema.sql --remote
npx wrangler deploy
```

`wrangler.toml` 只绑定 D1 `FLEET_DB`；生产部署不使用 KV。

### 防止公开端点被刷

`POST /api/pools`（创建池）和 `POST /api/pools/join`（用池码加入）按设计不需要登录，所以任何人都能调用。Worker 已加两层限流：

- 创建池：每个 IP / Cloudflare 位置约 3 次/分钟；
- 加入池：每个 IP / Cloudflare 位置约 10 次/分钟。

限流使用 Workers Rate Limiting binding（免费、不写 D1），配置在 `wrangler.toml` 的 `[[ratelimits]]`。  
它是近似限流，不能替代 Cloudflare WAF；如果公网实例被持续刷，建议再加 WAF 速率规则或改成邀请制/私有部署。

### 创建池密钥

公网部署建议再设置：

```bash
npx wrangler secret put CREATE_POOL_KEY
```

设置后，`POST /api/pools` 必须带请求头：

```http
x-multidsh-create-key: <你设置的密钥>
```

没有设置该 secret 时，创建池保持开放（适合本地/自建）。客户端在创建池时需要填写同一个密钥；密钥只保存在客户端本机配置里。

本仓库维护者也可以用本机 Cloudflare MCP 自动部署：

```powershell
.\bin\node.cmd scripts\bundle-worker.mjs --check
.\bin\node.cmd scripts\cf-deploy.mjs    # 建/复用 D1、执行 schema、上传 Worker、挂自定义域
```

`wrangler dev` 在没有 D1 binding 时会退回内存存储，重启即丢数据，仅用于冒烟。

## D1 表布局

```sql
pools(id PK, name, created_at, join_code UNIQUE, join_code_expires_at, owner_device_id)
devices(id PK, pool_id, kind, role, name, platform, version, status,
        created_at, approved_at, last_seen_at, public_url, machine_id,
        machine_name, health_json, meta_json, token_hash UNIQUE, pair_secret)
device_liveness(device_id PK, last_seen_at, public_url, version,
                health_json, machine_id, machine_name)
```

- `token_hash` 是设备 token 的 SHA-256，token 明文只在创建时返回一次；
- `pair_secret` 只对 host 有值；
- `device_liveness` 由 30 秒心跳 upsert，避免每次心跳改写 `devices` 行；
- `createPool` / `join` / `approve` / `revoke` / `rotate` 全部走 D1；
- 生产读写全部走 D1；无 D1 的本地开发退回 per-isolate 内存，仅用于冒烟。

## 已知限制

- D1 免费版为 100,000 行写入/天、5,000,000 行读取/天；30 秒心跳约 2,880 行/天/台，适合几十台以内的个人/小团队部署。
- 没有速率限制 / WAF 规则（Cloudflare 侧后续加），没有跨池审计日志。
- 池码过期只靠 `joinCodeExpiresAt` 判断，不清理旧记录。
- 没有分页（池内设备数默认 ≤10）。
- 无 D1 的本地 `wrangler dev` 会退回 per-isolate 内存，重启即丢数据，仅用于冒烟。

## 与 Node 版的差异

| 项 | Node 版 | Worker 版 |
|---|---|---|
| 存储 | JSON 文件 + 原子写 | D1（pool/device/token/liveness） |
| 加密 | node:crypto / Buffer | WebCrypto / Uint8Array |
| 部署 | 单进程 | Cloudflare 边缘 |
| 配对 nonce | HMAC-SHA256 | HMAC-SHA256（同一线格式，交叉测试通过） |
