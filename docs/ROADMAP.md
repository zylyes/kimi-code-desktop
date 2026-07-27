# Kimi Code Desktop 下一步规划（v1.1.0 → v1.3.0）

> 本文档为纯规划文档（2026-07-27 制定，同日基于六路文档核对结果全量修订）。
> 依据：Kimi Code 官方文档（https://www.kimi.com/code/docs/ ，全量 39 篇中文文档，CLI 文档基线 0.29.1 / 2026-07-24）、ACP 探测记录（scripts/acp-probe3.js、probe4.js，CLI 0.27.0 四次探测）、.qoder/repowiki 与代码现状（模块地图已逐文件核实）。
> 文档抓取全覆盖：官方中文站 39 篇文档全部读到原文，kimi-docs-md（39 篇 Markdown + 索引）+ kimi-docs（全站 HTML 镜像）双层验证；2026-07-27 与线上构建资产 hash 比对一致（本地快照与线上为同一次部署）。注：`other/产品概览.md` 抓取损坏（仅 3 行 JS 片段），其内容实际分散在 01-overview 七篇中，不影响结论。
> 未能取得的内容：仅「逐档位额度细表」（pricing 页 JS 渲染）一点；「VS Code 扩展对 TS CLI 开放时间」于 2026-07-27 线上复核仍未开放，降级为持续监控项（见 §7-12）。

---

## 0. 背景判断：三个决定性事实

1. **CLI 已完成 Python→Node 重写，旧版 EOL**。文档首页明示"旧版将不再维护"（迁移页原文"旧版将逐渐停止维护"）；changelog 已至 0.29.1（2026-07-24）。本项目开发机仍是 CLI 0.27.0——0.25.0 的两项安全修复（bearer token 校验绕过、会话文件越权）0.27.0 已经包含，真正的问题是落后当前基线 4 个版本，缺少 0.28/0.29 大量行为变更（`kimi server` 废弃、ACP 免终端登录凭据、思考强度切换）与后续修复。
2. **ACP 已从"实验"变成官方一等公民**。官方 `kimi acp` 参考页给出完整方法矩阵（稳定面 agent-side 10/12 + client-side reverse-RPC 4/9 + 不稳定面 `session/set_model`），SDK 版本 `@agentclientprotocol/sdk@0.23.0`。IDE 集成（Zed/JetBrains/Paseo）统一走 ACP；0.28.1 起 ACP 会话可用非 OAuth 凭据免终端登录；0.29.0 起支持思考强度切换。项目的 v1.0.0 原生聊天路线与官方方向一致，但协议面只实现了约 60%。
3. **官方 VS Code 扩展存在但处于过渡期**：`moonshot-ai.kimi-code` 目前仅对旧版 Python CLI 用户开放新增安装，TS 版 CLI 用户暂不可装。07-vscode 全部 4 篇文档页首逐字明示此限制（2026-07-27 线上复核无变化）。这是桌面端的窗口期，也是中期风险——桌面端应把重心放在扩展做不了的事上：CLI 安装/登录/升级/诊断管家、多 IDE 配置、多实例与数据管理、原生审批/问答/Goal 面板，而非与扩展比拼聊天 UI 花哨度。旁证：扩展底层同样跑 CLI（`kimi.executablePath` 配置项），且官方明示其模型列表刷新需"重启 VS Code 或重装插件"——CLI 生命周期管理确是官方未覆盖的空白。

---

## 三轨战略定位

项目实际承载三条并行的用户路径，规划需为每条路径定义各自的演进目标：

| 轨道 | 定位 | 当前状态 | v1.3.0 目标 |
| --- | --- | --- | --- |
| **WebView 轨道** | 官方 `kimi web`（含设置面板/调试工具）的 Electron 壳 | 完整（v1.0.0 主窗 WebView + 设置中心独立窗） | 维持可用；深链参数追踪；设置中心 schema 对齐 |
| **ACP 原生聊天轨道** | 自建 ACP 协议客户端，原生审批/问答/Goal 面板 | 协议覆盖约 60%，聊天窗纯文本 | 协议补齐 → 主界面级体验（Markdown/plan/Goal） |
| **桌面管家轨道** | 安装/登录/升级/诊断/数据管理/多 IDE 配置 | 启动器+托盘+向导基础可用 | 完整管家面板（销毁/回收站/用量/错误引导 + 登录/令牌/导出/反馈官方通道接入） |

三条轨道共享：托盘生命周期管理、CLI 版本检测与适配层、IPC 通信总线。轨道间通过 URL scheme（主窗 `?reason=` 跳转设置中心）和托盘菜单解耦。

---

## 1. 差距分析（文档能力 × 项目现状）

### 1.1 模型图谱

官方现提供 4 个 Model ID，本项目设置中心仅预置 `kimi-for-coding` 一个预设：

| Model ID | 模型版本 | 上下文 | 思考强度 | 调用门槛 | 多模态 |
| --- | --- | --- | --- | --- | --- |
| `k3` | Kimi K3（2.8T 参数） | 最高 1M（Allegretto+）/ 256K（Moderato） | low / high / max（默认 high） | Moderato+ | 图片、视频 |
| `k3-256k` | Kimi K3 | 256K | low / high / max（默认 high） | Moderato+ | 仅图片 |
| `kimi-for-coding` | Kimi K2.7 Code | 256K | Thinking:ON（必须开启） | 所有会员 | 图片、视频 |
| `kimi-for-coding-highspeed` | K2.7 Code HighSpeed | 256K | Thinking:ON（必须开启） | Allegretto+ | 图片、视频 |

> **注意**：K3 的 effort 映射不同于通用 effort 枚举——`null`/`undefined`→`high`，`ultra`/`max`/`xhigh`→`max`，`high`/`medium`→`high`（官方推荐档），`low`/`minimum`/`light`→`low`，`none`→关闭 thinking（thinking.type disabled），**其它未知取值→直接 HTTP 400 报错**（非静默兜底——设置中心做 effort 输入校验时必须拦截非法值）。K3/K2.7 Code 关闭 thinking 会被路由到 K2.6。**切换模型与切换思考强度都会使上下文缓存失效**（官方建议同一会话内保持 effort 一致，确需切换则新建会话）。高速版输出速度约普通版 5–6 倍、额度消耗约 3 倍；模型 ID 填错会**静默兜底到标准版 `kimi-for-coding`**（不报错也不加速），且工具/脚本耗时占比大时整体提速不明显。k3(1M) 消耗约为 k3-256k 两倍；k3↔k3-256k 互切注意：上下文已超 256K 时需先手动 compact 再切，历史含视频时切 k3-256k 会直接报错（k3-256k 不支持视频），反向切换不影响缓存。第三方工具使用 K3 需手动把上下文窗口字段配为 `1048576` 才能用满 1M。模型目录是动态的（API Key 用户自动拉取最新模型列表；列表未出现新模型时 `/logout` 后重新 `/login` 刷新）——硬编码预设可能滞后，UI 应标注。

### 1.2 综合差距表

| 领域 | 官方文档能力（0.29.x） | 项目现状（v1.0.0） | 差距 |
| --- | --- | --- | --- |
| CLI 适配 | `kimi web` 前台唯一模式（v0.28.0 破坏性变更，`kimi server` 废弃；`kimi web kill/ps` 移除于 0.28.1）、`--no-open`、端口自动 +1、server.token（Web UI 经 URL `#token=` 片段自动鉴权、`kimi web rotate-token` 轮换后旧 token 立即失效且运行中实例自动换用、令牌关闭标签页后最长保留 7 天）、instances/ 注册、`/openapi.json` + `/asyncapi.json` 双 schema；`kimi server kill` 被保留为清理 0.28 之前遗留后台服务的唯一合法例外 | 适配层按 0.27/0.28 双轨写成 | 未在 0.29.x 真实回归；`--foreground` / `kimi server` 旧路径死代码待清（注意 `kimi server kill` 的合法保留用途不可误删），见 P0-1 |
| ACP 协议 | 稳定面 agent-side 10/12（含 `session/set_mode`、`session/set_config_option`）+ client 反向 RPC 4/9 + 不稳定面 `session/set_model`(1/19)；load 回放历史、resume 轻量恢复、authenticate(-32000)、fs 读写路由、plan/config_option_update/available_commands_update 推送、`embeddedContext` + `resource`/`resource_link` 内容块（对应 TUI `@` 文件引用）、`mcpServers` 经 session/new/session/load 转发（http/stdio/sse 转换，`acp` 传输丢弃写 warn）、`promptCapabilities.image=true`（base64+mimeType，未声明视频能力）、SDK 0.23.0 | acp-client.js 实现 6 个方法；无 list/resume/authenticate/set_model/set_mode；main.js 未转发 plan/config_option_update/available_commands_update；fs/terminal 有意关闭 | 协议覆盖约 60%，见 P0-3 |
| 会话管理 | session/list 枚举磁盘会话（经 `sessionCapabilities.list = {}` 公告；title/updatedAt/cursor 字段系 ACP 规范定义、官方文档页未展开，以 P0-2③ 实测为准）；CLI 无删除能力（GitHub issue #1926 空白）；/fork、/compact、/export-debug-zip、/export-md | 启动器走 REST + 本地索引解析；有归档/删除（REST） | ACP 路线下列表信息可更全；删除可填补官方空白 |
| 配置系统 | config.toml 大幅扩编：`[tools]` enabled/disabled、`[thinking]` enabled/effort(模型相关映射)/keep、`[secondary_model]`（实验，需 `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`）、`[subagent]` timeout_ms（默认 7200000ms）、`[mcp]` startup_timeout_ms/tool_timeout_ms、`[image]` max_edge_px（默认 2000）/read_byte_budget（默认 256KB）、`[background]` 8 字段、`[loop_control]` reserved_context_size、`[services]` moonshot_search/fetch、models.overrides 子表、provider 6 类型（含 openai_responses）+ env/oauth/custom_headers、权限规则 scope(四枚举)/reason、`default_permission_mode`、顶层 `telemetry`、项目级 `.kimi-code/local.toml` | 设置中心 schema 为旧版，收集 24 个字段，多个新版区块完全缺失 | schema 落后一代，见 P0-5 |
| 权限控制 | manual/yolo/auto + plan 叠加（`default_plan_mode`）；规则 scope=turn-override/session-runtime/project/user（默认 user）+ reason、按顺序匹配第一条命中即生效；审批面板数字键直选、Ctrl-E 展开 diff；Auto 模式计划退出自动批准标 "Auto-approved"；YOLO 下敏感文件（.env/SSH 私钥）仍询问 | ACP 审批窗 v0.11.0（once/always/Esc）；规则编辑器无 scope/reason | 规则编辑器字段缺失；审批窗无 diff 预览 |
| 交互/问答 | AskUserQuestion 经 ACP request_permission 与工具审批共用通道到达（官方文档仅确认通道共用；1–4 题/2–4 选项/multi_select 的 schema 数字出自项目 v0.5.0 自有实现与 ACP 规范，官方快照无出处，字段形态以 P0-2⑥ 实测为准） | 原生问答窗仅服务 WS 路线；ACP 聊天内问答按普通审批窗处理 | ACP 问答未接原生问答窗，见 P1-3 |
| Goal 模式 | /goal 全生命周期（status/pause/resume/cancel/replace + /goal next、/goal next manage）+ 预算 + 退出码 0/3/6；恢复即 paused；模型/供应商/运行时错误亦置 paused；blocked 时 Agent 写简短原因消息 | 完全未支持 | 全新能力空白，见 P1-4 |
| Skills | 四档目录（project>user>extra>builtin + ~/.agents/skills）、扁平 .md 格式、frontmatter 6 字段（name/description 目录型必填 + type/whenToUse/disableModelInvocation/arguments，含连字符别名）、占位符全集（`$ARGUMENTS`/`$ARGUMENTS[i]`/`$0`/`$1`/`$<name>`/`${KIMI_SKILL_DIR}`/无占位符时尾部自动追加 ARGUMENTS）、嵌套最多 3 层 | 面板仅扫用户级 + extra_skill_dirs，只认目录型 SKILL.md，仅解析 2 字段（name/description） | 扫描档位与解析字段不足，见 P1-5 |
| 自定义 Agents | **五档作用域（显式 --agent-file > 项目 > 额外 > 用户 > 内置——注意 extra > user，与 Skills 的 user > extra 恰好相反）** + frontmatter 8 字段（name 可选/description 必填/whenToUse/tools/disallowedTools/subagents/override/model_preference）、Markdown 定义 + `${base_prompt}` 占位符、SYSTEM.md（kimi web/实验性 kimi -p）、AGENTS.md 指令文件 | 无管理面板（只有子 Agent 运行监视器） | 新面板，见 P1-5 |
| Hooks | 16 事件，与项目模板一致；插件可声明 hooks；timeout 1–600s 默认 30s；JSON 阻断模板；Interrupt 替代 Stop；仅 PreToolUse/Stop/UserPromptSubmit 三个可阻断事件，其余观察型；退出码非 0/2 与超时均 fail-open 放行 | 基本对齐（16 事件、4 模板） | 仅增值项（timeout 校验提示、JSON 阻断模板、Interrupt/Stop 互斥说明、fail-open 与可阻断事件标注），P2 |
| 插件 | manifest 完整文档化；仅用户级安装（暂不支持项目级）；变更需 `/reload` 或新会话生效；移除只删记录、managed/ 副本残留；marketplace version "2" JSON；GitHub URL 四种格式安装；trust 三档徽章；`<plugin>:<cmd>` 命名空间命令 | 面板三形态自适应已实现 | 详情视图/marketplace 浏览/kimi.plugin.json 优先解析未做，P2 |
| Themes | ~/.kimi-code/themes/*.json，**19** 个颜色 token（文档表列 dark/light 默认双色值；**自定义主题文件每 token 只写一个色值**，另靠可选 `base` 字段（dark 默认/light）决定未写 token 继承哪套调色板），文件名即主题名；/theme 命令实时扫描；/reload-tui 重载；官方 `/custom-theme` skill 交互式创建 | 未支持 | 低垂果实，P2 |
| MCP | toolTimeoutMs、enabled、disabledTools、transport sse、OAuth（/mcp-config login）、项目级 .kimi-code/mcp.json（同名条目覆盖）、超时优先级链（server 字段 > env `KIMI_MCP_*` > config `[mcp]` > 内置默认 30000/60000ms） | GUI 已有 enabledTools/bearerTokenEnvVar/startupTimeoutMs | 字段小补齐 + 项目级编辑 + toolTimeoutMs/disabledTools，P2 |
| IDE 集成 | Zed（type:"custom" 片段，`agent_servers` 层 MCP 会经 ACP 转发到 kimi 侧）、JetBrains（必须绝对路径；无 AI 订阅时注册表 `llm.enable.mock.response` 可启用面板）、Paseo（第三个 ACP 客户端，`command` 数组形式）；macOS PATH 陷阱 | 向导 v0.8.0（Zed 自动写入/JetBrains 指引） | 片段逐字段核对 + Paseo 配置卡，P2 |
| 模型/供应商 | 6 种供应商类型（含 openai_responses、vertexai）；KIMI_MODEL_* 全家族 **15** 个环境变量（模型定义通道 11 个：NAME/API_KEY/PROVIDER_TYPE/BASE_URL/MAX_CONTEXT_SIZE/CAPABILITIES/DISPLAY_NAME/MAX_OUTPUT_SIZE/REASONING_KEY/THINKING_EFFORT/ADAPTIVE_THINKING；运行时开关 5 个：TEMPERATURE/TOP_P/MAX_COMPLETION_TOKENS/THINKING_EFFORT/THINKING_KEEP——THINKING_EFFORT 两表重合）；/provider 交互式管理器 + `kimi provider` 子命令组；models.overrides 子表 | 设置中心仅预置 kimi-for-coding；供应商面板基础可用；KIMI_MODEL_* 注入面板缺少运行时开关系列 | 补齐 P0-5 |
| 会员/错误 | 档位 Moderato/Allegretto；7 天周额度 + 5h 滚动窗 + 月共享（与 Kimi 网页端共享）；加油包（单次最低 25 RMB、**每日最多 10 次且累计 3,000 RMB**、余额 10,000 RMB 上限、不过期）；错误码全表（401 六种/402 一种/403 两种/**429 四种**/400 六种/**404 两种**/**500 五种**/**工具错误五种**，共 31 条目、33 条快速查找关键词）；设备与配额（所有设备/API Key 共享配额、30 天未活跃设备自动解绑） | 认证 FAQ 引导为旧知识；托盘只有 token 用量 | 错误引导库需对齐（见 P1-6）；用量三层展示 P2 |
| Web UI | 仍存在（kimi web 同进程挂载）；v0.22.0 新设计系统；审批通知（v0.23.4）；`#token=` 片段自动鉴权、令牌最长保留 7 天；?action=create-in-dir 深链未在新文档出现 | 主窗 WebView 路线完整 | 深链参数待实测（§7-9） |

---

## 2. 下一阶段总体目标

**把基线从"旧版 CLI 兼容层"切换到"新版 Node CLI（0.28+）原生对接"，并把 ACP 原生聊天从"可用"提升到"主界面级体验"，同时让设置中心追平新版配置 schema。**

具体化为三个可验证的终点：
1. 开发/发布基线 = CLI 0.28+（实测 0.29.x），旧版路径标注 legacy 并给出升级引导。
2. ACP 客户端覆盖官方稳定面全部对桌面有意义的方法（list/resume/authenticate/set_model/set_mode + plan/config_option_update/available_commands_update 推送），聊天窗具备 Markdown 渲染、plan 展示、原生问答、Goal 面板——WebView 仅作设置/高级面板与降级兜底。
3. 设置中心 schema 与 0.29.x 文档逐字段对齐（含 [tools]/thinking effort 按模型映射/权限 scope/供应商 6 类型/services/[secondary_model] 实验区/tui.toml schema 与 `kimi doctor tui` 校验），Skills/Agents/插件面板按新文档补齐。

版本节奏：**v1.1.0 = P0（基线切换）→ v1.2.0 = P1（体验升级）→ v1.3.0 = P2（差异化增强）**。

---

## 3. P0 任务清单（基线切换，全部进 v1.1.0）

### P0-1 CLI 0.29.x 升级与全量真实回归
- **用户价值**：所有已发布功能在新版 CLI 上确认可用；消除"文档说新版行为不同但没人实测过"的累积风险（0.25.0 安全修复 0.27.0 已包含，升级目的是追平 0.28+ 行为变更与后续修复）。
- **实现要点**：开发机升级 CLI 到最新（install.ps1 重跑）；编写回归脚本核对表共 **14 组**：①启动、②登录、③WebView 加载、④WS 通知、⑤审批通道、⑥问答通道、⑦会话管理、⑧配置读写（原 8 组）；⑨`kimi login` 设备码非交互登录（RFC 8628、Ctrl-C 可取消、退出码 0/1、token 与 TUI `/login` 同一本地位置）；⑩令牌机制（`#token=` 片段注入、`kimi web rotate-token` 轮换后旧 token 立即失效且运行中实例自动换用、令牌 7 天保留）；⑪双 schema 端点（`/openapi.json` 与 `/asyncapi.json`）可用性；⑫Windows 前置检测（Git for Windows/`KIMI_SHELL_PATH`、Node.js ≥ 22.19.0、**Windows native 安装无法自动升级、仅打印手动更新命令**——升级管家行为边界）；⑬`kimi doctor tui [path]` 与 `kimi server kill`（清理 0.28 之前遗留后台服务）；⑭启动参数与代理（flag 冲突规则：`-p` 与 `--yolo/--auto/--plan` 互斥且固定 auto 权限、`-r`/`--resume`=`--session`；HTTP(S)_PROXY/ALL_PROXY/NO_PROXY 含 SOCKS、回环地址始终绕过）。版本适配层（`src/main/main.js:273` 版本检测）把 0.28+ 设为支持基线，0.27 及以下弹"CLI 过旧且不再维护"引导卡；清理 `--foreground` / `kimi server` 相关死路径（v0.28.0 破坏性变更；`kimi server kill` 清理旧版遗留的用途保留）；确认启动参数使用 `kimi web --no-open`（桌面端不需要 CLI 代开浏览器）。
- **涉及文件**：`src/main/main.js`（版本检测 L273、子进程 L531、就绪探测 L708）、`src/main/cli-adapter.js`、`scripts/dev-verify.js`。
- **验收标准**：14 组核对清单在 0.29.x 上全过或有明确结论（失败项转成 bug 或 §7 待核实项）；`npm start` 全流程（启动→就绪→加载→WS→审批/问答通知）通过。
- **风险与依赖**：升级可能暴露行为差异（如 WS 事件字段变化）——这正是本任务的目的；依赖用户本机完成 OAuth 登录。无代码依赖，最先做。

### P0-2 ACP 第五次探测（对新 CLI）
- **用户价值**：后续所有 ACP 功能设计的实测依据，避免按 0.27 探测结论（已过时）做错误设计——例如 0.27 上 session/load 不回放历史，官方文档写新版会回放；0.29.0 ACP 新增思考强度选择。
- **实现要点**：仿照 `scripts/acp-probe3.js`/`probe4.js` 写 `acp-probe5.js`，对新 CLI 实测 **14 项**：①session/load 加载**非活跃**历史会话是否回放（建 B 后 load A，并跨进程复测）；②session/resume 行为与 load 的确切差异；③session/list 字段与分页（title/updatedAt/cursor——字段出处为 ACP 规范，官方文档页未展开）；④未登录时 initialize/prompt 的 authRequired(-32000) 形态与 authenticate 的 method_id 参数；⑤thinking 在 ACP configOptions 的形态（effort 多档 vs 0.27 的单值 on）及 session/set_model 的 model 参数格式；⑥AskUserQuestion elicitation 经 request_permission 的字段形态（options 如何承载多题/multi_select/allow_other）；⑦plan/config_option_update/available_commands_update 推送形态（含下发范围——是否含 /goal、skill 命令、插件命令）；⑧图片输入是否修复（0.27 崩溃 0xC0000409，ACP 能力声明 image=true）；⑨发 `/goal` 文本观察 goal 相关 session/update 推送与预算进度通道；⑩hooks 在 ACP 会话中是否触发（附带验证）；⑪`session/set_mode` 与 `set_config_option({configId:'mode'})` 等价性实测（文档称走同一 dispatcher）；⑫新版是否另发 ACP 规范 `current_mode_update`（对照文档的 `config_option_update`）；⑬`embeddedContext`/resource 块与 `mcpServers` 转发的实测形态（http/stdio/sse 转换、`acp` 传输是否丢弃写 warn）；⑭`available_commands_update` 下发清单是否含 `/btw`、`/web`、`/reload`、`/undo`、`/title`、`/add-dir`、`/init`、`/experiments`、`/mcp`、`/custom-theme`、`/import-from-cc-codex`、`/update-config`、`/check-kimi-code-docs`。产出：重建 `docs/acp-research.md`（旧文件已在工作区删除）+ `docs/acp-probe5-output.txt`。
- **涉及文件**：`scripts/acp-probe5.js`（新）、`docs/acp-research.md`（重建）、`docs/acp-probe5-output.txt`。
- **验收标准**：探测退出码 0、stdout 0 段脏输出；上述 14 项每项都有实测结论（含"不存在/未实现"结论）；研究文档创建。
- **风险与依赖**：依赖 P0-1 的 CLI 升级；goal/elicitation 触发不保证成功（需设计诱导 prompt），失败则列入 §7。

### P0-3 acp-client 协议补齐（list / resume / authenticate / set_model / set_mode / 推送转发）
- **用户价值**：原生聊天获得官方完整会话语义——启动器列表更准（session/list）、恢复更快（resume 跳过回放）、未登录有明确引导（authenticate -32000 → 登录窗）、plan 模式可见（plan/config_option_update 推送）、模式切换走官方入口（set_mode）。
- **实现要点**：按 P0-2 结论在 `AcpClient` 增加 `listSessions(cursor)`（返回 session 数组 + nextCursor）、`resumeSession(id, cwd)`、`setModel(modelId)`、`setMode(modeId)`（稳定面"是"，plan 模式/权限模式切换官方入口，与 `set_config_option({configId:'mode'})` 同一 dispatcher）；initialize 失败或 prompt 遇 -32000 时上抛 `authRequired` 事件 → main.js 引导登录窗；`main.js` 的 update 转发补 `plan`、`config_option_update`、`available_commands_update`；评估 `embeddedContext`（桌面 `@` 文件注入）与 `mcpServers` 转发（GUI 的 MCP 配置随会话下发）的接入点，结论记入本任务验收；保持 `fs=false`/`terminal=false` 安全基线不变。
- **涉及文件**：`src/main/acp-client.js`、`src/main/main.js`（1858–2457 ACP 区）、`src/preload/chat-preload.js`、`tests/test-acp-client.js`（回环假服务端补新用例）。
- **验收标准**：单元测试覆盖新方法（含分页游标、authRequired、resume 语义、setMode）；真实 CLI 冒烟（`KIMI_ACP_SMOKE=1`）通过；embeddedContext/mcpServers 接入评估结论落文档。
- **风险与依赖**：依赖 P0-2 结论（字段形态）；resume 语义以实测为准，与官方文档"load 回放/resume 轻量恢复"不符时以实测为准并记入 §7。

### P0-4 会话启动器升级（ACP session/list + 会话删除）
- **用户价值**：列表标题/更新时间直接来自 CLI（比解析本地索引更准更全）；提供官方 CLI 没有的会话删除能力（GitHub issue #1926 确认的空白），桌面管家价值 +1。
- **实现要点**：启动器数据源增加 ACP `session/list` 通道（与现有 REST/本地索引三路归一，按 cwd 路径分隔符归一化匹配，倒序合并）；「原生聊天」恢复改用 `session/resume`（历史渲染暂保留本地 wire.jsonl 自绘，待 P0-2 结论①若回放可靠再切换为 load 回放渲染）；删除会话 = 停实例后删 `sessions/<key>/<id>/` 目录 + 剔除 session_index.jsonl 行（二次确认 + 回收站式 .trash 移动而非硬删）。定位依据：`workDirKey` 格式 `wd_<slug>_<sha256前12位>`、`session_index.jsonl` 行含 `sessionId`/`sessionDir`/`workDir`（数据路径页）；官方警告"sessions/ 目录下的文件请勿手动编辑"（会话与上下文页）——删除/.trash 设计以此为最高风险依据，操作必须可恢复。
- **涉及文件**：`src/main/main.js`（4513/4591 会话管理区）、`src/pages/sessions.html`（内嵌 JS）、`src/main/acp-client.js`。
- **验收标准**：列表与 `kimi` TUI `/sessions` 一致；删除后 TUI/Web UI/启动器三方不再出现该会话；误删可从 .trash 恢复。
- **风险与依赖**：依赖 P0-3；删目录属破坏性操作——必须二次确认 + 可恢复；REST 能力探测（archive/delete caps）逻辑保留作 Web 路线兜底。

### P0-5 设置中心 schema 对齐 0.29.x（第一波）
- **用户价值**：配置面板不再误导——新版字段可见可编，废弃字段有迁移提示；避免用户手改 TOML 出 doctor 错误。
- **实现要点**：
  - **新增区块**：`[tools]` enabled/disabled、`[thinking]` `enabled`（boolean 默认 true，旧键迁移目标）+ `effort`（注意：K3 映射 ≠ 通用枚举，UI 应展示可选值 `low`/`high`/`max` 并标注"K3 专属映射"提示；**非枚举值将导致 HTTP 400 而非回退，输入校验必须拦截**）+ `keep`（默认 `"all"`）、`[loop_control]` `reserved_context_size`、`[image]` `max_edge_px`（默认 2000）/`read_byte_budget`（默认 262144）、`[subagent]` `timeout_ms`（默认 7200000）、`[background]` 8 字段（`max_running_tasks`、`keep_alive_on_exit`、`kill_grace_period_ms`（默认 5000）、`bash_auto_background_on_timeout`（默认 true）、`bash_task_timeout_s`（默认 600，与 auto_background 成对展示）、`print_background_mode`（默认 `"steer"`）、`print_wait_ceiling_s`、`print_max_turns`）、`[services]` `moonshot_search`/`moonshot_fetch` 子表（各含 `base_url`/`api_key`/`oauth`/`custom_headers` 四字段；`KIMI_WEB_SEARCH_*`/`KIMI_WEB_FETCH_*` 环境变量覆盖，env 端点不发送文件内凭据）、`[secondary_model]`（标注实验性 + 需 `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`——桌面走 `kimi web` 必须注入此变量；`KIMI_CODE_EXPERIMENTAL_FLAG=1` 为 `kimi -p` 总开关，TUI 忽略）、`merge_all_available_skills`（默认 true）、`default_plan_mode`、`default_permission_mode`（默认 manual）、顶层 `telemetry`（默认 true，`KIMI_DISABLE_TELEMETRY` 关闭）；
  - **tui.toml 全 schema**：`theme`（默认 auto）/`disable_paste_burst`/`[editor].command`/`[notifications].enabled`+`notification_condition`/`[upgrade].auto_install`（与升级管家直接相关）；保存后改用 `kimi doctor tui <path>` 校验；
  - **供应商**：补齐 6 种类型（`kimi`/`anthropic`/`openai`/`openai_responses`/`google-genai`/`vertexai`），vertexai 的 `env` 子表（`GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`）；凭证键补 `VERTEXAI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS`（唯一走系统环境的例外）/`GOOGLE_GEMINI_BASE_URL`/`GOOGLE_VERTEX_BASE_URL`；OAuth/托管端点 `KIMI_CODE_OAUTH_HOST`（默认 `https://auth.kimi.com`）/`KIMI_CODE_BASE_URL`（默认 `https://api.kimi.com/coding/v1`，注意 ≠ `KIMI_BASE_URL`）；
  - **模型预设**：更新为 4 个 Model ID（k3/k3-256k/kimi-for-coding/kimi-for-coding-highspeed），标注各模型的门槛档位与 thinking 约束，并标注"模型目录动态、重新登录可刷新，预设可能滞后"；models 表字段群（`max_input_size`/`max_output_size`/`support_efforts`/`default_effort`/`off_effort`/`display_name`/`reasoning_key`/`adaptive_thinking`/模型级 `base_url`；overrides 子表**不接受** `provider`/`model`/`protocol`/`beta_api`/`base_url`）；`KIMI_SECONDARY_MODEL`/`KIMI_SECONDARY_EFFORT`（覆盖 `[secondary_model]`，优先级高于配置文件）；
  - **权限规则**：补 `scope`（四枚举，默认 `user`）与 `reason`；`AgentSwarm`、MCP 工具**和自定义工具**只按工具名匹配、不支持参数模式；规则**按顺序匹配、第一条命中即生效**（编辑器需提供排序语义）；
  - **KIMI_MODEL_\*** 注入面板按"定义通道 11 + 运行时开关 5"全家族 15 个补齐（运行时开关含 `KIMI_MODEL_TEMPERATURE`/`KIMI_MODEL_TOP_P`/`KIMI_MODEL_MAX_COMPLETION_TOKENS`/`KIMI_MODEL_THINKING_EFFORT`/`KIMI_MODEL_THINKING_KEEP`，另 `KIMI_MODEL_ADAPTIVE_THINKING` 属定义通道）；警示标注：`KIMI_MODEL_PROVIDER_TYPE` 仅支持 `kimi`/`anthropic`/`openai` 三种；`TEMPERATURE`/`TOP_P` 全局生效、不依赖 `KIMI_MODEL_NAME`；`MAX_COMPLETION_TOKENS` 仅 kimi 供应商；env 覆盖提示清单（`KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT`/`KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS`/`KIMI_IMAGE_MAX_EDGE_PX`/`KIMI_IMAGE_READ_BYTE_BUDGET`/`KIMI_SUBAGENT_TIMEOUT_MS`/`KIMI_MCP_STARTUP_TIMEOUT_MS`/`KIMI_MCP_TOOL_TIMEOUT_MS`/`KIMI_LOOP_MAX_STEPS_PER_TURN`/`KIMI_LOOP_MAX_RETRIES_PER_STEP`）；
  - **迁移逻辑**：检出 `default_thinking`/`thinking.mode` 旧键时提示自动迁移到 `[thinking]`（`thinking.budget` 无文档依据，不做）；检出 `kimi server` 路径时提示迁移到 `kimi web`；
  - **校验**：config.toml 保存后用 `kimi doctor config <path>` 精准校验；tui.toml 用 `kimi doctor tui`；tools 匹配三种永不匹配写法（`mcp__` 外用通配符、`mcp__github` 缺工具段、不存在的名字，区分大小写）做即时校验告警；
  - **项目级**：`.kimi-code/local.toml` `[workspace] additional_dir`（`/add-dir` 自动写入，建议 gitignore）。
- **涉及文件**：`src/main/config-manager.js`、`src/pages/setup.html`（内嵌 JS，当前 2210 行）、`src/main/main.js`（config:* IPC L3220、doctor L4054）。
- **验收标准**：新版全字段读写往返经 `kimi doctor config` 退出码 0；tui.toml 经 `kimi doctor tui` 通过；旧字段迁移路径有单测；vertexai env 子表凭证可落盘；4 个 Model ID 预设均通过 doctor 校验。
- **风险与依赖**：setup.html 已 2210 行，改动面大——按区块小步提交；config-manager 的备份+回滚机制（写前 .bak、doctor 失败回滚）必须保持；thinking effort 的 UI 需要处理好 K3 映射 vs 通用枚举的差异展示。

---

## 4. P1 任务清单（体验升级，进 v1.2.0）

### P1-1 聊天窗 Markdown / 代码高亮渲染
- **用户价值**：原生聊天从"纯文本终端感"升级到"可用聊天产品"，代码块可读、可复制。
- **实现要点**：引入轻量 Markdown 渲染（项目无前端构建链——选无依赖单文件库如 marked UMD + highlight.js 子集，vendor 进 `src/pages/vendor/` 并进 `build.files`）；渲染层继续保持合帧节流；严格 sanitize（DOMPurify 或白名单式后处理），CSP 收紧；代码块加复制按钮；同步补消息级复制按钮；TodoList 待办工具输出渲染为待办卡片（对齐 TUI `Ctrl-T` 展开截断列表语义）。
- **涉及文件**：`src/pages/chat.html`、`src/pages/chat.js`（537+1033 行，渲染管线）、`package.json`（build.files）。
- **验收标准**：常见 Markdown（标题/列表/表格/代码块/行内码/链接）渲染正确；`<script>`/事件属性注入用例被中和；长流式输出（模拟 500 条 chunk）滚动流畅无卡顿；链接点击一律走外链管。
- **风险与依赖**：XSS 是主要风险——渲染前必须过 sanitize，且保留"纯文本模式"开关兜底；无外部依赖冲突（vendor 本地化，不引 npm CDN）。

### P1-2 Plan 模式 UI（plan 推送渲染 + ExitPlanMode 审批卡）
- **用户价值**：plan 会话在原生聊天里不再"盲飞"——计划正文可见，退出审批可点选 1–3 个备选方案，体验对齐官方审批面板语义。
- **实现要点**：消费 P0-3 转发的 `plan` sessionUpdate 渲染计划卡片（条目勾选态）；request_permission 中 toolCall.kind='other'/ExitPlanMode 场景按 options 渲染备选方案卡（label+description；label 不可重复、不可使用 `Approve`/`Reject`/`Reject and Exit`/`Revise` 保留词）；审批窗补 `Ctrl-E` 等价的 diff/详情展开与数字键 1–9 直选（文档两处不一致——键盘页 1–9、交互页 1–3，按宽实现）；标注 Auto 模式计划退出自动批准的 "Auto-approved" 语义与 YOLO 敏感文件（.env/SSH 私钥）仍询问的例外。
- **涉及文件**：`src/main/main.js`（转发）、`src/pages/chat.js`、`src/pages/permission.html`/`permission.js`、`src/preload/permission-preload.js`。
- **验收标准**：plan 会话全程计划可视；ExitPlanMode 审批四选项（Approve/Revise/Reject/Reject and Exit）点选后 agent 行为符合预期；**Reject 与 Revise 均切换反馈输入态**（Esc 返回候选列表），反馈文本正确回传。
- **风险与依赖**：依赖 P0-2 结论⑦的字段形态；Revise/Reject 反馈通道形态需实测确认。

### P1-3 ACP 结构化问答接入原生问答窗
- **用户价值**：agent 提问在原生聊天里也享受 v0.5.0 的多题/多选/自定义输入原生体验，而非退化成普通审批选项。
- **实现要点**：识别 request_permission 中的 elicitation 形态（P0-2 结论⑥），按 AskUserQuestion schema 路由到现有 `question.html`（复用 question:submit/fallback/cancel 通道与窗体）；ACP 应答映射回 permission 响应 optionId/自由文本（背景：新版 CLI 已将回答改为"问题文本+选项标签"回传模型，客户端无需改动但映射设计应知悉）；保留普通工具审批走 `permission.html` 的现有分流。
- **涉及文件**：`src/main/main.js`（1879–2106 审批窗区、1360 问答区）、`src/pages/question.html`/`question.js`、`src/preload/question-preload.js`、`src/main/acp-client.js`。
- **验收标准**：多题、multi_select、allow_other 全形态在 ACP 会话正确弹窗并回执（形态数以 P0-2⑥ 实测为准）；Esc/关窗=取消且 agent 收到 cancelled；与 Web 路线问答互不干扰。
- **风险与依赖**：完全依赖 P0-2 结论⑥的字段形态，若 elicitation 形态与假设不符需改设计；这是本批 P1 中不确定性最高的一项。

### P1-4 Goal 模式面板
- **用户价值**：桌面端独家承载官方新能力——长任务目标的状态可视、可暂停/继续/取消、队列管理，是"管家"定位的标志性功能。
- **实现要点**：聊天窗加 Goal 状态条（active/paused/blocked/complete + 轮次/token/用时 + blocked 原因消息）；操作入口发送 `/goal pause|resume|cancel|replace` 等文本命令（最坏路径，已被 `kimi -p` 支持创建证实可行）——注意命令空闲拦截语义（resume/replace 仅空闲可用，pause/cancel/next 随时可用），UI 标注可用态；paused 完整触发集（手动暂停/中断当前轮次/恢复带 goal 的会话/**模型、供应商、运行时错误**）均需在状态条正确呈现；`/goal next` 队列读取/编辑 upcoming-goals.json（位于 `sessions/<workDirKey>/<sessionId>/`，TUI 专属文件、"不属于 Agent 对话"，桌面只读为主、编辑需谨慎；队列运行期间对 Agent 不可见，当前目标 paused/cancelled/blocked 时**不提升**下一个）；预算进度（若 P0-2 结论⑨发现预算推送通道则消费之，否则仅状态展示；达预算上限是 blocked 触发之一）；`/fork` 派生会话不复制已保存的 /goal，状态条需相应置空；WebView 轨道可直接利用官方 Web 目标条（点击展开/收起、预算进度在标题栏、取消需二次确认），双轨口径一致。
- **涉及文件**：`src/pages/chat.js`、`src/main/main.js`（acp-chat 区）、`src/pages/sessions.html`（详情面板可选挂 goal 状态）。
- **验收标准**：发起 `/goal` 后状态条随轮次刷新；pause/resume/cancel/replace 生效；错误导致的 paused 与恢复带 goal 会话的 paused 均正确显示；非空闲时 resume/replace 入口置灰。
- **风险与依赖**：goal 经 ACP 的状态推送形式文档未写——P0-2 结论⑨决定 UI 数据源；若无推送通道，降级为"命令入口 + upcoming-goals.json 轮询"，验收标准相应调整。

### P1-5 Skills 面板补齐 + Agents 管理面板
- **用户价值**：Skills 与官方四档目录完全一致（含项目级、~/.agents/skills 共享档、扁平 .md 格式）；自定义 Agent（Markdown frontmatter）获得与 Skills 同构的可视化管理。
- **实现要点**：
  - **Skills**：`skills-manager.js` 扫描补齐四档（项目 `.kimi-code/skills/`+`.agents/skills/` > 用户 `$KIMI_CODE_HOME/skills/`+`~/.agents/skills/` > extra `extra_skill_dirs` > builtin）+ 扁平 `.md` 格式 + frontmatter 6 字段（`name`/`description` 目录型必填——缺任一解析失败；扁平 `.md` 省略 description 时回退正文首行非空内容、截至 240 字符；`type`:`prompt`（默认）/`inline`（同 prompt 语义）/`flow`（仅手动调用，其它值跳过）；`whenToUse`/`when-to-use`/`when_to_use`；`disableModelInvocation`/`disable-model-invocation`/`disable_model_invocation`；`arguments` 字符串数组或空格分隔）+ 占位符全集（`$ARGUMENTS`/`$ARGUMENTS[0]`/`$ARGUMENTS[1]` 及简写 `$0`/`$1`、`$<name>` 命名参数、`${KIMI_SKILL_DIR}`、无占位符时附带文本以 `\n\nARGUMENTS: <文本>` 追加正文末尾）；名称**大小写不敏感**；UI 标注来源作用域与同名覆盖关系（项目级优先、同目录 `<name>/SKILL.md` 目录型覆盖 `<name>.md` 扁平文件）；
  - **Agents**：新建 `agents-manager.js` 复用同一扫描/编辑骨架（**骨架可复用，优先级表不可复用**——Agents 为五档：显式 `--agent-file` > 项目 `.kimi-code/agents/`+`.agents/agents/` > 额外 `extra_agent_dirs` > 用户 `$KIMI_CODE_HOME/agents/`+`~/.agents/agents/` > 内置，extra 高于 user，与 Skills 恰好相反）；frontmatter 8 字段（`name` 可选 kebab-case 缺省取文件名、`description` **必填**、`whenToUse`、`tools`/`disallowedTools`/`subagents`/`override`/`model_preference`——`model_preference` 仅次主力模型实验启用时生效且 TUI 忽略，取值 `primary`/`secondary`）；**override:true 红色安全警告**（项目级 `agent.md` + `override: true` 会替换默认主 Agent 整个系统提示词，`coder.md` + override 替换默认子 Agent 类型——官方 ⚠️ 级："在不熟悉的仓库中运行前，请以对待脚本同样的谨慎检查"）；标注 Claude Code/OpenCode 风格 Agent 文件一般可直接加载（兼容导入）；SYSTEM.md 模板变量表（`${skills}`/`${agents_md}`/`${cwd}`/`${cwd_listing}`/`${os}`/`${shell}`/`${now}`/`${additional_dirs_info}`/`${base_prompt}` + 预组合块 `${windows_notes}`/`${additional_dirs_section}`/`${skills_section}`）；AGENTS.md 指令文件四位置（`$KIMI_CODE_HOME/AGENTS.md`、`~/.agents/AGENTS.md`、`.kimi-code/AGENTS.md`、`AGENTS.md`）；写操作仍限定用户级目录，项目级只读展示。
- **涉及文件**：`src/main/skills-manager.js`、`src/main/agents-manager.js`（新）、`src/pages/setup.html`、`src/main/main.js`（skills:* IPC L3220 区）、`tests/test-skills-manager.js`、`tests/test-agents-manager.js`（新）。
- **验收标准**：四档 Skills 扫描与五档 Agents 扫描结果与 `kimi` 实际加载一致（同名冲突各自按官方优先级表解析）；扁平 .md 正确解析所有 frontmatter 字段及连字符别名；Agents 面板增删改后新会话内 Agent 工具可派发该子代理；override:true 文件在 UI 有红色警示。
- **风险与依赖**：无外部依赖；注意 `~/.agents/` 不随 `KIMI_CODE_HOME` 搬迁（文档明示）——扫描路径不能错。

### P1-6 错误引导库对齐 error-reference + 加油包引导
- **用户价值**：报错不再只有"401 认证失败"一种卡片——429 四种限流分别给出"可重试/等窗口重置/月额度冻结+加油包"的不同指引，高速版 401 引导降级模型或升级档位，500 内部错误给出重试策略建议。
- **实现要点**：按官方错误码全表建关键词→引导卡映射（文档提示第三方会重包装错误码，必须按文字关键词匹配）。覆盖 **31 条目（33 条快速查找关键词）**：
  - **401** 六种：API Key 无效/过期、误用开放平台 Key/URL、无 K3 权限（引导升级 Moderato+）、K3 仅 256K 无 1M（引导升级 Allegretto+）、无高速版权限（引导升级 Allegretto+）、模型 ID 拼写错误（主因 `k3[1m]` 写法误用）；
  - **402** 一种：订阅验证失败——**临时性为主**：先确认订阅仍在有效期并重试，持续出现再查控制台或联系 code@moonshot.ai；
  - **403** 两种：周额度耗尽、账号终止（Access terminated，申诉 support@moonshot.cn）；
  - **429** 四种：引擎过载（可直接重试，工作日 14:00–17:00 高峰易触发）、并发过多、5h 限额触顶、月额度耗尽（引导加油包）；
  - **400** 六种：消息超 2MB、token 超限、思维链字段缺失、不支持的图片 URL、工具名重复、内容安全拦截；
  - **404** 两种：模型未找到（附官方常见错误拼写清单 `Kimi For Coding`/`Kimi-for-Coding`/`kimi-for-code`/`kimi-code`/`K2.6`）、method not found（接口路径不存在）；
  - **500** 五种：bot_id 不合规（更新客户端）、数据库连接失败（等 1-2min）、内部连接异常（含 Redis 超时、`failed to evaluate rate limit script`，等 1s×3）、下游 5xx、账号状态异常（申诉 support@kimi-code.com——**与 403 邮箱不同，官方文档内部不一致，必须逐条取原文**）；
  - 工具错误五种：499 取消、500 网页读取失败、500 图片审核失败、403 URL 安全风险、400 URL 格式无效。
  - **重试语义总纲**（引导卡"是否可重试/预计恢复"字段设计依据）：401 不需要重试、403 重试无意义、配额类无意义、400 修改请求内容即可解决、引擎过载直接重试、500 大多等待重试。
- **额外**：加油包规则全集（单次最低 25 RMB、**每日最多 10 次且累计 3,000 RMB**、余额上限 10,000 RMB、不过期可叠加、可设每月消费上限、扣费顺序先订阅限时额度后加油包兜底、余额不足时保证最后一次模型调用完成但不保证整个任务、订阅失效后余额可用但不可充值）；设备与配额管理（所有登录设备与 API Key 共享同一配额、超过 30 天未活跃设备自动解绑——重新 `/login` 恢复、控制台可查看频限状态/管理 API Key 与登录设备）；检测用户 export 了但**不会生效**的凭证变量（`KIMI_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 等——官方明示密钥变量不从 shell 环境自动读取，必须写入 `config.toml` 的 `[providers.<name>]` 或 `.env` 子表）→ 引导正确写法；真正覆盖配置的是文档列明的开关变量（`KIMI_IMAGE_*`/`KIMI_MCP_*`/`KIMI_LOOP_*` 等），纳入诊断打包。
- **涉及文件**：`src/main/main.js`（536 认证错误识别区、4161 诊断打包）、`src/pages/setup.html`（错误引导卡 UI）。
- **验收标准**：构造 31 条目错误文本（mock）均弹出对应引导卡且内容符合官方释义（含各自正确的申诉邮箱）；诊断包含无效凭证环境变量检查项、加油包引导入口与设备管理指引。
- **风险与依赖**：无；文案需引用官方错误原文，避免自造解释。

### P1-7 管家登录/令牌/诊断增强（新）
- **用户价值**：登录、令牌重置、诊断打包、问题反馈全部接入官方通道——少自研、少维护、与 CLI 行为天然一致，管家定位补强。
- **实现要点**：①登录向导接入 `kimi login` 设备码非交互登录（RFC 8628，无需进 TUI，Ctrl-C 可取消，退出码 0/1，token 与 TUI `/login` 同一本地位置）；②`kimi web rotate-token` 重置令牌入口（旧 token 立即失效、所有运行中实例下次鉴权自动换用新 token，无需重启）；③诊断打包改调 `kimi export <sessionId> -y [--no-include-global-log]`（官方推荐通道——数据路径页明示报 bug 优先使用），自研打包保留作无会话场景兜底；④环境检测纳入诊断（Git for Windows/`KIMI_SHELL_PATH`、Node.js ≥ 22.19.0、代理变量 HTTP(S)_PROXY/ALL_PROXY/NO_PROXY、Windows native 无法自动升级仅打印手动命令的行为边界）；⑤`/feedback` 官方反馈通道引导（三档附件 No attachment/Logs only/Logs + codebase，`.env` 与密钥等敏感文件自动排除，提交返回 Session 与 Feedback ID 供跟进）。
- **涉及文件**：`src/main/main.js`（登录/诊断区）、`src/pages/setup.html`、登录向导页。
- **验收标准**：设备码登录全流程手测通过；rotate-token 后 WebView 凭新 token 自动恢复；诊断包由 `kimi export` 产出且可直接提交官方；环境检测项在缺失时给出正确引导；`/feedback` 引导卡跳转正确。
- **风险与依赖**：依赖 P0-1 的 ⑨⑩⑫ 组回归结论；`kimi export` 需会话 ID——无会话场景回退自研打包。

### P1-8 ACP 图片输入复测收尾（新）
- **用户价值**：v0.13.0 已发布原生聊天图片输入 UI，但 probe4 在 CLI 0.27 实测图文 prompt 崩溃 0xC0000409——在新 CLI 上确认链路真实可用，或给用户明确降级路径。
- **实现要点**：按 P0-2 结论⑧在 0.29.x 复测图文 prompt：已修复则解除兜底逻辑、补验收用例（base64+mimeType、至多 4 张、mime 白名单）；未修复则输入侧加明确降级提示（引导 WebView 轨道粘贴，Windows 为 `Alt-V` 语义），并防止崩溃扩散到桌面进程。视频输入标注为 TUI/Web 路线（ACP 未声明视频能力，桌面不做）。
- **涉及文件**：`src/pages/chat.js`、`src/main/acp-client.js`、`tests/test-acp-client.js`。
- **验收标准**：0.29.x 图文 prompt 实测结论落地——已修复则图片全链路用例通过；未修复则降级提示可见、发送被拦截且不崩溃。
- **风险与依赖**：完全依赖 P0-2 结论⑧。

---

## 5. P2 任务清单（差异化增强，进 v1.3.0，按价值排序）

| # | 任务 | 用户价值 | 实现要点与落点 | 验收 | 风险/依赖 |
| --- | --- | --- | --- | --- | --- |
| P2-1 | Themes 管理器 | 桌面 UI 与 TUI 共用主题；低垂果实 | 扫描 `$KIMI_CODE_HOME/themes/*.json`（**19** token，**每 token 单色值** + 可选 `base` 字段 dark/light 决定未写 token 继承调色板），可视化编辑（对齐官方 `/custom-theme` skill 体验：schema 为 `name` 必填/`displayName`/`base`/`colors`，token 语义表即映射校准依据）+ 写 `tui.toml` `theme` 字段；token 映射 `kimi-theme.css` 变量。注意：重新选中同一主题不触发重载（"Theme unchanged"）；`auto` 调色板损坏静默回退 dark；保存后 `kimi doctor tui` 校验。落点：setup.html 新页、config-manager.js | 主题 JSON 增删改后 TUI `/theme` 可见"Custom: <名>"；桌面原生页配色随动；非法色值静默回退；`kimi doctor tui` 通过 | token→CSS 映射需按官方 token 语义表校准 |
| P2-2 | 插件详情 + marketplace 浏览 | 插件管理追上 `/plugins` 面板能力 | 详情视图（manifest interface/diagnostics/hooks/mcpServers/commands/sessionStart/`skillInstructions` 声明；`name` 正则 `[a-z0-9][a-z0-9_-]{0,63}`；不支持字段显示为 diagnostics）；marketplace 拉取 version "2" JSON 列表 + 安装入口（本地/zip/GitHub URL 四种格式）；优先解析 `kimi.plugin.json`；标注：仅用户级安装（暂不支持项目级）、变更需 `/reload` 或新会话生效、第三方安装确认默认"取消"、`<plugin>:<cmd>` 命令命名空间、插件 MCP server `cwd` 必须 `./` 且在根内、符号链接解析后须在 plugin 根内、`KIMI_CODE_PLUGIN_MARKETPLACE_URL` 可覆盖默认源；Kimi Datasource 官方插件（`/skill:kimi-datasource`）作 marketplace 头号内容。落点：plugins-manager.js、setup.html | 与 `/plugins list/info` 输出一致；安装后 managed/ 出现托管副本 | 安装动作建议仍引导 CLI 命令，桌面先做只读+跳转 |
| P2-3 | MCP 面板增强 | 字段追平 + 项目级配置 | 补 `toolTimeoutMs`/`enabled`/`disabledTools`/`transport:"sse"`；类型判定规则（有 `command`=stdio；有 `url` 无 `transport`=HTTP；`transport:"sse"`=旧式，新 server 优先 HTTP）；超时优先级链（server 字段 > env `KIMI_MCP_STARTUP_TIMEOUT_MS`/`KIMI_MCP_TOOL_TIMEOUT_MS` > config `[mcp]` > 内置默认 30000/60000，范围 1–2147483647）；项目级 `.kimi-code/mcp.json` 编辑（含"stdio 会执行本地命令"信任警告）；OAuth 引导卡（`/mcp-config login`，凭据存 `credentials/mcp/`、`/logout` 不清）；`/mcp` 连接状态查看入口。落点：setup.html、config-manager.js | 全局/项目两级读写 doctor 通过；优先级提示正确（项目级同名覆盖；单 server 字段始终优先全局） | 项目级写入涉及用户工程目录，需明示 |
| P2-4 | IDE 向导更新（Paseo + 片段核对） | 向导覆盖官方全部三个 ACP 客户端 | Zed 片段逐字段对齐（`type:"custom"`/`env:{}`；`agent_servers` 层声明的 MCP 会经 ACP 转发到 kimi 侧，可顺带说明）；JetBrains 强调绝对路径（无 AI 订阅时注册表 `llm.enable.mock.response` 可启用聊天面板）；新增 Paseo 配置卡（`command: ["kimi","acp"]` 数组形式、`~/.paseo/config.json`、登录需提前在终端完成）；macOS PATH 陷阱提示（跨平台文案预留）；附"终端跑 `kimi acp` 阻塞等 stdin = CLI 正常"自验法；ACP 适配层 MCP 传输仅 http/stdio/sse 三种、`acp` 传输静默丢弃写 warn。落点：ide-integration.js、setup.html | 生成的 Zed 配置在真实 Zed 中可用；Paseo 卡内容与官方一致 | 无 |
| P2-5 | 用量三层展示 + 额度引导 | 周额度/5h 窗/月共享 + 加油包余额可视，80% 时引导加油包 | 数据源仅 `/usage`（TUI 命令，无 REST API）——托盘菜单驱动 CLI 查量或展示最近解析值；三层结构 + 重置时间；加油包余额（v0.23.4 `/usage` 支持）；设备/API Key 共享配额与 30 天解绑提示。落点：main.js 托盘区 2726 | 展示与 TUI `/usage` 一致；无用量数据时明确标注来源限制 | 解析脆弱性；官方无用量查询 API（§7-11） |
| P2-6 | 后台任务/定时任务面板 | tasks/ 与 cron/ 持久化可视 | 只读解析会话目录 `tasks/<task_id>.json` + `tasks/<task_id>/output.log`、`cron/`；列表+输出查看；后台子 Agent 亦经 `tasks/` 暴露生命周期（Agent 文档明示）；cron 语义展示：本地时区表达式、触发注入同一会话、`--session` 恢复重新加载但不带入新会话、**周期任务 7 天自动过期（stale 标记）**、8 位 id 删除、总开关 `KIMI_DISABLE_CRON=1`。落点：session-export.js 扩展、agents.html 复用 | 与 `/tasks` 输出一致；过期 cron 有 stale 标记 | 只读起步，不做操作 |
| P2-7 | fs 能力开启（桌面接管文件读写，灰度） | 文件操作经桌面主进程，可做审计/拦截 UI | acp-client 声明 `fs.read=true`/`fs.write=true` 并实现 `fs/read_text_file`、`fs/write_text_file` 反向 RPC（路径白名单限会话 cwd）；配套审计日志视图。落点：acp-client.js、main.js | 声明后 agent 文件读写全部经桌面且有日志；越 cwd 路径拒绝 | 安全面扩大——需路径规范化+symlink 检查；建议独立灰度开关 |
| P2-8 | Steer 注入 | 流式期间"插话"体验 | 验证 turn 进行中 session/prompt 是否可用（第五次探测可加项）；可行则输入框支持 `Ctrl+S` 发送 steer | 实测结论落地；不可行则记录 §7 | ACP 文档未提，纯实测项 |
| P2-9 | Hooks 面板增值 | 对齐文档细节 | timeout 1–600/默认 30 校验提示、"仅四字段"提示、stdout JSON 阻断模板（`permissionDecision:deny`）——**仅 PreToolUse/Stop/UserPromptSubmit 三个可阻断事件可用，其余 13 个观察型事件置灰**；Interrupt/Stop 互斥说明；**fail-open 性质明示**（退出码非 0/2 与超时均放行，"Hooks 不应作为唯一安全防线"）；`matcher` 为正则；插件 hooks 差异（仅启用期生效、cwd=plugin 根、额外注入 `KIMI_CODE_HOME`/`KIMI_PLUGIN_ROOT`）。落点：setup.html | 模板生成的 hooks 直接可用；不可阻断事件的阻断模板被置灰 | 无 |
| P2-10 | kimi vis / 会话可视化 | 桌面窗内展示会话对话树 | 调用 `kimi vis <sessionId>` 在独立 WebView 窗渲染（复用主窗 WebView 管线），不解析内部数据 | vis 窗可正常交互；不影响主窗 WebView 会话 | CLI 版本需 0.16.0+；首次尝试，复杂度低 |
| P2-11 | 斜杠命令面板扩容 + 双轨互跳 | 命令覆盖追平官方下发清单；`/web` 提供原生↔WebView 互跳的官方语义 | v0.13.0 已有 `/` 菜单骨架；按 P0-2 结论⑭实测下发清单补齐 `/btw`（fork 子 Agent 旁路对话）、`/web`（Web UI 打开当前会话）、`/reload`（区别于 `/reload-tui`：同时重载 config.toml）、`/undo`、`/title`、`/add-dir`、`/mcp`、`/experiments` 等；命令标注空闲拦截态（流式/压缩期间部分命令被拦截）。落点：chat.js、main.js | 实测下发的命令全部可用；`/web` 正确跳转主窗 WebView 对应会话；非空闲命令正确置灰 | 完全依赖 P0-2 结论⑭的下发范围 |
| P2-12 | 第三方工具接入卡 | 管家"多 IDE 配置"轨道覆盖官方三大第三方工具 | Claude Code 卡（`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`、`k3[1m]` 写法声明 1M 上下文、effort 映射 medium→high/xhigh→max、`~/.claude.json` onboarding 跳过脚本）；OpenCode 卡（内置 "Kimi For Coding" provider、`opencode auth login`）；Codex 卡（社区第三方方案、官方不维护——CC Switch 转换层）；双协议端点（OpenAI 兼容 `https://api.kimi.com/coding/v1`、Anthropic 兼容 `https://api.kimi.com/coding/`）；API Key 控制台指引（最多 5 个、仅创建时可见一次）；档位×模型矩阵统一回链官方 models 页而非复制。落点：ide-integration.js、setup.html | 生成的配置在真实工具中可用；模型细节回链官方页 | Codex 方案社区维护、稳定性差——UI 标注即可 |

---

## 6. 迭代里程碑

> 粒度按 1–2 天（S）与 3–5 天（M）划分；每个里程碑结束可独立发布或回退。

| 里程碑 | 粒度 | 内容 | 出口标准 |
| --- | --- | --- | --- |
| **M1 基线升级** | S（1–2 天） | P0-1：CLI 升 0.29.x，14 组回归核对清单执行，适配层基线切换 + 旧版引导 + 死代码清理 | 回归清单全绿或项项有结论；v1.0.x 补丁版可发 |
| **M2 协议冲刺** | S（1–2 天） | P0-2 探测5（14 项）+ P0-3 acp-client 补齐（含单测） | 探测报告入库（重建 `docs/acp-research.md`）；acp-client 新 API 测试全过 |
| **M3 启动器与设置对齐** | M（3–5 天） | P0-4 启动器 session/list+删除；P0-5 设置中心 schema 第一波（约 25+ 新字段/区块，含 tui.toml） | 启动器三方一致；`kimi doctor config` 与 `kimi doctor tui` 校验全过 → **发布 v1.1.0** |
| **M4 聊天渲染与审批** | M（3–5 天） | P1-1 Markdown/高亮、P1-2 plan UI、P1-3 ACP 问答接入 | 渲染安全用例过；plan/问答全形态手测过 |
| **M5 Goal 与扩展面板** | M（3–5 天） | P1-4 Goal 面板、P1-5 Skills 补齐 + Agents 面板、P1-6 错误引导库（31 种错误映射、33 条匹配关键词）、P1-7 管家登录/令牌/诊断、P1-8 图片输入复测收尾 | Goal 全生命周期手测过；面板与 CLI 行为对账；`kimi export` 诊断包可用 → **发布 v1.2.0** |
| **M6 差异化精选** | M（3–5 天） | P2-1 Themes、P2-2 插件详情、P2-3 MCP 增强、P2-4 IDE 向导、P2-11 命令面板、P2-12 第三方工具卡（按窗口期优先级可调序） | 各面板与 CLI 对账 → **发布 v1.3.0** |
| 后续 | — | P2-5 用量、P2-6 任务面板、P2-7 fs 能力（灰度）、P2-8 Steer、P2-9 Hooks 增值、P2-10 kimi vis | 按窗口期与官方 VS Code 扩展开放节奏再排 |

---

## 7. 需进一步核实的问题清单（官方文档未覆盖/需实测）

> 标注 "📄" = 文档有线索但需实测确认；"🔍" = 只能实测。

1. 🔍 Goal 模式经 ACP 的暴露形式：是否有 goal 相关 session/update 推送、预算进度通道？（探测5 项⑨；文档仅描述 TUI/Web 行为）
2. 🔍 新版 CLI `session/load` 对**非活跃**历史会话是否真实回放历史（0.27 实测当前活跃会话不回放；文档写"回放"）；`session/resume` 与 load 的确切差异。
3. 🔍 AskUserQuestion elicitation 经 `session/request_permission` 的字段级形态（options 如何承载多题/multi_select/allow_other；schema 数字官方快照无出处，项目 v0.5.0 实现与 ACP 规范为准）。
4. 📄 `available_commands_update` 实际下发范围：ACP 文档确认为主动推送通知，但下发是否含 /goal、skill 动态命令（`/skill:<name>`）、插件命令（`<plugin>:<cmd>`）及 `/btw`、`/web`、`/reload`、`/undo`、`/title`、`/add-dir`、`/init`、`/experiments`、`/mcp`、`/custom-theme`、`/import-from-cc-codex`、`/update-config`、`/check-kimi-code-docs`——需实测验证（探测5 项⑭）。
5. 🔍 thinking 在 ACP configOptions 的形态：effort 多档（K3 映射 low/high/max）还是 on/off；与 `[thinking]` 配置的关系；session/set_model 切换模型时 effort 是否跟随（背景：v0.28.0 起模型切换后 effort 仅保留低于新模型最高档的档位）。
6. 🔍 图片输入在新 CLI 是否已修复（0.27.0 图文 prompt 崩溃 0xC0000409，probe4 结论；ACP 能力声明 image=true，文档模型页确认支持图片/视频）——决定 P1-8 走向。
7. 🔍 Steer：turn 进行中发 session/prompt 是否被接受（文档无 ACP steer 通道描述）。
8. 📄 数据路径页目录树缺项：`~/.kimi-code/server/` 与 `server.token`（kimi 命令页有述）之外，还缺 `themes/`、用户级 `agents/`、`updates/`（自动更新状态）、`credentials/mcp/`（MCP OAuth 凭据）——多处文档不一致，以实测为准。
9. 📄 Web UI 深链参数（旧版 `?action=create-in-dir&workDir=`）在新版是否保留（快照全文零命中已确认，只能实测）；新版 Web UI 的预算进度条数据源。
10. 🔍 审批 always 语义四个 scope（turn-override/session-runtime/project/user）各自的具体落盘位置与生命周期。
11. 🔍 是否存在 REST 用量查询接口（文档仅有 TUI `/usage` 与控制台，v0.23.4 `/usage` 开始显示加油包余额；openapi.json 实抓可证）。
12. 📄→**持续监控项**：VS Code 扩展面向 TS CLI 用户开放的时间表——2026-07-27 线上复核仍未开放（线上构建 hash 与本地快照一致，同一次部署），窗口期判断成立；转为每次发布前复查的监控项，不再阻塞规划。
13. ✅ **已确认**：`k3-256k` 确实进入 CLI 模型目录（模型配置页列出，含"模型上新推荐"块；仅 256K 上下文 + 仅图片多模态）。
14. 🔍 Skills/Hooks/插件在 ACP 会话中是否生效（文档仅确认 MCP 转发与 available_commands_update 推送）——探测5 可附带验证 hooks 触发。
15. 📄 `kimi web` 无客户端连接时的存活行为：`--keep-alive` 未继承到新命令树（旧版空闲超时随 v0.28.0 消失）；`--dangerous-bypass-auth` **已确认新版 `kimi web` 仍支持**（选项表在列，附彻底关闭鉴权的风险警告）；新文档对存活策略仅写明"一直挂在终端，直到收到 SIGINT/SIGTERM 时干净退出"——是否仍有空闲超时需实测。
16. 🔍 `session/list` 字段形态（title/updatedAt/cursor）：官方文档页未展开，出处为 ACP 规范——探测5 项③ 实测为准。
17. 🔍 新版 agent 是否另发 ACP 规范 `current_mode_update` 通知（官方文档 session/update 行仅列 `config_option_update`）——探测5 项⑫。
18. 🔍 rotate-token 行为实测（`kimi web rotate-token` 后旧 token 立即失效、运行中实例自动换用、令牌 7 天保留）——2026-07-27 M1 回归时因桌面/CLI 实例活跃使用中经用户决定跳过；`#token=` 片段注入链路已实证可用（见 docs/regression-0.29.md ⑩）。
19. 📄 REST 建会话配置落位缺陷（0.29.0 实测）：`POST /api/v1/sessions` 的 `agent_config`（model/permission_mode/plan_mode）不落位；`POST /profile` 仅落 permission/plan；model 须随 `POST /prompts` 顶层字段提交，否则 turn 报 `model.not_configured`；全局 `default_model` 不被 REST 会话继承——P0-4 启动器走 REST 建/恢复会话时必须按此实测结论实现（详见 docs/regression-0.29.md 附带发现）。

---

## 8. 工程约束与合规

- **User-Agent 合规**：官方明示篡改客户端标识可被暂停权益——桌面端不代理、不改写任何 API 请求身份标识，写入开发约束。
- **合规红线**：不做批量非交互式自动化能力；正向代理（VPN/公司代理）没问题、反向代理（给他人转发）违规；重度用户不误封（社区倡议 FAQ）。
- **安全基线**：fs/terminal 能力维持关闭直至 P2-7 灰度；Markdown 渲染必须 sanitize；会话删除必须可恢复（.trash 移动）。
- **Hooks fail-open 性质**：hook 退出码非 0/2 与超时崩溃均放行——官方明示"Hooks 不应作为唯一的安全防线"，面板与模板须保持此提示。
- **会话数据完整性**：官方警告"sessions/ 目录下的文件请勿手动编辑"（会话与上下文页）——P0-4 删除/.trash 与 P1-4 upcoming-goals.json 编辑以此为最高风险依据，任何写操作必须可恢复。
- **项目级 Agent 文件信任**：`.kimi-code/agents/` 与 `.agents/agents/` 中 `override: true` 的文件会替换默认主 Agent 系统提示词——面板按官方 ⚠️ 级指引给红色提示（"在不熟悉的仓库中运行前，请以对待脚本同样的谨慎检查"）。
- **旧数据不动**：`kimi migrate` 幂等且不删旧数据（OAuth 凭证与 MCP 授权不复制、插件不迁移、导入会话带 `[imported]` 标记），桌面迁移提示维持只引导、不代删。
- **测试策略**：tests/ 保持 node assert 无框架风格；acp-client/config-manager/skills/agents 管理器改动必须带单测；渲染层用 `scripts/screenshot-*` 双主题截图回归辅助。
- **文档回写**：M2 重建 `docs/acp-research.md`（旧文件已在工作区删除），此后每个里程碑结束回写探测结论，保持项目单一事实源。
- **模型门槛感知**：桌面端在模型选择与错误引导中应展示各 Model ID 的档位门槛（`k3`/`k3-256k` 需 Moderato+、`k3` 1M 需 Allegretto+、`kimi-for-coding-highspeed` 需 Allegretto+），避免用户选择不可用模型后遇到困惑的 401 错误；模型目录动态变化（重新登录可刷新），预设 UI 标注可能滞后。
- **thinking 约束**：`kimi-for-coding` / `kimi-for-coding-highspeed` 必须开启 thinking，关闭会路由到 K2.6；K3 关闭 thinking 同样路由到 K2.6；K3 effort 非枚举值直接 HTTP 400。设置中心 thinking 配置区应区分模型给出提示。
- **实验功能标识**：`secondary_model`（`KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`，kimi web 场景）、`--agent`/`--agent-file`/`SYSTEM.md`（`KIMI_CODE_EXPERIMENTAL_FLAG=1`，仅 `kimi web`/实验性 `kimi -p`，TUI 忽略/拒绝）在 UI 中标注"实验性"并说明启用条件。
- **CLI 破坏性变更追踪**：v0.28.0 `kimi server` 废弃为破坏性变更——桌面端适配层不得再调用 `kimi server` 命令树，仅使用 `kimi web`；唯一例外是 `kimi server kill`（官方保留用于清理 0.28 之前遗留后台服务）。
