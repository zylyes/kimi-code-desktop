// 主进程规范化状态层单元测试：normalizer + RuntimeState
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { normalizeWsEvent, normalizeAcpToolCall, normalizeAcpCatalogEvent, normalizeDiskTask, LIMITS: NLIMITS } = require('../src/main/runtime-event-normalizer');
const RuntimeState = require('../src/main/runtime-state');
const TaskCatalog = require('../src/main/task-catalog');

function load(rel) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf8'));
}
function ws(obj) { return normalizeWsEvent(obj); }
function rawWs(event, payload, extra) {
  return Object.assign({ event, payload }, extra || {});
}

async function run() {
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

  // ---------- 17. M4：task.started info 嵌套取值 + subagent.* / agent.* 映射 ----------
  // M1 实测：task.started payload 顶层为 { agentId, info, sessionId, type }，task_id 在 info 内
  const it = ws(rawWs('event.task.started', {
    agentId: 'agent-1',
    sessionId: 'sessM4',
    type: 'main',
    info: { task_id: 'nested-1', title: 'info 标题', description: 'info 描述' },
  }));
  assert.strictEqual(it.taskId, 'nested-1'); // info.task_id 兜底
  assert.strictEqual(it.sessionId, 'sessM4'); // payload.sessionId
  assert.strictEqual(it.title, 'info 标题'); // info.title 优先于 info.description
  // info 字段漂移变体：taskId / id / toolCallId + description + info.session_id
  const it2 = ws(rawWs('event.task.started', {
    info: { id: 'nested-2', description: '仅描述', session_id: 'sessInfo' },
  }));
  assert.strictEqual(it2.taskId, 'nested-2');
  assert.strictEqual(it2.title, '仅描述');
  assert.strictEqual(it2.sessionId, 'sessInfo'); // info.session_id 兜底
  const it3 = ws(rawWs('event.task.started', { info: { toolCallId: 'tool-3', sessionId: 's3' } }));
  assert.strictEqual(it3.taskId, 'tool-3');
  assert.strictEqual(it3.sessionId, 's3');
  assert.strictEqual(it3.title, ''); // info 无 title/description
  // 既有兼容：顶层 task_id/title/session_id 仍优先于 info
  const it4 = ws(rawWs('event.task.started', { task_id: 'top-1', title: '顶层', info: { id: 'nested', title: 'info' } }, { session_id: 'sTop' }));
  assert.strictEqual(it4.taskId, 'top-1');
  assert.strictEqual(it4.title, '顶层');
  assert.strictEqual(it4.sessionId, 'sTop');

  // subagent.spawned -> task.observed(running)，agentType=subagentName，title=description
  const sp = ws(rawWs('event.subagent.spawned', {
    agentId: 'agent-2',
    callerAgentId: 'agent-1',
    description: '探索测试文件',
    parentAgentId: 'agent-1',
    parentToolCallId: '0:tool_parent',
    runInBackground: false,
    sessionId: 'sessM4',
    subagentId: 'sub-1',
    subagentName: 'explore',
  }));
  assert.strictEqual(sp.source, 'ws');
  assert.strictEqual(sp.kind, 'task.observed');
  assert.strictEqual(sp.status, 'running');
  assert.strictEqual(sp.taskId, 'sub-1');
  assert.strictEqual(sp.sessionId, 'sessM4');
  assert.strictEqual(sp.agentType, 'explore'); // subagentName 优先
  assert.strictEqual(sp.title, '探索测试文件'); // description 优先
  assert.strictEqual(sp.confidence, 'high');
  assert.strictEqual(sp.rawKind, 'event.subagent.spawned');

  // subagent.started -> task.observed(running)，无 name/description -> 'subagent' 默认
  const sst = ws(rawWs('event.subagent.started', { sessionId: 'sessM4', subagentId: 'sub-1' }));
  assert.strictEqual(sst.kind, 'task.observed');
  assert.strictEqual(sst.status, 'running');
  assert.strictEqual(sst.taskId, 'sub-1');
  assert.strictEqual(sst.sessionId, 'sessM4');
  assert.strictEqual(sst.agentType, 'subagent');
  assert.strictEqual(sst.title, 'subagent');
  // 无 subagentId -> 无法形成可观测任务
  assert.strictEqual(ws(rawWs('event.subagent.spawned', { sessionId: 's', subagentName: 'x' })), null);
  // agent.created / agent.status.updated 保守 null（未实测，不伪造生命周期）
  assert.strictEqual(ws(rawWs('event.agent.created', { sessionId: 's', agentId: 'a' })), null);
  assert.strictEqual(ws(rawWs('event.agent.status.updated', { sessionId: 's', agentId: 'a', status: 'completed' })), null);
  console.log('✅ normalizer：M4 task.started info 嵌套 / subagent.* / agent.*');

  // ---------- 18. M4：RuntimeState 消费 subagent.*（getTasks / getActiveCounts） ----------
  const m4 = new RuntimeState();
  m4.apply(sp);
  assert.deepStrictEqual(m4.getActiveCounts('sessM4'), { tasks: 0, agents: 1 }); // agents 类
  assert.strictEqual(m4.getActiveTaskCount('sessM4'), 1); // agent 计入任务计数
  let m4Tasks = m4.getTasks({ sessionId: 'sessM4' });
  assert.strictEqual(m4Tasks.length, 1);
  assert.strictEqual(m4Tasks[0].taskId, 'sub-1');
  assert.strictEqual(m4Tasks[0].agentType, 'explore');
  assert.strictEqual(m4Tasks[0].title, '探索测试文件');
  assert.strictEqual(m4Tasks[0].status, 'running');
  // subagent.started 同键：不重复计数（agent 数不变）
  m4.apply(sst);
  assert.deepStrictEqual(m4.getActiveCounts('sessM4'), { tasks: 0, agents: 1 });
  m4Tasks = m4.getTasks({ sessionId: 'sessM4' });
  assert.strictEqual(m4Tasks.length, 1);
  // 会话隔离：其他会话不可见
  assert.deepStrictEqual(m4.getActiveCounts('other'), { tasks: 0, agents: 0 });
  // 不同 subagentId -> agents 计数增加
  m4.apply(ws(rawWs('event.subagent.spawned', { sessionId: 'sessM4', subagentId: 'sub-2', subagentName: 'planner' })));
  assert.deepStrictEqual(m4.getActiveCounts('sessM4'), { tasks: 0, agents: 2 });
  // 与 task.started（tasks 类）共存
  m4.apply(ws(rawWs('event.task.started', { sessionId: 'sessM4', info: { task_id: 't-m4', title: '主任务' } })));
  assert.deepStrictEqual(m4.getActiveCounts('sessM4'), { tasks: 1, agents: 2 });
  // description 漂移：title 更新、不重复计数
  m4.apply(ws(rawWs('event.subagent.spawned', { sessionId: 'sessM4', subagentId: 'sub-2', subagentName: 'planner', description: '新描述' })));
  assert.deepStrictEqual(m4.getActiveCounts('sessM4'), { tasks: 1, agents: 2 });
  const m4t2 = m4.getTasks({ sessionId: 'sessM4' }).find((t) => t.taskId === 'sub-2');
  assert.strictEqual(m4t2.title, '新描述');
  assert.strictEqual(m4t2.agentType, 'planner');
  console.log('✅ state：subagent.* 消费（getTasks / getActiveCounts.agents）');

  // ---------- 19. 元信息降级保护：同键非终态更新不降级具体 title/agentType ----------
  const mq = new RuntimeState();
  // subagent.spawned 携带具体元信息（explore / inspect repo）
  mq.apply(ws(rawWs('event.subagent.spawned', {
    sessionId: 'sessQ',
    subagentId: 'q-1',
    subagentName: 'explore',
    description: 'inspect repo',
  })));
  assert.deepStrictEqual(mq.getActiveCounts('sessQ'), { tasks: 0, agents: 1 });
  // subagent.started 缺 name/description -> normalizer 通用回退（'subagent'），不得覆盖已有具体值
  mq.apply(ws(rawWs('event.subagent.started', { sessionId: 'sessQ', subagentId: 'q-1' })));
  assert.deepStrictEqual(mq.getActiveCounts('sessQ'), { tasks: 0, agents: 1 }); // 不重复计数、不降级 agentType 分类
  let qTasks = mq.getTasks({ sessionId: 'sessQ' });
  assert.strictEqual(qTasks.length, 1);
  assert.strictEqual(qTasks[0].title, 'inspect repo'); // 保留 spawned 的具体 title
  assert.strictEqual(qTasks[0].agentType, 'explore'); // 保留更具体 agentType
  assert.strictEqual(qTasks[0].status, 'running');
  // 新事件携带具体非通用值 -> 允许覆盖
  mq.apply(ws(rawWs('event.subagent.spawned', {
    sessionId: 'sessQ',
    subagentId: 'q-1',
    subagentName: 'planner',
    description: 'plan migration',
  })));
  qTasks = mq.getTasks({ sessionId: 'sessQ' });
  assert.strictEqual(qTasks[0].title, 'plan migration');
  assert.strictEqual(qTasks[0].agentType, 'planner');
  assert.deepStrictEqual(mq.getActiveCounts('sessQ'), { tasks: 0, agents: 1 }); // 覆盖元信息仍不重复计数
  console.log('✅ state：非终态元信息降级保护（title/agentType）');

  // ---------- 20. M4 RuntimeState 契约：agentType 具体化触发 changed，等价重复不变更 ----------
  const ag = new RuntimeState();
  let agChanged = 0;
  ag.on('changed', () => { agChanged++; });
  // 同 key 先通用（tool_call 无 subagent_type -> agentType null）
  ag.apply(normalizeAcpToolCall('sessR', {
    sessionUpdate: 'tool_call',
    toolCallId: '0:tool_contracttest000000001',
    title: 'Agent',
  }));
  assert.strictEqual(agChanged, 1);
  // 同 key 具体化：agentType null -> explore，title/status 均不变 -> 必须 emit changed
  const specific = normalizeAcpToolCall('sessR', {
    sessionUpdate: 'tool_call_update',
    toolCallId: '0:tool_contracttest000000001',
    title: 'Agent',
    status: 'in_progress',
    rawInput: { subagent_type: 'explore' },
  });
  assert.strictEqual(specific.agentType, 'explore');
  assert.strictEqual(specific.title, 'Agent'); // 无 description -> update.title
  ag.apply(specific);
  assert.strictEqual(agChanged, 2, 'agentType 具体化必须触发 changed');
  let agTasks = ag.getTasks({ sessionId: 'sessR' });
  assert.strictEqual(agTasks.length, 1);
  assert.strictEqual(agTasks[0].agentType, 'explore');
  assert.strictEqual(agTasks[0].status, 'running');
  // 等价重复具体事件：不再 changed
  ag.apply(specific);
  assert.strictEqual(agChanged, 2, '等价重复事件不得再次 changed');
  // 通用回退事件（无 subagent_type）：降级保护保留具体 agentType；
  // 与 specific 同一时刻（at 相同）的等价事件不 changed（at 单调契约下同刻不刷新可见字段）
  const fallback = normalizeAcpToolCall('sessR', {
    sessionUpdate: 'tool_call_update',
    toolCallId: '0:tool_contracttest000000001',
    title: 'Agent',
    status: 'in_progress',
  });
  fallback.at = specific.at;
  ag.apply(fallback);
  assert.strictEqual(agChanged, 2, '等价（同 at）通用回退事件不得 changed');
  agTasks = ag.getTasks({ sessionId: 'sessR' });
  assert.strictEqual(agTasks[0].agentType, 'explore'); // 未被降级
  assert.strictEqual(agTasks[0].title, 'Agent');
  assert.deepStrictEqual(ag.getActiveCounts('sessR'), { tasks: 0, agents: 1 }); // 分类保持 agents
  console.log('✅ state：agentType 具体化 changed / 等价重复与回退不变更');

  // ---------- 21. M4 终审：可见字段契约（等价状态 + 递增 at -> changed；等价重复不变更） ----------
  const fm = new RuntimeState();
  let fmChanged = 0;
  fm.on('changed', () => { fmChanged++; });
  const mkFinal = (at, extra) => Object.assign({
    source: 'ws',
    kind: 'task.observed',
    sessionId: 'sessFinal',
    taskId: 'final-1',
    title: '回归任务',
    status: 'running',
    at,
    usage: null,
    agentType: null,
    confidence: 'high',
    rawKind: 'event.subagent.spawned',
  }, extra || {});
  // 首建
  fm.apply(mkFinal(1000));
  assert.strictEqual(fmChanged, 1);
  // 同 status/title/agentType、at 递增：可见 at（TaskCatalog updatedAt 来源）变化 -> 必须 changed
  fm.apply(mkFinal(2000));
  assert.strictEqual(fmChanged, 2, '等价状态 + 递增 at 必须 changed');
  let fmTasks = fm.getTasks({ sessionId: 'sessFinal' });
  assert.strictEqual(fmTasks[0].at, 2000);
  assert.strictEqual(fmTasks[0].status, 'running');
  assert.strictEqual(fmTasks[0].title, '回归任务');
  // source/confidence/rawKind 同为可见字段：变化必须 changed
  fm.apply(mkFinal(2000, { source: 'acp', confidence: 'low', rawKind: 'tool_call_update' }));
  assert.strictEqual(fmChanged, 3, 'source/confidence/rawKind 变化必须 changed');
  fmTasks = fm.getTasks({ sessionId: 'sessFinal' });
  assert.strictEqual(fmTasks[0].source, 'acp');
  assert.strictEqual(fmTasks[0].confidence, 'low');
  assert.strictEqual(fmTasks[0].rawKind, 'tool_call_update');
  // 完全等价重复（全字段含 at 相同）：不得 changed
  fm.apply(mkFinal(2000, { source: 'acp', confidence: 'low', rawKind: 'tool_call_update' }));
  assert.strictEqual(fmChanged, 3, '完全等价重复不得 changed');
  // at 倒退：单调保护不更新不 changed（乱序老事件不抖动可见 updatedAt）
  fm.apply(mkFinal(1500, { source: 'acp', confidence: 'low', rawKind: 'tool_call_update' }));
  assert.strictEqual(fmChanged, 3, 'at 倒退不得 changed');
  fmTasks = fm.getTasks({ sessionId: 'sessFinal' });
  assert.strictEqual(fmTasks[0].at, 2000, 'at 倒退不更新');
  // 递增 at 等价事件持续推进：每次均 changed 且 at 前移
  fm.apply(mkFinal(3000, { source: 'acp', confidence: 'low', rawKind: 'tool_call_update' }));
  assert.strictEqual(fmChanged, 4, 'at 持续推进必须 changed');
  assert.strictEqual(fm.getTasks({ sessionId: 'sessFinal' })[0].at, 3000);
  console.log('✅ state：可见字段契约（递增 at / 等价重复 / 倒退单调）');

  // ---------- 22. M4 终审：TaskCatalog 可见 updatedAt 与 changed 一致性（跨模块） ----------
  const catState = new RuntimeState();
  let catChanged = 0;
  catState.on('changed', () => { catChanged++; });
  const catMk = (at, extra) => Object.assign({
    source: 'ws',
    kind: 'task.observed',
    sessionId: 'sessCat',
    taskId: 'cat-1',
    title: '目录任务',
    status: 'running',
    at,
    usage: null,
    agentType: null,
    confidence: 'high',
    rawKind: 'event.subagent.spawned',
  }, extra || {});
  const cat22 = new TaskCatalog({ runtimeState: catState, sessionsRoot: path.join(__dirname, 'no-such-sessions') });
  catState.apply(catMk(1000));
  let catRes = await cat22.getCatalog({ sessionId: 'sessCat' });
  assert.strictEqual(catRes.entries[0].updatedAt, 1000);
  assert.strictEqual(catChanged, 1);
  // 等价状态 + 递增 at：changed 且 catalog 可见 updatedAt 同步刷新（Workspace 获知的充要条件）
  catState.apply(catMk(2000));
  catRes = await cat22.getCatalog({ sessionId: 'sessCat' });
  assert.strictEqual(catRes.entries[0].updatedAt, 2000, '递增 at 刷新可见 updatedAt');
  assert.strictEqual(catChanged, 2, '可见 updatedAt 变化必须伴随 changed');
  // 完全等价重复：changed 不发、可见 updatedAt 不变
  catState.apply(catMk(2000));
  catRes = await cat22.getCatalog({ sessionId: 'sessCat' });
  assert.strictEqual(catRes.entries[0].updatedAt, 2000);
  assert.strictEqual(catChanged, 2, '等价重复不得 changed');
  // at 倒退：可见 updatedAt 保持
  catState.apply(catMk(1500));
  catRes = await cat22.getCatalog({ sessionId: 'sessCat' });
  assert.strictEqual(catRes.entries[0].updatedAt, 2000, 'at 倒退可见 updatedAt 不变');
  assert.strictEqual(catChanged, 2);
  console.log('✅ TaskCatalog：可见 updatedAt 与 changed 语义一致（跨模块）');

  // ---------- 23. M6 上限缺口：in-memory map 条目上限（WS/runtime 连续超量确定性驱逐） ----------
  {
    const L = RuntimeState.LIMITS;
    // 23a. 任务条目上限：超过 MAX_TASK_ENTRIES 后驱逐 at 最小（最老）条目，不抛
    const st23 = new RuntimeState();
    const base = 1785554000000;
    const mk = (i) => ({
      source: 'ws', kind: 'task.started', sessionId: 's23', taskId: `t${i}`,
      title: `任务${i}`, status: 'running', at: base + i * 1000,
      agentType: null, confidence: 'high', rawKind: 'event.task.started',
    });
    for (let i = 0; i < L.MAX_TASK_ENTRIES + 50; i++) {
      st23.apply(mk(i));
    }
    const all = st23.getTasks({ sessionId: 's23', includeTerminal: true });
    assert.ok(all.length <= L.MAX_TASK_ENTRIES, '任务条目不超上限');
    assert.ok(st23.truncation.tasksEvicted >= 50, '驱逐计数可见');
    assert.ok(!all.some((e) => e.taskId === 't0'), '最老（at 最小）条目被驱逐');
    assert.ok(all.some((e) => e.taskId === `t${L.MAX_TASK_ENTRIES + 49}`), '最新条目保留');
    assert.ok(all.every((e) => e.at >= base + 50 * 1000), '驱逐确定性：现存条目均比驱逐者新');
    // 驱逐后新事件仍正常进入
    st23.apply(mk(L.MAX_TASK_ENTRIES + 50));
    assert.ok(st23.getTasks({ sessionId: 's23', includeTerminal: true }).some((e) => e.taskId === `t${L.MAX_TASK_ENTRIES + 50}`));
    assert.ok(st23.getTruncation().tasksEvicted >= 51, 'getTruncation() 快照可见');

    // 23b. usage 桶数上限：超过 MAX_USAGE_BUCKETS 驱逐最早插入桶
    const st24 = new RuntimeState();
    for (let i = 0; i < L.MAX_USAGE_BUCKETS + 20; i++) {
      st24.apply({ kind: 'usage.updated', sessionId: `bucket${i}`, usage: { totalTokens: i, contextUsed: 0, contextLimit: 0 } });
    }
    assert.ok(st24.truncation.usageBucketsEvicted >= 20, 'usage 桶驱逐计数可见');
    assert.strictEqual(st24.getSessionUsage('bucket0'), null, '最早插入桶被驱逐');
    assert.ok(st24.getSessionUsage(`bucket${L.MAX_USAGE_BUCKETS + 19}`), '最新桶保留');
    // 既有桶更新不受驱逐影响（回归：全局桶与既有会话桶语义不变）
    const st25 = new RuntimeState();
    st25.apply({ kind: 'usage.updated', sessionId: null, usage: { totalTokens: 1, contextUsed: 2, contextLimit: 3 } });
    assert.deepStrictEqual(st25.getUsageSnapshot(), {
      totalTokens: 1, contextUsed: 2, contextLimit: 3, runningTasks: 0, lastTaskTitle: '',
    });
    console.log('✅ M6 in-memory map 条目上限（任务/usage 桶连续超量确定性驱逐、truncation 可见、小数据回归）');
  }

  // ---------- 24. M6 CronList 规范化资源上限：超长 rawOutput 不 parse / 超量数组整体跳过 / 上限内正常 ----------
  {
    const L = NLIMITS;
    assert.strictEqual(L.CRON_LIST_RAW_MAX_CHARS, 256 * 1024, '长度上限常量');
    assert.strictEqual(L.CRON_LIST_MAX_ITEMS, 500, '条目上限常量');
    const mkList = (rawOutput) => ({
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:tool_cronlist0000000000000',
      title: 'CronList',
      status: 'completed',
      rawInput: { name: 'from-summary' },
      rawOutput,
    });
    const cat24 = new TaskCatalog({ runtimeState: new RuntimeState(), sessionsRoot: path.join(__dirname, 'no-such-sessions') });
    // 既有 cron 观察（CronCreate 建立 daily-backup），用于验证超限事件无 destructive 效果
    assert.strictEqual(cat24.observe(normalizeAcpCatalogEvent('s24', {
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:tool_croncreate0000000000',
      title: 'CronCreate',
      status: 'completed',
      rawInput: { name: 'daily-backup' },
    })), true);

    // 24a. 超长 rawOutput（合法 JSON 数组 + 尾随空白填充，parse 必然成功）：不调用 JSON.parse、回落摘要
    const rawHuge = JSON.stringify([{ id: 'leaked' }]) + ' '.repeat(L.CRON_LIST_RAW_MAX_CHARS);
    let parseCalls = 0;
    const origParse = JSON.parse;
    let evHuge;
    try {
      JSON.parse = function (...args) { parseCalls++; return origParse.apply(this, args); };
      evHuge = normalizeAcpCatalogEvent('s24', mkList(rawHuge));
    } finally {
      JSON.parse = origParse;
    }
    assert.strictEqual(parseCalls, 0, '超长 rawOutput 不得调用 JSON.parse');
    assert.strictEqual(evHuge.kind, 'cron.observed');
    assert.strictEqual(evHuge.cronAction, 'CronList');
    assert.ok(!Array.isArray(evHuge.detail), '超长 rawOutput 不得产出 list snapshot');
    assert.deepStrictEqual(evHuge.detail, { name: 'from-summary' }, '回落 rawInput 摘要（安全 no-op）');

    // 24b. TaskCatalog 消费：超长 rawOutput 事件无 destructive event（既有 cron 观察完好、无新增）
    assert.strictEqual(cat24.observe(evHuge), false, '超限 list 不产生任何 upsert');
    let cron24 = (await cat24.getCatalog({ sessionId: 's24' })).entries.filter((e) => e.kind === 'cron');
    assert.strictEqual(cron24.length, 1, '超限 list 未新增条目');
    assert.strictEqual(cron24[0].taskId, 'daily-backup', '既有 cron 观察未被清除/覆盖');

    // 24c. 超量数组（合法 JSON、条目数 > 上限）：不映射全量、不产生 destructive snapshot，整体跳过
    const big = [];
    for (let i = 0; i < L.CRON_LIST_MAX_ITEMS + 10; i++) big.push({ id: `cron-${i}` });
    const evBig = normalizeAcpCatalogEvent('s24', mkList(JSON.stringify(big)));
    assert.ok(!Array.isArray(evBig.detail), '超量数组不得产出 list snapshot');
    assert.deepStrictEqual(evBig.detail, { name: 'from-summary' }, '超量数组整体跳过（回落摘要）');
    assert.strictEqual(cat24.observe(evBig), false, '超量 list 不产生 upsert');

    // 24d. 上限内：正常规范化（列表项短字段白名单；恰好等于条目上限可解析）
    const okList = [];
    for (let i = 0; i < L.CRON_LIST_MAX_ITEMS; i++) okList.push({ id: `ok-${i}`, name: `名字${i}`, command: 'rm -rf /' });
    const evOk = normalizeAcpCatalogEvent('s24', mkList(JSON.stringify(okList)));
    assert.ok(Array.isArray(evOk.detail), '上限内正常解析为数组');
    assert.strictEqual(evOk.detail.length, L.CRON_LIST_MAX_ITEMS, '恰好等于条目上限可解析');
    assert.deepStrictEqual(evOk.detail[0], { id: 'ok-0', name: '名字0' }, '列表项仍只保留短字段（command 排除）');

    // 24e. 上限内 catalog 消费：小列表正常 upsert，既有观察保留
    const small = normalizeAcpCatalogEvent('s24', mkList(JSON.stringify([
      { id: 'daily-backup', description: '每日备份' },
      { id: 'nightly-clean', description: '夜间清理' },
    ])));
    assert.strictEqual(cat24.observe(small), true, '上限内 list 正常 upsert');
    cron24 = (await cat24.getCatalog({ sessionId: 's24' })).entries.filter((e) => e.kind === 'cron');
    assert.strictEqual(cron24.length, 2, '既有 daily-backup（保留）+ 新增 nightly-clean');
    const db24 = cron24.find((e) => e.taskId === 'daily-backup');
    assert.ok(db24, '既有 daily-backup 未被清除');
    assert.strictEqual(db24.status, 'completed', '终态条目不被 CronList running 复活（既有语义保持）');
    assert.ok(cron24.some((e) => e.taskId === 'nightly-clean'), '新增条目可见');
    console.log('✅ M6 CronList 上限：超长 rawOutput 零 parse / 超量数组整体跳过 / 上限内正常规范化');
  }

  console.log('\n全部 runtime-state 测试通过');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
