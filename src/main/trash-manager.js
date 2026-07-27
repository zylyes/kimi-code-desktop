// Kimi Code Desktop — 回收站管理模块
// 纯 Node.js 同步 fs 逻辑，不依赖 electron，homeDir 参数化便于单测。
// 目录结构：<homeDir>/.trash/<entryName>/ 内含 meta.json 与原始会话目录内容。
const fs = require('fs');
const path = require('path');

// 校验 entryName/sessionId 防路径穿越：只允许字母数字下划线连字符
const SAFE_NAME_RE = /^[A-Za-z0-9_-]+$/;

function assertSafeName(name, label) {
  if (typeof name !== 'string' || !name || !SAFE_NAME_RE.test(name) || name.includes('..')) {
    throw new Error(`非法 ${label}（仅允许字母数字下划线连字符）: ${JSON.stringify(name)}`);
  }
}

// 格式化时间戳为 yyyymmdd-hhmmss
function tsFormat() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// 将会话目录移至 .trash，写 meta.json，返回条目目录名
function moveToTrash(homeDir, { sessionId, sessionDir, workDir, title }) {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('moveToTrash: 缺少 sessionId');
  if (!sessionDir || typeof sessionDir !== 'string') throw new Error('moveToTrash: 缺少 sessionDir');
  assertSafeName(sessionId, 'sessionId');

  if (!fs.existsSync(sessionDir)) {
    throw new Error(`会话目录不存在: ${sessionDir}`);
  }

  const trashDir = path.join(homeDir, '.trash');
  fs.mkdirSync(trashDir, { recursive: true });

  const entryName = `${sessionId}_${tsFormat()}`;
  const destDir = path.join(trashDir, entryName);

  // rename 前确保目标目录的父目录存在
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.renameSync(sessionDir, destDir);

  const meta = {
    sessionId,
    originalDir: sessionDir,
    workDir: workDir || '',
    title: title || '',
    deletedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(destDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  return entryName;
}

// 列出回收站中的条目（按 deletedAt 倒序）
function listTrash(homeDir) {
  const trashDir = path.join(homeDir, '.trash');
  if (!fs.existsSync(trashDir)) return [];

  const entries = [];
  let names;
  try {
    names = fs.readdirSync(trashDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dirent of names) {
    if (!dirent.isDirectory()) continue;
    const entryName = dirent.name;
    // 安全校验
    try {
      assertSafeName(entryName, 'entryName');
    } catch {
      continue; // 跳过非法命名的目录
    }
    const metaPath = path.join(trashDir, entryName, 'meta.json');
    let meta;
    try {
      const raw = fs.readFileSync(metaPath, 'utf8');
      meta = JSON.parse(raw);
    } catch {
      continue; // meta.json 损坏/缺失跳过
    }
    if (!meta.sessionId) continue; // 缺少必要字段
    entries.push({
      entryName,
      sessionId: meta.sessionId,
      originalDir: meta.originalDir || '',
      workDir: meta.workDir || '',
      title: meta.title || '',
      deletedAt: meta.deletedAt || '',
    });
  }

  // 按 deletedAt 倒序（最新的在前）
  entries.sort((a, b) => {
    const ta = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
    const tb = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
    return tb - ta;
  });

  return entries;
}

// 从回收站恢复：读 meta.json，originalDir 已存在则 throw，rename 回去，删除 trash 条目目录
function restoreFromTrash(homeDir, entryName) {
  assertSafeName(entryName, 'entryName');

  const entryDir = path.join(homeDir, '.trash', entryName);
  const metaPath = path.join(entryDir, 'meta.json');

  let meta;
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    meta = JSON.parse(raw);
  } catch (e) {
    throw new Error(`无法读取回收站条目 meta.json: ${e.message}`);
  }
  if (!meta.sessionId || !meta.originalDir) {
    throw new Error('回收站条目 meta.json 缺少必要字段');
  }

  if (fs.existsSync(meta.originalDir)) {
    throw new Error(`目标目录已存在，无法恢复: ${meta.originalDir}`);
  }

  // 确保 originalDir 父目录存在
  fs.mkdirSync(path.dirname(meta.originalDir), { recursive: true });

  // 重命名恢复
  fs.renameSync(entryDir, meta.originalDir);

  return meta;
}

// 彻底删除回收站条目
function purgeTrash(homeDir, entryName) {
  assertSafeName(entryName, 'entryName');

  const entryDir = path.join(homeDir, '.trash', entryName);
  if (!fs.existsSync(entryDir)) {
    throw new Error(`回收站条目不存在: ${entryName}`);
  }

  fs.rmSync(entryDir, { recursive: true, force: true });
}

module.exports = { moveToTrash, listTrash, restoreFromTrash, purgeTrash };