'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { stableStringify, validateManifest } = require('../../src/patch-service');
const { createLaunchProfiles, PRODUCT, productForProfile } = require('../../src/config');
const { writeJsonAtomic } = require('../../src/file-utils');

const MAX_MODE_BYTES = 512 * 1024 * 1024;
const MODRINTH_PAGE_HOSTS = new Set(['modrinth.com', 'www.modrinth.com']);
const CURSEFORGE_PAGE_HOSTS = new Set(['curseforge.com', 'www.curseforge.com']);
const CURSEFORGE_API_BASE = 'https://api.curseforge.com/v1';
const CURSEFORGE_MINECRAFT_GAME_ID = 432;
const CURSEFORGE_CLASS_IDS = Object.freeze({ 'mc-mods': 6, modpacks: 4471, 'texture-packs': 12, shaders: 6552 });
const CURSEFORGE_LOADER_TYPES = Object.freeze({ forge: 1, fabric: 4, quilt: 5, neoforge: 6 });

function parseModrinthProjectUrl(urlValue) {
  const url = new URL(String(urlValue || '').trim());
  if (!MODRINTH_PAGE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/^\/(?:mod|plugin|datapack|shader|resourcepack|modpack)\/([^/]+)/i);
  if (!match) throw new Error('Modrinth 프로젝트 페이지 주소를 입력해 주세요.');
  return decodeURIComponent(match[1]);
}

function parseCurseForgeProjectUrl(urlValue) {
  const url = new URL(String(urlValue || '').trim());
  if (!CURSEFORGE_PAGE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0]?.toLowerCase() !== 'minecraft') throw new Error('Minecraft CurseForge 프로젝트 주소를 입력해 주세요.');
  const section = String(parts[1] || '').toLowerCase();
  const slug = String(parts[2] || '').trim();
  if (!CURSEFORGE_CLASS_IDS[section] || !slug) throw new Error('CurseForge 모드 또는 모드팩 프로젝트 주소를 입력해 주세요.');
  const fileMarker = parts.findIndex((part) => ['files', 'download'].includes(part.toLowerCase()));
  const fileId = fileMarker >= 0 && /^\d+$/.test(parts[fileMarker + 1] || '') ? Number(parts[fileMarker + 1]) : 0;
  return { slug, section, classId: CURSEFORGE_CLASS_IDS[section], fileId };
}

async function readDownloadBuffer(url, fetchImpl, headers = {}) {
  const response = await fetchImpl(url, { redirect: 'follow', headers });
  if (!response.ok) throw new Error(`모드팩 다운로드 실패 (HTTP ${response.status})`);
  const declaredSize = Number(response.headers?.get?.('content-length') || 0);
  if (declaredSize > MAX_MODE_BYTES) throw new Error('모드팩이 512MB 제한을 초과합니다.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_MODE_BYTES) throw new Error('모드팩이 512MB 제한을 초과합니다.');
  return buffer;
}

function archiveFiles(zip, prefix) {
  const normalized = String(prefix || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  return zip.getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName.replaceAll('\\', '/').replace(/^\/+/, ''))
    .filter((entry) => !normalized || entry.startsWith(`${normalized}/`))
    .map((entry) => normalized ? entry.slice(normalized.length + 1) : entry)
    .filter((entry) => entry && !/^(saves|screenshots)(\/|$)/i.test(entry) && !/^servers\.dat$/i.test(entry));
}

function archiveHasPrefix(zip, prefix) {
  const normalized = `${String(prefix).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')}/`;
  return zip.getEntries().some((entry) => entry.entryName.replaceAll('\\', '/').replace(/^\/+/, '').startsWith(normalized));
}

function chunks(values, size = 50) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function archiveDescriptor(id, url, buffer, prefix, zip) {
  return {
    id: String(id).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase(),
    url,
    size: buffer.length,
    hash: { algorithm: 'sha256', value: crypto.createHash('sha256').update(buffer).digest('hex') },
    prefix: `${String(prefix || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')}/`,
    destination: '',
    managedFiles: archiveFiles(zip, prefix)
  };
}

async function modrinthJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'Fire-Crew-Mode-Manager/1.0 (github.com/Delta-A1/HeroRedMinecraftLauncher)' } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.description || `Modrinth 조회 실패 (HTTP ${response.status})`);
  return body;
}

async function resolveModrinthProject(urlValue, options = {}, fetchImpl = fetch) {
  const slug = parseModrinthProjectUrl(urlValue);
  if (!slug) return null;
  const minecraftVersion = String(options.minecraftVersion || PRODUCT.minecraft.version);
  const loader = String(options.loader || 'forge').toLowerCase();
  const query = new URLSearchParams({ loaders: JSON.stringify([loader]), game_versions: JSON.stringify([minecraftVersion]), include_changelog: 'false' });
  const projectUrl = `https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}`;
  const versionsUrl = `${projectUrl}/version?${query}`;
  const [project, versions] = await Promise.all([modrinthJson(projectUrl, fetchImpl), modrinthJson(versionsUrl, fetchImpl)]);
  const version = Array.isArray(versions) ? versions[0] : null;
  const file = version?.files?.find((entry) => entry.primary) || version?.files?.[0];
  if (!file?.url || !file?.filename || !file?.hashes?.sha1) throw new Error(`Minecraft ${minecraftVersion} / ${loader}에 맞는 Modrinth 파일을 찾지 못했습니다.`);
  if (project.project_type === 'modpack') {
    const buffer = await readDownloadBuffer(file.url, fetchImpl, { 'User-Agent': 'Fire-Crew-Mode-Manager/1.0' });
    const zip = new AdmZip(buffer);
    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) throw new Error('Modrinth 모드팩에서 modrinth.index.json을 찾지 못했습니다.');
    const index = JSON.parse(indexEntry.getData().toString('utf8'));
    const files = (Array.isArray(index.files) ? index.files : [])
      .filter((entry) => entry.env?.client !== 'unsupported')
      .map((entry) => {
        const downloadUrl = entry.downloads?.find((value) => /^https:\/\//i.test(value));
        const sha1 = String(entry.hashes?.sha1 || '').toLowerCase();
        if (!downloadUrl || !/^[0-9a-f]{40}$/.test(sha1)) throw new Error(`모드팩 파일 메타데이터가 올바르지 않습니다: ${entry.path || '알 수 없는 파일'}`);
        return {
          path: String(entry.path || '').replaceAll('\\', '/'),
          url: downloadUrl,
          size: Number(entry.fileSize) || 0,
          hash: { algorithm: 'sha1', value: sha1 },
          source: `${project.title || slug} · Modrinth 모드팩`
        };
      });
    const archiveGroup = `modrinth-${slug}`;
    const prefixes = ['overrides', 'client-overrides'].filter((prefix) => archiveHasPrefix(zip, prefix));
    return {
      type: 'modpack',
      files,
      archiveGroup,
      archives: prefixes.map((prefix) => archiveDescriptor(`${archiveGroup}-${prefix}`, file.url, buffer, prefix, zip)),
      source: `${project.title || slug} · ${version.name || version.version_number} · Modrinth 모드팩`,
      compatibility: { minecraftVersion, loader, versionId: version.id || '', versionNumber: version.version_number || '' }
    };
  }
  const folder = project.project_type === 'resourcepack' ? 'resourcepacks' : project.project_type === 'shader' ? 'shaderpacks' : 'mods';
  return {
    url: file.url,
    path: `${folder}/${file.filename}`,
    size: Number(file.size) || 0,
    hash: { algorithm: 'sha1', value: String(file.hashes.sha1).toLowerCase() },
    source: `${project.title || slug} · ${version.name || version.version_number} · Modrinth`,
    compatibility: { minecraftVersion, loader, versionId: version.id || '', versionNumber: version.version_number || '' }
  };
}

async function curseforgeJson(url, apiKey, fetchImpl, options = {}) {
  if (!String(apiKey || '').trim()) throw new Error('CurseForge 링크 자동 확인에는 CurseForge API 키가 필요합니다.');
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': String(apiKey).trim(),
      'User-Agent': 'Fire-Crew-Mode-Manager/1.0',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) {
    throw new Error(`CurseForge Core API가 키를 거부했습니다 (HTTP ${response.status}). 승인된 제3자 개발자용 API 키인지 확인해 주세요. 업로드 API 토큰이나 CurseForge 계정 토큰은 사용할 수 없습니다.`);
  }
  if (!response.ok) throw new Error(body?.error || body?.message || `CurseForge 조회 실패 (HTTP ${response.status})`);
  return body?.data ?? body;
}

async function validateCurseForgeApiKey(apiKey, fetchImpl = fetch) {
  const game = await curseforgeJson(`${CURSEFORGE_API_BASE}/games/${CURSEFORGE_MINECRAFT_GAME_ID}`, apiKey, fetchImpl);
  if (Number(game?.id) !== CURSEFORGE_MINECRAFT_GAME_ID) throw new Error('CurseForge API 키로 Minecraft 정보를 확인하지 못했습니다.');
  return { valid: true, game: game.name || 'Minecraft' };
}

function curseforgeHash(file) {
  const hash = file?.hashes?.find((entry) => Number(entry.algo) === 1)
    || file?.hashes?.find((entry) => Number(entry.algo) === 2);
  if (!hash) throw new Error(`${file?.fileName || 'CurseForge 파일'}에 검증 가능한 해시가 없습니다.`);
  return { algorithm: Number(hash.algo) === 1 ? 'sha1' : 'md5', value: String(hash.value).toLowerCase() };
}

function curseforgeFolder(project) {
  if (Number(project?.classId) === 12) return 'resourcepacks';
  if (Number(project?.classId) === 6552) return 'shaderpacks';
  return 'mods';
}

function curseforgePackCompatibility(manifest, fallback = {}) {
  const minecraftVersion = String(manifest?.minecraft?.version || fallback.minecraftVersion || '');
  const loaders = Array.isArray(manifest?.minecraft?.modLoaders) ? manifest.minecraft.modLoaders : [];
  const primary = loaders.find((entry) => entry?.primary) || loaders[0] || {};
  const match = String(primary.id || '').match(/^([a-z]+)-(.+)$/i);
  const loader = String(match?.[1] || fallback.loader || 'vanilla').toLowerCase();
  const loaderVersion = String(match?.[2] || '');
  return {
    minecraftVersion,
    loader,
    loaderVersion,
    versionId: loader === 'vanilla' || !loaderVersion
      ? minecraftVersion
      : loader === 'fabric' ? `${minecraftVersion}-fabric${loaderVersion}` : `${minecraftVersion}-${loader}-${loaderVersion}`
  };
}

async function curseforgeDownloadUrl(file, apiKey, fetchImpl) {
  if (file?.downloadUrl) return file.downloadUrl;
  const result = await curseforgeJson(`${CURSEFORGE_API_BASE}/mods/${file.modId}/files/${file.id}/download-url`, apiKey, fetchImpl).catch(() => '');
  if (typeof result === 'string' && /^https:\/\//i.test(result)) return result;
  throw new Error(`${file?.fileName || '이 파일'}은 CurseForge 정책상 외부 런처 자동 다운로드가 허용되지 않습니다.`);
}

async function resolveCurseForgeProject(urlValue, options = {}, fetchImpl = fetch) {
  const parsed = parseCurseForgeProjectUrl(urlValue);
  if (!parsed) return null;
  const apiKey = options.curseforgeApiKey || options.apiKey;
  const minecraftVersion = String(options.minecraftVersion || PRODUCT.minecraft.version);
  const loader = String(options.loader || 'forge').toLowerCase();
  const search = new URLSearchParams({
    gameId: String(CURSEFORGE_MINECRAFT_GAME_ID),
    classId: String(parsed.classId),
    slug: parsed.slug,
    pageSize: '1'
  });
  const projects = await curseforgeJson(`${CURSEFORGE_API_BASE}/mods/search?${search}`, apiKey, fetchImpl);
  const project = Array.isArray(projects) ? projects.find((entry) => entry.slug === parsed.slug) || projects[0] : null;
  if (!project) throw new Error(`CurseForge 프로젝트를 찾지 못했습니다: ${parsed.slug}`);
  let file;
  let usedCompatibilityFallback = false;
  if (parsed.fileId) {
    file = await curseforgeJson(`${CURSEFORGE_API_BASE}/mods/${project.id}/files/${parsed.fileId}`, apiKey, fetchImpl);
  } else {
    const query = new URLSearchParams({ gameVersion: minecraftVersion, pageSize: '50' });
    if (CURSEFORGE_LOADER_TYPES[loader]) query.set('modLoaderType', String(CURSEFORGE_LOADER_TYPES[loader]));
    const files = await curseforgeJson(`${CURSEFORGE_API_BASE}/mods/${project.id}/files?${query}`, apiKey, fetchImpl);
    file = Array.isArray(files) ? files[0] : null;
    if (!file && parsed.section === 'modpacks') {
      usedCompatibilityFallback = true;
      if (Number(project.mainFileId)) {
        file = await curseforgeJson(`${CURSEFORGE_API_BASE}/mods/${project.id}/files/${project.mainFileId}`, apiKey, fetchImpl);
      } else {
        const latestFiles = await curseforgeJson(`${CURSEFORGE_API_BASE}/mods/${project.id}/files?pageSize=50`, apiKey, fetchImpl);
        file = Array.isArray(latestFiles) ? latestFiles.find((entry) => !entry.isServerPack) || latestFiles[0] : null;
      }
    }
  }
  if (!file?.id || !file?.fileName) throw new Error(`Minecraft ${minecraftVersion} / ${loader}에 맞는 CurseForge 파일을 찾지 못했습니다. 모드팩 프로필의 게임 버전과 로더를 확인해 주세요.`);
  const downloadUrl = await curseforgeDownloadUrl(file, apiKey, fetchImpl);
  if (parsed.section !== 'modpacks') {
    return {
      url: downloadUrl,
      path: `${curseforgeFolder(project)}/${file.fileName}`,
      size: Number(file.fileLength) || 0,
      hash: curseforgeHash(file),
      source: `${project.name || parsed.slug} · ${file.displayName || file.fileName} · CurseForge`,
      compatibility: { minecraftVersion, loader, versionId: String(file.id), versionNumber: file.displayName || file.fileName }
    };
  }

  const buffer = await readDownloadBuffer(downloadUrl, fetchImpl, { 'User-Agent': 'Fire-Crew-Mode-Manager/1.0' });
  const zip = new AdmZip(buffer);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new Error('CurseForge 모드팩에서 manifest.json을 찾지 못했습니다.');
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  const packCompatibility = curseforgePackCompatibility(manifest, { minecraftVersion, loader });
  if (!['vanilla', 'forge', 'fabric'].includes(packCompatibility.loader)) {
    throw new Error(`이 모드팩의 ${packCompatibility.loader} 구동기는 현재 Fire Crew 클라이언트에서 지원하지 않습니다.`);
  }
  const declared = (Array.isArray(manifest.files) ? manifest.files : []).filter((entry) => entry.required !== false);
  const fileIds = declared.map((entry) => Number(entry.fileID)).filter(Number.isFinite);
  const projectIds = [...new Set(declared.map((entry) => Number(entry.projectID)).filter(Number.isFinite))];
  const [packFileGroups, packProjectGroups] = await Promise.all([
    Promise.all(chunks(fileIds).map((ids) => curseforgeJson(`${CURSEFORGE_API_BASE}/mods/files`, apiKey, fetchImpl, { method: 'POST', body: JSON.stringify({ fileIds: ids }) }))),
    Promise.all(chunks(projectIds).map((ids) => curseforgeJson(`${CURSEFORGE_API_BASE}/mods`, apiKey, fetchImpl, { method: 'POST', body: JSON.stringify({ modIds: ids }) })))
  ]);
  const filesById = new Map(packFileGroups.flat().map((entry) => [Number(entry.id), entry]));
  const projectsById = new Map(packProjectGroups.flat().map((entry) => [Number(entry.id), entry]));
  const files = [];
  for (const declaredFile of declared) {
    const dependency = filesById.get(Number(declaredFile.fileID));
    const dependencyProject = projectsById.get(Number(declaredFile.projectID));
    if (!dependency) throw new Error(`CurseForge 모드팩 파일 정보를 찾지 못했습니다: ${declaredFile.projectID}/${declaredFile.fileID}`);
    files.push({
      path: `${curseforgeFolder(dependencyProject)}/${dependency.fileName}`,
      url: await curseforgeDownloadUrl(dependency, apiKey, fetchImpl),
      size: Number(dependency.fileLength) || 0,
      hash: curseforgeHash(dependency),
      source: `${dependencyProject?.name || declaredFile.projectID} · CurseForge ${dependency.id}`
    });
  }
  const prefix = String(manifest.overrides || 'overrides').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  return {
    type: 'modpack',
    files,
    archiveGroup: `curseforge-${parsed.slug}`,
    archives: [archiveDescriptor(`curseforge-${parsed.slug}-overrides`, downloadUrl, buffer, prefix, zip)],
    source: `${project.name || parsed.slug} · ${file.displayName || file.fileName} · CurseForge 모드팩`,
    compatibility: { ...packCompatibility, fileId: String(file.id), versionNumber: file.displayName || file.fileName, usedFallback: usedCompatibilityFallback },
    profileUpdate: {
      minecraftVersion: packCompatibility.minecraftVersion,
      loader: packCompatibility.loader,
      loaderVersion: packCompatibility.loaderVersion,
      versionId: packCompatibility.versionId,
      packName: project.name || parsed.slug,
      packVersion: String(manifest.version || file.displayName || file.id)
    }
  };
}

function normalizeRepository(value) {
  const repository = String(value || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GitHub 저장소는 owner/repository 형식이어야 합니다.');
  return repository;
}

function normalizeGithubPath(value) {
  const result = String(value || '').trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (!result || result.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('GitHub 파일 경로가 올바르지 않습니다.');
  return result;
}

function createPayload(input) {
  const inputProfiles = Array.isArray(input.profiles) && input.profiles.length
    ? input.profiles
    : [{
      id: 'fire-crew-main',
      name: PRODUCT.server.name,
      server: PRODUCT.server,
      minecraft: PRODUCT.minecraft,
      pack: PRODUCT.pack,
      version: input.version,
      archives: input.archives,
      files: input.files,
      remove: input.remove
    }];
  const ids = new Set();
  const packIds = new Set();
  const profiles = inputProfiles.map((entry, index) => {
    const normalized = createLaunchProfiles({ profiles: [entry] }, PRODUCT)[0];
    if (!String(entry.id || '').trim()) throw new Error(`프로필 ${index + 1}의 ID가 필요합니다.`);
    if (!String(entry.pack?.id || '').trim()) throw new Error(`${entry.name || `프로필 ${index + 1}`}의 모드팩 ID가 필요합니다.`);
    if (!String(entry.server?.address || '').trim()) throw new Error(`${entry.name || `프로필 ${index + 1}`}의 서버 주소가 필요합니다.`);
    if (!String(entry.minecraft?.version || '').trim()) throw new Error(`${entry.name || `프로필 ${index + 1}`}의 Minecraft 버전이 필요합니다.`);
    if (ids.has(normalized.id)) throw new Error(`중복된 프로필 ID입니다: ${normalized.id}`);
    if (packIds.has(normalized.pack.id)) throw new Error(`중복된 모드팩 ID입니다: ${normalized.pack.id}`);
    ids.add(normalized.id);
    packIds.add(normalized.pack.id);
    const files = (Array.isArray(entry.files) ? entry.files : []).map((file) => ({
      path: String(file.path || '').trim().replaceAll('\\', '/'),
      url: String(file.url || '').trim(),
      size: Number(file.size) || 0,
      hash: {
        algorithm: String(file.hash?.algorithm || 'sha256').toLowerCase(),
        value: String(file.hash?.value || '').trim().toLowerCase()
      },
      source: String(file.source || '').trim()
    })).sort((a, b) => a.path.localeCompare(b.path));
    const seen = new Set();
    for (const file of files) {
      const key = file.path.toLowerCase();
      if (seen.has(key)) throw new Error(`중복된 설치 경로입니다: ${file.path}`);
      seen.add(key);
    }
    return {
      id: normalized.id,
      name: normalized.name,
      description: normalized.description,
      version: String(entry.version || normalized.pack.version || input.version || '').trim(),
      ready: entry.ready !== false,
      server: normalized.server,
      minecraft: normalized.minecraft,
      pack: normalized.pack,
      archives: Array.isArray(entry.archives) ? entry.archives : [],
      files,
      remove: [...new Set((Array.isArray(entry.remove) ? entry.remove : [])
        .map((value) => String(value).trim().replaceAll('\\', '/')).filter(Boolean))]
    };
  });
  const payload = {
    schemaVersion: 2,
    ready: true,
    version: String(input.version || '').trim(),
    generatedAt: new Date().toISOString(),
    profiles
  };
  if (!payload.version) throw new Error('목록 버전이 필요합니다.');
  for (const profile of profiles) {
    if (!profile.version) throw new Error(`${profile.name}의 프로필 버전이 필요합니다.`);
    validateManifest(payload, productForProfile(profile, PRODUCT));
  }
  return payload;
}

function signPayload(payload, privateKey, expectedPublicKey = '') {
  if (!String(privateKey || '').includes('BEGIN PRIVATE KEY')) throw new Error('Ed25519 개인 키를 선택해 주세요.');
  const signature = crypto.sign(null, Buffer.from(stableStringify(payload), 'utf8'), privateKey).toString('base64');
  if (expectedPublicKey && !crypto.verify(
    null,
    Buffer.from(stableStringify(payload), 'utf8'),
    expectedPublicKey,
    Buffer.from(signature, 'base64')
  )) throw new Error('선택한 개인 키가 런처에 등록된 공개 키와 일치하지 않습니다.');
  return { payload, signature };
}

async function saveSignedManifest(file, input, privateKeyFile) {
  const privateKey = await fs.readFile(privateKeyFile, 'utf8');
  const envelope = signPayload(createPayload(input), privateKey);
  await writeJsonAtomic(path.resolve(file), envelope);
  return envelope;
}

async function inspectDownload(urlValue, options = {}, fetchImpl = fetch) {
  if (typeof options === 'function') {
    fetchImpl = options;
    options = {};
  }
  const modrinth = await resolveModrinthProject(urlValue, options, fetchImpl);
  if (modrinth) return modrinth;
  const curseforge = await resolveCurseForgeProject(urlValue, options, fetchImpl);
  if (curseforge) return curseforge;
  const url = new URL(String(urlValue || '').trim());
  if (url.protocol !== 'https:') throw new Error('모드 URL은 HTTPS여야 합니다.');
  const response = await fetchImpl(url, { redirect: 'follow', headers: { 'User-Agent': 'Fire-Crew-Mode-Manager/1.0' } });
  if (!response.ok || !response.body) throw new Error(`파일 확인 실패 (HTTP ${response.status})`);
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_MODE_BYTES) throw new Error('파일이 512MB 제한을 초과합니다.');
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_MODE_BYTES) throw new Error('파일이 512MB 제한을 초과합니다.');
    hash.update(chunk);
  }
  return { size, hash: { algorithm: 'sha256', value: hash.digest('hex') } };
}

async function githubRequest(url, token, options = {}, fetchImpl = fetch) {
  if (!String(token || '').trim()) throw new Error('GitHub 토큰이 필요합니다.');
  const response = await fetchImpl(url, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${String(token).trim()}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Fire-Crew-Mode-Manager/1.0', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `GitHub 요청 실패 (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function publishManifest(options, envelope, fetchImpl = fetch) {
  const repository = normalizeRepository(options.repository);
  const filePath = normalizeGithubPath(options.path);
  const branch = String(options.branch || 'main').trim();
  const base = `https://api.github.com/repos/${repository}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  let current = null;
  try {
    current = await githubRequest(`${base}?ref=${encodeURIComponent(branch)}`, options.token, {}, fetchImpl);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const result = await githubRequest(base, options.token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: String(options.message || `Update mode list ${envelope.payload.version}`).trim(),
      content: Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8').toString('base64'),
      branch,
      ...(current?.sha ? { sha: current.sha } : {})
    })
  }, fetchImpl);
  return { commitUrl: result.commit?.html_url || '', rawUrl: `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/${filePath}` };
}

module.exports = { createPayload, inspectDownload, normalizeGithubPath, normalizeRepository, parseCurseForgeProjectUrl, parseModrinthProjectUrl, publishManifest, resolveCurseForgeProject, resolveModrinthProject, saveSignedManifest, signPayload, validateCurseForgeApiKey };
