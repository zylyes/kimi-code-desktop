// Kimi Code Desktop — 网页版桌面套壳
// 自动启动 `kimi web`，从输出中捕获带 token 的本地地址，并在桌面窗口中打开。
const { app, BrowserWindow, WebContentsView, Menu, Tray, shell, ipcMain, dialog, nativeImage, nativeTheme, Notification, globalShortcut, session } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const configManager = require('./config-manager');
const skillsManager = require('./skills-manager');
const instancesManager = require('./instances-manager');
const ideIntegration = require('./ide-integration');
const sessionExport = require('./session-export');
const pluginsManager = require('./plugins-manager');
const { AcpClient } = require('./acp-client');

const APP_NAME = 'Kimi Code Desktop';
// 让 Windows 通知显示应用名，而非 electron.app 默认 ID
app.setAppUserModelId(APP_NAME);
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
// 覆盖层视图：sessions/setup 本地页盖在 Web UI 之上，切回时移除覆盖层即可，零重载
let overlayView = null;
let overlayKind = null; // 当前覆盖层类型：'sessions' | 'setup'

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
// 当前 WS 连接对应的服务地址/token（startWsSubscription 幂等判断用）
let wsConnectedBase = null;
let wsConnectedToken = null;
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
// 服务端能力探测（来自 /openapi.json，按路径自适应，探测不到则功能降级禁用）
const serverCaps = {
  archive: false, archivePath: null,
  delete: false, deletePath: null, deleteMethod: 'post',
  models: false, modelsPath: null,
};
// 认证错误提示去抖（每次启动世代只弹一次）
let authErrorShownForGen = -1;
// 模型切换下拉缓存（fetchModels 填充，菜单构建时消费）
let cachedModels = [];
// 模型菜单防抖刷新定时器
let modelMenuRefreshTimer = null;

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
  return Object.assign({
    mode: 'auto', cliPath: '', manualUrl: '', shellPath: '',
    httpProxy: '', httpsProxy: '', allProxy: '', noProxy: '',
    port: null, host: '', logLevel: '', kimiCodeHome: '',
    noAutoUpdate: false, disableTelemetry: false, autoStartCli: true,
    // 应用设置（设置页「应用设置」面板）
    theme: 'system', zoomFactor: 1,
    closeToTray: true, minimizeToTray: true, alwaysOnTop: false,
    launchAtLogin: false, notificationsEnabled: true, globalHotkeyEnabled: true,
  }, readJSON(configFile(), {}));
}

// 应用设置即时生效：主题/开机自启/全局热键/窗口置顶/界面缩放（不重启 server）
function applyAppSettings(cfg) {
  nativeTheme.themeSource = ['light', 'dark', 'system'].includes(cfg.theme) ? cfg.theme : 'system';
  try { app.setLoginItemSettings({ openAtLogin: cfg.launchAtLogin === true }); } catch { /* ignore */ }
  if (cfg.globalHotkeyEnabled === false) {
    unregisterGlobalShortcut();
  } else {
    registerGlobalShortcut();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(cfg.alwaysOnTop === true);
    const z = typeof cfg.zoomFactor === 'number' && Number.isFinite(cfg.zoomFactor) ? cfg.zoomFactor : 1;
    mainWindow.webContents.setZoomFactor(Math.min(2, Math.max(0.5, z)));
  }
}

// 自定义 KIMI_CODE_HOME：尽早注入 process.env，使全进程（含 config-manager）统一生效
function applyKimiCodeHomeFromConfig() {
  const cfg = readJSON(configFile(), {});
  const home = typeof cfg.kimiCodeHome === 'string' ? cfg.kimiCodeHome.trim() : '';
  if (home && home !== process.env.KIMI_CODE_HOME) {
    process.env.KIMI_CODE_HOME = home;
    logLine(`使用自定义 KIMI_CODE_HOME: ${home}`);
  }
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
  if (cfg.kimiCodeHome) env.KIMI_CODE_HOME = cfg.kimiCodeHome;
  if (cfg.noAutoUpdate === true) env.KIMI_CODE_NO_AUTO_UPDATE = '1';
  if (cfg.disableTelemetry === true) env.KIMI_DISABLE_TELEMETRY = '1';
  const bashPath = detectGitBash();
  if (bashPath) {
    env.KIMI_SHELL_PATH = bashPath;
  }
  // 插件市场 / OAuth / 自建服务地址（非空才注入）
  if (cfg.pluginMarketplaceUrl) env.KIMI_CODE_PLUGIN_MARKETPLACE_URL = cfg.pluginMarketplaceUrl;
  if (cfg.oauthHost) env.KIMI_CODE_OAUTH_HOST = cfg.oauthHost;
  if (cfg.selfHostedBaseUrl) env.KIMI_CODE_BASE_URL = cfg.selfHostedBaseUrl;
  // 临时模型：name 与 apiKey 均非空才注入，可选字段空串跳过
  const tm = cfg.tempModel;
  if (tm && typeof tm === 'object' && ensureString(tm.name).trim() && ensureString(tm.apiKey).trim()) {
    env.KIMI_MODEL_NAME = tm.name;
    env.KIMI_MODEL_API_KEY = tm.apiKey;
    if (tm.providerType) env.KIMI_MODEL_PROVIDER_TYPE = tm.providerType;
    if (tm.baseUrl) env.KIMI_MODEL_BASE_URL = tm.baseUrl;
    if (tm.displayName) env.KIMI_MODEL_DISPLAY_NAME = tm.displayName;
    if (tm.maxContextSize) env.KIMI_MODEL_MAX_CONTEXT_SIZE = tm.maxContextSize;
    if (tm.capabilities) env.KIMI_MODEL_CAPABILITIES = tm.capabilities;
    if (tm.thinkingEffort) env.KIMI_MODEL_THINKING_EFFORT = tm.thinkingEffort;
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
// 托盘菜单异步扫描的缓存（扫描含网络探测，构建菜单时只能读缓存）
let lastInstances = [];
let instancesCacheAt = 0;
let instancesCacheRefreshing = false;

function checkMultiInstances() {
  try {
    const list = instancesManager.scanInstances(getKimiHomeDir());
    if (list.length > 0) {
      const summary = list.map((i) =>
        `${i.host || '127.0.0.1'}:${i.port || '-'}(v${i.version || '?'}, ${i.alive ? 'alive' : 'exited'})`
      ).join(', ');
      logLine(`检测到 ${list.length} 个 CLI 实例注册项 [${summary}]，CLI 将自行选择端口`);
    }
  } catch {
    // 静默安全
  }
}

// 判断实例是否为当前连接（host+port 与 knownServerBase 匹配，loopback 别名视为同一地址）
function isCurrentInstance(inst) {
  if (!knownServerBase || !inst || !inst.port) return false;
  try {
    const u = new URL(knownServerBase);
    if (Number(u.port) !== inst.port) return false;
    const norm = (h) => (!h || h === 'localhost' || h === '[::1]' || h === '::1') ? '127.0.0.1' : h;
    return norm(inst.host) === norm(u.hostname);
  } catch {
    return false;
  }
}

// 切换到指定实例：探测可达 → 读 token → 更新连接信息并复用 rotateToken 末尾的 WS 重建序列。
// 失败时不改动任何现状（knownServerBase/knownServerToken 保持原值）。
async function connectToInstance(host, port) {
  const reachable = await instancesManager.probeInstance(host, port);
  if (!reachable) {
    return { ok: false, error: `实例 ${host}:${port} 不可达` };
  }
  const token = readServerToken();
  if (!token) {
    return { ok: false, error: '未读取到访问令牌（server.token）' };
  }
  knownServerBase = `http://${host}:${port}`;
  knownServerToken = token;
  // 废弃旧 WS 订阅并清理，loadMain 会以新地址+token 重建订阅
  wsGeneration++;
  cleanupWsPermanent();
  loadMain(`${knownServerBase}/#token=${encodeURIComponent(token)}`);
  logLine(`已切换到实例 ${host}:${port}`);
  return { ok: true };
}

// 异步刷新实例缓存：扫描 + 探测存活实例 + 标注当前连接，完成后重建托盘菜单
async function refreshInstancesCache(force) {
  if (instancesCacheRefreshing) return;
  const now = Date.now();
  if (!force && now - instancesCacheAt <= 10000) return;
  instancesCacheRefreshing = true;
  instancesCacheAt = now;
  try {
    const list = instancesManager.scanInstances(getKimiHomeDir());
    await Promise.all(list.map(async (inst) => {
      inst.responding = inst.alive
        ? await instancesManager.probeInstance(inst.host || '127.0.0.1', inst.port)
        : false;
      inst.current = isCurrentInstance(inst);
    }));
    lastInstances = list;
  } catch (err) {
    logLine(`实例缓存刷新失败: ${err.message}`);
  } finally {
    instancesCacheRefreshing = false;
  }
  updateTrayStatus();
}

// 托盘点击切换实例：与 instances:switch 同一逻辑，失败弹框提示
async function switchInstanceFromTray(inst) {
  const r = await connectToInstance(inst.host || '127.0.0.1', inst.port);
  if (!r.ok) {
    dialog.showMessageBox({ type: 'error', title: '切换实例', message: `切换失败：${r.error}` });
  }
  refreshInstancesCache(true);
}

// 构建「多实例」子菜单：标签含 :端口、版本、当前/已退出标记；已退出置灰；底部重新扫描
function buildInstancesSubmenu() {
  const items = lastInstances.map((inst) => {
    const parts = [`${inst.host || ''}:${inst.port || '?'}`];
    if (inst.version) parts.push(`v${inst.version}`);
    if (inst.current) parts.push('当前');
    else if (!inst.alive) parts.push('已退出');
    return {
      label: parts.join(' '),
      enabled: !!inst.alive,
      click: () => { void switchInstanceFromTray(inst); },
    };
  });
  if (items.length === 0) {
    items.push({ label: '未发现实例', enabled: false });
  }
  items.push({ type: 'separator' });
  items.push({ label: '重新扫描', click: () => { void refreshInstancesCache(true); } });
  return items;
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

// 通用 REST 请求（归档/删除等动作），返回 { status, data } 或 null
function httpRequest(method, url, token, timeout = 8000) {
  return new Promise((resolve) => {
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      timeout,
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

// ---------- 认证错误识别与 FAQ 引导 ----------
const AUTH_ERROR_RE = /401|unauthorized|forbidden|invalid.{0,20}(api[ -]?key|token|credential)|authentication (failed|error)|登录已过期|授权已过期|凭证无效/i;

function handleAuthError(gen, source) {
  if (gen !== serverGeneration) return;
  if (authErrorShownForGen === gen) return;
  authErrorShownForGen = gen;
  logLine(`检测到认证错误（${source}），弹出排查引导`);
  showDesktopNotification('认证失败', 'Kimi Code 认证错误，点击查看排查建议');
  const detail = [
    '可能原因与排查建议：',
    '',
    '1. api.kimi.com 与 api.moonshot.cn 的 API 密钥不通用，请确认密钥与供应商域名匹配；',
    '2. 设备授权超过 30 天未使用会自动过期，请重新登录；',
    '3. 高速版模型无权限时返回 401，且填错模型 ID 会静默回退不报错，请检查 default_model；',
    '4. 若使用自定义供应商，请检查 baseURL 与密钥是否正确。',
  ].join('\n');
  dialog.showMessageBox({
    type: 'error',
    title: '认证失败',
    message: 'Kimi Code 认证错误',
    detail,
    buttons: ['重新登录', '打开设置', '忽略'],
    defaultId: 0,
    cancelId: 2,
  }).then(({ response }) => {
    if (response === 0 || response === 1) {
      showSetup('auth-error');
    }
  }).catch(() => { /* ignore */ });
}

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
  const isNewCli = ver && (ver.semver[0] >= 1 || (ver.semver[0] === 0 && ver.semver[1] >= 28));
  let args;
  if (isNewCli) {
    args = ['web', '--no-open'];
    // 自定义启动参数（仅新版 CLI 支持）
    const port = Number(cfg.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) args.push('--port', String(port));
    if (cfg.host && typeof cfg.host === 'string' && cfg.host.trim()) args.push('--host', cfg.host.trim());
    if (cfg.debugMode === true) {
      // 调试模式：固定 debug 日志并开启调试端点，忽略自定义 logLevel
      args.push('--log-level', 'debug', '--debug-endpoints');
      logLine('调试模式已开启: --log-level debug --debug-endpoints');
    } else if (cfg.logLevel && typeof cfg.logLevel === 'string' && cfg.logLevel.trim()) {
      args.push('--log-level', cfg.logLevel.trim());
    }
  } else {
    args = ['web', '--no-open', '--foreground'];
    if (cfg.port || cfg.host || cfg.logLevel) {
      logLine('当前 CLI 版本不支持 --port/--host/--log-level，已忽略自定义启动参数');
    }
    if (cfg.debugMode === true) {
      logLine('当前 CLI 不支持 --debug-endpoints，已忽略');
    }
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
      .forEach((line) => {
        logLine(`kimi: ${line}`);
        if (AUTH_ERROR_RE.test(line)) handleAuthError(gen, 'CLI 输出');
      });
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
// 从 openapi.json paths 探测服务端能力，路径形态自适应（:archive 自定义动词或 /archive 子路径）
function detectServerCaps(openapi) {
  serverCaps.archive = false; serverCaps.archivePath = null;
  serverCaps.delete = false; serverCaps.deletePath = null; serverCaps.deleteMethod = 'post';
  serverCaps.models = false; serverCaps.modelsPath = null;
  const paths = openapi && typeof openapi === 'object' ? openapi.paths : null;
  if (!paths || typeof paths !== 'object') return;
  for (const [p, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== 'object') continue;
    const methods = Object.keys(ops).map((m) => m.toLowerCase());
    if (/\/sessions\/\{[^}]+\}:archive\/?$/.test(p) && methods.includes('post')) {
      serverCaps.archive = true; serverCaps.archivePath = p;
    } else if (/\/sessions\/\{[^}]+\}\/archive\/?$/.test(p) && methods.includes('post')) {
      serverCaps.archive = true; serverCaps.archivePath = p;
    } else if (/\/sessions\/\{[^}]+\}:delete\/?$/.test(p) && methods.includes('post')) {
      serverCaps.delete = true; serverCaps.deletePath = p; serverCaps.deleteMethod = 'post';
    } else if (/\/sessions\/\{[^}]+\}\/?$/.test(p) && methods.includes('delete')) {
      serverCaps.delete = true; serverCaps.deletePath = p; serverCaps.deleteMethod = 'delete';
    } else if (/\/models/.test(p) && methods.includes('get') && !serverCaps.models) {
      serverCaps.models = true; serverCaps.modelsPath = p;
    }
  }
  logLine(`服务端能力: archive=${serverCaps.archive} delete=${serverCaps.delete} models=${serverCaps.models}`);
}

// 将会话 ID 代入路径模板（{xxx} → id），并附加 /api/v1 前缀（若模板缺失）
function buildSessionActionUrl(base, pathTemplate, sessionId) {
  const rel = pathTemplate.replace(/\{[^}]+\}/g, encodeURIComponent(sessionId));
  const full = rel.startsWith('/api/') ? rel : `/api/v1${rel.startsWith('/') ? '' : '/'}${rel}`;
  return new URL(full, base);
}

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
        try {
          detectServerCaps(JSON.parse(res.data));
        } catch {
          logLine('openapi.json 解析失败，能力探测跳过（归档/删除/模型列表将禁用）');
        }
        // 拉取模型列表并防抖刷新托盘/应用菜单（异步，不阻塞页面加载）
        fetchModels().then(refreshModelMenus);
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
  // 连接记录随 socket 一并失效（cleanupWsPermanent 经由此处同步清除）
  wsConnectedBase = null;
  wsConnectedToken = null;
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

// 原生窗口背景色跟随系统亮/暗主题
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#181817' : '#fbfaf9';
}

// 主窗口悬浮窗控（titleBarOverlay）配色：背景对齐窗口背景，符号色随亮/暗主题
function titleBarOverlayOpts() {
  return {
    color: windowBackground(),
    symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#111111',
    height: 32,
  };
}

// 主窗口 Web UI 页右上角窗控区采样色（preload 采样上报；本地页恒为 null → 用 windowBackground()）
let mainTitlebarSampleColor = null;
// menu-panel.js 文件内容缓存（did-finish-load 时 executeJavaScript 注入 Web UI 页）
let menuPanelCodeCache = null;

// 解析 'rgb(r, g, b)' / 'rgba(r, g, b, a)' 为 [r,g,b]，非法返回 null
function parseTitlebarColor(color) {
  if (typeof color !== 'string') return null;
  const m = color.match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// 判断 URL 是否为 loopback 的 kimi web UI 页（与 did-finish-load 注入处同一判定）
function isLoopbackWebUIUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:')
      && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

// 逐窗计算悬浮窗控配色：主窗口且当前 URL 是 loopback http(s) 且有采样色 → 采样色，
// 逐窗计算悬浮窗控配色：主窗口且当前 URL 是 loopback http(s) 且有采样色 → 采样色，
// symbolColor 按采样色 Rec.601 亮度 > 0.6 用 '#111111' 否则 '#ffffff'；否则回退 windowBackground()。
// 覆盖层（sessions/setup 本地页）打开时主窗口 Web UI 虽仍在 loopback URL，但可视顶栏是覆盖层的
// .app-topbar（bg 同 windowBackground()），此时须回退 windowBackground()，否则采样色会成异色补丁
function titlebarColorForWindow(win) {
  if (win && win === mainWindow && !win.isDestroyed() && mainTitlebarSampleColor && !overlayView) {
    const rgb = parseTitlebarColor(mainTitlebarSampleColor);
    if (rgb && isLoopbackWebUIUrl(win.webContents.getURL())) {
      const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
      return {
        color: mainTitlebarSampleColor,
        symbolColor: luminance > 0.6 ? '#111111' : '#ffffff',
        height: 32,
      };
    }
  }
  return titleBarOverlayOpts();
}

function applyTitlebarOverlay(win) {
  if (!win || win.isDestroyed()) return;
  try { win.setTitleBarOverlay(titlebarColorForWindow(win)); } catch { /* 无 overlay 的窗口忽略 */ }
}

// 无边框窗口通用选项与后配置：全窗口统一无边框 + 悬浮窗控（品牌一致性），
// 页面拖拽区由 kimi-theme.css（#kcd-drag-strip/.app-topbar）与 preload 注入提供
function framelessOpts() {
  return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlayOpts() };
}

function applyFrameless(win) {
  // 无边框窗口上禁止 Alt 唤出原生菜单条（菜单加速键不受影响）
  win.setMenuBarVisibility(false);
}

// 亮/暗主题变化时同步刷新所有窗口的悬浮窗控配色（applyAppSettings 切 themeSource 亦触发此事件）；
// 逐窗用 titlebarColorForWindow：主窗口 Web UI 页保留页面采样色，其余窗口跟随 windowBackground()
nativeTheme.on('updated', () => {
  for (const w of BrowserWindow.getAllWindows()) {
    applyTitlebarOverlay(w);
  }
});

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
      backgroundColor: windowBackground(),
      autoHideMenuBar: true,
      ...framelessOpts(),
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
  applyFrameless(win);

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
  // 幂等：已有指向同一服务（base/token 一致）且处于 OPEN/CONNECTING 的连接时直接复用，不重复建连
  if (wsClient
    && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)
    && wsConnectedBase === knownServerBase && wsConnectedToken === knownServerToken) {
    return;
  }
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
  // 记录本次连接对应的服务地址/token，供幂等判断
  wsConnectedBase = knownServerBase;
  wsConnectedToken = knownServerToken;

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

      // 会话被删除（其他客户端或本端触发）→ 刷新启动器列表
      if (event === 'event.session.deleted' || event === 'session.deleted' ||
          event === 'event.session.archived' || event === 'session.archived') {
        wsSubscribedSessions.clear();
        notifySessionChanged();
        return;
      }

      // 模型目录变更 → 重新拉取模型列表并刷新菜单
      if (event === 'event.model_catalog.changed' || event === 'model_catalog.changed') {
        fetchModels().then(refreshModelMenus);
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
    if (AUTH_ERROR_RE.test(err.message || '')) handleAuthError(serverGeneration, 'WebSocket');
    cleanupWsSoft();
    scheduleWsReconnect(gen);
  });

  wsClient.on('close', (code, reason) => {
    if (gen !== wsGeneration) return;
    logLine(`WebSocket 连接关闭 (code=${code})`);
    const reasonText = reason ? reason.toString('utf8') : '';
    if (code === 1008 || code === 4401 || code === 4403 || AUTH_ERROR_RE.test(reasonText)) {
      handleAuthError(serverGeneration, 'WebSocket');
    }
    cleanupWsSoft();
    scheduleWsReconnect(gen);
  });
}

function showDesktopNotification(title, body) {
  if (loadConfig().notificationsEnabled === false) return;
  try {
    const notif = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') });
    notif.on('click', () => {
      // 与托盘点击同一入口：窗口被销毁（mainWindow 为 null）时自动重建并拉起服务
      showMainWindow();
      // 取消任务栏闪烁
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
    });
    notif.show();
    // 通知闪烁前重新确认窗口未聚焦（窗口可能在消息到达后被聚焦）
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindowFocused) {
      mainWindow.flashFrame(true);
    }
  } catch { /* Electron Notification 不可用时静默 */ }
}

// 屏蔽网页自身的 HTML5 通知：桌面端统一由主进程原生通知展示，避免同一事件弹出网页+原生两条通知
function blockWebPageNotifications() {
  const shouldDeny = (permission) => permission === 'notifications';
  const sessions = [session.defaultSession, session.fromPartition('persist:kimi-code')];
  for (const ses of sessions) {
    if (!ses) continue;
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(!shouldDeny(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => !shouldDeny(permission));
  }
}

// ---------- 页面加载 ----------
function loadMain(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  closeOverlay(); // 不变式：Web UI 回到前台时覆盖层必关
  sessionLauncherVisible = false; // 显式加载 Web UI 时清除启动器可见状态
  loadedUrl = url;
  mainWindow.loadURL(url).catch((err) => {
    logLine(`加载页面失败: ${err.message}`);
    showSetup('load-failed');
  });
  // 启动 WebSocket 订阅
  startWsSubscription();
}

function showSetup(reason, tab) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sessionLauncherVisible = false; // 从会话启动器进入设置后，确保 startPolling 能加载页面
  const query = { reason: reason || '' };
  if (tab) query.tab = tab; // 指定初始标签页（如 'ide'），由 setup.html 的 ?tab= 逻辑消费
  // Web UI 已常驻时，设置页改为覆盖层展示，切回零重载
  if (loadedUrl) {
    showOverlay('setup', 'setup.html', query);
    return;
  }
  closeOverlay(); // 防御：整页加载前确保覆盖层已关闭
  mainWindow.loadFile(path.join(__dirname, 'setup.html'), { query });
}

// ---------- 覆盖层（本地页盖在常驻 Web UI 之上，切回零重载）----------
// 懒创建覆盖层视图：webPreferences 与主窗口完全一致，bounds 铺满内容区
function ensureOverlayView() {
  if (overlayView || !mainWindow || mainWindow.isDestroyed()) return;
  overlayView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      partition: 'persist:kimi-code',
      // 与主窗口相同的标记，preload 据此注入拖拽条/菜单按钮
      additionalArguments: ['--kcd-main-window'],
    },
  });
  mainWindow.contentView.addChildView(overlayView);
  const [w, h] = mainWindow.getContentSize();
  overlayView.setBounds({ x: 0, y: 0, width: w, height: h });
  // 与主窗口相同的新窗策略：外部链接交系统浏览器，拒绝弹新窗
  overlayView.webContents.setWindowOpenHandler(handleWindowOpen);
}

// 打开/切换覆盖层：每次 show 重新 loadFile，保证 sessions 列表等数据新鲜
function showOverlay(kind, file, query) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (overlayView) closeOverlay(); // 已有覆盖层（含不同 kind）先销毁重建
  ensureOverlayView();
  if (!overlayView) return;
  overlayView.webContents.loadFile(path.join(__dirname, file), query ? { query } : undefined).catch((err) => {
    logLine(`加载 ${file} 失败: ${err.message}`);
  });
  overlayKind = kind;
  overlayView.webContents.focus();
  // 覆盖层可视顶栏为本地页 .app-topbar（bg 同 windowBackground()）：刷新悬浮窗控配色，防采样色成补丁
  applyTitlebarOverlay(mainWindow);
}

// 关闭覆盖层：移除子视图并销毁其 webContents，Web UI 立即回到前台（不重载）
function closeOverlay() {
  if (!overlayView) { overlayKind = null; return; }
  const view = overlayView;
  overlayView = null;
  overlayKind = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.contentView.removeChildView(view); } catch { /* ignore */ }
  }
  // WebContentsView 的 webContents 不会随移除自动销毁，需显式 close 释放页面资源
  try { view.webContents.close(); } catch { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus();
  }
  // Web UI 回到前台：恢复采样色窗控配色
  applyTitlebarOverlay(mainWindow);
}

// 前台 webContents：覆盖层（sessions/setup）可见时页面在覆盖层里，否则是主窗口内容。
// 页面定向消息（setup 的登录/安装日志等）与「重新加载」都应作用于前台页面
function foregroundContents() {
  if (overlayView && !overlayView.webContents.isDestroyed()) return overlayView.webContents;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.webContents;
  return null;
}

// ---------- 会话启动器 ----------
function showSessionLauncher() {
  sessionLauncherVisible = true;
  // Web UI 已常驻时，启动器改为覆盖层展示，切回零重载（窗口 show/focus 逻辑不变）
  if (loadedUrl && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    showOverlay('sessions', 'sessions.html');
    return;
  }
  closeOverlay(); // 防御：整页加载前确保覆盖层已关闭
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

// ---------- 辅助窗口（模板库 / 帮助 / 局域网 / 子 Agent 监视）----------
// 单例辅助窗口工厂：重复调用时聚焦既有窗口，关闭后下次重新创建
function makeSingletonWindow(title, file) {
  let win = null;
  return () => {
    if (win && !win.isDestroyed()) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 960,
      height: 720,
      minWidth: 640,
      minHeight: 480,
      title,
      backgroundColor: windowBackground(),
      autoHideMenuBar: true,
      ...framelessOpts(),
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
    applyFrameless(win);
    win.on('closed', () => { win = null; });
    win.loadFile(path.join(__dirname, file)).catch((err) => {
      logLine(`加载 ${file} 失败: ${err.message}`);
    });
  };
}

const showPromptLibrary = makeSingletonWindow('Prompt 模板库', 'prompts.html');
const showHelpWindow = makeSingletonWindow('命令与快捷键速查', 'help.html');
const showLanWindow = makeSingletonWindow('局域网访问', 'lan.html');

// 子 Agent 任务监视窗口（可多开，按会话目录区分内容）
function showAgentsMonitor(sessionDir, title) {
  const dir = ensureString(sessionDir);
  if (!dir) {
    logLine('打开子 Agent 监视失败：缺少会话目录');
    return;
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: title ? `子 Agent 监视 - ${title}` : '子 Agent 监视',
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    ...framelessOpts(),
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
  applyFrameless(win);
  win.loadFile(path.join(__dirname, 'agents.html'), {
    query: { dir, title: ensureString(title) },
  }).catch((err) => {
    logLine(`加载 agents.html 失败: ${err.message}`);
  });
}

// ---------- ACP 原型聊天窗（实验）----------
// 直连 `kimi acp`，会话落在系统临时目录；工具执行权限经原生审批窗确认（见下方「ACP 权限审批窗」）
let acpChatWindow = null;
let acpClient = null;
let acpConfigOptions = null; // 当前会话最近一次拿到的 configOptions（set-config 白名单依据，dispose 时清空）

function disposeAcpClient(reason) {
  cancelAllAcpPermissions(reason || '客户端销毁');
  if (acpClient) {
    try { acpClient.dispose(reason); } catch { /* ignore */ }
    acpClient = null;
  }
  acpConfigOptions = null;
}

function sendAcpEvent(payload) {
  if (acpChatWindow && !acpChatWindow.isDestroyed()) {
    try { acpChatWindow.webContents.send('acp-chat:event', payload); } catch { /* ignore */ }
  }
}

// ---------- ACP 权限审批窗 ----------
// session/request_permission 的原生审批：一次一个窗串行处理，并发请求防御性排队；
// 窗口创建/加载失败回退原生对话框，再失败按取消处理
let acpPermissionWindow = null;
let acpPermissionPending = null; // 当前在途 { settle, params }
let acpPermissionQueue = [];     // 防御性 FIFO 队列

// 从 toolCall 防御性提取可读详情：execute 优先命令行，edit/write 优先文件路径，
// 否则取 rawInput 的美化 JSON；统一截断 2000 字符
function extractAcpToolDetail(toolCall) {
  const tc = toolCall && typeof toolCall === 'object' ? toolCall : {};
  const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : null;
  const firstString = (vals) => {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
    return '';
  };
  const kind = ensureString(tc.kind);
  let text = '';
  if (kind === 'execute') {
    text = raw ? firstString([raw.command, raw.commandLine, raw.cmd, raw.script]) : '';
  } else if (kind === 'edit' || kind === 'write') {
    const locs = Array.isArray(tc.locations) ? tc.locations : [];
    const locPath = locs.length && locs[0] && typeof locs[0].path === 'string' ? locs[0].path : '';
    text = firstString([locPath, raw ? firstString([raw.path, raw.file_path, raw.filePath, raw.filename]) : '']);
  }
  if (!text && raw) {
    try { text = JSON.stringify(raw, null, 2); } catch { text = ''; }
  }
  // 实测（docs/acp-probe2-output.txt）：request_permission 内嵌 toolCall 常无 kind/rawInput，
  // 关键上下文（如计划正文）在 content 块里，按 ACP 内容块形态提取文本兜底
  if (!text && Array.isArray(tc.content)) {
    const parts = [];
    for (const block of tc.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'content' && block.content && block.content.type === 'text' && typeof block.content.text === 'string') {
        if (block.content.text.trim()) parts.push(block.content.text);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text.trim()) parts.push(block.text);
      }
    }
    text = parts.join('\n\n');
  }
  if (typeof text !== 'string') text = String(text || '');
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

// tool_call_update 的 rawOutput 文本提取（截断 2000，空串由调用方省略字段）
function extractAcpRawOutput(rawOutput) {
  let text = '';
  if (typeof rawOutput === 'string') text = rawOutput;
  else if (rawOutput && typeof rawOutput === 'object') {
    if (typeof rawOutput.text === 'string') text = rawOutput.text;
    else if (typeof rawOutput.content === 'string') text = rawOutput.content;
    else if (typeof rawOutput.output === 'string') text = rawOutput.output;
  }
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

// 权限窗 init payload：白名单字段 + 防御性清洗截断
function buildAcpPermissionPayload(params) {
  const p = params && typeof params === 'object' ? params : {};
  const tc = p.toolCall && typeof p.toolCall === 'object' ? p.toolCall : {};
  const title = ensureString(tc.title).slice(0, 200) || '操作审批';
  const kind = ensureString(tc.kind).slice(0, 40);
  const locations = (Array.isArray(tc.locations) ? tc.locations : [])
    .filter((l) => l && typeof l === 'object' && typeof l.path === 'string')
    .slice(0, 20)
    .map((l) => {
      const item = { path: l.path.slice(0, 500) };
      if (Number.isInteger(l.line)) item.line = l.line;
      return item;
    });
  const options = (Array.isArray(p.options) ? p.options : [])
    .filter((o) => o && typeof o === 'object' && typeof o.optionId === 'string')
    .slice(0, 8)
    .map((o) => ({
      optionId: o.optionId.slice(0, 100),
      name: ensureString(o.name).slice(0, 80) || o.optionId.slice(0, 100),
      kind: ensureString(o.kind).slice(0, 40),
    }));
  return { title, kind, detail: extractAcpToolDetail(tc), locations, options };
}

function closeAcpPermissionWindow() {
  if (acpPermissionWindow && !acpPermissionWindow.isDestroyed()) {
    try { acpPermissionWindow.close(); } catch { /* ignore */ }
  }
  acpPermissionWindow = null;
}

// 清理在途 + 排队的权限审批（一律按 cancelled 收尾）并关闭权限窗
function cancelAllAcpPermissions(reason) {
  if (acpPermissionPending) {
    logLine(`[acp] 权限审批按取消收尾（${reason}）`);
    acpPermissionPending.settle({ outcome: 'cancelled' });
  }
  const queued = acpPermissionQueue;
  acpPermissionQueue = [];
  for (const item of queued) {
    try { item.resolve({ outcome: { outcome: 'cancelled' } }); } catch { /* ignore */ }
  }
  closeAcpPermissionWindow();
}

// 权限审批入口（acp-client 的 permission handler）：永不 reject，结果恒为 ACP outcome
function requestAcpPermission(params) {
  return new Promise((resolve) => {
    acpPermissionQueue.push({ params, resolve });
    pumpAcpPermissionQueue();
  });
}

function pumpAcpPermissionQueue() {
  if (acpPermissionPending) return; // 一次只审批一个
  const next = acpPermissionQueue.shift();
  if (!next) return;
  const { params, resolve } = next;
  let settled = false; // 每个请求只收尾一次
  const settle = (inner) => {
    if (settled) return;
    settled = true;
    acpPermissionPending = null;
    const ok = inner && inner.outcome === 'selected' && typeof inner.optionId === 'string';
    sendAcpEvent(ok
      ? { type: 'permission-resolved', optionId: inner.optionId }
      : { type: 'permission-resolved', cancelled: true });
    closeAcpPermissionWindow();
    resolve({ outcome: ok ? { outcome: 'selected', optionId: inner.optionId } : { outcome: 'cancelled' } });
    pumpAcpPermissionQueue(); // 处理队列下一条
  };
  acpPermissionPending = { settle, params };
  const payload = buildAcpPermissionPayload(params);
  logLine(`[acp] 权限审批请求: ${payload.title} (${payload.kind || 'unknown'})`);
  sendAcpEvent({ type: 'permission-pending', title: payload.title, kind: payload.kind });
  // 聊天窗失焦时任务栏闪烁 + 桌面通知
  if (!acpChatWindow || acpChatWindow.isDestroyed() || !acpChatWindow.isFocused()) {
    if (acpChatWindow && !acpChatWindow.isDestroyed()) {
      try { acpChatWindow.flashFrame(true); } catch { /* ignore */ }
    }
    showDesktopNotification('操作审批', payload.title);
  }
  openAcpPermissionWindow(payload, settle);
}

function openAcpPermissionWindow(payload, settle) {
  let win = null;
  try {
    win = new BrowserWindow({
      width: 520,
      height: 480,
      minWidth: 420,
      minHeight: 360,
      resizable: true,
      parent: acpChatWindow && !acpChatWindow.isDestroyed() ? acpChatWindow : undefined,
      title: '操作审批',
      backgroundColor: windowBackground(),
      autoHideMenuBar: true,
      ...framelessOpts(),
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'permission-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
  } catch (err) {
    logLine(`权限窗口创建失败: ${err.message}`);
    fallbackAcpPermissionDialog(payload, settle);
    return;
  }
  applyFrameless(win);
  acpPermissionWindow = win;
  let fellBack = false; // 加载失败回退对话框时，关窗不再按取消收尾
  win.on('closed', () => {
    if (acpPermissionWindow === win) acpPermissionWindow = null;
    // 关窗 / Esc = 取消
    if (!fellBack) settle({ outcome: 'cancelled' });
  });
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    // 仅在仍为当前在途审批时下发（防御时序竞争）
    if (!acpPermissionPending || acpPermissionPending.settle !== settle) return;
    try { win.webContents.send('acp-permission:init', payload); } catch { /* ignore */ }
  });
  win.loadFile(path.join(__dirname, 'permission.html')).catch((err) => {
    logLine(`权限窗口加载失败: ${err.message}`);
    fellBack = true;
    if (!win.isDestroyed()) win.close();
    // 仅在审批仍在途时回退（用户可能已关窗完成决策）
    if (acpPermissionPending && acpPermissionPending.settle === settle) {
      fallbackAcpPermissionDialog(payload, settle);
    }
  });
}

// 权限窗不可用时的回退：原生对话框（按钮 = 各 option.name + 拒绝），再失败按取消
function fallbackAcpPermissionDialog(payload, settle) {
  const buttons = payload.options.map((o) => (o.name.length > 60 ? `${o.name.slice(0, 57)}...` : o.name));
  buttons.push('拒绝');
  const opts = {
    type: 'question',
    buttons,
    defaultId: -1, // 无默认选中
    cancelId: buttons.length - 1, // 「拒绝」作为取消
    title: '操作审批',
    message: payload.title,
    detail: (payload.detail || payload.kind || '').slice(0, 2000),
    noLink: true,
  };
  logLine(`显示权限审批对话框: options=${payload.options.length}`);
  const parentWin = acpChatWindow && !acpChatWindow.isDestroyed() ? acpChatWindow : null;
  const shown = parentWin ? dialog.showMessageBox(parentWin, opts) : dialog.showMessageBox(opts);
  shown.then((result) => {
    const idx = result && typeof result.response === 'number' ? result.response : -1;
    if (idx >= 0 && idx < payload.options.length) {
      settle({ outcome: 'selected', optionId: payload.options[idx].optionId });
    } else {
      settle({ outcome: 'cancelled' });
    }
  }).catch((err) => {
    logLine(`权限审批对话框失败: ${err.message}`);
    settle({ outcome: 'cancelled' });
  });
}

ipcMain.handle('acp-permission:respond', (_e, optionId) => {
  if (!acpPermissionPending) {
    logLine('[acp] 收到陈旧的权限审批响应，已忽略');
    return { ok: false, error: '无在途审批' };
  }
  if (optionId === null) {
    acpPermissionPending.settle({ outcome: 'cancelled' });
    return { ok: true };
  }
  // optionId 必须在当前请求的可选项内（与 acp-client 的校验一致，防伪造/防事件误报）
  const validIds = (Array.isArray(acpPermissionPending.params && acpPermissionPending.params.options)
    ? acpPermissionPending.params.options : [])
    .filter((o) => o && typeof o.optionId === 'string')
    .map((o) => o.optionId);
  if (typeof optionId !== 'string' || !validIds.includes(optionId)) {
    logLine('[acp] 权限审批响应 optionId 非法（不在可选项内），按取消处理');
    acpPermissionPending.settle({ outcome: 'cancelled' });
    return { ok: true };
  }
  acpPermissionPending.settle({ outcome: 'selected', optionId });
  return { ok: true };
});

function showAcpChatWindow() {
  if (acpChatWindow && !acpChatWindow.isDestroyed()) {
    acpChatWindow.show();
    if (acpChatWindow.isMinimized()) acpChatWindow.restore();
    acpChatWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: '原生聊天原型（ACP 实验）',
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    ...framelessOpts(),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'chat-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  applyFrameless(win);
  acpChatWindow = win;
  win.on('closed', () => {
    if (acpChatWindow === win) acpChatWindow = null;
    disposeAcpClient('窗口关闭');
  });
  win.loadFile(path.join(__dirname, 'chat.html')).catch((err) => {
    logLine(`加载 chat.html 失败: ${err.message}`);
  });
}

// 恢复会话的本地历史兜底（双保险）：agent 在 session/load 期间未重放消息时，
// 按 session-export 的解析思路从 wire.jsonl 提取 user/assistant 文本消息下发渲染层；
// 坏行跳过、只取最近 50 条、单条文本封顶 4000 字符；找不到数据一律静默跳过（记日志）
function sendAcpLocalHistory(sessionId) {
  try {
    const entry = readSessionIndex().find((e) => e.sessionId === sessionId);
    if (!entry || !entry.sessionDir) {
      logLine('[acp] 本地历史跳过：会话索引无该 sessionId 或缺 sessionDir');
      return;
    }
    const parsed = sessionExport.readJsonl(sessionExport.wirePathFor(entry.sessionDir, 'main'));
    if (!parsed) {
      logLine('[acp] 本地历史跳过：wire.jsonl 不存在或不可读');
      return;
    }
    const messages = sessionExport.extractMessages(parsed.events)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text)
      .map((m) => ({ role: m.role, text: m.text.length > 4000 ? `${m.text.slice(0, 3997)}...` : m.text }));
    if (messages.length === 0) {
      logLine('[acp] 本地历史跳过：wire.jsonl 中无可渲染消息');
      return;
    }
    const recent = messages.slice(-50); // 逆序取最近 50 条后恢复正序（等价写法，保持时间正序下发）
    logLine(`[acp] 本地历史下发 ${recent.length} 条（共 ${messages.length} 条，坏行 ${parsed.badLines}）`);
    sendAcpEvent({ type: 'history', messages: recent });
  } catch (err) {
    logLine(`[acp] 本地历史读取失败: ${err.message}`);
  }
}

// opts 可空：{ cwd, sessionId }。cwd 合法（已存在的绝对路径目录）才采用，否则回退临时目录；
// 带 sessionId 走 loadSession 恢复既有会话（失败明确报错，不回退新建），否则 newSession
ipcMain.handle('acp-chat:start', async (_e, opts) => {
  disposeAcpClient('重新启动 ACP 会话');
  const cfg = loadConfig();
  const cli = resolveCliPath(cfg);
  if (!cli) return { ok: false, error: '未找到 Kimi CLI，请先在设置中完成安装' };
  const o = opts && typeof opts === 'object' ? opts : {};
  const wantCwd = ensureString(o.cwd).slice(0, 500);
  const wantSessionId = ensureString(o.sessionId).slice(0, 500);
  let cwd = '';
  if (wantCwd && path.isAbsolute(wantCwd)) {
    try {
      if (fs.existsSync(wantCwd) && fs.statSync(wantCwd).isDirectory()) cwd = wantCwd;
    } catch { /* 校验失败按无 cwd 处理 */ }
  }
  if (!cwd) {
    try {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-acp-chat-'));
    } catch (err) {
      logLine(`ACP 临时目录创建失败: ${err.message}`);
      return { ok: false, error: `创建临时目录失败: ${err.message}` };
    }
  }
  // 历史双保险：load 完成前到达的消息类 update 视为 agent 重放（置标记以跳过本地自绘）
  let loadPending = false;
  let loadReplayed = false;
  let client;
  try {
    client = new AcpClient({ cliPath: cli, cwd, logFn: (m) => logLine(`[acp] ${m}`) });
  } catch (err) {
    logLine(`ACP 客户端创建失败: ${err.message}`);
    return { ok: false, error: `启动 ACP 客户端失败: ${err.message}` };
  }
  client.on('update', (update) => {
    if (!update || typeof update !== 'object') return;
    const kind = update.sessionUpdate;
    const text = update.content && update.content.type === 'text' && typeof update.content.text === 'string'
      ? update.content.text : null;
    if (loadPending && (kind === 'agent_message_chunk' || kind === 'user_message_chunk'
      || kind === 'agent_message' || kind === 'user_message')) {
      loadReplayed = true; // chunk 本身仍走下方管线照常转发，不吞掉
    }
    if (kind === 'agent_message_chunk' && text !== null) {
      sendAcpEvent({ type: 'message-chunk', text });
    } else if (kind === 'user_message_chunk' && text !== null) {
      // 渲染层原先不收 user chunk：补发事件（agent 重放历史时才能看到用户侧消息）
      sendAcpEvent({ type: 'user-chunk', text });
    } else if (kind === 'agent_thought_chunk' && text !== null) {
      sendAcpEvent({ type: 'thought-chunk', text });
    } else if (kind === 'available_commands_update') {
      // 斜杠命令菜单：清洗后转发完整列表（防御性白名单字段 + 截断 + 封顶 50 条）
      const commands = (Array.isArray(update.availableCommands) ? update.availableCommands : [])
        .filter((c) => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim())
        .slice(0, 50)
        .map((c) => ({
          name: c.name.slice(0, 64),
          description: ensureString(c.description).slice(0, 200),
          hint: c.input && typeof c.input === 'object' ? ensureString(c.input.hint).slice(0, 200) : '',
        }));
      sendAcpEvent({ type: 'commands', count: commands.length, commands });
    } else if (kind === 'config_option_update') {
      // 配置项变更通知（先于 set_config_option 响应到达）：刷新缓存并转发渲染层
      if (Array.isArray(update.configOptions)) acpConfigOptions = update.configOptions;
      sendAcpEvent({ type: 'config-options', configOptions: update.configOptions });
    } else if (kind === 'tool_call') {
      // 工具调用卡片：字段直接挂在 update 上，detail 与审批窗共用同一提取逻辑
      sendAcpEvent({
        type: 'tool-call',
        call: {
          toolCallId: ensureString(update.toolCallId).slice(0, 100),
          title: ensureString(update.title).slice(0, 200),
          kind: ensureString(update.kind).slice(0, 40),
          status: ensureString(update.status).slice(0, 40),
          detail: extractAcpToolDetail(update),
        },
      });
    } else if (kind === 'tool_call_update') {
      const ev = { type: 'tool-call-update', toolCallId: ensureString(update.toolCallId).slice(0, 100) };
      if (typeof update.status === 'string') ev.status = update.status.slice(0, 40);
      const out = extractAcpRawOutput(update.rawOutput);
      if (out) ev.output = out;
      sendAcpEvent(ev);
    }
    // 其它 sessionUpdate 类型暂不处理
  });
  client.on('permission', () => {
    logLine('[acp] 收到权限请求（交由审批窗处理）');
  });
  client.on('stderr', (line) => logLine(`[acp stderr] ${line}`));
  client.on('exit', () => {
    logLine('[acp] 进程已退出');
    sendAcpEvent({ type: 'status', state: 'exited' });
    if (acpClient === client) disposeAcpClient('进程退出');
  });
  // 权限请求交由原生审批窗异步决策（acp-client 侧有超时/非法结构兜底）
  client.setPermissionHandler((params) => requestAcpPermission(params));
  acpClient = client;
  sendAcpEvent({ type: 'status', state: 'connecting' });
  try {
    const init = await client.start();
    let sessionId;
    let configOptions;
    let resumed = false;
    if (wantSessionId) {
      // 恢复既有会话：失败明确报错并销毁 client，不静默回退 newSession
      loadPending = true;
      let s;
      try {
        s = await client.loadSession(wantSessionId);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        logLine(`ACP 恢复会话失败: ${msg}`);
        if (acpClient === client) disposeAcpClient('恢复会话失败');
        sendAcpEvent({ type: 'status', state: 'error', message: `恢复会话失败: ${msg}` });
        return { ok: false, error: `恢复会话失败: ${msg}` };
      } finally {
        loadPending = false;
      }
      sessionId = ensureString(s && s.sessionId) || client.sessionId || wantSessionId;
      configOptions = s && s.configOptions;
      resumed = true;
      // agent 未重放历史时从本地 wire.jsonl 自绘（双保险）
      if (!loadReplayed) sendAcpLocalHistory(wantSessionId);
    } else {
      const s = await client.newSession();
      sessionId = s.sessionId;
      configOptions = s.configOptions;
    }
    acpConfigOptions = Array.isArray(configOptions) ? configOptions : null;
    sendAcpEvent({ type: 'status', state: 'ready', agentInfo: init.agentInfo, sessionId, configOptions, cwd, resumed });
    return { ok: true, agentInfo: init.agentInfo, sessionId, configOptions, cwd, resumed };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logLine(`ACP 会话启动失败: ${msg}`);
    if (acpClient === client) disposeAcpClient('启动失败');
    sendAcpEvent({ type: 'status', state: 'error', message: msg });
    return { ok: false, error: msg };
  }
});

// 聊天图片约束：MIME 白名单 / 单张解码后 ≤10MB / 一次 ≤4 张（渲染层与主进程两侧同规则校验）
const CHAT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGE_MAX_COUNT = 4;

ipcMain.handle('acp-chat:prompt', async (_e, text, images) => {
  if (!acpClient) return { ok: false, error: 'ACP 会话未连接，请先启动' };
  // 服务端侧二次校验图片参数（渲染层不可信，任一非法即整体拒绝）
  const rawImages = Array.isArray(images) ? images : [];
  const cleanImages = [];
  for (const img of rawImages.slice(0, CHAT_IMAGE_MAX_COUNT + 1)) {
    const mimeType = img && typeof img === 'object' ? ensureString(img.mimeType) : '';
    const data = img && typeof img === 'object' ? ensureString(img.data) : '';
    // 非空标准 base64（拒绝非法字符，Buffer.from 对脏输入过于宽容，先正则把关）
    const base64Ok = data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
    if (!CHAT_IMAGE_MIMES.has(mimeType) || !base64Ok
      || Buffer.from(data, 'base64').length > CHAT_IMAGE_MAX_BYTES) {
      logLine(`[acp] prompt 图片参数非法，已拒绝（mimeType=${mimeType || '空'}，data 长度=${data.length}）`);
      return { ok: false, error: '图片参数非法' };
    }
    cleanImages.push({ mimeType, data });
  }
  if (rawImages.length > CHAT_IMAGE_MAX_COUNT) {
    logLine(`[acp] prompt 图片数量超限（${rawImages.length} > ${CHAT_IMAGE_MAX_COUNT}），已拒绝`);
    return { ok: false, error: '图片参数非法' };
  }
  const textStr = typeof text === 'string' ? text : '';
  // 无图时维持原行为（纯文本必须非空）；有图时空文本以单空格兜底
  if (!textStr.trim() && cleanImages.length === 0) return { ok: false, error: '消息内容为空' };
  const finalText = textStr.trim() ? textStr : ' ';
  try {
    const r = await acpClient.prompt(finalText.slice(0, 8000), cleanImages);
    sendAcpEvent({ type: 'prompt-done', stopReason: r.stopReason });
    return { ok: true, stopReason: r.stopReason };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // 进程退出导致的失败：exit 事件已置空 acpClient，补一条状态通知
    if (!acpClient) sendAcpEvent({ type: 'status', state: 'exited' });
    return { ok: false, error: msg };
  }
});

// 会话配置项切换：白名单校验（configId 须在缓存的 configOptions 内，value 须 ∈ 该项 options 取值集合）
ipcMain.handle('acp-chat:set-config', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const configId = ensureString(p.configId).slice(0, 200);
  const value = ensureString(p.value).slice(0, 200);
  if (!configId || !value) return { ok: false, error: 'configId/value 不能为空' };
  if (!acpClient) return { ok: false, error: '会话未连接' };
  const cached = Array.isArray(acpConfigOptions) ? acpConfigOptions : [];
  const item = cached.find((c) => c && typeof c === 'object' && c.id === configId);
  const allowed = item && Array.isArray(item.options)
    ? item.options.map((op) => (op && typeof op === 'object' ? ensureString(op.value) : '')).filter(Boolean)
    : [];
  if (!item || !allowed.includes(value)) {
    logLine(`[acp] set-config 拒绝非法配置: ${configId}=${value}`);
    return { ok: false, error: '非法配置项或取值' };
  }
  try {
    const r = await acpClient.setConfigOption(configId, value);
    if (r && Array.isArray(r.configOptions)) acpConfigOptions = r.configOptions;
    return { ok: true, configOptions: r && r.configOptions };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logLine(`[acp] set-config 失败: ${msg}`);
    return { ok: false, error: msg };
  }
});

// 取消当前在途 prompt（cancel 约定同步、不抛异常，仍防御性 try）
ipcMain.handle('acp-chat:cancel', () => {
  if (!acpClient) return { ok: false };
  try { acpClient.cancel(); } catch { /* ignore */ }
  return { ok: true };
});

// 聊天图片选择：系统对话框选图（≤4 张），按扩展名映射 MIME；>10MB 或读取失败的计入 skipped
ipcMain.handle('acp-chat:pick-images', async () => {
  const extToMime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  try {
    const parent = acpChatWindow && !acpChatWindow.isDestroyed() ? acpChatWindow : undefined;
    const opts = {
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    };
    const result = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { ok: true, images: [], skipped: 0 };
    }
    const images = [];
    let skipped = 0;
    for (const filePath of result.filePaths.slice(0, CHAT_IMAGE_MAX_COUNT)) {
      try {
        const mimeType = extToMime[path.extname(filePath).slice(1).toLowerCase()];
        const buf = fs.readFileSync(filePath);
        if (!mimeType || buf.length > CHAT_IMAGE_MAX_BYTES) {
          skipped += 1;
          logLine(`[acp] 选图跳过: ${path.basename(filePath).slice(0, 100)}（${!mimeType ? '类型不支持' : '超过 10MB'}）`);
          continue;
        }
        images.push({
          name: path.basename(filePath).slice(0, 100),
          mimeType,
          data: buf.toString('base64'),
          size: buf.length,
        });
      } catch (err) {
        skipped += 1;
        logLine(`[acp] 选图读取失败: ${path.basename(filePath).slice(0, 100)} - ${err && err.message ? err.message : err}`);
      }
    }
    logLine(`[acp] 选图完成: 成功 ${images.length} 张，跳过 ${skipped} 张`);
    return { ok: true, images, skipped };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logLine(`[acp] 选图失败: ${msg}`);
    return { ok: false, error: msg };
  }
});

// 降级入口：打开 Web UI 高级面板（主窗口不存在时 showMainWindow 内部会建窗并起服务，直接复用）
ipcMain.handle('acp-chat:open-webui', () => {
  try {
    showMainWindow();
    logLine('[acp] 已从聊天窗打开 Web UI 高级面板');
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logLine(`[acp] 打开 Web UI 失败: ${msg}`);
    return { ok: false, error: msg };
  }
});

// ---------- 重启 ----------
// restartServer 杀进程整体重启，仅保留给手动重载/恢复会话等需要重建服务的场景；
// 「新建对话」走下方 newConversationInPlace（点击 Web UI 官方按钮，不重启进程）
async function restartServer() {
  if (restartPromise) return restartPromise;
  restartPromise = (async () => {
    closeOverlay(); // 重启前关闭覆盖层，避免 loading 页被覆盖
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

// 新建对话（不重启进程）：聚焦主窗口并点击 Web UI 侧栏官方「新建对话」按钮（.btn-new-chat）；
// 当前不在 Web UI 页时先回到 Web UI，服务未运行时退化为 restartServer（重启本身就是新对话）
async function newConversationInPlace() {
  showMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  closeOverlay(); // 覆盖层（会话启动器/设置）打开时先关掉，否则点击发生在被遮挡的 Web UI 上
  const wc = mainWindow.webContents;
  // 判断当前是否已在 loopback 的 Web UI 页（与注入 FAB 样式处同一判定）
  let onWebUI = false;
  try {
    const u = new URL(wc.getURL());
    onWebUI = (u.protocol === 'http:' || u.protocol === 'https:')
      && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  } catch { /* ignore */ }
  if (!onWebUI) {
    if (knownServerBase && knownServerToken) {
      try {
        await wc.loadURL(knownServerBase + '/#token=' + encodeURIComponent(knownServerToken));
      } catch (err) {
        logLine(`新建对话：加载 Web UI 失败: ${err.message}`);
        return;
      }
    } else {
      // 服务未运行：重启服务本身就是新对话
      logLine('新建对话：服务未运行，改为重启服务');
      restartServer();
      return;
    }
  }
  // 程序化 click() 对隐藏元素同样生效，按钮存在即可点。
  // 候选选择器数组逐个尝试（Playwright 实测 2026-07：官方按钮为侧栏 button.btn-new-chat「新建对话」，
  // JS click 后原地切回新空会话，无整页 reload/新窗口）；兜底再按按钮文本匹配一次
  const CLICK_NEW_CHAT_JS = `(() => { try {
    const sels = ['.btn-new-chat', 'button[aria-label*="新建对话"]', 'button[aria-label*="新建会话"]'];
    for (const s of sels) { const b = document.querySelector(s); if (b) { b.click(); return 'clicked'; } }
    for (const b of document.querySelectorAll('button, a, [role="button"]')) {
      const t = (b.textContent || '').trim();
      if (t === '新建对话' || t === '新对话' || /^new chat$/i.test(t)) { b.click(); return 'clicked'; }
    }
    return 'not-found';
  } catch (e) { return 'not-found'; } })()`;
  let result = await wc.executeJavaScript(CLICK_NEW_CHAT_JS).catch(() => 'not-found');
  if (result === 'not-found') {
    // Vue 侧栏可能尚未渲染完，等 500ms 重试一次
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await wc.executeJavaScript(CLICK_NEW_CHAT_JS).catch(() => 'not-found');
  }
  if (result === 'clicked') {
    logLine('新建对话：已点击 Web UI 官方新建按钮');
  } else {
    logLine('新建对话：未找到 Web UI 新建按钮（候选选择器均未命中）');
  }
}

// ---------- 默认模型切换 ----------
// 读取当前默认模型，失败/为空时回退内置默认
function getCurrentDefaultModel() {
  try {
    const data = configManager.loadConfigToml().data;
    const model = data && typeof data.default_model === 'string' ? data.default_model.trim() : '';
    if (model) return model;
  } catch { /* 配置读取失败时使用默认值 */ }
  return 'kimi-for-coding';
}

// 拉取服务端模型列表（容错解析多种响应形态），失败回退内置候选；结果写入 cachedModels
async function fetchModels() {
  let models = [];
  try {
    if (serverCaps.models && knownServerBase && knownServerToken) {
      const url = `${knownServerBase}${serverCaps.modelsPath || '/api/v1/models'}`;
      const res = await httpGet(url, knownServerToken);
      if (res && res.status === 200) {
        try {
          const body = JSON.parse(res.data);
          // 兼容数组本身 / obj.models / obj.data 三种形态
          const arr = Array.isArray(body) ? body
            : (body && typeof body === 'object'
              ? (Array.isArray(body.models) ? body.models : (Array.isArray(body.data) ? body.data : null))
              : null);
          if (arr) {
            // 元素为字符串或含 id/model/name 字段的对象，去重去空
            const parsed = arr.map((item) => {
              if (typeof item === 'string') return item.trim();
              if (item && typeof item === 'object') return String(item.id || item.model || item.name || '').trim();
              return '';
            }).filter(Boolean);
            models = [...new Set(parsed)];
          }
        } catch {
          logLine('模型列表响应解析失败，使用回退候选');
        }
      }
    }
  } catch (err) {
    logLine(`获取模型列表失败: ${err.message}`);
  }
  if (models.length === 0) {
    // 回退：内置候选（去重去空）
    models = [...new Set([getCurrentDefaultModel(), 'kimi-for-coding', 'kimi-for-coding-highspeed'].filter(Boolean))];
  }
  // 确保当前默认模型始终在列表首位附近
  const current = getCurrentDefaultModel();
  if (current && !models.includes(current)) models.unshift(current);
  cachedModels = models;
  return models;
}

// 防抖刷新托盘与应用菜单中的模型下拉
function refreshModelMenus() {
  if (modelMenuRefreshTimer) clearTimeout(modelMenuRefreshTimer);
  modelMenuRefreshTimer = setTimeout(() => {
    modelMenuRefreshTimer = null;
    try { updateTrayStatus(); } catch { /* ignore */ } // 内部会重建托盘菜单
    try { buildMenu(); } catch { /* ignore */ }
  }, 500);
}

// 构建「默认模型」子菜单（radio 标记当前默认模型）
function buildModelSubmenu() {
  if (!cachedModels || cachedModels.length === 0) {
    return [{ label: '（服务就绪后可用）', enabled: false }];
  }
  const current = getCurrentDefaultModel();
  return cachedModels.map((m) => ({
    label: m,
    type: 'radio',
    checked: m === current,
    click: () => switchModel(m),
  }));
}

// 切换默认模型：写入 config.toml（doctor 校验失败自动回滚），成功后询问是否重启服务
async function switchModel(modelId) {
  if (!modelId || modelId === getCurrentDefaultModel()) return;
  try {
    const cfg = loadConfig();
    const cli = resolveCliPath(cfg);
    if (!cli) {
      dialog.showMessageBox({ type: 'error', title: '切换默认模型', message: '未找到 kimi CLI，无法写入配置' });
      return;
    }
    const data = configManager.loadConfigToml().data || {};
    const prev = typeof data.default_model === 'string' ? data.default_model : '';
    data.default_model = modelId;
    await configManager.saveConfigToml(data, cli, buildKimiEnv(cfg));
    logLine(`默认模型已切换: ${prev || '(空)'} -> ${modelId}`);
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: '切换默认模型',
      message: `默认模型已切换为 ${modelId}，立即重启服务生效？`,
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      await restartServer();
    }
  } catch (err) {
    // doctor 校验失败时配置已自动回滚
    logLine(`切换默认模型失败: ${err.message}`);
    dialog.showMessageBox({ type: 'error', title: '切换默认模型', message: `切换失败：${err.message}` });
  }
  refreshModelMenus();
}

// ---------- 轮换访问令牌 ----------
// 调用 CLI 生成新 token，更新内存状态并重载窗口（loadMain 内部会重建 WS 订阅）
async function rotateToken() {
  if (!knownServerBase) {
    dialog.showMessageBox({ type: 'warning', title: '轮换访问令牌', message: '服务未就绪，无法轮换令牌' });
    return;
  }
  const confirm = await dialog.showMessageBox({
    type: 'question',
    title: '轮换访问令牌',
    message: '确定要轮换访问令牌吗？',
    detail: '旧令牌将立即失效，窗口会重新加载，继续？',
    buttons: ['轮换', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (confirm.response !== 0) return;
  const cfg = loadConfig();
  const cli = resolveCliPath(cfg);
  if (!cli) {
    dialog.showMessageBox({ type: 'error', title: '轮换访问令牌', message: '未找到 kimi CLI，无法轮换令牌' });
    return;
  }
  const runResult = await new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cli, ['web', 'rotate-token'], { env: buildKimiEnv(cfg), windowsHide: true });
    } catch (err) {
      done({ error: err.message });
      return;
    }
    const timer = setTimeout(() => {
      forceKill(child.pid);
      done({ error: '轮换令牌超时（20 秒）' });
    }, 20000);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); done({ error: err.message }); });
    child.on('exit', (code) => { clearTimeout(timer); done({ code, stderr }); });
  });
  if (runResult.error || runResult.code !== 0) {
    const msg = runResult.error || (runResult.stderr || '').trim() || `轮换进程退出码 ${runResult.code}`;
    logLine(`轮换访问令牌失败: ${msg}`);
    dialog.showMessageBox({ type: 'error', title: '轮换访问令牌', message: `轮换失败：${msg}` });
    return;
  }
  // 等待 token 文件落盘后读取新 token
  await new Promise((r) => setTimeout(r, 500));
  const newToken = readServerToken();
  if (!newToken) {
    logLine('轮换访问令牌失败：未读取到新令牌');
    dialog.showMessageBox({ type: 'error', title: '轮换访问令牌', message: '轮换失败：未读取到新令牌' });
    return;
  }
  knownServerToken = newToken;
  // 废弃旧 WS 订阅并清理，loadMain 会以新 token 重建订阅
  wsGeneration++;
  cleanupWsPermanent();
  loadMain(`${knownServerBase}/#token=${encodeURIComponent(newToken)}`);
  logLine('访问令牌已轮换，窗口已重新加载');
  dialog.showMessageBox({ type: 'info', title: '轮换访问令牌', message: '访问令牌已轮换，窗口已重新加载' });
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
        content: '已最小化到系统托盘。单击图标恢复窗口。',
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
    { label: '新建对话', click: () => { newConversationInPlace(); } },
    { label: '默认模型', submenu: buildModelSubmenu() },
    { label: '多实例', submenu: buildInstancesSubmenu() },
    { label: '设置…', click: () => { showMainWindow(); showSetup('manual'); } },
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
  tray.on('double-click', showMainWindow);
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
    // 实例缓存超过 10 秒未刷新时后台触发刷新（刷新完成后会自行重建托盘菜单）
    if (!instancesCacheRefreshing && Date.now() - instancesCacheAt > 10000) {
      refreshInstancesCache();
    }
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
// 新窗策略（主窗口与覆盖层共用）：同源 Kimi 本地服务保留，其他 http(s) 交默认浏览器，未知协议拒绝
function handleWindowOpen({ url }) {
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
}

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
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    // 无边框：原生标题栏与 Web UI 品牌区/会话头部重复，改为悬浮窗控（右上角叠加 min/max/close）
    ...framelessOpts(),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      partition: 'persist:kimi-code',
      // 供 preload 识别主窗口（注入拖拽条/菜单按钮），辅助窗口不带此标记
      additionalArguments: ['--kcd-main-window'],
    },
  });
  // 无边框窗口上禁止 Alt 唤出原生菜单条（菜单加速键不受影响，菜单经页面内 ☰ 按钮弹出）
  applyFrameless(mainWindow);
  if (state.maximized) mainWindow.maximize();

  // 应用设置：窗口置顶与界面缩放
  const appCfg = loadConfig();
  mainWindow.setAlwaysOnTop(appCfg.alwaysOnTop === true);
  const appZoom = typeof appCfg.zoomFactor === 'number' && Number.isFinite(appCfg.zoomFactor) ? appCfg.zoomFactor : 1;
  mainWindow.webContents.setZoomFactor(Math.min(2, Math.max(0.5, appZoom)));

  const saveWindowState = () => {
    if (!mainWindow) return;
    const maximized = mainWindow.isMaximized();
    const b = maximized ? readJSON(stateFile(), {}) : mainWindow.getBounds();
    writeJSON(stateFile(), { x: b.x, y: b.y, width: b.width, height: b.height, maximized });
  };

  mainWindow.on('minimize', (e) => {
    if (loadConfig().minimizeToTray === false) {
      saveWindowState();
      return; // 走系统默认最小化
    }
    e.preventDefault();
    saveWindowState();
    hideToTray();
  });

  mainWindow.on('close', (e) => {
    if (!quitting) {
      if (loadConfig().closeToTray === false) {
        quitting = true;
        app.quit(); // 走 before-quit 优雅退出
        return;
      }
      e.preventDefault();
      saveWindowState();
      hideToTray();
      return;
    }
    saveWindowState();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // 覆盖层子视图随窗口销毁：显式关闭其 webContents 防泄漏（Electron 不会自动销毁），再清引用
    if (overlayView) {
      try { overlayView.webContents.close(); } catch { /* ignore */ }
      overlayView = null;
      overlayKind = null;
    }
  });

  // 窗口聚焦状态跟踪
  mainWindow.on('focus', () => { mainWindowFocused = true; });
  mainWindow.on('blur', () => { mainWindowFocused = false; });

  // 窗口尺寸变化时同步覆盖层 bounds（覆盖层存在才处理）
  mainWindow.on('resize', () => {
    if (!overlayView || !mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getContentSize();
    overlayView.setBounds({ x: 0, y: 0, width: w, height: h });
  });

  // 强化导航：同源 Kimi 本地服务保留，其他 http(s) 交默认浏览器，未知协议拒绝（策略与覆盖层共用）
  mainWindow.webContents.setWindowOpenHandler(handleWindowOpen);
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

  // 主窗口注入：顶部拖拽条样式（无边框窗口拖动用，本地页与 Web UI 页均需要）；
  // 会话页（loopback http(s)）追加会话头部样式；☰ 菜单按钮 DOM 与样式由 menu-panel.js 自带，
  // insertCSS 在主进程侧执行，不受页面 CSP 的 style-src 限制
  mainWindow.webContents.on('did-finish-load', () => {
    try {
      // 拖拽条：10px 只覆盖页面顶部 padding 区，不遮挡 Web UI 头部交互；双击 drag 区自动切换最大化
      mainWindow.webContents.insertCSS(
        '#kcd-drag-strip{position:fixed;top:0;left:0;right:0;height:10px;-webkit-app-region:drag;z-index:2147483646;}'
      );
      const u = new URL(mainWindow.webContents.getURL());
      const isLoopback = (u.protocol === 'http:' || u.protocol === 'https:')
        && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
      if (!isLoopback) return;
      mainWindow.webContents.insertCSS([
        // 会话头部：右让 228px 避开悬浮窗控与 ☰ 菜单按钮（138px 窗控 + 38px 按钮 + 余量），
        // 整行作拖拽区、交互控件除外；背景强制对齐窗口背景色（亮 #fbfaf9/暗 #181817，同 windowBackground()），
        // 与右上角 OS 悬浮窗控融为一体、消除异色补丁；box-shadow 置 none 去掉头部底部分隔阴影造成的接缝
        'header.chat-header{padding-right:228px !important;-webkit-app-region:drag;background:#fbfaf9 !important;box-shadow:none !important;}',
        '@media (prefers-color-scheme:dark){header.chat-header{background:#181817 !important;}}',
        'header.chat-header button,header.chat-header a,header.chat-header input,header.chat-header select,header.chat-header textarea,header.chat-header [role=button],header.chat-header [contenteditable]{-webkit-app-region:no-drag;}',
      ].join('\n'));
      // ☰ 菜单面板：Web UI 页 CSP（default-src 'self'）拦截 <script> 文本节点注入（实测被拒绝执行），
      // 改由主进程 executeJavaScript 在页面主世界执行（DevTools 级求值不受页面 CSP 限制）；
      // menu-panel.js 自带 __kcdMenuPanelLoaded 幂等守卫，重复执行安全
      try {
        if (menuPanelCodeCache === null) {
          menuPanelCodeCache = fs.readFileSync(path.join(__dirname, 'menu-panel.js'), 'utf8');
        }
        mainWindow.webContents.executeJavaScript(menuPanelCodeCache).catch(() => { /* 页面已销毁等 */ });
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  });

  // 窗控区颜色同步：导航/加载完成时刷新悬浮窗控配色（离开 Web UI 页时清掉采样色，
  // 本地页恒为 windowBackground()；Web UI 页等 preload 采样上报后再换成页面实际颜色）
  const syncTitlebarColor = () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!isLoopbackWebUIUrl(mainWindow.webContents.getURL())) {
        mainTitlebarSampleColor = null;
      }
      applyTitlebarOverlay(mainWindow);
    } catch { /* ignore */ }
  };
  mainWindow.webContents.on('did-navigate', syncTitlebarColor);
  mainWindow.webContents.on('did-navigate-in-page', syncTitlebarColor);
  mainWindow.webContents.on('did-finish-load', syncTitlebarColor);

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
// 窗口置顶：应用 + 写回 config.json，供设置页与下次启动读取（原生菜单勾选与菜单面板共用）
function setAlwaysOnTopFlag(v) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(v);
  const c = readJSON(configFile(), {});
  c.alwaysOnTop = v === true;
  writeJSON(configFile(), c);
}

// 运行 kimi doctor 并弹窗展示结果（原生菜单与菜单面板共用）
function runKimiDoctorWithDialog() {
  return runKimiDoctor().then((result) => {
    const title = result.ok ? '诊断完成' : '诊断失败';
    const detail = result.ok
      ? `kimi doctor 诊断通过。\n\n输出：\n${result.output}`
      : `${result.error}\n\n输出：\n${result.output}`;
    dialog.showMessageBox({ type: result.ok ? 'info' : 'error', title, message: title, detail });
  });
}

// 打包诊断信息并弹窗展示结果（原生菜单与菜单面板共用）
async function packDiagnosticsWithDialog() {
  const r = await packDiagnostics();
  dialog.showMessageBox({
    type: r.ok ? 'info' : 'error',
    title: '打包诊断信息',
    message: r.ok ? '诊断包已保存' : '打包失败',
    detail: r.ok ? r.path : (r.message || ''),
  });
}

// 关于对话框（原生菜单与菜单面板共用）
function showAboutDialog() {
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
}

// 隐藏菜单栏仅作快捷键载体（setMenuBarVisibility(false)，不再 popup）；
// 顶层结构与 menu-panel.js 面板分组对齐（会话/模型/多实例/设置/视图/帮助 + 底部应用动作）
function buildMenu() {
  const template = [
    {
      label: '会话',
      submenu: [
        { label: '打开会话启动器', accelerator: 'CmdOrCtrl+Shift+S', click: showSessionLauncher },
        { label: '新建对话', accelerator: 'CmdOrCtrl+Shift+N', click: () => { newConversationInPlace(); } },
        { label: '原生聊天（新会话）…', click: showAcpChatWindow },
      ],
    },
    { label: '模型', submenu: buildModelSubmenu() },
    { label: '多实例', submenu: buildInstancesSubmenu() },
    {
      label: '设置',
      submenu: [
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => showSetup('manual') },
        { label: '手动输入地址…', accelerator: 'CmdOrCtrl+L', click: () => showSetup('manual') },
        { label: '轮换访问令牌…', click: rotateToken },
        { label: '局域网访问…', click: showLanWindow },
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
          checked: loadConfig().alwaysOnTop === true,
          click: (item) => setAlwaysOnTopFlag(item.checked),
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
        { label: '运行 kimi doctor', click: () => { void runKimiDoctorWithDialog(); } },
        { label: 'IDE 接入向导…', click: () => showSetup('manual', 'ide') },
        { label: 'Prompt 模板库…', click: showPromptLibrary },
        { label: '命令与快捷键速查…', accelerator: 'F1', click: showHelpWindow },
        { label: '打包诊断信息…', click: () => { void packDiagnosticsWithDialog(); } },
        { label: '关于', click: showAboutDialog },
      ],
    },
    {
      label: '应用',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => { const wc = foregroundContents(); if (wc) wc.reload(); } },
        { role: 'quit', label: '退出' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------

// 配置中心 IPC
ipcMain.handle('config:loadConfigToml', () => {
  try {
    const result = configManager.loadConfigToml();
    return { ok: true, data: result.data, path: result.path };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:saveConfigToml', async (_e, data) => {
  try {
    const cfg = loadConfig();
    const cli = resolveCliPath(cfg);
    if (!cli) throw new Error('未找到 kimi CLI');
    await configManager.saveConfigToml(data, cli, buildKimiEnv(cfg));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:loadTuiToml', () => {
  try {
    const result = configManager.loadTuiToml();
    return { ok: true, data: result.data, path: result.path };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:saveTuiToml', async (_e, data) => {
  try {
    const cfg = loadConfig();
    const cli = resolveCliPath(cfg);
    if (!cli) throw new Error('未找到 kimi CLI');
    await configManager.saveTuiToml(data, cli, buildKimiEnv(cfg));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:loadMcpJson', () => {
  try {
    const result = configManager.loadMcpJson(true);
    return { ok: true, data: result.data, path: result.path };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:saveMcpJson', (_e, data) => {
  try {
    const result = configManager.saveMcpJson(data, true);
    return { ok: true, path: result.path };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:listProviders', async () => {
  try {
    const cfg = loadConfig();
    const cli = resolveCliPath(cfg);
    if (!cli) throw new Error('未找到 kimi CLI');
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawn(cli, ['provider', 'list', '--json'], { env: buildKimiEnv(cfg), windowsHide: true });
      } catch (err) {
        return resolve({ ok: false, error: err.message });
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, error: '获取供应商列表超时' });
      }, 15000);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve({ ok: false, error: stderr || `退出码 ${code}` });
        try {
          const data = JSON.parse(stdout);
          resolve({ ok: true, providers: Array.isArray(data) ? data : (data.providers || []) });
        } catch (e) {
          resolve({ ok: false, error: '解析供应商 JSON 失败' });
        }
      });
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:removeProvider', async (_e, name) => {
  try {
    const cfg = loadConfig();
    const cli = resolveCliPath(cfg);
    if (!cli) throw new Error('未找到 kimi CLI');
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cli, ['provider', 'remove', String(name)], { env: buildKimiEnv(cfg), windowsHide: true });
      } catch (err) {
        return resolve({ ok: false, error: err.message });
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, error: '超时' });
      }, 15000);
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
      child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, error: code === 0 ? undefined : (stderr || `退出码 ${code}`) }); });
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:addProviderCatalog', async (_e, args) => {
  try {
    const cfg = loadConfig();
    const cli = resolveCliPath(cfg);
    if (!cli) throw new Error('未找到 kimi CLI');
    const { type, apiKey, baseUrl, models, modelsDevDir } = args || {};
    if (!type) throw new Error('缺少供应商类型');
    const spawnArgs = ['provider', 'catalog', 'add', '--type', String(type)];
    if (apiKey) spawnArgs.push('--api-key', String(apiKey));
    if (baseUrl) spawnArgs.push('--base-url', String(baseUrl));
    if (models) spawnArgs.push('--models', String(models));
    if (modelsDevDir) spawnArgs.push('--models-dev-dir', String(modelsDevDir));
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cli, spawnArgs, { env: buildKimiEnv(cfg), windowsHide: true });
      } catch (err) {
        return resolve({ ok: false, error: err.message });
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, error: '添加供应商超时' });
      }, 30000);
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
      child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, error: code === 0 ? undefined : (stderr || `退出码 ${code}`) }); });
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- Skills 管理 IPC ----------
ipcMain.handle('skills:list', () => {
  try {
    return skillsManager.scanSkills();
  } catch (err) {
    logLine(`skills:list 失败: ${err.message}`);
    return { ok: false, error: err.message, skills: [] };
  }
});

ipcMain.handle('skills:save', (_e, payload) => {
  try {
    return skillsManager.saveSkill(payload || {});
  } catch (err) {
    logLine(`skills:save 失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skills:delete', (_e, name) => {
  try {
    return skillsManager.deleteSkill(name);
  } catch (err) {
    logLine(`skills:delete 失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ---------- 插件管理 IPC ----------
ipcMain.handle('plugins:list', () => {
  try {
    return pluginsManager.listPlugins();
  } catch (err) {
    logLine(`plugins:list 失败: ${err.message}`);
    return { ok: false, message: err.message, plugins: [] };
  }
});

ipcMain.handle('plugins:setEnabled', (_e, id, enabled) => {
  try {
    const result = pluginsManager.setPluginEnabled(id, enabled === true);
    if (result.ok) logLine(`插件 ${id} 已${enabled === true ? '启用' : '禁用'}`);
    return result;
  } catch (err) {
    logLine(`plugins:setEnabled 失败: ${err.message}`);
    return { ok: false, message: err.message };
  }
});

// ---------- 调试端点 IPC ----------
ipcMain.handle('debug:fetchEndpoints', async () => {
  if (!knownServerBase) {
    return { ok: false, message: '服务未连接' };
  }
  try {
    const url = new URL('/api/v1/debug/', knownServerBase);
    const res = await httpRequest('GET', url, knownServerToken);
    if (!res) {
      return { ok: false, message: '请求失败（网络错误或超时）' };
    }
    return { ok: true, status: res.status, body: res.data };
  } catch (err) {
    logLine(`debug:fetchEndpoints 失败: ${err.message}`);
    return { ok: false, message: err.message };
  }
});

// ---------- 多实例 IPC ----------
ipcMain.handle('instances:list', async () => {
  try {
    const list = instancesManager.scanInstances(getKimiHomeDir());
    // 存活实例并发探测可达性（host 缺失用 127.0.0.1 兜底），并标注当前连接
    await Promise.all(list.map(async (inst) => {
      inst.responding = inst.alive
        ? await instancesManager.probeInstance(inst.host || '127.0.0.1', inst.port)
        : false;
      inst.current = isCurrentInstance(inst);
    }));
    return list;
  } catch (err) {
    logLine(`instances:list 失败: ${err.message}`);
    return [];
  }
});

ipcMain.handle('instances:switch', async (_e, target) => {
  const t = target && typeof target === 'object' ? target : {};
  const host = typeof t.host === 'string' && t.host.trim() ? t.host.trim() : '127.0.0.1';
  const port = Number(t.port);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    return { ok: false, error: '无效的端口' };
  }
  const r = await connectToInstance(host, port);
  if (r.ok) refreshInstancesCache(true); // 切换后刷新「当前」标记
  return r;
});

// ---------- IDE 接入 IPC ----------
ipcMain.handle('ide:detect', async () => {
  try {
    const cli = resolveCliPath(loadConfig());
    const [acp, editors] = await Promise.all([
      ideIntegration.detectAcp(cli),
      Promise.resolve().then(() => ideIntegration.detectEditors()),
    ]);
    return { acp, zed: editors.zed, jetbrains: editors.jetbrains };
  } catch (err) {
    logLine(`ide:detect 失败: ${err.message}`);
    return {
      acp: { available: false, detail: `检测异常: ${err.message}` },
      zed: { installed: false, execPath: null, settingsPath: null },
      jetbrains: { installed: false, ides: [] },
    };
  }
});

ipcMain.handle('ide:applyZed', () => {
  try {
    const cli = resolveCliPath(loadConfig());
    if (!cli) return { ok: false, manualRequired: true, reason: '未找到 kimi CLI' };
    const editors = ideIntegration.detectEditors();
    return ideIntegration.applyZedConfig(editors.zed.settingsPath, cli);
  } catch (err) {
    logLine(`ide:applyZed 失败: ${err.message}`);
    return { ok: false, manualRequired: true, reason: err.message };
  }
});

ipcMain.handle('ide:getSnippet', (_e, editor) => {
  try {
    // CLI 未安装时回退默认安装路径，保证片段可直接粘贴使用
    const cliPath = resolveCliPath(loadConfig()) || defaultCliCandidates()[0];
    if (editor === 'zed') return JSON.stringify(ideIntegration.buildZedSnippet(cliPath), null, 2);
    if (editor === 'jetbrains') return ideIntegration.buildJetBrainsGuide(cliPath);
    if (editor === 'generic') return ideIntegration.buildGenericSnippet(cliPath);
    return { ok: false, error: `未知的编辑器类型: ${String(editor)}` };
  } catch (err) {
    logLine(`ide:getSnippet 失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

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
      port: cfg.port || '',
      host: cfg.host || '',
      logLevel: cfg.logLevel || '',
      kimiCodeHome: cfg.kimiCodeHome || '',
      noAutoUpdate: cfg.noAutoUpdate === true,
      disableTelemetry: cfg.disableTelemetry === true,
      autoStartCli: cfg.autoStartCli !== false,
      debugMode: cfg.debugMode === true,
      pluginMarketplaceUrl: cfg.pluginMarketplaceUrl || '',
      oauthHost: cfg.oauthHost || '',
      selfHostedBaseUrl: cfg.selfHostedBaseUrl || '',
      tempModel: cfg.tempModel || {},
      // 应用设置（设置页「应用设置」面板初始值）
      theme: ['light', 'dark', 'system'].includes(cfg.theme) ? cfg.theme : 'system',
      zoomFactor: typeof cfg.zoomFactor === 'number' && Number.isFinite(cfg.zoomFactor) ? cfg.zoomFactor : 1,
      closeToTray: cfg.closeToTray !== false,
      minimizeToTray: cfg.minimizeToTray !== false,
      alwaysOnTop: cfg.alwaysOnTop === true,
      launchAtLogin: cfg.launchAtLogin === true,
      notificationsEnabled: cfg.notificationsEnabled !== false,
      globalHotkeyEnabled: cfg.globalHotkeyEnabled !== false,
    },
    loadedUrl,
    isDev,
  };
});

ipcMain.handle('setup:save', async (_e, payload) => {
  const p = payload || {};
  const prev = loadConfig();
  const portRaw = typeof p.port === 'number' ? p.port : parseInt(ensureString(p.port), 10);
  const cfg = {
    mode: p.mode === 'manual' ? 'manual' : 'auto',
    cliPath: ensureString(p.cliPath),
    manualUrl: ensureString(p.manualUrl),
    shellPath: ensureString(p.shellPath),
    httpProxy: ensureString(p.httpProxy),
    httpsProxy: ensureString(p.httpsProxy),
    allProxy: ensureString(p.allProxy),
    noProxy: ensureString(p.noProxy),
    port: Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : null,
    host: ensureString(p.host),
    logLevel: ensureString(p.logLevel),
    kimiCodeHome: ensureString(p.kimiCodeHome),
    noAutoUpdate: p.noAutoUpdate === true,
    disableTelemetry: p.disableTelemetry === true,
    autoStartCli: p.autoStartCli !== false,
    debugMode: p.debugMode === true,
    pluginMarketplaceUrl: ensureString(p.pluginMarketplaceUrl),
    oauthHost: ensureString(p.oauthHost),
    selfHostedBaseUrl: ensureString(p.selfHostedBaseUrl),
    // 临时模型：白名单重建，非对象输入归一为空对象
    tempModel: (() => {
      const t = p.tempModel && typeof p.tempModel === 'object' ? p.tempModel : {};
      return {
        name: ensureString(t.name),
        apiKey: ensureString(t.apiKey),
        providerType: ensureString(t.providerType),
        baseUrl: ensureString(t.baseUrl),
        displayName: ensureString(t.displayName),
        maxContextSize: ensureString(t.maxContextSize),
        capabilities: ensureString(t.capabilities),
        thinkingEffort: ensureString(t.thinkingEffort),
      };
    })(),
    // 非表单字段随白名单重建保留，避免保存设置后迁移提示复现
    legacyMigrationDismissed: prev.legacyMigrationDismissed === true,
    // 应用设置键随白名单重建保留，避免「保存并连接」丢失应用设置
    theme: ['light', 'dark', 'system'].includes(prev.theme) ? prev.theme : 'system',
    zoomFactor: typeof prev.zoomFactor === 'number' && Number.isFinite(prev.zoomFactor)
      ? Math.min(2, Math.max(0.5, prev.zoomFactor)) : 1,
    closeToTray: prev.closeToTray !== false,
    minimizeToTray: prev.minimizeToTray !== false,
    alwaysOnTop: prev.alwaysOnTop === true,
    launchAtLogin: prev.launchAtLogin === true,
    notificationsEnabled: prev.notificationsEnabled !== false,
    globalHotkeyEnabled: prev.globalHotkeyEnabled !== false,
  };
  writeJSON(configFile(), cfg);
  logLine(`配置已保存: mode=${cfg.mode}`);
  if (cfg.kimiCodeHome !== (prev.kimiCodeHome || '')) {
    logLine('KIMI_CODE_HOME 已变更，重启应用后完全生效');
  }
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

// ---------- 菜单面板 IPC（渲染端 menu-panel.js 自绘面板的数据与动作）----------
// menu:getDefinition 返回分组结构：数组，组含 title 与 items；
// item: {id, label, shortcut?, checked?, disabled?, submenu?, separator?}
function buildMenuDefinition() {
  const currentModel = getCurrentDefaultModel();
  // 模型候选：数据复用 buildModelSubmenu 来源（cachedModels + getCurrentDefaultModel）
  const modelItems = (cachedModels && cachedModels.length > 0)
    ? cachedModels.map((m) => ({ id: `model:${m}`, label: m, checked: m === currentModel }))
    : [{ id: 'model:none', label: '（服务就绪后可用）', disabled: true }];
  // 多实例候选：数据复用 buildInstancesSubmenu 来源（lastInstances）
  const instanceItems = lastInstances.map((inst, i) => {
    const parts = [`${inst.host || ''}:${inst.port || '?'}`];
    if (inst.version) parts.push(`v${inst.version}`);
    if (inst.current) parts.push('当前');
    else if (!inst.alive) parts.push('已退出');
    return { id: `instance:${i}`, label: parts.join(' '), disabled: !inst.alive };
  });
  if (instanceItems.length === 0) instanceItems.push({ id: 'instance:none', label: '未发现实例', disabled: true });
  instanceItems.push({ separator: true }, { id: 'instances:rescan', label: '重新扫描' });
  return [
    {
      title: '会话',
      items: [
        { id: 'session.launcher', label: '打开会话启动器', shortcut: 'Ctrl+Shift+S' },
        { id: 'session.new', label: '新建对话', shortcut: 'Ctrl+Shift+N' },
        { id: 'session.acpChat', label: '原生聊天（新会话）…' },
      ],
    },
    {
      title: '模型',
      items: [
        { id: 'models', label: `默认模型：${currentModel}`, submenu: modelItems },
      ],
    },
    {
      title: '多实例',
      items: [
        { id: 'instances', label: '切换实例', submenu: instanceItems },
      ],
    },
    {
      title: '设置',
      items: [
        { id: 'app.setup', label: '设置…', shortcut: 'Ctrl+,' },
        { id: 'app.manualUrl', label: '手动输入地址…', shortcut: 'Ctrl+L' },
        { id: 'app.rotateToken', label: '轮换访问令牌…' },
        { id: 'app.lan', label: '局域网访问…' },
      ],
    },
    {
      title: '视图',
      items: [
        { id: 'view.toggleWindow', label: '显示/隐藏窗口', shortcut: 'Ctrl+Shift+Space' },
        { id: 'view.alwaysOnTop', label: '窗口置顶', shortcut: 'Ctrl+T', checked: loadConfig().alwaysOnTop === true },
        { separator: true },
        { id: 'view.zoomIn', label: '放大', shortcut: 'Ctrl+=' },
        { id: 'view.zoomOut', label: '缩小', shortcut: 'Ctrl+-' },
        { id: 'view.resetZoom', label: '重置缩放', shortcut: 'Ctrl+0' },
        { separator: true },
        { id: 'view.fullscreen', label: '全屏', shortcut: 'F11' },
        { id: 'view.devtools', label: '开发者工具', shortcut: 'Ctrl+Shift+I' },
      ],
    },
    {
      title: '帮助',
      items: [
        { id: 'help.dataDir', label: '打开数据目录(日志/配置)' },
        { id: 'help.doctor', label: '运行 kimi doctor' },
        { id: 'help.ide', label: 'IDE 接入向导…' },
        { id: 'help.prompts', label: 'Prompt 模板库…' },
        { id: 'help.shortcuts', label: '命令与快捷键速查…', shortcut: 'F1' },
        { id: 'help.diagnostics', label: '打包诊断信息…' },
        { id: 'help.about', label: '关于' },
      ],
    },
    {
      title: '',
      items: [
        { id: 'app.reload', label: '重新加载', shortcut: 'Ctrl+R' },
        { id: 'app.quit', label: '退出' },
      ],
    },
  ];
}

ipcMain.handle('menu:getDefinition', () => buildMenuDefinition());

// menu:run 用 id 白名单映射复用现有函数；缩放/全屏/DevTools/重新加载直接操作发起调用的 webContents
ipcMain.handle('menu:run', (e, id) => {
  try {
    const wc = e.sender;
    const win = wc ? BrowserWindow.fromWebContents(wc) : null;
    if (typeof id === 'string' && id.startsWith('model:')) {
      const m = id.slice('model:'.length);
      if (m && m !== 'none') void switchModel(m);
      return { ok: true };
    }
    if (typeof id === 'string' && id.startsWith('instance:')) {
      const inst = lastInstances[Number(id.slice('instance:'.length))];
      if (inst && inst.alive) void switchInstanceFromTray(inst);
      return { ok: true };
    }
    const actions = {
      'session.launcher': () => showSessionLauncher(),
      'session.new': () => { void newConversationInPlace(); },
      'session.acpChat': () => showAcpChatWindow(),
      'instances:rescan': () => { void refreshInstancesCache(true); },
      'app.setup': () => showSetup('manual'),
      'app.manualUrl': () => showSetup('manual'),
      'app.rotateToken': () => { void rotateToken(); },
      'app.lan': () => showLanWindow(),
      'view.toggleWindow': () => toggleMainWindow(),
      'view.alwaysOnTop': () => setAlwaysOnTopFlag(!(loadConfig().alwaysOnTop === true)),
      'view.zoomIn': () => { if (wc && !wc.isDestroyed()) wc.setZoomLevel(wc.getZoomLevel() + 0.5); },
      'view.zoomOut': () => { if (wc && !wc.isDestroyed()) wc.setZoomLevel(wc.getZoomLevel() - 0.5); },
      'view.resetZoom': () => { if (wc && !wc.isDestroyed()) wc.setZoomLevel(0); },
      'view.fullscreen': () => { if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen()); },
      'view.devtools': () => { if (wc && !wc.isDestroyed()) wc.toggleDevTools(); },
      'help.dataDir': () => { void shell.openPath(userDataDir()); },
      'help.doctor': () => { void runKimiDoctorWithDialog(); },
      'help.ide': () => showSetup('manual', 'ide'),
      'help.prompts': () => showPromptLibrary(),
      'help.shortcuts': () => showHelpWindow(),
      'help.diagnostics': () => { void packDiagnosticsWithDialog(); },
      'help.about': () => showAboutDialog(),
      'app.reload': () => { if (wc && !wc.isDestroyed()) wc.reload(); },
      'app.quit': () => { quitting = true; app.quit(); },
    };
    const fn = actions[id];
    if (!fn) return { ok: false, error: `unknown menu id: ${id}` };
    fn();
    return { ok: true };
  } catch (err) {
    logLine(`menu:run 失败(${id}): ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// 主窗口 Web UI 页窗控区采样色上报（preload 采样）：缓存并刷新悬浮窗控配色
ipcMain.on('kcd:titlebar-color', (e, color) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || e.sender !== mainWindow.webContents) return;
    if (!parseTitlebarColor(color)) return;
    if (color === mainTitlebarSampleColor) return;
    mainTitlebarSampleColor = color;
    applyTitlebarOverlay(mainWindow);
  } catch { /* ignore */ }
});

ipcMain.handle('app:restart', async () => { await restartServer(); return true; });

// 应用设置保存：白名单合并 8 键（theme 枚举校验、zoomFactor 数字钳制、其余布尔归一），即时生效
ipcMain.handle('app:saveAppSettings', (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cfg = readJSON(configFile(), {});
  if (['light', 'dark', 'system'].includes(p.theme)) cfg.theme = p.theme;
  if (typeof p.zoomFactor === 'number' && Number.isFinite(p.zoomFactor)) {
    cfg.zoomFactor = Math.min(2, Math.max(0.5, p.zoomFactor));
  }
  for (const key of ['closeToTray', 'minimizeToTray', 'alwaysOnTop', 'launchAtLogin', 'notificationsEnabled', 'globalHotkeyEnabled']) {
    if (typeof p[key] === 'boolean') cfg[key] = p[key];
  }
  writeJSON(configFile(), cfg);
  applyAppSettings(loadConfig());
  return true;
});

// 返回会话页：覆盖层在前台则直接移除（零重载）；有已加载地址则整页加载，否则重启 server 兜底
ipcMain.handle('app:backToSession', async () => {
  if (overlayView) {
    closeOverlay();
  } else if (loadedUrl) {
    loadMain(loadedUrl);
  } else {
    await restartServer();
  }
  return true;
});

ipcMain.handle('app:openAgentsMonitor', (_e, payload) => {
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    showAgentsMonitor(p.sessionDir, p.title);
    return { ok: true };
  } catch (err) {
    logLine(`app:openAgentsMonitor 失败: ${err.message}`);
    return { ok: false, message: err.message };
  }
});

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
        // setup 可能以覆盖层展示，日志发往前台页面所在 contents
        const wc = foregroundContents();
        if (wc) {
          try { wc.send('auth:loginLog', sanitizedLine); } catch { /* ignore */ }
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
      const wc = foregroundContents(); // setup 可能在覆盖层中，发往前台页面
      if (wc) {
        try { wc.send('auth:loginComplete', { ok: false, error: err.message, loginStatus }); } catch { /* ignore */ }
      }
      resolve({ ok: false, error: err.message });
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      activeLoginProc = null;
      const loginStatus = getLoginStatus();
      const ok = code === 0;
      const wc = foregroundContents(); // setup 可能在覆盖层中，发往前台页面
      if (wc) {
        try { wc.send('auth:loginComplete', { ok, error: ok ? undefined : `登录进程退出码 ${code}`, loginStatus }); } catch { /* ignore */ }
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
    const wc = foregroundContents(); // setup 可能在覆盖层中，发往前台页面
    if (wc) {
      try { wc.send('install:log', msg); } catch { /* ignore */ }
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

// ---------- 维护 IPC ----------
// 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0（按 . 分段数字比较）
function compareSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((s) => parseInt(s, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

ipcMain.handle('cli:checkUpdate', async () => {
  try {
    const cli = resolveCliPath(loadConfig());
    const current = (cli ? getCliVersion(cli) : null)?.version || '';
    let latest = '';
    try {
      const latestFile = path.join(getKimiHomeDir(), 'updates', 'latest.json');
      const data = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      latest = String(data.latest || data.latest_version || data.version || data.tag_name || '').replace(/^v/, '');
    } catch { /* latest.json 不存在或损坏时视为无更新信息 */ }
    const updateAvailable = !!(current && latest && compareSemver(current, latest) < 0);
    return { ok: true, current, latest, updateAvailable };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('cli:upgrade', async () => {
  if (restartPromise) {
    return { ok: false, error: '服务正在重启，请稍后再试' };
  }
  const dir = getKimiHomeDir();
  const ps = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const send = (msg) => {
    const wc = foregroundContents(); // setup 可能在覆盖层中，发往前台页面
    if (wc) {
      try { wc.send('install:log', msg); } catch { /* ignore */ }
    }
    logLine(`upgrade: ${msg}`);
  };
  // 与 cli:install 相同的官方安装脚本，覆盖安装即升级
  const runResult = await new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
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
      done({ error: err.message });
      return;
    }
    const onData = (chunk) => {
      chunk.toString('utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach(send);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => done({ error: err.message }));
    child.on('exit', (code) => done({ code }));
  });
  if (runResult.error) {
    return { ok: false, error: runResult.error };
  }
  const exe = path.join(dir, 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
  if (runResult.code === 0 && fs.existsSync(exe)) {
    logLine(`CLI 升级完成: ${exe}`);
    cliVersionCache = null; // 清除版本缓存，下次重新探测
    await restartServer();
    return { ok: true, cliPath: exe };
  }
  return { ok: false, error: `升级脚本退出码 ${runResult.code}，未找到 ${exe}` };
});

// 递归统计目录大小与文件数（单文件失败跳过，全程容错）
function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          const sub = dirStats(full);
          bytes += sub.bytes;
          files += sub.files;
        } else if (entry.isFile()) {
          bytes += fs.statSync(full).size;
          files++;
        }
      } catch { /* 单文件失败跳过 */ }
    }
  } catch { /* 目录不可读时按 0 计 */ }
  return { bytes, files };
}

ipcMain.handle('system:dataDirStats', async () => {
  try {
    const root = getKimiHomeDir();
    const entries = [];
    if (fs.existsSync(root)) {
      const defs = [
        { key: 'sessions', label: '会话数据', cleanable: true },
        { key: 'logs', label: '日志', cleanable: true },
        { key: 'bin', label: 'CLI 二进制与缓存', cleanable: true },
        { key: 'updates', label: '更新缓存', cleanable: true },
        { key: 'credentials', label: '登录凭据', cleanable: false },
        { key: 'server', label: '服务状态', cleanable: true },
      ];
      for (const def of defs) {
        try {
          const dir = path.join(root, def.key);
          if (fs.existsSync(dir)) {
            const stats = dirStats(dir);
            entries.push({ key: def.key, label: def.label, bytes: stats.bytes, files: stats.files, cleanable: def.cleanable });
          }
        } catch { /* 单项失败跳过 */ }
      }
    }
    return { ok: true, root, entries };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('system:cleanupDataDirs', async (_e, keys) => {
  // 白名单：登录凭据与其他目录一律拒绝
  const ALLOWED = new Set(['sessions', 'logs', 'bin', 'updates', 'server']);
  const root = getKimiHomeDir();
  const cleaned = [];
  const errors = [];
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    const k = String(key);
    if (!ALLOWED.has(k)) {
      errors.push({ key: k, error: '不允许清理的目录' });
      continue;
    }
    try {
      if (k === 'sessions') {
        // 会话索引一并删除
        logLine('正在清理会话数据目录（含会话索引）');
        try { fs.rmSync(path.join(root, 'session_index.jsonl'), { force: true }); } catch { /* ignore */ }
      }
      const dir = path.join(root, k);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      cleaned.push(k);
      logLine(`数据目录已清理: ${k}`);
    } catch (err) {
      logLine(`清理数据目录失败 (${k}): ${err.message}`);
      errors.push({ key: k, error: err.message });
    }
  }
  return { ok: true, cleaned, errors };
});

// 打包诊断信息（「帮助」菜单与 IPC 共用）：日志 + doctor 输出 + 最近会话导出，压缩为 zip
async function packDiagnostics() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存诊断包',
    defaultPath: path.join(app.getPath('desktop'), `kimi-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`),
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, message: '已取消' };
  }
  const target = result.filePath;
  let staging = null;
  const cleanupStaging = () => {
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
  try {
    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-diag-'));
    // 应用日志（存在才复制）
    try {
      const log = logFile();
      if (fs.existsSync(log)) fs.copyFileSync(log, path.join(staging, 'app.log'));
    } catch (err) {
      logLine(`复制应用日志失败: ${err.message}`);
    }
    // kimi doctor 输出
    try {
      const doctor = await runKimiDoctor();
      const doctorText = (doctor.ok ? 'kimi doctor 诊断通过\n\n' : `kimi doctor 诊断失败: ${doctor.error || ''}\n\n`) + (doctor.output || '');
      fs.writeFileSync(path.join(staging, 'doctor.txt'), doctorText, 'utf8');
    } catch (err) {
      logLine(`写入 doctor 输出失败: ${err.message}`);
    }
    // 最近会话导出（60s 超时，失败仅记录日志不阻断）
    try {
      const sessions = getAllSessions();
      if (sessions.length > 0) {
        const cfg = loadConfig();
        const cli = resolveCliPath(cfg);
        if (cli) {
          await new Promise((resolve) => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            let child;
            try {
              child = spawn(cli, ['export', sessions[0].sessionId, '-o', staging, '-y'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: buildKimiEnv(cfg),
              });
            } catch (err) {
              logLine(`启动会话导出失败: ${err.message}`);
              done();
              return;
            }
            const timer = setTimeout(() => {
              logLine('诊断包会话导出超时（60 秒）');
              forceKill(child.pid);
              done();
            }, 60000);
            child.on('error', (err) => {
              clearTimeout(timer);
              logLine(`会话导出进程错误: ${err.message}`);
              done();
            });
            child.on('exit', (code) => {
              clearTimeout(timer);
              if (code === 0) logLine(`最近会话已导出至诊断包: ${sessions[0].sessionId}`);
              else logLine(`会话导出退出码 ${code}（诊断打包继续）`);
              done();
            });
          });
        }
      }
    } catch (err) {
      logLine(`导出最近会话失败（诊断打包继续）: ${err.message}`);
    }
    // PowerShell 压缩为 zip
    const ps = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    // PowerShell 单引号路径转义：' → ''
    const psStaging = staging.replace(/'/g, "''");
    const psTarget = target.replace(/'/g, "''");
    const zipResult = await new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      let child;
      try {
        child = spawn(ps, [
          '-NoProfile', '-Command',
          `Compress-Archive -Path '${psStaging}\\*' -DestinationPath '${psTarget}' -Force`,
        ], { windowsHide: true });
      } catch (err) {
        done({ error: err.message });
        return;
      }
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => done({ error: err.message }));
      child.on('exit', (code) => done({ code, stderr }));
    });
    if (!zipResult.error && zipResult.code === 0 && fs.existsSync(target)) {
      cleanupStaging();
      logLine(`诊断包已保存: ${target}`);
      return { ok: true, path: target };
    }
    const msg = zipResult.error || (zipResult.stderr || '').trim() || `压缩进程退出码 ${zipResult.code}`;
    cleanupStaging();
    logLine(`诊断包打包失败: ${msg}`);
    return { ok: false, message: msg };
  } catch (err) {
    cleanupStaging();
    logLine(`诊断包打包异常: ${err.message}`);
    return { ok: false, message: err.message };
  }
}

ipcMain.handle('system:packDiagnostics', async () => packDiagnostics());

// ---------- 局域网访问 IPC ----------
ipcMain.handle('system:lanInfo', async () => {
  try {
    const cfg = loadConfig();
    // 收集全部非内部 IPv4 地址
    const ips = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        if (info && (info.family === 'IPv4' || info.family === 4) && !info.internal) {
          ips.push(info.address);
        }
      }
    }
    // 端口：优先当前运行中的服务，其次配置值，最后默认 58627
    let port = null;
    if (knownServerBase) {
      try { port = Number(new URL(knownServerBase).port) || null; } catch { /* 解析失败时用配置兜底 */ }
    }
    if (!port) port = Number(cfg.port) || 58627;
    // token：优先内存中的值，缺失时回读 server.token 文件
    const token = knownServerToken || readServerToken() || '';
    const urls = ips.map((ip) => `http://${ip}:${port}/#token=${encodeURIComponent(token)}`);
    // 二维码懒加载：qrcode 不可用时降级为空数组，仅记日志
    const qrDataUrls = [];
    try {
      const qrcode = require('qrcode');
      for (let i = 0; i < ips.length; i++) {
        const dataUrl = await qrcode.toDataURL(urls[i], { width: 320 });
        qrDataUrls.push({ ip: ips[i], url: urls[i], dataUrl });
      }
    } catch (err) {
      logLine(`生成局域网二维码失败: ${err.message}`);
    }
    return {
      ok: true,
      port,
      hostWildcard: cfg.host === '0.0.0.0' || cfg.host === '::',
      urls,
      qrDataUrls,
    };
  } catch (err) {
    logLine(`system:lanInfo 失败: ${err.message}`);
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('system:lanEnable', async () => {
  try {
    const cfg = loadConfig();
    cfg.host = '0.0.0.0';
    writeJSON(configFile(), cfg);
    logLine('已开启局域网访问（host=0.0.0.0），重启服务');
    await restartServer();
    return { ok: true, message: '已开启局域网访问并重启服务' };
  } catch (err) {
    logLine(`system:lanEnable 失败: ${err.message}`);
    return { ok: false, message: err.message };
  }
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

// 判断工作目录是否属于敏感位置：用户主目录、盘符根、路径段含 .ssh/.gnupg、KIMI_CODE_HOME
function isSensitiveWorkDir(dir) {
  try {
    const normalized = path.resolve(dir);
    if (normalized === path.resolve(os.homedir())) return true;
    if (normalized === path.parse(normalized).root) return true;
    if (normalized === path.resolve(getKimiHomeDir())) return true;
    const segments = normalized.split(path.sep).map((s) => s.toLowerCase());
    if (segments.includes('.ssh') || segments.includes('.gnupg')) return true;
  } catch { /* 解析失败时按非敏感处理 */ }
  return false;
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

// 在原生聊天窗中打开既有会话：查索引 → 敏感目录二次确认 → 开窗并向渲染层下发 open-session
ipcMain.handle('session:openInNativeChat', async (_e, sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, message: '无效的 sessionId' };
  }
  const indexEntries = readSessionIndex();
  const entry = indexEntries.find((e) => e.sessionId === sessionId);
  if (!entry) {
    return { ok: false, message: `未找到会话: ${sessionId}` };
  }
  const enriched = enrichSessionFromState(entry);
  const workDir = ensureString(enriched.workDir);
  if (!workDir) {
    return { ok: false, message: '该会话缺少工作目录信息' };
  }
  // 敏感目录二次确认（与新建会话同一套检查）
  if (isSensitiveWorkDir(workDir)) {
    const warn = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '敏感目录警告',
      message: '在敏感目录中打开会话',
      detail: `会话工作目录「${workDir}」属于敏感位置（用户主目录、盘符根目录、.ssh/.gnupg 或 Kimi 数据目录）。在此运行 Agent 可能读取或修改大量私人文件，建议谨慎操作。`,
      buttons: ['继续打开', '取消'],
      defaultId: 1,
      cancelId: 1,
    });
    if (warn.response !== 0) {
      return { ok: false, message: '已取消' };
    }
  }
  // 窗口已存在且有在途 client 时先断开（切换会话）
  if (acpClient) disposeAcpClient('切换会话');
  showAcpChatWindow();
  const win = acpChatWindow;
  const payload = {
    type: 'open-session',
    cwd: workDir,
    sessionId,
    title: ensureString(enriched.title) || sessionId.slice(0, 8),
  };
  const deliver = () => {
    // 窗口已被替换或销毁则不再下发
    if (acpChatWindow === win && win && !win.isDestroyed()) sendAcpEvent(payload);
  };
  if (win && !win.isDestroyed()) {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', deliver); // once 一次性监听，防重复绑定
    } else {
      deliver(); // 窗口已存在且已加载完：立即下发
    }
  }
  logLine(`原生聊天打开会话: ${sessionId} (cwd=${workDir})`);
  return { ok: true };
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

ipcMain.handle('session:exportMarkdown', async (_e, sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, message: '无效的 sessionId' };
  }
  try {
    const session = getAllSessions().find((s) => s.sessionId === sessionId);
    if (!session) {
      return { ok: false, message: `未找到会话: ${sessionId}` };
    }
    const exported = sessionExport.exportSessionMarkdown(session.sessionDir, {
      title: session.title,
      sessionId: session.sessionId,
      workDir: session.workDir,
    });
    if (!exported.ok) {
      return { ok: false, message: exported.error || '导出失败' };
    }
    // 标题中的文件系统非法字符替换为下划线，避免保存对话框路径错误
    const baseName = (session.title || sessionId).replace(/[\\/:*?"<>|]/g, '_');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出会话为 Markdown',
      defaultPath: `${baseName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, cancelled: true };
    }
    fs.writeFileSync(result.filePath, exported.markdown, 'utf8');
    logLine(`导出会话 Markdown: ${sessionId}（${exported.messageCount} 条消息）`);
    return { ok: true, path: result.filePath, messageCount: exported.messageCount };
  } catch (err) {
    logLine(`导出会话 Markdown 失败: ${err.message}`);
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('session:scanSubagents', (_e, sessionDir) => {
  try {
    const dir = ensureString(sessionDir);
    if (!dir) {
      return { ok: false, message: '无效的会话目录', agents: [], tasks: [] };
    }
    // 安全校验：仅允许扫描 KIMI_CODE_HOME/sessions 之内的目录
    const sessionsRoot = path.join(getKimiHomeDir(), 'sessions');
    const rel = path.relative(sessionsRoot, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, message: '会话目录不在 sessions 目录之内', agents: [], tasks: [] };
    }
    return sessionExport.scanSubagents(dir);
  } catch (err) {
    logLine(`scanSubagents 失败: ${err.message}`);
    return { ok: false, message: err.message, agents: [], tasks: [] };
  }
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
            backgroundColor: windowBackground(),
            autoHideMenuBar: true,
            ...framelessOpts(),
            icon: path.join(__dirname, 'assets', 'icon.png'),
            webPreferences: {
              preload: path.join(__dirname, 'preload.js'),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
              spellcheck: false,
              partition: `persist:kimi-vis-${sessionId.slice(0, 8)}`,
              // 外部页面（kimi vis）无内嵌拖拽条元素，靠 preload 按此标记注入
              additionalArguments: ['--kcd-drag-strip'],
            },
          });
          applyFrameless(visWindow);
          // 外部页面无 kimi-theme.css，拖拽条样式改由主进程注入
          visWindow.webContents.on('did-finish-load', () => {
            try {
              visWindow.webContents.insertCSS(
                '#kcd-drag-strip{position:fixed;top:0;left:0;right:0;height:10px;-webkit-app-region:drag;z-index:2147483646;}'
              );
            } catch { /* ignore */ }
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

ipcMain.handle('session:createSessionInDirectory', async (_e, opts) => {
  const dirResult = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (dirResult.canceled || !dirResult.filePaths[0]) {
    return { ok: false, message: '用户取消了选择' };
  }
  const workDir = dirResult.filePaths[0];
  // 敏感目录二次确认：主目录/盘符根/.ssh/.gnupg/KIMI_CODE_HOME 风险较高
  if (isSensitiveWorkDir(workDir)) {
    const warn = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '敏感目录警告',
      message: '在敏感目录中创建会话',
      detail: `所选目录「${workDir}」属于敏感位置（用户主目录、盘符根目录、.ssh/.gnupg 或 Kimi 数据目录）。在此运行 Agent 可能读取或修改大量私人文件，建议改用专门的子目录。`,
      buttons: ['继续创建', '取消'],
      defaultId: 1,
      cancelId: 1,
    });
    if (warn.response !== 0) {
      return { ok: false, cancelled: true };
    }
  }
  if (!knownServerBase) {
    return { ok: false, message: 'Web 服务未就绪，请先启动会话后再创建' };
  }
  // 新会话权限模式：先写入 config.toml（doctor 校验失败自动回滚）
  const o = opts && typeof opts === 'object' ? opts : {};
  const permMode = ['manual', 'yolo', 'auto'].includes(o.permissionMode) ? o.permissionMode : null;
  const planMode = o.planMode === true;
  if (permMode || planMode) {
    try {
      const cfg = loadConfig();
      const cli = resolveCliPath(cfg);
      if (!cli) throw new Error('未找到 kimi CLI');
      const data = configManager.loadConfigToml().data || {};
      if (permMode) data.default_permission_mode = permMode;
      if (planMode) data.default_plan_mode = true;
      await configManager.saveConfigToml(data, cli, buildKimiEnv(cfg));
      logLine(`新会话模式已写入配置: permission=${permMode || '保持'} plan=${planMode}`);
    } catch (err) {
      logLine(`写入新会话模式失败: ${err.message}`);
      return { ok: false, message: `写入权限模式失败：${err.message}` };
    }
  }
  const token = knownServerToken || '';
  const encodedDir = encodeURIComponent(workDir);
  const deepLink = `${knownServerBase}/?action=create-in-dir&workDir=${encodedDir}#token=${encodeURIComponent(token)}`;
  logLine(`创建会话于目录: ${workDir}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    closeOverlay(); // 深链接回到 Web UI 前关闭覆盖层
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

// ---------- 会话归档/删除（REST 能力自适应）----------
ipcMain.handle('session:getCaps', () => ({
  ok: true,
  caps: {
    archive: serverCaps.archive,
    delete: serverCaps.delete,
    models: serverCaps.models,
  },
}));

// 从 session_index.jsonl 剔除指定会话的所有行
function removeSessionFromIndex(sessionId) {
  const indexPath = getSessionIndexPath();
  try {
    const content = fs.readFileSync(indexPath, 'utf8');
    const kept = content.split(/\r?\n/).filter((line) => {
      if (!line.trim()) return false;
      try {
        const entry = JSON.parse(line);
        return entry.sessionId !== sessionId;
      } catch {
        return false;
      }
    });
    fs.writeFileSync(indexPath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    return true;
  } catch (err) {
    logLine(`更新会话索引失败: ${err.message}`);
    return false;
  }
}

// 通知会话启动器刷新列表
function notifySessionChanged() {
  // 启动器以覆盖层展示时发给覆盖层；否则维持发主窗口（兼容启动期启动器在主窗口的场景）
  if (overlayView && overlayKind === 'sessions') {
    try { overlayView.webContents.send('session:changed'); } catch { /* ignore */ }
    return;
  }
  if (sessionLauncherVisible && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('session:changed'); } catch { /* ignore */ }
  }
}

ipcMain.handle('session:archiveSession', async (_e, sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, message: '无效的 sessionId' };
  }
  if (!serverCaps.archive || !serverCaps.archivePath) {
    return { ok: false, message: '当前服务端不支持归档操作（openapi 未暴露归档端点）' };
  }
  if (!knownServerBase) {
    return { ok: false, message: 'Web 服务未就绪' };
  }
  const url = buildSessionActionUrl(knownServerBase, serverCaps.archivePath, sessionId);
  logLine(`归档会话: ${sessionId}`);
  const res = await httpRequest('POST', url, knownServerToken);
  if (!res) {
    return { ok: false, message: '归档请求失败（网络错误或超时）' };
  }
  if (res.status < 200 || res.status >= 300) {
    logLine(`归档会话失败: HTTP ${res.status}`);
    return { ok: false, message: `归档失败 (HTTP ${res.status})` };
  }
  removeSessionFromIndex(sessionId);
  notifySessionChanged();
  return { ok: true, message: '会话已归档' };
});

ipcMain.handle('session:deleteSession', async (_e, sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, message: '无效的 sessionId' };
  }
  if (!serverCaps.delete || !serverCaps.deletePath) {
    return { ok: false, message: '当前服务端不支持删除操作（openapi 未暴露删除端点）' };
  }
  if (!knownServerBase) {
    return { ok: false, message: 'Web 服务未就绪' };
  }
  // 先归档（若支持），再删除，降低误删损失
  if (serverCaps.archive && serverCaps.archivePath) {
    const archiveUrl = buildSessionActionUrl(knownServerBase, serverCaps.archivePath, sessionId);
    await httpRequest('POST', archiveUrl, knownServerToken);
  }
  const url = buildSessionActionUrl(knownServerBase, serverCaps.deletePath, sessionId);
  logLine(`删除会话: ${sessionId}`);
  const res = await httpRequest(serverCaps.deleteMethod.toUpperCase(), url, knownServerToken);
  if (!res) {
    return { ok: false, message: '删除请求失败（网络错误或超时）' };
  }
  if (res.status < 200 || res.status >= 300) {
    logLine(`删除会话失败: HTTP ${res.status}`);
    return { ok: false, message: `删除失败 (HTTP ${res.status})` };
  }
  removeSessionFromIndex(sessionId);
  notifySessionChanged();
  return { ok: true, message: '会话已删除' };
});

// ---------- 旧版数据目录迁移提示 ----------
// 首跑判定后执行：~/.kimi 存在且含 bin 子目录或 config.toml 文件时提示迁移，
// 「不再提示」写 config.json 的 legacyMigrationDismissed 标志位去重。
function maybePromptLegacyMigration() {
  try {
    const cfg = readJSON(configFile(), {});
    if (cfg.legacyMigrationDismissed === true) return;
    const legacyDir = path.join(os.homedir(), '.kimi');
    if (!fs.existsSync(legacyDir)) return;
    const hasBin = (() => {
      try { return fs.statSync(path.join(legacyDir, 'bin')).isDirectory(); } catch { return false; }
    })();
    const hasConfigToml = fs.existsSync(path.join(legacyDir, 'config.toml'));
    if (!hasBin && !hasConfigToml) return;
    logLine('检测到旧版 kimi-cli 数据目录（~/.kimi），弹出迁移提示');
    dialog.showMessageBox({
      type: 'question',
      title: '发现旧版数据',
      message: '检测到旧版 kimi-cli 数据目录（~/.kimi）',
      detail: '可以运行 kimi migrate 将旧版数据迁移到新版数据目录（~/.kimi-code）。迁移会在新打开的命令行窗口中进行，请按窗口内提示操作。',
      buttons: ['立即迁移', '稍后', '不再提示'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        const cli = resolveCliPath(loadConfig());
        if (!cli) {
          dialog.showMessageBox({ type: 'error', title: '旧版数据迁移', message: '未找到 kimi CLI，无法执行迁移' });
          return;
        }
        try {
          // 外部终端执行迁移（detached，窗口保持可见）
          const child = spawn('cmd', ['/c', 'start', 'cmd', '/k', `"${cli}"`, 'migrate'], {
            detached: true, stdio: 'ignore', windowsHide: false,
          });
          child.unref();
          logLine('已启动外部终端执行 kimi migrate');
        } catch (err) {
          logLine(`启动迁移终端失败: ${err.message}`);
          dialog.showMessageBox({ type: 'error', title: '旧版数据迁移', message: `启动迁移终端失败：${err.message}` });
        }
      } else if (response === 2) {
        const cur = readJSON(configFile(), {});
        cur.legacyMigrationDismissed = true;
        writeJSON(configFile(), cur);
        logLine('旧版迁移提示已设置为不再提示');
      }
    }).catch(() => { /* ignore */ });
  } catch {
    // 静默安全
  }
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    applyKimiCodeHomeFromConfig();
    blockWebPageNotifications();
    createWindow();
    buildMenu();
    createTray();
    applyAppSettings(loadConfig()); // 含全局热键注册（按 globalHotkeyEnabled 配置）

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
      } else if (cfg.autoStartCli === false) {
        logLine('已按设置跳过自动启动，显示设置页面');
        showSetup('startup-paused');
      } else {
        startKimiServer();
      }
      // 旧版 kimi-cli 数据目录（~/.kimi）迁移提示（一次性，可关闭）
      maybePromptLegacyMigration();
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
    disposeAcpClient('app 退出');
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
