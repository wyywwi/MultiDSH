# 把「这台 Windows 的 DSH」加入池（Host 侧车）

## 先回答：Directory 是什么

Directory 是整个 MultiDSH 的**通讯录 / 会合服务**，不存会话内容，只存：

- 池（pool）和设备（device）清单、每台设备的在线心跳；
- 待审批设备、池码；
- 配对时的一次性签名（让桌面端能直接打开主机，不暴露主机 token）。

它必须被**每一个要互相看到的设备**访问到，所以通常是「一个公网可访问的地址」（HTTPS 最好）。
如果你使用项目发布页提供的公共地址，把它填到客户端和 host 的 `--directory`；没有公共地址时，可以自己部署一个（Cloudflare Worker + D1，或本机 Node 版 Directory）。

本机 Node 版示例：

```powershell
cd multidsh
.\bin\node.cmd packages\directory\bin.js --port 8787 --data .tmp\dir.json
# Directory 地址 = http://<这台机器的局域网 IP>:8787（同一局域网内互访）
```

三种选择：

| 场景 | Directory 用什么 | 需要公网吗 |
|---|---|---|
| 只在这台机器上试 | `http://127.0.0.1:8787`（本机 Node Directory） | 不需要 |
| 家里/办公室多台设备 | 项目发布页提供的公共地址 | 需要（客户端出站即可） |
| 自己部署 | 自己的 Worker 或自己的 Node Directory + 反代/隧道 | 需要 |

主机（host）和桌面端（client）都要能访问**同一个** Directory 地址；桌面端在
`设置 → Directory 地址` 里改，host 在 `init --directory` 里指定。

## Host 是什么

「把当前 Windows 的 DSH 加入池子」= 在这台 Windows 上跑一个 **host 侧车**：
它自己拉起一个 `dsh web` 进程（独立 DSH_HOME），把 `dsh web` 反代到 sidecar 端口，
再通过 Directory 注册成池里的一台主机。桌面端审批后，点「打开」就进入这个 dsh 的 Web UI。

> 注意：sidecar 是**新起**一个 dsh web，不会 attach 到你当前正在用的 DeepSeek Harness 窗口
> （DSH 0.2.x 没有 attach 到已运行实例的接口）。它可以复用本仓库 `dsh_out` 里的 DSH
> 0.2.1-rc.2，但会用自己的 DSH_HOME，避免和 Harness 会话/配置打架。

## 最省事：在 MultiDSH 里点鼠标（Windows 推荐）

不需要开终端。桌面端已经内置 host 侧车（打包在 `resources/app/host`），可以自己
启动本机 DSH：

1. 双击 `MultiDSH.exe` → 若在演示模式，点「退出演示，开始使用」→ **创建池**
   （或凭池码加入别人的池）。
2. 右上角 **⚙** 打开**独立设置窗口** →「DSH 主机实例」。
3. 已有的单实例配置显示为 `default`（数据仍在 `%APPDATA%\MultiDSH\local-host`）；点 **「启动」** 即复用它的
   `host.json` 和 `DSH_HOME`，不会重新初始化。
4. （可选）点 **「+ 新建实例」** 创建另一个独立 DSH host：填写实例名，池码会自动填好；
   每个实例有自己的 `host.json`、`DSH_HOME`、admin/dsh 端口和 Directory 身份。可以选择复用已有实例的
   DSH 登录/API key。
5. 创建/启动后设备出现在「待审批」；池主可直接在设置里点 **「批准入池」**，或回主界面设备列表批准。
6. 不再需要时，设置里点对应实例的 **「停止」**；要断开池点 **「脱离池」**（保留 DSH_HOME），
   要连本地数据一起删点 **「删除实例」**。完全退出应用（托盘右键 →「退出 MultiDSH」）也会结束所有侧车。

### 关闭窗口 / 关闭应用后，本机 DSH 还是活的吗？

- **点右上角 × = 最小化到托盘**：应用和侧车都继续运行，本机主机保持在线，其他设备照常打开。
  要完全退出，右键托盘图标 →「退出 MultiDSH（停止本机主机）」。
- 侧车（host + 它拉起的 `dsh web`）是桌面应用的**子进程**：**完全退出应用时它会结束**，
  退出期间这台机器在池里会显示离线。
- 只要上次是通过「启动」启动的（而不是点「停止」），**下次打开应用会自动恢复侧车**：
  应用启动约 1~2 秒后自动跑 `host run`，几秒后心跳恢复、设备回到在线，点「打开」即可。
  `default` 的开关记在 `%APPDATA%\MultiDSH\config.json` 的 `autoStartLocalHost`；新实例记在各自
  `local-hosts\<id>\host.json` 的 `autoStart`。点「停止」会把它清掉。
- 如果应用重启后侧车还没起来就点「打开」，现在会提示「本机主机正在启动 / 没有运行」，
  不会再显示 `ERR_CONNECTION_REFUSED` 的原始错误页；等几秒刷新重试即可。
- 想要**完全退出应用后也一直在线**：Windows 上没有内置后台服务，需要让应用保持在托盘运行；
  或者按下面的命令行方式单独跑 `host run`（Linux 本来就是独立进程，关掉桌面端不影响它）。

应用会自动检测：

- **DSH `bin.js`**：默认找仓库里的 `dsh_out\node_modules\@deepseek-ai\dsh\lib\bin.js`
  （打包 exe 会找 exe 上一级目录的 `dsh_out`）；找不到就在「高级」里手填；
- **node.exe**：默认用 DeepSeek Harness 安装目录里的 Node 运行时
  （`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\...\node.exe`），
  其次 `%USERPROFILE%\.dsh\dsh-runtimes\...`；
- 端口冲突或想换机器访问时，在「高级」里改 sidecar 端口 / dsh 端口 /
  Public URL（其他设备访问要用局域网 IP 或隧道地址）。

> 这一步只影响「谁当主机」；只是作为客户端打开别人主机的设备**不需要**跑侧车。

## 命令行路径（Linux / 脚本 / CI）

Linux 没有 GUI，仍然用命令；Windows 也可以不用上面的按钮，改跑脚本：

## 最短路径（本机自测，不需要隧道）

1. 双击 `MultiDSH.exe` → 若在演示模式，先「退出演示，开始使用」→ **创建一个池**，
   记下 8 位池码（例如 `7K3M9Q2X`）。
2. 开一个 PowerShell，初始化 host（池码换成你的）：

   ```powershell
   cd C:\path\to\multidsh
   .\scripts\join-local-host.ps1 -PoolCode 7K3M9Q2X
   ```

   它等价于：

   ```powershell
   .\bin\node.cmd packages\host\bin.js init `
     --directory https://multidsh.example.com `
     --pool-code 7K3M9Q2X `
     --name "$env:COMPUTERNAME-local" `
     --public-url http://127.0.0.1:4080 `
     --admin-port 4080 --dsh-port 3080 `
     --dsh-home "$env:USERPROFILE\.multidsh\dsh"
   ```

   默认 `--dsh-bin` 自动指向本仓库 `dsh_out\node_modules\@deepseek-ai\dsh\lib\bin.js`。
3. 回到桌面端：左侧「待审批」出现 `xxx-local` → 点 **批准**。
4. 启动 sidecar（前台窗口，别关；关掉主机就下线）：

   ```powershell
   .\bin\node.cmd packages\host\bin.js run --config "$env:USERPROFILE\.multidsh\host.json"
   ```

5. 桌面端等 5 秒或点刷新 → 「在线主机」出现这台机器 → 点「打开」→ 右侧加载真正的 DSH UI。

> 本机自测时 `--public-url http://127.0.0.1:4080` 就够了：桌面端和 sidecar 在同一台机器，
> 不需要公网可达；换设备访问才需要下面第 2 条的可达地址。

一步到位（初始化后直接 run）：

```powershell
.\scripts\join-local-host.ps1 -PoolCode 7K3M9Q2X -Run
```

## 让别的设备/外网访问这台主机

`--public-url` 必须是「桌面端所在设备能访问到的 sidecar 地址」：

- **同一局域网**：`http://<这台 Windows 的局域网 IP>:4080`（Windows 防火墙放行 4080）；
- **跨公网**：用 Cloudflare Tunnel 指向 `127.0.0.1:4080`，把生成的地址作为 public-url：

  ```powershell
  cloudflared tunnel --url http://127.0.0.1:4080
  # 例如输出 https://random-words.trycloudflare.com
  ```

  然后用 `--public-url https://random-words.trycloudflare.com` 重新 init（或改
  `%USERPROFILE%\.multidsh\host.json` 的 `publicUrl` 后 run）。
  生产环境建议命名隧道 + 自己的域名（和 Worker 目录用的 example.com 同一个 Cloudflare 账号即可）。
  完整的子域规划、Published application / Private hostname、公网/内网差异和排错见
  [`CLOUDFLARE-TUNNEL.md`](CLOUDFLARE-TUNNEL.md)。

## 常见问题

- **卡在 pending**：池主没批准；桌面端「待审批」里点「批准」。池码 24 小时过期。
- **批准后不在线**：sidecar 没在跑（第 4 步），或 `run` 窗口被关掉；看窗口日志里
  `captured dsh token` 和心跳输出。
- **点打开报 502/超时**：`--public-url` 不可达（换了设备访问时忘了开隧道/防火墙）。
- **端口冲突**：`--admin-port` / `--dsh-port` 默认 4080 / 3080，被占用就换一对，重新 init。
- **想换 DSH 版本**：`--dsh-bin <path>` 指向任意 `@deepseek-ai/dsh/lib/bin.js`。
