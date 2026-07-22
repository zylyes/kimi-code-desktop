// Kimi Code Desktop — 问答窗口渲染逻辑
// 职责：渲染问题（单选/多选/自定义回答）、管理多题填写状态、校验、
// 通过 window.kimiQuestion 桥接回传 submit / fallback / cancel。
(function () {
  'use strict';

  var api = window.kimiQuestion || null;
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    counter: $('counter'),
    progress: $('progress'),
    bridgeWarn: $('bridgeWarn'),
    loading: $('loading'),
    main: $('main'),
    qcard: $('qcard'),
    qHeader: $('qHeader'),
    qText: $('qText'),
    qBody: $('qBody'),
    qKind: $('qKind'),
    options: $('options'),
    otherWrap: $('otherWrap'),
    otherInput: $('otherInput'),
    notice: $('notice'),
    hint: $('hint'),
    fallbackBtn: $('fallbackBtn'),
    prevBtn: $('prevBtn'),
    nextBtn: $('nextBtn'),
    mask: $('mask'),
    maskTitle: $('maskTitle'),
    maskSub: $('maskSub'),
    maskClose: $('maskClose'),
  };

  var OTHER = '__other__'; // “自定义回答”选项的占位值

  var state = {
    questionId: '',
    sessionId: '',
    questions: [],
    current: 0,
    answers: {},        // itemId -> { selected: string|null, checked: {}, other: bool, otherText: '' }
    currentInputs: [],  // 当前题可见输入框（用于数字键直选）
    submitting: false,
    dismissed: false,
    ready: false,
  };

  /* ---------- 数据规范化：容忍字段命名差异 ---------- */
  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

  function normalizeOption(o) {
    if (!o || typeof o !== 'object') return null;
    var label = str(o.label || o.text || o.title || o.name);
    var id = str(o.id != null ? o.id : (o.value != null ? o.value : label));
    if (!id && !label) return null;
    return { id: id || label, label: label || id, description: str(o.description || o.desc || '') };
  }

  function normalize(data) {
    var src = data && typeof data === 'object' ? data : {};
    var list = Array.isArray(src.questions) ? src.questions : [];
    var qs = [];
    for (var i = 0; i < list.length; i++) {
      var q = list[i] || {};
      var item = {
        id: str(q.id),
        header: str(q.header),
        question: str(q.question || q.title),
        body: str(q.body || q.detail),
        multi: !!(q.multi_select != null ? q.multi_select : (q.multiSelect != null ? q.multiSelect : q.multi)),
        allowOther: !!(q.allow_other != null ? q.allow_other : q.allowOther),
        options: [],
      };
      var opts = Array.isArray(q.options) ? q.options : [];
      for (var j = 0; j < opts.length; j++) {
        var no = normalizeOption(opts[j]);
        if (no) item.options.push(no);
      }
      if (item.id && item.question) qs.push(item);
    }
    return {
      questionId: str(src.question_id || src.questionId),
      sessionId: str(src.session_id || src.sessionId),
      questions: qs,
    };
  }

  /* ---------- 答案状态 ---------- */
  function getAns(q) {
    if (!state.answers[q.id]) {
      state.answers[q.id] = { selected: null, checked: {}, other: false, otherText: '' };
    }
    return state.answers[q.id];
  }

  // 该题是否已有有效答案
  function isAnswered(q) {
    var a = state.answers[q.id];
    if (!a) return false;
    var textOk = a.otherText.trim().length > 0;
    if (q.options.length === 0) {
      // 无可选项：退化为纯文本回答
      return textOk;
    }
    if (q.multi) {
      var anyChecked = Object.keys(a.checked).some(function (k) { return a.checked[k]; });
      if (a.other && !textOk) return false; // 勾了“自定义”但没写内容
      return anyChecked || (a.other && textOk);
    }
    if (a.selected == null) return false;
    if (a.selected === OTHER) return textOk;
    return true;
  }

  function firstUnanswered() {
    for (var i = 0; i < state.questions.length; i++) {
      if (!isAnswered(state.questions[i])) return i;
    }
    return -1;
  }

  function unansweredCount() {
    var n = 0;
    for (var i = 0; i < state.questions.length; i++) {
      if (!isAnswered(state.questions[i])) n++;
    }
    return n;
  }

  function canSubmit() {
    return state.questions.length > 0 && firstUnanswered() === -1;
  }

  /* ---------- 提示条 ---------- */
  function setHint(kind, msg) {
    els.hint.className = 'hint' + (kind ? ' ' + kind : '');
    els.hint.textContent = msg || '';
  }

  function refreshHint() {
    if (state.submitting || state.dismissed || !state.ready) return;
    if (state.questions.length === 0 || canSubmit() || state.current !== state.questions.length - 1) {
      setHint('', '');
      return;
    }
    if (state.questions.length > 1) {
      setHint('', '还有 ' + unansweredCount() + ' 题未作答');
    } else {
      setHint('', '请选择或填写答案后再提交');
    }
  }

  /* ---------- DOM 构造（一律 textContent，杜绝注入） ---------- */
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function buildOptionCard(q, opt, index, value, isOther) {
    var a = getAns(q);
    var card = el('label', 'opt' + (q.multi ? ' check' : ''));
    var input = el('input', 'sr-input');
    input.type = q.multi ? 'checkbox' : 'radio';
    input.name = 'q_' + state.current;
    input.value = value;
    input.id = 'opt-' + state.current + '-' + index;

    if (q.multi) {
      input.checked = isOther ? a.other : !!a.checked[value];
    } else {
      input.checked = a.selected === value;
    }

    var tick = el('span', 'tick');
    tick.setAttribute('aria-hidden', 'true');

    var main = el('span', 'opt-main');
    var label = el('span', 'opt-label');
    label.textContent = isOther ? '自定义回答' : opt.label;
    main.appendChild(label);
    if (isOther) {
      var od = el('span', 'opt-desc');
      od.textContent = q.multi ? '以上都不合适，自己填写（可多选并附加）' : '以上都不合适，自己填写';
      main.appendChild(od);
    } else if (opt.description) {
      var desc = el('span', 'opt-desc');
      desc.textContent = opt.description;
      main.appendChild(desc);
    }

    var num = el('span', 'opt-num');
    num.textContent = String(index + 1);
    num.setAttribute('aria-hidden', 'true');

    card.appendChild(input);
    card.appendChild(tick);
    card.appendChild(main);
    card.appendChild(num);

    input.addEventListener('change', function () { onOptionChange(q, value, isOther, input); });
    state.currentInputs.push({ input: input, value: value, isOther: isOther });
    return card;
  }

  function onOptionChange(q, value, isOther, input) {
    var a = getAns(q);
    if (q.multi) {
      if (isOther) {
        a.other = input.checked;
        syncOtherWrap(q);
        if (input.checked) els.otherInput.focus();
      } else {
        a.checked[value] = input.checked;
      }
    } else {
      a.selected = value;
      syncOtherWrap(q);
      if (isOther) els.otherInput.focus();
    }
    refresh();
  }

  // 控制自定义输入框显隐与可用性
  function syncOtherWrap(q) {
    var a = getAns(q);
    var active = q.options.length === 0 || (q.multi ? a.other : a.selected === OTHER);
    els.otherWrap.hidden = !active;
    els.otherInput.disabled = !active;
    if (!active && q.options.length > 0) {
      // 收起时不清空文本，用户切回时内容还在
    }
  }

  /* ---------- 渲染当前题 ---------- */
  function renderQuestion() {
    var q = state.questions[state.current];
    if (!q) return;
    state.currentInputs = [];

    els.qHeader.hidden = !q.header;
    if (q.header) els.qHeader.textContent = q.header;

    els.qText.textContent = q.question;

    els.qBody.hidden = !q.body;
    if (q.body) els.qBody.textContent = q.body;

    els.qKind.textContent = q.options.length === 0
      ? '填写文本回答'
      : (q.multi ? '多选 · 可选择多项' : '单选 · 选择一项');

    els.options.textContent = '';
    els.options.setAttribute('role', q.multi ? 'group' : 'radiogroup');
    els.options.setAttribute('aria-labelledby', 'qText');

    var idx = 0;
    q.options.forEach(function (opt) {
      els.options.appendChild(buildOptionCard(q, opt, idx, opt.id, false));
      idx++;
    });
    if (q.allowOther) {
      els.options.appendChild(buildOptionCard(q, null, idx, OTHER, true));
    }

    var a = getAns(q);
    els.otherInput.value = a.otherText;
    syncOtherWrap(q);

    // 重新触发入场动画
    els.qcard.style.animation = 'none';
    void els.qcard.offsetWidth;
    els.qcard.style.animation = '';
  }

  function renderProgress() {
    els.progress.textContent = '';
    if (state.questions.length < 2) {
      els.progress.hidden = true;
      return;
    }
    els.progress.hidden = false;
    state.questions.forEach(function (q, i) {
      var seg = el('button', 'seg');
      seg.type = 'button';
      var st = i === state.current ? 'current' : '';
      var done = isAnswered(q) ? 'done' : '';
      seg.className = 'seg' + (done ? ' ' + done : '') + (st ? ' ' + st : '');
      seg.setAttribute('aria-label',
        '第 ' + (i + 1) + ' 题' + (isAnswered(q) ? '，已作答' : '，未作答') + (i === state.current ? '，当前' : ''));
      if (i === state.current) seg.setAttribute('aria-current', 'step');
      seg.addEventListener('click', function () { goTo(i); });
      els.progress.appendChild(seg);
    });
  }

  function refresh() {
    var total = state.questions.length;
    els.counter.textContent = total > 0 ? (state.current + 1) + ' / ' + total : '';

    var last = state.current === total - 1;
    els.prevBtn.disabled = state.current === 0 || state.submitting;
    els.prevBtn.hidden = total < 2;
    if (!state.submitting) {
      els.nextBtn.textContent = last ? '提交回答' : '下一题';
    }
    els.nextBtn.disabled = state.submitting || (last && !canSubmit());
    els.nextBtn.setAttribute('aria-disabled', String(els.nextBtn.disabled));

    renderProgress();
    refreshHint();
  }

  function goTo(i) {
    if (i < 0 || i >= state.questions.length || state.submitting) return;
    state.current = i;
    renderQuestion();
    refresh();
    els.qText.focus({ preventScroll: true });
    els.main.scrollTop = 0;
  }

  /* ---------- 动作 ---------- */
  function ids() {
    return { question_id: state.questionId, session_id: state.sessionId };
  }

  function setBusy(on) {
    state.submitting = on;
    els.fallbackBtn.disabled = on;
    els.prevBtn.disabled = on || state.current === 0;
    els.nextBtn.disabled = on;
  }

  function buildAnswers() {
    var out = {};
    state.questions.forEach(function (q) {
      var a = getAns(q);
      var text = a.otherText.trim();
      if (q.options.length === 0) {
        out[q.id] = { kind: 'other', text: text };
        return;
      }
      if (q.multi) {
        var idsArr = q.options
          .filter(function (o) { return a.checked[o.id]; })
          .map(function (o) { return o.id; });
        if (idsArr.length === 0 && a.other) {
          out[q.id] = { kind: 'other', text: text };
        } else {
          var item = { kind: 'multi', option_ids: idsArr };
          if (a.other && text) item.other_text = text;
          out[q.id] = item;
        }
        return;
      }
      if (a.selected === OTHER) {
        out[q.id] = { kind: 'other', text: text };
      } else {
        out[q.id] = { kind: 'single', option_id: a.selected };
      }
    });
    return out;
  }

  function showNotice(text) {
    els.qcard.hidden = true;
    els.notice.hidden = false;
    els.notice.textContent = text;
  }

  function doSubmit() {
    if (!api || state.submitting || state.dismissed) return;
    var bad = firstUnanswered();
    if (bad >= 0) {
      goTo(bad);
      var q = state.questions[bad];
      var a = getAns(q);
      var needsText = q.options.length === 0 || (q.multi ? a.other : a.selected === OTHER);
      if (needsText && !a.otherText.trim()) {
        setHint('warn', q.options.length === 0 ? '请填写回答内容' : '请填写自定义回答的内容');
        els.otherInput.focus();
      } else {
        setHint('warn', q.multi ? '请至少选择一项' : '请选择一个选项');
      }
      return;
    }
    setBusy(true);
    setHint('', '正在提交…');
    var originalLabel = els.nextBtn.textContent;
    els.nextBtn.textContent = '';
    var sp = el('span', 'spinner');
    sp.setAttribute('aria-hidden', 'true');
    els.nextBtn.appendChild(sp);
    els.nextBtn.appendChild(document.createTextNode('正在提交…'));

    api.submit(Object.assign(ids(), { answers: buildAnswers() }))
      .then(function (res) {
        if (res && res.ok === false) {
          els.nextBtn.textContent = originalLabel;
          setBusy(false);
          refresh();
          setHint('err', '提交失败：' + (res.message || '未知错误'));
          return;
        }
        // 成功：等待主进程关闭窗口
        setHint('ok', '回答已提交');
        showNotice('回答已提交，此窗口即将关闭。');
        els.fallbackBtn.disabled = true;
        els.prevBtn.disabled = true;
        els.nextBtn.disabled = true;
      })
      .catch(function (e) {
        els.nextBtn.textContent = originalLabel;
        setBusy(false);
        refresh();
        setHint('err', '提交失败：' + ((e && e.message) || '网络或进程错误'));
      });
  }

  function doFallback() {
    if (!api || state.submitting || state.dismissed) return;
    setBusy(true);
    setHint('', '正在打开 Kimi…');
    api.fallback(ids())
      .then(function (res) {
        if (res && res.ok === false) {
          setBusy(false);
          refresh();
          setHint('err', res.message || '打开 Kimi 失败');
        }
      })
      .catch(function () {
        setBusy(false);
        refresh();
        setHint('err', '打开 Kimi 失败，请稍后重试');
      });
  }

  function doCancel() {
    if (!api || state.submitting || state.dismissed) return;
    api.cancel(ids()).catch(function () {});
  }

  function onPrimary() {
    if (state.current < state.questions.length - 1) {
      goTo(state.current + 1);
    } else {
      doSubmit();
    }
  }

  /* ---------- 键盘 ---------- */
  function isTypingTarget(t) {
    if (!t) return false;
    var tag = t.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT' && (t.type === 'text' || t.type === 'search' || t.type === 'url' || t.type === 'password')) return true;
    return !!t.isContentEditable;
  }

  document.addEventListener('keydown', function (e) {
    if (!state.ready || state.dismissed) return;
    if (e.isComposing) return; // 中文输入法组词期间不拦截

    if (e.key === 'Escape') {
      e.preventDefault();
      doCancel();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onPrimary();
      return;
    }
    // 数字键 1-9 直选当前题选项（输入框聚焦时不拦截）
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
      var i = parseInt(e.key, 10) - 1;
      if (i < state.currentInputs.length) {
        e.preventDefault();
        var entry = state.currentInputs[i];
        if (entry.input.type === 'checkbox') {
          entry.input.checked = !entry.input.checked;
        } else {
          entry.input.checked = true;
        }
        entry.input.focus();
        // onOptionChange 中“自定义回答”会把焦点移到文本框，放在其后调用
        onOptionChange(state.questions[state.current], entry.value, entry.isOther, entry.input);
      }
    }
  });

  els.otherInput.addEventListener('input', function () {
    var q = state.questions[state.current];
    if (!q) return;
    getAns(q).otherText = els.otherInput.value;
    refresh();
  });

  els.otherInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      onPrimary();
    }
  });

  els.prevBtn.addEventListener('click', function () { goTo(state.current - 1); });
  els.nextBtn.addEventListener('click', onPrimary);
  els.fallbackBtn.addEventListener('click', doFallback);
  els.maskClose.addEventListener('click', function () { window.close(); });

  /* ---------- 桥接事件 ---------- */
  function onDismiss(info) {
    if (state.dismissed) return;
    state.dismissed = true;
    var reason = info && typeof info.reason === 'string' ? info.reason : '';
    els.maskTitle.textContent = reason === 'answered' ? '该问题已被回答' : '该问题已关闭';
    els.maskSub.textContent = '它可能已在其他地方得到处理，此窗口即将自动关闭。';
    els.mask.hidden = false;
    els.maskClose.focus();
  }

  function onInit(data) {
    var norm = normalize(data);
    state.questionId = norm.questionId;
    state.sessionId = norm.sessionId;
    state.questions = norm.questions;
    state.ready = true;
    els.loading.hidden = true;

    if (state.questions.length === 0) {
      showNotice('问题数据为空或格式不正确，请点击下方“在 Kimi 中回答”继续。');
      els.counter.textContent = '';
      els.prevBtn.hidden = true;
      els.nextBtn.hidden = true;
      setHint('', '');
      return;
    }

    els.qcard.hidden = false;
    renderQuestion();
    refresh();
    els.qText.focus({ preventScroll: true });
  }

  /* ---------- 启动 ---------- */
  if (!api) {
    els.loading.hidden = true;
    els.bridgeWarn.hidden = false;
    els.fallbackBtn.disabled = true;
    els.prevBtn.disabled = true;
    els.nextBtn.disabled = true;
    showNotice('桥接不可用，无法加载问题。');
    return;
  }
  api.onInit(onInit);
  api.onDismiss(onDismiss);
})();
