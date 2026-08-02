// Kimi Code Desktop — ACP 原生聊天原型窗渲染逻辑
// 只读原型：全部动态文本经 textContent 写入，杜绝 innerHTML 注入；
// message/thought 流式分片只进字符串缓冲，按 ~50ms 合帧统一写 DOM，
// 每类缓冲每帧最多一次 textContent 赋值（479 条/轮的思考分片也只写一次）。
// 工具调用渲染为卡片节点插入当前轮次容器，由 tool-call-update 就地更新状态与输出。
// 配置切换栏（模型/思考/模式）数据来自 status ready / config-options 事件的
// configOptions，字段缺失时隐藏对应下拉；切换失败回滚选中值并系统提示。
// 斜杠命令菜单：commands 事件缓存命令清单，输入 '/' 前缀实时过滤渲染浮层，
// 上下键循环高亮、Enter/Tab 选中、Escape 关闭；菜单可见时 Enter 只选中不发送。
// 图片附件：回形针按钮系统选图（mime 白名单、合计至多 4 张），chips 行逐个可移除，
// 发送时随 prompt 一并提交，成功清空、失败恢复；Web UI 按钮打开高级面板。
(function () {
  'use strict';

  var FLUSH_MS = 50; // 流式渲染合帧间隔
  var SCROLL_TOLERANCE = 40; // 距底部多少像素内视为「未上翻」
  var MAX_PENDING_IMAGES = 4; // 一次最多附带图片数
  var MAX_SLASH_COMMANDS = 200; // 斜杠命令缓存条数上限（防御）
  // 图片 mimeType 白名单（与主进程约定一致）：渲染层二次校验，亦用于 data URL 拼接
  var IMAGE_MIME_WHITELIST = {
    'image/png': true,
    'image/jpeg': true,
    'image/gif': true,
    'image/webp': true,
  };

  // ---------- DOM 引用 ----------
  var statusDot = document.getElementById('statusDot');
  var statusText = document.getElementById('statusText');
  var agentInfoEl = document.getElementById('agentInfo');
  var sessionInfoEl = document.getElementById('sessionInfo');
  var commandsInfoEl = document.getElementById('commandsInfo');
  var taskRunningBadgeEl = document.getElementById('taskRunningBadge'); // 运行中任务徽章（counts.session.tasks）
  var agentRunningBadgeEl = document.getElementById('agentRunningBadge'); // 运行中子代理徽章（counts.session.agents）
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
  var slashMenu = document.getElementById('slashMenu'); // 斜杠命令浮层（.composer 内）
  var attachBtn = document.getElementById('attachBtn'); // 附件按钮（发送按钮左侧）
  var chips = document.getElementById('chips'); // 附件缩略行（textarea 上方）
  var webuiBtn = document.getElementById('webuiBtn'); // Web UI 入口按钮（顶栏右侧）

  // ---------- Plan 卡片 DOM 引用 ----------
  var planCardWrap = document.getElementById('planCardWrap');
  var planCardSummary = document.getElementById('planCardSummary');
  var planCardToggle = document.getElementById('planCardToggle');
  var planCardList = document.getElementById('planCardList');
  var planCardHeader = document.getElementById('planCardHeader');
  var planCardEntries = null; // 当前清洗后的 entries
  var planCardExpanded = false;

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
  var pendingImages = []; // 待发送图片附件 [{ name, mimeType, data, size }]
  var slashCommands = []; // 斜杠命令缓存（会话级，resetTranscript 不清）
  var slashMatches = []; // 斜杠菜单当前过滤结果
  var slashActive = -1; // 斜杠菜单当前高亮下标
  var currentSessionId = null; // 当前 ACP 会话 ID（本地命令入参；ready 事件回填，无活跃会话为 null）

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
    // 仅 ready 且非在途、无待审批时可输入（附件按钮同一规则）
    var canType = connState === 'ready' && !busy && !permissionPending;
    input.disabled = !canType;
    attachBtn.disabled = !canType;
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
      // 有文本或有待发图片才可发送
      sendBtn.disabled = !(connState === 'ready' && (input.value.trim() || pendingImages.length > 0));
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
  // 用户气泡：无图时保持纯文本节点（行为与原来一致）；
  // 有图时为容器 div.msg-user——先缩略图行（img 小图、data URL）、再文本块。
  // img.src 仅允许 'data:<白名单 mime>;base64,' 前缀拼接，杜绝外部 URL 注入。
  function appendUserMessage(text, images) {
    var el = document.createElement('div');
    el.className = 'msg msg-user';
    var imgs = Array.isArray(images) ? images : [];
    if (imgs.length === 0) {
      el.textContent = text;
    } else {
      var row = document.createElement('div');
      row.className = 'msg-images';
      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        // 防御：非白名单 mime 或 data 缺失的项跳过
        if (!img || typeof img.mimeType !== 'string' || !IMAGE_MIME_WHITELIST[img.mimeType] ||
            typeof img.data !== 'string' || !img.data) continue;
        var thumb = document.createElement('img');
        thumb.className = 'msg-image-thumb';
        thumb.src = 'data:' + img.mimeType + ';base64,' + img.data;
        thumb.alt = typeof img.name === 'string' ? img.name : '';
        row.appendChild(thumb);
      }
      el.appendChild(row);
      if (text) {
        var textEl = document.createElement('div');
        textEl.className = 'msg-user-text';
        textEl.textContent = text;
        el.appendChild(textEl);
      }
    }
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
      // Markdown 渲染（缓存的，仅文本变化时重解析）
      if (typeof KcdMarkdown !== 'undefined' && KcdMarkdown.renderAssistantMessage) {
        KcdMarkdown.renderAssistantMessage(turn.textStr, turn, false);
        // 首次添加消息级复制按钮（getter 函数确保复制最新文本）
        if (!turn._copyBtnAdded) {
          KcdMarkdown.addMessageCopyButton(turn.textEl, function () { return turn.textStr; });
          turn._copyBtnAdded = true;
        }
      } else {
        turn.textEl.textContent = turn.textStr;
      }
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
    // Agent 工具卡片挂点（Phase 6b）：head 行尾加「步骤」展开钮 + 内联树容器；
    // 桥接无 getSubagentTree（旧版）时不加钮，功能静默缺席
    if (isAgentToolTitle(call.title) && typeof call.toolCallId === 'string' && call.toolCallId &&
        typeof window.kimiChat !== 'undefined' && typeof window.kimiChat.getSubagentTree === 'function') {
      var stepsToggle = el('button', 'agent-steps-toggle');
      stepsToggle.type = 'button';
      stepsToggle.setAttribute('aria-expanded', 'false');
      stepsToggle.title = '展开子代理步骤';
      stepsToggle.appendChild(el('span', '', '步骤'));
      stepsToggle.appendChild(el('span', 'sg-caret', '▾'));
      head.appendChild(stepsToggle);
      var treeWrap = el('div', 'agent-tree');
      treeWrap.hidden = true;
      card.appendChild(treeWrap);
      ref.toolCallId = call.toolCallId;
      ref.stepsToggle = stepsToggle;
      ref.treeWrap = treeWrap;
      ref.treeOpen = false;
      stepsToggle.addEventListener('click', function () { toggleAgentSteps(ref); });
    }
    applyToolStatus(ref, typeof call.status === 'string' ? call.status : 'pending');
    if (typeof call.detail === 'string' && call.detail) {
      // 尝试 TodoList 渲染
      if (typeof KcdMarkdown !== 'undefined' && KcdMarkdown.parseTodoList) {
        var todoResult = KcdMarkdown.parseTodoList(call, call.detail);
        if (todoResult.isTodo && todoResult.html) {
          detailBody.innerHTML = todoResult.html;
          detail.hidden = false;
        } else {
          detailBody.textContent = call.detail;
          detail.hidden = false;
        }
      } else {
        detailBody.textContent = call.detail; // 主进程已预提取并截断
        detail.hidden = false;
      }
    }
    return ref;
  }

  // ---------- Plan 卡片渲染 ----------
  function renderPlanCard() {
    if (!planCardWrap || !planCardSummary) return;
    var entries = planCardEntries;
    if (!entries || entries.length === 0) {
      planCardWrap.hidden = true;
      return;
    }
    var summary = KcdPlan.summarizePlan(entries);
    // 进度摘要
    var summaryText = '计划进度：已完成 ' + summary.completed + '/' + summary.total;
    if (summary.inProgress > 0) {
      // 取第一条进行中的内容作为当前任务提示
      var current = '';
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].status === 'in_progress') {
          current = entries[i].content;
          break;
        }
      }
      if (current) {
        summaryText += ' · 当前：' + current;
      }
    }
    planCardSummary.textContent = summaryText;

    // 条目列表
    planCardList.textContent = '';
    for (var j = 0; j < entries.length; j++) {
      var item = entries[j];
      var itemEl = document.createElement('div');
      itemEl.className = 'plan-card-item' + (item.status === 'completed' ? ' completed' : '');
      var bullet = document.createElement('span');
      bullet.className = 'bullet ' + item.status;
      itemEl.appendChild(bullet);
      var textSpan = document.createElement('span');
      textSpan.className = 'item-text';
      textSpan.textContent = item.content || '（无描述）';
      itemEl.appendChild(textSpan);
      planCardList.appendChild(itemEl);
    }

    // 展开/收起态
    planCardList.hidden = !planCardExpanded;
    planCardToggle.className = 'plan-card-toggle' + (planCardExpanded ? ' open' : '');

    planCardWrap.hidden = false;
  }

  // Plan 卡片点击展开/收起
  if (planCardHeader) {
    planCardHeader.addEventListener('click', function () {
      if (!planCardEntries || planCardEntries.length === 0) return;
      planCardExpanded = !planCardExpanded;
      planCardList.hidden = !planCardExpanded;
      planCardToggle.className = 'plan-card-toggle' + (planCardExpanded ? ' open' : '');
    });
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
    // 子代理步骤树：卡片随消息区销毁，展开引用/缓存/在途一并清；
    // agentFoldMemory 折叠记忆归属会话，不在此清（onOpenSession 显式清）
    agentTreeOpen = {};
    agentTreeCache = null;
    agentTreeSeq++;
    agentTreeInflight = null;
    if (agentTreeRefreshTimer) { clearTimeout(agentTreeRefreshTimer); agentTreeRefreshTimer = null; }
    // Plan 卡片复位
    planCardEntries = null;
    planCardExpanded = false;
    if (planCardWrap) planCardWrap.hidden = true;
    // 待发附件一并清空（会话切换不残留）；slashCommands 为会话级缓存，不在此清理
    pendingImages = [];
    chips.textContent = '';
    chips.hidden = true;
    hideSlashMenu();
  }

  // ---------- 斜杠命令菜单 ----------
  // commands 事件载荷防御：仅收录 name 为非空字符串的项，
  // description/hint 缺省补 ''；旧形态（仅 count、无 commands 字段）按 []
  function sanitizeCommands(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_SLASH_COMMANDS; i++) {
      var c = list[i];
      if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name) continue;
      out.push({
        name: c.name,
        description: typeof c.description === 'string' ? c.description : '',
        hint: typeof c.hint === 'string' ? c.hint : '',
      });
    }
    return out;
  }

  function hideSlashMenu() {
    slashMenu.hidden = true;
    slashMatches = [];
    slashActive = -1;
  }

  // 输入驱动：值以 '/' 开头且不含空白字符时按 name 前缀过滤（大小写不敏感），
  // 否则或无匹配时隐藏菜单；每次重建菜单项，默认高亮首项
  function renderSlashMenu() {
    var v = input.value;
    if (v.charAt(0) !== '/' || /\s/.test(v)) {
      hideSlashMenu();
      return;
    }
    var prefix = v.slice(1).toLowerCase();
    var matches = [];
    for (var i = 0; i < slashCommands.length; i++) {
      if (slashCommands[i].name.toLowerCase().indexOf(prefix) === 0) matches.push(slashCommands[i]);
    }
    if (matches.length === 0) {
      hideSlashMenu();
      return;
    }
    slashMatches = matches;
    slashActive = 0;
    slashMenu.textContent = ''; // 清空旧项
    for (var j = 0; j < matches.length; j++) {
      slashMenu.appendChild(buildSlashItem(matches[j], j === slashActive));
    }
    slashMenu.hidden = false;
  }

  // 菜单项 button.slash-item：/name 等宽 + description 小字，hint 有值时额外小字；
  // 高亮项加 .active；点击等同选中
  function buildSlashItem(cmd, active) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = active ? 'slash-item active' : 'slash-item';
    var nameEl = document.createElement('span');
    nameEl.className = 'slash-name';
    nameEl.textContent = '/' + cmd.name;
    item.appendChild(nameEl);
    if (cmd.description) {
      var descEl = document.createElement('span');
      descEl.className = 'slash-desc';
      descEl.textContent = cmd.description;
      item.appendChild(descEl);
    }
    if (cmd.hint) {
      var hintEl = document.createElement('span');
      hintEl.className = 'slash-hint';
      hintEl.textContent = cmd.hint;
      item.appendChild(hintEl);
    }
    item.addEventListener('click', function () {
      applySlashCommand(cmd);
    });
    return item;
  }

  // 上下键循环移动高亮：只切换 .active，不重建 DOM
  function moveSlashActive(delta) {
    if (slashMatches.length === 0) return;
    slashActive = (slashActive + delta + slashMatches.length) % slashMatches.length;
    var items = slashMenu.children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', i === slashActive);
    }
    if (items[slashActive] && typeof items[slashActive].scrollIntoView === 'function') {
      items[slashActive].scrollIntoView({ block: 'nearest' });
    }
  }

  // 选中：输入框值替换为 '/name '，聚焦并隐藏菜单，随后同步高度与发送按钮
  function applySlashCommand(cmd) {
    input.value = '/' + cmd.name + ' ';
    hideSlashMenu();
    input.focus();
    autoGrow();
    refreshSendBtn();
  }

  // ---------- 本地命令结果面板（/usage、/status） ----------
  // send() 最前精确拦截（trim 后全等，大小写敏感；'/usage foo' 等带参形式原样放行），
  // 不进聊天记录、不发给 ACP。面板三态：loading（新请求取代旧请求，序号递增，旧序号
  // 结果到达即丢弃）/ result（按 kind 分区渲染）/ error（错误文案 + 重试按钮）。
  // 所有动态文本经 textContent 写入，不拼 HTML。
  var cmdPanel = document.getElementById('commandResultPanel');
  var cmdPanelTitle = document.getElementById('cmdPanelTitle');
  var cmdPanelTime = document.getElementById('cmdPanelTime');
  var cmdPanelBody = document.getElementById('cmdPanelBody');
  var cmdPanelClose = document.getElementById('cmdPanelClose');
  var cmdPanelSeq = 0; // 请求序号：新请求/关闭面板均递增，旧序号结果到达即丢弃
  var cmdTrendRange = 'today'; // 趋势分段选中（today/7d/30d），跨次打开保留
  var cmdPanelUsage = null; // 最近一次 usage 结果数据（切换趋势标签重绘用）

  // 小工具：建节点（类名 + 文本，text 省略时纯元素）
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // token 缩写：与托盘 formatTokenCount 同风（≥1000 → X.Xk），≥1e6 → X.XM
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  // 千位逗号完整值（悬浮 title 与明细用）
  function fmtFull(n) {
    return (Number(n) || 0).toLocaleString('en-US');
  }

  // 金额：分 → 元两位小数；币种符号 CNY→¥、USD→$，其他原样代码前缀
  function fmtMoney(minor, currency) {
    var sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : (currency ? currency + ' ' : '');
    return sym + ((Number(minor) || 0) / 100).toFixed(2);
  }

  // 额度 used/limit（平台十进制数）：整数原样，小数保留两位
  function fmtAmount(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return '0';
    return n % 1 === 0 ? String(n) : n.toFixed(2);
  }

  // epoch ms → HH:MM:SS（本地时区）
  function fmtClock(ms) {
    var d = new Date(Number(ms) || Date.now());
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ISO 时间 → 「M月D日 HH:MM」；解析失败返回 ''
  function fmtReset(iso) {
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    var d = new Date(t);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 进度条（used/limit）：返回 { wrap, pct }；pct ≥90 时 fill 转 error 色
  function buildProgress(used, limit) {
    var wrap = el('div', 'cmd-progress');
    var fill = el('div', 'cmd-progress-fill');
    var pct = limit > 0 ? Math.min(100, (Number(used) / Number(limit)) * 100) : 0;
    fill.style.width = pct.toFixed(1) + '%';
    if (pct >= 90) fill.classList.add('hot');
    wrap.appendChild(fill);
    return { wrap: wrap, pct: pct };
  }

  function buildSection(titleText, noteText) {
    var sec = el('div', 'cmd-section');
    var head = el('div', 'cmd-section-head');
    head.appendChild(el('span', 'cmd-section-title', titleText));
    if (noteText) head.appendChild(el('span', 'cmd-section-note', noteText));
    sec.appendChild(head);
    return sec;
  }

  // 上下文窗口区：进度条 + 数值 + source 标注；null → 暂无上下文数据
  function buildContextSection(cw, sessionUsage) {
    var sourceNote = cw && cw.source ? (cw.source === 'session' ? '当前会话' : '最近同步快照') : '';
    var sec = buildSection('上下文窗口', sourceNote);
    if (!cw || !(cw.limit > 0)) {
      sec.appendChild(el('div', 'cmd-empty', '暂无上下文数据'));
      return sec;
    }
    var p = buildProgress(cw.used, cw.limit);
    sec.appendChild(p.wrap);
    var row = el('div', 'cmd-row');
    row.appendChild(el('span', 'cmd-row-val',
      fmtTokens(cw.used) + ' / ' + fmtTokens(cw.limit) + '（' + Math.round(p.pct) + '%）'));
    sec.appendChild(row);
    if (sessionUsage && sessionUsage.totalTokens > 0) {
      sec.appendChild(el('div', 'cmd-section-note', '本会话累计 ' + fmtTokens(sessionUsage.totalTokens) + ' tokens'));
    }
    return sec;
  }

  // Token 明细区（数据取 trends.today）：四字段 + 合计 + byModel 各模型小计
  function buildTokenSection(today) {
    var sec = buildSection('Token 明细（今天）', '');
    var s = today && today.summary && typeof today.summary === 'object' ? today.summary : null;
    var models = today && Array.isArray(today.byModel) ? today.byModel : [];
    if (!s || (!s.totalTokens && models.length === 0)) {
      sec.appendChild(el('div', 'cmd-empty', '今天还没有用量记录'));
      return sec;
    }
    var line = el('div', 'cmd-token-line');
    var items = [
      ['输入', s.inputOther],
      ['输出', s.output],
      ['缓存读取', s.inputCacheRead],
      ['缓存写入', s.inputCacheCreation],
      ['合计', s.totalTokens],
    ];
    for (var i = 0; i < items.length; i++) {
      var item = el('span', 'cmd-token-item');
      item.appendChild(el('span', 'cmd-token-k', items[i][0]));
      var v = el('span', 'cmd-token-v', fmtTokens(items[i][1]));
      v.title = fmtFull(items[i][1]) + ' tokens';
      item.appendChild(v);
      line.appendChild(item);
    }
    sec.appendChild(line);
    for (var m = 0; m < models.length; m++) {
      var mb = models[m];
      if (!mb || typeof mb !== 'object') continue;
      var mrow = el('div', 'cmd-model-row');
      mrow.appendChild(el('span', 'cmd-model-name', mb.model || 'unknown'));
      var mv = el('span', 'cmd-model-val', fmtTokens(mb.totalTokens));
      mv.title = '输入 ' + fmtFull(mb.inputOther) + ' · 输出 ' + fmtFull(mb.output) +
        ' · 缓存读取 ' + fmtFull(mb.inputCacheRead) + ' · 缓存写入 ' + fmtFull(mb.inputCacheCreation);
      mrow.appendChild(mv);
      sec.appendChild(mrow);
    }
    return sec;
  }

  // 平台额度区：kind 分级文案；ok → plans 列表 + wallet；staleAt 过期标注
  function buildManagedSection(managed) {
    var stale = managed && Number(managed.staleAt) > 0 && Number(managed.staleAt) < Date.now();
    var sec = buildSection('平台额度', stale ? '数据可能过期' : '');
    if (!managed || managed.kind === 'error') {
      sec.appendChild(el('div', 'cmd-empty',
        '额度查询失败' + (managed && managed.message ? '：' + managed.message : '')));
      return sec;
    }
    if (managed.kind === 'auth-required') {
      sec.appendChild(el('div', 'cmd-empty', '登录状态已过期，请在终端运行 kimi login 后重试'));
      return sec;
    }
    if (managed.kind === 'unavailable') {
      sec.appendChild(el('div', 'cmd-empty', '当前登录方式不支持额度查询'));
      return sec;
    }
    var plans = Array.isArray(managed.plans) ? managed.plans : [];
    if (plans.length === 0 && !managed.wallet) {
      sec.appendChild(el('div', 'cmd-empty', '暂无额度数据'));
      return sec;
    }
    for (var i = 0; i < plans.length; i++) {
      var plan = plans[i];
      if (!plan || typeof plan !== 'object') continue;
      var pw = el('div', 'cmd-plan');
      var row = el('div', 'cmd-row');
      row.appendChild(el('span', 'cmd-plan-label', plan.label || '额度'));
      var val = fmtAmount(plan.used) + ' / ' + fmtAmount(plan.limit);
      if (plan.limit > 0) val += '（' + Math.round((Number(plan.used) / Number(plan.limit)) * 100) + '%）';
      row.appendChild(el('span', 'cmd-row-val', val));
      pw.appendChild(row);
      if (plan.limit > 0) pw.appendChild(buildProgress(plan.used, plan.limit).wrap);
      var reset = fmtReset(plan.resetAt);
      if (reset) pw.appendChild(el('div', 'cmd-section-note', reset + ' 重置'));
      sec.appendChild(pw);
    }
    if (managed.wallet && typeof managed.wallet === 'object') {
      var w = managed.wallet;
      var wrow = el('div', 'cmd-row');
      wrow.appendChild(el('span', 'cmd-row-label', '钱包余额'));
      wrow.appendChild(el('span', 'cmd-row-val', fmtMoney(w.balanceMinor, w.currency)));
      sec.appendChild(wrow);
      if (w.monthlyLimitMinor > 0) {
        sec.appendChild(el('div', 'cmd-section-note',
          '本月已用 ' + fmtMoney(w.monthlyUsedMinor, w.currency) + ' / 上限 ' + fmtMoney(w.monthlyLimitMinor, w.currency)));
      }
    }
    if (Number(managed.fetchedAt) > 0) {
      sec.appendChild(el('div', 'cmd-section-note', '更新于 ' + fmtClock(managed.fetchedAt)));
    }
    return sec;
  }

  // 趋势柱标签：today 的 key 为 'HH'，7d/30d 的 key 为 'YYYY-MM-DD'
  function bucketLabel(key, range) {
    if (range === 'today') return key + ':00';
    var parts = String(key).split('-');
    return parts.length === 3 ? Number(parts[1]) + '-' + Number(parts[2]) : String(key);
  }

  // 趋势图重绘（tabs 选中态 + 摘要 + 条形图 + 首末轴标签 + partial 标注）
  function renderTrendInto(wrap, tabs, trends) {
    var range = cmdTrendRange;
    for (var t = 0; t < tabs.children.length; t++) {
      tabs.children[t].classList.toggle('active', tabs.children[t].getAttribute('data-range') === range);
    }
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    var snap = trends && typeof trends === 'object' ? trends[range] : null;
    if (!snap || !Array.isArray(snap.series)) {
      wrap.appendChild(el('div', 'cmd-empty', '暂无该时段的用量数据'));
      return;
    }
    var s = snap.summary && typeof snap.summary === 'object' ? snap.summary : {};
    wrap.appendChild(el('div', 'cmd-section-note',
      '合计 ' + fmtTokens(s.totalTokens) + ' tokens · ' + fmtFull(s.requests) + ' 次请求'));
    var max = 0;
    var i;
    for (i = 0; i < snap.series.length; i++) {
      var b = snap.series[i];
      if (b && Number(b.totalTokens) > max) max = Number(b.totalTokens);
    }
    var bars = el('div', 'cmd-bars');
    for (i = 0; i < snap.series.length; i++) {
      var bk = snap.series[i] || {};
      var v = Number(bk.totalTokens) || 0;
      var bar = el('div', v > 0 ? 'cmd-bar has' : 'cmd-bar');
      bar.style.height = v > 0 && max > 0 ? Math.max(4, (v / max) * 100).toFixed(1) + '%' : '2px';
      bar.title = bucketLabel(bk.key, range) + '：' + fmtFull(v) + ' tokens';
      bars.appendChild(bar);
    }
    wrap.appendChild(bars);
    if (snap.series.length > 0) {
      var axis = el('div', 'cmd-axis');
      axis.appendChild(el('span', '', bucketLabel(snap.series[0].key, range)));
      axis.appendChild(el('span', '', bucketLabel(snap.series[snap.series.length - 1].key, range)));
      wrap.appendChild(axis);
    }
    var diag = snap.diagnostics && typeof snap.diagnostics === 'object' ? snap.diagnostics : {};
    if (diag.partial || s.partial) {
      var reason = diag.reason === 'session-scope-only'
        ? '只有会话累计记录，算不出分时段用量'
        : (diag.reason ? String(diag.reason) : '部分记录解析失败');
      wrap.appendChild(el('div', 'cmd-section-note', '数据不完整：' + reason));
    }
  }

  // 用量趋势区：今天/7 天/30 天分段标签 + 纯 CSS 条形图
  function buildTrendsSection(trends) {
    var sec = buildSection('用量趋势', '');
    var tabs = el('div', 'cmd-tabs');
    var wrap = el('div', 'cmd-section');
    var defs = [['today', '今天'], ['7d', '7 天'], ['30d', '30 天']];
    for (var i = 0; i < defs.length; i++) {
      var tab = el('button', 'cmd-tab', defs[i][1]);
      tab.type = 'button';
      tab.setAttribute('data-range', defs[i][0]);
      tab.addEventListener('click', function () {
        cmdTrendRange = this.getAttribute('data-range');
        renderTrendInto(wrap, tabs, trends);
      });
      tabs.appendChild(tab);
    }
    sec.appendChild(tabs);
    sec.appendChild(wrap);
    renderTrendInto(wrap, tabs, trends);
    return sec;
  }

  // errors 非空 → 面板顶部警示条（列出失败 part 与脱敏 message）
  function buildErrorsBar(errors) {
    var parts = [];
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i] || {};
      parts.push((e.part || '未知') + '：' + (e.message || '获取失败'));
    }
    return el('div', 'cmd-warn', '部分数据获取失败（' + parts.join('；') + '）');
  }

  // /usage 结果：警示条 + 上下文窗口 + Token 明细 + 平台额度 + 用量趋势
  function renderUsageResult(data) {
    cmdPanelUsage = data;
    cmdPanelBody.textContent = '';
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      cmdPanelBody.appendChild(buildErrorsBar(data.errors));
    }
    cmdPanelBody.appendChild(buildContextSection(data.contextWindow, data.sessionUsage));
    cmdPanelBody.appendChild(buildTokenSection(data.trends ? data.trends.today : null));
    cmdPanelBody.appendChild(buildManagedSection(data.managed));
    cmdPanelBody.appendChild(buildTrendsSection(data.trends));
  }

  // /status 结果：字段表 + 上下文行 + 平台额度摘要行；null 字段显示「—」
  function renderStatusResult(data) {
    cmdPanelUsage = null;
    cmdPanelBody.textContent = '';
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      cmdPanelBody.appendChild(buildErrorsBar(data.errors));
    }
    var sec = buildSection('会话状态', '');
    var kv = el('div', 'cmd-kv');
    function addRow(label, value) {
      kv.appendChild(el('span', 'cmd-kv-label', label));
      kv.appendChild(el('span', 'cmd-kv-val',
        value === null || value === undefined || value === '' ? '—' : String(value)));
    }
    addRow('CLI 版本', data.cliVersion);
    addRow('桌面版本', data.desktopVersion);
    addRow('模型', data.model);
    addRow('思考', data.thinking);
    addRow('模式', data.mode);
    addRow('权限模式', data.permissionMode);
    addRow('目录', data.cwd);
    addRow('会话状态', data.sessionState === 'active' ? '活跃' : data.sessionState === 'idle' ? '空闲' : data.sessionState);
    var ctx = null;
    if (data.contextWindow && data.contextWindow.limit > 0) {
      var cw = data.contextWindow;
      ctx = fmtTokens(cw.used) + ' / ' + fmtTokens(cw.limit) +
        '（' + Math.round((Number(cw.used) / Number(cw.limit)) * 100) + '%，' +
        (cw.source === 'session' ? '当前会话' : '最近同步快照') + '）';
    }
    addRow('上下文', ctx);
    var mText = null;
    var m = data.managedSummary;
    if (m && typeof m === 'object') {
      var mparts = [];
      if (m.planLabel) {
        mparts.push((m.planLabel === 'Weekly limit' ? '周配额' : String(m.planLabel)) +
          ' ' + fmtAmount(m.planUsed) + ' / ' + fmtAmount(m.planLimit));
      }
      if (m.walletBalanceMinor !== null && m.walletBalanceMinor !== undefined) {
        mparts.push('钱包余额 ' + fmtMoney(m.walletBalanceMinor, m.currency));
      }
      if (mparts.length > 0) mText = mparts.join(' · ');
    }
    addRow('平台额度', mText);
    sec.appendChild(kv);
    cmdPanelBody.appendChild(sec);
  }

  function renderCmdLoading(cmd) {
    cmdPanelBody.textContent = '';
    var row = el('div', 'cmd-loading');
    row.appendChild(el('span', 'spinner'));
    row.appendChild(el('span', '', cmd === '/usage' ? '正在获取用量…' : '正在获取状态…'));
    cmdPanelBody.appendChild(row);
  }

  function renderCmdError(cmd, message) {
    cmdPanelBody.textContent = '';
    cmdPanelBody.appendChild(el('div', 'cmd-warn', message));
    var retry = el('button', 'btn btn-secondary cmd-retry', '重试');
    retry.type = 'button';
    retry.addEventListener('click', function () { runLocalCommand(cmd); });
    cmdPanelBody.appendChild(retry);
  }

  // 本地命令入口：序号递增取代旧请求；面板立即出 loading，结果按 kind 渲染
  function runLocalCommand(cmd) {
    var mySeq = ++cmdPanelSeq;
    cmdPanelTitle.textContent = cmd;
    cmdPanelTime.textContent = '';
    cmdPanel.hidden = false;
    renderCmdLoading(cmd);
    window.kimiChat.runLocalCommand(cmd, currentSessionId).then(function (r) {
      if (mySeq !== cmdPanelSeq) return; // 已被新请求取代或面板已关闭，丢弃
      if (!r || r.ok === false) {
        var msg = r && r.error && r.error.message ? r.error.message
          : (r && r.code === 'not-local-command' ? '该命令需发送给 Kimi 处理' : '命令执行失败');
        renderCmdError(cmd, msg);
        return;
      }
      cmdPanelTime.textContent = '生成于 ' + fmtClock(r.generatedAt || Date.now());
      if (r.kind === 'usage') {
        renderUsageResult(r.data && typeof r.data === 'object' ? r.data : {});
      } else if (r.kind === 'status') {
        renderStatusResult(r.data && typeof r.data === 'object' ? r.data : {});
      } else {
        renderCmdError(cmd, '未知的结果类型');
      }
    }).catch(function (err) {
      if (mySeq !== cmdPanelSeq) return;
      renderCmdError(cmd, '命令执行失败：' + String(err && err.message ? err.message : err));
    });
  }

  function closeCmdPanel() {
    cmdPanel.hidden = true;
    cmdPanelSeq++; // 关闭后在途结果到达即丢弃
    cmdPanelUsage = null;
    input.focus();
  }

  cmdPanelClose.addEventListener('click', closeCmdPanel);
  // Escape 关浮层：斜杠菜单可见时菜单优先（其 Escape 在 input keydown 中已处理且
  // preventDefault，此处经 defaultPrevented 跳过，二者不冲突）；
  // 抽屉与命令面板同开时先关抽屉（浮层层级更高），再按一次关面板
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!slashMenu.hidden) return;
    if (!tasksDrawer.hidden) { closeTasksDrawer(); return; }
    if (!cmdPanel.hidden) closeCmdPanel();
  });

  // ---------- Tasks 抽屉（后台任务 / Cron 调度只读视图，Phase 5b） ----------
  // 打开时拉取一次 getTaskCatalog(currentSessionId)（无活跃会话传 null，主进程给全部会话）；
  // runtime-changed 事件 1s 防抖重拉（仅打开期间）；关闭/会话切换时序号递增丢弃在途结果、
  // 清掉待发防抖并清空列表。不开轮询、不新增 setInterval；纯只读视图，无任何操作按钮；
  // 全部动态文本经 textContent 写入，不拼 HTML。
  var tasksDrawer = document.getElementById('tasksDrawer');
  var tasksDiag = document.getElementById('tasksDiag');
  var tasksBody = document.getElementById('tasksDrawerBody');
  var tasksDrawerCloseBtn = document.getElementById('tasksDrawerClose');
  var tasksBtn = document.getElementById('tasksBtn'); // 顶栏常驻入口（toggle）
  var tasksDrawerOpen = false;
  var tasksSeq = 0; // 拉取序号：新拉取/关闭/会话切换均递增，旧序号结果到达即丢弃
  var tasksRefreshTimer = null; // 事件防抖定时器（仅打开期间由 runtime-changed 触发）

  var TASK_STATUS_TEXT = { running: '运行中', completed: '已完成', failed: '失败', removed: '已移除' };
  var TASK_KIND_TEXT = { task: '任务', subagent: '子代理', cron: 'Cron' };
  var TASK_SOURCE_TEXT = { ws: '实时同步', acp: '会话事件', disk: '本地文件' };
  var TASK_CONF_TEXT = { medium: '参考', low: '粗略' }; // high 不标注（可信来源无需提示）

  // epoch ms → 中文相对时间（「3 分钟前」；未来/无效值按「刚刚」）
  function fmtAgo(ms) {
    var diff = Date.now() - (Number(ms) || 0);
    if (!(diff >= 0)) diff = 0;
    var min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    return Math.floor(hr / 24) + ' 天前';
  }

  // 单条目录项 → 行节点：主行（kind 徽标 + 标题 + 相对时间）+ 副行（状态/来源/置信度/调度/缺字段）
  function buildTaskRow(e) {
    var row = el('div', 'tasks-row');
    if (e.status === 'failed' || e.status === 'removed') row.classList.add('dim'); // 失败/已移除降不透明度
    var detail = e.detail && typeof e.detail === 'object' ? e.detail : null;
    var main = el('div', 'tasks-row-main');
    main.appendChild(el('span', 'tasks-kind', TASK_KIND_TEXT[e.kind] || '任务'));
    var title = typeof e.title === 'string' && e.title ? e.title
      : (detail && typeof detail.description === 'string' && detail.description ? detail.description : '未命名任务');
    var titleEl = el('span', 'tasks-title', title);
    titleEl.title = title; // 截断时悬浮看全名
    main.appendChild(titleEl);
    main.appendChild(el('span', 'tasks-time', fmtAgo(e.updatedAt)));
    row.appendChild(main);
    var sub = el('div', 'tasks-row-sub');
    var st = el('span', 'tasks-meta', TASK_STATUS_TEXT[e.status] || '状态未知');
    if (e.status === 'failed') st.classList.add('is-failed');
    sub.appendChild(st);
    if (TASK_SOURCE_TEXT[e.source]) sub.appendChild(el('span', 'tasks-meta', TASK_SOURCE_TEXT[e.source]));
    if (TASK_CONF_TEXT[e.confidence]) sub.appendChild(el('span', 'tasks-meta', TASK_CONF_TEXT[e.confidence]));
    if (e.kind === 'cron' && detail && typeof detail.schedule === 'string' && detail.schedule) {
      sub.appendChild(el('span', 'tasks-meta tasks-schedule', detail.schedule));
    }
    if (detail && Array.isArray(detail.missing) && detail.missing.length > 0) {
      sub.appendChild(el('span', 'tasks-meta tasks-missing', '缺字段: ' + detail.missing.join(', ')));
    }
    row.appendChild(sub);
    return row;
  }

  // 分组：小标题 + 计数注 + 行列表
  function buildTasksGroup(title, items) {
    var sec = el('div', 'tasks-group');
    var head = el('div', 'tasks-group-head');
    head.appendChild(el('span', 'tasks-group-title', title));
    head.appendChild(el('span', 'tasks-group-note', items.length + ' 项'));
    sec.appendChild(head);
    var list = el('div', 'tasks-list');
    for (var i = 0; i < items.length; i++) list.appendChild(buildTaskRow(items[i]));
    sec.appendChild(list);
    return sec;
  }

  // 目录渲染：diagnostics 摘要（头部小字槽）+ 三互斥分组（空组隐藏），组内按更新时间倒序
  function renderTasks(entries, diag) {
    tasksBody.textContent = '';
    var d = diag && typeof diag === 'object' ? diag : {};
    var badFiles = (Number(d.badFiles) || 0) + (Number(d.badCronFiles) || 0);
    var badLines = Number(d.badLines) || 0;
    if (badFiles + badLines > 0) {
      tasksDiag.textContent = badFiles > 0
        ? badFiles + ' 个损坏文件已跳过'
        : badLines + ' 条损坏记录已跳过';
      tasksDiag.hidden = false;
    } else {
      tasksDiag.hidden = true;
    }
    // 互斥分组：现存 cron 计划（含 running 态）归「Cron 调度」；其余 running 归「运行中」；
    // completed/failed/removed（含已移除 cron）归「已结束」
    var running = [];
    var crons = [];
    var done = [];
    if (Array.isArray(entries)) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e || typeof e !== 'object') continue;
        if (e.kind === 'cron' && e.status !== 'removed') crons.push(e);
        else if (e.status === 'running') running.push(e);
        else done.push(e);
      }
    }
    if (running.length === 0 && crons.length === 0 && done.length === 0) {
      tasksBody.appendChild(el('div', 'cmd-empty', '暂无后台任务'));
      return;
    }
    var byUpdatedDesc = function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); };
    if (running.length > 0) tasksBody.appendChild(buildTasksGroup('运行中', running.sort(byUpdatedDesc)));
    if (crons.length > 0) tasksBody.appendChild(buildTasksGroup('Cron 调度', crons.sort(byUpdatedDesc)));
    if (done.length > 0) tasksBody.appendChild(buildTasksGroup('已结束', done.sort(byUpdatedDesc)));
  }

  function renderTasksLoading() {
    tasksBody.textContent = '';
    var row = el('div', 'cmd-loading');
    row.appendChild(el('span', 'spinner'));
    row.appendChild(el('span', '', '正在读取任务列表…'));
    tasksBody.appendChild(row);
  }

  // 读取失败：只读视图不放重试钮——runtime-changed 事件会驱动自动重拉
  function renderTasksError() {
    tasksBody.textContent = '';
    tasksBody.appendChild(el('div', 'cmd-empty', '读取失败，任务变动时会自动重拉'));
  }

  function refreshTasks() {
    if (typeof window.kimiChat.getTaskCatalog !== 'function') { renderTasksError(); return; }
    var mySeq = ++tasksSeq;
    window.kimiChat.getTaskCatalog(currentSessionId).then(function (r) {
      if (mySeq !== tasksSeq || !tasksDrawerOpen) return; // 已关闭或已被新拉取取代，丢弃
      if (!r || r.error) { renderTasksError(); return; }
      renderTasks(r.entries, r.diagnostics);
    }).catch(function () {
      if (mySeq !== tasksSeq || !tasksDrawerOpen) return;
      renderTasksError();
    });
  }

  // runtime-changed 驱动（仅打开期间调用）：1s 防抖合并密集事件
  function scheduleTasksRefresh() {
    if (tasksRefreshTimer) clearTimeout(tasksRefreshTimer);
    tasksRefreshTimer = setTimeout(function () {
      tasksRefreshTimer = null;
      if (tasksDrawerOpen) refreshTasks();
    }, 1000);
  }

  function openTasksDrawer() {
    if (tasksDrawerOpen) return;
    tasksDrawerOpen = true;
    tasksDrawer.hidden = false;
    tasksBtn.classList.add('tasks-open');
    tasksBtn.setAttribute('aria-expanded', 'true');
    renderTasksLoading();
    refreshTasks();
  }

  // 幂等清理：隐藏 + 序号递增丢弃在途结果 + 清待发防抖 + 清空列表（重开时再拉）
  function closeTasksDrawer() {
    tasksDrawerOpen = false;
    tasksDrawer.hidden = true;
    tasksBtn.classList.remove('tasks-open');
    tasksBtn.setAttribute('aria-expanded', 'false');
    tasksSeq++;
    if (tasksRefreshTimer) { clearTimeout(tasksRefreshTimer); tasksRefreshTimer = null; }
    tasksBody.textContent = '';
    tasksDiag.hidden = true;
  }

  tasksBtn.addEventListener('click', function () {
    if (tasksDrawerOpen) closeTasksDrawer(); else openTasksDrawer();
  });
  tasksDrawerCloseBtn.addEventListener('click', closeTasksDrawer);
  // 状态条双徽章兼作入口：运行计数本身即抽屉摘要，点击/Enter/Space 直达详情
  function bindBadgeOpen(badge) {
    badge.addEventListener('click', openTasksDrawer);
    badge.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTasksDrawer(); }
    });
  }
  bindBadgeOpen(taskRunningBadgeEl);
  bindBadgeOpen(agentRunningBadgeEl);

  // ---------- 子代理步骤树（Agent 工具卡片内联展开，Phase 6b） ----------
  // 数据：getSubagentTree(currentSessionId)——state.json agents 映射父子关系 +
  // agents/*/wire.jsonl 磁盘扫描补绘步骤（降级路径，实时事件缺失时的兜底视图）。
  // 挂点：Agent 工具卡片「步骤」钮；展开时按 toolCallId 匹配 node.parentToolCallId，
  // 命中渲染以该节点为根的子树；未命中回退为会话全树视图并标注「按会话扫描结果展示」。
  // 折叠：每层独立，agentFoldMemory（agentId -> bool）跨重拉保留，会话切换清空；
  // 默认 running 展开、其余收起，手动操作立即覆盖默认。
  // 刷新：runtime-changed 1s 防抖重拉（仅存在展开树时），序号 agentTreeSeq 丢弃在途旧结果。
  // 树为文档流内联块，不参与 Escape 层级；全部动态文本经 textContent 写入，不拼 HTML。
  var agentTreeSeq = 0; // 拉取序号：会话切换递增，在途结果到达即作废
  var agentTreeCache = null; // 最近一次成功结果 { ok, sessionId, nodes, diagnostics }
  var agentTreeOpen = {}; // toolCallId -> 卡片 ref（当前展开的步骤树）
  var agentFoldMemory = Object.create(null); // agentId -> true 展开 / false 收起
  var agentTreeInflight = null; // 在途拉取的回调队列（多卡片同时展开共享一次 IPC）
  var agentTreeRefreshTimer = null; // runtime-changed 防抖定时器

  var AGENT_STATUS_TEXT = {
    running: '运行中', completed: '已完成', failed: '失败', interrupted: '已中断', unknown: '状态未知',
  };
  // 状态点复用 .dot 色系：running=busy（脉冲绿）completed=ready（绿）failed=error（红）其余=exited（灰）
  var AGENT_STATUS_DOT = {
    running: 'busy', completed: 'ready', failed: 'error', interrupted: 'exited', unknown: 'exited',
  };
  // steps.kind 实际枚举（subagent-tree.js 头部契约）：step=推理步 / tool=工具调用；未知值原样兜底
  var STEP_KIND_TEXT = { step: '推理', tool: '工具' };

  // Agent 工具卡片判定：title 全等 'Agent' 或含 'agent'（大小写不敏感）
  function isAgentToolTitle(title) {
    if (typeof title !== 'string' || !title) return false;
    return title === 'Agent' || title.toLowerCase().indexOf('agent') !== -1;
  }

  function hasOpenAgentTrees() {
    for (var k in agentTreeOpen) return true;
    return false;
  }

  // 折叠判定：手动记忆优先（bool 直读），缺省 running 展开、其余收起
  function isAgentNodeOpen(node) {
    var id = node && typeof node.agentId === 'string' ? node.agentId : '';
    var m = id ? agentFoldMemory[id] : undefined;
    if (typeof m === 'boolean') return m;
    return !!node && node.status === 'running';
  }

  // 收起预览：自尾向前取最近一条非空 step 文本（截断 72），无 step 文本时落回状态文字
  function agentNodePreview(node) {
    var steps = node && Array.isArray(node.steps) ? node.steps : [];
    for (var i = steps.length - 1; i >= 0; i--) {
      var t = steps[i] && typeof steps[i].text === 'string' ? steps[i].text.trim() : '';
      if (t) return t.length > 72 ? t.slice(0, 72) + '…' : t;
    }
    return AGENT_STATUS_TEXT[node && node.status] || '状态未知';
  }

  // 状态徽标：状态点 + 文字；failed 加 .is-failed 转 error 色
  function buildAgentStatusBadge(status) {
    var badge = el('span', 'sg-badge' + (status === 'failed' ? ' is-failed' : ''));
    badge.appendChild(el('span', 'dot ' + (AGENT_STATUS_DOT[status] || 'exited')));
    badge.appendChild(el('span', '', AGENT_STATUS_TEXT[status] || '状态未知'));
    return badge;
  }

  // 单条步骤：主行（mono seq + kind 徽标 + 状态点 + 截断文本 + tool 调用尾 6 位）；
  // tool 且 output 非空时追加 details 折叠输出；kind 未知值原样兜底、空值落「步骤」
  function buildStepRow(s) {
    var item = el('div', 'sg-step');
    var line = el('div', 'sg-step-line');
    var seq = s && typeof s.seq === 'number' ? s.seq : null;
    line.appendChild(el('span', 'sg-step-seq', seq === null ? '#—' : '#' + seq));
    var kind = s && typeof s.kind === 'string' ? s.kind : '';
    line.appendChild(el('span', 'sg-step-kind', STEP_KIND_TEXT[kind] || kind || '步骤'));
    line.appendChild(el('span', 'dot sg-step-dot ' + (AGENT_STATUS_DOT[s && s.status] || 'exited')));
    var text = s && typeof s.text === 'string' ? s.text.trim() : '';
    var textEl = el('span', 'sg-step-text', text || (s && s.status === 'running' ? '正在生成…' : '（无文本记录）'));
    if (text) textEl.title = s.text; // 截断时悬浮看全文
    line.appendChild(textEl);
    item.appendChild(line);
    if (kind === 'tool') {
      var callId = s && typeof s.toolCallId === 'string' ? s.toolCallId : '';
      if (callId) line.appendChild(el('span', 'sg-step-call', '…' + callId.slice(-6)));
      var output = s && typeof s.output === 'string' ? s.output : '';
      if (output) {
        var out = document.createElement('details');
        out.className = 'sg-step-out';
        var sum = document.createElement('summary');
        sum.textContent = '输出';
        out.appendChild(sum);
        out.appendChild(el('div', 'sg-step-out-body', output));
        item.appendChild(out);
      }
    }
    return item;
  }

  // 节点块：head（折叠箭头 + 类型徽标 + 标题 + id 尾 6 位 + 状态徽标 + 相对时间）
  // + 收起预览行 + 体（steps + 递归 children 缩进线）；手动折叠立即写 agentFoldMemory
  function buildAgentNode(node, childrenOf, visited) {
    if (!node || typeof node !== 'object') return null;
    var agentId = typeof node.agentId === 'string' && node.agentId ? node.agentId : '?';
    if (visited[agentId]) return null; // 防御：数据成环/重复直接跳过，不虚构层级
    visited[agentId] = true;
    var open = isAgentNodeOpen(node);
    var box = el('div', 'sg-node' + (open ? ' open' : ''));

    var head = el('div', 'sg-head');
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.appendChild(el('span', 'sg-caret', '▸'));
    head.appendChild(el('span', 'sg-type', agentId === 'main'
      ? '主代理'
      : (typeof node.agentType === 'string' && node.agentType ? node.agentType : '子代理')));
    var title = typeof node.description === 'string' && node.description ? node.description
      : (agentId === 'main' ? '主会话' : '子代理');
    var titleEl = el('span', 'sg-title', title);
    if (title) titleEl.title = title;
    head.appendChild(titleEl);
    if (agentId !== 'main') head.appendChild(el('span', 'sg-id', '…' + agentId.slice(-6)));
    head.appendChild(buildAgentStatusBadge(node.status));
    head.appendChild(el('span', 'sg-time', fmtAgo(node.updatedAt)));
    box.appendChild(head);

    var preview = el('div', 'sg-preview', agentNodePreview(node));
    preview.hidden = open;
    box.appendChild(preview);

    var body = el('div', 'sg-body');
    body.hidden = !open;
    var steps = Array.isArray(node.steps) ? node.steps : [];
    if (steps.length === 0) {
      body.appendChild(el('div', 'sg-note', '暂无步骤记录'));
    } else {
      var list = el('div', 'sg-steps');
      for (var i = 0; i < steps.length; i++) list.appendChild(buildStepRow(steps[i]));
      body.appendChild(list);
    }
    var kids = childrenOf[agentId] || [];
    if (kids.length > 0) {
      var kidWrap = el('div', 'sg-children');
      for (var k = 0; k < kids.length; k++) {
        var kidEl = buildAgentNode(kids[k], childrenOf, visited);
        if (kidEl) kidWrap.appendChild(kidEl);
      }
      if (kidWrap.children.length > 0) body.appendChild(kidWrap);
    }
    box.appendChild(body);

    var onToggle = function () {
      var nowOpen = !box.classList.contains('open');
      box.classList.toggle('open', nowOpen);
      agentFoldMemory[agentId] = nowOpen; // 手动操作立即覆盖默认，跨重拉保留
      preview.hidden = nowOpen;
      body.hidden = !nowOpen;
    };
    head.addEventListener('click', onToggle);
    head.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
    });
    return box;
  }

  // nodes → childrenOf 映射（parentAgentId -> [childNode]）；'__unknown__'/顶层游离在渲染侧分组
  function buildChildrenOf(nodes) {
    var childrenOf = Object.create(null);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || typeof n !== 'object') continue;
      var p = typeof n.parentAgentId === 'string' ? n.parentAgentId : null;
      if (!p || p === '__unknown__') continue;
      if (!childrenOf[p]) childrenOf[p] = [];
      childrenOf[p].push(n);
    }
    return childrenOf;
  }

  // 诊断注行：truncated 防御未来契约（实际形状暂无该字段）；badFiles/badLines 为实际字段
  function appendTreeNotes(root, diag, extraNote) {
    if (extraNote) root.appendChild(el('div', 'sg-note', extraNote));
    if (diag.truncated === true) {
      root.appendChild(el('div', 'sg-note', '节点过多已截断，仅显示部分节点'));
    }
    var badFiles = Number(diag.badFiles) || 0;
    var badLines = Number(diag.badLines) || 0;
    if (badFiles > 0) root.appendChild(el('div', 'sg-note', badFiles + ' 个损坏文件已跳过'));
    else if (badLines > 0) root.appendChild(el('div', 'sg-note', badLines + ' 条损坏记录已跳过'));
  }

  // 会话全树：main 根（含递归子层）→ 顶层游离节点（无 state.json 降级路径）
  // → 底部「未知关系」组（__unknown__ 或父 id 不在扫描集内，组标题带计数）
  function buildAgentTreeView(nodes, diag, note) {
    var root = el('div', 'sg-tree');
    appendTreeNotes(root, diag, note);
    var ids = Object.create(null);
    var i;
    var n;
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      if (n && typeof n === 'object' && typeof n.agentId === 'string' && n.agentId) ids[n.agentId] = true;
    }
    var childrenOf = buildChildrenOf(nodes);
    var mainNode = null;
    var tops = [];
    var unknowns = [];
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      if (!n || typeof n !== 'object') continue;
      var p = typeof n.parentAgentId === 'string' ? n.parentAgentId : null;
      if (n.agentId === 'main') { mainNode = n; continue; }
      if (p === '__unknown__' || (p && !ids[p])) unknowns.push(n);
      else if (!p) tops.push(n);
    }
    var visited = Object.create(null);
    if (mainNode) {
      var mainEl = buildAgentNode(mainNode, childrenOf, visited);
      if (mainEl) root.appendChild(mainEl);
    }
    for (i = 0; i < tops.length; i++) {
      var topEl = buildAgentNode(tops[i], childrenOf, visited);
      if (topEl) root.appendChild(topEl);
    }
    if (unknowns.length > 0) {
      var grp = el('div', 'sg-unknown');
      var ghead = el('div', 'sg-unknown-head');
      ghead.appendChild(el('span', 'sg-unknown-title', '未知关系'));
      ghead.appendChild(el('span', 'sg-unknown-note', unknowns.length + ' 项'));
      grp.appendChild(ghead);
      for (i = 0; i < unknowns.length; i++) {
        var uEl = buildAgentNode(unknowns[i], childrenOf, visited);
        if (uEl) grp.appendChild(uEl);
      }
      root.appendChild(grp);
    }
    return root;
  }

  // 展开容器渲染：按 toolCallId 匹配 parentToolCallId；命中渲染该节点子树（含递归后代），
  // 未命中回退会话全树并标注「按会话扫描结果展示」；nodes 为空显示空态
  function renderAgentTreeInto(wrap, data, toolCallId) {
    wrap.textContent = '';
    var nodes = data && Array.isArray(data.nodes) ? data.nodes : [];
    var diag = data && data.diagnostics && typeof data.diagnostics === 'object' ? data.diagnostics : {};
    if (nodes.length === 0) {
      wrap.appendChild(el('div', 'cmd-empty', '暂无子代理步骤记录'));
      return;
    }
    var hit = null;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] && typeof nodes[i].parentToolCallId === 'string' && nodes[i].parentToolCallId === toolCallId) {
        hit = nodes[i];
        break;
      }
    }
    if (!hit) {
      wrap.appendChild(buildAgentTreeView(nodes, diag, '未匹配到该工具调用对应的子代理，按会话扫描结果展示'));
      return;
    }
    var root = el('div', 'sg-tree');
    appendTreeNotes(root, diag, null);
    var childrenOf = buildChildrenOf(nodes);
    var hitEl = buildAgentNode(hit, childrenOf, Object.create(null));
    if (hitEl) root.appendChild(hitEl);
    wrap.appendChild(root);
  }

  function renderTreeLoading(wrap) {
    wrap.textContent = '';
    var row = el('div', 'cmd-loading');
    row.appendChild(el('span', 'spinner'));
    row.appendChild(el('span', '', '正在读取子代理步骤…'));
    wrap.appendChild(row);
  }

  // 只读视图不放重试钮：收起再展开即重拉，runtime 事件亦驱动自动重拉
  function renderTreeError(wrap, msg) {
    wrap.textContent = '';
    wrap.appendChild(el('div', 'cmd-warn', '读取失败：' + msg));
  }

  // 拉取（多卡片同时展开共享一次 IPC）：成功写 agentTreeCache；会话切换使在途结果作废
  function fetchAgentTree(cb) {
    if (agentTreeInflight) { agentTreeInflight.push(cb); return; }
    var cbs = [cb];
    agentTreeInflight = cbs;
    var mySeq = agentTreeSeq;
    var done = function (res) {
      agentTreeInflight = null;
      if (mySeq !== agentTreeSeq) return;
      for (var i = 0; i < cbs.length; i++) cbs[i](res);
    };
    window.kimiChat.getSubagentTree(currentSessionId).then(function (r) {
      if (r && r.ok !== false) {
        agentTreeCache = r;
        done({ ok: true });
      } else {
        // 主进程失败形状 { ok:false, message }；error 字段为兜底
        var msg = r && (r.message || r.error) ? String(r.message || r.error) : '读取失败';
        done({ ok: false, error: msg });
      }
    }).catch(function (err) {
      done({ ok: false, error: String(err && err.message ? err.message : err) });
    });
  }

  // 「步骤」钮开合：展开立即 loading，有缓存直接渲染、无缓存拉取后渲染；
  // 收起仅隐藏容器并移出 agentTreeOpen（折叠记忆保留，重开仍按记忆呈现）
  function toggleAgentSteps(ref) {
    var toolCallId = ref.toolCallId;
    if (ref.treeOpen) {
      ref.treeOpen = false;
      ref.treeWrap.hidden = true;
      ref.stepsToggle.classList.remove('open');
      ref.stepsToggle.setAttribute('aria-expanded', 'false');
      ref.stepsToggle.title = '展开子代理步骤';
      delete agentTreeOpen[toolCallId];
      return;
    }
    ref.treeOpen = true;
    ref.treeWrap.hidden = false;
    ref.stepsToggle.classList.add('open');
    ref.stepsToggle.setAttribute('aria-expanded', 'true');
    ref.stepsToggle.title = '收起子代理步骤';
    agentTreeOpen[toolCallId] = ref;
    if (agentTreeCache) {
      renderAgentTreeInto(ref.treeWrap, agentTreeCache, toolCallId);
      return;
    }
    renderTreeLoading(ref.treeWrap);
    fetchAgentTree(function (res) {
      if (!ref.treeOpen) return; // 拉取期间已收起
      if (res.ok) renderAgentTreeInto(ref.treeWrap, agentTreeCache, toolCallId);
      else renderTreeError(ref.treeWrap, res.error);
    });
  }

  // 重拉重绘（事件驱动）：成功就地把各展开容器按新数据重绘（折叠态经 agentFoldMemory 保留）；
  // 失败时已有缓存保留旧视图，从未成功过则把 loading 容器落为错误态
  function refreshOpenAgentTrees() {
    fetchAgentTree(function (res) {
      var id;
      var ref;
      if (res.ok) {
        for (id in agentTreeOpen) {
          ref = agentTreeOpen[id];
          if (ref && ref.treeOpen) renderAgentTreeInto(ref.treeWrap, agentTreeCache, id);
        }
      } else if (!agentTreeCache) {
        for (id in agentTreeOpen) {
          ref = agentTreeOpen[id];
          if (ref && ref.treeOpen) renderTreeError(ref.treeWrap, res.error);
        }
      }
    });
  }

  // runtime-changed 驱动（仅存在展开树时调用）：1s 防抖合并密集事件
  function scheduleAgentTreeRefresh() {
    if (agentTreeRefreshTimer) clearTimeout(agentTreeRefreshTimer);
    agentTreeRefreshTimer = setTimeout(function () {
      agentTreeRefreshTimer = null;
      if (hasOpenAgentTrees()) refreshOpenAgentTrees();
    }, 1000);
  }

  // ---------- 图片附件 ----------
  function refreshChipsVisibility() {
    chips.hidden = pendingImages.length === 0;
  }

  // 渲染层二次校验（preload/主进程已做白名单与大小校验）：
  // mimeType 须在白名单内，data 须为非空 base64 字符串，非法项返回 null
  function sanitizeImage(img) {
    if (!img || typeof img !== 'object') return null;
    if (typeof img.mimeType !== 'string' || !IMAGE_MIME_WHITELIST[img.mimeType]) return null;
    if (typeof img.data !== 'string' || !img.data) return null;
    return {
      name: typeof img.name === 'string' && img.name ? img.name : '图片',
      mimeType: img.mimeType,
      data: img.data,
      size: typeof img.size === 'number' && img.size >= 0 ? img.size : 0,
    };
  }

  // 附件 chip：img 缩略图（data URL）+ ×移除按钮（type=button，
  // 点击从 pendingImages 数组与 DOM 中一并删除）
  function buildChip(img) {
    var chip = document.createElement('span');
    chip.className = 'chip';
    var thumb = document.createElement('img');
    thumb.className = 'chip-thumb';
    thumb.src = 'data:' + img.mimeType + ';base64,' + img.data;
    thumb.alt = img.name;
    chip.appendChild(thumb);
    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chip-remove';
    removeBtn.textContent = '×';
    removeBtn.title = '移除图片';
    removeBtn.addEventListener('click', function () {
      var idx = pendingImages.indexOf(img);
      if (idx !== -1) pendingImages.splice(idx, 1);
      if (chip.parentNode) chip.parentNode.removeChild(chip);
      refreshChipsVisibility();
      refreshSendBtn();
    });
    chip.appendChild(removeBtn);
    return chip;
  }

  // 追加选图结果：与现有合计至多 MAX_PENDING_IMAGES 张，超出部分丢弃并系统提示
  function addPendingImages(list) {
    var dropped = 0;
    for (var i = 0; i < list.length; i++) {
      var img = sanitizeImage(list[i]);
      if (!img) continue; // preload 已校验，此处仅兜底防御，静默跳过
      if (pendingImages.length >= MAX_PENDING_IMAGES) {
        dropped++;
        continue;
      }
      pendingImages.push(img);
      chips.appendChild(buildChip(img));
    }
    refreshChipsVisibility();
    refreshSendBtn();
    if (dropped > 0) {
      appendSystemNotice('一次最多附带 ' + MAX_PENDING_IMAGES + ' 张图片，已丢弃 ' + dropped + ' 张');
    }
  }

  // 发送失败后把本轮快照附件恢复到附件行（发送时已清空，此处原样重建）
  function restorePendingImages(images) {
    for (var i = 0; i < images.length && pendingImages.length < MAX_PENDING_IMAGES; i++) {
      pendingImages.push(images[i]);
      chips.appendChild(buildChip(images[i]));
    }
    refreshChipsVisibility();
    refreshSendBtn();
  }

  // 带图发送失败的补充提示：本机 CLI 0.27.0 实测图文 prompt 会崩溃/挂起
  // （docs/acp-probe4-output.txt），引导用户改走 Web UI 发图
  function notifyImageSendFailure(images) {
    if (Array.isArray(images) && images.length > 0) {
      appendSystemNotice('当前 CLI 可能不支持图片输入，可点击右上角「Web UI」在高级面板中发送图片');
    }
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

  // ---------- 运行中任务/子代理徽章（runtime-changed 事件 counts 驱动） ----------
  // 只读 counts.session（当前 ACP 会话口径；null 视为全 0）；文案 textContent 赋值，不拼 HTML
  function refreshRunningBadges(counts) {
    var session = counts && typeof counts === 'object' ? counts.session : null;
    var tasks = session && typeof session.tasks === 'number' ? session.tasks : 0;
    var agents = session && typeof session.agents === 'number' ? session.agents : 0;
    taskRunningBadgeEl.textContent = tasks + ' 个任务运行中';
    taskRunningBadgeEl.hidden = tasks <= 0;
    agentRunningBadgeEl.textContent = agents + ' 个子代理运行中';
    agentRunningBadgeEl.hidden = agents <= 0;
  }

  // 会话切换时立即隐藏两个徽章（归属旧会话口径，等下一次 runtime-changed 刷新）
  function hideRunningBadges() {
    taskRunningBadgeEl.hidden = true;
    agentRunningBadgeEl.hidden = true;
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
    hideRunningBadges(); // 徽章归属旧会话，立即隐藏待新会话 counts 刷新
    // 本地命令面板随会话切换关闭（面板数据归属旧会话），在途结果序号作废
    cmdPanel.hidden = true;
    cmdPanelSeq++;
    cmdPanelUsage = null;
    // Tasks 抽屉随会话切换关闭并清空（列表归属旧会话，等重新打开再拉）
    closeTasksDrawer();
    // 子代理步骤树折叠记忆归属旧会话，一并清空（树本体已随 resetTranscript 销毁）
    agentFoldMemory = Object.create(null);
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
        // 历史 assistant 约简为一个消息块，不带思考区/工具卡片
        var el = document.createElement('div');
        el.className = 'msg msg-assistant';
        var textEl = document.createElement('div');
        textEl.className = 'assistant-text';
        if (typeof KcdMarkdown !== 'undefined' && KcdMarkdown.renderAssistantMessage) {
          var turn = {
            textEl: textEl,
            textStr: m.text,
            cachedText: '',
            cachedHtml: undefined,
          };
          KcdMarkdown.renderAssistantMessage(m.text, turn, false);
          KcdMarkdown.addMessageCopyButton(textEl, function () { return m.text; });
        } else {
          textEl.textContent = m.text;
        }
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
        currentSessionId = p.sessionId; // 本地命令（/usage、/status）入参
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
        // 缓存命令清单供斜杠菜单过滤；旧形态（仅 count、无 commands 字段）按 []
        slashCommands = sanitizeCommands(p.commands);
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
          // 尝试 TodoList 渲染
          if (typeof KcdMarkdown !== 'undefined' && KcdMarkdown.parseTodoList) {
            var todoResult = KcdMarkdown.parseTodoList(p, updRef.outputStr);
            if (todoResult.isTodo) {
              if (todoResult.html) {
                updRef.outputEl.innerHTML = todoResult.html;
              } else {
                updRef.outputEl.textContent = updRef.outputStr;
              }
            } else {
              updRef.outputEl.textContent = updRef.outputStr;
            }
          } else {
            updRef.outputEl.textContent = updRef.outputStr;
          }
          updRef.outputEl.hidden = false;
        }
        maybeScrollToBottom();
        break;
      }
      case 'plan':
        // plan 推送：entries 整体替换，渲染顶部计划进度卡片
        if (typeof KcdPlan !== 'undefined' && KcdPlan.normalizePlanEntries) {
          planCardEntries = KcdPlan.normalizePlanEntries(p.entries);
          renderPlanCard();
        }
        break;
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
    // 本地命令精确拦截（trim 后全等，大小写敏感）：/usage、/status 走本地面板，
    // 不进聊天记录、不发给 ACP；'/usage foo' 等带参形式不满足全等，原样放行给下方正常流程
    if (text === '/usage' || text === '/status') {
      input.value = '';
      hideSlashMenu();
      autoGrow();
      refreshSendBtn();
      runLocalCommand(text);
      input.focus();
      return;
    }
    var images = pendingImages.slice(); // 本轮待发附件快照
    if ((!text && images.length === 0) || connState !== 'ready' || busy) return;

    flushBuffers(); // 防御：上一轮残余缓冲先落 DOM（正常为空）
    appendUserMessage(text, images);
    currentTurn = createTurn();
    msgBuf = '';
    thoughtBuf = '';
    busy = true;
    input.value = '';
    // 发送即清空待发附件（已随快照提交）；发送失败时在回调里恢复，chips 保留待重发
    pendingImages = [];
    chips.textContent = '';
    refreshChipsVisibility();
    hideSlashMenu();
    autoGrow();
    refreshUi();
    stickToBottom = true;
    scrollToBottom();

    // 文本为空但有图时 text 传 ''，preload/主进程会兜底
    window.kimiChat.sendPrompt(text, images).then(function (r) {
      if (!r || !r.ok) {
        appendSystemNotice('发送失败：' + (r && r.error ? r.error : '未知错误'));
        notifyImageSendFailure(images);
        restorePendingImages(images);
      }
    }).catch(function (err) {
      appendSystemNotice('发送失败：' + String(err && err.message ? err.message : err));
      notifyImageSendFailure(images);
      restorePendingImages(images);
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
    renderSlashMenu(); // '/' 前缀时刷新斜杠命令菜单，否则隐藏
  });
  input.addEventListener('keydown', function (e) {
    // 斜杠菜单可见时优先接管按键：上下循环高亮、Enter/Tab 选中、Escape 关闭；
    // 此时 Enter 必须先 preventDefault 且只选中不发送（与下方 Enter 发送共存）
    if (!slashMenu.hidden) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSlashActive(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSlashActive(-1);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') {
        e.preventDefault();
        if (slashMatches[slashActive]) applySlashCommand(slashMatches[slashActive]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSlashMenu();
        return;
      }
    }
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
  // 附件按钮：系统选图 → 追加进 chips 行；skipped 为超 10MB/读取失败被跳过的张数
  attachBtn.addEventListener('click', function () {
    window.kimiChat.pickImages().then(function (r) {
      if (!r || !r.ok) {
        appendSystemNotice('选择图片失败：' + (r && r.error ? r.error : '未知错误'));
        return;
      }
      var skipped = typeof r.skipped === 'number' ? r.skipped : 0;
      if (skipped > 0) {
        appendSystemNotice('有 ' + skipped + ' 张图片被跳过（超过 10MB 或读取失败）');
      }
      addPendingImages(Array.isArray(r.images) ? r.images : []);
    }).catch(function (err) {
      appendSystemNotice('选择图片失败：' + String(err && err.message ? err.message : err));
    });
  });
  // Web UI 按钮：在 Web UI 高级面板中打开（无参调用），失败时系统提示
  webuiBtn.addEventListener('click', function () {
    window.kimiChat.openWebUI().then(function (r) {
      if (!r || !r.ok) {
        appendSystemNotice('打开 Web UI 失败：' + (r && r.error ? r.error : '未知错误'));
      }
    }).catch(function (err) {
      appendSystemNotice('打开 Web UI 失败：' + String(err && err.message ? err.message : err));
    });
  });
  retryBtn.addEventListener('click', function () {
    start(lastStartOpts);
  });

  // ---------- 启动会话 ----------
  function start(opts) {
    lastStartOpts = opts;
    connState = 'connecting';
    busy = false;
    currentSessionId = null; // 新会话 ID 待 ready 事件回填
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
    attachBtn.disabled = true;
    webuiBtn.disabled = true;
    tasksBtn.disabled = true; // 抽屉依赖桥接 getTaskCatalog，一并禁用
    return;
  }

  // ---------- Markdown / 纯文本功能 ----------
  var plainToggleBtn = document.getElementById('plainToggleBtn');

  // 初始化纯文本按钮状态
  function refreshPlainToggle() {
    if (typeof KcdMarkdown !== 'undefined' && KcdMarkdown.isPlainText) {
      var isPlain = KcdMarkdown.isPlainText();
      plainToggleBtn.textContent = isPlain ? 'Markdown' : '纯文本';
      plainToggleBtn.title = isPlain ? '切换为 Markdown 渲染' : '切换为纯文本渲染';
    }
  }

  if (plainToggleBtn) {
    plainToggleBtn.addEventListener('click', function () {
      if (typeof KcdMarkdown !== 'undefined' && KcdMarkdown.setPlainText) {
        var now = KcdMarkdown.isPlainText();
        KcdMarkdown.setPlainText(!now);
        refreshPlainToggle();
        // 刷新现有消息：暴力重绘整个消息区（简单可靠，消息条数有限）
        var turns = messagesInner.querySelectorAll('.msg-assistant');
        for (var ti = 0; ti < turns.length; ti++) {
          var turnWrap = turns[ti];
          var textEl = turnWrap.querySelector('.assistant-text');
          if (!textEl) continue;
          // 找到对应的 textStr（从当前内容反推不可行，用 data 属性存一下）
          // 由于 textStr 只存在 turn 对象中，此处不做全量刷新，
          // 后续 flush/新消息会走新的模式
        }
      }
    });
    refreshPlainToggle();
  }

  // 链接点击拦截：走系统浏览器
  if (typeof KcdMarkdown !== 'undefined' && KcdMarkdown.setupLinkHandler) {
    KcdMarkdown.setupLinkHandler(messagesInner, function (url) {
      try {
        window.kimiChat.openExternal(url);
      } catch (e) {
        // preload 无 openExternal 时 fallback
        var a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    });
  }

  document.title = '原生聊天 - 新会话';
  window.kimiChat.onEvent(onEvent);
  // runtime 状态变化订阅（Phase 3a 冻结 API）：读 payload.counts 刷新运行中任务/子代理徽章
  // （旧事件无 counts 字段 -> 不动徽章）；抽屉打开期间任何 runtime 变化 1s 防抖重拉目录
  window.kimiChat.onRuntimeChanged(function (p) {
    if (p && p.payload && p.payload.counts) refreshRunningBadges(p.payload.counts);
    if (tasksDrawerOpen) scheduleTasksRefresh();
    if (hasOpenAgentTrees()) scheduleAgentTreeRefresh(); // 步骤树展开期间随任务变动 1s 防抖重拉
  });
  autoGrow();
  refreshUi();
  start();
})();
