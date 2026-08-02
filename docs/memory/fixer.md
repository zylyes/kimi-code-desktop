# Fixer 记忆（kimi-code-desktop）

## 测试夹具

- `tests/fixtures/`（2026-08-02 建立）含 11 个 fixture 供 Phase 1-6 测试消费：`usage/usage-record.jsonl`（12 有效 + 2 非法 JSON + 1 缺 usage 行，消费 test-usage-stats.js）、`usage/usage-updated-ws.json`、`tasks/task-events-ws.json`（消费 test-runtime-state.js/test-task-catalog.js）、`acp/tool-call-read.json`、`acp/tool-call-agent.json`（无 parent 字段，实测确认）、`cron/cron-tool-events.json`（synthetic，含 _fixtureNote）、`subagents/` 5 文件（wire-main.jsonl/wire-subagent.jsonl 各含 1 坏行 + append_loop_event 步骤事件；state-nested.json 3 层嵌套 / state-loop.json 循环 / state-orphan.json 缺父）；清单见 `tests/fixtures/manifest.json`。
- wire `usage.record` 的 `time` 字段为 epoch ms（wire.jsonl 统一范式，test-session-export.js 佐证），非 ISO 字符串；time 字段值域 > 1e12。
- ACP 工具事件工具：toolCallId 恒为 `{turn序号}:tool_{24位字母数字}`；流式 tool_call_update 只带 status/content（无 title），最终带 title 与完整 rawInput。

## Phase 1 状态层（2026-08-02 完成）

- 新增 `src/main/runtime-event-normalizer.js`（纯函数）、`src/main/runtime-state.js`（EventEmitter）、`src/main/task-catalog.js`；测试 `tests/test-runtime-state.js`、`tests/test-task-catalog.js`。均 CommonJS 纯 Node 无 electron，`node tests/test-*.js` 直跑。
- 关键口径：normalizeDiskTask 未知 status 值保守归 'completed'、status 缺失 → null；getUsageSnapshot 用全局桶（`sessionId || '__global__'`），无全局桶返回零值不回退；任务键 `${sessionId||''}:${taskId}`，taskId 缺失用 `unknown:${单调序号}`（每次事件独立键）；终态（completed/failed）墓碑不可复活；TaskCatalog 同键冲突 runtime 赢，磁盘 running 不覆盖 runtime 终态；'changed' 事件仅状态实际变化时 emit（at 更新不算变化）。
- 写异步测试（temp dir 清理）时不能在 `main()` 调用外用同步 finally 清理——async 未 await 会提前删目录导致扫描静默跳过。

## Phase 1c main.js 接线（2026-08-02 完成）

- main.js 已接入 runtimeState（`require('./runtime-event-normalizer')` + `require('./runtime-state')`，位于 usageState 声明处 ~74 行）；usageState 收敛为仅 `{ pendingApprovals, pendingQuestions }`，其余 5 字段由 `runtimeState.getUsageSnapshot()` 提供（托盘 updateTrayStatus / resetUsageState / WS handler 消费）。
- WS handler：usage_updated/task.started/task.progress/task.completed 四个分支改为 `runtimeState.apply(normalizeWsEvent(raw))` + scheduleTrayStatus；approval/question/session.deleted/model_catalog 分支保持本地计数逻辑不动。
- ACP handler：tool_call 与 tool_call_update 两分支在 sendAcpEvent 后追加 `runtimeState.apply(normalizeAcpToolCall(client.sessionId || null, update))`（client.sessionId 由 acp-client.js newSession/loadSession/resumeSession 置位）。
- TaskCatalog 未实例化（Phase 5 才接线）。验收：node --check 通过、14 个 test-*.js 全过。

## managed-usage 模块（2026-08-02 完成）

- 新增 `src/main/managed-usage.js` + `tests/test-managed-usage.js`（CommonJS 纯 Node 无 electron，fetch 注入式仿 cli-update）。契约：`fetchManagedUsage({fetchImpl, token, baseUrl, timeoutMs=8000, now})` → `{kind:'ok'|'unavailable'|'auth-required'|'error', plans, wallet, fetchedAt, staleAt}`（staleAt=fetchedAt+60s）；`loadOAuthToken({kimiCodeHome, fsImpl})` 读 `<home>/credentials/kimi-code.json` 的 access_token。
- 关键口径：无 token → unavailable 不发请求；401→auth-required（桌面端不刷新凭据）；404→unavailable；其他→error（消息脱敏：去 token/完整 baseUrl）。GET `{baseUrl}/usages`，AbortController 超时。
- 映射：payload.usage → plans[0] `{id:'weekly',label:'Weekly limit',used,limit,resetAt}`（resetAt 透传）；limits[] → `{id:'limit-'+i}`，label 由 window.duration+timeUnit 合成（5+'hour'→'5h limit'、7+'day'→'7d limit'、week→'Weekly limit'），detail 缺失/非对象跳过；数字为十进制字符串，parseDecimal 容错（非法/Infinity/NaN→0）。
- wallet：仅 `type==='BOOSTER'` 才映射；amount/amountLeft/monthlyUsed/monthlyChargeLimit 金额为 1e6 fixed-point → 分（/1e4 四舍五入）；monthlyChargeLimitEnabled!==true 时 monthlyLimitMinor=0；currency 缺省 'USD'。

## usage-stats 模块（2026-08-02 完成）

- 新增 `src/main/usage-stats.js` + `tests/test-usage-stats.js`（CommonJS 纯 Node 无 electron，流式 readline 逐行扫描）。契约：`UsageStats({sessionsRoot, now, cacheTtlMs=30000, readStreamImpl})` → `snapshot(range)`（TTL 内复用缓存扫描结果）/ `compute(range)`（强制重扫）/ `invalidate()`；快照 `{schemaVersion:1, range, summary, series, byModel, window:{startMs,endMs,timezone}, diagnostics:{scannedFiles,matchedRecords,badLines,sessionRecords,partial[,reason]}}`（reason 仅在 session-scope-only 场景出现；summary.partial 同理）。
- 关键口径：扫描路径 `sessionsRoot/<wdKey>/<sessionId>/agents/*/wire.jsonl`（stat 预检，无 wire.jsonl 的 agent 目录不计 scannedFiles）；**只聚合 `usageScope:"turn"` 的记录**，`usageScope:"session"` 的记录仅读取并计 diagnostics.sessionRecords、**不参与任何聚合**（真实数据验证：6 个真实 wire.jsonl，CLI 0.29.0 产生且含子代理 agent-0 目录，usage.record 行 turn=12 / session=0，真实 CLI 只写 turn scope；session 累计快照值为"截至 time 的历史累计"，无法按时间窗口分桶，会跨窗口高估）；窗口内 turnRecords===0 且 sessionRecords>0 时 summary.partial=true 且 diagnostics.reason='session-scope-only'，聚合值全零（不做差分/取代推断）；today 按本地小时 HH 补零到当前小时、7d/30d 按本地日期 YYYY-MM-DD 补零整窗口；summary.requests 按参与统计的记录条数计；model 缺失/空串 → 'unknown'；byModel 按码点序排序（不用 localeCompare，ICU 排序与码点序不同）；partial = 坏行>0 || 残缺记录>0 || 读取失败>0；time 为 epoch ms（>1e12），time<=0 的行跳过。
- 测试 8 组：fixture 全量（`tests/fixtures/usage/usage-record.jsonl` 12 有效 + 2 坏行 + 1 缺 usage）/ today 小时桶 / 7d·30d 日期桶 / turn 聚合·session 只计数·全 session partial+reason / 缓存 / diagnostics / byModel / 本地午夜边界；时间戳一律用 `new Date(y,m-1,d,h,min,s)` 本地构造保证跨时区稳定；每个测试独立 sessionsRoot。
- 经验教训：测试 helper 的解构默认值（`{model='kimi-code/k3'}`）会把"未传字段"填成默认值，构造"字段缺失"行须手写 JSON；`JSON.stringify` 会省略 undefined 字段（利用此点构造缺失字段行）。

## Phase 4 运行徽章（2026-08-02 完成）

- `RuntimeState.getActiveCounts(sessionId)` → `{ tasks, agents }`：running 快照中 agentType 非 null 计 agents、null 计 tasks；sessionId 过滤口径与 getActiveTaskCount 一致（`arguments.length === 0` 判不传=全部含 null 桶）。`src/main/runtime-state.js` ~120 行。
- main.js runtime-changed 广播（500ms 防抖不变）payload 扩展 `counts: { session, global }`：session=当前 acpClient.sessionId 口径（无活跃会话→null，渲染层视为全 0），global=全部。
- chat.html `.chat-statusbar` 内新增 `#taskRunningBadge`/`#agentRunningBadge` 两 span（默认 hidden），**零新增 CSS**——既有 `.chat-statusbar span` 与 `> span:not([hidden]) ~ span:not([hidden])::before` 相邻分隔符规则自动覆盖，无硬编码颜色。
- chat.js：`window.kimiChat.onRuntimeChanged` 订阅此前**从未接线**（preload API Phase 3a 冻结但渲染层未调用），本次在初始化处新建订阅；回调只读 `p.payload.counts.session`，tasks>0 → "N 个任务运行中"、agents>0 → "N 个子代理运行中"，0 → 隐藏；旧事件无 counts（兼容）→ 不动；onOpenSession 立即 hideRunningBadges()。文案 textContent 赋值不拼 HTML。

## Phase 5a 任务目录扩展（2026-08-02 完成）

- `normalizeAcpToolCall` 口径补全：放行 `title==='Task'`（Agent 内置后台任务工具）→ task.observed、agentType=null（getActiveCounts 计 tasks 不计 agents）；Read 等其余工具仍 null。
- 新增 `normalizeAcpCatalogEvent(sessionId, update)`：CronCreate/CronDelete → cron.observed（detail 只取 rawInput 白名单短字段 id/name/label/description/schedule、各截断 120，不含 command）；CronList → cron.observed（detail 为 rawOutput JSON 数组解析的列表项，解析失败回落 rawInput 摘要）；TaskOutput/TaskStop → tasktool.observed；其余工具（含 Task/Agent）→ null。status 映射同 Agent 路径（tool_call→running、in_progress→running、completed→completed、failed→failed，其余→null）。
- TaskCatalog 扩展（`src/main/task-catalog.js`）：`observe(event)`（cronEntries Map + tasktool 互证 Map）；**getCatalog 签名变化：返回 `{ entries, diagnostics }`**（原返回数组）；CatalogEntry = { id, key, kind:'task'|'cron'|'subagent', title, status, source, confidence, sessionId, taskId, updatedAt, at, detail? }；diagnostics 扩展 `{ scannedFiles, badFiles, badLines, cronFiles, badCronFiles }`（tasks 目录计前四项，cron 目录单独计 cronFiles/badCronFiles，互不影响）；`clearSession(sessionId)` 清该会话 cronEntries/tasktool 记录。
- **cron 观察键定位设计**：CronCreate/CronDelete 键优先取 detail 的 id/name（cron 真实身份，Create→List→Delete 生命周期闭环），toolCallId 兜底；CronList 逐项用 item.id||item.name upsert。ACP 降级口径：cronEntries confidence='low'（平面观察可见性有限），磁盘 cron='medium'；磁盘 cron 缺 schedule/description/enabled → detail.missing 标注（不算坏文件），status 缺省 'running'（计划文件存在即活跃）。tasktool.observed 仅刷新同键 runtime 条目 updatedAt（max），不新建不改状态。同键优先级 runtime > cronEntries > 磁盘；内存终态（completed/failed/removed）不可被 running 覆盖。
- main.js 接线：`taskCatalog = new TaskCatalog({ runtimeState, sessionsRoot: <同 usageStats> })`（~1923 行）；ACP tool_call/tool_call_update 两分支在 apply 后追加 `taskCatalog.observe(normalizeAcpCatalogEvent(...))`；IPC `chat:getTaskCatalog`（~2633 行，sessionId 字符串≤200 或 null，异常兜底 `{entries:[],diagnostics:{},error}`）。chat-preload.js `kimiChat.getTaskCatalog(sessionId)`（~119 行）。消费方核对：getCatalog 仅 test-task-catalog.js + main.js IPC 两处，无其他遗漏。

## Phase 6a 子代理树（2026-08-02 完成）

- 新增 `src/main/subagent-tree.js` + `tests/test-subagent-tree.js`（CommonJS 纯 Node 无 electron）。契约：`buildSubagentTree(sessionDir, { sessionId })` → `{ ok, sessionId, nodes, diagnostics }`；SubagentNode = { sessionId, turnId, agentId, parentAgentId, parentToolCallId, agentType, status, description, steps, updatedAt }；steps = { stepId, seq, kind:'step'|'tool', status, text, toolCallId, output }；diagnostics = { scannedAgents, badFiles, badLines, unknownParents }。
- 关键口径：父子关系唯一来源是会话根 state.json 的 agents 映射（`{id:{type:'main'|'sub',parentAgentId}}`，v2 中 main 无 parentAgentId 字段），无 state.json/损坏 → 目录枚举降级全顶层；父不存在或父链成环（含自环）→ parentAgentId='__unknown__'（unknownParents 计数）；agentType：main→'main'、子代理取父 wire Agent tool.call 的 args.subagent_type 否则 'coder'；启发式 parentToolCallId/description：父 wire Agent 调用中与子代理 firstTime 绝对差最小者（fixture 里 tool_agentA 差 2000ms vs tool_agentB 差 106000ms 区分两子代理）。
- status 推断（agent 级，确定性不依赖时钟）：无 step 条目→'unknown'；有未闭合 step→'running'；全闭合→最后一条 step 状态（finishReason interrupted→'interrupted' 截断态、failed/error→'failed'、tool_use/end_turn/未知→'completed'）。步骤构建：step.begin/end 按 `${turnId}:${step}` 配对、content.part 按 stepUuid 挂最近未闭合 step（think/text 累积，截断 200）、tool.call/result 按 toolCallId 配对（isError→failed，output 截断 500）；每 wire 步骤上限 200、loop 事件上限 5000。
- main.js 接线：`chat:getSubagentTree` IPC（chat:getTaskCatalog 后）——sessionId 白名单：必须在 session_index 登记（getAllSessions().find）+ sessionDir 在 `KIMI_CODE_HOME/sessions` 内（path.relative 校验，同 session:scanSubagents 口径），异常兜底 `{ok:false,message}`。chat-preload.js `kimiChat.getSubagentTree(sessionId)`（sessionId 封顶 200）。
- 验收：7 组用例 + 全量 18 个 test-*.js FAILURES:none；node --check 三个文件过。

## 执行注意

- 临时脚本放 `C:\Users\zyl\AppData\Local\Temp\opencode`（该目录 package.json 声明 type:module，CommonJS 脚本须用 .cjs 扩展名）。

## 经验教训

- **口径决策不得自行变更**：规格明确的口径（如"只聚合 turn 记录"）若觉得有更优实现（如"session 快照取代 turn"），必须先请示 orchestrator，不得擅自改口径——曾因擅自改为 session 快照取代逻辑导致错误（真实 CLI 只写 turn scope，session 累计值无法按时间窗口分桶）。
