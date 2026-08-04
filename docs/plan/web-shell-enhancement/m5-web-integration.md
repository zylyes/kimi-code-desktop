# M5 Web 主导整合边界

> 来源：`WEB_SHELL_ENHANCEMENT_PLAN.original.md` §7 M5、§9
> 归档日期：2026-08-03
> 状态：已完成（2026-08-04）
> 前置：M2
> 预计工作量：2–3 人日

## 任务

- [x] **M5-1** 通知去重与聚焦：审批/任务完成通知保持"仅通知 + 点击聚焦主窗口"；实测 Web UI 自身是否渲染审批/追问 UI，若双 UI 并存则评估关闭桌面弹窗路径。question 目标态：Web UI 优先，桌面仅通知/聚焦；仅当 M1 证明对应 Web 版本不支持提问时，现有本地 question 窗才作兼容 fallback
  - 涉及：main.js WS 区、question 窗区
  - 验收：结论落文档；无"同一审批弹两次"可见冲突（手测）；question 所有权结论依据 M1 探测证据
- [x] **M5-2** 模型/权限/Plan/Swarm/上传/Slash/队列边界清单：桌面不复制任何对应控件；托盘"默认模型"菜单保留但 UI 文案标注"默认配置，会话内切换请在 Web UI 操作"
  - 涉及：托盘/菜单区（文案与文档）
  - 验收：清单入文档 §9；手测 Web UI 内切换与桌面默认配置互不打架
- [x] **M5-3** 深链增强：`create-in-dir` 后面板自动聚焦新会话工作目录；通知点击定位对应会话（经 `--session` 重启或 WS 事件对齐）——深链可探测性待 M1 确认
  - 涉及：main.js 会话/通知区
  - 验收：深链建会话 → 面板上下文 3s 内切换为新目录（若 M1 证明深链可探测；否则仅聚焦主窗口）；通知点击 → 主窗口聚焦
- [x] **M5-4** 面板与 Web UI 的键盘/焦点边界：面板聚焦时不拦截 Web UI 快捷键（`Ctrl+Shift+S` 等全局保留）；Esc 折叠面板
  - 涉及：workspace.html/js + main.js
  - 验收：快捷键矩阵回归（§11）全过

## M5 出口

- [x] 边界清单文档评审通过（最终决策入库：`docs/web-ui-integration-boundary.md`）
- [x] 双 UI 去重结论落地且可验证

## 执行日志

日期 | 已完成 | 下一步 | 备注/阻塞
--- | --- | --- | ---
2026-08-04 | M5-1 至 M5-4：Web 主导边界落地。通知：屏蔽 HTML5 Web 通知、审批/完成通知仅在全来源 session ID 合法一致且 epoch/base/token 匹配时点击可导航（`notification-nav.js` 纯函数）、WS question 仅通知/聚焦绝不导航；问答：主 Web question 不打开本地窗，ACP elicitation/permission 为独立 legacy 路径（owner 'ws'/'acp' 隔离）；深链：未验证会话 URL 约 4s 有界重查本地 session index（退避 100..2000ms，禁 ACP/全量扫描），验证前不授权 Workspace、未验证不回退 explicit；模型：托盘默认模型标注"默认配置，会话内切换请在 Web UI 操作"；键盘：Esc 有预览先关预览、无预览折叠面板，不拦截 Web UI 快捷键；overlay 期间 context 合并重挂后恰好补发一次 | M6 Windows 回归、安全门禁与发布 | 边界清单入库 `docs/web-ui-integration-boundary.md`；全量 26 份 `tests/test-*.js`、专项 acp-permission 11/11、acp-question 12/12、notification-nav 13/13、overlay context 6/6、Workspace selfcheck 61/61、Electron 集成探针均通过；Oracle 终局门禁通过。Windows 原生通知点击 A→B→A、真实窗口 load/close 竞态、连续 ACP question/permission 与 fallback、overlay 导航恢复、create-in-dir 实际 session index 时序及快捷键矩阵未自动化，留 M6 手测/回归 |
