'use strict';

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { MinecraftFolder, Version, launch } = require('@xmcl/core');
const {
  getVersionList,
  installForgeTask,
  installLibrariesTask,
  installVersionTask
} = require('@xmcl/installer');
const { ensureDirectory, pathExists, readJson, writeJsonAtomic } = require('./file-utils');
const { installJavaRuntimeFiles } = require('./java-runtime-installer');
const {
  createMinecraftDownloadDispatcher,
  removeZeroByteInstallFiles,
  retryInstall
} = require('./minecraft-download-policy');
const { fetchMojangJavaRuntimeManifest } = require('./mojang-runtime-manifest');

function createMicrosoftLaunchIdentity(session) {
  const clientId = String(session?.clientId || '').trim();
  const xuid = String(session?.xuid || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    throw new Error('Microsoft 로그인 클라이언트 ID가 실행 세션에 없습니다.');
  }
  if (!/^\d+$/.test(xuid)) {
    throw new Error('Minecraft XUID가 실행 세션에 없습니다. Microsoft 계정으로 다시 로그인해 주세요.');
  }
  return {
    userType: 'msa',
    features: {
      fire_crew_microsoft_session: {
        clientid: Buffer.from(clientId, 'utf8').toString('base64'),
        auth_xuid: xuid
      }
    }
  };
}

function baseStateMatchesProduct(state, product) {
  return Boolean(
    state?.minecraftVersion === product.minecraft.version
    && state?.forgeVersion === product.minecraft.forgeVersion
    && state?.javaRuntimeTarget === product.minecraft.javaRuntimeTarget
    && state?.forgeVersionId
  );
}

function createVanillaDependencyManifest(version, assetIndex) {
  const files = {};
  for (const entry of Object.values(assetIndex?.objects || {})) {
    const hash = String(entry?.hash || '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) {
      throw new Error('Minecraft 에셋 인덱스에 잘못된 SHA-1이 있습니다.');
    }
    files[`assets/objects/${hash.slice(0, 2)}/${hash}`] = {
      type: 'file',
      downloads: {
        raw: {
          url: `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
          sha1: hash,
          size: Number(entry.size) || 0
        }
      }
    };
  }
  for (const library of version.libraries || []) {
    const download = library?.download;
    if (!download?.path || !download?.url || !download?.sha1) continue;
    files[`libraries/${download.path}`] = {
      type: 'file',
      downloads: {
        raw: {
          url: download.url,
          sha1: download.sha1,
          size: Number(download.size) || 0
        }
      }
    };
  }
  const logFile = version.logging?.client?.file;
  if (logFile?.id && logFile?.url && logFile?.sha1) {
    files[`assets/log_configs/${logFile.id}`] = {
      type: 'file',
      downloads: {
        raw: {
          url: logFile.url,
          sha1: logFile.sha1,
          size: Number(logFile.size) || 0
        }
      }
    };
  }
  return { files };
}

class MinecraftService {
  constructor(options) {
    this.gameRoot = options.gameRoot;
    this.runtimeRoot = options.runtimeRoot;
    this.baseStateFile = options.baseStateFile;
    this.product = options.product;
    this.onProgress = options.onProgress;
    this.onLog = options.onLog;
    this.onGameExit = options.onGameExit;
    this.minecraft = new MinecraftFolder(this.gameRoot);
    this.runtimeStateFile = path.join(this.runtimeRoot, '.fire-crew-runtime.json');
    this.downloadDispatcher = options.downloadDispatcher
      || createMinecraftDownloadDispatcher();
  }

  get javaExecutable() {
    if (process.platform === 'win32') return path.join(this.runtimeRoot, 'bin', 'java.exe');
    return path.join(this.runtimeRoot, 'bin', 'java');
  }

  get javaWindowExecutable() {
    if (process.platform === 'win32') {
      const javaw = path.join(this.runtimeRoot, 'bin', 'javaw.exe');
      if (fssync.existsSync(javaw)) return javaw;
    }
    return this.javaExecutable;
  }

  async isRuntimeReady() {
    const state = await readJson(this.runtimeStateFile, {});
    return Boolean(
      await pathExists(this.javaExecutable)
      && state.verified === true
      && state.target === this.product.minecraft.javaRuntimeTarget
    );
  }

  async runTask(task, range, stage) {
    const [start, end] = range;
    const update = () => {
      const ratio = task.total > 0 ? Math.min(1, task.progress / task.total) : 0;
      this.onProgress?.(stage, start + Math.round((end - start) * ratio), task.param?.file || task.param?.version || '');
    };
    return task.startAndWait({
      onStart: update,
      onUpdate: update,
      onSucceed: update,
      onFailed: (_failed, error) => this.onLog?.(`${stage} 실패: ${error?.message || error}`, 'error')
    });
  }

  getDownloadOptions(overrides = {}) {
    return {
      dispatcher: this.downloadDispatcher,
      maxConcurrency: 4,
      assetsDownloadConcurrency: 4,
      librariesDownloadConcurrency: 4,
      ...overrides
    };
  }

  async cleanupFailedDownloads() {
    return removeZeroByteInstallFiles([
      path.join(this.gameRoot, 'libraries'),
      path.join(this.gameRoot, 'assets'),
      path.join(this.gameRoot, 'versions')
    ]);
  }

  async runTaskWithRetries(taskFactory, range, stage) {
    return retryInstall(
      () => this.runTask(taskFactory(), range, stage),
      {
        attempts: 3,
        cleanup: async () => {
          const removed = await this.cleanupFailedDownloads();
          if (removed.length > 0) {
            this.onLog?.(`${stage}: 0바이트 실패 파일 ${removed.length}개를 정리했습니다.`, 'warning');
          }
        },
        onRetry: ({ nextAttempt, attempts, error }) => {
          const detail = error?.errors?.[0]?.message || error?.message || String(error);
          this.onLog?.(`${stage} 네트워크 재시도 ${nextAttempt}/${attempts}: ${detail}`, 'warning');
          this.onProgress?.(stage, range[0], `연결을 조정해 다시 시도합니다. (${nextAttempt}/${attempts})`);
        }
      }
    );
  }

  async ensureRuntime(options = {}) {
    if (!options.repair && await this.isRuntimeReady()) return this.javaExecutable;
    const javaLabel = `Java ${this.product.minecraft.javaMajorVersion}`;
    this.onProgress?.(`${javaLabel} 준비`, 2, 'Mojang 공식 런타임 확인 중');
    const manifest = await fetchMojangJavaRuntimeManifest({
      target: this.product.minecraft.javaRuntimeTarget
    });
    await ensureDirectory(this.runtimeRoot);
    await installJavaRuntimeFiles({
      destination: this.runtimeRoot,
      manifest,
      concurrency: 4,
      onProgress: (received, total, detail) => {
        const ratio = total > 0 ? Math.min(1, received / total) : 0;
        this.onProgress?.(`${javaLabel} 다운로드`, 3 + Math.round(15 * ratio), detail);
      },
      onRetry: ({ relativePath, attempt, error }) => {
        this.onLog?.(
          `Java 파일 재시도 ${attempt}/3: ${relativePath} · ${error?.message || error}`,
          'warning'
        );
      }
    });
    await writeJsonAtomic(this.runtimeStateFile, {
      target: this.product.minecraft.javaRuntimeTarget,
      version: manifest.version,
      verified: true,
      verifiedAt: new Date().toISOString()
    });
    if (!await pathExists(this.javaExecutable)) {
      throw new Error('설치된 Java 실행 파일을 찾지 못했습니다.');
    }
    return this.javaExecutable;
  }

  async ensureVanilla(options = {}) {
    const version = this.product.minecraft.version;
    const json = this.minecraft.getVersionJson(version);
    const jar = this.minecraft.getVersionJar(version);
    const saved = await readJson(this.baseStateFile, {});
    if (
      !options.repair
      && saved.minecraftVersion === version
      && saved.vanillaDependenciesVerified === true
      && await pathExists(json)
      && await pathExists(jar)
    ) {
      return Version.parse(this.minecraft, version);
    }
    this.onProgress?.('Minecraft 준비', 19, `${version} 공식 파일 확인 중`);
    const list = await getVersionList();
    const metadata = list.versions.find((entry) => entry.id === version);
    if (!metadata) throw new Error(`Minecraft ${version} 설치 정보를 찾지 못했습니다.`);
    const resolved = await this.runTaskWithRetries(
      () => installVersionTask(metadata, this.minecraft, this.getDownloadOptions({
        side: 'client',
        throwErrorImmediately: false
      })),
      [20, 24],
      `Minecraft ${version} 설치`
    );
    const indexPath = path.join(this.gameRoot, 'assets', 'indexes', `${resolved.assets}.json`);
    await installJavaRuntimeFiles({
      destination: this.gameRoot,
      manifest: {
        files: {
          [`assets/indexes/${resolved.assets}.json`]: {
            type: 'file',
            downloads: {
              raw: {
                url: resolved.assetIndex.url,
                sha1: resolved.assetIndex.sha1,
                size: Number(resolved.assetIndex.size) || 0
              }
            }
          }
        }
      },
      concurrency: 1,
      onProgress: (received, total) => {
        const ratio = total > 0 ? Math.min(1, received / total) : 0;
        this.onProgress?.('Minecraft 에셋 목록', 24 + Math.round(2 * ratio), resolved.assets);
      }
    });
    const assetIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    await installJavaRuntimeFiles({
      destination: this.gameRoot,
      manifest: createVanillaDependencyManifest(resolved, assetIndex),
      concurrency: 4,
      onProgress: (received, total, detail) => {
        const ratio = total > 0 ? Math.min(1, received / total) : 0;
        this.onProgress?.('Minecraft 에셋 및 라이브러리', 26 + Math.round(8 * ratio), detail);
      },
      onRetry: ({ relativePath, attempt, error }) => {
        this.onLog?.(
          `Minecraft 파일 재시도 ${attempt}/3: ${relativePath} · ${error?.message || error}`,
          'warning'
        );
      }
    });
    await writeJsonAtomic(this.baseStateFile, {
      ...saved,
      minecraftVersion: version,
      javaRuntimeTarget: this.product.minecraft.javaRuntimeTarget,
      vanillaDependenciesVerified: true,
      vanillaPreparedAt: new Date().toISOString()
    });
    return resolved;
  }

  async ensureForge(javaPath, options = {}) {
    const saved = await readJson(this.baseStateFile, {});
    const savedMatches = baseStateMatchesProduct(saved, this.product);
    let forgeVersionId = savedMatches
      ? saved.forgeVersionId
      : this.product.minecraft.forgeVersionId;
    const versionJson = this.minecraft.getVersionJson(forgeVersionId);
    if (options.repair || !savedMatches || !await pathExists(versionJson)) {
      this.onProgress?.('Forge 준비', 35, `${this.product.minecraft.forgeVersion} 설치 중`);
      forgeVersionId = await this.runTaskWithRetries(
        () => installForgeTask({
          mcversion: this.product.minecraft.version,
          version: this.product.minecraft.forgeVersion
        }, this.minecraft, this.getDownloadOptions({
          java: javaPath,
          side: 'client',
          mavenHost: ['https://maven.minecraftforge.net']
        })),
        [35, 42],
        'Forge 설치'
      );
    }
    const resolved = await Version.parse(this.minecraft, forgeVersionId);
    if (
      options.repair
      || !savedMatches
      || saved.dependenciesVerified !== true
      || saved.forgeVersionId !== forgeVersionId
    ) {
      await this.runTaskWithRetries(
        () => installLibrariesTask(resolved, this.getDownloadOptions({
          side: 'client',
          mavenHost: ['https://maven.minecraftforge.net']
        })),
        [42, 44],
        'Forge 라이브러리 확인'
      );
    }
    await writeJsonAtomic(this.baseStateFile, {
      minecraftVersion: this.product.minecraft.version,
      forgeVersion: this.product.minecraft.forgeVersion,
      forgeVersionId,
      javaRuntimeTarget: this.product.minecraft.javaRuntimeTarget,
      vanillaDependenciesVerified: true,
      dependenciesVerified: true,
      preparedAt: new Date().toISOString()
    });
    return forgeVersionId;
  }

  async prepareBase(options = {}) {
    await ensureDirectory(this.gameRoot);
    const javaPath = await this.ensureRuntime(options);
    await this.ensureVanilla(options);
    const forgeVersionId = await this.ensureForge(javaPath, options);
    return {
      javaPath,
      forgeVersionId
    };
  }

  async getStatus() {
    const state = await readJson(this.baseStateFile, {});
    const stateMatches = baseStateMatchesProduct(state, this.product);
    const javaReady = await this.isRuntimeReady();
    const vanillaReady = state.minecraftVersion === this.product.minecraft.version
      && state.vanillaDependenciesVerified === true
      && await pathExists(this.minecraft.getVersionJson(this.product.minecraft.version))
      && await pathExists(this.minecraft.getVersionJar(this.product.minecraft.version));
    const forgeVersionId = stateMatches
      ? state.forgeVersionId
      : this.product.minecraft.forgeVersionId;
    const forgeReady = await pathExists(this.minecraft.getVersionJson(forgeVersionId));
    return {
      ready: Boolean(
        stateMatches
        && javaReady
        && vanillaReady
        && forgeReady
        && state.dependenciesVerified
      ),
      javaReady,
      vanillaReady,
      forgeReady,
      forgeVersionId
    };
  }

  async launchGame(session, memoryMb) {
    const state = await readJson(this.baseStateFile, {});
    if (!baseStateMatchesProduct(state, this.product) || state.dependenciesVerified !== true) {
      throw new Error(`Minecraft ${this.product.minecraft.version} 클라이언트 준비가 필요합니다.`);
    }
    const forgeVersionId = state.forgeVersionId;
    const maxMemory = Number(memoryMb) || 8192;
    const launchIdentity = createMicrosoftLaunchIdentity(session);
    this.onProgress?.('Minecraft 실행', 99, `${this.product.server.name}에 바로 접속합니다.`);
    const child = await launch({
      gamePath: this.gameRoot,
      resourcePath: this.gameRoot,
      javaPath: this.javaWindowExecutable,
      version: forgeVersionId,
      gameProfile: {
        name: session.profile.name,
        id: session.profile.id
      },
      accessToken: session.accessToken,
      userType: launchIdentity.userType,
      features: launchIdentity.features,
      launcherName: 'Fire Crew Launcher',
      launcherBrand: 'Fire Crew',
      versionName: forgeVersionId,
      versionType: 'Fire Crew',
      minMemory: Math.min(4096, maxMemory),
      maxMemory,
      quickPlayMultiplayer: this.product.server.address,
      server: {
        ip: this.product.server.host,
        port: this.product.server.port
      },
      extraExecOption: {
        cwd: this.gameRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      }
    });
    child.once('exit', (code, signal) => this.onGameExit?.({ code, signal }));
    child.unref();
    return {
      started: true,
      pid: child.pid,
      server: this.product.server.address
    };
  }
}

module.exports = {
  baseStateMatchesProduct,
  createVanillaDependencyManifest,
  createMicrosoftLaunchIdentity,
  MinecraftService
};
