// 子代理树构建模块单元测试（Phase 6a）
// 覆盖：state.json agents 映射读取 / 无 state 目录枚举降级 / 3 层嵌套 /
// 循环父链与缺父 '__unknown__' / status 推断（含 interrupted 截断态）/
// 步骤构建与容错 / fixture 端到端（启发式 description/parentToolCallId）/
// M4 安全边界：sessionDir 后代 symlink/junction 严格跳过（skippedLinks 记录，不读外部内容）
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-subagent-tree-test-'));
const { buildSubagentTree, UNKNOWN_PARENT, LIMITS } = require('../src/main/subagent-tree');
const FIXTURES = path.join(__dirname, 'fixtures', 'subagents');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// 建会话目录：state 可选（对象，写 state.json）；wires: { agentId: wire 内容 }；返回 sessionDir
function makeSession(name, { state, wires } = {}) {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state), 'utf8');
  for (const [id, content] of Object.entries(wires || {})) {
    const agentDir = path.join(dir, 'agents', id);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'wire.jsonl'), content, 'utf8');
  }
  return dir;
}

// wire 行构造 helpers（时间戳 > 1e12 为 epoch ms）
const loopEvent = (event, time) => JSON.stringify({ type: 'context.append_loop_event', event, time });
const stepBegin = (uuid, seq, time, turnId = '0') =>
  loopEvent({ type: 'step.begin', uuid, turnId, step: seq }, time);
const stepEnd = (uuid, seq, finishReason, time, turnId = '0') =>
  loopEvent({ type: 'step.end', uuid, turnId, step: seq, finishReason }, time);
const contentPart = (stepUuid, part, time) =>
  loopEvent({ type: 'content.part', uuid: `p-${stepUuid}`, turnId: '0', stepUuid, part }, time);
const toolCall = (uuid, stepUuid, seq, name, args, toolCallId, time) =>
  loopEvent({ type: 'tool.call', uuid, turnId: '0', step: seq, stepUuid, toolCallId, name, args }, time);
const toolResult = (toolCallId, output, isError, time) =>
  loopEvent({ type: 'tool.result', uuid: `r-${toolCallId}`, toolCallId, result: { output, isError } }, time);

const findNode = (nodes, agentId) => nodes.find((n) => n.agentId === agentId);

// 建目录链接：优先 symlink（'dir'），失败降级 junction（Windows 无需权限）。
// 返回创建方式（'symlink' | 'junction'），全失败返回 null。
function tryLinkDir(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return 'symlink';
  } catch {
    try {
      fs.symlinkSync(target, linkPath, 'junction');
      return 'junction';
    } catch {
      return null;
    }
  }
}

// 建文件链接（wire.jsonl/state.json）：'file' 型 symlink；Windows 无开发者模式/权限时可能失败 -> false
function tryLinkFile(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

function run() {
  console.log('测试目录:', tmpDir);

  // ---------- 1. 无 state.json 降级：目录枚举、全部顶层、agentType 回落 coder ----------
  {
    const dir = makeSession('t1-nostate', {
      wires: {
        main: [stepBegin('m1', 1, 1785550000000), stepEnd('m1', 1, 'end_turn', 1785550001000)].join('\n'),
        'agent-0': [stepBegin('a1', 1, 1785550002000)].join('\n'), // 未闭合 -> running
      },
    });
    const r = buildSubagentTree(dir, { sessionId: 'sess-1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sessionId, 'sess-1');
    assert.strictEqual(r.nodes.length, 2);
    const main = findNode(r.nodes, 'main');
    const sub = findNode(r.nodes, 'agent-0');
    assert.strictEqual(main.parentAgentId, null); // 无 state.json -> main 顶层
    assert.strictEqual(main.agentType, 'main');
    assert.strictEqual(main.status, 'completed');
    assert.strictEqual(sub.parentAgentId, null); // 无映射 -> 子代理也按顶层展示
    assert.strictEqual(sub.parentToolCallId, null); // 父 wire 无 Agent 调用 -> 无法启发式
    assert.strictEqual(sub.agentType, 'coder'); // 回落 CLI 默认
    assert.strictEqual(sub.status, 'running');
    assert.strictEqual(sub.description, '');
    assert.strictEqual(sub.turnId, '0');
    assert.strictEqual(r.diagnostics.unknownParents, 0);
    console.log('✅ 无 state.json 降级（目录枚举 + 顶层 + agentType 回落）');
  }

  // ---------- 2. fixture 端到端：state-nested 4 节点 + 启发式匹配 + 步骤内容 ----------
  {
    const dir = makeSession('t2-fixture', {
      state: JSON.parse(readFixture('state-nested.json')),
      wires: {
        main: readFixture('wire-main.jsonl'),
        'agent-0': readFixture('wire-subagent.jsonl'),
        'agent-00': [stepBegin('n1', 1, 1785549703000), stepEnd('n1', 1, 'end_turn', 1785549704000)].join('\n'),
        'agent-1': [stepBegin('n2', 1, 1785549805000), stepEnd('n2', 1, 'end_turn', 1785549807000)].join('\n'),
      },
    });
    const r = buildSubagentTree(dir, { sessionId: 'sess-2' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.nodes.length, 4);
    // 排序：main 首位
    assert.strictEqual(r.nodes[0].agentId, 'main');

    const main = findNode(r.nodes, 'main');
    assert.strictEqual(main.parentAgentId, null);
    assert.strictEqual(main.agentType, 'main');
    assert.strictEqual(main.status, 'completed'); // step3 end_turn
    assert.strictEqual(main.steps.length, 6); // step(1)+tool(Glob)+step(2)+tool(Agent A)+step(3)+tool(Agent B)
    assert.strictEqual(main.steps.filter((s) => s.kind === 'step').length, 3);
    assert.strictEqual(main.steps.filter((s) => s.kind === 'tool').length, 3);
    const globCall = main.steps.find((s) => s.toolCallId === 'tool_glob1');
    assert.strictEqual(globCall.status, 'completed');
    assert.strictEqual(globCall.output, '12 个测试文件');
    const step1 = main.steps.find((s) => s.stepId === 'm-st-1');
    assert.ok(step1.text.includes('先用 Glob 定位')); // content.part think 累积进 step

    // 子代理 agent-0：启发式匹配 main wire 的 tool_agentA（时间差 2000ms < tool_agentB 106000ms）
    const sub = findNode(r.nodes, 'agent-0');
    assert.strictEqual(sub.parentAgentId, 'main');
    assert.strictEqual(sub.parentToolCallId, 'tool_agentA');
    assert.strictEqual(sub.description, '统计 tests 目录文件数');
    assert.strictEqual(sub.agentType, 'coder'); // args.subagent_type 直译
    assert.strictEqual(sub.status, 'completed');
    assert.strictEqual(sub.steps.length, 3); // step+tool(Glob)+step
    assert.strictEqual(sub.steps[1].toolCallId, 'tool_sglob');
    assert.strictEqual(sub.steps[1].output, '12 个测试文件');

    // 3 层嵌套：agent-00 挂 agent-0 下
    const sub2 = findNode(r.nodes, 'agent-00');
    assert.strictEqual(sub2.parentAgentId, 'agent-0');
    assert.strictEqual(sub2.status, 'completed');

    // agent-1 首事件接近 tool_agentB（差 1000ms）-> 匹配 tool_agentB
    const sub3 = findNode(r.nodes, 'agent-1');
    assert.strictEqual(sub3.parentAgentId, 'main');
    assert.strictEqual(sub3.parentToolCallId, 'tool_agentB');
    assert.strictEqual(sub3.description, '另一项后续任务');
    assert.strictEqual(sub3.agentType, 'reviewer');

    // 诊断：4 个 agent 目录、两个 fixture 各有 1 坏行、无坏文件、无链接跳过（M6 限额字段为 0）
    assert.strictEqual(r.diagnostics.scannedAgents, 4);
    assert.strictEqual(r.diagnostics.badFiles, 0);
    assert.strictEqual(r.diagnostics.badLines, 2);
    assert.strictEqual(r.diagnostics.unknownParents, 0);
    assert.strictEqual(r.diagnostics.skippedLinks, 0);
    assert.strictEqual(r.diagnostics.skippedInvalidIds, 0);
    assert.strictEqual(r.diagnostics.truncatedFiles, 0);
    assert.strictEqual(r.diagnostics.skippedFiles, 0);
    assert.ok(r.diagnostics.bytesRead > 0, 'wire 实际读取字节应 > 0');
    console.log('✅ fixture 端到端（父子链 + 启发式 description/parentToolCallId/agentType + 步骤内容 + 诊断）');
  }

  // ---------- 3. status 推断矩阵（含 interrupted 截断态） ----------
  {
    const T = 1785550100000;
    const dir = makeSession('t3-status', {
      state: {
        agents: {
          main: { type: 'main' },
          comp: { type: 'sub', parentAgentId: 'main' },
          run: { type: 'sub', parentAgentId: 'main' },
          intr: { type: 'sub', parentAgentId: 'main' },
          fail: { type: 'sub', parentAgentId: 'main' },
          unknown: { type: 'sub', parentAgentId: 'main' },
        },
      },
      wires: {
        main: [stepBegin('m1', 1, T), stepEnd('m1', 1, 'end_turn', T + 1000)].join('\n'),
        comp: [stepBegin('c1', 1, T + 2000), stepEnd('c1', 1, 'end_turn', T + 3000)].join('\n'),
        run: [stepBegin('r1', 1, T + 4000)].join('\n'), // 有 step.begin 无 step.end -> running
        intr: [stepBegin('i1', 1, T + 5000), stepEnd('i1', 1, 'interrupted', T + 6000)].join('\n'),
        fail: [stepBegin('f1', 1, T + 7000), stepEnd('f1', 1, 'failed', T + 8000)].join('\n'),
        unknown: ['{"type":"metadata","protocol_version":"1.5","created_at":' + (T + 9000) + '}'].join('\n'), // 无任何 loop 步骤
      },
    });
    const r = buildSubagentTree(dir, { sessionId: 'sess-3' });
    assert.strictEqual(r.nodes.length, 6);
    assert.strictEqual(findNode(r.nodes, 'main').status, 'completed');
    assert.strictEqual(findNode(r.nodes, 'comp').status, 'completed');
    assert.strictEqual(findNode(r.nodes, 'run').status, 'running');
    assert.strictEqual(findNode(r.nodes, 'intr').status, 'interrupted'); // 截断态直译
    assert.strictEqual(findNode(r.nodes, 'fail').status, 'failed');
    assert.strictEqual(findNode(r.nodes, 'unknown').status, 'unknown'); // 无步骤不虚构
    console.log('✅ status 推断矩阵（completed/running/interrupted/failed/unknown）');
  }

  // ---------- 4. 循环父链 '__unknown__'（含自环） ----------
  {
    const dir = makeSession('t4-loop', {
      state: JSON.parse(readFixture('state-loop.json')),
      wires: {
        main: [stepBegin('m1', 1, 1785550200000), stepEnd('m1', 1, 'end_turn', 1785550201000)].join('\n'),
        'agent-0': [stepBegin('a1', 1, 1785550202000), stepEnd('a1', 1, 'end_turn', 1785550203000)].join('\n'),
        'agent-1': [stepBegin('b1', 1, 1785550204000), stepEnd('b1', 1, 'end_turn', 1785550205000)].join('\n'),
      },
    });
    const r = buildSubagentTree(dir, { sessionId: 'sess-4' });
    assert.strictEqual(findNode(r.nodes, 'agent-0').parentAgentId, UNKNOWN_PARENT); // agent-0 <-> agent-1 成环
    assert.strictEqual(findNode(r.nodes, 'agent-1').parentAgentId, UNKNOWN_PARENT);
    assert.strictEqual(findNode(r.nodes, 'main').parentAgentId, null);
    assert.strictEqual(r.diagnostics.unknownParents, 2);

    // 自环：agent-0 -> agent-0
    const dir2 = makeSession('t4-selfloop', {
      state: { agents: { main: { type: 'main' }, 'agent-0': { type: 'sub', parentAgentId: 'agent-0' } } },
      wires: {
        main: [stepBegin('m1', 1, 1785550206000), stepEnd('m1', 1, 'end_turn', 1785550207000)].join('\n'),
        'agent-0': [stepBegin('a1', 1, 1785550208000), stepEnd('a1', 1, 'end_turn', 1785550209000)].join('\n'),
      },
    });
    const r2 = buildSubagentTree(dir2, { sessionId: 'sess-4b' });
    assert.strictEqual(findNode(r2.nodes, 'agent-0').parentAgentId, UNKNOWN_PARENT);
    assert.strictEqual(r2.diagnostics.unknownParents, 1);
    console.log('✅ 循环父链归 __unknown__（互环 + 自环）');
  }

  // ---------- 5. 缺父节点 '__unknown__' ----------
  {
    const dir = makeSession('t5-orphan', {
      state: JSON.parse(readFixture('state-orphan.json')),
      wires: {
        main: [stepBegin('m1', 1, 1785550300000), stepEnd('m1', 1, 'end_turn', 1785550301000)].join('\n'),
        'agent-0': [stepBegin('a1', 1, 1785550302000), stepEnd('a1', 1, 'end_turn', 1785550303000)].join('\n'),
      },
    });
    const r = buildSubagentTree(dir, { sessionId: 'sess-5' });
    assert.strictEqual(findNode(r.nodes, 'agent-0').parentAgentId, UNKNOWN_PARENT); // parentAgentId='ghost-agent' 不存在
    assert.strictEqual(findNode(r.nodes, 'agent-0').parentToolCallId, null); // 未知关系不尝试启发式
    assert.strictEqual(findNode(r.nodes, 'main').parentAgentId, null);
    assert.strictEqual(r.diagnostics.unknownParents, 1);
    console.log('✅ 缺父节点归 __unknown__');
  }

  // ---------- 6. 步骤构建细节：text 累积 / tool output / isError / 截断 / 未闭合工具 ----------
  {
    const T = 1785550400000;
    const longThink = '长思考内容'.repeat(60); // 180 汉字 -> 超 200 字符截断
    const longOutput = '长输出'.repeat(300); // 900 字符 -> 超 500 截断
    const dir = makeSession('t6-steps', {
      wires: {
        main: [
          stepBegin('s1', 1, T),
          contentPart('s1', { type: 'think', think: longThink }, T + 100),
          toolCall('t1', 's1', 1, 'Read', { path: 'a.js' }, 'tool_read1', T + 200),
          toolResult('tool_read1', longOutput, false, T + 300),
          stepEnd('s1', 1, 'tool_use', T + 400),
          stepBegin('s2', 2, T + 500),
          contentPart('s2', { type: 'text', text: '分析结果' }, T + 600),
          toolCall('t2', 's2', 2, 'Bash', { command: 'ls' }, 'tool_bash1', T + 700),
          stepEnd('s2', 2, 'end_turn', T + 800),
          stepBegin('s3', 3, T + 900),
          toolCall('t3', 's3', 3, 'Write', { path: 'b.js' }, 'tool_write1', T + 1000),
          toolResult('tool_write1', '写入失败', true, T + 1100), // isError -> failed
          stepEnd('s3', 3, 'failed', T + 1200),
        ].join('\n'),
      },
    });
    const r = buildSubagentTree(dir, { sessionId: 'sess-6' });
    const main = findNode(r.nodes, 'main');
    assert.strictEqual(main.steps.length, 6); // step+tool(Read)+step+tool(Bash)+step+tool(Write)
    assert.strictEqual(main.status, 'failed'); // 最后闭合 step failed

    const step1 = main.steps.find((s) => s.stepId === 's1');
    assert.ok(step1.text.length <= 201 && step1.text.endsWith('…')); // think 内容截断
    assert.ok(step1.text.includes('长思考内容'));
    const readCall = main.steps.find((s) => s.toolCallId === 'tool_read1');
    assert.strictEqual(readCall.status, 'completed');
    assert.ok(readCall.output.length <= 501 && readCall.output.endsWith('…')); // 500 截断
    assert.ok(readCall.output.startsWith('长输出'));

    const step2 = main.steps.find((s) => s.stepId === 's2');
    assert.strictEqual(step2.text, '分析结果'); // content.part text 累积
    const bashCall = main.steps.find((s) => s.toolCallId === 'tool_bash1');
    assert.strictEqual(bashCall.status, 'running'); // 无 tool.result -> 保持 running

    const writeCall = main.steps.find((s) => s.toolCallId === 'tool_write1');
    assert.strictEqual(writeCall.status, 'failed'); // isError:true -> failed
    assert.strictEqual(writeCall.output, '写入失败');
    console.log('✅ 步骤构建细节（text 累积 / output / isError / 截断 / 未闭合工具）');
  }

  // ---------- 7. 容错与诊断：坏行 / 缺 wire / 目录不存在 / state.json 损坏 ----------
  {
    // 目录不存在
    const r1 = buildSubagentTree(path.join(tmpDir, 'nope'), { sessionId: 's' });
    assert.strictEqual(r1.ok, false);
    assert.deepStrictEqual(r1.nodes, []);

    // state.json 损坏 -> 目录枚举降级；agent 目录缺 wire -> badFiles
    const dir2 = makeSession('t7-bad', {
      wires: {
        main: [
          '{这不是合法JSON',
          stepBegin('m1', 1, 1785550500000),
          stepEnd('m1', 1, 'end_turn', 1785550501000),
        ].join('\n'),
      },
    });
    fs.writeFileSync(path.join(dir2, 'state.json'), '{损坏的state', 'utf8');
    fs.mkdirSync(path.join(dir2, 'agents', 'agent-0'), { recursive: true }); // 无 wire.jsonl
    const r2 = buildSubagentTree(dir2, { sessionId: 'sess-7' });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.nodes.length, 1); // agent-0 无 wire -> 不建节点
    assert.strictEqual(findNode(r2.nodes, 'main').parentAgentId, null); // state 损坏 -> 全顶层
    assert.strictEqual(r2.diagnostics.scannedAgents, 2);
    assert.strictEqual(r2.diagnostics.badFiles, 1); // agent-0 无 wire.jsonl
    assert.strictEqual(r2.diagnostics.badLines, 1); // main 1 坏行

    // agents 目录不存在（仅 state.json）-> 空树但 ok
    const dir3 = makeSession('t7-noagents', { state: { agents: { main: { type: 'main' } } } });
    fs.rmSync(path.join(dir3, 'agents'), { recursive: true, force: true });
    const r3 = buildSubagentTree(dir3, { sessionId: 'sess-7b' });
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(r3.nodes.length, 0);
    assert.strictEqual(r3.diagnostics.scannedAgents, 0);
    console.log('✅ 容错与诊断（坏行 / 缺 wire / 目录不存在 / state.json 损坏降级）');
  }

  // ---------- 8. sessionDir 自身为 symlink/junction -> 既有 ok:false 失败形态，不抛 ----------
  {
    const real = makeSession('t8-sessionlink', {
      wires: { main: [stepBegin('m1', 1, 1785550600000), stepEnd('m1', 1, 'end_turn', 1785550601000)].join('\n') },
    });
    const link = path.join(tmpDir, 't8-sessionlink-link');
    const kind = tryLinkDir(real, link);
    assert.ok(kind, '应能创建 sessionDir 链接');
    const r = buildSubagentTree(link, { sessionId: 'sess-8' });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.nodes, []);
    console.log(`✅ sessionDir 自身为链接（${kind}）-> ok:false 失败形态`);
  }

  // ---------- 9. agents 目录为 symlink/junction 指向外部树 -> 不读取外部 agents ----------
  {
    const T = 1785550700000;
    const external = path.join(tmpDir, 't9-external');
    fs.mkdirSync(path.join(external, 'agents', 'evil-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(external, 'agents', 'evil-agent', 'wire.jsonl'),
      [stepBegin('e1', 1, T), stepEnd('e1', 1, 'end_turn', T + 1000)].join('\n'),
      'utf8',
    );
    // 会话 state.json 登记了 evil-agent：若实现跟随 agents 链接，会把外部 wire 读入并建节点
    const dir = makeSession('t9-agentslink', {
      state: {
        agents: { main: { type: 'main' }, 'evil-agent': { type: 'sub', parentAgentId: 'main' } },
      },
    });
    fs.rmSync(path.join(dir, 'agents'), { recursive: true, force: true });
    const kind = tryLinkDir(path.join(external, 'agents'), path.join(dir, 'agents'));
    assert.ok(kind, '应能创建 agents 目录链接');
    const r = buildSubagentTree(dir, { sessionId: 'sess-9' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.nodes.length, 0); // 外部 agents 未被读取 -> 无任何节点
    assert.strictEqual(r.diagnostics.scannedAgents, 0);
    assert.strictEqual(r.diagnostics.skippedLinks, 1); // agents 目录链接
    console.log(`✅ agents 目录链接（${kind}）-> 不读外部树、skippedLinks 记录`);
  }

  // ---------- 10. 单个 agent 目录 / wire.jsonl / state.json 为链接 -> 跳过且 diagnostics 记录 ----------
  {
    const T = 1785550800000;
    const external = path.join(tmpDir, 't10-external');
    fs.mkdirSync(path.join(external, 'agent-0'), { recursive: true });
    fs.writeFileSync(
      path.join(external, 'agent-0', 'wire.jsonl'),
      [stepBegin('e0', 1, T + 2000), stepEnd('e0', 1, 'end_turn', T + 3000)].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(external, 'wire-agent-1.jsonl'),
      [stepBegin('e1', 1, T + 4000), stepEnd('e1', 1, 'end_turn', T + 5000)].join('\n'),
      'utf8',
    );
    const dir = makeSession('t10-mixed', {
      state: {
        agents: {
          main: { type: 'main' },
          'agent-0': { type: 'sub', parentAgentId: 'main' },
          'agent-1': { type: 'sub', parentAgentId: 'main' },
        },
      },
      wires: {
        main: [stepBegin('m1', 1, T), stepEnd('m1', 1, 'end_turn', T + 1000)].join('\n'),
        'agent-1': [stepBegin('a1', 1, T + 4000), stepEnd('a1', 1, 'end_turn', T + 5000)].join('\n'),
      },
    });
    // agent-0 目录整体替换为链接（指向外部目录）
    fs.rmSync(path.join(dir, 'agents', 'agent-0'), { recursive: true, force: true });
    const kindDir = tryLinkDir(path.join(external, 'agent-0'), path.join(dir, 'agents', 'agent-0'));
    assert.ok(kindDir, '应能创建 agent 目录链接');
    // agent-1 目录真实，仅 wire.jsonl 替换为链接（指向外部文件）
    fs.rmSync(path.join(dir, 'agents', 'agent-1', 'wire.jsonl'));
    const kindWire = tryLinkFile(path.join(external, 'wire-agent-1.jsonl'), path.join(dir, 'agents', 'agent-1', 'wire.jsonl'));
    assert.ok(kindWire, '应能创建 wire.jsonl 文件链接');
    const r = buildSubagentTree(dir, { sessionId: 'sess-10' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.nodes.length, 1); // 仅 main（agent-0 目录链接、agent-1 wire 链接均跳过）
    assert.strictEqual(findNode(r.nodes, 'main').parentAgentId, null);
    assert.strictEqual(r.diagnostics.scannedAgents, 2);
    assert.strictEqual(r.diagnostics.badFiles, 0);
    assert.strictEqual(r.diagnostics.badLines, 0);
    assert.strictEqual(r.diagnostics.unknownParents, 0);
    assert.strictEqual(r.diagnostics.skippedLinks, 2);
    assert.strictEqual(r.diagnostics.skippedInvalidIds, 0);
    assert.strictEqual(r.diagnostics.truncatedFiles, 0);
    assert.strictEqual(r.diagnostics.skippedFiles, 0);
    assert.ok(r.diagnostics.bytesRead > 0);

    // state.json 为链接 -> 外部映射被忽略，按目录枚举降级（全部顶层）
    const externalState = path.join(tmpDir, 't10-external-state.json');
    fs.writeFileSync(
      externalState,
      JSON.stringify({ agents: { main: { type: 'main' }, 'agent-0': { type: 'sub', parentAgentId: 'main' } } }),
      'utf8',
    );
    const dir2 = makeSession('t10-statelink', {
      wires: {
        main: [stepBegin('m1', 1, T), stepEnd('m1', 1, 'end_turn', T + 1000)].join('\n'),
        'agent-0': [stepBegin('a1', 1, T + 2000), stepEnd('a1', 1, 'end_turn', T + 3000)].join('\n'),
      },
    });
    fs.rmSync(path.join(dir2, 'state.json'), { force: true });
    const kindState = tryLinkFile(externalState, path.join(dir2, 'state.json'));
    assert.ok(kindState, '应能创建 state.json 文件链接');
    const r2 = buildSubagentTree(dir2, { sessionId: 'sess-10b' });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.nodes.length, 2);
    assert.strictEqual(r2.diagnostics.skippedLinks, 1);
    assert.strictEqual(findNode(r2.nodes, 'main').parentAgentId, null); // 外部映射未生效
    assert.strictEqual(findNode(r2.nodes, 'agent-0').parentAgentId, null);
    console.log('✅ 单个链接跳过（agent 目录 / wire.jsonl / state.json）-> diagnostics.skippedLinks 记录');
  }

  // ---------- 11. Windows 无 symlink 权限：junction 降级（junction 同样被 lstat 识别并拒绝） ----------
  {
    const T = 1785550900000;
    const external = path.join(tmpDir, 't11-external');
    fs.mkdirSync(path.join(external, 'agents', 'j-sub'), { recursive: true });
    fs.writeFileSync(
      path.join(external, 'agents', 'j-sub', 'wire.jsonl'),
      [stepBegin('j1', 1, T), stepEnd('j1', 1, 'end_turn', T + 1000)].join('\n'),
      'utf8',
    );
    const dir = makeSession('t11-junction', {
      state: { agents: { main: { type: 'main' }, 'j-sub': { type: 'sub', parentAgentId: 'main' } } },
    });
    fs.rmSync(path.join(dir, 'agents'), { recursive: true, force: true });
    // 优先直接创建 junction 型链接（Windows 无需管理员/开发者模式）；失败再回退 dir symlink
    let kind = null;
    try {
      fs.symlinkSync(path.join(external, 'agents'), path.join(dir, 'agents'), 'junction');
      kind = 'junction';
    } catch {
      kind = tryLinkDir(path.join(external, 'agents'), path.join(dir, 'agents'));
    }
    if (!kind) {
      console.log('⚠ 跳过 junction 降级测试：平台不支持创建链接');
    } else {
      const r = buildSubagentTree(dir, { sessionId: 'sess-11' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.nodes.length, 0); // junction 同样被拒 -> 不读外部 agents
      assert.strictEqual(r.diagnostics.skippedLinks, 1);
      console.log(`✅ junction 降级（${kind}）-> 与 symlink 同等拒绝`);
    }
  }

  // ---------- 12. M4 高危修复：state.json 恶意 agentId 不逃逸 agentsRoot、不读取外部内容 ----------
  {
    const T = 1785551000000;
    // 外部哨兵：若实现跟随非法 id，会把该外部 wire 读入并建节点
    const external = path.join(tmpDir, 't12-external');
    fs.mkdirSync(path.join(external, 'outside-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(external, 'outside-agent', 'wire.jsonl'),
      [stepBegin('evil', 1, T), stepEnd('evil', 1, 'end_turn', T + 1000)].join('\n'),
      'utf8',
    );
    // 非法 id 矩阵：目录穿越（/ 与 \）、多段、POSIX/Windows 绝对、UNC、盘符相对、'.'/'..'、空、NUL
    const badIds = [
      '../../outside-agent', // 目录穿越（正斜杠）
      '..\\..\\outside-agent', // 目录穿越（反斜杠）
      'a/b', // 多段（/）
      'a\\b', // 多段（\）
      '/etc/passwd', // POSIX 绝对
      'C:\\evil', // Windows 绝对（盘符）
      'C:/evil', // Windows 绝对（斜杠盘符）
      'C:evil', // Windows 盘符相对（isAbsolute 不判定）
      '\\\\server\\share\\evil', // UNC
      '//server/share', // UNC（斜杠）
      '.', // 当前目录
      '..', // 父目录
      '', // 空 key
      'bad\0id', // NUL
    ];
    const stateAgents = { main: { type: 'main' } };
    for (const id of badIds) stateAgents[id] = { type: 'sub', parentAgentId: 'main' };
    stateAgents['safe-agent'] = { type: 'sub', parentAgentId: 'main' }; // 合法 id 不受影响
    const dir = makeSession('t12-evil', {
      state: { agents: stateAgents },
      wires: {
        main: [stepBegin('m1', 1, T), stepEnd('m1', 1, 'end_turn', T + 1000)].join('\n'),
        'safe-agent': [stepBegin('s1', 1, T + 2000), stepEnd('s1', 1, 'end_turn', T + 3000)].join('\n'),
      },
    });
    const r = buildSubagentTree(dir, { sessionId: 'sess-12' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.nodes.length, 2); // 仅 main + safe-agent：非法 id 全部拒绝、外部哨兵未被读取
    assert.strictEqual(findNode(r.nodes, 'main').parentAgentId, null);
    assert.strictEqual(findNode(r.nodes, 'safe-agent').parentAgentId, 'main'); // 合法 id 行为保持
    assert.strictEqual(r.diagnostics.skippedInvalidIds, badIds.length); // 每个非法 id 计入 diagnostics
    assert.strictEqual(r.diagnostics.badFiles, 0); // 从未尝试读取任何非法/外部路径
    assert.strictEqual(r.diagnostics.scannedAgents, 2); // 磁盘枚举仅 main + safe-agent
    assert.strictEqual(r.diagnostics.skippedLinks, 0);
    console.log(`✅ M4 恶意 agentId（${badIds.length} 种穿越/绝对/分隔符/Windows 形式）全部拒绝、外部哨兵未被读取、合法 id 保持`);
  }

  // ---------- 13. M6 资源上限：超大 wire 截断读取，只保留完整行，残行绝不解析 ----------
  {
    const T = 1785551100000;
    // 残行以合法 JSON 开头但无换行且超长（> WIRE_MAX_BYTES）：若实现中途解析残行，
    // JSON.parse 必失败 -> badLines 增加；正确实现应丢弃残行 -> badLines 保持 0
    const hugeWire = [
      stepBegin('b1', 1, T),
      stepEnd('b1', 1, 'end_turn', T + 1000),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'frag', turnId: '0', step: 99 }, time: T + 2000 })
        + 'x'.repeat(LIMITS.WIRE_MAX_BYTES),
    ].join('\n');
    const dir = makeSession('t13-hugewire', { wires: { main: hugeWire } });
    const r = buildSubagentTree(dir, { sessionId: 'sess-13' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.nodes.length, 1); // 前两行完整行解析成功
    assert.strictEqual(findNode(r.nodes, 'main').status, 'completed');
    assert.strictEqual(r.diagnostics.truncatedFiles, 1); // 超大小截断读取
    assert.strictEqual(r.diagnostics.badLines, 0); // 残行未被解析
    assert.strictEqual(r.diagnostics.skippedFiles, 0);
    assert.strictEqual(r.diagnostics.bytesRead, LIMITS.WIRE_MAX_BYTES); // 只读上限内字节

    // 混合：超大 wire 与合法小 wire 并存，小文件完整读取不受影响
    const dir2 = makeSession('t13-mixed', {
      wires: {
        main: [stepBegin('m1', 1, T), stepEnd('m1', 1, 'end_turn', T + 1000)].join('\n'),
        'agent-0': hugeWire,
      },
    });
    const r2 = buildSubagentTree(dir2, { sessionId: 'sess-13b' });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.nodes.length, 2);
    assert.strictEqual(findNode(r2.nodes, 'agent-0').status, 'completed');
    assert.strictEqual(r2.diagnostics.truncatedFiles, 1);
    assert.strictEqual(r2.diagnostics.badLines, 0);
    assert.strictEqual(r2.diagnostics.skippedFiles, 0);
    console.log('✅ M6 超大 wire 截断（只解析完整行、残行丢弃、混合小文件保持）');
  }

  // ---------- 14. M6 资源上限：wire 文件数上限（超限跳过不读，diagnostics 记录） ----------
  {
    const T = 1785551200000;
    const wires = {};
    for (let i = 0; i < LIMITS.WIRE_MAX_FILES + 5; i++) {
      wires[`agent-${i}`] = [stepBegin(`s${i}`, 1, T + i), stepEnd(`s${i}`, 1, 'end_turn', T + i + 1)].join('\n');
    }
    const dir = makeSession('t14-toomany', { wires });
    const r = buildSubagentTree(dir, { sessionId: 'sess-14' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.diagnostics.scannedAgents, LIMITS.WIRE_MAX_FILES + 5); // 目录枚举不受限
    assert.strictEqual(r.nodes.length, LIMITS.WIRE_MAX_FILES); // 只解析前上限个
    assert.strictEqual(r.diagnostics.skippedFiles, 5); // 超出文件数上限被跳过
    assert.strictEqual(r.diagnostics.truncatedFiles, 0);
    assert.strictEqual(r.diagnostics.badFiles, 0);
    assert.ok(r.diagnostics.bytesRead > 0);
    console.log('✅ M6 wire 文件数上限（超限跳过不读、diagnostics 记录）');
  }

  // ---------- 15. M6 资源上限：wire 总读取字节预算耗尽（预算内保持、耗尽跳过、末次截断） ----------
  {
    const T = 1785551300000;
    const N = 90; // 90 × ~100KB ≈ 9MB > WIRE_TOTAL_BYTES
    const pad = 'x'.repeat(100 * 1024);
    const wires = {};
    for (let i = 0; i < N; i++) {
      // 每文件 2 行合法 step + 1 行 100KB 非法 JSON（完整读取时计坏行；截断读取时残行丢弃）
      wires[`agent-${i}`] = [stepBegin(`s${i}`, 1, T + i), stepEnd(`s${i}`, 1, 'end_turn', T + i + 1)].join('\n') + '\n' + pad + '\n';
    }
    const dir = makeSession('t15-budget', { wires });
    const r = buildSubagentTree(dir, { sessionId: 'sess-15' });
    assert.strictEqual(r.ok, true);
    assert.ok(r.diagnostics.bytesRead <= LIMITS.WIRE_TOTAL_BYTES, '总读取字节不得超过预算');
    assert.ok(r.diagnostics.bytesRead > 0);
    assert.strictEqual(r.diagnostics.skippedFiles, N - r.nodes.length, '预算耗尽后文件跳过');
    assert.ok(r.diagnostics.skippedFiles > 0, '预算应被耗尽');
    assert.ok(r.diagnostics.truncatedFiles >= 1, '预算不足时末次读取截断');
    assert.ok(r.diagnostics.badLines >= 80, '仅全读文件的坏行被解析计数');
    assert.ok(r.nodes.length >= 80, '预算内文件照常解析');
    console.log('✅ M6 wire 总字节预算（耗尽跳过 + 末次截断 + 预算内保持）');
  }

  // ---------- 16. M6 上限缺口：超大 state.json 有限大小读取（超限不整体 JSON.parse，目录枚举降级） ----------
  {
    const T = 1785551400000;
    const dir = makeSession('t16-hugestate', {
      wires: {
        main: [stepBegin('m1', 1, T), stepEnd('m1', 1, 'end_turn', T + 1000)].join('\n'),
        'agent-0': [stepBegin('a1', 1, T + 2000), stepEnd('a1', 1, 'end_turn', T + 3000)].join('\n'),
      },
    });
    // state.json 超过 STATE_MAX_BYTES：合法 JSON 前缀 + 超长 padding（若实现整体 parse 必失败/超预算）
    fs.writeFileSync(path.join(dir, 'state.json'),
      JSON.stringify({ agents: { main: { type: 'main' } }, padding: 'x'.repeat(LIMITS.STATE_MAX_BYTES) }), 'utf8');
    const r = buildSubagentTree(dir, { sessionId: 'sess-16' });
    assert.strictEqual(r.ok, true, '超大 state.json 不抛');
    assert.strictEqual(r.diagnostics.stateOversized, 1, '超限 state.json 记录且不解析');
    assert.strictEqual(r.nodes.length, 2); // 目录枚举降级：两个 wire 照常解析
    assert.strictEqual(findNode(r.nodes, 'main').parentAgentId, null); // 超大映射未生效 -> 全顶层
    assert.strictEqual(findNode(r.nodes, 'agent-0').parentAgentId, null);
    assert.strictEqual(r.diagnostics.badFiles, 0);
    console.log('✅ M6 超大 state.json（有限大小读取、不整体 parse、目录枚举降级、不抛）');
  }

  // ---------- 17. M6 上限缺口：state.json agents 映射条目超上限（确定性截断，不抛） ----------
  {
    const T = 1785551500000;
    const stateAgents = { main: { type: 'main' } };
    for (let i = 0; i < LIMITS.STATE_MAX_AGENTS + 30; i++) {
      stateAgents[`ghost-${i}`] = { type: 'sub', parentAgentId: 'main' }; // 无磁盘目录 -> 不建节点
    }
    const dir = makeSession('t17-statetrunc', {
      state: { agents: stateAgents },
      wires: {
        main: [stepBegin('m1', 1, T), stepEnd('m1', 1, 'end_turn', T + 1000)].join('\n'),
      },
    });
    const r = buildSubagentTree(dir, { sessionId: 'sess-17' });
    assert.strictEqual(r.ok, true, '映射条目超限不抛');
    assert.strictEqual(r.diagnostics.stateAgentsTruncated, 1, '映射条目超上限确定性截断（跳过剩余）');
    assert.strictEqual(r.nodes.length, 1, '仅 main（首个被纳入且有 wire）建节点');
    assert.strictEqual(r.nodes[0].agentId, 'main');
    assert.strictEqual(findNode(r.nodes, 'main').parentAgentId, null);
    console.log('✅ M6 state.json 映射条目上限（确定性截断 + diagnostics 可见 + 不抛）');
  }

  // ---------- 18. M6 上限缺口：agents 目录超量候选（流式有界枚举，达到候选上限即停止） ----------
  {
    const T = 1785551600000;
    const wires = {};
    for (let i = 0; i < LIMITS.AGENTS_ENUM_MAX + 60; i++) {
      wires[`agent-${i}`] = [stepBegin(`s${i}`, 1, T + i), stepEnd(`s${i}`, 1, 'end_turn', T + i + 1)].join('\n');
    }
    const dir = makeSession('t18-enumcap', { wires });
    const r = buildSubagentTree(dir, { sessionId: 'sess-18' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.diagnostics.scannedAgents, LIMITS.AGENTS_ENUM_MAX, '枚举达到候选上限即停止，不物化剩余目录');
    assert.strictEqual(r.diagnostics.enumerateTruncated, 1, '枚举截断记录');
    assert.strictEqual(r.nodes.length, LIMITS.WIRE_MAX_FILES, 'wire 读取上限仍生效');
    assert.strictEqual(r.diagnostics.skippedFiles, LIMITS.AGENTS_ENUM_MAX - LIMITS.WIRE_MAX_FILES);
    console.log('✅ M6 agents 目录流式有界枚举（候选上限停止 + 读取上限保持 + 不抛）');
  }

  // ---------- 19. M6 上限缺口：输出节点数上限（排序后确定性截断，main 优先保留） ----------
  {
    const orig = LIMITS.MAX_AGENT_NODES;
    LIMITS.MAX_AGENT_NODES = 3;
    try {
      const T = 1785551700000;
      const wires = {};
      for (let i = 0; i < 5; i++) {
        wires[`agent-${i}`] = [stepBegin(`s${i}`, 1, T + i * 1000), stepEnd(`s${i}`, 1, 'end_turn', T + i * 1000 + 100)].join('\n');
      }
      const dir = makeSession('t19-nodescap', { wires });
      const r = buildSubagentTree(dir, { sessionId: 'sess-19' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.nodes.length, 3, '节点数超上限确定性截断');
      assert.strictEqual(r.diagnostics.nodesTruncated, 2, '截断量计入 diagnostics');
      assert.deepStrictEqual(r.nodes.map((n) => n.agentId), ['agent-0', 'agent-1', 'agent-2'], '排序（时间升序）后保留前 N');

      // main 存在时排序优先保留
      const dir2 = makeSession('t19-nodescap2', {
        wires: {
          main: [stepBegin('m1', 1, T), stepEnd('m1', 1, 'end_turn', T + 100)].join('\n'),
          'agent-0': [stepBegin('a1', 1, T + 1000), stepEnd('a1', 1, 'end_turn', T + 1100)].join('\n'),
          'agent-1': [stepBegin('b1', 1, T + 2000), stepEnd('b1', 1, 'end_turn', T + 2100)].join('\n'),
          'agent-2': [stepBegin('c1', 1, T + 3000), stepEnd('c1', 1, 'end_turn', T + 3100)].join('\n'),
        },
      });
      const r2 = buildSubagentTree(dir2, { sessionId: 'sess-19b' });
      assert.deepStrictEqual(r2.nodes.map((n) => n.agentId), ['main', 'agent-0', 'agent-1'], 'main 优先保留');
      assert.strictEqual(r2.diagnostics.nodesTruncated, 1);
    } finally {
      LIMITS.MAX_AGENT_NODES = orig;
    }
    console.log('✅ M6 输出节点数上限（排序后确定性截断 + main 优先 + 截断量可见）');
  }

  console.log('\n全部 subagent-tree 测试通过');
}

try {
  run();
} finally {
  cleanup();
}
