'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const {
  LauncherUpdateService,
  compareVersions,
  extractArchiveToStaging,
  normalizeRepository,
  powerShellCandidates,
  safeEntryPath,
  selectWindowsAsset,
  spawnPowerShellScript,
  sha256FromAsset
} = require('../src/launcher-update-service');

test('semantic versions including prereleases are compared correctly', () => {
  assert.equal(compareVersions('0.4.3-login-test.9', '0.4.3-login-test.8'), 1);
  assert.equal(compareVersions('0.4.3', '0.4.3-login-test.9'), 1);
  assert.equal(compareVersions('v1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.1'), 0);
});

test('GitHub repository values are normalized and validated', () => {
  assert.equal(normalizeRepository('https://github.com/fire-crew/launcher.git'), 'fire-crew/launcher');
  assert.equal(normalizeRepository(''), '');
  assert.throws(() => normalizeRepository('fire-crew'), /owner\/repository/);
});

test('Windows x64 update ZIP and GitHub digest are selected', () => {
  const assets = [
    { name: 'Source.zip' },
    { name: 'fire-crew-launcher-windows-x64-v1.2.0.zip', digest: `sha256:${'a'.repeat(64)}` }
  ];
  const asset = selectWindowsAsset(assets);
  assert.equal(asset.name, 'fire-crew-launcher-windows-x64-v1.2.0.zip');
  assert.equal(sha256FromAsset(asset), 'a'.repeat(64));
});

test('PowerShell lookup prioritizes the absolute Windows system path', () => {
  const candidates = powerShellCandidates({
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files'
  });

  assert.equal(
    candidates[0],
    path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  );
  assert.ok(candidates.includes('powershell.exe'));
});

test('PowerShell launcher retries after an asynchronous ENOENT and waits for spawn', async () => {
  const commands = [];
  let unrefCalled = false;
  const spawnImpl = (command) => {
    commands.push(command);
    const child = new EventEmitter();
    child.unref = () => {
      unrefCalled = true;
    };
    queueMicrotask(() => {
      if (commands.length === 1) {
        const error = new Error('not found');
        error.code = 'ENOENT';
        child.emit('error', error);
      } else {
        child.emit('spawn');
      }
    });
    return child;
  };

  const command = await spawnPowerShellScript(spawnImpl, 'C:\\update\\apply-update.ps1', {
    env: { SystemRoot: 'C:\\Windows' }
  });

  assert.equal(commands.length, 2);
  assert.equal(command, commands[1]);
  assert.equal(unrefCalled, true);
});

test('PowerShell launcher reports a clear error when every candidate is missing', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => {
      const error = new Error('not found');
      error.code = 'ENOENT';
      child.emit('error', error);
    });
    return child;
  };

  await assert.rejects(
    spawnPowerShellScript(spawnImpl, 'C:\\update\\apply-update.ps1', { env: {} }),
    (error) => error.code === 'POWERSHELL_NOT_FOUND' && /PowerShell/.test(error.message)
  );
});

test('ZIP entries cannot escape the staging directory', () => {
  const root = path.resolve('updates', 'staging');
  assert.equal(safeEntryPath(root, 'resources/app.asar'), path.join(root, 'resources', 'app.asar'));
  assert.throws(() => safeEntryPath(root, '../outside.exe'), /벗어납니다/);
  assert.throws(() => safeEntryPath(root, 'C:\\outside.exe'), /안전하지 않은/);
});

test('update ZIP is extracted without relying on chmod', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-crew-update-'));
  try {
    const archive = new AdmZip();
    archive.addFile('resources/app.asar', Buffer.from('launcher payload'));
    archive.addFile('launcher.exe', Buffer.from('executable payload'));

    const stagingRoot = path.join(temporaryRoot, 'staging');
    await extractArchiveToStaging(archive, stagingRoot);

    assert.equal(await fs.readFile(path.join(stagingRoot, 'resources', 'app.asar'), 'utf8'), 'launcher payload');
    assert.equal(await fs.readFile(path.join(stagingRoot, 'launcher.exe'), 'utf8'), 'executable payload');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('latest GitHub release produces an available update state', async () => {
  const service = new LauncherUpdateService({
    currentVersion: '1.0.0',
    repository: 'fire-crew/launcher',
    dataRoot: path.resolve('updates'),
    execPath: path.resolve('불꽃단 런처.exe'),
    isPackaged: true,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.github.com/repos/fire-crew/launcher/releases/latest');
      return new Response(JSON.stringify({
        tag_name: 'v1.1.0',
        name: 'Launcher 1.1.0',
        html_url: 'https://github.com/fire-crew/launcher/releases/tag/v1.1.0',
        published_at: '2026-08-12T00:00:00Z',
        assets: [{
          name: 'fire-crew-launcher-windows-x64-v1.1.0.zip',
          browser_download_url: 'https://example.invalid/launcher.zip',
          digest: `sha256:${'b'.repeat(64)}`
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const status = await service.check();
  assert.equal(status.state, 'available');
  assert.equal(status.latestVersion, '1.1.0');
  assert.equal(status.available, true);
});
