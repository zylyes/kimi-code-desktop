// ACP Elicitation 解析层
// 将 session/request_permission 中 AskUserQuestion 形态解析为问答窗可用结构
// 纯函数，node 可测，无 Electron 依赖
'use strict';

/**
 * 解析 request_permission params，判断是否为 AskUserQuestion elicitation。
 *
 * @param {*} params - request_permission 的 params 对象（原始值，由 main.js 传入）
 * @returns {null|{reason:string}|{questions:Array}}
 *   - null：不是 elicitation（toolCall.title !== 'AskUserQuestion'）
 *   - {reason: 'multi-question'|'bad-option-format'|'no-options'}：需降级的 elicitation
 *   - {questions: Array}：成功解析
 *     questions[].key         - 题号标识，如 'q0'
 *     questions[].text        - 问题文本
 *     questions[].options     - 选项列表 [{optionId, name, kind, isSkip}]
 *     questions[].skipOptionId - skip 选项的 optionId，无则为 null
 */
function parseElicitation(params) {
  if (!params || typeof params !== 'object') return null;
  var tc = params.toolCall;
  if (!tc || typeof tc !== 'object') return null;
  if (tc.title !== 'AskUserQuestion') return null;

  var options = Array.isArray(params.options) ? params.options : [];
  if (options.length === 0) return { reason: 'no-options' };

  // 按题号前缀分组：qNum -> [{optionId, name, kind, isSkip}]
  var groups = {};
  var skipCount = 0;

  for (var i = 0; i < options.length; i++) {
    var o = options[i];
    if (!o || typeof o !== 'object' || typeof o.optionId !== 'string') {
      return { reason: 'bad-option-format' };
    }
    var optMatch = o.optionId.match(/^q(\d+)_opt_(\d+)$/);
    var skipMatch = o.optionId.match(/^q(\d+)_skip$/);
    if (!optMatch && !skipMatch) {
      return { reason: 'bad-option-format' };
    }
    if (skipMatch) {
      var skipKind = typeof o.kind === 'string' ? o.kind : 'reject_once';
      // skip 选项必须为 reject_once（拒绝/跳过类），不可映射的 kind 降级
      if (skipKind !== 'reject_once') return { reason: 'bad-option-format' };
      skipCount++;
      if (skipCount > 1) return { reason: 'bad-option-format' };
      var qn = skipMatch[1];
      if (!groups[qn]) groups[qn] = [];
      groups[qn].push({
        optionId: o.optionId,
        name: typeof o.name === 'string' ? o.name : o.optionId,
        kind: skipKind,
        isSkip: true,
      });
    } else {
      var optKind = typeof o.kind === 'string' ? o.kind : 'allow_once';
      // 正常选项必须为 allow_once（允许/放行类），allow_other 等不可映射形态降级
      if (optKind !== 'allow_once' && optKind !== 'reject_once') return { reason: 'bad-option-format' };
      var qn = optMatch[1];
      if (!groups[qn]) groups[qn] = [];
      groups[qn].push({
        optionId: o.optionId,
        name: typeof o.name === 'string' ? o.name : o.optionId,
        kind: optKind,
        isSkip: false,
      });
    }
  }

  var qNums = Object.keys(groups);
  // 多题形态：无法一次回多个 optionId，降级
  if (qNums.length !== 1) return { reason: 'multi-question' };

  var qNum = qNums[0];
  var opts = groups[qNum];
  var nonSkip = opts.filter(function (o) { return !o.isSkip; });
  if (nonSkip.length === 0) return { reason: 'no-options' };

  // 提取问题文本：防御遍历 toolCall.content[]
  var text = '';
  var contentArr = Array.isArray(tc.content) ? tc.content : [];
  for (var j = 0; j < contentArr.length; j++) {
    var item = contentArr[j];
    if (!item || typeof item !== 'object') continue;
    // 可能的结构：{ type: 'content', content: { type: 'text', text: '...' } }
    // 或 { type: 'text', text: '...' }
    var c = item.content || item;
    if (c && typeof c === 'object') {
      if (typeof c.text === 'string') {
        if (text) text += '\n';
        text += c.text;
      }
    } else if (typeof c === 'string') {
      if (text) text += '\n';
      text += c;
    }
  }
  if (!text) text = '问题';

  var skipOption = null;
  for (var k = 0; k < opts.length; k++) {
    if (opts[k].isSkip) { skipOption = opts[k]; break; }
  }

  return {
    questions: [{
      key: 'q' + qNum,
      text: text,
      options: opts.map(function (o) {
        return { optionId: o.optionId, name: o.name, kind: o.kind, isSkip: o.isSkip };
      }),
      skipOptionId: skipOption ? skipOption.optionId : null,
    }],
  };
}

module.exports = { parseElicitation };
