'use strict';

/**
 * MultiDSH preload: the only bridge between the sandboxed renderer and the
 * main process. Every method resolves to `{ ok: true, data }` or
 * `{ ok: false, error: { code, message, status } }`.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (err) {
      console.error(`[preload] listener for ${channel} failed`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const fleet = {
  // Snapshot of config + devices + pending state (synchronous cache, never blocks).
  getState: () => ipcRenderer.invoke('fleet:getState'),
  refresh: () => ipcRenderer.invoke('fleet:refresh'),

  // Settings / pool lifecycle.
  setDirectory: (url) => ipcRenderer.invoke('fleet:setDirectory', { url }),
  createPool: (name, createKey) => ipcRenderer.invoke('fleet:createPool', { name, createKey }),
  joinPool: (code) => ipcRenderer.invoke('fleet:joinPool', { code }),
  leavePool: () => ipcRenderer.invoke('fleet:leavePool'),
  exitDemo: () => ipcRenderer.invoke('fleet:exitDemo'),
  enterDemo: () => ipcRenderer.invoke('fleet:enterDemo'),
  setTheme: (theme) => ipcRenderer.invoke('fleet:setTheme', { theme }),
  setViewCacheSize: (size) => ipcRenderer.invoke('fleet:setViewCacheSize', { size }),
  openSettings: () => ipcRenderer.invoke('fleet:openSettings'),
  getLocalHost: () => ipcRenderer.invoke('fleet:getLocalHost'),
  startLocalHost: (options) => ipcRenderer.invoke('fleet:startLocalHost', options),
  stopLocalHost: () => ipcRenderer.invoke('fleet:stopLocalHost'),
  getHostInstances: () => ipcRenderer.invoke('fleet:getHostInstances'),
  createHostInstance: (options) => ipcRenderer.invoke('fleet:createHostInstance', options),
  updateHostInstance: (id, options) => ipcRenderer.invoke('fleet:updateHostInstance', { id, ...options }),
  installDshRuntime: () => ipcRenderer.invoke('fleet:installDshRuntime'),
  startHostInstance: (id) => ipcRenderer.invoke('fleet:startHostInstance', { id }),
  stopHostInstance: (id) => ipcRenderer.invoke('fleet:stopHostInstance', { id }),
  joinHostInstance: (id, poolCode) => ipcRenderer.invoke('fleet:joinHostInstance', { id, poolCode }),
  leaveHostInstance: (id) => ipcRenderer.invoke('fleet:leaveHostInstance', { id }),
  deleteHostInstance: (id) => ipcRenderer.invoke('fleet:deleteHostInstance', { id }),
  setSidebarCollapsed: (collapsed) => ipcRenderer.invoke('fleet:setSidebarCollapsed', { collapsed }),

  // Owner actions.
  approve: (deviceId) => ipcRenderer.invoke('fleet:approve', { deviceId }),
  revoke: (deviceId) => ipcRenderer.invoke('fleet:revoke', { deviceId }),

  // Host view.
  openHost: (hostId) => ipcRenderer.invoke('fleet:openHost', { hostId }),
  closeHost: () => ipcRenderer.invoke('fleet:closeHost'),

  copyText: (text) => ipcRenderer.invoke('fleet:copyText', { text }),

  // One-shot signal so the main process knows the UI is painted.
  notifyReady: () => ipcRenderer.send('fleet:rendererReady'),

  // Push updates from main.
  onState: (callback) => subscribe('fleet:state', callback),
  onHostOpened: (callback) => subscribe('fleet:hostOpened', callback),
  onHostClosed: (callback) => subscribe('fleet:hostClosed', callback),
  onHostError: (callback) => subscribe('fleet:hostError', callback),
  onRuntimeProgress: (callback) => subscribe('fleet:runtimeProgress', callback),
};

contextBridge.exposeInMainWorld('fleet', fleet);
