/* ============================================================================
 * 右栏：发布排期
 * ========================================================================== */
function renderSchedule() {
  const s = state.schedule || { pending: [], published: [], retention: [] };
  const onlySelf = state.bootstrap && state.bootstrap.mode.isOnlySelf;
  const multiPart = !!(state.bootstrap && state.bootstrap.config.publish.multiPart);
  let html = `<div class="sched-group"><div class="sched-title"><b>待发布 ${s.pending.length}</b>
    <span>错峰 ${fmtSpan(state.bootstrap.config.publish.clipGapSec)}</span></div>
    ${multiPart && s.pending.length ? '<div class="hintline" style="margin:2px 0 6px">多分P 模式：整个稿件只有一个发布时间，逐片排期不生效</div>' : ''}
    ${s.pending.length ? s.pending.map((c) => `<div class="slot">
      <span class="t">${c.dtimeText ? esc(c.dtimeText.slice(5, 16)) : '待定'}</span>
      <div class="b"><div class="n">${esc(c.title)}</div>
      <div class="s">${toTime(c.start)} · ${Math.round(c.durationSec)} 秒 · ${esc(clipStatusText(c.status))}${c.degraded ? ' · 降级' : ''}</div>
      <div class="acts">
        <button class="linkbtn" data-sched-act="edit" data-task="${esc(c.taskId)}" data-idx="${c.index}">编辑</button>
        <button class="linkbtn" data-sched-act="time" data-task="${esc(c.taskId)}" data-idx="${c.index}">改发布时间</button>
        <button class="linkbtn" data-sched-act="del" data-task="${esc(c.taskId)}" data-idx="${c.index}" style="color:#c0392b">删除</button>
      </div></div>
    </div>`).join('') : '<div class="empty" style="padding:6px 0">暂无排期</div>'}</div>`;

  html += `<div class="sched-group published"><div class="sched-title"><b>已发布 ${s.published.length}</b>
    ${onlySelf ? '<span style="color:#c8811a">仅自己可见</span>' : ''}</div>
    ${s.published.length ? s.published.map((c) => `<div class="slot"><span class="t">✓</span>
      <div class="b"><div class="n">${esc(c.title)}</div>
      <div class="s">${c.dtimeText ? esc(c.dtimeText.slice(5, 16)) : ''} ${c.url ? `· <a href="${esc(c.url)}" target="_blank" rel="noreferrer">${esc(c.bvid)}</a>` : ''}</div>
    </div></div>`).join('') : '<div class="empty" style="padding:6px 0">暂无</div>'}</div>`;

  html += `<div class="sched-group"><div class="sched-title"><b>素材保留</b><span>缓冲期 ${state.bootstrap.config.cleanup.retentionDays} 天</span></div>
    ${(s.retention || []).slice(0, 12).map((r) => `<div class="slot"><span class="t">${r.keep ? '保' : '删'}</span>
      <div class="b"><div class="n">${esc(r.title)}</div><div class="s">${esc(r.note)}</div></div></div>`).join('') || '<div class="empty" style="padding:6px 0">暂无</div>'}</div>`;

  /* 自动导入：把「它在等什么」摆出来。
     用户看不到等待队列时，会以为轮询没生效 → 自己去手动导入 → 任务标成「手动导入」→ 更困惑。 */
  const w = state.watch;
  if (w && w.enabled) {
    const waiting = (w.lastOutcomes || []).filter((o) => !o.taskId && /等下一轮|仍在写入/.test(String(o.skipped || '')));
    const backlog = (w.lastOutcomes || []).filter((o) => /首次启用时已存在|重新登记基线|轮询启用之前/.test(String(o.skipped || ''))).length;
    html += `<div class="sched-group"><div class="sched-title"><b>自动导入</b>
      <span>每 ${w.intervalSec} 秒扫 ${(w.dirs || []).length} 个目录</span></div>
      <div class="slot"><span class="t">等</span><div class="b">
        <div class="n">${waiting.length ? `正在等 ${waiting.length} 个文件写完` : '暂无等待中的文件'}</div>
        <div class="s">${waiting.length
          ? waiting.slice(0, 3).map((o) => `${esc(o.fileName)}（${esc(String(o.skipped).replace(/（.*/, ''))}）`).join('、')
          : `已自动导入 ${w.importedTotal} 个${backlog ? `；${backlog} 个历史文件按配置不自动导入` : ''}`}</div>
      </div></div>
      <div class="slot"><span class="t">录</span><div class="b">
        <div class="s" style="margin-top:0">路径规则：体积连续两轮不变且稳定 ${w.stableSec || 30} 秒才导（避免导到半场素材）；你手动点的记「手动导入」，它自己捡的记「自动导入」</div>
      </div></div></div>`;
  }
  $('#schedule').innerHTML = html;
  bindScheduleActions();
}

