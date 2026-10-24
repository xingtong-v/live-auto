/**
 * 「每片 5 分钟间隔」设置项的**真浏览器**验证（2026-10-16）。
 *
 * ## 为什么值得单独跑一次浏览器
 *
 * 这次改的界面部分是**模板字面量里现算的值**，不是静态文案：
 *
 * ```
 * 公式：dtime = 提交时刻 + ${submitGapSec} + (N-1)×${生效间隔} + random(0,${生效抖动})
 * ```
 *
 * 现算就可能算歪 —— `NaN`、负数、"抖动已压到 300"（其实没压）都会**静默**显示成一句看着挺像样的话。
 * 这类错误只有把页面真渲染一次、读回 DOM 里的文本才能发现（`check:ui` 只保证产物 == 模块）。
 *
 * ## ⚠️ 期望值必须来自**生产代码**，不能手抄一遍公式
 *
 * 2026-10-16 实测踩坑：本脚本原来自己写 `effJitter = min(jitterSec, clipGapSec-30)`，
 * 在「单独投稿」下页面显示 `random(0,0)`（该模式下抖动被钉成 0），脚本却期望 60 ⇒ **假失败**。
 * 同一个错误在复核排期时也犯过一次（手搓公式算出「间隔 270~342，期望 300~360」）。
 * 所以这里一律调 `resolveClipPublishSchedule()` 取期望值（它内部已经过 `effectiveJitterSec()` 的夹子）：
 * 页面与生产代码必须**同口径**，谁偏了都是真 bug。
 *
 * ## 只读、不写
 *
 * 全程只 GET（加载页面 + 读 DOM），**不改任何配置、不点保存**，所以可以对着**线上服务**跑。
 * 用例断言的是"界面上显示的与实际配置一致"，不写死具体数值（用户改口径后不会假失败）。
 *
 * 用法：node tools/verify-clip-gap-ui.ts [--headed]
 */
import { resolveClipPublishSchedule } from '../src/config.ts';
import { launchBrowser, ok, report, section, sleep } from './ui-shared.ts';

const BASE = process.env.LAI_VERIFY_BASE ?? 'http://127.0.0.1:3000';
const CDP_PORT = 9341; // 与其它 verify 工具错开
const HEADED = process.argv.includes('--headed');

interface PubCfg {
  submitGapSec?: number;
  clipGapSec?: number;
  jitterSec?: number;
  immediatePublish?: boolean;
  multiPart?: boolean;
  clipPublishMode?: string;
}

const boot = (await (await fetch(`${BASE}/api/bootstrap`)).json()) as {
  config?: { publish?: PubCfg; clip?: { maxCandidates?: number } };
  dtimePlan?: { first?: number; last?: number; gapSec?: number; scheduled?: boolean; note?: string };
  version?: string;
};
const pub = boot.config?.publish ?? {};
const maxCand = Math.max(1, Number(boot.config?.clip?.maxCandidates ?? 1));
const gap = Number(pub.clipGapSec ?? 0);
const jitter = Number(pub.jitterSec ?? 0);
/** 生效口径一律问生产代码要（单独投稿 ⇒ 间隔 max(300, 配置)、抖动 min(配置, 间隔−30)；追加 ⇒ 沿用配置） */
const sched = resolveClipPublishSchedule({
  clipPublishMode: pub.clipPublishMode === 'standalone' ? 'standalone' : 'append',
  multiPart: pub.multiPart === true,
  immediatePublish: pub.immediatePublish === true,
  clipGapSec: gap,
  jitterSec: jitter,
});
const effGap = sched.gapSec;
const effJitter = sched.jitterSec;

console.log(`目标：${BASE}（线上服务，本次只读）`);
console.log(
  `配置：clipGapSec=${gap} jitterSec=${jitter} immediatePublish=${String(pub.immediatePublish)} mode=${String(sched.mode)}`,
);
console.log(`生效：间隔 ${effGap} 秒、抖动 ${effJitter} 秒（期望值来自 resolveClipPublishSchedule）`);
console.log(`  ${sched.note}`);

const { cdp, close } = await launchBrowser({ port: CDP_PORT, ...(HEADED ? { headed: true } : {}) });
let failed = false;

try {
  await cdp.navigate(`${BASE}/`);
  await cdp.waitFor('#taskList');

  section('1. 页面能加载、构建标记与产物一致');
  const build = await cdp.evalJs<string>(`typeof UI_BUILD !== 'undefined' ? UI_BUILD : '(未定义)'`);
  const product = (
    await (await fetch(`${BASE}/`)).text()
  ).match(/const UI_BUILD = '([^']+)'/)?.[1];
  ok('页面里的 UI_BUILD 与产物一致', build !== '(未定义)' && build === product, `页面=${build} 产物=${product}`);

  section('2. 设置面板：相邻切片间隔的真实文案（读 DOM）');
  /* 设置面板是点「设置」按钮**现渲染**的（`openCfg()` → 写 #cfgBody.innerHTML），
     所以必须先真点一次；而它的分组是 `<details>`（默认收起）——
     收起时元素仍在 DOM 里（querySelector 找得到）但 rect 是 0×0。
     这里只展开目标分组，不去点"全部展开"（实测 81 个字段全展开会让截图挂死）。 */
  await cdp.evalJs<boolean>(`(() => { const b = document.querySelector('#btnSetting'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  const revealed = await cdp.evalJs<boolean>(
    `(() => { const f = document.querySelector('#c_clipGapSec'); if (!f) return false; const g = f.closest('details.cfggroup'); if (g) g.open = true; return true; })()`,
  );
  ok('设置面板里存在「相邻切片间隔」输入框', revealed);

  const gapVal = await cdp.evalJs<string>(`(document.querySelector('#c_clipGapSec') || {}).value ?? '(无)'`);
  ok('输入框回显的秒数与配置一致', Number(gapVal) === gap, `界面=${gapVal} 配置=${gap}`);

  const gapLabel = await cdp.evalJs<string>(
    `(() => { const l = document.querySelector('#c_clipGapSec') && document.querySelector('#c_clipGapSec').closest('.field').querySelector('label'); return l ? l.textContent.trim() : '(无)'; })()`,
  );
  ok('标签写明「300 = 每片 5 分钟」口径', /5\s*分钟|300/.test(gapLabel), gapLabel);

  const gapHints = await cdp.evalJs<string[]>(
    `(() => { const f = document.querySelector('#c_clipGapSec'); const p = f && f.closest('.field'); return p ? Array.from(p.querySelectorAll('.hintline')).map((el) => el.textContent.trim()) : []; })()`,
  );
  const hintAll = (gapHints ?? []).join(' ｜ ');
  ok('提示说明「非平台规则」（不再把我方取值说成 B站 要求）', /不是平台规则|非平台规则/.test(hintAll), hintAll.slice(0, 200));
  /* 文案随生效口径变（2026-10-17：两个键在**两种模式下都生效**，只是单独投稿多了两条边界：
     间隔 300 保底、抖动 < 间隔）。所以断言改成正向的"说清生效方式"，而不是找"不生效"。 */
  ok(
    sched.mode === 'standalone'
      ? '单独投稿：提示写明「这个间隔/抖动确实生效」+ 两条边界（300 保底、抖动<间隔）'
      : '追加模式：提示写明生效前提（关闭立即发布 / 或改用单独投稿）',
    sched.mode === 'standalone'
      ? /单独投稿/.test(hintAll) && /300/.test(hintAll) && /抖动/.test(hintAll) && !/对切片都不生效/.test(hintAll)
      : /立即发布/.test(hintAll) && /单独投稿/.test(hintAll),
    hintAll.slice(0, 300),
  );
  ok('提示不再出现"7500"这种旧口径', !/7500/.test(hintAll), hintAll.slice(0, 200));

  section('3. 公式行：现算的抖动必须是「生效值」，不能是 NaN/负数');
  const formula = await cdp.evalJs<string>(
    `(document.querySelector('#hintGap') || {}).textContent ?? '(无)'`,
  );
  console.log(`      公式行：${formula.trim()}`);
  ok('公式行提到了生效间隔（不是 config 里那个不生效的值）', formula.includes(String(effGap)), formula);
  const m = /random\(0,\s*(-?\d+(?:\.\d+)?|NaN)\)/.exec(formula);
  ok('公式里的抖动是个真数字（不是 NaN）', m !== null && Number.isFinite(Number(m[1])), formula);
  ok('公式里的抖动 = 生效抖动（来自生产口径，不是手抄的）', m !== null && Number(m[1]) === effJitter, `界面=${m?.[1]} 期望=${effJitter}`);
  if (Number(m?.[1]) !== jitter) {
    /* 界面显示的抖动与 config 里的值不同 ⇒ 必须**明说原因**（被夹小、或在当前模式下不参与），
       不能静默改数。 */
    ok('界面抖动 ≠ config 抖动 ⇒ 文案必须给出原因（压小 / 不参与）', /压到|自动压|必须小于|不参与|不生效/.test(hintAll + formula), `${hintAll.slice(0, 160)} ｜ ${formula}`);
  } else {
    ok('抖动未被改动 ⇒ 不应出现"已压到"的误导文案', !/压到/.test(formula), formula);
  }

  section('4. 排期预览：末片时间与「间隔」文案自洽');
  const plan = await cdp.evalJs<string>(`(document.querySelector('#hintPlan') || {}).textContent ?? '(无)'`);
  console.log(`      排期行：${plan.trim()}`);
  ok('排期预览非空且给出了首末片时间', /首片约/.test(plan) && /末片约/.test(plan), plan);
  /* 用**页面自己的** `fmtSpan()` 算出期望值再比对：自己再写一份"秒→人话"的格式化必然与它不一致
     （实测：7500 秒页面写"2.1 小时"，我这边写成"125 分钟"，假失败）。 */
  const pageSpan = await cdp.evalJs<string>(`typeof fmtSpan === 'function' ? fmtSpan(${effGap}) : '(无 fmtSpan)'`);
  ok('排期预览里的间隔文案 = 页面自己格式化后的间隔', plan.includes(pageSpan), `${plan} ｜ 期望含「${pageSpan}」`);
  /* ★ 时间本身也得自洽：服务端预览按 `clip.maxCandidates` 片算首末片，跨度必须正好是
     (片数−1)×生效间隔。只比"文案里有没有 5 分钟"是不够的 —— 曾经的 bug 正是
     "文案说 5 分钟、时间却按 7500 秒排"（那种预览会骗人，而且看不出来）。 */
  const planGap = Number(boot.dtimePlan?.gapSec ?? 0);
  const first = Number(boot.dtimePlan?.first ?? 0);
  const last = Number(boot.dtimePlan?.last ?? 0);
  ok('服务端预览用的间隔 = 生效间隔', planGap === effGap, `预览 gapSec=${planGap} 生效=${effGap}`);
  /* 带抖动时首末片跨度是随机的（每片独立 random）⇒ 容差 2×抖动上限；
     抖动为 0 时仍是精确的 (片数−1)×间隔。 */
  ok(
    `★ 首末片跨度 ≈ (${maxCand}−1)×${effGap} 秒（时间与文案同口径，容差 ±2×抖动 ${effJitter}）`,
    Math.abs(last - first - (maxCand - 1) * effGap) <= 2 * effJitter,
    `实际 ${last - first} 秒，期望 ${(maxCand - 1) * effGap} ± ${2 * effJitter} 秒`,
  );

  section('5. 页面没被弄坏');
  ok('任务列表仍在渲染', await cdp.evalJs<boolean>(`!!document.querySelector('#taskList')`));
  ok('没有未捕获的 JS 异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));
} catch (e) {
  failed = true;
  const msg = e instanceof Error ? e.message : String(e);
  console.log(`\n\x1b[31m用例抛异常：${msg}\x1b[0m`);
  // 计入 fail：否则 report() 只看 ok() 的计数，抛异常反而会以退出码 0 "通过"
  ok('用例执行未抛异常', false, msg);
} finally {
  await close();
}

await report();
/* ⚠️ 这里**不能**用 process.exit()：本脚本用过 fetch + CDP websocket，退出时 undici 的
   异步句柄可能仍在关闭中，硬退出会让 Node 在 Windows 上 fail-fast
   （实测：`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，file src\win\async.c，
   退出码 0xC0000409 —— 明明全部通过却看起来像崩了）。report() 已经设好 process.exitCode，
   这里只兜住"抛异常但断言数没涨"的情况；让事件循环自然收尾。 */
if (failed) process.exitCode = 1;
