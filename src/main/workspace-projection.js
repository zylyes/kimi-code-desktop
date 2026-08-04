// 工作区数据投影（M4-1/M4-5）：单一已验证会话的 agents 树 + 任务目录组合视图。
// 纯 Node 无 electron。只读：绝不启动 ACP、绝不写 session 数据、不做 sessionsRoot 全量扫描，
// 不做 replay/reducer、不跨会话合并。Workspace 只消费已验证的具体 sessionDir 的磁盘快照。
//
// 契约：
//   getWorkspaceProjection({ sessionId, sessionDir, taskCatalog }) ->
//   { ok:true, sessionId, agents: SubagentNode[], tasks: CatalogEntry[],
//     diagnostics: { agents: <buildSubagentTree.diagnostics>, tasks: <getCatalog.diagnostics> }, capturedAt }
//   | { ok:false, reason: 'unbound' | 'invalid-session-dir' | 'no-catalog' | 'catalog-error',
//       sessionId: string|null, agents: [], tasks: [], diagnostics, capturedAt }
// 失败/容错路径不抛：输入缺失/非法 -> 空态；目录缺失/坏文件 -> 失败态或诊断透传；
// getCatalog rejection（不受信 taskCatalog 实现或异常）-> 'catalog-error' 失败态，不逃逸。
// 会话 ID 绑定：canonical（realpath）sessionDir 的 basename 必须等于 sessionId，
// 独立于 TaskCatalog 再执行一次（防纯模块调用绕过其 _validateSessionDir），错配 -> invalid-session-dir 空态。
'use strict';

const fs = require('fs');
const path = require('path');

const { buildSubagentTree } = require('./subagent-tree');

// M6 资源上限：投影响应条目上限——上游（buildSubagentTree/getCatalog）已各自截断，
// 此处为独立防御防线：超限时确定性截断（保留前端 N 条，agents 已按 main 优先+时间升序
// 排序、tasks 已按合并序），截断标记计入 diagnostics.truncated，不抛。
const LIMITS = {
  MAX_AGENTS: 500, // agents 响应条目上限
  MAX_TASKS: 2000, // tasks 响应条目上限
};

async function getWorkspaceProjection({ sessionId, sessionDir, taskCatalog } = {}) {
  const capturedAt = Date.now();
  const diagnostics = { agents: null, tasks: null };
  const fail = (reason, sid) => ({
    ok: false, reason, sessionId: sid, agents: [], tasks: [], diagnostics, capturedAt,
  });

  // 1. 输入校验：缺失/非法 -> 空态（不抛）
  const sid = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId : null;
  if (!sid) return fail('unbound', null);
  const dir = typeof sessionDir === 'string' && sessionDir.length > 0 ? sessionDir : null;
  if (!dir) return fail('invalid-session-dir', sid);
  if (!taskCatalog || typeof taskCatalog.getCatalog !== 'function') {
    return fail('no-catalog', sid);
  }

  // 2. 独立会话 ID 绑定检查：canonical sessionDir 的 basename 必须等于 sessionId（绝不读盘时放行）
  let canonicalDir;
  try {
    canonicalDir = fs.realpathSync(dir);
  } catch {
    diagnostics.agents = { error: '会话目录不可用' };
    return fail('invalid-session-dir', sid);
  }
  if (path.basename(canonicalDir) !== sid) return fail('invalid-session-dir', sid);

  // 3. 正常路径：磁盘快照同步组合（buildSubagentTree + getCatalog 均自带容错，不抛）
  const tree = buildSubagentTree(dir, { sessionId: sid });
  if (!tree.ok) {
    // 会话目录不可用（不存在等）：失败态，不抛
    return {
      ok: false,
      reason: 'invalid-session-dir',
      sessionId: sid,
      agents: [],
      tasks: [],
      diagnostics: { agents: { error: tree.error || '会话目录不可用' }, tasks: null },
      capturedAt,
    };
  }

  // TaskCatalog rejection 不得逃逸：不受信 taskCatalog 实现或内部异常 -> 'catalog-error' 失败态
  let cat;
  try {
    cat = await taskCatalog.getCatalog({ sessionId: sid, sessionDir: dir });
  } catch {
    return {
      ok: false,
      reason: 'catalog-error',
      sessionId: sid,
      agents: [],
      tasks: [],
      diagnostics: { agents: tree.diagnostics, tasks: null },
      capturedAt,
    };
  }
  // M6 上限：投影响应条目上限——确定性截断（保留前 N 条），截断标记计入 diagnostics.truncated
  const agents = Array.isArray(tree.nodes) ? tree.nodes : [];
  const tasks = Array.isArray(cat && cat.entries) ? cat.entries : [];
  const agentsTruncated = agents.length > LIMITS.MAX_AGENTS;
  const tasksTruncated = tasks.length > LIMITS.MAX_TASKS;
  if (agentsTruncated) agents.length = LIMITS.MAX_AGENTS;
  if (tasksTruncated) tasks.length = LIMITS.MAX_TASKS;
  return {
    ok: true,
    sessionId: sid,
    agents,
    tasks,
    diagnostics: {
      agents: tree.diagnostics,
      tasks: (cat && cat.diagnostics) || {},
      truncated: { agents: agentsTruncated, tasks: tasksTruncated },
    },
    capturedAt,
  };
}

module.exports = { getWorkspaceProjection, LIMITS };
