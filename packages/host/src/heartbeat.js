// Periodic heartbeat to the MultiDSH Directory.
//
// 30s is frequent enough for a 90s online window without turning the Directory
// into a write-heavy KV workload. Keep the cadence aligned with
// packages/directory-worker/src/app.js ONLINE_WINDOW_MS.
export const HEARTBEAT_INTERVAL_MS = 30_000;

export class Heartbeat {
  constructor({ directoryUrl, deviceToken, config, supervisor, onStatusChange, log = () => {} }) {
    this.directoryUrl = directoryUrl;
    this.deviceToken = deviceToken;
    this.config = config;
    this.supervisor = supervisor;
    this.onStatusChange = onStatusChange;
    this.log = log;
    this.timer = null;
    this.state = { lastHeartbeatAt: null, lastError: null, status: config.status || 'pending' };
    this.stopped = false;
  }

  getState() {
    return { ...this.state };
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.stopped) return;
    try {
      const res = await fetch(`${this.directoryUrl}/api/heartbeat`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.deviceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version: this.config.version || '0.1.0',
          name: this.config.name || null,
          publicUrl: this.config.publicUrl,
          machineId: this.config.machineId || null,
          machineName: this.config.machineName || null,
          health: {
            // Reserved: DSH does not expose a cheap active-session counter yet.
            // The desktop UI shows dshRunning instead of a fake 0.
            runningSessions: null,
            dshPort: this.config.dshPort,
            dshRunning: Boolean(this.supervisor.pid),
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 403) {
        const body = await res.json().catch(() => null);
        this.state.lastError = body?.error?.message || 'device revoked';
        this.state.status = 'revoked';
        this.log(`heartbeat rejected: ${this.state.lastError}; stopping heartbeats`);
        this.stop();
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`heartbeat ${res.status}`);
      this.state.lastHeartbeatAt = Date.now();
      this.state.lastError = null;
      if (body?.status && body.status !== this.state.status) {
        this.state.status = body.status;
        this.config.status = body.status;
        this.onStatusChange?.(body.status);
      }
    } catch (err) {
      this.state.lastError = err.message;
    }
  }
}
