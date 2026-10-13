/* ============================================================================
 * 运行观测（/api/monitor + /api/observe，默认 5 秒自动刷新）
 *
 * 为什么再开一页（而不是塞进「实时监控」）：
 *   实时监控回答的是"任务视角"——这一场跑到哪、在等什么、为什么没动。
 *   但守着直播的人还要看**机器视角**的四件事，它们在监控页里没有位置：
 *     ① 边录边转到底转了没有（每场已完成 N/M 段、最近一轮 tick 的判定）
 *     ② 压制/上传队列与 ETA（biliLive-tools 在跑什么、还要多久）
 *     ③ 我们自己的资源占用（RSS/堆、本地 ASR 的精度与显存峰值）
 *     ④ 端到端各阶段（最近几场：状态、候选数、开始时间）
 *   这一页只读、只展示，不改任何状态（"看一眼就走"的用法）。
 *
 * 2026-10-13 加，起因：验证「边录边转」时只能靠命令行 grep 日志，用户问
 * "为什么它没跑"时无法一眼回答 —— 于是把它做成界面。
 * ========================================================================== */

const OBSERVE_INTERVAL_MS = 5000;

function stopObserve() {
  const o = state.obs;
  if (o && o.timer) {
    clearInterval(o.timer);
    o.timer = null;
  }
}

function startObserve() {
  const o = (state.obs = state.obs || { timer: null, data: null, paused: false });
  stopObserve();
  if (o.paused) return;
  o.timer = setInterval(() => {
    loadObserve().catch(() => {});
  }, OBSERVE_INTERVAL_MS);
}

async function loadObserve() {
  const o = (state.obs = state.obs || { timer: null, data: null, paused: false });
  const [mon, obs] = await Promise.all([
    fetch('/api/monitor').then((r) => r.json()),
    fetch('/api/observe').then((r) => r.json()),
  ]);
  o.data = { mon, obs, at: new Date() };
  const box = $('#otherPage');
  if (box && state.view === 'observe') renderObserve(box);
}

/** 把"多久之前"写成短句 */
function obsAgo(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '—';
  if (sec < 60) return Math.round(sec) + ' 秒前';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
  return (sec / 3600).toFixed(1) + ' 小时前';
}

function obsMB(bytes) {
  if (!bytes && bytes !== 0) return '—';
  return (bytes / 1048576).toFixed(bytes > 1073741824 ? 0 : 1) + ' MB';
}

function renderObserve(box) {
  const o = state.obs && state.obs.data;
  if (!o) {
    box.innerHTML = '<div class="empty">加载中…</div>';
    return;
  }
  const { mon, obs } = o;
  const mem = (mon.health && mon.health.memory) || {};
  const queue = mon.llcQueue || [];

  /* ① 录制中 */
  const outcomes = (mon.watch && mon.watch.outcomes) || [];
  const growing = outcomes.filter((x) => x && x.kind === 'recording');
  const recRows = (obs.recording || [])
    .map(
      (r) => `<tr>
        <td class="mono-sm">${esc(r.name)}</td>
        <td>${obsMB(r.sizeBytes)}</td>
        <td>${obsAgo(r.ageSec)}</td>
        <td>${r.growing ? '<span class="badge b-run">正在录</span>' : '<span class="badge">已停</span>'}</td>
      </tr>`,
    )
    .join('');

  /* ② 边录边转 */
  const pre = obs.preTranscribe || [];
  const preRows = pre
    .map((p) => {
      const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
      return `<tr>
        <td class="mono-sm">${esc(p.name)}</td>
        <td>${p.done}/${p.total} 段（${pct}%）</td>
        <td>${p.mode === 'fallback' ? '<span class="badge b-fail">已回退整段</span>' : '<span class="badge b-run">分段</span>'}</td>
        <td>${obsAgo(p.ageSec)}</td>
      </tr>`;
    })
    .join('');
  const tickLines = (obs.preTranscribeLog || [])
    .map((l) => `<div class="row mono-sm">[${esc(l.at)}] ${esc(l.msg)}</div>`)
    .join('');

  /* ③ 压制 / 上传队列 */
  const qRows = queue
    .map(
      (t) => `<tr>
        <td>${esc(t.type || '')}</td>
        <td>${esc(t.status || '')}</td>
        <td class="mono-sm">${esc((t.output || '').split(/[\\/]/).pop() || '—')}</td>
      </tr>`,
    )
    .join('');

  /* ④ 端到端阶段（最近几场） */
  const tl = obs.timeline || [];
  const tlRows = tl
    .map(
      (t) => `<tr>
        <td class="mono-sm">${esc(String(t.id).slice(-22))}</td>
        <td>${esc(t.status || '')}</td>
        <td>${t.clips} 片 / 选中 ${t.selected}</td>
        <td>${esc(t.createdAt || '')}</td>
      </tr>`,
    )
    .join('');

  /* ⑤ 资源与 ASR 体检 */
  const health = (obs.asrHealth || [])
    .map((h) => `<div class="row mono-sm">[${esc(h.at)}] ${esc(h.msg)}</div>`)
    .join('');

  box.innerHTML = `
    <div class="card">
      <div class="card-head">
        <b>运行观测</b>
        <span class="mono-sm" style="color:var(--text-3)">每 ${OBSERVE_INTERVAL_MS / 1000} 秒自动刷新 · 数据时间 ${esc(o.at.toLocaleTimeString())}</span>
        <button class="btn-sm" id="obsPause">${state.obs.paused ? '继续刷新' : '暂停刷新'}</button>
      </div>
      <div class="hintline">这一页只读：<b>边录边转</b>（每场已完成几段）、<b>压制/上传队列</b>、<b>我们的资源占用</b>与 <b>最近几场</b>。数据来自 /api/monitor + /api/observe，不改任何状态。</div>
    </div>

    <div class="card">
      <div class="card-head"><b>① 正在录制的文件</b><span class="badge ${recRows ? 'b-run' : ''}">${growing.length || (obs.recording || []).length} 个</span></div>
      ${
        recRows
          ? `<table class="tbl"><thead><tr><th>文件</th><th>大小</th><th>最后写入</th><th>状态</th></tr></thead><tbody>${recRows}</tbody></table>`
          : '<div class="empty">当前没有在写的录制文件（目录轮询每轮都会给结论，见「实时监控」页）</div>'
      }
    </div>

    <div class="card">
      <div class="card-head"><b>② 边录边转（预转写）</b><span class="badge ${pre.length ? 'b-run' : ''}">${pre.length} 个场次有进度</span></div>
      ${
        preRows
          ? `<table class="tbl"><thead><tr><th>场次</th><th>已完成</th><th>路径</th><th>更新</th></tr></thead><tbody>${preRows}</tbody></table>`
          : '<div class="empty">还没有任何场次留下预转写进度。若正在直播却一直为空，看下面「最近几轮判定」——多半是让路，或候选判定没命中。</div>'
      }
      ${tickLines ? `<div class="card-head" style="margin-top:8px"><b>最近几轮判定</b></div>${tickLines}` : ''}
    </div>

    <div class="card">
      <div class="card-head"><b>③ 压制 / 上传队列（biliLive-tools）</b><span class="badge ${queue.length ? 'b-run' : ''}">${queue.length} 个进行中</span></div>
      ${
        qRows
          ? `<table class="tbl"><thead><tr><th>类型</th><th>状态</th><th>产物</th></tr></thead><tbody>${qRows}</tbody></table>`
          : '<div class="empty">队列空闲</div>'
      }
      <div class="hintline">完整版（弹幕版 + 纯享版）由 biliLive-tools 压制与上传；它投出去之后，等完整版的切片才会被追加成分P。</div>
    </div>

    <div class="card">
      <div class="card-head"><b>④ 最近几场（端到端）</b></div>
      ${tlRows ? `<table class="tbl"><thead><tr><th>场次</th><th>状态</th><th>切片</th><th>开始</th></tr></thead><tbody>${tlRows}</tbody></table>` : '<div class="empty">台账为空</div>'}
    </div>

    <div class="card">
      <div class="card-head"><b>⑤ 我们的资源与 ASR 体检</b></div>
      <table class="tbl"><tbody>
        <tr><td>进程内存</td><td>RSS ${mem.rssMB ?? '—'} MB · 堆 ${mem.heapUsedMB ?? '—'}/${mem.heapLimitMB ?? '—'} MB</td></tr>
        <tr><td>磁盘</td><td>${mon.disk ? esc(String(mon.disk.freeGB ?? '—')) + ' GB 可用 / 阈值 ' + esc(String(mon.disk.thresholdGB ?? '—')) + ' GB' : '—'}</td></tr>
        <tr><td>运行时长</td><td>${mon.uptimeSec ? (mon.uptimeSec / 3600).toFixed(1) + ' 小时' : '—'}</td></tr>
      </tbody></table>
      <div class="card-head" style="margin-top:8px"><b>最近几次本地转写（精度 / 显存峰值）</b></div>
      ${health || '<div class="empty">还没有本地转写体检记录</div>'}
    </div>
  `;

  const btn = $('#obsPause');
  if (btn) {
    btn.onclick = () => {
      state.obs.paused = !state.obs.paused;
      if (state.obs.paused) stopObserve();
      else startObserve();
      renderObserve(box);
    };
  }
}
