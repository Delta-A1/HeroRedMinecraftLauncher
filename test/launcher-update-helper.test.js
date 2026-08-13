'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applyUpdateJob,
  updateJobFileFromArgv,
  validateUpdateJob
} = require('../src/launcher-update-helper');

function successfulSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
}

async function createJobFixture(context, { completePayload = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-crew-gui-updater-'));
  context.after(() => fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100
  }));
  const versionRoot = path.join(root, 'version');
  const stagingRoot = path.join(versionRoot, 'staging');
  const installRoot = path.join(root, 'OneDrive 바탕 화면', '불꽃단 런처 (test)');
  const helperRoot = path.join(root, 'helper');
  const logFile = path.join(root, 'launcher-update.log');
  await fs.mkdir(path.join(stagingRoot, 'resources'), { recursive: true });
  await fs.mkdir(path.join(installRoot, 'resources'), { recursive: true });
  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(path.join(stagingRoot, '불꽃단 런처.exe'), 'new executable');
  await fs.writeFile(path.join(stagingRoot, 'payload.txt'), 'new payload');
  if (completePayload) await fs.writeFile(path.join(stagingRoot, 'resources', 'app.asar'), 'new asar');
  await fs.writeFile(path.join(installRoot, '불꽃단 런처.exe'), 'old executable');
  await fs.writeFile(path.join(installRoot, 'payload.txt'), 'old payload');
  await fs.writeFile(path.join(installRoot, 'resources', 'app.asar'), 'old asar');
  await fs.writeFile(path.join(installRoot, 'Uninstall Fire Crew Launcher.exe'), 'installer uninstaller');
  return {
    schemaVersion: 1,
    parentPid: 2147483647,
    stagingRoot,
    installRoot,
    helperRoot,
    versionRoot,
    logFile,
    executableName: '불꽃단 런처.exe',
    targetVersion: '1.1.0'
  };
}

test('GUI updater job argument and paths are validated', () => {
  const jobFile = updateJobFileFromArgv(['launcher.exe', '--launcher-update-job=C:\\updates\\job.json']);
  assert.equal(jobFile, path.resolve('C:\\updates\\job.json'));
  assert.throws(() => validateUpdateJob({ schemaVersion: 2 }), /지원하지 않는/);
  assert.throws(() => validateUpdateJob({
    schemaVersion: 1,
    parentPid: 1,
    stagingRoot: path.resolve('same'),
    installRoot: path.resolve('same'),
    helperRoot: path.resolve('helper'),
    versionRoot: path.resolve('version'),
    logFile: path.resolve('update.log'),
    executableName: 'launcher.exe'
  }), /같습니다/);
});

test('GUI updater atomically replaces the install directory and restarts the new launcher', async (context) => {
  const job = await createJobFixture(context);
  const spawnCalls = [];
  const progress = [];

  const result = await applyUpdateJob(job, {
    spawnImpl: successfulSpawn(spawnCalls),
    onProgress: (percent, message) => progress.push({ percent, message })
  });

  assert.equal(result.updated, true);
  assert.equal(await fs.readFile(path.join(job.installRoot, 'payload.txt'), 'utf8'), 'new payload');
  assert.equal(await fs.readFile(path.join(job.installRoot, 'resources', 'app.asar'), 'utf8'), 'new asar');
  assert.equal(
    await fs.readFile(path.join(job.installRoot, 'Uninstall Fire Crew Launcher.exe'), 'utf8'),
    'installer uninstaller'
  );
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, path.join(job.installRoot, job.executableName));
  assert.ok(spawnCalls[0].args.some((argument) => argument.startsWith('--cleanup-update-helper=')));
  assert.equal(progress.at(-1).percent, 100);
  assert.match(await fs.readFile(job.logFile, 'utf8'), /업데이트 및 재시작 완료/);
});

test('GUI updater rolls back the complete old installation and restarts it after validation failure', async (context) => {
  const job = await createJobFixture(context, { completePayload: false });
  const spawnCalls = [];
  const progress = [];

  await assert.rejects(
    applyUpdateJob(job, {
      spawnImpl: successfulSpawn(spawnCalls),
      onProgress: (percent, message, detail) => progress.push({ percent, message, detail })
    })
  );

  assert.equal(await fs.readFile(path.join(job.installRoot, 'payload.txt'), 'utf8'), 'old payload');
  assert.equal(await fs.readFile(path.join(job.installRoot, 'resources', 'app.asar'), 'utf8'), 'old asar');
  assert.equal(spawnCalls.length, 1);
  assert.match(await fs.readFile(job.logFile, 'utf8'), /이전 버전 롤백 완료/);
  assert.ok(progress.some((entry) => /복구/.test(entry.message)));
});
