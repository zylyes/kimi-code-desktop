# Librarian 记忆（kimi-code-desktop）

## 官方事实（2026-08-02 实弹验证，来源 MoonshotAI/kimi-code 源码 + code.kimi.com）

- 版本真相源是 CDN：`https://code.kimi.com/kimi-code`（302 → `cdn.kimi.com`），非 npm/GitHub Releases。
- Endpoint 链：
  - `/latest` → 纯文本 semver（install.ps1 默认取版本；CLI 的 fallback）
  - `/latest.json` → 灰度清单 `{schemaVersion, version, publishedAt, rollout:[{percent,delaySeconds}]}`，schema 非 strict、字段可能新增（实弹含 schemaVersion）
  - `/binaries/<v>/manifest.json` → `{version, tag, platforms:{win32-x64:{filename,checksum}}}`，checksum 为 sha256 64hex
  - `/binaries/<v>/<filename>` → 二进制（win32 为 `kimi-code-win32-<arch>.exe`）
- install.ps1 流程：`KIMI_VERSION` 固定版本，否则 GET `/latest` → GET manifest → 下载 → sha256 校验 → 复制到 `<KIMI_INSTALL_DIR 或 ~/.kimi-code>\bin\kimi.exe`（旧 exe 先改名 .bak）；覆盖安装即升级。
- `~/.kimi-code/updates/latest.json`：**CLI 本地缓存，非主动源**。strict schema `{source:'cdn', checkedAt:ISO|null, latest:semver|null, manifest:{version,publishedAt,rollout[]}|null}`；仅 CLI 启动 preflight 时写；网络失败不写（保留旧值）；读失败返回全 null。
- Windows native 安装无法自动升级：官方 `canAutoInstall('native','win32')===false`，只提示手动 `irm https://code.kimi.com/kimi-code/install.ps1 | iex`。
- 版本比较官方用 `semver.gt`（本地 compareSemver 只比 3 段数字、不处理 pre-release，有偏差）。
- CLI 超时 3s；`/latest.json` 失败静默回退 `/latest`，两者都失败才报错。

## 本地实现现状

- main.js `cli:checkUpdate` 主动查远端：先 `/latest.json`，失败（网络/非 2xx/解析失败/缺 version 字段/非法版本）自动回退 `/latest` 纯文本；仅远端成功才下"已是最新"结论（`isUpdateAvailable(current, latest)`，current 未知不算有更新）。
- cli-update.js 为纯 Node 模块，main.js 注入 Electron `net.fetch`（走 Chromium 代理与证书处理），测试注入桩；版本严格校验 `/^v?\d+\.\d+\.\d+$/` 并去 v 前缀，非法即无效；本地缓存只读 latest/checkedAt（缺失/损坏/latest 非法返回 null），永不写回。
- 远端失败时缓存仅作为标注辅助返回（cachedLatest/cachedCheckedAt），严禁携带 latest/updateAvailable；超时 5s。
- main.js `cli:install`/`cli:upgrade` spawn `irm https://code.kimi.com/kimi-code/install.ps1 | iex`，与官方 NATIVE_INSTALL_COMMAND_WIN 一致，正确。

## 官方事实（2026-08-02 二轮调研，来源 MoonshotAI/kimi-code main + ACP 规范）

- 源码仓库：MoonshotAI/kimi-code（TypeScript, MIT, monorepo：apps/kimi-code=CLI/TUI、packages/acp-adapter=ACP 层、packages/agent-core-v2、packages/node-sdk=@moonshot-ai/kimi-code-sdk、packages/oauth）。勿与 Python 版 MoonshotAI/kimi-cli 混淆。最新版 @moonshot-ai/kimi-code@0.31.1（2026-07-31）。
- 官方文档源：仓库 docs/ 目录（发布到 moonshotai.github.io/kimi-code 与 kimi.com/code/docs）。
- 数据目录（官方 data-locations.md）：`~/.kimi-code/`（KIMI_CODE_HOME 可迁移）；会话 `sessions/<wdKey>/<sessionId>/`（wdKey=`wd_<slug>_<sha256前12>`）；wire.jsonl 在 `agents/main/wire.jsonl`（主）与 `agents/agent-N/wire.jsonl`（子代理）；`state.json` 含 title/lastPrompt/forkedFrom；`tasks/`、`cron/`、`session_index.jsonl`。文档未列 usage.record 文件——usage.record 是 wire.jsonl 里的记录类型。
- wire `usage.record` 记录：`{type:'usage.record', model, usage:{inputOther,output,inputCacheRead,inputCacheCreation}, usageScope:'session'|'turn', time}`。其他 wire 记录：`turn.step.completed`（含 usage）、`context_size.measured`、`config.update`、v1 `agent.status.updated`（合并 usage+contextTokens+maxContextTokens+model；v2 拆分独立 Op）。
- TUI /usage 数据源（commands/info.ts）：session.getUsage()（SessionUsage{byModel,currentTurn,total}）+ contextTokens/maxContextTokens（来自 live agent.status.updated 事件或回放 resume state）+ getManagedUsage（仅 provider='managed:kimi-code' OAuth 登录时）。/status：session.getStatus()（SessionStatus 含 model/thinkingEffort/permission/planMode/contextTokens 等）+ appState。
- 平台额度接口：`GET {KIMI_CODE_BASE_URL 默认 https://api.kimi.com/coding/v1}/usages`，`Authorization: Bearer <OAuth accessToken>`，超时 8s；401/404 有专用提示文案。响应 `{usage:{used,limit,resetTime}, limits:[{window:{duration,timeUnit},detail}], boosterWallet}`，数字为十进制字符串；summary=周配额、extraUsage=booster 钱包（fixed-point 1e6）。API key 等其他 provider 无此接口。
- ACP（kimi acp，基于 @agentclientprotocol/sdk@0.23.0）：agent-side 稳定 10/12（initialize/authenticate/session:new/load/resume/prompt/cancel/list/set_mode/set_config_option），reverse-RPC 4/9（session/update、session/request_permission、fs/read、fs/write）。authMethods 仅 terminal-auth（id 'login'）。session/update 变体：agent_message_chunk/agent_thought_chunk/tool_call/tool_call_update/plan/config_option_update/available_commands_update；**kimi 未实现 ACP 的 usage_update**（规范 MAY，used/size/cost）。
- ACP 内置 slash（builtin-commands.ts）：compact/status/usage/mcp/tasks/help；ACP 下 `/usage` 输出=formatUsageReport(getUsage,getStatus)（**无平台配额**，TUI 版才有）；未知命令报 "Unknown ACP command"。
- Task/TaskOutput/TaskStop/CronCreate/CronList/CronDelete/Agent 全部是 **Agent 内置工具**（agent tool registry，profiles.ts 默认含），非 ACP RPC；对 ACP 客户端仅以 tool_call 通知呈现（toolCallId=`${turnId}:${rawId}`）。agent/rpc/rpcService.ts 的 getTaskOutput/getTasks 是内部 RPC（kap-server），非 ACP。
- **ACP 无子代理身份**：SessionUpdate 无 parent/child 字段（_meta 是保留扩展点）；kimi adapter 用 isFromMainAgent（agentId===undefined||'main'）过滤，子代理事件不推送。内部 metadata：registerAgent 记 {type:'main'|'sub',parentAgentId,forkedFrom,labels}；子代理再派生子代理时 labels 带 parentAgentId+swarmItem（subagentMetadata.ts）；hook 命令 SubagentStart/SubagentStop。
- 状态条计数（footer.ts + session-event-handler.ts syncBackgroundTaskBadge）：`[N task running]`=当前**非终态**（跳过 completed/failed/timed_out/killed/lost）的 bash 后台任务数；`[N agent running]`=同类后台子代理数；两个徽章独立。

## 官方事实（2026-08-04，Node/Windows symlink/junction TOCTOU 研究）

- **O_NOFOLLOW 在 Windows 不可用**：libuv `deps/uv/include/uv/win.h` 硬编码 `UV_FS_O_NOFOLLOW 0`（静默忽略）；`src/node_constants.cc` 用 `#ifdef O_NOFOLLOW` 导出 → win32 上 `fs.constants.O_NOFOLLOW` 为 undefined；fs.md flags 章节明确 Windows 仅可用 O_APPEND/O_CREAT/O_EXCL/O_RDONLY/O_RDWR/O_TRUNC/O_WRONLY/UV_FS_O_FILEMAP。
- **Windows 上 lstat 与 readdir 都能识别 junction**：libuv win/fs.c 的 lstat 用 `CreateFileW+FILE_FLAG_OPEN_REPARSE_POINT` 打开（不跟随），任何 reparse point（含 junction）置 `S_IFLNK` → `lstat().isSymbolicLink()` 对 junction 返回 true；scandir 同理 `UV__DT_LINK` → `readdir withFileTypes` 的 `Dirent.isSymbolicLink()` 对 junction 也 true。
- **Windows 上 st_ino 有效**：`statbuf->st_ino = stat_info.FileId.QuadPart`（NTFS 文件 ID，需 bigint:true 拿全 64 位）→ lstat 与 open 后 fstat 的 (st_dev, st_ino) 对比可做"打开后验证"，连 rename 替换（非 symlink）也能发现。
- **fs.realpath 全家不支持 fd**：path 仅 {string|Buffer|URL}，文档注明 "Only paths that can be converted to UTF-8 strings are supported"；FileHandle 无 realpath 方法（有 stat）。支持 fd 的是 fs.readFile/writeFile/fstat 等（参数类型 {string|Buffer|URL|integer}）。
- **Node 纯 JS 层无原子防 reparse 跟随手段**（无 O_NOFOLLOW、无 openat、无 FILE_FLAG_DISALLOW_PATH_REDIRECTS 暴露）；Windows 最强原子手段是 CreateFile3 的 `FILE_FLAG_DISALLOW_PATH_REDIRECTS`（路径被重定向即 ERROR_PATH_REDIRECTED），Node 不暴露，需 native 模块。现实模式 = lstat 检查 + open 后 fstat 对比（可验证关闭的 TOCTOU）。
