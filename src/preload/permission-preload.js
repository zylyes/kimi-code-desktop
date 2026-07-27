// Kimi Code Desktop — 权限审批窗口预加载桥接
// contextIsolation 环境下，向渲染层暴露最小化、经过校验的 IPC 接口。
// 渲染层不直接触碰 ACP 子进程；审批结果统一由主进程回传给 acp-client。
const { contextBridge, ipcRenderer } = require('electron');

const isFn = (v) => typeof v === 'function';
const isStr = (v) => typeof v === 'string';

// 出站只放行 optionId（字符串或 null，null 表示取消），
// 裁剪超长文本，避免意外转发异常结构
function sanitizeOptionId(optionId) {
  if (optionId == null) return null;
  return isStr(optionId) ? optionId.slice(0, 200) : null;
}

contextBridge.exposeInMainWorld('kimiPermission', {
  // 主进程 → 渲染层：初始审批数据（主进程在 did-finish-load 后发送）
  // payload: { title, kind, detail, locations: [{ path, line? }], options: [{ optionId, name, kind }] }
  onInit: (fn) => {
    if (!isFn(fn)) return () => {};
    const listener = (_e, data) => fn(data);
    ipcRenderer.on('acp-permission:init', listener);
    return () => ipcRenderer.removeListener('acp-permission:init', listener);
  },
  // 渲染层 → 主进程：用户选择某个选项；传 null 表示取消（Esc / 取消按钮）
  respond: (optionId) => ipcRenderer.invoke('acp-permission:respond', sanitizeOptionId(optionId)),
});
