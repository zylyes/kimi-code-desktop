// CLI 0.29.x 回归脚本：在真实 CLI 0.29.0 上自动执行 14 组回归中的可自动化组。
// 纯 Node，只用内置模块（不依赖 electron/ws）。
// 本脚本覆盖：①启动 ⑦会话管理 ⑧配置读写 ⑨登录形态 ⑪双 schema ⑫Windows 前置 ⑬doctor tui 与 server kill ⑭启动参数与代理
// ②③④⑤⑥⑩ 为人工/Electron 组，由 scripts/dev-verify.js 与人工核对覆盖，不在本脚本范围。
// 用法：node scripts/regression-0.29.js
// 退出码：存在 FAIL 时为 1，否则 0。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[?::1\]?):\d+/;

const results = []; // { group, status, lines }

function record(group, status, ...lines) {
  results.push({ group, status, lines });
  console.log(`[${status}] ${group}`);
  for (const l of lines) {
    if (l) console.log(`       ${l}`);
  }
}

// CLI 路径解析顺序：~/.kimi-code/bin/kimi.exe → ~/.kimi/bin/kimi.exe
function resolveCli() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.kimi-code', 'bin', 'kimi.exe'),
    path.join(home, '.kimi', 'bin', 'kimi.exe'),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  return null;
}

// token 读 ~/.kimi-code/server.token（utf8 trim），缺失返回空串，相关组降级或 SKIP
function readToken() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.kimi-code', 'server.token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function tail(output, n = 6) {
  return output.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join(' | ');
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// 内置 http 模块发 GET，带 Authorization: Bearer <token>
function httpGet(port, urlPath, token, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: urlPath,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
  });
}

// 统一子进程调用（带超时，捕获 stdout+stderr）
function runExec(cmd, args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, cwd }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`;
      if (!err) return resolve({ code: 0, output });
      const code = typeof err.code === 'number' ? err.code : -1;
      const extra = err.killed ? `（超过 ${timeoutMs}ms 被终止）` : `（${err.message}）`;
      resolve({ code, output: output + `\n[execFile 异常] ${extra}` });
    });
  });
}

// ①启动 + ⑦会话管理 + ⑪双 schema：共用一个临时 kimi web 实例，依次做完统一 kill
async function groupsServer(cli, token) {
  const port = 19300 + (process.pid % 500);
  let child;
  try {
    child = spawn(cli, ['web', '--no-open', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    record('① 启动', 'FAIL', `spawn kimi web 失败: ${err.message}`);
    record('⑦ 会话管理', 'SKIP', '① 失败，服务未启动');
    record('⑪ 双 schema', 'SKIP', '① 失败，服务未启动');
    return;
  }
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    // ① 启动：30s 内从 stdout/stderr 匹配服务地址
    const deadline = Date.now() + 30000;
    let match = null;
    while (Date.now() < deadline) {
      match = output.match(URL_RE);
      if (match || child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!match) {
      record('① 启动', 'FAIL', `30s 内未匹配到服务地址（端口 ${port}），输出末尾: ${tail(output)}`);
      record('⑦ 会话管理', 'SKIP', '① 失败，服务未就绪');
      record('⑪ 双 schema', 'SKIP', '① 失败，服务未就绪');
      return;
    }
    const realPort = Number(match[0].match(/:(\d+)$/)[1]);
    record('① 启动', 'PASS', `实际地址: ${match[0]}（请求端口 ${port}）`);

    // ⑦ 会话管理：GET /api/v1/sessions
    if (!token) {
      record('⑦ 会话管理', 'SKIP', '缺少 ~/.kimi-code/server.token，无法鉴权请求');
    } else {
      const r = await httpGet(realPort, '/api/v1/sessions', token);
      if (r.status === 200) {
        const j = tryParseJson(r.body);
        if (j) {
          const items = j.data && Array.isArray(j.data.items) ? j.data.items.length : '(未知)';
          record('⑦ 会话管理', 'PASS', `GET /api/v1/sessions -> 200，JSON 合法，code=${j.code}，会话数=${items}`);
        } else {
          record('⑦ 会话管理', 'FAIL', 'GET /api/v1/sessions -> 200 但 JSON 解析失败', r.body.slice(0, 200));
        }
      } else if (r.status === 404) {
        // 如实记录 openapi.json 中 sessions 相关路径的实际形态，供修复
        const spec = await httpGet(realPort, '/openapi.json', token);
        const j = spec.status === 200 ? tryParseJson(spec.body) : null;
        const sessPaths = j
          ? (Object.keys(j.paths || {}).filter((p) => /session/i.test(p)).join(', ') || '(无 session 路径)')
          : '(openapi.json 不可用)';
        record('⑦ 会话管理', 'FAIL', 'GET /api/v1/sessions -> 404', `openapi.json 中 sessions 相关路径: ${sessPaths}`);
      } else {
        record('⑦ 会话管理', 'FAIL', `GET /api/v1/sessions -> ${r.status || r.error}`, (r.body || '').slice(0, 200));
      }
    }

    // ⑪ 双 schema：GET /openapi.json 与 /asyncapi.json 均 200 且可解析
    if (!token) {
      record('⑪ 双 schema', 'SKIP', '缺少 ~/.kimi-code/server.token，无法鉴权请求');
    } else {
      const open = await httpGet(realPort, '/openapi.json', token);
      const asyncSpec = await httpGet(realPort, '/asyncapi.json', token);
      const oj = open.status === 200 ? tryParseJson(open.body) : null;
      const aj = asyncSpec.status === 200 ? tryParseJson(asyncSpec.body) : null;
      if (oj && aj) {
        record('⑪ 双 schema', 'PASS',
          `openapi.json -> 200，${(oj.info && oj.info.title) || ''} ${(oj.info && oj.info.version) || ''}，paths=${Object.keys(oj.paths || {}).length}`,
          `asyncapi.json -> 200，asyncapi ${aj.asyncapi || ''}，${(aj.info && aj.info.title) || ''}`);
      } else {
        record('⑪ 双 schema', 'FAIL',
          `openapi.json -> ${open.status || open.error}${oj ? '' : '（不可解析）'}`,
          `asyncapi.json -> ${asyncSpec.status || asyncSpec.error}${aj ? '' : '（不可解析）'}`);
      }
    }
  } finally {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000));
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

// ⑧ 配置读写：配置管理模块单测 + 真实 CLI doctor config 校验配置副本
async function groupConfig(cli, tmpDir) {
  const lines = [];
  const t = await runExec(process.execPath, [path.join('tests', 'test-config-manager.js')], 40000, PROJECT_ROOT);
  const half1 = t.code === 0;
  lines.push(`node tests/test-config-manager.js 退出码 ${t.code}${half1 ? '' : `，输出末尾: ${tail(t.output)}`}`);

  // 把 ~/.kimi-code/config.toml 复制到临时目录；不存在则写最小合法内容
  const srcCfg = path.join(os.homedir(), '.kimi-code', 'config.toml');
  const dstCfg = path.join(tmpDir, 'config.toml');
  if (fs.existsSync(srcCfg)) {
    fs.copyFileSync(srcCfg, dstCfg);
    lines.push('已复制 ~/.kimi-code/config.toml 到临时目录');
  } else {
    fs.writeFileSync(dstCfg, 'default_model = "kimi-for-coding"\n', 'utf8');
    lines.push('~/.kimi-code/config.toml 不存在，已写最小合法内容');
  }

  let r = await runExec(cli, ['doctor', 'config', dstCfg], 30000);
  lines.push(`kimi doctor config <副本文件> 退出码 ${r.code}`);
  if (r.code !== 0) {
    // 参数形态自适应：先看 doctor --help，再换目录形态重试一次
    const help = await runExec(cli, ['doctor', '--help'], 20000);
    lines.push(`doctor --help 输出末尾: ${tail(help.output)}`);
    r = await runExec(cli, ['doctor', 'config', tmpDir], 30000);
    lines.push(`自适应重试 kimi doctor config <目录> 退出码 ${r.code}`);
  }
  lines.push(`doctor 输出末尾: ${tail(r.output)}`);
  record('⑧ 配置读写', half1 && r.code === 0 ? 'PASS' : 'FAIL', ...lines);
}

// ⑨ 登录形态：login --help 宽松匹配设备码非交互登录关键词
async function groupLogin(cli) {
  const r = await runExec(cli, ['login', '--help'], 20000);
  const re = /device|设备码|verification|code/i;
  const hit = r.output.split(/\r?\n/).find((l) => re.test(l));
  if (r.code === 0 && hit) {
    record('⑨ 登录形态', 'PASS', `匹配行摘录: ${hit.trim()}`);
  } else {
    record('⑨ 登录形态', 'FAIL', `退出码 ${r.code}，未命中设备码关键词，输出头部 20 行:`, r.output.split(/\r?\n/).slice(0, 20).join(' | '));
  }
}

// ⑫ Windows 前置：Node 版本、Git Bash 检出、Windows native 升级文档结论
function groupWindowsPrereq() {
  const lines = [];
  const [maj, min] = process.versions.node.split('.').map(Number);
  const nodeOk = maj > 22 || (maj === 22 && min >= 19);
  lines.push(`Node ${process.version}（要求 >= v22.19.0）`);

  let bashPath = '';
  const envShell = process.env.KIMI_SHELL_PATH;
  if (envShell && fs.existsSync(envShell)) {
    bashPath = envShell;
  } else if (fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')) {
    bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
  }
  lines.push(bashPath ? `Git Bash 检出路径: ${bashPath}` : 'Git Bash 未检出（KIMI_SHELL_PATH 无效且默认路径不存在）');
  lines.push('依据官方文档，未实测：Windows native 安装无法自动升级，仅打印手动更新命令');
  record('⑫ Windows 前置', nodeOk && bashPath ? 'PASS' : 'FAIL', ...lines);
}

// ⑬ doctor tui 与 server kill：tui.toml 副本校验 + server kill --help 存在性
async function groupDoctorTui(cli, tmpDir) {
  const lines = [];
  const tuiPath = path.join(tmpDir, 'tui.toml');
  fs.writeFileSync(tuiPath, 'theme = "auto"\n', 'utf8');
  let r = await runExec(cli, ['doctor', 'tui', tuiPath], 30000);
  lines.push(`kimi doctor tui <副本文件> 退出码 ${r.code}`);
  if (r.code !== 0) {
    // 参数形态自适应：先看 doctor --help，再换目录形态重试一次
    const help = await runExec(cli, ['doctor', '--help'], 20000);
    lines.push(`doctor --help 输出末尾: ${tail(help.output)}`);
    r = await runExec(cli, ['doctor', 'tui', tmpDir], 30000);
    lines.push(`自适应重试 kimi doctor tui <目录> 退出码 ${r.code}`);
  }
  lines.push(`doctor 输出末尾: ${tail(r.output)}`);

  // 存在性检查：绝不允许执行不带 --help 的 server kill
  const k = await runExec(cli, ['server', 'kill', '--help'], 20000);
  lines.push(`kimi server kill --help 退出码 ${k.code}${k.code === 0 ? `，输出首行: ${(k.output.split(/\r?\n/)[0] || '').trim()}` : ''}`);
  record('⑬ doctor tui 与 server kill', r.code === 0 && k.code === 0 ? 'PASS' : 'FAIL', ...lines);
}

// ⑭ 启动参数与代理：--help 关键词核对 + main.js buildKimiEnv 代理透传静态断言
async function groupArgsAndProxy(cli) {
  const lines = [];
  const top = await runExec(cli, ['--help'], 20000);
  const web = await runExec(cli, ['web', '--help'], 20000);
  const combined = `${top.output}\n${web.output}`;
  const allLines = combined.split(/\r?\n/);

  let ok = true;
  // 宽松关键词组：命中即摘录
  const checks = [
    ['非交互打印（-p/--print/--prompt）', /(?:^|\s)-p[,\s]|--print|--prompt/],
    ['--yolo', /--yolo/],
    ['--auto', /--auto/],
    ['--plan', /--plan/],
    ['会话恢复（-r/--resume/--session）', /(?:^|\s)-r[,\s]|--resume|--session/],
  ];
  for (const [label, re] of checks) {
    const hit = allLines.find((l) => re.test(l));
    if (hit) {
      lines.push(`${label} 命中: ${hit.trim()}`);
    } else {
      ok = false;
      lines.push(`${label} 未命中`);
    }
  }

  // 静态断言：src/main/main.js 的 buildKimiEnv 透传四个代理变量
  const mainSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'main.js'), 'utf8');
  const fnMatch = mainSrc.match(/function buildKimiEnv\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const missing = fnMatch ? proxies.filter((v) => !fnMatch[0].includes(v)) : proxies;
  if (!fnMatch) {
    ok = false;
    lines.push('main.js 中未找到 buildKimiEnv 函数');
  } else if (missing.length) {
    ok = false;
    lines.push(`buildKimiEnv 未透传: ${missing.join(', ')}`);
  } else {
    lines.push('buildKimiEnv 透传 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY ✓');
  }
  record('⑭ 启动参数与代理', ok ? 'PASS' : 'FAIL', ...lines);
}

async function main() {
  const cli = resolveCli();
  if (!cli) {
    console.log('未找到 kimi CLI（已尝试 ~/.kimi-code/bin/kimi.exe、~/.kimi/bin/kimi.exe）');
    process.exit(1);
  }
  const ver = await runExec(cli, ['--version'], 20000);
  console.log(`CLI: ${cli}（版本 ${ver.output.trim() || '未知'}）`);
  const token = readToken();
  console.log(`token: ${token ? '已读取 ~/.kimi-code/server.token' : '缺失，相关组降级/SKIP'}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-regression-029-'));
  try {
    await groupsServer(cli, token);
    await groupConfig(cli, tmpDir);
    await groupLogin(cli);
    groupWindowsPrereq();
    await groupDoctorTui(cli, tmpDir);
    await groupArgsAndProxy(cli);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n===== 汇总 =====');
  for (const r of results) console.log(`[${r.status}] ${r.group}`);
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL');
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`共 ${results.length} 组：PASS ${pass} / FAIL ${fail.length} / SKIP ${skip}`);
  if (fail.length) {
    console.log(`FAIL 组: ${fail.map((r) => r.group).join('、')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`回归脚本异常: ${err.stack || err.message}`);
  process.exit(1);
});
