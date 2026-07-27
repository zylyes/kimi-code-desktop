// Kimi Code Desktop — 问答窗口预加载桥接
// contextIsolation 环境下，向渲染层暴露最小化、经过校验的 IPC 接口。
// 渲染层不持有 token、不直接发 HTTP；提交/回退/取消均由主进程处理。
const { contextBridge, ipcRenderer } = require('electron');

const isFn = (v) => typeof v === 'function';
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';

// 只放行契约内字段，裁剪超长文本，避免意外转发异常结构
function sanitizePayload(p) {
  const src = isObj(p) ? p : {};
  const out = {
    question_id: isStr(src.question_id) ? src.question_id.slice(0, 200) : '',
    session_id: isStr(src.session_id) ? src.session_id.slice(0, 200) : '',
  };
  if (isObj(src.answers)) {
    const answers = {};
    for (const key of Object.keys(src.answers).slice(0, 50)) {
      const v = src.answers[key];
      if (!isStr(key) || !isObj(v)) continue;
      const item = { kind: isStr(v.kind) ? v.kind : '' };
      if (isStr(v.option_id)) item.option_id = v.option_id.slice(0, 200);
      if (Array.isArray(v.option_ids)) {
        item.option_ids = v.option_ids.filter(isStr).slice(0, 100).map((s) => s.slice(0, 200));
      }
      if (isStr(v.other_text)) item.other_text = v.other_text.slice(0, 4000);
      if (isStr(v.text)) item.text = v.text.slice(0, 4000);
      answers[key.slice(0, 200)] = item;
    }
    out.answers = answers;
  }
  return out;
}

contextBridge.exposeInMainWorld('kimiQuestion', {
  // 主进程 → 渲染层：初始问题数据（主进程在 did-finish-load 后发送）
  onInit: (fn) => {
    if (!isFn(fn)) return () => {};
    const listener = (_e, data) => fn(data);
    ipcRenderer.on('question:init', listener);
    return () => ipcRenderer.removeListener('question:init', listener);
  },
  // 主进程 → 渲染层：问题已在别处被回答/关闭（窗口即将销毁的预告）
  onDismiss: (fn) => {
    if (!isFn(fn)) return () => {};
    const listener = (_e, info) => fn(info);
    ipcRenderer.on('question:dismiss', listener);
    return () => ipcRenderer.removeListener('question:dismiss', listener);
  },
  // 渲染层 → 主进程：提交全部答案，返回 Promise<{ ok: boolean, message?: string }>
  submit: (payload) => ipcRenderer.invoke('question:submit', sanitizePayload(payload)),
  // 渲染层 → 主进程：回退到 Kimi 网页界面回答
  fallback: (payload) => ipcRenderer.invoke('question:fallback', sanitizePayload(payload)),
  // 渲染层 → 主进程：用户取消（Esc / 暂不回答）
  cancel: (payload) => ipcRenderer.invoke('question:cancel', sanitizePayload(payload)),
});
