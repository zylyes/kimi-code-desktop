// 本地命令服务层：/usage 与 /status 的命令处理（Phase 3）
// preload/面板只做拦截与渲染，本模块聚合 runtime 状态、本地用量趋势、平台额度，
// 产出渲染层契约。纯 Node、无 electron 依赖、全依赖注入。
// 安全约束：token/凭据/网络对服务层不可见——fetchManagedUsageImpl 由调用方闭包绑定
// （token/fetch/baseUrl 均已闭包捕获），服务层不发任何网络请求、不读文件、不碰 token。
'use strict';

const TREND_RANGES = ['today', '7d', '30d'];

// 错误 → 字符串并截断 200 字符
function truncateMessage(err) {
  const raw = err && err.message != null ? String(err.message) : String(err == null ? 'unknown error' : err);
  const msg = raw.trim();
  return msg.length > 200 ? `${msg.slice(0, 197)}...` : msg;
}

// contextWindow 派生（决策已定）：
//  - sessionId 非 null 且 getSessionUsage(sessionId) 存在且 contextLimit>0 → session
//  - 否则全局工作区桶 contextLimit>0 → global-ws
//  - 否则 null
function deriveContextWindow(runtimeState, sessionId) {
  if (sessionId != null) {
    const s = runtimeState.getSessionUsage(sessionId);
    if (s && s.contextLimit > 0) {
      return { used: s.contextUsed, limit: s.contextLimit, source: 'session' };
    }
  }
  const g = runtimeState.getUsageSnapshot();
  if (g && g.contextLimit > 0) {
    return { used: g.contextUsed, limit: g.contextLimit, source: 'global-ws' };
  }
  return null;
}

class LocalCommandService {
  constructor({ runtimeState, usageStats, fetchManagedUsageImpl, getStatusContext, now = () => Date.now() } = {}) {
    if (!runtimeState ||
      typeof runtimeState.getSessionUsage !== 'function' ||
      typeof runtimeState.getUsageSnapshot !== 'function') {
      throw new Error('runtimeState 必须提供 getSessionUsage/getUsageSnapshot');
    }
    if (!usageStats || typeof usageStats.snapshot !== 'function') {
      throw new Error('usageStats 必须提供 snapshot(range)');
    }
    if (typeof fetchManagedUsageImpl !== 'function') throw new Error('fetchManagedUsageImpl 必须是函数');
    if (typeof getStatusContext !== 'function') throw new Error('getStatusContext 必须是函数');
    this._runtimeState = runtimeState;
    this._usageStats = usageStats;
    this._fetchManaged = fetchManagedUsageImpl;
    this._getStatusContext = getStatusContext;
    this._now = typeof now === 'function' ? now : () => Date.now();
  }

  // 匹配：trim 后全等 '/usage' 或 '/status'（大小写敏感）；其余一切 → not-local-command（调用方放行给 CLI）
  async runLocalCommand(command, { sessionId = null, signal = null } = {}) {
    const cmd = String(command).trim();
    if (cmd !== '/usage' && cmd !== '/status') {
      return { ok: false, code: 'not-local-command' };
    }
    if (signal && signal.aborted) return { ok: false, code: 'aborted' };

    const generatedAt = this._now();
    if (cmd === '/usage') return this._runUsage(sessionId, signal, generatedAt);
    return this._runStatus(sessionId, signal, generatedAt);
  }

  // /usage：managed 与三个 range 用 Promise.allSettled 并行；部分失败降级，不置 ok:false
  async _runUsage(sessionId, signal, generatedAt) {
    const errors = [];
    const settled = await Promise.allSettled([
      this._usageStats.snapshot('today'),
      this._usageStats.snapshot('7d'),
      this._usageStats.snapshot('30d'),
      Promise.resolve().then(() => this._fetchManaged({ signal })), // 包一层：同步 throw 也归入 allSettled
    ]);
    if (signal && signal.aborted) return { ok: false, code: 'aborted' };

    const trends = {};
    for (let i = 0; i < TREND_RANGES.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        trends[TREND_RANGES[i]] = r.value;
      } else {
        trends[TREND_RANGES[i]] = null;
        errors.push({ part: `trends.${TREND_RANGES[i]}`, message: truncateMessage(r.reason) });
      }
    }

    const managedRes = settled[TREND_RANGES.length];
    const managed = managedRes.status === 'fulfilled'
      ? managedRes.value // 正常返回原样透传（kind 分级由渲染层解释）
      : { kind: 'error', plans: [], wallet: null, fetchedAt: this._now(), staleAt: this._now() };
    if (managedRes.status === 'rejected') {
      errors.push({ part: 'managed', message: truncateMessage(managedRes.reason) });
    }

    return {
      ok: true,
      kind: 'usage',
      generatedAt,
      data: {
        contextWindow: deriveContextWindow(this._runtimeState, sessionId),
        sessionUsage: sessionId != null ? this._runtimeState.getSessionUsage(sessionId) : null,
        managed,
        trends,
        errors,
      },
    };
  }

  // /status：getStatusContext 透传（null → 静态字段全 null）+ contextWindow + managed 摘要
  async _runStatus(sessionId, signal, generatedAt) {
    const errors = [];
    let managed = null;
    try {
      managed = await this._fetchManaged({ signal });
    } catch (err) {
      errors.push({ part: 'managed', message: truncateMessage(err) });
    }
    if (signal && signal.aborted) return { ok: false, code: 'aborted' };

    let managedSummary = null;
    if (managed && managed.kind === 'ok') {
      const plan = managed.plans && managed.plans[0] ? managed.plans[0] : null;
      const wallet = managed.wallet || null;
      managedSummary = {
        kind: managed.kind,
        planLabel: plan ? plan.label : null,
        planUsed: plan ? plan.used : null,
        planLimit: plan ? plan.limit : null,
        walletBalanceMinor: wallet ? wallet.balanceMinor : null,
        currency: wallet ? wallet.currency : null,
      };
    }

    const ctx = this._getStatusContext(sessionId);
    return {
      ok: true,
      kind: 'status',
      generatedAt,
      data: {
        cliVersion: ctx ? ctx.cliVersion : null,
        desktopVersion: ctx ? ctx.desktopVersion : null,
        model: ctx ? ctx.model : null,
        thinking: ctx ? ctx.thinking : null,
        mode: ctx ? ctx.mode : null,
        permissionMode: ctx ? ctx.permissionMode : null,
        cwd: ctx ? ctx.cwd : null,
        sessionState: ctx ? ctx.sessionState : null,
        contextWindow: deriveContextWindow(this._runtimeState, sessionId),
        managedSummary,
        errors,
      },
    };
  }
}

module.exports = { LocalCommandService };
