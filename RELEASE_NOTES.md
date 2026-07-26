### 修复

- **模态蒙版下窗控符号色修正**：`titlebarColorForWindow` 亮度阈值 0.6 → 0.4（亮页/蒙版灰用黑符号、暗页用白符号），修复设置模态压暗时 −▢× 变白的问题；新增符号色广播（`kcd:titlebar-style` IPC + preload `onTitlebarStyle` 桥），☰ 按钮内联色与原生三键永远一致。
- **右侧面板头部避让右上窗控**：`aside.global-preview .ui-panel-header` 注入 `padding-right:228px`，修复改动面板「列表/树形」切换、预览面板「适应/原始」切换与关闭按钮被 −▢× 悬浮窗控遮挡、文件大小被 ☰ 遮挡的问题。

### 改进

- **窗控条高度跟随会话头部**：preload 实测 `header.chat-header` 的 `offsetHeight`（钳制 32~64）上报，主窗口 `titleBarOverlay` 高度与 ☰ 按钮高度随动，四键与会话头部图标垂直同线；颜色采样点移至窗控条垂直中心。
- **蒙版切换变色提速**：preload MutationObserver 节流 300ms → 50ms + ~250ms 尾随信号踩蒙版淡入/淡出结束帧，main 防抖 250ms → 50ms，窗控变色端到端延迟显著降低。

### 其他

- 新增 `scripts/probe-panels.js`（页面元素探针 dump）
- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
