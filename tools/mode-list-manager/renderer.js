'use strict';

const api = window.modeManager;
const list = document.querySelector('#modeList');
const template = document.querySelector('#modeTemplate');
const archiveList = document.querySelector('#archiveList');
const archiveTemplate = document.querySelector('#archiveTemplate');
const status = document.querySelector('#status');
let profiles = [];
let activeProfileIndex = 0;
const loaderVersions = Object.freeze({
  forge: ['65.0.9', '47.4.0', '47.2.0', '43.4.0', '40.2.0', '36.2.42', '14.23.5.2860'],
  fabric: ['0.19.3', '0.18.6', '0.17.3', '0.16.14', '0.16.10', '0.15.11', '0.14.25'],
  vanilla: []
});

const profileFields = {
  id: '#profileId',
  name: '#profileName',
  description: '#profileDescription',
  serverName: '#serverName',
  serverAddress: '#serverAddress',
  serverPort: '#serverPort',
  minecraftVersion: '#minecraftVersion',
  loader: '#minecraftLoader',
  loaderVersion: '#loaderVersion',
  versionId: '#versionId',
  javaRuntimeTarget: '#javaRuntimeTarget',
  javaMajorVersion: '#javaMajorVersion',
  packId: '#packId',
  packName: '#packName',
  version: '#profileVersion'
};

function setStatus(message, kind = '') { status.textContent = message; status.dataset.kind = kind; }
function selectValue(selector, value) {
  const select = document.querySelector(selector);
  const normalized = String(value ?? '');
  if (normalized && ![...select.options].some((option) => option.value === normalized)) {
    select.add(new Option(normalized, normalized));
  }
  select.value = normalized;
}
function setBusy(value) {
  document.querySelectorAll('button').forEach((button) => { button.disabled = value; });
  if (!value) {
    document.querySelector('#removeProfileButton').disabled = profiles.length <= 1;
    document.querySelector('#curseforgeKeyRemoveButton').disabled = document.querySelector('#curseforgeKeyStatus').dataset.configured !== 'true';
  }
}

function addMode(entry = {}) {
  const card = template.content.firstElementChild.cloneNode(true);
  for (const field of card.querySelectorAll('[data-field]')) {
    const name = field.dataset.field;
    if (name === 'hash') field.value = entry.hash?.value || '';
    else if (name === 'algorithm') field.value = entry.hash?.algorithm || 'sha256';
    else field.value = entry[name] ?? '';
  }
  card.querySelector('[data-action="remove"]').addEventListener('click', () => card.remove());
  card.querySelector('[data-action="inspect"]').addEventListener('click', async () => {
    const url = card.querySelector('[data-field="url"]').value;
    try {
      setBusy(true); setStatus('파일을 내려받아 SHA-256을 계산하는 중...');
      const result = await api.inspect(url, {
        minecraftVersion: document.querySelector(profileFields.minecraftVersion).value,
        loader: document.querySelector(profileFields.loader).value
      });
      if (result.type === 'modpack') {
        applyPackProfile(result.profileUpdate);
        const existingCards = new Map([...list.querySelectorAll('.mode-card')]
          .filter((entry) => entry !== card)
          .map((entry) => [entry.querySelector('[data-field="path"]').value.trim().toLowerCase(), entry])
          .filter(([entryPath]) => Boolean(entryPath)));
        card.remove();
        let added = 0;
        for (const entry of result.files || []) {
          existingCards.get(String(entry.path || '').toLowerCase())?.remove();
          addMode(entry);
          added += 1;
        }
        const profile = profiles[activeProfileIndex];
        const archives = result.archives || (result.archive ? [result.archive] : []);
        profile.archives = [
          ...(profile.archives || []).filter((entry) => !result.archiveGroup || !entry.id?.startsWith(`${result.archiveGroup}-`)),
          ...archives
        ];
        renderArchives();
        const matched = result.compatibility ? ` · Minecraft ${result.compatibility.minecraftVersion} / ${result.compatibility.loader}` : '';
        setStatus(`${result.source}에서 ${added}개 파일과 오버라이드 설정을 가져왔습니다${matched}`, 'success');
        return;
      }
      card.querySelector('[data-field="size"]').value = result.size;
      card.querySelector('[data-field="algorithm"]').value = result.hash.algorithm;
      card.querySelector('[data-field="hash"]').value = result.hash.value;
      if (result.url) card.querySelector('[data-field="url"]').value = result.url;
      if (result.path) card.querySelector('[data-field="path"]').value = result.path;
      else if (!card.querySelector('[data-field="path"]').value) card.querySelector('[data-field="path"]').value = `mods/${decodeURIComponent(new URL(url).pathname.split('/').pop())}`;
      if (result.source) card.querySelector('[data-field="source"]').value = result.source;
      const matched = result.compatibility ? ` · Minecraft ${result.compatibility.minecraftVersion} / ${result.compatibility.loader} / ${result.compatibility.versionNumber}` : '';
      setStatus(`URL, 파일 크기, 해시 확인 완료${matched}`, 'success');
    } catch (error) { setStatus(error.message, 'error'); } finally { setBusy(false); }
  });
  list.append(card);
}

function renderArchives() {
  const archives = profiles[activeProfileIndex]?.archives || [];
  archiveList.replaceChildren(...archives.map((entry) => {
    const card = archiveTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector('[data-field="id"]').textContent = entry.id || '모드팩 오버라이드';
    card.querySelector('[data-field="details"]').textContent = `${entry.managedFiles?.length || 0}개 설정 파일 · ${entry.prefix || '전체'} 경로`;
    card.querySelector('[data-action="remove"]').addEventListener('click', () => {
      const profile = profiles[activeProfileIndex];
      profile.archives = (profile.archives || []).filter((archive) => archive !== entry);
      renderArchives();
      setStatus(`${entry.id || '모드팩'} 오버라이드를 제거했습니다.`);
    });
    return card;
  }));
}

function javaMajorForMinecraft(version) {
  const [major, minor = 0, patch = 0] = String(version || '').split('.').map(Number);
  if (major > 1 || minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  return 8;
}

function javaRuntimeTargetForMinecraft(version) {
  const major = javaMajorForMinecraft(version);
  if (major >= 25) return 'java-runtime-epsilon';
  if (major >= 21) return 'java-runtime-delta';
  if (major >= 17) return 'java-runtime-gamma';
  return 'jre-legacy';
}

function applyPackProfile(update = {}) {
  if (!update.minecraftVersion) return;
  if (!['vanilla', 'forge', 'fabric'].includes(update.loader)) throw new Error(`현재 클라이언트가 지원하지 않는 구동기입니다: ${update.loader}`);
  selectValue(profileFields.minecraftVersion, update.minecraftVersion);
  selectValue(profileFields.loader, update.loader || 'vanilla');
  renderLoaderVersions(update.loaderVersion || '');
  selectValue(profileFields.loaderVersion, update.loaderVersion || '');
  document.querySelector(profileFields.versionId).value = update.versionId || update.minecraftVersion;
  document.querySelector(profileFields.javaMajorVersion).value = javaMajorForMinecraft(update.minecraftVersion);
  document.querySelector(profileFields.javaRuntimeTarget).value = javaRuntimeTargetForMinecraft(update.minecraftVersion);
  if (update.packName) document.querySelector(profileFields.packName).value = update.packName;
  if (update.packVersion) document.querySelector(profileFields.version).value = update.packVersion;
  updateLoaderFields();
}

function defaultProfile(index = profiles.length) {
  const number = index + 1;
  return {
    id: `profile-${number}`,
    name: `새 프로필 ${number}`,
    description: '',
    version: `profile-${number}-r1`,
    ready: true,
    server: { name: `서버 ${number}`, address: '', host: '', port: 25565 },
    minecraft: {
      version: '1.12.2', loader: 'vanilla', loaderVersion: '', forgeVersion: '',
      forgeVersionId: '1.12.2', versionId: '1.12.2', javaRuntimeTarget: 'jre-legacy', javaMajorVersion: 8
    },
    pack: { id: `profile-${number}-vanilla`, name: 'Vanilla', version: `profile-${number}-r1`, koreanPackVersion: 'none' },
    archives: [], files: [], remove: []
  };
}

function updateLoaderFields() {
  const loader = document.querySelector(profileFields.loader).value;
  const loaderVersion = document.querySelector(profileFields.loaderVersion);
  const previousVersion = loaderVersion.value;
  renderLoaderVersions(loaderVersions[loader]?.includes(previousVersion) ? previousVersion : '');
  loaderVersion.disabled = loader === 'vanilla';
  if (loader === 'vanilla') loaderVersion.value = '';
  const minecraftVersion = document.querySelector(profileFields.minecraftVersion).value || '버전 미설정';
  const selectedLoaderVersion = loaderVersion.value;
  const versionId = loader === 'vanilla'
    ? minecraftVersion
    : loader === 'fabric'
      ? `${minecraftVersion}-fabric${selectedLoaderVersion}`
      : `${minecraftVersion}-forge-${selectedLoaderVersion}`;
  document.querySelector(profileFields.versionId).value = versionId;
  document.querySelector('#modeCompatibility').textContent = `Minecraft ${minecraftVersion} / ${loader}에 맞는 파일을 자동 선택합니다.`;
}

function renderLoaderVersions(selected = '') {
  const loader = document.querySelector(profileFields.loader).value;
  const select = document.querySelector(profileFields.loaderVersion);
  const versions = loaderVersions[loader] || [];
  select.replaceChildren(new Option(loader === 'vanilla' ? '사용하지 않음' : '버전 선택', ''));
  for (const version of versions) select.add(new Option(version, version));
  if (selected && !versions.includes(selected)) select.add(new Option(selected, selected));
  select.value = selected;
}

function saveActiveProfile() {
  const profile = profiles[activeProfileIndex];
  if (!profile) return;
  const value = (name) => document.querySelector(profileFields[name]).value.trim();
  const loader = value('loader') || 'vanilla';
  const minecraftVersion = value('minecraftVersion');
  const loaderVersion = loader === 'vanilla' ? '' : value('loaderVersion');
  const versionId = loader === 'vanilla' ? minecraftVersion : value('versionId');
  const serverAddress = value('serverAddress');
  const addressMatch = serverAddress.match(/^([^:]+)(?::(\d+))?$/);
  const serverPort = Number(value('serverPort')) || Number(addressMatch?.[2]) || 25565;
  profile.id = value('id');
  profile.name = value('name');
  profile.description = value('description');
  profile.version = value('version');
  profile.server = {
    ...(profile.server || {}),
    name: value('serverName'),
    address: serverAddress,
    host: addressMatch?.[1] || serverAddress,
    port: serverPort
  };
  profile.minecraft = {
    ...(profile.minecraft || {}),
    version: minecraftVersion,
    loader,
    loaderVersion,
    forgeVersion: loader === 'forge' ? loaderVersion : '',
    forgeVersionId: versionId,
    versionId,
    javaRuntimeTarget: value('javaRuntimeTarget'),
    javaMajorVersion: Number(value('javaMajorVersion')) || (loader === 'vanilla' ? 8 : 25)
  };
  profile.pack = {
    ...(profile.pack || {}),
    id: value('packId'),
    name: value('packName'),
    version: value('version'),
    koreanPackVersion: profile.pack?.koreanPackVersion || 'none'
  };
  profile.remove = document.querySelector('#remove').value.split(/\r?\n/);
  profile.files = [...list.querySelectorAll('.mode-card')].map((card) => ({
    path: card.querySelector('[data-field="path"]').value,
    source: card.querySelector('[data-field="source"]').value,
    url: card.querySelector('[data-field="url"]').value,
    size: card.querySelector('[data-field="size"]').value,
    hash: {
      algorithm: card.querySelector('[data-field="algorithm"]').value,
      value: card.querySelector('[data-field="hash"]').value
    }
  }));
}

function loadActiveProfile() {
  const profile = profiles[activeProfileIndex];
  if (!profile) return;
  const values = {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    serverName: profile.server?.name,
    serverAddress: profile.server?.address,
    serverPort: profile.server?.port,
    minecraftVersion: profile.minecraft?.version,
    loader: profile.minecraft?.loader || (profile.minecraft?.forgeVersion ? 'forge' : 'vanilla'),
    loaderVersion: profile.minecraft?.loaderVersion || profile.minecraft?.forgeVersion,
    versionId: profile.minecraft?.versionId || profile.minecraft?.forgeVersionId || profile.minecraft?.version,
    javaRuntimeTarget: profile.minecraft?.javaRuntimeTarget,
    javaMajorVersion: profile.minecraft?.javaMajorVersion,
    packId: profile.pack?.id,
    packName: profile.pack?.name,
    version: profile.version || profile.pack?.version
  };
  selectValue(profileFields.loader, values.loader);
  renderLoaderVersions(values.loaderVersion || '');
  for (const [name, selector] of Object.entries(profileFields)) {
    if (['minecraftVersion', 'loader', 'loaderVersion'].includes(name)) selectValue(selector, values[name]);
    else document.querySelector(selector).value = values[name] ?? '';
  }
  document.querySelector('#remove').value = (profile.remove || []).join('\n');
  list.replaceChildren();
  (profile.files || []).forEach(addMode);
  renderArchives();
  updateLoaderFields();
}

function renderProfileOptions() {
  const select = document.querySelector('#profileSelect');
  select.replaceChildren(...profiles.map((profile, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${index + 1}. ${profile.name || profile.id || '이름 없는 프로필'}`;
    return option;
  }));
  select.value = String(activeProfileIndex);
  document.querySelector('#removeProfileButton').disabled = profiles.length <= 1;
}

function collectInput() {
  saveActiveProfile();
  return {
    version: document.querySelector('#version').value,
    profiles
  };
}

async function run(action, success) {
  try { setBusy(true); setStatus('처리 중...'); const result = await action(); setStatus(success, 'success'); return result; }
  catch (error) { setStatus(error.message, 'error'); return null; }
  finally { setBusy(false); }
}

document.querySelector('#addButton').addEventListener('click', () => addMode());
document.querySelector('#profileSelect').addEventListener('change', (event) => {
  saveActiveProfile();
  activeProfileIndex = Number(event.target.value) || 0;
  loadActiveProfile();
});
document.querySelector('#addProfileButton').addEventListener('click', () => {
  saveActiveProfile();
  profiles.push(defaultProfile());
  activeProfileIndex = profiles.length - 1;
  renderProfileOptions();
  loadActiveProfile();
  setStatus('새 프로필을 추가했습니다. 서버와 버전 정보를 입력해 주세요.');
});
document.querySelector('#removeProfileButton').addEventListener('click', () => {
  if (profiles.length <= 1) return;
  const removed = profiles.splice(activeProfileIndex, 1)[0];
  activeProfileIndex = Math.min(activeProfileIndex, profiles.length - 1);
  renderProfileOptions();
  loadActiveProfile();
  setStatus(`${removed.name || removed.id} 프로필을 목록에서 제거했습니다.`);
});
document.querySelector('#minecraftLoader').addEventListener('change', updateLoaderFields);
document.querySelector('#minecraftVersion').addEventListener('change', updateLoaderFields);
document.querySelector('#loaderVersion').addEventListener('change', updateLoaderFields);
function renderCurseforgeKeyStatus(state = {}) {
  const label = document.querySelector('#curseforgeKeyStatus');
  label.textContent = state.valid ? 'API 키 확인됨' : state.configured ? 'API 키 거부됨 · 다시 저장 필요' : 'API 키 미설정';
  label.title = state.error || '';
  label.dataset.configured = state.configured ? 'true' : 'false';
  document.querySelector('#curseforgeKeyRemoveButton').disabled = !state.configured;
}
document.querySelector('#curseforgeKeySaveButton').addEventListener('click', async () => {
  const input = document.querySelector('#curseforgeApiKey');
  try {
    setBusy(true); setStatus('CurseForge API 키를 안전하게 저장하는 중...');
    renderCurseforgeKeyStatus(await api.saveCurseforgeKey(input.value));
    input.value = '';
    setStatus('CurseForge API 키를 Windows 보안 저장소에 암호화했습니다.', 'success');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { setBusy(false); }
});
document.querySelector('#curseforgeKeyRemoveButton').addEventListener('click', async () => {
  renderCurseforgeKeyStatus(await api.removeCurseforgeKey());
  setStatus('저장된 CurseForge API 키를 제거했습니다.', 'success');
});
document.querySelector('#curseforgeHelpButton').addEventListener('click', () => api.open('https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key'));
document.querySelector('#keyButton').addEventListener('click', async () => {
  try {
    const key = await api.chooseKey();
    if (key) {
      document.querySelector('#keyButton').textContent = `키: ${key.name}`;
      setStatus(`새 배포 키 확인 완료 · 지문 ${key.fingerprint}`, 'success');
    }
  } catch (error) { setStatus(error.message, 'error'); }
});

function renderGithubAuth(auth = {}) {
  const account = document.querySelector('#githubAccount');
  const login = document.querySelector('#githubLoginButton');
  const logout = document.querySelector('#githubLogoutButton');
  if (auth.clientId) document.querySelector('#githubClientId').value = auth.clientId;
  if (auth.connected) {
    account.textContent = `@${auth.user.login} 계정으로 연결됨`;
    login.textContent = '다시 로그인';
    logout.hidden = false;
  } else {
    account.textContent = auth.error || '로그인하지 않음 · PAT를 직접 입력해도 됩니다.';
    login.textContent = 'GitHub 로그인';
    logout.hidden = true;
  }
}

document.querySelector('#githubLoginButton').addEventListener('click', async () => {
  const clientId = document.querySelector('#githubClientId').value.trim();
  try {
    setBusy(true); setStatus('GitHub 기기 로그인 코드를 요청하는 중...');
    const flow = await api.authStart(clientId);
    setStatus(`브라우저에서 코드 ${flow.userCode}를 확인해 주세요. 코드는 클립보드에 복사됐습니다.`);
    const auth = await api.authPoll(clientId, flow);
    renderGithubAuth({ ...auth, clientId });
    setStatus(`GitHub @${auth.user.login} 로그인 완료`, 'success');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { setBusy(false); }
});
document.querySelector('#oauthHelpButton').addEventListener('click', () => api.open('https://github.com/settings/applications/new'));
document.querySelector('#patHelpButton').addEventListener('click', () => api.open('https://github.com/settings/personal-access-tokens/new'));
document.querySelector('#patLoginButton').addEventListener('click', async () => {
  const tokenInput = document.querySelector('#token');
  try {
    setBusy(true); setStatus('PAT 권한과 GitHub 계정을 확인하는 중...');
    const auth = await api.patLogin(tokenInput.value);
    tokenInput.value = '';
    renderGithubAuth(auth);
    setStatus(`GitHub @${auth.user.login} PAT 로그인 완료 · 토큰을 Windows 보안 저장소에 암호화했습니다.`, 'success');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { setBusy(false); }
});
document.querySelector('#githubLogoutButton').addEventListener('click', async () => {
  await api.authLogout();
  renderGithubAuth({ connected: false, clientId: document.querySelector('#githubClientId').value });
  setStatus('이 기기에 저장된 GitHub 로그인을 제거했습니다.', 'success');
});
document.querySelector('#saveButton').addEventListener('click', () => run(() => api.save(collectInput()), '서명된 목록을 assets/distribution-manifest.json에 저장했습니다.'));
document.querySelector('#publishButton').addEventListener('click', async () => {
  const github = {
    repository: document.querySelector('#repository').value,
    branch: document.querySelector('#branch').value,
    path: document.querySelector('#githubPath').value,
    token: document.querySelector('#token').value,
    message: document.querySelector('#message').value
  };
  const result = await run(() => api.publish(collectInput(), github), 'GitHub에 새 모드 목록을 게시했습니다.');
  document.querySelector('#token').value = '';
  if (result?.commitUrl) { status.textContent += ' (클릭하여 커밋 열기)'; status.onclick = () => api.open(result.commitUrl); }
});

api.load().then((envelope) => {
  const payload = envelope.payload || envelope;
  document.querySelector('#version').value = payload.version || '';
  profiles = Array.isArray(payload.profiles) && payload.profiles.length
    ? structuredClone(payload.profiles)
    : [{
      id: 'fire-crew-main', name: '불꽃단 메인 서버', description: '', version: payload.version,
      server: {},
      minecraft: { version: payload.profile?.minecraftVersion, loader: 'forge', loaderVersion: payload.profile?.forgeVersion, forgeVersion: payload.profile?.forgeVersion, forgeVersionId: `${payload.profile?.minecraftVersion}-forge-${payload.profile?.forgeVersion}`, javaRuntimeTarget: 'java-runtime-epsilon', javaMajorVersion: 25 },
      pack: { id: payload.profile?.id, name: 'Fire Crew', version: payload.profile?.packVersion || payload.version, koreanPackVersion: payload.profile?.koreanPackVersion || 'none' },
      archives: payload.archives || [], files: payload.files || [], remove: payload.remove || []
    }];
  activeProfileIndex = 0;
  renderProfileOptions();
  loadActiveProfile();
  const fileCount = profiles.reduce((sum, profile) => sum + (profile.files?.length || 0), 0);
  setStatus(`${profiles.length}개 프로필 · ${fileCount}개 설치 파일을 불러왔습니다.`);
}).catch((error) => setStatus(error.message, 'error'));

api.authStatus().then(renderGithubAuth).catch((error) => renderGithubAuth({ error: error.message }));
api.curseforgeKeyStatus().then(renderCurseforgeKeyStatus).catch(() => renderCurseforgeKeyStatus());
