# Kimi Code Desktop 功能建议报告

> 调研来源：Kimi Code 官方文档（https://www.kimi.com/code/docs/kimi-code-cli/ ）10 个板块精读，
> 覆盖 kimi 命令参考、会话管理、配置系统、平台与模型、扩展能力（Skills/插件/MCP/Hooks）、
> 交互模式与权限、IDE/ACP 集成、Web UI、帮助中心最佳实践。
> 调研日期：2026-07-21。本项目当前版本 v0.17.0：Electron 套壳，已实现 `kimi web` 进程管理 + 托盘 + 配置持久化 + 会话启动器 + 新手引导 + WS 事件订阅/原生通知/问答 + 图形化设置中心 + 会话归档/删除 + 认证引导 + Skills/Hooks 面板 + 模型切换 + 权限模式 + 维护面板 + 高级启动参数 + 令牌轮换 + 多实例管理面板 + 旧版迁移提示 + IDE 一键接入向导 + 自动更新/遥测开关 + P2 精选（模板库/速查窗/敏感目录警告/调试模式/Markdown 导出/子 Agent 监视器/局域网访问/插件面板/高级 env 注入）+ ACP 只读原型聊天窗 + 全窗口 kimi.com 官方风格翻新 + ACP 审批弹窗原生化 + ACP 工具调用卡片 + ACP 原生聊天真实会话化（真实目录启动/启动器入口/历史恢复/configOptions 切换栏/停止生成）+ ACP 斜杠命令菜单/图片输入/WebView 降级入口（v0.17.0）。

## 状态图例

| 标记            | 含义                              |
| --------------- | --------------------------------- |
| ✅ 已发布       | 代码已合入并随对应版本发布        |
| 🔶 工作区已实现 | 代码完成于当前工作区，待提交/发布 |
| 🔲 部分实现     | 基本功能可用，部分场景回退或受限  |
| ⬜ 未实现       | 尚未开发                          |

### 当前实现总览

| 阶段  | 状态      | 核心内容                                             |
| ----- | --------- | ---------------------------------------------------- |
| 阶段1 | ✅ v0.2.0 | CLI 版本适配层                                       |
| 阶段2 | ✅ v0.3.0 | 会话启动器                                           |
| 阶段3 | ✅ v0.4.0 | 新手引导                                             |
| 阶段4 | ✅ v0.5.0 | WS 通知、原生问答、托盘用量、全局热键、外链接管      |
| 阶段5 | ✅ v0.6.0 | 图形化设置中心（config.toml、权限规则、供应商、MCP） |
| 阶段7 | ✅ v0.7.0 | P0 收尾（会话归档/删除、认证错误引导）+ 精选 P1（Skills/Hooks 面板、模型切换、权限模式、维护面板、启动参数） |
| 阶段8 | ✅ v0.8.0 | P1 收尾（多实例管理面板、旧版迁移提示、IDE 一键接入向导、自动更新/遥测开关） |
| 阶段9 | ✅ v0.9.0 | P2 精选 11 项（模板库/速查窗/敏感目录警告/调试模式/Markdown 导出/子 Agent 监视器/局域网访问/插件面板/marketplace·临时模型·自建端点注入） |
| 阶段6 | ✅ 调研完成 | ACP spike 握手成功（scripts/acp-probe.js + docs/acp-research.md） |
| 阶段6 | ✅ v0.10.0 | ACP 只读原型聊天窗 + 全窗口 kimi.com 官方风格翻新 |
| 阶段6 | ✅ v0.11.0 | ACP 审批弹窗原生化（原生模态审批窗 + 工具调用卡片渲染） |
| 阶段6 | ✅ v0.12.0 | ACP 原生聊天真实会话化（真实目录启动/启动器入口/历史恢复/configOptions 切换栏/停止生成） |
| 阶段6 | ✅ v0.17.0 | ACP 斜杠命令菜单/图片输入/WebView 降级入口（原生聊天渐进替代项清零） |

---

## 0. 紧急：CLI 版本适配层（文档揭示的破坏性变化）

> ✅ **v0.2.0 已实现**（2026-07-21）

官方文档（0.28+）与本机实测 CLI（0.27.0）存在**机制性差异**，现有代码可能随 CLI 升级而失效：

| 差异点       | 旧版（本机 0.27.0）                                                     | 新版（官方文档 0.28+）                                                                       |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 服务命令     | `kimi server run`（守护进程）+ legacy 锁 `~/.kimi-code/server/lock` | `kimi server` 树**整体废弃**（退出码 1），仅 `kimi server kill` 保留用于清理旧进程 |
| 前台运行     | `kimi web --foreground`（我们当前用法）                               | `kimi web` **默认前台**运行，`--foreground` 不再出现在文档中                       |
| 无客户端退出 | 60 秒无连接自动退出（`--keep-alive` 控制）                            | 文档未提，需实测                                                                             |
| 多实例       | 单实例锁文件                                                            | 多实例注册到`~/.kimi-code/server/instances/`，端口被占自动 +1                              |
| 默认端口     | 5494（Python 旧版）/ 58627                                              | 58627（被占自动 58628、58629…）                                                             |

**✅ 已实现**：

1. ✅ 启动前跑 `kimi --version` 探测版本，按版本选择启动命令、flag 组合与 URL 捕获策略；
2. ✅ URL 捕获从"正则解析 stdout"升级为**双通道**：直接读 `~/.kimi-code/server.token` 拼 `http://127.0.0.1:<port>/#token=<token>`，stdout 正则仅作兜底；
3. ✅ 就绪探测改为 **HTTP 轮询**：捕获端口后轮询 `GET /openapi.json` 直到 200 再加载窗口，消除时序竞争导致的白屏；
4. ✅ 退出时先 `POST /api/v1/shutdown` 或发 SIGTERM 并等待，超时再强杀，避免会话数据写损。

---

## 1. 高价值功能（P0）

### 1.1 会话管理（让套壳变成"启动器"）✅ **v0.3.0 已实现**

| 功能                                            | 文档依据                                                                                                                         | 实现思路                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| ✅ 原生历史会话侧边栏（标题/工作目录/更新时间） | `~/.kimi-code/session_index.jsonl` 每行含 `sessionId/sessionDir/workDir`；各会话 `state.json` 含标题、`lastPrompt`、时间 | 只读解析索引文件，渲染会话列表                         |
| ✅ 一键继续最近会话 / 恢复指定会话              | `kimi --continue`、`kimi --session <id>`                                                                                     | 列表点击后 spawn 对应命令（注意`-c` 与 `-S` 互斥） |
| ✅ 在指定目录新建会话                           | Web UI URL 参数`?action=create-in-dir&workDir=<path>`（旧版文档，新版需实测）；REST `POST /api/v1/sessions`                  | 目录选择器 + 深链导航或 REST 创建                      |
| ✅ 导出会话为 ZIP                               | `kimi export <sessionId> -o <path> -y [--no-include-global-log]`                                                               | Electron 保存对话框 + spawn 子命令                     |
| ✅ 会话可视化窗口                               | `kimi vis [sessionId] --no-open` 打印访问地址                                                                                  | 复用现有"spawn + 捕获地址 + 窗口加载"架构，零新范式    |
| ✅ 会话归档/删除管理器（v0.7.0）                  | REST`:archive` 动作；WS `event.session.deleted`；Web UI 超 15 天自动归档                                                     | 原生面板调 REST 动作                                   |

### 1.2 审批与通知（桌面壳的独特价值）

| 功能                                                | 文档依据                                                                                               | 实现思路                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ 审批请求 → 系统原生通知（仅通知，不含原生回复） | WS`event.approval.requested/resolved/expired`；REST `/sessions/{id}/approvals/{approval_id}`       | 已连接 WebSocket 订阅审批事件，窗口失焦时弹系统通知 + 任务栏闪烁，点击聚焦窗口；尚不支持原生回复审批                                                                |
| ✅ 结构化问答 → 原生弹窗（全类型支持）             | WS`event.question.requested`；REST `/sessions/{id}/questions/*`                                    | 监听问题事件用原生问答窗口（question.html）展示，支持单题/多题/多选/自定义输入（allow_other）/纯文本；窗口创建失败时回退原生 dialog（仅单题单选）或通知+聚焦 Web UI |
| ✅ 任务完成 → 桌面通知                             | Hooks`Notification`(task.completed) / `SubagentStop` 事件；tui.toml `[notifications]` 已有此概念 | 已通过 WS 事件订阅实现，窗口失焦时弹原生通知                                                                                                                        |
| ✅ 托盘显示 token 用量/任务进度                     | WS`event.session.usage_updated`、`event.task.*`                                                    | 托盘 tooltip/角标展示；已订阅 usage_updated/task.*，托盘 tooltip+菜单状态项展示                                                                                     |

### 1.3 新手引导（帮助中心最高频痛点）✅ **v0.4.0 已实现**

| 功能                                                             | 文档依据                                                                                                                                            | 实现思路                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ✅ 首次启动向导：Git Bash 检测 → CLI 安装 → 登录 → 选工作目录 | getting-started：Windows 必须先装 Git for Windows；preparation 页整页新手扫盲                                                                       | 向导页串联现有安装流程                                                  |
| ✅ 登录引导（设备码流程可视化）                                  | `kimi login` 子命令：验证地址+用户码打印到 stderr，轮询授权，退出码 0/1                                                                           | spawn`kimi login`，解析 stderr 展示链接/二维码/用户码，自动打开浏览器 |
| ✅ 登录状态检测与登出                                            | 凭证存`~/.kimi-code/credentials/<name>.json`（0700/0600）；无 `kimi logout` 子命令，删文件即登出                                                | 启动时检查 credentials/ 目录                                            |
| ✅ Git Bash 自检 +`KIMI_SHELL_PATH` 注入                       | 非标准路径 Git 需设`KIMI_SHELL_PATH` 为 bash.exe 绝对路径                                                                                         | 探测常见路径，失败弹引导，config.json 支持自定义                        |
| ✅`kimi doctor` 配置体检入口                                   | `kimi doctor [config\|tui] [path]` 校验配置，退出码 0/1                                                                                            | 菜单项 + 结果弹窗                                                       |
| ✅ 网络自检与代理设置                                            | 支持`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`（含 SOCKS）/`NO_PROXY`；api.kimi.com/api.moonshot.cn 不可被代理拦截                                      | 启动前探测两个 API 域；设置页代理表单注入子进程 env                     |
| ✅ 认证错误识别与 FAQ 引导（v0.7.0）             | api.kimi.com 与 api.moonshot.cn 密钥**不通用**（高频坑）；设备 30 天未用授权过期；高速版无权限返回 401 且填错模型 ID **静默回退**不报错 | 监听子进程输出中的 401/认证失败关键字，弹对应排查卡片                   |
| ✅ CLI 版本显示 + 一键升级（v0.7.0）             | `kimi --version`；`kimi upgrade` 对 Windows native 只打印手动命令；`~/.kimi-code/updates/latest.json` 存最新版信息                            | 关于页显示版本；有新版时重跑`install.ps1` 完成升级                    |

### 1.4 图形化设置面板（config.toml GUI 化）✅ **v0.6.0 已实现**

| 功能                              | 文档依据                                                                                                                                                       | 实现思路                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ✅ 设置面板编辑核心配置           | config.toml 全字段：`default_model`、`default_permission_mode`(manual/yolo/auto)、`default_plan_mode`、`telemetry`、`[thinking]`、`[loop_control]` | TOML 解析库读写`~/.kimi-code/config.toml`                              |
| ✅ 权限规则编辑器 + 安全预设      | `[[permission.rules]]`：decision(allow/deny/ask) + pattern（如 `Bash(rm -rf*)`）+ scope                                                                    | 规则列表 UI + 模板（"拒绝 rm -rf"、"敏感文件 ask"），配合 YOLO/Auto 使用 |
| ✅ 供应商与模型管理器             | `kimi provider list --json` / `remove` / `catalog add`；6 种 provider 类型（kimi/anthropic/openai/openai_responses/google-genai/vertexai）               | GUI 列表 + 添加向导（填类型/key/baseURL/模型一键导入）                   |
| ✅ 保存后自动`kimi doctor` 校验 | 退出码语义                                                                                                                                                     | 每次代写配置后校验，失败提示且不覆盖原文件                               |
| ✅ MCP 服务器配置 GUI             | 两层`mcp.json`（用户级 `~/.kimi-code/mcp.json` + 项目级）；stdio/HTTP/SSE 三种接入；`enabledTools`/`disabledTools` 等字段                              | 表单读写 mcp.json                                                        |

---

## 2. 中价值功能（P1）

| 功能                                            | 文档依据                                                                                                                            | 实现思路                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ 多实例管理面板（v0.8.0）                     | 实例注册到`~/.kimi-code/server/instances/`；`kimi server ps`（0.27）/ `/api/v1/connections`                                   | 读目录列出存活实例，托盘切换/重连，避免重复起进程                                                                                                       |
| ✅ 自定义`KIMI_CODE_HOME`（v0.7.0）             | 环境变量可整体搬迁数据根                                                                                                            | config.json 加字段，spawn 注入 env                                                                                                                      |
| ✅ 令牌轮换菜单（v0.7.0）                       | `kimi web rotate-token`：旧 token 立即失效，运行中实例自动换用                                                                    | 菜单项调子命令后按新`server.token` 重载 URL                                                                                                           |
| ✅ 固定端口 /`--host` / `--log-level`（v0.7.0） | `kimi web --port/--host/--allowed-host/--log-level`                                                                               | config.json 扩展字段拼启动参数                                                                                                                          |
| ✅ 旧版 kimi-cli 迁移提示（v0.8.0）             | 检测`~/.kimi/` 自动提示；`kimi migrate` 交互迁移（幂等，不删旧数据）                                                            | 首次启动检测后引导                                                                                                                                      |
| ✅ Skills 管理面板（v0.7.0）                    | 四档扫描目录（项目 > 用户 > extra > 内置）；SKILL.md + YAML frontmatter；`extra_skill_dirs`                                       | 扫描目录解析 frontmatter，GUI 新建/编辑/删除                                                                                                            |
| ✅ MCP 服务器配置 GUI                           | 两层`mcp.json`（用户级 `~/.kimi-code/mcp.json` + 项目级）；stdio/HTTP/SSE 三种接入；`enabledTools`/`disabledTools` 等字段   | 表单读写 mcp.json                                                                                                                                       |
| ✅ Hooks 可视化编辑器 + 模板库（v0.7.0）        | `[[hooks]]` 四字段（event/matcher/command/timeout）；16 个事件；退出码 0 放行 / 2 阻断                                            | 生成配置条目 + 预置脚本模板                                                                                                                             |
| ✅ IDE 一键接入向导（v0.8.0）                   | Zed：`agent_servers` JSON 片段；JetBrains：Configure ACP agents（**必须绝对路径**）；`kimi acp` stdio JSON-RPC            | 检测已装编辑器，自动写入/生成配置片段（桌面应用已知 cliPath）                                                                                           |
| ✅ 全局唤起热键（Ctrl+Shift+Space）             | —                                                                                                                                  | 已注册 Electron`globalShortcut`，Ctrl+Shift+Space 显示/隐藏窗口                                                                                       |
| 🔲 外部链接接管（http(s)/mailto/tel 已实现）    | Web UI 外链与 Open in Terminal/VS Code 依赖浏览器协议处理                                                                           | 已通过`setWindowOpenHandler` 拦截，外部 http(s)、mailto/tel 走系统浏览器，同源本地 Kimi 页面留在 WebView，未知协议拒绝；自定义 Open-in 协议接管未实现 |
| ✅ 新会话权限模式选择（v0.7.0）                 | `default_permission_mode`/`default_plan_mode`（注意：`kimi web` **不接受** `--yolo/--plan` flag，只能写 config.toml） | 新建会话前写入配置                                                                                                                                      |
| ✅ 模型切换下拉（v0.7.0）                       | `/models/*` REST 路由；WS `event.model_catalog.changed`；双档模型 `kimi-for-coding` / `kimi-for-coding-highspeed`           | 托盘/菜单下拉切换`default_model`                                                                                                                      |
| ✅ 诊断打包（一键问题反馈）（v0.7.0）           | `kimi export -y` 打包会话 ZIP 含诊断日志                                                                                          | 导出 ZIP + 桌面端 app.log 打包                                                                                                                          |
| ✅ 数据目录管理器（v0.7.0）                     | 官方清理矩阵：sessions/+session_index.jsonl（清会话）、logs/、bin/（rg/fd 缓存）、updates/latest.json                               | 展示各子目录体积 + 勾选清理（二次确认）                                                                                                                 |
| ✅ 自动更新/遥测开关（v0.8.0）                  | tui.toml`[upgrade].auto_install`；`KIMI_CODE_NO_AUTO_UPDATE=1`；`telemetry`/`KIMI_DISABLE_TELEMETRY`                        | 设置页开关写配置或注入 env                                                                                                                              |

---

## 3. 低价值 / 长期方向（P2）

> ✅ **v0.9.0 已实现 11 项**（已发布）；v0.10.0 再落地「完全原生聊天 UI」的 ACP 只读原型 + 全窗口官方风格翻新（见下表首两行）；v0.11.0 落地审批弹窗原生化与工具调用卡片。

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 完全原生聊天 UI（去 WebView 化） | ✅ v0.17.0 渐进替代清零（斜杠命令菜单/图片输入/WebView 降级入口） | ACP spike 已握手成功（docs/acp-research.md）；v0.10.0 只读原型窗已落地（菜单「会话→原生聊天原型（ACP 实验）…」，临时目录只读会话、权限自动取消、流式正文+思考折叠）；v0.11.0 审批弹窗原生化（原生模态审批窗+工具调用卡片）；v0.12.0 真实会话化（真实目录启动、启动器「原生聊天」入口、session/load 历史恢复 + 本地 wire.jsonl 自绘、configOptions 切换栏、停止生成）；v0.17.0 落地斜杠命令菜单（available_commands_update 全量转发 + '/' 前缀过滤弹窗、选中作普通文本 prompt 执行）、图片输入（png/jpeg/gif/webp 白名单、单张 ≤10MB、一次 ≤4 张、chips 与气泡预览）、WebView 降级入口（状态条「Web UI」按钮聚焦主窗高级面板），渐进替代项清零 |
| 全窗口 kimi.com 官方风格翻新 | ✅ v0.10.0 | 新增共享样式 `kimi-theme.css`（设计令牌），设置中心/会话启动器/问答窗/模板库/速查窗/局域网/子 Agent 监视/loading 等原生页面统一接入 kimi.com 官方黑白灰设计语言；亮/暗主题跟随系统，`backgroundColor` 经 `windowBackground()` 动态切换 |
| 局域网/手机访问模式 | ✅ v0.9.0 | 会话菜单「局域网访问…」：一键 `host=0.0.0.0` 重启；展示各网卡 URL + 二维码；安全警示明示**不要**叠加 `--dangerous-bypass-auth` |
| 子 Agent 任务监视器 | ✅ v0.9.0 | 解析 `agents/<id>/wire.jsonl` 与 `tasks/`，会话启动器详情面板「任务监视」开窗渲染时间线 |
| Markdown 导出会话 | ✅ v0.9.0 | 会话启动器「导出 Markdown」：解析 wire.jsonl 渲染 .md（官方 `/export-md` 无非交互等价物，自行实现） |
| 插件管理器 | ✅ v0.9.0 | 设置中心「插件」页：扫描 `plugins/managed/` + installed.json 三形态自适应；可定位条目时启停写回，否则标注用 `/plugins` 命令 |
| 调试模式开关 | ✅ v0.9.0 | 环境页 debugMode → `--log-level debug --debug-endpoints`；`debug:fetchEndpoints` 抓 `/api/v1/debug/` |
| 新手 prompt 模板库 | ✅ v0.9.0 | 帮助菜单「Prompt 模板库…」：五大场景 15 条示例一键复制 |
| 敏感目录启动警告 | ✅ v0.9.0 | 新建会话 workDir 为 home 根/盘符根/含 .ssh/.gnupg/KIMI_CODE_HOME 时弹警告确认 |
| 命令与快捷键速查帮助窗 | ✅ v0.9.0 | 帮助菜单「命令与快捷键速查…」（F1）：斜杠命令 + TUI 快捷键 + 桌面端快捷键 |
| 自定义 marketplace 注入 | ✅ v0.9.0 | 环境页 pluginMarketplaceUrl → `KIMI_CODE_PLUGIN_MARKETPLACE_URL` |
| 临时模型快速测试 | ✅ v0.9.0 | 环境页「临时模型」分组 → `KIMI_MODEL_*` 进程级注入（官方文档实收 11 变量，GUI 覆盖核心 8 个） |
| 自建端点支持 | ✅ v0.9.0 | 环境页 oauthHost/selfHostedBaseUrl → `KIMI_CODE_OAUTH_HOST`/`KIMI_CODE_BASE_URL` |

---

## 4. 建议实施路线

**阶段 1（加固，1-2 天）**：版本适配层 + server.token 直读 + HTTP 就绪探测 + 优雅退出 + 多实例感知 ✅ **v0.2.0 已实现**
**阶段 2（会话启动器，2-3 天）**：会话侧边栏（session_index.jsonl）+ 继续/恢复会话 + 导出 ZIP + kimi vis 窗口 ✅ **v0.3.0 已实现**
**阶段 3（新手体验，2-3 天）**：首次启动向导（Git Bash 检测/安装/登录）+ 版本显示与升级 + doctor 体检 + 代理设置 ✅ **v0.4.0 已实现**
**阶段 4（原生增强，3-5 天）**：WS 连接 → 审批/问答/完成原生通知 + 托盘用量显示 + 全局热键 + 外链接管 → ✅ **v0.5.0 已发布**
**阶段 5（设置中心，3-5 天）**：config.toml 图形化 + 权限规则编辑器 + 供应商管理器 + MCP 配置 GUI → ✅ **v0.6.0 已发布**（Skills/Hooks 面板拆分至后续版本）
**阶段 7（管理增强，2-4 天）**：P0 收尾（会话归档/删除管理器 + 认证错误 FAQ 引导）+ 精选 P1（Skills 面板、Hooks 编辑器、模型切换、新会话权限模式、维护面板含升级/数据目录/诊断打包、高级启动参数、令牌轮换）→ ✅ **v0.7.0 已实现**
**阶段 8（P1 收尾，2-3 天）**：多实例管理面板 + 旧版 kimi-cli 迁移提示 + IDE 一键接入向导 + 自动更新/遥测开关 → ✅ **v0.8.0 已实现**
**阶段 9（P2 精选，2-3 天）**：prompt 模板库 + 命令速查窗 + 敏感目录警告 + 调试模式 + Markdown 导出 + 子 Agent 监视器 + 局域网访问 + 插件面板 + marketplace/临时模型/自建端点注入 → ✅ **v0.9.0 已发布**
**阶段 6（长期）**：ACP 客户端原生 UI，渐进替代 WebView → ✅ v0.10.0 只读原型 + ✅ v0.11.0 审批弹窗已实现，后续渐进替代

### 阶段 4 实现分项详情

| 子项                  | 状态           | 说明                                                                                                                                                                                                                                                                                                                              |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS 连接与订阅         | ✅ 已发布      | 使用`kimi-code.bearer.<token>` 子协议，支持 `client_hello`、会话订阅与断线重连                                                                                                                                                                                                                                                |
| 审批原生通知          | ✅ 已发布      | 窗口失焦时弹系统通知 + 任务栏闪烁；不含原生审批回复                                                                                                                                                                                                                                                                               |
| ✅ 结构化问答原生弹窗 | ✅ 已实现      | 全类型走原生问答窗口（单题/多题/多选/自定义输入/纯文本），dialog 仅作窗口创建失败时的回退                                                                                                                                                                                                                                         |
| 任务完成桌面通知      | ✅ 已发布      | 通过 WS 事件触发原生通知                                                                                                                                                                                                                                                                                                          |
| 全局热键              | ✅ 已发布      | Ctrl+Shift+Space 全局显示/隐藏窗口                                                                                                                                                                                                                                                                                                |
| 外部链接接管          | 🔲 部分实现    | http(s)、mailto/tel 已接管；vscode/cursor/zed 等编辑器协议已接管；同源 Kimi 页面留在 WebView；未知协议拒绝；自定义 Open-in 协议未实现                                                                                                                                                                                             |
| 托盘用量/进度         | ✅ 已发布      | 托盘 tooltip/角标展示 token 用量与任务进度                                                                                                                                                                                                                                                                                        |
| 复杂问答原生输入      | ✅ 已发布      | 多题多选、自定义输入的原生界面                                                                                                                                                                                                                                                                                                    |
| WS 端到端验证         | 🔶 mock 已验证 | mock 全场景通过：client_hello 握手/订阅、用量（12.3k tokens·上下文 35%）、任务 started/progress/completed 计数归零、审批计数、单题/多选/多题问答开窗、answered 释放与 dismiss 关窗、答案提交契约（answers map + method:'click'，多选与多题含 GUI 真实提交落盘）；聚焦回退分支已补日志。真实服务端人工核对待做（见 §5 第 12 条） |

> **注意**：package.json 当前版本 0.12.0。阶段1—5、阶段7—9（v0.2.0 → v0.9.0）均已完成；阶段6 完成 ACP 调研并落地 v0.10.0 只读原型聊天窗 + 全窗口 kimi.com 官方风格翻新 + v0.11.0 审批弹窗原生化与工具调用卡片 + v0.12.0 真实会话化（真实目录启动/历史恢复/configOptions 切换栏/停止生成）。

---

## 5. 需实测验证的存疑点

1. `kimi web` 新版是否仍接受 `--foreground` / `--keep-alive` flag（当前代码依赖）——跑 `kimi web --help` 确认；
2. Web UI 是否保留 `?action=create-in-dir&workDir=` 深链参数（旧版文档）——决定"指定目录新建会话"能否纯 URL 实现；
3. REST/WS 完整端点清单——启动服务后抓 `http://127.0.0.1:<port>/openapi.json` 与 `/asyncapi.json`（带 bearer token）；
4. `POST /api/v1/shutdown` 在新版是否保留（文档仅在 legacy `kimi server kill` 处提及）；
5. `~/.kimi-code/server/instances/` 文件格式（多实例面板依赖）——v0.8.0 已实现防御性解析 + `server/lock` 回退，0.28+ 真实格式待 CLI 升级后人工核对；
6. Electron 窗口内 Web UI 的 `/export` 下载行为需 `will-download` 拦截处理（浏览器下载上限 64 MiB）；
7. `kimi acp` 子命令曾短暂移除后恢复（GitHub issue 记录），IDE 集成功能应以"spawn `kimi acp` 是否存活"为最终判定；
8. Web UI 内是否原生支持 `/permission` 切换、`Ctrl-S` Steer 等 TUI 快捷键（决定桌面端快捷键映射的必要性）；
9. `kimi upgrade` 无非交互 flag，Windows 静默升级应自行重跑 install.ps1 而非驱动交互式命令；
10. `-c` vs `-C`（--continue 短选项）文档不一致，以 `kimi --help` 实测为准。
11. WS 事件订阅与 Kimi 服务端的实际端到端交互尚未完整验证——当前仅通过静态检查（`node --check`、`git diff --check`）和打包（`npm run pack:versioned:ca`）确认 `app.asar` 包含 ws 模块，但 `client_hello` 握手、会话订阅、各类事件（审批/问答/任务完成/用量更新）的收发正确性需启动实际 Kimi 服务端实例后逐一验证。mock 服务器（scripts/mock-kimi-server.js）已覆盖 client_hello/订阅/问答/审批/用量/任务事件的自动验证（2026-07-22 全场景通过）；真实服务端核对见第 12 条人工清单。
12. 真实服务人工核对清单（启动真实 `kimi web` 后逐项核对）：
    1. 触发一次审批请求 → 核对系统通知弹出（窗口聚焦时应静默、托盘状态"审批 1"）；
    2. 触发单选问答 → 核对原生问答窗口弹出、点选提交后答案在会话中生效；
    3. 触发多选问答 → 核对多选勾选 + 自定义输入提交后答案生效；
    4. 触发多题问答（含纯文本题） → 核对逐题翻页、全部作答一次提交后生效；
    5. 在 Web UI 中回答同一问题 → 核对原生窗口收到 dismiss 后自动关闭（约 2.5s）；
    6. 核对托盘 tooltip 的 token 用量与上下文百分比随会话刷新；
    7. 跑一个子任务至完成 → 核对任务完成桌面通知与托盘任务计数归零；
    8. 在 Web UI 点击 `vscode://` 等编辑器外链 → 核对接管到对应编辑器打开。
13. v0.7.0 真实服务核对清单（mock 已验证，真实 `kimi web` 待核）：
    1. 启动后抓真实 `/openapi.json` → 核对归档/删除/模型三个能力的探测结果（日志"服务端能力"行），路径形态与 `:archive` 正则是否匹配；
    2. 会话启动器归档一个会话 → 核对列表移除且 Web UI 中进入归档区；删除一个会话 → 核对 REST 2xx 与索引剔除；
    3. 托盘/菜单「默认模型」→ 核对模型列表与真实 `/api/v1/models` 返回一致、切换后 config.toml 写入且重启生效；
    4. 「会话→轮换访问令牌…」→ 核对旧 token 失效、窗口以新 token 重载、WS 重连成功；
    5. 会话启动器选择 yolo/Plan 新建会话 → 核对 config.toml 写入且新会话生效；
    6. 维护面板「检查更新」→ 核对读取 `updates/latest.json` 的版本比对；一键升级 → 核对 install.ps1 重跑与服务重启；
    7. 数据目录清理 sessions → 核对目录与 session_index.jsonl 清空、启动器列表归零；
    8. 诊断打包 → 核对桌面 ZIP 内含 app.log/doctor.txt/会话导出；
    9. 环境页填固定端口 58630 重启 → 核对服务实际监听 58630 且窗口加载正常；
    10. 触发一次 401（如错误密钥）→ 核对认证错误排查卡片弹出且每次启动只弹一次。
14. v0.8.0 真实服务核对清单（单元测试已过，真实环境待核）：
    1. CLI 升级 0.28+ 且多开 `kimi web` → 核对托盘「多实例」子菜单列出 instances/ 各实例（端口/版本/存活），点击切换后窗口加载新实例且 WS 重连成功；
    2. 切换到一个非本应用启动的实例 → 核对 server.token 是否跨实例有效（无效时应报错回退）；
    3. 本机 0.27 环境 → 核对子菜单回退显示 server/lock 单实例且标注「当前」；
    4. 设置中心「IDE 接入」→ 核对 acp 可用性探测与本机 Zed/JetBrains 检测结果；Zed「一键写入」后在 Zed 内确认 kimi-code agent 可用；
    5. 维护页「自动安装更新」开关 → 核对 tui.toml `[upgrade].auto_install` 写入且 doctor 校验通过；
    6. 环境页勾选两个强制开关保存 → 核对子进程 env 含 `KIMI_CODE_NO_AUTO_UPDATE=1`/`KIMI_DISABLE_TELEMETRY=1` 且服务自动重启；
    7. 构造假 `~/.kimi`（含 bin/）→ 核对迁移提示弹出、「不再提示」持久去重且保存设置后不复现。
15. v0.9.0 真实服务核对清单（单元测试已过，真实环境待核）：
    1. 帮助菜单「Prompt 模板库…」「命令与快捷键速查…」（F1）→ 核对窗口打开、复制按钮写入剪贴板；
    2. 会话启动器详情「导出 Markdown」→ 核对保存的 .md 含完整对话轮次与工具调用摘要，损坏行/旧格式会话给出明确错误而非崩溃；
    3. 详情「任务监视」→ 核对含子 Agent 的会话卡片时间线、tasks 区、刷新按钮；
    4. 新建会话选择 home 根目录 → 核对敏感目录警告弹出且取消后中止创建；
    5. 环境页勾选「调试模式」保存重启 → 核对 CLI 以 `--log-level debug --debug-endpoints` 启动、维护相关入口可抓到 `/api/v1/debug/` 响应；
    6. 会话菜单「局域网访问…」→ 一键开启后核对服务监听 0.0.0.0、二维码与 URL 可被手机扫码连通（token 生效）；
    7. 环境页填临时模型（name+apiKey）保存重启 → 核对 `KIMI_MODEL_*` 注入且新会话默认走临时供应商；
    8. 设置中心「插件」页 → 与真实 `plugins/managed/` + installed.json 对账，启停切换后 `/plugins list` 状态一致；
    9. 填 pluginMarketplaceUrl/oauthHost/selfHostedBaseUrl → 核对子进程 env 注入（`KIMI_CODE_PLUGIN_MARKETPLACE_URL` 等）。
16. v0.10.0 真实服务核对清单：
    1. 菜单「会话→原生聊天原型（ACP 实验）…」开窗 → 核对 initialize 握手成功与状态条就绪（agentInfo/sessionId 显示）；
    2. 发一条 prompt → 核对流式正文渲染、思考折叠区、`stopReason` 返回后输入框恢复可用；
    3. 连续多轮 prompt → 核对同一 ACP session 内上下文延续；
    4. 触发一次工具调用（如让 agent 创建文件）→ 核对状态栏提示权限已自动取消，且无任何文件被创建；
    5. 关闭窗口后 → 任务管理器核对无残留 `kimi.exe acp` 子进程；
    6. 系统亮/暗主题切换 → 逐窗口目检官方风格（设置中心/会话启动器/问答窗/模板库/速查窗/局域网/子 Agent 监视/loading）。
17. v0.11.0 真实服务核对清单：
    1. 触发一次需审批的工具调用（如让 agent 创建文件）→ 核对原生审批窗弹出且工具详情（命令/路径等）展示正确；
    2. 点「允许一次」→ 核对放行且文件真实创建；
    3. 重新触发后点「拒绝」→ 核对阻断且无文件落盘；
    4. 点「始终允许」→ 核对后续同类操作不再询问；
    5. 分别按 Esc 与直接关窗 → 核对均为取消且 agent 收到 cancelled；
    6. 模拟权限窗创建失败 → 核对回退系统对话框；
    7. 工具调用全程 → 核对聊天窗工具卡片状态 pending→completed 流转；
    8. 关闭聊天窗后 → 任务管理器核对无残留 `kimi.exe acp` 子进程。
18. v0.12.0 真实服务核对清单：
    1. 启动器「原生聊天」恢复有历史的会话 → 核对本地历史渲染完整且可续聊；
    2. 恢复后切模型/模式 → 核对下拉回显与 agent 行为变化；
    3. 切到已生效的模式（如 plan 会话再切 plan）→ 核对错误提示不崩溃；
    4. busy 时点「停止」→ 核对生成中止且输入框恢复；
    5. 无 workDir 会话按钮禁用、敏感目录弹确认；
    6. 实验菜单新建会话 → 核对临时目录行为与 v0.11.0 一致（回归）；
    7. 关窗后 → 任务管理器核对无残留 `kimi.exe acp` 子进程。
19. v0.17.0 真实服务核对清单（注意：probe4 实测本机 CLI 0.27.0 虽声明 `promptCapabilities.image:true`，但图文 prompt 会致子进程崩溃（0xC0000409）或挂起无响应，见 docs/acp-probe4-output.txt；第 4、7 子项在 CLI 修复前预期失败，带图发送失败时聊天窗会引导走 Web UI）：
    1. 输入 `/` → 核对斜杠菜单弹出且随输入前缀过滤，键盘上下键 + Enter 与鼠标点击均可选中插入；
    2. 选中带 hint 的命令 → 核对命令按普通文本插入输入框、可继续补参数后发送；
    3. 发送斜杠命令 → 核对其作为普通文本 prompt 由 agent 执行且结果正常渲染；
    4. 点附件按钮选图 → 核对缩略图 chips 出现、发送后用户气泡内嵌图片预览；
    5. 一次多选图片 → 核对 ≤4 张全部入列、超过 4 张截断并提示；
    6. 选入超过 10MB 的图片 → 核对跳过并给出提示；
    7. 纯图片（无文字）发送 → 核对可正常发送且 agent 正确识别图片内容；
    8. 点状态条「Web UI」按钮 → 核对聚焦主窗并打开高级面板；
    9. 关闭聊天窗后 → 任务管理器核对无残留 `kimi.exe acp` 子进程。

---

## 6. 完成情况总览（截至 v0.17.0，2026-07-23）

### ✅ 已完成（42 项）

| 版本   | 功能                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| v0.2.0 | CLI 版本自动适配、双通道地址捕获、HTTP 就绪探测、优雅退出、重启互斥锁、日志脱敏、多实例感知                                    |
| v0.3.0 | 会话历史侧边栏、恢复指定会话、指定目录新建会话、导出 ZIP、会话可视化窗口                                                       |
| v0.4.0 | 首次启动向导、Git Bash 检测、设备码登录/登出、kimi doctor、代理设置、CLI 版本显示                                              |
| v0.5.0 | WS 订阅、审批通知、结构化问答原生窗口（全类型）、任务完成通知、托盘用量/进度、全局热键、外链接管（http/mailto/tel/编辑器协议） |
| v0.6.0 | config.toml GUI、权限规则编辑器、供应商管理器、MCP 配置 GUI、保存后自动 doctor 校验                                            |
| v0.7.0 | 会话归档/删除管理器（能力自适应）、认证错误 FAQ 引导、Skills 面板、Hooks 编辑器、模型切换下拉、新会话权限模式、维护面板（检查更新/一键升级/数据目录清理/诊断打包）、高级启动参数（端口/host/日志级别/KIMI_CODE_HOME）、令牌轮换 |
| v0.8.0 | 多实例管理面板、旧版 kimi-cli 迁移提示、IDE 一键接入向导、自动更新/遥测开关                  |

### ✅ 已发布（v0.9.0 11 项 + v0.10.0 + v0.11.0 + v0.12.0 + v0.17.0）

| 版本    | 功能                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| v0.9.0  | prompt 模板库、命令与快捷键速查窗（F1）、敏感目录启动警告、调试模式开关（debug-endpoints）、Markdown 导出会话、子 Agent 任务监视器、局域网/手机访问模式（二维码）、插件管理面板、自定义 marketplace 注入、临时模型快速测试（KIMI_MODEL_*）、自建端点支持 |
| v0.10.0 | ACP 只读原型聊天窗（实验菜单入口、临时目录只读会话、权限自动取消、流式正文+思考折叠、渲染节流）、全窗口 kimi.com 官方风格翻新（kimi-theme.css 共享令牌、亮/暗主题与窗口背景色跟随系统） |
| v0.11.0 | ACP 原生审批弹窗（原生模态审批窗、once/always 语义按钮组、Esc/关窗取消、创建失败回退系统对话框、失焦通知+任务栏闪框）、工具调用卡片渲染（pending→in_progress→completed/failed 状态流转、折叠详情与输出摘要） |
| v0.12.0 | ACP 原生聊天真实会话化（真实工作目录启动、启动器「原生聊天」入口、session/load 历史恢复 + 本地 wire.jsonl 自绘最近 50 条、configOptions 原生切换栏、停止生成按钮）、第三次 ACP 探测（session/load、set_config_option、session/list、session/cancel 实测结论） |
| v0.17.0 | ACP 斜杠命令菜单（available_commands_update 全量转发、'/' 前缀过滤弹窗、键盘/鼠标选中插入、命令作为普通文本 prompt 由 agent 执行）、ACP 图片输入（系统选图→base64 图片块随 prompt 发送、png/jpeg/gif/webp 白名单、单张 ≤10MB、一次 ≤4 张、缩略图 chips 与气泡预览、CSP 放行 img-src data:）、WebView 降级入口（状态条「Web UI」按钮聚焦主窗高级面板）、第四次 ACP 探测（scripts/acp-probe4.js 图片往返） |

### 🔲 部分实现（2 项）

| 功能          | 已完成                                                     | 未完成                  |
| ------------- | ---------------------------------------------------------- | ----------------------- |
| 外部链接接管  | http(s)/mailto/tel/vscode/cursor/windsurf/zed 等编辑器协议 | 自定义 Open-in 协议接管 |
| WS 端到端验证 | mock 服务器全场景自动验证通过                              | 真实服务端人工核对待做  |

### ⬜ 未实现（长期方向，0 项）

（完全原生聊天 UI 已随 v0.17.0 完成真实会话化、会话恢复与全部渐进替代项（斜杠命令菜单/图片输入/WebView 降级入口），见 §3 P2。）

### 统计

| 分类           | 已完成       | 部分实现    | 未实现       |
| -------------- | ------------ | ----------- | ------------ |
| P0 高价值      | 26           | 2           | 0            |
| P1 中价值      | 16           | 0           | 0            |
| P2 低价值/长期 | 15（✅ 已发布） | 0        | 0            |
| **合计** | **57** | **2** | **0** |

---

## 7. ACP 调研结论（阶段6 前置，2026-07-22）

> 探测脚本 `scripts/acp-probe.js`（纯 Node，双分帧自动探测），实测日志 `docs/acp-probe-output.txt`，完整报告 `docs/acp-research.md`。本机 CLI 0.27.0 实测。

**实测结果**：`kimi acp` 以 **ndjson 分帧**首发握手成功（initialize 往返 612ms，LSP 回退未触发）；`initialize → session/new → session/prompt` 全链路走通，`stopReason: end_turn`，stdout 全程无脏输出，可当纯协议通道。initialize 能力含 `sessionCapabilities.{list,resume}`（会话启动器可直接受益）与 `loadSession:true`；`session/new` 返回模型/thinking/权限模式三件套 `configOptions`；session/update 实测事件：`available_commands_update`、`agent_thought_chunk`（极碎，UI 需节流合并）、`agent_message_chunk`。

**未验证项**：`session/request_permission` 与 `tool_call` 字段级形态（本次纯文本 prompt 未触发工具）、`session/set_config_option` 写入侧、客户端 `fs/terminal:true` 承接、Content-Length 回退路径。第二次探测用「创建文件」类 prompt 复跑即可覆盖审批形态。

**路线建议**（详见 docs/acp-research.md §3）：v0.10.0 只读原型窗口（3-5 天）→ v0.11.0 审批弹窗原生化（2-3 天）→ v0.12.0 已落地真实会话化/恢复/切换栏/停止；v0.17.0 补齐斜杠命令菜单·图片输入·WebView 降级入口，原生聊天渐进替代项清零。ACP 相对 REST+WS 的核心价值：审批/问答作为 server→client 请求天然带响应通道，桌面端可实现真正的原生审批回复（当前 WS 路线仅通知不含回复）。
