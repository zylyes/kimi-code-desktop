// managed-usage 模块单元测试
// 用法：node test-managed-usage.js
// 全部请求使用桩 fetchImpl，不真实联网；OAuth 凭据文件隔离在临时目录。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-managed-usage-test-'));
const { fetchManagedUsage, loadOAuthToken } = require('../src/main/managed-usage');

const BASE = 'https://example.test/api';
const URL = `${BASE}/usages`;
const TOKEN = 'TEST-TOKEN';
const NOW = 1754000000000; // 固定时间注入，便于断言 fetchedAt/staleAt

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------- 桩工具（范式同 test-cli-update.js） ----------
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

// 按 URL 分发响应并记录全部调用（url/init）；未匹配的 URL 抛错（用于证明某 endpoint 未被访问）
function urlStub(routes) {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      const entry = routes[url];
      if (typeof entry === 'function') return entry(url, init);
      throw new Error(`未配置的请求: ${url}`);
    },
  };
}

// 永不 resolve 的桩：等待 signal abort 后 reject（模拟真实超时）
function neverResolve(url, init) {
  return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'AbortError';
      reject(e);
    });
  });
}

// ---------- 1. 无 token → unavailable，不发请求 ----------
async function testNoTokenUnavailable() {
  let called = false;
  const r = await fetchManagedUsage({
    fetchImpl: async () => { called = true; throw new Error('不应被调用'); },
    token: null,
    now: () => NOW,
  });
  assert.strictEqual(r.kind, 'unavailable');
  assert.deepStrictEqual(r.plans, []);
  assert.strictEqual(r.wallet, null);
  assert.strictEqual(r.fetchedAt, NOW);
  assert.strictEqual(r.staleAt, NOW + 60000);
  assert.strictEqual(called, false, '无 token 时不得发起请求');

  const r2 = await fetchManagedUsage({ fetchImpl: async () => { called = true; }, token: '', now: () => NOW });
  assert.strictEqual(r2.kind, 'unavailable', '空字符串 token 同样视为无 token');
  assert.strictEqual(called, false, '空 token 也不得发起请求');
  console.log('✅ 无 token → unavailable（plans 空 / wallet null / 不发起请求）');
}

// ---------- 2. 401 → auth-required；404 → unavailable；500 → error（脱敏） ----------
async function testHttpErrors() {
  const r401 = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes('unauthorized', 401) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(r401.kind, 'auth-required');
  assert.deepStrictEqual(r401.plans, []);

  const r404 = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes('not found', 404) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(r404.kind, 'unavailable');

  const r500 = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes('boom', 500) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(r500.kind, 'error');
  assert.ok(!r500.message.includes(TOKEN), 'error 消息不得含 token');
  assert.ok(!r500.message.includes(BASE), 'error 消息不得含完整 URL');
  assert.ok(!r500.message.includes('/usages'), 'error 消息不得含请求路径');
  console.log('✅ 401→auth-required；404→unavailable；500→error（消息脱敏）');
}

// ---------- 3. 网络 reject / 非法 JSON / 超时 → error（脱敏） ----------
async function testNetworkAndTimeoutErrors() {
  // 网络错误：reject 且消息含完整 URL，应被脱敏
  const rNet = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => { throw new Error(`net::ERR_CONNECTION_REFUSED ${URL}`); } }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(rNet.kind, 'error');
  assert.ok(!rNet.message.includes(TOKEN), 'error 消息不得含 token');
  assert.ok(!rNet.message.includes(BASE), 'error 消息不得含完整 URL');
  assert.ok(!rNet.message.includes('example.test'), 'error 消息不得含 host 名');
  assert.ok(rNet.message.includes('ERR_CONNECTION_REFUSED'), '应保留网络错误原因');

  // 非法 JSON：2xx 但 json() 抛 SyntaxError
  const rBad = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes('not-json{{', 200) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(rBad.kind, 'error');
  assert.ok(!rBad.message.includes(TOKEN) && !rBad.message.includes(BASE), '解析失败消息不得含 token/URL');

  // 超时：neverResolve 桩 + timeoutMs 触发 AbortController；watchdog 兜底防挂起
  const watchdog = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ watchdogFired: true }), 5000);
    if (typeof t.unref === 'function') t.unref();
  });
  const rTimeout = await Promise.race([
    fetchManagedUsage({ fetchImpl: neverResolve, token: TOKEN, baseUrl: BASE, timeoutMs: 50, now: () => NOW }),
    watchdog,
  ]);
  if (rTimeout && rTimeout.watchdogFired) {
    throw new Error('watchdog 触发：AbortController 超时未生效（signal 回归），测试应快速失败');
  }
  assert.strictEqual(rTimeout.kind, 'error', '超时应归为 error');
  assert.ok(!rTimeout.message.includes(TOKEN) && !rTimeout.message.includes(BASE), '超时消息不得含 token/URL');
  assert.ok(/abort|timeout/i.test(rTimeout.message), `超时错误消息应体现中止/超时: ${rTimeout.message}`);
  console.log('✅ 网络 reject / 非法 JSON / 超时 → error（消息脱敏）');
}

// ---------- 4. 200 完整 payload：plans 3 项 / wallet 1e6→分 / staleAt 间隔 ----------
async function testOkFullPayload() {
  const payload = {
    usage: { used: '1234', limit: '5000', resetTime: '2026-08-09T00:00:00Z' },
    limits: [
      { window: { duration: 5, timeUnit: 'hour' }, detail: { used: '100', limit: '200', resetTime: '2026-08-02T12:00:00Z' } },
      { window: { duration: 7, timeUnit: 'day' }, detail: { used: '300', limit: '1000', resetTime: '2026-08-09T00:00:00Z' } },
    ],
    boosterWallet: {
      type: 'BOOSTER',
      currency: 'USD',
      amount: '1000000',
      amountLeft: '500000',
      monthlyChargeLimitEnabled: true,
      monthlyUsed: { amount: '123456', currency: 'USD' },
      monthlyChargeLimit: { amount: '250000', currency: 'USD' },
    },
  };
  const r = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes(JSON.stringify(payload)) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(r.kind, 'ok');
  assert.strictEqual(r.plans.length, 3, 'usage + limits[2] 共 3 项');
  assert.deepStrictEqual(r.plans[0], {
    id: 'weekly', label: 'Weekly limit', used: 1234, limit: 5000, resetAt: '2026-08-09T00:00:00Z',
  }, 'usage 项：十进制字符串→数字，resetAt 透传');
  assert.deepStrictEqual(r.plans[1], {
    id: 'limit-0', label: '5h limit', used: 100, limit: 200, resetAt: '2026-08-02T12:00:00Z',
  }, 'limits[0]：5+hour → 5h limit');
  assert.deepStrictEqual(r.plans[2], {
    id: 'limit-1', label: '7d limit', used: 300, limit: 1000, resetAt: '2026-08-09T00:00:00Z',
  }, 'limits[1]：7+day → 7d limit');
  assert.deepStrictEqual(r.wallet, {
    currency: 'USD', balanceMinor: 50, monthlyUsedMinor: 12, monthlyLimitMinor: 25,
  }, '1e6 fixed-point → 分（四舍五入）');
  assert.strictEqual(r.fetchedAt, NOW);
  assert.strictEqual(r.staleAt - r.fetchedAt, 60000, 'staleAt = fetchedAt + 60s');
  console.log('✅ 200 完整 payload：plans 3 项映射 / wallet 1e6→分 / staleAt-fetchedAt=60000');
}

// ---------- 5. wallet 边界：开关关闭 / 缺失 / 类型不符 ----------
async function testWalletEdges() {
  // monthlyChargeLimitEnabled=false → monthlyLimitMinor=0；currency 缺省 USD
  const p1 = {
    usage: { used: '1', limit: '2', resetTime: 'x' },
    boosterWallet: { type: 'BOOSTER', amountLeft: '10000', monthlyChargeLimitEnabled: false, monthlyUsed: { amount: '50000' } },
  };
  const r1 = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes(JSON.stringify(p1)) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(r1.kind, 'ok');
  assert.strictEqual(r1.wallet.currency, 'USD', 'currency 缺省 USD');
  assert.strictEqual(r1.wallet.balanceMinor, 1, '10000/1e4 = 1 分');
  assert.strictEqual(r1.wallet.monthlyUsedMinor, 5, '50000/1e4 = 5 分');
  assert.strictEqual(r1.wallet.monthlyLimitMinor, 0, 'monthlyChargeLimitEnabled=false → monthlyLimitMinor=0');

  // boosterWallet 缺失 → wallet:null
  const r2 = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes(JSON.stringify({ usage: { used: '1', limit: '2' } })) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(r2.kind, 'ok');
  assert.strictEqual(r2.wallet, null, 'boosterWallet 缺失 → wallet:null');

  // type !== 'BOOSTER' → wallet:null
  const r3 = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes(JSON.stringify({ usage: { used: '1', limit: '2' }, boosterWallet: { type: 'OTHER', amountLeft: '999' } })) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(r3.wallet, null, "type!=='BOOSTER' → wallet:null");
  console.log('✅ wallet 边界：开关关闭→monthlyLimitMinor=0 / 缺失→null / 类型不符→null');
}

// ---------- 6. 缺 usage/limits 字段 → plans 空但 ok；顶层非对象 → error ----------
async function testMissingFields() {
  const r = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes(JSON.stringify({})) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(r.kind, 'ok', '顶层对象缺字段不崩，仍为 ok');
  assert.deepStrictEqual(r.plans, []);
  assert.strictEqual(r.wallet, null);

  const r2 = await fetchManagedUsage({
    fetchImpl: urlStub({ [URL]: () => makeRes('null', 200) }).impl,
    token: TOKEN, baseUrl: BASE, now: () => NOW,
  });
  assert.strictEqual(r2.kind, 'error');
  assert.strictEqual(r2.message, 'Invalid usage response');
  console.log('✅ 缺 usage/limits → plans 空但 ok；顶层非对象 → Invalid usage response');
}

// ---------- 7. 请求断言：方法 / URL / Authorization 头；返回值不含 token/URL ----------
async function testRequestAssertions() {
  const s = urlStub({ [URL]: () => makeRes(JSON.stringify({ usage: { used: '1', limit: '2', resetTime: 't' } })) });
  const r = await fetchManagedUsage({ fetchImpl: s.impl, token: TOKEN, baseUrl: BASE, now: () => NOW });
  assert.strictEqual(r.kind, 'ok');
  assert.strictEqual(s.calls.length, 1, '只应发起一次请求');
  const call = s.calls[0];
  assert.strictEqual(call.url, URL, '请求 URL 应为 baseUrl + /usages');
  assert.strictEqual(call.init.method, 'GET', '请求方法应为 GET');
  assert.strictEqual(call.init.headers.Authorization, `Bearer ${TOKEN}`, 'Authorization 头应为 Bearer <token>');
  assert.ok(call.init.signal, '请求应携带 AbortSignal');
  const json = JSON.stringify(r);
  assert.ok(!json.includes(TOKEN), '返回值不得含 token');
  assert.ok(!json.includes('example.test'), '返回值不得含 URL');
  assert.ok(!json.includes('/usages'), '返回值不得含请求路径');
  console.log('✅ 请求断言：GET baseUrl/usages + Bearer 头 + signal；返回值不含 token/URL');
}

// ---------- 8. loadOAuthToken：临时目录 4 用例 ----------
function writeCred(sub, content) {
  const dir = path.join(tmpDir, sub, 'credentials');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kimi-code.json'), content, 'utf8');
  return path.join(tmpDir, sub);
}

function testLoadOAuthToken() {
  // 文件缺失
  assert.strictEqual(loadOAuthToken({ kimiCodeHome: path.join(tmpDir, 'missing-home') }), null, '文件缺失 → null');

  // 坏 JSON
  assert.strictEqual(loadOAuthToken({ kimiCodeHome: writeCred('bad-json', '{oops') }), null, '坏 JSON → null');

  // access_token 缺失 / 空白 / 非字符串
  assert.strictEqual(loadOAuthToken({ kimiCodeHome: writeCred('no-field', JSON.stringify({ other: 1 })) }), null, '缺 access_token → null');
  assert.strictEqual(loadOAuthToken({ kimiCodeHome: writeCred('blank-tok', JSON.stringify({ access_token: '  ' })) }), null, 'access_token 空白 → null');
  assert.strictEqual(loadOAuthToken({ kimiCodeHome: writeCred('num-tok', JSON.stringify({ access_token: 12345 })) }), null, 'access_token 非字符串 → null');

  // 正常：返回 accessToken，忽略其余字段
  assert.deepStrictEqual(
    loadOAuthToken({ kimiCodeHome: writeCred('good', JSON.stringify({ access_token: '  real-token-abc  ', extra: 'ignored' })) }),
    { accessToken: 'real-token-abc' },
    '正常返回 accessToken（trim），忽略其余字段',
  );
  console.log('✅ loadOAuthToken：缺失 / 坏 JSON / 字段异常 / 正常返回');
}

async function run() {
  await testNoTokenUnavailable();
  await testHttpErrors();
  await testNetworkAndTimeoutErrors();
  await testOkFullPayload();
  await testWalletEdges();
  await testMissingFields();
  await testRequestAssertions();
  testLoadOAuthToken();
  console.log('\n全部 managed-usage 测试通过');
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
