// Kimi Code Desktop — ACP 原生聊天原型窗渲染逻辑
// 只读原型：全部动态文本经 textContent 写入，杜绝 innerHTML 注入；
// message/thought 流式分片只进字符串缓冲，按 ~50ms 合帧统一写 DOM，
// 每类缓冲每帧最多一次 textContent 赋值（479 条/轮的思考分片也只写一次）。
// 工具调用渲染为卡片节点插入当前轮次容器，由 tool-call-update 就地更新状态与输出。
// 配置切换栏（模型/思考/模式）数据来自 status ready / config-options 事件的
// configOptions，字段缺失时隐藏对应下拉；切换失败回滚选中值并系统提示。
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
  var sessionBarEl = document.getElementById('sessionBar');
  var sessionTitleEl = document.getElementById('sessionTitle');
  var workDirEl = document.getElementById('workDir');
  var configBarEl = document.getElementById('configBar');
  var messagesEl = document.getElementById('messages');
  var messagesInner = document.getElementById('messagesInner');
  var errorBar = document.getElementById('errorBar');
  var errorText = document.getElementById('errorText');
  var retryBtn = document.getElementById('retryBtn');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('sendBtn');
  var sendArrow = document.getElementById('sendArrow');
  var sendStopLabel = document.getElementById('sendStopLabel');

  // 配置切换栏三项：按 configOptions 项的 id 匹配，label 为固定中文小字
  var CONFIG_IDS = ['model', 'thinking', 'mode'];
  var configEls = {
    model: {
      item: document.getElementById('configItem-model'),
      select: document.getElementById('configSelect-model'),
    },
    thinking: {
      item: document.getElementById('configItem-thinking'),
      select: document.getElementById('configSelect-thinking'),
    },
    mode: {
      item: document.getElementById('configItem-mode'),
      select: document.getElementById('configSelect-mode'),
    },
  };

  // ---------- 运行状态 ----------
  var connState = 'connecting'; // connecting | ready | error | exited
  var busy = false; // prompt 在途
  var permissionPending = false; // 权限审批等待中（视为 busy 态）
  var cancelling = false; // 已发起取消、等待 prompt-done
  var configChanging = false; // 配置切换在途（全部下拉禁用）
  var configOptions = null; // 最近一次下发的 configOptions（三项 select 配置）
  var currentTurn = null; // 当前 assistant 轮次容器
  var stickToBottom = true; // 用户未上翻时跟随滚动
  var lastStartOpts = undefined; // 最近一次 start 参数（重试沿用）

  // 流式缓冲：chunk 只拼字符串，合帧时一次性写 DOM
  var msgBuf = '';
  var thoughtBuf = '';
  var userBuf = ''; // agent 侧重放的用户消息分片
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
    } else if (permissionPending) {
      cls = 'busy'; text = '等待审批…';
    } else if (busy) {
      cls = 'busy'; text = '正在生成…';
    } else {
      cls = 'ready'; text = '就绪';
    }
    statusDot.className = 'dot ' + cls;
    statusText.textContent = text;
    // 仅 ready 且非在途、无待审批时可输入
    input.disabled = !(connState === 'ready' && !busy && !permissionPending);
    refreshSendBtn();
    refreshConfigBar();
  }

  // busy（含权限待审批）时发送按钮变为「停止」（改文案不改节点），点击走取消
  function refreshSendBtn() {
    if (busy || permissionPending) {
      sendBtn.disabled = cancelling;
      sendStopLabel.textContent = cancelling ? '停止中…' : '停止';
      sendStopLabel.hidden = false;
      sendArrow.hidden = true;
      sendBtn.classList.add('stop-mode');
      sendBtn.title = '停止';
      sendBtn.setAttribute('aria-label', '停止');
    } else {
      sendBtn.disabled = !(connState === 'ready' && input.value.trim());
      sendStopLabel.hidden = true;
      sendArrow.hidden = false;
      sendBtn.classList.remove('stop-mode');
      sendBtn.title = '发送';
      sendBtn.setAttribute('aria-label', '发送');
    }
  }

  // 配置下拉仅 ready 且非在途、无待审批、无切换在途时可操作
  function refreshConfigBar() {
    var usable = connState === 'ready' && !busy && !permissionPending && !configChanging;
    for (var i = 0; i < CONFIG_IDS.length; i++) {
      configEls[CONFIG_IDS[i]].select.disabled = !usable;
    }
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
      wrap: wrap,
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
    // agent 侧重放的用户消息：flush 时一次性渲染，不逐 chunk 建节点
    if (userBuf) {
      appendUserMessage(userBuf);
      userBuf = '';
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

  // ---------- 工具调用卡片 ----------
  // toolCallId → 卡片引用映射：普通对象即可，session 生命周期内有效，窗口关闭即弃
  var toolCards = {};

  // 状态文案与色点 class（复用状态条 .dot 色系语义，不新增颜色）
  var TOOL_STATUS = {
    pending: { text: '待处理', cls: 'connecting' },
    in_progress: { text: '执行中', cls: 'busy' },
    completed: { text: '已完成', cls: 'ready' },
    failed: { text: '失败', cls: 'error' },
  };

  function applyToolStatus(ref, status) {
    var s = TOOL_STATUS[status] || TOOL_STATUS.pending;
    ref.dot.className = 'dot tool-dot ' + s.cls;
    ref.statusText.textContent = s.text;
  }

  // 卡片结构：标题行（状态点 + 标题 + kind 徽标 + 状态文本）
  // + details 折叠的 detail 文本 + tool-call-update 追加的输出摘要区
  function createToolCard(call) {
    var card = document.createElement('div');
    card.className = 'tool-card';

    var head = document.createElement('div');
    head.className = 'tool-head';
    var dot = document.createElement('span');
    var title = document.createElement('span');
    title.className = 'tool-title';
    title.textContent = typeof call.title === 'string' && call.title ? call.title : '工具调用';
    var statusText = document.createElement('span');
    statusText.className = 'tool-status';
    head.appendChild(dot);
    head.appendChild(title);
    if (typeof call.kind === 'string' && call.kind) {
      var kind = document.createElement('span');
      kind.className = 'tool-kind';
      kind.textContent = call.kind;
      head.appendChild(kind);
    }
    head.appendChild(statusText);
    card.appendChild(head);

    var detail = document.createElement('details');
    detail.className = 'tool-detail';
    detail.hidden = true; // 有内容才展示
    var summary = document.createElement('summary');
    summary.textContent = '详情';
    var detailBody = document.createElement('div');
    detailBody.className = 'tool-detail-body';
    detail.appendChild(summary);
    detail.appendChild(detailBody);
    card.appendChild(detail);

    var output = document.createElement('div');
    output.className = 'tool-output';
    output.hidden = true;
    card.appendChild(output);

    var ref = {
      el: card,
      dot: dot,
      statusText: statusText,
      outputEl: output,
      outputStr: '',
    };
    applyToolStatus(ref, typeof call.status === 'string' ? call.status : 'pending');
    if (typeof call.detail === 'string' && call.detail) {
      detailBody.textContent = call.detail; // 主进程已预提取并截断
      detail.hidden = false;
    }
    return ref;
  }

  // ---------- 消息区重置（open-session / history 防御复用） ----------
  function resetTranscript() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    msgBuf = '';
    thoughtBuf = '';
    userBuf = '';
    currentTurn = null;
    toolCards = {};
    messagesInner.textContent = '';
  }

  // ---------- 配置切换栏 ----------
  // 按 id 在最新 configOptions 中查找配置项，防御字段缺失
  function findConfigItem(id) {
    if (!configOptions) return null;
    for (var i = 0; i < configOptions.length; i++) {
      var it = configOptions[i];
      if (it && typeof it === 'object' && it.id === id) return it;
    }
    return null;
  }

  // 按最新 configOptions 重建三个下拉：option 显示名/值均来自服务端数据，
  // 一律 option.value / textContent 赋值；某项缺失或无选项则隐藏对应 select
  function buildConfigBar() {
    var visible = 0;
    for (var i = 0; i < CONFIG_IDS.length; i++) {
      var id = CONFIG_IDS[i];
      var ref = configEls[id];
      var item = findConfigItem(id);
      if (!item || !Array.isArray(item.options) || item.options.length === 0) {
        ref.item.hidden = true;
        continue;
      }
      ref.select.textContent = ''; // 清空旧 option
      for (var j = 0; j < item.options.length; j++) {
        var o = item.options[j];
        if (!o || typeof o !== 'object' || typeof o.value !== 'string' || !o.value) continue;
        var opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = typeof o.name === 'string' && o.name ? o.name : o.value;
        ref.select.appendChild(opt);
      }
      if (ref.select.options.length === 0) {
        ref.item.hidden = true;
        continue;
      }
      // 选中值 = currentValue；不在选项列表时补一个占位 option，保证回显不丢
      var cur = typeof item.currentValue === 'string' ? item.currentValue : '';
      if (cur) {
        var found = false;
        for (var k = 0; k < ref.select.options.length; k++) {
          if (ref.select.options[k].value === cur) { found = true; break; }
        }
        if (!found) {
          var curOpt = document.createElement('option');
          curOpt.value = cur;
          curOpt.textContent = cur;
          ref.select.appendChild(curOpt);
        }
      }
      ref.select.value = cur;
      ref.item.hidden = false;
      visible++;
    }
    configBarEl.hidden = visible === 0;
  }

  // configOptions 回显入口：status ready / config-options 事件 / setConfig 返回共用（幂等）
  function applyConfigOptions(list) {
    configOptions = Array.isArray(list) ? list : null;
    buildConfigBar();
    refreshConfigBar();
  }

  // 切换流程：change → 禁用全部下拉 → setConfig；成功回显，失败报错并回滚旧值
  function onConfigChange(id) {
    var ref = configEls[id];
    var value = ref.select.value;
    var item = findConfigItem(id);
    var oldValue = item && typeof item.currentValue === 'string' ? item.currentValue : '';
    if (value === oldValue) return;
    configChanging = true;
    refreshConfigBar();
    window.kimiChat.setConfig(id, value).then(function (r) {
      if (r && r.ok) {
        if (Array.isArray(r.configOptions)) {
          applyConfigOptions(r.configOptions); // config-options 事件也会到，幂等回显
        } else if (item) {
          item.currentValue = value; // 无回显数据时先更新本地缓存，避免回滚基准过期
        }
        if (id === 'mode') appendSystemNotice('权限模式已切换为 ' + value);
      } else {
        appendSystemNotice('配置切换失败：' + (r && r.error ? r.error : '未知错误'));
        ref.select.value = oldValue; // 回滚到旧值
      }
    }).catch(function (err) {
      appendSystemNotice('配置切换失败：' + String(err && err.message ? err.message : err));
      ref.select.value = oldValue;
    }).then(function () {
      configChanging = false;
      refreshConfigBar();
    });
  }

  for (var ci = 0; ci < CONFIG_IDS.length; ci++) {
    (function (id) {
      configEls[id].select.addEventListener('change', function () {
        onConfigChange(id);
      });
    })(CONFIG_IDS[ci]);
  }

  // ---------- 会话信息行（会话名 + workDir 小字） ----------
  function refreshSessionBar() {
    sessionBarEl.hidden = sessionTitleEl.hidden && workDirEl.hidden;
  }

  function setWorkDir(cwd) {
    if (typeof cwd === 'string' && cwd) {
      workDirEl.textContent = cwd;
      workDirEl.hidden = false;
    } else {
      workDirEl.hidden = true;
    }
    refreshSessionBar();
  }

  // ---------- open-session：启动器要求用本窗恢复某会话 ----------
  function onOpenSession(p) {
    var sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
    var cwd = typeof p.cwd === 'string' ? p.cwd : '';
    var title = typeof p.title === 'string' && p.title
      ? p.title
      : (sessionId ? '会话 ' + sessionId.slice(0, 8) : '会话');
    // 重置界面：清空消息区/缓冲/工具卡片映射/当前轮次
    resetTranscript();
    busy = false;
    permissionPending = false;
    cancelling = false;
    configChanging = false;
    applyConfigOptions(null); // 旧会话配置先隐藏，待 ready 回显新值
    // 标题栏会话名 + workDir 小字
    sessionTitleEl.textContent = title;
    sessionTitleEl.hidden = false;
    setWorkDir(cwd);
    document.title = '原生聊天 - ' + title;
    start({ cwd: cwd, sessionId: sessionId });
  }

  // ---------- 历史消息渲染（恢复会话时主进程从 wire.jsonl 提取） ----------
  function renderHistory(messages) {
    if (!Array.isArray(messages)) return;
    // 防御重复到达：消息区已有内容先清空再渲染
    if (messagesInner.firstChild) resetTranscript();
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (!m || typeof m !== 'object' || typeof m.text !== 'string' || !m.text) continue;
      if (m.role === 'user') {
        appendUserMessage(m.text);
      } else if (m.role === 'assistant') {
        // 历史 assistant 约简为一个纯文本消息块，不带思考区/工具卡片
        var el = document.createElement('div');
        el.className = 'msg msg-assistant';
        var textEl = document.createElement('div');
        textEl.className = 'assistant-text';
        textEl.textContent = m.text;
        el.appendChild(textEl);
        messagesInner.appendChild(el);
      }
    }
    if (messagesInner.firstChild) appendSystemNotice('—— 以上为历史消息 ——');
    stickToBottom = true;
    scrollToBottom();
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
      if (Array.isArray(p.configOptions)) applyConfigOptions(p.configOptions);
      if (typeof p.cwd === 'string' && p.cwd) setWorkDir(p.cwd);
      if (p.resumed === true) appendSystemNotice('已恢复会话上下文');
    } else if (connState === 'error') {
      busy = false;
      permissionPending = false;
      cancelling = false;
      showError(typeof p.message === 'string' && p.message ? p.message : '连接出错');
    } else if (connState === 'exited') {
      busy = false;
      permissionPending = false;
      cancelling = false;
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
      case 'open-session':
        onOpenSession(p);
        break;
      case 'config-options':
        applyConfigOptions(p.configOptions);
        break;
      case 'history':
        renderHistory(p.messages);
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
      case 'user-chunk':
        if (typeof p.text === 'string' && p.text) {
          userBuf += p.text;
          scheduleFlush();
        }
        break;
      case 'commands':
        console.debug('[acp-chat] 可用命令数:', p.count);
        commandsInfoEl.textContent = '命令 ' + (typeof p.count === 'number' ? p.count : 0);
        commandsInfoEl.hidden = false;
        break;
      case 'tool-call': {
        var call = p.call && typeof p.call === 'object' ? p.call : null;
        if (!call || typeof call.toolCallId !== 'string' || !call.toolCallId) break;
        flushBuffers(); // 在途流式文本先落 DOM，保持「文本在前、卡片在后」
        var turn = ensureTurn();
        var ref = createToolCard(call);
        toolCards[call.toolCallId] = ref;
        turn.wrap.appendChild(ref.el);
        // 卡片之后的正文另起新段，维持流式文本与卡片的相对顺序
        var textEl = document.createElement('div');
        textEl.className = 'assistant-text';
        turn.wrap.appendChild(textEl);
        turn.textEl = textEl;
        turn.textStr = '';
        maybeScrollToBottom();
        break;
      }
      case 'tool-call-update': {
        var updRef = typeof p.toolCallId === 'string' ? toolCards[p.toolCallId] : null;
        if (!updRef) break; // 无对应卡片（事件乱序/缺失），直接忽略
        if (typeof p.status === 'string' && p.status) applyToolStatus(updRef, p.status);
        if (typeof p.output === 'string' && p.output) {
          // 输出摘要追加进输出区：单片与总量均封顶 2000 字符
          updRef.outputStr += p.output.slice(0, 2000);
          if (updRef.outputStr.length > 2000) updRef.outputStr = updRef.outputStr.slice(0, 2000);
          updRef.outputEl.textContent = updRef.outputStr;
          updRef.outputEl.hidden = false;
        }
        maybeScrollToBottom();
        break;
      }
      case 'permission-pending':
        permissionPending = true; // 视为 busy 态，输入框保持禁用
        refreshUi();
        break;
      case 'permission-resolved':
        permissionPending = false;
        refreshUi();
        if (p.cancelled === true) appendSystemNotice('权限请求已取消');
        break;
      case 'prompt-done':
        flushBuffers();
        busy = false;
        permissionPending = false;
        cancelling = false; // 取消完成，发送按钮恢复
        refreshUi();
        break;
    }
  }

  // ---------- 发送 / 停止 ----------
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

  // 取消在途 prompt：按钮临时禁用并显示「停止中…」，直到 prompt-done 恢复
  function cancelPrompt() {
    if (cancelling) return;
    cancelling = true;
    refreshUi();
    window.kimiChat.cancel().then(function (r) {
      if (!r || !r.ok) {
        // 取消失败不会有 prompt-done，立即恢复按钮避免卡死
        cancelling = false;
        refreshUi();
      }
    }).catch(function () {
      cancelling = false;
      refreshUi();
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
  // 同一按钮双态：busy（含待审批）时点击为停止，否则为发送
  sendBtn.addEventListener('click', function () {
    if (busy || permissionPending) {
      cancelPrompt();
    } else {
      send();
    }
  });
  retryBtn.addEventListener('click', function () {
    start(lastStartOpts);
  });

  // ---------- 启动会话 ----------
  function start(opts) {
    lastStartOpts = opts;
    connState = 'connecting';
    busy = false;
    hideError();
    refreshUi();
    window.kimiChat.start(opts).then(function (r) {
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

  document.title = '原生聊天 - 新会话';
  window.kimiChat.onEvent(onEvent);
  autoGrow();
  refreshUi();
  start();
})();
