// workspace-ipc-guard 模块单元测试（M6）
// 用法：node test-workspace-ipc-guard.js
// 纯函数测试：不涉及 fs / 网络 / electron，无临时目录。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const mod = require('../src/main/workspace-ipc-guard');

// 与 main.js 同口径的预期 workspace 页面 URL（pathToFileURL(workspace.html).href）
const EXPECTED_URL = pathToFileURL(path.join(__dirname, '..', 'src', 'pages', 'workspace.html')).href;

// ---------- 1. 预期 workspace file URL 判定 ----------
function testIsExpectedWorkspaceUrl() {
  // 精确匹配（正常 loadFile 后的形态：file:///D:/.../workspace.html）
  assert.strictEqual(mod.isExpectedWorkspaceUrl(EXPECTED_URL, EXPECTED_URL), true, '精确预期 URL 应通过');
  // 偏离：hash / query / 其他 file 页面 / http(s) / 空 / 非法
  assert.strictEqual(mod.isExpectedWorkspaceUrl(EXPECTED_URL + '#x', EXPECTED_URL), false, '带 hash 拒绝');
  assert.strictEqual(mod.isExpectedWorkspaceUrl(EXPECTED_URL + '?a=1', EXPECTED_URL), false, '带 query 拒绝');
  assert.strictEqual(
    mod.isExpectedWorkspaceUrl(pathToFileURL(path.join(__dirname, '..', 'src', 'pages', 'loading.html')).href, EXPECTED_URL),
    false, '其他本地页面拒绝');
  assert.strictEqual(mod.isExpectedWorkspaceUrl('https://evil.example.com/', EXPECTED_URL), false, '外部 http(s) 拒绝');
  assert.strictEqual(mod.isExpectedWorkspaceUrl('file:///etc/passwd', EXPECTED_URL), false, '任意 file URL 拒绝');
  assert.strictEqual(mod.isExpectedWorkspaceUrl('', EXPECTED_URL), false, '空串拒绝');
  assert.strictEqual(mod.isExpectedWorkspaceUrl(null, EXPECTED_URL), false, 'null 拒绝');
  assert.strictEqual(mod.isExpectedWorkspaceUrl(EXPECTED_URL, null), false, 'expectedUrl 缺失拒绝');
  console.log('✅ isExpectedWorkspaceUrl：精确 file URL 放行 / hash·query·他页·http·空拒绝');
}

// ---------- 2. 导航决策（will-navigate / will-redirect 共用） ----------
function testDecideWorkspaceNavigation() {
  assert.strictEqual(mod.decideWorkspaceNavigation(EXPECTED_URL, EXPECTED_URL), 'allow', '正常 loadFile 放行');
  // 恶意/重定向 URL 一律 reject
  assert.strictEqual(mod.decideWorkspaceNavigation('https://evil.example.com/steal', EXPECTED_URL), 'reject');
  assert.strictEqual(mod.decideWorkspaceNavigation('file:///C:/Windows/System32/evil.html', EXPECTED_URL), 'reject');
  assert.strictEqual(mod.decideWorkspaceNavigation('file:///D:/code/other/workspace.html', EXPECTED_URL), 'reject');
  assert.strictEqual(mod.decideWorkspaceNavigation('file:///D:/code/kimi-code-desktop/src/pages/workspace.html#x', EXPECTED_URL), 'reject');
  assert.strictEqual(mod.decideWorkspaceNavigation('', EXPECTED_URL), 'reject');
  assert.strictEqual(mod.decideWorkspaceNavigation(null, EXPECTED_URL), 'reject');
  console.log('✅ decideWorkspaceNavigation：仅精确 workspace.html 放行 / 外部·他页·hash·空拒绝');
}

// ---------- 3. sender 准入决策（isWorkspaceSender 纯内核） ----------
function testIsWorkspaceSenderDecision() {
  const ok = { senderMatchesView: true, senderFrameIsMainFrame: true, currentUrl: EXPECTED_URL, expectedUrl: EXPECTED_URL };
  assert.strictEqual(mod.isWorkspaceSenderDecision(ok), true, 'sender 匹配 + 主 frame + 预期 URL 全过');
  // 非主 frame（iframe/子 frame 发起）→ 拒绝
  assert.strictEqual(mod.isWorkspaceSenderDecision({ ...ok, senderFrameIsMainFrame: false }), false, '非主 frame 拒绝');
  assert.strictEqual(mod.isWorkspaceSenderDecision({ ...ok, senderFrameIsMainFrame: undefined }), false, 'senderFrame 缺失拒绝');
  // sender 不匹配视图 → 拒绝
  assert.strictEqual(mod.isWorkspaceSenderDecision({ ...ok, senderMatchesView: false }), false, 'sender 不匹配拒绝');
  // 当前 URL 偏离预期（页面被重定向/替换后残留）→ 拒绝
  assert.strictEqual(mod.isWorkspaceSenderDecision({ ...ok, currentUrl: 'https://evil.example.com/' }), false, 'URL 偏离拒绝');
  assert.strictEqual(mod.isWorkspaceSenderDecision({ ...ok, currentUrl: EXPECTED_URL + '#x' }), false, 'URL 带 hash 拒绝');
  assert.strictEqual(mod.isWorkspaceSenderDecision({ ...ok, currentUrl: '' }), false, 'URL 为空拒绝');
  // 缺省参数容错
  assert.strictEqual(mod.isWorkspaceSenderDecision({}), false, '缺参拒绝');
  assert.strictEqual(mod.isWorkspaceSenderDecision(null), false, 'null 拒绝');
  assert.strictEqual(mod.isWorkspaceSenderDecision(), false, 'undefined 拒绝');
  console.log('✅ isWorkspaceSenderDecision：全条件通过放行 / 非主 frame·sender 错配·URL 偏离·缺参拒绝');
}

// ---------- 4. panelState 输入白名单 ----------
function testValidatePanelState() {
  // 查询形态：无参 / null → ok 且 value null（无状态变更）
  assert.deepStrictEqual(mod.validatePanelState(undefined), { ok: true, value: null });
  assert.deepStrictEqual(mod.validatePanelState(null), { ok: true, value: null });
  assert.deepStrictEqual(mod.validatePanelState({}), { ok: true, value: null });
  // 设置形态：{ collapsed: boolean }
  assert.deepStrictEqual(mod.validatePanelState({ collapsed: true }), { ok: true, value: { collapsed: true } });
  assert.deepStrictEqual(mod.validatePanelState({ collapsed: false }), { ok: true, value: { collapsed: false } });
  // 类型/字段白名单拒绝
  assert.deepStrictEqual(mod.validatePanelState({ collapsed: 'yes' }), { ok: false, reason: 'bad-arg' }, 'collapsed 非布尔拒绝');
  assert.deepStrictEqual(mod.validatePanelState({ collapsed: 1 }), { ok: false, reason: 'bad-arg' });
  assert.deepStrictEqual(mod.validatePanelState({ collapsed: true, extra: 1 }), { ok: false, reason: 'bad-arg' }, '多余字段拒绝');
  assert.deepStrictEqual(mod.validatePanelState([]), { ok: false, reason: 'bad-arg' }, '数组非 plain object 拒绝');
  assert.deepStrictEqual(mod.validatePanelState('x'), { ok: false, reason: 'bad-arg' });
  assert.deepStrictEqual(mod.validatePanelState(42), { ok: false, reason: 'bad-arg' });
  assert.deepStrictEqual(mod.validatePanelState(new Date()), { ok: false, reason: 'bad-arg' }, '类实例拒绝');
  console.log('✅ validatePanelState：查询/设置放行 / 非 plain·字段类型·多余字段拒绝');
}

// ---------- 5. selectCandidate 输入白名单 ----------
function testValidateSelectCandidate() {
  assert.deepStrictEqual(mod.validateSelectCandidate({ sessionId: 'session_abc-123' }), { ok: true, value: { sessionId: 'session_abc-123' } });
  assert.strictEqual(mod.validateSelectCandidate({ sessionId: 'a'.repeat(128) }).ok, true, '128 长度边界通过');
  assert.deepStrictEqual(mod.validateSelectCandidate({ sessionId: 'a'.repeat(129) }), { ok: false, reason: 'bad-arg' }, '129 拒绝');
  assert.deepStrictEqual(mod.validateSelectCandidate({ sessionId: '' }), { ok: false, reason: 'bad-arg' }, '空串拒绝');
  assert.deepStrictEqual(mod.validateSelectCandidate({ sessionId: 123 }), { ok: false, reason: 'bad-arg' }, '非字符串拒绝');
  assert.deepStrictEqual(mod.validateSelectCandidate({}), { ok: false, reason: 'bad-arg' });
  assert.deepStrictEqual(mod.validateSelectCandidate({ sessionId: 's', extra: 1 }), { ok: false, reason: 'bad-arg' }, '多余字段拒绝');
  assert.deepStrictEqual(mod.validateSelectCandidate(null), { ok: false, reason: 'bad-arg' });
  assert.deepStrictEqual(mod.validateSelectCandidate('session_x'), { ok: false, reason: 'bad-arg' }, '裸字符串非 plain object 拒绝');
  console.log('✅ validateSelectCandidate：合法放行 / 超长·空·类型错·多余字段·非 plain 拒绝');
}

// ---------- 6. files 输入白名单 ----------
function testValidateFilesArg() {
  assert.deepStrictEqual(mod.validateFilesArg({ action: 'list', relPath: '' }), { ok: true, value: { action: 'list', relPath: '' } });
  assert.deepStrictEqual(mod.validateFilesArg({ action: 'read', relPath: 'src/main.js' }), { ok: true, value: { action: 'read', relPath: 'src/main.js' } });
  assert.strictEqual(mod.validateFilesArg({ action: 'list', relPath: 'a'.repeat(512) }).ok, true, '512 长度边界通过');
  assert.deepStrictEqual(mod.validateFilesArg({ action: 'list', relPath: 'a'.repeat(513) }), { ok: false, reason: 'bad-arg' }, '513 拒绝');
  assert.deepStrictEqual(mod.validateFilesArg({ action: 'delete', relPath: '' }), { ok: false, reason: 'bad-arg' }, '未知 action 拒绝');
  assert.deepStrictEqual(mod.validateFilesArg({ action: 'list' }), { ok: false, reason: 'bad-arg' }, '缺 relPath 拒绝');
  assert.deepStrictEqual(mod.validateFilesArg({ action: 'list', relPath: 42 }), { ok: false, reason: 'bad-arg' }, 'relPath 非字符串拒绝');
  assert.deepStrictEqual(mod.validateFilesArg({ action: 'list', relPath: '', extra: 1 }), { ok: false, reason: 'bad-arg' }, '多余字段拒绝');
  assert.deepStrictEqual(mod.validateFilesArg(['list', '']), { ok: false, reason: 'bad-arg' }, '数组拒绝');
  assert.deepStrictEqual(mod.validateFilesArg(null), { ok: false, reason: 'bad-arg' });
  console.log('✅ validateFilesArg：list/read 放行 / 未知 action·超长·非字符串·多余字段·非 plain 拒绝');
}

// ---------- 7. diff 输入白名单（snapshotId 与字符串 entryId 安全长度） ----------
function testValidateDiffArg() {
  const sid = 'c9f2a1b0-1111-2222-3333-444455556666';
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: sid, entryId: 0 }), { ok: true, value: { snapshotId: sid, entryId: 0 } }, '整数 entryId 通过');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: sid, entryId: '12' }), { ok: true, value: { snapshotId: sid, entryId: '12' } }, '数字串 entryId 通过');
  assert.strictEqual(mod.validateDiffArg({ snapshotId: sid, entryId: '1'.repeat(15) }).ok, true, 'entryId 15 位边界通过');
  assert.strictEqual(mod.validateDiffArg({ snapshotId: 's'.repeat(128), entryId: 1 }).ok, true, 'snapshotId 128 边界通过');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: sid, entryId: '1'.repeat(16) }), { ok: false, reason: 'bad-arg' }, 'entryId 16 位拒绝');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: sid, entryId: -1 }), { ok: false, reason: 'bad-arg' }, '负数拒绝');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: sid, entryId: 1.5 }), { ok: false, reason: 'bad-arg' }, '非整数拒绝');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: sid, entryId: 'abc' }), { ok: false, reason: 'bad-arg' }, '非数字串拒绝');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: 's'.repeat(129), entryId: 1 }), { ok: false, reason: 'bad-arg' }, 'snapshotId 129 拒绝');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: '', entryId: 1 }), { ok: false, reason: 'bad-arg' }, '空 snapshotId 拒绝');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: sid }), { ok: false, reason: 'bad-arg' }, '缺 entryId 拒绝');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: sid, entryId: 1, extra: 1 }), { ok: false, reason: 'bad-arg' }, '多余字段拒绝');
  assert.deepStrictEqual(mod.validateDiffArg({ snapshotId: sid, entryId: NaN }), { ok: false, reason: 'bad-arg' });
  assert.deepStrictEqual(mod.validateDiffArg(null), { ok: false, reason: 'bad-arg' });
  console.log('✅ validateDiffArg：整数/数字串 entryId 放行 / 超长·负数·非数字·缺字段·多余字段拒绝');
}

// ---------- 8. server:log 广播门：Web 禁止 / 受控本地 file 页允许 ----------
function testShouldBroadcastServerLog() {
  assert.strictEqual(mod.shouldBroadcastServerLog('file:///D:/code/kimi-code-desktop/src/pages/loading.html'), true, 'file 本地页允许');
  assert.strictEqual(mod.shouldBroadcastServerLog('file:///C:/x/setup.html'), true, '任意受控 file 页允许');
  assert.strictEqual(mod.shouldBroadcastServerLog('http://127.0.0.1:58997/chat/x'), false, '主 Web（http kimi web）禁止');
  assert.strictEqual(mod.shouldBroadcastServerLog('https://code.kimi.com/sessions/x'), false, 'https Web 禁止');
  assert.strictEqual(mod.shouldBroadcastServerLog('about:blank'), false, '未知协议禁止');
  assert.strictEqual(mod.shouldBroadcastServerLog('data:text/html,x'), false, 'data: 禁止');
  assert.strictEqual(mod.shouldBroadcastServerLog(''), false, '空串禁止');
  assert.strictEqual(mod.shouldBroadcastServerLog('not a url'), false, '非法 URL 禁止');
  assert.strictEqual(mod.shouldBroadcastServerLog(null), false, 'null 禁止');
  console.log('✅ shouldBroadcastServerLog：file 本地页允许 / HTTP(S) Web·未知协议·非法一律禁止');
}

// ---------- 8b. workspace:contextRestored：{ restoreId: 正整数 ≤ 2^31-1 }（M6 恢复回执） ----------
function testValidateContextRestored() {
  assert.deepStrictEqual(mod.validateContextRestored({ restoreId: 1 }), { ok: true, value: { restoreId: 1 } }, '正整数放行');
  assert.deepStrictEqual(mod.validateContextRestored({ restoreId: 2147483647 }), { ok: true, value: { restoreId: 2147483647 } }, '2^31-1 边界放行');
  assert.deepStrictEqual(mod.validateContextRestored({ restoreId: 0 }), { ok: false, reason: 'bad-arg' }, '0 拒绝');
  assert.deepStrictEqual(mod.validateContextRestored({ restoreId: -1 }), { ok: false, reason: 'bad-arg' }, '负数拒绝');
  assert.deepStrictEqual(mod.validateContextRestored({ restoreId: 2147483648 }), { ok: false, reason: 'bad-arg' }, '超上限拒绝');
  assert.deepStrictEqual(mod.validateContextRestored({ restoreId: 1.5 }), { ok: false, reason: 'bad-arg' }, '非整数拒绝');
  assert.deepStrictEqual(mod.validateContextRestored({ restoreId: '1' }), { ok: false, reason: 'bad-arg' }, '字符串拒绝');
  assert.deepStrictEqual(mod.validateContextRestored({ restoreId: NaN }), { ok: false, reason: 'bad-arg' }, 'NaN 拒绝');
  assert.deepStrictEqual(mod.validateContextRestored({}), { ok: false, reason: 'bad-arg' }, '缺字段拒绝');
  assert.deepStrictEqual(mod.validateContextRestored({ restoreId: 1, extra: 2 }), { ok: false, reason: 'bad-arg' }, '多余字段拒绝');
  assert.deepStrictEqual(mod.validateContextRestored(null), { ok: false, reason: 'bad-arg' }, 'null 拒绝');
  assert.deepStrictEqual(mod.validateContextRestored([1]), { ok: false, reason: 'bad-arg' }, '数组拒绝');
  console.log('✅ validateContextRestored：正整数放行 / 0·负·超上限·非整数·缺字段·多余字段拒绝');
}

// ---------- 9. main.js 静态接线断言（适度） ----------
function testMainWiringStatic() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  // 模块引入与预期 URL
  assert.ok(/require\('\.\/workspace-ipc-guard'\)/.test(src), 'main.js 应 require workspace-ipc-guard');
  assert.ok(/pathToFileURL\(path\.join\(__dirname, '\.\.', 'pages', 'workspace\.html'\)\)\.href/.test(src), 'workspacePageUrl 应来自 pathToFileURL(workspace.html)');
  // logLine 广播门：必须经 shouldBroadcastServerLog
  assert.ok(src.indexOf('workspaceGuard.shouldBroadcastServerLog(mainWindow.webContents.getURL())') >= 0, 'logLine 应经 shouldBroadcastServerLog 门控');
  // 视图导航隔离：四个导航事件（含 will-redirect）均经 decideWorkspaceNavigation 守卫，
  // 且守卫调用中必须引用预期 workspacePageUrl
  var navGuard = (src.match(/workspaceGuard\.decideWorkspaceNavigation\(url, workspacePageUrl\)/g) || []).length;
  assert.ok(navGuard >= 3, '导航守卫应覆盖直接调用与 guardViewNavigation 内核（实际 ' + navGuard + ' 处）');
  ['will-navigate', 'will-redirect', 'did-navigate', 'did-navigate-in-page'].forEach((ev) => {
    assert.ok(src.indexOf("view.webContents.on('" + ev + "'") >= 0, '应监听 ' + ev);
  });
  assert.ok(/hideWorkspacePanel\(\{ destroy: true \}\)/.test(src), 'URL 偏离应安全销毁面板');
  assert.ok(/setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)/.test(src), '面板应一律拒绝弹新窗');
  // isWorkspaceSender：sender + 主 frame + 当前 URL 三条件（isWorkspaceSenderDecision）
  assert.ok(src.indexOf('workspaceGuard.isWorkspaceSenderDecision({') >= 0, 'isWorkspaceSender 应走决策内核');
  assert.ok(/senderFrameIsMainFrame: !!\(e\.senderFrame && e\.senderFrame === e\.sender\.mainFrame\)/.test(src), '应校验 senderFrame 为主 frame');
  assert.ok(/currentUrl: wc\.getURL\(\),\s*expectedUrl: workspacePageUrl/.test(src), 'sender 准入应校验当前视图 URL');
  // origin 规则接线：resolveContext 与 computeNavStateUpdate 均传 knownServerBase
  assert.ok(/sw\.resolveContext\(\{\s*url,\s*indexEntries: workspaceIndexEntries\(\),\s*explicitSessionId: workspaceExplicitSessionId,\s*knownServerBase,\s*\}\)/.test(src), 'resolveWorkspaceContext 应传 knownServerBase');
  assert.ok(/knownServerBase, \/\/ M6 会话 origin 规则/.test(src), 'syncWorkspaceNavigationState 应传 knownServerBase');
  // M3 bound 收紧：workspaceBoundWorkDir 建立在 workspaceBoundSessionContext 上（不再直接 resolveWorkspaceContext）
  var boundStart = src.indexOf('function workspaceBoundWorkDir()');
  var boundEnd = src.indexOf('// bound 会话上下文守卫');
  assert.ok(boundStart >= 0 && boundEnd > boundStart, '应包含 workspaceBoundWorkDir');
  var boundBody = src.slice(boundStart, boundEnd);
  assert.ok(/const bound = workspaceBoundSessionContext\(\);/.test(boundBody), 'workspaceBoundWorkDir 必须建立在 workspaceBoundSessionContext 上');
  assert.ok(!/resolveWorkspaceContext\(\)/.test(boundBody), 'workspaceBoundWorkDir 不得再直接解析上下文');
  // IPC 输入白名单与固定错误 reason：工作区 IPC 区段内不得回传 err.message
  var ipcStart = src.indexOf('// ---------- 工作区面板 IPC');
  var ipcEnd = src.indexOf('// ---------- Skills 管理 IPC');
  assert.ok(ipcStart >= 0 && ipcEnd > ipcStart, '应包含工作区 IPC 区段');
  var ipcBody = src.slice(ipcStart, ipcEnd);
  ['validatePanelState', 'validateSelectCandidate', 'validateFilesArg', 'validateDiffArg', 'validateContextRestored'].forEach((fn) => {
    assert.ok(ipcBody.indexOf('workspaceGuard.' + fn + '(') >= 0, '工作区 IPC 应使用 ' + fn);
  });
  var errReason = (ipcBody.match(/workspaceGuard\.ERROR_REASON/g) || []).length;
  assert.ok(errReason >= 5, '五个异常兜底路径应返回固定 ERROR_REASON（实际 ' + errReason + ' 处）');
  assert.ok(!/reason: err\.message/.test(ipcBody), '工作区 IPC 区段不得向 renderer 回传 err.message');
  console.log('✅ main.js 静态接线：guard 引入/广播门/导航隔离/sender 三条件/origin 传参/bound 收紧/IPC 白名单与固定 reason');
}

function run() {
  testIsExpectedWorkspaceUrl();
  testDecideWorkspaceNavigation();
  testIsWorkspaceSenderDecision();
  testValidatePanelState();
  testValidateSelectCandidate();
  testValidateFilesArg();
  testValidateDiffArg();
  testValidateContextRestored();
  testShouldBroadcastServerLog();
  testMainWiringStatic();
  console.log('\n全部 workspace-ipc-guard 测试通过');
}

run();
