'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { signPayload } = require('./mode-list-manager/core');
const { writeJsonAtomic } = require('../src/file-utils');

async function main() {
  const manifestFile = path.resolve(process.argv[2] || 'assets/distribution-manifest.json');
  const privateKeyFile = path.resolve(process.argv[3] || 'admin-signing-key/fire-crew-manifest-private.pem');
  const runtimeConfigFile = path.resolve('assets/runtime-config.json');
  const [manifest, privateKey, runtimeConfig] = await Promise.all([
    fs.readFile(manifestFile, 'utf8').then(JSON.parse),
    fs.readFile(privateKeyFile, 'utf8'),
    fs.readFile(runtimeConfigFile, 'utf8').then(JSON.parse)
  ]);
  const envelope = signPayload(manifest.payload || manifest, privateKey, runtimeConfig.distributionPublicKey);
  await writeJsonAtomic(manifestFile, envelope);
  process.stdout.write(`서명 완료: ${manifestFile}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
