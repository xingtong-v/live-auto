/**
 * 「跑完自动关机」卡片的**真浏览器验证**（Edge headless + CDP，复用 tools/ui-shared.ts）。
 *
 * 为什么必须有它（2026-10-14 实测事故）：卡片写完我只看了静态断言（HTML 里有那几行字），
 * 而真实的失败长这样 —— `渲染失败：Cannot read properties of undefined (reading 'enabled')`：
 *   · `api()` 返回的是**数据本身**（31-基础.js `return data`），我却按 `{res,data}` 取了 `r.data`；
 *   · `toast(msg, 'err')` 把"毫秒"参数传成了字符串 → 提示 0ms 消失（用户以为"点了没反应"）。
 * 这两类错误**静态断言一个都抓不到**：必须真把页面跑起来、点一下、再读 DOM、看数字有没有变。
 */
import { clickReal, launchBrowser, ok, report, section, sleep } from './ui-shared.ts';

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:3000';
const PORT = 9237;

const { cdp, close } = await launchBrowser({ port: PORT, windowSize: '1500,1000' });

const evaluate = async <T>(expression: string): Promise<T> => {
  const r = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string };
  };
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'JS 异常');
  return r.result?.value as T;
};
const text = async (sel: string): Promise<string> => String((await evaluate<string>(`(document.querySelector('${sel}')||{}).textContent||''`)) ?? '');

try {
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);
  /* 切到「运行观测」页签（找不到就直接说，别静默） */
  const clicked = await clickReal(cdp, 'text=运行观测').catch(() => false);
  if (!clicked) {
    await evaluate(`(() => { const t=[...document.querySelectorAll('button,div,span,a')].find(x=>x.textContent.trim()==='运行观测'); if(t) t.click(); })()`);
  }
  await sleep(2000);

  section('④ 跑完自动关机卡片：真浏览器验证');
  ok('卡片渲染出来了（#sdOn 存在）', (await evaluate<boolean>(`!!document.querySelector('#sdOn')`)) === true);

  const badge0 = await text('#sdBadge');
  ok('★ 徽标是「已打开/已关闭」，不是「读取中…」', /已打开|已关闭/.test(badge0), badge0);
  const state0 = await text('#sdState');
  ok('★ 状态行没有「渲染失败/读取状态失败」（api 返回值接对了）', !/失败/.test(state0), state0.slice(0, 140));

  /* 点「打开」→ 徽标应变「已打开」，倒计时行出现 mm:ss */
  await evaluate(`document.querySelector('#sdOn').click()`);
  await sleep(1500);
  const badge1 = await text('#sdBadge');
  ok('★ 点「打开」后徽标变「已打开」', badge1.includes('已打开'), badge1);
  const cnt1 = await text('#sdCount');
  ok('★ 倒计时行有内容（mm:ss 或"等待条件满足/已下发/冷静期已满"）', /等待条件满足|冷静期已满|已下发|\d\d:\d\d/.test(cnt1), cnt1.slice(0, 140));

  await sleep(2200);
  const cnt2 = await text('#sdCount');
  ok('★★ 倒计时**每秒在动**（2 秒后文字变了 —— 这就是"在不在跑"的直观感受）', cnt1 !== cnt2, `${cnt1.slice(0, 40)} → ${cnt2.slice(0, 40)}`);

  /* 关回去（收尾，绝不留一个"已打开"在用户机器上） */
  await evaluate(`document.querySelector('#sdOff').click()`);
  await sleep(1200);
  const badge2 = await text('#sdBadge');
  ok('★ 点「关闭」后变回「已关闭」（收尾不留隐患）', badge2.includes('已关闭'), badge2);
} catch (e) {
  ok('验证过程本身没抛错', false, (e as Error).message);
} finally {
  await close();
}

await report();
