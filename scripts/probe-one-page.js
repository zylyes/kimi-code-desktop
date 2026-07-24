// 临时探针：单独加载指定页面，报告加载失败/渲染进程崩溃细节
const { app, BrowserWindow } = require('electron');
const path = require('path');

const target = process.argv[2] || 'sessions.html';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('RENDERER_GONE', JSON.stringify(d)));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('FAIL_LOAD', code, desc, url));
  win.webContents.on('did-finish-load', () => console.log('LOAD_OK'));
  win.webContents.on('console-message', (_e, _l, msg) => console.log('CONSOLE', msg.slice(0, 200)));
  try {
    await win.loadFile(path.join(__dirname, '..', target));
    await new Promise((r) => setTimeout(r, 1200));
  } catch (err) {
    console.log('THROW', err.message);
  }
  app.quit();
});
