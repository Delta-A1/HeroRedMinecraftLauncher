'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeWindowsPackageNames } = require('./normalize-windows-package-names.cjs');

const WINDOWS_BUILD_NAME = '불꽃단 런처-win32-x64';

const BUILD_IGNORE_PATTERNS = Object.freeze([
  /^\/release(?:\/|$)/,
  /^\/dist-admin(?:\/|$)/,
  /^\/internal-build(?:\/|$)/,
  /^\/admin-signing-key(?:\/|$)/,
  /\.pem$/i,
  /^\/test(?:\/|$)/,
  /^\/tools(?:\/|$)/,
  /^\/README-KO\.md$/,
  /^\/BUILD-VALIDATION-KO\.md$/,
  /^\/COMPATIBILITY-REPORT-KO\.md$/
]);

function normalizeAsarPath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/^(?:\.\/)+/, '');
}

function isBuildIgnored(relativePath) {
  const normalized = `/${normalizeAsarPath(relativePath)}`;
  return BUILD_IGNORE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function windowsBuildDirectories(outputRoot) {
  const resolvedOutput = path.resolve(outputRoot);
  return [...new Set([
    WINDOWS_BUILD_NAME.normalize('NFC'),
    WINDOWS_BUILD_NAME.normalize('NFD')
  ])].map((name) => {
    const target = path.resolve(resolvedOutput, name);
    if (path.dirname(target) !== resolvedOutput) {
      throw new Error(`안전하지 않은 Windows 빌드 출력 경로입니다: ${target}`);
    }
    return target;
  });
}

async function requiredRuntimeEntries(projectRoot) {
  const project = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const required = ['src/main.js', 'assets/runtime-config.json', 'assets/distribution-manifest.json'];
  for (const name of Object.keys(project.dependencies || {})) {
    const packageRoot = path.join(projectRoot, 'node_modules', ...name.split('/'));
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const main = normalizeAsarPath(manifest.main || 'index.js');
    required.push(`node_modules/${name}/${main}`);
  }
  return required;
}

async function verifyWindowsPackage(buildDirectory, projectRoot) {
  const { listPackage } = await import('@electron/asar');
  const asarFile = path.join(buildDirectory, 'resources', 'app.asar');
  const entries = new Set(listPackage(asarFile).map(normalizeAsarPath));
  const required = await requiredRuntimeEntries(projectRoot);
  const missing = required.filter((entry) => !entries.has(entry));
  if (missing.length) {
    throw new Error(`Windows 패키지 필수 실행 파일이 누락되었습니다:\n${missing.join('\n')}`);
  }
  return { asarFile, entryCount: entries.size, required };
}

function resolveOutputRoot(projectRoot, args = process.argv.slice(2)) {
  const index = args.indexOf('--out');
  if (index === -1) return path.join(projectRoot, 'dist');
  const value = args[index + 1];
  if (!value) throw new Error('--out 다음에 프로젝트 내부 출력 경로가 필요합니다.');
  const resolvedProject = path.resolve(projectRoot);
  const resolvedOutput = path.resolve(projectRoot, value);
  if (resolvedOutput === resolvedProject || !resolvedOutput.startsWith(`${resolvedProject}${path.sep}`)) {
    throw new Error(`Windows 빌드 출력은 프로젝트 내부 폴더여야 합니다: ${resolvedOutput}`);
  }
  return resolvedOutput;
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const outputRoot = resolveOutputRoot(projectRoot);
  const { packager } = await import('@electron/packager');
  await Promise.all(windowsBuildDirectories(outputRoot).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
  const outputDirectories = await packager({
    dir: projectRoot,
    name: '불꽃단 런처',
    platform: 'win32',
    arch: 'x64',
    out: outputRoot,
    overwrite: true,
    icon: path.join(projectRoot, 'assets', 'logo.ico'),
    ignore: BUILD_IGNORE_PATTERNS,
    asar: true
  });
  await normalizeWindowsPackageNames(outputRoot);
  for (const originalDirectory of outputDirectories) {
    const buildDirectory = originalDirectory.normalize('NFC');
    const validation = await verifyWindowsPackage(buildDirectory, projectRoot);
    process.stdout.write(
      `Windows 패키지를 생성하고 필수 실행 파일 ${validation.required.length}개를 검증했습니다: ${buildDirectory}\n`
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BUILD_IGNORE_PATTERNS,
  isBuildIgnored,
  normalizeAsarPath,
  requiredRuntimeEntries,
  resolveOutputRoot,
  verifyWindowsPackage,
  windowsBuildDirectories
};
