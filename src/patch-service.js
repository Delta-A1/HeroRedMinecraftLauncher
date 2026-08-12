'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const {
  downloadFile,
  ensureDirectory,
  hashFile,
  mapLimit,
  normalizeRelativePath,
  pathExists,
  readJson,
  resolveInside,
  writeJsonAtomic
} = require('./file-utils');
const { quarantineRuleFor } = require('./core');

class DistributionConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DistributionConfigurationError';
    this.code = 'DISTRIBUTION_CONFIGURATION_REQUIRED';
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function verifyManifestEnvelope(envelope, publicKey, allowUnsigned = false) {
  const payload = envelope?.payload || envelope;
  const signature = envelope?.payload ? envelope.signature : '';
  if (!signature) {
    if (!allowUnsigned) throw new Error('패치 매니페스트 서명이 없습니다.');
    return payload;
  }
  if (!String(publicKey || '').includes('BEGIN PUBLIC KEY')) {
    throw new Error('패치 매니페스트 공개 키가 설정되지 않았습니다.');
  }
  const valid = crypto.verify(
    null,
    Buffer.from(stableStringify(payload), 'utf8'),
    publicKey,
    Buffer.from(signature, 'base64')
  );
  if (!valid) throw new Error('패치 매니페스트 서명 검증에 실패했습니다.');
  return payload;
}

function validateHash(value) {
  const algorithm = String(value?.algorithm || '').toLowerCase();
  const hash = String(value?.value || '').toLowerCase();
  if (!['sha256', 'sha1', 'md5'].includes(algorithm)) throw new Error('지원하지 않는 파일 해시 형식입니다.');
  const expectedLength = { sha256: 64, sha1: 40, md5: 32 }[algorithm];
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(hash)) throw new Error('잘못된 파일 해시 값입니다.');
  return { algorithm, value: hash };
}

function validateHttpsUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== 'https:') throw new Error(`HTTPS가 아닌 배포 주소입니다: ${url.hostname}`);
  return url.toString();
}

function validateManifest(payload, product) {
  if (Number(payload?.schemaVersion) !== 1) throw new Error('지원하지 않는 패치 매니페스트 버전입니다.');
  if (payload?.profile?.id !== product.pack.id) throw new Error('다른 모드팩용 패치 매니페스트입니다.');
  if (payload.profile.minecraftVersion !== product.minecraft.version) throw new Error('Minecraft 버전이 서버 구성과 다릅니다.');
  if (payload.profile.forgeVersion !== product.minecraft.forgeVersion) throw new Error('Forge 버전이 서버 구성과 다릅니다.');
  const files = Array.isArray(payload.files) ? payload.files.map((entry) => ({
    path: normalizeRelativePath(entry.path),
    url: validateHttpsUrl(entry.url),
    size: Number(entry.size) || 0,
    hash: validateHash(entry.hash),
    source: String(entry.source || '')
  })) : [];
  const archives = Array.isArray(payload.archives) ? payload.archives.map((entry) => ({
    id: String(entry.id || ''),
    url: validateHttpsUrl(entry.url),
    size: Number(entry.size) || 0,
    hash: validateHash(entry.hash),
    prefix: String(entry.prefix || ''),
    destination: String(entry.destination || ''),
    managedFiles: Array.isArray(entry.managedFiles) ? entry.managedFiles.map(String) : []
  })) : [];
  const remove = Array.isArray(payload.remove) ? payload.remove.map(normalizeRelativePath) : [];
  return {
    ...payload,
    ready: payload.ready === true,
    files,
    archives,
    remove
  };
}

class PatchService {
  constructor(options) {
    this.gameRoot = options.gameRoot;
    this.cacheRoot = options.cacheRoot;
    this.stateFile = options.stateFile;
    this.manifestCacheFile = options.manifestCacheFile;
    this.manifestUrl = options.manifestUrl;
    this.localManifestPath = options.localManifestPath;
    this.publicKey = options.publicKey;
    this.allowUnsignedLocalManifest = options.allowUnsignedLocalManifest === true;
    this.product = options.product;
    this.onProgress = options.onProgress;
    this.onLog = options.onLog;
  }

  async loadManifest() {
    let envelope;
    let remote = false;
    if (this.manifestUrl) {
      remote = true;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(this.manifestUrl, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
              'Cache-Control': 'no-cache',
              'User-Agent': 'Fire-Crew-Launcher/1.0.0'
            }
          });
          if (!response.ok) throw new Error(`패치 정보 조회 실패 (HTTP ${response.status})`);
          envelope = await response.json();
          verifyManifestEnvelope(envelope, this.publicKey, false);
          if (this.manifestCacheFile) await writeJsonAtomic(this.manifestCacheFile, envelope);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        envelope = this.manifestCacheFile ? await readJson(this.manifestCacheFile, null) : null;
        if (!envelope && this.localManifestPath) {
          envelope = await readJson(this.localManifestPath, null);
          remote = false;
        }
        if (!envelope) throw error;
        this.onLog?.(`패치 서버 연결 실패, 마지막 검증 정보를 사용합니다: ${error.message}`, 'warning');
      }
    } else {
      envelope = await readJson(this.localManifestPath, null);
    }
    if (!envelope) throw new DistributionConfigurationError('배포 매니페스트를 찾지 못했습니다.');
    const payload = verifyManifestEnvelope(
      envelope,
      this.publicKey,
      !remote && this.allowUnsignedLocalManifest
    );
    return validateManifest(payload, this.product);
  }

  async getStatus(options = {}) {
    const manifest = await this.loadManifest();
    const installed = await readJson(this.stateFile, {});
    if (!manifest.ready) {
      return {
        configured: false,
        ready: false,
        version: manifest.version || '',
        changedFiles: manifest.files.length,
        message: manifest.message || '관리자용 배포 매니페스트 생성이 필요합니다.'
      };
    }
    const changed = [];
    for (const file of manifest.files) {
      const current = installed.files?.[file.path];
      if (!await this.fileMatches(file, current, options.verifyAll === true)) changed.push(file.path);
    }
    const archiveChanged = manifest.archives.filter((entry) =>
      installed.archives?.[entry.id]?.hash !== entry.hash.value
    );
    const profileMatches = installed.profileId === manifest.profile.id
      && installed.version === manifest.version;
    return {
      configured: true,
      ready: profileMatches && changed.length === 0 && archiveChanged.length === 0,
      version: manifest.version,
      changedFiles: changed.length + archiveChanged.length,
      message: changed.length || archiveChanged.length ? '새 패치가 있습니다.' : '최신 상태입니다.',
      manifest
    };
  }

  async fileMatches(entry, previous, verifyAll) {
    const destination = resolveInside(this.gameRoot, entry.path);
    try {
      const stat = await fs.stat(destination);
      if (!stat.isFile()) return false;
      if (entry.size > 0 && stat.size !== entry.size) return false;
      if (!verifyAll
        && previous?.hash === entry.hash.value
        && previous?.algorithm === entry.hash.algorithm
        && previous?.size === stat.size
        && Math.trunc(previous?.mtimeMs || 0) === Math.trunc(stat.mtimeMs)) {
        return true;
      }
      return await hashFile(destination, entry.hash.algorithm) === entry.hash.value;
    } catch {
      return false;
    }
  }

  async ensureCached(entry, cacheName, progressCallback) {
    const destination = resolveInside(this.cacheRoot, cacheName);
    let valid = false;
    try {
      const stat = await fs.stat(destination);
      valid = (!entry.size || stat.size === entry.size)
        && await hashFile(destination, entry.hash.algorithm) === entry.hash.value;
    } catch {
      valid = false;
    }
    if (!valid) {
      await downloadFile(entry.url, destination, { onProgress: progressCallback });
      const digest = await hashFile(destination, entry.hash.algorithm);
      if (digest !== entry.hash.value) {
        await fs.rm(destination, { force: true });
        throw new Error(`다운로드한 파일의 무결성 검증에 실패했습니다: ${cacheName}`);
      }
    }
    return destination;
  }

  async applyArchives(manifest, installed, options = {}) {
    const nextArchives = {};
    for (let index = 0; index < manifest.archives.length; index += 1) {
      const entry = manifest.archives[index];
      const previous = installed.archives?.[entry.id];
      if (!options.repair && previous?.hash === entry.hash.value) {
        nextArchives[entry.id] = previous;
        continue;
      }
      this.onProgress?.('모드팩 설정 적용', 48 + Math.round((index / Math.max(1, manifest.archives.length)) * 8), entry.id);
      const archive = await this.ensureCached(
        entry,
        `archives/${entry.id}-${entry.hash.value.slice(0, 12)}.zip`
      );
      const zip = new AdmZip(archive);
      const prefix = entry.prefix.replaceAll('\\', '/').replace(/^\/+/, '');
      for (const zipEntry of zip.getEntries()) {
        if (zipEntry.isDirectory) continue;
        const archivePath = zipEntry.entryName.replaceAll('\\', '/').replace(/^\/+/, '');
        if (prefix && !archivePath.startsWith(prefix)) continue;
        const relative = archivePath.slice(prefix.length).replace(/^\/+/, '');
        if (!relative) continue;
        const destinationRelative = [entry.destination, relative].filter(Boolean).join('/');
        if (/^(saves|screenshots)(\/|$)/i.test(destinationRelative) || /^servers\.dat$/i.test(destinationRelative)) continue;
        const destination = resolveInside(this.gameRoot, destinationRelative);
        await ensureDirectory(path.dirname(destination));
        const temp = `${destination}.partial`;
        await fs.writeFile(temp, zipEntry.getData());
        await fs.rm(destination, { force: true });
        await fs.rename(temp, destination);
      }
      const nextManaged = new Set(entry.managedFiles);
      for (const stale of previous?.managedFiles || []) {
        if (!nextManaged.has(stale)) {
          await this.quarantineFile(stale, '새 모드팩 설정에서 제거된 파일');
        }
      }
      nextArchives[entry.id] = {
        hash: entry.hash.value,
        appliedAt: new Date().toISOString(),
        managedFiles: entry.managedFiles
      };
    }
    return nextArchives;
  }

  async quarantineFile(relativePath, reason) {
    const source = resolveInside(this.gameRoot, relativePath);
    if (!await pathExists(source)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = resolveInside(
      this.gameRoot,
      `disabled-by-fire-crew/${stamp}/${relativePath}`
    );
    await ensureDirectory(path.dirname(destination));
    await fs.rename(source, destination);
    this.onLog?.(`${relativePath} 비활성화: ${reason}`, 'warning');
    return { path: relativePath, destination, reason };
  }

  async apply(options = {}) {
    const manifest = await this.loadManifest();
    if (!manifest.ready) {
      throw new DistributionConfigurationError(
        manifest.message || '관리자용 배포 매니페스트 생성이 필요합니다.'
      );
    }
    const installed = await readJson(this.stateFile, {});
    await ensureDirectory(this.gameRoot);
    await ensureDirectory(this.cacheRoot);
    this.onProgress?.('패치 정보 확인', 45, `${manifest.files.length}개 파일 검사`);

    const archives = await this.applyArchives(manifest, installed, options);
    const changed = [];
    for (const entry of manifest.files) {
      if (!await this.fileMatches(entry, installed.files?.[entry.path], options.repair === true)) {
        changed.push(entry);
      }
    }

    let completed = 0;
    await mapLimit(changed, 6, async (entry) => {
      const cacheName = `files/${entry.hash.value.slice(0, 2)}/${entry.hash.value}`;
      const cached = await this.ensureCached(entry, cacheName, (received, total) => {
        const ratio = total ? received / total : 0;
        const overall = completed + ratio;
        const percent = 57 + Math.round((overall / Math.max(1, changed.length)) * 29);
        this.onProgress?.('클라이언트 패치', percent, `${completed + 1} / ${changed.length} · ${path.basename(entry.path)}`);
      });
      const destination = resolveInside(this.gameRoot, entry.path);
      await ensureDirectory(path.dirname(destination));
      const temp = `${destination}.partial`;
      await fs.copyFile(cached, temp);
      await fs.rm(destination, { force: true });
      await fs.rename(temp, destination);
      completed += 1;
      this.onProgress?.('클라이언트 패치', 57 + Math.round((completed / Math.max(1, changed.length)) * 29), `${completed} / ${changed.length}`);
    });

    const quarantined = [];
    const previousManaged = new Set(Object.keys(installed.files || {}));
    const nextManaged = new Set(manifest.files.map((entry) => entry.path));
    for (const stale of previousManaged) {
      if (!nextManaged.has(stale)) {
        const result = await this.quarantineFile(stale, '새 배포 버전에서 제거된 파일');
        if (result) quarantined.push(result);
      }
    }
    for (const relativePath of manifest.remove) {
      const result = await this.quarantineFile(relativePath, '배포 매니페스트에서 제거하도록 지정된 파일');
      if (result) quarantined.push(result);
    }

    let modEntries = [];
    try {
      modEntries = await fs.readdir(path.join(this.gameRoot, 'mods'), { withFileTypes: true });
    } catch {
      modEntries = [];
    }
    for (const entry of modEntries) {
      if (!entry.isFile()) continue;
      const rule = quarantineRuleFor(entry.name);
      if (!rule) continue;
      const result = await this.quarantineFile(`mods/${entry.name}`, rule.reason);
      if (result) quarantined.push(result);
    }

    const fileState = {};
    for (const entry of manifest.files) {
      const destination = resolveInside(this.gameRoot, entry.path);
      const stat = await fs.stat(destination);
      fileState[entry.path] = {
        algorithm: entry.hash.algorithm,
        hash: entry.hash.value,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      };
    }
    const next = {
      schemaVersion: 1,
      profileId: manifest.profile.id,
      version: manifest.version,
      files: fileState,
      archives,
      quarantined,
      appliedAt: new Date().toISOString()
    };
    await writeJsonAtomic(this.stateFile, next);
    this.onProgress?.('클라이언트 패치 완료', 88, changed.length ? `${changed.length}개 파일 갱신` : '이미 최신 상태입니다.');
    return {
      manifest,
      changedFiles: changed.length,
      quarantined
    };
  }
}

module.exports = {
  DistributionConfigurationError,
  PatchService,
  stableStringify,
  validateManifest,
  verifyManifestEnvelope
};
