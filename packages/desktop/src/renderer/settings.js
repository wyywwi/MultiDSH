'use strict';

/**
 * Independent settings window renderer. It talks only through the same
 * `window.fleet` preload bridge as the main window and renders the persisted
 * host instances returned by the main process.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const fleet = window.fleet;

  let snapshot = null;
  let manager = null;
  let busy = '';
  let toastTimer = null;
  let editingHostId = null;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(kind, text, timeout = 5000) {
    const el = $('settings-toast');
    if (!el) return;
    el.textContent = text;
    el.className = `settings-toast is-${kind}`;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
      toastTimer = null;
    }, timeout);
  }

  function showManagerNotice(kind, text) {
    const el = $('host-manager-notice');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.className = `settings-notice is-${kind}`;
    el.textContent = text;
  }

  function applyTheme() {
    const theme = snapshot && snapshot.config && snapshot.config.theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = theme === 'light' ? 'light' : 'dark';
    $('theme-light-btn').classList.toggle('is-active', theme === 'light');
    $('theme-dark-btn').classList.toggle('is-active', theme === 'dark');
    $('theme-light-btn').setAttribute('aria-pressed', String(theme === 'light'));
    $('theme-dark-btn').setAttribute('aria-pressed', String(theme === 'dark'));
  }

  function renderDemoMode() {
    const button = $('demo-mode-btn');
    if (!button) return;
    const demo = Boolean(snapshot && snapshot.demo);
    button.textContent = demo ? '退出演示模式' : '进入演示模式';
    button.dataset.demo = demo ? '1' : '0';
  }

  function applySnapshot(next) {
    if (!next || typeof next !== 'object') return;
    snapshot = next;
    applyTheme();
    renderDemoMode();
    renderConnection();
    renderDevice();
    renderHosts();
  }

  async function loadState() {
    const res = await fleet.getState();
    if (res && res.ok) applySnapshot(res.data);
  }

  async function loadManager(options = {}) {
    if (options.clear !== false) showManagerNotice(null, '');
    const res = await fleet.getHostInstances();
    if (!res || !res.ok) {
      if (options.notify !== false) {
        showToast('error', (res && res.error && res.error.message) || '读取 DSH 实例失败');
      }
      return false;
    }
    manager = res.data;
    renderHosts();
    renderConnection();
    populateCredentialSources();
    return true;
  }

  function populateCredentialSources() {
    const select = $('host-credentials-source');
    if (!select) return;
    const current = select.value;
    const hosts = (manager && manager.instances) || [];
    const options = ['<option value="">不复制（稍后在 DSH 里登录）</option>'];
    for (const host of hosts) {
      if (!host.hasDshCredentials) continue;
      options.push(`<option value="${esc(host.id)}">${esc(host.name)}（已保存 DSH 登录/API key）</option>`);
    }
    select.innerHTML = options.join('');
    if (hosts.some((host) => host.id === current && host.hasDshCredentials)) select.value = current;
  }

  function labelForStatus(host) {
    if (host.running) return { text: '运行中', cls: 'is-running' };
    if (!host.joined) return { text: host.status === 'left' ? '未加入池' : '待加入池', cls: 'is-left' };
    if (host.status === 'pending') return { text: '待池主审批', cls: 'is-pending' };
    if (host.status === 'revoked') return { text: '已被移出池', cls: 'is-left' };
    return { text: '已停止', cls: 'is-stopped' };
  }

  function renderHosts() {
    const root = $('host-instances');
    if (!root) return;
    if (!manager) {
      root.innerHTML = '<p class="hint">加载实例中…</p>';
      return;
    }
    const hosts = manager.instances || [];
    if (!hosts.length) {
      root.innerHTML =
        '<div class="host-empty">还没有 DSH 主机实例。点右上角「+ 新建实例」创建一个；每个实例都可以独立启停、加入/脱离池和删除。</div>';
      return;
    }
    root.innerHTML = hosts
      .map((host) => {
        const state = labelForStatus(host);
        const canJoin = !host.joined;
        const joinDisabled = !manager.defaults || !manager.defaults.hasPool;
        const actions = [];
        if (host.running) {
          actions.push(
            `<button class="btn btn-danger-ghost btn-sm" data-host-action="stop" data-host-id="${esc(host.id)}">停止</button>`,
          );
        } else {
          actions.push(
            `<button class="btn btn-primary btn-sm" data-host-action="start" data-host-id="${esc(host.id)}" ${!host.joined || busy ? 'disabled' : ''}>启动</button>`,
          );
        }
        if (canJoin) {
          actions.push(
            `<button class="btn btn-secondary btn-sm" data-host-action="join" data-host-id="${esc(host.id)}" ${joinDisabled || busy ? 'disabled' : ''}>加入当前池</button>`,
          );
        } else {
          actions.push(
            `<button class="btn btn-secondary btn-sm" data-host-action="leave" data-host-id="${esc(host.id)}" ${busy ? 'disabled' : ''}>脱离池</button>`,
          );
        }
        if (host.status === 'pending' && manager.defaults && manager.defaults.isOwner) {
          actions.push(
            `<button class="btn btn-secondary btn-sm" data-host-action="approve" data-host-id="${esc(host.id)}" ${busy ? 'disabled' : ''}>批准入池</button>`,
          );
        }
        actions.push(
          `<button class="btn btn-secondary btn-sm" data-host-action="edit" data-host-id="${esc(host.id)}" ${busy ? 'disabled' : ''}>编辑</button>`,
        );
        actions.push(
          `<button class="btn btn-danger-ghost btn-sm" data-host-action="delete" data-host-id="${esc(host.id)}" ${busy ? 'disabled' : ''}>删除实例</button>`,
        );

        const meta = [];
        const active = Boolean(snapshot && snapshot.activeHostId && snapshot.activeHostId === host.id);
        if (host.deviceId) meta.push(`设备 <code>${esc(host.deviceId)}</code>`);
        if (host.adminPort) meta.push(`admin <code>${esc(host.adminPort)}</code>`);
        if (host.dshPort) meta.push(`dsh <code>${esc(host.dshPort)}</code>`);
        if (host.publicUrl) meta.push(`URL <code>${esc(host.publicUrl)}</code>`);
        if (host.autoStart) meta.push('下次启动自动恢复');
        const credentialsLabel = host.hasDshCredentials
          ? host.hasDshApiKey
            ? 'DSH 登录/API key：已保存'
            : 'DSH 登录：已保存'
          : 'DSH 登录/API key：未检测到（首次打开 DSH 后可登录）';
        meta.push(`<span class="host-credentials ${host.hasDshCredentials ? 'is-saved' : ''}">${credentialsLabel}</span>`);
        const logText = (host.logs || []).join('\n');
        return `
          <article class="host-card ${host.running ? 'is-running' : ''}${active ? ' is-active-host' : ''}">
            <div class="host-card-head">
              <div class="host-card-title">
                <strong>${esc(host.name || host.id)}${active ? '<span class="device-active-badge">当前</span>' : ''}</strong>
                <span class="host-badge ${state.cls}">${state.text}</span>
              </div>
              <code class="host-id">${esc(host.id)}</code>
            </div>
            <div class="host-meta">
              ${meta.length ? meta.join(' · ') : '尚未加入池'}
              ${host.dshHome ? `<span>DSH_HOME <code>${esc(host.dshHome)}</code></span>` : ''}
            </div>
            ${host.lastError ? `<p class="host-error">${esc(host.lastError)}</p>` : ''}
            <div class="host-actions">${actions.join('')}</div>
            ${
              host.configPath
                ? `<details class="host-details"><summary>查看配置路径和最近日志</summary><pre>config: ${esc(host.configPath)}\n${esc(logText || '(暂无日志)')}</pre></details>`
                : ''
            }
          </article>
        `;
      })
      .join('');
  }

  function renderConnection() {
    if (!snapshot) return;
    const directoryInput = $('directory-input');
    if (document.activeElement !== directoryInput) {
      directoryInput.value = (snapshot.config && snapshot.config.directoryUrl) || '';
    }
    const demo = Boolean(snapshot.demo);
    directoryInput.disabled = demo;
    $('directory-save-btn').disabled = Boolean(busy) || demo;
    const cacheInput = $('view-cache-size');
    if (cacheInput && document.activeElement !== cacheInput) {
      const cached = Number(snapshot.config && snapshot.config.hostViewCacheSize);
      cacheInput.value = String(Number.isInteger(cached) ? cached : 3);
    }
    $('view-cache-save').disabled = Boolean(busy) || demo;
    const defaults = manager && manager.defaults;
    if (defaults) {
      const nameInput = $('host-name');
      if (nameInput && (!nameInput.value || nameInput.dataset.autofilled === '1')) {
        nameInput.value = defaults.defaultName || '';
        nameInput.dataset.autofilled = '1';
      }
      const codeInput = $('host-pool-code');
      if (codeInput && (!codeInput.value || codeInput.dataset.autofilled === '1')) {
        codeInput.value = defaults.poolCode || '';
        codeInput.dataset.autofilled = '1';
      }
      const dshInput = $('host-dsh-bin');
      if (dshInput && (!dshInput.value || dshInput.dataset.autofilled === '1')) {
        dshInput.value = defaults.dshBin || '';
        dshInput.dataset.autofilled = '1';
      }
      const nodeInput = $('host-node-bin');
      if (nodeInput && (!nodeInput.value || nodeInput.dataset.autofilled === '1')) {
        nodeInput.value = defaults.nodeBin || '';
        nodeInput.dataset.autofilled = '1';
      }
      $('create-host-submit').disabled = Boolean(busy) || !defaults.hasPool;
    }
  }

  function renderDevice() {
    const root = $('device-summary');
    if (!root || !snapshot) return;
    const cfg = snapshot.config || {};
    const role = cfg.role === 'owner' ? '池主' : cfg.role === 'member' ? '成员' : '未入池';
    const items = [
      ['本机名称', cfg.deviceName || '—'],
      ['当前池', cfg.poolName || (cfg.hasPool ? cfg.poolId || '已加入' : '未加入池')],
      ['角色', role],
      ['设备 ID', cfg.deviceId || '—'],
      ['池码', cfg.joinCode ? '••••••••' : '—'],
    ];
    root.innerHTML = items
      .map(
        ([label, value]) =>
          `<div class="device-summary-item"><span>${esc(label)}</span><code title="${esc(value)}">${esc(value)}</code></div>`,
      )
      .join('');
  }

  async function act(key, fn) {
    if (busy) return;
    busy = key;
    renderHosts();
    renderConnection();
    try {
      const result = await fn();
      if (!result || !result.ok) {
        throw new Error((result && result.error && result.error.message) || '操作失败');
      }
      return result.data;
    } catch (err) {
      showToast('error', err && err.message ? err.message : String(err));
      return null;
    } finally {
      busy = '';
      renderHosts();
      renderConnection();
    }
  }

  async function onDirectorySubmit(event) {
    event.preventDefault();
    const url = $('directory-input').value.trim();
    if (!url) {
      showToast('error', '请填写 Directory 地址');
      return;
    }
    const data = await act('directory', () => fleet.setDirectory(url));
    if (data) {
      applySnapshot(data);
      await loadManager();
      showToast('info', 'Directory 地址已保存');
    }
  }

  async function onTheme(theme) {
    const data = await act(`theme:${theme}`, () => fleet.setTheme(theme));
    if (data) applySnapshot(data);
  }

  async function onDemoToggle() {
    const shouldExit = Boolean(snapshot && snapshot.demo);
    const data = await act('demo', () => (shouldExit ? fleet.exitDemo() : fleet.enterDemo()));
    if (data) {
      applySnapshot(data);
      showToast('info', shouldExit ? '已退出演示模式' : '已进入演示模式，可在主窗口查看示例数据');
    }
  }

  function setEditingMode(id) {
    editingHostId = id;
    const editing = Boolean(id);
    $('host-form-title').textContent = editing ? '编辑实例' : '新建实例';
    $('create-host-submit').textContent = editing ? '保存修改' : '创建并加入池';
    const poolLabel = $('host-pool-code').closest('label');
    const credentialsLabel = $('host-credentials-source').closest('label');
    if (poolLabel) poolLabel.hidden = editing;
    if (credentialsLabel) credentialsLabel.hidden = editing;
    $('host-pool-code').disabled = editing;
    $('host-credentials-source').disabled = editing;
  }

  function resetCreateForm() {
    setEditingMode(null);
    for (const id of ['host-name', 'host-pool-code', 'host-dsh-bin', 'host-node-bin', 'host-dsh-home', 'host-public-url', 'host-admin-port', 'host-dsh-port']) {
      const input = $(id);
      if (input) {
        input.value = '';
        input.dataset.autofilled = '0';
      }
    }
  }

  function toggleCreate(show) {
    const panel = $('host-create-panel');
    panel.hidden = !show;
    if (!show) {
      resetCreateForm();
      return;
    }
    if (!editingHostId) {
      setEditingMode(null);
      // Let renderConnection/defaults fill the new-instance fields again.
      for (const id of ['host-name', 'host-dsh-bin', 'host-node-bin']) {
        const input = $(id);
        if (input) input.dataset.autofilled = '1';
      }
      renderConnection();
    }
    $('host-name').focus();
  }

  function beginEditHost(id) {
    const host = manager && manager.instances ? manager.instances.find((entry) => entry.id === id) : null;
    if (!host) {
      showToast('error', '找不到这个实例');
      return;
    }
    setEditingMode(id);
    $('host-create-panel').hidden = false;
    $('host-name').value = host.name || '';
    $('host-dsh-bin').value = host.dshBin || '';
    $('host-node-bin').value = host.nodeBin || '';
    $('host-dsh-home').value = host.dshHome || '';
    $('host-public-url').value = host.publicUrl || '';
    $('host-admin-port').value = host.adminPort || '';
    $('host-dsh-port').value = host.dshPort || '';
    for (const field of ['host-name', 'host-dsh-bin', 'host-node-bin', 'host-dsh-home', 'host-public-url', 'host-admin-port', 'host-dsh-port']) {
      const input = $(field);
      if (input) input.dataset.autofilled = '0';
    }
    $('host-name').focus();
  }

  async function onCreateHost(event) {
    event.preventDefault();
    if (busy) return;
    const payload = {
      name: $('host-name').value.trim(),
      dshBin: $('host-dsh-bin').value.trim(),
      nodeBin: $('host-node-bin').value.trim(),
      dshHome: $('host-dsh-home').value.trim(),
      publicUrl: $('host-public-url').value.trim(),
      adminPort: Number($('host-admin-port').value) || undefined,
      dshPort: Number($('host-dsh-port').value) || undefined,
      start: true,
    };
    if (!payload.name) {
      showToast('error', '请填写实例名称');
      return;
    }
    if (editingHostId) {
      const data = await act('update-host', () => fleet.updateHostInstance(editingHostId, payload));
      if (data) {
        toggleCreate(false);
        await loadManager();
        await loadState();
        showToast('info', '实例配置已保存；如修改了名称/Public URL/端口，host 心跳会自动同步');
      }
      return;
    }
    payload.poolCode = $('host-pool-code').value.trim().toUpperCase();
    payload.copyCredentialsFrom = $('host-credentials-source').value;
    if (!payload.poolCode || payload.poolCode.length !== 8) {
      showToast('error', '需要当前池的 8 位池码；请先在主界面创建或加入池');
      return;
    }
    const data = await act('create', () => fleet.createHostInstance(payload));
    if (data) {
      toggleCreate(false);
      $('host-dsh-home').value = '';
      $('host-credentials-source').value = '';
      $('host-public-url').value = '';
      $('host-admin-port').value = '';
      $('host-dsh-port').value = '';
      await loadManager();
      showToast('info', '实例已创建并加入池；如果状态是待审批，请回到主界面批准。');
    }
  }

  async function onHostAction(action, id) {
    if (busy) return;
    if (action === 'edit') {
      beginEditHost(id);
      return;
    }
    if (action === 'start') {
      const data = await act(`start:${id}`, () => fleet.startHostInstance(id));
      if (data) showToast('info', '实例已启动');
    } else if (action === 'stop') {
      const data = await act(`stop:${id}`, () => fleet.stopHostInstance(id));
      if (data) showToast('info', '实例已停止');
    } else if (action === 'join') {
      const code = manager && manager.defaults ? manager.defaults.poolCode : '';
      if (!code) {
        showToast('error', '当前没有可用的池码，请先在主界面创建或加入池');
        return;
      }
      const data = await act(`join:${id}`, () => fleet.joinHostInstance(id, code));
      if (data) showToast('info', '已加入池；请回到主界面等待池主审批（如果是本机池主则直接批准）。');
    } else if (action === 'approve') {
      const host = manager && manager.instances ? manager.instances.find((entry) => entry.id === id) : null;
      if (!host || !host.deviceId) {
        showToast('error', '找不到这个实例对应的设备 ID');
        return;
      }
      const data = await act(`approve:${id}`, () => fleet.approve(host.deviceId));
      if (data) showToast('info', '已批准该实例入池');
    } else if (action === 'leave') {
      if (!window.confirm('脱离池会停止该实例并清除它在池中的身份；DSH_HOME 和登录/API key 会保留。继续？')) return;
      const data = await act(`leave:${id}`, () => fleet.leaveHostInstance(id));
      if (data) {
        showToast(data.warning ? 'info' : 'info', data.warning || '已脱离池');
      }
    } else if (action === 'delete') {
      if (!window.confirm('删除实例会停止它，并删除它的 host.json、DSH_HOME（包括该实例的 DSH 登录/API key）。继续？')) return;
      const data = await act(`delete:${id}`, () => fleet.deleteHostInstance(id));
      if (data) showToast(data.warning ? 'info' : 'info', data.warning || '实例已删除');
    } else {
      return;
    }
    await loadManager();
    await loadState();
  }

  function bind() {
    $('settings-window-close').addEventListener('click', () => window.close());
    $('directory-form').addEventListener('submit', onDirectorySubmit);
    $('refresh-hosts').addEventListener('click', async () => {
      await loadState();
      const ok = await loadManager();
      if (ok) showToast('info', '实例状态已刷新');
    });
    $('install-runtime').addEventListener('click', async () => {
      if (busy) return;
      const data = await act('install-runtime', () => fleet.installDshRuntime());
      if (!data) return;
      for (const [id, value] of [['host-dsh-bin', data.dshBin], ['host-node-bin', data.nodeBin]]) {
        const input = $(id);
        if (input && value) {
          input.value = value;
          input.dataset.autofilled = '0';
        }
      }
      await loadManager();
      showToast('info', `Node/npm/DSH 已安装到本机，版本 ${data.version || ''}`.trim());
    });
    $('theme-light-btn').addEventListener('click', () => onTheme('light'));
    $('theme-dark-btn').addEventListener('click', () => onTheme('dark'));
    $('view-cache-save').addEventListener('click', async () => {
      const size = Number($('view-cache-size').value);
      if (!Number.isInteger(size) || size < 1 || size > 6) {
        showToast('error', '主机页签缓存数量需要在 1-6 之间');
        return;
      }
      const data = await act('view-cache', () => fleet.setViewCacheSize(size));
      if (data) {
        applySnapshot(data);
        showToast('info', `已保留最近 ${size} 个主机页签`);
      }
    });
    $('demo-mode-btn').addEventListener('click', onDemoToggle);
    $('toggle-create-host').addEventListener('click', () => {
      const hidden = $('host-create-panel').hidden;
      if (hidden) {
        resetCreateForm();
        toggleCreate(true);
      } else {
        toggleCreate(false);
      }
    });
    $('cancel-create-host').addEventListener('click', () => toggleCreate(false));
    $('create-host-form').addEventListener('submit', onCreateHost);
    // Once the user edits an autofilled field, never overwrite it on a later
    // state refresh. Otherwise a background refresh can erase a half-typed form.
    for (const id of ['host-name', 'host-pool-code', 'host-dsh-bin', 'host-node-bin']) {
      const input = $(id);
      if (input) input.addEventListener('input', () => { input.dataset.autofilled = '0'; });
    }
    $('host-instances').addEventListener('click', (event) => {
      const button = event.target.closest('[data-host-action]');
      if (!button) return;
      onHostAction(button.dataset.hostAction, button.dataset.hostId);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') window.close();
    });
    fleet.onState((next) => applySnapshot(next));
    fleet.onRuntimeProgress((payload) => {
      if (payload && payload.line) showManagerNotice('info', `安装运行时：${payload.line}`);
    });
  }

  async function start() {
    bind();
    await loadState();
    await loadManager();
    if (snapshot && snapshot.demo) {
      showManagerNotice('info', '当前处于演示模式；退出演示后才能创建或修改真实 DSH 实例。');
    }
  }

  start().catch((err) => {
    showManagerNotice('error', `初始化设置窗口失败：${err && err.message ? err.message : err}`);
  });
})();
