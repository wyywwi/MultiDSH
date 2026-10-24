# Android Host 支持范围

Android 客户端只作为客户端使用。Android 设备不运行 DSH Host。

需要 Host 时，请在 Windows 或 Linux 上运行 DSH。Windows 客户端和 Linux host 包都可以托管本机 DSH。

## 为什么不在 Android 上运行 Host

DSH Host 需要：

- 一个 Node.js 运行时
- 一个长期运行的 sidecar 进程
- 前台服务和通知
- 可被其他设备访问的地址

Android 应用进程会被系统限制。手机进入后台后，系统可能停止进程。要实现稳定的 Android Host，需要把 Node.js 嵌入 APK，并管理前台服务、唤醒锁和超时停止。这个范围不在当前客户端内。

## 替代方案

- 在 Windows 电脑上运行 DSH Host，用 Android 客户端打开它。
- 在 Linux 服务器上运行 DSH Host，用 Android 客户端打开它。
- 通过 Cloudflare Tunnel 或局域网地址访问 Host。

## 相关文档

- [同一台机器运行多个 DSH](MULTI-INSTANCE.md)
- [Cloudflare Tunnel 配置](CLOUDFLARE-TUNNEL.md)
- [Android 客户端](../android/README.md)
