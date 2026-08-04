# M4 Agents/Tasks 活动投影

> 来源：`WEB_SHELL_ENHANCEMENT_PLAN.original.md` §7 M4、§8.3/§8.4
> 归档日期：2026-08-03
> 状态：已完成（2026-08-04）
> 前置：M1（数据）/ M2（UI）
> 预计工作量：5–7 人日

## 任务

- [x] **M4-1** `workspace-projection.js`：对当前已验证会话返回 `{ agents: SubagentNode[], tasks: CatalogEntry[], diagnostics }`——`buildSubagentTree(sessionDir)` + 改造后的 task-catalog 适配层（接收已验证的具体 `sessionDir`，不依赖 `sessionsRoot` 全量扫描）；Agents 以已验证 `sessionDir` 磁盘快照为必需来源（§8.3）；无已验证会话目录 → 空态 + 原因
  - 涉及：`src/main/workspace-projection.js`（新，纯 Node）；`src/main/task-catalog.js`（改造或新增适配层）
  - 验收：单测：正常会话树结构正确；task-catalog 以具体 `sessionDir` 调用与 `sessions/<workDirKey>/<sessionId>` 两级目录布局对账一致（含 `sessionsRoot` 扫描不匹配场景）；目录缺失/坏文件诊断计数正确且不抛错
- [x] **M4-2** Agents 标签 UI：按 `SubagentNode` 渲染层级树（main 根 + 子代理分组、状态色、步骤摘要、`__unknown__` 分组）——信息架构借鉴参考项目 agents-tab，不复制其代码
  - 涉及：workspace.html/js
  - 验收：与现有 `agents.html` 监视器数据一致（同源同解析）；父子关系/状态/步骤与 wire.jsonl 对账
- [x] **M4-3** Tasks 标签 UI：`CatalogEntry` 列表（task/subagent/cron 三类、状态、来源 badge ws/disk、置信度；ACP 观察仅作低置信附加 badge，不启动 ACP、不影响出口标准）
  - 涉及：workspace.html/js
  - 验收：与 `scripts/mock-kimi-server.js` 场景（task.started/progress/completed）联测正确；cron 条目展示（若 M1 探测到 cron 数据源）
- [x] **M4-4** 活动增量：WS 事件经现有 `runtimeState.apply()` 后，主进程按 1s 防抖向面板推 `workspace:event({ kind:'activity', sessionId })`，面板仅重取投影快照——不做消息级 reducer/增量合帧；Agents 实时跟随仅在 M1 实测发现官方 Web WS 子代理事件并扩展 normalizer 后生效（§8.3），否则维持磁盘快照口径
  - 涉及：main.js 接线
  - 验收：面板数据 ≤1.5s 跟随活动变化（Tasks 以 `task.*` 为准）；无事件风暴（防抖断言）
- [x] **M4-5** 历史快照：会话切换/刷新时首次加载读 sessionDir 下 `state.json`、`tasks/*.json` 等构成一次性磁盘快照（只读，非 replay 运行时）；Agents 以磁盘快照为准、Tasks 以磁盘快照 + 现有 WS `task.*` 为准，不追求完整历史实时重建
  - 涉及：workspace-projection.js
  - 验收：恢复历史会话后面板显示该会话已有 Agents/Tasks 记录（快照口径，标注采集时刻）

## M4 出口

- [x] `tests/test-workspace-projection.js` 通过（含 task-catalog 适配对账用例）
- [x] mock + 真实会话双路径手测通过
- [x] **候选发布门 2**

## 执行日志

日期 | 已完成 | 下一步 | 备注/阻塞
--- | --- | --- | ---
2026-08-04 | M4-1 至 M4-5：只读 Agents/Tasks 投影、WS/ACP 活动防抖、历史磁盘快照与四标签 UI | M5 Web 主导整合边界 | 全量 22 份 `tests/test-*.js`、M4 UI 自检 50/50、真实 Electron IPC 探针均通过；Oracle 终局门禁通过。已加固 sessionDir 三态、链接/agentId 路径逃逸、可见运行时字段刷新契约。真实 WS/ACP 活动注入端到端自动化留作 M6 回归风险。
