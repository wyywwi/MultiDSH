'use strict';

/**
 * MultiDSH Directory HTTP client.
 *
 * This module runs inside the Electron main process (it also works in plain
 * Node), so all cross-origin Directory traffic stays out of the renderer.
 * Shapes and endpoints follow multidsh/packages/protocol/PROTOCOL.md v1.
 */

const PROTOCOL_VERSION = 1;
// Default for the packaged/desktop client: the deployed Cloudflare Directory.
// Local E2E / tests always pass an explicit URL (or point Settings at a local
// Node directory on 127.0.0.1:8787), so this only affects a fresh install.
const DEFAULT_DIRECTORY_URL = 'https://multidsh.example.com';
/** A host is considered online when it heartbeated within this window. */
const ONLINE_WINDOW_MS = 90 * 1000;
const USER_AGENT = 'MultiDSH-Desktop/0.1.0';

const ERROR_MESSAGES = {
  invalid_url: 'Directory 地址无效，请检查后重试',
  network: '无法连接 Directory，请检查地址与网络',
  timeout: '连接 Directory 超时，请检查网络后重试',
  pool_code_invalid: '池码无效，请检查后重试',
  pool_code_expired: '池码已过期，请向池主索取新码',
  pool_not_found: '该池不存在或已被删除',
  device_revoked: '本设备已被移出该池',
  host_not_found: '主机不存在或已离开该池',
  host_not_active: '主机尚未通过审批或已被停用',
  unauthorized: '认证失败，请重新创建或加入池',
  forbidden: '没有权限执行该操作',
  validation: '输入内容不合法',
  no_pool: '尚未加入任何池',
  not_a_host: '该设备不是主机',
};

class DirectoryError extends Error {
  /**
   * @param {string} code machine readable code understood by the renderer
   * @param {string} message human readable (usually Chinese) message
   * @param {number} [status] HTTP status when applicable
   */
  constructor(code, message, status = 0) {
    super(message || ERROR_MESSAGES[code] || 'Directory 请求失败');
    this.name = 'DirectoryError';
    this.code = code || 'unknown';
    this.status = Number.isFinite(status) ? status : 0;
  }
}

/** Strip trailing slashes, reject non-http(s) base URLs. */
function normalizeBaseUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) throw new DirectoryError('invalid_url', 'Directory 地址不能为空');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DirectoryError('invalid_url', `Directory 地址无效：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DirectoryError('invalid_url', 'Directory 地址必须以 http:// 或 https:// 开头');
  }
  url.hash = '';
  url.search = '';
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Crockford base32 pool code, forgiving about user typos (I/L/O/U). */
function normalizeJoinCode(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

/** True when the device is active and heartbeated within 90 seconds. */
function isOnline(device, now = Date.now()) {
  if (!device || device.status !== 'active') return false;
  const seen = Number(device.lastSeenAt);
  return Number.isFinite(seen) && seen > 0 && now - seen <= ONLINE_WINDOW_MS;
}

/** Map any thrown value to the `{code, message, status}` shape the UI renders. */
function errorForRenderer(err) {
  const isDirectoryError = err instanceof DirectoryError;
  const code = isDirectoryError ? err.code : 'unexpected';
  const status = isDirectoryError ? err.status : 0;
  const message =
    ERROR_MESSAGES[code] ||
    (err && typeof err.message === 'string' && err.message) ||
    '发生未知错误，请重试';
  return { code, message, status };
}

class DirectoryClient {
  constructor(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  /**
   * @param {string} pathname absolute path such as `/api/health`
   * @param {{method?: string, token?: string, body?: any, timeoutMs?: number}} [options]
   */
  async request(pathname, options = {}) {
    const { method = 'GET', token, body, timeoutMs = 8000, headers: extraHeaders } = options;
    const suffix = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const url = `${this.baseUrl}${suffix}`;
    const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (extraHeaders && typeof extraHeaders === 'object') Object.assign(headers, extraHeaders);
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new DirectoryError('timeout', undefined);
      const cause = err && err.cause ? `（${err.cause.code || err.cause.message || err.cause}）` : '';
      throw new DirectoryError('network', `${ERROR_MESSAGES.network}${cause}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const code = (parsed && parsed.error && parsed.error.code) || (parsed && parsed.code) || `http_${response.status}`;
      const message =
        (parsed && parsed.error && parsed.error.message) ||
        (parsed && parsed.message) ||
        `Directory 请求失败（HTTP ${response.status}）`;
      throw new DirectoryError(code, message, response.status);
    }
    return parsed;
  }

  health() {
    return this.request('/api/health', { timeoutMs: 5000 });
  }

  /** Create a pool; the calling device becomes its active owner. */
  createPool({ name, deviceName, platform, createKey }) {
    return this.request('/api/pools', {
      method: 'POST',
      body: { name, deviceName, platform },
      headers: createKey ? { 'x-multidsh-create-key': createKey } : undefined,
      timeoutMs: 10000,
    });
  }

  /** Join a pool with an 8 character code. New devices start as pending. */
  joinPool({ code, name, platform, kind = 'client', version }) {
    return this.request('/api/pools/join', {
      method: 'POST',
      body: { code, kind, name, platform, version },
      timeoutMs: 10000,
    });
  }

  listDevices(poolId, token, { includePending = false } = {}) {
    const query = includePending ? '?includePending=1' : '';
    return this.request(`/api/pools/${encodeURIComponent(poolId)}/devices${query}`, {
      token,
      timeoutMs: 8000,
    });
  }

  approveDevice(poolId, token, deviceId) {
    return this.request(
      `/api/pools/${encodeURIComponent(poolId)}/devices/${encodeURIComponent(deviceId)}/approve`,
      { method: 'POST', token, timeoutMs: 8000 },
    );
  }

  revokeDevice(poolId, token, deviceId) {
    return this.request(
      `/api/pools/${encodeURIComponent(poolId)}/devices/${encodeURIComponent(deviceId)}/revoke`,
      { method: 'POST', token, timeoutMs: 8000 },
    );
  }

  rotateJoinCode(poolId, token) {
    return this.request(`/api/pools/${encodeURIComponent(poolId)}/join-code/rotate`, {
      method: 'POST',
      token,
      timeoutMs: 8000,
    });
  }

  /** Ask the Directory for a one-time signed pair URL for an active host. */
  async pair(poolId, token, hostId) {
    const result = await this.request(`/api/pools/${encodeURIComponent(poolId)}/pair`, {
      method: 'POST',
      token,
      body: { hostId },
      timeoutMs: 10000,
    });
    if (!result || typeof result.url !== 'string' || !result.url) {
      throw new DirectoryError('bad_response', 'Directory 未返回有效的配对地址');
    }
    return result;
  }
}

module.exports = {
  PROTOCOL_VERSION,
  DEFAULT_DIRECTORY_URL,
  ONLINE_WINDOW_MS,
  DirectoryClient,
  DirectoryError,
  ERROR_MESSAGES,
  errorForRenderer,
  isOnline,
  normalizeBaseUrl,
  normalizeJoinCode,
};
