# 项目共享记忆

## 项目概况

- Kimi Code Desktop 是 Electron 应用；主进程入口为 `src/main/main.js`，设置中心为 `src/pages/setup.html`。
- 用量统计面板为独立窗口页 `src/pages/usage.html`（菜单 ☰→「用量统计」打开，IPC `usage:getSnapshot` 复用 `runLocalCommand('/usage')` 契约；前端无框架无图表库，样式走 `src/styles/kimi-theme.css` 变量）。

## 重要决策

- CLI 最新版本以 `https://code.kimi.com/kimi-code/latest.json` 为主动检查源，失败回退 `/latest`；`~/.kimi-code/updates/latest.json` 仅是 CLI 本地缓存，远端失败时只能标注为辅助信息，不能据此宣称“已是最新”。
- CLI 更新网络请求由 `src/main/main.js` 注入 Electron `net.fetch` 给纯 Node 模块 `src/main/cli-update.js`，以兼顾系统代理/证书处理与单元测试可注入性。
- 更新检查 IPC 的不变式：`ok:true` 表示远端版本已严格校验；`ok:false` 不携带 `latest` 或 `updateAvailable`，可携带 `cachedLatest`/`cachedCheckedAt`。
- 产品继续定位为 `kimi web` 的 Electron 套壳增强：官方 Web UI 负责对话、流式渲染、工具卡、上传、Slash Commands、模式与消息队列；不建设独立原生聊天应用或第二套会话运行时，ACP 仅在 REST/WebSocket/本地数据无法满足的必要场景补缺。
- 工作区增强应嵌入主窗口且不离开 Web 对话：Electron 外壳负责 Changes/Files/Agents/Tasks 侧栏、状态汇总、通知和 Windows 集成；优先通过独立本地 `WebContentsView`/侧栏与官方 Web UI 并排，避免深度修改官方页面 DOM。
- Changes/Files 第一版由 Electron 主进程按当前会话工作目录白名单受控读取文件并计算 Git diff，不开启 ACP fs 反向 RPC，也不由桌面端写工程文件；Changes 以当前工作树相对 `HEAD` 为事实源，工具事件仅标记“本会话触及”。
- 参考 `kimi-code-desktop-master` 时只借鉴 Changes/Files/Agents/Tasks 的信息架构与交互模式，不复制其原生对话运行时或源码。

## 常用路径与命令

- CLI 更新模块测试：`node tests/test-cli-update.js`
- 全量单元测试：逐个运行 `tests/test-*.js`
- 本机打包：`npm run pack` 需 `NODE_OPTIONS=--use-system-ca`（Node 默认 CA 库校验 electron-builder 下载请求失败；系统 CA 正常；严禁 `NODE_TLS_REJECT_UNAUTHORIZED=0` 禁用校验）

## Web Shell 增强（计划执行中，docs/plan/web-shell-enhancement/）

- M1 能力审计已完成：`docs/web-shell-capability-audit.md`（CLI 0.31.1 实测，2026-08-03）是 M3/M4/M5 数据源决策唯一依据。
- CLI 0.31.1 实测关键事实：会话 URL 为 `/sessions/<sessionId>`（pathname 带完整 sessionId，`did-navigate-in-page` 可捕获，URL 不含 workDir）；WS 存在 `subagent.spawned/started`、`agent.created`、`agent.status.updated`（含 usage，桌面 normalizer 均未覆盖）；`task.started` payload 为 `{agentId, info, sessionId}`（task_id 不在顶层，normalizer 取值路径需修）；`session.usage_updated` 全程未触发（用量疑走 `agent.status.updated`，托盘/用量面板链路待复核）；无会话删除 REST、无 diff API；`/asyncapi.json` 存在（含 subscribe_v2/watch_fs 消息）。
- 探测脚本：`scripts/capability-audit.js`、`scripts/ws-event-probe.js`（全事件普查版）、`scripts/nav-probe.js`（Electron 导航探测），用法均为传端口、token 读 `~/.kimi-code/server.token`。
- M2 已完成（2026-08-03）：360px 覆盖式右侧 Workspace 面板（`workspacePanelEnabled` flag 默认关、`workspacePanelCollapsed` 持久化、loadMain 启动恢复）；`src/main/session-workspace.js` 纯函数上下文服务（bound/candidates/unbound）；`workspace:*` 定向 IPC + `src/preload/workspace-preload.js`。
- 教训（2026-08-03）：① `readJSON` 已 strip UTF-8 BOM——PowerShell `Set-Content -Encoding utf8`、记事本保存会写 BOM（EF BB BF），此前会让 config.json 静默解析失败回退默认值；写 JSON 配置文件改用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))` 或无 BOM 方式。② `BrowserWindow.capturePage()` 不合成 WebContentsView 子视图——面板/覆盖层的截图验证不可信，用日志/运行时内省（如 bounds 日志）验证。
- M3 已完成（2026-08-03）：`git-service.js` 的快照绑定 canonical workDir、diff 只接受 snapshot entryId、禁 external diff/textconv/fsmonitor、输出限额和一次重试；`file-browser.js` 默认不可绕过地排除 `.git`/`node_modules`、拒绝所有 descendant symlink/junction、目录枚举流式限 500 条。`scripts/workspace-integration-probe.js` 是真实 WebContentsView → preload → IPC → Git/Files 集成验证命令（不发 prompt）。
- 会话授权/异步不变式：verified URL 会话优先于 explicit，导航与 focus 都维护 `navFingerprint`（unverified/verified+workDir），verified URL 清 explicit；Workspace UI 在潜在 context 变化开始即递增 generation、清空旧数据，所有异步响应须匹配 generation+contextKey，`refresh` 才走 3 秒防抖。
- M4 已完成（2026-08-04）：`workspace-projection.js` 汇总经过验证的 sessionDir 磁盘 Agents 快照和 TaskCatalog；Agents/Tasks 面板只读，WS/ACP 活动仅推 `workspace:event({kind:'activity'})` 后由页面重取快照。`scripts/workspace-integration-probe.js` 现验证真实投影 IPC。
- M4 安全与刷新契约：TaskCatalog 的显式 sessionDir 为 absent/direct/invalid 三态，invalid 不扫描 sessionsRoot，direct 必为匹配 sessionId 的真实目录；Tasks/Cron 与 Agents 目录的 symlink/junction 一律跳过。`state.json` agentId 必须为安全单路径段并二次 containment。RuntimeState 的 `at` 单调，任何会改变可见任务字段（含 `at/kind/source/confidence/rawKind`）都必须触发 changed/activities；完全等价或乱序事件不刷新。
- M4 验证基线：全量 `tests/test-*.js`、`C:\Users\zyl\AppData\Local\Temp\opencode\m4-workspace-selfcheck.cjs`（50 断言）以及 `npx electron scripts/workspace-integration-probe.js` 均通过。真实 WS/ACP 事件注入至 activities 的端到端自动化仍未覆盖，应纳入 M6 回归。
- M5 已完成（2026-08-04）：Web 主导边界见 `docs/web-ui-integration-boundary.md`。主 Web 是唯一对话 UI；桌面不得复制审批、问答、Plan、Swarm、会话内模型、上传、Slash 或队列控件。主 Web question 仅通知/聚焦，ACP legacy 的 permission/elicitation 窗口是独立路径，必须保留 owner、sender、QID（elicitation）、窗口 epoch/settle 与 pending identity 的绑定，旧窗口/延迟 IPC 不得结算同步 pump 的新请求。
- M5 授权与导航契约：合法但未验证的 URL sessionId 绝不可回退 explicit 绑定；当前 URL 仅以有界约 4 秒的本地 session index 重查获得 verified（不启 ACP、不全量扫描）。通知导航仅允许审批/完成事件在全部来源 ID 合法一致、连接 navEpoch/base/token 仍匹配时由用户点击触发；question、旧通知、冲突 ID 或无 token 只聚焦。overlay 暂隐期间 context 事件合并，Workspace 重挂后补发一次。
- M5 验证基线：全量 26 个 `tests/test-*.js`，`test-acp-permission-window` 11/11、`test-acp-question-window` 12/12、`test-notification-nav` 13/13、`test-overlay-context-sync` 6/6、Workspace selfcheck 61/61、Electron integration probe 均通过。M6 仍须执行 Windows 原生通知点击、BrowserWindow load/close 时序、连续 ACP 队列、create-in-dir 索引时序与快捷键矩阵的真实回归。
- M6 自动门禁完成（2026-08-04）：安全门禁 Oracle 通过；全量 29 个 `tests/test-*.js`、Workspace selfcheck 61/61、M6 restore selfcheck 18/18、`npx electron scripts/workspace-integration-probe.js --all` 的 flag-off/flag-on 均通过。最终 `release/v1.7.0/win-unpacked/resources/app.asar` 与工作树 25 个 Workspace 安全关键文件 SHA-256 一致。
- M6 当前未完成正式发布候选：Windows 原生回归矩阵尚待人工，详见 `docs/regression-workspace-m6.md`；发布与回滚流程见 `docs/release-workspace-m6.md`。当前主 EXE、elevate.exe、NSIS 与 Portable 均为 `NotSigned`，无证书前只能内部测试，不能宣称正式签名发布。
- M6 安全约束：Workspace IPC 仅接受精确本地 workspace.html 的 mainFrame；可信 server origin 才可绑定会话；sessionDir 必须是 sessionsRoot 内、非链接的真实目录；Git 设 `GIT_LITERAL_PATHSPECS=1`；投影读取/内存/响应有硬上限。Windows Node 缺少 native `O_NOFOLLOW/openat`，同用户恶意并发替换目录 reparse point 是已记录的受限威胁模型残余，不能宣称 JS 层原子消除。
- M6 执行在 2026-08-04 按用户指示停止：用户跳过 Windows 原生手测与签名证书配置。M6-1/M6-5 未完成，`release/v1.7.0` 仅保留为未签名内部测试包；不得称为正式发布候选。
