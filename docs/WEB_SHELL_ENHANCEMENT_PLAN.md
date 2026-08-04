# Kimi Code Desktop Web Shell 增强计划（正式实施计划）

> 版本：v1.2（定稿）
> 日期：2026-08-03
> 状态：**已评审，可执行**（Oracle 最终门禁通过；可作为后续实施依据）
> 受众：后续实施工程师（单人，Windows 10+ / Electron 38 / Node 22+）
> 依据：`.slim/deepwork/web-shell-enhancement-plan.md`（已调和事实与产品边界）、`docs/ROADMAP.md`、`README.md`、`package.json`、`src/main/*.js` 源码核对、参考项目 `D:\code\kimi-code-desktop-master`（仅信息架构借鉴）。
> 约束：本计划只描述实施方向与验收标准，不修改源码、`docs/ROADMAP.md`、`docs/memory/*` 或其他文件；源码改动由后续实施提交。

---

## 0. 摘要

本项目（Kimi Code Desktop）本质是**官方 `kimi web` 的 Electron 套壳增强**。官方 Web UI（kimi web）是**唯一的主对话 UI**，负责流式 Markdown、代码高亮、工具卡、审批、追问、上传、Slash Commands、Plan/Swarm 控制与 prompt 队列。Electron 外壳负责进程生命周期、窗口组合、工作区（Workspace）面板、本地只读数据投影、通知、托盘、快捷键与单实例行为。

本计划把当前 v1.7.0 基线推进到"主窗口内嵌本地 Workspace 面板（Changes/Files/Agents/Tasks）"的正式形态，共 6 个里程碑（M1–M6）。**唯一架构决定**：第一版 Workspace 采用**固定宽度、可折叠的覆盖式右侧 `WebContentsView`**，覆盖当前 `BrowserWindow.webContents` 的右侧区域；**不把 `kimi web` 迁入 `WebContentsView`、不宣称并排、不做拖拽调宽**；feature flag 关闭时完全不创建面板，真实回到现状。**不建设第二个原生聊天运行时**：现有 ACP 原生聊天（`src/pages/chat.html`、`src/main/acp-client.js` 链路）不纳入本计划，其保留/隐藏/删除是独立的后续决策。

---

## 1. 背景与纠偏

### 1.1 背景

- 项目现状：Electron 38 主进程 `src/main/main.js`（约 5800 行）启动 `kimi web --no-open` 并将官方 Web UI 嵌入主窗口；已具备就绪探测（轮询 `/openapi.json`）、WS 订阅（`/api/v1/ws`，审批/问答/用量/任务事件）、托盘/通知/全局快捷键/单实例、sessions/setup 全屏覆盖层（`WebContentsView`）、会话启动器、设置中心等能力。
- 用户已明确的产品方向：**kimi web 是唯一主对话 UI，桌面端做套壳增强**，把工作区增强（Changes/Files/Agents/Tasks 面板、状态汇总、通知、Windows 集成）嵌入主窗口且不离开 Web 对话。
- 参考项目 `D:\code\kimi-code-desktop-master`（Tauri + React 独立聊天应用）的 Workspace 四标签（Changes/Files/Agents/Tasks）信息架构值得借鉴，但其**原生聊天运行时、消息 replay reducer、composer、审批/追问卡与多会话运行时均不得复制**。

### 1.2 纠偏（相对旧 ROADMAP 的差异）

旧 `docs/ROADMAP.md` 以下区域与修正后的产品方向冲突，**本计划以修正方向为准**，ROADMAP 的修订由 orchestrator 另行安排，不在本计划范围内：

| 位置 | 旧表述 | 纠偏 |
| --- | --- | --- |
| `docs/ROADMAP.md:18-28` | 三轨战略把「ACP 原生聊天轨道」作为主界面级体验目标之一 | 取消该目标：kimi web 是唯一主对话 UI；**ACP 不作为必需数据源**，仅自然存在的观察可作低置信附加信息（不启动、不依赖） |
| `docs/ROADMAP.md:71-80` | "把 ACP 原生聊天从可用提升到主界面级体验" | 不实施；聊天渲染、审批、问答、Goal 面板等一律由官方 Web UI 承载，桌面不重复实现 |
| `docs/ROADMAP.md` §3–§5 | P0–P2 中的 ACP 原生聊天/审批/问答/Goal 面板任务 | 全部移出本计划主线；已完成的历史功能保留运行但不演进，未来处置见 §12.4 |

### 1.3 已确认的产品边界（不可逾越）

1. **对话面唯一**：`kimi web` 拥有流式 Markdown、代码高亮、工具卡、审批、追问、上传、Slash Commands、Plan/Swarm 控制、prompt 队列的全部所有权。
2. **Electron 面**：进程生命周期、窗口组合、Workspace 面板、本地只读数据投影、通知、托盘、快捷键、单实例。
3. **数据源顺序**：官方 REST/OpenAPI 与 WebSocket/AsyncAPI → 官方 Web UI 状态 → 本地只读会话/工作区数据 → CLI 命令 → **ACP 仅作低置信附加信息（不启动 ACP、不成为模块依赖、不影响出口标准）**。
4. **禁止清单**：独立 React/原生聊天 workspace、多 ACP 会话运行时、自研聊天 live/replay reducer、Composer、工具卡、审批/追问卡、prompt 队列——均不建。
5. **DOM 注入红线**：避免深度 DOM 注入；优先本地 `WebContentsView` 面板；仅允许"最小且可探测"的页面钩子（见 §5.4）。
6. **ACP 原生聊天**（现有实验功能）：不纳入本计划，保留/隐藏/删除为独立决策（§12.4）。

---

## 2. 目标 / 非目标

### 2.1 目标（本计划交付）

1. **能力审计与外壳契约**（M1）：系统探测 `kimi web` 的 REST（`/openapi.json`）与事件通道（`/asyncapi.json`、WS 实测），产出能力清单文档，作为后续所有数据源决策的唯一依据。
2. **主窗口 Workspace 面板**（M2）：在主窗口内容区内以常驻本地 `WebContentsView` 形式实现**固定宽度、可折叠的覆盖式 Workspace 面板**（默认覆盖 `BrowserWindow.webContents` 右侧区域；不迁入 `kimi web`、不并排、不拖拽调宽），切会话/调窗口/换主题均正确联动。
3. **Changes/Files 只读服务与 UI**（M3）：主进程只读计算活动工作树的 Git 变更（HEAD/index/untracked 三源），白名单受限的文件浏览/预览，渲染为 Changes 列表 + Files 树；Changes 明确标注"当前工作树相对 Git 基线的视图"，不做"仅本会话修改"承诺。
4. **Agents/Tasks 活动投影**（M4）：复用 `runtime-event-normalizer` / `runtime-state` / `subagent-tree`；`task-catalog` 需改造（§3.2、§8.4），把已验证会话的子代理树、后台任务/定时任务以只读投影呈现。**Agents 第一版必需来源为已验证 `sessionDir` 的磁盘快照**（现有官方 WS normalizer 对官方事件规范化后 `agentType` 恒为 `null`，**不宣称具备完整 Agents 实时流**；仅当 M1 实测发现官方 Web WS 子代理事件后，才扩展 `runtime-event-normalizer` 并启用实时更新，§8.3）；Tasks 继续用已有 WS `task.*` + 磁盘快照；不追求完整历史实时重建。
5. **Web 主导整合边界**（M5）：权限/Plan/Swarm/模型/上传/Slash/队列全部留在 Web UI；桌面只做通知、聚焦引导、深链与去重，不复制交互控件。
6. **回归、安全门禁与发布**（M6）：Windows 托盘/通知/快捷键/单实例回归、文件系统与 Git 安全审计、打包与回滚流程。

### 2.2 非目标（明确不做）

- 不建设任何新的聊天输入、消息渲染、流式管线（Composer、reducer、replay）。
- 不实现工具卡、审批卡、追问卡、Goal 面板、prompt 队列的桌面副本。
- 不实现多 ACP 会话运行时；不在本计划内扩展 `acp-client.js` 的 fs/terminal 能力。
- 不开启 ACP fs 反向 RPC；桌面读文件一律走主进程白名单只读服务。
- 不修改 `docs/ROADMAP.md`、`docs/memory/*`（本计划仅文档交付；源码改动由后续实施提交，见顶部约束说明）。
- 不承诺 Changes 的"会话归因"语义（见 §8.1）。
- 不复制 `kimi-code-desktop-master` 的任何源码或 React 组件。

---

## 3. 当前基线与可复用能力（已核对源码）

以下均经源码/文档核对，作为 M2–M4 的复用前提；"✅ 复用 / 🔧 改造 / 🆕 新建"标注用途。

### 3.1 进程与窗口

| 能力 | 位置 | 用途 |
| --- | --- | --- |
| CLI 启动 `kimi web --no-open`（0.28+ 校验、`--port/--host/--log-level/--session`） | `src/main/main.js` `startKimiServer()`（L582） | 基线，不动 |
| 就绪探测：轮询 `/openapi.json` 直至 200 再 `loadMain` | `startPolling()`（L748）、`detectServerCaps()`（L717） | 🔧 扩展为统一能力登记入口（M1，**优先扩展现有 serverCaps**，见 §4.2） |
| 主窗口 `BrowserWindow` + `contentView` 组合 | `createWindow()`（L3200） | ✅ 面板宿主 |
| 全屏覆盖层 `WebContentsView`（sessions/setup），`ensureOverlayView/showOverlay/closeOverlay/foregroundContents` | `src/main/main.js` L1730–1796 | ✅ 面板复用其 WebContentsView 创建范式（webPreferences、partition `persist:kimi-code`、`--kcd-main-window` 标记、主题类下发） |
| 无边框 + 悬浮窗控 + 顶栏拖拽 | `framelessOpts()/applyFrameless()`（L1167） | ✅ 面板 bounds 避开右上角窗控/菜单区（§5.2）；面板无自身 `titleBarOverlay` |
| 主题令牌与亮暗类下发 | `src/styles/kimi-theme.css`、`applyAppThemeClassTo()`（L1144） | ✅ 面板直接引用 kimi-theme.css |
| 外部链接白名单 | `handleWindowOpen()`（L3166） | ✅ 面板复用 |

### 3.2 事件与状态（M4 直接复用）

| 模块 | 说明 | 用途 |
| --- | --- | --- |
| `src/main/runtime-event-normalizer.js` | WS `task.started/progress/completed`、`session.usage_updated` 规范化；ACP 工具事件规范化（仅当已有 ACP 观察自然存在时作低置信附加信息，**不启动 ACP**）；磁盘 `tasks/*.json` 防御性解析；**现状：对官方 WS 事件规范化后 `agentType` 恒为 `null`，不产出 Agents 生命周期数据；`SubagentStop` 仅作完成提示** | ✅ 保持；**Agents 实时更新仅在 M1 实测发现官方 Web WS 子代理事件后，小步扩展本模块（新增事件形态映射、使 `agentType` 可判）并启用，见 §8.3** |
| `src/main/runtime-state.js` | 任务键 `${sessionId}:${taskId}`、usage 分桶、终态墓碑、`getTasks/getActiveCounts/getUsageSnapshot` | ✅ 保持 |
| `src/main/subagent-tree.js` | `buildSubagentTree(sessionDir)`：state.json `agents` 映射 + `agents/<id>/wire.jsonl` 步骤补绘，缺省降级按目录枚举 | ✅ 保持（M4 只读调用） |
| `src/main/task-catalog.js` | 合并 runtime 快照 + 磁盘 `tasks/*.json`、`cron/*.json`，`getCatalog()` 返回 entries + diagnostics；现有 `sessionsRoot` 全量扫描与 `sessions/<workDirKey>/<sessionId>` 两级目录**可能不匹配**，M4 须改造为接收**已验证的具体 `sessionDir`** 或新增适配层，并以测试证实；已有 ACP 内存观察仅作低置信附加信息，**不得启动 ACP、不得成为模块依赖** | 🔧 改造（M4-1 以测试证实） |
| `src/main/session-export.js` | `wire.jsonl` 读取、Markdown 导出、子代理扫描 | 🔧 仅复用其 wire 解析思路，不引入导出功能 |

### 3.3 会话与工作目录

| 能力 | 位置 | 用途 |
| --- | --- | --- |
| 会话索引 `~/.kimi-code/session_index.jsonl`（`sessionId/sessionDir/workDir`） | `getSessionIndexPath()/getAllSessions()`（L4874） | ✅ 低置信候选源：仅用于展示候选，**不授权 Files/Git 读取**（§5.3） |
| 三路合并列表（REST + ACP session/list + 本地索引） | `getAllSessionsMerged()`（L5024） | ✅ 保持（**仅既有启动器可用**）；**Workspace 面板一律不得依赖**——其内部 `querySessionsViaAcp()` 会创建 `AcpClient` 并启动 `kimi acp`；面板候选/上下文链新建"不含 ACP"的候选服务（§5.3） |
| 敏感目录检测 `isSensitiveWorkDir()`（home 根/盘符根/`.ssh`/`.gnupg`/KIMI_CODE_HOME） | L4937 | ✅ 面板工作目录守卫复用 |
| 会话目录布局 `sessions/<workDirKey>/<sessionId>/`（`state.json`、`agents/main/wire.jsonl`、`tasks/`、`cron/`） | 实测/文档 | ✅ M4 只读数据根 |
| 深链建会话 `?action=create-in-dir&workDir=...#token=` | `createSessionInDir()`（L5424 区） | 🔧 M5 增强 |

### 3.4 WS 订阅（桌面事件通道）

- 端点 `ws://<base>/api/v1/ws`，子协议 `kimi-code.bearer.<token>`；`client_hello` + 按会话订阅（`wsSubscribe`），30s 低频发现（`refreshSubscriptions`），断线重连带 generation 防串台（`cleanupWsSoft/scheduleWsReconnect`）。
- 已处理事件：`approval.requested/resolved/expired`（仅通知计数，不自动审批）、`question.requested/answered/dismissed`（现状：原生问答窗接管；**目标态：Web UI 优先，桌面仅通知/聚焦，本地 question 窗仅当 M1 证明对应 Web 版本不支持时才作兼容 fallback，见 §9**）、`session.usage_updated`、`task.started/progress/completed`、`session.deleted/archived`、`model_catalog.changed`、`session.completed`、`SubagentStop`（**仅作完成提示，不算 Agents 生命周期数据**）。
- **现状**：桌面已消费"用量/任务/通知"类事件；M4 的 Tasks 活动投影数据源即此（`task.*`）+ 本地磁盘，不新增第二套事件管线；**Agents 投影第一版以磁盘快照为必需来源，官方 WS 实时流仅当 M1 实测存在子代理事件后才启用（§8.3）**。

### 3.5 Windows 集成（M6 回归对象）

| 能力 | 位置 |
| --- | --- |
| 系统托盘（菜单、tooltip 用量/任务状态；**单击与双击均绑定 `showMainWindow`**，源码 L3102–3103，无"双击新会话"语义） | `createTray()/updateTrayStatus()`（L3097/3127） |
| 原生通知 + 任务栏闪烁 + 网页通知屏蔽 | `showDesktopNotification()/blockWebPageNotifications()`（L1673/1692） |
| 全局快捷键 `Ctrl+Shift+Space`、窗口内快捷键（`Ctrl+Shift+S` 启动器等） | `registerGlobalShortcut()`（L3409）、`buildMenu()`（L3475） |
| 单实例 + 二次启动聚焦 | `app.requestSingleInstanceLock` 区（生命周期） |

### 3.6 IPC 与安全基线

- IPC 模式：`ipcMain.handle('config:xxx' / 'session:xxx' / ...)` 命名空间 + 渲染层 preload 桥。**路由语义保持**：`foregroundContents()` 维持"覆盖层可见 → 覆盖层 webContents，否则主窗口 webContents"（源码 L1790–1796，overlay → Web 语义）；**Workspace 不进入通用前台路由**，改用专用 `workspaceContents()` 与定向 `workspace:*` IPC（§5.2）。
- 现有安全基线：`contextIsolation: true`、`nodeIntegration: false`、无任意文件系统 IPC、日志脱敏 `sanitizeLog()`（L114）、`blockWebPageNotifications`。
- 🔧 M3 新增 `workspace:*` 命名空间时**继承并强化**上述基线（§10）。

### 3.7 测试与打包

- 单测：`tests/test-*.js`（node assert 无框架，逐文件运行）；mock 服务 `scripts/mock-kimi-server.js`（端口 58999，`KIMI_DESKTOP_TEST_BASE/TOKEN` 注入）；WS 探测 `scripts/ws-event-probe.js`。
- 打包：`npm run pack:versioned` / `pack:versioned:ca`（需 `NODE_OPTIONS=--use-system-ca`）；`build.files` 已含 `src/pages/*.html/js`、`src/pages/vendor/**`、`src/styles/*.css`——**新增面板文件必须落在这些模式内**，否则打包缺失。
- 回归脚本：`scripts/regression-0.29.js`、`scripts/probe-panels.js`、`scripts/screenshot-*`（双主题截图）。

---

## 4. 数据源优先级与能力探测策略

### 4.1 数据源优先级（统一决策表）

| 优先级 | 数据源 | 适用（本计划） | 说明 |
| --- | --- | --- | --- |
| 1 | 官方 REST/OpenAPI（`/openapi.json`）+ WebSocket/AsyncAPI（`/asyncapi.json`、WS 实测） | 会话枚举、能力探测、事件订阅 | 会话枚举/删除/归档的 REST 端点存在性**待 M1 探测**（不预先断言"已走 REST"）；WS 已是桌面事件通道（源码核对） |
| 2 | 官方 Web UI 状态（URL 变化、页面内可探测状态） | 活跃会话/工作目录切换感知 | 通过 Electron 导航事件探测，不做深度 DOM 注入（§5.4） |
| 3 | 本地只读会话/工作区数据（`session_index.jsonl`、`state.json`、`wire.jsonl`、`tasks/`、`cron/`） | Changes 的 Git 计算、Agents/Tasks 投影、工作目录解析 | 只读；官方警告 sessions/ 下文件勿手动编辑——绝不写 |
| 4 | CLI 命令（`kimi` 子命令 stdout） | 用量/状态等无 API 场景（沿用 `local-command-service.js` 契约） | 有解析脆弱性，仅作补充 |
| 5 | ACP | **非必需数据源**：Agents/Tasks 的必需数据源仅官方 WS/REST + 本地只读 sessionDir（Agents 第一版以磁盘快照为准，见 §8.3）；已有 ACP 内存观察若自然存在仅作**低置信附加信息**，**不启动 ACP、不影响出口标准、不成为模块依赖** | 不扩展 `acp-client.js` 的 fs/terminal；不建多会话运行时；**Workspace 候选/上下文链不得调用 `getAllSessionsMerged()`（其内部 `querySessionsViaAcp()` 会启动 `kimi acp`，§5.3）** |

### 4.2 能力探测策略（M1 执行）

1. **能力登记优先扩展现有实现**：以 `detectServerCaps()`（main.js L717）的现有 serverCaps 为基础扩展登记表；**只有 M1 证明确有必要（如条目膨胀、结构不适用）才新建独立 capability-registry**，否则沿用 serverCaps。
2. **REST 面**：抓取 `/openapi.json` 全量 `paths`，逐项登记方法/路径形态；对照现有 `detectServerCaps`（archive/delete/models）扩展登记表（会话、模型、用量、文件、diff 等端点是否存在——**存在性一律以实测为准，M1 完成前全部标注"待探测"**）。
3. **事件面**：抓取 `/asyncapi.json`（**端点是否存在本身待探测**；`docs/ROADMAP.md` 提及双 schema 端点仅作文档线索、不构成结论）；同时用 `scripts/ws-event-probe.js` 扩展实测：活跃会话期间记录到达的全部事件名与 payload 字段（usage/task/approval/question/session.* 等），与 `runtime-event-normalizer.js` 当前白名单对比。
4. **探测产物**：`docs/web-shell-capability-audit.md`（新建），包含：REST 端点清单、WS 事件清单（实测字段样例）、能力矩阵（✅ 已确认 / 🔍 待实测 / ❌ 不存在）、对 M3/M4 数据源选型的结论。
5. **探测纪律**：所有结论标注来源与日期；`/asyncapi.json` 不存在或字段缺失时按"不存在"降级（§8），**不得凭猜测虚构事件 schema；M1 未完成项一律保持"待探测"，不写完成时态**。

---

## 5. 目标架构

### 5.1 总体结构（主窗口三层）

```
主窗口 BrowserWindow（contentView）
├── kimi web                          ← 官方 Web UI（唯一对话面，仍承载于 BrowserWindow.webContents，
│                                         不迁入 WebContentsView；占满内容区）
│      └── 主进程侧最小钩子：did-navigate / did-navigate-in-page 探测（§5.4）
├── Workspace Panel WebContentsView   ← 本地覆盖式面板（固定宽度、可折叠，覆盖右侧区域，见 §5.2）
│      └── src/pages/workspace.html + workspace.js（Changes/Files/Agents/Tasks 四标签）
│      └── preload: src/preload/workspace-preload.js（新）
└── overlayView（现有机制保留）        ← sessions/setup 全屏覆盖层，z-order 最高（§5.2）
主进程只读服务（新增模块，全部无 electron 依赖、可单测）
├── detectServerCaps/serverCaps（现有） ← M1：优先扩展现有能力登记；仅证明确有必要才新建 capability-registry
├── src/main/session-workspace.js     ← 已验证会话 → 工作目录映射解析（🆕）
├── src/main/git-service.js           ← 只读 Git 变更计算（HEAD/index/untracked）（🆕）
├── src/main/file-browser.js          ← 白名单只读文件枚举/预览（🆕）
└── src/main/workspace-projection.js  ← Agents/Tasks 只读投影（复用 normalizer/state/tree，catalog 改造接入）（🆕）
IPC 命名空间：workspace:*（面板 ⇄ 主进程，定向路由，不经 foregroundContents()）
```

### 5.2 面板布局与窗口组合（覆盖式，唯一架构决定）

- **覆盖式**：`mainWindow.contentView.addChildView(workspaceView)`，`setBounds` 覆盖 `BrowserWindow.webContents` 内容区右缘，**固定宽度**（默认 320–400px 区间内取定值，第一版不做拖拽调宽）；可折叠（折叠即移除/隐藏视图，`kimi web` 回满内容区）。**不把 `kimi web` 迁入 `WebContentsView`、不宣称并排**。
- **z-order（由高到低）**：`overlayView`（sessions/setup 全屏覆盖层）> Workspace Panel > `BrowserWindow.webContents`。**overlay 显示时 Workspace 隐藏（或置于其下），关闭覆盖层后恢复**；面板不得覆盖在 overlay 之上。
- **路由**：`foregroundContents()` 语义保持不变（overlay → Web，源码 L1790–1796）；Workspace 使用专用 `workspaceContents()` 与定向 `workspace:*` IPC，**不进入通用前台路由**。
- **窗控区**：`WebContentsView` 没有自身 `titleBarOverlay`；Workspace bounds **必须避开主窗口右上角窗控/菜单区域**（无边框窗口自定义窗控所在区域），不得遮挡最小化/最大化/关闭按钮与顶栏菜单。
- **焦点返回**：面板折叠/关闭/销毁后焦点显式返回 `mainWindow.webContents`；面板获得焦点时不拦截全局快捷键。
- **销毁顺序（显式）**：先移除视图并**仅取消 Workspace 自有资源**——事件转发监听、`workspace:*` IPC 订阅、防抖 timer/轮询、渲染层监听 → 再 `webContents.close()`（必要时 `destroy()`），避免监听器悬挂与 webContents 泄漏；**不得停止主进程共享 WS、托盘、通知与 runtimeState**（面板关闭后共享 WS 保持连接，事件照常处理，仅不再转发给已销毁的面板；验收见 §11 用例 9、§12.1）。
- **窗口联动**：resize 时重排面板 bounds（仅固定宽度下的高度/位置计算）；主题切换时对面板 webContents 执行 `applyAppThemeClassTo`（复用现有机制）。
- **面板 webPreferences**：与覆盖层完全一致（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`、`partition: 'persist:kimi-code'`、`additionalArguments: ['--kcd-main-window']`）+ 独立 preload `workspace-preload.js`（只暴露 `workspace:*` 桥）。
- **资源**：新增 `src/pages/workspace.html`、`src/pages/workspace.js`、`src/preload/workspace-preload.js`、`src/styles/workspace.css`（可选，优先复用 kimi-theme.css 令牌）；`build.files` 模式已覆盖，无需改 package.json（除非引入新目录，见 §7 各阶段）。

### 5.3 会话切换与面板状态生命周期（活动工作区安全）

- 面板显示"当前会话"上下文（工作目录、会话 ID、更新时刻）；切换会话 = 面板刷新数据（M3/M4 服务重算），**不重建面板视图**。
- 会话切换感知源（按优先级）：① 主进程 `did-navigate-in-page`/`did-navigate` 捕获 kimi web URL 变化（无 DOM 注入，Electron 原生事件）；② WS `session.*` 事件；③ 本地 `session_index.jsonl` 最近更新条目（近似，**低置信**）。
- **候选服务（不含 ACP）**：面板的会话/工作区候选列表与上下文解析**新建**专用候选服务（建议在 `src/main/session-workspace.js` 内实现），数据源仅限：官方 REST 会话枚举（**存在性待 M1 探测**）、Web 导航状态（`did-navigate` 等）、本地 `session_index.jsonl`；**一律不调用 `getAllSessionsMerged()`**——其内部 `querySessionsViaAcp()` 会创建 `AcpClient` 并启动 `kimi acp`，面板必须避免任何 ACP 启动副作用。既有启动器（sessions/setup 覆盖层）可继续使用 `getAllSessionsMerged()`，面板不得依赖。
- **活动工作区安全门禁**：URL/WS/最近索引推断出的低置信映射**只能用于展示候选（会话/工作区候选列表）**，**不得授权 Files/Git 读取**。仅以下两种情形可启用 Changes/Files 数据服务：
  1. 确定的 `sessionId -> canonical workDir/sessionDir` 映射（如 `did-navigate` 携带的明确会话标识并经本地索引双向核对）；
  2. 用户显式从已知会话/工作区候选列表中选择。
  无法确认时，Changes/Files 显示**未绑定空态**（"未绑定工作区"，附候选入口），不读取任何文件系统。
- 无会话/未就绪时面板显示空态（"等待 Web UI 会话就绪"），复用 `loading.html` 的视觉语言。

### 5.4 页面钩子纪律（最小可探测钩子）

| 钩子 | 是否允许 | 实现方式 | 理由/降级 |
| --- | --- | --- | --- |
| URL/导航变化探测 | ✅ | 主进程 `webContents` 的 `did-navigate` / `did-navigate-in-page` 事件 | Electron 原生 API，非 DOM 注入；用于会话/工作目录切换感知 |
| `#token=` 片段注入 | ✅（既有） | 主进程拼接 URL | 已是现状，不动 |
| 深链 `?action=create-in-dir&workDir=` | ✅（既有） | 主进程拼接 URL | 已是现状，M5 增强 |
| 页面内选择器点击（如 `.btn-new-chat`） | ⚠️ 受限 | 仅在"无导航事件可依据"且功能必需时，经 `executeJavaScript` 使用**带版本探测的候选选择器**（参照 README v0.19.0 新建对话候选数组做法） | 每次使用必须在能力登记表（**优先扩展 serverCaps；仅 M1 证明确有必要才新建 capability-registry**）登记选择器与实测日期；探测失败立即降级，不做多级重试 |
| 页面 DOM 读取/样式注入 | ❌ 禁止 | — | 脆弱且违背"Web UI 主导"；面板所需数据一律走本地服务/事件通道 |

**红线**：任何页面钩子不得修改官方页面 DOM 结构、不得读取其内部 React 状态、不得用于复制对话渲染内容；页面钩子总数控制在 ≤2 处（导航探测 + 备选）。

---

## 6. 六个里程碑总览

> 粒度按人日（1 人实施）。M1 是全局前置；M2 是面板 UI 前置；M3/M4 数据服务与 M2 面板**按依赖关系顺序或任务级交错执行（单人顺序实施，不称真正并行）**；M5/M6 可在 M3/M4 稳定后交错推进（见"交错车道"）。

| 里程碑 | 名称 | 内容概要 | 前置 | 预计工作量 | 出口可发布 |
| --- | --- | --- | --- | --- | --- |
| **M1** | 能力审计与外壳契约 | openapi/asyncapi/WS 全量探测，能力登记（优先扩展 serverCaps，仅必要才新建注册表），审计文档产出 | 无 | 2–3 人日 | 否（纯研究，但可并入下一版发布） |
| **M2** | 主窗口 Workspace 面板组合 | 覆盖式右侧 WebContentsView（固定宽度、可折叠）、会话上下文、主题/窗口联动、workspace:* IPC 骨架、空态 | M1 | 4–6 人日 | 是（空面板 + 骨架，feature flag 默认关） |
| **M3** | Changes/Files 只读服务与 UI | git-service、file-browser、session-workspace、Changes 列表 + Files 树 | M1（数据）／M2（UI） | 5–7 人日 | 是（候选发布门 1：Changes/Files 首版） |
| **M4** | Agents/Tasks 活动投影 | workspace-projection（normalizer/state/tree 复用，catalog 改造）、Agents 树 + Tasks 列表 UI | M1（数据）／M2（UI） | 5–7 人日 | 是（候选发布门 2） |
| **M5** | Web 主导整合边界 | 通知/聚焦/深链增强、双 UI 去重评估与实施、Web 主导边界清单落地 | M2 | 2–3 人日 | 随后续发布门 |
| **M6** | Windows 回归、安全门禁与发布 | 托盘/通知/快捷键/单实例回归、fs/Git 安全审计、测试矩阵执行、打包与回滚流程 | M3+M4+M5 | 2–3 人日 | 是（正式发布候选就绪，版本号由发布门决定） |

**交错车道（单人顺序执行，仅任务级交错，不称真正并行）**：
- 车道 A（数据）：M1 → M3（git-service/file-browser/session-workspace）→ M4（workspace-projection）。
- 车道 B（UI）：M2（面板宿主）→ M3/M4 面板页面，依赖 A 车道的数据 API 时等待。
- 车道 C（整合）：M5 → M6，可在 M3/M4 稳定 API 落定后交错推进。

**总工作量**：约 19–28 人日（**覆盖式方案重新校准**，含测试与回归；单人顺序执行）。**发布门（不承诺固定版本号）**：M3 完成 → 候选发布门 1（Changes/Files 发布候选）；M4 完成 → 候选发布门 2（Agents/Tasks 发布候选）；M5+M6 完成 → 正式发布候选（"Web Shell + Workspace"宣发）。每次发布门的具体版本号（不再预设 v1.8/v1.9/v2.0）由发布人按发布节奏决定。feature flag：`config.json` 新增 `workspacePanelEnabled`（默认 false；发布候选开启策略见 §12.3）。

---

## 7. 分阶段任务清单（任务 / 涉及文件 / 验收标准）

### M1 能力审计与外壳契约

| # | 任务 | 涉及文件（建议） | 验收标准（可观察） |
| --- | --- | --- | --- |
| M1-1 | 抓取并登记 `/openapi.json` 全量 paths（方法/路径/参数），与现有 `detectServerCaps` 白名单对比，确认会话/模型/用量/文件/diff 类端点存在性（**存在性均以实测为准，M1 完成前全部标注待探测**） | 探测脚本 `scripts/capability-audit.js`（新）；能力登记**优先扩展现有 `detectServerCaps`/serverCaps**，仅 M1 证明确有必要才新建 `capability-registry.js` | 审计脚本退出码 0；输出含全部端点清单与"存在/不存在/待探测"结论 |
| M1-2 | 抓取 `/asyncapi.json`（**端点是否存在以实测为准**；存在则登记事件清单与 schema；不存在则记录"不存在"并降级） | 同上 | 结论明确标注：存在→事件清单；不存在→降级说明 |
| M1-3 | 扩展 `scripts/ws-event-probe.js` 实测活跃会话期间到达的全部事件名与 payload 字段，与 `runtime-event-normalizer.js` 白名单对比 | `scripts/ws-event-probe.js`（改） | 事件清单文档化：已覆盖/缺失/字段差异逐项标注 |
| M1-4 | 产出 `docs/web-shell-capability-audit.md`：能力矩阵（✅/🔍/❌）+ 对 M3/M4 数据源选型的结论 + 待实测项 | `docs/web-shell-capability-audit.md`（新） | 文档评审通过；M3/M4 每项数据源决策可回溯到该文档条目 |
| M1-5 | 确认会话/工作目录切换的可探测途径：`did-navigate-in-page` 实测（URL 是否携带会话标识/路径）、`session_index.jsonl` 最近更新条目置信度 | 实测记录（写入 M1-4 文档） | 结论明确：探测源可用性 + 置信度分级；**低置信源仅可展示候选、不得授权 Files/Git 读取（§5.3）**；不确定项列入 §12.2 |

**M1 出口**：能力矩阵 + 审计文档入库；能力登记（serverCaps 扩展或新建注册表，以 M1 结论为准）单测通过。

### M2 主窗口 Workspace 面板组合

| # | 任务 | 涉及文件（建议） | 验收标准（可观察） |
| --- | --- | --- | --- |
| M2-1 | 面板 WebContentsView：创建/覆盖右缘（**固定宽度**）/折叠/z-order（overlay > Workspace > Web）/关闭清理（复用 `ensureOverlayView` 范式抽象出 `ensureDockView`）；**显式销毁顺序**（先移除视图并**仅取消 Workspace 自有资源**——事件转发监听/`workspace:*` IPC 订阅/防抖 timer/轮询/渲染监听，**不停主进程共享 WS**，再 `webContents.close()`） | `src/main/main.js`（面板区）；`src/pages/workspace.html`（新，骨架 + 四标签空态）；`src/styles/workspace.css`（新，或内联） | 面板可开/关/折叠（**无拖拽调宽**）；resize 联动正确；**overlay 显示时面板隐藏、关闭后恢复**；**bounds 不遮挡右上角窗控/菜单区**；无泄漏（关闭面板后 webContents 显式 close）；**反复开关 ≥10 次期间共享 WS 持续连接（连接数与 generation 不变）、托盘/通知/runtimeState 不受影响（§11 用例 9）** |
| M2-2 | 会话上下文服务：解析当前会话（导航事件/WS/本地索引三源，§5.3）→ `{ sessionId, workDir, confidence }`；**低置信结果仅返回候选列表，不授权数据读取**；无确定映射时返回未绑定状态 | `src/main/session-workspace.js`（新，纯 Node）；main.js 接线 | 单测覆盖三源解析与置信度分级：低置信仅候选展示；用户显式选择后才置为已绑定；未绑定状态下面板显示空态、**不触发任何文件读取** |
| M2-3 | `workspace:*` IPC 契约：`workspace:getContext`、`workspace:panelState`（开/关/折叠持久化到 config.json）、`workspace:event`（主进程推送，如会话切换/主题变化）；**定向路由，不经 `foregroundContents()`** | `src/preload/workspace-preload.js`（新）；main.js IPC 区；workspace.html | preload 仅暴露白名单通道；渲染层收到 `workspace:event` 可刷新上下文 |
| M2-4 | 主题/窗控联动：面板 webContents 主题类下发；**面板 bounds 避开右上角窗控/菜单区**（`WebContentsView` 无自身 `titleBarOverlay`，§5.2）；`--kcd-main-window` 拖拽条 | main.js 现有 `applyAppThemeClassTo` 扩展；布局计算 | 亮/暗切换后面板即时跟随；面板不遮挡右上角窗控/菜单；`scripts/screenshot-*` 双主题截图通过 |
| M2-5 | feature flag：`config.json workspacePanelEnabled`（默认 false）+ 菜单/托盘入口（"视图→工作区面板"） | main.js 配置/菜单区 | **flag 关闭时完全不创建面板 `WebContentsView`（行为等同现状）**；开启时入口可用 |

**M2 出口**：flag 默认关下全部原生页面回归无回归；flag 开启时面板骨架可用、无控制台错误；单测（`tests/test-session-workspace.js`）通过。

### M3 Changes/Files 只读服务与 UI

| # | 任务 | 涉及文件（建议） | 验收标准（可观察） |
| --- | --- | --- | --- |
| M3-1 | `git-service.js`：只读计算工作树变更——**`git status --porcelain=v2 -z`**（NUL 分隔，可靠处理含空格/制表符/换行路径；`2.` 记录解析 rename `srcPath -> dstPath`）+ **`git diff --numstat -z`**（工作树 vs index）+ **`git diff --cached --numstat -z`**（index vs HEAD），**三条命令输出均以 NUL 为字段分隔符**；汇总为 `ChangeEntry { id, path, status: added/modified/deleted/renamed/untracked, unstaged: { adds, dels }, staged: { adds, dels } }`——**staged/unstaged 各为独立统计对象，不再使用歧义的单个 `staged` 布尔**；每条目携带本快照内唯一的不可伪造 `id`（diff 预览凭此引用，§8.1）；路径处理按 §10.3 契约：存在文件用 canonical realpath 校验；deleted 文件/rename 源路径用 lexical containment + 最近存在父目录 canonicalization；**非 git 仓库 → Changes 直接空态（"非 Git 仓库"），Files 独立可用** | `src/main/git-service.js`（新，纯 Node，spawn git 只读参数白名单） | 单测：三类变更混合仓库统计正确；**rename 与含空格/制表符/换行路径解析正确（NUL 分隔契约）**；**staged 与 unstaged 分开断言（不合并求和）**；`git` 缺失/非仓库 → `{ ok:false, reason }` 不崩溃且 Changes 空态、Files 可用；无任何 git 写参数泄漏（参数白名单断言） |
| M3-2 | 变更详情：单文件 diff 预览——**请求必须引用当前 Git 快照返回的不可伪造 `entryId`/受控条目，不接受渲染层任意路径**（`git diff -- <path>` / `--cached`，路径由服务按快照条目解析并置于 `--` 之后）；**diff 输出边读边限额**（流式读取，达上限即截断并标注"已截断"，不整段缓冲）；**第一版为后续可选任务，不阻塞 M3 出口**（Changes 首版可先只做列表） | git-service.js | 大文件 diff 不卡死主进程（边读边限）；预览内容与 `git diff` 输出一致；**渲染层传入任意路径/过期 `entryId` 被拒绝（单测）** |
| M3-3 | `file-browser.js`：白名单只读枚举/读取——根 = **已验证**的活动会话工作目录（§5.3）；路径规范化（`realpath`）、symlink/junction 解析后必须在根内、跳过 `.git` 与 `node_modules`（可配置）、单文件读取上限（默认 1 MB）、单次枚举条目上限（默认 500） | `src/main/file-browser.js`（新，纯 Node） | 单测：越界路径（`../`、绝对路径、symlink/junction 逃逸）全部拒绝；超限文件拒绝并给原因；空目录正常 |
| M3-4 | Changes/Files 面板 UI：四标签（Changes/Files/Agents/Tasks 骨架全建，M4 填充后两标签）；Changes 列表（path/status/adds/dels、**staged/unstaged 分列**、diff 展开为可选——**无 `touched-by-session` 徽标，该功能已删除**）、Files 树（目录展开、文件预览） | `src/pages/workspace.html`、`workspace.js`；preload 桥补 `workspace:changes`、`workspace:files` 通道 | 手动验收：在真实仓库改文件 → 面板 Changes 出现条目且 staged/unstaged 统计正确；untracked 新文件出现且标注；预览可开合（若实现）；"工作树基线"说明文案可见 |
| M3-5 | 节流与缓存：变更计算 3s 防抖 + 前台窗口焦点变化/会话切换触发刷新；面板隐藏时不刷新 | workspace.js + main.js | 连续编辑期间 CPU 不飙升（观察任务管理器）；切会话数据正确换源（仅已验证会话） |

**M3 出口**：`tests/test-git-service.js`、`tests/test-file-browser.js` 通过；flag 开启下真实仓库全流程手测通过；**候选发布门 1**（Changes/Files 首版发布候选，版本号由发布人定）。

### M4 Agents/Tasks 活动投影

| # | 任务 | 涉及文件（建议） | 验收标准（可观察） |
| --- | --- | --- | --- |
| M4-1 | `workspace-projection.js`：对当前**已验证会话**返回 `{ agents: SubagentNode[], tasks: CatalogEntry[], diagnostics }`——`buildSubagentTree(sessionDir)` + **改造后的 task-catalog 适配层**（接收已验证的具体 `sessionDir`，不依赖 `sessionsRoot` 全量扫描，见 §3.2、§8.4）只读组合（**Agents 部分以已验证 `sessionDir` 磁盘快照为必需来源，§8.3**）；无已验证会话目录 → 空态 + 原因 | `src/main/workspace-projection.js`（新，纯 Node）；`src/main/task-catalog.js`（🔧 改造或新增适配层） | 单测：正常会话树结构正确；**task-catalog 以具体 `sessionDir` 调用与 `sessions/<workDirKey>/<sessionId>` 两级目录布局对账一致（含 `sessionsRoot` 扫描不匹配场景）**；目录缺失/坏文件诊断计数正确且不抛错 |
| M4-2 | Agents 标签 UI：按 `subagent-tree.js` 的 `SubagentNode` 渲染层级树（main 根 + 子代理分组、状态色、步骤摘要、`__unknown__` 分组）——**信息架构借鉴参考项目 agents-tab，不复制其代码** | workspace.html/js | 与现有 `agents.html` 监视器数据一致（同源同解析）；父子关系/状态/步骤与 wire.jsonl 对账 |
| M4-3 | Tasks 标签 UI：`CatalogEntry` 列表（task/subagent/cron 三类、状态、来源 badge ws/disk、置信度；**ACP 观察仅作低置信附加 badge，不启动 ACP、不影响出口标准**） | workspace.html/js | 与 `scripts/mock-kimi-server.js` 场景（task.started/progress/completed）联测正确；cron 条目展示（若 M1 探测到 cron 数据源） |
| M4-4 | 活动增量：WS 事件经现有 `runtimeState.apply()` 后，主进程按 1s 防抖向面板推 `workspace:event({ kind:'activity', sessionId })`，面板仅重取投影快照——**不做消息级 reducer/增量合帧**；**Agents 标签的实时跟随仅在 M1 实测发现官方 Web WS 子代理事件并扩展 normalizer 后生效（§8.3），否则 Agents 维持磁盘快照口径** | main.js 接线 | 面板数据 ≤1.5s 跟随活动变化（Tasks 以 `task.*` 为准）；无事件风暴（防抖断言） |
| M4-5 | 历史快照：会话切换/刷新时首次加载读 sessionDir 下 `state.json`、`tasks/*.json` 等构成**一次性磁盘快照**（只读，非 replay 运行时）；**第一版 Agents 以磁盘快照为准、Tasks 以磁盘快照 + 现有 WS `task.*` 为准，不追求完整历史实时重建**；官方 WS 子代理事件仅当 M1 实测存在并扩展 normalizer 后才接入（§8.3） | workspace-projection.js | 恢复历史会话后面板显示该会话已有 Agents/Tasks 记录（快照口径，标注采集时刻） |

**M4 出口**：`tests/test-workspace-projection.js` 通过（含 task-catalog 适配对账用例）；mock + 真实会话双路径手测通过；**候选发布门 2**。

### M5 Web 主导整合边界

| # | 任务 | 涉及文件（建议） | 验收标准（可观察） |
| --- | --- | --- | --- |
| M5-1 | 通知去重与聚焦：审批/任务完成通知保持"仅通知 + 点击聚焦主窗口"（现状策略，不新增审批按钮）；实测 Web UI 自身是否渲染审批/追问 UI，若双 UI 并存则评估关闭桌面弹窗路径。**question 目标态：Web UI 优先（默认所有权），桌面仅通知/聚焦；仅当 M1 证明对应 Web 版本不支持提问时，现有本地 question 窗才作为兼容 fallback，不是默认所有权路径** | main.js WS 区、question 窗区 | 结论落文档；无"同一审批弹两次"的可见冲突（手测）；question 所有权结论依据 M1 探测证据 |
| M5-2 | 模型/权限/Plan/Swarm/上传/Slash/队列边界清单：桌面**不复制**任何对应控件；托盘"默认模型"菜单（既有能力，写 config.toml）保留但 UI 文案标注"默认配置，会话内切换请在 Web UI 操作" | 托盘/菜单区（文案与文档） | 清单入文档 §9；手测 Web UI 内切换与桌面默认配置互不打架 |
| M5-3 | 深链增强：`create-in-dir` 后面板自动聚焦新会话工作目录；通知点击定位对应会话（经 `--session` 重启或 WS 事件对齐）——**深链可探测性待 M1 确认** | main.js 会话/通知区 | 深链建会话 → 面板上下文 3s 内切换为新目录（**若 M1 证明深链可探测；否则仅聚焦主窗口**）；通知点击 → 主窗口聚焦 |
| M5-4 | 面板与 Web UI 的键盘/焦点边界：面板聚焦时不拦截 Web UI 快捷键（`Ctrl+Shift+S` 等全局保留）；Esc 折叠面板 | workspace.html/js + main.js | 快捷键矩阵回归（§11）全过 |

**M5 出口**：边界清单文档评审通过；双 UI 去重结论落地且可验证。

### M6 Windows 回归、安全门禁与发布

| # | 任务 | 涉及文件（建议） | 验收标准（可观察） |
| --- | --- | --- | --- |
| M6-1 | Windows 回归矩阵执行（§11）：托盘/通知/快捷键/单实例/覆盖层/面板场景（**托盘单击/双击均按源码现状"显示主窗口"实测，不预设"双击新会话"，L3102–3103**）；**面板反复开关 ≥10 次期间共享 WS 持续连接**；**feature flag 关闭路径（`workspacePanelEnabled:false` 行为等同 v1.7 基线）** | 手测清单 `docs/` 下新增或复用 | 矩阵全绿或有明确结论 |
| M6-2 | 安全门禁：`workspace:*` IPC 审计（仅白名单通道、入参校验）、git-service 参数白名单断言、file-browser 逃逸用例复跑、日志脱敏复核（新增路径日志） | git-service/file-browser/main.js | 审计清单全过；无新暴露的任意路径 IPC |
| M6-3 | 打包验证：`npm run pack:versioned:ca`，产物内确认 workspace.html/js/preload/新模块在列（`build.files` 模式覆盖性验证） | package.json（如需调整 files 模式，仅此文件可改） | 安装包运行后 flag 开启面板可用；未打包缺失项零 |
| M6-4 | 发布与回滚流程文档（§12.3 落地）：flag 开关、发布顺序、回滚操作 | 文档 | 流程演练通过（flag 关闭即回退到 v1.7 行为） |
| M6-5 | 发布候选全量回归（flag 开启策略由发布门决定，见 §12.3） | main.js 配置默认值 | 正式发布候选通过全部矩阵；flag 关闭回归确认回退到现状 |

**M6 出口**：全部矩阵绿（**含 feature flag 关闭路径、面板反复开关、共享 WS 持续连接、Git 特殊路径与 deleted/rename 路径安全**）；安全审计零未决项；正式发布候选就绪（版本号与 flag 开启策略由发布门决定）。

---

## 8. Changes / Files / Agents / Tasks 详细数据来源与降级

> 信息架构借鉴参考项目 `kimi-code-desktop-master` 的 workspace 模块（changes-panel/files-tab/agents-tab/tasks-tab 的分区与条目形态），**不复制其源码、数据管线与 React 实现**。

### 8.1 Changes（变更）

- **事实源**：活动工作树相对 Git 基线 = `HEAD`（已提交基线）∪ `index`（暂存区）∪ untracked（未跟踪文件）。
  - **`git status --porcelain=v2 -z`** → 状态分类（`1.`/`2.`/`?` 等记录，映射 added/modified/deleted/renamed/untracked）；`-z` 以 NUL 分隔，**可靠处理含空格/制表符/换行的路径**；rename 由 `2.` 记录解析 `srcPath -> dstPath`；
  - **`git diff --numstat -z`** → 工作树 vs index 的 adds/dels（**输出同样 NUL 分隔**）；
  - **`git diff --cached --numstat -z`** → index vs HEAD 的 adds/dels（**输出同样 NUL 分隔**）；
  - 汇总为 `ChangeEntry { id, path, status, unstaged: { adds, dels }, staged: { adds, dels } }`：同一 path 的暂存与非暂存变更**分别保存为 `staged`/`unstaged` 两个独立统计对象，不简单求和声称"净变化"、不使用歧义的单个 `staged` 布尔**；每条目携带当前快照内唯一的不可伪造 `id`；diff 预览输出**边读边限额**（§10）。
- **路径契约**：存在文件用 canonical realpath 校验在根内；**deleted 文件/rename 源路径已不在磁盘上，改用 lexical containment（`path.relative` 不外逃）校验 + 沿路径向上取最近存在父目录做 canonicalization 比对**；传给 git 的路径一律来自服务返回的**受控相对路径**并置于 `--` 之后，杜绝注入。**diff 预览请求必须引用当前 Git 快照返回的 `entryId`/受控条目，不接受渲染层任意路径**（快照过期即拒绝）。
- **不承诺**：Changes 是"当前工作树视图"，**不是"本会话修改集合"**。工作树由用户/外部工具/其他会话共同变更，桌面无法也不试图归因（`touched-by-session` 功能已按评审决定删除）。
- **降级链**：git 命令失败/超时 → 重试 1 次 → 失败则 Changes 显示空态 + 原因；**非 git 仓库直接 Changes 空态（"非 Git 仓库"），Files 独立可用**。**官方是否存在独立 diff API 待 M1 探测**（不预先断言），探测确认存在前不依赖服务端 diff。
- **UI 语义**（对齐参考项目信息架构但简化）：按 path 排序分组、status 徽标、adds/dels 数字（staged/unstaged 分列）、diff 展开为**后续可选任务**（第一版可先只做列表）；无 Approve/Reject/全部批准类操作——审批权在 Web UI。

### 8.2 Files（文件浏览）

- **事实源**：主进程 `file-browser.js` 只读枚举活动工作目录（根 = `session-workspace` 解析出的 workDir，**仅限已验证的 `sessionId -> canonical workDir` 映射或用户显式选择，见 §5.3**；未绑定时显示未绑定空态）。
- **条目形态**：`{ path, name, type: dir|file, size, mtime }`（借鉴参考项目 `SessionFileEntry` 的字段形态）。
- **能力**：目录展开、文件内容预览（文本，UTF-8，超限截断）、复制路径。**无**上传/下载/编辑/删除。
- **降级**：未绑定/低置信 → **未绑定空态 + 候选入口（不触发任何文件系统读取）**；工作目录不可达/被删 → 空态 + 原因；权限拒绝 → 单目录错误态不中断遍历；symlink 逃逸目标直接跳过并记 diagnostics。

### 8.3 Agents（子代理投影）

- **事实源**（第一版）：已验证会话目录 `sessions/<workDirKey>/<sessionId>/` 的**磁盘快照**（仅已验证映射可访问，§5.3）：
  1. `state.json` 的 `agents` 映射（父子关系唯一来源）；
  2. `agents/<id>/wire.jsonl`（`context.append_loop_event` 步骤补绘，`subagent-tree.js` 已实现）；
  3. **活动态增量（条件启用）**：当前 `runtime-event-normalizer.js` 对官方 WS 事件的规范化结果 `agentType` 恒为 `null`，**不产出 Agents 生命周期数据；`SubagentStop` 仅作完成提示、不算生命周期数据**。因此 **Agents 第一版以磁盘快照为必需来源，不宣称具备完整 Agents 实时流**；**仅当 M1 实测发现官方 Web WS 存在子代理事件后，才扩展 `runtime-event-normalizer`（新增事件形态映射、使 `agentType` 可判）并启用实时更新**；已有 ACP 观察若自然存在仅作低置信附加信息，**不启动 ACP、不成为依赖**。
- **展示**：`SubagentNode` 层级树（main 根、parentAgentId 层级、`__unknown__` 分组、状态色 running/completed/failed/interrupted、步骤折叠、父调用启发式匹配结果）。
- **降级**：无 `state.json` → 按目录枚举，全部置顶层（既有降级路径）；wire 坏行 → diagnostics 计数展示；父链成环 → `__unknown__`。
- **数据源优先级**：**磁盘快照（必需、第一版唯一来源）> 官方 WS 实时事件（仅当 M1 实测确认存在子代理事件后才启用，启用后作为增量刷新、优先级高于快照）**；二者以同一已验证 `sessionId` 对齐，不做跨会话合并；**第一版不追求完整历史实时重建**。

### 8.4 Tasks（任务/定时任务投影）

- **事实源**：改造后的 `task-catalog.js` 以**已验证的具体 `sessionDir`** 调用（§3.2、M4-1 适配层），合并序：内存 runtime 快照（**官方 WS `task.*` 事件**，优先级最高）→ 磁盘 `tasks/*.json` 与 `cron/*.json`（防御性解析，`confidence: medium/low`）。已有 ACP 内存观察若自然存在仅作**低置信附加信息**（标注 `acp` badge），**不启动 ACP、不得影响出口标准、不得成为模块依赖**。现有 `sessionsRoot` 全量扫描与 `sessions/<workDirKey>/<sessionId>` 两级目录**可能不匹配**，适配以测试证实（M4-1）。
- **展示**：条目列表 `{ kind: task|subagent|cron, title, status, source: ws/disk（acp 仅作低置信附加）, confidence, updatedAt, detail }`；来源 badge 与置信度可见（避免把低置信解析当事实）。
- **降级**：无 tasks/cron 目录 → 空态；坏文件 → diagnostics 计数；cron 字段缺失 → `detail.missing` 标注（沿用 task-catalog 现有语义）。
- **不复制**：参考项目的任务操作（暂停/恢复/取消等）一律不实现；操作权在 Web UI/TUI。

---

## 9. Web UI 主导时的桌面整合边界（权限/Plan/Swarm/模型/上传/Slash/队列）

| Web UI 能力 | 所有权 | 桌面行为（仅以下） | 禁止事项 |
| --- | --- | --- | --- |
| 权限/审批（approval） | Web UI | WS `approval.requested` 保持"计数 + 通知 + 点击聚焦"（现状）；M5 实测确认 Web UI 自带审批 UI 后，桌面弹窗路径按实测结论处置 | 不实现审批按钮/面板；不自动审批 |
| Plan 模式 | Web UI | 不展示 plan 内容副本；仅通知层面不重复 | 不渲染 plan 卡片 |
| Swarm/子代理控制 | Web UI | Agents 标签仅**只读投影**（§8.3） | 不提供启动/暂停/派发子代理入口 |
| 模型选择/思考强度 | Web UI（会话内） | 托盘「默认模型」菜单保留（既有写 `config.toml` 能力），文案标注为默认配置；会话内切换引导用户在 Web UI 完成 | 不在面板复制模型下拉/切换控件 |
| 上传/附件 | Web UI | 不参与 | 不实现上传 UI/文件注入 |
| Slash Commands | Web UI | 不参与 | 不实现命令菜单/补全 |
| prompt 队列 | Web UI | 不参与 | 不实现队列 UI/状态 |
| 问答（question） | **Web UI 优先（默认所有权）** | 桌面仅通知/聚焦；**仅当 M1 证明对应 Web 版本不支持提问时，现有本地 question 窗才作为兼容 fallback，不是默认所有权路径**（§5.4、M5-1） | 不新增问答形态；桌面不默认接管 |
| Goal | Web UI/TUI | 不实现 Goal 面板（旧 ROADMAP P1-4 移出）；M1 探测如发现预算事件则仅通知 | 不实现 goal 控制 UI |

**原则**：桌面只做"通知、聚焦、只读投影、默认配置"，一切交互决策在 Web UI。任何"边界清单"未覆盖的新能力需求，先走 §4 数据源优先级评估，再决定是否允许，且默认拒绝。

---

## 10. 文件系统与 Git 安全要求

1. **根目录白名单**：所有 `workspace:*` 文件读取 rooted 在**已验证**的活动会话工作目录（低置信推断仅展示候选，不授权读取，见 §5.3）；IPC 只接受相对路径或受控枚举结果，主进程侧做二次解析与校验。
2. **路径规范化**：`path.resolve` + `fs.realpathSync` 后必须仍在根内（大小写不敏感比较，Windows）；先 `lstat` 检测 symlink/junction，解析目标逃逸根目录即拒绝。**此规则适用于磁盘上仍存在的文件读取/枚举**；**deleted 文件/rename 源路径（磁盘上不存在，无法 realpath）改用 lexical containment + 最近存在父目录 canonicalization 校验（§8.1 路径契约）**。
3. **大小与输出限制**：单文件读取 ≤1 MB（预览截断并标注）；单次枚举 ≤500 条；**diff 输出边读边限额**（流式读取，≤500 KB 或 2000 行，达限即截断标注，不整段缓冲）；所有限制常量集中在服务模块顶部便于审计。
4. **Git 只读**：git 调用参数白名单（`status/diff/ls-files/show` 等只读子命令 + 固定 flag，**机器解析输出一律带 `-z` NUL 分隔，含 numstat**），禁止 `apply/checkout/reset/clean/commit` 等写命令；**路径必须来自服务返回的受控相对路径并置于 `--` 之后；diff 预览请求必须引用当前 Git 快照返回的不可伪造 `entryId`/受控条目，不接受渲染层任意路径**；spawn 参数逐项断言（单测覆盖）；超时（默认 10s）强杀并报错。
5. **不开启 ACP fs 反向 RPC**：本计划期间 `acp-client.js` 的 fs/terminal 能力保持关闭（现状）。
6. **不写会话数据**：绝不写入 `sessions/` 下任何文件（官方警告勿手动编辑）；桌面只读投影不落盘缓存到会话目录。
7. **日志脱敏**：新增日志（工作目录、文件路径）经 `sanitizeLog` 或等价位处理；不记录文件内容。
8. **权限模型**：面板 preload 只暴露 `workspace:*` 白名单 API；渲染层无 `nodeIntegration`、`contextIsolation: true`；面板内不加载远程资源（离线可用，沿用无外部字体/资源原则）。
9. **敏感目录**：`isSensitiveWorkDir` 判定为敏感的目录，面板只显示只读投影并置顶提示，不做任何写路径。

---

## 11. Windows 托盘/通知/快捷键/单实例回归

**M6 必须全绿的回归矩阵**（回归对象为既有能力 + 面板共存场景）：

| # | 项目 | 用例 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 托盘 | 最小化/点 X 收托盘、**单击回窗、双击回窗（按源码现状 L3102–3103：单击与双击均绑定 `showMainWindow`，无"双击新会话"；据此实测，不预设行为）**、右键菜单各项（含新「工作区面板」项） | 全部可用；tooltip 用量/任务状态随 WS 更新 |
| 2 | 通知 | 审批请求/任务完成/问答事件通知出现且只出现一次（无 Web UI 重复）；点击聚焦主窗口 | 无双重通知；点击行为正确 |
| 3 | 快捷键 | `Ctrl+Shift+Space`（全局显隐）、`Ctrl+Shift+S`（启动器）、`Ctrl+Shift+N`、`Ctrl+R`（作用于前台内容）、`Ctrl+,`（设置）、F1 | 面板聚焦时全局快捷键仍生效；`Ctrl+R` 不误刷新面板 |
| 4 | 单实例 | 二次启动 → 已有实例聚焦；面板状态保持 | 无第二进程；无状态重置 |
| 5 | 覆盖层 | sessions/setup 覆盖层显示时 Workspace 面板隐藏（z-order：overlay > Workspace > Web，§5.2）；关闭覆盖层后面板恢复、Web UI 零重载 | 切换无闪烁；**共享 WS 连接不断**；面板按 z-order 正确显隐 |
| 6 | 主题 | 亮/暗切换时面板、覆盖层、主窗口同步 | 截图回归通过 |
| 7 | 优雅退出 | 托盘退出先 `POST /api/v1/shutdown`；面板随窗口销毁无泄漏 | 日志无异常；进程干净退出 |
| 8 | 面板刷新 | 已验证会话切换/窗口焦点变化/3s 防抖刷新；未绑定状态不触发任何文件读取 | 数据新鲜且无事件风暴 |
| 9 | 面板反复开关 | 连续开/关/折叠面板 ≥10 次（含销毁重建）；**每次关闭仅取消 Workspace 自有资源（事件转发监听/`workspace:*` IPC 订阅/防抖 timer/轮询/渲染监听），不停主进程共享 WS** | **共享 WS 持续连接（连接数与 generation 不变，事件照常处理）；无监听器悬挂、webContents 无泄漏；托盘/通知/runtimeState 不受影响** |
| 10 | feature flag 关闭路径 | `workspacePanelEnabled:false` 时完全不创建面板 `WebContentsView`，菜单/托盘「工作区面板」入口隐藏或禁用 | 行为等同 v1.7 基线；用例 1–7 全绿 |

---

## 12. 测试矩阵、发布/回滚、风险与待确认项

### 12.1 测试矩阵

| 层 | 手段 | 覆盖 |
| --- | --- | --- |
| 单元（node assert） | `test-session-workspace.js`、`test-git-service.js`、`test-file-browser.js`、`test-workspace-projection.js`（新）+ 能力登记测试（优先覆盖 `serverCaps` 扩展；**仅当 M1 证明必要新建 capability-registry 时才建 `test-capability-registry.js`**）+ 既有 22 个 | 服务模块纯函数/边界/降级/逃逸用例；**Git 特殊路径（rename/空格/制表符/换行）与 deleted/rename 源路径安全用例**；**面板候选服务不含 ACP 路径断言（不调用 `querySessionsViaAcp()`、不创建 `AcpClient`）** |
| 集成（mock） | 扩展 `scripts/mock-kimi-server.js` 的 task/usage 事件场景（不新增协议） | 面板随 WS 活动刷新；无事件风暴 |
| 渲染 | `scripts/screenshot-*` 双主题截图 + `scripts/probe-panels.js` | 面板四标签亮/暗主题无硬编码色值 |
| 手动回归 | §11 矩阵（**含面板反复开关/共享 WS 持续连接/feature flag 关闭路径**）+ M3/M4 真实仓库手测清单（**含 rename/空格/制表符/换行路径的 Git 变更**） | 发布前全绿 |
| 安全 | git 参数白名单断言、file-browser 逃逸用例、IPC 入参校验用例（**diff 预览仅接受当前快照的 `entryId`/受控条目，任意路径与过期条目被拒**）、**deleted/rename 源路径 containment 用例** | M6 门禁 |

### 12.2 风险与待确认项

| # | 风险/待确认 | 影响 | 处置 |
| --- | --- | --- | --- |
| R1 | `/asyncapi.json` 是否存在（本身待探测）、WS 事件 schema 完整度未知 | M4 活动增量数据源 | M1 实测；不存在则活动增量仅依赖现有 WS 白名单事件 + 磁盘快照 |
| R2 | kimi web URL 是否携带会话标识/工作目录（`did-navigate-in-page` 可探测性） | 会话切换感知精度 | M1-5 实测；**低置信结果仅展示候选，不授权 Files/Git 读取（§5.3）；无法确认时显示未绑定空态** |
| R3 | Web UI 自身渲染审批/追问 UI 时与桌面弹窗/通知重复 | 用户体验与 M5-1 | M5 实测双 UI 并存形态后决定降级路径（保留通知 vs 关闭桌面弹窗） |
| R4 | 大仓库 git 计算耗时 | 面板卡顿 | 3s 防抖 + 超时强杀 + 截断；首次加载显示骨架 |
| R5 | git 参数白名单漏配导致误写 | 安全 | 单测断言 + M6 审计；只允许固定子命令集合 |
| R6 | `build.files` 模式未覆盖新增资源 | 打包缺文件 | M6-3 打包产物内核对；若需新目录（如 `src/pages/workspace/` 多文件）同步调整 package.json files |
| R7 | 覆盖层显示/关闭期间面板 bounds 与窗控采样的交互（面板不进 `foregroundContents()`） | 布局/配色 | M2 手测 + probe-panels 回归 |
| R8 | 会话索引/`state.json` 格式漂移（官方未文档化） | 投影准确性 | 防御性解析 + diagnostics 展示（沿用既有模式）；漂移记录到 §12.2 |
| R9 | 现有 ACP 原生聊天与 Web 主路径的资源竞争（同 CLI 会话并发） | 稳定性 | 本计划不触碰；M6 回归仅确认其不干扰 Web 主路径 |
| R10 | 面板反复开关期间误停共享 WS 或监听器泄漏 | 事件通道中断 | M2-1 显式销毁契约（仅取消 Workspace 自有资源）+ §11 用例 9（反复开关 ≥10 次，共享 WS 连接数/generation 不变） |
| R11 | M1 实测未发现官方 Web WS 子代理事件（当前 normalizer 对官方事件 `agentType` 恒为 `null`） | Agents 仅磁盘快照、无实时增量 | 按 §8.3 条件启用：不扩展 normalizer，Agents 显示快照口径并标注采集时刻；不算缺陷，属第一版范围 |

### 12.3 发布/回滚策略

- **发布门（不承诺固定版本号）**：M3 完成 → 候选发布门 1（Changes/Files 发布候选）；M4 完成 → 候选发布门 2（Agents/Tasks 发布候选）；M5+M6 完成 → 正式发布候选（"Web Shell + Workspace"宣发）。每个里程碑结束可独立发布或回退；**具体版本号（不再预设 v1.8/v1.9/v2.0）与 flag 开启策略由发布人按发布节奏决定**（flag 默认 false，发布候选可按需开启）。
- **回滚**：一级 = `config.json` 置 `workspacePanelEnabled:false`（面板完全不创建，行为等同 v1.7.x）；二级 = 回退安装上一版本安装包（数据不迁移，无 schema 变更）。
- **打包纪律**：`pack:versioned:ca`（`NODE_OPTIONS=--use-system-ca`，严禁 `NODE_TLS_REJECT_UNAUTHORIZED=0`）；产物版本化隔离于 `release/v<version>/`。
- **文档回写**：每个里程碑结束把实测结论回写 `docs/web-shell-capability-audit.md` 与本计划 §12.2（保持单一事实源）。

### 12.4 现有 ACP 原生聊天的处置（独立决策，不在本计划内）

- 现状：`src/pages/chat.html/chat.js`、`src/main/acp-client.js`、permission/question 的 ACP 路径、菜单「原生聊天（新会话）」入口（README v0.10.0–v0.13.0 累积）。
- 本计划立场：**不纳入、不演进、不删除、不启动**；M2–M6 的面板与 IPC 均不与 ACP 链路耦合，**Agents/Tasks 必需数据源仅官方 WS/REST + 本地只读 sessionDir**（已有 ACP 内存观察仅作低置信附加信息，不得启动 ACP、不得影响出口标准、不得成为模块依赖）；M6 回归仅确认其存在不干扰 Web 主路径。
- 可选后续方案（由 orchestrator/用户另行决策）：① 保留（标注实验）；② 从菜单隐藏（保留代码）；③ 完全移除（连同 `acp-client.js`、`chat.*`、`acp-elicitation.js` 等，需评估设置中心/启动器对 ACP session/list 的既有依赖——`getAllSessionsMerged()` 使用 ACP 作为三路之一，移除前必须先把该通道改为可选；**Workspace 面板已不依赖该函数，见 §5.3，不影响本方案**）。**本计划不做任何倾向性选择**。

---

## 13. 交付物清单（本计划）

| 类型 | 文件 |
| --- | --- |
| 本计划 | `docs/WEB_SHELL_ENHANCEMENT_PLAN.md`（本文件，唯一交付物） |
| 计划依据 | `.slim/deepwork/web-shell-enhancement-plan.md`（只读，不改） |
| M1 探测产物（实施时新建） | `docs/web-shell-capability-audit.md`、`scripts/capability-audit.js`；能力登记**优先扩展现有 `detectServerCaps`/serverCaps**，`src/main/capability-registry.js` 仅 M1 证明确有必要时新建 |
| M2–M6 新增模块（实施时新建，见 §7） | `src/main/session-workspace.js`、`src/main/git-service.js`、`src/main/file-browser.js`、`src/main/workspace-projection.js`、`src/pages/workspace.html/js`、`src/preload/workspace-preload.js`、对应 `tests/test-*.js` |

---

## 附：文档修订记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-08-03 | v1.0 | 初稿：基于 `.slim/deepwork/web-shell-enhancement-plan.md` 调和事实与源码核对产出 |
| 2026-08-03 | v1.1 | 按 Oracle 评审（会话 `ora-1`）与 orchestrator 决定修订：① 唯一架构决定——第一版用固定宽度、可折叠的覆盖式右侧 Workspace `WebContentsView`，覆盖 `BrowserWindow.webContents` 右侧区域，不迁入 `kimi web`、不并排、不拖拽调宽，flag 关闭完全不创建面板；② 活动工作区安全——低置信推断仅展示候选，不授权 Files/Git 读取，仅已验证映射或用户显式选择可启用，否则未绑定空态；③ ACP 降级——Agents/Tasks 必需数据源仅官方 WS/REST + 本地只读 sessionDir，已有 ACP 观察仅低置信附加，不启动、不影响出口、不成依赖；④ `TaskCatalog` 不直接复用，M4 改造为接收已验证 `sessionDir` 或加适配层并以测试证实（`sessionsRoot` 扫描与两级目录可能不匹配）；⑤ 路由/z-order——保留 `foregroundContents()` overlay→Web 语义，Workspace 用专用 `workspaceContents()`/定向 IPC，z-order 为 overlay > Workspace > Web，overlay 显示时 Workspace 隐藏，bounds 避开右上角窗控/菜单区，定义焦点返回与显式销毁顺序；⑥ question 目标态——Web UI 优先，桌面仅通知/聚焦，本地 question 窗仅作 M1 证明 Web 不支持时的兼容 fallback；⑦ M1 未完成的 OpenAPI/AsyncAPI/URL/deep-link/diff endpoint 结论全部改为待探测，删除"删除已走 REST"等不实描述与完成时态；⑧ Git 契约——`git status --porcelain=v2 -z`、rename/特殊字符路径、staged/unstaged 分开保存不求和、diff 边读边限额、受控相对路径置于 `--` 后、非 Git 仓库 Changes 空态且 Files 独立可用；⑨ 删除固定 v1.8/v1.9/v2.0 版本承诺改为候选发布门，工作量按覆盖式方案重新校准，单人顺序/可交错车道；⑩ Windows 回归按源码真实行为（托盘单击/双击均显示主窗口）；⑪ 接受简化——删除 `touched-by-session`、能力探测优先扩展现有 serverCaps、Agents/Tasks 首版磁盘快照 + 现有 WS、Changes 首版可先列表且 diff 展开为可选；⑫ 本版状态改为"已评审，可执行" |
| 2026-08-03 | v1.2（复核稿） | 按 Oracle 第二次门禁（依据 `.slim/deepwork/web-shell-enhancement-plan.md` Status 第 57–59 行）修订，**状态改"复核中"，待下一次门禁裁决，本稿不自行宣称可执行**：① Workspace 候选/上下文链完全排除 `getAllSessionsMerged()`（其内部 `querySessionsViaAcp()` 会创建 `AcpClient` 并启动 `kimi acp`）——新建"不含 ACP"候选服务（§5.3），仅用已确认的 REST/Web 导航状态/本地 session index；既有启动器保留使用，面板不得依赖（§3.3、§4.1、§12.4）；② 面板销毁仅取消 Workspace 自有资源（事件转发监听/`workspace:*` IPC 订阅/防抖 timer/轮询/渲染监听），**不停主进程共享 WS、托盘、通知、runtimeState**（§5.2、M2-1），新增面板反复开关共享 WS 持续连接验收（§11 用例 9、§12.1、M6-1）；③ Agents 第一版必需来源改为已验证 `sessionDir` 磁盘快照——注明现有 normalizer 对官方事件 `agentType` 恒为 `null`、`SubagentStop` 仅作完成提示，官方 WS 实时更新仅当 M1 实测发现子代理事件后才扩展 normalizer 启用（§2.1、§3.2、§3.4、§8.3、M4-1/M4-4/M4-5、R11）；Tasks 继续用已有 WS `task.*` + 磁盘；④ Git 契约闭合——status/numstat/--cached numstat 全部 `-z` NUL 分隔（M3-1、§8.1、§10.4），ChangeEntry 改为 `staged`/`unstaged` 两个 `{adds,dels}` 统计对象、弃用歧义单个 `staged` 布尔并加快照唯一 `id`，存在文件 realpath、deleted/rename 源路径 lexical containment + 最近存在父目录 canonicalization（§8.1、§10.2），diff 预览必须引用快照返回的不可伪造 `entryId`/受控条目、不接受渲染层任意路径（M3-2、§8.1、§10.4、§12.1 安全行）；⑤ 顶部状态改"复核中"、版本 v1.2（复核稿）；⑥ 删除非目标中"不修改源码"条目（顶部保留"本计划编写不修改源码"说明）；⑦ 测试矩阵与 M6 门禁增加 feature flag 关闭路径、面板反复开关、共享 WS 持续连接、Git 特殊路径（rename/空格/制表符/换行）与 deleted/rename 路径安全（§11 用例 9/10、§12.1、M6-1/M6 出口、R10） |
| 2026-08-03 | v1.2（定稿） | Oracle 最终门禁通过：上一轮四项剩余契约已全部关闭，未发现新的架构或安全阻塞；状态更新为“已评审，可执行”。 |
