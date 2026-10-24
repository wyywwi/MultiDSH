'use strict';

/**
 * MultiDSH desktop renderer (vanilla JS, no build step).
 *
 * This file only renders snapshots and calls `window.fleet` (see preload.js).
 * It performs no network access: all Directory traffic stays in the main process.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  const ui = {
    state: null,
    settingsOpen: false,
    busy: '', // current action key, e.g. 'create' or 'open:dev_123'
    notice: null, // { kind: 'error' | 'warn' | 'info', text }
    noticeTimer: null,
    host: null, // { id, name, online }
    localHost: null, // local host sidecar info (fleet:getLocalHost)
    sidebarCollapsed: false,
    joinCodeVisible: false,
  };

  const PLATFORM_LABELS = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux',
    freebsd: 'FreeBSD',
    openbsd: 'OpenBSD',
  };
  const KIND_LABELS = { host: '主机', client: '客户端' };
  const NOTICE_TIMEOUT_MS = 5000;

  // ------------------------------------------------------------------ utils

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function platformLabel(platform) {
    const key = String(platform == null ? '' : platform).toLowerCase();
    return PLATFORM_LABELS[key] || key || '未知平台';
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || '设备';
  }

  function relativeTime(ts, now) {
    const value = Number(ts);
    if (!Number.isFinite(value) || value <= 0) return '从未在线';
    const diff = Math.max(0, now - value);
    if (diff < 15 * 1000) return '刚刚';
    if (diff < 60 * 1000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  }

  function expiryText(expiresAt, now) {
    const value = Number(expiresAt);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value <= now) return '已过期';
    const diff = value - now;
    if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.ceil(diff / 60000))} 分钟后过期`;
    if (diff < 48 * 60 * 60 * 1000) return `${Math.round(diff / 3600000)} 小时后过期`;
    return `${Math.round(diff / 86400000)} 天后过期`;
  }

  function normalizeCodeInput(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
      .replace(/I/g, '1')
      .replace(/L/g, '1')
      .replace(/O/g, '0')
      .replace(/U/g, 'V')
      .slice(0, 8);
  }

  function maskedCode(code) {
    return code ? '••••••••' : '';
  }

  function setNotice(kind, text, options = {}) {
    ui.notice = { kind, text };
    if (ui.noticeTimer) {
      clearTimeout(ui.noticeTimer);
      ui.noticeTimer = null;
    }
    if (kind === 'info' && options.autoHide !== false) {
      ui.noticeTimer = setTimeout(() => {
        ui.notice = null;
        ui.noticeTimer = null;
        render();
      }, options.timeout || NOTICE_TIMEOUT_MS);
    }
    render();
  }

  // ------------------------------------------------------------------ state

  function applyState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    ui.state = snapshot;
    if (!snapshot.config.hasPool && ui.host) ui.host = null;
    if (!snapshot.config.hasPool) ui.joinCodeVisible = false;
    render();
  }

  function applyTheme(s) {
    const theme = s.config && s.config.theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = theme === 'light' ? 'light' : 'dark';
  }

  // ----------------------------------------------------------------- render

  function render() {
    const s = ui.state;
    if (!s) return;

    $('app').classList.toggle('is-collapsed', ui.sidebarCollapsed);
    applyTheme(s);
    renderHeader(s);
    renderSettings(s);
    renderBanners(s);
    renderFooter(s);
    renderUpdated(s);

    const hasPool = Boolean(s.config.hasPool);
    $('onboarding').hidden = hasPool;
    $('fleet').hidden = !hasPool;
    if (hasPool) renderFleet(s);

    renderButtons(s);
  }

  function renderHeader(s) {
    const cfg = s.config;
    const name = cfg.hasPool ? cfg.poolName || '已加入的池' : '未加入池';
    const poolName = $('pool-name');
    poolName.textContent = name;
    poolName.title = name;

    $('refresh-btn').disabled = Boolean(ui.busy);
    $('refresh-btn').classList.toggle('is-spinning', ui.busy === 'refresh' || Boolean(s.refreshing));
    $('settings-btn').classList.toggle('is-active', ui.settingsOpen);
  }

  function renderSettings(s) {
    const panel = $('settings-panel');
    panel.hidden = !ui.settingsOpen;
    if (!ui.settingsOpen) return;
    const input = $('directory-input');
    if (document.activeElement !== input) input.value = s.config.directoryUrl || '';
    $('device-name').textContent = s.config.deviceName || '—';
    $('role-text').textContent =
      s.config.role === 'owner' ? '池主' : s.config.role === 'member' ? '成员' : '—';
    $('device-id').textContent = s.config.deviceId || '—';
    $('device-name').title = s.config.deviceName || '';
    $('leave-pool-btn').hidden = !s.config.hasPool;
    $('exit-demo-btn').hidden = !s.demo;
    const theme = s.config.theme === 'dark' ? 'dark' : 'light';
    $('theme-dark-btn').classList.toggle('is-active', theme === 'dark');
    $('theme-light-btn').classList.toggle('is-active', theme === 'light');
    $('theme-dark-btn').setAttribute('aria-pressed', String(theme === 'dark'));
    $('theme-light-btn').setAttribute('aria-pressed', String(theme === 'light'));
    $('directory-save-btn').textContent = ui.busy === 'settings' ? '保存中…' : '保存地址';
    $('directory-save-btn').disabled = Boolean(ui.busy);
    renderLocalHost();
  }

  function renderLocalHost() {
    const status = $('local-host-status');
    if (!status) return;
    const info = ui.localHost;
    const startBtn = $('local-host-start');
    const stopBtn = $('local-host-stop');
    if (!info) {
      status.textContent = '检查中…';
      return;
    }
    if (info.running) {
      status.textContent = `运行中：${info.name || '本机主机'}${info.deviceId ? ` · ${info.deviceId}` : ''}`;
    } else if (info.lastError) {
      status.textContent = `启动失败：${info.lastError}`;
    } else if (!info.hostBinExists) {
      status.textContent = '当前版本缺少 host 侧车（需要重新打包），无法启动。';
    } else if (!info.dshBinExists) {
      status.textContent = '没有找到 DSH 的 bin.js，请在「高级」里填写路径。';
    } else if (!info.nodeBinExists) {
      status.textContent = '没有找到 node.exe（DSH 运行时），无法启动 host 侧车。';
    } else {
      status.textContent = `未启动 · 已检测到 DSH：${info.dshBin}`;
    }
    startBtn.hidden = Boolean(info.running);
    stopBtn.hidden = !info.running;
    startBtn.disabled = Boolean(ui.busy) || !info.hostBinExists;
    stopBtn.disabled = Boolean(ui.busy);
    const fill = (id, value) => {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = value == null ? '' : String(value);
    };
    // The join code belongs to the pool, not to the host config: after creating
    // or joining a pool it must follow the current pool (empty when there is none).
    const stateConfig = ui.state && ui.state.config;
    const poolCode = stateConfig && stateConfig.hasPool ? stateConfig.joinCode || '' : '';
    fill('local-host-code', poolCode);
    fill('local-host-name', info.name || info.defaultName || '');
    fill('local-host-public-url', info.publicUrl || info.defaultPublicUrl || '');
    fill('local-host-admin-port', info.adminPort || 4080);
    fill('local-host-dsh-port', info.dshPort || 3080);
    fill('local-host-dsh-bin', info.dshBin || '');
  }

  function renderButtons(s) {
    $('create-btn').textContent = ui.busy === 'create' ? '创建中…' : '创建池';
    $('create-btn').disabled = Boolean(ui.busy);
    $('join-btn').textContent = ui.busy === 'join' ? '加入中…' : '加入池';
    $('join-btn').disabled = Boolean(ui.busy);
    $('leave-pool-btn').disabled = Boolean(ui.busy);
    $('leave-pool-btn').textContent = ui.busy === 'leave' ? '正在离开…' : '离开当前池';
  }

  function renderBanners(s) {
    const banners = [];
    if (s.demo) {
      banners.push({
        kind: 'warn',
        text: '演示模式：以下为示例数据，没有连接任何服务。可在 设置 → 演示模式 中退出。',
      });
    }
    if (!s.demo && !s.smoke && s.health && s.health.error) {
      banners.push({ kind: 'error', text: s.health.error });
    }
    if (s.authPending) {
      banners.push({
        kind: 'warn',
        text: '本设备正在等待池主审批，审批通过后即可查看设备并打开主机。',
      });
    }
    if (s.authError) {
      banners.push({ kind: 'error', text: s.authError.message });
    }
    if (ui.notice) {
      banners.push({ kind: ui.notice.kind, text: ui.notice.text, dismissible: true });
    }

    const container = $('banners');
    if (banners.length === 0) {
      container.hidden = true;
      container.innerHTML = '';
      return;
    }
    container.hidden = false;
    container.innerHTML = banners
      .map(
        (banner) =>
          `<div class="banner banner-${banner.kind}">` +
          `<span class="banner-text">${esc(banner.text)}</span>` +
          (banner.dismissible
            ? '<button class="banner-close" type="button" data-action="dismiss-notice" aria-label="关闭提示">✕</button>'
            : '') +
          '</div>',
      )
      .join('');
  }

  function renderFooter(s) {
    const dot = $('conn-dot');
    const text = $('conn-text');
    let dotClass = 'dot-idle';
    let label = '正在连接…';
    if (s.demo) {
      label = '演示模式 · 示例数据';
      dotClass = 'dot-idle';
    } else if (s.smoke) {
      label = s.simulated ? 'Smoke 演示数据' : 'Smoke 模式 · 未连接 Directory';
      dotClass = 'dot-idle';
    } else if (s.health.ok) {
      dotClass = 'dot-online';
      label = 'Directory 已连接';
    } else if (s.health.checkedAt) {
      dotClass = 'dot-error';
      label = 'Directory 未连接';
    }
    dot.className = `dot ${dotClass}`;
    text.textContent = label;
    text.title = s.config.directoryUrl || '';
  }

  function renderUpdated(s) {
    const el = $('updated-text');
    if (!s.lastRefreshAt) {
      el.textContent = '';
      return;
    }
    const diff = Math.max(0, Date.now() - s.lastRefreshAt);
    el.textContent = diff < 5000 ? '刚刚更新' : `${Math.floor(diff / 1000)} 秒前更新`;
  }

  // ------------------------------------------------------------ fleet view

  function renderFleet(s) {
    renderPoolCard(s);
    renderHostBar(s);

    const isOwner = Boolean(s.config.isOwner);
    const pending = Array.isArray(s.pendingDevices) ? s.pendingDevices : [];
    const online = Array.isArray(s.onlineHosts) ? s.onlineHosts : [];
    const offline = Array.isArray(s.offlineHosts) ? s.offlineHosts : [];

    $('pending-section').hidden = !isOwner;
    $('pending-count').textContent = pending.length ? String(pending.length) : '';
    $('pending-list').innerHTML = pending.length
      ? renderPendingEntries(pending, s)
      : '<div class="empty-state empty-muted">没有待审批设备</div>';

    $('online-count').textContent = online.length ? String(online.length) : '';
    $('online-list').innerHTML = online.length
      ? renderHostEntries(online, s, true)
      : '<div class="empty-state">暂无在线主机<span>主机安装 sidecar 并加入池、通过审批后会自动出现在这里。</span></div>';

    $('offline-count').textContent = offline.length ? String(offline.length) : '';
    $('offline-list').innerHTML = offline.length
      ? renderHostEntries(offline, s, false)
      : '<div class="empty-state empty-muted">没有离线主机</div>';
  }

  function renderPoolCard(s) {
    const cfg = s.config;
    const poolName = cfg.poolName || '已加入的池';
    const roleChip = cfg.isOwner ? '池主' : '成员';
    let html =
      '<div class="pool-card-head">' +
      `<div><div class="pool-label">当前池</div><h2 class="pool-name">${esc(poolName)}</h2></div>` +
      `<span class="role-chip">${roleChip}</span>` +
      '</div>';

    if (cfg.isOwner && cfg.joinCode) {
      const expiry = expiryText(cfg.joinCodeExpiresAt, s.now);
      html +=
        '<div class="join-code-block">' +
        `<div class="join-code-label"><span>邀请池码</span>${
          expiry ? `<span class="join-code-exp">${esc(expiry)}</span>` : ''
        }</div>` +
        '<div class="join-code-row">' +
        `<code class="join-code" data-visible="${ui.joinCodeVisible}">${
          ui.joinCodeVisible ? esc(cfg.joinCode) : maskedCode(cfg.joinCode)
        }</code>` +
        `<button class="btn btn-ghost btn-sm" type="button" data-action="toggle-code" title="${
          ui.joinCodeVisible ? '隐藏池码' : '显示池码'
        }" aria-label="${ui.joinCodeVisible ? '隐藏池码' : '显示池码'}">${
          ui.joinCodeVisible ? '🙈' : '👁'
        }</button>` +
        `<button class="btn btn-ghost btn-sm" type="button" data-action="copy-code" data-code="${esc(cfg.joinCode)}">复制</button>` +
        '</div></div>';
    } else if (cfg.role === 'member') {
      const approved = s.self && s.self.status === 'active';
      html += `<div class="pool-meta">以客户端身份加入${approved ? ' · 已通过审批' : ' · 等待池主审批'}</div>`;
    }

    $('pool-card').innerHTML = html;
  }

  function renderHostBar(s) {
    const bar = $('host-bar');
    if (!ui.host) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    bar.hidden = false;
    const online = ui.host.online !== false;
    bar.innerHTML =
      '<div class="host-bar-inner">' +
      `<span class="dot dot-${online ? 'online' : 'offline'}"></span>` +
      '<div class="host-bar-text"><span class="host-bar-label">主机视图</span>' +
      `<span class="host-bar-name">${esc(ui.host.name)}</span></div>` +
      `<button class="btn btn-ghost btn-sm" type="button" data-action="close-host"${
        ui.busy === 'close' ? ' disabled' : ''
      }>关闭</button>` +
      '</div>' +
      (online
        ? ''
        : '<div class="host-bar-warn">该主机当前判定为离线，界面可能无法加载。</div>');
  }

  function pendingCard(device, s) {
    const disabled = ui.busy ? ' disabled' : '';
    const approving = ui.busy === `approve:${device.id}`;
    return (
      '<div class="device-card">' +
      '<span class="dot dot-pending"></span>' +
      '<div class="device-main">' +
      `<div class="device-name">${esc(device.name || device.id)}</div>` +
      `<div class="device-meta">${kindLabel(device.kind)} · ${esc(
        platformLabel(device.platform),
      )} · ${esc(relativeTime(device.lastSeenAt, s.now))}</div>` +
      '</div>' +
      '<div class="device-actions">' +
      `<button class="btn btn-primary btn-xs" type="button" data-action="approve" data-id="${esc(
        device.id,
      )}"${disabled}>${approving ? '批准中…' : '批准'}</button>` +
      `<button class="btn btn-danger-ghost btn-xs" type="button" data-action="revoke" data-id="${esc(
        device.id,
      )}"${disabled}>拒绝</button>` +
      '</div></div>'
    );
  }

  function hostCard(device, s, online) {
    const opening = ui.busy === `open:${device.id}`;
    const disabled = ui.busy ? ' disabled' : '';
    const active =
      (s && s.activeHostId === device.id) || Boolean(ui.host && ui.host.id === device.id);
    const platform = platformLabel(device.platform);
    const dshRunning =
      device.health && typeof device.health.dshRunning === 'boolean'
        ? device.health.dshRunning
        : null;
    const healthLabel = dshRunning === true ? 'DSH 运行中' : dshRunning === false ? 'DSH 未运行' : '';
    const meta = online
      ? `${platform}${healthLabel ? ` · ${healthLabel}` : ''}`
      : `${platform} · ${relativeTime(device.lastSeenAt, s.now)}`;
    const title = device.publicUrl ? ` title="${esc(device.publicUrl)}"` : '';
    return (
      `<div class="device-card${online ? '' : ' is-offline'}${active ? ' is-active-host' : ''}"${active ? ' aria-current="true"' : ''}>` +
      `<span class="dot dot-${online ? 'online' : 'offline'}"></span>` +
      '<div class="device-main">' +
      `<div class="device-name">${esc(device.name || device.id)}${active ? '<span class="device-active-badge">当前</span>' : ''}</div>` +
      `<div class="device-meta"${title}>${esc(meta)}</div>` +
      '</div>' +
      '<div class="device-actions">' +
      `<button class="btn ${active ? 'btn-primary' : online ? 'btn-secondary' : 'btn-ghost'} btn-xs" type="button" data-action="open-host" data-id="${esc(
        device.id,
      )}"${disabled}>${opening ? '打开中…' : active ? '已打开' : '打开'}</button>` +
      '</div></div>'
    );
  }

  // A machine groups one or more host profiles (e.g. vanilla DSH + a plugin
  // build). Hosts without machineId (older sidecars) stay as plain cards.
  function buildMachineGroups(hosts) {
    const groups = new Map();
    for (const device of hosts) {
      const machineId = typeof device.machineId === 'string' ? device.machineId.trim() : '';
      const key = machineId ? `machine:${machineId}` : `device:${device.id}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, machineId, machineName: '', hosts: [] };
        groups.set(key, group);
      }
      group.hosts.push(device);
      const machineName = typeof device.machineName === 'string' ? device.machineName.trim() : '';
      if (!group.machineName && machineName) group.machineName = machineName;
    }
    return Array.from(groups.values());
  }

  function platformSummary(hosts) {
    const labels = [];
    for (const device of hosts) {
      const label = platformLabel(device.platform);
      if (!labels.includes(label)) labels.push(label);
    }
    return labels.join(' / ');
  }

  function machineGroupCard(group, s, status) {
    const hosts = group.hosts;
    const latest = hosts.reduce((max, device) => Math.max(max, Number(device.lastSeenAt) || 0), 0);
    const name = group.machineName || hosts[0].name || hosts[0].id;
    const meta =
      status === 'pending'
        ? `${platformSummary(hosts)} · ${hosts.length} 个待审批`
        : status === 'online'
          ? `${platformSummary(hosts)} · ${hosts.length} 个 DSH`
          : `${platformSummary(hosts)} · ${hosts.length} 个 DSH · 最后在线 ${relativeTime(latest, s.now)}`;
    const dots = { online: 'dot-online', offline: 'dot-offline', pending: 'dot-pending' };
    const cardFor = status === 'pending' ? pendingCard : hostCard;
    const cardOptions = status === 'pending' ? [s] : [s, status === 'online'];
    const hasActive = hosts.some(
      (device) => (s && s.activeHostId === device.id) || Boolean(ui.host && ui.host.id === device.id),
    );
    return (
      `<div class="machine-group${status === 'offline' ? ' is-offline' : ''}${hasActive ? ' has-active-host' : ''}" data-machine-id="${esc(group.machineId)}">` +
      '<div class="machine-head">' +
      `<span class="dot ${dots[status] || 'dot-idle'}"></span>` +
      '<div class="machine-main">' +
      `<div class="machine-name" title="${esc(group.machineId)}">${esc(name)}${hasActive ? '<span class="device-active-badge">当前</span>' : ''}</div>` +
      `<div class="machine-meta">${esc(meta)}</div>` +
      '</div>' +
      `<span class="count machine-count">${hosts.length}</span>` +
      '</div>' +
      `<div class="machine-hosts">${hosts.map((device) => cardFor(device, ...cardOptions)).join('')}</div>` +
      '</div>'
    );
  }

  function renderHostEntries(hosts, s, online) {
    const status = online ? 'online' : 'offline';
    return buildMachineGroups(hosts)
      .map((group) => {
        if (!group.machineId) {
          return group.hosts.map((device) => hostCard(device, s, online)).join('');
        }
        return machineGroupCard(group, s, status);
      })
      .join('');
  }

  function renderPendingEntries(pending, s) {
    const hosts = pending.filter((device) => device.kind === 'host');
    const others = pending.filter((device) => device.kind !== 'host');
    const grouped = buildMachineGroups(hosts)
      .map((group) => {
        if (!group.machineId) {
          return group.hosts.map((device) => pendingCard(device, s)).join('');
        }
        return machineGroupCard(group, s, 'pending');
      })
      .join('');
    return grouped + others.map((device) => pendingCard(device, s)).join('');
  }

  // --------------------------------------------------------------- actions

  async function act(key, fn) {
    if (ui.busy) return null;
    ui.busy = key;
    render();
    try {
      const res = await fn();
      if (!res || res.ok !== true) {
        setNotice('error', (res && res.error && res.error.message) || '操作失败，请稍后重试');
        return null;
      }
      const data = res.data;
      if (data && data.config && typeof data.config === 'object') applyState(data);
      return data;
    } catch (err) {
      setNotice('error', (err && err.message) || '操作失败，请稍后重试');
      return null;
    } finally {
      ui.busy = '';
      render();
    }
  }

  async function doRefresh() {
    await act('refresh', () => window.fleet.refresh());
  }

  async function onCreate(event) {
    event.preventDefault();
    const input = $('pool-name-input');
    const name = input.value.trim();
    if (!name) {
      setNotice('error', '请输入池名称');
      input.focus();
      return;
    }
    const data = await act('create', () => window.fleet.createPool(name, $('create-key-input').value.trim()));
    if (data) {
      input.value = '';
      $('create-key-input').value = '';
      ui.host = null;
      setNotice('info', `池「${data.config.poolName || name}」已创建，把池码发给主机即可加入。`);
    }
  }

  async function onJoin(event) {
    event.preventDefault();
    const input = $('join-code-input');
    const code = normalizeCodeInput(input.value);
    input.value = code;
    if (code.length !== 8) {
      setNotice('error', '池码应为 8 位字符');
      input.focus();
      return;
    }
    const data = await act('join', () => window.fleet.joinPool(code));
    if (data) {
      input.value = '';
      ui.host = null;
      setNotice(
        'info',
        data.authPending ? '已提交加入申请，等待池主审批…' : '已加入池。',
      );
    }
  }

  async function onSaveDirectory(event) {
    event.preventDefault();
    const input = $('directory-input');
    const url = input.value.trim();
    if (!url) {
      setNotice('error', '请输入 Directory 地址');
      input.focus();
      return;
    }
    const hadPool = Boolean(ui.state && ui.state.config.hasPool);
    const data = await act('settings', () => window.fleet.setDirectory(url));
    if (data) {
      if (hadPool && !data.config.hasPool) {
        setNotice('info', 'Directory 地址已更新，当前池已断开，请重新创建或加入池。');
      } else {
        setNotice('info', 'Directory 地址已保存');
      }
    }
  }

  async function onLeavePool() {
    if (!ui.state || !ui.state.config.hasPool) return;
    const data = await act('leave', () => window.fleet.leavePool());
    if (data) {
      ui.host = null;
      setNotice('info', '已离开当前池');
    }
  }

  async function onExitDemo() {
    const data = await act('exit-demo', () => window.fleet.exitDemo());
    if (data) {
      ui.host = null;
      setNotice('info', '已退出演示，现在可以创建或加入真实的池。');
    }
  }

  async function onTheme(theme) {
    const data = await act('theme', () => window.fleet.setTheme(theme));
    if (data) {
      ui.state = data;
      render();
    }
  }

  async function loadLocalHost() {
    if (!window.fleet) return;
    try {
      const res = await window.fleet.getLocalHost();
      if (res && res.ok) ui.localHost = res.data;
    } catch {
      /* keep previous info */
    }
    if (ui.settingsOpen) renderLocalHost();
  }

  async function onStartLocalHost(event) {
    event.preventDefault();
    if (!window.fleet) return;
    const payload = {
      poolCode: $('local-host-code').value.trim().toUpperCase(),
      name: $('local-host-name').value.trim(),
      publicUrl: $('local-host-public-url').value.trim(),
      adminPort: Number($('local-host-admin-port').value) || 4080,
      dshPort: Number($('local-host-dsh-port').value) || 3080,
      dshBin: $('local-host-dsh-bin').value.trim(),
    };
    const data = await act('local-host', () => window.fleet.startLocalHost(payload));
    if (data) {
      setNotice('info', '本机主机已启动：等池主在「待审批」里批准后即可在线。');
      await loadLocalHost();
      await doRefresh();
    }
  }

  async function onStopLocalHost() {
    if (!window.fleet) return;
    const data = await act('local-host-stop', () => window.fleet.stopLocalHost());
    if (data) {
      setNotice('info', '已停止本机主机（侧车进程已退出）');
      await loadLocalHost();
      await doRefresh();
    }
  }

  function setSidebarCollapsed(collapsed) {
    ui.sidebarCollapsed = Boolean(collapsed);
    render();
    if (window.fleet && typeof window.fleet.setSidebarCollapsed === 'function') {
      window.fleet.setSidebarCollapsed(ui.sidebarCollapsed).catch(() => {});
    }
  }

  async function moderate(action, deviceId) {
    if (!deviceId) return;
    const label = action === 'approve' ? '批准' : '拒绝';
    const data = await act(`${action}:${deviceId}`, () =>
      action === 'approve'
        ? window.fleet.approve(deviceId)
        : window.fleet.revoke(deviceId),
    );
    if (data) setNotice('info', `已${label}该设备`);
  }

  async function openHost(hostId) {
    if (!hostId) return;
    const data = await act(`open:${hostId}`, () => window.fleet.openHost(hostId));
    if (data) {
      ui.host = { id: data.hostId, name: data.name, online: data.online !== false };
      if (data.online === false) {
        setNotice('warn', '该主机当前被判定为离线，仍已尝试打开。');
      }
      render();
    }
  }

  async function closeHost() {
    const data = await act('close', () => window.fleet.closeHost());
    if (data) {
      ui.host = null;
      render();
    }
  }

  async function copyText(text) {
    try {
      const res = await window.fleet.copyText(text);
      if (res && res.ok) setNotice('info', '池码已复制到剪贴板');
      else setNotice('error', (res && res.error && res.error.message) || '复制失败');
    } catch (err) {
      setNotice('error', '复制失败');
    }
  }

  // ---------------------------------------------------------------- events

  function bind() {
    $('refresh-btn').addEventListener('click', doRefresh);

    $('settings-btn').addEventListener('click', async () => {
      const result = await window.fleet.openSettings();
      if (result && !result.ok) {
        setNotice('error', result.error && result.error.message ? result.error.message : '无法打开设置窗口');
      }
    });

    $('settings-close-btn').addEventListener('click', () => {
      ui.settingsOpen = false;
      render();
    });

    $('create-form').addEventListener('submit', onCreate);
    $('join-form').addEventListener('submit', onJoin);
    $('directory-form').addEventListener('submit', onSaveDirectory);
    $('leave-pool-btn').addEventListener('click', onLeavePool);
    $('exit-demo-btn').addEventListener('click', onExitDemo);
    $('theme-dark-btn').addEventListener('click', () => onTheme('dark'));
    $('theme-light-btn').addEventListener('click', () => onTheme('light'));
    $('local-host-form').addEventListener('submit', onStartLocalHost);
    $('local-host-stop').addEventListener('click', onStopLocalHost);
    $('sidebar-collapse-btn').addEventListener('click', () => setSidebarCollapsed(true));
    $('sidebar-expand-btn').addEventListener('click', () => setSidebarCollapsed(false));

    $('join-code-input').addEventListener('input', (event) => {
      const input = event.target;
      const next = normalizeCodeInput(input.value);
      if (input.value !== next) input.value = next;
    });

    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'dismiss-notice') {
        ui.notice = null;
        render();
      } else if (action === 'copy-code') {
        copyText(button.dataset.code || '');
      } else if (action === 'toggle-code') {
        ui.joinCodeVisible = !ui.joinCodeVisible;
        render();
      } else if (action === 'open-host') {
        openHost(button.dataset.id);
      } else if (action === 'close-host') {
        closeHost();
      } else if (action === 'approve') {
        moderate('approve', button.dataset.id);
      } else if (action === 'revoke') {
        moderate('revoke', button.dataset.id);
      }
    });
  }

  function subscribe() {
    const fleet = window.fleet;
    if (!fleet || typeof fleet.onState !== 'function') {
      setNotice('error', '预加载脚本不可用（window.fleet 缺失），请重启应用。');
      return;
    }
    fleet.onState((snapshot) => {
      if (!snapshot || typeof snapshot !== 'object') return;
      ui.state = snapshot;
      if (!snapshot.config.hasPool) ui.host = null;
      render();
    });
    fleet.onHostOpened((info) => {
      if (!info) return;
      ui.host = {
        id: info.hostId || info.id,
        name: info.name || info.hostId || '主机',
        online: info.online !== false,
      };
      render();
    });
    fleet.onHostClosed(() => {
      ui.host = null;
      render();
    });
    fleet.onHostError((info) => {
      // The main process closes a failed host view: go back to the placeholder.
      ui.host = null;
      render();
      setNotice('error', (info && info.message) || '主机界面加载失败');
    });
  }

  // ------------------------------------------------------------------ init

  async function init() {
    bind();
    subscribe();

    if (!window.fleet) return;

    try {
      const res = await window.fleet.getState();
      if (res && res.ok) applyState(res.data);
      else setNotice('error', (res && res.error && res.error.message) || '无法读取初始状态');
    } catch (err) {
      setNotice('error', `无法读取初始状态：${(err && err.message) || '未知错误'}`);
    }

    loadLocalHost();

    setInterval(() => {
      if (ui.state) renderUpdated(ui.state);
    }, 1000);

    try {
      window.fleet.notifyReady();
    } catch {
      /* main process is going away */
    }
  }

  init();
})();
