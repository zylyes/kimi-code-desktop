// 主进程规范化状态层单元测试：normalizer + RuntimeState
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { normalizeWsEvent, normalizeAcpToolCall, normalizeAcpCatalogEvent, normalizeDiskTask } = require('../src/main/runtime-event-normalizer');
const RuntimeState = require('../src/main/runtime-state');

function load(rel) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf8'));
}
function ws(obj) { return normalizeWsEvent(obj); }
function rawWs(event, payload, extra) {
  return Object.assign({ event, payload }, extra || {});
}

function run() {
  const wsEvents = load('tasks/task-events-ws.json');
  const usageEvents = load('usage/usage-updated-ws.json');
  const agentSeq = load('acp/tool-call-agent.json');
  const readSeq = load('acp/tool-call-read.json');

  // ---------- 1. normalizer：WS task 事件（fixture 驱动） ----------
  const e1 = ws(wsEvents[0]);
  assert.strictEqual(e1.source, 'ws');
  assert.strictEqual(e1.kind, 'task.started');
  assert.strictEqual(e1.status, 'running');
  assert.strictEqual(e1.sessionId, null);
  assert.strictEqual(e1.taskId, 't1');
  assert.strictEqual(e1.title, '构建项目');
  assert.strictEqual(e1.confidence, 'high');
  assert.ok(typeof e1.at === 'number' && e1.at > 0);
  assert.strictEqual(e1.rawKind, 'event.task.started');
  assert.strictEqual(e1.usage, null);
  assert.strictEqual(e1.agentType, null);

  const e2 = ws(wsEvents[1]);
  assert.strictEqual(e2.kind, 'task.progress');
  assert.strictEqual(e2.status, 'running');

  const e3 = ws(wsEvents[3]);
  assert.strictEqual(e3.kind, 'task.completed');
  assert.strictEqual(e3.status, 'completed');

  // 无 event. 前缀变体
  const noPrefix = ws(rawWs('task.started', { task_id: 'x', title: '无前缀' }));
  assert.strictEqual(noPrefix.kind, 'task.started');
  assert.strictEqual(noPrefix.rawKind, 'task.started');
  // task.done -> completed
  assert.strictEqual(ws(rawWs('event.task.done', { task_id: 'x' })).kind, 'task.completed');
  // 无法识别 -> null
  assert.strictEqual(ws(rawWs('event.whatever', {})), null);
  assert.strictEqual(ws(null), null);
  console.log('✅ normalizer：WS task 事件');

  // ---------- 2. normalizer：usage 事件（fixture 驱动） ----------
  const u1 = ws(usageEvents[0]);
  assert.strictEqual(u1.kind, 'usage.updated');
  assert.strictEqual(u1.source, 'ws');
  assert.strictEqual(u1.status, null);
  assert.strictEqual(u1.taskId, null);
  assert.deepStrictEqual(u1.usage, { totalTokens: 12345, contextUsed: 45000, contextLimit: 128000 });

  const u2 = ws(usageEvents[1]);
  assert.deepStrictEqual(u2.usage, { totalTokens: 23456, contextUsed: 62000, contextLimit: 128000 });

  // 平铺 + totalTokens 变体
  const flat = ws(rawWs('event.session.usage_updated', { totalTokens: 500, contextUsed: 1000, contextLimit: 2000 }));
  assert.deepStrictEqual(flat.usage, { totalTokens: 500, contextUsed: 1000, contextLimit: 2000 });

  // total 缺失 -> input_tokens + output_tokens 兜底
  const fb = ws(rawWs('event.session.usage_updated', { input_tokens: 10, output_tokens: 20, context_used: 30, context_limit: 40 }));
  assert.deepStrictEqual(fb.usage, { totalTokens: 30, contextUsed: 30, contextLimit: 40 });

  // 非数字 -> 0
  const bad = ws(rawWs('event.session.usage_updated', { total_tokens: 'abc', context_used: 'x', context_limit: null }));
  assert.deepStrictEqual(bad.usage, { totalTokens: 0, contextUsed: 0, contextLimit: 0 });
  console.log('✅ normalizer：WS usage 事件');

  // ---------- 3. normalizer：ACP Agent 工具序列（fixture 驱动） ----------
  const acp = agentSeq.map((e) => normalizeAcpToolCall(e.sessionId, e.update)).filter(Boolean);
  assert.strictEqual(acp.length, 3); // tool_call + rawInput 完整片段 + completed
  assert.strictEqual(acp[0].source, 'acp');
  assert.strictEqual(acp[0].kind, 'task.observed');
  assert.strictEqual(acp[0].status, 'running'); // tool_call -> observed(running)
  assert.strictEqual(acp[0].taskId, '0:tool_eiihsvyYSWHKPDMqHnOYyD4x');
  assert.strictEqual(acp[0].title, 'Agent');
  assert.strictEqual(acp[0].agentType, null);
  assert.strictEqual(acp[0].sessionId, 'session_wd_kimi-code-desktop_7f3a2b9c4d1e5f6a8b0c2d4e');
  assert.strictEqual(acp[1].status, 'running');
  assert.strictEqual(acp[1].agentType, 'explore');
  assert.strictEqual(acp[1].title, 'Count test files via Glob'); // rawInput.description 优先
  assert.strictEqual(acp[2].status, 'completed');
  assert.strictEqual(acp[2].agentType, 'explore');
  // failed / 未知状态变体
  const failed = normalizeAcpToolCall('sid', { sessionUpdate: 'tool_call_update', toolCallId: '0:tool_x', title: 'Agent', status: 'failed' });
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(normalizeAcpToolCall('sid', { sessionUpdate: 'tool_call_update', toolCallId: '0:tool_x', title: 'Agent', status: 'weird' }), null);

  // 非 Agent 工具（fixture tool-call-read.json）-> 全部 null
  const read = readSeq.map((e) => normalizeAcpToolCall(e.sessionId, e.update)).filter(Boolean);
  assert.strictEqual(read.length, 0);
  console.log('✅ normalizer：ACP Agent/非 Agent 工具');

  // ---------- 4. state 幂等（fixture task-events-ws.json 全序列） ----------
  const st = new RuntimeState();
  let changedCount = 0;
  st.on('changed', () => { changedCount++; });
  const seq = wsEvents.map(ws);
  seq.forEach((e) => st.apply(e));
  assert.strictEqual(st.getActiveTaskCount(), 1); // t2 运行中
  assert.strictEqual(st.getActiveTaskCount(null), 1); // WS 事件无 sessionId -> null 全局桶
  const firstChanged = changedCount;
  // 重复 apply 全序列：不重复计数、无实际变化不触发 changed
  seq.forEach((e) => st.apply(e));
  assert.strictEqual(st.getActiveTaskCount(), 1);
  assert.strictEqual(changedCount, firstChanged);
  // 重复 completed：幂等，不跳数
  st.apply(ws(rawWs('event.task.completed', { task_id: 't1', title: '构建项目' })));
  assert.strictEqual(st.getActiveTaskCount(), 1);
  assert.strictEqual(changedCount, firstChanged);
  console.log('✅ state 幂等（重复 apply / 重复 completed）');

  // ---------- 5. 乱序：completed 先到 -> tombstone，不复活 ----------
  const oo = new RuntimeState();
  oo.apply(ws(rawWs('event.task.completed', { task_id: 'x1', title: '先完成' })));
  assert.strictEqual(oo.getActiveTaskCount(), 0);
  oo.apply(ws(rawWs('event.task.started', { task_id: 'x1', title: '后开始' })));
  assert.strictEqual(oo.getActiveTaskCount(), 0); // 终态不可被旧 running 观察复活
  const ooTasks = oo.getTasks({ includeTerminal: true });
  assert.strictEqual(ooTasks.length, 1);
  assert.strictEqual(ooTasks[0].status, 'completed');
  assert.strictEqual(ooTasks[0].title, '先完成'); // 终态未被覆盖
  console.log('✅ state 乱序 tombstone');

  // ---------- 6. progress 先到（无 started）：按 running 建快照 ----------
  const pp = new RuntimeState();
  pp.apply(ws(rawWs('event.task.progress', { task_id: 'p1', title: '进度先行' })));
  assert.strictEqual(pp.getActiveTaskCount(), 1);
  assert.strictEqual(pp.getTasks()[0].title, '进度先行');
  console.log('✅ state progress 先到建快照');

  // ---------- 7. 多会话：同 taskId 不同 sessionId 互不干扰 ----------
  const ms = new RuntimeState();
  ms.apply(ws(rawWs('event.task.started', { task_id: 't', title: '同 id' }, { session_id: 's1' })));
  ms.apply(ws(rawWs('event.task.started', { task_id: 't', title: '同 id' }, { session_id: 's2' })));
  ms.apply(ws(rawWs('event.task.started', { task_id: 't', title: '同 id' }))); // null 全局桶
  assert.strictEqual(ms.getActiveTaskCount(), 3);
  assert.strictEqual(ms.getActiveTaskCount('s1'), 1);
  assert.strictEqual(ms.getActiveTaskCount('s2'), 1);
  assert.strictEqual(ms.getActiveTaskCount(null), 1);
  assert.strictEqual(ms.getActiveTaskCount('s3'), 0);
  // s1 完成不影响 s2
  ms.apply(ws(rawWs('event.task.completed', { task_id: 't' }, { session_id: 's1' })));
  assert.strictEqual(ms.getActiveTaskCount(), 2);
  assert.strictEqual(ms.getActiveTaskCount('s1'), 0);
  assert.strictEqual(ms.getActiveTaskCount('s2'), 1);
  // getTasks 过滤
  const s2tasks = ms.getTasks({ sessionId: 's2' });
  assert.strictEqual(s2tasks.length, 1);
  assert.ok(s2tasks.every((t) => t.sessionId === 's2'));
  console.log('✅ state 多会话隔离');

  // ---------- 8. usage：分桶不覆盖 + 全局桶口径 ----------
  const us = new RuntimeState();
  us.apply(ws(usageEvents[0])); // sessionId null -> 全局桶
  assert.deepStrictEqual(us.getSessionUsage(null), { totalTokens: 12345, contextUsed: 45000, contextLimit: 128000 });
  us.apply(ws(usageEvents[1])); // 同桶覆盖
  assert.strictEqual(us.getUsageSnapshot().totalTokens, 23456);
  us.apply(ws(rawWs('event.session.usage_updated', { usage: { total_tokens: 777, context_used: 100, context_limit: 500 } }, { session_id: 's9' })));
  assert.strictEqual(us.getUsageSnapshot().totalTokens, 23456); // 会话桶不影响全局桶
  assert.deepStrictEqual(us.getSessionUsage('s9'), { totalTokens: 777, contextUsed: 100, contextLimit: 500 });
  assert.strictEqual(us.getSessionUsage('nope'), null);
  // 重复同值 usage -> 不触发 changed
  let usChanged = 0;
  us.on('changed', () => { usChanged++; });
  us.apply(ws(usageEvents[1]));
  assert.strictEqual(usChanged, 0);
  // 无全局桶 -> 全局桶零值口径（不回退最近会话桶）
  const us2 = new RuntimeState();
  us2.apply(ws(rawWs('event.session.usage_updated', { usage: { total_tokens: 1, context_used: 2, context_limit: 3 } }, { session_id: 'only' })));
  assert.deepStrictEqual(us2.getUsageSnapshot(), { totalTokens: 0, contextUsed: 0, contextLimit: 0, runningTasks: 0, lastTaskTitle: '' });
  console.log('✅ state usage 分桶');

  // ---------- 9. getUsageSnapshot：runningTasks / lastTaskTitle ----------
  const gs = new RuntimeState();
  gs.apply(ws(wsEvents[0])); // t1 构建项目 running
  let snap = gs.getUsageSnapshot();
  assert.strictEqual(snap.lastTaskTitle, '构建项目');
  assert.strictEqual(snap.runningTasks, 1);
  gs.apply(ws(wsEvents[4])); // t2 运行测试 running
  snap = gs.getUsageSnapshot();
  assert.strictEqual(snap.lastTaskTitle, '运行测试');
  assert.strictEqual(snap.runningTasks, 2);
  gs.apply(ws(rawWs('event.task.completed', { task_id: 't1' })));
  snap = gs.getUsageSnapshot();
  assert.strictEqual(snap.lastTaskTitle, '运行测试'); // 无 running 保留最后值
  assert.strictEqual(snap.runningTasks, 1);
  gs.apply(ws(rawWs('event.task.started', { task_id: 't9', title: '新任务' })));
  assert.strictEqual(gs.getUsageSnapshot().lastTaskTitle, '新任务');
  console.log('✅ state usage 快照派生字段');

  // ---------- 10. 'changed' 事件载荷 + 非法事件静默忽略 ----------
  const ch = new RuntimeState();
  const evs = [];
  ch.on('changed', (e) => evs.push(e));
  ch.apply(ws(rawWs('event.task.started', { task_id: 'c1', title: 'c' })));
  assert.deepStrictEqual(evs[0], { kind: 'task.started', sessionId: null });
  ch.apply(ws(usageEvents[0]));
  assert.deepStrictEqual(evs[1], { kind: 'usage.updated', sessionId: null });
  ch.apply(null);
  ch.apply({ kind: 'bogus' });
  ch.apply({});
  ch.apply('string');
  assert.strictEqual(evs.length, 2);
  console.log('✅ state changed 事件与非法输入');

  // ---------- 11. taskId 缺失 -> unknown 合成键 ----------
  const uk = new RuntimeState();
  uk.apply(ws(rawWs('event.task.started', { title: '无id一' })));
  uk.apply(ws(rawWs('event.task.started', { title: '无id二' })));
  assert.strictEqual(uk.getActiveTaskCount(), 2);
  const ukTasks = uk.getTasks({ includeTerminal: true });
  assert.ok(ukTasks.every((t) => t.key.startsWith('unknown:')));
  assert.strictEqual(new Set(ukTasks.map((t) => t.key)).size, 2); // 各事件独立键
  console.log('✅ state unknown 合成键');

  // ---------- 12. disk normalizer + state 集成 ----------
  const dk = normalizeDiskTask('sess1', { id: 'd1', status: 'running', description: '后台任务' });
  assert.strictEqual(dk.source, 'disk');
  assert.strictEqual(dk.kind, 'task.observed');
  assert.strictEqual(dk.status, 'running');
  assert.strictEqual(dk.confidence, 'medium');
  assert.strictEqual(dk.taskId, 'd1');
  assert.strictEqual(dk.title, '后台任务'); // description 兜底
  assert.strictEqual(normalizeDiskTask('s', { id: 'x', status: 'weird', title: 't' }).status, 'completed'); // 未知值保守归 completed
  assert.strictEqual(normalizeDiskTask('s', { id: 'x', title: 't' }).status, null); // 无 status -> null
  assert.strictEqual(normalizeDiskTask('s', { id: 'x', status: 'failed', title: 't' }).status, 'failed');
  assert.strictEqual(normalizeDiskTask('s', null), null);

  const ds = new RuntimeState();
  ds.apply(dk);
  assert.strictEqual(ds.getActiveTaskCount('sess1'), 1);
  ds.apply(normalizeDiskTask('sess1', { id: 'd1', status: 'completed', description: '后台任务' }));
  assert.strictEqual(ds.getActiveTaskCount('sess1'), 0);
  ds.apply(normalizeDiskTask('sess1', { id: 'd1', status: 'running', description: '后台任务' })); // 终态不复活
  assert.strictEqual(ds.getActiveTaskCount('sess1'), 0);
  // status null -> observed 中性记录，不计运行
  const ds2 = new RuntimeState();
  ds2.apply(normalizeDiskTask('sess1', { description: '未知状态' }));
  assert.strictEqual(ds2.getActiveTaskCount('sess1'), 0);
  assert.strictEqual(ds2.getTasks({ includeTerminal: true })[0].status, null);
  console.log('✅ normalizer disk + state 集成');

  // ---------- 13. resetSession / clear ----------
  const rc = new RuntimeState();
  rc.apply(ws(rawWs('event.task.started', { task_id: 'r1', title: 'a' }, { session_id: 's1' })));
  rc.apply(ws(rawWs('event.task.started', { task_id: 'r1', title: 'b' }, { session_id: 's2' })));
  rc.apply(ws(rawWs('event.session.usage_updated', { usage: { total_tokens: 1, context_used: 1, context_limit: 1 } }, { session_id: 's1' })));
  rc.resetSession('s1');
  assert.strictEqual(rc.getActiveTaskCount('s1'), 0);
  assert.strictEqual(rc.getActiveTaskCount(), 1); // s2 仍在
  assert.strictEqual(rc.getSessionUsage('s1'), null);
  rc.resetSession('s2');
  assert.strictEqual(rc.getActiveTaskCount(), 0);
  rc.clear();
  assert.strictEqual(rc.getTasks({ includeTerminal: true }).length, 0);
  assert.deepStrictEqual(rc.getUsageSnapshot(), { totalTokens: 0, contextUsed: 0, contextLimit: 0, runningTasks: 0, lastTaskTitle: '' });
  console.log('✅ state resetSession / clear');

  // ---------- 14. getActiveCounts：task/agent 双类拆分 + 会话隔离 + 终态归零 ----------
  const gc = new RuntimeState();
  // 全局 WS task（sessionId null -> tasks）
  gc.apply(ws(rawWs('event.task.started', { task_id: 'w1', title: '全局任务' })));
  // A 会话 ACP Agent 事件（rawInput.subagent_type 非空 -> agents）
  gc.apply(normalizeAcpToolCall('sessA', {
    sessionUpdate: 'tool_call',
    toolCallId: '0:tool_abcdefghijklmnopqrstuvwx',
    title: 'Agent A',
    rawInput: { subagent_type: 'explore' },
  }));
  // B 会话 WS task（带 session_id -> tasks）
  gc.apply(ws(rawWs('event.task.started', { task_id: 'b1', title: 'B 任务' }, { session_id: 'sessB' })));
  // 双类拆分：不传参 = 全部（含 null 桶）：2 tasks（w1 + b1）+ 1 agent
  assert.deepStrictEqual(gc.getActiveCounts(), { tasks: 2, agents: 1 });
  // 会话隔离：A 会话仅见自己的 agent；B 会话仅见自己的 task；null 桶仅见 w1；无会话 -> 全 0
  assert.deepStrictEqual(gc.getActiveCounts('sessA'), { tasks: 0, agents: 1 });
  assert.deepStrictEqual(gc.getActiveCounts('sessB'), { tasks: 1, agents: 0 });
  assert.deepStrictEqual(gc.getActiveCounts(null), { tasks: 1, agents: 0 });
  assert.deepStrictEqual(gc.getActiveCounts('sessC'), { tasks: 0, agents: 0 });
  // 会话内 task 完成不影响其他会话计数
  gc.apply(ws(rawWs('event.task.completed', { task_id: 'b1', title: 'B 任务' }, { session_id: 'sessB' })));
  assert.deepStrictEqual(gc.getActiveCounts(), { tasks: 1, agents: 1 });
  // 终态归零：全部完成后双计数均 0
  gc.apply(ws(rawWs('event.task.completed', { task_id: 'w1', title: '全局任务' })));
  gc.apply(normalizeAcpToolCall('sessA', {
    sessionUpdate: 'tool_call_update',
    toolCallId: '0:tool_abcdefghijklmnopqrstuvwx',
    title: 'Agent A',
    status: 'completed',
    rawInput: { subagent_type: 'explore' },
  }));
  assert.deepStrictEqual(gc.getActiveCounts(), { tasks: 0, agents: 0 });
  // tombstone 不复活：同键再 started 不恢复计数
  gc.apply(normalizeAcpToolCall('sessA', {
    sessionUpdate: 'tool_call_update',
    toolCallId: '0:tool_abcdefghijklmnopqrstuvwx',
    title: 'Agent A',
    status: 'in_progress',
    rawInput: { subagent_type: 'explore' },
  }));
  assert.deepStrictEqual(gc.getActiveCounts(), { tasks: 0, agents: 0 });
  // 现有方法行为不变：getActiveTaskCount 仍按会话过滤（agents 也计入 running 任务）
  assert.strictEqual(gc.getActiveTaskCount(), 0);
  gc.apply(normalizeAcpToolCall('sessA', {
    sessionUpdate: 'tool_call',
    toolCallId: '0:tool_newtoolidnewtoolidnewtoolid',
    title: 'Agent A2',
    rawInput: { subagent_type: 'planner' },
  }));
  assert.strictEqual(gc.getActiveTaskCount('sessA'), 1); // agent 计入任务计数
  assert.deepStrictEqual(gc.getActiveCounts('sessA'), { tasks: 0, agents: 1 });
  console.log('✅ state getActiveCounts 双类拆分/会话隔离/终态归零');

  // ---------- 15. ACP Task 工具放行（Phase 5a 口径补全）：task.observed、agentType=null ----------
  const tq = new RuntimeState();
  const taskCall = normalizeAcpToolCall('sessT', {
    sessionUpdate: 'tool_call',
    toolCallId: '0:tool_taskbg1234567890abcdefg',
    title: 'Task',
    status: 'pending',
    rawInput: { description: '后台构建任务', command: 'npm run build' },
  });
  assert.ok(taskCall, 'Task 工具应放行');
  assert.strictEqual(taskCall.kind, 'task.observed');
  assert.strictEqual(taskCall.status, 'running'); // tool_call -> observed(running)
  assert.strictEqual(taskCall.agentType, null);
  assert.strictEqual(taskCall.title, '后台构建任务'); // rawInput.description 优先
  assert.strictEqual(taskCall.taskId, '0:tool_taskbg1234567890abcdefg');
  assert.strictEqual(taskCall.sessionId, 'sessT');
  // 计入 tasks 类（getActiveCounts 不把 Task 当 agent）
  tq.apply(taskCall);
  assert.deepStrictEqual(tq.getActiveCounts('sessT'), { tasks: 1, agents: 0 });
  assert.strictEqual(tq.getActiveTaskCount('sessT'), 1);
  // 状态映射同 Agent 路径
  assert.strictEqual(normalizeAcpToolCall('sid', { sessionUpdate: 'tool_call_update', toolCallId: '0:tool_x', title: 'Task', status: 'in_progress' }).status, 'running');
  assert.strictEqual(normalizeAcpToolCall('sid', { sessionUpdate: 'tool_call_update', toolCallId: '0:tool_x', title: 'Task', status: 'completed' }).status, 'completed');
  assert.strictEqual(normalizeAcpToolCall('sid', { sessionUpdate: 'tool_call_update', toolCallId: '0:tool_x', title: 'Task', status: 'failed' }).status, 'failed');
  assert.strictEqual(normalizeAcpToolCall('sid', { sessionUpdate: 'tool_call_update', toolCallId: '0:tool_x', title: 'Task', status: 'weird' }), null);
  // Read 等其他工具仍 null（fixture tool-call-read.json 已覆盖）
  assert.strictEqual(normalizeAcpToolCall('sid', { sessionUpdate: 'tool_call', toolCallId: '0:tool_x', title: 'Glob' }), null);
  console.log('✅ normalizer：ACP Task 工具放行（tasks 类、agentType=null）');

  // ---------- 16. normalizeAcpCatalogEvent：Cron*/TaskOutput/TaskStop 形态（fixture 驱动） ----------
  const cronSeq = load('cron/cron-tool-events.json').events;
  const catEvents = cronSeq.map((e) => normalizeAcpCatalogEvent(e.sessionId, e.update));
  // CronCreate：tool_call -> running（detail 只取短字段，不含 command）
  const cc = catEvents[0];
  assert.strictEqual(cc.kind, 'cron.observed');
  assert.strictEqual(cc.cronAction, 'CronCreate');
  assert.strictEqual(cc.status, 'running');
  assert.strictEqual(cc.sessionId, cronSeq[0].sessionId);
  assert.strictEqual(cc.taskId, '1:tool_a1b2c3d4e5f6a7b8c9d0e1f2');
  assert.strictEqual(cc.title, 'CronCreate'); // rawInput 无 description -> update.title
  assert.deepStrictEqual(cc.detail, {}); // tool_call 阶段无 rawInput
  // CronCreate completed：rawInput 短字段收录，command 排除
  const cc2 = catEvents[1];
  assert.strictEqual(cc2.status, 'completed');
  assert.deepStrictEqual(cc2.detail, { name: 'daily-backup', schedule: '0 2 * * *' });
  assert.ok(!('command' in cc2.detail), 'detail 不得含 command 全文');
  // CronList：detail 为 rawOutput 解析的列表数组
  const cl = catEvents[3];
  assert.strictEqual(cl.cronAction, 'CronList');
  assert.strictEqual(cl.status, 'completed');
  assert.ok(Array.isArray(cl.detail));
  assert.deepStrictEqual(cl.detail, []); // rawOutput '[]'
  // TaskOutput -> tasktool.observed
  const to = catEvents[5];
  assert.strictEqual(to.kind, 'tasktool.observed');
  assert.strictEqual(to.status, 'completed');
  assert.strictEqual(to.taskId, '1:tool_c3d4e5f6a7b8c9d0e1f2a3b4');
  assert.strictEqual(to.title, 'TaskOutput');
  // 非目录工具 -> null
  assert.strictEqual(normalizeAcpCatalogEvent('sid', { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Task' }), null);
  assert.strictEqual(normalizeAcpCatalogEvent('sid', { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Agent' }), null);
  assert.strictEqual(normalizeAcpCatalogEvent('sid', { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Read' }), null);
  assert.strictEqual(normalizeAcpCatalogEvent('sid', { sessionUpdate: 'tool_call_update', toolCallId: 'x', title: 'CronCreate', status: 'weird' }), null);
  assert.strictEqual(normalizeAcpCatalogEvent('sid', null), null);
  // CronDelete 形态
  const cd = normalizeAcpCatalogEvent('sid', {
    sessionUpdate: 'tool_call',
    toolCallId: '1:tool_delcron0000000000000000',
    title: 'CronDelete',
    status: 'pending',
    rawInput: { name: 'daily-backup' },
  });
  assert.strictEqual(cd.cronAction, 'CronDelete');
  assert.strictEqual(cd.status, 'running');
  assert.deepStrictEqual(cd.detail, { name: 'daily-backup' });
  // TaskStop 形态
  const ts = normalizeAcpCatalogEvent('sid', { sessionUpdate: 'tool_call', toolCallId: '1:tool_stop00000000000000000', title: 'TaskStop', status: 'pending' });
  assert.strictEqual(ts.kind, 'tasktool.observed');
  assert.strictEqual(ts.title, 'TaskStop');
  console.log('✅ normalizer：normalizeAcpCatalogEvent Cron*/TaskOutput/TaskStop');

  console.log('\n全部 runtime-state 测试通过');
}

run();
