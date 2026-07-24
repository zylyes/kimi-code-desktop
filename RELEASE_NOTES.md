### 改进

- **WebContentsView 覆盖层架构**：sessions/setup/loading 由全页加载重构为 `WebContentsView` 覆盖层，打开时盖在常驻 Web UI 之上，切回时直接移除覆盖层（零重载、不丢 WS 连接）；覆盖层随窗口 resize 同步 bounds，窗口关闭时显式清理防泄漏；`foregroundContents()` 统一路由 IPC 定向消息（登录日志/安装日志/通知）到前台页面。
- **菜单扁平化**：去除「会话」子菜单层级，常用操作（会话启动器/新建对话/设置/轮换令牌/局域网/原生聊天）平铺顶层；仅「视图」「帮助」保留为子菜单；「重新加载」提到顶层。
- **聊天头部背景对齐**：`header.chat-header` 强制设为窗口背景色（亮 `#fbfaf9` / 暗 `#121212`），与右上角悬浮窗控融为一体，消除接缝；同时移除头部底部分隔阴影。
- **WS 连接幂等**：`startWsSubscription` 检测同 base/token 已连接时直接复用，避免覆盖层切回时重复建连。
- **菜单按钮锚定**：`app:popupMenu` 接收按钮 rect 坐标（经 zoomFactor 换算），菜单精确锚定到按钮位置弹出。

### 其他

- `windowOpenHandler` 提取为独立函数（主窗口与覆盖层共用）
- `.statusbar` 整行加入拖拽区（与 `.topbar` 一致），内部按钮/下拉保持可点击
- 覆盖层存在时 `session:changed` 通知发往覆盖层而非主窗口
- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
