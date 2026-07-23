# ACP（Agent Client Protocol）实测调研报告

> 调研日期：2026-07-22 · 调研人：ACP 探测脚本（`scripts/acp-probe.js`）+ 人工分析
> 目的：评估 FEATURE-IDEAS.md「阶段6 ACP 原生 UI」路线的可行性，为 v0.10.0+ 规划提供实测依据。
> 原始输出日志：[`docs/acp-probe-output.txt`](./acp-probe-output.txt)（下文以 `日志:Lxx` 引用行号）

## 探测环境与方法

| 项 | 值 |
| --- | --- |
| CLI 路径 | `C:\Users\zyl\.kimi-code\bin\kimi.exe`（首选候选命中） |
| CLI 版本 | Kimi Code CLI 0.27.0（`agentInfo` 自报，日志:L55-58） |
| 运行环境 | Windows 10/11 x64，Node v24.16.0，本机已完成 OAuth 登录 |
| 探测方式 | `spawn('kimi.exe', ['acp'], { stdio:'pipe', windowsHide:true })`，纯 Node JSON-RPC 2.0 客户端；ndjson 分帧首发，20s 无响应则 kill 重启改试 Content-Length(LSP) 分帧；总超时 90s |
| 探测流程 | `initialize` → `session/new`（临时目录）→ `session/prompt`（口令 `ACP-PROBE-OK`）→ 记录全部通知与 server→client 请求 |

## ① 实测结果

**结论：握手一次成功，全链路走通，退出码 0（日志:L646）。总耗时约 25 秒，其中 LLM 往返约 20.9s。**

### 分帧方式

- **ndjson（每行一个 JSON）首发即成功**，initialize 往返仅 612ms（日志:L8-9），LSP 回退路径未触发。
- ACP 官方协议即 ndjson 分帧，实测与规范一致；脚本中的 Content-Length 解析器已实现但**未经真实对端验证**（仅代码路径存在）。
- 全程 0 段无法解析的原始输出（日志:L643），stdout 干净，无banner/日志混入——这意味着桌面端可以安全地把子进程 stdout 当纯协议通道。

### initialize 能力清单（日志:L10-60）

请求：`{protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}, terminal:false}}`

响应要点：

| 字段 | 实测值 | 含义 |
| --- | --- | --- |
| `protocolVersion` | `1` | 协议版本协商一致 |
| `agentCapabilities.loadSession` | `true` | 支持恢复已有会话（桌面端会话启动器可直接受益） |
| `promptCapabilities` | `{image:true, audio:false, embeddedContext:true}` | 支持图片与嵌入式上下文，不支持音频 |
| `mcpCapabilities` | `{http:true, sse:true}` | 经 ACP 注入 MCP 服务器时支持 HTTP/SSE |
| `sessionCapabilities` | `{list:{}, resume:{}}` | **kimi 扩展**：会话列表/恢复（对应 ACP 较新规范的 session/list、session/resume，未实测） |
| `authMethods` | 1 个：`{id:'login', type:'terminal'}` | 设备码登录走终端流程；`_meta.terminal-auth` 携带完整命令行（日志:L42-52），桌面端需自行弹终端或做登录窗 |
| `agentInfo` | `Kimi Code CLI 0.27.0` | 版本自报，可用于兼容性检查 |

### session/new 形态（日志:L61-135）

请求 `{cwd: <临时目录>, mcpServers: []}`，往返 377ms。响应除 `sessionId` 外还返回 **`configOptions`**（kimi 扩展的会话配置项）：

- `model`（当前 `kimi-code/k3`，可选 K2.7 Coding / K2.7 Coding Highspeed / K3）
- `thinking`（当前 `on`）
- `mode`（当前 `default`，可选 `plan` / `auto` / `yolo`，各带描述文案）

价值：模型、思考、权限模式三件套在 ACP 会话内即可切换（推测走 `session/set_config_option`，**未实测**），桌面端原生 UI 不必为此回退 REST。

### session/prompt 与 session/update（日志:L136-631）

- 请求 `{sessionId, prompt:[{type:'text', text:'Reply with exactly: ACP-PROBE-OK'}]}`；响应 `{"stopReason":"end_turn"}`，往返 20.9s（日志:L622-630）。
- 实测出现的 `session/update` 通知类型（统计见日志:L637-640）：

| update 种类 | 条数 | 说明 |
| --- | --- | --- |
| `available_commands_update` | 1 | prompt 后立即下发可用斜杠命令（compact/status/usage/mcp/tasks…），原生 UI 可直接渲染命令菜单 |
| `agent_thought_chunk` | 479 | 思考过程逐词流式推送（与正文分离）；非常碎，UI 需做合并/节流渲染 |
| `agent_message_chunk` | 5 | 正文流式分片，拼接结果为 `ACP-PROBE-OK`，口令精确回显（日志:L617-621, L644-645） |

- **本次未触发** `session/request_permission` 与 `tool_call`/`tool_call_update`（日志:L641）：探测口令是纯文本对话，agent 未调用工具。审批请求的字段级形态仍待第二次探测（见 §未验证项）。
- 脚本已就位：收到 `request_permission` 会记录完整结构并按协议回 `{outcome:{outcome:'cancelled'}}`，其它 server→client 请求回 `-32601`（本次均未发生）。

## ② ACP 与现有 REST+WS 路线的能力差分析

| 维度 | 现有 REST+WS（`kimi server` + WebView） | ACP（spawn `kimi acp`，stdio JSON-RPC） |
| --- | --- | --- |
| 部署形态 | 常驻守护进程 + 端口 + token 鉴权；桌面端只做「壳」 | 每实例一个子进程，stdio 通信，**无端口、无 token**，进程生命周期由 Electron 直接掌控 |
| 会话语义 | 面向多客户端 Web UI；会话管理走 REST 轮询 | 单客户端独占；`session/new` + `loadSession`/`sessionCapabilities.{list,resume}`（kimi 已声明）天然贴合「一个窗口一个会话」 |
| 流式推送 | 私有 WS 事件（question/usage/task…），需自行订阅与转换 | `session/update` 统一通知：正文/思考/工具调用/计划/命令菜单，协议标准化 |
| **审批** | 工具审批在 Web UI 内完成；桌面端仅把 AskUserQuestion 问答经 WS 事件 + `POST /api/v1/sessions/:id/questions/:qid` 搬到了原生窗（question.html），依赖 Web 服务存活 | `session/request_permission` 是**同步 JSON-RPC 请求**：agent 阻塞等待客户端答复，options 带 allow/reject × once/always 语义——审批是协议一等公民，天然对应原生模态弹窗 |
| 文件/终端 | 无客户端侧概念，全在服务端 | 客户端能力协商（`fs.readTextFile/writeTextFile`、`terminal`）：可选由桌面端自己实现文件读写与终端（如内嵌终端组件），边界可控 |
| 配置切换 | 写 config.toml / REST 设置接口 | `configOptions` 会话内切换模型/模式（实测存在） |
| 生态 | kimi 私有（有 openapi.json/asyncapi.json 自描述文档兜底） | Zed 主导的开放协议，JetBrains 等编辑器共用，CLI 侧会持续受真实客户端检验 |
| 认证 | token 注入 WebView | `authMethods`（kimi 为 terminal device-code），需桌面端自己承接登录流程 |

### 审批原生化对桌面端的价值（重点）

1. **审批不再依赖 Web UI 存活**：Web 服务崩溃、页面卡死、WebView 白屏时审批链路全断；ACP 下审批是主进程与 CLI 子进程间的同步请求，渲染层挂了审批逻辑仍在，可降级为系统对话框。
2. **审批可深度集成桌面能力**：原生模态窗抢焦点、托盘角标、系统通知、「始终允许」规则直接落 config.toml 权限段——这些在 WebView 内做都要绕一层桥。
3. **安全边界更清晰**：审批决策点从 Web 页面脚本移到 Electron 主进程，WebView 内任何注入/ XSS 都无法伪造批准；`always` 类授权的落库也可统一审计。
4. **延迟与确定性**：`session/request_permission` 是点对点同步请求，省掉「WS 事件 → 主进程 → POST 回写」的三段跳转，且协议层面不会丢（丢了 agent 就一直等，可观测、可超时取消，而不是静默失败）。

代价同样明确：ACP 路线下桌面端要自己实现整条聊天 UI（渲染、Markdown、代码高亮、输入框、历史），这正是分阶段推进的原因。

## ③ 桌面端原生聊天 UI 分阶段建议

路线沿用 FEATURE-IDEAS.md 阶段6「渐进替代 WebView」的既定方向，基于本次实测细化为：

### v0.10.0 — 只读原型窗口（预估 3-5 天）

- `acp-client.js`：把本次 probe 代码产品化（分帧 + JSON-RPC + 请求复用 + 进程看护），约 200-300 行，已被实测验证可行。
- `chat.html` 原型窗：发 prompt、渲染 `agent_message_chunk` 流式正文 + `agent_thought_chunk` 折叠区；`available_commands_update` 先只记录不渲染。
- 安全兜底：所有 `session/request_permission` 一律回 `cancelled`（同 probe），保证原型阶段 agent 无法执行任何写操作；会话以临时 cwd 或只读目录启动。
- 验证点：渲染节流（479 条 thought chunk 不能逐条刷 DOM）。

### v0.11.0 — 审批弹窗（预估 2-3 天）

- `session/request_permission` → 原生模态窗，交互模式复用 question.html 的窗体/桥接套路；options 的 once/always 语义映射为按钮组。
- 渲染 `tool_call` / `tool_call_update`（工具名、状态流转、结果摘要）。
- 前置工作：**第二次探测**拿到 request_permission 的真实字段结构（见下），避免照规范空想。

### v0.12.0+ — 渐进替代 WebView（预估 5-8 天）

- `session/list` + `session/resume` 接入现有会话启动器（sessions.html），替代 REST 轮询。
- `configOptions` → 原生模型/模式切换栏；slash 命令菜单；图片与 embeddedContext 输入。
- 设置中心、MCP/Skills 管理等仍留 WebView（REST 路线成熟且非高频），聊天主界面完成替换后 WebView 降级为「高级面板」。

**合计约 10-16 个工作日**，分三个版本交付，每个版本都可独立回退（WebView 始终可用）。

### 未验证项与后续探测清单

1. `session/request_permission` 字段级结构（本次 agent 未调工具）——下次用「创建一个文件」类 prompt 触发，脚本已具备记录 + 取消能力。
2. `session/set_config_option`（configOptions 的写入侧）与 `session/list` / `session/resume` 的实际行为。
3. 客户端声明 `fs/terminal: true` 后 `fs/read_text_file`、`terminal/*` 请求的形态（桌面端是否要接管文件读写）。
4. Content-Length 分帧回退路径仅有代码、未对真实对端验证（ndjson 已够用，此项仅作健壮性储备）。
5. 备选交叉验证：用 Zed 配置 `agent_servers` 指向 `kimi.exe acp` 实测一轮（本项目 v0.8.0 的 IDE 接入向导已能生成该配置），从成熟客户端视角对照。

## 附：探测产物

- 探测脚本：`scripts/acp-probe.js`（纯 Node 无依赖，可重复运行）
- 输出日志：`docs/acp-probe-output.txt`（647 行时间线，毫秒级方向标记）
