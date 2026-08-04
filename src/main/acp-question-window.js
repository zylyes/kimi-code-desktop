// ACP Elicitation 问答窗生命周期纯函数（M5 P1 修复）
// node 可测，无 Electron 依赖。main.js 的 ACP elicitation 窗路径全部走本模块
// 的判定函数，保证：窗口有效性用与当前 ACP 请求绑定的独立 owner/request epoch
// （绝不使用 wsGeneration）；旧/遗留窗口不得结算后续 elicitation。
'use strict';

// ACP 问答窗 question_id（question.html 渲染层以该值识别 elicitation 形态）
const ACP_ELICITATION_QID = 'acp-elicitation';

// 将 parseElicitation 结果映射为 question.html 可渲染 payload（字段名适配
// question 页面契约：id/question/options[].id|label|description）
function buildElicitationQuestionPayload(parsed, sessionId) {
  const questions = Array.isArray(parsed && parsed.questions) ? parsed.questions : [];
  return {
    question_id: ACP_ELICITATION_QID,
    session_id: typeof sessionId === 'string' ? sessionId : '',
    questions: questions.map((q) => ({
      id: q.key,
      question: q.text,
      options: (Array.isArray(q.options) ? q.options : []).map((o) => ({
        id: o.optionId,
        label: o.name,
        description: '',
      })),
    })),
  };
}

// 判定窗口事件/IPC 是否应结算当前 ACP elicitation：仅当在途请求仍是同一
// elicitation（kind 匹配 + settle 身份一致）才结算。旧/遗留窗口的 settle 与
// 当前 pending 不一致，或 pending 已清空（已 settle/已取消/客户端销毁）时恒不结算。
function shouldSettleElicitation(pending, windowSettle) {
  return !!(pending && pending.kind === 'elicitation' && pending.settle === windowSettle);
}

// 判定问答窗 init 下发是否仍有效：owner 对应的窗口有效性代必须仍匹配。
// ACP 窗绑定独立 epoch（每次新 elicitation 请求、取消收尾、权限清理时递增），
// 绝不以 wsGeneration 作为 ACP 窗加载/初始化有效性依据；WS 问答窗沿用
// wsGeneration 语义。
function isWindowInitCurrent(owner, gen, wsGeneration, acpElicitationEpoch) {
  return owner === 'acp' ? gen === acpElicitationEpoch : gen === wsGeneration;
}

// ---------- P1-1：elicitation 请求身份（同步 reentry 安全） ----------
// 背景：当前请求的 settle() 内部会同步 pump 队列下一项；下一项可能又是
// elicitation，立即 begin() 建立新身份（新 epoch + 新 settle）。因此任何收尾
// 路径（submit/fallback/cancel、create/load/init 失败、closed、dispose/cancel）
// 都必须在调用可能同步 pump 的 settle 之前，用 retire() 原子地失效并移除
// "当前请求"的身份；retire 之后只允许结算其返回的旧 settle，绝不能再清空/
// 递增身份字段——否则会破坏 settle 同步创建的新请求身份（第二个 elicitation
// 的 init 失效、无法结算）。
class ElicitationIdentity {
  constructor() {
    this.epoch = 0;
    this.settle = null;
  }

  // 记录新请求（openAcpElicitationWindow 建立身份时调用）：递增 epoch 并绑定
  // settle，返回新 epoch（作 createQuestionWindow 的 gen）。settle() 同步 pump
  // 出的下一个 elicitation 即经由此处建立身份。
  begin(nextSettle) {
    this.epoch += 1;
    this.settle = nextSettle;
    return this.epoch;
  }

  // 原子失效"匹配 expectedSettle"的当前身份：仅当当前身份正是 expectedSettle
  // 且 pending 仍是同一 elicitation（shouldSettleElicitation）时，捕获并移除身份
  // （settle 置 null、epoch 递增），返回捕获的旧 settle；不匹配 → 返回 null 且
  // 身份不动。必须发生在任何可能同步 pump 的 settle 调用之前；调用方只可结算
  // 其返回值，之后不得再触碰身份字段。
  // expectedSettle 语义：收尾路径传当前身份（identity.settle）；旧窗口 closed
  // guard 传闭包捕获的旧 settle——即使队列已同步 pump 出新请求（身份已更换），
  // 旧 guard 也绝不误伤新请求。
  retire(pending, expectedSettle) {
    if (expectedSettle !== this.settle) return null;
    if (!shouldSettleElicitation(pending, expectedSettle)) return null;
    this.settle = null;
    this.epoch += 1;
    return expectedSettle;
  }

  currentEpoch() {
    return this.epoch;
  }
}

// ---------- P1-4 + P1-B + P1-C：question IPC（submit/fallback/cancel）ACP 分支准入校验 ----------
// 在 ACP 结算分支前显式验证：sender 是当前 questionWindow、owner='acp'、
// questionWindowQuestionId（窗口 QID）等于 ACP elicitation ID、IPC payload 中的
// question_id（payloadQuestionId）同样等于 ACP elicitation ID、窗口创建时捕获的
// request identity（windowEpoch/windowSettle）与当前请求身份（identity 的
// epoch/settle）完全一致、pending.settle 与窗口捕获的 windowSettle 一致。
// 任何旧窗口（epoch 旧 / settle 旧）、owner 错配、窗口 QID 错误、payload QID 空、
// 伪造、非 ACP 或旧值、身份错配、identity 缺失均不得结算当前或后续 ACP 请求
// （此后只能走遗留窗拒绝或 WS 路径）。缺任一条件均拒绝。
function canSettleAcpElicitation({ senderIsCurrentWindow, owner, questionId, payloadQuestionId, pending, windowEpoch, windowSettle, identity }) {
  return !!senderIsCurrentWindow
    && owner === 'acp'
    && questionId === ACP_ELICITATION_QID
    && payloadQuestionId === ACP_ELICITATION_QID
    && !!identity
    && windowEpoch === identity.currentEpoch()
    && windowSettle === identity.settle
    && shouldSettleElicitation(pending, windowSettle);
}

// ---------- P1-A：窗口级 elicitation 取消收尾（仅结算捕获的 settle） ----------
// createQuestionWindow 的创建/加载/init 失败、初始化前已销毁等 cleanup 路径
// 专用：只对"该窗口创建时捕获的 settle"原子 retire，命中才结算取消；绝不读取
// 全局"当前"身份——win.close() 会同步触发 closed guard 结算并 pump 出下一项
// elicitation（新身份已建立），旧 cleanup 若再用全局当前身份 retire/settle 会
// 误伤新请求。settle 可能同步 pump 新请求（begin 建立新身份），本函数结算后
// 调用方不得再触碰身份字段。返回是否实际结算（未命中 = 已由 guard 结算/身份
// 已更换/pending 非 elicitation，幂等安全）。
function settleWindowElicitationCancelled(identity, pending, windowSettle) {
  const retired = identity.retire(pending, windowSettle);
  if (retired && pending) {
    pending.settle({ outcome: 'cancelled' });
    return true;
  }
  return false;
}

module.exports = {
  ACP_ELICITATION_QID,
  buildElicitationQuestionPayload,
  shouldSettleElicitation,
  isWindowInitCurrent,
  ElicitationIdentity,
  canSettleAcpElicitation,
  settleWindowElicitationCancelled,
};
