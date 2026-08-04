// overlay-context-sync 模块单元测试（P1-2 overlay 期间 context 待同步契约）
// 契约：overlay 覆盖期间 context 事件记入待同步标志（多次 context 合并为一次）；
// 非 context 事件不积压；overlay 关闭、Workspace view 重挂后恰好补发一次 context，
// 随后复位；collapsed（未重挂）不补发但复位（绝不残留、绝不重复补发）。
// 用法：node test-overlay-context-sync.js
'use strict';
var assert = require('assert');
var mod = require('../src/main/overlay-context-sync');

// ---------- 1. 期间合并一次：多次 context → 恒置位 ----------
function testMergeWhileOverlay() {
  var pending = false;
  pending = mod.noteContextWhileOverlay(pending, { kind: 'context' });
  assert.strictEqual(pending, true);
  // 再次 context（导航/重查命中多次）→ 仍一次（幂等合并）
  pending = mod.noteContextWhileOverlay(pending, { kind: 'context' });
  assert.strictEqual(pending, true);
  pending = mod.noteContextWhileOverlay(pending, { kind: 'context', sessionId: 'session_aaa_1' });
  assert.strictEqual(pending, true);
}

// ---------- 2. 非 context 事件不积压 ----------
function testNonContextNotStashed() {
  var pending = false;
  pending = mod.noteContextWhileOverlay(pending, { kind: 'activities', sessionId: 'session_aaa_1' });
  assert.strictEqual(pending, false, 'activities 不置位');
  pending = mod.noteContextWhileOverlay(pending, { kind: 'refresh' });
  assert.strictEqual(pending, false, 'refresh 不置位');
  pending = mod.noteContextWhileOverlay(pending, {});
  assert.strictEqual(pending, false);
  pending = mod.noteContextWhileOverlay(pending, null);
  assert.strictEqual(pending, false);
  // context 置位后，非 context 不改变标志（不合并也不清除）
  pending = mod.noteContextWhileOverlay(pending, { kind: 'context' });
  assert.strictEqual(pending, true);
  pending = mod.noteContextWhileOverlay(pending, { kind: 'activities' });
  assert.strictEqual(pending, true, '已置位后非 context 不得清除');
  // 空 payload 也不清除
  pending = mod.noteContextWhileOverlay(pending, null);
  assert.strictEqual(pending, true);
}

// ---------- 3. 恢复补一次：重挂后恰好补发一次并复位 ----------
function testDrainOnceAfterRemount() {
  // pending 置位 → 重挂 → 补发一次 + 复位
  var d = mod.drainContextAfterOverlay(true, true);
  assert.strictEqual(d.send, true);
  assert.strictEqual(d.pending, false);
  // 再次 drain → 不再补发（恰好一次）
  var d2 = mod.drainContextAfterOverlay(d.pending, true);
  assert.strictEqual(d2.send, false);
  assert.strictEqual(d2.pending, false);
  // 无 pending → 不补发
  var d3 = mod.drainContextAfterOverlay(false, true);
  assert.strictEqual(d3.send, false);
  assert.strictEqual(d3.pending, false);
}

// ---------- 4. collapsed（未重挂）：不补发但复位（不残留、不重复） ----------
function testDrainCollapsed() {
  var d = mod.drainContextAfterOverlay(true, false);
  assert.strictEqual(d.send, false, 'collapsed 不补发');
  assert.strictEqual(d.pending, false, 'collapsed 也复位标志（页面下次加载自行同步）');
  var d2 = mod.drainContextAfterOverlay(false, false);
  assert.strictEqual(d2.send, false);
  assert.strictEqual(d2.pending, false);
}

// ---------- 5. 端到端模拟：overlay 打开 → 事件 → 关闭 → 重挂 ----------
function testFullFlow() {
  var pending = false;
  // overlay 打开期间：context ×2 + activities
  pending = mod.noteContextWhileOverlay(pending, { kind: 'context' });
  pending = mod.noteContextWhileOverlay(pending, { kind: 'activities', sessionId: 's' });
  pending = mod.noteContextWhileOverlay(pending, { kind: 'context' });
  assert.strictEqual(pending, true);
  // 关闭 + 重挂 → 补发一次并复位
  var d = mod.drainContextAfterOverlay(pending, true);
  assert.strictEqual(d.send, true);
  assert.strictEqual(d.pending, false);
  // 后续正常推送（非 overlay 期间）不受影响
  assert.strictEqual(d.pending, false);
  // 无 overlay 期间积压、无 context → 关闭不补发
  var d2 = mod.drainContextAfterOverlay(false, true);
  assert.strictEqual(d2.send, false);
}

// ---------- 6. 静态回归：main.js 接线（行为契约由上方纯函数测试覆盖） ----------
function testMainWiringStatic() {
  var fs = require('fs');
  var path = require('path');
  var src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  // pushWorkspaceEvent 的 overlay 分支必须经 noteContextWhileOverlay 记录
  assert.ok(src.indexOf('overlayContextSync.noteContextWhileOverlay(') >= 0,
    'pushWorkspaceEvent 必须在 overlay 分支记录 context 待同步');
  // closeOverlay 必须经 drainContextAfterOverlay 取积压标志
  assert.ok(src.indexOf('overlayContextSync.drainContextAfterOverlay(') >= 0,
    'closeOverlay 必须 drain context 待同步');
  var closeStart = src.indexOf('function closeOverlay');
  var closeEnd = src.indexOf('function foregroundContents');
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  var body = src.slice(closeStart, closeEnd);
  // M6：stale 时绝不先把保有旧 DOM 的 view 挂回——closeOverlay 函数体内
  // 不得直接 addChildView，stale 分支必须走 workspaceRestorer.begin（隐藏态
  // 安全重置 + renderer ack + 单次挂回），无积压分支走 mountWorkspaceViewOnce
  assert.ok(body.indexOf('addChildView') === -1,
    'closeOverlay 体内不得直接 addChildView（M6：stale 时挂回必须经 workspaceRestorer）');
  assert.ok(body.indexOf('workspaceRestorer.begin(') >= 0,
    'closeOverlay stale 分支必须走 workspaceRestorer.begin 安全恢复');
  assert.ok(body.indexOf('mountWorkspaceViewOnce(') >= 0,
    'closeOverlay 无积压分支必须走 mountWorkspaceViewOnce 快速恢复');
  // M6：不再"挂回后补发 context"（那一帧旧 DOM 暴露正是本修复消除的对象）
  assert.ok(body.indexOf("pushWorkspaceEvent({ kind: 'context' })") === -1,
    'closeOverlay 不得再先挂回再补发 context（M6 安全恢复取代）');
}

var tests = [
  testMergeWhileOverlay,
  testNonContextNotStashed,
  testDrainOnceAfterRemount,
  testDrainCollapsed,
  testFullFlow,
  testMainWiringStatic,
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
  console.log('\n全部 overlay-context-sync 测试通过 (' + tests.length + '/' + tests.length + ')');
} else {
  console.log('\n' + failed + '/' + tests.length + ' 测试失败');
  process.exitCode = 1;
}
