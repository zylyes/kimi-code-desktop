// session-dir-guard 模块测试（M6 高危项：sessionDir 本体校验）
// 用法：node test-session-dir-guard.js
// 真实 fs 可执行测试（非仅静态断言）：构造临时根内 sessions 目录树，验证
//  - 根内真实目录 → 通过（bound 前提成立）
//  - 普通文件 / symlink / junction（Windows 可用时）/ lstat 失败 → 全部拒绝
//  - 拒绝情形不得触发 Files/Git 授权：helper 层拒绝（可执行）+ main.js 调用链
//    静态核验（workspaceBoundWorkDir → workspaceBoundSessionContext → isRealDirectoryBody；
//    workspace:changes/files/diff 拒绝时返回 'unbound'，不触碰 gitService/fileBrowser）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../src/main/session-dir-guard');

function setupRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcd-sdg-'));
  const sessionsRoot = path.join(root, 'sessions');
  fs.mkdirSync(sessionsRoot);
  return { root, sessionsRoot };
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------- 1. 根内真实目录通过 ----------
function testRealDirectoryPasses() {
  const { root, sessionsRoot } = setupRoot();
  try {
    const sid = 'session_real_dir_001';
    const sessionDir = path.join(sessionsRoot, sid);
    fs.mkdirSync(sessionDir);
    assert.strictEqual(mod.isRealDirectoryBody(sessionDir), true, '根内真实目录应通过');
    // 深一层子目录同样通过（本体判定不依赖层级）
    const nested = path.join(sessionDir, 'agents');
    fs.mkdirSync(nested);
    assert.strictEqual(mod.isRealDirectoryBody(nested), true, '嵌套真实目录应通过');
  } finally {
    cleanup(root);
  }
  console.log('✅ 根内真实目录：通过');
}

// ---------- 2. 普通文件拒绝 ----------
function testRegularFileRejected() {
  const { root, sessionsRoot } = setupRoot();
  try {
    const sid = 'session_fake_file_002'; // basename === sessionId 也不能授权
    const p = path.join(sessionsRoot, sid);
    fs.writeFileSync(p, 'not a directory');
    assert.strictEqual(mod.isRealDirectoryBody(p), false, '普通文件（即使 basename=sessionId）拒绝');
  } finally {
    cleanup(root);
  }
  console.log('✅ 普通文件：拒绝');
}

// ---------- 3. symlink 拒绝（创建可用时；Windows 需开发者模式/管理员） ----------
function testSymlinkRejected() {
  const { root, sessionsRoot } = setupRoot();
  let created = false;
  try {
    // 指向根外目录的 symlink（basename === sessionId 的攻击形态）
    const outside = path.join(root, 'outside-target');
    fs.mkdirSync(outside);
    const sid = 'session_symlink_003';
    const link = path.join(sessionsRoot, sid);
    try {
      fs.symlinkSync(outside, link, 'dir');
      created = true;
    } catch {
      console.log('⚠ 目录 symlink 创建不可用（权限/开发者模式），跳过 symlink 用例');
    }
    if (created) {
      assert.strictEqual(mod.isRealDirectoryBody(link), false, '指向根外的目录 symlink 拒绝');
    }
    // 指向根内真实目录的 symlink 同样拒绝（realpath 落点合法也无效）
    const realDir = path.join(sessionsRoot, 'real-target');
    fs.mkdirSync(realDir);
    const sid2 = 'session_symlink_004';
    const link2 = path.join(sessionsRoot, sid2);
    try {
      fs.symlinkSync(realDir, link2, 'dir');
      created = true;
    } catch {
      console.log('⚠ 目录 symlink 创建不可用，跳过根内目标 symlink 用例');
    }
    if (created) {
      assert.strictEqual(mod.isRealDirectoryBody(link2), false, '指向根内目录的 symlink 拒绝');
    }
    // dangling symlink（目标不存在）：lstat 仍能识别为 symlink → 拒绝
    const sid3 = 'session_symlink_005';
    const link3 = path.join(sessionsRoot, sid3);
    try {
      fs.symlinkSync(path.join(root, 'no-such-target'), link3, 'dir');
      created = true;
    } catch {
      console.log('⚠ 目录 symlink 创建不可用，跳过 dangling symlink 用例');
    }
    if (created) {
      assert.strictEqual(mod.isRealDirectoryBody(link3), false, 'dangling symlink 拒绝');
    }
  } finally {
    cleanup(root);
  }
  console.log('✅ symlink：拒绝');
}

// ---------- 4. junction 拒绝（Windows 专用，创建不需管理员权限） ----------
function testJunctionRejected() {
  if (process.platform !== 'win32') {
    console.log('⚠ 非 Windows 平台，跳过 junction 用例');
    return;
  }
  const { root, sessionsRoot } = setupRoot();
  try {
    const target = path.join(root, 'junction-target');
    fs.mkdirSync(target);
    const sid = 'session_junction_006'; // basename === sessionId
    const j = path.join(sessionsRoot, sid);
    try {
      fs.symlinkSync(target, j, 'junction');
    } catch (err) {
      console.log(`⚠ junction 创建失败（${err.code}），跳过 junction 用例`);
      return;
    }
    assert.strictEqual(mod.isRealDirectoryBody(j), false, 'junction（basename=sessionId）拒绝');
    // 指向根内真实目录的 junction 同样拒绝
    const realDir = path.join(sessionsRoot, 'junction-real-target');
    fs.mkdirSync(realDir);
    const j2 = path.join(sessionsRoot, 'session_junction_007');
    try {
      fs.symlinkSync(realDir, j2, 'junction');
    } catch (err) {
      console.log(`⚠ junction 创建失败（${err.code}），跳过根内目标 junction 用例`);
      return;
    }
    assert.strictEqual(mod.isRealDirectoryBody(j2), false, '指向根内目录的 junction 拒绝');
  } finally {
    cleanup(root);
  }
  console.log('✅ junction：拒绝');
}

// ---------- 5. lstat 失败拒绝 ----------
function testLstatFailureRejected() {
  const { root, sessionsRoot } = setupRoot();
  try {
    // 不存在的路径（ENOENT）
    assert.strictEqual(mod.isRealDirectoryBody(path.join(sessionsRoot, 'no-such-session-008')), false, '不存在的路径（lstat 失败）拒绝');
    // 空串 / 非字符串
    assert.strictEqual(mod.isRealDirectoryBody(''), false, '空串拒绝');
    assert.strictEqual(mod.isRealDirectoryBody(null), false, 'null 拒绝');
    assert.strictEqual(mod.isRealDirectoryBody(undefined), false, 'undefined 拒绝');
    assert.strictEqual(mod.isRealDirectoryBody(42), false, '非字符串拒绝');
    // 深层父路径缺失（lstat 同样 ENOENT）
    assert.strictEqual(mod.isRealDirectoryBody(path.join(sessionsRoot, 'a', 'b', 'c')), false, '父路径缺失拒绝');
  } finally {
    cleanup(root);
  }
  console.log('✅ lstat 失败：拒绝');
}

// ---------- 6. main.js 调用链静态核验（拒绝情形不得触发 Files/Git 授权） ----------
function testMainWiringStatic() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  // main 必须实际 require 并调用 helper（唯一本体判定入口，非测试专用死代码）
  assert.ok(/require\('\.\/session-dir-guard'\)/.test(src), 'main.js 应 require session-dir-guard');
  const ctxStart = src.indexOf('function workspaceBoundSessionContext()');
  const ctxEnd = src.indexOf('// 当前会话上下文：bound');
  assert.ok(ctxStart >= 0 && ctxEnd > ctxStart, '应包含 workspaceBoundSessionContext');
  const ctxBody = src.slice(ctxStart, ctxEnd);
  assert.ok(/sessionDirGuard\.isRealDirectoryBody\(sessionDir\)/.test(ctxBody), 'workspaceBoundSessionContext 必须调用 isRealDirectoryBody');
  // 本体 lstat 校验必须先于任何 realpath / 授权
  const lstatIdx = ctxBody.indexOf('isRealDirectoryBody');
  const realpathIdx = ctxBody.indexOf('realpathSync');
  assert.ok(lstatIdx >= 0 && realpathIdx > lstatIdx, '本体 lstat 校验必须在 realpath 之前');
  // 保留既有校验：containment / realpath 二次 containment / canonical basename===sessionId
  assert.ok(/insideRoot\(sessionDir\)/.test(ctxBody), '应保留 sessionDir containment');
  assert.ok(/insideRoot\(real\)/.test(ctxBody), '应保留 realpath 二次 containment');
  assert.ok(/path\.basename\(real\) !== sessionId/.test(ctxBody), '应保留 canonical basename===sessionId');
  // workspaceBoundWorkDir 建立在 workspaceBoundSessionContext 之上
  const boundStart = src.indexOf('function workspaceBoundWorkDir()');
  const boundBody = src.slice(boundStart, ctxStart);
  assert.ok(/const bound = workspaceBoundSessionContext\(\);/.test(boundBody), 'workspaceBoundWorkDir 必须建立在 workspaceBoundSessionContext 上');
  // M3 三个数据 IPC 必须先过 bound 守卫，拒绝时返回 'unbound'（不触碰 gitService/fileBrowser）
  const segs = [
    ['workspace:changes', src.indexOf("ipcMain.handle('workspace:changes'"), src.indexOf('// 文件浏览（M3）')],
    ['workspace:files', src.indexOf("ipcMain.handle('workspace:files'"), src.indexOf('// diff 预览（M3）')],
    ['workspace:diff', src.indexOf("ipcMain.handle('workspace:diff'"), src.indexOf('// 会话活动投影（M4）')],
  ];
  for (const [name, start, end] of segs) {
    assert.ok(start >= 0 && end > start, '应包含 ' + name + ' handler');
    const seg = src.slice(start, end);
    assert.ok(/const bound = workspaceBoundWorkDir\(\);/.test(seg), name + ' 应先经 bound 守卫');
    assert.ok(/'unbound'/.test(seg), name + ' 拒绝时应返回 unbound');
  }
  console.log('✅ main.js 调用链：helper 实际调用 / lstat 先于 realpath / 既有校验保留 / M3 IPC 拒绝时 unbound');
}

function run() {
  testRealDirectoryPasses();
  testRegularFileRejected();
  testSymlinkRejected();
  testJunctionRejected();
  testLstatFailureRejected();
  testMainWiringStatic();
  console.log('\n全部 session-dir-guard 测试通过');
}

run();
