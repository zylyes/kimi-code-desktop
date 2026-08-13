# Explorer 专属记忆
## 任务/Agent/会话相关关键位置
- 子 Agent 监视器：`src/pages/agents.html`（手工刷新）；后端 `src/main/session-export.js` 的 `scanSubagents()`（枚举 agents/ 目录+统计 wire 事件类型），IPC `session:scanSubagents`（main.js，sessions 目录白名单校验）；chat.js 不消费。
- 子代理树事实源（2026-08-02 实测）：agent 目录无 state.json/meta.json，只有 wire.jsonl（+plans/、tasks/）；父子关系唯一来源是会话根 state.json 的 agents 映射 `{id:{homedir,type:'main'|'sub',parentAgentId}}`；wire 的 tool.call 含 toolCallId/args.subagent_type/display.agent_name，可做平面降级（runtime-event-normalizer.js 已提取 agentType）。
- wire 步骤树事件：`context.append_loop_event.event` 为 step.begin/step.end（含 finishReason、usage 各字段、llm*LatencyMs 等统计）/content.part（think|text）/tool.call/tool.result；顶层另有 usage.record（usageScope:"turn"）。
- 会话目录结构：`sessions/<workDirKey>/<sessionId>/{state.json, agents/{main,<id>}/wire.jsonl, tasks/<id>.json+output.log, cron/}`；tasks/cron 格式未文档化，代码仅防御性读 id/status/description。
- 实时事件：CLI WebSocket（kimi web）→ main.js `wsClient.on('message')`；M4（2026-08-04）后事件经 runtimeState 驱动 Workspace 面板投影，同时仍驱动托盘计数/桌面通知（task.started/progress/completed、subagent_stop 等）。
- ACP 原生聊天：`src/main/acp-client.js`（stdio JSON-RPC）→ main.js `client.on('update')` 把 sessionUpdate kinds 映射为 chat 事件 → `src/pages/chat.js` onEvent；sessionUpdate 清单见 `docs/memory/librarian.md` 与 `docs/ROADMAP.md`（agent_message_chunk/tool_call/plan/config_option_update/available_commands_update 等，无 subagent/step/task 类；原 `docs/acp-research.md` 已于 2026-08-07 清理，勿再查找）。
- 会话树：桌面模型无 parent/child 字段；唯一"会话树"是 `kimi vis <sessionId>` 外部渲染（main.js）；state.json 有 forkedFrom 但未被使用。
- ROADMAP P2-6（tasks/cron 面板）实现要点见 docs/ROADMAP.md。
