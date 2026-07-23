// Kimi Code Desktop — ACP 原生聊天原型窗渲染逻辑
// 只读原型：全部动态文本经 textContent 写入，杜绝 innerHTML 注入；
// message/thought 流式分片只进字符串缓冲，按 ~50ms 合帧统一写 DOM，
// 每类缓冲每帧最多一次 textContent 赋值（479 条/轮的思考分片也只写一次）。
(function () {
  'use strict';

  var FLUSH_MS = 50; // 流式渲染合帧间隔
  var SCROLL_TOLERANCE = 40; // 距底部多少像素内视为「未上翻」

  // ---------- DOM 引用 ----------
  var statusDot = document.getElementById('statusDot');
  var statusText = document.getElementById('statusText');
  var agentInfoEl = document.getElementById('agentInfo');
  var sessionInfoEl = document.getElementById('sessionInfo');
  var commandsInfoEl = document.getElementById('commandsInfo');
  var messagesEl = document.getElementById('messages');
  var messagesInner = document.getElementById('messagesInner');
  var errorBar = document.getElementById('errorBar');
  var errorText = document.getElementById('errorText');
  var retryBtn = document.getElementById('retryBtn');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('sendBtn');

  // ---------- 运行状态 ----------
  var connState = 'connecting'; // connecting | ready | error | exited
  var busy = false; // prompt 在途
  var currentTurn = null; // 当前 assistant 轮次容器
  var stickToBottom = true; // 用户未上翻时跟随滚动

  // 流式缓冲：chunk 只拼字符串，合帧时一次性写 DOM
  var msgBuf = '';
  var thoughtBuf = '';
  var flushTimer = null;

  // ---------- 状态条与输入可用态 ----------
  function refreshUi() {
    var cls;
    var text;
    if (connState === 'error') {
      cls = 'error'; text = '连接出错';
    } else if (connState === 'exited') {
      cls = 'exited'; text = '已退出';
    } else if (connState === 'connecting') {
      cls = 'connecting'; text = '正在连接…';
    } else if (busy) {
      cls = 'busy'; text = '正在生成…';
    } else {
      cls = 'ready'; text = '就绪';
    }
    statusDot.className = 'dot ' + cls;
    statusText.textContent = text;
    // 仅 ready 且非在途时可输入
    input.disabled = !(connState === 'ready' && !busy);
    refreshSendBtn();
  }

  function refreshSendBtn() {
    sendBtn.disabled = !(connState === 'ready' && !busy && input.value.trim());
  }

  // ---------- 错误提示条 ----------
  function showError(msg) {
    errorText.textContent = msg || '未知错误';
    errorBar.hidden = false;
  }

  function hideError() {
    errorBar.hidden = true;
  }

  // ---------- 滚动跟随 ----------
  messagesEl.addEventListener('scroll', function () {
    stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < SCROLL_TOLERANCE;
  }, { passive: true });

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function maybeScrollToBottom() {
    if (stickToBottom) scrollToBottom();
  }

  // ---------- 消息节点（一律 textContent，防注入） ----------
  function appendUserMessage(text) {
    var el = document.createElement('div');
    el.className = 'msg msg-user';
    el.textContent = text;
    messagesInner.appendChild(el);
  }

  function appendSystemNotice(text) {
    var el = document.createElement('div');
    el.className = 'msg msg-system';
    el.textContent = text;
    messagesInner.appendChild(el);
    maybeScrollToBottom();
  }

  // 每轮 assistant 容器：一个思考 details + 一个正文 div（思考有内容才展示）
  function createTurn() {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';

    var thought = document.createElement('details');
    thought.className = 'thought';
    thought.hidden = true;
    var summary = document.createElement('summary');
    summary.textContent = '思考过程';
    var thoughtBody = document.createElement('div');
    thoughtBody.className = 'thought-body';
    thought.appendChild(summary);
    thought.appendChild(thoughtBody);

    var textEl = document.createElement('div');
    textEl.className = 'assistant-text';

    wrap.appendChild(thought);
    wrap.appendChild(textEl);
    messagesInner.appendChild(wrap);

    return {
      thought: thought,
      thoughtEl: thoughtBody,
      textEl: textEl,
      textStr: '',
      thoughtStr: '',
      thoughtShown: false,
    };
  }

  function ensureTurn() {
    if (!currentTurn) currentTurn = createTurn();
    return currentTurn;
  }

  // ---------- 合帧渲染 ----------
  function flushBuffers() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!msgBuf && !thoughtBuf) return;
    var turn = ensureTurn();
    if (thoughtBuf) {
      turn.thoughtStr += thoughtBuf;
      turn.thoughtEl.textContent = turn.thoughtStr;
      if (!turn.thoughtShown) {
        turn.thought.hidden = false;
        turn.thoughtShown = true;
      }
      thoughtBuf = '';
    }
    if (msgBuf) {
      turn.textStr += msgBuf;
      turn.textEl.textContent = turn.textStr;
      msgBuf = '';
    }
    maybeScrollToBottom();
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flushBuffers, FLUSH_MS);
  }

  // ---------- 状态事件 ----------
  function onStatus(p) {
    connState = p.state || 'connecting';
    if (connState === 'ready') {
      hideError();
      var info = p.agentInfo && typeof p.agentInfo === 'object' ? p.agentInfo : {};
      var label = (typeof info.name === 'string' ? info.name : '') +
        (typeof info.version === 'string' ? ' ' + info.version : '');
      label = label.trim();
      agentInfoEl.textContent = label;
      agentInfoEl.hidden = !label;
      if (typeof p.sessionId === 'string' && p.sessionId) {
        sessionInfoEl.textContent = '会话 ' + p.sessionId.slice(0, 8);
        sessionInfoEl.hidden = false;
      }
    } else if (connState === 'error') {
      busy = false;
      showError(typeof p.message === 'string' && p.message ? p.message : '连接出错');
    } else if (connState === 'exited') {
      busy = false;
    }
    refreshUi();
  }

  // ---------- 事件分发 ----------
  function onEvent(p) {
    if (!p || typeof p !== 'object') return;
    switch (p.type) {
      case 'status':
        onStatus(p);
        break;
      case 'message-chunk':
        if (typeof p.text === 'string' && p.text) {
          msgBuf += p.text;
          scheduleFlush();
        }
        break;
      case 'thought-chunk':
        if (typeof p.text === 'string' && p.text) {
          thoughtBuf += p.text;
          scheduleFlush();
        }
        break;
      case 'commands':
        console.debug('[acp-chat] 可用命令数:', p.count);
        commandsInfoEl.textContent = '命令 ' + (typeof p.count === 'number' ? p.count : 0);
        commandsInfoEl.hidden = false;
        break;
      case 'permission-auto-cancel':
        appendSystemNotice('已自动取消一次权限请求（原型只读模式）');
        break;
      case 'prompt-done':
        flushBuffers();
        busy = false;
        refreshUi();
        break;
    }
  }

  // ---------- 发送 ----------
  function send() {
    var text = input.value.trim();
    if (!text || connState !== 'ready' || busy) return;

    flushBuffers(); // 防御：上一轮残余缓冲先落 DOM（正常为空）
    appendUserMessage(text);
    currentTurn = createTurn();
    msgBuf = '';
    thoughtBuf = '';
    busy = true;
    input.value = '';
    autoGrow();
    refreshUi();
    stickToBottom = true;
    scrollToBottom();

    window.kimiChat.sendPrompt(text).then(function (r) {
      if (!r || !r.ok) {
        appendSystemNotice('发送失败：' + (r && r.error ? r.error : '未知错误'));
      }
    }).catch(function (err) {
      appendSystemNotice('发送失败：' + String(err && err.message ? err.message : err));
    }).then(function () {
      flushBuffers();
      busy = false;
      refreshUi();
      input.focus();
    });
  }

  // ---------- 输入框 ----------
  // 自动增高：min 24px / max 170px，超出后内部滚动
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 170) + 'px';
    input.style.overflowY = input.scrollHeight > 170 ? 'auto' : 'hidden';
  }

  input.addEventListener('input', function () {
    autoGrow();
    refreshSendBtn();
  });
  input.addEventListener('keydown', function (e) {
    // Enter 发送 / Shift+Enter 换行；中文输入法组词中不触发发送
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);
  retryBtn.addEventListener('click', function () {
    start();
  });

  // ---------- 启动会话 ----------
  function start() {
    connState = 'connecting';
    busy = false;
    hideError();
    refreshUi();
    window.kimiChat.start().then(function (r) {
      if (!r || !r.ok) {
        // 主进程通常已推送 error 状态事件，此处兜底
        if (connState !== 'error') {
          connState = 'error';
          showError(r && r.error ? r.error : '启动失败');
          refreshUi();
        }
      }
      // 成功时状态条由 ready 事件驱动
    }).catch(function (err) {
      if (connState !== 'error') {
        connState = 'error';
        showError(String(err && err.message ? err.message : err));
        refreshUi();
      }
    });
  }

  // ---------- 初始化 ----------
  if (!window.kimiChat) {
    connState = 'error';
    statusDot.className = 'dot error';
    statusText.textContent = '桥接不可用';
    showError('未检测到桌面桥接接口（window.kimiChat），当前窗口无法执行任何操作。');
    input.disabled = true;
    sendBtn.disabled = true;
    retryBtn.disabled = true;
    return;
  }

  window.kimiChat.onEvent(onEvent);
  autoGrow();
  refreshUi();
  start();
})();
