/* ============================================================================
 * 中栏交互
 * ========================================================================== */
function bindDetail() {
  const d = state.detail;
  if (!d) return;

  // ---- 任务级操作 ----
  const stopBtn = $('[data-act="stop-task"]');
  if (stopBtn) stopBtn.onclick = async () => {
    if (!confirm('停止处理这个任务？\n\n会把它移出待处理队列并把状态修回可操作状态。\n注意：若 biliLive-tools 里已有 ffmpeg 在跑，它会自己跑完。')) return;
    stopBtn.disabled = true;
    try {
      const r = await api(`/api/task/${encodeURIComponent(d.id)}/stop`, { method: 'POST' });
      toast(`${r.from} → ${r.to}：${r.reason}`, 6000);
      setTimeout(() => refreshAll(true), 800);
    } catch (e) { toast('停止失败：' + e.message, 5000); stopBtn.disabled = false; }
  };

  const retryFromBtn = $('[data-act="retry-from"]');
  if (retryFromBtn) retryFromBtn.onclick = () => {
    openInfo('从某阶段重跑', `
      <p style="font-size:13px;color:var(--text-2)">转写结果与切片产物都会复用，重跑不会重复产生 ASR 费用。</p>
      <div class="fields" style="grid-template-columns:1fr">
        <div class="field"><label>从哪个阶段开始</label>
          <div class="chips" id="retryStages">
            ${[['ANALYZED','重新分析（重跑 LLM 选片）'],['TRANSCRIBED','重新转写（复用缓存）'],['RECORDED','从源素材重来'],['CLIPPED','重新切片与投稿']]
              .map(([v, t]) => `<button class="chip" data-stage="${v}">${t}</button>`).join('')}
          </div></div>
      </div>
      <p class="hintline">当前阶段：${esc(d.stage)}</p>`);
    // ⚠️ 必须用 $$（querySelectorAll）：$ 是 querySelector（单个元素），
    //    对它调 .forEach 会抛 TypeError，导致这 4 个 chip 一个都点不动（用户报过这个问题）
    $$('#retryStages .chip').forEach((c) => (c.onclick = async () => {
      c.classList.add('on');
      try {
        const r = await api(`/api/task/${encodeURIComponent(d.id)}/retry`, { method: 'POST', body: { fromStage: c.dataset.stage } });
        closeInfo();
        toast(r.note || '已提交重跑', 5000);
        setTimeout(() => refreshAll(true), 1200);
      } catch (e) { toast('重跑失败：' + e.message, 5000); c.classList.remove('on'); }
    }));
  };

  // 投稿体检：本场投了几次、有没有重复、bvid 是否可信、标题有没有硬伤
  /* 刷新投稿状态：**真的去 B站 反查一次**（不是重画页面 —— 重画只会把旧状态再显示一遍）。
     用户 2026-10-11 要求：「任务这里加个刷新 用于及时刷新投稿信息」。 */
  const refreshBtn = $('[data-act="refresh-publish"]');
  if (refreshBtn) refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    const old = refreshBtn.textContent;
    refreshBtn.textContent = '反查中…';
    try {
      const r = await api(`/api/task/${encodeURIComponent(d.id)}/refresh-publish`, { method: 'POST' });
      toast(r.note || '已刷新投稿状态', 8000);
      await refreshAll(true);
    } catch (e) {
      toast('刷新失败：' + e.message, 8000);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = old;
    }
  };
  /* 投稿批次时间线（2026-10-11 优化第二批 ②）：批次账的只读呈现。
     逐片状态只说明"某片现在是什么"，批次能说明"这一次投稿整体成没成、缺哪个分P"。 */
  const batchesBtn = $('[data-act="publish-batches"]');
  if (batchesBtn) batchesBtn.onclick = async () => {
    batchesBtn.disabled = true;
    try {
      const r = await api(`/api/task/${encodeURIComponent(d.id)}/batches`);
      const rows = (r.batches || []).map((b) => {
        const st = b.status === 'landed' ? '<b style="color:#2a7">已落地</b>'
          : b.status === 'failed' ? '<b style="color:#c33">提交失败</b>'
          : b.status === 'unconfirmed' ? '<b style="color:#c8811a">未确认</b>' : '已提交（等反查）';
        return `<div class="row ${b.status === 'failed' ? 'bad' : ''}"><span class="t">${fmtTime(Date.parse(b.at))}</span><span class="s">
          <b>${b.kind === 'append' ? '追加进已有稿件' : '新建稿件'}</b> · ${b.parts} 个分P · ${st}${b.bvid ? ` · <a href="https://www.bilibili.com/video/${esc(b.bvid)}" target="_blank" rel="noreferrer">${esc(b.bvid)}</a>` : ''}<br>
          <span style="color:var(--text-3)">批次 ${esc(String(b.uploadTaskId).slice(0, 8))} · 落地 ${b.landed}/${b.parts}${b.missing && b.missing.length ? ` · 缺：${esc(b.missing.map((x) => String(x).slice(0, 16)).join('、'))}` : ''}</span>
          ${b.note ? `<br><span style="color:var(--text-3)">${esc(b.note)}</span>` : ''}
        </span></div>`;
      }).join('');
      openInfo('投稿批次时间线', (r.batches || []).length
        ? `<p style="font-size:13px">本场一共投了 <b>${r.batches.length}</b> 次。每次投稿是一个"批次"：同一个 uploadTaskId 下的分P 一起投、一起确认。</p><div class="timeline">${rows}</div>`
        : `<p>${esc(r.note || '没有批次记录')}</p>`);
    } catch (e) { toast('读取投稿批次失败：' + e.message, 6000); }
    batchesBtn.disabled = false;
  };
  /* 每场复盘报告（2026-10-11 优化第三批 ⑧）：一页看完这一场的产出与待办 */
  const recapBtn = $('[data-act="recap"]');
  if (recapBtn) recapBtn.onclick = async () => {
    recapBtn.disabled = true;
    try {
      const r = await api(`/api/task/${encodeURIComponent(d.id)}/recap`);
      const L = [];
      L.push(`【${r.task.title}】`);
      L.push(`${r.task.when} · ${toTime(r.task.durationSec)} · 状态 ${r.task.status}`);
      L.push('');
      L.push(`切片：共 ${r.clips.total} 个`);
      L.push(Object.entries(r.clips.byStatus).map(([k, v]) => `${k} ${v}`).join(' · ') || '（无切片）');
      if (r.clips.avgScore !== undefined) L.push(`评分：均 ${r.clips.avgScore}（${r.clips.minScore}–${r.clips.maxScore}）`);
      for (const x of r.clips.top) L.push(`  ★ ${Number(x.score).toFixed(1)} ${x.title}`);
      L.push('');
      L.push(`投稿：${r.publish.batches} 次批次（落地 ${r.publish.landed} / 未落地或未确认 ${r.publish.submitted} / 失败 ${r.publish.failed}${r.publish.missingParts ? ` / 缺 ${r.publish.missingParts} 个分P` : ''}）`);
      L.push(`表现：${r.performance.measured} 个稿件拉到数据 · 播放 ${r.performance.view} · 点赞 ${r.performance.like}`);
      L.push(`成本：ASR 估算 ¥${Number(r.transcript.asrEstimate).toFixed(2)}（音频 ${Math.round(r.transcript.asrAudioSeconds / 60)} 分钟）· LLM ¥${Number(r.transcript.llmActual).toFixed(4)}（${r.transcript.llmCalls} 次）`);
      if (r.todos.length) { L.push(''); L.push('需要你处理：'); for (const x of r.todos) L.push(`  ⚠ ${x}`); }
      const text = L.join('\n');
      state.lastCopy = text;
      openInfo('复盘报告 · ' + r.task.when, `<pre class="raw">${esc(text)}</pre><p class="hintline">${esc(r.note)}</p>`);
    } catch (e) { toast('生成复盘报告失败：' + e.message, 6000); }
    recapBtn.disabled = false;
  };
  const auditBtn = $('[data-act="publish-audit"]');
  if (auditBtn) auditBtn.onclick = async () => {
    auditBtn.disabled = true; auditBtn.textContent = '体检中…';
    try {
      // 默认**只做本地分析**（瞬间出结果）：重复投稿、bvid 错配、标题硬伤全在本地数据里。
      // 线上核对单独一个按钮，因为它要访问 B站、慢且对「定时未到点」的稿件必然显示不可见。
      const r = await api(`/api/task/${encodeURIComponent(d.id)}/publish-audit`);
      const rep = r.report;
      const color = rep.verdict.level === 'bad' ? '#c33' : rep.verdict.level === 'warn' ? '#c8811a' : 'var(--green)';
      const batchRows = rep.batches.map((b) => {
        const when = fmtTime(Date.parse(b.at));
        const kind = b.kind === 'multipart' ? `${b.parts.length} 个分P` : b.kind === 'single' ? '单片' : '仅确认';
        const bvid = b.confirmedBvids.length
          ? `${b.confirmedBvids.join(',')}${b.bvidLooksFullVideo ? ' <span style="color:#c33">⚠ 完整版录播的 bvid</span>' : ''}`
          : '<span style="color:var(--text-3)">未反查到 bvid</span>';
        return `<div class="row ${b.bvidLooksFullVideo ? 'bad' : ''}"><span class="t">${when}</span><span class="s"><b>${kind}</b> · ${bvid}<br>${b.parts.map((p) => esc(p.title)).join('<br>')}</span></div>`;
      }).join('');
      const dupRows = rep.duplicates.repeatedClips.length
        ? rep.duplicates.repeatedClips.map((x) => `<div class="row bad"><span class="t">#${x.clipIndex}</span><span class="s">投了 <b>${x.batches}</b> 次：${x.titles.map((t) => esc(t)).join(' ｜ ')}</span></div>`).join('')
        : '<div class="row"><span class="s" style="color:var(--green)">未发现重复投稿</span></div>';
      const titleRows = rep.titles.finalTitles.map((t) => {
        const errs = rep.titles.errors.filter((e) => e.index === t.index);
        const warns = rep.titles.warnings.filter((w) => w.index === t.index);
        const mark = errs.length ? '<span style="color:#c33">✗</span>' : warns.length ? '<span style="color:#c8811a">!</span>' : '<span style="color:var(--green)">✓</span>';
        const notes = [...errs.map((e) => `<span style="color:#c33">必须修：${esc(e.problem.message)}</span>`), ...warns.map((w) => `<span style="color:#c8811a">建议：${esc(w.problem.message)}</span>`)];
        return `<div class="row ${errs.length ? 'bad' : ''}"><span class="t">#${t.index} ${mark}</span><span class="s">${esc(t.title)}${t.finalTitle !== t.title ? `<br><span style="color:var(--text-3)">提交时会变成：${esc(t.finalTitle)}</span>` : ''}${notes.map((n) => `<br>${n}`).join('')}</span></div>`;
      }).join('');
      const visRows = rep.archives.checked.length
        ? rep.archives.checked.map((c) => `<div class="row ${c.visible ? '' : 'bad'}"><span class="t">${c.visible ? '可见' : '不可见'}</span><span class="s">${esc(c.bvid)} ${esc(c.title || '')}<br><span style="color:var(--text-3)">${esc(c.note || '')}</span></span></div>`).join('')
        : '<div class="row"><span class="s" style="color:var(--text-3)">（未做线上核对）</span></div>';
      openInfo('投稿体检', `
        <div class="barstrip" style="border-left:3px solid ${color}">
          <b style="color:${color}">${esc(rep.verdict.summary)}</b>
        </div>
        ${rep.verdict.actions.length ? `<div class="timeline">${rep.verdict.actions.map((a) => `<div class="row bad"><span class="t">建议</span><span class="s">${esc(a)}</span></div>`).join('')}</div>` : ''}
        <h3 style="margin:14px 0 6px">投稿批次（${rep.batches.length} 次）</h3>
        <div class="timeline">${batchRows}</div>
        <h3 style="margin:14px 0 6px">重复投稿</h3>
        <div class="timeline">${dupRows}</div>
        <h3 style="margin:14px 0 6px">标题逐条（80 字符上限）</h3>
        <div class="timeline">${titleRows}</div>
        <h3 style="margin:14px 0 6px">B站 侧可见性</h3>
        <div class="timeline">${visRows}</div>
        <div style="margin-top:12px"><button class="btn-sm" id="auditRemote">核对线上可见性（访问 B站，稍慢）</button></div>
        <p class="hintline">删除/修改线上稿件只能去 B站 创作中心；这里只做检测，不动任何状态。
          「定时发布」未到点的稿件在 B站 侧本来就查不到详情，显示「不可见」是正常的。</p>`);
      { const rb = $('#auditRemote'); if (rb) rb.onclick = async () => {
        rb.disabled = true; rb.textContent = '核对中…';
        try {
          const r2 = await api(`/api/task/${encodeURIComponent(d.id)}/publish-audit?remote=1`);
          const rows = r2.report.archives.checked;
          rb.parentElement.innerHTML = rows.length
            ? `<div class="timeline">${rows.map((c) => `<div class="row ${c.visible ? '' : 'bad'}"><span class="t">${c.visible ? '可见' : '不可见'}</span><span class="s">${esc(c.bvid)} ${esc(c.title || '')}<br><span style="color:var(--text-3)">${esc(c.note || '')}</span></span></div>`).join('')}</div>`
            : '<span class="hintline">没有可核对的 bvid（本场还没反查到稿件号）</span>';
        } catch (e) { toast('核对失败：' + e.message, 5000); rb.disabled = false; rb.textContent = '核对线上可见性（访问 B站，稍慢）'; }
      }; }
    } catch (e) {
      toast('体检失败：' + e.message, 6000);
    }
    auditBtn.disabled = false; auditBtn.textContent = '投稿体检';
  };

  const openDirBtn = $('[data-act="open-dir"]');
  if (openDirBtn) openDirBtn.onclick = () => {
    openInfo('产物位置', `
      <div class="kv">
        <div class="k">任务目录</div><div class="mono-sm" style="word-break:break-all">${esc(d.taskDirHint || '')}</div>
        <div class="k">切片产物</div><div class="mono-sm" style="word-break:break-all">${esc(d.clipsDirHint || '(无)')}</div>
      </div>
      <p class="hintline">可直接复制上面的路径到资源管理器打开。</p>`);
  };

  // 复制已投稿件链接：本地删除不撤回稿件，用户拿到链接才好去创作中心处理
  const copyLinksBtn = $('[data-act="copy-links"]');
  if (copyLinksBtn) copyLinksBtn.onclick = async () => {
    try {
      const lines = await collectPublishedLinks(d.id);
      if (!lines.length) { toast('本场还没有已投稿的稿件'); return; }
      await copyText(lines.join('\n'), ` ${lines.length} 条稿件链接（可粘到创作中心核对）`);
    } catch (e) { toast('获取稿件链接失败：' + e.message, 5000); }
  };

  const delBtn = $('[data-act="delete-task"]');
  if (delBtn) delBtn.onclick = async () => {
    try {
      const plan = await api(`/api/task/${encodeURIComponent(d.id)}/delete-plan`);
      const p = plan.plan;
      openInfo(`删除任务：${p.title.slice(0, 30)}`, `
        ${plan.warning ? `<div class="barstrip warn">${esc(plan.warning)}</div>` : ''}
        <p style="font-size:13px">勾选要一并删除的内容。<b>只勾切片产物时任务记录会保留</b>（转写/信号/总结/投稿记录都还在，可随时重切）；勾选任务目录才会整体移除该任务。</p>
        <div class="fields" style="grid-template-columns:1fr">
          <div class="field"><label><input type="checkbox" id="delClips" ${p.clipsFiles ? 'checked' : ''}> 切片产物（${p.clipsFiles} 个文件，${p.clipsMB} MB）</label></div>
          <div class="field"><label><input type="checkbox" id="delTaskDir"> 任务目录（压制产物 ${p.taskFullMB || 0} MB + 转写 / 弹幕信号 / 总结 ${p.taskMetaMB || 0} MB，合计 ${p.taskMB} MB）</label>
            <div class="hintline">大头是 full/ 下的压制产物（弹幕版 + 纯净版）。<b>勾选它 = 整体删除该任务记录</b>，之后无法回看本场总结与转写；重跑需重新转写（会再花 ASR 费用）</div></div>
          ${p.rawFiles.map((r, i) => `<div class="field"><label><input type="checkbox" id="delRaw${i}" ${r.sharedWith.length ? 'disabled' : ''}> 源素材 ${esc(r.name)}（${r.MB} MB）${r.sharedWith.length ? ` <span style="color:#c8811a">被其它任务共享，已锁定</span>` : ''}</label></div>`).join('')}
        </div>
        <p class="hintline">合计约 ${p.totalMB} MB。文件会先移入回收站（可恢复）。</p>`);
      $('#infoBody').dataset.rawCount = String(p.rawFiles.length);
      $('#infoBody').insertAdjacentHTML('beforeend', '<div style="margin-top:14px"><button class="danger" id="doDelete">确认删除</button></div>');
      $('#doDelete').onclick = async () => {
        const rawIdx = [];
        for (let i = 0; i < Number($('#infoBody').dataset.rawCount || 0); i++) {
          const el = document.getElementById('delRaw' + i);
          if (el && el.checked && !el.disabled) rawIdx.push(i);
        }
        const body = {
          confirm: true,
          deleteClips: $('#delClips').checked,
          deleteTaskDir: $('#delTaskDir').checked,
          deleteRaw: rawIdx.length > 0,
        };
        $('#doDelete').disabled = true;
        try {
          const r = await api(`/api/task/${encodeURIComponent(d.id)}/delete`, { method: 'POST', body });
          closeInfo();
          const kept = body.deleteTaskDir !== true; // 没勾「任务目录」= 只清文件，任务仍在
          toast(
            (kept ? '已删除所选文件（任务记录保留，可随时重切）' : r.trashId ? '已移入回收站（可在「设置 → 回收站」恢复）' : '已删除')
              + `，释放 ${r.freedMB} MB${r.skipped.length ? `（${r.skipped.length} 项跳过）` : ''}`,
            6000,
          );
          // 只有整体删除才清空当前选中项；只删文件时保持选中，否则用户会以为任务也没了
          if (!kept) {
            state.activeId = null;
            state.dirty.clear();
          }
          setTimeout(() => refreshAll(true), 800);
        } catch (e) { toast('删除失败：' + e.message, 6000); $('#doDelete').disabled = false; }
      };
    } catch (e) { toast('无法获取删除预览：' + e.message, 5000); }
  };

  // 重跑
  const retryBtn = $('[data-act="retry"]');
  if (retryBtn) retryBtn.onclick = async () => {
    const stageMap = { '录制': 'RECORDED', '转写': 'TRANSCRIBED', '分析': 'ANALYZED', '切片': 'CLIPPED', '发布': 'PUBLISHED' };
    const from = stageMap[retryBtn.dataset.stage] || d.stage;
    retryBtn.disabled = true; retryBtn.textContent = '已提交…';
    try {
      const r = await api(`/api/task/${encodeURIComponent(d.id)}/retry`, { method: 'POST', body: { fromStage: from } });
      toast(r.note || '已提交重跑');
      setTimeout(() => refreshAll(true), 1500);
    } catch (e) { toast('重跑失败：' + e.message); retryBtn.disabled = false; retryBtn.textContent = '从该阶段重跑'; }
  };

  // 查看日志（渲染后的错误时间线）
  const reportBtn = $('[data-act="report"]');
  if (reportBtn) reportBtn.onclick = async () => {
    try {
      const r = await api('/api/error-report/' + encodeURIComponent(reportBtn.dataset.report));
      const nt = reportNote(r);
      openInfo('错误报告 · ' + reportBtn.dataset.report, nt.note + `<div class="timeline">${(r.report.timeline || []).map((t) =>
        `<div class="row ${t.ok ? '' : 'bad'}"><span class="t">${esc(fmtTime(Date.parse(t.at)))}</span>
         <span class="s"><b>${esc(t.step)}</b>${t.model ? ` <span class="tag-mini">${esc(t.model)}</span>` : ''}${t.detail ? '<br>' + esc(t.detail) : ''}${t.elapsedMs ? ` <span style="color:var(--text-3)">${t.elapsedMs}ms</span>` : ''}</span></div>`).join('')}</div>
        <h3 style="font-size:13px;margin:16px 0 8px">错误本体</h3>
        <div class="kv"><div class="k">类型</div><div>${esc(r.report.error.type)}</div>
        <div class="k">消息</div><div>${esc(r.report.error.message)}</div>
        <div class="k">阶段</div><div>${esc(r.report.stage)}</div></div>
        ${r.report.request ? `<h3 style="font-size:13px;margin:16px 0 8px">请求上下文（已脱敏）</h3><pre class="raw">${esc(JSON.stringify(r.report.request, null, 2))}</pre>` : ''}
        ${r.report.env && r.report.env.biliLiveToolsLogTail ? `<h3 style="font-size:13px;margin:16px 0 8px">biliLive-tools 侧日志片段</h3><pre class="raw">${esc(String(r.report.env.biliLiveToolsLogTail).slice(-3000))}</pre>` : ''}
        <h3 style="font-size:13px;margin:16px 0 8px">完整报告 JSON</h3><pre class="raw">${esc(JSON.stringify(r.report, null, 2))}</pre>`,
        nt.tip);
      state.lastCopy = r.timeline;
    } catch (e) { toast('读取报告失败：' + e.message); }
  };

  // 本场设置的开关：`.switch` 需要**逐个绑定**（本项目没有全局委托），
  // 漏绑的后果是"点了没反应、保存下去永远是 false" —— 实测 `#ovSkip` 和 `#ovFullVideoBy` 都漏过。
  ['#ovSkip', '#ovFullVideoBy'].forEach((sel) => {
    const el = $(sel);
    if (el) el.onclick = () => el.classList.toggle('on');
  });

  // 本场设置
  const saveOv = $('[data-act="save-overrides"]');
  if (saveOv) saveOv.onclick = async () => {
    const skip = $('#ovSkip').classList.contains('on');
    const maxClips = Number($('#ovMaxClips').value) || undefined;
    const extraTags = $('#ovTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const fullVideoBy = $('#ovFullVideoBy') && $('#ovFullVideoBy').classList.contains('on') ? 'assistant' : null;
    const resumeAid = ($('#ovResumeAid') ? $('#ovResumeAid').value.trim() : '') || null;
    try {
      /* ★ 真写台账（以前只是塞进 state.pendingOverrides，从没有发出去 —— 按钮是死的） */
      const r = await api(`/api/task/${encodeURIComponent(d.id)}/overrides`, {
        method: 'POST',
        body: { ...(maxClips !== undefined ? { maxClips } : {}), skipAutoPublish: skip, extraTags, fullVideoBy, resumeAid },
      });
      toast(r.note || '本场设置已保存', 4000);
      state.pendingOverrides = undefined;
      await loadDetail();
    } catch (e) { toast('保存失败：' + e.message, 5000); }
  };

  // 文件预览
  $$('#detail [data-act="preview"]').forEach((el) => el.onclick = async () => {
    const f = el.dataset.file;
    try {
      const res = await fetch(`/api/preview/${encodeURIComponent(d.id)}/${encodeURIComponent(f)}`, { headers: { 'X-CSRF-Token': BOOT.csrf } });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const text = await res.text();
      openInfo(d.id + ' / ' + f, `<pre class="raw">${esc(text.slice(0, 60000))}</pre>`, '仅显示前 60000 字符');
    } catch (e) { toast('预览失败：' + e.message); }
  });

  // 切片卡片
  $$('#detail .clip').forEach((card) => {
    const idx = Number(card.dataset.clip);
    const clip = d.clips.find((c) => c.index === idx);
    if (!clip) return;

    const sel = card.querySelector('[data-act="select"]');
    sel.onchange = () => {
      clip.selected = sel.checked;
      card.classList.toggle('off', !sel.checked);
      updateSelectedCount();
      patchClip(d.id, idx, { selected: sel.checked }).catch((e) => toast(e.message));
    };

    const ti = card.querySelector('[data-act="title"]');
    const cnt = card.querySelector('[data-role="cnt"]');
    ti.oninput = () => {
      const n = ti.value.length;
      cnt.textContent = `${n}/80`;
      cnt.classList.toggle('over', n > 80);
      state.dirty.add(d.id + ':' + idx);
      clearTimeout(card.__titleTimer);
      card.__titleTimer = setTimeout(() => saveTitle(card, d.id, idx, ti.value), 900);
    };
    ti.onblur = () => saveTitle(card, d.id, idx, ti.value);

    card.querySelectorAll('.tinput').forEach((inp) => {
      inp.onchange = async () => {
        const start = toSec(card.querySelector('[data-k="start"]').value);
        const end = toSec(card.querySelector('[data-k="end"]').value);
        if (!(end > start)) { toast('结束时间必须大于开始时间'); return; }
        try {
          const r = await patchClip(d.id, idx, { start, end });
          card.querySelector('[data-role="dur"]').textContent = `${(end - start).toFixed(0)} 秒`;
          card.querySelector('[data-role="changed"]').style.display = 'inline-block';
          inp.classList.add('changed');
          for (const w of (r.warnings || [])) toast(w, 4000);
          toast('时间范围已保存，发布时会重新切片');
        } catch (e) {
          toast('保存失败：' + e.message, 5000);
          inp.value = toTime(inp.dataset.k === 'start' ? clip.start : clip.end);
        }
      };
    });

    /* 试看：**定位切片产物 + 用系统自带播放器前台播放**。
       不转码、不弹大弹窗 —— 点了就直接在系统播放器里看（实测 1.4 秒内完成）。
       失败时才弹说明，并给出替代动作（如实说明，不假装成功）。 */
    card.querySelector('[data-act="preview-cut"]').onclick = async () => {
      const btn = card.querySelector('[data-act="preview-cut"]');
      const old = btn.textContent;
      btn.disabled = true; btn.textContent = '打开中…';
      try {
        const r = await api('/api/preview-cut', { method: 'POST', body: { taskId: d.id, index: idx } });
        if (r.ok) {
          toast(`已用 ${r.player || '系统播放器'} 播放该片段${r.playerForeground ? '' : '（可能被其它窗口挡住）'}`, 3500);
        } else if (r.notCut) {
          openInfo('试看', `<p style="color:#c8811a;font-weight:600">${esc(r.note)}</p>
            <div class="kv">
              <div class="k">区间</div><div class="mono">${toTime(r.startSec)} – ${toTime(r.endSec)}</div>
              <div class="k">源文件</div><div class="mono-sm" style="word-break:break-all">${esc(r.sourcePath || '(未设置)')}</div>
            </div>
            <div style="margin-top:10px"><button class="linkbtn" data-reveal="source">在文件夹中打开源文件</button></div>`);
        } else {
          /* 定位成功但播放器打不开（例如本机 .mp4 关联坏掉 / 没装播放器）：
             给出两个替代动作 —— 在浏览器里看，或去文件夹里拿原件。 */
          openInfo('试看（播放器打开失败）', `
            <p style="color:#c8811a;font-weight:600">${esc(r.note || '未知原因')}</p>
            <div class="kv">
              <div class="k">区间</div><div class="mono">${toTime(r.startSec)} – ${toTime(r.endSec)}</div>
              <div class="k">产物</div><div class="mono-sm" style="word-break:break-all">${esc(r.cutOutput || '')}</div>
            </div>
            <div style="margin-top:10px;display:flex;gap:14px;flex-wrap:wrap">
              <button class="linkbtn" id="pvInline">在浏览器里播放</button>
              <button class="linkbtn" data-reveal="cut">在文件夹中定位产物</button>
            </div>
            <div id="pvBox" style="margin-top:10px"></div>`);
          const bi = document.getElementById('pvInline');
          if (bi) bi.onclick = async () => {
            bi.disabled = true; bi.textContent = '生成中…（首次需转码）';
            try {
              const r2 = await api('/api/preview-cut', { method: 'POST', body: { taskId: d.id, index: idx, inline: true } });
              const box = document.getElementById('pvBox');
              if (box && r2.videoUrl) {
                box.innerHTML = `<video src="${esc(r2.videoUrl)}" controls autoplay muted playsinline
                  style="width:100%;max-height:50vh;background:#000;border-radius:6px;display:block"></video>`;
              } else { toast('内联生成失败：' + (r2.note || ''), 5000); }
            } catch (e) { toast('失败：' + e.message, 5000); }
            bi.disabled = false; bi.textContent = '在浏览器里播放';
          };
        }
        document.querySelectorAll('#infoBody [data-reveal]').forEach((b) => {
          b.onclick = async () => {
            try {
              const rr = await api('/api/reveal', { method: 'POST', body: { taskId: d.id, kind: b.dataset.reveal, index: idx } });
              toast('已打开：' + rr.target, 4000);
            } catch (e) { toast('打开失败：' + e.message, 5000); }
          };
        });
      } catch (e) { toast(e.message, 5000); }
      btn.disabled = false; btn.textContent = old;
    };
    card.querySelector('[data-act="open-llc"]').onclick = () => {
      const llc = d.llcFile;
      openInfo('在 biliLive-tools 中打开', llc
        ? `<p>已为该任务生成项目文件：<code>${esc(llc)}</code></p>
           <p>在 biliLive-tools 的「切片」页面用「打开项目」选择它（位于任务目录）：</p>
           <pre class="raw">${esc(d.source.fullVideoPath || (d.source.segments[0] && d.source.segments[0].name) || '')}</pre>
           <p style="color:var(--text-3);font-size:12.5px">任务目录：data/tasks/${esc(d.id)}/</p>`
        : '<p>尚未生成 .llc 项目文件（分析完成后会生成；若失败请看日志）。</p>');
    };
    /* 单片投稿：与下面批量按钮走**同一个** approve 接口，只是 indices 只有一个。
       先 patch selected=true（勾选状态是权威输入，别依赖界面上的勾），再提交。 */
    const pub1 = card.querySelector('[data-act="publish-this"]');
    if (pub1) pub1.onclick = async () => {
      pub1.disabled = true;
      const old = pub1.textContent;
      pub1.textContent = '提交中…';
      try {
        await patchClip(d.id, idx, { selected: true });
        const r = await api(`/api/task/${encodeURIComponent(d.id)}/approve`, { method: 'POST', body: { indices: [idx] } });
        const c0 = d.clips.find((x) => x.index === idx) || {};
        toast(`已提交「${String(c0.title || '').slice(0, 16)}」（${r.count ?? 1} 个切片）——过审后公开`, 7000);
        setTimeout(() => refreshAll(true), 1500);
      } catch (e) {
        const problems = e.payload && e.payload.problems;
        toast('投稿失败：' + (problems && problems.length ? problems.join('；') : e.message), 9000);
        pub1.disabled = false;
        pub1.textContent = old;
      }
    };
    /* 重投「已提交待确认」的切片（B站 稿件里 1 小时都没出现，反查已告警）。
       这是**唯一**会重投 SUBMITTED 切片的入口，所以必须二次确认：
       若它其实只是 B站 列表慢（或已经在稿件里了），重复投递会在同一稿件里留下重复分P。 */
    const rep1 = card.querySelector('[data-act="republish-this"]');
    if (rep1) rep1.onclick = async () => {
      const c0 = d.clips.find((x) => x.index === idx) || {};
      const okGo = confirm(
        `确认要重新投稿这一片吗？\n\n内容：「${String(c0.title || '')}」\n` +
          (c0.bvid ? `目标稿件：https://www.bilibili.com/video/${c0.bvid}\n` : '') +
          `\n【请先在创作中心确认这个分P 确实不在稿件里】——\n` +
          `· 确实不在 → 点确定，重新投一次；\n` +
          `· 其实在（只是列表延迟）→ 点取消，重复投递会在同一稿件里留下重复分P。`
      );
      if (!okGo) return;
      rep1.disabled = true;
      const old = rep1.textContent;
      rep1.textContent = '重投中…';
      try {
        const r = await api(`/api/task/${encodeURIComponent(d.id)}/approve`, {
          method: 'POST',
          body: { indices: [idx], includeSubmitted: true },
        });
        toast(`已重新提交这一片（${r.count ?? 1} 个切片）——反查确认后会变成「已发布」`, 8000);
        setTimeout(() => refreshAll(true), 1500);
      } catch (e) {
        const problems = e.payload && e.payload.problems;
        toast('重投失败：' + (problems && problems.length ? problems.join('；') : e.message), 9000);
        rep1.disabled = false;
        rep1.textContent = old;
      }
    };
    const recut = card.querySelector('[data-act="recut"]');
    if (recut) recut.onclick = async () => {
      recut.disabled = true;
      try {
        await patchClip(d.id, idx, { selected: true });
        const r = await api(`/api/task/${encodeURIComponent(d.id)}/approve`, { method: 'POST', body: { indices: [idx] } });
        toast('已重新提交切片与投稿');
        setTimeout(() => refreshAll(true), 2000);
      } catch (e) { toast('失败：' + (e.payload && e.payload.problems ? e.payload.problems.join('；') : e.message), 6000); recut.disabled = false; }
    };
    /* 解除墓碑：这是「允许同一内容再投一次」的唯一开关，所以必须二次确认，
       而且确认文案要把不可逆的后果说清楚（旧稿件不会因为本地解除而消失）。 */
    const rel = card.querySelector('[data-act="release-tomb"]');
    if (rel) rel.onclick = async () => {
      const t = (d.clips.find((x) => x.index === idx) || {}).tombstone || {};
      const okGo = confirm(
        '确认要解除墓碑吗？\n\n' +
        '这意味着「同一录制区间」以后可以再次投稿到 B站。\n' +
        (t.bvid ? `请先确认 B站 上 ${t.bvid} 这个稿件确实已经删除。\n` : '请注意：当时并未反查到 bvid，无法确认那次投稿是否成功。\n') +
        '\n解除后重跑本场，这一片会照常切片并投稿。'
      );
      if (!okGo) return;
      rel.disabled = true;
      try {
        const fp = (d.clips.find((x) => x.index === idx) || {}).blockedByTombstone || (t && t.fingerprint);
        const r = await api('/api/tombstone/release', { method: 'POST', body: { fingerprint: fp, confirm: true, note: 'UI 手动解除' } });
        toast(r.note || '已解除墓碑', 6000);
        setTimeout(() => refreshAll(true), 600);
      } catch (e) {
        toast('解除失败：' + e.message, 6000);
        rel.disabled = false;
      }
    };
  });

  const btn = $('#publishBtn');
  if (btn) btn.onclick = async () => {
    /* 只提交**还没投过**的：与卡片上的「投稿这一片」、服务端 approve、publish.ts 的切片段同一判据 */
    const DONE = ['PUBLISHED', 'SUBMITTED', 'SUBMITTING', 'SKIPPED'];
    const indices = state.detail.clips.filter((c) => c.selected && !DONE.includes(c.status)).map((c) => c.index);
    if (!indices.length) {
      toast('选中的切片都已经投过了 —— 没有需要新投的（要重投得先在 B站 删除对应分P）', 8000);
      return;
    }
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const r = await api(`/api/task/${encodeURIComponent(state.activeId)}/approve`, { method: 'POST', body: { indices } });
      const mode = state.bootstrap.mode.isOnlySelf ? '（仅自己可见）' : '';
      toast(`已提交 ${r.count ?? indices.length} 个切片${mode}，按 ${fmtSpan(state.bootstrap.config.publish.clipGapSec)}间隔加入排期`, 5000);
      setTimeout(() => refreshAll(true), 1500);
    } catch (e) {
      const problems = e.payload && e.payload.problems;
      if (problems && problems.length) {
        // 发布前校验未通过：把每一条都列出来，别只给一句概览
        toast('发布前校验未通过：' + problems.join('；'), 10000);
      } else if (e.csrfFailure) {
        // api() 已经自动换过 token 并重试过一次，仍失败说明服务刚重启
        toast('服务刚重启，安全令牌已自动更新 —— 请再点一次投稿按钮', 6000);
      } else {
        toast('发布失败：' + e.message, 8000);
      }
      btn.disabled = false; btn.textContent = `投稿选中的 ${indices.length} 个切片`;
    }
  };
  updateSelectedCount();
}

function updateSelectedCount() {
  const el = $('#cntSelected');
  if (el && state.detail) el.textContent = state.detail.clips.filter((c) => c.selected).length;
  const hint = $('#publishHint');
  if (hint && state.detail) {
    const bad = state.detail.clips.filter((c) => c.selected && (c.degraded && c.title.startsWith('（待填写）') || c.title.length > 80 || c.title.length === 0));
    hint.textContent = bad.length ? `⚠ ${bad.length} 个已选切片标题不合规，发布会被拦下` : '';
  }
}

async function saveTitle(card, taskId, idx, value) {
  const clip = state.detail.clips.find((c) => c.index === idx);
  if (!clip || clip.title === value) { state.dirty.delete(taskId + ':' + idx); return; }
  try {
    const r = await patchClip(taskId, idx, { title: value });
    clip.title = r.clip.title;
    const input = card.querySelector('[data-act="title"]');
    if (input.value !== r.clip.title) input.value = r.clip.title;
    state.dirty.delete(taskId + ':' + idx);
    card.querySelector('[data-role="changed"]').style.display = 'inline-block';
    for (const w of (r.warnings || [])) toast(w, 4000);
    updateSelectedCount();
  } catch (e) { toast('保存标题失败：' + e.message); }
}

async function patchClip(taskId, idx, patch) {
  return api(`/api/task/${encodeURIComponent(taskId)}/clip/${idx}`, { method: 'PATCH', body: patch });
}

