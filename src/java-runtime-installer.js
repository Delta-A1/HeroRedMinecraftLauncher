'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  downloadFile,
  ensureDirectory,
  hashFile,
  mapLimit,
  resolveInside
} = require('./file-utils');

async function verifyRuntimeFile(file, downloadInfo) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    if (Number(downloadInfo.size) > 0 && stat.size !== Number(downloadInfo.size)) return false;
    return await hashFile(file, 'sha1') === String(downloadInfo.sha1 || '').toLowerCase();
  } catch {
    return false;
  }
}

function resolveLinkTarget(root, linkFile, target) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(path.dirname(linkFile), String(target || ''));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Java 런타임 링크가 설치 폴더를 벗어납니다: ${target}`);
  }
  return resolved;
}

async function installJavaRuntimeFiles(options) {
  const manifest = options.manifest;
  const destination = options.destination;
  const download = options.download || downloadFile;
  const entries = Object.entries(manifest?.files || {});
  const directories = entries.filter(([, entry]) => entry?.type === 'directory');
  const files = entries.filter(([, entry]) => entry?.type === 'file');
  const links = entries.filter(([, entry]) => entry?.type === 'link');
  const totalBytes = files.reduce(
    (total, [, entry]) => total + Math.max(0, Number(entry?.downloads?.raw?.size) || 0),
    0
  );
  let completedBytes = 0;
  const activeBytes = new Map();

  const report = (detail = '') => {
    const active = [...activeBytes.values()].reduce((sum, value) => sum + value, 0);
    options.onProgress?.(completedBytes + active, totalBytes, detail);
  };

  await ensureDirectory(destination);
  await Promise.all(directories.map(([relativePath]) =>
    ensureDirectory(resolveInside(destination, relativePath))
  ));

  await mapLimit(files, Number(options.concurrency) || 4, async ([relativePath, entry], index) => {
    const downloadInfo = entry.downloads?.raw;
    if (!downloadInfo?.url || !downloadInfo?.sha1) {
      throw new Error(`Java 런타임 다운로드 정보가 올바르지 않습니다: ${relativePath}`);
    }
    const target = resolveInside(destination, relativePath);
    if (await verifyRuntimeFile(target, downloadInfo)) {
      completedBytes += Math.max(0, Number(downloadInfo.size) || 0);
      report(relativePath);
      return;
    }

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      activeBytes.set(index, 0);
      await fs.rm(`${target}.partial`, { force: true });
      try {
        await download(downloadInfo.url, target, {
          timeoutMs: 120000,
          onProgress: (received) => {
            activeBytes.set(index, Math.max(0, Number(received) || 0));
            report(relativePath);
          }
        });
        if (!await verifyRuntimeFile(target, downloadInfo)) {
          throw new Error('다운로드한 파일의 크기 또는 SHA-1이 일치하지 않습니다.');
        }
        if (entry.executable && process.platform !== 'win32') {
          await fs.chmod(target, 0o755);
        }
        activeBytes.delete(index);
        completedBytes += Math.max(0, Number(downloadInfo.size) || 0);
        report(relativePath);
        return;
      } catch (error) {
        lastError = error;
        activeBytes.delete(index);
        await fs.rm(target, { force: true });
        await fs.rm(`${target}.partial`, { force: true });
        options.onRetry?.({ relativePath, attempt, error });
      }
    }
    throw new Error(`Java 런타임 파일을 3회 시도했지만 받지 못했습니다: ${relativePath}`, {
      cause: lastError
    });
  });

  for (const [relativePath, entry] of links) {
    const linkFile = resolveInside(destination, relativePath);
    const target = resolveLinkTarget(destination, linkFile, entry.target);
    await ensureDirectory(path.dirname(linkFile));
    await fs.rm(linkFile, { force: true });
    try {
      await fs.link(target, linkFile);
    } catch {
      const stat = await fs.stat(target).catch(() => null);
      if (stat?.isFile()) await fs.copyFile(target, linkFile);
    }
  }

  report('Java 런타임 파일 검증 완료');
  return {
    fileCount: files.length,
    totalBytes
  };
}

module.exports = {
  installJavaRuntimeFiles,
  resolveLinkTarget,
  verifyRuntimeFile
};
