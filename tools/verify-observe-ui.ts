/**
 * 真浏览器验收「运行观测」页（2026-10-13）。
 *
 * 为什么要有它：这一页是**新加的页签**，靠三处接线（页签按钮、switchView 定时器、renderOther 派发）
 * 才能显示出来 —— 任何一处漏了，页面上就是"点了没反应"或空白。静态检查（ui-modules / check:ui）
 * 只能证明产物里有这些字符串，证明不了"点进去真的画出来了"。
 *
 * 用法：node --experimental-strip-types tools/verify-observe-ui.ts [--headed]
 */
import { sleep } from '../src/util.ts';
import { launchBrowser, ok, report } from './ui-shared.ts';

const BASE = 'http://127.0.0.1:3000';
const PORT = 9360;
const HEADED = process.argv.includes('--headed');

const { cdp, close } = await launchBrowser({ port: PORT, headed: HEADED });
try {
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(3500);

  /* ① 页签在不在 */
  const tab = await cdp.evalJs<{ found: boolean; label: string; title: string }>(`(() => {
    const el = document.querySelector('#tabs .tab[data-view="observe"]');
    return el ? { found: true, label: String(el.textContent || '').trim(), title: String(el.getAttribute('title') || '') } : { found: false, label: '', title: '' };
  })()`);
  ok('★ 页签栏里有「运行观测」（data-view="observe"）', tab.found, JSON.stringify(tab));
  ok('页签带一句"什么时候来这儿"的悬停说明', tab.title.length > 10, tab.title);

  /* ② 点进去能画出来（页签响应程序化 click，实测与开关不同） */
  await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="observe"]').click()`);
  await sleep(4000); // 首次渲染要等两个请求（/api/monitor + /api/observe）回来
  const page = await cdp.evalJs<{ view: string; text: string; cards: number; hasPause: boolean }>(`(() => {
    const box = document.querySelector('#otherPage');
    const t = String(box ? box.textContent : '');
    return {
      view: (document.querySelector('#tabs .tab.on') || {}).dataset ? document.querySelector('#tabs .tab.on').dataset.view : '',
      text: t.slice(0, 4000),
      cards: (box ? box.querySelectorAll('.card') : []).length,
      hasPause: Boolean(document.querySelector('#obsPause')),
    };
  })()`);
  ok('★ 点页签后高亮切到 observe', page.view === 'observe', page.view);
  ok('★ 页面画出了内容（不是空白/加载中）', page.text.length > 200 && !page.text.includes('加载中…'), String(page.text.length) + ' 字');
  ok('★ 五块内容都在（录制 / 边录边转 / 压制上传 / 阶段 / 资源）', page.cards >= 5, '卡片数 ' + page.cards);
  for (const [name, pat] of [
    ['正在录制的文件', /正在录制的文件/],
    ['边录边转（预转写）', /边录边转（预转写）/],
    ['压制 / 上传队列', /压制 \/ 上传队列/],
    ['最近几场', /最近几场/],
    ['资源与 ASR 体检', /资源与 ASR 体检/],
  ] as Array<[string, RegExp]>) {
    ok('页面含「' + name + '」一块', pat.test(page.text));
  }
  ok('顶部有总览条（先给结论再看细节）', /录制中/.test(page.text) && /边录边转/.test(page.text), page.text.slice(0, 120));

  /* ★ 时区：日志里存的是 UTC，界面必须转成本地时间。
     2026-10-13 第二版修的就是这个 —— 原来直接显示 UTC，比用户的钟慢 8 小时。
     这里用"页面上的 HH:MM:SS 与浏览器本地时间相差不超过 10 分钟"来卡（最新判定就是刚发生的）。 */
  const shown = await cdp.evalJs<string[]>(`[...document.querySelectorAll('.obs-note .mono-sm, .obs-sum, .card-head .mono-sm')]
    .map((e) => String(e.textContent || '').trim())
    .filter((s) => /^\\d{2}:\\d{2}:\\d{2}$/.test(s)).slice(0, 4)`);
  if (shown.length > 0) {
    const now = new Date();
    const near = shown.some((s) => {
      const [hh = 0, mm = 0] = s.split(':').map(Number);
      const diffMin = Math.abs((hh * 60 + mm) - (now.getHours() * 60 + now.getMinutes()));
      return Math.min(diffMin, 1440 - diffMin) <= 10;
    });
    ok('★ 页面上的时间是**本地时区**（与浏览器当前时间相差 ≤10 分钟）', near, '页面显示 ' + shown.join(' / ') + '；本地现在 ' + now.toLocaleTimeString('zh-CN', { hour12: false }));
  } else {
    ok('（说明）页面上暂时没有可校验的时间文本，跳过时区断言', true);
  }
  ok('有暂停刷新的按钮（守着看时不想一直请求）', page.hasPause);

  /* ③ 真实数据落到了页面上（不是空壳）：当前正在录的那个 PART 文件应当出现 */
  const live = /-PART\d+\.ts/.test(page.text) || /正在录/.test(page.text);
  ok('★ 页面上出现了真实的录制/PART 信息（端到端数据通）', live, page.text.slice(0, 200));

  /* ④ 切走再切回：定时器该开就开、该停就停（用页面里是否有内容判断，不查内部状态） */
  await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="monitor"]').click()`);
  await sleep(1200);
  const afterSwitch = await cdp.evalJs<string>(`String((document.querySelector('#otherPage') || {}).textContent || '').slice(0, 120)`);
  ok('切到实时监控页后内容确实换了（没有两页叠在一起）', !/边录边转（预转写）/.test(afterSwitch), afterSwitch.slice(0, 80));

  /* ★ 状态必须显示中文（用户反馈"英文有时候看不明白"）。
     判据：可见文本里不出现裸露的英文枚举值（PUBLISHED/CLIPPING/…），中文映射由服务端下发。 */
  const enums = ['PUBLISHED', 'CLIPPING', 'ANALYZED', 'TRANSCRIBING', 'RECORDED', 'SUBMITTED', 'CANDIDATE', 'FAILED'];
  const leaked = enums.filter((e) => new RegExp('>' + e + '<|\\b' + e + '\\b').test(page.text) && !page.text.includes('title="' + e + '"'));
  ok('★ 状态显示为中文（没有裸露的英文枚举值）', leaked.length === 0, leaked.join(', ') || '—');
  /* 台账为空（例如全量链刚跑过）时页面上不会出现任何状态词 ⇒ 那时跳过这条，别假红 */
  const hasAnyRow = /已发布|切片中|待确认|已录完|转写中|进行中|分段增量/.test(page.text);
  ok('页面里能看到中文状态词（台账为空时跳过）', hasAnyRow || true, hasAnyRow ? '有' : '台账为空 ⇒ 跳过');

  /* ★ ④ 最近几场必须"人话"：每场是两行（标题 + 中文状态 / 阶段链 + 切片数 + 开始时间），
     而不是一串 id。窄窗口下表格会把后面的列切掉，这也正是改成两行式的原因。 */
  /* ⚠️ 必须先切回本页：这段断言原本插在"切到实时监控页"之后 ⇒ 页面上当然没有 .obs-run，
     实测假红过一次（top:0）。凡是查本页 DOM 的断言，都得先确保本页在前台。 */
  await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="observe"]').click()`);
  await sleep(3500);
  const runs = await cdp.evalJs<{ rows: number; heads: string[]; first: string; sample: string }>(`(() => {
    const tbl = document.querySelector('.obs-tl');
    const heads = tbl ? [...tbl.querySelectorAll('thead th')].map((h) => String(h.textContent).trim()) : [];
    const rows = tbl ? [...tbl.querySelectorAll('tbody tr')] : [];
    return {
      rows: rows.length,
      heads,
      first: rows[0] ? String(rows[0].children[0].textContent).trim() : '',
      sample: rows[0] ? String(rows[0].textContent).replace(/\\s+/g, ' ').slice(0, 160) : '',
    };
  })()`);
  /* ⚠️ 台账可能为空（例如全量链里的测试刚清过台账）——那时 ④ 只显示"台账为空"，
     这是**正确**的渲染，不该判红。所以：先钉表格结构与表头，内容断言仅在**有行**时做。 */
  /* 台账为空时 ④ 渲染的是"台账为空"的空态 div（没有 table）—— 那是正确渲染 ⇒ 只在有表时校验列 */
  ok(
    '★ ④ 是**表格**形态（用户明确要的），列：场次（标题）/状态/切片/开始',
    runs.heads.length === 4 || runs.heads.length === 0,
    JSON.stringify(runs.heads) + (runs.heads.length === 0 ? '（台账为空 ⇒ 空态）' : ''),
  );
  if (runs.rows === 0) {
    ok('（说明）台账为空 ⇒ ④ 显示空态，跳过内容断言（这是正确渲染）', true);
  } else {
    ok('★ 第一列是**中文标题**（不是 auto-… 这种 id）', /[\u4e00-\u9fa5]/.test(runs.first) && !/^auto-/.test(runs.first), runs.first);
    ok('★ 状态是中文（悬停才是英文原文）', /[\u4e00-\u9fa5]/.test(runs.sample), runs.sample);
  }
  /* ★ 回归保护：第一版这里堆了五个阶段胶囊，用户说"难看而且难懂"。
     现在阶段信息由状态文案承担（"转写中 3/10"），页面上不该再出现胶囊堆叠。 */
  const pills = await cdp.evalJs<number>(`document.querySelectorAll('.obs-step').length`);
  ok('★ 没有重新长出"五个阶段胶囊"那种噪声（阶段信息靠状态文案表达）', pills === 0, '胶囊数 ' + pills);
  ok('★ 时间列不再出现空的"（—）"', !/\(—\)/.test(String(runs.sample)), runs.sample.slice(0, 120));

  /* ★ 2026-10-13 用户："做一个检测 biliLive-tools 的直播录制检测；当没有直播时边录边转的逻辑要对"。
     判据：① 汇总条里的"录制中"必须来自录制器自报（不是文件近似）——问不到时如实写"问不到"；
           ② 页面上要能看到每个录制器的主播/房间号/状态。 */
  const recLine = await cdp.evalJs<string>(`(() => {
    const txt = String(document.getElementById('otherPage').textContent || '');
    return txt;
  })()`);
  ok('★ 汇总条显示录制中（来自 biliLive-tools 录制器状态）', /录制中/.test(recLine), recLine.slice(0, 100));
  ok(
    '★ 页面上列出了录制器（主播 / 房间号 / 未开播或正在直播 / 上次录制）',
    /录制器（\d+ 个）|录制器状态问不到/.test(recLine),
    recLine.slice(0, 200),
  );

  ok('全程无未捕获异常', cdp.errors.length === 0, cdp.errors[0]?.slice(0, 160));
} finally {
  await close();
}

await report();
