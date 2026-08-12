'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { CurseforgeV1Client } = require('@xmcl/curseforge');
const { PRODUCT } = require('../src/config');
const { downloadFile, hashFile, mapLimit, writeJsonAtomic } = require('../src/file-utils');
const { quarantineRuleFor } = require('../src/core');
const { stableStringify } = require('../src/patch-service');

const BLOCKED_FILE_IDS = new Set([4607236, 4618962, 7194089]);
const JET_KOREAN = Object.freeze({
  path: 'resourcepacks/JET-Korean-1.0.8.zip',
  url: 'https://mediafilez.forgecdn.net/files/8379/951/JET-Korean%201.0.8.zip',
  size: 0,
  hash: {
    algorithm: 'sha256',
    value: '449e85d1bc2e954d4b8d3cc9c7f423b7f8880de39311273b07a34844719fd14f'
  },
  source: 'JET Korean 1.0.8 · CurseForge 8379951'
});

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function selectHash(file) {
  const sha1 = file.hashes?.find((entry) => Number(entry.algo) === 1);
  const md5 = file.hashes?.find((entry) => Number(entry.algo) === 2);
  if (sha1) return { algorithm: 'sha1', value: String(sha1.value).toLowerCase() };
  if (md5) return { algorithm: 'md5', value: String(md5.value).toLowerCase() };
  throw new Error(`${file.fileName}에 검증 가능한 CurseForge 해시가 없습니다.`);
}

function projectFolder(project) {
  if (Number(project?.classId) === 12) return 'resourcepacks';
  if (Number(project?.classId) === 6552) return 'shaderpacks';
  return 'mods';
}

async function resolvePackSource(value, explicitUrl) {
  if (/^https:\/\//i.test(value)) {
    const file = path.join(os.tmpdir(), `fire-crew-pack-${Date.now()}.zip`);
    await downloadFile(value, file);
    return { file, url: explicitUrl || value, temporary: true };
  }
  const file = path.resolve(value);
  return { file, url: explicitUrl || '', temporary: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = args['curseforge-key'] || process.env.CURSEFORGE_API_KEY;
  if (!args.pack) throw new Error('--pack <DeceasedCraft ZIP 경로 또는 HTTPS URL>이 필요합니다.');
  if (!apiKey) throw new Error('--curseforge-key 또는 CURSEFORGE_API_KEY가 필요합니다.');
  if (!args['private-key']) throw new Error('--private-key <Ed25519 PEM 경로>가 필요합니다.');
  if (!args.output) throw new Error('--output <JSON 경로>가 필요합니다.');

  const pack = await resolvePackSource(args.pack, args['pack-url']);
  try {
    if (!pack.url) throw new Error('로컬 ZIP을 사용할 때는 플레이어가 받을 --pack-url HTTPS 주소도 필요합니다.');
    const zip = new AdmZip(pack.file);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) throw new Error('CurseForge manifest.json을 찾지 못했습니다.');
    const curseManifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    const declared = Array.isArray(curseManifest.files) ? curseManifest.files : [];
    const client = new CurseforgeV1Client(apiKey);
    const fileIds = declared.map((entry) => Number(entry.fileID));
    const projectIds = [...new Set(declared.map((entry) => Number(entry.projectID)))];

    console.log(`${declared.length}개 CurseForge 파일 메타데이터 조회 중...`);
    const fileGroups = await mapLimit(chunk(fileIds, 50), 3, (ids) => client.getFiles(ids));
    const projectGroups = await mapLimit(chunk(projectIds, 50), 3, (ids) => client.getMods(ids));
    const filesById = new Map(fileGroups.flat().map((entry) => [Number(entry.id), entry]));
    const projectsById = new Map(projectGroups.flat().map((entry) => [Number(entry.id), entry]));
    const outputFiles = [];
    const excluded = [];

    for (const declaredFile of declared) {
      const fileId = Number(declaredFile.fileID);
      const projectId = Number(declaredFile.projectID);
      const file = filesById.get(fileId);
      const project = projectsById.get(projectId);
      if (!file) throw new Error(`CurseForge 파일 정보를 찾지 못했습니다: ${projectId}/${fileId}`);
      const rule = quarantineRuleFor(file.fileName);
      if (BLOCKED_FILE_IDS.has(fileId) || rule) {
        excluded.push({
          projectId,
          fileId,
          fileName: file.fileName,
          reason: rule?.reason || 'CurseForge 제3자 다운로드 제한 또는 선택형 클라이언트 파일'
        });
        continue;
      }
      if (!file.downloadUrl) {
        throw new Error(`${file.fileName}은 외부 런처 다운로드가 허용되지 않습니다. 서버 관리자 검토가 필요합니다.`);
      }
      outputFiles.push({
        path: `${projectFolder(project)}/${file.fileName}`,
        url: file.downloadUrl,
        size: Number(file.fileLength) || 0,
        hash: selectHash(file),
        source: `${project?.name || projectId} · CurseForge ${fileId}`
      });
    }

    outputFiles.push(JET_KOREAN);
    const prefix = String(curseManifest.overrides || 'overrides').replaceAll('\\', '/').replace(/\/+$/, '');
    const managedFiles = zip.getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.entryName.replaceAll('\\', '/'))
      .filter((entry) => entry.startsWith(`${prefix}/`))
      .map((entry) => entry.slice(prefix.length + 1))
      .filter((entry) => entry && !/^(saves|screenshots)(\/|$)/i.test(entry) && !/^servers\.dat$/i.test(entry));
    const packStat = await fs.stat(pack.file);
    const packSha256 = await hashFile(pack.file, 'sha256');
    const existingEnvelope = await fs.readFile(path.resolve(args.output), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    const preservedProfiles = (Array.isArray(existingEnvelope?.payload?.profiles)
      ? existingEnvelope.payload.profiles
      : [])
      .filter((profile) => profile?.pack?.id !== PRODUCT.pack.id);
    const mainProfile = {
      id: 'fire-crew-main',
      name: PRODUCT.server.name,
      description: PRODUCT.pack.name,
      version: args.version || `${PRODUCT.pack.version}.1`,
      ready: true,
      server: PRODUCT.server,
      minecraft: PRODUCT.minecraft,
      pack: PRODUCT.pack,
      archives: [{
        id: `deceasedcraft-overrides-${PRODUCT.pack.version}`,
        url: pack.url,
        size: packStat.size,
        hash: { algorithm: 'sha256', value: packSha256 },
        prefix: `${prefix}/`,
        destination: '',
        managedFiles
      }],
      files: outputFiles.sort((a, b) => a.path.localeCompare(b.path)),
      remove: [],
      excluded
    };
    const payload = {
      schemaVersion: 2,
      ready: true,
      version: args.version || `${PRODUCT.pack.version}.1`,
      generatedAt: new Date().toISOString(),
      profiles: [mainProfile, ...preservedProfiles]
    };
    const privateKey = await fs.readFile(path.resolve(args['private-key']), 'utf8');
    const signature = crypto.sign(
      null,
      Buffer.from(stableStringify(payload), 'utf8'),
      privateKey
    ).toString('base64');
    await writeJsonAtomic(path.resolve(args.output), { payload, signature });
    console.log(`완료: ${outputFiles.length}개 배포 파일, ${excluded.length}개 제외`);
    console.log(`출력: ${path.resolve(args.output)}`);
  } finally {
    if (pack.temporary) await fs.rm(pack.file, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
