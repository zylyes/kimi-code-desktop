# M1 能力审计与外壳契约

> 来源：`WEB_SHELL_ENHANCEMENT_PLAN.original.md` §7 M1
> 归档日期：2026-08-03
> 状态：**已完成**（2026-08-03）
> 前置：无（全局前置）
> 交付物：`docs/web-shell-capability-audit.md`（能力矩阵 + 决策表 + 待实测项）

## 任务

- [x] **M1-1** 抓取并登记 `/openapi.json` 全量 paths，与 `detectServerCaps` 白名单对比
  - 实测：76 端点（CLI 0.31.1）；archive ✅ 命中、models ✅ 命中、**delete ❌ 未命中**（无 `:delete` 动词、无 DELETE 方法——detectServerCaps 的 delete=false 与实测一致，无需修正）；`scripts/capability-audit.js` 新建（170 行，exit 0）
- [x] **M1-2** 抓取 `/asyncapi.json`
  - 实测：**存在（HTTP 200）**。channel `kimiCodeWebSocket`；32 条消息；**发现 `subscribe_v2`/`unsubscribe_v2`/`watch_fs_add`/`watch_fs_remove`/`resync_required`**（桌面当前用 v1 subscribe，未用 v2/fs 监视）；业务事件统一封装 `session_event`
- [x] **M1-3** 扩展 `scripts/ws-event-probe.js` 实测 WS 事件并与 normalizer 白名单对比
  - 实测：28 种事件普查（exit 0，审批/问答 PASS）。**子代理事件存在：`subagent.spawned`（含 parentAgentId/subagentName/runInBackground）/`subagent.started`/`agent.created`/`agent.status.updated`（54 次含 usage）——§8.3 条件启用前提已满足**；⚠️ `task.started` payload 为 `{agentId, info, sessionId}`（task_id 不在顶层，normalizer 取值路径需修）；⚠️ `session.usage_updated` 全程未触发（用量走 `agent.status.updated`）；审批新旧双流并存（`event.approval.*` + `permission.approval.*`）；subagent 终止态未观察到（列入待实测）
- [x] **M1-4** 产出 `docs/web-shell-capability-audit.md`
  - 已入库：REST 能力矩阵（9 类 76 端点）+ AsyncAPI 结论 + WS 普查 + M3/M4/M5 选型决策表 + 待实测项
- [x] **M1-5** 确认会话/工作目录切换可探测途径
  - 实测（`scripts/nav-probe.js`，Electron，exit 0）：**会话 URL 形态 `/sessions/<sessionId>`（pathname 携带完整 sessionId，高置信 ✅）**；`did-navigate-in-page` 可捕获 SPA 路由；web UI 消费 token 后清空 hash、首页自动恢复最近活跃会话；页面无 `<a href>` 会话链接（感知只能靠导航事件）；**URL 不含 workDir**——需经 sessionId 双向核对（REST 详情/本地索引）后才可授权 Files/Git；`session_index.jsonl` 初判低置信（三字段无时间戳、最近条目为 ACP 临时会话，仅候选展示）

## M1 出口

- [x] 能力矩阵 + 审计文档入库（`docs/web-shell-capability-audit.md`）
- [x] 能力登记结论：**维持现状，不扩展 serverCaps、不新建 capability-registry**——detectServerCaps 三项与 0.31.1 实测一致（delete=false 为正确结论）；M3/M4 数据源决策（本地 git / file-browser 白名单 / WS+磁盘+REST 对账）不依赖运行时能力登记。无新增登记代码，无需新单测

## 关键实测结论（影响后续阶段）

1. **M3**：无服务端 diff API → Changes 必走本地 git；fs:* REST 语义未证实 → Files 走 file-browser 白名单
2. **M4**：Agents 启用 WS 实时流（扩展 normalizer 支持 `subagent.*`/`agent.*`；终止态事件需长任务补测）；Tasks 注意 task.* payload 字段差异需修 normalizer 取值路径
3. **M2**：会话上下文服务以 `did-navigate-in-page`（高置信）+ WS + 本地索引（低置信仅候选）三源；URL 不含 workDir 需双向核对
4. **跨计划待办**：`session.usage_updated` 在 0.31.1 未触发，托盘/用量面板现行依赖需复核 `agent.status.updated` 替代方案（影响面超本计划）

## 执行日志

日期 | 已完成 | 下一步 | 备注/阻塞
--- | --- | --- | ---
2026-08-03 | M1-1~M1-5 全部完成；探测实例（端口 58997，CLI 0.31.1）实测三脚本均 exit 0；审计文档入库 | M2 主窗口 Workspace 面板组合 | 测试会话 session_d98864c1（ws-probe）与 session_ab5319fc（nav-probe）保留磁盘可手动归档；额度消耗 3 个短提示词
