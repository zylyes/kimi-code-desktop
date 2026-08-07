// 临时验证脚本：以独立 userData 启动并存实例（不影响正在运行的正式实例），
// 周期性截取所有窗口到 %TEMP%/kcd-live/，并在 Web UI 就绪后实测「新建对话」按钮点击。
// 用法：npx electron scripts/archive/dev-verify.js
// 环境变量 KCD_VERIFY_TICKS 可延长运行拍数（默认 8 拍，每拍 5s；长跑用于配合 ws-event-probe 截获弹窗）
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const MAX_TICKS = Math.max(8, Number(process.env.KCD_VERIFY_TICKS) || 8);

app.setPath('userData', path.join(os.tmpdir(), 'kcd-dev-userdata'));
app.setName('kcd-dev-verify');
require('../../src/main/main.js');

const outDir = path.join(os.tmpdir(), 'kcd-live');
fs.mkdirSync(outDir, { recursive: true });

// 断言③④各只报告一次：③ WebView 加载（首个 http(s) 窗口）；④ WS 通知通道（app.log 中的订阅成功日志）
const appLogFile = path.join(os.tmpdir(), 'kcd-dev-userdata', 'app.log');
let webviewDone = false;
let webviewTick = 0;
let wsDone = false;

function checkWsLog() {
  wsDone = true;
  let hit = '';
  try {
    // main.js 订阅成功日志：'WebSocket 已连接'（open 时）/'WebSocket 订阅已启动'（建连前），宽松匹配
    hit = fs.readFileSync(appLogFile, 'utf8').split(/\r?\n/)
      .find((l) => l.includes('WebSocket') && (l.includes('已连接') || l.includes('订阅已启动'))) || '';
  } catch { /* ignore */ }
  console.log(hit ? `[verify] WS 通知通道: ok | ${hit.trim()}` : '[verify] WS 通知通道: fail');
}

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
    // ③ WebView 加载：首次出现 http(s) 窗口即报告（url 截掉 #fragment 防泄密），第 8 拍仍未出现报 fail
    if (!webviewDone) {
      const w = BrowserWindow.getAllWindows().find((win) => /^https?:/.test(win.webContents.getURL()));
      if (w) {
        webviewDone = true;
        webviewTick = n;
        console.log(`[verify] WebView 加载: ok | url=${w.webContents.getURL().split('#')[0]}`);
      } else if (n >= 8) {
        webviewDone = true;
        console.log('[verify] WebView 加载: fail');
      }
    }
    // ④ WS 通知通道：WebView 就绪后约 2 拍检查 app.log；第 8 拍兜底保证报告一次
    if (!wsDone && webviewTick > 0 && n >= webviewTick + 2) checkWsLog();
    if (!wsDone && n >= 8) checkWsLog();
    if (n >= MAX_TICKS) { clearInterval(timer); app.quit(); }
  }, 5000);
});
