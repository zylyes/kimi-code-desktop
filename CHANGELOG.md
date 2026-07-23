# Changelog

## [0.12.0] - 2026-07-23

### 新功能

- **ACP 原生聊天真实会话化**：`acp-chat:start` 支持 `{cwd, sessionId}`；真实工作目录启动（路径非法回退临时目录）；菜单项改名「原生聊天（新会话）…」。
- **历史会话恢复**：会话启动器详情新增「原生聊天」按钮（无 workDir 的会话禁用并提示；敏感目录弹确认）；恢复 = `session/load` 接续 agent 上下文 + 本地 wire.jsonl 自绘最近 50 条历史（双保险：若 agent 重放则跳过本地历史）；聊天窗标题栏显示会话名与工作目录、窗口标题动态化；load 失败明确报错不静默回退新建。
- **configOptions 原生切换栏**：聊天窗状态条下新增模型/思考/权限模式三下拉（缺项自动隐藏）；切换走 `session/set_config_option`，`config_option_update` 通知幂等回显，失败回滚并提示；仅就绪且非在途时可操作。
- **停止生成按钮**：busy 时发送键变「停止」，走 `session/cancel` 通知。
- **第三次 ACP 探测**：新增 `scripts/acp-probe3.js` 与 `docs/acp-probe3-output.txt`（786 行），`docs/acp-research.md` 追加第三次探测小节。实测结论：`session/load` 存在（参数 `{sessionId,cwd,mcpServers:[]}`，响应仅含 configOptions，实测无历史重放）、`session/set_config_option` 可用（字符串 value，响应与 `config_option_update` 通知均带完整 configOptions，失败 -32603，改动不跨 load 持久）、`session/list` 存在（条目 sessionId/cwd/title/updatedAt + nextCursor）、`session/cancel` 生效（prompt 以 stopReason:cancelled 返回）。

### 其他

- `acp-client.js` 新增 `loadSession()`/`setConfigOption()`/`cancel()`；新增 `user-chunk` 事件转发（agent 侧用户消息重放兜底）。
- `test-acp-client.js` 新增 `loadSession`/`setConfigOption`/`cancel` 对应单测（全部通过）。
- 无破坏性变更。

## [0.11.0] - 2026-07-23

### 新功能

- **ACP 原生审批弹窗**：`session/request_permission` 接入原生模态审批窗（options 的 once/always 语义映射按钮组，详情区展示命令/路径等工具上下文，Esc/关窗即取消；窗口创建失败回退系统对话框；聊天窗失焦时系统通知 + 任务栏闪框）。
- **ACP 工具调用卡片**：`tool_call`/`tool_call_update` 渲染为状态流转卡片（pending→in_progress→completed/failed，折叠详情与输出摘要）。

### 其他

- `acp-client.js` 新增 `setPermissionHandler` 异步权限决策（未设 handler 保持自动取消安全基线）。
- 新增权限窗三件套 `permission.html`/`permission.js`/`permission-preload.js` 与新 IPC 通道 `acp-permission:init`（主→渲染）、`acp-permission:respond`（渲染→主 invoke）。
- `acp-chat:event` 新增 `tool-call`/`tool-call-update`/`permission-pending`/`permission-resolved` 四类 payload，移除 `permission-auto-cancel`。
- `test-acp-client.js` 扩展权限决策回环断言。
- 第二次 ACP 探测产物 `docs/acp-probe2-output.txt` 与 `docs/acp-research.md` 补充。
- 打包清单（build.files）登记 permission 三件套。
- 无破坏性变更。

## [0.10.0] - 2026-07-23

### 新功能

- **ACP 原生聊天只读原型窗（实验）**：菜单「会话→原生聊天原型（ACP 实验）…」打开；主进程经新模块 `acp-client.js` 直连 `kimi acp`，initialize → session/new → 流式 prompt 全链路；会话落在系统临时目录（mkdtemp）实现只读隔离；权限请求一律自动取消（仅状态栏提示）；渲染层流式正文 + 思考折叠区 + 渲染节流；`stopReason` 回传后输入框恢复。
- **全部原生窗口翻新为 kimi.com 官方设计语言**：新增共享样式 `kimi-theme.css`（设计令牌），设置中心/会话启动器/问答窗/模板库/速查窗/局域网/子 Agent 监视/loading 等原生页面统一接入；亮/暗主题跟随系统，各窗口 `backgroundColor` 经 `windowBackground()` 跟随 `nativeTheme`。

### 其他

- 新增 `acp-client.js`（ACP stdio JSON-RPC 客户端：start/newSession/prompt/dispose，update/permission/stderr/exit/raw 事件）与 `chat.html`/`chat.js`/`chat-preload.js` 原型窗前端。
- 新增 IPC 通道：`acp-chat:start`、`acp-chat:prompt`（渲染→主 invoke）；新增主→渲染事件 `acp-chat:event`（status/message-chunk/thought-chunk/commands/permission-auto-cancel/prompt-done）。
- main.js 新增 `showAcpChatWindow()`/`disposeAcpClient()`/`sendAcpEvent()`/`windowBackground()`；5 处窗口背景色统一改走 `windowBackground()`；before-quit 增加 ACP 客户端清理。
- 打包清单（build.files）登记 `kimi-theme.css`、`acp-client.js`、`chat.html`、`chat.js`、`chat-preload.js`。
- 无破坏性变更。

## [0.9.0] - 2026-07-23

### 新功能

- **新手 prompt 模板库**：帮助菜单新增「Prompt 模板库…」，按帮助中心五大场景（实现新功能/修复 bug/理解项目/自动化/通用任务）内置 15 条工程实践示例 prompt，一键复制（clipboard API + execCommand 回退）。
- **命令与快捷键速查**：帮助菜单新增「命令与快捷键速查…」（F1），内置斜杠命令六组分类表 + TUI 快捷键 + 桌面端快捷键清单，内容已核对官方文档。
- **敏感目录启动警告**：会话启动器新建会话时，工作目录为 home 根/盘符根/含 `.ssh`/`.gnupg`/等于 KIMI_CODE_HOME 的，先弹警告对话框（继续/取消）。
- **调试模式开关**：环境页「高级」新增 debugMode，启用后新版 CLI 以 `--log-level debug --debug-endpoints` 启动（覆盖 logLevel，旧版忽略并记日志）；新增 `debug:fetchEndpoints` IPC 抓取 `/api/v1/debug/`。
- **Markdown 导出会话**：会话启动器详情面板新增「导出 Markdown」，只读解析 `agents/main/wire.jsonl`（损坏行跳过、think 部件排除、无 append_message 时回退 turn.prompt），保存对话框写出 .md。
- **子 Agent 任务监视器**：详情面板新增「任务监视」，新窗口按时间线渲染 `agents/*/wire.jsonl` 各 Agent 卡片（消息/事件数、起止时间、事件类型 chips）与 `tasks/` 后台任务，支持手动刷新。
- **局域网/手机访问模式**：会话菜单新增「局域网访问…」窗口——未开启时一键写 `host=0.0.0.0` 并重启；开启后展示各网卡访问 URL（含 token）与二维码（新增 `qrcode` 依赖），顶部醒目安全警示（token 即凭证、严禁叠加 `--dangerous-bypass-auth`）。
- **自定义 marketplace 注入**：环境页新增 pluginMarketplaceUrl → `KIMI_CODE_PLUGIN_MARKETPLACE_URL`。
- **临时模型快速测试**：环境页「临时模型」分组（name/apiKey/providerType/baseUrl/displayName/maxContextSize/capabilities/thinkingEffort），注入 `KIMI_MODEL_*` 进程级环境变量合成临时供应商，不写 config.toml。
- **自建端点支持**：环境页新增 oauthHost/selfHostedBaseUrl → `KIMI_CODE_OAUTH_HOST`/`KIMI_CODE_BASE_URL`。
- **插件管理面板**：设置中心新增第 10 个标签页「插件」，扫描 `plugins/managed/<id>/` 清单（kimi.plugin.json 优先，.kimi-plugin/plugin.json 回退）并合并 installed.json 启用状态（映射/数组/`{plugins}` 三形态自适应）；能定位条目时支持启用/禁用写回（.bak 备份），否则标注用 `/plugins` 命令管理。

### 其他

- 新增 `session-export.js`（readJsonl/extractMessages/renderMarkdown/exportSessionMarkdown/scanSubagents）与 `plugins-manager.js`（listPlugins/setPluginEnabled/normalizeInstalled/readManifest）。
- 新增 IPC 通道：`session:exportMarkdown`、`session:scanSubagents`（sessionDir 限 sessions 根内）、`plugins:list`、`plugins:setEnabled`、`debug:fetchEndpoints`、`system:lanInfo`、`system:lanEnable`、`app:openAgentsMonitor`；preload 新增 8 个桥接方法。
- 新窗口：prompts.html、help.html、agents.html、lan.html（单例工厂 `makeSingletonWindow`，监视器可多开）。
- config.json 新增 `debugMode`/`pluginMarketplaceUrl`/`oauthHost`/`selfHostedBaseUrl`/`tempModel` 字段；app:info 与 setup:save 白名单同步登记。
- `buildKimiEnv` 新增 `KIMI_MODEL_*` 八变量、marketplace、OAuth 主机、Base URL 条件注入。
- 新增 `test-session-export.js`（8 组断言）与 `test-plugins-manager.js`（9 组 48 条断言）；六个测试文件全绿。
- 打包清单（build.files）登记两个新模块与四个新页面；dependencies 新增 `qrcode@^1.5.4`。
- 新增 `scripts/acp-probe.js`（ACP 协议探测，ndjson 分帧首发握手成功）与 `docs/acp-research.md` 调研报告，详见 FEATURE-IDEAS.md §7。
- 无破坏性变更。

## [0.8.0] - 2026-07-22

### 新功能

- **多实例管理面板**：托盘新增「多实例」子菜单；扫描 `~/.kimi-code/server/instances/`（0.28+ 新版格式，防御性解析），目录不存在时回退读取 `server/lock`（0.27 旧版格式）；子菜单显示各实例端口/版本/存活状态/当前连接标记，点击实例先 HTTP probe 校验可达、再重读 server.token，复用令牌轮换的 WS 断连重建序列完成窗口连接切换；列表 10 秒缓存防抖自动刷新，另提供「重新扫描」手动强制刷新；已退出实例置灰展示。
- **旧版 kimi-cli 迁移提示**：启动时检测 `~/.kimi/` 存在且含 `bin/` 或 `config.toml` 时弹出三按钮对话框「立即迁移 / 稍后 / 不再提示」；「立即迁移」打开外部终端窗口运行 `kimi migrate`；「不再提示」写入 config.json `legacyMigrationDismissed` 持久去重，且保存设置时该标志不丢失。
- **IDE 一键接入向导**：设置中心新增第 9 个标签页「IDE 接入」，帮助菜单新增「IDE 接入向导…」入口（showSetup 支持 tab 定位，setup.html 解析 `?tab=ide`）；先探测 `kimi acp` 子命令可用性（不可用时提示升级 CLI）；Zed 卡片支持一键写入 `agent_servers` 配置（JSONC 剥注释/尾逗号后合并，写前 `.bak` 备份，解析失败回退展示片段 + 复制按钮）；JetBrains 卡片检测已装 IDE 并给出手动配置步骤文本（强调必须绝对路径）+ 复制；通用 ACP 片段卡片适配其它客户端。
- **自动更新/遥测开关**：维护标签页新增「自动安装更新」checkbox，读写 tui.toml `[upgrade].auto_install`（保存走 `kimi doctor` 校验 + 失败回滚）；环境页新增「禁止 CLI 自动更新」「禁用遥测」两个强制级开关，写入 config.json 的 `noAutoUpdate`/`disableTelemetry` 并向子进程 env 注入 `KIMI_CODE_NO_AUTO_UPDATE=1`/`KIMI_DISABLE_TELEMETRY=1`（保存后自动重启服务生效）。

### 其他

- 新增 `instances-manager.js`：`scanInstances`/`checkPidAlive`/`probeInstance`；新增 `ide-integration.js`：`detectAcp`/`detectEditors`/`buildZedSnippet`/`applyZedConfig`/`stripJsonc`/`buildGenericSnippet`/`buildJetBrainsGuide`。
- 新增 IPC 通道：`instances:list`、`instances:switch`、`ide:detect`、`ide:applyZed`、`ide:getSnippet`；preload 新增桥接方法：`instancesList`/`instancesSwitch`/`ideDetect`/`ideApplyZed`/`ideGetSnippet`。
- config.json 新增 `noAutoUpdate`/`disableTelemetry`/`legacyMigrationDismissed` 字段；`buildKimiEnv` 新增两个条件注入。
- 新增 `test-instances-manager.js`（6 项断言）与 `test-ide-integration.js`（19 项断言，含 JSONC 字符串内 `//` 不误删边界）；四个测试文件全绿。
- 打包清单（build.files）登记 `instances-manager.js`、`ide-integration.js`。
- 无破坏性变更。

## [0.7.0] - 2026-07-22

### 新功能

- **会话归档/删除管理器**：会话启动器详情面板新增「归档」「删除」按钮；启动时解析 `/openapi.json` paths 自动探测服务端能力（`:archive` 自定义动词 / `/archive` 子路径 / `DELETE` 三种形态自适应），不支持的端点按钮禁用；删除前先归档降低误删损失；订阅 WS `event.session.deleted` 自动刷新列表。
- **认证错误识别与 FAQ 引导**：CLI 输出与 WebSocket 关闭/错误中识别 401/认证失败关键字（每次启动只弹一次），弹出排查卡片（api.kimi.com 与 api.moonshot.cn 密钥不通用、设备授权 30 天过期、模型 ID 静默回退等），可一键跳转重新登录。
- **Skills 管理面板**：设置中心新增 Skills 标签页，扫描用户级 `~/.kimi-code/skills/` 与 `extra_skill_dirs`（只读标注来源），解析 SKILL.md frontmatter，支持新建/编辑/重命名/删除用户级技能。
- **Hooks 可视化编辑器**：设置中心新增 Hooks 标签页，按官方文档内置 16 个事件清单与用途提示，编辑 `[[hooks]]`（event/matcher/command/timeout），提供拦截 rm -rf、任务完成通知、附加 Git 分支、Bash 审计日志 4 个模板，保存走 doctor 校验回滚。
- **模型切换下拉**：托盘菜单与「会话」菜单新增「默认模型」单选子菜单，模型列表取自 `GET /api/v1/models`（失败回退双档模型 + 当前配置），切换写入 config.toml 并可选择立即重启生效；订阅 `event.model_catalog.changed` 自动刷新。
- **新会话权限模式选择**：会话启动器新建按钮旁新增权限模式下拉与 Plan 复选（默认「保持当前配置」），选择后先写 config.toml 再创建会话。
- **维护面板**：设置中心新增维护标签页——CLI 检查更新（读 `updates/latest.json` 比对版本）与一键升级（重跑官方 install.ps1，成功后自动重启）；数据目录体积统计与勾选清理（sessions/logs/bin/updates/server，凭据受保护）；诊断打包（app.log + doctor 输出 + 最近会话导出，PowerShell Compress-Archive 生成 ZIP）。
- **高级启动参数**：环境页新增固定端口 `--port`、监听地址 `--host`、日志级别 `--log-level`、自定义 `KIMI_CODE_HOME` 四项设置（仅新版 CLI 生效，旧版自动忽略并记日志）；KIMI_CODE_HOME 在应用启动最早期注入，全进程统一生效。
- **令牌轮换**：「会话」菜单新增「轮换访问令牌…」，调用 `kimi web rotate-token` 后重读 server.token、重载窗口并重建 WS 订阅。

### 改进

- `session:createSessionInDirectory` 支持可选权限模式参数，写入失败时中止创建并提示。
- `skills-manager.deleteSkill` 对不存在的用户级目录显式报错，防止误删 extra 只读技能。
- mock 服务器扩展：`:archive`/`DELETE`/`/api/v1/models` 端点与 `session.deleted` 事件推送（`/control/emit` scenario 与 `/mock/push/session-deleted` 双触发），openapi.json paths 同步补齐。

### 其他

- 新增 `skills-manager.js`：frontmatter 简易解析、目录扫描、用户级技能读写删（路径包含校验防越权）。
- 新增 IPC 通道：`session:archiveSession`、`session:deleteSession`、`session:getCaps`、`skills:list`、`skills:save`、`skills:delete`、`cli:checkUpdate`、`cli:upgrade`、`system:dataDirStats`、`system:cleanupDataDirs`、`system:packDiagnostics`；新增主→渲染事件 `session:changed`。
- 新增 `httpRequest()` 通用 REST 辅助与 `buildSessionActionUrl()` 路径模板替换（`{param}` → 会话 ID）。
- config.json 新增 `port`/`host`/`logLevel`/`kimiCodeHome` 字段，`setup:save` 完整持久化（端口范围校验）。
- 新增 `test-skills-manager.js` 单元测试（8 项断言全过）；能力探测逻辑已对 mock 实弹验证通过。
- 打包清单补齐 `skills-manager.js`。
- 无破坏性变更。

## [0.6.0] - 2026-07-22

### 新功能

- **图形化设置中心**：设置页（setup.html）新增标签页导航，集成 config.toml / 权限规则 / 供应商管理 / MCP 服务器四大配置面板。
- **config.toml GUI 化**：支持编辑 `default_model`、`default_permission_mode`（manual/yolo/auto）、`default_plan_mode`、`telemetry` 开关，以及 `[thinking]` / `[loop_control]` 参数；保存前自动调用 `kimi doctor` 校验，失败时回滚原文件。
- **权限规则编辑器**：可视化增删改 `[[permission.rules]]`，支持 decision（allow/deny/ask）、pattern、scope，提供"拒绝 rm -rf"与"敏感文件 ask"安全预设。
- **供应商与模型管理器**：调用 `kimi provider list --json` 展示供应商列表，支持删除供应商与通过向导添加 catalog 供应商（覆盖 6 种 provider 类型）。
- **MCP 服务器配置 GUI**：读写用户级 `~/.kimi-code/mcp.json`，支持 stdio/http/sse 三种接入方式、命令/URL、环境变量与启停工具列表。

### 改进

- 新增 `config-manager.js` 配置管理模块：统一读写 `config.toml`、`tui.toml`、`mcp.json`，写入前备份、doctor 校验、失败回滚。
- `package.json` 打包清单补齐 `config-manager.js`，并新增 `@iarna/toml` 依赖。
- 新增 IPC 通道：`config:loadConfigToml`、`config:saveConfigToml`、`config:loadTuiToml`、`config:saveTuiToml`、`config:loadMcpJson`、`config:saveMcpJson`、`config:listProviders`、`config:removeProvider`、`config:addProviderCatalog`。

### 其他

- TOML 解析使用 `@iarna/toml`，支持完整的 parse/stringify。
- `runDoctor` 在 Windows 上对非 `.exe` CLI 路径自动启用 `shell: true`，提高兼容性。
- 新增 `test-config-manager.js` 单元测试，覆盖空配置加载、TOML 解析、保存备份、失败回滚、MCP JSON 读写。
- 无破坏性变更。

## [0.5.0] - 2026-07-22

### 新功能

- **原生问答窗口全类型接管**：`event.question.requested` 统一由原生问答窗口（question.html）处理，支持单选、多选、多题与自定义输入（allow_other）；主进程接线 `question:submit`/`question:fallback`/`question:cancel` IPC 提交答案，原 `dialog` 弹窗仅作窗口创建失败时的回退。
- **托盘用量/任务进度显示**：订阅 WS `event.session.usage_updated` 与 `event.task.started/progress/completed` 事件，托盘 tooltip 与菜单状态项实时展示 token 用量、上下文占用与任务进度，更新带防抖。
- **编辑器协议接管**：外部链接白名单新增 `vscode`、`cursor`、`windsurf`、`zed` 等编辑器协议，走系统默认程序打开，Web UI 的 Open in Editor 类按钮可用。
- **mock 验证基建**：新增 `scripts/mock-kimi-server.js`（默认端口 58999，固定 token `mock-token`），自动覆盖 client_hello/订阅/问答/审批/用量/任务事件验证，`npm run mock` 一键启动。
- **测试钩子**：支持 `KIMI_DESKTOP_TEST_BASE`、`KIMI_DESKTOP_TEST_TOKEN` 环境变量覆盖服务地址与 token，便于对接 mock 服务做自动化测试。

### 改进

- 打包清单补齐 `question.html`、`question.js`、`question-preload.js`，修复打包后问答窗口文件缺失问题。

### 其他

- 新增 IPC 通道：`question:submit`、`question:fallback`、`question:cancel`（渲染→主 invoke）；新增主→渲染事件：`question:init`、`question:dismiss`。
- 答案提交：`POST /api/v1/sessions/{sid}/questions/{qid}`，三种形态 `{kind:'single', option_id}` / `{kind:'multi', option_ids, other_text?}` / `{kind:'other', text}`；HTTP 2xx 且响应 `code` 为 0 或缺失判定成功。
- 用量字段容错解析（`total_tokens|totalTokens`、`input_tokens`、`output_tokens`、`context_used`、`context_limit`），托盘菜单新增禁用态状态项展示。
- 无破坏性变更。

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

### 其他

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

### 其他

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

### 其他

- 新增 `getCliVersion()`、`readServerToken()`、`checkMultiInstances()`、`httpGet()`、`httpPostShutdown()`、`waitForProcessExit()`、`forceKill()`、`stopKimi()`、`startPolling()`、`restartServer()` 等函数。
- 新增 `cliVersionCache`、`stoppingIntentionally`、`beforeQuitInProgress`、`knownServerBase`、`knownServerToken`、`serverGeneration`、`restartPromise` 等状态变量。
- 引入 `http` 模块用于 HTTP 请求，`execFileSync` 用于 CLI 版本探测。
- 日志模块新增多层正则替换脱敏逻辑。

[0.1.0] - 初始版本

- 基础 Electron 套壳，spawn `kimi web --no-open --foreground` 并捕获 stdout 地址。
- 系统托盘常驻、窗口状态持久化、设置页（手动/自动/在线安装）。
- 快捷键、菜单栏、外部链接拦截。