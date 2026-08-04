# M6 发布与回滚流程（Web Shell + Workspace）

> 面向维护者/发布人。落地 `WEB_SHELL_ENHANCEMENT_PLAN.original.md` §12.3（发布/回滚策略）。
> 归档日期：2026-08-04
> 配套：回归事实源 `docs/regression-workspace-m6.md`；里程碑状态 `docs/plan/web-shell-enhancement/m6-regression-release.md`。
> 当前结论：**尚未达到发布候选出口**——用户已跳过 M6 人工验收与签名证书配置；最终包无有效 Authenticode 签名。当前 `release/v1.7.0` 仅可作为**内部测试包**。

## 1. 发布前置条件（全部满足才可进入发布候选）

| # | 条件 | 当前状态（2026-08-04） |
| --- | --- | --- |
| P1 | M6 手测全部记录为 PASS（§11 十项矩阵，见 `docs/regression-workspace-m6.md` §1） | ⏭ 用户跳过：上述项目均未执行，不能视为 PASS |
| P2 | 安全门禁零未决项 | ✅ M6 Oracle 安全门禁通过（IPC 白名单/参数白名单/逃逸用例/日志脱敏，证据 A5） |
| P3 | 最终包 hash 与 asars 内容核对 | ✅ `release/v1.7.0` `app.asar` 源文件哈希 25/25 一致、workspace.html/js/preload/新模块在列（证据 A6）；全量单测 29/29、selfcheck 61/61 与 18/18、集成探针 `--all` exit 0（证据 A1–A4） |
| P4 | 签名状态 | ⏭ 用户跳过证书配置；当前仍为 **NotSigned**（见 §4），不得宣称正式签名发布 |

> P1 中任何一项最终结论为 FAIL 或"有明确缺陷结论"时，先修复再回归，不得带病进入发布候选。

## 2. 发布顺序（flag 默认保持 false）

发布候选不改变 `workspacePanelEnabled` 默认值。**不要把 flag 默认改为 true**（计划硬约束：flag 默认 false，关闭时完全不创建面板）。

1. **内部候选（默认 flag false）**：以默认配置发布/分发，Workspace 面板不创建，行为等同 v1.7 基线；用于验证安装、升级、回滚路径本身。
2. **受控开启**：选定内部/白名单用户，通过各自 `config.json` 设置 `workspacePanelEnabled:true` 开启面板；观察真实使用（会话切换、数据新鲜度、共享 WS 稳定性、资源占用），必要时按 §3 一级回滚单点关闭。
3. **再评估**：依据手测矩阵最终结论 + 受控开启反馈，由发布人决定是否（a）保持候选继续迭代、（b）宣告正式发布候选（可宣发"Web Shell + Workspace"），或（c）回退。正式候选仍需满足 §1 全部前置条件。

版本号与开启策略由发布人按发布节奏决定，本流程不预设版本号。

## 3. 回滚

**一级（默认首选，秒级生效）**：编辑 `config.json` 将 `workspacePanelEnabled` 置为 `false`（删除或置 false 均可），重启应用或重开窗口即回退到 v1.7 基线行为——不创建面板视图、无 preload/IPC 注入、主 Web 会话不受影响（事实依据：`docs/regression-workspace-m6.md` §3 flag-off 实测）。无需卸载、不触碰 CLI 与共享 WS。

**二级（安装层）**：回退安装上一版本签名安装包（NSIS Setup）。数据不迁移、无 schema 变更（面板配置仅存在于 config.json，一级已关闭）。

**通知用户**：任何回滚操作前向用户说明影响与步骤；**不执行 Git reset、不执行破坏性操作**（不删用户目录、不 force 操作、不动 CLI 数据）。若回滚后需保留面板侧配置，仅保留 `config.json` 中该 flag 键的关闭值。

## 4. Authenticode 签名状态（2026-08-04 实测）

对 `release/v1.7.0` 产物执行 `Get-AuthenticodeSignature`：

| 产物 | 路径 | 签名状态 |
| --- | --- | --- |
| NSIS 安装包 | `release/v1.7.0/KimiCodeDesktop-Setup-1.7.0.exe` | `NotSigned` |
| Portable | `release/v1.7.0/KimiCodeDesktop-Portable-1.7.0.exe` | `NotSigned` |
| 主 EXE | `release/v1.7.0/win-unpacked/Kimi Code Desktop.exe` | `NotSigned` |
| elevate.exe | `release/v1.7.0/win-unpacked/resources/elevate.exe` | `NotSigned` |

**说明**：electron-builder 打包日志可能提及 signtool，但产物实测均未签名（package.json 未配置签名证书，签名阶段未生效）。在取得有效代码签名证书并完成配置前，**仅可作为内部测试包分发**；不得声称正式签名发布，不得面向不受信环境推广。

**配置证书后的要求**：在打包配置中配置有效签名证书（electron-builder 标准机制），重新执行 `npm run pack:versioned:ca`（`NODE_OPTIONS=--use-system-ca`，严禁禁用 TLS 校验），然后对上述四项产物逐一执行 `Get-AuthenticodeSignature` 复核：状态必须为 `Valid`（签名链完整、时间戳有效）才视为签名发布就绪；复核结果记录回本文档 §4 并更新 P4 为 ✅。本流程不记录、不写入任何证书变量值或机密。
