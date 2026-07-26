### 改进

- **蒙版切换变色链路重构（渲染端同步算色，根治 600ms+ 延迟）**：设置模态开/关窗控条变色不再等主进程防抖追采——preload 在 DOM 变化瞬间用 `elementsFromPoint` 对窗控采样点元素栈做 source-over 合成、同步算出目标色随 `kcd:titlebar-color` 直发主进程（即收即应用，无防抖）；蒙版淡入/淡出动画期 rAF 逐帧跟踪（`getComputedStyle` 实时反映 opacity 过渡）；主进程 350ms 后做一次 `capturePage` 校验采样兜底。逐帧实测全程无「页面已变窗控不动」，变色收敛 <100ms（原 600ms+）。
- `scripts/probe-panels.js` 扩展为蒙版开/关窗控变色逐帧 OS 级测量。

### 其他

- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
