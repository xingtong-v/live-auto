/**
 * 「切片投稿方式」开关（追加切片投稿 / 单独投稿）的**真浏览器 + 真服务**验证。
 *
 * ## 为什么不用跑着的那个服务
 *
 * 这个开关要验的是「界面上点一下 → POST /api/config → 落盘 → 再读回来还是它」，
 * 而 `/api/config` 写的就是**运行中服务的 config.json**。为了不碰用户的线上配置，
 * 这里自己起一个**独立实例**：独立端口（3180）+ 独立临时 config.json + 独立 dataDir，
 * 全程 dryRun、不启动轮询、不建任务、不切片、不投稿。线上服务与线上配置一字不动。
 *
 * ## 验的是什么
 *
 *   1. 设置面板里真有这个两选一开关（两个 chip 的文案、初值与配置一致）；
 *   2. 点「单独投稿」→ 另一项必须熄灭（互斥），提示文案随之说明差别；
 *   3. 点「保存配置」→ 服务端真的存下 `clipPublishMode='standalone'` **且** `multiPart=false`
 *      （两个键必须一起变：这是"界面上能点、链路里没人读"那类事故的防线）；
 *   4. 存完**没有硬约束错误**（显式单独投稿是明确意图，不该被旧规则拦住）；
 *   5. 重开设置面板 → 读回来还是「单独投稿」（落盘往返）；
 *   6. 切回「追加切片投稿」→ 两个键一起回到 append / multiPart=true；
 *   7. 全程没有未捕获的 JS 异常，页面没被弄坏。
 *
 * 运行（不需要线上服务在跑）：
 *   node --experimental-strip-types tools/verify-clip-publish-mode.ts
 *   加 --headed 可以看着浏览器跑。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/daemon.ts';
import { Ledger } from '../src/ledger.ts';
import { UiServer } from '../src/server.ts';
import { CONFIG_PATH, ensureDir } from '../src/util.ts';
import { clickReal, launchBrowser, ok, report, section, shotPath, sleep, type Cdp } from './ui-shared.ts';

const PORT = 3180; // 独立实例：与线上 3000、config-conflict-e2e 的 3179 错开
const CDP_PORT = 9338; // 浏览器调试端口，与其它 verify 工具错开
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

function request(method: string, p: string, opts: { csrf?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: p,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(opts.csrf ? { 'X-CSRF-Token': opts.csrf } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            json = { raw: text.slice(0, 200) };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** bootstrap 里的 publish 段（只取本用例关心的字段） */
async function publishCfg(): Promise<{ clipPublishMode?: string; multiPart?: boolean }> {
  const boot = await request('GET', '/api/bootstrap');
  const cfg = boot.json['config'] as { publish?: { clipPublishMode?: string; multiPart?: boolean } } | undefined;
  return cfg?.publish ?? {};
}

/** 等一个**条件表达式**成立（共享件的 waitFor 只等元素出现，这里要等配置往返） */
async function waitUntil(cdp: Cdp, label: string, expr: string, timeoutMs = 12000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cdp.evalJs<boolean>(expr).catch(() => false)) return true;
    await sleep(200);
  }
  console.log(`      ⚠ 等待超时：${label}`);
  return false;
}

/**
 * 把开关所在的分组展开、并滚进视野 —— **每次点它之前都必须做**。
 *
 * 为什么：设置面板的分组是 `<details>`（默认收起），收起时元素仍在 DOM 里（`querySelector` 找得到，
 * 所以"元素存在"这类断言会通过），但 **rect 是 0×0** ⇒ 真实鼠标点击必然落空。
 * 实测踩过：第一次打开面板时我手动展开了分组，点击成功；保存后面板关闭、再打开时分组又收起了，
 * 于是"切回追加"那一步的点击静默失败（`clickReal` 返回 false），最后配置停在 standalone。
 */
async function revealClipMode(cdp: Cdp): Promise<void> {
  await cdp.evalJs(`(() => { const f = document.querySelector('#c_clipPublishMode'); if (!f) return false; const g = f.closest('details.cfggroup'); if (g) g.open = true; f.closest('.field').scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(400);
}

/** 点一个元素并**自检落点**（落空就再展开一次重试；仍失败则由断言报红，不静默跳过） */
async function clickSure(cdp: Cdp, selector: string, before?: () => Promise<void>): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (before) await before();
    if (await clickReal(cdp, selector)) return true;
    await sleep(300);
  }
  return false;
}

/** 截图（超时只提示、不判失败：设置面板很长时 Chromium 偶发截图不返回） */
async function shot(cdp: Cdp, name: string): Promise<void> {
  const file = shotPath(`clip-publish-mode-${name}`);
  try {
    ensureDir(path.dirname(file));
    await cdp.shot(file);
    console.log(`      \x1b[90m截图: ${path.relative(process.cwd(), file)}\x1b[0m`);
  } catch (e) {
    console.log(`      \x1b[33m截图失败（不影响结论）：${(e as Error).message}\x1b[0m`);
  }
}

/* ---------- 独立临时实例（线上服务与线上 config.json 都不碰） ---------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cpm-ui-'));
const tmpCfg = path.join(tmpRoot, 'config.json');
const live = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { publish: Record<string, unknown>; ui: Record<string, unknown> };
const entryMode = live.publish['clipPublishMode'] === 'standalone' ? 'standalone' : 'append';
const entryMulti = live.publish['multiPart'] === true;
/* ★ 排期三个键**强制摆成非默认值**（immediatePublish=true / 7500 / 1800）：
   这样「单独投稿仍然按设置里的间隔/抖动排期」才是**可判定的** —— 若继承线上值
   （线上恰好是 500 / 120 / 立即发布开），界面即使写死 300/0 也看不出来，用例会假绿。
   ⚠️ 2026-10-17 口径：单独投稿下 clipGapSec / jitterSec **生效**（间隔 300 保底、抖动 < 间隔），
   所以下面期望的是 `×7500` 与 `random(0,1800)`，而不是曾经的 300/0。 */
const FORCED = { immediatePublish: true, clipGapSec: 7500, jitterSec: 1800, submitGapSec: 1200 };
fs.writeFileSync(
  tmpCfg,
  JSON.stringify({ ...live, publish: { ...live.publish, ...FORCED }, ui: { ...live.ui, enabled: false, port: PORT } }, null, 2),
  'utf8',
);

/* 错误事件流/报告重定向到临时目录（模块级常量，configPath 管不到） */
const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));
setErrorReportDir(path.join(tmpRoot, 'error-report'));

/* ⚠️ **必须显式给一个临时 ledger**（2026-10-16 发现）：`Orchestrator` 的写法是
   `this.ledger = opts.ledger ?? defaultLedger`，而 `defaultLedger` 是**模块级**、指向线上
   `data/ledger.json` 的那一个 —— `dataDirOverride` 只重定向日志与错误报告，管不到台账。
   第一版没给 ledger，于是这个"独立实例"其实读的是**线上台账**（截图里能看到线上那 22 个待发布），
   只是没点任何写台账的操作而已。这类"以为隔离、其实共享"的替身最危险：一旦哪天多点一个按钮，
   就会写进线上台账。这里补上，让隔离是真的。 */
const ledger = new Ledger({ path: path.join(tmpRoot, 'data', 'ledger.json') });
const orch = new Orchestrator({ configPath: tmpCfg, dataDirOverride: path.join(tmpRoot, 'data'), dryRun: true, ledger });
const ui = new UiServer({ orchestrator: orch, port: PORT, openBrowser: false });
await ui.start();
console.log(`独立实例：${BASE}（临时配置 ${path.relative(os.tmpdir(), tmpCfg)}，线上配置未改动）`);
console.log(`进入时：clipPublishMode=\x1b[1m${entryMode}\x1b[0m multiPart=\x1b[1m${entryMulti}\x1b[0m（本用例只改临时实例）`);

const { cdp, close } = await launchBrowser({ port: CDP_PORT, headed: HEADED });

try {
  await cdp.navigate(BASE + '/');
  await cdp.waitFor('#taskList');

  /* ---------------- 1. 打开设置：开关存在、初值正确 ---------------- */
  section('1. 设置面板里的「切片投稿方式」开关（两个选项 + 初值）');
  ok('页面加载完成（任务列表在）', await cdp.waitFor('#taskList'));
  /* 构建标记断言用"页面 == 当前产物"而不是写死一个字符串：
     这个仓库可能同时有别的会话在改界面并重建 ui.html（实测 2026-10-16 就发生了），
     写死值会在**别人的改动**上假红，而真正要守的是"页面用的就是当前产物"。 */
  const builtMarker = /const UI_BUILD = '([^']+)'/.exec(fs.readFileSync(path.join(process.cwd(), 'public', 'ui.html'), 'utf8'))?.[1] ?? '';
  const pageMarker = String(await cdp.evalJs<string>(`typeof UI_BUILD !== 'undefined' ? UI_BUILD : ''`));
  ok('页面用的就是当前产物（UI_BUILD 与 public/ui.html 一致）', builtMarker !== '' && pageMarker === builtMarker, `产物 ${builtMarker} / 页面 ${pageMarker}`);
  ok('顶栏「设置」按钮点得动（真实鼠标事件）', await clickReal(cdp, '#btnSetting'));
  ok('设置面板打开且开关在', await cdp.waitFor('#c_clipPublishMode'));
  const labels = await cdp.evalJs<string[]>(`Array.from(document.querySelectorAll('#c_clipPublishMode .chip')).map((el) => el.textContent.trim())`);
  ok('两个选项都在，且文案就是「追加切片投稿 / 单独投稿」', (labels ?? []).join('|') === '追加切片投稿|单独投稿', (labels ?? []).join('|'));
  const initOn = await cdp.evalJs<string>(`(document.querySelector('#c_clipPublishMode .chip.on') || {}).dataset ? document.querySelector('#c_clipPublishMode .chip.on').dataset.mode : '(无)'`);
  ok(`初值与配置一致（${entryMode}）`, initOn === entryMode, `界面 ${initOn}`);
  const hint0 = await cdp.evalJs<string>(`document.querySelector('#hintClipMode').textContent`);
  ok('提示文案说明了这个模式的后果', String(hint0).includes(entryMode === 'append' ? '同一个稿件' : '各自投一个稿件'), String(hint0).slice(0, 80));
  /* 截图留证：分组默认收起，先把**这一个**分组展开再滚进视野 —— 否则截图上只有目录。
     ⚠️ 刻意不用「全部展开」：81 个字段全展开时 Chromium 截图会卡住不返回。 */
  await revealClipMode(cdp);
  await shot(cdp, 'open');

  /* ---------------- 2. 点「单独投稿」：互斥 + 文案切换 ---------------- */
  section('2. 点「单独投稿」：互斥（另一项必须熄灭）+ 提示说明差别');
  ok('点击落在开关上（真实鼠标事件，不是 el.click()）', await clickSure(cdp, '#c_clipPublishMode .chip[data-mode="standalone"]', () => revealClipMode(cdp)));
  const onNow = await cdp.evalJs<string[]>(`Array.from(document.querySelectorAll('#c_clipPublishMode .chip.on')).map((el) => el.dataset.mode)`);
  ok('★ 只有一个亮着，且是 standalone（两选一，不是多选）', (onNow ?? []).length === 1 && onNow?.[0] === 'standalone', (onNow ?? []).join(','));
  const hint1 = await cdp.evalJs<string>(`document.querySelector('#hintClipMode').textContent`);
  ok('文案切到「单独投稿」的说明', String(hint1).includes('每个切片各自投一个稿件'), String(hint1).slice(0, 60));
  ok('★ 说清了"不用等完整版稿件"（两个模式最容易误解的差别）', String(hint1).includes('不用等'), String(hint1).slice(0, 120));
  ok('★ 说清了额度代价（每片占 1 个每日额度）', String(hint1).includes('每片占 1 个每日额度'), String(hint1).slice(0, 160));
  /* ★ 2026-10-17 用户要求（原话「这里改成对定时投稿也生效」）：单独投稿下
     「相邻切片间隔 / 随机抖动」确实生效。临时配置刻意把它们摆成 7500/1800，
     界面若还照 "钉死 300/0" 的老口径渲染，就会在公式行里写 ×300 / random(0,0) —— 本用例就是拦这个。 */
  const schedHints = await cdp.evalJs<Record<string, string>>(`(() => {
    const t = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim().replace(/\\s+/g, ' ') : '(无)'; };
    return { formula: t('#hintGap'), gapUse: t('#hintClipGapUse'), immediate: t('#hintImmediate') };
  })()`);
  console.log(`      公式行：${schedHints['formula'] ?? ''}`);
  console.log(`      间隔提示：${(schedHints['gapUse'] ?? '').slice(0, 90)}…`);
  ok(
    '★ 公式行用**生效间隔 7500 / 抖动 1800**（= 设置值；不是钉死的 300 / 0）',
    /\(N-1\)×7500/.test(schedHints['formula'] ?? '') && /random\(0,1800\)/.test(schedHints['formula'] ?? ''),
    schedHints['formula'] ?? '',
  );
  ok(
    '★ 「相邻切片间隔」旁写明：单独投稿下这个键**生效**，两条边界是「300 保底」与「抖动<间隔」',
    /当前是「单独投稿」/.test(schedHints['gapUse'] ?? '') &&
      /300/.test(schedHints['gapUse'] ?? '') &&
      /抖动/.test(schedHints['gapUse'] ?? '') &&
      !/都不生效/.test(schedHints['gapUse'] ?? ''),
    schedHints['gapUse'] ?? '',
  );
  ok(
    '★ 「立即发布」旁写明：它对切片不生效（但完整版仍按它走）',
    /对切片不生效/.test(schedHints['immediate'] ?? '') && /完整版/.test(schedHints['immediate'] ?? ''),
    schedHints['immediate'] ?? '',
  );
  ok('没有未捕获异常（点击处理没炸）', cdp.errors.length === 0, cdp.errors.slice(0, 1).join(''));
  await shot(cdp, 'standalone');

  /* ---------------- 3. 保存：两个键一起落盘，且无硬约束错误 ---------------- */
  section('3. 保存配置 → 服务端真的存下 standalone，且 multiPart 一起变 false');
  ok('点击「保存配置」', await clickReal(cdp, '#btnSaveCfg'));
  const saved = await waitUntil(
    cdp,
    '服务端读到 standalone',
    `(async () => { const b = await (await fetch('/api/bootstrap')).json(); return b.config.publish.clipPublishMode === 'standalone' && b.config.publish.multiPart === false; })()`,
  );
  ok('★ 落盘：clipPublishMode=standalone 且 multiPart=false（两个键必须一起变）', saved, JSON.stringify(await publishCfg()));
  /* 生效口径也随之下发（界面四处「错峰 X」不再各自读 config.publish.clipGapSec） */
  const schedAfter = await cdp.evalJs<{ mode?: string; scheduled?: boolean; gapSec?: number; jitterSec?: number; ignored?: string }>(
    `(async () => { const b = await (await fetch('/api/bootstrap')).json(); return b.publishSchedule || {}; })()`,
  );
  ok(
    '★ 服务端下发的生效口径 = 单独投稿 / 定时投稿 / 间隔 7500 / 抖动 1800（2026-10-17 起按设置生效，不再钉死 300/0）',
    schedAfter.mode === 'standalone' && schedAfter.scheduled === true && schedAfter.gapSec === 7500 && schedAfter.jitterSec === 1800,
    JSON.stringify(schedAfter),
  );
  ok(
    '★ 且如实点名"唯一不参与的是 immediatePublish"（clipGapSec/jitterSec 现在生效，不该再被说不参与）',
    /immediatePublish=true/.test(schedAfter.ignored ?? '') &&
      !/clipGapSec=/.test(schedAfter.ignored ?? '') &&
      !/jitterSec=/.test(schedAfter.ignored ?? ''),
    schedAfter.ignored ?? '',
  );
  const issues = await cdp.evalJs<string>(`document.querySelector('#cfgIssues') ? document.querySelector('#cfgIssues').textContent : '(无)'`);
  /* 只要求"没有 error 级"：这个开关不该再触发「必须开 multiPart」那条硬约束。
     提醒（warn）可能是与本次无关的历史项（实测临时实例上有 2 条），不该让本用例变红。 */
  ok('★ 保存后没有硬约束错误（旧规则会在这里拦"必须开 multiPart"）', !String(issues).includes('硬约束错误'), String(issues));
  const closed = await waitUntil(cdp, '保存成功后设置面板关闭', `!document.querySelector('#cfgMask').classList.contains('show')`);
  ok('保存成功后设置面板自动关闭（说明这次保存被当成成功）', closed);

  /* ---------------- 4. 重开：读回来还是它（落盘往返） ---------------- */
  section('4. 重开设置面板 → 读回来还是「单独投稿」');
  await clickSure(cdp, '#btnSetting');
  await cdp.waitFor('#c_clipPublishMode');
  await revealClipMode(cdp);
  const reread = await cdp.evalJs<string>(`(document.querySelector('#c_clipPublishMode .chip.on') || {}).dataset ? document.querySelector('#c_clipPublishMode .chip.on').dataset.mode : '(无)'`);
  ok('★ 落盘往返一致（不是"看着开了、存下去却丢了"）', reread === 'standalone', `界面 ${reread}`);
  await shot(cdp, 'reread');

  /* ---------------- 5. 切回「追加切片投稿」 ---------------- */
  section('5. 切回「追加切片投稿」→ 两个键一起回到 append / multiPart=true');
  ok('点击落在「追加切片投稿」上（真实鼠标事件）', await clickSure(cdp, '#c_clipPublishMode .chip[data-mode="append"]', () => revealClipMode(cdp)));
  const backOn = await cdp.evalJs<string>(`(document.querySelector('#c_clipPublishMode .chip.on') || {}).dataset ? document.querySelector('#c_clipPublishMode .chip.on').dataset.mode : '(无)'`);
  ok('界面在保存前已切到 append（否则保存的还是上一次的选择）', backOn === 'append', `界面 ${backOn}`);
  ok('点击「保存配置」', await clickSure(cdp, '#btnSaveCfg'));
  const back = await waitUntil(
    cdp,
    '服务端读到 append',
    `(async () => { const b = await (await fetch('/api/bootstrap')).json(); return b.config.publish.clipPublishMode === 'append' && b.config.publish.multiPart === true; })()`,
  );
  ok('★ 两个键一起回到 append / multiPart=true', back, JSON.stringify(await publishCfg()));
  const hint2 = await cdp.evalJs<string>(`document.querySelector('#hintClipMode') ? document.querySelector('#hintClipMode').textContent : ''`);
  ok('文案回到「追加切片投稿」的说明（含"等完整版稿件"）', String(hint2).includes('等完整版稿件'), String(hint2).slice(0, 80));
  /* ★ 反向断言：切回追加后，排期提示必须**跟着回到 config 口径**（7500 / 1800 / 立即发布生效）——
     否则"单独投稿那套固定值"就变成了写死的文案，两种模式看着一样。 */
  const backHints = await cdp.evalJs<Record<string, string>>(`(() => {
    const t = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim().replace(/\\s+/g, ' ') : '(无)'; };
    return { formula: t('#hintGap'), gapUse: t('#hintClipGapUse'), immediate: t('#hintImmediate') };
  })()`);
  ok(
    '★ 切回追加后公式行用回 config 的 7500 / 1800',
    /\(N-1\)×7500/.test(backHints['formula'] ?? '') && /random\(0,1800\)/.test(backHints['formula'] ?? ''),
    backHints['formula'] ?? '',
  );
  ok(
    '★ 切回追加后「立即发布」提示回到原来的语义（不再说对切片不生效）',
    !/对切片不生效/.test(backHints['immediate'] ?? '') && /dtime/.test(backHints['immediate'] ?? ''),
    backHints['immediate'] ?? '',
  );
  const schedBack = await cdp.evalJs<Record<string, unknown>>(
    `(async () => { const b = await (await fetch('/api/bootstrap')).json(); return b.publishSchedule || {}; })()`,
  );
  ok(
    '★ 切回追加后生效口径也回到 append（立即发布生效 ⇒ scheduled=false，间隔回到 config 的 7500）',
    schedBack['mode'] === 'append' && schedBack['scheduled'] === false && schedBack['gapSec'] === 7500,
    JSON.stringify(schedBack),
  );

  /* ---------------- 6. 页面健康 ---------------- */
  section('6. 页面健康');
  ok('全程没有未捕获的 JS 异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '));
  ok('任务列表仍渲染（设置改动没影响主流程）', await cdp.evalJs<boolean>(`!!document.querySelector('#taskList')`));
} finally {
  await close();
  await ui.stop();
}

await report();
