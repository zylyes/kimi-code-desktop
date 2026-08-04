// git-service：工作区 Git 变更快照与 diff 预览
//
// 纯 Node 模块，无任何 electron 依赖，可用 `node tests/test-git-service.js` 直跑。
//
// 契约：
// - getChanges(workDir) => { ok:true, snapshotId, at, entries: ChangeEntry[] }
//                        | { ok:false, reason, notGitRepo?:true }
//   ChangeEntry = { id, path, status:'added'|'modified'|'deleted'|'renamed'|'untracked',
//                   oldPath?:string, unstaged:{adds,dels}, staged:{adds,dels} }
// - getDiffPreview(workDir, snapshotId, entryId) => { ok:true, diff, truncated } | { ok:false, reason }
//
// 数据源（三条只读命令，全部 -z NUL 分隔；spawn 不用 shell，参数数组）：
//   1. git status --porcelain=v2 -z           → 条目（XY 状态 + path；rename 附加 origPath 独立字段）
//   2. git diff --numstat -z                  → unstaged 行数（工作树 vs index）
//   3. git diff --cached --numstat -z         → staged 行数（index vs HEAD）
// 按 path 关联三源（rename 关联新 path）；staged/unstaged 各为独立统计对象，不合并。
//
// 安全边界：
// - snapshotId = randomUUID，仅内存快照表（≤20 条 LRU 淘汰）可解析；
//   快照绑定创建时 canonical workDir，getDiffPreview 跨工作区调用一律 stale-snapshot；
//   getDiffPreview 校验 snapshotId + entryId（快照内数组下标），其余一律 stale-snapshot。
// - 路径校验：lexical containment（path.relative 严格逃逸判定：'..' 本身、
//   '..'+分隔符开头、绝对路径；根内合法 '..foo' 等文件名不误拒）；
//   存在的文件补 realpathSync 比对；已删除/rename 源路径按最近存在的父目录 realpath 比对。
// - git 参数仅由 buildGitArgs 白名单生成；固定只读保护：-c core.fsmonitor=false、
//   --no-ext-diff --no-textconv、env 设 GIT_OPTIONAL_LOCKS=0 并清空 GIT_EXTERNAL_DIFF 等；
//   diff 预览的路径置于 '--' 之后；env 固定 GIT_LITERAL_PATHSPECS=1（等价全局
//   --literal-pathspecs），':' 开头 / :(glob) / :(attr) 等 pathspec magic 一律按字面路径处理。
// - 每条命令 LIMITS.GIT_TIMEOUT_MS 超时强杀；diff 流式累计，超 DIFF_MAX_BYTES /
//   DIFF_MAX_LINES 即截断（kill 子进程，truncated=true，尾部标注「（已截断）」）。
// - status/numstat 收集输出超 GIT_OUTPUT_MAX_BYTES 立即 kill → output-too-large（不返回
//   不完整快照）；stderr 超 GIT_STDERR_MAX_BYTES 截断。
// - status/numstat 与 diff 预览的 git-error / git-timeout 均只重试一次；git-missing /
//   not-git-repo / output-too-large 不重试；diff 成功但 truncated（截断）不重试。
// - 非 git 仓库（退出码 128 或 stderr 含 not a git repository）→ not-git-repo；
//   git 缺失（ENOENT）→ git-missing；均不崩溃。

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 集中限额（模块顶部）
const LIMITS = {
  GIT_TIMEOUT_MS: 10000,
  DIFF_MAX_BYTES: 500 * 1024,
  DIFF_MAX_LINES: 2000,
  GIT_OUTPUT_MAX_BYTES: 4 * 1024 * 1024, // status/numstat 收集上限；超限立即 kill 并拒绝整份输出
  GIT_STDERR_MAX_BYTES: 4096, // stderr 诊断上限（超限截断）
};

const SNAPSHOT_CAP = 20;

// snapshotId -> { workDir: canonicalWorkDir, entries: ChangeEntry[], stagedPaths: Set }
// （插入序即访问序；命中时刷新位置实现 LRU）
const snapshots = new Map();

// 可注入 spawn（测试用模拟 child process）；默认真实 spawn
let spawnFn = spawn;

// git 进程环境：禁用可选锁（GIT_OPTIONAL_LOCKS=0），清除外部 diff 相关变量，
// 固定 literal pathspec 模式（GIT_LITERAL_PATHSPECS=1，等价全局 --literal-pathspecs，
// M6：'--' 之后的路径仍可能被解释为 :(glob)/:(attr) 等 pathspec magic，统一关闭），
// 保证 diff/status 严格只读、绝不触发外部程序、路径参数一律字面解释
function gitEnv() {
  const env = Object.assign({}, process.env, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
  });
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_PATH_COUNTER;
  delete env.GIT_DIFF_PATH_TOTAL;
  return env;
}

// ---------- git 参数白名单 ----------

// 仅生成只读子命令 + 固定 flag；diff 预览 path 置于 '--' 之后。
// 固定保护：-c core.fsmonitor=false（禁用 fsmonitor）；diff 一律 --no-ext-diff --no-textconv
function buildGitArgs(command, opts = {}) {
  const base = ['-c', 'core.fsmonitor=false'];
  if (command === 'status') {
    return base.concat(['status', '--porcelain=v2', '-z']);
  }
  if (command === 'numstat') {
    return base.concat(['diff', ...(opts.cached ? ['--cached'] : []), '--numstat', '-z', '--no-ext-diff', '--no-textconv']);
  }
  if (command === 'diff-preview') {
    return base.concat(['diff', ...(opts.cached ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--', opts.path]);
  }
  throw new Error('unsupported git command: ' + command);
}

// ---------- 子进程执行 ----------

// 收集模式：status / numstat（输出有界）
function runGit(workDir, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn('git', ['-C', workDir, ...args], { shell: false, windowsHide: true, env: gitEnv() });
    } catch (err) {
      resolve(failResult(err));
      return;
    }
    const chunks = [];
    let stderr = '';
    let stdoutBytes = 0;
    let tooLarge = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, LIMITS.GIT_TIMEOUT_MS);
    child.stdout.on('data', (c) => {
      if (tooLarge) return;
      stdoutBytes += c.length;
      if (stdoutBytes > LIMITS.GIT_OUTPUT_MAX_BYTES) {
        // 超限立即 kill：绝不返回不完整快照
        tooLarge = true;
        child.kill();
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < LIMITS.GIT_STDERR_MAX_BYTES) {
        stderr += c.toString('utf8').slice(0, LIMITS.GIT_STDERR_MAX_BYTES - stderr.length);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(failResult(err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (tooLarge) {
        resolve({ ok: false, reason: 'output-too-large' });
        return;
      }
      if (timedOut) {
        resolve({ ok: false, reason: 'git-timeout' });
        return;
      }
      if (code !== 0) {
        resolve(notOkFromExit(code, stderr));
        return;
      }
      resolve({ ok: true, stdout: Buffer.concat(chunks) });
    });
  });
}

// status/numstat 的一般临时失败（git-error / git-timeout）只重试一次；
// 确定性失败（git-missing / not-git-repo / output-too-large）不得重试。
// exec 可注入（测试验证重试上限）。
function runGitWithRetry(workDir, args, exec = runGit) {
  return exec(workDir, args).then((r) => {
    if (r.ok || (r.reason !== 'git-error' && r.reason !== 'git-timeout')) return r;
    return exec(workDir, args);
  });
}

// 流式模式：diff 预览，边读边限额（字节 / 行数），超限即 kill
function runGitStream(workDir, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn('git', ['-C', workDir, ...args], { shell: false, windowsHide: true, env: gitEnv() });
    } catch (err) {
      resolve(failResult(err));
      return;
    }
    const chunks = [];
    let stderr = '';
    let bytes = 0;
    let lines = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, LIMITS.GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      let end = chunk.length;
      const roomB = LIMITS.DIFF_MAX_BYTES - bytes;
      if (roomB <= 0) {
        truncated = true;
        end = 0;
      } else if (chunk.length > roomB) {
        truncated = true;
        end = roomB;
      }
      if (end > 0) {
        const roomL = LIMITS.DIFF_MAX_LINES - lines;
        let lineCount = 0;
        for (let i = 0; i < end; i++) {
          if (chunk[i] === 0x0a) lineCount++;
        }
        if (lineCount > roomL) {
          let seen = 0;
          let cut = end;
          for (let i = 0; i < end; i++) {
            if (chunk[i] === 0x0a) {
              seen++;
              if (seen === roomL) {
                cut = i + 1;
                break;
              }
            }
          }
          end = cut;
          truncated = true;
        }
        bytes += end;
        lines += lineCount;
        chunks.push(chunk.subarray(0, end));
      }
      if (truncated) {
        clearTimeout(timer);
        child.kill();
      }
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < LIMITS.GIT_STDERR_MAX_BYTES) {
        stderr += c.toString('utf8').slice(0, LIMITS.GIT_STDERR_MAX_BYTES - stderr.length);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(failResult(err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (truncated) {
        resolve({ ok: true, stdout: Buffer.concat(chunks), truncated: true });
        return;
      }
      if (timedOut) {
        resolve({ ok: false, reason: 'git-timeout' });
        return;
      }
      if (code !== 0) {
        resolve(notOkFromExit(code, stderr));
        return;
      }
      resolve({ ok: true, stdout: Buffer.concat(chunks), truncated: false });
    });
  });
}

// diff 预览（流式）的一般临时失败（git-error / git-timeout）只重试一次；
// 确定性失败（git-missing / not-git-repo / output-too-large）与成功但截断
// （truncated）不得重试。exec 可注入（测试验证重试上限）。
function runGitStreamWithRetry(workDir, args, exec = runGitStream) {
  return exec(workDir, args).then((r) => {
    if (r.ok || (r.reason !== 'git-error' && r.reason !== 'git-timeout')) return r;
    return exec(workDir, args);
  });
}

function failResult(err) {
  if (err && err.code === 'ENOENT') return { ok: false, reason: 'git-missing' };
  return { ok: false, reason: 'git-error' };
}

function notOkFromExit(code, stderr) {
  if (code === 128 || /not a git repository/i.test(stderr)) {
    return { ok: false, reason: 'not-git-repo', notGitRepo: true };
  }
  return { ok: false, reason: 'git-error', code };
}

// ---------- 解析器（-z NUL 分隔） ----------

function splitNul(buf) {
  const fields = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      fields.push(buf.toString('utf8', start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) fields.push(buf.toString('utf8', start));
  return fields;
}

// porcelain=v2 -z：每条记录 = 一个 NUL 字段（header 空格分隔 + path 尾部）。
// 普通：'1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>'
// rename：'2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <R><score> <path>' + 下一字段 origPath
// untracked：'? <path>'；ignored：'! <path>'；unmerged：'u ...'（跳过）
function parseStatusV2Z(buf) {
  const fields = splitNul(buf);
  const records = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    i++;
    if (f.length === 0) continue;
    const tokens = f.split(' ');
    const kind = tokens[0];
    if (kind === '?' || kind === '!') {
      records.push({ type: kind === '?' ? 'untracked' : 'ignored', path: tokens.slice(1).join(' ') });
    } else if (kind === '1' || kind === '2') {
      const rec = {
        type: kind === '2' ? 'renamed' : 'normal',
        xy: tokens[1],
        path: tokens.slice(kind === '2' ? 9 : 8).join(' '),
      };
      if (kind === '2') {
        rec.origPath = fields[i] !== undefined ? fields[i] : '';
        i++;
      }
      records.push(rec);
    } else if (kind === 'u') {
      // unmerged（冲突）：解析层记录，调用方跳过
      records.push({ type: 'unmerged', path: tokens.slice(10).join(' ') });
    }
    // 其他未知记录：跳过
  }
  return records;
}

// numstat -z：'<adds>\t<dels>\t<path>'；rename：'<adds>\t<dels>\t' + src + dst 两独立字段；
// 二进制 adds/dels 为 '-'（按 0）
function parseNumstatZ(buf) {
  const map = new Map();
  const fields = splitNul(buf);
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    i++;
    if (f.length === 0) continue;
    const t1 = f.indexOf('\t');
    if (t1 < 0) continue;
    const adds = f.slice(0, t1);
    const rest = f.slice(t1 + 1);
    const t2 = rest.indexOf('\t');
    if (t2 < 0) continue;
    const dels = rest.slice(0, t2);
    const p = rest.slice(t2 + 1);
    if (p === '') {
      const src = fields[i] !== undefined ? fields[i] : '';
      const dst = fields[i + 1] !== undefined ? fields[i + 1] : '';
      i += 2;
      if (dst) map.set(dst, { adds: toCount(adds), dels: toCount(dels) });
    } else {
      map.set(p, { adds: toCount(adds), dels: toCount(dels) });
    }
  }
  return map;
}

function toCount(s) {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// XY 状态映射：X=index 侧、Y=worktree 侧；'.' 未变、'M' 修改、'A' 新增、'D' 删除、'R' rename
function mapStatus(xy, isRename) {
  if (isRename) return 'renamed';
  const X = xy[0];
  if (X === 'A') return 'added';
  if (xy.indexOf('D') >= 0) return 'deleted';
  return 'modified';
}

// ---------- 路径校验 ----------

function checkContainment(workDir, p) {
  const rel = path.relative(workDir, p);
  // 只拒绝严格逃逸：'..' 本身、'..' + 分隔符开头的相对路径、绝对路径；
  // 根内合法文件名（如 '..foo'、'...txt'）不得误拒
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}

// 存在文件 → realpath 比对；不存在（deleted/rename 源）→ 最近存在的父目录 realpath 比对
function validatePath(workDir, p) {
  if (!checkContainment(workDir, path.resolve(workDir, p))) return false;
  const resolved = path.resolve(workDir, p);
  try {
    if (fs.existsSync(resolved)) {
      return checkContainment(workDir, fs.realpathSync(resolved));
    }
    let d = path.dirname(resolved);
    for (;;) {
      if (fs.existsSync(d)) {
        return checkContainment(workDir, fs.realpathSync(d));
      }
      const parent = path.dirname(d);
      if (parent === d) return false;
      d = parent;
    }
  } catch {
    return false;
  }
}

function normalizeWorkDir(workDir) {
  if (typeof workDir !== 'string' || workDir.length === 0) return { error: 'bad-workdir' };
  try {
    return { workDir: fs.realpathSync(workDir) };
  } catch {
    return { error: 'workdir-not-found' };
  }
}

// ---------- 公共 API ----------

async function getChanges(workDir) {
  const wd0 = normalizeWorkDir(workDir);
  if (wd0.error) return { ok: false, reason: wd0.error };
  const wd = wd0.workDir;

  const st = await runGitWithRetry(wd, buildGitArgs('status'));
  if (!st.ok) return { ok: false, reason: st.reason, notGitRepo: st.notGitRepo };
  const un = await runGitWithRetry(wd, buildGitArgs('numstat'));
  if (!un.ok) return { ok: false, reason: un.reason };
  const sg = await runGitWithRetry(wd, buildGitArgs('numstat', { cached: true }));
  if (!sg.ok) return { ok: false, reason: sg.reason };

  const entries = [];
  for (const rec of parseStatusV2Z(st.stdout)) {
    // ignored / unmerged 及未知记录：跳过
    if (rec.type !== 'normal' && rec.type !== 'renamed' && rec.type !== 'untracked') continue;
    if (!validatePath(wd, rec.path)) continue;
    if (rec.origPath && !validatePath(wd, rec.origPath)) continue;

    const entry = {
      id: entries.length,
      path: rec.path,
      status: rec.type === 'untracked' ? 'untracked' : mapStatus(rec.xy, rec.type === 'renamed'),
      unstaged: { adds: 0, dels: 0 },
      staged: { adds: 0, dels: 0 },
    };
    if (rec.type === 'renamed') entry.oldPath = rec.origPath;
    entries.push(entry);
  }

  // 按 path 关联三源（rename 关联新 path）；staged/unstaged 独立统计，不合并。
  // stagedPaths：记录 staged numstat 是否命中该 path（二进制/纯 rename/空文件
  // 行数常为 0/0，diff 侧选择必须依赖此集合而非行数和）
  const unstagedMap = parseNumstatZ(un.stdout);
  const stagedMap = parseNumstatZ(sg.stdout);
  const stagedPaths = new Set();
  for (const e of entries) {
    const u = unstagedMap.get(e.path);
    const s = stagedMap.get(e.path);
    if (u) e.unstaged = u;
    if (s) {
      e.staged = s;
      stagedPaths.add(e.path);
    }
  }

  const snapshotId = crypto.randomUUID();
  snapshots.set(snapshotId, { workDir: wd, entries, stagedPaths });
  while (snapshots.size > SNAPSHOT_CAP) {
    const oldest = snapshots.keys().next().value;
    snapshots.delete(oldest);
  }
  return { ok: true, snapshotId, at: Date.now(), entries };
}

function toEntryId(x) {
  if (typeof x === 'number') return Number.isInteger(x) ? x : null;
  if (typeof x === 'string' && /^\d+$/.test(x) && x.length <= 15) return parseInt(x, 10);
  return null;
}

async function getDiffPreview(workDir, snapshotId, entryId) {
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
    return { ok: false, reason: 'stale-snapshot' };
  }
  const id = toEntryId(entryId);
  const snap = snapshots.get(snapshotId);
  if (!snap || id === null || id < 0 || id >= snap.entries.length) {
    return { ok: false, reason: 'stale-snapshot' };
  }
  const wd0 = normalizeWorkDir(workDir);
  if (wd0.error) return { ok: false, reason: wd0.error };
  // 快照严格绑定创建时的 canonical workDir：跨工作区调用一律视为过期
  if (wd0.workDir !== snap.workDir) return { ok: false, reason: 'stale-snapshot' };

  const entry = snap.entries[id];
  if (!validatePath(wd0.workDir, entry.path)) return { ok: false, reason: 'path-denied' };

  // 侧选择不依赖 staged 行数和（二进制/纯 rename/空文件常为 0/0）：
  // 快照阶段记录 staged numstat 命中集合，命中即 --cached；同文件双侧变更优先 staged
  const useCached = snap.stagedPaths.has(entry.path);
  const r = await runGitStreamWithRetry(
    wd0.workDir,
    buildGitArgs('diff-preview', { cached: useCached, path: entry.path })
  );
  if (!r.ok) return { ok: false, reason: r.reason, notGitRepo: r.notGitRepo };

  // 命中则刷新 LRU 位置
  snapshots.delete(snapshotId);
  snapshots.set(snapshotId, snap);

  let diff = r.stdout.toString('utf8');
  if (r.truncated) diff += '（已截断）';
  return { ok: true, diff, truncated: r.truncated, source: useCached ? 'staged' : 'worktree' };
}

// 测试注入点：替换 spawn 实现（模拟 child process）；传 null 恢复真实 spawn
function _setSpawn(fn) {
  spawnFn = typeof fn === 'function' ? fn : spawn;
}

module.exports = {
  getChanges,
  getDiffPreview,
  LIMITS,
  _internals: {
    buildGitArgs,
    parseStatusV2Z,
    parseNumstatZ,
    runGitWithRetry,
    runGitStreamWithRetry,
    checkContainment,
    _setSpawn,
  },
};
