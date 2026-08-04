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
  // 同键互证（at 更大 -> updatedAt 刷新；状态不变；返回 true 供主进程 scheduleWorkspaceActivities 响应）
  assert.strictEqual(cTt.observe(tasktoolEv('s1', '0:tool_task1', tAt + 500, 'completed')), true,
    'tasktool 互证刷新可见 updatedAt 应返回 true');
  tres = await cTt.getCatalog();
  task1 = tres.entries.find((e) => e.key === 's1:0:tool_task1');
  assert.strictEqual(task1.updatedAt, tAt + 500, '互证应刷新 updatedAt');
  assert.strictEqual(task1.status, 'running', '互证不覆盖状态');
  assert.strictEqual(cTt.observe(tasktoolEv('s1', '0:tool_task1', tAt + 500, 'completed')), false,
    '重复等价 tasktool 观察应返回 false');
  // 无 runtime 同键 -> 不新建条目（互证不参与 catalog，可见状态不变 -> false）
  assert.strictEqual(cTt.observe(tasktoolEv('s1', '0:tool_never', tAt + 999, 'running')), false,
    '无 runtime 同键的互证不改变可见状态');
  tres = await cTt.getCatalog();
  assert.ok(!tres.entries.some((e) => e.key === 's1:0:tool_never'), 'tasktool 不新建条目');
  // taskId 缺失 -> 忽略
  assert.strictEqual(cTt.observe({ ...tasktoolEv('s1', '', tAt, 'running'), taskId: null }), false,
    'taskId 缺失互证忽略');
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

  // ---------- 12. sessionDir 直读（两级目录）：只返回目标会话磁盘条目，不扫描 sessionsRoot ----------
  // 布局：sessionsRoot/<wdKey>/<sessionId>/tasks|cron；另有同 id 异 wdKey 与同级其他会话目录
  writeJson('wdA/session_s1/tasks/t1.json', { id: 't1', status: 'completed', title: '直读任务' });
  writeJson('wdA/session_s1/tasks/t2.json', { id: 't2', status: 'running', description: '直读运行' });
  writeJson('wdA/session_s1/cron/c1.json', { id: 'c1', schedule: '0 2 * * *', description: '直读计划', enabled: true });
  writeJson('wdA/session_s2/tasks/o1.json', { id: 'o1', status: 'running', title: '另一会话' });
  writeJson('wdB/session_s1/tasks/o2.json', { id: 'o2', status: 'running', title: '同 id 异 wdKey' });

  const s1Dir = path.join(sessionsRoot, 'wdA', 'session_s1');
  const catalogD = new TaskCatalog({ runtimeState: new RuntimeState(), sessionsRoot });

  // 哨兵：直读模式不得 readdir sessionsRoot（monkeypatch fs.promises.readdir 计数）
  const origReaddir = fs.promises.readdir;
  let rootReaddirCalls = 0;
  fs.promises.readdir = async function (p, ...rest) {
    if (p === sessionsRoot) rootReaddirCalls++;
    return origReaddir.call(this, p, ...rest);
  };
  let dres;
  try {
    dres = await catalogD.getCatalog({ sessionId: 'session_s1', sessionDir: s1Dir });
  } finally {
    fs.promises.readdir = origReaddir;
  }
  assert.strictEqual(rootReaddirCalls, 0, 'sessionDir 直读不得 readdir sessionsRoot');
  assert.deepStrictEqual(dres.entries.map((e) => e.key).sort(), ['session_s1:c1', 'session_s1:t1', 'session_s1:t2']);
  assert.ok(dres.entries.every((e) => e.sessionId === 'session_s1'), '直读只返回目标会话条目');
  assert.ok(dres.entries.every((e) => e.source === 'disk'));
  // 直读模式 diagnostics 计数正常（tasks 2 + cron 1）
  assert.strictEqual(catalogD.diagnostics.scannedFiles, 2);
  assert.strictEqual(catalogD.diagnostics.cronFiles, 1);
  assert.ok(!('invalidSessionDir' in catalogD.diagnostics), '合法 sessionDir 不写无效标记');
  console.log('✅ sessionDir 直读（哨兵证明不扫描 sessionsRoot）');

  // ---------- 13. 无效 sessionDir：绝不读盘不抛，只写本次 diagnostics ----------
  const catInv = new TaskCatalog({ runtimeState: new RuntimeState(), sessionsRoot });
  writeJson('wdA/plain.txt', { note: '普通文件（非目录）' }); // 13f 哨兵：basename 匹配但非目录
  // 哨兵：invalid sessionDir 也零 sessionsRoot 扫描（三态：invalid 绝不回退全量）
  const origReaddirInv = fs.promises.readdir;
  let rootReaddirCallsInv = 0;
  fs.promises.readdir = async function (p, ...rest) {
    if (p === sessionsRoot) rootReaddirCallsInv++;
    return origReaddirInv.call(this, p, ...rest);
  };
  let esc, abs, nf, ns, eq, pf;
  try {
    // 13a. .. 逃逸（lexical 越界）
    esc = await catInv.getCatalog({ sessionId: 'session_s1', sessionDir: path.join(sessionsRoot, '..', 'evil') });
    assert.strictEqual(esc.entries.length, 0, '越界 sessionDir 不读盘');
    assert.strictEqual(esc.diagnostics.invalidSessionDir, 'outside-root');
    // 13b. 绝对路径（win 下不同盘或深层 ../ 一律拒绝）
    abs = await catInv.getCatalog({ sessionId: 'session_s1', sessionDir: 'C:\\Windows' });
    assert.strictEqual(abs.entries.length, 0);
    assert.strictEqual(abs.diagnostics.invalidSessionDir, 'outside-root');
    // 13c. 目录不存在（lexical 合法但 lstat/realpath 失败）
    nf = await catInv.getCatalog({ sessionId: 'session_s1', sessionDir: path.join(sessionsRoot, 'wdA', 'ghost') });
    assert.strictEqual(nf.entries.length, 0, '目录不存在不读盘');
    assert.strictEqual(nf.diagnostics.invalidSessionDir, 'not-found');
    // 13d. 非字符串
    ns = await catInv.getCatalog({ sessionId: 'session_s1', sessionDir: 42 });
    assert.strictEqual(ns.entries.length, 0);
    assert.strictEqual(ns.diagnostics.invalidSessionDir, 'not-string');
    // 13e. 等于 sessionsRoot 本身（rel === '' -> 拒绝）
    eq = await catInv.getCatalog({ sessionId: 'session_s1', sessionDir: sessionsRoot });
    assert.strictEqual(eq.entries.length, 0);
    assert.strictEqual(eq.diagnostics.invalidSessionDir, 'outside-root');
    // 13f. 普通文件（basename 与 sessionId 匹配但非目录）-> not-directory，绝不视作 direct
    pf = await catInv.getCatalog({ sessionId: 'plain.txt', sessionDir: path.join(sessionsRoot, 'wdA', 'plain.txt') });
    assert.strictEqual(pf.entries.length, 0, '普通文件不读盘');
    assert.strictEqual(pf.diagnostics.invalidSessionDir, 'not-directory');
  } finally {
    fs.promises.readdir = origReaddirInv;
  }
  assert.strictEqual(rootReaddirCallsInv, 0, 'invalid sessionDir 不得 readdir sessionsRoot（绝不回退全量扫描）');
  console.log('✅ 无效 sessionDir 绝不读盘不抛（哨兵证明零 sessionsRoot 扫描 + diagnostics 标注）');

  // ---------- 14. sessionId 与 sessionDir 绑定：direct 目录 basename 必须等于 filter.sessionId，错配 invalid 绝不读盘 ----------
  const catX = new TaskCatalog({ runtimeState: new RuntimeState(), sessionsRoot });
  // sessionId 与 sessionDir 目录名一致 -> 正常直读
  const same = await catX.getCatalog({ sessionId: 'session_s1', sessionDir: s1Dir });
  assert.strictEqual(same.entries.length, 3);
  // sessionId 与目录名不一致 -> invalid（session-id-mismatch），绝不读盘（哨兵证明）
  const origReaddirX = fs.promises.readdir;
  let rootReaddirCallsX = 0;
  fs.promises.readdir = async function (p, ...rest) {
    if (p === sessionsRoot) rootReaddirCallsX++;
    return origReaddirX.call(this, p, ...rest);
  };
  let diff;
  try {
    diff = await catX.getCatalog({ sessionId: 'session_s2', sessionDir: s1Dir });
  } finally {
    fs.promises.readdir = origReaddirX;
  }
  assert.strictEqual(diff.entries.length, 0, '会话 ID 与目录名错配 -> 空（不读盘）');
  assert.strictEqual(diff.diagnostics.invalidSessionDir, 'session-id-mismatch');
  assert.strictEqual(rootReaddirCallsX, 0, 'session-id-mismatch 不得 readdir sessionsRoot');
  // {sessionId:'B', sessionDir:'.../session_A'} 形态
  const misB = await catX.getCatalog({ sessionId: 'B', sessionDir: s1Dir });
  assert.strictEqual(misB.entries.length, 0);
  assert.strictEqual(misB.diagnostics.invalidSessionDir, 'session-id-mismatch');
  console.log('✅ sessionId 与 sessionDir 绑定（错配 invalid，绝不读盘）');

  // ---------- 15. Tasks/Cron 后代链接严格拒绝：junction/symlink 指向 root 外，不读外部 JSON ----------
  const externalDir = path.join(tmpDir, 'external');
  fs.mkdirSync(path.join(externalDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(externalDir, 'tasks', 'external.json'),
    JSON.stringify({ id: 'external', status: 'running', title: '外部任务' }), 'utf8');
  // 15a. tasks 目录是 junction（Windows 无权限要求）指向 root 外 -> 整目录跳过
  const lnkDir = path.join(sessionsRoot, 'wdA', 'session_lnk');
  fs.mkdirSync(lnkDir, { recursive: true });
  let junctionCreated = false;
  try {
    fs.symlinkSync(externalDir, path.join(lnkDir, 'tasks'), 'junction');
    junctionCreated = true;
  } catch (e) {
    console.log('跳过 junction 创建（不可用）:', e.code);
  }
  const catLnk = new TaskCatalog({ runtimeState: new RuntimeState(), sessionsRoot });
  const lnkRes = await catLnk.getCatalog({ sessionId: 'session_lnk', sessionDir: lnkDir });
  assert.strictEqual(lnkRes.entries.length, 0, 'tasks junction 不读外部 JSON');
  assert.ok(!lnkRes.entries.some((t) => t.taskId === 'external'));
  if (junctionCreated) {
    assert.strictEqual(lnkRes.diagnostics.skippedLinks, 1, 'tasks junction 计 skippedLinks');
  }
  // 15b. cron 目录是 junction -> 整目录跳过
  fs.mkdirSync(path.join(externalDir, 'cron'), { recursive: true });
  fs.writeFileSync(path.join(externalDir, 'cron', 'extcron.json'),
    JSON.stringify({ id: 'extcron', schedule: '0 2 * * *', description: '外部计划' }), 'utf8');
  let cronJunctionCreated = false;
  try {
    fs.symlinkSync(path.join(externalDir, 'cron'), path.join(lnkDir, 'cron'), 'junction');
    cronJunctionCreated = true;
  } catch (e) {
    console.log('跳过 cron junction 创建（不可用）:', e.code);
  }
  const catLnk2 = new TaskCatalog({ runtimeState: new RuntimeState(), sessionsRoot });
  const lnkRes2 = await catLnk2.getCatalog({ sessionId: 'session_lnk', sessionDir: lnkDir });
  assert.ok(!lnkRes2.entries.some((t) => t.taskId === 'extcron'), 'cron junction 不读外部 JSON');
  if (junctionCreated && cronJunctionCreated) {
    assert.strictEqual(lnkRes2.diagnostics.skippedLinks, 2, 'tasks + cron junction 均计 skippedLinks');
  }
  // 15c. 枚举文件是 symlink（指向 root 外）-> 该文件跳过（Windows 文件 symlink 需权限，失败则跳过本子断言）
  const fileLinkDir = path.join(sessionsRoot, 'wdA', 'session_f');
  fs.mkdirSync(path.join(fileLinkDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(fileLinkDir, 'tasks', 'ok.json'), JSON.stringify({ id: 'ok1', status: 'completed', title: '正常' }), 'utf8');
  let fileSymlinkCreated = false;
  try {
    fs.symlinkSync(path.join(externalDir, 'tasks', 'external.json'), path.join(fileLinkDir, 'tasks', 'evil.json'));
    fileSymlinkCreated = true;
  } catch (e) {
    console.log('跳过文件 symlink 创建（权限不足）:', e.code);
  }
  const catFl = new TaskCatalog({ runtimeState: new RuntimeState(), sessionsRoot });
  const flRes = await catFl.getCatalog({ sessionId: 'session_f', sessionDir: fileLinkDir });
  assert.ok(flRes.entries.some((t) => t.taskId === 'ok1'), '正常文件仍读');
  assert.ok(!flRes.entries.some((t) => t.taskId === 'external'), 'symlink 文件不读外部 JSON');
  assert.strictEqual(flRes.diagnostics.scannedFiles, 1);
  if (fileSymlinkCreated) {
    assert.strictEqual(flRes.diagnostics.skippedLinks, 1, '文件 symlink 计 skippedLinks');
  }
  console.log('✅ 链接严格拒绝（junction/symlink 指向 root 外不读外部 JSON，skippedLinks 记录）');

  // ---------- 16. observe 返回 boolean：_cronEntries 实际变更信号（create/list/delete / 重复 observe） ----------
  const st5 = new RuntimeState();
  const cObs5 = new TaskCatalog({ runtimeState: st5, sessionsRoot: path.join(tmpDir, 'nope') });
  const mkCreate = (name, updateStatus) => cronEv('s1', {
    sessionUpdate: updateStatus === 'completed' ? 'tool_call_update' : 'tool_call',
    toolCallId: `1:tool_${name}0000000000000000`,
    title: 'CronCreate', status: updateStatus,
    rawInput: { name, schedule: '0 3 * * *', description: `${name} desc` },
  });
  const mkList = (items) => cronEv('s1', {
    sessionUpdate: 'tool_call_update', toolCallId: '1:tool_list00000000000000000',
    title: 'CronList', status: 'completed', rawInput: {},
    rawOutput: JSON.stringify(items),
  });
  const mkDelete = (name) => cronEv('s1', {
    sessionUpdate: 'tool_call_update', toolCallId: `1:tool_del${name}000000000000000`,
    title: 'CronDelete', status: 'completed', rawInput: { name },
  });
  assert.strictEqual(cObs5.observe(mkCreate('a1', 'pending')), true, '新 Create -> true');
  assert.strictEqual(cObs5.observe(mkCreate('a1', 'pending')), false, '重复相同 Create -> false');
  assert.strictEqual(cObs5.observe(mkCreate('a1', 'completed')), true, 'Create 状态推进 -> true');
  assert.strictEqual(cObs5.observe(mkCreate('a1', 'completed')), false, '重复相同终态 -> false');
  assert.strictEqual(cObs5.observe(mkCreate('a1', 'pending')), false, '终态后迟到 running 被拦截 -> false');
  assert.strictEqual(cObs5.observe(mkList([{ id: 'b1', name: 'b1', description: 'b1 desc' }])), true, 'List 新项 -> true');
  assert.strictEqual(cObs5.observe(mkList([{ id: 'b1', name: 'b1', description: 'b1 desc' }])), false, '重复相同 List -> false');
  assert.strictEqual(cObs5.observe(mkDelete('b1')), true, 'Delete 已存在条目 -> true');
  assert.strictEqual(cObs5.observe(mkDelete('b1')), false, '重复 Delete（removed 再删）-> false');
  assert.strictEqual(cObs5.observe(mkDelete('ghost')), false, '未见过的 Delete -> false');
  assert.strictEqual(cObs5.observe(null), false, '无效事件 -> false');
  assert.strictEqual(cObs5.observe(tasktoolEv('s1', '0:tool_x', Date.now(), 'running')), false, 'tasktool 不触碰 cronEntries -> false');
  // 观察后条目语义保持原合并口径
  const obsRes = await cObs5.getCatalog();
  assert.strictEqual(obsRes.entries.find((e) => e.key === 's1:a1').status, 'completed');
  assert.strictEqual(obsRes.entries.find((e) => e.key === 's1:b1').status, 'removed');
  // tasktool.observed 变更信号：runtime 同键且 at 推进改变可见 updatedAt -> true；其余 -> false
  const stTt = new RuntimeState();
  stTt.apply(normalizeWsEvent({ event: 'event.task.started', payload: { task_id: 'toolA', title: '工具任务' }, session_id: 's1' }));
  const tAtA = stTt.getTasks({ sessionId: 's1', includeTerminal: true })[0].at;
  const cTt5 = new TaskCatalog({ runtimeState: stTt, sessionsRoot: path.join(tmpDir, 'nope') });
  assert.strictEqual(cTt5.observe(tasktoolEv('s1', 'toolA', tAtA - 100, 'running')), false,
    '首次观察未超过 runtime.at -> 可见 updatedAt 不变 false');
  assert.strictEqual(cTt5.observe(tasktoolEv('s1', 'toolA', tAtA + 500, 'running')), true,
    '首次观察超过 runtime.at -> 可见 updatedAt 刷新 true');
  assert.strictEqual(cTt5.observe(tasktoolEv('s1', 'toolA', tAtA + 500, 'running')), false, '重复等价观察 -> false');
  assert.strictEqual(cTt5.observe(tasktoolEv('s1', 'toolA', tAtA + 200, 'running')), false, '倒退观察 -> false');
  assert.strictEqual(cTt5.observe(tasktoolEv('s1', 'toolA', tAtA + 900, 'running')), true, '观察持续推进 -> true');
  const ttRes = await cTt5.getCatalog();
  assert.strictEqual(ttRes.entries.find((e) => e.key === 's1:toolA').updatedAt, tAtA + 900, '可见 updatedAt 随互证推进');
  console.log('✅ observe 返回 boolean 变更信号（create/list/delete 与重复 observe 的 true/false）');

  // ---------- 17. 每次 getCatalog diagnostics 独立：不共享不累积，非法请求不污染后续快照 ----------
  const catD2 = new TaskCatalog({ runtimeState: new RuntimeState(), sessionsRoot });
  const d1 = await catD2.getCatalog();
  const d2 = await catD2.getCatalog();
  assert.strictEqual(d2.diagnostics.scannedFiles, d1.diagnostics.scannedFiles, '连续调用计数不翻倍');
  assert.strictEqual(d2.diagnostics.cronFiles, d1.diagnostics.cronFiles);
  assert.deepStrictEqual(d2.diagnostics, d1.diagnostics, '两次合法调用 diagnostics 相同');
  assert.strictEqual(catD2.diagnostics.scannedFiles, d2.diagnostics.scannedFiles, '实例快照 = 最近一次');
  // 非法请求（session-id-mismatch）不污染后续合法快照
  await catD2.getCatalog({ sessionId: 'B', sessionDir: s1Dir });
  const d3 = await catD2.getCatalog({ sessionId: 'session_s1', sessionDir: s1Dir });
  assert.ok(!('invalidSessionDir' in d3.diagnostics), '非法请求不污染后续合法快照');
  assert.strictEqual(d3.diagnostics.scannedFiles, 2, '合法直读快照计数干净（tasks 2）');
  assert.strictEqual(d3.entries.length, 3);
  console.log('✅ 每次 getCatalog diagnostics 独立（不累积、不污染）');

  // ---------- 18. M6 资源上限：超大 task/cron JSON、过量文件、总预算耗尽均安全跳过不抛 ----------
  {
    const stLim = new RuntimeState();
    const catLim = new TaskCatalog({ runtimeState: stLim, sessionsRoot });
    const L = TaskCatalog.LIMITS;
    // 18a. 超大 task JSON（> TASK_MAX_BYTES）与超大 cron JSON：跳过不读、不解析、不抛
    writeJson('sLim/tasks/big1.json', { id: 'big1', status: 'running', title: '超大', padding: 'x'.repeat(L.TASK_MAX_BYTES + 1024) });
    writeJson('sLim/tasks/small1.json', { id: 'small1', status: 'completed', title: '小任务' });
    writeJson('sLim/cron/bigc1.json', { id: 'bigc1', schedule: '0 2 * * *', padding: 'x'.repeat(L.CRON_MAX_BYTES + 1024) });
    writeJson('sLim/cron/smallc1.json', { id: 'smallc1', schedule: '0 3 * * *', description: '小计划' });
    const limRes = await catLim.getCatalog({ sessionId: 'sLim', sessionDir: path.join(sessionsRoot, 'sLim') });
    assert.ok(!limRes.entries.some((e) => e.taskId === 'big1'), '超大 task JSON 不读');
    assert.ok(!limRes.entries.some((e) => e.taskId === 'bigc1'), '超大 cron JSON 不读');
    assert.ok(limRes.entries.some((e) => e.taskId === 'small1'), '合法小 task 保持');
    assert.ok(limRes.entries.some((e) => e.taskId === 'smallc1'), '合法小 cron 保持');
    assert.strictEqual(limRes.diagnostics.oversizedFiles, 1);
    assert.strictEqual(limRes.diagnostics.oversizedCronFiles, 1);
    assert.strictEqual(limRes.diagnostics.scannedFiles, 2); // big1 + small1 均为扫描候选
    assert.strictEqual(limRes.diagnostics.cronFiles, 1); // 仅 smallc1 解析成功
    assert.strictEqual(limRes.diagnostics.badFiles, 0); // 超大小不算坏文件
    assert.strictEqual(limRes.diagnostics.badCronFiles, 0);
    assert.strictEqual(limRes.diagnostics.skippedFiles, 0);
    assert.strictEqual(limRes.diagnostics.skippedCronFiles, 0);
    assert.ok(limRes.diagnostics.bytesRead > 0);
    assert.ok(limRes.diagnostics.cronBytesRead > 0);

    // 18b. 过量 task JSON 文件：只读前 TASK_MAX_FILES 个，其余跳过
    for (let i = 0; i < L.TASK_MAX_FILES + 5; i++) {
      writeJson(`sLim2/tasks/t${i}.json`, { id: `t${i}`, status: 'running', title: `任务${i}` });
    }
    const overRes = await catLim.getCatalog({ sessionId: 'sLim2', sessionDir: path.join(sessionsRoot, 'sLim2') });
    assert.strictEqual(overRes.entries.filter((e) => e.kind === 'task').length, L.TASK_MAX_FILES);
    assert.strictEqual(overRes.diagnostics.scannedFiles, L.TASK_MAX_FILES);
    assert.strictEqual(overRes.diagnostics.skippedFiles, 5);

    // 18c. 过量 cron JSON 文件：只读前 CRON_MAX_FILES 个，其余跳过
    for (let i = 0; i < L.CRON_MAX_FILES + 5; i++) {
      writeJson(`sLim3/cron/nc${i}.json`, { id: `nc${i}`, schedule: '0 4 * * *' });
    }
    const cronOverRes = await catLim.getCatalog({ sessionId: 'sLim3', sessionDir: path.join(sessionsRoot, 'sLim3') });
    assert.strictEqual(cronOverRes.entries.filter((e) => e.kind === 'cron').length, L.CRON_MAX_FILES);
    assert.strictEqual(cronOverRes.diagnostics.cronFiles, L.CRON_MAX_FILES);
    assert.strictEqual(cronOverRes.diagnostics.skippedCronFiles, 5);

    // 18d. tasks 总字节预算耗尽：后续文件跳过（JSON 不截断读），累计读取不超预算
    for (let i = 0; i < 60; i++) {
      writeJson(`sLim4/tasks/b${i}.json`, { id: `b${i}`, status: 'running', title: 'x'.repeat(100 * 1024) });
    }
    const budgetRes = await catLim.getCatalog({ sessionId: 'sLim4', sessionDir: path.join(sessionsRoot, 'sLim4') });
    const nTask = budgetRes.entries.filter((e) => e.kind === 'task').length;
    assert.ok(budgetRes.diagnostics.bytesRead <= L.TASK_TOTAL_BYTES, 'tasks 总读取不超预算');
    assert.strictEqual(budgetRes.diagnostics.skippedFiles, 60 - nTask, '预算耗尽后跳过');
    assert.ok(budgetRes.diagnostics.skippedFiles > 0);
    assert.ok(nTask >= 38 && nTask <= 40, '预算内文件照常解析');
    assert.strictEqual(budgetRes.diagnostics.badFiles, 0);

    // 18e. cron 总字节预算耗尽
    for (let i = 0; i < 30; i++) {
      writeJson(`sLim5/cron/bc${i}.json`, { id: `bc${i}`, schedule: '0 2 * * *', padding: 'x'.repeat(100 * 1024) });
    }
    const cronBudgetRes = await catLim.getCatalog({ sessionId: 'sLim5', sessionDir: path.join(sessionsRoot, 'sLim5') });
    const nCron = cronBudgetRes.entries.filter((e) => e.kind === 'cron').length;
    assert.ok(cronBudgetRes.diagnostics.cronBytesRead <= L.CRON_TOTAL_BYTES, 'cron 总读取不超预算');
    assert.strictEqual(cronBudgetRes.diagnostics.skippedCronFiles, 30 - nCron, 'cron 预算耗尽后跳过');
    assert.ok(cronBudgetRes.diagnostics.skippedCronFiles > 0);

    // 18f. 每次调用独立：限额动作不污染后续合法调用（不共享不累积）
    const afterRes = await catLim.getCatalog({ sessionId: 'sLim', sessionDir: path.join(sessionsRoot, 'sLim') });
    assert.strictEqual(afterRes.diagnostics.oversizedFiles, 1);
    assert.strictEqual(afterRes.diagnostics.oversizedCronFiles, 1);
    assert.strictEqual(afterRes.diagnostics.skippedFiles, 0);
    assert.strictEqual(afterRes.diagnostics.skippedCronFiles, 0);
    assert.ok(afterRes.entries.some((e) => e.taskId === 'small1'));
    console.log('✅ M6 资源上限（超大 task/cron、过量文件、总预算耗尽、每次调用独立）');
  }

  // ---------- 19. M6 上限缺口：目录流式有界枚举 / 句柄级有限读取 / 最终条目与观察 map 上限 ----------
  {
    const L = TaskCatalog.LIMITS;
    // 19a. 超量目录不完整物化：文件数超过枚举候选上限 -> 达到候选上限即停止（不物化剩余条目）
    const stE = new RuntimeState();
    const catE = new TaskCatalog({ runtimeState: stE, sessionsRoot });
    for (let i = 0; i < L.TASK_ENUM_MAX + 60; i++) {
      writeJson(`sEnum/tasks/f${i}.json`, { id: `f${i}`, status: 'running', title: `任务${i}` });
    }
    const enumRes = await catE.getCatalog({ sessionId: 'sEnum', sessionDir: path.join(sessionsRoot, 'sEnum') });
    assert.strictEqual(enumRes.diagnostics.enumerateTruncated, true, '枚举达到候选上限即停止并标记');
    assert.strictEqual(enumRes.entries.filter((e) => e.kind === 'task').length, L.TASK_MAX_FILES, '处理数不超读取上限');
    assert.strictEqual(enumRes.diagnostics.scannedFiles, L.TASK_MAX_FILES);
    assert.strictEqual(enumRes.diagnostics.skippedFiles, L.TASK_ENUM_MAX - L.TASK_MAX_FILES, '候选上限内剩余文件被跳过');
    console.log('✅ M6 目录流式有界枚举（候选上限停止、不物化剩余、截断标记可见）');

    // 19b. 句柄级有限读取：fstat 报放大 size（模拟文件实际大于预检/预算）-> 跳过不读、零读入
    const stH = new RuntimeState();
    const catH = new TaskCatalog({ runtimeState: stH, sessionsRoot });
    writeJson('sH/tasks/grow.json', { id: 'grow', status: 'running', title: '增长文件' });
    const realOpen = fs.promises.open;
    let opened = 0;
    fs.promises.open = async function (p, flags) {
      const fh = await realOpen.call(this, p, flags);
      opened++;
      return {
        stat: async () => ({ ...(await fh.stat()), size: L.TASK_MAX_BYTES + 1024 }), // 句柄报超上限大小
        read: (buf, offset, length, pos) => fh.read(buf, offset, length, pos),
        close: () => fh.close(),
      };
    };
    let hres;
    try {
      hres = await catH.getCatalog({ sessionId: 'sH', sessionDir: path.join(sessionsRoot, 'sH') });
    } finally {
      fs.promises.open = realOpen;
    }
    assert.strictEqual(hres.entries.length, 0, '实际大于预检的文件不读');
    assert.strictEqual(hres.diagnostics.oversizedFiles, 1);
    assert.strictEqual(hres.diagnostics.bytesRead, 0, '零读入，不突破总预算');
    assert.ok(opened >= 1, '句柄级 open 被使用');

    // 19c. 句柄级有限读取：fstat 报小 size（模拟文件被替换为更大）-> 只读句柄大小字节，
    // bytesRead 反映实际读入（绝不整文件无界 readFile）
    const stR = new RuntimeState();
    const catR = new TaskCatalog({ runtimeState: stR, sessionsRoot });
    writeJson('sH2/tasks/repl.json', { id: 'repl', status: 'running', title: 'x'.repeat(50 * 1024) }); // 真实 ~50KB
    const realOpen2 = fs.promises.open;
    fs.promises.open = async function (p, flags) {
      const fh = await realOpen2.call(this, p, flags);
      return {
        stat: async () => ({ ...(await fh.stat()), size: 64 }), // 只报 64 字节
        read: (buf, offset, length, pos) => fh.read(buf, offset, length, pos),
        close: () => fh.close(),
      };
    };
    let rres;
    try {
      rres = await catR.getCatalog({ sessionId: 'sH2', sessionDir: path.join(sessionsRoot, 'sH2') });
    } finally {
      fs.promises.open = realOpen2;
    }
    assert.strictEqual(rres.diagnostics.bytesRead, 64, 'bytesRead 反映实际读入（受限于句柄大小）');
    assert.strictEqual(rres.diagnostics.badFiles, 1, '64 字节截断 JSON 解析失败计坏文件');
    assert.strictEqual(rres.entries.length, 0);
    console.log('✅ M6 句柄级有限读取（实际大于预检/替换均不突破预算、bytesRead 为实际读入）');

    // 19d. 最终 catalog 条目上限：确定性截断（at 最新优先保留），diagnostics 可见，小数据不触发
    const origCap = L.MAX_CATALOG_ENTRIES;
    L.MAX_CATALOG_ENTRIES = 4;
    try {
      const stC = new RuntimeState();
      const catC = new TaskCatalog({ runtimeState: stC, sessionsRoot: path.join(tmpDir, 'nope') });
      for (let i = 0; i < 6; i++) {
        stC.apply({
          kind: 'task.started', taskId: `c${i}`, sessionId: 'sC', title: `任务${i}`,
          status: 'running', at: 1785553000000 + i * 1000, source: 'ws', confidence: 'high', rawKind: 'test',
        });
      }
      const cres = await catC.getCatalog({ sessionId: 'sC' });
      assert.strictEqual(cres.entries.length, 4, '最终条目超上限确定性截断');
      assert.strictEqual(cres.diagnostics.entriesTruncated, true);
      assert.deepStrictEqual(cres.entries.map((e) => e.taskId), ['c5', 'c4', 'c3', 'c2'], '保留 at 最新 4 条（降序）');
      assert.strictEqual(catC.truncation.catalogTruncated, true, '截断标记经 truncation 可见');
    } finally {
      L.MAX_CATALOG_ENTRIES = origCap;
    }

    // 19e. in-memory cron 观察 map 条目上限：确定性驱逐 at 最小（最老）条目，不抛
    const origCron = L.MAX_CRON_ENTRIES;
    L.MAX_CRON_ENTRIES = 3;
    try {
      const stD = new RuntimeState();
      const catD3 = new TaskCatalog({ runtimeState: stD, sessionsRoot: path.join(tmpDir, 'nope') });
      for (let i = 0; i < 6; i++) {
        catD3.observe(cronEv('sD', {
          sessionUpdate: 'tool_call', toolCallId: `1:tool_c${i}00000000000000000`,
          title: 'CronCreate', status: 'pending',
          rawInput: { name: `cc${i}`, schedule: '0 3 * * *' },
        }));
      }
      const dres = await catD3.getCatalog({ sessionId: 'sD' });
      assert.strictEqual(dres.entries.filter((e) => e.kind === 'cron').length, 3, 'cron 观察条目不超上限');
      assert.strictEqual(catD3.truncation.cronEntriesEvicted, 3, '超限条目被确定性驱逐');
      assert.ok(!dres.entries.some((e) => e.taskId === 'cc0'), '最老（at 最小）条目被驱逐');
      assert.ok(dres.entries.some((e) => e.taskId === 'cc5'), '最新条目保留');
    } finally {
      L.MAX_CRON_ENTRIES = origCron;
    }
    console.log('✅ M6 最终 catalog 与 cron 观察条目上限（确定性截断/驱逐 + diagnostics/truncation 可见 + 小数据回归）');
  }

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
