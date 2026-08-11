'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const outputRoot = path.resolve(process.argv[2] || 'admin-signing-key');
  await fs.mkdir(outputRoot, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const publicFile = path.join(outputRoot, 'fire-crew-manifest-public.pem');
  const privateFile = path.join(outputRoot, 'fire-crew-manifest-private.pem');
  await fs.writeFile(publicFile, publicKey, { encoding: 'utf8', mode: 0o644 });
  await fs.writeFile(privateFile, privateKey, { encoding: 'utf8', mode: 0o600 });
  console.log(`Public key: ${publicFile}`);
  console.log(`Private key: ${privateFile}`);
  console.log('Private key must never be bundled with or uploaded alongside the launcher.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
