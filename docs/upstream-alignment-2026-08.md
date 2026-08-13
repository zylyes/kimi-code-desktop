# Kimi Code 官方上游变更对齐报告（2026-08）

> 面向项目维护者的上游变更对齐清单：记录本机 CLI 从 `0.31.1` 升级到 `0.36.0` 后的失效项、已修复项与未跟进项。
> 调研日期：2026-08-13；官方 CLI 最新版本 `0.36.0`（2026-08-13 发布、灰度中）。
> 事实源：GitHub `MoonshotAI/kimi-code` releases（0.30.0–0.36.0）、官方更新源 `https://code.kimi.com/kimi-code/latest.json`、官方 changelog（kimi.com/code/docs/en/kimi-code-cli/release-notes/changelog.html）、官方文档 `https://moonshotai.github.io/kimi-code/`、本仓库 2026-08-13 实测记录。
> 结论总览：核心链路全部未变；WS 应用层心跳为唯一实锤失效项（已修复）；「设置打不开」为桌面端 overlay 悬挂缺陷（防御修复已落地）；三项修复/跟进在本报告成稿同期完成。

## 1. 结论摘要

- 本机 CLI 已从 `0.31.1` 升级到 `0.36.0`。
- **官方核心链路均未变**：`kimi web --no-open` 启动参数、`server.token` 地址拼合、`/api/v1/*` REST 契约、WS 子协议、磁盘布局、`kimi-for-coding` 模型 ID。0.32.0 官方声明 "the /api/v1 message contract is unchanged"。
- **实锤失效项仅一项**：WS 应用层心跳（ping/pong）。0.36.0 起服务端每 10s 发 ping、20s 无 pong 即以 code=1001 "heartbeat timeout" 断开，桌面端出现约 25s 一断的连接循环（0.31.1 无此行为）。已在 WS message 处理入口回 pong 修复（§3.1）。
- 「设置打不开」无法在干净环境复现（CDP 端到端实测设置可正常打开），根因判定为桌面端 overlay 悬挂缺陷，防御修复已落地（§3.2）。
- Web UI 注入锚点在 0.36.0 实测基本保持，仅 `.app-topbar-actions`（☰ 菜单挂载点）消失，fixed 兜底定位实测正常——无需大改（§3.3）。
- 设置页 `[loop_control]` 旧键与文档中过时表述已清理（§4）。
- 剩余未跟进项与风险见 §5，验证矩阵见 §6。

## 2. 上游版本时间线（0.29.1 → 0.36.0）

| 版本 | 发布日期 | 关键变更 | 对桌面端影响面 |
| --- | --- | --- | --- |
| `0.29.1` | 07-24 | 本机升级前基线 | — |
| `0.30.0` | 07-29 | 常规迭代 | 兼容 |
| `0.31.0` | 07-30 | **`[loop_control]` 键改名**：`max_steps_per_run`→`max_steps_per_turn`（另 changelog 记 `max_retries_per_step`→`max_attempts_per_step`）；新增 `[token_counting]` 节 | 需跟进（已处理，§4） |
| `0.31.1` | 07-31 | 修复 `kimi web` 随机 "model is not configured"；web 引入 Monaco 高亮；新增 `--allowed-host`；修复 Windows server 首次运行后无法再启动 | 兼容 |
| `0.32.0` | 08-04 | **server 层承接 v1 消息历史**（"the /api/v1 message contract is unchanged"）；移除 `KIMI_SNAPSHOT_*` 三个环境变量；**新增 4 个 hook 事件**：TurnStarted / UserPromptQueued / TaskStarted / SessionHeartbeat | 兼容；hook 事件暂不接入（§5） |
| `0.33.0` | 08-05 | **Web UI/UX 大改版**（#2599）；TUI 启动信任当前文件夹询问；**agent-core-v2 引擎默认**（`KIMI_CODE_EXPERIMENTAL_FLAG` 不再选引擎，`KIMI_CODE_LEGACY_FLAG=1` 回退）；web UI 中询问不再 60s 自动消失 | 注入锚点已实测（§3.3） |
| `0.34.0` | 08-06 | web 侧栏平铺视图、子 Agent 显示模型与思考等级、失败卡片一键恢复；大量 web 修复 | 兼容 |
| `0.35.0` | 08-12 | **server 新增 WS 心跳**（修复反代/网关空闲超时 30s 掉线）；Windows binary-planting 安全修复；图片/视频工具结果全屏预览；长会话流式渲染优化 | 需跟进（心跳行为，§3.1） |
| `0.36.0` | 08-13 | **workspace trust prompt 默认拒绝信任**（SDK WorkspaceTrustInfo 合约变更）；**WS 心跳强制**（每 10s ping、20s 无 pong 即 code=1001 "heartbeat timeout" 断开；`server_hello` 新增 `heartbeat_ms:10000` / `protocol_version:2` / `max_event_buffer_size:1000`）；LaTeX 渲染为 Unicode 公式 | **破坏性（心跳）**，已修复（§3.1）；信任机制为观察项（§5） |

> 注：0.31.0 官方 changelog 与当前文档字段存在出入（changelog 记 `max_retries_per_step`→`max_attempts_per_step`，当前文档保留 `max_retries_per_step`），本项目按当前文档口径 `max_steps_per_turn` / `max_retries_per_step` / `reserved_context_size` 处理。

## 3. 失效问题与修复记录（本次已修复）

### 3.1 WS 应用层心跳（0.36.0 破坏性变更）

- **现象**：0.36.0 server 每 10s 发 `{"type":"ping","payload":{"nonce":...}}`，客户端不回 pong 则 20s 后以 code=1001 "heartbeat timeout" 关闭连接。桌面端升级后每 ~25s 断连循环（app.log 实测；`0.31.1` 无此行为）。
- **修复**：`src/main/main.js` WS message 处理入口识别 `type === 'ping'` 后回 `{"type":"pong","nonce":<nonce>}`（该格式实测可维持连接）。

### 3.2 「设置打不开」——overlay 悬挂缺陷（防御修复）

- **复现结论**：无法在干净环境复现；CDP 端到端实测设置链路可正常打开。
- **根因判定**：overlay 悬挂缺陷——覆盖层渲染进程崩溃后 overlayView 不复位，后续 loadFile 永久静默失败。
- **修复**：`render-process-gone` 复位 + loadFile 失败降级整页加载 + setup.html 返回按钮桥判空。

### 3.3 Web UI 注入锚点（0.36.0 实测）

- **仍存在**：`header.chat-header`（实测高 48）、`.btn-new-chat`、`.ui-panel-header`（仅右侧面板展开态存在）、`aside.global-preview`。
- **已消失**：`.app-topbar-actions`（☰ 菜单挂载点）——fixed 兜底定位实测正常（x≈1230, y=0, 38×48）。
- **结论**：无需大改。

### 3.4 shutdown 端点 404（实测根因 + 修复）

- **根因实测**：上游安全设计——`/api/v1/shutdown` 仅 loopback 绑定挂载；`--host 0.0.0.0` 时 `/openapi.json` 中无此路径、恒 404（loopback 绑定时带 token 返回 200）。
- **修复**：`/openapi.json` 能力探测新增 `shutdown` 项；`stopKimi` 在探测到端点未挂载时跳过无效优雅关闭请求、直接结束进程（省去 5 秒超时等待），日志不再误报 404。

## 4. 需去除/已清理项

- 设置页 `loop_control.max_iterations`：迁移为 `max_steps_per_turn`（读取时兼容旧键展示，保存时删除旧键，不改磁盘）。
- 设置页 `max_tool_depth`：上游已删除，保存时不再写出。
- 文档中过时的 `KIMI_CODE_EXPERIMENTAL_FLAG`「选引擎」表述：0.33.0 起该变量不再选择引擎。
- 文档中 `kimi-code/kimi-k2.5` 模型示例：该系列 API 2026-08-31 下线（官方通知 2026-08-04）。

> 另注明（桌面端无改动需求）：
> - `kimi server` 命令树上游 0.28.0 已移除，桌面端无调用残留（`server/` 仅作为数据目录路径使用）。
> - `kimi doctor tui` 上游改名 `doctor config`，桌面端已用新形态，无需改。

## 5. 需跟进清单（本次未做）

| # | 事项 | 风险与建议 |
| --- | --- | --- |
| 1 | Workspace trust 机制（0.36.0 默认拒绝信任，Web UI 内呈现询问） | 桌面端主窗口已嵌入 Web UI，用户在 Web UI 内确认即可；建议观察用户反馈后再决定是否加设置页引导 |
| 2 | 0.32.0 新增 4 个 hook 事件（TurnStarted / UserPromptQueued / TaskStarted / SessionHeartbeat） | runtime-event-normalizer 对未知事件安全忽略；若未来需消费再接入 |
| 3 | 新 REST 端点 `/api/v1/healthz`（免鉴权）、`/api/v1/meta`、`/api/v1/workspaces/{id}/trust` | 现能力探测走 `/openapi.json`，暂无消费需求 |
| 4 | `server_hello` 新增 `heartbeat_ms` 协议字段 | 当前未消费，固定 10s 节奏回应即可（心跳帧已适配，见 §3.1） |
| 5 | 2026-08-31 kimi-k2.5 / moonshot-v1 API 下线 | 仅影响以开放平台 API key 登录并在 config.toml 显式绑定旧模型的用户；桌面端默认 OAuth 订阅路径不受影响。已跟进：设置页模型区新增迁移提示（本版本落地） |
| 6 | 官方 Kimi Work 桌面端（2026-06-03 Beta 公测，K3 需 3.1.0+） | 与本项目定位的关系见 README 新增段落；本项目继续以 `kimi web` 套壳为定位 |
| 7 | 0.36.0 当天发布时无公开 release notes | 本报告以 GitHub release + 官方 changelog 为准 |
| 8 | `POST /api/v1/shutdown` 在非 loopback 绑定下恒 404 | 已定位根因并修复，见 §3.4 |

## 6. 验证矩阵

| 层级 | 内容 | 结果 |
| --- | --- | --- |
| 单测 | `node tests/test-*.js` 全量 | 已执行 |
| mock server 端到端 | `KIMI_DESKTOP_TEST_BASE` 测试钩子对接 mock 服务（client_hello / 订阅 / 问答 / 审批 / 用量 / 任务事件） | 已执行 |
| 真实 CLI `0.36.0` 冒烟 | WS 心跳 60s 存活实测（§3.1 pong 格式）；DOM 结构实测（§3.3 锚点清单）；CDP 设置链路实测（§3.2 设置可正常打开） | 已执行，观察项均见正文 |
