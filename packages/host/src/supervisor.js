// Supervises the local `dsh --profile web` process and captures its one-shot token.

import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_LINE = /dsh web:\s+(\S+)/;

function authorityOf(publicUrl) {
  try {
    return new URL(publicUrl).host;
  } catch {
    return null;
  }
}

export class DshSupervisor extends EventEmitter {
  constructor(options) {
    super();
    this.nodeBin = options.nodeBin || process.execPath;
    this.dshBin = options.dshBin;
    this.dshPort = Number(options.dshPort);
    this.publicUrl = options.publicUrl || null;
    this.dshHome = options.dshHome || null;
    this.dshArgs = options.dshArgs || [];
    this.log = options.log || (() => {});
    this.child = null;
    this.token = null;
    this.url = null;
    this.startedAt = null;
    this.restarts = 0;
    this.lastExit = null;
    this.stopping = false;
    this.restartTimer = null;
    this.backoff = [1000, 2000, 5000, 10000];
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  getState() {
    return {
      pid: this.pid,
      port: this.dshPort,
      tokenCaptured: Boolean(this.token),
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastExit: this.lastExit,
    };
  }

  args() {
    const args = [
      this.dshBin,
      'web',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(this.dshPort),
    ];
    if (this.publicUrl) {
      const root = this.publicUrl.endsWith('/') ? this.publicUrl : `${this.publicUrl}/`;
      const authority = authorityOf(this.publicUrl);
      args.push('--public-url', root);
      if (authority) args.push('--trusted-host', authority);
    }
    args.push(...this.dshArgs);
    return args;
  }

  start() {
    if (this.child) return;
    this.stopping = false;
    this.token = null;
    this.url = null;
    this.startedAt = Date.now();
    const env = { ...process.env };
    if (this.dshHome) env.DSH_HOME = path.resolve(this.dshHome);
    this.log(`starting dsh: ${this.nodeBin} ${this.args().join(' ')}`);
    const child = spawn(this.nodeBin, this.args(), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const match = TOKEN_LINE.exec(line);
        if (match && !this.token) {
          try {
            const parsed = new URL(match[1]);
            const token = parsed.searchParams.get('token');
            if (token) {
              this.token = token;
              this.url = match[1];
              this.log('captured dsh token');
              this.emit('token', { token, url: this.url });
            }
          } catch {
            this.log(`could not parse dsh url: ${match[1]}`);
          }
        } else {
          this.log(`dsh: ${line}`);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.log(`dsh stderr: ${line.trim()}`);
      }
    });

    child.on('exit', (code, signal) => {
      this.lastExit = { code, signal, at: Date.now() };
      this.child = null;
      this.token = null;
      this.url = null;
      this.emit('exit', this.lastExit);
      if (this.stopping) return;
      const delay = this.backoff[Math.min(this.restarts, this.backoff.length - 1)];
      this.restarts += 1;
      this.log(`dsh exited (code=${code} signal=${signal}); restarting in ${delay}ms`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.stopping) this.start();
      }, delay);
    });
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    const pid = child.pid;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    });
    this.child = null;
  }
}

/** Verify a path looks like the dsh CLI entry. */
export function assertDshBin(dshBin) {
  if (!dshBin || !fs.existsSync(dshBin)) {
    throw new Error(`dsh CLI not found: ${dshBin}`);
  }
  return dshBin;
}
