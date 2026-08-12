'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createPayload,
  normalizeGithubPath,
  normalizeRepository,
  parseModrinthProjectUrl,
  publishManifest,
  resolveModrinthProject,
  signPayload
} = require('../tools/mode-list-manager/core');
const { fetchGithubUser, pollDeviceFlow, startDeviceFlow } = require('../tools/mode-list-manager/github-auth');
const { PRODUCT } = require('../src/config');
const { PatchService, verifyManifestEnvelope } = require('../src/patch-service');

function sampleInput() {
  return {
    version: 'fire-crew-test-r3',
    files: [{
      path: 'mods/example.jar',
      url: 'https://cdn.example.com/example.jar',
      size: 123,
      hash: { algorithm: 'sha256', value: 'a'.repeat(64) },
      source: 'Example'
    }],
    remove: ['mods/old.jar']
  };
}

test('관리 도구가 런처와 호환되는 모드 목록을 만든다', () => {
  const payload = createPayload(sampleInput());
  assert.equal(payload.profile.id, PRODUCT.pack.id);
  assert.equal(payload.files[0].path, 'mods/example.jar');
  assert.equal(payload.files[0].hash.value, 'a'.repeat(64));
});

test('중복 경로와 게임 폴더 밖 경로를 거부한다', () => {
  assert.throws(() => createPayload({ ...sampleInput(), files: [sampleInput().files[0], sampleInput().files[0]] }), /중복/);
  assert.throws(() => createPayload({ ...sampleInput(), files: [{ ...sampleInput().files[0], path: '../outside.jar' }] }));
});

test('관리 도구의 Ed25519 서명을 클라이언트가 검증한다', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const payload = createPayload(sampleInput());
  assert.deepEqual(verifyManifestEnvelope(signPayload(payload, privateKey), publicKey), payload);
  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => signPayload(payload, privateKey, otherKey), /일치하지 않습니다/);
});

test('번들 모드 목록과 런타임 공개 키가 서로 일치한다', async () => {
  const root = path.join(__dirname, '..');
  const [manifest, config] = await Promise.all([
    fs.readFile(path.join(root, 'assets', 'distribution-manifest.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'assets', 'runtime-config.json'), 'utf8').then(JSON.parse)
  ]);
  assert.deepEqual(verifyManifestEnvelope(manifest, config.distributionPublicKey), manifest.payload);
  assert.match(config.distributionManifestUrl, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal(config.allowUnsignedLocalManifest, false);
  assert.equal(new URL(config.distributionManifestUrl).hostname, 'raw.githubusercontent.com');
  assert.equal(config.githubRepository, 'Delta-A1/HeroRedMinecraftLauncher');
});

test('모드 관리자와 런처의 Windows 빌드 명령이 분리되어 있다', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['modes:pack'], 'node tools/build-mode-manager.cjs');
  assert.doesNotMatch(packageJson.scripts['modes:pack'], /build-github-release/);
  assert.match(packageJson.scripts['release:win'], /build-github-release/);
});

test('모드 관리자 패키징 스크립트가 런타임 adm-zip 의존성을 포함한다', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'tools', 'build-mode-manager.cjs'), 'utf8');
  assert.match(source, /dependencies:\s*\{[\s\S]*?'adm-zip'/);
  assert.match(source, /node_modules\/adm-zip\/adm-zip\.js/);
});

test('GitHub 목록 조회 실패 시 서명된 번들 목록으로 복귀한다', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-crew-mode-fallback-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(__dirname, '..');
  const config = JSON.parse(await fs.readFile(path.join(projectRoot, 'assets', 'runtime-config.json'), 'utf8'));
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  context.after(() => { global.fetch = originalFetch; });
  const service = new PatchService({
    gameRoot: path.join(root, 'game'),
    cacheRoot: path.join(root, 'cache'),
    stateFile: path.join(root, 'state.json'),
    manifestCacheFile: path.join(root, 'manifest-cache.json'),
    manifestUrl: config.distributionManifestUrl,
    localManifestPath: path.join(projectRoot, 'assets', 'distribution-manifest.json'),
    publicKey: config.distributionPublicKey,
    allowUnsignedLocalManifest: false,
    product: PRODUCT
  });
  const result = await service.getStatus();
  assert.equal(result.configured, true);
  assert.equal(result.manifest.version, 'fire-crew-26.2-city-building-r2');
});

test('GitHub 저장소와 파일 경로를 정규화한다', () => {
  assert.equal(normalizeRepository('https://github.com/Fire-Crew/Launcher.git'), 'Fire-Crew/Launcher');
  assert.equal(normalizeGithubPath('/assets/modes.json'), 'assets/modes.json');
  assert.throws(() => normalizeGithubPath('../secret.json'));
});

test('기존 GitHub 파일의 SHA를 포함해 새 목록을 커밋한다', async () => {
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) return { ok: true, status: 200, json: async () => ({ sha: 'existing-sha' }) };
    return { ok: true, status: 200, json: async () => ({ commit: { html_url: 'https://github.com/example/commit/1' } }) };
  };
  const result = await publishManifest({ repository: 'fire/crew', path: 'assets/modes.json', branch: 'main', token: 'test-token' }, { payload: { version: 'r3' }, signature: 'sig' }, fakeFetch);
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.sha, 'existing-sha');
  assert.equal(body.branch, 'main');
  assert.equal(result.rawUrl, 'https://raw.githubusercontent.com/fire/crew/main/assets/modes.json');
});

test('Modrinth 프로젝트 페이지에서 Forge 26.2 파일을 선택한다', async () => {
  const requests = [];
  const fakeFetch = async (url) => {
    requests.push(String(url));
    const body = String(url).includes('/version?') ? [{
      id: 'version-id', name: 'Example 2.0', version_number: '2.0.0',
      files: [{ primary: true, filename: 'example-forge-26.2.jar', url: 'https://cdn.modrinth.com/example.jar', size: 456, hashes: { sha1: 'b'.repeat(40) } }]
    }] : { title: 'Example Mod', project_type: 'mod' };
    return { ok: true, status: 200, json: async () => body };
  };
  assert.equal(parseModrinthProjectUrl('https://modrinth.com/mod/example'), 'example');
  const result = await resolveModrinthProject('https://modrinth.com/mod/example', {}, fakeFetch);
  assert.equal(result.url, 'https://cdn.modrinth.com/example.jar');
  assert.equal(result.path, 'mods/example-forge-26.2.jar');
  assert.equal(result.hash.algorithm, 'sha1');
  assert.match(requests[1], /loaders=%5B%22forge%22%5D/);
  assert.match(requests[1], /game_versions=%5B%2226\.2%22%5D/);
});

test('GitHub Device Flow로 로그인하고 사용자 계정을 확인한다', async () => {
  let tokenPolls = 0;
  const fakeFetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/login/device/code')) return { ok: true, status: 200, json: async () => ({ device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) };
    if (target.endsWith('/login/oauth/access_token')) {
      tokenPolls += 1;
      return { ok: true, status: 200, json: async () => tokenPolls === 1 ? { error: 'authorization_pending' } : { access_token: 'oauth-token', scope: 'repo', token_type: 'bearer' } };
    }
    assert.equal(options.headers.Authorization, 'Bearer oauth-token');
    return { ok: true, status: 200, json: async () => ({ login: 'fire-admin', avatar_url: '', html_url: 'https://github.com/fire-admin' }) };
  };
  const flow = await startDeviceFlow('client_id_1234567890', fakeFetch);
  assert.equal(flow.userCode, 'ABCD-EFGH');
  const auth = await pollDeviceFlow({ clientId: 'client_id_1234567890', ...flow }, fakeFetch, async () => {});
  assert.equal(auth.token, 'oauth-token');
  assert.deepEqual(await fetchGithubUser(auth.token, fakeFetch), { login: 'fire-admin', avatarUrl: '', profileUrl: 'https://github.com/fire-admin' });
});
