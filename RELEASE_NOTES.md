### 改进

- **全窗口无边框化（品牌一致性）**：原生标题栏与 Web UI 品牌区/会话头部内容重复，全部窗口（主窗口、设置、会话启动器、问答、Prompt 模板库、快捷键速查、局域网访问、子 Agent 监视、ACP 原生聊天、ACP 审批、会话可视化）统一改为 `titleBarStyle: 'hidden'` + `titleBarOverlay` 右上角悬浮窗控（min/max/close），经 `framelessOpts()/applyFrameless()` 助手接入；悬浮窗控配色跟随亮/暗主题（`nativeTheme.updated` 联动 `setTitleBarOverlay`，覆盖全部已开窗口）。
- **窗口拖拽**：顶部 10px 拖拽条统一为 `#kcd-drag-strip` 共享样式（kimi-theme.css），各本地页内嵌元素、Web UI 与 kimi vis 外部页由 preload + insertCSS 注入；`.topbar` 顶栏整行作拖拽区（交互控件 `no-drag` 除外），Web UI 会话头部 `header.chat-header` 右内边距 154px 避开悬浮窗控，双击拖拽区切换最大化。
- **页面内菜单按钮**：无边框后无原生菜单栏（同时 `setMenuBarVisibility(false)` 屏蔽 Alt 唤出），主窗口右下角设置按钮上方注入 `☰` 浮动按钮，点击经 `app:popupMenu` IPC 弹出完整应用菜单（菜单加速键不受影响）。

### 其他

- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
