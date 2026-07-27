// acp-elicitation 模块单元测试
// 用法：node test-acp-elicitation.js
'use strict';
var assert = require('assert');
var parseElicitation = require('../src/main/acp-elicitation').parseElicitation;

// ---------- 辅助：构造基础 params ----------
function makeParams(overrides) {
  var base = {
    sessionId: 'session_test_123',
    toolCall: {
      toolCallId: '0:tool_test',
      title: 'AskUserQuestion',
      content: [{ type: 'content', content: { type: 'text', text: '你希望默认采用哪种代码风格格式化方式？' } }],
    },
    options: [
      { optionId: 'q0_opt_0', name: '自动格式化', kind: 'allow_once' },
      { optionId: 'q0_opt_1', name: '手动格式化', kind: 'allow_once' },
      { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
    ],
  };
  return Object.assign({}, base, overrides || {});
}

// ---------- 1. 标准单题形态 ----------
function testSingleQuestion() {
  var result = parseElicitation(makeParams());
  assert.ok(result, '应有解析结果');
  assert.ok(result.questions, '应有 questions 数组');
  assert.strictEqual(result.questions.length, 1);
  assert.strictEqual(result.questions[0].key, 'q0');
  assert.ok(result.questions[0].text.indexOf('代码风格格式化') >= 0);
  assert.strictEqual(result.questions[0].options.length, 3);
  assert.strictEqual(result.questions[0].options[0].optionId, 'q0_opt_0');
  assert.strictEqual(result.questions[0].options[0].name, '自动格式化');
  assert.strictEqual(result.questions[0].options[0].isSkip, false);
  assert.strictEqual(result.questions[0].options[1].optionId, 'q0_opt_1');
  assert.strictEqual(result.questions[0].options[1].name, '手动格式化');
  assert.strictEqual(result.questions[0].skipOptionId, 'q0_skip');
  assert.strictEqual(result.questions[0].options[2].optionId, 'q0_skip');
  assert.strictEqual(result.questions[0].options[2].isSkip, true);
  console.log('✅ 单题标准形态 → 正确分组/提取选项和文本/skipOptionId');
}

// ---------- 2. 非 elicitation（title 不符）----------
function testNotElicitation() {
  var p = makeParams();
  p.toolCall.title = 'execute';
  var result = parseElicitation(p);
  assert.strictEqual(result, null);
  console.log('✅ 非 AskUserQuestion → 返回 null');
}

// ---------- 3. 多题（q0_ / q1_ 混合）→ 降级 ----------
function testMultiQuestion() {
  var p = makeParams();
  p.options = [
    { optionId: 'q0_opt_0', name: 'A', kind: 'allow_once' },
    { optionId: 'q1_opt_0', name: 'B', kind: 'allow_once' },
  ];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.strictEqual(result.reason, 'multi-question');
  console.log('✅ 多题（q0_/q1_混合）→ 降级 multi-question');
}

// ---------- 4. 坏 optionId（无 q 前缀）→ 降级 ----------
function testBadOptionFormat() {
  var p = makeParams();
  p.options[0].optionId = 'custom_option';
  var result = parseElicitation(p);
  assert.ok(result);
  assert.strictEqual(result.reason, 'bad-option-format');
  console.log('✅ 坏 optionId（自定义格式）→ 降级 bad-option-format');
}

// ---------- 5. other 形态 optionId → 降级 ----------
function testOtherOptionFormat() {
  var p = makeParams();
  p.options = [
    { optionId: 'q0_opt_0', name: 'A', kind: 'allow_once' },
    { optionId: 'q0_opt_1', name: '自定义', kind: 'allow_other' },
  ];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.strictEqual(result.reason, 'bad-option-format');
  console.log('✅ allow_other 形态（非 opt/skip 格式）→ 降级 bad-option-format');
}

// ---------- 6. 空 options → 降级 ----------
function testEmptyOptions() {
  var p = makeParams();
  p.options = [];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.strictEqual(result.reason, 'no-options');
  console.log('✅ 空 options → 降级 no-options');
}

// ---------- 7. 仅 skip 无正常选项 → 降级 ----------
function testOnlySkip() {
  var p = makeParams();
  p.options = [{ optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' }];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.strictEqual(result.reason, 'no-options');
  console.log('✅ 仅 skip 无正常选项 → 降级 no-options');
}

// ---------- 8. 双 skip → 降级 ----------
function testDoubleSkip() {
  var p = makeParams();
  p.options = [
    { optionId: 'q0_opt_0', name: 'A', kind: 'allow_once' },
    { optionId: 'q0_skip', name: 'Skip1', kind: 'reject_once' },
    { optionId: 'q0_skip', name: 'Skip2', kind: 'reject_once' },
  ];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.strictEqual(result.reason, 'bad-option-format');
  console.log('✅ 双 skip → 降级 bad-option-format');
}

// ---------- 9. 无 content 字段 → 兜底 '问题' ----------
function testNoContent() {
  var p = makeParams();
  p.toolCall.content = undefined;
  var result = parseElicitation(p);
  assert.ok(result);
  assert.ok(result.questions);
  assert.strictEqual(result.questions[0].text, '问题');
  console.log('✅ 无 content 字段 → 兜底文本 "问题"');
}

// ---------- 10. 空 content 数组 → 兜底 '问题' ----------
function testEmptyContent() {
  var p = makeParams();
  p.toolCall.content = [];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.strictEqual(result.questions[0].text, '问题');
  console.log('✅ 空 content 数组 → 兜底文本 "问题"');
}

// ---------- 11. 多段 content 拼接 ----------
function testMultiContentParts() {
  var p = makeParams();
  p.toolCall.content = [
    { type: 'content', content: { type: 'text', text: '第一段' } },
    { type: 'content', content: { type: 'text', text: '第二段' } },
  ];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.ok(result.questions[0].text.indexOf('第一段') >= 0);
  assert.ok(result.questions[0].text.indexOf('第二段') >= 0);
  // 中间应有换行
  assert.ok(result.questions[0].text.length > '第一段'.length + '第二段'.length);
  console.log('✅ 多段 content 拼接 → 文本含两段且以换行分隔');
}

// ---------- 12. 直 content.text（无嵌套 content）----------
function testDirectContentText() {
  var p = makeParams();
  p.toolCall.content = [
    { type: 'text', text: '直接文本' },
  ];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.ok(result.questions[0].text.indexOf('直接文本') >= 0);
  console.log('✅ 直 content.text（无嵌套 content）→ 正确提取');
}

// ---------- 13. options 缺少 optionId → 降级 ----------
function testMissingOptionId() {
  var p = makeParams();
  p.options = [{ name: '无 id', kind: 'allow_once' }];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.strictEqual(result.reason, 'bad-option-format');
  console.log('✅ options 缺少 optionId → 降级 bad-option-format');
}

// ---------- 14. params 为空/非法 → null ----------
function testInvalidParams() {
  assert.strictEqual(parseElicitation(null), null);
  assert.strictEqual(parseElicitation(undefined), null);
  assert.strictEqual(parseElicitation('string'), null);
  assert.strictEqual(parseElicitation(42), null);
  console.log('✅ params 为空/非法 → null');
}

// ---------- 15. 无 toolCall → null ----------
function testNoToolCall() {
  assert.strictEqual(parseElicitation({ sessionId: 's' }), null);
  console.log('✅ 无 toolCall → null');
}

// ---------- 16. 单题无 skip 选项 ----------
function testNoSkipOption() {
  var p = makeParams();
  p.options = [
    { optionId: 'q0_opt_0', name: 'A', kind: 'allow_once' },
    { optionId: 'q0_opt_1', name: 'B', kind: 'allow_once' },
  ];
  var result = parseElicitation(p);
  assert.ok(result);
  assert.strictEqual(result.questions.length, 1);
  assert.strictEqual(result.questions[0].skipOptionId, null);
  assert.strictEqual(result.questions[0].options.length, 2);
  console.log('✅ 单题无 skip 选项 → skipOptionId=null');
}

// ---------- 主流程 ----------
var tests = [
  testSingleQuestion,
  testNotElicitation,
  testMultiQuestion,
  testBadOptionFormat,
  testOtherOptionFormat,
  testEmptyOptions,
  testOnlySkip,
  testDoubleSkip,
  testNoContent,
  testEmptyContent,
  testMultiContentParts,
  testDirectContentText,
  testMissingOptionId,
  testInvalidParams,
  testNoToolCall,
  testNoSkipOption,
];

var failed = 0;
for (var i = 0; i < tests.length; i++) {
  try {
    tests[i]();
  } catch (e) {
    console.error('❌ ' + tests[i].name + ' 失败: ' + e.message);
    console.error('   ' + (e.stack || '').split('\n').slice(1).join('\n   '));
    failed++;
  }
}

if (failed === 0) {
  console.log('\n全部 acp-elicitation 测试通过 (' + tests.length + '/' + tests.length + ')');
} else {
  console.log('\n' + failed + '/' + tests.length + ' 测试失败');
  process.exitCode = 1;
}
