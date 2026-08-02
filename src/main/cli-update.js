// CLI 更新检查服务
// 纯 Node 模块，不依赖 Electron：main.js 注入 Electron net.fetch（使用 Chromium 代理与证书处理），
// 测试注入桩实现。只读官方远端与本地缓存；本地缓存由 CLI 写入，此处永不写。
const fs = require('fs');

const JSON_URL = 'https://code.kimi.com/kimi-code/latest.json';
const TEXT_URL = 'https://code.kimi.com/kimi-code/latest';

// 版本仅接受 v?数字.数字.数字，归一化去掉 v 前缀
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

function normalizeVersion(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = VERSION_RE.exec(s);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

// 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0；非法输入视为相等（返回 0），保证调用方不抛异常
function compareSemver(a, b) {
  const na = normalizeVersion(a);
  const nb = normalizeVersion(b);
  if (!na || !nb) return 0;
  const pa = na.split('.').map(Number);
  const pb = nb.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

// 是否可更新：current 与 latest 均为合法版本且 current < latest 才返回 true；
// current 为空（''/null/undefined）或任一版本非法一律返回 false，保证调用方不抛异常
function isUpdateAvailable(current, latest) {
  const nc = normalizeVersion(current);
  const nl = normalizeVersion(latest);
  if (!nc || !nl) return false;
  return compareSemver(nc, nl) < 0;
}

// 读取本地缓存（~/.kimi-code/updates/latest.json）。只信任 latest（合法版本）与字符串 checkedAt，
// 其余字段一律忽略；文件缺失/损坏/latest 非法时返回 null。缓存由 CLI 写入，此处绝不写回。
function readCache(cachePath) {
  let raw;
  try {
    raw = fs.readFileSync(cachePath, 'utf8');
  } catch {
    return null; // 缺失或不可读
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null; // 损坏
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const latest = normalizeVersion(data.latest);
  if (!latest) return null; // 无合法缓存版本即视为无效
  const checkedAt = typeof data.checkedAt === 'string' ? data.checkedAt : '';
  const out = { latest };
  if (checkedAt) out.checkedAt = checkedAt;
  return out;
}

// 响应是否为 2xx（兼容只提供 ok 或 status 的桩实现）
function isOk(res) {
  if (!res) return false;
  if (typeof res.ok === 'boolean') return res.ok;
  return typeof res.status === 'number' && res.status >= 200 && res.status < 300;
}

// 错误消息压缩：整段（含来源前缀）最多 120 字符，避免聚合后超长
function briefError(err, label) {
  const msg = (err instanceof Error ? err.message : String(err == null ? '' : err))
    .replace(/\s+/g, ' ')
    .trim();
  const prefix = `${label}: `;
  const maxMsg = 120 - prefix.length;
  const cut = msg.length > maxMsg ? `${msg.slice(0, maxMsg - 3)}...` : msg;
  return prefix + (cut || '请求失败');
}

// 请求远端并校验 2xx，非 2xx 抛错（计入错误聚合）
async function fetchFrom(fetchImpl, url, opts, label) {
  const res = await fetchImpl(url, opts);
  if (!isOk(res)) {
    throw new Error(`HTTP ${res && typeof res.status === 'number' ? res.status : 'unknown'}`);
  }
  return res;
}

// 主动检查官方最新版本：先 JSON endpoint，失败（网络/非 2xx/解析失败/缺字段/非法版本）回退纯文本 endpoint。
// 成功返回 { ok:true, latest, source:'json'|'text', publishedAt? }；双失败返回 { ok:false, error }（错误聚合）。
async function fetchLatest({ fetchImpl, timeoutMs = 5000 } = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetchImpl 必须是函数' };
  }
  const errors = [];
  const mkOpts = () => ({ cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });

  // 1) 官方 JSON endpoint：只读 version 字段，字符串 publishedAt 可透传
  try {
    const res = await fetchFrom(fetchImpl, JSON_URL, mkOpts(), 'JSON');
    const data = await res.json();
    const latest = data && typeof data === 'object' && !Array.isArray(data)
      ? normalizeVersion(data.version)
      : null;
    if (!latest) throw new Error('缺少或非法的 version 字段');
    const publishedAt = typeof data.publishedAt === 'string' ? data.publishedAt : undefined;
    const out = { ok: true, latest, source: 'json' };
    if (publishedAt) out.publishedAt = publishedAt;
    return out;
  } catch (err) {
    errors.push(briefError(err, 'JSON'));
  }

  // 2) 官方纯文本 endpoint：trim 后严格校验版本
  try {
    const res = await fetchFrom(fetchImpl, TEXT_URL, mkOpts(), 'TEXT');
    const text = await res.text();
    const latest = normalizeVersion(text);
    if (!latest) throw new Error('非法版本');
    return { ok: true, latest, source: 'text' };
  } catch (err) {
    errors.push(briefError(err, 'TEXT'));
  }

  return { ok: false, error: errors.join('; ') };
}

module.exports = { JSON_URL, TEXT_URL, fetchLatest, readCache, compareSemver, isUpdateAvailable };
