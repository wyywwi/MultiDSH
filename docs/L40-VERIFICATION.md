# L40 验证记录（Linux 桌面端 + Android 客户端）

日期：2026-10-21。目标机器：`test-linux-a`（Ubuntu 22.04，192 核，KVM，无 sudo，可访问
dl.google.com / npmmirror，GitHub 与 maven.google.com 不可达）。两台子代理均只写
`.tmp/l40-linux/`、`multidsh/android/`、`.tmp/android/`，未改主仓库其它代码。

> **定位说明**：L40 上这部分 Electron 测试的是 **可选的 Linux 桌面客户端**（GUI），
> 仅为验证 Linux 可移植性；截图里的窗口/托盘/图标都来自这块 GUI。Linux 服务器的生产
> 形态是 **无桌面的后台 host CLI**（`./multidsh init` / `./multidsh start`，底层
> `packages/host/bin.js run`），不需要 X11、Electron、图标或托盘，由另一台设备上的
> MultiDSH 客户端操控 —— 见 [`docs/LINUX-HOST.md`](LINUX-HOST.md) 的「先分清」一节。

## 一、Linux 桌面端（Electron）— PASS

| 验证 | 实际命令（cwd=`packages/desktop`） | 结果 |
|---|---|---|
| demo 冒烟 | `DISPLAY=:99 ~/apps/electron/electron/electron --no-sandbox . --smoke --smoke-demo` | EXIT 0，1279×799 截图 243,022 B，内置布局断言 0 failures |
| 空状态冒烟 | `… --no-sandbox . --smoke` | EXIT 0，1279×799 / 195,980 B，0 failures |
| 非 smoke 真实启动 | `… --no-sandbox --disable-gpu --remote-debugging-port=9223 .` + CDP | title=MultiDSH，5 张设备卡片，innerText 正常，CDP 截图 258,379 B |
| 关闭到托盘 | 真实 `WM_DELETE_WINDOW`（python-xlib） | close 被拦截、窗口 UnMapped、进程存活、日志 `[tray] created` |

环境（全部无 sudo）：Xvfb 21.1.4 用 `apt-get download` + `dpkg-deb -x` 解包；Electron
33.4.11 linux-x64 从 npmmirror 下载；Noto CJK 字体解包到 `~/.local/share/fonts`。
脚本与原始日志保存在构建机本地（未纳入仓库）；最新快照复测结果也在构建机本地。

截图保存在构建机本地，未随仓库分发。

### Linux 桌面端待办

P0（会影响真实使用）：

1. `windowIconPath()` 只列 `.ico`；Linux 需回退到仓库已有 `assets/icon/icon-dark-512.png`
   （`nativeImage` 在 Linux 不支持 ICO，实测托盘图标为空）。
2. `detectNodeBin()` 只有 Windows 路径：需补 PATH 查找、`~/.dsh/dsh-runtimes/*/dependencies/node/bin/node`、
   `~/multidsh-runtime/node-*/bin/node`。
3. `detectDshBin()` 只认 `dsh_out`：需补 `which dsh`、`~/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`。
4. 无系统托盘宿主时（GNOME 默认 / 纯 Xvfb）关闭到托盘会把窗口藏没：需检测
   `Tray` 创建/可见性不可用则回退为最小化或直接退出。

P1：`scripts/package-desktop.mjs` 是 Windows 专用（electron.exe / C# launcher / ICO），
Linux 需要 AppImage/deb + `.desktop` + PNG 图标；portable 模式在只读挂载不可用；
无头 CI 需文档化 `--no-sandbox/--disable-gpu/xvfb-run/fonts-noto-cjk`。

未覆盖（如实）：未做 GUI 的 live smoke（L40 的 dsh 已安装成功，但 Electron live smoke 仍需要池凭据）；未做 Linux 打包；Xvfb 无 StatusNotifier，托盘图标“可见性”无法验证（只能验证 close 行为和 `Tray` 对象创建）。Host CLI + 真实 dsh 的验证见第三节。

## 二、Android 客户端 M2.0 — PASS（原型，host 为 mock）

APK：`.tmp/android/multidsh-android-0.1.0-debug.apk`（25,051 B，debug 签名，minSdk 26 /
target 34）；源码在 [`multidsh/android/`](../android/)。

无 Gradle 构建链（全程 <10 s）：

```text
aapt2 link → javac 11 → d8 → zip → zipalign → apksigner
```

环境修复：L40 原 SDK 缺 build-tools → 直接解包 dl.google.com 的
`build-tools_r34-linux.zip`；宿主只有 JRE 11 没有 javac → `apt-get download
openjdk-11-jdk-headless` + `dpkg -x` 拼出 `~/jdk11home`。均可复用。

验证证据保存在构建机本地（未纳入仓库）：11 张截图 + uiautomator XML + logcat + mock host 请求日志。

| 步骤 | 结果 |
|---|---|
| 干净安装/启动 | `pm clear` → install Success → `am start` COLD ok → 入池界面渲染（`01-home.png`） |
| Directory 同源请求 | `health: OK status=200 protocol=1 viaBridge=false`；file:// 直连会被 CORS 拦截（无 ACAO、OPTIONS 405），改用 `loadDataWithBaseURL(directoryUrl)` 使 origin 与 Directory 同源 |
| 创建池 | 201 `pool_<redacted>` / 池码 `<pool-code>`（`02-created.*`） |
| 审批设备 | L40 curl 以 host 入池 → pending → app 点批准 → active、待审批归零（`03`/`04`） |
| 打开 host | `POST /pair` 拿到 Directory 签名 URL → 同一 WebView 303 → mock host 收到 `dsh-auth-token` cookie（`05-host-ui.*`、`fake-host-requests.log`） |
| 入池申请 | app 内输入池码 → 202 pending + 403 等待审批提示（`09-join-pending.*`） |

截图保存在构建机本地，未随仓库分发。

限制（如实）：

- host 端是 **mock sidecar**（`android/tools/fake-host-server.py`），真实 DSH UI /
  WebSocket / nonce 验签 / 真实 `dsh-auth-*` 细节未验证；需要真实 host `publicUrl` 才能进 M2.2。
- 观察到一次待审批可见性延迟约 3 分钟；`tools/directory-probe.sh` 直接查
  `includePending=1` 立即返回 pending，判断为 Cloudflare Worker/D1 读副本最终一致性，
  客户端 5 s 轮询会自愈，不是客户端查询 bug。
- debug 签名、token 存 localStorage、允许 cleartext、无图标/AndroidX/单测；`--es js_b64`
  是调试钩子。生产 Directory 留下 3 个临时测试池（池码 24 h 过期，无删除 API）。

复现命令：

```powershell
scp -r multidsh\android\* test-linux-a:~/multidsh-android/
ssh test-linux-a 'bash ~/multidsh-android/setup-env.sh'
ssh test-linux-a 'bash ~/multidsh-android/build.sh'
ssh test-linux-a 'bash ~/android-emulator.sh up'
ssh test-linux-a 'bash ~/multidsh-android/verify.sh launch'
```

## 三、Host CLI + 真实 dsh（2026-10-21）— PASS

L40 上 `@deepseek-ai/dsh@0.2.1-rc.2` 已在 Docker `node:24` 内安装成功（613 个包，
约 855 MB）；随后把安装目录只读挂进同版本容器（`--network host`），用本地 Node Directory
跑新 CLI 的完整流程：

| 步骤 | 结果 |
|---|---|
| `multidsh init` | 入池成功，生成独立 profile（端口 4188/3188、独立 DSH_HOME） |
| owner 审批 + `multidsh start` | host 健康接口 OK；dsh 子进程启动，约 5.7s 后捕获 token（`dsh.tokenCaptured=true`） |
| Directory 心跳 | `status=active` |
| 直接 `GET /` | 401（DSH 需要 `dsh-auth-*` cookie；符合配对设计，不是 dsh 启动失败） |

结论：npm 11 跳过的 install scripts 不影响 `dsh web` 基本启动；真实 DSH 版本/插件差异
只需要 `--dsh-bin` 指向对应目录（见 [`MULTI-INSTANCE.md`](MULTI-INSTANCE.md)）。

