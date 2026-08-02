# 项目共享记忆

## 项目概况

- Kimi Code Desktop 是 Electron 应用；主进程入口为 `src/main/main.js`，设置中心为 `src/pages/setup.html`。

## 重要决策

- CLI 最新版本以 `https://code.kimi.com/kimi-code/latest.json` 为主动检查源，失败回退 `/latest`；`~/.kimi-code/updates/latest.json` 仅是 CLI 本地缓存，远端失败时只能标注为辅助信息，不能据此宣称“已是最新”。
- CLI 更新网络请求由 `src/main/main.js` 注入 Electron `net.fetch` 给纯 Node 模块 `src/main/cli-update.js`，以兼顾系统代理/证书处理与单元测试可注入性。
- 更新检查 IPC 的不变式：`ok:true` 表示远端版本已严格校验；`ok:false` 不携带 `latest` 或 `updateAvailable`，可携带 `cachedLatest`/`cachedCheckedAt`。

## 常用路径与命令

- CLI 更新模块测试：`node tests/test-cli-update.js`
- 全量单元测试：逐个运行 `tests/test-*.js`
- 本机打包：`npm run pack` 需 `NODE_OPTIONS=--use-system-ca`（Node 默认 CA 库校验 electron-builder 下载请求失败；系统 CA 正常；严禁 `NODE_TLS_REJECT_UNAUTHORIZED=0` 禁用校验）
