// 会话导出模块单元测试
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-export-test-'));
const sessionExport = require('./session-export');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// 构造一个会话目录：agents/main/wire.jsonl + 一个子 Agent + tasks/
function makeSession(name, wireLines, extra) {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), wireLines.join('\n'), 'utf8');
  if (extra) extra(dir);
  return dir;
}

function run() {
  console.log('测试目录:', tmpDir);

  // 1. 标准 wire.jsonl：append_message 提取 user/assistant + 工具调用摘要 + 损坏行跳过
  const lines = [
    JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1784727526886 }),
    JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: '你好' }], time: 1784727527000 }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '你好' }], toolCalls: [], id: 'm1' }, time: 1784727527001 }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: '你好！' }, { type: 'think', think: '思考中' }], toolCalls: [{ name: 'Read' }, { name: 'Edit' }], id: 'm2' }, time: 1784727528000 }),
    '{这不是合法JSON',
    JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin' }, time: 1784727528100 }),
  ];
  const dir1 = makeSession('s1', lines);
  const parsed = sessionExport.readJsonl(path.join(dir1, 'agents', 'main', 'wire.jsonl'));
  assert.strictEqual(parsed.events.length, 5);
  assert.strictEqual(parsed.badLines, 1);
  console.log('✅ JSONL 解析与损坏行统计');

  const messages = sessionExport.extractMessages(parsed.events);
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].role, 'user');
  assert.strictEqual(messages[0].text, '你好');
  assert.strictEqual(messages[1].role, 'assistant');
  assert.strictEqual(messages[1].text, '你好！');
  assert.deepStrictEqual(messages[1].toolCalls, ['Read', 'Edit']);
  console.log('✅ 消息提取（append_message 优先，think 部件跳过）');

  // 2. Markdown 渲染
  const md = sessionExport.renderMarkdown({ title: '测试会话', sessionId: 'abc', workDir: 'D:\\x' }, messages);
  assert.ok(md.includes('# 测试会话'));
  assert.ok(md.includes('- 会话 ID：`abc`'));
  assert.ok(md.includes('## 用户'));
  assert.ok(md.includes('## 助手'));
  assert.ok(md.includes('工具调用（2）：Read、Edit'));
  console.log('✅ Markdown 渲染');

  // 3. exportSessionMarkdown 端到端
  const exp = sessionExport.exportSessionMarkdown(dir1, { title: 's1', sessionId: 's1' });
  assert.strictEqual(exp.ok, true);
  assert.strictEqual(exp.messageCount, 2);
  assert.strictEqual(exp.badLines, 1);
  console.log('✅ 导出端到端');

  // 4. 回退路径：无 append_message 时用 turn.prompt
  const dir2 = makeSession('s2', [
    JSON.stringify({ type: 'metadata' }),
    JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: '仅 prompt' }], time: 1 }),
  ]);
  const exp2 = sessionExport.exportSessionMarkdown(dir2, {});
  assert.strictEqual(exp2.ok, true);
  assert.strictEqual(exp2.messageCount, 1);
  assert.strictEqual(exp2.messages, undefined);
  assert.ok(exp2.markdown.includes('仅 prompt'));
  console.log('✅ turn.prompt 回退');

  // 5. 错误分支：目录不存在 / 无 wire.jsonl / 无消息
  assert.strictEqual(sessionExport.exportSessionMarkdown(path.join(tmpDir, 'nope'), {}).ok, false);
  const dir3 = path.join(tmpDir, 's3');
  fs.mkdirSync(dir3, { recursive: true });
  assert.strictEqual(sessionExport.exportSessionMarkdown(dir3, {}).ok, false);
  const dir4 = makeSession('s4', [JSON.stringify({ type: 'metadata' })]);
  const exp4 = sessionExport.exportSessionMarkdown(dir4, {});
  assert.strictEqual(exp4.ok, false);
  assert.ok(/没有可导出/.test(exp4.error));
  console.log('✅ 错误分支');

  // 6. scanSubagents：main + 子 Agent + tasks/
  const dir5 = makeSession('s5', lines, (dir) => {
    fs.mkdirSync(path.join(dir, 'agents', 'sub-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', 'sub-1', 'wire.jsonl'), [
      JSON.stringify({ type: 'metadata' }),
      JSON.stringify({ type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: '子任务回复' }] }, time: 1784727530000 }),
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks', 't1.json'), JSON.stringify({ id: 't1', status: 'completed', description: '后台任务' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'tasks', 'bad.json'), '{损坏', 'utf8');
  });
  const scan = sessionExport.scanSubagents(dir5);
  assert.strictEqual(scan.ok, true);
  assert.strictEqual(scan.agents.length, 2);
  const main = scan.agents.find((a) => a.id === 'main');
  const sub = scan.agents.find((a) => a.id === 'sub-1');
  assert.strictEqual(main.isMain, true);
  assert.strictEqual(sub.isMain, false);
  assert.strictEqual(main.messageCount, 2);
  assert.strictEqual(sub.messageCount, 1);
  assert.strictEqual(sub.firstTime, 1784727530000);
  assert.strictEqual(scan.tasks.length, 1);
  assert.strictEqual(scan.tasks[0].status, 'completed');
  console.log('✅ 子 Agent 与 tasks 扫描');

  // 7. scanSubagents 容错：目录不存在
  const scanBad = sessionExport.scanSubagents(path.join(tmpDir, 'nope'));
  assert.strictEqual(scanBad.ok, false);
  assert.deepStrictEqual(scanBad.agents, []);
  console.log('✅ scanSubagents 容错');

  console.log('\n全部 session-export 测试通过');
}

try {
  run();
} finally {
  cleanup();
}
