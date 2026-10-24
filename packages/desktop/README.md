# MultiDSH Desktop（M0）

Electron 桌面客户端原型：左侧 MultiDSH 设备面板，右侧内嵌选中主机的 DSH Web UI。
无框架、无构建步骤（原生 HTML/CSS/JS）。协议见 [`../protocol/PROTOCOL.md`](../protocol/PROTOCOL.md)。

## 目录结构

```
packages/desktop/
  package.json          # @multidsh/desktop，electron 33.4.11（devDependency）
  pnpm-workspace.yaml   # 允许 electron 的安装脚本（pnpm >= 10 默认拦截）
  src/
    main.js             # 主进程：窗口、host 视图、全部 Directory HTTP、config、IPC、smoke
    preload.js          # contextBridge 暴露 window.fleet（沙箱渲染层唯一通道）
    directory-client.js # Directory HTTP 客户端 + 90s 在线判定 + 错误中文化
    renderer/
      index.html        # 侧边栏骨架（300px）
      styles.css        # 深色 / 浅色两套 CSS 变量
      app.js            # 渲染/交互逻辑（无网络访问）
  test/
    directory-client.test.cjs  # 基于 mock Directory 的协议单测
```

## 安装

本仓库环境里 `node` 不在 PATH（`pnpm` 的依赖安装脚本需要用 PATH 里的 `node` 下载
Electron 二进制），先把 bundled node 加进 PATH：

```powershell
$env:PATH = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
cd multidsh\packages\desktop
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
..\..\bin\pnpm.cmd install
```

- `pnpm-workspace.yaml` 里的 `allowBuilds: { electron: true }` 已允许 electron 的
  postinstall 下载平台二进制（pnpm >=10 默认拦截依赖构建脚本；pnpm 11 的字段名是
  `allowBuilds`，v10 的 `onlyBuiltDependencies` 已废弃）。
- 安装成功标志：存在 `node_modules/electron/dist/electron.exe`（约 190 MB）。
- 若看到 `[ERR_PNPM_IGNORED_BUILDS]` 或二进制缺失，补跑：

```powershell
..\..\bin\node.cmd node_modules\electron\install.js
```

或 `..\..\bin\pnpm.cmd approve-builds` 后重新安装。普通机器上 `node` 已在 PATH，
`npm install` 即可，无需这些步骤。

## 运行

本仓库环境中 `node` 不在 PATH，且部分 shell 会带 `ELECTRON_RUN_AS_NODE=1`
（会让 electron.exe 退化成纯 Node，报 `app.setName` undefined）。先准备环境：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PATH = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
cd multidsh\packages\desktop
..\..\bin\pnpm.cmd start
```

普通机器（node 已在 PATH）：`npm install` 后 `npx electron .` 或 `npm start`。

演示模式现在是手动入口：设置 →「演示模式」→「进入演示模式」。  
它显示一套示例数据，不访问网络；退出后回到真实引导页。`--demo` 仍可强制启动演示，`--smoke-demo` 只用于冒烟测试。

> 源码默认 Directory 是示例地址 `https://multidsh.example.com`；实际使用时在设置里
> 填写你的连接服务地址，本地联调可改成 `http://127.0.0.1:8787`。

外观：默认深色；标题栏右侧 ⚙ → 设置 →「外观」可切到**浅色**。选择写入
`config.theme`（打包版在 `%APPDATA%\MultiDSH\config.json`），重启保持；渲染层通过
`document.documentElement.dataset.theme` 切整套 CSS 变量。

侧边栏可收起：标题栏的 **«** 收起成 32px 窄条（只剩 **»**），主进程同步把
`WebContentsView` 的 x/宽度从 300 改成 32，右侧主机界面自动铺满；**»** 展开。

窗口关闭 = 托盘后台：点击右上角 **×** 时主进程拦截 `close` 并 `win.hide()`，应用与
本机主机侧车继续运行；托盘菜单（右键）有「显示 MultiDSH」和「退出 MultiDSH（停止本机主机）」。
再次启动 exe 触发 `second-instance` 直接唤回窗口。

标题栏左侧的三鲸鱼图标直接用用户提供的两版 SVG（`src/renderer/brand-dark.svg` =
深色版、`brand-light.svg` = 浅色版），随主题切换显示；exe/窗口/托盘图标由同一份深色版
渲染成 `assets/icon/icon.ico`（生成方式见 `assets/icon/README.md`）。打包的
`MultiDSH.exe` 带版本资源（`0.1.0.2`），WIN32 图标与 `icon.ico` 的 32px 逐像素一致
（见 `.tmp/exe-icon-32.png` 校验）。如果资源管理器仍显示旧图标：`ie4uinit.exe -show`
刷新图标缓存、取消固定旧任务栏图标后重新固定，或删掉旧解压目录、重新解压最新 zip。

## 在应用里把本机 DSH 加入池（不用命令行）

设置 →「本机主机（Host）」→ 池码（自动跟随当前池；没有池时留空）→ **启动本机主机**。主进程会：

1. 调 `host/bin.js init` 把本机注册成池里的 host 设备（`local-host/host.json`）；
2. 用 Electron 自带的 Node 模式拉起 `host/bin.js run`：侧车再拉起一个
   `dsh web`（独立 `DSH_HOME`，默认端口 4080 / 3080）；
3. 设备进入「待审批」，池主批准后刷新即出现在「在线主机」，点「打开」进入真正的 DSH UI；
   同机多个 host（例如不同 DSH 版本/插件）会按 `machineId` 归到同一个机器组，组内逐个打开。
4. 设置里「停止本机主机」或关闭应用时结束侧车。**下次打开应用会自动恢复**（只限上次是通过
   「启动」启动的；点过「停止」就不再自动启动）。如果重启后立刻点「打开」，应用会等待端口
   就绪或给出「本机主机没有运行 / 正在启动」的提示，而不会显示 `ERR_CONNECTION_REFUSED` 原始错误页。

### 多实例、编辑与一键安装运行时

- 设置 →「DSH 主机实例」→「+ 新建实例」：每个实例独立 `host.json`、`DSH_HOME`、admin/dsh 端口。
- 实例卡片上的「编辑」可以修改：名称、Public URL、admin/dsh 端口、DSH `bin.js`、`node.exe`、`DSH_HOME`。
  修改后会自动停止并按新配置重启；名称/Public URL 通过心跳同步到 Directory。
- 主列表和设置里，当前正在交互的 host 会显示高亮边框和「当前」标记，按钮变成「已打开」。
- 「安装 Node/DSH」按钮会下载官方 Node 24 zip 到 `%APPDATA%\MultiDSH\runtime`，再用其中的
  npm 安装 `@deepseek-ai/dsh@0.2.1-rc.2`，不需要管理员权限，也不影响系统 PATH。
- 设置窗口不再定时自动刷新，正在填写的新建/编辑表单不会被后台状态刷新覆盖。

### 更新桌面端

程序文件和数据是分开的：数据在 `%APPDATA%\MultiDSH`，程序在解压目录。  
完全退出 MultiDSH 后，把新 zip 解压覆盖程序目录即可完成升级，不需要重新创建池、重新登录或
重新添加 host。设置窗口的自动刷新已移除，更新后第一次打开会直接读到旧配置。

自动检测（找不到时可在「高级」里手填）：

- DSH `bin.js`：仓库 `dsh_out\node_modules\@deepseek-ai\dsh\lib\bin.js`（打包版找
  exe 旁边上一级的 `dsh_out`）；
- `node.exe`：DeepSeek Harness 安装目录的 runtime（`%LOCALAPPDATA%\Programs\
  DeepSeek Harness\resources\runtime\...\node.exe`），其次 `%USERPROFILE%\.dsh\
  dsh-runtimes\...`；也可用 `MULTIDSH_NODE_BIN` 覆盖。

> 侧车是**新起**一个 dsh web（独立 DSH_HOME），不会 attach 到你正在用的 Harness 窗口。
> 只是作为客户端打开别人主机的设备**不需要**启本机主机。

> 受限 Windows 会话/虚拟机里 Chromium 沙箱可能初始化失败（进程瞬间退出，退出码
> `-2147483645`/`0x80000003`）。此时加 `--no-sandbox` 启动：
> `.\node_modules\.bin\electron.cmd . --no-sandbox`。`pnpm run smoke` 已内置该参数。

## 手动联调流程

1. 启动 Directory（另开终端，`multidsh` 目录下）：
   ```powershell
   .\bin\node.cmd packages\directory\bin.js --port 8787 --data .tmp\dir-desktop
   ```
2. 启动桌面端（本地联调填 `http://127.0.0.1:8787`；默认源码地址是示例
   `https://multidsh.example.com`，可在设置里改成你的连接服务地址），创建池，记下池码。
3. 主机侧 sidecar 凭池码加入 → 桌面端「待审批」出现该设备 → 点「批准」。
4. 主机心跳后进入「在线主机」，点「打开」：
   `POST /api/pools/:id/pair {hostId}` → `{url}` → `WebContentsView` 加载该 URL →
   host sidecar 校验 nonce 后 303 到 `/?token=...` → DSH 设置 `dsh-auth-*` cookie →
   右侧显示完整 DSH UI。

## 打包成双击即用的 Windows exe（便携版）

不想装 Node/Electron，可直接双击打包产物：

```powershell
cd multidsh
.\bin\node.cmd scripts\package-desktop.mjs
```

产物在 `multidsh\dist\MultiDSH-win\`，双击 `MultiDSH.exe` 即可（同目录的
`MultiDSH-windows-0.1.0.zip` 是整包，可拷到别的 Windows 机器）。打包复用
`node_modules\electron\dist` 的 Electron 33.4.11，不联网下载。

结构/原理：

- `MultiDSH-runtime.exe`：electron.exe 改名，运行时加载 `resources\app\`；
- `resources\app\`：本包 `package.json` + `src/`（与开发时同一份代码）；
- `resources\app\host\` + `protocol\`：host 侧车运行时代码，供「本机主机」按钮直接拉起；
- `MultiDSH.exe`：18 KB 的 C# 启动器（`csc /target:winexe` 编译），正常情况直接启动
  运行时；仅当 Chromium 沙箱在受限父进程下初始化失败（退出码 `0x80000003`）时，
  自动带 `--no-sandbox` 重试一次，保证「双击」在任何环境都能开窗；
- 配置在 exe 旁边 `multidsh-config.json`（便携，不写 `%APPDATA%`），首次启动进入真实引导页。

打包后的验证（本机实测）：双击 → 正式引导页 → 设置 → 演示模式 → 示例数据；退出后回到引导页，且退出演示不会影响真实池配置。

## 截图冒烟测试（无需 Directory）

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PATH = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
cd multidsh\packages\desktop
..\..\bin\pnpm.cmd run smoke        # 等价于 electron . --smoke --no-sandbox
# 或直接：
.\node_modules\.bin\electron.cmd . --smoke --no-sandbox
```

行为：打开窗口 → 等渲染层 ready → `capturePage()` 截图 → 校验布局 →
`app.exit(0)`（15s 硬看门狗兜底，不会残留 electron 进程）。约 4 秒。

产物（`multidsh/.tmp/`）：

- `desktop-smoke.png`：空状态（创建池/凭池码加入）截图
- `desktop-smoke-metrics.json`：布局断言结果 + 侧边栏/设备卡片尺寸等度量

`pnpm run smoke:demo`（`--smoke-demo`）用内置示例池渲染完整设备列表，产物为
`desktop-smoke-demo.png` / `desktop-smoke-demo-metrics.json`。两种模式都不访问网络。
想在冒烟里检查浅色主题，加环境变量 `MULTIDSH_SMOKE_THEME=light`（截图即浅色配色）。

### 真实链路 smoke（`--live-smoke`，由 `scripts/e2e-desktop.mjs` 驱动）

`--live-smoke` 不模拟数据：从 `MULTIDSH_LIVE_*` 环境变量读取一个真实池会话，
启动后按正常路径打开指定 host（pair → 303 → `dsh-auth-*` cookie → WebContentsView
里的 DSH UI），并输出断言与截图：

| 环境变量 | 含义 |
|---|---|
| `MULTIDSH_LIVE_DIRECTORY` | Directory URL（如 `http://127.0.0.1:8787`） |
| `MULTIDSH_LIVE_POOL_ID` / `MULTIDSH_LIVE_DEVICE_ID` / `MULTIDSH_LIVE_DEVICE_TOKEN` | 本机（owner）会话 |
| `MULTIDSH_LIVE_HOST_ID` | 要打开的主机设备 ID |
| `MULTIDSH_LIVE_PUBLIC_URL` | 主机 sidecar 公网入口（如 `http://127.0.0.1:4093`） |
| `MULTIDSH_LIVE_DEVICE_NAME` / `MULTIDSH_LIVE_ROLE` | 可选，默认 `live-desktop` / `owner` |

产物（`multidsh/.tmp/`）：`desktop-live-metrics.json`（含 hostUrl、页面标题、
`dsh-auth-*` cookie 名、设备数/在线主机数）、`desktop-live-window.png`（窗口合成截图）。
典型调用见仓库根目录的 `scripts/e2e-desktop.mjs`（一条命令起 Directory + Host + 桌面端）。

> 本仓库的会话模型无法读图，因此 smoke 额外输出 DOM 度量与断言（侧边栏 300px、
> 无横向溢出、设备卡片数、池码文本等），全部通过才算成功。

> 环境提示：本工作区位于 OneDrive 同步的 `Documents` 下，偶发的
> OneDrive/杀软扫描会让 electron 原生进程在启动阶段崩溃（`crashpad ... not connected`，
> 退出码 -36861）。这不是应用代码问题：重跑一次 `pnpm run smoke`，或把
> `node_modules/electron` 复制到本地非同步目录后运行，即可恢复。

## 单元测试（mock Directory）

```powershell
..\..\bin\pnpm.cmd run test
# 或：..\..\bin\node.cmd --test test\directory-client.test.cjs
```

覆盖：URL/池码归一化、90s 在线判定、网络错误映射、创建池 → 主机 pending 加入 →
owner 可见待审批 → 批准 → 心跳 → 列表 → pair → 吊销 的完整协议流。

## 配置与数据

开发运行和打包版默认都用 `%APPDATA%\MultiDSH\`（`app.getPath('userData')`）：

- `config.json`：池会话 / 设备身份 / 主题 / `autoStartLocalHost`；
- `local-host\host.json`：本机主机侧车配置；`local-host\dsh-home\` 是它自己的 DSH 数据。

打包版首次启动会把旧版 exe 旁边的 `multidsh-config.json` 和 `local-host\` 迁移过来（含
`host.json` 里的绝对路径改写）。想恢复“整个文件夹拷走”的便携模式，在 exe 旁边放一个
空文件 `multidsh-portable.txt`。

```json
{
  "directoryUrl": "https://multidsh.example.com",
  "poolId": "pool_...",
  "deviceId": "dev_...",
  "deviceToken": "mdt_...",
  "deviceName": "DESKTOP-XXX",
  "poolName": "home",
  "role": "owner",
  "joinCode": "7K3M9Q2X",
  "joinCodeExpiresAt": 1792586400000,
  "selfStatus": "active",
  "demoDismissed": true
}
```

`demoDismissed` 表示已经看过演示模式；`poolName`/`role`/`joinCode`/`selfStatus` 是 M0
为界面显示的附加字段。修改 Directory 地址会清空本地池会话（旧 token 属于旧服务）。
设备名默认取主机名，可用环境变量 `MULTIDSH_DEVICE_NAME` 覆盖。渲染层永远拿不到
`deviceToken`。

## 实现要点

- **主进程持有全部网络请求**：渲染层无 fetch，IPC 统一返回
  `{ok, data}` / `{ok:false, error:{code,message,status}}`。
- **安全**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、
  preload 仅暴露白名单方法；CSP 只允许同源脚本/样式。
- **右侧 host 视图**：Electron ≥30 用 `WebContentsView`（`contentView` 子视图），
  否则回退 `BrowserView`；bounds = 内容区减去 300px 侧边栏，窗口 resize 时同步；
  独立持久化分区 `persist:multidsh-host`（DSH cookie 随配对刷新）。关闭时销毁视图。
- **轮询**：窗口聚焦时每 5s `GET /api/pools/:id/devices?includePending=1`（owner），
  聚焦/手动刷新立即拉取；`lastSeenAt` 在 90s 内视为在线。
- **池主专属**：待审批区、批准/拒绝、池码展示；非 owner 只看 active 设备。
  待审批的自设备会显示「等待池主审批」状态（403/401 时按 `selfStatus` 区分）。
- **错误**：全部内联 banner / 表单提示，不使用 `alert()`；Directory 错误按
  `code` 转中文（`pool_code_invalid`、`pool_code_expired`、`host_not_active` 等）。

## M0 已知取舍

- 单窗口、单 host 视图；打开的主机不跨重启保存。
- 池码轮换、吊销 active 主机、会话摘要/事件推送（M3）未做 UI。
- 离线主机的「打开」仍会请求 pair（Directory 返回 `online:false`），加载可能失败，
  失败后内联报错，重新点击可重试。
- 桌面端以 `client` 身份加入，不替 host 发心跳；desktop 自身的 lastSeen 不会更新。
- smoke 为纯前端渲染验证，不覆盖真实 pair → cookie → DSH UI 流程（该链路由
  Directory/Host 的 E2E 与 `test/directory-client.test.cjs` 覆盖协议部分）。
