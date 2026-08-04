// session-workspace 模块：M2-2 会话上下文服务（纯函数映射）
//
// 模块契约：
// - 纯 Node 模块，无任何 electron 依赖，可用 `node tests/test-session-workspace.js` 直跑
// - 纯函数：模块内无任何 fs / 网络副作用；索引条目由调用方（main.js）注入，
//   本模块自身不读取 ~/.kime-code/session_index.jsonl
// - 安全边界：本地索引为低置信推断（无时间戳、无来源标记），仅用于展示候选，
//   不授权数据读取；verified 判定只发生在调用方注入的索引命中时
// - 上下文优先级：url（navigate，本地 verified）> explicitSessionId（仅 URL 无会话 ID 时 fallback）
// - M5 安全规则：URL 携带合法 sessionId 但索引未命中时，绝不可回退 explicit——否则会出现
//   Web 显示 URL 会话 B、Workspace 却读取 explicit A 旧绑定的不一致（未授权读取）；该情形
//   安全返回候选 candidates / unbound，保持未授权。explicit 保留在内存仅供非会话页回退；
//   一旦该 URL sessionId 后续被索引 verified，仍按 url 优先解析为 bound B，
//   与 computeNavStateUpdate 的 clearExplicit 语义（verified URL 覆盖显式选择）一致
// - M6 会话 origin 规则：只有 URL origin 严格等于当前 knownServerBase 的 Web 页面才可能成为
//   Workspace bound context——file:// 本地页、外部/未知 origin、host 别名、协议/端口不匹配
//   的 URL 一律 unbound：绝不 bound、绝不 fallback explicit（本地页加载/配置页期间不得凭
//   explicit 读取任何工作区数据）、绝不展示本地索引候选（非可信页零索引泄漏面）；
//   可信 Web 非会话页（origin 属于 knownServerBase 且无会话 id）保留 explicit 既有回退用途
// - M6 导航指纹：navFingerprint 必须携带 knownServerBase——指纹含 trusted/untrusted origin
//   维度（可信↔非可信、127.0.0.1↔localhost、HTTP↔HTTPS、knownServerBase 变化但 sessionId
//   相同均必 changed），调用方据此推送 context，不保留旧 Workspace DOM
//
// 背景（M1 实测）：
// - kimi web 会话 URL 形态：/sessions/<sessionId>（pathname 携带完整 sessionId）
// - sessionId 形态：session_ + uuid，字符集仅 [A-Za-z0-9_-]，拒绝 / \ .. 等路径注入

// pathname 形态：/sessions/<id>[/]
const SESSION_URL_RE = /^\/sessions\/([^/]+)\/?$/;

// 兼容保留：早期「所有非会话页同态」哨兵。M6 起 navFingerprint 不再产出该值
//（可信非会话页 → `trusted:<origin>:no-session`、非可信 → `untrusted:<origin>`），
// 导出仅为既有消费方兼容，不得再用于指纹语义判断
const NO_SESSION_FP = 'no-session';

// 校验 sessionId：非空字符串、长度 ≤128、字符集仅 [A-Za-z0-9_-]
function isValidSessionId(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 128) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}

// M6 会话 origin 规则：URL origin 是否严格等于当前 knownServerBase origin。
// 仅可信 Web 页面（kimi web）可成为 Workspace bound context / 回退 explicit；
// file:// 本地页、外部站点、非法 URL、空输入一律 false（unbound，不 fallback explicit）
function isTrustedWebOrigin(url, knownServerBase) {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (typeof knownServerBase !== 'string' || knownServerBase.length === 0) return false;
  try {
    return new URL(url).origin === new URL(knownServerBase).origin;
  } catch {
    return false;
  }
}

// 从 URL 提取 sessionId：仅 http/https；pathname 匹配 /sessions/<id>[/]；
// 查询串 / hash 不影响；decodeURIComponent 后过 isValidSessionId
function parseSessionIdFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null; // 非法 URL
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const m = SESSION_URL_RE.exec(parsed.pathname);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null; // 非法百分号编码
  }
  return isValidSessionId(id) ? id : null;
}

// 按 sessionId 在注入的索引条目中解析；indexEntries 非数组按空数组处理
function resolveBySessionId(sessionId, indexEntries) {
  if (!isValidSessionId(sessionId)) {
    return { status: 'unknown', sessionId: null };
  }
  const entries = Array.isArray(indexEntries) ? indexEntries : [];
  for (const e of entries) {
    if (e && typeof e === 'object' && e.sessionId === sessionId) {
      return { status: 'verified', sessionId, workDir: e.workDir, sessionDir: e.sessionDir };
    }
  }
  return { status: 'unknown', sessionId };
}

// 候选列表：过滤有效条目（isValidSessionId 且 workDir 非空字符串）、
// 按 sessionId 去重（保留最后出现项 = jsonl 最近）、倒序（后追加 = 最近在前）、截断 limit
function listCandidates(indexEntries, { limit = 20 } = {}) {
  const entries = Array.isArray(indexEntries) ? indexEntries : [];
  const n = Number.isInteger(limit) && limit >= 0 ? limit : 20;
  const out = [];
  const seen = new Set();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== 'object') continue;
    if (typeof e.sessionId !== 'string' || !isValidSessionId(e.sessionId)) continue;
    if (typeof e.workDir !== 'string' || e.workDir.length === 0) continue;
    if (seen.has(e.sessionId)) continue;
    seen.add(e.sessionId);
    out.push({ sessionId: e.sessionId, workDir: e.workDir, sessionDir: e.sessionDir, source: 'index' });
  }
  return out.slice(0, n);
}

// 导航去重指纹（did-navigate-in-page 变化检测用稳定键）：
// M6 起必须携带 knownServerBase，指纹纳入 trusted/untrusted origin 维度——
// - 非可信（file:// 本地页、外部/未知 origin、host 别名、协议/端口与 knownServerBase
//   不匹配、空/非法 URL）→ `untrusted:<urlOrigin>`（urlOrigin 解析失败为 ''；
//   file:// 的 origin 恒为 'null'），与任何可信指纹严格不同；
// - 可信 Web（origin 严格等于 knownServerBase origin）：
//   - URL 非法 / 无会话 id（非会话页）→ `trusted:<origin>:no-session`
//   - 会话 id 未在索引 verified → `trusted:<origin>:unverified:<id>`
//   - 会话 id 已 verified → `trusted:<origin>:verified:<id>:<workDir>`
// 语义：可信↔非可信、127.0.0.1↔localhost、HTTP↔HTTPS、knownServerBase 变化但
// sessionId 相同（origin 变化）均必 changed——调用方（main.js）据此不会保留旧
// Workspace DOM；同 URL 同 base 同索引状态指纹稳定（去重不误伤）。
// indexEntries 非数组按空数组处理。
function navFingerprint(url, indexEntries, knownServerBase) {
  if (typeof url !== 'string' || url.length === 0) return 'untrusted:';
  if (!isTrustedWebOrigin(url, knownServerBase)) {
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* 非法 URL 无 origin */ }
    return `untrusted:${origin}`;
  }
  // isTrustedWebOrigin 已保证可解析且 origin 与 knownServerBase 严格相等
  const origin = new URL(url).origin;
  const id = parseSessionIdFromUrl(url);
  if (!id) return `trusted:${origin}:no-session`;
  const r = resolveBySessionId(id, indexEntries);
  if (r.status === 'verified') {
    const workDir = typeof r.workDir === 'string' ? r.workDir : '';
    return `trusted:${origin}:verified:${id}:${workDir}`;
  }
  return `trusted:${origin}:unverified:${id}`;
}

// 导航状态同步纯函数内核（main.js syncWorkspaceNavigationState 共用，可单测）：
// 输入当前 URL、索引条目、上一次指纹、当前 explicit、knownServerBase（M6 origin 规则），输出：
// - changed: 本次 URL 指纹是否与上一次不同（导航授权状态是否发生变化）——
//   可信↔非可信、127.0.0.1↔localhost、HTTP↔HTTPS、knownServerBase 变化但 sessionId
//   相同均产生 changed，调用方据此推送 context，不保留旧 Workspace DOM；
// - fingerprint: 本次 URL 的新指纹（changed 时为新值，否则与 prevFingerprint 相同）；
// - clearExplicit: 是否应清 workspaceExplicitSessionId——仅当 URL 会话已在本地索引
//   verified 且当前 URL 属于可信 Web origin 时为 true（可信导航覆盖显式选择）；
//   非可信页（file/外部/未知/host 别名/协议·端口不匹配）与可信 Web 非会话页恒 false：
//   explicit 保留内存仅供可信 Web 非会话页回退（既有用途），resolveContext 的 origin
//   规则保证非可信页绝不 fallback explicit，残留无安全面
// 口径：explicit 清理只在指纹变化路径评估（changed 才可能为 true）；
// 绝不依赖 workspaceVisible（面板可见性只影响调用方是否推送 IPC 事件，不影响状态同步）
function computeNavStateUpdate({ url, indexEntries, prevFingerprint, explicitSessionId, knownServerBase } = {}) {
  const fingerprint = navFingerprint(url, indexEntries, knownServerBase);
  const changed = fingerprint !== prevFingerprint;
  let clearExplicit = false;
  if (changed) {
    // M6：explicit 只在「可信 Web 且 URL 会话已 verified」时清理；非可信页与
    // 可信 Web 非会话页一律不清（explicit 的既有用途仅限于可信 Web 非会话页回退）
    const id = parseSessionIdFromUrl(url);
    if (id && explicitSessionId && isTrustedWebOrigin(url, knownServerBase)) {
      clearExplicit = resolveBySessionId(id, indexEntries).status === 'verified';
    }
  }
  return { changed, fingerprint, clearExplicit };
}

// 解析上下文：优先级 url（navigate，本地索引 verified）> explicit；
// M5 安全规则：URL 携带合法 sessionId 但索引未命中 → 绝不回退 explicit（防 Web 显示 B、
// Workspace 读取旧绑定 A 的不一致），直接安全返回候选 candidates / unbound，保持未授权；
// M6 会话 origin 规则：URL origin 严格等于 knownServerBase 才可信——
// 非可信（file:// 本地页、外部/未知 origin、host 别名、协议/端口不匹配）一律 unbound：
// 绝不 bound、绝不 fallback explicit、绝不展示本地索引候选（非可信页零索引泄漏面）；
// explicit 仅在可信 Web 非会话页（origin 属于 knownServerBase 且 URL 无会话 ID）回退；
// 可信 Web 的 URL sessionId 后续被索引 verified 时，仍按上方 url 优先解析为 bound B，
// 与 computeNavStateUpdate 的 clearExplicit 语义（可信 verified URL 覆盖显式选择）一致
function resolveContext({ url, indexEntries, explicitSessionId, knownServerBase } = {}) {
  const updatedAt = Date.now();

  // M6：origin 严格校验先行——非可信 URL 在任意分支都不产生 bound / explicit / 候选
  const trusted = isTrustedWebOrigin(url, knownServerBase);

  // 可信 Web 的 URL 会话优先：/sessions/<id> 可解析且在本地索引 verified → bound/navigate
  if (trusted) {
    const id = parseSessionIdFromUrl(url);
    if (id) {
      const r = resolveBySessionId(id, indexEntries);
      if (r.status === 'verified') {
        return {
          state: 'bound', sessionId: r.sessionId, workDir: r.workDir, sessionDir: r.sessionDir,
          confidence: 'high', source: 'navigate', updatedAt,
        };
      }
      // M5 安全规则：可信 Web 的 URL 携带合法 sessionId 但索引未命中 → 绝不可回退 explicit，
      // 安全返回候选 / unbound（保持未授权，等待该 URL sessionId 被索引 verified 后再 bound）
      return candidatesOrUnbound(indexEntries, updatedAt);
    }
  } else {
    // M6：非可信 origin 一律 unbound——绝不 bound、绝不 fallback explicit、绝不展示
    // 本地索引候选（file/外部/未知页不得感知任何工作区数据）
    return { state: 'unbound', confidence: 'low', updatedAt };
  }

  // 可信 Web 非会话页：explicit 仅作 fallback（既有用途，M2 起保留）。非可信页不会
  // 到达此处（上方已 return）。保留在内存供回退，URL sessionId 后续 verified 时由
  // 上方 url 优先覆盖（clearExplicit 语义）
  if (typeof explicitSessionId === 'string' && explicitSessionId.length > 0) {
    const r = resolveBySessionId(explicitSessionId, indexEntries);
    if (r.status === 'verified') {
      return {
        state: 'bound', sessionId: r.sessionId, workDir: r.workDir, sessionDir: r.sessionDir,
        confidence: 'high', source: 'explicit', updatedAt,
      };
    }
  }

  return candidatesOrUnbound(indexEntries, updatedAt);
}

// 低置信安全返回：有候选 → candidates（仅展示不授权），无候选 → unbound
function candidatesOrUnbound(indexEntries, updatedAt) {
  const candidates = listCandidates(indexEntries);
  if (candidates.length > 0) {
    return { state: 'candidates', candidates, confidence: 'low', updatedAt };
  }
  return { state: 'unbound', confidence: 'low', updatedAt };
}

module.exports = { isValidSessionId, isTrustedWebOrigin, parseSessionIdFromUrl, resolveBySessionId, listCandidates, resolveContext, navFingerprint, computeNavStateUpdate, NO_SESSION_FP };
