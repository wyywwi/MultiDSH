#!/usr/bin/env bash
# MultiDSH Linux host installer / first-run wizard.
#
# Usage:
#   ./install.sh
#   ./install.sh --no-pool
#   ./install.sh --pool-code ABCD1234 --yes
#
# This script is intentionally dependency-light: it installs Node and DSH into
# the current user's home, copies nothing outside it, and never needs root.
# Run it from a MultiDSH checkout, or give it a repository/archive URL.
set -euo pipefail

VERSION="0.1.0"
DEFAULT_DIRECTORY="${MULTIDSH_DIRECTORY:-https://multidsh.example.com}"
DEFAULT_DSH_VERSION="${MULTIDSH_DSH_VERSION:-0.2.1-rc.2}"
DEFAULT_NODE_VERSION="${MULTIDSH_NODE_VERSION:-24.21.0}"
DEFAULT_NPM_REGISTRY="${MULTIDSH_NPM_REGISTRY:-https://registry.npmmirror.com}"

INSTALL_ROOT="${MULTIDSH_INSTALL_ROOT:-$HOME/.local/share/multidsh}"
APP_DIR="${MULTIDSH_APP_DIR:-$INSTALL_ROOT/app}"
NODE_DIR="${MULTIDSH_NODE_DIR:-$INSTALL_ROOT/node}"
DSH_DIR="${MULTIDSH_DSH_DIR:-$INSTALL_ROOT/dsh}"
MULTIDSH_HOME="${MULTIDSH_HOME:-$HOME/.multidsh}"
export MULTIDSH_HOME

TTY_FD=""
INTERACTIVE=1
YES=0
NO_POOL=0
NO_START=0
POOL_CODE=""
NAME=""
DIRECTORY_URL=""
PUBLIC_URL=""
ADMIN_PORT=""
DSH_PORT=""
DSH_HOME=""
DSH_BIN_FLAG=""
NODE_BIN_FLAG=""
REPO_URL="${MULTIDSH_REPO_URL:-}"
ARCHIVE_URL="${MULTIDSH_ARCHIVE_URL:-}"
INSTALL_DSH=0
SKIP_DSH=0
NODE_BIN=""
NPM_CMD=()
APP_DIR_RESOLVED=""
MULTIDSH_CLI=""

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[36m'
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_BLUE=""
fi

say() { printf '%s\n' "$*"; }
info() { printf '%s\n' "${C_BLUE}[info]${C_RESET} $*"; }
ok() { printf '%s\n' "${C_GREEN}[ok]${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}[warn]${C_RESET} $*" >&2; }
die() { printf '%s\n' "${C_RED}[error]${C_RESET} $*" >&2; exit 1; }
section() { printf '\n%s\n' "${C_BOLD}== $* ==${C_RESET}"; }

usage() {
  cat <<'EOF'
MultiDSH Linux host installer

用法:
  ./install.sh                       交互式安装并配置
  ./install.sh --no-pool             只安装，不加入池
  ./install.sh --pool-code ABCD1234  非交互式入池
  ./install.sh --help

常用参数:
  --directory <url>      Directory 地址（默认 https://multidsh.example.com）
  --pool-code <code>     8 位池码；留空/不传则询问，交互时可跳过
  --name <name>          host 名字（默认 <hostname>-dsh）
  --public-url <url>     客户端访问地址；默认按局域网 IP 生成
  --admin-port <port>     sidecar 端口（默认 4080，被占用自动 +1）
  --dsh-port <port>       DSH 内部端口（默认 3080，被占用自动 +1）
  --dsh-home <dir>       该实例的 DSH_HOME
  --dsh-bin <path>       已有 DSH 的 lib/bin.js（不给则安装/探测）
  --node-bin <path>      已有 Node（不给则使用系统 Node 或下载便携版）
  --no-pool              跳过入池，只安装依赖和 CLI
  --no-start             完成配置但不启动 host
  --yes, -y              非交互模式，使用参数/默认值
  --repo-url <url>       从 Git 仓库安装 MultiDSH（不在 checkout 内运行时）
  --archive-url <url>    从 tar.gz 归档安装 MultiDSH
  --install-dsh          即使 --no-pool 也安装 DSH
  --version              显示版本
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --directory) DIRECTORY_URL="${2:-}"; shift 2 ;;
      --directory=*) DIRECTORY_URL="${1#*=}"; shift ;;
      --pool-code) POOL_CODE="${2:-}"; shift 2 ;;
      --pool-code=*) POOL_CODE="${1#*=}"; shift ;;
      --name) NAME="${2:-}"; shift 2 ;;
      --name=*) NAME="${1#*=}"; shift ;;
      --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
      --public-url=*) PUBLIC_URL="${1#*=}"; shift ;;
      --admin-port) ADMIN_PORT="${2:-}"; shift 2 ;;
      --admin-port=*) ADMIN_PORT="${1#*=}"; shift ;;
      --dsh-port) DSH_PORT="${2:-}"; shift 2 ;;
      --dsh-port=*) DSH_PORT="${1#*=}"; shift ;;
      --dsh-home) DSH_HOME="${2:-}"; shift 2 ;;
      --dsh-home=*) DSH_HOME="${1#*=}"; shift ;;
      --dsh-bin) DSH_BIN_FLAG="${2:-}"; shift 2 ;;
      --dsh-bin=*) DSH_BIN_FLAG="${1#*=}"; shift ;;
      --node-bin) NODE_BIN_FLAG="${2:-}"; shift 2 ;;
      --node-bin=*) NODE_BIN_FLAG="${1#*=}"; shift ;;
      --repo-url) REPO_URL="${2:-}"; shift 2 ;;
      --repo-url=*) REPO_URL="${1#*=}"; shift ;;
      --archive-url) ARCHIVE_URL="${2:-}"; shift 2 ;;
      --archive-url=*) ARCHIVE_URL="${1#*=}"; shift ;;
      --no-pool|--skip-pool) NO_POOL=1; shift ;;
      --no-start) NO_START=1; shift ;;
      --install-dsh) INSTALL_DSH=1; shift ;;
      --yes|-y) YES=1; shift ;;
      --version) printf '%s\n' "MultiDSH Linux installer $VERSION"; exit 0 ;;
      --help|-h) usage; exit 0 ;;
      *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
  done

  if [[ "$YES" == 1 ]]; then
    INTERACTIVE=0
  fi
  if [[ "$INTERACTIVE" == 1 ]]; then
    if [[ -t 0 ]]; then
      TTY_FD=0
    elif exec 3</dev/tty 2>/dev/null; then
      TTY_FD=3
    else
      INTERACTIVE=0
      TTY_FD=""
    fi
  fi
}

prompt() {
  local label="$1"
  local default="${2:-}"
  local answer=""
  if [[ "$INTERACTIVE" != 1 ]]; then
    printf '%s' "$default"
    return 0
  fi
  while :; do
    printf '%s' "$label" >&2
    [[ -n "$default" ]] && printf ' [%s]' "$default" >&2
    printf ': ' >&2
    IFS= read -r answer <&"$TTY_FD" || answer=""
    answer="${answer:-$default}"
    if [[ -n "$answer" ]]; then
      printf '%s' "$answer"
      return 0
    fi
    printf '  需要填写这一项。\n' >&2
  done
}

prompt_optional() {
  local label="$1"
  local default="${2:-}"
  local answer=""
  if [[ "$INTERACTIVE" != 1 ]]; then
    printf '%s' "$default"
    return 0
  fi
  printf '%s' "$label" >&2
  [[ -n "$default" ]] && printf ' [%s]' "$default" >&2
  printf ': ' >&2
  IFS= read -r answer <&"$TTY_FD" || answer=""
  printf '%s' "${answer:-$default}"
}

confirm() {
  local label="$1"
  local default="${2:-n}"
  local answer=""
  if [[ "$INTERACTIVE" != 1 ]]; then
    [[ "$default" == "y" || "$default" == "Y" ]]
    return $?
  fi
  while :; do
    printf '%s [%s] ' "$label" "$([[ "$default" == "y" || "$default" == "Y" ]] && printf 'Y/n' || printf 'y/N')" >&2
    IFS= read -r answer <&"$TTY_FD" || answer=""
    answer="${answer:-$default}"
    case "${answer,,}" in
      y|yes|是) return 0 ;;
      n|no|否) return 1 ;;
      *) printf '  请输入 y 或 n。\n' >&2 ;;
    esac
  done
}

check_platform() {
  [[ "$(uname -s)" == "Linux" ]] || die "这个安装器只支持 Linux；当前系统：$(uname -s)"
  [[ "$(uname -m)" =~ ^(x86_64|amd64|aarch64|arm64)$ ]] || die "暂不支持 CPU 架构：$(uname -m)"
}

run_download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 20 --max-time 600 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=20 -O "$dest" "$url"
  else
    die "需要 curl 或 wget 下载文件"
  fi
}

version_ge() {
  local have="$1" want="$2"
  printf '%s\n%s\n' "$want" "$have" | sort -V -C
}

node_version() {
  "$1" -p 'process.versions.node' 2>/dev/null | head -n1
}

absolute_path() {
  local p
  p="$(expand_home "$1")"
  if [[ "$p" != /* ]]; then
    p="$(cd "$(dirname "$p")" 2>/dev/null && pwd)/$(basename "$p")"
  fi
  printf '%s' "$p"
}

ensure_node() {
  section "1/6 检查 Node"
  if [[ -n "$NODE_BIN_FLAG" ]]; then
    NODE_BIN="$(absolute_path "$NODE_BIN_FLAG")"
    [[ -x "$NODE_BIN" ]] || die "指定的 Node 不存在或不可执行：$NODE_BIN"
    ok "使用指定 Node：$NODE_BIN"
  elif command -v node >/dev/null 2>&1 && version_ge "$(node_version node)" "22.0.0"; then
    NODE_BIN="$(command -v node)"
    ok "使用系统 Node：$NODE_BIN ($(node_version "$NODE_BIN"))"
  elif [[ -x "$NODE_DIR/bin/node" ]] && version_ge "$(node_version "$NODE_DIR/bin/node")" "22.0.0"; then
    NODE_BIN="$NODE_DIR/bin/node"
    ok "使用已安装的便携 Node：$NODE_BIN ($(node_version "$NODE_BIN"))"
  else
    local arch="$DEFAULT_NODE_VERSION"
    case "$(uname -m)" in
      x86_64|amd64) arch="x64" ;;
      aarch64|arm64) arch="arm64" ;;
      *) die "不支持的 CPU 架构：$(uname -m)" ;;
    esac
    local name="node-v${DEFAULT_NODE_VERSION}-linux-${arch}"
    local tarfile="$INSTALL_ROOT/node.tar.xz"
    mkdir -p "$INSTALL_ROOT"
    info "未找到可用的 Node，下载便携版 Node ${DEFAULT_NODE_VERSION} ($arch)…"
    local mirrors=(
      "${MULTIDSH_NODE_MIRROR:-https://nodejs.org/dist}"
      "https://npmmirror.com/mirrors/node"
    )
    local downloaded=0
    for mirror in "${mirrors[@]}"; do
      if run_download "${mirror}/v${DEFAULT_NODE_VERSION}/${name}.tar.xz" "$tarfile"; then
        downloaded=1
        break
      fi
      warn "下载失败，尝试下一个镜像：$mirror"
    done
    [[ "$downloaded" == 1 ]] || die "Node 下载失败；可设置 MULTIDSH_NODE_MIRROR 后重试"
    rm -rf "$INSTALL_ROOT/.node-extract"
    mkdir -p "$INSTALL_ROOT/.node-extract"
    tar -xJf "$tarfile" -C "$INSTALL_ROOT/.node-extract"
    local extracted
    extracted="$(find "$INSTALL_ROOT/.node-extract" -mindepth 1 -maxdepth 1 -type d | head -n1)"
    [[ -n "$extracted" ]] || die "Node 压缩包结构异常"
    rm -rf "$NODE_DIR"
    mv "$extracted" "$NODE_DIR"
    rm -rf "$INSTALL_ROOT/.node-extract" "$tarfile"
    NODE_BIN="$NODE_DIR/bin/node"
    [[ -x "$NODE_BIN" ]] || die "Node 安装后找不到可执行文件：$NODE_BIN"
    ok "Node 已安装：$NODE_BIN ($(node_version "$NODE_BIN"))"
  fi

  export PATH="$(dirname "$NODE_BIN"):$PATH"
  if command -v npm >/dev/null 2>&1; then
    NPM_CMD=("$(command -v npm)")
  elif [[ -x "$(dirname "$NODE_BIN")/npm" ]]; then
    NPM_CMD=("$(dirname "$NODE_BIN")/npm")
  elif [[ -f "$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js" ]]; then
    NPM_CMD=("$NODE_BIN" "$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js")
  else
    die "找不到 npm；请用 --node-bin 指向完整 Node 安装目录"
  fi
}

dsh_version() {
  "$NODE_BIN" "$1" --version 2>/dev/null | head -n1 || true
}

ensure_dsh() {
  section "2/6 检查 DSH"
  local candidate=""
  if [[ -n "$DSH_BIN_FLAG" ]]; then
    candidate="$DSH_BIN_FLAG"
  elif [[ -n "${MULTIDSH_DSH_BIN:-}" ]]; then
    candidate="$MULTIDSH_DSH_BIN"
  elif [[ -f "$DSH_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js" ]]; then
    candidate="$DSH_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
  else
    # Match the CLI's useful auto-detection for people who already ran DSH
    # before installing MultiDSH. Keep this list short and boring.
    local common
    for common in \
      "$HOME/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
      "$HOME/multidsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
      "$HOME/dsh-a/node_modules/@deepseek-ai/dsh/lib/bin.js" \
      "$HOME/dsh-b/node_modules/@deepseek-ai/dsh/lib/bin.js" \
      "$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" \
      "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" \
      "/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"; do
      if [[ -f "$common" ]]; then
        candidate="$common"
        break
      fi
    done
    if [[ -z "$candidate" ]]; then
      local variant
      for variant in "$HOME"/dsh*/node_modules/@deepseek-ai/dsh/lib/bin.js; do
        if [[ -f "$variant" ]]; then
          candidate="$variant"
          break
        fi
      done
    fi
  fi

  if [[ -n "$candidate" ]]; then
    candidate="$(absolute_path "$candidate")"
    [[ -f "$candidate" ]] || die "DSH bin.js 不存在：$candidate"
    DSH_BIN="$candidate"
    ok "使用 DSH：$DSH_BIN ($(dsh_version "$DSH_BIN"))"
    return 0
  fi

  warn "未找到 DSH CLI（@deepseek-ai/dsh）。"
  if [[ "$NO_POOL" == 1 && "$INSTALL_DSH" != 1 && "$YES" == 1 ]]; then
    warn "当前为 --no-pool 非交互模式，跳过 DSH 安装；以后入池时再运行本脚本即可。"
    SKIP_DSH=1
    return 0
  fi
  if ! confirm "是否安装 @deepseek-ai/dsh@${DEFAULT_DSH_VERSION}（下载约 855 MB，可能需要几分钟）?" "y"; then
    SKIP_DSH=1
    warn "已跳过 DSH 安装。"
    return 0
  fi

  mkdir -p "$DSH_DIR"
  info "安装 DSH 到 $DSH_DIR（registry: $DEFAULT_NPM_REGISTRY）…"
  local install_ok=0
  local registry="$DEFAULT_NPM_REGISTRY"
  local attempt
  for attempt in 1 2; do
    if "${NPM_CMD[@]}" install \
      --prefix "$DSH_DIR" \
      --no-audit --no-fund \
      --registry="$registry" \
      "@deepseek-ai/dsh@${DEFAULT_DSH_VERSION}"; then
      install_ok=1
      break
    fi
    if [[ "$attempt" == 1 && "$registry" != "https://registry.npmjs.org" ]]; then
      warn "当前 registry 安装失败，改用 https://registry.npmjs.org 重试…"
      registry="https://registry.npmjs.org"
    fi
  done
  if [[ "$install_ok" != 1 ]]; then
    die "DSH 安装失败。可检查网络/registry，或设置 MULTIDSH_DSH_DIR / MULTIDSH_NPM_REGISTRY 后重试"
  fi
  DSH_BIN="$DSH_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
  [[ -f "$DSH_BIN" ]] || die "DSH 安装完成但找不到 bin.js：$DSH_BIN"
  ok "DSH 已安装：$DSH_BIN ($(dsh_version "$DSH_BIN"))"
}

ensure_source() {
  section "3/6 检查 MultiDSH 源码"
  local script_path="${BASH_SOURCE[0]:-}"
  if [[ -n "$script_path" && -f "$script_path" ]]; then
    local script_dir
    script_dir="$(cd "$(dirname "$script_path")" && pwd)"
    if [[ -f "$script_dir/multidsh" && -f "$script_dir/bin/multidsh.mjs" ]]; then
      APP_DIR_RESOLVED="$script_dir"
      ok "使用当前 checkout：$APP_DIR_RESOLVED"
      return 0
    fi
  fi

  if [[ -f "$APP_DIR/multidsh" && -f "$APP_DIR/bin/multidsh.mjs" ]]; then
    APP_DIR_RESOLVED="$APP_DIR"
    ok "使用已安装源码：$APP_DIR_RESOLVED"
    return 0
  fi

  mkdir -p "$INSTALL_ROOT"
  local tmp="$INSTALL_ROOT/.source-install"
  rm -rf "$tmp"
  mkdir -p "$tmp"

  if [[ -n "$ARCHIVE_URL" ]]; then
    info "下载源码归档：$ARCHIVE_URL"
    run_download "$ARCHIVE_URL" "$tmp/source.tar.gz" || die "源码归档下载失败"
    tar -xzf "$tmp/source.tar.gz" -C "$tmp" || die "源码归档解压失败"
    local extracted
    extracted="$(find "$tmp" -mindepth 1 -maxdepth 2 -type d -name multidsh 2>/dev/null | head -n1)"
    if [[ -z "$extracted" ]]; then
      extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d ! -path "$tmp" | head -n1)"
    fi
    [[ -n "$extracted" ]] || die "源码归档里找不到目录"
    if [[ -f "$extracted/multidsh" && -f "$extracted/bin/multidsh.mjs" ]]; then
      APP_DIR_RESOLVED="$extracted"
    elif [[ -f "$extracted/multidsh/multidsh" && -f "$extracted/multidsh/bin/multidsh.mjs" ]]; then
      APP_DIR_RESOLVED="$extracted/multidsh"
    else
      die "源码归档里找不到 multidsh 启动器"
    fi
  elif [[ -n "$REPO_URL" ]]; then
    command -v git >/dev/null 2>&1 || die "指定 --repo-url 需要 git；也可以改用 --archive-url"
    info "克隆 MultiDSH：$REPO_URL"
    git clone --depth 1 "$REPO_URL" "$tmp/repo" || die "git clone 失败"
    APP_DIR_RESOLVED="$tmp/repo"
  else
    rm -rf "$tmp"
    die "未找到 MultiDSH 源码。请在仓库目录内运行本脚本，或使用：
  ./install.sh --repo-url https://github.com/<你的账号>/multidsh.git
  MULTIDSH_ARCHIVE_URL=https://github.com/<你的账号>/multidsh/archive/refs/heads/main.tar.gz ./install.sh"
  fi

  [[ -f "$APP_DIR_RESOLVED/multidsh" && -f "$APP_DIR_RESOLVED/bin/multidsh.mjs" ]] \
    || die "源码目录不完整：$APP_DIR_RESOLVED"
  if [[ "$APP_DIR_RESOLVED" == "$tmp/repo" || "$APP_DIR_RESOLVED" == "$tmp/"* ]]; then
    rm -rf "$APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    mv "$APP_DIR_RESOLVED" "$APP_DIR"
    APP_DIR_RESOLVED="$APP_DIR"
  fi
  rm -rf "$tmp"
  ok "源码已准备：$APP_DIR_RESOLVED"
}

prepare_cli() {
  MULTIDSH_CLI="$APP_DIR_RESOLVED/multidsh"
  chmod +x "$MULTIDSH_CLI" 2>/dev/null || true
  export PATH="$(dirname "$NODE_BIN"):$PATH"
}

install_wrapper() {
  local bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  mkdir -p "$bin_dir"
  local target="$bin_dir/multidsh"
  if [[ -e "$target" && ! -L "$target" ]]; then
    if ! grep -q 'MultiDSH installer wrapper' "$target" 2>/dev/null; then
      warn "已有 $target，不是本安装器生成的包装器，保留不动。"
      warn "你可以直接运行：$NODE_BIN $MULTIDSH_CLI"
      return 0
    fi
  fi
  cat > "$target" <<EOF
#!/usr/bin/env bash
# MultiDSH installer wrapper (generated by install.sh)
exec "$NODE_BIN" "$MULTIDSH_CLI" "\$@"
EOF
  chmod 755 "$target"
  ok "CLI 包装器：$target"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "把 $bin_dir 加入 PATH 后可直接运行 multidsh：export PATH=\"$bin_dir:\$PATH\"" ;;
  esac
}

normalize_pool_code() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]'
}

expand_home() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

directory_health() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --connect-timeout 5 --max-time 8 "$1/api/health" >/dev/null 2>&1
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"; then
      return 0
    fi
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    if netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"; then
      return 0
    fi
    return 1
  fi
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    exec 3>&-
    return 0
  fi
  return 1
}

pick_port() {
  local base="$1" port
  for ((port = base; port < base + 50; port++)); do
    if ! port_in_use "$port"; then
      printf '%s' "$port"
      return 0
    fi
  done
  die "找不到空闲端口（从 $base 开始尝试 50 个）"
}

prompt_port() {
  local label="$1" default="$2" port
  while :; do
    port="$(prompt "$label" "$default")"
    if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
      if [[ "$INTERACTIVE" == 1 ]]; then
        warn "端口必须是 1-65535 的数字。"
        default="$(pick_port "$default")"
        continue
      fi
      die "无效端口：$port"
    fi
    if port_in_use "$port"; then
      if [[ "$INTERACTIVE" == 1 ]]; then
        warn "端口 $port 已被占用，换成 $(pick_port $((port + 1)))。"
        default="$(pick_port $((port + 1)))"
        continue
      fi
      die "端口 $port 已被占用，请换一个（或去掉 --admin-port/--dsh-port 让脚本自动选择）"
    fi
    printf '%s' "$port"
    return 0
  done
}

detect_lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
  fi
  if [[ -z "$ip" ]] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
  fi
  [[ "$ip" == 127.* ]] && ip=""
  printf '%s' "$ip"
}

start_host() {
  if [[ "$NO_START" == 1 ]]; then
    info "按 --no-start 跳过启动。"
    return 0
  fi
  section "启动 host"
  info "启动 $NAME …"
  if ! "$NODE_BIN" "$MULTIDSH_CLI" start "$NAME"; then
    die "host 启动失败。查看日志：
  $NODE_BIN $MULTIDSH_CLI logs $NAME"
  fi
}

finish_skipped() {
  printf '\n'
  ok "安装完成；你没有加入设备池。"
  say ""
  say "已安装："
  say "  Node      $NODE_BIN"
  say "  MultiDSH  $APP_DIR_RESOLVED"
  if [[ "$SKIP_DSH" == 1 ]]; then
    say "  DSH       未安装"
  else
    say "  DSH       $DSH_BIN"
  fi
  say ""
  say "以后随时可以入池："
  if [[ "$SKIP_DSH" == 1 ]]; then
    say "  cd $APP_DIR_RESOLVED && ./install.sh"
    say "  （会补装 DSH、配置池码并启动）"
  else
    say "  $NODE_BIN $MULTIDSH_CLI init"
  fi
  say ""
  say "常用命令："
  say "  $NODE_BIN $MULTIDSH_CLI list"
  say "  $NODE_BIN $MULTIDSH_CLI doctor"
  say ""
}

config_join() {
  section "4/6 连接 Directory"
  DIRECTORY_URL="$(prompt "Directory 地址" "${DIRECTORY_URL:-$DEFAULT_DIRECTORY}")"
  while [[ ! "$DIRECTORY_URL" =~ ^https?:// ]]; do
    if [[ "$INTERACTIVE" != 1 ]]; then die "Directory 地址必须以 http:// 或 https:// 开头"; fi
    warn "地址需要以 http:// 或 https:// 开头。"
    DIRECTORY_URL="$(prompt "Directory 地址" "$DEFAULT_DIRECTORY")"
  done
  DIRECTORY_URL="${DIRECTORY_URL%/}"
  if directory_health "$DIRECTORY_URL"; then
    ok "Directory 可访问：$DIRECTORY_URL"
  else
    warn "Directory 健康检查失败：$DIRECTORY_URL/api/health"
    if [[ "$INTERACTIVE" == 1 ]] && ! confirm "仍然继续吗?" "n"; then
      exit 1
    fi
  fi

  section "5/6 设备池"
  if [[ -z "$POOL_CODE" && "$INTERACTIVE" == 1 ]]; then
    say "在 Windows/Android 的 MultiDSH 客户端里创建一个池，复制 8 位池码。"
    say "没有池码也可以直接回车跳过，稍后再入池。"
    POOL_CODE="$(prompt_optional "8 位池码（留空跳过）" "")"
  fi
  if [[ -z "$POOL_CODE" || "${POOL_CODE,,}" == "s" || "${POOL_CODE,,}" == "skip" ]]; then
    NO_POOL=1
    if [[ "$SKIP_DSH" == 1 ]]; then
      warn "DSH 未安装，跳过入池后不能启动 DSH。"
    fi
    finish_skipped
    exit 0
  fi
  POOL_CODE="$(normalize_pool_code "$POOL_CODE")"
  while [[ ! "$POOL_CODE" =~ ^[A-Z0-9]{8}$ ]]; do
    if [[ "$INTERACTIVE" != 1 ]]; then die "池码应为 8 位字母/数字：$POOL_CODE"; fi
    warn "池码应为 8 位字母/数字（当前 ${#POOL_CODE} 位）。"
    POOL_CODE="$(normalize_pool_code "$(prompt_optional "8 位池码" "")")"
    if [[ -z "$POOL_CODE" ]]; then
      NO_POOL=1
      finish_skipped
      exit 0
    fi
  done

  if [[ "$SKIP_DSH" == 1 ]]; then
    warn "没有可用的 DSH，暂时不能入池。"
    if [[ "$INTERACTIVE" == 1 ]] && confirm "只安装并跳过入池?" "y"; then
      finish_skipped
      exit 0
    fi
    die "请重新运行安装器并安装 DSH，或用 --dsh-bin 指定 lib/bin.js"
  fi

  local default_name
  default_name="$(hostname -s 2>/dev/null || hostname 2>/dev/null || printf 'linux')"
  default_name="${default_name}-dsh"
  NAME="$(prompt "host 名字（同机唯一）" "${NAME:-$default_name}")"
  NAME="$(printf '%s' "$NAME" | tr -cd '[:alnum:]_.-')"
  [[ -n "$NAME" ]] || die "host 名字不能为空"

  local profile_config="$MULTIDSH_HOME/instances/$NAME/host.json"
  if [[ -f "$profile_config" ]]; then
    warn "这台机器上已有同名 host：$NAME"
    if [[ "$YES" == 1 ]] || confirm "直接启动已有实例?" "y"; then
      start_host
      finish_installed "已有实例已启动"
      exit 0
    fi
    NAME="$(prompt "换一个 host 名字" "${default_name}-2")"
    NAME="$(printf '%s' "$NAME" | tr -cd '[:alnum:]_.-')"
    [[ -n "$NAME" ]] || die "host 名字不能为空"
  fi

  if [[ "$INTERACTIVE" == 1 && -z "$DSH_BIN_FLAG" ]]; then
    local dsh_input
    dsh_input="$(prompt "DSH CLI（lib/bin.js）" "$DSH_BIN")"
    dsh_input="$(expand_home "$dsh_input")"
    while [[ ! -f "$dsh_input" ]]; do
      warn "找不到文件：$dsh_input"
      dsh_input="$(expand_home "$(prompt "DSH CLI（lib/bin.js）" "$DSH_BIN")")"
    done
    DSH_BIN="$dsh_input"
  fi

  section "6/6 端口与访问地址"
  local default_admin default_dsh
  default_admin="$(pick_port "${ADMIN_PORT:-4080}")"
  default_dsh="$(pick_port "${DSH_PORT:-3080}")"
  ADMIN_PORT="$(prompt_port "sidecar/admin 端口" "$default_admin")"
  while :; do
    DSH_PORT="$(prompt_port "DSH 内部端口" "$default_dsh")"
    [[ "$DSH_PORT" != "$ADMIN_PORT" ]] && break
    warn "DSH 内部端口不能和 sidecar 端口相同。"
    default_dsh="$(pick_port $((DSH_PORT + 1)))"
  done

  local lan public_default
  lan="$(detect_lan_ip)"
  if [[ -n "$lan" ]]; then
    public_default="http://${lan}:${ADMIN_PORT}"
  else
    public_default="http://127.0.0.1:${ADMIN_PORT}"
  fi
  say "Public URL 是客户端/手机打开 DSH UI 的地址："
  say "  - 只在本机或 SSH 隧道用：http://127.0.0.1:${ADMIN_PORT}"
  say "  - 同一局域网：http://${lan:-<局域网IP>}:${ADMIN_PORT}"
  say "  - 公网/Cloudflare Tunnel：填 https://你的域名（Tunnel 指向本机 ${ADMIN_PORT}）"
  PUBLIC_URL="$(prompt "Public URL" "${PUBLIC_URL:-$public_default}")"
  while [[ ! "$PUBLIC_URL" =~ ^https?:// ]]; do
    if [[ "$INTERACTIVE" != 1 ]]; then die "Public URL 必须以 http:// 或 https:// 开头"; fi
    warn "Public URL 需要以 http:// 或 https:// 开头。"
    PUBLIC_URL="$(prompt "Public URL" "$public_default")"
  done
  PUBLIC_URL="${PUBLIC_URL%/}"

  local default_dsh_home="$MULTIDSH_HOME/instances/$NAME/dsh-home"
  DSH_HOME="$(prompt "DSH_HOME（该实例独立数据目录）" "${DSH_HOME:-$default_dsh_home}")"
  DSH_HOME="$(expand_home "$DSH_HOME")"

  # Optional: reuse the login/API key from a normal DSH CLI home.
  local reuse_creds=0
  local source_creds="$HOME/.dsh/.credentials.yaml"
  if [[ -f "$source_creds" && "$DSH_HOME" != "$HOME/.dsh" ]]; then
    if confirm "检测到 $HOME/.dsh 有 DSH 登录信息，是否复制到该实例?" "y"; then
      reuse_creds=1
    fi
  fi

  say ""
  say "${C_BOLD}即将创建：${C_RESET}"
  say "  name        $NAME"
  say "  directory   $DIRECTORY_URL"
  say "  pool code   $POOL_CODE"
  say "  dsh         $DSH_BIN"
  say "  dsh home    $DSH_HOME"
  say "  ports       admin $ADMIN_PORT / dsh $DSH_PORT"
  say "  public url  $PUBLIC_URL"
  say "  config      $profile_config"
  if [[ "$INTERACTIVE" == 1 ]] && ! confirm "确认创建并入池?" "y"; then
    say "已取消，依赖和 CLI 已安装完成。"
    exit 1
  fi

  section "创建并入池"
  local init_args=(
    init
    --yes
    --no-interactive
    --directory "$DIRECTORY_URL"
    --pool-code "$POOL_CODE"
    --name "$NAME"
    --public-url "$PUBLIC_URL"
    --admin-port "$ADMIN_PORT"
    --dsh-port "$DSH_PORT"
    --dsh-bin "$DSH_BIN"
    --node-bin "$NODE_BIN"
    --dsh-home "$DSH_HOME"
  )
  if ! "$NODE_BIN" "$MULTIDSH_CLI" "${init_args[@]}"; then
    die "入池失败。修正后可用以下命令重试：
  $NODE_BIN $MULTIDSH_CLI ${init_args[*]}"
  fi

  if [[ "$reuse_creds" == 1 ]]; then
    mkdir -p "$DSH_HOME"
    for f in .credentials.yaml .anonymous-user-id; do
      if [[ -f "$HOME/.dsh/$f" && ! -f "$DSH_HOME/$f" ]]; then
        cp -p "$HOME/.dsh/$f" "$DSH_HOME/$f"
        info "已复制 $f 到 $DSH_HOME"
      fi
    done
  fi

  start_host
  finish_installed "已加入设备池"
}

finish_installed() {
  local reason="$1"
  printf '\n'
  ok "$reason。"
  say ""
  say "实例：$NAME"
  say "  配置   $MULTIDSH_HOME/instances/$NAME/host.json"
  say "  日志   $MULTIDSH_HOME/instances/$NAME/run.log"
  say "  停止   $NODE_BIN $MULTIDSH_CLI stop $NAME"
  say "  状态   $NODE_BIN $MULTIDSH_CLI status $NAME"
  say ""
  say "如果设备还是 pending：在 Windows/Android 客户端的「待审批」里批准它。"
  say "批准后它会自动上线，客户端「打开 host」即可使用。"
  if [[ "$NO_START" == 1 ]]; then
    say ""
    say "按 --no-start 未启动，需要时运行：$NODE_BIN $MULTIDSH_CLI start $NAME"
  fi
  say ""
  say "开机自启（可选）：参考 $APP_DIR_RESOLVED/scripts/multidsh-host.service.example"
}

main() {
  parse_args "$@"
  check_platform
  printf '%s\n' "${C_BOLD}MultiDSH Linux host installer v${VERSION}${C_RESET}"
  printf '%s\n' "${C_DIM}安装到当前用户目录，不需要 root；可随时 Ctrl-C 中止。${C_RESET}"

  if [[ "$INTERACTIVE" != 1 && "$NO_POOL" != 1 && -z "$POOL_CODE" ]]; then
    die "非交互模式需要 --pool-code，或显式使用 --no-pool"
  fi

  ensure_node
  ensure_dsh
  ensure_source
  prepare_cli
  install_wrapper

  if [[ "$NO_POOL" == 1 ]]; then
    finish_skipped
    exit 0
  fi
  config_join
}

main "$@"
