// Kimi Code Desktop — 本地会话用量统计
// 流式扫描 sessionsRoot/<wdKey>/<sessionId>/agents/*/wire.jsonl 中的 usage.record 行，
// 提供 today / 7d / 30d 本地时区分桶统计：
// - 只聚合 usageScope:"turn" 的记录，逐条累加；usageScope:"session" 的记录仅读取并计数
//   （diagnostics.sessionRecords），不参与任何聚合（其值为截至 time 的历史累计，无法按时间窗口分桶）。
// - 窗口内 turnRecords===0 且 sessionRecords>0 时：summary.partial=true 且
//   diagnostics.reason="session-scope-only"，聚合值全零（不做差分/取代推断）。
// - wire.jsonl 非稳定契约，全部防御性解析（坏行 / 缺 usage / 坏 time 跳过），
//   扫描结果按 TTL 缓存，诊断信息经 diagnostics 暴露（scannedFiles/matchedRecords/badLines/sessionRecords/partial）。
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RANGES = ['today', '7d', '30d'];
const SCHEMA_VERSION = 1;

// 数值容错：number / 数字字符串 → 非负整数；非法 / Infinity / NaN / 负数 → 0
function toNumber(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

function emptyBucket() {
  return { requests: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, totalTokens: 0 };
}

// 解析一行 JSONL：{ ok:true, record } | { ok:false, reason }
// reason: 'bad-json'（坏行）| 'not-usage'（非 usage.record 的正常行，不计数）| 'no-usage' | 'bad-time'
function parseUsageRecord(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev) || ev.type !== 'usage.record') {
    return { ok: false, reason: 'not-usage' };
  }
  const usage = ev.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return { ok: false, reason: 'no-usage' };
  }
  const time = toNumber(ev.time);
  if (time <= 0) return { ok: false, reason: 'bad-time' };
  const inputOther = toNumber(usage.inputOther);
  const output = toNumber(usage.output);
  const inputCacheRead = toNumber(usage.inputCacheRead);
  const inputCacheCreation = toNumber(usage.inputCacheCreation);
  const totalTokens = toNumber(usage.totalTokens) || (inputOther + output + inputCacheRead + inputCacheCreation);
  return {
    ok: true,
    record: {
      model: typeof ev.model === 'string' && ev.model ? ev.model : 'unknown',
      usageScope: ev.usageScope === 'session' ? 'session' : 'turn',
      time,
      bucket: { inputOther, output, inputCacheRead, inputCacheCreation, totalTokens },
    },
  };
}

// 将一条记录并入目标桶（requests 按记录数累加）
function mergeBucket(target, record) {
  target.requests += 1;
  target.inputOther += record.bucket.inputOther;
  target.output += record.bucket.output;
  target.inputCacheRead += record.bucket.inputCacheRead;
  target.inputCacheCreation += record.bucket.inputCacheCreation;
  target.totalTokens += record.bucket.totalTokens;
}

// 本地日期键 YYYY-MM-DD（基于本地时区）
function dateKey(ms) {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function finalizeDiag(diag) {
  return {
    scannedFiles: diag.scannedFiles,
    matchedRecords: diag.matchedRecords,
    badLines: diag.badLines,
    sessionRecords: diag.sessionRecords,
    partial: diag.badLines > 0 || diag._skippedRecords > 0 || diag._readFailures > 0,
  };
}

// 记录归属的 series 桶键：today 按本地小时 HH，7d/30d 按本地日期 YYYY-MM-DD
function bucketKeyFor(time, range) {
  if (range === 'today') {
    return String(new Date(time).getHours()).padStart(2, '0');
  }
  return dateKey(time);
}

// 由扫描结果构造快照：窗口过滤 + 分桶 + 补零（series 覆盖完整窗口，缺数据填 0）
// records 仅含 turn 记录（参与聚合）；sessionRecords 仅计数（不参与聚合），
// 窗口内无 turn 但有 session 记录时标记 partial（reason="session-scope-only"）。
function buildSnapshot(records, sessionRecords, diagnostics, range, nowMs) {
  const local = new Date(nowMs);
  const dayMs = 86400000;
  const todayStart = new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime();
  const startMs = range === 'today' ? todayStart
    : range === '7d' ? todayStart - 6 * dayMs
    : todayStart - 29 * dayMs;
  const endMs = nowMs;

  const summary = emptyBucket();
  const byModel = new Map();
  const seriesMap = new Map();
  const keys = [];
  if (range === 'today') {
    for (let h = 0; h <= local.getHours(); h++) {
      const k = String(h).padStart(2, '0');
      keys.push(k);
      seriesMap.set(k, emptyBucket());
    }
  } else {
    const days = range === '7d' ? 7 : 30;
    const d = new Date(startMs);
    for (let i = 0; i < days; i++) {
      const k = dateKey(d.getTime());
      keys.push(k);
      seriesMap.set(k, emptyBucket());
      d.setDate(d.getDate() + 1);
    }
  }

  let turnRecords = 0;
  for (const r of records) {
    if (r.time < startMs || r.time > endMs) continue;
    turnRecords += 1;
    mergeBucket(summary, r);
    let mb = byModel.get(r.model);
    if (!mb) { mb = emptyBucket(); byModel.set(r.model, mb); }
    mergeBucket(mb, r);
    const sb = seriesMap.get(bucketKeyFor(r.time, range));
    if (sb) mergeBucket(sb, r);
  }
  let inWindowSession = 0;
  for (const r of sessionRecords || []) {
    if (r.time >= startMs && r.time <= endMs) inWindowSession += 1;
  }

  let timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { timezone = ''; }

  // 窗口内无 turn 记录但存在 session 记录：数据不足以推断用量，标记 partial 并保持聚合值全零
  const diagOut = { ...diagnostics };
  if (turnRecords === 0 && inWindowSession > 0) {
    summary.partial = true;
    diagOut.reason = 'session-scope-only';
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    range,
    summary,
    series: keys.map((k) => ({ key: k, ...seriesMap.get(k) })),
    byModel: [...byModel.entries()]
      .map(([model, b]) => ({ model, ...b }))
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
    window: { startMs, endMs, timezone },
    diagnostics: diagOut,
  };
}

class UsageStats {
  constructor({ sessionsRoot, now = () => Date.now(), cacheTtlMs = 30000, readStreamImpl = null } = {}) {
    if (!sessionsRoot) throw new Error('sessionsRoot is required');
    this.sessionsRoot = sessionsRoot;
    this._now = now;
    this.cacheTtlMs = cacheTtlMs;
    this._readStream = readStreamImpl || ((p) => fs.createReadStream(p, { encoding: 'utf8' }));
    this._cache = null;
  }

  _assertRange(range) {
    if (!RANGES.includes(range)) throw new Error(`unsupported range: ${range}`);
  }

  // 快照：缓存未过期直接复用扫描结果，否则重新扫描
  async snapshot(range) {
    this._assertRange(range);
    const nowMs = this._now();
    if (this._cache && nowMs - this._cache.scannedAt < this.cacheTtlMs) {
      return buildSnapshot(this._cache.records, this._cache.sessionRecords, this._cache.diagnostics, range, nowMs);
    }
    return this.compute(range);
  }

  // 强制重算：忽略缓存重新扫描并刷新缓存
  async compute(range) {
    this._assertRange(range);
    const { records, sessionRecords, diagnostics } = await this._scan();
    this._cache = { records, sessionRecords, diagnostics, scannedAt: this._now() };
    return buildSnapshot(records, sessionRecords, diagnostics, range, this._now());
  }

  invalidate() {
    this._cache = null;
  }

  // 流式扫描单个 wire.jsonl：逐行解析，坏行 / 残缺行计数
  // 返回 { records: turn 记录（参与聚合）, sessionRecords: session 记录（仅计数） }
  _scanFile(filePath, diag) {
    return new Promise((resolve) => {
      const records = [];
      const sessionRecords = [];
      let failed = false;
      const stream = this._readStream(filePath);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      const finish = () => {
        diag.scannedFiles += 1;
        if (failed) diag._readFailures += 1;
        resolve({ records, sessionRecords });
      };
      stream.on('error', () => { failed = true; rl.close(); });
      rl.on('error', () => { failed = true; rl.close(); });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const r = parseUsageRecord(line);
        if (r.ok) {
          diag.matchedRecords += 1;
          if (r.record.usageScope === 'session') {
            sessionRecords.push(r.record);
            diag.sessionRecords += 1;
          } else {
            records.push(r.record);
          }
        } else if (r.reason === 'bad-json') {
          diag.badLines += 1;
        } else if (r.reason !== 'not-usage') {
          diag._skippedRecords += 1;
        }
      });
      rl.on('close', finish);
    });
  }

  // 遍历 sessionsRoot/<wdKey>/<sessionId>/agents/*/wire.jsonl
  // 只聚合 usageScope:"turn" 的记录；"session" 记录仅收集（buildSnapshot 中计数，不参与聚合）
  async _scan() {
    const diag = { scannedFiles: 0, matchedRecords: 0, badLines: 0, sessionRecords: 0, _skippedRecords: 0, _readFailures: 0 };
    const records = [];
    const sessionRecords = [];
    let wdEntries = [];
    try {
      wdEntries = await fs.promises.readdir(this.sessionsRoot, { withFileTypes: true });
    } catch {
      return { records, sessionRecords, diagnostics: finalizeDiag(diag) };
    }
    for (const wd of wdEntries) {
      if (!wd.isDirectory()) continue;
      let sessionEntries = [];
      try {
        sessionEntries = await fs.promises.readdir(path.join(this.sessionsRoot, wd.name), { withFileTypes: true });
      } catch { continue; }
      for (const sid of sessionEntries) {
        if (!sid.isDirectory()) continue;
        const agentsRoot = path.join(this.sessionsRoot, wd.name, sid.name, 'agents');
        let agentEntries = [];
        try {
          agentEntries = await fs.promises.readdir(agentsRoot, { withFileTypes: true });
        } catch { continue; }
        for (const ag of agentEntries) {
          if (!ag.isDirectory()) continue;
          const wirePath = path.join(agentsRoot, ag.name, 'wire.jsonl');
          let st = null;
          try { st = await fs.promises.stat(wirePath); } catch { continue; }
          if (!st.isFile()) continue;
          const { records: fileTurns, sessionRecords: fileSessions } = await this._scanFile(wirePath, diag);
          records.push(...fileTurns);
          sessionRecords.push(...fileSessions);
        }
      }
    }
    return { records, sessionRecords, diagnostics: finalizeDiag(diag) };
  }
}

module.exports = { UsageStats, parseUsageRecord, RANGES };
