# Android 测试环境（test-linux-a headless 模拟器）

> 状态：**已验证可用**（2026-10-20，UTC 15:49）。在 test-linux-a 上用 Docker + KVM 跑起了 Android 14（API 34）headless 模拟器，
> `adb` 可用、`sys.boot_completed=1`、已截图落盘 `.tmp/android/boot.png`（1080×2340）。
>
> 覆盖任务：MultiDSH M2 之前的「有可用 Android 测试环境」验证；本文件只描述环境，不包含 App 代码。

## 1. 结论

| 项 | 结果 |
|---|---|
| 模拟器启动 | ✅ 冷启动 `sys.boot_completed=1` 用时 **25s**（容器内 `emulator`，KVM 加速） |
| 系统 | Android 14 / API 34 / `sdk_gphone64_x86_64` / x86_64 / google_apis |
| 屏幕 | 1080×2340（AVD device profile = `pixel_5`） |
| adb | ✅ `adb devices` → `emulator-5554  device`，可 `shell` / `exec-out screencap` |
| 截图证据 | 服务器 `~/android-sdk/boot.png`（1,280,452 B，sha256 `bb23f872…49301cf`），本仓库 `.tmp/android/boot.png` |
| 预装包数 | 223 个（`pm list packages \| wc -l`），Launcher 已就绪 |
| 资源占用 | 单模拟器约 2–3 GB RAM；宿主 192 vCPU / 503 GB RAM，可并行多台 |
| 阻塞项 | 无（全部绕开，见第 6 节） |

**能力边界**：headless + 软件 GPU（`swiftshader_indirect`），无窗口、无音频、无摄像头；适合 adb 驱动、UI 自动化、截图回归、CI 里的 instrumentation 测试。不适合需要真实 GPU 帧率/音视频硬解的场景。

## 2. 环境事实（实测，非假设）

宿主（`ssh test-linux-a`，hostname `node19`）：

| 项 | 值 |
|---|---|
| OS / 内核 | Ubuntu 22.04，`5.15.0-191-generic` |
| CPU / 内存 | 192 vCPU / 503 GB（空闲约 480 GB） |
| 磁盘 | `/` 437 G，已用 61%，空闲 163 G（SDK 共占 6.4 G） |
| KVM | `/dev/kvm` 存在，`crw-rw---- root:kvm`（gid **108**） |
| 用户 | `<user>`，组 `<user>,sudo,docker`；**不在 `kvm` 组** |
| sudo | **需要密码**（无 NOPASSWD），因此不能 `chmod /dev/kvm` 或改宿主机用户组 |
| Docker | 28.5.1，overlay2，cgroup v2，用户可直接 `docker` |
| 时区 | 服务器时钟为 UTC（本机 Asia/Singapore = UTC+8） |

网络（实测 `curl`）：

| 目标 | 可达性 |
|---|---|
| `dl.google.com` | ✅ 200，单流约 7 MB/s（android repository 直链可用） |
| Docker Hub `registry-1.docker.io` | ❌ 超时 |
| `docker.m.daocloud.io`（Docker Hub 镜像源） | ✅ 可 pull `library/ubuntu:22.04` |
| `archive.ubuntu.com` / `security.ubuntu.com` | ✅ 可 apt（约 7 MB/s，装依赖略慢） |
| `github.com` | ❌ 不可达 |
| `registry.npmjs.org` | ✅ 200 |

关键点：**用户不在 kvm 组且 sudo 要密码** → 宿主机直接跑 `emulator` 拿不到 `/dev/kvm`。
解法：模拟器跑在 Docker 容器里，`--device /dev/kvm --group-add 108` 透传，容器内 uid 1000 与宿主用户对齐，SDK 目录宿主可读写。

## 3. 一键使用

脚本：`multidsh/scripts/android-emulator.sh`（**在 test-linux-a 上执行**，不需要 Windows 端有 bash）。

```bash
# 从本机（Windows PowerShell 也可以）把脚本送上去并启动：
scp multidsh/scripts/android-emulator.sh test-linux-a:~/
ssh test-linux-a 'bash ~/android-emulator.sh up'          # 首次约 10 分钟（装镜像+SDK），之后约 30 秒
ssh test-linux-a 'bash ~/android-emulator.sh status'      # 容器 / adb / boot_completed
ssh test-linux-a 'bash ~/android-emulator.sh shot'        # 再截一张到 ~/android-sdk/boot.png
ssh test-linux-a 'bash ~/android-emulator.sh shell'       # 交互 adb shell
ssh test-linux-a 'bash ~/android-emulator.sh down'        # 停+删容器（SDK/AVD 保留）
ssh test-linux-a 'bash ~/android-emulator.sh down --wipe' # 连 AVD 状态一起删
```

若有 Git Bash / WSL，也可不落盘直接流式执行：

```bash
ssh test-linux-a 'bash -s' < multidsh/scripts/android-emulator.sh
```

取截图回本机：

```bash
scp test-linux-a:~/android-sdk/boot.png .tmp/android/boot.png
```

脚本可覆盖的变量（`SDK_ROOT` / `AVD_NAME` / `AVD_DEVICE` / `API` / `IMAGE` / `BASE_IMAGE` / `BOOT_TIMEOUT`），例如同机并行第二台：

```bash
ssh test-linux-a 'AVD_NAME=multidsh35 CONTAINER=multidsh-emulator-2 bash ~/android-emulator.sh up'
```

## 4. 完整复现步骤（从零，实测可重放）

### 4.1 Docker 镜像

`Dockerfile` 由脚本 `dockerfile` 子命令输出（`bash ~/android-emulator.sh dockerfile`）。要点：

- 基础镜像：`docker.m.daocloud.io/library/ubuntu:22.04`（Docker Hub 直连不通，必须用镜像源；可用 `BASE_IMAGE=` 换源）。
- 安装 JDK 17（`openjdk-17-jre-headless`）+ 模拟器运行库（`libpulse0 libnss3 libx11* libxcb* libgl1 libglu1-mesa libgbm1 libxkbcommon* libasound2 libgtk-3-0 ...`）。
- 建 uid/gid 1000 的 `builder` 用户，工作目录 `/sdk`，与宿主用户对齐文件权限。

```bash
docker build -t multidsh/android-emulator:34 /tmp/multidsh-android-image
# 实测：566 MB，约 2–3 分钟（瓶颈是 archive.ubuntu.com 的 apt 下载）
```

### 4.2 安装 Android SDK（约 6.4 GB，实测 ~4 分钟）

```bash
mkdir -p ~/android-sdk/{avd,home,dl}
curl -sSL -o ~/android-sdk/dl/cmdline-tools.zip \
  https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip   # 153 MB
unzip -q ~/android-sdk/dl/cmdline-tools.zip -d /tmp/ct
mkdir -p ~/android-sdk/cmdline-tools && mv /tmp/ct/cmdline-tools ~/android-sdk/cmdline-tools/latest
```

`sdkmanager` 必须在 **JDK 17** 下运行（宿主只有 JDK 11，跑会报版本错误），所以放进容器：

```bash
docker run --rm --user "$(id -u):$(id -g)" -v ~/android-sdk:/sdk \
  -e ANDROID_SDK_ROOT=/sdk multidsh/android-emulator:34 bash -lc '
    export ANDROID_AVD_HOME=/sdk/avd ANDROID_USER_HOME=/sdk/home
    yes | sdkmanager --sdk_root=/sdk --licenses >/dev/null
    sdkmanager --sdk_root=/sdk --install \
      "platform-tools" "emulator" "platforms;android-34" \
      "system-images;android-34;google_apis;x86_64"'
```

实测安装结果：

| 包 | 版本 |
|---|---|
| `cmdline-tools` | 11076708（latest） |
| `emulator` | 37.2.12 (build_id 16428233) |
| `platform-tools` | 37.0.1 |
| `platforms;android-34` | rev 3 |
| `system-images;android-34;google_apis;x86_64` | rev 14（`x86_64-34_r14.zip`，压缩约 1.5 GB） |

### 4.3 创建 AVD

```bash
docker run --rm --user "$(id -u):$(id -g)" -v ~/android-sdk:/sdk \
  -e ANDROID_SDK_ROOT=/sdk -e ANDROID_AVD_HOME=/sdk/avd -e ANDROID_USER_HOME=/sdk/home \
  --entrypoint bash multidsh/android-emulator:34 -lc \
  "echo no | avdmanager create avd -n multidsh34 \
     -k 'system-images;android-34;google_apis;x86_64' --device pixel_5 --force"
```

> 不加 `--device` 时 AVD 默认 320×640（太小，截图/UI 测试失真）；`pixel_5` → 1080×2340。

### 4.4 启动模拟器（KVM 透传，后台容器）

```bash
docker run -d --name multidsh-emulator \
  --device /dev/kvm --group-add "$(stat -c %g /dev/kvm)" --user "$(id -u):$(id -g)" \
  -v ~/android-sdk:/sdk \
  -e ANDROID_SDK_ROOT=/sdk -e ANDROID_AVD_HOME=/sdk/avd -e ANDROID_USER_HOME=/sdk/home \
  --entrypoint bash multidsh/android-emulator:34 -lc \
  "adb start-server >/dev/null 2>&1; exec emulator -avd multidsh34 \
     -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on \
     -no-snapshot -camera-back none -camera-front none -netdelay none -netspeed full"
```

### 4.5 等待启动 + 截图

```bash
docker exec multidsh-emulator adb wait-for-device
until [ "$(docker exec multidsh-emulator adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 5; done
docker exec multidsh-emulator adb shell getprop ro.build.version.release   # 14
docker exec multidsh-emulator adb shell wm size                            # Physical size: 1080x2340
docker exec multidsh-emulator sh -c 'adb exec-out screencap -p > /sdk/boot.png'
scp test-linux-a:~/android-sdk/boot.png .tmp/android/boot.png
```

实测：`wait-for-device` + `boot_completed=1` 共 **25 s**；截图 1080×2340 RGBA PNG，1.28 MB。

### 4.6 清理

```bash
docker exec multidsh-emulator adb kill-server 2>/dev/null || true
docker rm -f multidsh-emulator
# 可选：rm -rf ~/android-sdk/avd ~/android-sdk/home   （脚本 down --wipe）
# 彻底卸载：docker rmi multidsh/android-emulator:34; rm -rf ~/android-sdk  （回收 6.4 GB + 566 MB）
```

## 5. adb 的两种用法

默认（已验证）：adb server 在容器内，用 `docker exec` 驱动：

```bash
docker exec multidsh-emulator adb devices
docker exec multidsh-emulator adb shell pm list packages | head
docker exec multidsh-emulator adb install app-debug.apk
docker exec multidsh-emulator adb logcat -d -s AndroidRuntime
```

若要从宿主直接 `adb`（例如宿主跑 Gradle instrumentation 测试），可给容器加 `--network host`，让容器内 5554/5555 落在宿主网络上，再 `adb connect 127.0.0.1:5555`。
该模式**本轮未验证**，需要时再加；当前容器为默认 bridge 网络，宿主 `adb` 看不到设备。

## 6. 坑与规避（实测踩过）

| # | 坑 | 现象 | 规避 |
|---|---|---|---|
| 1 | Docker Hub 不可达 | `docker pull ubuntu:22.04` 卡住/超时 | 基础镜像换 `docker.m.daocloud.io/...`（实测可用） |
| 2 | 用户不在 `kvm` 组，sudo 要密码 | 宿主直接跑 `emulator` 报 `KVM is not installed / permission denied` | `docker run --device /dev/kvm --group-add 108`，容器内用（未改宿主权限） |
| 3 | 宿主只有 JDK 11 | `sdkmanager` 直接跑报 UnsupportedClassVersionError 类错误 | JDK 17 装进镜像，`sdkmanager` 在容器里跑 |
| 4 | 容器内 uid 与宿主不一致 | 挂载的 `~/android-sdk` 里文件变 root 所有，后续清理/覆盖失败 | 镜像内建 uid 1000 用户，`--user "$(id -u):$(id -g)"` 运行 |
| 5 | AVD 默认屏幕 320×640 | 截图/home 布局失真 | `avdmanager --device pixel_5` |
| 6 | `ANDROID_USER_HOME` 未固定 | adb key/AVD 落到容器临时 home，重启后丢 | 统一 `ANDROID_AVD_HOME=/sdk/avd`、`ANDROID_USER_HOME=/sdk/home` |
| 7 | 快照残留 / 磁盘写放大 | 反复启停后启动变慢或状态脏 | `-no-snapshot`；需要干净状态用 `down --wipe` |
| 8 | `ssh test-linux-a` 有 `RemoteForward 8890` 警告 | 每次命令都打印 `remote port forwarding failed` | 与本任务无关，可忽略（或从 `~/.ssh/config` 去掉该转发） |
| 9 | 下载量大 | SDK 6.4 GB + 镜像 566 MB | 全流程在服务器侧完成，不要在 Windows 拉 SDK；长命令放后台 `nohup` + 轮询 |

## 7. 如果模拟器不可行的备选方案（本轮未启用，仅风险预案）

主方案已在 test-linux-a 跑通，以下仅作 Plan B（例如换机器、KVM 被收回、需要真机行为时）：

| 方案 | 做法 | 成本/限制 |
|---|---|---|
| **Windows 本地模拟器（WHPX）** | Android Studio → SDK Manager 装 `android-34` + google_apis x86_64 → 开「Windows 虚拟机监控程序平台」→ `emulator -avd ... -gpu swiftshader_indirect` | 一次性 1–2 h 配置、8–10 GB 磁盘、2–4 GB 内存；需开启虚拟化（Windows 家庭版没有 Hyper-V/WHPX，只能退回极慢的软件模拟）；本机到 `dl.google.com` 的下载速度未验证；有窗口，适合交互调试 |
| **云真机** | Firebase Test Lab（Robo/虚拟/真机矩阵）、BrowserStack、阿里云/腾讯云真机 | 本地零成本、真实设备；但需 Google 账号 + 计费账户，或国内实名账号与按分钟计费（约 0.5–2 元/分钟，或 40–100 元/月起）；本项目**无账号**，接入需额外审批 |
| **build-only + Robolectric** | 不跑模拟器：Gradle `assembleDebug` + JVM 单测 + Robolectric（含 `@Config(sdk=34)`） | 秒级、零外部依赖、可进 CI；但只覆盖 JVM/资源/部分 framework，**无法验证 UI 渲染、截图、真实网络与设备能力**；适合 M2 脚手架阶段先行，UI 回归再接模拟器 |

建议：M2 阶段以 test-linux-a 模拟器为主（已验证、可并行多台）；Robolectric 作为本地/CI 快速门禁；真机只在需要 OEM/传感器/性能数据时按需接入。

## 8. 从 Windows 远程驱动模拟器（已验证）

脚本默认桥接网络，Windows 只能 `docker exec` 间接用 adb；现在支持 `NETWORK=host`：adb server 监听宿主
`127.0.0.1:5555`，Windows 经 SSH 隧道即可直连，做到「本机构建 → 远程安装/运行/截图」。

```powershell
# 1) 服务器上以 host 网络启动
scp multidsh\scripts\android-emulator.sh test-linux-a:~/
ssh test-linux-a 'NETWORK=host bash ~/android-emulator.sh up'

# 2) Windows 侧 platform-tools（dl.google.com 下载 platform-tools-latest-windows.zip）

# 3) 隧道 + adb
ssh -N -L 127.0.0.1:5555:127.0.0.1:5555 test-linux-a
adb connect 127.0.0.1:5555
adb devices                              # 127.0.0.1:5555  device
adb shell getprop sys.boot_completed     # 1
adb exec-out screencap -p > .tmp\android\win-adb-boot.png
```

实测（2026-10-21）：Windows adb 37.0.1 连上构建机的模拟器，`sys.boot_completed=1`、Android 14、223 个包，
截图 1080×2340 落在 `.tmp/android/win-adb-boot.png`。

踩坑：

- 构建机的 `~/.ssh/config` 带 `RemoteForward 8890`；本机 ssh 若加 `ExitOnForwardFailure=yes`，该转发失败会让整个隧道退出。用显式 `ssh -i <key> -p <port> <user>@<host>`（不读 config）或去掉该选项。
- `adb.exe` 首次启动要写 `%USERPROFILE%\.android` 和 `%TEMP%\adb.log`；被 ACL 拦住时先 `mkdir %USERPROFILE%\.android`，并把 `TEMP` 指到可写目录。
- 容器被杀会留下 AVD `*.lock`，导致 `Running multiple emulators with the same AVD`；脚本 `up` 已自动清理。

## 9. 文件清单

| 路径 | 说明 |
|---|---|
| `multidsh/scripts/android-emulator.sh` | 一键 `up/status/shot/shell/log/down/dockerfile`（服务器侧执行；`NETWORK=host` 支持远程 adb） |
| `multidsh/docs/ANDROID-ENV.md` | 本文件：复现步骤、版本、坑、备选方案 |
| `multidsh/docs/ANDROID-PLAN.md` | M2 Android 开发与测试方案（架构、构建、测试分层、里程碑） |
| `.tmp/android/boot.png` | 服务器侧开机截图（1080×2340，1.28 MB） |
| `.tmp/android/win-adb-boot.png` | Windows 经 SSH 隧道远程 adb 截图（1080×2340，1.36 MB） |
| `.tmp/android/env-report.md` | 实执行命令、耗时、原始输出摘要 |

服务器侧产物（不入库）：`~/android-sdk/`（SDK 6.4 GB + AVD）、Docker 镜像 `multidsh/android-emulator:34`（566 MB）、容器 `multidsh-emulator`。
