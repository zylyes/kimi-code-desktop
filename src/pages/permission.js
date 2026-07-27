// Kimi Code Desktop — 权限审批窗口渲染逻辑
// 职责：展示 ACP 工具调用的审批请求（标题 / 类型徽标 / 详情 / 相关文件），
// 由 options 生成按钮组，通过 window.kimiPermission 桥接回传选择结果或取消。
// 支持 ExitPlanMode 审批：Markdown 渲染计划全文、反馈输入态、三选项分类。
(function () {
  'use strict';

  var api = window.kimiPermission || null;
  var KcdMarkdown = window.KcdMarkdown || null;
  var KcdPlan = window.KcdPlan || null;
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    kindChip: $('kindChip'),
    bridgeWarn: $('bridgeWarn'),
    loading: $('loading'),
    req: $('req'),
    reqTitle: $('reqTitle'),
    reqSub: $('reqSub'),
    detailWrap: $('detailWrap'),
    detail: $('detail'),
    detailTrunc: $('detailTrunc'),
    // ExitPlanMode Markdown 容器
    mdDetailWrap: $('mdDetailWrap'),
    mdDetail: $('mdDetail'),
    locsWrap: $('locsWrap'),
    locs: $('locs'),
    notice: $('notice'),
    hint: $('hint'),
    cancelBtn: $('cancelBtn'),
    optBtns: $('optBtns'),
    // ExitPlanMode 额外元素
    planHint: $('planHint'),
    feedbackWrap: $('feedbackWrap'),
    feedbackInput: $('feedbackInput'),
    feedbackBackBtn: $('feedbackBackBtn'),
    feedbackSubmitBtn: $('feedbackSubmitBtn'),
  };

  var TITLE_MAX = 300;     // 工具标题防御性截断
  var KIND_MAX = 40;       // 类型徽标文本上限
  var DETAIL_MAX = 4000;   // 详情区字符上限（主进程已预截断，此处再兜底）
  var NAME_MAX = 80;       // 选项按钮文案上限
  var ID_MAX = 200;        // optionId 上限
  var PATH_MAX = 500;      // 单条路径上限
  var LOCATIONS_MAX = 50;  // 路径条数上限
  var OPTIONS_MAX = 20;    // 选项个数上限
  var DETAIL_COLLAPSED_HEIGHT = 260; // 普通审批 detail 折叠高度

  // 工具调用类型 → 徽标文本（未知类型回退显示原始 kind）
  var KIND_LABELS = {
    read: '读取',
    edit: '编辑',
    delete: '删除',
    move: '移动',
    search: '搜索',
    execute: '执行命令',
    think: '思考',
    fetch: '网络请求',
    switch_mode: '切换模式',
    other: '其他',
  };

  var state = {
    ready: false,
    responded: false, // 已响应后置真，防止重复提交
    optionBtns: [],
    isExitPlanMode: false, // 当前是否为 ExitPlanMode
    selectedOptionId: null, // 反馈态暂存
    feedbackMode: false, // 是否在反馈输入态
    detailExpanded: false, // Ctrl-E 展开/收起态
    currentData: null, // 保存的原始 normalize 数据
  };

  /* ---------- 工具函数 ---------- */
  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

  function trunc(s, max) { return s.length > max ? s.slice(0, max) : s; }

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  /* ---------- 数据规范化：容忍字段缺失/异常 ---------- */
  function normalize(data) {
    var src = data && typeof data === 'object' ? data : {};

    var options = [];
    var rawOpts = Array.isArray(src.options) ? src.options : [];
    for (var i = 0; i < rawOpts.length && options.length < OPTIONS_MAX; i++) {
      var o = rawOpts[i];
      if (!o || typeof o !== 'object') continue;
      var id = trunc(str(o.optionId), ID_MAX);
      if (!id) continue;
      options.push({
        optionId: id,
        name: trunc(str(o.name) || id, NAME_MAX),
        kind: trunc(str(o.kind), KIND_MAX),
      });
    }

    var locations = [];
    var rawLocs = Array.isArray(src.locations) ? src.locations : [];
    for (var j = 0; j < rawLocs.length && locations.length < LOCATIONS_MAX; j++) {
      var l = rawLocs[j];
      if (!l || typeof l !== 'object') continue;
      var p = trunc(str(l.path), PATH_MAX);
      if (!p) continue;
      var item = { path: p, line: 0 };
      if (typeof l.line === 'number' && isFinite(l.line) && l.line > 0) {
        item.line = Math.floor(l.line);
      }
      locations.push(item);
    }

    return {
      title: trunc(str(src.title), TITLE_MAX),
      toolTitle: trunc(str(src.toolTitle), TITLE_MAX),
      kind: trunc(str(src.kind), KIND_MAX),
      detail: str(src.detail),
      locations: locations,
      options: options,
    };
  }

  /* ---------- 提示条 ---------- */
  function setHint(kind, msg) {
    els.hint.className = 'hint' + (kind ? ' ' + kind : '');
    els.hint.textContent = msg || '';
  }

  /* ---------- 渲染（动态文本一律 textContent，杜绝注入；ExitPlanMode detail 为 Markdown innerHTML） ---------- */
  function kindLabel(kind) {
    return KIND_LABELS[kind] || kind || '其他';
  }

  // 选项类型 → 按钮样式：allow_once 主按钮、allow_secondary 次按钮、拒绝类警示色
  function btnClassFor(kind) {
    if (kind === 'allow_once') return 'btn btn-primary';
    if (kind === 'allow_always') return 'btn btn-secondary';
    if (kind === 'reject_once' || kind === 'reject_always') return 'btn btn-danger';
    return 'btn btn-secondary';
  }

  // ExitPlanMode 选项按钮样式的分类覆盖
  function exitPlanBtnClass(optionId) {
    if (optionId === 'plan_approve') return 'btn btn-primary';
    if (optionId === 'plan_revise') return 'btn btn-secondary';
    if (optionId === 'plan_reject_and_exit') return 'btn btn-danger';
    return 'btn btn-secondary';
  }

  function renderDetail(detail) {
    if (!detail) {
      els.detailWrap.hidden = true;
      return;
    }
    var over = detail.length > DETAIL_MAX;
    els.detail.textContent = over ? detail.slice(0, DETAIL_MAX) : detail;
    els.detailTrunc.hidden = !over;
    els.detailWrap.hidden = false;
  }

  function renderMarkdownDetail(detail) {
    if (!detail) {
      els.mdDetailWrap.hidden = true;
      return;
    }
    // 用 marked + DOMPurify 全局变量（vendor 三库通过 <script> 加载后挂载到 window）
    var mkd = (typeof window !== 'undefined' && window.marked) || null;
    var dp = (typeof window !== 'undefined' && window.DOMPurify) || null;
    var html = detail;
    try {
      if (mkd && typeof mkd.parse === 'function') {
        html = mkd.parse(detail, { breaks: true, gfm: true });
      }
      if (dp && typeof dp.sanitize === 'function') {
        html = dp.sanitize(html, {
          ALLOWED_TAGS: ['p','h1','h2','h3','h4','h5','h6','ul','ol','li','table','thead','tbody','tr','th','td','code','pre','span','div','a','strong','em','b','i','blockquote','hr','br','del','input','img'],
          ALLOWED_ATTR: ['href','target','rel','title','alt','class','id','src','width','height','type','checked','disabled','lang','language','style','align'],
          ALLOW_DATA_ATTR: false,
          ALLOW_ARIA_ATTR: false,
          FORBID_TAGS: ['script','style','iframe','object','form'],
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
        });
      }
    } catch (e) {
      // 渲染异常兜底：纯文本
      html = detail.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    els.mdDetail.innerHTML = html;
    els.mdDetailWrap.hidden = false;
  }

  function renderLocations(locations) {
    els.locs.textContent = '';
    if (locations.length === 0) {
      els.locsWrap.hidden = true;
      return;
    }
    locations.forEach(function (loc) {
      var li = el('li', 'loc');
      li.textContent = loc.line > 0 ? loc.path + ':' + loc.line : loc.path;
      els.locs.appendChild(li);
    });
    els.locsWrap.hidden = false;
  }

  function renderOptions(options, isExitPlanMode) {
    els.optBtns.textContent = '';
    state.optionBtns = [];
    options.forEach(function (opt) {
      var btnClass = isExitPlanMode ? exitPlanBtnClass(opt.optionId) : btnClassFor(opt.kind);
      var btn = el('button', btnClass);
      btn.type = 'button';
      btn.textContent = opt.name;
      btn.addEventListener('click', function () {
        if (isExitPlanMode && KcdPlan) {
          var cls = KcdPlan.classifyExitPlanOption(opt.optionId);
          if (cls === 'approve') {
            // approve 直接提交
            doRespond(opt.optionId);
            return;
          }
          if (cls === 'revise' || cls === 'reject_exit') {
            // revise/reject_exit → 反馈输入态
            enterFeedbackMode(opt.optionId);
            return;
          }
        }
        doRespond(opt.optionId);
      });
      els.optBtns.appendChild(btn);
      state.optionBtns.push(btn);
    });
  }

  // ---------- 反馈输入态 ----------
  function enterFeedbackMode(optionId) {
    if (state.responded) return;
    state.feedbackMode = true;
    state.selectedOptionId = optionId;
    // 隐藏选项区和取消按钮
    els.optBtns.hidden = true;
    els.cancelBtn.hidden = true;
    // 显示反馈区
    els.feedbackWrap.hidden = false;
    els.feedbackInput.value = '';
    // 请求动画帧后 focus
    requestAnimationFrame(function () {
      els.feedbackInput.focus();
    });
    setHint('', '输入修订意见后提交，或留空直接提交。按 Esc 返回。');
  }

  function exitFeedbackMode() {
    if (!state.feedbackMode) return;
    state.feedbackMode = false;
    state.selectedOptionId = null;
    els.feedbackWrap.hidden = true;
    els.optBtns.hidden = false;
    els.cancelBtn.hidden = false;
    // 恢复焦点到主按钮
    var primary = els.optBtns.querySelector('.btn-primary');
    (primary || els.cancelBtn).focus({ preventScroll: true });
    setHint('', '');
  }

  function submitFeedback() {
    if (state.responded || !state.selectedOptionId) return;
    var raw = els.feedbackInput.value;
    var feedback = KcdPlan ? KcdPlan.validatePlanFeedback(raw) : (raw && typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 2000) : null);
    doRespond(state.selectedOptionId, feedback);
  }

  function setAllDisabled(on) {
    els.cancelBtn.disabled = on;
    for (var i = 0; i < state.optionBtns.length; i++) {
      state.optionBtns[i].disabled = on;
    }
    els.feedbackBackBtn.disabled = on;
    els.feedbackSubmitBtn.disabled = on;
    els.feedbackInput.disabled = on;
  }

  function showNotice(text) {
    els.req.hidden = true;
    els.notice.hidden = false;
    els.notice.textContent = text;
  }

  /* ---------- 动作 ---------- */
  function doRespond(optionId, feedback) {
    if (!api || state.responded) return;
    state.responded = true;
    setAllDisabled(true);
    var msg = optionId == null ? '已取消，窗口即将关闭…' : '已提交选择，窗口即将关闭…';
    setHint('', msg);
    api.respond(optionId, feedback).catch(function (e) {
      // 提交失败：恢复可操作状态，允许重试（主进程侧对重复响应有幂等保护）
      state.responded = false;
      setAllDisabled(false);
      if (state.feedbackMode) {
        els.feedbackInput.disabled = false;
        els.feedbackInput.focus();
      }
      setHint('err', '提交失败：' + ((e && e.message) || '进程通信错误'));
    });
  }

  function doCancel() {
    doRespond(null);
  }

  /* ---------- 键盘 ---------- */
  document.addEventListener('keydown', function (e) {
    if (!state.ready || state.responded) return;
    if (e.isComposing) return; // 中文输入法组词期间不拦截

    // 反馈输入态：Esc 只返回选项列表，不取消
    if (state.feedbackMode) {
      if (e.key === 'Escape') {
        e.preventDefault();
        exitFeedbackMode();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        // textarea 内 Enter 不提交（应有提交按钮），仅 Ctrl+Enter 提交
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          submitFeedback();
        }
        return;
      }
      // 数字键在反馈输入态不拦截
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      doCancel();
      return;
    }

    // Ctrl-E：展开/收起详情区
    if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      toggleDetailExpand();
      return;
    }

    // 数字键 1-9 直选选项（输入控件 focus 时不拦截）
    var activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') {
      return; // 输入控件 focus 时不拦截数字键
    }
    var digit = parseInt(e.key, 10);
    if (digit >= 1 && digit <= 9 && digit <= state.optionBtns.length) {
      e.preventDefault();
      // 模拟对应按钮点击
      var targetBtn = state.optionBtns[digit - 1];
      if (targetBtn && !targetBtn.disabled) {
        targetBtn.click();
      }
    }
  });

  // Ctrl-E 切换 detail 展开/收起（普通审批与 ExitPlanMode 均适用）
  function toggleDetailExpand() {
    state.detailExpanded = !state.detailExpanded;
    if (state.isExitPlanMode && els.mdDetailWrap && !els.mdDetailWrap.hidden) {
      els.mdDetail.style.maxHeight = state.detailExpanded ? 'none' : '360px';
    } else if (els.detailWrap && !els.detailWrap.hidden) {
      els.detail.style.maxHeight = state.detailExpanded ? 'none' : DETAIL_COLLAPSED_HEIGHT + 'px';
    }
  }

  els.cancelBtn.addEventListener('click', doCancel);

  // 反馈按钮事件
  els.feedbackBackBtn.addEventListener('click', function () {
    exitFeedbackMode();
  });
  els.feedbackSubmitBtn.addEventListener('click', function () {
    submitFeedback();
  });

  /* ---------- 桥接事件 ---------- */
  function onInit(data) {
    var norm = normalize(data);
    state.ready = true;
    state.currentData = norm;
    els.loading.hidden = true;

    // 识别 ExitPlanMode
    state.isExitPlanMode = false;
    if (KcdPlan && typeof KcdPlan.isExitPlanMode === 'function') {
      state.isExitPlanMode = KcdPlan.isExitPlanMode(norm);
      // KcdPlan.isExitPlanMode 用 title 判定，但数据中 title 可能是 old payload 的 title（tctitle 截断 200）
      // 用 norm.toolTitle 补充检测（buildAcpPermissionPayload 新增透传字段）
      if (!state.isExitPlanMode && norm.toolTitle === 'ExitPlanMode') {
        state.isExitPlanMode = true;
      }
    } else if (norm.toolTitle === 'ExitPlanMode' || norm.title === 'ExitPlanMode') {
      // 无 KcdPlan 时的降级检测
      state.isExitPlanMode = true;
    }

    if (state.isExitPlanMode) {
      els.reqTitle.textContent = '计划审批';
      els.reqSub.textContent = 'Kimi 请求退出 Plan 模式，请选择操作。';
      els.kindChip.hidden = false;
      els.kindChip.textContent = '退出计划';

      // detail 区：Markdown 渲染（ExitPlanMode），非 pre
      els.detailWrap.hidden = true; // 隐藏普通 pre 详情
      renderMarkdownDetail(norm.detail);

      // 提示文案
      els.planHint.hidden = false;

      // 选项按钮
      renderOptions(norm.options, true);
    } else {
      els.reqTitle.textContent = norm.title || '未命名操作';
      els.kindChip.hidden = false;
      els.kindChip.textContent = kindLabel(norm.kind);

      renderDetail(norm.detail);
      renderOptions(norm.options, false);
    }

    renderLocations(norm.locations);

    if (norm.options.length === 0) {
      setHint('warn', '该请求未提供可选项，只能取消。');
    }

    els.req.hidden = false;
    // 默认焦点放在主按钮上，便于键盘操作；无选项时落到取消按钮
    if (!state.isExitPlanMode) {
      var primary = els.optBtns.querySelector('.btn-primary');
      (primary || state.optionBtns[0] || els.cancelBtn).focus({ preventScroll: true });
    } else {
      // ExitPlanMode：焦点给第一个非取消按钮
      (state.optionBtns[0] || els.cancelBtn).focus({ preventScroll: true });
    }
  }

  /* ---------- 启动 ---------- */
  if (!api) {
    els.loading.hidden = true;
    els.bridgeWarn.hidden = false;
    els.cancelBtn.disabled = true;
    showNotice('桥接不可用，无法加载审批请求。');
    return;
  }
  api.onInit(onInit);
})();
