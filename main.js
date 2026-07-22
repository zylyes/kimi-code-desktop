// Kimi Code Desktop — 网页版桌面套壳
// 自动启动 `kimi web`，从输出中捕获带 token 的本地地址，并在桌面窗口中打开。
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog, nativeImage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const APP_NAME = 'Kimi Code Desktop';
const isDev = process.argv.includes('--dev');

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

function logLine(msg) {
  // 日志脱敏：所有日志不得包含 token、授权头、完整带 fragment URL
  const sanitized = String(msg).replace(/(https?:\/\/[^\s"'<>)\]]+)/g, (url) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return url;
    }
  }).replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer ***')
    .replace(/(?:^|[^a-zA-Z])(token[=:])\s*\S+/gi, '$1***')
    .replace(/Bearer\s+[^*\s]\S*/gi, 'Bearer ***');
  try { fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${sanitized}\n`); } catch { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('server:log', sanitized); } catch { /* ignore */ }
  }
}

function loadConfig() {
  return Object.assign({ mode: 'auto', cliPath: '', manualUrl: '' }, readJSON(configFile(), {}));
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
    child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

// ---------- 页面加载 ----------
function loadMain(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sessionLauncherVisible = false; // 显式加载 Web UI 时清除启动器可见状态
  loadedUrl = url;
  mainWindow.loadURL(url).catch((err) => {
    logLine(`加载页面失败: ${err.message}`);
    showSetup('load-failed');
  });
}

function showSetup(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
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

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: '打开会话启动器', click: showSessionLauncher },
    { label: '新建 Web 会话', click: () => { showMainWindow(); restartServer(); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', () => { showMainWindow(); restartServer(); });
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
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
        {
          label: '关于',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: '关于',
            message: APP_NAME,
            detail: `版本 ${app.getVersion()}\nKimi Code 网页版的桌面套壳。\n自动启动 kimi web 并嵌入窗口，登录状态持久保存。`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  defaultCli: defaultCliCandidates()[0],
  cliFound: !!resolveCliPath(loadConfig()),
  config: loadConfig(),
  loadedUrl,
  isDev,
}));

ipcMain.handle('setup:save', async (_e, payload) => {
  const cfg = {
    mode: payload && payload.mode === 'manual' ? 'manual' : 'auto',
    cliPath: (payload && payload.cliPath) || '',
    manualUrl: (payload && payload.manualUrl) || '',
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

    const cfg = loadConfig();
    if (cfg.mode === 'manual' && cfg.manualUrl) {
      logLine(`手动模式，直接加载: ${cfg.manualUrl}`);
      loadMain(cfg.manualUrl);
    } else {
      startKimiServer();
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