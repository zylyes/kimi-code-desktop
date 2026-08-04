// acp-permission-window 模块单元测试（M5 P1 最后一项：普通 ACP 审批窗 respond
// 窗口绑定 request identity 准入 + loadFile 失败回退协调）
// 用法：node test-acp-permission-window.js
// 覆盖：E1 dispose/cancel 或 close 后同步 pump E2，E1 延迟 respond（甚至 optionId
// 重合）被拒绝、E2 保持并可正常结算；当前 E2 窗正确响应通过；非当前 sender/旧窗/
// 窗口替换/dispose 后/settle 不匹配一律拒绝且不影响新 pending；loadFile 失败时
// close 之前捕获验证身份、关闭后只用捕获身份回退/取消（窗口已替换/identity 失效
// skip，fallback 不可用取消且队列继续，一次失败最多结算一次）。
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var mod = require('../src/main/acp-permission-window');

// ---------- 模拟 main.js 审批窗状态机 ----------
// pump 等价 pumpAcpPermissionQueue：创建一个请求（settle 闭包）并"打开"新窗
// （windowActive + windowSettle/windowParams 捕获 + currentSender）；settle 等价
// main.js 的 settle 闭包：幂等结算、清空在途/窗口身份（同步 pump 由调用方随后
// 再次 pump 模拟）。
function makeSim() {
  var state = {
    pending: null,
    windowSettle: null,
    windowParams: null,
    windowActive: false,
    currentSender: null,
    settled: [], // 每次结算记录 { outcome, optionId? }
    settleCalls: 0,
  };
  state.pump = function (params) {
    var done = false;
    var settle = function (inner) {
      if (done) return;
      done = true;
      state.settleCalls += 1;
      state.settled.push(inner);
      state.pending = null;
      state.windowSettle = null;
      state.windowParams = null;
      state.windowActive = false;
      state.currentSender = null;
    };
    state.pending = { settle: settle, params: params };
    state.windowSettle = settle;
    state.windowParams = params;
    state.windowActive = true;
    state.currentSender = 'wc-' + Math.random().toString(36).slice(2, 10);
  };
  return state;
}

// 以当前模拟状态执行一次 respond 决策（等价 main.js handler 的准入输入组装）
function decide(sim, sender, raw) {
  return mod.decidePermissionRespond({
    windowActive: sim.windowActive,
    senderIsCurrentWindow: sender === sim.currentSender,
    windowSettle: sim.windowSettle,
    windowParams: sim.windowParams,
    pending: sim.pending,
    raw: raw,
  });
}

// ---------- 1. canSettleAcpPermission 准入矩阵 ----------
function testCanSettleMatrix() {
  var settleA = function () {};
  var settleB = function () {};
  var paramsA = { options: [{ optionId: 'a' }] };
  var paramsB = { options: [{ optionId: 'b' }] };
  var pending = { settle: settleA, params: paramsA };
  var base = {
    windowActive: true,
    senderIsCurrentWindow: true,
    windowSettle: settleA,
    windowParams: paramsA,
    pending: pending,
  };
  // 全部满足（窗口当前 + sender 当前窗 + settle/params 与窗口捕获一致）→ 准入
  assert.strictEqual(mod.canSettleAcpPermission(base), true);
  // 窗口已关闭/替换/未创建 → 拒绝
  assert.strictEqual(mod.canSettleAcpPermission(Object.assign({}, base, { windowActive: false })), false);
  // 非当前窗 sender（恶意/延迟 IPC）→ 拒绝
  assert.strictEqual(mod.canSettleAcpPermission(Object.assign({}, base, { senderIsCurrentWindow: false })), false);
  // 窗口捕获 identity 已清空（dispose/cancel/close 后）→ 拒绝
  assert.strictEqual(mod.canSettleAcpPermission(Object.assign({}, base, { windowSettle: null })), false);
  assert.strictEqual(mod.canSettleAcpPermission(Object.assign({}, base, { windowParams: null })), false);
  // 无在途请求 → 拒绝
  assert.strictEqual(mod.canSettleAcpPermission(Object.assign({}, base, { pending: null })), false);
  // 当前 pending 的 settle 与窗口捕获 settle 不匹配（旧窗身份 vs 新请求）→ 拒绝
  assert.strictEqual(mod.canSettleAcpPermission(Object.assign({}, base, {
    pending: { settle: settleB, params: paramsB },
  })), false);
  // 类型/请求不匹配：settle 相同但 params 引用不同（防呆）→ 拒绝
  assert.strictEqual(mod.canSettleAcpPermission(Object.assign({}, base, {
    pending: { settle: settleA, params: paramsB },
  })), false);
}

// ---------- 2. parsePermissionRespond：兼容裸字符串与 { optionId, feedback? } ----------
function testParseRespond() {
  // 裸字符串（旧形态）
  assert.deepStrictEqual(mod.parsePermissionRespond('opt-1'), { optionId: 'opt-1', feedback: '' });
  // 新形态对象
  assert.deepStrictEqual(mod.parsePermissionRespond({ optionId: 'opt-1', feedback: '好' }),
    { optionId: 'opt-1', feedback: '好' });
  // 对象无 optionId / 非字符串 optionId → null（按取消）
  assert.deepStrictEqual(mod.parsePermissionRespond({}), { optionId: null, feedback: '' });
  assert.deepStrictEqual(mod.parsePermissionRespond({ optionId: 42 }), { optionId: null, feedback: '' });
  // 非对象非字符串（数字/布尔）→ 原样（随后按非法 optionId 取消）
  assert.deepStrictEqual(mod.parsePermissionRespond(7), { optionId: 7, feedback: '' });
  assert.deepStrictEqual(mod.parsePermissionRespond(null), { optionId: null, feedback: '' });
  // feedback 非字符串 → 空串；超长截断 2000
  assert.deepStrictEqual(mod.parsePermissionRespond({ optionId: 'a', feedback: 3 }), { optionId: 'a', feedback: '' });
  var long = 'x'.repeat(3000);
  assert.strictEqual(mod.parsePermissionRespond({ optionId: 'a', feedback: long }).feedback.length, 2000);
}

// ---------- 3. 当前窗正确响应：selected / cancelled（无 optionId）/ cancelled（非法） ----------
function testCurrentWindowRespondPasses() {
  var sim = makeSim();
  sim.pump({ options: [{ optionId: 'allow' }, { optionId: 'reject' }] });
  // 合法 optionId → selected，结算的是捕获的同一请求
  var d = decide(sim, sim.currentSender, { optionId: 'allow', feedback: 'ok' });
  assert.strictEqual(d.action, 'selected');
  assert.strictEqual(d.pending, sim.pending, '结算对象必须是准入时的同一请求');
  assert.strictEqual(d.optionId, 'allow');
  assert.strictEqual(d.feedback, 'ok');
  d.pending.settle({ outcome: 'selected', optionId: d.optionId });
  assert.strictEqual(sim.settleCalls, 1);
  assert.deepStrictEqual(sim.settled, [{ outcome: 'selected', optionId: 'allow' }]);

  // 无 optionId（raw null / 空对象）→ cancelled
  sim.pump({ options: [{ optionId: 'allow' }] });
  var d2 = decide(sim, sim.currentSender, null);
  assert.strictEqual(d2.action, 'cancelled');
  assert.strictEqual(d2.pending, sim.pending);
  d2.pending.settle({ outcome: 'cancelled' });
  assert.deepStrictEqual(sim.settled[1], { outcome: 'cancelled' });

  // optionId 不在可选项内（伪造）→ cancelled（语义保持：按取消处理）
  sim.pump({ options: [{ optionId: 'allow' }] });
  var d3 = decide(sim, sim.currentSender, { optionId: 'evil' });
  assert.strictEqual(d3.action, 'cancelled');
  assert.strictEqual(d3.pending, sim.pending);
  d3.pending.settle({ outcome: 'cancelled' });
  assert.strictEqual(sim.settleCalls, 3);
  // 非字符串 optionId（数字）→ cancelled
  sim.pump({ options: [{ optionId: 'allow' }] });
  var d4 = decide(sim, sim.currentSender, 7);
  assert.strictEqual(d4.action, 'cancelled');
}

// ---------- 4. P1 核心：E1 dispose/cancel 后同步 pump E2，E1 延迟 respond
// （optionId 与 E2 重合）被拒绝，E2 保持并可正常结算 ----------
// 场景还原：E1 在途 → cancelAllAcpPermissions/disposeAcpClient 结算 E1（settle
// 同步 pump 队列下一项）→ E2 在途 + 新窗已替换。E1 旧窗的渲染层延迟（setTimeout）
// 发来 acp-permission:respond（optionId 恰好与 E2 相同）——修复前 handler 直接
// 结算全局 acpPermissionPending → E2 被误结算；修复后 sender/settle/params 三重
// 校验拒绝，E2 完好并可正常完成。
function testE1CancelSyncPumpE2StaleRespondRejected() {
  var sim = makeSim();
  // E1 在途（dispose/cancel 前）
  sim.pump({ options: [{ optionId: 'same' }] });
  var e1 = {
    pending: sim.pending,
    settle: sim.windowSettle,
    sender: sim.currentSender,
  };
  // E1 正常响应通过（dispose 前的合法窗口）
  var d0 = decide(sim, e1.sender, { optionId: 'same' });
  assert.strictEqual(d0.action, 'selected');
  assert.strictEqual(d0.pending, e1.pending);

  // dispose/cancel：结算 E1 → settle 内部同步 pump 出 E2（optionId 与 E1 重合）
  e1.settle({ outcome: 'cancelled' });
  assert.strictEqual(sim.settleCalls, 1);
  assert.strictEqual(sim.pending, null, 'E1 结算后旧 pending 已清空');
  sim.pump({ options: [{ optionId: 'same' }] }); // 同步 pump：E2 在途 + 新窗
  var e2 = {
    pending: sim.pending,
    settle: sim.windowSettle,
    sender: sim.currentSender,
  };
  assert.notStrictEqual(e2.settle, e1.settle, 'E2 是全新请求（新 settle）');
  assert.strictEqual(sim.settleCalls, 1, 'E2 尚未被结算');

  // E1 旧窗延迟 respond（旧 sender + optionId 与 E2 重合）→ 拒绝，E2 不受影响
  var stale = decide(sim, e1.sender, { optionId: 'same' });
  assert.strictEqual(stale.action, 'reject', 'E1 延迟 respond 必须被拒绝（sender 非当前窗）');
  assert.strictEqual(sim.settleCalls, 1, 'E1 延迟 respond 不得结算任何请求');
  assert.strictEqual(sim.pending, e2.pending, 'E2 保持为当前在途');

  // E1 旧窗的"取消"型延迟 respond（raw null）同样被拒绝
  var staleCancel = decide(sim, e1.sender, null);
  assert.strictEqual(staleCancel.action, 'reject', 'E1 延迟取消 respond 也必须被拒绝');
  assert.strictEqual(sim.pending, e2.pending, 'E2 仍保持');

  // E2 当前窗正常响应通过（settle/params 与窗口捕获一致）
  var fresh = decide(sim, e2.sender, { optionId: 'same' });
  assert.strictEqual(fresh.action, 'selected');
  assert.strictEqual(fresh.pending, e2.pending, '结算的必须是 E2 捕获请求');
  fresh.pending.settle({ outcome: 'selected', optionId: fresh.optionId });
  assert.deepStrictEqual(sim.settled, [
    { outcome: 'cancelled' },                    // E1：dispose/cancel 收尾
    { outcome: 'selected', optionId: 'same' },   // E2：未被 E1 延迟 IPC 误伤，正常完成
  ]);
  assert.strictEqual(sim.pending, null, 'E2 结算后无在途');
}

// ---------- 5. P1 核心：E1 关窗（close）后同步 pump E2，E1 延迟 respond 被拒 ----------
// 场景还原：用户关窗/Esc → closed handler settle E1（同步 pump E2）→ E2 新窗已
// 建立（窗口替换）。E1 旧窗 delayed closed 事件随后触发/延迟 IPC 到达——窗口
// 捕获身份已更换（windowSettle=E2 settle），E1 的响应命中不了新 pending。
function testE1CloseSyncPumpE2Rejected() {
  var sim = makeSim();
  sim.pump({ options: [{ optionId: 'x' }] });
  var e1 = { pending: sim.pending, settle: sim.windowSettle, sender: sim.currentSender };
  // 关窗 → closed guard 结算 E1 → 同步 pump E2（新窗替换）
  e1.settle({ outcome: 'cancelled' });
  sim.pump({ options: [{ optionId: 'x' }] }); // optionId 与 E1 重合
  var e2 = { pending: sim.pending, settle: sim.windowSettle, sender: sim.currentSender };

  // 变体 A：E1 旧窗延迟 respond（sender 仍是旧窗 wc）→ 拒绝
  var dA = decide(sim, e1.sender, { optionId: 'x' });
  assert.strictEqual(dA.action, 'reject');
  assert.strictEqual(sim.pending, e2.pending, 'E2 不受影响');
  // 变体 B：E1 旧窗 delayed closed 已触发（窗口身份清空/失效）→ 拒绝
  sim.windowActive = false;
  sim.windowSettle = null;
  sim.windowParams = null;
  var dB = decide(sim, e1.sender, { optionId: 'x' });
  assert.strictEqual(dB.action, 'reject');
  assert.strictEqual(sim.pending, e2.pending, '窗口失效后旧 IPC 不影响 E2');
  // E2 仍可正常结算
  sim.windowActive = true;
  sim.windowSettle = e2.settle;
  sim.windowParams = sim.pending.params;
  var fresh = decide(sim, e2.sender, { optionId: 'x' });
  assert.strictEqual(fresh.action, 'selected');
  assert.strictEqual(fresh.pending, e2.pending);
}

// ---------- 6. 恶意/延迟 IPC 矩阵：settle 不匹配、dispose 后、窗口替换、无在途 ----------
function testAdversarialRejected() {
  var sim = makeSim();
  sim.pump({ options: [{ optionId: 'a' }] });
  var e1 = { pending: sim.pending, settle: sim.windowSettle, sender: sim.currentSender };

  // dispose 后无在途（settle 结算完成、无队列项）→ 窗口失效 + pending null → 拒绝
  e1.settle({ outcome: 'cancelled' });
  var d1 = decide(sim, e1.sender, { optionId: 'a' });
  assert.strictEqual(d1.action, 'reject', 'dispose 后无在途的延迟 IPC 必须拒绝');
  assert.strictEqual(sim.settleCalls, 1, '不得新增结算');

  // settle 不匹配：窗口捕获的是旧 settle，pending 是全新请求（s2）→ 拒绝
  var settleB = function () {};
  var paramsB = { options: [{ optionId: 'b' }] };
  var d2 = mod.decidePermissionRespond({
    windowActive: true,
    senderIsCurrentWindow: true,
    windowSettle: e1.settle,   // 旧窗捕获身份
    windowParams: sim.pending && sim.pending.params, // E2 params
    pending: { settle: settleB, params: paramsB },   // 新请求（与窗口捕获不匹配）
    raw: { optionId: 'b' },
  });
  assert.strictEqual(d2.action, 'reject', 'settle 不匹配（旧窗身份 vs 新 pending）必须拒绝');

  // 窗口已替换：windowActive=true（新窗）但 sender 是旧窗 → 拒绝
  sim.pump({ options: [{ optionId: 'b' }] });
  var d3 = decide(sim, e1.sender, { optionId: 'b' });
  assert.strictEqual(d3.action, 'reject', '窗口替换后旧窗 sender 必须拒绝');
  assert.strictEqual(sim.pending.settle === sim.windowSettle, true, '新 pending 身份未被触碰');
  // 新窗当前 sender 正常通过
  var d4 = decide(sim, sim.currentSender, { optionId: 'b' });
  assert.strictEqual(d4.action, 'selected');
}

// ---------- 7. 静态接线回归：main.js 审批窗捕获身份 + respond 准入接线 ----------
function testMainWiringStatic() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  // require helper
  assert.ok(src.indexOf("require('./acp-permission-window')") >= 0,
    'main.js 必须 require acp-permission-window helper');
  // 窗口绑定 identity 声明
  assert.ok(src.indexOf('let acpPermissionWindowSettle = null;') >= 0,
    '必须声明 acpPermissionWindowSettle（窗口捕获 settle identity）');
  assert.ok(src.indexOf('let acpPermissionWindowParams = null;') >= 0,
    '必须声明 acpPermissionWindowParams（窗口捕获 params identity）');
  // openAcpPermissionWindow 创建时捕获并赋值身份
  assert.ok(src.indexOf('const windowSettle = settle;') >= 0,
    'openAcpPermissionWindow 必须捕获 windowSettle');
  assert.ok(src.indexOf('acpPermissionWindowSettle = windowSettle;') >= 0,
    '必须把捕获的 windowSettle 赋给窗口身份');
  assert.ok(src.indexOf('acpPermissionWindowParams = windowParams;') >= 0,
    '必须把捕获的 windowParams 赋给窗口身份');
  // did-finish-load：窗口仍为当前窗才 send init（窗口替换后旧窗不 send）
  var openStart = src.indexOf('function openAcpPermissionWindow');
  var openEnd = src.indexOf('function openAcpElicitationWindow');
  assert.ok(openStart >= 0 && openEnd > openStart);
  var openBody = src.slice(openStart, openEnd);
  assert.ok(openBody.indexOf('if (acpPermissionWindow !== win) return;') >= 0,
    'did-finish-load 必须校验窗口仍为当前审批窗');
  // closed：定向清理捕获身份（已替换新窗时旧窗 closed 不伤及新窗状态）
  assert.ok(openBody.indexOf('acpPermissionWindowSettle = null;') >= 0,
    'closed 必须清空窗口捕获 settle');
  assert.ok(openBody.indexOf('acpPermissionWindowParams = null;') >= 0,
    'closed 必须清空窗口捕获 params');
  // load catch（M5 最后一个 P1）：close 之前必须 planPermissionLoadFail 捕获验证身份；
  // 关闭后只用捕获身份回退；旧缺陷模式（close 后读全局 acpPermissionWindow === win
  // && acpPermissionPending 判回退）必须消失
  assert.ok(openBody.indexOf('planPermissionLoadFail') >= 0,
    'load catch 必须调用 planPermissionLoadFail（close 之前捕获验证身份）');
  var planCall = openBody.indexOf('const loadFailPlan = acpPermissionWindowHelper.planPermissionLoadFail({');
  var closeCall = openBody.indexOf('if (!win.isDestroyed()) win.close();');
  assert.ok(planCall >= 0 && closeCall > planCall,
    'planPermissionLoadFail 必须在 win.close() 之前执行（close 会清空全局窗口/身份）');
  assert.ok(openBody.indexOf('windowIsCurrent: acpPermissionWindow === win') >= 0,
    'plan 必须校验窗口仍为当前审批窗（close 之前）');
  assert.ok(openBody.indexOf('if (loadFailPlan.action === \'fallback\') {') >= 0,
    '关闭后必须按捕获 plan 的 action 决定是否回退');
  assert.ok(openBody.indexOf('fallbackAcpPermissionDialog(payload, loadFailPlan.pending.settle)') >= 0,
    '回退必须只用捕获身份（plan.pending.settle）结算');
  assert.ok(openBody.indexOf('acpPermissionWindow === win && acpPermissionPending') < 0,
    'close 之后不得再用全局 acpPermissionWindow === win 判断回退（旧缺陷模式已移除）');
  // closeAcpPermissionWindow 同步清空窗口与捕获身份
  var closeStart = src.indexOf('function closeAcpPermissionWindow');
  var closeEnd = src.indexOf('function closeAcpQuestionWindow');
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  var closeBody = src.slice(closeStart, closeEnd);
  assert.ok(closeBody.indexOf('acpPermissionWindowSettle = null;') >= 0,
    'closeAcpPermissionWindow 必须清空窗口捕获 settle');
  assert.ok(closeBody.indexOf('acpPermissionWindowParams = null;') >= 0,
    'closeAcpPermissionWindow 必须清空窗口捕获 params');
  // respond handler：走 decidePermissionRespond 准入，传窗口捕获身份与 sender 校验
  var respondStart = src.indexOf("'acp-permission:respond'");
  var respondEnd = src.indexOf('function showAcpChatWindow');
  assert.ok(respondStart >= 0 && respondEnd > respondStart);
  var respondBody = src.slice(respondStart, respondEnd);
  assert.ok(respondBody.indexOf('decidePermissionRespond') >= 0,
    'respond 必须走 decidePermissionRespond 准入');
  assert.ok(respondBody.indexOf('windowActive:') >= 0, '准入必须校验窗口仍为当前窗');
  assert.ok(respondBody.indexOf('senderIsCurrentWindow:') >= 0, '准入必须校验 sender 为当前窗');
  assert.ok(respondBody.indexOf('e.sender === win.webContents') >= 0,
    'sender 校验必须比对 e.sender 与 acpPermissionWindow.webContents');
  assert.ok(respondBody.indexOf('windowSettle: acpPermissionWindowSettle') >= 0,
    '准入必须传窗口捕获的 windowSettle');
  assert.ok(respondBody.indexOf('windowParams: acpPermissionWindowParams') >= 0,
    '准入必须传窗口捕获的 windowParams');
  // 准入后只结算捕获的 pendingRef（decision.pending），不得再读全局当前 pending
  assert.ok(respondBody.indexOf('const pendingRef = decision.pending;') >= 0,
    '准入后必须捕获 decision.pending（只结算该 captured 请求）');
  assert.ok(respondBody.indexOf('pendingRef.settle(') >= 0,
    '结算必须只针对捕获的 pendingRef');
  assert.ok(respondBody.indexOf('acpPermissionPending.settle(') < 0,
    'respond 不得再直接结算全局当前 pending');
  // fallbackAcpPermissionDialog 走可注入执行器（对话框不可用 → 取消，绝不悬挂）
  var fbStart = src.indexOf('function fallbackAcpPermissionDialog');
  var fbEnd = src.indexOf("ipcMain.handle('acp-permission:respond'");
  assert.ok(fbStart >= 0 && fbEnd > fbStart);
  var fbBody = src.slice(fbStart, fbEnd);
  assert.ok(fbBody.indexOf('runPermissionFallbackDialog({') >= 0,
    'fallback 必须走 runPermissionFallbackDialog（可注入、可测）');
  assert.ok(fbBody.indexOf('showDialog:') >= 0, 'fallback 必须注入 showDialog');
  assert.ok(fbBody.indexOf('dialog.showMessageBox') >= 0,
    'fallback 原生对话框仍经 dialog.showMessageBox 展示（既有 UI 保留）');
}

// ---------- 8. loadFile 失败协调（M5 最后一个 P1）：可执行行为测试 ----------
// 复刻 main.js 的 pump/openAcpPermissionWindow/closed/load catch 编排：pump 创建
// 请求 + settle 闭包 + 打开窗口（捕获窗口身份）；win.close() 同步触发 closed
// handler（fellBack 未置位时按取消结算并同步 pump 队列下一项）；loadFail(win, resp)
// 按修复后的 catch 路径：close 之前 planPermissionLoadFail 捕获验证身份 →
// fellBack=true → close → 按捕获 plan 走 runPermissionFallbackDialog（注入响应）。
function makeLoadFailSim() {
  var state = {
    queue: [],
    pending: null,
    window: null,
    windowSettle: null,
    windowParams: null,
    settled: [],
    settleCalls: 0,
    fallbackShown: 0,
    winSeq: 0,
  };
  var settleFn = function (params) {
    var done = false;
    return function (inner) {
      if (done) return; // settle 幂等：一次失败最多结算一次
      done = true;
      state.settleCalls += 1;
      state.settled.push(inner);
      state.pending = null;
      state.window = null;
      state.windowSettle = null;
      state.windowParams = null;
      state.pump(); // 同步推进队列（等价 settle 内部 pumpAcpPermissionQueue）
    };
  };
  state.pump = function () {
    if (state.pending) return; // 一次只审批一个
    var next = state.queue.shift();
    if (!next) return;
    var settle = settleFn(next.params);
    state.pending = { settle: settle, params: next.params };
    var win = {
      id: ++state.winSeq,
      destroyed: false,
      fellBack: false,
      settle: settle,
      params: next.params,
      isDestroyed: function () { return win.destroyed; },
      close: function () {
        // closed handler（等价 main.js）：定向清空窗口身份；fellBack 未置位 → 取消结算
        win.destroyed = true;
        if (state.window === win) {
          state.window = null;
          state.windowSettle = null;
          state.windowParams = null;
        }
        if (!win.fellBack) win.settle({ outcome: 'cancelled' });
      },
    };
    state.window = win;
    state.windowSettle = settle;
    state.windowParams = next.params;
    return win;
  };
  // 复刻 main.js load catch（修复后路径）：close 之前 plan → fellBack → close →
  // 按捕获身份 fallback（注入响应）或 skip。resp：数字按钮索引 / 'throw'（对话框
  // 同步抛）/ 'null'（对话框不可用返回 null）
  state.loadFail = function (win, resp) {
    var plan = mod.planPermissionLoadFail({
      windowIsCurrent: state.window === win,
      pending: state.pending,
      windowSettle: win.settle,
      windowParams: win.params,
    });
    win.fellBack = true;
    if (!win.isDestroyed()) win.close();
    if (plan.action === 'fallback') {
      state.fallbackShown += 1;
      mod.runPermissionFallbackDialog({
        options: (win.params && win.params.options) || [],
        settle: plan.pending.settle, // 只用捕获身份结算
        showDialog: function () {
          if (resp === 'throw') throw new Error('dialog broken');
          if (resp === 'null') return null;
          return Promise.resolve({ response: resp });
        },
        log: function () {},
      });
    }
    return plan;
  };
  return state;
}

function tick() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

// 场景 A：load fail → close 清空窗口 → 捕获的当前请求 E1 仍进入 fallback/settle
// 且队列推进（旧缺陷：close 后 acpPermissionWindow===win 恒 false，回退不执行、
// acpPermissionPending 永久在途、pump 卡死）
async function testLoadFailFallbackSettlesCapturedAndPumps() {
  var sim = makeLoadFailSim();
  sim.queue.push({ params: { options: [{ optionId: 'allow' }, { optionId: 'deny' }] } });
  sim.queue.push({ params: { options: [{ optionId: 'second' }] } });
  sim.pump();
  var e1 = sim.pending;
  var w1 = sim.window;
  assert.strictEqual(sim.settleCalls, 0);

  // load 失败：close 之前捕获并验证（plan fallback）→ fellBack → close（closed 清空窗口）
  var plan = sim.loadFail(w1, 0); // 用户点第一个按钮「allow」
  assert.strictEqual(plan.action, 'fallback', '窗口仍当前 + 身份匹配 → 必须回退');
  assert.strictEqual(plan.pending, e1, '回退针对的是捕获的当前请求 E1');
  assert.strictEqual(sim.window, null, 'close 已清空当前窗口（closed handler 同步）');
  assert.strictEqual(sim.windowSettle, null, 'close 已清空窗口捕获身份');
  assert.strictEqual(sim.settleCalls, 0, 'fellBack 置位后 closed 不按取消结算');

  await tick(); // 等 fallback 对话框 promise 结算
  assert.strictEqual(sim.settleCalls, 1, 'E1 只结算一次（一次失败最多结算一次）');
  assert.deepStrictEqual(sim.settled, [{ outcome: 'selected', optionId: 'allow' }],
    'fallback UI 批准语义保留');
  // 队列推进：E2 已 pump 且在途（新请求、新窗口身份），未被旧路径触碰
  assert.ok(sim.pending && sim.pending !== e1, '队列已推进到 E2');
  assert.strictEqual(sim.windowSettle, sim.pending.settle, 'E2 窗口捕获身份完好');
  assert.strictEqual(sim.settleCalls, 1, 'E2 未被误结算');
  // E2 可正常完成
  sim.pending.settle({ outcome: 'selected', optionId: 'second' });
  assert.deepStrictEqual(sim.settled[1], { outcome: 'selected', optionId: 'second' });
  assert.strictEqual(sim.pending, null, 'E2 结算后无在途');

  // 变体：fallback 对话框「拒绝」按钮（idx = options.length）→ cancelled
  var sim2 = makeLoadFailSim();
  sim2.queue.push({ params: { options: [{ optionId: 'allow' }] } });
  sim2.pump();
  var w2 = sim2.window;
  var plan2 = sim2.loadFail(w2, 1); // 「拒绝」按钮
  assert.strictEqual(plan2.action, 'fallback');
  await tick();
  assert.deepStrictEqual(sim2.settled, [{ outcome: 'cancelled' }], '拒绝按钮 = 取消');
  assert.strictEqual(sim2.pending, null, '无队列项时结算后无在途');

  // 变体：对话框 promise reject → 按取消结算，队列继续
  var sim3 = makeLoadFailSim();
  sim3.queue.push({ params: { options: [{ optionId: 'allow' }] } });
  sim3.queue.push({ params: { options: [{ optionId: 'next' }] } });
  sim3.pump();
  var w3 = sim3.window;
  var plan3 = mod.planPermissionLoadFail({
    windowIsCurrent: sim3.window === w3,
    pending: sim3.pending,
    windowSettle: w3.settle,
    windowParams: w3.params,
  });
  w3.fellBack = true;
  w3.close();
  sim3.fallbackShown += 1;
  mod.runPermissionFallbackDialog({
    options: w3.params.options,
    settle: plan3.pending.settle,
    showDialog: function () { return Promise.reject(new Error('boom')); },
    log: function () {},
  });
  await tick();
  assert.deepStrictEqual(sim3.settled, [{ outcome: 'cancelled' }], '对话框异常 → 取消');
  assert.ok(sim3.pending, '队列继续推进');
}

// 场景 B：load fail 时窗口已被替换/同步 pump 出新请求 E2——旧路径必须 skip，
// 不 fallback、不结算，绝不触碰 E2
async function testLoadFailAfterReplaceSkips() {
  var sim = makeLoadFailSim();
  sim.queue.push({ params: { options: [{ optionId: 'x' }] } });
  sim.queue.push({ params: { options: [{ optionId: 'y' }] } });
  sim.pump();
  var e1 = sim.pending;
  var w1 = sim.window;
  // E1 被用户关窗/Esc（closed 未置位 fellBack）→ settle E1 cancelled → 同步 pump E2 + 新窗
  w1.close();
  assert.strictEqual(sim.settleCalls, 1);
  assert.deepStrictEqual(sim.settled[0], { outcome: 'cancelled' });
  var e2 = sim.pending;
  var w2 = sim.window;
  assert.ok(e2 && e2 !== e1, 'E2 已同步 pump 在途');
  assert.notStrictEqual(w2, w1, 'E2 新窗已替换');

  // E1 的 load catch 随后执行（窗口已替换）→ plan 必须 skip，不 fallback 不结算
  var plan = sim.loadFail(w1, 0);
  assert.strictEqual(plan.action, 'skip', '窗口已替换 → 旧路径必须 skip');
  assert.strictEqual(plan.reason, 'window-replaced');
  assert.strictEqual(sim.settleCalls, 1, '旧路径不新增结算');
  assert.strictEqual(sim.pending, e2, 'E2 不受影响');
  assert.strictEqual(sim.fallbackShown, 0, '不弹回退对话框');
  // E2 正常完成
  sim.pending.settle({ outcome: 'selected', optionId: 'y' });
  assert.deepStrictEqual(sim.settled[1], { outcome: 'selected', optionId: 'y' });

  // 变体：E1 已在 closed 中结算（身份清空），load catch 后到 → skip，不结算不弹窗
  var sim2 = makeLoadFailSim();
  sim2.queue.push({ params: { options: [{ optionId: 'x' }] } });
  sim2.pump();
  var w1b = sim2.window;
  w1b.close(); // closed → settle cancelled（fellBack 未置位），无队列项 → pending null
  var planB = sim2.loadFail(w1b, 0);
  assert.strictEqual(planB.action, 'skip', '请求已结算 → 旧路径必须 skip');
  assert.strictEqual(sim2.settleCalls, 1, '不重复结算');
  assert.strictEqual(sim2.fallbackShown, 0, '不弹回退对话框');
}

// ---------- 9. planPermissionLoadFail 分支矩阵（单元级） ----------
function testPlanPermissionLoadFailMatrix() {
  var settleA = function () {};
  var settleB = function () {};
  var paramsA = { options: [{ optionId: 'a' }] };
  var paramsB = { options: [{ optionId: 'b' }] };
  var pending = { settle: settleA, params: paramsA };
  var base = {
    windowIsCurrent: true,
    pending: pending,
    windowSettle: settleA,
    windowParams: paramsA,
  };
  // 全满足（窗口仍当前 + 身份严格匹配）→ fallback，pending 为捕获的当前有效请求
  var ok = mod.planPermissionLoadFail(base);
  assert.strictEqual(ok.action, 'fallback');
  assert.strictEqual(ok.pending, pending);
  assert.strictEqual(ok.windowSettle, settleA);
  assert.strictEqual(ok.windowParams, paramsA);
  // 窗口已关闭/替换/清理（close 后全局 acpPermissionWindow 已清空）→ skip
  var r1 = mod.planPermissionLoadFail(Object.assign({}, base, { windowIsCurrent: false }));
  assert.deepStrictEqual(r1, { action: 'skip', reason: 'window-replaced' });
  // 无在途请求（dispose/cancel 后）→ skip
  var r2 = mod.planPermissionLoadFail(Object.assign({}, base, { pending: null }));
  assert.deepStrictEqual(r2, { action: 'skip', reason: 'no-pending' });
  // 当前 pending 的 settle 与窗口捕获 settle 不匹配（旧窗身份 vs 新请求）→ skip
  var r3 = mod.planPermissionLoadFail(Object.assign({}, base, {
    pending: { settle: settleB, params: paramsB },
  }));
  assert.deepStrictEqual(r3, { action: 'skip', reason: 'settle-mismatch' });
  // 类型/请求不匹配：settle 相同但 params 引用不同（防呆）→ skip
  var r4 = mod.planPermissionLoadFail(Object.assign({}, base, {
    pending: { settle: settleA, params: paramsB },
  }));
  assert.deepStrictEqual(r4, { action: 'skip', reason: 'params-mismatch' });
}

// 场景 C：fallback 本身不可用（对话框同步抛异常 / 返回非 Promise）→ 捕获请求 E1
// 安全取消并让队列继续，绝不悬挂
async function testFallbackUnavailableCancelsAndPumps() {
  // C1：对话框同步抛异常
  var sim = makeLoadFailSim();
  sim.queue.push({ params: { options: [{ optionId: 'allow' }] } });
  sim.queue.push({ params: { options: [{ optionId: 'next' }] } });
  sim.pump();
  var e1 = sim.pending;
  var w1 = sim.window;
  var plan = sim.loadFail(w1, 'throw');
  assert.strictEqual(plan.action, 'fallback', '身份匹配 → 仍计划回退');
  // runPermissionFallbackDialog 同步取消 E1 → 同步 pump E2（队列推进）
  assert.strictEqual(sim.settleCalls, 1, 'fallback 不可用 → E1 取消且只结算一次');
  assert.deepStrictEqual(sim.settled[0], { outcome: 'cancelled' }, 'E1 安全取消');
  assert.ok(sim.pending && sim.pending !== e1, '队列继续推进到 E2');
  assert.strictEqual(sim.windowSettle, sim.pending.settle, 'E2 窗口身份完好');
  assert.strictEqual(sim.settleCalls, 1, 'E2 未被误结算');
  // E2 正常完成
  sim.pending.settle({ outcome: 'selected', optionId: 'next' });
  assert.deepStrictEqual(sim.settled[1], { outcome: 'selected', optionId: 'next' });

  // C2：对话框返回 null（不可用）
  var sim2 = makeLoadFailSim();
  sim2.queue.push({ params: { options: [{ optionId: 'allow' }] } });
  sim2.pump();
  sim2.loadFail(sim2.window, 'null');
  assert.strictEqual(sim2.settleCalls, 1, '对话框不可用 → 取消结算');
  assert.deepStrictEqual(sim2.settled[0], { outcome: 'cancelled' });
  assert.strictEqual(sim2.pending, null, '无队列项 → 无在途（pump 不卡死）');
}

var tests = [
  testCanSettleMatrix,
  testParseRespond,
  testCurrentWindowRespondPasses,
  testE1CancelSyncPumpE2StaleRespondRejected,
  testE1CloseSyncPumpE2Rejected,
  testAdversarialRejected,
  testMainWiringStatic,
  testPlanPermissionLoadFailMatrix,
  testLoadFailFallbackSettlesCapturedAndPumps,
  testLoadFailAfterReplaceSkips,
  testFallbackUnavailableCancelsAndPumps,
];

// 异步测试运行器（支持 async 行为测试：fallback 对话框 promise 结算在微任务内）
async function runAll() {
  var failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try {
      await tests[i]();
    } catch (e) {
      console.error('❌ ' + tests[i].name + ' 失败: ' + e.message);
      console.error('   ' + (e.stack || '').split('\n').slice(1).join('\n   '));
      failed++;
    }
  }
  if (failed === 0) {
    console.log('\n全部 acp-permission-window 测试通过 (' + tests.length + '/' + tests.length + ')');
  } else {
    console.log('\n' + failed + '/' + tests.length + ' 测试失败');
    process.exitCode = 1;
  }
}

runAll();
