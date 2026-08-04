// 能力探测：对运行中的 kimi web 实例做 /openapi.json、/asyncapi.json 登记与已知端点存在性探测（一次性研究工具，不进打包）
// 用法：node scripts/capability-audit.js <port>
// 输出：结构化 JSON 到 stdout（单次 console.log）；绝不打印 token / 响应体业务内容（只登记路径、方法、键名、状态码）
// 退出码：0 = 探测流程完成（端点不存在不算失败）；1 = openapi.json 完全拿不到（连接失败/非 200/结构不合法）；2 = 用法错误
// 注意：所有请求 15s 超时；单个端点失败不中断后续探测；登记路径仅含结构信息，不含业务内容
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('用法: node scripts/capability-audit.js <port>');
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
const token = fs.readFileSync(path.join(os.homedir(), '.kimi-code', 'server.token'), 'utf8').trim();

// 通用 REST 请求：15s 超时；raw 截断仅供诊断用（不进报告）
function rest(method, p) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: data.slice(0, 300) });
      });
    });
    req.on('error', (e) => resolve({ status: 'error', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'error', error: 'timeout' }); });
    req.end();
  });
}

// 服务端可能返回 { data: ... } 包装，需拆包（本脚本不依赖，保留与项目 REST 助手一致形态）
const unwrap = (r) => (r.json && typeof r.json === 'object' && 'data' in r.json ? r.json.data : r.json);

// 与 src/main/main.js detectServerCaps() 同款正则
const RE_ARCHIVE_1 = /\/sessions\/\{[^}]+\}:archive\/?$/;
const RE_ARCHIVE_2 = /\/sessions\/\{[^}]+\}\/archive\/?$/;
const RE_DELETE_POST = /\/sessions\/\{[^}]+\}:delete\/?$/;
const RE_DELETE_DEL = /\/sessions\/\{[^}]+\}\/?$/;
const RE_MODELS = /\/models/;

// 端点分类：先命中更具体的类别（usage/models/files-diff/prompts/approvals/questions/ws/shutdown），再 sessions 兜底，其余进"其他"
function categorize(p) {
  if (/\/usage/.test(p)) return 'usage';
  if (/\/models/.test(p)) return 'models';
  if (/\/files|\/diff/.test(p)) return 'files/diff';
  if (/\/prompts/.test(p)) return 'prompts';
  if (/\/approvals/.test(p)) return 'approvals';
  if (/\/questions/.test(p)) return 'questions';
  if (/\/ws/.test(p)) return 'ws';
  if (/\/shutdown/.test(p)) return 'shutdown';
  if (/\/sessions/.test(p)) return 'sessions';
  return '其他';
}

// 与 detectServerCaps 三项（archive/delete/models）对照：现有正则能否命中、命中哪些路径
function checkServerCaps(paths) {
  const check = {
    archive: { matched: false, paths: [] },
    delete: { matched: false, detail: null },
    models: { matched: false, paths: [] },
  };
  for (const [p, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== 'object') continue;
    const methods = Object.keys(ops).map((m) => m.toLowerCase());
    if ((RE_ARCHIVE_1.test(p) || RE_ARCHIVE_2.test(p)) && methods.includes('post')) {
      check.archive.matched = true;
      check.archive.paths.push(p);
    }
    if (RE_DELETE_POST.test(p) && methods.includes('post')) {
      check.delete.matched = true;
      check.delete.detail = { path: p, method: 'post' };
    } else if (RE_DELETE_DEL.test(p) && methods.includes('delete')) {
      check.delete.matched = true;
      check.delete.detail = { path: p, method: 'delete' };
    }
    if (RE_MODELS.test(p) && methods.includes('get')) {
      check.models.matched = true;
      check.models.paths.push(p);
    }
  }
  return check;
}

async function main() {
  const report = {
    base, probedAt: new Date().toISOString(),
    openapi: null, asyncapi: null, probes: null,
  };
  let openapiOk = false;

  // 1. GET /openapi.json：全量登记 paths（方法小写）+ 前缀分组 + 分类 + 与 detectServerCaps 对照
  const oa = await rest('GET', '/openapi.json');
  if (oa.status === 200 && oa.json && typeof oa.json === 'object' && oa.json.paths && typeof oa.json.paths === 'object') {
    openapiOk = true;
    const paths = oa.json.paths;
    const endpoints = [];
    const groups = {};
    for (const [p, ops] of Object.entries(paths)) {
      if (!ops || typeof ops !== 'object') continue;
      const methods = Object.keys(ops).map((m) => m.toLowerCase()).sort();
      const category = categorize(p);
      endpoints.push({ path: p, methods, category });
      const segs = p.split('/').filter(Boolean);
      const key = '/' + segs.slice(0, 4).join('/') + (segs.length > 4 ? '/*' : '');
      (groups[key] = groups[key] || []).push({ path: p, methods, category });
    }
    report.openapi = {
      status: oa.status,
      pathCount: endpoints.length,
      groups,
      serverCapsCheck: checkServerCaps(paths),
      endpoints,
    };
  } else {
    report.openapi = {
      status: oa.status,
      pathCount: 0,
      error: oa.status === 'error' ? oa.error : (oa.status === 200 ? '响应非 JSON 或缺 paths 结构' : '非 200'),
    };
  }

  // 2. GET /asyncapi.json：200 且可解析 → 防御性提取 channels/operations/components.messages 键名；否则输出"不存在"结论
  const aa = await rest('GET', '/asyncapi.json');
  const asyncapi = { status: aa.status };
  if (aa.status === 200 && aa.json && typeof aa.json === 'object') {
    asyncapi.exists = true;
    const a = aa.json;
    const ch = a.channels && typeof a.channels === 'object' ? Object.keys(a.channels) : null;
    const op = a.operations && typeof a.operations === 'object' ? Object.keys(a.operations) : null;
    const msgs = a.components && a.components.messages && typeof a.components.messages === 'object'
      ? Object.keys(a.components.messages) : null;
    if (ch) asyncapi.channels = ch;
    if (op) asyncapi.operations = op;
    if (msgs) asyncapi.messages = msgs;
    if (!ch && !op && !msgs) asyncapi.topKeys = Object.keys(a); // 结构不识别 → 顶层 keys
  } else {
    asyncapi.exists = false;
    asyncapi.note = aa.status === 404
      ? '不存在（HTTP 404）'
      : (aa.status === 'error' ? `请求失败: ${aa.error}` : `非 200 或非 JSON（HTTP ${aa.status}）`);
  }
  report.asyncapi = asyncapi;

  // 3. 已知端点存在性探测（仅 HEAD 级：记录状态码，不读业务内容）
  const probeEntry = (r) => (r.status === 'error' ? { status: 'error', message: r.error } : r.status);
  const [m, s, u] = await Promise.all([
    rest('GET', '/api/v1/models'),
    rest('GET', '/api/v1/sessions'),
    rest('GET', '/api/v1/usage'),
  ]);
  report.probes = { models: probeEntry(m), sessions: probeEntry(s), usage: probeEntry(u) };

  console.log(JSON.stringify(report, null, 2));
  return openapiOk;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err) => { console.error(`[audit] FATAL: ${err.message}`); process.exit(1); },
);
