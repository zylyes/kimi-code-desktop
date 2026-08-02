// 任务目录：runtime-state 快照 + ACP 目录观察（cron/tasktool）+ 磁盘 sessions/<sid>/tasks|/cron 合并（无 electron 依赖）
// Phase 5a 扩展版。
// CatalogEntry = { id, kind:'task'|'cron'|'subagent', title, status:'running'|'completed'|'failed'|'removed',
//   source:'ws'|'acp'|'disk', confidence:'high'|'medium'|'low', sessionId, updatedAt, detail? }
// 合并规则：同键冲突 runtime > cronEntries(ACP 观察) > 磁盘；内存终态（completed/failed/removed）不可被 running 覆盖。
// 磁盘扫描失败/文件坏行：跳过并累计 this.diagnostics = { scannedFiles, badFiles, badLines, cronFiles, badCronFiles }。
'use strict';

const fs = require('fs');
const path = require('path');

const { normalizeDiskTask } = require('./runtime-event-normalizer');

const TERMINAL = new Set(['completed', 'failed', 'removed']);
// 磁盘 cron 防御性提取字段：缺字段 -> detail.missing 标注
const CRON_FIELDS = ['schedule', 'description', 'enabled'];
const CRON_STATUSES = new Set(['running', 'completed', 'failed', 'removed']);

class TaskCatalog {
  constructor({ runtimeState, sessionsRoot }) {
    if (!runtimeState) throw new Error('TaskCatalog: runtimeState required');
    this.runtimeState = runtimeState;
    this.sessionsRoot = sessionsRoot || null;
    this.diagnostics = { scannedFiles: 0, badFiles: 0, badLines: 0, cronFiles: 0, badCronFiles: 0 };
    this._seq = 0; // 缺 taskId 条目的合成键序号（磁盘 tasks 与磁盘 cron 共用）
    this._cronEntries = new Map(); // key=`${sessionId||''}:${taskId}` -> cron 观察条目
    this._tasktoolObs = new Map(); // key -> observedAt（与 runtime 同键条目互证，仅刷新 updatedAt）
  }

  // ACP 目录观察入口：接收 normalizeAcpCatalogEvent 输出（null 忽略）
  // cron.observed -> 维护 cronEntries；tasktool.observed -> 与 runtime 同键互证（仅记观察时间，不新建）
  observe(event) {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'cron.observed') {
      this._observeCron(event);
    } else if (event.kind === 'tasktool.observed') {
      const key = `${event.sessionId || ''}:${event.taskId || ''}`;
      if (key.endsWith(':')) return; // taskId 缺失无法互证
      this._tasktoolObs.set(key, event.at || Date.now());
    }
  }

  _observeCron(event) {
    const sessionId = event.sessionId || null;
    const now = event.at || Date.now();
    const action = event.cronAction;

    if (action === 'CronList') {
      // 批量刷新：detail 列表项（rawOutput 解析所得）逐条 upsert
      const items = Array.isArray(event.detail) ? event.detail : [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const id = (typeof item.id === 'string' && item.id) ? item.id
          : (typeof item.name === 'string' && item.name) ? item.name : null;
        if (!id) continue;
        const key = `${sessionId || ''}:${id}`;
        const prev = this._cronEntries.get(key);
        if (prev && TERMINAL.has(prev.status)) continue; // 终态不可被 running 复活
        this._cronEntries.set(key, {
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
        });
      }
      return;
    }

    // CronCreate / CronDelete：键优先取 cron 真实身份（detail 的 id/name），toolCallId 兜底
    const targetId = (event.detail && typeof event.detail === 'object'
      && ((typeof event.detail.id === 'string' && event.detail.id) || (typeof event.detail.name === 'string' && event.detail.name)))
      ? (typeof event.detail.id === 'string' && event.detail.id ? event.detail.id : event.detail.name)
      : event.taskId;
    if (!targetId) return; // 无任何身份标识 -> 无法落键
    const key = `${sessionId || ''}:${targetId}`;
    const prev = this._cronEntries.get(key);
    if (action === 'CronDelete') {
      if (!prev) return; // 未见过的删除 -> 忽略
      if (prev.status !== 'removed') {
        this._cronEntries.set(key, { ...prev, status: 'removed', updatedAt: now, at: now });
      }
      return;
    }
    // CronCreate：建/更新；同键新事件覆盖旧状态，但终态不可被 running 覆盖
    if (prev && TERMINAL.has(prev.status) && event.status === 'running') return;
    this._cronEntries.set(key, {
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
    });
  }

  // 返回 { entries, diagnostics }：runtime 快照优先，ACP cron 观察次之，磁盘 tasks/cron 补充
  async getCatalog(filter = {}) {
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

    // 3. 磁盘补充
    if (this.sessionsRoot) {
      await this._scanDiskTasks(merged, sessionId);
      await this._scanDiskCron(merged, sessionId);
    }

    return { entries: [...merged.values()], diagnostics: { ...this.diagnostics } };
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

  async _scanDiskTasks(merged, sessionId) {
    let sids;
    try {
      sids = await fs.promises.readdir(this.sessionsRoot);
    } catch {
      return; // sessionsRoot 不存在 -> 空，不报错
    }
    for (const sid of sids) {
      if (sessionId !== undefined && sid !== sessionId) continue;
      let files;
      try {
        files = await fs.promises.readdir(path.join(this.sessionsRoot, sid, 'tasks'));
      } catch {
        continue; // 无 tasks 目录 -> 跳过，不报错
      }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        this.diagnostics.scannedFiles++;
        const fp = path.join(this.sessionsRoot, sid, 'tasks', f);
        let text;
        try {
          text = await fs.promises.readFile(fp, 'utf8');
        } catch {
          this.diagnostics.badFiles++;
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          this.diagnostics.badFiles++;
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          this.diagnostics.badLines++; // JSON 合法但不是对象
          continue;
        }
        const event = normalizeDiskTask(sid, parsed);
        if (!event) {
          this.diagnostics.badLines++;
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
  }

  async _scanDiskCron(merged, sessionId) {
    let sids;
    try {
      sids = await fs.promises.readdir(this.sessionsRoot);
    } catch {
      return; // sessionsRoot 不存在 -> 空，不报错
    }
    for (const sid of sids) {
      if (sessionId !== undefined && sid !== sessionId) continue;
      let files;
      try {
        files = await fs.promises.readdir(path.join(this.sessionsRoot, sid, 'cron'));
      } catch {
        continue; // 无 cron 目录 -> 跳过，不报错
      }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const fp = path.join(this.sessionsRoot, sid, 'cron', f);
        let parsed;
        try {
          parsed = JSON.parse(await fs.promises.readFile(fp, 'utf8'));
        } catch {
          this.diagnostics.badCronFiles++;
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          this.diagnostics.badCronFiles++;
          continue;
        }
        this.diagnostics.cronFiles++;
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
  }
}

module.exports = TaskCatalog;
