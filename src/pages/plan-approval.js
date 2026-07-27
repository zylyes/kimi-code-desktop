// Kimi Code Desktop — Plan 模式工具（UMD 双兼容）
// 浏览器：<script src="plan-approval.js"> → window.KcdPlan
// Node：require('./src/pages/plan-approval.js')
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.KcdPlan = factory();
  }
})(this, function () {
  'use strict';

  // ---------- 常量 ----------
  var ENTRIES_MAX = 100;
  var CONTENT_MAX = 500;
  var STATUS_MAX = 40;
  var PRIORITY_MAX = 40;
  var FEEDBACK_MAX = 2000;
  var TITLE_MAX = 200;

  // status 归一化映射（大小写不敏感别名）
  var STATUS_MAP = {
    pending: 'pending',
    in_progress: 'in_progress',
    completed: 'completed',
    'in-progress': 'in_progress',
    inprogress: 'in_progress',
    progress: 'in_progress',
    doing: 'in_progress',
    running: 'in_progress',
    done: 'completed',
    complete: 'completed',
    finished: 'completed',
    success: 'completed',
    ok: 'completed',
  };

  // ---------- 工具函数 ----------
  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

  function trunc(s, max) { return s.length > max ? s.slice(0, max) : s; }

  function normalizeStatus(s) {
    var key = str(s).toLowerCase().trim();
    return STATUS_MAP[key] || 'pending';
  }

  // ---------- 导出 API ----------

  var api = {};

  /**
   * 防御清洗 plan entries 数组
   * @param {*} entries - 原始 entries（可能非数组、元素非法等）
   * @returns {Array<{content:string,status:string,priority:string}>}
   */
  api.normalizePlanEntries = function (entries) {
    if (!Array.isArray(entries)) return [];
    var out = [];
    for (var i = 0; i < entries.length && out.length < ENTRIES_MAX; i++) {
      var e = entries[i];
      if (!e || typeof e !== 'object') continue;
      out.push({
        content: trunc(str(e.content), CONTENT_MAX),
        status: normalizeStatus(e.status),
        priority: trunc(str(e.priority), PRIORITY_MAX),
      });
    }
    return out;
  };

  /**
   * 摘要计划进度
   * @param {Array} entries - 已清洗的 entries
   * @returns {{ total: number, completed: number, inProgress: number, pending: number }}
   */
  api.summarizePlan = function (entries) {
    var total = 0, completed = 0, inProgress = 0, pending = 0;
    if (!Array.isArray(entries)) return { total: 0, completed: 0, inProgress: 0, pending: 0 };
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || typeof e !== 'object') continue;
      total++;
      if (e.status === 'completed') completed++;
      else if (e.status === 'in_progress') inProgress++;
      else pending++;
    }
    return { total: total, completed: completed, inProgress: inProgress, pending: pending };
  };

  /**
   * 识别审批 payload 是否为 ExitPlanMode
   * @param {object} payload - 来自 buildAcpPermissionPayload 的返回（含 title 字段）
   * @returns {boolean}
   */
  api.isExitPlanMode = function (payload) {
    if (!payload || typeof payload !== 'object') return false;
    // title 来自 tc.title，ExitPlanMode 时 title==='ExitPlanMode'
    // 同时检测 options 字段包含 plan_approve/plan_revise/plan_reject_and_exit 之一
    var title = str(payload.title);
    if (title !== 'ExitPlanMode') return false;
    // 副确认：options 应包含 plan_approve
    var opts = Array.isArray(payload.options) ? payload.options : [];
    for (var i = 0; i < opts.length; i++) {
      if (opts[i] && opts[i].optionId === 'plan_approve') return true;
    }
    return false;
  };

  /**
   * 分类 ExitPlanMode 选项
   * @param {string} optionId
   * @returns {'approve'|'revise'|'reject_exit'|null}
   */
  api.classifyExitPlanOption = function (optionId) {
    if (optionId === 'plan_approve') return 'approve';
    if (optionId === 'plan_revise') return 'revise';
    if (optionId === 'plan_reject_and_exit') return 'reject_exit';
    return null;
  };

  /**
   * 反馈文本清洗与校验
   * @param {*} text - 原始输入
   * @returns {string|null} 清洗后的文本，空/无效返回 null
   */
  api.validatePlanFeedback = function (text) {
    if (typeof text !== 'string') return null;
    var t = text.trim();
    if (!t) return null;
    return t.length > FEEDBACK_MAX ? t.slice(0, FEEDBACK_MAX) : t;
  };

  return api;
});
