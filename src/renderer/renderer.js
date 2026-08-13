'use strict';

const api = window.fireCrew;
const SOOP_STATION_URL = 'https://www.sooplive.com/station/ttobeherored';
const YOUTUBE_CHANNEL_URL = 'https://www.youtube.com/channel/UCmDSPI6hQNkuOa7VQEApAhQ';
const NEWS_REFRESH_INTERVAL_MS = 60 * 1000;
const NEWS_FOCUS_STALE_MS = 15 * 1000;
const SERVER_STATUS_INTERVAL_MS = 20 * 1000;
const BACKGROUND_INTERVAL_MS = 9 * 1000;

const elements = {
  primary: document.querySelector('#primaryButton'),
  primaryLabel: document.querySelector('.primary-label'),
  repair: document.querySelector('#repairButton'),
  folder: document.querySelector('#folderButton'),
  report: document.querySelector('#reportButton'),
  memory: document.querySelector('#memorySelect'),
  launcherBuildLabel: document.querySelector('#launcherBuildLabel'),
  statusDot: document.querySelector('#statusDot'),
  statusTitle: document.querySelector('#statusTitle'),
  statusDetail: document.querySelector('#statusDetail'),
  progressBar: document.querySelector('#progressBar'),
  progressText: document.querySelector('#progressText'),
  accountNote: document.querySelector('#accountNote'),
  accountDot: document.querySelector('#accountDot'),
  accountSkinHead: document.querySelector('#accountSkinHead'),
  accountProviderLabel: document.querySelector('#accountProviderLabel'),
  accountName: document.querySelector('#accountName'),
  mainSkinName: document.querySelector('#mainSkinName'),
  profileSkin: document.querySelector('#profileSkinCanvas'),
  skinModelLabel: document.querySelector('#skinModelLabel'),
  accountButton: document.querySelector('#accountButton'),
  updateCheck: document.querySelector('#updateCheckButton'),
  modeUpdateCheck: document.querySelector('#modeUpdateCheckButton'),
  launcherUpdateStatus: document.querySelector('#launcherUpdateStatus'),
  launcherUpdateVersion: document.querySelector('#launcherUpdateVersion'),
  launcherUpdateMessage: document.querySelector('#launcherUpdateMessage'),
  launcherUpdateProgress: document.querySelector('#launcherUpdateProgress'),
  modeUpdateStatus: document.querySelector('#modeUpdateStatus'),
  modeUpdateVersion: document.querySelector('#modeUpdateVersion'),
  modeUpdateMessage: document.querySelector('#modeUpdateMessage'),
  modeUpdateProgress: document.querySelector('#modeUpdateProgress'),
  station: document.querySelector('#stationButton'),
  stationText: document.querySelector('#stationTextButton'),
  youtube: document.querySelector('#youtubeButton'),
  newsList: document.querySelector('#newsList'),
  newsSource: document.querySelector('#newsSource'),
  newsRefresh: document.querySelector('#newsRefreshButton'),
  newsTabs: [...document.querySelectorAll('.news-tab')],
  heroSlides: [...document.querySelectorAll('.hero-slide')],
  serverPopulation: document.querySelector('.server-population'),
  serverPlayerCount: document.querySelector('#serverPlayerCount'),
  profileCarousel: document.querySelector('#profileCarousel'),
  profileSlide: document.querySelector('#profileSlide'),
  profilePrevious: document.querySelector('#profilePreviousButton'),
  profileNext: document.querySelector('#profileNextButton'),
  profilePosition: document.querySelector('#profilePosition'),
  profileName: document.querySelector('#profileName'),
  profileVersion: document.querySelector('#profileVersion'),
  profileMode: document.querySelector('#profileMode'),
  profileServer: document.querySelector('#profileServer'),
  settings: document.querySelector('#settingsPanel'),
  settingsOpen: document.querySelector('#settingsButton'),
  settingsClose: document.querySelector('#settingsCloseButton'),
  authPanel: document.querySelector('#authPanel'),
  authTitle: document.querySelector('#authTitle'),
  authDescription: document.querySelector('#authDescription'),
  authCode: document.querySelector('#authCode'),
  authMessage: document.querySelector('#authMessage'),
  authClose: document.querySelector('#authCloseButton')
};

let state = null;
let busy = false;
let newsLoading = false;
let lastNewsLoadedAt = 0;
let renderedSkinKey = '';
let activeNewsCategory = 'notice';
let allNewsPosts = [];
let activeBackgroundIndex = 0;

function preparePixelCanvas(canvas) {
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  return context;
}

function drawSkinFallback() {
  const head = preparePixelCanvas(elements.accountSkinHead);
  const headGradient = head.createLinearGradient(0, 0, 32, 32);
  headGradient.addColorStop(0, '#ffd84b');
  headGradient.addColorStop(0.48, '#f23a36');
  headGradient.addColorStop(1, '#73121c');
  head.fillStyle = headGradient;
  head.fillRect(0, 0, 32, 32);
  head.fillStyle = '#fff9e8';
  head.font = '900 15px Arial';
  head.textAlign = 'center';
  head.textBaseline = 'middle';
  head.fillText('FC', 16, 17);

  const profile = preparePixelCanvas(elements.profileSkin);
  const glow = profile.createLinearGradient(32, 8, 160, 260);
  glow.addColorStop(0, 'rgba(255,216,75,0.92)');
  glow.addColorStop(0.48, 'rgba(242,58,54,0.88)');
  glow.addColorStop(1, 'rgba(71,15,31,0.88)');
  profile.fillStyle = glow;
  profile.fillRect(64, 7, 64, 64);
  profile.fillRect(64, 71, 64, 96);
  profile.fillRect(32, 72, 32, 96);
  profile.fillRect(128, 72, 32, 96);
  profile.fillRect(64, 167, 32, 96);
  profile.fillRect(96, 167, 32, 96);
  profile.fillStyle = 'rgba(255,255,255,0.2)';
  profile.fillRect(76, 27, 10, 7);
  profile.fillRect(106, 27, 10, 7);
  profile.fillStyle = '#fff9e8';
  profile.font = '900 25px Arial';
  profile.textAlign = 'center';
  profile.textBaseline = 'middle';
  profile.fillText('FC', 96, 119);
}

function drawSkinImage(image, variant) {
  const head = preparePixelCanvas(elements.accountSkinHead);
  head.drawImage(image, 8, 8, 8, 8, 0, 0, 32, 32);
  head.drawImage(image, 40, 8, 8, 8, 0, 0, 32, 32);

  const profile = preparePixelCanvas(elements.profileSkin);
  const slim = variant === 'SLIM';
  const armSourceWidth = slim ? 3 : 4;
  const armWidth = slim ? 24 : 32;
  const bodyX = 64;
  const bodyY = 71;
  const bodyWidth = 64;
  const bodyHeight = 96;
  const leftArmX = bodyX - armWidth;
  const rightArmX = bodyX + bodyWidth;
  const legacy = image.naturalHeight === 32 || image.height === 32;

  profile.drawImage(image, 44, 20, armSourceWidth, 12, leftArmX, bodyY, armWidth, bodyHeight);
  profile.drawImage(
    image,
    legacy ? 44 : 36,
    legacy ? 20 : 52,
    armSourceWidth,
    12,
    rightArmX,
    bodyY,
    armWidth,
    bodyHeight
  );
  profile.drawImage(image, 20, 20, 8, 12, bodyX, bodyY, bodyWidth, bodyHeight);
  if (!legacy) {
    profile.drawImage(image, 44, 36, armSourceWidth, 12, leftArmX, bodyY, armWidth, bodyHeight);
    profile.drawImage(image, 52, 52, armSourceWidth, 12, rightArmX, bodyY, armWidth, bodyHeight);
    profile.drawImage(image, 20, 36, 8, 12, bodyX, bodyY, bodyWidth, bodyHeight);
  }
  profile.drawImage(image, 4, 20, 4, 12, bodyX, bodyY + bodyHeight, 32, 96);
  profile.drawImage(image, legacy ? 4 : 20, legacy ? 20 : 52, 4, 12, bodyX + 32, bodyY + bodyHeight, 32, 96);
  if (!legacy) {
    profile.drawImage(image, 4, 36, 4, 12, bodyX, bodyY + bodyHeight, 32, 96);
    profile.drawImage(image, 4, 52, 4, 12, bodyX + 32, bodyY + bodyHeight, 32, 96);
  }
  profile.drawImage(image, 8, 8, 8, 8, 64, 7, 64, 64);
  profile.drawImage(image, 40, 8, 8, 8, 62, 5, 68, 68);
}

function renderSkin(auth = {}) {
  const dataUrl = auth.skinDataUrl || '';
  const variant = auth.skinVariant === 'SLIM' ? 'SLIM' : 'CLASSIC';
  const key = `${auth.minecraftId || ''}|${variant}|${dataUrl.length}|${dataUrl.slice(-24)}`;
  elements.skinModelLabel.textContent = auth.minecraftReady
    ? (variant === 'SLIM' ? 'SLIM MODEL' : 'CLASSIC MODEL')
    : 'PLAYER';
  if (key === renderedSkinKey) return;
  renderedSkinKey = key;
  if (!dataUrl) {
    drawSkinFallback();
    return;
  }
  const image = new Image();
  image.onload = () => drawSkinImage(image, variant);
  image.onerror = drawSkinFallback;
  image.src = dataUrl;
}

function setSettingsOpen(open) {
  elements.settings.setAttribute('aria-hidden', String(!open));
  elements.settingsOpen.setAttribute('aria-expanded', String(open));
}

function setAuthOpen(open) {
  elements.authPanel.setAttribute('aria-hidden', String(!open));
}

function hasBlockingConfiguration(nextState) {
  if (nextState?.qaMode) return false;
  return (nextState?.configurationIssues || []).some((issue) =>
    issue.id === 'microsoft-client-id' || issue.id === 'distribution'
  );
}

function setBusy(value) {
  busy = value;
  const blocked = hasBlockingConfiguration(state);
  elements.primary.disabled = value || blocked || state?.gameRunning;
  elements.repair.disabled = value || (!state?.qaMode && !state?.installed && !state?.legacyImportAvailable);
  elements.memory.disabled = value;
  elements.accountButton.disabled = value || state?.qaMode;
  const updateState = state?.launcherUpdate?.state;
  elements.updateCheck.disabled = value || ['checking', 'downloading', 'preparing', 'ready'].includes(updateState);
  const modeState = state?.modeUpdate?.state;
  elements.modeUpdateCheck.disabled = value || ['checking', 'updating'].includes(modeState);
  const profileLocked = value || Boolean(state?.gameRunning) || (state?.profiles?.length || 0) < 2;
  elements.profilePrevious.disabled = profileLocked;
  elements.profileNext.disabled = profileLocked;
  elements.statusDot.className = `status-dot ${value ? 'busy' : (state?.installed ? 'ready' : '')}`;
}

function renderProfile(nextState, direction = 0) {
  const profiles = Array.isArray(nextState.profiles) ? nextState.profiles : [];
  const index = Math.max(0, profiles.findIndex((profile) => profile.id === nextState.activeProfileId));
  const profile = profiles[index] || {
    name: nextState.product.server.name,
    server: nextState.product.server,
    minecraft: nextState.product.minecraft,
    pack: nextState.product.pack
  };
  elements.profilePosition.textContent = `PROFILE ${String(index + 1).padStart(2, '0')} / ${String(Math.max(1, profiles.length)).padStart(2, '0')}`;
  elements.profileName.textContent = profile.name;
  elements.profileVersion.textContent = `MC ${profile.minecraft.version}`;
  const loader = String(profile.minecraft.loader || (profile.minecraft.forgeVersion ? 'forge' : 'vanilla')).toUpperCase();
  elements.profileMode.textContent = profile.pack.name || `${loader} ${profile.minecraft.loaderVersion || profile.minecraft.forgeVersion || ''}`.trim();
  elements.profileServer.textContent = profile.server.address;
  elements.profileCarousel.title = profile.description || profile.pack.name || profile.name;
  elements.profileSlide.classList.remove('slide-from-left', 'slide-from-right');
  if (direction) {
    void elements.profileSlide.offsetWidth;
    elements.profileSlide.classList.add(direction > 0 ? 'slide-from-right' : 'slide-from-left');
  }
  const locked = busy || nextState.gameRunning || profiles.length < 2;
  elements.profilePrevious.disabled = locked;
  elements.profileNext.disabled = locked;
}

function renderLauncherUpdate(update = {}) {
  const updateState = update.state || 'disabled';
  elements.launcherUpdateStatus.dataset.state = updateState;
  elements.launcherUpdateVersion.textContent = update.latestVersion
    ? `현재 ${update.currentVersion} · 최신 ${update.latestVersion}`
    : `현재 ${update.currentVersion || '확인 중'}`;
  elements.launcherUpdateMessage.textContent = update.message || '업데이트 정보를 확인할 수 없습니다.';
  elements.launcherUpdateProgress.style.width = `${Math.max(0, Math.min(100, Number(update.progress) || 0))}%`;
  if (update.available) {
    elements.updateCheck.textContent = `${update.latestVersion} 다운로드 후 재시작`;
  } else if (updateState === 'checking') {
    elements.updateCheck.textContent = '업데이트 확인 중...';
  } else if (updateState === 'downloading' || updateState === 'preparing') {
    elements.updateCheck.textContent = `업데이트 준비 중 · ${Number(update.progress) || 0}%`;
  } else if (updateState === 'ready') {
    elements.updateCheck.textContent = '재시작 준비 중...';
  } else {
    elements.updateCheck.textContent = '런처 업데이트 확인';
  }
  elements.updateCheck.disabled = busy
    || !update.configured
    || ['checking', 'downloading', 'preparing', 'ready'].includes(updateState);
}

function renderModeUpdate(update = {}) {
  const updateState = update.state || 'idle';
  elements.modeUpdateStatus.dataset.state = updateState;
  elements.modeUpdateVersion.textContent = update.latestVersion
    ? `설치 ${update.currentVersion || '없음'} · 목록 ${update.latestVersion}`
    : '모드 목록 확인 전';
  elements.modeUpdateMessage.textContent = update.message || 'GitHub의 서명된 모드 목록을 확인합니다.';
  elements.modeUpdateProgress.style.width = `${Math.max(0, Math.min(100, Number(update.progress) || 0))}%`;
  if (updateState === 'checking') {
    elements.modeUpdateCheck.textContent = '모드 목록 확인 중...';
  } else if (updateState === 'updating') {
    elements.modeUpdateCheck.textContent = `모드 갱신 중 · ${Number(update.progress) || 0}%`;
  } else if (update.available) {
    elements.modeUpdateCheck.textContent = `${Number(update.changedFiles) || 0}개 모드 갱신`;
  } else {
    elements.modeUpdateCheck.textContent = '모드 업데이트 확인';
  }
  elements.modeUpdateCheck.disabled = busy
    || !update.configured
    || ['checking', 'updating'].includes(updateState);
}

function renderAccount(nextState) {
  const auth = nextState.auth || {};
  if (nextState.qaMode) {
    elements.accountProviderLabel.textContent = 'INTERNAL TEST MODE';
    elements.accountName.textContent = 'LOGIN-FREE QA';
    elements.mainSkinName.textContent = 'LOGIN-FREE QA';
    elements.accountDot.className = 'account-dot pending';
    elements.accountButton.textContent = 'QA 모드 · 로그인 사용 안 함';
    elements.accountButton.disabled = true;
    renderSkin({});
    elements.skinModelLabel.textContent = 'QA MODE';
    return;
  }
  elements.accountProviderLabel.textContent = 'MICROSOFT · MINECRAFT';
  const microsoftSignedIn = Boolean(auth.microsoftSignedIn || auth.signedIn);
  const minecraftReady = Boolean(auth.minecraftReady || auth.signedIn);
  const displayName = auth.minecraftName || auth.microsoftName || '로그인 필요';
  elements.accountName.textContent = displayName;
  elements.mainSkinName.textContent = minecraftReady
    ? displayName
    : (microsoftSignedIn ? 'MINECRAFT 확인 필요' : '로그인 필요');
  elements.accountDot.className = `account-dot ${minecraftReady ? 'ready' : (microsoftSignedIn ? 'pending' : '')}`;
  elements.accountButton.textContent = minecraftReady
    ? 'Microsoft 로그아웃'
    : (microsoftSignedIn ? 'Minecraft 연결 재시도' : 'Microsoft 로그인');
  renderSkin(auth);
}

function render(nextState) {
  state = nextState;
  const loaderName = state.product.minecraft.loader === 'vanilla' ? 'Vanilla' : state.product.minecraft.loader === 'fabric' ? 'Fabric' : 'Forge';
  elements.memory.value = String(state.memoryMb || 8192);
  elements.launcherBuildLabel.textContent = `Fire Crew Launcher · ${state.product.version} · MC ${state.product.minecraft.version}`;
  renderProfile(state);
  renderAccount(state);
  renderLauncherUpdate(state.launcherUpdate);
  renderModeUpdate(state.modeUpdate);
  const blocking = hasBlockingConfiguration(state);
  elements.primary.disabled = busy || blocking || state.gameRunning;
  elements.repair.disabled = busy || (!state.qaMode && !state.installed && !state.legacyImportAvailable);

  if (state.qaMode) {
    const baseReady = Boolean(state.base?.ready);
    elements.statusDot.className = `status-dot ${baseReady ? 'ready' : ''}`;
    elements.statusTitle.textContent = baseReady
      ? '로그인 없는 QA 준비 완료'
      : '로그인 없는 내부 테스트 모드';
    elements.statusDetail.textContent = 'QA MODE';
    elements.progressBar.style.width = baseReady ? '78%' : '0%';
    elements.progressText.textContent = state.installed
      ? '클라이언트 파일·패치·서버 목록까지 확인할 수 있습니다.'
      : 'Microsoft 인증 없이 Java·Minecraft·패치 설치 흐름을 확인합니다.';
    elements.primaryLabel.textContent = baseReady ? '파일 다시 검사' : '클라이언트 준비';
    elements.accountNote.textContent = '실제 게임 실행과 서버 접속은 정식 인증 빌드에서만 가능합니다.';
  } else if (blocking) {
    const issue = state.configurationIssues.find((entry) =>
      entry.id === 'microsoft-client-id' || entry.id === 'distribution'
    );
    elements.statusDot.className = 'status-dot error';
    elements.statusTitle.textContent = '관리자 설정이 필요합니다';
    elements.statusDetail.textContent = 'SETUP';
    elements.progressBar.style.width = '0%';
    elements.progressText.textContent = issue?.message || '배포 설정을 확인해 주세요.';
    elements.primaryLabel.textContent = '설정 확인 필요';
    elements.accountNote.textContent = '공개 배포용 인증·패치 설정이 완료되어야 실행할 수 있습니다.';
  } else if (!state.auth?.signedIn) {
    elements.statusDot.className = 'status-dot';
    elements.statusTitle.textContent = 'Microsoft 로그인이 필요합니다';
    elements.statusDetail.textContent = 'SECURE';
    elements.progressBar.style.width = '0%';
    elements.progressText.textContent = '정품 Minecraft 계정을 한 번만 연결해 주세요.';
    elements.primaryLabel.textContent = '로그인하고 시작';
    elements.accountNote.textContent = '비밀번호는 런처가 받지 않으며 Microsoft 브라우저에서만 입력합니다.';
  } else if (state.gameRunning) {
    elements.statusDot.className = 'status-dot ready';
    elements.statusTitle.textContent = 'Minecraft 실행 중';
    elements.statusDetail.textContent = 'ONLINE';
    elements.progressBar.style.width = '100%';
    elements.progressText.textContent = '게임 종료 후 다시 실행할 수 있습니다.';
    elements.primaryLabel.textContent = '게임 실행 중';
    elements.accountNote.textContent = `${state.auth.minecraftName || 'Minecraft 계정'}으로 접속했습니다.`;
  } else if (state.updateAvailable) {
    elements.statusDot.className = 'status-dot busy';
    elements.statusTitle.textContent = '새 패치가 준비되었습니다';
    elements.statusDetail.textContent = `${state.patch.changedFiles} FILES`;
    elements.progressBar.style.width = '72%';
    elements.progressText.textContent = '게임 시작 시 변경된 파일만 자동으로 적용합니다.';
    elements.primaryLabel.textContent = '업데이트 후 접속';
    elements.accountNote.textContent = `${state.auth.minecraftName || 'Minecraft 계정'} · 서버 자동 접속`;
  } else if (state.installed) {
    elements.statusDot.className = 'status-dot ready';
    elements.statusTitle.textContent = '플레이 준비 완료';
    elements.statusDetail.textContent = 'BASE READY';
    elements.progressBar.style.width = '100%';
    elements.progressText.textContent = `Minecraft·${loaderName} 기본 파일과 서버 등록이 완료되었습니다.`;
    elements.primaryLabel.textContent = '게임 시작';
    elements.accountNote.textContent = `${state.auth.minecraftName || 'Minecraft 계정'} · 서버 자동 접속`;
  } else {
    elements.statusDot.className = 'status-dot';
    elements.statusTitle.textContent = state.legacyImportAvailable
      ? '기존 클라이언트를 가져올 수 있습니다'
      : '첫 설치가 필요합니다';
    elements.statusDetail.textContent = 'ONE-TIME';
    elements.progressBar.style.width = '0%';
    elements.progressText.textContent = state.legacyImportAvailable
      ? 'Prism의 기존 파일을 보존한 채 독립형 폴더로 복사합니다.'
      : `Minecraft·${loaderName} 기본 파일을 런처 내부에서 자동으로 준비합니다.`;
    elements.primaryLabel.textContent = '설치하고 바로 접속';
    elements.accountNote.textContent = `설치가 끝나면 ${state.product.server.name}로 자동 접속합니다.`;
  }
}

function showError(error) {
  const message = String(error?.message || error)
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .trim();
  elements.statusDot.className = 'status-dot error';
  elements.statusTitle.textContent = '작업을 완료하지 못했습니다';
  elements.statusDetail.textContent = 'ERROR';
  elements.progressText.textContent = message;
  elements.progressText.title = message;
}

function formatPostDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[2]}.${match[3]}` : '';
}

function formatFeedTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function createNewsItem(post) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'news-item';
  item.setAttribute('aria-label', `${post.title} 글 열기`);

  const board = document.createElement('span');
  board.className = 'news-board';
  board.textContent = post.board || '방송국';

  const copy = document.createElement('span');
  copy.className = 'news-copy';
  const title = document.createElement('span');
  title.className = 'news-title';
  title.textContent = post.title;
  const meta = document.createElement('span');
  meta.className = 'news-meta';
  meta.textContent = [post.author, formatPostDate(post.publishedAt)].filter(Boolean).join(' · ');
  copy.append(title, meta);

  const arrow = document.createElement('span');
  arrow.className = 'news-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '›';

  item.append(board, copy, arrow);
  item.addEventListener('click', () => api.openExternal(post.url));
  return item;
}

function renderNewsPosts() {
  const posts = allNewsPosts
    .filter((post) => post.category === activeNewsCategory)
    .slice(0, 3);
  elements.newsList.replaceChildren();
  if (posts.length) {
    posts.forEach((post) => elements.newsList.append(createNewsItem(post)));
    return;
  }
  const empty = document.createElement('div');
  empty.className = 'news-empty';
  empty.textContent = activeNewsCategory === 'notice'
    ? '표시할 공지 글이 없습니다.'
    : '표시할 비밀기지 글이 없습니다.';
  elements.newsList.append(empty);
}

async function loadNews() {
  if (newsLoading) return;
  newsLoading = true;
  elements.newsRefresh.disabled = true;
  elements.newsRefresh.classList.add('loading');
  try {
    const feed = await api.getSoopPosts();
    lastNewsLoadedAt = Date.now();
    if (feed.posts.length) {
      allNewsPosts = feed.posts;
      renderNewsPosts();
      const fetchedAt = formatFeedTime(feed.fetchedAt);
      elements.newsSource.textContent = feed.source === 'cache'
        ? `저장된 최신 소식${fetchedAt ? ` · ${fetchedAt}` : ''}`
        : `SOOP 실시간${fetchedAt ? ` · ${fetchedAt} 갱신` : ''}`;
    } else {
      allNewsPosts = [];
      elements.newsList.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'news-empty';
      empty.textContent = '최신 소식을 불러오지 못했습니다.\n방송국에서 직접 확인해 주세요.';
      elements.newsList.append(empty);
      elements.newsSource.textContent = 'SOOP 연결 대기 중';
    }
  } catch {
    allNewsPosts = [];
    elements.newsList.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'news-empty';
    empty.textContent = '최신 소식을 불러오지 못했습니다.';
    elements.newsList.append(empty);
    elements.newsSource.textContent = 'SOOP 연결 대기 중';
  } finally {
    newsLoading = false;
    elements.newsRefresh.disabled = false;
    elements.newsRefresh.classList.remove('loading');
  }
}

async function refreshServerStatus() {
  try {
    const result = await api.getServerStatus();
    elements.serverPopulation.classList.toggle('offline', !result.online);
    elements.serverPlayerCount.textContent = result.online
      ? `${result.playersOnline} / ${result.playersMax}`
      : 'OFFLINE';
    elements.serverPopulation.title = result.online && result.sample?.length
      ? result.sample.map((player) => player.name).join(', ')
      : (result.error || '서버 상태를 확인할 수 없습니다.');
  } catch (error) {
    elements.serverPopulation.classList.add('offline');
    elements.serverPlayerCount.textContent = '확인 불가';
    elements.serverPopulation.title = String(error?.message || error);
  }
}

function showNextBackground() {
  if (elements.heroSlides.length < 2) return;
  elements.heroSlides[activeBackgroundIndex].classList.remove('active');
  activeBackgroundIndex = (activeBackgroundIndex + 1) % elements.heroSlides.length;
  elements.heroSlides[activeBackgroundIndex].classList.add('active');
}

function refreshNewsWhenActive() {
  if (document.visibilityState === 'hidden') return;
  if (Date.now() - lastNewsLoadedAt >= NEWS_FOCUS_STALE_MS) loadNews();
}

async function refreshState() {
  state = await api.getState();
  render(state);
}

async function moveProfile(direction) {
  const profiles = Array.isArray(state?.profiles) ? state.profiles : [];
  if (busy || state?.gameRunning || profiles.length < 2) return;
  const currentIndex = Math.max(0, profiles.findIndex((profile) => profile.id === state.activeProfileId));
  const nextIndex = (currentIndex + direction + profiles.length) % profiles.length;
  setBusy(true);
  try {
    const nextState = await api.selectProfile(profiles[nextIndex].id);
    render(nextState);
    renderProfile(nextState, direction);
    await refreshServerStatus();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

elements.profilePrevious.addEventListener('click', () => moveProfile(-1));
elements.profileNext.addEventListener('click', () => moveProfile(1));

elements.primary.addEventListener('click', async () => {
  setBusy(true);
  try {
    if (state?.qaMode) {
      elements.statusTitle.textContent = 'QA 클라이언트 검사 중...';
      elements.progressText.textContent = '로그인 없이 기본 설치·패치·서버 목록을 확인합니다.';
      state = await api.install();
      render(state);
      return;
    }
    if (!state?.auth?.signedIn) {
      state = await api.login();
      setAuthOpen(false);
      render(state);
    }
    elements.statusTitle.textContent = state?.installed ? '업데이트 확인 중...' : '클라이언트 준비 중...';
    elements.progressText.textContent = '필요한 파일만 확인한 뒤 서버로 바로 연결합니다.';
    await api.launch();
    await refreshState();
  } catch (error) {
    setAuthOpen(false);
    showError(error);
  } finally {
    setBusy(false);
  }
});

elements.repair.addEventListener('click', async () => {
  setBusy(true);
  try {
    state = await api.repair();
    render(state);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

elements.memory.addEventListener('change', async () => {
  try {
    state = await api.setMemory(Number(elements.memory.value));
    render(state);
  } catch (error) {
    showError(error);
  }
});

elements.accountButton.addEventListener('click', async () => {
  if (state?.qaMode) return;
  setBusy(true);
  try {
    if (state?.auth?.signedIn) {
      state = await api.logout();
    } else {
      state = await api.login();
      setAuthOpen(false);
    }
    render(state);
  } catch (error) {
    setAuthOpen(false);
    showError(error);
  } finally {
    setBusy(false);
  }
});

elements.updateCheck.addEventListener('click', async () => {
  setBusy(true);
  try {
    if (state?.launcherUpdate?.available) {
      await api.installLauncherUpdate();
    } else {
      state = await api.checkUpdates();
      render(state);
    }
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

elements.modeUpdateCheck.addEventListener('click', async () => {
  setBusy(true);
  try {
    state = await api.checkModeUpdates();
    render(state);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

elements.folder.addEventListener('click', () => api.openFolder());
elements.report.addEventListener('click', () => api.openReport());
elements.station.addEventListener('click', () => api.openExternal(SOOP_STATION_URL));
elements.stationText.addEventListener('click', () => api.openExternal(SOOP_STATION_URL));
elements.youtube.addEventListener('click', () => api.openExternal(YOUTUBE_CHANNEL_URL));
elements.newsRefresh.addEventListener('click', loadNews);
elements.newsTabs.forEach((tab) => tab.addEventListener('click', () => {
  activeNewsCategory = tab.dataset.category || 'notice';
  elements.newsTabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
  });
  renderNewsPosts();
}));
window.addEventListener('focus', refreshNewsWhenActive);
document.addEventListener('visibilitychange', refreshNewsWhenActive);
elements.settingsOpen.addEventListener('click', (event) => {
  event.stopPropagation();
  setSettingsOpen(elements.settings.getAttribute('aria-hidden') === 'true');
});
elements.settingsClose.addEventListener('click', () => setSettingsOpen(false));
elements.settings.addEventListener('click', (event) => event.stopPropagation());
elements.authClose.addEventListener('click', () => setAuthOpen(false));
document.addEventListener('click', () => setSettingsOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setSettingsOpen(false);
    setAuthOpen(false);
  }
});

api.onProgress(({ stage, percent, detail }) => {
  elements.statusDot.className = 'status-dot busy';
  elements.statusTitle.textContent = stage;
  elements.statusDetail.textContent = `${percent}%`;
  elements.progressBar.style.width = `${percent}%`;
  elements.progressText.textContent = detail || '작업 중...';
});

api.onLog(({ message, level }) => {
  elements.progressText.textContent = message;
  if (level === 'error') elements.statusDot.className = 'status-dot error';
});

api.onAuthCode(({ userCode, message }) => {
  elements.authTitle.innerHTML = '브라우저에서<br>로그인을 완료해 주세요.';
  elements.authDescription.textContent = '아래 코드를 Microsoft 로그인 페이지에 입력하면 런처로 자동 복귀합니다.';
  elements.authCode.textContent = userCode || '---- ----';
  elements.authMessage.textContent = message || '브라우저에서 Microsoft 로그인을 완료해 주세요.';
  setAuthOpen(true);
});

api.onAuthStage(({ stage, username, message }) => {
  if (stage === 'microsoft-complete') {
    elements.authTitle.innerHTML = 'Microsoft 인증이<br>완료되었습니다.';
    elements.authDescription.textContent = '이제 Minecraft 계정과 Java Edition 소유권을 확인합니다.';
    elements.authCode.textContent = 'CHECK';
    elements.authMessage.textContent = message || `${username || 'Microsoft 계정'} 연결 확인 중`;
    setAuthOpen(true);
  } else if (stage === 'minecraft-complete') {
    elements.authTitle.innerHTML = '전체 인증이<br>완료되었습니다.';
    elements.authDescription.textContent = `${username || 'Minecraft 계정'}으로 게임을 시작할 수 있습니다.`;
    elements.authCode.textContent = 'READY';
    elements.authMessage.textContent = message || '런처 계정 연결 완료';
  }
});

api.onStateChanged((nextState) => {
  render(nextState);
});

api.onUpdateStatus?.((update) => {
  if (state) state.launcherUpdate = update;
  renderLauncherUpdate(update);
});

api.onModeUpdateStatus?.((update) => {
  if (state) state.modeUpdate = { ...(state.modeUpdate || {}), ...update };
  renderModeUpdate(update);
});

api.onSkinUpdated?.(({ profileId, dataUrl, variant }) => {
  if (!state?.auth || state.auth.minecraftId !== profileId) return;
  state.auth.skinDataUrl = dataUrl;
  state.auth.skinVariant = variant;
  renderSkin(state.auth);
});

api.onGameExit(() => {
  refreshState().catch(showError);
});

api.getState()
  .then(render)
  .catch(showError)
  .finally(() => {
    elements.primary.disabled = !state || hasBlockingConfiguration(state) || state.gameRunning;
  });

loadNews();
refreshServerStatus();
setInterval(loadNews, NEWS_REFRESH_INTERVAL_MS);
setInterval(refreshServerStatus, SERVER_STATUS_INTERVAL_MS);
setInterval(showNextBackground, BACKGROUND_INTERVAL_MS);
