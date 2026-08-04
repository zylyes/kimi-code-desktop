// 工作区数据投影模块单元测试（M4-1/M4-5）：单一已验证会话的 agents 树 + 任务目录组合视图
// 覆盖：正常树+catalog / 两级 session 路径对账（不跨会话合并）/ 目录缺失与坏文件 diagnostics 不抛 /
// 无效输入空态（unbound / invalid-session-dir / no-catalog）；taskCatalog 用真实 TaskCatalog 直读 sessionDir。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const RuntimeState = require('../src/main/runtime-state');
const TaskCatalog = require('../src/main/task-catalog');
const { normalizeWsEvent } = require('../src/main/runtime-event-normalizer');
const { getWorkspaceProjection } = require('../src/main/workspace-projection');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-ws-proj-test-'));
const sessionsRoot = path.join(tmpDir, 'sessions');

function writeJson(rel, obj) {
  const fp = path.join(sessionsRoot, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}

// wire 行构造 helpers（时间戳为 epoch ms）
const loopEvent = (event, time) => JSON.stringify({ type: 'context.append_loop_event', event, time });
const stepBegin = (uuid, seq, time) => loopEvent({ type: 'step.begin', uuid, turnId: '0', step: seq }, time);
const stepEnd = (uuid, seq, finishReason, time) =>
  loopEvent({ type: 'step.end', uuid, turnId: '0', step: seq, finishReason }, time);

// 建会话目录（两级布局 sessionsRoot/<wdKey>/<sessionId>/）：state + main/agent-0 wire + tasks/cron
function makeSessionDir(wdKey, sid) {
  const rel = `${wdKey}/${sid}`;
  writeJson(`${rel}/state.json`, {
    agents: { main: { type: 'main' }, 'agent-0': { type: 'sub', parentAgentId: 'main' } },
  });
  writeJson(`${rel}/agents/main/wire.jsonl`,
    [stepBegin('m1', 1, 1785550000000), stepEnd('m1', 1, 'end_turn', 1785550001000)].join('\n'));
  writeJson(`${rel}/agents/agent-0/wire.jsonl`, stepBegin('a1', 1, 1785550002000)); // 未闭合 -> running
  writeJson(`${rel}/tasks/t1.json`, { id: 't1', status: 'completed', title: '投影任务' });
  writeJson(`${rel}/cron/c1.json`, { id: 'c1', schedule: '0 2 * * *', description: '投影计划', enabled: true });
  return path.join(sessionsRoot, rel);
}

async function main() {
  console.log('测试目录:', tmpDir);

  const dir = makeSessionDir('wdA', 'session_s1');
  makeSessionDir('wdA', 'session_s2'); // 另一会话：对账不得跨会话合并
  const catalog = new TaskCatalog({ runtimeState: new RuntimeState(), sessionsRoot });

  // ---------- 1. 正常投影：树 + 目录组合，两级路径对账 ----------
  const r = await getWorkspaceProjection({ sessionId: 'session_s1', sessionDir: dir, taskCatalog: catalog });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sessionId, 'session_s1');
  assert.ok(Array.isArray(r.agents) && r.agents.length === 2, 'agents 应为树节点');
  assert.ok(r.agents.every((a) => a.sessionId === 'session_s1'), 'agents 对账：仅目标会话');
  const main = r.agents.find((a) => a.agentId === 'main');
  assert.ok(main && main.agentType === 'main' && main.status === 'completed');
  const sub = r.agents.find((a) => a.agentId === 'agent-0');
  assert.ok(sub && sub.parentAgentId === 'main' && sub.status === 'running');
  assert.ok(Array.isArray(r.tasks) && r.tasks.length === 2, 'tasks 应为目录条目');
  assert.ok(r.tasks.every((t) => t.sessionId === 'session_s1'), 'tasks 对账：无跨会话合并');
  const t1 = r.tasks.find((t) => t.key === 'session_s1:t1');
  assert.ok(t1 && t1.source === 'disk' && t1.status === 'completed' && t1.confidence === 'medium');
  const c1 = r.tasks.find((t) => t.key === 'session_s1:c1');
  assert.ok(c1 && c1.kind === 'cron');
  assert.ok(r.diagnostics && r.diagnostics.agents && r.diagnostics.tasks, 'diagnostics 保留两边完整结构');
  assert.strictEqual(r.diagnostics.agents.scannedAgents, 2);
  assert.strictEqual(r.diagnostics.tasks.scannedFiles, 1);
  assert.strictEqual(r.diagnostics.tasks.cronFiles, 1);
  assert.ok(typeof r.capturedAt === 'number' && r.capturedAt > 0);
  console.log('✅ 正常投影（树 + 目录 + 两级路径对账）');

  // ---------- 2. 目录缺失 -> 失败态不抛 ----------
  const ghost = await getWorkspaceProjection({
    sessionId: 'ghost_s', sessionDir: path.join(sessionsRoot, 'wdA', 'ghost'), taskCatalog: catalog,
  });
  assert.strictEqual(ghost.ok, false);
  assert.strictEqual(ghost.reason, 'invalid-session-dir');
  assert.deepStrictEqual(ghost.agents, []);
  assert.deepStrictEqual(ghost.tasks, []);
  assert.ok(ghost.diagnostics && ghost.diagnostics.agents && ghost.diagnostics.agents.error);
  console.log('✅ 目录缺失 -> 失败态不抛');

  // ---------- 3. 坏文件：diagnostics 透传不抛（ok:true） ----------
  writeJson('wdA/session_bad/state.json', { agents: { main: { type: 'main' } } });
  writeJson('wdA/session_bad/agents/main/wire.jsonl', '{损坏');
  writeJson('wdA/session_bad/tasks/bad.json', '{损坏');
  writeJson('wdA/session_bad/tasks/ok.json', { id: 'ok', status: 'completed', title: '好文件' });
  const bad = await getWorkspaceProjection({
    sessionId: 'session_bad', sessionDir: path.join(sessionsRoot, 'wdA', 'session_bad'), taskCatalog: catalog,
  });
  assert.strictEqual(bad.ok, true, '坏文件不抛且保持 ok');
  assert.strictEqual(bad.agents.length, 1); // main wire 可读但坏行 -> 节点仍建（status unknown）
  assert.strictEqual(bad.agents[0].status, 'unknown');
  assert.strictEqual(bad.diagnostics.agents.badLines, 1);
  assert.strictEqual(bad.tasks.length, 1); // 坏 JSON 跳过、好文件进入
  assert.strictEqual(bad.diagnostics.tasks.badFiles, 1);
  assert.strictEqual(bad.tasks[0].key, 'session_bad:ok');
  console.log('✅ 坏文件 diagnostics 透传不抛');

  // ---------- 4. 无效输入空态（不抛） ----------
  const plainFile = path.join(sessionsRoot, 'wdA', 'plain.txt'); // 普通文件：Agents 边界拒绝（非目录）
  writeJson('wdA/plain.txt', { note: '普通文件' });
  const u1 = await getWorkspaceProjection({ sessionDir: dir, taskCatalog: catalog }); // 缺 sessionId
  assert.strictEqual(u1.ok, false);
  assert.strictEqual(u1.reason, 'unbound');
  assert.strictEqual(u1.sessionId, null);
  assert.deepStrictEqual(u1.agents, []);
  assert.deepStrictEqual(u1.tasks, []);
  const u2 = await getWorkspaceProjection({ sessionId: '  ', sessionDir: dir, taskCatalog: catalog }); // 非法 sessionId
  assert.strictEqual(u2.ok, false);
  assert.strictEqual(u2.reason, 'unbound');
  const i1 = await getWorkspaceProjection({ sessionId: 'session_s1', taskCatalog: catalog }); // 缺 sessionDir
  assert.strictEqual(i1.ok, false);
  assert.strictEqual(i1.reason, 'invalid-session-dir');
  const i2 = await getWorkspaceProjection({ sessionId: 'session_s1', sessionDir: 42, taskCatalog: catalog }); // 非字符串
  assert.strictEqual(i2.ok, false);
  assert.strictEqual(i2.reason, 'invalid-session-dir');
  const i3 = await getWorkspaceProjection({ // 越界目录：树层失败态（不抛）
    sessionId: 'session_s1', sessionDir: path.join(sessionsRoot, '..', 'evil'), taskCatalog: catalog,
  });
  assert.strictEqual(i3.ok, false);
  assert.strictEqual(i3.reason, 'invalid-session-dir');
  const i4 = await getWorkspaceProjection({ // 普通文件：basename 匹配但非目录 -> Agents 边界失败态（不抛）
    sessionId: 'plain.txt', sessionDir: plainFile, taskCatalog: catalog,
  });
  assert.strictEqual(i4.ok, false);
  assert.strictEqual(i4.reason, 'invalid-session-dir');
  assert.deepStrictEqual(i4.agents, []);
  assert.deepStrictEqual(i4.tasks, []);
  const n1 = await getWorkspaceProjection({ sessionId: 'session_s1', sessionDir: dir }); // 缺 taskCatalog
  assert.strictEqual(n1.ok, false);
  assert.strictEqual(n1.reason, 'no-catalog');
  const n2 = await getWorkspaceProjection(); // 全空调用
  assert.strictEqual(n2.ok, false);
  assert.strictEqual(n2.reason, 'unbound');
  console.log('✅ 无效输入空态（unbound / invalid-session-dir / no-catalog）');

  // ---------- 5. 与真实 TaskCatalog 直读的 sessionDir 联动（含 runtime 快照优先级） ----------
  const state = new RuntimeState();
  const cat2 = new TaskCatalog({ runtimeState: state, sessionsRoot });
  state.apply(normalizeWsEvent({
    event: 'event.task.started', payload: { task_id: 't1', title: '运行时t1' }, session_id: 'session_s1',
  }));
  const r2 = await getWorkspaceProjection({ sessionId: 'session_s1', sessionDir: dir, taskCatalog: cat2 });
  const t1b = r2.tasks.find((t) => t.key === 'session_s1:t1');
  assert.ok(t1b && t1b.source === 'ws' && t1b.status === 'running', 'runtime WS 快照优先于磁盘');
  console.log('✅ runtime WS 快照优先（TaskCatalog sessionDir 直读联动）');

  // ---------- 6. 会话 ID 与 sessionDir 绑定：独立 basename 一致性检查（防纯模块调用绕过） ----------
  // {sessionId:'B', sessionDir:'.../session_A'}：canonical basename 错配 -> invalid-session-dir 空态，
  // Agents/Tasks 都不得混入
  const mis = await getWorkspaceProjection({ sessionId: 'B', sessionDir: dir, taskCatalog: catalog });
  assert.strictEqual(mis.ok, false);
  assert.strictEqual(mis.reason, 'invalid-session-dir');
  assert.strictEqual(mis.sessionId, 'B');
  assert.deepStrictEqual(mis.agents, [], '错配时 Agents 不得混入');
  assert.deepStrictEqual(mis.tasks, [], '错配时 Tasks 不得混入');
  // 目录存在但 basename 与 sessionId 不一致（session_A 形态）
  const mis2 = await getWorkspaceProjection({ sessionId: 'session_s2', sessionDir: dir, taskCatalog: catalog });
  assert.strictEqual(mis2.ok, false);
  assert.strictEqual(mis2.reason, 'invalid-session-dir');
  assert.deepStrictEqual(mis2.agents, []);
  assert.deepStrictEqual(mis2.tasks, []);
  // 一致性正确时正常投影不受影响（回归）
  const ok3 = await getWorkspaceProjection({ sessionId: 'session_s1', sessionDir: dir, taskCatalog: catalog });
  assert.strictEqual(ok3.ok, true);
  assert.strictEqual(ok3.agents.length, 2);
  assert.strictEqual(ok3.tasks.length, 2);
  console.log('✅ 会话 ID 与 sessionDir 绑定（错配 invalid-session-dir，Agents/Tasks 均不混入）');

  // ---------- 7. TaskCatalog rejection 不逃逸：'catalog-error' 失败态（不抛） ----------
  // 不受信 taskCatalog 实现（getCatalog 抛 rejection）不得击穿投影的"不抛"契约
  const boom = { getCatalog: async () => { throw new Error('catalog boom'); } };
  let threw = false;
  let rr;
  try {
    rr = await getWorkspaceProjection({ sessionId: 'session_s1', sessionDir: dir, taskCatalog: boom });
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, false, 'getCatalog rejection 不得从投影逃逸');
  assert.strictEqual(rr.ok, false);
  assert.strictEqual(rr.reason, 'catalog-error');
  assert.strictEqual(rr.sessionId, 'session_s1');
  assert.deepStrictEqual(rr.agents, []);
  assert.deepStrictEqual(rr.tasks, []);
  assert.ok(rr.diagnostics && rr.diagnostics.agents && rr.diagnostics.agents.scannedAgents === 2,
    'catalog-error 态保留 agents 侧诊断（树已构建）');
  assert.strictEqual(rr.diagnostics.tasks, null);
  // 同 sessionDir 的合法 taskCatalog 不受影响（回归）
  const ok4 = await getWorkspaceProjection({ sessionId: 'session_s1', sessionDir: dir, taskCatalog: catalog });
  assert.strictEqual(ok4.ok, true);
  assert.strictEqual(ok4.tasks.length, 2);
  console.log('✅ TaskCatalog rejection 不逃逸（catalog-error 失败态 + 回归）');

  // ---------- 8. M6 上限缺口：投影响应条目上限（确定性截断 + diagnostics 可见 + 小数据回归） ----------
  {
    const LIM = require('../src/main/workspace-projection').LIMITS;
    const origA = LIM.MAX_AGENTS;
    const origT = LIM.MAX_TASKS;
    LIM.MAX_AGENTS = 1;
    LIM.MAX_TASKS = 1;
    try {
      const r = await getWorkspaceProjection({ sessionId: 'session_s1', sessionDir: dir, taskCatalog: catalog });
      assert.strictEqual(r.ok, true, '截断不抛');
      assert.strictEqual(r.agents.length, 1, 'agents 响应超上限确定性截断');
      assert.strictEqual(r.tasks.length, 1, 'tasks 响应超上限确定性截断');
      assert.strictEqual(r.diagnostics.truncated.agents, true, '截断标记 diagnostics 可见');
      assert.strictEqual(r.diagnostics.truncated.tasks, true);
      assert.strictEqual(r.agents[0].agentId, 'main', '保留前 N（main 优先排序后）');
    } finally {
      LIM.MAX_AGENTS = origA;
      LIM.MAX_TASKS = origT;
    }
    // 小数据回归：不截断时结构/顺序不变
    const ok5 = await getWorkspaceProjection({ sessionId: 'session_s1', sessionDir: dir, taskCatalog: catalog });
    assert.strictEqual(ok5.ok, true);
    assert.strictEqual(ok5.agents.length, 2);
    assert.strictEqual(ok5.tasks.length, 2);
    assert.strictEqual(ok5.diagnostics.truncated.agents, false);
    assert.strictEqual(ok5.diagnostics.truncated.tasks, false);
    assert.ok(ok5.diagnostics.agents && ok5.diagnostics.tasks, '既有 diagnostics 结构保持');
    console.log('✅ M6 投影响应条目上限（确定性截断 + diagnostics 可见 + 小数据回归）');
  }

  console.log('\n全部 workspace-projection 测试通过');
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
