// 子代理树构建（Phase 6a）：会话根 state.json 的 agents 映射（父子关系唯一来源）
// + agents/<id>/wire.jsonl 的 context.append_loop_event 步骤补绘。纯 Node 无 electron。
// 安全边界（M4 修复）：sessionDir 及其所有后代（state.json / agents / agents/<id> / wire.jsonl）
// 一律 lstatSync 校验（不跟随），symlink/junction 严格跳过、不读外部内容，计入 diagnostics.skippedLinks；
// sessionDir 自身必须为真实目录且非链接，否则返回既有 ok:false 失败形态（不抛）。
// M6 资源上限：wire.jsonl 有限读取——单文件超 WIRE_MAX_BYTES 截断读取（只保留完整行、
// 残行丢弃绝不解析），单次调用最多读 WIRE_MAX_FILES 个 wire、总读取字节不超过
// WIRE_TOTAL_BYTES（超限跳过）；截断/跳过计入 diagnostics.truncatedFiles/skippedFiles/bytesRead，
// 每次调用独立。上限缺口补全：state.json 有限大小读取（超限不整体 JSON.parse，目录枚举降级）、
// state.json agents 映射条目上限、agents 目录流式有界枚举（达到候选数上限即停止）、
// 输出节点数上限（排序后确定性截断）——均计入 diagnostics.stateOversized/stateAgentsTruncated/
// enumerateTruncated/nodesTruncated，不抛。
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
// diagnostics: { scannedAgents, badFiles, badLines, unknownParents, skippedLinks }
'use strict';

const fs = require('fs');
const path = require('path');

const UNKNOWN_PARENT = '__unknown__';
const STEP_TEXT_MAX = 200; // 步骤文本截断长度
const OUTPUT_MAX = 500; // 工具输出截断长度
const MAX_STEPS = 200; // 每节点步骤数上限（保留最新）
const MAX_LOOP_EVENTS = 5000; // 每个 wire 最多处理的 loop 事件数（防超大文件拖垮）

// M6 资源上限（Workspace projection）：wire.jsonl 有限读取。
// 单文件超 WIRE_MAX_BYTES 截断读取（只保留完整行，残行不解析）；
// 单次调用最多读 WIRE_MAX_FILES 个 wire；总读取字节不超过 WIRE_TOTAL_BYTES（超限跳过）。
// M6 上限缺口补全：state.json 有限大小读取（超限不整体 JSON.parse，目录枚举降级）；
// state.json agents 映射条目上限（超限确定性截断）；agents 目录流式有界枚举
// （达到候选数上限即停止，不物化无界条目）；输出节点数上限（排序后确定性截断）。
const LIMITS = {
  WIRE_MAX_BYTES: 4 * 1024 * 1024, // 单个 wire.jsonl 最多读取字节（超出截断）
  WIRE_MAX_FILES: 200, // 单次调用最多读取的 wire 文件数（超出跳过）
  WIRE_TOTAL_BYTES: 8 * 1024 * 1024, // 单次调用所有 wire 累计读取字节上限（超出跳过）
  STATE_MAX_BYTES: 512 * 1024, // state.json 读取大小上限（超出不整体 JSON.parse，目录枚举降级）
  STATE_MAX_AGENTS: 500, // state.json agents 映射条目上限（超出确定性截断，跳过剩余）
  AGENTS_ENUM_MAX: 1000, // agents 目录有效候选（真实目录）枚举上限（达到即停止，不读剩余条目）
  AGENTS_ENUM_ITEMS_MAX: 1500, // agents 目录总条目枚举保险上限（防垃圾条目洪水，达到即停止）
  MAX_AGENT_NODES: 500, // 输出节点数上限（排序后确定性截断）
};

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

// M6 有限读取 wire.jsonl：最多读 maxBytes 且不超 budget 字节（保守上限，绝不 whole-file
// 无上限读取）；文件更大/预算不足时截断，但只保留完整行——最后一个不完整行（残行）丢弃，
// 绝不中途解析残行。返回 { text, bytesRead, truncated } 或 null（打开/stat 失败）。
function readWireBounded(wirePath, maxBytes, budget) {
  let fd;
  try {
    fd = fs.openSync(wirePath, 'r');
  } catch {
    return null;
  }
  try {
    let size;
    try {
      size = fs.fstatSync(fd).size;
    } catch {
      return null;
    }
    const len = Math.max(0, Math.min(size, maxBytes, budget));
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, read);
      if (n <= 0) break;
      read += n;
    }
    let text = buf.toString('utf8', 0, read);
    const truncated = read < size;
    if (truncated) {
      // 只保留完整行：丢弃最后一个不完整行（残行），含其 '\r'（'\r\n' 尾随，不残留半行）
      const nl = text.lastIndexOf('\n');
      text = nl < 0 ? '' : text.slice(0, nl + 1);
    }
    return { text, bytesRead: read, truncated };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// 解析单个 wire.jsonl：返回 { ok:false } 或 { ok:true, steps, status, firstTime, lastTime, badLines, agentCalls, bytesRead, truncated }
// agentCalls: 父 wire 中 Agent 工具调用 [{ toolCallId, description, subagentType, time }]（供子代理启发式匹配）
// bytesRead/truncated: 本次有限读取实际字节数与是否截断（M6 预算/诊断用）
function parseWire(wirePath, opts) {
  const maxBytes = opts && opts.maxBytes != null ? opts.maxBytes : LIMITS.WIRE_MAX_BYTES;
  const budget = opts && opts.budget != null ? opts.budget : LIMITS.WIRE_TOTAL_BYTES;
  const r = readWireBounded(wirePath, maxBytes, budget);
  if (!r) return { ok: false };
  const lines = r.text.split(/\r?\n/).filter(Boolean);
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

  return { ok: true, steps, status, firstTime, lastTime, badLines, agentCalls, firstTurnId: firstTurnId || '0', bytesRead: r.bytesRead, truncated: r.truncated };
}

// agentId 安全校验（M4 修复）：state.json 来源的 id 必须是单一文件路径段。
// 拒绝：空串、'.'/'..'、含路径分隔符（'/' 或 '\\'，覆盖 POSIX/Windows 绝对与多段穿越）、
// NUL、path.isAbsolute 判定为绝对（Windows 盘符/UNC）、Windows 盘符相对形式（'C:' / 'C:foo'，
// isAbsolute 不判定但 CreateFile 语义可解析出盘符）。
function isSafeAgentId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('\0') || id.includes('/') || id.includes('\\')) return false;
  if (path.isAbsolute(id)) return false;
  if (/^[A-Za-z]:/.test(id)) return false;
  return true;
}

// 严格 containment：target 必须位于 root 内（root 自身或其真实后代），禁止逃逸
function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// state.json agents 映射读取：{ id: { homedir, type, parentAgentId } }；
// 缺失/损坏/超大 -> { map: null }（调用方按目录枚举降级）；
// 非法 agentId（路径逃逸形式）跳过并计数 rejected：不进入映射、不参与任何路径构造。
// M6 上限：state.json 有限大小读取——open 后 fstat，超 STATE_MAX_BYTES 不整体 JSON.parse
// （diagnostics.stateOversized 记录，按目录枚举降级，不抛）；agents 映射条目超
// STATE_MAX_AGENTS 确定性截断（跳过剩余条目，diagnostics.stateAgentsTruncated 记录）。
function readAgentsMap(sessionDir, diagnostics) {
  let fd;
  try {
    fd = fs.openSync(path.join(sessionDir, 'state.json'), 'r');
  } catch {
    return { map: null, rejected: 0 };
  }
  let raw;
  try {
    let size;
    try {
      size = fs.fstatSync(fd).size;
    } catch {
      return { map: null, rejected: 0 };
    }
    if (size > LIMITS.STATE_MAX_BYTES) {
      diagnostics.stateOversized++;
      return { map: null, rejected: 0 }; // 超限不解析：目录枚举降级
    }
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    raw = JSON.parse(buf.toString('utf8', 0, read));
  } catch {
    return { map: null, rejected: 0 };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  if (!raw || typeof raw !== 'object' || !raw.agents || typeof raw.agents !== 'object') {
    return { map: null, rejected: 0 };
  }
  const map = {};
  let rejected = 0;
  let count = 0;
  for (const [id, info] of Object.entries(raw.agents)) {
    if (count >= LIMITS.STATE_MAX_AGENTS) {
      diagnostics.stateAgentsTruncated++; // 映射条目超上限：确定性截断，跳过剩余
      break;
    }
    count++;
    if (!isSafeAgentId(id)) {
      rejected++;
      continue;
    }
    if (!info || typeof info !== 'object') continue;
    map[id] = {
      type: info.type === 'sub' ? 'sub' : 'main',
      parentAgentId: typeof info.parentAgentId === 'string' && info.parentAgentId ? info.parentAgentId : null,
    };
  }
  return { map: Object.keys(map).length ? map : null, rejected };
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
  if (!sessionDir) {
    return { ok: false, error: '会话目录不存在', sessionId, nodes: [], diagnostics: null };
  }
  // sessionDir 自身必须为真实目录且非 symlink/junction：lstat 不跟随，缺失/链接/非目录 -> 既有失败形态
  let sessionStat;
  try {
    sessionStat = fs.lstatSync(sessionDir);
  } catch {
    return { ok: false, error: '会话目录不存在', sessionId, nodes: [], diagnostics: null };
  }
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
    return { ok: false, error: '会话目录不存在', sessionId, nodes: [], diagnostics: null };
  }

  const diagnostics = {
    scannedAgents: 0, badFiles: 0, badLines: 0, unknownParents: 0, skippedLinks: 0, skippedInvalidIds: 0,
    truncatedFiles: 0, skippedFiles: 0, bytesRead: 0, // M6 资源上限：截断/跳过/实际读取字节
    stateOversized: 0, stateAgentsTruncated: 0, enumerateTruncated: 0, nodesTruncated: 0, // M6 上限缺口：state/枚举/节点截断
  };
  const agentsRoot = path.join(sessionDir, 'agents');

  // state.json 为链接则跳过（不读外部映射），按既有目录枚举降级
  let agentsMap = null;
  let stateStat = null;
  try { stateStat = fs.lstatSync(path.join(sessionDir, 'state.json')); } catch { /* 缺失/不可读 -> readAgentsMap 自行处理 */ }
  if (stateStat && stateStat.isSymbolicLink()) {
    diagnostics.skippedLinks++;
  } else {
    const rmap = readAgentsMap(sessionDir, diagnostics);
    agentsMap = rmap.map;
    diagnostics.skippedInvalidIds += rmap.rejected;
  }

  // agents 目录：链接则整体跳过（任何后代路径都会穿过它）；否则流式有界枚举
  // （opendir 逐个读取，不一次物化无界条目；达到候选数上限即停止，无需读取剩余文件），
  // 逐条目 lstat 校验目录真实非链接。
  let agentsRootLink = false;
  let dirIds = [];
  let agentsRootStat = null;
  try { agentsRootStat = fs.lstatSync(agentsRoot); } catch { /* 缺失 -> 既有降级空枚举 */ }
  if (agentsRootStat && agentsRootStat.isSymbolicLink()) {
    diagnostics.skippedLinks++;
    agentsRootLink = true;
  } else if (agentsRootStat) {
    let dh = null;
    try { dh = fs.opendirSync(agentsRoot); } catch { dh = null; }
    if (dh) {
      let itemsRead = 0;
      try {
        for (;;) {
          const d = dh.readSync();
          if (!d) break; // 目录读完
          if (dirIds.length >= LIMITS.AGENTS_ENUM_MAX || itemsRead >= LIMITS.AGENTS_ENUM_ITEMS_MAX) {
            diagnostics.enumerateTruncated++; // 达到候选/条目上限：停止枚举，剩余条目不读
            break;
          }
          itemsRead++;
          const p = path.join(agentsRoot, d.name);
          let st;
          try { st = fs.lstatSync(p); } catch { continue; } // 条目竞态消失：跳过
          if (st.isSymbolicLink()) { diagnostics.skippedLinks++; continue; } // agent 目录链接（junction 同样覆盖）
          if (!st.isDirectory()) continue;
          dirIds.push(d.name);
        }
      } finally {
        try { dh.closeSync(); } catch { /* ignore */ }
      }
    }
  }
  diagnostics.scannedAgents = dirIds.length;
  // 映射集 = state.json 登记 ∪ 磁盘目录（两者并集都能建节点）
  const ids = new Set([...Object.keys(agentsMap || {}), ...dirIds]);

  // 第一遍：读每个 agent wire，收集步骤与 Agent 调用
  const parsed = new Map(); // agentId -> parseWire 结果
  let wireFilesTried = 0; // 已尝试读取的 wire 文件数（文件数上限）
  let wireBytesLeft = LIMITS.WIRE_TOTAL_BYTES; // 剩余读取字节预算
  for (const id of ids) {
    if (agentsRootLink) continue; // agents 目录是链接：任何 wire 路径都会穿过它 -> 一律不读
    if (!isSafeAgentId(id)) { diagnostics.skippedInvalidIds++; continue; } // 非法 id（纵深防御，readAgentsMap 已过滤）
    const agentDir = path.join(agentsRoot, id);
    if (!isWithin(agentsRoot, agentDir)) { diagnostics.skippedInvalidIds++; continue; } // 严格 containment：禁止逃逸 agentsRoot
    if (wireFilesTried >= LIMITS.WIRE_MAX_FILES) { diagnostics.skippedFiles++; continue; } // 文件数上限：不再尝试读取
    if (wireBytesLeft <= 0) { diagnostics.skippedFiles++; continue; } // 总字节预算耗尽：不再读取
    let st;
    try { st = fs.lstatSync(agentDir); } catch { st = null; } // 缺失 -> parseWire 失败计 badFiles
    if (st && st.isSymbolicLink()) {
      continue; // 目录链接：跳过该 agent（不跟随）；枚举阶段已计入 skippedLinks，此处不重复计
    }
    const wirePath = path.join(agentDir, 'wire.jsonl');
    let wst;
    try { wst = fs.lstatSync(wirePath); } catch { wst = null; }
    if (wst && wst.isSymbolicLink()) {
      diagnostics.skippedLinks++; // wire.jsonl 链接：跳过（不读外部内容）
      continue;
    }
    wireFilesTried++;
    const p = parseWire(wirePath, { maxBytes: LIMITS.WIRE_MAX_BYTES, budget: wireBytesLeft });
    if (!p.ok) {
      diagnostics.badFiles++;
      continue;
    }
    wireBytesLeft -= p.bytesRead;
    if (p.truncated) diagnostics.truncatedFiles++;
    diagnostics.badLines += p.badLines;
    parsed.set(id, p);
  }
  diagnostics.bytesRead = LIMITS.WIRE_TOTAL_BYTES - wireBytesLeft; // 本次实际读取字节（M6 可见性）

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

  // M6 上限：输出节点数上限——排序后确定性截断（main 优先、时间升序的前 N 个保留），
  // 截断量计入 diagnostics.nodesTruncated，不抛。
  if (nodes.length > LIMITS.MAX_AGENT_NODES) {
    diagnostics.nodesTruncated = nodes.length - LIMITS.MAX_AGENT_NODES;
    nodes.length = LIMITS.MAX_AGENT_NODES;
  }

  return { ok: true, sessionId, nodes, diagnostics };
}

module.exports = { buildSubagentTree, UNKNOWN_PARENT, LIMITS };
