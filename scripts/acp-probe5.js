#!/usr/bin/env node
// Kimi Code Desktop — ACP（Agent Client Protocol）第五次协议探测脚本（调研用，一次性）
// 目的：在 CLI 0.29.x 上实测 ROADMAP P0-2 的 14 项协议行为（0.27 探测结论已过时）：
//   ①session/load 非活跃会话是否回放历史（含跨进程复测）  ②session/resume 与 load 差异
//   ③session/list 字段与分页（含 sessionCapabilities.list 公告）
//   ④未登录 authRequired(-32000) 形态与 authenticate(method_id)（空 KIMI_CODE_HOME 隔离进程）
//   ⑤thinking 在 configOptions 的形态 + session/set_model 参数格式
//   ⑥AskUserQuestion elicitation 经 request_permission 的字段形态（诱导 prompt）
//   ⑦plan/config_option_update/available_commands_update 推送形态
//   ⑧图片输入是否修复（0.27 崩溃 0xC0000409）
//   ⑨/goal 文本命令的 goal 相关推送与预算进度通道
//   ⑩hooks 在 ACP 会话中是否触发（临时 KIMI_CODE_HOME 复制凭据 + [[hooks]] UserPromptSubmit）
//   ⑪session/set_mode 与 set_config_option({configId:'mode'}) 等价性
//   ⑫是否另发 ACP 规范 current_mode_update
//   ⑬embeddedContext/resource 块与 mcpServers 转发（http/stdio/sse/acp 四形态）
//   ⑭available_commands_update 下发命令清单
// 纯 Node 实现，无第三方依赖；对 agent 的权限请求一律回 cancelled，不允许真正执行任何工具写操作。
// 日志同时写 stdout 与 docs/acp-probe5-output.txt（格式与前四次探测一致）。
// 用法：node scripts/acp-probe5.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 常量 ----------
const TOTAL_TIMEOUT_MS = 900_000;        // 总超时 15 分钟：到点无条件 kill 子进程并退出
const FRAMING_PROBE_MS = 30_000;         // ndjson 首发 initialize 的响应窗口，超时改试 LSP 分帧
const SESSION_NEW_TIMEOUT_MS = 45_000;   // session/new / load / resume 响应窗口
const PROMPT_TIMEOUT_MS = 90_000;        // 单条 prompt 的最长等待（诱导类单独控制）
const GENERIC_REQ_TIMEOUT_MS = 20_000;   // list/set_model/set_mode/set_config_option 等通用请求窗口
const AUTH_PROBE_MS = 15_000;            // 未登录进程 authenticate 观察窗口
const RAW_DUMP_LIMIT = 300;              // 无法解析的原始输出截断长度
const PARAMS_DUMP_LIMIT = 500;           // 通知 params 摘要截断长度
const FULL_DUMP_LIMIT = 4000;            // server→client 请求完整结构的截断上限
const RESP_DUMP_LIMIT = 6000;            // 响应完整结构的截断上限

const MARK_A = 'PROBE5-MARK-A';          // 会话 A 历史标记口令
const CONTEXT_MARK = 'PROBE5-CONTEXT-MARK'; // embeddedContext 测试文件内容口令
const GOAL_MARK = 'GOAL-PROBE5-MARK';    // /goal 诱导口令
const PROMPT_TEXT_IMAGE = 'The attached image is a tiny 1x1 test PNG. Reply with exactly: PROBE5-IMG-MARK';

// 内嵌 1x1 PNG（70 字节，8bit RGBA；与 probe4 同一测试图）
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const REPORT_PATH = path.join(__dirname, '..', 'docs', 'acp-probe5-output.txt');

// initialize 请求参数：按 ACP 协议声明客户端不具备 fs / terminal 能力（安全基线）
const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

// ---------- 时间线日志（同时 tee 到 stdout 与报告文件缓冲） ----------
const t0 = Date.now();
const reportLines = [];
function stamp() {
  return '+' + String(Date.now() - t0).padStart(6, '0') + 'ms';
}
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function logFull(label, obj, limit = RESP_DUMP_LIMIT) {
  log.recv(`${label}:\n${truncate(JSON.stringify(obj, null, 2), limit)}`);
}

// ---------- CLI 路径解析（同 probe4：两个候选安装路径） ----------
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

// ---------- 消息分帧（ndjson / Content-Length，照搬 probe4） ----------
function encodeMessage(msg, framing) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (framing === 'lsp') {
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
  }
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
        this.onRaw(header);
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) return;
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

// ---------- 全局探测结果（按 14 项组织；结尾逐项摘要） ----------
const results = {
  framingUsed: null,
  rawChunks: 0,
  // ③ list
  capsSessionList: null,        // initialize 是否公告 sessionCapabilities.list
  listFields: null,             // session/list 首条会话的字段名数组
  listCount: 0,
  listNextCursor: null,         // 首页 nextCursor
  listPage2: null,              // 翻页结果摘要
  // ① load 回放
  loadReplaySameProc: null,     // 同进程 load A 是否回放历史
  loadReplayNotifications: [],  // load 期间收集的 session/update kind 列表
  loadReplayCrossProc: null,    // 跨进程复测
  // ② resume
  resumeOk: null,               // 方法是否存在/成功
  resumeResult: null,           // 响应结构摘要
  resumeNotifications: [],      // resume 期间通知 kind
  // ④ auth
  unauthInitialize: null,       // 未登录 initialize 结果（authMethods 等）
  unauthSessionNew: null,       // 未登录 session/new 结果（-32000?）
  unauthPrompt: null,
  unauthAuthenticate: null,     // authenticate('login') 初始响应
  unauthAuthenticateBogus: null, // authenticate('bogus') 错误形态
  // ⑤ thinking / set_model
  configOptionsShape: null,     // session/new 返回的 configOptions 完整结构
  setModelResult: null,         // session/set_model 结果
  // ⑥ elicitation
  elicitationCaptured: null,    // 诱导捕获的 request_permission 完整结构
  elicitationAttempts: 0,
  // ⑦ 推送形态
  planSamples: [],              // plan sessionUpdate 样本
  configOptionUpdateSamples: [],
  availableCommands: null,      // 命令清单（去重合并）
  // ⑧ 图片
  imageCapability: null,
  imagePromptStopReason: null,
  imagePromptError: null,
  imageChildCrashed: false,
  // ⑨ goal
  goalUpdates: [],              // goal 相关推送样本
  goalMarkSeen: false,
  // ⑩ hooks
  hooksFired: null,             // 标记文件是否出现
  hooksPayload: null,           // 标记文件内容摘要
  // ⑪⑫ mode
  setModeResult: null,
  setModeViaConfigResult: null,
  modeUpdateKinds: [],          // 切模式期间出现的通知 kind
  // ⑬ embeddedContext / mcpServers
  embeddedContextEcho: null,    // agent 是否读到 CONTEXT_MARK
  mcpForwardObserved: [],       // stderr/日志中观察到的转发/warn 行
  // 通用统计
  permissionRequests: 0,
  otherServerRequests: [],
};

// 通知统计：kind -> count / 样本（最多3条）/ 首次出现次序
const notifStats = new Map();
const notifSamples = new Map();
function recordNotification(kind, msg) {
  notifStats.set(kind, (notifStats.get(kind) || 0) + 1);
  const samples = notifSamples.get(kind) || [];
  if (samples.length < 3) {
    samples.push(JSON.stringify(msg.params));
    notifSamples.set(kind, samples);
  }
}
function summarizeNotifKinds() {
  if (!notifStats.size) return '(无)';
  return [...notifStats.entries()].map(([k, c]) => `${k}×${c}`).join(', ');
}

// ---------- ACP 会话通道（一个子进程实例的封装） ----------
// 与 probe4 的内联全局状态不同，probe5 需要 4 个独立子进程（主进程/跨进程复测/hooks/auth），
// 把「spawn + 分帧 + 收发 + 通知处理」收敛为类，便于多进程复用同一套逻辑。
class ProbeChannel {
  constructor(name, extraEnv) {
    this.name = name;
    this.extraEnv = extraEnv || null; // 注入子进程的额外环境变量（如 KIMI_CODE_HOME 隔离）
    this.child = null;
    this.framing = 'ndjson';
    this.parser = null;
    this.nextId = 1;
    this.childExited = false;
    this.exitCode = null;
    this.pending = new Map();
    this.stderrLines = [];
    this.sessionId = null;
    this.turnText = '';               // 当前 prompt 轮次累计的 agent 文本
    this.notificationSink = null;     // 阶段临时通知监听器 fn(kind, msg)
    this.elicitationSink = null;      // 阶段临时 request_permission 监听器 fn(msg)
  }

  start(mode, cliPath) {
    this.framing = mode;
    this.childExited = false;
    const env = this.extraEnv ? { ...process.env, ...this.extraEnv } : process.env;
    log.info(`[${this.name}] 以 ${mode} 分帧启动子进程: kimi acp${this.extraEnv ? `（注入 env: ${Object.keys(this.extraEnv).join(',')}）` : ''}`);
    this.child = spawn(cliPath, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.parser = new FrameParser(mode, (m) => this.handleMessage(m), (t) => this.handleRaw(t));
    log.info(`[${this.name}] 子进程已 spawn, pid=${this.child.pid}`);
    this.child.on('error', (e) => {
      log.err(`[${this.name}] 子进程 error 事件: ${e.message}`);
      this.childExited = true;
      this.rejectAllPending(new Error(`spawn 失败: ${e.message}`));
    });
    this.child.on('exit', (code, signal) => {
      log.info(`[${this.name}] 子进程退出: code=${code} signal=${signal}`);
      this.childExited = true;
      this.exitCode = code;
      this.rejectAllPending(new Error(`子进程已退出 code=${code}`));
    });
    this.child.stdout.on('data', (chunk) => {
      try {
        this.parser.push(chunk);
      } catch (e) {
        log.err(`[${this.name}] 分帧解析异常: ${e.message}`);
      }
    });
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      this.stderrLines.push(text);
      // mcpServers 转发观察（项⑬b）：转发/丢弃/warn 行直接捞出
      if (/mcp|transport|warn/i.test(text)) results.mcpForwardObserved.push(truncate(text, RAW_DUMP_LIMIT));
      log.info(`[${this.name}][stderr] ${truncate(text, RAW_DUMP_LIMIT)}`);
    });
    this.child.stdin.on('error', (e) => log.err(`[${this.name}] stdin 写入异常: ${e.message}`));
  }

  kill(reason) {
    if (this.child && !this.childExited) {
      log.info(`[${this.name}] kill 子进程 pid=${this.child.pid}（${reason}）`);
      try { this.child.kill(); } catch (e) { log.err(`[${this.name}] kill 失败: ${e.message}`); }
    }
    this.rejectAllPending(new Error('子进程被终止'));
  }

  rejectAllPending(err) {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }

  writeMessage(obj) {
    const data = encodeMessage(obj, this.framing);
    log.send(`[${this.name}] ${obj.method || `响应 id=${obj.id}`} [${this.framing}] ${truncate(JSON.stringify(obj), PARAMS_DUMP_LIMIT)}`);
    this.child.stdin.write(data);
  }

  sendRequest(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject, sentAt: Date.now() });
      try {
        this.writeMessage({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  requestWithTimeout(method, params, ms, timeoutDesc) {
    const p = this.sendRequest(method, params);
    p.catch(() => {});
    return Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutDesc)), ms)),
    ]);
  }

  sendResult(id, result) {
    this.writeMessage({ jsonrpc: '2.0', id, result });
  }
  sendError(id, code, message) {
    this.writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
  }

  handleMessage(msg) {
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this.handleServerRequest(msg);
    } else if (msg.method) {
      this.handleNotification(msg);
    } else if (msg.id !== undefined && msg.id !== null) {
      this.handleResponse(msg);
    } else {
      log.info(`[${this.name}] 无法归类的消息: ${truncate(JSON.stringify(msg), PARAMS_DUMP_LIMIT)}`);
    }
  }

  handleResponse(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      log.recv(`[${this.name}] 孤儿响应 id=${msg.id}: ${truncate(JSON.stringify(msg), PARAMS_DUMP_LIMIT)}`);
      return;
    }
    this.pending.delete(msg.id);
    const rtt = Date.now() - entry.sentAt;
    log.recv(`[${this.name}] ${entry.method} 响应 (id=${msg.id}, 往返 ${rtt}ms)${msg.error ? ' [错误]' : ''}`);
    entry.resolve(msg);
  }

  handleNotification(msg) {
    const kind =
      msg.method === 'session/update' && msg.params && msg.params.update
        ? `session/update:${msg.params.update.sessionUpdate || '?'}`
        : msg.method;
    recordNotification(kind, msg);
    // 专项收集：plan / config_option_update / current_mode_update / available_commands_update / goal
    if (msg.method === 'session/update' && msg.params && msg.params.update) {
      const u = msg.params.update;
      if (u.sessionUpdate === 'plan' && results.planSamples.length < 3) {
        results.planSamples.push(u);
      }
      if (u.sessionUpdate === 'config_option_update' && results.configOptionUpdateSamples.length < 3) {
        results.configOptionUpdateSamples.push(u);
      }
      if (u.sessionUpdate === 'available_commands_update') {
        const cmds = (u.availableCommands || u.available_commands || []).map((c) => c && (c.name || c));
        const known = new Set(results.availableCommands || []);
        for (const c of cmds) known.add(c);
        results.availableCommands = [...known];
      }
      if (/goal/i.test(String(u.sessionUpdate)) && results.goalUpdates.length < 5) {
        results.goalUpdates.push(u);
      }
      if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
        this.turnText += u.content.text || '';
        if (this.turnText.includes(GOAL_MARK)) results.goalMarkSeen = true;
      }
    }
    log.recv(`[${this.name}] 通知 ${kind} ${truncate(JSON.stringify(msg.params), PARAMS_DUMP_LIMIT)}`);
    if (this.notificationSink) {
      try { this.notificationSink(kind, msg); } catch { /* 监听器异常不影响主流程 */ }
    }
  }

  // agent -> client 请求：elicitation 捕获开启时先记录完整结构；一律回 cancelled（安全基线）
  handleServerRequest(msg) {
    log.recv(`[${this.name}] server→client 请求 ${msg.method} (id=${msg.id})，完整结构: ${truncate(JSON.stringify(msg), FULL_DUMP_LIMIT)}`);
    if (msg.method === 'session/request_permission') {
      results.permissionRequests++;
      if (this.elicitationSink) {
        try { this.elicitationSink(msg); } catch { /* 同上 */ }
      }
      this.sendResult(msg.id, { outcome: { outcome: 'cancelled' } });
      log.info(`[${this.name}] 已按协议回应 request_permission -> outcome=cancelled（探测，不批准执行）`);
    } else {
      results.otherServerRequests.push(msg.method);
      this.sendError(msg.id, -32601, 'acp-probe5: capability not implemented');
      log.info(`[${this.name}] 已回 JSON-RPC 错误 -32601（未实现的能力: ${msg.method}）`);
    }
  }

  handleRaw(text) {
    results.rawChunks++;
    log.info(`[${this.name}][raw] 无法按 JSON 解析的输出: ${truncate(text, RAW_DUMP_LIMIT)}`);
  }

  // initialize 握手：ndjson 首发，无响应则 kill 重启改试 LSP（沿用 probe4 回退逻辑）
  async handshake(cliPath) {
    this.start('ndjson', cliPath);
    let initResp;
    try {
      initResp = await this.requestWithTimeout(
        'initialize',
        INIT_PARAMS,
        FRAMING_PROBE_MS,
        `ndjson 分帧 initialize 后 ${FRAMING_PROBE_MS}ms 无响应`
      );
    } catch (e) {
      log.info(`[${this.name}] ${e.message}，kill 子进程并以 Content-Length(LSP) 分帧重启`);
      this.kill('分帧探测切换');
      await sleep(500);
      this.start('lsp', cliPath);
      initResp = await this.sendRequest('initialize', INIT_PARAMS);
    }
    results.framingUsed = results.framingUsed || this.framing;
    logFull(`[${this.name}] initialize 完整响应`, initResp);
    return initResp;
  }

  // 发一条文本 prompt 并等待响应；返回 { resp, error, turnText }
  async sendTextPrompt(text, timeoutMs = PROMPT_TIMEOUT_MS) {
    this.turnText = '';
    try {
      const resp = await this.requestWithTimeout(
        'session/prompt',
        { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
        timeoutMs,
        `prompt ${timeoutMs}ms 无响应`
      );
      logFull(`[${this.name}] session/prompt 完整响应`, resp);
      if (resp.error) return { resp, error: JSON.stringify(resp.error), turnText: this.turnText };
      return { resp, error: null, turnText: this.turnText };
    } catch (e) {
      log.err(`[${this.name}] prompt 失败: ${e.message}`);
      return { resp: null, error: e.message, turnText: this.turnText };
    }
  }

  async newSession(cwd, mcpServers) {
    const resp = await this.requestWithTimeout(
      'session/new',
      { cwd, mcpServers: mcpServers || [] },
      SESSION_NEW_TIMEOUT_MS,
      `session/new ${SESSION_NEW_TIMEOUT_MS}ms 无响应`
    );
    logFull(`[${this.name}] session/new 完整响应`, resp);
    if (resp.error) throw new Error(`session/new 错误: ${JSON.stringify(resp.error)}`);
    this.sessionId = resp.result && resp.result.sessionId;
    if (!this.sessionId) throw new Error('session/new 响应中没有 sessionId');
    return resp.result;
  }
}

// ---------- 阶段工具 ----------
function stage(title) {
  log.info(`========== ${title} ==========`);
}

// 从 configOptions 数组里按 id/category 模糊查找配置项（兼容不同字段命名）
function findConfigOption(configOptions, needle) {
  if (!Array.isArray(configOptions)) return null;
  return configOptions.find((o) => o && (o.id === needle || o.configId === needle || o.name === needle)) || null;
}

// ---------- 主流程 ----------
let cliPath = null;
let done = false;

async function main() {
  log.info('ACP 第五次探测开始（CLI 0.29.x，ROADMAP P0-2 共 14 项）');
  log.info(`Node ${process.version}, platform=${process.platform}, arch=${process.arch}`);

  // 内嵌 PNG 自校验（保证项⑧图片数据本身有效）
  const pngBuf = Buffer.from(PNG_BASE64, 'base64');
  log.info(`内嵌 1x1 PNG 自校验: ${pngBuf.length > 8 && pngBuf.subarray(0, 8).equals(PNG_MAGIC) ? '通过' : '失败'}（解码后 ${pngBuf.length} 字节）`);

  cliPath = resolveCli();
  if (!cliPath) {
    log.err('两个候选路径均未找到 CLI，探测中止');
    return finish(1);
  }
  log.info(`选定 CLI: ${cliPath}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe5-'));
  log.info(`探测工作目录(临时): ${workDir}`);
  // embeddedContext 测试文件（项⑬a）
  const markerFile = path.join(workDir, 'probe5-context.txt');
  fs.writeFileSync(markerFile, `口令是 ${CONTEXT_MARK}\n其余内容无关。`, 'utf8');

  // ==================== 主进程 P1：项 ①②③⑤⑥⑦⑧⑨⑪⑫⑬⑭ ====================
  const main1 = new ProbeChannel('P1');
  let sessionIdA = null;

  stage('S0 initialize（项③公告 / 项⑧能力声明 / authMethods）');
  const initResp = await main1.handshake(cliPath);
  if (initResp.error) {
    log.err(`initialize 返回错误: ${JSON.stringify(initResp.error)}`);
    return finish(1);
  }
  const caps = initResp.result && initResp.result.agentCapabilities;
  results.imageCapability = caps && caps.promptCapabilities ? caps.promptCapabilities.image === true : null;
  results.capsSessionList = !!(caps && caps.sessionCapabilities && caps.sessionCapabilities.list !== undefined);
  log.info(`agent 声明: promptCapabilities.image=${results.imageCapability}, sessionCapabilities.list=${results.capsSessionList ? '已公告' : '未公告'}`);

  // ---------- 项③ session/list ----------
  stage('S1 项③ session/list 字段与分页');
  try {
    const listResp = await main1.requestWithTimeout('session/list', {}, GENERIC_REQ_TIMEOUT_MS, 'session/list 无响应');
    logFull('session/list 完整响应（首页）', listResp);
    if (listResp.error) {
      results.listFields = `错误: ${JSON.stringify(listResp.error)}`;
    } else {
      const r = listResp.result || {};
      const sessions = r.sessions || r.items || [];
      results.listCount = sessions.length;
      results.listNextCursor = r.nextCursor !== undefined ? r.nextCursor : (r.next_cursor !== undefined ? r.next_cursor : null);
      results.listFields = sessions.length ? Object.keys(sessions[0]) : '(空列表)';
      log.info(`session/list: 首页 ${sessions.length} 条, nextCursor=${JSON.stringify(results.listNextCursor)}, 字段=${JSON.stringify(results.listFields)}`);
      if (results.listNextCursor) {
        const p2 = await main1.requestWithTimeout('session/list', { cursor: results.listNextCursor }, GENERIC_REQ_TIMEOUT_MS, 'session/list 翻页无响应');
        logFull('session/list 完整响应（第 2 页）', p2);
        const r2 = p2.result || {};
        const s2 = r2.sessions || r2.items || [];
        results.listPage2 = `第 2 页 ${s2.length} 条, nextCursor=${JSON.stringify(r2.nextCursor !== undefined ? r2.nextCursor : r2.next_cursor)}`;
      } else {
        results.listPage2 = '首页无 nextCursor，未翻页';
      }
    }
  } catch (e) {
    results.listFields = `异常: ${e.message}`;
    log.err(`session/list 探测失败: ${e.message}`);
  }

  // ---------- 会话 A/B 建立 + 项⑤ configOptions 形态 ----------
  stage('S2 session/new A（项⑤ configOptions 完整结构）');
  try {
    const newA = await main1.newSession(workDir);
    sessionIdA = main1.sessionId;
    results.configOptionsShape = newA.configOptions || null;
    log.info(`会话 A: ${sessionIdA}；configOptions ${Array.isArray(newA.configOptions) ? newA.configOptions.length + ' 项' : '(缺失)'}`);
  } catch (e) {
    log.err(`session/new A 失败: ${e.stack || e.message}`);
    return finish(1);
  }

  stage('S3 会话 A 留痕 prompt（为项①回放判定准备历史）');
  const markResp = await main1.sendTextPrompt(`Reply with exactly: ${MARK_A}`);
  log.info(`留痕 prompt: error=${markResp.error || '无'}, 回显 ${MARK_A}=${markResp.turnText.includes(MARK_A)}`);

  stage('S4 session/new B（同 cwd，构造「A 为非活跃会话」场景）');
  let sessionIdB = null;
  try {
    await main1.newSession(workDir);
    sessionIdB = main1.sessionId;
    log.info(`会话 B: ${sessionIdB}`);
  } catch (e) {
    log.err(`session/new B 失败: ${e.message}（项①同进程复测将受影响）`);
  }

  // ---------- 项① session/load 非活跃会话回放（同进程） ----------
  stage('S5 项① session/load A（非活跃会话，同进程）——观察历史回放');
  if (sessionIdB) {
    const loadNotifs = [];
    main1.notificationSink = (kind) => loadNotifs.push(kind);
    try {
      const loadResp = await main1.requestWithTimeout(
        'session/load',
        { sessionId: sessionIdA, cwd: workDir, mcpServers: [] },
        SESSION_NEW_TIMEOUT_MS,
        'session/load 无响应'
      );
      logFull('session/load A 完整响应', loadResp);
      await sleep(2000); // 收残余回放通知
      main1.notificationSink = null;
      results.loadReplayNotifications = loadNotifs;
      const replayedText = main1.turnText; // 注意：turnText 只统计 chunk；回放判定主要看通知流
      const sawHistory = loadNotifs.some((k) => k.startsWith('session/update:agent_message_chunk') || k.startsWith('session/update:user_message'));
      results.loadReplaySameProc = sawHistory ? '是（load 期间收到历史消息推送）' : '否（load 期间无历史消息推送）';
      if (loadResp.error) results.loadReplaySameProc = `load 返回错误: ${JSON.stringify(loadResp.error)}`;
      log.info(`项①同进程: ${results.loadReplaySameProc}；通知序列=${loadNotifs.join(', ') || '(无)'}${replayedText ? `；chunk 文本含 MARK=${replayedText.includes(MARK_A)}` : ''}`);
      main1.sessionId = sessionIdA; // load 成功后当前会话切回 A
    } catch (e) {
      main1.notificationSink = null;
      results.loadReplaySameProc = `异常: ${e.message}`;
      log.err(`session/load A 失败: ${e.message}`);
    }
  }

  // ---------- 项② session/resume 与 load 差异 ----------
  stage('S6 项② session/resume B——与 load 对比（响应结构 + 是否跳过回放）');
  const resumeNotifs = [];
  main1.notificationSink = (kind) => resumeNotifs.push(kind);
  try {
    const resumeResp = await main1.requestWithTimeout(
      'session/resume',
      { sessionId: sessionIdB, cwd: workDir, mcpServers: [] },
      SESSION_NEW_TIMEOUT_MS,
      'session/resume 无响应'
    );
    logFull('session/resume B 完整响应', resumeResp);
    await sleep(2000);
    results.resumeNotifications = resumeNotifs;
    if (resumeResp.error) {
      results.resumeOk = false;
      results.resumeResult = `错误: ${JSON.stringify(resumeResp.error)}`;
    } else {
      results.resumeOk = true;
      results.resumeResult = resumeResp.result ? Object.keys(resumeResp.result) : '(空 result)';
      main1.sessionId = sessionIdB;
    }
    log.info(`项②: resume ${results.resumeOk ? '成功' : '失败'}，结果键=${JSON.stringify(results.resumeResult)}，通知=${resumeNotifs.join(', ') || '(无)'}（对比 load 通知=${(results.loadReplayNotifications || []).join(', ') || '(无)'}）`);
  } catch (e) {
    results.resumeOk = false;
    results.resumeResult = `异常: ${e.message}`;
    log.err(`session/resume B 失败: ${e.message}`);
  }
  main1.notificationSink = null;

  // ---------- 项⑤ session/set_model 参数格式 ----------
  stage('S7 项⑤ session/set_model（不稳定面）参数格式实测');
  try {
    // 模型候选：优先从 configOptions 的 model 配置项取值，否则用目录全名
    const modelOpt = findConfigOption(results.configOptionsShape, 'model');
    const candidates = (modelOpt && (modelOpt.options || modelOpt.values || [])).map((o) => o && (o.value || o.id || o)).filter(Boolean);
    const targetModel = candidates.find((v) => typeof v === 'string' && /k3/.test(v)) || 'kimi-code/k3';
    log.info(`set_model 目标模型: ${targetModel}（configOptions.model 候选=${JSON.stringify(candidates)}）`);
    const smResp = await main1.requestWithTimeout(
      'session/set_model',
      { sessionId: main1.sessionId, modelId: targetModel },
      GENERIC_REQ_TIMEOUT_MS,
      'session/set_model 无响应'
    );
    logFull('session/set_model 完整响应', smResp);
    results.setModelResult = smResp.error ? `错误: ${JSON.stringify(smResp.error)}` : `成功: ${JSON.stringify(smResp.result)}`;
  } catch (e) {
    results.setModelResult = `异常: ${e.message}`;
    log.err(`session/set_model 失败: ${e.message}`);
  }

  // ---------- 项⑪⑫ set_mode vs set_config_option 等价性 + current_mode_update ----------
  stage('S8 项⑪⑫ set_mode vs set_config_option（切 plan→default，观察推送 kind）');
  const modeOpt = findConfigOption(results.configOptionsShape, 'mode');
  const modeCandidates = (modeOpt && (modeOpt.options || modeOpt.values || [])).map((o) => o && (o.value || o.id || o)).filter(Boolean);
  const planMode = modeCandidates.find((v) => /plan/i.test(String(v))) || 'plan';
  const defaultMode = modeCandidates.find((v) => /default|normal|code/i.test(String(v))) || 'default';
  log.info(`mode 候选=${JSON.stringify(modeCandidates)}，选用 plan=${planMode}, default=${defaultMode}`);
  const modeKinds1 = [];
  main1.notificationSink = (kind) => modeKinds1.push(kind);
  try {
    const r1 = await main1.requestWithTimeout('session/set_mode', { sessionId: main1.sessionId, modeId: planMode }, GENERIC_REQ_TIMEOUT_MS, 'set_mode 无响应');
    logFull('session/set_mode(plan) 完整响应', r1);
    results.setModeResult = r1.error ? `错误: ${JSON.stringify(r1.error)}` : `成功: ${JSON.stringify(r1.result)}`;
  } catch (e) {
    results.setModeResult = `异常: ${e.message}`;
  }
  await sleep(1500);
  main1.notificationSink = null;
  const modeKinds2 = [];
  main1.notificationSink = (kind) => modeKinds2.push(kind);
  try {
    const r2 = await main1.requestWithTimeout(
      'session/set_config_option',
      { sessionId: main1.sessionId, configId: 'mode', value: defaultMode },
      GENERIC_REQ_TIMEOUT_MS,
      'set_config_option(mode) 无响应'
    );
    logFull('set_config_option(mode=default) 完整响应', r2);
    results.setModeViaConfigResult = r2.error ? `错误: ${JSON.stringify(r2.error)}` : `成功`;
  } catch (e) {
    results.setModeViaConfigResult = `异常: ${e.message}`;
  }
  await sleep(1500);
  main1.notificationSink = null;
  results.modeUpdateKinds = { setMode: modeKinds1, setConfigOption: modeKinds2 };
  log.info(`项⑪⑫: set_mode 推送=${modeKinds1.join(', ') || '(无)'}；set_config_option 推送=${modeKinds2.join(', ') || '(无)'}`);

  // ---------- 项⑦ plan 推送（plan 模式下发规划 prompt） ----------
  stage('S9 项⑦ plan 推送（plan 模式规划 prompt）');
  try {
    await main1.requestWithTimeout('session/set_mode', { sessionId: main1.sessionId, modeId: planMode }, GENERIC_REQ_TIMEOUT_MS, 'set_mode(plan) 无响应').catch(() => null);
    const planResp = await main1.sendTextPrompt('制定一个三步学习做煎饼的计划。只输出计划，不要执行任何操作。', 60_000);
    log.info(`plan prompt: error=${planResp.error || '无'}；plan 样本数=${results.planSamples.length}`);
    // ExitPlanMode 审批（若出现）已按 cancelled 回应；切回 default
    await main1.requestWithTimeout('session/set_mode', { sessionId: main1.sessionId, modeId: defaultMode }, GENERIC_REQ_TIMEOUT_MS, 'set_mode(default) 无响应').catch(() => null);
  } catch (e) {
    log.err(`plan 探测失败: ${e.message}`);
  }

  // ---------- 项⑥ elicitation 诱导（至多 3 次） ----------
  stage('S10 项⑥ AskUserQuestion elicitation 诱导（至多 3 次）');
  const ELICIT_PROMPTS = [
    '请调用 AskUserQuestion 工具向我提问，要求：恰好包含 2 个问题；第 1 个问题为单选并提供 2 个选项；第 2 个问题设置 multi_select 为 true、提供 3 个选项并设置 allow_other 为 true。除调用该工具外不要做任何事情。',
    '使用 AskUserQuestion 工具问我两个选择题（一个单选 2 选项，一个多选 multi_select 3 选项、允许自定义 allow_other）。不要执行其他操作。',
    'Call the AskUserQuestion tool now with exactly 2 questions: one single-select with 2 options, one multi_select with 3 options and allow_other=true. Do nothing else.',
  ];
  for (let i = 0; i < ELICIT_PROMPTS.length && !results.elicitationCaptured; i++) {
    results.elicitationAttempts = i + 1;
    log.info(`elicitation 诱导第 ${i + 1} 次`);
    main1.elicitationSink = (msg) => {
      // 粗判 elicitation：options 携带问题结构或 toolCall 指向 AskUserQuestion
      if (!results.elicitationCaptured) results.elicitationCaptured = msg.params;
    };
    await main1.sendTextPrompt(ELICIT_PROMPTS[i], 60_000);
    main1.elicitationSink = null;
    if (results.elicitationCaptured) break;
    await sleep(1000);
  }
  log.info(`项⑥: ${results.elicitationCaptured ? '已捕获 request_permission 结构' : '3 次诱导均未触发'}（permission 请求总数=${results.permissionRequests}）`);

  // ---------- 项⑨ /goal 推送观察 ----------
  stage('S11 项⑨ /goal 文本命令推送观察');
  const goalKindsBefore = new Set([...notifStats.keys()]);
  const goalResp = await main1.sendTextPrompt(`/goal 立即回复 ${GOAL_MARK} 然后完成此目标`, 60_000);
  await sleep(2000);
  const goalKindsAfter = [...notifStats.keys()].filter((k) => !goalKindsBefore.has(k));
  log.info(`项⑨: prompt error=${goalResp.error || '无'}；回显 ${GOAL_MARK}=${results.goalMarkSeen}；新通知 kind=${goalKindsAfter.join(', ') || '(无)'}；goal 样本=${results.goalUpdates.length}`);

  // ---------- 项⑧ 图片输入复测 ----------
  stage('S12 项⑧ 图文 prompt 复测（0.27 崩溃 0xC0000409）');
  try {
    main1.turnText = '';
    const imgResp = await main1.requestWithTimeout(
      'session/prompt',
      {
        sessionId: main1.sessionId,
        prompt: [
          { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
          { type: 'text', text: PROMPT_TEXT_IMAGE },
        ],
      },
      45_000,
      '图文 prompt 45s 无响应'
    );
    logFull('图文 prompt 完整响应', imgResp);
    if (imgResp.error) {
      results.imagePromptError = JSON.stringify(imgResp.error);
    } else {
      results.imagePromptStopReason = imgResp.result && imgResp.result.stopReason;
    }
    await sleep(1000);
  } catch (e) {
    results.imagePromptError = e.message;
    log.err(`图文 prompt 失败: ${e.message}`);
  }
  results.imageChildCrashed = main1.childExited;
  log.info(`项⑧: stopReason=${results.imagePromptStopReason || '(无)'}, error=${results.imagePromptError || '无'}, 子进程异常退出=${main1.childExited}（exitCode=${main1.exitCode}）`);

  // ---------- 项⑬a embeddedContext / resource 块 ----------
  stage('S13 项⑬a embeddedContext（resource 块引用测试文件）');
  if (!main1.childExited) {
    main1.turnText = '';
    try {
      const fileUri = 'file:///' + markerFile.replace(/\\/g, '/');
      const ctxResp = await main1.requestWithTimeout(
        'session/prompt',
        {
          sessionId: main1.sessionId,
          prompt: [
            {
              type: 'resource',
              resource: {
                uri: fileUri,
                mimeType: 'text/plain',
                text: fs.readFileSync(markerFile, 'utf8'),
              },
            },
            { type: 'text', text: '上面的 resource 块是一个文件的内容。这个文件里写的口令是什么？只回复口令本身。' },
          ],
        },
        60_000,
        'embeddedContext prompt 60s 无响应'
      );
      logFull('embeddedContext prompt 完整响应', ctxResp);
      results.embeddedContextEcho = main1.turnText.includes(CONTEXT_MARK)
        ? `agent 正确回读口令（${CONTEXT_MARK}）`
        : `agent 未回读口令；error=${ctxResp.error ? JSON.stringify(ctxResp.error) : '无'}；agent 文本=${truncate(main1.turnText, RAW_DUMP_LIMIT)}`;
    } catch (e) {
      results.embeddedContextEcho = `异常: ${e.message}`;
    }
    log.info(`项⑬a: ${results.embeddedContextEcho}`);
  } else {
    results.embeddedContextEcho = '跳过（主进程已退出）';
  }

  // ---------- 项⑬b mcpServers 四形态转发 ----------
  stage('S14 项⑬b mcpServers 转发（http/stdio/sse/acp 四形态）');
  if (!main1.childExited) {
    results.mcpForwardObserved = []; // 清空此前无关 stderr 观察
    const mcpPayload = [
      { name: 'probe5-http', type: 'http', url: 'http://127.0.0.1:1/mcp' },
      { name: 'probe5-stdio', command: 'node', args: ['--version'] },
      { name: 'probe5-sse', type: 'sse', url: 'http://127.0.0.1:1/sse' },
      { name: 'probe5-acp', type: 'acp', command: 'node', args: ['--version'] },
    ];
    try {
      const mcpResp = await main1.requestWithTimeout(
        'session/new',
        { cwd: workDir, mcpServers: mcpPayload },
        SESSION_NEW_TIMEOUT_MS,
        'mcpServers session/new 无响应'
      );
      logFull('mcpServers session/new 完整响应', mcpResp);
      if (!mcpResp.error && mcpResp.result && mcpResp.result.sessionId) {
        log.info(`mcpServers 会话已建: ${mcpResp.result.sessionId}（四形态转发后回到会话 B 继续）`);
      }
    } catch (e) {
      log.err(`mcpServers session/new 失败: ${e.message}`);
    }
    await sleep(2000); // 等 stderr warn 行
    log.info(`项⑬b: stderr 中 mcp/transport/warn 相关行 ${results.mcpForwardObserved.length} 条`);
  } else {
    log.info('项⑬b: 跳过（主进程已退出）');
  }
  main1.kill('主进程探测完成');
  await sleep(800);

  // ==================== P2：项①跨进程复测 load A ====================
  stage('P2 项①跨进程复测：重启 acp 后 load 会话 A');
  if (sessionIdA) {
    const p2 = new ProbeChannel('P2');
    try {
      const init2 = await p2.handshake(cliPath);
      if (init2.error) throw new Error(`initialize 错误: ${JSON.stringify(init2.error)}`);
      const replayNotifs = [];
      p2.notificationSink = (kind) => replayNotifs.push(kind);
      const load2 = await p2.requestWithTimeout(
        'session/load',
        { sessionId: sessionIdA, cwd: workDir, mcpServers: [] },
        SESSION_NEW_TIMEOUT_MS,
        'P2 session/load 无响应'
      );
      logFull('P2 session/load A 完整响应', load2);
      await sleep(2000);
      p2.notificationSink = null;
      const sawHistory = replayNotifs.some((k) => k.startsWith('session/update:agent_message_chunk') || k.startsWith('session/update:user_message'));
      results.loadReplayCrossProc = load2.error
        ? `load 返回错误: ${JSON.stringify(load2.error)}`
        : sawHistory
          ? `是（跨进程 load 收到历史推送：${replayNotifs.join(', ')}）`
          : `否（跨进程 load 无历史推送：${replayNotifs.join(', ') || '(无通知)'}）`;
    } catch (e) {
      results.loadReplayCrossProc = `异常: ${e.message}`;
    }
    p2.kill('跨进程复测完成');
    log.info(`项①跨进程: ${results.loadReplayCrossProc}`);
  } else {
    results.loadReplayCrossProc = '跳过（会话 A 未建成）';
  }

  // ==================== P3：项⑩ hooks（临时 KIMI_CODE_HOME + 凭据复制） ====================
  stage('P3 项⑩ hooks 在 ACP 会话中是否触发（UserPromptSubmit）');
  try {
    const realHome = path.join(os.homedir(), '.kimi-code');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe5-home-'));
    // 复制凭据与既有配置，再追加 hook 规则
    const credSrc = path.join(realHome, 'credentials');
    if (fs.existsSync(credSrc)) fs.cpSync(credSrc, path.join(fakeHome, 'credentials'), { recursive: true });
    const cfgSrc = path.join(realHome, 'config.toml');
    let cfgText = fs.existsSync(cfgSrc) ? fs.readFileSync(cfgSrc, 'utf8') : '';
    const hookMarker = path.join(fakeHome, 'hook-fired.log').replace(/\\/g, '\\\\');
    const hookScript = path.join(fakeHome, 'hook.cjs');
    fs.writeFileSync(
      hookScript,
      `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{require('fs').appendFileSync('${hookMarker}', d+'\\n---\\n');});`,
      'utf8'
    );
    cfgText += `\n[[hooks]]\nevent = "UserPromptSubmit"\ncommand = 'node "${hookScript.replace(/\\/g, '\\\\')}"'\ntimeout = 10\n`;
    fs.writeFileSync(path.join(fakeHome, 'config.toml'), cfgText, 'utf8');
    log.info(`hooks 临时 home: ${fakeHome}（凭据已复制，config.toml 追加 UserPromptSubmit hook）`);

    const p3 = new ProbeChannel('P3', { KIMI_CODE_HOME: fakeHome });
    const init3 = await p3.handshake(cliPath);
    if (init3.error) throw new Error(`initialize 错误: ${JSON.stringify(init3.error)}`);
    await p3.newSession(workDir);
    await p3.sendTextPrompt('Reply with exactly: PROBE5-HOOK-MARK', 60_000);
    await sleep(3000); // 等 hook 落盘
    const markerExists = fs.existsSync(path.join(fakeHome, 'hook-fired.log'));
    results.hooksFired = markerExists;
    results.hooksPayload = markerExists
      ? truncate(fs.readFileSync(path.join(fakeHome, 'hook-fired.log'), 'utf8'), PARAMS_DUMP_LIMIT)
      : '(标记文件不存在)';
    log.info(`项⑩: hook ${markerExists ? '已触发' : '未触发'}；payload=${results.hooksPayload}`);
    p3.kill('hooks 探测完成');
    // 临时 home 含复制的凭据，探测后清理
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  } catch (e) {
    results.hooksFired = false;
    results.hooksPayload = `异常: ${e.message}`;
    log.err(`hooks 探测失败: ${e.stack || e.message}`);
  }

  // ==================== P4：项④ 未登录形态（空 KIMI_CODE_HOME） ====================
  stage('P4 项④ 未登录 authRequired/authenticate（空 KIMI_CODE_HOME 隔离）');
  try {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe5-unauth-'));
    const p4 = new ProbeChannel('P4', { KIMI_CODE_HOME: emptyHome });
    const init4 = await p4.handshake(cliPath);
    results.unauthInitialize = init4.error
      ? `错误: ${JSON.stringify(init4.error)}`
      : { authMethods: init4.result && init4.result.authMethods, agentInfo: init4.result && init4.result.agentInfo };
    log.info(`项④ initialize: ${JSON.stringify(results.unauthInitialize)}`);

    try {
      const newResp = await p4.requestWithTimeout('session/new', { cwd: workDir, mcpServers: [] }, SESSION_NEW_TIMEOUT_MS, '未登录 session/new 无响应');
      logFull('未登录 session/new 完整响应', newResp);
      results.unauthSessionNew = newResp.error ? JSON.stringify(newResp.error) : `意外成功: ${JSON.stringify(newResp.result)}`;
      if (!newResp.error && newResp.result && newResp.result.sessionId) {
        p4.sessionId = newResp.result.sessionId;
        const pr = await p4.sendTextPrompt('hi', 20_000);
        results.unauthPrompt = pr.error || `意外成功: ${truncate(pr.turnText, 100)}`;
      }
    } catch (e) {
      results.unauthSessionNew = `异常: ${e.message}`;
    }
    log.info(`项④ session/new: ${results.unauthSessionNew}${results.unauthPrompt ? `；prompt: ${results.unauthPrompt}` : ''}`);

    // authenticate('login')：预期进入设备码流程或返回错误；观察初始响应（窗口内无响应也记结论）
    try {
      const authResp = await p4.requestWithTimeout('authenticate', { method_id: 'login' }, AUTH_PROBE_MS, `authenticate ${AUTH_PROBE_MS}ms 无响应（可能已进入交互式设备码流程）`);
      logFull('authenticate(login) 完整响应', authResp);
      results.unauthAuthenticate = authResp.error ? `错误: ${JSON.stringify(authResp.error)}` : `成功: ${JSON.stringify(authResp.result)}`;
    } catch (e) {
      results.unauthAuthenticate = e.message;
    }
    try {
      const bogusResp = await p4.requestWithTimeout('authenticate', { method_id: 'bogus' }, GENERIC_REQ_TIMEOUT_MS, 'authenticate(bogus) 无响应');
      results.unauthAuthenticateBogus = bogusResp.error ? `错误: ${JSON.stringify(bogusResp.error)}` : `意外成功: ${JSON.stringify(bogusResp.result)}`;
    } catch (e) {
      results.unauthAuthenticateBogus = `异常: ${e.message}`;
    }
    log.info(`项④ authenticate(login): ${results.unauthAuthenticate}；authenticate(bogus): ${results.unauthAuthenticateBogus}`);
    p4.kill('auth 探测完成');
    try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch { /* 同上 */ }
  } catch (e) {
    log.err(`auth 探测失败: ${e.stack || e.message}`);
  }

  // ==================== 收尾 ====================
  return finish(results.rawChunks > 0 ? 1 : 0);
}

// ---------- 14 项逐项摘要 ----------
function printSummary() {
  log.info('================== 探测摘要（14 项逐项结论） ==================');
  log.info(`分帧方式: ${results.framingUsed || '(未知)'}；无法解析的原始输出: ${results.rawChunks} 段`);
  log.info(`① load 非活跃会话回放（同进程）: ${results.loadReplaySameProc || '(未执行)'}；跨进程: ${results.loadReplayCrossProc || '(未执行)'}`);
  log.info(`② resume: ${results.resumeOk === null ? '(未执行)' : results.resumeOk ? `成功，结果键=${JSON.stringify(results.resumeResult)}` : `失败: ${results.resumeResult}`}；resume 通知=${(results.resumeNotifications || []).join(', ') || '(无)'} vs load 通知=${(results.loadReplayNotifications || []).join(', ') || '(无)'}`);
  log.info(`③ session/list: 能力公告=${results.capsSessionList}；首页 ${results.listCount} 条；字段=${JSON.stringify(results.listFields)}；nextCursor=${JSON.stringify(results.listNextCursor)}；翻页=${results.listPage2 || '(未执行)'}`);
  log.info(`④ 未登录: initialize=${JSON.stringify(results.unauthInitialize)}；session/new=${results.unauthSessionNew || '(未执行)'}；authenticate(login)=${results.unauthAuthenticate || '(未执行)'}；authenticate(bogus)=${results.unauthAuthenticateBogus || '(未执行)'}`);
  log.info(`⑤ configOptions 结构: ${results.configOptionsShape ? truncate(JSON.stringify(results.configOptionsShape), 800) : '(未获取)'}；set_model: ${results.setModelResult || '(未执行)'}`);
  log.info(`⑥ elicitation: ${results.elicitationCaptured ? `已捕获（尝试 ${results.elicitationAttempts} 次）: ${truncate(JSON.stringify(results.elicitationCaptured), 800)}` : `未触发（尝试 ${results.elicitationAttempts} 次）`}；permission 请求总数=${results.permissionRequests}`);
  log.info(`⑦ 推送形态: plan 样本 ${results.planSamples.length} 条；config_option_update 样本 ${results.configOptionUpdateSamples.length} 条；全部通知统计: ${summarizeNotifKinds()}`);
  log.info(`⑧ 图片: 能力声明=${results.imageCapability}；stopReason=${results.imagePromptStopReason || '(无)'}；error=${results.imagePromptError || '无'}；子进程崩溃=${results.imageChildCrashed}`);
  log.info(`⑨ goal: goal 类推送样本 ${results.goalUpdates.length} 条；口令回显=${results.goalMarkSeen}`);
  log.info(`⑩ hooks: UserPromptSubmit ${results.hooksFired === null ? '(未执行)' : results.hooksFired ? '已触发' : '未触发'}；payload=${results.hooksPayload || '(无)'}`);
  log.info(`⑪ set_mode: ${results.setModeResult || '(未执行)'}；set_config_option(mode): ${results.setModeViaConfigResult || '(未执行)'}`);
  log.info(`⑫ mode 切换推送 kind: set_mode=${results.modeUpdateKinds.setMode ? results.modeUpdateKinds.setMode.join(', ') || '(无)' : '(未执行)'}；set_config_option=${results.modeUpdateKinds.setConfigOption ? results.modeUpdateKinds.setConfigOption.join(', ') || '(无)' : '(未执行)'}（current_mode_update 出现=${[...notifStats.keys()].some((k) => /current_mode_update/.test(k))}）`);
  log.info(`⑬ embeddedContext: ${results.embeddedContextEcho || '(未执行)'}；mcpServers 转发观察 ${results.mcpForwardObserved.length} 条: ${results.mcpForwardObserved.slice(0, 5).join(' | ') || '(无)'}`);
  log.info(`⑭ available_commands 清单（${results.availableCommands ? results.availableCommands.length : 0} 条）: ${results.availableCommands ? results.availableCommands.join(', ') : '(未收到 available_commands_update)'}`);
  log.info(`其它 server→client 请求: ${results.otherServerRequests.length ? results.otherServerRequests.join(', ') : '(无)'}`);
}

function finish(code) {
  if (done) return code;
  done = true;
  clearTimeout(totalTimer);
  printSummary();
  log.info(`退出码 ${code}`);
  try {
    fs.writeFileSync(REPORT_PATH, reportLines.join('\n') + '\n', 'utf8');
    console.log(`报告已写入: ${REPORT_PATH}`);
  } catch (e) {
    console.error(`报告写入失败: ${e.message}`);
  }
  setTimeout(() => process.exit(code), 500);
  return code;
}

const totalTimer = setTimeout(() => {
  log.err(`总超时 ${TOTAL_TIMEOUT_MS}ms 到达，强制退出`);
  finish(2);
}, TOTAL_TIMEOUT_MS);

process.on('uncaughtException', (e) => {
  log.err(`uncaughtException: ${e.stack || e.message}`);
  finish(1);
});
process.on('unhandledRejection', (e) => {
  log.err(`unhandledRejection: ${(e && e.stack) || e}`);
});

main();
