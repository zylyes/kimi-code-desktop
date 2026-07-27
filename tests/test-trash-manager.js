// 回收站管理模块单元测试
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// 通过 KIMI_CODE_HOME 指向临时目录，隔离真实数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-trash-test-'));
process.env.KIMI_CODE_HOME = tmpDir;

const { moveToTrash, listTrash, restoreFromTrash, purgeTrash } = require('../src/main/trash-manager');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function run() {
  console.log('测试目录:', tmpDir);

  // 准备测试会话目录
  const sessionId = 'test-session-123';
  const sessionDir = path.join(tmpDir, 'sessions', 'wd_test', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ title: '测试会话', updatedAt: Date.now() }), 'utf8');
  const workDir = path.join(tmpDir, 'projects', 'my-project');
  fs.mkdirSync(workDir, { recursive: true });

  // 1. moveToTrash → listTrash 验证
  const entryName = moveToTrash(tmpDir, { sessionId, sessionDir, workDir, title: '测试会话' });
  assert.ok(entryName, '应返回条目目录名');
  assert.ok(entryName.startsWith(sessionId + '_'), '条目名应以 sessionId_ 开头');
  console.log('✅ moveToTrash 返回条目名:', entryName);

  // 验证原目录已不存在
  assert.ok(!fs.existsSync(sessionDir), '原会话目录应已被移动');
  // 验证回收站目录存在
  const trashDir = path.join(tmpDir, '.trash');
  assert.ok(fs.existsSync(trashDir), '.trash 目录应存在');
  const entryDir = path.join(trashDir, entryName);
  assert.ok(fs.existsSync(entryDir), '条目目录应存在');
  // 验证 meta.json
  const metaPath = path.join(entryDir, 'meta.json');
  assert.ok(fs.existsSync(metaPath), 'meta.json 应存在');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.strictEqual(meta.sessionId, sessionId);
  assert.strictEqual(meta.originalDir, sessionDir);
  assert.strictEqual(meta.workDir, workDir);
  assert.strictEqual(meta.title, '测试会话');
  assert.ok(meta.deletedAt, 'deletedAt 应为 ISO 字符串');
  console.log('✅ moveToTrash 创建了 meta.json');

  // 2. listTrash 验证
  let trashList = listTrash(tmpDir);
  assert.ok(Array.isArray(trashList), 'listTrash 应返回数组');
  assert.strictEqual(trashList.length, 1, '应有一个条目');
  assert.strictEqual(trashList[0].entryName, entryName);
  assert.strictEqual(trashList[0].sessionId, sessionId);
  assert.strictEqual(trashList[0].originalDir, sessionDir);
  assert.strictEqual(trashList[0].workDir, workDir);
  assert.strictEqual(trashList[0].title, '测试会话');
  assert.ok(trashList[0].deletedAt, '应有 deletedAt');
  console.log('✅ listTrash 返回正确条目');

  // 3. 多个条目时按 deletedAt 倒序
  const sessionId2 = 'test-session-456';
  const sessionDir2 = path.join(tmpDir, 'sessions', 'wd_other', sessionId2);
  fs.mkdirSync(sessionDir2, { recursive: true });
  fs.writeFileSync(path.join(sessionDir2, 'state.json'), JSON.stringify({ title: '会话2' }), 'utf8');
  // 等一小段时间确保时间戳不同
  const entryName2 = moveToTrash(tmpDir, { sessionId: sessionId2, sessionDir: sessionDir2, workDir: '', title: '会话2' });
  trashList = listTrash(tmpDir);
  assert.strictEqual(trashList.length, 2, '应有 2 个条目');
  // 最新的在前
  assert.strictEqual(trashList[0].entryName, entryName2, '最新的条目应在前面');
  assert.strictEqual(trashList[1].entryName, entryName, '旧的条目应在后面');
  console.log('✅ listTrash 按 deletedAt 倒序');

  // 4. restoreFromTrash 验证
  const restoredMeta = restoreFromTrash(tmpDir, entryName);
  assert.strictEqual(restoredMeta.sessionId, sessionId);
  assert.strictEqual(restoredMeta.originalDir, sessionDir);
  // 验证目录已恢复
  assert.ok(fs.existsSync(sessionDir), '会话目录应已恢复');
  assert.ok(fs.existsSync(path.join(sessionDir, 'state.json')), 'state.json 应存在');
  // 验证回收站条目已删除
  assert.ok(!fs.existsSync(entryDir), '回收站条目目录应已删除');
  console.log('✅ restoreFromTrash 恢复成功');

  // 5. restoreFromTrash 时 originalDir 已存在 → throw
  // 重新移入回收站
  const entryName3 = moveToTrash(tmpDir, { sessionId, sessionDir, workDir, title: '测试会话' });
  // 重建 originalDir
  fs.mkdirSync(sessionDir, { recursive: true });
  assert.throws(() => {
    restoreFromTrash(tmpDir, entryName3);
  }, /目标目录已存在|已存在/, 'originalDir 已存在时应 throw');
  console.log('✅ restoreFromTrash 目标目录已存在时 throw');

  // 清理重建的目录，恢复条目以便后续测试
  fs.rmSync(sessionDir, { recursive: true, force: true });
  restoreFromTrash(tmpDir, entryName3);

  // 6. purgeTrash 验证
  // 重新移入回收站
  const entryName4 = moveToTrash(tmpDir, { sessionId, sessionDir, workDir, title: '测试会话' });
  purgeTrash(tmpDir, entryName4);
  assert.ok(!fs.existsSync(path.join(trashDir, entryName4)), '条目目录应被彻底删除');
  trashList = listTrash(tmpDir);
  // 只剩 sessionId2 的条目
  assert.strictEqual(trashList.length, 1, 'purge 后应只剩 1 个条目');
  console.log('✅ purgeTrash 彻底删除成功');

  // 7. entryName 含 .. → throw
  assert.throws(() => {
    restoreFromTrash(tmpDir, '../escape');
  }, /非法/, 'entryName 含 .. 应 throw');
  assert.throws(() => {
    purgeTrash(tmpDir, 'foo/bar');
  }, /非法/, 'entryName 含斜杠应 throw');
  assert.throws(() => {
    moveToTrash(tmpDir, { sessionId: '../bad', sessionDir, workDir, title: '' });
  }, /非法/, 'sessionId 含 .. 应 throw');
  console.log('✅ 路径穿越防护');

  // 8. meta.json 损坏条目跳过
  // 创建一个损坏的条目
  const badEntry = 'bad-entry_20260101-120000';
  const badDir = path.join(trashDir, badEntry);
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'meta.json'), 'not-json', 'utf8');
  trashList = listTrash(tmpDir);
  // 不应包含损坏条目
  const hasBad = trashList.some((e) => e.entryName === badEntry);
  assert.ok(!hasBad, '损坏的 meta.json 条目应被跳过');
  console.log('✅ meta.json 损坏条目跳过');

  // 9. .trash 不存在时 listTrash 返回 []
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-trash-empty-'));
  const emptyList = listTrash(emptyHome);
  assert.ok(Array.isArray(emptyList), 'listTrash 应返回数组');
  assert.strictEqual(emptyList.length, 0, '.trash 不存在时应返回空数组');
  fs.rmSync(emptyHome, { recursive: true, force: true });
  console.log('✅ .trash 不存在时 listTrash 返回 []');

  // 10. 全生命周期：move → list → restore → list
  const sidCycle = 'cycle-session';
  const sdirCycle = path.join(tmpDir, 'sessions', 'wd_cycle', sidCycle);
  fs.mkdirSync(sdirCycle, { recursive: true });
  const eName = moveToTrash(tmpDir, { sessionId: sidCycle, sessionDir: sdirCycle, workDir: '', title: '循环' });
  let list = listTrash(tmpDir);
  assert.ok(list.some((e) => e.entryName === eName), '应出现在回收站');
  restoreFromTrash(tmpDir, eName);
  assert.ok(fs.existsSync(sdirCycle), '应恢复');
  list = listTrash(tmpDir);
  assert.ok(!list.some((e) => e.entryName === eName), '恢复后应不在回收站');
  console.log('✅ 全生命周期：move → list → restore → list');

  console.log('\n全部 trash-manager 测试通过');
}

try {
  run();
} finally {
  cleanup();
}