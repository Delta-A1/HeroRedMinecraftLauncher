'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const project = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const buildDirectory = path.join(projectRoot, 'dist', '불꽃단 런처-win32-x64');
  const executable = path.join(buildDirectory, '불꽃단 런처.exe');
  const configFile = path.join(projectRoot, 'electron-builder.yml');
  const builderCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  const installerName = `fire-crew-launcher-setup-v${project.version}.exe`;
  const installerFile = path.join(projectRoot, 'release', installerName);

  await Promise.all([
    fs.access(executable),
    fs.access(configFile),
    fs.access(builderCli)
  ]);
  await fs.rm(installerFile, { force: true });
  await fs.rm(`${installerFile}.blockmap`, { force: true });

  await execFileAsync(process.execPath, [
    builderCli,
    '--win',
    'nsis',
    '--x64',
    '--prepackaged',
    buildDirectory,
    '--config',
    configFile,
    '--publish',
    'never'
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'
    },
    maxBuffer: 20 * 1024 * 1024
  });

  const installer = await fs.stat(installerFile);
  if (!installer.isFile() || installer.size < 1024 * 1024) {
    throw new Error(`Windows 설치 프로그램이 올바르게 생성되지 않았습니다: ${installerFile}`);
  }
  process.stdout.write(`고정 경로 Windows 설치 프로그램을 생성했습니다:\n${installerFile}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stdout || ''}${error.stderr || ''}${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
