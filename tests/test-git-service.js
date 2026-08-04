// git-service 模块单元测试
// 用法：node test-git-service.js
// 测试在 os.tmpdir() 下创建临时真实 git 仓库（git init + 配置 user），
// 每条用例 try/finally 清理临时目录。
const assert = require('assert');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getChanges,
  getDiffPreview,
  LIMITS,
  _internals,
} = require('../src/main/git-service');

// ---------- 测试夹具 ----------

function git(dir, args, opts = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 30000, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} 失败 (${r.status}): ${(r.stderr || '').slice(0, 500)}`);
  }
  return r;
}

// 初始化临时 git 仓库：autocrlf=false 保证 numstat 行数精确（无 CRLF 干扰）
function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-svc-'));
  git(dir, ['init']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

function commitAll(dir, msg) {
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg]);
}

function write(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

// 模拟 child process：spawn 注入用；kill 后异步 close，超限/正常两种流程都可走
function makeFakeSpawn(chunks) {
  let calls = 0;
  const fn = () => {
    calls++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', 1));
    };
    setImmediate(() => {
      for (const c of chunks) {
        if (child.killed) break;
        child.stdout.emit('data', c);
      }
      if (!child.killed) child.emit('close', 0);
    });
    return child;
  };
  fn.calls = () => calls;
  return fn;
}

// 捕获 spawn 的 bin/args/env（模拟 child process）；chunksByCall 按调用次序提供 stdout
function makeCaptureSpawn(chunksByCall) {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args, env: opts.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', 1));
    };
    // 元素可为 Buffer（单块）或数组（多块）：Buffer 直接迭代会产出字节数字，须包装
    const perCall = chunksByCall[calls.length - 1] || [];
    const chunks = Array.isArray(perCall) ? perCall : [perCall];
    setImmediate(() => {
      for (const c of chunks) {
        if (child.killed) break;
        child.stdout.emit('data', c);
      }
      if (!child.killed) child.emit('close', 0);
    });
    return child;
  };
  fn.calls = () => calls;
  return fn;
}

// ---------- 1. 混合变更 ----------
async function testMixedChanges() {
  const dir = initRepo();
  try {
    // base（一次提交）
    write(dir, 'mod.txt', 'l1\nl2\nl3\n');
    write(dir, 'del.txt', 'd1\n');
    write(dir, 'sd.txt', 's1\n');
    git(dir, ['add', '.']);
    commitAll(dir, 'base');
    // 变更（之后不再 commit）
    write(dir, 'mod.txt', 'l1\nl2\nl3\nl4\n'); // unstaged modified
    write(dir, 'added.txt', 'n1\nn2\n'); // untracked → staged added
    git(dir, ['add', 'added.txt']);
    fs.unlinkSync(path.join(dir, 'del.txt')); // unstaged deleted
    git(dir, ['rm', 'sd.txt']); // staged deleted
    write(dir, 'untracked.txt', 'u1\n'); // untracked

    const r = await getChanges(dir);
    assert.strictEqual(r.ok, true, 'getChanges 应成功');
    assert.strictEqual(typeof r.snapshotId, 'string', 'snapshotId 应为字符串');
    assert.ok(r.snapshotId.length > 0);
    assert.strictEqual(typeof r.at, 'number', 'at 应为时间戳');
    assert.strictEqual(r.entries.length, 5, '应恰好 5 个条目');
    r.entries.forEach((e, i) => assert.strictEqual(e.id, i, 'id 应为数组下标'));

    const byPath = new Map(r.entries.map((e) => [e.path, e]));
    assert.strictEqual(byPath.get('mod.txt').status, 'modified');
    assert.deepStrictEqual(byPath.get('mod.txt').unstaged, { adds: 1, dels: 0 });
    assert.deepStrictEqual(byPath.get('mod.txt').staged, { adds: 0, dels: 0 });
    assert.strictEqual(byPath.get('added.txt').status, 'added');
    assert.deepStrictEqual(byPath.get('added.txt').unstaged, { adds: 0, dels: 0 });
    assert.deepStrictEqual(byPath.get('added.txt').staged, { adds: 2, dels: 0 });
    assert.strictEqual(byPath.get('del.txt').status, 'deleted');
    assert.deepStrictEqual(byPath.get('del.txt').unstaged, { adds: 0, dels: 1 });
    assert.deepStrictEqual(byPath.get('del.txt').staged, { adds: 0, dels: 0 });
    assert.strictEqual(byPath.get('sd.txt').status, 'deleted');
    assert.deepStrictEqual(byPath.get('sd.txt').unstaged, { adds: 0, dels: 0 });
    assert.deepStrictEqual(byPath.get('sd.txt').staged, { adds: 0, dels: 1 });
    assert.strictEqual(byPath.get('untracked.txt').status, 'untracked');
    assert.deepStrictEqual(byPath.get('untracked.txt').unstaged, { adds: 0, dels: 0 });
    assert.deepStrictEqual(byPath.get('untracked.txt').staged, { adds: 0, dels: 0 });
    console.log('✅ 混合变更：modified/added/deleted(staged+unstaged)/untracked 统计正确');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 2. staged/unstaged 独立计数 ----------
async function testStagedUnstagedIndependent() {
  const dir = initRepo();
  try {
    write(dir, 'f.txt', 'l1\nl2\nl3\n');
    write(dir, 'g.txt', 'g1\ng2\ng3\ng4\n');
    git(dir, ['add', '.']);
    commitAll(dir, 'base');
    // 变更阶段（之后不再 commit，避免吞 staged）
    write(dir, 'f.txt', 'l1\nl2\nl3\nl4\n');
    git(dir, ['add', 'f.txt']);
    write(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\n');
    write(dir, 'g.txt', 'g1\ng3\ng4\n');
    git(dir, ['add', 'g.txt']);
    write(dir, 'g.txt', 'g1\ng4\n');

    const r = await getChanges(dir);
    const f = r.entries.find((e) => e.path === 'f.txt');
    assert.ok(f, 'f.txt 条目应存在');
    assert.deepStrictEqual(f.staged, { adds: 1, dels: 0 }, 'staged 仅计第一次修改');
    assert.deepStrictEqual(f.unstaged, { adds: 1, dels: 0 }, 'unstaged 仅计第二次修改');
    const g = r.entries.find((e) => e.path === 'g.txt');
    assert.ok(g, 'g.txt 条目应存在');
    assert.deepStrictEqual(g.staged, { adds: 0, dels: 1 }, 'staged 仅计第一次删除');
    assert.deepStrictEqual(g.unstaged, { adds: 0, dels: 1 }, 'unstaged 仅计第二次删除');
    console.log('✅ staged/unstaged 独立：同文件先改后 stage 再改，两侧分别计数不合并');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 3. rename ----------
async function testRename() {
  const dir = initRepo();
  try {
    write(dir, 'old.txt', 'r1\nr2\n');
    git(dir, ['add', 'old.txt']);
    commitAll(dir, 'base');
    git(dir, ['mv', 'old.txt', 'new name.txt']); // rename + 目标含空格

    const r = await getChanges(dir);
    assert.strictEqual(r.entries.length, 1, '应恰好 1 个条目');
    const e = r.entries[0];
    assert.strictEqual(e.status, 'renamed');
    assert.strictEqual(e.path, 'new name.txt', 'path 应为新名');
    assert.strictEqual(e.oldPath, 'old.txt', 'oldPath 应为原路径');
    // 内容不变 rename → 行数 0/0
    assert.deepStrictEqual(e.staged, { adds: 0, dels: 0 });
    assert.deepStrictEqual(e.unstaged, { adds: 0, dels: 0 });
    console.log('✅ rename：git mv → renamed + oldPath，numstat 按新 path 关联');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 4. 特殊路径 ----------
async function testSpecialPaths() {
  const dir = initRepo();
  try {
    // 空格文件名：真实仓库端到端
    write(dir, 'sp ace.txt', 'p1\n');
    git(dir, ['add', 'sp ace.txt']);
    commitAll(dir, 'base');
    write(dir, 'sp ace.txt', 'p1\np2\n');
    const r = await getChanges(dir);
    const e = r.entries.find((x) => x.path === 'sp ace.txt');
    assert.ok(e, '空格路径条目应存在');
    assert.strictEqual(e.status, 'modified');
    assert.deepStrictEqual(e.unstaged, { adds: 1, dels: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 制表符/换行路径：Windows 版 git 直接拒绝（"Invalid path"），真实仓库无法构造；
  // 对解析器喂合成 NUL 流，断言 NUL 分隔解析不串行
  const statusBuf = Buffer.concat([
    Buffer.from('1 .M N... 100644 100644 100644 h1 h2 tab\tname.txt', 'utf8'), Buffer.from([0]),
    Buffer.from('? we\nird.txt', 'utf8'), Buffer.from([0]),
    Buffer.from('2 R. N... 100644 100644 100644 h1 h2 R100 nl\nname.txt', 'utf8'), Buffer.from([0]),
    Buffer.from('old\tpath.txt', 'utf8'), Buffer.from([0]),
    Buffer.from('! ign\nored.log', 'utf8'), Buffer.from([0]),
    Buffer.from('u uu N... 100644 100644 100644 100644 h1 h2 h3 unmerged.txt', 'utf8'), Buffer.from([0]),
  ]);
  const recs = _internals.parseStatusV2Z(statusBuf);
  assert.strictEqual(recs.length, 5, '应解析出 5 条记录（含 ignored/unmerged）');
  assert.strictEqual(recs[0].type, 'normal');
  assert.strictEqual(recs[0].xy, '.M');
  assert.strictEqual(recs[0].path, 'tab\tname.txt', '制表符路径不应被拆分');
  assert.strictEqual(recs[1].type, 'untracked');
  assert.strictEqual(recs[1].path, 'we\nird.txt', '换行路径不应串行');
  assert.strictEqual(recs[2].type, 'renamed');
  assert.strictEqual(recs[2].path, 'nl\nname.txt');
  assert.strictEqual(recs[2].origPath, 'old\tpath.txt', 'origPath 独立字段完整保留');
  assert.strictEqual(recs[3].type, 'ignored');
  assert.strictEqual(recs[4].type, 'unmerged');

  // numstat 合成流：普通含空格路径 + rename（src/dst 独立字段）
  const numstatBuf = Buffer.concat([
    Buffer.from('2\t1\ta b.txt', 'utf8'), Buffer.from([0]),
    Buffer.from('0\t0\t', 'utf8'), Buffer.from([0]),
    Buffer.from('s1.txt', 'utf8'), Buffer.from([0]),
    Buffer.from('d1 name.txt', 'utf8'), Buffer.from([0]),
    Buffer.from('-\t-\tbin.bin', 'utf8'), Buffer.from([0]),
  ]);
  const nm = _internals.parseNumstatZ(numstatBuf);
  assert.deepStrictEqual(nm.get('a b.txt'), { adds: 2, dels: 1 });
  assert.deepStrictEqual(nm.get('d1 name.txt'), { adds: 0, dels: 0 }, 'rename 按 dst 键关联');
  assert.strictEqual(nm.has('s1.txt'), false, 'src 不作为键');
  assert.deepStrictEqual(nm.get('bin.bin'), { adds: 0, dels: 0 }, '二进制 - 按 0');
  console.log('✅ 特殊路径：空格端到端 + 制表符/换行合成 NUL 流解析不串行（git 拒此类真实路径）');
}

// ---------- 5. 二进制文件 numstat ----------
async function testBinaryNumstat() {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0x00, 0x01, 0x02]));
    git(dir, ['add', 'b.bin']);
    commitAll(dir, 'base');
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const r = await getChanges(dir);
    const e = r.entries.find((x) => x.path === 'b.bin');
    assert.ok(e, '二进制条目应存在');
    assert.strictEqual(e.status, 'modified');
    assert.deepStrictEqual(e.unstaged, { adds: 0, dels: 0 }, '二进制 numstat - 按 0');
    console.log('✅ 二进制文件：numstat "-" 按 0 统计');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 6. 非 git 仓库 / diff 预览 / 伪造与注入 ----------
async function testErrorsAndPreview() {
  // 非 git 仓库
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'git-svc-plain-'));
  try {
    const r = await getChanges(plain);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-git-repo');
    assert.strictEqual(r.notGitRepo, true);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }

  const dir = initRepo();
  try {
    write(dir, 'f.txt', 'l1\nl2\nl3\n');
    write(dir, 'u.txt', 'u1\n');
    git(dir, ['add', '.']);
    commitAll(dir, 'base');
    write(dir, 'f.txt', 'l1\nl2\nl3\nl4\n'); // unstaged modified
    git(dir, ['add', 'f.txt']); // staged modified
    fs.unlinkSync(path.join(dir, 'u.txt')); // unstaged deleted
    write(dir, 'unt.txt', 'x\n'); // untracked

    const snap = await getChanges(dir);
    assert.strictEqual(snap.ok, true);
    const entryOf = (p) => snap.entries.find((e) => e.path === p);

    // 正常条目：staged modified → --cached diff 含新增行
    const d1 = await getDiffPreview(dir, snap.snapshotId, entryOf('f.txt').id);
    assert.strictEqual(d1.ok, true);
    assert.strictEqual(d1.truncated, false);
    assert.ok(d1.diff.includes('+l4'), 'diff 应包含新增行');

    // 正常条目：unstaged deleted → 工作树侧 diff 含删除行
    const d2 = await getDiffPreview(dir, snap.snapshotId, entryOf('u.txt').id);
    assert.strictEqual(d2.ok, true);
    assert.ok(d2.diff.includes('-u1'), 'deleted diff 应包含删除行');

    // untracked 无 diff 内容（git diff 不显示未跟踪文件）
    const d3 = await getDiffPreview(dir, snap.snapshotId, entryOf('unt.txt').id);
    assert.strictEqual(d3.ok, true);
    assert.strictEqual(d3.diff, '', 'untracked 条目 diff 应为空');

    // 合法字符串 entryId：main IPC 已支持数字/字符串，'0' 与数字 0 等价成功
    const dNum = await getDiffPreview(dir, snap.snapshotId, 0);
    const dStr = await getDiffPreview(dir, snap.snapshotId, '0');
    assert.strictEqual(dStr.ok, true, '字符串 entryId "0" 应解析成功');
    assert.strictEqual(dStr.diff, dNum.diff, '字符串与数字 entryId 应解析到同一条目');

    // 伪造 snapshotId → stale-snapshot
    const bad = await getDiffPreview(dir, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 0);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'stale-snapshot');

    // 合法 snapshotId + 越界/非法/负数 entryId → stale-snapshot
    assert.strictEqual((await getDiffPreview(dir, snap.snapshotId, 999)).reason, 'stale-snapshot');
    assert.strictEqual((await getDiffPreview(dir, snap.snapshotId, -1)).reason, 'stale-snapshot');
    assert.strictEqual((await getDiffPreview(dir, snap.snapshotId, 'x')).reason, 'stale-snapshot');

    // 伪造字符串 entryId（小数/十六进制/负号/空/空白/超长 16 位）→ stale-snapshot
    for (const bad of ['1.5', '0x1', '-1', '', ' 0', '9999999999999999']) {
      assert.strictEqual(
        (await getDiffPreview(dir, snap.snapshotId, bad)).reason,
        'stale-snapshot',
        `伪造字符串 ${JSON.stringify(bad)} 应拒绝`
      );
    }

    // ../../ 路径注入 → 一律拒绝（不解析为任何路径）
    assert.strictEqual((await getDiffPreview(dir, '../../etc/passwd', 0)).reason, 'stale-snapshot');
    assert.strictEqual((await getDiffPreview(dir, snap.snapshotId, '../../')).reason, 'stale-snapshot');
    console.log('✅ 非 git 仓库 notGitRepo / diff 正常返回 / 伪造 id 与 ../../ 注入一律拒绝');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 6b. 快照绑定 workDir：跨工作区调用 diff 被拒绝 ----------
async function testSnapshotBindsWorkDir() {
  const a = initRepo();
  const b = initRepo();
  try {
    write(a, 'f.txt', 'l1\n');
    git(a, ['add', '.']);
    commitAll(a, 'base');
    write(b, 'g.txt', 'g1\n');
    git(b, ['add', '.']);
    commitAll(b, 'base');
    write(a, 'f.txt', 'l1\nl2\n');

    const snap = await getChanges(a);
    assert.strictEqual(snap.ok, true);
    const id = snap.entries.find((e) => e.path === 'f.txt').id;

    const dA = await getDiffPreview(a, snap.snapshotId, id);
    assert.strictEqual(dA.ok, true, '同工作区 diff 应成功');

    const dB = await getDiffPreview(b, snap.snapshotId, id);
    assert.strictEqual(dB.ok, false, '跨工作区 diff 应被拒绝');
    assert.strictEqual(dB.reason, 'stale-snapshot');
    console.log('✅ 快照绑定 workDir：工作区 A 的快照在 B 调 diff 返回 stale-snapshot');
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
}

// ---------- 6c. diff 侧选择不依赖 staged 行数和（二进制/纯 rename/空文件 0/0） ----------
async function testStagedSideSelection() {
  const dir = initRepo();
  try {
    // base 提交（b.bin 二进制、r.txt 后续 rename、both.txt 后续双侧变更）
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0x00, 0x01]));
    write(dir, 'r.txt', 'r1\nr2\n');
    write(dir, 'both.txt', 'b1\n');
    git(dir, ['add', '.']);
    commitAll(dir, 'base');

    // 变更阶段（之后不再 commit）
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0x00, 0x01, 0x02]));
    git(dir, ['add', 'b.bin']); // staged 二进制：numstat "-" 按 0
    write(dir, 'empty.txt', '');
    git(dir, ['add', 'empty.txt']); // staged 空文件：numstat 0/0
    git(dir, ['mv', 'r.txt', 'rn.txt']); // staged 纯 rename：numstat 0/0
    write(dir, 'both.txt', 'b1\nb2\n');
    git(dir, ['add', 'both.txt']); // staged
    write(dir, 'both.txt', 'b1\nb2\nb3\n'); // unstaged：同文件双侧变更
    write(dir, 'unt.txt', 'u\n'); // untracked：worktree 侧

    const snap = await getChanges(dir);
    assert.strictEqual(snap.ok, true);
    const entryOf = (p) => snap.entries.find((e) => e.path === p);
    assert.ok(entryOf('b.bin') && entryOf('empty.txt') && entryOf('rn.txt'), 'staged 条目应齐全');

    // staged 二进制：非空且含 Binary（unstaged 侧为空），source=staged
    const db = await getDiffPreview(dir, snap.snapshotId, entryOf('b.bin').id);
    assert.strictEqual(db.ok, true);
    assert.ok(db.diff.length > 0, 'staged 二进制 diff 不应为空');
    assert.ok(/binary files/i.test(db.diff), '二进制 diff 应含 Binary 说明');
    assert.strictEqual(db.source, 'staged');

    // staged 空文件：new file mode，source=staged
    const de = await getDiffPreview(dir, snap.snapshotId, entryOf('empty.txt').id);
    assert.strictEqual(de.ok, true);
    assert.ok(/new file mode/i.test(de.diff), 'staged 空文件 diff 应为 new file mode');
    assert.strictEqual(de.source, 'staged');

    // 纯 rename：路径限定 diff 下 Git 不做 rename detection，--cached 侧显示为 new file；
    // 关键验证：若侧选择错误（unstaged 侧为空 diff）则 diff 为空 → 非空 + source=staged 证明选对
    const dr = await getDiffPreview(dir, snap.snapshotId, entryOf('rn.txt').id);
    assert.strictEqual(dr.ok, true);
    assert.ok(dr.diff.length > 0, '纯 rename diff 不应为空（unstaged 侧为空，选对 --cached 才有内容）');
    assert.ok(/new file mode/i.test(dr.diff), '纯 rename 在 --cached 侧显示为 new file');
    assert.strictEqual(dr.source, 'staged');

    // 同文件 staged+unstaged：优先 staged（含 +b2、不含 b3）
    const dt = await getDiffPreview(dir, snap.snapshotId, entryOf('both.txt').id);
    assert.strictEqual(dt.ok, true);
    assert.ok(dt.diff.includes('+b2'), 'staged 优先应含 +b2');
    assert.ok(!dt.diff.includes('b3'), '不应包含 unstaged 侧 b3');
    assert.strictEqual(dt.source, 'staged');

    // untracked：worktree 侧，diff 为空
    const du = await getDiffPreview(dir, snap.snapshotId, entryOf('unt.txt').id);
    assert.strictEqual(du.ok, true);
    assert.strictEqual(du.source, 'worktree');
    assert.strictEqual(du.diff, '');
    console.log('✅ diff 侧选择：staged 二进制/空文件/纯 rename 显式选 --cached；双侧变更优先 staged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 7. 快照 LRU（≤20，超限淘汰最旧） ----------
async function testSnapshotLRU() {
  const dir = initRepo();
  try {
    write(dir, 'f.txt', 'x\n');
    git(dir, ['add', 'f.txt']);
    commitAll(dir, 'base');
    // 清场：挤掉此前用例残留快照（模块级快照表跨测试共享），保证边界断言自包含
    for (let i = 0; i < 20; i++) {
      const r = await getChanges(dir);
      assert.strictEqual(r.ok, true);
    }
    const ids = [];
    for (let i = 0; i < 25; i++) {
      // 每次制造真实变更，保证快照 entries 非空（entryId 0 可解析）
      fs.writeFileSync(path.join(dir, 'f.txt'), `x${i}\n`);
      const r = await getChanges(dir);
      assert.strictEqual(r.ok, true);
      assert.ok(r.entries.length > 0, '快照 entries 应非空');
      ids.push(r.snapshotId);
    }
    for (let i = 0; i < 5; i++) {
      const d = await getDiffPreview(dir, ids[i], 0);
      assert.strictEqual(d.ok, false, `第 ${i + 1} 个快照应已被淘汰`);
      assert.strictEqual(d.reason, 'stale-snapshot');
    }
    for (let i = 5; i < 25; i++) {
      const d = await getDiffPreview(dir, ids[i], 0);
      assert.strictEqual(d.ok, true, `第 ${i + 1} 个快照应仍在`);
    }
    console.log('✅ 快照 LRU：内存仅保留 ≤20 快照，超限淘汰最旧');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 8. 参数白名单 + 固定只读保护（内部参数构建 + 静态审查） ----------
function testWhitelist() {
  assert.strictEqual(LIMITS.GIT_TIMEOUT_MS, 10000);
  assert.strictEqual(LIMITS.DIFF_MAX_BYTES, 500 * 1024);
  assert.strictEqual(LIMITS.DIFF_MAX_LINES, 2000);
  assert.strictEqual(LIMITS.GIT_OUTPUT_MAX_BYTES, 4 * 1024 * 1024);

  assert.deepStrictEqual(_internals.buildGitArgs('status'), [
    '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '-z',
  ]);
  assert.deepStrictEqual(_internals.buildGitArgs('numstat'), [
    '-c', 'core.fsmonitor=false', 'diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv',
  ]);
  assert.deepStrictEqual(_internals.buildGitArgs('numstat', { cached: true }), [
    '-c', 'core.fsmonitor=false', 'diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-textconv',
  ]);
  assert.deepStrictEqual(_internals.buildGitArgs('diff-preview', { path: 'a.txt' }), [
    '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--', 'a.txt',
  ]);
  assert.deepStrictEqual(_internals.buildGitArgs('diff-preview', { cached: true, path: 'a b.txt' }), [
    '-c', 'core.fsmonitor=false', 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--', 'a b.txt',
  ]);
  assert.throws(() => _internals.buildGitArgs('branch'), /unsupported/);

  // 静态审查：固定只读保护必须存在
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'git-service.js'), 'utf8');
  for (const needle of [
    'core.fsmonitor=false',
    '--no-ext-diff',
    '--no-textconv',
    'GIT_OPTIONAL_LOCKS',
    'GIT_LITERAL_PATHSPECS',
    'GIT_EXTERNAL_DIFF',
    'GIT_DIFF_PATH_COUNTER',
    'GIT_DIFF_PATH_TOTAL',
    'shell: false',
  ]) {
    assert.ok(src.includes(needle), `源码应含固定保护 ${needle}`);
  }
  // 静态审查：模块源码不得出现任何危险写操作子命令
  for (const bad of ['checkout', 'reset', 'clean', 'apply', 'commit']) {
    assert.ok(!src.includes(`'${bad}'`), `源码不应含危险子命令 '${bad}'`);
  }
  console.log('✅ 参数白名单 + 固定只读保护：buildGitArgs 固定 flags/环境变量齐备，无危险子命令');
}

// ---------- 8b. containment：..foo / ...txt 不误拒，严格逃逸仍拒绝 ----------
async function testContainmentDots() {
  const dir = initRepo();
  try {
    write(dir, 'f.txt', 'x\n');
    git(dir, ['add', '.']);
    commitAll(dir, 'base');
    // 根内合法文件名（非严格 '..' 逃逸）：Windows Git 允许 '..foo' / '...txt'
    write(dir, '..foo', 'a\n');
    write(dir, '...txt', 'b\n');
    const r = await getChanges(dir);
    assert.strictEqual(r.ok, true);
    const paths = r.entries.map((e) => e.path);
    assert.ok(paths.includes('..foo'), '合法文件 ..foo 应列入 Changes');
    assert.ok(paths.includes('...txt'), '合法文件 ...txt 应列入 Changes');
    const e = r.entries.find((x) => x.path === '..foo');
    const d = await getDiffPreview(dir, r.snapshotId, e.id);
    assert.strictEqual(d.ok, true, '..foo 的 diff 应被允许（untracked 为空即可）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 白盒：严格逃逸（'..' 本身 / '..'+分隔符 / 绝对路径）仍拒绝
  assert.strictEqual(_internals.checkContainment(dir, path.join(dir, '..')), false);
  assert.strictEqual(_internals.checkContainment(dir, path.join(dir, '..', '..')), false);
  assert.strictEqual(_internals.checkContainment(dir, 'C:\\windows\\evil.txt'), false);
  assert.strictEqual(_internals.checkContainment(dir, path.join(dir, '..foo')), true);
  assert.strictEqual(_internals.checkContainment(dir, path.join(dir, '...txt')), true);
  console.log('✅ containment：根内 ..foo/...txt 列入 Changes 且可 diff；严格逃逸仍拒绝');
}

// ---------- 9. git 缺失（PATH 置空模拟，不崩溃） ----------
function testGitMissing() {
  const dir = initRepo();
  try {
    const modulePath = path.join(__dirname, '..', 'src', 'main', 'git-service.js');
    const script = `
      process.env.PATH = '';
      const gs = require(${JSON.stringify(modulePath)});
      gs.getChanges(${JSON.stringify(dir)}).then((r) => {
        console.log(JSON.stringify({ ok: r.ok, reason: r.reason }));
        process.exit(0);
      }).catch((e) => {
        console.error(e);
        process.exit(2);
      });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 0, `子进程退出码 ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.reason, 'git-missing');
    console.log('✅ git 缺失（PATH 清空）：返回 git-missing 不崩溃');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 10. 输出上限（可注入 child process）+ 有界重试上限 ----------
async function testOutputLimitAndRetry() {
  const dir = initRepo();
  try {
    write(dir, 'f.txt', 'x\n');
    git(dir, ['add', '.']);
    commitAll(dir, 'base');

    // 模拟 stdout 超限（2 × 3MB > GIT_OUTPUT_MAX_BYTES=4MB）：立即失败且不返回不完整快照
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const fake = makeFakeSpawn([big, big]);
    _internals._setSpawn(fake);
    try {
      const r = await getChanges(dir);
      assert.strictEqual(r.ok, false, '输出超限应失败');
      assert.strictEqual(r.reason, 'output-too-large');
      assert.strictEqual(fake.calls(), 1, 'output-too-large 不得重试（status 一次即止）');
    } finally {
      _internals._setSpawn(null);
    }

    // 重试上限：可注入 exec 验证
    let calls = 0;
    let r = await _internals.runGitWithRetry(dir, ['status'], async () => {
      calls++;
      return { ok: false, reason: 'git-timeout' };
    });
    assert.strictEqual(r.reason, 'git-timeout');
    assert.strictEqual(calls, 2, 'git-timeout 只重试一次');

    calls = 0;
    r = await _internals.runGitWithRetry(dir, ['status'], async () => {
      calls++;
      return { ok: false, reason: 'git-error', code: 1 };
    });
    assert.strictEqual(r.reason, 'git-error');
    assert.strictEqual(calls, 2, 'git-error 只重试一次');

    for (const reason of ['git-missing', 'not-git-repo', 'output-too-large']) {
      calls = 0;
      r = await _internals.runGitWithRetry(dir, ['status'], async () => {
        calls++;
        return { ok: false, reason };
      });
      assert.strictEqual(r.reason, reason);
      assert.strictEqual(calls, 1, `${reason} 不得重试`);
    }

    calls = 0;
    r = await _internals.runGitWithRetry(dir, ['status'], async () => {
      calls++;
      return { ok: true, stdout: Buffer.alloc(0) };
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls, 1, '成功不重试');

    // diff 预览（流式）重试：git-error / git-timeout 只重试一次
    calls = 0;
    r = await _internals.runGitStreamWithRetry(dir, ['status'], async () => {
      calls++;
      return { ok: false, reason: 'git-error', code: 1 };
    });
    assert.strictEqual(r.reason, 'git-error');
    assert.strictEqual(calls, 2, 'diff git-error 只重试一次');

    calls = 0;
    r = await _internals.runGitStreamWithRetry(dir, ['status'], async () => {
      calls++;
      return { ok: false, reason: 'git-timeout' };
    });
    assert.strictEqual(r.reason, 'git-timeout');
    assert.strictEqual(calls, 2, 'diff git-timeout 只重试一次');

    for (const reason of ['git-missing', 'not-git-repo', 'output-too-large']) {
      calls = 0;
      r = await _internals.runGitStreamWithRetry(dir, ['status'], async () => {
        calls++;
        return { ok: false, reason };
      });
      assert.strictEqual(r.reason, reason);
      assert.strictEqual(calls, 1, `diff ${reason} 不得重试`);
    }

    // 成功但 truncated（边读边限额截断）不得重试
    calls = 0;
    r = await _internals.runGitStreamWithRetry(dir, ['status'], async () => {
      calls++;
      return { ok: true, stdout: Buffer.alloc(0), truncated: true };
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(calls, 1, 'diff 成功但 truncated 不得重试');

    // 端到端：getDiffPreview 经 spawn 注入，git-error 重试一次后成功（验证接线）
    write(dir, 'f.txt', 'y\n'); // 制造真实变更，保证快照 entries 非空
    const snap = await getChanges(dir);
    assert.strictEqual(snap.ok, true);
    let diffSpawns = 0;
    const flakyDiff = () => {
      diffSpawns++;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => {};
      if (diffSpawns === 1) {
        // 非 128 退出码 → git-error
        setImmediate(() => child.emit('close', 1));
      } else {
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from('+x\n', 'utf8'));
          child.emit('close', 0);
        });
      }
      return child;
    };
    _internals._setSpawn(flakyDiff);
    try {
      const d = await getDiffPreview(dir, snap.snapshotId, 0);
      assert.strictEqual(d.ok, true, 'diff git-error 重试后应成功');
      assert.strictEqual(diffSpawns, 2, 'diff git-error 应恰好重试一次');
      assert.strictEqual(d.diff, '+x\n');
    } finally {
      _internals._setSpawn(null);
    }

    console.log('✅ 输出上限 + 有界重试：超限 kill→output-too-large 不重试；status/diff 的 git-error/timeout 只重试一次，diff truncated 不重试');
  } finally {
    _internals._setSpawn(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- M6. literal pathspec：'--' 之后的路径不被解释为 pathspec magic ----------
async function testLiteralPathspecs() {
  const dir = initRepo();
  try {
    write(dir, 'f.txt', 'x\n');
    git(dir, ['add', '.']);
    commitAll(dir, 'base');
    write(dir, 'f.txt', 'x\ny\n');

    // 参数层：':' 开头 / :(glob) / :(attr) 样式路径在 '--' 后原样透传，参数顺序语义不变
    for (const p of [':foo.txt', ':(glob)**/a.txt', ':(attr)export-ignore', ':(top)bar.txt']) {
      const args = _internals.buildGitArgs('diff-preview', { path: p });
      assert.strictEqual(args[args.length - 1], p, `path ${JSON.stringify(p)} 应原样置于 '--' 之后`);
      assert.strictEqual(args[args.length - 2], '--', `'--' 应在 path 之前`);
    }
    assert.deepStrictEqual(_internals.buildGitArgs('diff-preview', { path: ':(glob)**/a.txt' }), [
      '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--', ':(glob)**/a.txt',
    ]);
    // cached 顺序语义不变
    assert.deepStrictEqual(_internals.buildGitArgs('diff-preview', { cached: true, path: ':(attr)export-ignore' }), [
      '-c', 'core.fsmonitor=false', 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--', ':(attr)export-ignore',
    ]);

    // 端到端（注入）：合成 '(glob)' 样式条目进快照 → diff 调用 path 原样 + 全部调用 env 固定 literal
    const statusBuf = Buffer.concat([
      Buffer.from('1 .M N... 100644 100644 100644 h1 h2 :(glob)foo.txt', 'utf8'), Buffer.from([0]),
    ]);
    const numstatBuf = Buffer.concat([
      Buffer.from('1\t1\t:(glob)foo.txt', 'utf8'), Buffer.from([0]),
    ]);
    const capture = makeCaptureSpawn([statusBuf, numstatBuf, Buffer.alloc(0), Buffer.from('+a\n', 'utf8')]);
    _internals._setSpawn(capture);
    try {
      const r = await getChanges(dir);
      assert.strictEqual(r.ok, true);
      const e = r.entries.find((x) => x.path === ':(glob)foo.txt');
      assert.ok(e, '合成 (glob) 样式条目应进入快照');
      const d = await getDiffPreview(dir, r.snapshotId, e.id);
      assert.strictEqual(d.ok, true);
      assert.strictEqual(d.diff, '+a\n');
      const calls = capture.calls();
      assert.strictEqual(calls.length, 4, 'status/numstat/numstat-cached/diff 各一次');
      // 所有 git 调用（含无路径的 status/numstat）统一固定 literal pathspec（magic 已关闭）
      for (const c of calls) {
        assert.strictEqual(c.bin, 'git');
        assert.strictEqual(c.env.GIT_LITERAL_PATHSPECS, '1', '每次 git 调用 env 均固定 GIT_LITERAL_PATHSPECS=1');
      }
      // diff 调用参数：-C 后依次 -c core.fsmonitor=false / diff / --no-ext-diff / --no-textconv / -- / path 原样
      assert.deepStrictEqual(calls[3].args, [
        '-C', dir, '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--', ':(glob)foo.txt',
      ]);
    } finally {
      _internals._setSpawn(null);
    }
    console.log('✅ literal pathspec：status/numstat/diff 全部固定 GIT_LITERAL_PATHSPECS=1，:/(glob)/(attr) 样式路径原样透传');
  } finally {
    _internals._setSpawn(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 执行 ----------
async function run() {
  await testMixedChanges();
  await testStagedUnstagedIndependent();
  await testRename();
  await testSpecialPaths();
  await testBinaryNumstat();
  await testErrorsAndPreview();
  await testSnapshotBindsWorkDir();
  await testStagedSideSelection();
  await testSnapshotLRU();
  testWhitelist();
  await testLiteralPathspecs();
  await testContainmentDots();
  testGitMissing();
  await testOutputLimitAndRetry();
  console.log('\n全部 git-service 测试通过');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
