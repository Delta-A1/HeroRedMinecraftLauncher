'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  LauncherUpdateService,
  compareVersions,
  normalizeRepository,
  safeEntryPath,
  selectWindowsAsset,
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

test('ZIP entries cannot escape the staging directory', () => {
  const root = path.resolve('updates', 'staging');
  assert.equal(safeEntryPath(root, 'resources/app.asar'), path.join(root, 'resources', 'app.asar'));
  assert.throws(() => safeEntryPath(root, '../outside.exe'), /벗어납니다/);
  assert.throws(() => safeEntryPath(root, 'C:\\outside.exe'), /안전하지 않은/);
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
