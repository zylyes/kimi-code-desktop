// acp-client 模块单元测试
// 用法：node test-acp-client.js
// 可选真实 CLI 冒烟：KIMI_ACP_SMOKE=1 node test-acp-client.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-acp-test-'));
const { AcpClient, FrameParser, encodeMessage } = require('./acp-client');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------- 1. FrameParser 单测 ----------
function testFrameParserNdjson() {
  const msgs = [];
  const raws = [];
  const p = new FrameParser('ndjson', (m) => msgs.push(m), (t) => raws.push(t));
  // 一条消息分两段 push（跨 chunk 边界）
  p.push(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"ok":tr'));
  assert.strictEqual(msgs.length, 0);
  p.push(Buffer.from('ue}}\n'));
  assert.strictEqual(msgs.length, 1);
  assert.deepStrictEqual(msgs[0].result, { ok: true });
  // \r\n 行尾 + 空行跳过
  p.push(Buffer.from('\n\r\n{"id":2,"method":"x"}\r\n'));
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[1].method, 'x');
  assert.strictEqual(raws.length, 0);
  // 非法 JSON 走 onRaw
  p.push(Buffer.from('这不是JSON\n'));
  assert.strictEqual(raws.length, 1);
  assert.strictEqual(raws[0], '这不是JSON');
  console.log('✅ FrameParser ndjson（跨 chunk / \\r\\n 行尾 / 空行跳过 / 非法 JSON 走 onRaw）');
}

function testFrameParserLsp() {
  const msgs = [];
  const raws = [];
  const p = new FrameParser('lsp', (m) => msgs.push(m), (t) => raws.push(t));
  // 正常分帧 + header 只到一半
  const body1 = JSON.stringify({ jsonrpc: '2.0', id: 7, result: 42 });
  const full1 = `Content-Length: ${Buffer.byteLength(body1)}\r\n\r\n${body1}`;
  const headerEnd = full1.indexOf('\r\n\r\n');
  p.push(Buffer.from(full1.slice(0, headerEnd + 2))); // header 只到一半（缺结尾 \r\n）
  assert.strictEqual(msgs.length, 0);
  p.push(Buffer.from(full1.slice(headerEnd + 2)));
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].result, 42);
  // body 只到一半（按字节切在多字节字符中间，验证字节缓冲）
  const body2 = JSON.stringify({ a: '正文' });
  const head2 = `Content-Length: ${Buffer.byteLength(body2)}\r\n\r\n`;
  p.push(Buffer.from(head2));
  const body2Buf = Buffer.from(body2);
  p.push(body2Buf.subarray(0, 3));
  assert.strictEqual(msgs.length, 1);
  p.push(body2Buf.subarray(3));
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[1].a, '正文');
  // 无 Content-Length 头走 onRaw
  p.push(Buffer.from('X-Other: 1\r\n\r\n'));
  assert.strictEqual(raws.length, 1);
  assert.ok(raws[0].includes('X-Other'));
  console.log('✅ FrameParser LSP（正常分帧 / header 半包 / body 半包 / 无长度头走 onRaw）');
}

// ---------- 2. encodeMessage 两种分帧往返 ----------
function testEncodeRoundtrip() {
  for (const framing of ['ndjson', 'lsp']) {
    const msg = { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: 'D:\\x', mcpServers: [] } };
    const data = encodeMessage(msg, framing);
    const got = [];
    const p = new FrameParser(framing, (m) => got.push(m), () => assert.fail('不应走 onRaw'));
    // 刻意逐字节 push，验证分帧健壮性后再比较相等
    for (let i = 0; i < data.length; i++) p.push(data.subarray(i, i + 1));
    assert.strictEqual(got.length, 1);
    assert.deepStrictEqual(got[0], msg);
  }
  console.log('✅ encodeMessage 两种分帧往返一致');
}

// ---------- 3. 回环假 ACP 服务端端到端 ----------
// 假服务端：按行读 stdin 的 JSON-RPC，initialize/session/new 直接回结果；
// session/prompt 先推 3 条 session/update，再按 prompt 文本分发权限场景：
//   默认     → id=999 空 options 权限请求（期待 cancelled）+ id=998 未知方法（期待 -32601）
//   '第二轮' → id=997 带 allow/deny 选项的权限请求（期待 selected allow）
// 当前 prompt 期待的应答全部到齐后才回 prompt 响应。
const FAKE_ACP_SERVER = `
'use strict';
let buf = '';
let promptId = null;
let pendingAcks = 0; // 当前 prompt 还在等待的客户端应答数
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function fail(msg) { process.stderr.write('FAKE-SERVER-ASSERT: ' + msg + '\\n'); process.exit(3); }
function ack() { pendingAcks--; maybeFinish(); }
function maybeFinish() {
  if (promptId !== null && pendingAcks === 0) {
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    promptId = null;
  }
}
function isCancelled(msg) {
  return msg.result && msg.result.outcome && msg.result.outcome.outcome === 'cancelled';
}
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  for (;;) {
    const idx = buf.indexOf('\\n');
    if (idx < 0) break;
    const line = buf.slice(0, idx).replace(/\\r$/, '');
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake', version: '0.0.0' }, agentCapabilities: { loadSession: true } } });
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fake-s1', configOptions: {} } });
    } else if (msg.method === 'session/prompt') {
      promptId = msg.id;
      const text = (msg.params.prompt[0] && msg.params.prompt[0].text) || '';
      for (const t of ['a', 'b', 'c']) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
      }
      if (text === '第二轮') {
        pendingAcks = 1;
        send({ jsonrpc: '2.0', id: 997, method: 'session/request_permission', params: { sessionId: msg.params.sessionId, toolCall: { toolCallId: 'tc-2', title: 'fake tool（带选项）', kind: 'execute' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
      } else {
        pendingAcks = 2;
        send({ jsonrpc: '2.0', id: 999, method: 'session/request_permission', params: { sessionId: msg.params.sessionId, toolCall: { toolCallId: 'tc-1', title: 'fake tool' }, options: [] } });
        send({ jsonrpc: '2.0', id: 998, method: 'fs/read_text_file', params: { path: '/x' } });
      }
    } else if (msg.id === 999) {
      if (!isCancelled(msg)) fail('request_permission(999) 响应不是 cancelled: ' + JSON.stringify(msg));
      ack();
    } else if (msg.id === 997) {
      const o = msg.result && msg.result.outcome;
      if (!o || o.outcome !== 'selected' || o.optionId !== 'allow') fail('request_permission(997) 响应不是 selected allow: ' + JSON.stringify(msg));
      ack();
    } else if (msg.id === 998) {
      if (!msg.error || msg.error.code !== -32601) fail('未知方法未回 -32601: ' + JSON.stringify(msg));
      ack();
    }
  }
});
`;

async function testLoopback() {
  const updates = [];
  const permissions = [];
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  client.on('update', (u) => updates.push(u));
  client.on('permission', (p) => permissions.push(p));

  const init = await client.start();
  assert.strictEqual(init.protocolVersion, 1);
  assert.deepStrictEqual(init.agentInfo, { name: 'fake', version: '0.0.0' });
  assert.strictEqual(init.agentCapabilities.loadSession, true);
  console.log('✅ 回环 start() 拿到假 agentInfo');

  const session = await client.newSession();
  assert.strictEqual(session.sessionId, 'fake-s1');
  assert.deepStrictEqual(session.configOptions, {});
  console.log('✅ 回环 newSession() 拿到 fake-s1');

  // 第一轮：不设 handler，权限请求应被自动 cancelled（只读安全基线）
  const result = await client.prompt('打招呼');
  assert.strictEqual(result.stopReason, 'end_turn');
  assert.strictEqual(updates.length, 3);
  assert.strictEqual(updates.map((u) => u.content.text).join(''), 'abc');
  assert.ok(updates.every((u) => u.sessionUpdate === 'agent_message_chunk'));
  assert.strictEqual(permissions.length, 1);
  assert.strictEqual(permissions[0].toolCall.toolCallId, 'tc-1');
  // 假服务端内部已断言：request_permission(999) 收到 cancelled、未知方法(998) 收到 -32601
  console.log('✅ 回环 prompt() end_turn / update×3 拼出 abc / 未设 handler 自动 cancelled / -32601 应答');

  // 第二轮：设置 handler 后，带 allow/deny 选项的权限请求按 handler 决策放行 allow
  client.setPermissionHandler(async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }));
  const result2 = await client.prompt('第二轮');
  assert.strictEqual(result2.stopReason, 'end_turn');
  assert.strictEqual(updates.length, 6);
  assert.strictEqual(permissions.length, 2); // handler 路径同样 emit 'permission'
  assert.strictEqual(permissions[1].toolCall.toolCallId, 'tc-2');
  assert.deepStrictEqual(permissions[1].options.map((o) => o.optionId), ['allow', 'deny']);
  // 假服务端内部已断言：request_permission(997) 收到 { outcome: { outcome: 'selected', optionId: 'allow' } }
  console.log('✅ 回环 handler 决策：request_permission(997) 应答 selected allow，permission 事件仍 emit');

  client.dispose('回环测试结束');
}

// ---------- 4. 权限决策异常路径（白盒：stub _sendResult 捕获应答，不起子进程） ----------
const PERMISSION_MSG = {
  jsonrpc: '2.0',
  id: 1,
  method: 'session/request_permission',
  params: {
    sessionId: 's',
    toolCall: { toolCallId: 'tc-x', title: 'x' },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  },
};

function makeDecisionClient(handler) {
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  if (handler) client.setPermissionHandler(handler);
  const sent = [];
  client._sendResult = (id, result) => sent.push({ id, result });
  return { client, sent };
}

// 等两拍，让 _onPermissionRequest 里的 Promise 决策链跑完
async function tick() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

async function testPermissionInvalidOption() {
  // handler 返回不在 options 内的 optionId → 降级 cancelled
  const { client, sent } = makeDecisionClient(async () => ({ outcome: { outcome: 'selected', optionId: 'root' } }));
  client._onServerRequest(PERMISSION_MSG);
  await tick();
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].result, { outcome: { outcome: 'cancelled' } });
  assert.strictEqual(client._pendingPermissions.size, 0);
  console.log('✅ 权限决策 optionId 越界 → 降级 cancelled');
}

async function testPermissionHandlerThrows() {
  // handler 同步抛异常 → cancelled
  const { client, sent } = makeDecisionClient(() => { throw new Error('炸了'); });
  client._onServerRequest(PERMISSION_MSG);
  await tick();
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].result, { outcome: { outcome: 'cancelled' } });
  // handler 返回非法结构 → cancelled
  const bad = makeDecisionClient(async () => ({ outcome: '不是合法结构' }));
  bad.client._onServerRequest(PERMISSION_MSG);
  await tick();
  assert.strictEqual(bad.sent.length, 1);
  assert.deepStrictEqual(bad.sent[0].result, { outcome: { outcome: 'cancelled' } });
  console.log('✅ 权限决策回调抛异常 / 返回非法结构 → cancelled');
}

// ---------- 5. dispose ----------
async function testDispose() {
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  await client.start();
  await client.newSession();
  const p = client.prompt('会被 dispose 中断');
  p.catch(() => {}); // 防 unhandledRejection 噪音（断言在 assert.rejects 里做）
  client.dispose('测试 dispose');
  await assert.rejects(p, /dispose/);
  client.dispose('再次 dispose'); // 幂等，不抛异常
  new AcpClient({ cliPath: process.execPath, cwd: tmpDir }).dispose(); // 未 start 直接 dispose 也不抛
  console.log('✅ dispose 拒绝进行中 prompt 且幂等');
}

// ---------- 6. dispose 时挂起的权限决策按 cancelled 收尾 ----------
async function testDisposePendingPermission() {
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  await client.start();
  await client.newSession();
  // handler 永不返回：决策挂起
  let resolveDecision;
  client.setPermissionHandler(() => new Promise((r) => { resolveDecision = r; }));
  const sent = [];
  client._sendResult = (id, result) => sent.push({ id, result }); // 吞掉 999 的应答，让 prompt 挂起
  const p = client.prompt('挂起的权限决策');
  p.catch(() => {}); // 防 unhandledRejection 噪音（断言在 assert.rejects 里做）
  // 等服务端的 request_permission(999) 到达并登记为挂起决策
  for (let i = 0; i < 100 && client._pendingPermissions.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.strictEqual(client._pendingPermissions.size, 1);
  client.dispose('挂起决策收尾测试');
  // 挂起决策按 cancelled 收尾（趁子进程存活补发响应），不挂死
  assert.strictEqual(client._pendingPermissions.size, 0);
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].result, { outcome: { outcome: 'cancelled' } });
  await assert.rejects(p, /dispose/);
  // dispose 后 handler 才返回：一次性 guard 生效，不再补发响应
  resolveDecision({ outcome: { outcome: 'selected', optionId: 'allow' } });
  await tick();
  assert.strictEqual(sent.length, 1);
  console.log('✅ dispose 时挂起权限决策按 cancelled 收尾，不挂死且不重复响应');
}

// ---------- 7. 可选真实 CLI 冒烟（KIMI_ACP_SMOKE=1 才跑） ----------
async function testSmoke() {
  if (process.env.KIMI_ACP_SMOKE !== '1') {
    console.log('⏭️  真实 CLI 冒烟跳过（设 KIMI_ACP_SMOKE=1 启用）');
    return;
  }
  const exe = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
  const candidates = [
    path.join(os.homedir(), '.kimi-code', 'bin', exe),
    path.join(os.homedir(), '.kimi', 'bin', exe),
  ];
  const cliPath = candidates.find((p) => fs.existsSync(p));
  if (!cliPath) {
    console.log('⏭️  真实 CLI 冒烟跳过（候选路径均不存在）');
    return;
  }
  console.log(`真实 CLI 冒烟: ${cliPath}`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-client-smoke-'));
  const client = new AcpClient({ cliPath, cwd: workDir, logFn: (m) => console.log(`  [acp] ${m}`) });
  let agentText = '';
  client.on('update', (u) => {
    if (u && u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      agentText += u.content.text || '';
    }
  });
  try {
    await client.start();
    await client.newSession();
    const result = await client.prompt('Reply with exactly: ACP-CLIENT-OK');
    assert.strictEqual(result.stopReason, 'end_turn');
    assert.ok(agentText.includes('ACP-CLIENT-OK'), `agent 文本未含口令: ${agentText.slice(0, 200)}`);
    console.log('✅ 真实 CLI 冒烟（start → newSession → prompt，口令回显）');
  } finally {
    client.dispose('冒烟结束');
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------- 主流程 ----------
async function run() {
  console.log('测试目录:', tmpDir);

  testFrameParserNdjson();
  testFrameParserLsp();
  testEncodeRoundtrip();

  // 回环假服务端：AcpClient 固定以 [cliPath, 'acp'] 启动子进程，
  // 在临时目录放一个名为 acp 的 Node 脚本并 chdir 过去，让 `node acp` 解析到它
  fs.writeFileSync(path.join(tmpDir, 'acp'), FAKE_ACP_SERVER, 'utf8');
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await testLoopback();
    await testPermissionInvalidOption();
    await testPermissionHandlerThrows();
    await testDispose();
    await testDisposePendingPermission();
  } finally {
    process.chdir(oldCwd);
  }

  await testSmoke();

  console.log('\n全部 acp-client 测试通过');
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
