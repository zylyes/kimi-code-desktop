# ACP 协议研究报告（CLI 0.29.0 实测）

> 本文档是项目 ACP 集成的单一事实源，由第五次探测（`scripts/acp-probe5.js` + 补测 `scripts/acp-probe5b.js`）实测重建。
> 探测环境：CLI 0.29.0（`C:\Users\zyl\.kimi-code\bin\kimi.exe`）、Windows、Node v24.16.0、2026-07-27。
> 原始输出：`docs/acp-probe5-output.txt`（首跑 14 项）、`docs/acp-probe5b-output.txt`（7 项干净复测）。
> 两次探测退出码均为 0，stdout 均 0 段无法解析的脏输出；分帧方式 ndjson 首发即成功（无 LSP 回退）。
> 此前结论（probe3/probe4，CLI 0.27）已过时之处以本文为准。

## 结论速查表

| # | 探测项 | 结论 |
| --- | --- | --- |
| ① | session/load 回放 | **新 acp 进程 load 磁盘会话时回放历史**；同一进程内 load 已加载过的会话不回放 |
| ② | session/resume | 已实现：result 仅 `configOptions`，仅推 `available_commands_update`，不回放历史 |
| ③ | session/list | 已实现：字段 `sessionId`/`cwd`/`title`/`updatedAt`；51 条单页返回无 `nextCursor` |
| ④ | 未登录形态 | `session/new` → `-32000 Authentication required`；`authenticate` 参数名为 **`methodId`（camelCase）**，官方文档 `method_id` 系笔误；`'login'` 为 terminal 型认证 |
| ⑤ | thinking/configOptions | 三个 select：`model`（4 个 `kimi-code/*`）、`thinking`（**low/high/max 多档**，当前 high）、`mode`（default/plan/…）；`session/set_model({sessionId, modelId})` 成功 |
| ⑥ | elicitation | 经 `session/request_permission` 到达，`toolCall.title='AskUserQuestion'` 可识别；options 命名 `q{N}_opt_{M}`/`q{N}_skip` |
| ⑦ | 推送形态 | `config_option_update`（含完整 configOptions）与 `available_commands_update` 实测到达；`plan` 推送因 0.29.0 mode 切换 bug 未捕获（ExitPlanMode 审批三次到达佐证 plan 流程真实存在） |
| ⑧ | 图片输入 | **0.29.0 已修复**（0.27 崩溃 0xC0000409 不再）：`end_turn` + 口令正确回显 |
| ⑨ | /goal 推送 | **无 goal 专属 session/update 推送，无预算进度通道**；`/goal` 文本可创建目标并执行 |
| ⑩ | hooks | **ACP 会话中触发**：`UserPromptSubmit` 实测落盘，payload 含 ACP 内容块数组 |
| ⑪ | set_mode ≡ set_config_option | 同一 dispatcher 证实；但 **0.29.0 切 plan 报 `Already in plan mode` 内部错乱**（新会话 default 态复现） |
| ⑫ | current_mode_update | **不发**：mode 切换仅推 `config_option_update` |
| ⑬ | embeddedContext/mcpServers | `resource` 块注入生效（agent 正确回读文件口令）；mcpServers 四形态（http/stdio/sse/acp）参数校验通过，acp 传输未见 stderr warn |
| ⑭ | 命令清单 | 15 条：`compact, status, usage, mcp, tasks, help, check-kimi-code-docs, custom-theme, import-from-cc-codex, mcp-config, sub-skill, sub-skill.consolidate, sub-skill.review, update-config, write-goal` |

---

## 逐项详录

### ① session/load 加载非活跃会话的历史回放

**实测（首跑 S5 + P2 跨进程复测）：**
- **同一进程**：会话 A 在本进程 new 并留痕后，new B，再 `session/load A` → load 期间**无**历史消息推送（仅 `available_commands_update`）。
- **跨进程**：kill 后重启 `kimi acp`，`session/load A` → 收到历史回放：`user_message_chunk`（用户消息）→ `agent_thought_chunk`（思考链）→ `agent_message_chunk`（助手回复）→ `available_commands_update`。
- load 响应 result 仅含 `configOptions`（无 sessionId 回显，与 0.27 一致）。

**结论**：回放发生在 agent 端**首次从磁盘加载**该会话时；会话已在内存则跳过回放。官方文档"loadSession 加载时同步回放历史"成立，但仅限首次加载。

**对 P0-3/P0-4 的含义**：桌面端每个聊天窗一个独立 acp 进程，`load` 恢复历史会话时总会获得回放——历史渲染可以直接消费回放流（`user_message_chunk`/`agent_message_chunk`/`agent_thought_chunk`），替代本地 wire.jsonl 自绘解析。需在客户端去重：若回放后紧跟 resume 同会话，resume 不会再回放（见 ②）。

### ② session/resume 与 load 的差异

**实测（首跑 S6）**：`session/resume({sessionId, cwd, mcpServers})` 成功，result 键 = `["configOptions"]`（同 load），通知仅 `available_commands_update`×1，**无任何历史回放**。

**结论**：resume 是 load 的轻量版——恢复会话上下文但不回放历史，官方方法矩阵描述准确。二者 result 结构相同（configOptions），差异仅在回放行为。

**含义**：桌面「原生聊天」恢复会话的默认通道应为 `resume`（快），历史渲染走 ① 的 load 回放或本地索引；二者不可混用于同一进程同一会话（load 过的会话 resume 无增量信息）。

### ③ session/list 字段与分页

**实测（首跑 S1）**：
- initialize 公告 `sessionCapabilities.list = {}`（另公告 `sessionCapabilities.resume = {}`——能力矩阵文档未列 resume 公告）。
- `session/list({})` 返回 `sessions` 数组 **51 条**，单条字段：`sessionId`、`cwd`、`title`、`updatedAt`。
- 响应**无 `nextCursor` 字段**（51 条单页全量返回；是否存在分页阈值未知，未触发）。

**含义**：启动器可直接消费（title 比本地索引解析更准）；`listSessions(cursor)` API 设计保留 cursor 透传，但当前版本单页全量。

### ④ 未登录 authRequired 与 authenticate

**实测（首跑 P4 空 `KIMI_CODE_HOME` + 补测 ④b）：**
- 未登录时 `initialize` **正常返回**，`authMethods = [{ id: 'login', type: 'terminal', name: 'Login with Kimi account', args: ['--login'], _meta: { 'terminal-auth': { command: '<kimi.exe 完整路径>', args: ['login'], env: { KIMI_CODE_HOME } } } }]`——即官方不提供 ACP 内联认证，而是指引客户端**在终端跑 `kimi login`**（设备码流程），`_meta.terminal-auth` 给出完整命令行与环境。
- 未登录 `session/new` → 错误 `-32000 Authentication required`（无 data）。
- `authenticate({methodId: 'login'})` → **同样 `-32000 Authentication required`**（token 缺失时 authenticate 本身也拒绝——它是校验而非启动登录）。
- `authenticate({methodId: 'bogus'})` → `-32602 Invalid params: Unknown auth method: bogus`（data 含回显 methodId）。
- **参数名是 camelCase `methodId`**：首跑用 snake_case `method_id` 报 `-32602`（"methodId: expected string, received undefined"）。官方文档写 `method_id='login'` 系笔误。

**含义**：桌面端登录引导 = 检测 `-32000`（initialize 后的任何会话操作）→ 弹登录卡，按 `_meta.terminal-auth` 指引跑 `kimi login`（与 P1-7 设备码登录向导汇合），完成后 `authenticate({methodId:'login'})` 校验或重试会话操作。acp-client 需在 `-32000` 时上抛 `authRequired` 事件。

### ⑤ thinking 在 configOptions 的形态 + session/set_model

**实测（首跑 S2/S7）**：`session/new` 返回的 `configOptions` 为三个 select 项（完整结构见 output）：

```json
[
  { "type": "select", "id": "model", "name": "Model", "category": "model", "currentValue": "kimi-code/k3",
    "options": [
      { "value": "kimi-code/kimi-for-coding", "name": "K2.7 Coding" },
      { "value": "kimi-code/kimi-for-coding-highspeed", "name": "K2.7 Coding Highspeed" },
      { "value": "kimi-code/k3", "name": "K3" },
      { "value": "kimi-code/k3-256k", "name": "K3-256k" } ] },
  { "type": "select", "id": "thinking", "name": "Thinking", "category": "thought_level", "currentValue": "high",
    "options": [ { "value": "low", "name": "Low" }, { "value": "high", "name": "High" }, { "value": "max", "name": "Max" } ] },
  { "type": "select", "id": "mode", "name": "Mode", "category": "mode", "currentValue": "default",
    "options": [ { "value": "default", ... }, { "value": "plan", ... }, ... ] }
]
```

- **thinking 是多档 effort（low/high/max）**，0.27 的单值 on 形态已废弃——0.29.0 changelog 的"ACP 思考强度切换"落地形态即此 select。currentValue 跟随当前模型（K3 默认 high）。
- 模型 ID 用**目录全名**（`kimi-code/k3` 等四个），与 regression-0.29 附带发现一致。
- `session/set_model({sessionId, modelId: 'kimi-code/k3'})` → 成功（result `{}`），随后推 `config_option_update`（含更新后完整 configOptions）。

**含义**：acp-client 的 `setModel(modelId)` 封装参数名 `modelId`；thinking 切换走 `set_config_option({configId:'thinking', value:'low'|'high'|'max'})`；聊天窗模型/思考强度选择器直接消费 configOptions 的 options 数组（不要硬编码模型清单）。

### ⑥ AskUserQuestion elicitation 经 request_permission 的字段形态

**实测（补测 ⑥，default 模式新会话一次诱导即触发）**，捕获完整结构：

```json
{
  "sessionId": "session_…",
  "options": [
    { "optionId": "q0_opt_0", "name": "自动格式化", "kind": "allow_once" },
    { "optionId": "q0_opt_1", "name": "手动格式化", "kind": "allow_once" },
    { "optionId": "q0_skip", "name": "Skip", "kind": "reject_once" }
  ],
  "toolCall": {
    "toolCallId": "0:tool_NOjfCYTLfxPiSym1FMNDDj65",
    "title": "AskUserQuestion",
    "content": [ { "type": "content", "content": { "type": "text", "text": "你希望默认采用哪种代码风格格式化方式？" } } ]
  }
}
```

- **识别特征**：`toolCall.title === 'AskUserQuestion'`；问题文本在 `toolCall.content[].content.text`。
- **选项编码**：`q{题号}_opt_{序号}`（kind=`allow_once`）+ `q{题号}_skip`（kind=`reject_once`，跳过该题）；toolCallId 前缀 `0:` 推测为题号/轮次序号。
- **多题/multi_select/allow_other 形态未捕获**：诱导要求 2 题+多选+自定义，agent 自主决定只问了 1 题单选（agent 有裁量权，3+2 次诱导均如此）。多题形态推测按 `q0_/q1_` 前缀分组，但**未经实测**——P1-3 实现时应按前缀分组解析并对未知形态降级为普通审批窗。

**含义**：原生问答窗路由条件 = request_permission 且 title='AskUserQuestion'；应答 = `{ outcome: { outcome: 'selected', optionId } }`；取消 = cancelled。elicitation 与工具审批共用通道确认。

### ⑦ plan / config_option_update / available_commands_update 推送形态

**实测**：
- `config_option_update`：`set_model` / `set_mode` / `set_config_option` 成功后推送，payload 为**更新后完整 configOptions 数组**（同 ⑤ 结构）——客户端应整体替换本地状态而非增量合并。全程 4 次。
- `available_commands_update`：`session/new`、`session/load`、`session/resume` 后均推送（全程 6 次），命令清单见 ⑭。
- `plan` sessionUpdate：**未能捕获**——0.29.0 的 mode 切换 bug（见 ⑪）导致无法干净进入 plan 流程。但首跑 S9 的 plan prompt 在 plan 模式下执行（agent 思考链证实），且三次到达 **ExitPlanMode 权限请求**（见下「附带发现」），证明 plan 工作流真实存在，`plan` 推送形态列入 ROADMAP §7 待核实。

### 附带发现：ExitPlanMode 审批形态（P1-2 直接可用）

```json
{
  "options": [
    { "optionId": "plan_approve", "name": "Approve", "kind": "allow_once" },
    { "optionId": "plan_revise", "name": "Revise", "kind": "reject_once" },
    { "optionId": "plan_reject_and_exit", "name": "Reject and Exit", "kind": "reject_once" }
  ],
  "toolCall": {
    "title": "ExitPlanMode",
    "content": [ { "type": "content", "content": { "type": "text", "text": "Plan saved to: <计划文件绝对路径>\n\n# 计划全文（Markdown）…" } } ]
  }
}
```

- 选项为**三项**（Approve / Revise / Reject and Exit）——官方交互文档的四选项（含单独 Reject）与实测不符，以实测为准。
- 计划全文经 `toolCall.content` 下发（含落盘路径）——审批卡可直接渲染 Markdown 计划。
- 三次 ExitPlanMode 均被我们回 cancelled，agent 随后重试修订计划再发起（符合"拒绝后修订"语义）。

### ⑧ 图片输入

**实测（补测 ⑧，独立新会话）**：1×1 PNG（base64）+ 文本 prompt → `stopReason=end_turn`，agent 正确回显口令，子进程无异常。**0.27 的崩溃 0xC0000409 在 0.29.0 已修复**。`promptCapabilities.image=true` 声明属实。

**含义**：P1-8 走"已修复"路径——解除兜底降级，图片全链路可用（base64+mimeType、≤4 张、mime 白名单维持客户端校验）。

### ⑨ /goal 经 ACP 的暴露形式

**实测（首跑 S11 + 补测 ⑨b default 模式复测）**：
- `/goal <文本>` 作为 prompt 发送后 agent 接受并执行目标：首跑中 goal turn 持续运行（后续 prompt 被拒 `-32600 turn.agent_busy`），补测中 agent 直接完成并返回 `end_turn`。
- 全程通知仅 `agent_message_chunk` + `available_commands_update`——**无 goal 专属 sessionUpdate（无状态/轮次/预算进度推送）**。
- `available_commands_update` 清单含 `write-goal`（见 ⑭），即 goal 创建的底层 skill 命令。

**结论**：ACP 无 goal 状态/预算推送通道（ROADMAP §7-1 结案）。P1-4 Goal 面板按**降级路径**实现：命令入口（`/goal …` 文本）+ 轮询 `upcoming-goals.json` + turn 活跃状态推断。

### ⑩ hooks 在 ACP 会话中是否触发

**实测（首跑 P3，临时 KIMI_CODE_HOME 复制凭据 + `[[hooks]] event="UserPromptSubmit"`）**：发送 prompt 后 hook 脚本被执行，落盘 payload：

```json
{ "hook_event_name": "UserPromptSubmit", "session_id": "session_…", "cwd": "<会话 cwd>",
  "prompt": [ { "type": "text", "text": "Reply with exactly: PROBE5-HOOK-MARK" } ] }
```

**结论**：hooks 在 ACP 会话中触发（ROADMAP §7-14 的 hooks 部分结案）；`UserPromptSubmit` 的 `prompt` 字段是 **ACP 内容块数组**（非纯字符串）——hook 脚本作者需注意此形态差异。

### ⑪ session/set_mode 与 set_config_option({configId:'mode'}) 等价性

**实测（首跑 S8 + 补测 ⑪b 干净复测）**：
- 两者均作用于 mode（同一 dispatcher 证实）：首跑 `set_mode(plan)` 与补测 `set_config_option(mode=plan)` 报**同一个错** `-32603 Internal error: "Already in plan mode"`；`set_mode(default)` 成功并推 `config_option_update`。
- **0.29.0 内部状态错乱 bug**：新会话 configOptions 明示 `mode=default`，切 plan 却报 "Already in plan mode"（两进程独立复现）。报错后 agent 实际行为：首跑 S9 的 plan prompt 思考链证实 plan mode 确实激活——即**报错信息不可信，状态切换可能已生效**。

**结论**：两条路径等价但均不可靠（0.29.0 bug）。列入 ROADMAP §7 新增待核实项（上游 bug，建议向官方反馈）。**客户端策略**：mode 切换以 `config_option_update` 推送的 `currentValue` 为唯一事实源，忽略 `Already in …` 类报错文案本身；切换失败时按推送态决定是否重试。

### ⑫ current_mode_update 是否另发

**实测**：mode 切换全程仅 `config_option_update`，**未出现** ACP 规范 `current_mode_update` 通知。以 `config_option_update` 为准（官方文档 session/update 行准确）。

### ⑬ embeddedContext / mcpServers 转发

**实测（补测 ⑬a/⑬b）**：
- `resource` 块（`{type:'resource', resource:{uri, mimeType, text}}`）注入生效：agent 正确回读测试文件口令（`PROBE5-CONTEXT-MARK`）。`promptCapabilities.embeddedContext=true` 声明属实——桌面 `@` 文件注入可用。
- mcpServers 四形态（http/stdio/sse/acp）修正结构后 `session/new` 全部通过参数校验：**http/sse 必须带 `headers` 数组（可空），stdio 必须带 `env` 数组（可空）**——缺省报 `-32602`（"headers: expected array, received undefined"）。
- `acp` 传输未见 stderr warn（文档称"丢弃并写 warn"）——warn 可能写入 `~/.kimi-code/logs/` 诊断日志而非 stderr；客户端**无显式反馈**可知 acp 传输被丢弃，GUI 层应自行拦截该形态。

### ⑭ available_commands_update 下发清单

**实测（6 次推送合并去重，15 条）**：
`compact`、`status`、`usage`、`mcp`、`tasks`、`help`、`check-kimi-code-docs`、`custom-theme`、`import-from-cc-codex`、`mcp-config`、`sub-skill`、`sub-skill.consolidate`、`sub-skill.review`、`update-config`、`write-goal`

- **不含** `/goal`（goal 能力经 `write-goal` skill 暴露）、`/btw`、`/web`、`/reload`、`/undo`、`/title`、`/add-dir`、`/init`、`/experiments`（ROADMAP §7-4 部分结案：下发范围不含这些）。
- `sub-skill.*` 族证实 skill 命令经清单动态下发（`<skill>:<cmd>` 命名空间形态存在）。
- 清单会随会话状态更新（6 次推送），客户端应全量替换。

### 附带行为：turn 并发约束（turn.agent_busy）

goal turn 运行期间发送新 prompt → `-32600 Invalid request: Cannot launch a new turn while another turn (ID 0) is active`（data.code=`turn.agent_busy`）。**含义**：桌面聊天窗在 turn 进行中必须禁用发送或本地排队；`session/cancel` 可终止进行中的 turn（补测 ⑨b 验证路径）。

---

## 对 P0-3（acp-client 补齐）的接口定型

| 新方法 | 参数 | 响应 | 备注 |
| --- | --- | --- | --- |
| `listSessions(cursor?)` | `{cursor?}` | `{sessions:[{sessionId,cwd,title,updatedAt}], nextCursor?}` | 当前单页全量，cursor 透传预留 |
| `resumeSession(sessionId)` | `{sessionId, cwd, mcpServers}` | `{configOptions}` | 不回放；与 load 二选一 |
| `setModel(modelId)` | `{sessionId, modelId}`（目录全名） | `{}` + `config_option_update` 推送 | 不稳定面但实测可用 |
| `setMode(modeId)` | `{sessionId, modeId}` | 同 dispatcher | 0.29.0 报错文案不可信，以推送为准 |
| `authenticate(methodId)` | camelCase `methodId` | -32000/-32602 | 主要用于登录后校验 |
| `authRequired` 事件 | 任何请求遇 `-32000` 上抛 | — | 引导登录窗 |

- 推送转发：main.js 需增转 `plan`、`config_option_update`、`available_commands_update` 三类 sessionUpdate。
- `embeddedContext`：prompt 已支持 `resource` 块（`{uri, mimeType, text}`），`@` 文件注入可直接构造；blob 资源会被丢弃（文档），仅发文本资源。
- `mcpServers` 转发：GUI 的 MCP 配置可随 `session/new`/`session/load` 下发，注意 http/sse 补 `headers:[]`、stdio 补 `env:[]`；拦截 `acp` 传输形态。
- 问答路由：`request_permission` 且 `toolCall.title==='AskUserQuestion'` → 原生问答窗；`title==='ExitPlanMode'` → plan 审批卡（三选项 Approve/Revise/Reject and Exit，计划全文在 content）；其余 → 工具审批窗。

## 0.27 → 0.29 行为差异备忘（客户端兼容要点）

| 维度 | 0.27（probe3/4） | 0.29.0（本报告） |
| --- | --- | --- |
| load 回放 | 当前活跃会话不回放 | 首次磁盘加载回放；已在内存不回放 |
| resume | 未实现/未测 | 已实现（轻量无回放） |
| thinking | configOptions 单值 on | select low/high/max（K3 映射） |
| 图片 prompt | 崩溃 0xC0000409 | 正常（end_turn） |
| 未登录 | 未测 | initialize 正常 + authMethods terminal 型；操作 -32000 |
| mode 切换 | set_config_option 正常 | 切 plan 报 "Already in plan mode"（状态错乱 bug） |

## 遗留待核实（回写 ROADMAP §7）

1. `plan` sessionUpdate 推送形态：因 0.29.0 mode 切换 bug 未捕获，待上游修复后补测。
2. mode 切换 "Already in plan mode" 误报：疑似 0.29.0 上游 bug，建议反馈官方；后续版本复测。
3. elicitation 多题/multi_select/allow_other 形态：agent 裁量权下未触发，需真实场景观察（不阻塞 P1-3，按前缀分组 + 未知降级实现）。
4. session/list 分页阈值：51 条未触发 nextCursor，更大基数下的分页行为未知。
5. `acp` 传输 mcpServers 的 warn 实际落点（stderr 无，疑在 `~/.kimi-code/logs/`）。
