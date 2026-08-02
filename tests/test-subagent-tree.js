// 子代理树构建模块单元测试（Phase 6a）
// 覆盖：state.json agents 映射读取 / 无 state 目录枚举降级 / 3 层嵌套 /
// 循环父链与缺父 '__unknown__' / status 推断（含 interrupted 截断态）/
// 步骤构建与容错 / fixture 端到端（启发式 description/parentToolCallId）
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-subagent-tree-test-'));
const { buildSubagentTree, UNKNOWN_PARENT } = require('../src/main/subagent-tree');
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

    // 诊断：4 个 agent 目录、两个 fixture 各有 1 坏行、无坏文件
    assert.deepStrictEqual(
      { ...r.diagnostics },
      { scannedAgents: 4, badFiles: 0, badLines: 2, unknownParents: 0 },
    );
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

  console.log('\n全部 subagent-tree 测试通过');
}

try {
  run();
} finally {
  cleanup();
}
