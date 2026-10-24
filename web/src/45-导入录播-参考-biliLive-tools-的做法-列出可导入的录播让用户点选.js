/* ---------------------------------------------------------------------------
 * 导入录播（参考 biliLive-tools 的做法：列出可导入的录播让用户点选）
 *
 * 为什么不再让人粘贴路径：实测那条路上有三个坑 ——
 *   1. 用户得自己去资源管理器复制绝对路径，还容易复制错；
 *   2. 同一个直播间一次录制会产生 3–5 个文件（原始 flv / `-弹幕版.mp4` / `_PART000.flv`），
 *      根本分不清该选哪个，**错选 `-弹幕版` 就会烧出双层弹幕**；
 *   3. 弹幕文件要自己找（文件名对不上就找不到），导错了要到流水线跑失败才发现。
 * 所以改成：清单（biliLive-tools 录制历史 ∪ 扫盘）→ 点选 → 预览（配对的弹幕、时长、
 * 预估 ASR 费用、是否已导入、是否仍在录制）→ 确认导入。手动填路径作为兜底保留。
 * ------------------------------------------------------------------------- */
$('#btnImport').onclick = () => {
  openInfo('导入录播文件', `
    <div class="barstrip" style="gap:8px">
      <span style="font-size:var(--fs-s);color:var(--text-3)">可导入的录播</span>
      <button class="btn-sm" id="impRefresh">刷新清单</button>
      <span id="impScanInfo" class="hintline" style="margin-left:auto"></span>
    </div>

    <details id="impDirsBox" style="margin:8px 0 12px">
      <summary style="cursor:pointer;font-size:var(--fs-s);color:var(--text-2)">扫描目录（录播没显示出来？在这里加）</summary>
      <div id="impDirs" style="margin-top:8px"></div>
      <div class="ctl" style="margin-top:8px">
        <input class="inp" id="impDirAdd" placeholder="例如 D:\\录播  或  ~/Videos/bili（支持 ~）">
        <button class="btn-sm" id="impDirAddBtn">添加</button>
      </div>
      <p class="hintline">biliLive-tools 自己的保存目录会自动包含（不用手填）；上面列出的「手动」目录才是额外要扫的。</p>
    </details>

    <div id="impList" class="timeline" style="max-height:320px;overflow:auto">
      <div class="row"><span class="s" style="color:var(--text-3)">正在扫描录播目录…</span></div>
    </div>

    <h3 style="margin:14px 0 6px">导入参数</h3>
    <div class="fields" style="grid-template-columns:1fr">
      <div class="field"><label>视频文件绝对路径（必填）</label><input class="inp" id="impVideo" placeholder="从上面的清单点选，或直接粘贴路径"></div>
      <div class="field"><label>弹幕文件绝对路径（可选，XML 用于信号分析 / ASS 用于烧录）</label><input class="inp" id="impDanma"></div>
      <div class="field"><label>标题（可选）</label><input class="inp" id="impTitle" placeholder="留空则用文件名"></div>
      <div class="field"><label>房间号（可选）</label><input class="inp" id="impRoom" value="${esc(BOOT.roomId)}"></div>
    </div>
    <div id="impPreview"></div>
    <p class="hintline">用途：补跑漏掉的场次、测试新 prompt、处理其他渠道获得的录播。会跑完整链路（受当前 dry-run / 付费开关约束）。</p>
    <div style="margin-top:12px"><button class="primary" style="margin-left:0" id="impGo">创建任务并开始处理</button></div>`);

  /**
   * 渲染扫描范围：哪些目录是自动来的（biliLive-tools 的保存目录）、
   * 哪些是用户手动加的（可移除），以及这次实际扫了哪些、历史查了哪些房间。
   *
   * 为什么要显示这些：用户反馈过「路径太绝对，我还有别的主播的录播没显示」——
   * 只有把「扫了哪里」摊开，用户才知道该往哪里加目录。
   */
  const renderDirs = (info) => {
    const box = $('#impDirs');
    if (!box) return;
    const rows = [];
    for (const d of info.detectedDirs || []) {
      rows.push(`<div class="row"><span class="t" style="color:var(--text-3)">自动</span><span class="s">
        <span class="mono-sm" style="word-break:break-all">${esc(d)}</span>
        <br><span style="color:var(--text-3);font-size:var(--fs-meta)">来自 biliLive-tools 的保存目录</span></span></div>`);
    }
    for (const d of info.configuredDirs || []) {
      rows.push(`<div class="row"><span class="t" style="color:var(--text-3)">手动</span><span class="s">
        <span class="mono-sm" style="word-break:break-all">${esc(d)}</span>
        <button class="btn-sm" data-rmdir="${esc(d)}" style="margin-left:8px">移除</button></span></div>`);
    }
    if (!rows.length) rows.push('<div class="row"><span class="s" style="color:var(--text-3)">（还没有额外目录）</span></div>');
    const scanned = (info.scanRoots || []).length
      ? `<p class="hintline">本次实际扫描：${(info.scanRoots || []).map((r) => `<span class="mono-sm">${esc(r)}</span>`).join('　')}</p>`
      : '';
    const hist = info.historyTotal
      ? `<p class="hintline">录制历史：查了 ${info.roomIds.length} 个房间（${(info.roomIds || []).join('、')}）共 ${info.historyTotal} 条${info.historyMissing ? `，其中 <span style="color:#c8811a">${info.historyMissing} 条的文件已不在磁盘</span>` : ''}</p>`
      : '';
    box.innerHTML = `<div class="timeline">${rows.join('')}</div>${scanned}${hist}`;
    $$('#impDirs [data-rmdir]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        await api('/api/recordings/dirs', { method: 'POST', body: { remove: b.dataset.rmdir } });
        toast('已移除扫描目录：' + b.dataset.rmdir);
        loadList(true);
      } catch (e) { toast('移除失败：' + e.message, 5000); b.disabled = false; }
    }));
  };

  /* 清单的两级结构：先按「正在录制 / 已录制完成 / 已导入过」分桶，再渲染。
     分桶与渲染分开，是为了让折叠只重画 DOM，不必重新请求 /api/recordings。 */
  let lastList = null;
  let lastBuckets = null;

  const rowHtml = (i) => {
    const c = lastList.candidates[i];
    const flags = [];
    /* 在「自动导入目录」里的文件要标出来：两条路（轮询自动捡 / 你手动点）会分别记成
       「自动导入」和「手动导入」，用户需要事先知道这件事，而不是事后奇怪为什么标手动 */
    const w = state.watch;
    if (w && w.enabled && (w.dirs || []).some((d) => c.videoPath.toLowerCase().startsWith(String(d).toLowerCase()))) {
      flags.push('<span style="color:var(--blue,#00aeec)">在自动导入目录</span>');
    }
    if (c.possiblyRecording) flags.push('<span style="color:#c8811a">可能仍在录制</span>');
    /* 碎片合并：同一场直播被 CDN 每隔几分钟断一次、落成好几个文件。
       两个状态都要标出来，否则用户看到"3.3 分钟的一场"会以为录短了：
         · 还在等 → 说明还剩多久（等安静后整场一起导入，不再一场拆成好几个任务）
         · 已合并 → 说明由几段拼成（导入后就是整场） */
    if (c.stitch && (c.stitch.fragmentCount || 1) > 1) {
      if (c.stitchWaiting) {
        const left = Math.max(0, Math.round((c.stitch.quietSec || 0) - (c.stitch.newestAgeSec || 0)));
        flags.push(`<span style="color:#c8811a">已拼 ${c.stitch.fragmentCount} 段碎片，等安静 ${left} 秒</span>`);
      } else {
        flags.push(`<span style="color:var(--blue,#00aeec)">已合并 ${c.stitch.fragmentCount} 段碎片（整场）</span>`);
      }
    }
    /* 合并不全：已经导过其中几段。剩下的仍会被导入（已导过的不会重复转写），
       所以要如实说明，否则用户看到"没标已导入"会以为是全新的。 */
    if (c.importedParts && c.importedParts.covered < c.importedParts.total) {
      flags.push(`<span style="color:#c8811a">已导过 ${c.importedParts.covered}/${c.importedParts.total} 段</span>`);
    }
    if (c.importedBy) flags.push('<span style="color:#c8811a">已导入</span>');
    if (c.hasDanmakuInPicture) flags.push('<span style="color:#c8811a">画面已烧弹幕</span>');
    if (!c.usable) flags.push('<span style="color:#c33">文件不可用</span>');
    if (c.asr && c.asr.cacheHits >= c.asr.windows && c.asr.windows > 0) flags.push('<span style="color:var(--green)">ASR 已缓存</span>');
    return `<div class="row" data-imp="${i}" style="cursor:pointer">
      <span class="t">${esc(c.group)}</span>
      <span class="s"><b>${esc(c.title)}</b> ${flags.join(' ')}<br>
        <span style="color:var(--text-3)">${esc(c.summary)}${c.asr ? ` · 预估 ASR ¥${c.asr.estCost.toFixed(2)}（${c.asr.cacheHits}/${c.asr.windows} 段已缓存）` : ''}</span><br>
        <span class="mono-sm" style="color:var(--text-3);word-break:break-all">${esc(c.videoPath)}</span></span>
    </div>`;
  };

  /** 可折叠分组的表头（点一下展开/收起）。展开状态记在 state.impOpen 上 —— 点「刷新清单」
      或缓存过期重扫时，不会把用户刚展开的那组又收回去。 */
  const groupHtml = (key, label) => {
    const open = !!state.impOpen[key];
    const rows = open ? lastBuckets[key].map(rowHtml).join('') : '';
    return `<div class="impgroup${open ? ' open' : ''}" data-g="${key}" title="${open ? '收起' : '展开'}这 ${lastBuckets[key].length} 场">
      <span class="caret">▸</span><span>${label}</span><span class="cnt">${lastBuckets[key].length} 场</span>
    </div>${rows}`;
  };

  const bindList = () => {
    /* 点分组表头 → 只重画清单（不重新扫描） */
    $$('#impList .impgroup[data-g]').forEach((el) => (el.onclick = () => {
      state.impOpen[el.dataset.g] = !state.impOpen[el.dataset.g];
      renderList();
    }));
    // 点一行 → 填进表单并预览
    $$('#impList .row[data-imp]').forEach((el) => (el.onclick = () => {
      const c = lastList.candidates[Number(el.dataset.imp)];
      if (!c) return;
      $$('#impList .row[data-imp]').forEach((x) => (x.style.background = ''));
      el.style.background = 'var(--bg-2,#f5f7fa)';
      $('#impVideo').value = c.videoPath;
      $('#impDanma').value = c.danmaPath || '';
      $('#impTitle').value = c.title || '';
      showPreview(c.videoPath);
    }));
  };

  const renderList = () => {
    const box = $('#impList');
    const b = lastBuckets;
    const parts = [];
    if (b.live.length) {
      /* 「正在录制」永远展开、不可折叠 —— 这正是用户打开这个对话框要看的东西 */
      parts.push(`<div class="impgroup live"><span>● 正在录制</span><span class="cnt">${b.live.length} 场</span></div>`);
      parts.push(b.live.map(rowHtml).join(''));
    } else {
      /* 没有在录的场次时给一句明确的话，否则用户只看到两个收起的表头会以为清单坏了 */
      parts.push('<div class="impgroup none"><span>● 当前没有正在录制的场次</span></div>');
    }
    if (b.idle.length) parts.push(groupHtml('idle', '已录制完成 · 未导入'));
    if (b.imported.length) parts.push(groupHtml('imported', '已导入过'));
    box.innerHTML = parts.join('');
    bindList();
  };

  /** 载入清单；refresh=1 时绕过服务端 20 秒缓存 */
  const loadList = async (refresh) => {
    const box = $('#impList');
    box.innerHTML = '<div class="row"><span class="s" style="color:var(--text-3)">正在扫描录播目录…</span></div>';
    try {
      const r = await api('/api/recordings' + (refresh ? '?refresh=1' : ''));
      renderDirs(r);
      $('#impScanInfo').textContent = `共 ${r.count} 场${r.cached ? '（缓存）' : ''}`;
      if (!r.candidates.length) {
        box.innerHTML = '<div class="row"><span class="s" style="color:var(--text-3)">没有找到可导入的录播。可在「设置」里加扫描目录，或直接在下面粘贴绝对路径。</span></div>';
        return;
      }
      /* 分桶：正在录制 / 已录制完成未导入 / 已导入过。
         判定顺序很重要 —— "已导入过但这会儿还在录"的文件要归到「正在录制」，
         因为它属于"当前正在发生、需要你注意"的那一类。 */
      const buckets = { live: [], idle: [], imported: [] };
      r.candidates?.forEach((c, i) => {
        if (c.possiblyRecording) buckets.live.push(i);
        else if (c.importedBy) buckets.imported.push(i);
        else buckets.idle.push(i);
      });
      /* 展开状态：**「已录制完成 · 未导入」默认展开** —— 这个对话框就是用来挑一场录播导入的，
         默认收起会让用户打开后只看到两行表头（实测真浏览器端到端用例抓到「清单 0 行」）。
         「已导入过」默认收起：那是历史，点开才看。正在录制的那组永远展开、不可折叠。 */
      state.impOpen ??= { idle: true, imported: false };
      lastList = r;
      lastBuckets = buckets;
      renderList();
    } catch (e) {
      box.innerHTML = `<div class="row bad"><span class="s">扫描失败：${esc(e.message)}</span></div>`;
    }
  };

  /** 选中后做一次完整预览：配对弹幕、时长、费用、已导入、是否仍在录制 */
  const showPreview = async (videoPath) => {
    const box = $('#impPreview');
    box.innerHTML = '<p class="hintline">正在检查这个文件…</p>';
    try {
      const p = await api('/api/import/preview', { method: 'POST', body: { videoPath } });
      // 预览里更权威的弹幕对应关系（biliLive-tools 自己的映射）覆盖掉清单里的猜测
      if (p.danmaPath && !$('#impDanma').value.trim()) $('#impDanma').value = p.danmaPath;
      const rows = [
        ['时长', p.durationSec > 0 ? toTime(p.durationSec) : '未知'],
        ['大小', p.sizeMB + ' MB'],
        ['分辨率', p.resolution || '-'],
        ['分段', p.segmentCount > 1 ? `${p.segmentCount} 个（将合并为一场）` : '1 个'],
        ['弹幕', p.danmaPath ? `${p.danmaPath.split(/[\\/]/).pop()}（来源：${{ 'bililive-tools': 'biliLive-tools 对应关系', sibling: '同名文件', none: '未找到' }[p.danmaSource]}）` : '未找到'],
        ['画面弹幕', p.hasDanmakuInPicture ? '已烧进画面（切片时不再叠 ASS）' : '未烧，切片时烧入'],
        ['ASR', p.asr ? `${p.asr.windows} 段，缓存命中 ${p.asr.cacheHits}，预估 ¥${p.asr.estCost.toFixed(2)}` : '-'],
      ];
      box.innerHTML = `<div class="kv">${rows.map(([k, v]) => `<div class="k">${k}</div><div>${esc(String(v))}</div>`).join('')}</div>` +
        (p.variants.length > 1
          ? `<div style="margin-top:10px"><div class="k" style="font-size:var(--fs-meta);color:var(--text-3);margin-bottom:6px">这一场的其它版本（点一下换用它）</div>
             <div class="filelist">${p.variants.map((v, i) => `<button data-variant="${i}" ${v.videoPath === p.videoPath ? 'style="border-color:var(--blue,#00aeec)"' : ''}>${esc(v.fileName)}（${v.sizeMB} MB${v.hasDanmakuInPicture ? ' · 已烧弹幕' : ''}）</button>`).join('')}</div></div>`
          : '') +
        (p.importedBy ? `<div class="barstrip warn">这个文件已属于任务 <span class="mono-sm">${esc(p.importedBy.taskId)}</span>（${esc(p.importedBy.status)}）—— 再次导入会新建一场并重新花 ASR 费用</div>` : '') +
        (() => {
          const w = state.watch;
          const inWatch = !!w && w.enabled && (w.dirs || []).some((d) => String(p.videoPath).toLowerCase().startsWith(String(d).toLowerCase()));
          return inWatch
            ? `<div class="barstrip">这个文件在**自动导入目录**里：不点导入的话，轮询也会处理它，但要先等它写完（体积连续两轮不变且稳定 ${w.stableSec} 秒，通常 1–2 分钟）。` +
              `两条路的记账不同 —— 你点的是<b>手动导入</b>，轮询捡起来的记<b>自动导入</b>。</div>`
            : '';
        })() +
        (p.warnings.length ? `<div class="timeline">${p.warnings.slice(0, 5).map((w) => `<div class="row"><span class="t">注意</span><span class="s">${esc(w)}</span></div>`).join('')}</div>` : '');
      // 换用同一场的另一个版本（原始 flv ↔ 已烧弹幕的压制产物）
      $$('#impPreview [data-variant]').forEach((btn) => (btn.onclick = () => {
        const v = p.variants[Number(btn.dataset.variant)];
        if (!v) return;
        $('#impVideo').value = v.videoPath;
        showPreview(v.videoPath);
      }));
    } catch (e) {
      box.innerHTML = `<div class="row bad"><span class="s">预览失败：${esc(e.message)}</span></div>`;
    }
  };

  $('#impRefresh').onclick = () => loadList(true);
  // 添加扫描目录（这是「别的主播的录播没显示」的直接解法）
  { const ab = $('#impDirAddBtn'); if (ab) ab.onclick = async () => {
    const d = $('#impDirAdd').value.trim();
    if (!d) { toast('请填写目录路径'); return; }
    ab.disabled = true;
    try {
      const r = await api('/api/recordings/dirs', { method: 'POST', body: { add: d } });
      $('#impDirAdd').value = '';
      toast(r.note || '已添加');
      loadList(true);
    } catch (e) { toast('添加失败：' + e.message, 6000); }
    ab.disabled = false;
  }; }
  { const inp = $('#impDirAdd'); if (inp) inp.onkeydown = (ev) => { if (ev.key === 'Enter') $('#impDirAddBtn').click(); }; }
  $('#impVideo').onchange = () => { const v = $('#impVideo').value.trim(); if (v) showPreview(v); };
  loadList(false);

  $('#impGo').onclick = async () => {
    const videoPath = $('#impVideo').value.trim();
    if (!videoPath) { toast('请从上面的清单点选一个录播，或粘贴视频文件路径'); return; }
    $('#impGo').disabled = true; $('#impGo').textContent = '创建中…';
    try {
      const r = await api('/api/import', { method: 'POST', body: {
        videoPath,
        danmaPath: $('#impDanma').value.trim() || undefined,
        title: $('#impTitle').value.trim() || undefined,
        roomId: $('#impRoom').value.trim() || undefined,
        // 文件名带「-弹幕版」→ 源文件画面里已有弹幕，切片时不能再叠一层（陷阱 #8）
        hasDanmakuInPicture: /-弹幕版|-danmaku|（弹幕版）/.test(videoPath.replace(/\.[^.]+$/, '')),
      } });
      closeInfo();
      /* 手动导入的文件如果就躺在「自动导入目录」里，用户会以为"它应该自己跑" ——
         实测就为此困惑过（看到任务卡标着「手动导入」以为标错了）。
         这里把两条路的区别一次说清：谁点的就记谁，轮询那条路要等文件写完。 */
      const w = state.watch;
      const inWatch = !!w && w.enabled && (w.dirs || []).some((d) => videoPath.toLowerCase().startsWith(String(d).toLowerCase()));
      toast(
        `已创建任务 ${r.taskId}，处理已开始` +
          (inWatch ? '（这个文件在自动导入目录里，轮询也会捡它 —— 本次按你手动导入记账，所以标「手动导入」）' : ''),
        inWatch ? 8000 : 4000,
      );
      state.activeId = r.taskId;
      setTimeout(() => refreshAll(true), 1200);
    } catch (e) { toast('导入失败：' + e.message, 5000); $('#impGo').disabled = false; $('#impGo').textContent = '创建任务并开始处理'; }
  };
};
$('#modeSwitch').onclick = async () => {
  const on = !$('#modeSwitch').classList.contains('on');
  /* ★ 2026-10-16（UI 评审 3.1）：这是全站唯一"点一下就会自动对外发文、且不再问你"的开关，
     所以确认文案把后果说全（会发文 / 不再询问 / 怎么退回），而不是只说"确定开启？"。 */
  if (on && !confirm(
    '开启「全自动 · 免确认发布」后：\n\n' +
    '· 分析完成后直接按评分阈值选片、切片、排期发布\n' +
    '· 全程不再询问你，稿件会直接投到 B 站\n' +
    '· 顶栏这个开关会变成琥珀色，用来提醒你它正开着\n\n' +
    '随时可以点回来切回半自动。确定开启？',
  )) return;
  try {
    await api('/api/config', { method: 'POST', body: { patch: { publish: { autoPublish: on } } } });
    renderModeSwitch(on);
    toast(on ? '已切换为全自动：分析完成后直接排期发布' : '已切换为半自动：需你确认后才发布');
    await loadBootstrap();
  } catch (e) { toast('切换失败：' + e.message); }
};
/* 顶栏字幕开关：切 clip.burnSubtitles。
   云端 ASR 下开启会先弹确认 —— 这不是"多问一句"，而是因为那个组合必然错位（有实测数据），
   而且用户当初就是因为它错位才整体关掉字幕的，不该让人一键踩回同一个坑。 */
$('#subSwitch').onclick = async () => {
  const cfg = (state.bootstrap && state.bootstrap.config) || {};
  const next = !(cfg.clip && cfg.clip.burnSubtitles);
  const provider = String((cfg.asr && cfg.asr.provider) || '未知');
  const local = provider === 'local-funasr' || provider === 'whisper-cpp';
  if (next && !local) {
    if (!confirm(
      `现在转写走的是云端 ASR（asr.provider=${provider}）。\n\n` +
      '它的句级时间窗不可靠 —— 实测「15 个字的句子占了 0→30.9 秒」，烧出来的字幕会与声音整体错位。' +
      '这正是之前把字幕整体关掉的原因。\n\n' +
      '建议先把「设置 → 转写引擎」换成本地 Fun-ASR（字级时间戳，实测偏差 ±0.2 秒）再开字幕。\n\n仍要现在开启？',
    )) return;
  }
  try {
    await api('/api/config', { method: 'POST', body: { patch: { clip: { burnSubtitles: next } } } });
    toast(
      next
        ? '已开启字幕烧录：只对之后新切的片子生效（已切好的不会重切）'
        : '已关闭字幕烧录：之后新切的片子画面只留弹幕',
      5000,
    );
    await loadBootstrap();
  } catch (e) { toast('切换字幕失败：' + e.message); }
};
$('#infoCopy').onclick = async () => {
  const text = state.lastCopy || $('#infoBody').innerText;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    // 剪贴板 API 在非安全上下文不可用时的兜底
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch { toast('复制失败，请手动选择文本'); }
    ta.remove();
  }
};
/* 包装一层：直接把 saveCfg 挂到 onclick 会把**事件对象**当 force 传进去，
   于是「强制覆盖」会在毫不知情的情况下生效，乐观锁等于白做。 */
$('#btnSaveCfg').onclick = () => saveCfg();
$$('#tabs .tab').forEach((t) => t.onclick = () => switchView(t.dataset.view));
let searchTimer;
$('#searchInput').oninput = (e) => {
  state.q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadTasks().catch(() => {}), 300);
};
$$('#statusFilters button').forEach((b) => b.onclick = () => {
  $$('#statusFilters button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  state.status = b.dataset.status;
  loadTasks().catch((e) => toast(e.message));
});
/* 多选开关：切到多选后卡片上出现勾选框，点卡片=勾选（不再切换任务） */
$('#btnMulti').onclick = () => {
  state.multi.on = !state.multi.on;
  if (!state.multi.on) state.multi.sel.clear();
  updateMultiButton();
  renderTaskList();
};
$('#cfgMask').onclick = (e) => { if (e.target.id === 'cfgMask') closeCfg(); };
$('#infoMask').onclick = (e) => { if (e.target.id === 'infoMask') closeInfo(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeCfg(); closeInfo(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && $('#cfgMask').classList.contains('show')) { e.preventDefault(); saveCfg(); }
});
window.addEventListener('beforeunload', (e) => {
  if (state.dirty.size) { e.preventDefault(); e.returnValue = ''; }
});

