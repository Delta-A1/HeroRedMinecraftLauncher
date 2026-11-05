'use strict';

function neoForgeVersionPrefix(minecraftVersion) {
  if (minecraftVersion === '1.20.1') return '1.20.1-';
  const match = String(minecraftVersion).match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('NeoForge는 정식 Minecraft 버전을 선택해 주세요.');
  const [, major, minor, patch = '0'] = match;
  return major === '1' ? `${minor}.${patch}.` : `${major}.${minor}.${patch}.`;
}

function neoForgeVersionId(minecraftVersion, loaderVersion) {
  return minecraftVersion === '1.20.1'
    ? `${minecraftVersion}-neoforge-${loaderVersion}`
    : `neoforge-${loaderVersion}`;
}

module.exports = { neoForgeVersionId, neoForgeVersionPrefix };
