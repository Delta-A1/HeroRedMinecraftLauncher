'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isExpectedDeceasedCraftInstance,
  normalizeSoopPosts,
  resolveSoopBoardIds,
  patchInstanceCfg,
  patchOptionsText,
  quarantineRuleFor,
  removeResourcePacksFromOptions
} = require('../src/core');

test('한글 언어와 JET 리소스팩을 추가하면서 기존 팩을 보존한다', () => {
  const input = 'lang:en_us\nresourcePacks:["vanilla","mod_resources","file/Existing.zip"]\n';
  const output = patchOptionsText(input, 'JET-Korean-1.0.8.zip');
  assert.match(output, /^lang:ko_kr$/m);
  assert.match(output, /"file\/Existing.zip"/);
  assert.match(output, /"file\/JET-Korean-1.0.8.zip"/);
});

test('반복 적용해도 JET 리소스팩이 중복되지 않는다', () => {
  const once = patchOptionsText('', 'JET-Korean-1.0.8.zip');
  const twice = patchOptionsText(once, 'JET-Korean-1.0.8.zip');
  assert.equal((twice.match(/JET-Korean-1\.0\.8\.zip/g) || []).length, 1);
});

test('자동 다운로드가 차단된 선택형 리소스팩만 목록에서 제거한다', () => {
  const input = 'resourcePacks:["vanilla","file/Itsme64\\u0027s no potion particles [1.5.1].zip","file/Deceasedcraft Screen Tweak 1.20.1.zip","file/Keep.zip"]\n';
  const output = removeResourcePacksFromOptions(input, [
    "Itsme64's no potion particles [1.5.1].zip",
    'Deceasedcraft Screen Tweak 1.20.1.zip'
  ]);
  assert.doesNotMatch(output, /no potion particles/i);
  assert.doesNotMatch(output, /Screen Tweak/i);
  assert.match(output, /file\/Keep\.zip/);
});

test('메모리 설정과 표시 이름을 갱신한다', () => {
  const output = patchInstanceCfg('MaxMemAlloc=4096\nname=Old\n', 8192, '불꽃단 | DeceasedCraft 5.10.14');
  assert.match(output, /^OverrideMemory=true$/m);
  assert.match(output, /^MinMemAlloc=4096$/m);
  assert.match(output, /^MaxMemAlloc=8192$/m);
  assert.match(output, /^name=불꽃단 \| DeceasedCraft 5\.10\.14$/m);
});

test('고정 서버와 중복되는 클라이언트 모드만 격리한다', () => {
  assert.equal(quarantineRuleFor('e4mc_minecraft-forge-5.4.1.jar').id, 'e4mc');
  assert.equal(quarantineRuleFor('ytongame_hostingmenu-1.0.1.jar').id, 'ytongame-hosting-menu');
  assert.equal(quarantineRuleFor('Connector-1.0.0-beta.47+1.20.1.jar'), null);
  assert.equal(quarantineRuleFor('fabric-api-0.92.6+1.11.14+1.20.1.jar'), null);
});

test('가져온 DeceasedCraft 인스턴스를 식별한다', () => {
  assert.equal(isExpectedDeceasedCraftInstance('DeceasedCraft_Beta 5.10.14'), true);
  assert.equal(isExpectedDeceasedCraftInstance('불꽃단 | DeceasedCraft 5.10.14'), true);
  assert.equal(isExpectedDeceasedCraftInstance('Vanilla 1.20.1'), false);
});

test('SOOP 방송국 응답을 안전한 최신 글 데이터로 정리한다', () => {
  const payload = {
    data: [
      {
        title_no: 202228107,
        title_name: '  서버   주소 변경 안내 ',
        user_nick: '히어로레드',
        reg_date: '2026-07-23 03:52:28',
        display: { bbs_name: '🔴 공지' },
        content: { summary: '<script>가 아닌 평문 요약' }
      }
    ]
  };
  const [post] = normalizeSoopPosts(payload, 'ttobeherored', 3);
  assert.deepEqual(post, {
    id: '202228107',
    title: '서버 주소 변경 안내',
    board: '🔴 공지',
    category: 'notice',
    author: '히어로레드',
    publishedAt: '2026-07-23 03:52:28',
    summary: '<script>가 아닌 평문 요약',
    url: 'https://www.sooplive.com/station/ttobeherored/post/202228107'
  });
  assert.deepEqual(normalizeSoopPosts(payload, '../wrong', 3), []);
});

test('SOOP 새 채널 API 응답과 게시판 메뉴를 정리한다', () => {
  const boardIds = resolveSoopBoardIds({
    board: [
      { bbsNo: 117219807, name: '🔴공지' },
      { bbsNo: 98652685, name: '⭐비밀 기지 (자유게시판)' }
    ]
  });
  assert.deepEqual(boardIds, { notice: 117219807, secret: 98652685 });

  const [post] = normalizeSoopPosts({
    contents: [{
      titleNo: 200539255,
      titleName: '  오늘 할 컨텐츠  ',
      userNick: '히어로레드',
      regDate: '2026-07-04 22:00:43',
      display: { bbsName: '🔴공지' },
      content: { summary: '새 API 응답' }
    }]
  }, 'ttobeherored', 3);
  assert.equal(post.id, '200539255');
  assert.equal(post.title, '오늘 할 컨텐츠');
  assert.equal(post.category, 'notice');
  assert.equal(post.author, '히어로레드');
  assert.equal(post.publishedAt, '2026-07-04 22:00:43');
});

test('SOOP 게시판 메뉴가 없으면 설정된 안전한 식별자를 사용한다', () => {
  assert.deepEqual(resolveSoopBoardIds({}, { notice: 11, secret: 22 }), {
    notice: 11,
    secret: 22
  });
});
