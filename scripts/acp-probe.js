#!/usr/bin/env node
// Kimi Code Desktop — ACP（Agent Client Protocol）协议探测脚本（调研用，一次性）
// 目的：评估「阶段6 ACP 原生 UI」路线前，实测本机 `kimi acp` 的协议形态。
// 纯 Node 实现，无第三方依赖；只发起 initialize / session/new / session/prompt，
// 对 agent 的权限请求一律回 cancelled，不允许真正执行任何工具写操作。
// 用法：node scripts/acp-probe.js    （建议：node scripts/acp-probe.js > docs/acp-probe-output.txt 2>&1）
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
const RAW_DUMP_LIMIT = 300;          // 无法解析的原始输出截断长度
const PARAMS_DUMP_LIMIT = 500;       // 通知 params 摘要截断长度
const FULL_DUMP_LIMIT = 4000;        // server→client 请求完整结构的截断上限

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

// 统计信息：供结尾摘要与调研文档使用
const stats = {
  handshakeOk: false,
  framingUsed: null,
  sessionId: null,
  stopReason: null,
  notifications: new Map(), // 方法名 / update 种类 -> 条数
  permissionRequests: 0,
  otherServerRequests: [],  // 除 request_permission 外的 server→client 请求方法名
  agentText: '',            // agent_message_chunk 文本拼接
  sawProbeOk: false,
  rawChunks: 0,             // 无法按 JSON 解析的原始输出段数
};

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
  stats.notifications.set(kind, (stats.notifications.get(kind) || 0) + 1);
  log.recv(`通知 ${kind} ${truncate(JSON.stringify(msg.params), PARAMS_DUMP_LIMIT)}`);
  // 拼接 agent 文本，检查探针口令是否回来
  if (msg.method === 'session/update' && msg.params && msg.params.update) {
    const u = msg.params.update;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      stats.agentText += u.content.text || '';
      if (stats.agentText.includes('ACP-PROBE-OK')) stats.sawProbeOk = true;
    }
  }
}

// agent -> client 请求：记录完整结构后按协议回取消/拒绝，绝不放行工具执行
function handleServerRequest(msg) {
  log.recv(`server→client 请求 ${msg.method} (id=${msg.id})，完整结构: ${truncate(JSON.stringify(msg), FULL_DUMP_LIMIT)}`);
  if (msg.method === 'session/request_permission') {
    stats.permissionRequests++;
    // ACP 协议结构：{ outcome: { outcome: 'cancelled' } } 表示用户取消
    sendResult(msg.id, { outcome: { outcome: 'cancelled' } });
    log.info(`已按协议回应 request_permission -> outcome=cancelled（探测，不批准执行）`);
  } else {
    stats.otherServerRequests.push(msg.method);
    // 客户端声明无 fs/terminal 能力，其余请求回 JSON-RPC 方法未实现错误
    sendError(msg.id, -32601, 'acp-probe: capability not implemented');
    log.info(`已回 JSON-RPC 错误 -32601（未实现的能力: ${msg.method}）`);
  }
}

function handleRaw(text) {
  stats.rawChunks++;
  log.info(`[raw] 无法按 JSON 解析的输出: ${truncate(text, RAW_DUMP_LIMIT)}`);
}

// ---------- 收尾 ----------
function printSummary() {
  log.info('---------- 探测摘要 ----------');
  log.info(`分帧方式: ${stats.framingUsed || framing}（ndjson 首发，20s 无响应则重启试 lsp）`);
  log.info(`initialize 握手: ${stats.handshakeOk ? '成功' : '失败/未完成'}`);
  log.info(`sessionId: ${stats.sessionId || '(无)'}`);
  log.info(`prompt stopReason: ${stats.stopReason || '(无)'}`);
  log.info(`通知统计: ${stats.notifications.size ? '' : '(无通知)'}`);
  for (const [kind, count] of stats.notifications) {
    log.info(`  ${kind}: ${count} 条`);
  }
  log.info(`request_permission 请求: ${stats.permissionRequests} 次（均已回 cancelled）`);
  log.info(`其它 server→client 请求: ${stats.otherServerRequests.length ? stats.otherServerRequests.join(', ') : '(无)'}`);
  log.info(`无法解析的原始输出: ${stats.rawChunks} 段`);
  log.info(`agent 文本拼接: ${truncate(stats.agentText || '(空)', 600)}`);
  log.info(`探针口令 ACP-PROBE-OK 回显: ${stats.sawProbeOk ? '是' : '否'}`);
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
  log.info('ACP 探测开始');
  log.info(`Node ${process.version}, platform=${process.platform}, arch=${process.arch}`);

  cliPath = resolveCli();
  if (!cliPath) {
    log.err('两个候选路径均未找到 CLI，探测中止');
    return finish(1);
  }
  log.info(`选定 CLI: ${cliPath}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe-'));
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
    log.recv(`initialize 完整响应:\n${JSON.stringify(initResp, null, 2)}`);
    if (initResp.error) {
      log.err(`initialize 返回错误: ${JSON.stringify(initResp.error)}`);
      return finish(1);
    }
    stats.handshakeOk = true;

    // 阶段二：session/new
    const newResp = await sendRequest('session/new', { cwd: workDir, mcpServers: [] });
    log.recv(`session/new 完整响应:\n${JSON.stringify(newResp, null, 2)}`);
    if (newResp.error) {
      log.err(`session/new 返回错误: ${JSON.stringify(newResp.error)}`);
      return finish(1);
    }
    stats.sessionId = newResp.result && newResp.result.sessionId;
    if (!stats.sessionId) {
      log.err('session/new 响应中没有 sessionId');
      return finish(1);
    }

    // 阶段三：session/prompt，期间逐条打印 session/update 等通知
    const promptResp = await sendRequest('session/prompt', {
      sessionId: stats.sessionId,
      prompt: [{ type: 'text', text: PROMPT_TEXT }],
    });
    log.recv(`session/prompt 完整响应:\n${JSON.stringify(promptResp, null, 2)}`);
    if (promptResp.error) {
      log.err(`session/prompt 返回错误: ${JSON.stringify(promptResp.error)}`);
      return finish(1);
    }
    stats.stopReason = promptResp.result && promptResp.result.stopReason;

    // 留一点尾巴时间收残余通知
    await new Promise((r) => setTimeout(r, POST_PROMPT_GRACE_MS));
    return finish(0);
  } catch (e) {
    log.err(`主流程异常: ${e.stack || e.message}`);
    return finish(1);
  }
}

main();
