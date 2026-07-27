// Kimi Code Desktop — 插件管理后端
// 只读扫描 $KIMI_CODE_HOME/plugins/managed/<id>/ 的插件清单（kimi.plugin.json），
// 并尝试从 installed.json 合并启用状态。installed.json 格式未官方文档化，
// 全部防御性解析：认不出的字段跳过，启停写回仅在能定位条目时进行，否则提示用 /plugins 命令。
const fs = require('fs');
const path = require('path');
const { getKimiHomeDir } = require('./config-manager');

function pluginsRoot() {
  return path.join(getKimiHomeDir(), 'plugins');
}

function managedDir() {
  return path.join(pluginsRoot(), 'managed');
}

function installedJsonPath() {
  return path.join(pluginsRoot(), 'installed.json');
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// 读取单个插件目录的清单：kimi.plugin.json 优先，其次 .kimi-plugin/plugin.json
function readManifest(pluginDir) {
  const candidates = [
    path.join(pluginDir, 'kimi.plugin.json'),
    path.join(pluginDir, '.kimi-plugin', 'plugin.json'),
  ];
  for (const p of candidates) {
    const data = readJSON(p);
    if (data && typeof data === 'object') return { data, path: p };
  }
  return null;
}

// installed.json 条目归一化：兼容 {id: entry} 映射、数组、{plugins: ...} 三种形态
function normalizeInstalled(raw) {
  const entries = [];
  if (!raw || typeof raw !== 'object') return entries;
  let list = raw;
  if (Array.isArray(raw.plugins) || (raw.plugins && typeof raw.plugins === 'object')) {
    list = raw.plugins;
  }
  if (Array.isArray(list)) {
    for (const item of list) {
      if (item && typeof item === 'object') {
        const id = item.id || item.name;
        if (id) entries.push({ id, entry: item });
      }
    }
  } else if (list && typeof list === 'object') {
    for (const [id, entry] of Object.entries(list)) {
      if (entry && typeof entry === 'object') entries.push({ id, entry });
    }
  }
  return entries;
}

function entryEnabled(entry) {
  if (!entry || typeof entry !== 'object') return true;
  if (entry.enabled === false) return false;
  if (entry.disabled === true) return false;
  return true;
}

// 列出插件：managed/ 目录扫描 + installed.json 状态合并
function listPlugins() {
  const plugins = [];
  const managed = managedDir();
  let dirs = [];
  try {
    dirs = fs.readdirSync(managed, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    dirs = [];
  }
  const installedRaw = readJSON(installedJsonPath());
  const installedEntries = normalizeInstalled(installedRaw);
  const installedById = new Map(installedEntries.map((x) => [x.id, x.entry]));
  const seen = new Set();

  for (const dir of dirs) {
    const pluginDir = path.join(managed, dir.name);
    const manifest = readManifest(pluginDir);
    const m = manifest ? manifest.data : {};
    const id = m.name || dir.name;
    seen.add(id);
    const rec = installedById.get(id);
    plugins.push({
      id,
      dirName: dir.name,
      version: m.version || (rec && rec.version) || '',
      description: m.description || '',
      displayName: (m.interface && m.interface.displayName) || m.name || dir.name,
      hasManifest: !!manifest,
      enabled: entryEnabled(rec),
      source: (rec && (rec.source || rec.origin)) || '',
      installedAt: (rec && (rec.installedAt || rec.installed_at)) || '',
      canToggle: !!rec, // 仅在 installed.json 中能定位条目时支持写回
    });
  }
  // installed.json 中有记录但 managed/ 目录缺失的插件（记录残留）
  for (const { id, entry } of installedEntries) {
    if (seen.has(id)) continue;
    plugins.push({
      id,
      dirName: '',
      version: entry.version || '',
      description: '',
      displayName: id,
      hasManifest: false,
      enabled: entryEnabled(entry),
      source: entry.source || entry.origin || '',
      installedAt: entry.installedAt || entry.installed_at || '',
      canToggle: true,
      missing: true, // managed 目录缺失
    });
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    plugins,
    root: pluginsRoot(),
    installedJsonFound: installedRaw != null,
  };
}

// 启用/禁用：仅在 installed.json 可解析且能定位条目时写回（写前 .bak 备份）
function setPluginEnabled(id, enabled) {
  if (!id || typeof id !== 'string') {
    return { ok: false, reason: 'invalid', message: '非法的插件 ID' };
  }
  const p = installedJsonPath();
  const raw = readJSON(p);
  if (raw == null) {
    return { ok: false, reason: 'unsupported', message: 'installed.json 不存在或无法解析，请在会话中使用 /plugins enable|disable 命令' };
  }
  // 定位条目：优先顶层映射/数组，其次 plugins 容器
  const containers = [raw];
  if (raw.plugins && typeof raw.plugins === 'object') containers.unshift(raw.plugins);
  for (const container of containers) {
    if (Array.isArray(container)) {
      for (const item of container) {
        if (item && typeof item === 'object' && (item.id === id || item.name === id)) {
          return writeEnabled(p, raw, item, enabled);
        }
      }
    } else if (container && typeof container === 'object' && container[id] && typeof container[id] === 'object') {
      return writeEnabled(p, raw, container[id], enabled);
    }
  }
  return { ok: false, reason: 'not-found', message: `installed.json 中未找到插件「${id}」，请在会话中使用 /plugins enable|disable ${id}` };
}

function writeEnabled(jsonPath, raw, entry, enabled) {
  entry.enabled = enabled === true;
  delete entry.disabled; // 统一用 enabled 字段，避免双字段冲突
  try {
    fs.copyFileSync(jsonPath, jsonPath + '.bak');
  } catch { /* 备份失败不阻断 */ }
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2), 'utf8');
    return { ok: true, enabled: entry.enabled, note: '插件变更需 /reload 或新会话后生效' };
  } catch (err) {
    try {
      fs.copyFileSync(jsonPath + '.bak', jsonPath);
    } catch { /* ignore */ }
    return { ok: false, reason: 'write-failed', message: `installed.json 写入失败：${err.message}` };
  }
}

module.exports = {
  pluginsRoot,
  managedDir,
  installedJsonPath,
  readManifest,
  normalizeInstalled,
  listPlugins,
  setPluginEnabled,
};
