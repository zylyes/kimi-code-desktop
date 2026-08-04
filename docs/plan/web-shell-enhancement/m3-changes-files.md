# M3 Changes/Files 只读服务与 UI

> 来源：`WEB_SHELL_ENHANCEMENT_PLAN.original.md` §7 M3、§8.1/§8.2、§10
> 归档日期：2026-08-03
> 状态：**已完成**（2026-08-03）
> 前置：M1（数据）/ M2（UI）
> 预计工作量：5–7 人日

## 任务

- [x] **M3-1** `git-service.js`：只读计算工作树变更——`git status --porcelain=v2 -z` + `git diff --numstat -z` + `git diff --cached --numstat -z`（三条命令输出均 NUL 分隔）；汇总 `ChangeEntry { id, path, status, unstaged: { adds, dels }, staged: { adds, dels } }`（staged/unstaged 各为独立统计对象，不用单个 `staged` 布尔）；每条目携带快照内唯一不可伪造 `id`；路径契约：存在文件 canonical realpath 校验，deleted/rename 源路径 lexical containment + 最近存在父目录 canonicalization；**非 git 仓库 → Changes 空态（"非 Git 仓库"），Files 独立可用**
  - 涉及：`src/main/git-service.js`（新，纯 Node，spawn git 只读参数白名单）
  - 验收：单测：三类变更混合仓库统计正确；rename 与含空格/制表符/换行路径解析正确；staged 与 unstaged 分开断言；git 缺失/非仓库 → `{ ok:false, reason }` 不崩溃且 Changes 空态、Files 可用；无 git 写参数泄漏（参数白名单断言）
- [x] **M3-2** 变更详情：单文件 diff 预览——请求必须引用当前 Git 快照返回的不可伪造 `entryId`/受控条目，不接受渲染层任意路径；diff 输出边读边限额（流式，达上限截断标注）；**第一版为后续可选任务，不阻塞 M3 出口**
  - 涉及：git-service.js
  - 验收：大文件 diff 不卡死主进程；预览与 `git diff` 输出一致；任意路径/过期 `entryId` 被拒绝（单测）
- [x] **M3-3** `file-browser.js`：白名单只读枚举/读取——根 = 已验证的活动会话工作目录（§5.3）；realpath 规范化、symlink/junction 解析后必须在根内、跳过 `.git` 与 `node_modules`（可配置）、单文件 ≤1 MB、单次枚举 ≤500 条
  - 涉及：`src/main/file-browser.js`（新，纯 Node）
  - 验收：单测：越界路径（`../`、绝对路径、symlink/junction 逃逸）全部拒绝；超限文件拒绝并给原因；空目录正常
- [x] **M3-4** Changes/Files 面板 UI：四标签骨架全建（M4 填充后两标签）；Changes 列表（path/status/adds/dels、staged/unstaged 分列、diff 展开可选——无 `touched-by-session` 徽标）、Files 树（目录展开、文件预览）
  - 涉及：`src/pages/workspace.html`、`workspace.js`；preload 桥补 `workspace:changes`、`workspace:files` 通道
  - 验收：真实仓库改文件 → 面板条目与 staged/unstaged 统计正确；untracked 标注；预览可开合（若实现）；"工作树基线"说明文案可见
- [x] **M3-5** 节流与缓存：变更计算 3s 防抖 + 前台窗口焦点/会话切换触发刷新；面板隐藏时不刷新
  - 涉及：workspace.js + main.js
  - 验收：连续编辑 CPU 不飙升；切会话数据正确换源（仅已验证会话）

## M3 出口

- [x] `tests/test-git-service.js`、`tests/test-file-browser.js` 通过（全量 21 个 `tests/test-*.js` 通过）
- [x] flag 开启下真实仓库全流程手测通过（`scripts/workspace-integration-probe.js`：verified session → Workspace WebContentsView → preload → IPC → Changes/Files/diff，面板控制台零 error）
- [x] **候选发布门 1**：技术门禁就绪，版本号仍由发布人决定

## 执行日志

日期 | 已完成 | 下一步 | 备注/阻塞
--- | --- | --- | ---
2026-08-03 | M3-1~M3-5 全部完成；Git/Files 服务、workspace IPC/UI、3 秒节流、受控 diff 全落地 | M4 Agents/Tasks 活动投影 | Oracle 审查两轮：发现并关闭会话授权、跨会话异步泄漏、快照跨 workDir、Git helper/输出上限、文件排除与 symlink 等问题；终局门禁通过。已接受：纯 Node 路径 API 非句柄级 TOCTOU 边界（严格拒绝 descendant symlink/junction + canonical 二次校验）；M6 再做运行时回归。
