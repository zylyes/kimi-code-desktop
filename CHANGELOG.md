# Changelog

## [1.7.0] - 2026-07-27

### 改进

- **菜单结构整理**（原生菜单与自绘面板同步）：视图菜单「缩放与全屏」归组二级（放大/缩小/重置/全屏）；帮助菜单「排查问题」归组二级（kimi doctor/打包诊断/数据目录）；应用菜单「开发者」归组二级（开发者工具/重新加载）；视图新增「用量统计」。
- **移除「手动输入地址…」菜单入口**（`Ctrl+L`）：该功能保留于设置页手动模式，仅移除菜单快捷键入口（help.html 同步删除对应行）。

### 其他

- 无破坏性变更。

## [1.6.0] - 2026-07-27

### 改进

- **自绘窗控全应用统一**：窗口控制三键（min/max/close）由 `menu-panel.js` 统一注入——本地页挂 `.app-topbar-actions` 末尾（☰ 右侧），Web UI 页 `fixed top:0;right:0`（☰ 相应改为 `right:118px`）；`framelessOpts()` 移除 `titleBarOverlay`，全窗口不再依赖 OS 悬浮窗控。
- **样式收拢**：`.app-topbar` 收回为 OS 窗控让位的 150px 右 padding（`0 14px` 对称）；`.kcd-win-btn` 样式与暗色规则并入 menu-panel.js 内联样式；usage 页单页窗控实现全量回退。
- **桥接统一**：`windowControl` 归入 `kimiDesktopMenu` 桥（preload + chat-preload 双端），`applyTitlebarStyle` 广播四键同吃（☰ + 三窗控同色同高）。

### 其他

- preload 采样过滤补 `.kcd-win-btn`/`.kcd-win-controls`。
- 无破坏性变更。

## [1.5.0] - 2026-07-27

### 新功能

- **用量统计面板自绘窗控**：usage 窗口改为 `titleBarStyle: 'hidden'` 页面自绘三键（min/max/close，`.kcd-win-btn` 视觉逐字复刻 ☰ 按钮），不再依赖 OS `titleBarOverlay`；新增 `window:control` IPC（action 白名单，供自绘窗控调用）。
- **托盘菜单「用量统计」入口**：托盘右键菜单新增「用量统计」，直达用量面板。

### 改进

- `usage:getSnapshot` 显式传 `sessionId: null`（明确取全局用量）。
- preload 新增 `windowControl` 桥接。

### 其他

- 无破坏性变更。

## [1.4.0] - 2026-07-27

### 新功能

- **用量统计面板**：新增 `usage.html` + `usage.js`（单例窗口 960×640）——上下文窗口占用、会话用量、托管用量（计划/钱包）、趋势（today/7d/30d 按小时/按日序列 + 分模型汇总）与诊断错误展示；60s 自动刷新（页面隐藏暂停、回前台立即刷）、请求序号防竞态、首次加载三态 + 静默刷新。
- **菜单入口**：自绘菜单「视图 → 用量统计」打开面板。
- **IPC**：新增 `usage:getSnapshot`（复用本地命令服务 `/usage`）。

### 其他

- preload 新增用量统计桥接。
- 无破坏性变更。

## [1.3.0] - 2026-07-27

### 新功能

- **运行时状态层**：新增 `runtime-state.js`——WS/ACP 事件统一规范化入口，维护任务状态（幂等 started/completed、乱序 tombstone、未知任务合成键）与按会话分桶的 usage 统计。
- **任务目录**：新增 `task-catalog.js`——运行时快照 + ACP 目录观察（cron/tasktool）+ 磁盘 `sessions/<sid>/tasks|/cron` 三源合并，带诊断计数（扫描/坏行统计）。
- **子 Agent 树**：新增 `subagent-tree.js`——从运行时快照构建子 Agent 层级树。
- **用量统计**：新增 `usage-stats.js`（会话分桶统计）与 `managed-usage.js`（OAuth token 加载 + 托管用量拉取）。
- **CLI 更新模块**：新增 `cli-update.js`——托管 CLI 更新流程（361 行测试覆盖）。
- **本地命令服务**：新增 `local-command-service.js`——本地命令执行服务。
- **ACP 事件探针**：新增 `scripts/acp-event-probe.js`。

### 改进

- **ACP 原生聊天窗大幅扩展**（+1033 行）：任务目录/子 Agent 树渲染、运行时状态可视化。
- **setup.html**（+151 行）：CLI 更新与用量相关配置入口。
- **托盘状态**：用量/任务进度改由 RuntimeState 快照提供，审批/问答计数保留本地。

### 其他

- 新增 7 套单元测试：test-runtime-state / test-task-catalog / test-subagent-tree / test-usage-stats / test-cli-update / test-local-command-service / test-managed-usage（含 fixtures）。
- 新增 `docs/memory/`（agent 记忆）与 `docs/plan/`（计划归档）。
- 无破坏性变更。

## [1.2.0] - 2026-07-27

### 新功能

- **Markdown / 代码高亮渲染**：新增 `chat-markdown.js`（UMD 双兼容，Node + 浏览器），为 ACP 原生聊天窗提供 Markdown 渲染与代码语法高亮；经 `chat.js` 集成，助手消息自动渲染为富文本（标题/列表/代码块/行内代码/链接/加粗/斜体）。

### 改进

- **ACP Elicitation 原生问答桥接**：新增 `acp-elicitation.js` 解析层——将 `session/request_permission` 中 `AskUserQuestion` 形态解析为原生问答窗可用的题目结构（多题分组、选项映射、skip 处理）；主进程 `question:submit` 直接回执 ACP settle（不走 HTTP），回答后 1.5s 自动关窗；`question:fallback` 按取消处理。
- **ACP 审批窗 Plan Approval UI**：新增 `plan-approval.js`（Plan 审批卡片渲染——工具列表/说明文字/确认取消按钮组），`permission.html`/`permission.js` 集成 Plan 审批展示。
- **打包清单**：新增 `src/pages/vendor/**`（第三方渲染库），`chat-markdown.js`、`plan-approval.js`、`acp-elicitation.js` 自动纳入。

### 其他

- 新增 `tests/test-acp-elicitation.js`、`tests/test-chat-markdown.js`、`tests/test-plan-approval.js` 三套单元测试。
- 无破坏性变更。

## [1.1.0] - 2026-07-27

### 改进

- **移除旧版 CLI（< 0.28）兼容代码**：不再向后兼容 0.27 及更早版本，启动检测到过旧 CLI 时提示升级（setup.html 新增 `cli-outdated` 引导）；实例管理移除 `server/lock` 旧格式回退，仅使用 `server/instances/*.json` 新版格式。

### 其他

- **文档重整**：删除内部开发文档（`FEATURE-IDEAS.md`、`docs/acp-probe*.txt`、`docs/acp-research.md`），新增公开文档（`docs/ROADMAP.md`、`docs/kimi-docs/`）。
- **测试工具**：新增 `scripts/regression-0.29.js`（CLI 0.29 回归测试）、`scripts/ws-event-probe.js`（WS 事件探测）；更新 `tests/test-instances-manager.js`（仅测试新版格式）。
- 无破坏性变更。

## [1.0.0] - 2026-07-26 🎉

首个公开发行版。经过 20 个版本的迭代（v0.1.0 → v0.20.0），Kimi Code Desktop 已从基础 Electron 套壳演进为功能完整的原生桌面体验。

### 核心能力

- **Kimi Web 桌面化**：一键启动 `kimi web` 本地服务，自动捕获会话地址嵌入桌面窗口。
- **会话启动器**（`Ctrl+Shift+S`）：历史浏览、搜索、恢复、ZIP/Markdown 导出、可视化、指定目录新建。
- **图形化设置中心**：config.toml GUI 编辑、权限规则、供应商/模型管理、MCP 服务器配置、Skills/Hooks 编辑器、IDE 接入向导、插件管理、应用设置（主题/缩放/托盘行为/自启/通知/热键 8 项）。
- **ACP 原生聊天**：完全原生聊天 UI——流式正文/思考折叠、真实会话化、历史恢复、configOptions 切换栏、斜杠命令菜单、图片输入、审批弹窗、工具调用卡片、WebView 降级入口。渐进替代 WebView，全链路原生。
- **无边框窗口体系**：全窗口统一 frameless + titleBarOverlay 悬浮窗控，窗控颜色与页面实时同步（<100ms），暗色模式 Web UI 主题与桌面应用主题解耦。
- **Kimi 风自绘菜单面板**：全窗口统一 ☰ 按钮，分组/勾选态/快捷键提示/二级子面板，亮暗双主题。
- **会话归档/删除**：能力自适应探测，WS 事件自动刷新。
- **多实例管理**：扫描/切换/存活检测。
- **全局热键**：`Ctrl+Shift+Space` 全局显隐，`Ctrl+Shift+S` 启动器，`Ctrl+,` 设置。
- **通知与状态**：桌面原生通知（消双重弹出）、托盘用量/任务进度、窗控颜色无缝融合。
- **项目结构**：`src/main/` / `src/pages/` / `src/preload/` / `src/styles/` / `tests/` 分层架构。

### 统计

- **20 个版本**（v0.1.0 → v1.0.0），**80 项功能**，**7 套单元测试全部通过**。
- 源码规模：主进程 ~4500 行，页面 ~6000 行，CSS 令牌系统 ~800 行。

### 其他

- **开源社区文档**：新增 `LICENSE`（MIT）、`CONTRIBUTING.md`（贡献指南）、`CODE_OF_CONDUCT.md`（行为准则）、`SECURITY.md`（安全策略）、`SUPPORT.md`（支持与诊断）。
- 新增 `.github/` 社区模板目录（Issue/PR 模板）。
- README 新增「项目文档」索引表。
- 无破坏性变更。所有 v0.x 用户平滑升级。

## [0.20.0] - 2026-07-26

### 改进

- **项目结构重组**：全部源码从扁平根目录迁移到分层结构——`src/main/`（主进程模块）、`src/pages/`（HTML/JS 页面）、`src/preload/`（预加载脚本）、`src/styles/`（CSS 样式）、`tests/`（单元测试）；`package.json` 入口改为 `src/main/main.js`，打包清单改用 glob 模式；`build.files` 从逐文件列举精简为 5 条 glob 规则。

### 其他

- `.gitignore` 扩展：新增编辑器/系统/敏感配置文件忽略规则。
- 无破坏性变更。

## [0.19.4] - 2026-07-26

### 修复

- **深色模式顶栏异色根治**：`header.chat-header` 强制背景色的暗色变体原挂在 `@media (prefers-color-scheme)`（跟随桌面应用主题），与 Web UI 自身主题设置解耦——Web UI 深色 + 桌面/系统浅色时头部被刷白、右上窗控采样随之整条顶栏发白。改为 preload 在内容区代表点用 `elementsFromPoint` source-over 合成判定**页面实际渲染主题**（亮度 ≤0.4 判暗），在 `<html>` 维护 `kcd-page-dark` 类，注入 CSS 暗色规则改挂该类；顶栏任何「Web UI 主题 × 桌面主题」组合下都与页面一致。
- **本地页面深色跟随 Web UI 实际主题**：全部本地页（设置/会话启动器/局域网/子 Agent 监视/Prompt 库/快捷键/ACP 聊天/审批/问答）的暗色此前只经 `prefers-color-scheme` 跟随桌面主题，Web UI 深色时仍渲染浅色。新增生效主题裁决 `effectiveDark()`（桌面设置显式亮/暗优先，「跟随系统」时随 Web UI 实际主题、未上报退回系统），preload 检测翻转经 `kcd:page-theme` 上报，主进程向所有窗口与覆盖层页面置 `kcd-page-dark`/`kcd-page-light` 类并刷新窗口底色与悬浮窗控；`kimi-theme.css` 暗色令牌与 `menu-panel.js` 暗色规则改为「类驱动 + 媒体查询兜底」双通道。

### 其他

- 无破坏性变更。

## [0.19.3] - 2026-07-24

### 改进

- **蒙版切换变色链路重构（渲染端同步算色，根治 600ms+ 延迟）**：设置模态开/关窗控条变色不再等主进程防抖追采——preload 在 DOM 变化瞬间用 `elementsFromPoint` 对窗控采样点元素栈做 source-over 合成、同步算出目标色随 `kcd:titlebar-color` 直发主进程（即收即应用，无防抖）；蒙版淡入/淡出动画期 rAF 逐帧跟踪（`getComputedStyle` 实时反映 opacity 过渡，有色变才发）；主进程 350ms 后做一次 `capturePage` 校验采样兜底（不一致以采样为准），渲染端算不出色（null）时仍走原 50ms 采样路径。逐帧 OS 级截屏实测（`scripts/probe-panels.js`，~100ms/帧）：开窗控条色与蒙版参考色从首帧起 Δ=0、淡入在 +261→+348ms 内完成，关 +46→+230ms 内完成，全程无「页面已变窗控不动」，变色收敛 <100ms（原 600ms+）。
- `scripts/probe-panels.js` 扩展为蒙版开/关窗控变色逐帧 OS 级测量（331 行新增）。

### 其他

- 无破坏性变更。

## [0.19.2] - 2026-07-24

### 修复

- **模态蒙版下窗控符号色修正**：`titlebarColorForWindow` 亮度阈值 0.6 → 0.4（亮页/蒙版灰用黑符号、暗页用白符号），修复设置模态压暗时 −▢× 变白的问题；新增符号色广播（`kcd:titlebar-style` IPC + preload `onTitlebarStyle` 桥），☰ 按钮内联色与原生三键永远一致。
- **右侧面板头部避让右上窗控**：`aside.global-preview .ui-panel-header` 注入 `padding-right:228px`，修复改动面板「列表/树形」切换、预览面板「适应/原始」切换与关闭按钮被 −▢× 悬浮窗控遮挡、文件大小被 ☰ 遮挡的问题。

### 改进

- **窗控条高度跟随会话头部**：preload 实测 `header.chat-header` 的 `offsetHeight`（钳制 32~64）上报，主窗口 `titleBarOverlay` 高度与 ☰ 按钮高度随动，四键与会话头部图标垂直同线；颜色采样点移至窗控条垂直中心。
- **蒙版切换变色提速**：preload MutationObserver 节流 300ms → 50ms + ~250ms 尾随信号踩蒙版淡入/淡出结束帧，main 防抖 250ms → 50ms，窗控变色端到端延迟降低。

### 其他

- 新增 `scripts/probe-panels.js`（页面元素探针 dump）。
- 无破坏性变更。

## [0.19.1] - 2026-07-24

### 修复

- **窗控颜色采样改进**：Web UI 页窗控区颜色采样从 preload `elementsFromPoint` 改为 main 进程 `capturePage` 众数像素（取页面实际渲染的众数色，自然剔除文字噪点），`setTitleBarOverlay` 同步更精确；preload 仅发变色信号，main 防抖 250ms 重采。
- **菜单按钮自愈重挂**：Web UI 页 ☰ 按钮注入改为 main 进程 `executeJavaScript`（绕过页面 CSP，`did-navigate-in-page` 同步补注），按钮带 MutationObserver + 轮询自愈（SPA 重渲染移除节点后自动补挂）。

### 其他

- `menu-panel.js` 加入打包清单（build.files），修复打包后菜单面板缺失。
- CHANGELOG 措辞精修（窗控区同步与菜单面板条目）。
- 无破坏性变更。

## [0.19.0] - 2026-07-24

### 改进

- **窗控区颜色运行时同步**：主进程对 Web UI 页窗控区正下方页面像素做 `capturePage` 采样（众数色，天然剔除文字噪点；preload 以 MutationObserver + 轮询发变色信号，主进程防抖 250ms 重采），动态 `setTitleBarOverlay`（symbolColor 按亮度自适应）；官方「改动」面板、文件预览、设置模态压暗等任意顶栏状态下悬浮窗控与页面实际渲染融为一体，彻底消除窗控「补丁」感。本地页与覆盖层打开时仍恒用窗口背景色。
- **应用菜单重做（Kimi 官方风自绘面板）**：右上角两个浮动小按钮合并为单个 ☰ 按钮（与悬浮窗控同排同风格），点击展开自绘下拉面板（新文件 `menu-panel.js`，渲染端共享）——圆角卡片浮层、分组标题、勾选态、右侧快捷键提示、模型/多实例二级子面板、Esc/点外部/失焦关闭、亮暗双主题；菜单结构与动作走新 IPC `menu:getDefinition`/`menu:run`（分组：会话/模型/多实例/设置/视图/帮助）。按钮带自愈重挂（MutationObserver + 轮询，SPA 重渲染移除节点后自动补挂），Web UI 页经主进程 `executeJavaScript` 注入（绕过页面 CSP，did-navigate-in-page 同步补注）。隐藏的原生应用菜单重组为同构分组、仅作快捷键载体；`app:popupMenu` 与旧浮动按钮注入移除。全窗口统一入口：本地页（chat/agents/help/prompts/lan/sessions/setup/loading）经 `<script src="menu-panel.js" defer>` 挂载，`chat-preload.js` 补同名桥接；`menu-panel.js` 已加入打包清单。
- **新建对话确认保留并鲁棒化**：实测当前 Web UI 官方新建按钮（`button.btn-new-chat`）存在，点击后 SPA 原地切换到新空会话（无整页重载、无新进程）；`newConversationInPlace` 改为候选选择器数组逐个尝试（`.btn-new-chat` → `aria-label` → 按钮文本匹配），500ms 重试与「不在 Web UI 先导航回 / 服务未运行退化为重启」路径不变。
- **全页面官方风美化**：chat/sessions/setup/agents/help/prompts/lan/loading/permission/question 十页逐页对齐 kimi-theme.css 令牌——硬编码色值清零，圆角/字号/间距统一，按钮归一 `.btn`/`.icon-btn` 体系，空态/加载态走共享 `.notice`/`.loading`/`.spinner`，卡片留白与 hover/focus 态规范，暗色主题逐页核验；loading 页进度条改共享 `.spinner`，sessions 详情标题收敛至 14px 全局层级，setup 分区标题改 `.side-group` 弱化风，重复 CSS（`.topbar-note`/`@keyframes rise`/`.mono` 等）去重回落主题。

### 其他

- `scripts/screenshot-pages.js` 离屏连拍禁用硬件加速并加窗口建毁间隔，修复第二页起 ERR_FAILED 崩溃；新增 `scripts/screenshot-one.js`（单页单进程截图）与 `scripts/probe-one-page.js`（单页加载探针）。
- 无破坏性变更。

## [0.18.0] - 2026-07-24

### 改进

- **WebContentsView 覆盖层架构**：sessions/setup/loading 由全页加载重构为 `WebContentsView` 覆盖层，打开时盖在常驻 Web UI 之上，切回时直接移除覆盖层（零重载、不丢 WS 连接）；覆盖层随窗口 resize 同步 bounds，窗口关闭时显式清理防泄漏；`foregroundContents()` 统一路由 IPC 定向消息（登录日志/安装日志/通知）到前台页面。
- **菜单扁平化**：去除「会话」子菜单层级，常用操作（会话启动器/新建对话/设置/轮换令牌/局域网/原生聊天）平铺顶层；仅「视图」「帮助」保留为子菜单；「重新加载」提到顶层。
- **聊天头部背景对齐**：`header.chat-header` 强制设为窗口背景色（亮 `#fbfaf9` / 暗 `#121212`），与右上角悬浮窗控融为一体，消除接缝；同时移除头部底部分隔阴影。
- **WS 连接幂等**：`startWsSubscription` 检测同 base/token 已连接时直接复用，避免覆盖层切回时重复建连。
- **菜单按钮锚定**：`app:popupMenu` 接收按钮 rect 坐标（经 zoomFactor 换算），菜单精确锚定到按钮位置弹出。

### 其他

- `windowOpenHandler` 提取为独立函数（主窗口与覆盖层共用）。
- `.statusbar` 整行加入拖拽区（与 `.topbar` 一致），内部按钮/下拉保持可点击。
- 覆盖层存在时 `session:changed` 通知发往覆盖层而非主窗口。
- 无破坏性变更。

## [0.17.0] - 2026-07-24

### 改进

- **全窗口无边框化（品牌一致性）**：原生标题栏与 Web UI 品牌区/会话头部内容重复，全部窗口（主窗口、设置、会话启动器、问答、Prompt 模板库、快捷键速查、局域网访问、子 Agent 监视、ACP 原生聊天、ACP 审批、会话可视化）统一改为 `titleBarStyle: 'hidden'` + `titleBarOverlay` 右上角悬浮窗控（min/max/close），经 `framelessOpts()/applyFrameless()` 助手接入；悬浮窗控配色跟随亮/暗主题（`nativeTheme.updated` 联动 `setTitleBarOverlay`，覆盖全部已开窗口）。
- **窗口拖拽**：顶部 10px 拖拽条统一为 `#kcd-drag-strip` 共享样式（kimi-theme.css），各本地页内嵌元素、Web UI 与 kimi vis 外部页由 preload + insertCSS 注入；`.topbar` 顶栏整行作拖拽区（交互控件 `no-drag` 除外），Web UI 会话头部 `header.chat-header` 右内边距 154px 避开悬浮窗控，双击拖拽区切换最大化。
- **页面内菜单按钮**：无边框后无原生菜单栏（同时 `setMenuBarVisibility(false)` 屏蔽 Alt 唤出），主窗口右下角设置按钮上方注入 `☰` 浮动按钮，点击经 `app:popupMenu` IPC 弹出完整应用菜单（菜单加速键不受影响）。

### 其他

- 无破坏性变更。

## [0.16.1] - 2026-07-24

### 修复

- **CLI 更新检查误报**：`compareSemver(current, latest) !== 0` 修复为 `< 0`，之前本地版本高于远程时也会提示"有更新"。
- **通知点击崩溃**：通知点击回调改用 `showMainWindow()`（窗口已销毁时自动重建并拉起服务），修复 `mainWindow` 为 null 时的崩溃。

### 改进

- **屏蔽网页 HTML5 通知**：新增 `blockWebPageNotifications()`，在 `session.defaultSession` 与 `persist:kimi-code` 上拒绝 `notifications` 权限，桌面端统一由主进程原生通知展示，避免同一事件双重弹出。

### 其他

- 无破坏性变更。

## [0.16.0] - 2026-07-23

### 改进

- **Windows 通知应用名显示修正**：启动时调用 `app.setAppUserModelId(APP_NAME)`，系统通知顶部显示「Kimi Code Desktop」，不再显示 Electron 默认的 `electron.app.*`。
- **kimi-theme.css 共享层扩充**：新增 `--font-mono` 令牌（各页等宽字体栈统一引用）与 `.mono` 工具类、新增 `--radius-sm`（8px）令牌；`.btn` 体系补齐 `.btn-secondary`/`.btn-danger` hover 态，新增 `.btn.ghost` 变体与共享 `.icon-btn`；上提弹窗家族共享组件（顶栏品牌区、bridge-warn、loading、notice、foot/hint 系、spinner 与 rot/rise 动画、420px 与 prefers-reduced-motion 媒体查询），permission 与 question 两窗重复 CSS 去重。
- **sessions 启动器配色收敛**：移除自造第三点缀色 `--color-warning`（琥珀色），归档标识与 bridge-warn 改灰阶中性色，回到主题「仅 error/success 两点缀色」原则。
- **各原生窗口令牌化清理**：圆角统一走 `--radius-pill`/`--radius-sm`/`--radius-card`，等宽字体栈统一 `var(--font-mono)`，焦点环统一走主题 `:focus-visible`，禁用态透明度统一 0.4；`.card`/`.btn-primary` 的逐属性复刻改为直接复用共享类。
- **Web UI 浮动设置按钮色值对齐**：main.js 注入的 `#kcd-settings-fab` 边框与阴影色值对齐主题 separator/shadow-card 令牌（亮/暗两套，注入页无法引用 var()，手写同值并注释来源）。

### 其他

- 无破坏性变更。

## [0.15.0] - 2026-07-23

### 新功能

- **应用设置面板**：设置页新增「应用设置」面板，支持主题模式（跟随系统/浅色/深色）、界面缩放（80%~150%）、关闭/最小化到托盘开关、窗口置顶、开机自动启动、桌面通知、全局快捷键共 8 项；全部即时生效，不重启 server。
- **设置页侧栏导航**：设置页 UI 从标签页横幅重构为左侧分组导航 + 右侧内容布局，分组为「应用」「环境」「配置」「集成」，支持 url `?tab=` 定位。
- **Web UI 浮动设置按钮**：kimi web 会话页右下角注入齿轮设置按钮（不依赖页面 CSP，主进程 insertCSS + preload DOM 注入双通道），点击直接打开设置页。
- **会话启动器设置入口**：新建按钮旁新增齿轮设置按钮（`⚙`），直达设置。

### 其他

- `config.json` 新增 `theme`/`zoomFactor`/`closeToTray`/`minimizeToTray`/`alwaysOnTop`/`launchAtLogin`/`notificationsEnabled`/`globalHotkeyEnabled` 共 8 键；`app:info` / `setup:save` 同步登记。
- 新增 IPC 通道 `app:saveAppSettings`（白名单即时生效）、`app:backToSession`（返回会话页）；preload 新增 `saveAppSettings` / `backToSession` 桥接。
- 设置页新增「返回会话」按钮（仅手动打开时展示）。
- 窗口关闭/最小化到托盘、桌面通知、全局热键可通过应用设置关闭；关闭后走系统默认行为。
- 无破坏性变更。

## [0.14.0] - 2026-07-23

### 新功能

- **autoStartCli 配置项**：设置页新增「启动时自动连接 CLI」开关，关闭后启动时先停留在配置页而非自动连接；默认开启，保持原有行为。
- **托盘菜单「设置…」**：托盘右键菜单新增「设置…」入口，直达设置页。
- **菜单栏「设置…」+ 快捷键**：菜单栏「会话」子菜单新增「设置…」（`Ctrl+,`），快速打开设置。

### 其他

- `config.json` 新增 `autoStartCli` 字段（默认 `true`），`app:info` / `setup:save` 同步登记。
- 无破坏性变更。

## [0.13.0] - 2026-07-23

### 新功能

- **ACP 原生聊天斜杠命令菜单**：`available_commands_update` 全量转发至渲染层（commands 事件载荷改为 `{type:'commands', count, commands:[{name, description, hint}]}`，hint 无值时为 `''`）；输入 `/` 触发前缀过滤弹窗，键盘上下键 + Enter 与鼠标点击均可选中插入；命令作为普通文本 prompt 发送，由 agent 原样执行。
- **ACP 原生聊天图片输入**：composer 新增圆形附件按钮（回形针图标），系统选图后以 base64 图片块（`{type:'image', data, mimeType}`）随 prompt 发送（图片块在前、文本块在后）；mimeType 白名单 image/png、image/jpeg、image/gif、image/webp，单张解码后 ≤10MB，一次 ≤4 张（超限跳过并提示）；textarea 上方缩略图 chips 可单张移除，用户气泡内嵌图片预览；CSP 放行 `img-src data:`。
- **WebView 降级入口**：聊天窗状态条右侧新增「Web UI」小按钮，一键聚焦主窗高级面板，原生聊天能力缺失场景可随时降级回 Web UI。

### 其他

- `acp-client.js` 的 `prompt()` 签名扩展为 `prompt(text, images)`（images 可选，元素 `{mimeType, data(base64)}`；不传 images 时行为与现状完全一致）。
- 新增 IPC 通道 `acp-chat:pick-images`（系统选图 + 白名单/大小/数量校验，返回 `{ok, images, skipped}`）与 `acp-chat:open-webui`（聚焦主窗）；`acp-chat:prompt` 现接收 `(text, images)`。
- preload `window.kimiChat` 新增 `sendPrompt(text, images)`/`pickImages()`/`openWebUI()`（start/setConfig/cancel/onEvent 保持现状）；chat.html 新增 slashMenu/attachBtn/chips/webuiBtn。
- 新增 `scripts/acp-probe4.js`（第四次 ACP 探测：图片块 prompt 往返，验证 agent 识图）。
- 已知限制：probe4 实测本机 CLI 0.27.0 虽声明 `promptCapabilities.image:true`，但图文 prompt 会致 `kimi acp` 子进程崩溃（0xC0000409）或挂起无响应（docs/acp-probe4-output.txt）；图片输入链路已按协议完整实现并带失败引导（提示改走 Web UI），待 CLI 修复后重跑 `node scripts/acp-probe4.js` 复测。
- 无破坏性变更。

## [0.12.0] - 2026-07-23

### 新功能

- **ACP 原生聊天真实会话化**：`acp-chat:start` 支持 `{cwd, sessionId}`；真实工作目录启动（路径非法回退临时目录）；菜单项改名「原生聊天（新会话）…」。
- **历史会话恢复**：会话启动器详情新增「原生聊天」按钮（无 workDir 的会话禁用并提示；敏感目录弹确认）；恢复 = `session/load` 接续 agent 上下文 + 本地 wire.jsonl 自绘最近 50 条历史（双保险：若 agent 重放则跳过本地历史）；聊天窗标题栏显示会话名与工作目录、窗口标题动态化；load 失败明确报错不静默回退新建。
- **configOptions 原生切换栏**：聊天窗状态条下新增模型/思考/权限模式三下拉（缺项自动隐藏）；切换走 `session/set_config_option`，`config_option_update` 通知幂等回显，失败回滚并提示；仅就绪且非在途时可操作。
- **停止生成按钮**：busy 时发送键变「停止」，走 `session/cancel` 通知。
- **第三次 ACP 探测**：新增 `scripts/acp-probe3.js` 与 `docs/acp-probe3-output.txt`（786 行），`docs/acp-research.md` 追加第三次探测小节。实测结论：`session/load` 存在（参数 `{sessionId,cwd,mcpServers:[]}`，响应仅含 configOptions，实测无历史重放）、`session/set_config_option` 可用（字符串 value，响应与 `config_option_update` 通知均带完整 configOptions，失败 -32603，改动不跨 load 持久）、`session/list` 存在（条目 sessionId/cwd/title/updatedAt + nextCursor）、`session/cancel` 生效（prompt 以 stopReason:cancelled 返回）。

### 其他

- `acp-client.js` 新增 `loadSession()`/`setConfigOption()`/`cancel()`；新增 `user-chunk` 事件转发（agent 侧用户消息重放兜底）。
- `test-acp-client.js` 新增 `loadSession`/`setConfigOption`/`cancel` 对应单测（全部通过）。
- 无破坏性变更。

## [0.11.0] - 2026-07-23

### 新功能

- **ACP 原生审批弹窗**：`session/request_permission` 接入原生模态审批窗（options 的 once/always 语义映射按钮组，详情区展示命令/路径等工具上下文，Esc/关窗即取消；窗口创建失败回退系统对话框；聊天窗失焦时系统通知 + 任务栏闪框）。
- **ACP 工具调用卡片**：`tool_call`/`tool_call_update` 渲染为状态流转卡片（pending→in_progress→completed/failed，折叠详情与输出摘要）。

### 其他

- `acp-client.js` 新增 `setPermissionHandler` 异步权限决策（未设 handler 保持自动取消安全基线）。
- 新增权限窗三件套 `permission.html`/`permission.js`/`permission-preload.js` 与新 IPC 通道 `acp-permission:init`（主→渲染）、`acp-permission:respond`（渲染→主 invoke）。
- `acp-chat:event` 新增 `tool-call`/`tool-call-update`/`permission-pending`/`permission-resolved` 四类 payload，移除 `permission-auto-cancel`。
- `test-acp-client.js` 扩展权限决策回环断言。
- 第二次 ACP 探测产物 `docs/acp-probe2-output.txt` 与 `docs/acp-research.md` 补充。
- 打包清单（build.files）登记 permission 三件套。
- 无破坏性变更。

## [0.10.0] - 2026-07-23

### 新功能

- **ACP 原生聊天只读原型窗（实验）**：菜单「会话→原生聊天原型（ACP 实验）…」打开；主进程经新模块 `acp-client.js` 直连 `kimi acp`，initialize → session/new → 流式 prompt 全链路；会话落在系统临时目录（mkdtemp）实现只读隔离；权限请求一律自动取消（仅状态栏提示）；渲染层流式正文 + 思考折叠区 + 渲染节流；`stopReason` 回传后输入框恢复。
- **全部原生窗口翻新为 kimi.com 官方设计语言**：新增共享样式 `kimi-theme.css`（设计令牌），设置中心/会话启动器/问答窗/模板库/速查窗/局域网/子 Agent 监视/loading 等原生页面统一接入；亮/暗主题跟随系统，各窗口 `backgroundColor` 经 `windowBackground()` 跟随 `nativeTheme`。

### 其他

- 新增 `acp-client.js`（ACP stdio JSON-RPC 客户端：start/newSession/prompt/dispose，update/permission/stderr/exit/raw 事件）与 `chat.html`/`chat.js`/`chat-preload.js` 原型窗前端。
- 新增 IPC 通道：`acp-chat:start`、`acp-chat:prompt`（渲染→主 invoke）；新增主→渲染事件 `acp-chat:event`（status/message-chunk/thought-chunk/commands/permission-auto-cancel/prompt-done）。
- main.js 新增 `showAcpChatWindow()`/`disposeAcpClient()`/`sendAcpEvent()`/`windowBackground()`；5 处窗口背景色统一改走 `windowBackground()`；before-quit 增加 ACP 客户端清理。
- 打包清单（build.files）登记 `kimi-theme.css`、`acp-client.js`、`chat.html`、`chat.js`、`chat-preload.js`。
- 无破坏性变更。

## [0.9.0] - 2026-07-23

### 新功能

- **新手 prompt 模板库**：帮助菜单新增「Prompt 模板库…」，按帮助中心五大场景（实现新功能/修复 bug/理解项目/自动化/通用任务）内置 15 条工程实践示例 prompt，一键复制（clipboard API + execCommand 回退）。
- **命令与快捷键速查**：帮助菜单新增「命令与快捷键速查…」（F1），内置斜杠命令六组分类表 + TUI 快捷键 + 桌面端快捷键清单，内容已核对官方文档。
- **敏感目录启动警告**：会话启动器新建会话时，工作目录为 home 根/盘符根/含 `.ssh`/`.gnupg`/等于 KIMI_CODE_HOME 的，先弹警告对话框（继续/取消）。
- **调试模式开关**：环境页「高级」新增 debugMode，启用后新版 CLI 以 `--log-level debug --debug-endpoints` 启动（覆盖 logLevel，旧版忽略并记日志）；新增 `debug:fetchEndpoints` IPC 抓取 `/api/v1/debug/`。
- **Markdown 导出会话**：会话启动器详情面板新增「导出 Markdown」，只读解析 `agents/main/wire.jsonl`（损坏行跳过、think 部件排除、无 append_message 时回退 turn.prompt），保存对话框写出 .md。
- **子 Agent 任务监视器**：详情面板新增「任务监视」，新窗口按时间线渲染 `agents/*/wire.jsonl` 各 Agent 卡片（消息/事件数、起止时间、事件类型 chips）与 `tasks/` 后台任务，支持手动刷新。
- **局域网/手机访问模式**：会话菜单新增「局域网访问…」窗口——未开启时一键写 `host=0.0.0.0` 并重启；开启后展示各网卡访问 URL（含 token）与二维码（新增 `qrcode` 依赖），顶部醒目安全警示（token 即凭证、严禁叠加 `--dangerous-bypass-auth`）。
- **自定义 marketplace 注入**：环境页新增 pluginMarketplaceUrl → `KIMI_CODE_PLUGIN_MARKETPLACE_URL`。
- **临时模型快速测试**：环境页「临时模型」分组（name/apiKey/providerType/baseUrl/displayName/maxContextSize/capabilities/thinkingEffort），注入 `KIMI_MODEL_*` 进程级环境变量合成临时供应商，不写 config.toml。
- **自建端点支持**：环境页新增 oauthHost/selfHostedBaseUrl → `KIMI_CODE_OAUTH_HOST`/`KIMI_CODE_BASE_URL`。
- **插件管理面板**：设置中心新增第 10 个标签页「插件」，扫描 `plugins/managed/<id>/` 清单（kimi.plugin.json 优先，.kimi-plugin/plugin.json 回退）并合并 installed.json 启用状态（映射/数组/`{plugins}` 三形态自适应）；能定位条目时支持启用/禁用写回（.bak 备份），否则标注用 `/plugins` 命令管理。

### 其他

- 新增 `session-export.js`（readJsonl/extractMessages/renderMarkdown/exportSessionMarkdown/scanSubagents）与 `plugins-manager.js`（listPlugins/setPluginEnabled/normalizeInstalled/readManifest）。
- 新增 IPC 通道：`session:exportMarkdown`、`session:scanSubagents`（sessionDir 限 sessions 根内）、`plugins:list`、`plugins:setEnabled`、`debug:fetchEndpoints`、`system:lanInfo`、`system:lanEnable`、`app:openAgentsMonitor`；preload 新增 8 个桥接方法。
- 新窗口：prompts.html、help.html、agents.html、lan.html（单例工厂 `makeSingletonWindow`，监视器可多开）。
- config.json 新增 `debugMode`/`pluginMarketplaceUrl`/`oauthHost`/`selfHostedBaseUrl`/`tempModel` 字段；app:info 与 setup:save 白名单同步登记。
- `buildKimiEnv` 新增 `KIMI_MODEL_*` 八变量、marketplace、OAuth 主机、Base URL 条件注入。
- 新增 `test-session-export.js`（8 组断言）与 `test-plugins-manager.js`（9 组 48 条断言）；六个测试文件全绿。
- 打包清单（build.files）登记两个新模块与四个新页面；dependencies 新增 `qrcode@^1.5.4`。
- 新增 `scripts/acp-probe.js`（ACP 协议探测，ndjson 分帧首发握手成功）与 `docs/acp-research.md` 调研报告，详见 FEATURE-IDEAS.md §7。
- 无破坏性变更。

## [0.8.0] - 2026-07-22

### 新功能

- **多实例管理面板**：托盘新增「多实例」子菜单；扫描 `~/.kimi-code/server/instances/`（0.28+ 新版格式，防御性解析），目录不存在时回退读取 `server/lock`（0.27 旧版格式）；子菜单显示各实例端口/版本/存活状态/当前连接标记，点击实例先 HTTP probe 校验可达、再重读 server.token，复用令牌轮换的 WS 断连重建序列完成窗口连接切换；列表 10 秒缓存防抖自动刷新，另提供「重新扫描」手动强制刷新；已退出实例置灰展示。
- **旧版 kimi-cli 迁移提示**：启动时检测 `~/.kimi/` 存在且含 `bin/` 或 `config.toml` 时弹出三按钮对话框「立即迁移 / 稍后 / 不再提示」；「立即迁移」打开外部终端窗口运行 `kimi migrate`；「不再提示」写入 config.json `legacyMigrationDismissed` 持久去重，且保存设置时该标志不丢失。
- **IDE 一键接入向导**：设置中心新增第 9 个标签页「IDE 接入」，帮助菜单新增「IDE 接入向导…」入口（showSetup 支持 tab 定位，setup.html 解析 `?tab=ide`）；先探测 `kimi acp` 子命令可用性（不可用时提示升级 CLI）；Zed 卡片支持一键写入 `agent_servers` 配置（JSONC 剥注释/尾逗号后合并，写前 `.bak` 备份，解析失败回退展示片段 + 复制按钮）；JetBrains 卡片检测已装 IDE 并给出手动配置步骤文本（强调必须绝对路径）+ 复制；通用 ACP 片段卡片适配其它客户端。
- **自动更新/遥测开关**：维护标签页新增「自动安装更新」checkbox，读写 tui.toml `[upgrade].auto_install`（保存走 `kimi doctor` 校验 + 失败回滚）；环境页新增「禁止 CLI 自动更新」「禁用遥测」两个强制级开关，写入 config.json 的 `noAutoUpdate`/`disableTelemetry` 并向子进程 env 注入 `KIMI_CODE_NO_AUTO_UPDATE=1`/`KIMI_DISABLE_TELEMETRY=1`（保存后自动重启服务生效）。

### 其他

- 新增 `instances-manager.js`：`scanInstances`/`checkPidAlive`/`probeInstance`；新增 `ide-integration.js`：`detectAcp`/`detectEditors`/`buildZedSnippet`/`applyZedConfig`/`stripJsonc`/`buildGenericSnippet`/`buildJetBrainsGuide`。
- 新增 IPC 通道：`instances:list`、`instances:switch`、`ide:detect`、`ide:applyZed`、`ide:getSnippet`；preload 新增桥接方法：`instancesList`/`instancesSwitch`/`ideDetect`/`ideApplyZed`/`ideGetSnippet`。
- config.json 新增 `noAutoUpdate`/`disableTelemetry`/`legacyMigrationDismissed` 字段；`buildKimiEnv` 新增两个条件注入。
- 新增 `test-instances-manager.js`（6 项断言）与 `test-ide-integration.js`（19 项断言，含 JSONC 字符串内 `//` 不误删边界）；四个测试文件全绿。
- 打包清单（build.files）登记 `instances-manager.js`、`ide-integration.js`。
- 无破坏性变更。

## [0.7.0] - 2026-07-22

### 新功能

- **会话归档/删除管理器**：会话启动器详情面板新增「归档」「删除」按钮；启动时解析 `/openapi.json` paths 自动探测服务端能力（`:archive` 自定义动词 / `/archive` 子路径 / `DELETE` 三种形态自适应），不支持的端点按钮禁用；删除前先归档降低误删损失；订阅 WS `event.session.deleted` 自动刷新列表。
- **认证错误识别与 FAQ 引导**：CLI 输出与 WebSocket 关闭/错误中识别 401/认证失败关键字（每次启动只弹一次），弹出排查卡片（api.kimi.com 与 api.moonshot.cn 密钥不通用、设备授权 30 天过期、模型 ID 静默回退等），可一键跳转重新登录。
- **Skills 管理面板**：设置中心新增 Skills 标签页，扫描用户级 `~/.kimi-code/skills/` 与 `extra_skill_dirs`（只读标注来源），解析 SKILL.md frontmatter，支持新建/编辑/重命名/删除用户级技能。
- **Hooks 可视化编辑器**：设置中心新增 Hooks 标签页，按官方文档内置 16 个事件清单与用途提示，编辑 `[[hooks]]`（event/matcher/command/timeout），提供拦截 rm -rf、任务完成通知、附加 Git 分支、Bash 审计日志 4 个模板，保存走 doctor 校验回滚。
- **模型切换下拉**：托盘菜单与「会话」菜单新增「默认模型」单选子菜单，模型列表取自 `GET /api/v1/models`（失败回退双档模型 + 当前配置），切换写入 config.toml 并可选择立即重启生效；订阅 `event.model_catalog.changed` 自动刷新。
- **新会话权限模式选择**：会话启动器新建按钮旁新增权限模式下拉与 Plan 复选（默认「保持当前配置」），选择后先写 config.toml 再创建会话。
- **维护面板**：设置中心新增维护标签页——CLI 检查更新（读 `updates/latest.json` 比对版本）与一键升级（重跑官方 install.ps1，成功后自动重启）；数据目录体积统计与勾选清理（sessions/logs/bin/updates/server，凭据受保护）；诊断打包（app.log + doctor 输出 + 最近会话导出，PowerShell Compress-Archive 生成 ZIP）。
- **高级启动参数**：环境页新增固定端口 `--port`、监听地址 `--host`、日志级别 `--log-level`、自定义 `KIMI_CODE_HOME` 四项设置（仅新版 CLI 生效，旧版自动忽略并记日志）；KIMI_CODE_HOME 在应用启动最早期注入，全进程统一生效。
- **令牌轮换**：「会话」菜单新增「轮换访问令牌…」，调用 `kimi web rotate-token` 后重读 server.token、重载窗口并重建 WS 订阅。

### 改进

- `session:createSessionInDirectory` 支持可选权限模式参数，写入失败时中止创建并提示。
- `skills-manager.deleteSkill` 对不存在的用户级目录显式报错，防止误删 extra 只读技能。
- mock 服务器扩展：`:archive`/`DELETE`/`/api/v1/models` 端点与 `session.deleted` 事件推送（`/control/emit` scenario 与 `/mock/push/session-deleted` 双触发），openapi.json paths 同步补齐。

### 其他

- 新增 `skills-manager.js`：frontmatter 简易解析、目录扫描、用户级技能读写删（路径包含校验防越权）。
- 新增 IPC 通道：`session:archiveSession`、`session:deleteSession`、`session:getCaps`、`skills:list`、`skills:save`、`skills:delete`、`cli:checkUpdate`、`cli:upgrade`、`system:dataDirStats`、`system:cleanupDataDirs`、`system:packDiagnostics`；新增主→渲染事件 `session:changed`。
- 新增 `httpRequest()` 通用 REST 辅助与 `buildSessionActionUrl()` 路径模板替换（`{param}` → 会话 ID）。
- config.json 新增 `port`/`host`/`logLevel`/`kimiCodeHome` 字段，`setup:save` 完整持久化（端口范围校验）。
- 新增 `test-skills-manager.js` 单元测试（8 项断言全过）；能力探测逻辑已对 mock 实弹验证通过。
- 打包清单补齐 `skills-manager.js`。
- 无破坏性变更。

## [0.6.0] - 2026-07-22

### 新功能

- **图形化设置中心**：设置页（setup.html）新增标签页导航，集成 config.toml / 权限规则 / 供应商管理 / MCP 服务器四大配置面板。
- **config.toml GUI 化**：支持编辑 `default_model`、`default_permission_mode`（manual/yolo/auto）、`default_plan_mode`、`telemetry` 开关，以及 `[thinking]` / `[loop_control]` 参数；保存前自动调用 `kimi doctor` 校验，失败时回滚原文件。
- **权限规则编辑器**：可视化增删改 `[[permission.rules]]`，支持 decision（allow/deny/ask）、pattern、scope，提供"拒绝 rm -rf"与"敏感文件 ask"安全预设。
- **供应商与模型管理器**：调用 `kimi provider list --json` 展示供应商列表，支持删除供应商与通过向导添加 catalog 供应商（覆盖 6 种 provider 类型）。
- **MCP 服务器配置 GUI**：读写用户级 `~/.kimi-code/mcp.json`，支持 stdio/http/sse 三种接入方式、命令/URL、环境变量与启停工具列表。

### 改进

- 新增 `config-manager.js` 配置管理模块：统一读写 `config.toml`、`tui.toml`、`mcp.json`，写入前备份、doctor 校验、失败回滚。
- `package.json` 打包清单补齐 `config-manager.js`，并新增 `@iarna/toml` 依赖。
- 新增 IPC 通道：`config:loadConfigToml`、`config:saveConfigToml`、`config:loadTuiToml`、`config:saveTuiToml`、`config:loadMcpJson`、`config:saveMcpJson`、`config:listProviders`、`config:removeProvider`、`config:addProviderCatalog`。

### 其他

- TOML 解析使用 `@iarna/toml`，支持完整的 parse/stringify。
- `runDoctor` 在 Windows 上对非 `.exe` CLI 路径自动启用 `shell: true`，提高兼容性。
- 新增 `test-config-manager.js` 单元测试，覆盖空配置加载、TOML 解析、保存备份、失败回滚、MCP JSON 读写。
- 无破坏性变更。

## [0.5.0] - 2026-07-22

### 新功能

- **原生问答窗口全类型接管**：`event.question.requested` 统一由原生问答窗口（question.html）处理，支持单选、多选、多题与自定义输入（allow_other）；主进程接线 `question:submit`/`question:fallback`/`question:cancel` IPC 提交答案，原 `dialog` 弹窗仅作窗口创建失败时的回退。
- **托盘用量/任务进度显示**：订阅 WS `event.session.usage_updated` 与 `event.task.started/progress/completed` 事件，托盘 tooltip 与菜单状态项实时展示 token 用量、上下文占用与任务进度，更新带防抖。
- **编辑器协议接管**：外部链接白名单新增 `vscode`、`cursor`、`windsurf`、`zed` 等编辑器协议，走系统默认程序打开，Web UI 的 Open in Editor 类按钮可用。
- **mock 验证基建**：新增 `scripts/mock-kimi-server.js`（默认端口 58999，固定 token `mock-token`），自动覆盖 client_hello/订阅/问答/审批/用量/任务事件验证，`npm run mock` 一键启动。
- **测试钩子**：支持 `KIMI_DESKTOP_TEST_BASE`、`KIMI_DESKTOP_TEST_TOKEN` 环境变量覆盖服务地址与 token，便于对接 mock 服务做自动化测试。

### 改进

- 打包清单补齐 `question.html`、`question.js`、`question-preload.js`，修复打包后问答窗口文件缺失问题。

### 其他

- 新增 IPC 通道：`question:submit`、`question:fallback`、`question:cancel`（渲染→主 invoke）；新增主→渲染事件：`question:init`、`question:dismiss`。
- 答案提交：`POST /api/v1/sessions/{sid}/questions/{qid}`，三种形态 `{kind:'single', option_id}` / `{kind:'multi', option_ids, other_text?}` / `{kind:'other', text}`；HTTP 2xx 且响应 `code` 为 0 或缺失判定成功。
- 用量字段容错解析（`total_tokens|totalTokens`、`input_tokens`、`output_tokens`、`context_used`、`context_limit`），托盘菜单新增禁用态状态项展示。
- 无破坏性变更。

## [0.4.0] - 2026-07-22

### 新功能

- **Git Bash 检测与选择**：自动探测系统已安装的 Git Bash（`Program Files\Git\bin\bash.exe`、`Local\Programs\Git\bin\bash.exe` 等常见路径），支持设置页手动浏览选择 bash.exe，通过 `KIMI_SHELL_PATH` 环境变量注入 CLI 子进程，解决非标准路径 Git 不可用问题。
- **设备码登录/登出**：设置页集成 `kimi login` 设备码流程，spawn 子进程捕获 stderr/stdout 输出，自动提取授权 URL 并打开浏览器，实时显示登录日志；支持一键登出（删除 `~/.kimi-code/credentials/` 目录），凭据状态在环境状态面板实时展示。
- **kimi doctor 诊断**：菜单栏"帮助→运行 kimi doctor"及设置页"环境诊断"按钮，spawn `kimi doctor` 子进程（20 秒超时保护），结果弹窗/内联展示诊断输出。
- **代理设置**：设置页新增 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 四项代理配置表单，保存后通过 `buildKimiEnv()` 注入自动启动的 CLI 子进程环境变量，支持 SOCKS5 等协议。
- **首次运行欢迎引导**：启动时检测配置文件是否存在，首次运行（无 `config.json`）自动进入设置页并显示 `first-run` 原因，引导用户完成初始配置。
- **关于面板增强**：关于对话框新增 CLI 版本号显示，通过 `getCliVersion()` 实时获取。

### 改进

- 设置页 UI 重构：新增环境状态面板（CLI 版本、Git Bash 路径、登录状态三栏指示灯），代理设置网格布局，响应式适配窄屏。
- 设置页从会话启动器进入后重置 `sessionLauncherVisible` 标记，确保 `startPolling` 能正常加载页面。
- 日志模块重构：提取 `sanitizeLog()` 为独立函数，`logLine()` 返回脱敏后的字符串，供登录日志等场景复用。
- 配置模型扩展：`loadConfig()` 默认值新增 `shellPath`、`httpProxy`、`httpsProxy`、`allProxy`、`noProxy` 字段。
- 设置页 JavaScript 重构：引入 `$()` 简写、`collectPayload()` 统一收集表单数据、`validateProxies()` 代理格式校验、`renderStatus()` 统一渲染环境状态。

### 其他

- 新增 `detectGitBash()`：扫描 4 个常见 Git 安装路径，优先使用配置或 `KIMI_SHELL_PATH` 环境变量。
- 新增 `buildKimiEnv()`：合并代理环境变量和 `KIMI_SHELL_PATH`，用于 CLI 子进程 spawn。
- 新增 `getLoginStatus()`：扫描 `~/.kimi-code/credentials/` 目录文件数，返回 `{ authenticated, credentialCount }`。
- 新增 `runKimiDoctor()`：spawn `kimi doctor`，64 KiB 输出截断，20 秒超时保护。
- 新增 IPC 通道：`auth:login`、`auth:logout`、`auth:loginLog`、`auth:loginComplete`、`cli:doctor`、`dialog:pickShell`。
- preload.js 新增 6 个 API 桥接方法：`pickShell`、`runDoctor`、`startLogin`、`logout`、`onLoginLog`、`onLoginComplete`。
- setup.html 新增约 250 行 CSS/JS/HTML，含环境状态面板、设备码登录 UI、kimi doctor 诊断面板、代理设置网格、响应式适配。
- 无破坏性变更。

## [0.3.0] - 2026-07-22

### 新功能

- **会话启动器**：新增 `sessions.html` 原生会话管理界面，通过 `Ctrl+Shift+S` 或托盘/菜单入口打开。
- **会话历史浏览**：读取 `~/.kimi-code/session_index.jsonl` 索引文件，按更新时间降序排列，支持搜索标题/工作目录/最近提示。
- **恢复指定会话**：选中会话后以 `kimi --session <id>` 参数重启 Web 服务，直接进入该会话继续对话。
- **ZIP 导出**：选中会话后调用 `kimi export <sessionId> -o <path> -y`，通过 Electron 保存对话框选择导出路径，60 秒超时保护。
- **可视化窗口**：选中会话后 spawn `kimi vis <sessionId> --no-open`，捕获可视化地址并在独立 Electron 窗口中打开。
- **指定目录新建会话**：通过深链 `?action=create-in-dir&workDir=<path>` 导航至 Web UI 创建新会话。
- **托盘菜单入口**：托盘右键菜单新增"打开会话启动器"项。
- **菜单栏入口**：菜单栏"会话"子菜单新增"打开会话启动器"项，快捷键 `Ctrl+Shift+S`。

### 改进

- 启动流程增加 `sessionLauncherVisible` 状态标记，会话启动器可见时跳过自动加载，避免覆盖用户操作。
- 新增 `pendingSessionId` 机制，支持在重启流程中传递待恢复会话 ID。
- 会话列表支持键盘导航（方向键/Home/End）和搜索过滤。
- 会话详情面板展示工作目录、更新时间、最近提示，支持一键恢复/导出/可视化。

### 其他

- 新增 `showSessionLauncher()`、`getAllSessions()`、`readSessionIndex()`、`enrichSessionFromState()` 等函数。
- 新增 IPC 通道：`session:getSessions`、`session:refreshSessions`、`session:resumeSession`、`session:exportSession`、`session:visualiseSession`、`session:createSessionInDirectory`、`session:openLauncher`。
- 新增 `sessions.html`（784 行）完整会话管理前端，含深色主题 UI、搜索、键盘导航、加载状态与错误处理。
- preload.js 新增 7 个会话相关 API 桥接方法。
- 新增 `SESSION_TIMEOUT` 常量（30 秒）用于可视化 URL 等待超时。
- 无破坏性变更。

## [0.2.0] - 2026-07-21

### 新功能

- **CLI 版本自动适配**：启动前运行 `kimi --version` 探测版本号，v0.28+ 自动使用新版参数（不含 `--foreground`），旧版保持向后兼容，消除 CLI 升级导致的启动失败风险。
- **双通道地址捕获**：优先读取 `~/.kimi-code/server.token` 文件拼合 `http://127.0.0.1:端口/#token=token` 地址；stdout 正则解析作为兜底，兼容旧版 CLI 输出格式差异。
- **HTTP 就绪探测**：捕获端口后轮询 `GET /openapi.json` 直到 HTTP 200 再加载页面，消除时序竞争导致的白屏问题。
- **优雅退出机制**：先 `POST /api/v1/shutdown` 发送关闭请求并等待 5 秒，超时后强杀回退（`taskkill /T /F`），避免会话数据写损。
- **重启互斥锁**：连续触发重启时自动合并为单次执行，防止重复启停导致进程混乱。
- **日志脱敏**：所有日志自动过滤 token、Authorization 头、完整带 fragment URL，防止敏感信息泄漏。
- **多实例感知**：启动时检测 `~/.kimi-code/server/instances/` 目录，感知 CLI 多实例注册。

### 改进

- 进程状态管理升级：迁移至 `serverGeneration` 世代计数器，旧进程回调自动失效，消除竞态条件。
- `before-quit` 生命周期改为异步等待优雅关闭完成后再退出，防止进程残留。
- 代码体积增加约 60%，新增 275 行核心逻辑，无破坏性变更。

### 其他

- 新增 `getCliVersion()`、`readServerToken()`、`checkMultiInstances()`、`httpGet()`、`httpPostShutdown()`、`waitForProcessExit()`、`forceKill()`、`stopKimi()`、`startPolling()`、`restartServer()` 等函数。
- 新增 `cliVersionCache`、`stoppingIntentionally`、`beforeQuitInProgress`、`knownServerBase`、`knownServerToken`、`serverGeneration`、`restartPromise` 等状态变量。
- 引入 `http` 模块用于 HTTP 请求，`execFileSync` 用于 CLI 版本探测。
- 日志模块新增多层正则替换脱敏逻辑。

[0.1.0] - 初始版本

- 基础 Electron 套壳，spawn `kimi web --no-open --foreground` 并捕获 stdout 地址。
- 系统托盘常驻、窗口状态持久化、设置页（手动/自动/在线安装）。
- 快捷键、菜单栏、外部链接拦截。