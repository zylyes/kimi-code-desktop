// Kimi Code Desktop — ACP 原生聊天原型窗预加载桥接
// contextIsolation 环境下，向渲染层暴露最小化、经过校验的 IPC 接口。
// 渲染层不接触子进程与文件系统；启动会话、发送消息（含图片附件）、
// 选取图片、打开 Web UI 高级面板均由主进程处理。
const { contextBridge, ipcRenderer } = require('electron');

const isFn = (v) => typeof v === 'function';
const isStr = (v) => typeof v === 'string';

// 仅放行字符串消息：去首尾空白、裁剪到 8000 字符以内，非字符串一律视为空
function sanitizeText(text) {
  if (!isStr(text)) return '';
  return text.trim().slice(0, 8000);
}

// start(opts) 浅校验：只透传字符串字段 cwd/sessionId，各封顶 500 字符；
// opts 缺失或字段非法时按新建会话处理（透传空对象）
function sanitizeStartOpts(opts) {
  const clean = {};
  if (opts && typeof opts === 'object') {
    if (isStr(opts.cwd) && opts.cwd) clean.cwd = opts.cwd.slice(0, 500);
    if (isStr(opts.sessionId) && opts.sessionId) clean.sessionId = opts.sessionId.slice(0, 500);
  }
  return clean;
}

// 图片附件白名单与限额（与主进程约束保持一致）：
// 仅放行常见四种格式；base64 长度封顶约 14MB（解码后约 ≤10MB）；一次最多 4 张
const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_DATA_MAX_LEN = 14_000_000;
const IMAGE_MAX_COUNT = 4;
const IMAGE_DATA_RE = /^[A-Za-z0-9+/=]+$/;

// sendPrompt 的 images 参数校验：非数组按空数组处理；
// 逐元素白名单提取 { name, mimeType, data, size }，mimeType/data 非法即丢弃整个元素，
// 附属字段缺失时降级（name → ''，size → 0），合法元素封顶 4 个
function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  const clean = [];
  for (const img of images) {
    if (clean.length >= IMAGE_MAX_COUNT) break;
    if (!img || typeof img !== 'object') continue;
    if (!IMAGE_MIME_WHITELIST.has(img.mimeType)) continue;
    if (!isStr(img.data) || img.data.length > IMAGE_DATA_MAX_LEN || !IMAGE_DATA_RE.test(img.data)) continue;
    clean.push({
      name: isStr(img.name) ? img.name.slice(0, 100) : '',
      mimeType: img.mimeType,
      data: img.data,
      size: Number.isInteger(img.size) && img.size >= 0 ? img.size : 0,
    });
  }
  return clean;
}

contextBridge.exposeInMainWorld('kimiChat', {
  // 渲染层 → 主进程：启动 ACP 会话
  // opts 可传 { cwd, sessionId } 恢复既有会话，或不传新建临时目录会话
  // 返回 Promise<{ ok, agentInfo?, sessionId?, configOptions?, cwd?, resumed?, error? }>
  start: (opts) => ipcRenderer.invoke('acp-chat:start', sanitizeStartOpts(opts)),
  // 渲染层 → 主进程：发送一条用户消息（文本先做裁剪校验）
  // images 可选：[{ name, mimeType, data(base64), size }]，白名单校验后随文本一并发出
  // 返回 Promise<{ ok, stopReason?, error? }>
  sendPrompt: (text, images) => ipcRenderer.invoke('acp-chat:prompt', sanitizeText(text), sanitizeImages(images)),
  // 渲染层 → 主进程：打开系统图片选择器（主进程做解码与限额校验）
  // 返回 Promise<{ ok, images?: [{ name, mimeType, data, size }], skipped?: number, error? }>
  pickImages: () => ipcRenderer.invoke('acp-chat:pick-images'),
  // 渲染层 → 主进程：聚焦主窗（Web UI 高级面板）；主窗不存在时由主进程建窗并起服务
  // 返回 Promise<{ ok: true }>
  openWebUI: () => ipcRenderer.invoke('acp-chat:open-webui'),
  // 渲染层 → 主进程：切换会话配置项（模型/思考/模式）
  // configId、value 均须为非空字符串、各封顶 200 字符，非法直接返回失败
  // 返回 Promise<{ ok, configOptions?, error? }>
  setConfig: (configId, value) => {
    if (!isStr(configId) || !configId.trim() || !isStr(value) || !value.trim()) {
      return Promise.resolve({ ok: false, error: '参数非法' });
    }
    return ipcRenderer.invoke('acp-chat:set-config', configId.trim().slice(0, 200), value.trim().slice(0, 200));
  },
  // 渲染层 → 主进程：在系统浏览器中打开外部链接
  openExternal: (url) => {
    if (!isStr(url) || !/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false, error: '非法链接' });
    return ipcRenderer.invoke('shell:open-external', url.slice(0, 2000));
  },
  // 渲染层 → 主进程：取消当前在途 prompt
  // 返回 Promise<{ ok }>
  cancel: () => ipcRenderer.invoke('acp-chat:cancel'),
  // 主进程 → 渲染层：订阅 acp-chat:event 事件流（status / message-chunk /
  // thought-chunk / commands / tool-call / tool-call-update /
  // permission-pending / permission-resolved / prompt-done /
  // open-session / config-options / history / user-chunk）
  // 返回退订函数；fn 不是函数时返回空函数
  onEvent: (fn) => {
    if (!isFn(fn)) return () => {};
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on('acp-chat:event', listener);
    return () => ipcRenderer.removeListener('acp-chat:event', listener);
  },
  // 渲染层 → 主进程：执行本地命令（/usage、/status；非本地命令返回 not-local-command 放行给 CLI）
  // command 封顶 100 字符、sessionId 封顶 200 字符（null 表示全局工作区）
  // 返回 Promise<{ ok, kind?, generatedAt?, data?, code?, error? }>
  runLocalCommand: (command, sessionId) => ipcRenderer.invoke('chat:runLocalCommand', {
    command: String(command).slice(0, 100),
    sessionId: sessionId == null ? null : String(sessionId).slice(0, 200),
  }),
  // 主进程 → 渲染层：订阅 runtime 状态变化（acp-chat:event 事件流内
  // type === 'runtime-changed' 的事件，主进程 500ms 防抖后下发，payload 为
  // { kind, sessionId } 变更摘要）；返回退订函数；fn 不是函数时返回空函数
  onRuntimeChanged: (fn) => {
    if (!isFn(fn)) return () => {};
    const listener = (_e, payload) => {
      if (payload && payload.type === 'runtime-changed') fn(payload);
    };
    ipcRenderer.on('acp-chat:event', listener);
    return () => ipcRenderer.removeListener('acp-chat:event', listener);
  },
  // 渲染层 → 主进程：查询任务目录（会话任务/cron/子代理合并视图）
  // sessionId 可选（null -> 全部会话）、封顶 200 字符
  // 返回 Promise<{ entries, diagnostics?, error? }>
  getTaskCatalog: (sessionId) => ipcRenderer.invoke('chat:getTaskCatalog', {
    sessionId: sessionId == null ? null : String(sessionId).slice(0, 200),
  }),
  // 渲染层 → 主进程：查询子代理树（state.json agents 映射父子关系 + agents/*/wire.jsonl 步骤补绘）
  // sessionId 必填、封顶 200 字符；返回 Promise<{ ok, sessionId?, nodes?, diagnostics?, error? }>
  getSubagentTree: (sessionId) => ipcRenderer.invoke('chat:getSubagentTree', {
    sessionId: sessionId == null ? null : String(sessionId).slice(0, 200),
  }),
});

// 应用菜单面板桥接：与 preload.js 同名同构，供 menu-panel.js（chat.html 经 <script src> 挂载）消费
contextBridge.exposeInMainWorld('kimiDesktopMenu', {
  getDefinition: () => ipcRenderer.invoke('menu:getDefinition'),
  run: (id) => ipcRenderer.invoke('menu:run', id),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
});
