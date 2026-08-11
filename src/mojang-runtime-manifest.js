'use strict';

const DEFAULT_RUNTIME_INDEX_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function resolvePlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    if (arch === 'arm64') return 'windows-arm64';
    if (arch === 'ia32' || arch === 'x32') return 'windows-x86';
    return 'windows-x64';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  }
  if (platform === 'linux') {
    if (arch === 'ia32' || arch === 'x32') return 'linux-i386';
    return 'linux';
  }
  throw new Error(`지원하지 않는 운영체제입니다: ${platform}/${arch}`);
}

async function fetchJson(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('런처의 HTTPS 다운로드 기능을 사용할 수 없습니다.');
  }
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Fire-Crew-Launcher'
    },
    redirect: 'follow'
  });
  if (!response?.ok) {
    throw new Error(`Mojang 설치 정보 요청 실패: HTTP ${response?.status ?? 'unknown'}`);
  }
  return response.json();
}

async function fetchMojangJavaRuntimeManifest(options = {}) {
  const target = options.target || 'java-runtime-epsilon';
  const platformKey = options.platformKey
    || resolvePlatformKey(options.platform, options.arch);
  const runtimeIndex = options.runtimeIndex
    || await fetchJson(options.indexUrl || DEFAULT_RUNTIME_INDEX_URL, options.fetch);
  const candidates = runtimeIndex?.[platformKey]?.[target];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`Java 런타임 정보를 찾지 못했습니다: ${platformKey}/${target}`);
  }
  const selected = candidates[0];
  if (!selected?.manifest?.url) {
    throw new Error(`Java 런타임 매니페스트 주소가 없습니다: ${platformKey}/${target}`);
  }
  const manifest = await fetchJson(selected.manifest.url, options.fetch);
  if (!manifest?.files || typeof manifest.files !== 'object') {
    throw new Error('Mojang Java 런타임 매니페스트 형식이 올바르지 않습니다.');
  }
  return {
    files: manifest.files,
    target,
    version: selected.version
  };
}

module.exports = {
  DEFAULT_RUNTIME_INDEX_URL,
  fetchJson,
  fetchMojangJavaRuntimeManifest,
  resolvePlatformKey
};
