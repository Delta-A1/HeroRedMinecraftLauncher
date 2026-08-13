'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { version: launcherVersion } = require('../package.json');

const PRODUCT = Object.freeze({
  name: '불꽃단 런처',
  englishName: 'Fire Crew',
  version: launcherVersion,
  server: {
    name: '불꽃단 서버',
    address: '185.207.166.118:19003',
    host: '185.207.166.118',
    port: 19003
  },
  minecraft: {
    version: '26.2',
    loader: 'forge',
    loaderVersion: '65.0.9',
    forgeVersion: '65.0.9',
    forgeVersionId: '26.2-forge-65.0.9',
    versionId: '26.2-forge-65.0.9',
    javaRuntimeTarget: 'java-runtime-epsilon',
    javaMajorVersion: 25
  },
  pack: {
    id: 'fire-crew-26.2-city-building',
    name: 'Fire Crew 26.2 City Building',
    version: 'fire-crew-26.2-city-building-r2',
    fileId: 0,
    koreanPackName: '',
    koreanPackVersion: 'none'
  },
  soop: {
    streamerId: 'ttobeherored',
    stationName: '레드의 기지',
    stationUrl: 'https://www.sooplive.com/station/ttobeherored',
    menuApi: 'https://api-channel.sooplive.com/v1.1/channel/ttobeherored/menu',
    boardApi: 'https://api-channel.sooplive.com/v1.1/channel/ttobeherored/board?perPage=20&startDate=&endDate=&field=title,contents,user_nick,user_id,hashtags&keyword=&type=all&orderBy=reg_date&page=1',
    boardIds: {
      notice: 117219807,
      secret: 98652685
    }
  }
});

const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  microsoftClientId: '',
  distributionManifestUrl: '',
  distributionPublicKey: '',
  allowUnsignedLocalManifest: true,
  qaBypassMicrosoftLogin: false,
  githubRepository: '',
  githubOAuthClientId: '',
  githubReleaseAsset: '',
  autoUpdateEnabled: true,
  profiles: []
});

function normalizeProfileId(value, fallback = 'default') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function splitServerAddress(address, fallbackPort = 25565) {
  const value = String(address || '').trim();
  const ipv6 = value.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (ipv6) {
    return { host: ipv6[1], port: Number(ipv6[2]) || fallbackPort };
  }
  const separator = value.lastIndexOf(':');
  if (separator > 0 && value.indexOf(':') === separator) {
    return {
      host: value.slice(0, separator),
      port: Number(value.slice(separator + 1)) || fallbackPort
    };
  }
  return { host: value, port: fallbackPort };
}

function createLaunchProfiles(config = {}, product = PRODUCT) {
  const entries = Array.isArray(config.profiles) && config.profiles.length
    ? config.profiles
    : [{}];
  const usedIds = new Set();
  return entries.map((entry, index) => {
    let id = normalizeProfileId(entry.id, index === 0 ? 'default' : `profile-${index + 1}`);
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    const address = String(entry.server?.address || product.server.address).trim();
    const parsedServer = splitServerAddress(address, Number(entry.server?.port) || product.server.port);
    const minecraft = { ...product.minecraft, ...(entry.minecraft || {}) };
    const explicitVersionId = String(entry.minecraft?.versionId || entry.minecraft?.forgeVersionId || '');
    minecraft.loader = String(minecraft.loader || (minecraft.forgeVersion ? 'forge' : 'vanilla')).toLowerCase();
    if (minecraft.loader === 'vanilla') {
      minecraft.loaderVersion = '';
      minecraft.forgeVersion = '';
      minecraft.forgeVersionId = minecraft.version;
      minecraft.versionId = minecraft.version;
    } else {
      const inheritedLoader = String(product.minecraft.loader || (product.minecraft.forgeVersion ? 'forge' : 'vanilla')).toLowerCase();
      minecraft.loaderVersion = String(
        entry.minecraft?.loaderVersion
        || (minecraft.loader === 'forge' ? minecraft.forgeVersion : '')
        || (minecraft.loader === inheritedLoader ? product.minecraft.loaderVersion : '')
        || ''
      );
      if (minecraft.loader === 'forge') {
        minecraft.forgeVersion = minecraft.loaderVersion;
        minecraft.versionId = explicitVersionId || `${minecraft.version}-forge-${minecraft.loaderVersion}`;
        minecraft.forgeVersionId = minecraft.versionId;
      } else {
        minecraft.forgeVersion = '';
        minecraft.versionId = explicitVersionId || `${minecraft.version}-${minecraft.loader}${minecraft.loaderVersion}`;
        minecraft.forgeVersionId = minecraft.versionId;
      }
    }
    const pack = { ...product.pack, ...(entry.pack || {}) };
    return {
      id,
      name: String(entry.name || (index === 0 ? product.server.name : `프로필 ${index + 1}`)).trim(),
      description: String(entry.description || pack.name || '').trim(),
      server: {
        ...product.server,
        ...(entry.server || {}),
        address,
        host: String(entry.server?.host || parsedServer.host).trim(),
        port: Number(entry.server?.port) || parsedServer.port
      },
      minecraft,
      pack,
      distributionManifestUrl: String(entry.distributionManifestUrl ?? config.distributionManifestUrl ?? '').trim(),
      distributionPublicKey: String(entry.distributionPublicKey ?? config.distributionPublicKey ?? ''),
      allowUnsignedLocalManifest: Boolean(
        entry.allowUnsignedLocalManifest ?? config.allowUnsignedLocalManifest
      ),
      bundledManifestPath: entry.bundledManifestPath || config.bundledManifestPath
    };
  });
}

function productForProfile(profile, product = PRODUCT) {
  return {
    ...product,
    server: { ...profile.server },
    minecraft: { ...profile.minecraft },
    pack: { ...profile.pack }
  };
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadRuntimeConfig(appPath, dataRoot) {
  const bundledPath = path.join(appPath, 'assets', 'runtime-config.json');
  const localPath = path.join(dataRoot, 'runtime-config.json');
  const bundled = await readJson(bundledPath, {});
  const local = await readJson(localPath, {});
  return {
    ...DEFAULT_RUNTIME_CONFIG,
    ...bundled,
    ...local,
    bundledManifestPath: path.join(appPath, 'assets', 'distribution-manifest.json')
  };
}

function getRuntimeConfigurationIssues(config) {
  const issues = [];
  if (
    !config.qaBypassMicrosoftLogin
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.microsoftClientId || '')
  ) {
    issues.push({
      id: 'microsoft-client-id',
      message: 'Fire Crew 명의의 Microsoft OAuth 클라이언트 ID가 필요합니다.'
    });
  }
  if (config.distributionManifestUrl) {
    try {
      const url = new URL(config.distributionManifestUrl);
      if (url.protocol !== 'https:') throw new Error('HTTPS required');
    } catch {
      issues.push({
        id: 'distribution-manifest-url',
        message: '배포 매니페스트 주소는 유효한 HTTPS 주소여야 합니다.'
      });
    }
  }
  if (config.distributionManifestUrl && !String(config.distributionPublicKey || '').includes('BEGIN PUBLIC KEY')) {
    issues.push({
      id: 'distribution-public-key',
      message: '원격 패치 검증용 공개 키가 필요합니다.'
    });
  }
  if (config.githubRepository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.githubRepository)) {
    issues.push({
      id: 'github-repository',
      message: 'GitHub 업데이트 저장소는 owner/repository 형식이어야 합니다.'
    });
  }
  return issues;
}

module.exports = {
  createLaunchProfiles,
  DEFAULT_RUNTIME_CONFIG,
  PRODUCT,
  getRuntimeConfigurationIssues,
  loadRuntimeConfig,
  productForProfile,
  readJson
};
