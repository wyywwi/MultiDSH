# MultiDSH Android 客户端（0.2.0）

Android 客户端：WebView 承载的 MultiDSH 管理界面 + 原生顶部栏。
当前版本是 **client only**；Android 作为 Host 暂不支持，Host 仍请运行在
Windows / Linux（设计取舍见 [Android Host 可行性分析](../docs/ANDROID-HOST.md)）。

## 1. 当前能力

| 能力 | 说明 |
|---|---|
| Directory 地址 | 首页/设置页可编辑，保存后由原生壳重载页面 |
| 创建池 | 可输入池名，创建后成为 owner |
| 凭池码加入 | 8 位池码；加入后为 pending，等 owner 审批 |
| 设备列表 | 按 machineId 分组，显示机器名、主机/客户端、在线/离线 |
| 审批 / 吊销 | owner 可批准/拒绝 pending、吊销 active；吊销/拒绝有二次确认 |
| 本机设备名 | 设置页/池视图可改，重新加入后生效 |
| 打开 host | `POST /api/pools/:id/pair` → 同一 WebView 加载 host URL，303 后保存 `dsh-auth-*` Cookie |
| 当前 host | 列表显示「当前」徽章；返回后保留「上次打开」提示 |
| 主题 | **默认浅色**；设置页可切深色，选择持久化 |
| 顶部栏 | 原生 48dp：返回 / 标题 / 设置；打开 host 时显示 host 名 |
| 安全 | bridge token 限域、默认 non-debuggable、HTTPS-only（仅 localhost/10.0.2.2 允许明文） |

明确没有：演示模式、Android 公网 Host、二维码邀请。

## 2. 构建（ZJU-L40，无 Gradle）

需要：Android SDK build-tools 34、platform android-34、JDK 11（脚本默认
`~/android-sdk` 与 `~/jdk11home`）。

```bash
ssh ZJU-L40
cd ~/multidsh-android
bash build.sh
```

输出：

```text
dist/multidsh-android-0.2.0.apk          # 默认：non-debuggable，可 sideload
```

需要跑 `--es js` / `--es js_b64` 调试钩子或 WebView 远程调试时：

```bash
DEBUG=1 bash build.sh
# 输出 dist/multidsh-android-0.2.0-debug.apk
```

`DEBUG=1` 只是给脚本临时生成的 manifest 加 `android:debuggable`，
**不要把这个 debug APK 发给普通用户**。

构建流程：

```text
aapt2 compile res/ -> build/res.zip
aapt2 link  --manifest AndroidManifest.xml -A assets -R build/res.zip
javac 11    -source 8 -target 8
d8          -> classes.dex
zip/python  -> 注入 classes.dex
zipalign    -> 4 字节对齐
apksigner   -> debug keystore 签名
```

## 3. 安装 / 验证

模拟器：

```bash
bash verify.sh launch        # 默认使用 dist/multidsh-android-0.2.0.apk
bash verify.sh shot home
bash verify.sh dump home
```

`verify.sh js` / `jsb64` 需要安装 `DEBUG=1` 构建的 `*-debug.apk`。

## 4. 安全设计

- **Non-debuggable**：默认 APK 不启用 `--es js` 注入、不启用 WebView 调试。
- **Bridge token**：每次加载本地页面生成 32B 随机 token，替换 HTML 里的
  `__MD_BRIDGE_TOKEN__`；所有 `MDNative` 方法第一个参数校验 token。远程 host 页面
  拿不到 token，不能调用 `http/openHost/setDirectory/copy` 等能力。
- **设备 token 加密存储**：`deviceToken` 不再写入 WebView localStorage；原生壳用
  Android Keystore 的 AES/GCM 密钥加密后存入 SharedPreferences。旧的
  localStorage token 会在首次启动时迁移并删除。
- **HTTPS-only**：`usesCleartextTraffic=false` + `res/xml/network_security_config.xml`；
  仅 `localhost`、`127.0.0.1`、`10.0.2.2` 允许明文，便于本地 Directory/模拟器调试。
- **日志脱敏**：不打印完整 pair URL、nonce 或 token，只打印 host/端口/状态。
- **混合内容**：`MIXED_CONTENT_COMPATIBILITY_MODE`，不无条件允许 HTTP 资源。
- **owner 自保护**：本机设备不显示吊销按钮。

仍待改进：

- 生产上架前需要自己的 release keystore；当前 APK 仍用 debug keystore 签名。

## 5. 已知限制

1. **Android 目前不支持作为 Host**。Host 仍请运行在 Windows/Linux；原因见
   [Android Host 可行性分析](../docs/ANDROID-HOST.md)。
2. 真实 host 的 DSH Web UI 在手机上的渲染只做了基本 WebView 验证，复杂 DSH
   页面（终端、拖拽、文件选择）需要继续适配。
3. 未适配平板/横屏/大字体；当前优先手机竖屏。
4. 未实现二维码扫描加入、Host 编辑页、通知栏常驻服务。
5. 默认 Directory 是示例地址 `https://multidsh.example.com`，首次使用必须在
   设置页改成自己的地址。

## 6. 目录

```text
android/
├── AndroidManifest.xml       # 0.2.0, non-debuggable, icon, networkSecurityConfig
├── src/com/multidsh/app/
│   └── MainActivity.java     # 原生顶部栏 + 单 WebView + token bridge + 平台能力
├── assets/multidsh/index.html# 浅色默认 / 设置页 / 池视图 / 设备分组
├── res/                      # 黑色鲸鱼 launcher icon、网络安全配置
├── build.sh                  # aapt2 → javac → d8 → zipalign → apksigner
├── setup-env.sh              # L40 一次性工具链
└── verify.sh                 # 安装 / 截图 / UI dump / 调试注入
```
