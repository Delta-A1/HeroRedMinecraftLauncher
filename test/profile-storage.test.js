'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listUnusedProfileDirectories, removeUnusedProfileDirectories } = require('../src/profile-storage');
const { createLaunchProfiles, PRODUCT } = require('../src/config');

test('프로필 주소가 기존 host/port보다 우선한다', () => {
  const [profile] = createLaunchProfiles({ profiles: [{
    id: 'server',
    server: { address: 'new.example.test:25570', host: 'old.example.test', port: 25565 }
  }] }, PRODUCT);
  assert.equal(profile.server.host, 'new.example.test');
  assert.equal(profile.server.port, 25570);
});

test('사용되지 않는 프로필만 조회하고 삭제한다', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-crew-profiles-'));
  await fs.mkdir(path.join(root, 'profiles', 'current'), { recursive: true });
  await fs.mkdir(path.join(root, 'profiles', 'old-profile'), { recursive: true });
  const profiles = [{ id: 'current' }, { id: 'new-profile' }];
  const candidates = await listUnusedProfileDirectories(root, profiles, 'current');
  assert.deepEqual(candidates.map((entry) => entry.id), ['old-profile']);
  const removed = await removeUnusedProfileDirectories(root, profiles, 'current');
  assert.deepEqual(removed.map((entry) => entry.id), ['old-profile']);
  await assert.rejects(fs.access(path.join(root, 'profiles', 'old-profile')));
  await fs.access(path.join(root, 'profiles', 'current'));
});
