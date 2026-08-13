'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeWindowsPackageNames } = require('./normalize-windows-package-names.cjs');

const MANAGER_NAME = 'Fire Crew 모드 관리자';

async function copy(projectRoot, stagingRoot, relativePath) {
  const source = path.join(projectRoot, relativePath);
  const destination = path.join(stagingRoot, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
}

async function verifyPackage(directory) {
  const { listPackage } = await import('@electron/asar');
  const asarFile = path.join(directory, 'resources', 'app.asar');
  const entries = new Set(listPackage(asarFile).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '')));
  const required = [
    'tools/mode-list-manager/main.js',
    'tools/mode-list-manager/github-auth.js',
    'tools/mode-list-manager/preload.js',
    'tools/mode-list-manager/index.html',
    'tools/mode-list-manager/renderer.js',
    'assets/distribution-manifest.json',
    'assets/runtime-config.json',
    'node_modules/adm-zip/adm-zip.js'
  ];
  const missing = required.filter((entry) => !entries.has(entry));
  if (missing.length) throw new Error(`관리 도구 패키지 필수 파일 누락:\n${missing.join('\n')}`);
  const forbidden = [...entries].filter((entry) => entry.endsWith('.pem') || entry.includes('admin-signing-key'));
  if (forbidden.length) throw new Error(`관리 도구 패키지에 개인 키 후보가 포함되었습니다:\n${forbidden.join('\n')}`);
  await fs.access(path.join(directory, `${MANAGER_NAME}.exe`));
  return { asarFile, required: required.length };
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const stagingRoot = path.join(projectRoot, 'internal-build', 'mode-manager-staging');
  const outIndex = process.argv.indexOf('--out');
  const outputRoot = path.resolve(projectRoot, outIndex === -1 ? 'dist-admin' : process.argv[outIndex + 1] || '');
  if (outputRoot === projectRoot || !outputRoot.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`관리 도구 빌드 출력은 프로젝트 내부여야 합니다: ${outputRoot}`);
  }
  const targetRoot = path.join(outputRoot, `${MANAGER_NAME}-win32-x64`);
  await fs.rm(stagingRoot, { recursive: true, force: true });
  for (const form of ['NFC', 'NFD']) {
    const candidate = path.join(outputRoot, `${MANAGER_NAME.normalize(form)}-win32-x64`);
    if (path.resolve(candidate).startsWith(`${path.resolve(outputRoot)}${path.sep}`)) {
      await fs.rm(candidate, { recursive: true, force: true });
    }
  }
  await fs.mkdir(stagingRoot, { recursive: true });
  try {
    await fs.writeFile(path.join(stagingRoot, 'package.json'), `${JSON.stringify({
      name: 'fire-crew-mode-manager',
      productName: MANAGER_NAME,
      version: require('../package.json').version,
      main: 'tools/mode-list-manager/main.js',
      private: true,
      dependencies: {
        'adm-zip': require('../node_modules/adm-zip/package.json').version
      }
    }, null, 2)}\n`, 'utf8');
    for (const entry of [
      'tools/mode-list-manager',
      'src/config.js',
      'src/core.js',
      'src/file-utils.js',
      'src/patch-service.js',
      'assets/distribution-manifest.json',
      'assets/runtime-config.json',
      'assets/logo.ico',
      'node_modules/adm-zip'
    ]) await copy(projectRoot, stagingRoot, entry);

    const { packager } = await import('@electron/packager');
    const outputs = await packager({
      dir: stagingRoot,
      name: MANAGER_NAME,
      platform: 'win32',
      arch: 'x64',
      electronVersion: require('electron/package.json').version,
      out: outputRoot,
      overwrite: true,
      icon: path.join(stagingRoot, 'assets', 'logo.ico'),
      asar: true
    });
    await normalizeWindowsPackageNames(outputRoot);
    const result = await verifyPackage(targetRoot);
    process.stdout.write(`모드 관리자 패키지를 생성하고 필수 파일 ${result.required}개를 검증했습니다: ${targetRoot}\n`);
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { MANAGER_NAME, verifyPackage };
