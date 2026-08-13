# 项目共享记忆

## 项目概况

- Kimi Code Desktop：`kimi web` 的 Electron 套壳应用；主进程入口 `src/main/main.js`；页面：`src/pages/setup.html`（设置）、`src/pages/usage.html`（用量统计，独立窗口，菜单 ☰→「用量统计」，IPC `usage:getSnapshot` 复用 `runLocalCommand('/usage')` 契约）。前端无框架无图表库，样式走 `src/styles/kimi-theme.css` 变量。

## 重要决策

- CLI 更新（`src/main/cli-update.js` 纯 Node 模块，由 main.js 注入 Electron `net.fetch` 以兼顾系统代理/证书，且可注入便于单测）：主动检查源 `https://code.kimi.com/kimi-code/latest.json`，失败回退 `/latest`；`~/.kimi-code/updates/latest.json` 仅是 CLI 本地缓存（桌面端只读），远端失败时只能标注为辅助信息，不得据此宣称"已是最新"。IPC 不变式：`ok:true` 表示远端版本已严格校验；`ok:false` 不携带 `latest`/`updateAvailable`，可携带 `cachedLatest`/`cachedCheckedAt`。
- WS 心跳契约（2026-08-13 实测 CLI 0.36.0）：server 每 10s 发应用层 `{"type":"ping","payload":{"nonce"}}`，20s 无 pong 即 `1001 "heartbeat timeout"` 断开；客户端必须回 `{"type":"pong","nonce":<nonce>}`（main.js WS message 入口已处理）；`server_hello` 携带 `heartbeat_ms:10000`/`protocol_version:2`。0.31.1 及更早无此行为。
- scripts/ 按用途三层：`scripts/build/`（打包）、`scripts/dev/`（开发工具与探测验证）、`scripts/archive/`（过时脚本）；docs/ 同理以 `docs/archive/` 存历史文档。2026-08-07 已清理一次性探测脚本与 `docs/acp-research.md`（均无运行时引用），ACP 结论保留在 src 注释与 ROADMAP 中，勿再引用已删文件。一次性探测脚本用完即删，结论落文档（本次 WS/DOM/CDP 探测结论已并入 `docs/upstream-alignment-2026-08.md`）。
- 产品定位：官方 Web UI 负责对话、流式渲染、工具卡、上传、Slash Commands、模式与消息队列；不建设独立原生聊天应用或第二套会话运行时，ACP 仅在 REST/WebSocket/本地数据无法满足的必要场景补缺。
- 工作区增强嵌入主窗口且不离开 Web 对话：Electron 外壳负责 Changes/Files/Agents/Tasks 侧栏、状态汇总、通知和 Windows 集成；优先通过独立本地 `WebContentsView`/侧栏与官方 Web UI 并排，避免深度修改官方页面 DOM。
- Changes/Files：主进程按当前会话工作目录白名单受控读文件并计算 Git diff（事实源 = 当前工作树相对 `HEAD`）；不开启 ACP fs 反向 RPC，桌面端不写工程文件。
- 参考 `kimi-code-desktop-master` 时只借鉴 Changes/Files/Agents/Tasks 的信息架构与交互模式，不复制其原生对话运行时或源码。

## 经验教训

- `readJSON` 已 strip UTF-8 BOM：PowerShell `Set-Content -Encoding utf8`、记事本保存会写 BOM（EF BB BF），曾让 config.json 静默解析失败回退默认值；写 JSON 配置文件须用无 BOM 方式（`[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`）。
- `BrowserWindow.capturePage()` 不合成 WebContentsView 子视图——面板/覆盖层的截图验证不可信，用日志/运行时内省（如 bounds 日志）验证。
- 本机跑第二个桌面端实例会被单实例锁拦截：调试/冒烟用 `--user-data-dir=<临时目录>` 隔离（app.log 也随之隔离，读 `<tmp>/app.log` 判定）。杀残留 electron 进程必须按 PID/命令行精确杀（`taskkill /IM electron.exe` 或窗口标题过滤会误杀用户正在运行的主实例）。

## 常用路径与命令

- CLI 更新模块测试：`node tests/test-cli-update.js`；全量单测无测试框架，逐个运行 `tests/test-*.js`
- 本机打包：`npm run pack:versioned:ca`（等价 `npm run dist` 但带 `-UseSystemCA`；需 `NODE_OPTIONS=--use-system-ca`，严禁 `NODE_TLS_REJECT_UNAUTHORIZED=0` 禁用校验）

## 当前状态（2026-08-13）

- 上游对齐（CLI 0.36.0）：WS 心跳 pong 修复、overlay 悬挂防御（render-process-gone 复位 + loadFile 失败整页降级 + setup.html 返回按钮判空）、设置页 `loop_control` 键迁移（max_iterations→max_steps_per_turn、删除 max_tool_depth）、模型回退补 k3/k3-256k；完整结论见 `docs/upstream-alignment-2026-08.md`（含需跟进清单：workspace trust、新 hook 事件、8-31 k2.5 API 下线提示等）。
- Web Shell 增强计划（`docs/plan/web-shell-enhancement/`）M1–M6 自动门禁完成；M6-1/M6-5 按用户指示跳过（Windows 原生手测与签名证书配置未做）。
- `release/v1.7.0` 仅为未签名内部测试包（Setup/Portable/主 EXE/elevate.exe 均 `NotSigned`），不得称为正式发布候选；发布/回滚流程见 `docs/release-workspace-m6.md`，回归矩阵见 `docs/regression-workspace-m6.md`（探测/验证脚本见 `scripts/dev/`）。
