'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { stableStringify, validateManifest } = require('../../src/patch-service');
const { PRODUCT } = require('../../src/config');
const { writeJsonAtomic } = require('../../src/file-utils');

const MAX_MODE_BYTES = 512 * 1024 * 1024;
const MODRINTH_PAGE_HOSTS = new Set(['modrinth.com', 'www.modrinth.com']);

function parseModrinthProjectUrl(urlValue) {
  const url = new URL(String(urlValue || '').trim());
  if (!MODRINTH_PAGE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/^\/(?:mod|plugin|datapack|shader|resourcepack|modpack)\/([^/]+)/i);
  if (!match) throw new Error('Modrinth 프로젝트 페이지 주소를 입력해 주세요.');
  return decodeURIComponent(match[1]);
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
  if (project.project_type === 'modpack') throw new Error('Modrinth 모드팩 페이지는 단일 모드 항목으로 추가할 수 없습니다. 개별 모드 페이지를 사용해 주세요.');
  const version = Array.isArray(versions) ? versions[0] : null;
  const file = version?.files?.find((entry) => entry.primary) || version?.files?.[0];
  if (!file?.url || !file?.filename || !file?.hashes?.sha1) throw new Error(`Minecraft ${minecraftVersion} / ${loader}에 맞는 Modrinth 파일을 찾지 못했습니다.`);
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
  const payload = {
    schemaVersion: 1,
    ready: true,
    version: String(input.version || '').trim(),
    generatedAt: new Date().toISOString(),
    profile: {
      id: PRODUCT.pack.id,
      minecraftVersion: PRODUCT.minecraft.version,
      forgeVersion: PRODUCT.minecraft.forgeVersion,
      packVersion: PRODUCT.pack.version,
      koreanPackVersion: PRODUCT.pack.koreanPackVersion
    },
    archives: Array.isArray(input.archives) ? input.archives : [],
    files: (Array.isArray(input.files) ? input.files : []).map((entry) => ({
      path: String(entry.path || '').trim().replaceAll('\\', '/'),
      url: String(entry.url || '').trim(),
      size: Number(entry.size) || 0,
      hash: { algorithm: String(entry.hash?.algorithm || 'sha256').toLowerCase(), value: String(entry.hash?.value || '').trim().toLowerCase() },
      source: String(entry.source || '').trim()
    })).sort((a, b) => a.path.localeCompare(b.path)),
    remove: [...new Set((Array.isArray(input.remove) ? input.remove : []).map((entry) => String(entry).trim().replaceAll('\\', '/')).filter(Boolean))]
  };
  if (!payload.version) throw new Error('목록 버전이 필요합니다.');
  const seen = new Set();
  for (const entry of payload.files) {
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new Error(`중복된 설치 경로입니다: ${entry.path}`);
    seen.add(key);
  }
  return validateManifest(payload, PRODUCT);
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

async function inspectDownload(urlValue, fetchImpl = fetch) {
  const modrinth = await resolveModrinthProject(urlValue, {}, fetchImpl);
  if (modrinth) return modrinth;
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

module.exports = { createPayload, inspectDownload, normalizeGithubPath, normalizeRepository, parseModrinthProjectUrl, publishManifest, resolveModrinthProject, saveSignedManifest, signPayload };
