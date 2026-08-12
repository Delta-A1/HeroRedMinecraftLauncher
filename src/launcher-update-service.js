'use strict';

const crypto = require('node:crypto');
let fs = require('node:fs');
let fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const AdmZip = require('adm-zip');

try {
  fs = require('original-fs');
  fsp = fs.promises;
} catch {
  // original-fs is provided by Electron. Node tests use the standard filesystem.
}

const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left.localeCompare(right);
}

function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) throw new Error(`비교할 수 없는 버전입니다: ${leftValue}, ${rightValue}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key]);
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (comparison) return comparison;
  }
  return 0;
}

function normalizeRepository(value) {
  const repository = String(value || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  if (!repository) return '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GitHub 저장소는 owner/repository 형식이어야 합니다.');
  }
  return repository;
}

function selectWindowsAsset(assets, preferredName = '') {
  if (preferredName) return assets.find((asset) => asset.name === preferredName) || null;
  return assets.find((asset) => {
    const name = String(asset.name || '').toLowerCase();
    return name.endsWith('.zip')
      && /(?:win|windows)/.test(name)
      && /(?:x64|amd64)/.test(name)
      && !/(?:symbols|source|src)/.test(name);
  }) || null;
}

function sha256FromAsset(asset) {
  const match = String(asset?.digest || '').match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : '';
}

function safeEntryPath(root, entryName) {
  const normalizedName = String(entryName || '').replaceAll('\\', '/');
  if (!normalizedName || normalizedName.startsWith('/') || /^[A-Za-z]:/.test(normalizedName)) {
    throw new Error(`업데이트 ZIP에 안전하지 않은 경로가 있습니다: ${entryName}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalizedName);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`업데이트 ZIP이 대상 폴더를 벗어납니다: ${entryName}`);
  }
  return target;
}

function spawnAndConfirm(spawnImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, options);
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(child);
    });
  });
}

async function extractArchiveToStaging(archive, stagingRoot) {
  const entries = archive.getEntries();
  if (!entries.length) throw new Error('업데이트 ZIP이 비어 있습니다.');

  await fsp.mkdir(stagingRoot, { recursive: true });
  for (const entry of entries) {
    const target = safeEntryPath(stagingRoot, entry.entryName);
    if (entry.isDirectory) {
      await fsp.mkdir(target, { recursive: true });
      continue;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    const content = entry.getData();
    if (!content) throw new Error(`업데이트 ZIP 파일을 압축 해제할 수 없습니다: ${entry.entryName}`);
    await fsp.writeFile(target, content, { flag: 'wx' });
  }
}

class LauncherUpdateService {
  constructor(options) {
    this.currentVersion = options.currentVersion;
    let repositoryError = '';
    try {
      this.repository = normalizeRepository(options.repository);
    } catch (error) {
      this.repository = '';
      repositoryError = error.message;
    }
    this.preferredAssetName = String(options.assetName || '').trim();
    this.dataRoot = path.resolve(options.dataRoot);
    this.execPath = path.resolve(options.execPath);
    this.isPackaged = Boolean(options.isPackaged);
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.spawn = options.spawnImpl || spawn;
    this.onStatus = options.onStatus || (() => {});
    this.status = {
      configured: Boolean(this.repository),
      currentVersion: this.currentVersion,
      state: repositoryError ? 'error' : (this.repository ? 'idle' : 'disabled'),
      available: false,
      latestVersion: '',
      releaseName: '',
      releaseUrl: '',
      publishedAt: '',
      progress: 0,
      message: repositoryError
        ? `업데이트 설정 오류: ${repositoryError}`
        : this.repository
        ? '업데이트 확인을 기다리고 있습니다.'
        : 'GitHub 업데이트 저장소가 설정되지 않았습니다.'
    };
    this.release = null;
    this.checkPromise = null;
  }

  getStatus() {
    return { ...this.status };
  }

  setStatus(changes) {
    this.status = { ...this.status, ...changes };
    this.onStatus(this.getStatus());
  }

  async request(url, accept = 'application/vnd.github+json') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await this.fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: accept,
          'User-Agent': `Fire-Crew-Launcher/${this.currentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
      if (!response.ok) throw new Error(`GitHub 응답 오류 (HTTP ${response.status})`);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  async check() {
    if (!this.repository) return this.getStatus();
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.checkInternal().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  async checkInternal() {
    this.setStatus({ state: 'checking', progress: 0, message: 'GitHub에서 최신 버전을 확인하고 있습니다.' });
    try {
      const response = await this.request(`https://api.github.com/repos/${this.repository}/releases/latest`);
      const release = await response.json();
      const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
      if (!parseVersion(latestVersion)) throw new Error(`릴리스 태그가 올바른 버전 형식이 아닙니다: ${release.tag_name || '(없음)'}`);
      const available = compareVersions(latestVersion, this.currentVersion) > 0;
      const asset = available ? selectWindowsAsset(release.assets || [], this.preferredAssetName) : null;
      if (available && !asset) throw new Error('최신 릴리스에서 Windows x64 ZIP 파일을 찾지 못했습니다.');
      this.release = available ? { release, asset } : null;
      this.setStatus({
        state: available ? 'available' : 'up-to-date',
        available,
        latestVersion,
        releaseName: String(release.name || release.tag_name || ''),
        releaseUrl: String(release.html_url || ''),
        publishedAt: String(release.published_at || ''),
        assetName: asset?.name || '',
        progress: available ? 0 : 100,
        message: available
          ? `새 런처 ${latestVersion}을(를) 설치할 수 있습니다.`
          : `현재 ${this.currentVersion}이(가) 최신 버전입니다.`
      });
    } catch (error) {
      this.release = null;
      this.setStatus({
        state: 'error',
        available: false,
        progress: 0,
        message: `업데이트 확인 실패: ${error.message}`
      });
    }
    return this.getStatus();
  }

  async resolveExpectedSha256(asset, assets) {
    const digest = sha256FromAsset(asset);
    if (digest) return digest;
    const checksum = assets.find((candidate) => candidate.name === `${asset.name}.sha256`);
    if (!checksum) throw new Error('릴리스 자산에 SHA-256 검증값이 없습니다.');
    const response = await this.request(checksum.browser_download_url, 'text/plain');
    const text = await response.text();
    const match = text.match(/\b[a-f0-9]{64}\b/i);
    if (!match) throw new Error('SHA-256 파일의 형식이 올바르지 않습니다.');
    return match[0].toLowerCase();
  }

  async downloadAndPrepare() {
    if (!this.isPackaged) throw new Error('개발 모드에서는 런처 자동 업데이트를 적용할 수 없습니다.');
    if (!this.release || !this.status.available) await this.check();
    if (!this.release || !this.status.available) throw new Error('설치할 런처 업데이트가 없습니다.');

    const { release, asset } = this.release;
    if (path.basename(asset.name) !== asset.name) throw new Error('업데이트 자산 이름이 안전하지 않습니다.');
    const versionRoot = path.join(this.dataRoot, 'launcher-updates', this.status.latestVersion);
    const zipFile = path.join(versionRoot, asset.name);
    const stagingRoot = path.join(versionRoot, 'staging');
    await fsp.rm(versionRoot, { recursive: true, force: true });
    await fsp.mkdir(versionRoot, { recursive: true });
    this.setStatus({ state: 'downloading', progress: 0, message: `${asset.name} 다운로드 중` });

    const response = await this.request(asset.browser_download_url, 'application/octet-stream');
    if (!response.body) throw new Error('업데이트 다운로드 응답이 비어 있습니다.');
    const contentLength = Number(response.headers.get('content-length')) || 0;
    if (contentLength > MAX_UPDATE_BYTES) throw new Error('업데이트 파일이 허용된 최대 크기를 초과합니다.');
    const hash = crypto.createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (received > MAX_UPDATE_BYTES) return callback(new Error('업데이트 파일이 허용된 최대 크기를 초과합니다.'));
        hash.update(chunk);
        const progress = contentLength ? Math.min(90, Math.round((received / contentLength) * 90)) : 0;
        this.setStatus({ state: 'downloading', progress, message: `업데이트 다운로드 중 · ${Math.round(received / 1048576)} MB` });
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(zipFile));
    const expectedHash = await this.resolveExpectedSha256(asset, release.assets || []);
    const actualHash = hash.digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      await fsp.rm(zipFile, { force: true });
      throw new Error('업데이트 파일의 SHA-256 검증에 실패했습니다.');
    }

    this.setStatus({ state: 'preparing', progress: 93, message: '업데이트 파일을 안전하게 준비하고 있습니다.' });
    const archive = new AdmZip(zipFile);
    await extractArchiveToStaging(archive, stagingRoot);

    const executableName = path.basename(this.execPath);
    let payloadRoot = stagingRoot;
    try {
      await fsp.access(path.join(payloadRoot, executableName));
    } catch {
      const children = await fsp.readdir(stagingRoot, { withFileTypes: true });
      const directories = children.filter((entry) => entry.isDirectory());
      if (children.length !== 1 || directories.length !== 1) {
        throw new Error(`업데이트 ZIP에서 ${executableName}을(를) 찾지 못했습니다.`);
      }
      payloadRoot = path.join(stagingRoot, directories[0].name);
      await fsp.access(path.join(payloadRoot, executableName));
    }
    this.setStatus({ state: 'ready', progress: 100, message: '재시작하면 새 버전이 적용됩니다.' });
    return { payloadRoot, versionRoot };
  }

  async applyAndRestart() {
    try {
      const prepared = await this.downloadAndPrepare();
      const installRoot = path.dirname(this.execPath);
      if (installRoot === path.parse(installRoot).root) throw new Error('안전하지 않은 설치 경로입니다.');
      const installParent = path.dirname(installRoot);
      const writeTestFile = path.join(installParent, `.fire-crew-update-write-test-${process.pid}`);
      try {
        await fsp.writeFile(writeTestFile, 'write-test', { flag: 'wx' });
      } finally {
        await fsp.rm(writeTestFile, { force: true });
      }
      this.setStatus({ state: 'preparing', progress: 97, message: '별도 업데이트 도우미를 준비하고 있습니다.' });
      const helperParent = path.join(this.dataRoot, 'launcher-updater-helper');
      const helperRoot = path.join(helperParent, `${this.status.latestVersion}-${Date.now()}`);
      await fsp.mkdir(helperParent, { recursive: true });
      await fsp.cp(prepared.payloadRoot, helperRoot, {
        recursive: true,
        force: true,
        errorOnExist: false
      });

      const executableName = path.basename(this.execPath);
      const helperExecutable = path.join(helperRoot, executableName);
      await fsp.access(helperExecutable);
      const logFile = path.join(this.dataRoot, 'launcher-update.log');
      const jobFile = path.join(prepared.versionRoot, 'update-job.json');
      await fsp.writeFile(jobFile, JSON.stringify({
        schemaVersion: 1,
        parentPid: process.pid,
        stagingRoot: prepared.payloadRoot,
        installRoot,
        helperRoot,
        versionRoot: prepared.versionRoot,
        logFile,
        executableName,
        targetVersion: this.status.latestVersion
      }, null, 2), 'utf8');

      await spawnAndConfirm(this.spawn, helperExecutable, [
        `--launcher-update-job=${jobFile}`
      ], {
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
        cwd: helperRoot
      });
      return { restarting: true };
    } catch (error) {
      this.setStatus({
        state: 'error',
        progress: 0,
        message: `업데이트 설치 실패: ${error.message}`
      });
      throw error;
    }
  }
}

module.exports = {
  LauncherUpdateService,
  compareVersions,
  extractArchiveToStaging,
  normalizeRepository,
  parseVersion,
  safeEntryPath,
  selectWindowsAsset,
  spawnAndConfirm,
  sha256FromAsset
};
