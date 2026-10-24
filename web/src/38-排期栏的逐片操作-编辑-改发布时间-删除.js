/* ============================================================================
 * 排期栏的逐片操作：编辑 / 改发布时间 / 删除
 *
 * 为什么放在排期栏（而不是只在详情页）：用户是在排期栏里"看这一场会发什么"的，
 * 发现某一片不想要、或时间不合适时，就在原地处理，不必先去左侧切到那一场。
 * ========================================================================== */
function bindScheduleActions() {
  /* ★ 2026-10-16（UI 评审 IA-4）：行内「⋯」菜单的开合。
     菜单里的按钮仍带 data-sched-act，由下面那段统一绑事件 —— 这里只管显隐。 */
  const closeAllMenus = () => {
    $$('#schedule .slot-menu').forEach((m) => { m.hidden = true; });
    $$('#schedule [data-slot-more]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  };
  $$('#schedule [data-slot-more]').forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const menu = btn.parentElement.querySelector('.slot-menu');
      const willOpen = menu.hidden;
      closeAllMenus();
      if (willOpen) { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
    };
  });
  /* 点外面 / 按 Esc 收起。挂在 document 上，每次渲染会重复注册 ——
     所以先移除上一次的（用具名函数引用存在窗口上，避免监听器越堆越多）。 */
  if (window.__schedMenuOff) window.__schedMenuOff();
  const onDocClick = () => closeAllMenus();
  const onEsc = (ev) => { if (ev.key === 'Escape') closeAllMenus(); };
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onEsc);
  window.__schedMenuOff = () => {
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onEsc);
  };

  $$('#schedule [data-sched-act]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const taskId = btn.dataset.task;
      const idx = Number(btn.dataset.idx);
      const act = btn.dataset.schedAct;
      if (act === 'edit') {
        // 切到那一场：详情页里有完整的标题/区间/标签编辑器
        state.activeId = taskId;
        await loadDetail();
        renderTaskList();
        toast('已切到该场，可在右侧切片卡片里编辑');
        return;
      }
      closeAllMenus();
      if (act === 'time') return openDtimeEditor(taskId, idx);
      if (act === 'del') return deleteClipFromSchedule(taskId, idx);
    };
  });
}

/** 逐片排期：手填发布时间（或清空回自动排期） */
function openDtimeEditor(taskId, idx) {
  const c = (state.schedule.pending || []).find((x) => x.taskId === taskId && x.index === idx);
  const cur = c && c.dtime ? new Date(c.dtime * 1000) : null;
  const local = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const in2h = local(new Date(Date.now() + 2.5 * 3600_000));
  const tomorrow8 = local(new Date(new Date().setHours(8, 0, 0, 0) + 86_400_000));
  openInfo(
    '改发布时间（切片 #' + idx + '）',
    '<p style="font-size:13px;color:var(--text-2)">B站 要求定时发布时间必须**晚于提交时刻 2 小时以上**（硬约束 #4）。' +
      '手填的时间会盖过自动排期；留空并保存 = 回到自动排期。</p>' +
      `<div style="margin:10px 0"><input id="dtimeInput" type="datetime-local" value="${cur ? local(cur) : in2h}" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px"></div>` +
      '<div class="chips">' +
      `<button class="chip" data-quick="${in2h}">2 小时后</button>` +
      `<button class="chip" data-quick="${tomorrow8}">明天 08:00</button>` +
      `<button class="chip" data-quick="">清空（自动排期）</button>` +
      '</div>' +
      '<div class="modal-foot" style="padding:12px 0 0"><span class="tip" id="dtimeTip"></span>' +
      '<button class="btn-sm" id="dtimeSave" style="margin-left:auto">保存</button></div>',
  );
  $$('#infoBody [data-quick]').forEach((b) => (b.onclick = () => {
    const v = b.dataset.quick;
    if (!v) { $('#dtimeInput').value = ''; return; }
    $('#dtimeInput').value = v;
  }));
  $('#dtimeSave').onclick = async () => {
    const v = $('#dtimeInput').value;
    $('#dtimeTip').textContent = '保存中…';
    try {
      const r = await patchClip(taskId, idx, v ? { dtime: v } : { clearDtime: true });
      for (const w of r.warnings || []) toast(w, 4000);
      toast(v ? '已设置发布时间' : '已改回自动排期');
      closeInfo();
      await loadSchedule();
      if (state.activeId === taskId) await loadDetail();
    } catch (e) {
      // 后端 400 时会带上 earliestAllowed：直接告诉用户最早能选什么时候
      const p = e && e.payload ? e.payload : null;
      let msg = (p && p.error) || e.message;
      if (p && p.earliestAllowed) msg += '（最早可选 ' + fmtTime(p.earliestAllowed * 1000) + '）';
      $('#dtimeTip').textContent = msg;
      toast(msg, 5000);
    }
  };
}

/** 排期栏里直接删掉一条切片 */
async function deleteClipFromSchedule(taskId, idx) {
  const c = (state.schedule.pending || []).find((x) => x.taskId === taskId && x.index === idx);
  if (!confirm(`删除切片 #${idx}？\n\n${c ? c.title : ''}\n\n只从本场清单里移除，不会删掉已切好的成片文件，也不影响 B站 上已有的稿件。`)) return;
  try {
    const r = await api(`/api/task/${encodeURIComponent(taskId)}/clip/${idx}/delete`, { method: 'POST', body: { deleteOutput: false } });
    toast(r.fingerprintsRemoved ? `已删除切片，并清掉 ${r.fingerprintsRemoved} 条幂等指纹` : '已删除切片');
    await loadSchedule();
    if (state.activeId === taskId) await loadDetail();
  } catch (e) {
    toast('删除失败：' + e.message, 5000);
  }
}

function clipStatusText(s) {
  return { CANDIDATE: '候选', PENDING_UPLOAD: '待切片', CUTTING: '切片中', CUT: '已切片', SUBMITTING: '投稿中', SUBMITTED: '已提交待确认', PUBLISHED: '已发布', FAILED: '失败', SKIPPED: '已跳过' }[s] || s;
}

