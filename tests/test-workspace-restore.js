// workspace-restore 模块单元测试（M6 overlay 关闭安全恢复契约）
// 契约：overlay 关闭且 context 已合并（stale）时，保有旧 DOM 的 Workspace view
// 绝不直接挂回——隐藏态发 {kind:'context', restoreId} → 页面清 DOM + 新 context
// 定型回执 → ack 匹配才单次挂回；ack 超时受控 reload 后再等 ack；load 失败
// fail-closed 不挂回；reload 后 ack 仍超时兜底挂回（旧 DOM 已销毁）；
// 取消（再次 overlay/折叠/销毁/窗口销毁/视图替换）后迟到 ack/超时绝不重挂。
// 用法：node test-workspace-restore.js
'use strict';
var assert = require('assert');
var mod = require('../src/main/workspace-restore');

/* ---------- 测试 harness：注入假 deps（send/reload/mount/timer 全部可控） ---------- */
function makeHarness(opts) {
  opts = opts || {};
  var calls = { send: [], reload: [], mount: [], log: [] };
  var timers = []; // { fn, ms, cleared }
  var usable = opts.usable !== false; // isViewUsable 返回值（默认可用）
  var reloadDeferreds = [];
  var restorer = mod.createWorkspaceRestore({
    sendContext: function (view, id) {
      calls.send.push({ view: view, id: id });
      if (opts.sendThrows) throw new Error('send fail');
    },
    reload: function (view) {
      calls.reload.push(view);
      var d = deferred();
      reloadDeferreds.push(d);
      return d.promise;
    },
    mount: function (view) { calls.mount.push(view); },
    isViewUsable: function () { return usable; },
    ackTimeoutMs: 3000,
    reloadAckTimeoutMs: 5000,
    setTimeout: function (fn, ms) { var t = { fn: fn, ms: ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: function (t) { if (t) t.cleared = true; },
    log: function (m) { calls.log.push(m); },
  });
  return {
    restorer: restorer,
    calls: calls,
    timers: timers,
    reloadDeferreds: reloadDeferreds,
    setUsable: function (v) { usable = v; },
  };
}
function deferred() {
  var res, rej;
  var p = new Promise(function (r, j) { res = r; rej = j; });
  return { promise: p, resolve: res, reject: rej };
}
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

// ---------- 1. stale → 不挂旧 DOM → ack → 单次重挂（核心路径） ----------
function testStaleAckMountOnce() {
  var h = makeHarness();
  var view = { name: 'v1' };
  h.restorer.begin(view);
  // 关键安全断言：ack 之前 view 绝未被挂回（旧 DOM 不得暴露一帧）
  assert.strictEqual(h.calls.mount.length, 0, 'ack 前不得挂回');
  assert.strictEqual(h.calls.send.length, 1, '隐藏态发一次带 restoreId 的 context');
  assert.strictEqual(h.calls.send[0].view, view);
  assert.strictEqual(h.calls.send[0].id, 1);
  assert.strictEqual(h.calls.reload.length, 0, 'ack 及时到达不得 reload');
  assert.strictEqual(h.timers.length, 1, 'ack 超时看守已设');
  assert.strictEqual(h.timers[0].ms, 3000);
  var ok = h.restorer.handleAck(view, 1);
  assert.strictEqual(ok, true, '匹配 ack 被接受');
  assert.strictEqual(h.calls.mount.length, 1, 'ack 后挂回恰好一次');
  assert.strictEqual(h.calls.mount[0], view);
  assert.strictEqual(h.timers[0].cleared, true, '挂回后超时看守已清');
  assert.strictEqual(h.restorer.isPending(), false);
  // 重复 ack（防御）不再挂回
  assert.strictEqual(h.restorer.handleAck(view, 1), false);
  assert.strictEqual(h.calls.mount.length, 1, '重复 ack 不得再次挂回');
}

// ---------- 2. 错 id / 错 view 的 ack 一律忽略 ----------
function testWrongAckIgnored() {
  var h = makeHarness();
  var view = { name: 'v1' };
  var other = { name: 'v2' };
  h.restorer.begin(view);
  assert.strictEqual(h.restorer.handleAck(view, 999), false, '错 id 拒绝');
  assert.strictEqual(h.restorer.handleAck(other, 1), false, '错 view 拒绝');
  assert.strictEqual(h.restorer.handleAck(null, 1), false);
  assert.strictEqual(h.calls.mount.length, 0, '错误 ack 不得挂回');
  assert.strictEqual(h.restorer.isPending(), true, '正确恢复仍在等待');
  assert.strictEqual(h.restorer.handleAck(view, 1), true, '正确 ack 仍可完成');
  assert.strictEqual(h.calls.mount.length, 1);
}

// ---------- 3. ack 超时 → 受控 reload → 再通知 → ack → 单次挂回 ----------
function testAckTimeoutReloadThenAck() {
  var h = makeHarness();
  var view = { name: 'v1' };
  h.restorer.begin(view);
  h.timers[0].fn(); // ack 超时
  assert.strictEqual(h.calls.mount.length, 0, '超时未挂回（reload 未完成，旧 DOM 可能仍在）');
  assert.strictEqual(h.calls.reload.length, 1, '超时后受控 reload');
  assert.strictEqual(h.calls.reload[0], view);
  // reload 进行中：旧 id 的迟到 ack 必须拒绝（旧 DOM 销毁未完成）
  assert.strictEqual(h.restorer.handleAck(view, 1), false, 'reloading 阶段 ack 拒绝');
  assert.strictEqual(h.calls.mount.length, 0);
  h.reloadDeferreds[0].resolve();
  return tick().then(function () {
    assert.strictEqual(h.calls.send.length, 2, 'reload 完成后再次通知（同一 restoreId）');
    assert.strictEqual(h.calls.send[1].id, 1);
    assert.strictEqual(h.timers.length, 2, '二级 ack 看守已设');
    assert.strictEqual(h.timers[1].ms, 5000);
    assert.strictEqual(h.restorer.handleAck(view, 1), true, 'reload 后 ack 接受');
    assert.strictEqual(h.calls.mount.length, 1, '单次挂回');
    assert.strictEqual(h.restorer.isPending(), false);
  });
}

// ---------- 4. reload 失败 → fail-closed：绝不挂回（旧 DOM 可能仍在） ----------
function testReloadFailClosed() {
  var h = makeHarness();
  var view = { name: 'v1' };
  h.restorer.begin(view);
  h.timers[0].fn();
  assert.strictEqual(h.calls.reload.length, 1);
  h.reloadDeferreds[0].reject(new Error('load failed'));
  return tick().then(function () {
    assert.strictEqual(h.calls.mount.length, 0, 'load 失败绝不挂回');
    assert.strictEqual(h.restorer.isPending(), false, '恢复已取消');
    assert.strictEqual(h.restorer.handleAck(view, 1), false, '取消后 ack 无效');
    assert.strictEqual(h.calls.mount.length, 0);
  });
}

// ---------- 5. reload 后 ack 仍超时 → 兜底挂回（旧 DOM 已随 reload 销毁） ----------
function testReloadAckTimeoutFallbackMount() {
  var h = makeHarness();
  var view = { name: 'v1' };
  h.restorer.begin(view);
  h.timers[0].fn(); // 一级超时 → reload
  h.reloadDeferreds[0].resolve();
  return tick().then(function () {
    assert.strictEqual(h.calls.send.length, 2);
    h.timers[1].fn(); // 二级超时
    assert.strictEqual(h.calls.mount.length, 1, 'reload 已完成，兜底挂回安全');
    assert.strictEqual(h.calls.mount[0], view);
    assert.strictEqual(h.restorer.isPending(), false);
  });
}

// ---------- 6. 取消（折叠/销毁/再次 overlay）后：ack 与超时回调全部失效 ----------
function testCancelInvalidatesEverything() {
  var h = makeHarness();
  var view = { name: 'v1' };
  h.restorer.begin(view);
  h.restorer.cancel('面板隐藏');
  assert.strictEqual(h.restorer.isPending(), false);
  assert.strictEqual(h.timers[0].cleared, true, '取消即清超时看守');
  assert.strictEqual(h.restorer.handleAck(view, 1), false, '取消后 ack 拒绝');
  // 极端：超时回调即便被触发（真实环境 clearTimeout 后不会），内部 stage 校验兜底
  h.timers[0].fn();
  assert.strictEqual(h.calls.reload.length, 0, '取消后超时回调不得触发 reload');
  assert.strictEqual(h.calls.mount.length, 0);
  h.restorer.cancel(); // 幂等：重复取消不报错
}

// ---------- 7. begin 覆盖旧恢复（快速连续开关 overlay） ----------
function testBeginSupersedesPrevious() {
  var h = makeHarness();
  var v1 = { name: 'v1' };
  var v2 = { name: 'v2' };
  h.restorer.begin(v1);
  h.restorer.begin(v2);
  assert.strictEqual(h.timers[0].cleared, true, '旧恢复看守已清');
  assert.strictEqual(h.calls.send.length, 2);
  assert.strictEqual(h.calls.send[1].id, 2, '新恢复用新 id');
  assert.strictEqual(h.restorer.handleAck(v1, 1), false, '旧 view/旧 id 的 ack 拒绝');
  assert.strictEqual(h.calls.mount.length, 0);
  assert.strictEqual(h.restorer.handleAck(v2, 2), true, '新恢复 ack 接受');
  assert.strictEqual(h.calls.mount.length, 1);
  assert.strictEqual(h.calls.mount[0], v2, '挂回的是新 view');
}

// ---------- 8. 视图已失效（destroyed/被替换）时 begin → fail-closed ----------
function testBeginUnusableView() {
  var h = makeHarness({ usable: false });
  var view = { name: 'dead' };
  h.restorer.begin(view);
  assert.strictEqual(h.restorer.isPending(), false, '失效视图不留 pending');
  assert.strictEqual(h.calls.send.length, 0, '不向失效视图发事件');
  assert.strictEqual(h.calls.reload.length, 0, '失效视图不 reload');
  assert.strictEqual(h.calls.mount.length, 0, '失效视图不挂回');
}

// ---------- 9. 首次通知即抛错 → 受控 reload 再给一次机会 ----------
function testSendThrowsFallsToReload() {
  var h = makeHarness({ sendThrows: true });
  var view = { name: 'v1' };
  h.restorer.begin(view);
  assert.strictEqual(h.calls.reload.length, 1, 'send 失败进入受控 reload');
  assert.strictEqual(h.calls.mount.length, 0);
  h.reloadDeferreds[0].resolve();
  return tick().then(function () {
    // reload 后 send 仍抛（harness 恒定抛）→ 不致命，等二级超时兜底挂回
    assert.strictEqual(h.calls.send.length, 2);
    assert.strictEqual(h.calls.mount.length, 0, '二级超时前不挂回');
    h.timers[h.timers.length - 1].fn();
    assert.strictEqual(h.calls.mount.length, 1, 'reload 已完成，超时兜底挂回');
  });
}

// ---------- 10. reload 后视图失效 → 取消，不挂回 ----------
function testReloadThenViewDead() {
  var h = makeHarness();
  var view = { name: 'v1' };
  h.restorer.begin(view);
  h.timers[0].fn();
  h.setUsable(false); // reload 期间视图被替换/销毁
  h.reloadDeferreds[0].resolve();
  return tick().then(function () {
    assert.strictEqual(h.calls.mount.length, 0, '视图失效不挂回');
    assert.strictEqual(h.restorer.isPending(), false);
    assert.strictEqual(h.calls.send.length, 1, '失效后不再通知');
  });
}

// ---------- 11. 静态接线：main.js / preload / workspace.js / guard ----------
function testStaticWiring() {
  var fs = require('fs');
  var path = require('path');
  var root = path.join(__dirname, '..');
  var main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');
  var preload = fs.readFileSync(path.join(root, 'src', 'preload', 'workspace-preload.js'), 'utf8');
  var page = fs.readFileSync(path.join(root, 'src', 'pages', 'workspace.js'), 'utf8');
  var guard = fs.readFileSync(path.join(root, 'src', 'main', 'workspace-ipc-guard.js'), 'utf8');

  assert.ok(main.indexOf("require('./workspace-restore')") >= 0, 'main.js 必须引入 workspace-restore');
  assert.ok(main.indexOf('workspaceRestore.createWorkspaceRestore(') >= 0, 'main.js 必须创建恢复实例');
  // 取消挂点：再次 overlay / 折叠销毁 / 主窗销毁 三处都必须取消在途恢复
  assert.ok(main.indexOf("workspaceRestorer.cancel('overlay 再次打开')") >= 0, 'showOverlay 必须取消在途恢复');
  assert.ok(main.indexOf("workspaceRestorer.cancel('面板隐藏')") >= 0, 'hideWorkspacePanel 必须取消在途恢复');
  assert.ok(main.indexOf('workspaceRestorer.cancel(); // M6：窗口销毁') >= 0, '主窗 closed 必须取消在途恢复');
  // 恢复 pending 期间不向暂隐 view 推常规事件
  assert.ok(main.indexOf('workspaceRestorer.isPending()') >= 0, 'pushWorkspaceEvent 必须拦截恢复 pending 期推送');
  // showWorkspacePanel 的直接挂载必须受 isPending 把守（loadMain 紧跟 closeOverlay
  // 的场景：stale 恢复在途时不得抢先挂回旧 DOM view）
  var showStart = main.indexOf('function showWorkspacePanel()');
  var showEnd = main.indexOf('function hideWorkspacePanel');
  assert.ok(showStart >= 0 && showEnd > showStart);
  var showBody = main.slice(showStart, showEnd);
  var addIdx = showBody.indexOf('addChildView(workspaceView)');
  var guardIdx = showBody.indexOf('!workspaceRestorer.isPending()');
  assert.ok(addIdx >= 0 && guardIdx >= 0 && guardIdx < addIdx,
    'showWorkspacePanel 直接挂载必须先经 isPending 把守');
  // ack IPC 通道存在且经 guard 校验
  assert.ok(main.indexOf("ipcMain.on('workspace:contextRestored'") >= 0, 'main.js 必须有 contextRestored 回执通道');
  assert.ok(main.indexOf('workspaceGuard.validateContextRestored(') >= 0, '回执必须经 guard 白名单校验');
  // preload 暴露回执桥
  assert.ok(preload.indexOf('ackContextRestore') >= 0 && preload.indexOf("ipcRenderer.send('workspace:contextRestored'") >= 0,
    'preload 必须暴露 ackContextRestore → workspace:contextRestored');
  // 页面：context 事件带 restoreId 时定型后回执；普通 context 不回执
  assert.ok(page.indexOf('ackContextRestore') >= 0, 'workspace.js 必须有回执逻辑');
  assert.ok(page.indexOf('p.restoreId') >= 0, 'workspace.js 必须识别事件 restoreId');
  assert.ok(guard.indexOf('validateContextRestored') >= 0, 'guard 必须导出 validateContextRestored');
}

var tests = [
  testStaleAckMountOnce,
  testWrongAckIgnored,
  testAckTimeoutReloadThenAck,
  testReloadFailClosed,
  testReloadAckTimeoutFallbackMount,
  testCancelInvalidatesEverything,
  testBeginSupersedesPrevious,
  testBeginUnusableView,
  testSendThrowsFallsToReload,
  testReloadThenViewDead,
  testStaticWiring,
];

var failed = 0;
var chain = Promise.resolve();
tests.forEach(function (t) {
  chain = chain.then(function () {
    return Promise.resolve().then(t).catch(function (e) {
      console.error('❌ ' + t.name + ' 失败: ' + e.message);
      console.error('   ' + (e.stack || '').split('\n').slice(1).join('\n   '));
      failed++;
    });
  });
});
chain.then(function () {
  if (failed === 0) {
    console.log('\n全部 workspace-restore 测试通过 (' + tests.length + '/' + tests.length + ')');
  } else {
    console.log('\n' + failed + '/' + tests.length + ' 测试失败');
    process.exitCode = 1;
  }
});
