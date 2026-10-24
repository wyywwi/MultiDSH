# 在 Cloudflare 上部署 Directory

Directory 是 MultiDSH 的控制面：保存池、设备、池码、设备 token、host 的 pairSecret 和在线心跳。它必须有一个所有客户端都能访问的 HTTPS 地址。

> **本项目不提供公共 Directory 实例。** 每个部署都需要自己的 Cloudflare 账号和一个可访问的 HTTPS 地址。小团队可以共用一个自建实例。

当前实现使用 **Cloudflare Workers + D1**，不依赖 Workers KV，所以没有 KV 每日写入额度问题。

## 1. 需要准备什么

- 一个 Cloudflare 账号；
- 一个已接入 Cloudflare 的域名（可选但推荐；也可以先用 `*.workers.dev` 地址）；
- Node.js 22 或 24；
- 本仓库源码；
- 一个终端。

部署完成后你会得到一个 Directory 地址，例如：

```text
https://multidsh.example.com
```

客户端和 Linux host 的 `--directory` 都填这个地址。

## 2. 推荐：Wrangler 部署

### 2.1 登录 Cloudflare

```bash
cd multidsh/packages/directory-worker
npx wrangler login
```

浏览器会打开 Cloudflare 授权页，登录你的账号并授权。

### 2.2 创建 D1 数据库

```bash
npx wrangler d1 create multidsh_directory
```

输出里会有一段：

```toml
[[d1_databases]]
binding = "FLEET_DB"
database_name = "multidsh_directory"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

把 `database_id` 填到本目录的 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "FLEET_DB"
database_name = "multidsh_directory"
database_id = "你的 D1 UUID"
```

> D1 免费版足够个人/小团队使用；30 秒心跳约 2,880 行写入/天/台。

### 2.3 建表

```bash
npx wrangler d1 execute multidsh_directory --file schema.sql --remote
```

这会在 D1 中创建：

- `pools`
- `devices`
- `device_liveness`

不需要 KV，也不需要任何初始数据。

### 2.4 部署 Worker

```bash
npx wrangler deploy
```

成功后会输出类似：

```text
Published multidsh-directory
  https://multidsh-directory.<your-subdomain>.workers.dev
```

这个 `workers.dev` 地址已经可以用于测试。可以直接把它作为 Directory URL，也可以继续配置自定义域。

### 2.5 配置自定义域（推荐）

在 Cloudflare Dashboard：

```text
Workers & Pages
  → multidsh-directory
  → Settings
  → Domains & Routes
  → Add → Custom domain
  → multidsh.example.com
```

Cloudflare 会自动创建 DNS 记录并签发证书。等状态变成 Active 后验证：

```bash
curl -fsS https://multidsh.example.com/api/health
```

应返回：

```json
{"ok":true,"app":"MultiDSH","protocol":1,"time":...}
```

也可以直接在 `wrangler.toml` 里配置自定义域（把域名换成自己的）：

```toml
routes = [
  { pattern = "multidsh.example.com", custom_domain = true }
]
```

然后重新 `npx wrangler deploy`。

### 2.6 检查部署

```bash
curl -i https://multidsh.example.com/api/health
```

- `200` + JSON：成功；
- `404`：域名指向了别的 Worker，或路由没生效；
- `500`：检查 D1 binding 名称是否为 `FLEET_DB`，以及 schema 是否已执行；
- `522/523`：DNS/源站问题，通常不是 Worker 代码。

## 3. 更新部署

代码更新后：

```bash
cd multidsh/packages/directory-worker
npx wrangler deploy
```

如果 `schema.sql` 有新增表/字段，再执行一次：

```bash
npx wrangler d1 execute multidsh_directory --file schema.sql --remote
```

`schema.sql` 使用 `CREATE TABLE IF NOT EXISTS`，重复执行安全。

## 4. 纯 Dashboard 部署（不想用命令行）

适合只需要部署一次、不想装 Wrangler 的情况：

1. Cloudflare Dashboard → **Workers & Pages → D1 → Create database**，名称 `multidsh_directory`；
2. 打开数据库 → **Console**，把 `packages/directory-worker/schema.sql` 的内容粘贴执行（如果 Console 不支持多语句，就按 `CREATE TABLE` / `CREATE INDEX` 逐条执行）；
3. **Workers & Pages → Create → Worker**，名称 `multidsh-directory`；
4. 编辑 Worker，把 `packages/directory-worker/dist/worker.js` 的内容粘贴进去；
5. Worker → **Settings → Bindings → Add → D1 database**：
   - Variable name: `FLEET_DB`
   - D1 database: `multidsh_directory`
6. Deploy；
7. **Settings → Domains & Routes → Add custom domain**；
8. 用 `/api/health` 验证。

`dist/worker.js` 是构建产物；可以在仓库根目录运行：

```bash
node scripts/bundle-worker.mjs
```

生成后再复制。

> Dashboard 方式更容易漏掉 D1 绑定；如果 health 正常但 create/join 500，优先检查 `FLEET_DB`。

## 5. 客户端指向新的 Directory

部署完成后，把客户端和 Linux 安装器的 Directory 地址改成你的地址：

### Linux 安装器

```bash
./install.sh --yes \
  --directory https://multidsh.example.com \
  --pool-code <池码> \
  --name linux-01 \
  --public-url https://dsh-01.example.com
```

### Windows 桌面端

设置 → Directory 地址，填入：

```text
https://multidsh.example.com
```

### Android

在 Android 客户端的 Directory 输入框中改成同一个地址。

## 6. 数据、备份与限制

- D1 数据库：`multidsh_directory`；
- 表：`pools`、`devices`、`device_liveness`；
- 备份：Cloudflare Dashboard → D1 → 数据库 → **Export**（或使用 `wrangler d1 export`）；
- D1 免费额度：100,000 行写入/天、5,000,000 行读取/天；
- 30 秒心跳 = 2,880 行/天/台，适合几十台以内；
- 不需要 Workers KV。

## 7. 安全建议

- Directory 只存元数据和 token hash，不存会话内容；
- `deviceToken` 只在创建时返回一次；`pairSecret` 只给 host；
- 生产环境使用 HTTPS；
- 公网部署建议设置创建密钥：`npx wrangler secret put CREATE_POOL_KEY`，并在客户端创建池时填写同一个密钥；
- `POST /api/pools` 和 `POST /api/pools/join` 是公开端点；Worker 已内置创建池/加入池限流，公网实例仍建议再加 Cloudflare WAF 速率规则；
- 可给 Directory 加 Cloudflare 速率限制/WAF，但不要阻止 `/api/health`；
- 不要把 D1 数据库直接暴露成公共 API；只通过 Worker 访问；
- Cloudflare 账号开启 MFA，Wrangler 登录态不要提交到仓库。
