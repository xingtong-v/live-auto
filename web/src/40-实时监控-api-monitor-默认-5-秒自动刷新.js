/* ============================================================================
 * 实时监控（/api/monitor，默认 5 秒自动刷新）
 *
 * 为什么单独做一页而不是把「健康面板」改成自动刷新：
 *   健康面板回答的是"依赖是否正常"（biliLive-tools 连没连上、账号还有几天），
 *   是**偶发查看**的；而用户守着直播时真正要盯的是另外四件事：
 *     ① 现在在干什么（流水线跑到哪一步、进度多少、已经用了多久）
 *     ② 在等什么（等 biliLive-tools 的完整版稿件？等到什么时候？）
 *     ③ 为什么没动（目录轮询上一轮对每个文件下了什么结论 —— 这是"录播没被导入"的唯一答案）
 *     ④ 有没有坏事（最近错误、待删清单到期）
 *   把这四件事做成每 5 秒自刷的新页，既不动原有页面（改坏风险为零），也符合"守着看"的用法。
 * ========================================================================== */

/** 可选的自动刷新间隔（秒）；0 视为暂停 */
const MON_INTERVAL_OPTIONS = [3, 5, 10, 30];

function stopMonitor() {
  const m = state.mon;
  if (m.timer) { clearInterval(m.timer); m.timer = null; }
}

function startMonitor() {
  const m = state.mon;
  stopMonitor();
  if (m.paused) return;
  m.timer = setInterval(() => {
    if (state.view !== 'monitor' || document.hidden) return;
    loadMonitor(true).catch(() => {});
  }, Math.max(1, m.interval) * 1000);
}

/**
 * 数据指纹：去掉**每次必然变化**的字段再比，用来决定"要不要整页重画"。
 * 不这么做的话，5 秒一次的 innerHTML 重画会把页面变成闪烁的幻灯片。
 *
 * 实测踩到的坑（都是浏览器端到端测试 + 两次快照对比抓到的）：
 *   ① 忘了去掉 `now` —— 它是每次请求都变的时间戳，于是指纹永远不同、永远重画；
 *   ② 磁盘余量 `freeGB` 是浮点数，服务每写一行日志它就变一点点（0.00x GB），
 *      按**显示精度**（0.1 GB）比才不会因为看不见的变化而重画；原始字节数 `freeBytes` 直接跳过；
 *   ③ `account.daysLeft` 是连续倒计时（89.990336 → 89.990301），同样按显示精度比。
 */
function monSignature(d) {
  const SKIP = new Set([
    'now', 'uptimeSec', 'lastScanAgoSec', 'elapsedSec', 'remainSec', 'nextDueSec', 'scanning',
    // 原始字节数：面板显示的是 GB（已按 0.1 GB 比），这两个字段每写一行日志都在动
    'freeBytes', 'totalBytes',
  ]);
  const ROUND1 = new Set(['freeGB', 'totalGB', 'daysLeft']);
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === 'object') {
      return Object.fromEntries(
        Object.entries(o)
          .filter(([k]) => !SKIP.has(k))
          .map(([k, v]) => [k, ROUND1.has(k) && typeof v === 'number' ? Number(v.toFixed(1)) : walk(v)]),
      );
    }
    return o;
  };
  try { return JSON.stringify(walk(d)); } catch { return String(Date.now()); }
}

async function loadMonitor(silent) {
  const m = state.mon;
  if (m.busy) return;
  m.busy = true;
  try {
    const d = await api('/api/monitor');
    m.data = d;
    m.lastAt = Date.now();
    m.lastError = '';
    const sig = monSignature(d);
    if (silent && sig === m.sig) {
      // 数据没变：只更新"最后更新"这一行，不重画（避免闪烁/打断滚动）
      const el = $('#monUpdated');
      if (el) el.textContent = `最后更新 ${new Date(m.lastAt).toLocaleTimeString()} · 无变化`;
    } else {
      m.sig = sig;
      renderMonitor($('#otherPage'));
    }
  } catch (e) {
    m.lastError = e.message;
    if (!m.data) $('#otherPage').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    else {
      const el = $('#monUpdated');
      if (el) el.textContent = `刷新失败（显示的是旧数据）：${e.message}`;
    }
  } finally {
    m.busy = false;
  }
}

/* ★ 2026-10-15：任务时长表（id → durationSec）**必须在模块级** ——
   我第一次写在了渲染函数里，函数每 5 秒跑一次 ⇒ 缓存每次被重置 ⇒ 进度永远算不出来（实测页面空白无进度）。
   60 秒拉一次 /api/tasks 就够，别每 5 秒拉。 */
let txDurCache = { at: 0, map: {} };

function renderMonitor(box) {
  const m = state.mon;
  const d = m.data;
  if (!d) {
    box.innerHTML = '<div class="empty">加载中…</div>';
    return;
  }
  const kpi = (k, v, n, cls) => `<div class="kpi ${cls || ''}"><div class="k">${esc(k)}</div><div class="v ${String(v).length > 8 ? 'sm' : ''}">${v}</div><div class="n">${esc(n || '')}</div></div>`;
  const badge = (txt, cls) => `<span class="badge ${cls}">${esc(txt)}</span>`;
  const fileBase = (p) => String(p || '').split(/[\\/]/).pop();
  const secText = (s) => {
    const n = Math.max(0, Math.round(Number(s) || 0));
    if (n < 60) return `${n} 秒`;
    if (n < 3600) return `${Math.floor(n / 60)} 分 ${n % 60} 秒`;
    return `${Math.floor(n / 3600)} 小时 ${Math.floor((n % 3600) / 60)} 分`;
  };
  const statusBadge = (status) => {
    const map = { PUBLISHED: ['已投稿', 'b-done'], ARCHIVED: ['已归档', 'b-done'], FAILED: ['失败', 'b-fail'], PUBLISHING: ['投稿中', 'b-run'], CLIPPING: ['切片中', 'b-run'], ANALYZING: ['分析中', 'b-run'], TRANSCRIBING: ['转写中', 'b-run'], CLIPPED: ['已切片', 'b-wait'], ANALYZED: ['待确认', 'b-wait'], PENDING: ['排队中', 'b-idle'], RECORDED: ['已录制', 'b-idle'] };
    const [txt, cls] = map[status] || [status, 'b-idle'];
    return badge(txt, cls);
  };

  /* ---- 顶部：这一页是什么、多久刷一次、最后更新 ---- */
  let html = `<h2 style="font-size:16px;margin:0 0 14px">实时监控
    <span class="mono-sm" id="monUpdated" style="font-weight:400;color:var(--text-3)">
      最后更新 ${m.lastAt ? new Date(m.lastAt).toLocaleTimeString() : '—'}${m.paused ? ' · 已暂停' : ` · 每 ${m.interval} 秒`}</span>
    <span style="margin-left:auto;display:flex;gap:8px;align-items:center">
      <select id="monAuto" class="tinput" style="width:auto">
        ${MON_INTERVAL_OPTIONS.map((s) => `<option value="${s}"${s === m.interval && !m.paused ? ' selected' : ''}>每 ${s} 秒</option>`).join('')}
        <option value="0"${m.paused ? ' selected' : ''}>暂停自动刷新</option>
      </select>
      <button class="btn-sm" data-act="mon-refresh">立即刷新</button>
    </span></h2>`;

  /* ---- 状态灯 ---- */
  const h = d;
  const acct = h.account;
  html += `<div class="kpis">
    ${kpi('biliLive-tools', h.bililive && h.bililive.ok ? '已连接' : '未连接', h.bililive ? `${h.bililive.version || '?'}（核实 ${h.bililive.expected}）` : '', h.bililive && h.bililive.ok ? (h.bililive.drift ? 'warn' : 'ok') : 'bad')}
    ${kpi('B站账号', acct ? (acct.expired ? '已过期' : '有效') : '未知', acct ? `${acct.name || acct.uid}${acct.daysLeft ? ' · 剩 ' + acct.daysLeft.toFixed(1) + ' 天' : ''}` : '未获取', acct && acct.expired ? 'bad' : acct && acct.daysLeft <= 7 ? 'warn' : 'ok')}
    ${kpi('磁盘剩余', h.disk ? h.disk.freeGB.toFixed(1) + ' GB' : '未知', h.disk ? `总 ${h.disk.totalGB.toFixed(0)} GB · 阈值 ${h.disk.thresholdGB} GB` : '', h.disk && h.disk.low ? 'bad' : 'ok')}
    ${kpi('队列', h.queue && h.queue.busy ? '处理中' : '空闲', `排队 ${h.queue ? h.queue.length : 0}${h.queue && h.queue.paused ? ' · 磁盘守卫已暂停' : ''}`, h.queue && h.queue.paused ? 'bad' : '')}
    ${kpi('今日已投稿', h.dailyLimit > 0 ? `${h.todayPublished} / ${h.dailyLimit}` : String(h.todayPublished), h.dailyLimit > 0 ? '每日上限' : '不限额', h.dailyLimit > 0 && h.todayPublished >= h.dailyLimit ? 'warn' : '')}
    ${kpi('今日花费', '¥' + Number(h.costToday.total || 0).toFixed(2), `转写 ¥${Number(h.costToday.asr || 0).toFixed(2)} · 分析 ¥${Number(h.costToday.llm || 0).toFixed(4)}`, '')}
    ${kpi('待删清单', String(h.pendingDelete.count || 0), h.pendingDelete.count ? `共 ${h.pendingDelete.totalMB} MB${h.pendingDelete.nextDueSec !== null ? ' · 最近 ' + secText(h.pendingDelete.nextDueSec) + ' 后' : ''}` : '没有待删文件', h.pendingDelete.overdueCount ? 'warn' : '')}
    ${kpi('近 24h 错误', String(h.errorsLast24h), h.errors.length ? `最近：${h.errors[0].type}` : '没有错误事件', h.errorsLast24h > 0 ? 'warn' : 'ok')}
  </div>`;
  if (h.healthError) html += `<div class="barstrip warn">健康检查失败：<b>${esc(h.healthError)}</b> —— 下面显示的是"能拿到的那部分"，不代表助手没在跑。</div>`;

  /* ---- ① 现在在干什么 ---- */
  const stageStrip = (p) => (h.stageLabels || []).map((label, i) => {
    const st = (p.stages && p.stages[i]) || 'todo';
    const mark = st === 'done' ? '✓' : st === 'fail' ? '!' : st === 'active' ? '•' : '';
    /* 阶段条上的小数字：有**实测**百分比就用它（转写），否则用块数（分析/切片那两条链） */
    const g = p.progress;
    const prog = st !== 'active' || !g
      ? ''
      : typeof g.pct === 'number'
        ? `<span class="prog">${g.pct}%</span>`
        : g.total
          ? `<span class="prog">${g.current}/${g.total}</span>`
          : '';
    return `<span class="stage ${st}"><span class="dot">${mark}</span>${esc(label)}${prog}</span>`;
  }).join('<span class="arrow">›</span>');

  /* P1-7 正文级定位说明：这一页是"直播进行中盯一眼"用的，和"跑完复盘"要分清。 */
  html += `<p class="hintline">这一页回答：<b>现在在干什么、在等什么、为什么没动</b>（默认 5 秒自动刷新，适合直播进行中盯一眼）。跑完一场的产出请到「任务」里看复盘报告。</p>`;
  /* ★ 2026-10-15 第二版（用户："精确进度"）：服务端现在给**实测**字段 ——
     `p.progress` 里带 pct / audioDoneSec / audioTotalSec / etaSec / speed / phase。
     来源：本地 ASR 执行器把一块音频切成若干子批推理，每批上报"已经推进到本块音频的第几秒"
     + 实测速度 ⇒ 百分比是**量出来的**，剩余时间 = 剩余音频 ÷ 实测速度 + 还没开始的块 × 单块固定成本。
     ⚠️ 有实测数据时**只显示实测**，不再叠加下面那套估算（两套数字同时出现会互相打架）。 */
  const txMeasuredOf = (p) => {
    const g = p && p.progress;
    if (!g || typeof g.pct !== 'number' || !(Number(g.audioTotalSec) > 0)) return null;
    return g;
  };
  const txMeasuredLine = (g) => {
    const eta = g.etaSec === null || g.etaSec === undefined ? null : Math.max(0, Number(g.etaSec));
    const left = eta === null ? '<b>计算中</b>（还没测到速度）' : `还需约 <b>${secText(eta)}</b>`;
    const speed = typeof g.speed === 'number' && g.speed > 0 ? `实测 ${(1 / g.speed).toFixed(2)}× 音频时长` : '速度测量中';
    /* 分块信息：多块时百分比会"跳"（一块跑完就前进一大格），标出"第几块"才不会被误读成卡顿。
       ⚠️ chunksDone 已经等于 chunksTotal 时要夹住，否则会出现"第 3/2 块"这种读不通的文案。 */
    const chunkInfo =
      Number(g.chunksTotal) > 1
        ? ` · 第 ${Math.min(Number(g.chunksDone || 0) + 1, Number(g.chunksTotal))}/${g.chunksTotal} 块`
        : '';
    const title =
      `实测：已识别 ${secText(g.audioDoneSec)} / ${secText(g.audioTotalSec)} 音频` +
      `（第 ${g.chunksDone || 0}/${g.chunksTotal || 0} 块，${g.phase || '—'}）；${speed}；` +
      `剩余 = 剩余音频 ÷ 实测速度 + 未开始的块 × 单块固定成本（抽音频+切句+加载模型 ≈90–100 秒）。` +
      `计时自 ${g.startedAt ? new Date(g.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}。`;
    return `<div class="mono-sm" style="color:var(--text-3)" title="${esc(title)}">转写进度 <b>${g.pct}%</b> · ${secText(g.audioDoneSec)} / ${secText(g.audioTotalSec)} 音频 · ${left}<span style="color:var(--text-3)">（${esc(g.phase || '')}${chunkInfo}）</span></div>`;
  };
  /* 兜底（**估算**）：服务端没有实测数据时（旧服务 / 云端 · whisper 路径）才用。
     接口里没有"本次转写开始于何时"，所以由本页记录"它第一次以 TRANSCRIBING 出现的时刻"，
     存 localStorage（刷新不丢）。速度按本机实测标称值 0.25×音频时长 —— 它是**猜**的，
     页面上必须写清"（估算）"，不许冒充精确值。 */
  const TX_RTF = 0.25;
  const txAnchors = (() => {
    try {
      return JSON.parse(localStorage.getItem('liveauto.tx.anchor') || '{}');
    } catch {
      return {};
    }
  })();
  const txSaveAnchors = () => {
    try {
      localStorage.setItem('liveauto.tx.anchor', JSON.stringify(txAnchors));
    } catch {
      /* 隐私模式/禁用存储：退化为"本次页面会话内有效" */
    }
  };
  const txAnchorOf = (p, nowMs) => {
    if (p.status === 'TRANSCRIBING') {
      if (!txAnchors[p.id]) {
        txAnchors[p.id] = nowMs;
        txSaveAnchors();
      }
      return txAnchors[p.id];
    }
    /* 已经不是转写了：留 6 小时便于回看，再久就清掉，别让 localStorage 无限长 */
    if (txAnchors[p.id] && nowMs - txAnchors[p.id] > 6 * 3600_000) {
      delete txAnchors[p.id];
      txSaveAnchors();
    }
    return undefined;
  };
  /** 只有"正在转写"才有进度；音频时长取 /api/tasks 的 durationSec */
  const txProgressOf = (p, durationSec, nowMs) => {
    const anchor = txAnchorOf(p, nowMs);
    /* 调试出口：界面上一旦不显示，能立刻看出是"状态不对/没锚点/没时长"哪一类（2026-10-15 排查用） */
    const dbg = (why) => {
      try {
        window.__txDebug = window.__txDebug || {};
        window.__txDebug[p.id] = {
          status: p.status,
          hasAnchor: Boolean(anchor),
          durationSec: durationSec ?? null,
          cacheKeys: Object.keys(txDurCache.map || {}).length,
          cacheAt: txDurCache.at ? new Date(txDurCache.at).toISOString() : null,
          why,
        };
      } catch {
        /* 忽略 */
      }
      return null;
    };
    if (p.status !== 'TRANSCRIBING') return dbg('状态不是 TRANSCRIBING');
    if (!anchor) return dbg('没有锚点');
    const audioSec = Number(durationSec || 0);
    if (!(audioSec > 0)) return dbg('没有音频时长（/api/tasks 还没回来？）');
    const totalMs = audioSec * 1000 * TX_RTF;
    const pct = Math.max(1, Math.min(99, Math.round(((nowMs - anchor) / totalMs) * 100)));
    return { pct, leftSec: Math.max(0, Math.round((totalMs - (nowMs - anchor)) / 1000)), audioSec };
  };
  /* 任务时长表：60 秒缓存（缓存在**模块级**，见 txDurCache） */
  const txEnsureDurations = () => {
    if (Date.now() - txDurCache.at < 60_000) return;
    txDurCache.at = Date.now();
    fetch('/api/tasks?limit=50')
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((j) => {
        const map = {};
        for (const x of j.tasks || []) map[x.id] = x.durationSec;
        txDurCache.map = map;
        try {
          window.__txFetch = { ok: true, keys: Object.keys(map).length };
        } catch {
          /* 忽略 */
        }
        /* ★ 必须自己重画一次：loadMonitor(true) 有"签名相同就不重画"的快路径（见本文件 L540 的注释），
           监控数据没变时根本不会走 renderMonitor ⇒ 进度行永远出不来。
           实测就是卡在这一步：时长拿到了（keys: 6），页面上却一直没有那行。 */
        try {
          if (state.view === 'monitor') renderMonitor($('#otherPage'));
        } catch {
          /* 重画失败不影响其它 */
        }
      })
      .catch((e) => {
        /* ⚠️ 原来这里吞掉了错误 ⇒ 界面只是"不显示进度"，查不出为什么（实测就卡在这一步） */
        try {
          window.__txFetch = { ok: false, error: String((e && e.message) || e) };
        } catch {
          /* 忽略 */
        }
      });
  };
  txEnsureDurations();

  html += `<div class="card"><h2>流水线（现在在干什么）${d.pipeline.length ? badge(`${d.pipeline.length} 个活跃任务`, 'b-run') : badge('空闲', 'b-idle')}</h2>`;
  if (d.pipeline.length) {
    html += `<table class="tbl"><thead><tr><th>任务</th><th>状态</th><th style="width:46%">阶段</th><th>已用</th><th class="num">花费</th></tr></thead><tbody>
      ${d.pipeline.map((p) => `<tr>
        <td><a href="#" data-act="mon-open" data-id="${esc(p.id)}" style="color:inherit;text-decoration:none;border-bottom:1px dotted #c9ced4">${esc(p.title)}</a>
          <div class="mono-sm" style="color:var(--text-3)">${esc(p.streamer || '')} · ${esc(p.id)} · ${esc(p.importSource === 'auto' ? '自动导入' : p.importSource === 'manual' ? '手动导入' : '录制触发')}</div></td>
        <td>${statusBadge(p.status)}${p.publishWaiting ? badge('等完整稿件', 'b-wait') : ''}${p.hasError ? badge('有错误', 'b-fail') : ''}
          <div class="mono-sm" style="color:var(--text-3)">${esc(p.statusText || '')}</div>
          ${(() => {
            const g = txMeasuredOf(p);
            if (g) return txMeasuredLine(g);
            const e = txProgressOf(p, txDurCache.map[p.id], Date.now());
            if (!e) return '';
            return `<div class="mono-sm" style="color:var(--text-3)" title="服务端没给实测进度，这里是**估算**：按本机标称速度（约 ${TX_RTF}×音频时长）与本页第一次看到它开始转写的时刻推算；刚打开页面时数值会偏低">转写进度 <b>${e.pct}%</b> · 还需约 ${secText(e.leftSec)}<span style="color:var(--text-3)">（估算）</span></div>`;
          })()}</td>
        <td><div class="stages" style="margin:0">${stageStrip(p)}</div></td>
        <td class="mono-sm">${secText(p.elapsedSec)}</td>
        <td class="num">¥${Number(p.costYuan || 0).toFixed(2)}</td></tr>`).join('')}
    </tbody></table>`;
  } else {
    html += `<div class="empty">没有正在处理的任务${h.queue && h.queue.busy ? '（队列标记为处理中，可能是刚结束一跳）' : ''}。新录播出现后这里会自动冒出来。</div>`;
  }
  html += `</div>`;

  /* ---- ② 在等什么 ---- */
  const noWait = !d.waiting.length && !d.scheduled.count && !d.pendingDelete.count;
  html += `<div class="card"><h2>在等什么</h2>`;
  if (noWait) html += `<div class="empty">没有等待项：没有任务在等完整版稿件，也没有排期待投的切片。</div>`;
  if (d.waiting.length) {
    html += `<h3 style="font-size:13px;margin:8px 0 8px">等 biliLive-tools 投出完整版（投出后切片会自动追加成分P）</h3>
      <table class="tbl"><thead><tr><th>任务</th><th>为什么等</th><th>剩余</th><th class="num">已试</th></tr></thead><tbody>
      ${d.waiting.map((w) => `<tr><td>${esc(w.title)}<div class="mono-sm" style="color:var(--text-3)">${esc(w.id)}</div></td>
        <td>${esc(w.reason)}</td>
        <td class="mono-sm">${w.expired ? '<span style="color:#c8811a">已超时，等人工处理</span>' : secText(w.remainSec)}</td>
        <td class="num">${w.attempts}</td></tr>`).join('')}</tbody></table>`;
  }
  if (d.scheduled.count || d.cutAwaitingCount) {
    html += `<h3 style="font-size:13px;margin:14px 0 8px">已排期待投（${d.scheduled.count} 条${d.cutAwaitingCount ? ` · 另有 ${d.cutAwaitingCount} 条已切好待投` : ''}）</h3>`;
    html += d.scheduled.next.length
      ? `<table class="tbl"><thead><tr><th>计划投稿时间</th><th>切片</th><th>任务</th><th>状态</th></tr></thead><tbody>
        ${d.scheduled.next.map((s) => `<tr><td class="mono-sm">${esc(s.dtimeText)}</td><td>${esc(s.title)}</td><td class="mono-sm">${esc(s.taskId)}</td><td>${statusBadge(s.status)}</td></tr>`).join('')}
        </tbody></table>`
      : `<div class="empty">没有带定时时间的切片（这些是已切好、等发布阶段的）。</div>`;
  }
  if (d.pendingDelete.count) {
    html += `<h3 style="font-size:13px;margin:14px 0 8px">待删文件（${d.pendingDelete.count} 个 · 共 ${d.pendingDelete.totalMB} MB）
      ${d.pendingDelete.count > 1 ? '<button class="btn-sm" data-pending-delall="1" style="margin-left:8px;border-color:#f0c8c8;color:#c33">全部立即删除</button>' : ''}</h3>
      <table class="tbl"><thead><tr><th>到期</th><th>文件</th><th class="num">大小</th><th>为什么删</th><th>操作</th></tr></thead><tbody>
      ${d.pendingDelete.items.map((i) => `<tr><td class="mono-sm">${esc(fmtTime(Date.parse(i.dueAt)))}</td>
        <td class="mono-sm" title="${esc(i.path)}">${esc(fileBase(i.path))}<div style="color:var(--text-3)">${esc(i.kind)} · ${esc(i.taskId || '')}</div></td>
        <td class="num">${i.sizeMB} MB</td><td style="color:var(--text-3)">${esc(String(i.reason || '').slice(0, 70))}</td>
        <td>${pendingRowActions(i)}</td></tr>`).join('')}
      </tbody></table>`;
  }
  html += `</div>`;

  /* ---- ③ 为什么没动：目录轮询 ---- */
  const w = d.watch || {};
  const outs = w.outcomes || [];
  const skipped = outs.filter((o) => o.skipped);
  html += `<div class="card"><h2>目录轮询（为什么某个录播没被导入）
    ${w.enabled ? badge(w.scanning ? '正在扫描' : '在跑', w.scanning ? 'b-run' : 'b-done') : badge('未启用', 'b-idle')}</h2>
    <div class="kv" style="margin-bottom:10px">
      <div class="k">监控目录</div><div class="mono-sm">${(w.dirs || []).map((x) => esc(x)).join('<br>') || '（无）'}</div>
      <div class="k">上次扫描</div><div>${w.lastScanAt ? `${esc(fmtTime(Date.parse(w.lastScanAt)))}（${secText(w.lastScanAgoSec)}前）` : '还没扫过'}</div>
      <div class="k">累计自动导入</div><div>${w.importedTotal || 0} 场${w.backoffCount ? ` · 失败退避中 ${w.backoffCount} 个` : ''}</div>
    </div>`;
  if (d.recordingNow.length) {
    html += `<h3 style="font-size:13px;margin:6px 0 8px">正在录制（还在写入，写稳了才会导入）</h3>
      <table class="tbl"><thead><tr><th>文件</th><th>标题</th><th class="num">大小</th><th>说明</th></tr></thead><tbody>
      ${d.recordingNow.map((r) => `<tr><td class="mono-sm">${esc(r.fileName)}</td><td>${esc(r.title)}</td><td class="num">${r.sizeMB} MB</td><td class="mono-sm">${esc(r.note || '')}</td></tr>`).join('')}
      </tbody></table>`;
  }
  if (outs.length) {
    /* 这一块原来是一张平表：35 个文件、35 行「已导入过（任务 …；该任务已从台账删除）」+ 每行一句重跑指引。
       用户的原话是「这里的显示的太多了 而且是导入过的 优化他」。改成两类：
         · 需要你留意的（导入成功 / 正在录制等 / 失败 / 文件不可用）：直接列表（最多 12 行）；
         · 「已导入过」：**默认收起**（历史，无需处理），点开才看；
       重跑办法只写一次（原来每一行都重复一遍，35 行就是 35 遍）。 */
    const isImportedSkip = (o) => !o.taskId && /^已导入过/.test(String(o.skipped || ''));
    /* 压制产物（`-弹幕版` / `-纯享版`）也**默认收起**（2026-10-13 用户截图）：
       那 9 行"压制产物…完整版由 biliLive-tools 投"把「其它」整块占满，
       而真正要看的那一行（正在录制的那场）反而被淹没。
       它们不是"待处理的结论"，而是**别人的产物**：留一条折叠组随时可查，
       但不参与「其它」计数、不占直接列表的位置。 */
    const isProductSkip = (o) => !o.taskId && /^压制产物/.test(String(o.skipped || ''));
    const imported = outs.filter(isImportedSkip);
    const products = outs.filter(isProductSkip);
    const okCount = outs.filter((o) => o.taskId).length;
    const noteworthy = outs.filter((o) => !isImportedSkip(o) && !isProductSkip(o));
    const otherCount = noteworthy.length - okCount;
    const verdictOf = (o) => {
      const stillWriting = /仍在写入|可能仍在录制/.test(String(o.skipped || ''));
      if (o.taskId) return `<span style="color:var(--green)">已导入（任务 ${esc(o.taskId)}）</span>`;
      if (stillWriting) return '<span style="color:#1a86c7">正在录制，等写完</span>';
      return `<span style="color:var(--text-3)">${esc(o.skipped || o.error || '—')}</span>`;
    };
    const healthTable = (list, cap) => `<table class="tbl"><thead><tr><th>文件</th><th class="num">大小</th><th>结论</th></tr></thead><tbody>
      ${list.slice(0, cap).map((o) => `<tr><td class="mono-sm" title="${esc(o.videoPath || '')}">${esc(o.fileName)}</td><td class="num">${o.sizeMB} MB</td><td>${verdictOf(o)}</td></tr>`).join('')}
      </tbody></table>${list.length > cap ? `<div class="empty">还有 ${list.length - cap} 个未显示（清单太长时这里只列前 ${cap} 个）。</div>` : ''}`;
    html += `<h3 style="font-size:13px;margin:14px 0 8px">上一轮对每个文件的结论
      <span class="ai-tag">共 ${outs.length} 个 · 导入成功 ${okCount} · 已导入过 ${imported.length}${products.length ? ` · 压制产物 ${products.length}` : ''} · 其它 ${otherCount}</span></h3>`;
    if (noteworthy.length) {
      html += healthTable(noteworthy, 12);
    } else {
      html += `<div class="empty">这一轮没有需要你处理的结论（${imported.length} 个文件都是「已导入过」的历史记录）。</div>`;
    }
    if (imported.length) {
      html += `<div class="impgroup" data-g="health-imported" data-n="${imported.length}" title="展开这 ${imported.length} 个已导入过的文件">
          <span class="caret">▸</span><span>已导入过（历史，不需要处理）</span><span class="cnt">${imported.length} 个</span></div>
        <div id="healthImported" style="display:none">${healthTable(imported, 60)}</div>
        <p class="hintline">已导入过的文件不会被自动重导（同一个文件重复跑一遍是白花的 ASR + LLM 钱）。确实要重跑：
          用「导入录播」手动挑那一场（那条路不受此限制），或在「设置 → 导入」里关掉目录轮询。</p>`;
    }
    if (products.length) {
      html += `<div class="impgroup" data-g="health-products" data-n="${products.length}" title="展开这 ${products.length} 个压制产物">
          <span class="caret">▸</span><span>压制产物（-弹幕版/-纯享版，完整版由 biliLive-tools 投）</span><span class="cnt">${products.length} 个</span></div>
        <div id="healthProducts" style="display:none">${healthTable(products, 60)}</div>
        <p class="hintline">这些是 biliLive-tools 压出来的完整版（画面已烧弹幕），<b>不归切片助手处理</b> ——
          列出来只是让你能核对"哪一场的完整版已经出来了"，不需要任何操作。</p>`;
    }
  } else {
    html += `<div class="empty">上一轮没扫到任何录播。若目录里确实有文件，点上面的「立即刷新」看结论，或去「导入录播」检查扫描目录。</div>`;
  }
  html += `</div>`;

  /* ---- ④ 它在压制/上传什么（biliLive-tools 自己的队列） ---- */
  html += `<div class="card"><h2>biliLive-tools 队列（完整版的压制与上传）${d.llcQueue.length ? badge(`${d.llcQueue.length} 个进行中`, 'b-run') : badge('空闲', 'b-idle')}</h2>`;
  if (d.llcQueue.length) {
    html += `<table class="tbl"><thead><tr><th>类型</th><th>状态</th><th>产物</th><th>ID</th></tr></thead><tbody>
      ${d.llcQueue.map((t) => `<tr><td>${esc(t.type || '')}</td><td>${esc(t.status || '')}</td><td class="mono-sm">${esc(fileBase(t.output) || '—')}</td><td class="mono-sm" style="color:var(--text-3)">${esc(String(t.id || '').slice(0, 12))}</td></tr>`).join('')}
      </tbody></table>
      <div class="empty">它把完整版（弹幕版 + 纯享版）投出去之后，上面「等完整版的切片」才会被追加成分P。</div>`;
  } else if (d.llcQueueError) {
    html += `<div class="empty">查不到它的队列（${esc(d.llcQueueError)}）—— 不影响助手本身，这只是"顺路看一眼"。</div>`;
  } else {
    html += `<div class="empty">它现在没有在跑的压制/上传任务。</div>`;
  }
  html += `</div>`;

  /* ---- 已投稿文件：盘上哪些产物已经交出去了、审核到什么程度、能不能删 ---- */
  {
    const uf = d.uploadedFiles || { count: 0, items: [], deletableCount: 0, totalMB: 0, deletedCount: 0 };
    html += `<div class="card"><h2>已投稿文件
      ${uf.deletableCount ? badge(`${uf.deletableCount} 个可删`, 'b-run') : ''}
      ${uf.totalMB ? `<span style="font-size:12px;color:var(--text-3);font-weight:400">共 ${uf.totalMB} MB</span>` : ''}
      ${uf.deletableCount ? `<button class="btn-sm" style="margin-left:10px;border-color:#f0c8c8;color:#c33" data-act="del-published-all" data-n="${uf.deletableCount}" data-mb="${uf.totalMB}">一键删除可删的 ${uf.deletableCount} 项</button>` : ''}
    </h2>`;
    if (uf.error) html += `<div class="hintline warn" style="margin-bottom:8px">查不到审核状态（${esc(uf.error)}）—— 下面显示的是最后一次拿到的结果</div>`;
    if (!uf.items.length) {
      html += `<div class="empty">还没有已经投出去的文件。等切片或完整版上传成功后，这里会列出来。</div>`;
    } else {
      html += `<table class="tbl"><thead><tr><th>状态</th><th>类型</th><th>文件 / 标题</th><th class="num">大小</th><th></th></tr></thead><tbody>`;
      html += uf.items.map((i) => {
        /* 状态列：投成功了就显示可点的 bv 号（和「最近投稿」一样新窗口打开），
           还在审核就显示「审核中」。后面的小字是 B站 给的状态标签，只作参考 ——
           bv 号是否可点**只由** reviewState 决定，与标签无关。 */
        const bvidTip = i.bvidFrom === 'clip'
          ? 'bvid 取自本场切片：完整版是录制结束后才压出来的，台账里没有它的 bvid，而我们的切片正是追加进它那个稿件'
          : '';
        const statusCell = i.reviewState === 'published' && i.bvid
          ? `<a href="${esc(i.url)}" target="_blank" rel="noreferrer" class="mono-sm" style="font-weight:600;text-decoration:none"${bvidTip ? ` title="${esc(bvidTip)}"` : ''}>${esc(i.bvid)}</a>`
            + (i.stateLabel && !/已通过|开放浏览/.test(String(i.stateLabel))
              ? `<br><span style="font-size:11px;color:var(--text-3)" title="B站 返回的稿件状态，仅供参考">${esc(i.stateLabel)}</span>`
              : '')
          : `<span class="tag-mini" style="background:#fff8ec;color:#c8811a" title="${esc(i.stateLabel || '')}">${esc(i.reviewText || '审核中')}</span>`;
        return `<tr>
          <td>${statusCell}</td>
          <td><span class="tag-mini">${esc(i.kindText)}</span>${i.clipIndex !== undefined ? ` <span class="mono-sm" style="color:var(--text-3)">#${i.clipIndex}</span>` : ''}</td>
          <td>${esc(String(i.fileName || i.title).slice(0, 46))}<br><span style="color:var(--text-3);font-size:12px">${esc(String(i.title).slice(0, 40))}</span></td>
          <td class="num">${esc(i.sizeText || i.sizeMB + ' MB')}</td>
          <td>${i.deletable
            ? `<button class="btn-sm" data-act="del-published" data-key="${esc(i.key)}" data-file="${esc(i.fileName || '')}" data-bvid="${esc(i.bvid || '')}" data-size="${esc(i.sizeText || '')}" data-review="${esc(i.reviewState === 'published' ? '' : (i.reviewText || ''))}" style="border-color:#f0c8c8;color:#c33">删除</button>`
            : `<span style="color:var(--text-3);font-size:12px" title="只有已经反查到 bvid 的文件才允许在这里删">审核中不可删</span>`}</td>
        </tr>`;
      }).join('');
      html += `</tbody></table>`;
      const notes = [];
      if (uf.deletedCount) notes.push(`另有 ${uf.deletedCount} 项产物已删除（在回收站里，可恢复）`);
      if (uf.deletableCount) notes.push('「删除」只删本地文件并移入回收站，**不会**撤回 B站 上的稿件');
      if (notes.length) html += `<div style="margin-top:8px;font-size:12px;color:var(--text-3)">${notes.join('；')}</div>`;
    }
    html += `</div>`;
  }

  /* ---- 最近投稿 + 最近错误 ---- */
  html += `<div class="card"><h2>最近投稿</h2>`;
  html += d.recentPublished.length

    ? d.recentPublished.map((t) => `<div style="margin-bottom:10px">
        <b>${esc(t.title)}</b> <span class="mono-sm" style="color:var(--text-3)">${esc(fmtTime(Date.parse(t.publishedAt)))} · ${esc(t.id)}</span>
        <div style="margin-top:4px">${t.clips.length ? t.clips.map((c) => `<a class="tag-mini" href="${esc(c.url)}" target="_blank" rel="noreferrer" style="text-decoration:none">${esc(c.bvid)} · ${esc(String(c.title).slice(0, 24))}</a>`).join('') : '<span style="color:var(--text-3)">没有可回查的 bvid</span>'}</div>
      </div>`).join('')
    : `<div class="empty">还没有投出去的切片。</div>`;
  html += `</div>`;

  html += `<div class="card"><h2>最近错误（errors.jsonl）</h2>`;
  html += d.errors.length
    ? `<table class="tbl"><thead><tr><th>时间</th><th>阶段</th><th>类型</th><th>消息</th><th></th></tr></thead><tbody>
      ${d.errors.map((e) => `<tr><td class="mono-sm">${esc(fmtTime(Date.parse(e.at)))}</td><td>${esc(e.stage)}</td>
        <td><span class="tag-mini">${esc(e.type)}</span></td><td>${esc(String(e.message).slice(0, 120))}</td>
        <td><button class="btn-sm" data-act="openreport" data-report="${esc(e.reportId)}">报告</button></td></tr>`).join('')}
      </tbody></table>`
    : `<div class="empty">没有错误事件。</div>`;
  html += `</div>`;

  box.innerHTML = html;

  /* ---- 绑定 ---- */
  /* 「已导入过」那一组的展开/收起：只切这一块的显示，不重画整页
     （重画会把用户滚到的位置和别的展开状态一起弄丢）。
     ⚠️ 这段必须留在 renderMonitor 里 —— 第一版接到了 renderHealth 的末尾，
     而 DOM 是监控页画的，于是点了没反应（真浏览器验证当场抓到：可见行 0、箭头不变）。 */
  const impHead = $('[data-g="health-imported"]');
  if (impHead) {
    impHead.onclick = () => {
      const panel = $('#healthImported');
      if (!panel) return;
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : '';
      impHead.classList.toggle('open', !open);
      impHead.querySelector('.caret').textContent = open ? '▸' : '▾';
      impHead.title = `${open ? '展开' : '收起'}这 ${impHead.dataset.n || ''} 个已导入过的文件`;
    };
  }
  /* 压制产物那一组同样要能点开（2026-10-13 加）：折叠组只画不绑 = 摆设 */
  const prodHead = $('[data-g="health-products"]');
  if (prodHead) {
    prodHead.onclick = () => {
      const panel = $('#healthProducts');
      if (!panel) return;
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : '';
      prodHead.classList.toggle('open', !open);
      prodHead.querySelector('.caret').textContent = open ? '▸' : '▾';
      prodHead.title = `${open ? '展开' : '收起'}这 ${prodHead.dataset.n || ''} 个压制产物`;
    };
  }
  const sel = $('#monAuto');
  if (sel) sel.onchange = () => {
    const v = Number(sel.value);
    m.paused = v === 0;
    if (!m.paused) m.interval = v;
    startMonitor();
    renderMonitor(box);
  };
  const rf = $('[data-act="mon-refresh"]');
  if (rf) rf.onclick = async () => {
    rf.disabled = true;
    try { await loadMonitor(true); toast('已刷新'); } catch (e) { toast(e.message); } finally { rf.disabled = false; }
  };
  /* 待删文件：监控页上直接能删（不用再翻到设置里的「查看待删清单」）。
     确认文案由 deletePendingNow 按"进回收站 / 永久删除"分别给出。 */
  $$('[data-pending-del]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try {
      const res = await deletePendingNow([b.dataset.pendingDel], (m.data.pendingDelete.items || []));
      if (res === null) { b.disabled = false; return; }
      await loadMonitor(true); // 立刻重画：让用户看到它从待删里消失
    } catch (e) { toast('删除失败：' + e.message, 6000); b.disabled = false; }
  });
  const delAllMon = $('[data-pending-delall]');
  if (delAllMon) delAllMon.onclick = async () => {
    delAllMon.disabled = true;
    try {
      const res = await deletePendingNow((m.data.pendingDelete.items || []).map((x) => x.id), m.data.pendingDelete.items || []);
      if (res === null) { delAllMon.disabled = false; return; }
      await loadMonitor(true);
    } catch (e) { toast('删除失败：' + e.message, 6000); delAllMon.disabled = false; }
  };
  /* 已投稿文件：只删**本地文件**，走回收站；B站 上的稿件不受影响。
     确认框必须把这两件事都说清楚 —— 用户很容易以为「删除」是把稿件撤下来。 */
  $$('[data-act="del-published"]').forEach((b) => b.onclick = async () => {
    const fileName = b.dataset.file || '';
    const bvid = b.dataset.bvid || '';
    const sizeText = b.dataset.size || '?';
    const review = b.dataset.review || '';
    const okGo = confirm(
      '删除这个已投稿的产物文件吗？\n\n' +
      `文件：${fileName}（${sizeText}）\n` +
      `对应稿件：${bvid}${review ? `（${review}）` : ''}\n\n` +
      '· 文件会**移入回收站**，可以恢复；\n' +
      '· B站 上的稿件**不会**被撤回或删除' + (review ? `，它现在${review}，删本地文件不影响审核` : '') + '；\n' +
      '· 台账里的投稿记录保留，之后重跑仍会被幂等拦住，不会重复投稿。'
    );
    if (!okGo) return;
    b.disabled = true;
    try {
      const r = await api('/api/published-file/delete', { method: 'POST', body: { key: b.dataset.key, confirm: true } });
      toast(r.note || '已删除', 7000);
      await loadMonitor(true); // 立刻重画：让那一行消失
    } catch (e) { toast('删除失败：' + e.message, 6000); }
    /* 自己复位，不指望重画：数据没变时 `loadMonitor(true)` 会走"签名相同就不重画"的快路径
       （真浏览器验证的截图里抓到过按钮卡在「正在删除…」）。真删掉了的话这个节点已被重画替换，
       写它无害。 */
    finally { b.disabled = false; }
  });
  /* 一键删除**所有可删的**已投稿文件。
     确认框必须把三件事说清楚（缺一条用户就会误判后果）：
       ① 到底删几个、多大；② 进回收站可恢复、但磁盘空间要等回收站清理才释放；③ 不影响 B站 上的稿件。
     与单删共用同一个后端判定（deletable = 有 bvid + 文件在），所以"审核中不可删"的项在批量里也会被跳过。 */
  $$('[data-act="del-published-all"]').forEach((b) => b.onclick = async () => {
    const n = Number(b.dataset.n || 0);
    const mb = Number(b.dataset.mb || 0);
    const sizeText = mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
    /* 注意：`confirm()` 是**纯文本**弹窗，不认 HTML —— 这里用「」而不是 `<b>`/`**`。
       第一版写了 `**移入回收站**`，真浏览器验证时抓到弹窗里原样显示两个星号。 */
    const okGo = confirm(
      `一键删除全部 ${n} 个可删的已投稿文件吗？\n\n` +
      `合计：${sizeText}\n\n` +
      '· 全部「移入回收站」（7 天内可恢复），不是永久删除；\n' +
      '· 磁盘空间要等「回收站清理」之后才真正释放；\n' +
      '· B站 上的稿件「不会」被撤回或删除；\n' +
      '· 还在审核（没有 bvid）的项会自动跳过，不会被删。'
    );
    if (!okGo) return;
    b.disabled = true;
    b.textContent = '正在删除…';
    try {
      const r = await api('/api/published-file/delete-all', { method: 'POST', body: { confirm: true } });
      const extra = [];
      if (r.failed && r.failed.length) extra.push(`失败 ${r.failed.length} 个`);
      if (r.skipped && r.skipped.length) extra.push(`跳过 ${r.skipped.length} 个（审核中/文件已不在）`);
      /* `r.note` 兜底：没有它就会弹出一个写着 "undefined" 的黑框（真浏览器验证的截图里抓到过）。
         服务端一直返回 note，但界面不该因为一个字段缺失就显示 "undefined"。 */
      toast(`${r.note || `已删除 ${r.deleted ?? 0} 个文件`}${extra.length ? `；${extra.join('，')}` : ''}`, 9000);
      await loadMonitor(true);
    } catch (e) {
      toast('一键删除失败：' + e.message, 6000);
    }
    /* 同单删：数据没变时 `loadMonitor(true)` 不重画，按钮会一直卡在「正在删除…」——
       截图里就是那样。所以无论成败都自己复位。 */
    finally {
      b.disabled = false;
      b.textContent = `一键删除可删的 ${n} 项`;
    }
  });
  $$('[data-act="mon-open"]').forEach((a) => a.onclick = (ev) => {
    ev.preventDefault();
    // 点标题 → 跳到任务页并选中这一场（不用自己再去列表里找）
    state.activeId = a.dataset.id;
    switchView('tasks');
    renderTaskList();
    loadDetail().catch((e) => toast(e.message));
  });
  $$('[data-act="openreport"]').forEach((b) => b.onclick = async () => {
    try {
      const r = await api('/api/error-report/' + encodeURIComponent(b.dataset.report));
      const nt = reportNote(r);
      openInfo('错误报告 · ' + b.dataset.report, nt.note + `<pre class="raw">${esc(r.timeline)}</pre>`, nt.tip);
      state.lastCopy = r.timeline;
    } catch (e) { toast('读取报告失败：' + e.message); }
  });
}

/**
 * 成本（月度汇总）：**不再是独立页签**，作为「稿件表现」里的一张折叠卡片。
 * 2026-10-11 用户要求：「将这两个放到成本的位置 然后将成本放到稿件表现里」。
 * 只把 HTML 生成抽出来复用，数字与口径一个字没改（同一份 `/api/tasks` 的 `monthly`）。
 */
function costHtml(m) {
  const days = Object.entries(m.byDay || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const max = Math.max(0.01, ...days.map(([, v]) => v.asr + v.llm));
  return `
    <div class="kpis">
      <div class="kpi"><div class="k">本月合计</div><div class="v">¥${m.total.toFixed(2)}</div><div class="n">${m.tasks} 场直播</div></div>
      <div class="kpi"><div class="k">字幕识别（估算值）</div><div class="v">¥${m.asrEstimate.toFixed(2)}</div><div class="n">音频 ${m.asrAudioHours} 小时</div></div>
      <div class="kpi"><div class="k">内容分析（实际）</div><div class="v sm">¥${m.llmActual.toFixed(4)}</div><div class="n">${m.llmCalls} 次调用 · 按 API usage 计</div></div>
    </div>
    <div class="card"><h2>说明</h2><div class="summary"><p>${esc(m.disclaimer)}</p>
      <p>结论：<b>LLM 成本几乎可以忽略，真正值得优化的是 ASR</b>。要压成本请优先考虑本地 Whisper 方案或本地剪静音，而不是换更便宜的 LLM。</p></div></div>
    <div class="card"><h2>按日分布</h2>
      ${days.length ? `<table class="tbl"><thead><tr><th>日期</th><th>字幕识别</th><th>内容分析</th><th>合计</th><th style="width:40%">占比</th></tr></thead><tbody>
      ${days.map(([d, v]) => `<tr><td class="mono-sm">${esc(m.month)}-${esc(d)}</td><td class="num">¥${v.asr.toFixed(2)}</td>
        <td class="num">¥${v.llm.toFixed(4)}</td><td class="num">¥${(v.asr + v.llm).toFixed(2)}</td>
        <td><div style="background:#eceef0;border-radius:3px;height:6px"><i style="display:block;height:100%;border-radius:3px;background:var(--pink);width:${Math.round(((v.asr + v.llm) / max) * 100)}%"></i></div></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">本月暂无数据</div>'}</div>`;
}

/**
 * 「待删 / 回收站」——把两条**同一条生命周期**上的清单放在一页里。
 *
 * 2026-10-11 用户反馈：「待删清单里的 已经删除的 不在显示 或者待删清单和回收站放一起」。
 * 原来两个页签各有一份"已删除"：待删清单底部列 `最近已删除`（20 条，只是历史），
 * 回收站按天分组列出同一批东西（但能恢复、能彻底删、还带保留期限）—— 同一件事说两遍，
 * 而且两份的**动作还不一样**（那份历史什么都没有）。所以合并成一页两段：
 *   ① 待删（宽限期内，可取消 / 立即删除）；② 回收站（已删，可恢复 / 彻底删除 / 超期自动清理）。
 * 「最近已删除」那段历史**去掉** —— 回收站就是它的完整版（含恢复与期限）。
 */
async function renderDeletePage(box) {
  /* 两段各自取数：一段失败不该让另一段整页空白 */
  const pend = await api('/api/pending-delete').catch((e) => ({ error: e.message }));
  const trash = await api('/api/trash').catch((e) => ({ error: e.message }));
  const keepDays = Number(state.bootstrap?.config?.cleanup?.trashDays ?? 0);

  /* ---------------- 第一段：待删（宽限期内） ---------------- */
  const pendRow = (e) => `<div class="row"><span class="t">${fmtTime(Date.parse(e.dueAt))}</span><span class="s">
      <b>${esc(e.path.split(/[\\/]/).pop() || e.path)}</b>
      <span style="color:var(--text-3)"> · ${e.kind === 'raw' ? '源录播' : e.kind === 'clip' ? '成片' : '完整版'} · ${fmtBytes(e.sizeBytes)}</span><br>
      <span class="mono-sm" style="color:var(--text-3)">${esc(e.path)}</span><br>
      <span style="color:var(--text-3)">${esc(e.reason)}</span>
      <br>${pendingRowActions(e, { cancellable: true })}
      ${e.error ? `<br><span style="color:#c33">上次删除失败：${esc(e.error)}</span>` : ''}
    </span></div>`;
  const pendList = pend.error
    ? `<div class="row"><span class="s" style="color:#c33">待删清单读取失败：${esc(pend.error)}</span></div>`
    : pend.pending.length
      ? pend.pending.map(pendRow).join('')
      : '<div class="row"><span class="s" style="color:var(--text-3)">没有待删除的文件</span></div>';
  const pendCard = `<div class="card">
      <h2>① 待删（用完即删 · 宽限期内可取消）</h2>
      <p style="font-size:13px">本场全部切片确认投稿成功后，成片与源录播会排进这里，<b>宽限期过后自动删除</b>。
      宽限期内点「取消删除」就不会删；点「立即删除」则<b>现在</b>就删（不等宽限期）。<br>
      ${pend.error ? '' : `待删 <b>${pend.stats.pendingCount}</b> 项，可释放 <b>${fmtBytes(pend.stats.pendingBytes)}</b>${pend.stats.nextDueAt ? `，最早 <b>${fmtTime(Date.parse(pend.stats.nextDueAt))}</b> 执行` : ''}。`}</p>
      <div class="timeline">${pendList}</div>
      <div style="margin-top:12px">
      ${!pend.error && pend.pending.length ? `<button class="btn-sm" id="pendingDelAll" style="border-color:#f0c8c8;color:#c33">全部立即删除（${pend.pending.length} 项 · ${fmtBytes(pend.stats.pendingBytes)}）</button> ` : ''}
      <button class="btn-sm" id="pendingRunDue">立即执行到点的删除</button>
      <span class="hintline" style="margin-left:8px">「到点删除」每 10 分钟自动执行一次，这里只是手动触发；要提前删请点上面的「立即删除」。</span></div>
    </div>`;

  /* ---------------- 第二段：回收站（已删除） ---------------- */
  const trashRow = (e) => `<div class="row"><span class="t">${fmtTime(Date.parse(e.deletedAt))}</span><span class="s">
      <b>${esc(e.title)}</b><br>
      <span style="color:var(--text-3)">${fmtBytes(e.totalBytes)} · ${e.files.length} 项 · 任务 <span class="mono-sm">${esc(e.taskId)}</span>${e.task ? '' : '（无台账快照，只能恢复文件）'}</span><br>
      <button class="btn-sm" data-restore="${esc(e.id)}">恢复</button>
      <button class="btn-sm" data-purge="${esc(e.id)}" style="color:#c33">彻底删除</button></span></div>`;
  /* 按**本地日期**分组（`deletedAt` 是 ISO，直接切前 10 位会串到 UTC 那天：凌晨删的会跑到前一天） */
  const byDay = new Map();
  const entries = trash.error ? [] : trash.entries;
  for (const e of entries) {
    const day = fmtTime(Date.parse(e.deletedAt)).slice(0, 10) || '未知日期';
    const arr = byDay.get(day);
    if (arr) arr.push(e);
    else byDay.set(day, [e]);
  }
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])); // 最新的天在最上面
  const expireTextOf = (list) => {
    if (!(keepDays > 0)) return '<span class="hintline" style="color:#c8811a">已关闭自动清理（cleanup.trashDays=0）</span>';
    const oldest = Math.min(...list.map((e) => Date.parse(e.deletedAt)).filter((n) => Number.isFinite(n)));
    if (!Number.isFinite(oldest)) return '';
    const leftMs = oldest + keepDays * 86400_000 - Date.now();
    const leftDays = Math.ceil(leftMs / 86400_000);
    if (leftMs <= 0) return `<span class="hintline" style="color:#c33">已过期 · 下次自动清理就删</span>`;
    return `<span class="hintline">${leftDays <= 1 ? '今天到期' : `还有 ${leftDays} 天到期`} · 到期自动删除</span>`;
  };
  const dayBlocks = days
    .map(([day, list]) => {
      const bytes = list.reduce((a, e) => a + (Number(e.totalBytes) || 0), 0);
      /* 每一天都**默认收起**（用户 2026-10-11：「改成默认是折叠状态」） */
      return `<details class="trashday">
        <summary style="cursor:pointer;font-size:13px;font-weight:600;padding:6px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span>${esc(day)}</span>
          <span class="ai-tag">${list.length} 项 · ${fmtBytes(bytes)}</span>
          ${expireTextOf(list)}
          <button class="btn-sm" style="margin-left:auto;color:#c33" data-day-purge="${esc(day)}"
            title="彻底删除这一天的全部条目（不可恢复）">彻底删除这天</button>
        </summary>
        <div class="timeline">${list.map(trashRow).join('')}</div>
      </details>`;
    })
    .join('');
  const expiredCount = keepDays > 0
    ? entries.filter((e) => Date.parse(e.deletedAt) + keepDays * 86400_000 <= Date.now()).length
    : 0;
  const trashCard = `<div class="card">
      <h2>② 回收站（已删除 · 可恢复）</h2>
      ${trash.error
        ? `<div class="row"><span class="s" style="color:#c33">回收站读取失败：${esc(trash.error)}</span></div>`
        : `<p style="font-size:13px">共 ${entries.length} 项，占用 ${fmtBytes(trash.stats.bytes)}。删除的任务会先到这里，可随时恢复（含台账记录）。<br>
      <b>保留 ${keepDays > 0 ? `${keepDays} 天` : '不自动清理'}</b>${keepDays > 0 ? '（在「设置 → 回收站 / 待删清单」里改）：超期的条目每天会自动彻底删除，下面每个日期都标了还剩几天。' : '（cleanup.trashDays=0：删任务会直接永久删除，没有回收站）'}
      下面按<b>删除日期</b>分组（默认全部收起，点日期展开）：</p>
      ${days.length ? dayBlocks : '<div class="row"><span class="s" style="color:var(--text-3)">回收站是空的</span></div>'}
      <div style="margin-top:12px">
        ${days.length ? '<button class="btn-sm" id="trashToggleAll">全部展开</button> ' : ''}
        ${keepDays > 0 ? `<button class="btn-sm" id="trashPurgeExpired"${expiredCount ? '' : ' disabled'} title="${expiredCount ? `现在就彻底删除这 ${expiredCount} 项已过期的` : '当前没有过期条目'}">立即清理过期项${expiredCount ? `（${expiredCount}）` : ''}</button> ` : ''}
        <button class="btn-sm" id="trashPurgeAll" style="color:#c33">清空回收站（不可逆）</button>
      <span class="hintline" style="margin-left:8px">目录：<span class="mono-sm">${esc(trash.dir)}</span></span></div>`}
    </div>`;

  box.innerHTML = `<h2 style="font-size:16px;margin:0 0 14px">待删 / 回收站</h2>
    <p class="hintline">这一页回答两个问题：① 哪些文件是「用完即删」但仍在宽限期内（可以取消）；② 已经删掉的能不能恢复（按天折叠，可整组恢复或彻底清掉）。</p>${pendCard}${trashCard}`;

  /* ---------------- 绑定：任何动作完成后**整页重画**（两段一起刷新） ---------------- */
  const rerender = () => renderDeletePage(box);
  box.querySelectorAll('[data-pending-del]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      const res = await deletePendingNow([b.dataset.pendingDel], pend.pending);
      if (res === null) { b.disabled = false; return; } // 用户在确认框里点了取消
      toast(`已删除 ${res.deleted} 项（释放 ${fmtBytes(res.bytes)}）`, 6000);
      await rerender();
      void refreshPendingBadge();
    } catch (e) { toast('删除失败：' + e.message, 6000); b.disabled = false; }
  }));
  const delAll = box.querySelector('#pendingDelAll');
  if (delAll) delAll.onclick = async () => {
    delAll.disabled = true;
    try {
      const res = await deletePendingNow(pend.pending.map((e) => e.id), pend.pending);
      if (res === null) { delAll.disabled = false; return; }
      toast(`已删除 ${res.deleted} 项（释放 ${fmtBytes(res.bytes)}）`, 6000);
      await rerender();
      void refreshPendingBadge();
    } catch (e) { toast('删除失败：' + e.message, 6000); delAll.disabled = false; }
  };
  box.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      await api('/api/pending-delete/cancel', { method: 'POST', body: { id: b.dataset.cancel } });
      toast('已取消：这个文件不会被自动删除');
      await rerender();
      void refreshPendingBadge();
    } catch (e) { toast('取消失败：' + e.message, 6000); b.disabled = false; }
  }));
  const runDue = box.querySelector('#pendingRunDue');
  if (runDue) runDue.onclick = async () => {
    runDue.disabled = true;
    try {
      const rr = await api('/api/pending-delete/run', { method: 'POST', body: {} });
      toast(`执行完成：删除 ${rr.deleted} 项（释放 ${fmtBytes(rr.bytes)}）${rr.failed ? `，失败 ${rr.failed} 项` : ''}`, 7000);
      await rerender();
      void refreshPendingBadge();
    } catch (e) { toast('执行失败：' + e.message, 6000); runDue.disabled = false; }
  };
  /* 每个日期行的「彻底删除这天」：必须 preventDefault —— 它在 <summary> 里，
     不拦的话点一下既删东西又顺手把这一天折叠/展开（原生 details 的默认行为）。 */
  box.querySelectorAll('[data-day-purge]').forEach((b) => (b.onclick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const day = b.dataset.dayPurge;
    const list = byDay.get(day) ?? [];
    const bytes = list.reduce((a, e) => a + (Number(e.totalBytes) || 0), 0);
    if (!confirm(`彻底删除 ${day} 这一天的 ${list.length} 个条目（${fmtBytes(bytes)}）？\n\n文件将从磁盘抹掉，与「恢复」不同 —— **不可恢复**。`)) return;
    b.disabled = true;
    try {
      const rr = await api('/api/trash/purge', { method: 'POST', body: { confirm: true, ids: list.map((e) => e.id) } });
      toast(`已彻底删除 ${rr.purged} 项，释放 ${fmtBytes(rr.bytes)}`, 7000);
      await rerender();
    } catch (e) { toast('删除失败：' + e.message, 6000); b.disabled = false; }
  }));
  const expireBtn = box.querySelector('#trashPurgeExpired');
  if (expireBtn) expireBtn.onclick = async () => {
    if (!confirm(`立即彻底删除已超过 ${keepDays} 天的条目（${expiredCount} 项）？不可恢复。`)) return;
    expireBtn.disabled = true;
    try {
      const rr = await api('/api/trash/purge', { method: 'POST', body: { confirm: true, olderThanDays: keepDays } });
      toast(rr.note || `已清理 ${rr.purged} 项过期条目`, 7000);
      await rerender();
    } catch (e) { toast('清理失败：' + e.message, 6000); expireBtn.disabled = false; }
  };
  const toggleAll = box.querySelector('#trashToggleAll');
  if (toggleAll) toggleAll.onclick = () => {
    const all = [...box.querySelectorAll('details.trashday')];
    const expand = all.some((d) => !d.open); // 还有收起的 → 这一下全展开
    for (const d of all) d.open = expand;
    toggleAll.textContent = expand ? '全部收起' : '全部展开';
  };
  box.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      const rr = await api('/api/trash/restore', { method: 'POST', body: { id: b.dataset.restore } });
      toast(`已恢复 ${rr.restored.length} 项${rr.warnings.length ? `（${rr.warnings.length} 项提示）` : ''}`, 6000);
      await rerender();
      void refreshAll(true);
    } catch (e) { toast('恢复失败：' + e.message, 6000); b.disabled = false; }
  }));
  box.querySelectorAll('[data-purge]').forEach((b) => (b.onclick = async () => {
    if (!confirm('彻底删除这一项？文件将从磁盘抹掉，无法恢复。')) return;
    b.disabled = true;
    try {
      await api('/api/trash/purge', { method: 'POST', body: { confirm: true, ids: [b.dataset.purge] } });
      toast('已彻底删除');
      await rerender();
    } catch (e) { toast('删除失败：' + e.message, 6000); b.disabled = false; }
  }));
  const purgeAll = box.querySelector('#trashPurgeAll');
  if (purgeAll) purgeAll.onclick = async () => {
    if (!confirm('清空回收站？里面所有文件将被永久删除，无法恢复。')) return;
    purgeAll.disabled = true;
    try {
      const rr = await api('/api/trash/purge', { method: 'POST', body: { confirm: true } });
      toast(rr.note || '已清空回收站');
      await rerender();
    } catch (e) { toast('清空失败：' + e.message, 6000); purgeAll.disabled = false; }
  };
}

