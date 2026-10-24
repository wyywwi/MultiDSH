# 一台机器跑多个 host（多 DSH 实例 / 多版本 / 多插件）

MultiDSH 的 host 是**独立进程**：每个 host 有自己的 Directory 设备身份、管理端口、DSH 端口、
`DSH_HOME`，并启动自己的 `dsh web` 子进程。因此**同一台 Linux 服务器可以同时跑多个 host**，
Directory 仍为每个 host 保存一条独立设备记录（独立审批/吊销/配对）；桌面端会按
`machineId` 把它们归到同一台物理机器下，展开为该机器的多个 DSH 实例，每条仍可单独打开。

典型用途：

- **不同 DSH 版本**：一个 stable、一个 rc，或旧版本做回归；
- **不同插件组合**：例如原版 DSH + 装了 DSH-Purge 的修改版，互不影响；
- **不同工作区/数据**：每个实例独立的 `DSH_HOME`（会话、配置、凭据隔离）；
- **灰度/对照**：同一池里并排比较两个实例的行为。

## 用 CLI 创建（推荐）

`multidsh` CLI 的 profile 就是“一台机器上的一个 host”：

```bash
cd ~/multidsh
chmod +x multidsh

# 准备两个独立的 DSH 版本/目录（示例；也可以是同一版本 + 不同插件）
# ~/dsh-vanilla/node_modules/@deepseek-ai/dsh/lib/bin.js
# ~/dsh-purge/node_modules/@deepseek-ai/dsh/lib/bin.js

# 创建两个 profile；池码同一个即可（owner 需要分别审批两个设备）
./multidsh init            # 交互向导，第一次会问 Directory/池码/名字/dsh bin…
./multidsh init            # 第二次换一个名字，dsh bin 指向另一个版本

# 或者直接非交互：
./multidsh init --yes --name vanilla --pool-code ABCD1234 \
  --dsh-bin ~/dsh-vanilla/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --dsh-home ~/.multidsh/instances/vanilla/dsh-home
./multidsh init --yes --name purge --pool-code ABCD1234 \
  --dsh-bin ~/dsh-purge/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --dsh-home ~/.multidsh/instances/purge/dsh-home

# 端口默认自动从 4080/3080 起找空闲，也可以显式指定：
#   --admin-port 4280 --dsh-port 3280
#   --admin-port 4281 --dsh-port 3281

./multidsh list
./multidsh start vanilla
./multidsh start purge
./multidsh status
```

在 MultiDSH 客户端里批准两个 `pending` 设备后，它们会分别变成在线主机；桌面端会把它们显示为
一台机器（`machineId` 相同）下的两个 DSH 条目，点各自的「打开」进入自己的 DSH UI。

## 隔离边界

| 资源 | 是否隔离 | 说明 |
|---|---|---|
| Directory 设备身份（deviceId/token/pairSecret） | ✅ 每个 host 独立 | 一个 profile 一个设备记录；吊销一个不影响另一个 |
| `admin` / `dsh` 端口 | ✅ 必须不同 | CLI 自动 +1 找空闲；手工指定时冲突会报错 |
| `DSH_HOME` | ✅ 每个 profile 独立 | 会话、插件配置、凭据都不共享 |
| DSH 版本 / 插件 | ✅ 由各自 `--dsh-bin` 决定 | 每个 host 启动自己的 `dsh web`，进程级隔离 |
| CPU / 内存 | ❌ 共享 | 每个 DSH 实例都占资源；大模型/终端任务按需分配 |
| 系统重启 | 每个 profile 一个 systemd unit | 见下 |

## systemd（无桌面服务器）

一个 profile 一个 unit（`multidsh init` 生成的配置默认在
`~/.multidsh/instances/<name>/host.json`）：

```ini
[Service]
ExecStart=/home/<USER>/multidsh-runtime/node-v24.21.0-linux-x64/bin/node \
  /home/<USER>/multidsh/packages/host/bin.js run \
  --config /home/<USER>/.multidsh/instances/vanilla/host.json
```

复制 [`scripts/multidsh-host.service.example`](../scripts/multidsh-host.service.example)
成 `multidsh-host-vanilla.service` / `multidsh-host-purge.service`，分别填不同
`--config`/日志路径即可。

## 网络（publicUrl / Cloudflare Tunnel）

每个 host 都有自己的 `publicUrl`。如果客户端不在同一台机器/局域网，需要让每个 host 的
管理端口被客户端访问到：

- 一个 Tunnel 服务两个 host：给每个 host 配一个 hostname ingress，例如
  `vanilla.example.com -> 127.0.0.1:4280`、`purge.example.com -> 127.0.0.1:4281`；
- 创建 profile 时把 `--public-url` 填成对应 hostname（不要用 `127.0.0.1`，否则客户端
  在另一台机器打不开）；
- Directory 的 `/pair` 会返回该 host 的 `publicUrl`，客户端据此打开对应的 DSH UI。

## 桌面端如何分组

每个 host profile 首次 `init` 时会读取（或生成）`~/.multidsh/machine.json`：

```json
{ "id": "machine_9f3a2c7d1b4e6a80", "name": "user-desktop" }
```

同机所有 profile 共用这个 `machineId`/`machineName`，`init` 时随 join 上报，之后每次心跳也会带上。
Directory 把它保存在设备记录/心跳里，桌面端的「在线主机」「离线」「待审批」按 `machineId` 分组：

- 组头显示机器名、平台、该机器的 DSH 数量（待审批组显示“N 个待审批”）；组内每条 host 仍有独立的
  「打开」或「批准/拒绝」按钮；
- 审批、吊销、配对仍按 host 设备独立进行，一个实例出问题不影响同机其他实例；
- 旧 host 配置没有 `machineId` 时，下次 `run` 自动补写并随心跳上报；升级前已存在的设备会先按单台
  主机显示，host 恢复心跳后即可参与分组；
- 想手动覆盖（例如容器里 hostname 不稳定）：`--machine-id` / `--machine-name`，或环境变量
  `MULTIDSH_MACHINE_ID` / `MULTIDSH_MACHINE_NAME`。

## 与桌面端“DSH 主机实例”的关系

桌面端点「设置」会打开独立窗口，其中的「DSH 主机实例」管理**本机所有桌面托管的实例**：

- 旧版单实例保留为 `default`（数据继续放在 `%APPDATA%\MultiDSH\local-host`），不会被迁移或重新初始化；
- 新实例放在 `%APPDATA%\MultiDSH\local-hosts/<id>/`，各自拥有独立的 `host.json`、`DSH_HOME`、
  `adminPort`、`dshPort`，以及独立的 Directory 设备身份；
- 启动已有实例时执行的是 `host run --config host.json`，**不会再次执行 `host init`**，所以
  `deviceId`、`deviceToken`、`pairSecret` 和 DSH 的登录/API key 都会保留；应用退出后再打开会
  自动恢复之前处于运行状态的实例；
- 每个实例可分别开启、关闭、加入池、脱离池和删除；池主可在同一窗口里直接批准待审批实例；
- 删除实例会删除它的 `host.json` 和 `DSH_HOME`（包括该实例的 DSH 登录/API key）；
  如果只想保留登录数据、只断开池，用「脱离池」；
- 新建实例时可以选择复用已有实例的 DSH 登录/API key（复制 `.credentials.yaml` 等凭据文件），
  也可以填写已有 `DSH_HOME`。实例之间默认不共享 DSH_HOME，避免会话互相干扰；
- CLI 创建的 profile 与桌面托管的实例可以共存，但**端口不要冲突**（桌面会自动从 4080/3080
  找空闲端口，CLI 也支持 `--admin-port/--dsh-port` 错开）。目前桌面设置窗口只管理
  `%APPDATA%\MultiDSH` 下的实例，不接管 `~/.multidsh/instances`；需要时用 CLI 管理。
- 客户端左侧「在线主机」列表显示 Directory 里的所有 host，包括同一台机器的多个 profile；
  它们会按 `machineId` 归到同一机器组，每个条目的「打开」走各自的 pair URL。
- 每个 profile 都需要 owner 单独审批；建议 host 名字带上用途（`gpu-vanilla`、`gpu-purge`）。

## 限制与注意

- Directory 里的“设备”粒度是 host profile，不是物理机：一台机器跑 N 个 host = N 个设备记录、
  N 次审批、N 份心跳；这是设计选择，方便独立吊销/独立 URL。
- 每个 DSH 实例会独立占内存/CPU；多版本同时跑时注意端口、磁盘（每个 `DSH_HOME` 独立）。
- `multidsh remove` 只删本机配置/DSH_HOME，不删云端设备记录；需要在客户端或 Directory API 吊销。
- 插件修改版 DSH 请确认其 `dsh web` 仍然支持 `--host/--port/--public-url/--trusted-host`
  参数（host supervisor 依赖这些参数和 `dsh web: <url>?token=` 输出行）。

## 已验证

在 Windows 本机用本地 Node Directory + fake dsh 做了集成验证（`node scripts/test-multidsh-cli.mjs`）：

- 同一台机器创建 `cli-a` / `cli-b` 两个 host（独立端口 4280/3280、4281/3281，独立 `DSH_HOME`）；
- 两个设备分别审批后 `status=active`，Directory 中 2 个 active host；
- 两个 `host.json` 共享同一 `machineId`/`machineName`，Directory 两条 active host 记录也带回同样字段，
  桌面端可把它们归到同一机器组；
- `multidsh list/status` 同时显示两个 running，health OK；
- `stop`/`remove` 后各目录删除，互不影响。

真实 DSH 版本/插件差异只取决于 `--dsh-bin` 指向的目录，不需要改 MultiDSH 代码。
