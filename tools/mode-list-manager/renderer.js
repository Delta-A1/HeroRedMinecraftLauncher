'use strict';

const api = window.modeManager;
const list = document.querySelector('#modeList');
const template = document.querySelector('#modeTemplate');
const status = document.querySelector('#status');
let archives = [];

function setStatus(message, kind = '') { status.textContent = message; status.dataset.kind = kind; }
function setBusy(value) { document.querySelectorAll('button').forEach((button) => { button.disabled = value; }); }

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
      const result = await api.inspect(url);
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

function collectInput() {
  return {
    version: document.querySelector('#version').value,
    archives,
    remove: document.querySelector('#remove').value.split(/\r?\n/),
    files: [...list.querySelectorAll('.mode-card')].map((card) => ({
      path: card.querySelector('[data-field="path"]').value,
      source: card.querySelector('[data-field="source"]').value,
      url: card.querySelector('[data-field="url"]').value,
      size: card.querySelector('[data-field="size"]').value,
      hash: { algorithm: card.querySelector('[data-field="algorithm"]').value, value: card.querySelector('[data-field="hash"]').value }
    }))
  };
}

async function run(action, success) {
  try { setBusy(true); setStatus('처리 중...'); const result = await action(); setStatus(success, 'success'); return result; }
  catch (error) { setStatus(error.message, 'error'); return null; }
  finally { setBusy(false); }
}

document.querySelector('#addButton').addEventListener('click', () => addMode());
document.querySelector('#keyButton').addEventListener('click', async () => {
  const name = await api.chooseKey();
  if (name) { document.querySelector('#keyButton').textContent = `키: ${name}`; setStatus('개인 키를 메모리에 연결했습니다.', 'success'); }
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
  document.querySelector('#remove').value = (payload.remove || []).join('\n');
  archives = payload.archives || [];
  (payload.files || []).forEach(addMode);
  setStatus(`${payload.files?.length || 0}개 모드를 불러왔습니다.`);
}).catch((error) => setStatus(error.message, 'error'));

api.authStatus().then(renderGithubAuth).catch((error) => renderGithubAuth({ error: error.message }));
