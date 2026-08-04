// 工作区面板 preload（M2/M3）：contextIsolation 下仅暴露白名单内的 workspace:* 通道。
// 渲染层可用的能力：
// - workspace:getContext   查询当前会话上下文（bound/candidates/unbound）
// - workspace:panelState   查询/设置面板折叠态
// - workspace:selectCandidate  从候选列表显式绑定会话（仅本地索引命中的 sessionId 生效）
// - workspace:changes      查询会话工作目录 Git 变更（仅 bound 会话；敏感目录结果带 sensitive:true）
// - workspace:files        文件浏览：list（目录条目）/ read（文件预览）
// - workspace:diff         diff 预览（snapshotId + entryId）
// - workspace:projection   查询会话活动投影（agents/tasks 快照 + diagnostics，仅 bound 会话）
// - workspace:event        订阅主进程推送的事件（会话切换 { kind:'context' }、窗口聚焦 { kind:'refresh' } 等）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspace', {
  // 获取当前会话上下文（bound/candidates/unbound），由主进程解析
  getContext: () => ipcRenderer.invoke('workspace:getContext'),
  // 查询面板折叠态：{ collapsed: boolean }
  getPanelState: () => ipcRenderer.invoke('workspace:panelState'),
  // 设置面板折叠态（{ collapsed: boolean }），返回新状态
  setPanelState: (s) => ipcRenderer.invoke('workspace:panelState', s),
  // 显式绑定会话（sessionId 需命中本地索引，否则 ok:false）
  selectCandidate: (sessionId) => ipcRenderer.invoke('workspace:selectCandidate', { sessionId }),
  // 查询会话工作目录的 Git 变更（getChanges 结果，含 snapshotId 供 getDiff 使用）
  getChanges: () => ipcRenderer.invoke('workspace:changes'),
  // 列出工作目录条目（relPath 传空字符串表示根目录；返回 FileEntry[]）
  listFiles: (relPath) => ipcRenderer.invoke('workspace:files', { action: 'list', relPath }),
  // 读取文件预览（文本内容/截断；目录或二进制返回 ok:false）
  readFile: (relPath) => ipcRenderer.invoke('workspace:files', { action: 'read', relPath }),
  // 获取 diff 预览（snapshotId/entryId 取自 getChanges 结果）
  getDiff: (snapshotId, entryId) => ipcRenderer.invoke('workspace:diff', { snapshotId, entryId }),
  // 获取会话活动投影（仅 bound 会话；{ ok, agents, tasks, diagnostics, capturedAt }）
  getProjection: () => ipcRenderer.invoke('workspace:projection'),
  // overlay 关闭安全恢复回执（M6）：带 restoreId 的 context 事件处理完成
  // （旧 DOM 已同步清空 + 新 context 已定型）后回传，主进程凭 ack 单次挂回面板
  ackContextRestore: (restoreId) => ipcRenderer.send('workspace:contextRestored', { restoreId }),
  // 订阅主进程推送的事件（如会话切换触发 { kind:'context' }），返回取消订阅函数
  onEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('workspace:event', listener);
    return () => ipcRenderer.removeListener('workspace:event', listener);
  },
});
