'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const project = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const buildDirectory = path.join(projectRoot, 'dist', '불꽃단 런처-win32-x64');
  const releaseDirectory = path.join(projectRoot, 'release');
  const assetName = `fire-crew-launcher-windows-x64-v${project.version}.zip`;
  const assetFile = path.join(releaseDirectory, assetName);
  const installerName = `fire-crew-launcher-setup-v${project.version}.exe`;
  const installerFile = path.join(releaseDirectory, installerName);
  await fs.access(path.join(buildDirectory, '불꽃단 런처.exe'));
  await fs.access(installerFile);
  await fs.mkdir(releaseDirectory, { recursive: true });

  const archive = new AdmZip();
  archive.addLocalFolder(buildDirectory);
  await new Promise((resolve, reject) => {
    archive.writeZip(assetFile, (error) => error ? reject(error) : resolve());
  });
  const digest = crypto.createHash('sha256').update(await fs.readFile(assetFile)).digest('hex');
  await fs.writeFile(`${assetFile}.sha256`, `${digest}  ${assetName}\n`, 'utf8');
  const installerDigest = crypto.createHash('sha256').update(await fs.readFile(installerFile)).digest('hex');
  await fs.writeFile(`${installerFile}.sha256`, `${installerDigest}  ${installerName}\n`, 'utf8');
  process.stdout.write(
    `GitHub Release 자산을 생성했습니다:\n${installerFile}\n${installerFile}.sha256\n${assetFile}\n${assetFile}.sha256\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
