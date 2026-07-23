// 插件管理模块单元测试
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// 通过 KIMI_CODE_HOME 指向临时目录，隔离真实数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-plugins-test-'));
process.env.KIMI_CODE_HOME = tmpDir;

const pluginsManager = require('./plugins-manager');

const managedDirPath = path.join(tmpDir, 'plugins', 'managed');
const installedPath = path.join(tmpDir, 'plugins', 'installed.json');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// 写入 installed.json 辅助函数
function writeInstalled(data) {
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.writeFileSync(installedPath, JSON.stringify(data, null, 2), 'utf8');
}

function run() {
  console.log('测试目录:', tmpDir);

  // 1. 空目录（无 plugins/）：ok、空列表、installedJsonFound:false
  assert.strictEqual(pluginsManager.pluginsRoot(), path.join(tmpDir, 'plugins'));
  assert.strictEqual(pluginsManager.managedDir(), managedDirPath);
  assert.strictEqual(pluginsManager.installedJsonPath(), installedPath);
  let res = pluginsManager.listPlugins();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.plugins.length, 0);
  assert.strictEqual(res.installedJsonFound, false);
  console.log('✅ 空目录扫描');

  // 2. managed/<id>/kimi.plugin.json 清单解析
  const demoDir = path.join(managedDirPath, 'demo');
  fs.mkdirSync(demoDir, { recursive: true });
  fs.writeFileSync(path.join(demoDir, 'kimi.plugin.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.2.3',
    description: '演示插件',
    interface: { displayName: '演示插件 Demo' },
  }, null, 2), 'utf8');
  res = pluginsManager.listPlugins();
  const demo = res.plugins.find((p) => p.id === 'demo-plugin');
  assert.ok(demo, '应扫描到 demo-plugin');
  assert.strictEqual(demo.dirName, 'demo');
  assert.strictEqual(demo.version, '1.2.3');
  assert.strictEqual(demo.description, '演示插件');
  assert.strictEqual(demo.displayName, '演示插件 Demo');
  assert.strictEqual(demo.hasManifest, true);
  assert.strictEqual(demo.enabled, true); // 无 installed.json 记录时默认启用
  assert.strictEqual(demo.canToggle, false); // 无记录不可写回
  console.log('✅ kimi.plugin.json 清单解析');

  // 3. 无 kimi.plugin.json 时回退 .kimi-plugin/plugin.json
  const legacyDir = path.join(managedDirPath, 'legacy');
  fs.mkdirSync(path.join(legacyDir, '.kimi-plugin'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, '.kimi-plugin', 'plugin.json'), JSON.stringify({
    name: 'legacy-plugin',
    version: '0.1.0',
    description: '旧格式插件',
  }, null, 2), 'utf8');
  const manifest = pluginsManager.readManifest(legacyDir);
  assert.ok(manifest, '回退清单应被读到');
  assert.strictEqual(manifest.data.name, 'legacy-plugin');
  assert.ok(manifest.path.endsWith(path.join('.kimi-plugin', 'plugin.json')), '应命中回退路径');
  res = pluginsManager.listPlugins();
  const legacy = res.plugins.find((p) => p.id === 'legacy-plugin');
  assert.ok(legacy, '应扫描到 legacy-plugin');
  assert.strictEqual(legacy.hasManifest, true);
  assert.strictEqual(legacy.version, '0.1.0');
  console.log('✅ .kimi-plugin/plugin.json 回退');

  // 4. installed.json 映射形态 {id: {enabled:false, source}} 合并
  writeInstalled({ 'demo-plugin': { enabled: false, source: 'https://example.com/demo.kpg', version: '1.2.3' } });
  let entries = pluginsManager.normalizeInstalled(JSON.parse(fs.readFileSync(installedPath, 'utf8')));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].id, 'demo-plugin');
  res = pluginsManager.listPlugins();
  assert.strictEqual(res.installedJsonFound, true);
  const demoMapped = res.plugins.find((p) => p.id === 'demo-plugin');
  assert.strictEqual(demoMapped.enabled, false);
  assert.strictEqual(demoMapped.canToggle, true);
  assert.strictEqual(demoMapped.source, 'https://example.com/demo.kpg');
  console.log('✅ installed.json 映射形态合并');

  // 5. installed.json 数组形态 [{id, enabled:false}] 合并（附带 disabled 字段供用例 7 验证删除）
  writeInstalled([{ id: 'demo-plugin', enabled: false, disabled: true, source: 'array-src' }]);
  entries = pluginsManager.normalizeInstalled(JSON.parse(fs.readFileSync(installedPath, 'utf8')));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].id, 'demo-plugin');
  res = pluginsManager.listPlugins();
  const demoArr = res.plugins.find((p) => p.id === 'demo-plugin');
  assert.strictEqual(demoArr.enabled, false);
  assert.strictEqual(demoArr.canToggle, true);
  assert.strictEqual(demoArr.source, 'array-src');
  console.log('✅ installed.json 数组形态合并');

  // 6. installed.json 有记录但 managed/ 目录缺失 → missing:true
  writeInstalled([
    { id: 'demo-plugin', enabled: false, disabled: true, source: 'array-src' },
    { id: 'ghost-plugin', enabled: true, version: '9.9.9' },
  ]);
  res = pluginsManager.listPlugins();
  const ghost = res.plugins.find((p) => p.id === 'ghost-plugin');
  assert.ok(ghost, '应列出记录残留的 ghost-plugin');
  assert.strictEqual(ghost.missing, true);
  assert.strictEqual(ghost.hasManifest, false);
  assert.strictEqual(ghost.dirName, '');
  assert.strictEqual(ghost.version, '9.9.9');
  assert.strictEqual(ghost.canToggle, true);
  console.log('✅ managed 缺失标记 missing');

  // 7. setPluginEnabled 正常写回：enabled 翻转、disabled 删除、.bak 备份、再次扫描生效
  const r = pluginsManager.setPluginEnabled('demo-plugin', true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.enabled, true);
  assert.ok(typeof r.note === 'string' && r.note.includes('/reload'));
  assert.ok(fs.existsSync(installedPath + '.bak'), '写回前应生成 .bak 备份');
  const rawAfter = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  const itemAfter = rawAfter.find((x) => x.id === 'demo-plugin');
  assert.strictEqual(itemAfter.enabled, true);
  assert.ok(!('disabled' in itemAfter), 'disabled 字段应被删除');
  res = pluginsManager.listPlugins();
  const demoAfter = res.plugins.find((p) => p.id === 'demo-plugin');
  assert.strictEqual(demoAfter.enabled, true);
  console.log('✅ setPluginEnabled 写回');

  // 8. setPluginEnabled 未找到条目 → not-found
  const r2 = pluginsManager.setPluginEnabled('no-such-plugin', false);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'not-found');
  console.log('✅ 未找到条目返回 not-found');

  // 9. installed.json 缺失 → unsupported
  fs.rmSync(installedPath, { force: true });
  const r3 = pluginsManager.setPluginEnabled('demo-plugin', true);
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.reason, 'unsupported');
  console.log('✅ installed.json 缺失返回 unsupported');

  console.log('\n全部 plugins-manager 测试通过');
}

try {
  run();
} finally {
  cleanup();
}
