'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPayload, inspectDownload, publishManifest, signPayload, validateCurseForgeApiKey } = require('./core');
const { fetchGithubUser, loginWithPat, pollDeviceFlow, startDeviceFlow } = require('./github-auth');

const projectRoot = path.resolve(__dirname, '..', '..');
const bundledManifestFile = path.join(projectRoot, 'assets', 'distribution-manifest.json');
const runtimeConfigFile = path.join(projectRoot, 'assets', 'runtime-config.json');
let privateKeyFile = '';

function manifestFile() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'distribution-manifest.json')
    : bundledManifestFile;
}

async function ensureWorkingManifest() {
  const workingFile = manifestFile();
  try {
    await fs.access(workingFile);
  } catch {
    await fs.mkdir(path.dirname(workingFile), { recursive: true });
    await fs.copyFile(bundledManifestFile, workingFile);
  }
  return workingFile;
}

function authTokenFile() {
  return path.join(app.getPath('userData'), 'github-token.bin');
}

function curseforgeApiKeyFile() {
  return path.join(app.getPath('userData'), 'curseforge-api-key.bin');
}

function authSettingsFile() {
  return path.join(app.getPath('userData'), 'github-auth.json');
}

async function loadAuthSettings() {
  const runtimeConfig = await fs.readFile(runtimeConfigFile, 'utf8').then(JSON.parse).catch(() => ({}));
  const local = await fs.readFile(authSettingsFile(), 'utf8').then(JSON.parse).catch(() => ({}));
  return { clientId: String(local.clientId || runtimeConfig.githubOAuthClientId || '') };
}

async function saveClientId(clientId) {
  await fs.mkdir(path.dirname(authSettingsFile()), { recursive: true });
  await fs.writeFile(authSettingsFile(), `${JSON.stringify({ clientId }, null, 2)}\n`, 'utf8');
}

async function saveAuthToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 보안 저장소를 사용할 수 없어 GitHub 토큰을 저장하지 않았습니다.');
  await fs.mkdir(path.dirname(authTokenFile()), { recursive: true });
  await fs.writeFile(authTokenFile(), safeStorage.encryptString(token));
}

async function loadAuthToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(await fs.readFile(authTokenFile()));
  } catch {
    return '';
  }
}

async function saveCurseforgeApiKey(apiKey) {
  const value = String(apiKey || '').trim();
  if (value.length < 16) throw new Error('올바른 CurseForge API 키를 입력해 주세요.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 보안 저장소를 사용할 수 없어 CurseForge API 키를 저장하지 않았습니다.');
  await validateCurseForgeApiKey(value);
  await fs.mkdir(path.dirname(curseforgeApiKeyFile()), { recursive: true });
  await fs.writeFile(curseforgeApiKeyFile(), safeStorage.encryptString(value));
}

async function loadCurseforgeApiKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(await fs.readFile(curseforgeApiKeyFile()));
  } catch {
    return '';
  }
}

function createWindow() {
  const window = new BrowserWindow({ width: 1260, height: 850, minWidth: 980, minHeight: 680, title: 'Fire Crew 모드 목록 관리자', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  window.removeMenu();
  window.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('modes:load', async () => JSON.parse(await fs.readFile(await ensureWorkingManifest(), 'utf8')));
ipcMain.handle('modes:choose-key', async () => {
  const result = await dialog.showOpenDialog({ title: 'Ed25519 개인 키 선택', properties: ['openFile'], filters: [{ name: 'PEM 키', extensions: ['pem'] }] });
  if (result.canceled) return '';
  const candidate = result.filePaths[0];
  const [privateKey, runtimeConfig] = await Promise.all([
    fs.readFile(candidate, 'utf8'),
    fs.readFile(runtimeConfigFile, 'utf8').then(JSON.parse)
  ]);
  const probe = Buffer.from('fire-crew-mode-manager-key-check', 'utf8');
  const signature = crypto.sign(null, probe, privateKey);
  if (!crypto.verify(null, probe, runtimeConfig.distributionPublicKey, signature)) {
    throw new Error('선택한 개인 키가 현재 v1.0.1 이후 런처의 새 배포 공개 키와 일치하지 않습니다. 새 fire-crew-manifest-private.pem을 선택해 주세요.');
  }
  privateKeyFile = candidate;
  const fingerprint = crypto.createHash('sha256')
    .update(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }))
    .digest('hex').slice(0, 12);
  return { name: path.basename(privateKeyFile), fingerprint };
});
ipcMain.handle('modes:inspect', async (_event, url, options) => inspectDownload(url, {
  ...options,
  curseforgeApiKey: await loadCurseforgeApiKey()
}));
ipcMain.handle('curseforge:key-status', async () => {
  const apiKey = await loadCurseforgeApiKey();
  if (!apiKey) return { configured: false, valid: false };
  try {
    await validateCurseForgeApiKey(apiKey);
    return { configured: true, valid: true };
  } catch (error) {
    return { configured: true, valid: false, error: error.message };
  }
});
ipcMain.handle('curseforge:key-save', async (_event, apiKey) => {
  await saveCurseforgeApiKey(apiKey);
  return { configured: true, valid: true };
});
ipcMain.handle('curseforge:key-remove', async () => {
  await fs.rm(curseforgeApiKeyFile(), { force: true });
  return { configured: false };
});
ipcMain.handle('github:auth-status', async () => {
  const settings = await loadAuthSettings();
  const token = await loadAuthToken();
  if (!token) return { connected: false, clientId: settings.clientId };
  try {
    return { connected: true, clientId: settings.clientId, user: await fetchGithubUser(token) };
  } catch (error) {
    return { connected: false, clientId: settings.clientId, error: error.message };
  }
});
ipcMain.handle('github:auth-start', async (_event, clientId) => {
  const flow = await startDeviceFlow(clientId);
  await saveClientId(String(clientId).trim());
  clipboard.writeText(flow.userCode);
  await shell.openExternal(flow.verificationUri);
  return flow;
});
ipcMain.handle('github:auth-poll', async (_event, clientId, flow) => {
  const result = await pollDeviceFlow({ clientId, ...flow });
  const user = await fetchGithubUser(result.token);
  await saveAuthToken(result.token);
  return { connected: true, user, scope: result.scope };
});
ipcMain.handle('github:pat-login', async (_event, tokenValue) => {
  const result = await loginWithPat(tokenValue);
  await saveAuthToken(result.token);
  return { connected: true, user: result.user, method: 'pat' };
});
ipcMain.handle('github:auth-logout', async () => {
  await fs.rm(authTokenFile(), { force: true });
  return { connected: false };
});
ipcMain.handle('modes:save', async (_event, input) => {
  if (!privateKeyFile) throw new Error('먼저 개인 키를 선택해 주세요.');
  const [privateKey, runtimeConfig] = await Promise.all([
    fs.readFile(privateKeyFile, 'utf8'),
    fs.readFile(runtimeConfigFile, 'utf8').then(JSON.parse)
  ]);
  const envelope = signPayload(createPayload(input), privateKey, runtimeConfig.distributionPublicKey);
  await fs.writeFile(await ensureWorkingManifest(), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  return envelope;
});
ipcMain.handle('modes:publish', async (_event, input, github) => {
  if (!privateKeyFile) throw new Error('먼저 개인 키를 선택해 주세요.');
  const [privateKey, runtimeConfig] = await Promise.all([
    fs.readFile(privateKeyFile, 'utf8'),
    fs.readFile(runtimeConfigFile, 'utf8').then(JSON.parse)
  ]);
  const envelope = signPayload(createPayload(input), privateKey, runtimeConfig.distributionPublicKey);
  await fs.writeFile(await ensureWorkingManifest(), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  return publishManifest({ ...github, token: github.token || await loadAuthToken() }, envelope);
});
ipcMain.handle('modes:open', (_event, url) => shell.openExternal(url));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
