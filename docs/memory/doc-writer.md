# Doc-writer 记忆（kimi-code-desktop）

## Web Shell 增强 M6 文档（2026-08-04）

- 回归矩阵事实源：`docs/regression-workspace-m6.md`（§11 十项用例表格：✅ 自动通过 / ⬜ 待人工；**未实际运行的人工项绝不写 PASS**）。
- 发布/回滚流程：`docs/release-workspace-m6.md`（发布前置条件 P1–P4、发布顺序内部候选→受控开启→再评估、一级回滚 flag=false、二级回退安装包；flag 默认保持 false 不改为 true）。
- M6 自动门禁证据（复用引用）：29 份 `tests/test-*.js`、M4 selfcheck 61/61、M6 restore selfcheck 18/18（Temp `m6-workspace-restore-selfcheck.cjs`）、`npx electron scripts/workspace-integration-probe.js --all`（flag-off 10s×500ms≈20 次采样无 workspace.html + 主会话 ready；flag-on 全链 IPC/Changes/Files/Projection）、Oracle 安全门禁、`release/v1.7.0` app.asar 源文件哈希 25/25。
- 待人工项（10 项，写文档时勿标 PASS）：托盘单/双击与右键、Windows 原生通知 A→B→A、快捷键、单实例、overlay 视觉、主题、优雅退出、面板开关 ≥10 次共享 WS、create-in-dir index 时序、连续 ACP permission/elicitation 的 BrowserWindow 时序。
- Authenticode 实测（2026-08-04）：v1.7.0 的 Setup/Portable/主 EXE/elevate.exe 四项均 `NotSigned`，electron-builder 日志提及 signtool 但产物未签名；文档不写证书变量值/机密。
- 已知平台残余：Windows Node 无 `O_NOFOLLOW/openat`，file-browser 用 lstat 快照→open→fstat 比对（`openVerifiedRead`）纯 JS 防护，目录 reparse point 理论 TOCTOU 未能在 JS 层原子消除（受限威胁模型：同用户恶意/失陷进程 + 精确命中窗口）。

## 约定

- 计划文件执行日志格式：`日期 | 已完成 | 下一步 | 备注/阻塞`（M6 用"备注/阻塞"表头）。
- 文档一律中文、事实不夸大、引用证据标注来源；打包相关命令 `npm run pack:versioned:ca`（`NODE_OPTIONS=--use-system-ca`，严禁禁用 TLS 校验）。
