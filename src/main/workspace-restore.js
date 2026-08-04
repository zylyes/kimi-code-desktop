// Workspace 面板 overlay 关闭安全恢复状态机（M6）——纯逻辑模块，node 可测，无 electron 依赖。
//
// 背景：overlay（sessions/setup）显示时 Workspace view 被 removeChildView 暂隐，
// 但 WebContents/旧 DOM 保留；期间 context 变化被合并为 stale 标志（overlay-context-sync）。
// 若 overlay 关闭时直接把保有旧 DOM 的 view 挂回窗口，用户会先看到旧会话的
// diff/files/projection 一帧（旧 DOM 暴露）。
//
// 契约：
// - overlay 关闭且 stale：绝不能先挂回。先在隐藏态向页面发 {kind:'context', restoreId}——
//   页面按潜在身份切换处理（invalidate 同步清空旧 DOM → getContext 落地 → establish）
//   并回执 ack；主进程收到匹配 ack 才把 view 单次挂回。不依赖"发送后马上已渲染"的假设，
//   只依赖 renderer 逻辑定型后的显式回执。
// - ack 超时（页面卡死/JS 异常）：受控 reload workspace.html（销毁旧 DOM），load 完成后
//   再次发带同一 restoreId 的 context 事件等 ack；load 失败 → fail-closed 取消
//   （旧 DOM 可能仍在，绝不挂回）。
// - reload 后 ack 仍超时：旧 DOM 已随 reload 销毁，挂回不再暴露旧数据——兜底挂回，
//   防面板永久消失。
// - 重挂恰好一次：ack/超时任一路径落地后状态即清空，重复 ack/迟到回调一律忽略。
// - 取消（再次 overlay / 面板折叠销毁 / 主窗销毁 / 视图被替换）后，任何迟到 ack、
//   超时回调、reload promise 回调均不得再挂回（current 引用 + stage 双重校验）。
// - 恢复 pending 期间不向 view 推常规事件（调用方 pushWorkspaceEvent 以 isPending 拦截）；
//   授权同步与有界 index recheck 不依赖本模块，照常执行。
'use strict';

function createWorkspaceRestore(deps) {
  const sendContext = deps.sendContext;   // (view, restoreId) => void（可抛）
  const reload = deps.reload;             // (view) => Promise
  const mount = deps.mount;               // (view) => void（全部存活/可见性校验集中于调用方实现）
  const isViewUsable = deps.isViewUsable; // (view) => boolean（当前视图引用 + webContents 存活）
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const ackTimeoutMs = deps.ackTimeoutMs > 0 ? deps.ackTimeoutMs : 3000;
  const reloadAckTimeoutMs = deps.reloadAckTimeoutMs > 0 ? deps.reloadAckTimeoutMs : 5000;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;

  let current = null; // { id, view, stage: 'await-ack'|'reloading'|'await-reload-ack', timer }
  let nextId = 0;

  function clearTimer(state) {
    if (state.timer) { clearTimeoutFn(state.timer); state.timer = null; }
  }

  function errMsg(e) { return e && e.message ? e.message : String(e); }

  // 取消在途恢复（幂等）：清 timer + 置空。此后迟到 ack（id/view 不匹配或 current 为 null）
  // 与超时/reload 回调（current !== state）全部失效，绝不重挂已失效视图
  function cancel(reason) {
    if (!current) return;
    clearTimer(current);
    current = null;
    if (reason) log('工作区面板恢复已取消: ' + reason);
  }

  // 单次挂回唯一出口：状态清空后才 mount（mount 内部做可见性/窗口/视图存活校验，不抢焦点）
  function finishMount(state, via) {
    if (current !== state) return;
    clearTimer(state);
    current = null;
    log('工作区面板恢复挂回（' + via + '）');
    mount(state.view);
  }

  // await-ack 超时：页面未及时回执——受控 reload（销毁旧 DOM）后再等一次 ack
  function onAckTimeout(state) {
    if (current !== state || state.stage !== 'await-ack') return;
    log('工作区面板恢复 ack 超时（' + ackTimeoutMs + 'ms），改为受控 reload');
    enterReload(state);
  }

  // reload 后 ack 仍超时：旧 DOM 已随 reload 销毁，挂回安全（兜底，防面板消失）
  function onReloadAckTimeout(state) {
    if (current !== state || state.stage !== 'await-reload-ack') return;
    log('工作区面板 reload 后 ack 仍超时（' + reloadAckTimeoutMs + 'ms），挂回已重建视图');
    finishMount(state, 'reload 超时兜底');
  }

  function enterReload(state) {
    if (current !== state) return;
    clearTimer(state);
    if (!isViewUsable(state.view)) { cancel('视图已失效，放弃 reload'); return; }
    state.stage = 'reloading';
    let p;
    try { p = reload(state.view); } catch (e) {
      log('工作区面板 reload 调用异常: ' + errMsg(e));
      cancel('reload 异常');
      return;
    }
    Promise.resolve(p).then(() => {
      if (current !== state || state.stage !== 'reloading') return; // 已取消/被新恢复取代
      if (!isViewUsable(state.view)) { cancel('reload 后视图已失效'); return; }
      state.stage = 'await-reload-ack';
      state.timer = setTimeoutFn(() => onReloadAckTimeout(state), reloadAckTimeoutMs);
      // reload 已完成（旧 DOM 销毁）；通知失败不致命——超时兜底会挂回已重建视图
      try { sendContext(state.view, state.id); } catch (e) {
        log('工作区面板 reload 后通知失败: ' + errMsg(e));
      }
    }, (err) => {
      if (current !== state || state.stage !== 'reloading') return;
      // load 失败：旧 DOM 可能仍在——fail-closed 取消，绝不挂回
      log('工作区面板 reload 失败: ' + errMsg(err));
      cancel('reload 失败');
    });
  }

  // 开始恢复（overlay 关闭且 context stale 时调用）：隐藏态安全重置 → ack → 单次挂回
  function begin(view) {
    cancel(); // 旧恢复一律作废（快速连续开关 overlay / 再次 closeOverlay）
    const id = ++nextId;
    const state = { id, view, stage: 'await-ack', timer: null };
    current = state;
    if (!isViewUsable(view)) { cancel('视图已失效'); return; }
    state.timer = setTimeoutFn(() => onAckTimeout(state), ackTimeoutMs);
    try {
      sendContext(view, id);
    } catch (e) {
      log('工作区面板恢复通知失败: ' + errMsg(e));
      enterReload(state); // 通知即失败：受控 reload 再给一次机会
    }
  }

  // renderer 回执：处于等待 ack 阶段 + id 匹配 + view 引用相等 → 单次挂回；
  // reloading 阶段的迟到 ack 一律拒绝（旧 DOM 销毁未完成，不得挂回）
  function handleAck(view, restoreId) {
    const state = current;
    if (!state) return false;
    if (state.stage !== 'await-ack' && state.stage !== 'await-reload-ack') return false;
    if (state.id !== restoreId || state.view !== view) return false;
    finishMount(state, 'ack');
    return true;
  }

  function isPending() { return !!current; }

  return { begin, handleAck, cancel, isPending };
}

module.exports = { createWorkspaceRestore };
