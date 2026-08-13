'use strict';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function validateClientId(value) {
  const clientId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(clientId)) throw new Error('GitHub OAuth App의 Client ID를 입력해 주세요.');
  return clientId;
}

async function postForm(url, values, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Fire-Crew-Mode-Manager/1.0' },
    body: new URLSearchParams(values).toString()
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || body.error || `GitHub 인증 실패 (HTTP ${response.status})`);
  return body;
}

async function startDeviceFlow(clientId, fetchImpl = fetch) {
  const result = await postForm('https://github.com/login/device/code', {
    client_id: validateClientId(clientId),
    scope: 'public_repo'
  }, fetchImpl);
  if (!result.device_code || !result.user_code || !result.verification_uri) throw new Error('GitHub가 올바른 기기 인증 코드를 반환하지 않았습니다.');
  return {
    deviceCode: result.device_code,
    userCode: result.user_code,
    verificationUri: result.verification_uri,
    expiresIn: Number(result.expires_in) || 900,
    interval: Math.max(5, Number(result.interval) || 5)
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollDeviceFlow(options, fetchImpl = fetch, delayImpl = delay) {
  const clientId = validateClientId(options.clientId);
  const deadline = Date.now() + Math.max(1, Number(options.expiresIn) || 900) * 1000;
  let interval = Math.max(5, Number(options.interval) || 5);
  while (Date.now() < deadline) {
    await delayImpl(interval * 1000);
    const result = await postForm('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      device_code: String(options.deviceCode || ''),
      grant_type: DEVICE_GRANT
    }, fetchImpl);
    if (result.access_token) return { token: result.access_token, scope: result.scope || '', tokenType: result.token_type || 'bearer' };
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') {
      interval = Math.max(interval + 5, Number(result.interval) || 0);
      continue;
    }
    throw new Error(result.error_description || result.error || 'GitHub 로그인을 완료하지 못했습니다.');
  }
  throw new Error('GitHub 로그인 코드가 만료되었습니다. 다시 시도해 주세요.');
}

async function fetchGithubUser(token, fetchImpl = fetch) {
  const response = await fetchImpl('https://api.github.com/user', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${String(token || '').trim()}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Fire-Crew-Mode-Manager/1.0' }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.login) throw new Error(body.message || 'GitHub 로그인 정보를 확인할 수 없습니다.');
  return { login: body.login, avatarUrl: body.avatar_url || '', profileUrl: body.html_url || '' };
}

async function loginWithPat(tokenValue, fetchImpl = fetch) {
  const token = String(tokenValue || '').trim();
  if (token.length < 20) throw new Error('유효한 GitHub Personal Access Token을 입력해 주세요.');
  return { token, user: await fetchGithubUser(token, fetchImpl) };
}

module.exports = { fetchGithubUser, loginWithPat, pollDeviceFlow, startDeviceFlow, validateClientId };
