'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const previewArgs = process.argv.slice(-3);
const width = Number(previewArgs[0]) || 1280;
const height = Number(previewArgs[1]) || 720;
const output = path.resolve(previewArgs[2] || `Fire-Crew-Launcher-${width}x${height}.png`);

app.commandLine.appendSwitch('ozone-platform', 'headless');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: true,
    width,
    height,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true
    }
  });
  window.setBounds({ x: 0, y: 0, width, height });
  await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await window.webContents.executeJavaScript('document.fonts.ready');
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (process.env.PREVIEW_OPEN_SETTINGS === '1') {
    await window.webContents.executeJavaScript("document.querySelector('#settingsButton').click()");
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  const metrics = await window.webContents.executeJavaScript(`({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    newsCount: document.querySelectorAll('.news-item').length,
    account: document.querySelector('#accountName')?.textContent
  })`);
  const image = await window.webContents.capturePage();
  await fs.writeFile(output, image.toPNG());
  console.log(JSON.stringify({ output, ...metrics }));
  window.destroy();
  app.quit();
});
