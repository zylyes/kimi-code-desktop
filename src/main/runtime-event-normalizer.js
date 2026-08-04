// 运行时事件规范化（纯函数，无状态，无 electron 依赖）
// 将 WS / ACP / 磁盘三种来源的原始事件统一为内部事件形态，供 RuntimeState 消费。
// 无法识别或不符合过滤条件的输入返回 null。
'use strict';

// 数值提取容错：非数字 -> 0；数字字符串（如 "123"）按数字处理
function num(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return 0;
}

// 按候选键依次取值；键不存在或值为 null/undefined -> null
function pickNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return num(obj[k]);
  }
  return null;
}

// 按候选键依次取字符串值（防御 info 字段漂移）；空串/非字符串 -> 继续下一候选，全空 -> null
function pickStr(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : String(v);
    if (s.trim() !== '') return s;
  }
  return null;
}

// 从 WS usage payload 提取 { totalTokens, contextUsed, contextLimit }
// 兼容 usage 嵌套对象/平铺、total_tokens/totalTokens、input+output 兜底
function extractUsage(payload) {
  const u = payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
  let total = u ? pickNum(u, ['total_tokens', 'totalTokens']) : null;
  if (total === null) total = pickNum(payload, ['total_tokens', 'totalTokens']);
  if (total === null) {
    const input = (u ? pickNum(u, ['input_tokens', 'inputTokens']) : null)
      ?? pickNum(payload, ['input_tokens', 'inputTokens']) ?? 0;
    const output = (u ? pickNum(u, ['output_tokens', 'outputTokens']) : null)
      ?? pickNum(payload, ['output_tokens', 'outputTokens']) ?? 0;
    total = input + output;
  }
  const contextUsed = (u ? pickNum(u, ['context_used', 'contextUsed']) : null)
    ?? pickNum(payload, ['context_used', 'contextUsed']) ?? 0;
  const contextLimit = (u ? pickNum(u, ['context_limit', 'contextLimit']) : null)
    ?? pickNum(payload, ['context_limit', 'contextLimit']) ?? 0;
  return { totalTokens: total, contextUsed, contextLimit };
}

// WS 事件：{ event, payload, session_id?, sessionId? }
// 事件名兼容带/不带 `event.` 前缀两种变体
function normalizeWsEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawKind = typeof raw.event === 'string' ? raw.event : '';
  const name = rawKind.replace(/^event\./, '');
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload
    : raw.data && typeof raw.data === 'object' ? raw.data
    : {};

  let kind = null;
  let status = null;
  switch (name) {
    case 'task.started': kind = 'task.started'; status = 'running'; break;
    case 'task.progress': kind = 'task.progress'; status = 'running'; break;
    case 'task.completed':
    case 'task.done': kind = 'task.completed'; status = 'completed'; break;
    case 'session.usage_updated': kind = 'usage.updated'; break;
    default: {
      // agent.created / agent.status.updated：未实测且无法辨别主/子 agent，
      // 保守返回 null，不伪造生命周期事件；子代理活动统一由 subagent.spawned/started 覆盖。
      if (name === 'subagent.spawned' || name === 'subagent.started') break; // 下方单独处理
      return null; // 无法识别
    }
  }

  // 已实测（CLI 0.31.1）：subagent.spawned（payload 含 agentId/callerAgentId/description/
  // parentAgentId/parentToolCallId/runInBackground/sessionId/subagentId/subagentName）与
  // subagent.started（payload 仅 sessionId/subagentId）-> task.observed(running)，
  // agentType 非 null 使 RuntimeState.getActiveCounts 计入 agents 类。
  // 不虚构 completed/failed：未实测对应终止事件，running 态只做 runtime 活动触发 /
  // Tasks-Catalog 低延迟补充，终止态以磁盘 subagent-tree 快照为事实源。
  if (name === 'subagent.spawned' || name === 'subagent.started') {
    const subagentId = pickStr(payload, ['subagentId']);
    if (!subagentId) return null; // 无身份 -> 无法形成可观测任务
    const sessionId = pickStr(raw, ['session_id', 'sessionId'])
      || pickStr(payload, ['session_id', 'sessionId']);
    const subagentName = pickStr(payload, ['subagentName']);
    const description = pickStr(payload, ['description']);
    return {
      source: 'ws',
      kind: 'task.observed',
      sessionId,
      taskId: subagentId,
      at: Date.now(), // WS 无时间戳 -> 函数内取
      title: description || subagentName || 'subagent',
      status: 'running',
      usage: null,
      agentType: subagentName || 'subagent',
      confidence: 'high',
      rawKind: rawKind || name,
    };
  }

  // M1 实测：task.started payload 顶层为 { agentId, info:object, sessionId, type }，
  // task_id 不在顶层，且 info 内字段会漂移 -> 防御性多候选取值。
  const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
  const sessionId = pickStr(raw, ['session_id', 'sessionId'])
    || pickStr(payload, ['session_id', 'sessionId'])
    || pickStr(info, ['session_id', 'sessionId']);
  const taskId = pickStr(payload, ['task_id', 'taskId'])
    || pickStr(info, ['task_id', 'taskId', 'id', 'toolCallId']);

  const ev = {
    source: 'ws',
    kind,
    sessionId,
    taskId,
    at: Date.now(), // WS 无时间戳 -> 函数内取
    title: '',
    status,
    usage: null,
    agentType: null,
    confidence: 'high',
    rawKind: rawKind || name,
  };
  if (kind === 'usage.updated') {
    ev.usage = extractUsage(payload);
  } else {
    ev.title = pickStr(payload, ['title']) || pickStr(info, ['title', 'description']) || '';
  }
  return ev;
}

// ACP 工具事件：update 的字段（toolCallId/title/kind/status/rawInput/rawOutput）直接挂在 update 上。
// 仅当 title==='Agent'、title==='Task'（Agent 内置后台任务工具）或 rawInput.subagent_type 非空
// （子代理形态）时返回事件，否则 null。
function normalizeAcpToolCall(sessionId, update) {
  if (!update || typeof update !== 'object') return null;
  const rawKind = update.sessionUpdate || '';
  if (rawKind !== 'tool_call' && rawKind !== 'tool_call_update') return null;
  const rawInput = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {};
  const agentType = rawInput.subagent_type || null;
  if (update.title !== 'Agent' && update.title !== 'Task' && !agentType) return null; // 非子代理/非 Task 工具 -> null

  let status = null;
  if (rawKind === 'tool_call') {
    status = 'running';
  } else {
    if (update.status === 'in_progress') status = 'running';
    else if (update.status === 'completed') status = 'completed';
    else if (update.status === 'failed') status = 'failed';
    else return null; // 其他状态 -> null
  }

  return {
    source: 'acp',
    kind: 'task.observed',
    sessionId: sessionId || null,
    taskId: update.toolCallId || null,
    at: Date.now(), // ACP 无时间戳 -> 函数内取
    title: rawInput.description || update.title || '',
    status,
    usage: null,
    agentType,
    confidence: 'high',
    rawKind,
  };
}

// Cron 短字段摘要：白名单键（id/name/label/description/schedule），字符串截断 120 字符；
// 不含 command 全文。非字符串/空值跳过。
function extractCronShortFields(rawInput) {
  const detail = {};
  const KEYS = ['id', 'name', 'label', 'description', 'schedule'];
  for (const k of KEYS) {
    const v = rawInput[k];
    if (typeof v === 'string' && v.trim()) detail[k] = v.slice(0, 120);
  }
  return detail;
}

// M6：CronList rawOutput 规范化硬上限（导出供测试与调用方知情）。
// CRON_LIST_RAW_MAX_CHARS：JSON.parse 前的字符（UTF-16 code unit）长度硬上限——
//   超长 rawOutput 一律不解析，防超长 JSON.parse 的瞬时 CPU/内存峰值；
// CRON_LIST_MAX_ITEMS：解析成功后数组条目数硬上限——超量视为不可信/可能截断的列表，
//   整体跳过该 list 事件（不生成 list snapshot，避免破坏/误删现有 cron 观察）。
const LIMITS = {
  CRON_LIST_RAW_MAX_CHARS: 256 * 1024,
  CRON_LIST_MAX_ITEMS: 500,
};

// CronList 列表项：防御性解析 rawOutput JSON 数组（每项仅保留短字段）。
// 解析失败 / rawOutput 超长 / 数组条目超量 -> 回落 rawInput 摘要（非数组 detail，
// TaskCatalog 对非数组 detail 不产生任何 list upsert，为安全 no-op，不清空既有 cron）。
function parseCronList(rawInput, rawOutput) {
  if (typeof rawOutput === 'string' && rawOutput.trim()) {
    if (rawOutput.length > LIMITS.CRON_LIST_RAW_MAX_CHARS) {
      // M6：解析前硬上限——不 JSON.parse，回落摘要 = 无 list snapshot（不破坏现有 cron）
      return extractCronShortFields(rawInput);
    }
    try {
      const parsed = JSON.parse(rawOutput);
      if (Array.isArray(parsed)) {
        if (parsed.length > LIMITS.CRON_LIST_MAX_ITEMS) {
          // M6：条目超量——不截断映射（不完整截断数组不可作为完整 CronList snapshot），
          // 整体跳过整个 list 事件，回落摘要 no-op。
          return extractCronShortFields(rawInput);
        }
        return parsed
          .filter((it) => it && typeof it === 'object')
          .map((it) => extractCronShortFields(it));
      }
    } catch { /* 非 JSON -> 忽略，回落 rawInput 摘要 */ }
  }
  return extractCronShortFields(rawInput);
}

// ACP 目录类工具事件：CronCreate/CronList/CronDelete -> cron.observed；
// TaskOutput/TaskStop -> tasktool.observed（与 runtimeState 同键互证）。
// 与 normalizeAcpToolCall 正交：Task/Agent/Read 等其余工具返回 null。
// status 映射同 Agent 路径：tool_call(pending)->running；update in_progress->running、
// completed->completed、failed->failed；其余状态 -> null。
function normalizeAcpCatalogEvent(sessionId, update) {
  if (!update || typeof update !== 'object') return null;
  const rawKind = update.sessionUpdate || '';
  if (rawKind !== 'tool_call' && rawKind !== 'tool_call_update') return null;

  let status = null;
  if (rawKind === 'tool_call') {
    status = 'running';
  } else {
    if (update.status === 'in_progress') status = 'running';
    else if (update.status === 'completed') status = 'completed';
    else if (update.status === 'failed') status = 'failed';
    else return null; // 其他状态 -> null
  }

  const title = update.title || '';
  const toolCallId = update.toolCallId || null;
  const rawInput = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {};

  if (title === 'CronCreate' || title === 'CronDelete') {
    return {
      source: 'acp',
      kind: 'cron.observed',
      cronAction: title,
      sessionId: sessionId || null,
      taskId: toolCallId,
      status,
      title: rawInput.description || title,
      detail: extractCronShortFields(rawInput),
    };
  }
  if (title === 'CronList') {
    return {
      source: 'acp',
      kind: 'cron.observed',
      cronAction: title,
      sessionId: sessionId || null,
      taskId: toolCallId,
      status,
      title,
      detail: parseCronList(rawInput, update.rawOutput),
    };
  }
  if (title === 'TaskOutput' || title === 'TaskStop') {
    return {
      source: 'acp',
      kind: 'tasktool.observed',
      sessionId: sessionId || null,
      taskId: toolCallId,
      status,
      title,
    };
  }
  return null;
}

// 磁盘任务 tasks/*.json（格式未文档化，防御性提取 id/status/description/title）
// 状态映射：running/completed/failed 直译；其他非空值保守归 'completed'（不强行猜）；
// status 缺失 -> null（由 state 层按 observed 处理）。
function normalizeDiskTask(sessionId, taskJson) {
  if (!taskJson || typeof taskJson !== 'object' || Array.isArray(taskJson)) return null;
  const taskId = taskJson.id || taskJson.taskId || null;
  const rawStatus = typeof taskJson.status === 'string' ? taskJson.status : '';
  let status = null;
  if (rawStatus === 'running') status = 'running';
  else if (rawStatus === 'completed') status = 'completed';
  else if (rawStatus === 'failed') status = 'failed';
  else if (rawStatus !== '') status = 'completed'; // 未知值保守归 completed
  // rawStatus === '' -> status 保持 null

  return {
    source: 'disk',
    kind: 'task.observed',
    sessionId: sessionId || null,
    taskId,
    at: Date.now(),
    title: taskJson.title || taskJson.description || '',
    status,
    usage: null,
    agentType: null,
    confidence: 'medium',
    rawKind: 'disk.task',
  };
}

module.exports = { normalizeWsEvent, normalizeAcpToolCall, normalizeAcpCatalogEvent, normalizeDiskTask, LIMITS };
