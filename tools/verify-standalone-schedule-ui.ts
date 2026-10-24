/**
 * 「单独投稿 ⇒ 定时投稿 + 片间隔/抖动按设置生效」在**线上界面**上的真浏览器验证（2026-10-16 加，2026-10-17 改口径）。
 *
 * ## 为什么还要一次真浏览器
 *
 * 这条规则改的是**界面显示的口径**：右栏「错峰 X」、本场详情「定时发布间隔 X」过去都直接读
 * `config.publish.clipGapSec`，而现在要读服务端下发的**生效口径**（`publishSchedule`）。
 * 模板字面量里换个取值来源，错法很安静 —— 显示 `undefined`、显示 config 的旧值、
 * 或者 `publishSchedule()` 在某个模块里没定义（模块顺序问题）都会让页面**看着还行**。
 * `check:ui` 只保证产物 == 模块，管不了这些；只有真渲染一次、把 DOM 文本读回来才算数。
 *
 * ## 只读、不写
 *
 * 全程只 GET 页面 + 读 DOM（点一次任务列表项只是打开详情，不改任何东西、不保存、不投稿），
 * 所以可以对着**线上服务**跑。断言写成"界面显示 == 服务端下发的生效口径"，
 * 不写死具体数值 —— 用户改口径（500/120、100/0、900/…）或切回追加模式都不会假红。
 *
 * 用法：node --experimental-strip-types tools/verify-standalone-schedule-ui.ts [--headed]
 */
import { launchBrowser, ok, report, section, sleep, type Cdp } from './ui-shared.ts';

const BASE = process.env.LAI_VERIFY_BASE ?? 'http://127.0.0.1:3000';
const CDP_PORT = 9343; // 与其它 verify 工具错开（clip-publish-mode 用 9338、clip-gap 用 9341）
const HEADED = process.argv.includes('--headed');

interface Sched {
  mode?: string;
  scheduled?: boolean;
  gapSec?: number;
  jitterSec?: number;
  note?: string;
  ignored?: string;
}

const boot = (await (await fetch(`${BASE}/api/bootstrap`)).json()) as {
  publishSchedule?: Sched;
  config?: { publish?: { clipGapSec?: number } };
};
const sched = boot.publishSchedule ?? {};
const cfgGap = Number(boot.config?.publish?.clipGapSec ?? 0);
console.log(`目标：${BASE}（线上服务，本次只读）`);
console.log(`生效口径：mode=${String(sched.mode)} scheduled=${String(sched.scheduled)} gapSec=${String(sched.gapSec)} jitterSec=${String(sched.jitterSec)}`);
console.log(`config 里的 clipGapSec=${cfgGap}${sched.ignored ? `　｜　${sched.ignored}` : ''}`);

const { cdp, close } = await launchBrowser({ port: CDP_PORT, ...(HEADED ? { headed: true } : {}) });

/** 页面上格式化后的间隔文案（用页面自己的 fmtSpan，避免另写一份格式化导致假失败） */
async function pageSpanOf(cdp: Cdp, sec: number): Promise<string> {
  return String(await cdp.evalJs<string>(`typeof fmtSpan === 'function' ? fmtSpan(${sec}) : '(无 fmtSpan)'`));
}

try {
  await cdp.navigate(`${BASE}/`);
  await cdp.waitFor('#taskList');

  section('1. 服务端下发的生效口径自洽');
  ok('页面用的就是当前产物（UI_BUILD 在页面里）', (await cdp.evalJs<string>(`typeof UI_BUILD !== 'undefined' ? UI_BUILD : ''`)) !== '');
  ok('bootstrap 里有 publishSchedule（界面四处「错峰 X」的来源）', typeof sched.gapSec === 'number' && sched.gapSec > 0, JSON.stringify(sched));
  if (sched.mode === 'standalone') {
    ok('★ 单独投稿：scheduled=true（定时投稿）', sched.scheduled === true, String(sched.scheduled));
    /* 2026-10-17 口径：间隔 = max(300, clipGapSec)、抖动 = min(jitterSec, 间隔−30) ——
       不再写死 300/0（那样用户把间隔改成 500、抖动改成 120 也测不出来）。 */
    ok(
      '★ 单独投稿：gapSec = max(300, clipGapSec)（平台底线保底、可往上调）',
      sched.gapSec === Math.max(300, cfgGap),
      `生效 ${String(sched.gapSec)} / 期望 ${Math.max(300, cfgGap)}（config=${cfgGap}）`,
    );
    ok(
      '★ 单独投稿：jitterSec = min(clipJitter, 间隔−30)（不能 ≥ 间隔）',
      typeof sched.jitterSec === 'number' && sched.jitterSec >= 0 && sched.jitterSec <= Math.max(0, Number(sched.gapSec) - 30),
      String(sched.jitterSec),
    );
  } else {
    ok('追加切片投稿：口径逐字沿用 config（不在本用例的断言范围内，只核对自洽性）', sched.gapSec === cfgGap, `生效 ${String(sched.gapSec)} / config ${cfgGap}`);
  }

  section('2. 右栏「发布排期」：错峰数字 = 生效口径（不是 config 的旧值）');
  /* ⚠️ 必须**等**它渲染：`refreshAll()` 是先 loadTasks() 再 Promise.all([loadDetail, loadSchedule])，
     右栏是最后写进 `#schedule` 的。第一版没等就查 ⇒ 读到 "(无)"，看起来像"界面没显示"（假失败）。 */
  let schedTitle = '';
  for (let i = 0; i < 40; i++) {
    schedTitle = String(await cdp.evalJs<string>(
      `(() => { const el = document.querySelector('#schedule .sched-title span'); return el ? el.textContent.trim() : ''; })()`,
    ));
    if (schedTitle) break;
    await sleep(250);
  }
  console.log(`      右栏标题：${schedTitle || '(无)'}`);
  const span = await pageSpanOf(cdp, Number(sched.gapSec));
  ok(
    `★ 右栏显示的是生效间隔（含「${span}」）`,
    sched.scheduled ? schedTitle.includes(span) : /立即发布/.test(schedTitle),
    `${schedTitle} ｜ 期望含「${sched.scheduled ? span : '立即发布'}」`,
  );
  if (cfgGap > 0 && cfgGap !== Number(sched.gapSec)) {
    ok('★ 且没有拿 config 里的旧值渲染（那正是这次要修的口径漂移）', !schedTitle.includes(await pageSpanOf(cdp, cfgGap)), `${schedTitle} ｜ 不应含 ${await pageSpanOf(cdp, cfgGap)}`);
  }

  section('3. 本场详情：动作栏的「定时发布间隔」同样用生效口径');
  /* 点第一场打开详情（只读：详情是 GET /api/task/:id） */
  const clicked = await cdp.evalJs<boolean>(`(() => { const el = document.querySelector('#taskList .task'); if (!el) return false; el.click(); return true; })()`);
  if (!clicked) {
    console.log('      （任务列表为空，跳过本节）');
  } else {
    let bar = '';
    for (let i = 0; i < 40; i++) {
      bar = String(await cdp.evalJs<string>(`(() => { const el = document.querySelector('.actionbar .info'); return el ? el.textContent : ''; })()`));
      if (bar.includes('切片')) break;
      await sleep(250);
    }
    console.log(`      动作栏：${bar.trim().slice(0, 120)}`);
    ok(
      '★ 动作栏写的是生效间隔（或如实写「立即发布（不排期）」）',
      sched.scheduled ? bar.includes(span) : /立即发布/.test(bar),
      `${bar.trim().slice(0, 160)}`,
    );
  }

  section('4. 页面健康');
  ok('没有未捕获的 JS 异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));
  ok('任务列表仍在渲染', await cdp.evalJs<boolean>(`!!document.querySelector('#taskList')`));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log(`\n\x1b[31m用例抛异常：${msg}\x1b[0m`);
  ok('用例执行未抛异常', false, msg);
} finally {
  await close();
}

await report();
