/* ============================================================================
 * 设置弹窗
 * ========================================================================== */
const LLM_PRESETS = {
  deepseek: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', note: '支持错峰半价（直播多在深夜结束）与 prompt 缓存折扣（分块共享同一段 system 指令），本场景单场成本可低至几分钱。⚠️ 缓存命中前提是各请求的 system 字节级一致 —— 本服务已把分块内容全部放在 user 消息里。' },
  aliyun: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', note: '与字幕识别同平台，只需管理一个 Key；中文细粒度理解好，配置最省事。' },
  zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', note: '永久免费、无 Token 上限。适合先跑通链路；选片环节建议另配一个更强的模型（否则「契约校验失败升级重跑」会退化成同模型重试）。' },
  ollama: { url: 'http://127.0.0.1:11434/v1', model: 'qwen3:14b', note: '完全本地运行、数据不出机器。⚠️ Ollama 默认上下文仅 2048 token，必须在 Modelfile 里设 num_ctx，否则长文本会被静默截断。' },
  custom: { url: '', model: '', note: '自行填写任意 OpenAI 兼容端点。' },
};

/** 「常用」快跳字段（打开设置先看到这些，不用在 81 个输入里翻） */
const CFG_PINNED = [
  ['c_baseUrl', 'biliLive-tools 地址'],
  ['c_roomId', '直播间'],
  ['c_autoPublish', '自动发布'],
  ['c_multiPart', '多分P'],
  ['c_immediatePublish', '立即发布'],
  ['c_trashDays', '回收站保留天数'],
  ['c_dailyLimit', '每日投稿上限'],
  ['c_isOnlySelf', '仅自己可见'],
];
/** 危险字段：改错了代价大（0 有特殊语义 / 会删源），必须在界面上标出来 */
const CFG_DANGER = new Set(['c_trashDays', 'c_deleteRaw', 'c_keepOnFail']);

/**
 * 设置面板瘦身（2026-10-11 优化第一批 A1）。
 *
 * 问题：**81 个输入平铺一页**，找一个开关要滚很久；危险项（`trashDays=0` 会直接不用回收站、
 * 删源开关）和常用项混在一起，看不出轻重。
 *
 * 做法是**纯增强层**：不改任何字段的 id / name / 保存口径（`saveCfg` 仍按 id 读值），
 * 只是把已有的 `.group` 包成可折叠的 `<details>`、加搜索框、把常用字段做成快跳、给危险字段打标。
 * 这样零风险：就算这层不生效，设置面板照旧能用（只是又变回平铺）。
 */
function enhanceCfgPanel() {
  const body = $('#cfgBody');
  if (!body) return;
  /* ⚠️ 幂等判断必须看**本次渲染的结果**，不能看 #cfgBody 自己身上的标记：
     每次打开设置都会重写 #cfgBody.innerHTML（子节点全新），而 dataset 挂在容器自身、会留下来 ——
     实测症状就是"只有第一次打开是瘦身的，第二次又变回 81 个输入平铺"。
     改成"已经存在搜索框就说明这一轮增强过了"，天然自愈。 */
  if (body.querySelector('#cfgSearch')) return;
  const groups = [...body.querySelectorAll('.group')];
  /* ① 分组折叠：默认收起 —— 打开设置先看到"目录"，而不是 81 个输入 */
  for (const g of groups) {
    const h3 = g.querySelector('h3');
    const title = h3 ? String(h3.textContent).trim() : '设置';
    const box = document.createElement('details');
    box.className = 'cfggroup';
    const sum = document.createElement('summary');
    sum.style.cssText = 'cursor:pointer;font-size:14px;font-weight:600;padding:6px 0';
    sum.textContent = title;
    box.appendChild(sum);
    const inner = document.createElement('div');
    inner.className = 'inner';
    while (g.firstChild) {
      const n = g.firstChild;
      if (n === h3) {
        g.removeChild(n);
        continue;
      }
      inner.appendChild(n);
    }
    box.appendChild(inner);
    g.appendChild(box);
  }
  /* ② 顶部工具条：搜索 + 全部展开 + 常用快跳 */
  const bar = document.createElement('div');
  bar.id = 'cfgBar';
  bar.style.cssText = 'position:sticky;top:0;background:var(--card);z-index:3;padding:2px 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--border);margin-bottom:10px';
  /* ③ 与"出厂基线"的差异（P1-7 最后一件）：回答"这套配置和你最初时哪里不一样" ——
     排障与交接时最需要这一条。数据由服务端下发（configDiff），界面只渲染，
     免得同一套口径在两端各写一遍。路径末段能匹配到 #c_<名字> 的就做成可点击跳转，
     匹配不到就只显示路径（不放假跳转）。 */
  const diff = (state.bootstrap && state.bootstrap.configDiff) || { count: 0, items: [] };
  bar.innerHTML = `<input class="inp" id="cfgSearch" placeholder="搜索设置项（例：封面 / 保留天数 / 弹幕 / Key）" style="width:300px">
    <button class="btn-sm" id="cfgExpandAll">全部展开</button>
    <span class="hintline" id="cfgSearchNote"></span>
    <span class="hintline">常用：${CFG_PINNED.map(([id, label]) => `<button class="linkbtn" data-cfgjump="${id}">${esc(label)}</button>`).join(' · ')}</span>
    <details class="hintline" style="margin-left:auto">
      <summary style="cursor:pointer">${diff.count ? `你改过 <b>${diff.count}</b> 项` : '与出厂基线一致'}</summary>
      ${diff.count
        ? `<div style="max-height:220px;overflow:auto;margin-top:6px">
             ${diff.items
               .map((it) => {
                 const leaf = String(it.path).split('.').pop() || '';
                 const target = body.querySelector(`#c_${leaf}`) ? `c_${leaf}` : '';
                 return `<div style="white-space:nowrap">${
                   target ? `<button class="linkbtn" data-cfgjump="${esc(target)}">${esc(it.path)}</button>` : `<span class="mono-sm">${esc(it.path)}</span>`
                 } <span style="color:var(--text-3)">${it.kind === 'added' ? `新增：${esc(it.to ?? '')}` : it.kind === 'removed' ? `已删除（原 ${esc(it.from ?? '')}）` : `${esc(it.from ?? '')} → <b>${esc(it.to ?? '')}</b>`}</span></div>`;
               })
               .join('')}
             ${diff.count > diff.items.length ? `<div style="color:var(--text-3)">… 还有 ${diff.count - diff.items.length} 项</div>` : ''}
             <div style="color:var(--text-3);margin-top:6px">基线保存在 data/config-baseline.json（删掉它即以当前配置为新基线）</div>
           </div>`
        : ''}
    </details>`;
  body.insertBefore(bar, body.firstChild);

  /* ③ 危险字段打标（不阻止保存，但让人看见） */
  for (const id of CFG_DANGER) {
    const el = body.querySelector(`#${id}`);
    const field = el ? el.closest('.field') : null;
    const label = field ? field.querySelector('label') : null;
    if (label && !label.querySelector('[data-danger]')) {
      const tag = document.createElement('span');
      tag.setAttribute('data-danger', '1');
      tag.className = 'tag-mini';
      tag.style.cssText = 'background:#fdecec;color:#c33;margin-left:6px';
      tag.textContent = '⚠ 改错代价大';
      label.appendChild(tag);
    }
  }

  /* ④ 搜索：按字段的文字过滤；命中的分组自动展开，并如实报匹配数 */
  const search = body.querySelector('#cfgSearch');
  const note = body.querySelector('#cfgSearchNote');
  const fields = [...body.querySelectorAll('.field')];
  const applyFilter = () => {
    const q = String(search?.value ?? '').trim().toLowerCase();
    if (note) note.textContent = '';
    for (const f of fields) f.style.display = '';
    for (const g of groups) {
      const d = g.querySelector('details.cfggroup');
      if (d && !q) d.open = false;
    }
    if (!q) return;
    let hit = 0;
    for (const f of fields) {
      const hay = String(f.textContent ?? '').toLowerCase();
      const ok = hay.includes(q);
      f.style.display = ok ? '' : 'none';
      if (ok) {
        hit++;
        const d = f.closest('details.cfggroup');
        if (d) d.open = true;
      }
    }
    if (note) note.textContent = hit ? `匹配 ${hit} 项（已自动展开所在分组）` : '没有匹配的设置项';
  };
  if (search) search.oninput = applyFilter;
  const expand = body.querySelector('#cfgExpandAll');
  if (expand) {
    expand.onclick = () => {
      const ds = [...body.querySelectorAll('details.cfggroup')];
      const anyClosed = ds.some((d) => !d.open);
      for (const d of ds) d.open = anyClosed;
      expand.textContent = anyClosed ? '全部收起' : '全部展开';
    };
  }
  /* ⑤ 常用快跳：展开所在分组 + 滚到它 + 聚焦（不移动 DOM，避免 id 重复导致保存读错值） */
  body.querySelectorAll('[data-cfgjump]').forEach((b) => (b.onclick = () => {
    const el = body.querySelector(`#${b.dataset.cfgjump}`);
    if (!el) return;
    const d = el.closest('details.cfggroup');
    if (d) d.open = true;
    const field = el.closest('.field');
    if (field) field.scrollIntoView({ block: 'center' });
    if (typeof el.focus === 'function') el.focus();
  }));
}

async function openCfg() {
  /* 每次打开设置面板都重新拉一次：面板渲染的是「此刻」的配置快照。
     以前这里复用 state.bootstrap，于是「打开页面 → 别处改了 config.json → 打开设置 → 保存」
     会把别处的改动静默覆盖掉（实测丢过 llm.select.model）。
     现在既刷新表单，又拿到 configVersion 供保存时做乐观锁校验。 */
  await loadBootstrap();
  const b = state.bootstrap;
  const c = b.config;
  // 术语表可能还没加载（旧页面/接口失败）：给个空壳，界面不至于整块报错
  const glossary = {
    anchors: [],
    terms: [],
    replacements: [],
    path: 'data/glossary.json',
    ...(b.glossary || {}),
  };
  const tags = (c.publish.tidWhitelist ? Object.keys(c.publish.tidWhitelist) : []);
  $('#cfgBody').innerHTML = `
  <div class="group"><h3>连接</h3>
    <p class="gdesc">录制、压制、切割、上传、ASR 全部由 biliLive-tools 执行，这里只填它的地址与鉴权。</p>
    <div class="fields">
      <div class="field"><label>biliLive-tools 地址</label><div class="ctl">
        <input class="inp" id="c_baseUrl" value="${esc(c.bililive.baseUrl)}">
        <button class="btn-sm" data-test="conn">测试</button></div>
        <div class="testres" id="res-conn"></div></div>
      <div class="field"><label>PassKey</label><div class="ctl">
        <input class="inp" type="password" id="c_passKey" value="${esc(c.bililive.passKey)}">
        <button class="btn-sm" data-pwd="c_passKey">显示</button></div>
        <div class="hintline">留空表示不修改。值不会写入日志或错误报告。</div></div>
    </div></div>

  <div class="group"><h3>直播间与录制</h3>
    <p class="gdesc">检查间隔越短，录制结束后越快被感知。轮询在任何情况下都保留 —— 它是可靠兜底。</p>
    <div class="fields">
      <div class="field"><label>B站直播间房间号</label><input class="inp" id="c_roomId" value="${esc(c.room.roomId)}"></div>
      <div class="field"><label>platform（必须首字母大写）</label><input class="inp" id="c_platform" value="${esc(c.room.platform)}" readonly>
        <div class="hintline">写成 bilibili 会<b>静默返回空数组</b>，触发永不生效（陷阱 #1）</div></div>
      <div class="field"><label>检查开播间隔（秒）</label><input class="inp num" id="c_pollIntervalSec" value="${c.room.pollIntervalSec}"></div>
      <div class="field"><label>下播确认窗口（秒）</label><input class="inp num" id="c_offlineConfirmSec" value="${c.room.offlineConfirmSec}">
        <div class="hintline">断流误触发的防线：持续非直播 ≥ 该窗口才判定本场结束（硬约束 #19）</div></div>
      <div class="field"><label>历史对账间隔（分钟）</label><input class="inp num" id="c_reconcileIntervalMin" value="${c.room.reconcileIntervalMin}"></div>
      <div class="field"><label>录制器类型</label>
        <select class="inp" id="c_recorderType">
          ${['builtin', 'bililiverecorder', 'blrec', 'ddtv', 'oneliverec', 'custom'].map((t) => `<option value="${t}" ${c.recorder.type === t ? 'selected' : ''}>${{ builtin: '内置引擎（无对外事件源，用轮询）', bililiverecorder: '录播姬', blrec: 'blrec', ddtv: 'DDTV', oneliverec: 'oneliverec', custom: '其它 / custom' }[t]}</option>`).join('')}
        </select>
        <div class="hintline">首选方案：让录制器<b>直接配置两个 webhook 目标</b>（本服务 + biliLive-tools），零转发零单点故障</div></div>
    </div></div>

  <div class="group"><h3>切片与选片</h3>
    <p class="gdesc">控制 LLM 每场产出多少候选、哪些默认勾选；单场可在任务页临时覆盖。</p>
    <div class="fields">
      <div class="field"><label>每场最多候选切片数</label><input class="inp num" id="c_maxCandidates" value="${c.clip.maxCandidates}"></div>
      <div class="field"><label>推荐阈值（低于此分默认不勾选）</label><input class="inp num" id="c_autoSelectScoreFloor" value="${c.clip.autoSelectScoreFloor}">
        <div class="hintline">两个闸门分工（2026-10-12 澄清）：<b>这一项只管"勾不勾"</b> —— 分数 ≥ 它就会被勾上；<b>自动投多少</b>另由 <span class="mono-sm">clip.autoSelectTopN</span>（当前 ${c.clip.autoSelectTopN}，本页没有控件，改 config.json）决定：按评分降序只自动投前 N 个，超出部分仍保持勾选、但需要你点一下发布（会写一条含分数的日志）。想"达标就全投"就把它调大（99 = 实质不设限）。</div></div>
      <div class="field"><label>片段时长范围（秒）</label><div class="ctl">
        <input class="inp num" id="c_minDurationSec" value="${c.clip.minDurationSec}"><span style="color:var(--text-3)">—</span>
        <input class="inp num" id="c_maxDurationSec" value="${c.clip.maxDurationSec}"></div></div>
      <div class="field"><label>前后缓冲（秒）</label><input class="inp num" id="c_bufferSec" value="${c.clip.bufferSec}"></div>
      <div class="field"><label>画面烧入弹幕</label><div class="inline-switch">
        <button class="switch sm ${c.clip.burnDanmaku ? 'on' : ''}" id="c_burnDanmaku"></button>
        <span>${c.clip.burnDanmaku ? '开启（原生弹幕，无错字风险）' : '关闭（切片画面无弹幕）'}</span></div></div>
      <div class="field"><label>源文件是否已烧弹幕</label><div class="inline-switch">
        <button class="switch sm ${c.clip.fullVideoHasDanmaku ? 'on' : ''}" id="c_fullVideoHasDanmaku"></button>
        <span>${c.clip.fullVideoHasDanmaku ? '是（切片时不再传 ASS，避免叠双层弹幕）' : '否（切片时传入整场 ASS）'}</span></div>
        <div class="hintline">该值由压制预设或本场配置决定，<b>不允许运行时猜测</b>（硬约束 #12）</div></div>
      <div class="field"><label>ffmpeg 预设 ID</label><input class="inp" id="c_ffmpegPresetId" value="${esc(c.clip.ffmpegPresetId)}">
        <div class="hintline">从 biliLive-tools 的预设读取参数；切片必须重编码，禁止 stream copy</div></div>
      <div class="field"><label>编码参数覆盖（JSON，可留空）</label><input class="inp" id="c_ffmpegOptionsOverride" value="${esc(JSON.stringify(c.clip.ffmpegOptionsOverride || {}))}"></div>
      <div class="field full"><label>多分P 稿件的「切片分P」标题模板</label>
        <input class="inp" id="c_partTitleTemplate" value="${esc(c.publish.partTitleTemplate || '')}" placeholder="留空 = 沿用 P3 标题 的旧行为；例：{anchor}切片{n} {title}">
        <div class="hintline">可用变量：<span class="mono-sm">{n}</span> 分P 序号、<span class="mono-sm">{title}</span> 切片标题、
          <span class="mono-sm">{anchor}</span> 主播名、<span class="mono-sm">{date}</span> 录制日期、
          <span class="mono-sm">{mainTitle}</span> 稿件主标题。<b>实测创作中心里看到的「P3 主播收到…」就是默认模板的产物</b>。</div>
        <div class="hintline" id="partTitlePreview"></div></div>
      <div class="field full"><label>投稿体检</label><div class="ctl">
        <button class="btn-sm" id="btnAuditCurrent">对最近的场次跑一次体检</button>
        <span class="hintline">列出本场投了几次、有没有重复稿件、bvid 是否可信、标题有没有硬伤。也可以在某场任务详情页点「投稿体检」。</span></div></div>
      <div class="field full"><label>回收站 / 待删清单</label><div class="ctl">
        <span class="hintline">这两项已经<b>搬到顶部标签栏、并合并成一页</b>（2026-10-11）：
        「待删 / 回收站」里第一段是「用完即删」的待删（宽限期内可取消），第二段是回收站（已删除、可恢复、超期自动清理）——
        不用再翻设置。</span></div></div>
      <div class="field full"><label>回收站保留天数</label><div class="ctl">
        <input class="inp" id="c_trashDays" type="number" min="0" max="90" step="1" style="width:90px" value="${Number(c.cleanup.trashDays)}">
        <span class="hintline">超过这个天数的条目会被<b>自动彻底删除</b>（每天检查一次）；在「回收站」页每个日期上也能看到还剩几天到期。
          <b>0 = 不用回收站</b>：删除任务会直接永久删除，误点了也恢复不了。</span></div></div>
      <div class="field full"><label>MCP 接口</label><div class="ctl">
        <button class="btn-sm" id="btnMcp">接入 Agent（Claude Code / Codex / Cursor）<span id="mcpBadge"></span></button>
        <span class="hintline">把整个切片助手暴露成 MCP 工具，Agent 就能直接用对话驱动流水线：看任务、重跑某阶段、查为什么没导入、取消删源。只监听 127.0.0.1，且必须带 token。</span></div></div>
      <div class="field full"><label>记录选片决策</label><div class="inline-switch">
        <button class="switch sm ${c.runtime.recordDecisions ? 'on' : ''}" id="c_recordDecisions"></button>
        <span>${c.runtime.recordDecisions ? '开启（记录你的勾选与取消，用于观察 LLM 的偏好偏差）' : '关闭（无法分析选片偏好）'}</span></div>
        <div class="hintline">记录含评分与理由、以及你编辑后的最终标题/时间范围/标签，仅存本机。</div></div>
    </div></div>

  <div class="group"><h3>字幕与术语表</h3>
    <p class="gdesc">转写结果烧成字幕（与弹幕合成同一个 ASS 交给切片接口）；术语表用来纠正 ASR 听错的人名与术语，
      并告诉选片模型这些词是专有名词、不要改写。</p>
    <div class="fields">
      <div class="field"><label>画面烧入字幕</label><div class="inline-switch">
        <button class="switch sm ${c.clip.burnSubtitles ? 'on' : ''}" id="c_burnSubtitles"></button>
        <span>${c.clip.burnSubtitles ? '开启（字幕烧进画面）' : '关闭（画面只有弹幕）'}</span></div>
        <div class="hintline">字幕位置比弹幕更高、字号更大，两者不会叠在一起。
          <b>字幕准不准取决于转写引擎</b>：本地 Fun-ASR 有字级时间戳（实测偏差 ±0.2 秒）；云端 ASR 的句级时间窗不可靠（实测 15 个字的句子占了 0→30.9 秒），烧出来会与声音错位。
          顶栏那个「字幕」开关可以随时切，不用进这里。</div></div>
      <div class="field"><label>字幕字号（0 = 自动）</label><input class="inp num" id="c_subtitleFontSize" value="${c.clip.subtitle.fontSize}"></div>
      <div class="field"><label>每行最多几个字</label><input class="inp num" id="c_subtitleMaxChars" value="${c.clip.subtitle.maxCharsPerLine}"></div>
      <div class="field"><label>单条最短显示（秒）</label><input class="inp num" id="c_subtitleMinDur" value="${c.clip.subtitle.minDurationSec}"></div>
      <div class="field full"><label>主播 / 常驻嘉宾（一行一个）</label>
        <textarea class="inp" id="c_glossaryAnchors" rows="2" placeholder="甲主播">${esc(glossary.anchors.join('\n'))}</textarea></div>
      <div class="field full"><label>术语 / 梗 / 栏目名（一行一个）</label>
        <textarea class="inp" id="c_glossaryTerms" rows="4" placeholder="后半夜后悔时代&#10;闪身步">${esc(glossary.terms.join('\n'))}</textarea>
        <div class="hintline">会注入到「分块要点」和「选片起标题」的提示词里，让模型知道这些词的正确写法。</div></div>
      <div class="field full"><label>纠错规则（一行一条，写成 <span class="mono-sm">错→对</span>；正则加前缀 <span class="mono-sm">re:</span>）</label>
        <textarea class="inp" id="c_glossaryRepl" rows="4" placeholder="闪身部→闪身步&#10;re:\\d+次红包→很多次红包">${esc(glossary.replacements.map((r) => `${r.regex ? 're:' : ''}${r.from}→${r.to}`).join('\n'))}</textarea>
        <div class="hintline">转写完成后做确定性替换，按书写顺序生效（先写的先跑）。<b>改完保存即生效，不需要重新转写、不重复花钱。</b></div></div>
      <div class="field full"><label>热词表</label><div class="ctl">
        <button class="btn-sm" id="btnCopyHotWords">复制热词（一行一个）</button>
        <button class="btn-sm" id="btnCopyHotWords2">复制热词（逗号分隔）</button>
        <span class="hintline">本项目的 ASR 走 biliLive-tools，实测它的 <span class="mono-sm">/ai/subtitle</span> 只收
          file/modelId/startTime/endTime/offset/song 六个参数，<b>没有热词入参</b>。所以热词在这里只能作为可复制清单：
          换成本地 whisper（initial_prompt）或云厂商控制台的「定制热词」时可直接粘贴。</span></div>
        <div class="hintline">术语表文件：<span class="mono-sm">${esc(glossary.path)}</span>（也可以直接用记事本改，保存即生效）</div></div>
    </div></div>

  <div class="group"><h3>AI 配置</h3>
    <p class="gdesc">字幕识别复用 biliLive-tools 中已配置的模型与凭据，本服务不重复管理。内容分析（LLM）由本服务自研调用。</p>
    <div class="fields">
      <div class="field full"><label>字幕识别模型</label>
        <input class="inp" readonly value="在 biliLive-tools 设置 → AI 配置 中指定（必须勾选 ASR 标签）">
        <div class="hintline">转写用于内容分析、选片，以及烧成画面字幕（可在上方「字幕与术语表」里关闭）。未配置该模型时 /ai/subtitle 会直接抛错（陷阱 #5）。</div></div>
      <div class="field full"><label>服务预设</label>
        <select class="inp" id="c_llmPreset">
          ${Object.entries({ deepseek: 'DeepSeek（推荐：结构化抽取强，支持错峰半价与缓存折扣）', aliyun: '阿里云百炼 · 通义千问（与字幕识别同一个 Key）', zhipu: '智谱 GLM-Flash（有免费档，适合先跑通链路）', ollama: '本地 Ollama（完全离线，需自备显卡）', custom: '自定义' }).map(([k, v]) => `<option value="${k}" ${c.llm.preset === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
        <div class="hintline" id="presetNote"></div></div>
      <div class="field full"><label>LLM 接口地址</label><input class="inp" id="c_llmUrl" value="${esc(c.llm.summary.baseUrl)}"></div>
      <div class="field"><label>API Key</label><div class="ctl">
        <input class="inp" type="password" id="c_llmKey" value="${esc(c.llm.summary.apiKey)}">
        <button class="btn-sm" data-pwd="c_llmKey">显示</button></div></div>
      <div class="field"><label>模型名（分块与总结）</label><div class="ctl">
        <input class="inp" id="c_llmModel" value="${esc(c.llm.summary.model)}">
        <button class="btn-sm" data-test="llm">测试</button></div>
        <div class="testres" id="res-llm"></div></div>
      <div class="field full"><label>选片专用模型（留空则同上）</label>
        <input class="inp" id="c_llmSelectModel" value="${esc(c.llm.select.model)}" placeholder="建议填更强的型号，仅用于选片与起标题（每场 1–2 次）">
        <div class="hintline" id="escalationHint"></div></div>
      <div class="field"><label>分块时长（分钟）</label><input class="inp num" id="c_chunkMinutes" value="${c.llm.chunkMinutes}"></div>
      <div class="field"><label>分块并发</label><input class="inp num" id="c_chunkConcurrency" value="${c.llm.chunkConcurrency}"></div>
      <div class="field full"><label>转写引擎</label>
        <select class="inp" id="c_asrProvider">
          <option value="bililive-tools" ${c.asr.provider === 'bililive-tools' ? 'selected' : ''}>云端（biliLive-tools → 阿里云 DashScope）：按时长计费，最快</option>
          <option value="local-funasr" ${c.asr.provider === 'local-funasr' ? 'selected' : ''}>本地 Fun-ASR-Nano（阿里云开源）：免费，同素材实测字错率 8.8%，慢约 5 倍</option>
          <option value="whisper-cpp" ${c.asr.provider === 'whisper-cpp' ? 'selected' : ''}>本地 faster-whisper：免费，字错率约 17%（比 Fun-ASR 差一倍）—— 已被 Fun-ASR 压过，不推荐</option>
        </select>
        <div class="hintline">本地引擎需要先建好环境：Fun-ASR 用 <span class="mono-sm">node tools/local-asr/setup-funasr.mjs</span>，whisper 用 <span class="mono-sm">.venv-asr</span>。本地跑不产生任何云端费用。</div>
        <div class="hintline">两个<b>只改配置、界面上刻意没给开关</b>的项，连同实测结论写在这儿，免得你到处找：<br>
          · <span class="mono-sm">asr.silenceTrim.enabled</span> 静音裁剪：实测 480.4 s → 468.2 s，<b>只省 12 秒</b>（字幕条数与覆盖完全一致）⇒ <b>默认关，不建议开</b>；<br>
          · <span class="mono-sm">asr.worker.enabled</span> 转写放独立进程：实测 549.5 s vs 进程内 466.6 s，<b>慢约 18%</b>，换来的是"ASR 崩溃/OOM 不拖垮主链" ⇒ 要崩溃隔离就开，赶时间就关。</div></div>
      <div class="field"><label>Fun-ASR 设备</label>
        <select class="inp" id="c_funasrDevice">
          <option value="auto" ${c.asr.localFunasr.device === 'auto' ? 'selected' : ''}>auto（有 CUDA 就用）</option>
          <option value="cuda" ${c.asr.localFunasr.device === 'cuda' ? 'selected' : ''}>cuda</option>
          <option value="cpu" ${c.asr.localFunasr.device === 'cpu' ? 'selected' : ''}>cpu</option>
        </select></div>
      <div class="field"><label>Fun-ASR 推理引擎</label>
        <select class="inp" id="c_funasrEngine">
          <option value="auto" ${c.asr.localFunasr.engine === 'auto' ? 'selected' : ''}>auto（优先 vLLM，失败退 PyTorch）</option>
          <option value="pytorch" ${c.asr.localFunasr.engine === 'pytorch' ? 'selected' : ''}>pytorch（实测 4 小时素材约 43 分钟）</option>
          <option value="vllm" ${c.asr.localFunasr.engine === 'vllm' ? 'selected' : ''}>vllm（官方 bench 快 16 倍，需另装）</option>
        </select></div>
      <div class="field"><label>Fun-ASR 每句字数上限</label><input class="inp num" id="c_funasrMaxChars" value="${c.asr.localFunasr.maxCharsPerCue}">
        <div class="hintline">按标点切句时一条字幕最多几个字，与字幕排版保持一致</div></div>
      <div class="field"><label>Fun-ASR 模型路径（Python）</label><input class="inp" id="c_funasrPython" value="${esc(c.asr.localFunasr.pythonPath || '')}" placeholder="留空 = 项目内 .venv-funasr"></div>
      <div class="field full"><label>Fun-ASR 字级时间戳</label><div class="inline-switch">
        <button class="switch sm ${c.asr.localFunasr.timestamps !== false ? 'on' : ''}" id="c_funasrTimestamps"></button>
        <span>${c.asr.localFunasr.timestamps !== false ? '开启（时间戳偏差 ±0.2s，推荐）' : '关闭（退化成 VAD 段粒度，偏差 ±2s）'}</span></div>
        <div class="hintline">开启后每句的时间取该句首字与末字的真实时刻（CTC 强制对齐），而不是整段的起止。</div></div>
      <div class="field"><label>热词上限（术语表 → Fun-ASR）</label><input class="inp num" id="c_funasrHotwordsMax" value="${c.asr.localFunasr.hotwordsMax ?? 80}">
        <div class="hintline">热词不是越多越好：超上限的部分会被丢掉（日志里会说明丢了几个）</div></div>
      <div class="field full"><label>把术语表当热词喂给 Fun-ASR</label><div class="inline-switch">
        <button class="switch sm ${c.asr.localFunasr.hotwordsEnabled !== false ? 'on' : ''}" id="c_funasrHotwords"></button>
        <span>${c.asr.localFunasr.hotwordsEnabled !== false ? '开启（推荐）' : '关闭'}</span></div>
        <div class="hintline">术语表（<span class="mono-sm">data/glossary.json</span> 的 anchors + terms）会作为 <span class="mono-sm">hotwords</span> 传给本地 Fun-ASR —— <b>只有它支持热词</b>（云端 biliLive-tools 的 /ai/subtitle 不透传热词）。同素材实测：目标词命中 5→8 次、相对云端基准的字错率 5.47%→5.03%，耗时无变化。改了术语表要<b>重新转写</b>才生效（缓存键含热词指纹，会自动重算，不会拿旧结果糊弄）。</div></div>
      <div class="field full"><label>ASR 分段时长（分钟）</label><input class="inp num" id="c_asrSegmentMinutes" value="${c.asr.segmentMinutes}">
        <div class="hintline">/ai/subtitle 是同步阻塞接口，4 小时全片一次调用会挂 20–40 分钟；必须分段且 startTime/endTime 成对（硬约束 #7）。本地 Fun-ASR 会自动忽略它（整文件一次调用，省掉重复加载模型）。</div></div>
      <div class="field"><label>ASR 单价（元/小时，用于估算）</label><input class="inp num" id="c_asrPrice" value="${c.asr.unitPricePerHour}"></div>
      <div class="field"><label>转写输入源</label>
        <select class="inp" id="c_asrInputSource">
          <option value="raw" ${c.asr.inputSource === 'raw' ? 'selected' : ''}>录制原始文件（可与压制并行，推荐）</option>
          <option value="full" ${c.asr.inputSource === 'full' ? 'selected' : ''}>压制产物 mp4</option>
        </select></div>
      <div class="field full"><label>边录边转写（录制中就把已录完的分段转掉）</label><div class="inline-switch">
        <button class="switch sm ${c.asr.incrementalEnabled === true ? 'on' : ''}" id="c_incrementalEnabled"></button>
        <span>${c.asr.incrementalEnabled === true ? '开启（录完只剩最后一段要转）· 需重启服务才生效' : '关闭（等整段录完才开始转）'}</span></div>
        <div class="hintline">实测"等开始转写"占 573–3691 秒，比转写本身（59 分钟素材约 133–145 秒）长得多 —— 开它能把这部分拿回来。只转<b>已闭合</b>的分段（判据与正式导入同一个常量），任何一段失败就整场回退到整段转写，不会出半截字幕；分段结果走的是同一份 ASR 缓存，不重复计费。<b>⚠️ 改这一项需要重启服务</b>（预转写循环只在启动时按此开关创建）：<span class="mono-sm">node tools/restart-service.ts --force</span>。生效后在日志里搜「预转写」看进度。</div></div>
    </div></div>

  <div class="group"><h3>发布策略</h3>
    <p class="gdesc">切片按设定间隔错峰发布，避免集中投稿。</p>
    <div class="fields">
      <div class="field full"><label>首片发布时间（留空 = 按公式自动排期）</label>
        <div class="ctl">
          <input class="inp" type="datetime-local" id="c_firstPublishAt" value="${esc(c.publish.firstPublishAt || '')}" style="width:auto">
          <button class="btn-sm" id="btnClearFirstAt">自动排期</button>
          <button class="btn-sm" data-quick="+3h">3 小时后</button>
          <button class="btn-sm" data-quick="tomorrow8">明早 8 点</button>
          <button class="btn-sm" data-quick="tomorrow20">明晚 8 点</button>
        </div>
        <div class="hintline" id="hintPlan"></div>
      </div>
      <div class="field"><label>首片提交余量（秒，必须 &gt;7200）</label><input class="inp num" id="c_submitGapSec" value="${c.publish.submitGapSec}">
        <div class="hintline ok" id="hintGap">公式：dtime = 提交时刻 + ${c.publish.submitGapSec} + (N-1)×${c.publish.clipGapSec} + random(0,${c.publish.jitterSec})</div>
        <div class="hintline">指定了「首片发布时间」后，这一项只作为<b>兜底下限</b>（指定时间更早时会被推迟到它）</div></div>
      <div class="field"><label>相邻切片间隔（秒）</label><input class="inp num" id="c_clipGapSec" value="${c.publish.clipGapSec}">
        <div class="hintline">B站硬限制是「相对<b>各稿件自身提交时刻</b> &gt;7200 秒」，相邻间隔不受额外限制；7500 仅为保守余量</div></div>
      <div class="field"><label>随机抖动上限（秒）</label><input class="inp num" id="c_jitterSec" value="${c.publish.jitterSec}"></div>
      <div class="field"><label>每日投稿上限</label><input class="inp num" id="c_dailyLimit" value="${c.publish.dailyLimit}"></div>
      <div class="field"><label>仅自己可见（试跑期建议开启）</label><div class="inline-switch">
        <button class="switch sm ${c.publish.isOnlySelf === 1 ? 'on' : ''}" id="c_isOnlySelf"></button>
        <span>${c.publish.isOnlySelf === 1 ? '开启' : '关闭（公开可见）'}</span></div></div>
      <div class="field"><label>全自动发布</label><div class="inline-switch">
        <button class="switch sm ${c.publish.autoPublish ? 'on' : ''}" id="c_autoPublish"></button>
        <span>${c.publish.autoPublish ? '全自动（分析完直接排期发布）' : '半自动（需确认后发布）'}</span></div>
        <div class="hintline">首次部署必须用半自动，确认选片质量稳定后再改全自动</div></div>
      <div class="field"><label>立即发布（不传 dtime）</label><div class="inline-switch">
        <button class="switch sm ${c.publish.immediatePublish ? 'on' : ''}" id="c_immediatePublish"></button>
        <span>${c.publish.immediatePublish ? '开启 —— 稿件过审后直接公开' : '关闭 —— 按公式定时发布'}</span></div>
        <div class="hintline" id="hintImmediate"></div></div>
      <div class="field"><label>多分P投稿（完整版+纯享版+切片合成一个稿件）</label><div class="inline-switch">
        <button class="switch sm ${c.publish.multiPart ? 'on' : ''}" id="c_multiPart"></button>
        <span>${c.publish.multiPart ? '开启 —— 省额度，但各分P同一时刻发布' : '关闭 —— 每片一稿，可错峰但费额度'}</span></div>
        <div class="hintline" id="hintMultiPart"></div></div>
      <div class="field"><label>完整版（弹幕版 + 纯享版）由谁投稿</label>
        <select class="inp" id="c_fullVideoBy">
          <option value="bililive-tools" ${c.publish.fullVideoBy !== 'assistant' ? 'selected' : ''}>biliLive-tools 投（默认）—— 它压制并投出完整版，本服务只把切片追加进同一个稿件</select>
          <option value="assistant" ${c.publish.fullVideoBy === 'assistant' ? 'selected' : ''}>切片助手投（例外）—— 本服务自己烧弹幕版 + remux 纯享版，新建 2+N 稿件</option>
        </select>
        <div class="hintline">规则：<b>除非你明确在这里（或该任务的 overrides.fullVideoBy）说明由切片助手投，否则完整版一律由 biliLive-tools 投</b>。
          默认路径下，如果它还没投出来，本场会停在「已切片」<b>等待</b>（最多 ${c.publish.resumeWaitMin} 分钟，可在 config.json 调 publish.resumeWaitMin），
          不会自己投完整版、也不会把切片投成独立稿件。</div></div>
      <div class="field"><label>等待完整版稿件的上限（分钟）</label><input class="inp" id="c_resumeWaitMin" type="number" min="1" max="1440" value="${c.publish.resumeWaitMin}">
        <div class="hintline">biliLive-tools 的压制 + 上传是异步的（实测录制结束后 13–15 分钟才出弹幕版）。超时后本场仍停在「已切片」并告警，交人工确认。</div></div>
      <div class="field"><label>合集 ID（seasonId，留空则无法归入合集）</label><input class="inp" id="c_seasonId" value="${c.publish.seasonId || ''}" placeholder="需在 B站创作中心手动创建后填写">
        <div class="hintline">⚠️ 没有任何接口能创建合集；留空时切片照常投稿但<b>不会归入同一合集</b></div></div>
      <div class="field"><label>分区（默认）</label>
        <select class="inp" id="c_defaultCategory">${tags.map((t) => `<option ${c.publish.defaultCategory === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="field full"><label>默认标签（逗号分隔）</label><input class="inp" id="c_defaultTags" value="${esc(c.publish.defaultTags.join(', '))}">
        <div class="hintline" id="hintTags"></div></div>
      <div class="field full"><label>简介模板</label><textarea class="inp" id="c_descTemplate">${esc(c.publish.descTemplate)}</textarea>
        <div class="hintline">可用变量：{{date}} {{liveTitle}} {{roomUrl}} {{startText}} {{endText}} {{desc}}（上限 250 字符，超出自动截断）</div></div>
      <div class="field full"><label>简介末尾的 AI 声明</label><textarea class="inp" id="c_aiNotice" rows="2" placeholder="留空 = 不写声明">${esc(c.publish.aiNotice || '')}</textarea>
        <div class="hintline">切片是 LLM 选段 + AI 生成标题/字幕后自动投稿的，观众与平台都该看得见。
          <b>声明最后拼、不参与 250 字符截断</b>，所以正文再长也不会把它挤掉；单切片、多分P 稿件、我们上传的完整版都会带上。
          可以多行（例如声明 + 一句求赞）。</div></div>
      <div class="field"><label>封面来源优先级</label>
        <select class="inp" id="c_coverSource">
          <option value="preset" ${c.publish.coverSource === 'preset' ? 'selected' : ''}>biliLive-tools 投稿预设（默认）</option>
          <option value="default" ${c.publish.coverSource === 'default' ? 'selected' : ''}>配置的默认封面图</option>
          <option value="fullVideo" ${c.publish.coverSource === 'fullVideo' ? 'selected' : ''}>复用完整版封面</option>
        </select></div>
      <div class="field"><label>默认封面绝对路径（可留空）</label><input class="inp" id="c_defaultCover" value="${esc(c.publish.defaultCover)}"></div>
      <div class="field"><label>创作声明</label>
        <select class="inp" id="c_creationStatement">
          ${[[-1, '不声明'], [1, '含 AI 生成内容'], [2, '含虚构演绎内容'], [3, '内容为转载'], [4, '含个人观点']].map(([v, t]) => `<option value="${v}" ${c.publish.creationStatement === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <div class="hintline">封面/文案由 AI 生成时按平台要求标注</div></div>
      <div class="field"><label>版权</label>
        <select class="inp" id="c_copyright">${[[1, '自制'], [2, '转载'], [3, '其他']].map(([v, t]) => `<option value="${v}" ${c.publish.copyright === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    </div></div>

  <div class="group"><h3>素材与清理</h3>
    <p class="gdesc">切片流程需要反复读取源视频，因此素材清理由本服务统一管理。</p>
    <div class="fields">
      <div class="field"><label>源视频保留天数（切片全部发布后起算）</label><input class="inp num" id="c_retentionDays" value="${c.cleanup.retentionDays}"></div>
      <div class="field"><label>磁盘剩余阈值（GB）</label><input class="inp num" id="c_diskFloorGB" value="${c.cleanup.diskFloorGB}"></div>
      <div class="field"><label>转写完成后删除原始分段</label><div class="inline-switch">
        <button class="switch sm ${c.cleanup.deleteRawAfterTranscribe ? 'on' : ''}" id="c_deleteRaw"></button>
        <span>${c.cleanup.deleteRawAfterTranscribe ? '开启（省空间，原始分段是最占地方的中间产物）' : '关闭'}</span></div></div>
      <div class="field"><label>失败时保留素材</label><div class="inline-switch">
        <button class="switch sm ${c.cleanup.keepFullVideoOnFailure ? 'on' : ''}" id="c_keepOnFail"></button>
        <span>${c.cleanup.keepFullVideoOnFailure ? '开启（便于重跑）' : '关闭'}</span></div></div>
      <div class="field full"><input class="inp" readonly value="biliLive-tools 的「上传后删除素材」必须关闭（afterUploadDeletAction = none）">
        <div class="hintline warn">⚠️ 若开启，稿件过审后源视频会被删除，导致转写与切片读到不存在的文件 —— 故障表现分散，很难定位（硬约束 #11）</div></div>
    </div></div>

  <div class="group"><h3>通知与告警</h3>
    <p class="gdesc">事件推送到手机，方便随时确认选片结果。告警会去重，恢复时发送恢复通知。</p>
    <div class="fields">
      <div class="field full"><label>通知渠道</label><div class="chips" id="c_channels">
        ${['serverchan', 'dingtalk', 'telegram', 'webhook'].map((ch) => `<button class="chip ${c.alert.channels.includes(ch) ? 'on' : ''}" data-ch="${ch}">${{ serverchan: 'Server酱', dingtalk: '钉钉机器人', telegram: 'Telegram', webhook: '自定义 Webhook' }[ch]}</button>`).join('')}
      </div></div>
      <div class="field"><label>Server酱 SendKey</label><div class="ctl">
        <input class="inp" type="password" id="c_scKey" value="${esc(c.alert.serverchan.sendKey)}">
        <button class="btn-sm" data-pwd="c_scKey">显示</button>
        <button class="btn-sm" data-test="alert" data-ch="serverchan">测试</button></div>
        <div class="testres" id="res-alert"></div></div>
      <div class="field"><label>钉钉 Webhook</label><input class="inp" id="c_dtWebhook" value="${esc(c.alert.dingtalk.webhook)}"></div>
      <div class="field"><label>钉钉加签 Secret</label><input class="inp" type="password" id="c_dtSecret" value="${esc(c.alert.dingtalk.secret)}"></div>
      <div class="field"><label>Telegram Bot Token</label><input class="inp" type="password" id="c_tgToken" value="${esc(c.alert.telegram.botToken)}"></div>
      <div class="field"><label>Telegram Chat ID</label><input class="inp" id="c_tgChat" value="${esc(c.alert.telegram.chatId)}"></div>
      <div class="field full"><label>推送事件</label><div class="chips" id="c_events">
        ${[['recordingDone', '录制完成'], ['analysisDone', '分析完成（待确认）'], ['publishSuccess', '发布成功'], ['failure', '失败告警'], ['accountExpiring', '账号即将过期'], ['diskLow', '磁盘不足'], ['versionDrift', '版本差异']].map(([k, t]) => `<button class="chip ${c.alert.events[k] ? 'on' : ''}" data-ev="${k}">${t}</button>`).join('')}
      </div></div>
      <div class="field"><label>账号过期预警（天）</label><input class="inp num" id="c_accountWarn" value="${c.alert.accountExpireWarnDays}"></div>
      <div class="field"><label>告警去重窗口（秒）</label><input class="inp num" id="c_dedupe" value="${c.alert.dedupeWindowSec}"></div>
    </div></div>

  <div class="group"><h3>运行</h3>
    <div class="fields">
      <div class="field"><label>日志级别</label>
        <select class="inp" id="c_logLevel">${['debug', 'info', 'warn', 'error'].map((l) => `<option ${c.runtime.logLevel === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>日志保留天数</label><input class="inp num" id="c_logKeepDays" value="${c.runtime.logKeepDays}"></div>
      <div class="field"><label>Web UI 端口</label><input class="inp num" id="c_uiPort" value="${c.ui.port}" readonly>
        <div class="hintline">改动需重启服务（当前页面所在端口）</div></div>
      <div class="field"><label>预览宿主（只读）</label><input class="inp" value="${esc(c.ui.host)}" readonly>
        <div class="hintline">硬约束 #2：只监听 127.0.0.1，绝不可改为 0.0.0.0</div></div>
    </div></div>`;

  $('#cfgMask').classList.add('show');
  $('#presetNote').textContent = LLM_PRESETS[c.llm.preset] ? LLM_PRESETS[c.llm.preset].note : '';
  updateEscalationHint();
  updateTagHint();
  renderDtimePlanPreview();
  bindCfg();
}

/**
 * 排期预览：把「首片/末片什么时候发、我指定的时间是否被推迟」直接显示出来。
 * 这些没有理由让用户自己按公式算。
 */
function renderDtimePlanPreview() {
  const el = $('#hintPlan');
  if (!el) return;
  const v = ($('#c_firstPublishAt') || {}).value || '';
  const b = state.bootstrap || {};
  const plan = b.dtimePlan || {};
  if (!v) {
    el.className = 'hintline';
    el.textContent = `自动排期：首片约 ${plan.firstText || '—'}，末片约 ${plan.lastText || '—'}（间隔 ${fmtSpan((b.config && b.config.publish.clipGapSec) || 7500)}）`;
    return;
  }
  const ms = Date.parse(v.replace(' ', 'T'));
  if (!Number.isFinite(ms)) { el.className = 'hintline warn'; el.textContent = '无法解析这个时间'; return; }
  const earliestMs = (plan.earliestAllowed || 0) * 1000;
  if (ms / 1000 < Math.floor(Date.now() / 1000) + 7200) {
    el.className = 'hintline warn';
    el.textContent = `⚠ 这个时间距现在不足 7200 秒（B站要求 dtime 晚于提交时刻 7200 秒）—— 实际会推迟到 ${plan.earliestAllowedText || '最早合法时间'} 发布`;
  } else {
    el.className = 'hintline ok';
    el.textContent = `✓ 首片 ${fmtTime(ms)} 发布，其余按间隔顺延`;
  }
}

function updateEscalationHint() {
  const sum = $('#c_llmModel').value.trim();
  const sel = $('#c_llmSelectModel').value.trim();
  const el = $('#escalationHint');
  if (!el) return;
  if (sel && sel === sum) {
    el.className = 'hintline warn';
    el.textContent = '⚠️ 与总结档配置为同一模型：「契约校验失败升级重跑」会退化为同模型重试一次，仍失败即直接降级。建议配一个更强的模型。';
  } else {
    el.className = 'hintline';
    el.textContent = '契约校验失败时会升级到该模型重跑，而不是在便宜模型上原地重试。';
  }
}
function updateTagHint() {
  const el = $('#hintTags');
  if (!el) return;
  const n = $('#c_defaultTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).length;
  el.className = n > 10 ? 'hintline warn' : 'hintline';
  el.textContent = n > 10 ? `已填 ${n} 个，超出 B站上限 10 个` : `已填 ${n} 个（上限 10 个，与 LLM 生成的标签合并后仍会去重与截断）`;
}

function bindCfg() {
  /* 设置面板瘦身：分组折叠 + 搜索 + 常用快跳 + 危险标注（纯增强层，见 enhanceCfgPanel 的说明） */
  enhanceCfgPanel();
  $$('#cfgBody [data-pwd]').forEach((b) => b.onclick = () => {
    const el = document.getElementById(b.dataset.pwd);
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    b.textContent = show ? '隐藏' : '显示';
  });
  $$('#cfgBody [data-test]').forEach((b) => b.onclick = async () => {
    const kind = b.dataset.test;
    const resEl = document.getElementById('res-' + kind);
    const old = b.textContent;
    b.disabled = true; b.textContent = '测试中…';
    resEl.className = 'testres'; resEl.textContent = '';
    try {
      const body = kind === 'llm' ? { target: 'llm', slot: 'summary' }
        : kind === 'alert' ? { target: 'alert', channel: b.dataset.ch || 'serverchan' }
        : { target: 'bililive' };
      const r = await api('/api/test', { method: 'POST', body });
      resEl.className = 'testres ' + (r.ok ? 'ok' : 'err');
      resEl.textContent = r.message || (r.ok ? '成功' : '失败');
    } catch (e) {
      resEl.className = 'testres err';
      resEl.textContent = e.message;
    }
    b.disabled = false; b.textContent = old;
  });
  const preset = $('#c_llmPreset');
  preset.onchange = () => {
    const p = LLM_PRESETS[preset.value];
    if (preset.value !== 'custom') {
      $('#c_llmUrl').value = p.url;
      $('#c_llmModel').value = p.model;
    }
    $('#presetNote').textContent = p.note;
    updateEscalationHint();
  };
  $('#c_llmModel').oninput = updateEscalationHint;
  $('#c_llmSelectModel').oninput = updateEscalationHint;
  $('#c_defaultTags').oninput = updateTagHint;

  // 首片发布时间：快捷按钮 + 实时预览
  const firstAt = $('#c_firstPublishAt');
  if (firstAt) {
    firstAt.oninput = renderDtimePlanPreview;
    firstAt.onchange = renderDtimePlanPreview;
  }
  const clearBtn = $('#btnClearFirstAt');
  if (clearBtn) clearBtn.onclick = () => {
    if (firstAt) firstAt.value = '';
    renderDtimePlanPreview();
    toast('已改为自动排期');
  };
  /** 本地时间 → datetime-local 需要的 YYYY-MM-DDTHH:mm */
  const toLocalInput = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  $$('#cfgBody [data-quick]').forEach((b) => (b.onclick = () => {
    if (!firstAt) return;
    const kind = b.dataset.quick;
    const now = Date.now();
    let ms;
    if (kind === '+3h') {
      ms = now + 3 * 3600_000;
    } else {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(kind === 'tomorrow8' ? 8 : 20, 0, 0, 0);
      ms = d.getTime();
    }
    // 不能早于 B站下限（提交后 7200 秒）；更早的话实际也会被推迟，这里直接给合法值更省事
    const floor = now + 7800_000;
    if (ms < floor) ms = floor;
    firstAt.value = toLocalInput(ms);
    renderDtimePlanPreview();
  }));

  const tgl = (id, cb) => { const el = $(id); if (el) el.onclick = () => { const on = el.classList.toggle('on'); cb(on, el); }; };
  tgl('#c_burnDanmaku', (on, el) => el.nextElementSibling.textContent = on ? '开启（原生弹幕，无错字风险）' : '关闭（切片画面无弹幕）');
  tgl('#c_burnSubtitles', (on, el) => el.nextElementSibling.textContent = on ? '开启（字幕烧进画面）' : '关闭（画面只有弹幕）');
  /* 热词开关：文案要跟着状态变 —— 关掉时用户唯一能看到的反馈就是这行字，
     否则"点了没反应"会被当成按钮坏了（这个坑本项目在其它开关上踩过）。 */
  tgl('#c_funasrHotwords', (on, el) => el.nextElementSibling.textContent = on ? '开启（推荐）' : '关闭');
  tgl('#c_funasrTimestamps', (on, el) => el.nextElementSibling.textContent = on ? '开启（时间戳偏差 ±0.2s，推荐）' : '关闭（退化成 VAD 段粒度，偏差 ±2s）');
  /* 边录边转写（P1-6）：文案跟着状态变，并在"刚打开"时明确提示要重启 ——
     否则用户点了、看着是开的，而预转写循环要等下次启动才创建（这一点在实现里是刻意的）。 */
  tgl('#c_incrementalEnabled', (on, el) => el.nextElementSibling.textContent = on ? '开启（录完只剩最后一段要转）· 需重启服务才生效' : '关闭（等整段录完才开始转）');
  { const cp = $('#btnCopyHotWords'); if (cp) cp.onclick = () => copyText(hotWordsFromForm().perLine, '热词（一行一个）'); }
  { const cp = $('#btnCopyHotWords2'); if (cp) cp.onclick = () => copyText(hotWordsFromForm().commaSeparated, '热词（逗号分隔）'); }
  // 分P 标题模板实时预览：模板写错（变量拼错）肉眼很难发现，这里直接渲染出来
  {
    const el = $('#c_partTitleTemplate');
    const prev = $('#partTitlePreview');
    const render = () => {
      if (!el || !prev) return;
      const tpl = el.value.trim();
      if (!tpl) { prev.innerHTML = '当前：<span class="mono-sm">P3 有人中了20次红包？主播直呼搞不懂</span>（默认）'; return; }
      const sample = ['有人中了20次红包？主播直呼搞不懂', '主播漏看前辈弹幕连声道歉：我眼神真不行'];
      const out = sample.map((t, i) => renderPartTitleClient(tpl, { n: i + 3, title: t, anchor: '甲主播', date: '2026-09-20', mainTitle: '已进入后半夜后悔时代 2026-09-20', kind: '切片' }));
      const bad = /\{[a-zA-Z]+\}/.test(out.join(''));
      prev.innerHTML = `预览：<span class="mono-sm">${out.map((x) => esc(x)).join('<br>')}</span>` +
        (bad ? ' <span style="color:#c8811a">⚠ 有变量没被替换 —— 检查拼写（可用 {n} {title} {anchor} {date} {mainTitle} {kind}）</span>' : '');
    };
    if (el) { el.oninput = render; render(); }
  }
  { const ab = $('#btnAuditCurrent'); if (ab) ab.onclick = () => {
    const t = state.tasks[0];
    if (!t) { toast('还没有任务'); return; }
    closeCfg();
    state.activeId = t.id;
    loadDetail().then(() => {
      const btn = document.querySelector('[data-act="publish-audit"]');
      if (btn) btn.click(); else toast('请在该场任务详情页点「投稿体检」');
    }).catch((e) => toast(e.message));
  }; }

  // MCP 接口：把端点、token 与可直接粘贴的接入命令摊给用户
  // 为什么必须做成界面：token 在 config.json 里，让用户自己去翻文件再拼命令，等于没做这个功能。
  { const mb = $('#btnMcp'); if (mb) mb.onclick = async () => {
    try {
      const r = await api('/api/mcp');
      const cmd = (id, label, text) => `
        <div style="margin-top:10px"><div style="font-size:12px;color:var(--text-3);margin-bottom:4px">${label}</div>
        <pre class="raw" style="white-space:pre-wrap;word-break:break-all;cursor:pointer" data-copy="${esc(text)}" title="点击复制">${esc(text)}</pre></div>`;
      openInfo('MCP 接口（Agent 接入）', `
        <p style="font-size:13px">状态：${r.enabled
          ? (r.paired ? '<b style="color:#2a7">已启用，已配对</b>' : '<b style="color:#c8811a">已启用，但还没生成 token（重启服务会自动生成）</b>')
          : '<b style="color:#c33">未启用</b>（config.json 里把 mcp.enabled 设为 true，重启后生效）'}<br>
        端点：<span class="mono-sm">${esc(r.endpoint)}</span>　共 <b>${r.toolCount}</b> 个工具（其中只读 <b>${r.readOnlyToolCount}</b> 个）</p>
        <h4 style="margin-top:14px">接入命令（点击代码块即复制）</h4>
        ${cmd('claude', 'Claude Code', r.commands.claudeCode)}
        ${cmd('codex', 'Codex', r.commands.codex)}
        ${cmd('cursor', 'Cursor（~/.cursor/mcp.json 里的片段）', r.commands.cursorJson)}
        ${cmd('curl', '动手验证（列出所有工具）', r.commands.curl)}
        <h4 style="margin-top:14px">安全边界</h4>
        <ul style="font-size:12.5px;color:var(--text-2);padding-left:18px;line-height:1.7">
          ${r.safety.map((s) => `<li>${esc(s)}</li>`).join('')}
        </ul>
        <h4 style="margin-top:14px">Agent 能做什么</h4>
        <p style="font-size:12.5px;color:var(--text-2);line-height:1.7">
        可以直接对它说：「现在有什么任务在跑」「<span class="mono-sm">manual-xxx</span> 这场为什么没出片」「把这场从 ANALYZED 重跑」
        「我新录的那场怎么没导入」「取消删源录播」「这场跑一次投稿体检」。</p>`);
      $$('#infoBody [data-copy]').forEach((el) => (el.onclick = () => {
        const text = el.dataset.copy || '';
        void navigator.clipboard?.writeText(text).then(
          () => toast('已复制到剪贴板'),
          () => toast('复制失败，请手动选中复制', 4000),
        );
      }));
    } catch (e) { toast('读取 MCP 信息失败：' + e.message, 5000); }
  }; }

  tgl('#c_fullVideoHasDanmaku', (on, el) => el.nextElementSibling.textContent = on ? '是（切片时不再传 ASS，避免叠双层弹幕）' : '否（切片时传入整场 ASS）');
  tgl('#c_recordDecisions', (on, el) => el.nextElementSibling.textContent = on ? '开启（记录你的勾选与取消，用于观察 LLM 的偏好偏差）' : '关闭（无法分析选片偏好）');
  tgl('#c_isOnlySelf', (on, el) => el.nextElementSibling.textContent = on ? '开启' : '关闭（公开可见）');
  tgl('#c_autoPublish', (on, el) => el.nextElementSibling.textContent = on ? '全自动（分析完直接排期发布）' : '半自动（需确认后发布）');
  tgl('#c_immediatePublish', (on, el) => {
    el.nextElementSibling.textContent = on ? '开启 —— 稿件过审后直接公开' : '关闭 —— 按公式定时发布';
    const hint = document.getElementById('hintImmediate');
    if (hint) {
      hint.className = on ? 'hintline warn' : 'hintline';
      hint.textContent = on
        ? '⚠️ 投稿不带 dtime，稿件过审即公开。这会绕过任务书硬约束 #4（dtime > 提交后 7200 秒）—— 该约束是防风控的自律措施，不是 B站规则。试跑期建议关闭。'
        : 'B站只在「传了 dtime」时才要求它 ≥ 提交后 2 小时；本模式满足硬约束 #4。';
    }
  });
  { const h = document.getElementById('hintImmediate'); if (h) h.textContent = 'B站只在「传了 dtime」时才要求它 ≥ 提交后 2 小时；本模式满足硬约束 #4。'; }
  tgl('#c_multiPart', (on, el) => {
    el.nextElementSibling.textContent = on ? '开启 —— 省额度，但各分P同一时刻发布' : '关闭 —— 每片一稿，可错峰但费额度';
    const hint = document.getElementById('hintMultiPart');
    if (hint) {
      hint.className = 'hintline';
      hint.textContent = on
        ? '结构为 2+N 个分P（完整版/纯享版/各切片），一次投稿只占 1 个每日额度；代价是多P稿件只有一个 dtime，相邻错峰间隔不再生效。'
        : '每个切片单独投一个稿件，可按 clipGapSec 错峰，但每片占 1 个每日额度。';
    }
  });
  { const h = document.getElementById('hintMultiPart'); if (h) h.textContent = (state.bootstrap.config.publish.multiPart ? '结构为 2+N 个分P（完整版/纯享版/各切片），一次投稿只占 1 个每日额度；代价是多P稿件只有一个 dtime，相邻错峰间隔不再生效。' : '每个切片单独投一个稿件，可按 clipGapSec 错峰，但每片占 1 个每日额度。'); }
  tgl('#c_deleteRaw', (on, el) => el.nextElementSibling.textContent = on ? '开启（省空间）' : '关闭');
  tgl('#c_keepOnFail', (on, el) => el.nextElementSibling.textContent = on ? '开启（便于重跑）' : '关闭');
  $$('#c_channels .chip').forEach((ch) => ch.onclick = () => ch.classList.toggle('on'));
  $$('#c_events .chip').forEach((ch) => ch.onclick = () => ch.classList.toggle('on'));
  const gap = $('#c_submitGapSec');
  gap.oninput = () => {
    const v = Number(gap.value);
    const el = $('#hintGap');
    if (!(v > 7200)) {
      el.className = 'hintline warn';
      el.textContent = `B站要求定时发布必须晚于该稿件提交时刻 7200 秒，${v} 秒会导致投稿被拒（陷阱 #12）`;
    } else {
      el.className = 'hintline ok';
      el.textContent = `✓ 合规（> 7200 秒）`;
    }
  };
}

/**
 * 把术语表两个输入框的内容整理成数组。
 * 一行一个，忽略空行与以 # 开头的注释行。
 */
function linesOf(id) {
  const el = document.getElementById(id);
  if (!el) return [];
  return String(el.value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

/**
 * 解析纠错规则输入框：每行 `错→对`，正则加 `re:` 前缀。
 *
 * 分隔符接受 `→`、`->`、`=>`（用户从别处粘贴时三种都可能出现）。
 * 认不出来的行会被收集起来提示，而不是静默丢弃 —— 静默丢弃会让人以为规则生效了。
 */
function parseReplacementLines(text) {
  const out = [];
  const bad = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(re:)?([\s\S]*?)\s*(?:→|->|=>)\s*([\s\S]*)$/.exec(line);
    if (!m) { bad.push(line); continue; }
    const from = m[2].trim();
    const to = m[3].trim();
    if (!from) { bad.push(line); continue; }
    out.push({ from, to, ...(m[1] ? { regex: true } : {}) });
  }
  return { out, bad };
}

/** 当前表单里的热词（术语 + 主播名），用于「复制热词」 */
function hotWordsFromForm() {
  const all = [...linesOf('c_glossaryAnchors'), ...linesOf('c_glossaryTerms')];
  return { perLine: all.join('\n'), commaSeparated: all.join('，') };
}

/**
 * 分P 标题模板的前端渲染（与服务端 `renderPartTitle` 同一套规则）。
 *
 * 为什么在前端也实现一份：模板是用户在输入框里现敲的，必须**边敲边看**。
 * 为了不让两份实现漂移，这里只支持同样的 6 个变量，未知变量原样保留并给出警告
 * （服务端行为一致：未知变量不替换）。
 */
function renderPartTitleClient(template, vars) {
  const map = { n: vars.n, title: vars.title, anchor: vars.anchor, date: vars.date, mainTitle: vars.mainTitle, kind: vars.kind };
  return String(template || 'P{n} {title}')
    .replace(/\{(n|title|anchor|date|mainTitle|kind)\}/g, (_, k) => String(map[k] ?? ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function saveCfg(force) {
  const btn = $('#btnSaveCfg');
  btn.disabled = true; btn.textContent = '保存中…';
  const val = (id) => { const el = $(id); return el ? el.value : ''; };
  const num = (id) => Number(val(id));
  const on = (id) => $(id).classList.contains('on');
  const patch = {
    bililive: { baseUrl: val('#c_baseUrl'), ...(val('#c_passKey') ? { passKey: val('#c_passKey') } : {}) },
    room: {
      roomId: val('#c_roomId'),
      pollIntervalSec: num('#c_pollIntervalSec'),
      offlineConfirmSec: num('#c_offlineConfirmSec'),
      reconcileIntervalMin: num('#c_reconcileIntervalMin'),
    },
    recorder: { type: val('#c_recorderType') },
    clip: {
      maxCandidates: num('#c_maxCandidates'),
      autoSelectScoreFloor: num('#c_autoSelectScoreFloor'),
      minDurationSec: num('#c_minDurationSec'),
      maxDurationSec: num('#c_maxDurationSec'),
      bufferSec: num('#c_bufferSec'),
      burnDanmaku: on('#c_burnDanmaku'),
      burnSubtitles: on('#c_burnSubtitles'),
      subtitle: {
        fontSize: num('#c_subtitleFontSize'),
        maxCharsPerLine: num('#c_subtitleMaxChars'),
        minDurationSec: num('#c_subtitleMinDur'),
      },
      fullVideoHasDanmaku: on('#c_fullVideoHasDanmaku'),
      ffmpegPresetId: val('#c_ffmpegPresetId'),
      ffmpegOptionsOverride: (() => { try { return JSON.parse(val('#c_ffmpegOptionsOverride') || '{}'); } catch { return null; } })(),
    },
    asr: {
      provider: val('#c_asrProvider'),
      segmentMinutes: num('#c_asrSegmentMinutes'),
      unitPricePerHour: num('#c_asrPrice'),
      inputSource: val('#c_asrInputSource'),
      /* 边录边转写（P1-6）：这一项改的是"录制监听 + 转写阶段消费"两条腿，
         必须真的存下去（漏了就成了"界面上看着开着、其实没生效"）。改完需重启服务。 */
      incrementalEnabled: on('#c_incrementalEnabled'),
      localFunasr: {
        pythonPath: val('#c_funasrPython'),
        device: val('#c_funasrDevice'),
        engine: val('#c_funasrEngine'),
        maxCharsPerCue: num('#c_funasrMaxChars'),
        timestamps: on('#c_funasrTimestamps'),
        /* 这两项必须一起回写：界面的 patch 是**部分字段**深合并，
           漏掉就等于"界面上看着还开着、存下去却丢了"，用户下次看配置会发现它自己关了。 */
        hotwordsEnabled: on('#c_funasrHotwords'),
        hotwordsMax: num('#c_funasrHotwordsMax'),
      },
    },
    llm: {
      preset: val('#c_llmPreset'),
      summary: { baseUrl: val('#c_llmUrl'), model: val('#c_llmModel'), ...(val('#c_llmKey') ? { apiKey: val('#c_llmKey') } : {}) },
      select: { model: val('#c_llmSelectModel'), baseUrl: val('#c_llmUrl'), ...(val('#c_llmKey') ? { apiKey: val('#c_llmKey') } : {}) },
      chunkMinutes: num('#c_chunkMinutes'),
      chunkConcurrency: num('#c_chunkConcurrency'),
    },
    publish: {
      submitGapSec: num('#c_submitGapSec'),
      firstPublishAt: val('#c_firstPublishAt'),
      clipGapSec: num('#c_clipGapSec'),
      jitterSec: num('#c_jitterSec'),
      dailyLimit: num('#c_dailyLimit'),
      partTitleTemplate: val('#c_partTitleTemplate').trim(),
      isOnlySelf: on('#c_isOnlySelf') ? 1 : 0,
      autoPublish: on('#c_autoPublish'),
      immediatePublish: on('#c_immediatePublish'),
      multiPart: on('#c_multiPart'),
      fullVideoBy: val('#c_fullVideoBy') === 'assistant' ? 'assistant' : 'bililive-tools',
      resumeWaitMin: Math.max(1, Number(val('#c_resumeWaitMin')) || 90),
      seasonId: Number(val('#c_seasonId')) || 0,
      defaultCategory: val('#c_defaultCategory'),
      defaultTags: val('#c_defaultTags').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      descTemplate: val('#c_descTemplate'),
      aiNotice: val('#c_aiNotice').trim(),
      coverSource: val('#c_coverSource'),
      defaultCover: val('#c_defaultCover'),
      creationStatement: Number(val('#c_creationStatement')),
      copyright: Number(val('#c_copyright')),
    },
    cleanup: {
      retentionDays: num('#c_retentionDays'),
      /* 回收站保留天数（用户 2026-10-11 要求「添加只保留几天的设置 超长时间的自动删除」）：
         服务端每日检查按它清理过期条目；界面上「回收站」页的到期提示也读同一个值。 */
      trashDays: Math.max(0, Math.round(num('#c_trashDays')) || 0),
      diskFloorGB: num('#c_diskFloorGB'),
      deleteRawAfterTranscribe: on('#c_deleteRaw'),
      keepFullVideoOnFailure: on('#c_keepOnFail'),
    },
    alert: {
      channels: $$('#c_channels .chip.on').map((c) => c.dataset.ch),
      events: Object.fromEntries($$('#c_events .chip').map((c) => [c.dataset.ev, c.classList.contains('on')])),
      accountExpireWarnDays: num('#c_accountWarn'),
      dedupeWindowSec: num('#c_dedupe'),
      serverchan: { sendKey: val('#c_scKey') },
      dingtalk: { webhook: val('#c_dtWebhook'), secret: val('#c_dtSecret') },
      telegram: { botToken: val('#c_tgToken'), chatId: val('#c_tgChat') },
    },
    runtime: { logLevel: val('#c_logLevel'), logKeepDays: num('#c_logKeepDays'), recordDecisions: on('#c_recordDecisions') },
  };
  try {
    // 术语表走自己的接口（独立文件、独立校验），与配置一起保存：
    // 同一个「保存配置」按钮，用户不用记住两处要分别保存。
    const replParsed = parseReplacementLines(val('#c_glossaryRepl'));
    if (replParsed.bad.length) {
      toast(`有 ${replParsed.bad.length} 行纠错规则看不懂（需要写成 错→对）：${replParsed.bad.slice(0, 2).join(' / ')}`, 7000);
      btn.disabled = false; btn.textContent = '保存配置';
      return;
    }
    const gr = await api('/api/glossary', {
      method: 'PUT',
      body: {
        anchors: linesOf('c_glossaryAnchors'),
        terms: linesOf('c_glossaryTerms'),
        replacements: replParsed.out,
      },
    });
    if (gr && gr.ok === false) {
      const bad = (gr.issues || []).filter((i) => i.level === 'error').map((i) => i.message);
      toast(`术语表未保存：${bad.join('；')}`, 7000);
    }

    const r = await api('/api/config', {
      method: 'POST',
      body: { patch, ...(force ? { force: true } : { configVersion: state.bootstrap && state.bootstrap.configVersion }) },
    });
    if (r.configVersion) { state.bootstrap = { ...(state.bootstrap || {}), configVersion: r.configVersion }; }
    const errs = (r.issues || []).filter((i) => i.level === 'error');
    const warns = (r.issues || []).filter((i) => i.level === 'warn');
    $('#cfgIssues').innerHTML = errs.length
      ? `<span style="color:#c33">${errs.length} 项硬约束错误</span>`
      : warns.length ? `<span style="color:#c8811a">${warns.length} 项提醒</span>` : '<span style="color:var(--green)">配置合法</span>';
    if (errs.length) {
      openInfo('配置存在硬约束错误', `<div class="timeline">${r.issues.map((i) => `<div class="row ${i.level === 'error' ? 'bad' : ''}">
        <span class="t">${i.level === 'error' ? '✗' : '⚠'}</span><span class="s"><b>${esc(i.field)}</b><br>${esc(i.message)}${i.fix ? `<br><span style="color:#c8811a">修复：${esc(i.fix)}</span>` : ''}</span></div>`).join('')}</div>`);
      toast('配置已保存但存在硬约束错误，请修正', 5000);
    } else {
      toast(r.note || '配置已保存并热加载');
      await loadBootstrap();
      closeCfg();
    }
  } catch (e) {
    const c = e.payload && e.payload.conflict;
    if (e.status === 409 && c) {
      /* 乐观锁冲突：磁盘上的配置在设置面板打开之后被别处改过。
         绝不能静默覆盖 —— 把「谁被改过」「保存会覆盖掉什么」摊开给用户选。 */
      const list = (arr, empty) => (arr && arr.length)
        ? arr.map((p) => `<code>${esc(p)}</code>`).join('、')
        : `<span style="color:var(--text-3)">${empty}</span>`;
      openInfo('配置已被其它程序修改', `
        <p>设置面板打开之后，<b>config.json 被别处改过</b>，本次<b>没有写入任何内容</b>。</p>
        <div class="timeline">
          <div class="row"><span class="t">·</span><span class="s"><b>外部改动的字段</b><br>${list(c.changedByOthers, '（版本号变了但字段值相同，可能只是格式差异）')}</span></div>
          <div class="row ${c.wouldOverwrite && c.wouldOverwrite.length ? 'bad' : ''}"><span class="t">${c.wouldOverwrite && c.wouldOverwrite.length ? '!' : '·'}</span><span class="s"><b>继续保存会覆盖掉的字段</b><br>${list(c.wouldOverwrite, '（无 —— 界面上的值与磁盘一致，重新加载后重试即可）')}</span></div>
        </div>
        <p style="color:var(--text-3)">磁盘版本 <code>${esc(c.actual)}</code> · 界面版本 <code>${esc(c.expected)}</code></p>
        <p><b>推荐「重新加载」</b>：把外部改动读进表单，确认无误后再保存。只有当你确定要以界面为准时才用「强制覆盖」。</p>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn-sm" data-cfgfix="reload">重新加载（推荐）</button>
          <button class="btn-sm" data-cfgfix="force">强制覆盖（以界面为准）</button>
        </div>`, c.hint);
      $$('#infoBody [data-cfgfix]').forEach((b) => (b.onclick = async () => {
        closeInfo();
        if (b.dataset.cfgfix === 'reload') {
          await openCfg();
          toast('已重新加载最新配置，请确认后再次保存', 5000);
        } else {
          await saveCfg(true);
        }
      }));
    } else {
      toast('保存失败：' + e.message, 5000);
    }
  }
  btn.disabled = false; btn.textContent = '保存配置';
}

function closeCfg() { $('#cfgMask').classList.remove('show'); }
window.closeCfg = closeCfg;

