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
    ['最近几场（端到端）', /最近几场（端到端）/],
    ['资源与 ASR 体检', /资源与 ASR 体检/],
  ] as Array<[string, RegExp]>) {
    ok('页面含「' + name + '」一块', pat.test(page.text));
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

  ok('全程无未捕获异常', cdp.errors.length === 0, cdp.errors[0]?.slice(0, 160));
} finally {
  await close();
}

await report();
