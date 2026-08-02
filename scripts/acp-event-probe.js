#!/usr/bin/env node
// Kimi Code Desktop — ACP（Agent Client Protocol）事件探针（脱敏版）
// 目的：确认 CLI 通过 ACP 实时推送哪些事件（尤其任务/Cron/子代理嵌套字段）。
// 与 acp-probe.js 的区别：
//   - stdout 只输出 JSONL 脱敏记录（每条收发消息一行），日志与结束摘要走 stderr；
//   - 每行记录含 ids（ID 类字段原值）/ keys（key 路径清单）/ payload（递归脱敏结构）；
//   - 脱敏默认保守：字符串一律替换为 "<str:长度>"，仅白名单 key 保留原值；
//   - 输出不含用户正文（prompt 只作为探测口令发出，不回显原文）。
// 用法：node scripts/acp-event-probe.js
//   env: KIMI_ACP_PROBE_PROMPT  自定义 prompt（沿用 acp-probe.js 同名开关）
//        KIMI_ACP_PROBE_OUT     指定 JSONL 输出文件（同步追加，双写；未设则只写 stdout）
//        KIMI_ACP_PROBE_CLI     覆盖 CLI 路径（默认走基座脚本的候选路径发现）
// 纯 Node 实现，无第三方依赖；对 agent 的权限请求一律回 cancelled，不允许真正执行任何工具写操作。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 常量 ----------
const TOTAL_TIMEOUT_MS = 90_000;     // 总超时：到点无条件 kill 子进程并退出
const FRAMING_PROBE_MS = 20_000;     // ndjson 首发 initialize 的响应窗口，超时改试 LSP 分帧
const POST_PROMPT_GRACE_MS = 3_000;  // 收到 prompt 响应后再留的尾巴时间，用于收残余通知
// 探测口令可用环境变量 KIMI_ACP_PROBE_PROMPT 覆盖（默认保持原口令不变）
const PROMPT_TEXT = process.env.KIMI_ACP_PROBE_PROMPT || 'Reply with exactly: ACP-PROBE-OK';
const PROMPT_MARK = 'ACP-PROBE-OK';
// KIMI_ACP_PROBE_OUT：指定 JSONL 记录文件（同步追加写入，双写 stdout）
const OUT_PATH = process.env.KIMI_ACP_PROBE_OUT ? path.resolve(process.env.KIMI_ACP_PROBE_OUT) : null;
const RAW_DUMP_LIMIT = 300;          // 无法解析的原始输出截断长度
const PARAMS_DUMP_LIMIT = 500;       // 通知 params 摘要截断长度

// ---------- 脱敏配置（默认保守） ----------
const MAX_DEPTH = 6;                              // 对象深度上限，超出记 "<depth-limit>"
const MAX_ARRAY = 20;                             // 数组保留元素上限，超出追加 "<truncated:剩余N>"
const ID_KEY_RE = /ids?$/i;                       // ID 类 key（id/sessionId/toolCallId/parentId/parent_id/taskId/agentId/messageId/...）：字符串值保留原值
const KEEP_LITERAL_KEYS = new Set([               // 白名单字面 key：值保留原值
  'method', 'jsonrpc', 'sessionUpdate', 'type', 'kind', 'status', 'state',
  'role', 'stopReason', 'name', 'title', 'event',
]);
const RELEVANT_KEY_RE = /task|cron|sub[_-]?agent|delegate|parent/i; // 摘要用：任务/Cron/子代理相关
const PARENT_KEY_RE = /parent/i;                  // 摘要用：嵌套迹象

// initialize 请求参数：按 ACP 协议声明客户端不具备 fs / terminal 能力
const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

// ---------- 时间线日志（全部走 stderr，stdout 只允许 JSONL 记录） ----------
// 格式：[+000123ms] 方向 内容；方向：>>>=发送 <<< =接收 ###=本地事件 !!!=异常
const t0 = Date.now();
function stamp() {
  return '+' + String(Date.now() - t0).padStart(6, '0') + 'ms';
}
function line(dir, msg) {
  console.error(`[${stamp()}] ${dir} ${msg}`);
}
const log = {
  info: (msg) => line('###', msg),
  send: (msg) => line('>>>', msg),
  recv: (msg) => line('<<<', msg),
  err: (msg) => line('!!!', msg),
};

function truncate(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}…(共${s.length}字符)` : s;
}

// ---------- 脱敏遍历 ----------
// walk(value, depth, path, ctx) 返回脱敏后的值；同时填充：
//   ctx.keys —— 聚合 key 路径清单（数组元素用 []，用于发现未知字段）
//   ctx.ids  —— ID 类字段拍平（key→原值，路径含数组索引以唯一定位）
function leafKey(p) {
  if (!p) return '';
  const segs = p.split('.');
  let last = segs[segs.length - 1];
  if (/^\d+$/.test(last) || /^\[\d+\]$/.test(last)) {
    last = segs[segs.length - 2] || '';
  }
  return last;
}
// title 仅限 task/tool_call 上下文的短标签才保留原值
function isTaskTitleContext(p) {
  return /(^|\.)(task|tool_call)\.title$/.test(p);
}
function walk(v, depth, p, ctx) {
  // 所有节点（含数字/布尔/null/字符串）都计入 key 路径清单，保证未知字段可被发现；
  // keys 用聚合路径（数组元素统一为 []），ids 仍用带索引路径以唯一定位
  const pAgg = p ? p.replace(/\[\d+\]/g, '[]') : p;
  if (pAgg && ctx.keys.indexOf(pAgg) < 0) ctx.keys.push(pAgg);
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return v;          // 数字、布尔保留原值
  if (t === 'string') {
    const leaf = leafKey(p);
    if (ID_KEY_RE.test(leaf)) return v;                     // ID 类 key 保留
    if (KEEP_LITERAL_KEYS.has(leaf)) {
      if (leaf === 'title' && !isTaskTitleContext(p)) return `<str:${v.length}>`;
      return v;
    }
    return `<str:${v.length}>`;                             // 默认替换
  }
  if (Array.isArray(v)) {
    const out = [];
    const n = Math.min(v.length, MAX_ARRAY);
    for (let i = 0; i < n; i++) out.push(walk(v[i], depth + 1, `${p}[${i}]`, ctx));
    if (v.length > MAX_ARRAY) out.push(`<truncated:${v.length - MAX_ARRAY}>`);
    return out;
  }
  if (t === 'object') {
    if (depth >= MAX_DEPTH) return '<depth-limit>';         // 深度上限
    const out = {};
    for (const k of Object.keys(v)) {
      const np = p ? `${p}.${k}` : k;
      const val = v[k];
      if (ID_KEY_RE.test(k)) {
        // ID 类字段拍平提取（仅 string/number）
        if (typeof val === 'string' || typeof val === 'number') ctx.ids[np] = val;
      }
      out[k] = walk(val, depth + 1, np, ctx);
    }
    return out;
  }
  return `<str:${String(v).length}>`;                        // 其他类型兜底
}

// ---------- CLI 路径解析（同 acp-probe.js，另支持 KIMI_ACP_PROBE_CLI 覆盖） ----------
function resolveCli() {
  const envCli = process.env.KIMI_ACP_PROBE_CLI;
  if (envCli) {
    log.info(`KIMI_ACP_PROBE_CLI 指定: ${envCli}`);
    return envCli;
  }
  const exe = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
  const candidates = [
    path.join(os.homedir(), '.kimi-code', 'bin', exe),
    path.join(os.homedir(), '.kimi', 'bin', exe),
  ];
  for (const p of candidates) {
    log.info(`探测 CLI 候选路径: ${p} -> ${fs.existsSync(p) ? '存在' : '不存在'}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- 消息分帧（ndjson / Content-Length 两种都实现，同 acp-probe.js） ----------
function encodeMessage(msg, framing) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (framing === 'lsp') {
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
  }
  return Buffer.concat([body, Buffer.from('\n')]);
}

// 按字节缓冲的流式分帧解析器；解析不出的内容走 onRaw 记录，便于判断协议形态
class FrameParser {
  constructor(framing, onMessage, onRaw) {
    this.framing = framing;
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onRaw = onRaw;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.framing === 'lsp') this.drainLsp();
    else this.drainNdjson();
  }
  drainNdjson() {
    for (;;) {
      const idx = this.buf.indexOf(0x0a); // '\n'
      if (idx < 0) return;
      const text = this.buf.subarray(0, idx).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.subarray(idx + 1);
      if (!text.trim()) continue;
      try {
        this.onMessage(JSON.parse(text));
      } catch {
        this.onRaw(text);
      }
    }
  }
  drainLsp() {
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // 头部不含长度字段：协议不符，丢弃这段头并记录
        this.onRaw(header);
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) return; // 等更多数据
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + len);
      try {
        this.onMessage(JSON.parse(body));
      } catch {
        this.onRaw(body);
      }
    }
  }
}

// ---------- 探测状态 ----------
let cliPath = null;
let child = null;
let framing = 'ndjson';
let parser = null;
let nextId = 1;
let childExited = false;
let done = false;
const pending = new Map(); // id -> { method, resolve, reject, sentAt }

// 统计信息：供结尾摘要使用
const stats = {
  handshakeOk: false,
  framingUsed: null,
  sessionId: null,
  agentInfo: null,
  protocolVersion: null,
  stopReason: null,
  sawProbeOk: false,
  sessionUpdates: new Map(), // sessionUpdate 种类 -> 条数
  inCount: 0,                // 收消息总数
  outCount: 0,               // 发消息总数
  errors: 0,                 // JSON-RPC error 消息 + 无法解析的原始块
  rawChunks: 0,
  relevantKeys: new Set(),   // 任务/Cron/子代理相关 key 路径
  parentKeys: new Set(),     // 嵌套迹象（/parent/i）
};

// ---------- JSONL 记录（stdout + 可选文件双写） ----------
function emitRecord(dir, msg, methodFallback) {
  const ctx = { keys: [], ids: {} };
  const payload = walk(msg, 0, '', ctx);

  const rec = { t: Date.now() - t0, dir };
  const method = msg.method || methodFallback || null;
  if (method) rec.method = method;
  if (msg.method === 'session/update' && msg.params && msg.params.update && msg.params.update.sessionUpdate) {
    rec.sessionUpdate = msg.params.update.sessionUpdate;
  }
  rec.ids = ctx.ids;
  rec.keys = ctx.keys;
  rec.payload = payload;

  const jsonLine = JSON.stringify(rec);
  console.log(jsonLine);
  if (OUT_PATH) {
    try {
      fs.appendFileSync(OUT_PATH, jsonLine + '\n');
    } catch (e) {
      log.err(`OUT 文件写入失败: ${e.message}`);
    }
  }

  // 统计
  if (dir === 'in') stats.inCount++;
  else stats.outCount++;
  for (const k of ctx.keys) {
    if (RELEVANT_KEY_RE.test(k)) stats.relevantKeys.add(k);
    if (PARENT_KEY_RE.test(k)) stats.parentKeys.add(k);
  }
}

// ---------- 子进程管理 ----------
function startChild(mode) {
  framing = mode;
  childExited = false;
  log.info(`以 ${mode} 分帧启动子进程: ${cliPath} acp`);
  child = spawn(cliPath, ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  parser = new FrameParser(mode, handleMessage, handleRaw);
  log.info(`子进程已 spawn, pid=${child.pid}`);
  child.on('error', (e) => {
    log.err(`子进程 error 事件: ${e.message}`);
    childExited = true;
    rejectAllPending(new Error(`spawn 失败: ${e.message}`));
  });
  child.on('exit', (code, signal) => {
    log.info(`子进程退出: code=${code} signal=${signal}`);
    childExited = true;
    rejectAllPending(new Error(`子进程已退出 code=${code}`));
  });
  child.stdout.on('data', (chunk) => {
    try {
      parser.push(chunk);
    } catch (e) {
      log.err(`分帧解析异常: ${e.message}`);
    }
  });
  child.stderr.on('data', (chunk) => {
    log.info(`[stderr] ${truncate(chunk.toString('utf8').trim(), RAW_DUMP_LIMIT)}`);
  });
  child.stdin.on('error', (e) => log.err(`stdin 写入异常: ${e.message}`));
}

function killChild(reason) {
  if (child && !childExited) {
    log.info(`kill 子进程 pid=${child.pid}（${reason}）`);
    try {
      child.kill();
    } catch (e) {
      log.err(`kill 失败: ${e.message}`);
    }
  }
  rejectAllPending(new Error('子进程被终止'));
}

function rejectAllPending(err) {
  for (const entry of pending.values()) entry.reject(err);
  pending.clear();
}

// ---------- JSON-RPC 收发 ----------
function writeMessage(obj) {
  const data = encodeMessage(obj, framing);
  const method = obj.method || 'response';
  log.send(`${method} [${framing}] ${truncate(JSON.stringify(obj), PARAMS_DUMP_LIMIT)}`);
  emitRecord('out', obj, method === 'response' ? 'response' : null);
  child.stdin.write(data);
}

function sendRequest(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject, sentAt: Date.now() });
    try {
      writeMessage({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

// 带超时的请求；内部 promise 兜底 catch，避免竞速失败后 unhandledRejection Crash
function requestWithTimeout(method, params, ms, timeoutDesc) {
  const p = sendRequest(method, params);
  p.catch(() => {});
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutDesc)), ms)),
  ]);
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---------- 消息处理 ----------
function handleMessage(msg) {
  let methodFallback = null;
  if (msg.id !== undefined && msg.id !== null && !msg.method) {
    const entry = pending.get(msg.id);
    methodFallback = entry ? entry.method : 'response';
  }
  emitRecord('in', msg, methodFallback);
  if (msg.error) stats.errors++;

  if (msg.method && msg.id !== undefined && msg.id !== null) {
    handleServerRequest(msg); // agent -> client 请求（如 session/request_permission）
  } else if (msg.method) {
    handleNotification(msg); // agent -> client 通知（如 session/update）
  } else if (msg.id !== undefined && msg.id !== null) {
    handleResponse(msg); // 对 client 请求的响应
  } else {
    log.info(`无法归类的消息: ${truncate(JSON.stringify(msg), PARAMS_DUMP_LIMIT)}`);
  }
}

function handleResponse(msg) {
  const entry = pending.get(msg.id);
  if (!entry) {
    log.recv(`孤儿响应 id=${msg.id}`);
    return;
  }
  pending.delete(msg.id);
  const rtt = Date.now() - entry.sentAt;
  log.recv(`${entry.method} 响应 (id=${msg.id}, 往返 ${rtt}ms)${msg.error ? ' [错误]' : ''}`);
  entry.resolve(msg);
}

function handleNotification(msg) {
  const kind =
    msg.method === 'session/update' && msg.params && msg.params.update
      ? `session/update:${msg.params.update.sessionUpdate || '?'}`
      : msg.method;
  log.recv(`通知 ${kind} ${truncate(JSON.stringify(msg.params), PARAMS_DUMP_LIMIT)}`);
  // 统计 sessionUpdate 种类
  if (msg.method === 'session/update') {
    const su = msg.params && msg.params.update
      ? (msg.params.update.sessionUpdate || '(无 sessionUpdate 字段)')
      : '(无 update)';
    stats.sessionUpdates.set(su, (stats.sessionUpdates.get(su) || 0) + 1);
  }
  // 拼接 agent 文本，检查探针口令是否回来
  if (msg.method === 'session/update' && msg.params && msg.params.update) {
    const u = msg.params.update;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      stats.agentText = (stats.agentText || '') + u.content.text;
      if (stats.agentText.includes(PROMPT_MARK)) stats.sawProbeOk = true;
    }
  }
}

// agent -> client 请求：记录完整结构后按协议回取消/拒绝，绝不放行工具执行
function handleServerRequest(msg) {
  log.recv(`server→client 请求 ${msg.method} (id=${msg.id})`);
  if (msg.method === 'session/request_permission') {
    // ACP 协议结构：{ outcome: { outcome: 'cancelled' } } 表示用户取消
    sendResult(msg.id, { outcome: { outcome: 'cancelled' } });
    log.info(`已按协议回应 request_permission -> outcome=cancelled（探测，不批准执行）`);
  } else {
    // 客户端声明无 fs/terminal 能力，其余请求回 JSON-RPC 方法未实现错误
    sendError(msg.id, -32601, 'acp-event-probe: capability not implemented');
    log.info(`已回 JSON-RPC 错误 -32601（未实现的能力: ${msg.method}）`);
  }
}

function handleRaw(text) {
  stats.rawChunks++;
  stats.errors++;
  log.info(`[raw] 无法按 JSON 解析的输出: ${truncate(text, RAW_DUMP_LIMIT)}`);
}

// ---------- 收尾 ----------
function buildSummary() {
  return {
    handshake: {
      ok: stats.handshakeOk,
      framing: stats.framingUsed,
      protocolVersion: stats.protocolVersion,
      agentInfo: stats.agentInfo,
      sessionId: stats.sessionId,
      stopReason: stats.stopReason,
      probeMarkEchoed: stats.sawProbeOk,
    },
    sessionUpdates: Object.fromEntries(stats.sessionUpdates),
    relevantKeys: [...stats.relevantKeys].sort(),
    parentKeys: [...stats.parentKeys].sort(),
    counts: {
      in: stats.inCount,
      out: stats.outCount,
      total: stats.inCount + stats.outCount,
      errors: stats.errors,
    },
  };
}

function printSummary(summary) {
  console.error('===== ACP 事件探针摘要 =====');
  console.error(`CLI: ${cliPath || '(未找到)'}`);
  console.error(`分帧方式: ${stats.framingUsed || framing}`);
  console.error(`握手: ${stats.handshakeOk ? '成功' : '失败/未完成'}`);
  if (stats.agentInfo) console.error(`agentInfo: ${JSON.stringify(stats.agentInfo)}`);
  if (stats.protocolVersion !== null && stats.protocolVersion !== undefined) {
    console.error(`协商 protocolVersion: ${stats.protocolVersion}`);
  }
  console.error(`sessionId: ${stats.sessionId || '(无)'}`);
  console.error(`prompt stopReason: ${stats.stopReason || '(无)'}`);
  console.error(`探针口令 ${PROMPT_MARK} 回显: ${stats.sawProbeOk ? '是' : '否'}`);
  console.error('sessionUpdate 种类:');
  if (stats.sessionUpdates.size === 0) console.error('  (无)');
  for (const [kind, count] of stats.sessionUpdates) {
    console.error(`  ${kind}: ${count} 条`);
  }
  console.error('任务/Cron/子代理相关 key 路径:');
  if (stats.relevantKeys.size === 0) console.error('  (无)');
  for (const k of [...stats.relevantKeys].sort()) console.error(`  ${k}`);
  console.error('嵌套迹象 key 路径 (/parent/i):');
  if (stats.parentKeys.size === 0) console.error('  (无)');
  for (const k of [...stats.parentKeys].sort()) console.error(`  ${k}`);
  console.error(`消息统计: 收 ${stats.inCount} / 发 ${stats.outCount} / 总 ${stats.inCount + stats.outCount} / 错误 ${stats.errors}`);
  console.error('===========================');
}

function finish(code, timeoutHit) {
  if (done) return;
  done = true;
  clearTimeout(totalTimer);
  killChild(timeoutHit ? '总超时' : '探测结束');
  const summary = buildSummary();
  printSummary(summary);
  // OUT 文件末尾追加一行 summary（若指定了输出文件）
  if (OUT_PATH) {
    try {
      fs.appendFileSync(OUT_PATH, JSON.stringify({ summary }) + '\n');
    } catch (e) {
      log.err(`OUT 文件写入 summary 失败: ${e.message}`);
    }
  }
  log.info(`退出码 ${code}`);
  // 给 kill 与 stdout 冲刷留一点时间再退出
  setTimeout(() => process.exit(code), 500);
}

const totalTimer = setTimeout(() => {
  log.err(`总超时 ${TOTAL_TIMEOUT_MS}ms 到达，强制 kill 并退出`);
  finish(0, true);
}, TOTAL_TIMEOUT_MS);

// 任何未捕获异常只记录不 crash
process.on('uncaughtException', (e) => {
  log.err(`uncaughtException: ${e.stack || e.message}`);
  finish(1);
});
process.on('unhandledRejection', (e) => {
  log.err(`unhandledRejection: ${(e && e.stack) || e}`);
});

// ---------- 主流程 ----------
async function main() {
  log.info('ACP 事件探针（脱敏版）开始');
  log.info(`Node ${process.version}, platform=${process.platform}, arch=${process.arch}`);
  if (OUT_PATH) log.info(`JSONL 记录文件: ${OUT_PATH}`);
  else log.info('未设置 KIMI_ACP_PROBE_OUT，记录仅写 stdout');

  cliPath = resolveCli();
  if (!cliPath) {
    log.err('两个候选路径均未找到 CLI，探测中止');
    return finish(1);
  }
  log.info(`选定 CLI: ${cliPath}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-event-probe-'));
  log.info(`session/new 工作目录(临时): ${workDir}`);

  try {
    // 阶段一：ndjson 分帧首发 initialize；20s 无响应则 kill 重启改试 LSP 分帧
    startChild('ndjson');
    let initResp;
    try {
      initResp = await requestWithTimeout(
        'initialize',
        INIT_PARAMS,
        FRAMING_PROBE_MS,
        `ndjson 分帧 initialize 后 ${FRAMING_PROBE_MS}ms 无响应`
      );
    } catch (e) {
      log.info(`${e.message}，kill 子进程并以 Content-Length(LSP) 分帧重启`);
      killChild('分帧探测切换');
      await new Promise((r) => setTimeout(r, 500)); // 等旧进程退出
      startChild('lsp');
      initResp = await sendRequest('initialize', INIT_PARAMS); // 由全局 90s 兜底
    }
    stats.framingUsed = framing;
    if (initResp.error) {
      log.err(`initialize 返回错误: ${JSON.stringify(initResp.error)}`);
      return finish(1);
    }
    const initResult = initResp.result || {};
    stats.protocolVersion = initResult.protocolVersion ?? null;
    stats.agentInfo = initResult.agentInfo || null;
    stats.handshakeOk = true;
    log.info(`握手成功: protocolVersion=${stats.protocolVersion} agentInfo=${JSON.stringify(stats.agentInfo)}`);

    // 阶段二：session/new
    const newResp = await sendRequest('session/new', { cwd: workDir, mcpServers: [] });
    if (newResp.error) {
      log.err(`session/new 返回错误: ${JSON.stringify(newResp.error)}`);
      return finish(1);
    }
    stats.sessionId = newResp.result && newResp.result.sessionId;
    if (!stats.sessionId) {
      log.err('session/new 响应中没有 sessionId');
      return finish(1);
    }

    // 阶段三：session/prompt，期间逐条打印 session/update 等通知（脱敏 JSONL 已实时输出）
    const promptResp = await sendRequest('session/prompt', {
      sessionId: stats.sessionId,
      prompt: [{ type: 'text', text: PROMPT_TEXT }],
    });
    if (promptResp.error) {
      log.err(`session/prompt 返回错误: ${JSON.stringify(promptResp.error)}`);
      return finish(1);
    }
    stats.stopReason = promptResp.result && promptResp.result.stopReason;
    log.info(`prompt 完成: stopReason=${stats.stopReason}`);

    // 留一点尾巴时间收残余通知
    await new Promise((r) => setTimeout(r, POST_PROMPT_GRACE_MS));
    return finish(0);
  } catch (e) {
    log.err(`主流程异常: ${e.stack || e.message}`);
    return finish(1);
  }
}

main();
