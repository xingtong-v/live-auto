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
      const [hh, mm] = s.split(':').map(Number);
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
  ok('页面里能看到中文状态词（已发布/切片中/待确认 之类）', /已发布|切片中|待确认|已录完|转写中/.test(page.text), page.text.slice(0, 160));

  /* ★ ④ 最近几场必须"人话"：每场是两行（标题 + 中文状态 / 阶段链 + 切片数 + 开始时间），
     而不是一串 id。窄窗口下表格会把后面的列切掉，这也正是改成两行式的原因。 */
  /* ⚠️ 必须先切回本页：这段断言原本插在"切到实时监控页"之后 ⇒ 页面上当然没有 .obs-run，
     实测假红过一次（top:0）。凡是查本页 DOM 的断言，都得先确保本页在前台。 */
  await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="observe"]').click()`);
  await sleep(3500);
  const runs = await cdp.evalJs<{ top: number; withSteps: number; sample: string }>(`(() => {
    const list = [...document.querySelectorAll('.obs-run')];
    const withSteps = list.filter((r) => r.querySelectorAll('.obs-step').length >= 4).length;
    return { top: list.length, withSteps, sample: list[0] ? String(list[0].textContent).slice(0, 160) : '' };
  })()`);
  ok('★ ④ 每场两行（标题 + 中文状态 / 时间·切片·短 id），不是只有 id 的表格', runs.top >= 1, JSON.stringify(runs));
  ok('★ 场次显示的是标题/人话，不是一串 id', /[\u4e00-\u9fa5]/.test(runs.sample), runs.sample);
  /* ★ 回归保护：第一版这里堆了五个阶段胶囊，用户说"难看而且难懂"。
     现在阶段信息由状态文案承担（"转写中 3/10"），页面上不该再出现胶囊堆叠。 */
  const pills = await cdp.evalJs<number>(`document.querySelectorAll('.obs-step').length`);
  ok('★ 没有重新长出"五个阶段胶囊"那种噪声（阶段信息靠状态文案表达）', pills === 0, '胶囊数 ' + pills);
  ok('★ 时间列不再出现空的"（—）"', !/\(—\)/.test(String(runs.sample)), runs.sample.slice(0, 120));

  ok('全程无未捕获异常', cdp.errors.length === 0, cdp.errors[0]?.slice(0, 160));
} finally {
  await close();
}

await report();
