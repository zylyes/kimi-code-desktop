// Kimi Code Desktop — 会话导出与子 Agent 监视后端
// 只读解析 <sessionDir>/agents/<id>/wire.jsonl，生成 Markdown 导出与子任务时间线。
// wire.jsonl 格式未官方承诺稳定，全部防御性解析：损坏行与未知事件一律跳过。
const fs = require('fs');
const path = require('path');

// 逐行解析 JSONL，损坏行计入 badLines 跳过
function readJsonl(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const events = [];
  let badLines = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { events, badLines };
}

function wirePathFor(sessionDir, agentId) {
  return path.join(sessionDir, 'agents', agentId || 'main', 'wire.jsonl');
}

// 提取 content 部件中的纯文本（think 等部件跳过，返回计数）
function partsToText(content) {
  const texts = [];
  let skipped = 0;
  if (!Array.isArray(content)) return { text: '', skipped };
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
    } else {
      skipped++;
    }
  }
  return { text: texts.join('\n'), skipped };
}

function toolCallName(tc) {
  if (!tc || typeof tc !== 'object') return 'tool';
  return tc.name || tc.tool || tc.toolName || tc.type || 'tool';
}

// 从事件流提取对话消息：优先 context.append_message（user/assistant/tool），
// 一条都没有时回退 turn.prompt 作为用户消息
function extractMessages(events) {
  const messages = [];
  for (const ev of events) {
    if (!ev || ev.type !== 'context.append_message' || !ev.message) continue;
    const m = ev.message;
    const role = typeof m.role === 'string' ? m.role : 'unknown';
    const { text, skipped } = partsToText(m.content);
    const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls.map(toolCallName) : [];
    if (!text && toolCalls.length === 0 && skipped === 0) continue;
    messages.push({ role, text, toolCalls, time: typeof ev.time === 'number' ? ev.time : 0 });
  }
  if (messages.length > 0) return messages;
  // 回退：turn.prompt 作为用户消息
  for (const ev of events) {
    if (!ev || ev.type !== 'turn.prompt') continue;
    const { text } = partsToText(ev.input);
    if (text) {
      messages.push({ role: 'user', text, toolCalls: [], time: typeof ev.time === 'number' ? ev.time : 0 });
    }
  }
  return messages;
}

const ROLE_LABELS = { user: '用户', assistant: '助手', tool: '工具', system: '系统' };

function formatTime(ms) {
  if (!ms || typeof ms !== 'number') return '';
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

// 渲染 Markdown：头部元信息 + 逐条消息；文本原样输出，工具调用折叠为一行摘要
function renderMarkdown(meta, messages) {
  const lines = [];
  lines.push(`# ${meta.title || meta.sessionId || '会话导出'}`);
  lines.push('');
  if (meta.sessionId) lines.push(`- 会话 ID：\`${meta.sessionId}\``);
  if (meta.workDir) lines.push(`- 工作目录：\`${meta.workDir}\``);
  lines.push(`- 消息数：${messages.length}`);
  lines.push(`- 导出时间：${formatTime(Date.now())}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const msg of messages) {
    const label = ROLE_LABELS[msg.role] || msg.role;
    const time = formatTime(msg.time);
    lines.push(`## ${label}${time ? `（${time}）` : ''}`);
    lines.push('');
    if (msg.text) {
      lines.push(msg.text);
      lines.push('');
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lines.push(`> 工具调用（${msg.toolCalls.length}）：${msg.toolCalls.join('、')}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// 导出指定会话的主 Agent 对话为 Markdown 字符串
function exportSessionMarkdown(sessionDir, meta = {}) {
  if (!sessionDir || !fs.existsSync(sessionDir)) {
    return { ok: false, error: '会话目录不存在' };
  }
  const parsed = readJsonl(wirePathFor(sessionDir, 'main'));
  if (!parsed) {
    return { ok: false, error: '未找到 wire.jsonl（该会话可能不含对话记录）' };
  }
  const messages = extractMessages(parsed.events);
  if (messages.length === 0) {
    return { ok: false, error: '会话中没有可导出的对话消息' };
  }
  const markdown = renderMarkdown(meta, messages);
  return { ok: true, markdown, messageCount: messages.length, badLines: parsed.badLines };
}

// 扫描会话的 agents/ 目录（含 main 与子 Agent）与 tasks/ 目录，供任务监视器展示
function scanSubagents(sessionDir) {
  const result = { ok: true, agents: [], tasks: [] };
  if (!sessionDir || !fs.existsSync(sessionDir)) {
    return { ok: false, error: '会话目录不存在', agents: [], tasks: [] };
  }
  const agentsRoot = path.join(sessionDir, 'agents');
  let entries = [];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wirePath = wirePathFor(sessionDir, entry.name);
    const parsed = readJsonl(wirePath);
    if (!parsed) continue;
    let firstTime = 0;
    let lastTime = 0;
    let messageCount = 0;
    const eventTypes = {};
    for (const ev of parsed.events) {
      if (!ev || typeof ev.type !== 'string') continue;
      eventTypes[ev.type] = (eventTypes[ev.type] || 0) + 1;
      if (ev.type === 'context.append_message') messageCount++;
      if (typeof ev.time === 'number' && ev.time > 0) {
        if (!firstTime || ev.time < firstTime) firstTime = ev.time;
        if (ev.time > lastTime) lastTime = ev.time;
      }
    }
    result.agents.push({
      id: entry.name,
      isMain: entry.name === 'main',
      eventCount: parsed.events.length,
      messageCount,
      firstTime,
      lastTime,
      eventTypes,
      badLines: parsed.badLines,
    });
  }
  result.agents.sort((a, b) => (a.firstTime || 0) - (b.firstTime || 0));
  // tasks/ 目录（后台任务记录，格式未文档化，防御性读取）
  const tasksRoot = path.join(sessionDir, 'tasks');
  try {
    for (const f of fs.readdirSync(tasksRoot)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(tasksRoot, f), 'utf8'));
        result.tasks.push({
          file: f,
          id: data.id || data.taskId || f.replace(/\.json$/, ''),
          status: data.status || '',
          description: typeof data.description === 'string' ? data.description.slice(0, 200) : '',
        });
      } catch { /* 跳过损坏的任务文件 */ }
    }
  } catch { /* tasks/ 不存在时忽略 */ }
  return result;
}

module.exports = {
  readJsonl,
  wirePathFor,
  extractMessages,
  renderMarkdown,
  exportSessionMarkdown,
  scanSubagents,
};
