/**
 * 真浏览器复验：流水线里的**精确**转写进度（2026-10-15，用户需求「精确进度」）。
 *
 * 与 `tools/verify-transcribe-progress.ts`（第 96 节的**估算**版）的区别：
 *   · 那一条只要求出现「转写进度 N%（估算）」—— 数字是**猜**的也算过；
 *   · 这一条要求服务端给出**实测**字段（`pct` / `audioDoneSec` / `audioTotalSec` / `etaSec` / `phase`），
 *     界面上出现「X / Y 音频」，并且**不再**出现「（估算）」字样（有实测就不该同时显示猜的值）。
 *
 * 前提：**必须有一个任务正在转写**（本地 ASR 才会上报细粒度进度）。
 * 直播期间的"边录边转"会一直跑，所以通常等一两分钟就有；等不到就如实判失败并打印原因，
 * 不许"没数据也算过"（那正是这类验收最容易变成摆设的地方）。
 */
import { sleep } from '../src/util.ts';
import { launchBrowser, ok, report, shotPath } from './ui-shared.ts';

const BASE = 'http://127.0.0.1:3000';
const WAIT_TX_SEC = Number(process.env['WAIT_TX_SEC'] ?? 180);

interface PipelineRow {
  id?: string;
  status?: string;
  title?: string;
  progress?: {
    label?: string;
    pct?: number;
    phase?: string;
    audioDoneSec?: number;
    audioTotalSec?: number;
    etaSec?: number | null;
    speed?: number | null;
    chunksDone?: number;
    chunksTotal?: number;
    startedAt?: string;
    updatedAt?: string;
  } | null;
}

/** 等到"有一个正在转写、且服务端给了实测字段"的任务 */
async function waitForMeasured(): Promise<PipelineRow | undefined> {
  const deadline = Date.now() + WAIT_TX_SEC * 1000;
  let last = '';
  for (;;) {
    try {
      const j = (await (await fetch(`${BASE}/api/monitor`)).json()) as { pipeline?: PipelineRow[] };
      const rows = j.pipeline ?? [];
      const tx = rows.filter((r) => r.status === 'TRANSCRIBING');
      const measured = tx.find((r) => typeof r.progress?.pct === 'number' && Number(r.progress?.audioTotalSec) > 0);
      if (measured) return measured;
      last = tx.length
        ? `有 ${tx.length} 个转写中任务，但都还没有实测字段（progress=${JSON.stringify(tx[0]?.progress ?? null)}）—— 多半是**服务还在跑旧代码**`
        : `当前没有转写中的任务（活跃 ${rows.length} 个）`;
    } catch (e) {
      last = `接口失败：${(e as Error).message}`;
    }
    if (Date.now() > deadline) {
      console.log(`  \x1b[31m✗\x1b[0m 等不到"有实测字段的转写任务"（${WAIT_TX_SEC}s）：${last}`);
      return undefined;
    }
    await sleep(5000);
  }
}

console.log('\x1b[1m流水线 · 精确转写进度（真浏览器 + 实测字段）\x1b[0m');
console.log('─'.repeat(74));

const target = await waitForMeasured();
if (!target) {
  ok('★ 等到了带实测字段的转写任务', false, '没有数据就不判过');
  await report();
  process.exit(1);
}
const g = target.progress!;
console.log(`  接口给的实测进度：pct=${g.pct}% phase=${g.phase} 音频 ${g.audioDoneSec}/${g.audioTotalSec}s ` +
  `eta=${g.etaSec === null || g.etaSec === undefined ? '计算中' : `${g.etaSec}s`} speed=${g.speed ?? '—'} 块 ${g.chunksDone}/${g.chunksTotal}`);
ok('★ 接口给出实测百分比（不再只有 current/total 块数）', typeof g.pct === 'number' && g.pct >= 0 && g.pct <= 100, String(g.pct));
ok('★ 接口给出已转写/总音频秒（"已经转写多少"有据可依）', Number(g.audioTotalSec) > 0 && Number(g.audioDoneSec) >= 0, `${g.audioDoneSec}/${g.audioTotalSec}`);
ok('★ 接口给出阶段文案（识别中/加载模型/语音切句/抽取音频）', typeof g.phase === 'string' && g.phase.length > 0, String(g.phase));
ok('接口给出阶段开始时刻（不再是页面自己造的锚点）', typeof g.startedAt === 'string' && g.startedAt.length > 0, String(g.startedAt));
ok('剩余时间要么是数字、要么明确是"算不出来"（null），不许是 NaN/undefined', g.etaSec === null || (typeof g.etaSec === 'number' && Number.isFinite(g.etaSec)), String(g.etaSec));

const { cdp, close } = await launchBrowser({ port: 9437, headed: false, windowSize: '1500,1000' });
try {
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(3000);
  await cdp.evalJs(`(() => { const t = document.querySelector('#tabs .tab[data-view="monitor"]'); if (t) t.click(); return true; })()`);
  /* 等两轮 5 秒刷新：第一轮拿数据，第二轮渲染 */
  await sleep(12000);
  const r = await cdp.evalJs<{ txt: string; rows: string[]; dbg: unknown }>(`(() => {
    const page = document.getElementById("otherPage");
    const txt = String(page && page.textContent || "").replace(/\\s+/g, " ");
    const tr = [...document.querySelectorAll("#otherPage .tbl tbody tr")];
    return {
      txt,
      rows: tr.map((x) => String(x.textContent).replace(/\\s+/g, " ").trim()).filter((x) => /转写/.test(x)),
      dbg: (window.__txDebug && Object.values(window.__txDebug)) || null,
    };
  })()`);
  for (const row of r.rows) console.log('   页面上那行：' + row.slice(0, 200));

  ok('★ 页面上出现「转写进度 N%」', /转写进度\s*\d+%/.test(r.txt), r.txt.slice(Math.max(0, r.txt.indexOf('流水线')), r.txt.indexOf('流水线') + 220));
  ok('★ 页面上出现「X / Y 音频」（已转写多少、总共多少）', /转写进度\s*\d+%\s*·[\s\S]{0,40}?\/[\s\S]{0,24}?音频/.test(r.txt), r.txt.slice(Math.max(0, r.txt.indexOf('转写进度')), r.txt.indexOf('转写进度') + 120));
  ok('★ 有实测数据时**不再**显示「（估算）」', !/（估算）/.test(r.txt.slice(Math.max(0, r.txt.indexOf('流水线')), r.txt.indexOf('在等什么'))), '流水线块里出现了估算字样');
  ok('阶段条上显示的是百分比（而不是 1/4 这种块数）', /转写\s*\d+%/.test(r.txt) || new RegExp(`${g.pct}%`).test(r.txt), r.txt.slice(Math.max(0, r.txt.indexOf('流水线')), r.txt.indexOf('流水线') + 220));
  /* 剩余时间：有速度就必须给出数字；还没测到速度就必须如实写"计算中"（不许拿标称速度冒充） */
  if (typeof g.etaSec === 'number') {
    ok('★ 页面上出现「还需约 X」（剩余时间来自实测速度，不是标称值）', /还需约\s*[\d]+\s*[分秒小时]+/.test(r.txt), r.txt.slice(Math.max(0, r.txt.indexOf('转写进度')), r.txt.indexOf('转写进度') + 140));
    ok('★ 有数字就不该再写"计算中"', !/计算中/.test(r.txt.slice(Math.max(0, r.txt.indexOf('流水线')), r.txt.indexOf('在等什么'))), '流水线块里同时出现了"还需约"与"计算中"');
  } else {
    ok('接口还没测到速度 ⇒ 页面写"计算中"，而不是猜一个数', /计算中/.test(r.txt) && !/还需约/.test(r.txt.slice(Math.max(0, r.txt.indexOf('转写进度')))), r.txt.slice(Math.max(0, r.txt.indexOf('转写进度')), r.txt.indexOf('转写进度') + 140));
  }
  ok('全程无未捕获异常', cdp.errors.length === 0, cdp.errors[0]?.slice(0, 160));

  const shot = shotPath('tx-precise');
  await cdp.shot(shot);
  console.log(`  \x1b[90m截图：${shot}\x1b[0m`);
} finally {
  await close();
}
await report();
