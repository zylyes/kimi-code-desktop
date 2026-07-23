### 新功能

- **应用设置面板**：设置页新增「应用设置」面板，支持主题模式（跟随系统/浅色/深色）、界面缩放（80%~150%）、关闭/最小化到托盘开关、窗口置顶、开机自动启动、桌面通知、全局快捷键共 8 项；全部即时生效，不重启 server。
- **设置页侧栏导航**：设置页 UI 从标签页横幅重构为左侧分组导航 + 右侧内容布局，分组为「应用」「环境」「配置」「集成」，支持 url `?tab=` 定位。
- **Web UI 浮动设置按钮**：kimi web 会话页右下角注入齿轮设置按钮（不依赖页面 CSP，主进程 insertCSS + preload DOM 注入双通道），点击直接打开设置页。
- **会话启动器设置入口**：新建按钮旁新增齿轮设置按钮（`⚙`），直达设置。

### 其他

- `config.json` 新增 `theme`/`zoomFactor`/`closeToTray`/`minimizeToTray`/`alwaysOnTop`/`launchAtLogin`/`notificationsEnabled`/`globalHotkeyEnabled` 共 8 键
- 新增 IPC 通道 `app:saveAppSettings`（白名单即时生效）、`app:backToSession`（返回会话页）；preload 新增 `saveAppSettings` / `backToSession` 桥接
- 设置页新增「返回会话」按钮（仅手动打开时展示）
- 窗口关闭/最小化到托盘、桌面通知、全局热键可通过应用设置关闭；关闭后走系统默认行为
- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
