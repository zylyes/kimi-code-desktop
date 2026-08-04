// workspace-ipc-guard：Workspace 面板 IPC/导航/日志广播的纯决策 helper（M6）
//
// 模块契约：
// - 纯 Node 模块，无任何 electron 依赖，可用 `node tests/test-workspace-ipc-guard.js` 直跑
// - 纯函数：不做任何状态修改/副作用；main.js 只消费决策结果并落地
//
// 覆盖 M6 安全决策：
// 1) Workspace 视图导航与 sender 准入：视图只允许精确本地 workspace.html；
//    isWorkspaceSender 的纯决策内核（sender 匹配 + 主 frame + 当前 URL 精确等于预期页面）
// 2) IPC 输入白名单：panelState/selectCandidate/files/diff 的 plain-object、字段白名单、
//    类型与安全长度校验（snapshotId/entryId/relPath/sessionId 限长）
// 3) 固定错误 reason：renderer 只拿到固定 reason，详细 err.message 仅本地脱敏日志
// 4) server:log 广播门：主 Web（HTTP(S) 的 kimi web）不接收日志广播（避免路径/内部信息
//    泄露）；受控本地 file 页面保留所需日志

'use strict';

// renderer 在异常路径得到的固定错误 reason（详细 err.message 仅写本地日志，绝不回传）
const ERROR_REASON = 'error';

// 仅接受普通对象：数组 / 类实例 / 原型链被改写的对象一律拒绝（structured clone 到达
// 主进程的常规 IPC 参数均为 Object.prototype 的 plain object）
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// 字段白名单：对象只允许出现 whitelist 内的键（多余键 → 拒绝）
function hasOnlyKeys(obj, keys) {
  return Object.keys(obj).every((k) => keys.includes(k));
}

// ---------- IPC 输入校验（各返回 { ok:true, value } 或 { ok:false, reason:'bad-arg' }） ----------

// workspace:panelState：undefined/null（查询）或 { collapsed:boolean }（设置，字段白名单）
function validatePanelState(arg) {
  if (arg === undefined || arg === null) return { ok: true, value: null };
  if (!isPlainObject(arg) || !hasOnlyKeys(arg, ['collapsed'])) return { ok: false, reason: 'bad-arg' };
  if ('collapsed' in arg && typeof arg.collapsed !== 'boolean') return { ok: false, reason: 'bad-arg' };
  return { ok: true, value: 'collapsed' in arg ? { collapsed: arg.collapsed } : null };
}

// workspace:selectCandidate：{ sessionId: string 1..128 }（字段白名单 + 长度上限）
const SESSION_ID_MAX_LEN = 128; // 与 session-workspace.isValidSessionId 的长度上限一致
function validateSelectCandidate(arg) {
  if (!isPlainObject(arg) || !hasOnlyKeys(arg, ['sessionId'])) return { ok: false, reason: 'bad-arg' };
  const sid = arg.sessionId;
  if (typeof sid !== 'string' || sid.length === 0 || sid.length > SESSION_ID_MAX_LEN) {
    return { ok: false, reason: 'bad-arg' };
  }
  return { ok: true, value: { sessionId: sid } };
}

// workspace:files：{ action:'list'|'read', relPath: string ≤512 }（action 白名单 + 长度上限）
const FILE_RELPATH_MAX_LEN = 512;
const FILE_ACTIONS = ['list', 'read'];
function validateFilesArg(arg) {
  if (!isPlainObject(arg) || !hasOnlyKeys(arg, ['action', 'relPath'])) return { ok: false, reason: 'bad-arg' };
  const { action, relPath } = arg;
  if (!FILE_ACTIONS.includes(action)) return { ok: false, reason: 'bad-arg' };
  if (typeof relPath !== 'string' || relPath.length > FILE_RELPATH_MAX_LEN) {
    return { ok: false, reason: 'bad-arg' };
  }
  return { ok: true, value: { action, relPath } };
}

// workspace:diff：{ snapshotId: string 1..128, entryId: 整数 ≥0 或 ≤15 位数字串 }
//（snapshotId/字符串 entryId 限制安全长度；entryId 数字串口径与 git-service.toEntryId 对齐）
const SNAPSHOT_ID_MAX_LEN = 128;
const ENTRY_ID_DIGITS_RE = /^\d{1,15}$/;
function validateDiffArg(arg) {
  if (!isPlainObject(arg) || !hasOnlyKeys(arg, ['snapshotId', 'entryId'])) return { ok: false, reason: 'bad-arg' };
  const { snapshotId, entryId } = arg;
  if (typeof snapshotId !== 'string' || snapshotId.length === 0 || snapshotId.length > SNAPSHOT_ID_MAX_LEN) {
    return { ok: false, reason: 'bad-arg' };
  }
  const entryOk = (typeof entryId === 'number' && Number.isInteger(entryId) && entryId >= 0)
    || (typeof entryId === 'string' && ENTRY_ID_DIGITS_RE.test(entryId));
  if (!entryOk) return { ok: false, reason: 'bad-arg' };
  return { ok: true, value: { snapshotId, entryId } };
}

// workspace:contextRestored：{ restoreId: 正整数 ≤ 2^31-1 }（M6 overlay 关闭安全恢复
// 回执——页面 refreshContext 定型后回传 restoreId，主进程据此单次挂回面板视图）
function validateContextRestored(arg) {
  if (!isPlainObject(arg) || !hasOnlyKeys(arg, ['restoreId'])) return { ok: false, reason: 'bad-arg' };
  const id = arg.restoreId;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > 2147483647) {
    return { ok: false, reason: 'bad-arg' };
  }
  return { ok: true, value: { restoreId: id } };
}

// ---------- Workspace 视图导航 / sender 准入决策 ----------

// 预期 workspace 页面 URL（main.js 用 pathToFileURL(workspace.html 绝对路径).href 注入）：
// 当前/目标 URL 必须与预期 file URL 精确相等（含无 hash/query 后缀；loadFile 无选项加载
// 即为该精确形态，正常 loadFile 不受影响）
function isExpectedWorkspaceUrl(url, expectedUrl) {
  return typeof url === 'string' && url === expectedUrl;
}

// 导航决策：目标精确等于预期 workspace.html → 'allow'，其余（外部/重定向/任何偏离）→ 'reject'
function decideWorkspaceNavigation(url, expectedUrl) {
  return isExpectedWorkspaceUrl(url, expectedUrl) ? 'allow' : 'reject';
}

// sender 准入决策（isWorkspaceSender 纯函数内核）：
// 同时要求 sender 匹配面板视图 webContents、senderFrame 为 sender 的主 frame
//（拒绝 iframe/子 frame 发起）、当前视图 URL 精确等于预期 workspace.html
//（页面偏离预期后视图将先被销毁，此处为纵深防御的第二道闸）
function isWorkspaceSenderDecision(opts) {
  const { senderMatchesView, senderFrameIsMainFrame, currentUrl, expectedUrl } = (opts && typeof opts === 'object') ? opts : {};
  return !!(senderMatchesView === true
    && senderFrameIsMainFrame === true
    && isExpectedWorkspaceUrl(currentUrl, expectedUrl));
}

// ---------- server:log 广播门 ----------

// 主 Web（HTTP(S) 的 kimi web）不接收日志广播（避免路径/内部诊断信息泄露）；
// 仅受控本地 file 页面（loading 等）保留日志；空/非法 URL 一律不广播
function shouldBroadcastServerLog(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

module.exports = {
  ERROR_REASON,
  isPlainObject,
  hasOnlyKeys,
  validatePanelState,
  validateSelectCandidate,
  validateFilesArg,
  validateDiffArg,
  validateContextRestored,
  isExpectedWorkspaceUrl,
  decideWorkspaceNavigation,
  isWorkspaceSenderDecision,
  shouldBroadcastServerLog,
};
