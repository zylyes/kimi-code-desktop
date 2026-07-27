# Kimi Code Desktop v1.0.0 🎉

> Kimi Code 网页版的原生桌面体验。一键启动 Kimi Code 本地服务，无需浏览器——ACP 原生聊天、图形化设置、会话管理、全局热键、无边框窗口，全部开箱即用。

## 直接使用

从 [Releases](https://github.com/zylyes/kimi-code-desktop/releases) 下载最新版本，提供三种分发格式：

| 格式 | 文件名 | 说明 |
|---|---|---|
| **安装包** | `KimiCodeDesktop-Setup-x.x.x.exe` | 带安装向导，可选安装路径，创建开始菜单快捷方式 |
| **便携版** | `KimiCodeDesktop-Portable-x.x.x.exe` | 绿色版，双击即用，无需安装 |
| **7z 自解压** | `KimiCodeDesktop-x.x.x-x64.7z` | 压缩包，解压到任意目录直接运行 |

### 要求

- Windows 10+（x64）
- [Kimi Code CLI](https://www.kimi.com/code)（可选——首次运行可在设置页一键在线安装）

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
36. **多实例管理面板**（v0.8.0）：托盘新增「多实例」子菜单，扫描 `~/.kimi-code/server/instances/`（0.28+ 格式，目录不存在时回退 `server/lock` 旧版格式），显示各实例端口/版本/存活状态/当前连接标记；点击实例先 HTTP 探测可达再重读 server.token 完成切换；10 秒缓存防抖 + 「重新扫描」手动刷新，已退出实例置灰。
37. **旧版 kimi-cli 迁移提示**（v0.8.0）：启动时检测 `~/.kimi/` 存在且含 `bin/` 或 `config.toml` 时弹出「立即迁移 / 稍后 / 不再提示」对话框；「立即迁移」打开外部终端运行 `kimi migrate`，「不再提示」写入 config.json 持久去重。
38. **IDE 一键接入向导**（v0.8.0）：设置中心新增「IDE 接入」标签页 + 帮助菜单「IDE 接入向导…」入口；探测 `kimi acp` 可用性后，Zed 支持一键写入 agent_servers 配置（JSONC 合并、写前 .bak 备份），JetBrains 检测已装 IDE 并给出手动配置步骤，通用 ACP 片段适配其它客户端。
39. **自动更新/遥测开关**（v0.8.0）：维护页新增「自动安装更新」开关（读写 tui.toml `[upgrade].auto_install`，doctor 校验 + 失败回滚）；环境页新增「禁止 CLI 自动更新」「禁用遥测」强制开关，写入 config.json 并向子进程注入 `KIMI_CODE_NO_AUTO_UPDATE=1`/`KIMI_DISABLE_TELEMETRY=1`（保存后自动重启生效）。
40. **新手 prompt 模板库**（v0.9.0）：帮助菜单新增「Prompt 模板库…」，按帮助中心五大场景（实现新功能/修复 bug/理解项目/自动化/通用任务）内置 15 条工程实践示例 prompt，一键复制。
41. **命令与快捷键速查**（v0.9.0）：帮助菜单新增「命令与快捷键速查…」（F1），内置斜杠命令分类表 + TUI 快捷键 + 桌面端快捷键清单。
42. **敏感目录启动警告**（v0.9.0）：会话启动器新建会话时，工作目录为 home 根/盘符根/含 `.ssh`/`.gnupg`/等于 `KIMI_CODE_HOME` 的，先弹警告对话框。
43. **调试模式开关**（v0.9.0）：环境页「高级」新增 debugMode，启用后新版 CLI 以 `--log-level debug --debug-endpoints` 启动。
44. **Markdown 导出会话**（v0.9.0）：会话启动器详情面板新增「导出 Markdown」，解析 `agents/main/wire.jsonl` 输出 .md 文件。
45. **子 Agent 任务监视器**（v0.9.0）：详情面板新增「任务监视」，新窗口按时间线渲染各 Agent 卡片（消息/事件数、起止时间、事件类型 chips）与后台任务。
46. **局域网/手机访问模式**（v0.9.0）：会话菜单新增「局域网访问…」窗口——一键写 `host=0.0.0.0` 并重启；展示各网卡 URL（含 token）与二维码；顶部醒目安全警示。
47. **自定义 marketplace 注入**（v0.9.0）：环境页新增 pluginMarketplaceUrl → `KIMI_CODE_PLUGIN_MARKETPLACE_URL`。
48. **临时模型快速测试**（v0.9.0）：环境页「临时模型」分组（name/apiKey/providerType/baseUrl 等），注入 `KIMI_MODEL_*` 进程级环境变量合成临时供应商，不写 config.toml。
49. **自建端点支持**（v0.9.0）：环境页新增 oauthHost/selfHostedBaseUrl → `KIMI_CODE_OAUTH_HOST`/`KIMI_CODE_BASE_URL`。
50. **插件管理面板**（v0.9.0）：设置中心新增第 10 个标签页「插件」，扫描 `plugins/managed/<id>/` 清单并合并启用状态，支持启用/禁用（.bak 备份）。
51. **ACP 原生聊天只读原型窗（实验）**（v0.10.0）：菜单「会话→原生聊天原型（ACP 实验）…」打开；主进程经 `acp-client.js` 模块直连 `kimi acp` 子进程，initialize → session/new → 流式 prompt 全链路；会话落在系统临时目录（mkdtemp）实现只读隔离；权限请求一律自动取消（仅状态栏提示）；渲染层流式正文 + 思考折叠区 + 渲染节流；`stopReason` 回传后输入框恢复。
52. **全窗口 kimi.com 官方风格翻新**（v0.10.0）：新增共享样式 `kimi-theme.css`（设计令牌），设置中心/会话启动器/问答窗/模板库/速查窗/局域网/子 Agent 监视/loading 等原生页面统一接入 kimi.com 官方黑白灰设计语言；亮/暗主题跟随系统，各窗口 `backgroundColor` 经 `windowBackground()` 函数跟随 `nativeTheme` 动态切换。
53. **ACP 原生审批弹窗**（v0.11.0）：`session/request_permission` 接入原生模态审批窗，once/always 语义映射按钮组，详情区展示命令/路径等工具上下文，Esc/关窗即取消；窗口创建失败回退系统对话框；聊天窗失焦时系统通知 + 任务栏闪框。
54. **ACP 工具调用卡片**（v0.11.0）：`tool_call`/`tool_call_update` 渲染为状态流转卡片（pending→in_progress→completed/failed，折叠详情与输出摘要）。
55. **ACP 原生聊天真实会话化**（v0.12.0）：`acp-chat:start` 支持 `{cwd, sessionId}`，真实工作目录启动（路径非法回退临时目录）；菜单项改名「原生聊天（新会话）…」。
56. **历史会话恢复**（v0.12.0）：会话启动器详情新增「原生聊天」按钮（无 workDir 的会话禁用并提示；敏感目录弹确认）；`session/load` 接续 agent 上下文 + 本地 wire.jsonl 自绘最近 50 条历史（agent 重放则跳过本地历史）；标题栏显示会话名与工作目录；load 失败明确报错不静默回退新建。
57. **configOptions 原生切换栏**（v0.12.0）：聊天窗状态条下新增模型/思考/权限模式三下拉（缺项自动隐藏），切换走 `session/set_config_option`，失败回滚并提示，仅就绪且非在途时可操作。
58. **停止生成按钮**（v0.12.0）：busy 时发送键变「停止」，走 `session/cancel` 通知。
59. **ACP 原生聊天斜杠命令菜单**（v0.13.0）：`available_commands_update` 全量转发至渲染层；输入 `/` 触发前缀过滤弹窗，键盘上下键 + Enter 与鼠标点击均可选中插入；命令作为普通文本 prompt 由 agent 执行。
60. **ACP 原生聊天图片输入**（v0.13.0）：composer 新增圆形附件按钮（回形针图标），系统选图后以 base64 图片块随 prompt 发送；mimeType 白名单 png/jpeg/gif/webp，单张解码后 ≤10MB，一次 ≤4 张（超限跳过并提示）；textarea 上方缩略图 chips 可单张移除，用户气泡内嵌图片预览。
61. **WebView 降级入口**（v0.13.0）：聊天窗状态条右侧新增「Web UI」按钮，一键聚焦主窗高级面板，原生聊天能力缺失场景可随时降级回 Web UI。
62. **autoStartCli 配置项**（v0.14.0）：设置页新增「启动时自动连接 CLI」开关，关闭后启动时先停留在配置页而非自动连接；默认开启，保持原有行为。
63. **托盘菜单「设置…」入口**（v0.14.0）：托盘右键菜单新增「设置…」，直达设置页。
64. **菜单栏「设置…」+ 快捷键**（v0.14.0）：菜单栏「会话」子菜单新增「设置…」（`Ctrl+,`），快速打开设置。
65. **应用设置面板**（v0.15.0）：设置页新增「应用设置」面板，支持主题模式（跟随系统/浅色/深色）、界面缩放（80%~150%）、关闭/最小化到托盘开关、窗口置顶、开机自动启动、桌面通知、全局快捷键共 8 项；全部即时生效，不重启 server。
66. **设置页侧栏导航**（v0.15.0）：设置页 UI 重构为左侧分组导航 + 右侧内容布局，分组为「应用」「环境」「配置」「集成」。
67. **Web UI 浮动设置按钮**（v0.15.0）：kimi web 会话页右下角注入齿轮设置按钮，点击直接打开设置；会话启动器新增设置入口（⚙）。
68. **Windows 通知应用名修正**（v0.16.0）：系统通知顶部显示「Kimi Code Desktop」，不再显示 Electron 默认进程名。
69. **全局 UI 令牌化清理**（v0.16.0）：kimi-theme.css 共享层扩充 `--font-mono`/`--radius-sm`/`.btn.ghost` 等令牌与组件，各原生窗口统一走主题令牌（圆角/字体/焦点环/禁用态），permission/question 重复 CSS 去重，sessions 配色收敛至两点缀色。
70. **CLI 更新检查误报修复**（v0.16.1）：修复本地版本高于远程时误提示"有更新"的问题。
71. **屏蔽网页 HTML5 通知**（v0.16.1）：桌面端统一由主进程原生通知展示，避免同一事件双重弹出。
72. **全窗口无边框化**（v0.17.0）：全部原生窗口统一改为无边框设计（`titleBarStyle: 'hidden'` + `titleBarOverlay` 悬浮窗控），去除原生标题栏与 Web UI 品牌区/会话头部的冗余；悬浮窗控跟随亮/暗主题联动。
73. **页面内菜单按钮**（v0.17.0）：无边框后无原生菜单栏，主窗口右下角新增 `☰` 浮动菜单按钮，点击弹出完整应用菜单（快捷键不受影响）。
74. **窗口拖拽**（v0.17.0）：顶部 10px 拖拽条 + `.topbar` 顶栏整行作为拖拽区，双击拖拽区切换最大化。
75. **WebContentsView 覆盖层架构**（v0.18.0）：sessions/setup 由全页加载重构为覆盖层盖在常驻 Web UI 之上，切回时直接移除（零重载、不丢 WS 连接）；`foregroundContents()` 统一路由 IPC 消息。
76. **菜单扁平化**（v0.18.0）：去除「会话」子菜单，常用操作（启动器/新建/设置/轮换令牌/局域网/原生聊天）平铺顶层，仅「视图」「帮助」为子菜单。
77. **窗控区颜色运行时同步**（v0.19.0）：Web UI 页实时采样右上角背景色并动态同步悬浮窗控配色，预览栏/改动条等任意顶栏状态下窗控与页面无缝融合。
78. **Kimi 风应用菜单面板**（v0.19.0）：右上角单个 ☰ 按钮（与窗控同排同风格），点击展开官方风自绘面板：分组标题、勾选态、快捷键提示、模型/多实例二级子面板、亮暗双主题；全窗口统一入口；原生菜单仅作快捷键载体。
79. **新建对话鲁棒化**（v0.19.0）：实测确认官方新建按钮（`.btn-new-chat`）原地切换新空会话，改为候选选择器数组逐个尝试。
80. **全页面官方风美化**（v0.19.0）：十个原生页面逐页对齐主题令牌（硬编码色值清零、圆角/字号/间距统一、按钮归一、空态/加载态共享组件、暗色核验）。

## 会话启动器

v0.3.0 新增**会话启动器**（`Ctrl+Shift+S`），提供完整的会话管理能力：

- **会话历史浏览**：读取 `~/.kimi-code/session_index.jsonl` 索引文件，按更新时间降序排列，支持搜索标题/目录/最近提示。
- **恢复指定会话**：选中会话后点击"恢复会话"，以 `kimi --session <id>` 参数重启 Web 服务，直接进入该会话。
- **原生聊天恢复**（v0.12.0）：详情面板新增「原生聊天」按钮，以 ACP 原生聊天窗恢复有 workDir 的历史会话（`session/load` 接续上下文 + 本地历史自绘；无 workDir 禁用、敏感目录弹确认）。
- **ZIP 导出 / Markdown 导出**：选中会话后可导出 ZIP 或 Markdown（v0.9.0，解析 wire.jsonl 输出 .md）。
- **可视化窗口 / 任务监视器**：选中会话后打开可视化或任务监视器窗口（v0.9.0，时间线渲染各 Agent 卡片）。
- **指定目录新建会话**：点击侧边栏 `+` 按钮，选择工作目录后通过深链导航至 Web UI 创建新会话（v0.9.0 新增敏感目录警告）。
- **托盘/菜单入口**：托盘右键菜单和菜单栏"会话"菜单均提供"打开会话启动器"入口。
- **快捷键**：`Ctrl+Shift+S` 直接打开会话启动器。

## 快捷键与菜单

应用菜单经各窗口右上角 `☰` 按钮打开（Kimi 风自绘面板，含模型/多实例二级子面板）；原生菜单栏已隐藏，仅作快捷键载体，下表快捷键直接可用。

| 功能 | 快捷键 |
|---|---|---|
| 显示/隐藏窗口（全局） | `Ctrl+Shift+Space` |
| 打开会话启动器 | `Ctrl+Shift+S` |
| 新建对话 | `Ctrl+Shift+N` |
| 手动输入地址 | `Ctrl+L` |
| 重新加载 | `Ctrl+R` |
| 窗口置顶 | `Ctrl+T` |
| 命令与快捷键速查 | `F1` |
| 打开设置 | `Ctrl+,` |

## 系统托盘

应用常驻系统托盘，关闭或最小化窗口都不会退出：

- **最小化 / 点 X** → 收进托盘，Web 会话保持运行
- **单击托盘图标** → 秒回窗口（会话原样恢复）
- **双击托盘图标** → 秒开新 Web 会话
- **右键托盘图标** → 显示主窗口 / 打开会话启动器 / 新建 Web 会话 / 设置 / 退出
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
src/
  main/                   主进程模块
    main.js               Electron 主进程（启动/托盘/窗口/WS/IPC/ACP 全逻辑）
    acp-client.js          ACP 协议客户端（stdio JSON-RPC 2.0，图片附件支持）
    config-manager.js      配置管理（config.toml/tui.toml/mcp.json 读写校验）
    instances-manager.js   多实例管理（扫描/探测/切换）
    ide-integration.js     IDE 接入（kimi acp 探测/编辑器检测/Zed 配置）
    skills-manager.js      Skills 管理（frontmatter 解析/目录扫描/读写删）
    plugins-manager.js     插件管理（清单扫描/启用状态合并）
    session-export.js      会话导出（JSONL 解析/Markdown 渲染/Agent 扫描）
    menu-panel.js          Kimi 风自绘菜单面板（全窗口统一入口）
  pages/                  原生页面
    loading.html           启动等待页
    setup.html             设置页（侧栏分组导航）
    sessions.html          会话启动器
    chat.html + chat.js    ACP 原生聊天前端（斜杠命令/图片输入/WebView 降级）
    permission.html + .js  ACP 原生审批弹窗
    question.html + .js    原生问答窗口
    prompts.html           Prompt 模板库
    help.html              命令与快捷键速查
    agents.html            子 Agent 任务监视器
    lan.html               局域网访问面板
  preload/                预加载桥接
    preload.js             主窗口渲染桥接
    chat-preload.js        聊天窗桥接
    permission-preload.js  审批窗桥接
    question-preload.js    问答窗桥接
  styles/
    kimi-theme.css         全应用共享设计令牌样式表（亮/暗双主题）
scripts/                   工具脚本
  mock-kimi-server.js      Mock Kimi 服务端
  pack-versioned.ps1       版本化打包脚本
  acp-probe.js/3.js/4.js  ACP 协议探测
  probe-panels.js          页面元素探针 dump + 窗控变色逐帧测量
tests/                     单元测试（7 个文件，全部通过）
docs/                      调研文档
CHANGELOG.md               版本变更历史
FEATURE-IDEAS.md           功能建议报告
RELEASE_NOTES.md           发行版说明