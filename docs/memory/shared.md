# 项目共享记忆

## 项目概况

- Kimi Code Desktop 是 Electron 应用：主进程入口 `src/main/main.js`，设置中心 `src/pages/setup.html`，用量统计面板为独立窗口页 `src/pages/usage.html`（菜单 ☰→「用量统计」打开，IPC `usage:getSnapshot` 复用 `runLocalCommand('/usage')` 契约；前端无框架无图表库，样式走 `src/styles/kimi-theme.css` 变量）。

## 重要决策

- CLI 最新版本以 `https://code.kimi.com/kimi-code/latest.json` 为主动检查源，失败回退 `/latest`；`~/.kimi-code/updates/latest.json` 仅是 CLI 本地缓存（桌面端只读），远端失败时只能标注为辅助信息，不能据此宣称"已是最新"。
- CLI 更新网络请求由 `src/main/main.js` 注入 Electron `net.fetch` 给纯 Node 模块 `src/main/cli-update.js`，以兼顾系统代理/证书处理与单元测试可注入性。
- 更新检查 IPC 不变式：`ok:true` 表示远端版本已严格校验；`ok:false` 不携带 `latest` 或 `updateAvailable`，可携带 `cachedLatest`/`cachedCheckedAt`。
- 产品定位为 `kimi web` 的 Electron 套壳增强：官方 Web UI 负责对话、流式渲染、工具卡、上传、Slash Commands、模式与消息队列；不建设独立原生聊天应用或第二套会话运行时，ACP 仅在 REST/WebSocket/本地数据无法满足的必要场景补缺。
- 工作区增强嵌入主窗口且不离开 Web 对话：Electron 外壳负责 Changes/Files/Agents/Tasks 侧栏、状态汇总、通知和 Windows 集成；优先通过独立本地 `WebContentsView`/侧栏与官方 Web UI 并排，避免深度修改官方页面 DOM。
- Changes/Files 由 Electron 主进程按当前会话工作目录白名单受控读取文件并计算 Git diff，不开启 ACP fs 反向 RPC，也不由桌面端写工程文件；Changes 以当前工作树相对 `HEAD` 为事实源。
- 参考 `kimi-code-desktop-master` 时只借鉴 Changes/Files/Agents/Tasks 的信息架构与交互模式，不复制其原生对话运行时或源码。

## 经验教训

- `readJSON` 已 strip UTF-8 BOM：PowerShell `Set-Content -Encoding utf8`、记事本保存会写 BOM（EF BB BF），此前会让 config.json 静默解析失败回退默认值；写 JSON 配置文件改用无 BOM 方式（`[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`）。
- `BrowserWindow.capturePage()` 不合成 WebContentsView 子视图——面板/覆盖层的截图验证不可信，用日志/运行时内省（如 bounds 日志）验证。

## 常用路径与命令

- CLI 更新模块测试：`node tests/test-cli-update.js`
- 全量单元测试：无测试框架，逐个运行 `tests/test-*.js`
- 本机打包：`npm run pack:versioned:ca`（等价 `npm run dist` 但带 `-UseSystemCA`；需 `NODE_OPTIONS=--use-system-ca`，严禁 `NODE_TLS_REJECT_UNAUTHORIZED=0` 禁用校验）

## 当前状态（2026-08-04）

- Web Shell 增强计划（`docs/plan/web-shell-enhancement/`）M1–M6 自动门禁完成；M6-1/M6-5 按用户指示跳过（Windows 原生手测与签名证书配置未做）。
- `release/v1.7.0` 仅为未签名内部测试包（Setup/Portable/主 EXE/elevate.exe 均 `NotSigned`），不得称为正式发布候选；发布/回滚流程见 `docs/release-workspace-m6.md`，回归矩阵见 `docs/regression-workspace-m6.md`。
- 探测/验证脚本：`scripts/capability-audit.js`、`scripts/ws-event-probe.js`、`scripts/nav-probe.js`（传端口、token 读 `~/.kimi-code/server.token`）；`scripts/workspace-integration-probe.js` 为真实 WebContentsView → preload → IPC → Git/Files/投影集成验证（不发 prompt）。
- 官方能力审计报告：`docs/web-shell-capability-audit.md`（CLI 0.31.1 实测，2026-08-03）。
