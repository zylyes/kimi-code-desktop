### 修复

- **窗控颜色采样改进**：Web UI 页窗控区颜色采样从 preload `elementsFromPoint` 改为 main 进程 `capturePage` 众数像素（取页面实际渲染的众数色，自然剔除文字噪点），`setTitleBarOverlay` 同步更精确；preload 仅发变色信号，main 防抖 250ms 重采。
- **菜单按钮自愈重挂**：Web UI 页 ☰ 按钮注入改为 main 进程 `executeJavaScript`（绕过页面 CSP，`did-navigate-in-page` 同步补注），按钮带 MutationObserver + 轮询自愈（SPA 重渲染移除节点后自动补挂）。

### 其他

- `menu-panel.js` 加入打包清单（build.files），修复打包后菜单面板缺失
- CHANGELOG 措辞精修
- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
