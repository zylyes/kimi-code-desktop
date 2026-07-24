// 单页单主题截图（每进程只拍一张，规避同进程连续建窗崩溃）
// 用法：npx electron scripts/screenshot-one.js <file> <light|dark> <outPng> [width] [height]
const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const [, , file, theme, outPng, wArg, hArg] = process.argv;
const width = Number(wArg) || 1100;
const height = Number(hArg) || 760;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: theme === 'dark' ? '#181817' : '#fbfaf9',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  try {
    await win.loadFile(path.join(__dirname, '..', file));
    await new Promise((r) => setTimeout(r, 700));
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    fs.writeFileSync(outPng, img.toPNG());
    console.log(`OK ${path.basename(outPng)}`);
  } catch (err) {
    console.log(`FAIL ${file}: ${err.message}`);
    app.exit(1);
  }
  app.quit();
});
