#!/usr/bin/env node
// Kimi Code Desktop — ACP（Agent Client Protocol）第三次协议探测脚本（调研用，一次性）
// 目的：为 v0.12.0「会话恢复 + configOptions 切换」实测本机 `kimi acp` 的协议形态：
//   阶段A: session/new + prompt（拿到 sessionId 与 configOptions 全量）
//   阶段B: session/set_config_option 切换 model/thinking/mode + 切后 prompt 观察
//   阶段C: session/load（失败则 session/resume）历史重放形态
//   阶段D: session/list 条目形态，对照 ~/.kimi-code/session_index.jsonl
//   阶段E: prompt 进行中发 session/cancel 通知，观察是否中止
// 纯 Node 实现，无第三方依赖；对 agent 的权限请求一律回 cancelled，不允许真正执行任何工具写操作。
// 用法：node scripts/acp-probe3.js    （建议：node scripts/acp-probe3.js > docs/acp-probe3-output.txt 2>&1）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 常量 ----------
const TOTAL_TIMEOUT_MS = 120_000;        // 总超时：到点无条件 kill 子进程并退出
const FRAMING_PROBE_MS = 20_000;         // ndjson 首发 initialize 的响应窗口，超时改试 LSP 分帧
const PHASE_A_PROMPT_TIMEOUT_MS = 45_000;
const PHASE_B_SET_TIMEOUT_MS = 10_000;   // 单次 set_config_option 响应窗口
const PHASE_B_PROMPT_TIMEOUT_MS = 45_000;// 切换后观察 prompt 的最长等待
const POST_CONFIG_WAIT_MS = 800;         // 每次 set_config_option 后等通知的窗口
const PHASE_C_LOAD_TIMEOUT_MS = 20_000;  // session/load(resume) 响应窗口
const PHASE_C_GRACE_MS = 2_000;          // load 响应后收残余重放通知的尾巴时间
const PHASE_D_TIMEOUT_MS = 10_000;       // session/list 单次尝试窗口
const PHASE_E_CANCEL_DELAY_MS = 2_000;   // prompt 后多久发 session/cancel
const PHASE_E_PROMPT_TIMEOUT_MS = 30_000;// cancel 后等 prompt 响应的最长时间
const RAW_DUMP_LIMIT = 300;              // 无法解析的原始输出截断长度
const PARAMS_DUMP_LIMIT = 500;           // 通知 params 摘要截断长度
const FULL_DUMP_LIMIT = 4000;            // server→client 请求完整结构的截断上限
const RESP_DUMP_LIMIT = 6000;            // 阶段响应完整结构的截断上限
const SAMPLE_DUMP_LIMIT = 3000;          // 阶段C 每类通知样本的截断上限

const PROMPT_A = 'Reply with exactly: ACP-PROBE3-MARK';
const PROMPT_B = 'Reply with exactly: PROBE3-AFTER-CONFIG';
const PROMPT_E = 'Count from 1 to 50, one number per line, then reply with exactly: PROBE3-CANCEL-DONE';

// initialize 请求参数：按 ACP 协议声明客户端不具备 fs / terminal 能力
const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

// ---------- 时间线日志 ----------
// 格式：[+000123ms] 方向 内容；方向：>>>=发送 <<< =接收 ###=本地事件 !!!=异常
const t0 = Date.now();
function stamp() {
  return '+' + String(Date.now() - t0).padStart(6, '0') + 'ms';
}
function line(dir, msg) {
  console.log(`[${stamp()}] ${dir} ${msg}`);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 完整结构的日志输出（带截断保护）
function logFull(label, obj, limit = RESP_DUMP_LIMIT) {
  log.recv(`${label}:\n${truncate(JSON.stringify(obj, null, 2), limit)}`);
}

// ---------- CLI 路径解析 ----------
function resolveCli() {
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

// ---------- 消息分帧（ndjson / Content-Length 两种都实现） ----------
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

// 分阶段通知统计：currentPhase 标记当前所处阶段，通知按阶段归档
let currentPhase = 'init';
let loadResponded = false; // 阶段C：load/resume 响应是否已到达（用于标注重放通知在响应前/后）
const phaseStats = {};     // phase -> Map(kind -> count)
const phaseSamples = {};   // phase -> Map(kind -> [完整JSON, ...最多2条])
const phaseKindOrder = {}; // phase -> [kind 首次出现次序]
const notifEvents = [];    // 全部通知事件 {t, phase, kind}，供阶段B窗口查询

// 各阶段结果：供结尾摘要与调研文档使用
const results = {
  handshakeOk: false,
  framingUsed: null,
  A: { sessionId: null, stopReason: null, configOptions: null, sawMark: false },
  B: { attempts: [], postPromptStopReason: null, postPromptNote: null, sawAfterConfig: false },
  C: { methodUsed: null, ok: false, error: null, notifsBeforeResp: 0, notifsAfterResp: 0 },
  D: { ok: false, error: null, paramsUsed: null, entryKeys: null, entryCount: null },
  E: { stopReason: null, note: null },
  permissionRequests: 0,
  otherServerRequests: [],
  rawChunks: 0,
  agentText: '',
};

function recordNotification(kind, msg) {
  const ph = currentPhase;
  if (!phaseStats[ph]) {
    phaseStats[ph] = new Map();
    phaseSamples[ph] = new Map();
    phaseKindOrder[ph] = [];
  }
  if (!phaseStats[ph].has(kind)) phaseKindOrder[ph].push(kind);
  phaseStats[ph].set(kind, (phaseStats[ph].get(kind) || 0) + 1);
  const samples = phaseSamples[ph].get(kind) || [];
  if (samples.length < 2) {
    samples.push(JSON.stringify(msg.params));
    phaseSamples[ph].set(kind, samples);
  }
  notifEvents.push({ t: Date.now() - t0, phase: ph, kind });
  if (ph === 'C') {
    if (loadResponded) results.C.notifsAfterResp++;
    else results.C.notifsBeforeResp++;
  }
}

function summarizeKinds(events) {
  if (!events.length) return '(无)';
  const counts = new Map();
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
  return [...counts.entries()].map(([k, c]) => `${k}×${c}`).join(', ');
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
  log.send(`${obj.method || `响应 id=${obj.id}`} [${framing}] ${truncate(JSON.stringify(obj), PARAMS_DUMP_LIMIT)}`);
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

function sendNotification(method, params) {
  writeMessage({ jsonrpc: '2.0', method, params });
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
    log.recv(`孤儿响应 id=${msg.id}: ${truncate(JSON.stringify(msg), PARAMS_DUMP_LIMIT)}`);
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
  recordNotification(kind, msg);
  const cMark = currentPhase === 'C' ? (loadResponded ? ' [load响应后]' : ' [load响应前]') : '';
  log.recv(`通知 ${kind}${cMark} ${truncate(JSON.stringify(msg.params), PARAMS_DUMP_LIMIT)}`);
  // 拼接 agent 文本，检查探针口令是否回来
  if (msg.method === 'session/update' && msg.params && msg.params.update) {
    const u = msg.params.update;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      results.agentText += u.content.text || '';
      if (results.agentText.includes('ACP-PROBE3-MARK')) results.A.sawMark = true;
      if (results.agentText.includes('PROBE3-AFTER-CONFIG')) results.B.sawAfterConfig = true;
    }
  }
}

// agent -> client 请求：记录完整结构后按协议回取消/拒绝，绝不放行工具执行
function handleServerRequest(msg) {
  log.recv(`server→client 请求 ${msg.method} (id=${msg.id})，完整结构: ${truncate(JSON.stringify(msg), FULL_DUMP_LIMIT)}`);
  if (msg.method === 'session/request_permission') {
    results.permissionRequests++;
    // ACP 协议结构：{ outcome: { outcome: 'cancelled' } } 表示用户取消
    sendResult(msg.id, { outcome: { outcome: 'cancelled' } });
    log.info(`已按协议回应 request_permission -> outcome=cancelled（探测，不批准执行）`);
  } else {
    results.otherServerRequests.push(msg.method);
    // 客户端声明无 fs/terminal 能力，其余请求回 JSON-RPC 方法未实现错误
    sendError(msg.id, -32601, 'acp-probe3: capability not implemented');
    log.info(`已回 JSON-RPC 错误 -32601（未实现的能力: ${msg.method}）`);
  }
}

function handleRaw(text) {
  results.rawChunks++;
  log.info(`[raw] 无法按 JSON 解析的输出: ${truncate(text, RAW_DUMP_LIMIT)}`);
}

// ---------- 阶段C 重放形态报告 ----------
function printPhaseCReport() {
  const ph = 'C';
  log.info('---------- 阶段C 重放通知报告 ----------');
  log.info(`load 响应前通知 ${results.C.notifsBeforeResp} 条，响应后 ${results.C.notifsAfterResp} 条`);
  const stats = phaseStats[ph];
  if (!stats || !stats.size) {
    log.info('阶段C 未收到任何通知');
    return;
  }
  log.info(`种类首次出现次序: ${phaseKindOrder[ph].join(' -> ')}`);
  for (const [kind, count] of stats) {
    log.info(`  ${kind}: ${count} 条`);
    const samples = phaseSamples[ph].get(kind) || [];
    samples.forEach((s, i) => {
      let pretty = s;
      try {
        pretty = JSON.stringify(JSON.parse(s), null, 2);
      } catch { /* 原样输出 */ }
      log.info(`  ${kind} 样本#${i + 1}:\n${truncate(pretty, SAMPLE_DUMP_LIMIT)}`);
    });
  }
}

// ---------- 收尾 ----------
function printSummary() {
  log.info('---------- 探测摘要 ----------');
  log.info(`分帧方式: ${results.framingUsed || framing}（ndjson 首发，20s 无响应则重启试 lsp）`);
  log.info(`initialize 握手: ${results.handshakeOk ? '成功' : '失败/未完成'}`);
  log.info(`[A] sessionId: ${results.A.sessionId || '(无)'}; stopReason: ${results.A.stopReason || '(无)'}; 口令回显: ${results.A.sawMark ? '是' : '否'}`);
  log.info(`[A] configOptions 项: ${results.A.configOptions ? results.A.configOptions.map((o) => `${o.id}(当前=${o.currentValue}, 可选=${(o.options || []).map((x) => x.value).join('/')})`).join('; ') : '(无)'}`);
  for (const a of results.B.attempts) {
    log.info(`[B] set_config_option ${a.configId} -> ${a.value}: ${a.ok ? '成功' : `失败 ${a.error}`}; 切后 ${POST_CONFIG_WAIT_MS}ms 内通知: ${a.notifsAfter}`);
  }
  log.info(`[B] 切后 prompt stopReason: ${results.B.postPromptStopReason || '(无)'}; 备注: ${results.B.postPromptNote || '(无)'}; AFTER-CONFIG 回显: ${results.B.sawAfterConfig ? '是' : '否'}`);
  log.info(`[C] 方法: ${results.C.methodUsed || '(未尝试)'}; 结果: ${results.C.ok ? '成功' : `失败 ${results.C.error || ''}`}; 重放通知: 响应前 ${results.C.notifsBeforeResp} 条 / 响应后 ${results.C.notifsAfterResp} 条`);
  log.info(`[D] session/list: ${results.D.ok ? `成功（参数=${results.D.paramsUsed}，条目=${results.D.entryCount}，字段=${(results.D.entryKeys || []).join(',')}）` : `失败 ${results.D.error || '(未尝试)'}`}`);
  log.info(`[E] cancel 后 prompt stopReason: ${results.E.stopReason || '(无)'}; 备注: ${results.E.note || '(无)'}`);
  log.info('分阶段通知统计:');
  for (const ph of Object.keys(phaseStats)) {
    log.info(`  [${ph}] ${summarizeKinds(notifEvents.filter((e) => e.phase === ph))}`);
  }
  log.info(`request_permission 请求: ${results.permissionRequests} 次（均已回 cancelled）`);
  log.info(`其它 server→client 请求: ${results.otherServerRequests.length ? results.otherServerRequests.join(', ') : '(无)'}`);
  log.info(`无法解析的原始输出: ${results.rawChunks} 段`);
}

function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(totalTimer);
  killChild('探测结束');
  printSummary();
  log.info(`退出码 ${code}`);
  // 给 kill 与 stdout 冲刷留一点时间再退出
  setTimeout(() => process.exit(code), 500);
}

const totalTimer = setTimeout(() => {
  log.err(`总超时 ${TOTAL_TIMEOUT_MS}ms 到达，强制 kill 并退出`);
  finish(2);
}, TOTAL_TIMEOUT_MS);

// 任何未捕获异常只记录不 crash（任务要求）
process.on('uncaughtException', (e) => {
  log.err(`uncaughtException: ${e.stack || e.message}`);
  finish(1);
});
process.on('unhandledRejection', (e) => {
  log.err(`unhandledRejection: ${(e && e.stack) || e}`);
});

// ---------- 主流程 ----------
async function main() {
  log.info('ACP 第三次探测开始（会话恢复 + configOptions 切换 + list + cancel）');
  log.info(`Node ${process.version}, platform=${process.platform}, arch=${process.arch}`);

  cliPath = resolveCli();
  if (!cliPath) {
    log.err('两个候选路径均未找到 CLI，探测中止');
    return finish(1);
  }
  log.info(`选定 CLI: ${cliPath}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe3-'));
  log.info(`session/new 工作目录(临时): ${workDir}`);

  // initialize：ndjson 分帧首发；20s 无响应则 kill 重启改试 LSP 分帧（沿用前两次探测结论，正常不会触发回退）
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
    await sleep(500); // 等旧进程退出
    startChild('lsp');
    initResp = await sendRequest('initialize', INIT_PARAMS); // 由全局 120s 兜底
  }
  results.framingUsed = framing;
  logFull('initialize 完整响应', initResp);
  if (initResp.error) {
    log.err(`initialize 返回错误: ${JSON.stringify(initResp.error)}`);
    return finish(1);
  }
  results.handshakeOk = true;

  // ==================== 阶段A：session/new + prompt ====================
  currentPhase = 'A';
  log.info('========== 阶段A: session/new + prompt ==========');
  try {
    const newResp = await sendRequest('session/new', { cwd: workDir, mcpServers: [] });
    logFull('session/new 完整响应', newResp);
    if (newResp.error) throw new Error(`session/new 错误: ${JSON.stringify(newResp.error)}`);
    results.A.sessionId = newResp.result && newResp.result.sessionId;
    results.A.configOptions = (newResp.result && newResp.result.configOptions) || null;
    if (!results.A.sessionId) throw new Error('session/new 响应中没有 sessionId');

    const promptResp = await requestWithTimeout(
      'session/prompt',
      { sessionId: results.A.sessionId, prompt: [{ type: 'text', text: PROMPT_A }] },
      PHASE_A_PROMPT_TIMEOUT_MS,
      `阶段A prompt ${PHASE_A_PROMPT_TIMEOUT_MS}ms 无响应`
    );
    logFull('阶段A session/prompt 完整响应', promptResp);
    if (promptResp.error) throw new Error(`session/prompt 错误: ${JSON.stringify(promptResp.error)}`);
    results.A.stopReason = promptResp.result && promptResp.result.stopReason;
    await sleep(1000); // 收残余通知
  } catch (e) {
    log.err(`阶段A失败: ${e.stack || e.message}`);
  }

  const sessionId = results.A.sessionId;

  // ==================== 阶段B：session/set_config_option 切换 ====================
  currentPhase = 'B';
  log.info('========== 阶段B: session/set_config_option ==========');
  try {
    if (!sessionId) throw new Error('无 sessionId（阶段A失败），跳过');
    const configOptions = results.A.configOptions || [];
    if (!configOptions.length) log.info('configOptions 为空，无可切换项');
    for (const opt of configOptions) {
      const alt = (opt.options || []).find((o) => o.value !== opt.currentValue);
      if (!alt) {
        log.info(`跳过 ${opt.id}：可选值列表中没有不同于当前值(${opt.currentValue})的项`);
        results.B.attempts.push({ configId: opt.id, value: '(无可切换值)', ok: false, error: 'skipped', notifsAfter: '-' });
        continue;
      }
      const before = notifEvents.length;
      let resp;
      try {
        resp = await requestWithTimeout(
          'session/set_config_option',
          { sessionId, configId: opt.id, value: alt.value },
          PHASE_B_SET_TIMEOUT_MS,
          `set_config_option(${opt.id}) ${PHASE_B_SET_TIMEOUT_MS}ms 无响应`
        );
      } catch (e) {
        log.err(`set_config_option ${opt.id} 请求异常: ${e.message}`);
        results.B.attempts.push({ configId: opt.id, value: alt.value, ok: false, error: e.message, notifsAfter: '-' });
        continue;
      }
      logFull(`set_config_option(${opt.id} -> ${alt.value}) 完整响应`, resp);
      await sleep(POST_CONFIG_WAIT_MS);
      const news = notifEvents.slice(before + 1); // +1 排除不算事件的部分（notifEvents 只含通知，before 即切前数量）
      const notifSummary = summarizeKinds(notifEvents.slice(before));
      log.info(`切换 ${opt.id} -> ${alt.value} 后 ${POST_CONFIG_WAIT_MS}ms 内收到通知: ${notifSummary}`);
      results.B.attempts.push({
        configId: opt.id,
        value: alt.value,
        ok: !resp.error,
        error: resp.error ? JSON.stringify(resp.error) : null,
        notifsAfter: notifSummary,
      });
      void news;
    }

    // 切换全部完成后发一条短 prompt 观察 agent 是否感知变化
    log.info('---------- 阶段B 切换后观察 prompt ----------');
    try {
      const postResp = await requestWithTimeout(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: PROMPT_B }] },
        PHASE_B_PROMPT_TIMEOUT_MS,
        `阶段B prompt ${PHASE_B_PROMPT_TIMEOUT_MS}ms 无响应`
      );
      logFull('阶段B session/prompt 完整响应', postResp);
      if (postResp.error) {
        results.B.postPromptNote = `错误: ${JSON.stringify(postResp.error)}`;
      } else {
        results.B.postPromptStopReason = postResp.result && postResp.result.stopReason;
      }
    } catch (e) {
      // 超时（如 plan 模式审批循环）：发 cancel 兜底后进入下一阶段，不 kill 子进程（后续阶段还要用同一会话）
      log.err(`阶段B prompt 未在 ${PHASE_B_PROMPT_TIMEOUT_MS}ms 内完成: ${e.message}；发送 session/cancel 兜底`);
      results.B.postPromptNote = `超时(${e.message})，已发 cancel 兜底`;
      sendNotification('session/cancel', { sessionId });
      await sleep(1500);
    }
  } catch (e) {
    log.err(`阶段B失败: ${e.stack || e.message}`);
  }

  // ==================== 阶段C：session/load（失败则 session/resume） ====================
  currentPhase = 'C';
  log.info('========== 阶段C: session/load 历史重放 ==========');
  try {
    if (!sessionId) throw new Error('无 sessionId（阶段A失败），跳过');
    const loadParams = { sessionId, cwd: workDir, mcpServers: [] };
    loadResponded = false;
    let resp;
    try {
      resp = await requestWithTimeout(
        'session/load',
        loadParams,
        PHASE_C_LOAD_TIMEOUT_MS,
        `session/load ${PHASE_C_LOAD_TIMEOUT_MS}ms 无响应`
      );
    } catch (e) {
      resp = { error: { code: '(local)', message: e.message } };
    }
    loadResponded = true;
    results.C.methodUsed = 'session/load';
    logFull('session/load 完整响应', resp);
    if (resp.error && resp.error.code === -32601) {
      log.info('session/load 报方法不存在(-32601)，改试 session/resume（同参数）');
      loadResponded = false;
      try {
        resp = await requestWithTimeout(
          'session/resume',
          loadParams,
          PHASE_C_LOAD_TIMEOUT_MS,
          `session/resume ${PHASE_C_LOAD_TIMEOUT_MS}ms 无响应`
        );
      } catch (e) {
        resp = { error: { code: '(local)', message: e.message } };
      }
      loadResponded = true;
      results.C.methodUsed = 'session/resume';
      logFull('session/resume 完整响应', resp);
    }
    if (resp.error) {
      results.C.error = JSON.stringify(resp.error);
      log.err(`阶段C ${results.C.methodUsed} 返回错误: ${results.C.error}`);
    } else {
      results.C.ok = true;
    }
    await sleep(PHASE_C_GRACE_MS); // 收残余重放通知
    printPhaseCReport();
  } catch (e) {
    log.err(`阶段C失败: ${e.stack || e.message}`);
  }

  // ==================== 阶段D：session/list ====================
  currentPhase = 'D';
  log.info('========== 阶段D: session/list ==========');
  try {
    const attempts = [
      { label: '{}', params: {} },
      { label: '{cursor:null}', params: { cursor: null } },
      { label: '(无参数)', params: undefined },
    ];
    for (const att of attempts) {
      let resp;
      try {
        resp = await requestWithTimeout(
          'session/list',
          att.params,
          PHASE_D_TIMEOUT_MS,
          `session/list(${att.label}) ${PHASE_D_TIMEOUT_MS}ms 无响应`
        );
      } catch (e) {
        resp = { error: { code: '(local)', message: e.message } };
      }
      logFull(`session/list(${att.label}) 完整响应`, resp);
      if (!resp.error) {
        results.D.ok = true;
        results.D.paramsUsed = att.label;
        const list = resp.result && (resp.result.sessions || resp.result.items || resp.result);
        if (Array.isArray(list)) {
          results.D.entryCount = list.length;
          if (list.length) results.D.entryKeys = Object.keys(list[0]);
        } else if (resp.result) {
          results.D.entryKeys = Object.keys(resp.result);
        }
        break;
      }
      log.info(`session/list(${att.label}) 返回错误: ${JSON.stringify(resp.error)}，尝试下一种参数形态`);
      results.D.error = JSON.stringify(resp.error);
    }
    // 对照本地 session_index.jsonl 前几行
    try {
      const indexPath = path.join(os.homedir(), '.kimi-code', 'session_index.jsonl');
      const lines = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(0, 3);
      log.info(`session_index.jsonl 前 ${lines.length} 行对照:`);
      lines.forEach((l, i) => log.info(`  行${i + 1}: ${truncate(l, PARAMS_DUMP_LIMIT)}`));
    } catch (e) {
      log.info(`读取 session_index.jsonl 失败: ${e.message}`);
    }
  } catch (e) {
    log.err(`阶段D失败: ${e.stack || e.message}`);
  }

  // ==================== 阶段E：session/cancel ====================
  currentPhase = 'E';
  log.info('========== 阶段E: session/cancel ==========');
  try {
    if (!sessionId) throw new Error('无 sessionId（阶段A失败），跳过');
    const p = sendRequest('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: PROMPT_E }],
    });
    p.catch(() => {});
    log.info(`prompt 已发出，${PHASE_E_CANCEL_DELAY_MS}ms 后发 session/cancel 通知`);
    await sleep(PHASE_E_CANCEL_DELAY_MS);
    sendNotification('session/cancel', { sessionId });
    try {
      const resp = await Promise.race([
        p,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`cancel 后 ${PHASE_E_PROMPT_TIMEOUT_MS}ms prompt 仍未结束`)), PHASE_E_PROMPT_TIMEOUT_MS)
        ),
      ]);
      logFull('阶段E session/prompt 完整响应', resp);
      if (resp.error) {
        results.E.note = `错误: ${JSON.stringify(resp.error)}`;
      } else {
        results.E.stopReason = resp.result && resp.result.stopReason;
        results.E.note = results.E.stopReason === 'cancelled' ? 'cancel 生效' : `stopReason=${results.E.stopReason}（非 cancelled）`;
      }
    } catch (e) {
      results.E.note = `${e.message}（cancel 未使 prompt 提前结束）`;
      log.err(`阶段E: ${e.message}`);
      sendNotification('session/cancel', { sessionId }); // 再兜底一次
      await sleep(1000);
    }
  } catch (e) {
    log.err(`阶段E失败: ${e.stack || e.message}`);
  }

  return finish(0);
}

main();
