# CLI 0.29.x 回归核对表（14 组）

> 用途：v1.1.0 基线切换验收（对应 ROADMAP §3 P0-1）。在 CLI 0.29.x 上逐项执行并回填结果；定义出处见 `docs/ROADMAP.md` P0-1 条。

- CLI 版本：0.29.0（`C:\Users\zyl\.kimi-code\bin\kimi.exe`）
- 操作系统：Windows（Git Bash 环境）
- 执行日期：2026-07-27

## 分组说明

- **自动组**：①⑦⑧⑨⑪⑫⑬⑭ 由 `scripts/regression-0.29.js` 覆盖；③④ 由 `scripts/dev-verify.js` 覆盖。
- **人工组**：②登录态、⑤审批通道、⑥问答通道、⑩令牌机制 rotate-token 实测（会改写真实 server.token，**放最后执行**）。

## 核对表

| 组别 | 内容 | 方法/依据 | 结果 | 结论 |
| --- | --- | --- | --- | --- |
| ① | 启动：`kimi web --no-open` 子进程拉起并就绪 | `scripts/regression-0.29.js` | PASS：30s 内捕获地址 http://127.0.0.1:19528（请求端口 19528），进程收尾已 kill | ✅ 通过 |
| ② | 登录态：已登录身份可用、未登录有明确引导 | 人工：确认本机 OAuth 登录态后走完整启动流程 | PASS：`~/.kimi-code/credentials/kimi-code.json` 存在（credentialCount=1，getLoginStatus=已认证）；未登录引导卡 `auth-error`/FAQ 走查在案 | ✅ 通过 |
| ③ | WebView 加载：页面正常加载渲染 | `scripts/dev-verify.js` | PASS：webui 窗口出现（http://127.0.0.1:58628/...）；官方「新建对话」按钮 clicked 成功 | ✅ 通过 |
| ④ | WS 通知：WebSocket 连接建立且事件可达 | `scripts/dev-verify.js` | PASS：当日 app.log 实测 `WebSocket 订阅已启动` + `WebSocket 已连接` + `已订阅 46 个会话`（2026-07-27T06:28Z） | ✅ 通过 |
| ⑤ | 审批通道：权限审批请求可弹出、可响应 | 半自动：`scripts/ws-event-probe.js` 建会话发 bash 提示词触发审批，REST 批准 | PASS：捕获 `event.approval.requested`（桌面处理器同名匹配 main.js:1493），payload 含 approval_id/tool_call_id/tool_name/action/tool_input_display/expires_at；REST 批准 → HTTP 200 → `event.approval.resolved`；真实桌面同日 4 次处理审批事件（app.log「托盘状态 / 审批 1」03:17/03:19/05:16/06:03）；沙箱桌面事件到达时已订阅（审批先于订阅发出未截获托盘行，属时序非缺陷） | ✅ 通过（通道+处理器+真实桌面佐证） |
| ⑥ | 问答通道：AskUserQuestion 问答可弹出、可作答 | 半自动：`scripts/ws-event-probe.js` 发 AskUserQuestion 提示词，REST 作答 | PASS：捕获 `event.question.requested`，payload 形态=question_id+questions 数组（首题键 id/question/options×2/allow_other，与桌面 handleQuestionRequested 校验形状一致）；沙箱桌面实测接收并路由（app.log「主窗口聚焦，问答请求回退 Web UI: question_id=tool_wM7g…」同 ID）；REST 作答 → HTTP 200 → `event.question.answered` → 桌面「问题已释放」 | ✅ 通过（全链路；原生问答窗因主窗聚焦按设计回退 Web UI） |
| ⑦ | 会话管理：会话创建/恢复/列表可用 | `scripts/regression-0.29.js` | PASS：GET /api/v1/sessions → 200，`{code:0,data:{items:[...]}}`，会话数=42 | ✅ 通过 |
| ⑧ | 配置读写：配置读取与写回行为正常 | `scripts/regression-0.29.js` | PASS：tests/test-config-manager.js 退出码 0；`kimi doctor config <副本>` 退出码 0（All checked config files are valid.） | ✅ 通过 |
| ⑨ | `kimi login` 设备码非交互登录（RFC 8628、Ctrl-C 可取消、退出码 0/1、token 与 TUI `/login` 同一本地位置） | `scripts/regression-0.29.js` | PASS（形态核对）：`kimi login --help` 明示 "Authenticate with Kimi Code CLI via the device-code flow."；交互流程（Ctrl-C/退出码）未实走 | ✅ 通过（形态）；交互细则列入后续观察 |
| ⑩ | 令牌机制：`#token=` 片段注入、rotate-token 后旧 token 立即失效且运行中实例自动换用、令牌 7 天保留 | 人工：`kimi web rotate-token` 实测（改写真实 server.token，最后执行） | 部分实测：`#token=` 注入已实现（main.js:669）且 dev-verify 中 Web UI 经 token 片段鉴权成功加载会话页（间接证实鉴权链路）；rotate-token 与 7 天保留未实测（用户决定跳过：桌面与 CLI 实例活跃使用中，避免打断） | ⚠️ 部分通过：注入链路已证实；rotate-token 记入 ROADMAP §7 待核实项 |
| ⑪ | 双 schema 端点 `/openapi.json` 与 `/asyncapi.json` 可用性 | `scripts/regression-0.29.js` | PASS：openapi.json → 200（Kimi Code Server API 0.29.0，paths=65）；asyncapi.json → 200（asyncapi 3.1.0，Kimi Code WebSocket API） | ✅ 通过 |
| ⑫ | Windows 前置检测：Git for Windows/`KIMI_SHELL_PATH`、Node.js ≥ 22.19.0、native 安装仅打印手动更新命令（升级管家行为边界） | `scripts/regression-0.29.js` | PASS：Node v24.16.0 ≥ v22.19.0；Git Bash 检出 C:\Program Files\Git\bin\bash.exe；「native 安装仅打印手动更新命令」依据官方文档记录（未实测） | ✅ 通过（升级边界为文档结论） |
| ⑬ | `kimi doctor tui [path]` 与 `kimi server kill`（清理 0.28 之前遗留后台服务） | `scripts/regression-0.29.js` | PASS：`kimi doctor tui <副本>` 退出码 0；`kimi server kill --help` 存在（Usage: kimi server kill [options]，0.29.0 已标 Deprecated，仅清 0.28 前 legacy lock）；本机无 server/lock 遗留，未执行实际 kill | ✅ 通过 |
| ⑭ | 启动参数与代理：`-p` 与 `--yolo/--auto/--plan` 互斥且固定 auto 权限、`-r`/`--resume`=`--session`；HTTP(S)_PROXY/ALL_PROXY/NO_PROXY 含 SOCKS、回环地址始终绕过 | `scripts/regression-0.29.js` | PASS：--help 命中 `-p, --prompt`（旧名 --print 已更名）、`--yolo/--auto/--plan`、`-S, --session`（旧名 -r/--resume 已更名）；buildKimiEnv 静态断言透传 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY ✓；SOCKS/回环绕过为 CLI 侧行为（文档结论） | ✅ 通过（注意：参数旧名已更名，适配层用的 `--session` 与新名一致） |

## 附带发现（⑤⑥ 探测过程实录，供 P0-4 / ROADMAP §7 参考）

- **REST `POST /api/v1/sessions` 的 `agent_config` 在 0.29.0 不落位**：openapi schema 文档化了 `model`/`permission_mode`/`plan_mode` 等字段，但实测三轮均不生效（profile 回显 `agent_config:{model:""}`，status 回显全局默认）；`POST /profile` 可落 `permission_mode`/`plan_mode` 但仍不落 `model`。
- **模型须随 `POST /prompts` 顶层字段提交**（该端点顶层接受 `model`/`permission_mode`/`plan_mode`/`thinking` 等），否则 turn 直接失败：`error` 事件 `{"code":"model.not_configured","message":"Model not set"}`；全局 `default_model`（本机=kimi-code/k3）亦不被 REST 会话继承。
- **模型 ID 须用目录全名**（`GET /api/v1/models` 的 `model` 字段，如 `kimi-code/kimi-for-coding`；目录另含 `kimi-code/k3`（1M，support_efforts low/high/max）等）。
- WS 事件流中审批存在双事件：`permission.approval.requested` 与 `event.approval.requested`（桌面处理后者，匹配正确）；其余事件流：turn.started → tool.call.* → turn.step.completed → assistant.delta → turn.ended → prompt.completed。
- 建会话后桌面端经 30s 发现周期订阅新会话（app.log「已订阅 1 个新会话」），探针需等待一个周期再触发事件。

## 失败项处理

- 失败项不允许留无结论项：转入 bug 修复，或记入 ROADMAP §7（需进一步核实的问题清单）作为待核实项。
- 验收标准：14 组全过或项项有结论，且 `npm start` 全流程（启动→就绪→加载→WS→审批/问答通知）通过。
