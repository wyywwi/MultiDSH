# Android 开发与测试方案（M2）

结论先说：**没有实体 Android 设备也能开发**。本仓库已经在 test-linux-a（192 核、KVM）上跑通
headless Android 14 模拟器（见 [`ANDROID-ENV.md`](ANDROID-ENV.md)），并验证了
「Windows 本地构建 → 远程模拟器安装/运行/截图」的完整回路；Android 端 M2 按下面的分层开发。

## 1. 已具备的测试能力（已验证）

| 能力 | 状态 |
|---|---|
| Android 14 / API 34 模拟器（x86_64，google_apis） | ✅ test-linux-a，KVM，冷启动 ~25s（host 网络模式下 10s） |
| 从 Windows 远程 adb | ✅ `ssh -L 5555:127.0.0.1:5555` + 本地 platform-tools，`adb devices` 显示 `127.0.0.1:5555 device` |
| 远程截图 | ✅ `adb exec-out screencap -p` → `.tmp/android/win-adb-boot.png`（1080×2340） |
| 包管理 | ✅ 223 个预装包，可 `pm list packages` / `adb install` |
| Android 构建依赖（Windows 侧） | ✅ `dl.google.com`、`maven.google.com`、`repo1.maven.org`、`services.gradle.org` 均可达 |
| 构建依赖（构建机侧） | ⚠️ `dl.google.com` 可达（SDK/模拟器可装），`maven.google.com` 超时 → **不要在构建机上跑 Gradle 构建**，只把它当设备农场 |

## 2. 开发环境

- **IDE/构建**：Windows 本机装 Android SDK command-line tools + platform-tools + platforms;android-34 + build-tools；Gradle 用 wrapper（依赖从 Google Maven 拉，本机网络已确认可达）。
- **运行/调试**：test-linux-a 的 headless 模拟器 + SSH 隧道 adb（脚本 `scripts/android-emulator.sh`，`NETWORK=host`）。
- **CI（可选）**：暂时不必；M2 用「本机 `./gradlew assembleDebug` + `adb install` + adb 截图」即可覆盖 UI 回归。

Windows 侧一次性准备：

```powershell
# 1) 下载 command line tools 与 platform-tools（dl.google.com）
#    https://dl.google.com/android/repository/commandlinetools-win-*_latest.zip
#    https://dl.google.com/android/repository/platform-tools-latest-windows.zip
# 2) sdkmanager 安装
sdkmanager --sdk_root=$env:ANDROID_SDK_ROOT "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

## 3. App 架构（与 M0/M1 协议对齐）

```
MultiDSH Android (client-only)
├── protocol/         Directory API client（与 packages/protocol 同一 HTTP 契约）
│   ├── createPool / join / approve / listDevices / pair
│   └── token / pairSecret 的持久化（EncryptedSharedPreferences）
├── ui/               Jetpack Compose
│   ├── 入池/建池（池码 24h + 待审批卡片）
│   ├── 设备列表（host 在线状态、最后在线时间）
│   └── 打开 host：WebView + CookieManager
└── deep link         multidsh://host/<deviceId>
```

要点：

1. **会话严格 host 绑定**：Android 只做 client，打开的是 host 的 Web UI，不在手机上跑 agent。
2. **配对**：调 `POST /api/pools/:id/pair {hostId}` 拿一次性 `https://<host>/__fleet/pair?nonce=...`，WebView 加载该 URL → 303 → DSH 设 `dsh-auth-*` cookie（WebView 的 CookieManager 自动保存），之后加载 `https://<host>/`。
3. **无账户**：设备 token 存在 Android Keystore/EncryptedSharedPreferences；不引入邮箱/验证码。
4. **网络**：Directory 用 `https://multidsh.example.com`（已部署）；host 子域建议每台随机 128-bit 后缀，避免扫描。
5. **降级**：WebView 里可注入一个极简 JS bridge 用于「刷新/回列表」，不把业务逻辑放网页里。

## 4. 测试策略（无真机）

| 层 | 手段 | 在哪些环境跑 |
|---|---|---|
| 协议/JSON/状态机 | JVM 单元测试（JUnit） | Windows 本机，秒级 |
| UI 逻辑 | Compose UI Test（Robolectric 或 instrumented） | Windows 本机 / 模拟器 |
| 端到端 | `adb install` + 启动 Activity + `adb shell input` + `adb exec-out screencap` 截图断言 | test-linux-a 模拟器（已验证 adb 通路） |
| 回归 | 截图存档 `.tmp/android/*.png` + 关键 View 的 `uiautomator dump` 断言 | 同上 |

## 5. 里程碑建议

- **M2.1**：Gradle 工程骨架（Kotlin + Compose，minSdk 26 / target 34），Directory client + 设备列表 + 池码输入，JVM 单测；`assembleDebug` 出 APK，`adb install` 到构建机模拟器。
- **M2.2**：WebView 打开 host（pair→303→cookie），加载 DSH UI，截图验收；深链 `multidsh://host/<id>`。
- **M2.3**：错误态（host 离线/设备被撤销/池码过期）、快速派发入口预留、APK 签名与 sideload 说明。

## 6. 风险与对策

- **WebView 与 DSH 的 cookie 兼容性**：`SameSite=Strict` + 自定义域；需在模拟器上实测 303 后的 cookie 是否被 WebView 接受（M2.2 第一件事）。
- **Android 网络策略**：host 子域随机后缀 + 仅 HTTPS；客户端不校验证书固定（不引入账户体系）。
- **模拟器无 GMS Play Store**：`google_apis` 镜像带基础 GMS；若 M2 暂不做推送，无需 Play Store 镜像。
- **构建机网络限制**：只用于跑模拟器/adb，构建留在 Windows；若以后要 CI，可在能访问 Google Maven 的机器上构建或配镜像源。
