// Kimi Code Desktop — IDE 一键接入向导后端
// 探测 kimi acp 可用性与本机 IDE（Zed / JetBrains），生成或写入各 IDE 的 ACP 接入配置。
// Zed 通过 settings.json 的 agent_servers 段自动写入；JetBrains 仅生成手动配置指引。
// 纯 Node 模块，禁止 require('electron'），保持可单测。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ACP_PROBE_TIMEOUT_MS = 3000;
const JETBRAINS_KEYWORDS = ['idea', 'pycharm', 'webstorm', 'goland', 'clion', 'rider'];

// 剥离 JSONC 注释（// 行注释与 /* */ 块注释），字符串字面量原样保留，
// 字符串内出现的 // 或 /* */ 一律不视为注释（关键边界）。
function stripJsoncComments(text) {
  let out = '';
  let inString = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        // 转义序列：连同下一个字符一起原样保留，避免 \" 被误判为字符串结束
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      // 行注释：跳到行尾；换行符本身保留，避免前后内容粘连
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2; // 跳过结尾 */；若未闭合则自然越界结束
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// 删除尾逗号：对象/数组闭合括号前的多余逗号，同样需要避开字符串字面量
function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      // 向前看：下一个非空白字符若是 } 或 ]，则丢弃该逗号
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

// JSONC → 可 JSON.parse 的纯 JSON 文本
function stripJsonc(text) {
  return stripTrailingCommas(stripJsoncComments(String(text == null ? '' : text)));
}

// 探测 kimi CLI 是否支持 acp 子命令：spawn `cliPath acp --help`，3 秒超时。
// 退出码 0，或输出中包含 usage / acp 关键字（部分 CLI 对 --help 返回非零码）视为可用。
function detectAcp(cliPath) {
  return new Promise((resolve) => {
    if (!cliPath || typeof cliPath !== 'string') {
      resolve({ available: false, detail: '未提供 kimi CLI 路径' });
      return;
    }
    const isWin = process.platform === 'win32';
    const needsShell = isWin && !/\.exe$/i.test(cliPath);
    let proc;
    try {
      proc = spawn(cliPath, ['acp', '--help'], { windowsHide: true, shell: needsShell });
    } catch (err) {
      resolve({ available: false, detail: `无法启动 kimi CLI（${cliPath}）: ${err.message}` });
      return;
    }
    let output = '';
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      // 注意：shell:true 时 kill 只杀掉壳进程，孙进程会自行退出，属可接受行为
      try { proc.kill(); } catch { /* ignore */ }
      done({ available: false, detail: `探测超时（${ACP_PROBE_TIMEOUT_MS / 1000} 秒无响应），kimi acp 可能不可用` });
    }, ACP_PROBE_TIMEOUT_MS);
    const onData = (chunk) => {
      if (output.length < 8192) output += chunk.toString(); // 截断保护，避免异常输出撑爆内存
    };
    if (proc.stdout) proc.stdout.on('data', onData);
    if (proc.stderr) proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      done({ available: false, detail: `无法启动 kimi CLI（${cliPath}）: ${err.message}` });
    });
    proc.on('close', (code) => {
      const text = output.toLowerCase();
      if (code === 0) {
        done({ available: true, detail: 'kimi acp --help 正常退出，ACP 可用' });
      } else if (text.includes('usage') || text.includes('acp')) {
        done({ available: true, detail: `退出码 ${code}，但输出包含 acp 用法信息，视为 ACP 可用` });
      } else {
        done({ available: false, detail: `kimi acp --help 退出码 ${code}，输出中未找到 acp 用法信息` });
      }
    });
  });
}

function listSubdirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// 探测本机已安装的 IDE。防御性读取，任何异常都不抛出。
function detectEditors() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

  // Zed：Windows 下安装位置固定在 %LOCALAPPDATA%\Programs\Zed\Zed.exe
  const zedExe = path.join(localAppData, 'Programs', 'Zed', 'Zed.exe');
  const zedInstalled = fs.existsSync(zedExe);
  const zed = {
    installed: zedInstalled,
    execPath: zedInstalled ? zedExe : null,
    // 无论文件是否存在都给出路径，便于向导直接写入配置
    settingsPath: path.join(appData, 'Zed', 'settings.json'),
  };

  // JetBrains：扫描各候选根目录下名字含 IDE 关键字的子目录
  // （Toolbox 实际把 IDE 放在 apps 子目录，故额外下探一层）
  const roots = [
    path.join(localAppData, 'JetBrains', 'Toolbox'),
    path.join(localAppData, 'JetBrains', 'Toolbox', 'apps'),
    path.join(localAppData, 'Programs'),
  ];
  const ides = [];
  for (const root of roots) {
    for (const name of listSubdirNames(root)) {
      const lower = name.toLowerCase();
      if (JETBRAINS_KEYWORDS.some((kw) => lower.includes(kw)) && !ides.includes(name)) {
        ides.push(name);
      }
    }
  }
  const jetbrains = { installed: ides.length > 0, ides };

  return { zed, jetbrains };
}

// Zed settings.json 的 agent_servers 配置片段
function buildZedSnippet(cliPath) {
  return {
    agent_servers: {
      'kimi-code': {
        command: cliPath,
        args: ['acp'],
      },
    },
  };
}

// 将 kimi-code agent 写入 Zed settings.json（JSONC）。
// 文件不存在则新建；解析失败或顶层非对象时返回 manualRequired，绝不改动原文件。
function applyZedConfig(settingsPath, cliPath) {
  let existing = {};
  let raw = '';
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return { ok: false, manualRequired: true, reason: `读取 settings.json 失败: ${err.message}` };
    }
    // 文件不存在：从空对象起步
  }
  if (raw.trim()) {
    try {
      existing = JSON.parse(stripJsonc(raw));
    } catch (err) {
      return { ok: false, manualRequired: true, reason: `settings.json 解析失败，请手动合并配置: ${err.message}` };
    }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return { ok: false, manualRequired: true, reason: 'settings.json 顶层不是 JSON 对象，无法自动合并' };
    }
  }

  // 深合并 agent_servers 段：保留用户已有的其它 agent 与所有其它顶层键
  const prevAgents = (existing.agent_servers && typeof existing.agent_servers === 'object' && !Array.isArray(existing.agent_servers))
    ? existing.agent_servers
    : {};
  existing.agent_servers = { ...prevAgents, ...buildZedSnippet(cliPath).agent_servers };

  // 写回前备份原文件（备份失败不阻断，与 config-manager 保持一致）
  if (fs.existsSync(settingsPath)) {
    try { fs.copyFileSync(settingsPath, settingsPath + '.bak'); } catch { /* ignore */ }
  }
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, manualRequired: true, reason: `写入 settings.json 失败: ${err.message}` };
  }
  return { ok: true, path: settingsPath };
}

// 通用 ACP 客户端配置片段（JSON 文本），供不支持自动写入的客户端手动粘贴
function buildGenericSnippet(cliPath) {
  return JSON.stringify({
    description: 'Kimi Code ACP Agent：在支持 Agent Client Protocol 的客户端中，以 stdio JSON-RPC 方式启动 kimi CLI。command 必须填写 kimi CLI 的绝对路径。',
    command: cliPath,
    args: ['acp'],
  }, null, 2);
}

// JetBrains IDE 手动配置指引（JetBrains 系只能在 IDE 内 UI 配置，桌面端无法代写文件）
function buildJetBrainsGuide(cliPath) {
  return [
    'JetBrains IDE 接入 Kimi Code（ACP）手动配置步骤：',
    '',
    '1. 打开 IDE，进入 Settings（Ctrl+Alt+S）→ Tools → AI Assistant → Configure ACP agents',
    '   （不同 IDE / 插件版本入口名称可能略有差异，如 "Agents" 或 "ACP"）。',
    '2. 点击 "+" / "Add" 新建一个 ACP Agent，名称填写：Kimi Code',
    '3. Command / Executable 一栏填写以下绝对路径：',
    `   ${cliPath}`,
    '4. Arguments / 参数一栏填写：acp',
    '5. 保存后，在 AI Assistant 的 Agent 列表中选择 "Kimi Code" 即可开始使用。',
    '',
    '注意：',
    `- 上述路径必须是可以直接执行的绝对路径（不支持 ~、相对路径或 PATH 查找），`,
    '  请按你的机器上 kimi CLI 的真实安装位置填写；若移动过安装位置请相应修改。',
    '- 若设置界面中没有 ACP 相关入口，请将 IDE 与 AI Assistant 插件升级到最新版本后重试。',
  ].join('\n');
}

module.exports = {
  detectAcp,
  detectEditors,
  buildZedSnippet,
  applyZedConfig,
  buildGenericSnippet,
  buildJetBrainsGuide,
  stripJsonc,
};
