'use strict';

const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AuthService } = require('./auth-service');
const {
  createLaunchProfiles,
  PRODUCT,
  getRuntimeConfigurationIssues,
  loadRuntimeConfig,
  productForProfile
} = require('./config');
const {
  ensureDirectory,
  readJson,
  writeJsonAtomic
} = require('./file-utils');
const { migrateLegacyInstance, countMods, findLegacyInstance } = require('./legacy-migration');
const { MinecraftService } = require('./minecraft-service');
const {
  DistributionConfigurationError,
  PatchService,
  verifyManifestEnvelope
} = require('./patch-service');
const { upsertServer } = require('./server-list');
const { queryMinecraftServer } = require('./server-status');
const { SkinService } = require('./skin-service');
const { LauncherUpdateService } = require('./launcher-update-service');
const {
  cleanupUpdateHelpers,
  runUpdateHelper,
  updateJobFileFromArgv
} = require('./launcher-update-helper');
const {
  normalizeSoopPosts,
  resolveSoopBoardIds,
  setOption
} = require('./core');

const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
const dataRoot = path.join(localAppData, 'FireCrewLauncherLoginTest');
const updateJobFile = updateJobFileFromArgv();
app.setPath('userData', path.join(dataRoot, updateJobFile ? 'updater-electron' : 'electron'));

const paths = Object.freeze({
  root: dataRoot,
  cache: path.join(dataRoot, 'cache'),
  game: path.join(dataRoot, 'game'),
  runtime: path.join(dataRoot, 'runtime', 'java-25'),
  config: path.join(dataRoot, 'launcher-state.json'),
  baseState: path.join(dataRoot, 'base-install-state.json'),
  patchState: path.join(dataRoot, 'installed-distribution.json'),
  patchManifestCache: path.join(dataRoot, 'cache', 'distribution-manifest.json'),
  migrationState: path.join(dataRoot, 'legacy-migration.json'),
  prismData: path.join(dataRoot, 'prism-data'),
  logs: path.join(dataRoot, 'logs'),
  authLog: path.join(dataRoot, 'logs', 'authentication-errors.log'),
  installLog: path.join(dataRoot, 'logs', 'installation-errors.log'),
  compatibilityReport: path.join(dataRoot, 'logs', 'compatibility-report.json'),
  soopCache: path.join(dataRoot, 'soop-posts-cache.json'),
  authCache: path.join(dataRoot, 'secure', 'microsoft-token-cache.bin'),
  authProfile: path.join(dataRoot, 'secure', 'minecraft-profile.json'),
  skins: path.join(dataRoot, 'cache', 'skins')
});

let mainWindow;
let operationInProgress = false;
let gameRunning = false;
let runtimeConfig;
let launchProfiles = [];
let activeProfile;
let activeProduct = PRODUCT;
let profilePaths = paths;
let authService;
let minecraftService;
let patchService;
let skinService;
let launcherUpdateService;
let patchStatusPromise = null;
let modeUpdateInProgress = false;
let modeUpdateStatus = {
  state: 'idle',
  configured: false,
  available: false,
  currentVersion: '',
  latestVersion: '',
  changedFiles: 0,
  progress: 0,
  message: '모드 업데이트 정보를 확인하지 않았습니다.'
};
const smokeTest = process.argv.includes('--smoke-test');

function expectedInstallRoot(localData = localAppData) {
  return path.resolve(localData, 'Programs', 'FireCrewLauncher');
}

function isApprovedInstallPath(executablePath = process.execPath, localData = localAppData) {
  return path.dirname(path.resolve(executablePath)).toLowerCase()
    === expectedInstallRoot(localData).toLowerCase();
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function log(message, level = 'info') {
  emit('launcher:log', { message, level, at: new Date().toISOString() });
}

function progress(stage, percent, detail = '') {
  emit('launcher:progress', {
    stage,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    detail
  });
  if (modeUpdateInProgress) {
    modeUpdateStatus = {
      ...modeUpdateStatus,
      state: 'updating',
      progress: Math.max(0, Math.min(100, Math.round(percent))),
      message: detail || stage
    };
    emit('launcher:mode-update-status', modeUpdateStatus);
  }
}

function cleanAuthenticationError(error) {
  return String(error?.stack || error?.message || error || '알 수 없는 인증 오류')
    .replace(/("?(?:access_token|refresh_token|device_code)"?\s*[:=]\s*")[^"]+/gi, '$1[REDACTED]')
    .slice(0, 12000);
}

function collectErrorMessages(error, messages = []) {
  if (!error) return messages;
  const message = String(error.message || error).trim();
  if (message && !messages.includes(message)) messages.push(message);
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    for (const child of error.errors) collectErrorMessages(child, messages);
  }
  if (error.cause) collectErrorMessages(error.cause, messages);
  return messages;
}

async function reportInstallationError(stage, error) {
  const messages = collectErrorMessages(error);
  const summary = messages.at(-1) || '알 수 없는 설치 오류';
  const detail = cleanAuthenticationError(error);
  await ensureDirectory(paths.logs);
  await fs.appendFile(
    paths.installLog,
    `[${new Date().toISOString()}] ${stage}\n${messages.join('\n')}\n${detail}\n\n`,
    'utf8'
  );
  const friendly = `${stage} 실패: ${summary}`;
  log(`${friendly} · 설정의 로그 폴더에서 전체 기록을 확인할 수 있습니다.`, 'error');
  const wrapped = new Error(friendly);
  wrapped.code = error?.code || 'INSTALLATION_FAILED';
  return wrapped;
}

function describeAuthenticationError(error) {
  const raw = String(error?.message || error || '');
  const xerr = raw.match(/"?XErr"?\s*:\s*(\d+)/i)?.[1];
  if (/Invalid app registration/i.test(raw)) {
    return 'Microsoft 계정 인증은 완료됐지만 Minecraft 서비스 연결 승인이 아직 확인되지 않았습니다.';
  }
  if (/Failed to authenticate with xbox live/i.test(raw)) {
    return `Microsoft 로그인은 완료됐지만 Xbox Live 계정 인증에 실패했습니다.${xerr ? ` (XErr ${xerr})` : ''}`;
  }
  if (/Failed to authorize with xbox live/i.test(raw)) {
    return `Microsoft 로그인은 완료됐지만 Minecraft용 Xbox 권한을 받지 못했습니다.${xerr ? ` (XErr ${xerr})` : ''} Xbox 프로필·연령·가족·지역 설정을 확인해 주세요.`;
  }
  if (/Failed to login minecraft with xbox/i.test(raw)) {
    return 'Xbox 로그인은 완료됐지만 Minecraft 서비스 로그인에 실패했습니다.';
  }
  if (error?.code === 'MINECRAFT_OWNERSHIP_REQUIRED' || /소유권/i.test(raw)) {
    return '로그인한 계정에서 Minecraft: Java Edition 소유권을 확인하지 못했습니다.';
  }
  return `Microsoft 로그인을 완료하지 못했습니다.${error?.code ? ` (${error.code})` : ''}`;
}

async function reportAuthenticationError(error) {
  const friendly = describeAuthenticationError(error);
  const detail = cleanAuthenticationError(error);
  await ensureDirectory(paths.logs);
  await fs.appendFile(
    paths.authLog,
    `[${new Date().toISOString()}] ${friendly}\n${detail}\n\n`,
    'utf8'
  );
  log(friendly, 'error');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'Microsoft 로그인 실패',
    message: friendly,
    detail: `${detail.slice(0, 1800)}\n\n전체 기록: ${paths.authLog}`,
    buttons: ['닫기', '로그 폴더 열기'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (result.response === 1) await shell.openPath(paths.logs);
  return new Error(friendly);
}

async function ensureDirectories() {
  await Promise.all([
    paths.root,
    paths.cache,
    paths.game,
    paths.runtime,
    paths.logs,
    path.dirname(paths.authCache)
  ].map(ensureDirectory));
}

function pathsForProfile(profile) {
  if (!launchProfiles.length || profile.id === launchProfiles[0].id) return paths;
  const root = path.join(paths.root, 'profiles', profile.id);
  return {
    ...paths,
    root,
    cache: path.join(root, 'cache'),
    game: path.join(root, 'game'),
    runtime: path.join(root, 'runtime', `java-${profile.minecraft.javaMajorVersion}`),
    baseState: path.join(root, 'base-install-state.json'),
    patchState: path.join(root, 'installed-distribution.json'),
    patchManifestCache: path.join(root, 'cache', 'distribution-manifest.json'),
    migrationState: path.join(root, 'legacy-migration.json')
  };
}

async function loadLaunchProfileCatalog() {
  const localEnvelope = await readJson(runtimeConfig.bundledManifestPath, null);
  let localProfiles = [];
  if (localEnvelope) {
    const localPayload = verifyManifestEnvelope(
      localEnvelope,
      runtimeConfig.distributionPublicKey,
      runtimeConfig.allowUnsignedLocalManifest
    );
    localProfiles = Array.isArray(localPayload.profiles) ? localPayload.profiles : [];
  }
  if (runtimeConfig.distributionManifestUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(runtimeConfig.distributionManifestUrl, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': `Fire-Crew-Launcher/${PRODUCT.version}` }
        });
        if (!response.ok) throw new Error(`프로필 목록 조회 실패 (HTTP ${response.status})`);
        const envelope = await response.json();
        const payload = verifyManifestEnvelope(envelope, runtimeConfig.distributionPublicKey, false);
        if (Array.isArray(payload.profiles) && payload.profiles.length) return payload.profiles;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      log(`원격 프로필 목록 확인 실패, 번들 목록을 사용합니다: ${error.message}`, 'warning');
    }
  }
  return localProfiles.length ? localProfiles : runtimeConfig.profiles;
}

function createProfileServices() {
  profilePaths = pathsForProfile(activeProfile);
  minecraftService = new MinecraftService({
    gameRoot: profilePaths.game,
    runtimeRoot: profilePaths.runtime,
    baseStateFile: profilePaths.baseState,
    product: activeProduct,
    onProgress: progress,
    onLog: log,
    onGameExit: (value) => {
      gameRunning = false;
      emit('launcher:game-exit', value);
    }
  });
  patchService = new PatchService({
    gameRoot: profilePaths.game,
    cacheRoot: path.join(profilePaths.cache, 'patch'),
    stateFile: profilePaths.patchState,
    manifestCacheFile: profilePaths.patchManifestCache,
    manifestUrl: activeProfile.distributionManifestUrl,
    localManifestPath: activeProfile.bundledManifestPath,
    publicKey: activeProfile.distributionPublicKey,
    allowUnsignedLocalManifest: activeProfile.allowUnsignedLocalManifest,
    product: activeProduct,
    onProgress: progress,
    onLog: log
  });
}

function createServices() {
  createProfileServices();
  authService = new AuthService({
    clientId: runtimeConfig.microsoftClientId,
    cacheFile: paths.authCache,
    profileFile: paths.authProfile,
    safeStorage,
    openExternal: (url) => shell.openExternal(url),
    onDeviceCode: (value) => emit('launcher:auth-code', value),
    onMicrosoftAuthenticated: ({ username }) => {
      emit('launcher:auth-stage', {
        stage: 'microsoft-complete',
        username,
        message: 'Microsoft 인증이 완료되었습니다. Minecraft 계정과 소유권을 확인하고 있습니다.'
      });
      progress('Microsoft 인증 완료', 62, 'Minecraft 계정 연결을 확인하고 있습니다.');
    }
  });
  skinService = new SkinService({
    cacheRoot: paths.skins
  });
  launcherUpdateService = new LauncherUpdateService({
    currentVersion: app.getVersion(),
    repository: runtimeConfig.githubRepository,
    assetName: runtimeConfig.githubReleaseAsset,
    dataRoot: paths.root,
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    onStatus: (status) => emit('launcher:update-status', status)
  });
}

async function syncSessionSkin(session) {
  if (!session?.profile?.skin?.url) return '';
  try {
    const dataUrl = await skinService.refresh(session.profile);
    emit('launcher:skin-updated', {
      profileId: session.profile.id,
      dataUrl,
      variant: session.profile.skin.variant
    });
    return dataUrl;
  } catch (error) {
    log(`Minecraft 스킨을 불러오지 못했습니다: ${error.message}`, 'warning');
    return '';
  }
}

async function requestJson(urlValue, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 15000);
  try {
    const response = await fetch(urlValue, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Fire-Crew-Launcher/1.0.3',
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getSoopPosts() {
  await ensureDirectories();
  const cached = await readJson(paths.soopCache, null);
  try {
    const requestOptions = {
      timeoutMs: 8000,
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Origin: 'https://www.sooplive.com',
        Referer: `${PRODUCT.soop.stationUrl}/`
      }
    };
    const menuUrl = new URL(PRODUCT.soop.menuApi);
    menuUrl.searchParams.set('_', String(Date.now()));
    const menu = await requestJson(menuUrl.toString(), requestOptions);
    const boardIds = resolveSoopBoardIds(menu, PRODUCT.soop.boardIds);
    if (!boardIds.notice || !boardIds.secret) throw new Error('필수 게시판을 찾을 수 없습니다.');

    const payloads = await Promise.all(Object.values(boardIds).map((bbsNo) => {
      const boardUrl = new URL(PRODUCT.soop.boardApi);
      boardUrl.searchParams.set('bbsNo', String(bbsNo));
      boardUrl.searchParams.set('_', String(Date.now()));
      return requestJson(boardUrl.toString(), requestOptions);
    }));
    const posts = payloads
      .flatMap((payload) => normalizeSoopPosts(payload, PRODUCT.soop.streamerId, 20))
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
    if (!posts.length) throw new Error('표시할 최신 글이 없습니다.');
    const result = {
      posts,
      fetchedAt: new Date().toISOString(),
      source: 'live',
      stationName: PRODUCT.soop.stationName,
      stationUrl: PRODUCT.soop.stationUrl
    };
    await writeJsonAtomic(paths.soopCache, result);
    return result;
  } catch (error) {
    log(`SOOP 최신 글 조회 실패: ${error.message}`, 'warning');
    if (Array.isArray(cached?.posts) && cached.posts.length) {
      return { ...cached, source: 'cache' };
    }
    return {
      posts: [],
      fetchedAt: null,
      source: 'unavailable',
      stationName: PRODUCT.soop.stationName,
      stationUrl: PRODUCT.soop.stationUrl
    };
  }
}

function isTrustedExternalUrl(value) {
  try {
    const url = new URL(String(value));
    const isSoop = url.hostname === 'sooplive.com' || url.hostname.endsWith('.sooplive.com');
    const isYouTube = url.hostname === 'youtube.com'
      || url.hostname.endsWith('.youtube.com')
      || url.hostname === 'youtu.be';
    return url.protocol === 'https:' && (isSoop || isYouTube);
  } catch {
    return false;
  }
}

async function openTrustedExternal(value) {
  if (!isTrustedExternalUrl(value)) throw new Error('허용되지 않은 외부 주소입니다.');
  await shell.openExternal(String(value));
  return { opened: true };
}

async function patchClientOptions() {
  const optionsFile = path.join(profilePaths.game, 'options.txt');
  let current = '';
  try {
    current = await fs.readFile(optionsFile, 'utf8');
  } catch {
    current = '';
  }
  const next = setOption(current, 'lang', 'ko_kr');
  await fs.writeFile(optionsFile, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
}

async function selectProfile(profileId) {
  if (operationInProgress || gameRunning) throw new Error('게임 또는 다른 작업이 진행 중에는 프로필을 변경할 수 없습니다.');
  const next = launchProfiles.find((profile) => profile.id === String(profileId));
  if (!next) throw new Error('존재하지 않는 실행 프로필입니다.');
  if (next.id === activeProfile.id) return getState();
  activeProfile = next;
  activeProduct = productForProfile(next);
  patchStatusPromise = null;
  modeUpdateStatus = {
    state: 'idle', configured: false, available: false, currentVersion: '', latestVersion: '',
    changedFiles: 0, progress: 0, message: '선택한 프로필의 모드 정보를 확인합니다.'
  };
  createProfileServices();
  await ensureDirectory(profilePaths.game);
  const saved = await readJson(paths.config, { memoryMb: 8192 });
  await writeJsonAtomic(paths.config, { ...saved, activeProfileId: next.id });
  return getState();
}

async function getPatchStatus() {
  if (!patchStatusPromise) {
    patchStatusPromise = patchService.getStatus().catch((error) => ({
      configured: false,
      ready: false,
      installedVersion: '',
      changedFiles: 0,
      version: '',
      message: error.message,
      errorCode: error.code || 'PATCH_STATUS_FAILED'
    })).finally(() => {
      patchStatusPromise = null;
    });
  }
  return patchStatusPromise;
}

async function getState() {
  await ensureDirectories();
  await Promise.all([
    profilePaths.game,
    profilePaths.runtime,
    profilePaths.cache
  ].map(ensureDirectory));
  const [saved, auth, base, patch, modCount, legacyInstance] = await Promise.all([
    readJson(paths.config, { memoryMb: 8192 }),
    authService.getStatus(),
    minecraftService.getStatus(),
    getPatchStatus(),
    countMods(profilePaths.game),
    findLegacyInstance(paths.prismData)
  ]);
  const importedClientReady = modCount >= 250;
  const clientFilesReady = patch.ready || importedClientReady;
  const installed = Boolean(base.ready && clientFilesReady);
  const configurationIssues = getRuntimeConfigurationIssues(runtimeConfig);
  const skinDataUrl = auth.minecraftId
    ? await skinService.getDataUrl(auth.minecraftId)
    : '';
  if (!patch.configured && !importedClientReady && !legacyInstance) {
    configurationIssues.push({
      id: 'distribution',
      message: patch.message || '모드 배포 정보가 설정되지 않았습니다.'
    });
  }
  return {
    product: activeProduct,
    profiles: launchProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      server: profile.server,
      minecraft: profile.minecraft,
      pack: profile.pack
    })),
    activeProfileId: activeProfile.id,
    qaMode: Boolean(runtimeConfig.qaBypassMicrosoftLogin),
    installed,
    updateAvailable: Boolean(base.ready && patch.configured && !patch.ready),
    importedClientReady,
    legacyImportAvailable: Boolean(legacyInstance),
    jarCount: modCount,
    memoryMb: Number(saved.memoryMb) || 8192,
    busy: operationInProgress,
    gameRunning,
    dataRoot: paths.root,
    auth: {
      ...auth,
      skinDataUrl
    },
    base,
    patch: {
      configured: patch.configured,
      ready: patch.ready,
      changedFiles: patch.changedFiles,
      version: patch.version,
      message: patch.message
    },
    modeUpdate: {
      ...modeUpdateStatus,
      configured: patch.configured,
      available: Boolean(base.ready && patch.configured && !patch.ready),
      currentVersion: patch.installedVersion || modeUpdateStatus.currentVersion || '',
      latestVersion: patch.version || modeUpdateStatus.latestVersion || '',
      changedFiles: patch.changedFiles,
      message: ['checking', 'updating', 'error'].includes(modeUpdateStatus.state)
        ? modeUpdateStatus.message
        : patch.message
    },
    launcherUpdate: launcherUpdateService.getStatus(),
    configurationIssues
  };
}

async function checkLauncherUpdate() {
  await launcherUpdateService.check();
  return getState();
}

function setModeUpdateStatus(next) {
  modeUpdateStatus = { ...modeUpdateStatus, ...next };
  emit('launcher:mode-update-status', modeUpdateStatus);
}

async function syncModeUpdates(options = {}) {
  if (operationInProgress || modeUpdateInProgress) {
    if (options.automatic) return getState();
    throw new Error('다른 작업이 진행 중입니다.');
  }
  operationInProgress = true;
  modeUpdateInProgress = true;
  setModeUpdateStatus({ state: 'checking', progress: 5, message: 'GitHub 모드 목록을 확인하고 있습니다.' });
  try {
    const [patch, base] = await Promise.all([getPatchStatus(), minecraftService.getStatus()]);
    setModeUpdateStatus({
      configured: patch.configured,
      currentVersion: patch.installedVersion || '',
      latestVersion: patch.version || '',
      changedFiles: patch.changedFiles,
      available: Boolean(base.ready && patch.configured && !patch.ready)
    });
    if (!patch.configured) {
      setModeUpdateStatus({ state: 'error', progress: 0, message: patch.message || '모드 목록이 설정되지 않았습니다.' });
      return getState();
    }
    if (patch.ready) {
      setModeUpdateStatus({ state: 'up-to-date', available: false, progress: 100, message: '모드 목록과 설치 파일이 최신 상태입니다.' });
      return getState();
    }
    if (!base.ready) {
      setModeUpdateStatus({ state: 'available', available: false, progress: 0, message: '새 모드 목록을 확인했습니다. 최초 설치할 때 적용됩니다.' });
      return getState();
    }
    setModeUpdateStatus({ state: 'updating', available: true, progress: 10, message: `${patch.changedFiles}개 변경 파일을 적용합니다.` });
    const result = await patchService.apply();
    setModeUpdateStatus({
      state: 'up-to-date',
      available: false,
      currentVersion: result.manifest.version,
      latestVersion: result.manifest.version,
      changedFiles: 0,
      progress: 100,
      message: result.changedFiles ? `${result.changedFiles}개 모드 파일을 갱신했습니다.` : '모드 목록이 최신 상태입니다.'
    });
    return getState();
  } catch (error) {
    setModeUpdateStatus({ state: 'error', progress: 0, message: `모드 업데이트 실패: ${error.message}` });
    if (options.automatic) {
      log(`자동 모드 업데이트 실패: ${error.message}`, 'warning');
      return getState();
    }
    throw error;
  } finally {
    modeUpdateInProgress = false;
    operationInProgress = false;
  }
}

async function installLauncherUpdate() {
  if (!launcherUpdateService.getStatus().available) await launcherUpdateService.check();
  const status = launcherUpdateService.getStatus();
  if (!status.available) return getState();
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '런처 업데이트',
    message: `불꽃단 런처 ${status.latestVersion}을(를) 설치할까요?`,
    detail: '다운로드와 검증이 끝나면 런처가 자동으로 종료되고 새 버전으로 다시 시작됩니다.',
    buttons: ['취소', '다운로드 후 재시작'],
    defaultId: 1,
    cancelId: 0,
    noLink: true
  });
  if (result.response !== 1) return getState();
  await launcherUpdateService.applyAndRestart();
  setImmediate(() => app.quit());
  return { restarting: true };
}

async function recordCompatibility(result, migration) {
  const previous = await readJson(paths.compatibilityReport, { runs: [] });
  previous.runs = Array.isArray(previous.runs) ? previous.runs : [];
  previous.runs.push({
    at: new Date().toISOString(),
    launcherVersion: PRODUCT.version,
    profileId: activeProfile.id,
    packVersion: activeProduct.pack.version,
    distributionVersion: result?.manifest?.version || 'legacy-import',
    migratedFromPrism: Boolean(migration?.migrated),
    changedFiles: result?.changedFiles || 0,
    quarantined: result?.quarantined || []
  });
  await writeJsonAtomic(paths.compatibilityReport, previous);
}

async function prepareClientInternal(options = {}) {
  const saved = await readJson(paths.config, { memoryMb: 8192 });
  progress('클라이언트 준비', 1, '독립 실행 환경을 확인합니다.');
  await minecraftService.prepareBase(options);

  const migration = await migrateLegacyInstance({
    prismDataRoot: paths.prismData,
    gameRoot: profilePaths.game,
    migrationStateFile: profilePaths.migrationState,
    onProgress: progress,
    onLog: log
  });

  let patchResult = null;
  try {
    patchResult = await patchService.apply(options);
  } catch (error) {
    const canContinue = migration.available || options.allowIncompleteDistribution;
    if (!(error instanceof DistributionConfigurationError) || !canContinue) throw error;
    if (migration.available) {
      log('기존 Prism 클라이언트를 독립 폴더로 가져왔습니다. 서명형 패치 서버가 연결되기 전까지 기존 파일로 실행합니다.', 'warning');
      progress('기존 클라이언트 확인', 88, `${migration.modCount}개 모드 사용`);
    } else {
      log('로그인 없는 QA 모드에서는 패치 서버가 없어도 기본 설치와 런처 기능 검사를 계속합니다.', 'warning');
      progress('QA 기본 설치 확인', 88, '모드 패치는 연결하지 않고 Java·Minecraft·서버 목록만 확인합니다.');
    }
  }

  await patchClientOptions();
  const serverResult = await upsertServer(profilePaths.game, activeProduct.server);
  progress('서버 목록 등록', 94, `${activeProduct.server.name} · ${activeProduct.server.address}`);
  await writeJsonAtomic(paths.config, {
    ...saved,
    memoryMb: Number(saved.memoryMb) || 8192,
    activeProfileId: activeProfile.id,
    packVersion: activeProduct.pack.version,
    launcherVersion: PRODUCT.version,
    serverAddress: activeProduct.server.address,
    installedAt: saved.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await recordCompatibility(patchResult, migration);
  progress(
    options.allowIncompleteDistribution ? 'QA 준비 완료' : '플레이 준비 완료',
    98,
    serverResult.added ? '서버 목록에 새로 등록했습니다.' : '서버 목록을 최신 주소로 확인했습니다.'
  );
  return { patchResult, migration };
}

async function install(options = {}) {
  if (operationInProgress) throw new Error('다른 작업이 진행 중입니다.');
  operationInProgress = true;
  try {
    const qaMode = Boolean(runtimeConfig.qaBypassMicrosoftLogin);
    if (!qaMode) {
      const session = await authService.acquireMinecraftSession({ interactive: true });
      await syncSessionSkin(session);
    }
    await prepareClientInternal({
      ...options,
      allowIncompleteDistribution: qaMode
    });
    progress(
      qaMode ? 'QA 검사 완료' : '설치 완료',
      100,
      qaMode
        ? '로그인 없이 설치·패치·서버 목록 흐름을 확인했습니다. 실제 게임 실행은 잠겨 있습니다.'
        : '이제 게임 시작 버튼으로 바로 접속할 수 있습니다.'
    );
    return getState();
  } catch (error) {
    throw await reportInstallationError('클라이언트 준비', error);
  } finally {
    operationInProgress = false;
  }
}

async function launchGame() {
  if (runtimeConfig.qaBypassMicrosoftLogin) {
    const error = new Error('로그인 없는 QA 빌드에서는 실제 Minecraft 실행과 서버 접속을 지원하지 않습니다.');
    error.code = 'QA_GAME_LAUNCH_DISABLED';
    throw error;
  }
  if (operationInProgress) throw new Error('다른 작업이 진행 중입니다.');
  if (gameRunning) throw new Error('Minecraft가 이미 실행 중입니다.');
  operationInProgress = true;
  try {
    const session = await authService.acquireMinecraftSession({ interactive: true });
    await syncSessionSkin(session);
    await prepareClientInternal();
    const saved = await readJson(paths.config, { memoryMb: 8192 });
    const result = await minecraftService.launchGame(session, Number(saved.memoryMb) || 8192);
    gameRunning = true;
    progress('게임 실행 완료', 100, `${activeProduct.server.name}으로 연결 중`);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return result;
  } finally {
    operationInProgress = false;
  }
}

async function login() {
  if (runtimeConfig.qaBypassMicrosoftLogin) {
    const error = new Error('이 빌드는 Microsoft 로그인을 생략하는 내부 QA 전용 버전입니다.');
    error.code = 'QA_AUTH_DISABLED';
    throw error;
  }
  if (operationInProgress) throw new Error('다른 작업이 진행 중입니다.');
  operationInProgress = true;
  try {
    progress('Microsoft 로그인', 1, '브라우저에서 표시된 코드를 입력해 주세요.');
    const authResult = await authService.login();
    await syncSessionSkin(authResult);
    progress('계정 확인 완료', 100, 'Minecraft: Java Edition 소유권을 확인했습니다.');
    const state = await getState();
    emit('launcher:auth-stage', {
      stage: 'minecraft-complete',
      username: state.auth.minecraftName,
      message: 'Microsoft 및 Minecraft 인증이 모두 완료되었습니다.'
    });
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '인증 완료',
      message: '인증이 완료되었습니다.',
      detail: `${state.auth.minecraftName} 계정이 연결되었습니다.\n계정 상태를 새로 적용하려면 런처를 재시작할 수 있습니다.`,
      buttons: ['계속 사용', '런처 재시작'],
      defaultId: 1,
      cancelId: 0,
      noLink: true
    });
    if (result.response === 1) {
      app.relaunch();
      app.exit(0);
    }
    return state;
  } catch (error) {
    throw await reportAuthenticationError(error);
  } finally {
    operationInProgress = false;
  }
}

async function resumeCachedAuthentication() {
  if (runtimeConfig.qaBypassMicrosoftLogin) return;
  const status = await authService.getStatus();
  if (!status.microsoftSignedIn) return;
  if (status.minecraftReady) {
    const cachedSkin = status.minecraftId
      ? await skinService.getDataUrl(status.minecraftId)
      : '';
    if (!cachedSkin && status.skinAvailable) {
      const storedProfile = await authService.getStoredProfile();
      if (storedProfile?.skin?.url) {
        progress('Minecraft 스킨 복구', 84, '공식 프로필에서 스킨을 다시 불러옵니다.');
        const refreshedSkin = await syncSessionSkin({ profile: storedProfile });
        emit('launcher:state-changed', await getState());
        if (refreshedSkin) {
          progress('Minecraft 스킨 확인 완료', 100, `${status.minecraftName} 스킨을 적용했습니다.`);
        }
      }
    }
    return;
  }
  progress('Minecraft 계정 확인', 62, '저장된 Microsoft 인증으로 연결을 다시 확인합니다.');
  try {
    const session = await authService.acquireMinecraftSession({ interactive: false });
    await syncSessionSkin(session);
    const state = await getState();
    emit('launcher:state-changed', state);
    progress('계정 확인 완료', 100, `${state.auth.minecraftName} 계정이 연결되었습니다.`);
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '인증 완료',
      message: '인증이 완료되었습니다.',
      detail: `${state.auth.minecraftName} 계정이 정상적으로 연결되었습니다.`,
      buttons: ['확인'],
      defaultId: 0,
      noLink: true
    });
  } catch (error) {
    const friendly = describeAuthenticationError(error);
    log(friendly, 'warning');
    emit('launcher:state-changed', await getState());
  }
}

async function setMemory(memoryMb) {
  const allowed = [6144, 8192, 10240, 12288];
  const value = Number(memoryMb);
  if (!allowed.includes(value)) throw new Error('지원하지 않는 메모리 설정입니다.');
  const state = await readJson(paths.config, {});
  state.memoryMb = value;
  await writeJsonAtomic(paths.config, state);
  return getState();
}

async function repair() {
  if (operationInProgress) throw new Error('다른 작업이 진행 중입니다.');
  operationInProgress = true;
  try {
    const qaMode = Boolean(runtimeConfig.qaBypassMicrosoftLogin);
    await prepareClientInternal({
      repair: true,
      allowIncompleteDistribution: qaMode
    });
    const loaderName = activeProduct.minecraft.loader === 'vanilla' ? 'Vanilla' : activeProduct.minecraft.loader === 'fabric' ? 'Fabric' : 'Forge';
    progress(
      qaMode ? 'QA 재검사 완료' : '복구 완료',
      100,
      qaMode
        ? '로그인 없이 확인 가능한 기본 파일과 서버 목록을 다시 검사했습니다.'
        : `Minecraft·${loaderName} 기본 파일을 모두 다시 검증했습니다.`
    );
    return getState();
  } catch (error) {
    throw await reportInstallationError('클라이언트 재검사', error);
  } finally {
    operationInProgress = false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#07080b',
    title: PRODUCT.name,
    icon: path.join(__dirname, '..', 'assets', 'logo.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#07080b',
      symbolColor: '#f8f5ef',
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.once('did-finish-load', () => {
    syncModeUpdates({ automatic: true })
      .then((state) => emit('launcher:state-changed', state))
      .catch((error) => log(`자동 모드 업데이트 확인 실패: ${error.message}`, 'warning'));
    resumeCachedAuthentication().catch((error) => {
      log(`저장된 계정 확인 실패: ${error.message}`, 'warning');
    });
    if (runtimeConfig.autoUpdateEnabled !== false) {
      launcherUpdateService.check()
        .then(() => getState())
        .then((state) => emit('launcher:state-changed', state))
        .catch((error) => log(`런처 업데이트 확인 실패: ${error.message}`, 'warning'));
    }
  });
}

async function initializeMainApplication() {
  if (smokeTest) {
    process.stdout.write('Fire Crew Launcher packaged dependency smoke test passed.\n');
    app.quit();
    return;
  }
  if (app.isPackaged && !isApprovedInstallPath()) {
    await dialog.showMessageBox({
      type: 'warning',
      title: '불꽃단 런처 설치 필요',
      message: '불꽃단 런처는 공식 설치 프로그램으로 설치해야 합니다.',
      detail: `보호된 설치 경로: ${expectedInstallRoot()}\nGitHub 릴리즈의 Setup EXE를 실행해 주세요.`,
      buttons: ['확인'],
      defaultId: 0,
      noLink: true
    });
    app.quit();
    return;
  }
  await ensureDirectories();
  runtimeConfig = await loadRuntimeConfig(app.getAppPath(), paths.root);
  const catalogProfiles = await loadLaunchProfileCatalog();
  launchProfiles = createLaunchProfiles({ ...runtimeConfig, profiles: catalogProfiles });
  const savedLauncherState = await readJson(paths.config, {});
  activeProfile = launchProfiles.find((profile) => profile.id === savedLauncherState.activeProfileId)
    || launchProfiles[0];
  activeProduct = productForProfile(activeProfile);
  createServices();
  await authService.initialize();

  ipcMain.handle('launcher:get-state', getState);
  ipcMain.handle('launcher:get-soop-posts', getSoopPosts);
  ipcMain.handle('launcher:get-server-status', () => queryMinecraftServer(activeProduct.server));
  ipcMain.handle('launcher:select-profile', (_event, profileId) => selectProfile(profileId));
  ipcMain.handle('launcher:login', login);
  ipcMain.handle('launcher:logout', async () => {
    const status = await authService.getStatus();
    await authService.logout();
    await skinService.remove(status.minecraftId);
    return getState();
  });
  ipcMain.handle('launcher:install', () => install());
  ipcMain.handle('launcher:launch', launchGame);
  ipcMain.handle('launcher:check-updates', checkLauncherUpdate);
  ipcMain.handle('launcher:check-mode-updates', () => syncModeUpdates());
  ipcMain.handle('launcher:install-update', installLauncherUpdate);
  ipcMain.handle('launcher:repair', async () => {
    const qaMode = Boolean(runtimeConfig.qaBypassMicrosoftLogin);
    const loaderName = activeProduct.minecraft.loader === 'vanilla' ? 'Vanilla' : activeProduct.minecraft.loader === 'fabric' ? 'Fabric' : 'Forge';
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: qaMode ? 'QA 클라이언트 재검사' : '클라이언트 복구',
      message: qaMode
        ? '로그인 없이 확인 가능한 설치 파일과 서버 목록을 다시 검사할까요?'
        : `Minecraft·${loaderName} 기본 파일을 모두 다시 검사할까요?`,
      detail: qaMode
        ? '실제 게임 실행은 하지 않으며 개인 월드와 스크린샷은 변경하지 않습니다.'
        : '개인 월드와 스크린샷은 유지하며 손상되거나 빠진 파일만 복구합니다.',
      buttons: ['취소', qaMode ? 'QA 재검사' : '검사 및 복구'],
      defaultId: 0,
      cancelId: 0
    });
    return result.response === 1 ? repair() : getState();
  });
  ipcMain.handle('launcher:set-memory', (_event, value) => setMemory(value));
  ipcMain.handle('launcher:open-folder', async () => shell.openPath(profilePaths.game));
  ipcMain.handle('launcher:open-report', async () => shell.openPath(paths.logs));
  ipcMain.handle('launcher:open-external', (_event, url) => openTrustedExternal(url));
  createWindow();
  cleanupUpdateHelpers(paths.root).catch(() => {});
}

app.whenReady().then(() => {
  if (updateJobFile) return runUpdateHelper({ app, BrowserWindow, jobFile: updateJobFile });
  return initializeMainApplication();
});

app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (error) => {
  log(error.message, 'error');
  if (mainWindow) dialog.showErrorBox('불꽃단 런처 오류', error.stack || error.message);
});
