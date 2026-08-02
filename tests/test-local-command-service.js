// LocalCommandService 单元测试（全桩：无 electron / 网络 / 文件依赖）
// 运行：node tests/test-local-command-service.js
'use strict';

const assert = require('assert');
const { LocalCommandService } = require('../src/main/local-command-service.js');

const NOW = 1234567890;

// ---- 桩 ----
function makeRuntimeState({ sessionMap = {}, globalUsage = null } = {}) {
  return {
    getSessionUsage(sessionId) {
      return Object.prototype.hasOwnProperty.call(sessionMap, sessionId) ? sessionMap[sessionId] : null;
    },
    getUsageSnapshot() {
      return globalUsage || { totalTokens: 0, contextUsed: 0, contextLimit: 0, runningTasks: 0, lastTaskTitle: '' };
    },
  };
}

// 注：冻结接口为 UsageStats.snapshot(range)（规格文字写 getSnapshot，实现按冻结接口）
function makeUsageStats(map = {}) {
  return {
    snapshot(range) {
      const entry = map[range];
      if (entry && entry.error) return Promise.reject(entry.error);
      return Promise.resolve(entry && entry.value !== undefined ? entry.value : null);
    },
  };
}

function trendSnapshot(range, marker) {
  return {
    schemaVersion: 1,
    range,
    marker,
    summary: { requests: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, totalTokens: 0 },
    series: [],
    byModel: [],
    window: { startMs: 0, endMs: NOW, timezone: 'UTC' },
    diagnostics: { scannedFiles: 1, matchedRecords: 0, badLines: 0, sessionRecords: 0, partial: false },
  };
}

function managedOk(overrides = {}) {
  return {
    kind: 'ok',
    plans: [{ id: 'weekly', label: 'Weekly limit', used: 10, limit: 100, resetAt: '2026-08-09T00:00:00Z' }],
    wallet: { currency: 'USD', balanceMinor: 12345, monthlyUsedMinor: 0, monthlyLimitMinor: 0 },
    fetchedAt: NOW,
    staleAt: NOW + 60000,
    ...overrides,
  };
}

function makeService({ sessionMap = {}, globalUsage = null, usageMap = {}, managedImpl = () => Promise.resolve(managedOk()), statusCtx = () => null } = {}) {
  return new LocalCommandService({
    runtimeState: makeRuntimeState({ sessionMap, globalUsage }),
    usageStats: makeUsageStats(usageMap),
    fetchManagedUsageImpl: managedImpl,
    getStatusContext: statusCtx,
    now: () => NOW,
  });
}

function call(svc, command, { sessionId = null, signal = null } = {}) {
  return svc.runLocalCommand(command, { sessionId, signal });
}

// ---- 用例 ----
async function testUsageAllGreen() {
  const svc = makeService({
    sessionMap: { s1: { totalTokens: 100, contextUsed: 50, contextLimit: 200 } },
    globalUsage: { totalTokens: 0, contextUsed: 0, contextLimit: 0 },
    usageMap: {
      today: { value: trendSnapshot('today', 'T') },
      '7d': { value: trendSnapshot('7d', 'S') },
      '30d': { value: trendSnapshot('30d', 'X') },
    },
  });
  const res = await call(svc, '/usage', { sessionId: 's1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.kind, 'usage');
  assert.strictEqual(res.generatedAt, NOW);
  assert.deepStrictEqual(res.data.contextWindow, { used: 50, limit: 200, source: 'session' });
  assert.deepStrictEqual(res.data.sessionUsage, { totalTokens: 100, contextUsed: 50, contextLimit: 200 });
  assert.strictEqual(res.data.trends.today.marker, 'T');
  assert.strictEqual(res.data.trends['7d'].marker, 'S');
  assert.strictEqual(res.data.trends['30d'].marker, 'X');
  assert.deepStrictEqual(res.data.managed, managedOk());
  assert.deepStrictEqual(res.data.errors, []);
}

async function testContextWindowFallback() {
  // a) 会话无记录 → 回退 global-ws
  let svc = makeService({
    sessionMap: {},
    globalUsage: { totalTokens: 30, contextUsed: 30, contextLimit: 100 },
  });
  let res = await call(svc, '/usage', { sessionId: 'ghost' });
  assert.deepStrictEqual(res.data.contextWindow, { used: 30, limit: 100, source: 'global-ws' });
  assert.strictEqual(res.data.sessionUsage, null);

  // b) 全局桶 contextLimit=0 → null
  svc = makeService({
    globalUsage: { totalTokens: 0, contextUsed: 0, contextLimit: 0 },
  });
  res = await call(svc, '/usage', { sessionId: 'ghost' });
  assert.strictEqual(res.data.contextWindow, null);

  // c) sessionId=null → 直接 global-ws 路径，sessionUsage 恒 null
  svc = makeService({
    globalUsage: { totalTokens: 7, contextUsed: 7, contextLimit: 50 },
  });
  res = await call(svc, '/usage', { sessionId: null });
  assert.deepStrictEqual(res.data.contextWindow, { used: 7, limit: 50, source: 'global-ws' });
  assert.strictEqual(res.data.sessionUsage, null);
}

async function testManagedAuthRequired() {
  const svc = makeService({
    managedImpl: () => Promise.resolve(managedOk({ kind: 'auth-required', plans: [], wallet: null })),
  });
  const res = await call(svc, '/usage', { sessionId: 's1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.managed.kind, 'auth-required');
  assert.deepStrictEqual(res.data.managed.plans, []);
  assert.deepStrictEqual(res.data.errors, []); // kind 分级不算失败
}

async function testTrend7dThrows() {
  const svc = makeService({
    usageMap: {
      today: { value: trendSnapshot('today', 'T') },
      '7d': { error: new Error('boom 7d') },
      '30d': { value: trendSnapshot('30d', 'X') },
    },
  });
  const res = await call(svc, '/usage', { sessionId: 's1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.trends['7d'], null);
  assert.strictEqual(res.data.trends.today.marker, 'T');
  assert.strictEqual(res.data.trends['30d'].marker, 'X');
  assert.deepStrictEqual(res.data.errors, [{ part: 'trends.7d', message: 'boom 7d' }]);
  assert.strictEqual(res.data.managed.kind, 'ok'); // 其余 part 不受影响
}

async function testManagedThrows() {
  const svc = makeService({
    usageMap: {
      today: { value: trendSnapshot('today', 'T') },
      '7d': { value: trendSnapshot('7d', 'S') },
      '30d': { value: trendSnapshot('30d', 'X') },
    },
    managedImpl: () => Promise.reject(new Error('platform down')),
  });
  const res = await call(svc, '/usage', { sessionId: 's1' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.data.managed, { kind: 'error', plans: [], wallet: null, fetchedAt: NOW, staleAt: NOW });
  assert.deepStrictEqual(res.data.errors, [{ part: 'managed', message: 'platform down' }]);
  assert.strictEqual(res.data.trends.today.marker, 'T'); // trends 正常
}

async function testStatusPassthrough() {
  const ctx = {
    cliVersion: '1.2.3', desktopVersion: '4.5.6', model: 'kimi-k2', thinking: true,
    mode: 'edit', permissionMode: 'ask', cwd: 'C:\\proj', sessionState: 'idle',
  };
  const svc = makeService({
    sessionMap: { s1: { totalTokens: 100, contextUsed: 50, contextLimit: 200 } },
    statusCtx: (sid) => (sid === 's1' ? ctx : null),
  });
  const res = await call(svc, '/status', { sessionId: 's1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.kind, 'status');
  assert.strictEqual(res.generatedAt, NOW);
  for (const k of ['cliVersion', 'desktopVersion', 'model', 'thinking', 'mode', 'permissionMode', 'cwd', 'sessionState']) {
    assert.strictEqual(res.data[k], ctx[k], `field ${k}`);
  }
  assert.deepStrictEqual(res.data.contextWindow, { used: 50, limit: 200, source: 'session' });
  assert.deepStrictEqual(res.data.managedSummary, {
    kind: 'ok', planLabel: 'Weekly limit', planUsed: 10, planLimit: 100, walletBalanceMinor: 12345, currency: 'USD',
  });
  assert.deepStrictEqual(res.data.errors, []);
}

async function testStatusNullCtx() {
  const svc = makeService({
    sessionMap: { s1: { totalTokens: 100, contextUsed: 50, contextLimit: 200 } },
    statusCtx: () => null,
  });
  const res = await call(svc, '/status', { sessionId: 's1' });
  assert.strictEqual(res.ok, true); // 静态字段全 null 但 ok:true
  for (const k of ['cliVersion', 'desktopVersion', 'model', 'thinking', 'mode', 'permissionMode', 'cwd', 'sessionState']) {
    assert.strictEqual(res.data[k], null, `field ${k}`);
  }
  assert.deepStrictEqual(res.data.contextWindow, { used: 50, limit: 200, source: 'session' });
  assert.strictEqual(res.data.managedSummary.kind, 'ok'); // managed 独立于 ctx
}

async function testStatusWalletNull() {
  const svc = makeService({
    managedImpl: () => Promise.resolve(managedOk({ wallet: null })),
  });
  const res = await call(svc, '/status');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.data.managedSummary, {
    kind: 'ok', planLabel: 'Weekly limit', planUsed: 10, planLimit: 100, walletBalanceMinor: null, currency: null,
  });
}

async function testMatching() {
  const svc = makeService();
  for (const cmd of ['/usage foo', '/statusbar', '/foo', '/USAGE']) {
    const res = await call(svc, cmd);
    assert.strictEqual(res.ok, false, `cmd=${cmd}`);
    assert.strictEqual(res.code, 'not-local-command', `cmd=${cmd}`);
  }
  const ok1 = await call(svc, '/usage '); // 尾空格 → trim 后本地命令
  assert.strictEqual(ok1.ok, true);
  assert.strictEqual(ok1.kind, 'usage');
  const ok2 = await call(svc, '/status');
  assert.strictEqual(ok2.ok, true);
  assert.strictEqual(ok2.kind, 'status');
}

async function testSignalPreAborted() {
  let fetchCalls = 0;
  const svc = makeService({
    managedImpl: () => { fetchCalls += 1; return Promise.resolve(managedOk()); },
  });
  const ac = new AbortController();
  ac.abort();
  const res = await call(svc, '/usage', { signal: ac.signal });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'aborted');
  assert.strictEqual(fetchCalls, 0); // 调用前已检测，未触达 fetch
}

async function testMessageTruncation() {
  const svc = makeService({
    managedImpl: () => Promise.reject(new Error('x'.repeat(300))),
  });
  const res = await call(svc, '/usage');
  assert.strictEqual(res.data.errors.length, 1);
  assert.strictEqual(res.data.errors[0].part, 'managed');
  assert.strictEqual(res.data.errors[0].message.length, 200);
  assert.ok(res.data.errors[0].message.endsWith('...'));
}

// ---- runner ----
(async () => {
  const cases = [
    ['1. /usage 全绿（session contextWindow + sessionUsage + 三 range + managed 透传 + errors 空）', testUsageAllGreen],
    ['2. contextWindow 回退（无会话记录→global-ws / 全局 contextLimit=0→null / sessionId=null→global-ws）', testContextWindowFallback],
    ['3. managed auth-required → ok:true、errors 空（分级不算失败）', testManagedAuthRequired],
    ['4. usageStats 对 7d 抛错 → trends.7d=null、errors 记 trends.7d、其余正常、ok:true', testTrend7dThrows],
    ['5. fetchManagedUsageImpl 抛错 → managed=error 快照 + errors 记 managed、trends 正常', testManagedThrows],
    ['6. /status 字段全透传 + managedSummary 形状 + contextWindow', testStatusPassthrough],
    ['6b. /status getStatusContext=null → 静态字段全 null 但 ok:true', testStatusNullCtx],
    ['7. /status managed wallet=null → walletBalanceMinor=null', testStatusWalletNull],
    ['8. 匹配规则（/usage foo、/statusbar、/foo、/USAGE → not-local；/usage 尾空格 → 本地）', testMatching],
    ['9. signal 预 aborted → code=aborted 且 fetch 未被调用', testSignalPreAborted],
    ['10. 错误消息截断 200 字符', testMessageTruncation],
  ];
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      pass += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      fail += 1;
      console.error(`FAIL - ${name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})();
