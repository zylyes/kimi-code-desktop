// file-browser 模块单元测试
// 用法：node tests/test-file-browser.js
// 临时目录树（os.tmpdir + mkdtemp），测试结束清理。Windows 无开发者模式时
// symlink 创建失败 → 自动降级为 junction（无需权限）继续测试逃逸防护。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listDir, readFilePreview, LIMITS, _internals } = require('../src/main/file-browser');

const BIG_BYTES = 1024 * 1024; // 1MB
const ABS_PATH = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

// ---------- 夹具：临时目录树 ----------
function createFixture() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-fb-'));
  const root = path.join(tmpBase, 'root');
  const outside = path.join(tmpBase, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'subdir'));
  fs.mkdirSync(path.join(root, 'subdir2'));
  fs.mkdirSync(path.join(root, '.git')); // 默认排除
  fs.mkdirSync(path.join(root, 'subdir', '.git')); // 嵌套默认排除
  fs.mkdirSync(path.join(root, 'node_modules')); // 默认排除
  fs.mkdirSync(path.join(root, 'empty'));
  fs.mkdirSync(path.join(root, 'limitdir'));
  fs.mkdirSync(path.join(root, '..foo')); // 合法根内名称（非 '..' 逃逸）
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'afile.txt'), 'hello world');
  fs.writeFileSync(path.join(root, 'Bfile.txt'), 'B content');
  fs.writeFileSync(path.join(root, '..bar.txt'), 'dots'); // 合法根内名称
  fs.writeFileSync(path.join(root, '..foo', 'dotfile.txt'), 'dot-in');
  fs.writeFileSync(path.join(root, 'subdir', 'inner.txt'), 'inner');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'git-config');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg.js'), 'pkg');
  // >1MB 文件
  fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(BIG_BYTES + 100, 0x61));
  // 含 NUL 的二进制文件
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63]));
  // 带 BOM 的文件（EF BB BF + 'hi'）
  fs.writeFileSync(path.join(root, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]));
  // 505 个文件触发 LIST_MAX_ENTRIES 截断
  for (let i = 0; i < LIMITS.LIST_MAX_ENTRIES + 5; i++) {
    fs.writeFileSync(path.join(root, 'limitdir', `f${String(i).padStart(4, '0')}.txt`), `content-${i}`);
  }
  return { tmpBase, root, outside };
}

// Windows 无开发者模式/管理员权限时 symlink 创建会失败 → 降级 junction。
// 返回创建方式（'symlink' | 'junction'），全失败返回 null。
function tryCreateLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return 'symlink';
  } catch (err) {
    try {
      fs.symlinkSync(target, linkPath, 'junction');
      return 'junction';
    } catch {
      return null;
    }
  }
}

// ---------- 1. 正常枚举 ----------
async function testListDirBasic(fx) {
  const res = await listDir(fx.root);
  assert.strictEqual(res.ok, true, '正常枚举应 ok');
  const types = res.entries.map((e) => e.type);
  const firstFileIdx = types.indexOf('file');
  const lastDirIdx = types.lastIndexOf('dir');
  assert.ok(firstFileIdx === -1 || lastDirIdx < firstFileIdx, '目录应全部排在文件之前');
  // 组内按 name localeCompare（大小写不敏感）：..bar.txt < afile.txt < Bfile.txt
  const names = res.entries.filter((e) => e.type === 'file').map((e) => e.name);
  assert.deepStrictEqual(
    names,
    ['..bar.txt', 'afile.txt', 'Bfile.txt', 'big.txt', 'binary.bin', 'bom.txt', 'outside.txt'],
    '文件组应按名称排序');
  // 默认跳过 .git / node_modules
  assert.ok(!res.entries.some((e) => e.name === '.git'), '.git 应默认跳过');
  assert.ok(!res.entries.some((e) => e.name === 'node_modules'), 'node_modules 应默认跳过');
  // 字段齐全：path 相对、size、mtime 数字
  for (const e of res.entries) {
    assert.strictEqual(typeof e.path, 'string');
    assert.ok(!path.isAbsolute(e.path), 'path 应为相对路径');
    assert.strictEqual(typeof e.size, 'number');
    assert.strictEqual(typeof e.mtime, 'number');
    assert.ok(e.mtime > 0, 'mtime 应为正数时间戳(ms)');
  }
  const sub = res.entries.find((e) => e.name === 'subdir');
  assert.deepStrictEqual(
    { name: sub.name, type: sub.type, size: sub.size, path: sub.path },
    { name: 'subdir', type: 'dir', size: 0, path: 'subdir' },
    '目录条目 size 应为 0、path 为相对路径');
  const af = res.entries.find((e) => e.name === 'afile.txt');
  assert.strictEqual(af.size, 11, '文件 size 应为字节数');
  assert.strictEqual(af.type, 'file');
  console.log('✅ listDir 基础：目录在前 / 组内排序 / 字段齐全 / 默认跳过 .git·node_modules');
}

// ---------- 2. 嵌套目录枚举 ----------
async function testListDirNested(fx) {
  const res = await listDir(fx.root, 'subdir');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(
    res.entries.map((e) => ({ path: e.path, name: e.name, type: e.type })),
    [{ path: 'subdir/inner.txt', name: 'inner.txt', type: 'file' }],
    '子目录枚举应产出 POSIX 相对路径（嵌套 .git 默认跳过）');
  assert.strictEqual(res.truncated, false);
  console.log('✅ listDir 嵌套：relPath 枚举 / path 为 POSIX 相对');
}

// ---------- 3. 空目录 / 不存在 / root 非法 ----------
async function testEmptyAndMissing(fx) {
  const empty = await listDir(fx.root, 'empty');
  assert.deepStrictEqual(empty, { ok: true, entries: [], truncated: false }, '空目录 → ok:true 空数组');
  const missing = await listDir(fx.root, 'nope');
  assert.strictEqual(missing.ok, false, '不存在目录应 ok:false');
  const missingF = await readFilePreview(fx.root, 'nope');
  assert.strictEqual(missingF.ok, false, '不存在文件应 ok:false');
  const noRoot = await listDir(path.join(fx.tmpBase, 'no-such-root'));
  assert.strictEqual(noRoot.ok, false, 'root 不存在应 ok:false');
  const fileAsRoot = await listDir(path.join(fx.root, 'afile.txt'));
  assert.strictEqual(fileAsRoot.ok, false, 'root 为文件应 ok:false');
  const fileAsRootR = await readFilePreview(path.join(fx.root, 'afile.txt'), 'x');
  assert.strictEqual(fileAsRootR.ok, false, 'root 为文件（预览）应 ok:false');
  console.log('✅ 空目录 / 不存在路径 / root 非法：全部 ok:false 或空数组');
}

// ---------- 4. containment 越界 ----------
async function testContainment(fx) {
  for (const bad of ['../', '../../..', '../outside', ABS_PATH]) {
    const l = await listDir(fx.root, bad);
    assert.strictEqual(l.ok, false, `listDir 越界路径应拒绝: ${bad}`);
    assert.strictEqual(l.reason, 'escape-denied', `listDir 越界 reason 应为 escape-denied: ${bad}`);
    const r = await readFilePreview(fx.root, bad);
    assert.strictEqual(r.ok, false, `readFilePreview 越界路径应拒绝: ${bad}`);
    assert.strictEqual(r.reason, 'escape-denied', `readFilePreview 越界 reason 应为 escape-denied: ${bad}`);
  }
  // 相对自身（relPath='' 或 '.'）应允许
  const self = await listDir(fx.root, '.');
  assert.strictEqual(self.ok, true, "relPath='.' 应视为 root 自身");
  console.log('✅ containment：../ 多级 ../ 绝对路径全部 escape-denied');
}

// ---------- 5. 排除规则：.git / node_modules 不可直接访问 ----------
async function testExcludedPaths(fx) {
  const cases = [
    ['listDir', '.git'],
    ['listDir', 'node_modules'],
    ['listDir', 'subdir/.git'],
    ['listDir', '.GIT'], // 大小写变体（Windows 大小写不敏感 FS）
    ['readFilePreview', '.git/config'],
    ['readFilePreview', 'node_modules/pkg.js'],
    ['readFilePreview', 'subdir/.git/config'],
  ];
  for (const [fn, rel] of cases) {
    const res = fn === 'listDir' ? await listDir(fx.root, rel) : await readFilePreview(fx.root, rel);
    assert.strictEqual(res.ok, false, `${fn}('${rel}') 应拒绝`);
    assert.strictEqual(res.reason, 'excluded-path', `${fn}('${rel}') reason 应为 excluded-path`);
  }
  console.log('✅ 排除规则：.git/node_modules 直接路径与嵌套路径全部 excluded-path（含大小写变体）');
}

// ---------- 6. 合法根内名称：..foo / ..bar.txt ----------
async function testDotDotFoo(fx) {
  const dir = await listDir(fx.root, '..foo');
  assert.strictEqual(dir.ok, true, '..foo 目录应可访问');
  assert.deepStrictEqual(
    dir.entries.map((e) => e.name),
    ['dotfile.txt'],
    '..foo 内容应可枚举');
  const file = await readFilePreview(fx.root, '..bar.txt');
  assert.deepStrictEqual(
    { ok: file.ok, content: file.content },
    { ok: true, content: 'dots' },
    '..bar.txt 应可读取');
  const listing = await listDir(fx.root);
  assert.ok(listing.entries.some((e) => e.name === '..foo'), '枚举应包含 ..foo 目录');
  assert.ok(listing.entries.some((e) => e.name === '..bar.txt'), '枚举应包含 ..bar.txt 文件');
  console.log('✅ ..foo / ..bar.txt 合法根内名称：可直接访问且出现在枚举');
}

// ---------- 7. symlink / junction 严格拒绝 ----------
async function testSymlinkStrict(fx) {
  // 三种链接：指向 root 外 / 指向 root 内 / 指向 root/.git 的别名
  const links = [
    { name: 'link-outside', target: fx.outside },
    { name: 'link-inside', target: path.join(fx.root, 'subdir') },
    { name: 'git-link', target: path.join(fx.root, '.git') },
  ];
  const kinds = [];
  for (const l of links) {
    const kind = tryCreateLink(l.target, path.join(fx.root, l.name));
    kinds.push(kind);
    if (!kind) {
      console.log(`⚠️ 无法创建链接 ${l.name}（无权限），跳过该用例`);
      continue;
    }
    const lr = await listDir(fx.root, l.name);
    assert.strictEqual(lr.ok, false, `listDir 链接 ${l.name} 应拒绝`);
    assert.strictEqual(lr.reason, 'symlink-denied', `listDir 链接 ${l.name} reason 应为 symlink-denied`);
    const rf = await readFilePreview(fx.root, l.name);
    assert.strictEqual(rf.ok, false, `readFilePreview 链接 ${l.name} 应拒绝`);
    assert.strictEqual(rf.reason, 'symlink-denied', `readFilePreview 链接 ${l.name} reason 应为 symlink-denied`);
  }
  // 枚举 root：所有 symlink/junction 条目一律跳过（无论指向 root 内/外）
  const listing = await listDir(fx.root);
  for (const l of links) {
    assert.ok(!listing.entries.some((e) => e.name === l.name), `${l.name} 不应出现在条目列表`);
  }
  // 嵌套路径中的中间级链接：subdir/inner-link → root 外，拒绝
  const nestedLink = path.join(fx.root, 'subdir', 'inner-link');
  const kindNested = tryCreateLink(fx.outside, nestedLink);
  if (kindNested) {
    const n = await listDir(fx.root, 'subdir/inner-link');
    assert.strictEqual(n.ok, false, '中间级链接应拒绝');
    assert.strictEqual(n.reason, 'symlink-denied', '中间级链接 reason 应为 symlink-denied');
  } else {
    console.log('⚠️ 无法创建嵌套链接（无权限），跳过嵌套用例');
  }
  console.log(
    `✅ symlink/junction 严格拒绝（${links.map((l, i) => `${l.name}:${kinds[i] || '-'}`).join(' / ')}）：全部 symlink-denied、枚举跳过`);
}

// ---------- 8. skipNames 仅追加，默认排除不可绕过 ----------
async function testSkipNames(fx) {
  // skipNames:[] → 默认排除仍生效（.git / node_modules 不可绕过）
  const none = await listDir(fx.root, '', { skipNames: [] });
  assert.ok(!none.entries.some((e) => e.name === '.git'), 'skipNames:[] 仍应跳过 .git');
  assert.ok(!none.entries.some((e) => e.name === 'node_modules'), 'skipNames:[] 仍应跳过 node_modules');
  // 默认排除不可绕过 → .git 仍不可直接 list
  const direct = await listDir(fx.root, '.git', { skipNames: [] });
  assert.strictEqual(direct.ok, false, 'skipNames:[] 时 .git 仍应拒绝');
  assert.strictEqual(direct.reason, 'excluded-path', 'skipNames:[] 时 .git reason 应为 excluded-path');
  // 有效额外名被追加跳过；默认排除不受影响
  const custom = await listDir(fx.root, '', { skipNames: ['afile.txt'] });
  assert.ok(!custom.entries.some((e) => e.name === 'afile.txt'), 'skipNames 应过滤指定条目');
  assert.ok(custom.entries.some((e) => e.name === 'Bfile.txt'), '非额外名条目不应被过滤');
  assert.ok(!custom.entries.some((e) => e.name === '.git'), '默认排除仍生效（.git 继续跳过）');
  assert.ok(!custom.entries.some((e) => e.name === 'node_modules'), '默认排除仍生效（node_modules 继续跳过）');
  // 额外名大小写变体同样生效（与默认排除一致的比较口径）
  const upper = await listDir(fx.root, '', { skipNames: ['AFILE.TXT'] });
  assert.ok(!upper.entries.some((e) => e.name === 'afile.txt'), 'skipNames 应大小写不敏感（AFILE.TXT 过滤 afile.txt）');
  console.log('✅ skipNames：仅追加额外排除 / 默认 .git·node_modules 不可绕过 / 大小写不敏感');
}

// ---------- 8b. skipNames / opts 非法输入：bad-arg 且不抛 ----------
async function testSkipNamesBadArgs(fx) {
  // skipNames 非法：null / number / string / 含 null 元素 / 路径分隔符 / 空串
  const badSkipNames = [null, 5, 'afile.txt', ['afile.txt', null], ['a/b'], ['a\\b'], ['a\0b'], ['']];
  for (const skipNames of badSkipNames) {
    let res;
    try {
      res = await listDir(fx.root, '', { skipNames });
    } catch (err) {
      assert.fail(`skipNames=${JSON.stringify(skipNames)} 不应抛异常：${err.message}`);
    }
    assert.strictEqual(res.ok, false, `skipNames=${JSON.stringify(skipNames)} 应 bad-arg`);
    assert.strictEqual(res.reason, 'bad-arg', `skipNames=${JSON.stringify(skipNames)} reason 应为 bad-arg`);
  }
  // opts 非法：null / 数组 / 数字 / 字符串 → bad-arg
  const badOpts = [null, [1, 2], 5, 'x'];
  for (const opts of badOpts) {
    const res = await listDir(fx.root, '', opts);
    assert.strictEqual(res.ok, false, `opts=${JSON.stringify(opts)} 应 bad-arg`);
    assert.strictEqual(res.reason, 'bad-arg', `opts=${JSON.stringify(opts)} reason 应为 bad-arg`);
  }
  // skipNames 缺失（undefined / 省略）→ 默认行为正常
  const def = await listDir(fx.root, '', { skipNames: undefined });
  assert.strictEqual(def.ok, true, 'skipNames 缺失应走默认');
  console.log('✅ skipNames/opts 非法输入：null/数字/字符串/含 null/路径分隔符/空串 全部 bad-arg 且不抛');
}

// ---------- 9. 上限截断 ----------
async function testListLimit(fx) {
  const res = await listDir(fx.root, 'limitdir');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.truncated, true, '超过 LIST_MAX_ENTRIES 应 truncated');
  assert.strictEqual(res.entries.length, LIMITS.LIST_MAX_ENTRIES, '应截断至 LIST_MAX_ENTRIES 条');
  const names = res.entries.map((e) => e.name);
  assert.deepStrictEqual([...names].sort(), names, '截断后仍应有序');
  console.log(`✅ 上限：505 条目截断为 ${LIMITS.LIST_MAX_ENTRIES} / truncated=true`);
}

// ---------- 10. 流式读取实现路径（mock/静态断言） ----------
async function testListLimitStreaming(fx) {
  // 静态断言实现路径：fs.promises.readdir 不可用而枚举仍成功（证明用 opendir 流式）；
  // lstat 调用次数远小于全量条目数（证明收集满 LIMITS+1 即停止，未全量 lstat 后截断）。
  const origReaddir = fs.promises.readdir;
  const origLstat = fs.promises.lstat;
  let readdirCalls = 0;
  let lstatCalls = 0;
  fs.promises.readdir = async () => {
    readdirCalls++;
    throw new Error('readdir 不应被调用（应使用 opendir 流式读取）');
  };
  fs.promises.lstat = async (p, o) => {
    lstatCalls++;
    return origLstat(p, o);
  };
  try {
    const res = await listDir(fx.root, 'limitdir');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.truncated, true, '超过上限应 truncated');
    assert.strictEqual(res.entries.length, LIMITS.LIST_MAX_ENTRIES, '应截断至上限');
    assert.strictEqual(readdirCalls, 0, '不得调用 fs.promises.readdir');
    // 全量实现需 lstat 全部 505 个条目 + limitdir 自身 1 次；流式实现只 lstat
    // LIMITS+1 个候选 + limitdir 自身 1 次即停止。
    assert.ok(
      lstatCalls <= LIMITS.LIST_MAX_ENTRIES + 3,
      `lstat 应提前停止（实际 ${lstatCalls} 次）`);
  } finally {
    fs.promises.readdir = origReaddir;
    fs.promises.lstat = origLstat;
  }
  console.log(
    `✅ 流式上限：${LIMITS.LIST_MAX_ENTRIES} 截断 / 未调用 readdir / lstat 提前停止（${lstatCalls} 次 < 全量 ${LIMITS.LIST_MAX_ENTRIES + 5}）`);
}

// ---------- 11. 文件预览 ----------
async function testReadFilePreview(fx) {
  // 普通文件
  const plain = await readFilePreview(fx.root, 'afile.txt');
  assert.deepStrictEqual(
    { ok: plain.ok, content: plain.content, truncated: plain.truncated, size: plain.size },
    { ok: true, content: 'hello world', truncated: false, size: 11 },
    '普通文件应完整返回');
  // 目录 → is-directory
  const dir = await readFilePreview(fx.root, 'subdir');
  assert.deepStrictEqual(dir, { ok: false, reason: 'is-directory' }, '目录预览应 is-directory');
  // 超限文件 → 截断
  const big = await readFilePreview(fx.root, 'big.txt');
  assert.strictEqual(big.ok, true);
  assert.strictEqual(big.truncated, true, '超限文件应 truncated');
  assert.ok(big.content.length <= LIMITS.FILE_MAX_BYTES, `content 长度 ${big.content.length} 应 ≤1MB`);
  assert.strictEqual(big.size, BIG_BYTES + 100, 'size 应为完整字节数');
  // 二进制 → binary-file
  const bin = await readFilePreview(fx.root, 'binary.bin');
  assert.deepStrictEqual(bin, { ok: false, reason: 'binary-file' }, '含 NUL 应 binary-file');
  // BOM → strip
  const bom = await readFilePreview(fx.root, 'bom.txt');
  assert.strictEqual(bom.ok, true);
  assert.ok(!bom.content.startsWith('\uFEFF'), 'BOM 应被 strip');
  assert.strictEqual(bom.content, 'hi', 'BOM 文件内容应正确');
  console.log('✅ 预览：普通 / is-directory / 超限截断 / binary-file / BOM strip');
}

// ---------- 12. openVerifiedRead：lstat 快照 vs fstat 句柄比对（TOCTOU 注入） ----------
async function testOpenVerifiedReadTOCTOU() {
  const { openVerifiedRead } = _internals;
  const okData = Buffer.from('hello world');

  // ① 快照一致 → 正常读取
  let okReads = 0;
  let okCloses = 0;
  const okIo = {
    lstat: async () => ({ dev: 10, ino: 20, size: 11, isDirectory: () => false, isSymbolicLink: () => false }),
    open: async () => ({
      stat: async () => ({ dev: 10, ino: 20, size: 11 }),
      read: async (buf, off, len) => { okReads++; okData.copy(buf, off, 0, len); return { bytesRead: Math.min(len, okData.length) }; },
      close: async () => { okCloses++; },
    }),
  };
  const ok = await openVerifiedRead('target', okIo);
  assert.strictEqual(ok.ok, true, '快照一致应正常读取');
  assert.strictEqual(ok.data.toString('utf8'), 'hello world', '读取内容正确');
  assert.strictEqual(ok.truncated, false);
  assert.strictEqual(ok.size, 11);
  assert.strictEqual(okReads, 1);
  assert.strictEqual(okCloses, 1, '读取后应 close');

  // ② dev/ino/size 任一不一致 → 拒绝、不读任何字节、仍 close
  const mismatches = [
    { label: 'dev', build: (s) => ({ dev: s.dev + 1, ino: s.ino, size: s.size }) },
    { label: 'ino', build: (s) => ({ dev: s.dev, ino: s.ino + 1, size: s.size }) },
    { label: 'size', build: (s) => ({ dev: s.dev, ino: s.ino, size: s.size + 1 }) },
  ];
  for (const m of mismatches) {
    let reads = 0;
    let closes = 0;
    const io = {
      lstat: async () => ({ dev: 10, ino: 20, size: 11, isDirectory: () => false, isSymbolicLink: () => false }),
      open: async () => ({
        stat: async () => m.build({ dev: 10, ino: 20, size: 11 }),
        read: async () => { reads++; throw new Error('不应读取'); },
        close: async () => { closes++; },
      }),
    };
    const res = await openVerifiedRead('target', io);
    assert.deepStrictEqual(res, { ok: false, reason: 'unreadable' }, `${m.label} 不一致应拒绝`);
    assert.strictEqual(reads, 0, `${m.label} 不一致时不得读取任何字节`);
    assert.strictEqual(closes, 1, `${m.label} 不一致时仍须 close`);
  }

  // ③ 快照为目录 → is-directory 且不 open
  let opened = 0;
  const dirRes = await openVerifiedRead('target', {
    lstat: async () => ({ dev: 1, ino: 2, size: 0, isDirectory: () => true, isSymbolicLink: () => false }),
    open: async () => { opened++; throw new Error('目录不应 open'); },
  });
  assert.deepStrictEqual(dirRes, { ok: false, reason: 'is-directory' }, '目录快照应 is-directory');
  assert.strictEqual(opened, 0, '目录不应 open');

  // ④ 快照为链接 → symlink-denied 且不 open
  const linkRes = await openVerifiedRead('target', {
    lstat: async () => ({ dev: 1, ino: 2, size: 0, isDirectory: () => false, isSymbolicLink: () => true }),
    open: async () => { opened++; throw new Error('链接不应 open'); },
  });
  assert.deepStrictEqual(linkRes, { ok: false, reason: 'symlink-denied' }, '链接快照应 symlink-denied');
  assert.strictEqual(opened, 0, '链接不应 open');

  // ⑤ lstat 失败 → errReason（ENOENT → not-found），不抛
  const enoent = await openVerifiedRead('target', {
    lstat: async () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  assert.deepStrictEqual(enoent, { ok: false, reason: 'not-found' }, 'lstat ENOENT 应 not-found 不抛');

  // ⑥ open 失败 → unreadable 不抛
  const openFail = await openVerifiedRead('target', {
    lstat: async () => ({ dev: 1, ino: 2, size: 1, isDirectory: () => false, isSymbolicLink: () => false }),
    open: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  assert.deepStrictEqual(openFail, { ok: false, reason: 'unreadable' }, 'open 失败应 unreadable 不抛');

  // ⑦ fh.stat 失败 → unreadable 不抛、仍 close
  let statFailCloses = 0;
  const statFail = await openVerifiedRead('target', {
    lstat: async () => ({ dev: 1, ino: 2, size: 1, isDirectory: () => false, isSymbolicLink: () => false }),
    open: async () => ({
      stat: async () => { throw Object.assign(new Error('io'), { code: 'EIO' }); },
      read: async () => { throw new Error('不应读取'); },
      close: async () => { statFailCloses++; },
    }),
  });
  assert.deepStrictEqual(statFail, { ok: false, reason: 'unreadable' }, 'fh.stat 失败应 unreadable 不抛');
  assert.strictEqual(statFailCloses, 1, 'fh.stat 失败仍应 close');

  // ⑧ close 抛错 → 不掩盖结果（匹配场景 ok / 不匹配场景 unreadable），均不抛
  const closeFailOk = await openVerifiedRead('target', {
    lstat: async () => ({ dev: 10, ino: 20, size: 11, isDirectory: () => false, isSymbolicLink: () => false }),
    open: async () => ({
      stat: async () => ({ dev: 10, ino: 20, size: 11 }),
      read: async (buf, off, len) => { okData.copy(buf, off, 0, len); return { bytesRead: Math.min(len, okData.length) }; },
      close: async () => { throw new Error('close failed'); },
    }),
  });
  assert.strictEqual(closeFailOk.ok, true, 'close 抛错不应掩盖匹配场景的读取结果');
  const closeFailRej = await openVerifiedRead('target', {
    lstat: async () => ({ dev: 10, ino: 20, size: 11, isDirectory: () => false, isSymbolicLink: () => false }),
    open: async () => ({
      stat: async () => ({ dev: 10, ino: 20, size: 99 }),
      read: async () => { throw new Error('不应读取'); },
      close: async () => { throw new Error('close failed'); },
    }),
  });
  assert.deepStrictEqual(closeFailRej, { ok: false, reason: 'unreadable' }, 'close 抛错不应掩盖拒绝结果');

  // ⑨ bigint 兼容：lstat 快照 Number 与 fstat bigint 同值 → 视为一致
  const bigRes = await openVerifiedRead('target', {
    lstat: async () => ({ dev: 10, ino: 20, size: 11, isDirectory: () => false, isSymbolicLink: () => false }),
    open: async () => ({
      stat: async () => ({ dev: 10n, ino: 20n, size: 11n }),
      read: async (buf, off, len) => { okData.copy(buf, off, 0, len); return { bytesRead: Math.min(len, okData.length) }; },
      close: async () => {},
    }),
  });
  assert.strictEqual(bigRes.ok, true, 'bigint/number 同值应视为一致（跨平台兼容）');
  assert.strictEqual(bigRes.data.toString('utf8'), 'hello world');

  // ⑩ 超限文件 → truncated、只读 1MB、size 为完整字节数
  const bigSize = LIMITS.FILE_MAX_BYTES + 5;
  const bigBuf = Buffer.alloc(bigSize, 0x61);
  let bigReadLen = -1;
  const truncRes = await openVerifiedRead('target', {
    lstat: async () => ({ dev: 1, ino: 2, size: bigSize, isDirectory: () => false, isSymbolicLink: () => false }),
    open: async () => ({
      stat: async () => ({ dev: 1, ino: 2, size: bigSize }),
      read: async (buf, off, len) => { bigReadLen = len; bigBuf.copy(buf, off, 0, len); return { bytesRead: len }; },
      close: async () => {},
    }),
  });
  assert.strictEqual(truncRes.ok, true);
  assert.strictEqual(truncRes.truncated, true, '超限应 truncated');
  assert.strictEqual(truncRes.data.length, LIMITS.FILE_MAX_BYTES, '只读 1MB');
  assert.strictEqual(bigReadLen, LIMITS.FILE_MAX_BYTES, 'read 长度应为 1MB');
  assert.strictEqual(truncRes.size, bigSize, 'size 应为完整字节数');

  // ⑪ 空文件（size=0）→ 正常返回空内容
  const emptyRes = await openVerifiedRead('target', {
    lstat: async () => ({ dev: 1, ino: 2, size: 0, isDirectory: () => false, isSymbolicLink: () => false }),
    open: async () => ({
      stat: async () => ({ dev: 1, ino: 2, size: 0 }),
      read: async (buf, off, len) => ({ bytesRead: 0 }),
      close: async () => {},
    }),
  });
  assert.strictEqual(emptyRes.ok, true, '空文件应正常读取');
  assert.strictEqual(emptyRes.data.length, 0);
  assert.strictEqual(emptyRes.truncated, false);
  console.log('✅ openVerifiedRead：快照一致读取 / dev·ino·size 任一不一致拒绝且零读取 / 目录·链接·open·stat·close 失败路径不抛 / bigint 兼容 / 1MB 截断 / 空文件');
}

// ---------- 13. readFilePreview 全链路 TOCTOU：lstat 与 fstat 不匹配 → 拒绝且未读取 ----------
async function testReadFilePreviewTOCTOU(fx) {
  const { readFilePreviewImpl } = _internals;
  const origOpen = fs.promises.open;
  let reads = 0;
  const io = {
    realpath: (p) => fs.promises.realpath(p),
    stat: (p) => fs.promises.stat(p),
    lstat: (p, o) => fs.promises.lstat(p, o),
    open: async (p, flags) => {
      const fh = await origOpen(p, flags);
      const origStat = fh.stat.bind(fh);
      const origRead = fh.read.bind(fh);
      // 篡改 fstat：size 与 lstat 快照不一致（模拟 lstat 后目标被替换）
      fh.stat = async () => {
        const st = await origStat();
        st.size += 1;
        return st;
      };
      fh.read = async (...args) => { reads++; return origRead(...args); };
      return fh;
    },
  };
  const res = await readFilePreviewImpl(fx.root, 'afile.txt', io);
  assert.strictEqual(res.ok, false, 'fstat 与 lstat 快照不一致应拒绝');
  assert.strictEqual(res.reason, 'unreadable', '不匹配 reason 应为 unreadable');
  assert.strictEqual(reads, 0, '不匹配时全链路不得读取任何字节');
  // 正常 io（不注入）回归：内容仍正确
  const plain = await readFilePreview(fx.root, 'afile.txt');
  assert.deepStrictEqual(
    { ok: plain.ok, content: plain.content, truncated: plain.truncated, size: plain.size },
    { ok: true, content: 'hello world', truncated: false, size: 11 },
    '未注入时普通预览不回归');
  console.log('✅ readFilePreview 全链路：fstat 篡改（lstat≠fstat）→ unreadable 且零读取 / 普通预览不回归');
}

async function run() {
  const fx = createFixture();
  try {
    await testListDirBasic(fx);
    await testListDirNested(fx);
    await testEmptyAndMissing(fx);
    await testContainment(fx);
    await testExcludedPaths(fx);
    await testDotDotFoo(fx);
    await testSymlinkStrict(fx);
    await testSkipNames(fx);
    await testSkipNamesBadArgs(fx);
    await testListLimit(fx);
    await testListLimitStreaming(fx);
    await testReadFilePreview(fx);
    await testOpenVerifiedReadTOCTOU();
    await testReadFilePreviewTOCTOU(fx);
  } finally {
    fs.rmSync(fx.tmpBase, { recursive: true, force: true });
  }
  console.log('\n全部 file-browser 测试通过');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
