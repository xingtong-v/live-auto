/**
 * 「跑完自动关机」独立页面的**真浏览器验证**（Edge headless + CDP，复用 tools/ui-shared.ts）。
 *
 * 为什么必须有它（2026-10-14 实测事故）：卡片写完我只看了静态断言（HTML 里有那几行字），
 * 而真实的失败长这样 —— `渲染失败：Cannot read properties of undefined (reading 'enabled')`：
 *   · `api()` 返回的是**数据本身**（31-基础.js `return data`），我却按 `{res,data}` 取了 `r.data`；
 *   · `toast(msg, 'err')` 把"毫秒"参数传成了字符串 → 提示 0ms 消失（用户以为"点了没反应"）。
 * 这两类错误**静态断言一个都抓不到**：必须真把页面跑起来、点一下、再读 DOM、看数字有没有变。
 *
 * 【2026-10-17 重定向】原来这个脚本验的是「运行观测」页里那张内联卡片（#sdOn/#sdBadge/#sdState/#sdCount）。
 * 那张卡片在 2026-10-14 就被**独立页面**（/api/shutdown/page + iframe）取代、代码已删，
 * 于是本脚本一直在验一堆不存在的元素 —— 留着只会撒谎。改成验真正的那个页面。
 *
 * 它盯的是三个**只有真浏览器才暴露**的问题（都是实测踩出来的）：
 *   ① iframe 高度写死 ⇒ 底部"时段/冷静期/倒计时/保存"整行被切在切口外（用户截图那一刀）；
 *   ② 内页写死浅色 ⇒ 主界面切深色后整个 iframe 是一块白板；
 *   ③ 条件条数写死"六条" ⇒ 服务端实际发 7 条，标题在撒谎。
 */
import { clickReal, launchBrowser, ok, report, section, sleep } from './ui-shared.ts';

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:3000';
const PORT = 9237;

const { cdp, close } = await launchBrowser({ port: PORT, windowSize: '1600,1000' });

const evaluate = async <T>(expression: string): Promise<T> => {
  const r = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string };
  };
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'JS 异常');
  return r.result?.value as T;
};

/** 进入「自动关机」页签并等 iframe 把首屏状态画完 */
const openTab = async (theme: 'dark' | 'light'): Promise<void> => {
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);
  await evaluate(`try{localStorage.setItem('liveauto.theme',${JSON.stringify(theme)})}catch(e){};location.reload()`);
  await sleep(3000);
  const clicked = await clickReal(cdp, '.tab[data-view="autoshutdown"]').catch(() => false);
  if (!clicked) {
    await evaluate(`(() => { const t = document.querySelector('.tab[data-view="autoshutdown"]'); if (t) t.click(); })()`);
  }
  await sleep(2600);
};

/** 量 iframe 里那一页的真实几何与配色（同源，父页面能直接读 contentDocument） */
const measure = () =>
  evaluate<{
    theme: string | null;
    iframeH: number;
    innerBodyH: number;
    overflow: number;
    lastBottom: number;
    innerClientH: number;
    bodyBg: string;
    cardBg: string;
    gateTitle: string;
    gateRows: number;
    cdDisplay: string;
    progDisplay: string;
    badge: string;
  }>(`(() => {
    const f = document.querySelector('#sdFrame');
    if (!f) return null;
    const d = f.contentDocument;
    const cs = (el, p) => (el ? getComputedStyle(el)[p] : '');
    const card = d.querySelector('.card');
    const sect = d.querySelector('.sect');
    const r = sect ? sect.getBoundingClientRect() : null;
    return {
      theme: d.documentElement.getAttribute('data-theme'),
      iframeH: Math.round(f.getBoundingClientRect().height),
      innerBodyH: Math.ceil(d.body.getBoundingClientRect().height),
      overflow: d.documentElement.scrollHeight - d.documentElement.clientHeight,
      lastBottom: r ? Math.round(r.bottom) : -1,
      innerClientH: d.documentElement.clientHeight,
      bodyBg: cs(d.body, 'backgroundColor'),
      cardBg: cs(card, 'backgroundColor'),
      gateTitle: (d.querySelector('#gateTitle') || {}).textContent || '',
      gateRows: d.querySelectorAll('.gate').length,
      cdDisplay: cs(d.querySelector('#cd'), 'display'),
      progDisplay: cs(d.querySelector('#prog'), 'display'),
      badge: (d.querySelector('#badge') || {}).textContent || '',
    };
  })()`);

try {
  section('④ 跑完自动关机（独立页面）：真浏览器验证');

  /* 用户原本选的主题（本脚本会来回切，结束时按原样还原） */
  const origTheme = await evaluate<string | null>(`(() => { try { return localStorage.getItem('liveauto.theme'); } catch (e) { return null; } })()`);

  /* ---- 深色 ---- */
  await openTab('dark');
  const dark = await measure();
  ok('★ iframe 里的那一页真的渲染出来了（#sdFrame 有内容）', !!dark && dark.gateRows > 0, JSON.stringify(dark)?.slice(0, 120));
  if (dark) {
    ok('★ 徽标是「已打开/已关闭」，不是「读取中…」', /已打开|已关闭/.test(dark.badge), dark.badge);
    ok('★★ 内页跟随主界面深色（body 不再是浅色 #f6f7f9）', dark.bodyBg !== 'rgb(246, 247, 249)', `bodyBg=${dark.bodyBg} cardBg=${dark.cardBg}`);
    ok('★★ 底部参数行没被切掉（整页无内部溢出）', dark.overflow <= 0, `overflow=${dark.overflow} 底部=${dark.lastBottom}/${dark.innerClientH}`);
    ok('★★ iframe 高度跟着内容自适应（不是写死的 620）', dark.iframeH >= dark.innerBodyH - 1, `iframeH=${dark.iframeH} 内容高=${dark.innerBodyH}`);
    const n = Number((dark.gateTitle.match(/(\d+)\s*项/) || [])[1]);
    ok('★ 标题里的条目数 = 实际渲染行数（"六条"那种写死文案会在这里露馅）', n === dark.gateRows, `标题="${dark.gateTitle}" 行数=${dark.gateRows}`);
    /* 关闭态下：空进度槽 + 重复的"已关闭"大字都应收起 */
    if (dark.badge.includes('已关闭')) {
      ok('★ 关闭态收起进度槽与大字（不占位、不重复说同一件事）', dark.cdDisplay === 'none' && dark.progDisplay === 'none', `#cd=${dark.cdDisplay} #prog=${dark.progDisplay}`);
    }
  }

  /* ---- 主题动态跟随：主界面切换，内页不刷新就跟上 ---- */
  await evaluate(`try{localStorage.setItem('liveauto.theme','light')}catch(e){}`);
  await sleep(1200);
  const followed = await evaluate<string | null>(`(() => { const f = document.querySelector('#sdFrame'); return f && f.contentDocument ? f.contentDocument.documentElement.getAttribute('data-theme') : null; })()`);
  ok('★★ 主界面切浅色后内页**不刷新**就跟上（storage 事件）', followed === 'light', String(followed));

  /* ---- 浅色 ---- */
  await openTab('light');
  const light = await measure();
  if (light) {
    ok('★ 浅色下内页也是浅色（两套主题都正常）', light.bodyBg === 'rgb(244, 246, 248)', `bodyBg=${light.bodyBg}`);
    ok('★ 浅色下同样没有内部溢出（底部不被切）', light.overflow <= 0, `overflow=${light.overflow}`);
  }

  /* 收尾：把主题恢复成用户原来的选择（别留下"我改过你的主题"） */
  await evaluate(origTheme ? `try{localStorage.setItem('liveauto.theme',${JSON.stringify(origTheme)})}catch(e){}` : `try{localStorage.removeItem('liveauto.theme')}catch(e){}`);
} catch (e) {
  ok('验证过程本身没抛错', false, (e as Error).message);
} finally {
  await close();
}

await report();
