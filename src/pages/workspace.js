/* workspace.js —— 工作区面板（M2 骨架 + M3 Changes/Files + M4 Agents/Tasks 只读投影）
 *
 * 仅通过 window.workspace 桥与主进程通信（contextIsolation，无 Node API）：
 * - 头部：getContext() 三态渲染，onEvent({kind:'context'}) 立即刷新；
 * - Changes：getChanges() 列表 + getDiff() 行内展开；Files：listFiles() 懒加载目录树
 *   + readFile() 底部抽屉预览；
 * - Agents/Tasks：getProjection() 一次性拉取会话快照（agents 树 + tasks 目录），
 *   只读展示，无任何控制按钮；onEvent kind:'activities'（payload.sessionId 匹配
 *   当前 bound 会话才生效）短防抖后重拉投影；
 * - 标签首屏数据切到才加载（不预加载），切回用缓存并后台刷新；
 * - onEvent kind:'refresh' → 3s 防抖后重取当前激活标签数据；
 * - 初始化只落定激活标签的 ARIA/视觉状态：首个 getContext 成功/失败定型前，
 *   Changes/Files 一律不发数据请求；
 * - context 刷新一开始（首个初始化与 onEvent kind:'context'；主进程仅在导航
 *   fingerprint/候选选择导致身份可能变化时发送）即按潜在身份切换处理：
 *   contextGeneration 立即递增作废全部在途数据请求，同步清空 Changes/Files/
 *   diff/预览/loadedTabs 与旧 DOM、取消待触发防抖，contextReady 落下——
 *   getContext 落地前不发新数据请求（此间切标签只切视觉）；
 * - getContext 成功才建立新的非 null contextKey（sessionId+workDir，未绑定态
 *   用稳定占位）、渲染头部并立即重载当前标签（不走防抖）；失败建立稳定非 null
 *   失败键（unbound:context-error）同样定型放行——后续数据请求永远无法以
 *   null key 提交；contextRequestSeq 单调递增，乱序/迟到的旧响应与旧异常整体丢弃；
 * - onEvent kind:'refresh'（同身份 focus）→ 仅 3s 防抖重取当前标签，绝不清空数据；
 * - 所有异步桥调用发起时捕获 contextGeneration + contextKey，提交结果前严格核对
 *   （key===null 一律判 stale，无放行通道），过期响应直接丢弃，杜绝旧会话数据
 *   写回新会话；
 * - M6 overlay 关闭安全恢复：主进程在 overlay 关闭且 context 已合并时，向仍隐藏的
 *   本页发 {kind:'context', restoreId}——本页按常规 context 流程处理（invalidate
 *   同步清空旧 DOM → getContext 落地 → establish），定型后经 ackContextRestore
 *   回执，主进程收到 ack 才把面板 view 单次挂回窗口（ack 前用户绝看不到旧 DOM）；
 * - 所有桥调用 try/catch，失败进内联错误条（#errorBar）或 pane 内失败态，不弹窗。
 */
(function () {
  'use strict';

  var api = typeof window.workspace === 'object' && window.workspace ? window.workspace : null;

  var ctxArea = document.getElementById('ctxArea');
  var errorBar = document.getElementById('errorBar');
  var collapseBtn = document.getElementById('collapseBtn');
  var changesBody = document.getElementById('changesBody');
  var filesBody = document.getElementById('filesBody');
  var previewBox = document.getElementById('previewBox');
  var previewName = document.getElementById('previewName');
  var previewBody = document.getElementById('previewBody');
  var previewClose = document.getElementById('previewClose');
  var agentsNote = document.getElementById('agentsNote');
  var agentsBody = document.getElementById('agentsBody');
  var tasksNote = document.getElementById('tasksNote');
  var tasksBody = document.getElementById('tasksBody');

  /* ---------- 工具 ---------- */

  function errMsg(e) {
    return e && e.message ? e.message : String(e);
  }

  function showError(msg) {
    errorBar.textContent = msg;
    errorBar.hidden = false;
  }

  function clearError() {
    errorBar.hidden = true;
    errorBar.textContent = '';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* sessionId 截断为 session_ab53…f145 式（头 12 + … + 尾 4） */
  function truncateSid(sid) {
    if (!sid) return '未知会话';
    if (sid.length <= 17) return sid;
    return sid.slice(0, 12) + '…' + sid.slice(-4);
  }

  /* 路径过长省略中间段，保留首尾 */
  function shortenPath(p, max) {
    if (!p) return '';
    var limit = max || 34;
    if (p.length <= limit) return p;
    var head = Math.ceil((limit - 1) / 2);
    var tail = Math.floor((limit - 1) / 2);
    return p.slice(0, head) + '…' + p.slice(-tail);
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '--:--:--';
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* YYYY-MM-DD HH:mm */
  function fmtDateTime(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtSize(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ---------- 会话身份：contextKey + contextGeneration（跨会话旧数据防泄漏） ---------- */

  /* 当前已确认的会话身份键；null = 尚未建立（首个 getContext 未定型） */
  var contextKey = null;
  /* 身份代际号：context 刷新一开始即递增（作废全部在途数据请求），身份建立/切换凭它核对 */
  var contextGeneration = 0;
  /* getContext 请求序号：单调递增，乱序/迟到的旧响应与旧异常凭它整体丢弃 */
  var contextRequestSeq = 0;
  /* 最近一次 getContext 是否已定型（成功或失败）：未定型前 Changes/Files 不发数据请求 */
  var contextReady = false;

  /* getContext 失败时定型的稳定非 null 失败键：失败也建立合法身份占位，
   * 后续数据请求凭非 null key 捕获/校验，杜绝 null key 提交通道 */
  var CONTEXT_ERROR_KEY = 'unbound:context-error';

  /* 稳定身份键：bound 用 sessionId + workDir；未绑定各态用固定占位（不随轮询抖动） */
  function contextKeyOf(ctx) {
    if (!ctx) return 'unbound:none';
    if (ctx.state === 'bound') {
      return 'bound|' + (ctx.sessionId || '') + '|' + (ctx.workDir || '');
    }
    return 'unbound:' + (ctx.state || 'none');
  }

  /* 异步提交前严格核对：key===null 一律判 stale（无放行通道），代际或身份键
   * 任一不同即丢。数据请求只在 context 定型后发出（activateTab 以 contextReady
   * 把守），发起时捕获的 gen/key 即当时身份；context 刷新开始即递增代际，
   * 在途旧响应在新身份落定前就已作废，getContext 在途窗口内绝无写回。 */
  function staleContext(gen, key) {
    if (key === null) return true;
    if (gen !== contextGeneration) return true;
    if (key !== contextKey) return true;
    return false;
  }

  /* ---------- 头部上下文三态渲染 ---------- */

  function renderBound(ctx) {
    var box = el('div', 'ctx-bound');

    var row = el('div', 'ctx-row');
    var sid = el('span', 'ctx-sid mono', truncateSid(ctx.sessionId));
    if (ctx.sessionId) sid.title = ctx.sessionId;
    row.appendChild(sid);
    if (ctx.confidence === 'high' || ctx.confidence === 'low') {
      var high = ctx.confidence === 'high';
      row.appendChild(el('span', 'badge ' + (high ? 'badge-ok' : 'badge-warn'), high ? '已验证' : '低置信'));
    }
    box.appendChild(row);

    if (ctx.workDir) {
      var dir = el('div', 'ctx-dir mono', shortenPath(ctx.workDir, 34));
      dir.title = ctx.workDir;
      box.appendChild(dir);
    }

    box.appendChild(el('div', 'ctx-meta', '更新于 ' + fmtTime(ctx.updatedAt)));
    ctxArea.appendChild(box);
  }

  function renderCandidates(ctx) {
    var box = el('div', 'ctx-candidates');
    box.appendChild(el('div', 'ctx-label', '未绑定工作区，请选择要绑定的会话：'));

    var list = el('ul', 'cand-list');
    var candidates = Array.isArray(ctx.candidates) ? ctx.candidates : [];
    if (candidates.length === 0) {
      box.appendChild(el('div', 'ctx-meta', '暂无候选会话'));
    }
    candidates.forEach(function (c) {
      var item = el('li');
      var btn = el('button', 'cand-item');
      btn.type = 'button';
      var sid = el('span', 'cand-sid', truncateSid(c.sessionId));
      if (c.sessionId) sid.title = c.sessionId;
      btn.appendChild(sid);
      if (c.workDir) {
        var dir = el('span', 'cand-dir', shortenPath(c.workDir, 40));
        dir.title = c.workDir;
        btn.appendChild(dir);
      }
      btn.addEventListener('click', function () { onSelectCandidate(c.sessionId, btn); });
      item.appendChild(btn);
      list.appendChild(item);
    });
    box.appendChild(list);
    ctxArea.appendChild(box);
  }

  function renderUnbound() {
    var box = el('div', 'ctx-loading');
    var spinner = el('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    box.appendChild(spinner);
    box.appendChild(el('span', null, '等待 Web UI 会话就绪…'));
    ctxArea.appendChild(box);
  }

  function renderContext(ctx) {
    ctxArea.textContent = '';
    if (!ctx || ctx.state === 'unbound') {
      renderUnbound();
    } else if (ctx.state === 'candidates') {
      renderCandidates(ctx);
    } else if (ctx.state === 'bound') {
      renderBound(ctx);
    } else {
      renderUnbound();
    }
  }

  /* context 刷新（首个初始化 / onEvent kind:'context' / 候选绑定成功）：
   * 按潜在身份切换处理——开始即 invalidateForContextRefresh() 作废旧数据、
   * 同步清空旧 DOM，getContext 落地前不发新数据请求；落地且通过乱序核对后
   * 才建立非 null 身份键、渲染头部、立即重载当前标签。 */
  function refreshContext() {
    if (!api || typeof api.getContext !== 'function') return Promise.resolve();
    var reqSeq = ++contextRequestSeq;
    invalidateForContextRefresh(); // 立即作废在途数据 + 同步清空；落地前不发新数据请求
    return api.getContext()
      .then(function (ctx) {
        if (reqSeq !== contextRequestSeq) return; // 已有更新的 getContext 在途/落地，旧响应整体丢弃
        clearError();
        contextKey = contextKeyOf(ctx); // 建立新的非 null 身份键
        renderContext(ctx);
        establishContext(); // 定型放行 + 当前标签立即重载（不走防抖）
      })
      .catch(function (e) {
        if (reqSeq !== contextRequestSeq) return; // 旧异常同样整体丢弃，不进错误条
        contextKey = CONTEXT_ERROR_KEY; // 稳定非 null 失败键：后续请求不得以 null key 提交
        establishContext(); // 失败也定型：放行数据请求（pane 按 unbound/error 呈现）
        showError('获取工作区上下文失败：' + errMsg(e));
      });
  }

  var selecting = false;

  function onSelectCandidate(sessionId, btn) {
    if (!api || selecting || !sessionId) return;
    selecting = true;
    btn.disabled = true;
    api.selectCandidate(sessionId)
      .then(function (r) {
        if (r && r.ok) {
          clearError();
          return refreshContext(); // 绑定成功即潜在身份切换：由 refreshContext 统一作废清空重载
        }
        showError('绑定会话失败：' + (r && r.reason ? r.reason : '未知原因'));
        return undefined;
      })
      .catch(function (e) {
        showError('绑定会话失败：' + errMsg(e));
      })
      .then(function () {
        selecting = false;
        btn.disabled = false;
      });
  }

  collapseBtn.addEventListener('click', function () {
    if (!api || typeof api.setPanelState !== 'function') return;
    api.setPanelState({ collapsed: true })
      .catch(function (e) {
        showError('折叠面板失败：' + errMsg(e));
      });
  });

  /* ---------- pane 通用渲染 ---------- */

  function renderPaneLoading(container, text) {
    container.textContent = '';
    var box = el('div', 'pane-loading');
    var spinner = el('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    box.appendChild(spinner);
    box.appendChild(el('span', null, text));
    container.appendChild(box);
  }

  /* 复用 M2 空态视觉语言（图标 + 一句话 + 副文案） */
  function renderPaneEmpty(container, glyph, title, sub) {
    container.textContent = '';
    var box = el('div', 'empty');
    box.appendChild(el('span', 'empty-icon', glyph)).setAttribute('aria-hidden', 'true');
    box.appendChild(el('div', 'empty-title', title));
    if (sub) box.appendChild(el('div', 'empty-sub', sub));
    container.appendChild(box);
  }

  function renderPaneFail(container, title, msg, retry) {
    container.textContent = '';
    var box = el('div', 'pane-fail');
    box.appendChild(el('div', 'pane-fail-title', title));
    box.appendChild(el('div', 'pane-fail-msg', msg));
    if (retry) {
      var btn = el('button', 'btn btn-secondary', '重试');
      btn.type = 'button';
      btn.addEventListener('click', retry);
      box.appendChild(btn);
    }
    container.appendChild(box);
  }

  /* ---------- Changes ---------- */

  var changes = {
    loaded: false,
    loading: false,
    status: 'idle', // idle | ok | empty | unbound | not-git | error
    message: '',
    snapshotId: null,
    entries: [],
    sensitive: false,
    expandedId: null,
    diffs: {}, // entryId -> { state:'loading'|'ok'|'error', diff, truncated, message }
    seq: 0
  };

  var STATUS_META = {
    added: { letter: 'A', cls: 'st-added', label: '新增' },
    modified: { letter: 'M', cls: 'st-modified', label: '修改' },
    deleted: { letter: 'D', cls: 'st-deleted', label: '删除' },
    renamed: { letter: 'R', cls: 'st-renamed', label: '改名' },
    untracked: { letter: 'U', cls: 'st-untracked', label: '未跟踪' }
  };

  function loadChanges(background) {
    if (!api || typeof api.getChanges !== 'function' || changes.loading) return;
    var hadData = changes.status === 'ok' || changes.status === 'empty';
    var seq = ++changes.seq;
    var gen = contextGeneration;
    var key = contextKey;
    changes.loading = true;
    if (!background || !changes.loaded) renderPaneLoading(changesBody, '正在读取变更…');
    api.getChanges()
      .then(function (r) {
        if (seq !== changes.seq || staleContext(gen, key)) return;
        changes.loading = false;
        if (!r || r.ok !== true) {
          var reason = r && r.reason ? r.reason : '未知原因';
          if (reason === 'unbound') {
            changes.status = 'unbound';
          } else if (reason === 'not-git-repo' || (r && r.notGitRepo)) {
            changes.status = 'not-git';
          } else if (background && hadData) {
            showError('刷新变更失败：' + reason);
            return;
          } else {
            changes.status = 'error';
            changes.message = reason;
          }
          changes.loaded = true;
          changes.entries = [];
          changes.snapshotId = null;
          changes.diffs = {};
          changes.expandedId = null;
          renderChanges();
          return;
        }
        changes.loaded = true;
        if (changes.snapshotId !== r.snapshotId) changes.diffs = {};
        changes.snapshotId = r.snapshotId;
        changes.entries = (Array.isArray(r.entries) ? r.entries : []).slice()
          .sort(function (a, b) { return String(a.path).localeCompare(String(b.path)); });
        changes.sensitive = !!r.sensitive;
        changes.status = changes.entries.length ? 'ok' : 'empty';
        pruneDiffs();
        clearError();
        renderChanges();
      })
      .catch(function (e) {
        if (seq !== changes.seq || staleContext(gen, key)) return;
        changes.loading = false;
        if (background && hadData) {
          showError('刷新变更失败：' + errMsg(e));
          return;
        }
        changes.loaded = true;
        changes.status = 'error';
        changes.message = errMsg(e);
        renderChanges();
        showError('获取变更失败：' + errMsg(e));
      });
  }

  function pruneDiffs() {
    var ids = {};
    changes.entries.forEach(function (en) { ids[en.id] = true; });
    if (changes.expandedId && !ids[changes.expandedId]) changes.expandedId = null;
    Object.keys(changes.diffs).forEach(function (id) {
      if (!ids[id]) delete changes.diffs[id];
    });
  }

  function statBlock(label, s) {
    var adds = s && typeof s.adds === 'number' ? s.adds : 0;
    var dels = s && typeof s.dels === 'number' ? s.dels : 0;
    var block = el('span', 'stat-block' + (adds === 0 && dels === 0 ? ' zero' : ''));
    block.appendChild(el('span', 'stat-label', label));
    block.appendChild(el('span', 'stat-adds', '+' + adds));
    block.appendChild(el('span', 'stat-dels', '−' + dels));
    return block;
  }

  function renderChanges() {
    changesBody.textContent = '';
    if (changes.status === 'unbound') {
      renderPaneEmpty(changesBody, '±', '未绑定工作区', '在头部候选区选择会话即可加载');
      return;
    }
    if (changes.status === 'not-git') {
      renderPaneEmpty(changesBody, '±', '非 Git 仓库', 'Changes 需要 Git 仓库；Files 标签仍可用');
      return;
    }
    if (changes.status === 'error') {
      renderPaneFail(changesBody, '获取变更失败', changes.message, function () { loadChanges(false); });
      return;
    }
    if (changes.status === 'empty') {
      renderPaneEmpty(changesBody, '✓', '工作树干净，无变更');
      return;
    }
    if (changes.status !== 'ok') return;

    if (changes.sensitive) {
      changesBody.appendChild(el('div', 'warn-strip', '敏感目录：只读展示'));
    }
    var list = el('div', 'ch-list');
    changes.entries.forEach(function (en) {
      list.appendChild(renderChangeItem(en));
    });
    changesBody.appendChild(list);
  }

  function renderChangeItem(en) {
    var wrap = el('div', 'ch-item');
    var expanded = changes.expandedId === en.id;

    var head = el('button', 'ch-head' + (expanded ? ' open' : ''));
    head.type = 'button';
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    var line1 = el('div', 'ch-line1');
    var meta = STATUS_META[en.status] || { letter: '?', cls: 'st-untracked', label: en.status || '未知' };
    var badge = el('span', 'st-badge ' + meta.cls, meta.letter);
    badge.title = meta.label;
    badge.setAttribute('aria-label', meta.label);
    line1.appendChild(badge);

    var isRename = en.status === 'renamed' && en.oldPath;
    var fullPath = isRename ? en.oldPath + ' → ' + en.path : en.path;
    var pathText = isRename
      ? shortenPath(en.oldPath, 16) + ' → ' + shortenPath(en.path, 16)
      : shortenPath(en.path, 34);
    var pathEl = el('span', 'ch-path', pathText);
    pathEl.title = fullPath;
    line1.appendChild(pathEl);
    line1.appendChild(el('span', 'ch-chev' + (expanded ? ' open' : ''), '▸'));
    head.appendChild(line1);

    var stats = el('div', 'ch-stats');
    stats.appendChild(statBlock('暂存', en.staged));
    stats.appendChild(statBlock('未暂存', en.unstaged));
    head.appendChild(stats);

    head.addEventListener('click', function () { onToggleDiff(en); });
    wrap.appendChild(head);

    if (expanded) wrap.appendChild(renderDiffBox(en));
    return wrap;
  }

  function onToggleDiff(en) {
    if (changes.expandedId === en.id) {
      changes.expandedId = null;
      renderChanges();
      return;
    }
    changes.expandedId = en.id;
    renderChanges();
    loadDiff(en.id);
  }

  function loadDiff(entryId) {
    if (!api || typeof api.getDiff !== 'function') return;
    var d = changes.diffs[entryId];
    if (d && d.state === 'ok') return;
    changes.diffs[entryId] = { state: 'loading', diff: '', truncated: false, message: '' };
    var snap = changes.snapshotId;
    var gen = contextGeneration;
    var key = contextKey;
    api.getDiff(snap, entryId)
      .then(function (r) {
        if (staleContext(gen, key)) return; // 身份已切换，丢弃在途结果
        if (changes.snapshotId !== snap) return; // 快照已换，丢弃在途结果
        if (r && r.ok) {
          changes.diffs[entryId] = { state: 'ok', diff: r.diff || '', truncated: !!r.truncated, message: '' };
        } else {
          changes.diffs[entryId] = { state: 'error', diff: '', truncated: false, message: (r && r.reason) || '未知原因' };
        }
        if (changes.expandedId === entryId) renderChanges();
      })
      .catch(function (e) {
        if (staleContext(gen, key)) return;
        if (changes.snapshotId !== snap) return;
        changes.diffs[entryId] = { state: 'error', diff: '', truncated: false, message: errMsg(e) };
        if (changes.expandedId === entryId) renderChanges();
      });
  }

  var DIFF_MAX_LINES = 2000;

  function renderDiffBox(en) {
    var box = el('div', 'ch-diff');
    var d = changes.diffs[en.id];

    if (!d || d.state === 'loading') {
      var loading = el('div', 'diff-state');
      var spinner = el('span', 'spinner');
      spinner.setAttribute('aria-hidden', 'true');
      loading.appendChild(spinner);
      loading.appendChild(el('span', null, '正在加载差异…'));
      box.appendChild(loading);
      return box;
    }

    if (d.state === 'error') {
      var errBox = el('div', 'diff-state err', '加载差异失败：' + d.message);
      var retry = el('button', 'link-btn', '重试');
      retry.type = 'button';
      retry.addEventListener('click', function () {
        delete changes.diffs[en.id];
        renderChanges();
        loadDiff(en.id);
      });
      errBox.appendChild(retry);
      box.appendChild(errBox);
      return box;
    }

    var scroll = el('div', 'diff-scroll');
    var lines = String(d.diff).split('\n');
    var capped = lines.length > DIFF_MAX_LINES;
    if (capped) lines = lines.slice(0, DIFF_MAX_LINES);
    lines.forEach(function (ln) {
      var cls = 'dl';
      if (ln.charAt(0) === '+' && ln.slice(0, 3) !== '+++') cls += ' dl-add';
      else if (ln.charAt(0) === '-' && ln.slice(0, 3) !== '---') cls += ' dl-del';
      else if (ln.slice(0, 2) === '@@') cls += ' dl-hunk';
      scroll.appendChild(el('span', cls, ln === '' ? ' ' : ln));
    });
    if (capped) {
      scroll.appendChild(el('span', 'dl dl-note', '… 行数过多，仅渲染前 ' + DIFF_MAX_LINES + ' 行'));
    }
    box.appendChild(scroll);
    if (d.truncated) {
      box.appendChild(el('div', 'diff-foot', '已截断'));
    }
    return box;
  }

  /* ---------- Files ---------- */

  var files = {
    loaded: false,
    loading: false,
    status: 'idle', // idle | ok | unbound | error
    message: '',
    root: [],
    rootTruncated: false,
    children: {}, // path -> { loading, entries, truncated, error }
    expanded: {}, // path -> true
    seq: 0
  };

  var preview = {
    path: null,
    state: 'idle', // idle | loading | ok | binary | error
    content: '',
    truncated: false,
    message: ''
  };

  /* listFiles 单次调用归一化为 { ok, entries, truncated, reason }，异常也进结果 */
  function callListFiles(relPath) {
    return api.listFiles(relPath).then(function (r) {
      if (r && r.ok) {
        var entries = (Array.isArray(r.entries) ? r.entries : []).slice().sort(function (a, b) {
          if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
          return String(a.name).localeCompare(String(b.name));
        });
        return { ok: true, entries: entries, truncated: !!r.truncated, reason: '' };
      }
      return { ok: false, entries: [], truncated: false, reason: (r && r.reason) || '未知原因' };
    }, function (e) {
      return { ok: false, entries: [], truncated: false, reason: errMsg(e) };
    });
  }

  function loadFiles(background) {
    if (!api || typeof api.listFiles !== 'function' || files.loading) return;
    var hadData = files.status === 'ok';
    var seq = ++files.seq;
    var gen = contextGeneration;
    var key = contextKey;
    files.loading = true;
    if (!background || !files.loaded) renderPaneLoading(filesBody, '正在读取文件…');

    var expandedPaths = Object.keys(files.expanded);
    var reqs = [callListFiles('')].concat(expandedPaths.map(function (p) { return callListFiles(p); }));
    Promise.all(reqs).then(function (results) {
      if (seq !== files.seq || staleContext(gen, key)) return;
      files.loading = false;
      var root = results[0];
      if (!root.ok) {
        if (root.reason === 'unbound') {
          files.loaded = true;
          files.status = 'unbound';
          files.root = [];
          files.children = {};
          renderFiles();
        } else if (background && hadData) {
          showError('刷新文件失败：' + root.reason);
        } else {
          files.loaded = true;
          files.status = 'error';
          files.message = root.reason;
          renderFiles();
          showError('读取文件失败：' + root.reason);
        }
        return;
      }
      files.loaded = true;
      files.status = 'ok';
      files.root = root.entries;
      files.rootTruncated = root.truncated;
      expandedPaths.forEach(function (p, i) {
        var r = results[i + 1];
        var prev = files.children[p] || { entries: [], truncated: false };
        if (r.ok) {
          files.children[p] = { loading: false, entries: r.entries, truncated: r.truncated, error: '' };
        } else {
          files.children[p] = { loading: false, entries: prev.entries, truncated: prev.truncated, error: r.reason };
        }
      });
      clearError();
      renderFiles();
    });
  }

  function loadDir(path) {
    var gen = contextGeneration;
    var key = contextKey;
    files.children[path] = { loading: true, entries: [], truncated: false, error: '' };
    callListFiles(path).then(function (r) {
      if (staleContext(gen, key)) return; // 身份已切换，子目录结果不得写回
      var ch = files.children[path];
      if (!ch) return;
      if (r.ok) {
        files.children[path] = { loading: false, entries: r.entries, truncated: r.truncated, error: '' };
      } else {
        files.children[path] = { loading: false, entries: [], truncated: false, error: r.reason };
      }
      if (files.status === 'ok') renderFiles();
    });
  }

  function onToggleDir(path) {
    if (files.expanded[path]) {
      delete files.expanded[path];
      renderFiles();
      return;
    }
    files.expanded[path] = true;
    if (!files.children[path]) loadDir(path);
    renderFiles();
  }

  function renderFiles() {
    filesBody.textContent = '';
    if (files.status === 'unbound') {
      renderPaneEmpty(filesBody, '▤', '未绑定工作区', '在头部候选区选择会话即可加载');
      return;
    }
    if (files.status === 'error') {
      renderPaneFail(filesBody, '读取文件失败', files.message, function () { loadFiles(false); });
      return;
    }
    if (files.status !== 'ok') return;

    if (files.root.length === 0) {
      renderPaneEmpty(filesBody, '▤', '空目录');
      return;
    }
    renderTreeEntries(filesBody, files.root, 0);
    if (files.rootTruncated) {
      filesBody.appendChild(el('div', 'tree-note', '仅显示前 500 条'));
    }
  }

  function treeNote(depth, text, withSpinner) {
    var note = el('div', 'tree-note');
    note.style.paddingLeft = (8 + depth * 14 + 15) + 'px';
    if (withSpinner) {
      var spinner = el('span', 'spinner');
      spinner.setAttribute('aria-hidden', 'true');
      note.appendChild(spinner);
    }
    note.appendChild(el('span', null, text));
    return note;
  }

  function renderTreeEntries(container, entries, depth) {
    entries.forEach(function (en) {
      if (en.type === 'dir') {
        container.appendChild(renderDirRow(en, depth));
        if (files.expanded[en.path]) {
          var childBox = el('div', 'tree-children');
          var ch = files.children[en.path];
          if (!ch || ch.loading) {
            childBox.appendChild(treeNote(depth + 1, '加载中…', true));
          } else if (ch.error) {
            var note = treeNote(depth + 1, '读取失败：' + ch.error);
            var retry = el('button', 'link-btn', '重试');
            retry.type = 'button';
            retry.addEventListener('click', function () { loadDir(en.path); renderFiles(); });
            note.appendChild(retry);
            childBox.appendChild(note);
          } else if (ch.entries.length === 0) {
            childBox.appendChild(treeNote(depth + 1, '空目录'));
          } else {
            renderTreeEntries(childBox, ch.entries, depth + 1);
            if (ch.truncated) childBox.appendChild(treeNote(depth + 1, '仅显示前 500 条'));
          }
          container.appendChild(childBox);
        }
      } else {
        container.appendChild(renderFileRow(en, depth));
      }
    });
  }

  function renderDirRow(en, depth) {
    var row = el('button', 'tree-row dir');
    row.type = 'button';
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    row.setAttribute('aria-expanded', files.expanded[en.path] ? 'true' : 'false');
    row.appendChild(el('span', 'tree-chev', files.expanded[en.path] ? '▾' : '▸'));
    var name = el('span', 'tree-name', en.name);
    name.title = en.path;
    row.appendChild(name);
    row.addEventListener('click', function () { onToggleDir(en.path); });
    return row;
  }

  function renderFileRow(en, depth) {
    var row = el('button', 'tree-row file' + (preview.path === en.path ? ' active' : ''));
    row.type = 'button';
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    row.appendChild(el('span', 'tree-chev', ''));
    var name = el('span', 'tree-name', en.name);
    name.title = en.path;
    row.appendChild(name);

    var metaText = fmtSize(en.size);
    var dt = fmtDateTime(en.mtime);
    if (dt) metaText = metaText ? metaText + ' · ' + dt : dt;
    if (metaText) row.appendChild(el('span', 'tree-meta', metaText));

    var copyBtn = el('button', 'copy-btn', '复制路径');
    copyBtn.type = 'button';
    copyBtn.title = en.path;
    copyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      onCopyPath(en.path, copyBtn);
    });
    row.appendChild(copyBtn);

    row.addEventListener('click', function () { openPreview(en); });
    return row;
  }

  function onCopyPath(path, btn) {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      showError('复制失败：当前环境不支持剪贴板接口');
      return;
    }
    navigator.clipboard.writeText(path).then(function () {
      btn.textContent = '已复制';
      btn.classList.add('ok');
      if (btn._copyTimer) clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(function () {
        btn.textContent = '复制路径';
        btn.classList.remove('ok');
        btn._copyTimer = null;
      }, 1200);
    }, function (e) {
      showError('复制失败：' + errMsg(e));
    });
  }

  /* ---------- Files：预览抽屉 ---------- */

  function openPreview(en) {
    preview.path = en.path;
    preview.state = 'loading';
    preview.content = '';
    preview.truncated = false;
    preview.message = '';
    renderPreview();
    renderFiles(); // 刷新选中行高亮

    if (!api || typeof api.readFile !== 'function') return;
    var gen = contextGeneration;
    var key = contextKey;
    api.readFile(en.path)
      .then(function (r) {
        if (staleContext(gen, key)) return; // 身份已切换，旧文件内容不得写回
        if (preview.path !== en.path) return; // 已切走，丢弃
        if (r && r.ok) {
          preview.state = 'ok';
          preview.content = r.content || '';
          preview.truncated = !!r.truncated;
        } else {
          var reason = (r && r.reason) || '未知原因';
          if (reason === 'binary-file') {
            preview.state = 'binary';
          } else if (reason === 'is-directory') {
            preview.state = 'error';
            preview.message = '这是一个目录，无法预览';
          } else {
            preview.state = 'error';
            preview.message = reason;
          }
        }
        renderPreview();
      })
      .catch(function (e) {
        if (staleContext(gen, key)) return;
        if (preview.path !== en.path) return;
        preview.state = 'error';
        preview.message = errMsg(e);
        renderPreview();
      });
  }

  function closePreview() {
    if (!preview.path) return;
    preview.path = null;
    preview.state = 'idle';
    renderPreview();
    renderFiles();
  }

  function renderPreview() {
    if (!preview.path) {
      previewBox.hidden = true;
      return;
    }
    previewBox.hidden = false;
    previewName.textContent = preview.path;
    previewName.title = preview.path;

    // 移除旧的 truncated 脚注
    var oldFoot = previewBox.querySelector('.preview-foot');
    if (oldFoot) oldFoot.parentNode.removeChild(oldFoot);

    previewBody.textContent = '';
    previewBody.className = 'preview-body mono';

    if (preview.state === 'loading') {
      var box = el('div', 'preview-state');
      var spinner = el('span', 'spinner');
      spinner.setAttribute('aria-hidden', 'true');
      box.appendChild(spinner);
      box.appendChild(el('span', null, '正在读取文件…'));
      previewBody.appendChild(box);
      return;
    }
    if (preview.state === 'binary') {
      previewBody.appendChild(el('div', 'preview-state', '二进制文件不可预览'));
      return;
    }
    if (preview.state === 'error') {
      previewBody.appendChild(el('div', 'preview-state err', '读取失败：' + preview.message));
      return;
    }
    previewBody.textContent = preview.content;
    if (preview.truncated) {
      previewBox.appendChild(el('div', 'preview-foot', '已截断（仅前 1MB）'));
    }
  }

  previewClose.addEventListener('click', closePreview);

  /* Escape：有预览时优先关闭预览（与 previewClose 同路）；无预览时复用折叠按钮
   * 同款 preload panelState API（setPanelState）折叠面板。仅处理 Escape 键，不
   * 拦截其它键（Tab/方向键 roving 导航不受影响）；API 缺失时静默跳过不抛，
   * 异步失败进错误条（与折叠按钮一致）。 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (preview.path) {
      closePreview();
      e.preventDefault();
      return;
    }
    if (!api || typeof api.setPanelState !== 'function') return;
    api.setPanelState({ collapsed: true }).catch(function (err) {
      showError('折叠面板失败：' + errMsg(err));
    });
    e.preventDefault();
  });

  /* ---------- Agents / Tasks：会话只读投影（M4） ----------
   * getProjection() 一次性返回 agents（SubagentNode[]）+ tasks（CatalogEntry[]）
   * + capturedAt 快照时刻；两个标签共享同一份快照状态，各自负责渲染。
   * 第一版事实源为磁盘 snapshot，文案只称「会话快照」，不宣称完整实时流。 */

  var projection = {
    loaded: false,
    loading: false,
    status: 'idle', // idle | ok | unbound | error
    message: '',
    sessionId: null,
    capturedAt: 0,
    agents: [],
    tasks: [],
    agentExpanded: {}, // agentId -> true（步骤展开，同身份跨刷新保留，身份切换清空）
    seq: 0
  };

  var TASKS_NOTE_BASE = '任务目录（只读投影）';

  var AGENT_STATUS_META = {
    running:     { label: '运行中', cls: 'ag-running' },
    completed:   { label: '已完成', cls: 'ag-completed' },
    failed:      { label: '失败',   cls: 'ag-failed' },
    interrupted: { label: '已中断', cls: 'ag-interrupted' },
    unknown:     { label: '未知',   cls: 'ag-unknown' }
  };

  var TASK_KIND_META = {
    task:     { label: '任务',   cls: 'tk-kind-task' },
    subagent: { label: '子代理', cls: 'tk-kind-subagent' },
    cron:     { label: '定时',   cls: 'tk-kind-cron' }
  };

  /* 与 chat 页任务抽屉同款标注语言：来源 / 置信度 */
  var TASK_SOURCE_META = {
    ws:   { label: '实时同步', cls: 'tk-src-ws' },
    acp:  { label: '会话事件', cls: 'tk-src-acp' },
    disk: { label: '本地文件', cls: 'tk-src-disk' }
  };

  var TASK_CONF_META = { // high 不显示
    medium: { label: '参考', cls: 'tk-conf-medium' },
    low:    { label: '粗略', cls: 'tk-conf-low' }
  };

  var TASK_STATUS_LABEL = {
    running: '运行中', completed: '已完成', failed: '失败',
    pending: '等待中', removed: '已移除', interrupted: '已中断',
    cancelled: '已取消', canceled: '已取消', unknown: '未知'
  };

  var AGENT_STEP_MAX = 96;  // 单步文本截断（不渲染工具输出全文）
  var AGENT_STEPS_MAX = 50; // 单代理最多渲染步数

  function loadProjection(background) {
    if (!api || typeof api.getProjection !== 'function') {
      projection.loaded = true;
      projection.status = 'error';
      projection.message = '当前桌面桥接版本不支持投影接口（getProjection）';
      renderAgents();
      renderTasks();
      return;
    }
    if (projection.loading) return;
    var hadData = projection.status === 'ok';
    var seq = ++projection.seq;
    var gen = contextGeneration;
    var key = contextKey;
    projection.loading = true;
    if (!background || !projection.loaded) {
      renderPaneLoading(agentsBody, '正在读取会话快照…');
      renderPaneLoading(tasksBody, '正在读取会话快照…');
    }
    api.getProjection()
      .then(function (r) {
        if (seq !== projection.seq || staleContext(gen, key)) return;
        projection.loading = false;
        if (!r || r.ok !== true) {
          var reason = r && r.reason ? r.reason : '未知原因';
          if (reason === 'unbound') {
            projection.status = 'unbound';
          } else if (background && hadData) {
            showError('刷新会话快照失败：' + reason);
            return;
          } else {
            projection.status = 'error';
            projection.message = reason;
          }
          projection.loaded = true;
          projection.sessionId = null;
          projection.capturedAt = 0;
          projection.agents = [];
          projection.tasks = [];
          projection.agentExpanded = {};
          renderAgents();
          renderTasks();
          return;
        }
        projection.loaded = true;
        projection.status = 'ok';
        projection.sessionId = r.sessionId || null;
        projection.capturedAt = r.capturedAt || 0;
        projection.agents = Array.isArray(r.agents) ? r.agents : [];
        projection.tasks = Array.isArray(r.tasks) ? r.tasks : [];
        pruneAgentExpanded();
        clearError();
        renderAgents();
        renderTasks();
      })
      .catch(function (e) {
        if (seq !== projection.seq || staleContext(gen, key)) return;
        projection.loading = false;
        if (background && hadData) {
          showError('刷新会话快照失败：' + errMsg(e));
          return;
        }
        projection.loaded = true;
        projection.status = 'error';
        projection.message = errMsg(e);
        renderAgents();
        renderTasks();
        showError('获取会话快照失败：' + errMsg(e));
      });
  }

  function pruneAgentExpanded() {
    var ids = {};
    projection.agents.forEach(function (n) { if (n && n.agentId) ids[n.agentId] = true; });
    Object.keys(projection.agentExpanded).forEach(function (id) {
      if (!ids[id]) delete projection.agentExpanded[id];
    });
  }

  /* 扁平 SubagentNode[] → 层级：main 根 + parentAgentId 分组；
   * 父缺失或成环（__unknown__）的节点归入「未知关系」组。 */
  function buildAgentTree(list) {
    var byId = {};
    list.forEach(function (n) {
      if (n && n.agentId) byId[n.agentId] = n;
    });
    function parentOf(n) {
      var pid = n && n.parentAgentId;
      if (!pid || pid === 'main' || pid === n.agentId) return null; // 顶层：挂在 main 根下
      return pid;
    }
    function inCycle(n) {
      var seen = {};
      var cur = n;
      while (cur) {
        var pid = parentOf(cur);
        if (pid === null) return false;
        if (seen[pid]) return true;
        seen[pid] = true;
        cur = byId[pid] || null;
      }
      return false;
    }
    var roots = [];
    var unknown = [];
    var childMap = {}; // parentId -> [node]
    list.forEach(function (n) {
      if (!n) return;
      var pid = parentOf(n);
      if (pid === null) { roots.push(n); return; }
      if (!byId[pid] || inCycle(n)) { unknown.push(n); return; }
      (childMap[pid] = childMap[pid] || []).push(n);
    });
    function byUpdatedDesc(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }
    roots.sort(byUpdatedDesc);
    unknown.sort(byUpdatedDesc);
    Object.keys(childMap).forEach(function (k) { childMap[k].sort(byUpdatedDesc); });
    return { roots: roots, childMap: childMap, unknown: unknown };
  }

  /* 步骤文本提取：字符串原样；对象取 text/title/summary（tool 兜底工具名），
   * 折叠空白并截断——绝不渲染工具输出全文。 */
  function stepText(s) {
    var t = '';
    if (typeof s === 'string') t = s;
    else if (s && typeof s === 'object') {
      t = s.text || s.title || s.summary || '';
      if (!t && s.kind === 'tool' && s.tool) t = String(s.tool);
    }
    t = String(t).replace(/\s+/g, ' ').trim();
    if (t.length > AGENT_STEP_MAX) t = t.slice(0, AGENT_STEP_MAX - 1) + '…';
    return t;
  }

  function stepKindLabel(s) {
    var kind = s && typeof s === 'object' && s.kind ? String(s.kind) : 'step';
    if (kind === 'tool') return '工具';
    if (kind === 'step') return '推理';
    return kind;
  }

  function renderAgentSteps(steps) {
    var box = el('div', 'ag-steps');
    var capped = steps.length > AGENT_STEPS_MAX;
    var show = capped ? steps.slice(0, AGENT_STEPS_MAX) : steps;
    show.forEach(function (s) {
      var row = el('div', 'ag-step');
      row.appendChild(el('span', 'ag-step-kind', stepKindLabel(s)));
      var txt = stepText(s);
      var t = el('span', 'ag-step-text', txt || '（空）');
      if (txt) t.title = txt;
      row.appendChild(t);
      box.appendChild(row);
    });
    if (capped) {
      box.appendChild(el('div', 'ag-step-more', '… 步骤过多，仅渲染前 ' + AGENT_STEPS_MAX + ' 条'));
    }
    return box;
  }

  function renderAgentNode(n, depth, tree, visited) {
    var wrap = el('div', 'ag-item');
    var id = n.agentId || '';
    var meta = AGENT_STATUS_META[n.status] || AGENT_STATUS_META.unknown;
    var steps = Array.isArray(n.steps) ? n.steps : [];
    var expandable = steps.length > 0;
    var expanded = expandable && !!projection.agentExpanded[id];

    var head = el('button', 'ag-head' + (expanded ? ' open' : ''));
    head.type = 'button';
    head.style.paddingLeft = (8 + (depth - 1) * 14) + 'px';
    if (expandable) head.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    var line1 = el('div', 'ag-line1');
    var dot = el('span', 'ag-dot ' + meta.cls);
    dot.title = meta.label;
    dot.setAttribute('aria-label', meta.label);
    line1.appendChild(dot);
    var descText = n.description || n.agentType || id || '子代理';
    var desc = el('span', 'ag-desc', descText);
    desc.title = descText;
    line1.appendChild(desc);
    if (n.agentType && n.agentType !== 'main') {
      line1.appendChild(el('span', 'ag-type', n.agentType));
    }
    if (expandable) line1.appendChild(el('span', 'ag-chev' + (expanded ? ' open' : ''), '▸'));
    head.appendChild(line1);

    var line2 = el('div', 'ag-line2');
    line2.appendChild(el('span', 'ag-stat', meta.label));
    line2.appendChild(el('span', 'ag-stat', steps.length + ' 步'));
    if (n.updatedAt) line2.appendChild(el('span', 'ag-stat', fmtTime(n.updatedAt)));
    head.appendChild(line2);

    if (expandable) {
      head.addEventListener('click', function () {
        if (projection.agentExpanded[id]) delete projection.agentExpanded[id];
        else projection.agentExpanded[id] = true;
        renderAgents();
      });
    } else {
      head.disabled = true; // 无步骤：纯展示，不可展开
    }
    wrap.appendChild(head);

    if (expanded) wrap.appendChild(renderAgentSteps(steps));

    if (id && !visited[id]) {
      visited[id] = true;
      var kids = tree.childMap[id] || [];
      if (kids.length) {
        var childBox = el('div', 'ag-children');
        kids.forEach(function (k) {
          childBox.appendChild(renderAgentNode(k, depth + 1, tree, visited));
        });
        wrap.appendChild(childBox);
      }
    }
    return wrap;
  }

  function renderAgents() {
    if (projection.status === 'ok' && projection.capturedAt) {
      agentsNote.textContent = '会话快照 · ' + fmtTime(projection.capturedAt);
    } else {
      agentsNote.textContent = '会话快照';
    }
    agentsBody.textContent = '';
    if (projection.status === 'unbound') {
      renderPaneEmpty(agentsBody, '✦', '未绑定工作区', '在头部候选区选择会话即可加载');
      return;
    }
    if (projection.status === 'error') {
      renderPaneFail(agentsBody, '获取子代理失败', projection.message, function () { loadProjection(false); });
      return;
    }
    if (projection.status !== 'ok') return;

    if (projection.agents.length === 0) {
      renderPaneEmpty(agentsBody, '✦', '暂无子代理记录');
      return;
    }
    var tree = buildAgentTree(projection.agents);
    var box = el('div', 'ag-tree');
    var root = el('div', 'ag-root');
    root.appendChild(el('span', 'ag-root-name mono', 'main'));
    root.appendChild(el('span', 'ag-root-meta', '主代理 · ' + projection.agents.length + ' 个子代理'));
    box.appendChild(root);
    var visited = {};
    tree.roots.forEach(function (n) {
      box.appendChild(renderAgentNode(n, 1, tree, visited));
    });
    if (tree.unknown.length) {
      var grp = el('div', 'ag-group');
      grp.appendChild(el('div', 'ag-group-title', '未知关系（' + tree.unknown.length + '）'));
      tree.unknown.forEach(function (n) {
        grp.appendChild(renderAgentNode(n, 1, tree, visited));
      });
      box.appendChild(grp);
    }
    agentsBody.appendChild(box);
  }

  /* cron 条目从 detail 里挑一个短字段展示（schedule/cron/expression/interval） */
  function cronDetailText(detail) {
    if (!detail || typeof detail !== 'object') return '';
    var v = detail.schedule || detail.cron || detail.expression || detail.interval || '';
    v = String(v);
    if (v.length > 28) v = v.slice(0, 27) + '…';
    return v;
  }

  function renderTaskItem(en) {
    var dim = en.terminal || en.status === 'failed' || en.status === 'removed';
    var wrap = el('div', 'tk-item' + (dim ? ' dim' : ''));

    var line1 = el('div', 'tk-line1');
    var km = TASK_KIND_META[en.kind] || { label: en.kind || '未知', cls: 'tk-kind-task' };
    line1.appendChild(el('span', 'tk-kind ' + km.cls, km.label));
    var titleText = en.title || en.key || en.id || '未命名';
    var title = el('span', 'tk-title', titleText);
    title.title = titleText;
    line1.appendChild(title);
    var stCls = 'tk-status';
    if (en.status === 'completed') stCls += ' is-ok';
    else if (en.status === 'failed') stCls += ' is-failed';
    else if (en.status === 'running') stCls += ' is-running';
    else if (en.status === 'interrupted') stCls += ' is-warn';
    line1.appendChild(el('span', stCls, TASK_STATUS_LABEL[en.status] || en.status || '未知'));
    wrap.appendChild(line1);

    var line2 = el('div', 'tk-line2');
    var sm = TASK_SOURCE_META[en.source];
    if (sm) line2.appendChild(el('span', 'tk-src ' + sm.cls, sm.label));
    var cm = TASK_CONF_META[en.confidence];
    if (cm) line2.appendChild(el('span', 'tk-conf ' + cm.cls, cm.label));
    if (en.kind === 'cron') {
      var det = cronDetailText(en.detail);
      if (det) {
        var d = el('span', 'tk-cron mono', det);
        d.title = det;
        line2.appendChild(d);
      }
    }
    if (en.updatedAt) line2.appendChild(el('span', 'tk-time', fmtDateTime(en.updatedAt)));
    wrap.appendChild(line2);
    return wrap;
  }

  function renderTasks() {
    tasksBody.textContent = '';
    if (projection.status === 'unbound') {
      tasksNote.textContent = TASKS_NOTE_BASE;
      renderPaneEmpty(tasksBody, '☑', '未绑定工作区', '在头部候选区选择会话即可加载');
      return;
    }
    if (projection.status === 'error') {
      tasksNote.textContent = TASKS_NOTE_BASE;
      renderPaneFail(tasksBody, '获取任务失败', projection.message, function () { loadProjection(false); });
      return;
    }
    if (projection.status !== 'ok') {
      tasksNote.textContent = TASKS_NOTE_BASE;
      return;
    }

    var entries = projection.tasks.slice().sort(function (a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    if (entries.length === 0) {
      tasksNote.textContent = TASKS_NOTE_BASE;
      renderPaneEmpty(tasksBody, '☑', '暂无任务记录', '会话快照中还没有任务、子代理或定时活动');
      return;
    }
    tasksNote.textContent = '任务目录 · ' + entries.length + ' 条' +
      (projection.capturedAt ? ' · 快照 ' + fmtTime(projection.capturedAt) : '');
    var list = el('div', 'tk-list');
    entries.forEach(function (en) { list.appendChild(renderTaskItem(en)); });
    tasksBody.appendChild(list);
  }

  /* activities 事件：仅 payload.sessionId 匹配当前 bound 会话才重拉投影；
   * 主进程已 1s 防抖，这里加 400ms 短防抖合并连发。 */
  var activitiesTimer = null;

  function currentBoundSessionId() {
    if (typeof contextKey !== 'string' || contextKey.indexOf('bound|') !== 0) return null;
    var rest = contextKey.slice('bound|'.length);
    var idx = rest.indexOf('|');
    return idx >= 0 ? rest.slice(0, idx) : rest;
  }

  function onActivitiesEvent(p) {
    var sid = currentBoundSessionId();
    if (!sid || !p || !p.sessionId || p.sessionId !== sid) return;
    if (!loadedTabs.agents && !loadedTabs.tasks) return; // 两个标签都未首载，无需提前拉取
    if (activitiesTimer) clearTimeout(activitiesTimer);
    activitiesTimer = setTimeout(function () {
      activitiesTimer = null;
      loadProjection(true);
    }, 400);
  }

  /* ---------- 四标签栏（点击 + 左右方向键，roving tabindex；首屏数据切到才加载） ---------- */

  var tabEls = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var paneEls = Array.prototype.slice.call(document.querySelectorAll('.tabpane'));
  var activeTab = 'changes';
  var loadedTabs = {};

  function activateTab(id, moveFocus) {
    activeTab = id;
    tabEls.forEach(function (t) {
      var active = t.getAttribute('data-tab') === id;
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) {
        t.removeAttribute('tabindex');
        if (moveFocus) t.focus();
      } else {
        t.setAttribute('tabindex', '-1');
      }
    });
    paneEls.forEach(function (p) {
      p.hidden = p.getAttribute('data-pane') !== id;
    });
    if (!contextReady) return; // context 未定型（首个 pending 或刷新在途）：只落定 ARIA/视觉状态，不发数据请求
    if (id === 'changes' || id === 'files') {
      if (!loadedTabs[id]) {
        loadedTabs[id] = true;
        if (id === 'changes') loadChanges(false); else loadFiles(false);
      } else {
        // 已加载的标签切回：用缓存，后台刷新
        if (id === 'changes') loadChanges(true); else loadFiles(true);
      }
    } else if (id === 'agents' || id === 'tasks') {
      // Agents/Tasks 共享同一份投影：先按缓存呈现，再按首载/切回决定前台或后台拉取
      if (id === 'agents') renderAgents(); else renderTasks();
      if (!loadedTabs[id]) {
        loadedTabs[id] = true;
        loadProjection(projection.loaded); // 已有快照：后台刷新；否则首屏 loading
      } else {
        loadProjection(true);
      }
    }
  }

  tabEls.forEach(function (t, i) {
    t.addEventListener('click', function () {
      activateTab(t.getAttribute('data-tab'), false);
    });
    t.addEventListener('keydown', function (e) {
      var j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % tabEls.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabEls.length) % tabEls.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabEls.length - 1;
      if (j >= 0) {
        e.preventDefault();
        activateTab(tabEls[j].getAttribute('data-tab'), true);
      }
    });
  });

  /* ---------- 刷新节流：refresh 事件（同身份 focus）3s 防抖后重取当前激活标签 ---------- */

  var refreshTimer = null;

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      if (activeTab === 'changes' && loadedTabs.changes) loadChanges(true);
      else if (activeTab === 'files' && loadedTabs.files) loadFiles(true);
      else if ((activeTab === 'agents' || activeTab === 'tasks') && loadedTabs[activeTab]) loadProjection(true);
    }, 3000);
  }

  /* context 刷新第一阶段（开始即同步执行）：立即使旧数据请求失效——代际递增 +
   * 同步清空 Changes/Files/diff/预览/loadedTabs 与旧 DOM + 取消待触发防抖；
   * contextReady 落下，getContext 落地前不发新数据请求（此间切标签只切视觉）。
   * 只清逻辑状态，不改任何视觉结构；各 pane 按既有渲染函数重画为空态。 */
  function invalidateForContextRefresh() {
    contextGeneration++;
    contextReady = false;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; } // 旧身份的待刷新一并作废

    // Changes：列表/快照/diff/展开/加载态全清
    changes.seq++;
    changes.loaded = false;
    changes.loading = false;
    changes.status = 'idle';
    changes.message = '';
    changes.snapshotId = null;
    changes.entries = [];
    changes.sensitive = false;
    changes.expandedId = null;
    changes.diffs = {};

    // Files：根/子目录/展开/加载态全清
    files.seq++;
    files.loaded = false;
    files.loading = false;
    files.status = 'idle';
    files.message = '';
    files.root = [];
    files.rootTruncated = false;
    files.children = {};
    files.expanded = {};

    // 预览抽屉：路径/内容/截断/消息/状态全清
    preview.path = null;
    preview.state = 'idle';
    preview.content = '';
    preview.truncated = false;
    preview.message = '';

    // Agents/Tasks 投影：快照/展开/加载态全清，activities 待触发防抖一并作废
    projection.seq++;
    projection.loaded = false;
    projection.loading = false;
    projection.status = 'idle';
    projection.message = '';
    projection.sessionId = null;
    projection.capturedAt = 0;
    projection.agents = [];
    projection.tasks = [];
    projection.agentExpanded = {};
    if (activitiesTimer) { clearTimeout(activitiesTimer); activitiesTimer = null; }

    // 标签首屏记录作废，各标签按新身份重新首载
    loadedTabs = {};

    // 清除旧身份遗留的错误条
    clearError();

    // 同步清空旧 DOM：A 的列表/diff/预览/投影不得残留在 B 中（渲染逻辑与空态结构不变）
    renderChanges();
    renderFiles();
    renderPreview();
    renderAgents();
    renderTasks();
  }

  /* context 刷新第二阶段（getContext 落地且通过乱序核对后执行）：身份键已建立
   * （成功为新非 null key，失败为稳定失败键），定型放行并立即加载当前标签。 */
  function establishContext() {
    contextReady = true; // 数据请求自此放行（activateTab 把守解除）
    // 当前激活标签立即加载（不等 3 秒防抖）
    if (activeTab === 'changes' || activeTab === 'files') {
      loadedTabs[activeTab] = true;
      if (activeTab === 'changes') loadChanges(false); else loadFiles(false);
    } else if (activeTab === 'agents' || activeTab === 'tasks') {
      loadedTabs[activeTab] = true;
      loadProjection(false);
    }
  }

  /* ---------- 初始化 ---------- */

  // 仅落定激活标签的 ARIA/视觉状态；首个 getContext 定型前不发任何数据请求，
  // 首屏数据由 refreshContext 首次落地后的 establishContext 立即加载。
  activateTab('changes', false);

  if (!api) {
    showError('未检测到桌面桥接接口（window.workspace），面板无法获取工作区数据。');
    renderUnbound();
    renderPaneFail(changesBody, '无法加载', '未检测到桌面桥接接口（window.workspace）', null);
    renderPaneFail(filesBody, '无法加载', '未检测到桌面桥接接口（window.workspace）', null);
    renderPaneFail(agentsBody, '无法加载', '未检测到桌面桥接接口（window.workspace）', null);
    renderPaneFail(tasksBody, '无法加载', '未检测到桌面桥接接口（window.workspace）', null);
    collapseBtn.disabled = true;
    return;
  }

  if (typeof api.getPanelState === 'function') {
    api.getPanelState().catch(function (e) {
      showError('读取面板状态失败：' + errMsg(e));
    });
  }

  refreshContext();

  /* M6：overlay 关闭安全恢复回执——仅响应带 restoreId 的 context 事件；
   * 在 refreshContext 定型（旧 DOM 已同步清空 + 新 context 已落地渲染）后回传，
   * 主进程凭 ack 才把面板 view 单次挂回窗口。回执失败不致命：
   * 主进程有 ack 超时 → 受控 reload 兜底。 */
  function ackContextRestore(rid) {
    if (rid === null) return;
    if (!api || typeof api.ackContextRestore !== 'function') return;
    try { api.ackContextRestore(rid); } catch (e) { /* 回执失败由主进程超时兜底 */ }
  }

  if (typeof api.onEvent === 'function') {
    api.onEvent(function (p) {
      if (!p) return;
      if (p.kind === 'context') {
        // 主进程仅在身份可能变化时发送：按潜在身份切换处理。
        // M6：overlay 关闭安全恢复流程会带 restoreId——定型后必须回执
        //（成功/失败都回执：失败也已建立稳定失败键并渲染安全空态）
        var rid = (typeof p.restoreId === 'number' && isFinite(p.restoreId)) ? p.restoreId : null;
        Promise.resolve(refreshContext()).then(function () { ackContextRestore(rid); }, function () { ackContextRestore(rid); });
      } else if (p.kind === 'refresh') {
        scheduleRefresh(); // 同身份 focus：仅 3s 防抖，绝不清空数据
      } else if (p.kind === 'activities') {
        onActivitiesEvent(p); // 子代理/任务活动：sessionId 匹配当前 bound 会话才短防抖重拉投影
      }
    });
  }
})();
