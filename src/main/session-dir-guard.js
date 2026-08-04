// session-dir-guard — M6 高危项：sessionDir 本体校验（纯 Node，无 electron）
// 在任何 realpath / 授权之前，对 sessionDir 做 lstat 本体检查：必须是真实目录本体，
// 不得是普通文件、symbolic link 或 junction / reparse point；lstat 失败同样拒绝。
// 由 main.js workspaceBoundSessionContext() 实际调用（该函数是 M3 Changes/Files/Diff
// 与 M4 投影的唯一 sessionDir/workDir 来源）——拒绝即 unbound，不产生任何授权。
'use strict';

const fs = require('fs');

// 判定 p 是否为「真实目录本体」：
//  - 空/非字符串 → false（拒绝）
//  - lstat 失败（不存在/无权限/损坏）→ false（拒绝）
//  - 非目录（普通文件/设备等）→ false（拒绝）
//  - symbolic link → false（拒绝；Node 22+ 上 junction 在 lstat 即显示为 symlink，
//    此处一并拒绝）
//  - junction / 其他 reparse point（旧 Node 上 lstat 显示为目录，但 readlink 可解析
//    目标）→ readlink 探测命中 → false（拒绝）
//  - 其余（真实目录，readlink 抛 EINVAL 确认非链接）→ true（通过）
function isRealDirectoryBody(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  let st;
  try {
    st = fs.lstatSync(p); // 不跟随链接，看本体
  } catch {
    return false; // lstat 失败：不存在/权限/损坏 → unbound
  }
  if (!st.isDirectory()) return false; // 普通文件等非目录 → unbound
  if (st.isSymbolicLink()) return false; // symlink（含 Node 22+ 的 junction）→ unbound
  // 兜底探测：旧 Node 上 junction 的 lstat 表现为目录，readlink 仍能解析目标；
  // 真实目录 readlink 必抛 EINVAL；其他错误（权限等）保守拒绝
  try {
    fs.readlinkSync(p);
    return false; // 能读出链接目标 → reparse point → unbound
  } catch (err) {
    return !err || err.code === 'EINVAL';
  }
}

module.exports = { isRealDirectoryBody };
