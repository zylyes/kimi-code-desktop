### 修复

- **CLI 更新检查误报**：`compareSemver(current, latest) !== 0` 修复为 `< 0`，之前本地版本高于远程时也会提示"有更新"。
- **通知点击崩溃**：通知点击回调改用 `showMainWindow()`（窗口已销毁时自动重建并拉起服务），修复 `mainWindow` 为 null 时的崩溃。

### 改进

- **屏蔽网页 HTML5 通知**：新增 `blockWebPageNotifications()`，在 `session.defaultSession` 与 `persist:kimi-code` 上拒绝 `notifications` 权限，桌面端统一由主进程原生通知展示，避免同一事件双重弹出。

### 其他

- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
