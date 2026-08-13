'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modeManager', {
  load: () => ipcRenderer.invoke('modes:load'),
  chooseKey: () => ipcRenderer.invoke('modes:choose-key'),
  inspect: (url, options) => ipcRenderer.invoke('modes:inspect', url, options),
  curseforgeKeyStatus: () => ipcRenderer.invoke('curseforge:key-status'),
  saveCurseforgeKey: (apiKey) => ipcRenderer.invoke('curseforge:key-save', apiKey),
  removeCurseforgeKey: () => ipcRenderer.invoke('curseforge:key-remove'),
  authStatus: () => ipcRenderer.invoke('github:auth-status'),
  authStart: (clientId) => ipcRenderer.invoke('github:auth-start', clientId),
  authPoll: (clientId, flow) => ipcRenderer.invoke('github:auth-poll', clientId, flow),
  patLogin: (token) => ipcRenderer.invoke('github:pat-login', token),
  authLogout: () => ipcRenderer.invoke('github:auth-logout'),
  save: (input) => ipcRenderer.invoke('modes:save', input),
  publish: (input, github) => ipcRenderer.invoke('modes:publish', input, github),
  open: (url) => ipcRenderer.invoke('modes:open', url)
});
