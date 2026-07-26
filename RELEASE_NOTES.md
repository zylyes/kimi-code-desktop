### 修复

- **深色模式顶栏异色根治**：`header.chat-header` 强制背景色的暗色变体原挂在 `@media (prefers-color-scheme)`（跟随桌面应用主题），与 Web UI 自身主题设置解耦——Web UI 深色 + 桌面/系统浅色时头部被刷白、右上窗控采样随之整条顶栏发白。改为 preload 在内容区代表点用 `elementsFromPoint` source-over 合成判定**页面实际渲染主题**（亮度 ≤0.4 判暗），在 `<html>` 维护 `kcd-page-dark` 类，注入 CSS 暗色规则改挂该类；顶栏任何「Web UI 主题 × 桌面主题」组合下都与页面一致。
- **本地页面深色跟随 Web UI 实际主题**：全部本地页的暗色此前只经 `prefers-color-scheme` 跟随桌面主题，Web UI 深色时仍渲染浅色。新增生效主题裁决 `effectiveDark()`（桌面设置显式亮/暗优先，「跟随系统」时随 Web UI 实际主题），preload 检测翻转经 `kcd:page-theme` 上报，主进程向所有窗口与覆盖层页面置 `kcd-page-dark`/`kcd-page-light` 类并刷新窗口底色与悬浮窗控。

### 其他

- `kimi-theme.css` 暗色令牌与 `menu-panel.js` 暗色规则改为「类驱动 + 媒体查询兜底」双通道
- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
