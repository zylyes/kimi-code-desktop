// 托管用量查询服务
// 纯 Node 模块，不依赖 Electron：fetchImpl 由调用方注入（main.js 注入 Electron net.fetch，
// 测试注入桩）。只读平台额度接口 GET {baseUrl}/usages，不写任何本地文件。
// 安全约束：任何返回值/错误消息不得包含 token、Authorization 头、完整请求 URL。
const path = require('path');

const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
const DEFAULT_TIMEOUT_MS = 8000;
const STALE_AFTER_MS = 60000; // staleAt = fetchedAt + 60s

// 十进制字符串→数字：null/undefined/非法/Infinity/NaN 一律 0，保证不抛异常
function parseDecimal(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 1e6 fixed-point → 分（cents）：fixed / 1e4 四舍五入
function toCents(fixedPoint) {
  return Math.round(parseDecimal(fixedPoint) / 1e4);
}

// label 合成：week → 'Weekly limit'；5+'hour' → '5h limit'；7+'day' → '7d limit'；未知单位原样拼接
function planLabel(duration, timeUnit) {
  const unit = String(timeUnit == null ? '' : timeUnit).toLowerCase();
  const d = String(duration == null ? '' : duration);
  if (unit === 'week') return 'Weekly limit';
  const abbrev = { hour: 'h', day: 'd' }[unit];
  if (abbrev) return `${d}${abbrev} limit`;
  const label = `${d} ${unit} limit`.trim();
  return label || 'Limit';
}

// 响应是否为 2xx（兼容只提供 ok 或 status 的桩实现）
function isOk(res) {
  if (!res) return false;
  if (typeof res.ok === 'boolean') return res.ok;
  return typeof res.status === 'number' && res.status >= 200 && res.status < 300;
}

// 错误消息脱敏：去掉 token 与完整 baseUrl（含其派生的完整请求 URL），超长截断
function sanitizeMessage(msg, token, baseUrl) {
  let s = String(msg == null ? '' : msg).replace(/\s+/g, ' ').trim();
  if (s.length > 200) s = `${s.slice(0, 197)}...`;
  if (token) s = s.split(token).join('[redacted]');
  if (baseUrl) s = s.split(baseUrl).join('[redacted]');
  return s || '请求失败';
}

// usage 字段 → plans[0]（id 固定 weekly）；非对象 → null
function planFromUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  return {
    id: 'weekly',
    label: 'Weekly limit',
    used: parseDecimal(usage.used),
    limit: parseDecimal(usage.limit),
    resetAt: usage.resetTime, // 原样透传
  };
}

// limits[i] → plans[i+1]；detail 缺失/非对象 → 跳过（返回 null）
function planFromLimit(item, i) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const detail = item.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const window = item.window && typeof item.window === 'object' && !Array.isArray(item.window)
    ? item.window
    : {};
  return {
    id: `limit-${i}`,
    label: planLabel(window.duration, window.timeUnit),
    used: parseDecimal(detail.used),
    limit: parseDecimal(detail.limit),
    resetAt: detail.resetTime, // 原样透传
  };
}

// boosterWallet → wallet；type 必须为 'BOOSTER'；金额 1e6 fixed-point → 分；currency 缺省 USD
function walletFromBooster(wallet) {
  if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)) return null;
  if (wallet.type !== 'BOOSTER') return null;
  const currency = typeof wallet.currency === 'string' && wallet.currency ? wallet.currency : 'USD';
  const monthlyUsed = wallet.monthlyUsed && typeof wallet.monthlyUsed === 'object' && !Array.isArray(wallet.monthlyUsed)
    ? toCents(wallet.monthlyUsed.amount)
    : 0;
  const limitEnabled = wallet.monthlyChargeLimitEnabled === true;
  const monthlyLimit = limitEnabled
    && wallet.monthlyChargeLimit
    && typeof wallet.monthlyChargeLimit === 'object'
    && !Array.isArray(wallet.monthlyChargeLimit)
    ? toCents(wallet.monthlyChargeLimit.amount)
    : 0;
  return {
    currency,
    balanceMinor: toCents(wallet.amountLeft),
    monthlyUsedMinor: monthlyUsed,
    monthlyLimitMinor: monthlyLimit,
  };
}

// 查询托管用量快照。token 缺失时直接 unavailable，不发请求。
async function fetchManagedUsage({ fetchImpl, token, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const fetchedAt = now();
  const base = { fetchedAt, staleAt: fetchedAt + STALE_AFTER_MS };
  const noData = { plans: [], wallet: null };

  if (token == null || token === '') {
    return { kind: 'unavailable', ...noData, ...base };
  }
  if (typeof fetchImpl !== 'function') {
    return { kind: 'error', ...noData, message: 'fetchImpl 必须是函数', ...base };
  }
  const root = typeof baseUrl === 'string' && baseUrl ? baseUrl.replace(/\/+$/, '') : DEFAULT_BASE_URL;
  const url = `${root}/usages`;
  const ms = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    return { kind: 'error', ...noData, message: sanitizeMessage(err && err.message, token, root), ...base };
  } finally {
    clearTimeout(timer);
  }

  if (res && res.status === 401) {
    return { kind: 'auth-required', ...noData, ...base };
  }
  if (res && res.status === 404) {
    return { kind: 'unavailable', ...noData, ...base };
  }
  if (!isOk(res)) {
    const status = res && typeof res.status === 'number' ? res.status : 'unknown';
    return { kind: 'error', ...noData, message: `HTTP ${status}`, ...base };
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    return { kind: 'error', ...noData, message: sanitizeMessage(err && err.message, token, root), ...base };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'error', ...noData, message: 'Invalid usage response', ...base };
  }

  const plans = [];
  const usagePlan = planFromUsage(payload.usage);
  if (usagePlan) plans.push(usagePlan);
  if (Array.isArray(payload.limits)) {
    for (let i = 0; i < payload.limits.length; i++) {
      const p = planFromLimit(payload.limits[i], i);
      if (p) plans.push(p);
    }
  }
  return { kind: 'ok', plans, wallet: walletFromBooster(payload.boosterWallet), ...base };
}

// 读取 OAuth 凭据文件 <kimiCodeHome>/credentials/kimi-code.json 的 access_token。
// 文件缺失/坏 JSON/access_token 非空字符串 → null；同步读取。
function loadOAuthToken({ kimiCodeHome, fsImpl = require('fs') }) {
  if (!kimiCodeHome || typeof kimiCodeHome !== 'string') return null;
  let raw;
  try {
    raw = fsImpl.readFileSync(path.join(kimiCodeHome, 'credentials', 'kimi-code.json'), 'utf8');
  } catch {
    return null; // 缺失或不可读
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null; // 坏 JSON
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const token = data.access_token;
  if (typeof token !== 'string' || token.trim() === '') return null;
  return { accessToken: token.trim() };
}

module.exports = { fetchManagedUsage, loadOAuthToken };
