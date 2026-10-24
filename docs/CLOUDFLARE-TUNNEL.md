# 用 Cloudflare Tunnel 暴露 host

Directory 只负责设备发现、审批和配对，**不中转 DSH 流量**。客户端最终会直接访问每台 host 的 `publicUrl`，所以每台 host 都需要一个客户端能访问的地址。

公网/内网服务器都推荐用 **Cloudflare Tunnel**：

```text
客户端  ──HTTPS──▶ Cloudflare 边缘  ◀──出站连接──  cloudflared  ──▶ 127.0.0.1:4080
```

- 不需要公网 IP；
- 不需要在防火墙开放 4080；
- 内网服务器只要能出站访问 Cloudflare 即可；
- 公网服务器也建议这样做，避免直接暴露源站 IP。

## 1. 子域怎么分配

一个主域名就够，按 host 分子域：

```text
example.com
├── multidsh.example.com        Directory
├── dsh-01.example.com          Linux 01 的 host
├── dsh-02.example.com          Linux 02 的 host
└── dsh-win-01.example.com      Windows 的 host
```

规则：

- **一台 host 一个子域**；
- 不要用 `example.com/dsh-01` 这种路径区分：DSH/sidecar 都按根路径设计，路径前缀会破坏 WebSocket、静态资源和 Cookie；
- 不要只换端口来区分多个 host：浏览器 Cookie 按 host 隔离，不按端口隔离，多个 host 共用一个 host 名会串登录态；
- 子域要稳定，host 的 `publicUrl` 和它保持一致。

## 2. 创建 Tunnel

先在每台 host 上安装 `cloudflared`。Ubuntu/Debian x86_64 示例：

```bash
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

ARM64 把文件名换成 `cloudflared-linux-arm64.deb`。其他系统见 Cloudflare 官方安装页。

### 2.1 在 Cloudflare Dashboard 创建

```text
Zero Trust
  → Networks
  → Tunnels
  → Create a tunnel
  → Cloudflared
```

给 Tunnel 起名，例如 `linux-01`。创建后会得到一条安装命令，类似：

```bash
sudo cloudflared service install <TOKEN>
```

在目标 Linux 服务器上执行。它会安装并启动 `cloudflared` 系统服务。

确认服务状态：

```bash
sudo systemctl status cloudflared
```

Tunnel 页面应显示 **Healthy**。

> 内网服务器不需要开放入站端口；`cloudflared` 主动连接 Cloudflare。  
> 如果公司代理阻止默认协议，可在服务配置里加 `--protocol http2`，走 443。

### 2.2 添加 Published application

在 Tunnel 页面：

```text
Add a route
  → Published application
```

填写：

```text
Subdomain:  dsh-01
Domain:     example.com
Path:       （留空）
Service:    HTTP
URL:        localhost:4080
```

保存后 Cloudflare 会自动创建 DNS 记录：

```text
dsh-01.example.com  CNAME  <tunnel-id>.cfargotunnel.com  Proxied
```

同样方式给每台 host 加自己的子域。  
同一台机器上的多个 host 实例可以共用同一个 Tunnel，加多条 Published application：

```text
dsh-a-01.example.com → localhost:4080
dsh-a-02.example.com → localhost:4081
```

不同机器则各自安装 `cloudflared`、各自创建 Tunnel。

### 2.3 验证

先在服务器本机确认 sidecar：

```bash
curl -fsS http://127.0.0.1:4080/__fleet/health
```

再从外网/客户端：

```bash
curl -i https://dsh-01.example.com/__fleet/health
```

返回 `200` + JSON 即成功。

- `502`：`cloudflared` 没连上，或本机 4080 没启动；
- `404`：Public Hostname 子域/域名填错；
- `403`：可能启用了 Cloudflare Access，先关闭；
- `522/523`：DNS/源站问题，不是 sidecar 问题。

## 3. 用 CLI 创建 Tunnel（可选）

如果不想用 Dashboard：

```bash
# 1) 登录（浏览器授权）
cloudflared tunnel login

# 2) 创建 tunnel
cloudflared tunnel create linux-01

# 3) 写配置（系统服务用 /etc/cloudflared/config.yml）
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL_UUID>.json /etc/cloudflared/
```

示例 `/etc/cloudflared/config.yml`：

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: dsh-01.example.com
    service: http://127.0.0.1:4080
  - service: http_status:404
```

```bash
# 4) 创建 DNS 记录
cloudflared tunnel route dns linux-01 dsh-01.example.com

# 5) 安装为系统服务
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

一台机器多个 host：在 `ingress` 里加多条 `hostname`，分别指向不同本地端口。

## 3.1 Windows 主机

Windows 桌面端不会自动安装 cloudflared，需要单独配置 Tunnel。推荐用 Cloudflare Dashboard 的 token 方式，不需要手写 YAML。

1. 在 Windows 上解压或下载 `cloudflared.exe`；
2. Cloudflare Dashboard：
   ```text
   Zero Trust → Networks → Tunnels → Create a tunnel
   → Cloudflared → Windows
   ```
3. 复制页面给出的安装命令，在 **管理员 PowerShell** 中执行：
   ```powershell
   .\cloudflared.exe service install <TOKEN>
   ```
4. 在 Tunnel 页面添加路由：
   ```text
   Published application
   Subdomain: win-dsh-01
   Domain:    example.com
   Path:      留空
   Service:   HTTP
   URL:       http://127.0.0.1:4080
   ```
5. 验证：
   ```powershell
   curl.exe -fsS https://win-dsh-01.example.com/__fleet/health
   ```

然后在 MultiDSH 里：

```text
设置 → DSH 主机实例 → + 新建实例
```

- `admin 端口` 填 `4080`
- `Public URL` 填 `https://win-dsh-01.example.com`
- 其他字段按安装器提示填写

如果 host 已经创建过，可以停止该实例，编辑它目录下的 `host.json`，把：

```json
"publicUrl": "https://win-dsh-01.example.com"
```

改好后重新启动实例，host 心跳会把新地址注册到 Directory。

> Tunnel 的 ingress 必须指向 sidecar 的 `4080`，不是 DSH 内部的 `3080`。  
> 每台 host 用独立子域；不要用路径区分，否则 Cookie 会串。

如果 Windows 网络下 QUIC 不稳定，先用前台 HTTP/2 验证：

```powershell
.\cloudflared.exe --protocol http2 tunnel run --token <TOKEN>
```

确认稳定后，再按 Cloudflare Dashboard 的方式安装为服务。


## 4. 公网服务器和内网服务器

### 内网服务器

只能出站、不能入站：

- 必须用 Tunnel（或 Tailscale/VPS 反向 SSH）；
- `cloudflared` 主动连 Cloudflare；
- 不需要公网 IP；
- 不需要开放 4080。

### 公网服务器

两种选择：

1. **也走 Tunnel（推荐）**：统一配置，源站 IP 不暴露，不用开 4080；
2. **直接 A 记录 + Caddy/Nginx**：
   - DNS A 记录指向公网 IP；
   - Caddy/Nginx 反代到 `127.0.0.1:4080`；
   - 只开放 443，不要开放 4080/3080；
   - Cloudflare 代理模式下建议用 Origin Certificate，SSL 用 Full (strict)；
   - 或者 DNS only，由 Caddy 申请 Let's Encrypt，但会暴露源站 IP。

Caddy 示例：

```caddyfile
dsh-pub-01.example.com {
    reverse_proxy 127.0.0.1:4080
}
```

Caddy 会自动处理 WebSocket。

## 5. 私人访问：Private hostname + WARP

如果不想让 host 暴露到公网，可以用 Cloudflare 的 **Private hostname**：

```text
Add a route → Private hostname
```

它不会创建公开 DNS，只允许安装了 Cloudflare WARP、并加入你 Zero Trust 组织的设备访问。

适合：

- 内网服务器；
- 只给自己的 Windows/Android 用；
- 不希望被公网扫描。

代价：

- 每台客户端要装 WARP 并登录你的组织；
- 比 Published application 多一步客户端配置；
- Android/Windows 都要验证 WARP 下的 WebSocket/配对。

如果不想用 Cloudflare WARP，Tailscale 的 `tailscale serve` 也是同类方案。

## 6. 安装器里填什么

Tunnel/Private hostname 配好后，Linux 安装器的 `Public URL` 填：

```text
https://dsh-01.example.com
```

不要填：

- `https://`（不完整）；
- `http://10.8.0.6:4080`（公网客户端访问不到）；
- `http://127.0.0.1:4080`（只有本机/SSH 隧道能用）；
- DSH 内部端口 `3080`。

安装器只是把地址写进 `host.json`；具体 Tunnel 要你自己按这份文档配置。

## 7. 安全提醒

Published application 是**公网可达**的：

- 不要依赖“子域难猜”当认证；
- host 只暴露 sidecar 4080，不要暴露 3080、SSH、数据库；
- 建议给 host 子域加随机后缀；
- 可在 Cloudflare 侧加 Access、WAF、速率限制；
- `cloudflared` 令牌是敏感信息，不要提交到 Git；
- 公网入口的最终认证仍依赖 DSH token/配对，不要把 DSH 直接裸奔。

## 8. 1033 / 530：cloudflared 在跑但隧道没连上

如果公网访问报 `Error 1033`，但服务器上：

- `systemctl status cloudflared` 显示 `active`
- 本机 `curl http://127.0.0.1:4080/__fleet/health` 返回 200

那么 host 和 sidecar 正常，问题在 cloudflared 到 Cloudflare 的连接。校园网/公司网络对 QUIC（UDP 7844）不稳定时，进程会卡在重连并占用高 CPU。

先看状态：

```bash
systemctl status cloudflared --no-pager
ps -p $(systemctl show -p MainPID --value cloudflared) -o pid,etime,pcpu,stat,cmd
```

如果 CPU 长期很高且隧道没有连接，改成 HTTP/2（TCP 443）：

```bash
sudo sed -i \
  's#cloudflared --no-autoupdate tunnel run#cloudflared --no-autoupdate --protocol http2 tunnel run#' \
  /etc/systemd/system/cloudflared.service
sudo systemctl daemon-reload
sudo systemctl restart cloudflared
```

验证：

```bash
curl -fsS http://127.0.0.1:4080/__fleet/health
curl -fsS https://dsh-01.example.com/__fleet/health
```
