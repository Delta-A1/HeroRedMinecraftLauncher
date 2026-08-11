'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await ensureDirectory(path.dirname(file));
  const temp = `${file}.partial`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rm(file, { force: true });
  await fs.rename(temp, file);
}

function hashFile(file, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const input = fssync.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', reject);
  });
}

function normalizeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error('비어 있거나 잘못된 배포 파일 경로입니다.');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`안전하지 않은 배포 파일 경로입니다: ${value}`);
  }
  return parts.join('/');
}

function resolveInside(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalized.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`배포 경로가 설치 폴더를 벗어납니다: ${relativePath}`);
  }
  return resolved;
}

async function downloadFile(urlValue, destination, options = {}) {
  const url = new URL(String(urlValue));
  if (url.protocol !== 'https:') throw new Error(`HTTPS가 아닌 다운로드 주소는 거부되었습니다: ${url.hostname}`);
  await ensureDirectory(path.dirname(destination));
  const temp = `${destination}.partial`;
  await fs.rm(temp, { force: true });

  const timeoutController = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => timeoutController.abort(), Number(options.timeoutMs))
    : null;
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal,
      headers: {
        'User-Agent': 'Fire-Crew-Launcher/0.4.3-R9',
        ...(options.headers || {})
      }
    });
    if (!response.ok || !response.body) {
      throw new Error(`다운로드 실패 (HTTP ${response.status}): ${url.hostname}`);
    }

    const total = Number(response.headers.get('content-length') || 0);
    let received = 0;
    const stream = Readable.fromWeb(response.body);
    stream.on('data', (chunk) => {
      received += chunk.length;
      options.onProgress?.(received, total);
    });
    await pipeline(stream, fssync.createWriteStream(temp, { flags: 'wx' }));
    await fs.rm(destination, { force: true });
    await fs.rename(temp, destination);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return destination;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, run));
  return results;
}

module.exports = {
  downloadFile,
  ensureDirectory,
  hashFile,
  mapLimit,
  normalizeRelativePath,
  pathExists,
  readJson,
  resolveInside,
  writeJsonAtomic
};
