# Web UI 整合边界（M5 最终决策）

> 面向项目维护者的简洁边界清单，记录 M5「Web 主导整合边界」的最终决策与安全契约。
> 来源：`docs/plan/web-shell-enhancement/WEB_SHELL_ENHANCEMENT_PLAN.original.md` §7 M5、§9；M5 实施期间实测与修复（`src/main/main.js`、`src/main/notification-nav.js`、`src/main/overlay-context-sync.js`、`src/pages/workspace.js`）。
> 归档日期：2026-08-04
> 状态：M5 已完成（2026-08-04），本清单为最终口径；后续改动须先更新本清单。

## 产品原则

`kimi web` 是唯一主对话 UI；桌面仅做**通知、聚焦、只读 Workspace、默认配置和安全深链**，不复制任何交互控件。一切对话内交互决策（审批、问答、Plan、模型切换、上传、Slash Commands、队列）都在 Web UI 完成。边界清单未覆盖的新能力需求默认拒绝，先走数据源优先级评估再决定。

## 边界清单

| 能力 | 所有权 | 桌面允许行为 | 禁止行为 |
| --- | --- | --- | --- |
| 权限/审批（approval） | Web UI | WS `approval.requested` 保持计数 + 通知 + 点击聚焦；全部来源 session ID 合法且一致时点击可导航（见「通知」节） | 不实现审批按钮/面板；不自动审批；不渲染审批卡 |
| 问答（question） | Web UI（默认所有权） | 主 Web WS question 仅通知/聚焦，点击不导航；ACP elicitation/permission 为独立 legacy 路径，可使用本地窗（见「问答」节） | 不打开第二个本地问答窗接主 Web 事件；不新增问答形态；桌面不默认接管 |
| Plan | Web UI | 不展示 plan 内容副本；通知层面不重复 | 不渲染 plan 卡片 |
| Swarm/子代理 | Web UI | Agents 标签仅只读投影（M4 磁盘快照口径，含活动增量） | 不提供启动/暂停/派发子代理入口 |
| 模型/思考强度 | Web UI（会话内） | 托盘「默认模型」菜单保留，仅写全局 `default_model` 并标注为默认配置；会话内切换引导用户在 Web UI 完成（见「模型」节） | 不在面板复制模型下拉/切换控件；不拦截会话内切换 |
| 上传/附件 | Web UI | 不参与 | 不实现上传 UI/文件注入 |
| Slash Commands | Web UI | 不参与 | 不实现命令菜单/补全 |
| prompt 队列 | Web UI | 不参与 | 不实现队列 UI/状态 |
| Goal | Web UI/TUI | 不实现 Goal 面板；如 M1 探测发现预算事件则仅通知 | 不实现 goal 控制 UI |

## 问答

- **主 Web WS question**（`question.requested`）：默认只通知/聚焦，**不打开第二个本地问答窗**。主窗聚焦时由 Web UI 自行呈现（仅记录日志）；失焦时发原生通知，点击只聚焦、绝不导航，事件到达不抢焦点。通知创建后按 `question_id` 去重，防止重连回放重复触发。
- **ACP elicitation/permission**：独立 legacy 路径，可继续使用本地 question 窗/审批窗——`createQuestionWindow` 仅保留给 ACP 路径调用。问答窗以 `owner: 'ws' | 'acp'` 隔离：WS `answered/dismissed` 只作用于 WS 问答窗，ACP elicitation 窗不受其影响；窗口有效性绑定各自独立的请求身份 epoch，与 WS 事件完全隔离。

## 通知

- **HTML5 Web 通知已屏蔽**：default session 与 `persist:kimi-code` partition 的 permission handler 一律拒绝 `notifications`，避免同一事件弹出网页 + 原生两条通知。
- **审批/完成通知**：仅当全部来源（raw 顶层 + `payload`/`data` 及其 `info` 层）的 session ID 均合法且一致（`notification-nav.approvalNavSessionId` / `completionNavSessionId`），**且**通知创建时捕获的连接/导航 `epoch` 与 `base` 仍与当前一致、当前持有可信 base+token（`decideNotificationNav`）时，用户点击后才导航到 `/sessions/<id>#token=`；否则仅聚焦。导航目标 URL 只能由当前可信 `knownServerBase`/`token` 构造，**绝不接受事件提供的 URL**；已在目标会话不重载。
- **question 通知不导航**：WS question 无论合法与否都不携带可导航 session ID。
- **旧通知、冲突 ID、无 token 只聚焦**：实例切换、服务启动/停止、连接身份变更（token 轮换）均递增 `navEpoch`，旧通知点击只能聚焦，不得恢复导航资格。

## 深链

- `create-in-dir` 深链照常由主进程构造 URL（`/?action=create-in-dir&workDir=...#token=`）。
- 对当前**合法但未验证**的会话 URL（通知点击导航 / create-in-dir / 任何 SPA 或全量导航到达 `/sessions/<id>` 且本地索引尚未更新），在**约 4 秒内**有界重查本地 session index：退避序列 100/250/500/1000/2000ms（总生命周期 ≈3.85s），只读 `workspaceIndexEntries()`；每次 tick 校验窗口存活、导航 epoch 未变、当前 URL 仍是同一 sessionId、origin 属于当前 `knownServerBase`、server generation/base 未变。命中 verified 后同步 Workspace 授权状态，面板可见才推 context。
- **验证前绝不授权 Workspace**：低置信推断仅展示候选，不授权 Files/Git 读取。
- **未验证 URL 不回退旧 explicit**：仅 verified URL 清除 explicit 绑定（可信导航覆盖显式选择）；未验证 URL 保留 explicit 作回退，绝不因重查未命中而清除。
- 重查**禁止 ACP、全量扫描与无限轮询**；导航、服务切换、窗口销毁使在途重查失效。
- 通知点击导航仍是用户显式动作，资格由上述 epoch/base/token 契约约束。

## 模型

- 托盘/菜单面板「默认模型」菜单保留（既有写 `config.toml` 全局 `default_model` 能力，doctor 校验失败自动回滚），UI 文案标注「默认配置；会话内切换请在 Web UI 操作」。
- 会话内模型/思考强度切换一律在 Web UI 完成，桌面不提供切换控件。

## 键盘/焦点

- 面板仅处理 **Escape**：有预览时先关闭预览（与预览关闭按钮同路）；无预览时折叠面板（`setPanelState({collapsed:true})`）。
- 面板**不拦截 Web UI 全局快捷键**（`Ctrl+Shift+S` 等全局保留）：仅处理 Escape 键，Tab/方向键 roving 导航不受影响。
- **overlay 期间 context 合并**：overlay（sessions/setup 覆盖层）显示时面板已从主窗口内容树移除，`pushWorkspaceEvent` 不得推送事件；期间丢弃的 `{kind:'context'}` 记入待同步标志（多次 context 合并为一次，`overlay-context-sync.noteContextWhileOverlay`），overlay 关闭、面板重挂后**恰好补发一次**（`drainContextAfterOverlay`）；非 context 事件不积压。overlay 期间授权状态重算与未验证 URL 有界重查照常执行，不依赖面板可见性。

## 验证证据（2026-08-04）

- M5 终局 Oracle 门禁通过（沿用 M3/M4 惯例）。
- 全量 26 个 `tests/test-*.js` 通过。
- 专项单测：`test-acp-permission-window.js` 11/11、`test-acp-question-window.js` 12/12、`test-notification-nav.js` 13/13、`test-overlay-context-sync.js` 6/6。
- Workspace selfcheck 61/61。
- Electron integration probe（`scripts/dev/workspace-integration-probe.js`）通过。

## 仍需 M6/人工验证

以下场景自动化未覆盖，留给 M6 Windows 回归矩阵（`m6-regression-release.md` M6-1）与手测：

- Windows 原生通知点击 A→B→A（跨实例切换后旧通知仅聚焦）。
- 真实 BrowserWindow load/close 竞态（窗口销毁/重建与导航、重查时序）。
- 连续 ACP question/permission 与 fallback（多请求连续到达）。
- overlay 导航恢复（overlay 期间导航后的 context 补发）。
- create-in-dir 实际 session index 落盘时序，及 §11 快捷键矩阵。
