const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kimiDesktop', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  saveSetup: (payload) => ipcRenderer.invoke('setup:save', payload),
  showSetup: () => ipcRenderer.invoke('app:showSetup'),
  restart: () => ipcRenderer.invoke('app:restart'),
  pickCli: () => ipcRenderer.invoke('dialog:pickCli'),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  pickShell: () => ipcRenderer.invoke('dialog:pickShell'),
  runDoctor: () => ipcRenderer.invoke('cli:doctor'),
  startLogin: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  onLoginLog: (fn) => {
    const listener = (_e, msg) => fn(msg);
    ipcRenderer.on('auth:loginLog', listener);
    return () => ipcRenderer.removeListener('auth:loginLog', listener);
  },
  onLoginComplete: (fn) => {
    const listener = (_e, result) => fn(result);
    ipcRenderer.on('auth:loginComplete', listener);
    return () => ipcRenderer.removeListener('auth:loginComplete', listener);
  },
  installCli: (dir) => ipcRenderer.invoke('cli:install', dir),
  onInstallLog: (fn) => {
    const listener = (_e, msg) => fn(msg);
    ipcRenderer.on('install:log', listener);
    return () => ipcRenderer.removeListener('install:log', listener);
  },
  onLog: (fn) => {
    const listener = (_e, msg) => fn(msg);
    ipcRenderer.on('server:log', listener);
    return () => ipcRenderer.removeListener('server:log', listener);
  },
  // 配置中心 API
  loadConfigToml: () => ipcRenderer.invoke('config:loadConfigToml'),
  saveConfigToml: (data) => ipcRenderer.invoke('config:saveConfigToml', data),
  loadTuiToml: () => ipcRenderer.invoke('config:loadTuiToml'),
  saveTuiToml: (data) => ipcRenderer.invoke('config:saveTuiToml', data),
  loadMcpJson: () => ipcRenderer.invoke('config:loadMcpJson'),
  saveMcpJson: (data) => ipcRenderer.invoke('config:saveMcpJson', data),
  listProviders: () => ipcRenderer.invoke('config:listProviders'),
  removeProvider: (name) => ipcRenderer.invoke('config:removeProvider', name),
  addProviderCatalog: (args) => ipcRenderer.invoke('config:addProviderCatalog', args),
  // Skills 管理 API
  listSkills: () => ipcRenderer.invoke('skills:list'),
  saveSkill: (payload) => ipcRenderer.invoke('skills:save', payload),
  deleteSkill: (name) => ipcRenderer.invoke('skills:delete', name),
  // 会话启动器 API
  getSessions: () => ipcRenderer.invoke('session:getSessions'),
  refreshSessions: () => ipcRenderer.invoke('session:refreshSessions'),
  resumeSession: (id) => ipcRenderer.invoke('session:resumeSession', id),
  openInNativeChat: (id) => ipcRenderer.invoke('session:openInNativeChat', id),
  exportSession: (id) => ipcRenderer.invoke('session:exportSession', id),
  visualiseSession: (id) => ipcRenderer.invoke('session:visualiseSession', id),
  createSessionInDirectory: (opts) => ipcRenderer.invoke('session:createSessionInDirectory', opts),
  openSessionLauncher: () => ipcRenderer.invoke('session:openLauncher'),
  archiveSession: (id) => ipcRenderer.invoke('session:archiveSession', id),
  deleteSession: (id) => ipcRenderer.invoke('session:deleteSession', id),
  getCaps: () => ipcRenderer.invoke('session:getCaps'),
  onSessionChanged: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('session:changed', listener);
    return () => ipcRenderer.removeListener('session:changed', listener);
  },
  // 维护 API
  checkUpdate: () => ipcRenderer.invoke('cli:checkUpdate'),
  upgradeCli: () => ipcRenderer.invoke('cli:upgrade'),
  getDataDirStats: () => ipcRenderer.invoke('system:dataDirStats'),
  cleanupDataDirs: (keys) => ipcRenderer.invoke('system:cleanupDataDirs', keys),
  packDiagnostics: () => ipcRenderer.invoke('system:packDiagnostics'),
  // 多实例 API
  instancesList: () => ipcRenderer.invoke('instances:list'),
  instancesSwitch: (target) => ipcRenderer.invoke('instances:switch', target),
  // IDE 接入 API
  ideDetect: () => ipcRenderer.invoke('ide:detect'),
  ideApplyZed: () => ipcRenderer.invoke('ide:applyZed'),
  ideGetSnippet: (editor) => ipcRenderer.invoke('ide:getSnippet', editor),
  // 会话导出与子 Agent 监视 API
  exportMarkdown: (id) => ipcRenderer.invoke('session:exportMarkdown', id),
  scanSubagents: (dir) => ipcRenderer.invoke('session:scanSubagents', dir),
  openAgentsMonitor: (sessionDir, title) => ipcRenderer.invoke('app:openAgentsMonitor', { sessionDir, title }),
  // 插件管理 API
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsSetEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
  // 调试与局域网 API
  debugFetch: () => ipcRenderer.invoke('debug:fetchEndpoints'),
  lanInfo: () => ipcRenderer.invoke('system:lanInfo'),
  lanEnable: () => ipcRenderer.invoke('system:lanEnable'),
  // 应用设置 API
  saveAppSettings: (payload) => ipcRenderer.invoke('app:saveAppSettings', payload),
  backToSession: () => ipcRenderer.invoke('app:backToSession'),
});

// 应用菜单面板 API：menu-panel.js（本地页经 <script src="menu-panel.js"> 加载、主窗口 Web UI 页由
// 主进程 did-finish-load 时 executeJavaScript 注入——该页 CSP 为 default-src 'self'，<script> 文本
// 节点注入会被拦截，故不在此处注入）消费；所有使用本 preload 的窗口统一暴露；
// 含窗控样式同步 API（get/onTitlebarStyle），供 menu-panel.js 让 ≡ 与 OS 窗控一致
// 主进程广播的窗控样式（符号色/高度）缓存与订阅者：仅主窗口会收到 kcd:titlebar-style
let titlebarStyleCache = null;
const titlebarStyleListeners = new Set();
ipcRenderer.on('kcd:titlebar-style', (_e, style) => {
  titlebarStyleCache = style && typeof style === 'object' ? style : null;
  for (const cb of titlebarStyleListeners) {
    try {
      cb(titlebarStyleCache);
    } catch {
      // 单个 listener 异常不影响其他订阅者
    }
  }
});
contextBridge.exposeInMainWorld('kimiDesktopMenu', {
  getDefinition: () => ipcRenderer.invoke('menu:getDefinition'),
  run: (id) => ipcRenderer.invoke('menu:run', id),
  getTitlebarStyle: () => titlebarStyleCache,
  onTitlebarStyle: (cb) => {
    if (typeof cb !== 'function') return () => {};
    titlebarStyleListeners.add(cb);
    return () => titlebarStyleListeners.delete(cb);
  },
});

// 主窗口标记：createWindow 经 additionalArguments 传入，辅助窗口复用本 preload 时不带此标记
const IS_MAIN_WINDOW = process.argv.includes('--kcd-main-window');
// 拖拽条标记：无边框窗口都需要顶部拖拽条（主窗口所有页面 + 可视化等外部页面窗口）
const NEEDS_DRAG_STRIP = IS_MAIN_WINDOW || process.argv.includes('--kcd-drag-strip');

// 当前页是否为 kimi web UI 会话页（loopback http(s)）
function isLoopbackWebUI() {
  try {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname);
  } catch {
    return false;
  }
}

// 窗控区「变色」信号：渲染端同步算色——页面 DOM/可见性变化时 preload 立刻用
// elementsFromPoint 对窗控采样点做 source-over 合成算出目标色（computeTitlebarColor），
// 随信号一并发给主进程，即算即达：蒙版出现瞬间目标色已定，不再等主进程防抖 capturePage。
// 主进程收到有效色立即应用、350ms 防抖后做一次校验性 capturePage；收到 null（算不出）
// 走原 50ms 防抖 capturePage 路径兜底（见 main.js runTitlebarCapture）。
// 触发源：MutationObserver（节流 50ms）+ 每次调度重设 250ms 尾随补信号 + 动画期间 ~400ms
// rAF 逐帧跟踪（专踩蒙版淡入/淡出 CSS transition）+ 1s 轮询兜底 + visibilitychange；
// 并上报 header.chat-header 实测高度（启动一次、随 1s 轮询、resize 200ms 节流），
// 供主进程设置 titleBarOverlay 高度、与 ≡ 菜单按钮对齐

// 同步计算窗控采样点的合成色：采样点与主进程 capturePage 同一几何（x 距右缘 75，
// y 为头部高度一半）；取该点元素栈自底向顶做标准 source-over 合成。
// 返回 'rgb(r, g, b)'（r/g/b 为 0-255 整数），空栈或任何异常返回 null
function computeTitlebarColor() {
  try {
    const header = document.querySelector('header.chat-header');
    const H = header && header.offsetHeight > 0 ? header.offsetHeight : 32;
    const x = window.innerWidth - 75;
    const y = Math.max(6, Math.round(H / 2));
    // 元素栈（顶→底），跳过自家注入物：拖拽条、≡ 菜单按钮与菜单面板
    const stack = document.elementsFromPoint(x, y).filter((el) => {
      if (!el || el.id === 'kcd-drag-strip') return false;
      const cls = el.classList;
      return !cls || (!cls.contains('kcd-menu-btn') && !cls.contains('kcd-menu-panel'));
    });
    if (stack.length === 0) return null;
    const styles = stack.map((el) => getComputedStyle(el));
    const opacityAt = (i) => {
      const v = parseFloat(styles[i].opacity);
      return Number.isFinite(v) ? v : 1;
    };
    // 合成起点用窗口底色（与 main.js windowBackground 一致），
    // 防止栈里没有全不透明层时出错
    let [r, g, b] = matchMedia('(prefers-color-scheme: dark)').matches
      ? [24, 24, 23]
      : [251, 250, 249];
    // 自栈底向栈顶逐层 source-over：out = src * a + dst * (1 - a)
    for (let i = stack.length - 1; i >= 0; i--) {
      const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/
        .exec(styles[i].backgroundColor);
      if (!m) continue; // 非 rgb/rgba 形式：按无有效背景跳过
      const bgAlpha = m[4] === undefined ? 1 : parseFloat(m[4]);
      // 层有效不透明度 = 背景 alpha × 该元素自身 opacity × 栈中所有包含它的
      // 祖先元素 opacity 之积（祖先 opacity 会整体压暗其子树渲染；栈小，直接双重循环）
      let a = bgAlpha * opacityAt(i);
      for (let j = 0; j < stack.length; j++) {
        if (j !== i && stack[j].contains(stack[i])) a *= opacityAt(j);
      }
      if (a <= 0) continue; // 背景全透明或有效不透明度为 0 的层跳过
      if (a > 1) a = 1;
      r = parseFloat(m[1]) * a + r * (1 - a);
      g = parseFloat(m[2]) * a + g * (1 - a);
      b = parseFloat(m[3]) * a + b * (1 - a);
    }
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  } catch {
    return null;
  }
}

function startTitlebarColorSignals() {
  let scheduled = false;
  let trailingTimer = null;
  let lastColor; // 上一次随信号送出的颜色（undefined = 未发过），供 rAF 跟踪去重
  // 每次信号都同步算色一并发送；force=false 时与上次相同则不发（rAF 逐帧跟踪专用），
  // force=true 保持原有节奏恒发（启动/节流/尾随/轮询/visibilitychange）
  const sendColor = (force) => {
    const color = computeTitlebarColor();
    if (!force && color === lastColor) return;
    lastColor = color;
    ipcRenderer.send('kcd:titlebar-color', color);
  };
  // rAF 逐帧跟踪窗（~400ms）：专踩蒙版淡入/淡出 CSS transition——动画期间 DOM 不再
  // 变化、MutationObserver 静默，但 opacity 计算值逐帧变化且被 getComputedStyle 实时
  // 反映；故每次 schedule 后开窗逐帧重算，仅颜色有变才发，400ms 后停止。
  // 性能守卫：单例循环（rafRunning），连续多次 mutation 只重置截止时间续期、不叠加
  // 多个 rAF 循环；循环体每帧只跑一次，同一帧不重复算
  let rafRunning = false;
  let rafDeadline = 0;
  const nextFrame = (cb) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
    else setTimeout(cb, 16); // 无 rAF 环境退化为 16ms 定时器
  };
  const kickRafTrack = () => {
    rafDeadline = performance.now() + 400; // 新 mutation 到来则延长 400ms
    if (rafRunning) return;
    rafRunning = true;
    const step = () => {
      if (performance.now() >= rafDeadline) {
        rafRunning = false;
        return;
      }
      sendColor(false);
      nextFrame(step);
    };
    nextFrame(step);
  };
  const signal = () => {
    scheduled = false;
    sendColor(true);
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      setTimeout(signal, 50);
    }
    // 尾随补信号：每次调度都 clearTimeout 重设，到点无条件发一次
    clearTimeout(trailingTimer);
    trailingTimer = setTimeout(signal, 250);
    kickRafTrack();
  };
  // 高度上报：header.chat-header 存在且有实际高度才发，找不到不发（主进程保留上次值）
  const reportHeight = () => {
    const h = document.querySelector('header.chat-header');
    if (h && h.offsetHeight > 0) {
      ipcRenderer.send('kcd:titlebar-height', h.offsetHeight);
    }
  };
  signal();
  reportHeight();
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  setInterval(() => { signal(); reportHeight(); }, 1000); // 兜底：CSS 动画/媒体查询变化等不触发 MutationObserver 的情况
  document.addEventListener('visibilitychange', () => { if (!document.hidden) signal(); });
  // 缩放（Ctrl±）/窗口尺寸变化会改变头部高度：单独 200ms 节流上报
  let resizeScheduled = false;
  window.addEventListener('resize', () => {
    if (resizeScheduled) return;
    resizeScheduled = true;
    setTimeout(() => {
      resizeScheduled = false;
      reportHeight();
    }, 200);
  });
}

// 主窗口（无边框）注入顶部拖拽条；kimi web UI 会话页（loopback http(s) 页面）启动窗控区变色信号上报
// （☰ 菜单面板由主进程 did-finish-load 时 executeJavaScript 注入 menu-panel.js，见 main.js）
window.addEventListener('DOMContentLoaded', () => {
  try {
    // 顶部拖拽条：无边框窗口页面（含 loading/setup/sessions 本地页与 kimi vis 外部页）都需要
    if (NEEDS_DRAG_STRIP && !document.getElementById('kcd-drag-strip')) {
      const strip = document.createElement('div');
      strip.id = 'kcd-drag-strip';
      strip.setAttribute('aria-hidden', 'true');
      document.body.appendChild(strip);
    }

    if (!IS_MAIN_WINDOW || !isLoopbackWebUI()) return;
    startTitlebarColorSignals();
  } catch (err) {
    // 注入失败不影响页面本身
  }
});
