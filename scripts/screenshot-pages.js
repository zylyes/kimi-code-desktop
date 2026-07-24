// 临时验证脚本：用 Electron 离屏渲染各本地页面并截图（亮/暗双主题），供 UI 翻新回归检查
// 用法：npx electron scripts/screenshot-pages.js   输出到 %TEMP%/kcd-shots/
const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const pages = [
  ['chat', 'chat.html', 960, 720],
  ['sessions', 'sessions.html', 1100, 760],
  ['setup', 'setup.html', 1100, 760],
  ['agents', 'agents.html', 1100, 760],
  ['help', 'help.html', 960, 720],
  ['prompts', 'prompts.html', 960, 720],
  ['lan', 'lan.html', 960, 720],
  ['loading', 'loading.html', 960, 720],
  ['permission', 'permission.html', 520, 480],
  ['question', 'question.html', 560, 720],
];

const outDir = path.join(os.tmpdir(), 'kcd-shots');
fs.mkdirSync(outDir, { recursive: true });

// 离屏连拍时禁用硬件加速，避免窗口快速建毁导致 GPU/渲染进程崩溃（ERR_FAILED）
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    for (const [name, file, w, h] of pages) {
      const win = new BrowserWindow({
        width: w,
        height: h,
        show: false,
        backgroundColor: theme === 'dark' ? '#181817' : '#fbfaf9',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      try {
        await win.loadFile(path.join(__dirname, '..', file));
        await new Promise((r) => setTimeout(r, 700));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `${name}-${theme}.png`), img.toPNG());
        console.log(`shot ${name}-${theme}`);
      } catch (err) {
        console.log(`fail ${name}-${theme}: ${err.message}`);
      }
      win.destroy();
      await new Promise((r) => setTimeout(r, 250)); // 窗口建毁间隔，防渲染进程连锁崩溃
    }
  }
  app.quit();
});
