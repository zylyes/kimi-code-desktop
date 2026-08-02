// 子代理树构建（Phase 6a）：会话根 state.json 的 agents 映射（父子关系唯一来源）
// + agents/<id>/wire.jsonl 的 context.append_loop_event 步骤补绘。纯 Node 无 electron。
// 降级路径：无 state.json / 无 agents 映射时按目录枚举，所有子代理按顶层（parentAgentId=null）展示；
// 父不存在或父链成环的节点归入 '__unknown__'（UI 呈现为"未知关系"组），不虚构层级。
//
// SubagentNode = {
//   sessionId, turnId, agentId, parentAgentId: null|string, parentToolCallId: null|string,
//   agentType, status, description, steps: [{ stepId, seq, kind, status, text, toolCallId, output }], updatedAt
// }
// status: 'unknown' | 'running' | 'completed' | 'failed' | 'interrupted'（interrupted 为截断态）
// steps.kind: 'step'（LLM 推理步，step.begin/end 对）| 'tool'（工具调用，tool.call/result 对）
// steps.status: 'running' | 'completed' | 'failed' | 'interrupted'
// diagnostics: { scannedAgents, badFiles, badLines, unknownParents }
'use strict';

const fs = require('fs');
const path = require('path');

const UNKNOWN_PARENT = '__unknown__';
const STEP_TEXT_MAX = 200; // 步骤文本截断长度
const OUTPUT_MAX = 500; // 工具输出截断长度
const MAX_STEPS = 200; // 每节点步骤数上限（保留最新）
const MAX_LOOP_EVENTS = 5000; // 每个 wire 最多处理的 loop 事件数（防超大文件拖垮）

// 单行折叠 + 截断摘要；非字符串/空白 -> ''
function summarize(v, max) {
  if (typeof v !== 'string' || !v.trim()) return '';
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// 文本累计：追加到已有文本（截断在累计时控制）
function appendText(existing, part) {
  if (!part || typeof part !== 'object') return existing;
  if (part.type === 'think' && typeof part.think === 'string') {
    return summarize(`${existing ? `${existing} ` : ''}${part.think}`, STEP_TEXT_MAX);
  }
  if (part.type === 'text' && typeof part.text === 'string') {
    return summarize(`${existing ? `${existing} ` : ''}${part.text}`, STEP_TEXT_MAX);
  }
  return existing;
}

// finishReason -> step/agent 状态：interrupted 截断态直译；failed/error -> failed；
// tool_use/end_turn/缺省 -> completed；未知值保守归 completed（不强行猜）
function statusFromFinishReason(reason) {
  const r = typeof reason === 'string' ? reason : '';
  if (r === 'interrupted') return 'interrupted';
  if (r === 'failed' || r === 'error') return 'failed';
  return 'completed';
}

// 解析单个 wire.jsonl：返回 { ok:false } 或 { ok:true, steps, status, firstTime, lastTime, badLines, agentCalls }
// agentCalls: 父 wire 中 Agent 工具调用 [{ toolCallId, description, subagentType, time }]（供子代理启发式匹配）
function parseWire(wirePath) {
  let text;
  try {
    text = fs.readFileSync(wirePath, 'utf8');
  } catch {
    return { ok: false };
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const steps = []; // 有序步骤条目
  const stepBySeq = new Map(); // `${turnId}:${step}` -> step 条目（step.end 定位用）
  const toolById = new Map(); // toolCallId -> tool 条目（tool.result 定位用）
  const agentCalls = [];
  let badLines = 0;
  let firstTime = 0;
  let lastTime = 0;
  let firstTurnId = null; // 首条 step.begin 的 turnId（wire 内 turn 序号，非事件 seq）
  let loopEvents = 0;

  const pushStep = (entry) => {
    steps.push(entry);
    if (steps.length > MAX_STEPS) steps.shift(); // 只保留最新 MAX_STEPS 条
  };

  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!ev || typeof ev !== 'object') {
      badLines++;
      continue;
    }
    if (typeof ev.time === 'number' && ev.time > 0) {
      if (!firstTime || ev.time < firstTime) firstTime = ev.time;
      if (ev.time > lastTime) lastTime = ev.time;
    }
    if (ev.type !== 'context.append_loop_event' || !ev.event || typeof ev.event !== 'object') continue;
    if (++loopEvents > MAX_LOOP_EVENTS) break;
    const e = ev.event;
    const seqKey = `${e.turnId || '0'}:${e.step != null ? e.step : ''}`;

    if (e.type === 'step.begin') {
      if (firstTurnId === null) firstTurnId = typeof e.turnId === 'string' && e.turnId ? e.turnId : '0';
      const entry = {
        stepId: typeof e.uuid === 'string' && e.uuid ? e.uuid : `step-${steps.length + 1}`,
        seq: typeof e.step === 'number' ? e.step : steps.length + 1,
        kind: 'step',
        status: 'running',
        text: '',
        toolCallId: null,
        output: '',
      };
      pushStep(entry);
      stepBySeq.set(seqKey, entry);
    } else if (e.type === 'step.end') {
      const entry = stepBySeq.get(seqKey);
      if (entry) entry.status = statusFromFinishReason(e.finishReason);
    } else if (e.type === 'content.part') {
      // 挂到最近未闭合 step（stepUuid 与 step.begin 的 uuid 同源）
      let target = null;
      if (typeof e.stepUuid === 'string' && e.stepUuid) {
        target = [...stepBySeq.values()].find((s) => s.stepId === e.stepUuid && s.status === 'running');
      }
      if (!target) {
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i].kind === 'step' && steps[i].status === 'running') { target = steps[i]; break; }
        }
      }
      if (target) target.text = appendText(target.text, e.part);
    } else if (e.type === 'tool.call') {
      const args = e.args && typeof e.args === 'object' ? e.args : {};
      const entry = {
        stepId: typeof e.uuid === 'string' && e.uuid ? e.uuid : `tool-${steps.length + 1}`,
        seq: typeof e.step === 'number' ? e.step : steps.length + 1,
        kind: 'tool',
        status: 'running',
        text: summarize(`${e.name || ''}${typeof args.description === 'string' && args.description ? `: ${args.description}` : ''}`, STEP_TEXT_MAX),
        toolCallId: typeof e.toolCallId === 'string' ? e.toolCallId : null,
        output: '',
      };
      pushStep(entry);
      if (entry.toolCallId) toolById.set(entry.toolCallId, entry);
      if (e.name === 'Agent') {
        agentCalls.push({
          toolCallId: entry.toolCallId,
          description: typeof args.description === 'string' ? args.description : '',
          subagentType: typeof args.subagent_type === 'string' ? args.subagent_type : '',
          time: ev.time || 0,
        });
      }
    } else if (e.type === 'tool.result') {
      const entry = toolById.get(e.toolCallId);
      if (!entry) continue;
      const result = e.result && typeof e.result === 'object' ? e.result : {};
      entry.status = result.isError === true ? 'failed' : 'completed';
      const out = typeof result.output === 'string' ? result.output : '';
      entry.output = summarize(out, OUTPUT_MAX);
    }
  }

  // agent 状态推断：无 step 类条目 -> unknown；有未闭合 step -> running；
  // 全部闭合 -> 最后一条闭合 step 的状态（interrupted/failed/completed 透传）
  let status = 'unknown';
  const stepEntries = steps.filter((s) => s.kind === 'step');
  if (stepEntries.length > 0) {
    const open = stepEntries.find((s) => s.status === 'running');
    if (open) {
      status = 'running';
    } else {
      status = stepEntries[stepEntries.length - 1].status;
    }
  }

  return { ok: true, steps, status, firstTime, lastTime, badLines, agentCalls, firstTurnId: firstTurnId || '0' };
}

// state.json agents 映射读取：{ id: { homedir, type, parentAgentId } }；
// 缺失/损坏 -> null（调用方按目录枚举降级）
function readAgentsMap(sessionDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.agents || typeof raw.agents !== 'object') return null;
    const map = {};
    for (const [id, info] of Object.entries(raw.agents)) {
      if (!info || typeof info !== 'object') continue;
      map[id] = {
        type: info.type === 'sub' ? 'sub' : 'main',
        parentAgentId: typeof info.parentAgentId === 'string' && info.parentAgentId ? info.parentAgentId : null,
      };
    }
    return Object.keys(map).length ? map : null;
  } catch {
    return null;
  }
}

// 父链解析：父不存在或沿链成环（含自环）-> '__unknown__'；正常 -> 最近可解析父（可为 null 顶层）
function resolveParent(agentId, agentsMap, ids) {
  let parent = agentsMap[agentId] ? agentsMap[agentId].parentAgentId : null;
  if (!parent) return null;
  const seen = new Set();
  while (parent) {
    if (!ids.has(parent)) return UNKNOWN_PARENT; // 缺父
    if (seen.has(parent)) return UNKNOWN_PARENT; // 循环
    seen.add(parent);
    parent = agentsMap[parent] ? agentsMap[parent].parentAgentId : null;
  }
  return seen.size ? [...seen][0] : null;
}

// 启发式 parentToolCallId/description/agentType：父 wire 的 Agent 工具调用中，
// 与子代理 wire 首事件时间（firstTime）绝对差最小者即为派生子代理的调用；
// 无任何 Agent 调用 -> parentToolCallId=null、description=''、agentType 回落 'coder'（CLI 默认）
function matchParentCall(agentCalls, firstTime) {
  if (!agentCalls || agentCalls.length === 0) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const c of agentCalls) {
    const diff = Math.abs(c.time - (firstTime || 0));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

// 构建子代理树（主入口）。
// buildSubagentTree(sessionDir, { sessionId }) -> { ok, sessionId, nodes, diagnostics }
// sessionDir 不存在 -> { ok:false, error, nodes:[] }；其余容错路径始终 ok:true。
function buildSubagentTree(sessionDir, opts) {
  const sessionId = opts && typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : path.basename(sessionDir);
  if (!sessionDir || !fs.existsSync(sessionDir)) {
    return { ok: false, error: '会话目录不存在', sessionId, nodes: [], diagnostics: null };
  }

  const diagnostics = { scannedAgents: 0, badFiles: 0, badLines: 0, unknownParents: 0 };
  const agentsRoot = path.join(sessionDir, 'agents');
  const agentsMap = readAgentsMap(sessionDir);
  let dirIds = [];
  try {
    dirIds = fs.readdirSync(agentsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    dirIds = [];
  }
  diagnostics.scannedAgents = dirIds.length;
  // 映射集 = state.json 登记 ∪ 磁盘目录（两者并集都能建节点）
  const ids = new Set([...Object.keys(agentsMap || {}), ...dirIds]);

  // 第一遍：读每个 agent wire，收集步骤与 Agent 调用
  const parsed = new Map(); // agentId -> parseWire 结果
  for (const id of ids) {
    const wirePath = path.join(agentsRoot, id, 'wire.jsonl');
    const p = parseWire(wirePath);
    if (!p.ok) {
      diagnostics.badFiles++;
      continue;
    }
    diagnostics.badLines += p.badLines;
    parsed.set(id, p);
  }

  // 第二遍：解析父链 + 启发式匹配 + 组装节点
  const nodes = [];
  for (const id of ids) {
    const p = parsed.get(id);
    if (!p) continue; // wire 缺失/不可读 -> 不建节点（坏文件已在 badFiles 计数）
    const meta = agentsMap && agentsMap[id] ? agentsMap[id] : { type: id === 'main' ? 'main' : 'sub', parentAgentId: null };
    let parentAgentId = resolveParent(id, agentsMap || {}, ids);
    if (parentAgentId === UNKNOWN_PARENT) diagnostics.unknownParents++;

    let parentToolCallId = null;
    let description = '';
    let agentType = meta.type === 'main' ? 'main' : 'coder'; // 子代理缺省 coder
    if (meta.type !== 'main') {
      const parentParsed = parentAgentId && parentAgentId !== UNKNOWN_PARENT ? parsed.get(parentAgentId) : null;
      const call = matchParentCall(parentParsed ? parentParsed.agentCalls : null, p.firstTime);
      if (call) {
        parentToolCallId = call.toolCallId;
        description = call.description || '';
        if (call.subagentType) agentType = call.subagentType;
      }
    }

    nodes.push({
      sessionId,
      turnId: p.firstTurnId,
      agentId: id,
      parentAgentId,
      parentToolCallId,
      agentType,
      status: p.status,
      description,
      steps: p.steps,
      updatedAt: p.lastTime || 0,
    });
  }

  // 稳定排序：main 优先，其余按首事件时间升序
  nodes.sort((a, b) => {
    if (a.agentId === 'main') return -1;
    if (b.agentId === 'main') return 1;
    return (a.updatedAt || 0) - (b.updatedAt || 0);
  });

  return { ok: true, sessionId, nodes, diagnostics };
}

module.exports = { buildSubagentTree, UNKNOWN_PARENT };
