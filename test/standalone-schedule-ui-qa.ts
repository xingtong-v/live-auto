/**
 * QA 独立验收（真浏览器）：设置弹窗里「相邻切片间隔 / 随机抖动」在**单独投稿**下的显示口径。
 *
 * ## 隔离实例，绝不碰生产
 *
 * 生产服务在 3000 上跑（且可能是旧代码），本脚本**不连它**：
 * 自己 `mkdtemp` 一份临时目录（config + data 全在里面），用 `Orchestrator({ configPath, dataDirOverride })`
 * + `UiServer({ port: 0 })` 起一个进程内实例，端口由系统分配 ⇒ 不可能撞上 3000。
 * 全程只 GET 页面 / 读 DOM / 改**表单里的输入框**（不点保存、不发 POST），所以临时配置一个字节都不会被改。
 *
 * ## 断言为什么必须自己写
 *
 * 仓库里已有的 `tools/verify-clip-gap-ui.ts` / `verify-standalone-schedule-ui.ts` 是**对线上服务只读**
 * 的巡检（它们拿 bootstrap 下发的 `publishSchedule` 当期望值），口径一变就跟着变，
 * 证明不了"500/120 这种情况真的生效"。这里反过来：
 *
 *   · 期望值来自**需求**（间隔 = max(300, 用户值)、抖动 = min(用户值, 间隔−30)），写死在断言里；
 *   · 输入框改值后读**渲染出来的文本**，验证公式实时重算 + 被抬/被夹的原因有没有说清；
 *   · 同时守住"删掉的旧文案不许回来"（旧文案说两项对切片都不生效）。
 *
 * ## 顺序说明（不是笔误）
 *
 * 「把间隔改成 100 ⇒ 公式变 ×300」「把抖动改成 900 ⇒ random(0,470)」这两条**不能连着做**：
 * 间隔还是 100 时生效间隔是 300，抖动的夹子上限是 270 而不是 470。
 * 所以脚本按「100（看 ×300 + 抬的原因）→ 抖动 900（看夹到 270）→ 间隔回 500（看夹到 470）」走，
 * 三条都是当前输入下的**正确**期望值。
 *
 * 用法：node test/standalone-schedule-ui-qa.ts [--headed]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';
import { Ledger } from '../src/ledger.ts';
import { launchBrowser, ok, eq, report, section, sleep } from '../tools/ui-shared.ts';

const CDP_PORT = 9351; // 与其它 verify 工具错开（9338/9341/9343 都有人用）
const HEADED = process.argv.includes('--headed');

/* ===================== 隔离实例 ===================== */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-sched-qa-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const configPath = path.join(tmpRoot, 'config.json');

/** 被测配置：单独投稿 + 用户设置 500 / 120（默认值来自 config.example.json，这里只写要测的那几个键） */
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      publish: {
        clipPublishMode: 'standalone',
        multiPart: false,
        immediatePublish: false,
        clipGapSec: 500,
        jitterSec: 120,
        submitGapSec: 1200,
        firstPublishAt: '',
      },
      ui: { host: '127.0.0.1', port: 0, openBrowser: false },
      mcp: { enabled: false },
      runtime: { logLevel: 'error' },
    },
    null,
    2,
  ),
  'utf8',
);

const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
const orch = new Orchestrator({ configPath, dataDirOverride: dataDir, ledger, dryRun: true });
const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
await ui.start();
const BASE = ui.url;
console.log(`隔离实例：${BASE}（端口由系统分配；临时目录 ${tmpRoot}）`);

let browser: { cdp: Awaited<ReturnType<typeof launchBrowser>>['cdp']; close: () => Promise<void> } | undefined;

try {
  /* ===================== 0. 服务端口径（API 层，先证明实例喂的是被测配置） ===================== */
  section('0. 隔离实例下发的生效口径');
  const boot = (await (await fetch(`${BASE}/api/bootstrap`)).json()) as {
    publishSchedule?: { mode?: string; scheduled?: boolean; gapSec?: number; jitterSec?: number; ignored?: string };
    config?: { publish?: { clipGapSec?: number; jitterSec?: number; clipPublishMode?: string } };
    configVersion?: string;
  };
  const versionBefore = String(boot.configVersion ?? '');
  const sched = boot.publishSchedule ?? {};
  eq('实例配置：clipPublishMode=standalone', boot.config?.publish?.clipPublishMode, 'standalone');
  eq('实例配置：clipGapSec=500', boot.config?.publish?.clipGapSec, 500);
  eq('实例配置：jitterSec=120', boot.config?.publish?.jitterSec, 120);
  eq('★ 服务端下发 gapSec=500（不是写死的 300）', sched.gapSec, 500);
  eq('★ 服务端下发 jitterSec=120（不是写死的 0）', sched.jitterSec, 120);
  eq('单独投稿 ⇒ scheduled=true', sched.scheduled, true);
  eq('500 / 120 没有任何"被抬/被夹"的偏离说明', sched.ignored, '');

  /* ===================== 1. 设置弹窗：公式行真渲染 ===================== */
  browser = await launchBrowser({ port: CDP_PORT, ...(HEADED ? { headed: true } : {}) });
  const cdp = browser.cdp;
  await cdp.navigate(`${BASE}/`, '#taskList');

  /* 等 bootstrap 落到页面状态里（设置面板的渲染完全依赖它）。
     ⚠️ `state` 是脚本顶层的 `const`（全局词法器绑定），**不在 `window` 上** ——
     写成 `window.state` 会永远读不到（第一版就这么错的，页面明明渲染正常却报假红）。 */
  let bootReady = false;
  for (let i = 0; i < 60; i++) {
    bootReady = await cdp.evalJs<boolean>(`typeof state !== 'undefined' && !!(state.bootstrap && state.bootstrap.config)`);
    if (bootReady) break;
    await sleep(200);
  }
  ok('页面已拿到 bootstrap（设置面板可渲染）', bootReady);

  const opened = await cdp.evalJs<boolean>(`(() => { const b = document.querySelector('#btnSetting'); if (b) b.click(); return !!b; })()`);
  ok('设置按钮存在并被点击', opened);
  await sleep(700);
  ok('设置弹窗已打开（#cfgMask 带 show）', await cdp.evalJs<boolean>(`!!document.querySelector('#cfgMask.show')`));

  /* 只展开「相邻切片间隔」所在分组：81 个字段全展开会让页面很慢 */
  const revealed = await cdp.evalJs<boolean>(
    `(() => { const f = document.querySelector('#c_clipGapSec'); if (!f) return false; const g = f.closest('details.cfggroup'); if (g) g.open = true; return true; })()`,
  );
  ok('设置面板里有「相邻切片间隔」输入框', revealed);
  await sleep(300);

  eq('输入框回显 clipGapSec=500', Number(await cdp.evalJs<string>(`document.querySelector('#c_clipGapSec').value`)), 500);
  eq('输入框回显 jitterSec=120', Number(await cdp.evalJs<string>(`document.querySelector('#c_jitterSec').value`)), 120);

  const formula = await cdp.evalJs<string>(`(() => { const el = document.querySelector('#hintGap'); return el ? el.textContent : '(缺少 #hintGap)'; })()`);
  console.log(`      公式行：${formula}`);
  ok('★ 公式行出现 (N-1)×500（按用户设置的间隔，不是写死 300）', formula.includes('(N-1)×500'), formula);
  ok('★ 公式行出现 random(0,120)（按用户设置的抖动，不是写死 0）', formula.includes('random(0,120)'), formula);
  ok('公式行标明这是「单独投稿 + 两项都生效」', /单独投稿/.test(formula) && /生效/.test(formula), formula);
  ok(
    '500 / 120 没有被抬/被夹 ⇒ 不带警示色（class 含 ok）',
    await cdp.evalJs<boolean>(`(() => { const el = document.querySelector('#hintGap'); return !!el && el.className.includes('ok'); })()`),
  );

  /* ===================== 2. 旧文案必须消失（但 immediatePublish 那条要留着） ===================== */
  section('2. 「对切片都不生效」这类旧字句已消失');
  const panelText = await cdp.evalJs<string>(`(() => { const el = document.querySelector('#cfgBody'); return el ? el.innerText : ''; })()`);
  const oldPhrase = /对切片都不生效|不参与切片排期|相邻切片间隔.{0,12}不生效|随机抖动.{0,12}不生效/.test(panelText);
  ok('★ 设置面板里不再出现「对切片都不生效 / 不参与切片排期」', !oldPhrase, panelText.slice(0, 200));

  const gapUse = await cdp.evalJs<string>(`(document.querySelector('#hintClipGapUse') || {}).textContent || ''`);
  console.log(`      间隔生效说明：${gapUse.slice(0, 120)}…`);
  ok(
    '★ 间隔说明改成「确实生效 + 低于 300 会被抬到 300」',
    /单独投稿/.test(gapUse) && /300/.test(gapUse) && /抬到 300/.test(gapUse) && /抖动/.test(gapUse),
    gapUse,
  );

  const immHint = await cdp.evalJs<string>(`(document.querySelector('#hintImmediate') || {}).textContent || ''`);
  console.log(`      立即发布说明：${immHint.slice(0, 120)}…`);
  ok(
    '边界：immediatePublish 仍如实提示「对切片不生效」（这条**不该**删）',
    /单独投稿/.test(immHint) && /对切片不生效/.test(immHint),
    immHint,
  );

  const modeHint = await cdp.evalJs<string>(`(document.querySelector('#hintClipMode') || {}).textContent || ''`);
  ok(
    '模式说明写明「每片相隔 500 秒 + 0~120 秒抖动」',
    /500 秒/.test(modeHint) && /0~120/.test(modeHint),
    modeHint.slice(0, 200),
  );

  /* ===================== 3. 实时重算：改输入框 ⇒ 公式与原因立刻变 ===================== */
  section('3. 改输入框即时重算（clipGapSec=100 ⇒ ×300 + 抬的原因）');
  const setInput = async (sel: string, value: number): Promise<void> => {
    await cdp.evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false;
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);
  };

  await setInput('#c_clipGapSec', 100);
  const f100 = await cdp.evalJs<string>(`document.querySelector('#hintGap').textContent`);
  console.log(`      公式行：${f100}`);
  ok('★ clipGapSec=100 ⇒ 公式变成 (N-1)×300（被抬到平台底线）', f100.includes('(N-1)×300'), f100);
  ok('★ 并给出原因「低于 B站 平台底线 300 秒」', /低于\s*B站\s*平台底线\s*300\s*秒/.test(f100), f100);
  ok(
    '被抬时公式行带警示色（class 含 warn）',
    await cdp.evalJs<boolean>(`(() => { const el = document.querySelector('#hintGap'); return !!el && el.className.includes('warn'); })()`),
  );

  section('4. 抖动 900（间隔仍 100 ⇒ 生效 300 ⇒ 夹到 270）');
  await setInput('#c_jitterSec', 900);
  const f270 = await cdp.evalJs<string>(`document.querySelector('#hintGap').textContent`);
  console.log(`      公式行：${f270}`);
  ok('★ 抖动被夹成 random(0,270)（= 生效间隔 300 − 30，不是 900，也不是 870）', f270.includes('random(0,270)'), f270);
  ok('★ 并给出夹取原因（你填的 900 已自动压到 270）', /你填的抖动 900 秒已自动压到 270 秒/.test(f270), f270);

  section('5. 间隔回 500 ⇒ 抖动夹到 470');
  await setInput('#c_clipGapSec', 500);
  const f470 = await cdp.evalJs<string>(`document.querySelector('#hintGap').textContent`);
  console.log(`      公式行：${f470}`);
  ok('★ 间隔 500 + 抖动 900 ⇒ (N-1)×500 且 random(0,470)', f470.includes('(N-1)×500') && f470.includes('random(0,470)'), f470);
  ok('★ 夹取原因同步成「压到 470 秒」', /已自动压到 470 秒/.test(f470), f470);
  ok('此时不再报「间隔被抬」（500 已合法）', !/低于\s*B站\s*平台底线/.test(f470), f470);

  section('6. 页面健康 + 状态未落盘');
  eq('设置面板没有未捕获的 JS 异常', cdp.errors.length, 0);
  const versionAfter = String(((await (await fetch(`${BASE}/api/bootstrap`)).json()) as { configVersion?: string }).configVersion ?? '');
  ok(
    '★ 全程没点保存：配置内容版本号一字未变（表单改动只是本地渲染）',
    versionBefore !== '' && versionAfter === versionBefore,
    `前 ${versionBefore} / 后 ${versionAfter}`,
  );
  const cfgBack = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { publish?: { clipGapSec?: number; jitterSec?: number } };
  ok(
    '★ 临时 config 未被改动（全程只读表单，没点保存）',
    cfgBack.publish?.clipGapSec === 500 && cfgBack.publish?.jitterSec === 120,
    JSON.stringify(cfgBack.publish),
  );

  /* 截一张图留档（落系统临时目录，不污染 data/verify-shots；finally 里不删，便于人工复核） */
  const shot = path.join(os.tmpdir(), `lai-sched-qa-${Date.now()}.png`);
  await cdp.shot(shot);
  console.log(`      截图：${shot}`);
} catch (e) {
  const msg = e instanceof Error ? e.stack ?? e.message : String(e);
  ok('用例执行未抛异常', false, msg.slice(0, 400));
} finally {
  if (browser) await browser.close();
  await ui.stop();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用：临时目录留着也无害 */
  }
}

await report();
