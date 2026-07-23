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
// session/prompt 先推 3 条 session/update，再发 id=999 的 request_permission
// 与 id=998 的未知方法请求，断言客户端应答正确后才回 prompt 响应。
const FAKE_ACP_SERVER = `
'use strict';
let buf = '';
let promptId = null;
const done = { perm: false, unknown: false };
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function fail(msg) { process.stderr.write('FAKE-SERVER-ASSERT: ' + msg + '\\n'); process.exit(3); }
function maybeFinish() {
  if (promptId !== null && done.perm && done.unknown) {
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    promptId = null;
  }
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
      for (const t of ['a', 'b', 'c']) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
      }
      send({ jsonrpc: '2.0', id: 999, method: 'session/request_permission', params: { sessionId: msg.params.sessionId, toolCall: { toolCallId: 'tc-1', title: 'fake tool' }, options: [] } });
      send({ jsonrpc: '2.0', id: 998, method: 'fs/read_text_file', params: { path: '/x' } });
    } else if (msg.id === 999) {
      if (!msg.result || !msg.result.outcome || msg.result.outcome.outcome !== 'cancelled') fail('request_permission 响应不是 cancelled: ' + JSON.stringify(msg));
      done.perm = true;
      maybeFinish();
    } else if (msg.id === 998) {
      if (!msg.error || msg.error.code !== -32601) fail('未知方法未回 -32601: ' + JSON.stringify(msg));
      done.unknown = true;
      maybeFinish();
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

  const result = await client.prompt('打招呼');
  assert.strictEqual(result.stopReason, 'end_turn');
  assert.strictEqual(updates.length, 3);
  assert.strictEqual(updates.map((u) => u.content.text).join(''), 'abc');
  assert.ok(updates.every((u) => u.sessionUpdate === 'agent_message_chunk'));
  assert.strictEqual(permissions.length, 1);
  assert.strictEqual(permissions[0].toolCall.toolCallId, 'tc-1');
  // 假服务端内部已断言：request_permission 收到 cancelled、未知方法收到 -32601
  console.log('✅ 回环 prompt() end_turn / update×3 拼出 abc / permission×1 / cancelled 与 -32601 应答');

  client.dispose('回环测试结束');
}

// ---------- 4. dispose ----------
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

// ---------- 5. 可选真实 CLI 冒烟（KIMI_ACP_SMOKE=1 才跑） ----------
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
    await testDispose();
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
