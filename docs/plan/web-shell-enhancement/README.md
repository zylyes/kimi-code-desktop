# Web Shell 增强计划 — 执行主计划

> 来源：`docs/WEB_SHELL_ENHANCEMENT_PLAN.md`（v1.2 定稿，已评审可执行）
> 原始版：`WEB_SHELL_ENHANCEMENT_PLAN.original.md`（本目录，只读不改）
> 归档日期：2026-08-03
> 状态：**已停止（M6 自动门禁完成，人工验收与签名由用户跳过）**
> 当前阶段：M6（已停止）

## 里程碑总览与依赖

| 里程碑 | 名称 | 前置 | 状态 | 子文件 |
| --- | --- | --- | --- | --- |
| M1 | 能力审计与外壳契约 | 无 | **已完成**（2026-08-03） | [m1-capability-audit.md](m1-capability-audit.md) |
| M2 | 主窗口 Workspace 面板组合 | M1 | **已完成**（2026-08-03） | [m2-workspace-panel.md](m2-workspace-panel.md) |
| M3 | Changes/Files 只读服务与 UI | M1（数据）/ M2（UI） | **已完成**（2026-08-03） | [m3-changes-files.md](m3-changes-files.md) |
| M4 | Agents/Tasks 活动投影 | M1（数据）/ M2（UI） | **已完成**（2026-08-04） | [m4-agents-tasks.md](m4-agents-tasks.md) |
| M5 | Web 主导整合边界 | M2 | **已完成**（2026-08-04） | [m5-web-integration.md](m5-web-integration.md) |
| M6 | Windows 回归、安全门禁与发布 | M3+M4+M5 | 已停止（自动门禁完成；人工验收与签名跳过，非正式候选） | [m6-regression-release.md](m6-regression-release.md) |

## 执行车道（单人顺序，任务级交错）

- 车道 A（数据）：M1 → M3 服务模块 → M4 投影
- 车道 B（UI）：M2 面板宿主 → M3/M4 面板页面
- 车道 C（整合）：M5 → M6

## 关键约束（执行中不可违反）

1. 产品边界：`kimi web` 是唯一主对话 UI；不建聊天运行时/工具卡/审批卡/Composer/reducer。
2. Workspace 候选/上下文链**禁止调用 `getAllSessionsMerged()`**（其内部会启动 `kimi acp`）。
3. 面板销毁仅取消 Workspace 自有资源，**不停主进程共享 WS**。
4. 低置信会话推断仅展示候选，**不授权 Files/Git 读取**。
5. Git 只读参数白名单；机器解析输出一律 `-z` NUL 分隔；diff 预览必须引用快照 `entryId`。
6. feature flag `workspacePanelEnabled` 默认 false，关闭时完全不创建面板。
7. 能力登记优先扩展现有 `detectServerCaps`/serverCaps，仅 M1 证明必要才新建 registry。
8. 打包：`npm run pack:versioned:ca`（`NODE_OPTIONS=--use-system-ca`，严禁禁用 TLS 校验）。

## 执行日志

日期 | 已完成 | 下一阶段 | 备注/阻塞
--- | --- | --- | ---
2026-08-03 | 计划归档（原始版 + 拆解版） | M1-1 探测脚本 | 开始 M1
2026-08-03 | M1 全部完成：三探测脚本（capability-audit / ws-event-probe / nav-probe）实测 CLI 0.31.1 均 exit 0；`docs/web-shell-capability-audit.md` 入库；能力登记结论=维持现状不新建 registry | M2 面板组合 | 关键实测：subagent WS 事件存在（§8.3 条件满足）、会话 URL `/sessions/<id>` 高置信、无 diff API、task.* payload 字段差异、session.usage_updated 未触发（跨计划待办）
2026-08-03 | M2 全部完成：面板架构（360px 覆盖式右栏+z-order+销毁顺序）、session-workspace 上下文服务（63 断言）、workspace:* IPC+preload、feature flag+菜单+启动恢复、骨架页四标签空态；冒烟验证 flag 关/开双路径通过；全量单测 19/19 | M3 git-service/file-browser | 教训：PS Set-Content utf8 带 BOM 致 config 静默失效（已修 readJSON strip BOM）；capturePage 不合成 WebContentsView（面板验证须日志内省）；§11 用例 9 留 M6 |
2026-08-03 | M3 全部完成：受控 Git Changes/diff、白名单 Files、workspace IPC/UI、3 秒节流；全量 21 个单测、111 条 UI 时序自检、真实 Workspace WebContents IPC 探针均通过；Oracle 终局门禁通过 | M4 Agents/Tasks 投影 | 安全整改：verified URL 覆盖 explicit、跨会话 generation、快照绑定 workDir、Git 禁 helper/限额/重试、.git/node_modules 不可绕过、严格拒绝 descendant symlink；保留已记录的纯 Node TOCTOU 边界 |
2026-08-04 | M4 全部完成：Agents/Tasks 只读投影、历史磁盘快照、官方 WS/ACP 活动防抖与四标签 UI；全量 22 个单测、50 条 M4 UI 自检、真实 Electron IPC 探针均通过；Oracle 终局门禁通过 | M5 Web 主导整合边界 | 安全整改：sessionDir absent/direct/invalid 三态及绑定、Tasks/Cron/Agents 链接拒绝、agentId 路径段与 containment、RuntimeState 可见字段变更即活动刷新且时间单调；真实 WS/ACP 活动注入端到端自动化留作 M6 回归 |
2026-08-04 | M5 全部完成：Web 主导边界落地（通知安全导航 epoch/base/token 契约、WS question 仅通知/聚焦且与 ACP 本地窗 owner 隔离、未验证会话 URL 约 4s 有界索引重查、overlay context 合并补发、Esc 折叠且不拦截 Web UI 快捷键、托盘默认模型仅默认配置文案）；边界清单入库 `docs/web-ui-integration-boundary.md`；全量 26 份 `tests/test-*.js`、专项 acp-permission 11/11、acp-question 12/12、notification-nav 13/13、overlay context 6/6、Workspace selfcheck 61/61、Electron 集成探针均通过；Oracle 终局门禁通过 | M6 Windows 回归、安全门禁与发布 | 安全整改：审批/完成通知仅全来源 session ID 合法一致才可导航、question 事件绝不携带可导航 ID、重查禁 ACP/全量扫描/无限轮询、验证前不授权 Workspace、未验证 URL 不回退 explicit；Windows 原生通知 A→B→A、真实窗口 load/close 竞态、连续 ACP question/permission 与 fallback、overlay 导航恢复、create-in-dir 时序及快捷键矩阵留 M6 手测/回归 |
2026-08-04 | M6 自动门禁完成（M6-2/M6-3/M6-4 完成，M6-1 自动部分通过）：全量 29 份 `tests/test-*.js`（含 Git 特殊/rename/deleted 与 file-browser 逃逸、M6 IPC/restore 专项）、M4 selfcheck 61/61、M6 restore selfcheck 18/18、集成探针 `--all` exit 0（flag-off 10s×20 次采样无 workspace.html 且主会话 ready；flag-on 全链 IPC/Changes/Files/Projection）、Oracle 安全门禁通过、`release/v1.7.0` app.asar 源文件哈希 25/25 一致；回归矩阵入库 `docs/regression-workspace-m6.md`，发布/回滚流程入库 `docs/release-workspace-m6.md` | M6-1 人工验收 → M6-5 发布候选 | **未达发布候选出口**：托盘单/双击与右键、原生通知 A→B→A、快捷键、单实例、overlay 视觉、主题、优雅退出、面板反复开关 ≥10 次共享 WS、create-in-dir 时序、连续 ACP 窗口时序待人工未记录 PASS；Authenticode 四项产物均 `NotSigned`，无有效证书前仅内部测试包；flag 默认保持 false 不改为 true |
2026-08-04 | M6 自动门禁、安全审计、最终包内容核对完成 | 计划停止 | 用户明确跳过 Windows 原生人工验收与代码签名证书配置；M6 不标完成，`release/v1.7.0` 仅为未签名内部测试包，未达正式发布候选出口 |
