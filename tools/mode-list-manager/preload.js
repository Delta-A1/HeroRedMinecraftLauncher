'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modeManager', {
  load: () => ipcRenderer.invoke('modes:load'),
  chooseKey: () => ipcRenderer.invoke('modes:choose-key'),
  inspect: (url) => ipcRenderer.invoke('modes:inspect', url),
  authStatus: () => ipcRenderer.invoke('github:auth-status'),
  authStart: (clientId) => ipcRenderer.invoke('github:auth-start', clientId),
  authPoll: (clientId, flow) => ipcRenderer.invoke('github:auth-poll', clientId, flow),
  authLogout: () => ipcRenderer.invoke('github:auth-logout'),
  save: (input) => ipcRenderer.invoke('modes:save', input),
  publish: (input, github) => ipcRenderer.invoke('modes:publish', input, github),
  open: (url) => ipcRenderer.invoke('modes:open', url)
});
