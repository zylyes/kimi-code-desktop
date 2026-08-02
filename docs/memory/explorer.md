# Explorer 专属记忆

## 任务/Agent/会话相关关键位置

- 子 Agent 任务监视器（后台任务/子 Agent 列表）：`src/pages/agents.html`（手工刷新，无实时推送），后端 `src/main/session-export.js` 的 `scanSubagents()`（:135-194，枚举 agents/ 目录 + 统计 wire 事件类型），IPC 为 `session:scanSubagents`（main.js:5196，有 sessions 目录白名单校验）；chat.js 不消费它。
- 子代理树事实源（2026-08-02 实测）：agent 目录（agents/main、agents/agent-N）内**无 state.json/meta.json**，只有 wire.jsonl（+plans/、tasks/）；父子关系唯一来源是**会话根 state.json 的 agents 映射** `{id:{homedir,type:'main'|'sub',parentAgentId}}`；wire 中 Agent 工具调用 `tool.call` 含 `toolCallId/args.subagent_type/display.agent_name`，可做平面降级路径（runtime-event-normalizer.js:95 已提取 agentType）。
- wire 步骤树事件：`context.append_loop_event.event` 为 step.begin/step.end（含 finishReason、usage{inputOther,output,inputCacheRead,inputCacheCreation}、llm*LatencyMs 等统计）/content.part（part.type think|text）/tool.call/tool.result；顶层另有 `usage.record`（usageScope:"turn"）。
- 会话目录磁盘结构：`sessions/<workDirKey>/<sessionId>/{state.json, agents/{main,<id>}/wire.jsonl, tasks/<id>.json+output.log, cron/}`；tasks/cron 格式官方未文档化，代码仅防御性读取 id/status/description（session-export.js:177-192）。
- 实时事件：CLI WebSocket（`kimi web`）→ main.js:1536 `wsClient.on('message')`，仅驱动托盘计数/桌面通知（task.started/progress/completed、subagent_stop 等），不推送到任何页面。
- ACP 原生聊天：`src/main/acp-client.js`（stdio JSON-RPC）→ main.js:2363 `client.on('update')` 把 sessionUpdate kinds 映射为 chat 事件 → `src/pages/chat.js` onEvent；sessionUpdate 类型清单见 `docs/acp-research.md` ⑦（agent_message_chunk/tool_call/plan/config_option_update/available_commands_update 等，无 subagent/step/task 类推送）。
- 会话树：桌面数据模型无 parent/child 字段；唯一"会话树"是 `kimi vis <sessionId>` 外部渲染（main.js:5138），`state.json` 有 `forkedFrom` 但未被使用。
- ROADMAP P2-6（tasks/cron 面板）在 docs/ROADMAP.md:215 有完整实现要点。
