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
});
