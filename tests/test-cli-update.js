// cli-update 模块单元测试
// 用法：node test-cli-update.js
// 全部请求使用桩 fetchImpl，不真实联网；缓存读写隔离在临时目录。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-cli-update-test-'));
const { JSON_URL, TEXT_URL, fetchLatest, readCache, compareSemver, isUpdateAvailable } = require('../src/main/cli-update');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------- 桩工具 ----------
// 简易 Response 桩：ok 与 status 均可识别，json() 对非法 JSON 抛错（模拟真实解析失败）
function makeRes(body, status = 200) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    text: async () => String(body),
    json: async () => JSON.parse(String(body)),
  };
}

// 按 URL 分发响应的桩；未匹配的 URL 抛错（用于证明某 endpoint 未被访问）
function urlStub(routes) {
  const hit = [];
  return {
    hit,
    impl: async (url, init) => {
      hit.push(url);
      const entry = routes[url];
      if (typeof entry === 'function') return entry(url, init);
      throw new Error(`未配置的请求: ${url}`);
    },
  };
}

// 永不 resolve 的桩：等待 AbortSignal.timeout 触发 abort 后 reject（模拟真实超时）
function neverResolve(url, init) {
  return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'AbortError';
      reject(e);
    });
  });
}

function makeCache(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

// ---------- 1. JSON 成功 ----------
async function testJsonOk() {
  const s = urlStub({
    [JSON_URL]: () => makeRes(JSON.stringify({ version: 'v1.2.3', publishedAt: '2026-08-02T00:00:00Z', rollout: 100 })),
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.latest, '1.2.3', 'v 前缀应被归一化');
  assert.strictEqual(r.source, 'json');
  assert.strictEqual(r.publishedAt, '2026-08-02T00:00:00Z', '字符串 publishedAt 应透传');
  assert.deepStrictEqual(s.hit, [JSON_URL], 'JSON 成功时不应访问 text endpoint');
  console.log('✅ JSON 成功：version 归一化 + publishedAt 透传，不访问 text');
}

// ---------- 2. JSON 成功但 publishedAt 非字符串 → 不透传 ----------
async function testJsonPublishedAtNonString() {
  const s = urlStub({
    [JSON_URL]: () => makeRes(JSON.stringify({ version: '1.2.3', publishedAt: 123456 })),
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.latest, '1.2.3');
  assert.ok(!('publishedAt' in r), '非字符串 publishedAt 不应透传');
  console.log('✅ JSON 成功：非字符串 publishedAt 不透传');
}

// ---------- 3. JSON 网络错误 → text 成功 ----------
async function testJsonNetworkFailTextOk() {
  const s = urlStub({
    [JSON_URL]: () => { throw new Error('net::ERR_CONNECTION_REFUSED'); },
    [TEXT_URL]: () => makeRes('v0.31.1\n'),
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.latest, '0.31.1');
  assert.strictEqual(r.source, 'text');
  assert.ok(!('publishedAt' in r), 'text 成功不应携带 publishedAt');
  console.log('✅ JSON 网络失败 → text 回退成功');
}

// ---------- 4. JSON 非 2xx → text 成功 ----------
async function testJsonHttpFailTextOk() {
  const s = urlStub({
    [JSON_URL]: () => makeRes('not found', 404),
    [TEXT_URL]: () => makeRes('2.0.0'),
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.latest, '2.0.0');
  assert.strictEqual(r.source, 'text');
  console.log('✅ JSON 非 2xx → text 回退成功');
}

// ---------- 5. JSON 非法 JSON → text 成功 ----------
async function testJsonParseFailTextOk() {
  const s = urlStub({
    [JSON_URL]: () => makeRes('not-json{{', 200),
    [TEXT_URL]: () => makeRes('1.2.3'),
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.latest, '1.2.3');
  assert.strictEqual(r.source, 'text');
  console.log('✅ JSON 非法 JSON → text 回退成功');
}

// ---------- 6. JSON 缺 version 字段 → text 成功 ----------
async function testJsonMissingVersionTextOk() {
  const s = urlStub({
    [JSON_URL]: () => makeRes(JSON.stringify({ tag_name: 'v1.2.3' }), 200),
    [TEXT_URL]: () => makeRes('1.2.3'),
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.latest, '1.2.3');
  assert.strictEqual(r.source, 'text');
  console.log('✅ JSON 缺 version 字段 → text 回退成功');
}

// ---------- 7. JSON 非法 version → text 成功 ----------
async function testJsonBadVersionTextOk() {
  const s = urlStub({
    [JSON_URL]: () => makeRes(JSON.stringify({ version: 'latest-1.2' }), 200),
    [TEXT_URL]: () => makeRes('v1.2.3'),
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.latest, '1.2.3');
  assert.strictEqual(r.source, 'text');
  console.log('✅ JSON 非法 version → text 回退成功');
}

// ---------- 8. 双失败：错误聚合 ----------
async function testBothFailAggregated() {
  const s = urlStub({
    [JSON_URL]: () => { throw new Error('connect ECONNREFUSED 1.2.3.4'); },
    [TEXT_URL]: () => { throw new Error('socket hang up'); },
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, false);
  assert.ok(!('latest' in r) && !('source' in r), '失败响应不得携带 latest/source');
  assert.ok(r.error.includes('JSON:'), '错误应包含 JSON 段');
  assert.ok(r.error.includes('TEXT:'), '错误应包含 TEXT 段');
  assert.ok(r.error.includes('ECONNREFUSED') && r.error.includes('socket hang up'), '应保留两端原因');
  console.log('✅ 双失败：错误聚合（JSON + TEXT）');
}

// ---------- 9. 错误消息截断（每段 <=120 字符） ----------
async function testErrorTruncation() {
  const longMsg = 'x'.repeat(500);
  const s = urlStub({
    [JSON_URL]: () => { throw new Error(longMsg); },
    [TEXT_URL]: () => { throw new Error(longMsg); },
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, false);
  const parts = r.error.split('; ');
  assert.strictEqual(parts.length, 2);
  for (const p of parts) {
    assert.ok(p.length <= 120, `错误段应 <=120 字符，实际 ${p.length}`);
  }
  assert.ok(r.error.includes('...'), '超长消息应被截断');
  console.log('✅ 双失败：超长错误消息按段截断（每段 <=120）');
}

// ---------- 10. 超时 ----------
async function testTimeout() {
  // AbortSignal.timeout 的内部 timer 为 unref，纯挂起的 promise 会让进程提前退出；
  // 用 keep-alive interval 保持事件循环，等待 30ms 后 abort 触发
  const keepAlive = setInterval(() => {}, 1000);
  let watchdog = null;
  try {
    // 测试侧 watchdog：若 fetchLatest 不再传入/使用 AbortSignal.timeout（signal 回归），
    // neverResolve 桩将永不 settle，5s 后快速失败而非挂住测试
    const watchdogPromise = new Promise((resolve) => {
      watchdog = setTimeout(() => resolve({ watchdogFired: true }), 5000);
    });
    const r = await Promise.race([
      fetchLatest({ fetchImpl: neverResolve, timeoutMs: 30 }),
      watchdogPromise,
    ]);
    clearTimeout(watchdog);
    watchdog = null;
    if (r && r.watchdogFired) {
      throw new Error('watchdog 触发：AbortSignal.timeout 未生效（超时信号回归），测试应快速失败');
    }
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('JSON:'), '应报告 JSON 段失败');
    assert.ok(r.error.includes('TEXT:'), '应报告 TEXT 段失败');
    assert.ok(/abort|timeout/i.test(r.error), `错误应体现超时/中止: ${r.error}`);
    console.log('✅ 超时：AbortSignal.timeout 中止后双失败（不真实联网）');
  } finally {
    if (watchdog) clearTimeout(watchdog);
    clearInterval(keepAlive);
  }
}

// ---------- 11. fetchImpl 缺失 ----------
async function testMissingFetchImpl() {
  const r = await fetchLatest({});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('fetchImpl'), '应提示 fetchImpl 缺失');
  console.log('✅ fetchImpl 缺失：直接失败并提示');
}

// ---------- 12. readCache 合法 ----------
function testReadCacheValid() {
  const cacheFile = path.join(tmpDir, 'updates', 'latest.json');
  makeCache(cacheFile, JSON.stringify({
    source: 'cli', checkedAt: '2026-07-23T10:00:00Z', latest: 'v0.29.0',
    manifest: { url: 'https://example.test/bin.json' },
  }));
  const r = readCache(cacheFile);
  assert.deepStrictEqual(r, { latest: '0.29.0', checkedAt: '2026-07-23T10:00:00Z' },
    '只应读取 latest（归一化）与字符串 checkedAt，其余字段忽略');
  // 缓存文件未被写入（readCache 后内容不变）
  const after = fs.readFileSync(cacheFile, 'utf8');
  assert.ok(after.includes('manifest'), 'readCache 不应改写缓存文件');
  console.log('✅ readCache 合法：latest 归一化 + checkedAt 透传，忽略其余字段，不写缓存');
}

// ---------- 13. readCache 缺失 ----------
function testReadCacheMissing() {
  assert.strictEqual(readCache(path.join(tmpDir, 'nope', 'latest.json')), null, '文件缺失应返回 null');
  console.log('✅ readCache 缺失 → null');
}

// ---------- 14. readCache 损坏 ----------
function testReadCacheCorrupt() {
  const cacheFile = path.join(tmpDir, 'updates-corrupt', 'latest.json');
  makeCache(cacheFile, '{broken json!!');
  assert.strictEqual(readCache(cacheFile), null, '损坏 JSON 应返回 null');
  console.log('✅ readCache 损坏 → null');
}

// ---------- 15. readCache 非法 latest / 非字符串 checkedAt ----------
function testReadCacheInvalid() {
  const badLatest = path.join(tmpDir, 'updates-badlatest', 'latest.json');
  makeCache(badLatest, JSON.stringify({ latest: '1.2', checkedAt: '2026-07-23T10:00:00Z' }));
  assert.strictEqual(readCache(badLatest), null, 'latest 非法（1.2）应返回 null');

  const badCheckedAt = path.join(tmpDir, 'updates-badchecked', 'latest.json');
  makeCache(badCheckedAt, JSON.stringify({ latest: '1.2.3', checkedAt: 12345 }));
  const r = readCache(badCheckedAt);
  assert.deepStrictEqual(r, { latest: '1.2.3' }, '非字符串 checkedAt 应被忽略，latest 保留');

  const notObject = path.join(tmpDir, 'updates-array', 'latest.json');
  makeCache(notObject, '[1,2,3]');
  assert.strictEqual(readCache(notObject), null, '非对象 JSON 应返回 null');
  console.log('✅ readCache 非法：latest 非法 → null；checkedAt 非字符串忽略');
}

// ---------- 16. compareSemver ----------
function testCompareSemver() {
  assert.strictEqual(compareSemver('1.2.3', '1.2.3'), 0, '相等 → 0');
  assert.strictEqual(compareSemver('v1.2.3', 'v1.2.3'), 0, 'v 前缀相等 → 0');
  assert.strictEqual(compareSemver('v1.2.3', '1.2.3'), 0, 'v 前缀与无前缀相等 → 0');
  assert.strictEqual(compareSemver('1.2.4', '1.2.3'), 1, '大 → 1');
  assert.strictEqual(compareSemver('2.0.0', '1.9.9'), 1, '跨段大 → 1');
  assert.strictEqual(compareSemver('v2.0.0', '1.9.9'), 1, 'v 前缀大 → 1');
  assert.strictEqual(compareSemver('1.2.3', '1.2.4'), -1, '小 → -1');
  assert.strictEqual(compareSemver('1.2.3', 'v2.0.0'), -1, '对 v 前缀小 → -1');
  assert.strictEqual(compareSemver('abc', '1.2.3'), 0, '非法输入不抛异常，视为相等');
  console.log('✅ compareSemver：相等 / 大小 / v 前缀 / 非法输入');
}

// ---------- 17. isUpdateAvailable：本地低/相等/高/current 空/非法输入 ----------
// 直接测试 cli-update 共享函数（main.js handler 复用同一实现，测试不再复制表达式）
function testIsUpdateAvailable() {
  // 本地版本更低 → true
  assert.strictEqual(isUpdateAvailable('1.0.0', '1.2.3'), true, '本地低于远端 → true');
  assert.strictEqual(isUpdateAvailable('v1.0.0', '1.2.3'), true, 'v 前缀本地低于远端 → true');
  // 相等 → false
  assert.strictEqual(isUpdateAvailable('1.2.3', '1.2.3'), false, '相等 → false');
  assert.strictEqual(isUpdateAvailable('v1.2.3', '1.2.3'), false, 'v 前缀相等 → false');
  // 本地版本更高 → false
  assert.strictEqual(isUpdateAvailable('2.0.0', '1.2.3'), false, '本地高于远端 → false');
  assert.strictEqual(isUpdateAvailable('v2.0.0', '1.2.3'), false, 'v 前缀本地高于远端 → false');
  // current 为空 → false（绝不因远端成功而误报）
  assert.strictEqual(isUpdateAvailable('', '1.2.3'), false, 'current 为空字符串 → false');
  assert.strictEqual(isUpdateAvailable(null, '1.2.3'), false, 'current 为 null → false');
  assert.strictEqual(isUpdateAvailable(undefined, '1.2.3'), false, 'current 为 undefined → false');
  // 任一版本非法 → false
  assert.strictEqual(isUpdateAvailable('abc', '1.2.3'), false, 'current 非法 → false');
  assert.strictEqual(isUpdateAvailable('1.2', '1.2.3'), false, 'current 不完整 → false');
  assert.strictEqual(isUpdateAvailable('1.2.3', 'abc'), false, 'latest 非法 → false');
  assert.strictEqual(isUpdateAvailable('1.2.3', ''), false, 'latest 为空 → false');
  console.log('✅ isUpdateAvailable：本地低/相等/高/current 空/非法输入');
}

// ---------- 18. 成功路径不读取缓存（也不写缓存） ----------
async function testSuccessIgnoresCache() {
  const cacheFile = path.join(tmpDir, 'updates-success', 'latest.json');
  makeCache(cacheFile, '{broken json!!'); // 磁盘缓存损坏也不影响成功路径
  const s = urlStub({
    [JSON_URL]: () => makeRes(JSON.stringify({ version: '0.31.1' })),
  });
  const r = await fetchLatest({ fetchImpl: s.impl });
  assert.strictEqual(r.ok, true);
  assert.ok(!('cachedLatest' in r) && !('cachedCheckedAt' in r),
    '远端成功响应不得携带任何缓存字段');
  assert.strictEqual(fs.readFileSync(cacheFile, 'utf8'), '{broken json!!',
    '成功路径不应改写缓存文件');
  // 失败路径才会产出缓存字段（模拟 handler 编排）：远端失败 + 合法缓存 → 仅 cachedLatest/cachedCheckedAt
  const badS = urlStub({
    [JSON_URL]: () => { throw new Error('offline'); },
    [TEXT_URL]: () => { throw new Error('offline'); },
  });
  const failR = await fetchLatest({ fetchImpl: badS.impl });
  assert.strictEqual(failR.ok, false);
  assert.ok(!('latest' in failR) && !('updateAvailable' in failR), '失败响应严禁携带 latest/updateAvailable');
  console.log('✅ 成功路径不读取/不写缓存；失败响应不含 latest/updateAvailable');
}

async function run() {
  await testJsonOk();
  await testJsonPublishedAtNonString();
  await testJsonNetworkFailTextOk();
  await testJsonHttpFailTextOk();
  await testJsonParseFailTextOk();
  await testJsonMissingVersionTextOk();
  await testJsonBadVersionTextOk();
  await testBothFailAggregated();
  await testErrorTruncation();
  await testTimeout();
  await testMissingFetchImpl();
  testReadCacheValid();
  testReadCacheMissing();
  testReadCacheCorrupt();
  testReadCacheInvalid();
  testCompareSemver();
  testIsUpdateAvailable();
  await testSuccessIgnoresCache();
  console.log('\n全部 cli-update 测试通过');
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
