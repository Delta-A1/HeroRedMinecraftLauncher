'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('Windows 설치기는 사용자별 고정 경로만 사용하고 경로 선택을 제공하지 않는다', async () => {
  const root = path.resolve(__dirname, '..');
  const [config, include, packageJson, mainSource] = await Promise.all([
    fs.readFile(path.join(root, 'electron-builder.yml'), 'utf8'),
    fs.readFile(path.join(root, 'build', 'installer.nsh'), 'utf8'),
    fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'src', 'main.js'), 'utf8')
  ]);

  assert.match(config, /oneClick:\s*true/);
  assert.match(config, /perMachine:\s*false/);
  assert.match(config, /allowToChangeInstallationDirectory:\s*false/);
  assert.match(config, /fire-crew-launcher-setup-v\$\{version\}\.\$\{ext\}/);
  assert.match(include, /\$LOCALAPPDATA\\Programs\\FireCrewLauncher/);
  assert.match(include, /StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\FireCrewLauncher"/);
  assert.match(packageJson.scripts['release:win'], /installer:win/);
  assert.ok(packageJson.devDependencies['electron-builder']);
  assert.match(mainSource, /isApprovedInstallPath/);
  assert.match(mainSource, /공식 설치 프로그램으로 설치해야 합니다/);
});

test('GitHub 릴리즈는 설치 EXE와 체크섬을 게시한다', async () => {
  const root = path.resolve(__dirname, '..');
  const [workflow, releaseBuilder, installerBuilder] = await Promise.all([
    fs.readFile(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8'),
    fs.readFile(path.join(root, 'tools', 'build-github-release.cjs'), 'utf8'),
    fs.readFile(path.join(root, 'tools', 'build-windows-installer.cjs'), 'utf8')
  ]);

  assert.match(workflow, /release\/\*\.exe/);
  assert.match(workflow, /release\/\*\.sha256/);
  assert.match(releaseBuilder, /installerFile.*sha256/s);
  assert.match(installerBuilder, /--prepackaged/);
  assert.match(installerBuilder, /--publish[\s\S]*never/);
  assert.match(installerBuilder, /electron-builder\.yml/);
});
