/**
 * menu-panel.js —— Kimi Code Desktop 应用菜单面板（渲染端共享，无依赖）
 *
 * 挂载：DOMContentLoaded 时自动挂载右上角 ☰ 按钮（.kcd-menu-btn，38×32，
 * 视觉对齐悬浮窗控）：优先挂到 .app-topbar-actions 内（原生页），否则 fixed
 * 定位 top:0;right:142px（Web UI 页，紧贴 138px 悬浮窗控左缘）。
 * body 带 data-kcd-no-menu 属性、页面无 body 或桥接 kimiDesktopMenu 不存在时跳过。
 * 挂载后带自愈：MutationObserver + 1s 轮询检查按钮是否仍在 DOM，被 SPA 重渲染移除时自动重挂。
 *
 * 面板：点击 ☰ 经 IPC 拉取菜单定义（分组结构）并展开下拉；叶子项点击调用
 * kimiDesktopMenu.run(id) 并关闭；二级项原地切换子面板（顶部带返回项）；
 * Esc / 点外部 / 窗口 blur 关闭。
 *
 * 样式全部内联于下方 <style>，色值写成 var(--token, 兜底) 格式：本地页命中
 * kimi-theme.css 令牌，Web UI 页无令牌时用兜底色（与 kimi-theme.css 亮/暗令牌值一致，
 * 暗色经 @media (prefers-color-scheme: dark)）。
 *
 * 窗控样式跟随：主窗口 Web UI 页上，主进程会把 OS 绘制的 −▢× 悬浮窗控
 * （titleBarOverlay）的符号色与高度经 preload 桥广播给页面；本模块通过
 * kimiDesktopMenu.getTitlebarStyle / onTitlebarStyle 取到后以内联 style 写到 ≡ 上，
 * 使 ≡ 与原生三键颜色/高度一致。未收到广播时（如本地页，桥恒返回 null）维持样式表令牌色。
 */
(() => {
  'use strict';
  if (window.__kcdMenuPanelLoaded) return;
  window.__kcdMenuPanelLoaded = true;

  const STYLE_TEXT = `
.kcd-menu-btn{width:38px;height:32px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:none;border-radius:0;color:var(--label-secondary, #00000099);cursor:pointer;-webkit-app-region:no-drag;transition:background-color .15s ease,color .15s ease;flex:none;padding:0;}
.kcd-menu-btn--fixed{position:fixed;top:0;right:142px;z-index:2147483647;}
.kcd-menu-btn:hover{background:#00000012;color:var(--label-primary, #000000e6);}
.kcd-menu-btn:focus-visible{outline:2px solid var(--label-quaternary, #0000004d);outline-offset:-2px;}
.kcd-menu-btn svg{width:15px;height:15px;pointer-events:none;}
.kcd-menu-panel{position:fixed;z-index:2147483647;min-width:248px;max-width:340px;max-height:calc(100vh - 48px);overflow-y:auto;padding:6px;background:var(--bg-primary, #ffffff);border:1px solid var(--separator, #00000021);border-radius:14px;box-shadow:0 8px 30px #0000001f;font-family:var(--font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Noto Sans", Ubuntu, Cantarell, "Helvetica Neue", sans-serif, Arial, "PingFang SC", "Source Han Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC");font-size:13px;color:var(--label-primary, #000000e6);-webkit-app-region:no-drag;user-select:none;animation:kcdMenuIn .12s ease;}
@keyframes kcdMenuIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}
.kcd-menu-group-title{padding:12px 10px 4px;font-size:12px;line-height:1.4;color:var(--label-tertiary, #00000073);}
.kcd-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:var(--label-primary, #000000e6);font-family:inherit;font-size:13px;line-height:1.4;text-align:left;cursor:pointer;box-sizing:border-box;}
.kcd-menu-item:hover:not(.is-disabled){background:#00000008;}
.kcd-menu-item.is-disabled{opacity:.4;cursor:default;}
.kcd-menu-check{width:16px;flex:none;text-align:center;font-size:12px;}
.kcd-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kcd-menu-hint{flex:none;font-size:12px;color:var(--label-tertiary, #00000073);}
.kcd-menu-arrow{flex:none;font-size:12px;color:var(--label-tertiary, #00000073);}
.kcd-menu-sep{height:1px;margin:4px 10px;background:var(--separator, #00000021);}
.kcd-menu-back{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:var(--label-secondary, #00000099);font-family:inherit;font-size:13px;line-height:1.4;text-align:left;cursor:pointer;box-sizing:border-box;}
.kcd-menu-back:hover{background:#00000008;color:var(--label-primary, #000000e6);}
@media (prefers-color-scheme: dark){
.kcd-menu-btn{color:var(--label-secondary, #ffffff8f);}
.kcd-menu-btn:hover{background:#ffffff1a;color:var(--label-primary, #ffffffd6);}
.kcd-menu-btn:focus-visible{outline-color:var(--label-quaternary, #ffffff42);}
.kcd-menu-panel{background:var(--bg-secondary, #1f1f1f);border-color:var(--separator, #ffffff1f);color:var(--label-primary, #ffffffd6);}
.kcd-menu-item{color:var(--label-primary, #ffffffd6);}
.kcd-menu-item:hover:not(.is-disabled){background:#ffffff12;}
.kcd-menu-group-title{color:var(--label-tertiary, #ffffff6b);}
.kcd-menu-hint,.kcd-menu-arrow{color:var(--label-tertiary, #ffffff6b);}
.kcd-menu-sep{background:var(--separator, #ffffff1f);}
.kcd-menu-back{color:var(--label-secondary, #ffffff8f);}
.kcd-menu-back:hover{background:#ffffff12;color:var(--label-primary, #ffffffd6);}
}
`;

  let btn = null;
  let panel = null;
  // 子面板返回栈：[{ title, groups }]，空栈表示根面板
  const navStack = [];

  function injectStyle() {
    if (document.getElementById('kcd-menu-style')) return;
    const s = document.createElement('style');
    s.id = 'kcd-menu-style';
    s.textContent = STYLE_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }

  function closePanel() {
    if (panel) {
      panel.remove();
      panel = null;
    }
    navStack.length = 0;
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', closePanel);
    window.removeEventListener('resize', closePanel);
  }

  function onDocMouseDown(e) {
    if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) closePanel();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePanel();
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // 渲染一个菜单项：勾选态左侧 ✓，快捷键 hint 右侧，二级项右侧 ›
  function renderItem(item, ctx) {
    if (item && item.separator) {
      ctx.appendChild(el('div', 'kcd-menu-sep'));
      return;
    }
    if (!item || typeof item.label !== 'string') return;
    const row = el('button', 'kcd-menu-item');
    row.type = 'button';
    if (item.disabled) {
      row.classList.add('is-disabled');
      row.disabled = true;
    }
    row.appendChild(el('span', 'kcd-menu-check', item.checked ? '✓' : ''));
    row.appendChild(el('span', 'kcd-menu-label', item.label));
    if (Array.isArray(item.submenu)) {
      row.appendChild(el('span', 'kcd-menu-arrow', '›'));
      if (!item.disabled) {
        row.addEventListener('click', () => {
          navStack.push({ title: item.label, groups: ctx.__groups });
          renderGroups([{ title: '', items: item.submenu }]);
        });
      }
    } else {
      if (item.shortcut) row.appendChild(el('span', 'kcd-menu-hint', item.shortcut));
      if (!item.disabled) {
        row.addEventListener('click', () => {
          closePanel();
          try { window.kimiDesktopMenu.run(item.id); } catch { /* 桥接异常忽略 */ }
        });
      }
    }
    ctx.appendChild(row);
  }

  // 渲染一组（根面板为多组，子面板为单组 + 顶部返回项）
  function renderGroups(groups) {
    if (!panel) return;
    panel.innerHTML = '';
    const root = el('div');
    root.__groups = groups;
    if (navStack.length > 0) {
      const back = el('button', 'kcd-menu-back');
      back.type = 'button';
      back.appendChild(el('span', 'kcd-menu-arrow', '‹'));
      back.appendChild(el('span', 'kcd-menu-label', navStack[navStack.length - 1].title || '返回'));
      back.addEventListener('click', () => {
        const prev = navStack.pop();
        if (prev) renderGroups(prev.groups);
      });
      root.appendChild(back);
      root.appendChild(el('div', 'kcd-menu-sep'));
    }
    for (const group of groups) {
      if (!group || !Array.isArray(group.items)) continue;
      if (group.title) root.appendChild(el('div', 'kcd-menu-group-title', group.title));
      else if (root.childNodes.length > 0 && navStack.length === 0) root.appendChild(el('div', 'kcd-menu-sep'));
      for (const item of group.items) renderItem(item, root);
    }
    panel.appendChild(root);
  }

  async function openPanel() {
    if (!window.kimiDesktopMenu) return;
    let groups = null;
    try {
      groups = await window.kimiDesktopMenu.getDefinition();
    } catch { /* IPC 失败忽略 */ }
    if (!Array.isArray(groups) || groups.length === 0) return;
    if (panel) { closePanel(); return; }
    panel = el('div', 'kcd-menu-panel');
    panel.setAttribute('role', 'menu');
    document.body.appendChild(panel);
    // 定位于按钮下方、右对齐按钮右缘
    const r = btn.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 4)}px`;
    panel.style.right = `${Math.max(4, Math.round(window.innerWidth - r.right))}px`;
    renderGroups(groups);
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', closePanel);
    window.addEventListener('resize', closePanel);
  }

  function mount() {
    try {
      if (!document.body || document.body.hasAttribute('data-kcd-no-menu')) return;
      if (!window.kimiDesktopMenu) return;
      if (document.querySelector('.kcd-menu-btn')) return;
      injectStyle();
      btn = el('button', 'kcd-menu-btn');
      btn.type = 'button';
      btn.title = '菜单';
      btn.setAttribute('aria-label', '菜单');
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (panel) closePanel();
        else openPanel();
      });
      const actions = document.querySelector('.app-topbar-actions');
      if (actions) {
        actions.appendChild(btn);
      } else {
        btn.classList.add('kcd-menu-btn--fixed');
        document.body.appendChild(btn);
      }
      // 广播可能早于本次挂载/重挂到达，先用 preload 桥缓存值应用一次
      try {
        if (typeof window.kimiDesktopMenu.getTitlebarStyle === 'function') {
          applyTitlebarStyle(window.kimiDesktopMenu.getTitlebarStyle());
        }
      } catch { /* 取窗控样式缓存失败忽略 */ }
    } catch { /* 挂载失败不影响页面本身 */ }
  }

  // 应用主进程广播的窗控样式：让 ≡ 与 OS 绘制的 −▢× 悬浮窗控（titleBarOverlay）保持
  // 颜色/高度一致。symbolColor 写内联 style，优先于样式表令牌色（含 :hover 色——可接受，
  // 背景 hover 仍生效）；height 取整后钳制在 32~64，与原生键同中心线。
  function applyTitlebarStyle(style) {
    if (!btn || !style || typeof style !== 'object') return;
    if (typeof style.symbolColor === 'string') btn.style.color = style.symbolColor;
    const h = Math.round(Number(style.height));
    if (h >= 32 && h <= 64) btn.style.height = h + 'px';
  }

  // 自愈：SPA 路由切换/框架重渲染可能把 body 下的按钮节点移除，mount() 只跑一次就会永久丢失。
  // 持续检查按钮是否还在 DOM，掉了就重挂；只补按钮——面板状态独立处理：面板节点若一并
  // 被移除按关闭处理（清理监听），仍在 DOM 则原样保留，避免已打开的面板闪烁。
  function ensureMounted() {
    try {
      if (panel && !panel.isConnected) closePanel();
      if (btn && btn.isConnected) return;
      btn = null;
      mount();
    } catch { /* 自愈失败不影响页面本身 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // MutationObserver（发现按钮缺失后 150ms 内补挂；面板开合也会触发 observer，但按钮在时直接返回，
  // 成本可忽略）+ 1s 轮询兜底
  let healScheduled = false;
  const healObserver = new MutationObserver(() => {
    if (btn && btn.isConnected) return;
    if (healScheduled) return;
    healScheduled = true;
    setTimeout(() => { healScheduled = false; ensureMounted(); }, 150);
  });
  healObserver.observe(document.documentElement, { subtree: true, childList: true });
  setInterval(ensureMounted, 1000);

  // 订阅主进程窗控样式广播：回调直接作用于当前模块级 btn，自愈重挂后的新节点自然生效。
  // 广播只发到主窗口 Web UI 页；本地页桥 getTitlebarStyle 恒为 null，不会收到更新。
  try {
    if (window.kimiDesktopMenu && typeof window.kimiDesktopMenu.onTitlebarStyle === 'function') {
      window.kimiDesktopMenu.onTitlebarStyle(applyTitlebarStyle);
    }
  } catch { /* 订阅失败不影响菜单本身 */ }
})();
