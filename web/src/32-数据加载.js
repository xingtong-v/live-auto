/* ============================================================================
 * 数据加载
 * ========================================================================== */
/* 顶栏的「字幕」开关（默认关，随时能切）。
   为什么单独给它一个按钮、而不是只留在设置里：字幕曾经被**整体关掉**，原因是云端 ASR 的
   句级时间窗不可靠 —— 实测「15 个字的句子占了 0→30.9 秒」，烧出来与声音整体错位。
   换成本地 Fun-ASR 后字级时间戳是准的（实测偏差 ±0.2 秒），那时烧字幕才成立。
   所以这个开关不只显示一个布尔值，它要顺带回答「现在这台机器上烧字幕值不值得」：
   本地引擎 → 绿色；云端引擎 → 琥珀色警告。 */
function renderSubtitleSwitch() {
  const cfg = (state.bootstrap && state.bootstrap.config) || {};
  const on = !!(cfg.clip && cfg.clip.burnSubtitles);
  const provider = String((cfg.asr && cfg.asr.provider) || '');
  const local = provider === 'local-funasr' || provider === 'whisper-cpp';
  const sw = $('#subSwitch');
  if (sw) sw.classList.toggle('on', on);
  const box = $('#subMode');
  if (box) {
    box.classList.toggle('ok', on && local);
    box.classList.toggle('warn', on && !local);
  }
  const t = $('#subText');
  if (t) t.textContent = !on ? '字幕：关' : (local ? '字幕：开 · 本地 ASR' : '字幕：开 · 云端 ASR 可能错位');
}

async function loadBootstrap() {
  state.bootstrap = await api('/api/bootstrap');
  const b = state.bootstrap;
  $('#modeSwitch').classList.toggle('on', b.mode.autoPublish);
  $('#modeText').textContent = b.mode.autoPublish ? '全自动 · 免确认发布' : '半自动 · 需确认后发布';
  renderSubtitleSwitch();
  /* 房间号只有一个（它只用于"开播触发"这条次要路径），而**导入走目录轮询**、
     覆盖录制根目录下的全部主播 ⇒ 把覆盖数一并显示，免得看起来像"只处理一个直播间"
     （2026-10-13 用户就是照这里问的："只能单个直播间吗，我想两个都显示"）。 */
  const covered = Number(b.coveredStreamers || 0);
  $('#brandText').textContent =
    `房间 ${b.roomId}` +
    (covered > 1 ? `（触发）· 轮询覆盖 ${covered} 个直播间` : covered === 1 ? ' · 轮询覆盖 1 个直播间' : '') +
    ` · v${b.version}` +
    (b.mode.isOnlySelf ? ' · 仅自己可见' : '') +
    (b.seasonConfigured ? '' : ' · 未配置合集');
}

async function loadTasks() {
  const qs = new URLSearchParams();
  if (state.status) qs.set('status', state.status);
  if (state.q) qs.set('q', state.q);
  const data = await api('/api/tasks?' + qs.toString());
  state.tasks = data.tasks;
  state.monthly = data.monthly;
  if (!state.activeId && state.tasks.length) state.activeId = state.tasks[0].id;
  if (state.activeId && !state.tasks.some((t) => t.id === state.activeId)) {
    state.activeId = state.tasks.length ? state.tasks[0].id : null;
  }
  renderTaskList();
}

async function loadDetail() {
  if (!state.activeId) { $('#detail').innerHTML = '<div class="empty">左侧还没有任务。服务正在轮询录制历史，也可以在右上角点「立即检查」。</div>'; return; }
  state.detail = await api('/api/task/' + encodeURIComponent(state.activeId));
  renderDetail();
}

async function loadSchedule() {
  state.schedule = await api('/api/schedule');
  /* 自动导入的状态也一起取：用户看不到"它在等什么"时，会以为轮询没生效，
     然后自己去手动导入（于是任务标成「手动导入」，更困惑）。 */
  try { state.watch = await api('/api/watch'); } catch { state.watch = null; }
  renderSchedule();
}

async function refreshAll(silent) {
  try {
    await loadTasks();
    await Promise.all([loadDetail(), loadSchedule()]);
    void refreshPendingBadge();
  } catch (e) {
    if (!silent) toast('加载失败：' + e.message);
  }
}

/**
 * 待删清单角标：有待删文件时直接在**页签**上显示数量和释放空间。
 *
 * 为什么要在页签上提示而不是只写在页面里：这个功能的默认宽限期是 24 小时，
 * 用户很可能根本不记得它还挂着 —— 到点删掉了源录播才发现就晚了。
 * （2026-10-11：入口从设置弹窗搬到了标签栏，角标跟着搬到页签上；旧 id 保留兼容。）
 */
async function refreshPendingBadge() {
  const badge = $('#pendingTabBadge') || $('#pendingDeleteBadge');
  const hint = $('#pendingDeleteHint');
  if (!badge) return;
  try {
    const r = await api('/api/pending-delete');
    const n = r.stats.pendingCount;
    if (n > 0) {
      badge.textContent = `（${n} 项 · ${fmtBytes(r.stats.pendingBytes)}）`;
      badge.style.color = '#c33';
      if (hint && r.stats.nextDueAt) hint.textContent = `最早 ${fmtTime(Date.parse(r.stats.nextDueAt))} 自动删除；宽限期内可取消。`;
    } else {
      badge.textContent = '';
      if (hint) hint.textContent = '本场全部切片确认投稿成功后，成片与源录播会排进待删清单，宽限期过后自动删除。宽限期内可在这里取消。';
    }
  } catch {
    /* 角标拿不到不影响主流程 */
  }
}

/**
 * 待删清单的「立即删除」：确认文案必须区分**两种截然不同的后果**。
 *
 * - 同盘（`willTrash`）→ 移入回收站，7 天内可恢复 → 文案说明"可恢复"；
 * - 异盘 → 回收站在别的盘，整份复制 20 GB 不现实 → 直接删，**不可恢复** →
 *   必须用"永久删除 / 无法恢复"这样的字眼，并把文件名列出来，别让人点下去才发现。
 *
 * 返回删除结果（`null` = 用户取消），调用方据此刷新自己的视图。
 */
async function deletePendingNow(ids, entries) {
  const list = (entries || []).filter((e) => ids.includes(e.id));
  /* 防御：真要删的条目一个都不在**待删**清单里（比如界面给了已删条目的按钮、或清单刚被别处刷新过）
     就别弹"共 0.0 MB"那种莫名其妙的话 —— 直接说清并收手。 */
  if (ids.length === 0 || list.length === 0) {
    toast('这些条目已经处理过了，无需再删', 5000);
    return null;
  }
  const permanent = list.filter((e) => e.willTrash === false);
  const gone = list.filter((e) => e.existsNow === false);
  const mb = (list.reduce((a, e) => a + (Number(e.sizeBytes) || 0), 0) / 1048576).toFixed(1);
  let msg = `立即删除 ${ids.length} 个文件（共 ${mb} MB）？\n\n不是等到宽限期，而是现在就删。`;
  const toTrash = list.length - permanent.length - gone.length;
  if (toTrash > 0) msg += `\n· ${toTrash} 个移入回收站，7 天内可恢复`;
  if (gone.length) msg += `\n· ${gone.length} 个文件已经不在磁盘上（只会标记为已删除）`;
  if (permanent.length) {
    const names = permanent.slice(0, 3).map((e) => String(e.path).split(/[\\/]/).pop());
    msg += `\n\n⚠️ 其中 ${permanent.length} 个在别的盘（回收站在本盘），删除后【无法恢复】：\n  ${names.join('\n  ')}${permanent.length > 3 ? `\n  …等 ${permanent.length} 个` : ''}`;
  }
  if (!confirm(msg)) return null;

  const body = ids.length === 1 ? { id: ids[0] } : { ids };
  const r = await api('/api/pending-delete/delete', { method: 'POST', body });
  toast(r.note, 7000);
  void refreshPendingBadge();
  return r;
}

/** 待删条目的一行标签与按钮（清单页 / 监控面板共用，两处文案不能漂移） */
function pendingRowActions(e, opts = {}) {
  /* ★ 2026-10-11 用户实测踩到：**「最近已删除」的行也挂着「立即删除」按钮** ——
     点下去还弹「立即删除 1 个文件（共 0.0 MB）？」，纯属误导（文件早就不在了；
     服务端会把它归到 skipped「这一条已经删过了」）。已删条目只留结果说明，不给任何动作按钮。
     行正文里已经写了「已移入回收站 / 已永久删除」（`deletedBy`），所以这里什么都不用再挂。 */
  if (e.deletedAt || e.deletedBy) return e.deletedBy ? '' : '<span class="tag-mini">已删除</span>';
  const willTrash = e.willTrash !== false;
  const tag = e.existsNow === false
    ? '<span class="tag-mini">文件已不在</span>'
    : willTrash
      ? '<span class="tag-mini">删除→回收站</span>'
      : '<span class="tag-mini" style="background:#fdecec;color:#c33">跨盘·删除不可恢复</span>';
  const label = e.existsNow === false ? '标记为已删除' : '立即删除';
  return `${tag}<button class="btn-sm" style="margin-left:6px" data-pending-del="${esc(e.id)}">${label}</button>` +
    (opts.cancellable ? `<button class="btn-sm" data-cancel="${esc(e.id)}">取消删除</button>` : '');
}

