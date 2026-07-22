# Kimi Code Desktop 功能建议报告

> 调研来源：Kimi Code 官方文档（https://www.kimi.com/code/docs/kimi-code-cli/ ）10 个板块精读，
> 覆盖 kimi 命令参考、会话管理、配置系统、平台与模型、扩展能力（Skills/插件/MCP/Hooks）、
> 交互模式与权限、IDE/ACP 集成、Web UI、帮助中心最佳实践。
> 调研日期：2026-07-21。本项目当前版本：Electron 套壳，仅做 `kimi web` 进程管理 + 托盘 + 配置持久化。

## 状态图例

| 标记 | 含义 |
|------|------|
| ✅ 已发布 | 代码已合入并随对应版本发布 |
| 🔶 工作区已实现 | 代码完成于当前工作区，待提交/发布 |
| 🔲 部分实现 | 基本功能可用，部分场景回退或受限 |
| ⬜ 未实现 | 尚未开发 |

### 当前实现总览

| 阶段 | 状态 | 核心内容 |
|------|------|----------|
| 阶段1 | ✅ v0.2.0 | CLI 版本适配层 |
| 阶段2 | ✅ v0.3.0 | 会话启动器 |
| 阶段3 | ✅ v0.4.0 | 新手引导 |
| 阶段4 | 🔶 工作区已实现 | WS 通知、原生问答、托盘用量、全局热键、外链接管 |
| 阶段5 | ⬜ 未实现 | 图形化设置中心 |
| 阶段6 | ⬜ 未实现 | ACP 原生 UI |

---

## 0. 紧急：CLI 版本适配层（文档揭示的破坏性变化）

> ✅ **v0.2.0 已实现**（2026-07-21）

官方文档（0.28+）与本机实测 CLI（0.27.0）存在**机制性差异**，现有代码可能随 CLI 升级而失效：

| 差异点 | 旧版（本机 0.27.0） | 新版（官方文档 0.28+） |
|---|---|---|
| 服务命令 | `kimi server run`（守护进程）+ legacy 锁 `~/.kimi-code/server/lock` | `kimi server` 树**整体废弃**（退出码 1），仅 `kimi server kill` 保留用于清理旧进程 |
| 前台运行 | `kimi web --foreground`（我们当前用法） | `kimi web` **默认前台**运行，`--foreground` 不再出现在文档中 |
| 无客户端退出 | 60 秒无连接自动退出（`--keep-alive` 控制） | 文档未提，需实测 |
| 多实例 | 单实例锁文件 | 多实例注册到 `~/.kimi-code/server/instances/`，端口被占自动 +1 |
| 默认端口 | 5494（Python 旧版）/ 58627 | 58627（被占自动 58628、58629…） |

**✅ 已实现**：
1. ✅ 启动前跑 `kimi --version` 探测版本，按版本选择启动命令、flag 组合与 URL 捕获策略；
2. ✅ URL 捕获从"正则解析 stdout"升级为**双通道**：直接读 `~/.kimi-code/server.token` 拼 `http://127.0.0.1:<port>/#token=<token>`，stdout 正则仅作兜底；
3. ✅ 就绪探测改为 **HTTP 轮询**：捕获端口后轮询 `GET /openapi.json` 直到 200 再加载窗口，消除时序竞争导致的白屏；
4. ✅ 退出时先 `POST /api/v1/shutdown` 或发 SIGTERM 并等待，超时再强杀，避免会话数据写损。

---

## 1. 高价值功能（P0）

### 1.1 会话管理（让套壳变成"启动器"）✅ **v0.3.0 已实现**

| 功能 | 文档依据 | 实现思路 |
|---|---|---|
| ✅ 原生历史会话侧边栏（标题/工作目录/更新时间） | `~/.kimi-code/session_index.jsonl` 每行含 `sessionId/sessionDir/workDir`；各会话 `state.json` 含标题、`lastPrompt`、时间 | 只读解析索引文件，渲染会话列表 |
| ✅ 一键继续最近会话 / 恢复指定会话 | `kimi --continue`、`kimi --session <id>` | 列表点击后 spawn 对应命令（注意 `-c` 与 `-S` 互斥） |
| ✅ 在指定目录新建会话 | Web UI URL 参数 `?action=create-in-dir&workDir=<path>`（旧版文档，新版需实测）；REST `POST /api/v1/sessions` | 目录选择器 + 深链导航或 REST 创建 |
| ✅ 导出会话为 ZIP | `kimi export <sessionId> -o <path> -y [--no-include-global-log]` | Electron 保存对话框 + spawn 子命令 |
| ✅ 会话可视化窗口 | `kimi vis [sessionId] --no-open` 打印访问地址 | 复用现有"spawn + 捕获地址 + 窗口加载"架构，零新范式 |
| 会话归档/删除管理器 | REST `:archive` 动作；WS `event.session.deleted`；Web UI 超 15 天自动归档 | 原生面板调 REST 动作 |

### 1.2 审批与通知（桌面壳的独特价值）

| 功能 | 文档依据 | 实现思路 |
|---|---|---|
| 🔶 审批请求 → 系统原生通知（仅通知，不含原生回复） | WS `event.approval.requested/resolved/expired`；REST `/sessions/{id}/approvals/{approval_id}` | 已连接 WebSocket 订阅审批事件，窗口失焦时弹系统通知 + 任务栏闪烁，点击聚焦窗口；尚不支持原生回复审批 |
| 🔲 结构化问答 → 原生弹窗（单题/单选已支持） | WS `event.question.requested`；REST `/sessions/{id}/questions/*` | 监听问题事件用原生 dialog 展示，目前仅支持单题、单选、无自定义输入；多题、多选、允许自定义输入时回退 Web UI |
| 🔶 任务完成 → 桌面通知 | Hooks `Notification`(task.completed) / `SubagentStop` 事件；tui.toml `[notifications]` 已有此概念 | 已通过 WS 事件订阅实现，窗口失焦时弹原生通知 |
| 🔶 托盘显示 token 用量/任务进度 | WS `event.session.usage_updated`、`event.task.*` | 托盘 tooltip/角标展示；已订阅 usage_updated/task.*，托盘 tooltip+菜单状态项展示 |

### 1.3 新手引导（帮助中心最高频痛点）✅ **v0.4.0 已实现**

| 功能 | 文档依据 | 实现思路 |
|---|---|---|
| ✅ 首次启动向导：Git Bash 检测 → CLI 安装 → 登录 → 选工作目录 | getting-started：Windows 必须先装 Git for Windows；preparation 页整页新手扫盲 | 向导页串联现有安装流程 |
| ✅ 登录引导（设备码流程可视化） | `kimi login` 子命令：验证地址+用户码打印到 stderr，轮询授权，退出码 0/1 | spawn `kimi login`，解析 stderr 展示链接/二维码/用户码，自动打开浏览器 |
| ✅ 登录状态检测与登出 | 凭证存 `~/.kimi-code/credentials/<name>.json`（0700/0600）；无 `kimi logout` 子命令，删文件即登出 | 启动时检查 credentials/ 目录 |
| ✅ Git Bash 自检 + `KIMI_SHELL_PATH` 注入 | 非标准路径 Git 需设 `KIMI_SHELL_PATH` 为 bash.exe 绝对路径 | 探测常见路径，失败弹引导，config.json 支持自定义 |
| ✅ `kimi doctor` 配置体检入口 | `kimi doctor [config\|tui] [path]` 校验配置，退出码 0/1 | 菜单项 + 结果弹窗 |
| ✅ 网络自检与代理设置 | 支持 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`（含 SOCKS）/`NO_PROXY`；api.kimi.com/api.moonshot.cn 不可被代理拦截 | 启动前探测两个 API 域；设置页代理表单注入子进程 env |
| 认证错误识别与 FAQ 引导 | api.kimi.com 与 api.moonshot.cn 密钥**不通用**（高频坑）；设备 30 天未用授权过期；高速版无权限返回 401 且填错模型 ID **静默回退**不报错 | 监听子进程输出中的 401/认证失败关键字，弹对应排查卡片 |
| CLI 版本显示 + 一键升级 | `kimi --version`；`kimi upgrade` 对 Windows native 只打印手动命令；`~/.kimi-code/updates/latest.json` 存最新版信息 | 关于页显示版本；有新版时重跑 `install.ps1` 完成升级 |

### 1.4 图形化设置面板（config.toml GUI 化）

| 功能 | 文档依据 | 实现思路 |
|---|---|---|
| 设置面板编辑核心配置 | config.toml 全字段：`default_model`、`default_permission_mode`(manual/yolo/auto)、`default_plan_mode`、`telemetry`、`[thinking]`、`[loop_control]` | TOML 解析库读写 `~/.kimi-code/config.toml` |
| 权限规则编辑器 + 安全预设 | `[[permission.rules]]`：decision(allow/deny/ask) + pattern（如 `Bash(rm -rf*)`）+ scope | 规则列表 UI + 模板（"拒绝 rm -rf"、"敏感文件 ask"），配合 YOLO/Auto 使用 |
| 供应商与模型管理器 | `kimi provider list --json` / `remove` / `catalog add`；6 种 provider 类型（kimi/anthropic/openai/openai_responses/google-genai/vertexai） | GUI 列表 + 添加向导（models.dev 目录浏览，填 key 一键导入） |
| 保存后自动 `kimi doctor` 校验 | 退出码语义 | 每次代写配置后校验，失败提示且不覆盖原文件 |

---

## 2. 中价值功能（P1）

| 功能 | 文档依据 | 实现思路 |
|---|---|---|
| 多实例管理面板 | 实例注册到 `~/.kimi-code/server/instances/`；`kimi server ps`（0.27）/ `/api/v1/connections` | 读目录列出存活实例，托盘切换/重连，避免重复起进程 |
| 自定义 `KIMI_CODE_HOME`（多环境隔离/便携模式） | 环境变量可整体搬迁数据根 | config.json 加字段，spawn 注入 env |
| 令牌轮换菜单 | `kimi web rotate-token`：旧 token 立即失效，运行中实例自动换用 | 菜单项调子命令后按新 `server.token` 重载 URL |
| 固定端口 / `--host` / `--log-level` 设置 | `kimi web --port/--host/--allowed-host/--log-level` | config.json 扩展字段拼启动参数 |
| 旧版 kimi-cli 迁移提示 | 检测 `~/.kimi/` 自动提示；`kimi migrate` 交互迁移（幂等，不删旧数据） | 首次启动检测后引导 |
| Skills 管理面板 | 四档扫描目录（项目 > 用户 > extra > 内置）；SKILL.md + YAML frontmatter；`extra_skill_dirs` | 扫描目录解析 frontmatter，GUI 新建/编辑/删除 |
| MCP 服务器配置 GUI | 两层 `mcp.json`（用户级 `~/.kimi-code/mcp.json` + 项目级）；stdio/HTTP/SSE 三种接入；`enabledTools`/`disabledTools` 等字段 | 表单读写 mcp.json |
| Hooks 可视化编辑器 + 模板库 | `[[hooks]]` 四字段（event/matcher/command/timeout）；16 个事件；退出码 0 放行 / 2 阻断 | 生成配置条目 + 预置脚本模板 |
| IDE 一键接入向导 | Zed：`agent_servers` JSON 片段；JetBrains：Configure ACP agents（**必须绝对路径**）；`kimi acp` stdio JSON-RPC | 检测已装编辑器，自动写入/生成配置片段（桌面应用已知 cliPath） |
| 🔶 全局唤起热键（Ctrl+Shift+Space） | — | 已注册 Electron `globalShortcut`，Ctrl+Shift+Space 显示/隐藏窗口 |
| 🔲 外部链接接管（http(s)/mailto/tel 已实现） | Web UI 外链与 Open in Terminal/VS Code 依赖浏览器协议处理 | 已通过 `setWindowOpenHandler` 拦截，外部 http(s)、mailto/tel 走系统浏览器，同源本地 Kimi 页面留在 WebView，未知协议拒绝；自定义 Open-in 协议接管未实现 |
| 新会话权限模式选择（Plan/YOLO/Auto） | `default_permission_mode`/`default_plan_mode`（注意：`kimi web` **不接受** `--yolo/--plan` flag，只能写 config.toml） | 新建会话前写入配置 |
| 模型切换下拉 | `/models/*` REST 路由；WS `event.model_catalog.changed`；双档模型 `kimi-for-coding` / `kimi-for-coding-highspeed` | 托盘/菜单下拉切换 `default_model` |
| 诊断打包（一键问题反馈） | `kimi export -y` 打包会话 ZIP 含诊断日志 | 导出 ZIP + 桌面端 app.log 打包 |
| 数据目录管理器（占用/清理） | 官方清理矩阵：sessions/+session_index.jsonl（清会话）、logs/、bin/（rg/fd 缓存）、updates/latest.json | 展示各子目录体积 + 勾选清理（二次确认） |
| 自动更新/遥测开关 | tui.toml `[upgrade].auto_install`；`KIMI_CODE_NO_AUTO_UPDATE=1`；`telemetry`/`KIMI_DISABLE_TELEMETRY` | 设置页开关写配置或注入 env |

---

## 3. 低价值 / 长期方向（P2）

| 功能 | 说明 |
|---|---|
| 完全原生聊天 UI（去 WebView 化） | 两条协议路线：① REST+WS（`GET /openapi.json` + `GET /asyncapi.json` 自描述文档，`/api/v1/ws` 收发）；② ACP 客户端（spawn `kimi acp`，stdio JSON-RPC，`session/prompt` + `session/update` 流式推送，原生渲染审批弹窗）。ACP 路线更适合桌面端，但工程量大，建议分阶段 |
| 局域网/手机访问模式 | `--host 0.0.0.0` + token 鉴权，展示二维码；明示**不要**叠加 `--dangerous-bypass-auth`（该 flag 会关闭全部鉴权，任何能访问端口的人可完全控制文件系统和 shell） |
| 子 Agent 任务监视器 | 解析会话目录 `agents/<id>/wire.jsonl` 与 `tasks/` 渲染时间线侧栏 |
| Markdown 导出会话 | `/export-md` 无非交互 CLI 等价物，需自行解析 `wire.jsonl` 渲染 |
| 插件管理器 | 读 `$KIMI_CODE_HOME/plugins/managed/` + `installed.json` 展示；安装/启停需注入斜杠命令或待 REST 端点确认 |
| 调试模式开关 | `--log-level debug --debug-endpoints`，日志页展示 `/api/v1/debug/*` |
| 新手 prompt 模板库 | 帮助中心五大场景（新功能/修 bug/理解项目/自动化/通用任务）内置示例，一键复制 |
| 敏感目录启动警告 | 工作目录选在 home 根/.ssh 同级时弹安全提示（官方安全建议） |
| 命令与快捷键速查帮助窗 | 内置静态清单页（斜杠命令 ~40 个 + 快捷键全表） |
| 自定义 marketplace 注入 | `KIMI_CODE_PLUGIN_MARKETPLACE_URL` env 注入 |
| 临时模型快速测试 | `KIMI_MODEL_*` 13 个环境变量在内存合成临时供应商，重启失效 |
| 自建端点支持 | `KIMI_CODE_OAUTH_HOST` / `KIMI_CODE_BASE_URL` 高级设置 |

---

## 4. 建议实施路线

**阶段 1（加固，1-2 天）**：版本适配层 + server.token 直读 + HTTP 就绪探测 + 优雅退出 + 多实例感知 ✅ **v0.2.0 已实现**
**阶段 2（会话启动器，2-3 天）**：会话侧边栏（session_index.jsonl）+ 继续/恢复会话 + 导出 ZIP + kimi vis 窗口 ✅ **v0.3.0 已实现**
**阶段 3（新手体验，2-3 天）**：首次启动向导（Git Bash 检测/安装/登录）+ 版本显示与升级 + doctor 体检 + 代理设置 ✅ **v0.4.0 已实现**
**阶段 4（原生增强，3-5 天）**：WS 连接 → 审批/问答/完成原生通知 + 托盘用量显示 + 全局热键 + 外链接管 → 🔶 **工作区已实现，待提交/发布**
**阶段 5（设置中心，3-5 天）**：config.toml 图形化 + 权限规则编辑器 + 供应商管理器 + MCP/Skills/Hooks 面板
**阶段 6（长期）**：ACP 客户端原生 UI，渐进替代 WebView

### 阶段 4 实现分项详情

| 子项 | 状态 | 说明 |
|------|------|------|
| WS 连接与订阅 | 🔶 已实现 | 使用 `kimi-code.bearer.<token>` 子协议，支持 `client_hello`、会话订阅与断线重连 |
| 审批原生通知 | 🔶 已实现 | 窗口失焦时弹系统通知 + 任务栏闪烁；不含原生审批回复 |
| 结构化问答原生弹窗 | 🔶 已实现 | 全类型走原生问答窗口，dialog 仅作回退 |
| 任务完成桌面通知 | 🔶 已实现 | 通过 WS 事件触发原生通知 |
| 全局热键 | 🔶 已实现 | Ctrl+Shift+Space 全局显示/隐藏窗口 |
| 外部链接接管 | 🔲 部分实现 | http(s)、mailto/tel 已接管；vscode/cursor/zed 等编辑器协议已接管；同源 Kimi 页面留在 WebView；未知协议拒绝；自定义 Open-in 协议未实现 |
| 托盘用量/进度 | 🔶 已实现 | 托盘 tooltip/角标展示 token 用量与任务进度 |
| 复杂问答原生输入 | 🔶 已实现 | 多题多选、自定义输入的原生界面 |
| WS 端到端验证 | 🔶 mock 已验证 | mock 全场景通过：client_hello 握手/订阅、用量（12.3k tokens·上下文 35%）、任务 started/progress/completed 计数归零、审批计数、单题/多选/多题问答开窗、answered 释放与 dismiss 关窗、答案提交契约（answers map + method:'click'，多选与多题含 GUI 真实提交落盘）；聚焦回退分支已补日志。真实服务端人工核对待做（见 §5 第 12 条） |

> **注意**：package.json 已升至 0.5.0，阶段4增强已完成于工作区、待提交/发布。阶段1—3 仍为标记版本（v0.2.0/v0.3.0/v0.4.0）已完成。阶段5 与其他未标注完成项目仍未实现。

---

## 5. 需实测验证的存疑点

1. `kimi web` 新版是否仍接受 `--foreground` / `--keep-alive` flag（当前代码依赖）——跑 `kimi web --help` 确认；
2. Web UI 是否保留 `?action=create-in-dir&workDir=` 深链参数（旧版文档）——决定"指定目录新建会话"能否纯 URL 实现；
3. REST/WS 完整端点清单——启动服务后抓 `http://127.0.0.1:<port>/openapi.json` 与 `/asyncapi.json`（带 bearer token）；
4. `POST /api/v1/shutdown` 在新版是否保留（文档仅在 legacy `kimi server kill` 处提及）；
5. `~/.kimi-code/server/instances/` 文件格式（多实例面板依赖）；
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
