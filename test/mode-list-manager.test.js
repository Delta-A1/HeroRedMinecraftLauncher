'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const {
  createPayload,
  normalizeGithubPath,
  normalizeRepository,
  parseCurseForgeProjectUrl,
  parseModrinthProjectUrl,
  publishManifest,
  resolveCurseForgeProject,
  resolveModrinthProject,
  signPayload,
  validateCurseForgeApiKey
} = require('../tools/mode-list-manager/core');
const { fetchGithubUser, loginWithPat, pollDeviceFlow, startDeviceFlow } = require('../tools/mode-list-manager/github-auth');
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
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.profiles[0].pack.id, PRODUCT.pack.id);
  assert.equal(payload.profiles[0].files[0].path, 'mods/example.jar');
  assert.equal(payload.profiles[0].files[0].hash.value, 'a'.repeat(64));
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

test('CurseForge 프로젝트 페이지에서 프로필과 호환되는 모드 파일을 선택한다', async () => {
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const body = String(url).includes('/mods/search')
      ? { data: [{ id: 123, name: 'Example CF Mod', slug: 'example-cf', classId: 6 }] }
      : { data: [{ id: 456, modId: 123, fileName: 'example-cf.jar', displayName: 'Example 1.0', fileLength: 789, downloadUrl: 'https://mediafilez.forgecdn.net/example.jar', hashes: [{ algo: 1, value: 'c'.repeat(40) }] }] };
    return { ok: true, status: 200, json: async () => body };
  };
  assert.deepEqual(parseCurseForgeProjectUrl('https://www.curseforge.com/minecraft/mc-mods/example-cf'), {
    slug: 'example-cf', section: 'mc-mods', classId: 6, fileId: 0
  });
  const result = await resolveCurseForgeProject('https://www.curseforge.com/minecraft/mc-mods/example-cf', {
    minecraftVersion: '26.2', loader: 'forge', apiKey: 'test-curseforge-api-key'
  }, fakeFetch);
  assert.equal(result.url, 'https://mediafilez.forgecdn.net/example.jar');
  assert.equal(result.path, 'mods/example-cf.jar');
  assert.equal(result.hash.algorithm, 'sha1');
  assert.ok(requests.every((entry) => entry.options.headers['x-api-key'] === 'test-curseforge-api-key'));
  assert.match(requests[1].url, /gameVersion=26\.2/);
  assert.match(requests[1].url, /modLoaderType=1/);
});

test('CurseForge API 키를 실제 Minecraft 조회로 검사하고 403을 명확히 안내한다', async () => {
  const valid = await validateCurseForgeApiKey('valid-test-api-key', async (_url, options) => {
    assert.equal(options.headers['x-api-key'], 'valid-test-api-key');
    return { ok: true, status: 200, json: async () => ({ data: { id: 432, name: 'Minecraft' } }) };
  });
  assert.deepEqual(valid, { valid: true, game: 'Minecraft' });
  await assert.rejects(
    () => validateCurseForgeApiKey('denied-test-api-key', async () => ({ ok: false, status: 403, json: async () => null })),
    /제3자 개발자용 API 키/
  );
});

test('CurseForge 모드팩 링크에서 필수 모드와 overrides를 가져온다', async () => {
  const pack = new AdmZip();
  pack.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '26.2' }, overrides: 'overrides',
    files: [{ projectID: 200, fileID: 201, required: true }]
  })));
  pack.addFile('overrides/config/example.toml', Buffer.from('enabled=true'));
  const packBuffer = pack.toBuffer();
  const fakeFetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/mods/search')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 100, name: 'Example Pack', slug: 'example-pack', classId: 4471 }] }) };
    if (target.includes('/mods/100/files?')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 101, modId: 100, fileName: 'pack.zip', displayName: 'Pack 1.0', fileLength: packBuffer.length, downloadUrl: 'https://mediafilez.forgecdn.net/pack.zip', hashes: [{ algo: 1, value: 'd'.repeat(40) }] }] }) };
    if (target === 'https://mediafilez.forgecdn.net/pack.zip') return { ok: true, status: 200, headers: new Headers({ 'content-length': String(packBuffer.length) }), arrayBuffer: async () => packBuffer };
    if (target.endsWith('/mods/files') && options.method === 'POST') return { ok: true, status: 200, json: async () => ({ data: [{ id: 201, modId: 200, fileName: 'dependency.jar', fileLength: 321, downloadUrl: 'https://mediafilez.forgecdn.net/dependency.jar', hashes: [{ algo: 1, value: 'e'.repeat(40) }] }] }) };
    if (target.endsWith('/mods') && options.method === 'POST') return { ok: true, status: 200, json: async () => ({ data: [{ id: 200, name: 'Dependency', classId: 6 }] }) };
    throw new Error(`Unexpected URL: ${target}`);
  };
  const result = await resolveCurseForgeProject('https://www.curseforge.com/minecraft/modpacks/example-pack', {
    minecraftVersion: '26.2', loader: 'forge', apiKey: 'test-curseforge-api-key'
  }, fakeFetch);
  assert.equal(result.type, 'modpack');
  assert.equal(result.files[0].path, 'mods/dependency.jar');
  assert.deepEqual(result.archives[0].managedFiles, ['config/example.toml']);
  assert.equal(result.archives[0].prefix, 'overrides/');
});

test('CurseForge 모드팩은 현재 프로필과 버전이 달라도 최신 파일을 조회하고 프로필 정보를 제안한다', async () => {
  const pack = new AdmZip();
  pack.addFile('manifest.json', Buffer.from(JSON.stringify({
    name: 'NightfallCraft', version: '2.2.9.6',
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.4.0', primary: true }] },
    overrides: 'overrides', files: []
  })));
  const packBuffer = pack.toBuffer();
  const requests = [];
  const fakeFetch = async (url) => {
    const target = String(url);
    requests.push(target);
    if (target.includes('/mods/search')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 1354886, mainFileId: 8544899, name: 'NightfallCraft - The Casket of Reveries', slug: 'nightfallcraft-the-casket-of-reveries', classId: 4471 }] }) };
    if (target.includes('/mods/1354886/files?')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (target.endsWith('/mods/1354886/files/8544899')) return { ok: true, status: 200, json: async () => ({ data: { id: 8544899, modId: 1354886, fileName: 'The Casket of Reveries -2.2.9.6.zip', displayName: '2.2.9.6', fileLength: packBuffer.length, downloadUrl: 'https://mediafilez.forgecdn.net/nightfall.zip', hashes: [{ algo: 1, value: 'a'.repeat(40) }] } }) };
    if (target === 'https://mediafilez.forgecdn.net/nightfall.zip') return { ok: true, status: 200, headers: new Headers({ 'content-length': String(packBuffer.length) }), arrayBuffer: async () => packBuffer };
    throw new Error(`Unexpected URL: ${target}`);
  };
  const result = await resolveCurseForgeProject('https://www.curseforge.com/minecraft/modpacks/nightfallcraft-the-casket-of-reveries', {
    minecraftVersion: '26.2', loader: 'forge', apiKey: 'test-curseforge-api-key'
  }, fakeFetch);
  assert.equal(result.compatibility.usedFallback, true);
  assert.deepEqual(result.profileUpdate, {
    minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.0',
    versionId: '1.20.1-forge-47.4.0', packName: 'NightfallCraft - The Casket of Reveries', packVersion: '2.2.9.6'
  });
  assert.ok(requests.some((target) => target.endsWith('/mods/1354886/files/8544899')));
});

test('Modrinth 모드팩 링크에서 파일 목록과 overrides를 가져온다', async () => {
  const pack = new AdmZip();
  pack.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ files: [{
    path: 'mods/modrinth-dependency.jar', fileSize: 654,
    hashes: { sha1: 'f'.repeat(40) }, downloads: ['https://cdn.modrinth.com/dependency.jar']
  }] })));
  pack.addFile('overrides/config/modrinth.toml', Buffer.from('enabled=true'));
  const packBuffer = pack.toBuffer();
  const fakeFetch = async (url) => {
    const target = String(url);
    if (target.includes('/version?')) return { ok: true, status: 200, json: async () => [{ id: 'pack-version', name: 'Pack 1.0', version_number: '1.0', files: [{ primary: true, filename: 'pack.mrpack', url: 'https://cdn.modrinth.com/pack.mrpack', size: packBuffer.length, hashes: { sha1: 'a'.repeat(40) } }] }] };
    if (target.includes('/project/')) return { ok: true, status: 200, json: async () => ({ title: 'Modrinth Pack', project_type: 'modpack' }) };
    if (target === 'https://cdn.modrinth.com/pack.mrpack') return { ok: true, status: 200, headers: new Headers({ 'content-length': String(packBuffer.length) }), arrayBuffer: async () => packBuffer };
    throw new Error(`Unexpected URL: ${target}`);
  };
  const result = await resolveModrinthProject('https://modrinth.com/modpack/modrinth-pack', { minecraftVersion: '26.2', loader: 'forge' }, fakeFetch);
  assert.equal(result.type, 'modpack');
  assert.equal(result.files[0].path, 'mods/modrinth-dependency.jar');
  assert.deepEqual(result.archives[0].managedFiles, ['config/modrinth.toml']);
});

test('fine-grained PAT로 GitHub 계정을 확인한다', async () => {
  const token = 'github_pat_test_token_1234567890';
  const fakeFetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return { ok: true, status: 200, json: async () => ({ login: 'fire-admin', avatar_url: 'avatar', html_url: 'profile' }) };
  };
  const result = await loginWithPat(token, fakeFetch);
  assert.equal(result.token, token);
  assert.equal(result.user.login, 'fire-admin');
  await assert.rejects(() => loginWithPat('short', fakeFetch), /Personal Access Token/);
});

test('관리자 빌드는 개인 키를 포함하지 않고 선택 즉시 새 공개 키를 검증한다', async () => {
  const root = path.join(__dirname, '..');
  const [mainSource, buildSource] = await Promise.all([
    fs.readFile(path.join(root, 'tools', 'mode-list-manager', 'main.js'), 'utf8'),
    fs.readFile(path.join(root, 'tools', 'build-mode-manager.cjs'), 'utf8')
  ]);
  assert.match(mainSource, /crypto\.verify\(null, probe, runtimeConfig\.distributionPublicKey, signature\)/);
  assert.match(mainSource, /fingerprint/);
  assert.match(buildSource, /entry\.endsWith\('\.pem'\)/);
  assert.match(buildSource, /admin-signing-key/);
});

test('모드 목록 관리자는 서버 프로필 추가·선택·삭제와 로더 설정을 제공한다', async () => {
  const root = path.join(__dirname, '..', 'tools', 'mode-list-manager');
  const [html, renderer] = await Promise.all([
    fs.readFile(path.join(root, 'index.html'), 'utf8'),
    fs.readFile(path.join(root, 'renderer.js'), 'utf8')
  ]);
  for (const id of ['profileSelect', 'addProfileButton', 'removeProfileButton', 'serverAddress', 'minecraftVersion', 'minecraftLoader', 'packId', 'curseforgeApiKey', 'curseforgeKeySaveButton']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(renderer, /profiles\.push\(defaultProfile\(\)\)/);
  assert.match(renderer, /loader === 'vanilla'/);
  assert.match(renderer, /api\.inspect\(url, \{/);
  assert.match(renderer, /applyPackProfile\(result\.profileUpdate\)/);
  assert.match(html, /<select id="minecraftVersion">/);
  assert.match(html, /<select id="loaderVersion">/);
  assert.match(html, /<option value="fabric">Fabric<\/option>/);
  assert.match(renderer, /fabric:\s*\[/);
});
