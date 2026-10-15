/**
 * 「自动关机」独立页签（iframe）的真浏览器验证（Edge headless + CDP，复用 tools/ui-shared.ts）。
 *
 * 为什么要它：这个页签的全部价值就是"**不受其它页刷新影响、不抖**"——
 * 而这正是静态断言证明不了的：必须真的点开页签、看 iframe 有没有加载出来、
 * 里面那张卡片是不是活的、以及**切到其它页再切回来**还正常。
 */
import { clickReal, launchBrowser, ok, report, section, sleep } from './ui-shared.ts';

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:3000';
const PORT = 9238;
const { cdp, close } = await launchBrowser({ port: PORT, windowSize: '1500,1000' });

const evalJs = async <T>(expression: string): Promise<T> => {
  const r = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string };
  };
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'JS 异常');
  return r.result?.value as T;
};
const sleep2 = sleep;

try {
  await cdp.send('Page.navigate', { url: BASE });
  await sleep2(2500);

  section('「自动关机」页签（iframe 独立页面）');
  const hasTab = await evalJs<boolean>(`!!document.querySelector('#tabs .tab[data-view="autoshutdown"]')`);
  ok('★ 页签存在', hasTab === true);
  const order = await evalJs<string[]>(
    `[...document.querySelectorAll('#tabs .tab')].map(t=>t.dataset.view)`,
  );
  const iHealth = order.indexOf('health');
  const iAuto = order.indexOf('autoshutdown');
  ok('★ 位置在「健康面板」**后面**', iAuto === iHealth + 1, `health=${iHealth} autoshutdown=${iAuto} 顺序=${order.join(',')}`);

  await clickReal(cdp, '#tabs .tab[data-view="autoshutdown"]');
  await sleep2(2000);
  const hasFrame = await evalJs<boolean>(`!!document.querySelector('#sdFrame')`);
  ok('★ iframe 渲染出来了', hasFrame === true);

  /* iframe 内部的卡片（跨文档取）：徽标不该停在"读取中…" */
  const inner = await evalJs<string>(
    `(() => { const f=document.querySelector('#sdFrame'); const d=f && f.contentDocument; if(!d) return '(取不到 iframe 文档)'; const b=d.querySelector('#badge'); return b ? b.textContent : '(iframe 里没有 #badge)'; })()`,
  );
  ok('★ iframe 里的卡片是活的（徽标已打开/已关闭）', /已打开|已关闭/.test(inner), inner);

  /* 切到别的页再切回来：应当还在（结构只建一次） */
  await clickReal(cdp, '#tabs .tab[data-view="health"]');
  await sleep2(1200);
  await clickReal(cdp, '#tabs .tab[data-view="autoshutdown"]');
  await sleep2(1500);
  const back = await evalJs<boolean>(`!!document.querySelector('#sdFrame')`);
  ok('★ 切走再切回来仍在（不会白屏、不重复堆叠）', back === true);
  const frames = await evalJs<number>(`document.querySelectorAll('#sdFrame').length`);
  ok('★ 只有一个 iframe（不会每切一次堆一个）', frames === 1, String(frames));
} catch (e) {
  ok('验证过程本身没抛错', false, (e as Error).message);
} finally {
  await close();
}

await report();
