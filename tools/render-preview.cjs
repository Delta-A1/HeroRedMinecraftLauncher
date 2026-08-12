'use strict';

const https = require('node:https');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { normalizeSoopPosts } = require('../src/core');

const BOARD_API = 'https://chapi.sooplive.co.kr/api/ttobeherored/board/?per_page=6&start_date=&end_date=&field=title,contents,user_nick,user_id,hashtags&keyword=&type=all&order_by=reg_date&board_number=&page=1';
const VERIFIED_POSTS = [
  {
    id: '202228107',
    title: '[공지]마인크래프트 좀비서버 주소 변경 안내',
    board: '⭐비밀 기지 (자유게시판)',
    category: 'secret',
    author: 'DeltaA1',
    publishedAt: '2026-07-23 03:52:28',
    url: 'https://www.sooplive.com/station/ttobeherored/post/202228107'
  },
  {
    id: '202188535',
    title: '[중요] 오늘자 마인크래프트 모드서버 참여 방법',
    board: '⭐비밀 기지 (자유게시판)',
    category: 'secret',
    author: 'DeltaA1',
    publishedAt: '2026-07-22 21:00:29',
    url: 'https://www.sooplive.com/station/ttobeherored/post/202188535'
  },
  {
    id: '202157737',
    title: '오늘 저녁 마크 시참 한번 받아볼까 생각중!',
    board: '🔴 공지',
    category: 'notice',
    author: '히어로레드',
    publishedAt: '2026-07-22 13:43:01',
    url: 'https://www.sooplive.com/station/ttobeherored/post/202157737'
  }
];

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Fire-Crew-Launcher-Design-Preview/1.0'
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('SOOP timeout')));
    request.on('error', reject);
  });
}

async function makeFeed() {
  if (process.env.PREVIEW_USE_VERIFIED_FEED === '1') {
    return {
      posts: VERIFIED_POSTS,
      fetchedAt: new Date().toISOString(),
      source: 'live'
    };
  }
  try {
    let payload;
    try {
      payload = await requestJson(`${BOARD_API}&_=${Date.now()}`);
    } catch {
      payload = JSON.parse(execFileSync('curl', [
        '--fail',
        '--location',
        '--silent',
        '--show-error',
        '--max-time',
        '20',
        '-A',
        'Fire-Crew-Launcher-Design-Preview/1.0',
        `${BOARD_API}&_=${Date.now()}`
      ], { encoding: 'utf8' }));
    }
    return {
      posts: normalizeSoopPosts(payload, 'ttobeherored', 3),
      fetchedAt: new Date().toISOString(),
      source: 'live'
    };
  } catch {
    return {
      posts: VERIFIED_POSTS,
      fetchedAt: null,
      source: 'cache'
    };
  }
}

async function render(width, height, output) {
  const feed = await makeFeed();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    env: {
      ...process.env,
      HOME: '/tmp/fire-crew-home',
      XDG_CACHE_HOME: '/tmp/fire-crew-home/.cache'
    },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--single-process',
      '--font-render-hinting=none'
    ]
  });
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1
  });

  await page.addInitScript(({ liveFeed }) => {
    const state = {
      product: {
        version: '1.0.3',
        server: { name: '불꽃단 서버', address: '185.207.166.118:19003' },
        minecraft: { version: '26.2', forgeVersion: '65.0.9' },
        pack: { name: 'Fire Crew 26.2 City Building' }
      },
      profiles: [
        {
          id: 'main', name: '불꽃단 메인 서버', description: '도시 건축 모드',
          server: { name: '불꽃단 서버', address: '185.207.166.118:19003' },
          minecraft: { version: '26.2', forgeVersion: '65.0.9' },
          pack: { name: 'Fire Crew 26.2 City Building' }
        },
        {
          id: 'heroreds-freedom', name: "HeroRed's Freedom", description: 'Minecraft 1.12.2 바닐라 서버',
          server: { name: "HeroRed's Freedom", address: 'heroredsfreedom.run.place' },
          minecraft: { version: '1.12.2', loader: 'vanilla', loaderVersion: '', forgeVersion: '' },
          pack: { name: 'Vanilla' }
        }
      ],
      activeProfileId: 'main',
      qaMode: false,
      installed: true,
      updateAvailable: false,
      importedClientReady: false,
      legacyImportAvailable: false,
      jarCount: 317,
      memoryMb: 8192,
      gameRunning: false,
      auth: {
        configured: true,
        signedIn: true,
        microsoftSignedIn: true,
        minecraftReady: true,
        microsoftName: 'hero.red@example.com',
        minecraftName: 'HeroRed',
        minecraftId: '00000000000000000000000000000000',
        secureStorage: true
      },
      base: {
        ready: true,
        javaReady: true,
        vanillaReady: true,
        forgeReady: true
      },
      patch: {
        configured: true,
        ready: true,
        changedFiles: 0,
        version: '5.10.14.1',
        message: '최신 상태입니다.'
      },
      configurationIssues: []
    };
    window.fireCrew = {
      getState: async () => state,
      getSoopPosts: async () => liveFeed,
      getServerStatus: async () => ({ online: true, playersOnline: 7, playersMax: 20, sample: [] }),
      selectProfile: async (profileId) => {
        state.activeProfileId = profileId;
        const profile = state.profiles.find((item) => item.id === profileId);
        state.product = { ...state.product, server: profile.server, minecraft: profile.minecraft, pack: profile.pack };
        return state;
      },
      login: async () => state,
      logout: async () => ({ ...state, auth: { ...state.auth, signedIn: false } }),
      checkUpdates: async () => state,
      install: async () => state,
      launch: async () => ({ started: true }),
      repair: async () => state,
      setMemory: async (memoryMb) => ({ ...state, memoryMb }),
      openFolder: async () => {},
      openReport: async () => {},
      openExternal: async () => ({ opened: true }),
      onLog: () => {},
      onProgress: () => {},
      onAuthCode: () => {},
      onAuthStage: () => {},
      onStateChanged: () => {},
      onGameExit: () => {}
    };
  }, { liveFeed: feed });

  const pageUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href;
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await page.waitForTimeout(300);
  if (process.env.PREVIEW_NEXT_PROFILE === '1') {
    await page.click('#profileNextButton');
    await page.waitForTimeout(320);
  }
  if (process.env.PREVIEW_OPEN_SETTINGS === '1') {
    await page.click('#settingsButton');
    await page.waitForTimeout(180);
  }

  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    newsCount: document.querySelectorAll('.news-item').length,
    activeProfile: document.querySelector('#profileName')?.textContent.trim(),
    headline: document.querySelector('#mainTitle')?.textContent.replace(/\s+/g, ' ').trim()
  }));

  await page.screenshot({ path: output });
  await browser.close();
  return metrics;
}

async function main() {
  const [widthArg = '1280', heightArg = '720', outputArg] = process.argv.slice(2);
  const width = Number(widthArg);
  const height = Number(heightArg);
  const output = outputArg || path.join(process.cwd(), `Fire-Crew-Launcher-${width}x${height}.png`);
  const metrics = await render(width, height, output);
  process.stdout.write(`${JSON.stringify({ output, ...metrics })}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
