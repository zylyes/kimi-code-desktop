// 普通 ACP permission 审批窗 respond 准入与结算决策（M5 P1 最后一项）
// node 可测，无 Electron 依赖。main.js 的 acp-permission:respond handler 走本
// 模块的决策函数，保证：
// 1. 窗口创建时捕获不可变 request identity（settle 引用 + params 引用），
//    respond 仅在"窗口仍为当前窗、sender 为当前窗 webContents、当前 pending 的
//    settle 与窗口捕获 settle 严格相等、params 引用仍为同一请求"时才允许结算；
// 2. 准入后只结算决策返回的 captured pending——绝不读取/结算全局当前 pending，
//    settle 同步 pump 出的新请求不受旧窗口延迟 respond 影响；
// 3. dispose/cancel/close/窗口替换后（窗口失效或身份被清空）旧窗延迟 IPC
//    （即使 optionId 与新请求重合）一律拒绝且不影响新 pending。
'use strict';

// 准入判定：全条件满足才允许 respond 进入结算。
// windowActive        窗口仍为当前审批窗（acpPermissionWindow 存在、未销毁）
// senderIsCurrentWindow sender === acpPermissionWindow.webContents
// windowSettle        窗口创建时捕获的 settle（无窗口/已清理 → null）
// windowParams        窗口创建时捕获的 params（类型/请求匹配的引用级校验）
// pending             当前在途请求（acpPermissionPending）
function canSettleAcpPermission({ windowActive, senderIsCurrentWindow, windowSettle, windowParams, pending }) {
  if (!windowActive) return false;               // 窗口已关闭/替换/未创建
  if (!senderIsCurrentWindow) return false;      // 非当前窗 sender（恶意/延迟 IPC）
  if (!windowSettle) return false;               // 无窗口捕获 identity（已清理/dispose）
  if (!pending) return false;                    // 无在途请求
  if (pending.settle !== windowSettle) return false; // pending 与窗口捕获 settle 不匹配
  if (pending.params !== windowParams) return false; // 类型/请求不匹配（引用级，防御防呆）
  return true;
}

// 解析 respond raw：兼容旧形态（裸字符串 optionId）与新形态（{ optionId, feedback? }）
function parsePermissionRespond(raw) {
  let optionId;
  let feedback;
  if (raw !== null && typeof raw === 'object') {
    optionId = typeof raw.optionId === 'string' ? raw.optionId : null;
    feedback = typeof raw.feedback === 'string' ? raw.feedback.slice(0, 2000) : '';
  } else {
    optionId = raw;
    feedback = '';
  }
  return { optionId, feedback };
}

// 请求可选项 ID 列表（optionId 必须在当前请求可选项内，防伪造/防事件误报）
function validOptionIds(pending) {
  const params = pending && pending.params;
  return (Array.isArray(params && params.options) ? params.options : [])
    .filter((o) => o && typeof o.optionId === 'string')
    .map((o) => o.optionId);
}

// 决策入口：先准入（canSettleAcpPermission），再解析/校验，返回：
//   { action: 'reject', error }                       —— 非当前窗/身份不匹配/窗口失效
//   { action: 'selected', pending, optionId, feedback }—— 合法选项（pending 为捕获请求）
//   { action: 'cancelled', pending, feedback }         —— 无 optionId / optionId 非法
// 调用方只能结算返回的 captured pending（decision.pending），不得重读全局 pending。
function decidePermissionRespond({ windowActive, senderIsCurrentWindow, windowSettle, windowParams, pending, raw }) {
  if (!canSettleAcpPermission({ windowActive, senderIsCurrentWindow, windowSettle, windowParams, pending })) {
    return { action: 'reject', error: '非当前审批窗或请求不匹配' };
  }
  const { optionId, feedback } = parsePermissionRespond(raw);
  if (optionId === null) {
    return { action: 'cancelled', pending, feedback };
  }
  if (typeof optionId !== 'string' || !validOptionIds(pending).includes(optionId)) {
    return { action: 'cancelled', pending, feedback };
  }
  return { action: 'selected', pending, optionId, feedback };
}

// ---------- loadFile 失败回退协调（M5 最后一个 P1） ----------
// 缺陷：load catch 在 win.close()（closed handler 同步清空全局 acpPermissionWindow
// 与捕获身份）之后用 `acpPermissionWindow === win` 判断是否回退——窗口已被清空 →
// fallbackAcpPermissionDialog 不执行 → acpPermissionPending 永久在途、FIFO pump 卡死。
// 修复：关闭失败窗之前捕获并验证该窗口创建时的 request identity（windowSettle/
// windowParams）仍是当前有效请求；关闭后只用捕获身份执行 fallback 或取消，绝不
// 依赖全局 acpPermissionWindow，也绝不触碰同步 pump 出的下一请求。

// close 之前调用：验证窗口创建时捕获的 identity 是否仍是当前有效请求（窗口仍为
// 当前审批窗 + 当前 pending 的 settle/params 与捕获身份严格相等，引用级）。
// 返回 { action: 'fallback', pending, windowSettle, windowParams }——pending 为
//   捕获的当前有效请求，调用方只能用它结算（fallback 对话框或取消）；
//   { action: 'skip', reason }——窗口已替换/identity 不匹配/dispose 后失效：
//   不 fallback、不结算（该请求已被 closed/取消路径收尾，或已非当前请求；旧路径
//   绝不触碰同步 pump 出的新请求）。
function planPermissionLoadFail({ windowIsCurrent, pending, windowSettle, windowParams }) {
  if (!windowIsCurrent) return { action: 'skip', reason: 'window-replaced' };
  if (!pending) return { action: 'skip', reason: 'no-pending' };
  if (pending.settle !== windowSettle) return { action: 'skip', reason: 'settle-mismatch' };
  if (pending.params !== windowParams) return { action: 'skip', reason: 'params-mismatch' };
  return { action: 'fallback', pending, windowSettle, windowParams };
}

// 对话框按钮索引 → 审批决策（与既有 fallback 语义一致）：idx 落在 options 内 →
// selected（该 optionId）；否则（含「拒绝」按钮、Esc、异常）→ cancelled
function decisionFromDialogResponse(response, options) {
  const idx = typeof response === 'number' ? response : -1;
  if (idx >= 0 && idx < options.length && options[idx] && typeof options[idx].optionId === 'string') {
    return { outcome: 'selected', optionId: options[idx].optionId };
  }
  return { outcome: 'cancelled' };
}

// 执行权限回退对话框并结算捕获请求（showDialog 注入，node 可测）：
//   options     审批选项（payload.options，按钮 0..n-1，n 后为「拒绝」）
//   settle      捕获请求的 settle（幂等：一次失败最多结算一次）
//   showDialog  返回 Promise<{ response }> 的对话框调用；同步抛异常或返回非
//               Promise（对话框不可用）→ 直接取消捕获请求，settle 内部同步 pump
//               队列，绝不悬挂
//   log         可选日志（默认忽略）
// 结算路径（对话框响应 / 取消 / 异常）均 try/catch，settle 异常不逃逸为
// unhandled rejection。
function runPermissionFallbackDialog({ options, settle, showDialog, log }) {
  const doSettle = (decision) => {
    try {
      settle(decision);
    } catch (err) {
      if (log) log(`权限审批对话框结算失败: ${err && err.message ? err.message : String(err)}`);
    }
  };
  const cancel = (msg) => {
    if (msg && log) log(msg);
    doSettle({ outcome: 'cancelled' });
  };
  let shown;
  try {
    shown = showDialog();
  } catch (err) {
    cancel(`权限审批对话框失败: ${err && err.message ? err.message : String(err)}`);
    return;
  }
  if (!shown || typeof shown.then !== 'function') {
    cancel('权限审批对话框不可用，按取消收尾');
    return;
  }
  shown.then((result) => {
    doSettle(decisionFromDialogResponse(result && result.response, options));
  }).catch((err) => {
    cancel(`权限审批对话框失败: ${err && err.message ? err.message : String(err)}`);
  });
}

module.exports = {
  canSettleAcpPermission,
  parsePermissionRespond,
  validOptionIds,
  decidePermissionRespond,
  planPermissionLoadFail,
  decisionFromDialogResponse,
  runPermissionFallbackDialog,
};
