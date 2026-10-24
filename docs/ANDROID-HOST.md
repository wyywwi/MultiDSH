# Android 作为 MultiDSH Host 的可行性分析

结论先说：

> **当前决定（2026-10-23）：暂不做 Android Host，选项 C。**  
> Android 客户端继续只作为 client 使用；Host 继续运行在 Windows/Linux。
> 本文保留为未来评估资料，不表示近期会实现。

技术上的完整结论：

> Android 可以跑 DSH Host，但不能把桌面端/Linux 那套 `node.exe + 子进程 dsh web`
> 直接照搬。需要把 Node 运行时嵌进 APK，并把 host sidecar 改成同进程管理 DSH。
> 公网访问还需要额外解决隧道问题；最现实的第一个版本是 **同一局域网内的 LAN Host**，
> 并且必须提供显式的手动停止入口，避免后台耗电。

## 1. 为什么不是“装个 APK 就能当 Host”

桌面端和 Linux 端的 host 结构是：

```text
MultiDSH host sidecar (:4080)
  └─ 子进程：node.exe dsh/lib/bin.js web --port 3080
```

Android 上直接照搬会遇到这些问题：

| 问题 | 说明 |
|---|---|
| 没有系统 Node | Android 不自带 Node，必须把 Node 运行时打进 APK（nodejs-mobile / libnode）或依赖 Termux |
| 不能随便 fork/exec | Android 应用不能像桌面一样随便启动另一个 `node` 进程；更现实的是在同一个 Node 运行时里直接加载 DSH |
| DSH 版本 | 桌面端用 Node 24 + `@deepseek-ai/dsh@0.2.1-rc.2`；nodejs-mobile 等方案需要确认 Node 版本和模块兼容性 |
| 原生依赖 | DSH 主体是 JS，但依赖里存在少量 native/optional 模块（例如 Windows 上的 koffi）；Android 需要逐个确认或提供替代 |
| 文件系统 | Android 10+ 有 scoped storage；DSH 工作区需要用户通过 SAF 选择目录，或只使用应用私有目录 |
| 公网入口 | 手机没有固定公网 IP，也不接受入站连接；局域网可直接用手机 IP，公网需要 Cloudflare Tunnel/其他隧道 |
| 后台限制 | Doze、电池优化、厂商杀后台都会中断 Node 服务；必须前台服务 + 常驻通知 |

## 2. 可行的技术路线

### 2.1 Node 运行时

优先级从高到低：

1. **nodejs-mobile**
   - 以 AAR/动态库形式嵌入 Node，应用内启动 Node 事件循环。
   - 优点：不依赖 Termux，用户安装即可用。
   - 风险：Node 版本通常落后于 24；DSH 的 ESM/新 API 需要验证。

2. **自编译 libnode / Node for Android**
   - 可控制 Node 版本，但需要 NDK、交叉编译和持续维护。

3. **Termux 方案（不推荐作为产品）**
   - 让用户在 Termux 里 `npm i @deepseek-ai/dsh` 并运行，MultiDSH 只做 UI/管理。
   - 优点：实现快，兼容性好。
   - 缺点：要求用户另装 Termux，普通用户门槛高。

### 2.2 Host 结构

不能再用“父进程 spawn 子进程”的模型，建议：

```text
Android App
  ├─ 前台服务（HostService）
  │    └─ Node 运行时
  │         ├─ 加载 host sidecar 逻辑（同进程）
  │         ├─ 加载 @deepseek-ai/dsh 并启动 web server :3080
  │         └─ 本地管理端口 :4080
  └─ UI / 通知栏“停止 Host”按钮
```

需要把 `packages/host` 里这些能力移植/复用：

- 设备注册 / 心跳
- pair nonce 校验
- 4080 → 3080 反向代理
- DSH 启动、token 捕获、退出清理

### 2.3 网络入口

**第一阶段只做 LAN：**

```text
publicUrl = http://<手机局域网 IP>:4080
```

同一 Wi-Fi 下的客户端可以直接打开。  
缺点：跨网络、手机流量、公司/校园网隔离时不可用。

**公网入口的后续选项：**

1. 交叉编译 `cloudflared` for Android arm64，作为独立 native 可执行文件由 App 启动；
   - 需要处理 token、进程管理、前台服务、升级。
2. 使用用户已有的隧道/反代（例如用户自己在路由器/服务器上做端口转发）。
3. 不做公网，明确标注 Android Host 仅 LAN。

> 不建议在没有隧道的情况下直接把手机端口暴露到公网。

### 2.4 LAN Host 与 Android HTTPS-only 的冲突

当前 0.2.0 客户端为了安全默认是 **HTTPS-only**：

```text
usesCleartextTraffic=false
network_security_config.xml 只允许 localhost / 127.0.0.1 / 10.0.2.2 明文
```

而 LAN Host 最自然的地址是：

```text
http://192.168.x.x:4080
```

这个地址会被 Android 的 network security config 拦掉。因此 LAN Host 必须先在下面
两种方案里选一个：

1. **放开私有网段明文**：允许 `10/8`、`172.16/12`、`192.168/16` 的 HTTP，
   同时由 App 层校验只允许私有地址，禁止公网 HTTP。
   - 优点：LAN 即插即用。
   - 缺点：局域网内明文传输 pair nonce / token，必须是可信 Wi-Fi。
2. **给 Host 套 HTTPS**：自己签 CA 或在 App 内信任固定证书，或者直接走
   Cloudflare Tunnel 的公网 HTTPS。
   - 优点：保持 HTTPS-only。
   - 缺点：证书分发/信任复杂，或必须依赖隧道。

在决定 Android Host 方案前，需要明确接受哪一种安全权衡。

## 3. 电池与后台策略（必须做）

Android Host 如果常驻，耗电会很明显，必须有：

- **显式手动启停**：设置页一个开关，通知栏也提供“停止”动作。
- **前台服务 + 常驻通知**：`startForeground()`，通知文案如
  “MultiDSH Host 运行中 · 点击停止”。
- **超时自动停止**：
  - 无客户端连接 N 分钟后自动停；
  - 屏幕关闭 / Wi-Fi 断开 / 切换网络时自动停；
  - 可选“仅在充电时运行”。
- **不申请无意义的唤醒锁**：优先靠前台服务；确需保活时用短时 `PARTIAL_WAKE_LOCK`。
- **电池优化提示**：引导用户把 MultiDSH 加入“不优化”列表，但要说明原因。
- **Android 14+ 前台服务类型**：需要声明合适的 `foregroundServiceType`
  （`dataSync` 或 `specialUse`）与对应权限，否则启动会抛异常。
- **心跳频率**：host 心跳保持 30s；不要为了“更实时”而缩短到秒级。

## 4. 存储与权限

- `DSH_HOME` 放在应用私有目录：
  ```text
  /data/data/com.multidsh.app/files/dsh-home
  ```
- 工作区目录：
  - 默认使用应用私有目录；或
  - 通过 SAF 让用户选择目录，持久化 `content://` URI 权限；
  - 不要申请 `MANAGE_EXTERNAL_STORAGE`。
- 文件上传/下载走 Android 的 Document picker，不要直接读任意路径。

## 5. 建议的交付阶段

### Phase 1（当前）

- Android 客户端：安全加固、原生顶部栏、设置页、浅色默认、图标。
- 设置页保留 **Android Host** 入口，明确标注“开发中”，只做说明，不误导用户。

### Phase 2（LAN Host 实验版）

- 嵌入 Node 运行时，跑通 DSH web + host sidecar（同进程）。
- 前台服务 + 通知栏停止按钮 + 超时自动停。
- 设置页：启动/停止、端口、DSH_HOME、局域网地址、电量说明。
- 只支持 LAN，不做公网。

### Phase 3（可选，公网 Host）

- 交叉编译/集成 cloudflared 或提供外部隧道配置。
- 处理 token 存储、隧道进程守护、升级和网络切换。
- 需要单独评估耗电和稳定性，不建议默认开启。

## 6. 风险清单

- Node/DSH 在 Android 上的兼容性未验证，可能出现 ESM、原生模块、文件系统差异。
- 前台服务被厂商 ROM 杀死，需要 watchdog 和用户引导。
- LAN Host 在校园网/公司网可能因客户端隔离不可达。
- 公网隧道方案会进一步增加耗电、复杂度和安全面。
- APK 体积会因 Node 运行时明显增加（预计 +30–80 MB，取决于 ABI 和裁剪）。

## 7. 结论

- **客户端 + 设置页**：现在就可以做，风险低。
- **Android Host**：技术上可行，但应按“实验性 LAN Host”推进，默认关闭、手动启停、
  前台服务、超时自动停；公网隧道放到后续阶段。
- 不建议把 Android 作为首选的长期在线 Host；它更适合临时、局域网、随身场景。
