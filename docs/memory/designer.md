# Designer 记忆

## 项目视觉系统（kimi-code-desktop）

- 唯一事实来源：`src/styles/kimi-theme.css`，官方 kimi.com 黑白灰单色体系；全应用仅有的两个点缀色是 `--color-error` / `--color-success`，禁止引入品牌彩色与任何硬编码颜色（页面内一律 `var(--*)`）。
- 暗色双命中：`prefers-color-scheme` 媒体查询 + `<html>` 的 `kcd-page-dark` 类，改暗色令牌需两处同步。
- 离线 Electron：禁止外部字体/远程资源，字体全部系统栈（`--font-family` / `--font-mono`）；页面 CSP 为 `default-src 'self'; style-src/script-src 'self' 'unsafe-inline'`。
- 共享组件勿在页面内重定义：`.app-topbar`、`.side-nav/.side-item/.side-group`、`.btn/.btn-primary/.btn-secondary/.btn-danger`、`.input`、`.card`、`.hint`（含 .warn/.err/.ok）、`.spinner`、`.badge`。
- 圆角令牌：`--radius-card 20px`（卡片）、`--radius-pill 22px`（按钮/开关）、`--radius-sm 8px`（日志/小徽标）。

## setup.html 页面约定

- 布局：`48px .app-topbar` + 左侧 232px `.sidebar` + 右侧 `.content-inner`（max-width 760px）。
- 状态列表用 `.status`（卡片骨架）+ `.srow`（dot 7px + `.sname` 56px + 右对齐等宽 `.sval`，行间 border-top 分隔）。
- 操作反馈成对 `.ok`/`.err`（12px、居中、min-height 占位），统一经 `setFeedback(okEl, errEl, type, text)` 写入。
- 所有 IPC 调用前先判 `typeof window.kimiDesktop.x === 'function'`；失败文案格式「操作失败：原因」。
- 字号全部 px 固定（11/12/13/14/18），不用视口单位；窄窗口靠 flex-wrap 与 `minmax(0,1fr)` 防溢出，380px 有媒体查询。

## 重要决策

- 维护页 CLI 升级区（2026-08）：版本信息用 `.status` 结构化卡片（当前/最新版本行 + `.ver-state` 语义色结论行 + `.ver-cache` 缓存注），`role="status"` + `aria-live="polite"`；按钮组 `.upgrade-actions` 自然宽度成组；五态状态机 checking/update-available/up-to-date/current-unknown/unknown。后端契约：成功 `{ok,current,latest,publishedAt?,updateAvailable}`，失败 `{ok:false,error,current,cachedLatest?,cachedCheckedAt?}`（缓存仅供参考，禁止冒充 latest）。
- 升级区防残留约定（2026-08）：`checkUpgrade` 开始即 `setFeedback(upgradeOk, upgradeErr, '', '')` 清旧反馈；失败分支 `verCurrent = r.current || '未检测到'`；catch 分支 `verLatest = '—'` 并清缓存注/隐藏升级按钮。升级成功分支顺序（2026-08 修正）：先 `await checkUpgrade(false)` 再写「升级完成，服务正在重启…」，否则会被 checkUpgrade 开场的清空抹掉；`refreshStatus()` 不 await、保留在 await 之前。
- 自检方法：从 HTML 抽 `<script>` 用 `node --check` 验语法；再抽目标函数 + 桩 DOM 在 node 跑契约场景断言（临时文件用 `.cjs` 后缀，Temp 目录 package.json 是 `"type":"module"`）。

## chat.html 页面约定

- 本地命令结果面板（2026-08，Phase 3b）：`.cmd-panel` 位于 `.composer` 正上方（error-bar 与 composer 之间），材质 = composer 同款 `--bg-secondary` + `--radius-card` + `--shadow-card`；标题栏 `cmd-panel-head`（mono 命令名 + 11px 生成时间 + 20px 关闭钮）+ `cmd-panel-body`（max-height 300px 内滚动）。状态机：loading（共享 .spinner）/result/error（.cmd-warn + .cmd-retry）；请求序号 `cmdPanelSeq` 递增丢弃旧结果，关闭面板也递增。
- Escape 优先级模式：input keydown 内 slash 菜单已 preventDefault；面板用 document 级 keydown + `e.defaultPrevented` 检查兜底，两处不冲突。同类"多层浮层 Escape"需求照此办理。
- 数字格式：`fmtTokens`（≥1e6→X.XM，≥1000→X.Xk，同托盘 formatTokenCount 风）+ `fmtFull`（toLocaleString 千位逗号，悬浮 title 用）；金额分→元 `(n/100).toFixed(2)`，CNY→¥、USD→$。
- `/usage`、`/status` 数据契约**以主进程实际产出为准**（usage-stats.js）：`summary:{requests,inputOther,output,inputCacheRead,inputCacheCreation,totalTokens,partial?}`，`series:[{key:'HH'|'YYYY-MM-DD',...}]`，`byModel` 为**数组** `[{model,...}]`；orchestrator 任务书曾误述为 inputTokens/byModel 对象映射。managed：`{kind,plans:[{id,label,used,limit,resetAt:ISO}],wallet:{currency,balanceMinor,monthlyUsedMinor,monthlyLimitMinor},fetchedAt,staleAt,message?}`，stale 判定 `staleAt < Date.now()`。
- Tasks 抽屉（2026-08，Phase 5b）：`#tasksDrawer` fixed 右侧卡片浮层（top 56/right 10/bottom 40，宽 320，z-index 20 高于 slash-menu），与 cmd-panel（文档流内联）位置错开；材质同 cmd-panel。入口 = 顶栏「任务」icon-btn（toggle + .tasks-open 态 + aria-expanded）+ 状态条双徽章 button 化（.badge-link role=button tabindex=0）。数据：`getTaskCatalog(currentSessionId)` 打开时拉一次 + onRuntimeChanged 1s 防抖重拉（仅打开期间，守卫 tasksDrawerOpen），序号 tasksSeq 丢弃在途结果，closeTasksDrawer 幂等清理（会话切换必调）。分组互斥：cron 非 removed → Cron 调度；其余 running → 运行中；completed/failed/removed → 已结束；组内 updatedAt 倒序。标注映射：source ws/acp/disk → 实时同步/会话事件/本地文件；confidence high 不显示、medium 参考、low 粗略；failed/removed 行 .dim 降不透明度，failed 状态字 .is-failed（error 色）。Escape 优先级：slash 菜单 > 抽屉 > cmd-panel。
- 子代理步骤树（2026-08，Phase 6b）：Agent 工具卡片 head 行尾「步骤」描边胶囊钮（.agent-steps-toggle，判定 title==='Agent' 或含 agent）+ 卡片内 .agent-tree 嵌块（bg-primary 拉开一层、max-height 320 内滚，纯文档流无定位）。展开按 toolCallId 匹配 parentToolCallId 渲染子树，未命中回退会话全树（main 根→顶层游离→「未知关系」组带计数）并标注「按会话扫描结果展示」。折叠：agentFoldMemory（agentId→bool）跨重拉保留、会话切换清；默认 running 展开其余收起，收起预览 = 自尾向前最近非空 step 文本截断 72。状态点复用 .dot 色系映射（running→busy 脉冲/completed→ready/failed→error/interrupted、unknown→exited）。steps.kind 枚举 step=推理/tool=工具，未知原样兜底；tool 行 toolCallId 尾 6 位 + output details 折叠。数据：getSubagentTree 首次展开拉取 + agentTreeCache 共享 + agentTreeInflight 并发合并；runtime-changed 1s 防抖重拉（守卫 hasOpenAgentTrees），agentTreeSeq 会话切换作废在途。失败形状 {ok:false,message}。子层级用 1px separator 缩进线。自检：桩 DOM vm 跑整 chat.js 事件驱动断言（Temp/opencode/phase6b-agent-tree-selfcheck.cjs 模式，53 断言）。

## 经验教训

- 工作区常有其他 agent 的并行改动（如 main.js、cli-update.js），`git status` 看到的脏文件不一定是自己的；只提交/只改自己负责的文件。
- ☰ 菜单分级约定（2026-08 精简后）：面板 `buildMenuDefinition()` 与原生 `buildMenu()` 顶层结构对齐；低频项收二级用 `submenu` 字段（menu-panel.js 自动渲染 › 与子面板，无需改渲染层）；二级分组现有三个：「缩放与全屏」「排查问题」「开发者」；`menu:run` 白名单只放叶子动作 id，二级父项 id 不加分发。

## usage.html / usage.js 页面约定（2026-08）

- 用量统计面板：骨架沿用 agents.html（drag-strip + app-topbar + `menu-panel.js` defer + 共享 loading/notice/spinner）。页面级 `[hidden]{display:none !important}` 防护必加——共享/页面类一旦带 display（.fail/.wrap/grid）会压过 UA 的 `[hidden]` 规则。
- 数据形状以主进程代码为准（managed-usage.js / usage-stats.js），任务书字段名可能过时：managed.plans 是 `{id,label,used,limit,resetAt}`（used/limit 平台十进制数，**非分**）；wallet 金额（balanceMinor 等）是分；trends[range] 的 byModel 是数组；errors 元素字段兼容 `source||part`。
- 仪表盘决策：hero 34px mono 大数字（字号纪律的破例点，仅限视觉锚点）；tabs 联动趋势图+分模型明细；byModel 展示层按 totalTokens 降序；partial 桶用斜纹柱（repeating-linear-gradient + var(--label-primary)，不引入新颜色）；plan 标签展示层中文化（Weekly limit→每周额度、5h limit→5 小时额度）。
- 刷新纪律：入场动画只挂容器、只首次播放；刷新只重建卡片内容；静默刷新失败保留旧数据 + 警示条（文案「这次刷新没成功…」）；60s 自动刷新 + visibilitychange 暂停/回前台立即刷；loadSeq 递增防竞态；auth-required 空态集中在 hero 卡 + plans 卡整卡隐藏（grid-top 加 .single），「去登录」调 `api.showSetup()`。
- 自检：桩 DOM 跑 IIFE 断言（Temp/opencode/*.cjs 模式），43 断言全过；`node --check` 验语法。
- 自绘窗控（2026-08，已上提全应用）：min/max/close 三键由 **menu-panel.js 统一注入**（挂 ☰ 后紧挂 `.kcd-win-controls`，本地页落 actions 末尾 ☰ 右侧；无 actions 页 fixed `top:0;right:0`，此时 ☰ fixed 定位 `right:118px`）。桥为 `kimiDesktopMenu.windowControl(action)`（不是 kimiDesktop），缺失/异常/reject 全静默。**禁用同名 `.kcd-menu-btn`**——mount 判定（`querySelector('.kcd-menu-btn')`）与 preload 采样过滤都靠它；新类 `.kcd-win-btn` 逐字复刻样式（38×32、透明、radius:0、hover #00000012 / 暗色 #ffffff1a 两条命中，色值带 var(--token,兜底) 供无令牌 Web UI 页）。applyTitlebarStyle 广播四键同吃（symbolColor/height，☰+三窗控）；自愈 ensureMounted 任一缺失即整组重挂（先 remove 残留再走 mount，否则 querySelector 判定命中残留 ☰ 直接返回）。kimi-theme.css `.app-topbar` padding 已收为 `0 14px`（OS overlay 让位 150px 成为历史）；`#kcd-drag-strip` 本左右贯通无让位。usage 页单页窗控实现已全量回退，页面不再自带窗控代码。
