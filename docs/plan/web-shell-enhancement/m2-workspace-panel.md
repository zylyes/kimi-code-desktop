# M2 主窗口 Workspace 面板组合

> 来源：`WEB_SHELL_ENHANCEMENT_PLAN.original.md` §7 M2、§5.2/§5.3
> 归档日期：2026-08-03
> 状态：**已完成**（2026-08-03）
> 前置：M1 ✅
> 交付物：`src/main/main.js`（面板区/IPC/菜单/flag）、`src/main/session-workspace.js`、`src/preload/workspace-preload.js`、`src/pages/workspace.html|js`、`src/styles/workspace.css`、`tests/test-session-workspace.js`

## 任务

- [x] **M2-1** 面板 WebContentsView：创建/覆盖右缘（固定宽度）/折叠/z-order/关闭清理
  - 实现：main.js 面板区（常量 `WORKSPACE_PANEL_WIDTH=360`、`WORKSPACE_TOP_OFFSET=36`；`ensureWorkspaceView/layoutWorkspaceView/showWorkspacePanel/hideWorkspacePanel/toggleWorkspacePanel/workspaceContents/pushWorkspaceEvent`）；z-order overlay > Workspace > Web（showOverlay 暂隐、closeOverlay 恢复 pending）；销毁顺序=removeChildView→仅清自有资源→webContents.close→焦点回主窗口，**不停共享 WS**
  - 验证：冒烟内省 `bounds=1086,36 360x878`（1446×914 窗口）✅；loadFile 成功 ✅；无挂载失败 ✅
- [x] **M2-2** 会话上下文服务（三源+置信度+无 ACP）
  - 实现：`src/main/session-workspace.js`（114 行纯函数：`isValidSessionId/parseSessionIdFromUrl/resolveBySessionId/listCandidates/resolveContext`；索引条目注入、无 fs 副作用、路径注入防护）
  - 验证：`tests/test-session-workspace.js` 63 断言全绿 ✅；低置信仅候选、verified 才 bound、explicit 优先 ✅
- [x] **M2-3** `workspace:*` IPC 契约 + preload
  - 实现：`workspace:getContext`（sender 校验+sw.resolveContext）、`workspace:panelState`（查询/切换+**持久化 config.json**，orchestrator 补）、`workspace:selectCandidate`（仅 verified 置 explicit）；`workspace-preload.js` 白名单 4 通道；定向路由不经 foregroundContents()
  - 验证：node --check ✅；面板页初始化/折叠/候选绑定走通（冒烟日志无错误）
- [x] **M2-4** 主题/窗控联动
  - 实现：`applyAppThemeEverywhere` 加 workspaceView 分支；did-finish-load 主题类下发（视图自身 webContents，随 close 自清）；bounds 顶部 36px 避开窗控（窗控 32+4）
  - 验证：深色主题冒烟无异常（observer 复核）✅；截图方式对 WebContentsView 不可见（capturePage 不合成子视图，见执行日志），改日志内省验证
- [x] **M2-5** feature flag + 菜单入口
  - 实现：loadConfig 默认值 `workspacePanelEnabled:false`、`workspacePanelCollapsed:false`；视图菜单「工作区面板」checkbox（`visible: flag===true`，flag 关隐藏）；**loadMain 启动恢复**（flag 开且未折叠→showWorkspacePanel，orchestrator 补）
  - 验证：flag=false 基线冒烟（Web UI/WS/菜单正常、app.log 零 workspace 行）✅；flag=true 面板创建+布局正确 ✅

## M2 出口

- [x] flag 默认关下回归无回归（dev-verify 基线：WebView 加载 ok / WS 通知通道 ok / 新建对话按钮 ok / 无 workspace 日志）
- [x] flag 开启时面板骨架可用、无控制台错误（loadFile 成功 + bounds 正确 + 无错误日志）
- [x] 单测 `tests/test-session-workspace.js` 通过；全量单测 19/19 PASS（含 BOM 修复后回归）
- 遗留至 M6：§11 用例 9（反复开关 ≥10 次共享 WS 不断）需菜单交互自动化，随 M6 统一回归矩阵执行

## 执行日志

日期 | 已完成 | 下一步 | 备注/阻塞
--- | --- | --- | ---
2026-08-03 | M2 全部完成（三车道并行：fixer×2 + designer×1）；冒烟验证 flag 关/开两路径 | M3 Changes/Files 服务与 UI | **关键教训**：① PowerShell `Set-Content -Encoding utf8` 写 BOM 导致 config.json 静默失效（已修 `readJSON` strip BOM，产品健壮性修复，惠及记事本编辑场景）；② `BrowserWindow.capturePage()` 不合成 WebContentsView 子视图——面板类视图截图验证不可信，须用日志/内省；③ des-1 设计产出含页面级 `--color-warning` 令牌（待上提 kimi-theme.css，非阻塞）
