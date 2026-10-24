# Linux 服务器一键安装

这个安装器把 Linux 服务器变成 MultiDSH 的 **Host 端**：它会在当前用户目录安装 Node、DSH 和 MultiDSH CLI，然后一步步询问 Directory、池码、端口和访问地址，最后把 host 加入设备池并启动。

不需要桌面环境、不需要 root、不需要手动装 Node 或 DSH。

## 1. 准备

- Linux x86_64 或 arm64（Ubuntu 22.04+ / Debian 12+ 最省心）
- `bash`、`curl` 或 `wget`、`tar`
- 至少 2 GB 磁盘（DSH 本体约 855 MB）
- 一个 MultiDSH 池码：在 Windows 或 Android 客户端里「创建池」后复制 8 位码

安装位置都在当前用户目录：

| 内容 | 默认位置 |
|---|---|
| Node | `~/.local/share/multidsh/node/` |
| DSH | `~/.local/share/multidsh/dsh/` |
| MultiDSH CLI 源码 | 仓库或 release 解压目录 |
| host 配置 / DSH_HOME | `~/.multidsh/instances/<name>/` |
| CLI 包装器 | `~/.local/bin/multidsh` |

## 2. 安装

### 方式 A：从 release 包（推荐给服务器用户）

下载 Linux Host 包，解压后运行：

```bash
curl -fsSL \
  https://github.com/<your-github-user>/multidsh/releases/download/v0.1.0/MultiDSH-linux-host-0.1.0.tar.gz \
  | tar xz -C ~

cd ~/multidsh
./install.sh
```

> 把 `<your-github-user>` 换成实际仓库所有者。包内已经包含 `install.sh`，所以这是最简单的服务器路径。
> 从 Windows 上传/解压后如果缺少执行位，用 `bash install.sh` 代替 `./install.sh`。

### 方式 B：clone 仓库（推荐跟进更新）

```bash
git clone https://github.com/<your-github-user>/multidsh.git ~/multidsh
cd ~/multidsh
./install.sh
```

### 方式 C：只有 install.sh 时

`curl | bash` 时脚本拿不到仓库源码，需要显式告诉它仓库地址：

```bash
curl -fsSL \
  https://raw.githubusercontent.com/<your-github-user>/multidsh/main/install.sh \
  -o /tmp/multidsh-install.sh

MULTIDSH_REPO_URL=https://github.com/<your-github-user>/multidsh.git \
  bash /tmp/multidsh-install.sh
```

## 3. 交互流程

脚本依次检查/安装：

1. **Node**：优先用系统 Node ≥ 22；没有就下载便携版 Node 24。
2. **DSH**：优先复用已有 DSH（`~/dsh`、`--dsh-bin`、全局安装等）；没有才询问是否安装 `@deepseek-ai/dsh@0.2.1-rc.2`。
3. **MultiDSH 源码**：当前 checkout、release 包或 `--repo-url`。
4. **Directory**：填写你的连接服务地址（示例里写作 `https://multidsh.example.com`），会做健康检查。
5. **池码**：粘贴 8 位池码；**直接回车 = 跳过入池**，只安装，不启动 host。
6. **host 名、端口、Public URL、DSH_HOME**：都有默认值，回车即可。
7. **确认**后创建 host、加入池并启动。

> 非交互的 `--no-pool --yes` 默认只装 Node/CLI，不装 DSH；如果之后要入池，重新运行安装器或加 `--install-dsh`。

完成后：

- 到 Windows/Android 客户端的「待审批」里批准这台主机；
- 批准后 host 自动上线；
- 客户端点「打开 host」即可用这台 Linux 机器的 DSH。

如果选择跳过池，安装器会告诉你以后如何再入池：

```bash
cd ~/multidsh
./install.sh
# 或者
~/.local/bin/multidsh init
```

## 4. Public URL / 网络

客户端需要通过 `publicUrl` 访问这台 Linux 主机。安装时可以选择：

| 场景 | 填什么 |
|---|---|
| 只有本机 / SSH 隧道 | `http://127.0.0.1:4080` |
| 同一局域网 | `http://<服务器局域网IP>:4080` |
| Cloudflare Tunnel / 反向代理 | `https://dsh-xxxx.example.com` |

生产环境推荐 Cloudflare Tunnel：

- Tunnel 的 ingress 指向 **sidecar 端口**（默认 `4080`）；
- 不要暴露 DSH 内部端口（默认 `3080`）；
- 公网地址需要 HTTPS，客户端才能正常配对和保存 Cookie。

脚本只负责写 `publicUrl`，不会自动配置 Tunnel。子域分配、Dashboard/CLI 创建 Tunnel、Published application、Private hostname、公网/内网服务器差异、排错，见完整教程：

[`CLOUDFLARE-TUNNEL.md`](CLOUDFLARE-TUNNEL.md)

## 5. 非交互安装

CI 或批量部署时使用：

```bash
./install.sh --yes \
  --pool-code ABCD1234 \
  --name linux-01 \
  --directory https://multidsh.example.com \
  --public-url https://dsh-01.example.com \
  --admin-port 4080 \
  --dsh-port 3080
```

只安装、不入池：

```bash
./install.sh --no-pool --yes
```

其他参数：

| 参数 | 说明 |
|---|---|
| `--dsh-bin <path>` | 复用已有 `@deepseek-ai/dsh/lib/bin.js` |
| `--node-bin <path>` | 复用已有 Node |
| `--dsh-home <dir>` | 指定实例的 DSH_HOME |
| `--no-start` | 创建/入池但不启动 |
| `--repo-url <url>` | 不在 checkout 内时从 Git 仓库安装 |
| `--archive-url <url>` | 不在 checkout 内时从 tar.gz 安装 |
| `--install-dsh` | `--no-pool` 时也安装 DSH |
| `--help` | 查看全部参数 |

## 6. 开机自启（可选）

安装器的 `start` 是后台进程，重启服务器后需要再次启动。要开机自启，使用 systemd：

```bash
sudo cp ~/multidsh/scripts/multidsh-host.service.example \
  /etc/systemd/system/multidsh-host.service
sudoedit /etc/systemd/system/multidsh-host.service
```

把模板里的 `<USER>`、`<REPO>`、`<NODE_BIN>`、`<HOST_JSON>`、`<LOG_DIR>` 换成实际值，例如：

```ini
[Service]
User=ubuntu
WorkingDirectory=/home/your-user/multidsh
ExecStart=/home/your-user/.local/share/multidsh/node/bin/node \
  /home/your-user/multidsh/packages/host/bin.js run \
  --config /home/your-user/.multidsh/instances/linux-01/host.json
StandardOutput=append:/home/your-user/.multidsh/instances/linux-01/host.log
StandardError=append:/home/your-user/.multidsh/instances/linux-01/host.err.log
```

然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now multidsh-host
systemctl status multidsh-host --no-pager
journalctl -u multidsh-host -f
```

一台机器多个 host：每个实例一个 unit，使用不同的 `host.json`、端口和 `DSH_HOME`。

## 7. 数据与登录

- host 配置：`~/.multidsh/instances/<name>/host.json`
- 日志：`~/.multidsh/instances/<name>/run.log`
- DSH 登录/API key：`~/.multidsh/instances/<name>/dsh-home/.credentials.yaml`
- 再次启动：`multidsh start <name>`；**不要重复 `init`**，否则会创建新的 Directory 设备。
- 复用本机已有 DSH 登录：安装器检测到 `~/.dsh/.credentials.yaml` 时会询问是否复制到新实例。
- 多实例请各自使用独立 `DSH_HOME`；不要多个进程共享同一个 DSH_HOME。

## 8. 常见问题

**DSH 下载很慢 / 失败**

设置镜像后重试：

```bash
MULTIDSH_NPM_REGISTRY=https://registry.npmjs.org ./install.sh
```

默认使用 `https://registry.npmmirror.com`。

**找不到已有 DSH**

显式指定：

```bash
./install.sh --dsh-bin ~/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
```

**端口被占用**

脚本默认会自动找下一个空闲端口。非交互模式显式传了被占用端口时会报错，去掉 `--admin-port/--dsh-port` 让脚本自动选，或换一个端口。

**Public URL 填错**

编辑 `~/.multidsh/instances/<name>/host.json` 里的 `publicUrl`，然后：

```bash
multidsh stop <name>
multidsh start <name>
```

**非交互模式提示需要池码**

加 `--pool-code <code>`，或明确只安装：

```bash
./install.sh --no-pool --yes
```

## 9. 发布到 GitHub 时的准备

发布前把文档和 README 里的：

- `<your-github-user>` 换成实际账号；
- release 包名/版本号与 `dist/` 产物一致；
- 如果希望支持 `curl | bash`，可以让用户设置 `MULTIDSH_REPO_URL`，或把 `install.sh` 和源码一起打进 release tar。

仓库根目录的 `.gitattributes` 已把 `*.sh`、`multidsh` 固定为 LF，避免 Windows 上传后脚本出现 CRLF 报错。

安装器不依赖仓库的绝对路径：从 release 包、clone 目录或 `--repo-url` 运行都可以。
