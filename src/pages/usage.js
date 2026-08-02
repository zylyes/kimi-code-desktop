/**
 * usage.js —— 用量统计面板
 *
 * 数据：window.kimiDesktop.getUsageSnapshot() → { ok, kind:'usage', data, error? }
 * data = { contextWindow, sessionUsage, managed, trends, errors }
 * 字段形状以主进程为准（src/main/managed-usage.js、src/main/usage-stats.js）：
 * - contextWindow: { used, limit, source? } | null
 * - sessionUsage:  { inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, totalTokens? } | null
 * - managed: { kind:'ok'|'unavailable'|'auth-required'|'error',
 *              plans:[{ id, label, used, limit, resetAt }],   // used/limit 为平台十进制数
 *              wallet:{ currency, balanceMinor, monthlyUsedMinor, monthlyLimitMinor } | null, // 金额单位为分
 *              fetchedAt, staleAt, message? } | null           // staleAt < Date.now() 即可能过期
 * - trends[range]: { summary:{ requests, inputOther, output, inputCacheRead, inputCacheCreation, totalTokens, partial? },
 *                    series:[{ key:'HH'|'YYYY-MM-DD', ... }],  // today 按小时，7d/30d 按日，空桶已补零
 *                    byModel:[{ model, requests, inputOther, output, inputCacheRead, inputCacheCreation, totalTokens }],
 *                    diagnostics:{ partial, reason? } }        // range ∈ today/7d/30d
 * - errors: [{ source, message }]（allSettled 部分失败，非空时顶部警示但不阻断已得数据）
 *
 * 行为：60s 自动刷新（页面隐藏时暂停、回前台立即刷一次）；手动刷新带 loading 态；
 * 请求序号递增防竞态；首次加载三态（loading/失败/内容），之后静默刷新原地更新、失败保留旧数据。
 * 全部动态文本经 textContent 写入，不拼 HTML。
 */
(function () {
  'use strict';

  var api = window.kimiDesktop;
  function $(id) { return document.getElementById(id); }

  var topbarSub = $('topbarSub');
  var refreshBtn = $('refreshBtn');
  var bridgeWarn = $('bridgeWarn');
  var stateLoading = $('stateLoading');
  var stateError = $('stateError');
  var failMsg = $('failMsg');
  var retryBtn = $('retryBtn');
  var dashboard = $('dashboard');
  var errorsBar = $('errorsBar');
  var gridTop = $('gridTop');
  var staleBadge = $('staleBadge');
  var heroBody = $('heroBody');
  var plansCard = $('plansCard');
  var plansBody = $('plansBody');
  var trendTabs = $('trendTabs');
  var trendBody = $('trendBody');
  var modelsNote = $('modelsNote');
  var modelsBody = $('modelsBody');
  var sessionBody = $('sessionBody');

  var loadSeq = 0; // 请求序号：新请求取代旧请求，旧序号结果到达即丢弃
  var trendRange = 'today'; // 趋势时段选中，跨刷新保留
  var lastData = null; // 最近一次成功数据（切换时段标签重绘用）
  var autoTimer = null; // 60s 自动刷新定时器
  var hasShown = false; // 是否已成功展示过内容（区分首次加载与静默刷新）

  var AUTO_MS = 60000;
  var RANGE_LABEL = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' };
  var TAB_DEFS = [['today', '今天'], ['7d', '7 天'], ['30d', '30 天']];

  /* ---------------- 小工具 ---------------- */
  // 建节点（类名 + 文本，text 省略时纯元素）
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

  // 千位逗号完整值（悬浮 title 用）
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

  function posNum(v) {
    var n = Number(v);
    return Number.isFinite(n) && n > 0;
  }

  // 百分比（0-100，非法输入归 0，保证不产生 NaN）
  function pctOf(used, limit) {
    var l = Number(limit);
    if (!Number.isFinite(l) || l <= 0) return 0;
    var p = (Number(used) / l) * 100;
    if (!Number.isFinite(p)) return 0;
    return Math.min(100, Math.max(0, p));
  }

  // 套餐标签中文化（主进程 planLabel 产出 'Weekly limit' / '5h limit' / '7d limit'，未知原样）
  function planName(label) {
    var s = String(label || '额度');
    if (s === 'Weekly limit') return '每周额度';
    var m = /^(\d+(?:\.\d+)?)h limit$/.exec(s);
    if (m) return m[1] + ' 小时额度';
    m = /^(\d+(?:\.\d+)?)d limit$/.exec(s);
    if (m) return m[1] + ' 天额度';
    return s;
  }

  // 进度条（used/limit）：带 aria；pct ≥90 时 fill 转 error 色
  function meter(used, limit, label) {
    var wrap = el('div', 'meter');
    var fill = el('div', 'meter-fill');
    var pct = pctOf(used, limit);
    fill.style.width = pct.toFixed(1) + '%';
    if (pct >= 90) fill.classList.add('hot');
    wrap.setAttribute('role', 'progressbar');
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '100');
    wrap.setAttribute('aria-valuenow', String(Math.round(pct)));
    if (label) wrap.setAttribute('aria-label', label);
    wrap.appendChild(fill);
    return { wrap: wrap, pct: pct };
  }

  // 「名 + 等宽值」小段（值带完整数字 title）
  function statChip(name, value, unit) {
    var item = el('span', 'stat');
    item.appendChild(el('span', 'stat-k', name));
    var v = el('span', 'stat-v', fmtTokens(value));
    v.title = fmtFull(value) + (unit ? ' ' + unit : '');
    item.appendChild(v);
    return item;
  }

  /* ---------------- 余额 hero ---------------- */
  function renderHero(managed) {
    heroBody.textContent = '';
    staleBadge.hidden = true;
    if (!managed || typeof managed !== 'object') {
      heroBody.appendChild(el('div', 'hero-empty', '平台额度数据这次没有返回，不影响下面的本地用量统计。'));
      return;
    }
    var stale = Number(managed.staleAt) > 0 && Number(managed.staleAt) < Date.now();
    staleBadge.hidden = !stale;

    if (managed.kind === 'auth-required') {
      heroBody.appendChild(el('div', 'hero-empty', '登录后才能查看钱包余额和套餐额度。'));
      if (api && typeof api.showSetup === 'function') {
        var btn = el('button', 'btn btn-primary hero-action', '去登录');
        btn.type = 'button';
        btn.addEventListener('click', function () {
          try { api.showSetup(); } catch (e) { /* 桥接异常忽略 */ }
        });
        heroBody.appendChild(btn);
      } else {
        heroBody.appendChild(el('div', 'hero-empty', '请打开「设置」完成登录。'));
      }
      heroBody.appendChild(el('div', 'hero-foot', '本地用量统计不受影响，见下方。'));
      return;
    }
    if (managed.kind === 'unavailable') {
      heroBody.appendChild(el('div', 'hero-empty', '当前登录方式查不到平台余额和套餐额度。'));
      heroBody.appendChild(el('div', 'hero-foot', '本地用量统计不受影响，见下方。'));
      return;
    }
    if (managed.kind === 'error') {
      heroBody.appendChild(el('div', 'hero-empty err',
        '平台余额查询失败' + (managed.message ? '：' + managed.message : '')));
      heroBody.appendChild(el('div', 'hero-foot', '过一会儿点右上角「刷新」重试。'));
      return;
    }

    // kind === 'ok'
    var wallet = managed.wallet && typeof managed.wallet === 'object' ? managed.wallet : null;
    if (!wallet) {
      heroBody.appendChild(el('div', 'hero-empty', '这个账号还没有钱包余额。'));
    } else {
      heroBody.appendChild(el('div', 'hero-amount', fmtMoney(wallet.balanceMinor, wallet.currency)));
      if (posNum(wallet.monthlyLimitMinor)) {
        var m = meter(wallet.monthlyUsedMinor, wallet.monthlyLimitMinor, '本月费用');
        heroBody.appendChild(m.wrap);
        heroBody.appendChild(el('div', 'hero-sub',
          '本月已用 ' + fmtMoney(wallet.monthlyUsedMinor, wallet.currency) +
          ' / 上限 ' + fmtMoney(wallet.monthlyLimitMinor, wallet.currency) +
          '（' + Math.round(m.pct) + '%）'));
      } else if (posNum(wallet.monthlyUsedMinor)) {
        heroBody.appendChild(el('div', 'hero-sub',
          '本月已用 ' + fmtMoney(wallet.monthlyUsedMinor, wallet.currency) + '（未设上限）'));
      } else {
        heroBody.appendChild(el('div', 'hero-sub', '本月还没有产生费用'));
      }
    }
    if (Number(managed.fetchedAt) > 0) {
      heroBody.appendChild(el('div', 'hero-foot',
        '数据更新于 ' + fmtClock(managed.fetchedAt) + (stale ? '，可能不是最新' : '')));
    }
  }

  /* ---------------- 套餐 plans（仅 managed.kind === 'ok' 时展示，其余整卡隐藏） ---------------- */
  function renderPlans(managed) {
    plansBody.textContent = '';
    var show = !!(managed && managed.kind === 'ok');
    plansCard.hidden = !show;
    gridTop.classList.toggle('single', !show);
    if (!show) return;
    var plans = Array.isArray(managed.plans) ? managed.plans : [];
    if (plans.length === 0) {
      plansBody.appendChild(el('div', 'empty', '暂无套餐额度数据'));
      return;
    }
    for (var i = 0; i < plans.length; i++) {
      var plan = plans[i];
      if (!plan || typeof plan !== 'object') continue;
      var pw = el('div', 'plan');
      var head = el('div', 'plan-head');
      head.appendChild(el('span', 'plan-label', planName(plan.label)));
      var hasLimit = Number(plan.limit) > 0;
      var val = fmtAmount(plan.used) + ' / ' + fmtAmount(plan.limit);
      if (hasLimit) {
        val += '（' + Math.round(pctOf(plan.used, plan.limit)) + '%）';
      }
      head.appendChild(el('span', 'plan-val', val));
      pw.appendChild(head);
      if (hasLimit) pw.appendChild(meter(plan.used, plan.limit, planName(plan.label)).wrap);
      var reset = fmtReset(plan.resetAt);
      if (reset) pw.appendChild(el('div', 'plan-foot', reset + ' 重置'));
      plansBody.appendChild(pw);
    }
  }

  /* ---------------- 趋势 + 分模型明细（联动时段标签） ---------------- */
  // 趋势柱标签：today 的 key 为 'HH'，7d/30d 的 key 为 'YYYY-MM-DD'
  function bucketLabel(key, range) {
    if (range === 'today') return key + ':00';
    var parts = String(key).split('-');
    return parts.length === 3 ? Number(parts[1]) + '-' + Number(parts[2]) : String(key);
  }

  function renderModels(list) {
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b && typeof b === 'object') rows.push(b);
    }
    rows.sort(function (a, b2) { return (Number(b2.totalTokens) || 0) - (Number(a.totalTokens) || 0); });
    if (rows.length === 0) {
      modelsBody.appendChild(el('div', 'empty', '这个时段没有分模型记录'));
      return;
    }
    var wrap = el('div', 'mtable-wrap');
    var t = el('div', 'mtable');
    var heads = [
      ['模型', 'name'], ['请求', ''], ['输入', ''], ['输出', ''],
      ['缓存读取', 'col-cache'], ['缓存写入', 'col-cache'], ['合计', ''],
    ];
    for (var h = 0; h < heads.length; h++) {
      t.appendChild(el('div', ('th ' + heads[h][1]).trim(), heads[h][0]));
    }
    for (var r = 0; r < rows.length; r++) {
      var mb = rows[r];
      var name = el('div', 'td name', mb.model || 'unknown');
      name.title = mb.model || 'unknown';
      t.appendChild(name);
      t.appendChild(el('div', 'td', fmtFull(mb.requests)));
      t.appendChild(el('div', 'td', fmtTokens(mb.inputOther)));
      t.appendChild(el('div', 'td', fmtTokens(mb.output)));
      t.appendChild(el('div', 'td col-cache', fmtTokens(mb.inputCacheRead)));
      t.appendChild(el('div', 'td col-cache', fmtTokens(mb.inputCacheCreation)));
      var total = el('div', 'td total', fmtTokens(mb.totalTokens));
      total.title = '输入 ' + fmtFull(mb.inputOther) + ' · 输出 ' + fmtFull(mb.output) +
        ' · 缓存读取 ' + fmtFull(mb.inputCacheRead) + ' · 缓存写入 ' + fmtFull(mb.inputCacheCreation);
      t.appendChild(total);
    }
    wrap.appendChild(t);
    modelsBody.appendChild(wrap);
    modelsBody.appendChild(el('div', 'trend-note', '共 ' + rows.length + ' 个模型，按合计 tokens 从高到低排'));
  }

  function renderTrendAndModels() {
    trendBody.textContent = '';
    modelsBody.textContent = '';
    for (var i = 0; i < trendTabs.children.length; i++) {
      var b = trendTabs.children[i];
      var on = b.getAttribute('data-range') === trendRange;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    modelsNote.textContent = RANGE_LABEL[trendRange] || '';

    var trends = lastData && lastData.trends && typeof lastData.trends === 'object' ? lastData.trends : null;
    var snap = trends ? trends[trendRange] : null;
    if (!snap || !Array.isArray(snap.series)) {
      trendBody.appendChild(el('div', 'empty', '这个时间段还没有用量数据'));
      modelsBody.appendChild(el('div', 'empty', '这个时段没有分模型记录'));
      return;
    }

    var s = snap.summary && typeof snap.summary === 'object' ? snap.summary : {};
    var sum = el('div', 'sum-line');
    sum.appendChild(document.createTextNode('合计 '));
    sum.appendChild(el('span', 'n', fmtTokens(s.totalTokens)));
    sum.appendChild(document.createTextNode(' tokens · '));
    sum.appendChild(el('span', 'n', fmtFull(s.requests)));
    sum.appendChild(document.createTextNode(' 次请求'));
    trendBody.appendChild(sum);

    var line = el('div', 'stat-line');
    line.appendChild(statChip('输入', s.inputOther, 'tokens'));
    line.appendChild(statChip('输出', s.output, 'tokens'));
    line.appendChild(statChip('缓存读取', s.inputCacheRead, 'tokens'));
    line.appendChild(statChip('缓存写入', s.inputCacheCreation, 'tokens'));
    trendBody.appendChild(line);

    var max = 0;
    var j;
    for (j = 0; j < snap.series.length; j++) {
      var bk = snap.series[j];
      if (bk && Number(bk.totalTokens) > max) max = Number(bk.totalTokens);
    }
    var bars = el('div', 'bars');
    bars.setAttribute('role', 'img');
    bars.setAttribute('aria-label', (RANGE_LABEL[trendRange] || '') + '各时段用量条形图，悬停查看数值');
    for (j = 0; j < snap.series.length; j++) {
      var bkt = snap.series[j] || {};
      var v = Number(bkt.totalTokens) || 0;
      var partial = bkt.partial === true;
      var bar = el('div', v > 0 ? (partial ? 'bar has partial' : 'bar has') : 'bar');
      bar.style.height = v > 0 && max > 0 ? Math.max(6, (v / max) * 100).toFixed(1) + '%' : '2px';
      bar.title = bucketLabel(bkt.key, trendRange) + '：' + fmtFull(v) + ' tokens' +
        (partial ? '（数据不完整）' : '');
      bars.appendChild(bar);
    }
    trendBody.appendChild(bars);

    if (snap.series.length > 0) {
      var axis = el('div', 'axis');
      axis.appendChild(el('span', '', bucketLabel(snap.series[0].key, trendRange)));
      axis.appendChild(el('span', '', bucketLabel(snap.series[snap.series.length - 1].key, trendRange)));
      trendBody.appendChild(axis);
    }

    var diag = snap.diagnostics && typeof snap.diagnostics === 'object' ? snap.diagnostics : {};
    if (diag.partial || s.partial) {
      var reason = diag.reason === 'session-scope-only'
        ? '只有会话累计记录，算不出分时段用量'
        : (diag.reason ? String(diag.reason) : '部分记录解析失败');
      trendBody.appendChild(el('div', 'trend-note', '数据不完整：' + reason));
    }

    renderModels(Array.isArray(snap.byModel) ? snap.byModel : []);
  }

  /* ---------------- 当前会话（上下文窗口 + 会话 token 明细） ---------------- */
  function renderSession(cw, su) {
    sessionBody.textContent = '';
    var has = false;

    if (cw && Number(cw.limit) > 0) {
      has = true;
      var srcNote = cw.source === 'session' ? ' · 当前会话' : (cw.source ? ' · 最近同步快照' : '');
      var b1 = el('div', 'sub-block');
      b1.appendChild(el('div', 'sub-title', '上下文窗口' + srcNote));
      var m = meter(cw.used, cw.limit, '上下文窗口');
      b1.appendChild(m.wrap);
      var line = el('div', 'ctx-line',
        fmtTokens(cw.used) + ' / ' + fmtTokens(cw.limit) + '（' + Math.round(m.pct) + '%）');
      line.title = fmtFull(cw.used) + ' / ' + fmtFull(cw.limit) + ' tokens';
      b1.appendChild(line);
      sessionBody.appendChild(b1);
    }

    var chips = [];
    if (su && typeof su === 'object') {
      if (posNum(su.inputTokens)) chips.push(['输入', su.inputTokens]);
      if (posNum(su.outputTokens)) chips.push(['输出', su.outputTokens]);
      if (posNum(su.cacheReadTokens)) chips.push(['缓存读取', su.cacheReadTokens]);
      if (posNum(su.cacheWriteTokens)) chips.push(['缓存写入', su.cacheWriteTokens]);
      if (posNum(su.totalTokens)) chips.push(['合计', su.totalTokens]);
    }
    if (chips.length > 0) {
      has = true;
      var b2 = el('div', 'sub-block');
      b2.appendChild(el('div', 'sub-title', '本会话 Token 累计'));
      var sl = el('div', 'stat-line');
      for (var i = 0; i < chips.length; i++) {
        sl.appendChild(statChip(chips[i][0], chips[i][1], 'tokens'));
      }
      b2.appendChild(sl);
      sessionBody.appendChild(b2);
    }

    if (!has) sessionBody.appendChild(el('div', 'empty', '当前会话还没有用量数据'));
  }

  /* ---------------- 部分失败警示条 ---------------- */
  function renderErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      errorsBar.textContent = '';
      errorsBar.hidden = true;
      return;
    }
    var parts = [];
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i] || {};
      parts.push((e.source || e.part || '未知') + '：' + (e.message || '获取失败'));
    }
    errorsBar.textContent = '有些数据没拿到（' + parts.join('；') + '），下面显示的是成功获取的部分。';
    errorsBar.hidden = false;
  }

  /* ---------------- 总渲染 ---------------- */
  function renderAll(data) {
    renderErrors(data.errors);
    renderHero(data.managed);
    renderPlans(data.managed);
    renderTrendAndModels();
    renderSession(data.contextWindow, data.sessionUsage);
  }

  /* ---------------- 加载与刷新 ---------------- */
  function setRefreshing(on) {
    refreshBtn.disabled = on;
    refreshBtn.textContent = '';
    if (on) {
      var sp = el('span', 'spinner');
      sp.setAttribute('aria-hidden', 'true');
      refreshBtn.appendChild(sp);
      refreshBtn.appendChild(document.createTextNode('刷新'));
    } else {
      refreshBtn.textContent = '刷新';
    }
  }

  function resErrorMessage(res) {
    if (res && typeof res === 'object') {
      if (res.error && typeof res.error === 'object' && res.error.message) return String(res.error.message);
      if (typeof res.error === 'string' && res.error) return res.error;
      if (typeof res.message === 'string' && res.message) return res.message;
    }
    return '未知错误';
  }

  async function load() {
    if (!api || typeof api.getUsageSnapshot !== 'function') return;
    var mySeq = ++loadSeq;
    setRefreshing(true);
    try {
      var res = await api.getUsageSnapshot();
      if (mySeq !== loadSeq) return; // 已被新请求取代，丢弃
      if (!res || res.ok === false) throw new Error(resErrorMessage(res));
      var data = res.data && typeof res.data === 'object' ? res.data : {};
      lastData = data;
      hasShown = true;
      stateLoading.hidden = true;
      stateError.hidden = true;
      dashboard.hidden = false;
      renderAll(data);
      topbarSub.textContent = '更新于 ' + fmtClock(Date.now());
    } catch (e) {
      if (mySeq !== loadSeq) return;
      var text = (e && e.message) || String(e || '未知错误');
      if (!hasShown) {
        // 首次加载失败：整页失败态
        stateLoading.hidden = true;
        dashboard.hidden = true;
        stateError.hidden = false;
        failMsg.textContent = text;
      } else {
        // 静默刷新失败：保留旧数据，警示条提示
        errorsBar.textContent = '这次刷新没成功（' + text + '），页面还是 ' +
          (topbarSub.textContent || '上次').replace('更新于 ', '') + ' 的数据。';
        errorsBar.hidden = false;
      }
    } finally {
      if (mySeq === loadSeq) setRefreshing(false);
    }
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(function () {
      if (!document.hidden) load();
    }, AUTO_MS);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  /* ---------------- 自绘窗控按钮（最小化 / 最大化 / 关闭） ---------------- */
  // 视觉复刻 menu-panel.js 的 ☰（38×32 透明钮 + 15×15 SVG 线条图标），样式类 .kcd-win-btn 见 usage.html。
  // 顺序保证：menu-panel.js 与本脚本均为 defer 且 menu-panel 在前，☰ 先挂载到 .app-topbar-actions 末尾，
  // 此处 append 自然位于 ☰ 右侧（…刷新、☰、min、max、close）。
  var WIN_BTN_DEFS = [
    ['minimize', '最小化',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>'],
    ['toggle-maximize', '最大化',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12"></rect></svg>'],
    ['close', '关闭',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>'],
  ];

  function buildWinControls() {
    var actions = document.querySelector('.app-topbar-actions');
    if (!actions) return;
    var wrap = el('div', 'win-controls');
    for (var i = 0; i < WIN_BTN_DEFS.length; i++) {
      var def = WIN_BTN_DEFS[i];
      var btn = el('button', 'kcd-win-btn');
      btn.type = 'button';
      btn.title = def[1];
      btn.setAttribute('aria-label', def[1]);
      btn.setAttribute('data-action', def[0]);
      // 静态 SVG 图标常量（无任何动态内容拼接），与 menu-panel.js 挂 ☰ 图标同款手法
      btn.innerHTML = def[2];
      btn.addEventListener('click', function () {
        var action = this.getAttribute('data-action');
        try {
          if (api && typeof api.windowControl === 'function') {
            var p = api.windowControl(action);
            if (p && typeof p.catch === 'function') p.catch(function () { /* IPC 失败静默 */ });
          }
        } catch (e) { /* 桥接异常静默忽略 */ }
      });
      wrap.appendChild(btn);
    }
    actions.appendChild(wrap);
  }

  /* ---------------- 初始化 ---------------- */
  function buildTabs() {
    for (var i = 0; i < TAB_DEFS.length; i++) {
      var tab = el('button', 'tab', TAB_DEFS[i][1]);
      tab.type = 'button';
      tab.setAttribute('data-range', TAB_DEFS[i][0]);
      tab.setAttribute('aria-pressed', TAB_DEFS[i][0] === trendRange ? 'true' : 'false');
      tab.addEventListener('click', function () {
        var range = this.getAttribute('data-range');
        if (!range || range === trendRange) return;
        trendRange = range;
        renderTrendAndModels();
      });
      trendTabs.appendChild(tab);
    }
  }

  // 窗控按钮无桥也照常渲染（点击静默），故在桥接检查之前挂载
  buildWinControls();

  if (!api || typeof api.getUsageSnapshot !== 'function') {
    bridgeWarn.hidden = false;
    refreshBtn.disabled = true;
    stateLoading.hidden = true;
    stateError.hidden = false;
    failMsg.textContent = '桥接接口不可用（window.kimiDesktop.getUsageSnapshot 不存在）';
    return;
  }

  refreshBtn.addEventListener('click', load);
  retryBtn.addEventListener('click', load);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopAuto();
    } else {
      load(); // 回到前台立即刷一次，并重启自动刷新
      startAuto();
    }
  });

  buildTabs();
  load();
  startAuto();
})();
