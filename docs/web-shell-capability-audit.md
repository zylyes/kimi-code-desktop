# Web Shell 增强计划 M1：能力审计报告（Web 服务端 REST / AsyncAPI / WS 实测）

| 项 | 值 |
| --- | --- |
| 文档性质 | Web Shell 增强计划 M1 正式交付物（能力审计报告），后续 M3/M4/M5 数据源决策的唯一依据 |
| 实测日期 | 2026-08-03 |
| 被测实例 | CLI 0.31.1（本地 HTTP 服务，`http://127.0.0.1:58997`，Windows 桌面宿主） |
| 探测工具 | `scripts/capability-audit.js 58997`（exit 0）、`scripts/ws-event-probe.js 58997`（exit 0） |
| 探测数据源 | `C:\Users\zyl\AppData\Local\Temp\opencode\capability-audit-result.json`、`C:\Users\zyl\AppData\Local\Temp\opencode\ws-probe-result.log` |
| 来源计划 | `docs/WEB_SHELL_ENHANCEMENT_PLAN.md` v1.2（定稿，M1-1~M1-5、§3.2、§4.2、§8.3） |

> 结论标记约定：✅ 已实测确认 ｜ ❌ 实测不存在 ｜ 🔍 待实测（未证实） ｜ ⚠️ 警示/需复核。所有结论均标注来源（capability-audit / ws-probe）与实测日期 2026-08-03；本报告不虚构任何未实测内容。

---

## 1. REST 能力矩阵

来源：`capability-audit-result.json`（`/openapi.json` 全量登记，`pathCount: 76`，HTTP 200；探测时间 `probedAt: 2026-08-03T06:44:30Z`）。共 76 个端点，以下按类别列出。

### 1.1 概览

| 类别 | 端点数 | 关键结论 |
| --- | --- | --- |
| sessions | 26 | 会话枚举/任务/归档 ✅；**删除端点未命中** |
| models | 2 | 模型列表/调用 ✅ |
| usage | 1 | `GET /api/v1/oauth/usage` ✅；`/api/v1/usage` ❌ 404 |
| files/diff | 2 | 仅上传附件管理；**无独立 diff API** |
| prompts | 3 | ✅ |
| approvals | 2 | 列表 + 批准 POST ✅（实测 200 闭环） |
| questions | 2 | 列表 + 作答 POST ✅（实测 200 闭环） |
| ws | 1 | `/asyncapi.json` ✅（HTTP 200） |
| shutdown | 1 | `POST /api/v1/shutdown` ✅ |
| 其他 | 36 | fs:* / workspaces / providers / mcp / search / tools / connections / gui/store / healthz / meta / auth / config / openapi.json / 静态兜底等 |
| **合计** | **76** | |

### 1.2 sessions 类（26 条，全录）

| # | 路径 | 方法 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | `/api/v1/sessions` | GET / POST | ✅ | **会话枚举 GET 实测 200**（`probes.sessions: 200`） |
| 2 | `/api/v1/sessions/{session_id}` | GET | ✅ | 会话详情 |
| 3 | `/api/v1/sessions/{session_id}/profile` | GET / POST | ✅ | |
| 4 | `/api/v1/sessions/{session_id}/children` | GET / POST | ✅ | |
| 5 | `/api/v1/sessions/{session_id}/status` | GET | ✅ | |
| 6 | `/api/v1/sessions/{session_id}/goal` | GET | ✅ | |
| 7 | `/api/v1/sessions/{session_id}/warnings` | GET | ✅ | |
| 8 | `/api/v1/sessions/{session_id}/export` | POST | ✅ | |
| 9 | `/api/v1/sessions/{session_id}/skills` | GET | ✅ | |
| 10 | `/api/v1/sessions/{session_id}/skills/{tail}` | POST | ✅ | |
| 11 | `/api/v1/sessions/{session_id}/messages` | GET | ✅ | |
| 12 | `/api/v1/sessions/{session_id}/messages/{message_id}` | GET | ✅ | |
| 13 | `/api/v1/sessions/{session_id}/tasks` | GET | ✅ | **会话级任务列表（M4 对账候选）** |
| 14 | `/api/v1/sessions/{session_id}/tasks/{task_id}` | GET | ✅ | **会话级任务详情** |
| 15 | `/api/v1/sessions/{session_id}/tasks/{tail}` | POST | ✅ | |
| 16 | `/api/v1/sessions/{session_id}/{tail}` | POST | ✅ | 通配动作 |
| 17 | `/api/v1/sessions/{session_id}/fs/{*}` | GET | 🔍 | 会话级 FS 读取，语义待评估（§1.9） |
| 18 | `/api/v1/sessions/{session_id}/terminals` | GET / POST | ✅ | |
| 19 | `/api/v1/sessions/{session_id}/terminals/{terminal_id}` | GET | ✅ | |
| 20 | `/api/v1/sessions/{session_id}/terminals/{tail}` | POST | ✅ | |
| 21 | `/api/v1/sessions/{session_id}/snapshot` | GET | ✅ | |
| 22 | `/api/v1/sessions/{session_id}/transcript` | GET | ✅ | |
| 23 | `/api/v1/sessions/{session_id}/transcript/ops` | GET | ✅ | |
| 24 | `/api/v1/sessions/{session_id}/transcript/user-messages` | GET | ✅ | |
| 25 | `/api/v1/sessions/{session_id}/transcript/plan` | GET | ✅ | |
| 26 | `/api/v1/sessions/{session_id}:archive` | POST | ✅ | **归档自定义动词命中**（`serverCapsCheck.archive.matched: true`） |

**删除端点结论**（来源：`serverCapsCheck.delete`）：`matched: false`，detail 为 null——`/openapi.json` 全量 76 端点中**无 `:delete` 自定义动词、无会话级 DELETE 方法**。现有 `detectServerCaps()` 的 `delete=false` 判断与 0.31.1 实测一致，**无需修正**；会话删除不存在 REST 通道，不纳入本计划数据源。

### 1.3 models 类（2 条）

| 路径 | 方法 | 状态 | 备注 |
| --- | --- | --- | --- |
| `/api/v1/models` | GET | ✅ | 模型列表，**实测 200**（`probes.models: 200`；`serverCapsCheck.models.matched: true`） |
| `/api/v1/models/{tail}` | POST | ✅ | 模型调用 |

### 1.4 usage 类（1 条）

| 路径 | 方法 | 状态 | 备注 |
| --- | --- | --- | --- |
| `/api/v1/oauth/usage` | GET | ✅ | 用量查询（已登记；字段/语义待确认） |
| `/api/v1/usage` | — | ❌ | **实测 404**（`probes.usage: 404`），该路径不存在 |

### 1.5 files/diff 类（2 条）

| 路径 | 方法 | 状态 | 备注 |
| --- | --- | --- | --- |
| `/api/v1/files` | POST | ✅ | 上传附件管理（非工作树文件） |
| `/api/v1/files/{file_id}` | GET / DELETE | ✅ | 附件读取/删除 |

**无独立 diff API 结论**：76 端点中**无任何 `/diff` 端点**（路径扫描无 diff 前缀/子路径）。→ **M3 Changes 必须走本地 git**（`git status --porcelain=v2 -z` + `git diff --numstat -z` 等，按计划 §8.1/M3-1 契约），不得依赖服务端 diff。

### 1.6 prompts 类（3 条）

| 路径 | 方法 | 状态 |
| --- | --- | --- |
| `/api/v1/sessions/{session_id}/prompts` | GET / POST | ✅ |
| `/api/v1/sessions/{session_id}/prompts:steer` | POST | ✅ |
| `/api/v1/sessions/{session_id}/prompts/{tail}` | POST | ✅ |

### 1.7 approvals 类（2 条）

| 路径 | 方法 | 状态 | 备注 |
| --- | --- | --- | --- |
| `/api/v1/sessions/{session_id}/approvals` | GET | ✅ | 审批列表 |
| `/api/v1/sessions/{session_id}/approvals/{approval_id}` | POST | ✅ | **批准实测 HTTP 200 有效**（ws-probe：`approval_id=tool_U8CNOxnEWyStRt3wfXjxvyk1 -> HTTP 200`） |

### 1.8 questions 类（2 条）

| 路径 | 方法 | 状态 | 备注 |
| --- | --- | --- | --- |
| `/api/v1/sessions/{session_id}/questions` | GET | ✅ | 问答列表 |
| `/api/v1/sessions/{session_id}/questions/{tail}` | POST | ✅ | **作答实测 HTTP 200 有效**（ws-probe：`question_id=tool_tvjUGDaupIoAjdtyIF7MO7B7 -> HTTP 200`，作答后收到 `event.question.answered`） |

### 1.9 其他类（36 条，合并计数 + 代表性端点）

| 路径 | 方法 | 状态 | 备注 |
| --- | --- | --- | --- |
| `/api/v1/fs:browse` | GET | 🔍 | 疑似 web UI 文件选择器后端，语义待评估 |
| `/api/v1/fs:content` | GET | 🔍 | 同上 |
| `/api/v1/fs:home` | GET | 🔍 | 同上 |
| `/api/v1/fs:mkdir` | POST | 🔍 | 同上 |
| `/api/v1/workspace/fs:search` | POST | 🔍 | 工作区 FS 搜索，语义待评估 |
| `/api/v1/sessions/{session_id}/fs/{*}` | GET | 🔍 | 见 §1.2 #17 |
| `/api/v1/workspaces` | GET / POST | ✅ | 工作区管理 |
| `/api/v1/workspaces/{workspace_id}` | DELETE / PATCH | ✅ | |
| `/api/v1/workspaces/{workspace_id}/skills` | GET | ✅ | |
| `/api/v1/workspaces/{workspace_id}/trust` | GET / POST | ✅ | |
| `/api/v1/workspaces/{workspace_id}/untrust` | POST | ✅ | |
| `/api/v1/providers` | GET / POST | ✅ | |
| `/api/v1/providers/{provider_id}` | GET / PUT / DELETE | ✅ | |
| `/api/v1/providers{action}` | POST | ✅ | |
| `/api/v1/providers/{tail}` | POST | ✅ | |
| `/api/v1/catalog/providers` | GET | ✅ | |
| `/api/v1/catalog/providers/{catalog_id}` | GET | ✅ | |
| `/api/v1/mcp/servers` | GET | ✅ | |
| `/api/v1/mcp/servers/{tail}` | POST | ✅ | |
| `/api/v1/search` | POST | ✅ | |
| `/api/v1/tools` | GET | ✅ | |
| `/api/v1/connections` | GET | ✅ | |
| `/api/v1/gui/store/getItem` | GET | ✅ | GUI 状态存储 |
| `/api/v1/gui/store/setItem` | POST | ✅ | |
| `/api/v1/gui/store/removeItem` | POST | ✅ | |
| `/api/v1/gui/store/clear` | POST | ✅ | |
| `/api/v1/gui/store/length` | GET | ✅ | |
| `/api/v1/healthz` | GET | ✅ | 健康检查 |
| `/api/v1/meta` | GET | ✅ | |
| `/api/v1/auth` | GET | ✅ | |
| `/api/v1/oauth/login` | GET / POST / DELETE | ✅ | |
| `/api/v1/oauth/logout` | POST | ✅ | |
| `/api/v1/oauth/userinfo` | GET | ✅ | |
| `/api/v1/config` | GET / POST | ✅ | |
| `/openapi.json` | GET | ✅ | schema 自身（200） |
| `/`、`/{*}` | GET | ✅ | 静态/兜底路由 |

**文件类语义评估结论**：`/api/v1/files`（POST 上传）与 `/files/{file_id}`（GET/DELETE）确认为**上传附件管理**；`fs:browse / fs:content / fs:home / fs:mkdir / workspace/fs:search / sessions/{id}/fs/{*}` 疑为 **web UI 自身文件选择器/会话附件 FS**——本次仅登记存在性（openapi 登记），**未做授权语义与路径边界实测（🔍 待实测）**，不构成面板 Files 数据源的已证实能力。→ M3 Files 采用主进程 `file-browser.js` 白名单方案（§5.3/M3-3），不依赖 fs:* REST。

---

## 2. AsyncAPI 结论

来源：`capability-audit-result.json`（`asyncapi` 段，`status: 200, exists: true`；实测日期 2026-08-03）。

| 项 | 值 |
| --- | --- |
| 端点 | `/asyncapi.json` **✅ 存在（HTTP 200）** |
| channel | `kimiCodeWebSocket`（1 个） |
| operations | `receiveClientMessages`（客户端→服务端）、`sendServerMessages`（服务端→客户端） |
| 消息数 | 32 条（client 侧 16 / server 侧 16） |

消息清单（32 条全录）：

| 方向 | 消息 |
| --- | --- |
| client → server | `client_hello`、`subscribe`、`subscribe_v2`、`unsubscribe_v2`、`unsubscribe`、`watch_fs_add`、`watch_fs_remove`、`abort`、`terminal_attach`、`terminal_detach`、`terminal_input`、`terminal_resize`、`terminal_close`、`pong`（14 条） |
| server → client | `client_hello_ack`、`subscribe_ack`、`subscribe_v2_ack`、`unsubscribe_v2_ack`、`unsubscribe_ack`、`watch_fs_add_ack`、`watch_fs_remove_ack`、`abort_ack`、`terminal_attach_ack`、`terminal_detach_ack`、`terminal_input_ack`、`terminal_resize_ack`、`terminal_close_ack`、`server_hello`、`ping`、`resync_required`、`error`、`session_event`（18 条） |

要点：

1. **存在 v2 订阅协议**：`subscribe_v2 / subscribe_v2_ack / unsubscribe_v2 / unsubscribe_v2_ack`，并配套 `resync_required`（断线重同步信号）。**桌面当前使用 v1 `subscribe`，未使用 v2 与 resync 机制**（ws-probe 中 ack 消息实测含 `cursors` / `resync_required` 字段，为 v2 协议特征，见 §3.3 envelope）。
2. **存在 fs 监视消息**：`watch_fs_add / watch_fs_remove`（含 ack）。桌面当前未使用；M3 Files 首版仍按计划走主进程白名单 file-browser，不接入 watch_fs（可作后续增强候选，本次不采用）。
3. **业务事件统一封装在 `session_event` 内**：server 侧仅 `session_event` 一个业务承载消息，事件类型在消息体内以 `type` 字段区分——与 §3 实测的 28 种事件一一对应。
4. `terminal_*`（attach/detach/input/resize/close）为终端通道消息，与桌面当前终端集成无直接关系，登记不采用。

---

## 3. WS 事件普查（28 种实测事件）

来源：`ws-probe-result.log`（`scripts/ws-event-probe.js 58997`，exit 0；审批/问答探测 PASS）。观测方式：活跃会话（`session_d98864c1-1a3c-490c-a04c-aa537d1b4b2e`）期间全程记录事件名与 payload 键，观察窗口约 120s（Task 子代理观测段）。

### 3.1 事件总表（28 种，按日志顺序）

| # | 事件名 | 次数 | payload 键（实测） | 与 normalizer 白名单关系 |
| --- | --- | --- | --- | --- |
| 1 | `server_hello` | 1 | capabilities:object, max_event_buffer_size:number, protocol_version:number, ws_connection_id:string | 未覆盖（normalizer 丢弃） |
| 2 | `ack` | 2 | accepted_subscriptions:array, cursors:object, resync_required:array, accepted:array, not_found:array | 未覆盖 |
| 3 | `agent.status.updated` | **54** | agentId, contextTokens:number, maxContextTokens:number, model, sessionId, thinkingEffort, type, **usage:object**, phase:object | **未覆盖（重要，见 §3.4）** |
| 4 | `session.meta.updated` | 3 | agentId, patch:object, sessionId, type | 未覆盖 |
| 5 | `turn.started` | 4 | agentId, origin:object, prompt, sessionId, turnId:number, type | 未覆盖 |
| 6 | `event.session.work_changed` | 9 | agentId, busy:boolean, main_turn_active:boolean, pending_interaction, sessionId, type, last_turn_reason | 未覆盖 |
| 7 | `context.spliced` | 7 | agentId, deleteCount:number, messages:array, sessionId, start:number, type | 未覆盖 |
| 8 | `turn.step.started` | 7 | agentId, sessionId, step:number, stepId, turnId:number, type | 未覆盖 |
| 9 | `thinking.delta` | 39 | agentId, delta, sessionId, turnId:number, type | 未覆盖（流式） |
| 10 | `tool.call.delta` | **88** | agentId, argumentsPart, name, sessionId, toolCallId, turnId:number, type | 未覆盖（流式） |
| 11 | `permission.approval.requested` | 1 | **action, agentId, display:object, sessionId, toolCallId, toolInput:object, toolName, turnId:number, type** | 未覆盖（**新审批流**） |
| 12 | `event.approval.requested` | 1 | action, agentId, **approval_id**, created_at, expires_at, sessionId, session_id, tool_call_id, **tool_input_display:object**, tool_name, turn_id:number, type | 未覆盖（**旧审批流，桌面现行消费**） |
| 13 | `event.approval.resolved` | 1 | agentId, approval_id, decision, resolved_at, sessionId, type | 未覆盖 |
| 14 | `permission.approval.resolved` | 1 | action, agentId, decision, display, sessionId, toolCallId, toolInput, toolName, turnId:number, type | 未覆盖 |
| 15 | `tool.call.started` | 3 | agentId, args:object, description, display:object, name, sessionId, toolCallId, turnId:number, type | 未覆盖 |
| 16 | `tool.progress` | 1 | agentId, sessionId, toolCallId, turnId:number, type, update:object | 未覆盖 |
| 17 | `tool.result` | 3 | agentId, output, sessionId, toolCallId, turnId:number, type | 未覆盖 |
| 18 | `turn.step.completed` | 5 | agentId, finishReason, llmClientConsumeMs, llmFirstTokenLatencyMs, llmRequestBuildMs, llmServerDecodeMs, llmServerFirstTokenMs, llmStreamDurationMs, providerFinishReason, rawFinishReason, sessionId, step, stepId, turnId:number, type, usage:object | 未覆盖 |
| 19 | `assistant.delta` | 4 | agentId, delta, sessionId, turnId:number, type | 未覆盖（流式） |
| 20 | `turn.ended` | 2 | agentId, durationMs:number, reason, sessionId, turnId:number, type | 未覆盖 |
| 21 | `prompt.completed` | 2 | agentId, finishedAt, promptId, reason, sessionId, type | 未覆盖 |
| 22 | `event.question.requested` | 1 | agentId, created_at, **question_id**, questions:array, sessionId, session_id, tool_call_id, turn_id:number, type | 未覆盖（**桌面现行消费**） |
| 23 | `event.question.answered` | 1 | agentId, answers:object, question_id, resolved_at, sessionId, type | 未覆盖 |
| 24 | `agent.created` | 1 | agentId, sessionId, type | **未覆盖（子代理相关）** |
| 25 | `subagent.spawned` | 1 | agentId, callerAgentId, **description, parentAgentId, parentToolCallId, runInBackground:boolean, subagentId, subagentName**, sessionId, type | **未覆盖（子代理相关）** |
| 26 | `subagent.started` | 1 | agentId, sessionId, subagentId, type | **未覆盖（子代理相关）** |
| 27 | `task.started` | 1 | **agentId, info:object, sessionId, type** | **已覆盖（白名单内）⚠️ 字段差异，见 §3.4** |
| 28 | `background.task.started` | 1 | agentId, info:object, sessionId, type | 未覆盖 |

白名单内未触发（120s 观察窗口内未出现，**未触发 ≠ 不存在**，来源：ws-probe 对比段）：

| 事件 | 状态 | 说明 |
| --- | --- | --- |
| `task.progress` | 未触发 | 白名单内，窗口内未见（本次任务可能未产生 progress） |
| `task.completed` | 未触发 | 白名单内，窗口内未见（任务超时未完成） |
| `task.done` | 未触发 | 白名单内，窗口内未见 |
| `session.usage_updated` | **未触发** | **白名单内但全程未出现**——用量数据实测改由 `agent.status.updated` 推送（§3.4） |

### 3.2 关键结论摘要

- **白名单内已覆盖**：`task.started` ✅（唯一在 28 种实测事件中被 normalizer 保留的事件）。
- **白名单内未触发**：`task.progress`、`task.completed`、`task.done`、`session.usage_updated`（均标注"未触发 ≠ 不存在"）。
- **未覆盖（normalizer 丢弃）的重要事件**：`agent.created`、`subagent.spawned`、`subagent.started`、`agent.status.updated`（54 次，含 usage/contextTokens/maxContextTokens/phase/model/thinkingEffort）、`session.meta.updated`、`event.session.work_changed`（busy/main_turn_active/pending_interaction）、`turn.*` 全生命周期（started/step.started/step.completed/ended）、流式事件（thinking.delta/assistant.delta/tool.call.delta）、`tool.call.started`/`tool.progress`/`tool.result`、`permission.approval.requested/resolved`（新审批流）、`prompt.completed`、`context.spliced`、`background.task.started`。

### 3.3 envelope 形态（实测）

| 字段 | 说明 |
| --- | --- |
| `epoch` / `seq` / `session_id` / `timestamp` / `type` / `volatile` | 业务事件统一 envelope（`server_hello` 与 `ack` 例外，见下） |
| `volatile:boolean` | 流式事件（thinking.delta / assistant.delta / tool.call.delta / tool.progress）与 server_hello/ack 出现，业务终态事件无 |
| `ack` 载荷 | 含 `cursors:object` / `resync_required:array` / `accepted_subscriptions` / `accepted` / `not_found`——**v2 协议特征**，与 §2 AsyncAPI 的 `subscribe_v2`/`resync_required` 消息对应 |

### 3.4 字段差异与漂移警示（对桌面现有消费逻辑的影响）

1. **`task.started` 字段差异（⚠️ 需修 normalizer）**：实测 payload 为 `{ agentId, info:object, sessionId, type }`——**`task_id`/`title` 不在顶层**（疑在 `info` 对象内，本次未展开记录）。现有 normalizer 取值路径 `payload.task_id || payload.taskId`（按计划 §3.2 描述）**与 0.31.1 实际形态不匹配**。M4 启用 Tasks 前必须实测 `info` 内部结构并修正取值路径。

2. **用量事件漂移（⚠️ 影响面超本计划，登记待办）**：`session.usage_updated` 全程未触发；**用量数据实测经 `agent.status.updated` 推送**（payload 含 `usage:object` + `contextTokens`/`maxContextTokens`，54 次高频）。桌面托盘/用量面板现行依赖 `session.usage_updated` 的链路**需复核**——本次不擅改，登记为待办（§5）。

3. **审批双流并存**：
   - 旧流 `event.approval.requested`：`approval_id` / `expires_at` / `tool_input_display` / `tool_call_id` / `tool_name` / `action`——**桌面现行消费**；对应 REST 批准 `POST /approvals/{approval_id}` 实测 200 有效。
   - 新流 `permission.approval.requested`：`toolCallId` / `toolInput` / `toolName` / `display` / `action`——**与旧流双流并存**（同一工具调用两条事件各 1 次）。
   - 决议：M5 继续消费旧流（REST 闭环实测有效），新流仅登记不消费（§5 决策表）。

4. **问答字段形态（与桌面 handleQuestionRequested 兼容 ✅）**：`event.question.requested` 含 `question_id` + `questions` 数组；首题键 `id` / `question` / `options` / `allow_other`，选项数 2；REST 作答 `POST /questions/{tail}` 实测 200，作答后收到 `event.question.answered`。与桌面 `handleQuestionRequested` 现有取值（`payload.question_id`、`questions[0].id/question/options`）**兼容**。

5. **子代理事件结论：存在（✅）**——§8.3 条件启用前提已满足：
   - `subagent.spawned`：含 `parentAgentId` / `parentToolCallId` / `subagentId` / `subagentName` / `runInBackground:boolean` / `description` / `callerAgentId`；
   - `subagent.started`：含 `subagentId`；
   - `agent.created`：含 `agentId`；
   - 另 `agent.status.updated` 54 次提供 agent 状态/用量/上下文窗口数据。
   - **但终止态事件（`subagent.completed/failed/stopped` 等）未在 120s 窗口内观察到**（探测段任务超时未完成）——M4 需以更长任务补测确认终止态形态后，再完成 normalizer 映射（§6 待实测项）。

### 3.5 会话切换可探测性（M1-5，nav-probe 实测）

来源：`scripts/nav-probe.js 58997`（`npx electron`，exit 0；实测日期 2026-08-03；探测输出 `nav-probe-result.log`）。只建会话不发 prompt，不消耗额度。

| 探测项 | 实测结论 | 证据 |
| --- | --- | --- |
| 会话 URL 形态 | **`/sessions/<sessionId>`——pathname 直接携带完整 sessionId（高置信会话识别可行 ✅）** | 候选 `/sessions/session_ab5319fc-…` 加载后页面出现探测标题 `kcd-nav-probe`；`/chat/<id>`、`/session/<id>` 均被 SPA 重定向回 `/sessions/<最近活跃会话>`，无效 |
| `did-navigate-in-page` 捕获 SPA 路由 | **✅ 可捕获**：loadURL 后 web UI 内部重定向均产生 `did-navigate-in-page` 事件（日志多条记录） | 每次候选加载后均捕获 `did-navigate-in-page …/sessions/session_…`（含 `/chat/<id>` → `/sessions/<id>` 的 SPA 重定向）。注：脚本结论行"未触发"系 REST 分支未更新判定标志所致，以日志事件为准 |
| token 处理 | web UI 消费 `#token=` 后清空 hash（加载后 `hasToken:false`） | dump 首页/候选页 hash 均为空 |
| 首页行为 | 加载首页自动恢复**最近活跃会话**（重定向至其 `/sessions/<id>`） | 首页 did-finish-load 后实际落在 `/sessions/session_d98864c1-…` |
| 会话切换入口形态 | 页面**无 `<a href>` 会话链接**（侧边栏为 JS 组件），会话切换感知只能依赖导航事件，不可用锚点枚举 | 各 dump 的 `links:[]` |
| 工作目录可得性 | **URL 仅携带 sessionId，不含 workDir**——workDir 须经 `sessionId → GET /api/v1/sessions/{id}`（详情是否含 cwd/metadata 🔍 未实测）或 `session_index.jsonl` 双向核对取得 | 形态实测 + §5 #5 |

**M1-5 结论**：探测源 ① `did-navigate-in-page`（**高置信**，URL pathname 携带完整 sessionId，会话切换即时可感）+ ② WS `session.*` 事件（辅助）+ ③ `session_index.jsonl`（低置信，仅候选展示）。按计划 §5.3：`did-navigate` 明确会话标识 + 本地索引双向核对 → 可升级为已验证映射后授权 Files/Git 读取；仅凭 URL 不含 workDir，**未核对前不得授权**。

---

## 4. 对 M3/M4/M5 数据源选型的结论（决策表）

每行结论可回溯到上文条目；依据均为 2026-08-03 实测。

| 里程碑 | 数据源选型 | 依据（本文条目） | 备注/动作 |
| --- | --- | --- | --- |
| M3 Changes | **本地 git**（`git status --porcelain=v2 -z` + `git diff --numstat -z` + `git diff --cached --numstat -z`） | §1.5 无独立 diff API（76 端点无 `/diff`） | 无服务端 diff 可选，按计划 M3-1/§8.1 契约实施 |
| M3 Files | **主进程 `file-browser.js` 白名单**（根 = 已验证活动会话工作目录） | §1.9 fs:* REST 语义未证实（🔍），不采用；`sessions/{id}/fs/{*}` 同待评估 | watch_fs 消息已登记但本次不采用（§2 要点 2） |
| M4 Tasks | **WS `task.*` + 磁盘 `tasks/*.json`** + 可选 **REST `/sessions/{id}/tasks`、`/tasks/{task_id}` 对账** | §1.2 #13/#14 端点 ✅；§3.1 #27 `task.started` 白名单已覆盖 | **⚠️ `task.*` payload 字段差异需修 normalizer**（`task_id`/`title` 不在顶层，§3.4-1）；`task.progress/completed/done` 未触发≠不存在，保留白名单 |
| M4 Agents | **磁盘快照（必需）** + **WS 实时流启用**（`subagent.spawned`/`subagent.started` + `agent.status.updated`，扩展 normalizer） | §3.4-5 子代理事件存在，§8.3 条件启用前提已满足 | 扩展 `runtime-event-normalizer` 新增 `subagent.*`/`agent.*` 映射、使 `agentType` 可判后启用实时流；**终止态事件待长任务补测**（§6） |
| M5 审批/问答 | **桌面继续消费旧流 `event.approval.*` / `event.question.*`**（REST 闭环实测有效）；**新流 `permission.*` 仅登记不消费** | §3.4-3 审批双流并存、REST 200 有效；§3.4-4 问答字段与桌面兼容 | 不新增审批按钮/面板（计划 M5-1 保持"通知+聚焦"）；question 目标态按计划 Web UI 优先，桌面本地窗仅 fallback |
| 用量（跨计划） | **待复核 `agent.status.updated` 替代 `session.usage_updated` 的可行性** | §3.4-2 用量漂移 | 影响面超本计划，登记为待办，不在 M3/M4/M5 范围内处理 |

---

## 5. 待实测项（🔍）

| # | 项 | 状态 | 影响 | 关联 |
| --- | --- | --- | --- | --- |
| 1 | ~~`did-navigate-in-page` 会话 URL 可探测性~~ | **✅ 已实测（M1-5，2026-08-03）**：URL pathname 携带完整 sessionId（`/sessions/<id>`），SPA 切换可捕获，高置信；workDir 不在 URL 中，需双向核对 | 会话切换感知精度（计划 R2/§5.3） | 见 §3.5 |
| 2 | subagent **终止态事件**（completed/failed/stopped）形态 | 120s 窗口未观察到，**待更长任务补测** | M4 normalizer 映射完整性、Agents 状态闭环 | §3.4-5 |
| 3 | `session.usage_updated` 是否存在于长会话/特定条件 | 窗口内未触发（≠不存在） | 用量面板/托盘复核（§4 待办） | §3.4-2 |
| 4 | `fs:*` REST 语义（授权范围、路径边界、是否可授权用于面板 Files） | 仅登记存在性，**待语义实测** | M3 Files 数据源候选（当前不采用） | §1.9 |
| 5 | `session_index.jsonl` 置信度 | **初判：低置信**——仅 `sessionId`/`sessionDir`/`workDir` 三字段、无时间戳与来源标记、最近条目为 ACP 临时会话 | 仅可作展示候选，不得授权 Files/Git 读取（计划 §5.3） | M1-5 / R2 |

---

## 6. 附：探测方法

### 6.1 探测脚本与运行记录

| 脚本 | 命令 | 退出码 | 探测内容 |
| --- | --- | --- | --- |
| `scripts/capability-audit.js` | `node scripts/capability-audit.js 58997` | 0 | `/openapi.json` 全量登记（76 端点，含方法/类别分组）、`serverCapsCheck`（archive/delete/models 对账）、`/asyncapi.json`（channel/operations/messages）、已知端点探测（`probes`: models=200 / sessions=200 / usage=404） |
| `scripts/ws-event-probe.js` | `node scripts/ws-event-probe.js 58997` | 0 | 活跃会话 WS 事件普查：创建测试会话 → 等待桌面端发现 → 依次发送 bash 提示词（审批）、AskUserQuestion 提示词（问答）、Task 子代理提示词（子代理/任务观察）→ 全程记录事件名/payload 键/次数 → 与 normalizer 白名单对比 |

探测输出落盘：`capability-audit-result.json`、`ws-probe-result.log`（`C:\Users\zyl\AppData\Local\Temp\opencode\`）。

### 6.2 关键探测动作与验证点（ws-probe）

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| ① | 创建测试会话 `session_d98864c1-1a3c-490c-a04c-aa537d1b4b2e` | 状态 `permission=yolo`、`plan_mode=true` |
| ② | WS 连接并订阅，等待 40s 让桌面端发现新会话 | 连接成功 |
| ③ | bash 提示词 → 捕获 `event.approval.requested` | **PASS ⑤**（旧流字段齐全） |
| ④ | REST 批准 `POST /approvals/{approval_id}` | HTTP 200（闭环有效） |
| ⑤ | AskUserQuestion 提示词 → 捕获 `event.question.requested` | **PASS ⑥**（`question_id` + `questions` 数组） |
| ⑥ | REST 作答 → 收到 `event.question.answered` | HTTP 200（闭环有效） |
| ⑦ | Task 子代理提示词，观察 `task.*` 与 agent 事件（120s，超时不算失败） | 收到 `task.started`；任务可能仍在进行 |

### 6.3 消耗说明

- **额度消耗**：仅 3 个短提示词（审批探测 / 问答探测 / 子代理探测各 1）。
- **测试会话保留**：`session_d98864c1-1a3c-490c-a04c-aa537d1b4b2e`（标题 `kcd-regression-probe`）**保留在磁盘**，可手动归档；若需复测子代理终止态事件，可复用该会话或新开会话补测。
