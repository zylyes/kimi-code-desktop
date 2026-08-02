# Oracle 记忆（kimi-code-desktop）

## 项目约定（2026-08-02 起生效）

- 技术栈：Electron ^38（主进程 Node 22，有全局 fetch）、CommonJS、Windows 优先；无前端框架，页面为原生 HTML+JS。
- 测试约定：无测试框架、无 npm test 脚本。`tests/test-*.js` 为独立 node 脚本（`assert` + console.log + process.exit(0/1)），逐个 `node tests/test-x.js` 运行；清单维护在 CONTRIBUTING.md 约 42-56 行。可测模块不得 require('electron')，通过依赖注入（如 fetchImpl）解耦，与 config-manager 等模块一致。
- 主进程网络请求：优先 Electron `net.fetch`（Chromium 栈，走系统代理 + Windows 证书存储；本项目用户有企业 CA 场景，见 package.json pack:versioned:ca）。Node 全局 fetch/https 不走系统代理，避免。
- 官方端点事实（详见 docs/memory/librarian.md，2026-08-02 实弹验证）：真相源 `https://code.kimi.com/kimi-code`（302→cdn.kimi.com）；`/latest` 纯文本 semver；`/latest.json` = `{schemaVersion, version, publishedAt, rollout}`（schema 非 strict）；本地缓存 `~/.kimi-code/updates/latest.json` 归 CLI 写，桌面端只读，schema strict `{source, checkedAt, latest, manifest}`。CLI 自身超时 3s，JSON 失败回退 text。官方用 semver.gt。
- `~/.kimi-code/updates/latest.json` 桌面端禁止写入（CLI 专属）。
- 历史回归：compareSemver 曾用 `!== 0` 导致本地高于远端也提示更新（CHANGELOG:172），凡动版本比较必须保留 local>remote → 无更新 的测试。

## 工作方式

- 只读（除本文件）：建议+契约输出，不改代码；超出边界向 orchestrator 报告。
