# Doc-writer 记忆（kimi-code-desktop）
## Web Shell 增强 M6 文档（2026-08-04）
- 回归矩阵事实源 `docs/regression-workspace-m6.md`（§11 十项用例：✅ 自动 / ⬜ 待人工；**未实际运行的人工项绝不写 PASS**）；发布/回滚流程 `docs/release-workspace-m6.md`（发布顺序内部候选→受控→再评估，一级回滚 flag=false、二级回退安装包，flag 默认保持 false）。
- 待人工 10 项（勿标 PASS）：托盘单/双击与右键、通知 A→B→A、快捷键、单实例、overlay、主题、优雅退出、面板开关 ≥10 次、create-in-dir index 时序、连续 ACP 的 BrowserWindow 时序。
- 签名状态与平台残余：electron-builder 日志提及 signtool 但产物未签名、文档不写证书变量值/机密；Windows 无 O_NOFOLLOW，file-browser 用 lstat→open→fstat（`openVerifiedRead`）纯 JS 防护，reparse point TOCTOU 未原子消除（同用户恶意进程威胁模型）。
## 约定
- 计划文件执行日志格式：`日期 | 已完成 | 下一步 | 备注/阻塞`。
- 文档一律中文、事实不夸大、引用证据标注来源。
