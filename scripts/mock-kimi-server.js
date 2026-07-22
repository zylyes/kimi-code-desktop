// Mock Kimi 服务端 — 供桌面端联调/测试使用
// HTTP: /openapi.json、/、问题答案提交、/control/* 控制端点
// WS: /api/v1/ws，子协议 kimi-code.bearer.<token> 鉴权，支持 /control/emit 广播事件
// 端口 MOCK_PORT（默认 58999），token MOCK_TOKEN（默认 mock-token）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.MOCK_PORT) || 58999;
const TOKEN = process.env.MOCK_TOKEN || 'mock-token';
const DEFAULT_SESSION = 'sess-mock-1';
const answersFile = path.join(__dirname, 'mock-answers.jsonl');

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

// ---------- 事件场景 ----------
const scenarios = {
  'approval.requested': () => ({
    event: 'event.approval.requested',
    payload: { approval_id: 'ap-1', tool: 'Bash', command: 'rm -rf build' },
  }),
  'question.single': () => ({
    event: 'event.question.requested',
    payload: {
      question_id: 'q-single-1',
      questions: [{
        id: 'item1',
        header: '环境确认',
        question: '是否在 build 目录下继续？',
        body: '检测到构建产物',
        options: [
          { id: 'yes', label: '继续', description: '保留现有产物' },
          { id: 'no', label: '取消', description: '终止操作' },
        ],
      }],
    },
  }),
  'question.multi': () => ({
    event: 'event.question.requested',
    payload: {
      question_id: 'q-multi-1',
      questions: [{
        id: 'item1',
        question: '选择要启用的功能',
        multi_select: true,
        allow_other: true,
        options: [
          { id: 'a', label: 'lint', description: '' },
          { id: 'b', label: 'test' },
          { id: 'c', label: 'docs' },
        ],
      }],
    },
  }),
  // 两道题：一单选，一纯文本（无选项、allow_other）
  'question.multiq': () => ({
    event: 'event.question.requested',
    payload: {
      question_id: 'q-multiq-1',
      questions: [
        {
          id: 'item1',
          header: '运行模式',
          question: '选择运行模式',
          options: [
            { id: 'fast', label: '快速', description: '跳过部分检查' },
            { id: 'full', label: '完整', description: '全量检查' },
          ],
        },
        {
          id: 'item2',
          header: '补充说明',
          question: '还有什么要补充的？',
          allow_other: true,
          options: [],
        },
      ],
    },
  }),
  'question.answered': (body) => ({
    event: 'event.question.answered',
    payload: { question_id: (body && body.question_id) || 'q-single-1' },
  }),
  'usage': () => ({
    event: 'event.session.usage_updated',
    payload: {
      usage: {
        total_tokens: 12345,
        input_tokens: 8000,
        output_tokens: 4345,
        context_used: 45000,
        context_limit: 128000,
      },
    },
  }),
  'task.started': () => ({
    event: 'event.task.started',
    payload: { task_id: 't1', title: '构建项目', progress: 0.5 },
  }),
  'task.progress': () => ({
    event: 'event.task.progress',
    payload: { task_id: 't1', title: '构建项目', progress: 0.5 },
  }),
  'task.completed': () => ({
    event: 'event.task.completed',
    payload: { task_id: 't1', title: '构建项目', progress: 0.5 },
  }),
};

// ---------- WebSocket ----------
const wss = new WebSocketServer({
  noServer: true,
  // 校验子协议 kimi-code.bearer.<token>；回带该子协议
  handleProtocols: (protocols, req) => {
    for (const p of protocols) {
      if (p.startsWith('kimi-code.bearer.') && p.slice('kimi-code.bearer.'.length) === TOKEN) {
        return p;
      }
    }
    // 容错：Authorization 头鉴权通过则回带第一个子协议
    const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+?)\s*$/i);
    if (m && m[1] === TOKEN) return protocols.values().next().value || false;
    return false;
  },
});

wss.on('connection', (ws, req) => {
  console.log('MOCK_WS_OPEN');
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    const type = msg && (msg.type || msg.event);
    if (type === 'client_hello') {
      console.log('MOCK_WS_HELLO');
      ws.send(JSON.stringify({ type: 'server_hello', id: msg.id }));
    } else if (type === 'subscribe') {
      const ids = (msg.payload && msg.payload.session_ids) || [];
      console.log('MOCK_WS_SUBSCRIBE ' + JSON.stringify(ids));
      ws.send(JSON.stringify({ type: 'subscribed', id: msg.id }));
    } else {
      console.log('MOCK_WS_MSG ' + JSON.stringify({ type }));
    }
  });
  ws.on('close', () => console.log('MOCK_WS_CLOSE'));
});

function broadcast(obj) {
  const line = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(line);
  }
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/openapi.json') {
    return json(res, 200, { openapi: '3.0.0', info: { title: 'mock-kimi-server', version: '0.0.0' }, paths: {} });
  }

  if (req.method === 'GET' && p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html><head><meta charset="utf-8"><title>Mock Kimi</title></head><body><h1>Mock Kimi Server</h1></body></html>');
  }

  // 问题答案提交
  const qm = p.match(/^\/api\/v1\/sessions\/([^/]+)\/questions\/([^/]+)$/);
  if (req.method === 'POST' && qm) {
    const body = await readBody(req);
    const record = { sid: qm[1], qid: qm[2], receivedAt: new Date().toISOString(), ...body };
    fs.appendFileSync(answersFile, JSON.stringify(record) + '\n');
    console.log('MOCK_ANSWER ' + JSON.stringify(record));
    return json(res, 200, { code: 0, data: {} });
  }

  if (req.method === 'POST' && p === '/control/emit') {
    const body = await readBody(req);
    const name = body.scenario;
    const build = scenarios[name];
    if (!build) return json(res, 400, { code: 1, error: 'unknown scenario: ' + name });
    const { event, payload } = build(body);
    broadcast({ event, session_id: body.session_id || DEFAULT_SESSION, payload });
    console.log('MOCK_EMIT ' + JSON.stringify({ event }));
    return json(res, 200, { code: 0, emitted: name });
  }

  if (req.method === 'GET' && p === '/control/scenarios') {
    return json(res, 200, { code: 0, scenarios: Object.keys(scenarios) });
  }

  json(res, 404, { code: 1, error: 'not found' });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/api/v1/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, () => console.log(`MOCK_READY port=${PORT}`));
