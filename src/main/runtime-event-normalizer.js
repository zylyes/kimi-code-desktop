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
    default: return null; // 无法识别
  }

  const sessionId = raw.session_id || raw.sessionId || payload.session_id || null;
  const taskId = payload.task_id || payload.taskId || null;

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
    ev.title = payload.title || '';
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

// CronList 列表项：防御性解析 rawOutput JSON 数组（每项仅保留短字段）；解析失败回落 rawInput 摘要
function parseCronList(rawInput, rawOutput) {
  if (typeof rawOutput === 'string' && rawOutput.trim()) {
    try {
      const parsed = JSON.parse(rawOutput);
      if (Array.isArray(parsed)) {
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

module.exports = { normalizeWsEvent, normalizeAcpToolCall, normalizeAcpCatalogEvent, normalizeDiskTask };
