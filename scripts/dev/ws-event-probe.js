// ⑤⑥ 通道探针 + M1-3 事件普查：对指定 kimi web 实例实测「审批 / 问答 / 子代理任务」WS 事件链路
//       （CLI 0.29.x 回归 + 能力审计用）
// 流程：REST 建会话 → 等 40s（桌面端 30s 发现周期订阅该会话）→ 发 bash 提示词触发审批 →
//       捕获 approval.requested → REST 批准 → 发 AskUserQuestion 提示词 → 捕获 question.requested →
//       REST 作答 → 发 Task 子代理提示词 → 观察 task.* / agent 相关事件（最长 120s，超时不算失败）。
//       全程普查记录 WS 事件（次数 + payload/envelope 键类型摘要 + 至多 2 条样本，不含任何文本值，
//       不打印 token/敏感内容），结尾输出与 normalizer 白名单的对比报告。
// 用法：node scripts/dev/ws-event-probe.js <port>
// 注意：会消耗少量额度（三个短提示词）；测试会话保留在磁盘（标题 kcd-regression-probe，可手动归档）。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('用法: node scripts/dev/ws-event-probe.js <port>');
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
const token = fs.readFileSync(path.join(os.homedir(), '.kimi-code', 'server.token'), 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => console.log(`[probe] ${msg}`);

function rest(method, p, body) {
  return new Promise((resolve, reject) => {
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
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const unwrap = (r) => (r.json && typeof r.json === 'object' && 'data' in r.json ? r.json.data : r.json);

// normalizer 白名单（src/main/runtime-event-normalizer.js normalizeWsEvent 仅保留这些事件）
const WHITELIST = ['task.started', 'task.progress', 'task.completed', 'task.done', 'session.usage_updated'];

// 值类型摘要：不记录任何文本内容，只记录键名与类型
const typeTag = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string / number / boolean / object / undefined
};

// 事件普查记录：count + payload 顶层键类型摘要 + envelope 顶层键摘要 + 至多 2 条样本（仅键级摘要）
function recordEvent(seen, name, raw) {
  const p = payloadOf(raw);
  const payloadKeys = Object.keys(p).map((k) => `${k}:${typeTag(p[k])}`).sort();
  const envelopeKeys = Object.keys(raw)
    .filter((k) => k !== 'payload' && k !== 'data')
    .map((k) => `${k}:${typeTag(raw[k])}`).sort();
  let rec = seen.get(name);
  if (!rec) {
    rec = { count: 0, payloadKeys: new Set(), envelopeKeys: new Set(), samples: [] };
    seen.set(name, rec);
  }
  rec.count += 1;
  payloadKeys.forEach((k) => rec.payloadKeys.add(k));
  envelopeKeys.forEach((k) => rec.envelopeKeys.add(k));
  if (rec.samples.length < 2) rec.samples.push(payloadKeys.join(','));
  return rec;
}

// 等待指定 WS 事件（兼容 event. 前缀），返回 { name, raw }；超时返回 null。
// 事件匹配由全局 message 监听器统一分派，所有事件在监听器中先做普查记录，保证计数不重复。
const waiters = [];
function waitEvent(ws, wantNames, timeoutMs) {
  return new Promise((resolve) => {
    const waiter = { wantNames, done: false };
    waiter.resolve = (name, raw) => {
      clearTimeout(timer);
      waiter.done = true;
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      resolve({ name, raw });
    };
    const timer = setTimeout(() => {
      waiter.done = true;
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    waiters.push(waiter);
  });
}

// 从事件 envelope 提取 payload（桌面端同款容错）
const payloadOf = (raw) => (raw && (raw.payload || raw.data)) || {};

async function main() {
  // 1. 建会话（cwd 用临时目录，bash 工具在其中执行，不碰项目）
  // model 必须显式指定（实测缺省报 model.not_configured: Model not set），
  // 且 ID 必须取目录全名（GET /api/v1/models 的 model 字段，如 kimi-code/kimi-for-coding；裸名会被置空）
  const created = await rest('POST', '/api/v1/sessions', {
    title: 'kcd-regression-probe',
    metadata: { cwd: os.tmpdir() },
    agent_config: { model: 'kimi-code/kimi-for-coding', permission_mode: 'manual', plan_mode: false },
  });
  if (created.status >= 300) throw new Error(`建会话失败 HTTP ${created.status}: ${created.raw}`);
  const d = unwrap(created);
  const sessionId = d && (d.session_id || d.sessionId || d.id);
  if (!sessionId) throw new Error(`建会话响应无会话 ID: ${created.raw}`);
  say(`会话已创建: ${sessionId}`);

  // 快速校验会话配置落位（仅记录；model 在 0.29.0 经 POST /sessions 与 /profile 均不落位——
  // 实测结论：须随 prompt 提交 model/permission_mode/plan_mode，POST /prompts 顶层支持这些字段）
  const [st, pf] = await Promise.all([
    rest('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/status`),
    rest('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/profile`),
  ]);
  const stD = unwrap(st) || {};
  const pfD = unwrap(pf) || {};
  say(`status: permission=${stD.permission} plan_mode=${stD.plan_mode} profile.model=${(pfD.agent_config && pfD.agent_config.model) || '(空，随 prompt 指定)'}`);
  // 随 prompt 提交的覆盖字段（0.29.0 实测：POST /sessions 的 agent_config 不落位）
  const turnCfg = { model: 'kimi-code/kimi-for-coding', permission_mode: 'manual', plan_mode: false };

  // 2. WS 建连（与桌面端同一协议：子协议 + Authorization + client_hello + subscribe）
  const wsUrl = base.replace(/^http:/, 'ws:') + '/api/v1/ws';
  const ws = new WebSocket(wsUrl, [`kimi-code.bearer.${token}`], { headers: { 'Authorization': `Bearer ${token}` } });
  const seen = new Map(); // 事件普查记录：事件名 -> { count, payloadKeys, envelopeKeys, samples }
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'client_hello', id: '1', payload: { client_id: 'kcd-regression-probe', subscriptions: [] } }));
  ws.send(JSON.stringify({ type: 'subscribe', id: '2', payload: { session_ids: [sessionId] } }));
  say('WS 已连接并订阅');
  // 全局消息监听：普查记录所有事件；error 事件即时打印（诊断 turn 失败原因）；分派给等待中的 waiter
  ws.on('message', (data) => {
    let raw;
    try { raw = JSON.parse(data.toString('utf8')); } catch { return; }
    const name = raw && (raw.event || raw.type);
    if (!name) return;
    recordEvent(seen, name, raw);
    if (name === 'error' || name === 'event.error') {
      say(`收到 error 事件: ${JSON.stringify(payloadOf(raw)).slice(0, 300)}`);
    }
    const short = name.replace(/^event\./, '');
    for (const w of waiters) {
      if (!w.done && w.wantNames.includes(short)) w.resolve(name, raw);
    }
  });

  // 3. 等桌面端 30s 发现周期订阅该会话
  say('等待 40s 让桌面端发现新会话…');
  await sleep(40000);

  // 4. 触发审批：要求执行 bash echo
  const r1 = await rest('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
    content: [{ type: 'text', text: '请调用 Bash 工具执行命令：echo kcd-approval-probe。执行完成后直接回复结果，不要执行任何其他操作。' }],
    ...turnCfg,
  });
  if (r1.status >= 300) throw new Error(`发送提示词失败 HTTP ${r1.status}: ${r1.raw}`);
  say('已发送 bash 提示词，等待 approval.requested（最长 150s）…');
  const approval = await waitEvent(ws, ['approval.requested'], 150000);
  if (!approval) {
    say(`FAIL: 150s 内未收到 approval.requested；期间收到的事件: ${[...seen.keys()].join(', ') || '(无)'}`);
    process.exitCode = 1;
  } else {
    const p = payloadOf(approval.raw);
    say(`PASS ⑤ 捕获事件 ${approval.name}，payload 键: ${Object.keys(p).join(', ') || '(空)'}`);
    const approvalId = p.approval_id || p.id || approval.raw.approval_id || approval.raw.id;
    if (approvalId) {
      const ra = await rest('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, { decision: 'approved' });
      say(`REST 批准 approval_id=${approvalId} -> HTTP ${ra.status}`);
    } else {
      say('WARN: 未找到 approval_id，跳过 REST 批准（会话可能挂起等待）');
    }
  }

  // 5. 触发问答：要求使用 AskUserQuestion
  const r2 = await rest('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
    content: [{ type: 'text', text: '请调用 AskUserQuestion 工具向我提出一个问题：主题任意（例如「是否继续」），提供 2 个选项即可。提出问题后等待我的回答，不要做其他操作。' }],
    ...turnCfg,
  });
  if (r2.status >= 300) throw new Error(`发送问答提示词失败 HTTP ${r2.status}: ${r2.raw}`);
  say('已发送 AskUserQuestion 提示词，等待 question.requested（最长 150s）…');
  const question = await waitEvent(ws, ['question.requested'], 150000);
  if (!question) {
    say(`FAIL: 150s 内未收到 question.requested；期间收到的事件: ${[...seen.keys()].join(', ') || '(无)'}`);
    process.exitCode = 1;
  } else {
    const p = payloadOf(question.raw);
    say(`PASS ⑥ 捕获事件 ${question.name}，payload 键: ${Object.keys(p).join(', ')}`);
    // 记录字段级形态（桌面端 handleQuestionRequested 依赖 question_id + questions 数组）
    say(`字段形态: question_id=${typeof p.question_id} questions=${Array.isArray(p.questions) ? `数组(${p.questions.length})` : typeof p.questions}`);
    if (Array.isArray(p.questions) && p.questions[0]) {
      const q0 = p.questions[0];
      say(`首题键: ${Object.keys(q0).join(', ')}；选项数: ${Array.isArray(q0.options) ? q0.options.length : '无 options 数组'}`);
    }
    // REST 作答：取首题第一个选项
    const qid = p.question_id;
    const q0 = Array.isArray(p.questions) && p.questions[0];
    const itemId = q0 && (q0.id || q0.item_id) ? (q0.id || q0.item_id) : qid;
    const opt = q0 && Array.isArray(q0.options) && q0.options[0];
    const optId = opt && (opt.id || opt.option_id || opt.label);
    if (qid && itemId && optId) {
      const answers = { [itemId]: { kind: 'single', option_id: optId } };
      const rr = await rest('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(qid)}`, { answers, method: 'click' });
      say(`REST 作答 question_id=${qid} -> HTTP ${rr.status}`);
      // 作答后应广播 question.answered，桌面端收到会释放并关窗
      const answered = await waitEvent(ws, ['question.answered', 'question.dismissed'], 30000);
      say(answered ? `作答后收到 ${answered.name}` : 'WARN: 30s 内未收到 question.answered');
    } else {
      say(`WARN: 无法构造作答（qid=${!!qid} itemId=${!!itemId} optId=${!!optId}），跳过 REST 作答`);
    }
  }

  // 6. 触发后台子代理任务（M1-3 审计：官方 WS 是否发布子代理生命周期事件）。
  //    只做观察，不参与 PASS/FAIL：任务完成或超时均继续，不算失败。
  const r3 = await rest('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
    content: [{ type: 'text', text: '请使用 Task 工具运行一个极短的后台子代理任务：让子代理直接回复字符串 "ok" 即可，不要执行任何其他操作，尽快完成。' }],
    ...turnCfg,
  });
  if (r3.status >= 300) throw new Error(`发送子代理任务提示词失败 HTTP ${r3.status}: ${r3.raw}`);
  say('已发送 Task 子代理提示词，观察 task.* 与 agent 相关事件（最长 120s，超时不算失败）…');
  const taskEvent = await waitEvent(ws, ['task.started', 'task.progress', 'task.completed', 'task.done'], 120000);
  if (taskEvent) {
    say(`观察: 收到任务事件 ${taskEvent.name}（其余事件由普查记录，任务可能仍在进行）`);
  } else {
    say('观察: 120s 内未收到任何 task.* 事件（任务完成或超时均继续）');
  }
  const agentNames = [...seen.keys()].filter((n) => /agent|subagent/i.test(n));

  // 7. 等 agent 收尾，避免事件洪流打到日志外
  await sleep(3000);
  say(`全程事件清单: ${[...seen.keys()].join(', ') || '(无)'}`);

  // 8. 事件普查报告（M1-3 能力审计）
  say('=== 事件普查报告 ===');
  for (const [name, rec] of seen) {
    say(`事件 ${name}: 次数=${rec.count}`);
    say(`  payload 键: ${[...rec.payloadKeys].join(', ') || '(空)'}`);
    say(`  envelope 键: ${[...rec.envelopeKeys].join(', ') || '(空)'}`);
    say(`  样本(${rec.samples.length}/2): ${rec.samples.map((s) => `{${s}}`).join(' | ') || '(空)'}`);
  }
  say('--- 与 normalizer 白名单对比（normalizeWsEvent 仅保留白名单事件） ---');
  for (const name of seen.keys()) {
    const covered = WHITELIST.includes(name.replace(/^event\./, ''));
    say(`  ${name}: ${covered ? '已覆盖' : '未覆盖'}`);
  }
  for (const w of WHITELIST) {
    const observed = [...seen.keys()].some((n) => n.replace(/^event\./, '') === w);
    if (!observed) say(`  ${w}: 未触发`);
  }
  say(agentNames.length > 0 ? `子代理事件: 存在(${agentNames.join(', ')})` : '子代理事件: 未观察到');
  say(`测试会话 ${sessionId}（标题 kcd-regression-probe）保留在磁盘，可手动归档`);
  ws.close();
}

main().then(
  () => { say('探针结束'); process.exit(process.exitCode || 0); },
  (err) => { say(`FATAL: ${err.message}`); process.exit(1); },
);
