#!/usr/bin/env node
// Kimi Code Desktop — ACP 第五次探测·补测脚本（调研用，一次性）
// 针对 acp-probe5.js 首跑中受时序/参数污染未测准的 7 项做干净复测：
//   ④b authenticate 正确参数名（首跑证明 method_id 报 -32602，ACP 规范为 camelCase methodId）
//   ⑥  elicitation：default 模式新会话诱导（首跑 3 次诱导发生在 plan 模式残留状态下）
//   ⑧  图片 prompt：独立新会话（首跑被 /goal 的 agent_busy 阻塞）
//   ⑨b /goal：default 模式新会话复测，观察 goal 推送；结束后 session/cancel
//   ⑪b mode 干净复测：新会话 set_config_option→plan、set_mode→default，观察报错与推送
//   ⑬a embeddedContext：独立新会话（首跑被 agent_busy 阻塞）
//   ⑬b mcpServers 四形态：修正结构（http/sse 补 headers:[]，stdio 补 env:[]）重测
// 日志同时写 stdout 与 docs/acp-probe5b-output.txt。权限请求一律回 cancelled（安全基线）。
// 用法：node scripts/acp-probe5b.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOTAL_TIMEOUT_MS = 720_000;
const FRAMING_PROBE_MS = 30_000;
const SESSION_NEW_TIMEOUT_MS = 45_000;
const PROMPT_TIMEOUT_MS = 90_000;
const GENERIC_REQ_TIMEOUT_MS = 20_000;
const RAW_DUMP_LIMIT = 300;
const PARAMS_DUMP_LIMIT = 500;
const FULL_DUMP_LIMIT = 4000;
const RESP_DUMP_LIMIT = 6000;

const CONTEXT_MARK = 'PROBE5-CONTEXT-MARK';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const REPORT_PATH = path.join(__dirname, '..', 'docs', 'acp-probe5b-output.txt');

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

const t0 = Date.now();
const reportLines = [];
function stamp() { return '+' + String(Date.now() - t0).padStart(6, '0') + 'ms'; }
function line(dir, msg) {
  const text = `[${stamp()}] ${dir} ${msg}`;
  reportLines.push(text);
  console.log(text);
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function logFull(label, obj, limit = RESP_DUMP_LIMIT) {
  log.recv(`${label}:\n${truncate(JSON.stringify(obj, null, 2), limit)}`);
}

function resolveCli() {
  const exe = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
  const candidates = [path.join(os.homedir(), '.kimi-code', 'bin', exe), path.join(os.homedir(), '.kimi', 'bin', exe)];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function encodeMessage(msg, framing) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (framing === 'lsp') return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
  return Buffer.concat([body, Buffer.from('\n')]);
}

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
      const idx = this.buf.indexOf(0x0a);
      if (idx < 0) return;
      const text = this.buf.subarray(0, idx).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.subarray(idx + 1);
      if (!text.trim()) continue;
      try { this.onMessage(JSON.parse(text)); } catch { this.onRaw(text); }
    }
  }
  drainLsp() {
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.onRaw(header); this.buf = this.buf.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) return;
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + len);
      try { this.onMessage(JSON.parse(body)); } catch { this.onRaw(body); }
    }
  }
}

const results = {
  rawChunks: 0,
  authMethodId: null,        // ④b authenticate({methodId:'login'}) 结果
  authBogus: null,
  elicitationRequests: [],   // ⑥ 捕获的全部 request_permission params
  elicitationAttempts: 0,
  imageStopReason: null,     // ⑧
  imageError: null,
  imageMarkSeen: false,
  goalNotifications: [],     // ⑨b /goal 期间的通知 kind
  goalDone: null,
  modeCleanProbe: null,      // ⑪b 干净复测记录
  embeddedEcho: null,        // ⑬a
  mcpNewResult: null,        // ⑬b session/new 响应
  mcpStderr: [],             // ⑬b stderr 观察
};

const notifStats = new Map();
function recordNotification(kind) {
  notifStats.set(kind, (notifStats.get(kind) || 0) + 1);
}

class ProbeChannel {
  constructor(name, extraEnv) {
    this.name = name;
    this.extraEnv = extraEnv || null;
    this.child = null;
    this.framing = 'ndjson';
    this.parser = null;
    this.nextId = 1;
    this.childExited = false;
    this.pending = new Map();
    this.sessionId = null;
    this.turnText = '';
    this.notificationSink = null;
    this.requestSink = null;
  }
  start(mode, cliPath) {
    this.framing = mode;
    this.childExited = false;
    const env = this.extraEnv ? { ...process.env, ...this.extraEnv } : process.env;
    log.info(`[${this.name}] 以 ${mode} 分帧启动子进程${this.extraEnv ? `（注入 env: ${Object.keys(this.extraEnv).join(',')}）` : ''}`);
    this.child = spawn(cliPath, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.parser = new FrameParser(mode, (m) => this.handleMessage(m), (t) => this.handleRaw(t));
    log.info(`[${this.name}] 子进程已 spawn, pid=${this.child.pid}`);
    this.child.on('error', (e) => { log.err(`[${this.name}] error: ${e.message}`); this.childExited = true; this.rejectAllPending(new Error(e.message)); });
    this.child.on('exit', (code, signal) => { log.info(`[${this.name}] 退出: code=${code} signal=${signal}`); this.childExited = true; this.rejectAllPending(new Error(`退出 code=${code}`)); });
    this.child.stdout.on('data', (c) => { try { this.parser.push(c); } catch (e) { log.err(`[${this.name}] 解析异常: ${e.message}`); } });
    this.child.stderr.on('data', (c) => {
      const t = c.toString('utf8').trim();
      if (/mcp|transport|warn/i.test(t)) results.mcpStderr.push(truncate(t, RAW_DUMP_LIMIT));
      log.info(`[${this.name}][stderr] ${truncate(t, RAW_DUMP_LIMIT)}`);
    });
    this.child.stdin.on('error', (e) => log.err(`[${this.name}] stdin 异常: ${e.message}`));
  }
  kill(reason) {
    if (this.child && !this.childExited) {
      log.info(`[${this.name}] kill pid=${this.child.pid}（${reason}）`);
      try { this.child.kill(); } catch (e) { log.err(`[${this.name}] kill 失败: ${e.message}`); }
    }
    this.rejectAllPending(new Error('子进程被终止'));
  }
  rejectAllPending(err) {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }
  writeMessage(obj) {
    log.send(`[${this.name}] ${obj.method || `响应 id=${obj.id}`} ${truncate(JSON.stringify(obj), PARAMS_DUMP_LIMIT)}`);
    this.child.stdin.write(encodeMessage(obj, this.framing));
  }
  sendRequest(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject, sentAt: Date.now() });
      try { this.writeMessage({ jsonrpc: '2.0', id, method, params }); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  requestWithTimeout(method, params, ms, desc) {
    const p = this.sendRequest(method, params);
    p.catch(() => {});
    return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(desc)), ms))]);
  }
  sendResult(id, result) { this.writeMessage({ jsonrpc: '2.0', id, result }); }
  sendError(id, code, message) { this.writeMessage({ jsonrpc: '2.0', id, error: { code, message } }); }
  handleMessage(msg) {
    if (msg.method && msg.id !== undefined && msg.id !== null) this.handleServerRequest(msg);
    else if (msg.method) this.handleNotification(msg);
    else if (msg.id !== undefined && msg.id !== null) this.handleResponse(msg);
  }
  handleResponse(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) { log.recv(`[${this.name}] 孤儿响应 id=${msg.id}`); return; }
    this.pending.delete(msg.id);
    log.recv(`[${this.name}] ${entry.method} 响应 (id=${msg.id}, 往返 ${Date.now() - entry.sentAt}ms)${msg.error ? ' [错误]' : ''}`);
    entry.resolve(msg);
  }
  handleNotification(msg) {
    const kind = msg.method === 'session/update' && msg.params && msg.params.update
      ? `session/update:${msg.params.update.sessionUpdate || '?'}`
      : msg.method;
    recordNotification(kind);
    if (msg.method === 'session/update' && msg.params && msg.params.update) {
      const u = msg.params.update;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') this.turnText += u.content.text || '';
    }
    log.recv(`[${this.name}] 通知 ${kind} ${truncate(JSON.stringify(msg.params), PARAMS_DUMP_LIMIT)}`);
    if (this.notificationSink) { try { this.notificationSink(kind, msg); } catch { /* 忽略 */ } }
  }
  handleServerRequest(msg) {
    log.recv(`[${this.name}] server→client 请求 ${msg.method} (id=${msg.id})，完整结构: ${truncate(JSON.stringify(msg), FULL_DUMP_LIMIT)}`);
    if (msg.method === 'session/request_permission') {
      if (this.requestSink) { try { this.requestSink(msg); } catch { /* 忽略 */ } }
      this.sendResult(msg.id, { outcome: { outcome: 'cancelled' } });
      log.info(`[${this.name}] request_permission -> cancelled（安全基线）`);
    } else {
      this.sendError(msg.id, -32601, 'acp-probe5b: not implemented');
    }
  }
  handleRaw(text) {
    results.rawChunks++;
    log.info(`[${this.name}][raw] ${truncate(text, RAW_DUMP_LIMIT)}`);
  }
  async handshake(cliPath) {
    this.start('ndjson', cliPath);
    const resp = await this.requestWithTimeout('initialize', INIT_PARAMS, FRAMING_PROBE_MS, 'initialize 无响应');
    if (resp.error) throw new Error(`initialize 错误: ${JSON.stringify(resp.error)}`);
    return resp;
  }
  async newSession(cwd, mcpServers) {
    const resp = await this.requestWithTimeout('session/new', { cwd, mcpServers: mcpServers || [] }, SESSION_NEW_TIMEOUT_MS, 'session/new 无响应');
    logFull(`[${this.name}] session/new 完整响应`, resp);
    if (resp.error) return { error: resp.error };
    this.sessionId = resp.result && resp.result.sessionId;
    return { result: resp.result };
  }
  async sendTextPrompt(text, timeoutMs = PROMPT_TIMEOUT_MS) {
    this.turnText = '';
    try {
      const resp = await this.requestWithTimeout('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, timeoutMs, `prompt ${timeoutMs}ms 无响应`);
      if (resp.error) return { error: JSON.stringify(resp.error), turnText: this.turnText };
      return { error: null, stopReason: resp.result && resp.result.stopReason, turnText: this.turnText };
    } catch (e) {
      return { error: e.message, turnText: this.turnText };
    }
  }
}

function stage(title) { log.info(`========== ${title} ==========`); }

let done = false;
async function main() {
  log.info('ACP 第五次探测·补测开始（7 项干净复测）');
  const cliPath = resolveCli();
  if (!cliPath) { log.err('未找到 CLI'); return finish(1); }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe5b-'));
  const markerFile = path.join(workDir, 'probe5-context.txt');
  fs.writeFileSync(markerFile, `口令是 ${CONTEXT_MARK}\n其余内容无关。`, 'utf8');

  const ch = new ProbeChannel('MAIN');
  await ch.handshake(cliPath);

  // ---------- ⑥ elicitation：default 模式新会话诱导 ----------
  stage('⑥ elicitation 干净复测（新会话，default 模式，至多 2 次）');
  await ch.newSession(workDir);
  ch.requestSink = (msg) => results.elicitationRequests.push(msg.params);
  const ELICIT = [
    '请调用 AskUserQuestion 工具向我提问，要求：恰好包含 2 个问题；第 1 个问题为单选并提供 2 个选项；第 2 个问题设置 multi_select 为 true、提供 3 个选项并设置 allow_other 为 true。除调用该工具外不要做任何事情。',
    'Call the AskUserQuestion tool now with exactly 2 questions: one single-select with 2 options, one multi_select with 3 options and allow_other=true. Do nothing else.',
  ];
  for (let i = 0; i < ELICIT.length && !results.elicitationRequests.length; i++) {
    results.elicitationAttempts = i + 1;
    log.info(`elicitation 诱导第 ${i + 1} 次`);
    const r = await ch.sendTextPrompt(ELICIT[i], 90_000);
    log.info(`诱导 prompt: error=${r.error || '无'}, stopReason=${r.stopReason || '(无)'}`);
    await sleep(1000);
  }
  ch.requestSink = null;
  log.info(`⑥: ${results.elicitationRequests.length ? `捕获 ${results.elicitationRequests.length} 次 request_permission` : '2 次诱导均未触发'}`);

  // ---------- ⑧ 图片 prompt：独立新会话 ----------
  stage('⑧ 图文 prompt 干净复测（独立新会话）');
  await ch.newSession(workDir);
  ch.turnText = '';
  try {
    const imgResp = await ch.requestWithTimeout(
      'session/prompt',
      {
        sessionId: ch.sessionId,
        prompt: [
          { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
          { type: 'text', text: 'The attached image is a tiny 1x1 test PNG. Reply with exactly: PROBE5-IMG-MARK' },
        ],
      },
      60_000,
      '图文 prompt 60s 无响应'
    );
    logFull('图文 prompt 完整响应', imgResp);
    if (imgResp.error) results.imageError = JSON.stringify(imgResp.error);
    else results.imageStopReason = imgResp.result && imgResp.result.stopReason;
    await sleep(1000);
    results.imageMarkSeen = ch.turnText.includes('PROBE5-IMG-MARK');
  } catch (e) {
    results.imageError = e.message;
  }
  log.info(`⑧: stopReason=${results.imageStopReason || '(无)'}, error=${results.imageError || '无'}, 口令回显=${results.imageMarkSeen}, 子进程退出=${ch.childExited}`);

  // ---------- ⑬a embeddedContext：独立新会话 ----------
  stage('⑬a embeddedContext 干净复测（独立新会话）');
  await ch.newSession(workDir);
  ch.turnText = '';
  try {
    const fileUri = 'file:///' + markerFile.replace(/\\/g, '/');
    const ctxResp = await ch.requestWithTimeout(
      'session/prompt',
      {
        sessionId: ch.sessionId,
        prompt: [
          { type: 'resource', resource: { uri: fileUri, mimeType: 'text/plain', text: fs.readFileSync(markerFile, 'utf8') } },
          { type: 'text', text: '上面的 resource 块是一个文件的内容。这个文件里写的口令是什么？只回复口令本身。' },
        ],
      },
      60_000,
      'embeddedContext prompt 60s 无响应'
    );
    logFull('embeddedContext prompt 完整响应', ctxResp);
    results.embeddedEcho = ch.turnText.includes(CONTEXT_MARK)
      ? `agent 正确回读口令（${CONTEXT_MARK}）`
      : `未回读；error=${ctxResp.error ? JSON.stringify(ctxResp.error) : '无'}；agent 文本=${truncate(ch.turnText, RAW_DUMP_LIMIT)}`;
  } catch (e) {
    results.embeddedEcho = `异常: ${e.message}`;
  }
  log.info(`⑬a: ${results.embeddedEcho}`);

  // ---------- ⑪b mode 干净复测 ----------
  stage('⑪b mode 切换干净复测（新会话：set_config_option→plan，再 set_mode→default）');
  await ch.newSession(workDir);
  const modeLog = { step1: null, step1Notifs: [], step2: null, step2Notifs: [] };
  ch.notificationSink = (kind) => modeLog.step1Notifs.push(kind);
  try {
    const r1 = await ch.requestWithTimeout('session/set_config_option', { sessionId: ch.sessionId, configId: 'mode', value: 'plan' }, GENERIC_REQ_TIMEOUT_MS, 'set_config_option 无响应');
    modeLog.step1 = r1.error ? `错误: ${JSON.stringify(r1.error)}` : '成功';
  } catch (e) { modeLog.step1 = `异常: ${e.message}`; }
  await sleep(1200);
  ch.notificationSink = (kind) => modeLog.step2Notifs.push(kind);
  try {
    const r2 = await ch.requestWithTimeout('session/set_mode', { sessionId: ch.sessionId, modeId: 'default' }, GENERIC_REQ_TIMEOUT_MS, 'set_mode 无响应');
    modeLog.step2 = r2.error ? `错误: ${JSON.stringify(r2.error)}` : '成功';
  } catch (e) { modeLog.step2 = `异常: ${e.message}`; }
  await sleep(1200);
  ch.notificationSink = null;
  results.modeCleanProbe = modeLog;
  log.info(`⑪b: set_config_option(plan)=${modeLog.step1}（推送=${modeLog.step1Notifs.join(',') || '无'}）；set_mode(default)=${modeLog.step2}（推送=${modeLog.step2Notifs.join(',') || '无'}）`);

  // ---------- ⑨b /goal default 模式复测 ----------
  stage('⑨b /goal 干净复测（新会话，default 模式）');
  await ch.newSession(workDir);
  const goalNotifs = [];
  ch.notificationSink = (kind) => goalNotifs.push(kind);
  const goalResp = await ch.sendTextPrompt('/goal 回复 GOAL-PROBE5B-MARK 一次，然后立即完成此目标', 90_000);
  await sleep(1500);
  results.goalNotifications = goalNotifs;
  results.goalDone = goalResp.error ? `prompt 未返回: ${goalResp.error}` : `prompt 已返回 stopReason=${goalResp.stopReason}`;
  // 终止可能仍在运行的 goal turn
  try { ch.writeMessage({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: ch.sessionId } }); } catch { /* 忽略 */ }
  await sleep(1000);
  ch.notificationSink = null;
  log.info(`⑨b: ${results.goalDone}；通知 kind=${goalNotifs.join(', ') || '(无)'}`);

  // ---------- ⑬b mcpServers 四形态（修正结构） ----------
  stage('⑬b mcpServers 转发修正复测（http/sse 补 headers:[], stdio 补 env:[]）');
  results.mcpStderr = [];
  const mcpPayload = [
    { name: 'probe5-http', type: 'http', url: 'http://127.0.0.1:1/mcp', headers: [] },
    { name: 'probe5-stdio', command: 'node', args: ['--version'], env: [] },
    { name: 'probe5-sse', type: 'sse', url: 'http://127.0.0.1:1/sse', headers: [] },
    { name: 'probe5-acp', type: 'acp', command: 'node', args: ['--version'], env: [] },
  ];
  const mcpNew = await ch.newSession(workDir, mcpPayload);
  results.mcpNewResult = mcpNew.error ? `错误: ${JSON.stringify(mcpNew.error)}` : `成功: sessionId=${mcpNew.result.sessionId}`;
  await sleep(2500);
  log.info(`⑬b: ${results.mcpNewResult}；stderr mcp/warn 行 ${results.mcpStderr.length} 条`);
  ch.kill('主进程补测完成');
  await sleep(800);

  // ---------- ④b authenticate({methodId}) 未登录复测 ----------
  stage('④b authenticate(methodId) 干净复测（空 KIMI_CODE_HOME）');
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe5b-unauth-'));
  const p4 = new ProbeChannel('AUTH', { KIMI_CODE_HOME: emptyHome });
  try {
    await p4.handshake(cliPath);
    try {
      const r1 = await p4.requestWithTimeout('authenticate', { methodId: 'login' }, 15_000, 'authenticate 15s 无响应');
      logFull('authenticate(methodId=login) 完整响应', r1);
      results.authMethodId = r1.error ? `错误: ${JSON.stringify(r1.error)}` : `成功: ${JSON.stringify(r1.result)}`;
    } catch (e) {
      results.authMethodId = `无响应/异常: ${e.message}`;
    }
    try {
      const r2 = await p4.requestWithTimeout('authenticate', { methodId: 'bogus' }, GENERIC_REQ_TIMEOUT_MS, 'authenticate(bogus) 无响应');
      results.authBogus = r2.error ? `错误: ${JSON.stringify(r2.error)}` : `意外成功: ${JSON.stringify(r2.result)}`;
    } catch (e) {
      results.authBogus = `异常: ${e.message}`;
    }
  } catch (e) {
    log.err(`④b 进程失败: ${e.message}`);
  }
  p4.kill('auth 补测完成');
  try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
  log.info(`④b: authenticate(methodId=login)=${results.authMethodId}；bogus=${results.authBogus}`);

  return finish(results.rawChunks > 0 ? 1 : 0);
}

function printSummary() {
  log.info('================== 补测摘要（7 项） ==================');
  log.info(`无法解析的原始输出: ${results.rawChunks} 段`);
  log.info(`④b authenticate(methodId=login): ${results.authMethodId}；bogus: ${results.authBogus}`);
  log.info(`⑥ elicitation: ${results.elicitationRequests.length ? `捕获 ${results.elicitationRequests.length} 次: ${truncate(JSON.stringify(results.elicitationRequests), 1500)}` : `未触发（${results.elicitationAttempts} 次诱导）`}`);
  log.info(`⑧ 图片: stopReason=${results.imageStopReason || '(无)'}, error=${results.imageError || '无'}, 口令回显=${results.imageMarkSeen}`);
  log.info(`⑨b goal: ${results.goalDone}；通知=${(results.goalNotifications || []).join(', ') || '(无)'}`);
  log.info(`⑪b mode 干净复测: ${JSON.stringify(results.modeCleanProbe)}`);
  log.info(`⑬a embeddedContext: ${results.embeddedEcho}`);
  log.info(`⑬b mcpServers: ${results.mcpNewResult}；stderr 观察 ${results.mcpStderr.length} 条: ${results.mcpStderr.slice(0, 6).join(' | ') || '(无)'}`);
}

function finish(code) {
  if (done) return code;
  done = true;
  clearTimeout(totalTimer);
  printSummary();
  log.info(`退出码 ${code}`);
  try { fs.writeFileSync(REPORT_PATH, reportLines.join('\n') + '\n', 'utf8'); console.log(`报告已写入: ${REPORT_PATH}`); } catch (e) { console.error(`报告写入失败: ${e.message}`); }
  setTimeout(() => process.exit(code), 500);
  return code;
}

const totalTimer = setTimeout(() => { log.err(`总超时到达`); finish(2); }, TOTAL_TIMEOUT_MS);
process.on('uncaughtException', (e) => { log.err(`uncaughtException: ${e.stack || e.message}`); finish(1); });
process.on('unhandledRejection', (e) => { log.err(`unhandledRejection: ${(e && e.stack) || e}`); });

main();
