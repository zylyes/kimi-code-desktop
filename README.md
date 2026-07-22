# Kimi Code Desktop

Kimi Code 网页版（`kimi web`）的桌面套壳应用。基于 Electron，打开后自动启动 `kimi web` 本地服务，捕获带 token 的会话地址并在桌面窗口中打开，无需再手动复制链接到浏览器。

## 直接使用（已打包）

从 [Releases](https://github.com/zylyes/kimi-code-desktop/releases) 下载最新 `KimiCodeDesktop-Portable.exe` 即可运行（绿色便携版，无需安装）。

## 工作方式

1. 启动后自动探测 Kimi Code CLI（默认 `%USERPROFILE%\.kimi-code\bin\kimi.exe`），运行 `kimi web --no-open`。
2. **CLI 版本自动适配**：自动检测 CLI 版本号——v0.28+ 使用新版参数（不含 `--foreground`），旧版自动添加 `--foreground` 确保前台运行。
3. **双通道地址捕获**：优先读取 `~/.kimi-code/server.token` 文件拼合 `http://127.0.0.1:端口/#token=token` 地址；stdout 正则解析作为兜底，兼容旧版 CLI。
4. **就绪探测（HTTP 轮询）**：捕获端口后轮询 `GET /openapi.json` 直到 HTTP 200 再加载页面，消除时序竞争导致的白屏。
5. **优雅退出**：先 `POST /api/v1/shutdown` 发送关闭请求并等待 5 秒，超时后强杀回退，避免会话数据写损。
6. **重启互斥**：连续触发重启时自动合并为单次执行，防止重复启停。
7. **日志脱敏**：所有日志自动过滤 token、Authorization 头、完整带 fragment URL，防止敏感信息泄漏。
8. 若自动启动失败（未找到 CLI / 超时 / 服务中途停止等），会进入设置页：
   - **浏览…**：手动选择已有的 `kimi.exe`；
   - **在线安装**：选择安装文件夹（默认 `%USERPROFILE%\.kimi-code`），一键运行官方安装脚本，完成后自动连接；
   - 或切换到"手动填写"，粘贴已在终端启动的会话地址。
9. 登录状态、窗口大小位置持久保存。
10. **会话启动器**（v0.3.0）：通过 `Ctrl+Shift+S` 或托盘菜单打开会话管理界面，支持浏览历史会话、恢复指定会话、ZIP 导出、可视化窗口、指定目录新建会话。
11. **Git Bash 检测与选择**（v0.4.0）：自动检测系统已安装的 Git Bash，支持设置页手动指定路径，通过 `KIMI_SHELL_PATH` 环境变量注入 CLI 子进程，确保非标准路径 Git 可用。
12. **设备码登录/登出**（v0.4.0）：设置页集成 `kimi login` 设备码流程，自动打开浏览器进入授权页，实时显示登录日志；支持一键登出（删除凭据文件）。
13. **kimi doctor 诊断**（v0.4.0）：菜单栏"帮助→运行 kimi doctor"或设置页"环境诊断"按钮，一键执行 `kimi doctor` 配置体检，结果弹窗展示。
14. **代理设置**（v0.4.0）：设置页支持 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 四项代理配置，保存后自动注入自动启动的 CLI 子进程环境变量。
15. **首次运行欢迎引导**（v0.4.0）：首次启动（无配置文件时）自动进入设置页，引导用户完成 Git Bash 检测、CLI 安装、设备码登录等初始配置，而非直接尝试自动连接。
16. **原生问答窗口全类型接管**（v0.5.0）：`event.question.requested` 统一由原生问答窗口（question.html）处理，支持单选、多选、多题与自定义输入（allow_other）；主进程通过 `question:submit`/`question:fallback`/`question:cancel` IPC 提交答案，原 `dialog` 弹窗仅作窗口创建失败时的回退。窗口失焦时自动回退到 Web UI 回答。
17. **托盘用量/任务进度显示**（v0.5.0）：订阅 WS `event.session.usage_updated` 与 `event.task.started/progress/completed` 事件，托盘 tooltip 与菜单状态项实时展示 token 用量、上下文占用百分比与任务运行计数，更新带 500ms 防抖。
18. **编辑器协议接管**（v0.5.0）：外部链接白名单新增 `vscode`、`vscode-insiders`、`cursor`、`windsurf`、`zed`、`sublime`、`atom`、`jetbrains` 等编辑器协议，走系统默认程序打开，Web UI 的 Open in Editor 类按钮可用。
19. **全局热键**（v0.5.0）：`Ctrl+Shift+Space` 全局显示/隐藏窗口，即使应用不在前台也可快速唤回。
20. **mock 验证基建**（v0.5.0）：新增 `scripts/mock-kimi-server.js`（默认端口 58999，固定 token `mock-token`），自动覆盖 client_hello/订阅/问答/审批/用量/任务事件验证，`npm run mock` 一键启动。
21. **测试钩子**（v0.5.0）：支持 `KIMI_DESKTOP_TEST_BASE`、`KIMI_DESKTOP_TEST_TOKEN` 环境变量覆盖服务地址与 token，便于对接 mock 服务做自动化测试。
22. **图形化设置中心**（v0.6.0）：设置页（setup.html）新增标签页导航，集成 config.toml / 权限规则 / 供应商管理 / MCP 服务器四大配置面板。
23. **config.toml GUI 编辑**（v0.6.0）：支持编辑 `default_model`、`default_permission_mode`（manual/yolo/auto）、`default_plan_mode`、`telemetry` 开关，以及 `[thinking]` / `[loop_control]` 参数；保存前自动调用 `kimi doctor` 校验，失败时回滚原文件。
24. **权限规则编辑器**（v0.6.0）：可视化增删改 `[[permission.rules]]`，支持 decision（allow/deny/ask）、pattern、scope，提供"拒绝 rm -rf"与"敏感文件 ask"安全预设。
25. **供应商与模型管理器**（v0.6.0）：调用 `kimi provider list --json` 展示供应商列表，支持删除供应商与通过向导添加 catalog 供应商（覆盖 6 种 provider 类型）。
26. **MCP 服务器配置 GUI**（v0.6.0）：读写用户级 `~/.kimi-code/mcp.json`，支持 stdio/http/sse 三种接入方式、命令/URL、环境变量与启停工具列表。
27. **会话归档与删除管理器**（v0.7.0）：会话启动器详情面板新增「归档」「删除」按钮；启动时解析 `/openapi.json` paths 自动探测服务端能力（`:archive` 自定义动词 / `/archive` 子路径 / `DELETE` 三种形态自适应），不支持的端点按钮禁用；删除前先归档降低误删损失；订阅 WS `event.session.deleted` 自动刷新列表。
28. **认证错误识别与 FAQ 引导**（v0.7.0）：CLI 输出与 WebSocket 关闭/错误中识别 401/认证失败关键字（每次启动只弹一次），弹出排查卡片（api.kimi.com 与 api.moonshot.cn 密钥不通用、设备授权 30 天过期、模型 ID 静默回退等），可一键跳转重新登录。
29. **Skills 管理面板**（v0.7.0）：设置中心新增 Skills 标签页，扫描用户级 `~/.kimi-code/skills/` 与 `extra_skill_dirs`（只读标注来源），解析 SKILL.md frontmatter，支持新建/编辑/重命名/删除用户级技能。
30. **Hooks 可视化编辑器**（v0.7.0）：设置中心新增 Hooks 标签页，按官方文档内置 16 个事件清单与用途提示，编辑 `[[hooks]]`（event/matcher/command/timeout），提供拦截 rm -rf、任务完成通知、附加 Git 分支、Bash 审计日志 4 个模板，保存走 doctor 校验回滚。
31. **模型切换下拉**（v0.7.0）：托盘菜单与「会话」菜单新增「默认模型」单选子菜单，模型列表取自 `GET /api/v1/models`（失败回退双档模型 + 当前配置），切换写入 config.toml 并可选立即重启生效；订阅 `event.model_catalog.changed` 自动刷新。
32. **新会话权限模式选择**（v0.7.0）：会话启动器新建按钮旁新增权限模式下拉与 Plan 复选（默认「保持当前配置」），选择后先写 config.toml 再创建会话。
33. **维护面板**（v0.7.0）：设置中心新增维护标签页——CLI 检查更新（读 `updates/latest.json` 比对版本）与一键升级（重跑官方 install.ps1，成功后自动重启）；数据目录体积统计与勾选清理（sessions/logs/bin/updates/server，凭据受保护）；诊断打包（app.log + doctor 输出 + 最近会话导出，PowerShell Compress-Archive 生成 ZIP）。
34. **高级启动参数**（v0.7.0）：环境页新增固定端口 `--port`、监听地址 `--host`、日志级别 `--log-level`、自定义 `KIMI_CODE_HOME` 四项设置（仅新版 CLI 生效，旧版自动忽略并记日志）；KIMI_CODE_HOME 在应用启动最早期注入，全进程统一生效。
35. **令牌轮换**（v0.7.0）：「会话」菜单新增「轮换访问令牌…」，调用 `kimi web rotate-token` 后重读 server.token、重载窗口并重建 WS 订阅。

## 会话启动器

v0.3.0 新增**会话启动器**（`Ctrl+Shift+S`），提供完整的会话管理能力：

- **会话历史浏览**：读取 `~/.kimi-code/session_index.jsonl` 索引文件，按更新时间降序排列，支持搜索标题/目录/最近提示。
- **恢复指定会话**：选中会话后点击"恢复会话"，以 `kimi --session <id>` 参数重启 Web 服务，直接进入该会话。
- **ZIP 导出**：选中会话后点击"导出 ZIP"，调用 `kimi export <sessionId> -o <path> -y`，通过保存对话框选择导出路径。
- **可视化窗口**：选中会话后点击"打开可视化"，spawn `kimi vis <sessionId> --no-open` 捕获地址并在独立 Electron 窗口中打开。
- **指定目录新建会话**：点击侧边栏 `+` 按钮，选择工作目录后通过深链 `?action=create-in-dir&workDir=<path>` 导航至 Web UI 创建新会话。
- **托盘/菜单入口**：托盘右键菜单和菜单栏"会话"菜单均提供"打开会话启动器"入口。
- **快捷键**：`Ctrl+Shift+S` 直接打开会话启动器。

## 快捷键与菜单

按 `Alt` 显示菜单栏。

| 功能 | 快捷键 |
|---|---|---|
| 显示/隐藏窗口（全局） | `Ctrl+Shift+Space` |
| 打开会话启动器 | `Ctrl+Shift+S` |
| 新建 Web 会话 | `Ctrl+Shift+N` |
| 手动输入地址 | `Ctrl+L` |
| 重新加载 | `Ctrl+R` |
| 窗口置顶 | `Ctrl+T` |

## 系统托盘

应用常驻系统托盘，关闭或最小化窗口都不会退出：

- **最小化 / 点 X** → 收进托盘，Web 会话保持运行
- **单击托盘图标** → 秒回窗口（会话原样恢复）
- **双击托盘图标** → 秒开新 Web 会话
- **右键托盘图标** → 显示主窗口 / 打开会话启动器 / 新建 Web 会话 / 退出
- **托盘 tooltip 状态** → 实时显示 token 用量、上下文占用百分比、运行中任务数、待处理审批与问答计数（需 WS 连接就绪后更新）

首次收进托盘时会弹出气泡提示。真正退出请用托盘菜单或应用菜单中的"退出"。

## 从源码运行 / 重新打包

```bash
npm install          # 安装依赖
npm start            # 开发运行
npm run dev          # 开发模式（--dev 标志）
npm run mock         # 启动 Mock Kimi 服务端（测试用，端口 58999）
npm run dist         # 打包便携版 exe → release\v<version>\（版本化输出，推荐）
npm run pack:versioned           # 与 dist 等效，版本化打包
npm run pack:versioned:ca        # 若 CA 证书导致下载失败，使用系统证书存储
```

> `npm run dist` 现在等同于 `npm run pack:versioned`，产物按版本隔离存储于 `release\v<version>\` 目录。

国内网络建议设置镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm install
```

## 数据目录

配置与日志位于 `%APPDATA%\kimi-code-desktop\`：

- `config.json` — 启动模式 / CLI 路径 / 手动地址
- `app.log` — 启动与捕获日志（已脱敏）
- `window-state.json` — 窗口位置尺寸

## 文件结构

```
main.js              Electron 主进程（CLI 版本检测、双通道地址捕获、HTTP 轮询就绪探测、优雅退出、IPC、会话管理、WebSocket 订阅、托盘用量/任务状态、全局热键、问答窗口管理、编辑器协议接管、配置中心 IPC）
preload.js           渲染进程桥接（含会话启动器 API 和配置中心 API）
config-manager.js    配置管理模块（读写 config.toml、tui.toml、mcp.json，写入前备份、doctor 校验、失败回滚）
question.html        原生问答窗口（单选/多选/多题/自定义输入，深色主题 UI）
question.js          问答窗口渲染逻辑（选项渲染、多题翻页、答案校验、提交/回退/取消）
question-preload.js  问答窗口预加载桥接（contextIsolation 下暴露 kimiQuestion API）
loading.html         启动等待页（实时显示 CLI 日志）
setup.html           设置页（自动/手动两种连接方式，含标签页导航：环境/通用配置/权限规则/供应商/MCP）
sessions.html        会话启动器（历史浏览、恢复、导出 ZIP、可视化、新建会话）
assets/              应用图标
scripts/
  mock-kimi-server.js  Mock Kimi 服务端（HTTP+WS，覆盖 client_hello/订阅/问答/审批/用量/任务事件验证）
  pack-versioned.ps1   版本化打包脚本
test-config-manager.js 配置管理模块单元测试
test-skills-manager.js Skills 管理模块单元测试
CHANGELOG.md          版本变更历史
FEATURE-IDEAS.md      功能建议报告与实施状态
```