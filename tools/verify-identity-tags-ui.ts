/**
 * 「必带标签（identityTags）+ {主播} 占位符」在**线上界面**上的真浏览器验证（2026-10-17）。
 *
 * ## 为什么还要一次真浏览器
 *
 * 这次改动同时动了三处口径：设置面板多了「必带标签」输入框（`#c_identityTags`）、
 * 「默认标签」的提示文字从「与 LLM 生成的标签合并后仍会去重与截断」改成「补足剩余名额」、
 * 以及实时提示里的占位符说明（`#hintIdentityTags`）。这些全是模板字面量 + `bindCfg()` 绑定，
 * `check:ui` 只保证产物 == 模块，管不了「input 有没有渲染」「oninput 绑没绑上」「文案是否还是旧的」。
 * 只有真渲染一次、把 DOM 读回来才算数。
 *
 * ## 只读、不写
 *
 * 全程只 GET 页面 + 读 DOM + 在输入框里改值触发提示（不点保存）。所以可以对着**线上服务**跑。
 * 断言写成「界面显示 == 服务端下发的 identityTags」，不写死那 6 个词 —— 用户哪天改标签也不会假红。
 *
 * 用法：node --experimental-strip-types tools/verify-identity-tags-ui.ts [--headed]
 */
import { launchBrowser, ok, report, section, shotPath, sleep, type Cdp } from './ui-shared.ts';

const BASE = process.env.LAI_VERIFY_BASE ?? 'http://127.0.0.1:3000';
const CDP_PORT = 9346; // 与其它 verify 工具错开（clip-publish-mode 9338 / clip-gap 9341 / standalone-schedule 9343）
const HEADED = process.argv.includes('--headed');

const boot = (await (await fetch(`${BASE}/api/bootstrap`)).json()) as {
  config?: {
    publish?: { identityTags?: string[]; defaultTags?: string[]; tidWhitelist?: Record<string, number>; defaultCategory?: string };
  };
};
const identity = boot.config?.publish?.identityTags ?? [];
const defaults = boot.config?.publish?.defaultTags ?? [];
console.log(`目标：${BASE}（线上服务，本次只读）`);
console.log(`服务端 identityTags=${identity.join(' | ')}`);
console.log(`服务端 defaultTags=${defaults.join(' | ')}`);

const { cdp, close } = await launchBrowser({ port: CDP_PORT, ...(HEADED ? { headed: true } : {}) });

const text = async (sel: string): Promise<string> =>
  String(await cdp.evalJs<string>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.textContent.trim() : ''; })()`));
const value = async (sel: string): Promise<string> =>
  String(await cdp.evalJs<string>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.value : ''; })()`));

try {
  await cdp.navigate(`${BASE}/`);
  await cdp.waitFor('#taskList');

  section('1. 打开设置面板');
  const opened = await cdp.evalJs<boolean>(`(async () => { if (typeof openCfg !== 'function') return false; await openCfg(); return true; })()`);
  ok('页面里有 openCfg() 且能打开', opened);
  ok('设置面板已显示（#cfgMask.show）', await cdp.evalJs<boolean>(`!!document.querySelector('#cfgMask.show')`));
  await cdp.waitFor('#c_identityTags');

  section('2. 必带标签输入框 = 服务端下发的值');
  const shown = await value('#c_identityTags');
  console.log(`      输入框：${shown}`);
  ok('★ 存在 #c_identityTags（新字段渲染出来了）', await cdp.evalJs<boolean>(`!!document.querySelector('#c_identityTags')`));
  ok(
    '★ 输入框里的词 == 服务端 identityTags（顺序也一致）',
    shown.split(/[,，]/).map((s) => s.trim()).filter(Boolean).join('|') === identity.join('|'),
    `界面 ${shown} ｜ 服务端 ${identity.join(', ')}`,
  );
  ok('★ 服务端默认必带标签里含占位符 {主播}', identity.some((s) => /\{主播\}/.test(s)), identity.join(' | '));

  section('3. 实时提示（占位符说明 + 剩余名额）');
  const hint = await text('#hintIdentityTags');
  console.log(`      提示：${hint.slice(0, 160)}`);
  ok('★ 提示说明「优先占位、剩下的名额给 LLM 内容词」', hint.includes('优先占位') && hint.includes('剩下的名额'), hint.slice(0, 200));
  if (identity.some((s) => /\{主播\}/.test(s))) {
    ok('★ 提示说明 {主播} 会替换成本场主播名', hint.includes('乙主播') && hint.includes('跳过'), hint.slice(0, 240));
  }
  const n = shown.split(/[,，]/).map((s) => s.trim()).filter(Boolean).length;
  ok(`★ 提示里的个数与服务端一致（${n} 个）`, hint.includes(`${n} 个`), hint.slice(0, 80));

  section('4. 默认标签的旧文案已改口径');
  const tagHint = await text('#hintTags');
  console.log(`      提示：${tagHint.slice(0, 160)}`);
  ok('★ 不再写「与 LLM 生成的标签合并后仍会去重与截断」（改前的承诺）', !tagHint.includes('合并后仍会去重与截断'), tagHint.slice(0, 200));
  ok('★ 改写成「排在必带标签与 LLM 标签之后、只补足剩余名额」', tagHint.includes('只用来补足剩余名额'), tagHint.slice(0, 200));

  section('5. 提示会随输入实时更新（只改 DOM，不保存）');
  const changed = await cdp.evalJs<string>(
    `(() => { const el = document.querySelector('#c_identityTags'); const old = el.value;` +
      ` el.value = ${JSON.stringify([...identity, 'X1', 'X2', 'X3', 'X4', 'X5'].join(', '))};` +
      ` el.dispatchEvent(new Event('input')); const t = document.querySelector('#hintIdentityTags').textContent;` +
      ` el.value = old; el.dispatchEvent(new Event('input')); return t; })()`,
  );
  ok('★ 超过 10 个时提示变红并写明超出（oninput 绑上了）', changed.includes('超出 B站上限 10 个'), changed.slice(0, 120));
  ok('恢复原值后提示回到正常口径', (await text('#hintIdentityTags')).includes('优先占位'));

  section('5b. 「分区（默认）」下拉 = 服务端白名单（2026-10-17 按官方分区表校对过）');
  const wlKeys = Object.keys(boot.config?.publish?.tidWhitelist ?? {});
  const opts = await cdp.evalJs<string[]>(
    `(() => { const el = document.querySelector('#c_defaultCategory'); return el ? [...el.options].map((o) => o.value) : []; })()`,
  );
  console.log(`      下拉 ${opts.length} 项 ｜ 服务端白名单 ${wlKeys.length} 条`);
  ok(
    '★ 下拉选项 == 服务端白名单的键（顺序也一致）',
    opts.join('|') === wlKeys.join('|'),
    `界面 ${opts.join('/')} ｜ 服务端 ${wlKeys.join('/')}`,
  );
  ok(
    '★ 默认选中项 == 服务端 defaultCategory',
    (await value('#c_defaultCategory')) === (boot.config?.publish?.defaultCategory ?? ''),
    `界面 ${await value('#c_defaultCategory')} ｜ 服务端 ${boot.config?.publish?.defaultCategory ?? ''}`,
  );
  ok(
    '★ 下拉里不再有 B站 现役分区表已删掉的「虚拟主播/虚拟主播」',
    !opts.includes('虚拟主播/虚拟主播'),
    opts.join('/'),
  );

  section('6. 页面健康');
  ok('没有未捕获的 JS 异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));
  ok('任务列表仍在渲染（面板没把页面搞崩）', await cdp.evalJs<boolean>(`!!document.querySelector('#taskList')`));

  /* 截图要把「分区（默认）」+「必带标签」两行一起拍进去：先点「全部展开」，再把下拉滚到视口中间 */
  await cdp.evalJs<boolean>(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '全部展开'); if (b) b.click(); return !!b; })()`,
  );
  await sleep(300);
  await cdp.evalJs<boolean>(`(() => { const el = document.querySelector('#c_defaultCategory'); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(300);
  const shot = shotPath('identity-tags-settings');
  await cdp.shot(shot);
  console.log(`      截图：${shot}`);
  await sleep(100);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log(`\n\x1b[31m用例抛异常：${msg}\x1b[0m`);
  ok('用例执行未抛异常', false, msg);
} finally {
  await close();
}

await report();
