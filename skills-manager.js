// Kimi Code Desktop — Skills 管理后端
// 扫描用户级 ~/.kimi-code/skills/ 与 config.toml extra_skill_dirs，解析 SKILL.md frontmatter。
// 新建/编辑/删除仅作用于用户级目录，extra 目录条目只读。
const fs = require('fs');
const path = require('path');
const { getKimiHomeDir, loadConfigToml } = require('./config-manager');

function userSkillsDir() {
  return path.join(getKimiHomeDir(), 'skills');
}

// 简易 YAML frontmatter 解析：仅支持 `key: value` 行（可带引号），足够覆盖 name/description
function parseFrontmatter(content) {
  const result = { frontmatter: {}, body: content || '' };
  if (!content || typeof content !== 'string') return result;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return result;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[kv[1]] = val;
  }
  return { frontmatter: fm, body: content.slice(m[0].length) };
}

function yamlQuote(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// 扫描一个技能根目录（其下每个子目录应含 SKILL.md）
function scanDir(rootDir, source) {
  const items = [];
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(rootDir, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const content = readText(skillFile);
    if (content == null) continue;
    const { frontmatter, body } = parseFrontmatter(content);
    items.push({
      name: frontmatter.name || entry.name,
      description: frontmatter.description || '',
      dirName: entry.name,
      path: skillFile,
      source, // 'user' | 'extra'
      readonly: source !== 'user',
      body,
    });
  }
  return items;
}

function scanSkills() {
  const results = [];
  results.push(...scanDir(userSkillsDir(), 'user'));
  try {
    const { data } = loadConfigToml();
    const extra = data && data.extra_skill_dirs;
    if (Array.isArray(extra)) {
      for (const d of extra) {
        if (typeof d === 'string' && d.trim()) {
          results.push(...scanDir(d.trim(), 'extra'));
        }
      }
    }
  } catch { /* config.toml 缺失或解析失败时忽略 extra 目录 */ }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, skills: results };
}

// 新建/编辑用户级技能；originalName 与 name 不同视为重命名
function saveSkill({ originalName, name, description, body }) {
  if (!NAME_RE.test(name || '')) {
    throw new Error('技能名称须为小写字母/数字/连字符，且以字母或数字开头');
  }
  const root = userSkillsDir();
  const skillDir = path.join(root, name);
  if (!isPathInside(root, skillDir)) {
    throw new Error('非法的技能目录');
  }
  if (originalName && originalName !== name) {
    deleteSkill(originalName);
  }
  const content = `---\nname: ${name}\ndescription: ${yamlQuote(description)}\n---\n\n${body || ''}`;
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  return { ok: true };
}

// 仅允许删除用户级目录内的技能
function deleteSkill(name) {
  if (!NAME_RE.test(name || '')) {
    throw new Error('非法的技能名称');
  }
  const root = userSkillsDir();
  const skillDir = path.join(root, name);
  if (!isPathInside(root, skillDir)) {
    throw new Error('仅允许删除用户级技能');
  }
  if (!fs.existsSync(skillDir)) {
    throw new Error('技能不存在或不可删除（extra 目录技能为只读）');
  }
  fs.rmSync(skillDir, { recursive: true, force: true });
  return { ok: true };
}

module.exports = {
  userSkillsDir,
  parseFrontmatter,
  scanSkills,
  saveSkill,
  deleteSkill,
};
