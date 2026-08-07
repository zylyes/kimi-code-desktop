# Fixer 记忆（kimi-code-desktop）

## 测试约定

- tests/test-*.js 独立脚本，CommonJS 纯 Node 无 electron，`node tests/test-*.js` 直跑；fs/网络/子进程依赖一律注入（fsImpl/fetchImpl/readStreamImpl/spawn 捕获等）解耦，纯函数经 `_internals` 导出
- 临时脚本放 `C:\Users\zyl\AppData\Local\Temp\opencode`（package.json 声明 type:module，CommonJS 脚本须用 .cjs 扩展名）
- 异步测试（temp 目录清理）：不能在 main() 调用外用同步 finally 清理——async 未 await 会提前删目录导致扫描静默跳过
- helper 解构默认值（`{model='kimi-code/k3'}`）会把"未传字段"填成默认值，构造"字段缺失"行须手写 JSON；`JSON.stringify` 省略 undefined 字段（可借此构造缺失字段）
- 时间戳一律 `new Date(y,m-1,d,h,min,s)` 本地构造保证跨时区稳定；每个测试独立 sessionsRoot
- 临时改模块 LIMITS 对象属性、用完恢复，是既有测试模式（测截断/驱逐）
- state.json 结构是 `{agents:{...}}`，测试构造须带 agents 包装层（顶层直接塞条目会让读取提前返回）

## 测试夹具

- `tests/fixtures/` 清单以 manifest.json 为准：usage/（usage-record.jsonl 12 有效+2 非法 JSON+1 缺 usage；usage-updated-ws.json）、tasks/task-events-ws.json、acp/（tool-call-read.json、tool-call-agent.json 无 parent 字段）、cron/cron-tool-events.json、subagents/（wire-main.jsonl/wire-subagent.jsonl 各含 1 坏行；state-nested.json 3 层/state-loop.json 循环/state-orphan.json 缺父）
- wire `usage.record.time` 为 epoch ms（>1e12），非 ISO 字符串；ACP toolCallId 恒为 `{turn序号}:tool_{24位字母数字}`，流式 tool_call_update 只带 status/content（无 title），最终带 title 与完整 rawInput

## 关键数据口径（持久契约，不得自行变更）

- 任务键 `${sessionId||''}:${taskId}`；终态（completed/failed）墓碑不可复活；同键优先级 runtime > cronEntries > 磁盘，内存终态不可被 running 覆盖；'changed' 仅状态实际变化时 emit
- usage 只聚合 `usageScope:'turn'` 记录；'session' 记录仅计 diagnostics.sessionRecords 不参与聚合（真实 CLI 只写 turn scope，session 累计值无法按窗口分桶）；窗口内 turn=0 且 session>0 → summary.partial + reason='session-scope-only' 全零
- 子代理父子关系唯一来源是会话根 state.json 的 agents 映射（v2 main 无 parentAgentId 字段）；无/损坏 → 目录枚举降级全顶层；父缺失/成环 → parentAgentId='__unknown__'
- normalizeWsEvent：task.* 取值 raw/payload/info 三层（顶层优先）；subagent.spawned/started → task.observed（source:'ws'、taskId=subagentId、agentType=subagentName）；task.done→completed；agent.created/agent.status.updated 保守 null；CronList rawOutput 超 CRON_LIST_RAW_MAX_CHARS=256KB 不 parse、条目超 CRON_LIST_MAX_ITEMS=500 整体跳过，均回落 rawInput 摘要
- 元信息降级保护：同 key 非终态更新时，新事件 title/agentType 为空或通用值 'subagent' 且旧值更具体 → 保留旧值
- 口径决策不得自行变更：有"更优实现"想法（如 session 快照取代 turn）须先请示 orchestrator，曾因擅自变更导致错误

## 实测踩坑（Windows）

- Node 24 `dir.read()` 返回 Dirent（非字符串），name 须 `typeof entry==='string' ? entry : entry.name`；Dirent 可直接 isSymbolicLink() 预跳过
- fstat `{bigint:true}` 的 size 为 bigint，`Buffer.alloc` 前必须 `Number(st.size)`（≤1MB 无精度损失）
- Buffer for-of 直接产出字节数字，单 Buffer 元素须包装成数组
- `git commit` 提交全部 staged——测试夹具须 base 一次提交，之后变更不再 commit
- Windows git 拒绝 \t/\n 路径（update-index "Invalid path"），只能喂合成 NUL 流测解析器；numstat 末行无 \n 会显示 2/1，测试文件须 \n 结尾 + core.autocrlf=false
- Windows Node 无 O_NOFOLLOW/openat，无法原子拒绝 reparse 点——用「lstat 快照→open→fstat 比对」+ canonical 二次校验 + 严格 symlink/junction 拒绝（防御深度而非原子承诺）
- `GIT_LITERAL_PATHSPECS='1'` 环境变量统一注入 git 调用，防 pathspec magic 解析（`--` 后的 path 仍被解析为 glob）
- junction 的 lstat.isSymbolicLink() 恒 true（Node v24.16 实测）；旧 Node 上 junction 显示为目录，readlink 兜底探测是跨版本防御

## 核心模块契约速查

- file-browser.js：LIMITS={FILE_MAX_BYTES:1MB, LIST_MAX_ENTRIES:500}；opendir 流式收集满 LIMITS+1 停；跳过 .git/node_modules 恒不可绕过；symlink/junction 严格拒绝；reason：escape-denied/excluded-path/symlink-denied/is-directory/binary-file/not-found/not-a-directory/unreadable/bad-arg；大文件 open+read 按长度截读（fs.readFile 的 {length} 仅 fd 形式生效）
- git-service.js：LIMITS={GIT_TIMEOUT_MS:10000, DIFF_MAX_BYTES:500KB, DIFF_MAX_LINES:2000}；snapshotId 仅内存 LRU(≤20) 可解析→stale-snapshot；porcelain v2 -z 单条记录=单 NUL 字段、header 与 path 空格分隔；numstat rename src/dst 两独立 NUL 字段、键用 dst；git-missing/not-git-repo
- task-catalog.js：getCatalog→{entries,diagnostics}；sessionDir 三态 absent（全量扫描）/invalid（不读盘，写 diagnostics.invalidSessionDir）/direct（只读该目录，须 basename(realpath)===sessionId）；observe(event)→boolean（cron/tasktool 变更信号）；LIMITS：MAX_CRON_ENTRIES:500/MAX_OBS_ENTRIES:500/MAX_CATALOG_ENTRIES:5000 + TASK_MAX_BYTES:512KB/TASK_MAX_FILES:200/TASK_TOTAL_BYTES:4MB + CRON_MAX_BYTES:512KB/CRON_MAX_FILES:100/CRON_TOTAL_BYTES:2MB；驱逐不 emit 'changed'
- subagent-tree.js：buildSubagentTree(sessionDir,{sessionId})→{ok,nodes,diagnostics}；status 推断确定性不依赖时钟（无 step→unknown/未闭合→running/全闭合→最后 step 状态）；LIMITS：WIRE_MAX_BYTES:4MB/WIRE_MAX_FILES:200/WIRE_TOTAL_BYTES:8MB、STATE_MAX_BYTES:512KB/STATE_MAX_AGENTS:500、AGENTS_ENUM_MAX:1000/AGENTS_ENUM_ITEMS_MAX:1500、MAX_AGENT_NODES:500、MAX_LOOP_EVENTS:5000、步骤上限 200；wire 截断只保留完整行（lastIndexOf('\n')，残行连同 '\r' 丢弃）；链接一律跳过计 skippedLinks
- runtime-state.js：getUsageSnapshot 全局桶（sessionId||'__global__'）无桶回零值；getActiveCounts 按 agentType 非 null 计 agents/null 计 tasks；LIMITS={MAX_TASK_ENTRIES:2000, MAX_USAGE_BUCKETS:200}+truncation/getTruncation()
- session-workspace.js：isValidSessionId（≤128、仅 [A-Za-z0-9_-]）、parseSessionIdFromUrl、resolveBySessionId、listCandidates(limit=20)、computeNavStateUpdate（explicit 仅可信 verified URL 清理）、navFingerprint（untrusted:<origin>/trusted:<origin>:...）、isTrustedWebOrigin（origin 严格相等）、resolveContext（explicit 仅"可信 Web 非会话页"回退；URL 合法未 verified 绝不回退 explicit；非可信一律 unbound 且不展示本地候选）
- workspace-ipc-guard.js：isPlainObject+hasOnlyKeys、validatePanelState/validateSelectCandidate/validateFilesArg（relPath≤512）/validateDiffArg、isWorkspaceSenderDecision（sender 匹配+主 frame+URL 精确三条件）、decideWorkspaceNavigation、shouldBroadcastServerLog（仅 file: 协议）、ERROR_REASON='error'（拒绝消息不回传 err.message）
- session-dir-guard.js：isRealDirectoryBody（lstat 不跟随：非目录/symlink→false；readlink 兜底——真实目录必抛 EINVAL）；失败即 unbound，校验先于 containment/realpath
- workspace-projection.js：getWorkspaceProjection→{agents,tasks,diagnostics,capturedAt}；失败态 unbound/invalid-session-dir/no-catalog/catalog-error（不抛）；LIMITS={MAX_AGENTS:500, MAX_TASKS:2000}
- managed-usage.js：fetchManagedUsage({fetchImpl,token,baseUrl,timeoutMs=8000,now})→{kind:ok/unavailable/auth-required/error,plans,wallet,fetchedAt,staleAt=+60s}；无 token→unavailable 不发请求；401→auth-required；金额 1e6 fixed-point→分（/1e4 四舍五入）；loadOAuthToken 读 <home>/credentials/kimi-code.json
- acp-question-window.js：ElicitationIdentity（begin/retire 状态机，所有收尾路径先 retire 再结算）；canSettleAcpElicitation（sender 当前窗+owner='acp'+QID=acp-elicitation+windowEpoch/windowSettle/identity 全匹配）；settleWindowElicitationCancelled 只结算捕获身份，绝不读全局当前身份
- acp-permission-window.js：planPermissionLoadFail（close 之前调用，引用级相等才 fallback）；decidePermissionRespond（windowActive+sender 当前窗+settle/params 引用级匹配）；runPermissionFallbackDialog（对话框不可用→settle cancelled 不悬挂）；parsePermissionRespond
- notification-nav.js：collectProvidedSessionIds（区分字段缺失与存在但非法 presentInvalid）；approvalNavSessionId/completionNavSessionId（全源合法且一致才返回，presentInvalid→null）；decideNotificationNav（epoch/base/可信 token/未在目标会话全过才导航，URL 只由当前 base/token 构造）
- overlay-context-sync.js：noteContextWhileOverlay（context 置位幂等合并，非 context 不积压）/drainContextAfterOverlay（重挂补发一次；collapsed 不补发但复位）
- workspace-restore.js：createWorkspaceRestore({sendContext,reload,mount,isViewUsable,ackTimeoutMs=3000,reloadAckTimeoutMs=5000})；overlay 关闭且 stale 时绝不直接挂回——先发 {kind:'context',restoreId} 等 renderer ack 才单次挂回；ack 超时→受控 reload 再等 ack；reload 后仍超时→兜底挂回；取消后迟到 ack/超时回调一律不得再挂回（current 引用+stage 双重校验）；pending 期间 pushWorkspaceEvent 以 isPending 拦截
