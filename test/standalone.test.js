'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { download } = require('@xmcl/file-transfer');
const {
  AuthService,
  exchangeMicrosoftTokenForMinecraft
} = require('../src/auth-service');
const {
  createLaunchProfiles,
  PRODUCT,
  getRuntimeConfigurationIssues,
  loadRuntimeConfig,
  productForProfile
} = require('../src/config');
const { resolveInside, writeJsonAtomic } = require('../src/file-utils');
const {
  PatchService,
  stableStringify,
  verifyManifestEnvelope
} = require('../src/patch-service');
const { readServerList, upsertServer } = require('../src/server-list');
const { decodeVarInt, encodeVarInt, parseStatusPacket } = require('../src/server-status');
const { installJavaRuntimeFiles } = require('../src/java-runtime-installer');
const {
  baseStateMatchesProduct,
  createMicrosoftLaunchIdentity,
  createVanillaDependencyManifest,
  MinecraftService
} = require('../src/minecraft-service');
const {
  createMinecraftDownloadDispatcher,
  isRetryableInstallError,
  removeZeroByteInstallFiles,
  retryInstall
} = require('../src/minecraft-download-policy');
const {
  fetchMojangJavaRuntimeManifest,
  resolvePlatformKey
} = require('../src/mojang-runtime-manifest');
const {
  SkinService,
  validateSkinUrl
} = require('../src/skin-service');
const {
  normalizeWindowsPackageNames
} = require('../tools/normalize-windows-package-names.cjs');
const {
  isBuildIgnored,
  requiredRuntimeEntries,
  windowsBuildDirectories
} = require('../tools/build-windows-package.cjs');

async function tempDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('불꽃단 서버를 servers.dat에 추가하고 기존 서버를 보존한다', async (context) => {
  const root = await tempDirectory('fire-crew-server-list-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await upsertServer(root, { name: '친구 서버', address: 'example.org:25565' });
  await upsertServer(root, PRODUCT.server);
  await upsertServer(root, PRODUCT.server);
  const list = await readServerList(path.join(root, 'servers.dat'));
  assert.equal(list.servers.length, 2);
  assert.equal(list.servers[0].name, PRODUCT.server.name);
  assert.equal(list.servers[0].ip, PRODUCT.server.address);
});

test('Minecraft 서버 상태 패킷에서 실시간 접속 인원을 읽는다', () => {
  const json = Buffer.from(JSON.stringify({
    version: { name: '26.2' },
    players: { online: 7, max: 20 }
  }));
  const payload = Buffer.concat([Buffer.from([0]), encodeVarInt(json.length), json]);
  const packet = Buffer.concat([encodeVarInt(payload.length), payload]);
  assert.equal(decodeVarInt(encodeVarInt(300)).value, 300);
  assert.deepEqual(parseStatusPacket(packet).players, { online: 7, max: 20 });
});

test('배포 매니페스트 Ed25519 서명을 검증하고 변조를 거부한다', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const payload = { schemaVersion: 1, version: 'test', files: [] };
  const signature = crypto.sign(
    null,
    Buffer.from(stableStringify(payload), 'utf8'),
    privateKey
  ).toString('base64');
  assert.deepEqual(verifyManifestEnvelope({ payload, signature }, publicKey), payload);
  assert.throws(
    () => verifyManifestEnvelope({ payload: { ...payload, version: 'tampered' }, signature }, publicKey),
    /서명 검증/
  );
});

test('배포 파일 경로가 게임 폴더 밖으로 나가지 못하게 한다', () => {
  const root = path.resolve(os.tmpdir(), 'fire-crew-root');
  assert.equal(resolveInside(root, 'mods/example.jar'), path.join(root, 'mods', 'example.jar'));
  assert.throws(() => resolveInside(root, '../outside.jar'), /안전하지 않은/);
  assert.throws(() => resolveInside(root, 'mods/../../outside.jar'), /안전하지 않은/);
});

test('OAuth 클라이언트 ID가 없으면 로그인 미설정 상태를 반환한다', async (context) => {
  const root = await tempDirectory('fire-crew-auth-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new AuthService({
    clientId: '',
    cacheFile: path.join(root, 'cache.bin'),
    profileFile: path.join(root, 'profile.json'),
    safeStorage: {
      isEncryptionAvailable: () => false
    }
  });
  const status = await service.getStatus();
  assert.equal(status.configured, false);
  assert.equal(status.signedIn, false);
  assert.equal(status.microsoftSignedIn, false);
  assert.equal(status.minecraftReady, false);
});

test('Microsoft 토큰만 저장된 상태를 Minecraft 로그인 완료로 표시하지 않는다', async (context) => {
  const root = await tempDirectory('fire-crew-auth-partial-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new AuthService({
    clientId: '13b1569c-6493-4f9f-9cc3-7a4def917a33',
    cacheFile: path.join(root, 'cache.bin'),
    profileFile: path.join(root, 'profile.json'),
    safeStorage: {
      isEncryptionAvailable: () => false
    }
  });
  service.initialized = true;
  service.pca = {
    getTokenCache: () => ({
      getAllAccounts: async () => [{ username: 'tester@example.com' }]
    })
  };
  const status = await service.getStatus();
  assert.equal(status.microsoftSignedIn, true);
  assert.equal(status.minecraftReady, false);
  assert.equal(status.signedIn, false);
  assert.equal(status.microsoftName, 'tester@example.com');
  assert.equal(status.minecraftName, '');
});

test('Microsoft 토큰과 Minecraft 프로필이 모두 있어야 로그인 완료가 된다', async (context) => {
  const root = await tempDirectory('fire-crew-auth-complete-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const profileFile = path.join(root, 'profile.json');
  await writeJsonAtomic(profileFile, {
    id: '0123456789abcdef',
    name: 'FireCrewTester'
  });
  const service = new AuthService({
    clientId: '13b1569c-6493-4f9f-9cc3-7a4def917a33',
    cacheFile: path.join(root, 'cache.bin'),
    profileFile,
    safeStorage: {
      isEncryptionAvailable: () => false
    }
  });
  service.initialized = true;
  service.pca = {
    getTokenCache: () => ({
      getAllAccounts: async () => [{ username: 'tester@example.com' }]
    })
  };
  const status = await service.getStatus();
  assert.equal(status.microsoftSignedIn, true);
  assert.equal(status.minecraftReady, true);
  assert.equal(status.signedIn, true);
  assert.equal(status.minecraftName, 'FireCrewTester');
});

test('로그인 테스트 배포본에 Fire Crew Microsoft 공개 클라이언트 ID가 연결되어 있다', async (context) => {
  const root = await tempDirectory('fire-crew-runtime-config-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const appRoot = path.join(__dirname, '..');
  const config = await loadRuntimeConfig(appRoot, root);
  assert.equal(config.microsoftClientId, '13b1569c-6493-4f9f-9cc3-7a4def917a33');
  assert.equal(config.qaBypassMicrosoftLogin, false);
  assert.equal(
    getRuntimeConfigurationIssues(config).some((issue) => issue.id === 'microsoft-client-id'),
    false
  );
});

test('R9 배포 매니페스트는 Forge 26.2용 도시 건축 모드 14개를 설치한다', async () => {
  const manifest = JSON.parse(await fs.readFile(
    path.join(__dirname, '..', 'assets', 'distribution-manifest.json'),
    'utf8'
  ));
  assert.equal(manifest.payload.ready, true);
  assert.equal(manifest.payload.schemaVersion, 2);
  const profile = manifest.payload.profiles.find((entry) => entry.pack.id === PRODUCT.pack.id);
  assert.equal(profile.version, 'fire-crew-26.2-city-building-r2');
  assert.equal(profile.minecraft.version, '26.2');
  assert.equal(profile.minecraft.loader, 'forge');
  assert.equal(profile.minecraft.forgeVersion, '65.0.9');
  assert.equal(profile.files.length, 14);
  assert.ok(profile.files.some((file) => file.path.includes('voicechat-forge-2.6.21')));
  assert.ok(profile.files.some((file) => file.path.includes('SkniroFurniture')));
  assert.ok(profile.files.some((file) => file.path.includes('mcw-roofs')));
  assert.ok(profile.files.every((file) => /^https:\/\/cdn\.modrinth\.com\//.test(file.url)));
  assert.ok(profile.files.every((file) => file.hash.algorithm === 'sha1'));
  assert.deepEqual(profile.archives, []);
  assert.ok(profile.remove.includes('mods/voicechat-forge-2.6.20+26.2.jar'));
  assert.ok(profile.remove.some((file) => /connected.?glass/i.test(file)));
  const vanilla = manifest.payload.profiles.find((entry) => entry.id === 'heroreds-freedom');
  assert.equal(vanilla.minecraft.version, '1.12.2');
  assert.equal(vanilla.minecraft.loader, 'vanilla');
  assert.equal(vanilla.server.address, 'heroredsfreedom.run.place');
  assert.equal(vanilla.server.port, 25565);
  assert.deepEqual(vanilla.files, []);
});

test('1.20.1 기반 상태는 26.2 준비 완료로 재사용하지 않는다', () => {
  assert.equal(baseStateMatchesProduct({
    minecraftVersion: '1.20.1',
    forgeVersion: '47.4.0',
    forgeVersionId: '1.20.1-forge-47.4.0',
    javaRuntimeTarget: 'java-runtime-gamma'
  }, PRODUCT), false);
  assert.equal(baseStateMatchesProduct({
    minecraftVersion: PRODUCT.minecraft.version,
    forgeVersion: PRODUCT.minecraft.forgeVersion,
    forgeVersionId: PRODUCT.minecraft.forgeVersionId,
    javaRuntimeTarget: PRODUCT.minecraft.javaRuntimeTarget
  }, PRODUCT), true);
});

test('Minecraft 26.2 에셋과 라이브러리를 제한 다운로드용 매니페스트로 만든다', () => {
  const assetHash = '0123456789abcdef0123456789abcdef01234567';
  const files = createVanillaDependencyManifest({
    libraries: [{
      download: {
        path: 'com/example/library/1.0/library-1.0.jar',
        url: 'https://libraries.minecraft.net/com/example/library/1.0/library-1.0.jar',
        sha1: '89abcdef0123456789abcdef0123456789abcdef',
        size: 1234
      }
    }],
    logging: {
      client: {
        file: {
          id: 'client-1.12.xml',
          url: 'https://piston-data.mojang.com/log_configs/client-1.12.xml',
          sha1: 'abcdef0123456789abcdef0123456789abcdef01',
          size: 567
        }
      }
    }
  }, {
    objects: {
      'minecraft/lang/ko_kr.json': {
        hash: assetHash,
        size: 789
      }
    }
  }).files;
  assert.equal(files[`assets/objects/01/${assetHash}`].downloads.raw.size, 789);
  assert.equal(
    files['libraries/com/example/library/1.0/library-1.0.jar'].downloads.raw.size,
    1234
  );
  assert.equal(files['assets/log_configs/client-1.12.xml'].downloads.raw.size, 567);
});

test('로그인 없는 QA 모드는 Microsoft 클라이언트 ID 누락을 실행 차단 사유로 만들지 않는다', () => {
  const issues = getRuntimeConfigurationIssues({
    microsoftClientId: '',
    distributionManifestUrl: '',
    distributionPublicKey: '',
    qaBypassMicrosoftLogin: true
  });
  assert.equal(issues.some((issue) => issue.id === 'microsoft-client-id'), false);
});

test('Minecraft XSTS에 XUID가 있으면 추가 Xbox Live XSTS 요청 없이 사용한다', async () => {
  const calls = [];
  const authenticator = {
    authenticateXboxLive: async (token) => {
      calls.push(['authenticate', token]);
      return { Token: 'xbl-token' };
    },
    authorizeXboxLive: async (token, relyingParty) => {
      calls.push(['authorize', token, relyingParty]);
      return {
        Token: 'minecraft-xsts-token',
        DisplayClaims: { xui: [{ uhs: 'user-hash', xid: '2533274799999999' }] }
      };
    },
    loginMinecraftWithXBox: async (uhs, token) => {
      calls.push(['minecraft', uhs, token]);
      return {
        access_token: 'minecraft-access-token',
        expires_in: 3600
      };
    }
  };
  const mojang = {
    checkGameOwnership: async (token) => {
      calls.push(['ownership', token]);
      return { items: [{ name: 'game_minecraft' }] };
    },
    getProfile: async (token) => {
      calls.push(['profile', token]);
      return { id: '0123456789abcdef', name: 'FireCrewTester' };
    }
  };

  const session = await exchangeMicrosoftTokenForMinecraft('microsoft-token', authenticator, mojang);
  assert.equal(session.profile.name, 'FireCrewTester');
  assert.equal(session.xuid, '2533274799999999');
  assert.deepEqual(calls.filter(([name]) => name === 'authorize'), [
    ['authorize', 'xbl-token', 'rp://api.minecraftservices.com/']
  ]);
});

test('Minecraft XSTS에 XUID가 없으면 Xbox Live XSTS에서 보완한다', async () => {
  const relyingParties = [];
  const authenticator = {
    authenticateXboxLive: async () => ({ Token: 'xbl-token' }),
    authorizeXboxLive: async (_token, relyingParty) => {
      relyingParties.push(relyingParty);
      if (relyingParty === 'http://xboxlive.com') {
        return {
          Token: 'live-xsts-token',
          DisplayClaims: { xui: [{ uhs: 'user-hash', xid: '2533274700000001' }] }
        };
      }
      return {
        Token: 'minecraft-xsts-token',
        DisplayClaims: { xui: [{ uhs: 'user-hash' }] }
      };
    },
    loginMinecraftWithXBox: async () => ({
      access_token: 'minecraft-access-token',
      expires_in: 3600
    })
  };
  const mojang = {
    checkGameOwnership: async () => ({ items: [{ name: 'game_minecraft' }] }),
    getProfile: async () => ({ id: '0123456789abcdef', name: 'FireCrewTester' })
  };
  const session = await exchangeMicrosoftTokenForMinecraft('microsoft-token', authenticator, mojang);
  assert.equal(session.xuid, '2533274700000001');
  assert.deepEqual(relyingParties, [
    'rp://api.minecraftservices.com/',
    'http://xboxlive.com'
  ]);
});

test('Microsoft Minecraft 실행 인자에 MSA 유형과 clientId·XUID를 전달한다', () => {
  const clientId = '13b1569c-6493-4f9f-9cc3-7a4def917a33';
  const identity = createMicrosoftLaunchIdentity({
    clientId,
    xuid: '2533274799999999'
  });
  assert.equal(identity.userType, 'msa');
  assert.deepEqual(identity.features, {
    fire_crew_microsoft_session: {
      clientid: Buffer.from(clientId, 'utf8').toString('base64'),
      auth_xuid: '2533274799999999'
    }
  });
});

test('XUID가 없는 Microsoft 세션은 보안 프로필 없이 실행하지 않는다', () => {
  assert.throws(
    () => createMicrosoftLaunchIdentity({
      clientId: '13b1569c-6493-4f9f-9cc3-7a4def917a33',
      xuid: ''
    }),
    /XUID/
  );
});

test('Minecraft 프로필의 활성 스킨과 모델 정보를 로그인 세션에 보존한다', async () => {
  const authenticator = {
    authenticateXboxLive: async () => ({ Token: 'xbl-token' }),
    authorizeXboxLive: async () => ({
      Token: 'minecraft-xsts-token',
      DisplayClaims: { xui: [{ uhs: 'user-hash', xid: '2533274799999999' }] }
    }),
    loginMinecraftWithXBox: async () => ({
      access_token: 'minecraft-access-token',
      expires_in: 3600
    })
  };
  const mojang = {
    checkGameOwnership: async () => ({ items: [{ name: 'game_minecraft' }] }),
    getProfile: async () => ({
      id: '0123456789abcdef0123456789abcdef',
      name: 'FireCrewTester',
      skins: [
        {
          state: 'INACTIVE',
          url: 'https://textures.minecraft.net/texture/1111',
          variant: 'CLASSIC'
        },
        {
          state: 'ACTIVE',
          url: 'https://textures.minecraft.net/texture/abcd1234',
          variant: 'SLIM'
        }
      ]
    })
  };

  const session = await exchangeMicrosoftTokenForMinecraft('microsoft-token', authenticator, mojang);
  assert.deepEqual(session.profile.skin, {
    url: 'https://textures.minecraft.net/texture/abcd1234',
    variant: 'SLIM'
  });
});

test('공식 Minecraft 텍스처만 검사해 스킨 캐시에 저장한다', async (context) => {
  const root = await tempDirectory('fire-crew-skin-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const png = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(64, 16);
  png.writeUInt32BE(64, 20);
  const service = new SkinService({
    cacheRoot: root,
    fetch: async () => ({
      ok: true,
      headers: { get: () => String(png.length) },
      arrayBuffer: async () => png
    })
  });
  const profileId = '0123456789abcdef0123456789abcdef';
  const dataUrl = await service.refresh({
    id: profileId,
    skin: {
      url: 'https://textures.minecraft.net/texture/abcd1234',
      variant: 'CLASSIC'
    }
  });
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.throws(
    () => validateSkinUrl('https://example.com/texture/abcd1234'),
    /공식 Minecraft/
  );
  await service.remove(profileId);
  assert.equal(await service.getDataUrl(profileId), '');
});

test('초안 배포 매니페스트는 공개 설치 준비 전 상태로 표시한다', async (context) => {
  const root = await tempDirectory('fire-crew-patch-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestFile = path.join(root, 'distribution.json');
  await writeJsonAtomic(manifestFile, {
    payload: {
      schemaVersion: 1,
      ready: false,
      version: 'draft',
      message: '관리자 설정 필요',
      profile: {
        id: PRODUCT.pack.id,
        minecraftVersion: PRODUCT.minecraft.version,
        forgeVersion: PRODUCT.minecraft.forgeVersion
      },
      files: [],
      archives: [],
      remove: []
    },
    signature: ''
  });
  const service = new PatchService({
    gameRoot: path.join(root, 'game'),
    cacheRoot: path.join(root, 'cache'),
    stateFile: path.join(root, 'state.json'),
    localManifestPath: manifestFile,
    allowUnsignedLocalManifest: true,
    product: PRODUCT
  });
  const status = await service.getStatus();
  assert.equal(status.configured, false);
  assert.equal(status.ready, false);
  assert.equal(status.message, '관리자 설정 필요');
});

test('독립형 런처 UI에서 참조하는 모든 요소가 HTML에 존재한다', async () => {
  const rendererRoot = path.join(__dirname, '..', 'src', 'renderer');
  const [html, script] = await Promise.all([
    fs.readFile(path.join(rendererRoot, 'index.html'), 'utf8'),
    fs.readFile(path.join(rendererRoot, 'renderer.js'), 'utf8')
  ]);
  const ids = [...script.matchAll(/querySelector\('#([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(ids.length > 20);
  for (const id of ids) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `HTML에 #${id}가 있어야 합니다.`);
  }
});

test('Fabric 프로필과 설치 상태는 로더 버전 및 실행 버전 ID로 일치 여부를 판단한다', () => {
  const fabricProduct = {
    ...PRODUCT,
    minecraft: {
      ...PRODUCT.minecraft,
      version: '1.20.1', loader: 'fabric', loaderVersion: '0.16.14',
      forgeVersion: '', forgeVersionId: '1.20.1-fabric0.16.14', versionId: '1.20.1-fabric0.16.14',
      javaRuntimeTarget: 'java-runtime-gamma', javaMajorVersion: 17
    }
  };
  assert.equal(baseStateMatchesProduct({
    minecraftVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.16.14',
    launchVersionId: '1.20.1-fabric0.16.14', javaRuntimeTarget: 'java-runtime-gamma'
  }, fabricProduct), true);
  assert.equal(baseStateMatchesProduct({
    minecraftVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.15.11',
    launchVersionId: '1.20.1-fabric0.15.11', javaRuntimeTarget: 'java-runtime-gamma'
  }, fabricProduct), false);
});

test('Fabric 서버 프로필은 Forge 기본값을 상속하지 않고 Fabric 실행 ID로 정규화된다', () => {
  const [profile] = createLaunchProfiles({ profiles: [{
    id: 'fabric-test',
    minecraft: { version: '1.20.1', loader: 'fabric', loaderVersion: '0.16.14' },
    pack: { id: 'fabric-test-pack' }
  }] }, PRODUCT);
  assert.equal(profile.minecraft.loader, 'fabric');
  assert.equal(profile.minecraft.loaderVersion, '0.16.14');
  assert.equal(profile.minecraft.forgeVersion, '');
  assert.equal(profile.minecraft.versionId, '1.20.1-fabric0.16.14');
  assert.equal(profile.minecraft.forgeVersionId, '1.20.1-fabric0.16.14');
});

test('런처 서비스가 Fabric 설치와 라이브러리 준비 분기를 제공한다', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'minecraft-service.js'), 'utf8');
  assert.match(source, /installFabric\(\{/);
  assert.match(source, /loader === 'fabric'/);
  assert.match(source, /'Fabric 라이브러리 확인'/);
});

test('통합 목록에서 선택한 1.12.2 바닐라 프로필만 적용한다', async (context) => {
  const root = await tempDirectory('fire-crew-vanilla-profile-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundled = JSON.parse(await fs.readFile(
    path.join(__dirname, '..', 'assets', 'distribution-manifest.json'),
    'utf8'
  ));
  const vanillaEntry = bundled.payload.profiles.find((profile) => profile.id === 'heroreds-freedom');
  const manifestFile = path.join(root, 'distribution.json');
  await writeJsonAtomic(manifestFile, {
    schemaVersion: 2,
    ready: true,
    version: 'catalog-r1',
    profiles: [vanillaEntry]
  });
  const launchProfile = createLaunchProfiles({ profiles: [vanillaEntry] }, PRODUCT)[0];
  const service = new PatchService({
    gameRoot: path.join(root, 'game'),
    cacheRoot: path.join(root, 'cache'),
    stateFile: path.join(root, 'state.json'),
    localManifestPath: manifestFile,
    allowUnsignedLocalManifest: true,
    product: productForProfile(launchProfile, PRODUCT)
  });
  const result = await service.apply();
  assert.equal(result.manifest.profile.loader, 'vanilla');
  assert.equal(result.manifest.version, 'heroreds-freedom-1.12.2-vanilla-r1');
  assert.equal(result.changedFiles, 0);
  assert.equal((await service.getStatus()).ready, true);
});

test('Minecraft 1.12.2 바닐라 상태는 Forge 없이 준비 완료로 식별한다', () => {
  const profile = createLaunchProfiles({ profiles: [{
    id: 'heroreds-freedom',
    server: { address: 'heroredsfreedom.run.place', port: 25565 },
    minecraft: { version: '1.12.2', loader: 'vanilla', javaRuntimeTarget: 'jre-legacy', javaMajorVersion: 8 },
    pack: { id: 'heroreds-freedom-1.12.2-vanilla', name: 'Vanilla', version: 'r1' }
  }] }, PRODUCT)[0];
  const product = productForProfile(profile, PRODUCT);
  assert.equal(baseStateMatchesProduct({
    minecraftVersion: '1.12.2',
    loader: 'vanilla',
    launchVersionId: '1.12.2',
    javaRuntimeTarget: 'jre-legacy'
  }, product), true);
});

test('서버 프로필별 버전·모드팩·접속 주소를 정규화한다', () => {
  const profiles = createLaunchProfiles({
    distributionManifestUrl: 'https://example.com/default.json',
    profiles: [{
      id: 'season-two',
      name: '시즌 2',
      server: { address: 'play.example.com:25570' },
      minecraft: { version: '1.20.1', forgeVersion: '47.4.0', forgeVersionId: '1.20.1-forge-47.4.0' },
      pack: { id: 'season-two-pack', name: 'Season Two', version: 'r1' }
    }]
  }, PRODUCT);
  assert.equal(profiles[0].server.host, 'play.example.com');
  assert.equal(profiles[0].server.port, 25570);
  assert.equal(profiles[0].minecraft.version, '1.20.1');
  assert.equal(profiles[0].distributionManifestUrl, 'https://example.com/default.json');
  const product = productForProfile(profiles[0], PRODUCT);
  assert.equal(product.pack.id, 'season-two-pack');
  assert.equal(product.server.address, 'play.example.com:25570');
});

test('클라이언트는 시작 자동 모드 갱신과 수동 확인 버튼을 제공한다', async () => {
  const root = path.resolve(__dirname, '..');
  const [mainSource, preloadSource, rendererSource, html] = await Promise.all([
    fs.readFile(path.join(root, 'src', 'main.js'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'preload.js'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'renderer', 'index.html'), 'utf8')
  ]);
  assert.match(mainSource, /syncModeUpdates\(\{ automatic: true \}\)/);
  assert.match(mainSource, /launcher:check-mode-updates/);
  assert.match(preloadSource, /checkModeUpdates/);
  assert.match(rendererSource, /modeUpdateCheck\.addEventListener/);
  assert.match(html, /id="modeUpdateCheckButton"/);
  assert.match(html, /id="modeUpdateStatus"/);
});

test('런처 업데이트는 PowerShell 없이 별도 GUI 도우미에서 백업·롤백·재시작한다', async () => {
  const root = path.resolve(__dirname, '..');
  const [mainSource, serviceSource, helperSource] = await Promise.all([
    fs.readFile(path.join(root, 'src', 'main.js'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'launcher-update-service.js'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'launcher-update-helper.js'), 'utf8')
  ]);
  assert.match(mainSource, /runUpdateHelper/);
  assert.match(mainSource, /updater-electron/);
  assert.doesNotMatch(serviceSource, /powershell|robocopy|apply-update\.ps1/i);
  assert.match(helperSource, /불꽃단 런처 업데이트/);
  assert.match(helperSource, /fsp\.rename\(job\.installRoot, backupRoot\)/);
  assert.match(helperSource, /이전 버전 롤백 완료/);
  assert.match(helperSource, /confirmRestartStayedAlive/);
  assert.match(helperSource, /require\('original-fs'\)/);
  assert.match(helperSource, /window\.setClosable\(true\);\s+window\.close\(\)/);
});

test('Minecraft 전신 스킨은 설정창 밖 메인 화면에 있고 이전 히어로 문구는 제거한다', async () => {
  const html = await fs.readFile(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8'
  );
  const skinPosition = html.indexOf('class="main-skin-showcase"');
  const settingsPosition = html.indexOf('id="settingsPanel"');
  assert.ok(skinPosition >= 0);
  assert.ok(settingsPosition > skinPosition);
  assert.match(html, /id="profileSkinCanvas"/);
  assert.doesNotMatch(html, /저랑 함께 할 준비 되셨슴까/);
  assert.doesNotMatch(html, /ONE CLICK|AUTO UPDATE|LIVE NOTICE/);
});

test('메인 UI는 좌우 공통 기준선으로 스킨·소식·실행 패널을 정렬한다', async () => {
  const css = await fs.readFile(
    path.join(__dirname, '..', 'src', 'renderer', 'styles.css'),
    'utf8'
  );
  assert.match(css, /--content-left:\s*clamp\(/);
  assert.match(css, /--content-right:\s*clamp\(/);
  assert.match(css, /\.main-skin-showcase\s*\{[\s\S]*?left:\s*var\(--content-left\)/);
  assert.match(css, /\.news-panel\s*\{[\s\S]*?left:\s*var\(--content-left\)/);
  assert.match(css, /\.launch-dock\s*\{[\s\S]*?right:\s*var\(--content-right\)/);
});

test('R9 UI는 배경 3장·SOOP 분류 탭·실시간 서버 인원 영역을 제공한다', async () => {
  const rendererRoot = path.join(__dirname, '..', 'src', 'renderer');
  const [html, script] = await Promise.all([
    fs.readFile(path.join(rendererRoot, 'index.html'), 'utf8'),
    fs.readFile(path.join(rendererRoot, 'renderer.js'), 'utf8')
  ]);
  assert.equal((html.match(/class="hero-slide /g) || []).length, 3);
  assert.match(html, /data-category="notice"/);
  assert.match(html, /data-category="secret"/);
  assert.match(html, /id="serverPlayerCount"/);
  assert.match(script, /getServerStatus\(\)/);
  assert.match(script, /showNextBackground/);
  assert.match(script, /activeNewsCategory/);
});

test('QA UI의 기본 버튼은 로그인 대신 설치 검사를 실행한다', async () => {
  const script = await fs.readFile(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
    'utf8'
  );
  assert.match(
    script,
    /if \(state\?\.qaMode\)[\s\S]*?state = await api\.install\(\);[\s\S]*?return;/
  );
});

test('중단된 Java 부분 파일을 정리하고 손상 파일을 재시도한 뒤 기존 파일은 재사용한다', async (context) => {
  const root = await tempDirectory('fire-crew-java-runtime-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const content = Buffer.from('fire-crew-java-runtime-test');
  const sha1 = crypto.createHash('sha1').update(content).digest('hex');
  const javaFile = path.join(root, 'bin', 'java.exe');
  await fs.mkdir(path.dirname(javaFile), { recursive: true });
  await fs.writeFile(`${javaFile}.partial`, 'interrupted');

  let attempts = 0;
  const manifest = {
    files: {
      bin: { type: 'directory' },
      'bin/java.exe': {
        type: 'file',
        executable: true,
        downloads: {
          raw: {
            url: 'https://example.invalid/java.exe',
            sha1,
            size: content.length
          }
        }
      },
      'bin/javaw.exe': {
        type: 'link',
        target: 'java.exe'
      }
    }
  };
  const download = async (_url, destination, options) => {
    attempts += 1;
    assert.equal(await fs.stat(`${destination}.partial`).catch(() => null), null);
    const payload = attempts === 1 ? Buffer.from('corrupt') : content;
    await fs.writeFile(destination, payload);
    options.onProgress?.(payload.length, payload.length);
  };

  await installJavaRuntimeFiles({
    destination: root,
    manifest,
    concurrency: 2,
    download
  });
  assert.equal(attempts, 2);
  assert.deepEqual(await fs.readFile(javaFile), content);
  assert.deepEqual(await fs.readFile(path.join(root, 'bin', 'javaw.exe')), content);

  await installJavaRuntimeFiles({
    destination: root,
    manifest,
    concurrency: 2,
    download
  });
  assert.equal(attempts, 2);
});

test('Java 실행 파일만 남은 중단 설치는 완료 상태로 오인하지 않는다', async (context) => {
  const root = await tempDirectory('fire-crew-java-marker-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const service = new MinecraftService({
    gameRoot: path.join(root, 'game'),
    runtimeRoot,
    baseStateFile: path.join(root, 'base.json'),
    product: PRODUCT
  });
  await fs.mkdir(path.dirname(service.javaExecutable), { recursive: true });
  await fs.writeFile(service.javaExecutable, 'partial-java');
  assert.equal(await service.isRuntimeReady(), false);
  await writeJsonAtomic(path.join(runtimeRoot, '.fire-crew-runtime.json'), {
    target: PRODUCT.minecraft.javaRuntimeTarget,
    verified: true
  });
  assert.equal(await service.isRuntimeReady(), true);
});

test('Mojang Java 매니페스트를 undici 전용 옵션 없이 가져온다', async () => {
  const requests = [];
  const runtimeIndex = {
    'windows-x64': {
      'java-runtime-gamma': [{
        manifest: { url: 'https://example.invalid/runtime.json' },
        version: { name: '17.0.test', released: '2026-07-24T00:00:00Z' }
      }]
    }
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => url.endsWith('all.json')
        ? runtimeIndex
        : { files: { bin: { type: 'directory' } } }
    };
  };
  const manifest = await fetchMojangJavaRuntimeManifest({
    target: 'java-runtime-gamma',
    platformKey: 'windows-x64',
    fetch
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.throwOnError, undefined);
  assert.equal(manifest.target, 'java-runtime-gamma');
  assert.equal(manifest.version.name, '17.0.test');
  assert.deepEqual(manifest.files, { bin: { type: 'directory' } });
});

test('Java 런타임 플랫폼 키를 Windows 아키텍처별로 선택한다', () => {
  assert.equal(resolvePlatformKey('win32', 'x64'), 'windows-x64');
  assert.equal(resolvePlatformKey('win32', 'arm64'), 'windows-arm64');
  assert.equal(resolvePlatformKey('win32', 'ia32'), 'windows-x86');
  assert.equal(PRODUCT.minecraft.javaRuntimeTarget, 'java-runtime-epsilon');
  assert.equal(PRODUCT.minecraft.javaMajorVersion, 25);
});

test('Windows 배포 파일명의 분해형 한글을 NFC 완성형으로 정규화한다', async (context) => {
  const root = await tempDirectory('fire-crew-nfc-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const decomposed = '불꽃단 런처'.normalize('NFD');
  const normalized = '불꽃단 런처'.normalize('NFC');
  await fs.mkdir(path.join(root, decomposed));
  await fs.writeFile(path.join(root, decomposed, `${decomposed}.exe`), 'launcher');
  await normalizeWindowsPackageNames(root);
  assert.equal(await fs.readFile(path.join(root, normalized, `${normalized}.exe`), 'utf8'), 'launcher');
});

test('Windows 패키징이 앱 출력물은 제외하되 의존성의 dist 실행 코드는 보존한다', async () => {
  assert.equal(isBuildIgnored('/test/standalone.test.js'), true);
  assert.equal(isBuildIgnored('/tools/build-windows-package.cjs'), true);
  assert.equal(isBuildIgnored('/admin-signing-key/fire-crew-manifest-private.pem'), true);
  assert.equal(isBuildIgnored('/secrets/another-private.pem'), true);
  assert.equal(isBuildIgnored('/dist/mode-update-safe/불꽃단 런처-win32-x64/resources/app.asar'), true);
  assert.equal(isBuildIgnored('/dist-admin/Fire Crew 모드 관리자.exe'), true);
  assert.equal(isBuildIgnored('/dist-update-fix-check/불꽃단 런처-win32-x64/resources/app.asar'), true);
  assert.equal(isBuildIgnored('/node_modules/@xmcl/user/dist/index.js'), false);
  assert.equal(isBuildIgnored('/node_modules/@xmcl/core/dist/index.js'), false);

  const required = await requiredRuntimeEntries(path.resolve(__dirname, '..'));
  assert.ok(required.includes('node_modules/@xmcl/user/dist/index.js'));
  assert.ok(required.includes('node_modules/@xmcl/core/dist/index.js'));

  const outputRoot = path.resolve('dist');
  const outputs = windowsBuildDirectories(outputRoot);
  assert.ok(outputs.every((entry) => path.dirname(entry) === outputRoot));
});

test('Minecraft 공식 파일 다운로드를 제한된 연결 디스패처로 처리한다', async (context) => {
  const root = await tempDirectory('fire-crew-minecraft-download-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const payload = Buffer.from('fire-crew-download-policy-test');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-length': payload.length,
      'content-type': 'application/java-archive'
    });
    response.end(payload);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const dispatcher = createMinecraftDownloadDispatcher({ connections: 2 });
  context.after(() => dispatcher.close());
  const address = server.address();
  const destination = path.join(root, 'library.jar');
  const sha1 = crypto.createHash('sha1').update(payload).digest('hex');
  await download({
    url: `http://127.0.0.1:${address.port}/library.jar`,
    destination,
    dispatcher,
    validator: { algorithm: 'sha1', hash: sha1 }
  });
  assert.deepEqual(await fs.readFile(destination), payload);
});

test('연결 시간 초과와 해시 오류는 정리 후 최대 3회 재시도한다', async () => {
  let attempts = 0;
  let cleanups = 0;
  const timeout = Object.assign(new Error('Connect Timeout Error'), {
    code: 'UND_ERR_CONNECT_TIMEOUT'
  });
  const aggregate = new AggregateError([timeout, new Error('sha1 checksum not match')]);
  assert.equal(isRetryableInstallError(aggregate), true);
  const result = await retryInstall(async () => {
    attempts += 1;
    if (attempts < 3) throw aggregate;
    return 'installed';
  }, {
    attempts: 3,
    cleanup: async () => { cleanups += 1; },
    sleep: async () => {}
  });
  assert.equal(result, 'installed');
  assert.equal(attempts, 3);
  assert.equal(cleanups, 2);
});

test('실패 후 남은 0바이트 설치 파일만 제거한다', async (context) => {
  const root = await tempDirectory('fire-crew-zero-byte-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const emptyJar = path.join(root, 'libraries', 'empty.jar');
  const validJar = path.join(root, 'libraries', 'valid.jar');
  await fs.mkdir(path.dirname(emptyJar), { recursive: true });
  await fs.writeFile(emptyJar, '');
  await fs.writeFile(validJar, 'valid');
  const removed = await removeZeroByteInstallFiles([path.join(root, 'libraries')]);
  assert.deepEqual(removed, [emptyJar]);
  assert.equal(await fs.stat(emptyJar).catch(() => null), null);
  assert.equal((await fs.readFile(validJar, 'utf8')), 'valid');
});
