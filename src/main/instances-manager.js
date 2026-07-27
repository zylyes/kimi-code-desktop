// Kimi Code Desktop — kimi web 多实例扫描后端
// 单来源适配：仅新版 CLI（0.28+）~/.kimi-code/server/instances/*.json，每实例一个文件
// （格式未验证，防御性解析保留）
// 纯 Node 模块，不依赖 electron，供 main.js require 使用。
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

function defaultKimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// 从多个候选字段名中取第一个非空值
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
  }
  return null;
}

function toPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 判断进程是否存活：ESRCH=不存在，EPERM=存在但无权限（视为存活），无 pid 视为不存活
function checkPidAlive(pid) {
  const n = toPositiveInt(pid);
  if (n == null) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

// 防御性归一化：字段可能缺失/命名不一（pid|processId、host_version|version、started_at|startedAt）
// 既无 pid 又无 port 的条目视为无效，返回 null
function normalizeInstance(raw, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pid = toPositiveInt(pick(raw, ['pid', 'processId']));
  const port = toPositiveInt(pick(raw, ['port']));
  if (pid == null && port == null) return null;
  const host = pick(raw, ['host']);
  const version = pick(raw, ['host_version', 'version']);
  const startedAt = pick(raw, ['started_at', 'startedAt']);
  return {
    pid,
    host: typeof host === 'string' && host ? host : null,
    port,
    version: version != null ? String(version) : null,
    startedAt: startedAt != null ? String(startedAt) : null,
    alive: checkPidAlive(pid),
    source, // 'instances-dir'
  };
}

// 排序约定：按 startedAt 降序（最新启动的在前），缺失或无法解析的排最后；
// 时间相同保持文件名升序（readdir 结果已排序，Array.prototype.sort 为稳定排序）
function sortInstances(list) {
  const ts = (s) => {
    const t = Date.parse(s || '');
    return Number.isNaN(t) ? 0 : t;
  };
  return list.slice().sort((a, b) => ts(b.startedAt) - ts(a.startedAt));
}

// 同步扫描 kimi web 实例：读取 server/instances/*.json，无有效条目返回 []
function scanInstances(kimiHomeDir) {
  const home = kimiHomeDir || defaultKimiHome();
  const instancesDir = path.join(home, 'server', 'instances');
  let files = [];
  try {
    files = fs.readdirSync(instancesDir)
      .filter((f) => /\.json$/i.test(f))
      .sort();
  } catch {
    files = []; // 目录不存在或不可读
  }
  const list = [];
  for (const f of files) {
    // 单个文件 JSON 损坏或条目无效时跳过，不影响整体
    const inst = normalizeInstance(readJSON(path.join(instancesDir, f)), 'instances-dir');
    if (inst) list.push(inst);
  }
  return sortInstances(list);
}

// 异步探测实例：GET http://<host>:<port>/openapi.json，2xx 为 true；超时/拒连/非 2xx 为 false
function probeInstance(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!host || !toPositiveInt(port)) return resolve(false);
    const req = http.get({ host, port, path: '/openapi.json', timeout: timeoutMs }, (res) => {
      res.resume(); // 不关心响应体，直接丢弃
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

module.exports = {
  scanInstances,
  checkPidAlive,
  probeInstance,
};
