'use strict';

let fs = require('node:fs');
let fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

try {
  fs = require('original-fs');
  fsp = fs.promises;
} catch {
  // original-fs is provided by Electron. Node tests use the standard filesystem.
}

const UPDATE_JOB_ARGUMENT = '--launcher-update-job=';

function updateJobFileFromArgv(argv = process.argv) {
  const argument = argv.find((value) => String(value).startsWith(UPDATE_JOB_ARGUMENT));
  return argument ? path.resolve(argument.slice(UPDATE_JOB_ARGUMENT.length)) : '';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessExit(processId, { timeoutMs = 60000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(processId)) {
    if (Date.now() >= deadline) throw new Error('기존 런처가 제한 시간 안에 종료되지 않았습니다.');
    await delay(pollMs);
  }
}

async function retry(operation, {
  attempts = 12,
  delayMs = 500,
  onRetry = () => {}
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      onRetry(error, attempt);
      await delay(delayMs);
    }
  }
  throw lastError;
}

function assertSafeJobPath(value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} 경로가 올바르지 않습니다.`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(`${label}에 루트 경로를 사용할 수 없습니다.`);
  return resolved;
}

function validateUpdateJob(job) {
  if (!job || job.schemaVersion !== 1) throw new Error('지원하지 않는 업데이트 작업 형식입니다.');
  const executableName = path.basename(String(job.executableName || ''));
  if (!executableName || executableName !== job.executableName || !executableName.toLowerCase().endsWith('.exe')) {
    throw new Error('런처 실행 파일 이름이 올바르지 않습니다.');
  }
  const normalized = {
    schemaVersion: 1,
    parentPid: Number(job.parentPid),
    stagingRoot: assertSafeJobPath(job.stagingRoot, '업데이트 원본'),
    installRoot: assertSafeJobPath(job.installRoot, '설치'),
    helperRoot: assertSafeJobPath(job.helperRoot, '업데이트 도우미'),
    versionRoot: assertSafeJobPath(job.versionRoot, '업데이트 작업'),
    logFile: assertSafeJobPath(job.logFile, '업데이트 로그'),
    executableName,
    targetVersion: String(job.targetVersion || '')
  };
  if (!Number.isInteger(normalized.parentPid) || normalized.parentPid <= 0) {
    throw new Error('종료를 기다릴 런처 프로세스가 올바르지 않습니다.');
  }
  if (normalized.stagingRoot === normalized.installRoot) {
    throw new Error('업데이트 원본과 설치 경로가 같습니다.');
  }
  return normalized;
}

async function appendLog(logFile, message) {
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  await fsp.appendFile(logFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

async function spawnAndConfirm(command, args, options, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, options);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      resolve(child);
    });
  });
}

async function deployPayload(stagingRoot, installRoot, onProgress) {
  try {
    await retry(() => fsp.rename(stagingRoot, installRoot), {
      attempts: 5,
      delayMs: 400,
      onRetry: (_error, attempt) => onProgress(48 + attempt, '새 버전 배치를 다시 시도하고 있습니다.')
    });
    return 'rename';
  } catch (error) {
    if (await pathExists(installRoot)) throw error;
  }

  await retry(async () => {
    await fsp.rm(installRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await fsp.cp(stagingRoot, installRoot, {
      recursive: true,
      force: true,
      errorOnExist: false
    });
  }, {
    attempts: 3,
    delayMs: 700,
    onRetry: (_error, attempt) => onProgress(55 + attempt * 5, '새 버전 파일 복사를 다시 시도하고 있습니다.')
  });
  return 'copy';
}

async function restartLauncher(executablePath, installRoot, helperRoot, spawnImpl = spawn) {
  const child = await spawnAndConfirm(executablePath, [
    `--cleanup-update-helper=${helperRoot}`
  ], {
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
    cwd: installRoot
  }, spawnImpl);
  child.unref();
  return child;
}

async function confirmRestartStayedAlive(child, waitMs = 2500) {
  await delay(waitMs);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`새 런처가 시작 직후 종료되었습니다 (종료 코드 ${child.exitCode ?? child.signalCode}).`);
  }
}

async function applyUpdateJob(rawJob, {
  onProgress = () => {},
  spawnImpl = spawn
} = {}) {
  const job = validateUpdateJob(rawJob);
  const installParent = path.dirname(job.installRoot);
  const backupRoot = path.join(
    installParent,
    `${path.basename(job.installRoot)}.fire-crew-backup-${Date.now()}`
  );
  const executablePath = path.join(job.installRoot, job.executableName);
  let backupCreated = false;
  let updateSucceeded = false;

  await appendLog(job.logFile, `GUI 업데이트 도우미 시작 · ${job.targetVersion}`);
  try {
    onProgress(8, '기존 런처가 종료되기를 기다리고 있습니다.');
    await waitForProcessExit(job.parentPid);
    await delay(800);

    onProgress(25, '기존 설치 파일을 안전하게 백업하고 있습니다.');
    await retry(() => fsp.rename(job.installRoot, backupRoot), {
      attempts: 20,
      delayMs: 500,
      onRetry: (error, attempt) => {
        onProgress(Math.min(44, 25 + attempt), `설치 폴더 사용 해제를 기다리는 중 (${attempt}/19)`);
        appendLog(job.logFile, `설치 폴더 백업 재시도 ${attempt}: ${error.message}`).catch(() => {});
      }
    });
    backupCreated = true;

    onProgress(48, '새 버전을 설치하고 있습니다.');
    const deployment = await deployPayload(job.stagingRoot, job.installRoot, onProgress);
    await appendLog(job.logFile, `새 버전 배치 완료 · ${deployment}`);

    onProgress(82, '설치 결과를 검증하고 있습니다.');
    await fsp.access(executablePath, fs.constants.R_OK);
    await fsp.access(path.join(job.installRoot, 'resources', 'app.asar'), fs.constants.R_OK);

    onProgress(92, '새 런처를 시작하고 있습니다.');
    const restartedLauncher = await restartLauncher(executablePath, job.installRoot, job.helperRoot, spawnImpl);
    await confirmRestartStayedAlive(restartedLauncher);
    updateSucceeded = true;
    await appendLog(job.logFile, `업데이트 및 재시작 완료 · ${job.targetVersion}`);
    onProgress(100, '업데이트가 완료되었습니다. 새 런처를 시작했습니다.');

    fsp.rm(backupRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      .catch((error) => appendLog(job.logFile, `이전 버전 정리 보류: ${error.message}`));
    fsp.rm(job.versionRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      .catch(() => {});
    return { updated: true, deployment, backupRoot };
  } catch (error) {
    await appendLog(job.logFile, `업데이트 실패: ${error.stack || error.message}`);
    onProgress(90, '설치에 실패해 이전 버전을 복구하고 있습니다.', error.message);
    if (backupCreated) {
      try {
        await fsp.rm(job.installRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        await retry(() => fsp.rename(backupRoot, job.installRoot), { attempts: 20, delayMs: 500 });
        await appendLog(job.logFile, '이전 버전 롤백 완료');
      } catch (rollbackError) {
        await appendLog(job.logFile, `이전 버전 롤백 실패: ${rollbackError.stack || rollbackError.message}`);
        error.message += `\n이전 버전 복구도 실패했습니다: ${rollbackError.message}`;
      }
    }
    if (await pathExists(executablePath)) {
      try {
        await restartLauncher(executablePath, job.installRoot, job.helperRoot, spawnImpl);
        await appendLog(job.logFile, '기존 런처 재시작 완료');
      } catch (restartError) {
        await appendLog(job.logFile, `기존 런처 재시작 실패: ${restartError.message}`);
      }
    }
    throw error;
  } finally {
    if (!updateSucceeded) onProgress(100, '업데이트를 완료하지 못했습니다. 이전 버전으로 복구했습니다.');
  }
}

function updaterHtml() {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>불꽃단 런처 업데이트</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0b0d12;color:#f7f2ea;font-family:"Malgun Gothic",sans-serif}.wrap{padding:30px}.brand{color:#ff6847;font-weight:800;font-size:14px;letter-spacing:.12em}.title{font-size:25px;font-weight:800;margin:12px 0 8px}.message{color:#c9c5be;min-height:48px;line-height:1.55}.track{height:12px;background:#252934;border-radius:999px;overflow:hidden;margin:24px 0 12px}.bar{height:100%;width:0;background:linear-gradient(90deg,#ff4b2b,#ff9b42);transition:width .28s ease}.meta{display:flex;justify-content:space-between;color:#918d87;font-size:12px}.detail{margin-top:22px;padding:12px;background:#151820;border:1px solid #272c38;border-radius:8px;color:#e07868;font-size:12px;line-height:1.45;display:none;white-space:pre-wrap}</style></head>
<body><div class="wrap"><div class="brand">FIRE CREW LAUNCHER</div><div class="title">런처를 업데이트하고 있습니다</div><div id="message" class="message">업데이트 도우미를 준비하고 있습니다.</div><div class="track"><div id="bar" class="bar"></div></div><div class="meta"><span>창을 닫거나 컴퓨터를 종료하지 마세요.</span><span id="percent">0%</span></div><div id="detail" class="detail"></div></div>
<script>window.setUpdateProgress=(value)=>{document.getElementById('bar').style.width=Math.max(0,Math.min(100,value.percent))+'%';document.getElementById('percent').textContent=value.percent+'%';document.getElementById('message').textContent=value.message||'';const detail=document.getElementById('detail');detail.textContent=value.detail||'';detail.style.display=value.detail?'block':'none';if(value.failed){document.querySelector('.title').textContent='업데이트를 완료하지 못했습니다';document.querySelector('.bar').style.background='#d94d3f';}};</script></body></html>`;
}

async function runUpdateHelper({ app, BrowserWindow, jobFile }) {
  const window = new BrowserWindow({
    width: 560,
    height: 350,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    title: '불꽃단 런처 업데이트',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(updaterHtml())}`);
  window.show();

  const update = (percent, message, detail = '', failed = false) => {
    window.setProgressBar(percent / 100);
    if (!window.isDestroyed()) {
      window.webContents.executeJavaScript(
        `window.setUpdateProgress(${JSON.stringify({ percent, message, detail, failed })})`
      ).catch(() => {});
    }
  };

  try {
    const rawJob = JSON.parse(await fsp.readFile(jobFile, 'utf8'));
    await applyUpdateJob(rawJob, { onProgress: update });
    await delay(1600);
  } catch (error) {
    update(100, '업데이트를 완료하지 못했습니다. 이전 버전을 다시 시작합니다.', error.message, true);
    window.setClosable(true);
    await delay(10000);
  } finally {
    if (!window.isDestroyed()) {
      window.setClosable(true);
      window.close();
    }
    app.quit();
  }
}

async function cleanupUpdateHelpers(dataRoot) {
  const helperParent = path.join(dataRoot, 'launcher-updater-helper');
  await delay(5000);
  await fsp.rm(helperParent, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 300
  }).catch(() => {});
}

module.exports = {
  UPDATE_JOB_ARGUMENT,
  applyUpdateJob,
  cleanupUpdateHelpers,
  confirmRestartStayedAlive,
  deployPayload,
  retry,
  runUpdateHelper,
  updateJobFileFromArgv,
  validateUpdateJob,
  waitForProcessExit
};
