// Skills 管理模块单元测试
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// 通过 KIMI_CODE_HOME 指向临时目录，隔离真实数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-skills-test-'));
process.env.KIMI_CODE_HOME = tmpDir;

const skillsManager = require('../src/main/skills-manager');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function run() {
  console.log('测试目录:', tmpDir);

  // 1. frontmatter 解析：标准格式
  const parsed = skillsManager.parseFrontmatter('---\nname: demo\ndescription: "测试: 技能"\n---\n\n# 正文\n内容');
  assert.strictEqual(parsed.frontmatter.name, 'demo');
  assert.strictEqual(parsed.frontmatter.description, '测试: 技能');
  assert.strictEqual(parsed.body.trim(), '# 正文\n内容');
  console.log('✅ frontmatter 标准解析');

  // 2. frontmatter 解析：无 frontmatter 时原样返回
  const plain = skillsManager.parseFrontmatter('# 仅正文');
  assert.deepStrictEqual(plain.frontmatter, {});
  assert.strictEqual(plain.body, '# 仅正文');
  console.log('✅ 无 frontmatter 容错');

  // 3. 空目录扫描
  let res = skillsManager.scanSkills();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.skills.length, 0);
  console.log('✅ 空目录扫描');

  // 4. 新建技能后可扫描到（user 来源）
  skillsManager.saveSkill({ name: 'my-skill', description: '我的技能', body: '# Hello\n' });
  const skillFile = path.join(tmpDir, 'skills', 'my-skill', 'SKILL.md');
  assert.ok(fs.existsSync(skillFile), 'SKILL.md 应被创建');
  const written = fs.readFileSync(skillFile, 'utf8');
  assert.ok(written.includes('name: my-skill'));
  assert.ok(written.includes('description: "我的技能"'));
  assert.ok(written.includes('# Hello'));
  res = skillsManager.scanSkills();
  assert.strictEqual(res.skills.length, 1);
  assert.strictEqual(res.skills[0].name, 'my-skill');
  assert.strictEqual(res.skills[0].description, '我的技能');
  assert.strictEqual(res.skills[0].source, 'user');
  assert.strictEqual(res.skills[0].readonly, false);
  console.log('✅ 新建与扫描');

  // 5. 非法名称拒绝
  assert.throws(() => skillsManager.saveSkill({ name: 'Bad_Name!', description: '', body: '' }), /技能名称/);
  assert.throws(() => skillsManager.saveSkill({ name: '../escape', description: '', body: '' }), /技能名称|非法/);
  console.log('✅ 非法名称校验');

  // 6. 重命名：originalName 不同则删除旧目录
  skillsManager.saveSkill({ originalName: 'my-skill', name: 'renamed-skill', description: '改名', body: 'x' });
  assert.ok(!fs.existsSync(path.join(tmpDir, 'skills', 'my-skill')), '旧目录应被删除');
  assert.ok(fs.existsSync(path.join(tmpDir, 'skills', 'renamed-skill', 'SKILL.md')), '新目录应存在');
  console.log('✅ 重命名');

  // 7. extra_skill_dirs 扫描（只读来源）
  const extraRoot = path.join(tmpDir, 'extra-skills');
  fs.mkdirSync(path.join(extraRoot, 'ext-skill'), { recursive: true });
  fs.writeFileSync(path.join(extraRoot, 'ext-skill', 'SKILL.md'), '---\nname: ext-skill\ndescription: 外部技能\n---\nbody', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'config.toml'), `extra_skill_dirs = ["${extraRoot.replace(/\\/g, '\\\\')}"]\n`, 'utf8');
  res = skillsManager.scanSkills();
  const ext = res.skills.find((s) => s.name === 'ext-skill');
  assert.ok(ext, '应扫描到 extra 技能');
  assert.strictEqual(ext.source, 'extra');
  assert.strictEqual(ext.readonly, true);
  console.log('✅ extra_skill_dirs 只读扫描');

  // 8. 删除：仅允许用户级
  assert.throws(() => skillsManager.deleteSkill('ext-skill'), /仅允许删除用户级|非法|不存在/);
  skillsManager.deleteSkill('renamed-skill');
  assert.ok(!fs.existsSync(path.join(tmpDir, 'skills', 'renamed-skill')), '用户级技能应被删除');
  console.log('✅ 删除与越权保护');

  console.log('\n全部 skills-manager 测试通过');
}

try {
  run();
} finally {
  cleanup();
}
