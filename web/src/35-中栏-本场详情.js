/* ============================================================================
 * 中栏：本场详情
 * ========================================================================== */
const STAGE_LABELS = ['录制', '转写', '分析', '切片', '发布'];

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const box = $('#detail');
  // 在详情页顶部给一句指路：任务操作还能从左侧列表的「⋯」或右键打开
  const opsTip = `<div style="font-size:11.5px;color:var(--text-3);margin:-6px 0 8px">
    提示：这些操作在左侧任务卡片的「⋯」按钮或右键菜单里同样可用
  </div>`;

  // 任务级操作栏：删除 / 停止 / 重跑 —— 这些以前只能改 json 才能做
  const publishedN = (d.clips || []).filter((c) => c.bvid).length;
  const ops = `<div class="barstrip" style="gap:8px">
    <span style="font-size:12.5px;color:var(--text-3)">任务操作</span>
    ${['PUBLISHED','ARCHIVED'].includes(d.status) ? '<span class="tag-mini">已完成</span>' : ''}
    ${['TRANSCRIBING','ANALYZING','CLIPPING','PUBLISHING','PENDING','RECORDED','TRANSCRIBED'].includes(d.status)
      ? '<button class="btn-sm" data-act="stop-task">停止处理</button>' : ''}
    <button class="btn-sm" data-act="retry-from">从某阶段重跑</button>
    ${publishedN ? '<button class="btn-sm" data-act="copy-links">复制全部稿件链接</button>' : ''}
    <button class="btn-sm" data-act="refresh-publish" title="立刻去 B站 反查一次这一场的投稿落地情况（不等后台每 5 分钟那一轮）；只读，不会重复投稿">刷新投稿状态</button>
    <button class="btn-sm" data-act="publish-audit">投稿体检</button>
    <button class="btn-sm" data-act="publish-batches" title="每次投稿本该产生哪几个分P、实际落地了哪几个">投稿批次</button>
    <button class="btn-sm" data-act="recap" title="这一场的产出复盘：切片/评分/投稿/表现/待办，一页看完">复盘报告</button>
    <button class="btn-sm" data-act="open-dir">打开产物目录</button>
    <button class="btn-sm" data-act="delete-task" style="color:#c33;border-color:#f0c8c8">删除任务…</button>
    <span style="margin-left:auto;font-size:11.5px;color:var(--text-3)" class="mono">${esc(d.id)}</span>
  </div>`;
  // 已投稿的场次额外提醒一句：本地删除不撤回稿件
  const publishNote = publishedN
    ? `<div style="font-size:11.5px;color:#c8811a;margin:-6px 0 8px">本场有 ${publishedN} 个切片已投稿到 B站 —— 删除本地记录<b>不会撤回投稿</b>，需下架请到 B站创作中心</div>`
    : '';

  let html = opsTip + ops + publishNote + `<div class="stages">${d.stages.map((s, i) => {
    const cls = s === 'done' ? 'done' : s === 'active' ? 'active' : s === 'fail' ? 'fail' : '';
    const prog = (d.progress && s === 'active') ? `<span class="prog">${esc(d.progress.label)} ${d.progress.total ? d.progress.current + '/' + d.progress.total : ''}</span>` : '';
    return `<div class="stage ${cls}"><span class="dot">${s === 'done' ? '✓' : s === 'fail' ? '!' : i + 1}</span>${STAGE_NAMES_SAFE(i)}${prog}</div>` + (i < 4 ? '<span class="arrow">›</span>' : '');
  }).join('')}</div>`;

  if (d.error) {
    html += `<div class="errbar"><div class="ico">!</div>
      <div class="txt"><b>${esc(d.error.stage)}失败</b> · ${esc(fmtTime(d.error.at))} · 已重试 ${d.error.retries} 次<br>${esc(d.error.message)}</div>
      <div class="acts">
        <button class="btn-retry" data-act="retry" data-stage="${esc(d.error.stage)}">从该阶段重跑</button>
        <button class="btn-detail" data-act="report" data-report="${esc(d.error.reportId)}">查看日志</button>
      </div></div>`;
  }

  // 成本（ASR 标注估算值）
  const cost = d.cost || {};
  html += `<div class="barstrip cost">本场成本 ≈ <b>¥${((cost.asrEstimate || 0) + (cost.llmActual || 0)).toFixed(2)}</b>
    <span>·</span>字幕识别 ¥${(cost.asrEstimate || 0).toFixed(2)} <span style="color:var(--text-3)">（估算值：按提交音频 ${toTime(cost.asrAudioSeconds || 0)} × 配置单价）</span>
    <span>·</span>内容分析 ¥${(cost.llmActual || 0).toFixed(4)} <span style="color:var(--text-3)">（实际 usage，${cost.llmCalls || 0} 次调用）</span>
    <span style="margin-left:auto;color:var(--text-3)">完整版上传：${esc(uploadStatusText(d.fullUpload))}${d.fullVideoBvid ? ' · ' + esc(d.fullVideoBvid) : ''}</span></div>`;

  if (d.degradedCount) {
    html += `<div class="barstrip warn"><b>本场含 ${d.degradedCount} 个降级产出片段</b>
      <span>·</span>LLM 分析失败时由弹幕密度选出，标题需人工填写后再发布</div>`;
  }
  if (d.transcript && d.transcript.gaps && d.transcript.gaps.length) {
    html += `<div class="barstrip warn"><b>转写有 ${d.transcript.gaps.length} 处缺失</b>
      <span>·</span>${d.transcript.gaps.slice(0, 4).map((g) => `${toTime(g.start)}–${toTime(g.end)}`).join('、')}${d.transcript.gaps.length > 4 ? ' 等' : ''}
      <span>·</span>总结时已注明该时间段转写缺失</div>`;
  }
  if (d.signals && d.signals.eventSignalsAvailable === false) {
    html += `<div class="barstrip info"><b>本场弹幕不含 SC / 上舰 / 礼物事件</b>
      <span>·</span>已降级为「普通弹幕密度 + 关键词」信号（陷阱 #25）</div>`;
  }

  // 在等 biliLive-tools 投出完整版稿件：默认规则下的正常中间态，必须在详情页说清"在等谁、等到什么时候"
  if (d.publishWait) {
    const until = d.publishWait.until ? fmtTime(Date.parse(d.publishWait.until)) : '';
    html += `<div class="barstrip warn"><b>⏳ 在等 biliLive-tools 投出本场的完整版稿件</b>
      <span>·</span>切片已切好但**暂不投稿** —— 规则是「完整版由 biliLive-tools 投，切片助手只把切片追加进同一个稿件」。
      <span>·</span>等待自 ${esc(String(d.publishWait.since || '').slice(5, 16))}${until ? `，最多等到 ${esc(until)}` : ''}（已重查 ${Number(d.publishWait.attempts || 0)} 次，每 5 分钟一次）
      <span>·</span>若这场本就该由切片助手投完整版，打开下面「本场设置 → 完整版由切片助手投」后重跑发布阶段。</div>`;
  }

  // 总结
  if (d.summary) {
    html += `<div class="card"><h2>本场总结 <span class="ai-tag">AI 生成</span></h2><div class="summary">${md(d.summary)}</div></div>`;
  }

  // 本场设置
  html += `<details class="scoped"><summary>本场设置（仅覆盖本场，不影响全局）</summary><div class="inner">
    <div class="field"><label>本场最多候选切片数</label><input class="inp num" id="ovMaxClips" value="${d.overrides && d.overrides.maxClips !== undefined ? d.overrides.maxClips : (state.bootstrap.config.clip.maxCandidates)}"></div>
    <div class="field"><label>本场不参与自动发布</label>
      <div class="inline-switch"><button class="switch sm ${d.overrides && d.overrides.skipAutoPublish ? 'on' : ''}" id="ovSkip"></button>
      <span style="font-size:12.5px;color:var(--text-3)">开启后仅产出候选，需手动发布</span></div></div>
    <div class="field full"><label>本场追加标签</label><input class="inp" id="ovTags" placeholder="例如：DLC开荒（逗号分隔，追加到全局标签之后）" value="${esc((d.overrides && d.overrides.extraTags || []).join(', '))}"></div>
    <div class="field"><label>完整版由切片助手投（例外）</label>
      <div class="inline-switch"><button class="switch sm ${d.overrides && d.overrides.fullVideoBy === 'assistant' ? 'on' : ''}" id="ovFullVideoBy"></button>
      <span style="font-size:12.5px;color:var(--text-3)">默认关闭：完整版（弹幕版+纯享版）由 biliLive-tools 投，本服务只追加切片分P。
        只有你**明确**需要本服务自己烧弹幕版 + remux 纯享版并新建 2+N 稿件时才打开这一场。</span></div></div>
    <div class="field full"><label>本场续传目标 aid（可选）</label>
      <input class="inp" id="ovResumeAid" value="${esc((d.overrides && d.overrides.resumeAid) || '')}" placeholder="例如 117321041512930（留空 = 按标题自动找）">
      <div class="hintline">什么时候必须填：biliLive-tools 投出的稿件标题不可信时 —— 实测它经<b>文件夹监控导入</b>进来的场次，
        稿件标题是「未知主播未知标题2026.09.23」，与标题模板永远匹配不上 → 本场会一直等到超时。
        去创作中心打开那个稿件，从地址里复制 <span class="mono-sm">aid=…</span> 填这里，切片就会追加进它。</div></div>
    <div class="field full"><button class="btn-sm" data-act="save-overrides">保存本场设置</button>
      <span class="hintline">保存后对「重跑分析」生效</span></div>
  </div></details>`;

  // 切片卡片
  if (d.clips && d.clips.length) {
    const checked = d.clips.filter((c) => c.selected).length;
    html += `<div class="clips-head"><h3>候选切片 ${d.clips.length} 个</h3>
      <span class="hint">勾选要发布的 · 标题与时间范围都可直接修改（修改自动保存）</span></div>`;
    html += d.clips.map(clipHTML).join('');
    /* ★ 批量按钮的判据必须与卡片上的「投稿这一片」、服务端 approve、publish.ts 的切片段一致：
       只算**还没投过**的（CANDIDATE/CUT/FAILED…）。旧写法用 `status !== 'PUBLISHED'`，
       把「已提交待确认」也算成可投 —— 点下去要靠 B站 分P 列表（约 20 分钟延迟）去重，
       延迟窗口内重跑就会在同一稿件里留下重复分P。用户 2026-10-07 的报障就出在这条路径上。 */
    const DONE = ['PUBLISHED', 'SUBMITTED', 'SUBMITTING', 'SKIPPED'];
    const publishable = d.clips.filter((c) => c.selected && !DONE.includes(c.status));
    const alreadyDone = d.clips.filter((c) => c.selected && ['PUBLISHED', 'SUBMITTED', 'SUBMITTING'].includes(c.status));
    html += `<div class="actionbar">
      <span class="info">已选 <b id="cntSelected">${checked}</b> / ${d.clips.length} 个切片　·　定时发布间隔 ${fmtSpan(state.bootstrap.config.publish.clipGapSec)}${
        alreadyDone.length ? `　·　<span style="color:var(--text-3)">其中 ${alreadyDone.length} 个已投过，不会重复投</span>` : ''
      }</span>
      <span id="publishHint" style="font-size:12px;color:var(--text-3)"></span>
      <button class="primary" id="publishBtn" ${publishable.length ? '' : 'disabled'} title="${
        publishable.length ? '把选中的、还没投过的切片投出去' : alreadyDone.length ? '选中的切片都已经投过了' : '先勾选要投稿的切片'
      }">投稿选中的 ${publishable.length} 个切片</button></div>`;
  } else {
    const msg = d.status === 'FAILED' ? '等待重跑后产出候选切片。'
      : ['TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING'].includes(d.status) ? '正在处理中，完成后会自动进入内容分析。'
      : ['ANALYZED'].includes(d.status) ? '分析完成但未产出候选切片。'
      : '该场次暂无切片。';
    html += `<div class="card"><h2>状态</h2><div class="summary"><p style="color:var(--text-3)">${esc(msg)}</p></div></div>`;
  }

  // 素材与文件
  html += `<div class="card"><h2>素材与产出</h2>
    <div class="kv">
      <div class="k">主播</div><div>${d.streamer
        ? `${esc(d.streamer)} <span style="color:var(--text-3)">（按录制目录名/弹幕/转写识别，总结与标题都按这个名字写）</span>`
        : '<span style="color:#c8811a">未识别</span> <span style="color:var(--text-3)">—— 提示词不会注入主播名，模型只依据转写内容</span>'}</div>
      <div class="k">源文件</div><div>${d.source.rawCount} 个分段 · ${fmtGB(d.source.rawTotalGB * 1024 ** 3)}${d.source.fullVideoExists ? ' · 压制产物已就绪' : ' · 无压制产物'}</div>
      <div class="k">弹幕</div><div>${d.source.danmaAss ? 'ASS ✓' : 'ASS ✗'} / ${d.source.danmaXml ? 'XML ✓' : 'XML ✗'} · 烧弹幕=${d.source.fullVideoHasDanmaku ? '源文件已含弹幕（不重复烧）' : '切片时烧入'}</div>
      <div class="k">素材保留</div><div>${esc(d.retention.fullVideoReason)}</div>
      <div class="k">封面</div><div>来源 ${esc(d.cover.source)}${d.cover.cover ? ' · ' + esc(String(d.cover.cover).split(/[\\/]/).pop()) : ''}</div>
      ${d.seasonId ? `<div class="k">合集</div><div>seasonId=${d.seasonId}</div>` : '<div class="k">合集</div><div style="color:#c8811a">未配置 —— 切片不会归入同一合集</div>'}
    </div>
    ${d.files && d.files.length ? `<div style="margin-top:12px"><div class="k" style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">任务目录文件（点击预览）</div>
      <div class="filelist">${d.files.map((f) => `<button data-act="preview" data-file="${esc(f)}">${esc(f)}</button>`).join('')}</div></div>` : ''}
  </div>`;

  if (d.transcriptPreview && d.transcriptPreview.length) {
    html += `<div class="card"><h2>转写预览（前 ${d.transcriptPreview.length} 条）</h2>
      <div class="timeline">${d.transcriptPreview.map((t) => `<div class="row"><span class="t">${esc(t.time)}</span><span class="s">${esc(t.text)}</span></div>`).join('')}</div></div>`;
  }

  box.innerHTML = html;
  bindDetail();
}

let STAGE_NAMES = STAGE_LABELS;
function STAGE_NAMES_SAFE(i) { return STAGE_LABELS[i] || ''; }

function clipHTML(c) {
  const pct = Math.round((c.score / 10) * 100);
  const over = c.title.length > 80;
  const dur = c.end - c.start;
  const durBad = dur < state.bootstrap.config.clip.minDurationSec || dur > state.bootstrap.config.clip.maxDurationSec;
  const failed = c.status === 'FAILED';
  /* 墓碑拦截：这一片**故意没投**（内容以前已经投过 B站，而那次的任务被删了）。
     不是失败、也不该被"重试"救回来 —— 重试只会再撞一次墓碑。所以既不显示"失败"，
     也不给"重新切片"，只说明原因 + 给一个显式的解除入口。
     ★ 判据用**服务端解析出来的** `c.tombstone`，而不是 `c.blockedByTombstone`：
       后者是切片上持久化的历史标记，解除墓碑之后它不会自己消失（要靠服务端清理）。
       若用标记判断，解除完界面还会挂着墓碑说明，看起来像"解除没生效"。 */
  const tomb = c.tombstone || null;
  /* ★ 2026-10-07 用户报「勾了想投稿，但没有投稿的选项」：他勾的正是**单片**，
     于是去找"这一片怎么投"。所以每张卡片直接给一个「投稿这一片」——
     判据与批量按钮、服务端、publish.ts 的切片段完全一致：勾了、没被墓碑拦、且**还没投过**。
     「已提交待确认（SUBMITTED）」也算投过（B站 分P 列表有约 20 分钟延迟，不能靠它去重，
     否则延迟窗口内重投会在同一稿件里留下重复分P）。 */
  const DONE_STATUSES = ['PUBLISHED', 'SUBMITTED', 'SUBMITTING', 'SKIPPED'];
  const canPublishThis = !!c.selected && !tomb && !DONE_STATUSES.includes(c.status);
  /* 「已提交待确认」且**确认窗口过了很久**（反查会给它写 `unconfirmedAlertAt`，并推送告警）：
     B站 稿件里极可能真的没有这一条 ⇒ 给一个显式的「重新投稿这一片」。
     默认的批量投稿**不会**碰它（避免重复分P），必须由人点、且二次确认。 */
  const republishThis = !tomb && c.status === 'SUBMITTED' && !!c.unconfirmedAlertAt;
  const statusPill = tomb ? `<span class="pill tomb">🪦 墓碑拦截</span>`
    : c.status === 'PUBLISHED' ? `<span class="pill">已发布${c.bvid ? ' ' + esc(c.bvid) : ''}</span>`
    : failed ? `<span class="pill fail">失败</span>`
    : c.status === 'SUBMITTED' ? `<span class="pill wait">已提交待确认</span>`
    : c.status === 'CUT' || c.status === 'CUTTING' ? `<span class="pill wait">已切片</span>` : '';
  return `<article class="clip ${c.selected ? '' : 'off'} ${c.degraded ? 'degraded' : ''} ${failed ? 'failed' : ''} ${tomb ? 'tomb' : ''}" data-clip="${c.index}">
    <div class="clip-head">
      <input type="checkbox" ${c.selected ? 'checked' : ''} data-act="select">
      <input class="tinput" data-k="start" value="${toTime(c.start)}">
      <span class="dash">–</span>
      <input class="tinput" data-k="end" value="${toTime(c.end)}">
      <span class="dur ${durBad ? 'bad' : ''}" data-role="dur">${dur.toFixed(0)} 秒</span>
      <span class="changed-tag" data-role="changed" style="display:${c.edited ? 'inline-block' : 'none'}">已改</span>
      <span class="score ${c.score < 7 ? 'low' : ''}"><span class="bar"><i style="width:${pct}%"></i></span>${Number(c.score).toFixed(1)}</span>
    </div>
    ${c.degraded ? '<div class="degraded-note">⚠ 降级产出：由弹幕密度选出，标题需人工填写后再发布</div>' : ''}
    ${tomb ? `<div class="tomb-note">
      <b>🪦 墓碑拦截 —— 这一片没有投稿（不是失败）</b>
      <div>这段内容<b>以前已经投过 B站</b>，而当时那个任务/切片已被删除。删除会清掉本地的幂等指纹，
      于是「重新导入同一份素材 → 重新分析出同一区间」就会再投一次、在 B站 上多出一个内容相同的稿件
      （B站 没有删除稿件的开放接口）。墓碑就是拦这件事的。</div>
      <div class="tomb-meta">
        ${tomb.bvid ? `旧稿件：<a href="https://www.bilibili.com/video/${esc(tomb.bvid)}" target="_blank" rel="noreferrer">${esc(tomb.bvid)}</a>` : '旧稿件：未反查到 bvid（当时只走到「已提交」）'}
        ${tomb.taskId ? ` · 原任务 <code>${esc(tomb.taskId)}</code>` : ''}
        ${tomb.retiredAt ? ` · 立碑于 ${esc(String(tomb.retiredAt).slice(0, 19).replace('T', ' '))}` : ''}
        ${tomb.title ? ` · 原标题「${esc(tomb.title)}」` : ''}
      </div>
      <div>确认 B站 上那个稿件<b>确实已经不存在</b>之后，再点下面的按钮解除；解除后重跑本场即可正常投稿。</div>
      <button class="linkbtn danger" data-act="release-tomb">确认旧稿件已删除，解除墓碑并允许重投</button>
    </div>` : ''}
    <div class="title-row">
      <input class="clip-title" data-act="title" value="${esc(c.title)}">
      <span class="cnt ${over ? 'over' : ''}" data-role="cnt">${c.title.length}/80</span>
    </div>
    ${over ? '<div class="hintline warn" style="margin:-4px 0 8px">超出 B站标题上限 80 字符，保存时会自动截断</div>' : ''}
    <div class="tags">${(c.tags || []).map((x) => `<span>${esc(x)}</span>`).join('')}<span style="background:#f0f6ff;color:#2b7cd3">${esc(c.category)}</span></div>
    <p class="why">${inline(c.reason || '')}</p>
    ${failed && c.failReason ? `<div class="hintline warn" style="margin-bottom:8px">失败原因：${esc(c.failReason)}</div>` : ''}
    <div class="clip-foot">
      <button class="linkbtn" data-act="preview-cut">试看</button>
      <button class="linkbtn" data-act="open-llc">在 biliLive-tools 中编辑</button>
      ${canPublishThis ? '<button class="linkbtn" data-act="publish-this" style="color:var(--pink);font-weight:600">投稿这一片</button>' : ''}
      ${republishThis ? '<button class="linkbtn" data-act="republish-this" style="color:#c8811a">重新投稿这一片</button>' : ''}
      ${c.dtime ? `<span style="color:var(--text-3)">排期 ${esc(fmtTime(c.dtime * 1000))}</span>` : ''}
      ${statusPill}
      ${c.bvid ? `<a href="https://www.bilibili.com/video/${esc(c.bvid)}" target="_blank" rel="noreferrer" style="font-size:12px">查看稿件</a>` : ''}
      ${!tomb && (c.status === 'FAILED' || c.status === 'CUT') ? '<button class="linkbtn" data-act="recut" style="color:#c8811a">重新切片</button>' : ''}
    </div>
  </article>`;
}

function uploadStatusText(s) {
  return { NOT_APPLICABLE: '由 biliLive-tools 自动上传（不跟踪）', WAITING: '等待压制产物', UPLOADING: '上传中（未确认）', CONFIRMED: '已确认', FAILED: '失败' }[s] || s;
}

/** 把秒数格式化成好看的时间跨度（避免出现 2.0833333333333335h 这种浮点噪声） */
function fmtSpan(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = s / 3600, m = s / 60;
  if (s % 3600 === 0) return `${h} 小时`;
  if (s % 60 === 0 && s < 3600) return `${m} 分钟`;
  if (s >= 3600) return `${h.toFixed(1)} 小时`;
  return m < 1 ? `${s} 秒` : `${m.toFixed(0)} 分钟`;
}

/** 从 ISO 时间或毫秒时间戳得到 YYYY-MM-DD HH:mm */
function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 人类可读字节数（与 src/util.ts 的 fmtBytes 保持一致）。
 *
 * ★ 这个函数曾经**只被调用、从未被定义** —— 「查看待删清单」与「回收站」两个弹窗
 *   一打开就抛 `ReferenceError: fmtBytes is not defined`，界面上只看到一句
 *   「读取待删清单失败：fmtBytes is not defined」，功能等于完全不可用。
 *   是 `npm run ui-e2e` 的第 12 段（真点按钮）把它抓出来的：纯 DOM 断言看不出来，
 *   因为弹窗的 HTML 根本没被渲染。
 *   为什么服务端测试也抓不到：那几个用例都直接调 HTTP 接口，不经过页面。
 */
function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

