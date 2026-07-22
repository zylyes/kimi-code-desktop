# Changelog

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

### 技术细节

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

### 技术细节

- 新增 `getCliVersion()`、`readServerToken()`、`checkMultiInstances()`、`httpGet()`、`httpPostShutdown()`、`waitForProcessExit()`、`forceKill()`、`stopKimi()`、`startPolling()`、`restartServer()` 等函数。
- 新增 `cliVersionCache`、`stoppingIntentionally`、`beforeQuitInProgress`、`knownServerBase`、`knownServerToken`、`serverGeneration`、`restartPromise` 等状态变量。
- 引入 `http` 模块用于 HTTP 请求，`execFileSync` 用于 CLI 版本探测。
- 日志模块新增多层正则替换脱敏逻辑。

[0.1.0] - 初始版本

- 基础 Electron 套壳，spawn `kimi web --no-open --foreground` 并捕获 stdout 地址。
- 系统托盘常驻、窗口状态持久化、设置页（手动/自动/在线安装）。
- 快捷键、菜单栏、外部链接拦截。