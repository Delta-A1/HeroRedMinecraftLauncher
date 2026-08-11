'use strict';

const { contextBridge } = require('electron');

const previewSkinSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" shape-rendering="crispEdges">
  <rect width="64" height="64" fill="none"/>
  <rect x="8" y="8" width="8" height="8" fill="#efb39d"/>
  <rect x="8" y="8" width="8" height="3" fill="#24191d"/>
  <rect x="8" y="11" width="2" height="2" fill="#35252a"/>
  <rect x="14" y="11" width="2" height="2" fill="#f33d35"/>
  <rect x="9" y="14" width="6" height="1" fill="#d77f79"/>
  <rect x="40" y="8" width="8" height="2" fill="#cf252b"/>
  <rect x="40" y="10" width="2" height="3" fill="#2a2024"/>
  <rect x="46" y="10" width="2" height="3" fill="#2a2024"/>
  <rect x="20" y="20" width="8" height="12" fill="#e8e6df"/>
  <rect x="20" y="20" width="8" height="2" fill="#9f1722"/>
  <rect x="20" y="24" width="3" height="8" fill="#b51d29"/>
  <rect x="25" y="22" width="3" height="10" fill="#34323a"/>
  <rect x="20" y="36" width="8" height="2" fill="#f13b35"/>
  <rect x="44" y="20" width="4" height="12" fill="#e5e3dc"/>
  <rect x="44" y="24" width="4" height="4" fill="#b21d28"/>
  <rect x="44" y="36" width="4" height="2" fill="#f13b35"/>
  <rect x="36" y="52" width="4" height="12" fill="#e5e3dc"/>
  <rect x="36" y="56" width="4" height="4" fill="#b21d28"/>
  <rect x="52" y="52" width="4" height="2" fill="#f13b35"/>
</svg>`;
const previewSkinDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewSkinSvg)}`;

const state = {
  qaMode: true,
  installed: true,
  updateAvailable: false,
  importedClientReady: false,
  legacyImportAvailable: false,
  jarCount: 317,
  memoryMb: 8192,
  gameRunning: false,
  auth: {
    configured: true,
    signedIn: false,
    microsoftSignedIn: false,
    minecraftReady: false,
    microsoftName: '',
    minecraftName: '',
    minecraftId: '',
    skinAvailable: false,
    skinVariant: 'CLASSIC',
    skinDataUrl: '',
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

const feed = {
  posts: [
    {
      id: '202228107',
      title: '[공지]마인크래프트 서버 주소 변경 안내',
      board: '공지',
      category: 'notice',
      author: '히어로레드',
      publishedAt: '2026-07-23 03:52:28',
      url: 'https://www.sooplive.com/station/ttobeherored/post/202228107'
    },
    {
      id: '202188535',
      title: '오늘 방송 및 참여 방법 안내',
      board: '비밀기지 (자유게시판)',
      category: 'secret',
      author: '히어로레드',
      publishedAt: '2026-07-22 21:00:29',
      url: 'https://www.sooplive.com/station/ttobeherored/post/202188535'
    },
    {
      id: '202157737',
      title: '오늘 저녁 시청자 참여 방송!',
      board: '비밀기지 (자유게시판)',
      category: 'secret',
      author: '히어로레드',
      publishedAt: '2026-07-22 13:43:01',
      url: 'https://www.sooplive.com/station/ttobeherored/post/202157737'
    }
  ],
  fetchedAt: new Date().toISOString(),
  source: 'live'
};

contextBridge.exposeInMainWorld('fireCrew', {
  getState: async () => state,
  getSoopPosts: async () => feed,
  getServerStatus: async () => ({ online: true, playersOnline: 7, playersMax: 20, sample: [] }),
  login: async () => state,
  logout: async () => state,
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
  onSkinUpdated: () => {},
  onGameExit: () => {}
});
