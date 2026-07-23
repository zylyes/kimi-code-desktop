# v0.12.0 - 2026-07-23

## 新功能

- **ACP 原生聊天真实会话化**：`acp-chat:start` 支持 `{cwd, sessionId}`；真实工作目录启动（路径非法回退临时目录）；菜单项改名「原生聊天（新会话）…」。
- **历史会话恢复**：会话启动器详情新增「原生聊天」按钮（无 workDir 的会话禁用并提示；敏感目录弹确认）；恢复 = `session/load` 接续 agent 上下文 + 本地 wire.jsonl 自绘最近 50 条历史（双保险：若 agent 重放则跳过本地历史）；聊天窗标题栏显示会话名与工作目录、窗口标题动态化；load 失败明确报错不静默回退新建。
- **configOptions 原生切换栏**：聊天窗状态条下新增模型/思考/权限模式三下拉（缺项自动隐藏）；切换走 `session/set_config_option`，`config_option_update` 通知幂等回显，失败回滚并提示；仅就绪且非在途时可操作。
- **停止生成按钮**：busy 时发送键变「停止」，走 `session/cancel` 通知。
- **第三次 ACP 探测**：新增 `scripts/acp-probe3.js` 与 `docs/acp-probe3-output.txt`（786 行），`docs/acp-research.md` 追加第三次探测小节。实测结论：`session/load` 存在（参数 `{sessionId,cwd,mcpServers:[]}`，响应仅含 configOptions，实测无历史重放）、`session/set_config_option` 可用（字符串 value，响应与 `config_option_update` 通知均带完整 configOptions，失败 -32603，改动不跨 load 持久）、`session/list` 存在（条目 sessionId/cwd/title/updatedAt + nextCursor）、`session/cancel` 生效（prompt 以 stopReason:cancelled 返回）。

## 其他

- `acp-client.js` 新增 `loadSession()`/`setConfigOption()`/`cancel()`；新增 `user-chunk` 事件转发（agent 侧用户消息重放兜底）。
- `test-acp-client.js` 新增 `loadSession`/`setConfigOption`/`cancel` 对应单测（全部通过）。
- 无破坏性变更。