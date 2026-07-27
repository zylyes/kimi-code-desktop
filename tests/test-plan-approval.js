// plan-approval 模块单元测试
// 用法：node tests/test-plan-approval.js
const assert = require('assert');
const KcdPlan = require('../src/pages/plan-approval.js');

// ---------- 辅助 ----------
function assertDeepEq(actual, expected, msg) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (e) {
    assert.fail(msg || e.message);
  }
}

// ---------- 1. API 表面 ----------
function testApiSurface() {
  assert.strictEqual(typeof KcdPlan.normalizePlanEntries, 'function');
  assert.strictEqual(typeof KcdPlan.summarizePlan, 'function');
  assert.strictEqual(typeof KcdPlan.isExitPlanMode, 'function');
  assert.strictEqual(typeof KcdPlan.classifyExitPlanOption, 'function');
  assert.strictEqual(typeof KcdPlan.validatePlanFeedback, 'function');
  console.log('✅ API 表面全');
}

// ---------- 2. normalizePlanEntries ----------
function testNormalizeEntries() {
  // 正常数据
  var entries = [
    { content: '步骤一', status: 'completed', priority: 'high' },
    { content: '步骤二', status: 'in_progress', priority: 'medium' },
    { content: '步骤三', status: 'pending', priority: 'low' },
  ];
  var result = KcdPlan.normalizePlanEntries(entries);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].content, '步骤一');
  assert.strictEqual(result[0].status, 'completed');
  assert.strictEqual(result[1].status, 'in_progress');
  assert.strictEqual(result[2].status, 'pending');
  console.log('✅ normalizePlanEntries 正常数据');

  // status 别名归一化
  var aliases = [
    { content: 'a', status: 'done' },
    { content: 'b', status: 'DOING' },
    { content: 'c', status: 'IN-PROGRESS' },
    { content: 'd', status: 'Complete' },
    { content: 'e', status: 'finished' },
    { content: 'f', status: 'inprogress' },
  ];
  var r2 = KcdPlan.normalizePlanEntries(aliases);
  assert.strictEqual(r2[0].status, 'completed');
  assert.strictEqual(r2[1].status, 'in_progress');
  assert.strictEqual(r2[2].status, 'in_progress');
  assert.strictEqual(r2[3].status, 'completed');
  assert.strictEqual(r2[4].status, 'completed');
  assert.strictEqual(r2[5].status, 'in_progress');
  console.log('✅ normalizePlanEntries status 别名归一化');

  // 未知 status → pending
  var unknown = [{ content: 'x', status: 'unknown_status' }];
  var r3 = KcdPlan.normalizePlanEntries(unknown);
  assert.strictEqual(r3[0].status, 'pending');
  console.log('✅ normalizePlanEntries 未知 status → pending');

  // 清洗截断
  var long = [{ content: 'x'.repeat(600), status: 'pending', priority: 'y'.repeat(60) }];
  var r4 = KcdPlan.normalizePlanEntries(long);
  assert.strictEqual(r4[0].content.length, 500);
  assert.strictEqual(r4[0].priority.length, 40);
  console.log('✅ normalizePlanEntries 截断');

  // 条数上限 100
  var many = [];
  for (var i = 0; i < 150; i++) many.push({ content: 'item ' + i, status: 'pending' });
  var r5 = KcdPlan.normalizePlanEntries(many);
  assert.strictEqual(r5.length, 100);
  console.log('✅ normalizePlanEntries 上限 100');

  // 非数组输入
  assertDeepEq(KcdPlan.normalizePlanEntries(null), []);
  assertDeepEq(KcdPlan.normalizePlanEntries(undefined), []);
  assertDeepEq(KcdPlan.normalizePlanEntries('not array'), []);
  assertDeepEq(KcdPlan.normalizePlanEntries(123), []);
  console.log('✅ normalizePlanEntries 非数组输入');
}

// ---------- 3. summarizePlan ----------
function testSummarizePlan() {
  var entries = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
    { content: 'd', status: 'in_progress' },
    { content: 'e', status: 'pending' },
  ];
  var s = KcdPlan.summarizePlan(entries);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.completed, 1);
  assert.strictEqual(s.inProgress, 2);
  assert.strictEqual(s.pending, 2);
  console.log('✅ summarizePlan 计数');

  // 空
  var s2 = KcdPlan.summarizePlan([]);
  assert.strictEqual(s2.total, 0);
  assert.strictEqual(s2.completed, 0);
  assert.strictEqual(s2.inProgress, 0);
  assert.strictEqual(s2.pending, 0);
  console.log('✅ summarizePlan 空数组');

  // 非数组
  var s3 = KcdPlan.summarizePlan(null);
  assert.strictEqual(s3.total, 0);
  console.log('✅ summarizePlan 非数组');
}

// ---------- 4. isExitPlanMode ----------
function testIsExitPlanMode() {
  // 命中
  var payload = {
    title: 'ExitPlanMode',
    options: [{ optionId: 'plan_approve' }, { optionId: 'plan_revise' }],
  };
  assert.strictEqual(KcdPlan.isExitPlanMode(payload), true);
  console.log('✅ isExitPlanMode 命中');

  // title 不命中
  var p2 = { title: 'read', options: [{ optionId: 'plan_approve' }] };
  assert.strictEqual(KcdPlan.isExitPlanMode(p2), false);
  console.log('✅ isExitPlanMode title 不命中');

  // 缺 plan_approve
  var p3 = { title: 'ExitPlanMode', options: [{ optionId: 'something_else' }] };
  assert.strictEqual(KcdPlan.isExitPlanMode(p3), false);
  console.log('✅ isExitPlanMode 缺 plan_approve');

  // 缺字段
  assert.strictEqual(KcdPlan.isExitPlanMode(null), false);
  assert.strictEqual(KcdPlan.isExitPlanMode({}), false);
  assert.strictEqual(KcdPlan.isExitPlanMode(undefined), false);
  console.log('✅ isExitPlanMode 缺字段');
}

// ---------- 5. classifyExitPlanOption ----------
function testClassifyExitPlanOption() {
  assert.strictEqual(KcdPlan.classifyExitPlanOption('plan_approve'), 'approve');
  assert.strictEqual(KcdPlan.classifyExitPlanOption('plan_revise'), 'revise');
  assert.strictEqual(KcdPlan.classifyExitPlanOption('plan_reject_and_exit'), 'reject_exit');
  assert.strictEqual(KcdPlan.classifyExitPlanOption('unknown'), null);
  assert.strictEqual(KcdPlan.classifyExitPlanOption(null), null);
  assert.strictEqual(KcdPlan.classifyExitPlanOption(''), null);
  assert.strictEqual(KcdPlan.classifyExitPlanOption('plan_approve '), null); // exact match
  console.log('✅ classifyExitPlanOption');
}

// ---------- 6. validatePlanFeedback ----------
function testValidatePlanFeedback() {
  // 正常
  assert.strictEqual(KcdPlan.validatePlanFeedback('修改为更好方案'), '修改为更好方案');
  console.log('✅ validatePlanFeedback 正常');

  // 空
  assert.strictEqual(KcdPlan.validatePlanFeedback(''), null);
  assert.strictEqual(KcdPlan.validatePlanFeedback('  '), null);
  console.log('✅ validatePlanFeedback 空');

  // 超长
  var long = 'x'.repeat(2500);
  var r = KcdPlan.validatePlanFeedback(long);
  assert.strictEqual(r.length, 2000);
  console.log('✅ validatePlanFeedback 超长');

  // 非字符串
  assert.strictEqual(KcdPlan.validatePlanFeedback(null), null);
  assert.strictEqual(KcdPlan.validatePlanFeedback(undefined), null);
  assert.strictEqual(KcdPlan.validatePlanFeedback(123), null);
  console.log('✅ validatePlanFeedback 非字符串');
}

// ---------- 运行 ----------
testApiSurface();
testNormalizeEntries();
testSummarizePlan();
testIsExitPlanMode();
testClassifyExitPlanOption();
testValidatePlanFeedback();
console.log('\n🎉 全部测试通过');
