# Oracle 记忆（kimi-code-desktop）

## 项目约定（2026-08-02 起生效）

- 技术栈：Electron ^38（主进程 Node 22）、CommonJS、Windows 优先；原生 HTML+JS，无前端框架。
- 测试：无框架及 `npm test`；`tests/test-*.js` 用 `assert` 独立运行，清单见 `CONTRIBUTING.md` 约 42-56 行；可测模块不直接 `require('electron')`，以依赖注入解耦。
- 主进程网络请求优先 Electron `net.fetch`，以支持系统代理、Windows 证书存储及企业 CA；避免 Node 全局 `fetch`/`https`。
- 官方端点事实见 `docs/memory/librarian.md`（2026-08-02 验证）：`/latest` 返回 semver 文本，`/latest.json` 返回清单且失败回退文本，官方用 `semver.gt`；`~/.kimi-code/updates/latest.json` 是 CLI 专属缓存，桌面端只读、禁止写入。
- 历史回归：`compareSemver` 曾以 `!== 0` 将 local>remote 误报更新（`CHANGELOG:172`）；修改版本比较须保留 local>remote 无更新测试。
