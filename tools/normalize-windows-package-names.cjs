'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function normalizeDirectory(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const currentPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeDirectory(currentPath);
    }
  }

  for (const entry of entries) {
    const normalizedName = entry.name.normalize('NFC');
    if (normalizedName === entry.name) continue;

    const currentPath = path.join(directory, entry.name);
    const normalizedPath = path.join(directory, normalizedName);

    try {
      await fs.access(normalizedPath);
      throw new Error(`정규화된 파일명이 이미 존재합니다: ${normalizedPath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await fs.rename(currentPath, normalizedPath);
  }
}

async function normalizeWindowsPackageNames(targetDirectory) {
  const resolved = path.resolve(targetDirectory);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`디렉터리가 아닙니다: ${resolved}`);
  }
  await normalizeDirectory(resolved);
  return resolved;
}

if (require.main === module) {
  const targetDirectory = process.argv[2] || 'dist';
  normalizeWindowsPackageNames(targetDirectory)
    .then((resolved) => {
      process.stdout.write(`Windows 패키지 파일명을 NFC로 정규화했습니다: ${resolved}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  normalizeWindowsPackageNames
};

