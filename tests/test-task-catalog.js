// 任务目录合并模块单元测试：runtime 快照 + ACP cron/tasktool 观察 + 磁盘 tasks|/cron
// Phase 5a：getCatalog 返回 { entries, diagnostics }；cron 观察生命周期；磁盘 cron 目录；优先级与 clearSession。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const RuntimeState = require('../src/main/runtime-state');
const TaskCatalog = require('../src/main/task-catalog');
const { normalizeWsEvent, normalizeAcpCatalogEvent } = require('../src/main/runtime-event-normalizer');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-catalog-test-'));
const sessionsRoot = path.join(tmpDir, 'sessions');

function writeJson(rel, obj) {
  const fp = path.join(sessionsRoot, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}

// ACP cron 观察事件快捷构造（走真实 normalizer 链路）
function cronEv(sessionId, update) {
  return normalizeAcpCatalogEvent(sessionId, update);
}
function tasktoolEv(sessionId, taskId, at, status) {
  return { source: 'acp', kind: 'tasktool.observed', sessionId, taskId, status, at, title: 'TaskOutput' };
}

async function main() {
  console.log('测试目录:', tmpDir);

  // ---------- 磁盘 fixture ----------
  writeJson('s1/tasks/t1.json', { id: 't1', status: 'running', description: '磁盘运行中' });
  writeJson('s1/tasks/t2.json', { id: 't2', status: 'completed', title: '磁盘完成' });
  writeJson('s1/tasks/bad.json', '{损坏');
  writeJson('s1/tasks/noid.json', { description: '缺 id 缺状态' });
  writeJson('s2/tasks/o1.json', { id: 'o1', status: 'completed', title: '会话二任务' });
  writeJson('s2/tasks/arr.json', '[1,2,3]');
  writeJson('s1/cron/c1.json', { id: 'c1', schedule: '0 2 * * *', description: '每日备份', enabled: true });
  writeJson('s1/cron/c2.json', { id: 'c2' }); // 缺 schedule/description/enabled -> missing 标注
  writeJson('s1/cron/badcron.json', '{损坏');
  writeJson('s1/cron/arrcron.json', '[1,2,3]');

  // ---------- runtime 状态 ----------
  const state = new RuntimeState();
  state.apply(normalizeWsEvent({ event: 'event.task.started', payload: { task_id: 't1', title: '运行时t1' }, session_id: 's1' }));
  state.apply(normalizeWsEvent({ event: 'event.task.completed', payload: { task_id: 't1', title: '运行时t1' }, session_id: 's1' }));
  state.apply(normalizeWsEvent({ event: 'event.task.started', payload: { task_id: 't3', title: '运行时t3' }, session_id: 's1' }));
  state.apply(normalizeWsEvent({ event: 'event.task.started', payload: { task_id: 't3', title: '会话三任务' }, session_id: 's3' }));

  const catalog = new TaskCatalog({ runtimeState: state, sessionsRoot });

  // ---------- 1. 合并（新签名）：runtime 优先 + 磁盘 tasks/cron 补充 ----------
  const res = await catalog.getCatalog();
  assert.ok(res && Array.isArray(res.entries), 'getCatalog 应返回 { entries, diagnostics }');
  assert.ok(res.diagnostics && typeof res.diagnostics === 'object', 'diagnostics 应为对象');
  const list = res.entries;
  const byKey = (k) => list.find((t) => t.key === k);
  const t1 = byKey('s1:t1');
  assert.ok(t1, 'runtime 任务应存在');
  assert.strictEqual(t1.status, 'completed'); // runtime 赢：磁盘 running 不覆盖 runtime 终态
  assert.strictEqual(t1.title, '运行时t1');
  assert.strictEqual(t1.source, 'ws');
  assert.strictEqual(t1.kind, 'task');
  assert.strictEqual(t1.id, 's1:t1');
  const t2 = byKey('s1:t2');
  assert.ok(t2, '磁盘补充任务应存在');
  assert.strictEqual(t2.status, 'completed');
  assert.strictEqual(t2.source, 'disk');
  assert.strictEqual(t2.confidence, 'medium');
  assert.strictEqual(byKey('s1:t3').status, 'running');
  assert.strictEqual(byKey('s2:o1').status, 'completed');
  assert.ok(byKey('s3:t3'));
  // 缺字段文件 -> 合成 unknown 键，status null
  const noid = list.find((t) => t.taskId === null);
  assert.ok(noid);
  assert.strictEqual(noid.status, null);
  assert.ok(noid.key.startsWith('unknown:'));
  // 非对象 JSON -> 跳过
  assert.ok(!list.some((t) => t.taskId === 'arr'));
  // 磁盘 cron：c1 完整字段、c2 缺字段 -> missing 标注
  const dc1 = byKey('s1:c1');
  assert.ok(dc1, '磁盘 cron 应存在');
  assert.strictEqual(dc1.kind, 'cron');
  assert.strictEqual(dc1.source, 'disk');
  assert.strictEqual(dc1.confidence, 'medium');
  assert.strictEqual(dc1.status, 'running');
  assert.strictEqual(dc1.title, '每日备份');
  assert.deepStrictEqual(dc1.detail, { schedule: '0 2 * * *', description: '每日备份', enabled: true });
  const dc2 = byKey('s1:c2');
  assert.ok(dc2, '缺字段 cron 应存在且标注 missing');
  assert.deepStrictEqual(dc2.detail, { missing: ['schedule', 'description', 'enabled'] });
  assert.strictEqual(dc2.title, 'c2'); // description 缺 -> id 兜底
  assert.ok(!list.some((t) => t.taskId === 'badcron' || t.taskId === 'arrcron'), '坏 cron JSON 应跳过');
  assert.strictEqual(list.length, 8); // runtime 3 + 磁盘 tasks 3 + 磁盘 cron 2
  console.log('✅ 合并（runtime 赢 + 磁盘 tasks/cron 补充 + missing 标注）');

  // ---------- 2. diagnostics 计数 ----------
  assert.strictEqual(catalog.diagnostics.scannedFiles, 6); // s1 tasks:4 + s2 tasks:2
  assert.strictEqual(catalog.diagnostics.badFiles, 1); // bad.json 解析失败
  assert.strictEqual(catalog.diagnostics.badLines, 1); // arr.json 非对象
  assert.strictEqual(catalog.diagnostics.cronFiles, 2); // c1 + c2
  assert.strictEqual(catalog.diagnostics.badCronFiles, 2); // badcron.json + arrcron.json
  assert.deepStrictEqual(res.diagnostics, catalog.diagnostics); // 返回快照
  console.log('✅ diagnostics 计数');

  // ---------- 3. filter.sessionId ----------
  const s1res = await catalog.getCatalog({ sessionId: 's1' });
  const s1list = s1res.entries;
  assert.ok(s1list.every((t) => t.sessionId === 's1'));
  assert.ok(!s1list.some((t) => t.taskId === 'o1'));
  assert.strictEqual(s1list.length, 6); // t1 + t2 + t3 + unknown(缺字段文件属 s1) + c1 + c2
  const s3res = await catalog.getCatalog({ sessionId: 's3' });
  assert.strictEqual(s3res.entries.length, 1);
  console.log('✅ filter.sessionId');

  // ---------- 4. cron 观察生命周期（Create -> List -> Delete，独立 catalog 隔离磁盘） ----------
  const state2 = new RuntimeState();
  const cObs = new TaskCatalog({ runtimeState: state2, sessionsRoot: path.join(tmpDir, 'nope') });
  // Create：tool_call（rawInput 携带身份）-> running
  cObs.observe(cronEv('s1', {
    sessionUpdate: 'tool_call', toolCallId: '1:tool_nightly000000000000000',
    title: 'CronCreate', status: 'pending',
    rawInput: { name: 'nightly', schedule: '0 3 * * *', description: '夜间备份' },
  }));
  // Create：completed -> 同键覆盖为 completed
  cObs.observe(cronEv('s1', {
    sessionUpdate: 'tool_call_update', toolCallId: '1:tool_nightly000000000000000',
    title: 'CronCreate', status: 'completed',
    rawInput: { name: 'nightly', schedule: '0 3 * * *', description: '夜间备份', command: 'npm run nightly' },
  }));
  let cres = await cObs.getCatalog();
  let nightly = cres.entries.find((e) => e.key === 's1:nightly');
  assert.ok(nightly, 'Create 应以 cron 身份（detail.name）落键');
  assert.strictEqual(nightly.kind, 'cron');
  assert.strictEqual(nightly.status, 'completed');
  assert.strictEqual(nightly.source, 'acp');
  assert.strictEqual(nightly.confidence, 'low');
  assert.strictEqual(nightly.title, '夜间备份');
  assert.ok(!('command' in nightly.detail), 'detail 不含 command');
  console.log('✅ cron 观察：Create 建/更新条目');

  // ---------- 5. cron 终态不被 running 覆盖 ----------
  cObs.observe(cronEv('s1', {
    sessionUpdate: 'tool_call', toolCallId: '1:tool_nightly000000000000000',
    title: 'CronCreate', status: 'pending',
    rawInput: { name: 'nightly', schedule: '0 3 * * *', description: '夜间备份' },
  })); // 迟到的 running 观察
  cres = await cObs.getCatalog();
  nightly = cres.entries.find((e) => e.key === 's1:nightly');
  assert.strictEqual(nightly.status, 'completed', '终态不可被 running 覆盖');
  console.log('✅ cron 终态不被 running 覆盖');

  // ---------- 6. CronList 批量刷新（upsert 列表项；终态条目不复活） ----------
  cObs.observe(cronEv('s1', {
    sessionUpdate: 'tool_call_update', toolCallId: '1:tool_list00000000000000000',
    title: 'CronList', status: 'completed', rawInput: {},
    rawOutput: JSON.stringify([
      { id: 'weekly', name: 'weekly', description: '每周任务', schedule: '0 4 * * 1' },
      { id: 'nightly' }, // 与已完成条目同键 -> 终态不复活
    ]),
  }));
  cres = await cObs.getCatalog();
  const weekly = cres.entries.find((e) => e.key === 's1:weekly');
  assert.ok(weekly, 'List 列表项应逐条 upsert');
  assert.strictEqual(weekly.status, 'running');
  assert.strictEqual(weekly.title, '每周任务');
  assert.strictEqual(weekly.detail.description, '每周任务');
  nightly = cres.entries.find((e) => e.key === 's1:nightly');
  assert.strictEqual(nightly.status, 'completed', 'List 不复活终态条目');
  console.log('✅ cron 观察：CronList 批量刷新');

  // ---------- 7. CronDelete -> removed；未见过删除忽略 ----------
  cObs.observe(cronEv('s1', {
    sessionUpdate: 'tool_call_update', toolCallId: '1:tool_del000000000000000000',
    title: 'CronDelete', status: 'completed', rawInput: { name: 'weekly' },
  }));
  cObs.observe(cronEv('s1', {
    sessionUpdate: 'tool_call_update', toolCallId: '1:tool_delghost000000000000000',
    title: 'CronDelete', status: 'completed', rawInput: { name: 'ghost' },
  }));
  cres = await cObs.getCatalog();
  assert.strictEqual(cres.entries.find((e) => e.key === 's1:weekly').status, 'removed');
  assert.ok(!cres.entries.some((e) => e.key === 's1:ghost'), '未见过的删除应忽略');
  // toolCallId 兜底键（rawInput 无身份）：Create 无 rawInput -> 键 = toolCallId
  cObs.observe(cronEv('s1', {
    sessionUpdate: 'tool_call', toolCallId: '1:tool_noid00000000000000000',
    title: 'CronCreate', status: 'pending',
  }));
  cres = await cObs.getCatalog();
  assert.ok(cres.entries.find((e) => e.key === 's1:1:tool_noid00000000000000000'));
  console.log('✅ cron 观察：CronDelete removed / 兜底键');

  // ---------- 8. tasktool.observed 互证：仅刷新 updatedAt，不新建、不改状态 ----------
  const state3 = new RuntimeState();
  state3.apply(normalizeWsEvent({ event: 'event.task.started', payload: { task_id: '0:tool_task1', title: '后台任务' }, session_id: 's1' }));
  const tAt = state3.getTasks({ sessionId: 's1', includeTerminal: true })[0].at; // ws 事件 at（Date.now）
  const cTt = new TaskCatalog({ runtimeState: state3, sessionsRoot: path.join(tmpDir, 'nope') });
  let tres = await cTt.getCatalog();
  let task1 = tres.entries.find((e) => e.key === 's1:0:tool_task1');
  assert.strictEqual(task1.updatedAt, tAt);
  assert.strictEqual(task1.status, 'running');
  // 同键互证（at 更大 -> updatedAt 刷新；状态不变）
  cTt.observe(tasktoolEv('s1', '0:tool_task1', tAt + 500, 'completed'));
  tres = await cTt.getCatalog();
  task1 = tres.entries.find((e) => e.key === 's1:0:tool_task1');
  assert.strictEqual(task1.updatedAt, tAt + 500, '互证应刷新 updatedAt');
  assert.strictEqual(task1.status, 'running', '互证不覆盖状态');
  // 无 runtime 同键 -> 不新建条目
  cTt.observe(tasktoolEv('s1', '0:tool_never', tAt + 999, 'running'));
  tres = await cTt.getCatalog();
  assert.ok(!tres.entries.some((e) => e.key === 's1:0:tool_never'), 'tasktool 不新建条目');
  // taskId 缺失 -> 忽略
  cTt.observe({ ...tasktoolEv('s1', '', tAt, 'running'), taskId: null });
  console.log('✅ tasktool 互证（仅 updatedAt）');

  // ---------- 9. 合并优先级：runtime > observe(cronEntries) > disk ----------
  const state4 = new RuntimeState();
  state4.apply(normalizeWsEvent({ event: 'event.task.started', payload: { task_id: 'rtask', title: '运行时任务' }, session_id: 's1' }));
  // 磁盘 s1/tasks/t1.json(running) vs runtime 终态 -> runtime 赢（磁盘 running 不覆盖内存终态）
  state4.apply(normalizeWsEvent({ event: 'event.task.completed', payload: { task_id: 't1', title: '运行时t1' }, session_id: 's1' }));
  const cPri = new TaskCatalog({ runtimeState: state4, sessionsRoot });
  // 磁盘 s1:c1（disk medium）vs observe Create(name='c1') -> cronEntries 赢
  cPri.observe(cronEv('s1', {
    sessionUpdate: 'tool_call', toolCallId: '1:tool_c1create0000000000000',
    title: 'CronCreate', status: 'pending', rawInput: { name: 'c1', schedule: '0 5 * * *' },
  }));
  // runtime s1:rtask vs observe 同键（toolCallId 兜底）-> runtime 赢
  cPri.observe(cronEv('s1', {
    sessionUpdate: 'tool_call', toolCallId: 'rtask', title: 'CronCreate', status: 'pending',
  }));
  const pres = await cPri.getCatalog();
  const pc1 = pres.entries.find((e) => e.key === 's1:c1');
  assert.strictEqual(pc1.source, 'acp', 'cronEntries 覆盖磁盘');
  assert.strictEqual(pc1.confidence, 'low');
  const prtask = pres.entries.find((e) => e.key === 's1:rtask');
  assert.strictEqual(prtask.source, 'ws', 'runtime 赢 cronEntries');
  assert.strictEqual(prtask.kind, 'task');
  // 磁盘 running 不覆盖内存终态（t1 已在第 1 节覆盖：磁盘 running vs runtime completed）
  assert.strictEqual(pres.entries.find((e) => e.key === 's1:t1').status, 'completed');
  console.log('✅ 合并优先级 runtime > observe > disk');

  // ---------- 10. clearSession：清理该会话 cronEntries / tasktool 互证 ----------
  cPri.observe(cronEv('s1', {
    sessionUpdate: 'tool_call', toolCallId: '1:tool_s1cron0000000000000000',
    title: 'CronCreate', status: 'pending', rawInput: { name: 's1cron', schedule: '0 6 * * *' },
  }));
  cPri.observe(cronEv('s2', {
    sessionUpdate: 'tool_call', toolCallId: '1:tool_s2cron0000000000000000',
    title: 'CronCreate', status: 'pending', rawInput: { name: 's2cron', schedule: '0 7 * * *' },
  }));
  let pre2 = await cPri.getCatalog();
  assert.ok(pre2.entries.find((e) => e.key === 's1:s1cron'));
  assert.ok(pre2.entries.find((e) => e.key === 's2:s2cron'));
  cPri.clearSession('s1');
  pre2 = await cPri.getCatalog();
  assert.ok(!pre2.entries.find((e) => e.key === 's1:s1cron'), 's1 观察条目应被清理');
  assert.ok(pre2.entries.find((e) => e.key === 's2:s2cron'), 's2 观察条目应保留');
  assert.ok(pre2.entries.find((e) => e.key === 's1:c1'), '磁盘 cron 不受 clearSession 影响');
  assert.ok(pre2.entries.find((e) => e.key === 's1:rtask'), 'runtime 快照不受 clearSession 影响');
  console.log('✅ clearSession 会话清理');

  // ---------- 11. sessionsRoot 不存在 -> 空不抛错（仅 runtime + 观察） ----------
  const c2 = new TaskCatalog({ runtimeState: state, sessionsRoot: path.join(tmpDir, 'nope') });
  const only = await c2.getCatalog();
  assert.strictEqual(only.entries.length, 3); // s1:t1 + s1:t3 + s3:t3
  assert.strictEqual(c2.diagnostics.scannedFiles, 0);
  assert.strictEqual(c2.diagnostics.cronFiles, 0);
  console.log('✅ sessionsRoot 不存在容错');

  console.log('\n全部 task-catalog 测试通过');
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
