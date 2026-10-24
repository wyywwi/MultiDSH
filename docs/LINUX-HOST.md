# Linux Host 部署与验证（M1）

本文记录 MultiDSH Host sidecar 在真实 Linux 服务器上的验证结果，以及部署到云端的步骤。
目标：Linux 主机加入 Cloudflare Worker Directory，心跳在线，Windows 客户端可配对并打开 DSH UI。

> **只想在 Linux 服务器上快速装好？** 优先用一键安装器：
> `cd ~/multidsh && ./install.sh`。它会自动安装 Node/DSH，并一步步询问 Directory、池码（可跳过）、端口和 Public URL。
> 完整说明见 [`INSTALL-LINUX.md`](INSTALL-LINUX.md)。本文保留手动步骤和真实环境验证记录，便于排查。

## 先分清：Linux Host（后台）与 Linux 桌面客户端（可选）

**Linux 服务器不需要桌面、不需要 Electron、不需要图标/托盘。** 它跑的是后台 CLI：

| 角色 | 跑什么 | 有没有图形界面/图标 | 部署位置 |
|---|---|---|---|
| **Host（服务器，生产形态）** | `./multidsh init` / `./multidsh start`（底层 `packages/host/bin.js`）：host sidecar + 它管理的 `dsh web` | **没有**。纯 Node 进程，不需要 X11/Wayland/桌面；可交给 systemd 常驻 | 你的 Linux 服务器 |
| **Client（客户端，GUI）** | MultiDSH 桌面版（Electron）：设备列表、本机主机设置、内嵌 host 的 DSH UI | **有**，图标/托盘都属于这一层 | Windows、macOS、带桌面的 Linux，或 Android app |

工作方式是：Linux Host 入池后只是 Directory 里的一台在线设备；你在 **另一台有桌面的设备**
上打开 MultiDSH，在「在线主机」里点这台 Linux 主机的「打开」，客户端通过 `/pair` 拿一次性
URL，再 303 到该 host 的 DSH Web UI 并种 `dsh-auth-*` cookie。Linux 本机始终是后台进程，
不渲染任何窗口。

`docs/L40-VERIFICATION.md` 里 L40 上跑的 Electron 是**可选的 Linux 桌面客户端**做移植性
验证（用 Xvfb 虚拟出一块 1279×799 的屏幕，所以截图里有窗口/托盘概念）；它**不是** Linux
服务器的生产形态，真实服务器上不会装也不会启动这个 Electron 客户端。

## 已验证环境

| 机器 | 配置 | 结果 |
|---|---|---|
| **test-linux-b**（腾讯云上海） | Ubuntu 22.04，2 核 / 2 GB，公网 203.0.113.10 | ✅ 完整 host 链路（无桌面）：Node 24 + dsh 0.2.1-rc.2 + sidecar 入池/审批/心跳/配对/打开 DSH UI |
| **test-linux-a**（校内 GPU 机） | Ubuntu 22.04，192 核 / 503 GB，KVM | ✅ Docker 内 Node 24 跑 30/30 测试（directory 16 + worker 13 + host 1）；✅ Android 模拟器（见 `ANDROID-ENV.md`）；✅ 可选的 Linux 桌面客户端在 Xvfb 下冒烟通过（非服务器形态）；✅ `@deepseek-ai/dsh@0.2.1-rc.2` 在容器内安装成功（613 个包，约 4 分钟）；✅ 真实 dsh 被 host CLI 成功监管（本地 Directory，约 5.7s 捕获 token）。host 端到端以 test-linux-b 为准 |

test-linux-b 宿主原本没有 Node，安装的是官方 `node-v24.21.0-linux-x64` 便携包，不改系统。

## test-linux-b 完整步骤（可复现）

```bash
# 0) 服务器上安装便携 Node（公网可达 nodejs.org）
mkdir -p ~/multidsh-runtime && cd ~/multidsh-runtime
curl -fsSL -o node.tar.xz https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
tar xf node.tar.xz && rm node.tar.xz
export PATH=$HOME/multidsh-runtime/node-v24.21.0-linux-x64/bin:$PATH
node -v   # v24.21.0

# 1) 安装 dsh CLI（与本地同版本）
mkdir -p ~/dsh && cd ~/dsh
npm install --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.2
node node_modules/@deepseek-ai/dsh/lib/bin.js --version   # 0.2.1-rc.2

# 2) 拿到仓库（本地打包后 scp，排除 node_modules/.tmp）
#    Windows: tar -czf multidsh-src.tgz -C <workspace> --exclude multidsh/node_modules --exclude multidsh/.tmp multidsh
scp multidsh-src.tgz test-linux-b:~/
ssh test-linux-b 'tar xzf ~/multidsh-src.tgz -C ~/'

# 3) 入池（池码由 Windows 端创建池得到）——推荐用交互式 CLI
cd ~/multidsh
chmod +x multidsh
# 可选：放进 PATH，之后任意目录都能直接敲 multidsh
mkdir -p ~/.local/bin && ln -sf "$PWD/multidsh" ~/.local/bin/multidsh
./multidsh init
# 向导会问：Directory（默认官方地址）、池码、host 名字、dsh bin（自动探测）、
# Public URL、DSH_HOME；端口/路径都有默认值，回车即可。
# 非交互/自动化时也可以一次给全：
# ./multidsh init --pool-code <CODE> --name tencent-sh \
#   --public-url http://127.0.0.1:4093 --admin-port 4093 --dsh-port 3093 \
#   --dsh-bin ~/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
#   --dsh-home ~/multidsh-run/dshhome

# 4) 在 Windows 上审批（桌面端或 Directory API）之后启动：
./multidsh start tencent-sh
./multidsh status tencent-sh
curl -s http://127.0.0.1:4093/__fleet/health
```

> `multidsh` 是 2026-10 新增的 host 管理器，`init/run/start/stop/status/list/logs/doctor`
> 都有默认值；旧的 `node packages/host/bin.js init/run` 仍然可用（CLI 只是它的友好封装）。
> 同一台机器可以建多个具名 host（不同端口 / DSH_HOME / DSH 版本或插件），见
> [`MULTI-INSTANCE.md`](MULTI-INSTANCE.md)。

生产环境应把 `--public-url` 换成该主机的 Cloudflare Tunnel 公网地址（Tunnel ingress 指向 sidecar 4093/4080）。

### 常驻运行（无桌面服务器推荐 systemd）

临时验证可用上面的 `setsid nohup`；服务器长期运行建议 systemd 单元，模板见
[`scripts/multidsh-host.service.example`](../scripts/multidsh-host.service.example)：

```bash
sudo cp multidsh/scripts/multidsh-host.service.example /etc/systemd/system/multidsh-host.service
sudoedit /etc/systemd/system/multidsh-host.service   # 填 <USER>/<REPO>/<NODE_BIN>/<HOST_JSON>/<LOG_DIR>
sudo systemctl daemon-reload
sudo systemctl enable --now multidsh-host
systemctl status multidsh-host --no-pager
journalctl -u multidsh-host -f
```

`multidsh init` 默认把配置写到 `~/.multidsh/instances/<name>/host.json`，所以 systemd 里的
`<HOST_JSON>` 用 `~/.multidsh/instances/tencent-sh/host.json`（展开成绝对路径；systemd 不展开 `~`）。
同一台机器多个 host 时，**一个 profile 一个 unit**（复制成 `multidsh-host-<name>.service`，
各自 `--config` 不同）。

没有 sudo 时用 `systemctl --user` + `~/.config/systemd/user/`；若不允许 linger，就继续用
`setsid nohup`。host 与 dsh 都是纯 Node 进程：**不需要安装 X11/Wayland、不需要 Electron、
不需要 `--no-sandbox`/Xvfb**，服务器没有桌面也能正常工作。

### 客户端怎么连这台 Linux 主机

1. host 入池并在 MultiDSH 客户端里被 owner 批准 → Directory 显示 `status=active`；
2. 在 Windows/Android 等有 GUI 的设备上打开 MultiDSH → 「在线主机」点这台主机「打开」；
3. 客户端请求 `/pair`，Directory 用 host 的 `pairSecret` 签一次性 nonce，303 到 host 的
   `publicUrl` 并种 `dsh-auth-*` cookie，随后内嵌显示该 host 的 DSH Web UI；
4. linux 本机只看到 `host run` 的日志/心跳，不会出现任何窗口或图标。

## 在 L40 上实测：dsh 安装到底卡在哪

之前记录里写“宿舍网络无法稳定拉全量 npm 依赖”，2026-10-21 重新实测后更准确的原因有三层：

1. **宿主没有 node 在 PATH 里**：早期日志 `~/dsh-build-install.log` 只有一行
   `bash: line 1: node: command not found`。L40 只装了便携 Node 到 `~/multidsh-runtime/...`
   或使用 `node:24` 容器，但登录 shell 的 PATH 没有它；这不是网络问题。
2. **依赖树很大 + 默认 registry 慢**：`@deepseek-ai/dsh@0.2.1-rc.2` 会拉 **613 个包**
   （解压后约 **855 MB**）。从容器内实测：
   - `registry.npmjs.org` 元数据 ~5.9 s、tarball ~1.5 s；
   - `registry.npmmirror.com` 元数据 ~0.8 s、tarball ~0.3 s；
   - 用 npmmirror 安装约 **4 分钟**成功（`added 613 packages in 4m`）。
   网络不是完全不通，而是“默认源慢 + 包多”，之前的命令/超时等不到结束就放弃了。
3. **npm 11 默认跳过 install scripts**：安装会提示
   `5 packages have install scripts not yet covered by allowScripts`（`koffi`、`node-pty`、
   `@deepseek-ai/dsh-subprocess-local` 等）。`dsh --version` 能跑，但终端/原生模块相关功能
   可能受影响；需要时执行：

```bash
npm install-scripts ls
npm install-scripts approve <package>   # 按需逐个批准（npm 11+）
```

推荐的可复现安装命令（L40 已实测 0.2.1-rc.2 可运行）：

```bash
mkdir -p ~/dsh && cd ~/dsh
npm init -y >/dev/null 2>&1 || true
npm install --no-audit --no-fund --registry=https://registry.npmmirror.com \
  @deepseek-ai/dsh@0.2.1-rc.2
node node_modules/@deepseek-ai/dsh/lib/bin.js --version   # 0.2.1-rc.2
```

在 L40 上也可以用 `node:24` 容器跑这一步（`-v ~/dsh:/work -w /work node:24 npm ...`）；
容器内 npm 11 的路径/权限与宿主不同，但产物可以直接被宿主 Node 使用。

**L40 真实 dsh + host CLI 验证**：把上面的 `~/dsh-build-test` 只读挂进 `node:24` 容器
（`--network host`），用本地 Directory 跑 `multidsh init/start`：
- `dsh` 启动约 5.7 秒后 host 捕获 token（`health.dsh.tokenCaptured=true`）；
- Directory 心跳 `status=active`；
- 直接 `GET /` 返回 401（DSH 要求 `dsh-auth-*` cookie，符合配对设计；不是启动失败）。

也就是说 npm 11 跳过 install scripts 不影响 `dsh web` 的基本启动；要用终端/原生模块相关
功能时再按上面的 `npm install-scripts` 逐个批准。

> 上面的容器安装产物属于 root（`~/dsh-build-test`）。正式用 `multidsh` 跑 host 时建议用
> 普通用户安装，或 `sudo chown -R "$USER" ~/dsh-build-test`；否则 DSH 可能无法写自己的
> 运行时文件。L40 无 sudo 时可在容器里用 `--user $(id -u):$(id -g)` 安装到用户目录。


## 验证结果（2026-10-20）

从 Windows 通过 SSH 隧道（`ssh -N -L 4093:127.0.0.1:4093 test-linux-b`）跑完整链路：

```
host tencent-sh status=active lastSeenAgo=50262ms
pair -> 303 /?token=…
token -> 303 cookie=dsh-auth-…
ui -> 200 bytes=37512 looks-html=true
replay -> 400
LINUX PAIR PASS
```

同时 Directory 的 `/api/pools/<id>/devices` 中该 host `status=active`，`health.dshRunning=true`。

## 过程中发现并修复的问题

1. **心跳覆盖审批状态（已修复）**
   Host 在审批前启动时，心跳会对 `device:<id>` 做 read-modify-write；若期间 owner 审批，心跳会把旧的 `pending` 写回，设备永久变回待审批。
   修复：心跳只写独立的 D1 liveness 记录，`devices` 只由 owner 的 approve/revoke 修改；列设备/配对时叠加心跳字段。
   回归测试：`worker.test.mjs` 的 “heartbeat never rewrites the device record”，以及 `d1-liveness.test.mjs`。
2. **`$host` 是 PowerShell 只读变量**（部署脚本踩坑），脚本里改用 `$hostDevice`。

## 已知限制

- test-linux-b 的 host 目前 `publicUrl=http://127.0.0.1:4093`，只通过 SSH 隧道验证；接入真实客户端前需配 Cloudflare Tunnel。
- test-linux-a 上 `dsh` 未装完（网络问题），host 端到端以 test-linux-b 结果为准；test-linux-a 已用于 Node 测试与 Android 模拟器。
- 停止 Tencent host：`ssh test-linux-b 'pkill -f "packages/host/bin.js run"'`。
