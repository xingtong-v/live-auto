/* ============================================================================
 * 运行观测（/api/monitor + /api/observe，默认 5 秒自动刷新）
 *
 * 为什么再开一页（而不是塞进「实时监控」）：
 *   实时监控回答的是"任务视角"——这一场跑到哪、在等什么、为什么没动。
 *   但守着直播的人还要看**机器视角**的四件事，它们在监控页里没有位置：
 *     ① 边录边转到底转了没有（每场已完成 N/M 段、最近几轮 tick 的判定）
 *     ② 压制/上传在跑什么、进度多少、还要多久（biliLive-tools 的队列明细）
 *     ③ 我们自己的资源占用（进程内存、本地 ASR 的精度与显存峰值）
 *     ④ 最近几场（状态、切片数、开始时间）
 *
 * 2026-10-13 加，起因：验证「边录边转」时只能命令行 grep 日志。
 * 同日第二版（用户反馈"显示得不够清楚"）：
 *   · 时间全部转**本地时区**（日志存的是 UTC，原来直接显示 ⇒ 比用户的钟慢 8 小时）；
 *   · 判定区滤掉"循环已启动"这类噪声，并按类型上色；
 *   · 队列显示任务名 + 进度条 + 已跑时长 + ETA + 产物
 *     （biliLive-tools 的字段是 taskId/progress/output/startTime，原来按 id 取 ⇒ 界面一直是"-"）；
 *   · 顶部加总览条。
 *
 * ⚠️ 样式**从这里注入**，不写进 10-style.css：实测把 CSS 追加到那个文件会被构建当正文带进页面
 *    （截图里页面顶部出现一大段 CSS 源码）。注入式还顺带保证"只有进过这一页才加载这段样式"。
 * ========================================================================== */

const OBSERVE_INTERVAL_MS = 5000;

/** 一次性注入本页样式（幂等：靠 id 判断） */
function ensureObserveStyle() {
  if (document.getElementById('observe-style')) return;
  const el = document.createElement('style');
  el.id = 'observe-style';
  el.textContent = `
.obs-summary .card-head { align-items: baseline; gap: 12px; flex-wrap: wrap; }
.obs-sum { color: var(--text-3, #666); font-size: 13px; }
.obs-sum b { color: var(--text-1, #111); font-size: 15px; padding: 0 2px; }
.obs-tbl td, .obs-tbl th { padding-top: 9px; padding-bottom: 9px; }
.obs-strong { font-weight: 600; }
.obs-bar { display: inline-block; width: 120px; height: 7px; border-radius: 4px; background: var(--border, #e5e7eb); vertical-align: middle; overflow: hidden; }
.obs-bar > i { display: block; height: 100%; background: #3b82f6; border-radius: 4px; transition: width .3s ease; }
.obs-bar > i.ok { background: #10b981; }
.obs-note { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: 1px dashed var(--border, #eee); font-size: 13px; }
.obs-note:first-of-type { border-top: none; }
.obs-sub { margin: 12px 0 4px; font-weight: 600; color: var(--text-3, #666); font-size: 13px; }
/* ④ 用表格：列清楚、一眼扫完（用户明确要的形态）。
   table-layout:fixed + 首列省略号 ⇒ 窄窗口也不会把后面的列挤出屏幕。 */
.obs-tl { table-layout: fixed; }
.obs-tl th:nth-child(1), .obs-tl td:nth-child(1) { width: 42%; }
.obs-tl th:nth-child(2), .obs-tl td:nth-child(2) { width: 17%; }
.obs-tl th:nth-child(3), .obs-tl td:nth-child(3) { width: 16%; }
.obs-tl th:nth-child(4), .obs-tl td:nth-child(4) { width: 25%; }
.obs-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obs-nowrap { white-space: nowrap; }
.obs-dim { color: var(--text-3, #999); font-size: 12px; }
`;
  document.head.appendChild(el);
}

function stopObserve() {
  const o = state.obs;
  if (o && o.timer) {
    clearInterval(o.timer);
    o.timer = null;
  }
}

function startObserve() {
  const o = (state.obs = state.obs || { timer: null, data: null, paused: false });
  ensureObserveStyle();
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

/* ── 显示辅助 ───────────────────────────────────────────────────────────── */

/** ISO / 毫秒 → 本地 时:分:秒（日志存 UTC，必须转，否则比用户的钟慢 8 小时） */
function obsTime(v) {
  if (!v) return '—';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v).slice(11, 19);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

/** ISO → 本地 月-日 时:分（跨天时看得出是哪天） */
function obsStamp(v) {
  if (!v) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function obsDur(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '—';
  const s = Math.round(sec);
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  return (s / 3600).toFixed(1) + ' 小时';
}

function obsAgo(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '—';
  return obsDur(sec) + '前';
}

function obsMB(bytes) {
  if (!bytes && bytes !== 0) return '—';
  return bytes > 1073741824 ? (bytes / 1073741824).toFixed(2) + ' GB' : (bytes / 1048576).toFixed(1) + ' MB';
}

function obsBar(pct, kind) {
  const p = pct === null || pct === undefined ? null : Math.max(0, Math.min(100, pct));
  return `<span class="obs-bar"><i class="${kind || ''}" style="width:${p === null ? 0 : p}%"></i></span>`;
}

function obsFile(name, keep) {
  const s = String(name || '');
  const n = keep || 46;
  if (s.length <= n) return s;
  const ext = (s.match(/\.[a-z0-9]+$/i) || [''])[0];
  return s.slice(0, n - ext.length - 1) + '…' + ext;
}

/** 状态/类型 → 中文。映射表由服务端下发（见 server.ts 的 STATUS_LABELS），这里只做兜底。 */
function obsLabel(map, raw) {
  const key = String(raw ?? '');
  return (map && map[key]) || key || '—';
}
function obsStatusText(raw) {
  return obsLabel((state.obs && state.obs.data && state.obs.data.mon && state.obs.data.mon.statusLabels) || null, raw);
}
function obsClipStatusText(raw) {
  return obsLabel((state.obs && state.obs.data && state.obs.data.mon && state.obs.data.mon.clipStatusLabels) || null, raw);
}
function obsTypeText(raw) {
  return obsLabel((state.obs && state.obs.data && state.obs.data.mon && state.obs.data.mon.llcTypeLabels) || null, raw);
}
function obsQueueStatusText(raw) {
  return obsLabel((state.obs && state.obs.data && state.obs.data.mon && state.obs.data.mon.llcStatusLabels) || null, raw);
}

/* 说明：这里曾经有个 obsSteps() 画"五个阶段胶囊"。用户反馈"难看而且难懂"后删掉 ——
   阶段信息用状态文案表达（"转写中 3/10" / "已发布"）比五个胶囊更省地方也更好懂。
   组件删了，但把理由留在这里，免得以后又有人加回来。 */

function obsNoteKind(msg) {
  if (/让路/.test(msg)) return { cls: 'b-wait', label: '让路' };
  if (/已转 \d+\/\d+/.test(msg)) return { cls: 'b-done', label: '已转' };
  if (/本轮无新段可转/.test(msg)) return { cls: 'b-run', label: '无新段' };
  if (/没有候选场次|本轮无事/.test(msg)) return { cls: '', label: '空闲' };
  if (/出错|失败/.test(msg)) return { cls: 'b-fail', label: '出错' };
  return { cls: '', label: '其它' };
}

function renderObserve(box) {
  const o = state.obs && state.obs.data;
  if (!o) {
    box.innerHTML = '<div class="empty">加载中…</div>';
    return;
  }
  ensureObserveStyle();
  const { mon, obs } = o;
  const mem = obs.memory || {};
  const recording = obs.recording || [];
  const pre = obs.preTranscribe || [];
  const queue = obs.queue || [];
  const tl = obs.timeline || [];

  const notes = (obs.preTranscribeLog || [])
    .filter((l) => !/循环已启动/.test(l.msg))
    .slice(-6)
    .reverse();

  const qRows = queue
    .map((q) => {
      const pct = q.progress === null || q.progress === undefined ? null : q.progress;
      return `<tr>
        <td><span class="badge" title="${esc(q.type)}">${esc(obsTypeText(q.type))}</span></td>
        <td class="obs-strong">${esc(obsFile(q.name || q.taskId, 40))}</td>
        <td><span class="badge ${q.status === 'running' ? 'b-run' : ''}" title="${esc(q.status)}">${esc(obsQueueStatusText(q.status))}</span></td>
        <td>${obsBar(pct)} <span class="mono-sm">${pct === null ? '—' : pct + '%'}</span></td>
        <td class="mono-sm">${obsDur(q.elapsedSec)}</td>
        <td class="mono-sm">${q.etaSec === null || q.etaSec === undefined ? '—' : obsDur(q.etaSec)}</td>
        <td class="mono-sm" title="${esc(q.output || '')}">${esc(obsFile((q.output || '').split(/[\\/]/).pop() || '—', 34))}</td>
      </tr>`;
    })
    .join('');

  const recRows = recording
    .map(
      (r) => `<tr>
        <td class="obs-strong" title="${esc(r.name)}">${esc(obsFile(r.name, 52))}</td>
        <td class="mono-sm">${obsMB(r.sizeBytes)}</td>
        <td class="mono-sm">${r.rateMBps === null || r.rateMBps === undefined ? '—' : r.rateMBps.toFixed(2) + ' MB/s'}</td>
        <td class="mono-sm">${obsAgo(r.ageSec)}</td>
        <td>${r.growing ? '<span class="badge b-run">在写</span>' : '<span class="badge">已停</span>'}</td>
      </tr>`,
    )
    .join('');

  const preRows = pre
    .map((p) => {
      const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
      /* 每条记录都打状态标签（2026-10-14 用户两次问「没在录了为什么还有进度」）：
         这一栏读的是录像目录里的**进度文件**，不是"当前录制状态"，所以必须说清它属于哪种：
           · 仍在写 → 这一场正在录；
           · 已导入 → 那场已经进过流水线（记录留着只为命中缓存），不会再变；
           · 历史   → 超过 1 小时没更新且没查到对应任务（多半是旧场次留下的）。 */
      const state = p.stillWriting
        ? '<span class="badge b-run">仍在写</span>'
        : p.imported
          ? '<span class="badge b-done">已导入</span>'
          : p.ageSec > 3600
            ? '<span class="badge">历史</span>'
            : '<span class="badge b-done">最近</span>';
      return `<tr>
        <td><span class="obs-strong">${esc(p.name)}</span><span class="obs-dim">${p.dir ? ' · ' + esc(p.dir) : ''}</span></td>
        <td>${obsBar(pct, 'ok')} <span class="mono-sm">${p.done}/${p.total} 段</span></td>
        <td>
          ${p.mode === 'fallback' ? '<span class="badge b-fail">已回退整段</span>' : '<span class="badge b-done">分段增量</span>'}
          ${state}
        </td>
        <td class="mono-sm">${obsAgo(p.ageSec)}</td>
      </tr>`;
    })
    .join('');
  /* 「进行中」只算**仍在写或最近 30 分钟更新过**的；其余算历史记录（保留在表里，但不计入数字）——
     否则一场直播结束、任务也被策略清理之后，这一栏会永远挂着"1 场有进度"。 */
  const preActive = pre.filter((p) => p.stillWriting || Number(p.ageSec) <= 1800);
  const preHistory = pre.length - preActive.length;

  const noteRows = notes
    .map((l) => {
      const k = obsNoteKind(l.msg);
      return `<div class="obs-note"><span class="badge ${k.cls}">${k.label}</span><span class="mono-sm">${obsTime(l.atIso || l.at)}</span><span>${esc(l.msg)}</span></div>`;
    })
    .join('');

  /* ④ 每场两行：第一行"标题 + 中文状态"，第二行"阶段链 + 切片数 + 开始时间 + 短 id"。
     为什么不用表格：窄窗口下后面的列会被切掉（用户截图里只剩"场次"一列），
     而"哪里在跑、跑到哪一步"恰恰是后面那几列的信息。 */
  /* ④ 表格（用户 2026-10-13 明确要求这个形态："UI 做成这样呢，中文标题"）。
     演进史，免得再走回头路：
       ① 只有一串 id 的表格 ⇒ 看不懂；
       ② 我改成"两行式 + 五个阶段胶囊" ⇒ 用户说"难看而且难懂"（已完成的场次五个胶囊全亮，等于没说）；
       ③ 收成两行式（无胶囊）⇒ 用户仍要**表格**这个形态。
     最终：**表格** + 第一列显示**中文标题**（id 放悬停） + 状态中文 + 时间本地且带"多久前"。
     时间由客户端按 createdAt 算（服务端不再下发冗余字段）。 */
  const tlRows = tl
    .map((t) => {
      const title = t.title && t.title.length > 1 ? t.title : String(t.id).replace(/^auto-/, '');
      const chip = /PUBLISHED/.test(t.status) ? 'b-done' : /FAIL|ERROR/.test(t.status) ? 'b-fail' : 'b-run';
      const startedSec = t.createdAt ? Math.max(0, Math.round((Date.now() - new Date(t.createdAt).getTime()) / 1000)) : null;
      return `<tr>
        <td class="obs-title" title="${esc(t.id)}">${esc(title)}</td>
        <td><span class="badge ${chip}" title="${esc(t.status)}">${esc(t.statusText || obsStatusText(t.status))}</span></td>
        <td class="obs-nowrap">${t.clips} 片 · 选中 ${t.selected}</td>
        <td class="obs-nowrap mono-sm">${esc(obsStamp(t.createdAt))}${startedSec === null ? '' : `<span class="obs-dim">（${obsAgo(startedSec)}）</span>`}</td>
      </tr>`;
    })
    .join('');

  const health = (obs.asrHealth || [])
    .slice(-3)
    .reverse()
    .map((h) => `<div class="obs-note"><span class="mono-sm">${obsTime(h.atIso || h.at)}</span><span>${esc(h.msg)}</span></div>`)
    .join('');

  /* ★ 2026-10-13 用户要求"做一个检测 biliLive-tools 的直播录制检测"。
     原来"录制中"是数**文件正在长**的个数（事后近似）；现在优先用 biliLive-tools 录制器自报的
     `liveInfo.living` / `state`（真信号），文件那套只作交叉校验与兜底。
     两个来源不一致时把两边都写出来 —— 不一致本身就是值得看的信息。 */
  const rec = o.recorder || { ok: false, recording: 0, live: 0, recorders: [] };
  const growingN = recording.filter((r) => r.growing).length;
  const recN = rec.ok ? Number(rec.live || 0) : null;
  const recLabel = !rec.ok
    ? `录制中 <b>?</b>（biliLive-tools 问不到）`
    : recN === 0 && growingN === 0
      ? `录制中 <b>0</b>（录制器全部空闲）`
      : `录制中 <b>${recN}</b>${growingN && growingN !== recN ? `（文件在写 ${growingN}）` : ''}`;
  const summary = [
    recLabel,
    /* ⚠️ 措辞必须把"两种场次"分开（2026-10-14 用户截图问「当检测到录制中时这里才会运行」）：
       原来只写「边录边转 N 场」，会被读成"正在录 N 场"—— 但它其实是**有预转写进度记录**的场次数，
       与"此刻在不在录"无关（录制结束后那一条会一直留着，等导入时命中）。
       现在写成「有进度 N 场（录制中 M 场）」，一眼能分清。 */
    `边录边转 <b>${pre.length}</b> 场有进度${pre.length ? `（其中本段仍在写 <b>${pre.filter((p) => p.stillWriting).length}</b> 场）` : ''}`,
    `压制/上传 <b>${queue.length}</b> 个`,
    `内存 <b>${mem.rssMB ?? '—'}</b> MB`,
    `同步于 ${o.at.toLocaleTimeString('zh-CN', { hour12: false })}`,
  ].join(' · ');

  box.innerHTML = `
    <div class="card obs-summary">
      <div class="card-head">
        <b>运行观测</b>
        <span class="obs-sum">${summary}</span>
        <button class="btn-sm" id="obsPause">${state.obs.paused ? '继续刷新' : '暂停刷新'}</button>
      </div>
      <div class="hintline">只读页：边录边转进度、压制/上传明细、资源与 ASR 体检。时间一律<b>本地时区</b>（日志里存的是 UTC）。</div>
      ${rec.ok && rec.recorders.length
        ? `<div class="hintline">biliLive-tools 录制器（${rec.recorders.length} 个）：${rec.recorders
            .map(
              (x) =>
                `<b>${esc(x.owner || x.channelId)}</b> 房间 ${esc(x.channelId)} · ${
                  x.living ? '<span class="badge b-run">正在直播</span>' : '<span class="badge">未开播</span>'
                } · 录制器 ${esc(x.state || '?')}${x.lastRecordSec === null ? '' : ` · 上次录制 ${obsAgo(x.lastRecordSec)}`}`,
            )
            .join('　|　')}</div>`
        : `<div class="hintline">biliLive-tools 录制器状态问不到（${esc(rec.error || '接口异常')}）—— 此时"录制中"退回按文件是否在写判断，不影响边录边转。</div>`}
    </div>

    <div class="card">
      <div class="card-head"><b>① 正在录制的文件</b><span class="badge ${recording.length ? 'b-run' : ''}">${recording.length} 个</span></div>
      ${
        recRows
          ? `<table class="tbl obs-tbl"><thead><tr><th>文件</th><th>大小</th><th>速率</th><th>最后写入</th><th>状态</th></tr></thead><tbody>${recRows}</tbody></table>`
          : '<div class="empty">当前没有在写的录制文件（每轮目录轮询的结论见「实时监控」页）</div>'
      }
    </div>

    <div class="card">
      <div class="card-head"><b>② 边录边转（预转写）</b><span class="badge ${preActive.length ? 'b-done' : ''}">${preActive.length} 场进行中${preHistory ? ` · 另有 ${preHistory} 条历史记录` : ''}</span></div>
      ${
        preRows
          ? `<table class="tbl obs-tbl"><thead><tr><th>场次</th><th>已完成</th><th>路径</th><th>更新</th></tr></thead><tbody>${preRows}</tbody></table>`
          : '<div class="empty">还没有场次留下进度（旧格式的历史状态不再显示——它没法区分是哪一场，显示出来只会误导）。若正在直播却为空，看下面的"最近判定"：多半是让路，或候选判定没命中。</div>'
      }`
      + `
      <div class="hintline">粒度：biliLive-tools 会把一场直播切成多个分段文件（<span class="mono-sm">.ts</span> / <span class="mono-sm">-PART001.ts</span>…）。<b>正在写的那个分段不会转</b>（末次写入距今不到 2 分钟即视为"仍在写入"），写完之后的下一次检查就会转它 —— 所以一场 4 小时的直播，下播时通常只剩最后一个分段要转。
      }
      ${noteRows ? `<div class="obs-sub">最近判定（已滤掉"循环已启动"这类噪声）</div>${noteRows}` : ''}
    </div>

    <div class="card">
      <div class="card-head"><b>③ 压制 / 上传队列</b><span class="badge ${queue.length ? 'b-run' : ''}">${queue.length} 个进行中</span></div>
      ${
        qRows
          ? `<table class="tbl obs-tbl"><thead><tr><th>类型</th><th>任务</th><th>状态</th><th>进度</th><th>已跑</th><th>预计还需</th><th>产物</th></tr></thead><tbody>${qRows}</tbody></table>`
          : '<div class="empty">队列空闲</div>'
      }
      <div class="hintline">完整版（弹幕版 + 纯享版）由 biliLive-tools 压制与上传；它投出去之后，等完整版的切片才会被追加成分P。</div>
    </div>

    <div class="card">
      <div class="card-head"><b>④ 最近几场</b></div>
      ${
        tlRows
          ? `<table class="tbl obs-tbl obs-tl"><thead><tr><th>场次（标题）</th><th>状态</th><th>切片</th><th>开始</th></tr></thead><tbody>${tlRows}</tbody></table>`
          : '<div class="empty">台账为空</div>'
      }
    </div>

    <div class="card">
      <div class="card-head"><b>⑤ 资源与 ASR 体检</b></div>
      <table class="tbl obs-tbl"><tbody>
        <tr><td>进程内存</td><td>RSS ${mem.rssMB ?? '—'} MB · 堆 ${mem.heapUsedMB ?? '—'}/${mem.heapTotalMB ?? '—'} MB</td></tr>
        <tr><td>磁盘</td><td>${mon.disk ? Math.round(Number(mon.disk.freeGB ?? 0)) + ' GB 可用（阈值 ' + Math.round(Number(mon.disk.thresholdGB ?? 0)) + ' GB）' : '—'}</td></tr>
        <tr><td>服务运行时长</td><td>${mem.uptimeSec ? obsDur(mem.uptimeSec) : '—'}</td></tr>
        <tr><td>监听目录</td><td class="mono-sm">${esc((obs.watchDirs || []).join('  ·  ') || '—')}</td></tr>
      </tbody></table>
      ${health ? `<div class="obs-sub">最近几次本地转写（精度 / 显存峰值）</div>${health}` : '<div class="empty" style="margin-top:8px">还没有本地转写体检记录</div>'}
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
