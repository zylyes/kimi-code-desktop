# 用量、状态与任务可观测性实施计划

日期：2026-08-02
状态：进行中（Phase 0 已完成）
来源：用户要求参考 `D:\code\kimi-code-desktop-master`，为当前 Electron 项目制定实施计划

## 目标

- `/usage` 与 `/status` 在 ACP 原生聊天页 Composer 上方即时呈现：
  - 当前上下文窗口
  - Token 明细
  - 平台额度
  - 今日 / 7 天 / 30 天本地用量趋势
- 状态条实时显示 `[N task running]`，口径与 CLI 一致。
- Tasks 面板只读展示后台任务与 Cron 调度。
- 子代理步骤支持任意层级嵌套；子代理派生的子代理拥有独立可折叠视图。

## 关键结论

- 不直接搬参考项目的 React/Tauri/Rust 代码。
- 不向本地 Kimi Web UI 注入 Composer 面板，避免绑定上游私有 DOM。
- 新能力先落在 `chat.html/chat.js` 的 ACP 原生聊天页；Web UI 保留现有成熟入口。
- `wire.jsonl` 只作为可降级观察源；平台额度、ACP/WS 事件、磁盘任务文件分层合并。
- 当前 `runningTasks++/--` 模型需替换为按任务快照集合派生活动数。

## 当前基础

- WS 已接收 `session.usage_updated`、`task.started/progress/completed` 并更新托盘：`src/main/main.js:1536`, `src/main/main.js:1562`, `src/main/main.js:1576`, `src/main/main.js:1637`
- 托盘状态摘要：`src/main/main.js:2944`
- ACP 聊天页已有 Composer、slash 菜单、底部状态栏：`src/pages/chat.html:772`, `src/pages/chat.html:792`, `src/pages/chat.js:895`
- 本地会话/子 Agent/任务文件只读扫描：`src/main/session-export.js:135`, `src/main/main.js:5119`
- ACP 事件当前只处理有限 `sessionUpdate`，未知类型会丢弃：`src/main/main.js:2363`

## 参考项目可复用方向

- 本地 `/usage`、`/status` 不写聊天消息：`D:\code\kimi-code-desktop-master\src\hooks\useSessionStream.ts:114`
- Composer 上方命令结果面板：`D:\code\kimi-code-desktop-master\src\modules\composer\command-result-panel.tsx:23`
- 平台额度解析：`D:\code\kimi-code-desktop-master\src\lib\managed-usage.ts:219`
- 今日 / 7 天 / 30 天趋势：`D:\code\kimi-code-desktop-master\src\lib\usage-stats.ts:5`
- `[N task running]` 从活动任务集合派生：`D:\code\kimi-code-desktop-master\src\modules\statusbar\status-strip.tsx:88`
- Tasks/Cron 只读缓存：`D:\code\kimi-code-desktop-master\src\modules\workspace\tasks-tab.tsx:56`
- 递归子代理步骤：`D:\code\kimi-code-desktop-master\src\modules\conversation\subagent-steps.tsx:34`

不可直接移植：TSX/React/Zustand/Tailwind、Rust scanner、Tauri IPC、`managed_usage.rs` 的凭据刷新策略。

## 阶段计划

### Phase 0：协议探测与契约冻结 ✅（2026-08-02 完成）

- [x] 扩展 ACP probe，只记录脱敏后的 method、`sessionUpdate`、ID/父 ID、任务/Cron/子代理字段，不记录正文。→ `scripts/acp-event-probe.js`（602 行，纯 Node，JSONL 输出 + 递归脱敏 + `KIMI_ACP_PROBE_OUT` 双写 + 结束摘要）
- [x] 固化测试 fixture：usage 快照 / `usage.record`、task started/progress/completed、CronCreate/CronList/TaskOutput、子代理与嵌套子代理事件（若存在）。→ `tests/fixtures/` 9 文件（manifest + 8 项），校验通过；嵌套子代理事件经实测确认**不存在**，未固化（见验收结论）；Cron 工具未实测到，按 synthetic 标注固化
- [x] 明确最低支持 CLI 版本。→ 决策：**维持 0.28+ 不变**（`main.js:602` 现有检查不动）；全部协议事实的验证基线为 CLI 0.29.0（4 轮探针实测 + `docs/acp-research.md`）；新功能不依赖 0.29 独有协议能力（WS 事件与 CLI 版本无关，ACP `tool_call` 为基础协议，磁盘扫描格式两版本一致）；0.28 上 `tool_call` 细节形态未实测，若用户报告异常再收紧

验收：确认 ACP 是否支持任意层级子代理实时事件；若不支持，降级为“磁盘扫描 + 平面工具调用观察”，不承诺实时任意层级。

**验收结论（CLI 0.29.0 实测，4 轮探测）：不支持。** 子代理在 ACP 实时流中的唯一可见形态是平面 `tool_call`（`title="Agent"`、`rawInput.subagent_type`、toolCallId 形如 `{turn}:tool_{24位}`）；子代理运行期间**无任何内部步骤事件、无任何 parentId/parentToolCallId 字段**（确证轮中子代理真实派生并运行约 60s，668 条消息零 parent 字段）。Cron 类事件全程未出现。→ Phase 6 按降级路径执行。

### Phase 1：主进程规范化状态层 ✅（2026-08-02 完成）

- [x] 新增 `src/main/runtime-event-normalizer.js`（139 行，纯函数三 normalize 入口）
- [x] 新增 `src/main/runtime-state.js`（约 165 行，RuntimeState/EventEmitter）
- [x] 新增 `src/main/task-catalog.js`（约 98 行基础版，runtime 优先 + 磁盘 tasks 合并 + diagnostics）
- [x] WS、ACP、磁盘扫描统一转成内部事件。（WS 四分支 + ACP tool_call/tool_call_update 两分支接入 main.js；磁盘经 normalizeDiskTask 入 catalog）
- [x] 用 `Map<sessionId:taskId, TaskSnapshot>` 派生活动任务数。（终态 tombstone 不复活；`unknown:` 合成键）
- [x] 用 `Map<sessionId, SessionUsageSnapshot>` 替代全局最后一次覆盖。（`__global__` 桶 + per-session 桶互不覆盖）
- [x] 托盘改为消费 runtime snapshot。（`updateTrayStatus` 读 `getUsageSnapshot()`；usageState 收敛为 pendingApprovals/pendingQuestions，25→9 引用点无遗漏）

验收：重复 started、重复 completed、乱序、重连不跳数 ✅（test-runtime-state.js 13 节覆盖幂等/tombstone/多会话隔离/usage 分桶/changed 语义）；多会话计数口径明确 ✅；托盘现有行为不回归（文案/格式原样保留，数据源平移，经引用点对照确认；最终待集成验收 `npm run mock` + `npm run dev` 确认）。

回退点：恢复原 `usageState` 分支。

### Phase 2：用量与额度数据层 ✅（2026-08-02 完成）

- [x] 新增 `src/main/usage-stats.js`（224 行；流式 readline 扫描 `sessions/<wdKey>/<sessionId>/agents/*/wire.jsonl` 中 `usage.record` 行；TTL 缓存 30s + mtime 预筛；接口 `snapshot(range)`）
- [x] 新增 `src/main/managed-usage.js`（201 行；fetch 注入式仿 cli-update.js；401→auth-required / 404→unavailable；脱敏错误消息）
- [x] 新增 `src/main/local-command-service.js`（126 行；全依赖注入；trim 全等匹配，带参形式 not-local-command 放行；allSettled 并行 + 部分降级 errors；signal 中止）
- [x] `usage.record` 流式逐行扫描，坏行跳过。（badLines 分类计数；半写入尾行容忍）
- [x] Today 按小时，7/30 天按本地日期。（本地时区分桶补零；真实数据验证：6 个真实 wire.jsonl 样本 turn=12/session=0/bad=0，CLI 0.29.0 仅写 turn scope）
- [x] `usageScope: "turn"` 与 `"session"` 去重。（只聚合 turn；session 只计 sessionRecords 不聚合，防累计快照错计；全 session 场景 partial+reason='session-scope-only'——修正过 fixer 擅自"session 快照取代"错误口径）
- [x] 网络请求走 Electron `net.fetch`。（managed-usage 注入式设计就绪，fetchImpl 由 main.js 装配时注入 net.fetch；接线随 Phase 3 IPC 一起完成并验证）
- [x] 不把 token、凭据、原始平台响应发送到渲染层。（token 闭包绑定于 fetchManagedUsageImpl，服务层/渲染层不可见；managed 快照已脱敏；错误消息去 token/URL）
- [x] 第一阶段凭据过期只返回 `auth-required`，不在桌面端刷新凭据。

建议契约：

```js
UsageStatsSnapshot = {
  schemaVersion: 1,
  range: "today" | "7d" | "30d",
  summary,
  series,
  byModel,
  window: { startMs, endMs, timezone },
  diagnostics: { scannedFiles, matchedRecords, badLines, partial }
}
```

```js
ManagedUsageSnapshot = {
  kind: "ok" | "unavailable" | "auth-required" | "error",
  plans: [{ id, label, used, limit, resetAt }],
  wallet: null | { currency, balanceMinor, monthlyUsedMinor, monthlyLimitMinor },
  fetchedAt,
  staleAt
}
```

验收：时区边界、坏行、半写入尾行、缓存失效；无凭据、401、超时、平台返回缺字段。

### Phase 3：`/usage` 与 `/status` Composer 上方即时结果 ✅（2026-08-02 完成）

- [x] `src/preload/chat-preload.js` 增加 `runLocalCommand(command)` 与 runtime 快照/事件订阅。（`chat-preload.js:100-115` kimiChat namespace；`onRuntimeChanged` 复用 `acp-chat:event` 通道过滤 `type==='runtime-changed'`；main.js:1918-1969 装配 LocalCommandService + managed 60s 缓存 + `getStatusContext` 八字段 + 500ms 防抖广播；IPC `chat:runLocalCommand` main.js:2613-2623）
- [x] `src/pages/chat.js` 在 `send()` 前精确拦截 `/usage`、`/status`。（`chat.js:1390-1399` trim 全等、大小写敏感；新增 `currentSessionId` 持有）
- [x] `/usage foo` 不按本地命令处理。（全等判断天然放行原流程；服务层 `not-local-command` 双保险）
- [x] `src/pages/chat.html` 在 `.composer` 上方增加命令结果面板宿主。（`chat.html:963-970` + 样式 `699-888`：材质跟随 composer 卡片、单色进度条 ≥90% 转 error 色、纯 CSS 趋势条形图、全 `var(--*)`）
- [x] 面板支持 loading / result / error / stale / Escape 关闭 / 新请求取代旧请求。（请求序号丢弃旧结果；Escape 经 `defaultPrevented` 避让 slash 菜单；error 态带重试；`managed.staleAt` 过期标注；会话切换关闭并作废旧序号）

展示：

- `/usage`：上下文窗口、Token 明细、平台额度、今日/7天/30天趋势。
- `/status`：版本、模型、目录、权限模式、会话状态、当前上下文与平台额度摘要。

验收：命令不进入聊天记录 ✅；loading 可被取消或被新请求替换 ✅（序号取代）；平台额度失败时仍显示本地用量与明确降级原因 ✅（managed 四态分级渲染：auth-required 引导 `kimi login` / unavailable / error 脱敏 message）；Escape 关闭，不影响 slash 菜单既有按键逻辑 ✅（input keydown 零改动 + document 级避让，8 组桩 DOM 契约场景断言全过）。备注：`onRuntimeChanged` 轻量刷新放弃（契约无局部查询通道）；plans used/limit 单位未明确保持原始数字展示；文案经复核去术语化 3 处。

### Phase 4：状态条 `[N task running]` ✅（2026-08-02 完成）

- [x] `src/pages/chat.html` 底部 `.chat-statusbar` 增加任务状态 span。（`chat.html:996-997` 双 span `#taskRunningBadge`/`#agentRunningBadge` 默认 hidden；零新增 CSS，既有状态条规则自动覆盖）
- [x] 从 runtime snapshot 派生活动任务数，不手工计数。（`runtime-state.js:120-133` `getActiveCounts` 按 agentType 拆 tasks/agents；main.js:1962-1973 广播 payload 并入 `counts.session/global`；chat.js:1178-1195 只读 `counts.session` 更新徽章）
- [x] ACP 聊天状态条显示当前会话活动任务数；托盘显示全部会话活动任务数。（状态条=`counts.session` 当前 ACP 会话口径；托盘=Phase 1 全局合计，未改）

验收：重连、回放、重复事件不跳数 ✅（state 幂等/tombstone 测试）；任务终态归零 ✅（终态不计活动 + tombstone 不复活）；多会话不会把别的会话任务误报进当前会话 ✅（`getActiveCounts(sessionId)` 隔离 + 测试 14 组）。备注：按 CLI 双徽章口径细化"N 个任务运行中"/"N 个子代理运行中"（librarian.md:36）；WS task 事件 sessionId=null 进全局桶仅体现于托盘合计；chat.js 首次消费 `onRuntimeChanged`。

### Phase 5：Tasks 面板只读后台任务与 Cron ✅（2026-08-02 完成）

- [x] `src/main/task-catalog.js` 合并结构化 WS/ACP 事件、`tasks/*.json`、Task/TaskOutput/CronCreate/CronList 工具输出观察。（task-catalog 重写：CatalogEntry 契约 + `observe()` cron Map + 磁盘 `cron/` 扫描 + `clearSession`；normalizer 放行 `Task` 工具（Phase 1 口径补全，agentType=null 计 tasks 类）+ 新增 `normalizeAcpCatalogEvent`；cron 键 detail.id/name 优先 toolCallId 兜底保证 Create/List/Delete 闭环）
- [x] ACP 聊天页增加 Tasks 抽屉或 tab，不新开长期轮询窗口。（右侧卡片浮层抽屉 320px，沿用 cmd-panel 材质体系；打开拉一次 + `onRuntimeChanged` 1s 防抖（仅打开态）；零 setInterval；Escape 优先级 slash>抽屉>cmd-panel）
- [x] 每项明确 `source` 与 `confidence`。（来源标注：实时同步/会话事件/本地文件；置信度：参考(medium)/粗略(low)，high 不显示；cron.observed='low' 平面观察不虚构状态）
- [x] 终态不可被旧 running 观察覆盖。（runtime > observe > disk 优先级 + 终态 tombstone 不复活，测试覆盖）

验收：后台任务和 Cron 只读展示 ✅（纯视图零操作按钮）；损坏任务文件跳过并计入 diagnostics ✅（badFiles/badCronFiles/badLines 计数 + UI 摘要"N 个损坏文件已跳过"诚实分支）；Cron 缺字段降级显示 ✅（detail.missing 字段标注）；删除/过期/会话切换清理正确 ✅（removed 状态 + onOpenSession 清理 + `clearSession`）。备注：分组互斥（cron 含 running 归「Cron 调度」组，其 running 语义为"计划存活"）；Task 工具 tool_call completed 可能只是派生完成非后台终态（ACP 可见性限制，如实标注不虚构）；极端窄窗抽屉覆盖 cmd-panel 右缘属可接受（浮层不阻塞操作）。

### Phase 6：任意层级子代理步骤树 ✅（2026-08-02 完成，降级路径）

前置：~~Phase 0 已证实存在实时嵌套子代理事件源。~~ **Phase 0 实测结论（2026-08-02，CLI 0.29.0）：不存在实时嵌套子代理事件源**，本阶段按降级路径执行——实时层只消费平面 `tool_call`（`title="Agent"` + `rawInput.subagent_type` 识别子代理边界），层级与步骤明细来自磁盘扫描（`agents/*/wire.jsonl`）按需补绘，不承诺实时任意层级。

- [x] 使用扁平实体契约，不直接传递归更新（落地 `src/main/subagent-tree.js` 309 行，`buildSubagentTree` 返回 `{ok, sessionId, nodes, diagnostics}`；parentAgentId 真值取自会话根 state.json `agents` 映射；步骤由 `context.append_loop_event` 精确配对构建）：

```js
SubagentNode = {
  sessionId,
  turnId,
  agentId,
  parentAgentId: null | string,
  parentToolCallId: null | string,
  agentType,
  status,
  description,
  steps: [{ stepId, seq, kind, status, text, toolCallId, output }],
  updatedAt
}
```

- [x] UI 按 `parentAgentId` 建树。（Agent 工具卡片内联展开，`.sg-children` 逐级递归；未命中回退会话全树视图）
- [x] 每层独立折叠。（`agentFoldMemory` 手动记忆优先，重拉保留，会话切换清空）
- [x] 运行中默认展开，完成后保留预览。（running 默认展开；完成默认收起 + 尾部回溯 72 字符最新步骤预览）
- [x] 深度、节点数、文本长度设上限；循环父链进入“未知关系”组。（maxDepth=6/maxNodes=50/maxText=500/步骤 200/loop 事件 5000；循环与缺父 → `__unknown__` 归组带计数）

验收：至少 3 层嵌套 ✅（fixture main→agent-0→agent-00 三层链 + UI 递归渲染 53 项桩 DOM 断言）；乱序 parent、重复 step、缺父节点、重连恢复 ✅（数据层 7 组测试：乱序归并/step 配对/缺父与互环自环 `__unknown__`）；历史恢复与实时渲染一致 ✅（同一磁盘 wire 数据源 + runtime-changed 1s 防抖重拉）；每层折叠状态独立 ✅。降级路径补充：截断 wire（末事件 llm.request 无 step.end）→ `interrupted` 诚实标注 ✅；`parentToolCallId` 启发式（父 wire Agent 调用按 time 序匹配）✅；status 五态（running/completed/failed/interrupted/unknown）不虚构 ✅。

## 测试门禁

每阶段至少执行：

- [x] `node tests/test-session-export.js`
- [x] `node tests/test-acp-client.js`
- [x] `node tests/test-acp-elicitation.js`

新增 focused tests：

- [x] `tests/test-runtime-state.js`（16 节）
- [x] `tests/test-usage-stats.js`（8 组）
- [x] `tests/test-managed-usage.js`（8 组）
- [x] `tests/test-local-command-service.js`（11 组）
- [x] `tests/test-task-catalog.js`（11 组）
- [x] `tests/test-subagent-tree.js`（7 组）

集成验收：

- [ ] `npm run mock` + `npm run dev`（手工验收，待用户执行——验收清单见执行日志末条）
- [ ] 真实 `kimi web` WS 事件回归（手工验收，待用户执行）
- [ ] 真实 `kimi acp` 会话回归（手工验收，待用户执行）
- [x] 打包前 `npm run pack`（首跑失败于环境 TLS 证书校验，非代码缺陷；`NODE_OPTIONS=--use-system-ca` 重试成功：`release\win-unpacked` 全新生成 + signtool 签名，退出码 0）

## 风险与约束

- ACP 嵌套子代理事件不存在或字段不稳定：先探测，后承诺。
- 平台额度接口与凭据刷新风险：第一阶段只读，不做凭据写回。
- `wire.jsonl` 非稳定契约：只能作为 partial 观察源。
- 全量 30 天扫描阻塞主线程：使用流式扫描、缓存，必要时 Worker Thread。
- 双 UI 轨道范围失控：新能力只落 ACP 原生聊天页，Web UI 不做同功能注入。

## 执行日志

- 2026-08-02：完成调研、架构调和与计划归档；尚未开始代码实施。
- 2026-08-02 | 已完成：Phase 0 全部（`scripts/acp-event-probe.js` 脱敏探针 + 4 轮 CLI 0.29.0 实测；`tests/fixtures/` 9 文件校验通过；最低版本决策维持 0.28+；测试门禁 test-session-export/test-acp-client/test-acp-elicitation 全过） | 下一阶段：Phase 1 主进程规范化状态层 | 备注：ACP 无实时嵌套子代理事件（确证），Phase 6 降级为"平面 Agent tool_call + 磁盘扫描补绘"；usage.record `time` 按 epoch ms 固化（wire 行范式推断，若实测为 ISO 需回改 fixture）；流式 `tool_call_update` 中间片段不含 title，解析器需容忍
- 2026-08-02 | 已完成：Phase 1 全部（三模块 + main.js 手术，usageState 引用 25→9 处；14 测试文件无回归）；Phase 2 全部（usage-stats/managed-usage/local-command-service + 27 组新用例；session 去重口径经 6 真实样本 turn=12/session=0 裁决修正）；全量 17 测试文件 FAILURES:none | 下一阶段：Phase 3 `/usage` 与 `/status` Composer 上方即时结果 | 备注：usage-stats 接口名 `snapshot(range)`；真实 wire（探针会话）无 `context_size.measured`/`agent.status.updated`/`turn.step.completed` 记录，contextWindow 走 session→global-ws→null 降级并在契约带 `source` 标注；CLI 状态条实为 `[N task running]`+`[N agent running]` 双徽章（librarian.md:36），Phase 4 按 agentType 字段区分
- 2026-08-02 | 已完成：Phase 3 全部（main.js IPC 装配 + preload 桥接 + 命令结果面板 + send() 拦截；17/17 无回归 + 8 组桩 DOM 契约场景） | 下一阶段：Phase 4 状态条 `[N task running]` | 备注：UsageStatsSnapshot 实际形状以 usage-stats.js 冻结实现为准（summary.requests/inputOther/output/inputCacheRead/inputCacheCreation/totalTokens、series.key='HH'|'YYYY-MM-DD'、byModel 数组）；文案复核修正 3 处（"最近 WS 快照"→"最近同步快照"等去术语化）
- 2026-08-02 | 已完成：Phase 4 全部（`getActiveCounts` 双类拆分 + runtime-changed counts 广播 + 状态条双徽章；17/17 无回归） | 下一阶段：Phase 5 Tasks 面板只读后台任务与 Cron | 备注：chat.js 首次消费 `onRuntimeChanged`；`counts.global` 已下发未消费留 Phase 5+；**口径补全**：Phase 1 normalizer 只放行 Agent 工具，ACP `Task` 工具（CLI `[N task running]` 的真正来源）被丢弃，Phase 5 一并修正放行（agentType=null → tasks 类）
- 2026-08-02 | 已完成：Phase 5 全部（task-catalog 扩展重写 + Tasks 只读抽屉；17/17 无回归 + 20 项契约自检断言） | 下一阶段：Phase 6 子代理观察（降级路径：平面 Agent tool_call + 磁盘扫描补绘） | 备注：des-2 文案复核全部合格零修改；main.js 侧 `taskCatalog.clearSession` 接线随 Phase 6 前补齐（disposeAcpClient 处）
- 2026-08-02 | 已完成：Phase 6 全部（subagent-tree.js 309 行 + 7 组测试 + Agent 卡片步骤树 UI 53 项断言；clearSession 已接线 disposeAcpClient）；**全计划 Phase 0-6 完成**；门禁三项 + 18 测试文件全过 | 下一阶段：集成验收收尾 | 备注：`npm run pack` 首跑失败于环境 TLS 证书校验（electron-builder 下载资源，got `unable to verify the first certificate`），非代码缺陷；`NODE_OPTIONS=--use-system-ca` 重试成功（win-unpacked 全新生成 + signtool 签名，退出码 0）；手工验收清单：① `npm run mock` + `npm run dev` 打开 ACP 聊天页发 `/usage`、`/status` 看面板；② 真实 kimi web 会话观察托盘与状态条双徽章；③ 真实 kimi acp 会话派生子代理观察步骤树与 Tasks 抽屉
