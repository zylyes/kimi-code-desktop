// Kimi Code Desktop — 配置中心后端
// 负责读写 ~/.kimi-code/config.toml、tui.toml、mcp.json，并在写入前调用 kimi doctor 校验。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const TOML = require('@iarna/toml');

function getKimiHomeDir() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function configTomlPath() { return path.join(getKimiHomeDir(), 'config.toml'); }
function tuiTomlPath() { return path.join(getKimiHomeDir(), 'tui.toml'); }
function mcpJsonPath(user = true, projectDir = null) {
  return user ? path.join(getKimiHomeDir(), 'mcp.json') : path.join(projectDir || process.cwd(), 'mcp.json');
}

function backupPath(p) { return p + '.bak'; }

function readText(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeText(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

function backupFile(p) {
  if (fs.existsSync(p)) {
    try { fs.copyFileSync(p, backupPath(p)); } catch { /* ignore */ }
  }
}

function restoreBackup(p) {
  const bp = backupPath(p);
  if (fs.existsSync(bp)) {
    try { fs.copyFileSync(bp, p); } catch { /* ignore */ }
  }
}

function parseToml(content, label) {
  try {
    return TOML.parse(content);
  } catch (err) {
    throw new Error(`${label} 解析失败: ${err.message}`);
  }
}

function stringifyToml(obj) {
  return TOML.stringify(obj);
}

function runDoctorSync(cliPath, env, opts) {
  if (!cliPath) return false;
  const isWin = process.platform === 'win32';
  const needsShell = isWin && !/\.exe$/i.test(cliPath);
  let argv;
  if (opts && opts.kind && opts.filePath) {
    argv = ['doctor', opts.kind, opts.filePath];
  } else {
    argv = ['doctor'];
  }
  const result = spawnSync(cliPath, argv, { env, windowsHide: true, shell: needsShell, timeout: 20000 });
  return result.status === 0;
}

function loadConfigToml(cliPath, env) {
  const p = configTomlPath();
  const content = readText(p, '');
  const data = content ? parseToml(content, 'config.toml') : {};
  const migrated = [];

  // 旧键迁移：仅在有 cliPath 可做 doctor 校验时执行写回
  if (cliPath && env) {
    // default_thinking (boolean) → thinking.enabled
    if (data.default_thinking !== undefined) {
      const val = data.default_thinking;
      if (typeof val === 'boolean') {
        if (data.thinking === undefined) data.thinking = {};
        if (data.thinking.enabled === undefined) {
          data.thinking.enabled = val;
        }
        delete data.default_thinking;
        migrated.push('default_thinking→thinking.enabled');
      }
    }

    // thinking.mode ('on'/'off'/'auto') → thinking.enabled
    if (data.thinking && data.thinking.mode !== undefined) {
      if (data.thinking.enabled === undefined) {
        const mode = data.thinking.mode;
        if (mode === 'on' || mode === 'auto') {
          data.thinking.enabled = true;
        } else if (mode === 'off') {
          data.thinking.enabled = false;
        }
        // 其它值无文档依据，保留不迁移
      }
      delete data.thinking.mode;
      if (!migrated.includes('thinking.mode→thinking.enabled')) {
        migrated.push('thinking.mode→thinking.enabled');
      }
    }

    // 有迁移则写回（备份 + doctor + 回滚）
    if (migrated.length > 0) {
      backupFile(p);
      let newContent;
      try {
        newContent = stringifyToml(data);
      } catch (err) {
        restoreBackup(p);
        throw new Error(`迁移序列化失败: ${err.message}`);
      }
      try {
        writeText(p, newContent);
      } catch (err) {
        restoreBackup(p);
        throw new Error(`迁移写回失败: ${err.message}`);
      }
      const ok = runDoctorSync(cliPath, env, { kind: 'config', filePath: p });
      if (!ok) {
        restoreBackup(p);
        throw new Error('迁移后 kimi doctor 校验失败，已恢复原文件');
      }
    }
  }

  return { ok: true, path: p, data, ...(migrated.length > 0 ? { migrated } : {}) };
}

function loadTuiToml() {
  const p = tuiTomlPath();
  const content = readText(p, '');
  const data = content ? parseToml(content, 'tui.toml') : {};
  return { path: p, content, data };
}

function loadMcpJson(user = true, projectDir = null) {
  const p = mcpJsonPath(user, projectDir);
  const data = readJSON(p, { mcpServers: {} });
  return { path: p, data };
}

async function runDoctor(cliPath, env, opts) {
  return new Promise((resolve) => {
    if (!cliPath) return resolve(false);
    const isWin = process.platform === 'win32';
    const needsShell = isWin && !/\.exe$/i.test(cliPath);
    let argv;
    if (opts && opts.kind && opts.filePath) {
      argv = ['doctor', opts.kind, opts.filePath];
    } else {
      argv = ['doctor'];
    }
    const proc = spawn(cliPath, argv, { env, windowsHide: true, shell: needsShell });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* ignore */ }
      resolve(false);
    }, 20000);
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('exit', (code) => { clearTimeout(timer); if (!timedOut) resolve(code === 0); });
  });
}

async function saveTomlFile(p, obj, cliPath, env, doctorOpts) {
  backupFile(p);
  let content;
  try {
    content = stringifyToml(obj);
  } catch (err) {
    restoreBackup(p);
    throw new Error(`TOML 序列化失败: ${err.message}`);
  }
  try {
    writeText(p, content);
  } catch (err) {
    restoreBackup(p);
    throw new Error(`文件写入失败: ${err.message}`);
  }
  const ok = await runDoctor(cliPath, env, doctorOpts);
  if (!ok) {
    restoreBackup(p);
    throw new Error('kimi doctor 校验失败，已恢复原文件');
  }
  return { ok: true };
}

async function saveConfigToml(obj, cliPath, env) {
  return saveTomlFile(configTomlPath(), obj, cliPath, env, { kind: 'config', filePath: configTomlPath() });
}

async function saveTuiToml(obj, cliPath, env) {
  return saveTomlFile(tuiTomlPath(), obj, cliPath, env, { kind: 'tui', filePath: tuiTomlPath() });
}

function saveMcpJson(obj, user = true, projectDir = null) {
  const p = mcpJsonPath(user, projectDir);
  backupFile(p);
  try {
    const content = JSON.stringify(obj, null, 2);
    writeText(p, content);
    return { ok: true, path: p };
  } catch (err) {
    restoreBackup(p);
    throw new Error(`mcp.json 写入失败: ${err.message}`);
  }
}

module.exports = {
  getKimiHomeDir,
  configTomlPath,
  tuiTomlPath,
  mcpJsonPath,
  loadConfigToml,
  saveConfigToml,
  loadTuiToml,
  saveTuiToml,
  loadMcpJson,
  saveMcpJson,
  runDoctor,
  runDoctorSync,
};
