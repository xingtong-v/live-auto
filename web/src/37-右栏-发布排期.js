/* ============================================================================
 * 右栏：发布排期
 * ========================================================================== */
/* ★ 2026-10-16（用户要求）：「单独投稿 + 定时发布」时，把**每个切片预计几点投出去**直接排出来。
 *
 * 之前未投稿的切片时间列一律写「待定」—— 14 行全是同一个词，用户看不出这一片大概什么时候上，
 * 得自己跑去设置里看首片/末片再心算，等于排期规则没有落到列表上。
 *
 * 口径与「设置 → 首片发布时间」下面那条排期预览完全一致（首片 + 序号 × 间隔），
 * 不在这里另写一套：真正的时间由服务端在**投稿那一刻**按「提交时刻 + 1200 秒余量」定下来，
 * 所以这里算出来的是**预计**，已投出去的（有真实 dtime）优先显示真实值。
 */
function plannedDtimeList(pending, gapSec) {
  const plan = (state.bootstrap && state.bootstrap.dtimePlan) || {};
  /* 立即发布模式下不带 dtime，排不排都一样 —— 直接不显示预计值，免得误导 */
  if (plan.scheduled === false) return new Map();
  /* ⚠️ dtimePlan.first 是 **Unix 秒**（服务端一路用秒，dtime 也是秒），
     而 new Date() / Date 运算要毫秒 —— 忘了 ×1000 会得到 1970-01-22，
     而且 i*gap 只剩 300 毫秒差、14 行全挤在同一分钟里显示成同一个时间。 */
  const baseMs = (Number(plan.first) || 0) * 1000;
  if (!baseMs) return new Map();
  const gapMs = Math.max(60, Number(gapSec) || 300) * 1000;
  const out = new Map();
  let i = 0;
  for (const c of pending) {
    if (!c.dtime) {                       // 有真实 dtime 的不动，只有还没投的才排
      out.set(`${c.taskId}#${c.index}`, baseMs + i * gapMs);
      i++;
    }
  }
  return out;
}

/** 年月日时分 → 「今天 04:12」「10-17 04:12」这种一眼能读的短格式 */
function shortWhen(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
  const tmr = new Date(today.getTime() + 86400000);
  if (d.toDateString() === tmr.toDateString()) return `明天 ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

function renderSchedule() {
  const s = state.schedule || { pending: [], published: [], retention: [] };
  const onlySelf = state.bootstrap && state.bootstrap.mode.isOnlySelf;
  const sched = publishSchedule();
  const appendMode = sched.mode === 'append';
  const planned = plannedDtimeList(s.pending, sched.gapSec);
  const plannedN = planned.size;
  /* ★ 2026-10-22：账号受限横幅。
     为什么必须在这里：闸门命中时 `publishClips` 是**一次提交都不发**的，
     界面上若不说明，用户只会觉得"点了重跑没反应"，然后反复点（每次都在给账号扣分）。 */
  const guard = state.quotaGuard;
  const guardBanner = guard && guard.blocked
    ? `<div class="sched-group" style="border:1px solid #e5484d;background:rgba(229,72,77,.08);padding:10px 12px;margin-bottom:10px">
        <div class="sched-title" style="margin-bottom:4px"><b style="color:#e5484d">账号受限：B站 连续拒绝投稿</b>
          <span>已暂停</span></div>
        <div class="hintline" style="margin:0 0 8px">${esc(guard.note || '')}</div>
        <div class="hintline" style="margin:0 0 8px">期间点「重跑发布阶段」不会发起任何提交，切片原样留在待投；确认 B站 恢复后可手动解除。</div>
        <button class="linkbtn" id="quotaGuardClear">我已确认恢复，解除限制</button>
      </div>`
    : '';
  let html = guardBanner + `<div class="sched-group"><div class="sched-title"><b>待发布 ${s.pending.length}</b>
    <span>${sched.scheduled ? `错峰 ${fmtSpan(sched.gapSec)}` : '立即发布'}</span></div>
    ${s.pending.length ? `<div class="hintline" style="margin:2px 0 6px">${appendMode ? '切片投稿方式：追加切片投稿 —— 整个稿件只有一个发布时间，逐片排期不生效' : `切片投稿方式：单独投稿 —— 每个切片各自一个稿件，固定定时发布、每片相隔 ${fmtSpan(sched.gapSec)}`}${plannedN ? `<br>下面带「预计」的 ${plannedN} 片是<b>按此规则排出来的时间</b>，投稿那一刻才最终确定（本项目要求晚于提交时刻 1200 秒）` : ''}</div>` : ''}
    ${/* ★ 2026-10-16（UI 评审 IA-4）：每行从 3 个文字链收成 1 个 + 「⋯」菜单。
          14 行 × 3 = 42 个 24px 高的目标，降到 14 个；"改发布时间/删除"是低频动作，
          常驻只会把「编辑」这个真正常用的入口淹没。
          时间格式也统一了：原来是「00:00:58 · 432 秒」（hh:mm:ss 与裸秒混排），
          现在两个都用 mm:ss 并加标签前缀。 */ ''}${s.pending.length ? s.pending.map((c) => {
      const pms = planned.get(`${c.taskId}#${c.index}`);
      const timeCell = c.dtimeText
        ? `<span class="t">${esc(c.dtimeText.slice(5, 16))}</span>`
        : pms
          ? `<span class="t tbd" title="按「首片 + 序号 × 间隔」推算出来的预计时间；投稿那一刻才最终确定（本项目要求晚于提交时刻 1200 秒）"><i class="eta">预计</i><b class="eta-t">${esc(shortWhen(pms))}</b></span>`
          : '<span class="t tbd">待定</span>';
      return `<div class="slot">
      ${timeCell}
      <div class="b"><div class="n">${esc(c.title)}</div>
      <div class="s">入点 ${toMS(c.start)} · 时长 ${toMS(c.durationSec)} · ${esc(clipStatusText(c.status))}${c.degraded ? ' · 降级' : ''}</div>
      <div class="acts">
        <button class="linkbtn" data-sched-act="edit" data-task="${esc(c.taskId)}" data-idx="${c.index}">编辑</button>
        <div class="slot-more">
          <button class="linkbtn slot-more-btn" data-slot-more aria-expanded="false" aria-haspopup="true"
            aria-label="更多操作（改发布时间 / 删除）">⋯</button>
          <div class="slot-menu" hidden role="menu">
            <button data-sched-act="time" data-task="${esc(c.taskId)}" data-idx="${c.index}">改发布时间</button>
            <button data-sched-act="del" data-task="${esc(c.taskId)}" data-idx="${c.index}" class="danger">删除</button>
          </div>
        </div>
      </div></div>
    </div>`;
    }).join('') : '<div class="empty" style="padding:6px 0">暂无排期</div>'}</div>`;

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
  /* 解除账号受限：确认后才放行（保留 24h 拒绝计数作参考，闸门不会立刻又关上） */
  const clearBtn = document.getElementById('quotaGuardClear');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      if (!confirm('确认 B站 已经可以正常投稿了吗？\n（建议先到创作中心手动投一个验证；解除后仍会记录本次限制）')) return;
      clearBtn.disabled = true;
      try {
        await api('/api/publish/quota-guard/clear', { method: 'POST', body: { reason: 'ui' } });
        toast('已解除账号受限，可以重跑发布阶段了', 5000);
        await loadSchedule();
      } catch (e) {
        toast('解除失败：' + e.message, 6000);
        clearBtn.disabled = false;
      }
    };
  }
}

