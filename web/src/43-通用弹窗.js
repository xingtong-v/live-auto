/* ============================================================================
 * 通用弹窗
 * ========================================================================== */
function openInfo(title, html, tip) {
  $('#infoTitle').textContent = title;
  $('#infoBody').innerHTML = html;
  $('#infoTip').textContent = tip || '';
  $('#infoMask').classList.add('show');
}
function closeInfo() { $('#infoMask').classList.remove('show'); }

/* 「报告文件已不存在」的提示条。
 *
 * 为什么要有它：`data/error-report/*.json` 会被清理，也可能当初就没写成功（磁盘满/被 kill），
 * 而 `errors.jsonl` 的事件行（同步追加）还在。服务端现在会**用事件行合成**一份最小报告
 * （`reportFileMissing: true`）。合成件缺的是请求上下文 / biliLive-tools 日志 / 堆栈 ——
 * 必须在弹窗里如实说明，否则用户会把"细节没了"当成"这个错本来就这么点信息"。
 * 三个页签（任务详情 / 健康 / 实时监控）共用这一份，避免以后改一处漏两处。 */
function reportNote(r) {
  const missing = !!(r && r.reportFileMissing);
  return {
    note: missing
      ? `<div class="warnbox">⚠ 原始报告文件已不存在（可能已被清理，或当初写盘失败）。以下内容由
         <code>errors.jsonl</code> 的事件行合成：时间、阶段、类型、消息、重试次数是真的，
         请求上下文 / biliLive-tools 侧日志 / 堆栈已不可得。</div>`
      : '',
    tip: missing ? '降级内容（仅事件记录）—— 已脱敏，可一键复制' : '报告已脱敏，可直接复制给开发者',
  };
}
window.closeInfo = closeInfo;

