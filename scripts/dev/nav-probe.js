// scripts/dev/nav-probe.js —— 一次性 Electron 探测脚本（研究工具，不进打包）
// 回答两个问题：
//   ① kimi web 的会话 URL 形态（会话标识在 pathname / search / hash 哪一段）
//   ② SPA 会话切换能否被主进程 did-navigate-in-page 捕获
// 用法：npx electron scripts/dev/nav-probe.js <port>   （项目 devDependencies 已有 electron）
// 说明：只建会话、不发 prompt，不消耗额度；测试会话标题 kcd-nav-probe 保留在磁盘可手动归档。
// 安全：所有 URL 输出均脱敏（hash 段整体替换为 #token=***，字符串中的 token 值一律抹掉），绝不打印 token。
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 参数与基础 ----------
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('用法: npx electron scripts/dev/nav-probe.js <port>');
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
const token = fs.readFileSync(path.join(os.homedir(), '.kimi-code', 'server.token'), 'utf8').trim();
const HOME_URL = `${base}/#token=${encodeURIComponent(token)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => console.log(`[nav] ${msg}`);

// ---------- 脱敏 ----------
// URL 的 hash 段整体替换为 #token=***（token 只可能出现在 hash 段）
const sanitizeUrl = (u) => {
  const i = u.indexOf('#');
  return i >= 0 ? `${u.slice(0, i)}#token=***` : u;
};
// 字符串中的 token=xxx 值抹掉（防 href / 页面文本等场景泄露）
const maskToken = (s) => String(s).replace(/token=([^&"'\s]*)/gi, 'token=***');

// ---------- REST（容错写法同 scripts/ws-event-probe.js） ----------
function rest(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: data.slice(0, 300) });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const unwrap = (r) => (r.json && typeof r.json === 'object' && 'data' in r.json ? r.json.data : r.json);

// ---------- 收集区（供超时兜底打印） ----------
const navEvents = []; // { t, name: 'did-navigate'|'did-navigate-in-page', url: 已脱敏 }
const result = { initialShape: null, sessionShape: null, inPage: '未触发' };

// ---------- 页面 dump ----------
// dump location 三元组 + title + 会话链接 + 是否出现探测标题文本。
// hash 脱敏在 JS 侧完成：不返回 hash 全串，只返回 hasToken 与除 token 外的片段；
// 所有 JS 异常 catch 后返回 { error }；结果由调用方 JSON 序列化后打印。
async function dumpPage(win, label) {
  const js = `(() => {
    try {
      const mask = (s) => String(s).replace(/token=([^&"'\\s]*)/gi, 'token=***');
      const h = location.hash;
      const hashRest = h.replace(/token=[^&]*/i, '');
      const bodyText = (document.body && document.body.innerText) || '';
      return {
        pathname: location.pathname,
        search: location.search,
        hash: { hasToken: /token=/i.test(h), rest: mask(hashRest) },
        title: document.title,
        hasProbeTitle: bodyText.includes('kcd-nav-probe'),
        links: [...document.querySelectorAll('a[href]')]
          .map((a) => a.getAttribute('href'))
          .filter((x) => x && /session|chat/i.test(x))
          .slice(0, 30)
          .map(mask),
      };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  })()`;
  const data = await win.webContents.executeJavaScript(js);
  say(`[dump ${label}] ${JSON.stringify(data)}`);
  return data;
}

// 点击第一个会话链接（href 含 session/chat 的 <a>）；返回 { clicked, count, href }，异常 { error }
async function clickFirstSessionLink(win) {
  const js = `(() => {
    try {
      const mask = (s) => String(s).replace(/token=([^&"'\\s]*)/gi, 'token=***');
      const anchors = [...document.querySelectorAll('a[href]')];
      const hits = anchors.filter((a) => /session|chat/i.test(a.getAttribute('href') || ''));
      const target = hits[0];
      if (!target) return { clicked: false, count: hits.length };
      target.click();
      return { clicked: true, href: mask(target.getAttribute('href')), count: hits.length };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  })()`;
  return win.webContents.executeJavaScript(js);
}

// ---------- REST 建会话 + 候选会话 URL 形态逐个探测 ----------
// 候选形态 /chat/<id>、/session/<id>、/sessions/<id> 均保留 #token= hash；
// 以「页面出现会话标题文本 kcd-nav-probe」判定哪种形态有效。
async function probeByRest(win) {
  const created = await rest('POST', '/api/v1/sessions', {
    title: 'kcd-nav-probe',
    metadata: { cwd: os.tmpdir() },
    agent_config: { model: 'kimi-code/kimi-for-coding', permission_mode: 'manual', plan_mode: false },
  });
  if (created.status >= 300) throw new Error(`建会话失败 HTTP ${created.status}: ${created.raw}`);
  const d = unwrap(created);
  const sessionId = d && (d.session_id || d.sessionId || d.id);
  if (!sessionId) throw new Error(`建会话响应无会话 ID: ${created.raw}`);
  say(`REST 会话已创建: ${sessionId}（不发 prompt，不消耗额度）`);

  const candidates = [`/chat/${sessionId}`, `/session/${sessionId}`, `/sessions/${sessionId}`];
  for (const cand of candidates) {
    const url = `${base}${cand}#token=${encodeURIComponent(token)}`;
    try {
      await win.loadURL(url);
      await sleep(3000);
    } catch (err) {
      say(`[cand ${cand}] 加载失败: ${err.message}`);
      continue;
    }
    const page = await dumpPage(win, `候选${cand}`);
    const shape = `${page.pathname || ''}${page.search || ''} hash=${JSON.stringify(page.hash || {})}`;
    if (page.hasProbeTitle) {
      say(`[cand ${cand}] 页面出现会话标题文本 kcd-nav-probe -> 形态有效`);
      result.sessionShape = `${cand}（有效，页面含会话标题；加载后实际形态 ${shape}）`;
      return;
    }
    say(`[cand ${cand}] 页面未出现会话标题文本（实际形态 ${shape}）`);
  }
  result.sessionShape = '候选形态均无效（页面均未出现会话标题文本）';
}

// ---------- 收尾 ----------
function printCollected() {
  say(`已收集导航事件(${navEvents.length}): ${navEvents.map((n) => `${n.name} ${n.url}`).join(' | ') || '(无)'}`);
  if (result.initialShape) say(`初始URL形态: ${result.initialShape}`);
  if (result.sessionShape) say(`会话URL形态: ${result.sessionShape}`);
  if (result.inPage !== '未触发') say(`did-navigate-in-page捕获SPA切换: ${result.inPage}`);
}

function finish(code) {
  clearTimeout(hardTimer);
  app.once('quit', () => process.exit(code));
  app.quit();
}

// 90s 总超时兜底：打印已收集数据后 quit，exit 0
const hardTimer = setTimeout(() => {
  say(`[timeout] 90s 总超时，打印已收集数据后退出`);
  printCollected();
  finish(0);
}, 90000);

// ---------- 主流程 ----------
async function main() {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // 防 target=_blank 弹新窗干扰探测

  win.webContents.on('did-navigate', (e, url) => {
    const clean = sanitizeUrl(url);
    say(`did-navigate ${clean}`);
    navEvents.push({ t: Date.now(), name: 'did-navigate', url: clean });
  });
  win.webContents.on('did-navigate-in-page', (e, url, isMainFrame) => {
    if (!isMainFrame) return; // 只处理主框架
    const clean = sanitizeUrl(url);
    say(`did-navigate-in-page ${clean}`);
    navEvents.push({ t: Date.now(), name: 'did-navigate-in-page', url: clean });
  });

  // ① 加载首页，SPA 初始化后 dump 初始形态
  await win.loadURL(HOME_URL);
  say(`首页已加载: ${sanitizeUrl(HOME_URL)}`);
  await sleep(5000);
  const home = await dumpPage(win, '首页');
  if (home.error) throw new Error(`首页 dump 失败: ${home.error}`);
  result.initialShape = `${home.pathname || ''}${home.search || ''} hash=${JSON.stringify(home.hash || {})}`;

  // ② 有会话链接则点击第一个，观察是否触发 did-navigate-in-page
  if (Array.isArray(home.links) && home.links.length > 0) {
    say(`枚举到 ${home.links.length} 个会话链接，点击第一个…`);
    const before = navEvents.length;
    const clicked = await clickFirstSessionLink(win);
    say(`点击结果: ${JSON.stringify(clicked)}`);
    if (clicked.error) say(`WARN: 点击脚本异常: ${clicked.error}`);
    await sleep(4000);
    const after = navEvents.slice(before);
    say(`点击后 4s 内新增导航事件(${after.length}): ${after.map((n) => `${n.name} ${n.url}`).join(' | ') || '(无)'}`);
    const page = await dumpPage(win, '点击后');
    if (page.error) throw new Error(`点击后 dump 失败: ${page.error}`);
    const shape = `${page.pathname || ''}${page.search || ''} hash=${JSON.stringify(page.hash || {})}`;
    if (after.some((n) => n.name === 'did-navigate-in-page')) {
      result.inPage = '是';
      result.sessionShape = shape;
    } else if (after.some((n) => n.name === 'did-navigate')) {
      result.inPage = '否（触发整页 did-navigate，非 SPA 内切换）';
      result.sessionShape = shape;
    } else {
      say('点击未触发任何导航，走 REST 建会话探测候选形态…');
      await probeByRest(win);
    }
  } else {
    say('未枚举到会话链接，走 REST 建会话探测候选形态…');
    await probeByRest(win);
  }

  // ③ 结论三行
  say('=== 探测结论 ===');
  say(`初始URL形态: ${result.initialShape}`);
  say(`会话URL形态: ${result.sessionShape || '未确定'}`);
  say(`did-navigate-in-page捕获SPA切换: ${result.inPage}`);
  finish(0);
}

app.whenReady().then(() => {
  main().catch((err) => {
    say(`FATAL: ${err.message}`);
    finish(1);
  });
});
