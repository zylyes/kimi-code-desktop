// 临时验证脚本：以独立 userData 启动并存实例（不影响正在运行的正式实例），
// 周期性截取所有窗口到 %TEMP%/kcd-live/，并在 Web UI 就绪后实测「新建对话」按钮点击。
// 用法：npx electron scripts/dev-verify.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', path.join(os.tmpdir(), 'kcd-dev-userdata'));
app.setName('kcd-dev-verify');
require('../main.js');

const outDir = path.join(os.tmpdir(), 'kcd-live');
fs.mkdirSync(outDir, { recursive: true });

app.whenReady().then(() => {
  let n = 0;
  const timer = setInterval(async () => {
    n++;
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        const img = await win.webContents.capturePage();
        const url = win.webContents.getURL();
        const tag = /^https?:/.test(url) ? 'webui' : `local-${win.id}`;
        fs.writeFileSync(path.join(outDir, `${String(n).padStart(2, '0')}-${tag}.png`), img.toPNG());
      } catch { /* ignore */ }
    }
    if (n === 6) {
      // Web UI 应已就绪：实测官方「新建对话」按钮存在并可点击（与 newConversationInPlace 同一机制）
      const win = BrowserWindow.getAllWindows().find((w) => /^https?:/.test(w.webContents.getURL()));
      if (win) {
        try {
          const r = await win.webContents.executeJavaScript(
            "(() => { const b = document.querySelector('.btn-new-chat'); if (b) { b.click(); return 'clicked'; } return 'not-found'; })()"
          );
          await new Promise((res) => setTimeout(res, 1500));
          const state = await win.webContents.executeJavaScript(
            "(() => { const t = document.querySelector('header.chat-header');"
            + " const items = document.querySelectorAll('.btn-new-chat').length;"
            + " return 'url=' + location.href + ' | btnCount=' + items + ' | header=' + (t ? t.textContent.trim().slice(0, 60) : 'none'); })()"
          );
          console.log(`[verify] 新建对话按钮: ${r} | 点击后状态: ${state}`);
        } catch (err) {
          console.log(`[verify] 新建对话按钮测试失败: ${err.message}`);
        }
      } else {
        console.log('[verify] 第 6 拍仍未见 Web UI 窗口');
      }
    }
    if (n >= 8) { clearInterval(timer); app.quit(); }
  }, 5000);
});
