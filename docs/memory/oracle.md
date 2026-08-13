# Oracle 记忆（kimi-code-desktop）

## 项目约定（2026-08-02 起生效）
- 技术栈与测试：Electron ^38（主进程 Node 22）、CommonJS、Windows 优先、原生 HTML+JS；无测试框架及 `npm test`，`tests/test-*.js` 用 `assert` 独立运行，可测模块通过依赖注入避免直接 `require('electron')`。
- 主进程网络请求优先 Electron `net.fetch`，以支持系统代理、Windows 证书存储及企业 CA；避免 Node 全局 `fetch`/`https`。
- 更新端点细节以 `docs/memory/librarian.md` 为事实源；裁决时坚持远端主动检查、CLI 缓存只读。
- 历史回归：`compareSemver` 曾以 `!== 0` 将 local>remote 误报更新（`CHANGELOG:172`）；修改版本比较须保留 local>remote 无更新测试。
