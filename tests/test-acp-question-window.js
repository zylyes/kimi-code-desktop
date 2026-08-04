// acp-question-window 模块单元测试（M5 P1 ACP elicitation 问答窗生命周期）
// 用法：node test-acp-question-window.js
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var mod = require('../src/main/acp-question-window');

// ---------- 1. buildElicitationQuestionPayload：形状与字段映射 ----------
function testBuildPayload() {
  var parsed = {
    questions: [{
      key: 'q0',
      text: '请选择方案？',
      options: [
        { optionId: 'q0_opt_0', name: '方案 A', kind: 'allow_once', isSkip: false },
        { optionId: 'q0_skip', name: '跳过', kind: 'reject_once', isSkip: true },
      ],
      skipOptionId: 'q0_skip',
    }],
  };
  var p = mod.buildElicitationQuestionPayload(parsed, 'session_aaa_1');
  assert.strictEqual(p.question_id, 'acp-elicitation');
  assert.strictEqual(p.session_id, 'session_aaa_1');
  assert.strictEqual(p.questions.length, 1);
  assert.strictEqual(p.questions[0].id, 'q0');
  assert.strictEqual(p.questions[0].question, '请选择方案？');
  assert.strictEqual(p.questions[0].options.length, 2);
  assert.strictEqual(p.questions[0].options[0].id, 'q0_opt_0');
  assert.strictEqual(p.questions[0].options[0].label, '方案 A');
  assert.strictEqual(p.questions[0].options[0].description, '');
  assert.strictEqual(p.questions[0].options[1].id, 'q0_skip');
  assert.strictEqual(p.questions[0].options[1].label, '跳过');
  // sessionId 非字符串 → 空串
  var p2 = mod.buildElicitationQuestionPayload(parsed, null);
  assert.strictEqual(p2.session_id, '');
  // parsed 无 questions / 非法 → 空数组（不抛）
  var p3 = mod.buildElicitationQuestionPayload(null, 's');
  assert.deepStrictEqual(p3.questions, []);
  var p4 = mod.buildElicitationQuestionPayload({}, 's');
  assert.deepStrictEqual(p4.questions, []);
}

// ---------- 2. shouldSettleElicitation：settle 身份一致才结算 ----------
function testShouldSettle() {
  var settleA = function () {};
  var settleB = function () {};
  var pending = { kind: 'elicitation', settle: settleA, params: {} };
  // 在途仍是同一 elicitation → 结算
  assert.strictEqual(mod.shouldSettleElicitation(pending, settleA), true);
  // 遗留窗口 settle 与当前 pending 不一致 → 不结算
  assert.strictEqual(mod.shouldSettleElicitation(pending, settleB), false);
  // pending 已清空（已 settle/已取消/客户端销毁）→ 不结算
  assert.strictEqual(mod.shouldSettleElicitation(null, settleA), false);
  // 普通 ACP permission（非 elicitation）→ 不结算
  assert.strictEqual(mod.shouldSettleElicitation({ kind: 'permission', settle: settleA }, settleA), false);
  // pending 无 kind → 不结算
  assert.strictEqual(mod.shouldSettleElicitation({ settle: settleA }, settleA), false);
}

// ---------- 3. isWindowInitCurrent：ACP 窗绑定独立 epoch，绝不使用 wsGeneration ----------
function testIsWindowInitCurrent() {
  // ACP 窗：gen 匹配 acpElicitationEpoch 即有效（wsGeneration 已变也有效——
  // ACP 窗生命周期不受 WS 订阅代影响）
  assert.strictEqual(mod.isWindowInitCurrent('acp', 3, 99, 3), true);
  // ACP 窗：acp epoch 已递增（新请求/收尾）→ 旧窗口 init 无效
  assert.strictEqual(mod.isWindowInitCurrent('acp', 3, 3, 4), false);
  // 即使 gen 恰好等于当前 wsGeneration，acp epoch 不匹配也无效（绝不使用 wsGeneration）
  assert.strictEqual(mod.isWindowInitCurrent('acp', 99, 99, 3), false);
  // WS 窗：沿用 wsGeneration 语义
  assert.strictEqual(mod.isWindowInitCurrent('ws', 7, 7, 0), true);
  assert.strictEqual(mod.isWindowInitCurrent('ws', 6, 7, 0), false);
  // 未知 owner 按 WS 语义（兼容旧调用）
  assert.strictEqual(mod.isWindowInitCurrent(null, 7, 7, 0), true);
}

// ---------- 4. 静态回归：main.js ACP 问答窗接线 ----------
function testMainWiringStatic() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  // openAcpElicitationWindow 用 ElicitationIdentity.begin(settle) 建立身份（非 wsGeneration）
  assert.ok(src.indexOf('acpElicitationIdentity.begin(settle)') >= 0,
    'openAcpElicitationWindow 必须以 acpElicitationIdentity.begin(settle) 建立身份');
  assert.ok(src.indexOf("createQuestionWindow(params.sessionId || '', questionPayload, epoch, 'acp', settle)") >= 0,
    'createQuestionWindow 必须以 begin 返回的 epoch 作 gen，并传入捕获的 settle（P1-A）');
  assert.ok(src.indexOf('createQuestionWindow(params.sessionId || \'\', questionPayload, wsGeneration') < 0,
    'ACP 问答窗不得以 wsGeneration 作为 gen');
  // ACP_ELICITATION_QID 来自模块（main.js 不再自定常量）
  assert.ok(src.indexOf('const ACP_ELICITATION_QID =') < 0, 'main.js 不应再定义 ACP_ELICITATION_QID 常量');
  // P1-1：createQuestionWindow 的"已在途"替换判断必须用窗口-请求绑定 epoch
  // （questionWindowEpoch !== 当前请求身份 epoch = 遗留窗 → 替换），
  // 绝不能用"身份仍匹配"判断（E2 身份建立后旧窗会误判为在途而被取消）
  assert.ok(src.indexOf('let questionWindowEpoch = null;') >= 0, '须声明 questionWindowEpoch');
  assert.ok(src.indexOf('let questionWindowSettle = null;') >= 0, '须声明 questionWindowSettle');
  assert.ok(src.indexOf("questionWindowEpoch = owner === 'acp' ? gen : null;") >= 0,
    'createQuestionWindow 创建 ACP 窗时必须记录窗口绑定 epoch');
  assert.ok(src.indexOf("questionWindowSettle = owner === 'acp' ? acpSettle : null;") >= 0,
    'createQuestionWindow 创建 ACP 窗时必须记录窗口绑定 settle（P1-C）');
  assert.ok(src.indexOf('questionWindowSettle = null;') >= 0,
    'closed/清理路径必须清空 questionWindowSettle');
  assert.ok(src.indexOf('questionWindowEpoch !== acpElicitationIdentity.currentEpoch()') >= 0,
    '遗留窗替换判断必须比较窗口 epoch 与当前请求身份 epoch');
  assert.ok(src.indexOf('!shouldSettleElicitation(acpPermissionPending, acpElicitationIdentity.settle)') < 0,
    '不得再用身份匹配作为遗留窗替换判断（会误取消 settle 同步创建的新请求）');
  // cancelAllAcpPermissions 必须关闭 ACP 问答窗
  var cancelStart = src.indexOf('function cancelAllAcpPermissions');
  var cancelEnd = src.indexOf('function requestAcpPermission');
  assert.ok(cancelStart >= 0 && cancelEnd > cancelStart);
  var cancelBody = src.slice(cancelStart, cancelEnd);
  assert.ok(cancelBody.indexOf('closeAcpQuestionWindow()') >= 0,
    'cancelAllAcpPermissions 必须关闭 owner=acp 的 questionWindow');
  // question IPC 全部带 sender 校验
  for (var name of ['question:submit', 'question:fallback', 'question:cancel']) {
    var idx = src.indexOf("'" + name + "'");
    assert.ok(idx >= 0, '应存在 ' + name + ' handler');
    assert.ok(src.indexOf('isQuestionWindowSender(e)', idx) >= 0 && src.indexOf('isQuestionWindowSender(e)', idx) < idx + 400,
      name + ' handler 必须校验 sender 为当前 questionWindow');
  }
  // P1-1/P1-4：三个 question IPC 的 ACP 分支必须走 canSettleAcpElicitation 准入
  // + retire 先于 settle（结算前原子失效身份，防同步 pump 覆盖新请求身份）
  var submitStart = src.indexOf("'question:submit'");
  var submitEnd = src.indexOf("'question:fallback'");
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  var submitBody = src.slice(submitStart, submitEnd);
  assert.ok(submitBody.indexOf('canSettleAcpElicitation') >= 0, 'submit 必须走 canSettleAcpElicitation 准入');
  assert.ok(submitBody.indexOf('const pendingRef = acpPermissionPending;') >= 0,
    'submit 必须在准入前捕获当前 pending（准入后不得重读全局 pending）');
  assert.ok(submitBody.indexOf('.retire(') >= 0, 'submit 必须先 retire 失效身份');
  assert.ok(submitBody.indexOf('.retire(') < submitBody.indexOf('.settle('),
    'submit 中 retire 必须发生在 settle 之前（settle 可能同步 pump 新请求）');
  var fallbackStart = src.indexOf("'question:fallback'");
  var fallbackEnd = src.indexOf("'question:cancel'");
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart);
  var fallbackBody = src.slice(fallbackStart, fallbackEnd);
  assert.ok(fallbackBody.indexOf('canSettleAcpElicitation') >= 0, 'fallback 必须走 canSettleAcpElicitation 准入');
  assert.ok(fallbackBody.indexOf('const pendingRef = acpPermissionPending;') >= 0,
    'fallback 必须在准入前捕获当前 pending');
  assert.ok(fallbackBody.indexOf('.retire(') >= 0 && fallbackBody.indexOf('.retire(') < fallbackBody.indexOf('.settle('),
    'fallback 中 retire 必须发生在 settle 之前');
  var cancelStart2 = src.indexOf("'question:cancel'");
  var cancelEnd2 = src.indexOf('function focusMainWindow');
  assert.ok(cancelStart2 >= 0 && cancelEnd2 > cancelStart2);
  var cancelBody2 = src.slice(cancelStart2, cancelEnd2);
  assert.ok(cancelBody2.indexOf('canSettleAcpElicitation') >= 0, 'cancel 必须走 canSettleAcpElicitation 准入');
  assert.ok(cancelBody2.indexOf('const pendingRef = acpPermissionPending;') >= 0,
    'cancel 必须在准入前捕获当前 pending');
  assert.ok(cancelBody2.indexOf('.retire(') >= 0 && cancelBody2.indexOf('.retire(') < cancelBody2.indexOf('.settle('),
    'cancel 中 retire 必须发生在 settle 之前');
  // P1-B/P1-C：三个 IPC 的 ACP 分支必须同时校验 payload 的 question_id
  // （ACP_ELICITATION_QID）、窗口捕获的 request identity（windowEpoch/windowSettle
  // 与 identity 比对），且绝不以全局当前 settle 作为准入身份
  for (var body of [submitBody, fallbackBody, cancelBody2]) {
    var canSettleIdx = body.indexOf('canSettleAcpElicitation');
    var callEnd = body.indexOf('}))', canSettleIdx);
    assert.ok(canSettleIdx >= 0 && callEnd > canSettleIdx);
    var callArgs = body.slice(canSettleIdx, callEnd);
    assert.ok(callArgs.indexOf('payloadQuestionId: questionId') >= 0,
      'canSettleAcpElicitation 调用必须传入 payloadQuestionId（IPC payload 的 question_id）');
    assert.ok(callArgs.indexOf('windowEpoch: questionWindowEpoch') >= 0,
      'canSettleAcpElicitation 调用必须传入窗口捕获的 windowEpoch');
    assert.ok(callArgs.indexOf('windowSettle: questionWindowSettle') >= 0,
      'canSettleAcpElicitation 调用必须传入窗口捕获的 windowSettle');
    assert.ok(callArgs.indexOf('identity: acpElicitationIdentity') >= 0,
      'canSettleAcpElicitation 调用必须传入请求身份 identity');
    assert.ok(callArgs.indexOf('settle: acpElicitationIdentity.settle') < 0,
      'canSettleAcpElicitation 调用不得以全局当前 settle 作准入身份');
    assert.ok(body.indexOf('.retire(pendingRef, questionWindowSettle)') >= 0,
      '准入后必须只以窗口捕获的 windowSettle 退休（不得重读全局当前 settle）');
  }
  // P1-A：createQuestionWindow 的 ACP 失败 cleanup 必须传捕获的 acpSettle，
  // 不得调用读取全局当前身份的无参 settleAcpElicitationCancelled
  var createStart = src.indexOf('function createQuestionWindow');
  var createEnd = src.indexOf('function showQuestionDialogFallback');
  assert.ok(createStart >= 0 && createEnd > createStart);
  var createBody = src.slice(createStart, createEnd);
  for (var reason of ['问答窗创建失败', '问答窗初始化前已销毁', '问答窗初始化失败', '问答窗加载失败']) {
    assert.ok(createBody.indexOf("settleAcpElicitationCancelled('" + reason + "', acpSettle)") >= 0,
      'createQuestionWindow ' + reason + ' cleanup 必须传捕获的 acpSettle');
    assert.ok(createBody.indexOf("settleAcpElicitationCancelled('" + reason + "')") < 0,
      'createQuestionWindow ' + reason + ' cleanup 不得调用无参（读全局当前身份）的结算');
  }
}

// ---------- 5. P1-1：连续两个 elicitation 的同步 reentry ----------
// 模拟 main.js 的 pump 重放：当前请求 settle() 内部同步 pump 下一个队列项，
// 下一个 elicitation 立即 begin() 建立新身份。第一个 settle 可同步创建第二个；
// 随后旧 cleanup 绝不破坏第二个（旧路径返回后不得清空/递增新请求身份）。
function testIdentitySyncReentry() {
  var id = new mod.ElicitationIdentity();
  var settled = [];
  var settle2 = null;
  // 模拟 main.js 的 settle：settled guard + 结算后同步 pump 下一个 elicitation
  var makeSettle = function (n) {
    var done = false;
    return function (o) {
      if (done) return;
      done = true;
      settled.push(o);
      if (n === 1) id.begin(settle2); // 同步 pump：第二个 elicitation 建立身份
    };
  };
  var settle1 = makeSettle(1);
  settle2 = makeSettle(2);

  // E1 建立（openAcpElicitationWindow 等效）
  var epoch1 = id.begin(settle1);
  assert.strictEqual(epoch1, 1);
  assert.strictEqual(id.currentEpoch(), 1);
  assert.strictEqual(id.settle, settle1);
  var pending1 = { kind: 'elicitation', settle: settle1, params: {} };
  // E1 init 有效
  assert.strictEqual(mod.isWindowInitCurrent('acp', epoch1, 99, id.currentEpoch()), true);

  // E1 窗口 submit 收尾：先原子失效身份，再结算旧 settle
  var retired1 = id.retire(pending1, id.settle);
  assert.strictEqual(retired1, settle1);
  assert.strictEqual(id.settle, null);
  assert.strictEqual(id.currentEpoch(), 2);
  // 结算 → settle 内部同步 pump 出第二个 elicitation（新身份建立）
  retired1({ outcome: 'selected', optionId: 'opt-x' });
  assert.strictEqual(id.settle, settle2);
  assert.strictEqual(id.currentEpoch(), 3);

  // 旧 cleanup 返回后不得再触碰身份——模拟旧 submit handler 的错误残留
  // （旧代码会在 settle 后清空身份/递增 epoch；修复后绝无此操作）：
  assert.strictEqual(id.settle, settle2, '旧路径返回后不得清空新请求的 settle 身份');
  assert.strictEqual(id.currentEpoch(), 3, '旧路径返回后不得递增新请求的 epoch');

  // 第二个 elicitation 的 init 必须仍有效且可结算
  var epoch2 = 3;
  assert.strictEqual(mod.isWindowInitCurrent('acp', epoch2, 0, id.currentEpoch()), true,
    '第二个 elicitation 的 init 必须仍有效（gen 与 currentEpoch 匹配）');
  var pending2 = { kind: 'elicitation', settle: settle2, params: {} };
  assert.strictEqual(mod.shouldSettleElicitation(pending2, id.settle), true,
    '第二个 elicitation 必须仍可结算');
  var retired2 = id.retire(pending2, id.settle);
  assert.strictEqual(retired2, settle2);
  retired2({ outcome: 'cancelled' });
  assert.deepStrictEqual(settled, [
    { outcome: 'selected', optionId: 'opt-x' },
    { outcome: 'cancelled' },
  ]);
  // 连续 begin 时 epoch 单调
  id.begin(settle1);
  assert.strictEqual(id.currentEpoch(), 5);
}

// ---------- 6. P1-1：retire 只失效捕获的旧 settle（旧窗口关闭不得误伤新请求） ----------
// E1 遗留窗口的 closed guard 以闭包捕获的旧 settle 为准 retire——即使队列已同步
// pump 出新请求（身份已更换），旧 guard 也绝不结算/破坏新请求身份。
function testRetireOnlyExpectedSettle() {
  var id = new mod.ElicitationIdentity();
  var settle1 = function () {};
  var settle2 = function () {};
  id.begin(settle1); // E1
  id.begin(settle2); // E1 已 settle，E2 在途（同步 reentry 结果）
  // E1 遗留窗口 closed guard 尝试 retire（旧 settle1）→ 不匹配，身份不动
  var pending2 = { kind: 'elicitation', settle: settle2, params: {} };
  var r = id.retire(pending2, settle1);
  assert.strictEqual(r, null);
  assert.strictEqual(id.settle, settle2, '旧 guard 不得清除新请求身份');
  assert.strictEqual(id.currentEpoch(), 2, '旧 guard 不得递增新请求 epoch');
  // E2 仍可正常结算
  assert.strictEqual(mod.shouldSettleElicitation(pending2, id.settle), true);
  var r2 = id.retire(pending2, id.settle);
  assert.strictEqual(r2, settle2);
  assert.strictEqual(id.settle, null);
  assert.strictEqual(id.currentEpoch(), 3);
  // 身份已失效后再 retire（pending 已清/身份已换）→ null 且不动 epoch
  assert.strictEqual(id.retire(pending2, settle2), null);
  assert.strictEqual(id.currentEpoch(), 3);
}

// ---------- 7. P1-4 + P1-B + P1-C：owner/窗口 QID/payload QID/窗口捕获 identity 错配拒绝 ----------
function testCanSettleAcpElicitation() {
  var settleA = function () {};
  var settleB = function () {};
  var pending = { kind: 'elicitation', settle: settleA, params: {} };
  var id = new mod.ElicitationIdentity();
  var epochA = id.begin(settleA);
  var base = {
    senderIsCurrentWindow: true,
    owner: 'acp',
    questionId: mod.ACP_ELICITATION_QID,
    payloadQuestionId: mod.ACP_ELICITATION_QID,
    pending: pending,
    windowEpoch: epochA,
    windowSettle: settleA,
    identity: id,
  };
  // 全部满足（窗口 QID + payload QID 均为 ACP elicitation ID + 窗口捕获 identity
  // 与当前身份一致 + pending.settle 与 windowSettle 一致）→ 准入
  assert.strictEqual(mod.canSettleAcpElicitation(base), true);
  // sender 非当前窗口 → 拒绝
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { senderIsCurrentWindow: false })), false);
  // owner 错配（ws 窗 / null）→ 拒绝
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { owner: 'ws' })), false);
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { owner: null })), false);
  // 窗口 QID 错误 → 拒绝
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { questionId: 'ws-q-1' })), false);
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { questionId: null })), false);
  // payload QID 为空 / 伪造 / 非 ACP / 旧 QID → 拒绝（即使窗口 QID 正确）
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { payloadQuestionId: '' })), false);
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { payloadQuestionId: null })), false);
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { payloadQuestionId: 'fake-q-1' })), false);
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { payloadQuestionId: 'ws-q-1' })), false);
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { payloadQuestionId: 'acp-elicitation-old' })), false);
  // payload QID 正确但窗口 QID 错误 → 拒绝
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { questionId: 'ws-q-1' })), false);
  // 窗口捕获 epoch 旧（不等于 identity.currentEpoch()）→ 拒绝（即使 settle 匹配）
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { windowEpoch: epochA - 1 })), false);
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { windowEpoch: epochA + 1 })), false);
  // 窗口捕获 settle 旧（不等于 identity.settle）→ 拒绝（即使 epoch 匹配）
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { windowSettle: settleB })), false);
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { windowSettle: null })), false);
  // identity 缺失 → 拒绝
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { identity: null })), false);
  // pending.settle 与 windowSettle 不一致（窗口 settle 正确但 pending 已是别的请求）→ 拒绝
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, {
    pending: { kind: 'elicitation', settle: settleB, params: {} },
  })), false);
  // pending 非 elicitation / 已清 → 拒绝
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { pending: { kind: 'permission', settle: settleA } })), false);
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { pending: null })), false);
  // sender 校验失败（窗口已销毁/非当前窗）时其余全对也不放行
  assert.strictEqual(mod.canSettleAcpElicitation(Object.assign({}, base, { senderIsCurrentWindow: false, owner: 'ws' })), false);
}

// ---------- 8. P1-A：旧窗 close() 同步触发 settle→pump 新 elicitation 后，
// 旧 load catch/destroy cleanup 继续执行，绝不误伤新请求身份（可执行行为测试） ----------
// 场景还原 main.js：win1 load 失败 → win.close() 同步触发 closed guard
// （settleWindowElicitationCancelled 以捕获的 settle1 收尾）→ settle1 内部同步
// pump 出 E2（begin 建立新身份）→ 随后旧 load catch 的 cleanup 再次执行。
// 修复前：旧 cleanup 调用读取全局当前身份的结算 → retire(pending2, settle2)
// 命中 → 误伤 E2。修复后：cleanup 以捕获的 settle1 二次 retire → 不匹配 → 幂等
// 安全，E2 身份/epoch/settle 完好且可完成。
function testWindowCleanupAfterSyncPump() {
  var id = new mod.ElicitationIdentity();
  var settled = [];
  var settle2 = null;
  // 模拟 main.js 的 settle：settled guard + 结算后同步 pump 下一个 elicitation
  var makeSettle = function (n) {
    var done = false;
    return function (o) {
      if (done) return;
      done = true;
      settled.push(o);
      if (n === 1) id.begin(settle2); // 同步 pump：E2 建立新身份
    };
  };
  var settle1 = makeSettle(1);
  settle2 = makeSettle(2);
  var epoch1 = id.begin(settle1);
  var pending1 = { kind: 'elicitation', settle: settle1, params: {} };
  assert.strictEqual(mod.isWindowInitCurrent('acp', epoch1, 99, id.currentEpoch()), true);

  // win1.close() 同步触发 closed guard（openAcpElicitationWindow 挂载的 guard 等效）
  assert.strictEqual(mod.settleWindowElicitationCancelled(id, pending1, settle1), true,
    'closed guard 命中捕获的 settle1 并结算');
  assert.strictEqual(id.settle, settle2, 'settle1 结算后同步 pump 出 E2（新身份已建立）');
  var epoch2 = id.currentEpoch();
  var pending2 = { kind: 'elicitation', settle: settle2, params: {} };

  // 旧 load catch cleanup 继续执行：仍以捕获的 settle1 收尾（若读全局当前
  // 身份会 retire 掉 E2 → 误伤）
  assert.strictEqual(mod.settleWindowElicitationCancelled(id, pending2, settle1), false,
    '旧 cleanup 不得二次结算（retire 只认捕获的 settle1，与 E2 不匹配）');
  assert.strictEqual(id.settle, settle2, '旧 cleanup 后新请求 settle 身份完好');
  assert.strictEqual(id.currentEpoch(), epoch2, '旧 cleanup 不得递增新请求 epoch');
  assert.strictEqual(mod.isWindowInitCurrent('acp', epoch2, 0, id.currentEpoch()), true,
    'E2 的 init 仍有效（未被旧 cleanup 取消）');
  assert.strictEqual(mod.shouldSettleElicitation(pending2, id.settle), true, 'E2 仍可结算');

  // E2 正常完成（submit/init/结算全链路未被旧 cleanup 破坏）
  var r = id.retire(pending2, id.settle);
  assert.strictEqual(r, settle2);
  r({ outcome: 'selected', optionId: 'opt-2' });
  assert.deepStrictEqual(settled, [
    { outcome: 'cancelled' },                    // E1：win1 close guard 收尾
    { outcome: 'selected', optionId: 'opt-2' },  // E2：正常完成
  ]);
}

// ---------- 9. P1-A：destroy cleanup 等效场景（did-finish-load 触发时窗口已销毁） ----------
// 用户已关窗 → guard 结算并 pump E2 → 旧窗 did-finish-load 才触发（win.isDestroyed
// 分支）→ 旧 cleanup 以捕获 settle1 收尾 → 幂等，E2 完好可完成。
function testDestroyCleanupAfterSyncPump() {
  var id = new mod.ElicitationIdentity();
  var settled = [];
  var settle2 = null;
  var makeSettle = function (n) {
    var done = false;
    return function (o) {
      if (done) return;
      done = true;
      settled.push(o);
      if (n === 1) id.begin(settle2); // 同步 pump：E2 建立新身份
    };
  };
  var settle1 = makeSettle(1);
  settle2 = makeSettle(2);
  id.begin(settle1);
  var pending1 = { kind: 'elicitation', settle: settle1, params: {} };
  // 用户关窗 → guard 结算 + pump E2
  assert.strictEqual(mod.settleWindowElicitationCancelled(id, pending1, settle1), true);
  var pending2 = { kind: 'elicitation', settle: settle2, params: {} };
  // 旧窗 did-finish-load（win.isDestroyed）cleanup 执行：只 retire 捕获的 settle1
  assert.strictEqual(mod.settleWindowElicitationCancelled(id, pending2, settle1), false,
    'destroy cleanup 不得结算新请求');
  assert.strictEqual(id.settle, settle2, 'destroy cleanup 后新请求身份完好');
  // E2 正常完成
  var r = id.retire(pending2, id.settle);
  assert.strictEqual(r, settle2);
  r({ outcome: 'cancelled' });
  assert.deepStrictEqual(settled, [{ outcome: 'cancelled' }, { outcome: 'cancelled' }]);
}

// ---------- 10. P1-A：窗口创建失败（closed guard 未挂）路径 ----------
// new BrowserWindow 抛异常时 guard 尚未挂载——cleanup 直接以捕获的自身 settle
// 收尾（命中并结算，settle 同步 pump E2 后不再触碰身份），E2 完好。
function testCreateFailCleanupSettlesOwn() {
  var id = new mod.ElicitationIdentity();
  var settled = [];
  var settle2 = null;
  var makeSettle = function (n) {
    var done = false;
    return function (o) {
      if (done) return;
      done = true;
      settled.push(o);
      if (n === 1) id.begin(settle2); // 同步 pump：E2 建立新身份
    };
  };
  var settle1 = makeSettle(1);
  settle2 = makeSettle(2);
  id.begin(settle1);
  var pending1 = { kind: 'elicitation', settle: settle1, params: {} };
  // 创建失败 cleanup：以捕获的 settle1 收尾（此时身份即本请求，命中）
  assert.strictEqual(mod.settleWindowElicitationCancelled(id, pending1, settle1), true,
    '创建失败时命中自身身份并结算取消');
  assert.deepStrictEqual(settled, [{ outcome: 'cancelled' }]);
  // 结算同步 pump 出 E2，cleanup 返回后不再触碰身份
  var epoch2 = id.currentEpoch();
  assert.strictEqual(id.settle, settle2, 'pump 出的 E2 身份已建立且未被误伤');
  var pending2 = { kind: 'elicitation', settle: settle2, params: {} };
  assert.strictEqual(mod.isWindowInitCurrent('acp', epoch2, 0, id.currentEpoch()), true,
    'E2 init 有效');
  // E2 可正常完成
  var r = id.retire(pending2, id.settle);
  assert.strictEqual(r, settle2);
  r({ outcome: 'selected', optionId: 'opt-2' });
  assert.deepStrictEqual(settled, [
    { outcome: 'cancelled' },
    { outcome: 'selected', optionId: 'opt-2' },
  ]);
}

// ---------- 11. P1-A：窗口级收尾对非 elicitation pending 恒不结算 ----------
function testWindowCleanupNonElicitationPending() {
  var id = new mod.ElicitationIdentity();
  var settle1 = function () {};
  id.begin(settle1);
  // pending 是普通 ACP permission（kind 不匹配）→ 不得结算
  var permPending = { kind: 'permission', settle: settle1, params: {} };
  assert.strictEqual(mod.settleWindowElicitationCancelled(id, permPending, settle1), false);
  assert.strictEqual(id.settle, settle1, '身份不动');
  // pending 已清空 → 不得结算
  assert.strictEqual(mod.settleWindowElicitationCancelled(id, null, settle1), false);
  assert.strictEqual(id.settle, settle1, '身份不动');
  // 捕获的 settle 与当前身份不匹配（旧窗 guard）→ 不得结算
  var settle2 = function () {};
  var pending2 = { kind: 'elicitation', settle: settle2, params: {} };
  assert.strictEqual(mod.settleWindowElicitationCancelled(id, pending2, settle1), false);
  assert.strictEqual(id.settle, settle1, '身份不动');
}

// ---------- 12. P1-C：当前 pending 已被 E2 替换后，E1 遗留窗口（QID 正确但
// epoch/settle 旧）准入拒绝，E2 保持可完成 ----------
// 场景还原：E1 窗口 submit 结算 → settle1 同步 pump 出 E2（新身份建立）→
// E1 窗口仍存活（延时关窗的 1500ms 内/替换间隙，sender 校验仍可能通过）且
// 窗口 QID 与 payload QID 均正确。修复前：准入用全局 identity.settle（=settle2）
// 与全局 pending（=E2）比对 → 命中 → E1 窗口结算了 E2 的 pending（E2 被误
// 取消）。修复后：准入要求窗口捕获的 windowEpoch/windowSettle 与当前请求身份
// 完全一致 → E1 的 epoch/settle 旧 → 拒绝 → E2 身份完好且可正常完成。
function testStaleWindowCannotSettleNewPending() {
  var id = new mod.ElicitationIdentity();
  var settled = [];
  var settle2 = null;
  // 模拟 main.js 的 settle：settled guard + 结算后同步 pump 下一个 elicitation
  var makeSettle = function (n) {
    var done = false;
    return function (o) {
      if (done) return;
      done = true;
      settled.push(o);
      if (n === 1) id.begin(settle2); // 同步 pump：E2 建立新身份
    };
  };
  var settle1 = makeSettle(1);
  settle2 = makeSettle(2);
  var epoch1 = id.begin(settle1);
  var pending1 = { kind: 'elicitation', settle: settle1, params: {} };

  // E1 窗口 submit：准入 → retire → settle1 → 同步 pump E2（身份已更换）
  var retired1 = id.retire(pending1, id.settle);
  assert.strictEqual(retired1, settle1);
  retired1({ outcome: 'selected', optionId: 'opt-1' });
  var epoch2 = id.currentEpoch();
  var pending2 = { kind: 'elicitation', settle: settle2, params: {} };
  assert.strictEqual(id.settle, settle2, 'E2 身份已建立（settle 已更换）');
  assert.notStrictEqual(epoch2, epoch1, 'E2 epoch 已更换');

  // E1 遗留窗口的 IPC 到达：sender 校验通过（仍被识别为当前窗的极端时序）、
  // QID 正确、owner='acp'，但窗口捕获的 epoch/settle 是旧的（epoch1/settle1），
  // 当前 pending 已是 E2
  var stale = {
    senderIsCurrentWindow: true,
    owner: 'acp',
    questionId: mod.ACP_ELICITATION_QID,
    payloadQuestionId: mod.ACP_ELICITATION_QID,
    pending: pending2,     // 当前 pending 已被 E2 替换
    windowEpoch: epoch1,   // E1 窗口捕获的旧 epoch
    windowSettle: settle1, // E1 窗口捕获的旧 settle
    identity: id,
  };
  assert.strictEqual(mod.canSettleAcpElicitation(stale), false,
    'E1 遗留窗口（epoch/settle 旧）准入必须拒绝');
  // E2 身份未被触碰
  assert.strictEqual(id.settle, settle2, 'E2 settle 身份完好');
  assert.strictEqual(id.currentEpoch(), epoch2, 'E2 epoch 未被递增');
  // E2 保持可完成：当前窗完整条件（窗口捕获 identity 与当前身份一致）必须通过
  var fresh = {
    senderIsCurrentWindow: true,
    owner: 'acp',
    questionId: mod.ACP_ELICITATION_QID,
    payloadQuestionId: mod.ACP_ELICITATION_QID,
    pending: pending2,
    windowEpoch: epoch2,
    windowSettle: settle2,
    identity: id,
  };
  assert.strictEqual(mod.canSettleAcpElicitation(fresh), true,
    '当前窗完整条件必须通过（windowEpoch/windowSettle 与当前身份一致）');
  var r2 = id.retire(pending2, id.settle);
  assert.strictEqual(r2, settle2);
  r2({ outcome: 'selected', optionId: 'opt-2' });
  assert.deepStrictEqual(settled, [
    { outcome: 'selected', optionId: 'opt-1' }, // E1：正常完成
    { outcome: 'selected', optionId: 'opt-2' }, // E2：未被 E1 遗留窗误结算
  ]);
}

var tests = [
  testBuildPayload,
  testShouldSettle,
  testIsWindowInitCurrent,
  testMainWiringStatic,
  testIdentitySyncReentry,
  testRetireOnlyExpectedSettle,
  testCanSettleAcpElicitation,
  testWindowCleanupAfterSyncPump,
  testDestroyCleanupAfterSyncPump,
  testCreateFailCleanupSettlesOwn,
  testWindowCleanupNonElicitationPending,
  testStaleWindowCannotSettleNewPending,
];

var failed = 0;
for (var i = 0; i < tests.length; i++) {
  try {
    tests[i]();
  } catch (e) {
    console.error('❌ ' + tests[i].name + ' 失败: ' + e.message);
    console.error('   ' + (e.stack || '').split('\n').slice(1).join('\n   '));
    failed++;
  }
}

if (failed === 0) {
  console.log('\n全部 acp-question-window 测试通过 (' + tests.length + '/' + tests.length + ')');
} else {
  console.log('\n' + failed + '/' + tests.length + ' 测试失败');
  process.exitCode = 1;
}
