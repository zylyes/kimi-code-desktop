#!/usr/bin/env node
// Kimi Code Desktop — ACP（Agent Client Protocol）第四次协议探测脚本（调研用，一次性）
// 目的：为 v0.13.0「图片输入」实测本机 `kimi acp` 对 session/prompt 图片块的协议形态：
//   本地断言（不依赖 CLI）：acp-client.js 的 prompt(text, images) 校验逻辑——
//     非法 mimeType / 解码后超 10MB / 第 5 张图 三种调用必须 throw；
//     另附正例：有图时 prompt 字段为 [图片块…, 文本块]，无图时保持单 text 块。
//   真实探测（需本机装有 kimi CLI）：initialize（确认 promptCapabilities.image）
//     → session/new → 发一条带 1 张内嵌 1x1 PNG + 文本的 prompt，
//     记录 stopReason 与全部 session/update 通知统计。
// 纯 Node 实现，无第三方依赖；对 agent 的权限请求一律回 cancelled，不允许真正执行任何工具写操作。
// 日志同时写 stdout 与 docs/acp-probe4-output.txt（格式与前三次探测一致）。
// 用法：node scripts/acp-probe4.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AcpClient } = require('../acp-client.js');

// ---------- 常量 ----------
const TOTAL_TIMEOUT_MS = 120_000;        // 总超时：到点无条件 kill 子进程并退出
const FRAMING_PROBE_MS = 20_000;         // ndjson 首发 initialize 的响应窗口，超时改试 LSP 分帧
const SESSION_NEW_TIMEOUT_MS = 30_000;   // session/new 响应窗口
const PROMPT_TIMEOUT_MS = 45_000;        // 图文 prompt 的最长等待
const RAW_DUMP_LIMIT = 300;              // 无法解析的原始输出截断长度
const PARAMS_DUMP_LIMIT = 500;           // 通知 params 摘要截断长度
const FULL_DUMP_LIMIT = 4000;            // server→client 请求完整结构的截断上限
const RESP_DUMP_LIMIT = 6000;            // 响应完整结构的截断上限

const PROMPT_TEXT = 'The attached image is a tiny 1x1 test PNG. Reply with exactly: ACP-PROBE4-MARK';
const PROMPT_MARK = 'ACP-PROBE4-MARK';

// 内嵌 1x1 PNG（70 字节，8bit RGBA；已用 PNG 魔数自校验，见本地断言用例0）
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const REPORT_PATH = path.join(__dirname, '..', 'docs', 'acp-probe4-output.txt');

// initialize 请求参数：按 ACP 协议声明客户端不具备 fs / terminal 能力
const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

// ---------- 时间线日志（同时 tee 到 stdout 与报告文件缓冲） ----------
// 格式：[+000123ms] 方向 内容；方向：>>>=发送 <<< =接收 ###=本地事件 !!!=异常
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

// 完整结构的日志输出（带截断保护）
function logFull(label, obj, limit = RESP_DUMP_LIMIT) {
  log.recv(`${label}:\n${truncate(JSON.stringify(obj, null, 2), limit)}`);
}

// ---------- CLI 路径解析（同 acp-probe3.js：两个候选安装路径） ----------
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

// ---------- 消息分帧（ndjson / Content-Length 两种都实现，照搬前三次探测） ----------
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

// ---------- 本地断言（不依赖 CLI，独立可过） ----------
// 用 AcpClient 直接调 prompt(text, images) 验证 v0.13.0 的图片校验与载荷形态。
// prompt 是 async 函数，非法输入表现为 Promise reject（Error），这里统一 await 捕获。
const assertionResults = []; // { label, ok, detail }

function recordAssertion(label, ok, detail) {
  assertionResults.push({ label, ok, detail });
  log.info(`本地断言 [${ok ? '通过' : '失败'}] ${label}${detail ? ` —— ${detail}` : ''}`);
}

// 期望调用 throw（reject）；keyword 非空时要求异常信息包含该片段
async function expectThrow(label, keyword, fn) {
  try {
    await fn();
    recordAssertion(label, false, '未抛异常');
    return false;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const ok = e instanceof Error && (!keyword || msg.includes(keyword));
    recordAssertion(label, ok, ok ? `已按预期抛出: ${msg}` : `异常不含「${keyword}」: ${msg}`);
    return ok;
  }
}

// 新建一个伪会话客户端：sessionId 伪造、child.stdin 替换为捕获器，从而无需真实子进程
// 即可拿到 _write 实际写出的 ndjson 帧；用毕 dispose 收尾（挂起的 prompt 按 dispose 拒绝）
function newCaptureClient() {
  const client = new AcpClient({ cliPath: 'unused-for-local-assert' });
  client.sessionId = 'fake-session-for-assert';
  const writes = [];
  client.child = { stdin: { write: (buf) => writes.push(buf) } };
  client.childExited = false;
  return { client, writes };
}

// 调用 prompt 并捕获写出的 JSON-RPC 帧（解析为对象返回）
async function capturePromptFrame(text, images) {
  const { client, writes } = newCaptureClient();
  const p = client.prompt(text, images);
  p.catch(() => {}); // dispose 时该 promise 被 reject，兜底避免 unhandledRejection
  await new Promise((r) => setImmediate(r)); // 让 async 函数体执行到 _write
  client.dispose('本地断言收尾');
  await p.catch(() => {});
  if (!writes.length) throw new Error('未捕获到任何 stdin 写入');
  return JSON.parse(writes[writes.length - 1].toString('utf8').trim());
}

async function runLocalAssertions() {
  log.info('========== 本地断言: prompt(text, images) 校验（不依赖 CLI） ==========');

  // 用例0：内嵌 PNG 自校验（魔数 + 非空），保证后续真实探测的图片数据本身有效
  const pngBuf = Buffer.from(PNG_BASE64, 'base64');
  recordAssertion(
    '内嵌 1x1 PNG base64 可解码且带 PNG 魔数',
    pngBuf.length > 8 && pngBuf.subarray(0, 8).equals(PNG_MAGIC),
    `解码后 ${pngBuf.length} 字节`
  );

  // 用例1：非法 mimeType 必须 throw
  await expectThrow('非法 mimeType(image/bmp) 必须 throw', 'mimeType', () => {
    const { client } = newCaptureClient();
    const p = client.prompt('hi', [{ mimeType: 'image/bmp', data: PNG_BASE64 }]);
    client.dispose('本地断言收尾');
    return p;
  });

  // 用例2：解码后超 10MB 必须 throw
  const bigBase64 = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61).toString('base64');
  await expectThrow('单张解码后超 10MB 必须 throw', '10MB', () => {
    const { client } = newCaptureClient();
    const p = client.prompt('hi', [{ mimeType: 'image/png', data: bigBase64 }]);
    client.dispose('本地断言收尾');
    return p;
  });

  // 用例3：第 5 张图必须 throw（上限 4 张）
  const fiveImages = Array.from({ length: 5 }, () => ({ mimeType: 'image/png', data: PNG_BASE64 }));
  await expectThrow('一次 5 张图片必须 throw', '最多', () => {
    const { client } = newCaptureClient();
    const p = client.prompt('hi', fiveImages);
    client.dispose('本地断言收尾');
    return p;
  });

  // 用例4（正例）：2 张合法图片通过校验，写出的 prompt 字段为 [图片块×2, 文本块]
  try {
    const imgs = [
      { mimeType: 'image/png', data: PNG_BASE64 },
      { mimeType: 'image/jpeg', data: PNG_BASE64 },
    ];
    const frame = await capturePromptFrame('你好', imgs);
    const blocks = frame.params && frame.params.prompt;
    const ok =
      frame.method === 'session/prompt' &&
      Array.isArray(blocks) &&
      blocks.length === 3 &&
      blocks[0].type === 'image' && blocks[0].data === PNG_BASE64 && blocks[0].mimeType === 'image/png' &&
      blocks[1].type === 'image' && blocks[1].mimeType === 'image/jpeg' &&
      blocks[2].type === 'text' && blocks[2].text === '你好';
    recordAssertion(
      '有图时 prompt 字段为 [{type:image,data,mimeType}…, {type:text,text}]',
      ok,
      truncate(JSON.stringify(frame.params), PARAMS_DUMP_LIMIT)
    );
  } catch (e) {
    recordAssertion('有图时 prompt 字段为 [{type:image,data,mimeType}…, {type:text,text}]', false, e.message);
  }

  // 用例5（正例）：无 images 时保持单 text 块（与 v0.12.0 现状完全一致）
  try {
    const frame = await capturePromptFrame('纯文本');
    const blocks = frame.params && frame.params.prompt;
    const ok =
      Array.isArray(blocks) &&
      blocks.length === 1 &&
      blocks[0].type === 'text' &&
      blocks[0].text === '纯文本';
    recordAssertion('无图时 prompt 字段保持单 text 块', ok, truncate(JSON.stringify(blocks), PARAMS_DUMP_LIMIT));
  } catch (e) {
    recordAssertion('无图时 prompt 字段保持单 text 块', false, e.message);
  }

  const failed = assertionResults.filter((r) => !r.ok);
  log.info(`本地断言合计 ${assertionResults.length} 项：通过 ${assertionResults.length - failed.length} 项，失败 ${failed.length} 项`);
  return failed.length === 0;
}

// ---------- 探测状态（真实 spawn 部分） ----------
let cliPath = null;
let child = null;
let framing = 'ndjson';
let parser = null;
let nextId = 1;
let childExited = false;
let done = false;
const pending = new Map(); // id -> { method, resolve, reject, sentAt }

// 通知统计：kind -> count / 样本（最多2条）/ 首次出现次序
const notifStats = new Map();
const notifSamples = new Map();
const notifKindOrder = [];

// 探测结果：供结尾摘要与调研文档使用
const results = {
  localAssertionsOk: false,
  handshakeOk: false,
  framingUsed: null,
  imageCapability: null, // initialize 响应里 promptCapabilities.image 的实测值
  sessionId: null,
  stopReason: null,
  promptError: null,
  sawMark: false,
  agentText: '',
  permissionRequests: 0,
  otherServerRequests: [],
  rawChunks: 0,
};

function recordNotification(kind, msg) {
  if (!notifStats.has(kind)) notifKindOrder.push(kind);
  notifStats.set(kind, (notifStats.get(kind) || 0) + 1);
  const samples = notifSamples.get(kind) || [];
  if (samples.length < 2) {
    samples.push(JSON.stringify(msg.params));
    notifSamples.set(kind, samples);
  }
}

function summarizeNotifKinds() {
  if (!notifStats.size) return '(无)';
  return [...notifStats.entries()].map(([k, c]) => `${k}×${c}`).join(', ');
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
  // 图片 base64 体积大，发送日志单独截断，避免刷屏
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
  log.recv(`通知 ${kind} ${truncate(JSON.stringify(msg.params), PARAMS_DUMP_LIMIT)}`);
  // 拼接 agent 文本，检查探针口令是否回来
  if (msg.method === 'session/update' && msg.params && msg.params.update) {
    const u = msg.params.update;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      results.agentText += u.content.text || '';
      if (results.agentText.includes(PROMPT_MARK)) results.sawMark = true;
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
    sendError(msg.id, -32601, 'acp-probe4: capability not implemented');
    log.info(`已回 JSON-RPC 错误 -32601（未实现的能力: ${msg.method}）`);
  }
}

function handleRaw(text) {
  results.rawChunks++;
  log.info(`[raw] 无法按 JSON 解析的输出: ${truncate(text, RAW_DUMP_LIMIT)}`);
}

// ---------- 收尾 ----------
function printSummary() {
  log.info('---------- 探测摘要 ----------');
  log.info(`本地断言: ${results.localAssertionsOk ? `全部通过（${assertionResults.length} 项）` : '存在失败项（见上）'}`);
  log.info(`分帧方式: ${results.framingUsed || framing}（ndjson 首发，20s 无响应则重启试 lsp）`);
  log.info(`initialize 握手: ${results.handshakeOk ? '成功' : '失败/未完成'}`);
  log.info(`promptCapabilities.image: ${results.imageCapability === null ? '(未获取)' : results.imageCapability}`);
  log.info(`sessionId: ${results.sessionId || '(无)'}`);
  log.info(`图文 prompt stopReason: ${results.stopReason || '(无)'}${results.promptError ? `; 错误: ${results.promptError}` : ''}`);
  log.info(`口令(${PROMPT_MARK})回显: ${results.sawMark ? '是' : '否'}`);
  log.info(`agent 文本累计 ${results.agentText.length} 字符: ${truncate(results.agentText, RAW_DUMP_LIMIT)}`);
  log.info(`session/update 通知统计: ${summarizeNotifKinds()}`);
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
  // 报告落盘：与 stdout 同内容；写失败不掩盖原退出码
  try {
    fs.writeFileSync(REPORT_PATH, reportLines.join('\n') + '\n', 'utf8');
    console.log(`报告已写入: ${REPORT_PATH}`);
  } catch (e) {
    console.error(`报告写入失败: ${e.message}`);
  }
  // 给 kill 与 stdout 冲刷留一点时间再退出
  setTimeout(() => process.exit(code), 500);
}

const totalTimer = setTimeout(() => {
  log.err(`总超时 ${TOTAL_TIMEOUT_MS}ms 到达，强制 kill 并退出`);
  finish(2);
}, TOTAL_TIMEOUT_MS);

// 任何未捕获异常只记录不 crash（沿用既有 probe 约定）
process.on('uncaughtException', (e) => {
  log.err(`uncaughtException: ${e.stack || e.message}`);
  finish(1);
});
process.on('unhandledRejection', (e) => {
  log.err(`unhandledRejection: ${(e && e.stack) || e}`);
});

// ---------- 主流程 ----------
async function main() {
  log.info('ACP 第四次探测开始（图片输入：本地校验断言 + 图文 prompt 实测）');
  log.info(`Node ${process.version}, platform=${process.platform}, arch=${process.arch}`);

  // ==================== 本地断言（不依赖 CLI，独立可过） ====================
  results.localAssertionsOk = await runLocalAssertions();
  if (!results.localAssertionsOk) {
    log.err('本地断言存在失败项，真实探测中止（prompt 图片校验不可信）');
    return finish(1);
  }

  // ==================== 真实探测（需本机 kimi CLI） ====================
  cliPath = resolveCli();
  if (!cliPath) {
    log.err('两个候选路径均未找到 CLI，真实探测中止（本地断言部分已通过，与 CLI 无关）');
    return finish(1);
  }
  log.info(`选定 CLI: ${cliPath}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe4-'));
  log.info(`session/new 工作目录(临时): ${workDir}`);

  // initialize：ndjson 分帧首发；20s 无响应则 kill 重启改试 LSP 分帧（沿用前三次探测结论，正常不会触发回退）
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
  // 记录 agent 声明的图片能力，供契约核对
  const caps = initResp.result && initResp.result.agentCapabilities;
  results.imageCapability = caps && caps.promptCapabilities ? caps.promptCapabilities.image === true : null;
  log.info(`agent 声明 promptCapabilities.image = ${results.imageCapability}`);
  if (results.imageCapability !== true) {
    log.err('agent 未声明 image 能力，图文 prompt 可能被拒绝；仍继续实测以记录真实行为');
  }

  // session/new
  try {
    const newResp = await requestWithTimeout(
      'session/new',
      { cwd: workDir, mcpServers: [] },
      SESSION_NEW_TIMEOUT_MS,
      `session/new ${SESSION_NEW_TIMEOUT_MS}ms 无响应`
    );
    logFull('session/new 完整响应', newResp);
    if (newResp.error) throw new Error(`session/new 错误: ${JSON.stringify(newResp.error)}`);
    results.sessionId = newResp.result && newResp.result.sessionId;
    if (!results.sessionId) throw new Error('session/new 响应中没有 sessionId');
  } catch (e) {
    log.err(`session/new 失败: ${e.stack || e.message}`);
    return finish(1);
  }

  // 图文 prompt：1 张内嵌 1x1 PNG + 文本（契约形态 [{type:image,data,mimeType}, {type:text,text}]）
  log.info(`发送图文 prompt：图片 1 张（image/png, base64 解码后 ${Buffer.from(PNG_BASE64, 'base64').length} 字节）+ 文本「${PROMPT_TEXT}」`);
  try {
    const promptResp = await requestWithTimeout(
      'session/prompt',
      {
        sessionId: results.sessionId,
        prompt: [
          { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
          { type: 'text', text: PROMPT_TEXT },
        ],
      },
      PROMPT_TIMEOUT_MS,
      `图文 prompt ${PROMPT_TIMEOUT_MS}ms 无响应`
    );
    logFull('session/prompt 完整响应', promptResp);
    if (promptResp.error) {
      results.promptError = JSON.stringify(promptResp.error);
      log.err(`session/prompt 返回错误: ${results.promptError}`);
    } else {
      results.stopReason = promptResp.result && promptResp.result.stopReason;
    }
    await sleep(1000); // 收残余通知
  } catch (e) {
    results.promptError = e.message;
    log.err(`图文 prompt 失败: ${e.stack || e.message}`);
  }

  return finish(results.stopReason ? 0 : 1);
}

main();
