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

// 主窗口标记：createWindow 经 additionalArguments 传入，辅助窗口复用本 preload 时不带此标记
const IS_MAIN_WINDOW = process.argv.includes('--kcd-main-window');
// 拖拽条标记：无边框窗口都需要顶部拖拽条（主窗口所有页面 + 可视化等外部页面窗口）
const NEEDS_DRAG_STRIP = IS_MAIN_WINDOW || process.argv.includes('--kcd-drag-strip');

// 主窗口（无边框）注入顶部拖拽条；kimi web UI 会话页（loopback http(s) 页面）右下角
// 注入浮动设置按钮与 ☰ 菜单按钮；样式由主进程 webContents.insertCSS 注入，此处不写任何内联样式。
window.addEventListener('DOMContentLoaded', () => {
  try {
    // 顶部拖拽条：无边框窗口页面（含 loading/setup/sessions 本地页与 kimi vis 外部页）都需要
    if (NEEDS_DRAG_STRIP && !document.getElementById('kcd-drag-strip')) {
      const strip = document.createElement('div');
      strip.id = 'kcd-drag-strip';
      strip.setAttribute('aria-hidden', 'true');
      document.body.appendChild(strip);
    }

    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname)) return;
    if (document.getElementById('kcd-settings-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'kcd-settings-fab';
    fab.type = 'button';
    fab.title = '设置 (Ctrl+,)';
    fab.setAttribute('aria-label', '设置');
    fab.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
    fab.addEventListener('click', () => {
      ipcRenderer.invoke('app:showSetup');
    });
    document.body.appendChild(fab);

    // ☰ 菜单按钮：无边框主窗口无原生菜单栏，点击弹出完整应用菜单（快捷键不受影响）
    if (IS_MAIN_WINDOW && !document.getElementById('kcd-menu-fab')) {
      const menuFab = document.createElement('button');
      menuFab.id = 'kcd-menu-fab';
      menuFab.type = 'button';
      menuFab.title = '菜单';
      menuFab.setAttribute('aria-label', '菜单');
      menuFab.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line></svg>';
      menuFab.addEventListener('click', () => {
        // 把按钮位置传给主进程，菜单将锚定到按钮左上角弹出
        const r = menuFab.getBoundingClientRect();
        ipcRenderer.invoke('app:popupMenu', { x: r.left, y: r.top, width: r.width, height: r.height });
      });
      document.body.appendChild(menuFab);
    }
  } catch (err) {
    // 注入失败不影响页面本身
  }
});
