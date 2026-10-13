/** 真机验收：设置面板「从 biliLive-tools 读取」房间号按钮（2026-10-13） */
import { sleep } from '../src/util.ts';
import { launchBrowser, ok, report } from './ui-shared.ts';

const PORT = 9382;
/* ⚠️ 不要在脚本里硬编码真实房间号（脱敏钩子会拦，而且换个直播间就失效）。
   改为先问一次接口，拿到"此刻真实存在的房间号清单"，断言"取到的值在清单里"。 */
const realRooms: string[] = await (await fetch('http://127.0.0.1:3000/api/llc-rooms'))
  .json()
  .then((raw: unknown) => ((raw as { rooms?: Array<{ roomId?: string }> }).rooms ?? []).map((x) => String(x.roomId ?? '')).filter(Boolean));
const { cdp, close } = await launchBrowser({ port: PORT, headed: false, windowSize: '1500,1400' });
try {
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000' });
  await sleep(3500);
  await cdp.evalJs(`(() => { const b=[...document.querySelectorAll('button')].find((e)=>/^设置$/.test(String(e.textContent||'').trim()) && e.offsetParent!==null); if(b) b.click(); return true; })()`);
  await sleep(1800);

  const before = await cdp.evalJs<{ hasBtn: boolean; value: string; hint: string }>(`(() => {
    const b = document.querySelector('#btnFetchRooms');
    const i = document.querySelector('#c_roomId');
    return { hasBtn: Boolean(b), value: i ? i.value : '(没有输入框)', hint: String((document.querySelector('#roomPickHint') || {}).textContent || '') };
  })()`);
  ok('★ 设置面板里有「从 biliLive-tools 读取」按钮', before.hasBtn);
  ok('房间号输入框存在且有值', before.value !== '' && before.value !== '(没有输入框)', before.value);
  ok('按钮旁有说明（写明"仍要你点保存"）', /保存/.test(before.hint), before.hint.slice(0, 60));

  /* 点一下（按钮是普通 button，程序化 click 可用；开关那类才需要真实鼠标事件） */
  await cdp.evalJs(`document.querySelector('#btnFetchRooms').click()`);
  await sleep(2500);
  const after = await cdp.evalJs<{ hint: string; value: string; picks: number }>(`(() => {
    const hint = document.querySelector('#roomPickHint');
    return {
      hint: String((hint || {}).textContent || ''),
      value: String((document.querySelector('#c_roomId') || {}).value || ''),
      picks: document.querySelectorAll('#roomPickHint [data-room]').length,
    };
  })()`);
  ok('★ 点了之后给出结果（不是一直"读取中…"）', !/读取中/.test(after.hint) && after.hint.length > 0, after.hint.slice(0, 120));
  const hit = realRooms.some((id) => after.hint.includes(id)) || realRooms.includes(after.value);
  ok('★ 结果里列出了真实房间号（或已自动填入）', hit, '清单 ' + realRooms.join('/') + '  hint=' + after.hint.slice(0, 60) + '  value=' + after.value);
  ok('多房间时给出可点的按钮', after.picks >= 1 || /已填入/.test(after.hint), '可点按钮数 ' + after.picks);

  /* 点第一个候选，输入框应被填入 */
  if (after.picks >= 1) {
    await cdp.evalJs(`(document.querySelector('#roomPickHint [data-room]') || {click(){}}).click()`);
    await sleep(600);
    const picked = await cdp.evalJs<{ value: string; hint: string }>(`(() => ({
      value: String((document.querySelector('#c_roomId') || {}).value || ''),
      hint: String((document.querySelector('#roomPickHint') || {}).textContent || ''),
    }))()`);
    ok('★ 点候选后房间号被填入输入框', realRooms.includes(picked.value), picked.value + ' / ' + picked.hint.slice(0, 60));
  }
  ok('全程无未捕获异常', cdp.errors.length === 0, cdp.errors[0]?.slice(0, 160));
} finally {
  await close();
}
await report();
