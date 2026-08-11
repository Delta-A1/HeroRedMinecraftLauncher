'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Agent, interceptors } = require('undici');

const RETRYABLE_INSTALL_PATTERN =
  /AggregateError|timeout|timed out|checksum|socket|connect|ECONN|ENET|EAI_AGAIN|UND_ERR|fetch failed/i;

function createMinecraftDownloadDispatcher(options = {}) {
  return new Agent({
    connections: options.connections || 4,
    connectTimeout: options.connectTimeoutMs || 60_000,
    headersTimeout: options.headersTimeoutMs || 60_000,
    bodyTimeout: options.bodyTimeoutMs || 300_000,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 1_000
  }).compose(interceptors.redirect({ maxRedirections: 5 }));
}

function collectErrorMessages(error, output = []) {
  if (!error) return output;
  if (error.message) output.push(String(error.message));
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) collectErrorMessages(nested, output);
  }
  if (error.cause && error.cause !== error) collectErrorMessages(error.cause, output);
  return output;
}

function isRetryableInstallError(error) {
  const codes = [];
  const visit = (current) => {
    if (!current) return;
    if (current.code) codes.push(String(current.code));
    if (Array.isArray(current.errors)) current.errors.forEach(visit);
    if (current.cause && current.cause !== current) visit(current.cause);
  };
  visit(error);
  return RETRYABLE_INSTALL_PATTERN.test(
    [error?.name, ...codes, ...collectErrorMessages(error)].filter(Boolean).join(' ')
  );
}

async function retryInstall(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const shouldRetry = options.shouldRetry || isRetryableInstallError;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      await options.cleanup?.({ attempt, error });
      options.onRetry?.({ attempt, nextAttempt: attempt + 1, attempts, error });
      await sleep(Math.min(5_000, 1_000 * attempt));
    }
  }
  throw lastError;
}

async function removeZeroByteInstallFiles(roots) {
  const removed = [];
  const walk = async (currentRoot) => {
    let entries;
    try {
      entries = await fs.readdir(currentRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const target = path.join(currentRoot, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
        return;
      }
      if (!entry.isFile() || !/\.(jar|json)$/i.test(entry.name)) return;
      const stat = await fs.stat(target).catch(() => null);
      if (stat?.size !== 0) return;
      await fs.unlink(target).catch(() => {});
      removed.push(target);
    }));
  };
  for (const root of roots) await walk(root);
  return removed;
}

module.exports = {
  collectErrorMessages,
  createMinecraftDownloadDispatcher,
  isRetryableInstallError,
  removeZeroByteInstallFiles,
  retryInstall
};
