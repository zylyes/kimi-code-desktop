// usage-stats 模块单元测试
// 用法：node test-usage-stats.js
// 全部数据写在临时 sessionsRoot 下（<root>/<wdKey>/<sessionId>/agents/*/wire.jsonl），
// 时间戳一律用本地 Date 构造，分桶断言跨时区稳定；fixture 场景消费 tests/fixtures/usage/usage-record.jsonl。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-usage-stats-test-'));
const { UsageStats, parseUsageRecord, RANGES } = require('../src/main/usage-stats');

const FIXTURE = path.join(__dirname, 'fixtures', 'usage', 'usage-record.jsonl');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// 每个测试独立的 sessionsRoot，互不干扰
function newRoot(tag) {
  return path.join(tmpDir, tag, 'sessions');
}

// 本地时间戳：与分桶逻辑（本地 getHours/getDate）同源，任何时区下断言一致
function L(y, m, d, h, min, s = 0) {
  return new Date(y, m - 1, d, h, min, s).getTime();
}

// 在 root/<wdKey>/<sessionId>/agents/<agentId>/wire.jsonl 写入 JSONL（无尾换行 = 半写入尾行场景）
function makeWire(root, wdKey, sessionId, agentId, lines) {
  const dir = path.join(root, wdKey, sessionId, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function usageRecord({ model = 'kimi-code/k3', scope = 'turn', time, usage = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } } = {}) {
  return JSON.stringify({ type: 'usage.record', model, usage, usageScope: scope, time });
}

// ---------- 1. fixture 全量扫描：12 有效 / 2 坏行 / 缺 usage 跳过 / session 只计数 / byModel ----------
async function testFixtureScan() {
  const root = newRoot('t1');
  const fixtureLines = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  makeWire(root, 'w1', 's1', 'main', fixtureLines);
  assert.throws(() => new UsageStats({}), /sessionsRoot/);
  assert.deepStrictEqual(RANGES, ['today', '7d', '30d']);

  // now = 最后一条记录时间 + 3 天：所有记录都在 30d 窗口内且不晚于 now（时区无关的聚合断言）
  const now = 1785640200000 + 3 * 86400000;
  const stats = new UsageStats({ sessionsRoot: root, now: () => now });
  const snap = await stats.snapshot('30d');
  assert.deepStrictEqual(snap.diagnostics, { scannedFiles: 1, matchedRecords: 12, badLines: 2, sessionRecords: 4, partial: true },
    '12 有效（8 turn + 4 session）+ 2 坏行 + 1 缺 usage 行');
  assert.strictEqual(snap.schemaVersion, 1);
  assert.strictEqual(snap.range, '30d');
  // 聚合 = 纯 turn 求和：8 条 turn 逐条累加，4 条 session 只计数不参与聚合
  assert.strictEqual(snap.summary.requests, 8);
  assert.strictEqual(snap.summary.inputOther, 10754);
  assert.strictEqual(snap.summary.output, 7300);
  assert.strictEqual(snap.summary.inputCacheRead, 2330);
  assert.strictEqual(snap.summary.inputCacheCreation, 335);
  assert.strictEqual(snap.summary.totalTokens, 20719);
  assert.strictEqual(snap.summary.partial, undefined, '存在 turn 记录时不设 summary.partial');
  assert.strictEqual(snap.diagnostics.reason, undefined, '存在 turn 记录时不设 reason');
  assert.deepStrictEqual(snap.byModel.map((r) => r.model), ['kimi-code/k3', 'kimi-code/kimi-for-coding']);
  assert.strictEqual(snap.byModel[0].requests, 4);
  assert.strictEqual(snap.byModel[0].totalTokens, 7964);
  assert.strictEqual(snap.byModel[1].requests, 4);
  assert.strictEqual(snap.byModel[1].totalTokens, 12755);
  assert.strictEqual(snap.series.length, 30);
  assert.ok(snap.window.startMs < snap.window.endMs && snap.window.endMs <= now);
  assert.ok(typeof snap.window.timezone === 'string' && snap.window.timezone.length > 0);
  console.log('✅ fixture 扫描：12 有效 / 2 坏行 / 缺 usage 跳过 / session 只计数 / byModel');
}

// ---------- 2. today 按本地小时分桶：聚合 / 补零 / 昨天 23:59:59 排除 ----------
async function testTodayHourlyBuckets() {
  const root = newRoot('t2');
  const now = L(2026, 8, 2, 12, 0, 0);
  makeWire(root, 'w1', 's1', 'main', [
    usageRecord({ time: L(2026, 8, 2, 9, 5), usage: { inputOther: 100, output: 50, inputCacheRead: 10, inputCacheCreation: 5 } }),
    usageRecord({ time: L(2026, 8, 2, 9, 40), usage: { inputOther: 200, output: 100, inputCacheRead: 20, inputCacheCreation: 10 } }),
    usageRecord({ time: L(2026, 8, 2, 11, 0), usage: { inputOther: 300, output: 150, inputCacheRead: 30, inputCacheCreation: 15 } }),
    usageRecord({ time: L(2026, 8, 1, 23, 59, 59), usage: { inputOther: 999, output: 999, inputCacheRead: 999, inputCacheCreation: 999 } }),
  ]);
  const stats = new UsageStats({ sessionsRoot: root, now: () => now });
  const snap = await stats.snapshot('today');
  assert.strictEqual(snap.series.length, 13, '00..12 共 13 个整点');
  assert.strictEqual(snap.series[0].key, '00');
  assert.strictEqual(snap.series[12].key, '12');
  assert.strictEqual(snap.series[9].requests, 2, '9 点两条聚合');
  assert.strictEqual(snap.series[9].inputOther, 300);
  assert.strictEqual(snap.series[9].totalTokens, 165 + 330);
  assert.strictEqual(snap.series[11].inputOther, 300);
  assert.strictEqual(snap.series[12].requests, 0, '未来小时补零');
  assert.strictEqual(snap.series[1].requests, 0, '空小时补零');
  assert.strictEqual(snap.summary.requests, 3, '昨天 23:59:59 不计入 today');
  assert.strictEqual(snap.summary.totalTokens, 990);
  assert.strictEqual(snap.window.startMs, L(2026, 8, 2, 0, 0, 0));
  assert.strictEqual(snap.window.endMs, now);
  console.log('✅ today 本地小时分桶：聚合 / 补零 / 昨天排除');
}

// ---------- 3. 7d / 30d 按本地日期分桶：窗口边界 / 补零 ----------
async function testDayBuckets7d30d() {
  const root = newRoot('t3');
  const now = L(2026, 8, 2, 12, 0, 0);
  makeWire(root, 'w1', 's1', 'main', [
    usageRecord({ time: L(2026, 8, 2, 10, 0), usage: { inputOther: 1 } }),
    usageRecord({ time: L(2026, 8, 1, 10, 0), usage: { inputOther: 2 } }),
    usageRecord({ time: L(2026, 7, 27, 10, 0), usage: { inputOther: 3 } }),
    usageRecord({ time: L(2026, 7, 26, 10, 0), usage: { inputOther: 4 } }),
    usageRecord({ time: L(2026, 7, 4, 10, 0), usage: { inputOther: 5 } }),
    usageRecord({ time: L(2026, 7, 3, 10, 0), usage: { inputOther: 6 } }),
  ]);
  const stats = new UsageStats({ sessionsRoot: root, now: () => now });
  const s7 = await stats.snapshot('7d');
  assert.strictEqual(s7.series.length, 7);
  assert.deepStrictEqual(s7.series.map((p) => p.key),
    ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']);
  assert.strictEqual(s7.summary.requests, 3, '7d 含今天/昨天/6 天前，7 天前排除');
  assert.strictEqual(s7.summary.inputOther, 6);
  assert.strictEqual(s7.series[0].requests, 1);
  assert.strictEqual(s7.series[1].requests, 0, '空日期补零');
  const s30 = await stats.snapshot('30d');
  assert.strictEqual(s30.series.length, 30);
  assert.strictEqual(s30.series[0].key, '2026-07-04');
  assert.strictEqual(s30.summary.requests, 5, '30d 排除 30 天前');
  assert.strictEqual(s30.summary.inputOther, 15);
  assert.strictEqual(s30.window.startMs, L(2026, 7, 4, 0, 0, 0));
  console.log('✅ 7d/30d 本地日期分桶：边界 / 补零');
}

// ---------- 4. turn 聚合 + session 只计数不聚合：跨 agent 独立 / 全 session 场景 partial+reason ----------
async function testTurnSessionDedup() {
  const root = newRoot('t4');
  const now = L(2026, 8, 2, 12, 0, 0);
  // 文件 A：3 条 turn + 2 条 session → 聚合只看 3 条 turn（每条 10×4=40），session 只计数
  makeWire(root, 'w1', 's1', 'main', [
    usageRecord({ time: L(2026, 8, 2, 10, 0), usage: { inputOther: 10, output: 10, inputCacheRead: 10, inputCacheCreation: 10 } }),
    usageRecord({ time: L(2026, 8, 2, 10, 30), usage: { inputOther: 20, output: 20, inputCacheRead: 20, inputCacheCreation: 20 } }),
    usageRecord({ time: L(2026, 8, 2, 11, 0), usage: { inputOther: 30, output: 30, inputCacheRead: 30, inputCacheCreation: 30 } }),
    usageRecord({ scope: 'session', time: L(2026, 8, 2, 11, 30), usage: { inputOther: 100, output: 100, inputCacheRead: 100, inputCacheCreation: 100 } }),
    usageRecord({ scope: 'session', time: L(2026, 8, 2, 11, 50), usage: { inputOther: 200, output: 200, inputCacheRead: 200, inputCacheCreation: 200 } }),
  ]);
  // 文件 B：纯 turn 4 条 → 全累加（每条 1+2+3+4=10）
  makeWire(root, 'w1', 's1', 'sub', [
    usageRecord({ time: L(2026, 8, 2, 9, 0), usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } }),
    usageRecord({ time: L(2026, 8, 2, 9, 10), usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } }),
    usageRecord({ time: L(2026, 8, 2, 9, 20), usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } }),
    usageRecord({ time: L(2026, 8, 2, 9, 30), usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } }),
  ]);
  // 文件 C：纯 session 1 条（500×4=2000）→ 只计数不参与聚合
  makeWire(root, 'w2', 's2', 'main', [
    usageRecord({ scope: 'session', time: L(2026, 8, 2, 8, 0), usage: { inputOther: 500, output: 500, inputCacheRead: 500, inputCacheCreation: 500 } }),
  ]);
  const stats = new UsageStats({ sessionsRoot: root, now: () => now });
  const snap = await stats.snapshot('today');
  assert.strictEqual(snap.diagnostics.matchedRecords, 10, '读取计数含 session：5+4+1');
  assert.strictEqual(snap.diagnostics.sessionRecords, 3, 'session 计数：2+0+1');
  assert.strictEqual(snap.summary.requests, 7, '聚合仅 turn：3+4+0');
  assert.strictEqual(snap.summary.totalTokens, 280, '文件 A turn 40+80+120 + 文件 B 4×10 + session 不参与');
  assert.strictEqual(snap.summary.inputOther, 64, '文件 A turn 10+20+30 + 文件 B 4×1');
  assert.strictEqual(snap.summary.partial, undefined, '存在 turn 记录时不设 summary.partial');
  assert.strictEqual(snap.diagnostics.reason, undefined);
  assert.strictEqual(snap.byModel[0].model, 'kimi-code/k3');

  // 全 session 场景（独立 root）：窗口内 turn=0、session>0 → summary.partial + reason，聚合值全零
  const root2 = newRoot('t4b');
  makeWire(root2, 'w1', 's1', 'main', [
    usageRecord({ scope: 'session', time: L(2026, 8, 2, 8, 0), usage: { inputOther: 500, output: 500, inputCacheRead: 500, inputCacheCreation: 500 } }),
  ]);
  const stats2 = new UsageStats({ sessionsRoot: root2, now: () => now });
  const snap2 = await stats2.snapshot('today');
  assert.strictEqual(snap2.diagnostics.sessionRecords, 1);
  assert.strictEqual(snap2.diagnostics.reason, 'session-scope-only');
  assert.strictEqual(snap2.summary.partial, true);
  assert.strictEqual(snap2.summary.requests, 0, '聚合值全零，不做差分/取代推断');
  assert.strictEqual(snap2.summary.totalTokens, 0);
  assert.strictEqual(snap2.summary.inputOther, 0);
  assert.deepStrictEqual(snap2.byModel, [], '无 turn 记录 → byModel 为空');
  console.log('✅ turn 聚合 / session 只计数不聚合 / 全 session 场景 partial+reason');
}

// ---------- 5. 缓存：TTL 命中 / invalidate / 过期重扫 / compute 强制 ----------
async function testCache() {
  const root = newRoot('t5');
  const nowBox = { t: L(2026, 8, 2, 12, 0, 0) };
  let streamCalls = 0;
  const stats = new UsageStats({
    sessionsRoot: root,
    now: () => nowBox.t,
    cacheTtlMs: 30000,
    readStreamImpl: (p) => { streamCalls += 1; return fs.createReadStream(p, { encoding: 'utf8' }); },
  });
  const wireFile = makeWire(root, 'w1', 's1', 'main', [
    usageRecord({ time: L(2026, 8, 2, 10, 0), usage: { inputOther: 100 } }),
  ]);
  const s1 = await stats.snapshot('today');
  assert.strictEqual(streamCalls, 1);
  assert.strictEqual(s1.summary.requests, 1);
  const s2 = await stats.snapshot('7d');
  assert.strictEqual(streamCalls, 1, 'TTL 内换 range 不重扫（缓存的是扫描结果）');
  assert.strictEqual(s2.summary.requests, 1);
  // TTL 内文件变更不可见
  fs.appendFileSync(wireFile, '\n' + usageRecord({ time: L(2026, 8, 2, 11, 0), usage: { inputOther: 200 } }));
  const s3 = await stats.snapshot('today');
  assert.strictEqual(s3.summary.requests, 1, 'TTL 内变更不可见');
  assert.strictEqual(streamCalls, 1);
  // invalidate 后重扫
  stats.invalidate();
  const s4 = await stats.snapshot('today');
  assert.strictEqual(s4.summary.requests, 2, 'invalidate 后可见新记录');
  assert.strictEqual(streamCalls, 2);
  // TTL 过期自动重扫
  nowBox.t += 31000;
  const s5 = await stats.snapshot('today');
  assert.strictEqual(streamCalls, 3, 'TTL 过期自动重扫');
  assert.strictEqual(s5.summary.requests, 2);
  // compute 强制重算
  await stats.compute('30d');
  assert.strictEqual(streamCalls, 4);
  console.log('✅ 缓存：TTL 命中 / invalidate / 过期重扫 / compute 强制');
}

// ---------- 6. diagnostics：空目录零值 / 半写入尾行容忍 / 坏 time 标记 partial ----------
async function testDiagnostics() {
  // sessionsRoot 不存在 → 全零且不报错
  const missing = new UsageStats({ sessionsRoot: path.join(tmpDir, 't6-missing', 'sessions'), now: () => L(2026, 8, 2, 12, 0, 0) });
  const s1 = await missing.snapshot('today');
  assert.deepStrictEqual(s1.diagnostics, { scannedFiles: 0, matchedRecords: 0, badLines: 0, sessionRecords: 0, partial: false });
  assert.strictEqual(s1.summary.requests, 0);

  const root = newRoot('t6');
  // 半写入尾行（文件末尾无 \n 的合法 JSON）+ 空行 + 非 usage 行；空 agent 目录无 wire.jsonl 不计数
  makeWire(root, 'w1', 's1', 'main', [
    '',
    JSON.stringify({ type: 'metadata', protocol_version: '1' }),
    JSON.stringify({ type: 'usage.record', model: 'm1', usage: { inputOther: 5 }, usageScope: 'turn', time: L(2026, 8, 2, 9, 0) }),
    JSON.stringify({ type: 'usage.record', model: 'm1', usage: { output: 7 }, usageScope: 'turn', time: L(2026, 8, 2, 9, 30) }),
  ]);
  fs.mkdirSync(path.join(root, 'w1', 's1', 'agents', 'empty-agent'), { recursive: true });
  const stats2 = new UsageStats({ sessionsRoot: root, now: () => L(2026, 8, 2, 12, 0, 0) });
  const s2 = await stats2.snapshot('today');
  assert.strictEqual(s2.diagnostics.scannedFiles, 1, '空 agent 目录不计数');
  assert.strictEqual(s2.diagnostics.badLines, 0, '半写入尾行为合法 JSON 不算坏行');
  assert.strictEqual(s2.diagnostics.partial, false);
  assert.strictEqual(s2.summary.requests, 2);
  assert.strictEqual(s2.summary.totalTokens, 12, '缺字段按 0 计');
  assert.strictEqual(s2.byModel.length, 1);
  // 追加坏 time 记录 → skipped → partial，不参与统计
  fs.appendFileSync(path.join(root, 'w1', 's1', 'agents', 'main', 'wire.jsonl'),
    '\n' + JSON.stringify({ type: 'usage.record', model: 'm1', usage: { inputOther: 9 }, usageScope: 'turn', time: 0 }));
  const s3 = await stats2.compute('today');
  assert.strictEqual(s3.diagnostics.partial, true, '坏 time 记录 → partial');
  assert.strictEqual(s3.diagnostics.scannedFiles, 1);
  assert.strictEqual(s3.summary.requests, 2, '坏 time 记录不参与统计');
  assert.ok(!parseUsageRecord('{这不是合法JSON').ok);
  console.log('✅ diagnostics：空目录零值 / 半写入容忍 / 坏记录 partial');
}

// ---------- 7. byModel：多模型分组 / 缺失归 unknown / 字典序 ----------
async function testByModel() {
  const root = newRoot('t7');
  const now = L(2026, 8, 2, 12, 0, 0);
  makeWire(root, 'w1', 's1', 'main', [
    usageRecord({ model: 'kimi-code/k3', time: L(2026, 8, 2, 9, 0), usage: { inputOther: 100, output: 100 } }),
    usageRecord({ model: 'kimi-code/k3', time: L(2026, 8, 2, 10, 0), usage: { inputOther: 50, output: 50 } }),
    usageRecord({ model: 'kimi-for-coding', time: L(2026, 8, 2, 9, 0), usage: { inputOther: 10 } }),
    // model 字段缺失 / 空串 → 均归 unknown（手写行避免 helper 默认值）
    JSON.stringify({ type: 'usage.record', usage: { output: 5 }, usageScope: 'turn', time: L(2026, 8, 2, 11, 0) }),
    JSON.stringify({ type: 'usage.record', model: '', usage: { output: 6 }, usageScope: 'turn', time: L(2026, 8, 2, 11, 30) }),
  ]);
  const stats = new UsageStats({ sessionsRoot: root, now: () => now });
  const snap = await stats.snapshot('today');
  assert.deepStrictEqual(snap.byModel.map((r) => r.model), ['kimi-code/k3', 'kimi-for-coding', 'unknown']);
  assert.strictEqual(snap.byModel[0].requests, 2);
  assert.strictEqual(snap.byModel[0].totalTokens, 300);
  assert.strictEqual(snap.byModel[1].requests, 1);
  assert.strictEqual(snap.byModel[2].requests, 2, 'model 缺失与空串归 unknown');
  assert.strictEqual(snap.byModel[2].totalTokens, 11);
  console.log('✅ byModel：多模型分组 / 缺失归 unknown / 字典序');
}

// ---------- 8. 本地午夜边界：23:59:59 排除 / 00:00 与 now 计入 / window ----------
async function testTimezoneBoundary() {
  const root = newRoot('t8');
  const now = L(2026, 8, 2, 0, 0, 0);
  makeWire(root, 'w1', 's1', 'main', [
    usageRecord({ time: L(2026, 8, 1, 23, 59, 59), usage: { inputOther: 100 } }),
    usageRecord({ time: L(2026, 8, 2, 0, 0, 0), usage: { inputOther: 200 } }),
    usageRecord({ time: now, usage: { inputOther: 300 } }),
  ]);
  const stats = new UsageStats({ sessionsRoot: root, now: () => now });
  const snap = await stats.snapshot('today');
  assert.strictEqual(snap.summary.requests, 2, '昨天最后一秒排除；00:00 与 now 计入');
  assert.strictEqual(snap.summary.inputOther, 500);
  assert.deepStrictEqual(snap.series.map((p) => p.key), ['00']);
  assert.strictEqual(snap.series[0].requests, 2);
  assert.strictEqual(snap.window.startMs, L(2026, 8, 2, 0, 0, 0));
  assert.strictEqual(snap.window.endMs, now);
  assert.ok(typeof snap.window.timezone === 'string' && snap.window.timezone.length > 0);
  console.log('✅ 本地午夜边界：23:59:59 排除 / 00:00 与 now 计入 / series 仅 00 点');
}

async function run() {
  await testFixtureScan();
  await testTodayHourlyBuckets();
  await testDayBuckets7d30d();
  await testTurnSessionDedup();
  await testCache();
  await testDiagnostics();
  await testByModel();
  await testTimezoneBoundary();
  console.log('\n全部 usage-stats 测试通过');
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
