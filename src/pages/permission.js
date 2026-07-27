// Kimi Code Desktop — 权限审批窗口渲染逻辑
// 职责：展示 ACP 工具调用的审批请求（标题 / 类型徽标 / 详情 / 相关文件），
// 由 options 生成按钮组，通过 window.kimiPermission 桥接回传选择结果或取消。
(function () {
  'use strict';

  var api = window.kimiPermission || null;
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    kindChip: $('kindChip'),
    bridgeWarn: $('bridgeWarn'),
    loading: $('loading'),
    req: $('req'),
    reqTitle: $('reqTitle'),
    detailWrap: $('detailWrap'),
    detail: $('detail'),
    detailTrunc: $('detailTrunc'),
    locsWrap: $('locsWrap'),
    locs: $('locs'),
    notice: $('notice'),
    hint: $('hint'),
    cancelBtn: $('cancelBtn'),
    optBtns: $('optBtns'),
  };

  var TITLE_MAX = 300;     // 工具标题防御性截断
  var KIND_MAX = 40;       // 类型徽标文本上限
  var DETAIL_MAX = 4000;   // 详情区字符上限（主进程已预截断，此处再兜底）
  var NAME_MAX = 80;       // 选项按钮文案上限
  var ID_MAX = 200;        // optionId 上限
  var PATH_MAX = 500;      // 单条路径上限
  var LOCATIONS_MAX = 50;  // 路径条数上限
  var OPTIONS_MAX = 20;    // 选项个数上限

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

  /* ---------- 渲染（动态文本一律 textContent，杜绝注入） ---------- */
  function kindLabel(kind) {
    return KIND_LABELS[kind] || kind || '其他';
  }

  // 选项类型 → 按钮样式：allow_once 主按钮、allow_always 次按钮、拒绝类警示色
  function btnClassFor(kind) {
    if (kind === 'allow_once') return 'btn btn-primary';
    if (kind === 'allow_always') return 'btn btn-secondary';
    if (kind === 'reject_once' || kind === 'reject_always') return 'btn btn-danger';
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

  function renderOptions(options) {
    els.optBtns.textContent = '';
    state.optionBtns = [];
    options.forEach(function (opt) {
      var btn = el('button', btnClassFor(opt.kind));
      btn.type = 'button';
      btn.textContent = opt.name;
      btn.addEventListener('click', function () { doRespond(opt.optionId); });
      els.optBtns.appendChild(btn);
      state.optionBtns.push(btn);
    });
  }

  function setAllDisabled(on) {
    els.cancelBtn.disabled = on;
    for (var i = 0; i < state.optionBtns.length; i++) {
      state.optionBtns[i].disabled = on;
    }
  }

  function showNotice(text) {
    els.req.hidden = true;
    els.notice.hidden = false;
    els.notice.textContent = text;
  }

  /* ---------- 动作 ---------- */
  function doRespond(optionId) {
    if (!api || state.responded) return;
    state.responded = true;
    setAllDisabled(true);
    setHint('', optionId == null ? '已取消，窗口即将关闭…' : '已提交选择，窗口即将关闭…');
    api.respond(optionId).catch(function (e) {
      // 提交失败：恢复可操作状态，允许重试（主进程侧对重复响应有幂等保护）
      state.responded = false;
      setAllDisabled(false);
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
    if (e.key === 'Escape') {
      e.preventDefault();
      doCancel();
    }
  });

  els.cancelBtn.addEventListener('click', doCancel);

  /* ---------- 桥接事件 ---------- */
  function onInit(data) {
    var norm = normalize(data);
    state.ready = true;
    els.loading.hidden = true;

    els.reqTitle.textContent = norm.title || '未命名操作';
    els.kindChip.hidden = false;
    els.kindChip.textContent = kindLabel(norm.kind);

    renderDetail(norm.detail);
    renderLocations(norm.locations);
    renderOptions(norm.options);

    if (norm.options.length === 0) {
      setHint('warn', '该请求未提供可选项，只能取消。');
    }

    els.req.hidden = false;
    // 默认焦点放在主按钮上，便于键盘操作；无选项时落到取消按钮
    var primary = els.optBtns.querySelector('.btn-primary');
    (primary || state.optionBtns[0] || els.cancelBtn).focus({ preventScroll: true });
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
