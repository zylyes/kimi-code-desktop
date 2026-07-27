// ⑤⑥ 通道探针：对指定 kimi web 实例实测「审批 / 问答」WS 事件链路（CLI 0.29.x 回归用）
// 流程：REST 建会话 → 等 40s（桌面端 30s 发现周期订阅该会话）→ 发 bash 提示词触发审批 →
//       捕获 approval.requested → REST 批准 → 发 AskUserQuestion 提示词 →
//       捕获 question.requested → REST 作答。全程记录 WS 事件名与字段形态（不打印 token/敏感内容）。
// 用法：node scripts/ws-event-probe.js <port>
// 注意：会消耗少量额度（两次短提示词）；测试会话保留在磁盘（标题 kcd-regression-probe，可手动归档）。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('用法: node scripts/ws-event-probe.js <port>');
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

// 等待指定 WS 事件（兼容 event. 前缀），返回 { name, raw }；超时返回 null
function waitEvent(ws, wantNames, timeoutMs, seen) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    const onMsg = (data) => {
      let raw;
      try { raw = JSON.parse(data.toString('utf8')); } catch { return; }
      const name = raw && (raw.event || raw.type);
      if (!name) return;
      seen.add(name);
      const short = name.replace(/^event\./, '');
      if (wantNames.includes(short)) {
        cleanup();
        resolve({ name, raw });
      }
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMsg); };
    ws.on('message', onMsg);
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
  const seen = new Set();
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'client_hello', id: '1', payload: { client_id: 'kcd-regression-probe', subscriptions: [] } }));
  ws.send(JSON.stringify({ type: 'subscribe', id: '2', payload: { session_ids: [sessionId] } }));
  say('WS 已连接并订阅');
  // error 事件即时打印（诊断 turn 失败原因）
  ws.on('message', (data) => {
    try {
      const raw = JSON.parse(data.toString('utf8'));
      const name = raw && (raw.event || raw.type);
      if (name === 'error' || name === 'event.error') {
        say(`收到 error 事件: ${JSON.stringify(payloadOf(raw)).slice(0, 300)}`);
      }
    } catch { /* ignore */ }
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
  const approval = await waitEvent(ws, ['approval.requested'], 150000, seen);
  if (!approval) {
    say(`FAIL: 150s 内未收到 approval.requested；期间收到的事件: ${[...seen].join(', ') || '(无)'}`);
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
  const question = await waitEvent(ws, ['question.requested'], 150000, seen);
  if (!question) {
    say(`FAIL: 150s 内未收到 question.requested；期间收到的事件: ${[...seen].join(', ') || '(无)'}`);
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
      const answered = await waitEvent(ws, ['question.answered', 'question.dismissed'], 30000, seen);
      say(answered ? `作答后收到 ${answered.name}` : 'WARN: 30s 内未收到 question.answered');
    } else {
      say(`WARN: 无法构造作答（qid=${!!qid} itemId=${!!itemId} optId=${!!optId}），跳过 REST 作答`);
    }
  }

  // 6. 等 agent 收尾，避免事件洪流打到日志外
  await sleep(3000);
  say(`全程事件清单: ${[...seen].join(', ') || '(无)'}`);
  say(`测试会话 ${sessionId}（标题 kcd-regression-probe）保留在磁盘，可手动归档`);
  ws.close();
}

main().then(
  () => { say('探针结束'); process.exit(process.exitCode || 0); },
  (err) => { say(`FATAL: ${err.message}`); process.exit(1); },
);
