> 来源: https://www.kimi.com/code/docs/kimi-code-cli/reference/kimi-acp.html

# `kimi acp` 子命令

`kimi acp` 把 Kimi Code CLI 切换到 **ACP (Agent Client Protocol)** 模式：在标准输入/输出上以 JSON-RPC 形式与 ACP 客户端（如 Zed、JetBrains AI Chat 等）对话，让 IDE 直接驱动 kimi 的会话、prompt 与工具调用。

```sh
kimi acp
```

启动后命令不会打印任何 banner，立刻等待 ACP 客户端在 stdin 上发出 `initialize` 请求。日志会写到标准错误（以及 `~/.kimi-code/logs/` 下的诊断日志），所以 ACP 通道本身保持干净。

> **📌 谁会调用它？**
>
>

你通常不需要手动跑 `kimi acp`——这个命令是给 IDE 的子进程入口准备的。IDE 端的配置见[在 IDE 中使用](kimi-code-cli/guides/ides.md)。

## 能力矩阵

下表列出当前 ACP 适配层声明的能力。`agentCapabilities` 字段在 `initialize` 响应里完整返回，IDE 端可据此调整 UI。

<table><thead><tr><th>能力</th><th>取值</th><th>说明</th></tr></thead><tbody><tr><td>`promptCapabilities.image`</td><td>`true`</td><td>支持 ACP `image` 内容块（base64 + mimeType）</td></tr><tr><td>`promptCapabilities.audio`</td><td>`false`</td><td>暂不支持音频 prompt</td></tr><tr><td>`promptCapabilities.embeddedContext`</td><td>`true`</td><td>客户端可发送 `resource`/`resource_link` 嵌入式资源块，文本内容会以 `<resource uri="...">...</resource>` 形式注入 prompt；blob 资源被丢弃并写 warn</td></tr><tr><td>`mcpCapabilities.http`</td><td>`true`</td><td>转发 IDE 配置的 HTTP MCP 服务</td></tr><tr><td>`mcpCapabilities.sse`</td><td>`true`</td><td>转发 IDE 配置的旧式 SSE MCP 服务</td></tr><tr><td>`loadSession`</td><td>`true`</td><td>支持 `session/load` 续接已有会话，加载时会同步回放历史</td></tr><tr><td>`sessionCapabilities.list`</td><td>`{}`</td><td>支持 `session/list` 枚举当前用户的会话</td></tr></tbody></table>

## ACP 方法覆盖

规范把方法分为**稳定**面和仍在演化的**不稳定**面（`@agentclientprotocol/sdk@0.23.0` 中以 `unstable_*` 前缀挂载的 handler）。两部分稳定性保证完全不同——稳定面是任何生产 ACP 客户端都会用到的方法，不稳定面覆盖实验性扩展（inline-edit 预测、document 缓冲区同步、provider 管理、elicitation 等），因此分开追踪。

**概览：稳定面 agent-side 实现 10/12（83%）+ client reverse-RPC 实现 4/9（44%）；不稳定面只接入了 `session/set_model`（1/19）。** 任何正常 agent 流程所需的方法（initialize → auth → new/load/resume → prompt → cancel + 文件 I/O + 工具审批）都已实现。

### 稳定面 agent-side — IDE → agent（10 / 12）

<table><thead><tr><th>方法</th><th>状态</th><th>说明</th></tr></thead><tbody><tr><td>`initialize`</td><td>是</td><td>版本协商；返回 `agentInfo: { name: 'Kimi Code CLI', version }`、能力矩阵、`authMethods`</td></tr><tr><td>`authenticate`</td><td>是</td><td>校验 `method_id='login'`；token 缺失返回 `authRequired (-32000)`，未知 id 返回 `invalidParams (-32602)`</td></tr><tr><td>`session/new`</td><td>是</td><td>接受 `cwd` / `mcpServers`，返回 `configOptions[]`</td></tr><tr><td>`session/load`</td><td>是</td><td>恢复磁盘会话并把历史以 `session/update` 同步回放</td></tr><tr><td>`session/resume`</td><td>是</td><td>`session/load` 的轻量兄弟方法，跳过历史回放</td></tr><tr><td>`session/prompt`</td><td>是</td><td>接受 `text` / `image` / `resource` / `resource_link` 内容块，流式输出 `agent_message_chunk`</td></tr><tr><td>`session/cancel`</td><td>是</td><td>中断当前 turn</td></tr><tr><td>`session/list`</td><td>是</td><td>枚举磁盘会话（通过 `sessionCapabilities.list = {}` 公告）</td></tr><tr><td>`session/set_mode`</td><td>是</td><td>兼容路径，与 `set_config_option({configId:'mode'})` 走同一 dispatcher</td></tr><tr><td>`session/set_config_option`</td><td>是</td><td>统一的 model / thinking / mode picker 分发</td></tr><tr><td>`session/close`</td><td>否</td><td></td></tr><tr><td>`logout`</td><td>否</td><td></td></tr></tbody></table>

### 稳定面 client-side reverse-RPC — agent → IDE（4 / 9）

<table><thead><tr><th>方法</th><th>状态</th><th>说明</th></tr></thead><tbody><tr><td>`session/update`</td><td>是</td><td>流式推送 `agent_message_chunk` / `tool_call*` / `plan` / `config_option_update` / `available_commands_update`</td></tr><tr><td>`session/request_permission`</td><td>是</td><td>工具审批和问题 elicitation 共用此通道</td></tr><tr><td>`fs/read_text_file`</td><td>是</td><td>kaos 层文件读取路由到客户端（通过 `fsCapabilities` 公告）</td></tr><tr><td>`fs/write_text_file`</td><td>是</td><td>kaos 层文件写入路由到客户端</td></tr><tr><td>`terminal/create` · `output` · `release` · `kill` · `wait_for_exit`</td><td>否</td><td>终端 reverse-RPC 未接，shell 命令走本地执行</td></tr></tbody></table>

### 不稳定面（1 / 19）

<table><thead><tr><th>方法</th><th>状态</th><th>说明</th></tr></thead><tbody><tr><td>`session/set_model`</td><td>是</td><td>兼容路径，等价于 `set_config_option({configId:'model'})`</td></tr><tr><td>其余 18 个方法</td><td>否</td><td>包括 session 生命周期扩展、缓冲区同步、inline-edit 预测、provider 管理等</td></tr></tbody></table>

上述未列出的方法一律返回 `methodNotFound`。

## MCP 转发

ACP 客户端在 `session/new` 或 `session/load` 中提供 `mcpServers` 时，适配层做如下转换：

- `http` → kimi 的 `transport: 'http'` 配置
- `stdio` → kimi 的 `transport: 'stdio'` 配置
- `sse` → kimi 的 `transport: 'sse'` 配置
- `acp` → 丢弃并写一条 warn 日志

## 下一步

- [在 IDE 中使用](kimi-code-cli/guides/ides.md) — Zed / JetBrains 配置步骤和故障排查
- [kimi 命令参考](kimi-code-cli/reference/kimi-command.md) — 完整子命令列表
