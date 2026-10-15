/* ============================================================================
 * 其它页签：健康 / 成本 / 表现 / Prompt
 * ========================================================================== */
function switchView(v) {
  state.view = v;
  $$('#tabs .tab').forEach((t) => t.classList.toggle('on', t.dataset.view === v));
  const isTasks = v === 'tasks';
  $('#viewTasks').style.display = isTasks ? '' : 'none';
  $('#viewOther').style.display = isTasks ? 'none' : '';
  /* 监控页签自己带定时器：切走就停（没人看的时候不必每 5 秒问一次服务端） */
  if (v === 'monitor') {
    startMonitor();
    loadMonitor(false).catch(() => {});
  } else {
    stopMonitor();
  }
  /* 运行观测页同理：自己带定时器，切走就停。
     ⚠️ 必须**立即拉一次**（照监控页 startMonitor() + loadMonitor() 的写法）——
     只开定时器的话，用户切进来会先看到 5 秒的"加载中…"（第一版就漏了这句，真机验收当场抓到）。 */
  if (v === 'observe') {
    startObserve();
    loadObserve().catch(() => {});
  } else {
    stopObserve();
  }
  if (!isTasks) renderOther(v);
}

async function renderOther(v) {
  const box = $('#otherPage');
  box.innerHTML = '<div class="empty">加载中…</div>';
  try {
    if (v === 'monitor') {
      // 已有数据就直接画（切回来不该重新等一次请求）；没有则拉一次
      if (state.mon.data) return renderMonitor(box);
      await loadMonitor(false);
      return;
    }
    if (v === 'observe') return renderObserve(box);
    if (v === 'health') return renderHealth(box);
    /* 「跑完自动关机」= **独立页面**（iframe，2026-10-14 用户：「独立页面放在健康界面后面」）：
       它有自己的文档与定时器，其它页（尤其运行观测）每 5 秒整块重渲染**碰不到它** ——
       用户报的"界面一直抖"就是这么根治的。结构只建一次：切走再切回来才重建。 */
    if (v === 'autoshutdown') {
      if (!box.querySelector('#sdFrame')) {
        box.innerHTML =
          '<div class="hintline" style="margin:0 0 10px">下面是独立页面（自己的刷新节奏，不受本页影响）。' +
          '也可以直接在浏览器里打开：<a href="/api/shutdown/page" target="_blank" class="mono-sm">/api/shutdown/page</a></div>' +
          '<iframe id="sdFrame" src="/api/shutdown/page" style="width:100%;height:620px;border:0;background:#f6f7f9;border-radius:8px"></iframe>';
      }
      return;
    }
    /* 2026-10-11：待删清单与回收站合并成一页（用户：「待删清单和回收站放一起」） */
    if (v === 'trash') return renderDeletePage(box);
    if (v === 'clips') return renderClipLibrary(box);
    if (v === 'perf') return renderPerf(box);
    if (v === 'prompts') return renderPrompts(box);
  } catch (e) {
    box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function renderHealth(box) {
  const { health, errors } = await api('/api/health');
  /* 墓碑清单单独取（失败不阻塞健康面板的其它部分 —— 它只是个附加视图） */
  let tombstones = [];
  try { tombstones = (await api('/api/tombstones')).tombstones || []; } catch (e) { tombstones = []; }
  const kpi = (k, val, note, cls) => `<div class="kpi ${cls || ''}"><div class="k">${esc(k)}</div><div class="v">${val}</div><div class="n">${esc(note || '')}</div></div>`;
  let html = `<h2 style="font-size:16px;margin:0 0 14px">健康面板
    <button class="btn-sm" style="margin-left:10px" data-act="selfcheck">一键自检</button>
    <button class="btn-sm" data-act="checknow">立即检查录制</button>
    <button class="btn-sm" data-act="perfrefresh">刷新稿件表现数据</button></h2>`;
  /* ★ 2026-10-11（优化第一批 A4）：**统一待办**放最上面 —— 原来要人管的事散在三处
     （未确认投稿在任务列表/切片卡片、失败场次在任务列表、磁盘与待删在各自页面），
     用户问"现在要我做什么"时没人能一句话回答。判据集中在服务端 `/api/todos`（界面与 MCP 共用）。 */
  let todos = { items: [], clean: true, note: '' };
  try {
    todos = await api('/api/todos');
  } catch (e) {
    todos = { items: [], clean: true, note: '待办读取失败：' + e.message };
  }
  /* P1-7（2026-10-13）正文级定位说明：健康面板的入口价值在"待办"，先把它说清楚。 */
  html += `<p class="hintline">这一页回答：<b>现在有没有需要你处理的事</b>（待办在最上面）；往下是连接/磁盘/错误/墓碑这类体检信息。日常只看最上面那块就够。</p>`;
  html += `<div class="card"><h2>待办<span class="ai-tag">${todos.items.length ? `${todos.items.length} 项需要你处理` : '没有需要处理的事'}</span></h2>
    ${todos.items.length
      ? `<div class="timeline">${todos.items
          .map(
            (it) => `<div class="row ${it.level === 'error' ? 'bad' : ''}">
          <span class="t">${it.level === 'error' ? '❗' : '⚠'}</span>
          <span class="s"><b>${esc(it.title)}</b><br><span style="color:var(--text-3)">${esc(it.detail)}</span><br>
          <button class="btn-sm" data-todo="${it.action.kind === 'task' ? `task:${esc(it.action.taskId)}` : `tab:${esc(it.action.view)}`}">${esc(it.actionLabel || '去处理')}</button>
          <button class="linkbtn" data-todo-snooze="${esc(it.key)}" title="24 小时内不再显示这条待办">忽略 24h</button>
          <button class="linkbtn" data-todo-done="${esc(it.key)}" title="已处理，永久隐藏">已处理</button></span>
        </div>`,
          )
          .join('')}</div>`
      : `<p class="hintline" style="color:var(--green)">✅ ${esc(todos.note || '现在没有需要你处理的事。')}</p>`}
    </div>`;
  html += `<div class="kpis">
    ${kpi('biliLive-tools', health.bililive.ok ? '已连接' : '未连接', health.bililive.message, health.bililive.ok ? (health.bililive.drift ? 'warn' : 'ok') : 'bad')}
    ${kpi('版本', esc(health.bililive.version || '?'), `核实版本 ${health.bililive.expected}${health.bililive.drift ? '（差异较大，接口可能已变动）' : ''}`, health.bililive.drift ? 'warn' : '')}
    ${kpi('B站账号', health.account ? (health.account.expired ? '已过期' : '有效') : '未知', health.account ? `${health.account.name || health.account.uid} · ${health.account.message}` : '未获取', health.account && health.account.expired ? 'bad' : health.account && (health.account.daysLeft || 99) <= 7 ? 'warn' : 'ok')}
    ${health.disk ? kpi('磁盘剩余', health.disk.freeGB.toFixed(1) + ' GB', `总 ${health.disk.totalGB.toFixed(0)} GB · 阈值 ${health.disk.thresholdGB} GB`, health.disk.low ? 'bad' : 'ok') : kpi('磁盘', '未知', 'fs.statfs 不可用')}
    ${kpi('今日已投稿', health.dailyLimit > 0 ? `${health.todayPublished} / ${health.dailyLimit}` : `${health.todayPublished}（不限额）`, health.dailyLimit > 0 ? '每日上限' : '上限已关闭', health.dailyLimit > 0 && health.todayPublished >= health.dailyLimit ? 'warn' : '')}
    ${kpi('近 24h 错误', String(health.errorsLast24h), 'errors.jsonl', health.errorsLast24h > 0 ? 'warn' : 'ok')}
    ${kpi('墓碑', String(health.tombstones || 0), (health.tombstones || 0) > 0 ? '已投稿内容被保护性拦下' : '无（没删过已投稿的任务）', (health.tombstones || 0) > 0 ? 'warn' : 'ok')}
    ${kpi('队列', health.queue.busy ? '处理中' : '空闲', `排队 ${health.queue.length}${health.queue.paused ? ' · 磁盘守卫已暂停' : ''}`, health.queue.paused ? 'bad' : '')}
    ${kpi('运行时长', (health.uptimeSec / 3600).toFixed(1) + ' h', `服务版本 ${health.version}`, '')}
  </div>`;

  html += `<div class="card"><h2>模式与配置</h2><div class="kv">
    <div class="k">发布模式</div><div>${health.mode.autoPublish ? '全自动（免确认发布）' : '半自动（需确认后发布）'}</div>
    <div class="k">可见性</div><div>${health.mode.isOnlySelf ? '仅自己可见（试跑期建议保持）' : '<span style="color:#c8811a">公开可见</span>'}</div>
    <div class="k">付费保护</div><div>${health.mode.dryRun ? 'dry-run' + (health.mode.allowPaid ? ' + allow-paid' : '（不调用付费 AI）') : '正常运行'}</div>
    <div class="k">触发状态</div><div>已处理录制 ${health.trigger.processedCount} 条 · 已触发场次 ${health.trigger.firedCount}${health.trigger.lastReconcileAt ? ' · 上次对账 ' + fmtTime(health.trigger.lastReconcileAt) : ''}</div>
    <div class="k">观察中</div><div>${health.trigger.pending.length ? health.trigger.pending.map((p) => esc(p.liveId + '（' + p.reason + '）')).join('；') : '无'}</div>
  </div></div>`;

  html += `<div class="card"><h2>素材占用</h2><div class="kv">
    <div class="k">任务数</div><div>${health.storage.tasks}</div>
    <div class="k">原始分段</div><div>${health.storage.rawGB.toFixed(2)} GB（其中可清理 ${health.storage.deletableRawGB.toFixed(2)} GB）</div>
    <div class="k">压制产物</div><div>${health.storage.fullVideoGB.toFixed(2)} GB（其中可清理 ${health.storage.deletableFullVideoGB.toFixed(2)} GB）</div>
  </div></div>`;

  html += `<div class="card"><h2>Prompt 指纹（system 变化会让 DeepSeek 缓存失效）</h2>
    <table class="tbl"><thead><tr><th>文件</th><th>字节</th><th>开头</th></tr></thead><tbody>
    ${health.prompts.map((p) => `<tr><td class="mono-sm">${esc(p.name)}.md</td><td class="num">${p.bytes}</td><td style="color:var(--text-3)">${esc(p.head)}</td></tr>`).join('')}
    </tbody></table></div>`;

/**
 * 墓碑明细表：默认**收起**。
 *
 * 为什么（用户原话：「显示的太多了」，2026-10-08 截图里 60 条平铺一屏）：
 * 这张表是"查账用"的 —— 平时只需要知道"有多少条在生效、每天会自动核对"，
 * 逐条明细只有真要解除某一个时才需要看。同一个教训本项目已经吃过一次
 * （健康面板「上一轮对每个文件的结论」平铺 35 行），那次也是改成默认收起 + 表头带数量。
 *
 * 用原生 `<details>`：不需要额外绑定，键盘/触屏都能开，也不会像自定义折叠那样漏绑事件。
 */
function tombstoneDetails(tombstones) {
  return `<details>
    <summary style="cursor:pointer;font-size:12.5px;color:var(--text-2)">逐条明细（${tombstones.length} 条，可单条解除）</summary>
    <table class="tbl" style="margin-top:8px"><thead><tr><th>立碑时间</th><th>原任务</th><th>切片</th><th>标题</th><th>旧稿件</th><th>原因</th><th></th></tr></thead><tbody>
    ${tombstones.map((t) => `<tr>
      <td class="mono-sm">${esc(String(t.retiredAt || '').slice(0, 19).replace('T', ' '))}</td>
      <td class="mono-sm">${esc(t.taskId)}</td>
      <td class="num">#${t.clipIndex}</td>
      <td>${esc(String(t.title || '').slice(0, 40))}</td>
      <td>${t.bvid ? `<a href="https://www.bilibili.com/video/${esc(t.bvid)}" target="_blank" rel="noreferrer" class="mono-sm">${esc(t.bvid)}</a>` : '<span style="color:var(--text-3)">未反查到</span>'}</td>
      <td><span class="tag-mini">${t.reason === 'clip-deleted' ? '删了切片' : '删了任务'}</span></td>
      <td><button class="btn-sm" data-act="releasetomb" data-fp="${esc(t.fingerprint)}" data-title="${esc(t.title || '')}" data-bvid="${esc(t.bvid || '')}">解除</button></td>
    </tr>`).join('')}
    </tbody></table>
  </details>`;
}

  html += `<div class="card"><h2>墓碑（已删除任务的、曾经投出去过的指纹）</h2>
    ${tombstones.length === 0
      ? `<div style="font-size:12.5px;color:var(--text-3);line-height:1.7">
           没有墓碑。墓碑只在一种情况下产生：<b>你删掉了一个已经投稿到 B站 的任务</b>。
           那一刻本地的幂等指纹不能跟着丢 —— 否则同一份素材被重新导入、重新分析出同一区间后，
           会在 B站 上投出第二个内容完全相同的稿件（B站 没有删除稿件的开放接口）。
           所以那类指纹会退役成墓碑继续拦着，并出现在这里。它<b>不影响</b>没投出去过的切片：
           删掉不满意的候选后重跑，照常可以投。
         </div>`
      : `<div style="font-size:12.5px;color:#5b5070;margin-bottom:9px;line-height:1.7">
           共 <b>${tombstones.length}</b> 条在生效。它们代表「这段内容以前投过 B站，而当时的任务已被删除」，
           重新投稿时会被自动跳过（切片卡片上会显示「🪦 墓碑拦截」）。
           <b>每天会自动核对一遍：旧稿件查不到的（含已锁定读不到的）自动解除</b>，
           证据不足的（有公开稿件这次没拉到）保留待下次。
           <button class="btn-sm" data-act="reconciletomb" style="margin-left:6px">立即核对一次</button>
         </div>
         ${tombstoneDetails(tombstones)}`}
  </div>`;

  if (errors.length) {
    /* 这份列表是从 errors.jsonl 一路攒下来的（同步追加、几乎不丢），所以会有"陈年旧账"：
       实测 2026-10-07 面板里躺着 12 条两周前、还没切本地 ASR 时的付费闸门/云端接口错误。
       给一个"清空历史"入口（默认先留档到 data/error-archive/），免得只能靠人工删文件。 */
    const old = errors.filter((e) => Date.now() - Date.parse(e.at) > 7 * 86400_000).length;
    html += `<div class="card"><h2>最近错误事件（errors.jsonl）
      <span class="ai-tag">共 ${errors.length} 条${old ? ` · 其中 ${old} 条超过 7 天` : ''}</span>
      <button class="btn-sm" style="margin-left:10px" data-act="clear-errors">清空历史错误</button></h2><table class="tbl">
      <thead><tr><th>时间</th><th>阶段</th><th>类型</th><th>消息</th><th>重试</th><th></th></tr></thead><tbody>
      ${errors.map((e) => `<tr><td class="mono-sm">${esc(fmtTime(Date.parse(e.at)))}</td><td>${esc(e.stage)}</td>
        <td><span class="tag-mini">${esc(e.type)}</span></td><td>${esc(String(e.message).slice(0, 120))}</td><td class="num">${e.retries}</td>
        <td><button class="btn-sm" data-act="openreport" data-report="${esc(e.reportId)}">报告</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  box.innerHTML = html;

  $('[data-act="selfcheck"]').onclick = async () => {
    toast('正在自检…');
    try {
      const r = await api('/api/selfcheck', { method: 'POST' });
      openInfo('一键自检结果', `<div class="timeline">${r.results.map((x) => `<div class="row ${x.ok ? '' : 'bad'}">
        <span class="t">${x.ok ? '✓' : '✗'}</span><span class="s"><b>${esc(x.item)}</b><br>${esc(x.detail)}${x.fix ? `<br><span style="color:#c8811a">修复：${esc(x.fix)}</span>` : ''}</span></div>`).join('')}</div>`,
        r.ok ? '全部通过' : '存在需要处理的问题');
    } catch (e) { toast(e.message); }
  };
  $('[data-act="checknow"]').onclick = async () => {
    try {
      const r = await api('/api/check-now', { method: 'POST' });
      toast(`检查完成：轮询触发 ${r.polled.length}，对账触发 ${r.reconciled.length}。${r.note}`);
      if (r.polled.length || r.reconciled.length) setTimeout(() => refreshAll(true), 1500);
    } catch (e) { toast(e.message); }
  };
  /* 待办条目的动作：跳任务详情 或 跳某个页签（判据在服务端 /api/todos，这里只负责跳） */
  $$('[data-todo-snooze]').forEach((b) => (b.onclick = async () => {
    const key = String(b.dataset.todoSnooze || '');
    if (!confirm('忽略这条待办 24 小时？（到期会自动重新出现）')) return;
    b.disabled = true;
    try { const r = await api('/api/todos/dismiss', { method: 'POST', body: { key, mode: 'snooze', hours: 24 } });
      toast('已忽略 24 小时' + (r.dismissedCount ? '（当前共忽略 ' + r.dismissedCount + ' 项）' : ''), 4000); renderOther('health');
    } catch (e) { toast('忽略失败：' + e.message, 6000); b.disabled = false; }
  }));
  $$('[data-todo-done]').forEach((b) => (b.onclick = async () => {
    const key = String(b.dataset.todoDone || '');
    if (!confirm('标记为「已处理」？会永久隐藏这条待办（恢复需手改 data/todo-dismiss.jsonl）')) return;
    b.disabled = true;
    try { const r = await api('/api/todos/dismiss', { method: 'POST', body: { key, mode: 'done' } });
      toast('已标记处理' + (r.dismissedCount ? '（共 ' + r.dismissedCount + ' 项被忽略/处理）' : ''), 4000); renderOther('health');
    } catch (e) { toast('标记失败：' + e.message, 6000); b.disabled = false; }
  }));
$$('[data-todo]').forEach((b) => (b.onclick = () => {
    const raw = String(b.dataset.todo || '');
    if (raw.startsWith('task:')) {
      const taskId = raw.slice(5);
      state.activeId = taskId;
      state.dirty.clear();
      switchView('tasks');
      loadDetail().catch((e) => toast('打开任务失败：' + e.message, 6000));
      return;
    }
    if (raw.startsWith('tab:')) switchView(raw.slice(4));
  }));
  $('[data-act="perfrefresh"]').onclick = async () => {
    toast('正在拉取稿件表现数据…');
    try {
      const r = await api('/api/performance/refresh', { method: 'POST' });
      perfLastRefresh = r;
      toast(`已更新 ${r.updated}/${r.checked} 个稿件${r.failed.length ? `，${r.failed.length} 个取不到统计` : ''}`);
      renderOther('perf');
    } catch (e) { toast(e.message); }
  };
  $$('[data-act="openreport"]').forEach((b) => b.onclick = async () => {
    try {
      const r = await api('/api/error-report/' + encodeURIComponent(b.dataset.report));
      const nt = reportNote(r);
      openInfo('错误报告 · ' + b.dataset.report, nt.note + `<pre class="raw">${esc(r.timeline)}</pre>`, nt.tip);
      state.lastCopy = r.timeline;
    } catch (e) { toast('读取报告失败：' + e.message); }
  });
  /* 清空历史错误事件：只清 errors.jsonl 的历史（默认先留档），不影响后续记录，也不动报告文件。
     二次确认要把这两点讲清楚 —— 否则用户会以为"清空 = 以后再出错也不报了"。 */
  $$('[data-act="clear-errors"]').forEach((b) => b.onclick = async () => {
    const okGo = confirm(
      '清空历史错误事件（errors.jsonl）吗？\n\n' +
      '· 原文会先留档到 data/error-archive/，需要时仍可 grep 出来；\n' +
      '· 只清历史：之后的错误照常记录，error-report/ 里已生成的报告文件也不动。'
    );
    if (!okGo) return;
    b.disabled = true;
    try {
      const r = await api('/api/errors/clear', { method: 'POST', body: { confirm: true } });
      toast(r.note || `已清空 ${r.removed} 条历史错误`, 9000);
      setTimeout(() => renderHealth(box), 400);
    } catch (e) { toast('清空失败：' + e.message, 8000); b.disabled = false; }
  });
  /* 解除墓碑：这是「允许同一内容再投一次」的唯一开关，必须二次确认，
     且确认文案要把不可逆的后果讲清楚（本地解除不会让旧稿件消失）。 */
  $$('[data-act="releasetomb"]').forEach((b) => b.onclick = async () => {
    const okGo = confirm(
      '确认解除这条墓碑吗？\n\n' +
      `内容：「${b.dataset.title || '(无标题)'}」\n` +
      (b.dataset.bvid ? `旧稿件：${b.dataset.bvid}\n\n请先在创作中心确认该稿件确实已经删除。\n` : '\n注意：当时没有反查到 bvid，无法确认那次投稿是否成功。\n') +
      '\n解除后，同一录制区间可以再次投稿到 B站。'
    );
    if (!okGo) return;
    b.disabled = true;
    try {
      const r = await api('/api/tombstone/release', { method: 'POST', body: { fingerprint: b.dataset.fp, confirm: true, note: '健康面板手动解除' } });
      toast(r.note || '已解除墓碑', 6000);
      setTimeout(() => renderHealth(box), 400);
    } catch (e) { toast('解除失败：' + e.message, 6000); b.disabled = false; }
  });

  /* 立即跑一次自动核对（每天也会自动跑，这里是"等不及/想立刻看结果"的入口）。
     不需要二次确认：它只解除**确实查不到**的（含已锁定读不到的），证据不足的一律保留。 */
  $('[data-act="reconciletomb"]').onclick = async () => {
    const b = $('[data-act="reconciletomb"]');
    b.disabled = true;
    toast('正在核对墓碑（要拉几份稿件详情，稍等）…', 8000);
    try {
      const r = await api('/api/tombstones/reconcile', { method: 'POST' });
      toast(r.note || '核对完成', 12000);
      setTimeout(() => renderHealth(box), 500);
    } catch (e) { toast('核对失败：' + e.message, 8000); b.disabled = false; }
  };
}

