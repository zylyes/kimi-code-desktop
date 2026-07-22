# Changelog

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

### 技术细节

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