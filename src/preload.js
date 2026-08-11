'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fireCrew', {
  getState: () => ipcRenderer.invoke('launcher:get-state'),
  getSoopPosts: () => ipcRenderer.invoke('launcher:get-soop-posts'),
  getServerStatus: () => ipcRenderer.invoke('launcher:get-server-status'),
  login: () => ipcRenderer.invoke('launcher:login'),
  logout: () => ipcRenderer.invoke('launcher:logout'),
  checkUpdates: () => ipcRenderer.invoke('launcher:check-updates'),
  installLauncherUpdate: () => ipcRenderer.invoke('launcher:install-update'),
  install: () => ipcRenderer.invoke('launcher:install'),
  launch: () => ipcRenderer.invoke('launcher:launch'),
  repair: () => ipcRenderer.invoke('launcher:repair'),
  setMemory: (value) => ipcRenderer.invoke('launcher:set-memory', value),
  openFolder: () => ipcRenderer.invoke('launcher:open-folder'),
  openReport: () => ipcRenderer.invoke('launcher:open-report'),
  openExternal: (url) => ipcRenderer.invoke('launcher:open-external', url),
  onLog: (handler) => ipcRenderer.on('launcher:log', (_event, value) => handler(value)),
  onProgress: (handler) => ipcRenderer.on('launcher:progress', (_event, value) => handler(value)),
  onAuthCode: (handler) => ipcRenderer.on('launcher:auth-code', (_event, value) => handler(value)),
  onAuthStage: (handler) => ipcRenderer.on('launcher:auth-stage', (_event, value) => handler(value)),
  onStateChanged: (handler) => ipcRenderer.on('launcher:state-changed', (_event, value) => handler(value)),
  onUpdateStatus: (handler) => ipcRenderer.on('launcher:update-status', (_event, value) => handler(value)),
  onSkinUpdated: (handler) => ipcRenderer.on('launcher:skin-updated', (_event, value) => handler(value)),
  onGameExit: (handler) => ipcRenderer.on('launcher:game-exit', (_event, value) => handler(value))
});
