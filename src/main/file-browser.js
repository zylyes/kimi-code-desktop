// file-browser 模块：受限的只读文件浏览服务（纯 Node，无 electron 依赖）
// 供 main.js 与工作区面板调用：listDir 枚举目录、readFilePreview 读取文件预览。
// 安全契约（调用方责任：验证 root 的授权性；本模块负责 containment 与 symlink 逃逸防护）：
//   1. containment：path.resolve(root, relPath) 必须仍在 root 内（path.relative 不以 .. 开头、非绝对）
//   2. 排除规则：默认排除路径段 ['.git','node_modules'] 恒不可绕过——opts.skipNames 仅追加
//      额外排除名，不能取消默认安全排除；list/read 目标先做 lexical 路径段检查，再对
//      canonical（realpath）目标二次检查，防 symlink alias（如 git-link -> root/.git）与
//      check-to-use 竞态；拒绝 reason 为 excluded-path
//   3. symlink/junction 严格拒绝：root 内任何 descendant symlink/junction 均不支持——
//      直接 list/read 返回 symlink-denied，列举时跳过；不解析、不跟随，避免 check-to-use 竞态。
//      root 自身先 realpath 规范化；实际 IO 前对 canonical target 二次 containment 校验
//   4. root 必须存在且为目录
//   5. 纯只读：模块内无任何写操作
// 纵深防御说明：纯 Node 路径 API（path.resolve/relative + realpath）在 Windows 下无法提供
// 文件句柄级原子保证；canonical 二次校验 + 严格 symlink 拒绝属防御深度（defense in depth），
// 缩小 check-to-use 竞态窗口，而非原子性承诺。本模块不引入任何写操作或句柄持有。
// M6 TOCTOU 加固：readFilePreview 对文件采用「lstat 快照（dev/ino/size）→ open 只读 →
// fstat 句柄比对」流程，任何不一致即 close 且不读任何字节，可靠避免读取被替换的目标文件。
// 平台限制：Windows Node 无可用 O_NOFOLLOW/openat，且 JS 层无法原子拒绝目录 reparse
// point——listDir 的路径检查与 opendir 之间仍存在理论竞态窗口（已尽力缩小），
// 此处不虚假声称已完全消除；不引入 native 依赖。
'use strict';
const fs = require('fs');
const path = require('path');

// ---------- 限制常量（集中模块顶部） ----------
const LIMITS = {
  FILE_MAX_BYTES: 1024 * 1024, // 单文件预览上限 1MB
  LIST_MAX_ENTRIES: 500, // 目录枚举条目上限
};

const DEFAULT_SKIP_NAMES = ['.git', 'node_modules'];
const BINARY_PROBE_BYTES = 8 * 1024; // 二进制检测窗口：前 8KB 含 NUL 字节视为二进制

// ---------- 内部工具 ----------

// 判断 target 是否在 root 之内（root/target 均已规范化）。
// 规则：path.relative 不以 '..' 开头、非绝对路径；rel === '' 视为自身（允许）。
// Windows 上 Node 的 path.relative 内部已做大小写不敏感比较（win32 实现 lowercases 后解析）。
function isWithin(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true; // target 就是 root 自身
  if (path.isAbsolute(rel)) return false; // 不同盘符/根 → 绝对相对路径
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

// root 校验与规范化：必须存在且为目录，返回 realpath 规范化后的 root（后续比较以此为准）。
// 返回 null 表示 root 无效（不存在/不可访问/非目录）。io 可注入（默认 fs.promises）。
async function normalizeRoot(root, io = fs.promises) {
  let norm;
  try {
    norm = await io.realpath(root);
  } catch {
    return null;
  }
  try {
    const st = await io.stat(norm);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  return norm;
}

// target 相对 normRoot 的路径段是否命中排除集合（大小写不敏感比较，覆盖 Windows 大小写不敏感 FS）。
// rel === ''（root 自身）不算被排除——root 由调用方授权。
function hasExcludedSegment(normRoot, target, skipLower) {
  const rel = path.relative(normRoot, target);
  if (rel === '') return false;
  for (const part of rel.split(path.sep)) {
    if (skipLower.has(part.toLowerCase())) return true;
  }
  return false;
}

// opts 必须是普通对象（排除 null / 数组 / 原始值；非普通对象一律 bad-arg）。
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 校验并归一化排除集合：默认 ['.git','node_modules'] 恒不可绕过，skipNames 仅追加额外排除名。
// skipNames 缺失（undefined）→ 默认集合；存在时必须是字符串数组，每个元素必须为非空
// basename（不含 '/'、'\\'、NUL），否则返回 bad-arg（不抛异常）。
// 返回 { ok:true, skipLower:Set }（元素均为小写，供大小写不敏感比较）或 { ok:false }。
function buildSkipLower(skipNames) {
  const skip = new Set(DEFAULT_SKIP_NAMES);
  if (skipNames === undefined) return { ok: true, skipLower: skip };
  if (!Array.isArray(skipNames)) return { ok: false };
  for (const s of skipNames) {
    if (typeof s !== 'string' || s === '' || s.includes('/') || s.includes('\\') || s.includes('\0')) {
      return { ok: false };
    }
    skip.add(s.toLowerCase());
  }
  return { ok: true, skipLower: skip };
}

// 安全解析目标路径：以规范化 normRoot 为基准做 containment + 逐级 symlink/junction 检查。
// 严格拒绝策略：任一级为 symlink/junction 即返回 symlink-denied（不解析、不跟随）。
// 返回 { ok:true, target } 或 { ok:false, reason:'escape-denied' | 'symlink-denied' }。
async function resolveSafeTarget(normRoot, relPath, io = fs.promises) {
  if (relPath === '' || relPath === '.') return { ok: true, target: normRoot };
  const resolved = path.resolve(normRoot, relPath);
  if (!isWithin(normRoot, resolved)) {
    return { ok: false, reason: 'escape-denied' };
  }
  const rel = path.relative(normRoot, resolved);
  let cur = normRoot;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    let lst;
    try {
      lst = await io.lstat(cur);
    } catch {
      // 中间级不存在/不可 lstat → 放行，由最终 IO 报错（not-found/unreadable）
      continue;
    }
    if (lst.isSymbolicLink()) {
      // Windows junction 的 lstat.isSymbolicLink() 亦为 true，一并覆盖
      return { ok: false, reason: 'symlink-denied' };
    }
  }
  return { ok: true, target: resolved };
}

// 目标二次校验（check-to-use 纵深防御）：
//   1) lexical 排除段检查（未解析别名前）
//   2) realpath 规范化后 containment 校验（防 IO 前路径被替换为指向 root 外的别名）
//   3) canonical 排除段检查（防 git-link -> root/.git 等别名命中排除目录）
// 返回 { ok:true, target }（target 为 realpath 结果，无法解析时退回原路径，由 IO 报错）
// 或 { ok:false, reason:'excluded-path' | 'escape-denied' }。
async function finalizeTarget(normRoot, target, skipLower, io = fs.promises) {
  if (hasExcludedSegment(normRoot, target, skipLower)) {
    return { ok: false, reason: 'excluded-path' };
  }
  let real;
  try {
    real = await io.realpath(target);
  } catch {
    return { ok: true, target }; // 路径不存在/不可解析 → 交给实际 IO 报错
  }
  if (!isWithin(normRoot, real)) {
    return { ok: false, reason: 'escape-denied' };
  }
  if (hasExcludedSegment(normRoot, real, skipLower)) {
    return { ok: false, reason: 'excluded-path' };
  }
  return { ok: true, target: real };
}

function errReason(err) {
  if (err && err.code === 'ENOENT') return 'not-found';
  if (err && err.code === 'ENOTDIR') return 'not-a-directory';
  return 'unreadable';
}

// 句柄一致性比较：dev/ino/size 全部一致才视为同一文件。
// 统一按十进制字符串比较，兼容 bigint 模式（{ bigint: true }）与 Number 模式混用
// （部分平台/文件系统 ino 超出 Number.MAX_SAFE_INTEGER 时 Number 转换可能丢精度）。
function sameFile(a, b) {
  return (
    String(a.dev) === String(b.dev) &&
    String(a.ino) === String(b.ino) &&
    String(a.size) === String(b.size)
  );
}

// openVerifiedRead(target, io)：带 TOCTOU 加固的单文件只读打开+读取。
// 流程：lstat 快照（dev/ino/size）→ open 只读 → fstat 句柄比对——任一不一致立即
// close 且不读任何字节，防止 lstat 校验后目标被替换为其他文件（可靠避免读取被替换目标；
// Windows Node 无 O_NOFOLLOW/openat，此流程是纯 JS 可用的最可靠替代）。
// 打开失败 / 句柄 stat 失败 / 读取失败 → { ok:false, reason:'unreadable' }（不抛）；
// close 失败被吞（不掩盖结果）。io 可注入（默认 fs.promises）供测试模拟不匹配场景。
// 返回 { ok:true, data, truncated, size } 或 { ok:false, reason }。
// reason：'is-directory'（快照为目录）/ 'symlink-denied'（快照为链接，纵深防御）/
// 'not-found' / 'unreadable'（含不匹配拒绝）。
async function openVerifiedRead(target, io) {
  let snapshot;
  try {
    snapshot = await io.lstat(target);
  } catch (err) {
    return { ok: false, reason: errReason(err) };
  }
  if (snapshot.isDirectory()) return { ok: false, reason: 'is-directory' };
  if (snapshot.isSymbolicLink()) return { ok: false, reason: 'symlink-denied' };
  let fh;
  try {
    fh = await io.open(target, 'r');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const st = await fh.stat();
    if (!sameFile(snapshot, st)) {
      // 目标已被替换（dev/ino/size 任一不一致）：不读任何字节即拒绝
      return { ok: false, reason: 'unreadable' };
    }
    const size = Number(st.size); // bigint 模式（{bigint:true}）下 size 为 bigint，Buffer.alloc 前须转 Number（预览上限 1MB 远小于 2^53，无精度损失）
    const truncated = size > LIMITS.FILE_MAX_BYTES;
    const readLen = truncated ? LIMITS.FILE_MAX_BYTES : size;
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, 0);
    return {
      ok: true,
      data: bytesRead < readLen ? buf.subarray(0, bytesRead) : buf,
      truncated,
      size,
    };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    try {
      await fh.close();
    } catch {
      // 关闭失败不掩盖结果（句柄由 GC/OS 兜底回收）
    }
  }
}

// ---------- 对外 API ----------

// listDir(root, relPath='', opts?)：枚举 root/relPath 的直接子项（不递归）。
// opts = { skipNames?: string[] }：默认跳过 ['.git','node_modules']（恒不可绕过），
// skipNames 仅追加额外排除名；skipNames 缺失=默认，存在时必须是字符串数组且元素为
// 非空 basename（无 '/'、'\\'、NUL）。opts 必须为普通对象，否则返回 { ok:false, reason:'bad-arg' }。
// 流式读取：fs.promises.opendir() 逐个读取，收集满 LIMITS.LIST_MAX_ENTRIES + 1 个
// 未跳过候选即停止，不做全量 readdir / 全量 lstat 后截断。
async function listDir(root, relPath = '', opts = {}) {
  if (!isPlainObject(opts)) return { ok: false, reason: 'bad-arg' };
  const skipRes = buildSkipLower(opts.skipNames);
  if (!skipRes.ok) return { ok: false, reason: 'bad-arg' };
  const skipLower = skipRes.skipLower;
  const normRoot = await normalizeRoot(root);
  if (!normRoot) {
    // root 不存在/不可访问 → not-found；存在但不是目录 → not-a-directory
    let st;
    try {
      st = await fs.promises.stat(root);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: false, reason: st.isDirectory() ? 'unreadable' : 'not-a-directory' };
  }
  const safe = await resolveSafeTarget(normRoot, relPath);
  if (!safe.ok) return safe;
  const final = await finalizeTarget(normRoot, safe.target, skipLower);
  if (!final.ok) return final;
  // 尽力缩小路径竞态：opendir 前对最终目标再 lstat——链接 → symlink-denied（纵深防御，
  // 此时不应出现）、非目录 → not-a-directory。
  // 平台限制（如实声明）：Windows Node JS 层无法原子拒绝目录 reparse point——lstat
  // 检查与 opendir 之间目录仍可能被替换为 junction/reparse point，此窗口无 native
  // 依赖无法消除，本模块不虚假声称已完全消除该竞态。
  let lst;
  try {
    lst = await fs.promises.lstat(final.target);
  } catch (err) {
    return { ok: false, reason: errReason(err) };
  }
  if (lst.isSymbolicLink()) return { ok: false, reason: 'symlink-denied' };
  if (!lst.isDirectory()) return { ok: false, reason: 'not-a-directory' };
  let dir;
  try {
    dir = await fs.promises.opendir(final.target);
  } catch (err) {
    return { ok: false, reason: errReason(err) };
  }
  const entries = [];
  let truncated = false;
  try {
    let entry;
    while ((entry = await dir.read()) !== null) {
      // Node 的 dir.read() 在较新版本返回 Dirent（含 name），旧版本返回字符串：统一取 name
      const name = typeof entry === 'string' ? entry : entry.name;
      if (skipLower.has(name.toLowerCase())) continue; // 排除规则（含 .GIT 等大小写变体）
      // 严格拒绝：symlink/junction 一律跳过（不跟随）；dirent 无 symlink 信息时由 lstat 兜底
      if (typeof entry !== 'string' && entry.isSymbolicLink()) continue;
      let st;
      try {
        st = await fs.promises.lstat(path.join(final.target, name));
      } catch {
        continue; // 无法 lstat 的条目：跳过
      }
      if (st.isSymbolicLink()) continue; // 严格拒绝：symlink/junction 一律跳过（不跟随）
      entries.push({
        path: relPath === '' ? name : `${relPath.replace(/[\\/]+$/, '')}/${name}`,
        name,
        type: st.isDirectory() ? 'dir' : 'file',
        size: st.isDirectory() ? 0 : st.size,
        mtime: Math.round(st.mtimeMs),
      });
      if (entries.length > LIMITS.LIST_MAX_ENTRIES) {
        truncated = true; // 已收集 LIMITS+1 个候选：停止扫描
        break;
      }
    }
  } catch (err) {
    return { ok: false, reason: errReason(err) };
  } finally {
    try {
      await dir.close();
    } catch {
      // 忽略关闭错误
    }
  }
  // 排序：目录在前，同组按 name localeCompare（大小写不敏感）
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  if (truncated) entries.length = LIMITS.LIST_MAX_ENTRIES;
  return { ok: true, entries, truncated };
}

// readFilePreview 核心实现：io 可注入（默认 fs.promises），供测试注入 lstat/fstat
// 不一致场景验证 TOCTOU 拒绝路径。
async function readFilePreviewImpl(root, relPath, io = fs.promises) {
  const normRoot = await normalizeRoot(root, io);
  if (!normRoot) {
    let st;
    try {
      st = await io.stat(root);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: false, reason: st.isDirectory() ? 'unreadable' : 'not-a-directory' };
  }
  const skipLower = buildSkipLower().skipLower;
  const safe = await resolveSafeTarget(normRoot, relPath, io);
  if (!safe.ok) return safe;
  const final = await finalizeTarget(normRoot, safe.target, skipLower, io);
  if (!final.ok) return final;
  let res;
  try {
    res = await openVerifiedRead(final.target, io);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!res.ok) return res;
  // 疑似二进制：前 8KB 含 NUL 字节
  const head = res.data.length <= BINARY_PROBE_BYTES ? res.data : res.data.subarray(0, BINARY_PROBE_BYTES);
  if (head.includes(0)) return { ok: false, reason: 'binary-file' };
  // UTF-8 解码 + strip BOM
  let content = res.data.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return { ok: true, content, truncated: res.truncated, size: res.size };
}

// readFilePreview(root, relPath)：读取单文件预览（≤1MB，UTF-8，strip BOM）。
// 排除规则使用默认集合（readFilePreview 无 skipNames 参数）。
// M6 TOCTOU 加固：任何读取前执行 open 后 fstat 验证——fstat 与 lstat 快照
// （dev/ino/size）任一不一致即 close 且不读任何字节；严禁仅 realpath/lstat 后 readFileSync。
async function readFilePreview(root, relPath) {
  return readFilePreviewImpl(root, relPath, fs.promises);
}

module.exports = {
  listDir,
  readFilePreview,
  LIMITS,
  _internals: { readFilePreviewImpl, openVerifiedRead, sameFile },
};
