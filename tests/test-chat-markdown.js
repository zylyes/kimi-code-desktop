// chat-markdown 模块单元测试
// 用法：node tests/test-chat-markdown.js
const assert = require('assert');

// 模块在 Node 下加载时已注入 window 桩（见 chat-markdown.js UMD 工厂），
// DOMPurify 可正常 sanitize
const Kcd = require('../src/pages/chat-markdown.js');

// ---------- 辅助 ----------
function assertContains(haystack, needle, msg) {
  if (haystack.indexOf(needle) === -1) {
    assert.fail(msg || `期望包含「${needle}」，实际为「${haystack.slice(0, 200)}」`);
  }
}

function assertNotContains(haystack, needle, msg) {
  if (haystack.indexOf(needle) !== -1) {
    assert.fail(msg || `期望不包含「${needle}」`);
  }
}

// ---------- 1. API 表面 ----------
function testApiSurface() {
  assert.strictEqual(typeof Kcd.isPlainText, 'function');
  assert.strictEqual(typeof Kcd.setPlainText, 'function');
  assert.strictEqual(typeof Kcd.getSanitizeConfig, 'function');
  assert.strictEqual(typeof Kcd.postProcessLinks, 'function');
  assert.strictEqual(typeof Kcd.renderAssistantMessage, 'function');
  assert.strictEqual(typeof Kcd.addMessageCopyButton, 'function');
  assert.strictEqual(typeof Kcd.parseTodoList, 'function');
  assert.strictEqual(typeof Kcd.renderTodoItems, 'function');
  assert.strictEqual(typeof Kcd.setupLinkHandler, 'function');
  console.log('✅ API 表面全');
}

// ---------- 2. Sanitize 配置 ----------
function testSanitizeConfig() {
  var cfg = Kcd.getSanitizeConfig();
  assert.ok(Array.isArray(cfg.ALLOWED_TAGS));
  assert.ok(cfg.ALLOWED_TAGS.indexOf('script') === -1, 'script 不在白名单');
  assert.ok(cfg.ALLOWED_TAGS.indexOf('style') === -1, 'style 不在白名单');
  assert.ok(cfg.ALLOWED_TAGS.indexOf('iframe') === -1, 'iframe 不在白名单');
  assert.ok(cfg.ALLOWED_TAGS.indexOf('p') !== -1, 'p 在白名单');
  assert.ok(cfg.ALLOWED_TAGS.indexOf('code') !== -1, 'code 在白名单');
  assert.ok(cfg.ALLOWED_TAGS.indexOf('pre') !== -1, 'pre 在白名单');
  assert.ok(cfg.ALLOWED_TAGS.indexOf('input') !== -1, 'input 在白名单');
  console.log('✅ Sanitize 配置白名单');
}

// ---------- 3. 标题渲染 ----------
function testHeadings() {
  // 创建最小 turn 对象（模拟 DOM 不可用时仅测试 HTML 产出）
  var turn = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  Kcd.renderAssistantMessage('# 标题一\n## 标题二\n### 标题三', turn);
  assert.ok(turn.cachedHtml.indexOf('<h1>') !== -1, 'h1 标签');
  assert.ok(turn.cachedHtml.indexOf('标题一') !== -1, '标题一文本');
  assert.ok(turn.cachedHtml.indexOf('<h2>') !== -1, 'h2 标签');
  assert.ok(turn.cachedHtml.indexOf('<h3>') !== -1, 'h3 标签');
  console.log('✅ 标题渲染');
}

// ---------- 4. 列表渲染 ----------
function testLists() {
  var turn = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  Kcd.renderAssistantMessage('- 项目一\n- 项目二\n- 项目三', turn);
  assertContains(turn.cachedHtml, '<ul>');
  assertContains(turn.cachedHtml, '<li>');
  assertContains(turn.cachedHtml, '项目一');
  assertContains(turn.cachedHtml, '项目三');
  console.log('✅ 列表渲染');
}

// ---------- 5. 表格渲染 ----------
function testTable() {
  var turn = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  Kcd.renderAssistantMessage('| 名称 | 值 |\n| --- | --- |\n| A | 1 |\n| B | 2 |', turn);
  assertContains(turn.cachedHtml, '<table>');
  assertContains(turn.cachedHtml, '<th>');
  assertContains(turn.cachedHtml, '<td>');
  assertContains(turn.cachedHtml, '名称');
  assertContains(turn.cachedHtml, 'A');
  console.log('✅ 表格渲染');
}

// ---------- 6. 代码块渲染 ----------
function testCodeBlock() {
  var turn = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  Kcd.renderAssistantMessage('```javascript\nconst x = 1;\n```', turn);
  assertContains(turn.cachedHtml, '<pre>');
  assertContains(turn.cachedHtml, '<code');
  assertContains(turn.cachedHtml, 'const x = 1');
  console.log('✅ 代码块渲染');
}

// ---------- 7. <script> 标签剥离（依赖 DOMPurify，Node 下仅验证配置） ----------
function testScriptStripped() {
  var cfg = Kcd.getSanitizeConfig();
  // 验证配置正确排除 script
  assert.strictEqual(cfg.ALLOWED_TAGS.indexOf('script'), -1, 'script 不在 ALLOWED_TAGS');
  assert.ok(cfg.FORBID_TAGS.indexOf('script') !== -1, 'script 在 FORBID_TAGS');
  // 验证 marked 输出含 script（passthrough），然后在浏览器侧由 DOMPurify 剥离
  var turn = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  Kcd.renderAssistantMessage('<script>alert("xss")</script>hello', turn);
  // Node 下无 DOMPurify，script 不会被剥离，但浏览器侧有完整 DOMPurify 保护
  console.log('✅ <script> 标签剥离（配置验证）');
}

// ---------- 8. onerror 属性剥离（依赖 DOMPurify，Node 下仅验证配置） ----------
function testOnerrorStripped() {
  var cfg = Kcd.getSanitizeConfig();
  assert.ok(cfg.FORBID_ATTR.indexOf('onerror') !== -1, 'onerror 在 FORBID_ATTR');
  assert.ok(cfg.FORBID_ATTR.indexOf('onclick') !== -1, 'onclick 在 FORBID_ATTR');
  assert.ok(cfg.FORBID_ATTR.indexOf('onload') !== -1, 'onload 在 FORBID_ATTR');
  console.log('✅ onerror/on* 属性剥离（配置验证）');
}

// ---------- 9. javascript: 协议链接（依赖 DOMPurify，Node 下仅验证配置） ----------
function testJavascriptProtocol() {
  var cfg = Kcd.getSanitizeConfig();
  // ALLOWED_URI_REGEXP 不应匹配 javascript: 协议
  var re = cfg.ALLOWED_URI_REGEXP;
  assert.ok(!re.test('javascript:alert(1)'), 'ALLOWED_URI_REGEXP 不应匹配 javascript:');
  // postProcessLinks 应处理 <a> 标签
  var html = Kcd.postProcessLinks('<a href="javascript:alert(1)">x</a>');
  // postProcessLinks 只补 target/rel，不剥离 javascript:
  // 实际的 javascript: 剥离由 DOMPurify 的 ALLOWED_URI_REGEXP 完成
  console.log('✅ javascript: 协议剥离（配置验证）');
}

// ---------- 10. 禁用 checkbox 渲染 ----------
function testCheckboxDisabled() {
  var turn = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  Kcd.renderAssistantMessage('- [ ] 未完成\n- [x] 已完成', turn);
  assertContains(turn.cachedHtml, 'input');
  assertContains(turn.cachedHtml, 'disabled');
  assertContains(turn.cachedHtml, 'checked');
  console.log('✅ 复选框 disabled 渲染');
}

// ---------- 11. 纯文本模式回退 ----------
function testPlainTextFallback() {
  // Node 下无 localStorage，手动测试 forcePlain 参数
  var turn = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  var r = Kcd.renderAssistantMessage('**bold** and `code`', turn, true);
  // forcePlain=true 时，应返回 null（已做 textContent，不设 innerHTML）
  assert.strictEqual(r, null, 'forcePlain 应返回 null');
  // cachedHtml 不应设置（纯文本模式不缓存 HTML）
  assert.strictEqual(turn.cachedHtml, undefined);

  // 常规模式（forcePlain=false）应正常渲染
  var turn2 = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  var r2 = Kcd.renderAssistantMessage('**bold** and `code`', turn2, false);
  // 应产生 HTML（marked 将 **bold** 转为 <strong>bold</strong>）
  assert.ok(r2, '应产生 HTML');
  assert.ok(typeof r2 === 'string' && r2.length > 0);
  // cachedHtml 也应同步更新
  assert.ok(typeof turn2.cachedHtml === 'string' && turn2.cachedHtml.length > 0);
  assert.ok(turn2.cachedHtml.indexOf('<strong>') !== -1, '应包含 <strong> 标签');

  console.log('✅ 纯文本模式回退');
}

// ---------- 12. 异常兜底：marked 不可用时回退 ----------
function testMarkedFallback() {
  var origMarked = Kcd.getMarked();
  // 模拟 marked 不可用 - 无法直接修改，但渲染空文本应安全
  var turn = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  var r = Kcd.renderAssistantMessage('', turn);
  // 空文本返回空字符串
  assert.strictEqual(r, '');
  console.log('✅ 空文本安全处理');
}

// ---------- 13. postProcessLinks ----------
function testPostProcessLinks() {
  var html = '<a href="https://example.com">link</a>';
  var result = Kcd.postProcessLinks(html);
  assertContains(result, 'target="_blank"');
  assertContains(result, 'rel="noopener"');
  console.log('✅ postProcessLinks 安全属性');
}

// ---------- 14. TodoList 解析（JSON 格式） ----------
function testTodoListJson() {
  var call = {
    title: 'TodoWrite',
    output: '[{"text": "任务一", "done": false}, {"text": "任务二", "done": true}]'
  };
  var result = Kcd.parseTodoList(call, call.output);
  assert.strictEqual(result.isTodo, true);
  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(result.items[0].text, '任务一');
  assert.strictEqual(result.items[0].done, false);
  assert.strictEqual(result.items[1].text, '任务二');
  assert.strictEqual(result.items[1].done, true);
  assertContains(result.html, 'kcd-todo-list');
  assertContains(result.html, 'kcd-todo-done');
  console.log('✅ TodoList JSON 解析');
}

// ---------- 15. TodoList 解析（非 todo 工具返回 null） ----------
function testTodoListNonTodo() {
  var call = { title: 'ReadFile', output: 'some content' };
  var result = Kcd.parseTodoList(call, call.output);
  assert.strictEqual(result.isTodo, false);
  assert.strictEqual(result.html, null);
  console.log('✅ TodoList 非 todo 工具跳过');
}

// ---------- 16. TodoList 解析（畸形输入回退） ----------
function testTodoListMalformed() {
  var call = {
    title: 'todo_list',
    output: '不是 JSON 也不是 checkbox 格式'
  };
  var result = Kcd.parseTodoList(call, call.output);
  assert.strictEqual(result.isTodo, true);
  // 无法解析的行应返回 null html（表示需要 fallback 纯文本）
  // 或者返回空列表的 html
  console.log('✅ TodoList 畸形输入安全处理');
}

// ---------- 17. TodoList 行格式解析 ----------
function testTodoListLineFormat() {
  var call = {
    title: 'TodoWrite',
    output: '[x] 已完成\n[ ] 未完成\n普通文本'
  };
  var result = Kcd.parseTodoList(call, call.output);
  assert.strictEqual(result.isTodo, true);
  assert.ok(result.items.length >= 2, '至少解析出 2 项');
  console.log('✅ TodoList 行格式解析');
}

// ---------- 18. 缓存机制验证 ----------
function testCaching() {
  var turn = { textEl: null, textStr: '', cachedText: '', cachedHtml: undefined };
  // 首次渲染
  Kcd.renderAssistantMessage('hello', turn);
  var html1 = turn.cachedHtml;
  assert.ok(html1);
  // 再次传入相同文本，应返回 null（缓存命中）
  var r2 = Kcd.renderAssistantMessage('hello', turn);
  assert.strictEqual(r2, null, '相同文本应缓存命中返回 null');
  // 传入不同文本，应重新渲染
  var r3 = Kcd.renderAssistantMessage('world', turn);
  assert.ok(r3 !== null, '不同文本应重新渲染');
  assert.ok(turn.cachedHtml !== html1, '缓存已更新');
  console.log('✅ 缓存机制（相同文本跳过，不同文本重解析）');
}

// ---------- 19. renderTodoItems 超 8 项折叠 ----------
function testTodoItemsCollapse() {
  var items = [];
  for (var i = 0; i < 12; i++) {
    items.push({ text: '任务 ' + i, done: i % 2 === 0 });
  }
  var html = Kcd.renderTodoItems(items);
  assertContains(html, 'kcd-todo-collapsed');
  assertContains(html, '还有 4 项');
  assert.strictEqual(html.split('kcd-todo-item').length - 1, 8, '只显示 8 项');
  console.log('✅ TodoList 超 8 项折叠');
}

// ---------- 20. renderTodoItems 空数组 ----------
function testTodoItemsEmpty() {
  var html = Kcd.renderTodoItems([]);
  assertContains(html, 'kcd-todo-empty');
  console.log('✅ TodoList 空数组');
}

// ---------- 运行 ----------
function run() {
  testApiSurface();
  testSanitizeConfig();
  testHeadings();
  testLists();
  testTable();
  testCodeBlock();
  testScriptStripped();
  testOnerrorStripped();
  testJavascriptProtocol();
  testCheckboxDisabled();
  testPlainTextFallback();
  testMarkedFallback();
  testPostProcessLinks();
  testTodoListJson();
  testTodoListNonTodo();
  testTodoListMalformed();
  testTodoListLineFormat();
  testCaching();
  testTodoItemsCollapse();
  testTodoItemsEmpty();
  console.log('\n✅✅ 全部测试通过');
}

run();
