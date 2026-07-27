// Kimi Code Desktop — Markdown / 代码高亮渲染模块（UMD 双兼容）
// 浏览器：<script src="chat-markdown.js"> → window.KcdMarkdown
// Node：require('./src/pages/chat-markdown.js')

// Node 下 DOMPurify 需要 window 桩，在 UMD 外层先定义
function createDomPurifyWindow() {
  function minimalDoc() {
    var doc = {};
    function mkEl(tag) {
      return {
        tagName: (tag || 'div').toUpperCase(),
        nodeType: 1,
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: doc,
        parentNode: null,
        childNodes: [],
        attributes: {},
        style: {},
        innerHTML: '',
        textContent: '',
        setAttribute: function (n, v) { this.attributes[n] = v; },
        getAttribute: function (n) { return this.attributes[n] || null; },
        hasAttribute: function (n) { return n in this.attributes; },
        removeAttribute: function (n) { delete this.attributes[n]; },
        appendChild: function (c) { this.childNodes.push(c); c.parentNode = this; return c; },
        removeChild: function (c) { var i = this.childNodes.indexOf(c); if (i > -1) this.childNodes.splice(i, 1); return c; },
        insertBefore: function (c, ref) { this.childNodes.push(c); c.parentNode = this; return c; },
        cloneNode: function () { return mkEl(this.tagName); },
        querySelectorAll: function () { return []; },
        querySelector: function () { return null; },
        getElementsByTagName: function () { return []; },
        setAttributeNS: function () {},
        addEventListener: function () {},
        removeEventListener: function () {},
        focus: function () {},
      };
    }
    doc.createElement = mkEl;
    doc.createTextNode = function (text) { return { nodeType: 3, textContent: text, data: text, ownerDocument: doc }; };
    doc.createDocumentFragment = function () { return { nodeType: 11, childNodes: [], appendChild: function () {} }; };
    doc.createComment = function () { return { nodeType: 8 }; };
    doc.documentElement = mkEl('html');
    doc.head = mkEl('head');
    doc.body = mkEl('body');
    doc.implementation = {
      createHTMLDocument: function (title) { var nd = minimalDoc(); nd.title = title || ''; return nd; },
      hasFeature: function () { return true; },
    };
    doc.defaultView = null;
    return doc;
  }
  var d = minimalDoc();
  var w = {
    document: d,
    location: { href: '', origin: 'null', protocol: 'https:', host: 'localhost' },
    navigator: { userAgent: 'Node.js' },
    DocumentFragment: function () {},
    HTMLTemplateElement: function () {},
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11, DOCUMENT_NODE: 9 },
    name: 'DOMPurifyNodeStub',
    self: null, top: null, parent: null,
    frames: [], length: 0,
    addEventListener: function () {}, removeEventListener: function () {},
    getComputedStyle: function () { return {}; },
    devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_COMMENT: 128, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    Blob: (typeof Blob !== 'undefined' ? Blob : function () {}),
    URL: { createObjectURL: function () { return ''; }, revokeObjectURL: function () {} },
    Error: Error, EvalError: EvalError, RangeError: RangeError,
    ReferenceError: ReferenceError, SyntaxError: SyntaxError,
    TypeError: TypeError, URIError: URIError,
  };
  d.defaultView = w;
  return w;
}

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    // Node — 尝试加载依赖，缺失时降级
    var mkd, domp, hl;
    try { mkd = require('marked'); } catch (e) { mkd = null; }
    try {
      // DOMPurify 在 Node 下需要 window/DOM 环境
      // 先设好全局 window 再 require，因为 purify.cjs.js 在模块加载时就执行了 createDOMPurify()
      var existingWin = typeof globalThis !== 'undefined' ? globalThis.window : undefined;
      if (!existingWin || !existingWin.document || !existingWin.document.implementation ||
          !existingWin.document.implementation.createHTMLDocument) {
        var dpWin = createDomPurifyWindow();
        globalThis.window = dpWin;
        // 清除 require 缓存，使 dompurify 以新 window 重新加载
        try {
          var purifyPath = require.resolve('dompurify');
          delete require.cache[purifyPath];
        } catch (pe) { /* ignore */ }
        try {
          var purifyAltPath = require.resolve('dompurify/dist/purify.cjs.js');
          delete require.cache[purifyAltPath];
        } catch (pe) { /* ignore */ }
      }
      domp = require('dompurify');
      // dompurify CJS 返回 createDOMPurify() 的产物，应包含 sanitize
      if (typeof domp === 'function' && typeof domp.sanitize !== 'function') {
        // 极特殊情形：是工厂而非实例，用 window 初始化
        domp = domp(globalThis.window || dpWin);
      }
    } catch (e) { domp = null; }
    try { hl = require('highlight.js'); } catch (e) { hl = null; }
    module.exports = factory(mkd, domp, hl);
  } else if (typeof define === 'function' && define.amd) {
    define(['marked', 'dompurify', 'highlight.js'], factory);
  } else {
    // Browser — 从全局变量获取
    root.KcdMarkdown = factory(
      root.marked || null,
      root.DOMPurify || null,
      root.hljs || null
    );
  }
})(this, function (marked, DOMPurify, hljs) {
  'use strict';

  // ==================== 配置 ====================

  var SANITIZE_TAGS = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'code', 'pre', 'span', 'div',
    'a', 'strong', 'em', 'b', 'i',
    'blockquote', 'hr', 'br', 'del',
    'input'
  ];

  var SANITIZE_ATTRS = [
    'href', 'target', 'rel', 'title', 'alt',
    'class', 'id', 'src', 'width', 'height',
    'type', 'checked', 'disabled',
    'lang', 'language',
    'style', 'align'
  ];

  // 纯文本模式 key
  var PLAINTEXT_KEY = 'kcd-chat-plaintext';

  // ==================== 公共 API ====================

  var api = {};

  /** 判断纯文本模式 */
  api.isPlainText = function () {
    try {
      return localStorage.getItem(PLAINTEXT_KEY) === '1';
    } catch (e) {
      return false;
    }
  };

  /** 设置纯文本模式 */
  api.setPlainText = function (val) {
    try {
      if (val) {
        localStorage.setItem(PLAINTEXT_KEY, '1');
      } else {
        localStorage.removeItem(PLAINTEXT_KEY);
      }
    } catch (e) { /* ignore */ }
  };

  /** 获取 DOMPurify 实例（可能为 null） */
  api.getDOMPurify = function () {
    return DOMPurify;
  };

  /** 获取 marked 实例（可能为 null） */
  api.getMarked = function () {
    return marked;
  };

  /** 获取 hljs 实例（可能为 null） */
  api.getHljs = function () {
    return hljs;
  };

  // ==================== Sanitize 配置 ====================

  /** 构建 DOMPurify sanitize 配置 */
  api.getSanitizeConfig = function () {
    return {
      ALLOWED_TAGS: SANITIZE_TAGS,
      ALLOWED_ATTR: SANITIZE_ATTRS,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'form'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onsubmit', 'onchange', 'oninput', 'onkeydown', 'onkeyup'],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
      ADD_ATTR: ['target', 'rel'],
      ADD_TAGS: [],
      WHOLE_DOCUMENT: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
      RETURN_TRUSTED_TYPE: true,
    };
  };

  /** 对 HTML 做链接安全后处理：a 标签补 target/rel，移除 javascript: 协议等 */
  api.postProcessLinks = function (html) {
    // 用正则简单处理：补 target=_blank rel=noopener，移除 javascript: 协议
    return html.replace(/<a\s+/gi, '<a target="_blank" rel="noopener" ');
  };

  // ==================== Markdown 渲染（含缓存） ====================

  /**
   * 渲染 assistant 消息（带缓存）
   * @param {string} textStr - 当前完整文本
   * @param {object} turn - 轮次对象，含 .textStr, .cachedHtml, .textEl
   * @param {boolean} forcePlain - 强制纯文本
   * @returns {string|null} HTML 字符串（有变化时），null 表示无变化
   */
  api.renderAssistantMessage = function (textStr, turn, forcePlain) {
    if (!textStr) {
      if (turn.textEl) turn.textEl.textContent = '';
      return '';
    }
    // 检查纯文本模式
    if (forcePlain || api.isPlainText()) {
      if (turn.textEl) turn.textEl.textContent = textStr;
      return null;
    }
    // 缓存命中：文本无变化
    if (turn.cachedText === textStr && turn.cachedHtml !== undefined) {
      return null; // 无变化
    }
    // 文本变化，重新解析
    try {
      var html = renderMarkdown(textStr);
      turn.cachedText = textStr;
      turn.cachedHtml = html;
      if (turn.textEl) {
        turn.textEl.innerHTML = html;
        // 代码高亮
        highlightCodeBlocks(turn.textEl);
        // 代码块复制按钮
        addCopyButtons(turn.textEl);
        // 链接安全
        secureLinks(turn.textEl);
        // 复选框 disabled
        disableCheckboxes(turn.textEl);
      }
      return html;
    } catch (e) {
      // 异常兜底：回退纯文本
      if (turn.textEl) turn.textEl.textContent = textStr;
      turn.cachedText = textStr;
      turn.cachedHtml = null;
      return null;
    }
  };

  /** 纯 Markdown → HTML 转换 */
  function renderMarkdown(text) {
    if (!marked || typeof marked.parse !== 'function') {
      return escapeHtml(text);
    }
    var raw = marked.parse(text, {
      breaks: true,
      gfm: true,
    });
    // Sanitize
    if (DOMPurify && typeof DOMPurify.sanitize === 'function') {
      raw = DOMPurify.sanitize(raw, api.getSanitizeConfig());
    }
    // 链接后处理
    raw = api.postProcessLinks(raw);
    return raw;
  }

  /** 简易 HTML 转义（marked 不可用时的兜底） */
  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==================== 代码高亮 ====================

  function highlightCodeBlocks(container) {
    if (!hljs || typeof hljs.highlightElement !== 'function') return;
    var codes = container.querySelectorAll('pre code');
    for (var i = 0; i < codes.length; i++) {
      try {
        hljs.highlightElement(codes[i]);
      } catch (e) {
        // 未知语言或出错，跳过
      }
    }
  }

  // ==================== 复制按钮 ====================

  /** 为所有代码块添加复制按钮 */
  function addCopyButtons(container) {
    if (!container) return;
    var pres = container.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      if (pres[i].querySelector('.kcd-copy-btn')) continue; // 已有按钮
      var code = pres[i].querySelector('code');
      if (!code) continue;
      var btn = document.createElement('button');
      btn.className = 'kcd-copy-btn';
      btn.textContent = '复制';
      btn.setAttribute('aria-label', '复制代码');
      btn.addEventListener('click', (function (codeEl, btnEl) {
        return function () {
          var text = codeEl.textContent || '';
          copyToClipboard(text).then(function () {
            var orig = btnEl.textContent;
            btnEl.textContent = '已复制';
            setTimeout(function () { btnEl.textContent = orig; }, 1500);
          }).catch(function () {
            btnEl.textContent = '复制失败';
            setTimeout(function () { btnEl.textContent = '复制'; }, 1500);
          });
        };
      })(code, btn));
      // 使 pre 成为相对定位容器（按钮绝对定位）
      var position = getComputedStyle(pres[i]).position;
      if (position === 'static') {
        pres[i].style.position = 'relative';
      }
      pres[i].appendChild(btn);
    }
  }

  /** 为 assistant 消息添加消息级复制按钮（复制 Markdown 原文） */
  api.addMessageCopyButton = function (textEl, getTextFn) {
    if (!textEl || textEl.querySelector('.kcd-msg-copy-btn')) return;
    var actionBar = textEl.querySelector('.kcd-msg-actions');
    if (!actionBar) {
      actionBar = document.createElement('div');
      actionBar.className = 'kcd-msg-actions';
      textEl.appendChild(actionBar);
    }
    var btn = document.createElement('button');
    btn.className = 'kcd-msg-copy-btn';
    btn.textContent = '复制内容';
    btn.setAttribute('aria-label', '复制 Markdown 原文');
    btn.addEventListener('click', function () {
      var text = typeof getTextFn === 'function' ? getTextFn() : String(getTextFn);
      copyToClipboard(text).then(function () {
        var orig = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = orig; }, 1500);
      }).catch(function () {
        btn.textContent = '复制失败';
        setTimeout(function () { btn.textContent = '复制内容'; }, 1500);
      });
    });
    actionBar.appendChild(btn);
  };

  // ==================== 链接安全 ====================

  function secureLinks(container) {
    if (!container) return;
    var links = container.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      // 补 target / rel
      if (!a.getAttribute('target')) a.setAttribute('target', '_blank');
      if (!a.getAttribute('rel')) a.setAttribute('rel', 'noopener');
      // 检查 href 协议
      var href = a.getAttribute('href') || '';
      if (/^javascript:/i.test(href)) {
        a.setAttribute('href', '');
        a.style.display = 'none';
      }
    }
  }

  // ==================== 复选框 ====================

  function disableCheckboxes(container) {
    if (!container) return;
    var inputs = container.querySelectorAll('input[type=checkbox]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].disabled = true;
    }
  }

  // ==================== 剪贴板 ====================

  function copyToClipboard(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      return navigator.clipboard.writeText(text).catch(function () {
        return fallbackCopy(text);
      });
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  // ==================== TodoList 解析与渲染 ====================

  /**
   * 尝试从工具调用的 detail/output 中解析待办列表
   * @param {object} call - 工具调用对象（含 title, detail, output）
   * @param {string} outputStr - 累积的输出文本
   * @returns {{ items: Array, isTodo: boolean, html: string|null }}
   */
  api.parseTodoList = function (call, outputStr) {
    // 1. 检查 title 是否匹配待办工具（大小写不敏感）
    var title = (call && typeof call.title === 'string') ? call.title : '';
    var todoPattern = /todo(?:write|list)|todo_write|todo_list/i;
    if (!todoPattern.test(title)) {
      return { items: [], isTodo: false, html: null };
    }

    // 2. 收集文本来源：优先 output，其次 detail
    var text = '';
    if (typeof outputStr === 'string' && outputStr) {
      text = outputStr;
    } else if (call && typeof call.output === 'string' && call.output) {
      text = call.output;
    } else if (call && typeof call.detail === 'string' && call.detail) {
      text = call.detail;
    }

    if (!text) {
      return { items: [], isTodo: true, html: '<div class="kcd-todo-empty">无待办数据</div>' };
    }

    // 3. 尝试解析 JSON
    try {
      // 从文本中提取 JSON 数组（可能被包裹）
      var jsonStr = text;
      // 尝试找 JSON 数组
      var match = text.match(/\[[\s\S]*?\]/);
      if (match) jsonStr = match[0];
      var data = JSON.parse(jsonStr);
      var items = Array.isArray(data) ? data : (Array.isArray(data.todos) ? data.todos : (Array.isArray(data.items) ? data.items : null));
      if (!items) {
        return { items: [], isTodo: true, html: api.renderTodoItems([]) };
      }
      return { items: items, isTodo: true, html: api.renderTodoItems(items) };
    } catch (e) {
      // 解析失败，按纯文本行处理
      var lines = text.split('\n').filter(function (l) { return l.trim(); });
      var parsed = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        var done = /^\[[xX]\]/.test(line);
        var label = line.replace(/^\[[ xX]\]\s*/, '');
        if (label) {
          parsed.push({ text: label, done: done });
        }
      }
      if (parsed.length > 0) {
        return { items: parsed, isTodo: true, html: api.renderTodoItems(parsed) };
      }
      return { items: [], isTodo: true, html: null }; // 无法解析，null 表示 fallback
    }
  };

  /**
   * 渲染待办卡片 HTML
   * @param {Array} items - [{ text, done }] 或 [{ title, done }] 或 [{ content, completed }]
   */
  api.renderTodoItems = function (items) {
    if (!Array.isArray(items) || items.length === 0) {
      return '<div class="kcd-todo-empty">暂无待办</div>';
    }

    // 归一化：支持多种字段名
    var normalized = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (typeof it === 'string') {
        normalized.push({ text: it, done: false });
      } else if (it && typeof it === 'object') {
        var text = it.text || it.title || it.content || it.description || '';
        var done = it.done === true || it.completed === true || it.status === 'completed' || it.status === 'done';
        normalized.push({ text: text, done: done });
      }
    }

    // 超 8 条折叠
    var MAX_VISIBLE = 8;
    var showAll = normalized.length <= MAX_VISIBLE;
    var visible = showAll ? normalized : normalized.slice(0, MAX_VISIBLE);
    var hidden = showAll ? [] : normalized.slice(MAX_VISIBLE);

    var html = '<div class="kcd-todo-list">';
    for (var j = 0; j < visible.length; j++) {
      var item = visible[j];
      var cls = 'kcd-todo-item' + (item.done ? ' kcd-todo-done' : '');
      html += '<label class="' + cls + '">';
      html += '<input type="checkbox" disabled' + (item.done ? ' checked' : '') + '>';
      html += '<span>' + escapeHtml(item.text || '') + '</span>';
      html += '</label>';
    }
    if (!showAll) {
      html += '<div class="kcd-todo-collapsed">还有 ' + hidden.length + ' 项…</div>';
    }
    html += '</div>';
    return html;
  };

  // ==================== DOM 链接点击拦截 ====================

  /**
   * 在容器上监听 a 标签点击，走系统浏览器打开
   * @param {Element} container - 父容器
   * @param {function} openExternal - 打开外部链接的函数
   * @returns {function} 退订函数
   */
  api.setupLinkHandler = function (container, openExternal) {
    if (!container || typeof openExternal !== 'function') return function () {};
    var handler = function (e) {
      var target = e.target;
      while (target && target !== container) {
        if (target.tagName === 'A') {
          var href = target.getAttribute('href');
          if (href && /^(https?|mailto):/i.test(href)) {
            e.preventDefault();
            openExternal(href);
            return;
          }
          break;
        }
        target = target.parentNode;
      }
    };
    container.addEventListener('click', handler);
    return function () {
      container.removeEventListener('click', handler);
    };
  };

  return api;
});
