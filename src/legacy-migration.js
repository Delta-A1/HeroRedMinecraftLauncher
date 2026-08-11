'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { ensureDirectory, pathExists, readJson, writeJsonAtomic } = require('./file-utils');
const { isExpectedDeceasedCraftInstance, parseInstanceName } = require('./core');

const MIGRATABLE_ENTRIES = Object.freeze([
  'mods',
  'config',
  'defaultconfigs',
  'kubejs',
  'resourcepacks',
  'shaderpacks',
  'scripts',
  'local',
  'saves',
  'screenshots',
  'options.txt'
]);

async function countMods(gameRoot) {
  try {
    const entries = await fs.readdir(path.join(gameRoot, 'mods'), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).length;
  } catch {
    return 0;
  }
}

async function findLegacyInstance(prismDataRoot) {
  const instancesRoot = path.join(prismDataRoot, 'instances');
  let entries = [];
  try {
    entries = await fs.readdir(instancesRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(instancesRoot, entry.name);
    let name = '';
    try {
      name = parseInstanceName(await fs.readFile(path.join(root, 'instance.cfg'), 'utf8'));
    } catch {
      name = entry.name;
    }
    if (!isExpectedDeceasedCraftInstance(name, entry.name)) continue;
    const gameRoot = path.join(root, '.minecraft');
    const modCount = await countMods(gameRoot);
    if (modCount >= 250) candidates.push({ id: entry.name, name, root, gameRoot, modCount });
  }
  return candidates.sort((a, b) => b.modCount - a.modCount)[0] || null;
}

async function migrateLegacyInstance(options) {
  const previous = await readJson(options.migrationStateFile, null);
  const existingMods = await countMods(options.gameRoot);
  if (existingMods >= 250) {
    return {
      migrated: Boolean(previous?.migrated),
      available: true,
      modCount: existingMods,
      source: previous?.source || ''
    };
  }
  const instance = await findLegacyInstance(options.prismDataRoot);
  if (!instance) return { migrated: false, available: false, modCount: existingMods };

  options.onProgress?.('기존 클라이언트 가져오기', 45, `${instance.modCount}개 모드 확인`);
  await ensureDirectory(options.gameRoot);
  let completed = 0;
  for (const entry of MIGRATABLE_ENTRIES) {
    const source = path.join(instance.gameRoot, entry);
    if (!await pathExists(source)) continue;
    const destination = path.join(options.gameRoot, entry);
    await fs.cp(source, destination, {
      recursive: true,
      force: true,
      errorOnExist: false
    });
    completed += 1;
    options.onProgress?.('기존 클라이언트 가져오기', 45 + Math.round((completed / MIGRATABLE_ENTRIES.length) * 35), entry);
  }
  const modCount = await countMods(options.gameRoot);
  const state = {
    migrated: true,
    source: instance.root,
    sourceInstanceId: instance.id,
    modCount,
    migratedAt: new Date().toISOString()
  };
  await writeJsonAtomic(options.migrationStateFile, state);
  options.onLog?.(`기존 Prism 인스턴스에서 ${modCount}개 모드를 독립형 클라이언트로 복사했습니다.`);
  return { ...state, available: modCount >= 250 };
}

module.exports = {
  MIGRATABLE_ENTRIES,
  countMods,
  findLegacyInstance,
  migrateLegacyInstance
};
