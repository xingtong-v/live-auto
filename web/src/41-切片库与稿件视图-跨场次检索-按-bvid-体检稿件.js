/* ============================================================================
 * 切片库与稿件视图（跨场次检索 / 按 bvid 体检稿件）
 * ========================================================================== */
/**
 * 切片库：把所有场次的切片拉平成一张可检索的表（2026-10-11 优化第一批 P0-3）。
 *
 * 为什么需要：稿件是长期资产，而切片一直只能"一场场翻任务"看 —— 想复盘"上次那种题材多少播放"、
 * 想把一条老切片再发一次、想核对某条到底投没投出去，都得先想起它在哪一场。
 *
 * 三条刻意的规矩：
 *   ① 只读视图：不改台账、不触发投稿；「试看」走与任务详情同一个 `/api/preview-cut`（行为一致）；
 *   ② 检索条件留在页面状态里（切走再回来不丢），并且**每次改筛选都重新查服务端**（口径与统计同源）；
 *   ③ 截断如实说：超过 limit 时写「只显示前 N 条，共 M 条」，不假装全都在。
 */
async function renderClipLibrary(box) {
  const p = new URLSearchParams({ q: clipLib.q, status: clipLib.status, sort: clipLib.sort, limit: String(clipLib.limit) });
  if (clipLib.asc) p.set('asc', '1');
  const d = await api('/api/clips/library?' + p.toString());
  const STATUS_LABEL = {
    CANDIDATE: '候选',
    CUT: '已切片',
    CUTTING: '切片中',
    SUBMITTING: '投稿中',
    SUBMITTED: '已提交待确认',
    PUBLISHED: '已发布',
    FAILED: '失败',
    SKIPPED: '已跳过',
    PENDING_UPLOAD: '待上传',
  };
  const rows = d.rows || [];
  box.innerHTML = `<h2 style="font-size:16px;margin:0 0 14px">切片库
    <span class="ai-tag">共 ${d.total} 条${d.truncated ? ` · 只显示前 ${d.limit} 条` : ''} · 已发布 ${d.counts.published} / 待确认 ${d.counts.submitted} / 候选 ${d.counts.candidate} / 失败 ${d.counts.failed}</span></h2>
    <p class="hintline">这一页回答：<b>跨场次</b>找一条切片 —— 按标题/状态/评分检索，可试看、可跳到那一场、可导出 CSV。（只看这一场请用「任务」，只看某个稿件请点行内的「看稿件」。）</p>
    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <input class="inp" id="libQ" placeholder="搜标题 / 场次 / 任务 ID / BV 号" value="${esc(clipLib.q)}" style="width:260px">
        <select class="inp" id="libStatus" style="width:auto">
          ${[['', '全部状态'], ['PUBLISHED', '已发布'], ['SUBMITTED', '已提交待确认'], ['CANDIDATE', '候选'], ['CUT', '已切片'], ['FAILED', '失败'], ['SKIPPED', '已跳过']]
            .map(([v, t]) => `<option value="${v}"${clipLib.status === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <select class="inp" id="libSort" style="width:auto">
          ${[['score', '按评分'], ['view', '按播放'], ['like', '按点赞'], ['time', '按场次时间'], ['duration', '按时长']]
            .map(([v, t]) => `<option value="${v}"${clipLib.sort === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <button class="btn-sm" id="libDir">${clipLib.asc ? '↑ 升序' : '↓ 降序'}</button>
        <button class="btn-sm" id="libExport">导出 CSV</button>
        <span class="hintline">${esc(d.note || '')}</span>
      </div>
      ${rows.length ? `<table class="tbl"><thead><tr>
        <th>标题</th><th>场次</th><th>评分</th><th>时长</th><th>状态</th><th>播放</th><th>点赞</th><th>稿件</th><th>操作</th>
      </tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td>${esc(r.title)}${r.fixture ? ' <span class="tag-mini">🔧 夹具</span>' : ''}${r.degraded ? ' <span class="tag-mini">降级</span>' : ''}${r.tombstone ? ' <span class="tag-mini">🪦 墓碑</span>' : ''}</td>
        <td class="mono-sm" title="${esc(r.taskId)}">${esc(String(r.taskWhen).slice(5, 16))} · ${esc(String(r.taskTitle).slice(0, 14))}</td>
        <td class="num">${Number(r.score ?? 0).toFixed(1)}</td>
        <td class="num">${r.durationSec}s</td>
        <td class="mono-sm">${esc(STATUS_LABEL[r.status] || r.status)}</td>
        <td class="num">${r.view ?? '—'}</td>
        <td class="num">${r.like ?? '—'}</td>
        <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer" class="mono-sm">${esc(r.bvid)}</a> <button class="linkbtn" data-lib-archive="${esc(r.bvid)}">看稿件</button>` : '—'}</td>
        <td class="mono-sm">
          ${r.hasCut ? `<button class="linkbtn" data-lib-preview="${esc(r.taskId)}|${r.index}">试看</button>` : '<span style="color:var(--text-3)">未切片</span>'}
          <button class="linkbtn" data-lib-goto="${esc(r.taskId)}|${r.index}">去这一场</button>
          ${r.status === 'SUBMITTED' ? `<button class="linkbtn" data-lib-republish="${esc(r.taskId)}|${r.index}" title="这一片显示已提交但未在 B站 分P 列表里确认，可重投一次">重新投稿这一片</button>` : ''}
        </td>
      </tr>`).join('')}
      </tbody></table>`
      : '<div class="empty">没有匹配的切片。换个关键词，或把状态切到「全部状态」。</div>'}
      ${d.truncated ? `<p class="hintline">还有 ${d.total - d.limit} 条没显示 —— 缩小搜索范围，或点下面的「多显示 200 条」。</p>
        <div style="margin-top:8px"><button class="btn-sm" id="libMore">多显示 200 条</button></div>` : ''}
    </div>`;
  /* 检索条件：改完**重新查服务端**（同一份口径，不在前端另算一套） */
  const q = box.querySelector('#libQ');
  if (q) {
    let timer = null;
    q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { clipLib.q = q.value.trim(); renderClipLibrary(box); }, 300);
    };
  }
  const st = box.querySelector('#libStatus');
  if (st) st.onchange = () => { clipLib.status = st.value; renderClipLibrary(box); };
  const so = box.querySelector('#libSort');
  if (so) so.onchange = () => { clipLib.sort = so.value; renderClipLibrary(box); };
  const dirBtn = box.querySelector('#libDir');
  if (dirBtn) dirBtn.onclick = () => { clipLib.asc = !clipLib.asc; renderClipLibrary(box); };
  const more = box.querySelector('#libMore');
  if (more) more.onclick = () => { clipLib.limit = Math.min(500, clipLib.limit + 200); renderClipLibrary(box); };
  const exp = box.querySelector('#libExport');
  if (exp) exp.onclick = () => {
    /* 导出的是**当前这批行**（与屏幕所见一致），不是另查一遍 —— 免得导出的和看到的不一样 */
    const head = ['标题', '场次时间', '场次', '任务ID', '评分', '时长秒', '状态', '播放', '点赞', 'BV号'];
    const csv = [head.join(',')]
      .concat(rows.map((r) => [r.title, r.taskWhen, r.taskTitle, r.taskId, r.score, r.durationSec, r.status, r.view ?? '', r.like ?? '', r.bvid ?? '']
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')))
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    a.download = `切片库-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${rows.length} 行 CSV`, 4000);
  };
  box.querySelectorAll('[data-lib-preview]').forEach((b) => (b.onclick = async () => {
    const [taskId, index] = String(b.dataset.libPreview).split('|');
    b.disabled = true;
    try {
      const r = await api('/api/preview-cut', { method: 'POST', body: { taskId, index: Number(index) } });
      toast(r.ok ? `已用 ${r.player || '系统播放器'} 播放该片段` : (r.note || '打不开'), 5000);
    } catch (e) { toast('试看失败：' + e.message, 6000); }
    b.disabled = false;
  }));
  /* 稿件级视图（2026-10-11 优化第二批 ⑥）：点 bvid 旁的「看稿件」看这个稿件的全部分P 与健康 */
  box.querySelectorAll('[data-lib-archive]').forEach((b) => (b.onclick = async () => {
    const bvid = String(b.dataset.libArchive || '');
    b.disabled = true;
    try {
      const a = await api('/api/archive/' + encodeURIComponent(bvid));
      const partRows = (a.parts || []).map((x) => `<div class="row"><span class="t">P${x.page}</span><span class="s">${esc(x.title)}${x.durationSec ? ` <span style="color:var(--text-3)">· ${x.durationSec}s</span>` : ''}</span></div>`).join('');
      const clipRows = (a.clips || []).map((c) => `<div class="row"><span class="t">#${c.index}</span><span class="s">${esc(c.title)} <span style="color:var(--text-3)">· ${esc(String(c.status))} · 评分 ${Number(c.score ?? 0).toFixed(1)}</span></span></div>`).join('');
      const health = (a.duplicates || []).length
        ? `<p style="color:#c33;font-weight:600">⚠ 有 ${a.duplicates.length} 个重复分P：${esc(a.duplicates.map((d) => d.title + '×' + d.count).join('、'))} —— 需要到创作中心删掉多余的</p>`
        : (a.missingLocal || []).length
          ? `<p style="color:#c8811a;font-weight:600">⚠ 本地记着 ${a.missingLocal.length} 个切片投到了这个稿件，但线上分P 里没有</p>`
            + `<div class="timeline">${a.missingLocal.map((m) => `<div class="row"><span class="t">#${m.clipIndex}</span><span class="s">${esc(m.title)}
              <button class="linkbtn" data-arch-republish="${esc(m.taskId)}|${m.clipIndex}">重新投稿这一片</button></span></div>`).join('')}</div>`
            + '<p class="hintline">重投前请先到创作中心确认它确实没落地；助手只追加缺失分P，不会产生重复分P。</p>'
          : '<p style="color:var(--green)">✅ 分P 与本地记录一致（无重复、无缺失）</p>';
      openInfo(`稿件 ${bvid}`, `
        <p style="font-size:13px"><b>${esc(a.title || '')}</b><br>
        <a href="${esc(a.url)}" target="_blank" rel="noreferrer">${esc(a.url)}</a></p>
        ${health}
        <p style="font-size:13px">${(a.parts || []).length} 个分P${a.performance ? ` · 播放 ${a.performance.view ?? '—'} / 点赞 ${a.performance.like ?? '—'}（${esc(String(a.performance.date ?? ''))}）` : ''}
        · 本地记着 ${(a.clips || []).length} 个切片属于它</p>
        <h4 style="margin-top:10px">线上分P</h4><div class="timeline">${partRows || '<div class="row"><span class="s" style="color:var(--text-3)">读不到分P 列表</span></div>'}</div>
        ${clipRows ? `<h4 style="margin-top:12px">本地切片（本台账）</h4><div class="timeline">${clipRows}</div>` : ''}`);
    } catch (e) { toast('读取稿件失败：' + e.message, 6000); }
    b.disabled = false;
  }));
  /* P1-4 就地动作：给「已提交待确认」的行一个重投出口（复用既有 approve + includeSubmitted）。
     为什么必须先 confirm 并写清指引：重投的前提是"确实没落地"，这只有人到创作中心看一眼才知道；
     助手只追加缺失的分P，不会产生重复分P（§40 的教训），但前提仍是人工确认。 */
  /* 稿件视图里的同类动作（P1-4）：与切片库共用同一端点与同一套 confirm 文案，行为一致 */
  box.querySelectorAll('[data-arch-republish]').forEach((b) => (b.onclick = async () => {
    const [taskId, index] = String(b.dataset.archRepublish || '').split('|');
    if (!confirm('确认重新投稿这一片？（请先到 B站创作中心确认它确实没落地）')) return;
    b.disabled = true;
    try {
      const r = await api(`/api/task/${encodeURIComponent(String(taskId))}/approve`, { method: 'POST', body: { indices: [Number(index)], includeSubmitted: true } });
      toast(r.note || '已提交重新投稿', 6000);
    } catch (e) { toast('重新投稿失败：' + e.message, 6000); b.disabled = false; }
  }));
  box.querySelectorAll('[data-lib-republish]').forEach((b) => (b.onclick = async () => {
    const [taskId, index] = String(b.dataset.libRepublish || '').split('|');
    if (!confirm('确认重新投稿这一片？\n\n请先到 B站创作中心看它到底有没有落地：\n· 已落地 ⇒ 点「取消」，别重投\n· 确实没落地 ⇒ 点「确定」（助手只追加缺失分P，不会产生重复分P）')) return;
    b.disabled = true;
    try {
      const r = await api(`/api/task/${encodeURIComponent(String(taskId))}/approve`, { method: 'POST', body: { indices: [Number(index)], includeSubmitted: true } });
      toast(r.note || '已提交重新投稿，稍后可在「投稿批次」里看结果', 6000);
      renderClipLibrary(box);
    } catch (e) { toast('重新投稿失败：' + e.message, 6000); b.disabled = false; }
  }));
  box.querySelectorAll('[data-lib-goto]').forEach((b) => (b.onclick = () => {
    const [taskId] = String(b.dataset.libGoto).split('|');
    state.activeId = taskId;
    state.dirty.clear();
    switchView('tasks');
    loadDetail().catch((e) => toast('打开任务失败：' + e.message, 6000));
  }));
}

let perfAutoTried = false;
/** 「测试夹具」开关（默认隐藏；见 renderTaskList 的说明） */
let showFixtureTasks = false;
/** 切片库的检索条件（页内状态，切走再回来保持） */
const clipLib = { q: '', status: '', sort: 'score', asc: false, limit: 200 };
let perfLastRefresh = null;
/* 「稿件已不存在」的行默认不显示；用户想核对时可以展开（见 renderPerf 里的说明） */
let perfShowGone = false;
/* ★ 2026-10-08 用户要求：「这里的排序 可以改成可选的吗 比如稿件时间 播放 点赞 等」。
   字段与方向都记进 localStorage，刷新后保持（取不到就当默认"播放降序"，绝不因为存储异常而白屏）。 */
const PERF_SORTS = [
  { key: 'view', label: '播放' },
  { key: 'like', label: '点赞' },
  { key: 'coin', label: '投币' },
  { key: 'favorite', label: '收藏' },
  { key: 'danmaku', label: '弹幕' },
  { key: 'llmScore', label: 'LLM 评分' },
  { key: 'publishedAt', label: '发布时间' },
  { key: 'statDate', label: '数据日期' },
];
const perfStore = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式等，忽略 */ } },
};
let perfSort = (() => {
  const v = perfStore.get('liveauto.perfSort', 'view');
  return PERF_SORTS.some((s) => s.key === v) ? v : 'view';
})();
let perfSortAsc = perfStore.get('liveauto.perfSortAsc', '0') === '1';

/** 时间字段解析：接口给的是本地时间字符串（`YYYY-MM-DD HH:MM:SS` 或 `YYYY-MM-DD`）。
 *  直接 `Date.parse('2026-10-07 23:33:13')` 在部分环境下不可靠，统一把空格换成 `T` 再解析；
 *  解析不出来就当"没有这个字段"（排序时沉底），绝不因为一条脏数据把整列排序搞乱。 */
function perfTimeMs(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '—') return undefined;
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : undefined;
}

/** 按当前选择给行排序。
 *  两条规矩：① **没有该字段的行永远沉底**（未拉取/取不到的行在升序时会跑到最上面，
 *  把真正有数据的稿件盖住）；② 同值时用播放兜底，保证顺序稳定、不会每次重画都跳。 */
function sortPerfRows(rows) {
  const key = perfSort;
  const dir = perfSortAsc ? 1 : -1;
  const valueOf = (r) => {
    const raw = r[key];
    if (key === 'publishedAt' || key === 'statDate') return perfTimeMs(raw);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  };
  return [...rows].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va === undefined && vb === undefined) return 0;
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    if (va === vb) return (Number(b.view) || 0) - (Number(a.view) || 0);
    return (va - vb) * dir;
  });
}
const perfSortLabel = () => PERF_SORTS.find((s) => s.key === perfSort)?.label ?? '播放';
async function renderPerf(box) {
  const p = await api('/api/performance');
  /* 成本卡片（2026-10-11 从独立页签并进来）：数字与口径同原「成本」页，取的就是这个接口的 monthly ✓ */
  const costData = await api('/api/tasks?limit=500');
  /* 首次打开这一页、且「知道有稿件但一条统计都没拉到」时，自动跑一次回流再重画。
     为什么要自动：这一页的数字全来自回流（performance.jsonl），用户打开它就是想看数据，
     让他先去别处点「刷新稿件表现数据」等于这一页默认是坏的（实测就是这个观感）。
     回流本身按天去重（bvidsNeedingPerformance 跳过当天已拉过的 bvid），所以自动跑一次不会反复打接口；
     只自动尝试一次，失败/无更新就不再自动重试（避免和手动按钮打架、也避免死循环）。 */
  const stale = Number(p.pulledTotal || 0) === 0 && Number(p.archiveTotal || 0) > 0 && !perfAutoTried;
  if (stale) {
    perfAutoTried = true;
    box.innerHTML = `<h2 style="font-size:16px;margin:0 0 14px">稿件表现统计（近 30 天）</h2>
    <p class="hintline">这一页回答：<b>长期资产</b>表现如何 —— 每个稿件的播放/点赞/评分、评分档与播放的相关性，以及月度成本（ASR 估算 + LLM 实际）。数据来自周期性回流。</p>
      <div class="card"><div class="empty">正在拉取 ${p.archiveTotal} 个稿件的表现数据…（首次打开这一页会自动回流一次）</div></div>`;
    try {
      perfLastRefresh = await api('/api/performance/refresh', { method: 'POST' });
      const r = perfLastRefresh;
      toast(`稿件表现数据已回流：更新 ${r.updated}/${r.checked} 个稿件${r.failed?.length ? `，${r.failed.length} 个取不到统计` : ''}`);
    } catch (e) { toast('回流失败：' + e.message); }
    return renderPerf(box);
  }
  const failed = (perfLastRefresh && perfLastRefresh.failed) || [];
  const corrTotal = p.correlation.reduce((a, c) => a + Number(c.count || 0), 0);
  /* ★ 2026-10-07 用户报「已删除的文件 不进行显示」：B站 上已经不存在的稿件（接口的 gone 标记）
     默认不出现在列表里。为什么不一删了之：这种行会堆满整张表（实测一次列出十几条
     「稿件已不存在」），把真正有数据的稿件全挤到下面；但也不能静默吞掉 —— 计数、说明与
     「显示它们」按钮都留着，想核对时一键展开。判据只用接口给的 gone（多分P 中任一P 回流到
     「稿件已不存在」就会带上），UI 不自己猜。 */
  const live = p.rows.filter((r) => !r.gone);
  const goneRows = p.rows.filter((r) => r.gone);
  const shown = sortPerfRows(perfShowGone ? p.rows : live);
  const livePartTotal = live.reduce((a, r) => a + (Number(r.partCount) || 1), 0);
  box.innerHTML = `<h2 style="font-size:16px;margin:0 0 14px">稿件表现统计（近 30 天）</h2>
    <p class="hintline">这一页回答：<b>长期资产</b>表现如何 —— 每个稿件的播放/点赞/评分、评分档与播放的相关性，以及月度成本（ASR 估算 + LLM 实际）。数据来自周期性回流。</p>
    <div class="card"><h2>LLM 评分 vs 实际播放（相关性，非因果）</h2>      ${corrTotal ? `<table class="tbl"><thead><tr><th>评分档</th><th>稿件数</th><th>平均播放</th></tr></thead><tbody>
      ${p.correlation.map((c) => `<tr><td>${esc(c.bucket)}</td><td class="num">${c.count}</td><td class="num">${c.avgView}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">这一档还统计不了：需要「既有 LLM 评分、又拉到了播放数据」的稿件。
        ${Number(p.pulledTotal || 0) > 0 ? `现在有 ${p.pulledTotal} 个稿件有播放数据，但它们的分P 任务是早期投的（评分没有落进表现数据）；新投的稿件会自动带上评分。` : '先让一场直播跑完投稿，再回来刷新。'}</div>`}
      <p class="hintline">${esc(p.note)}</p></div>
    <div class="card"><h2>已发布稿件表现（按${perfSortLabel()}${perfSortAsc ? '升序' : '降序'}）<span class="ai-tag">${live.length} 个在库稿件 · ${livePartTotal} 个分P · 已拉到数据 ${p.pulledTotal ?? 0} 个${goneRows.length ? ` · ${perfShowGone ? `含 ${goneRows.length} 个已删除` : `已隐藏 ${goneRows.length} 个已删除`}` : ''}</span>
      <span style="margin-left:auto;font-weight:400;font-size:12.5px;color:var(--text-2);display:inline-flex;align-items:center;gap:6px">排序
        <button class="btn-sm" id="perfRefreshNow" title="在页面上重查一遍（不动 B站，看的是已落库的最新数据）">🔄 刷新</button>
        <button class="btn-sm" id="perfForceRefresh" title="去 B站 强制拉一次最新统计（忽略每日一次的限制）">⬇️ 强制重拉</button>
        <select id="perfSortKey" class="inp" style="width:auto;padding:3px 8px;font-size:12.5px">
          ${PERF_SORTS.map((s) => `<option value="${s.key}"${s.key === perfSort ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
        </select>
        <button class="btn-sm" id="perfSortDir" title="切换升序/降序">${perfSortAsc ? '↑ 升序' : '↓ 降序'}</button>
      </span></h2>
      <p class="hintline" id="perfFreshNote" style="min-height:18px"></p>
      ${shown.length ? `<table class="tbl"><thead><tr><th>标题</th><th>评分</th><th>播放</th><th>点赞</th><th>投币</th><th>收藏</th><th>弹幕</th><th title="这个稿件最近一次投出切片的时间（同稿件多分P 取最近）">发布时间</th><th>数据日期</th></tr></thead><tbody>
      ${shown.map((r) => `<tr><td><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.title)}</a>${r.gone ? ' <span class="tag-mini">稿件已不存在</span>' : ''}${r.unavailable ? ` <span class="tag-mini">${esc(r.unavailable)}</span>` : ''}${r.degraded ? ' <span class="tag-mini">降级</span>' : ''}${Number(r.partCount) > 1 ? ` <span class="ai-tag">同一稿件 ${r.partCount} 个分P</span>` : ''}</td>
        <td class="num">${r.llmScore === undefined ? '—' : Number(r.llmScore).toFixed(1)}</td><td class="num">${r.view ?? '—'}</td><td class="num">${r.like ?? '—'}</td>
        <td class="num">${r.coin ?? '—'}</td><td class="num">${r.favorite ?? '—'}</td><td class="num">${r.danmaku ?? '—'}</td>
        <td class="mono-sm">${esc(r.publishedAt || '—')}</td>
        <td class="mono-sm">${esc(r.statDate || (r.gone ? '已删除' : r.unavailable ? '取不到' : '未拉取'))}</td></tr>`).join('')}
      </tbody></table>
      <p class="hintline">多分P 模式下同一稿件的各分P 共享稿件总播放，所以按稿件（bvid）列一行；「同一稿件 N 个分P」标出它的规模。播放数为 0 以前是「接口没取到」，现在只有真取到才写数字，取不到会标出原因。</p>` : `<div class="empty">还没有可统计的稿件。${goneRows.length && !live.length
        ? `现存的稿件一个都没有 —— 已隐藏 ${goneRows.length} 个在 B站 上已不存在的（点下面的「显示它们」可核对）。`
        : Number(p.archiveTotal || 0) > 0
          ? '有稿件但一条都没拉到：展开「健康面板 → 刷新稿件表现数据」重试。'
          : '切片要先投出去并拿到 bvid（多分P 续传成功后自动写入），然后才会出现在这里。'}</div>`}
      ${goneRows.length ? `<p class="hintline">已隐藏 ${goneRows.length} 个 B站 上已不存在的稿件（被删或下架，取不到任何数据）：<button class="linkbtn" id="perfGoneToggle">${perfShowGone ? '收起它们' : '显示它们'}</button></p>` : ''}
      ${failed.length ? `<p class="hintline">上次回流有 ${failed.length} 个稿件取不到统计：${failed.map((f) => `${esc(f.bvid)}（${esc(String(f.error).slice(0, 60))}）`).join('、')}</p>` : ''}</div>
    <!-- ★ 2026-10-11 用户要求把「成本」并进这一页（原来的独立页签让给了回收站/待删清单）。
         用原生 <details> 默认收起：这一页的主角是稿件表现，成本是"顺手看一眼"的附属信息。 -->
    <details class="group"><summary style="cursor:pointer;font-size:14px;font-weight:600">成本（月度汇总 · ${esc(String(costData.monthly.month))}）</summary>
      <div class="inner" style="padding-top:10px">
        ${costData.monthly.fixturesExcluded
          ? `<p class="hintline">已排除 <b>${costData.monthly.fixturesExcluded}</b> 个<b>测试夹具</b>任务（自动化测试造的，不算真实开销）；
             要看它们请到任务列表勾「显示测试夹具」。</p>`
          : ''}
        ${costHtml(costData.monthly)}</div>
    </details>`;
  /* 「显示它们 / 收起它们」与排序选择器是这张卡里的两个事件，就地绑定（与其它卡片的写法一致）。
     排序改完**整页重画**：只是重新排一遍，API 数据没变（多一次本地 GET，可忽略）。 */
  const goneToggle = box.querySelector('#perfGoneToggle');
  if (goneToggle) goneToggle.addEventListener('click', () => { perfShowGone = !perfShowGone; renderPerf(box); });
  /* ★ 2026-10-14：这一页自己的刷新入口 + **结果反馈**。
     用户实测反馈"刷新不及时"：其实刷新按钮原来只在健康面板上，而且候选为空时接口只回一句 notes、
     界面不显示 ⇒ 点了像没反应。现在：按钮在本页、结果写在这行提示里（含"今天已拉过"这种正常情况）。 */
  const perfNote = (msg, kind) => {
    const el = box.querySelector('#perfFreshNote');
    if (!el) return;
    el.textContent = msg;
    el.style.color = kind === 'bad' ? '#c33' : kind === 'ok' ? '#2a7' : '';
  };
  const perfDoRefresh = async (force) => {
    const b1 = box.querySelector('#perfRefreshNow');
    const b2 = box.querySelector('#perfForceRefresh');
    if (b1) b1.disabled = true;
    if (b2) b2.disabled = true;
    perfNote(force ? '正在向 B站 强制拉取（会慢几秒）…' : '正在重查…');
    try {
      const r = await api('/api/performance/refresh', { method: 'POST', body: force ? { force: true } : {} });
      const at = new Date().toLocaleTimeString('zh-CN');
      if (r.noop) {
        /* 这两种"没拉到"都是**正常**的，必须说清 —— 否则用户以为功能坏了 */
        perfNote((r.notes && r.notes[0]) || '没有需要拉取的稿件', '');
      } else {
        perfNote(`${force ? '强制重拉' : '刷新'}完成：更新 ${r.updated}/${r.checked} 个稿件${r.failed && r.failed.length ? `，${r.failed.length} 个取不到统计` : ''}（${at}）`, r.failed && r.failed.length ? 'bad' : 'ok');
      }
      await renderOther('perf');
      const el = document.getElementById('perfFreshNote');
      if (el) {
        el.textContent = r.noop ? ((r.notes && r.notes[0]) || '没有需要拉取的稿件') : `${force ? '强制重拉' : '刷新'}完成：更新 ${r.updated}/${r.checked} 个稿件（${at}）`;
      }
      if (!r.noop) toast(`已更新 ${r.updated}/${r.checked} 个稿件`, 4000);
    } catch (e) {
      perfNote('刷新失败：' + e.message, 'bad');
      toast('刷新失败：' + e.message, 6000);
    }
    const b1b = document.getElementById('perfRefreshNow');
    const b2b = document.getElementById('perfForceRefresh');
    if (b1b) b1b.disabled = false;
    if (b2b) b2b.disabled = false;
  };
  const rn = box.querySelector('#perfRefreshNow');
  if (rn) rn.onclick = () => perfDoRefresh(false);
  const rf = box.querySelector('#perfForceRefresh');
  if (rf) rf.onclick = () => perfDoRefresh(true);
    const sortSel = box.querySelector('#perfSortKey');
  if (sortSel) sortSel.onchange = () => {
    perfSort = PERF_SORTS.some((s) => s.key === sortSel.value) ? sortSel.value : 'view';
    perfStore.set('liveauto.perfSort', perfSort);
    renderPerf(box);
  };
  const sortDir = box.querySelector('#perfSortDir');
  if (sortDir) sortDir.onclick = () => {
    perfSortAsc = !perfSortAsc;
    perfStore.set('liveauto.perfSortAsc', perfSortAsc ? '1' : '0');
    renderPerf(box);
  };
}

async function renderPrompts(box) {
  const p = await api('/api/prompts');
  box.innerHTML = `<h2 style="font-size:16px;margin:0 0 14px">Prompt 文件（可直接编辑，下次分析生效）</h2>
    <div class="barstrip info">选片质量的核心在这里。验收标准是「抽检 10 个候选片段 ≥6 个值得发布」，需要 2–3 轮 prompt 迭代。
      <b>改完不需要重启</b>：分析时会重新读取文件。</div>
    ${p.prompts.map((x) => `<div class="card"><h2>${esc(x.name)}.md <span class="ai-tag">${x.bytes} 字节</span>
      ${x.name === 'chunk' || x.name === 'summary' || x.name === 'select' ? '<span class="ai-tag" style="background:#fff8ec;color:#c8811a">system prompt：改动会使 DeepSeek 缓存失效</span>' : ''}</h2>
      <pre class="raw">${esc(x.text)}</pre>
      <p class="hintline">文件路径：prompts/${esc(x.name)}.md</p></div>`).join('')}`;
}

