// 通知会话导航安全决策（M5 P1 修复 + P1-3 完整一致 sessionId）
// 纯函数模块，node 可测，无 Electron 依赖；不读全局状态、不做 I/O。
// 服务状态（epoch/base/token）与校验器均由 main.js 注入。
// 安全口径：
//  - 通知点击导航资格必须同时满足：sessionId 合法、通知创建时捕获的连接/导航
//    epoch 与 base 仍与当前一致（实例切换/服务重启/连接身份变更递增 epoch，
//    A→B→A 与同 base 重启均使旧通知只能聚焦，不得恢复导航资格）、当前持有可信
//    token；目标 URL 只能由当前 knownServerBase/token 构造；
//  - WS question 事件绝不携带可导航 sessionId（由调用方不传 sessionId 实现）；
//  - 审批/完成通知只在所有提供的 sessionId 来源（raw 与 payload/data 多层及其
//    info 层，与 runtime-event-normalizer 的 pick 路径对齐）全部合法且一致时
//    携带可导航 ID。收集时严格区分"字段缺失"与"字段存在但非法"：任何已存在
//    的 sessionId/session_id 若值为空（含空串/null）、非字符串、非法格式或与
//    其他来源不同 → 取消导航资格（仅聚焦）。字段缺失（undefined）不构成提供。
'use strict';

// 从 WS 事件 raw 收集所有"提供"的 sessionId 来源（raw 顶层 + payload + data 各层
// 的 session_id/sessionId，及 payload/data 的 info 层——与 normalizer 的 pick 路径
// 对齐）。区分字段缺失与字段存在但非法：
//  - 字段缺失（undefined）→ 不提供（不取消资格）；
//  - 字段存在（空串、null、非字符串等任意非法形态）→ presentInvalid=true（取消资格）；
//  - 非空字符串 → provided。
// 返回 { provided: string[], presentInvalid: boolean }（provided 按来源顺序不去重，
// 去重/一致性由调用方判定；info 非对象时按缺失处理，不构成非法来源）。
function collectProvidedSessionIds(raw) {
  const provided = [];
  let presentInvalid = false;
  const push = (v) => {
    if (v === undefined) return; // 字段缺失 → 不提供
    if (typeof v === 'string' && v.length > 0) provided.push(v);
    else presentInvalid = true; // 存在但为空/非字符串（含 null）→ 取消资格
  };
  const layer = (o) => {
    if (!o || typeof o !== 'object') return;
    push(o.session_id);
    push(o.sessionId);
    const info = o.info && typeof o.info === 'object' ? o.info : null;
    if (info) {
      push(info.session_id);
      push(info.sessionId);
    }
  };
  if (raw && typeof raw === 'object') {
    push(raw.session_id);
    push(raw.sessionId);
    layer(raw.payload);
    layer(raw.data);
  }
  return { provided, presentInvalid };
}

// 审批等普通通知的 sessionId 决策：
// 所有提供的来源必须全部合法且彼此一致 → 返回该 ID；
// 任一来源为存在但非法值（空串/null/非字符串/非法格式）、来源间冲突、
// 完全未提供 → null（仅聚焦）。
function approvalNavSessionId(raw, isValidSessionId) {
  const { provided, presentInvalid } = collectProvidedSessionIds(raw);
  if (presentInvalid) return null;
  if (provided.length === 0) return null;
  let id = null;
  for (const v of provided) {
    if (typeof isValidSessionId !== 'function' || !isValidSessionId(v)) return null;
    if (id === null) id = v;
    else if (id !== v) return null;
  }
  return id;
}

// 完成通知的 sessionId 决策：normalizer 的 sessionId 必须合法；raw 提供的所有
// 来源必须全部合法且与 normalizer 一致（normalizer 与 raw 同取首个字段不算验证）；
// raw 完全未提供时以 normalizer 为准。任一不满足（含存在但非法的来源值）→ null。
function completionNavSessionId(raw, normalizedSessionId, isValidSessionId) {
  if (typeof normalizedSessionId !== 'string'
    || typeof isValidSessionId !== 'function'
    || !isValidSessionId(normalizedSessionId)) {
    return null;
  }
  const { provided, presentInvalid } = collectProvidedSessionIds(raw);
  if (presentInvalid) return null;
  for (const v of provided) {
    if (!isValidSessionId(v)) return null;
    if (v !== normalizedSessionId) return null;
  }
  return normalizedSessionId;
}

// 通知点击导航决策（M5 P1 修复核心）：
//  - sessionId 必须合法；
//  - 创建时捕获的 epoch/base 必须与当前一致（独立连接/导航 epoch，绝不复用/递增
//    serverGeneration——后者同时被 CLI/WS 回调守卫消费）；
//  - 当前必须持有可信 base+token（目标 URL 只由当前值构造）；
//  - 已在目标会话不重载。
// 返回 { navigate: boolean, targetUrl: string|null, reason: string }
function decideNotificationNav({
  sessionId, epoch, base,
  currentEpoch, currentBase, currentToken,
  currentUrl,
  isValidSessionId, parseSessionIdFromUrl,
}) {
  if (typeof sessionId !== 'string'
    || typeof isValidSessionId !== 'function' || !isValidSessionId(sessionId)) {
    return { navigate: false, targetUrl: null, reason: 'invalid-session-id' };
  }
  if (epoch !== currentEpoch || base !== currentBase) {
    return { navigate: false, targetUrl: null, reason: 'stale-epoch' };
  }
  if (typeof currentBase !== 'string' || currentBase.length === 0) {
    return { navigate: false, targetUrl: null, reason: 'no-base' };
  }
  if (typeof currentToken !== 'string' || currentToken.length === 0) {
    return { navigate: false, targetUrl: null, reason: 'no-token' };
  }
  try {
    if (currentUrl && typeof parseSessionIdFromUrl === 'function'
        && parseSessionIdFromUrl(currentUrl) === sessionId) {
      return { navigate: false, targetUrl: null, reason: 'already-there' };
    }
  } catch {
    // 当前 URL 解析失败按可导航处理
  }
  return {
    navigate: true,
    targetUrl: `${currentBase}/sessions/${encodeURIComponent(sessionId)}#token=${encodeURIComponent(currentToken)}`,
    reason: 'navigate',
  };
}

module.exports = {
  collectProvidedSessionIds,
  approvalNavSessionId,
  completionNavSessionId,
  decideNotificationNav,
};
