// 运行时规范化状态层（无 electron 依赖，纯 Node）
// 消费 runtime-event-normalizer 产出的统一事件，维护任务状态、usage 分桶与活动任务计数。
// 核心不变量：
//  - 任务键 = `${sessionId || ''}:${taskId}`；taskId 缺失 -> `unknown:${单调序号}`（不重复计数）
//  - 重复 started/observed(running)：更新 title/at，不重复计数
//  - 重复 completed：幂等，不重复减
//  - 乱序：completed 先到 -> 终态 tombstone；之后同键 started/running 不得复活
//  - progress/observed 先到（无 started）：按 running 建快照
//  - usage 按 `sessionId || '__global__'` 分桶，会话间不互相覆盖
//  - 每次有效 apply 且状态实际变化后 emit('changed', { kind, sessionId })
//  - changed 契约：getTasks()/TaskCatalog 可见字段（status/title/agentType/at/kind/
//    source/confidence/rawKind）任一变化即 emit；at 单调（首建取事件时间戳，后续仅
//    前移，倒退/相等保持既有值）——等价重复事件（含 at 相同）不 emit
'use strict';

const { EventEmitter } = require('events');

const GLOBAL_BUCKET = '__global__';

// M6 资源上限：in-memory map 条目上限（WS 持续事件不可导致无界内存）。
// 达到上限时确定性驱逐 at 最小（最老）条目，驱逐数计入 truncation（getTruncation() 可见），
// 不抛；既有可见字段/状态语义不变。
const LIMITS = {
  MAX_TASK_ENTRIES: 2000, // _tasks 条目上限（含终态墓碑）
  MAX_USAGE_BUCKETS: 200, // _usage 会话桶数上限
};

class RuntimeState extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._now = opts && typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._tasks = new Map(); // key -> 任务条目
    this._usage = new Map(); // bucketKey -> { totalTokens, contextUsed, contextLimit }
    this._seq = 0; // unknown 任务合成键的单调序号
    this._lastTaskTitle = '';
    this.truncation = { tasksEvicted: 0, usageBucketsEvicted: 0 }; // M6：上限驱逐可见
  }

  // M6 确定性驱逐：map 达到 max 且插入新键时，删除 at 最小（相等取 Map 最早插入）的条目；
  // _usage 桶无时间戳，取 Map 最早插入桶。驱逐为内部容量管理，不触发 'changed'
  // （changed 契约只约束事件 apply 导致的可见字段变化），驱逐数经 truncation 可见。
  _evictTaskOldest() {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, e] of this._tasks) {
      if (e.at < oldestAt) {
        oldestAt = e.at;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) {
      this._tasks.delete(oldestKey);
      this.truncation.tasksEvicted++;
      return true;
    }
    return false;
  }

  // M6：usage 桶驱逐（Map 最早插入者），驱逐数经 truncation.usageBucketsEvicted 可见
  _evictUsageOldest() {
    const first = this._usage.keys().next();
    if (first.done) return false;
    this._usage.delete(first.value);
    this.truncation.usageBucketsEvicted++;
    return true;
  }

  // M6：截断/驱逐统计快照（副本，不暴露内部引用）
  getTruncation() {
    return { ...this.truncation };
  }

  // 应用 normalized 事件；非法事件静默忽略
  apply(event) {
    if (!event || typeof event !== 'object') return;
    const kind = event.kind;
    if (kind === 'usage.updated') {
      this._applyUsage(event);
    } else if (
      kind === 'task.started' || kind === 'task.progress' ||
      kind === 'task.completed' || kind === 'task.observed'
    ) {
      this._applyTask(event);
    }
    // 其他 kind：静默忽略
  }

  _applyTask(event) {
    const key = event.taskId
      ? `${event.sessionId || ''}:${event.taskId}`
      : `unknown:${++this._seq}`;

    const existing = this._tasks.get(key);
    if (existing && existing.terminal) return; // 终态墓碑：不可复活、不可覆盖

    let newStatus;
    if (event.kind === 'task.completed') newStatus = 'completed';
    else if (event.kind === 'task.started' || event.kind === 'task.progress') newStatus = 'running';
    else newStatus = event.status; // task.observed：running/completed/failed/null

    // observed 且状态未知（null）：不降级既有状态，仅更新元信息
    const status = newStatus === null && existing ? existing.status : newStatus;
    const terminal = status === 'completed' || status === 'failed';

    // 元信息降级保护：同键非终态更新中，通用回退值（空 / 'subagent'）不得覆盖已有具体值；
    // 新事件携带具体非通用值时仍正常更新
    let title = event.title || '';
    let agentType = event.agentType || null;
    if (existing) {
      if (!title || title === 'subagent') title = existing.title;
      if ((!agentType || agentType === 'subagent') &&
          existing.agentType && existing.agentType !== 'subagent') {
        agentType = existing.agentType;
      }
    }

    // at 单调契约：首建取事件时间戳（缺失 -> _now()）；已有条目仅允许时间前移，
    // 倒退/相等保持既有值。递增 at 会刷新 TaskCatalog 暴露的 updatedAt（可见变化，
    // 必须 changed）；等价重复事件（at 相同）不更新不 changed；乱序老事件不抖动时间戳。
    const eventAt = event.at != null ? event.at : (existing ? existing.at : this._now());
    const at = existing && eventAt < existing.at ? existing.at : eventAt;

    const entry = {
      key,
      sessionId: event.sessionId,
      taskId: event.taskId,
      title,
      status,
      at,
      kind: event.kind,
      agentType,
      source: event.source,
      confidence: event.confidence,
      rawKind: event.rawKind,
      terminal,
    };

    // changed 契约：任何改变 getTasks()/TaskCatalog 可见字段的事件必须 emit；
    // key/sessionId/taskId 由键派生必然相同，故比较其余全部可见字段（含 at）。
    let changed = false;
    if (!existing) changed = true;
    else {
      if (existing.status !== status) changed = true;
      if (existing.title !== title) changed = true;
      // agentType 具体化（通用 null/'subagent' -> 具体类型）属有意义变化；
      // 降级保护已保证通用值不会回写，故直接比较即可避免等价重复事件误发 changed
      if (existing.agentType !== agentType) changed = true;
      if (existing.at !== at) changed = true;
      if (existing.kind !== event.kind) changed = true;
      if (existing.source !== event.source) changed = true;
      if (existing.confidence !== event.confidence) changed = true;
      if (existing.rawKind !== event.rawKind) changed = true;
    }

    // M6：任务条目上限——插入新键且已满时确定性驱逐 at 最小（最老）条目，驱逐经
    // truncation.tasksEvicted 可见；既有 changed 语义不受影响
    if (!existing && this._tasks.size >= LIMITS.MAX_TASK_ENTRIES) {
      this._evictTaskOldest();
    }
    this._tasks.set(key, entry);

    // lastTaskTitle：最近 apply 的 running 任务 title；无 running 时保留最后值
    if (status === 'running' && title !== this._lastTaskTitle) {
      this._lastTaskTitle = title;
      changed = true;
    }

    if (changed) this.emit('changed', { kind: event.kind, sessionId: event.sessionId });
  }

  _applyUsage(event) {
    const bucketKey = event.sessionId || GLOBAL_BUCKET;
    const usage = event.usage || { totalTokens: 0, contextUsed: 0, contextLimit: 0 };
    const prev = this._usage.get(bucketKey);
    if (!prev && this._usage.size >= LIMITS.MAX_USAGE_BUCKETS) {
      this._evictUsageOldest(); // M6：桶数上限，驱逐最早插入桶
    }
    const changed = !prev ||
      prev.totalTokens !== usage.totalTokens ||
      prev.contextUsed !== usage.contextUsed ||
      prev.contextLimit !== usage.contextLimit;
    if (changed) {
      this._usage.set(bucketKey, {
        totalTokens: usage.totalTokens,
        contextUsed: usage.contextUsed,
        contextLimit: usage.contextLimit,
      });
      this.emit('changed', { kind: event.kind, sessionId: event.sessionId });
    }
  }

  // 传 sessionId -> 该会话；不传 -> 全部（含 null 全局桶）
  getActiveTaskCount(sessionId) {
    let count = 0;
    for (const entry of this._tasks.values()) {
      if (entry.status !== 'running') continue;
      if (arguments.length === 0 || entry.sessionId === sessionId) count++;
    }
    return count;
  }

  // 活动（running）计数双拆分：agentType 非 null -> agents（ACP 子代理），null -> tasks
  // sessionId 过滤口径与 getActiveTaskCount 完全一致：不传 -> 全部（含 null 全局桶）；传 -> 仅该会话
  getActiveCounts(sessionId) {
    const counts = { tasks: 0, agents: 0 };
    for (const entry of this._tasks.values()) {
      if (entry.status !== 'running') continue;
      if (arguments.length === 0 || entry.sessionId === sessionId) {
        if (entry.agentType) counts.agents++;
        else counts.tasks++;
      }
    }
    return counts;
  }

  // 全局桶 usage + 全会话活动任务数 + 最近 running 任务 title（无全局桶 -> 全局桶零值）
  getUsageSnapshot() {
    const g = this._usage.get(GLOBAL_BUCKET) || { totalTokens: 0, contextUsed: 0, contextLimit: 0 };
    return {
      totalTokens: g.totalTokens,
      contextUsed: g.contextUsed,
      contextLimit: g.contextLimit,
      runningTasks: this.getActiveTaskCount(),
      lastTaskTitle: this._lastTaskTitle,
    };
  }

  // 指定会话（null -> 全局桶）的 usage 快照；无该桶 -> null
  getSessionUsage(sessionId) {
    const b = this._usage.get(sessionId || GLOBAL_BUCKET);
    return b
      ? { totalTokens: b.totalTokens, contextUsed: b.contextUsed, contextLimit: b.contextLimit }
      : null;
  }

  // filter.sessionId 过滤；filter.includeTerminal 默认 false（不含终态）
  getTasks(filter = {}) {
    const sessionId = filter && filter.sessionId;
    const includeTerminal = !!(filter && filter.includeTerminal);
    const out = [];
    for (const entry of this._tasks.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (!includeTerminal && entry.terminal) continue;
      out.push({ ...entry });
    }
    return out;
  }

  resetSession(sessionId) {
    for (const [key, entry] of this._tasks) {
      if (entry.sessionId === sessionId) this._tasks.delete(key);
    }
    this._usage.delete(sessionId || GLOBAL_BUCKET);
  }

  clear() {
    this._tasks.clear();
    this._usage.clear();
    this._seq = 0;
    this._lastTaskTitle = '';
    this.truncation = { tasksEvicted: 0, usageBucketsEvicted: 0 };
  }
}

RuntimeState.LIMITS = LIMITS; // M6 资源上限常量（测试/调用方可读）
module.exports = RuntimeState;
