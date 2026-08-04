// scripts/workspace-integration-probe.js —— M3/M4/M6-1 真实集成探针（一次性探测脚本，不进打包）
//
// 目标：自动验证完整链 —— Workspace WebContentsView → preload window.workspace →
// sender 校验 IPC → verified session workDir → git-service / file-browser → 回传数据；
// 并验证 M6-1 feature flag 关闭路径（workspacePanelEnabled:false 时不创建/加载面板）。
//
// 用法：
//  - 默认 / --flag-on：npx electron scripts/workspace-integration-probe.js
//    （flag 开启路径，行为与既有 M3/M4 探针一致）
//  - --flag-off：npx electron scripts/workspace-integration-probe.js --flag-off
//    （flag 关闭路径，见下）
//  - --all：npx electron scripts/workspace-integration-probe.js --all
//    （顺序 spawn 两个独立子进程先 flag-off 后 flag-on，任一失败非零退出；
//      两实例各自独立 userData/隔离 config，互不污染）
// 行为（flag 开启 / 默认）：
//  - 启动前隔离 userData（os.tmpdir()/kcd-workspace-integration-probe）并写入无 BOM config
//    （{mode:'auto',autoStartCli:true,workspacePanelEnabled:true,workspacePanelCollapsed:false,theme:'system'}）
//    → require('../src/main/main.js') 启动真实主进程（真实 CLI + 真实 Web UI + 真实面板）
//  - 从 ~/.kimi-code/session_index.jsonl 找 workDir 归一化后等于本项目目录的最新会话
//  - 主窗口导航 /sessions/<id>（保留原 hash token 段维持认证；打印一律移除 hash），
//    在面板 webContents 上经 window.workspace 桥逐项断言
//  - M4 覆盖：getContext 与 getProjection 在同一 executeJavaScript 桥调用中执行；断言
//    projection ok===true / sessionId 匹配 / agents、tasks 均为数组（不强制非空）/ capturedAt
//    为有效数字；最终 JSON 汇总 projection:{ok,agents,tasks,capturedAt,diagnostics}，不打印内容
// 行为（--flag-off，M6-1）：
//  - 独立 userData（os.tmpdir()/kcd-workspace-integration-probe-flagoff）写入同一形态 config，
//    仅 workspacePanelEnabled:false → require main.js 启动真实主进程
//  - 断言：主窗口达 http(s) Kimi Web URL 后，观察窗内 webContents 全量枚举无任何
//    workspace.html 页面（main.js 中 flag 关闭时 showWorkspacePanel 直接 return，
//    workspaceView 恒 null → 无视图创建、无 loadFile、无 workspace-preload 注入、
//    workspace:* IPC 无 sender 可达）→ 主会话仍成功加载（URL 保持 http(s) 且 document 可达）
//  - 不依赖 capturePage，全部基于 webContents 枚举 / executeJavaScript 的可靠内省
//  - 不发送 prompt、不改项目/会话数据，只有 CLI 启动产生的常规运行状态
//  - 任一断言失败 / 总超时 120s → 明确 exit 1；正常完成 exit 0（app.quit 允许 main 正常 shutdown）
// 安全：所有打印 URL 移除 hash；绝不打印 token。
const { app, BrowserWindow, webContents } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => console.log(`[ws-probe] ${msg}`);

// ---------- CLI 模式解析（必须在 require main.js 之前完成） ----------
const FLAG_OFF = process.argv.includes('--flag-off');

// ---------- --all 组合模式：顺序 spawn 两个独立子进程（flag-off → flag-on） ----------
// 每个子进程独立 userData/隔离 config，互不污染；任一失败立即非零退出。
if (process.argv.includes('--all')) {
  const { spawnSync } = require('child_process');
  const script = __filename;
  let failed = null;
  for (const arg of ['--flag-off', '--flag-on']) {
    say(`[--all] 启动子进程 ${arg} …`);
    const r = spawnSync(process.execPath, [script, arg], { stdio: 'inherit', timeout: 170000 });
    const st = (r && typeof r.status === 'number') ? r.status : 1;
    if (st !== 0) {
      failed = { arg, st };
      break;
    }
    say(`[--all] ${arg} 通过（status=0）`);
  }
  if (failed) {
    say(`[--all] ${failed.arg} 失败（status=${failed.st}），整体非零退出`);
    process.exit(1);
  }
  say('[--all] flag-off 与 flag-on 均通过，整体退出 0');
  process.exit(0);
}

// URL 脱敏：hash 段（token 所在）整体替换
const sanitizeUrl = (u) => {
  const i = String(u).indexOf('#');
  return i >= 0 ? `${String(u).slice(0, i)}#***` : String(u);
};
// 字符串中的 token=xxx 值抹掉（防 console 消息等场景泄露）
const maskToken = (s) => String(s).replace(/token=([^&"'\\s]*)/gi, 'token=***');

// 路径归一化比较（Windows 大小写不敏感 FS；path.resolve 统一分隔符）
const normDir = (p) => {
  try { return path.resolve(String(p)); } catch { return null; }
};
const sameDir = (a, b) => {
  const x = normDir(a);
  const y = normDir(b);
  return x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
};

// ---------- 隔离：userData + 无 BOM config（必须在 require main.js 之前） ----------
// flag-off 与 flag-on 使用不同 userData 目录，--all 组合运行时两实例互不污染
const userData = path.join(
  os.tmpdir(),
  FLAG_OFF ? 'kcd-workspace-integration-probe-flagoff' : 'kcd-workspace-integration-probe'
);
app.setPath('userData', userData);
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(
  path.join(userData, 'config.json'),
  JSON.stringify({
    mode: 'auto',
    autoStartCli: true,
    workspacePanelEnabled: !FLAG_OFF,
    workspacePanelCollapsed: false,
    theme: 'system',
  }, null, 2),
  'utf8'
);

// 启动真实主进程（顶层注册生命周期，whenReady 回调先于本脚本执行）
require('../src/main/main.js');

// ---------- 目标工作区与目标会话 ----------
const targetWorkDir = path.resolve(__dirname, '..');

function resolveTargetSession() {
  const indexPath = path.join(os.homedir(), '.kimi-code', 'session_index.jsonl');
  let lines;
  try {
    lines = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch (err) {
    throw new Error(`读取会话索引失败 ${indexPath}: ${err.message}`);
  }
  // 从后往前找第一条 workDir 归一化匹配的条目 = 最新一条
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e && typeof e === 'object' && typeof e.workDir === 'string' && sameDir(e.workDir, targetWorkDir)) {
        if (typeof e.sessionId === 'string' && e.sessionId.length > 0) return e.sessionId;
      }
    } catch { /* 跳过损坏行 */ }
  }
  throw new Error(`session_index.jsonl 中无 workDir 匹配 ${targetWorkDir} 的会话条目`);
}

// ---------- 收集区（供超时兜底/失败时打印） ----------
const result = {
  targetSessionId: null,
  context: null,      // { state, workDir }
  changes: null,      // { count }
  files: null,        // { count }
  packagePreview: null,
  diff: null,         // { ok, same, length, source } 或 { skipped, reason }
  excludedPathReason: null,
  projection: null,   // { ok, agents, tasks, capturedAt, diagnostics }
  panelErrors: [],    // 必须为空
};

let hardTimer = null;

// 收尾：app.quit 走 main 的 before-quit（含 stopKimi POST shutdown），
// 'quit' 事件真正触发后再 process.exit(code)；15s 兜底防 before-quit 挂死
function finish(code) {
  clearTimeout(hardTimer);
  setTimeout(() => process.exit(code), 15000).unref();
  app.once('quit', () => process.exit(code));
  app.quit();
}

// 在面板 webContents 上执行表达式并返回 JSON 解析结果（异常 → { __probeError }）
function callWs(expr) {
  return wsWc.executeJavaScript(
    `(async () => { try { return JSON.stringify(await (${expr})); } catch (err) { return JSON.stringify({ __probeError: String(err && err.message || err) }); } })()`
  ).then((s) => {
    try { return JSON.parse(s); } catch { return { __probeError: 'JSON 解析失败' }; }
  });
}

let wsWc = null;

// ---------- 主流程 ----------
async function main() {
  result.targetSessionId = resolveTargetSession();
  say(`目标会话: ${result.targetSessionId}`);

  // ---------- ① 等主窗口成为 http(s) Kimi Web URL 且 workspace 子页面出现（≤90s） ----------
  let mainWin = null;
  const readyDeadline = Date.now() + 90000;
  while (Date.now() < readyDeadline) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0 && !wins[0].isDestroyed()) {
      const u = wins[0].webContents.getURL();
      if (/^https?:/i.test(u)) {
        const found = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/workspace.html'));
        if (found) {
          mainWin = wins[0];
          wsWc = found;
          // 尽早挂上面板 console-message 监听（此后面板页面的 error 均入账）
          wsWc.on('console-message', (...args) => {
            let level, message;
            if (typeof args[1] === 'number') {
              level = args[1];
              message = args[2];
            } else if (args[1] && typeof args[1] === 'object') {
              level = args[1].level;
              message = args[1].message;
            }
            if (typeof level === 'number' && level >= 3) {
              result.panelErrors.push(maskToken(message));
            }
          });
          say(`主窗口就绪: ${sanitizeUrl(u)}；workspace 页面: ${sanitizeUrl(found.getURL())}`);
          break;
        }
      }
    }
    await sleep(1000);
  }
  if (!mainWin || !wsWc) {
    throw new Error('90s 内未就绪：主窗口未达 http(s) Kimi Web URL 或 workspace 子页面未出现');
  }

  // ---------- ② 主窗口导航到 /sessions/<targetSessionId>（保留原 hash 认证段） ----------
  const cur = new URL(mainWin.webContents.getURL());
  const navUrl = `${cur.origin}/sessions/${result.targetSessionId}${cur.hash}`;
  say(`导航主窗口: ${sanitizeUrl(navUrl)}`);
  try {
    await mainWin.loadURL(navUrl);
  } catch (err) {
    say(`loadURL 异常（继续轮询等待）: ${err.message}`);
  }
  const navDeadline = Date.now() + 30000;
  let navOk = false;
  while (Date.now() < navDeadline) {
    const nowUrl = mainWin.webContents.getURL();
    try {
      if (new URL(nowUrl).pathname.includes(`/sessions/${result.targetSessionId}`)) {
        navOk = true;
        break;
      }
    } catch { /* URL 过渡期 */ }
    await sleep(1000);
  }
  if (!navOk) {
    throw new Error(`导航后 URL 未达 /sessions/${result.targetSessionId}（当前 ${sanitizeUrl(mainWin.webContents.getURL())}）`);
  }
  say(`导航成功: ${sanitizeUrl(mainWin.webContents.getURL())}`);

  // ---------- ③ window.workspace 桥逐项探测与断言 ----------
  // M4：getContext 与 getProjection 在同一 executeJavaScript 桥调用中执行（组合快照）
  const ctxRes = await callWs(`(async () => ({
    ctx: await window.workspace.getContext(),
    proj: await window.workspace.getProjection(),
  }))()`);
  const ctx = ctxRes && ctxRes.ctx;
  if (!ctx || ctx.state !== 'bound') throw new Error(`getContext 未 bound: ${JSON.stringify(ctxRes)}`);
  if (!sameDir(ctx.workDir, targetWorkDir)) throw new Error(`getContext workDir 不匹配: ${JSON.stringify(ctx.workDir)}（期望 ${targetWorkDir}）`);
  result.context = { state: ctx.state, workDir: ctx.workDir };
  say(`getContext: ${result.context.state} workDir=${result.context.workDir}`);

  // M4 投影断言：ok===true、sessionId 匹配、agents/tasks 均为数组、capturedAt 为有效数字；
  // 不强制 agents/tasks 非空（真实会话可能没有任务）
  const proj = ctxRes && ctxRes.proj;
  if (!proj || proj.ok !== true || proj.sessionId !== result.targetSessionId ||
      !Array.isArray(proj.agents) || !Array.isArray(proj.tasks) ||
      typeof proj.capturedAt !== 'number' || !Number.isFinite(proj.capturedAt)) {
    throw new Error(`getProjection 断言失败: ${JSON.stringify(proj)}`);
  }
  result.projection = {
    ok: proj.ok,
    agents: proj.agents.length,
    tasks: proj.tasks.length,
    capturedAt: proj.capturedAt,
    diagnostics: proj.diagnostics,
  };
  say(`getProjection: ok, agents=${result.projection.agents}, tasks=${result.projection.tasks}, capturedAt=${result.projection.capturedAt}`);

  const changes = await callWs('window.workspace.getChanges()');
  if (!changes || changes.ok !== true || !Array.isArray(changes.entries)) {
    throw new Error(`getChanges 失败: ${JSON.stringify(changes)}`);
  }
  result.changes = { count: changes.entries.length };
  say(`getChanges: ok, ${result.changes.count} 条变更`);

  const files = await callWs("window.workspace.listFiles('')");
  if (!files || files.ok !== true || !Array.isArray(files.entries)) {
    throw new Error(`listFiles 失败: ${JSON.stringify(files)}`);
  }
  result.files = { count: files.entries.length };
  say(`listFiles(''): ok, ${result.files.count} 个条目`);

  const pkg = await callWs("window.workspace.readFile('package.json')");
  if (!pkg || pkg.ok !== true || typeof pkg.content !== 'string' || !pkg.content.includes('kimi-code-desktop')) {
    throw new Error(`readFile('package.json') 失败: ${JSON.stringify(pkg)}`);
  }
  result.packagePreview = { ok: true, size: pkg.size, preview: pkg.content.slice(0, 200) };
  say(`readFile('package.json'): ok（含 kimi-code-desktop，size=${pkg.size}）`);

  if (changes.entries.length > 0) {
    const e0 = changes.entries[0];
    const dNum = await callWs(
      `window.workspace.getDiff(${JSON.stringify(changes.snapshotId)}, ${JSON.stringify(e0.id)})`
    );
    const dStr = await callWs(
      `window.workspace.getDiff(${JSON.stringify(changes.snapshotId)}, ${JSON.stringify(String(e0.id))})`
    );
    if (!dNum || dNum.ok !== true || !dStr || dStr.ok !== true) {
      throw new Error(`getDiff 失败: number=${JSON.stringify(dNum)} string=${JSON.stringify(dStr)}`);
    }
    if (dNum.diff !== dStr.diff) {
      throw new Error('getDiff 的 number/string entryId 结果不一致');
    }
    result.diff = { ok: true, same: true, length: (dNum.diff || '').length, source: dNum.source };
    say(`getDiff: ok，number 与 string entryId 结果一致（length=${result.diff.length}）`);
  } else {
    result.diff = { skipped: true, reason: 'changes 为空' };
    say('getDiff: 跳过（changes 为空）');
  }

  const gitCfg = await callWs("window.workspace.readFile('.git/config')");
  if (!gitCfg || gitCfg.ok !== false || gitCfg.reason !== 'excluded-path') {
    throw new Error(`readFile('.git/config') 应返回 excluded-path: ${JSON.stringify(gitCfg)}`);
  }
  result.excludedPathReason = gitCfg.reason;
  say(`readFile('.git/config'): ${gitCfg.reason}（排除生效）`);

  // ---------- ④ 面板 console error 必须为空 ----------
  if (result.panelErrors.length > 0) {
    throw new Error(`workspace 页面出现 console error(${result.panelErrors.length}): ${result.panelErrors.slice(0, 5).join(' | ')}`);
  }
  say('panelErrors: 空');

  return 0;
}

// ---------- 主流程（--flag-off / M6-1）：flag 关闭路径验证 ----------
// 内省依据（main.js 口径）：flag 关闭时 showWorkspacePanel 直接 return（不创建视图）、
// connectToInstance 不调用 showWorkspacePanel → workspaceView 恒 null → 无 workspace.html
// WebContentsView、无 loadFile、无 workspace-preload 注入、workspace:* IPC 无 sender 可达。
async function mainFlagOff() {
  result.mode = 'flag-off';
  result.flagOff = {};

  // ---------- ① 等主窗口成为 http(s) Kimi Web URL（≤90s）——主会话成功加载的前提 ----------
  let mainWin = null;
  const readyDeadline = Date.now() + 90000;
  while (Date.now() < readyDeadline) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0 && !wins[0].isDestroyed()) {
      const u = wins[0].webContents.getURL();
      if (/^https?:/i.test(u)) {
        mainWin = wins[0];
        break;
      }
    }
    await sleep(1000);
  }
  if (!mainWin) {
    throw new Error('90s 内主窗口未达 http(s) Kimi Web URL（CLI/主会话未成功加载）');
  }
  const mainUrl = sanitizeUrl(mainWin.webContents.getURL());
  result.flagOff.mainSessionUrl = mainUrl;
  say(`主窗口就绪: ${mainUrl}（主会话已由 CLI 启动）`);

  // ---------- ② 观察窗：全量枚举 webContents，断言 workspace.html 视图绝不出现 ----------
  // 持续 10s 轮询（flag 开启路径面板在 http(s) 就绪前后即加载；关闭路径下任何时刻都不得出现）
  const obsMs = 10000;
  const obsStart = Date.now();
  const samples = [];
  let wsMatch = null;
  while (Date.now() < obsStart + obsMs) {
    const all = webContents.getAllWebContents();
    wsMatch = all.find((w) => {
      try { const u = w.getURL(); return !!u && u.endsWith('/workspace.html'); } catch { return false; }
    });
    samples.push({ elapsedMs: Date.now() - obsStart, webContentsTotal: all.length, workspaceMatches: wsMatch ? 1 : 0 });
    if (wsMatch) break;
    await sleep(500);
  }
  if (wsMatch) {
    throw new Error(`flag-off 下 workspace.html 视图被创建/加载: ${sanitizeUrl(wsMatch.getURL())}`);
  }
  result.flagOff.observationMs = obsMs;
  result.flagOff.samples = samples;
  result.flagOff.workspaceViewCreated = false;
  // 推论（无 workspace.html 视图的直接结果，一并记账供证据输出）：
  result.flagOff.workspacePreloadInjected = false; // 无视图即无 workspace-preload → 无 window.workspace
  result.flagOff.workspaceIpcReachable = false;    // 无视图即无 workspace:* IPC 的合法 sender 可达
  say(`flag-off 观察窗 ${obsMs}ms: webContents 无 workspace.html（样本 ${samples.length} 次，最后一次 total=${samples[samples.length - 1].webContentsTotal}）`);

  // ---------- ③ 主 Web 会话仍成功加载：URL 保持 http(s) 且 document 可达 ----------
  const readyState = await mainWin.webContents.executeJavaScript('document.readyState')
    .catch((err) => { throw new Error(`主会话 document 不可达: ${err.message}`); });
  const stillHttp = /^https?:/i.test(mainWin.webContents.getURL());
  if (!stillHttp) {
    throw new Error(`flag-off 下主窗口已离开 http(s): ${sanitizeUrl(mainWin.webContents.getURL())}`);
  }
  if (typeof readyState !== 'string' || readyState.length === 0) {
    throw new Error(`主会话 document.readyState 非法: ${JSON.stringify(readyState)}`);
  }
  result.flagOff.mainSessionAlive = true;
  result.flagOff.documentReadyState = readyState;
  say(`主会话仍成功加载: URL 保持 http(s)，document.readyState=${readyState}`);

  return 0;
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  const run = FLAG_OFF ? mainFlagOff : main;
  run().then((code) => {
    console.log(JSON.stringify(result, null, 2));
    finish(code);
  }).catch((err) => {
    say(`FATAL: ${err.message}`);
    console.log(JSON.stringify(result, null, 2));
    finish(1);
  });
});

// 120s 总超时兜底：打印已收集数据后 exit 1
hardTimer = setTimeout(() => {
  say('[timeout] 120s 总超时，失败退出');
  console.log(JSON.stringify(result, null, 2));
  finish(1);
}, 120000);
