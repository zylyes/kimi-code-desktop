// Kimi Code Desktop — 网页版桌面套壳
// 自动启动 `kimi web`，从输出中捕获带 token 的本地地址，并在桌面窗口中打开。
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog, nativeImage, Notification, globalShortcut } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');

const APP_NAME = 'Kimi Code Desktop';
const isDev = process.argv.includes('--dev');
// 可交给外部应用打开的 open-in 协议白名单
const OPEN_IN_PROTOCOLS = new Set(['vscode:', 'vscode-insiders:', 'cursor:', 'windsurf:', 'zed:', 'sublime:', 'atom:', 'jetbrains:']);

let mainWindow = null;
let kimiProc = null;
let kimiChildPid = null;
let loadedUrl = null;
let urlFound = false;
let quitting = false;
let tray = null;
let trayHintShown = false;
let sessionLauncherVisible = false; // 会话启动器当前可见（防止 startPolling 覆盖）

// 版本缓存
let cliVersionCache = null; // { version: string, semver: number[] } | null
// 优雅停止
let stoppingIntentionally = false;
let beforeQuitInProgress = false;
// 已知服务器信息
let knownServerBase = null;
let knownServerToken = null;
// 启动世代计数器（用于旧进程回调检测）
let serverGeneration = 0;
// 重启互斥锁
let restartPromise = null;
// 待恢复的会话 ID（由 resumeSession 设置，startKimiServer 消费）
let pendingSessionId = null;
// WebSocket 订阅
let wsClient = null;
let wsReconnectTimer = null;
let wsGeneration = 0;
// 窗口聚焦状态
let mainWindowFocused = true;
// 问答相关状态
let wsSubscribedSessions = new Set();
let wsDiscoveryTimer = null;
let wsClientId = 'desktop-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
let wsMessageId = 0;
let wsActiveQuestions = new Map(); // question_id -> { session_id, resolved }
// 问答窗口（同一时刻仅一个）
let questionWindow = null;
let questionWindowQuestionId = null;
// 托盘用量/进度状态
const usageState = {
  totalTokens: 0,
  contextUsed: 0,
  contextLimit: 0,
  runningTasks: 0,
  lastTaskTitle: '',
  pendingApprovals: 0,
  pendingQuestions: 0,
};

// ---------- 路径与持久化 ----------
const userDataDir = () => app.getPath('userData');
const configFile = () => path.join(userDataDir(), 'config.json');
const stateFile = () => path.join(userDataDir(), 'window-state.json');
const logFile = () => path.join(userDataDir(), 'app.log');
const pidFile = () => path.join(userDataDir(), 'child.pid');

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); } catch { /* ignore */ }
}

function sanitizeLog(msg) {
  // 脱敏：移除 URL 查询参数和 fragment、Authorization/Bearer、token 等敏感信息
  return String(msg).replace(/(https?:\/\/[^\s"'<>)\]]+)/g, (url) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return url;
    }
  }).replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer ***')
    .replace(/(?:^|[^a-zA-Z])(token[=:])\s*\S+/gi, '$1***')
    .replace(/Bearer\s+[^*\s]\S*/gi, 'Bearer ***');
}

function ensureString(v) {
  return typeof v === 'string' ? v : '';
}

function logLine(msg) {
  const sanitized = sanitizeLog(msg);
  try { fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${sanitized}\n`); } catch { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('server:log', sanitized); } catch { /* ignore */ }
  }
  return sanitized;
}

function loadConfig() {
  return Object.assign({ mode: 'auto', cliPath: '', manualUrl: '', shellPath: '', httpProxy: '', httpsProxy: '', allProxy: '', noProxy: '' }, readJSON(configFile(), {}));
}

function detectGitBash() {
  const cfg = loadConfig();
  const candidates = [];
  if (cfg.shellPath) candidates.push(cfg.shellPath);
  if (process.env.KIMI_SHELL_PATH) candidates.push(process.env.KIMI_SHELL_PATH);
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const gitPaths = [
    path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(localAppData, 'Git', 'bin', 'bash.exe'),
  ];
  candidates.push(...gitPaths);
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function buildKimiEnv(cfg) {
  const env = { ...process.env };
  if (cfg.httpProxy) env.HTTP_PROXY = cfg.httpProxy;
  if (cfg.httpsProxy) env.HTTPS_PROXY = cfg.httpsProxy;
  if (cfg.allProxy) env.ALL_PROXY = cfg.allProxy;
  if (cfg.noProxy) env.NO_PROXY = cfg.noProxy;
  const bashPath = detectGitBash();
  if (bashPath) {
    env.KIMI_SHELL_PATH = bashPath;
  }
  return env;
}

function getLoginStatus() {
  const credentialsDir = path.join(getKimiHomeDir(), 'credentials');
  let credentialCount = 0;
  try {
    if (fs.existsSync(credentialsDir)) {
      const entries = fs.readdirSync(credentialsDir);
      for (const entry of entries) {
        const fullPath = path.join(credentialsDir, entry);
        try { if (fs.statSync(fullPath).isFile()) credentialCount++; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return { authenticated: credentialCount > 0, credentialCount };
}

function defaultCliCandidates() {
  const exe = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
  return [
    path.join(os.homedir(), '.kimi-code', 'bin', exe),
    path.join(os.homedir(), '.kimi', 'bin', exe),
  ];
}

function resolveCliPath(cfg) {
  const candidates = [];
  if (cfg.cliPath) candidates.push(cfg.cliPath);
  candidates.push(...defaultCliCandidates());
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

// ---------- KIMI_CODE_HOME 工具 ----------
function getKimiHomeDir() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function readServerToken() {
  const tokenFile = path.join(getKimiHomeDir(), 'server.token');
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (token) return token;
  } catch { /* 文件尚不可用 */ }
  return null;
}

// ---------- CLI 版本检测（仅进程内缓存，每次启动均重新探测）----------
function getCliVersion(cli) {
  if (cliVersionCache) return cliVersionCache;
  // 运行 --version（不读写 cli-version.json）
  try {
    const out = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (m) {
      const parts = m[1].split('.').map(Number);
      cliVersionCache = { version: m[1], semver: parts };
      logLine(`CLI 版本: ${m[1]}`);
      return cliVersionCache;
    }
  } catch { /* ignore */ }
  logLine('CLI 版本检测失败，使用向后兼容参数');
  return null;
}

// ---------- 多实例感知 ----------
function checkMultiInstances() {
  const instancesDir = path.join(getKimiHomeDir(), 'server', 'instances');
  try {
    if (fs.existsSync(instancesDir)) {
      const entries = fs.readdirSync(instancesDir);
      if (entries.length > 0) {
        logLine(`检测到 ${entries.length} 个 CLI 实例注册项 (${instancesDir})，CLI 将自行选择端口`);
      }
    }
  } catch {
    // 静默安全
  }
}

// ---------- HTTP 工具 ----------
function httpGet(url, token) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 3000,
    };
    if (token) {
      opts.headers = { 'Authorization': `Bearer ${token}` };
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function httpPostShutdown(base, token) {
  return new Promise((resolve) => {
    const url = new URL('/api/v1/shutdown', base);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout: 3000,
    };
    if (token) {
      opts.headers = { 'Authorization': `Bearer ${token}` };
    }
    const req = http.request(opts, (res) => {
      resolve({ status: res.statusCode });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ---------- 优雅停止 ----------
function waitForProcessExit(proc, timeout) {
  return new Promise((resolve, reject) => {
    if (!proc) { resolve(); return; }
    // 子进程已退出则立即返回
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('超时')), timeout);
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function forceKill(pid) {
  if (!pid) return;
  logLine(`强制结束 kimi 子进程 (pid=${pid})`);
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}

async function stopKimi() {
  const proc = kimiProc;
  const pid = kimiChildPid;
  // 永久废弃当前 WebSocket 订阅，阻止重连
  wsGeneration++;
  cleanupWsPermanent();

  if (!proc && !pid) return;

  // 尝试优雅关闭：POST /api/v1/shutdown
  if (knownServerBase) {
    logLine(`尝试优雅关闭: POST ${knownServerBase}/api/v1/shutdown`);
    const res = await httpPostShutdown(knownServerBase, knownServerToken);
    if (res) {
      logLine(`关闭请求已发送 (HTTP ${res.status})，等待进程退出`);
      try {
        await waitForProcessExit(proc, 5000);
        logLine('kimi 子进程已优雅退出');
        kimiProc = null;
        kimiChildPid = null;
        return;
      } catch {
        logLine('等待进程退出超时，强制结束');
      }
    } else {
      logLine('关闭请求失败，强制结束');
    }
  }

  forceKill(pid);
  kimiProc = null;
  kimiChildPid = null;
}

// ---------- kimi web 子进程 ----------
const URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[?::1\]?):\d+\/[^\s"'<>)\]]+/;
const ANSI_RE = /\[[0-9;?]*[a-zA-Z]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

function startKimiServer() {
  const cfg = loadConfig();
  const cli = resolveCliPath(cfg);
  urlFound = false;
  knownServerBase = null;
  knownServerToken = null;
  serverGeneration++;
  // 清理旧 WebSocket 连接和重连定时器，递增 generation 使旧回调失效
  wsGeneration++;
  cleanupWsPermanent();
  resetUsageState();
  const gen = serverGeneration;

  if (!cli) {
    logLine('未找到 Kimi Code CLI，进入手动配置页');
    showSetup('cli-not-found');
    return;
  }

  // 多实例检查
  checkMultiInstances();

  // 版本检测决定参数
  const ver = getCliVersion(cli);
  let args;
  if (ver && (ver.semver[0] >= 1 || (ver.semver[0] === 0 && ver.semver[1] >= 28))) {
    args = ['web', '--no-open'];
  } else {
    args = ['web', '--no-open', '--foreground'];
  }
  if (pendingSessionId) {
    args.unshift('--session', pendingSessionId);
    logLine(`使用会话参数: --session ${pendingSessionId}`);
    pendingSessionId = null;
  }
  logLine(`启动 CLI: ${cli} ${args.join(' ')}`);

  let child;
  try {
    const env = buildKimiEnv(cfg);
    child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  } catch (err) {
    logLine(`CLI 启动失败: ${err.message}`);
    showSetup('spawn-failed');
    return;
  }

  kimiProc = child;
  kimiChildPid = child.pid;
  writeJSON(pidFile(), { pid: child.pid, startedAt: Date.now() });

  let buf = '';
  const onData = (chunk) => {
    const text = stripAnsi(chunk.toString('utf8'));
    buf += text;
    text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .forEach((line) => logLine(`kimi: ${line}`));
    if (!urlFound) {
      const m = buf.match(URL_RE);
      if (m) {
        urlFound = true;
        // 日志脱敏：只记录 host:port/path，不含 fragment
        try {
          const logUrl = new URL(m[0]);
          logLine(`发现 Web 地址: ${logUrl.protocol}//${logUrl.host}${logUrl.pathname}`);
        } catch { logLine('发现 Web 地址'); }

        // 通过 URL API 解析端口，支持 localhost/IPv6 等
        let parsedPort = null;
        try {
          const u = new URL(m[0]);
          parsedPort = u.port;
        } catch { /* 降级到原逻辑 */ }
        if (parsedPort) {
          knownServerBase = `http://127.0.0.1:${parsedPort}`;
        }
        knownServerToken = readServerToken();

        let targetUrl = m[0];
        if (knownServerBase && knownServerToken) {
          targetUrl = `${knownServerBase}/#token=${encodeURIComponent(knownServerToken)}`;
          logLine('使用端口+token 组合地址');
        } else {
          logLine(knownServerToken ? '端口解析失败，使用 stdout 完整 URL' : 'token 文件不可用，使用 stdout 完整 URL');
        }

        // 轮询确认服务就绪
        startPolling(targetUrl, knownServerBase, knownServerToken, gen);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => {
    if (gen !== serverGeneration) return;
    logLine(`CLI 进程错误: ${err.message}`);
    if (!urlFound) showSetup('spawn-failed');
  });
  child.on('exit', (code) => {
    if (gen !== serverGeneration) return;
    logLine(`CLI 进程已退出 (code=${code})`);
    // 服务意外停止时不再允许旧订阅持续重连。
    wsGeneration++;
    cleanupWsPermanent();
    kimiProc = null;
    kimiChildPid = null;
    if (!urlFound) showSetup('exit-early');
    else if (!quitting && !stoppingIntentionally) showSetup('server-stopped');
  });

  // 30 秒仍未输出地址则转入手动配置
  setTimeout(() => {
    if (!urlFound && kimiProc) {
      logLine('等待 Web 地址超时，进入手动配置页');
      showSetup('timeout');
    }
  }, 30000);
}

// ---------- 轮询 /openapi.json ----------
function startPolling(targetUrl, base, token, gen) {
  const maxRetries = 15;
  const retryDelay = 1000;
  const totalTimeout = 20000;
  let attempts = 0;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    if (gen !== serverGeneration) return;
    logLine('轮询 /openapi.json 超时，进入手动配置页');
    showSetup('timeout');
  }, totalTimeout);

  const poll = () => {
    if (timedOut || gen !== serverGeneration) {
      clearTimeout(timer);
      return;
    }
    attempts++;
    const checkUrl = base ? `${base}/openapi.json` : (() => {
      try {
        const u = new URL(targetUrl);
        u.hash = '';
        u.search = '';
        u.pathname = '/openapi.json';
        return u.href;
      } catch {
        return targetUrl.replace(/\/[^/]*$/, '/openapi.json');
      }
    })();
    httpGet(checkUrl, token).then((res) => {
      if (timedOut || gen !== serverGeneration) {
        clearTimeout(timer);
        return;
      }
      if (res && res.status === 200) {
        clearTimeout(timer);
        if (sessionLauncherVisible) {
          logLine('服务就绪，但会话启动器当前可见，跳过自动加载');
          return;
        }
        logLine(`服务就绪 (HTTP ${res.status})，加载页面`);
        loadMain(targetUrl);
      } else if (attempts < maxRetries && !timedOut) {
        setTimeout(poll, retryDelay);
      } else {
        clearTimeout(timer);
        logLine(`服务未就绪 (尝试 ${attempts} 次)，进入手动配置页`);
        showSetup('poll-failed');
      }
    });
  };
  poll();
}

// ---------- WebSocket 订阅 ----------
function cleanupWsSoft() {
  // 软清理：关闭 socket 和定时器，清除订阅缓存，保留 wsActiveQuestions 用于重连去重
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (wsDiscoveryTimer) {
    clearTimeout(wsDiscoveryTimer);
    wsDiscoveryTimer = null;
  }
  if (wsClient) {
    try {
      wsClient.removeAllListeners();
      wsClient.close();
    } catch { /* ignore */ }
    wsClient = null;
  }
  wsSubscribedSessions.clear();
  // wsActiveQuestions 保持不变，防止重连后服务器回放重复触发
}

function cleanupWsPermanent() {
  // 永久清理：除软清理外，释放所有活跃问题
  cleanupWsSoft();
  for (const [qid, q] of wsActiveQuestions) {
    if (!q.resolved) { q.resolved = true; }
  }
  wsActiveQuestions.clear();
  // 关闭问答窗口
  if (questionWindow && !questionWindow.isDestroyed()) {
    try { questionWindow.close(); } catch { /* ignore */ }
  }
  questionWindow = null;
  questionWindowQuestionId = null;
  // 待处理计数随订阅一并失效
  usageState.pendingApprovals = 0;
  usageState.pendingQuestions = 0;
  scheduleTrayStatus();
}

function wsNextId() {
  return ++wsMessageId;
}

function wsSendIfOpen(gen, msg) {
  if (gen !== wsGeneration) return false;
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    try {
      wsClient.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      logLine(`WebSocket 发送失败: ${err.message}`);
    }
  }
  return false;
}

function wsHello(gen) {
  return wsSendIfOpen(gen, {
    type: 'client_hello',
    id: String(wsNextId()),
    payload: {
      client_id: wsClientId,
      subscriptions: [],
    },
  });
}

function wsSubscribe(gen, sessionIds) {
  if (!sessionIds || sessionIds.length === 0) return false;
  return wsSendIfOpen(gen, {
    type: 'subscribe',
    id: String(wsNextId()),
    payload: { session_ids: sessionIds },
  });
}

function refreshSubscriptions(gen) {
  if (gen !== wsGeneration) return;
  if (wsDiscoveryTimer) {
    clearTimeout(wsDiscoveryTimer);
    wsDiscoveryTimer = null;
  }
  try {
    const allSessions = getAllSessions();
    // 过滤出尚未订阅的 session ID
    const newIds = allSessions
      .map((s) => s.sessionId)
      .filter((id) => id && !wsSubscribedSessions.has(id));
    if (newIds.length > 0 && wsSubscribe(gen, newIds)) {
      for (const id of newIds) {
        wsSubscribedSessions.add(id);
      }
      logLine(`已订阅 ${newIds.length} 个新会话`);
    }
  } catch (err) {
    logLine(`刷新订阅失败: ${err.message}`);
  }
  // 每 30 秒检查一次新会话
  wsDiscoveryTimer = setTimeout(() => refreshSubscriptions(gen), 30000);
}

function scheduleWsReconnect(gen) {
  if (gen !== wsGeneration) return;
  if (stoppingIntentionally || quitting) return;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  wsReconnectTimer = setTimeout(() => {
    if (gen === wsGeneration && !stoppingIntentionally && !quitting) {
      startWsSubscription();
    }
  }, 5000);
}

function httpPostAnswer(base, token, sessionId, questionId, answers) {
  if (!base || !token || !sessionId || !questionId ||
      !answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const url = new URL(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`,
      base,
    );
    const body = JSON.stringify({ answers, method: 'click' });
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: 5000,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', (err) => {
      logLine(`回答提交请求失败: ${err.message}`);
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function isAnswerSuccess(res) {
  if (!res) return false;
  if (res.status < 200 || res.status >= 300) return false;
  try {
    const env = JSON.parse(res.data);
    // envelope code 为 0 或未提供 code 视为成功
    if (env.code === undefined || env.code === 0) return true;
  } catch {
    // 非 JSON 响应，仅以 HTTP 状态判定
    return true;
  }
  return false;
}

function handleQuestionRequested(sessionId, payload, gen) {
  // 校验 payload 格式
  if (!sessionId || typeof sessionId !== 'string' || !payload || !payload.question_id ||
      !payload.questions || !Array.isArray(payload.questions)) {
    // 格式不合法，无 question_id 无法去重，回退到通知+聚焦 Web UI
    showDesktopNotification('问题请求', '收到新的问题请求');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    return;
  }

  const questionId = payload.question_id;

  // 去重：已处理过的 question_id 忽略
  if (wsActiveQuestions.has(questionId)) {
    return;
  }

  // 立即缓存，防止重连回放重复触发
  wsActiveQuestions.set(questionId, { session_id: sessionId, resolved: false });
  bumpPendingQuestions(1);

  // 窗口已聚焦时回退到 Web UI（已缓存，不释放）
  if (mainWindowFocused) {
    logLine(`主窗口聚焦，问答请求回退 Web UI: question_id=${questionId}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.flashFrame(false);
    }
    return;
  }

  // 合法 payload 一律走问答窗口（单题/多题/多选/自定义/纯文本均可）
  createQuestionWindow(sessionId, payload, gen);
}

function bumpPendingQuestions(delta) {
  usageState.pendingQuestions = Math.max(0, usageState.pendingQuestions + delta);
  scheduleTrayStatus();
}

// 仅恰一题、非多选、不允许自定义且有可选项时，返回可用原生对话框展示的题目
function getSimpleDialogQuestion(payload) {
  const questions = payload && Array.isArray(payload.questions) ? payload.questions : [];
  if (questions.length !== 1) return null;
  const q = questions[0];
  if (!q || !q.id || !q.question || !Array.isArray(q.options) || q.options.length === 0) return null;
  if (q.multi_select || q.allow_other) return null;
  return q;
}

// 问答窗口不可用时的回退：单题单选走原生对话框，复杂 payload 通知+聚焦主窗口
function fallbackQuestionWindowFailure(sessionId, payload, gen) {
  const q = getSimpleDialogQuestion(payload);
  if (q) {
    showQuestionDialogFallback(sessionId, payload.question_id, q, gen);
    return;
  }
  showDesktopNotification('问题请求', '收到新的问题，请在 Kimi 中查看');
  focusMainWindow();
}

// ---------- 问答窗口 ----------
function createQuestionWindow(sessionId, payload, gen) {
  const questionId = payload.question_id;
  // 同一时刻仅一个问答窗口：已打开时新问题走通知+聚焦回退（缓存保留，Web UI 可答）
  if (questionWindow && !questionWindow.isDestroyed()) {
    showDesktopNotification('问题请求', '收到新的问题，请在 Kimi 中查看');
    focusMainWindow();
    return;
  }

  let win = null;
  try {
    win = new BrowserWindow({
      width: 560,
      height: 720,
      minWidth: 420,
      minHeight: 480,
      resizable: true,
      title: 'Kimi 的提问',
      backgroundColor: '#0e0e10',
      autoHideMenuBar: true,
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'question-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
  } catch (err) {
    logLine(`问答窗口创建失败: ${err.message}`);
    fallbackQuestionWindowFailure(sessionId, payload, gen);
    return;
  }

  questionWindow = win;
  questionWindowQuestionId = questionId;
  logLine(`打开问答窗口: question_id=${questionId}`);

  win.on('closed', () => {
    if (questionWindow === win) {
      questionWindow = null;
      questionWindowQuestionId = null;
    }
  });
  win.webContents.on('did-finish-load', () => {
    if (gen !== wsGeneration || win.isDestroyed()) return;
    try {
      win.webContents.send('question:init', {
        question_id: questionId,
        session_id: sessionId,
        questions: payload.questions,
      });
    } catch { /* ignore */ }
  });
  win.loadFile(path.join(__dirname, 'question.html')).catch((err) => {
    logLine(`问答窗口加载失败: ${err.message}`);
    if (!win.isDestroyed()) win.close();
    // 仅在问题仍未处理时回退（用户可能已手动关窗）
    const qs = wsActiveQuestions.get(questionId);
    if (qs && !qs.resolved) fallbackQuestionWindowFailure(sessionId, payload, gen);
  });
}

// 原生对话框回退：仅在问答窗口创建/加载失败且为单题单选时使用
function showQuestionDialogFallback(sessionId, questionId, q, gen) {
  // 构建对话框选项
  const dialogOptions = q.options.map((opt) => ({
    id: opt.id,
    label: (opt.label || '').slice(0, 80),
    description: (opt.description || '').slice(0, 120),
  }));

  // 构建 dialog buttons: 选项 + "在 Kimi 中回答"回退
  const buttons = dialogOptions.map((opt) => opt.label);
  // 如果按钮文本过长，截断
  const truncatedButtons = buttons.map((b) => b.length > 80 ? b.slice(0, 77) + '...' : b);
  truncatedButtons.push('在 Kimi 中回答');

  // 构建消息文本
  const header = (q.header || '').slice(0, 200);
  const body = (q.body || '').slice(0, 500);
  const questionText = (q.question || '').slice(0, 300);
  let message = questionText;
  if (header) message = header + '\n\n' + message;
  if (body) message = message + '\n\n' + body;

  // 截断总消息长度
  if (message.length > 2000) {
    message = message.slice(0, 1997) + '...';
  }

  logLine(`显示问答对话框: question_id=${questionId}, options=${dialogOptions.length}`);

  dialog.showMessageBox({
    type: 'question',
    buttons: truncatedButtons,
    defaultId: -1, // 无默认选中
    cancelId: truncatedButtons.length - 1, // 最后一个按钮（回退）作为取消
    title: 'Kimi Code 提问',
    message: '请选择一个选项',
    detail: message,
    noLink: true,
  }).then((result) => {
    if (gen !== wsGeneration) {
      // 旧 generation 释放
      wsActiveQuestions.delete(questionId);
      return;
    }
    const qState = wsActiveQuestions.get(questionId);
    if (!qState || qState.resolved) return;

    const responseIndex = result.response;
    const isFallback = responseIndex === truncatedButtons.length - 1 || result.response === -1;

    if (isFallback) {
      // 回退/取消：聚焦主窗口，不提交答案
      qState.resolved = true;
      wsActiveQuestions.delete(questionId);
      bumpPendingQuestions(-1);
      logLine(`问答已取消/回退: question_id=${questionId}`);
      focusMainWindow();
      return;
    }

    // 选择某个选项
    const selectedOption = dialogOptions[responseIndex];
    if (!selectedOption) {
      qState.resolved = true;
      wsActiveQuestions.delete(questionId);
      bumpPendingQuestions(-1);
      return;
    }

    logLine(`提交回答: question_id=${questionId}, option_id=${selectedOption.id}`);

    // 提交答案
    httpPostAnswer(knownServerBase, knownServerToken, sessionId, questionId,
      { [q.id]: { kind: 'single', option_id: selectedOption.id } })
      .then((res) => {
        if (gen !== wsGeneration) return;
        const qs = wsActiveQuestions.get(questionId);
        if (!qs || qs.resolved) return;
        qs.resolved = true;
        wsActiveQuestions.delete(questionId);
        bumpPendingQuestions(-1);
        if (isAnswerSuccess(res)) {
          logLine(`回答提交成功: question_id=${questionId}`);
        } else {
          logLine(`回答提交失败: question_id=${questionId}, status=${res ? res.status : '网络错误'}`);
        }
      })
      .catch((err) => {
        // 网络/API 失败只记录脱敏日志，不能使进程崩溃
        logLine(`回答提交异常: ${err.message}`);
        if (wsActiveQuestions.has(questionId)) {
          const qs = wsActiveQuestions.get(questionId);
          if (qs) qs.resolved = true;
          wsActiveQuestions.delete(questionId);
          bumpPendingQuestions(-1);
        }
      });
  }).catch((err) => {
    // dialog 异常时释放
    logLine(`问答对话框异常: ${err.message}`);
    if (wsActiveQuestions.has(questionId)) {
      const qs = wsActiveQuestions.get(questionId);
      if (qs) qs.resolved = true;
      wsActiveQuestions.delete(questionId);
      bumpPendingQuestions(-1);
    }
  });
}

// ---------- 问答窗口 IPC ----------
ipcMain.handle('question:submit', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const questionId = typeof p.question_id === 'string' ? p.question_id : '';
  const sessionId = typeof p.session_id === 'string' ? p.session_id : '';
  const answers = p.answers;
  if (!questionId || !sessionId || !answers || typeof answers !== 'object' ||
      Array.isArray(answers) || Object.keys(answers).length === 0) {
    return { ok: false, message: '提交数据不完整' };
  }
  if (!knownServerBase || !knownServerToken) {
    return { ok: false, message: '服务未连接' };
  }
  const gen = wsGeneration;
  logLine(`问答窗口提交: question_id=${questionId}, items=${Object.keys(answers).length}`);
  let res = null;
  try {
    res = await httpPostAnswer(knownServerBase, knownServerToken, sessionId, questionId, answers);
  } catch (err) {
    logLine(`问答提交异常: ${err.message}`);
    return { ok: false, message: '提交请求异常' };
  }
  if (!isAnswerSuccess(res)) {
    const status = res ? `HTTP ${res.status}` : '网络错误';
    logLine(`问答提交失败: question_id=${questionId}, status=${status}`);
    return { ok: false, message: `提交失败（${status}）` };
  }
  logLine(`问答提交成功: question_id=${questionId}`);
  const qs = wsActiveQuestions.get(questionId);
  if (qs) qs.resolved = true;
  if (wsActiveQuestions.delete(questionId)) bumpPendingQuestions(-1);
  // 窗口已展示完成态，不再接收该题的 dismiss 通知
  if (questionWindowQuestionId === questionId) questionWindowQuestionId = null;
  // 延时关窗，让渲染层显示提交成功提示
  const win = questionWindow;
  setTimeout(() => {
    if (gen !== wsGeneration) return;
    if (win && questionWindow === win && !win.isDestroyed()) win.close();
  }, 1500);
  return { ok: true };
});

ipcMain.handle('question:fallback', (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const questionId = typeof p.question_id === 'string' ? p.question_id : '';
  logLine(`问答回退 Web UI: question_id=${questionId}`);
  // 回退到 Web UI 回答：释放本地状态、聚焦主窗口、关窗
  if (questionId) {
    const qs = wsActiveQuestions.get(questionId);
    if (qs) qs.resolved = true;
    if (wsActiveQuestions.delete(questionId)) bumpPendingQuestions(-1);
  }
  focusMainWindow();
  if (questionWindow && !questionWindow.isDestroyed()) questionWindow.close();
  return { ok: true };
});

ipcMain.handle('question:cancel', (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const questionId = typeof p.question_id === 'string' ? p.question_id : '';
  logLine(`问答取消: question_id=${questionId}`);
  // 取消：关窗并释放缓存，服务器重放可再次触发
  if (questionId && wsActiveQuestions.delete(questionId)) bumpPendingQuestions(-1);
  if (questionWindow && !questionWindow.isDestroyed()) questionWindow.close();
  return { ok: true };
});

function focusMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.flashFrame(false);
  }
}

function startWsSubscription() {
  if (!knownServerBase || !knownServerToken) return;
  cleanupWsSoft();
  wsGeneration++;
  const gen = wsGeneration;
  const wsUrl = knownServerBase.replace(/^http:/, 'ws:') + '/api/v1/ws';
  logLine('WebSocket 订阅已启动');

  try {
    wsClient = new WebSocket(wsUrl, [`kimi-code.bearer.${knownServerToken}`], {
      headers: { 'Authorization': `Bearer ${knownServerToken}` },
      followRedirects: true,
    });
  } catch (err) {
    logLine(`WebSocket 连接失败: ${err.message}`);
    wsClient = null;
    return;
  }

  wsClient.on('open', () => {
    if (gen !== wsGeneration) { cleanupWsSoft(); return; }
    logLine('WebSocket 已连接');
    // 发送 client_hello
    wsHello(gen);
    // 立即订阅已知会话
    try {
      const allSessions = getAllSessions();
      const ids = allSessions.map((s) => s.sessionId).filter(Boolean);
      if (ids.length > 0) {
        wsSubscribe(gen, ids);
        for (const id of ids) {
          wsSubscribedSessions.add(id);
        }
        logLine(`已订阅 ${ids.length} 个会话`);
      }
    } catch (err) {
      logLine(`初始订阅失败: ${err.message}`);
    }
    // 启动低频发现 timer
    if (wsDiscoveryTimer) {
      clearTimeout(wsDiscoveryTimer);
      wsDiscoveryTimer = null;
    }
    wsDiscoveryTimer = setTimeout(() => refreshSubscriptions(gen), 30000);
  });

  wsClient.on('message', (data) => {
    if (gen !== wsGeneration) return;
    try {
      const raw = JSON.parse(data.toString('utf8'));
      // 容错解析 event envelope
      const event = raw && (raw.event || raw.type);
      if (!event) return;

      // 处理审批请求 — 保持为通知，不自动审批
      if (event === 'event.approval.requested' || event === 'approval.requested') {
        usageState.pendingApprovals++;
        scheduleTrayStatus();
        if (mainWindowFocused) return;
        showDesktopNotification('审批请求', '有新的审批请求等待处理');
        return;
      }

      // 审批已处理/已过期（若服务器下发此类事件）
      if (event === 'event.approval.resolved' || event === 'approval.resolved' ||
          event === 'event.approval.expired' || event === 'approval.expired') {
        usageState.pendingApprovals = Math.max(0, usageState.pendingApprovals - 1);
        scheduleTrayStatus();
        return;
      }

      // 会话用量更新
      if (event === 'event.session.usage_updated' || event === 'session.usage_updated') {
        const payload = raw.payload || raw.data || {};
        const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : payload;
        const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
        let total = num(usage.total_tokens != null ? usage.total_tokens : usage.totalTokens);
        if (!total) total = num(usage.input_tokens) + num(usage.output_tokens);
        usageState.totalTokens = total;
        usageState.contextUsed = num(usage.context_used);
        usageState.contextLimit = num(usage.context_limit);
        scheduleTrayStatus();
        return;
      }

      // 任务开始/进度
      if (event === 'event.task.started' || event === 'task.started') {
        const payload = raw.payload || raw.data || {};
        usageState.runningTasks++;
        if (typeof payload.title === 'string' && payload.title) usageState.lastTaskTitle = payload.title;
        scheduleTrayStatus();
        return;
      }
      if (event === 'event.task.progress' || event === 'task.progress') {
        const payload = raw.payload || raw.data || {};
        if (typeof payload.title === 'string' && payload.title) usageState.lastTaskTitle = payload.title;
        scheduleTrayStatus();
        return;
      }

      // 处理问答请求
      if (event === 'event.question.requested' || event === 'question.requested') {
        const payload = raw.payload || raw.data || {};
        const sessionId = raw.session_id || raw.sessionId || payload.session_id || '';
        handleQuestionRequested(sessionId, payload, gen);
        return;
      }

      // 处理问题已应答/已关闭事件，释放本地状态
      if (event === 'event.question.answered' || event === 'question.answered' ||
          event === 'event.question.dismissed' || event === 'question.dismissed') {
        const payload = raw.payload || raw.data || {};
        const qid = payload.question_id || raw.question_id || '';
        if (qid && wsActiveQuestions.has(qid)) {
          const qs = wsActiveQuestions.get(qid);
          if (qs) qs.resolved = true;
          wsActiveQuestions.delete(qid);
          bumpPendingQuestions(-1);
          logLine(`问题已释放: question_id=${qid}`);
        }
        // 问答窗口正在展示该问题时，通知渲染层并延时关窗
        if (qid && questionWindowQuestionId === qid && questionWindow && !questionWindow.isDestroyed()) {
          const reason = event.indexOf('answered') >= 0 ? 'answered' : 'dismissed';
          try { questionWindow.webContents.send('question:dismiss', { reason }); } catch { /* ignore */ }
          const win = questionWindow;
          setTimeout(() => {
            if (gen !== wsGeneration) return;
            if (questionWindow === win && !win.isDestroyed()) win.close();
          }, 2500);
        }
        return;
      }

      // 处理任务完成类事件（仅精确匹配完成事件，不匹配 usage_updated/started/progress/任意 task.*）
      const completionEvents = [
        'event.task.completed', 'task.completed', 'task.done',
        'event.session.completed', 'session.completed',
        'SubagentStop', 'event.subagent_stop',
      ];
      if (completionEvents.includes(event)) {
        if (event === 'event.task.completed' || event === 'task.completed') {
          usageState.runningTasks = Math.max(0, usageState.runningTasks - 1);
          scheduleTrayStatus();
        }
        if (mainWindowFocused) return;
        showDesktopNotification('任务完成', '任务已完成');
        return;
      }
    } catch {
      // 解析失败静默忽略
    }
  });

  wsClient.on('error', (err) => {
    if (gen !== wsGeneration) return;
    // 日志不泄露 token 或 URL
    logLine(`WebSocket 错误: ${err.message}`);
    cleanupWsSoft();
    scheduleWsReconnect(gen);
  });

  wsClient.on('close', (code, reason) => {
    if (gen !== wsGeneration) return;
    logLine(`WebSocket 连接关闭 (code=${code})`);
    cleanupWsSoft();
    scheduleWsReconnect(gen);
  });
}

function showDesktopNotification(title, body) {
  try {
    const notif = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') });
    notif.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        // 取消任务栏闪烁
        mainWindow.flashFrame(false);
      }
    });
    notif.show();
    // 通知闪烁前重新确认窗口未聚焦（窗口可能在消息到达后被聚焦）
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindowFocused) {
      mainWindow.flashFrame(true);
    }
  } catch { /* Electron Notification 不可用时静默 */ }
}

// ---------- 页面加载 ----------
function loadMain(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sessionLauncherVisible = false; // 显式加载 Web UI 时清除启动器可见状态
  loadedUrl = url;
  mainWindow.loadURL(url).catch((err) => {
    logLine(`加载页面失败: ${err.message}`);
    showSetup('load-failed');
  });
  // 启动 WebSocket 订阅
  startWsSubscription();
}

function showSetup(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sessionLauncherVisible = false; // 从会话启动器进入设置后，确保 startPolling 能加载页面
  mainWindow.loadFile(path.join(__dirname, 'setup.html'), { query: { reason: reason || '' } });
}

// ---------- 会话启动器 ----------
function showSessionLauncher() {
  sessionLauncherVisible = true;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    // 不启动 server，用户将在启动器中选取会话恢复
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.loadFile(path.join(__dirname, 'sessions.html')).catch((err) => {
    logLine(`加载 sessions.html 失败: ${err.message}`);
  });
}

// ---------- 重启 ----------
async function restartServer() {
  if (restartPromise) return restartPromise;
  restartPromise = (async () => {
    stoppingIntentionally = true;
    // 在停止前递增 generation，使旧进程回调失效
    serverGeneration++;
    await stopKimi();
    stoppingIntentionally = false;
    loadedUrl = null;
    urlFound = false;
    knownServerBase = null;
    knownServerToken = null;
    sessionLauncherVisible = false; // 开始新重启时清除启动器可见状态，确保 startPolling 能加载页面
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(path.join(__dirname, 'loading.html'));
    }
    startKimiServer();
  })();
  restartPromise.then(() => { restartPromise = null; }, () => { restartPromise = null; });
  return restartPromise;
}

// ---------- 系统托盘 ----------
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    startKimiServer();
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  mainWindowFocused = false;
  if (!trayHintShown && tray) {
    trayHintShown = true;
    try {
      tray.displayBalloon({
        title: APP_NAME,
        content: '已最小化到系统托盘。单击图标恢复窗口，双击图标秒开新会话。',
        icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')),
      });
    } catch { /* ignore */ }
  }
}

function buildTrayMenu(statusLabel) {
  const template = [];
  // 顶部状态项（仅展示，不可点击）
  if (statusLabel) {
    template.push({ label: statusLabel, enabled: false }, { type: 'separator' });
  }
  template.push(
    { label: '显示主窗口', click: showMainWindow },
    { label: '打开会话启动器', click: showSessionLauncher },
    { label: '新建 Web 会话', click: () => { showMainWindow(); restartServer(); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  );
  return Menu.buildFromTemplate(template);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu(''));
  tray.on('click', showMainWindow);
  tray.on('double-click', () => { showMainWindow(); restartServer(); });
}

// ---------- 托盘用量/进度状态 ----------
let trayStatusTimer = null;
let trayStatusLastKey = '';

function resetUsageState() {
  usageState.totalTokens = 0;
  usageState.contextUsed = 0;
  usageState.contextLimit = 0;
  usageState.runningTasks = 0;
  usageState.lastTaskTitle = '';
  usageState.pendingApprovals = 0;
  usageState.pendingQuestions = 0;
  scheduleTrayStatus();
}

function formatTokenCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// 防抖刷新托盘 tooltip 与菜单
function scheduleTrayStatus() {
  if (trayStatusTimer) clearTimeout(trayStatusTimer);
  trayStatusTimer = setTimeout(updateTrayStatus, 500);
}

function updateTrayStatus() {
  trayStatusTimer = null;
  if (!tray) return;
  try {
    const lines = [APP_NAME];
    const usageParts = [];
    if (usageState.totalTokens > 0) usageParts.push(`用量 ${formatTokenCount(usageState.totalTokens)} tokens`);
    if (usageState.contextUsed > 0 && usageState.contextLimit > 0) {
      usageParts.push(`上下文 ${Math.round((usageState.contextUsed / usageState.contextLimit) * 100)}%`);
    }
    if (usageParts.length > 0) lines.push(usageParts.join(' · '));
    const taskParts = [];
    if (usageState.runningTasks > 0) taskParts.push(`任务 ${usageState.runningTasks} 运行中`);
    if (usageState.pendingApprovals > 0) taskParts.push(`审批 ${usageState.pendingApprovals}`);
    if (usageState.pendingQuestions > 0) taskParts.push(`问答 ${usageState.pendingQuestions}`);
    if (taskParts.length > 0) lines.push(taskParts.join(' · '));
    let tooltip = lines.join('\n');
    if (tooltip.length > 120) tooltip = tooltip.slice(0, 117) + '...';
    let statusLabel = lines.length > 1 ? lines.slice(1).join(' | ') : '';
    if (statusLabel.length > 100) statusLabel = statusLabel.slice(0, 97) + '...';
    tray.setToolTip(tooltip);
    tray.setContextMenu(buildTrayMenu(statusLabel));
    const statusKey = lines.join('\n');
    if (statusKey !== trayStatusLastKey) {
      trayStatusLastKey = statusKey;
      logLine(`托盘状态: ${lines.join(' / ')}`);
    }
  } catch (err) {
    logLine(`托盘状态更新失败: ${err.message}`);
  }
}

// ---------- 窗口 ----------
function createWindow() {
  const state = readJSON(stateFile(), {});
  mainWindow = new BrowserWindow({
    width: state.width || 1440,
    height: state.height || 900,
    x: state.x,
    y: state.y,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      partition: 'persist:kimi-code',
    },
  });
  if (state.maximized) mainWindow.maximize();

  const saveWindowState = () => {
    if (!mainWindow) return;
    const maximized = mainWindow.isMaximized();
    const b = maximized ? readJSON(stateFile(), {}) : mainWindow.getBounds();
    writeJSON(stateFile(), { x: b.x, y: b.y, width: b.width, height: b.height, maximized });
  };

  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    saveWindowState();
    hideToTray();
  });

  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      saveWindowState();
      hideToTray();
      return;
    }
    saveWindowState();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 窗口聚焦状态跟踪
  mainWindow.on('focus', () => { mainWindowFocused = true; });
  mainWindow.on('blur', () => { mainWindowFocused = false; });

  // 强化导航：同源 Kimi 本地服务保留，其他 http(s) 交默认浏览器，未知协议拒绝
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      // 同源 Kimi 本地服务放行
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const isLocalhost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
        if (isLocalhost && knownServerBase) {
          const knownPort = new URL(knownServerBase).port;
          if (parsed.port === knownPort) {
            return { action: 'allow' };
          }
        }
        // 其他 http(s) 在默认浏览器打开
        shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
      }
      // mailto/tel 交给外部系统
      if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') {
        shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
      }
      // open-in 协议（IDE 等）交给外部应用
      if (OPEN_IN_PROTOCOLS.has(parsed.protocol)) {
        shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
      }
      // 未知自定义协议拒绝并记录
      logLine(`拒绝未知协议导航: ${parsed.protocol}//${parsed.hostname}`);
      return { action: 'deny' };
    } catch {
      return { action: 'deny' };
    }
  });
  // 拦截 WebView 内跨源导航
  mainWindow.webContents.on('will-navigate', (e, url) => {
    try {
      const parsed = new URL(url);
      // 同源 Kimi 本地服务保留
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const isLocalhost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
        if (isLocalhost && knownServerBase) {
          const knownPort = new URL(knownServerBase).port;
          if (parsed.port === knownPort) return; // 放行
        }
        // 其他 http(s) 阻止并打开默认浏览器
        e.preventDefault();
        shell.openExternal(url).catch(() => {});
        return;
      }
      // mailto/tel 放行外部系统
      if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') {
        e.preventDefault();
        shell.openExternal(url).catch(() => {});
        return;
      }
      // open-in 协议（IDE 等）交给外部应用
      if (OPEN_IN_PROTOCOLS.has(parsed.protocol)) {
        e.preventDefault();
        shell.openExternal(url).catch(() => {});
        return;
      }
      // 未知自定义协议拒绝并记录
      e.preventDefault();
      logLine(`拒绝导航至未知协议: ${parsed.protocol}//${parsed.hostname}`);
    } catch {
      e.preventDefault();
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
}

// ---------- 全局热键 ----------
function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    startKimiServer();
    return;
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.flashFrame(false);
  }
}

function registerGlobalShortcut() {
  try {
    const registered = globalShortcut.register('Ctrl+Shift+Space', toggleMainWindow);
    if (!registered) {
      logLine('全局热键 Ctrl+Shift+Space 注册失败');
    } else {
      logLine('全局热键 Ctrl+Shift+Space 已注册');
    }
  } catch (err) {
    logLine(`全局热键注册异常: ${err.message}`);
  }
}

function unregisterGlobalShortcut() {
  try {
    globalShortcut.unregister('Ctrl+Shift+Space');
  } catch { /* ignore */ }
}

// ---------- 菜单 ----------
function buildMenu() {
  const template = [
    {
      label: '会话',
      submenu: [
        { label: '打开会话启动器', accelerator: 'CmdOrCtrl+Shift+S', click: showSessionLauncher },
        { type: 'separator' },
        { label: '新建 Web 会话', accelerator: 'CmdOrCtrl+Shift+N', click: () => { restartServer(); } },
        { label: '手动输入地址…', accelerator: 'CmdOrCtrl+L', click: () => showSetup('manual') },
        { type: 'separator' },
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '显示/隐藏窗口', accelerator: 'CmdOrCtrl+Shift+Space',
          click: toggleMainWindow,
        },
        { type: 'separator' },
        {
          label: '窗口置顶', type: 'checkbox', accelerator: 'CmdOrCtrl+T',
          click: (item) => mainWindow && mainWindow.setAlwaysOnTop(item.checked),
        },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '重置缩放' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开数据目录(日志/配置)', click: () => shell.openPath(userDataDir()) },
        { label: '运行 kimi doctor', click: () => {
          runKimiDoctor().then((result) => {
            const title = result.ok ? '诊断完成' : '诊断失败';
            const detail = result.ok
              ? `kimi doctor 诊断通过。\n\n输出：\n${result.output}`
              : `${result.error}\n\n输出：\n${result.output}`;
            dialog.showMessageBox({ type: result.ok ? 'info' : 'error', title, message: title, detail });
          });
        } },
        {
          label: '关于',
          click: () => {
            const cfg = loadConfig();
            const cli = resolveCliPath(cfg);
            const ver = cli ? getCliVersion(cli) : null;
            const cliVerStr = ver ? ver.version : (cli ? '未知' : '未安装');
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: APP_NAME,
              detail: `版本 ${app.getVersion()}\nCLI 版本: ${cliVerStr}\nKimi Code 网页版的桌面套壳。\n自动启动 kimi web 并嵌入窗口，登录状态持久保存。`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
ipcMain.handle('app:info', () => {
  const cfg = loadConfig();
  const cli = resolveCliPath(cfg);
  const cliVer = cli ? getCliVersion(cli) : null;
  return {
    version: app.getVersion(),
    cliVersion: cliVer ? cliVer.version : (cli ? '' : null),
    platform: process.platform,
    defaultCli: defaultCliCandidates()[0],
    cliFound: !!cli,
    loginStatus: getLoginStatus(),
    gitBash: (() => {
      const p = detectGitBash();
      return { path: p || '', detected: !!p };
    })(),
    config: {
      mode: cfg.mode,
      cliPath: cfg.cliPath,
      manualUrl: cfg.manualUrl,
      shellPath: cfg.shellPath || '',
      httpProxy: cfg.httpProxy || '',
      httpsProxy: cfg.httpsProxy || '',
      allProxy: cfg.allProxy || '',
      noProxy: cfg.noProxy || '',
    },
    loadedUrl,
    isDev,
  };
});

ipcMain.handle('setup:save', async (_e, payload) => {
  const p = payload || {};
  const cfg = {
    mode: p.mode === 'manual' ? 'manual' : 'auto',
    cliPath: ensureString(p.cliPath),
    manualUrl: ensureString(p.manualUrl),
    shellPath: ensureString(p.shellPath),
    httpProxy: ensureString(p.httpProxy),
    httpsProxy: ensureString(p.httpsProxy),
    allProxy: ensureString(p.allProxy),
    noProxy: ensureString(p.noProxy),
  };
  writeJSON(configFile(), cfg);
  logLine(`配置已保存: mode=${cfg.mode}`);
  if (cfg.mode === 'manual' && cfg.manualUrl) {
    stoppingIntentionally = true;
    await stopKimi();
    stoppingIntentionally = false;
    loadMain(cfg.manualUrl);
  } else {
    await restartServer();
  }
  return true;
});

ipcMain.handle('app:showSetup', () => { showSetup('manual'); return true; });
ipcMain.handle('app:restart', async () => { await restartServer(); return true; });

ipcMain.handle('dialog:pickCli', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择 kimi.exe',
    properties: ['openFile'],
    filters: [{ name: 'Kimi Code CLI', extensions: ['exe'] }],
  });
  return r.canceled ? '' : r.filePaths[0];
});

ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择安装目录',
    defaultPath: path.join(os.homedir(), '.kimi-code'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? '' : r.filePaths[0];
});

ipcMain.handle('dialog:pickShell', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择 bash.exe',
    properties: ['openFile'],
    filters: [{ name: 'Bash', extensions: ['exe'] }],
  });
  return r.canceled ? '' : r.filePaths[0];
});

// ---------- 登录状态 ----------
let activeLoginProc = null;

ipcMain.handle('auth:login', async () => {
  if (activeLoginProc) {
    return { ok: false, error: '已有登录进程正在运行' };
  }
  const cfg = loadConfig();
  const cli = resolveCliPath(cfg);
  if (!cli) {
    return { ok: false, error: '未找到 kimi CLI' };
  }
  return new Promise((resolve) => {
    let resolved = false;
    let child;
    try {
      child = spawn(cli, ['login'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: buildKimiEnv(cfg) });
    } catch (err) {
      logLine(`启动登录进程失败: ${err.message}`);
      return resolve({ ok: false, error: err.message });
    }
    activeLoginProc = child;
    let urlOpened = false;
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((line) => {
        logLine(`login: ${line}`);
        // 向渲染层发送脱敏后的日志行，不泄露完整 URL 或 token
        const sanitizedLine = sanitizeLog(line);
        if (mainWindow && !mainWindow.isDestroyed()) {
          try { mainWindow.webContents.send('auth:loginLog', sanitizedLine); } catch { /* ignore */ }
        }
        // 首次提取 http(s) URL 后打开浏览器（使用原始行中的完整 URL）
        if (!urlOpened) {
          const urlMatch = line.match(/https?:\/\/[^\s"'<>)\]]+/);
          if (urlMatch) {
            urlOpened = true;
            shell.openExternal(urlMatch[0]);
          }
        }
      });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      activeLoginProc = null;
      const loginStatus = getLoginStatus();
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('auth:loginComplete', { ok: false, error: err.message, loginStatus }); } catch { /* ignore */ }
      }
      resolve({ ok: false, error: err.message });
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      activeLoginProc = null;
      const loginStatus = getLoginStatus();
      const ok = code === 0;
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('auth:loginComplete', { ok, error: ok ? undefined : `登录进程退出码 ${code}`, loginStatus }); } catch { /* ignore */ }
      }
      resolve({ ok, error: ok ? undefined : `登录进程退出码 ${code}` });
    });
  });
});

ipcMain.handle('auth:logout', async () => {
  const credentialsDir = path.join(getKimiHomeDir(), 'credentials');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['取消', '确认退出'],
    defaultId: 0,
    cancelId: 0,
    title: '退出登录',
    message: '确定要退出登录吗？这将删除所有已保存的登录凭据。',
  });
  if (result.response !== 1) {
    return { cancelled: true };
  }
  try {
    if (fs.existsSync(credentialsDir)) {
      fs.rmSync(credentialsDir, { recursive: true, force: true });
    }
    logLine('已退出登录，凭据已删除');
    return { ok: true, loginStatus: getLoginStatus() };
  } catch (err) {
    logLine(`退出登录失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ---------- kimi doctor ----------
function runKimiDoctor() {
  const cfg = loadConfig();
  const cli = resolveCliPath(cfg);
  if (!cli) {
    return Promise.resolve({ ok: false, error: '未找到 kimi CLI', output: '' });
  }
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 64 * 1024; // 64KiB
    let child;
    try {
      child = spawn(cli, ['doctor'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: buildKimiEnv(cfg) });
    } catch (err) {
      logLine(`启动 kimi doctor 失败: ${err.message}`);
      return resolve({ ok: false, error: err.message, output: '' });
    }
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        forceKill(child.pid);
        logLine('kimi doctor 超时');
        resolve({ ok: false, error: '诊断超时（20 秒）', output: sanitizeLog(stdout.slice(0, MAX_OUTPUT)) });
      }
    }, 20000);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk.toString('utf8');
      }
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      logLine(`kimi doctor 进程错误: ${err.message}`);
      resolve({ ok: false, error: err.message, output: sanitizeLog(stdout.slice(0, MAX_OUTPUT)) });
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const output = sanitizeLog((stdout + stderr).slice(0, MAX_OUTPUT));
      if (code === 0) {
        resolve({ ok: true, output });
      } else {
        resolve({ ok: false, error: `kimi doctor 退出码 ${code}`, output });
      }
    });
  });
}

ipcMain.handle('cli:doctor', async () => {
  return runKimiDoctor();
});

ipcMain.handle('cli:install', (_e, installDir) => {
  const dir = (installDir || '').trim() || path.join(os.homedir(), '.kimi-code');
  const ps = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const send = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('install:log', msg); } catch { /* ignore */ }
    }
    logLine(`install: ${msg}`);
  };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ps, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
      ], {
        env: { ...process.env, KIMI_INSTALL_DIR: dir },
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    const onData = (chunk) => {
      chunk.toString('utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach(send);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('exit', (code) => {
      const exe = path.join(dir, 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
      if (code === 0 && fs.existsSync(exe)) {
        logLine(`CLI 安装完成: ${exe}`);
        resolve({ ok: true, cliPath: exe });
      } else {
        resolve({ ok: false, error: `安装脚本退出码 ${code}，未找到 ${exe}` });
      }
    });
  });
});

// ---------- 会话管理（阶段2）----------
const SESSION_TIMEOUT = 30000;

function getSessionIndexPath() {
  return path.join(getKimiHomeDir(), 'session_index.jsonl');
}

function readSessionIndex() {
  const indexPath = getSessionIndexPath();
  try {
    const content = fs.readFileSync(indexPath, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const sessions = [];
    const seen = new Set();
    // 从后往前遍历，保留每个 sessionId 的最后一条
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.sessionId && entry.sessionDir && !seen.has(entry.sessionId)) {
          seen.add(entry.sessionId);
          sessions.push(entry);
        }
      } catch { /* 跳过损坏行 */ }
    }
    return sessions.reverse();
  } catch {
    return [];
  }
}

function enrichSessionFromState(entry) {
  const statePath = path.join(entry.sessionDir, 'state.json');
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw);
    // 兼容 v1/v2 格式
    let updatedAt = state.updatedAt || state.createdAt || 0;
    if (typeof updatedAt === 'string') updatedAt = new Date(updatedAt).getTime();
    if (typeof updatedAt === 'number' && updatedAt > 0 && updatedAt < 1e12) updatedAt *= 1000; // 秒→毫秒
    const title = state.title || '';
    const lastPrompt = state.lastPrompt || '';
    const workDir = state.workDir || state.cwd || entry.workDir || '';
    return { title, lastPrompt, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0, workDir };
  } catch {
    return { title: '', lastPrompt: '', updatedAt: 0, workDir: entry.workDir || '' };
  }
}

function getAllSessions() {
  const indexEntries = readSessionIndex();
  const sessions = indexEntries.map((entry) => {
    const enriched = enrichSessionFromState(entry);
    return {
      sessionId: entry.sessionId,
      sessionDir: entry.sessionDir,
      workDir: enriched.workDir,
      title: enriched.title || 'New Session',
      lastPrompt: enriched.lastPrompt || '',
      updatedAt: enriched.updatedAt,
    };
  });
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return sessions;
}

// ---------- 会话 IPC ----------
ipcMain.handle('session:getSessions', () => {
  try {
    const sessions = getAllSessions();
    return { ok: true, sessions };
  } catch (err) {
    logLine(`getSessions 失败: ${err.message}`);
    return { ok: false, message: err.message, sessions: [] };
  }
});

ipcMain.handle('session:refreshSessions', () => {
  try {
    const sessions = getAllSessions();
    return { ok: true, sessions };
  } catch (err) {
    logLine(`refreshSessions 失败: ${err.message}`);
    return { ok: false, message: err.message, sessions: [] };
  }
});

ipcMain.handle('session:resumeSession', async (_e, sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, message: '无效的 sessionId' };
  }
  if (restartPromise) {
    return { ok: false, message: '服务正在重启中，请稍后再试' };
  }
  const indexEntries = readSessionIndex();
  const entry = indexEntries.find((e) => e.sessionId === sessionId);
  if (!entry) {
    return { ok: false, message: `未找到会话: ${sessionId}` };
  }
  logLine(`恢复会话: ${sessionId}`);
  pendingSessionId = sessionId;
  try {
    await restartServer();
    return { ok: true, message: '正在恢复会话...' };
  } catch (err) {
    pendingSessionId = null;
    logLine(`resumeSession 失败: ${err.message}`);
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('session:exportSession', async (_e, sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, message: '无效的 sessionId' };
  }
  const cfg = loadConfig();
  const cli = resolveCliPath(cfg);
  if (!cli) {
    return { ok: false, message: '未找到 kimi CLI' };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出会话',
    defaultPath: `kimi-session-${sessionId.slice(0, 8)}.zip`,
    filters: [{ name: 'ZIP 文件', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, message: '用户取消了导出' };
  }
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 1024 * 1024; // 1MB 上限，防止内存无限增长
    let child;
    try {
      child = spawn(cli, ['export', sessionId, '-o', result.filePath, '-y'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      logLine(`启动导出进程失败: ${err.message}`);
      resolve({ ok: false, message: `启动导出进程失败: ${err.message}` });
      return;
    }
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        forceKill(child.pid);
        logLine(`导出会话 ${sessionId} 超时`);
        resolve({ ok: false, message: '导出超时' });
      }
    }, 60000);
    const onData = (chunk) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk.toString('utf8');
      }
    };
    const onErrData = (chunk) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk.toString('utf8');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onErrData);
    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        logLine(`导出会话 ${sessionId} 进程错误: ${err.message}`);
        resolve({ ok: false, message: err.message });
      }
    });
    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (code === 0) {
          logLine(`导出会话 ${sessionId} -> ${result.filePath}`);
          resolve({ ok: true, message: '导出成功', filePath: result.filePath });
        } else {
          const msg = (stderr || `导出进程退出码 ${code}`).trim();
          logLine(`导出会话 ${sessionId} 失败: ${msg}`);
          resolve({ ok: false, message: msg });
        }
      }
    });
  });
});

ipcMain.handle('session:visualiseSession', async (_e, sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, message: '无效的 sessionId' };
  }
  const cfg = loadConfig();
  const cli = resolveCliPath(cfg);
  if (!cli) {
    return { ok: false, message: '未找到 kimi CLI' };
  }
  return new Promise((resolve) => {
    let visUrlFound = false;
    let buf = '';
    let timer = null;
    let child = null;
    try {
      child = spawn(cli, ['vis', sessionId, '--no-open'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, message: `启动可视化失败: ${err.message}` });
      return;
    }
    timer = setTimeout(() => {
      if (!visUrlFound) {
        forceKill(child.pid);
        resolve({ ok: false, message: '等待可视化 URL 超时' });
      }
    }, SESSION_TIMEOUT);
    const onData = (chunk) => {
      const text = stripAnsi(chunk.toString('utf8'));
      buf += text;
      if (!visUrlFound) {
        const m = buf.match(URL_RE);
        if (m) {
          visUrlFound = true;
          clearTimeout(timer);
          const visUrl = m[0];
          logLine(`可视化 URL: ${visUrl}`);
          const visWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            title: `Kimi Code 可视化 - ${sessionId.slice(0, 8)}`,
            backgroundColor: '#0e0e10',
            autoHideMenuBar: true,
            icon: path.join(__dirname, 'assets', 'icon.png'),
            webPreferences: {
              preload: path.join(__dirname, 'preload.js'),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
              spellcheck: false,
              partition: `persist:kimi-vis-${sessionId.slice(0, 8)}`,
            },
          });
          visWindow.loadURL(visUrl).catch((err) => {
            logLine(`可视化窗口加载失败: ${err.message}`);
          });
          visWindow.on('closed', () => { logLine('可视化窗口已关闭'); });
          resolve({ ok: true, url: visUrl, message: '可视化窗口已打开' });
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!visUrlFound) resolve({ ok: false, message: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!visUrlFound) resolve({ ok: false, message: `kimi vis 已退出 (code=${code})` });
    });
  });
});

ipcMain.handle('session:createSessionInDirectory', async () => {
  const dirResult = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (dirResult.canceled || !dirResult.filePaths[0]) {
    return { ok: false, message: '用户取消了选择' };
  }
  const workDir = dirResult.filePaths[0];
  if (!knownServerBase) {
    return { ok: false, message: 'Web 服务未就绪，请先启动会话后再创建' };
  }
  const token = knownServerToken || '';
  const encodedDir = encodeURIComponent(workDir);
  const deepLink = `${knownServerBase}/?action=create-in-dir&workDir=${encodedDir}#token=${encodeURIComponent(token)}`;
  logLine(`创建会话于目录: ${workDir}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(deepLink).catch((err) => {
      logLine(`加载深链接失败: ${err.message}`);
    });
  }
  return { ok: true, workDir, message: '正在创建新会话...' };
});

ipcMain.handle('session:openLauncher', () => {
  showSessionLauncher();
  return { ok: true };
});

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    createWindow();
    buildMenu();
    createTray();
    registerGlobalShortcut();

    // 测试钩子：环境变量指定服务时直连，跳过 CLI 启动
    const testBase = (process.env.KIMI_DESKTOP_TEST_BASE || '').trim();
    if (testBase) {
      knownServerBase = testBase;
      knownServerToken = (process.env.KIMI_DESKTOP_TEST_TOKEN || '').trim() || 'mock-token';
      logLine(`测试钩子: base=${testBase}`);
      loadMain(`${knownServerBase}/#token=${encodeURIComponent(knownServerToken)}`);
    } else {
      const cfg = loadConfig();
      const configExists = (() => { try { fs.accessSync(configFile()); return true; } catch { return false; } })();
      if (!configExists) {
        logLine('首次运行，显示设置页面');
        showSetup('first-run');
      } else if (cfg.mode === 'manual' && cfg.manualUrl) {
        logLine(`手动模式，直接加载: ${cfg.manualUrl}`);
        loadMain(cfg.manualUrl);
      } else {
        startKimiServer();
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', (e) => {
    if (beforeQuitInProgress) return;
    e.preventDefault();
    beforeQuitInProgress = true;
    quitting = true;
    stoppingIntentionally = true;
    // 永久废弃 WebSocket 订阅并清理
    wsGeneration++;
    cleanupWsPermanent();
    unregisterGlobalShortcut();
    // 异步等待停止完成后再退出，防止无限递归
    (async () => {
      await stopKimi();
      app.quit();
    })();
  });

  app.on('window-all-closed', () => {
    if (!beforeQuitInProgress) {
      quitting = true;
      app.quit();
    }
  });
}
