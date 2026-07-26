// 探针脚本：以隔离 userData 启动并存实例（不连接/不干扰托盘常驻的正式实例），
// 驱动 Web UI 依次打开 home / session / changes / preview / 设置模态，
// 每步 dump DOM 结构（JSON）并截图到 %TEMP%/kcd-probe/，供选择面板避让 CSS 选择器。
// 用法：npx electron scripts/probe-panels.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const userDataDir = path.join(os.tmpdir(), 'kcd-probe-userdata');
app.setPath('userData', userDataDir);
app.setName('kcd-probe');
// 预置最小配置以跳过首启设置向导（仅作用于隔离 userData，不影响正式实例）
try {
  const cfgFile = path.join(userDataDir, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'auto', autoStartCli: true, port: null, host: '0.0.0.0' }, null, 2));
  }
} catch { /* ignore */ }
require('../main.js');

const outDir = path.join(os.tmpdir(), 'kcd-probe');
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function findWebUiWindow() {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      const url = win.webContents.getURL();
      if (!/^https?:/.test(url)) continue;
      const host = new URL(url).hostname;
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return win;
    } catch { /* ignore */ }
  }
  return null;
}

async function shot(win, name) {
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
    console.log(`[probe] 截图 ${name}`);
  } catch (err) {
    console.log(`[probe] 截图 ${name} 失败: ${err.message}`);
  }
}

// OS 级屏幕截图：capturePage 只含渲染进程内容，不含 OS 绘制的 −▢× 悬浮窗控；
// 验证四键配色必须用屏幕截图（desktopCapturer 全屏缩略图按窗口 bounds 裁剪）
async function screenShot(win, name) {
  try {
    // 先把本实例窗口提到 z 序最前并抢焦点（屏幕上常驻着正式实例窗口/可能有全屏程序，
    // 不置前会截到别的窗口；moveTop 对全屏程序无效，show+focus 可使其退出独占前台）
    try { win.show(); win.focus(); win.moveTop(); } catch { /* ignore */ }
    await sleep(250);
    const b = win.getBounds();
    const disp = screen.getDisplayMatching(b);
    const scale = disp.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(disp.size.width * scale),
        height: Math.round(disp.size.height * scale),
      },
    });
    if (!sources.length) throw new Error('no screen source');
    const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
    const img = src.thumbnail;
    const sz = img.getSize();
    const kx = sz.width / disp.size.width;
    const ky = sz.height / disp.size.height;
    const x = Math.max(0, Math.round((b.x - disp.bounds.x) * kx));
    const y = Math.max(0, Math.round((b.y - disp.bounds.y) * ky));
    const w = Math.min(sz.width - x, Math.round(b.width * kx));
    const h = Math.min(sz.height - y, Math.round(b.height * ky));
    const cropped = img.crop({ x, y, width: Math.max(1, w), height: Math.max(1, h) });
    fs.writeFileSync(path.join(outDir, name), cropped.toPNG());
    console.log(`[probe] 屏幕截图 ${name}`);
  } catch (err) {
    console.log(`[probe] 屏幕截图 ${name} 失败: ${err.message}`);
  }
}

// ===== 逐帧测量工具（modal 开/关时窗控条变色跟随蒙版的延迟） =====
// 实测本机 desktopCapturer.getSources 每帧 ~2.3s（与缩略图尺寸无关），无法做 ~100ms 逐帧；
// 改用其屏幕源开实时捕获流（getUserMedia chromeMediaSource:'desktop'，同为 OS 级全屏画面、
// 含 OS 绘制的 −▢× 窗控），隐藏捕获窗内 video→canvas 逐点采样，executeJavaScript 往返数 ms
async function startScreenSampler(win) {
  const b = win.getBounds();
  const disp = screen.getDisplayMatching(b);
  const scale = disp.scaleFactor || 1;
  const pw = Math.round(disp.size.width * scale);
  const ph = Math.round(disp.size.height * scale);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 160, height: 90 },
  });
  if (!sources.length) throw new Error('no screen source');
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  // about:blank 非安全上下文无 navigator.mediaDevices；起 127.0.0.1（potentially trustworthy）微型空页服务
  const srv = http.createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body></body></html>');
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const capWin = new BrowserWindow({ show: false, width: 320, height: 200 });
  let dims;
  try {
    await capWin.loadURL(`http://127.0.0.1:${srv.address().port}/blank`);
    dims = await capWin.webContents.executeJavaScript(`(async function () {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(src.id)},
        minWidth: ${pw}, maxWidth: ${pw}, minHeight: ${ph}, maxHeight: ${ph} } },
    });
    const v = document.createElement('video');
    v.srcObject = stream;
    v.muted = true;
    await v.play();
    if (v.readyState < 2) await new Promise((res) => { v.onloadeddata = res; });
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    window.__cap = { v: v, c: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
    // 采样若干小区域的众数色（[[x,y,w,h],...]，流像素坐标；众数剔除文字/图标字形噪点，
    // 与 main.js runTitlebarCapture 同理——窗控条点正压在 ▢ 字形上，单像素会抽到符号色）；
    // corner 非空时另返回该矩形 PNG dataURL
    window.__capSample = function (rects, corner) {
      const cap = window.__cap;
      cap.ctx.drawImage(cap.v, 0, 0);
      const out = [];
      for (let i = 0; i < rects.length; i++) {
        const rc = rects[i];
        const x0 = Math.min(cap.c.width - 1, Math.max(0, Math.round(rc[0])));
        const y0 = Math.min(cap.c.height - 1, Math.max(0, Math.round(rc[1])));
        const w = Math.min(cap.c.width - x0, Math.max(1, Math.round(rc[2])));
        const h = Math.min(cap.c.height - y0, Math.max(1, Math.round(rc[3])));
        const data = cap.ctx.getImageData(x0, y0, w, h).data;
        const counts = new Map();
        for (let p = 0; p + 2 < data.length; p += 4) {
          const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        let best = -1;
        let bc = 0;
        for (const [k, n] of counts) { if (n > bc) { bc = n; best = k; } }
        out.push([(best >> 16) & 255, (best >> 8) & 255, best & 255]);
      }
      let cornerUrl = null;
      if (corner) {
        const cc = window.__capCorner || (window.__capCorner = document.createElement('canvas'));
        cc.width = corner.w;
        cc.height = corner.h;
        cc.getContext('2d').drawImage(cap.c, corner.x, corner.y, corner.w, corner.h, 0, 0, corner.w, corner.h);
        cornerUrl = cc.toDataURL('image/png');
      }
      return { samples: out, corner: cornerUrl };
    };
    return { w: c.width, h: c.height };
  })()`);
  } catch (err) {
    try { capWin.destroy(); } catch { /* ignore */ }
    try { srv.close(); } catch { /* ignore */ }
    throw err;
  }
  console.log(`[probe] 屏幕采样流已建立: ${dims.w}x${dims.h} (display ${disp.size.width}x${disp.size.height}@${scale})`);
  return { capWin, srv, disp, width: dims.w, height: dims.h };
}

// 屏幕 DIP 坐标 → 采样流像素坐标
function dipToPx(sampler, dipX, dipY) {
  const kx = sampler.width / sampler.disp.size.width;
  const ky = sampler.height / sampler.disp.size.height;
  return [(dipX - sampler.disp.bounds.x) * kx, (dipY - sampler.disp.bounds.y) * ky];
}

// 以 (cx,cy)（屏幕 DIP）为中心、wDip×hDip（DIP）的区域 → 采样流像素矩形 [x,y,w,h]
function dipRectToPx(sampler, cx, cy, wDip, hDip) {
  const kx = sampler.width / sampler.disp.size.width;
  const ky = sampler.height / sampler.disp.size.height;
  return [
    Math.round((cx - sampler.disp.bounds.x - wDip / 2) * kx),
    Math.round((cy - sampler.disp.bounds.y - hDip / 2) * ky),
    Math.max(1, Math.round(wDip * kx)),
    Math.max(1, Math.round(hDip * ky)),
  ];
}

// BGRA buffer 众数色（剔除文字/图标字形噪点）
function modeOfBitmap(buf) {
  const counts = new Map();
  for (let i = 0; i + 2 < buf.length; i += 4) {
    const key = (buf[i + 2] << 16) | (buf[i + 1] << 8) | buf[i];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = -1;
  let bc = 0;
  for (const [k, n] of counts) { if (n > bc) { bc = n; best = k; } }
  return best < 0 ? null : [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

// 从 t0 起每 ~100ms 采一帧至 +1200ms；rectsPx[0]=窗控条区，其余为蒙版参考候选区；
// 第 1~2 帧附带右上角裁剪 dataURL（帧图右上角 340x64 DIP 区，供检查四键白闪）。
// 遮挡守卫：屏幕上可能有全屏程序盖住本窗口（实测：全屏游戏），每帧同时用 capturePage
// 取 guardRect（页面坐标，与 rectsPx[guardIdx] 同一逻辑点）的页面真实渲染色，与屏幕采样
// 对比——偏差 >15 说明该帧屏幕取到的不是本窗口（被遮挡），打标记供分析时剔除
async function measureTransition(win, sampler, rectsPx, cornerPx, t0, tag, guardRect, guardIdx) {
  const frames = [];
  const deadline = t0 + 1200;
  let next = t0;
  let idx = 0;
  while (Date.now() < deadline) {
    idx++;
    const wantCorner = idx <= 2 && cornerPx ? cornerPx : null;
    let guardPage = null;
    try {
      const img = await win.webContents.capturePage(guardRect);
      guardPage = modeOfBitmap(img.toBitmap());
    } catch { /* ignore */ }
    try {
      const res = await sampler.capWin.webContents.executeJavaScript(
        `window.__capSample(${JSON.stringify(rectsPx)}, ${wantCorner ? JSON.stringify(wantCorner) : 'null'})`
      );
      const g = guardPage && res.samples[guardIdx] ? rgbDelta(guardPage, res.samples[guardIdx]) : null;
      frames.push({ t: Date.now() - t0, samples: res.samples, corner: res.corner, guardDelta: g });
    } catch (err) {
      console.log(`[probe] ${tag} 采样失败: ${err.message}`);
    }
    next += 100;
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
  }
  return frames;
}

const rgbStr = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const rgbDelta = (a, b) => Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2));

// 对一组帧打 窗控条点(samples[0]) 与蒙版参考点(samples[refIdx]) 的 Δ 日志；
// guardDelta>15 的帧被全屏程序遮挡（屏幕取到的不是本窗口），打 [被遮挡] 标记
function logSampledFrames(frames, refIdx, tag) {
  let occluded = 0;
  for (const f of frames) {
    const s = f.samples[0];
    const r = f.samples[refIdx];
    if (!s || !r) continue;
    const occ = f.guardDelta != null && f.guardDelta > 15;
    if (occ) occluded++;
    console.log(`[probe] ${tag} t=+${f.t}ms strip=${rgbStr(s)} ref=${rgbStr(r)} Δ=${rgbDelta(s, r)}${occ ? ' [被遮挡]' : ''}`);
  }
  if (occluded) console.log(`[probe] ${tag} 共 ${occluded}/${frames.length} 帧被遮挡，分析时应剔除`);
}

// 帧附带右上角裁剪 dataURL 存档
function saveCornerDataUrl(frames, tag) {
  let n = 0;
  for (const f of frames) {
    if (!f.corner) continue;
    n++;
    const base64 = f.corner.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(outDir, `frame-${tag}-${n}-corner.png`), Buffer.from(base64, 'base64'));
    console.log(`[probe] 右上角裁剪 frame-${tag}-${n}-corner.png`);
  }
}

// 模态对话框（非全屏蒙版）可见矩形，供选蒙版参考点时避让
const DIALOG_RECT_JS = `(function () {
  var W = window.innerWidth, H = window.innerHeight;
  var best = null;
  var els = document.querySelectorAll('[class*="dialog"], [class*="modal"], [role="dialog"]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) continue;
    if (r.width > W * 0.92 && r.height > H * 0.92) continue; // 全屏蒙版不算对话框
    var area = r.width * r.height;
    if (!best || area > best.area) {
      best = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, area: area,
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '' };
    }
  }
  return best;
})()`;

// 选蒙版参考点：默认头部中点（与 strip 同一 header 表面——蒙版收敛后两者应同色，
// Δ<10 才有意义），被模态对话框占据（24px 余量）则依候选表另选；
// fyh 为 headerH 比例（header 内），fy 为视口高度比例（兜底区）。返回 REF_CANDIDATES 下标
const REF_CANDIDATES = [
  { fx: 0.5, fyh: 0.5, label: '头部中点' },
  { fx: 0.3, fyh: 0.5, label: '头部左侧' },
  { fx: 0.72, fyh: 0.5, label: '头部右侧' },
  { fx: 0.08, fy: 0.5, label: '左侧中点' }, // 侧栏蒙版区兜底（不同表面，仅看跟随时序）
];
function refPageXY(c, geo) {
  return {
    px: Math.round(geo.W * c.fx),
    py: Math.round(c.fyh != null ? geo.headerH * c.fyh : geo.H * c.fy),
  };
}
async function pickMaskRefIndex(win, geo) {
  let dlg = null;
  try {
    dlg = await win.webContents.executeJavaScript(DIALOG_RECT_JS);
  } catch { /* ignore */ }
  if (dlg) console.log(`[probe] 模态对话框矩形: ${JSON.stringify(dlg)}`);
  const m = 24;
  for (let i = 0; i < REF_CANDIDATES.length; i++) {
    const c = REF_CANDIDATES[i];
    const { px, py } = refPageXY(c, geo);
    const occupied = dlg && px > dlg.left - m && px < dlg.right + m && py > dlg.top - m && py < dlg.bottom + m;
    if (occupied) continue;
    const note = i > 0 ? '（前一候选被对话框占据，另选）' : '';
    return { idx: i, label: c.label + note, pageX: px, pageY: py };
  }
  const { px, py } = refPageXY(REF_CANDIDATES[0], geo);
  return { idx: 0, label: '头部中点(兜底)', pageX: px, pageY: py };
}

// 在 Web UI 页内收集 DOM 结构；返回对象必须可 JSON 序列化（DOMRect 显式取值组装）。
function dumpScript(step) {
  return `(function () {
    var out = { step: ${JSON.stringify(step)}, url: location.href,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      zone: [], candidates: [], chatHeader: null };
    function rectOf(el) {
      var r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }
    function clsOf(el) {
      return typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    }
    function visible(el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (el.offsetParent !== null) return true;
      return cs.position === 'fixed' || cs.position === 'sticky';
    }
    // a) 与右上角窗控区相交的可见元素
    var W = window.innerWidth;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (!(r.left < W && r.right > W - 340 && r.top < 96)) continue;
      var anc = [];
      var p = el.parentElement;
      while (p && anc.length < 4) {
        anc.push({ tag: p.tagName.toLowerCase(), className: clsOf(p) });
        p = p.parentElement;
      }
      out.zone.push({ tag: el.tagName.toLowerCase(), id: el.id || '', className: clsOf(el),
        rect: rectOf(el), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        ancestors: anc });
    }
    // b) class/id 匹配面板相关关键字的元素（去重，最多 200 个）
    var re = /panel|preview|diff|change|drawer|aside|sidebar|header|modal|mask|overlay|dialog/i;
    var seen = new Set();
    for (var j = 0; j < all.length; j++) {
      if (out.candidates.length >= 200) break;
      var e2 = all[j];
      if (seen.has(e2)) continue;
      if (!(re.test(clsOf(e2)) || re.test(e2.id || ''))) continue;
      seen.add(e2);
      out.candidates.push({ tag: e2.tagName.toLowerCase(), id: e2.id || '', className: clsOf(e2),
        rect: rectOf(e2), visible: visible(e2) });
    }
    // c) header.chat-header 高度与 class
    var h = document.querySelector('header.chat-header');
    if (h) out.chatHeader = { offsetHeight: h.offsetHeight, className: clsOf(h) };
    return out;
  })()`;
}

async function dump(win, step) {
  try {
    const data = await win.webContents.executeJavaScript(dumpScript(step));
    fs.writeFileSync(path.join(outDir, `dump-${step}.json`), JSON.stringify(data, null, 2));
    console.log(`[probe] dump-${step}.json (zone=${data.zone.length}, candidates=${data.candidates.length})`);
    return data;
  } catch (err) {
    console.log(`[probe] dump ${step} 失败: ${err.message}`);
    return null;
  }
}

async function dumpAndShot(win, step) {
  await dump(win, step);
  await shot(win, `shot-${step}.png`);
  await screenShot(win, `screen-${step}.png`);
}

// 关闭 Web UI 首启欢迎框等遮挡对话框（开始使用 / 关闭按钮 / Esc）
const DISMISS_DIALOG_JS = `(function () {
  var ovs = document.querySelectorAll('.ui-dialog__overlay, [class*="dialog"], [role="dialog"]');
  var acted = [];
  for (var i = 0; i < ovs.length; i++) {
    var ov = ovs[i];
    var cs = getComputedStyle(ov);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var root = ov.contains(document.querySelector('.ui-dialog')) ? ov : (ov.closest('.ui-dialog__overlay') || ov);
    var btns = root.querySelectorAll('button');
    var done = false;
    for (var j = 0; j < btns.length; j++) {
      var t = (btns[j].textContent || '').replace(/\\s+/g, '');
      if (/^(开始使用|完成|确定|知道了|关闭)$/.test(t)) { btns[j].click(); acted.push('btn:' + t); done = true; break; }
    }
    if (!done) {
      var x = root.querySelector('.ui-dialog__close, [class*="close"]');
      if (x) { x.click(); acted.push('close-x'); }
    }
  }
  return acted.length ? acted.join(',') : 'no-dialog';
})()`;

// 尽最大努力点击侧栏「工作区」分组下第一个会话条目（多策略文本/结构查找）
// 优先点击标题含「状态栏还是有些割裂」的会话（聊天流内含 png 附件卡片）
const CLICK_SESSION_JS = `(function () {
  function txt(el) { return (el.textContent || '').replace(/\\s+/g, ' ').trim(); }
  function vis(el) { return el.offsetParent !== null || getComputedStyle(el).position === 'fixed'; }
  var side = null;
  var sideSels = ['aside', '[class*="sidebar"]', '[class*="side-bar"]', 'nav', '[class*="workspace"]', '[class*="history"]'];
  for (var s = 0; s < sideSels.length; s++) { side = document.querySelector(sideSels[s]); if (side) break; }
  if (!side) return 'no-sidebar';
  function rowsIn(scope) {
    var out = [];
    var rows = scope.querySelectorAll('[class*="session"], [class*="conversation"], [class*="chat-item"], [role="treeitem"], a[href], li, div, button, [role="button"]');
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      var t = txt(row);
      if (!t || t.length < 2 || t === '工作区' || t.indexOf('暂无对话') !== -1) continue;
      if (!vis(row)) continue;
      var r = row.getBoundingClientRect();
      if (r.height < 12 || r.height > 120) continue;
      if (row.querySelector('[class*="session"], [class*="conversation"], [class*="chat-item"], li')) continue; // 只取最内层行
      out.push({ row: row, text: t });
    }
    return out;
  }
  // 策略1：按目标标题
  var rows = rowsIn(side);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].text.indexOf('状态栏还是有些割裂') !== -1) { rows[i].row.click(); return 'clicked-target:' + rows[i].text.slice(0, 40); }
  }
  // 策略2：第一个工作区分组下的第一行
  var scope = side;
  var kids = side.querySelectorAll('*');
  for (var g = 0; g < kids.length; g++) {
    if (kids[g].children.length === 0 && txt(kids[g]).indexOf('工作区') !== -1) {
      var gp = kids[g].parentElement;
      scope = (gp && gp.parentElement) || gp || side;
      break;
    }
  }
  rows = rowsIn(scope);
  if (rows.length) { rows[0].row.click(); return 'clicked-first:' + rows[0].text.slice(0, 40); }
  return 'no-session-row';
})()`;

// 找会话头部区域里的「改动」入口（实证：button.ch-git，内含分支名与 +add-del 统计；兜底搜「改动」文本）
const CLICK_CHANGES_JS = `(function () {
  var git = document.querySelector('header.chat-header button.ch-git, header button.ch-git, button.ch-git');
  if (git && git.offsetParent !== null) { git.click(); return 'clicked:ch-git:' + (git.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30); }
  var cands = document.querySelectorAll('button, [role="tab"], [role="button"], a, [class*="tab"], header *, [class*="header"] *');
  for (var i = 0; i < cands.length; i++) {
    var el = cands[i];
    var t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    var label = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '')).trim();
    if ((t.indexOf('改动') === -1 && label.indexOf('改动') === -1) || t.length > 20) continue;
    if (el.offsetParent === null) continue;
    el.click();
    return 'clicked:' + (t || label).slice(0, 40);
  }
  return 'not-found';
})()`;

// 找会话内容里的附件/图片卡片并点击第一个；聊天流虚拟渲染时先滚到顶部促使历史消息渲染
const CLICK_PREVIEW_JS = `(async function () {
  function vis(el) { return el.offsetParent !== null || getComputedStyle(el).position === 'fixed'; }
  function findCard() {
    var scope = document.querySelector('main') || document.body;
    var imgs = scope.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (!vis(img)) continue;
      var r = img.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue;
      var src = (img.currentSrc || img.src || '');
      if (/^data:image\\/svg/.test(src)) continue; // 跳过内联图标
      return { kind: 'img', el: img, desc: (img.alt || src).slice(0, 60) };
    }
    var chips = scope.querySelectorAll('[class*="attach"], [class*="file"], [class*="chip"], [class*="card"], [class*="media"], [class*="thumb"]');
    for (var j = 0; j < chips.length; j++) {
      var c = chips[j];
      var t = (c.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!t || t.length > 120) continue;
      if (!/\\.(png|jpe?g|gif|webp|bmp)(\\s|$|\\?)/i.test(t)) continue;
      if (!vis(c)) continue;
      return { kind: 'chip', el: c, desc: t.slice(0, 40) };
    }
    return null;
  }
  // 找最大可滚动容器（聊天流），分段滚到顶部让虚拟列表渲染历史消息
  var sc = null, sh = 0;
  var all = document.querySelectorAll('*');
  for (var k = 0; k < all.length; k++) {
    var el = all[k];
    if (el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200) {
      var oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > sh) { sc = el; sh = el.scrollHeight; }
    }
  }
  var found = findCard();
  if (!found && sc) {
    for (var step = 0; step < 8 && !found; step++) {
      sc.scrollTop = Math.max(0, sc.scrollTop - 1500);
      await new Promise(function (r) { setTimeout(r, 700); });
      found = findCard();
    }
  }
  if (!found) return 'not-found';
  var target = found.kind === 'img'
    ? (found.el.closest('[role="button"], a, [class*="card"], [class*="attach"], [class*="file"], [class*="image"], [class*="media"]') || found.el)
    : found.el;
  target.click();
  return 'clicked-' + found.kind + ':' + found.desc;
})()`;

// 点击左下角「设置」按钮（优先视口左下区域，找不到则取任意匹配项兜底）
const CLICK_SETTINGS_JS = `(function () {
  var all = document.querySelectorAll('button, [role="button"], a, [class*="setting"], [aria-label]');
  var W = window.innerWidth, H = window.innerHeight;
  var fallback = null;
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var label = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '') + ' ' + (el.textContent || '')).replace(/\\s+/g, ' ').trim();
    if (!/设置|settings/i.test(label)) continue;
    if (el.offsetParent === null) continue;
    var r = el.getBoundingClientRect();
    if (r.left < W * 0.4 && r.top > H * 0.5) { el.click(); return 'clicked:' + label.slice(0, 40); }
    if (!fallback) fallback = el;
  }
  if (fallback) {
    fallback.click();
    return 'clicked-fallback:' + ((fallback.getAttribute('aria-label') || '') + ' ' + (fallback.textContent || '')).replace(/\\s+/g, ' ').trim().slice(0, 40);
  }
  return 'not-found';
})()`;

// 检测是否仍有可见蒙版/模态
const HAS_MODAL_JS = `(function () {
  var els = document.querySelectorAll('[class*="modal"], [class*="mask"], [class*="overlay"], [class*="dialog"], [role="dialog"]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var r = el.getBoundingClientRect();
    if (r.width > window.innerWidth * 0.3 && r.height > window.innerHeight * 0.3) return 'modal-open';
  }
  return 'no-modal';
})()`;

// 点击蒙版兜底关闭
const CLICK_MASK_JS = `(function () {
  var els = document.querySelectorAll('[class*="mask"], [class*="overlay"], [class*="modal"], [role="dialog"]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var r = el.getBoundingClientRect();
    if (r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5) { el.click(); return 'mask-clicked'; }
  }
  return 'no-mask';
})()`;

async function run(win) {
  // 前置：关闭欢迎/迁移等遮挡对话框
  try {
    const r = await win.webContents.executeJavaScript(DISMISS_DIALOG_JS);
    console.log(`[probe] 关闭遮挡对话框: ${r}`);
    if (r !== 'no-dialog') await sleep(1000);
  } catch (err) { console.log(`[probe] 关闭遮挡对话框失败: ${err.message}`); }

  // 步骤 home
  try {
    console.log('[probe] 步骤 home');
    await dumpAndShot(win, 'home');
  } catch (err) { console.log(`[probe] home 失败: ${err.message}`); }

  // 步骤 changes：打开改动面板（ch-git 由 git 状态异步渲染，轮询至多 20s；
  // 先于 session 切换、在初始加载的当前会话里执行）
  try {
    console.log('[probe] 步骤 changes');
    let r = 'not-found';
    for (let i = 0; i < 20; i++) {
      try {
        r = await win.webContents.executeJavaScript(CLICK_CHANGES_JS);
      } catch (err) { console.log(`[probe] 改动入口轮询异常: ${err.message}`); }
      if (r !== 'not-found') break;
      await sleep(1000);
    }
    console.log(`[probe] 改动入口: ${r}`);
    if (r === 'not-found') {
      console.log('[probe] changes not-found，跳过');
    } else {
      await sleep(2000);
      await dumpAndShot(win, 'changes');
    }
  } catch (err) { console.log(`[probe] changes 失败: ${err.message}`); }

  // 步骤 session：点击侧栏目标会话（状态栏还是有些割裂，内含 png 附件）
  try {
    console.log('[probe] 步骤 session');
    const r = await win.webContents.executeJavaScript(CLICK_SESSION_JS);
    console.log(`[probe] 会话点击: ${r}`);
    await sleep(3000);
    await dumpAndShot(win, 'session');
  } catch (err) { console.log(`[probe] session 失败: ${err.message}`); }

  // 步骤 preview：点击附件/图片卡片
  try {
    console.log('[probe] 步骤 preview');
    const r = await win.webContents.executeJavaScript(CLICK_PREVIEW_JS);
    console.log(`[probe] 附件点击: ${r}`);
    if (r === 'not-found') {
      console.log('[probe] preview not-found，跳过');
    } else {
      await sleep(2000);
      await dumpAndShot(win, 'preview');
    }
  } catch (err) { console.log(`[probe] preview 失败: ${err.message}`); }

  // 步骤 modal：设置模态开/关——点击瞬间起每 ~100ms 逐帧 OS 截屏至 +1200ms，
  // 测窗控条区点(strip)与蒙版参考点(ref)的 Δ 收敛时间
  try {
    console.log('[probe] 步骤 modal');
    // 开测前取几何：视口宽高与会话头部高度（strip 点 y = bounds.y + headerH/2）
    let geo = { W: 1280, H: 800, headerH: 48 };
    try {
      const g = await win.webContents.executeJavaScript(`(function () {
        var h = document.querySelector('header.chat-header');
        return { W: window.innerWidth, H: window.innerHeight,
          headerH: h && h.offsetHeight > 0 ? h.offsetHeight : 48 };
      })()`);
      if (g && g.W) geo = g;
    } catch (err) { console.log(`[probe] 几何读取失败: ${err.message}`); }
    console.log(`[probe] 几何: W=${geo.W} H=${geo.H} headerH=${geo.headerH}`);
    // 抢前台（全屏游戏会盖住本窗口；show+focus 使其退出独占前台，moveTop 单用无效）
    try { win.show(); win.focus(); win.moveTop(); } catch { /* ignore */ }
    await sleep(500);
    const b0 = win.getBounds();
    const stripDip = { x: b0.x + b0.width - 75, y: b0.y + geo.headerH / 2 };
    console.log(`[probe] 窗控条采样点 strip dip(${stripDip.x}, ${stripDip.y})`);

    // 建屏幕采样流（一次 getSources 拿源 id + 隐藏捕获窗 getUserMedia 实时流）；
    // 采样区组：0=窗控条区细带，1..4=蒙版参考候选区（头部中/左/右 + 侧栏兜底）
    let sampler = null;
    let rectsPx = null;
    let cornerPx = null;
    // 遮挡守卫：页面坐标下 ref 候选0（头部中点）的 7x7 区，与 rectsPx[1] 同一逻辑点
    const g0 = refPageXY(REF_CANDIDATES[0], geo);
    const guardRect = { x: Math.max(0, g0.px - 3), y: Math.max(0, g0.py - 3), width: 7, height: 7 };
    try {
      sampler = await startScreenSampler(win);
      // 窗控条区：以 spec 点 (width-75, headerH/2) 的 x 为中心、顶部 y∈[2,8] 的 120x6 细带众数
      // ——spec 点本身正压在 ▢ 字形上（字形占区 ~40%，众数会被符号色夺走），细带取纯 overlay 底色
      rectsPx = [dipRectToPx(sampler, stripDip.x, b0.y + 5, 120, 6)];
      for (const c of REF_CANDIDATES) {
        const { px, py } = refPageXY(c, geo);
        rectsPx.push(dipRectToPx(sampler, b0.x + px, b0.y + py, 7, 7));
      }
      const c0 = dipToPx(sampler, b0.x + b0.width - 340, b0.y);
      const c1 = dipToPx(sampler, b0.x + b0.width, b0.y + 64);
      cornerPx = { x: Math.round(c0[0]), y: Math.round(c0[1]),
        w: Math.max(1, Math.round(c1[0] - c0[0])), h: Math.max(1, Math.round(c1[1] - c0[1])) };
      // 预热采样链路（首帧解码较慢）并取点击前基线 + 遮挡预检
      const base = await sampler.capWin.webContents.executeJavaScript(
        `window.__capSample(${JSON.stringify(rectsPx)}, null)`);
      console.log(`[probe] 基线(点击前) strip=${rgbStr(base.samples[0])} 候选=${base.samples.slice(1).map(rgbStr).join(' | ')}`);
      try {
        const gimg = await win.webContents.capturePage(guardRect);
        const gmode = modeOfBitmap(gimg.toBitmap());
        const gd = gmode ? rgbDelta(gmode, base.samples[1]) : null;
        console.log(`[probe] 遮挡预检: 页面色=${gmode ? rgbStr(gmode) : '?'} 屏幕色=${rgbStr(base.samples[1])} 偏差=${gd}${gd != null && gd > 15 ? ' <<被遮挡!抢前台失败' : ''}`);
      } catch (err) { console.log(`[probe] 遮挡预检失败: ${err.message}`); }
    } catch (err) { console.log(`[probe] 屏幕采样流建立失败: ${err.message}`); }

    const r = await win.webContents.executeJavaScript(CLICK_SETTINGS_JS);
    console.log(`[probe] 设置按钮: ${r}`);
    if (r === 'not-found') {
      console.log('[probe] modal not-found，跳过');
    } else {
      // 开：点击瞬间起逐帧测量
      const t0 = Date.now();
      const openFrames = sampler ? await measureTransition(win, sampler, rectsPx, cornerPx, t0, 'modal-open', guardRect, 1) : [];
      const ref = await pickMaskRefIndex(win, geo);
      console.log(`[probe] 蒙版参考点: ${ref.label} page(${ref.pageX}, ${ref.pageY})`);
      logSampledFrames(openFrames, ref.idx + 1, 'modal-open');
      saveCornerDataUrl(openFrames, 'open');
      await dump(win, 'modal');

      // 按 Esc 关闭，失败则点蒙版兜底；关闭瞬间起同样逐帧测量
      try {
        win.webContents.sendInputEvent({ type: 'keyDown', key: 'Escape', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', key: 'Escape', keyCode: 'Escape' });
      } catch (err) { console.log(`[probe] Esc 发送失败: ${err.message}`); }
      const t1 = Date.now();
      const closeFrames = sampler ? await measureTransition(win, sampler, rectsPx, cornerPx, t1, 'modal-close', guardRect, 1) : [];
      console.log(`[probe] 蒙版参考点(关): 同开 ${ref.label} page(${ref.pageX}, ${ref.pageY})`);
      logSampledFrames(closeFrames, ref.idx + 1, 'modal-close');
      saveCornerDataUrl(closeFrames, 'close');
      try {
        const state = await win.webContents.executeJavaScript(HAS_MODAL_JS);
        console.log(`[probe] Esc 后模态状态: ${state}`);
        if (state === 'modal-open') {
          const m = await win.webContents.executeJavaScript(CLICK_MASK_JS);
          console.log(`[probe] 蒙版兜底: ${m}`);
          await sleep(1000);
        }
      } catch (err) { console.log(`[probe] 模态关闭检查失败: ${err.message}`); }
      await dumpAndShot(win, 'modal-closed');
    }
    if (sampler) {
      try { sampler.capWin.destroy(); } catch { /* ignore */ }
      try { sampler.srv.close(); } catch { /* ignore */ }
    }
  } catch (err) { console.log(`[probe] modal 失败: ${err.message}`); }
}

app.whenReady().then(async () => {
  // 硬上限：找到 Web UI 窗口后 180 秒强制退出本实例（等待阶段本身至多 300s）

  // 轮询等 Web UI 窗口（loopback http(s)），至多 300s（首次隔离 userData 可能有初始化耗时）
  let win = null;
  for (let i = 0; i < 300; i++) {
    try {
      win = findWebUiWindow();
      if (win) break;
    } catch { /* ignore */ }
    await sleep(1000);
    if (i % 10 === 9) {
      let desc = '';
      try {
        desc = BrowserWindow.getAllWindows()
          .map((w) => `#${w.id}:${(w.webContents.getURL() || '').slice(0, 80)}`)
          .join(' | ');
      } catch { /* ignore */ }
      console.log(`[probe] 等待 Web UI 窗口... ${i + 1}s | windows: ${desc || '(none)'}`);
    }
  }
  if (!win) {
    console.log('[probe] 300s 内未找到 Web UI 窗口，退出');
    app.exit(0);
    return;
  }
  console.log(`[probe] 找到 Web UI 窗口: ${win.webContents.getURL()}`);
  // 硬上限：此后 180 秒强制退出本实例（逐帧测量 + 多轮截屏耗时上调）
  setTimeout(() => {
    console.log('[probe] 到达 180s 硬上限，退出');
    app.exit(0);
  }, 180000);
  await sleep(3000); // 等 SPA 稳定

  try {
    await run(win);
  } catch (err) {
    console.log(`[probe] 主流程异常: ${err.message}`);
  }
  console.log('[probe] 全部完成，退出');
  app.exit(0);
});
