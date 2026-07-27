// acp-client 模块单元测试
// 用法：node test-acp-client.js
// 可选真实 CLI 冒烟：KIMI_ACP_SMOKE=1 node test-acp-client.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-acp-test-'));
const { AcpClient, FrameParser, encodeMessage } = require('../src/main/acp-client');

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
// session/load 校验参数形态后回 configOptions（'missing-session' 回 -32603，'need-auth' 回 -32000）；
// session/resume 推 available_commands_update 后回 configOptions（第五次探测实测形态）；
// session/list 无 cursor 回 2 条+nextCursor='p2'，cursor='p2' 回 1 条无 nextCursor；
// session/set_model 校验 modelId 参数名后回 {} 并推 config_option_update；
// session/set_mode 校验 modeId 参数名（'plan' 回 -32603 'Already in plan mode'，复刻 0.29.0 误报）；
// authenticate 校验 camelCase methodId（snake_case method_id 直接 fail；'bogus' 回 -32602）；
// session/set_config_option 校验参数形态后回更新后 configOptions（mode->plan 回 -32603）；
// session/cancel（无 id 通知）回推一条 cancel_seen 的 session/update。
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
    } else if (msg.method === 'session/load') {
      const p = msg.params || {};
      if (typeof p.sessionId !== 'string' || typeof p.cwd !== 'string' || !Array.isArray(p.mcpServers)) fail('session/load 参数形态不对: ' + JSON.stringify(msg));
      if (p.sessionId === 'need-auth') {
        // 第五次探测实测：未登录会话操作回 -32000 Authentication required
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } });
      } else if (p.sessionId === 'missing-session') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error', data: { details: 'Session not found' } } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{ type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'kimi-code/k3', options: [{ value: 'kimi-code/k3', name: 'K3' }] }] } });
      }
    } else if (msg.method === 'session/resume') {
      const p = msg.params || {};
      if (typeof p.sessionId !== 'string' || typeof p.cwd !== 'string' || !Array.isArray(p.mcpServers)) fail('session/resume 参数形态不对: ' + JSON.stringify(msg));
      // 第五次探测实测：resume 仅推 available_commands_update，响应仅含 configOptions
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact context' }] } } });
      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{ type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', options: [] }] } });
    } else if (msg.method === 'session/list') {
      const p = msg.params || {};
      if (p.cursor !== undefined && typeof p.cursor !== 'string') fail('session/list cursor 形态不对: ' + JSON.stringify(msg));
      if (p.cursor === 'p2') {
        send({ jsonrpc: '2.0', id: msg.id, result: { sessions: [{ sessionId: 's3', cwd: '/c', title: '第三页会话', updatedAt: '2026-07-27T03:00:00Z' }] } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: { sessions: [
          { sessionId: 's1', cwd: '/a', title: '会话一', updatedAt: '2026-07-27T01:00:00Z' },
          { sessionId: 's2', cwd: '/b', title: '会话二', updatedAt: '2026-07-27T02:00:00Z' },
        ], nextCursor: 'p2' } });
      }
    } else if (msg.method === 'session/set_model') {
      const p = msg.params || {};
      // 第五次探测实测：参数名 modelId（camelCase）；result {} + config_option_update 推送
      if (typeof p.sessionId !== 'string' || typeof p.modelId !== 'string') fail('session/set_model 参数形态不对（参数名必须是 modelId）: ' + JSON.stringify(msg));
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: [{ type: 'select', id: 'model', currentValue: p.modelId, options: [] }] } } });
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'session/set_mode') {
      const p = msg.params || {};
      // 第五次探测实测：参数名 modeId；0.29.0 切 plan 误报 "Already in plan mode"（-32603）
      if (typeof p.sessionId !== 'string' || typeof p.modeId !== 'string') fail('session/set_mode 参数形态不对（参数名必须是 modeId）: ' + JSON.stringify(msg));
      if (p.modeId === 'plan') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error', data: { details: 'Already in plan mode' } } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    } else if (msg.method === 'authenticate') {
      const p = msg.params || {};
      // 第五次探测实测：参数名 camelCase methodId（snake_case method_id 系文档笔误，收到即 fail）
      if (p.method_id !== undefined) fail('authenticate 收到 snake_case method_id（必须 camelCase methodId）: ' + JSON.stringify(msg));
      if (typeof p.methodId !== 'string') fail('authenticate 参数形态不对: ' + JSON.stringify(msg));
      if (p.methodId === 'bogus') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: Unknown auth method: bogus', data: { methodId: 'bogus' } } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    } else if (msg.method === 'session/set_config_option') {
      const p = msg.params || {};
      if (typeof p.sessionId !== 'string' || typeof p.configId !== 'string' || typeof p.value !== 'string') fail('session/set_config_option 参数形态不对: ' + JSON.stringify(msg));
      if (p.configId === 'mode' && p.value === 'plan') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error', data: { details: 'Already in plan mode' } } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{ type: 'select', id: p.configId, name: p.configId, category: 'model', currentValue: p.value, options: [] }] } });
      }
    } else if (msg.method === 'session/cancel') {
      // 无 id 通知：回推一条 update 供客户端确认送达
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: (msg.params || {}).sessionId, update: { sessionUpdate: 'cancel_seen' } } });
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

// ---------- 6.5 loadSession / setConfigOption / cancel ----------
async function testLoadSession() {
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  await client.start();
  // 非法入参拒绝（不发请求）
  await assert.rejects(client.loadSession(''), /sessionId/);
  await assert.rejects(client.loadSession(123), /sessionId/);
  // 成功：resolve 完整 result（仅含 configOptions），sessionId 用入参设置（无回显）
  const result = await client.loadSession('old-session');
  assert.ok(Array.isArray(result.configOptions));
  assert.strictEqual(result.configOptions[0].id, 'model');
  assert.strictEqual(result.configOptions[0].currentValue, 'kimi-code/k3');
  assert.strictEqual(client.sessionId, 'old-session');
  // 请求方法名与参数形态（cwd/mcpServers）由假服务端 fail() 断言
  // JSON-RPC 错误上抛（err.code 透传），且不覆盖已有 sessionId
  await assert.rejects(client.loadSession('missing-session'), (e) => e.code === -32603 && /Internal error/.test(e.message));
  assert.strictEqual(client.sessionId, 'old-session');
  client.dispose('loadSession 测试结束');
  console.log('✅ loadSession() 参数形态 / 成功置 sessionId / 错误上抛不覆盖 / 空 sessionId 拒绝');
}

async function testSetConfigOption() {
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  await client.start();
  // 无会话时拒绝
  await assert.rejects(client.setConfigOption('model', 'kimi-code/k3'), /尚未建立会话/);
  await client.newSession();
  // 非法入参拒绝（非字符串 / 空 / 超 200 字符）
  await assert.rejects(client.setConfigOption('', 'x'), /configId/);
  await assert.rejects(client.setConfigOption(1, 'x'), /configId/);
  await assert.rejects(client.setConfigOption('model', ''), /value/);
  await assert.rejects(client.setConfigOption('model', 'x'.repeat(201)), /value/);
  // 成功：resolve 完整 result，configOptions 为更新后的完整数组
  const result = await client.setConfigOption('model', 'kimi-code/kimi-for-coding');
  assert.ok(Array.isArray(result.configOptions));
  assert.strictEqual(result.configOptions[0].currentValue, 'kimi-code/kimi-for-coding');
  // JSON-RPC 错误上抛（探测实录：mode->plan 回 -32603）
  await assert.rejects(client.setConfigOption('mode', 'plan'), (e) => e.code === -32603 && /Internal error/.test(e.message));
  client.dispose('setConfigOption 测试结束');
  console.log('✅ setConfigOption() 参数形态 / 成功 resolve configOptions / 无会话与非法入参拒绝 / 错误上抛');
}

async function testCancel() {
  // 白盒：stub _write 捕获写出的通知（不起子进程）
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  client.cancel(); // 无会话：静默 no-op，不写也不抛
  client.sessionId = 's-cancel';
  const written = [];
  client._write = (obj) => written.push(obj);
  const ret = client.cancel();
  assert.strictEqual(ret, undefined); // 同步返回，不返回 Promise
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].jsonrpc, '2.0');
  assert.strictEqual(written[0].method, 'session/cancel');
  assert.deepStrictEqual(written[0].params, { sessionId: 's-cancel' });
  assert.strictEqual(written[0].id, undefined); // JSON-RPC 通知：无 id
  assert.strictEqual(client.pending.size, 0); // 不进 pending，无响应配对
  // 子进程不可写：只记日志不抛异常
  const logs = [];
  const client2 = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: (m) => logs.push(m) });
  client2.sessionId = 's2';
  client2.cancel(); // child 为 null → _write throw → 被吞掉
  assert.ok(logs.some((m) => m.includes('session/cancel')));
  console.log('✅ cancel() 发无 id 通知 / 不占 pending / 无会话 no-op / 子进程不可用只记日志');

  // 回环：通知经真实分帧送达假服务端，收到回推的 cancel_seen
  const client3 = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  const updates = [];
  client3.on('update', (u) => updates.push(u));
  await client3.start();
  await client3.newSession();
  client3.cancel();
  for (let i = 0; i < 100 && !updates.some((u) => u && u.sessionUpdate === 'cancel_seen'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(updates.some((u) => u && u.sessionUpdate === 'cancel_seen'));
  client3.dispose('cancel 回环测试结束');
  console.log('✅ cancel() 回环：通知送达假服务端并收到 cancel_seen 回推');
}

// ---------- 6.6 第五次探测补齐：listSessions / resumeSession / setModel / setMode / authenticate+authRequired ----------
async function testListSessions() {
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  await client.start();
  // 首页：2 条 + nextCursor='p2'（字段形态按第五次探测实测：sessionId/cwd/title/updatedAt）
  const page1 = await client.listSessions();
  assert.strictEqual(page1.sessions.length, 2);
  assert.deepStrictEqual(page1.sessions.map((s) => s.sessionId), ['s1', 's2']);
  assert.strictEqual(page1.sessions[0].title, '会话一');
  assert.strictEqual(page1.nextCursor, 'p2');
  // 翻页：cursor 透传，1 条且无 nextCursor（末页归一化为 null）
  const page2 = await client.listSessions('p2');
  assert.strictEqual(page2.sessions.length, 1);
  assert.strictEqual(page2.sessions[0].sessionId, 's3');
  assert.strictEqual(page2.nextCursor, null);
  client.dispose('listSessions 测试结束');
  console.log('✅ listSessions() 首页字段/分页游标透传/末页 nextCursor 归一化 null');
}

async function testResumeSession() {
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  const updates = [];
  client.on('update', (u) => updates.push(u));
  await client.start();
  // 非法入参拒绝（不发请求）
  await assert.rejects(client.resumeSession(''), /sessionId/);
  await assert.rejects(client.resumeSession(123), /sessionId/);
  // 成功：resolve result（仅含 configOptions），sessionId 用入参设置
  const result = await client.resumeSession('old-session');
  assert.ok(Array.isArray(result.configOptions));
  assert.strictEqual(client.sessionId, 'old-session');
  // 实测形态：resume 推 available_commands_update（等它到达）
  for (let i = 0; i < 100 && !updates.some((u) => u && u.sessionUpdate === 'available_commands_update'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(updates.some((u) => u && u.sessionUpdate === 'available_commands_update'));
  client.dispose('resumeSession 测试结束');
  console.log('✅ resumeSession() 参数形态 / 成功置 sessionId / 推 available_commands_update / 非法入参拒绝');
}

async function testSetModelSetMode() {
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  const updates = [];
  client.on('update', (u) => updates.push(u));
  await client.start();
  // 无会话时拒绝
  await assert.rejects(client.setModel('kimi-code/k3'), /尚未建立会话/);
  await assert.rejects(client.setMode('default'), /尚未建立会话/);
  await client.newSession();
  // 非法入参拒绝
  await assert.rejects(client.setModel(''), /modelId/);
  await assert.rejects(client.setModel(1), /modelId/);
  await assert.rejects(client.setMode(''), /modeId/);
  await assert.rejects(client.setMode('x'.repeat(201)), /modeId/);
  // setModel 成功：result {}，随后收到 config_option_update 推送（参数名 modelId 由假服务端 fail() 断言）
  const r1 = await client.setModel('kimi-code/k3');
  assert.deepStrictEqual(r1, {});
  for (let i = 0; i < 100 && !updates.some((u) => u && u.sessionUpdate === 'config_option_update'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(updates.some((u) => u && u.sessionUpdate === 'config_option_update'));
  // setMode('plan')：复刻 0.29.0 误报形态（-32603 Internal error，details 含 'Already in plan mode'）上抛，err.code 透传
  await assert.rejects(client.setMode('plan'), (e) => e.code === -32603 && /Internal error/.test(e.message));
  // setMode('default') 成功（参数名 modeId 由假服务端 fail() 断言）
  const r2 = await client.setMode('default');
  assert.deepStrictEqual(r2, {});
  client.dispose('setModel/setMode 测试结束');
  console.log('✅ setModel()/setMode() 参数形态 / modelId/modeId 参数名 / -32603 误报上抛 / 无会话与非法入参拒绝');
}

async function testAuthenticateAuthRequired() {
  const client = new AcpClient({ cliPath: process.execPath, cwd: tmpDir, logFn: () => {} });
  const authEvents = [];
  client.on('authRequired', (info) => authEvents.push(info));
  await client.start();
  // -32000：loadSession('need-auth') reject 且补发 authRequired 事件（含触发方法与原始错误）
  await assert.rejects(client.loadSession('need-auth'), (e) => e.code === -32000 && /Authentication required/.test(e.message));
  assert.strictEqual(authEvents.length, 1);
  assert.strictEqual(authEvents[0].method, 'session/load');
  assert.strictEqual(authEvents[0].error.code, -32000);
  // authenticate('login') 成功（camelCase methodId 由假服务端 fail() 断言）
  const r = await client.authenticate('login');
  assert.deepStrictEqual(r, {});
  // authenticate('bogus') → -32602（不触发 authRequired）
  await assert.rejects(client.authenticate('bogus'), (e) => e.code === -32602 && /Unknown auth method/.test(e.message));
  assert.strictEqual(authEvents.length, 1);
  // 非法入参拒绝
  await assert.rejects(client.authenticate(''), /methodId/);
  await assert.rejects(client.authenticate(1), /methodId/);
  client.dispose('authenticate/authRequired 测试结束');
  console.log('✅ authenticate() methodId 参数名 / bogus -32602 / -32000 补发 authRequired 事件且不重复触发');
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
    // 第五次探测补齐方法的真实冒烟：listSessions/resumeSession/setModel/setMode
    const list = await client.listSessions();
    assert.ok(Array.isArray(list.sessions), 'listSessions.sessions 必须是数组');
    assert.ok(list.sessions.length >= 1, '真实环境至少存在刚创建的会话');
    assert.ok(list.sessions.every((s) => typeof s.sessionId === 'string' && typeof s.cwd === 'string'), '会话条目缺 sessionId/cwd 字段');
    console.log(`✅ 真实 CLI 冒烟：listSessions 返回 ${list.sessions.length} 条（nextCursor=${list.nextCursor}）`);
    const newSid = client.sessionId;
    const resumeResult = await client.resumeSession(newSid);
    assert.ok(resumeResult && Array.isArray(resumeResult.configOptions), 'resumeSession 应返回 configOptions 数组');
    assert.strictEqual(client.sessionId, newSid);
    console.log('✅ 真实 CLI 冒烟：resumeSession 恢复当前会话（configOptions 回显）');
    await client.setModel('kimi-code/k3');
    console.log('✅ 真实 CLI 冒烟：setModel(kimi-code/k3) 成功');
    try {
      await client.setMode('default');
      console.log('✅ 真实 CLI 冒烟：setMode(default) 成功');
    } catch (e) {
      // 0.29.0 mode 切换状态错乱误报（第五次探测实测）：不视为失败，记录即可
      console.log(`⚠️ 真实 CLI 冒烟：setMode(default) 返回错误（0.29.0 已知误报，容忍）: ${e.message}`);
    }
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
    await testLoadSession();
    await testSetConfigOption();
    await testCancel();
    await testListSessions();
    await testResumeSession();
    await testSetModelSetMode();
    await testAuthenticateAuthRequired();
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
