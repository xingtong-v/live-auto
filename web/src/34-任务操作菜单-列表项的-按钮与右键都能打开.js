/* ---------------------------------------------------------------------------
 * 任务操作菜单（列表项的「⋯」按钮与右键都能打开）
 *
 * 为什么需要：进程被强杀后任务会永久停在「切片中」这类状态，
 * 界面上既没有失败提示、也没有重跑入口，用户唯一的出路是手改 ledger.json。
 * ------------------------------------------------------------------------- */
function closeTaskMenu() {
  const m = document.getElementById('taskMenu');
  if (m) m.remove();
  /* 2026-10-16（UI 评审 L-2）：菜单收起后把「⋯」的常显状态也撤掉 */
  $$('#taskList .task.menu-open').forEach((el) => el.classList.remove('menu-open'));
}

/** 复制文本到剪贴板（clipboard API 在非安全上下文不可用，留 execCommand 兜底） */
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${label || ''}`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(`已复制${label || ''}`);
    } catch {
      toast('复制失败，请手动选择文本');
    }
    ta.remove();
  }
}

/**
 * 汇总一个任务已投稿切片的链接（标题 + 视频地址）。
 *
 * 为什么需要：本地删除**不会撤回 B站 上的稿件**，真要下架必须去创作中心。
 * 一次把链接全给用户，省得他一个个点开卡片找 BV 号。
 */
async function collectPublishedLinks(taskId) {
  const d = await api('/api/task/' + encodeURIComponent(taskId));
  return (d.clips || [])
    .filter((c) => c.bvid)
    .map((c) => (c.title || '(无标题)') + '\t' + 'https://www.bilibili.com/video/' + c.bvid);
}

function openTaskMenu(taskId, anchorEl) {
  closeTaskMenu();
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t || !anchorEl) return;
  const running = ['TRANSCRIBING','ANALYZING','CLIPPING','PUBLISHING','PENDING','RECORDED','TRANSCRIBED'].includes(t.status);
  const done = ['PUBLISHED','ARCHIVED'].includes(t.status);
  const menu = document.createElement('div');
  menu.className = 'task-menu';
  menu.id = 'taskMenu';
  menu.innerHTML = `
    <div class="head" title="${esc(t.title)}">${esc(t.title)}${t.publishedCount ? `　·　已投稿 ${t.publishedCount}` : ''}</div>
    <button data-op="open">查看详情</button>
    ${running ? '<button data-op="stop">停止处理</button>' : ''}
    <button data-op="retry">从某阶段重跑…</button>
    <div class="sep"></div>
    ${t.publishedCount ? '<button data-op="copy-links">复制全部稿件链接</button>' : ''}
    ${t.publishedCount ? '<button data-op="center">打开 B站 稿件管理</button>' : ''}
    ${t.publishedCount ? '<div class="sep"></div>' : ''}
    <button data-op="copy">复制任务 ID</button>
    <button data-op="dir">打开产物目录</button>
    ${done ? '<button data-op="perf">刷新稿件表现数据</button>' : ''}
    <div class="sep"></div>
    <button data-op="delete" class="danger">删除任务…</button>`;
  document.body.appendChild(menu);
  /* 2026-10-16（UI 评审 L-2）：「⋯」默认是 opacity:0（悬停才出现）。
     菜单开着时把它保持在可见状态 —— 否则鼠标移到菜单上，触发它的按钮就消失了，
     看起来像菜单凭空冒出来，也失去了"这个菜单属于哪一行"的空间关系。 */
  const row = document.querySelector(`#taskList .task[data-id="${CSS.escape(taskId)}"]`);
  if (row) row.classList.add('menu-open');
  const r = anchorEl.getBoundingClientRect();
  const mw = 200;
  const mh = menu.offsetHeight || 230;
  menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
  menu.style.top = (r.bottom + mh > window.innerHeight ? Math.max(8, r.top - mh) : r.bottom + 4) + 'px';
  menu.querySelectorAll('button[data-op]').forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    const op = b.dataset.op;
    closeTaskMenu();
    handleTaskOp(op, taskId);
  }));
}

async function handleTaskOp(op, taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  try {
    if (op === 'open') {
      if (state.dirty.size && !confirm('有未保存的切片修改，切换任务会丢失。确定切换？')) return;
      state.dirty.clear();
      state.activeId = taskId;
      renderTaskList();
      await loadDetail();
    } else if (op === 'copy-links') {
      const lines = await collectPublishedLinks(taskId);
      if (!lines.length) { toast('该任务还没有已投稿的稿件'); return; }
      await copyText(lines.join('\n'), ` ${lines.length} 条稿件链接（可粘到创作中心核对）`);
    } else if (op === 'center') {
      window.open('https://member.bilibili.com/platform/manage/index', '_blank', 'noopener,noreferrer');
      toast('已打开 B站 稿件管理页 —— 删除已投稿件只能在这里操作', 6000);
    } else if (op === 'copy') {
      try { await navigator.clipboard.writeText(taskId); toast('已复制任务 ID'); } catch { toast(taskId, 6000); }
    } else if (op === 'dir') {
      const d = await api('/api/task/' + encodeURIComponent(taskId));
      openInfo('产物位置', '<div class="kv"><div class="k">任务目录</div><div class="mono-sm" style="word-break:break-all">' + esc(d.taskDirHint || '') + '</div><div class="k">切片产物</div><div class="mono-sm" style="word-break:break-all">' + esc(d.clipsDirHint || '(无)') + '</div></div><p class="hintline">可直接复制上面的路径到资源管理器打开。</p>');
    } else if (op === 'perf') {
      toast('正在拉取稿件表现数据…');
      const r = await api('/api/performance/refresh', { method: 'POST' });
      toast('已更新 ' + r.updated + '/' + r.checked);
    } else if (op === 'stop') {
      if (!confirm('停止处理这个任务？\n\n会把它移出待处理队列并把状态修回可操作状态。\n注意：biliLive-tools 里已在跑的 ffmpeg 会自己跑完。')) return;
      const r = await api('/api/task/' + encodeURIComponent(taskId) + '/stop', { method: 'POST' });
      toast(r.from + ' → ' + r.to + '：' + r.reason, 6000);
      setTimeout(() => refreshAll(true), 700);
    } else if (op === 'retry') {
      openInfo('从某阶段重跑', '<p style="font-size:13px;color:var(--text-2)">转写结果与切片产物都会复用，重跑不会重复产生 ASR 费用。</p><p style="font-size:13px;color:var(--text-2)"><b>重新切片与投稿</b>：先把切片状态重置，再逐片同步 —— 已投过的片通过指纹/反查自动核对回来（不会重复投稿），只有 B站 上确实没有的片才会补投（产物在直接投、缺产物先重切）。</p><div class="chips" id="retryStages">' +
        [['ANALYZED','重新分析（重跑 LLM 选片）'],['TRANSCRIBED','重新转写（复用缓存）'],['RECORDED','从源素材重来'],['CLIPPED','重新切片与投稿']]
          .map(([v, label]) => '<button class="chip" data-stage="' + v + '">' + label + '</button>').join('') + '</div>');
      // ⚠️ 必须用 $$（querySelectorAll）：$ 是 querySelector，返回**单个元素**，
      //    元素上没有 .forEach → 抛 TypeError → 整段绑定从不执行，界面上就是「按钮点不了」
      $$('#retryStages .chip').forEach((c) => (c.onclick = async () => {
        c.classList.add('on');
        try {
          const r = await api('/api/task/' + encodeURIComponent(taskId) + '/retry', { method: 'POST', body: { fromStage: c.dataset.stage } });
          closeInfo();
          toast(r.note || '已提交重跑', 5000);
          setTimeout(() => refreshAll(true), 1200);
        } catch (e) { toast('重跑失败：' + e.message, 5000); c.classList.remove('on'); }
      }));
    } else if (op === 'delete') {
      await openDeleteDialog(taskId);
    }
  } catch (e) {
    toast('操作失败：' + e.message, 6000);
  }
  void t;
}

/** 删除对话框：先给「删什么、释放多少、有没有已投稿切片」的预览，再让用户确认 */
async function openDeleteDialog(taskId) {
  const plan = await api('/api/task/' + encodeURIComponent(taskId) + '/delete-plan');
  const p = plan.plan;
  const rawList = p.rawFiles.filter((r) => r.exists);
  let html = '';
  if (plan.warning) html += '<div class="barstrip warn">' + esc(plan.warning) + '</div>';
  html += '<p style="font-size:13px">勾选要一并删除的内容。<b>默认只删切片产物</b>（最占地方，且随时可重新切）。</p>';
  html += '<div class="fields" style="grid-template-columns:1fr">';
  html += '<div class="field"><label><input type="checkbox" id="delClips"' + (p.clipsFiles ? ' checked' : ' disabled') + '> 切片产物（' + p.clipsFiles + ' 个文件，' + p.clipsMB + ' MB）</label></div>';
  html += '<div class="field"><label><input type="checkbox" id="delTaskDir"> 任务目录（压制产物 ' + (p.taskFullMB || 0) + ' MB + 转写 / 弹幕信号 / 总结 ' + (p.taskMetaMB || 0) + ' MB，合计 ' + p.taskMB + ' MB）</label>';
  html += '<div class="hintline">大头是 full/ 下的压制产物（弹幕版 + 纯净版）。删掉后无法回看本场总结与转写；重跑需重新转写（会再花 ASR 费用）。</div></div>';
  rawList.forEach((r, i) => {
    html += '<div class="field"><label><input type="checkbox" id="delRaw' + i + '"' + (r.sharedWith.length ? ' disabled' : '') + '> 源素材 ' + esc(r.name) + '（' + r.MB + ' MB）' + (r.sharedWith.length ? ' <span style="color:#c8811a">被其它任务共用，已锁定</span>' : '') + '</label></div>';
  });
  html += '</div>';
  html += '<p class="hintline">合计约 ' + p.totalMB + ' MB。删除不可逆，且<b>不会撤回已投稿件</b>。</p>';
  html += '<div style="margin-top:14px"><button class="danger" id="doDelete">确认删除</button></div>';
  openInfo('删除任务：' + String(p.title).slice(0, 28), html);
  $('#doDelete').onclick = async () => {
    let anyRaw = false;
    rawList.forEach((r, i) => {
      const el = document.getElementById('delRaw' + i);
      if (el && el.checked && !el.disabled) anyRaw = true;
    });
    const btn = $('#doDelete');
    const wantTaskDir = !!($('#delTaskDir') && $('#delTaskDir').checked);
    btn.disabled = true;
    try {
      const r = await api('/api/task/' + encodeURIComponent(taskId) + '/delete', {
        method: 'POST',
        body: {
          confirm: true,
          deleteClips: !!($('#delClips') && $('#delClips').checked),
          deleteTaskDir: wantTaskDir,
          deleteRaw: anyRaw,
        },
      });
      closeInfo();
      toast(
        (wantTaskDir ? (r.trashId ? '已移入回收站（可在「设置 → 回收站」恢复），释放 ' : '已删除，释放 ') : '已删除所选文件（任务记录保留，可随时重切），释放 ') +
          r.freedMB + ' MB' + (r.skipped.length ? '（' + r.skipped.length + ' 项跳过）' : ''),
        6000,
      );
      // 只删文件时不要清空选中项，否则用户会以为整个任务也没了
      if (wantTaskDir) {
        if (state.activeId === taskId) state.activeId = null;
        state.dirty.clear();
      }
      setTimeout(() => refreshAll(true), 700);
    } catch (e) {
      toast('删除失败：' + e.message, 6000);
      btn.disabled = false;
    }
  };
}
function renderTaskList() {
  const badge = { processing: 'b-run', review: 'b-wait', failed: 'b-fail', published: 'b-done' };
  const group = (s) => (['PUBLISHED', 'ARCHIVED'].includes(s) ? 'published'
    : s === 'FAILED' ? 'failed' : s === 'ANALYZED' ? 'review' : 'processing');
  const multi = state.multi.on;
  /* ★ 2026-10-11：**测试夹具默认不显示**（用户最早的抱怨就是"列表太长"，而实测每天 38–45 个任务里
     真实直播只有 2–7 场，其余全是 `测试场次`/`【界面测试】…` 这类夹具，由自动化测试造出来）。
     不静默丢弃：条数写在下面的开关上，想看随时点开；成本统计也同步排除（口径见 src/fixtures.ts）。 */
  const all = state.tasks;
  const fixtures = all.filter((t) => t.fixture);
  const shown = showFixtureTasks ? all : all.filter((t) => !t.fixture);
  // 只保留还在列表里的选中项（切换筛选/搜索后不要把看不见的任务也删掉）
  const visible = new Set(shown.map((t) => t.id));
  state.multi.sel.forEach((id) => { if (!visible.has(id)) state.multi.sel.delete(id); });
  $('#taskList').innerHTML = shown.length ? shown.map((t) => {
    const g = group(t.status);
    const extra = [];
    if (t.fixture) extra.push('🔧 测试夹具');
    if (t.progress) extra.push(`${t.progress.label}`);
    if (t.clipCount) extra.push(`${t.clipCount} 候选`);
    if (t.degradedCount) extra.push(`${t.degradedCount} 降级`);
    // 来源标记：目录轮询自动捡起来的（auto）与人工点的（manual）必须一眼分得清
    if (t.importSource === 'auto') extra.push('自动导入');
    else if (t.manual || t.importSource === 'manual') extra.push('手动导入');
    // 在等 biliLive-tools 投完整版：这是默认规则下的正常中间态，必须一眼看出来（否则像卡住了）
    if (t.publishWaiting) extra.push('⏳ 等完整版稿件');
    const picked = state.multi.sel.has(t.id);
    return `<div class="task ${t.id === state.activeId ? 'active' : ''}${picked ? ' picked' : ''}" data-id="${esc(t.id)}">
      ${multi ? `<input type="checkbox" class="pick" data-pick="${esc(t.id)}"${picked ? ' checked' : ''} title="选中这一场">` : ''}
      <div class="when"><span>${esc(t.when)}</span><span>${toMS(t.durationSec)}</span></div>
      <div class="name">${esc(t.title)}</div>
      <div class="meta"><span class="badge ${badge[g] || 'b-idle'}">${esc(t.statusText)}</span>${extra.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
      ${multi ? '' : `<button class="more" data-more="${esc(t.id)}" title="任务操作（右键同样可打开）">⋯</button>`}
    </div>`;
  }).join('') : `<div class="empty" style="padding:16px">${fixtures.length && !showFixtureTasks ? `没有符合条件的真实场次（另有 ${fixtures.length} 个测试夹具被隐藏）` : '没有符合条件的任务'}</div>`;
  /* 夹具开关：只在真的有夹具时出现，且写清"藏了几个"（不静默） */
  const bar = document.getElementById('fixtureToggleBar');
  if (bar) {
    bar.innerHTML = fixtures.length
      ? `<label style="font-size:12px;color:var(--text-3);display:flex;align-items:center;gap:6px;cursor:pointer">
           <input type="checkbox" id="showFixtures"${showFixtureTasks ? ' checked' : ''}> 显示测试夹具（${fixtures.length}）
         </label>`
      : '';
    const cb = document.getElementById('showFixtures');
    if (cb) cb.onchange = () => { showFixtureTasks = cb.checked; renderTaskList(); };
  }

  renderMultiBar();
  // ---- 交互绑定 ----
  // 点击卡片：切换任务；多选模式下改为"勾选/取消"
  $$('#taskList .task').forEach((el) => (el.onclick = () => {
    if (state.multi.on) {
      togglePick(el.dataset.id);
      return;
    }
    if (state.dirty.size && !confirm('有未保存的切片修改，切换任务会丢失。确定切换？')) return;
    state.dirty.clear();
    state.activeId = el.dataset.id;
    renderTaskList();
    loadDetail().catch((e) => toast(e.message));
  }));
  $$('#taskList .task .pick').forEach((c) => (c.onclick = (ev) => {
    ev.stopPropagation();
    togglePick(c.dataset.pick);
  }));

  // 「⋯」按钮：打开操作菜单。
  // 必须 stopPropagation —— 否则点「⋯」会顺带触发任务切换，菜单刚开就被重渲染冲掉。
  $$('#taskList .task .more').forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    openTaskMenu(b.dataset.more, b);
  }));

  // 右键任务卡片：同样打开菜单（Windows 用户的第一直觉）
  $$('#taskList .task').forEach((el) => (el.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openTaskMenu(el.dataset.id, el);
  }));

  // 点空白处 / Esc 关闭菜单（全局只注册一次，避免每次重渲染叠加监听）
  if (!window.__taskMenuCloseBound) {
    window.__taskMenuCloseBound = true;
    document.addEventListener('click', (ev) => {
      const inMenu = ev.target && ev.target.closest && ev.target.closest('.task-menu');
      if (!inMenu) closeTaskMenu();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeTaskMenu(); });
  }
}

/** 勾选/取消一个任务（多选模式） */
function togglePick(id) {
  if (state.multi.sel.has(id)) state.multi.sel.delete(id);
  else state.multi.sel.add(id);
  renderTaskList();
}

/** 多选工具条：选中数量 + 批量操作（「全选已发布」是最常用的那条路） */
function renderMultiBar() {
  const bar = $('#multiBar');
  if (!bar) return;
  if (!state.multi.on) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  const n = state.multi.sel.size;
  const pub = state.tasks.filter((t) => ['PUBLISHED', 'ARCHIVED'].includes(t.status)).length;
  bar.style.display = '';
  bar.className = 'multibar';
  bar.innerHTML = `<span class="cnt">已选 <b>${n}</b> 个</span>
    <button class="btn-sm" data-multi="pub"${pub ? '' : ' disabled'} title="选中当前列表里所有「已发布」的场次">全选已发布（${pub}）</button>
    <button class="btn-sm" data-multi="clear"${n ? '' : ' disabled'}>清空</button>
    <button class="btn-sm" data-multi="retry"${n ? '' : ' disabled'} title="对选中的场次逐个「从失败阶段重跑」（已完成的会跳过）">批量重跑（${n}）</button>
    <button class="btn-sm" data-multi="export"${n ? '' : ' disabled'} title="把选中的场次导成 CSV（场次/标题/切片数/投稿状态/播放）">导出清单（${n}）</button>
    <button class="btn-sm danger" data-multi="del"${n ? '' : ' disabled'}>删除选中（${n}）</button>
    <button class="btn-sm" data-multi="exit">退出多选</button>`;
  $('[data-multi="pub"]').onclick = () => {
    state.tasks.forEach((t) => { if (['PUBLISHED', 'ARCHIVED'].includes(t.status)) state.multi.sel.add(t.id); });
    renderTaskList();
  };
  $('[data-multi="clear"]').onclick = () => { state.multi.sel.clear(); renderTaskList(); };
  $('[data-multi="exit"]').onclick = () => { state.multi.on = false; state.multi.sel.clear(); updateMultiButton(); renderTaskList(); };
  $('[data-multi="del"]').onclick = () => { void openBatchDeleteDialog(); };
  /* 批量重跑（P2 跨场次批量操作）：逐个调既有的「从失败阶段重跑」端点 —— 不新开一条重跑路径。
     刻意**串行 + 逐个报进度**：并发重跑会让多条流水线同时抢 CPU/带宽，也可能撞上投稿风控。 */
  $('[data-multi="retry"]').onclick = async () => {
    const ids = [...state.multi.sel];
    if (!ids.length) return;
    if (!confirm(`对选中的 ${ids.length} 个场次执行「从失败阶段重跑」？\n\n· 已完成的场次会自动跳过\n· 会逐个执行（不并发），进度在右上角提示`)) return;
    let done = 0;
    let skipped = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const r = await api(`/api/task/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} });
        if (r && r.ok === false) skipped++;
        else done++;
      } catch {
        failed++;
      }
      toast(`批量重跑 ${done + skipped + failed}/${ids.length}…`, 1500);
    }
    toast(`批量重跑完成：已触发 ${done}，跳过 ${skipped}，失败 ${failed}`, 6000);
    refreshAll(true).catch(() => undefined);
  };
  /* 导出清单：导的是**屏幕上选中的场次**（与所见一致），不再另查一遍 */
  $('[data-multi="export"]').onclick = () => {
    const rows = state.tasks.filter((t) => state.multi.sel.has(t.id));
    const head = ['场次时间', '标题', '任务ID', '状态', '时长秒', '切片数', '已发布', '待确认', '失败', 'ASR估算', 'LLM实际'];
    const csv = [head.join(',')]
      .concat(
        rows.map((t) =>
          [
            t.when,
            t.title,
            t.id,
            t.status,
            t.durationSec ?? '',
            t.clipCount ?? 0,
            t.publishedCount ?? '',
            t.submittedCount ?? '',
            t.failedCount ?? '',
            t.cost?.asrEstimate ?? '',
            t.cost?.llmActual ?? '',
          ]
            .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
            .join(','),
        ),
      )
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    a.download = `场次清单-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${rows.length} 个场次`, 4000);
  };
}

function updateMultiButton() {
  const b = $('#btnMulti');
  if (!b) return;
  b.textContent = state.multi.on ? '退出多选' : '多选';
  b.classList.toggle('on', state.multi.on);
}

/**
 * 批量删除对话框。
 *
 * 默认与单删一致：**只删切片产物**（最占地方、也最可重建），任务目录与源素材要显式勾。
 * 确认文案必须把三件事说清楚（缺一条用户就会误判后果）：
 *   ① 删几个；② 进回收站可恢复、磁盘空间要等回收站清理才释放；③ **不影响 B站 上的稿件**。
 */
async function openBatchDeleteDialog() {
  const ids = [...state.multi.sel];
  if (!ids.length) return;
  const pubCount = state.tasks.filter((t) => state.multi.sel.has(t.id) && ['PUBLISHED', 'ARCHIVED'].includes(t.status)).length;
  let html = `<p style="font-size:13px">已选中 <b>${ids.length}</b> 个任务${pubCount ? `（其中 ${pubCount} 个已发布）` : ''}。勾选要一并删除的内容，<b>三个勾选项对所选任务统一生效</b>。</p>`;
  html += '<div class="fields" style="grid-template-columns:1fr">';
  html += '<div class="field"><label><input type="checkbox" id="bDelClips" checked> 切片产物（成片 mp4，最占地方，随时可重切）</label></div>';
  html += '<div class="field"><label><input type="checkbox" id="bDelTaskDir"> 任务目录（压制产物 + 转写 / 弹幕信号 / 总结；删掉无法回看本场总结，重跑要重新转写）</label></div>';
  html += '<div class="field"><label><input type="checkbox" id="bDelRaw"> 源素材（录播原文件；被别的任务共用的会自动跳过）</label></div>';
  html += '</div>';
  html += '<p class="hintline">选中的任务记录会被删除（移入回收站，7 天内可恢复）。<b>B站 上的稿件不会被撤回或删除</b> —— 要撤下请到 B站创作中心操作。磁盘空间要等「回收站清理」之后才真正释放。</p>';
  html += '<div style="margin-top:14px"><button class="danger" id="doBatchDelete">确认删除这 ' + ids.length + ' 个任务</button></div>';
  openInfo('批量删除任务', html);
  const btn = $('#doBatchDelete');
  btn.onclick = async () => {
    const wantTaskDir = !!($('#bDelTaskDir') && $('#bDelTaskDir').checked);
    const wantRaw = !!($('#bDelRaw') && $('#bDelRaw').checked);
    const okGo = confirm(
      `确认删除选中的 ${ids.length} 个任务吗？\n\n` +
        `· 切片产物：删除\n` +
        `· 任务目录：${wantTaskDir ? '删除（转写/总结一并消失）' : '保留'}\n` +
        `· 源素材：${wantRaw ? '删除（被共用会自动跳过）' : '保留'}\n\n` +
        '· 全部移入回收站（7 天内可恢复），不是永久删除；\n' +
        '· 磁盘空间要等「回收站清理」之后才真正释放；\n' +
        '· B站 上的稿件「不会」被撤回或删除，要撤下请去创作中心。',
    );
    if (!okGo) return;
    btn.disabled = true;
    btn.textContent = '正在删除…';
    try {
      const r = await api('/api/task/delete-batch', {
        method: 'POST',
        body: { ids, confirm: true, deleteClips: true, deleteTaskDir: wantTaskDir, deleteRaw: wantRaw },
      });
      closeInfo();
      const extra = [];
      if (r.failed && r.failed.length) extra.push(`失败 ${r.failed.length} 个`);
      if (r.skippedCount) extra.push(`跳过 ${r.skippedCount} 项`);
      toast(`${r.note}${extra.length ? `；${extra.join('，')}` : ''}`, 9000);
      if (r.failed && r.failed.length) {
        openInfo(
          '批量删除：有失败项',
          '<div class="timeline">' +
            r.failed.map((f) => `<div class="row bad"><span class="t">✗</span><span class="s"><b>${esc(f.id)}</b><br>${esc(f.error)}</span></div>`).join('') +
            '</div>',
        );
      }
      state.multi.sel.clear();
      if (state.activeId && ids.includes(state.activeId)) state.activeId = null;
      state.dirty.clear();
      setTimeout(() => refreshAll(true), 700);
    } catch (e) {
      toast('批量删除失败：' + e.message, 7000);
    } finally {
      btn.disabled = false;
      btn.textContent = `确认删除这 ${ids.length} 个任务`;
    }
  };
}

