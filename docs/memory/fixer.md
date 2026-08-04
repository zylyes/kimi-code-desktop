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

## M2-2 会话上下文服务（2026-08-03 完成）

- 新增 `src/main/session-workspace.js` + `tests/test-session-workspace.js`（CommonJS 纯 Node 无 electron，纯函数无 fs/网络副作用）。契约：`isValidSessionId(s)`（非空、≤128、仅 `[A-Za-z0-9_-]`）；`parseSessionIdFromUrl(url)`（仅 http/https，pathname 匹配 `/^\/sessions\/([^/]+)\/?$/`，decodeURIComponent 后过校验，查询串/hash 不影响）；`resolveBySessionId(sessionId, indexEntries)`（非法 id→`{status:'unknown',sessionId:null}`，命中→verified 透传 workDir/sessionDir，entries 非数组按空数组）；`listCandidates(indexEntries,{limit=20})`（过滤 isValid+workDir 非空、去重保留最后出现、倒序、截断，`{sessionId,workDir,sessionDir,source:'index'}`）；`resolveContext({url,indexEntries,explicitSessionId})`（explicit>url，verified→bound/high/explicit|navigate，否则有候选 candidates/low 无候选 unbound/low，updatedAt=Date.now()）。
- 安全边界（M1 实测）：本地索引 `~/.kimi-code/session_index.jsonl` 低置信（无时间戳/来源标记），仅候选不授权读取；索引条目由 main.js 注入，模块内不读文件。sessionId 形态 `session_`+uuid。main.js 尚未接线（M2-2 只交付模块+测试，验收：node --check + 全绿）。

## M2 工作区面板 main.js 接线（2026-08-03 完成）

- 改动 `src/main/main.js`（require session-workspace 于 ~23 行；loadConfig 加 workspacePanelEnabled/workspacePanelCollapsed 默认 false；面板区在 foregroundContents 后 ~1813-1925；showOverlay/closeOverlay 加暂隐/恢复钩子；closed/resize/did-navigate-in-page 扩展；视图菜单加 checkbox 入口；IPC 区加 workspace:getContext/panelState/selectCandidate），新建 `src/preload/workspace-preload.js`（contextBridge 暴露 window.workspace，仅 getContext/getPanelState/setPanelState/selectCandidate/onEvent 五个 API）。
- 关键口径：z-order overlay > Workspace > 主内容，overlay 显示时面板 removeChildView 暂隐（不销毁），closeOverlay 恢复 addChildView+layoutWorkspaceView；面板 bounds `{x:w-360, y:36, w:360, h:h-36}`（WORKSPACE_TOP_OFFSET=36=窗控 32+4 间隙）；workspace:* IPC 一律校验 `e.sender === workspaceView.webContents`（isWorkspaceSender）；selectCandidate 仅 `sw.resolveBySessionId(...).status==='verified'` 才置 workspaceExplicitSessionId 并 push `workspace:event {kind:'context'}`；did-navigate-in-page 里 sessionId 变化才推送（workspaceLastNavSessionId 比对）；折叠态持久化仅发生在 toggleWorkspacePanel（写 config.json workspacePanelCollapsed）。
- 约定：`src/pages/workspace.html` 与 workspace 页面渲染逻辑属另一车道（本车道仅 loadFile 挂载，文件尚不存在时运行时加载报错属预期，等并行车道交付）。

## file-browser 模块（2026-08-03 完成，08-04 Oracle 修复）

- 新增 `src/main/file-browser.js` + `tests/test-file-browser.js`（CommonJS 纯 Node 无 electron，fs.promises 异步）。契约：`LIMITS = { FILE_MAX_BYTES: 1MB, LIST_MAX_ENTRIES: 500 }`；`listDir(root, relPath='', {skipNames})` → `{ok:true, entries:[{path,name,type:'dir'|'file',size,mtime(ms)}], truncated}`；`readFilePreview(root, relPath)` → `{ok:true, content, truncated, size}`。
- 关键口径：目录在前、组内 name localeCompare(sensitivity:'base')；默认跳过 `.git`/`node_modules` 且**恒不可绕过**（skipNames 仅追加额外排除名，08-04 Oracle 复审后收紧；skipNames 缺失=默认，存在时须字符串数组且元素为非空 basename（无 `/`、`\\`、NUL），opts 非普通对象或 skipNames 非法 → `{ok:false,reason:'bad-arg'}` 不抛异常）；**opendir 流式读取**，收集满 LIMITS+1 个未跳过候选即停止（不 readdir 全量/不全量 lstat），truncated=true 后截断；大文件截读前 1MB（**fs.readFile 的 {length} 仅 fd 形式生效，须 open+read 按长度截读**）；size 返回完整字节数；前 8KB 含 NUL → `binary-file`；UTF-8 + strip BOM。
- 安全（Oracle 审查后收紧）：root 先 realpath 规范化；containment 用 `path.relative`（win32 内置大小写不敏感）；**排除规则对任何 list/read 目标做 lexical 路径段检查 + canonical（realpath）二次检查**（防 git-link→root/.git 别名与 check-to-use 竞态），大小写不敏感（Windows FS）；**symlink/junction 严格拒绝**：root 内任何 descendant 链接直接 list/read 返回 `symlink-denied`（junction 的 lstat.isSymbolicLink() 亦为 true），列举时一律跳过，不解析不跟随；IO 前对 canonical target 二次 containment 校验。reason 取值：`escape-denied`/`excluded-path`/`symlink-denied`/`is-directory`/`binary-file`/`not-found`/`not-a-directory`/`unreadable`/`bad-arg`。模块契约注明：纯 Node 路径 API 无文件句柄级原子保证，canonical 二次校验 + 严格 symlink 拒绝属防御深度（defense in depth）而非原子性承诺。
- **坑（实测）**：Node 24 的 `dir.read()` 返回 **Dirent 对象**（非字符串），`name` 须 `typeof entry === 'string' ? entry : entry.name` 兼容；Dirent 可直接 `entry.isSymbolicLink()` 预跳过链接。

## M6 file-browser TOCTOU 加固（2026-08-04 完成）

- 只改 `src/main/file-browser.js` + `tests/test-file-browser.js`。`readFilePreview` 重构为「lstat 快照（dev/ino/size）→ open 'r' 只读 → fstat 句柄比对」，任一不一致立即 close 且不读任何字节（可靠避免读取被替换目标；Windows Node 无 O_NOFOLLOW/openat，此为纯 JS 最可靠替代）。
- 核心 helper：`openVerifiedRead(target, io)`（新导出至 `_internals`，io 默认 fs.promises 可注入）+ `sameFile(a,b)`（dev/ino/size 十进制字符串比较，兼容 bigint 模式混用）；`readFilePreviewImpl(root, relPath, io)` 为可注入实现，`readFilePreview` 是其默认 io 包装。normalizeRoot/resolveSafeTarget/finalizeTarget 均加 `io = fs.promises` 参数。
- **坑（实测）**：fstat 的 size 在 `{bigint:true}` 下为 bigint，直接 `Buffer.alloc(size)` 抛 TypeError——`Buffer.alloc` 前必须 `Number(st.size)`（预览上限 1MB 远小于 2^53 无精度损失）。
- listDir：opendir 前追加 lstat（链接→symlink-denied、非目录→not-a-directory，与 errReason 口径一致），缩小 check-to-use 竞态；模块注释如实声明 Windows JS 层无法原子拒绝目录 reparse point（lstat 与 opendir 之间仍存在理论窗口），不虚假声称完全消除，不引入 native 依赖。
- 测试新增 12/13 区块：openVerifiedRead 注入矩阵（一致读取 / dev·ino·size 任一不一致拒绝且零读取且仍 close / 目录·链接不 open / lstat ENOENT·open 失败·fh.stat 失败 → unreadable 不抛 / close 抛错不掩盖结果 / bigint 同值视为一致 / 1MB 截断 / 空文件）；readFilePreviewImpl 注入篡改 fstat.size → unreadable 且零读取。验收：node --check 两文件过、test-file-browser.js 全绿。

## git-service 模块（2026-08-03 完成）

- 新增 `src/main/git-service.js` + `tests/test-git-service.js`（CommonJS 纯 Node 无 electron，spawn('git', args, {shell:false})）。契约：`getChanges(workDir)` → `{ok:true, snapshotId(randomUUID), at, entries}`（ChangeEntry={id 数组下标, path, status, oldPath?, unstaged:{adds,dels}, staged:{adds,dels}}）；`getDiffPreview(workDir, snapshotId, entryId)` → `{ok:true, diff, truncated}`；`LIMITS={GIT_TIMEOUT_MS:10000, DIFF_MAX_BYTES:500*1024, DIFF_MAX_LINES:2000}`。snapshotId 仅内存 Map 可解析（≤20 LRU），伪造/越界/`../../` → stale-snapshot；路径 lexical containment + realpath（deleted/rename 源按最近存在父目录）；git 缺失 ENOENT → git-missing，退出码 128 或 stderr 含 not a git repository → not-git-repo。
- **porcelain v2 -z 实测格式（git 2.54.0.windows.1）**：每条记录 = 单个 NUL 字段，header 与 path 同字段**空格分隔**（非 \n）：`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`（path=tokens[8..] join 空格，含空格路径安全）；rename `2 <XY> ... <R><score> <path>` + **下一独立 NUL 字段** origPath（path=tokens[9..]）；`? <path>` untracked、`! <path>` ignored、`u ...` unmerged。numstat -z：`<adds>\t<dels>\t<path>`；rename `...\t` + src + dst 两独立字段（src 前 dst 后，键用 dst）；二进制 `-` 按 0。
- 关键坑（实测踩过）：**`git commit` 会提交全部 staged——测试里"独立 add 后再 commit"会把先前 staged 一并吞掉**，夹具须 base 一次提交、之后变更不再 commit；**Windows 版 git 拒绝 \t/\n 路径**（update-index --cacheinfo "Invalid path"），含制表符/换行路径只能喂合成 NUL 流测解析器（_internals.parseStatusV2Z/parseNumstatZ 已导出）；**numstat 加 1 行显示 2/1 是末行无 \n 所致**（末行被视作不同），测试文件内容统一以 \n 结尾 + 仓库设 core.autocrlf=false 保证精确计数；LRU 边界测试前须清场 20 次 getChanges 挤掉跨测试残留快照，且每次 getChanges 前制造真实变更保证 entries 非空（空 entries 时 entryId 0 必然 stale）。

## M6 literal pathspec 加固（2026-08-04 完成）

- 只改 `src/main/git-service.js` + `tests/test-git-service.js`。缺陷（Oracle finding，已实证）：diff-preview 的 path 在 `--` 后仍被 Git 解析为 pathspec magic——`git diff -- ':(glob)a.txt'` 无 literal 时输出 9 行（glob 命中真实文件），`GIT_LITERAL_PATHSPECS=1` 后输出 0 行（按字面）。
- 修复：`gitEnv()`（git-service.js ~64-77）在 Object.assign 中固定 `GIT_LITERAL_PATHSPECS: '1'`（git 官方文档记载的全局 `--literal-pathspecs` 等价环境变量），统一作用于 status/numstat/diff-preview 全部调用；**buildGitArgs 零改动**（参数顺序语义不变），模块头安全边界注释补 M6 说明。
- 测试：新增 `testLiteralPathspecs`（11 组断言）+ `makeCaptureSpawn`（按调用次序提供 stdout chunks 并捕获 bin/args/env；**坑：Buffer 直接 for-of 迭代产出字节数字，单 Buffer 元素须包装成数组**）。参数层断言 `:`/`:(glob)`/`:(attr)`/`:(top)` 样式 path 原样置于 `--` 后（含 cached 顺序不变）；端到端注入：合成 `:(glob)foo.txt` 条目进快照 → getDiffPreview，断言 4 次 git 调用 env 全部 `GIT_LITERAL_PATHSPECS==='1'`、diff 参数 `['-C',dir,'-c','core.fsmonitor=false','diff','--no-ext-diff','--no-textconv','--',':(glob)foo.txt']`；testWhitelist 静态审查 needles 加 `GIT_LITERAL_PATHSPECS`。验收：node --check 两文件过 + 全量 14 组测试全绿。

## M3 工作区面板数据 IPC 接线（2026-08-03 完成）

- main.js 追加 require git-service.js/file-browser.js（~25-26 行）；抽取 `resolveWorkspaceContext()`（getContext 与守卫共用）+ `workspaceBoundWorkDir()`（bound 且 workDir 非空 → {workDir, sessionId}，否则 null）；新增 `workspace:changes`（sensitive 目录结果附加 sensitive:true）/`workspace:files`（list/read，relPath 必须字符串且 ≤512，未知 action→bad-arg）/`workspace:diff`（snapshotId/entryId 字符串校验后直传）三 handler（~3971-4018）；mainWindow focus 事件里 workspaceVisible 时 pushWorkspaceEvent({kind:'refresh'})（~3429）。preload 桥追加 getChanges/listFiles/readFile/getDiff 四 API。
- 关键口径：M3 数据 IPC 一律先 isWorkspaceSender → workspaceBoundWorkDir（unbound→{ok:false,reason:'unbound'}）→ 参数校验（bad-arg）→ 服务调用 try/catch + logLine；IPC 层不做路径安全校验（服务内部已防护，直接透传）。
- 并行车道后续改动过面板区（flag 开启且未折叠时启动恢复面板、addChildView 失败 logLine、loadFile .then 日志），M2 已交付部分被其局部修改，未与本车道冲突。

## Oracle 高危导航授权竞态修复（2026-08-04 完成）

- `did-navigate-in-page` 导航授权状态维护移出 `workspaceVisible` 块（面板隐藏时也必须跟随）；仅向面板的 context 推送受可见性限制。
- 新增 `sw.navFingerprint(url, indexEntries)`（session-workspace.js 纯函数）：非会话页→`no-session` 哨兵、未验证→`unverified:<id>`、已验证→`verified:<id>:<workDir>`；去重键由 `workspaceLastNavSessionId`（仅 sessionId）改为 `workspaceLastNavFingerprint`，同 sessionId 的 unverified→verified 与 workDir 变化可识别。
- verified URL 导航无条件清 `workspaceExplicitSessionId`（原条件 `newId !== explicitSessionId` 已去掉）；main.js 抽取 `workspaceIndexEntries()`（getAllSessions 容错），resolveWorkspaceContext/selectCandidate/nav 维护共用。
- focus 事件改发 `{kind:'context'}`（原仅 refresh）：同 URL 索引/workDir 更新也能重新判定身份，UI 侧 refreshContext(true) 自带同身份防抖（workspace.js ~1021 行 context 分支）。
- 测试：tests/test-session-workspace.js 新增 `testNavFingerprint`（7 断言组，含未验证→已验证/workDir 变化/哨兵/稳定去重）。

## Oracle 导航状态阻塞修复（2026-08-04 完成）

- 缺陷：focus 只向面板发 `{kind:'context'}`，不重算 navFingerprint/不清 explicit——explicit A → URL B 未验证 → 索引更新 B 已验证 → focus 期间 explicit A 残留，离开 B 到非会话 URL 后回退重绑 A。
- session-workspace.js 新增纯函数 `computeNavStateUpdate({url, indexEntries, prevFingerprint, explicitSessionId})` → `{changed, fingerprint, clearExplicit}`；**口径：explicit 清理只在指纹变化路径评估**（changed 才可能 clearExplicit=true）；未验证 URL/非会话页恒 false（explicit 是低置信 URL 的高置信回退）；绝不依赖 workspaceVisible。
- main.js 抽取 `syncWorkspaceNavigationState(url)`（~3915，workspaceIndexEntries 后）：computeNavStateUpdate + 更新 workspaceLastNavFingerprint + clearExplicit 时清 workspaceExplicitSessionId，返回 `{changed}`；did-navigate-in-page（~3530）与 focus（~3431）共用。
- did-navigate-in-page：每次调同步函数，仅 `changed && workspaceVisible` 推 `{kind:'context'}`；focus：先 getURL 调同步函数（面板隐藏也同步），workspaceVisible 时 changed → context、未变 → refresh（UI scheduleRefresh 自带 3s 防抖，workspace.js ~1043，未改 UI）。
- 测试：test-session-workspace.js 新增 `testComputeNavStateUpdate`（8 组：unverified→verified 识别、explicit 仅 verified URL 清理、哨兵回退保留、指纹未变不清 explicit 的口径固定）。

## M4 官方 WS normalizer 适配（2026-08-04 完成）

- 只改 `src/main/runtime-event-normalizer.js` 与 `tests/test-runtime-state.js`（main/task-catalog/pages 未动）。
- task.* 取值增强（M1 实测：payload 顶层 `{agentId, info, sessionId, type}`）：新增 `pickStr(obj, keys)` 防御 helper；sessionId 候选 raw/payload/info 三层的 session_id/sessionId；taskId 候选 payload.task_id/taskId + info.task_id/taskId/id/toolCallId；title 候选 payload.title + info.title/description。顶层优先于 info，既有事件字段形状不变。
- **已实测** subagent.spawned/started → task.observed：source:'ws'、status:'running'、taskId=subagentId、agentType=subagentName 或 'subagent'、title=description 或 subagentName 或 'subagent'、confidence:'high'、rawKind 原样；无 subagentId → null。不虚构 completed/failed；agent.created / agent.status.updated 保守 null（未实测且无法辨别主/子 agent，default 分支注释说明）。
- RuntimeState 无改动：subagent 事件 agentType 非 null → getActiveCounts 计 agents；同 subagentId spawned+started 去重不重复计数；重复 running 覆盖 title/agentType（started 无 name 时会覆盖 spawned 的 explore → 'subagent'，测试断言顺序按此编排）。
- 测试新增第 17/18 区块：info 嵌套四变体 + 顶层优先兼容、spawned/started 字段断言、无 subagentId/agent.created/agent.status.updated → null、state 消费（getTasks 过滤/agents 计数/会话隔离/描述漂移 title 更新）。验收：node --check + 全绿。

## M4 元信息降级保护（2026-08-04 完成）

- 只改 `src/main/runtime-state.js` 与 `tests/test-runtime-state.js`。缺陷：官方 WS `subagent.spawned` 先写具体元信息（`{title:'inspect repo',agentType:'explore'}`），随后 `subagent.started` 缺 name/description 时 normalizer 回退 title/agentType='subagent'，`_applyTask` 整条覆盖导致可读名称与类型降级。
- `_applyTask` 新增合并口径：同 key **非终态**更新时，新事件 title 为空或 `'subagent'` → 保留 existing.title；新事件 agentType 为空/`'subagent'` 且 existing.agentType 非空非 `'subagent'`（更具体）→ 保留 existing.agentType；新事件携带具体非通用值仍正常覆盖。终态墓碑、状态推进、任务 key、source/confidence 语义不变；entry 构建用合并后的局部变量（此前 `agentType: event.agentType || null` 直接取事件值，须改用合并变量）。
- 测试新增第 19 区块：spawned(explore/inspect repo) → started(generic) 后 getTasks 仍 explore/inspect repo、getActiveCounts agents 保持 1；带具体新 title/agentType 的更新可覆盖旧值且不重复计数。验收：node --check + test-runtime-state.js 全绿。

## M4 工作区投影接线（2026-08-04 完成）

- 改动仅 `src/main/main.js` + `src/preload/workspace-preload.js`：require `./workspace-projection.js`（~28 行，交付时文件尚不存在，node --check 不解析 require）；新增 `workspaceBoundSessionContext()`（~3981，bound + sessionId/sessionDir/workDir 齐全；sessionDir 校验 = sessionsRoot 内 lexical path.relative（同 getSubagentTree 范式）+ realpathSync 二次校验，目录不存在/解析失败→null；`workspaceBoundWorkDir()` 保留不动给 M3）；IPC `workspace:projection`（~4113，isWorkspaceSender → bound 守卫 → getWorkspaceProjection({sessionId,sessionDir,taskCatalog})，unbound/异常兜底 `{ok:false,reason,agents:[],tasks:[],diagnostics:{},capturedAt}`）；preload 增 `getProjection`。
- 活动推送：runtimeState 'changed' listener 内追加**独立** workspaceActivityTimer 1s 防抖（与 500ms runtime-changed 广播互不干扰）；过滤语义：workspaceVisible && payload.sessionId 为字符串非空 && 等于 `workspaceBoundSessionContext().sessionId` 才推 `{kind:'activities',sessionId}`，payload 无 sessionId 不推；timer 在 hideWorkspacePanel destroy 分支与 mainWindow 'closed' 清理。
- 验收：node --check 两文件过；未启动 Electron。workspace-projection.js 本体由并行车道交付，本次未触碰。

## M4-1/M4-5 数据投影模块交付（2026-08-04 完成）

- 改动仅 `src/main/task-catalog.js` + 新建 `src/main/workspace-projection.js` + `tests/test-task-catalog.js` 扩展 + 新建 `tests/test-workspace-projection.js`（main/preload/pages/normalizer/runtime-state 未动）。
- TaskCatalog `getCatalog({sessionId, sessionDir})` 扩展：sessionDir 提供且核验通过时磁盘扫描只读该目录 tasks/cron（两级目录 `sessionsRoot/<wdKey>/<sessionId>`），**不 readdir sessionsRoot**；无 sessionDir 的遗留 chat 调用保持旧全量扫描。防御校验 `_validateSessionDir`：非字符串/空→'not-string'、sessionsRoot 缺失→'no-root'、lexical 越界（..逃逸/绝对/不同盘/等于根）→'outside-root'、realpath 失败→'root-not-found'/'not-found'、realpath 后越界→'realpath-outside'；无效写 `diagnostics.invalidSessionDir`（不抛、不读盘）。直读条目 sessionId=basename(sessionDir)，与 filter.sessionId 不一致时被过滤。旧 diagnostics 字段与 entries 合并优先级不变（runtime > cronEntries > disk）。
- `getWorkspaceProjection({sessionId, sessionDir, taskCatalog})` → ok:true `{sessionId, agents:tree.nodes, tasks:catalog.entries, diagnostics:{agents,tasks}, capturedAt}`；失败态 ok:false `{reason:'unbound'|'invalid-session-dir'|'no-catalog', sessionId:null|原值, agents:[], tasks:[], diagnostics, capturedAt}`；输入缺失/非法空态不抛；buildSubagentTree ok:false（目录不存在）→ invalid-session-dir 失败态。只读组合：不启动 ACP、不写盘、不跨会话、不 replay。
- **数据格式假设**：sessionDir 为 `sessionsRoot/<wdKey>/<sessionId>` 形态（sessionId=basename）；Projection 侧 sessionId 仅 trim 非空校验（深层越界校验在 TaskCatalog，职责分层）；buildSubagentTree 坏 wire 行只计 badLines 仍建节点（status unknown），坏 JSON 任务文件计 badFiles 跳过。
- 测试 5 组：正常树+catalog+两级对账（agents/tasks 均仅目标会话）/ 目录缺失失败态不抛 / 坏文件 diagnostics 透传不抛 / 无效输入空态（unbound·invalid-session-dir·no-catalog）/ runtime WS 快照优先联动（normalizeWsEvent 注入）。task-catalog 测试新增 12-14 区块：直读只返回目标会话（**monkeypatch fs.promises.readdir 哨兵断言 rootReaddirCalls===0**）+ 直读 diagnostics 计数 / 无效 sessionDir 五变体（..逃逸·绝对路径·不存在·非字符串·等于根）不读盘不抛 / sessionId 与目录名一致性。验收：node --check 4 文件过、两测试全绿。

## M4 探针扩展 workspace-integration-probe.js（2026-08-04 完成）

- 仅改 `scripts/workspace-integration-probe.js`：顶部注释补 M4 覆盖；**getContext 与 getProjection 在同一 executeJavaScript 桥调用中执行**（`callWs` 内 IIFE 组合快照，不新增桥调用）；断言 ok===true / sessionId===targetSessionId / agents、tasks 均为数组（不强制非空）/ capturedAt 为 `typeof==='number'` 且 `Number.isFinite`；最终 JSON 汇总 `projection:{ok,agents:<count>,tasks:<count>,capturedAt,diagnostics}`（不打印条目内容）；panelErrors 必须为空逻辑未动。验收：node --check 过，运行由 orchestrator 执行。

## M4 子代理树后代链接越界修复（2026-08-04 完成）

- 只改 `src/main/subagent-tree.js` + `tests/test-subagent-tree.js`。缺陷：buildSubagentTree 只信任 sessionDir，随后的 state.json/agents/agents\<id\>/wire.jsonl 读盘全跟随链接，合法 sessionDir 内 junction 可让投影读外部内容。
- 修复口径：sessionDir 自身 lstatSync 校验（缺失/链接/非目录 → 既有 `ok:false` 形态，diagnostics:null，不抛）；**state.json 链接 → 跳过映射按目录枚举降级**；**agents 根链接 → 整体跳过（agentsRootLink 标志，任何 wire 路径都会穿过它，一律不读）**；枚举逐条目 lstatSync（**不信 Dirent.isSymbolicLink，junction 的 lstat.isSymbolicLink() 恒 true**）；第一遍每 id 再 lstat agent 目录与 wire.jsonl（TOCTOU 防御）。
- **skippedLinks 计数语义**：state.json 链接 1、agents 根链接 1、枚举阶段每个 agent 目录链接 1、第一遍每个 wire.jsonl 链接 1；**第一遍不再计 agent 目录链接**（枚举已覆盖，重复计会导致 state 登记+磁盘链接双计数）。坏文件口径不变（wire 缺失仍 badFiles，链接不算 badFiles）。扫描降级"尽可能构建"：agents 根链接时 nodes=[]（无合法内容可读）。
- 测试：`tryLinkDir`（dir symlink→junction 降级，返回创建方式）/ `tryLinkFile`（file symlink，Windows 无权限可能失败）；新 4 组（sessionDir 链接 ok:false / agents 链接不读外部树 / 单 agent 目录+wire+state 链接跳过记录 / **junction 降级显式创建**——本机 junction 创建无需权限可直接 `symlinkSync(t, p, 'junction')`）。既有 t2 diagnostics deepStrictEqual 补 `skippedLinks:0`。验收：node --check 过、22 个 test-*.js 全绿。

## M4 主进程 WS 路由与活动调度修复（2026-08-04 完成）

- 只改 `src/main/main.js`（normalizer/runtime-state/task-catalog/preload/UI 未动；task-catalog.js 由并行车道改 observe(event)=>boolean 契约，main 侧按新契约调用）。
- WS handler 统一路由（~1560）：解析 raw 后、进入审批/问答/通知分支前统一 `normalizeWsEvent(raw)` → 非 null 则 `runtimeState.apply(normalized)` + `scheduleTrayStatus()`；删除 usage_updated/task.started/task.progress 三分支各自 apply（整分支删除，事件自然落到末尾），completion 分支仅保留通知。**每条 WS 消息只 apply 一次**（grep `runtimeState.apply(normalizeWsEvent` 零残留）。task.done→completed（normalizer L70）、subagent.spawned/started→task.observed 均由此进入 RuntimeState；SubagentStop/session.completed normalizer 不识别→仅通知。
- 抽取 `scheduleWorkspaceActivities(sessionId)`（~2153）：workspaceVisible + sessionId 字符串非空 + `workspaceBoundSessionContext().sessionId === sessionId` 严格相等 + 1s 防抖（clearTimeout 重置）；runtimeState changed 调它（~2180，payload.sessionId 可能 null 由函数内过滤）；ACP tool_call/tool_call_update 两分支（~2680/2692）`catalogEvent && taskCatalog.observe(catalogEvent) === true` 时才调（cron 活动不伪装 RuntimeState task，`=== true` 兼容并行车道 boolean 契约）。timer 清理点（hideWorkspacePanel destroy / mainWindow closed）不变。
- `workspaceBoundSessionContext()`（~3992）严格化：containment 用 `rel==='' || rel==='..' || rel.startsWith('..'+sep) || path.isAbsolute(rel)` 拒绝（**rel==='..foo' 不误拒**，旧 `!startsWith('..')` 会误拒）；realpath 二次校验后追加 `path.basename(real) !== sessionId` 严格相等（防 symlink 指向其他会话目录）。
- 验收：node --check main.js 过；未启动 Electron。

## M4 TaskCatalog/workspace-projection 审查修复（2026-08-04 完成）

- 只改 `src/main/task-catalog.js`、`src/main/workspace-projection.js`、两个对应测试（main/preload/normalizer/runtime-state 未动）。
- **sessionDir 三态**（`_validateSessionDir(sessionId, sessionDir, diagnostics)` 不再返回 null）：`absent`（未提供）才允许遗留 sessionsRoot 全量扫描；`invalid`（已提供但 not-string/no-root/outside-root/symlink-denied/not-found/realpath-outside/**session-id-mismatch**）只写本次 diagnostics.invalidSessionDir，`_scanDiskTasks/_scanDiskCron` 均不被调用（invalid 分支 getCatalog 直接跳过磁盘步）；`direct` 只直读该目录。旧代码 invalid 与 absent 同为 null 会回退全量——已修。
- **sessionId 与 sessionDir 绑定**：direct 须 `path.basename(realpath(sessionDir)) === filter.sessionId`，错配 invalid（'session-id-mismatch'）绝不读盘；`getWorkspaceProjection` 在调 buildSubagentTree 前独立 realpath + basename 检查（realpath 失败 → diagnostics.agents.error + invalid-session-dir，保持旧测试契约），防纯模块调用绕过。
- **链接严格拒绝**：会话目录本体 lstat 拒 symlink（'symlink-denied'）；tasks/cron 子目录与枚举文件用 `readdir(p, {withFileTypes:true})` dirent.isSymbolicLink 跳过（junction 亦 true）；sessionsRoot 与 sessionDir 均 realpath 后再 containment；新增 diagnostics.skippedLinks 计数（目录级链接计 1、跳过整个目录）。
- **每次 getCatalog diagnostics 独立**：`freshDiagnostics()` 每调用新建并显式传给扫描函数，结束覆盖 `this.diagnostics`（兼容快照，res.diagnostics 与实例属性相等）；连续调用不翻倍、invalid 请求不污染后续快照。
- **observe 返回 boolean**（_cronEntries 实际变更信号）：`_cronEntryChanged(prev,next)` 比较 status/title/cronAction/detail(JSON)；重复相同事件/终态拦截/未见删除/无 id → false；tasktool 分支恒 false。合并语义不变。
- 测试：task-catalog 新增 15（junction/symlink 指向 root 外不读外部 JSON）、16（observe true/false 矩阵）、17（diagnostics 独立）；13 改哨兵证明 invalid 零 sessionsRoot 扫描；14 改 session-id-mismatch 断言；projection 新增第 6 区块（{sessionId:'B',sessionDir:'.../session_A'} → invalid-session-dir，Agents/Tasks 空）。验收：node --check 4 文件 + 全量 24 个 test-*.js 全绿。

## M4 TaskCatalog/Projection 契约修复（2026-08-04 完成）

- 只改 `src/main/task-catalog.js`、`src/main/workspace-projection.js`、两个对应测试（main/preload/normalizer/runtime-state 未动）。
- **_validateSessionDir 补 'not-directory'**：lstat 成功后非目录（普通文件）→ invalid，绝不视作 direct（此前普通文件会穿过 lstat/symlink 检查进 direct，readdir 才失败）；检查顺序 symlink-denied → not-directory → realpath。13 区块加 13f 哨兵（basename 匹配的普通文件 → invalidSessionDir='not-directory' + 零 sessionsRoot readdir）。
- **observe() tasktool 分支返回变更信号**：runtime 同键且 `now > runtime.at` 的首次观察 → 记录并 true（可见 updatedAt = max(runtime.at, obsAt) 刷新）；prev 存在且 now <= prev（等价/倒退）→ false；无 runtime 同键 / now <= rt.at → false 不记录。主进程既有 `=== true` scheduleWorkspaceActivities 可直接响应 tasktool 活动。cron 分支语义不变。测试 8 区块补返回值断言、16 区块补 tasktool 矩阵（tAtA-100 false / +500 true / 重复 false / 倒退 false / +900 true / updatedAt 联动）。
- **projection 不抛契约补漏**：getCatalog rejection（不受信 taskCatalog 或异常）→ 新失败态 reason 'catalog-error'（agents: tree.diagnostics, tasks: null），不逃逸；buildSubagentTree 同步路径已全面 try/catch（M4 修复）未动。测试新增第 7 区块（boom catalog → catalog-error 不抛 + 回归）。
- 验收：node --check 4 文件过、全量 22 个 test-*.js 全绿。

## M5 会话上下文安全修复（2026-08-04 完成）

- 只改 `src/main/session-workspace.js` + `tests/test-session-workspace.js`。缺陷（Oracle finding）：URL 携带合法 sessionId 但索引未命中时 `resolveContext()` 仍回退 explicit → Web 显示 B、Workspace 读取旧绑定 A 的不一致（未授权读取）。
- 修复口径：`resolveContext` 中 URL 解析出合法 id 且 `resolveBySessionId` 未 verified → 直接走新抽出的 `candidatesOrUnbound(indexEntries, updatedAt)`（有候选 candidates / 无候选 unbound），**绝不回退 explicit**；explicit fallback 仅剩 URL 无会话 ID（非会话页 / 非法 URL / 解析失败）路径；URL sessionId 后续被索引 verified 仍按 url 优先 bound B（computeNavStateUpdate 的 clearExplicit 语义未动）。模块头注释与 resolveContext 注释均补充 M5 安全规则说明。
- 测试：新增 `testResolveContextM5Security`（5 组：explicit A + unknown 合法 URL B → candidates 非 bound A；B 入索引 → bound B/navigate；非会话 URL → fallback A；索引空 → unbound；非法 URL → fallback A）；`testResolveContextPriority` 原"未验证 URL 回退 explicit"场景改为断言 candidates（合法 id 未验证不再回退），非法 URL/候选既有测试保持。验收：node --check 两文件过 + 9 组测试全绿。

## M5 主进程最小整合（2026-08-04 完成）

- 只改 `src/main/main.js`（session-workspace.js/Workspace 页面/文档/测试未动；无 ACP 重构）。
- **WS question 路径弃用本地问答窗**：`handleQuestionRequested` 保留 payload 校验/questionId 去重/pending 计数；聚焦仅 logLine 记 Web UI 接手，失焦仅 `showDesktopNotification(title, body, sessionId)`；`createQuestionWindow` 仅剩 ACP elicitation 一个调用点。
- **通知 session 导航**：`showDesktopNotification(title, body, sessionId?)` 第三参可选；点击恒先 `showMainWindow()`，然后 `navigateNotificationToSession(sessionId, notifGen, notifBase)`——校验 isValidSessionId + 创建时 gen/base 与当前一致 + knownServerBase/Token 可用，才构造 `${base}/sessions/<id>#token=` 导航；已在目标会话不重载；不接受事件 URL；旧服务/无效 ID/无 token 仅聚焦。
- **审批/完成通知 sessionId**：`extractNotificationSessionId(raw)`（raw/payload 的 session_id/sessionId 形态校验）供审批通知；完成通知仅当 `normalized.sessionId` 合法且与原始 ID 不冲突才携带（冲突/缺失 → 仅聚焦）。
- **M5-4 索引重查**：`maybeStartNavRecheck(url)` 对合法未验证 sessionId 启动单实例退避重查（100/250/500/1000/2000ms，≈3.85s 总生命周期）；每 tick 校验窗口存在/同一 `navRecheckEpoch`/URL 仍同 sessionId/origin ∈ knownServerBase/gen+base 未变；命中 verified 仅一次 `syncWorkspaceNavigationState` + 面板可见才推 context。失效点：did-navigate、did-navigate-in-page、`connectToInstance`、`startKimiServer`、mainWindow 'closed'（均调 `invalidateNavRecheck()`）。
- **did-navigate 接入**：`handleWebNavigation(url)`（invalidate → sync → 可见才推 context → maybeStartNavRecheck）为 did-navigate 与 did-navigate-in-page 共用入口，修复通知 loadURL 跳会话后面板不刷新的问题。
- **question 窗 owner 隔离**：`questionWindowOwner`（'ws'|'acp'）；WS answered/dismissed 分支与 `cleanupWsPermanent` 只作用于 'ws' 窗；`openAcpElicitationWindow` 传 `'acp'`。
- **M5-2**：托盘「默认模型（默认配置；会话内切换请在 Web UI 操作）」、menu panel `默认模型：<m>（默认配置；会话内切换请在 Web UI 操作）`，动作仍只写 default_model。
- 验收：`node --check src/main/main.js` 过；22 个 test-*.js 全绿。未启动 Electron（通知点击导航/重查命中推 context 属运行时行为，无法自动测试）。

## M5 P1 通知/ACP 问答窗/Overlay 安全修复（2026-08-04 完成）

- 只改 `src/main/main.js` + 新建 `src/main/notification-nav.js`、`src/main/acp-question-window.js` + 两个对应测试（session-workspace.js/Workspace 页面/文档未动，无大范围重构）。
- **独立连接/导航 epoch**：`navEpoch`（main.js ~64 行）在 connectToInstance/stopKimi/startKimiServer/CLI child exit/rotateToken 五处递增（均伴 `wsGeneration++`，但 navEpoch 独立单调，绝不动 serverGeneration 的 CLI/WS 回调语义）。通知创建捕获 epoch+base，点击时经 `decideNotificationNav` 校验 epoch/base 相同 + 当前可信 token + 未在目标会话才导航；A→B→A 与同 base 重启旧通知只能聚焦。
- **notification-nav.js 纯函数**：`collectProvidedSessionIds(raw)`（raw 顶层 + payload + data 各层 session_id/sessionId，仅非空视为提供）；`approvalNavSessionId`（全部合法且一致才返回 ID，冲突/非法非空/缺失→null）；`completionNavSessionId`（normalizer 合法 + 与所有 raw 来源一致，raw 未提供时以 normalizer 为准）；`decideNotificationNav`（epoch/base/token/已在目标 全过才 navigate，URL 只由当前 base/token 构造）。WS question 路径 `handleQuestionRequested` 两处 showDesktopNotification 均不再传 sessionId（question 永不导航）。
- **ACP elicitation 窗生命周期**：`acpElicitationEpoch`（窗口有效性代）+ `acpElicitationSettle`（settle 身份）；createQuestionWindow 的构造/loadFile/did-finish-load 失败路径在 owner==='acp' 时一律 `settleAcpElicitationCancelled`（旧代码 ACP load 失败静默会卡死 acpPermissionPending）；init 有效性用 `isWindowInitCurrent(owner, gen, wsGeneration, acpElicitationEpoch)`——ACP 窗绝不使用 wsGeneration；`cancelAllAcpPermissions` 先清 settle 身份/递增 epoch 再 `closeAcpQuestionWindow()`（防 closed 守卫二次 settle）；三个 question IPC（submit/fallback/cancel）均加 `isQuestionWindowSender`（sender===当前 questionWindow.webContents）+ `shouldSettleElicitation`（pending.kind==='elicitation' && settle 身份一致）校验，遗留窗（QID 保持 ACP_ELICITATION_QID 至关闭）被守卫拒绝走 WS 路径；普通 ACP permission 窗与队列行为未动。
- **Overlay 暂隐**：`pushWorkspaceEvent` 开头若 overlayView 存活（z-order 覆盖、workspaceView 已 removeChildView）直接 return；syncWorkspaceNavigationState/maybeStartNavRecheck 不依赖该函数，overlay 期间照常；collapsed 情形由 workspaceContents() null 天然拦截。
- 测试：`tests/test-notification-nav.js`（9 组：A→B→A epoch/无 token/非法 ID/冲突 ID/完成不一致/已在目标/URL 构造 + 2 组 main.js 静态接线断言）；`tests/test-acp-question-window.js`（4 组：payload 构造/shouldSettle 矩阵/isWindowInitCurrent 矩阵 + main.js 静态断言）。验收：node --check 5 文件过、全量 24 个 test-*.js 全绿；未启动 Electron（通知点击导航/ACP 窗真实窗口/overlay 覆盖期间行为属运行时，需手测）。

## Oracle ACP P1-A/P1-B 关闭（2026-08-04 完成）

- 只改 `src/main/main.js`、`src/main/acp-question-window.js`、`tests/test-acp-question-window.js`（question 页面/preload 已传 question_id，无需改动；session-workspace/Workspace 页面/文档未动）。
- **P1-A 窗口 cleanup 捕获身份**：`createQuestionWindow(sessionId, payload, gen, owner, acpSettle)` 新增第 5 参（openAcpElicitationWindow 传捕获的 settle，main.js ~2698）；四个失败 cleanup（创建失败/did-finish-load 已销毁/init send 失败/load 失败）一律 `settleAcpElicitationCancelled(reason, acpSettle)`（main.js ~1290/1320/1331/1343）。`settleAcpElicitationCancelled(reason, expectedSettle)`（~2540）改走新纯函数 `settleWindowElicitationCancelled(identity, pending, windowSettle)`（acp-question-window.js ~111）：只 retire 捕获的 windowSettle 命中才结算，绝不读全局当前身份——win.close() 同步触发 closed guard 结算并 pump 新 elicitation 后，旧 cleanup 再 retire 全局身份会误伤新请求；expectedSettle 缺省回退全局身份（仅"问答窗已在途"等无窗口绑定路径）。"问答窗已在途"分支保持无参（防御性冲突路径，正确）。
- **P1-B payload QID 校验**：`canSettleAcpElicitation` 新增 `payloadQuestionId === ACP_ELICITATION_QID`（acp-question-window.js ~95）；三个 question IPC（submit/fallback/cancel，main.js ~1494/1573/1619）传 `payloadQuestionId: questionId`（handler 已提取 p.question_id）。拒绝分支日志/error 文案改"elicitation 已结算或 QID 校验失败"。question.js `ids()` 已随 init 数据携带 question_id（ACP 时为 'acp-elicitation'），页面/preload 零改动。
- 测试 11 组（新增 4 个可执行行为测试 + canSettle payload QID 矩阵 + 静态接线断言更新）：`testWindowCleanupAfterSyncPump`（close 同步触发 guard 结算→pump E2 后旧 load catch cleanup 再 retire 捕获旧 settle→幂等 false，E2 身份/epoch/init/结算全完好）、`testDestroyCleanupAfterSyncPump`（did-finish-load isDestroyed 等效）、`testCreateFailCleanupSettlesOwn`（创建失败无 guard 直接命中自身身份）、`testWindowCleanupNonElicitationPending`（permission pending/null pending/身份不匹配恒不结算）。验收：node --check 3 文件过、全量 25 个 test-*.js 全绿；未启动 Electron（真实窗口替换/load 失败时序需手测）。

## M5 最后一个 P1：普通 ACP 审批窗 loadFile 失败回退协调（2026-08-04 完成）

- 只改 `src/main/main.js`、`src/main/acp-permission-window.js`、`tests/test-acp-permission-window.js`（session-workspace/Workspace 页面/文档未动，无大重构）。缺陷：load catch 在 `win.close()`（closed handler 同步清空全局 acpPermissionWindow/捕获身份）之后用 `acpPermissionWindow === win` 判断回退——恒不成立 → fallback 不执行 → acpPermissionPending 永久在途、FIFO pump 卡死。
- **acp-permission-window.js 新增 3 纯函数**：`planPermissionLoadFail({windowIsCurrent,pending,windowSettle,windowParams})`（**close 之前调用**：窗口仍为当前窗 + pending.settle/params 与捕获身份引用级相等 → `{action:'fallback',pending,...}`，否则 `{action:'skip',reason:'window-replaced'|'no-pending'|'settle-mismatch'|'params-mismatch'}`）；`decisionFromDialogResponse(response,options)`（idx 在 options 内 → selected 否则 cancelled，与既有 fallback 语义一致）；`runPermissionFallbackDialog({options,settle,showDialog,log})`（showDialog 同步抛/返回非 Promise=对话框不可用 → 直接 settle cancelled，settle 内部同步 pump 队列，绝不悬挂；结算路径均 try/catch 不逃逸）。
- **main.js load catch 修复**（~2734-2755）：close **之前** `planPermissionLoadFail` 捕获验证 → `fellBack=true` → close → 仅 `action==='fallback'` 时 `fallbackAcpPermissionDialog(payload, loadFailPlan.pending.settle)`（只结算捕获身份）；skip 不 fallback 不结算（请求已被 closed/取消收尾或已非当前）。幂等：settle 闭包 `settled` 标志 + fellBack 让 closed 跳过结算，一次失败最多结算一次。
- **fallbackAcpPermissionDialog**（~2791）改走 `runPermissionFallbackDialog`（注入 `dialog.showMessageBox` 为 showDialog + log=logLine）；创建失败路径（~2708）调用点不变。
- 测试 11 组（新增 4）：`testPlanPermissionLoadFailMatrix`（5 分支单元矩阵）；`testLoadFailFallbackSettlesCapturedAndPumps`（**可执行模拟**：makeLoadFailSim 复刻 pump/settle/closed/load catch 编排——load fail → close 清窗 → 捕获 E1 仍 fallback selected 且队列推进到 E2、E2 完好；「拒绝」按钮 cancelled；对话框 promise reject → 取消且队列继续）；`testLoadFailAfterReplaceSkips`（E1 先被用户关窗 settle 并同步 pump E2 后，E1 load catch 后到 → skip、不结算、不弹窗，E2 正常完成）；`testFallbackUnavailableCancelsAndPumps`（showDialog 同步抛 / 返回 null → E1 取消、队列推进）。静态接线断言补：plan 在 close 之前（planCall < closeCall）、回退只用 `loadFailPlan.pending.settle`、旧缺陷模式 `acpPermissionWindow === win && acpPermissionPending` 零残留、fallback 走 runPermissionFallbackDialog。测试运行器改 async（await 微任务结算）。
- 验收：node --check 3 文件过、全量 26 个 test-*.js 全绿；未启动 Electron（真实窗口 loadFile 失败时序/原生对话框展示需手测）。

## M6-1 探针 flag-off 关闭路径验证（2026-08-04 完成）

- 仅改 `scripts/workspace-integration-probe.js`。新增三种模式：默认/`--flag-on`（行为输出与既有 M3/M4 探针完全一致）、`--flag-off`、`--all`。
- `--flag-off`：独立 userData（`os.tmpdir()/kcd-workspace-integration-probe-flagoff`）写同形态 config 仅 `workspacePanelEnabled:false` → require main.js 启动真实主进程；断言主窗口达 http(s) 后 10s 观察窗内 `webContents.getAllWebContents()` 全量枚举无任何 `workspace.html`（500ms 采样 20 次）+ 主会话 URL 保持 http(s) 且 `document.readyState` 可达（executeJavaScript，不依赖 capturePage）。证据链：main.js 中 flag 关闭时 showWorkspacePanel 直接 return、connectToInstance 不调用 → workspaceView 恒 null → 无视图/无 loadFile/无 workspace-preload（无 window.workspace）/workspace:* IPC 无合法 sender 可达，三推论（workspaceViewCreated/workspacePreloadInjected/workspaceIpcReachable=false）记账入 result.flagOff。
- `--all`：`spawnSync(process.execPath, [__filename, arg], {stdio:'inherit', timeout:170000})` 顺序跑 `--flag-off` → `--flag-on`，任一非零立即退出 1；两子进程独立 userData/隔离 config 互不污染；`--all` 分支在 require main.js 之前同步处理并退出。
- 验收：node --check 过；flag-off / 默认 flag-on / --all 三种模式实跑全部 exit 0（flag-off 20 次采样 workspaceMatches 恒 0、主会话 readyState=complete；flag-on 全链路 getContext bound + projection ok）。

## 执行注意

- 临时脚本放 `C:\Users\zyl\AppData\Local\Temp\opencode`（该目录 package.json 声明 type:module，CommonJS 脚本须用 .cjs 扩展名）。

## Oracle 四项 P1 修复（2026-08-04 完成）

- 只改 `src/main/main.js`、`src/main/notification-nav.js`、`src/main/acp-question-window.js`、新建 `src/main/overlay-context-sync.js` + 两个对应测试扩展 + 新建 `tests/test-overlay-context-sync.js`（session-workspace/Workspace 页面/文档未动，无大重构）。
- **P1-1 同步重入**：`acp-question-window.js` 新增 `ElicitationIdentity`（epoch+settle 绑定状态机，main.js 单例 `acpElicitationIdentity`）：`begin(settle)` 建立新请求身份（settle 同步 pump 时调用）；`retire(pending, expectedSettle)` 原子失效"匹配 expectedSettle"的身份并返回旧 settle（不匹配返回 null 不动身份）。**所有 elicitation 收尾路径必须先 retire 再结算**（submit/fallback/cancel、settleAcpElicitationCancelled、cancelAllAcpPermissions、closed guard）——settle 内部同步 pump 新 elicitation 会 begin 新身份，旧路径返回后绝不触碰身份字段；closed guard 必须传闭包捕获的旧 settle（防旧窗口误伤新请求）。**createQuestionWindow 遗留窗替换**：新增 `questionWindowEpoch`（acp 窗创建时=gen），在途窗 epoch !== 当前身份 currentEpoch → 遗留 → close 替换继续创建；绝不能用"身份仍匹配"判断（E2 身份建立后旧窗会被误判在途而取消）。延时关窗捕获 settle 前旧窗口且须 `questionWindow===win`。cancelAllAcpPermissions 先清队列+retire 再 settle（防 settle pump 出新请求漏结算/误关窗）。
- **P1-2 overlay context 待同步**：新建 `overlay-context-sync.js` 纯函数 `noteContextWhileOverlay(pending,payload)`（context→置位幂等合并，非 context 不积压不清除）+ `drainContextAfterOverlay(pending,remounted)`（重挂→补发一次并复位；collapsed→不补发但复位）。main.js：pushWorkspaceEvent overlay 分支记标志；closeOverlay 恢复面板（addChildView）后 drain 补发 `{kind:'context'}`；hideWorkspacePanel destroy 与 mainWindow closed 清标志。
- **P1-3 完整一致 sessionId**：`notification-nav.js` collectProvidedSessionIds 区分"字段缺失（undefined，不取消）"与"存在但非法（空串/null/非字符串→presentInvalid 取消）"；来源覆盖 raw 顶层/payload/data 及各自 info 层（与 normalizer pick 路径对齐，info 非对象按缺失）；approval/completion 有 presentInvalid 即 null。
- **P1-4 IPC 准入**：`acp-question-window.js` 新增 `canSettleAcpElicitation({senderIsCurrentWindow,owner,questionId,pending,settle})`——sender 当前窗 + owner='acp' + QID=acp-elicitation + settle 身份匹配，全满足才进 ACP 结算分支；三个 question IPC 均显式调用。
- 测试：test-acp-question-window 7 组（新增同步 reentry 重放模拟、retire 只失效捕获旧 settle、canSettle 错配矩阵、main.js 静态接线含 retire<settle 顺序断言）；test-notification-nav 13 组（新增存在非法值/info 冲突/全源同值/缺失不取消）；test-overlay-context-sync 6 组（合并一次/恢复补一次/collapsed 复位/全流程/静态接线）。验收：node --check 4 源文件过、全量 25 个 test-*.js 全绿；未启动 Electron（真实窗口替换/overlay 重挂补发需手测）。

## M5 最后一个 P1：窗口绑定 request identity 准入（2026-08-04 完成）

- 只改 `src/main/main.js`、`src/main/acp-question-window.js`、`tests/test-acp-question-window.js`。缺陷：三个 question IPC（submit/fallback/cancel）的 `canSettleAcpElicitation` 传入全局 `acpElicitationIdentity.settle`——旧窗口在 QID 正确且 sender 校验仍通过（延时关窗/替换间隙）时，可凭"新 pending.settle === 全局当前 settle"误结算新请求。
- **窗口绑定 identity**：新增 `questionWindowSettle`（main.js ~106，仅 owner==='acp' 时 = 创建时 acpSettle，WS 窗恒 null），与 `questionWindowEpoch` 构成窗口创建时捕获的不可变 request identity；createQuestionWindow 赋值（~1311）、closed 处理器与 closeAcpQuestionWindow 按 `questionWindow===win` / owner==='acp' 判定清理（~1320/2556），已替换新窗时旧窗 closed 不伤及新窗状态。
- **准入强化**：`canSettleAcpElicitation` 签名改为 `{senderIsCurrentWindow, owner, questionId, payloadQuestionId, pending, windowEpoch, windowSettle, identity}`——新增 `windowEpoch === identity.currentEpoch()`、`windowSettle === identity.settle`、`pending.settle === windowSettle`（shouldSettleElicitation 以 windowSettle 为参），identity 缺失拒绝；缺任一条件均拒绝。三个 IPC 准入前捕获 `const pendingRef = acpPermissionPending;`，准入后只以 `retire(pendingRef, questionWindowSettle)` 退休、`retired && pendingRef.settle(...)` 结算，绝不再读全局当前 settle/pending（`settle: acpElicitationIdentity.settle` 调用已零残留）。
- 测试 12 组：testCanSettleAcpElicitation 重写为新签名矩阵（epoch 旧/settle 旧/identity 缺失/pending 与 windowSettle 错配等）；新增 `testStaleWindowCannotSettleNewPending` 可执行场景（E1 结算→同步 pump E2 后，E1 遗留窗 QID 正确但 epoch/settle 旧 → 准入拒绝、E2 身份完好且可正常完成；当前窗完整条件通过）；静态接线断言补 windowEpoch/windowSettle/identity 传入与"不得以全局 settle 作准入身份"、pendingRef 捕获、`retire(pendingRef, questionWindowSettle)`。验收：node --check 3 文件过、全量 25 个 test-*.js 全绿；未启动 Electron（真实窗口延时关窗/替换时序需手测）。

## M5 最后 P1：普通 ACP 审批窗 respond 窗口绑定 identity（2026-08-04 完成）

- 只改 `src/main/main.js` + 新建 `src/main/acp-permission-window.js` + `tests/test-acp-permission-window.js`（session-workspace/Workspace 页面/文档未动，无大重构）。缺陷：`acp-permission:respond` 不验证 e.sender 与窗口 identity，直接结算全局 `acpPermissionPending`——E1 dispose/cancel/close 后同步 pump E2，E1 旧窗延迟 IPC（甚至 optionId 重合）可取消/批准 E2。
- **窗口捕获不可变 identity**：`acpPermissionWindowSettle` + `acpPermissionWindowParams`（main.js ~2445-2448，settle 闭包每请求唯一 + params 引用），openAcpPermissionWindow 创建时捕获赋值（windowSettle/windowParams，main.js ~2677-2681）；closeAcpPermissionWindow / closed handler 按 `acpPermissionWindow === win` 定向清空（~2550/2723-2729），旧窗 delayed closed 不伤新窗状态。did-finish-load / load catch 增 `acpPermissionWindow !== win` 守卫（窗口替换后旧窗不 send init/不回退对话框）。
- **respond 准入**：handler（~2812）只调 `decidePermissionRespond({windowActive, senderIsCurrentWindow(e.sender===win.webContents), windowSettle, windowParams, pending, raw})`（acp-permission-window.js 纯函数）——窗口仍为当前未销毁 + sender 为 acpPermissionWindow.webContents + pending.settle===windowSettle + pending.params===windowParams（引用级）全满足才准入；准入后只结算捕获的 `decision.pending`（pendingRef.settle），绝无 `acpPermissionPending.settle(` 残留。reject 返回 `{ok:false,error}`，不影响新 pending。取消/非法 optionId/裸字符串语义保持（parsePermissionRespond 兼容）。
- 测试 7 组（可执行行为测试为主 + 静态接线断言）：canSettle 矩阵 / parse / 当前窗 selected+cancelled（合法/伪造/数字 optionId）/ **E1 cancel 同步 pump E2（optionId 重合）E1 延迟 respond 拒绝、E2 保持并正常结算** / E1 close 同步 pump E2 两变体拒绝 / 恶意矩阵（dispose 无在途、settle 不匹配、窗口替换旧 sender）/ 静态接线（require、声明、捕获赋值、定向清理、decide 传参、pendingRef 只结算捕获）。验收：node --check 3 文件过、全量 26 个 test-*.js 全绿；未启动 Electron（真实窗口延时 IPC 时序/feedback prompt 需手测）。



## M6 Workspace projection 资源上限（2026-08-04 完成）

- 只改 `src/main/subagent-tree.js`、`src/main/task-catalog.js` 与两份对应测试（main/preload/normalizer/workspace-projection 未动）。
- **LIMITS 常量**（均导出：subagent-tree 的 `LIMITS` / `TaskCatalog.LIMITS`）：wire `WIRE_MAX_BYTES=4MB`（单文件读取上限，超出截断）、`WIRE_MAX_FILES=200`（单次调用读取数上限）、`WIRE_TOTAL_BYTES=8MB`（总读取字节上限）；task JSON `TASK_MAX_BYTES=512KB`/`TASK_MAX_FILES=200`/`TASK_TOTAL_BYTES=4MB`；cron JSON `CRON_MAX_BYTES=512KB`/`CRON_MAX_FILES=100`/`CRON_TOTAL_BYTES=2MB`。
- **wire 截断语义**：`readWireBounded` 用 open+fstat+readSync 按 `min(size,maxBytes,budget)` 读入，截断时只保留完整行（`lastIndexOf('\n')` 前内容，残行连同 '\r' 丢弃），绝不中途解析残行；MAX_LOOP_EVENTS=5000 语义不变；badLines 只反映完整行。预算不足（非超大小）时 wire 也截断读（行日志截断仍有价值）。
- **task/cron JSON 不截断读**：超单文件大小 → `oversizedFiles`/`oversizedCronFiles`；预算不足（size > 剩余预算）→ `skippedFiles`/`skippedCronFiles`（JSON 截断必 parse 失败，直接跳过）；文件数超限同 skipped 计数。stat 失败计 badFiles/badCronFiles（沿用坏文件口径）。
- **diagnostics 扩展**：wire 侧 +`truncatedFiles`/`skippedFiles`/`bytesRead`；task-catalog 侧 +`oversizedFiles`/`skippedFiles`/`bytesRead` 与 `oversizedCronFiles`/`skippedCronFiles`/`cronBytesRead`。语义保持：cronFiles 仍是"解析成功数"、scannedFiles 仍是"扫描候选数"（超大小计入 scannedFiles 不计 badFiles）；每次调用独立（freshDiagnostics 新建）。
- 限额检查位置：wire 第一遍循环在 agentDir lstat 之前（文件数/预算耗尽后不再做任何 lstat/读取）；tasks/cron 在 stat 前；filesTried 在 stat 通过后 ++（超大小文件也占文件数配额）。
- 测试：subagent-tree 13-15 区块（超大 wire 残行不解析 badLines=0 / 文件数 205 超限 skipped=5 / 90×100KB 预算耗尽 skipped=N-nodes）；task-catalog 18 区块（超大 task/cron 不读、205 文件、60×100KB、30×100KB、每次独立）。验收：node --check 4 文件过、两份目标测试全绿、test-workspace-projection 全绿；全量 26 个 test-*.js 中仅 test-session-workspace.js 失败（既有失败：M5 testResolveContextPriority 期望 bound 得 candidates，该模块未被本次触碰）。

## M6 Workspace IPC/授权/日志硬化（2026-08-04 完成）

- 只改 `src/main/main.js`、`src/main/session-workspace.js` + 新建 `src/main/workspace-ipc-guard.js` + `tests/test-workspace-ipc-guard.js` + 扩展 `tests/test-session-workspace.js`（Workspace 页面/preload/文档未动）。
- **新模块 workspace-ipc-guard.js（纯 Node）**：`isPlainObject`（原型须 Object.prototype/null，类实例/数组拒绝）+ `hasOnlyKeys`（字段白名单，多余键拒绝）；`validatePanelState`（undefined→查询，{collapsed:boolean}）/`validateSelectCandidate`（sessionId 字符串 1..128）/`validateFilesArg`（action∈list|read、relPath 字符串≤512）/`validateDiffArg`（snapshotId 字符串 1..128、entryId 整数≥0 或 ≤15 位数字串，与 git-service.toEntryId 对齐）；`isExpectedWorkspaceUrl`/`decideWorkspaceNavigation`（URL 精确等于预期 workspace.html 才 allow）/`isWorkspaceSenderDecision`（sender 匹配视图 + senderFrame 主 frame + 当前 URL 预期三条件全过）/`shouldBroadcastServerLog`（仅 file: 协议广播）；`ERROR_REASON='error'` 固定 reason。
- **main.js 接线**：`workspacePageUrl = pathToFileURL(workspace.html).href`（Windows 实测输出 `file:///D:/...`，与 Electron loadFile 同形态）；workspaceView 四个导航事件（will-navigate/will-redirect preventDefault + did-navigate/did-navigate-in-page）URL 偏离 → `hideWorkspacePanel({destroy:true})` 安全销毁；`setWindowOpenHandler(()=>({action:'deny'}))` 面板一律拒新窗；`isWorkspaceSender` 三条件（sender===wc + `e.senderFrame===e.sender.mainFrame` + `wc.getURL()===workspacePageUrl`）；`logLine` server:log 广播门（主 Web HTTP(S) 不接收，仅本地 file 页）；`workspaceBoundWorkDir` 改为建于 `workspaceBoundSessionContext()` 之上（Changes/Files/Diff 不再仅信任索引 workDir）；六个 handler 走 validate* 白名单，异常 catch 一律 `{ok:false, reason:ERROR_REASON}`（详细 err.message 仅本地日志）；`isKnownServerOrigin` 收敛为 `sw.isTrustedWebOrigin(url, knownServerBase)` 单一来源。
- **session-workspace.js M6 origin 规则**：新增 `isTrustedWebOrigin(url, knownServerBase)`（严格 `new URL(url).origin === new URL(base).origin`；file/外部/非法/空 → false）；`resolveContext` 增 knownServerBase 参数，explicit 仅在"URL 无会话 id 且可信 Web origin"回退——file:// 本地页、外部/未知 origin 一律 candidates/unbound；`computeNavStateUpdate` 增 knownServerBase，changed 且无 id 且非可信 origin → clearExplicit=true（explicit 不得存续于不受信页面），可信 Web 非会话页保留 explicit（既有用途）。
- **语义变更注意**：旧"非法 URL 回退 explicit"/"无 URL（window 销毁）回退 explicit" 被 M6 取代（非法/空 URL=未知 origin 一律不回退）；selectCandidate 非面板 sender reason 由中文改为 'rejected' 与其余 handler 一致；panelState bad-arg 保持现状返回 `{collapsed}`。
- 测试：test-workspace-ipc-guard.js 9 组（URL 精确/恶意/重定向、非主 frame、plain-object/长度矩阵、Web 日志禁止与 file 页允许、main.js 静态接线含四导航事件与固定 reason 零 err.message）；test-session-workspace.js 新增 3 组 origin 测试（isTrustedWebOrigin 矩阵、resolveContext file/外部/未知不 fallback、computeNavStateUpdate 离开可信 origin 清 explicit）+ 旧断言更新（顺带修复 M6 资源上限条目记录的 test-session-workspace.js 既有失败）。验收：node --check 5 文件过、全量 27 个 test-*.js 全绿；未启动 Electron（loadFile 生成 URL 与 pathToFileURL 精确相等的实测、真实导航拒绝/iframe sender 拒绝/日志广播门、sessionDir 缺失的索引条目导致 M3 unbound 的端到端行为需手测）。

## M6 高危可信 origin/导航指纹修复（2026-08-04 完成）

- 只改 `src/main/session-workspace.js`、`src/main/main.js`、`tests/test-session-workspace.js`（UI/投影/文档未动；test-workspace-ipc-guard.js 静态断言无需改仍通过）。缺陷（Oracle finding）：① resolveContext 的 verified URL 分支在 isTrustedWebOrigin 之前返回 bound——evil/file/未知 origin 的 URL 只要携带索引 verified 的 sessionId 就直接 bound；② navFingerprint 无 knownServerBase，可信 A → 非可信同 sessionId B（localhost/HTTPS/base 变化）不 changed，旧 Workspace DOM 保留。
- **resolveContext 重构**：`trusted = isTrustedWebOrigin(url, knownServerBase)` 先行；非可信一律 `{state:'unbound'}`——绝不 bound、绝不 fallback explicit、**绝不展示本地索引候选**（旧实现非可信 URL 走 candidatesOrUnbound 会向外部页泄漏索引条目，本次一并关闭）；explicit 回退仅剩可信 Web 非会话页分支。
- **navFingerprint(url, indexEntries, knownServerBase) 签名扩展**：非可信 → `untrusted:<urlOrigin>`（file 恒 'null'、非法/空 URL → 'untrusted:'）；可信 → `trusted:<origin>:no-session|unverified:<id>|verified:<id>:<workDir>`。可信↔非可信、127.0.0.1↔localhost、HTTP↔HTTPS、knownServerBase 变化但 sessionId 相同（origin 变）均必 changed。NO_SESSION_FP 保留导出但不再产出（兼容注释）。
- **computeNavStateUpdate clearExplicit 反转**（覆盖 2026-08-04 早前"离开可信 origin 清 explicit"语义）：现在只在**可信且 verified URL** 时清 explicit；非可信页/可信非会话页恒 false——explicit 残留内存无安全面（resolveContext origin 规则保证非可信页绝不 fallback），可信非会话页回退是既有用途。
- **main.js 上下文入口统一**：`maybeStartNavRecheck` 启动前加 `isKnownServerOrigin(url)` 守卫（tick 内已有）；`workspace:selectCandidate` 加 `isKnownServerOrigin(mainUrl)` 守卫，非可信 → `{ok:false,reason:'untrusted-origin'}`（防非可信页建立显式绑定入口）；syncWorkspaceNavigationState/resolveWorkspaceContext/navRecheck 已传 knownServerBase 不变。
- 测试：test-session-workspace.js 现有 11 组全量更新至新语义（原 M6 测试断言"离开可信清 explicit"反向）+ 新增 `testResolveContextM6UnboundMatrix`（verified ID + evil/file/未知/别名/协议/端口 → unbound、可信 verified 不回归）+ testComputeNavStateUpdateM6Origin 重写（别名/协议/base 变化 changed、explicit 仅可信 verified 清理、old explicit 非可信保留）。验收：node --check 3 文件过、test-session-workspace 13 组全绿、test-workspace-ipc-guard 全绿、全量 28 个 test-*.js 全绿；未启动 Electron（真实导航到 evil/localhost 页面、selectCandidate 非可信拒绝属运行时，需手测）。

## 经验教训

- **口径决策不得自行变更**：规格明确的口径（如"只聚合 turn 记录"）若觉得有更优实现（如"session 快照取代 turn"），必须先请示 orchestrator，不得擅自改口径——曾因擅自改为 session 快照取代逻辑导致错误（真实 CLI 只写 turn scope，session 累计值无法按时间窗口分桶）。

## M6 Workspace projection 上限缺口补全（2026-08-04 完成）

- 只改 `src/main/subagent-tree.js`、`src/main/task-catalog.js`、`src/main/runtime-state.js`、`src/main/workspace-projection.js` 及 4 份对应测试（main/preload/normalizer/UI/文档未动）。关闭规格五点：① state.json 有限读取 ② 目录流式有界枚举 ③ task/cron 句柄级有限读取 ④ in-memory map/catalog/投影条目上限 ⑤ 小数据行为保持。
- **① state.json**（subagent-tree）：`readAgentsMap(sessionDir, diagnostics)` 改 open+fstat 句柄读取，超 `STATE_MAX_BYTES=512KB` 不整体 JSON.parse → `diagnostics.stateOversized++` + 目录枚举降级不抛；agents 映射条目超 `STATE_MAX_AGENTS=500` 确定性截断 → `stateAgentsTruncated`。**坑：state.json 结构是 `{agents:{...}}`，测试构造须带 agents 包装层**（顶层直接塞 531 个 id 会让 readAgentsMap 提前 return，截断计数恒 0）。
- **② 流式有界枚举**：subagent-tree agents 目录改 `fs.opendirSync`+`readSync()` 逐个读取（不 readdir 全量物化），有效候选达 `AGENTS_ENUM_MAX=1000` 或总条目达 `AGENTS_ENUM_ITEMS_MAX=1500`（垃圾条目洪水保险）即停止 → `enumerateTruncated++`；逐条目 lstat 校验语义（M4 不信 Dirent）不变。task-catalog 新增 `readDirBounded(dir, max)`（`fs.promises.opendir`+`dh.read()`，返回 `{entries, truncated}`），tasks/cron/sessionDir/sessionsRoot 四级枚举均改用它（`TASK_ENUM_MAX=250`/`CRON_ENUM_MAX=150`/`SESSION_DIR_ENTRY_MAX=100`/`SESSION_ENUM_MAX=500`），任一截断 → `diagnostics.enumerateTruncated=true`。既有语义保持：scannedFiles 仍是"扫描候选数"、filesTried 上限后仍 skippedFiles 计数（枚举上限=读取上限+50，18b/18c 的 skipped=5 断言不破坏）。
- **③ task/cron 句柄级读取**：新增 `readJsonBounded(fp, maxBytes, budget)`（`fs.promises.open`→`fh.stat()`→超 maxBytes='oversized'/超剩余预算='budget' 跳过→按 fstat.size 精确读），替代"stat 预检+readFile 无界读"；**bytesRead 记录实际读入（非预检大小）**，文件增长/替换不突破总预算（绝无整文件 readFile）。文件数配额在 fstat 成功后 ++（超大小也占配额，口径不变）。
- **④ 条目上限**：RuntimeState `LIMITS={MAX_TASK_ENTRIES:2000, MAX_USAGE_BUCKETS:200}` + `truncation`（tasksEvicted/usageBucketsEvicted）+ `getTruncation()`；_applyTask 插入新键且满时驱逐 at 最小者（_evictTaskOldest），_applyUsage 驱逐最早插入桶。TaskCatalog `LIMITS` 增 `MAX_CRON_ENTRIES:500/MAX_OBS_ENTRIES:500/MAX_CATALOG_ENTRIES:5000`，`truncation` 实例属性（cronEntriesEvicted/tasktoolObsEvicted/catalogTruncated），observe 插入新键前 `_evictIfFull` 驱逐 at 最小者，getCatalog 最终 entries 超限按 at 降序确定性截断 → `diagnostics.entriesTruncated`。驱逐是内部容量管理**不 emit 'changed'**（changed 契约只约束事件 apply 导致的可见变化）。subagent-tree `MAX_AGENT_NODES:500` 排序后截断 → `nodesTruncated`（计数=截断量）；workspace-projection 导出 `LIMITS={MAX_AGENTS:500, MAX_TASKS:2000}` 独立防线截断 → `diagnostics.truncated:{agents,tasks}`（布尔）。
- 测试新增：subagent-tree 16-19 区块（超大 state 降级不 parse/映射条目截断/1060 目录枚举停 1000 且 nodes=200/节点截断临时改 LIMITS 后 main 优先保留——**临时改 LIMITS 对象属性再恢复是既有测试模式**）；task-catalog 19 区块（枚举 310 文件停 250/19b monkeypatch `fs.promises.open` 返回假 handle 报放大 size→oversized 零读入、19c 报 64B→bytesRead=64 实际读入/budget 截断/临时调 MAX_CATALOG_ENTRIES=4 断言 at 降序保留/cronEntries 驱逐 cc0）；runtime-state 23 区块（MAX_TASK_ENTRIES+50 事件驱逐 t0、usage 桶 220 驱逐最早、全局桶回归）；workspace-projection 8 区块（临时调 LIMITS=1 截断 + 小数据回归）。验收：node --check 4 文件 + 全量 28 个 test-*.js 全绿。

## M6 CronList 规范化资源上限（2026-08-04 完成）

- 只改 `src/main/runtime-event-normalizer.js` + `tests/test-runtime-state.js`（main/task-catalog/UI/文档未动）。关闭规格两点：CronList 的 rawOutput 无长度上限 JSON.parse + 全数组 map 的瞬时 CPU/内存峰值。
- **LIMITS（normalizer 导出）**：`CRON_LIST_RAW_MAX_CHARS: 256*1024`（UTF-16 code unit 长度，JSON.parse **之前**检查，超长不解析）+ `CRON_LIST_MAX_ITEMS: 500`（解析成功后数组条目数上限，与 TaskCatalog.MAX_CRON_ENTRIES 对齐）。`parseCronList` 两条新分支均**回落 rawInput 摘要**（非数组 detail → TaskCatalog CronList 分支 `items=[]` 零 upsert，安全 no-op，不清空既有 cron 观察）。
- **超量数组语义**：整体跳过整个 list 事件（不截断映射——不完整截断数组不可当作完整 snapshot 使用）；上限内（含恰好等于上限）解析映射语义不变。
- 测试第 24 区块：24a monkeypatch 全局 `JSON.parse` 计数哨兵断言超长合法 JSON（`'[{"id":"leaked"}]'+' '.repeat(MAX)`）零 parse 调用 + detail 回落摘要；24b TaskCatalog 消费超限事件 observe=false 且既有 daily-backup 观察完好（无 destructive event）；24c 超量数组（MAX+10 条合法 JSON）不产出 list snapshot 整体跳过；24d 恰等于上限可解析、列表项仍短字段白名单（command 排除）；24e 上限内小列表正常 upsert。**坑：CronCreate completed 建立的条目是终态，CronList upsert 按既有语义不复活终态（TERMINAL 保护）**——24e 断言 daily-backup 保留为 completed、仅新增 nightly-clean，不可断言其被更新为 running。
- 验收：node --check 两文件过、test-runtime-state.js 全绿、全量 29 个 test-*.js 全绿。

## M6 sessionDir 本体校验高危项（2026-08-04 完成）

- 只改 `src/main/main.js` + 新建 `src/main/session-dir-guard.js` + `tests/test-session-dir-guard.js`（UI/session-workspace/投影/任务模块/文档未动）。缺陷（Oracle finding）：workspaceBoundSessionContext() 只做 lexical containment + realpath + basename 校验，根内普通文件或 symlink/junction alias 只要 basename=sessionId 就授权其索引 workDir（M3 Changes/Files/Diff 与 M4 投影依赖此上下文）。
- **新模块 session-dir-guard.js（纯 Node 无 electron）**：`isRealDirectoryBody(p)`——lstatSync 不跟随看本体：空/非字符串/lstat 失败（ENOENT 等）/非目录（普通文件）→ false；`isSymbolicLink()` → false；**兜底 readlink 探测**（旧 Node 上 junction 的 lstat 显示为目录，readlink 仍能解析目标 → false；真实目录 readlink 必抛 EINVAL → true，其他错误保守 false）。实测 Node v24.16：junction 的 lstat 已 `isSymbolicLink()===true`，readlink 兜底是跨版本防御。
- **main.js 接线**：require 于 workspaceGuard 之后；`workspaceBoundSessionContext()` 在类型检查后、**containment/realpath 之前**先 `sessionDirGuard.isRealDirectoryBody(sessionDir)`，失败即 null（unbound）；既有 containment / realpath 二次 containment / canonical basename===sessionId 全部保留不动；M3/M4 仍从同一通过验证的上下文取 workDir/sessionDir（workspaceBoundWorkDir 建于其上）。
- 测试 `tests/test-session-dir-guard.js`（真实 fs 可执行，临时 sessions 目录树）：根内真实目录/嵌套目录通过；普通文件（basename=sessionId 也不授权）拒绝；symlink（根外/根内/dangling 三种，Windows 创建不可用自动跳过）拒绝；junction（Windows `symlinkSync(t,p,'junction')` 无需管理员权限，实测创建成功）拒绝；lstat 失败（不存在/空串/null/非字符串/父路径缺失）拒绝；静态核验调用链（helper 必须 main 实际调用、lstat 先于 realpath、既有校验保留、workspace:changes/files/diff 三 handler 拒绝时返回 'unbound' 不触碰 gitService/fileBrowser）。
- 验收：node --check 三文件过、test-session-dir-guard.js 全绿、全量 29 个 test-*.js 全绿；未启动 Electron（真实 IPC 授权路径属运行时）。
