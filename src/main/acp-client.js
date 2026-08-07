// Kimi Code Desktop — ACP（Agent Client Protocol）客户端模块
// 由 ACP 探测脚本产品化而来：与 `kimi acp` 子进程通过 stdio
// JSON-RPC 2.0 通信，ndjson 分帧首发 initialize，20s 无响应则改试 Content-Length(LSP) 分帧。
// 纯 Node CommonJS，无第三方依赖，不 require electron（供 Electron 主进程与单元测试共用）。
// 权限决策：未设 handler 时对 agent 的权限请求一律先 emit('permission') 再自动回
// cancelled，绝不放行工具执行（只读安全基线）；setPermissionHandler(fn) 后由
// fn(params) 异步决策，结构非法 / optionId 越界 / 抛异常 / 10 分钟防御性超时一律降级
// cancelled，每个请求只响应一次，dispose 时挂起决策按 cancelled 收尾。
// 其余 server→client 请求回 JSON-RPC 错误 -32601。
// 与 probe 的差异：不 process.exit、不设全局兜底超时，任何内部异常只通过
// logFn / 'error' 事件暴露（'error' 无监听时降级为日志，避免 EventEmitter throw）。
// 会话恢复 / 配置 / 取消（第三次探测实测）：
// session/load 恢复既有会话（result 仅含 configOptions，无 sessionId 回显）；
// session/set_config_option 切换配置项（value 为纯字符串，失败为 JSON-RPC 错误）；
// session/cancel 为无 id 通知，发出后进行中的 prompt 以 { stopReason: 'cancelled' } 返回。
// 图片输入（第四次探测实测）：prompt(text, images) 的
// images 可选，元素 { mimeType, data(base64) }，mimeType 白名单 / 解码后 ≤10MB / ≤4 张；
// 有图时 session/prompt 的 prompt 字段为 [{ type:'image', data, mimeType }…, { type:'text', text }]。
// 第五次探测补齐（CLI 0.29.0 实测）：
// session/list 枚举磁盘会话（字段 sessionId/cwd/title/updatedAt，当前单页全量、cursor 透传预留）；
// session/resume 轻量恢复（result 仅 configOptions，不回放历史，与 load 二选一）；
// session/set_model / session/set_mode（参数名 modelId/modeId，0.29.0 报错文案不可信——
// "Already in plan mode" 系状态错乱误报，调用方应以 config_option_update 推送为准）；
// authenticate({ methodId })（camelCase，官方文档 method_id 系笔误；token 缺失返回 -32000）；
// 任何请求收到 -32000（Authentication required）时除 reject 外另发 'authRequired' 事件，
// 供主进程引导登录（authMethods 的 _meta['terminal-auth'] 给出 kimi login 完整命令行）。
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// ---------- 常量 ----------
const FRAMING_PROBE_MS = 20_000; // ndjson 首发 initialize 的响应窗口，超时改试 LSP 分帧
const FRAMING_RETRY_DELAY_MS = 500; // kill 旧进程后等它退出的间隔
const SESSION_NEW_TIMEOUT_MS = 30_000; // session/new / load / resume 超时（prompt 不设固定超时，LLM 耗时长）
const SET_CONFIG_TIMEOUT_MS = 15_000; // session/set_config_option 超时
const GENERIC_REQ_TIMEOUT_MS = 20_000; // session/list / set_model / set_mode / authenticate 等通用请求超时
const PERMISSION_DECISION_TIMEOUT_MS = 600_000; // 权限决策的防御性超时（10 分钟），超时按 cancelled 收尾
const LOG_DUMP_LIMIT = 300; // 日志里消息摘要的截断长度
const MAX_PROMPT_IMAGES = 4; // 单次 prompt 最多附带的图片张数
const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024; // 单张图片 base64 解码后的字节上限（10MB）
const PROMPT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']); // 图片 MIME 白名单

// initialize 请求参数：按 ACP 协议声明客户端不具备 fs / terminal 能力
const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

function truncate(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}…(共${s.length}字符)` : s;
}

// ---------- 消息分帧（ndjson / Content-Length 两种都实现，照搬 probe） ----------
function encodeMessage(msg, framing) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (framing === 'lsp') {
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
  }
  return Buffer.concat([body, Buffer.from('\n')]);
}

// 按字节缓冲的流式分帧解析器；解析不出的内容走 onRaw 上报，便于判断协议形态
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

// ---------- ACP 客户端 ----------
// 事件一览：
//   'update'      (update)              session/update 通知里的 update 对象
//   'notification'(method, params)      其它 server→client 通知
//   'permission'  (params)              session/request_permission（日志/通知用；决策见 setPermissionHandler）
//   'authRequired'({ method, error })   任意请求收到 -32000 Authentication required（第五次探测实测形态；
//                                       reject 照常发生，本事件供主进程引导登录，同一次失败只补发一次）
//   'stderr'      (text)                子进程 stderr 数据
//   'raw'         (text)                stdout 中无法按 JSON 解析的段
//   'exit'        (code, signal)        子进程退出或 spawn 失败（分帧切换重启时不发）
//   'error'       (err)                 内部异常（无监听时只记日志）
class AcpClient extends EventEmitter {
  constructor({ cliPath, cwd, logFn } = {}) {
    super();
    if (!cliPath) throw new Error('AcpClient: 缺少 cliPath');
    this.cliPath = cliPath;
    this.cwd = cwd || process.cwd();
    this.logFn = typeof logFn === 'function' ? logFn : () => {};
    this.child = null;
    this.framing = 'ndjson';
    this.parser = null;
    this.nextId = 1;
    this.childExited = false;
    this.started = false;
    this.disposed = false;
    this.sessionId = null;
    this._restarting = false; // 分帧切换重启期间不对外发 'exit'
    this._exitEmitted = false; // 每个子进程生命周期只发一次 'exit'
    this.pending = new Map(); // id -> { method, resolve, reject, sentAt, timer }
    this._permissionHandler = null; // setPermissionHandler 注入的异步权限决策回调
    this._pendingPermissions = new Map(); // requestId -> { settleCancelled }，挂起的权限决策
  }

  _log(msg) {
    try {
      this.logFn(msg);
    } catch {
      /* 日志回调异常不向外抛 */
    }
  }

  // EventEmitter 的 'error' 事件无监听时会 throw，这里统一兜底：
  // 有监听发事件，监听器自身抛异常也只记日志，绝不让进程 crash
  _safeEmit(...args) {
    try {
      if (args[0] === 'error' && this.listenerCount('error') === 0) {
        const e = args[1];
        this._log(`[error 事件无监听] ${e && e.message ? e.message : e}`);
        return;
      }
      this.emit(...args);
    } catch (e) {
      this._log(`事件监听器抛异常（${String(args[0])}）: ${e && e.message ? e.message : e}`);
    }
  }

  _emitExit(code, signal) {
    if (this._exitEmitted || this._restarting) return;
    this._exitEmitted = true;
    this._safeEmit('exit', code, signal);
  }

  // ---------- 子进程管理 ----------
  _spawn(mode) {
    this.framing = mode;
    this.childExited = false;
    this._exitEmitted = false;
    this._log(`以 ${mode} 分帧启动子进程: ${this.cliPath} acp`);
    const child = spawn(this.cliPath, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.parser = new FrameParser(
      mode,
      (m) => this._onMessage(m),
      (t) => this._onRaw(t)
    );
    child.on('error', (e) => {
      this._log(`子进程 error 事件: ${e.message}`);
      this.childExited = true;
      this._rejectAllPending(new Error(`spawn 失败: ${e.message}`));
      this._emitExit(null, null);
    });
    child.on('exit', (code, signal) => {
      this._log(`子进程退出: code=${code} signal=${signal}`);
      this.childExited = true;
      this._rejectAllPending(new Error(`子进程已退出 code=${code}`));
      this._emitExit(code, signal);
    });
    child.stdout.on('data', (chunk) => {
      try {
        this.parser.push(chunk);
      } catch (e) {
        this._safeEmit('error', new Error(`分帧解析异常: ${e.message}`));
      }
    });
    child.stderr.on('data', (chunk) => {
      this._safeEmit('stderr', chunk.toString('utf8'));
    });
    child.stdin.on('error', (e) => this._log(`stdin 写入异常: ${e.message}`));
  }

  _killChild(reason) {
    if (this.child && !this.childExited) {
      this._log(`kill 子进程 pid=${this.child.pid}（${reason}）`);
      try {
        this.child.kill();
      } catch (e) {
        this._log(`kill 失败: ${e.message}`);
      }
    }
  }

  _rejectAllPending(err) {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  // ---------- JSON-RPC 收发 ----------
  _write(obj) {
    if (!this.child || this.childExited || !this.child.stdin) throw new Error('子进程不可用');
    this.child.stdin.write(encodeMessage(obj, this.framing));
  }

  // 发送请求并按 id 配对响应；timeoutMs 为空则不设超时（供 prompt 使用）
  _request(method, params, timeoutMs) {
    if (this.disposed) return Promise.reject(new Error('AcpClient 已 dispose'));
    if (!this.child) return Promise.reject(new Error('子进程未启动（先调用 start）'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { method, resolve, reject, sentAt: Date.now(), timer: null };
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          const err = new Error(`${method} 请求 ${timeoutMs}ms 内无响应`);
          err.acpTimeout = true;
          reject(err);
        }, timeoutMs);
        if (entry.timer.unref) entry.timer.unref(); // 超时不应拖着进程不退出
      }
      this.pending.set(id, entry);
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _sendResult(id, result) {
    try {
      this._write({ jsonrpc: '2.0', id, result });
    } catch (e) {
      this._safeEmit('error', e);
    }
  }

  _sendError(id, code, message) {
    try {
      this._write({ jsonrpc: '2.0', id, error: { code, message } });
    } catch (e) {
      this._safeEmit('error', e);
    }
  }

  // ---------- 消息处理（分类逻辑照搬 probe 的 handleMessage） ----------
  _onMessage(msg) {
    try {
      if (msg.method && msg.id !== undefined && msg.id !== null) {
        this._onServerRequest(msg); // agent -> client 请求（如 session/request_permission）
      } else if (msg.method) {
        this._onNotification(msg); // agent -> client 通知（如 session/update）
      } else if (msg.id !== undefined && msg.id !== null) {
        this._onResponse(msg); // 对 client 请求的响应
      } else {
        this._log(`无法归类的消息: ${truncate(JSON.stringify(msg), LOG_DUMP_LIMIT)}`);
      }
    } catch (e) {
      this._safeEmit('error', e);
    }
  }

  _onResponse(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      this._log(`孤儿响应 id=${msg.id}，忽略: ${truncate(JSON.stringify(msg), LOG_DUMP_LIMIT)}`);
      return;
    }
    this.pending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.error) {
      const err = new Error(`${entry.method} 返回错误: ${msg.error.message || JSON.stringify(msg.error)}`);
      err.code = msg.error.code;
      // -32000 Authentication required（第五次探测实测）：reject 之外补发 authRequired 事件，
      // 主进程据此引导登录（terminal 型 authMethods，需跑 kimi login 设备码流程）
      if (msg.error.code === -32000) {
        this._safeEmit('authRequired', { method: entry.method, error: msg.error });
      }
      entry.reject(err);
    } else {
      entry.resolve(msg.result);
    }
  }

  _onNotification(msg) {
    if (msg.method === 'session/update') {
      this._safeEmit('update', msg.params && msg.params.update);
    } else {
      this._safeEmit('notification', msg.method, msg.params);
    }
  }

  // agent -> client 请求：权限请求走 _onPermissionRequest（先 emit('permission') 再决策）；
  // 客户端声明无 fs/terminal 能力，其余请求回方法未实现错误
  _onServerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      this._onPermissionRequest(msg);
    } else {
      this._sendError(msg.id, -32601, 'acp-client: capability not implemented');
    }
  }

  // 权限决策：未设 handler 维持只读安全基线（一律自动 cancelled，绝不放行工具执行）；
  // 设了 handler 则异步决策，结构非法 / optionId 越界 / 抛异常 / 10 分钟防御性超时一律
  // 降级 cancelled。settled 闭包保证每个请求只响应一次；挂起决策登记在
  // _pendingPermissions，dispose 时统一按 cancelled 收尾
  _onPermissionRequest(msg) {
    const params = msg.params || {};
    this._safeEmit('permission', params); // 日志/通知用，无论有无 handler 都 emit
    const cancelled = { outcome: { outcome: 'cancelled' } }; // ACP 协议结构：用户取消
    if (typeof this._permissionHandler !== 'function') {
      this._sendResult(msg.id, cancelled);
      return;
    }
    let settled = false;
    let timer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      this._pendingPermissions.delete(msg.id);
      this._sendResult(msg.id, result);
    };
    this._pendingPermissions.set(msg.id, { settleCancelled: () => settle(cancelled) });
    // 防御性超时：handler 永不返回时按 cancelled 收尾，不让请求挂死
    timer = setTimeout(() => {
      this._log(`权限决策 ${PERMISSION_DECISION_TIMEOUT_MS}ms 内未返回，按 cancelled 收尾`);
      settle(cancelled);
    }, PERMISSION_DECISION_TIMEOUT_MS);
    if (timer.unref) timer.unref(); // 超时不应拖着进程不退出
    Promise.resolve()
      .then(() => this._permissionHandler(params))
      .then((result) => settle(this._normalizePermissionOutcome(result, params)))
      .catch((e) => {
        this._log(`权限决策回调抛异常，按 cancelled 收尾: ${e && e.message ? e.message : e}`);
        settle(cancelled);
      });
  }

  // 校验 handler 的决策结构：只认 { outcome: { outcome: 'selected', optionId } } 与
  // { outcome: { outcome: 'cancelled' } }；selected 的 optionId 必须 ∈ params.options
  // （无 options 或不在其中一律降级 cancelled）
  _normalizePermissionOutcome(result, params) {
    const cancelled = { outcome: { outcome: 'cancelled' } };
    const outcome = result && result.outcome;
    if (!outcome || typeof outcome !== 'object') return cancelled;
    if (outcome.outcome === 'cancelled') return cancelled;
    if (outcome.outcome !== 'selected') return cancelled;
    const options = Array.isArray(params.options) ? params.options : [];
    const hit = options.some((o) => o && o.optionId === outcome.optionId);
    if (!hit) {
      this._log(`权限决策 optionId 不在 options 内，降级 cancelled: ${truncate(JSON.stringify(outcome.optionId), LOG_DUMP_LIMIT)}`);
      return cancelled;
    }
    return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
  }

  _onRaw(text) {
    this._safeEmit('raw', text);
  }

  // ---------- 对外 API ----------
  // 启动子进程并完成 initialize 握手；resolve initialize 的 result
  // （含 agentInfo / agentCapabilities / authMethods）
  async start() {
    if (this.disposed) throw new Error('AcpClient 已 dispose');
    if (this.started) throw new Error('AcpClient 已启动');
    this.started = true;
    // 阶段一：ndjson 分帧首发 initialize；20s 无响应则 kill 重启改试 LSP 分帧
    this._spawn('ndjson');
    try {
      return await this._request('initialize', INIT_PARAMS, FRAMING_PROBE_MS);
    } catch (e) {
      // 只有「无响应超时」才换分帧重试；协议错误、子进程退出等直接上抛
      if (!e.acpTimeout || this.disposed) throw e;
      this._log(`ndjson 分帧 initialize ${FRAMING_PROBE_MS}ms 无响应，kill 子进程并以 Content-Length(LSP) 分帧重启`);
      this._restarting = true; // 切换期间的 exit 是内部行为，不对外发 'exit'
      this._killChild('分帧探测切换');
      await new Promise((r) => setTimeout(r, FRAMING_RETRY_DELAY_MS)); // 等旧进程退出
      this._restarting = false;
      if (this.disposed) throw new Error('AcpClient 已 dispose');
      this._spawn('lsp');
      // LSP 重试同样给 20s 窗口，避免 start() 无限挂起
      return await this._request('initialize', INIT_PARAMS, FRAMING_PROBE_MS);
    }
  }

  // 建立会话；resolve session/new 的 result（{ sessionId, configOptions }）
  async newSession() {
    const result = await this._request('session/new', { cwd: this.cwd, mcpServers: [] }, SESSION_NEW_TIMEOUT_MS);
    this.sessionId = result && result.sessionId;
    return result;
  }

  // 恢复既有会话；resolve session/load 的 result（仅含 configOptions，无 sessionId 回显），
  // 成功后把入参 sessionId 记为当前会话（与 newSession 同语义：覆盖旧值）；错误上抛
  async loadSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('loadSession: sessionId 必须是非空字符串');
    const result = await this._request('session/load', { sessionId, cwd: this.cwd, mcpServers: [] }, SESSION_NEW_TIMEOUT_MS);
    this.sessionId = sessionId;
    return result;
  }

  // 轻量恢复既有会话（第五次探测实测：与 load 的 result 结构相同、仅 configOptions，
  // 不回放历史，仅推 available_commands_update）；适合历史已由本地渲染的恢复场景。
  // 成功后把入参 sessionId 记为当前会话；错误上抛
  async resumeSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('resumeSession: sessionId 必须是非空字符串');
    const result = await this._request('session/resume', { sessionId, cwd: this.cwd, mcpServers: [] }, SESSION_NEW_TIMEOUT_MS);
    this.sessionId = sessionId;
    return result;
  }

  // 枚举磁盘会话（第五次探测实测：字段 sessionId/cwd/title/updatedAt，0.29.0 单页全量、
  // 未触发 nextCursor；cursor 透传预留分页）。resolve { sessions, nextCursor }，
  // sessions 恒为数组（异常响应上抛）；cursor 为非空字符串时才随参数下发
  async listSessions(cursor) {
    const params = {};
    if (typeof cursor === 'string' && cursor && cursor.length <= 500) params.cursor = cursor;
    const result = await this._request('session/list', params, GENERIC_REQ_TIMEOUT_MS);
    const sessions = result && Array.isArray(result.sessions) ? result.sessions : [];
    const nextCursor = result && typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    return { sessions, nextCursor };
  }

  // 发送用户输入；不设固定超时（LLM 耗时长），resolve result（{ stopReason }）。
  // images 可选：元素 { mimeType, data(base64) }；防御性校验白名单 mimeType、
  // data 非空且可 base64 解码、解码后 ≤10MB、单次 ≤4 张，任一非法直接 throw（中文报错）。
  // 有图时 prompt 字段为 [{ type:'image', data, mimeType }…, { type:'text', text }]，
  // 无图（含空数组）保持单 text 块，与原行为完全一致
  async prompt(text, images) {
    if (!this.sessionId) throw new Error('尚未建立会话（先调用 newSession）');
    const blocks = [];
    if (images !== undefined && images !== null) {
      if (!Array.isArray(images)) throw new Error('prompt: images 必须是数组（元素为 { mimeType, data }）');
      if (images.length > MAX_PROMPT_IMAGES) throw new Error(`prompt: 一次最多附带 ${MAX_PROMPT_IMAGES} 张图片（收到 ${images.length} 张）`);
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img || typeof img !== 'object') throw new Error(`prompt: 第 ${i + 1} 张图片必须是 { mimeType, data } 对象`);
        if (!PROMPT_IMAGE_MIME_TYPES.has(img.mimeType)) {
          throw new Error(`prompt: 第 ${i + 1} 张图片 mimeType 非法: ${truncate(img.mimeType, 50)}（仅支持 image/png、image/jpeg、image/gif、image/webp）`);
        }
        if (typeof img.data !== 'string' || !img.data) throw new Error(`prompt: 第 ${i + 1} 张图片 data 必须是非空 base64 字符串`);
        const decoded = Buffer.from(img.data, 'base64');
        if (!decoded.length) throw new Error(`prompt: 第 ${i + 1} 张图片 data 无法按 base64 解码`);
        if (decoded.length > MAX_PROMPT_IMAGE_BYTES) {
          throw new Error(`prompt: 第 ${i + 1} 张图片解码后 ${decoded.length} 字节，超过 10MB 上限`);
        }
        blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      }
    }
    blocks.push({ type: 'text', text: String(text) });
    return await this._request('session/prompt', {
      sessionId: this.sessionId,
      prompt: blocks,
    });
  }

  // 切换会话配置项（model / mode / thinking 等，value 为纯字符串）；resolve result
  // （configOptions 为更新后的完整数组）；agent 拒绝时上抛 JSON-RPC 错误
  async setConfigOption(configId, value) {
    if (!this.sessionId) throw new Error('尚未建立会话（先调用 newSession 或 loadSession）');
    if (typeof configId !== 'string' || !configId || configId.length > 200) throw new Error('setConfigOption: configId 必须是长度不超过 200 的非空字符串');
    if (typeof value !== 'string' || !value || value.length > 200) throw new Error('setConfigOption: value 必须是长度不超过 200 的非空字符串');
    return await this._request('session/set_config_option', { sessionId: this.sessionId, configId, value }, SET_CONFIG_TIMEOUT_MS);
  }

  // 切换模型（第五次探测实测：参数名 modelId，取 configOptions.model 的 options[].value
  // 目录全名，如 'kimi-code/k3'；成功后 agent 推 config_option_update 全量刷新）。
  // 不稳定面方法但 0.29.0 实测可用；等价于 setConfigOption('model', modelId)
  async setModel(modelId) {
    if (!this.sessionId) throw new Error('尚未建立会话（先调用 newSession 或 loadSession）');
    if (typeof modelId !== 'string' || !modelId || modelId.length > 200) throw new Error('setModel: modelId 必须是长度不超过 200 的非空字符串');
    return await this._request('session/set_model', { sessionId: this.sessionId, modelId }, GENERIC_REQ_TIMEOUT_MS);
  }

  // 切换模式（第五次探测实测：与 setConfigOption('mode', modeId) 走同一 dispatcher。
  // 注意 0.29.0 已知缺陷：切 plan 可能误报 "Already in plan mode"（-32603）——
  // 报错文案不可信，调用方应以 config_option_update 推送的 currentValue 判定实际状态）
  async setMode(modeId) {
    if (!this.sessionId) throw new Error('尚未建立会话（先调用 newSession 或 loadSession）');
    if (typeof modeId !== 'string' || !modeId || modeId.length > 200) throw new Error('setMode: modeId 必须是长度不超过 200 的非空字符串');
    return await this._request('session/set_mode', { sessionId: this.sessionId, modeId }, GENERIC_REQ_TIMEOUT_MS);
  }

  // 校验认证方式（第五次探测实测：参数名 camelCase methodId，官方文档 method_id 系笔误；
  // token 缺失返回 -32000，未知 methodId 返回 -32602）。认证本身是 terminal 型流程
  // （authMethods 的 _meta['terminal-auth'] 给出 kimi login 命令行），本方法仅做校验
  async authenticate(methodId) {
    if (typeof methodId !== 'string' || !methodId || methodId.length > 200) throw new Error('authenticate: methodId 必须是长度不超过 200 的非空字符串');
    return await this._request('authenticate', { methodId }, GENERIC_REQ_TIMEOUT_MS);
  }

  // 取消当前会话进行中的 prompt：session/cancel 是 JSON-RPC 通知（无 id、不进 pending、
  // 无响应配对），agent 收到后进行中的 prompt 以 { stopReason: 'cancelled' } 返回。
  // 无会话时静默 no-op；子进程不可写只记日志不抛异常。同步返回，不返回 Promise
  cancel() {
    if (!this.sessionId) return;
    try {
      this._write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    } catch (e) {
      this._log(`session/cancel 通知发送失败: ${e && e.message ? e.message : e}`);
    }
  }

  // 设置权限决策回调：fn(params) 返回 Promise，resolve
  // { outcome: { outcome: 'selected', optionId } }（optionId 必须 ∈ params.options）
  // 或 { outcome: { outcome: 'cancelled' } }；传非函数值则恢复自动 cancelled 基线
  setPermissionHandler(fn) {
    this._permissionHandler = typeof fn === 'function' ? fn : null;
  }

  // 幂等清理：挂起的权限决策按 cancelled 收尾、kill 子进程、拒绝全部 pending、移除监听
  dispose(reason) {
    if (this.disposed) return;
    this.disposed = true;
    // 趁子进程仍在，先给挂起的权限请求补 cancelled 响应（写失败也只进日志，不挂死）
    for (const entry of [...this._pendingPermissions.values()]) entry.settleCancelled();
    this._killChild(reason || 'dispose');
    this._rejectAllPending(new Error(`AcpClient 已 dispose（${reason || '无原因'}）`));
    this.removeAllListeners();
  }
}

module.exports = { AcpClient, FrameParser, encodeMessage };
