// 任务目录：runtime-state 快照 + ACP 目录观察（cron/tasktool）+ 磁盘 sessions/<sid>/tasks|/cron 合并（无 electron 依赖）
// Phase 5a 扩展版。
// CatalogEntry = { id, kind:'task'|'cron'|'subagent', title, status:'running'|'completed'|'failed'|'removed',
//   source:'ws'|'acp'|'disk', confidence:'high'|'medium'|'low', sessionId, updatedAt, detail? }
// 合并规则：同键冲突 runtime > cronEntries(ACP 观察) > 磁盘；内存终态（completed/failed/removed）不可被 running 覆盖。
// 磁盘扫描失败/文件坏行：跳过并记录本次 diagnostics = { scannedFiles, badFiles, badLines, cronFiles, badCronFiles, skippedLinks }。
// M6 资源上限：磁盘 tasks/cron JSON 有限读取——单文件大小上限（超限跳过不读）、每类扫描
// 文件数上限、每类累计读取字节上限（超限跳过后续文件）；全部安全跳过不抛，计入本次
// diagnostics（oversized*/skipped*/bytesRead），每次 getCatalog 独立。
'use strict';

const fs = require('fs');
const path = require('path');

const { normalizeDiskTask } = require('./runtime-event-normalizer');

const TERMINAL = new Set(['completed', 'failed', 'removed']);
// 磁盘 cron 防御性提取字段：缺字段 -> detail.missing 标注
const CRON_FIELDS = ['schedule', 'description', 'enabled'];
const CRON_STATUSES = new Set(['running', 'completed', 'failed', 'removed']);

// M6 资源上限（Workspace projection）：磁盘 tasks/cron JSON 有限读取。
// 单文件超对应 MAX_BYTES 跳过不读（JSON 无法安全截断）；每类扫描文件数与累计读取字节
// 均设上限（超限跳过后续文件）；限额动作计入本次 diagnostics，每次调用独立。
// 上限缺口补全：句柄级有限读取（open 后 fstat 取实际大小，超限/超预算跳过，文件增长/替换
// 不突破总预算，bytesRead 反映实际读入）；目录流式有界枚举（opendir 逐个读取，达到候选数
// 上限即停止，不物化无界条目）；in-memory 观察 map（cronEntries/tasktoolObs）与最终 catalog
// 条目上限（确定性截断/驱逐，truncation 可见）；均不抛。
const LIMITS = {
  TASK_MAX_BYTES: 512 * 1024, // 单个 task JSON 文件大小上限（超出跳过不读）
  TASK_MAX_FILES: 200, // 单次调用 tasks 扫描文件数上限（超出跳过）
  TASK_TOTAL_BYTES: 4 * 1024 * 1024, // 单次调用 tasks 累计读取字节上限（超出跳过）
  CRON_MAX_BYTES: 512 * 1024, // 单个 cron JSON 文件大小上限（超出跳过不读）
  CRON_MAX_FILES: 100, // 单次调用 cron 扫描文件数上限（超出跳过）
  CRON_TOTAL_BYTES: 2 * 1024 * 1024, // 单次调用 cron 累计读取字节上限（超出跳过）
  TASK_ENUM_MAX: 250, // tasks 目录枚举候选上限（达到即停止，剩余条目不读）
  CRON_ENUM_MAX: 150, // cron 目录枚举候选上限（达到即停止，剩余条目不读）
  SESSION_ENUM_MAX: 500, // 遗留全量扫描时 sessionsRoot 会话目录枚举上限（达到即停止）
  SESSION_DIR_ENTRY_MAX: 100, // 单会话根目录条目枚举上限（达到即停止）
  MAX_CRON_ENTRIES: 500, // in-memory cron 观察条目上限（超出驱逐 at 最老者）
  MAX_OBS_ENTRIES: 500, // in-memory tasktool 互证记录上限（超出驱逐最老者）
  MAX_CATALOG_ENTRIES: 5000, // 最终 catalog 条目上限（超出按 at 降序确定性截断）
};

// M6 流式有界目录枚举：opendir 逐个读取（不一次物化无界条目），最多取 maxItems 个条目，
// 达到即停止并标记 truncated（剩余条目不读、不 stat）。打开失败 -> null（调用方按空处理）。
async function readDirBounded(dirPath, maxItems) {
  let dh;
  try {
    dh = await fs.promises.opendir(dirPath);
  } catch {
    return null;
  }
  try {
    const entries = [];
    let truncated = false;
    for (;;) {
      const ent = await dh.read();
      if (!ent) break;
      entries.push(ent);
      if (entries.length >= maxItems) {
        truncated = true;
        break;
      }
    }
    return { entries, truncated };
  } finally {
    try { await dh.close(); } catch { /* ignore */ }
  }
}

// M6 句柄级有限读取 task/cron JSON：open 后 fstat 取句柄实际大小——超 maxBytes（oversized）
// 或超剩余预算 budget（budget）跳过不读（JSON 无法安全截断）；否则按 fstat.size 精确读取，
// 文件在打开后增长/被替换也不会突破预算（绝无整文件无界 readFile）。bytesRead 为实际读入。
// 返回 { ok:true, text, bytesRead } | { ok:false, reason:'open'|'stat'|'oversized'|'budget' }。
async function readJsonBounded(filePath, maxBytes, budget) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
  } catch {
    return { ok: false, reason: 'open' };
  }
  try {
    let size;
    try {
      size = (await fh.stat()).size;
    } catch {
      return { ok: false, reason: 'stat' };
    }
    if (size > maxBytes) return { ok: false, reason: 'oversized' };
    if (size > budget) return { ok: false, reason: 'budget' };
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const r = await fh.read(buf, read, size - read, read);
      if (!r || r.bytesRead <= 0) break;
      read += r.bytesRead;
    }
    return { ok: true, bytesRead: read, text: buf.toString('utf8', 0, read) };
  } finally {
    try { await fh.close(); } catch { /* ignore */ }
  }
}

function freshDiagnostics() {
  return {
    scannedFiles: 0, badFiles: 0, badLines: 0, cronFiles: 0, badCronFiles: 0, skippedLinks: 0,
    oversizedFiles: 0, skippedFiles: 0, bytesRead: 0, // M6：task JSON 超大小/超限跳过/实际读取字节
    oversizedCronFiles: 0, skippedCronFiles: 0, cronBytesRead: 0, // M6：cron JSON 同口径
    enumerateTruncated: false, entriesTruncated: false, // M6 缺口：目录枚举/最终条目被有界截断
  };
}

class TaskCatalog {
  constructor({ runtimeState, sessionsRoot }) {
    if (!runtimeState) throw new Error('TaskCatalog: runtimeState required');
    this.runtimeState = runtimeState;
    this.sessionsRoot = sessionsRoot || null;
    this.diagnostics = freshDiagnostics(); // 兼容快照：始终等于最近一次 getCatalog 的本次 diagnostics
    this._seq = 0; // 缺 taskId 条目的合成键序号（磁盘 tasks 与磁盘 cron 共用）
    this._cronEntries = new Map(); // key=`${sessionId||''}:${taskId}` -> cron 观察条目
    this._tasktoolObs = new Map(); // key -> observedAt（与 runtime 同键条目互证，仅刷新 updatedAt）
    this.truncation = { cronEntriesEvicted: 0, tasktoolObsEvicted: 0, catalogTruncated: false }; // M6：条目上限截断/驱逐可见
  }

  // M6 确定性驱逐：map 达到 max 且插入新键时，删除 at 最小（相等取 Map 最早插入）的条目，
  // 驱逐数计入 truncation[statKey]。不抛。
  _evictIfFull(map, max, statKey) {
    if (map.size < max) return;
    let oldestKey = null;
    let oldestVal = Infinity;
    for (const [k, v] of map) {
      const t = typeof v === 'number' ? v : (v && typeof v.at === 'number' ? v.at : Infinity);
      if (t < oldestVal) {
        oldestVal = t;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) {
      map.delete(oldestKey);
      this.truncation[statKey]++;
    }
  }

  // ACP 目录观察入口：接收 normalizeAcpCatalogEvent 输出（null 忽略）。
  // cron.observed -> 维护 cronEntries；tasktool.observed -> 与 runtime 同键互证（仅记观察时间，不新建）。
  // 返回 boolean：实际写入/更新观察状态并改变 catalog 可见状态（cronEntries 实际变更；
  // tasktool 互证刷新 runtime 同键条目的可见 updatedAt = max(runtime.at, obsAt)）时 true；
  // 重复等价事件 / 无可见影响（无效事件、taskId 缺失、无 runtime 同键、at 未超过 runtime.at）恒 false。
  observe(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.kind === 'cron.observed') {
      return this._observeCron(event);
    } else if (event.kind === 'tasktool.observed') {
      const key = `${event.sessionId || ''}:${event.taskId || ''}`;
      if (key.endsWith(':')) return false; // taskId 缺失无法互证
      const now = event.at || Date.now();
      const prev = this._tasktoolObs.get(key);
      // 互证仅影响 catalog 中 runtime 同键条目的可见 updatedAt（max(runtime.at, obsAt)）
      const rt = this.runtimeState.getTasks({ sessionId: event.sessionId || undefined, includeTerminal: true })
        .find((t) => t.key === key);
      if (!rt) return false; // 无 runtime 同键：互证不参与 catalog，可见状态不变
      if (prev !== undefined && now <= prev) return false; // 重复等价/倒退观察：不更新
      if (now <= rt.at) return false; // 新观察未超过 runtime.at：可见 updatedAt 不变（不记录）
      this._evictIfFull(this._tasktoolObs, LIMITS.MAX_OBS_ENTRIES, 'tasktoolObsEvicted'); // M6：条目上限确定性驱逐
      this._tasktoolObs.set(key, now);
      return true;
    }
    return false;
  }

  // 实际变更判定：键不存在 / status / title / cronAction / detail 任一不同 -> 变更
  _cronEntryChanged(prev, next) {
    if (!prev) return true;
    return prev.status !== next.status
      || prev.title !== next.title
      || prev.cronAction !== next.cronAction
      || JSON.stringify(prev.detail || null) !== JSON.stringify(next.detail || null);
  }

  _observeCron(event) {
    const sessionId = event.sessionId || null;
    const now = event.at || Date.now();
    const action = event.cronAction;

    if (action === 'CronList') {
      // 批量刷新：detail 列表项（rawOutput 解析所得）逐条 upsert
      let changed = false;
      const items = Array.isArray(event.detail) ? event.detail : [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const id = (typeof item.id === 'string' && item.id) ? item.id
          : (typeof item.name === 'string' && item.name) ? item.name : null;
        if (!id) continue;
        const key = `${sessionId || ''}:${id}`;
        const prev = this._cronEntries.get(key);
        if (prev && TERMINAL.has(prev.status)) continue; // 终态不可被 running 复活
        const next = {
          id: key,
          key,
          kind: 'cron',
          title: (typeof item.description === 'string' && item.description) ? item.description
            : (typeof item.name === 'string' && item.name) ? item.name : '',
          status: 'running', // 列表展示的都是现存计划
          source: 'acp',
          confidence: 'low', // ACP 平面观察，生命周期可见性有限
          sessionId,
          taskId: id,
          updatedAt: now,
          at: now,
          detail: item,
          cronAction: action,
        };
        if (this._cronEntryChanged(prev, next)) {
          if (!prev) this._evictIfFull(this._cronEntries, LIMITS.MAX_CRON_ENTRIES, 'cronEntriesEvicted'); // M6：上限确定性驱逐
          this._cronEntries.set(key, next);
          changed = true;
        }
      }
      return changed;
    }

    // CronCreate / CronDelete：键优先取 cron 真实身份（detail 的 id/name），toolCallId 兜底
    const targetId = (event.detail && typeof event.detail === 'object'
      && ((typeof event.detail.id === 'string' && event.detail.id) || (typeof event.detail.name === 'string' && event.detail.name)))
      ? (typeof event.detail.id === 'string' && event.detail.id ? event.detail.id : event.detail.name)
      : event.taskId;
    if (!targetId) return false; // 无任何身份标识 -> 无法落键
    const key = `${sessionId || ''}:${targetId}`;
    const prev = this._cronEntries.get(key);
    if (action === 'CronDelete') {
      if (!prev) return false; // 未见过的删除 -> 忽略
      if (prev.status !== 'removed') {
        this._cronEntries.set(key, { ...prev, status: 'removed', updatedAt: now, at: now });
        return true;
      }
      return false;
    }
    // CronCreate：建/更新；同键新事件覆盖旧状态，但终态不可被 running 覆盖
    if (prev && TERMINAL.has(prev.status) && event.status === 'running') return false;
    const next = {
      id: key,
      key,
      kind: 'cron',
      title: event.title || '',
      status: event.status,
      source: 'acp',
      confidence: 'low',
      sessionId,
      taskId: targetId,
      updatedAt: now,
      at: now,
      detail: event.detail || {},
      cronAction: action,
    };
    if (this._cronEntryChanged(prev, next)) {
      if (!prev) this._evictIfFull(this._cronEntries, LIMITS.MAX_CRON_ENTRIES, 'cronEntriesEvicted'); // M6：上限确定性驱逐
      this._cronEntries.set(key, next);
      return true;
    }
    return false;
  }

  // 返回 { entries, diagnostics }：runtime 快照优先，ACP cron 观察次之，磁盘 tasks/cron 补充
  // filter.sessionDir（可选）：已核验的具体会话目录，提供时磁盘扫描只读该目录的 tasks/cron，
  // 不做 sessionsRoot 全量扫描；无 sessionDir 的遗留 chat 调用保持旧全量扫描（只读 tasks/cron 子目录）。
  // sessionDir 三态：absent（未提供 -> 遗留全量扫描）/ direct（已验证 -> 只直读该目录）/ invalid（绝不读盘）。
  // diagnostics 每次调用独立创建（不共享不累积），结束后覆盖 this.diagnostics 作为兼容快照。
  async getCatalog(filter = {}) {
    const diagnostics = freshDiagnostics();
    const merged = new Map();
    const sessionId = filter && filter.sessionId;
    const inScope = (sid) => sessionId === undefined || sid === sessionId;

    // 1. runtime 快照优先（含终态）：agentType 非空 -> subagent，其余 -> task；字段直译
    for (const t of this.runtimeState.getTasks({ sessionId, includeTerminal: true })) {
      const obsAt = this._tasktoolObs.get(t.key);
      merged.set(t.key, {
        id: t.key,
        key: t.key,
        kind: t.agentType ? 'subagent' : 'task',
        title: t.title,
        status: t.status,
        source: t.source,
        confidence: t.confidence,
        sessionId: t.sessionId,
        taskId: t.taskId,
        updatedAt: obsAt ? Math.max(t.at, obsAt) : t.at,
        at: t.at,
        rawKind: t.rawKind,
        terminal: t.terminal,
      });
    }

    // 2. ACP cron 观察（cronEntries > 磁盘）；runtime 同键赢（优先级 runtime > cronEntries）
    for (const entry of this._cronEntries.values()) {
      if (!inScope(entry.sessionId)) continue;
      if (merged.has(entry.key)) continue;
      merged.set(entry.key, entry);
    }

    // 3. 磁盘补充：sessionDir 三态——direct 直读该目录；absent 遗留全量扫描；invalid 绝不读盘
    const mode = this._validateSessionDir(sessionId, filter && filter.sessionDir, diagnostics);
    if (mode.status === 'direct' || mode.status === 'absent') {
      await this._scanDiskTasks(merged, sessionId, mode, diagnostics);
      await this._scanDiskCron(merged, sessionId, mode, diagnostics);
    }

    // M6 上限：最终 catalog 条目上限——超限按 at 降序（最新优先）确定性截断，
    // 计入 diagnostics.entriesTruncated 与 this.truncation.catalogTruncated，不抛。
    // 小数据不触发排序，既有输出顺序保持。
    let entries = [...merged.values()];
    let entriesTruncated = false;
    if (entries.length > LIMITS.MAX_CATALOG_ENTRIES) {
      entries.sort((a, b) => (b.at || 0) - (a.at || 0));
      entries.length = LIMITS.MAX_CATALOG_ENTRIES;
      entriesTruncated = true;
    }
    diagnostics.entriesTruncated = entriesTruncated;
    this.truncation.catalogTruncated = entriesTruncated;

    this.diagnostics = diagnostics;
    return { entries, diagnostics: { ...diagnostics } };
  }

  // 防御校验 sessionDir，三态返回（never null）：
  //   absent  -> { status:'absent' }                         未提供（undefined/null）才允许遗留全量扫描
  //   invalid -> { status:'invalid', reason }                已提供但非法：写本次 diagnostics.invalidSessionDir，绝不读盘
  //   direct  -> { status:'direct', dir, sessionId }         已验证：只直读该会话目录
  // invalid 覆盖：非字符串/空 -> 'not-string'、sessionsRoot 缺失 -> 'no-root'、
  // lexical 越界（..逃逸/绝对/不同盘/等于根本身）-> 'outside-root'、目录本体 symlink/junction -> 'symlink-denied'、
  // 普通文件等非目录 -> 'not-directory'、目录不存在（lstat/realpath 失败）-> 'not-found'、
  // realpath 后越界 -> 'realpath-outside'、canonical sessionDir 的 basename 与 filter.sessionId 错配 -> 'session-id-mismatch'。
  _validateSessionDir(sessionId, sessionDir, diagnostics) {
    if (sessionDir === undefined || sessionDir === null) {
      return { status: 'absent' }; // 未提供 -> 走旧全量扫描
    }
    const invalid = (reason) => {
      diagnostics.invalidSessionDir = reason;
      return { status: 'invalid', reason };
    };
    if (typeof sessionDir !== 'string' || sessionDir.length === 0) return invalid('not-string');
    if (!this.sessionsRoot) return invalid('no-root');
    const root = path.resolve(this.sessionsRoot);
    const dir = path.resolve(sessionDir);
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
      return invalid('outside-root');
    }
    // 目录本体不得是 symlink/junction：lstat 拒绝，不跟随
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      return invalid('not-found');
    }
    if (st.isSymbolicLink()) return invalid('symlink-denied');
    // 普通文件等非目录不得视作 direct：lstat 为目录才允许后续 realpath/绑定检查
    if (!st.isDirectory()) return invalid('not-directory');
    // sessionsRoot 与 sessionDir 均 canonical 化（realpath）再 containment 检查
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      return invalid('root-not-found');
    }
    let realDir;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return invalid('not-found');
    }
    const realRel = path.relative(realRoot, realDir);
    if (realRel.startsWith('..') || path.isAbsolute(realRel) || realRel === '') {
      return invalid('realpath-outside');
    }
    // 会话 ID 绑定：canonical sessionDir 的 basename 必须等于 filter.sessionId，错配绝不读盘
    const dirSessionId = path.basename(realDir);
    if (typeof sessionId !== 'string' || sessionId.length === 0 || dirSessionId !== sessionId) {
      return invalid('session-id-mismatch');
    }
    return { status: 'direct', dir, sessionId: dirSessionId };
  }

  // 会话清理：删除该会话的 cronEntries 与 tasktool 互证记录（会话切换时调用）
  clearSession(sessionId) {
    const prefix = `${sessionId || ''}:`;
    for (const key of [...this._cronEntries.keys()]) {
      if (key.startsWith(prefix)) this._cronEntries.delete(key);
    }
    for (const key of [...this._tasktoolObs.keys()]) {
      if (key.startsWith(prefix)) this._tasktoolObs.delete(key);
    }
  }

  // mode 三态：direct -> 只读该会话目录的 tasks；absent -> 遗留全量扫描 sessionsRoot（只读 tasks 子目录）；
  // invalid -> 绝不调用本函数。目录/枚举一律流式有界枚举（opendir 逐个读取，达到候选上限即停止，
  // 不物化无界条目，截断标记 enumerateTruncated），文件读取代以句柄级有限读取
  // （readJsonBounded：open 后 fstat 实际大小，超上限/预算跳过，文件增长/替换不突破总预算）；
  // symlink/junction 跳过不跟随（skippedLinks++）。
  async _scanDiskTasks(merged, sessionId, mode, diagnostics) {
    const dirs = [];
    if (mode.status === 'direct') {
      dirs.push({ sid: mode.sessionId, sessionDir: mode.dir });
    } else {
      // absent：遗留全量扫描 sessionsRoot 下每个会话的 tasks 子目录（流式有界枚举）
      const rootEnts = await readDirBounded(this.sessionsRoot, LIMITS.SESSION_ENUM_MAX);
      if (!rootEnts) {
        return; // sessionsRoot 不存在 -> 空，不报错
      }
      if (rootEnts.truncated) diagnostics.enumerateTruncated = true;
      for (const ent of rootEnts.entries) {
        const sid = typeof ent === 'string' ? ent : ent.name;
        if (sessionId !== undefined && sid !== sessionId) continue;
        if (typeof ent !== 'string' && ent.isSymbolicLink()) {
          diagnostics.skippedLinks++; // 会话目录本体是链接 -> 跳过
          continue;
        }
        dirs.push({ sid, sessionDir: path.join(this.sessionsRoot, sid) });
      }
    }
    let filesTried = 0; // 已尝试读取的 task JSON 数（文件数上限，跨会话累计）
    let bytesRead = 0; // 已读取字节（总预算，跨会话累计；实际读入，非预检大小）
    for (const { sid, sessionDir } of dirs) {
      const sessionEnts = await readDirBounded(sessionDir, LIMITS.SESSION_DIR_ENTRY_MAX);
      if (!sessionEnts) continue; // 目录不存在 -> 跳过，不报错
      if (sessionEnts.truncated) diagnostics.enumerateTruncated = true;
      const tasksEnt = sessionEnts.entries.find((e) => (typeof e === 'string' ? e : e.name) === 'tasks');
      if (!tasksEnt) continue; // 无 tasks 目录 -> 跳过
      if (typeof tasksEnt !== 'string' && tasksEnt.isSymbolicLink()) {
        diagnostics.skippedLinks++; // tasks 目录是 junction/symlink -> 不跟随
        continue;
      }
      const files = await readDirBounded(path.join(sessionDir, 'tasks'), LIMITS.TASK_ENUM_MAX);
      if (!files) continue;
      if (files.truncated) diagnostics.enumerateTruncated = true;
      for (const ent of files.entries) {
        const name = typeof ent === 'string' ? ent : ent.name;
        if (!name.endsWith('.json')) continue;
        if (typeof ent !== 'string' && ent.isSymbolicLink()) {
          diagnostics.skippedLinks++; // 枚举文件是 symlink -> 不读
          continue;
        }
        if (filesTried >= LIMITS.TASK_MAX_FILES) { diagnostics.skippedFiles++; continue; } // 文件数上限
        if (bytesRead >= LIMITS.TASK_TOTAL_BYTES) { diagnostics.skippedFiles++; continue; } // 总字节预算耗尽
        diagnostics.scannedFiles++;
        const fp = path.join(sessionDir, 'tasks', name);
        const rr = await readJsonBounded(fp, LIMITS.TASK_MAX_BYTES, LIMITS.TASK_TOTAL_BYTES - bytesRead);
        if (!rr.ok && (rr.reason === 'open' || rr.reason === 'stat')) {
          diagnostics.badFiles++;
          continue;
        }
        filesTried++; // 句柄 fstat 成功即占配额（超大小/预算不足同配额，与既有口径一致）
        if (!rr.ok && rr.reason === 'oversized') { diagnostics.oversizedFiles++; continue; } // 超单文件上限：不读
        if (!rr.ok && rr.reason === 'budget') { diagnostics.skippedFiles++; continue; } // 预算不足：不读
        bytesRead += rr.bytesRead; // 实际读入字节（句柄级大小）
        let parsed;
        try {
          parsed = JSON.parse(rr.text);
        } catch {
          diagnostics.badFiles++;
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          diagnostics.badLines++; // JSON 合法但不是对象
          continue;
        }
        const event = normalizeDiskTask(sid, parsed);
        if (!event) {
          diagnostics.badLines++;
          continue;
        }
        const key = event.taskId
          ? `${event.sessionId || ''}:${event.taskId}`
          : `unknown:${++this._seq}`;
        if (merged.has(key)) continue; // 同键冲突：内存（runtime/cronEntries）赢
        merged.set(key, {
          id: key,
          key,
          kind: 'task',
          title: event.title,
          status: event.status,
          source: 'disk',
          confidence: 'medium',
          sessionId: event.sessionId,
          taskId: event.taskId,
          updatedAt: event.at,
          at: event.at,
          rawKind: event.rawKind,
          terminal: event.status === 'completed' || event.status === 'failed',
        });
      }
    }
    diagnostics.bytesRead += bytesRead; // 本次调用 tasks 实际读取字节（M6 可见性）
  }

  // mode 三态同 _scanDiskTasks；cron 目录/枚举文件同拒绝链接（skippedLinks++）。
  // 同样使用流式有界枚举（readDirBounded）与句柄级有限读取（readJsonBounded）。
  async _scanDiskCron(merged, sessionId, mode, diagnostics) {
    const dirs = [];
    if (mode.status === 'direct') {
      dirs.push({ sid: mode.sessionId, sessionDir: mode.dir });
    } else {
      const rootEnts = await readDirBounded(this.sessionsRoot, LIMITS.SESSION_ENUM_MAX);
      if (!rootEnts) {
        return; // sessionsRoot 不存在 -> 空，不报错
      }
      if (rootEnts.truncated) diagnostics.enumerateTruncated = true;
      for (const ent of rootEnts.entries) {
        const sid = typeof ent === 'string' ? ent : ent.name;
        if (sessionId !== undefined && sid !== sessionId) continue;
        if (typeof ent !== 'string' && ent.isSymbolicLink()) {
          diagnostics.skippedLinks++;
          continue;
        }
        dirs.push({ sid, sessionDir: path.join(this.sessionsRoot, sid) });
      }
    }
    let filesTried = 0; // 已尝试读取的 cron JSON 数（文件数上限，跨会话累计）
    let bytesRead = 0; // 已读取字节（总预算，跨会话累计；实际读入，非预检大小）
    for (const { sid, sessionDir } of dirs) {
      const sessionEnts = await readDirBounded(sessionDir, LIMITS.SESSION_DIR_ENTRY_MAX);
      if (!sessionEnts) continue; // 目录不存在 -> 跳过，不报错
      if (sessionEnts.truncated) diagnostics.enumerateTruncated = true;
      const cronEnt = sessionEnts.entries.find((e) => (typeof e === 'string' ? e : e.name) === 'cron');
      if (!cronEnt) continue; // 无 cron 目录 -> 跳过
      if (typeof cronEnt !== 'string' && cronEnt.isSymbolicLink()) {
        diagnostics.skippedLinks++; // cron 目录是 junction/symlink -> 不跟随
        continue;
      }
      const files = await readDirBounded(path.join(sessionDir, 'cron'), LIMITS.CRON_ENUM_MAX);
      if (!files) continue;
      if (files.truncated) diagnostics.enumerateTruncated = true;
      for (const ent of files.entries) {
        const name = typeof ent === 'string' ? ent : ent.name;
        if (!name.endsWith('.json')) continue;
        if (typeof ent !== 'string' && ent.isSymbolicLink()) {
          diagnostics.skippedLinks++; // 枚举文件是 symlink -> 不读
          continue;
        }
        if (filesTried >= LIMITS.CRON_MAX_FILES) { diagnostics.skippedCronFiles++; continue; } // 文件数上限
        if (bytesRead >= LIMITS.CRON_TOTAL_BYTES) { diagnostics.skippedCronFiles++; continue; } // 总字节预算耗尽
        const fp = path.join(sessionDir, 'cron', name);
        const rr = await readJsonBounded(fp, LIMITS.CRON_MAX_BYTES, LIMITS.CRON_TOTAL_BYTES - bytesRead);
        if (!rr.ok && (rr.reason === 'open' || rr.reason === 'stat')) {
          diagnostics.badCronFiles++;
          continue;
        }
        filesTried++; // 句柄 fstat 成功即占配额
        if (!rr.ok && rr.reason === 'oversized') { diagnostics.oversizedCronFiles++; continue; } // 超单文件上限：不读
        if (!rr.ok && rr.reason === 'budget') { diagnostics.skippedCronFiles++; continue; } // 预算不足：不读
        let parsed;
        try {
          parsed = JSON.parse(rr.text);
        } catch {
          diagnostics.badCronFiles++;
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          diagnostics.badCronFiles++;
          continue;
        }
        bytesRead += rr.bytesRead; // 实际读入字节（句柄级大小）
        diagnostics.cronFiles++;
        const id = (typeof parsed.id === 'string' && parsed.id) ? parsed.id
          : (typeof parsed.name === 'string' && parsed.name) ? parsed.name : null;
        const key = id ? `${sid}:${id}` : `unknown:${++this._seq}`;
        if (merged.has(key)) continue; // 内存（runtime/cronEntries）赢；磁盘 running 不覆盖内存终态
        // 防御性提取 + 缺字段 missing 标注
        const detail = {};
        const missing = [];
        for (const k of CRON_FIELDS) {
          if (parsed[k] !== undefined && parsed[k] !== null) {
            detail[k] = typeof parsed[k] === 'string' ? parsed[k].slice(0, 120) : parsed[k];
          } else {
            missing.push(k);
          }
        }
        if (missing.length) detail.missing = missing;
        // status 防御性直译；缺省时 cron 计划文件存在即视为活跃
        let status = 'running';
        if (typeof parsed.status === 'string' && CRON_STATUSES.has(parsed.status)) status = parsed.status;
        let mtime = Date.now();
        try { mtime = fs.statSync(fp).mtimeMs; } catch { /* ignore */ }
        merged.set(key, {
          id: key,
          key,
          kind: 'cron',
          title: typeof parsed.description === 'string' ? parsed.description : (id || ''),
          status,
          source: 'disk',
          confidence: 'medium',
          sessionId: sid,
          taskId: id,
          updatedAt: mtime,
          at: mtime,
          detail,
        });
      }
    }
    diagnostics.cronBytesRead += bytesRead; // 本次调用 cron 实际读取字节（M6 可见性）
  }
}

TaskCatalog.LIMITS = LIMITS; // M6 资源上限常量（测试/调用方可读）
module.exports = TaskCatalog;
