// Workspace context 待同步标志（P1-2 修复）——极小纯函数模块，node 可测，无副作用。
// 契约：overlay（sessions/setup 覆盖层）显示期间 workspaceView 已从主窗口内容树
// 移除（z-order 暂隐），pushWorkspaceEvent 不得把事件交给已移出的 view；但
// {kind:'context'} 必须记入"待同步"标志（多次 context 合并为一次），overlay 关闭后
// 恰好补发一次（M6 起经 workspace-restore 安全恢复流程），保证页面清空旧
// contextKey/DOM。非 context 事件不积压（直接丢弃，不影响标志）。
// 所有函数返回新状态（纯函数，不改入参）。状态为布尔 pending。
'use strict';

// overlay 覆盖期间的推送：payload.kind === 'context' → 置位待同步（幂等：多次
// context 合并为一次 pending）；其余事件（activities/refresh 等）→ 保持原状态，
// 不积压。返回新的 pending 值。
function noteContextWhileOverlay(pending, payload) {
  return payload && payload.kind === 'context' ? true : !!pending;
}

// overlay 关闭后的恢复：pending 且 restorable（面板应恢复可见，即 workspaceVisible
// 且 workspaceView 存活）→ { send: true, pending: false }；未恢复（collapsed，页面未
// 加载）→ 不补发但同样复位标志（恰好一次：drain 后无论是否补发都复位，绝不残留、
// 绝不重复——页面下次加载会自行同步 context）。
// M6：send:true 时调用方不得把保有旧 DOM 的 view 直接挂回后再补发——必须走
// workspace-restore 安全恢复（隐藏态重置 + renderer ack + 单次挂回）。
function drainContextAfterOverlay(pending, restorable) {
  if (pending && restorable) return { send: true, pending: false };
  return { send: false, pending: false };
}

module.exports = {
  noteContextWhileOverlay,
  drainContextAfterOverlay,
};
