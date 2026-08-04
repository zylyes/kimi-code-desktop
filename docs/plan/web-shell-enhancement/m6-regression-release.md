# M6 Windows 回归、安全门禁与发布

> 来源：`WEB_SHELL_ENHANCEMENT_PLAN.original.md` §7 M6、§10/§11/§12
> 归档日期：2026-08-03
> 状态：**已停止（2026-08-04，用户跳过人工验收与签名）**
> 前置：M3+M4+M5
> 预计工作量：2–3 人日
> 回归矩阵事实源：`docs/regression-workspace-m6.md`；发布/回滚流程：`docs/release-workspace-m6.md`

## 任务

- [ ] **M6-1** Windows 回归矩阵执行（§11 全部 10 用例）：托盘/通知/快捷键/单实例/覆盖层/面板场景（托盘单击/双击均按源码现状"显示主窗口"实测，L3102–3103）；面板反复开关 ≥10 次期间共享 WS 持续连接；feature flag 关闭路径（`workspacePanelEnabled:false` 行为等同 v1.7 基线）
  - 涉及：手测清单 `docs/` 下新增或复用
  - 验收：矩阵全绿或有明确结论
  - 状态：**用户跳过**。自动门禁已过（flag-off/flag-on 探针、全量单测、selfcheck，见 `docs/regression-workspace-m6.md` §2）；托盘单/双击与右键、原生通知 A→B→A、快捷键、单实例、overlay 视觉、主题、优雅退出、面板反复开关 ≥10 次共享 WS、create-in-dir index 时序、连续 ACP permission/elicitation 的 BrowserWindow 时序均未执行，未记录 PASS
- [x] **M6-2** 安全门禁：`workspace:*` IPC 审计（仅白名单通道、入参校验）、git-service 参数白名单断言、file-browser 逃逸用例复跑、日志脱敏复核（新增路径日志）
  - 涉及：git-service/file-browser/main.js
  - 验收：审计清单全过；无新暴露的任意路径 IPC
  - 完成：M6 Oracle 安全门禁通过（IPC 白名单与入参校验、参数白名单断言、逃逸用例复跑、日志脱敏/广播门），证据见 `docs/regression-workspace-m6.md` §2 A5
- [x] **M6-3** 打包验证：`npm run pack:versioned:ca`（`NODE_OPTIONS=--use-system-ca`），产物内确认 workspace.html/js/preload/新模块在列（`build.files` 模式覆盖性验证）
  - 涉及：package.json（如需调整 files 模式，仅此文件可改）
  - 验收：安装包运行后 flag 开启面板可用；未打包缺失项零
  - 完成：`release/v1.7.0`（2026-08-04）打包成功，`app.asar` 源文件哈希 25/25 一致、新模块在列，证据见 `docs/regression-workspace-m6.md` §2 A6
- [x] **M6-4** 发布与回滚流程文档（§12.3 落地）：flag 开关、发布顺序、回滚操作
  - 涉及：文档
  - 验收：流程演练通过（flag 关闭即回退到 v1.7 行为）
  - 完成：`docs/release-workspace-m6.md`（发布前置条件/顺序/回滚/Authenticode 状态）；flag-off 回退结论已在回归矩阵 §3 实证
- [ ] **M6-5** 发布候选全量回归（flag 开启策略由发布门决定）
  - 涉及：main.js 配置默认值
  - 验收：正式发布候选通过全部矩阵；flag 关闭回归确认回退到现状
  - 状态：**用户跳过**。受 M6-1 人工验收项与签名状态（NotSigned，见 `docs/release-workspace-m6.md` §4）双重限制；flag 默认保持 false，不改为 true，未达正式发布候选

## M6 出口

- 全部矩阵绿（含 feature flag 关闭路径、面板反复开关、共享 WS 持续连接、Git 特殊路径与 deleted/rename 路径安全）
- 安全审计零未决项
- 正式发布候选就绪（版本号与 flag 开启策略由发布门决定）

> 结论：自动门禁已完成；用户已明确跳过人工验收与签名，因此以上 M6 出口未达成，计划在此停止。

## 执行日志

日期 | 已完成 | 下一步 | 备注/阻塞
--- | --- | --- | ---
2026-08-04 | M6-2/M6-3/M6-4 完成，M6-1 自动门禁部分通过：全量 29 份 `tests/test-*.js`（含 Git 特殊/rename/deleted 与 file-browser 逃逸用例、M6 IPC/restore 专项）、M4 workspace selfcheck 61/61、M6 restore selfcheck 18/18、`npx electron scripts/workspace-integration-probe.js --all` exit 0（flag-off：10s×20 次采样无 workspace.html 且主 Web 会话 ready；flag-on：真实 WebContentsView 全链 IPC/Changes/Files/Projection）、Oracle 安全门禁通过、`release/v1.7.0` app.asar 源文件哈希 25/25 一致；发布/回滚流程文档入库 `docs/release-workspace-m6.md`，回归矩阵入库 `docs/regression-workspace-m6.md` | M6-1 人工验收与 M6-5 发布候选 | **阻塞**：① 托盘单/双击与右键、Windows 原生通知 A→B→A、快捷键、单实例、overlay 视觉、主题、优雅退出、面板反复开关 ≥10 次共享 WS、create-in-dir index 时序、连续 ACP permission/elicitation 的 BrowserWindow 时序均待人工，未记录 PASS；② Authenticode：NSIS/Portable/主 EXE/elevate.exe 均 `NotSigned`，无有效证书前仅内部测试包，配置证书重打后须以 `Get-AuthenticodeSignature` 复核 Valid；③ flag 默认保持 false，不改为 true
2026-08-04 | 自动门禁、安全审计、最终包内容核对完成 | 停止 M6 | 用户明确跳过 Windows 原生人工验收与代码签名证书配置；M6-1/M6-5 不记完成，产物仅限未签名内部测试，不达正式发布候选出口
