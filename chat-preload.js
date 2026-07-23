// Kimi Code Desktop — ACP 原生聊天原型窗预加载桥接
// contextIsolation 环境下，向渲染层暴露最小化、经过校验的 IPC 接口。
// 渲染层不接触子进程与文件系统；启动会话、发送消息均由主进程处理。
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

contextBridge.exposeInMainWorld('kimiChat', {
  // 渲染层 → 主进程：启动 ACP 会话
  // opts 可传 { cwd, sessionId } 恢复既有会话，或不传新建临时目录会话
  // 返回 Promise<{ ok, agentInfo?, sessionId?, configOptions?, cwd?, resumed?, error? }>
  start: (opts) => ipcRenderer.invoke('acp-chat:start', sanitizeStartOpts(opts)),
  // 渲染层 → 主进程：发送一条用户消息（文本先做裁剪校验）
  // 返回 Promise<{ ok, stopReason?, error? }>
  sendPrompt: (text) => ipcRenderer.invoke('acp-chat:prompt', sanitizeText(text)),
  // 渲染层 → 主进程：切换会话配置项（模型/思考/模式）
  // configId、value 均须为非空字符串、各封顶 200 字符，非法直接返回失败
  // 返回 Promise<{ ok, configOptions?, error? }>
  setConfig: (configId, value) => {
    if (!isStr(configId) || !configId.trim() || !isStr(value) || !value.trim()) {
      return Promise.resolve({ ok: false, error: '参数非法' });
    }
    return ipcRenderer.invoke('acp-chat:set-config', configId.trim().slice(0, 200), value.trim().slice(0, 200));
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
});
