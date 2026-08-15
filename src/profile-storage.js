'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function listUnusedProfileDirectories(dataRoot, profiles = [], activeProfileId = '') {
  const root = path.join(dataRoot, 'profiles');
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const known = new Set(profiles.map((profile) => String(profile.id || '').toLowerCase()));
  const active = String(activeProfileId || '').toLowerCase();
  return entries.filter((entry) => entry.isDirectory())
    .filter((entry) => !known.has(entry.name.toLowerCase()))
    .filter((entry) => entry.name.toLowerCase() !== active)
    .map((entry) => ({ id: entry.name, path: path.join(root, entry.name) }));
}

async function removeUnusedProfileDirectories(dataRoot, profiles = [], activeProfileId = '') {
  const candidates = await listUnusedProfileDirectories(dataRoot, profiles, activeProfileId);
  await Promise.all(candidates.map((candidate) => fs.rm(candidate.path, { recursive: true, force: true })));
  return candidates;
}

module.exports = { listUnusedProfileDirectories, removeUnusedProfileDirectories };
