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

contextBridge.exposeInMainWorld('kimiChat', {
  // 渲染层 → 主进程：启动 ACP 会话
  // 返回 Promise<{ ok, agentInfo?, sessionId?, configOptions?, error? }>
  start: () => ipcRenderer.invoke('acp-chat:start'),
  // 渲染层 → 主进程：发送一条用户消息（文本先做裁剪校验）
  // 返回 Promise<{ ok, stopReason?, error? }>
  sendPrompt: (text) => ipcRenderer.invoke('acp-chat:prompt', sanitizeText(text)),
  // 主进程 → 渲染层：订阅 acp-chat:event 事件流（status / message-chunk /
  // thought-chunk / commands / tool-call / tool-call-update /
  // permission-pending / permission-resolved / prompt-done）
  // 返回退订函数；fn 不是函数时返回空函数
  onEvent: (fn) => {
    if (!isFn(fn)) return () => {};
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on('acp-chat:event', listener);
    return () => ipcRenderer.removeListener('acp-chat:event', listener);
  },
});
