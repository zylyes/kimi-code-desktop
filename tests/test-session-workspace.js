// session-workspace 模块单元测试
// 用法：node test-session-workspace.js
// 纯函数测试：不涉及 fs / 网络 / electron，无临时目录。
const assert = require('assert');
const {
  isValidSessionId,
  isTrustedWebOrigin,
  parseSessionIdFromUrl,
  resolveBySessionId,
  listCandidates,
  resolveContext,
  navFingerprint,
  computeNavStateUpdate,
} = require('../src/main/session-workspace');

const SID = 'session_d98864c1-1a3c-490c-a04c-aa537d1b4b2e';

// ---------- 1. isValidSessionId ----------
function testIsValidSessionId() {
  assert.strictEqual(isValidSessionId(SID), true, '正常 id 应通过');
  assert.strictEqual(isValidSessionId('abc_123-XYZ'), true, '字母数字下划线连字符应通过');
  assert.strictEqual(isValidSessionId('a'.repeat(128)), true, '128 长度边界应通过');
  assert.strictEqual(isValidSessionId(''), false, '空串应拒绝');
  assert.strictEqual(isValidSessionId(null), false, 'null 应拒绝');
  assert.strictEqual(isValidSessionId(undefined), false, 'undefined 应拒绝');
  assert.strictEqual(isValidSessionId(123), false, '数字应拒绝');
  assert.strictEqual(isValidSessionId(`${SID}/x`), false, '含 / 应拒绝');
  assert.strictEqual(isValidSessionId('a\\b'), false, '含反斜杠应拒绝');
  assert.strictEqual(isValidSessionId('..'), false, '含 .. 应拒绝');
  assert.strictEqual(isValidSessionId('a b'), false, '含空格应拒绝');
  assert.strictEqual(isValidSessionId('a'.repeat(129)), false, '129 长度应拒绝');
  console.log('✅ isValidSessionId：合法通过 / 路径注入·超长·非字符串拒绝');
}

// ---------- 2. parseSessionIdFromUrl ----------
function testParseSessionIdFromUrl() {
  assert.strictEqual(
    parseSessionIdFromUrl('http://127.0.0.1:58997/sessions/session_abc-123'),
    'session_abc-123',
    '常规提取');
  assert.strictEqual(
    parseSessionIdFromUrl('https://kimi.com/sessions/session_abc-123/'),
    'session_abc-123',
    '尾斜杠应容忍');
  assert.strictEqual(
    parseSessionIdFromUrl('http://127.0.0.1:58997/sessions/session_abc-123?x=1#token=y'),
    'session_abc-123',
    '查询串/hash 不影响提取');
  assert.strictEqual(parseSessionIdFromUrl('http://127.0.0.1:58997/chat/x'), null, '/chat/x 应拒绝');
  assert.strictEqual(parseSessionIdFromUrl('http://127.0.0.1:58997/sessions/'), null, '/sessions/ 应拒绝');
  assert.strictEqual(parseSessionIdFromUrl('http://127.0.0.1:58997/sessions/..%2F..'), null, '编码路径注入应拒绝');
  assert.strictEqual(parseSessionIdFromUrl('file:///x'), null, 'file 协议应拒绝');
  assert.strictEqual(parseSessionIdFromUrl('not a url'), null, '非法 URL 应拒绝');
  assert.strictEqual(parseSessionIdFromUrl(''), null, '空串应拒绝');
  assert.strictEqual(parseSessionIdFromUrl(null), null, 'null 应拒绝');
  console.log('✅ parseSessionIdFromUrl：提取 / 尾斜杠 / 查询串 / 协议与路径注入拒绝');
}

// ---------- 3. resolveBySessionId ----------
function testResolveBySessionId() {
  const entries = [
    { sessionId: SID, workDir: 'D:/proj/a', sessionDir: 'C:/kimi/sessions/a' },
    { sessionId: 'session_other', workDir: 'D:/proj/b' },
  ];
  assert.deepStrictEqual(
    resolveBySessionId(SID, entries),
    { status: 'verified', sessionId: SID, workDir: 'D:/proj/a', sessionDir: 'C:/kimi/sessions/a' },
    '命中应 verified 并透传 workDir/sessionDir');
  assert.deepStrictEqual(
    resolveBySessionId('session_nope', entries),
    { status: 'unknown', sessionId: 'session_nope' },
    '未命中应 unknown 携带原 id');
  assert.deepStrictEqual(
    resolveBySessionId('../../etc', entries),
    { status: 'unknown', sessionId: null },
    '非法 id 应 unknown 且 sessionId 为 null');
  assert.deepStrictEqual(
    resolveBySessionId(SID, null),
    { status: 'unknown', sessionId: SID },
    'entries 为 null 按空数组');
  assert.deepStrictEqual(
    resolveBySessionId(SID, 'x'),
    { status: 'unknown', sessionId: SID },
    'entries 为字符串按空数组');
  assert.deepStrictEqual(
    resolveBySessionId(SID, undefined),
    { status: 'unknown', sessionId: SID },
    'entries 缺失按空数组');
  console.log('✅ resolveBySessionId：verified 透传 / unknown / 非法 id / 非数组输入');
}

// ---------- 4. listCandidates ----------
function testListCandidates() {
  const mk = (sessionId, workDir) => ({ sessionId, workDir, sessionDir: `dir-${sessionId}` });
  // 倒序：最后追加在最前
  const c1 = listCandidates([mk('s_a', 'w1'), mk('s_b', 'w2'), mk('s_c', 'w3')]);
  assert.deepStrictEqual(c1.map((x) => x.sessionId), ['s_c', 's_b', 's_a'], '应倒序（最近在前）');
  assert.deepStrictEqual(
    c1[0],
    { sessionId: 's_c', workDir: 'w3', sessionDir: 'dir-s_c', source: 'index' },
    '条目结构应含 source:index');
  // 去重保留最近（最后出现项）
  const c2 = listCandidates([mk('s_a', 'old'), mk('s_b', 'w2'), mk('s_a', 'new')]);
  assert.deepStrictEqual(c2.map((x) => x.sessionId), ['s_a', 's_b'], '应按 sessionId 去重');
  assert.strictEqual(c2[0].workDir, 'new', '去重应保留最后出现项');
  // limit 截断
  const c3 = listCandidates(
    [mk('s_a', 'w1'), mk('s_b', 'w2'), mk('s_c', 'w3'), mk('s_d', 'w4'), mk('s_e', 'w5')],
    { limit: 2 });
  assert.deepStrictEqual(c3.map((x) => x.sessionId), ['s_e', 's_d'], 'limit 截断应保留最近项');
  // 过滤非法条目 / 空 workDir / 非对象
  const c4 = listCandidates([
    mk('s_a', 'ok'),
    { sessionId: '../x', workDir: 'w' },
    { sessionId: 's_b', workDir: '' },
    'junk',
    null,
    42,
    { sessionId: 's_d', workDir: 'w4' },
  ]);
  assert.deepStrictEqual(c4.map((x) => x.sessionId), ['s_d', 's_a'], '应过滤非法条目/空 workDir/非对象');
  // 非数组输入
  assert.deepStrictEqual(listCandidates(null), [], 'null → []');
  assert.deepStrictEqual(listCandidates(undefined), [], 'undefined → []');
  assert.deepStrictEqual(listCandidates('x'), [], '字符串 → []');
  console.log('✅ listCandidates：倒序 / 去重保留最近 / limit / 过滤 / 非数组输入');
}

// ---------- 5. resolveContext ----------
function testResolveContext() {
  const index = [
    { sessionId: 'session_aaa', workDir: 'D:/proj/aaa', sessionDir: 'C:/sessions/aaa' },
    { sessionId: 'session_bbb', workDir: 'D:/proj/bbb', sessionDir: 'C:/sessions/bbb' },
  ];
  const base = 'http://127.0.0.1:58997';
  // navigate 命中 → bound/high/navigate
  const nav = resolveContext({ url: 'http://127.0.0.1:58997/sessions/session_bbb', indexEntries: index, knownServerBase: base });
  assert.strictEqual(nav.state, 'bound');
  assert.strictEqual(nav.sessionId, 'session_bbb');
  assert.strictEqual(nav.workDir, 'D:/proj/bbb');
  assert.strictEqual(nav.sessionDir, 'C:/sessions/bbb');
  assert.strictEqual(nav.confidence, 'high');
  assert.strictEqual(nav.source, 'navigate');
  assert.strictEqual(typeof nav.updatedAt, 'number');
  // navigate 未命中（URL 无法解析出 id）但有候选 → candidates
  const cand = resolveContext({ url: 'http://127.0.0.1:58997/chat/x', indexEntries: index, knownServerBase: base });
  assert.strictEqual(cand.state, 'candidates');
  assert.strictEqual(cand.confidence, 'low');
  assert.deepStrictEqual(cand.candidates.map((c) => c.sessionId), ['session_bbb', 'session_aaa']);
  assert.strictEqual(typeof cand.updatedAt, 'number');
  // navigate 未命中（id 不在索引）但有候选 → candidates
  const cand2 = resolveContext({ url: 'http://127.0.0.1:58997/sessions/session_nope', indexEntries: index, knownServerBase: base });
  assert.strictEqual(cand2.state, 'candidates');
  assert.strictEqual(cand2.confidence, 'low');
  // explicit 命中 + 可信 Web origin（knownServerBase 匹配）→ bound/high/explicit
  const exp = resolveContext({
    url: 'http://127.0.0.1:58997/chat/x',
    explicitSessionId: 'session_aaa',
    indexEntries: index,
    knownServerBase: base,
  });
  assert.strictEqual(exp.state, 'bound');
  assert.strictEqual(exp.sessionId, 'session_aaa');
  assert.strictEqual(exp.workDir, 'D:/proj/aaa');
  assert.strictEqual(exp.confidence, 'high');
  assert.strictEqual(exp.source, 'explicit');
  // M6 会话 origin 规则：无 URL（window 销毁/空串）时 explicit 不得回退（非可信 Web）→ unbound
  const expNoUrl = resolveContext({ explicitSessionId: 'session_aaa', indexEntries: index });
  assert.strictEqual(expNoUrl.state, 'unbound', '无 URL（未知 origin）绝不回退 explicit');
  assert.strictEqual(expNoUrl.confidence, 'low');
  assert.strictEqual(expNoUrl.sessionId, undefined, 'unbound 不得携带 bound sessionId');
  // url（verified）优先于 explicit（两者均命中）
  const both = resolveContext({
    url: 'http://127.0.0.1:58997/sessions/session_bbb',
    explicitSessionId: 'session_aaa',
    indexEntries: index,
    knownServerBase: base,
  });
  assert.strictEqual(both.state, 'bound');
  assert.strictEqual(both.sessionId, 'session_bbb');
  assert.strictEqual(both.workDir, 'D:/proj/bbb');
  assert.strictEqual(both.source, 'navigate');
  // 索引为空 → unbound（即便 URL 命中 id）
  const unbound = resolveContext({ url: 'http://127.0.0.1:58997/sessions/session_aaa', indexEntries: [], knownServerBase: base });
  assert.strictEqual(unbound.state, 'unbound');
  assert.strictEqual(unbound.confidence, 'low');
  assert.strictEqual(typeof unbound.updatedAt, 'number');
  // 全空参数 → unbound
  const unbound2 = resolveContext({});
  assert.strictEqual(unbound2.state, 'unbound');
  assert.strictEqual(typeof unbound2.updatedAt, 'number');
  console.log('✅ resolveContext：navigate/explicit 命中 bound / 候选 / unbound / url verified 优先');
}

// ---------- 5b. resolveContext 优先级（url verified > explicit） ----------
function testResolveContextPriority() {
  const index = [
    { sessionId: 'session_aaa', workDir: 'D:/proj/aaa', sessionDir: 'C:/sessions/aaa' },
    { sessionId: 'session_bbb', workDir: 'D:/proj/bbb', sessionDir: 'C:/sessions/bbb' },
  ];
  const base = 'http://127.0.0.1:58997';
  // explicit A + verified URL B → bound B / navigate
  const navWins = resolveContext({
    url: 'http://127.0.0.1:58997/sessions/session_bbb',
    explicitSessionId: 'session_aaa',
    indexEntries: index,
    knownServerBase: base,
  });
  assert.strictEqual(navWins.state, 'bound');
  assert.strictEqual(navWins.sessionId, 'session_bbb');
  assert.strictEqual(navWins.workDir, 'D:/proj/bbb');
  assert.strictEqual(navWins.sessionDir, 'C:/sessions/bbb');
  assert.strictEqual(navWins.confidence, 'high');
  assert.strictEqual(navWins.source, 'navigate');
  // M5 安全规则：explicit A + URL 携带合法 sessionId C 但索引未命中 → 绝不回退 A
  //（否则 Web 显示 C、Workspace 读取 A 的不一致）；安全返回 candidates 保持未授权
  const unverifiedUrl = resolveContext({
    url: 'http://127.0.0.1:58997/sessions/session_ccc',
    explicitSessionId: 'session_aaa',
    indexEntries: index,
    knownServerBase: base,
  });
  assert.strictEqual(unverifiedUrl.state, 'candidates');
  assert.strictEqual(unverifiedUrl.confidence, 'low');
  assert.deepStrictEqual(unverifiedUrl.candidates.map((c) => c.sessionId), ['session_bbb', 'session_aaa']);
  assert.strictEqual(unverifiedUrl.sessionId, undefined, 'candidates 状态不得携带 bound sessionId');
  assert.strictEqual(unverifiedUrl.source, undefined, 'candidates 状态不得携带 source');
  // M6 会话 origin 规则：explicit A + 无 URL（window 销毁/空串，非可信 Web）→ unbound
  //（本地页/未知 origin 期间不得凭 explicit 读取任何工作区数据，也不展示候选）
  const noUrl = resolveContext({ explicitSessionId: 'session_aaa', indexEntries: index });
  assert.strictEqual(noUrl.state, 'unbound');
  assert.strictEqual(noUrl.confidence, 'low');
  assert.strictEqual(noUrl.sessionId, undefined, 'unbound 不得携带 bound sessionId');
  // 既有用途保留：explicit A + 可信 Web 非会话 URL（origin 属于 knownServerBase）→ bound A / explicit
  const noUrlTrusted = resolveContext({
    url: 'http://127.0.0.1:58997/chat/x',
    explicitSessionId: 'session_aaa',
    indexEntries: index,
    knownServerBase: base,
  });
  assert.strictEqual(noUrlTrusted.state, 'bound');
  assert.strictEqual(noUrlTrusted.sessionId, 'session_aaa');
  assert.strictEqual(noUrlTrusted.workDir, 'D:/proj/aaa');
  assert.strictEqual(noUrlTrusted.confidence, 'high');
  assert.strictEqual(noUrlTrusted.source, 'explicit');
  // URL B verified 且 explicit 无效 → bound B / navigate
  const invalidExp = resolveContext({
    url: 'http://127.0.0.1:58997/sessions/session_bbb',
    explicitSessionId: 'session_zombie',
    indexEntries: index,
    knownServerBase: base,
  });
  assert.strictEqual(invalidExp.state, 'bound');
  assert.strictEqual(invalidExp.sessionId, 'session_bbb');
  assert.strictEqual(invalidExp.workDir, 'D:/proj/bbb');
  assert.strictEqual(invalidExp.confidence, 'high');
  assert.strictEqual(invalidExp.source, 'navigate');
  // URL 未验证 + explicit 无效 → 候选（低置信不授权 workDir）
  const cand = resolveContext({
    url: 'http://127.0.0.1:58997/sessions/session_ccc',
    explicitSessionId: 'session_zombie',
    indexEntries: index,
    knownServerBase: base,
  });
  assert.strictEqual(cand.state, 'candidates');
  assert.strictEqual(cand.confidence, 'low');
  assert.deepStrictEqual(cand.candidates.map((c) => c.sessionId), ['session_bbb', 'session_aaa']);
  console.log('✅ resolveContext 优先级：url verified > explicit / 合法 URL 未验证不回退 explicit / 无 URL explicit');
}

// ---------- 5c. M5 安全规则：合法 URL sessionId 未验证绝不回退 explicit ----------
function testResolveContextM5Security() {
  const indexA = [{ sessionId: 'session_aaa', workDir: 'D:/proj/aaa', sessionDir: 'C:/sessions/aaa' }];
  const indexAB = [
    { sessionId: 'session_aaa', workDir: 'D:/proj/aaa', sessionDir: 'C:/sessions/aaa' },
    { sessionId: 'session_bbb', workDir: 'D:/proj/bbb', sessionDir: 'C:/sessions/bbb' },
  ];
  const urlB = 'http://127.0.0.1:58997/sessions/session_bbb';
  const base = 'http://127.0.0.1:58997';

  // 1) explicit A + unknown 合法 URL B（B 不在索引）→ 绝不 bound A；安全返回 candidates（保持未授权）
  const r1 = resolveContext({ url: urlB, explicitSessionId: 'session_aaa', indexEntries: indexA, knownServerBase: base });
  assert.strictEqual(r1.state, 'candidates', '合法 URL 未验证时绝不可回退 explicit → 候选');
  assert.strictEqual(r1.confidence, 'low');
  assert.deepStrictEqual(r1.candidates.map((c) => c.sessionId), ['session_aaa'], '候选仅为索引内条目');
  assert.strictEqual(r1.sessionId, undefined, 'candidates 不得携带 bound sessionId');
  assert.strictEqual(r1.source, undefined, 'candidates 不得携带 source');

  // 2) B 加入索引（verified）→ 解析为 bound B / navigate（URL verified 优先，保持 clearExplicit 语义）
  const r2 = resolveContext({ url: urlB, explicitSessionId: 'session_aaa', indexEntries: indexAB, knownServerBase: base });
  assert.strictEqual(r2.state, 'bound');
  assert.strictEqual(r2.sessionId, 'session_bbb');
  assert.strictEqual(r2.workDir, 'D:/proj/bbb');
  assert.strictEqual(r2.sessionDir, 'C:/sessions/bbb');
  assert.strictEqual(r2.confidence, 'high');
  assert.strictEqual(r2.source, 'navigate');

  // 3) 非会话 URL（无法解析出 sessionId）+ explicit A + 可信 Web origin（knownServerBase 匹配）
  //    → 仍回退 bound A / explicit（可信 Web 非会话页保留 explicit 既有用途）
  const r3 = resolveContext({
    url: 'http://127.0.0.1:58997/chat/x',
    explicitSessionId: 'session_aaa',
    indexEntries: indexA,
    knownServerBase: base,
  });
  assert.strictEqual(r3.state, 'bound');
  assert.strictEqual(r3.sessionId, 'session_aaa');
  assert.strictEqual(r3.workDir, 'D:/proj/aaa');
  assert.strictEqual(r3.confidence, 'high');
  assert.strictEqual(r3.source, 'explicit');

  // 4) explicit A + unknown 合法 URL B 且索引为空 → unbound（无候选，绝不回退 A）
  const r4 = resolveContext({ url: urlB, explicitSessionId: 'session_aaa', indexEntries: [], knownServerBase: base });
  assert.strictEqual(r4.state, 'unbound', '索引为空且 URL 未验证 → unbound，绝不回退 explicit');
  assert.strictEqual(r4.confidence, 'low');
  assert.strictEqual(r4.sessionId, undefined);

  // 5) explicit A + 非法 URL（无法解析）→ M6 未知 origin 一律不回退 → unbound
  //（旧"非法 URL 回退 explicit"语义被 M6 origin 规则取代：非法 URL 无法判定为可信 Web）
  const r5 = resolveContext({ url: 'not a url', explicitSessionId: 'session_aaa', indexEntries: indexA, knownServerBase: base });
  assert.strictEqual(r5.state, 'unbound');
  assert.strictEqual(r5.confidence, 'low');
  assert.strictEqual(r5.sessionId, undefined);

  // 6) explicit A + file:// 本地页 URL（loading/配置页等）→ 绝不回退 explicit → unbound
  const r6 = resolveContext({
    url: 'file:///D:/code/kimi-code-desktop/src/pages/loading.html',
    explicitSessionId: 'session_aaa',
    indexEntries: indexA,
    knownServerBase: base,
  });
  assert.strictEqual(r6.state, 'unbound', 'file:// 本地页绝不回退 explicit');
  assert.strictEqual(r6.confidence, 'low');
  assert.strictEqual(r6.sessionId, undefined);

  // 7) explicit A + 外部/未知 origin URL → 绝不回退 explicit → unbound
  const r7 = resolveContext({
    url: 'https://evil.example.com/chat/x',
    explicitSessionId: 'session_aaa',
    indexEntries: indexA,
    knownServerBase: base,
  });
  assert.strictEqual(r7.state, 'unbound', '外部 origin 绝不回退 explicit');
  assert.strictEqual(r7.confidence, 'low');
  assert.strictEqual(r7.sessionId, undefined);

  console.log('✅ M5 安全规则：合法 URL 未验证绝不回退 explicit / verified 后 bound B / 非会话·可信 Web URL 回退 explicit / file·外部·未知 origin 一律 unbound');
}

// ---------- 6. navFingerprint（导航去重指纹：origin 维度 + unverified→verified / workDir 变化） ----------
function testNavFingerprint() {
  const index = [
    { sessionId: 'session_aaa', workDir: 'D:/proj/aaa', sessionDir: 'C:/sessions/aaa' },
    { sessionId: 'session_bbb', workDir: 'D:/proj/bbb', sessionDir: 'C:/sessions/bbb' },
  ];
  const base = 'http://127.0.0.1:58997';
  // 可信 Web 非会话页 / 根路径 → trusted:<origin>:no-session（与旧 NO_SESSION_FP 语义对应）
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/chat/x', index, base),
    'trusted:http://127.0.0.1:58997:no-session');
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/', index, base),
    'trusted:http://127.0.0.1:58997:no-session');
  // 非可信：非法 URL / 空串 / null → untrusted:（无 origin 可解析）
  assert.strictEqual(navFingerprint('not a url', index, base), 'untrusted:');
  assert.strictEqual(navFingerprint('', index, base), 'untrusted:');
  assert.strictEqual(navFingerprint(null, index, base), 'untrusted:');
  // 非可信：file / 外部 / host 别名 / 协议·端口不匹配 → untrusted:<origin>（安全哨兵，
  // 与可信状态严格区分）
  assert.strictEqual(navFingerprint('file:///D:/code/kimi-code-desktop/src/pages/loading.html', index, base), 'untrusted:null');
  assert.strictEqual(navFingerprint('https://evil.example.com/sessions/session_aaa', index, base), 'untrusted:https://evil.example.com');
  assert.strictEqual(navFingerprint('http://localhost:58997/sessions/session_aaa', index, base), 'untrusted:http://localhost:58997');
  assert.strictEqual(navFingerprint('https://127.0.0.1:58997/sessions/session_aaa', index, base), 'untrusted:https://127.0.0.1:58997');
  assert.strictEqual(navFingerprint('http://127.0.0.1:58998/sessions/session_aaa', index, base), 'untrusted:http://127.0.0.1:58998');
  // 未验证 → trusted:<origin>:unverified:<id>
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/sessions/session_zzz', index, base),
    'trusted:http://127.0.0.1:58997:unverified:session_zzz');
  // 已验证 → trusted:<origin>:verified:<id>:<workDir>
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/sessions/session_aaa', index, base),
    'trusted:http://127.0.0.1:58997:verified:session_aaa:D:/proj/aaa');
  // 同 sessionId：索引为空（未验证）→ 索引命中（已验证）指纹必变（状态变化可识别）
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/sessions/session_bbb', [], base),
    'trusted:http://127.0.0.1:58997:unverified:session_bbb');
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/sessions/session_bbb', index, base),
    'trusted:http://127.0.0.1:58997:verified:session_bbb:D:/proj/bbb');
  // 同 sessionId 已验证但 workDir 变化 → 指纹必变（索引/workDir 更新可识别）
  const index2 = [{ sessionId: 'session_aaa', workDir: 'D:/proj/aaa2', sessionDir: 'C:/sessions/aaa' }];
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/sessions/session_aaa', index2, base),
    'trusted:http://127.0.0.1:58997:verified:session_aaa:D:/proj/aaa2');
  // 同 URL 同索引（查询串/hash 差异）→ 指纹稳定（去重不误伤）
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/sessions/session_aaa?x=1#y', index, base),
    navFingerprint('http://127.0.0.1:58997/sessions/session_aaa', index, base));
  // knownServerBase 变化但 sessionId 相同（origin 变化，M6）→ 指纹必变
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58998/sessions/session_aaa', index, 'http://127.0.0.1:58998'),
    'trusted:http://127.0.0.1:58998:verified:session_aaa:D:/proj/aaa');
  // 非数组索引 → 按空数组（未验证）
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/sessions/session_aaa', null, base),
    'trusted:http://127.0.0.1:58997:unverified:session_aaa');
  assert.strictEqual(
    navFingerprint('http://127.0.0.1:58997/sessions/session_aaa', 'junk', base),
    'trusted:http://127.0.0.1:58997:unverified:session_aaa');
  console.log('✅ navFingerprint：origin 维度（可信/非可信·file·外部·别名·协议·端口·base 变化）/ unverified·verified / workDir 变化识别');
}

// ---------- 6b. computeNavStateUpdate（导航状态同步纯函数内核：main.js syncWorkspaceNavigationState 共用） ----------
function testComputeNavStateUpdate() {
  const index = [
    { sessionId: 'session_aaa', workDir: 'D:/proj/aaa', sessionDir: 'C:/sessions/aaa' },
    { sessionId: 'session_bbb', workDir: 'D:/proj/bbb', sessionDir: 'C:/sessions/bbb' },
  ];
  const base = 'http://127.0.0.1:58997';
  const urlB = 'http://127.0.0.1:58997/sessions/session_bbb';
  const urlNon = 'http://127.0.0.1:58997/chat/x';
  const unverifiedB = 'trusted:http://127.0.0.1:58997:unverified:session_bbb';
  const noSessionFp = 'trusted:http://127.0.0.1:58997:no-session';

  // explicit A + 未验证 B（索引不含 B）：changed（首见指纹）、explicit 不清
  const r1 = computeNavStateUpdate({ url: urlB, indexEntries: [], prevFingerprint: null, explicitSessionId: 'session_aaa', knownServerBase: base });
  assert.strictEqual(r1.changed, true, '首次导航未验证 URL 应 changed');
  assert.strictEqual(r1.fingerprint, unverifiedB, '未验证指纹');
  assert.strictEqual(r1.clearExplicit, false, '未验证 URL 不得清 explicit（低置信不覆盖显式选择）');

  // 同 URL 同索引稳定 → changed=false、指纹不变（去重不误伤）
  const r2 = computeNavStateUpdate({ url: urlB, indexEntries: [], prevFingerprint: unverifiedB, explicitSessionId: 'session_aaa', knownServerBase: base });
  assert.strictEqual(r2.changed, false, '同指纹应稳定去重');
  assert.strictEqual(r2.fingerprint, unverifiedB, '未变指纹保持');
  assert.strictEqual(r2.clearExplicit, false, '指纹未变不清 explicit');

  // 未验证 B → verified B+workDir（索引更新，focus 修复场景）：状态变化可识别；
  // URL 可信且已 verified → 无条件清 explicit A（不附带 newId !== explicit 之类条件）
  const r3 = computeNavStateUpdate({ url: urlB, indexEntries: index, prevFingerprint: unverifiedB, explicitSessionId: 'session_aaa', knownServerBase: base });
  assert.strictEqual(r3.changed, true, 'unverified→verified 状态变化必须可识别');
  assert.strictEqual(r3.fingerprint, 'trusted:http://127.0.0.1:58997:verified:session_bbb:D:/proj/bbb', 'verified 指纹含 origin 与 workDir');
  assert.strictEqual(r3.clearExplicit, true, '可信且 verified URL 必须无条件清 explicit');

  // verified 稳定 + explicit 已清 → changed=false、无需再清
  const r4 = computeNavStateUpdate({ url: urlB, indexEntries: index, prevFingerprint: r3.fingerprint, explicitSessionId: null, knownServerBase: base });
  assert.strictEqual(r4.changed, false, 'verified 稳定应去重');
  assert.strictEqual(r4.clearExplicit, false, 'explicit 已清无需再清');

  // 指纹未变但 explicit 残留（selectCandidate 重选后 focus）：口径——清理只在指纹变化路径评估
  const r5 = computeNavStateUpdate({ url: urlB, indexEntries: index, prevFingerprint: r3.fingerprint, explicitSessionId: 'session_ccc', knownServerBase: base });
  assert.strictEqual(r5.changed, false, '指纹未变');
  assert.strictEqual(r5.clearExplicit, false, 'explicit 清理只在指纹变化时评估');

  // 离开会话页 → 可信非会话页哨兵指纹变化；explicit 不清（可信 Web 非会话页既有用途）
  const r6 = computeNavStateUpdate({
    url: urlNon,
    indexEntries: index,
    prevFingerprint: r3.fingerprint,
    explicitSessionId: 'session_aaa',
    knownServerBase: base,
  });
  assert.strictEqual(r6.changed, true, '离开会话页指纹应变哨兵');
  assert.strictEqual(r6.fingerprint, noSessionFp, '可信非会话页哨兵');
  assert.strictEqual(r6.clearExplicit, false, '可信 Web 非会话页保留 explicit（既有用途）');

  // 非会话页稳定 → 哨兵去重
  const r7 = computeNavStateUpdate({ url: urlNon, indexEntries: index, prevFingerprint: noSessionFp, explicitSessionId: 'session_aaa', knownServerBase: base });
  assert.strictEqual(r7.changed, false, '哨兵稳定去重');
  assert.strictEqual(r7.clearExplicit, false, '哨兵场景不清 explicit');

  // 缺省参数容错：按非可信处理（untrusted: 指纹），无 explicit 无需清
  const r8 = computeNavStateUpdate({});
  assert.strictEqual(r8.fingerprint, 'untrusted:', '缺省参数按非可信（untrusted: 哨兵）');
  assert.strictEqual(r8.changed, true, 'prev 缺省(null)与 untrusted: 不同 → changed');
  assert.strictEqual(r8.clearExplicit, false, '无 explicit 无需清');

  console.log('✅ computeNavStateUpdate：unverified→verified 识别 / explicit 仅可信 verified URL 清理 / 哨兵回退保留');
}

// ---------- 6c. M6 会话 origin 规则：isTrustedWebOrigin ----------
function testIsTrustedWebOrigin() {
  const base = 'http://127.0.0.1:58997';
  assert.strictEqual(isTrustedWebOrigin('http://127.0.0.1:58997/', base), true, '根路径同源');
  assert.strictEqual(isTrustedWebOrigin('http://127.0.0.1:58997/chat/x#y?z=1', base), true, '路径/查询/hash 不影响 origin');
  assert.strictEqual(isTrustedWebOrigin('http://127.0.0.1:58997/sessions/session_a', base), true, '会话页同源');
  assert.strictEqual(isTrustedWebOrigin('https://127.0.0.1:58997/', base), false, '协议不同（http vs https）严格不等');
  assert.strictEqual(isTrustedWebOrigin('http://127.0.0.1:58998/', base), false, '端口不同严格不等');
  assert.strictEqual(isTrustedWebOrigin('http://localhost:58997/', base), false, 'host 别名不算同 origin（严格相等）');
  assert.strictEqual(isTrustedWebOrigin('https://evil.example.com/chat', base), false, '外部 origin');
  assert.strictEqual(isTrustedWebOrigin('file:///D:/code/kimi-code-desktop/src/pages/loading.html', base), false, 'file:// 本地页');
  assert.strictEqual(isTrustedWebOrigin('not a url', base), false, '非法 URL');
  assert.strictEqual(isTrustedWebOrigin('', base), false, '空串');
  assert.strictEqual(isTrustedWebOrigin(null, base), false, 'null');
  assert.strictEqual(isTrustedWebOrigin('http://127.0.0.1:58997/chat', ''), false, '空 knownServerBase');
  assert.strictEqual(isTrustedWebOrigin('http://127.0.0.1:58997/chat', null), false, 'null knownServerBase');
  assert.strictEqual(isTrustedWebOrigin('http://127.0.0.1:58997/chat', 'junk base'), false, '非法 knownServerBase');
  // base 带路径/查询不影响 origin 比较
  assert.strictEqual(
    isTrustedWebOrigin('http://127.0.0.1:58997/sessions/x', 'http://127.0.0.1:58997/foo?bar=1'),
    true, 'base 的路径/查询不影响 origin');
  console.log('✅ isTrustedWebOrigin：同源放行 / 协议·端口·host 别名·file·外部·非法严格拒绝');
}

// ---------- 6d. M6 会话 origin 规则：resolveContext 的 file/外部/未知 origin 一律 unbound ----------
function testResolveContextM6Origin() {
  const indexA = [{ sessionId: 'session_aaa', workDir: 'D:/proj/aaa', sessionDir: 'C:/sessions/aaa' }];
  const base = 'http://127.0.0.1:58997';
  // file:// 本地页（loading 等）+ explicit A → unbound（绝不回退、绝不展示候选）
  const filePage = resolveContext({
    url: 'file:///D:/code/kimi-code-desktop/src/pages/loading.html',
    explicitSessionId: 'session_aaa', indexEntries: indexA, knownServerBase: base,
  });
  assert.strictEqual(filePage.state, 'unbound', 'file:// 本地页一律 unbound');
  assert.strictEqual(filePage.confidence, 'low');
  assert.strictEqual(filePage.sessionId, undefined);
  assert.strictEqual(filePage.candidates, undefined, '非可信页不得携带候选');
  // 外部 origin + explicit A → unbound
  const external = resolveContext({
    url: 'https://evil.example.com/chat/x',
    explicitSessionId: 'session_aaa', indexEntries: indexA, knownServerBase: base,
  });
  assert.strictEqual(external.state, 'unbound', '外部 origin 一律 unbound');
  assert.strictEqual(external.sessionId, undefined);
  assert.strictEqual(external.candidates, undefined, '非可信页不得携带候选');
  // 未知 origin（knownServerBase 不可用）+ Web 非会话 URL + explicit A → unbound
  const noBase = resolveContext({
    url: 'http://127.0.0.1:58997/chat/x',
    explicitSessionId: 'session_aaa', indexEntries: indexA, knownServerBase: null,
  });
  assert.strictEqual(noBase.state, 'unbound', 'knownServerBase 不可用时一律 unbound');
  assert.strictEqual(noBase.sessionId, undefined);
  // 空 URL（window 销毁）+ explicit A → unbound
  const emptyUrl = resolveContext({
    url: '', explicitSessionId: 'session_aaa', indexEntries: indexA, knownServerBase: base,
  });
  assert.strictEqual(emptyUrl.state, 'unbound', '空 URL（未知 origin）一律 unbound');
  assert.strictEqual(emptyUrl.sessionId, undefined);
  // 索引无候选时 → unbound（同样不回退）
  const noCand = resolveContext({
    url: 'file:///D:/code/kimi-code-desktop/src/pages/loading.html',
    explicitSessionId: 'session_aaa', indexEntries: [], knownServerBase: base,
  });
  assert.strictEqual(noCand.state, 'unbound', 'file:// 且无候选 → unbound');
  assert.strictEqual(noCand.confidence, 'low');
  // 可信 Web 非会话页 + explicit A（既有用途保留）→ bound A / explicit
  const trusted = resolveContext({
    url: 'http://127.0.0.1:58997/chat/x',
    explicitSessionId: 'session_aaa', indexEntries: indexA, knownServerBase: base,
  });
  assert.strictEqual(trusted.state, 'bound');
  assert.strictEqual(trusted.sessionId, 'session_aaa');
  assert.strictEqual(trusted.source, 'explicit');
  console.log('✅ resolveContext M6 origin：file/外部/未知 origin 一律 unbound（不 fallback explicit、不展示候选）/ 可信 Web 保留 explicit');
}

// ---------- 6f. M6 高危修复：verified ID + 非可信 URL 一律 unbound（Oracle finding） ----------
function testResolveContextM6UnboundMatrix() {
  const index = [{ sessionId: 'session_aaa', workDir: 'D:/proj/aaa', sessionDir: 'C:/sessions/aaa' }];
  const base = 'http://127.0.0.1:58997';
  const sessionUrl = 'http://127.0.0.1:58997/sessions/session_aaa';
  // verified ID + evil 外部 URL → unbound（即便索引 verified，非可信 origin 绝不 bound）
  const evil = resolveContext({ url: 'https://evil.example.com/sessions/session_aaa', indexEntries: index, knownServerBase: base });
  assert.strictEqual(evil.state, 'unbound', 'verified ID + 外部 URL → unbound');
  assert.strictEqual(evil.confidence, 'low');
  assert.strictEqual(evil.sessionId, undefined, 'unbound 不得携带 bound sessionId');
  assert.strictEqual(evil.candidates, undefined, '非可信页不得携带候选');
  // verified ID + file URL → unbound
  const file = resolveContext({ url: 'file:///C:/evil/sessions/session_aaa', indexEntries: index, knownServerBase: base });
  assert.strictEqual(file.state, 'unbound', 'verified ID + file URL → unbound');
  assert.strictEqual(file.sessionId, undefined);
  // verified ID + 未知 origin（knownServerBase 不可用）→ unbound
  const unknown = resolveContext({ url: sessionUrl, indexEntries: index, knownServerBase: null });
  assert.strictEqual(unknown.state, 'unbound', 'verified ID + 未知 origin → unbound');
  assert.strictEqual(unknown.sessionId, undefined);
  // verified ID + host 别名（localhost vs 127.0.0.1）→ unbound
  const alias = resolveContext({ url: 'http://localhost:58997/sessions/session_aaa', indexEntries: index, knownServerBase: base });
  assert.strictEqual(alias.state, 'unbound', 'verified ID + host 别名 → unbound');
  assert.strictEqual(alias.sessionId, undefined);
  // verified ID + 协议不匹配（https vs base http）→ unbound
  const proto = resolveContext({ url: 'https://127.0.0.1:58997/sessions/session_aaa', indexEntries: index, knownServerBase: base });
  assert.strictEqual(proto.state, 'unbound', 'verified ID + 协议不匹配 → unbound');
  assert.strictEqual(proto.sessionId, undefined);
  // verified ID + 端口不匹配 → unbound
  const port = resolveContext({ url: 'http://127.0.0.1:58998/sessions/session_aaa', indexEntries: index, knownServerBase: base });
  assert.strictEqual(port.state, 'unbound', 'verified ID + 端口不匹配 → unbound');
  assert.strictEqual(port.sessionId, undefined);
  // 正常可信 verified URL → bound 不回归
  const ok = resolveContext({ url: sessionUrl, indexEntries: index, knownServerBase: base });
  assert.strictEqual(ok.state, 'bound', '可信 verified 不回归');
  assert.strictEqual(ok.sessionId, 'session_aaa');
  assert.strictEqual(ok.workDir, 'D:/proj/aaa');
  assert.strictEqual(ok.confidence, 'high');
  assert.strictEqual(ok.source, 'navigate');
  // 可信 verified URL + explicit → 仍 URL 优先（navigate）
  const okExp = resolveContext({
    url: sessionUrl,
    explicitSessionId: 'session_bbb',
    indexEntries: [{ sessionId: 'session_bbb', workDir: 'D:/proj/bbb', sessionDir: 'C:/sessions/bbb' }, ...index],
    knownServerBase: base,
  });
  assert.strictEqual(okExp.state, 'bound', '可信 verified 仍优先于 explicit');
  assert.strictEqual(okExp.sessionId, 'session_aaa');
  assert.strictEqual(okExp.source, 'navigate');
  console.log('✅ M6 unbound 矩阵：verified ID + evil/file/未知/别名/协议/端口一律 unbound / 可信 verified 不回归');
}

// ---------- 6e. M6 会话 origin 规则：指纹 trust 维度 + clearExplicit 仅限可信 verified ----------
function testComputeNavStateUpdateM6Origin() {
  const index = [{ sessionId: 'session_aaa', workDir: 'D:/proj/aaa', sessionDir: 'C:/sessions/aaa' }];
  const base = 'http://127.0.0.1:58997';
  const trustedA = 'trusted:http://127.0.0.1:58997:verified:session_aaa:D:/proj/aaa';
  const fileUrl = 'file:///D:/code/kimi-code-desktop/src/pages/loading.html';

  // 会话 URL → file:// 本地页：changed；非可信页不清 explicit（清理仅限「可信且 verified
  // URL」，explicit 残留仅供可信 Web 非会话页回退——resolveContext origin 规则保证非可信
  // 页绝不 fallback explicit，残留无安全面）
  const r1 = computeNavStateUpdate({
    url: fileUrl,
    indexEntries: index, prevFingerprint: trustedA, explicitSessionId: 'session_aaa', knownServerBase: base,
  });
  assert.strictEqual(r1.changed, true, '可信 → file 页指纹必变');
  assert.strictEqual(r1.fingerprint, 'untrusted:null', 'file 页非可信指纹哨兵，与可信状态区分');
  assert.strictEqual(r1.clearExplicit, false, '非可信页不清 explicit（清理仅限可信且 verified URL）');

  // 会话 URL → 外部 origin（含同 sessionId 的 evil URL）：changed、explicit 不清
  const r2 = computeNavStateUpdate({
    url: 'https://evil.example.com/sessions/session_aaa',
    indexEntries: index, prevFingerprint: trustedA, explicitSessionId: 'session_aaa', knownServerBase: base,
  });
  assert.strictEqual(r2.changed, true, '可信 → 外部同 sessionId 必须 changed（不保留旧 DOM）');
  assert.strictEqual(r2.fingerprint, 'untrusted:https://evil.example.com');
  assert.strictEqual(r2.clearExplicit, false, '外部 origin 不清 explicit');

  // 127.0.0.1 ↔ localhost（host 别名，非可信）：同 sessionId 必须 changed
  const rAlias = computeNavStateUpdate({
    url: 'http://localhost:58997/sessions/session_aaa',
    indexEntries: index, prevFingerprint: trustedA, explicitSessionId: 'session_aaa', knownServerBase: base,
  });
  assert.strictEqual(rAlias.changed, true, 'host 别名变化必须 changed');
  assert.strictEqual(rAlias.fingerprint, 'untrusted:http://localhost:58997');
  assert.strictEqual(rAlias.clearExplicit, false);

  // HTTP ↔ HTTPS（协议不匹配，非可信）：changed
  const rProto = computeNavStateUpdate({
    url: 'https://127.0.0.1:58997/sessions/session_aaa',
    indexEntries: index, prevFingerprint: trustedA, explicitSessionId: 'session_aaa', knownServerBase: base,
  });
  assert.strictEqual(rProto.changed, true, '协议变化必须 changed');
  assert.strictEqual(rProto.fingerprint, 'untrusted:https://127.0.0.1:58997');

  // knownServerBase 变化但 sessionId 相同（origin 变化）：changed，且新 base 下仍可信
  // verified → 清 explicit
  const rBase = computeNavStateUpdate({
    url: 'http://127.0.0.1:58998/sessions/session_aaa',
    indexEntries: index, prevFingerprint: trustedA, explicitSessionId: 'session_aaa', knownServerBase: 'http://127.0.0.1:58998',
  });
  assert.strictEqual(rBase.changed, true, 'knownServerBase 变化但 sessionId 相同必须 changed');
  assert.strictEqual(rBase.fingerprint, 'trusted:http://127.0.0.1:58998:verified:session_aaa:D:/proj/aaa');
  assert.strictEqual(rBase.clearExplicit, true, '新 base 下仍为可信且 verified → 清 explicit');

  // 可信 Web 非会话页：explicit 保留（既有用途）
  const r3 = computeNavStateUpdate({
    url: 'http://127.0.0.1:58997/chat/x',
    indexEntries: index, prevFingerprint: trustedA, explicitSessionId: 'session_aaa', knownServerBase: base,
  });
  assert.strictEqual(r3.changed, true);
  assert.strictEqual(r3.clearExplicit, false, '可信 Web 非会话页保留 explicit');

  // knownServerBase 缺失（未知 origin 判定）→ 非可信指纹、explicit 不清
  const r4 = computeNavStateUpdate({
    url: 'http://127.0.0.1:58997/chat/x',
    indexEntries: index, prevFingerprint: trustedA, explicitSessionId: 'session_aaa', knownServerBase: null,
  });
  assert.strictEqual(r4.changed, true);
  assert.strictEqual(r4.fingerprint, 'untrusted:http://127.0.0.1:58997', 'knownServerBase 缺失按非可信');
  assert.strictEqual(r4.clearExplicit, false, '未知 origin 不清 explicit');

  // 指纹未变（file 页稳定）→ 不清（清理只在指纹变化路径评估）
  const r5 = computeNavStateUpdate({
    url: fileUrl,
    indexEntries: index, prevFingerprint: 'untrusted:null', explicitSessionId: 'session_aaa', knownServerBase: base,
  });
  assert.strictEqual(r5.changed, false, 'file 页非可信指纹稳定去重');
  assert.strictEqual(r5.clearExplicit, false, '指纹未变不清 explicit');

  // 非可信 → 可信 verified URL：changed，且可信且 verified → 无条件清 explicit（既有语义不回归）
  const r6 = computeNavStateUpdate({
    url: 'http://127.0.0.1:58997/sessions/session_aaa',
    indexEntries: index, prevFingerprint: 'untrusted:null', explicitSessionId: 'session_aaa', knownServerBase: base,
  });
  assert.strictEqual(r6.changed, true, '非可信 → 可信 verified 指纹必变');
  assert.strictEqual(r6.clearExplicit, true, '可信且 verified URL 清 explicit');

  console.log('✅ computeNavStateUpdate M6：可信↔非可信·别名·协议·base 变化均 changed / explicit 仅可信 verified 清理');
}

function run() {
  testIsValidSessionId();
  testParseSessionIdFromUrl();
  testResolveBySessionId();
  testListCandidates();
  testResolveContext();
  testResolveContextPriority();
  testResolveContextM5Security();
  testNavFingerprint();
  testComputeNavStateUpdate();
  testIsTrustedWebOrigin();
  testResolveContextM6Origin();
  testResolveContextM6UnboundMatrix();
  testComputeNavStateUpdateM6Origin();
  console.log('\n全部 session-workspace 测试通过');
}

run();
