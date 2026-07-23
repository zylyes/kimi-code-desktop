### 改进

- **Windows 通知应用名显示修正**：启动时调用 `app.setAppUserModelId(APP_NAME)`，系统通知顶部显示「Kimi Code Desktop」，不再显示 Electron 默认的 `electron.app.*`。
- **kimi-theme.css 共享层扩充**：新增 `--font-mono` 令牌（各页等宽字体栈统一引用）与 `.mono` 工具类、新增 `--radius-sm`（8px）令牌；`.btn` 体系补齐 `.btn-secondary`/`.btn-danger` hover 态，新增 `.btn.ghost` 变体与共享 `.icon-btn`；上提弹窗家族共享组件（顶栏品牌区、bridge-warn、loading、notice、foot/hint 系、spinner 与 rot/rise 动画、420px 与 prefers-reduced-motion 媒体查询），permission 与 question 两窗重复 CSS 去重。
- **sessions 启动器配色收敛**：移除自造第三点缀色 `--color-warning`（琥珀色），归档标识与 bridge-warn 改灰阶中性色，回到主题「仅 error/success 两点缀色」原则。
- **各原生窗口令牌化清理**：圆角统一走 `--radius-pill`/`--radius-sm`/`--radius-card`，等宽字体栈统一 `var(--font-mono)`，焦点环统一走主题 `:focus-visible`，禁用态透明度统一 0.4；`.card`/`.btn-primary` 的逐属性复刻改为直接复用共享类。
- **Web UI 浮动设置按钮色值对齐**：main.js 注入的 `#kcd-settings-fab` 边框与阴影色值对齐主题 separator/shadow-card 令牌（亮/暗两套，注入页无法引用 var()，手写同值并注释来源）。

### 其他

- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
