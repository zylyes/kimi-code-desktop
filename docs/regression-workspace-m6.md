# M6 Windows 回归矩阵（§11）与结论

> 面向维护者：本表是 M6-1 回归执行的唯一事实源，供发布门裁决与人工验收追踪。
> 依据：`docs/plan/web-shell-enhancement/WEB_SHELL_ENHANCEMENT_PLAN.original.md` §11（10 用例）与 §12.1 测试矩阵。
> 归档日期：2026-08-04
> 结论总览：**自动门禁全部通过；用户已明确跳过 10 项用例中的人工验收项。它们均未执行/记录，不得视为 PASS，M6 未达发布候选出口**。发布前置条件见 `docs/release-workspace-m6.md`。

## 0. 状态口径

- ✅ = 已自动化执行且通过（证据见 §2，可复跑）。
- ⬜ = 待人工（需真实 Windows 交互/视觉/时序验证，**尚未运行，不写 PASS**）。凡含部分自动覆盖的用例，自动部分在证据列注明，未人工部分仍记 ⬜。
- 已知非阻塞平台残余单独记录（§4），不计入 PASS 项。
- ⏭ = 用户明确跳过；不等同于 PASS，不可用于发布候选裁决。

## 1. §11 十项回归矩阵

| # | 用例（§11 原文） | 结果 | 自动门禁覆盖 | 待人工范围与通过标准 |
| --- | --- | --- | --- | --- |
| 1 | 托盘：最小化/点 X 收托盘、单击回窗、双击回窗（按源码现状 L3102–3103：单击与双击均绑定 `showMainWindow`，无"双击新会话"，据此实测不预设）、右键菜单各项（含「工作区面板」项） | ⬜ 待人工 | 无（真实托盘交互） | 单击/双击均回主窗；右键各菜单项可用；tooltip 用量/任务状态随 WS 更新 |
| 2 | 通知：审批请求/任务完成/问答事件通知出现且只出现一次（无 Web UI 重复）；点击聚焦主窗口 | ⬜ 待人工 | 通知导航纯函数 `notification-nav.js` 13/13（M5）+ 连续 ACP 窗口身份单测（permission 11/11、question 12/12） | Windows 原生通知真实点击：A→B→A 会话导航、聚焦主窗口、无双重通知；**连续 ACP permission/elicitation 的真实 BrowserWindow 时序**（load/close/替换竞态） |
| 3 | 快捷键：`Ctrl+Shift+Space`（全局显隐）、`Ctrl+Shift+S`（启动器）、`Ctrl+Shift+N`、`Ctrl+R`（作用于前台内容）、`Ctrl+,`（设置）、F1 | ⬜ 待人工 | 无（系统级全局快捷键） | 面板聚焦时全局快捷键仍生效；`Ctrl+R` 不误刷新面板；快捷键矩阵逐项实测 |
| 4 | 单实例：二次启动 → 已有实例聚焦；面板状态保持 | ⬜ 待人工 | 无（真实二次进程） | 无第二进程；面板状态不重置 |
| 5 | 覆盖层：sessions/setup overlay 显示时 Workspace 面板隐藏（z-order overlay > Workspace > Web）；关闭后恢复、Web UI 零重载 | ⬜ 待人工 | context 合并/恢复补发 `overlay-context-sync` 6/6（M5）；overlay 关闭安全恢复 `test-workspace-restore.js` 11 例 + M6 restore selfcheck 18/18 | **overlay 视觉**：切换无闪烁、面板按 z-order 正确显隐、共享 WS 连接不断、真实窗口零重载 |
| 6 | 主题：亮/暗切换时面板、覆盖层、主窗口同步 | ⬜ 待人工 | 无（截图回归） | 亮/暗双主题面板四标签无硬编码色值，与覆盖层/主窗口同步 |
| 7 | 优雅退出：托盘退出先 `POST /api/v1/shutdown`；面板随窗口销毁无泄漏 | ⬜ 待人工 | 无（真实进程生命周期） | 日志无异常；进程干净退出；无监听器/webContents 泄漏 |
| 8 | 面板刷新：已验证会话切换/窗口焦点变化/3s 防抖刷新；未绑定状态不触发任何文件读取 | ◐ 自动门禁已覆盖数据链路；时序项 ⬜ | 探针 flag-on 导航真实会话后 context 绑定 + Changes/Files/diff/Projection 全链（§2）；3s 防抖与未绑定不读文件由单测覆盖 | **create-in-dir index 时序**：真实 create-in-dir 会话进入 `session_index.jsonl` 的时机与本地重查/刷新一致性，真实仓库实测 |
| 9 | 面板反复开关：连续开/关/折叠 ≥10 次（含销毁重建）；每次关闭仅取消 Workspace 自有资源，不停主进程共享 WS | ⬜ 待人工 | 显式销毁顺序契约由 `test-workspace-ipc-guard.js` 等单测部分覆盖 | 真实菜单交互开/关/折叠 ≥10 次：共享 WS 连接数与 generation 不变、事件照常处理；无监听器悬挂、webContents 无泄漏；托盘/通知/runtimeState 不受影响 |
| 10 | feature flag 关闭路径：`workspacePanelEnabled:false` 时完全不创建面板 `WebContentsView`，菜单/托盘入口隐藏或禁用 | ✅ 自动通过 | 探针 `--all` 的 flag-off 子进程（§2） | 关闭路径结论见 §3（一级回滚基线）；菜单/托盘入口隐藏行为待人工复核时一并确认 |

## 2. 自动门禁证据（✅，均已通过）

| # | 证据 | 结果 | 说明 |
| --- | --- | --- | --- |
| A1 | 全量单测 `tests/test-*.js`（逐个 `node tests/test-*.js`） | 29/29 | 覆盖 M6 新增 `test-workspace-ipc-guard.js`（9 组 IPC/导航/日志门）、`test-workspace-restore.js`（11 例）及既有全部模块。**Git 特殊路径（rename/空格/制表符/换行）与 deleted/rename 源路径 containment 用例**在 `test-git-service.js`（含 `GIT_LITERAL_PATHSPECS` 断言）；**file-browser 逃逸用例**（`.git`/`node_modules` 不可绕过、descendant symlink/junction 拒绝、openVerifiedRead 注入矩阵）在 `test-file-browser.js` |
| A2 | M4 workspace selfcheck | 61/61 | `C:\Users\zyl\AppData\Local\Temp\opencode\m4-workspace-selfcheck.cjs`（DOM+vm 加载 `src/pages/workspace.js` 事件驱动断言，M5 扩展至 61 断言） |
| A3 | M6 restore selfcheck | 18/18 | `C:\Users\zyl\AppData\Local\Temp\opencode\m6-workspace-restore-selfcheck.cjs`（overlay 关闭安全恢复 renderer 时序：ack 时机、同步清空旧 DOM、在途请求不写回、失败也回执、ack 抛错不致命） |
| A4 | `npx electron scripts/dev/workspace-integration-probe.js --all` | exit 0 | 顺序 spawn 两个独立子进程（独立 userData，互不污染），任一失败整体非零：<br>• **flag-off**：10 秒观察窗、500ms/次共 20 次采样，全量枚举 webContents **无任何 `/workspace.html` 视图**（即无 workspace-preload 注入、`workspace:*` IPC 无合法 sender）；主 Web 会话仍成功加载（URL 保持 http(s)、`document.readyState` 可达）。<br>• **flag-on**：真实 `WebContentsView` → preload → IPC → Git/Files 全链：等主窗口 http(s) 与 workspace 子页面出现（≤90s）→ 导航 `/sessions/<target>` → context 绑定 → Changes/Files/diff（快照 entryId）/Projection 均取数成功、panelErrors 为空 |
| A5 | M6 Oracle 安全门禁 | 通过 | `workspace:*` IPC 审计（仅白名单通道、入参校验、`isWorkspaceSender` 三条件、导航偏离即安全销毁）、git-service 参数白名单断言（固定子命令集合 + literal pathspec）、file-browser 逃逸用例复跑、日志脱敏复核（异常只回 `{ok:false, reason}`，详细 err.message 仅本地日志；`server:log` 广播门禁 Web 页）。Oracle 高危整改项（可信 origin/导航指纹/字面 pathspec/TOCTOU 加固/restore 状态机）均有单测落地 |
| A6 | 最终包 `app.asar` 源文件哈希 | 25/25 一致 | `release/v1.7.0`（2026-08-04 打包，`npm run pack:versioned:ca`）`win-unpacked/resources/app.asar` 内源文件与 `src/` 对应文件哈希逐一比对一致；`build.files` 覆盖 workspace.html/js/preload/新模块无缺失 |

## 3. flag-off 回退结论（一级回滚基线）

- **关闭时（`workspacePanelEnabled:false`）**：未创建 Workspace view、未注入 workspace-preload、无 `workspace:*` IPC 可达（无合法 sender）；主 Web 会话仍正常加载与使用（A4 flag-off 实测）。
- **结论**：flag 关闭即行为等同 v1.7 基线，构成**一级回滚**——无需重装、不触碰 CLI/共享 WS，重启/重开窗口即生效。此结论同时是 §1 用例 10 的自动通过判定依据与 `docs/release-workspace-m6.md` 回滚一节的事实基础。

## 4. 已知非阻塞平台残余（受限威胁模型）

- **事实**：Windows Node 无原生 `O_NOFOLLOW/openat`。`file-browser.js` 的读预览采用「lstat 快照（dev/ino/size）→ open 'r' 只读 → fstat 句柄比对」纯 JS 防护（任一不一致立即 close 且零读取）；listDir 在 opendir 前追加 lstat 缩小检查-使用窗口。**JS 层无法原子消除 lstat 与 open/opendir 之间目录 reparse point 并发替换的理论 TOCTOU 窗口**（模块注释如实声明，不引入 native 依赖）。
- **适用威胁模型（受限）**：同用户、已有能力在用户工作区内创建/替换文件与目录的恶意或失陷进程，且须在检查与使用之间的微小窗口内精确完成替换。不适用远程攻击者；不构成权限提升；不暴露跨用户数据；`openVerifiedRead` 对读目标替换可做到可靠拒绝。
- **处置**：不虚假声称完全消除；该边界已入 Oracle/fixer 记录，M6 不设阻塞项。

## 5. 下一步

- 发布前置条件与签名决策：见 `docs/release-workspace-m6.md`。
- 人工验收清单即本表 ⬜ 项（§1 用例 1–7、8 的时序部分、9、10 的菜单入口复核）；全部记录为 PASS 前，M6 不达发布候选出口（见 `docs/plan/web-shell-enhancement/m6-regression-release.md`）。
- 2026-08-04 用户选择跳过上述人工项；本矩阵保留其未验证状态，计划执行停止。
