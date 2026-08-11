'use strict';

const QUARANTINE_RULES = [
  {
    id: 'e4mc',
    pattern: /^e4mc_minecraft-forge-.*\.jar$/i,
    reason: '고정 외부 호스팅 서버에서는 LAN 터널 기능이 불필요하며, 의도하지 않은 별도 터널 생성을 막기 위해 비활성화합니다.'
  },
  {
    id: 'ytongame-hosting-menu',
    pattern: /^ytongame_hostingmenu-.*\.jar$/i,
    reason: '타 호스팅 업체 메뉴를 주입하는 클라이언트 전용 모드로, 불꽃단 고정 서버 접속 흐름과 중복되어 비활성화합니다.'
  }
];

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function setOption(text, key, value) {
  const lines = normalizeNewlines(text).split('\n');
  const prefix = `${key}:`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  const replacement = `${prefix}${value}`;
  if (index === -1) lines.push(replacement);
  else lines[index] = replacement;
  return lines.join('\n').replace(/^\n+/, '');
}

function setCfgOption(text, key, value) {
  const lines = normalizeNewlines(text).split('\n');
  const prefix = `${key}=`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  const replacement = `${prefix}${value}`;
  if (index === -1) lines.push(replacement);
  else lines[index] = replacement;
  return lines.join('\n').replace(/^\n+/, '');
}

function mergeResourcePacks(rawValue, packEntry) {
  let packs = [];
  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) packs = parsed.filter((value) => typeof value === 'string');
  } catch {
    packs = [];
  }

  if (!packs.includes('vanilla')) packs.unshift('vanilla');
  if (!packs.includes(packEntry)) packs.push(packEntry);
  return JSON.stringify(packs);
}

function patchOptionsText(text, resourcePackFileName) {
  const normalized = normalizeNewlines(text);
  const resourceLine = normalized.split('\n').find((line) => line.startsWith('resourcePacks:'));
  const currentValue = resourceLine ? resourceLine.slice('resourcePacks:'.length) : '[]';
  const packEntry = `file/${resourcePackFileName}`;
  let next = setOption(normalized, 'lang', 'ko_kr');
  next = setOption(next, 'resourcePacks', mergeResourcePacks(currentValue, packEntry));
  return next.endsWith('\n') ? next : `${next}\n`;
}

function removeResourcePacksFromOptions(text, fileNames) {
  const normalized = normalizeNewlines(text);
  const resourceLine = normalized.split('\n').find((line) => line.startsWith('resourcePacks:'));
  if (!resourceLine) return normalized;
  const blocked = new Set(fileNames.map((name) => `file/${name}`.toLowerCase()));
  let packs;
  try {
    packs = JSON.parse(resourceLine.slice('resourcePacks:'.length));
  } catch {
    return normalized;
  }
  if (!Array.isArray(packs)) return normalized;
  const filtered = packs.filter((entry) => typeof entry !== 'string' || !blocked.has(entry.toLowerCase()));
  return setOption(normalized, 'resourcePacks', JSON.stringify(filtered));
}

function patchInstanceCfg(text, memoryMb, displayName) {
  let next = normalizeNewlines(text);
  next = setCfgOption(next, 'OverrideMemory', 'true');
  next = setCfgOption(next, 'MinMemAlloc', String(Math.min(4096, memoryMb)));
  next = setCfgOption(next, 'MaxMemAlloc', String(memoryMb));
  if (displayName) next = setCfgOption(next, 'name', displayName);
  return next.endsWith('\n') ? next : `${next}\n`;
}

function quarantineRuleFor(fileName) {
  return QUARANTINE_RULES.find((rule) => rule.pattern.test(fileName)) || null;
}

function parseInstanceName(text) {
  const line = normalizeNewlines(text).split('\n').find((item) => item.startsWith('name='));
  return line ? line.slice('name='.length).trim() : '';
}

function isExpectedDeceasedCraftInstance(name, folderName = '') {
  const combined = `${name} ${folderName}`.toLowerCase();
  return combined.includes('deceasedcraft') || combined.includes('불꽃단');
}

function normalizeSoopPosts(payload, streamerId, limit = 3) {
  const safeStreamerId = /^[a-z0-9_]+$/i.test(String(streamerId || ''))
    ? String(streamerId)
    : '';
  const posts = Array.isArray(payload?.contents)
    ? payload.contents
    : payload?.data;
  if (!safeStreamerId || !Array.isArray(posts)) return [];

  return posts
    .filter((post) => {
      const id = post?.titleNo ?? post?.title_no;
      const title = post?.titleName ?? post?.title_name;
      return Number.isInteger(Number(id)) && String(title || '').trim();
    })
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((post) => {
      const id = String(Number(post.titleNo ?? post.title_no));
      const board = String(post.display?.bbsName ?? post.display?.bbs_name ?? '방송국 게시판')
        .replace(/\s+/g, ' ')
        .trim();
      const category = /공지/.test(board)
        ? 'notice'
        : (/비밀기지|자유게시판/.test(board) ? 'secret' : 'other');
      return {
        id,
        title: String(post.titleName ?? post.title_name).replace(/\s+/g, ' ').trim(),
        board,
        category,
        author: String(post.userNick ?? post.user_nick ?? post.userId ?? post.user_id ?? '')
          .replace(/\s+/g, ' ')
          .trim(),
        publishedAt: String(post.regDate ?? post.reg_date ?? '').trim(),
        summary: String(post.content?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 180),
        url: `https://www.sooplive.com/station/${safeStreamerId}/post/${id}`
      };
    });
}

function resolveSoopBoardIds(payload, fallback = {}) {
  const boards = Array.isArray(payload?.board)
    ? payload.board
    : (Array.isArray(payload?.boardList) ? payload.boardList : []);
  const findId = (pattern, fallbackId) => {
    const board = boards.find((item) => pattern.test(String(item?.name ?? item?.boardName ?? '')));
    const value = Number(board?.bbsNo ?? board?.bbs_no ?? fallbackId);
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  return {
    notice: findId(/공지/, fallback.notice),
    secret: findId(/자유게시판/, fallback.secret)
  };
}

module.exports = {
  QUARANTINE_RULES,
  isExpectedDeceasedCraftInstance,
  mergeResourcePacks,
  normalizeSoopPosts,
  resolveSoopBoardIds,
  parseInstanceName,
  patchInstanceCfg,
  patchOptionsText,
  quarantineRuleFor,
  removeResourcePacksFromOptions,
  setCfgOption,
  setOption
};
