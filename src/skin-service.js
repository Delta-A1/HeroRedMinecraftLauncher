'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { ensureDirectory } = require('./file-utils');

const MAX_SKIN_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function normalizeProfileId(value) {
  const id = String(value || '').replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('잘못된 Minecraft 프로필 ID입니다.');
  return id;
}

function validateSkinUrl(value) {
  const url = new URL(String(value || ''));
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.hostname.toLowerCase() !== 'textures.minecraft.net'
    || !/^\/texture\/[0-9a-f]+$/i.test(url.pathname)
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
  ) {
    throw new Error('공식 Minecraft 스킨 주소가 아닙니다.');
  }
  url.protocol = 'https:';
  return url;
}

function validatePng(buffer) {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length < 24
    || buffer.length > MAX_SKIN_BYTES
    || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('Minecraft 스킨 이미지 형식이 올바르지 않습니다.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== 64 || ![32, 64].includes(height)) {
    throw new Error('Minecraft 스킨 크기는 64×32 또는 64×64여야 합니다.');
  }
}

class SkinService {
  constructor(options) {
    this.cacheRoot = options.cacheRoot;
    this.fetch = options.fetch || fetch;
  }

  getCacheFile(profileId) {
    return path.join(this.cacheRoot, `${normalizeProfileId(profileId)}.png`);
  }

  async refresh(profile) {
    const profileId = normalizeProfileId(profile?.id);
    const skinUrl = validateSkinUrl(profile?.skin?.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await this.fetch(skinUrl, {
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'image/png',
          'User-Agent': 'Fire-Crew-Launcher/0.4.3-R9'
        }
      });
      if (!response.ok) throw new Error(`스킨 다운로드 실패 (HTTP ${response.status})`);
      const contentLength = Number(response.headers?.get?.('content-length') || 0);
      if (contentLength > MAX_SKIN_BYTES) throw new Error('Minecraft 스킨 파일이 너무 큽니다.');
      const buffer = Buffer.from(await response.arrayBuffer());
      validatePng(buffer);
      await ensureDirectory(this.cacheRoot);
      const destination = this.getCacheFile(profileId);
      const temp = `${destination}.partial`;
      await fs.writeFile(temp, buffer);
      await fs.rm(destination, { force: true });
      await fs.rename(temp, destination);
      return this.getDataUrl(profileId);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getDataUrl(profileId) {
    try {
      const buffer = await fs.readFile(this.getCacheFile(profileId));
      validatePng(buffer);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch {
      return '';
    }
  }

  async remove(profileId) {
    if (!profileId) return;
    await fs.rm(this.getCacheFile(profileId), { force: true });
  }
}

module.exports = {
  MAX_SKIN_BYTES,
  SkinService,
  normalizeProfileId,
  validatePng,
  validateSkinUrl
};
