// notification-nav 模块单元测试（M5 P1 通知会话导航安全）
// 用法：node test-notification-nav.js
'use strict';
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var mod = require('../src/main/notification-nav');

// ---------- 测试用校验器（与 session-workspace 口径一致：非空、≤128、[A-Za-z0-9_-]） ----------
function isValidSessionId(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && /^[A-Za-z0-9_-]+$/.test(s);
}
function parseSessionIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    var u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    var m = u.pathname.match(/^\/sessions\/([^/]+)\/?$/);
    if (!m) return null;
    var id;
    try { id = decodeURIComponent(m[1]); } catch { return null; }
    return isValidSessionId(id) ? id : null;
  } catch { return null; }
}

// 导航决策默认输入（全部有效的基线）
function navOpts(overrides) {
  var o = {
    sessionId: 'session_aaa_1',
    epoch: 5,
    base: 'http://127.0.0.1:3456',
    currentEpoch: 5,
    currentBase: 'http://127.0.0.1:3456',
    currentToken: 'tok-abc',
    currentUrl: 'http://127.0.0.1:3456/',
    isValidSessionId: isValidSessionId,
    parseSessionIdFromUrl: parseSessionIdFromUrl,
  };
  return Object.assign({}, o, overrides || {});
}

// ---------- 1. approvalNavSessionId：单来源 / 多层一致 ----------
function testApprovalSingle() {
  var id = mod.approvalNavSessionId({ session_id: 'session_aaa_1' }, isValidSessionId);
  assert.strictEqual(id, 'session_aaa_1');
  var id2 = mod.approvalNavSessionId({ sessionId: 'session_aaa_1' }, isValidSessionId);
  assert.strictEqual(id2, 'session_aaa_1');
  // payload 层
  var id3 = mod.approvalNavSessionId({ payload: { session_id: 'session_aaa_1' } }, isValidSessionId);
  assert.strictEqual(id3, 'session_aaa_1');
  // data 层
  var id4 = mod.approvalNavSessionId({ data: { sessionId: 'session_aaa_1' } }, isValidSessionId);
  assert.strictEqual(id4, 'session_aaa_1');
  // raw + payload + data 全部一致 → 可导航
  var id5 = mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    payload: { session_id: 'session_aaa_1' },
    data: { sessionId: 'session_aaa_1' },
  }, isValidSessionId);
  assert.strictEqual(id5, 'session_aaa_1');
  // 非对象 raw → null
  assert.strictEqual(mod.approvalNavSessionId(null, isValidSessionId), null);
  assert.strictEqual(mod.approvalNavSessionId('str', isValidSessionId), null);
}

// ---------- 2. approvalNavSessionId：冲突 / 非法 / 缺失 ----------
function testApprovalConflictIllegal() {
  // raw 与 payload 冲突 → 仅聚焦
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    payload: { session_id: 'session_bbb_2' },
  }, isValidSessionId), null);
  // 顶层两字段冲突
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    sessionId: 'session_ccc_3',
  }, isValidSessionId), null);
  // 非法非空值（路径穿越形态）→ 仅聚焦
  assert.strictEqual(mod.approvalNavSessionId({ session_id: '../etc' }, isValidSessionId), null);
  assert.strictEqual(mod.approvalNavSessionId({ session_id: 'session_aaa_1', payload: { session_id: 'a b' } }, isValidSessionId), null);
  // 超长
  assert.strictEqual(mod.approvalNavSessionId({ session_id: new Array(140).join('x') }, isValidSessionId), null);
  // 完全未提供（缺失要求来源）→ 仅聚焦
  assert.strictEqual(mod.approvalNavSessionId({ payload: { question_id: 'q1' } }, isValidSessionId), null);
  assert.strictEqual(mod.approvalNavSessionId({}, isValidSessionId), null);
  // 空字符串视为未提供
  assert.strictEqual(mod.approvalNavSessionId({ session_id: '' }, isValidSessionId), null);
}

// ---------- 3. completionNavSessionId：normalizer 合法且与所有 raw 一致 ----------
function testCompletionConsistent() {
  // normalizer 合法 + raw 一致 → 可导航
  var id = mod.completionNavSessionId(
    { session_id: 'session_aaa_1', payload: { sessionId: 'session_aaa_1' } },
    'session_aaa_1', isValidSessionId);
  assert.strictEqual(id, 'session_aaa_1');
  // raw 未提供 → normalizer 为准
  var id2 = mod.completionNavSessionId({ event: 'task.completed' }, 'session_aaa_1', isValidSessionId);
  assert.strictEqual(id2, 'session_aaa_1');
  // raw 多个来源一致 + normalizer 一致
  var id3 = mod.completionNavSessionId(
    { session_id: 'session_aaa_1', sessionId: 'session_aaa_1', data: { session_id: 'session_aaa_1' } },
    'session_aaa_1', isValidSessionId);
  assert.strictEqual(id3, 'session_aaa_1');
}

// ---------- 4. completionNavSessionId：normalizer/raw 不一致或非法 ----------
function testCompletionInconsistent() {
  // normalizer 与 raw 不一致 → 仅聚焦（同取首个字段不算验证）
  assert.strictEqual(mod.completionNavSessionId(
    { session_id: 'session_aaa_1' }, 'session_bbb_2', isValidSessionId), null);
  // raw 多层自相矛盾 → 仅聚焦
  assert.strictEqual(mod.completionNavSessionId(
    { session_id: 'session_aaa_1', payload: { session_id: 'session_bbb_2' } },
    'session_aaa_1', isValidSessionId), null);
  // raw 非法 → 仅聚焦
  assert.strictEqual(mod.completionNavSessionId(
    { session_id: 'session_aaa_1', payload: { session_id: '../x' } },
    'session_aaa_1', isValidSessionId), null);
  // normalizer 非法 → 仅聚焦（即使 raw 合法）
  assert.strictEqual(mod.completionNavSessionId(
    { session_id: 'session_aaa_1' }, '../x', isValidSessionId), null);
  // normalizer 缺失（normalizer 未识别该事件）→ 仅聚焦
  assert.strictEqual(mod.completionNavSessionId(
    { session_id: 'session_aaa_1' }, null, isValidSessionId), null);
  assert.strictEqual(mod.completionNavSessionId(
    { session_id: 'session_aaa_1' }, undefined, isValidSessionId), null);
  // normalizer 非法 + raw 未提供 → 仅聚焦
  assert.strictEqual(mod.completionNavSessionId({ event: 'task.completed' }, '', isValidSessionId), null);
}

// ---------- 5. decideNotificationNav：A→B→A epoch 失效（核心修复） ----------
function testNavABAEpoch() {
  // A 实例创建通知（epoch=5, base=A）→ 切 B（epoch=6, base=B）→ 切回 A（epoch=7, base=A）
  // 创建时捕获的 epoch/base 必须与当前一致——epoch 已变 → 仅聚焦，不得恢复导航资格
  var d = mod.decideNotificationNav(navOpts({ epoch: 5, currentEpoch: 7 }));
  assert.strictEqual(d.navigate, false);
  assert.strictEqual(d.reason, 'stale-epoch');
  assert.strictEqual(d.targetUrl, null);
  // 同 epoch 同 base（未发生任何切换）→ 可导航
  var d2 = mod.decideNotificationNav(navOpts({}));
  assert.strictEqual(d2.navigate, true);
  // base 不同（即便 epoch 相同——创建时 base 与当前 base 不一致）→ 仅聚焦
  var d3 = mod.decideNotificationNav(navOpts({ base: 'http://127.0.0.1:9999' }));
  assert.strictEqual(d3.navigate, false);
  assert.strictEqual(d3.reason, 'stale-epoch');
}

// ---------- 6. decideNotificationNav：无 token / 无 base ----------
function testNavNoToken() {
  var d = mod.decideNotificationNav(navOpts({ currentToken: '' }));
  assert.strictEqual(d.navigate, false);
  assert.strictEqual(d.reason, 'no-token');
  var d2 = mod.decideNotificationNav(navOpts({ currentToken: null }));
  assert.strictEqual(d2.navigate, false);
  // 创建时无服务（base 为 null）且当前仍无服务 → 仅聚焦
  var d3 = mod.decideNotificationNav(navOpts({ base: null, currentBase: null, currentToken: null }));
  assert.strictEqual(d3.navigate, false);
  // 有 token 但无 base → 仅聚焦
  var d4 = mod.decideNotificationNav(navOpts({ base: null, currentBase: null }));
  assert.strictEqual(d4.navigate, false);
  assert.strictEqual(d4.reason, 'no-base');
}

// ---------- 7. decideNotificationNav：非法 ID / 已在目标会话 / URL 构造 ----------
function testNavIllegalAndTarget() {
  // 非法 sessionId → 仅聚焦
  var d = mod.decideNotificationNav(navOpts({ sessionId: '../x' }));
  assert.strictEqual(d.navigate, false);
  assert.strictEqual(d.reason, 'invalid-session-id');
  var d2 = mod.decideNotificationNav(navOpts({ sessionId: null }));
  assert.strictEqual(d2.navigate, false);
  // 已在目标会话（当前 URL 即 /sessions/<id>）→ 不重载
  var d3 = mod.decideNotificationNav(navOpts({ currentUrl: 'http://127.0.0.1:3456/sessions/session_aaa_1' }));
  assert.strictEqual(d3.navigate, false);
  assert.strictEqual(d3.reason, 'already-there');
  // 当前 URL 带查询/hash 也识别
  var d4 = mod.decideNotificationNav(navOpts({
    currentUrl: 'http://127.0.0.1:3456/sessions/session_aaa_1?x=1#token=abc',
  }));
  assert.strictEqual(d4.navigate, false);
  // 正常导航：URL 只能由当前可信 base/token 构造（绝不使用创建时捕获值）
  var d5 = mod.decideNotificationNav(navOpts({ currentUrl: 'http://127.0.0.1:3456/other' }));
  assert.strictEqual(d5.navigate, true);
  assert.strictEqual(d5.reason, 'navigate');
  assert.strictEqual(d5.targetUrl, 'http://127.0.0.1:3456/sessions/session_aaa_1#token=tok-abc');
  // 特殊字符 sessionId 正确 encodeURIComponent
  var d6 = mod.decideNotificationNav(navOpts({ sessionId: 'session_aaa_1', currentUrl: '' }));
  assert.ok(d6.navigate);
  assert.strictEqual(d6.targetUrl.indexOf('session_aaa_1'), d6.targetUrl.indexOf('/sessions/') + 10);
}

// ---------- 8. 静态回归：WS question 永不返回导航资格（main.js 接线） ----------
function testQuestionNeverNavigates() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  // 截取 handleQuestionRequested 函数体
  var start = src.indexOf('function handleQuestionRequested');
  var end = src.indexOf('function bumpPendingQuestions');
  assert.ok(start >= 0 && end > start, 'main.js 应包含 handleQuestionRequested');
  var body = src.slice(start, end);
  // 函数体内任何 showDesktopNotification 调用都不得携带 sessionId 变量
  var re = /showDesktopNotification\([^)]*sessionId/g;
  var m = body.match(re);
  assert.strictEqual(m, null, 'WS question 通知不得携带 sessionId（' + (m ? m.join(', ') : '') + '）');
}

// ---------- 9. 静态回归：通知点击导航走 notificationNav 决策 + navEpoch ----------
function testNavWiringStatic() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  // 通知创建捕获 navEpoch（非 serverGeneration）
  assert.ok(/const notifEpoch = navEpoch;/.test(src), 'showDesktopNotification 应捕获 navEpoch');
  assert.ok(!/const notifGen = serverGeneration;/.test(src), '不得再用 serverGeneration 作通知世代');
  // 导航决策函数存在
  assert.ok(src.indexOf('notificationNav.decideNotificationNav') >= 0, '应使用 decideNotificationNav');
  // 失效点递增 navEpoch
  var inc = (src.match(/navEpoch\+\+;/g) || []).length;
  assert.ok(inc >= 5, 'navEpoch 递增点应覆盖实例切换/服务停止/服务启动/进程退出/token 轮换（实际 ' + inc + ' 处）');
}

// ---------- 10. P1-3：字段存在但非法（空串/null/数字/对象/布尔）→ 取消资格 ----------
function testPresentButInvalid() {
  // 空串
  assert.strictEqual(mod.approvalNavSessionId({ session_id: '' }, isValidSessionId), null);
  assert.strictEqual(mod.approvalNavSessionId({ payload: { session_id: '' } }, isValidSessionId), null);
  // null（字段存在但值非法——区分于字段缺失）
  assert.strictEqual(mod.approvalNavSessionId({ session_id: null }, isValidSessionId), null);
  // 数字 / 对象 / 布尔
  assert.strictEqual(mod.approvalNavSessionId({ session_id: 123 }, isValidSessionId), null);
  assert.strictEqual(mod.approvalNavSessionId({ session_id: {} }, isValidSessionId), null);
  assert.strictEqual(mod.approvalNavSessionId({ sessionId: true }, isValidSessionId), null);
  // 合法顶层 + payload 存在非法值 → 整体取消资格（任一来源非法即取消）
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    payload: { sessionId: 5 },
  }, isValidSessionId), null);
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    data: { session_id: '' },
  }, isValidSessionId), null);
  // completion 同样：normalizer 合法 + raw 存在非法值 → null
  assert.strictEqual(mod.completionNavSessionId({ session_id: 123 }, 'session_aaa_1', isValidSessionId), null);
  assert.strictEqual(mod.completionNavSessionId({ session_id: null }, 'session_aaa_1', isValidSessionId), null);
  assert.strictEqual(mod.completionNavSessionId({ session_id: '' }, 'session_aaa_1', isValidSessionId), null);
  assert.strictEqual(mod.completionNavSessionId({
    session_id: 'session_aaa_1',
    payload: { session_id: null },
  }, 'session_aaa_1', isValidSessionId), null);
}

// ---------- 11. P1-3：payload/data 的 info 层冲突 / 非法 → 取消资格 ----------
function testInfoLayerConflict() {
  // payload.info 与顶层冲突 → 取消
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    payload: { info: { session_id: 'session_bbb_2' } },
  }, isValidSessionId), null);
  // data.info 与顶层冲突 → 取消
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    data: { info: { sessionId: 'session_ccc_3' } },
  }, isValidSessionId), null);
  // payload.info 与 payload 层冲突 → 取消
  assert.strictEqual(mod.approvalNavSessionId({
    payload: { session_id: 'session_aaa_1', info: { session_id: 'session_ddd_4' } },
  }, isValidSessionId), null);
  // payload.info 存在非法值 → 取消
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    payload: { info: { session_id: '../x' } },
  }, isValidSessionId), null);
  // completion：normalizer 合法 + info 层冲突 → null
  assert.strictEqual(mod.completionNavSessionId({
    session_id: 'session_aaa_1',
    payload: { info: { sessionId: 'session_bbb_2' } },
  }, 'session_aaa_1', isValidSessionId), null);
  // info 层数字值 → 取消
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    payload: { info: { session_id: 42 } },
  }, isValidSessionId), null);
  // info 非对象（存在但非容器）→ 不构成来源，不取消（与 normalizer pick 路径一致）
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    payload: { info: 'not-an-object' },
  }, isValidSessionId), 'session_aaa_1');
  assert.strictEqual(mod.approvalNavSessionId({
    session_id: 'session_aaa_1',
    data: { info: 7 },
  }, isValidSessionId), 'session_aaa_1');
}

// ---------- 12. P1-3：所有来源同值（含 info 层）→ 可导航 ----------
function testAllSourcesSame() {
  var raw = {
    session_id: 'session_aaa_1',
    sessionId: 'session_aaa_1',
    payload: {
      session_id: 'session_aaa_1',
      sessionId: 'session_aaa_1',
      info: { session_id: 'session_aaa_1', sessionId: 'session_aaa_1' },
    },
    data: {
      session_id: 'session_aaa_1',
      sessionId: 'session_aaa_1',
      info: { session_id: 'session_aaa_1', sessionId: 'session_aaa_1' },
    },
  };
  assert.strictEqual(mod.approvalNavSessionId(raw, isValidSessionId), 'session_aaa_1');
  assert.strictEqual(mod.completionNavSessionId(raw, 'session_aaa_1', isValidSessionId), 'session_aaa_1');
  // 仅 info 层提供且合法 → 可导航（normalizer 的 info 兜底路径）
  assert.strictEqual(mod.approvalNavSessionId({ payload: { info: { sessionId: 'session_aaa_1' } } }, isValidSessionId), 'session_aaa_1');
  assert.strictEqual(mod.approvalNavSessionId({ data: { info: { session_id: 'session_aaa_1' } } }, isValidSessionId), 'session_aaa_1');
  // 仅 data.info 提供 + normalizer 一致 → completion 可导航
  assert.strictEqual(mod.completionNavSessionId({ data: { info: { sessionId: 'session_aaa_1' } } }, 'session_aaa_1', isValidSessionId), 'session_aaa_1');
}

// ---------- 13. P1-3：字段缺失（undefined）不取消资格 ----------
function testMissingFieldsOk() {
  // 顶层无 sessionId 字段，payload 提供合法 → 可导航
  assert.strictEqual(mod.approvalNavSessionId({ payload: { sessionId: 'session_aaa_1' } }, isValidSessionId), 'session_aaa_1');
  // 无 info 键 → 不取消
  assert.strictEqual(mod.approvalNavSessionId({ payload: { session_id: 'session_aaa_1' } }, isValidSessionId), 'session_aaa_1');
  // data 层无 sessionId 但 payload 有 → 可导航
  assert.strictEqual(mod.approvalNavSessionId({
    payload: { session_id: 'session_aaa_1' },
    data: { question_id: 'q1' },
  }, isValidSessionId), 'session_aaa_1');
  // payload 缺失（undefined）而 raw 顶层提供 → 可导航
  assert.strictEqual(mod.approvalNavSessionId({ session_id: 'session_aaa_1' }, isValidSessionId), 'session_aaa_1');
  // completion：raw 全缺失 → 以 normalizer 为准
  assert.strictEqual(mod.completionNavSessionId({ event: 'task.completed' }, 'session_aaa_1', isValidSessionId), 'session_aaa_1');
}

var tests = [
  testApprovalSingle,
  testApprovalConflictIllegal,
  testCompletionConsistent,
  testCompletionInconsistent,
  testNavABAEpoch,
  testNavNoToken,
  testNavIllegalAndTarget,
  testQuestionNeverNavigates,
  testNavWiringStatic,
  testPresentButInvalid,
  testInfoLayerConflict,
  testAllSourcesSame,
  testMissingFieldsOk,
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
  console.log('\n全部 notification-nav 测试通过 (' + tests.length + '/' + tests.length + ')');
} else {
  console.log('\n' + failed + '/' + tests.length + ' 测试失败');
  process.exitCode = 1;
}
