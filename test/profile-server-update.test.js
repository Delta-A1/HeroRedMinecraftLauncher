'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLaunchProfiles, productForProfile, updateProfileServers } = require('../src/config');
const { PatchService, stableStringify } = require('../src/patch-service');
const { readServerList, upsertServer } = require('../src/server-list');

test('포트 없는 새 주소는 이전 프로필 포트 대신 Minecraft 기본 포트를 사용한다', () => {
  for (const address of ['new.example.test', '[2001:db8::1]']) {
    const [profile] = createLaunchProfiles({ profiles: [{
      server: { address, host: 'old.example.test', port: 19003 }
    }] });
    assert.equal(profile.server.port, 25565);
    assert.equal(profile.server.host, address.replace(/^\[|]$/g, ''));
  }
});

test('검증된 목록의 주소 변경이 버전 변경 없이 실행 대상과 서버 목록에 반영된다', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-crew-server-update-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  let profiles = createLaunchProfiles({ profiles: [{
    id: 'main', server: { address: 'old.example.test:19003' }
  }] });
  const product = productForProfile(profiles[0]);
  const sharedServer = product.server;
  const payload = {
    schemaVersion: 2, ready: true, version: 'unchanged',
    profiles: [{ ...profiles[0], version: 'unchanged', ready: true, files: [],
      server: { ...profiles[0].server, address: 'new.example.test:25570' }
    }]
  };
  const file = path.join(root, 'manifest.json');
  async function writeManifest() {
    const jsonPayload = JSON.parse(JSON.stringify(payload));
    await fs.writeFile(file, JSON.stringify({ payload: jsonPayload, signature: crypto.sign(
      null, Buffer.from(stableStringify(jsonPayload)), privateKey
    ).toString('base64') }));
  }
  await writeManifest();
  const service = new PatchService({
    product, publicKey, localManifestPath: file,
    stateFile: path.join(root, 'installed.json'),
    onManifestVerified: (verified) => {
      profiles = updateProfileServers(profiles, verified);
      Object.assign(product.server, profiles[0].server);
    }
  });
  await upsertServer(root, product.server);
  await service.getStatus();
  assert.equal(product.server, sharedServer);
  assert.equal(product.server.address, 'new.example.test:25570');
  assert.equal(product.server.host, 'new.example.test');
  assert.equal(product.server.port, 25570);
  await upsertServer(root, product.server);
  const list = await readServerList(path.join(root, 'servers.dat'));
  assert.equal(list.servers.length, 1);
  assert.equal(list.servers[0].ip, product.server.address);

  payload.profiles[0].server.address = 'latest.example.test';
  await writeManifest();
  await service.getStatus();
  assert.equal(product.server.host, 'latest.example.test');
  assert.equal(product.server.port, 25565);

  // A tampered address must never reach the connection settings.
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  envelope.payload.profiles[0].server.address = 'tampered.example.test';
  await fs.writeFile(file, JSON.stringify(envelope));
  await assert.rejects(service.getStatus(), /서명 검증/);
  assert.equal(product.server.host, 'latest.example.test');
});

test('주소 갱신은 동일 ID와 모드팩에만 적용하고 설치 구성을 유지한다', () => {
  const profiles = createLaunchProfiles({ profiles: [{ id: 'main' }, { id: 'other' }] });
  const payload = { schemaVersion: 2, profiles: [{
    ...profiles[0], server: { address: '[2001:db8::2]:25570' },
    minecraft: { version: 'different' }
  }, { ...profiles[1], pack: { id: 'different' }, server: { address: 'wrong.test' } }] };
  const updated = updateProfileServers(profiles, payload);
  assert.equal(updated[0].server.host, '2001:db8::2');
  assert.equal(updated[0].server.port, 25570);
  assert.equal(updated[0].minecraft, profiles[0].minecraft);
  assert.equal(updated[1], profiles[1]);
  assert.equal(updateProfileServers(profiles, { schemaVersion: 1 }), profiles);
});
