/**
 * 线上排期体检（只读）：用**生产代码**算一遍「切片什么时候发」，并核对服务端预览与它同口径。
 *
 * ## 为什么要有这个工具
 *
 * 「每片隔多久」这件事没有一个地方能一眼看全：
 *   · config 里的 `clipGapSec` / `jitterSec` 在「单独投稿」下**是生效的**（2026-10-17 起），
 *     但有两条硬边界：间隔不得低于平台底线 300 秒、抖动必须小于间隔（防排期倒挂）；
 *   · 唯一真值是 `resolveClipPublishSchedule()`（别在这里手抄公式）；
 *   · 界面预览按 `clip.maxCandidates` 片算，而真实投稿是**逐片**提交的（每片切完+上传完才投）。
 *
 * 2026-10-16 复核时我（AI）自己手搓过一份公式，算出「间隔 270~342 秒，期望 300~360」并报失败
 * —— 那是**模型错**，不是产品错：既没走 `resolveClipPublishSchedule`，
 * 又把「抖动只往后推」当成了「相邻间隔 ∈ [gap, gap+cap]」（实际每片独立 ⇒ [gap−cap, gap+cap]）。
 * 这个工具存在的意义就是：**永远问生产代码要答案**，不再手抄公式。
 *
 * ## 两种模式都支持
 *
 * 期望值全部由 `resolveClipPublishSchedule()` 推出，所以用户把「切片投稿方式」切回
 * 「追加切片投稿」后本工具照样成立（那时才轮到 config 的 clipGapSec / jitterSec 生效）。
 *
 * 只读：只 GET `/api/bootstrap`、`/api/monitor`、`/api/tasks`，不改配置、不投任何稿。
 *
 * 用法：node tools/verify-dtime-plan.ts [--base http://127.0.0.1:3000]
 */
import { DTIME_MIN_MARGIN_SEC, STANDALONE_CLIP_GAP_SEC, resolveClipPublishSchedule } from '../src/config.ts';
import { computeDtime, effectiveJitterSec } from '../src/publish.ts';

const argv = process.argv.slice(2);
const iBase = argv.indexOf('--base');
const BASE = iBase >= 0 ? String(argv[iBase + 1] ?? '') : (process.env['LAI_VERIFY_BASE'] ?? 'http://127.0.0.1:3000');

let bad = 0;
const check = (okFlag: boolean, label: string, detail = ''): void => {
  if (!okFlag) bad++;
  console.log(`  ${okFlag ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? `　${detail}` : ''}`);
};
const fmt = (sec: number): string => new Date(sec * 1000).toLocaleString('zh-CN');
const secs = (n: number): string => `${n} 秒`;

interface PubCfg {
  clipPublishMode?: string;
  multiPart?: boolean;
  immediatePublish?: boolean;
  clipGapSec?: number;
  jitterSec?: number;
  submitGapSec?: number;
  firstPublishAt?: string;
}
interface Boot {
  config?: { publish?: PubCfg; clip?: { maxCandidates?: number } };
  issues?: Array<{ level: string; field: string; message: string }>;
  dtimePlan?: { first?: number; last?: number; firstText?: string; lastText?: string; gapSec?: number; scheduled?: boolean; note?: string };
  version?: string;
}

const boot = (await (await fetch(`${BASE}/api/bootstrap`)).json()) as Boot;
const p = boot.config?.publish ?? {};
const maxCand = Math.max(1, Number(boot.config?.clip?.maxCandidates ?? 1));

console.log(`目标：${BASE}（线上服务，本次只读）\n`);
console.log('== 1) 线上配置 ==');
for (const k of ['clipPublishMode', 'multiPart', 'immediatePublish', 'clipGapSec', 'jitterSec', 'submitGapSec', 'firstPublishAt'] as const) {
  console.log(`  ${k.padEnd(18)} = ${JSON.stringify(p[k])}`);
}
const errs = (boot.issues ?? []).filter((x) => x.level === 'error');
const warns = (boot.issues ?? []).filter((x) => x.level !== 'error');
console.log(`  启动自检：错误 ${errs.length} 条、警告/提示 ${warns.length} 条`);
for (const w of errs.concat(warns).slice(0, 10)) console.log(`    [${w.level}] ${w.field}: ${w.message}`);

/* ---- 生效口径：唯一真值来源 ---- */
const gap = Number(p.clipGapSec ?? 0);
const jitter = Number(p.jitterSec ?? 0);
const submitGapSec = Number(p.submitGapSec ?? 0);
const sched = resolveClipPublishSchedule({
  clipPublishMode: p.clipPublishMode === 'standalone' ? 'standalone' : 'append',
  multiPart: p.multiPart === true,
  immediatePublish: p.immediatePublish === true,
  clipGapSec: gap,
  jitterSec: jitter,
});
const effJitter = sched.jitterSec;
const effGap = sched.gapSec;
/** 抖动每片独立 ⇒ 相邻间隔落在 [间隔 − 抖动, 间隔 + 抖动]（别写成 [间隔, 间隔+抖动]，这是本仓 2026-10-16 踩过的坑） */
const minAdjacent = effGap - effJitter;

console.log('\n== 2) 生效口径（resolveClipPublishSchedule，生产代码） ==');
console.log(`  mode=${sched.mode}  scheduled=${sched.scheduled}  间隔=${secs(effGap)}  抖动=${secs(effJitter)}`);
console.log(`  ${sched.note}`);
check(sched.scheduled === true, '切片走定时投稿（立即发布不传 dtime，「每片几分钟」就无从谈起）', String(sched.scheduled));
if (sched.mode === 'standalone') {
  check(
    effGap === Math.max(STANDALONE_CLIP_GAP_SEC, gap),
    `生效间隔 = max(${STANDALONE_CLIP_GAP_SEC}, clipGapSec)（平台底线保底，可往上调）`,
    `config=${gap} 生效=${effGap}`,
  );
  check(
    effJitter === effectiveJitterSec(jitter, effGap),
    '生效抖动 = min(jitterSec, 生效间隔−30)（与追加模式同一道夹子）',
    `config=${jitter} 生效=${effJitter}`,
  );
  if (effJitter < jitter) console.log(`  ⚠ 你填的抖动 ${jitter} 秒被压到 ${effJitter} 秒（抖动必须小于片间隔）`);
  if (gap < effGap) console.log(`  ⚠ 你填的间隔 ${gap} 秒低于平台底线，实际按 ${effGap} 秒`);
}

console.log('\n== 3) 服务端预览 vs 生产代码（同一口径？） ==');
const plan = boot.dtimePlan ?? {};
const nowMs = Date.now();
/* 首片 = 提交 + submitGapSec + (0~抖动)。**不能**跟"本地再算一次随机值"逐秒比对 ——
   抖动是随机的，两次调用必然不同（2026-10-16 就因此报过一次假失败）。 */
check(Number(plan.gapSec ?? -1) === effGap, '预览用的间隔 = 生效间隔', `预览 ${String(plan.gapSec)} / 生效 ${effGap}`);
check(plan.scheduled === sched.scheduled, '预览的定时/立即口径 = 生效口径', `预览 ${String(plan.scheduled)}`);
const firstOffset = Number(plan.first ?? 0) - Math.floor(nowMs / 1000);
check(
  firstOffset >= submitGapSec && firstOffset <= submitGapSec + effJitter + 2,
  `预览首片 = 提交时刻 + ${submitGapSec} 秒 + (0~${effJitter} 抖动)`,
  `实测偏移 ${firstOffset} 秒`,
);
const span = Number(plan.last ?? 0) - Number(plan.first ?? 0);
/* 带抖动时首末片跨度是随机的（每片独立 random）⇒ 容差 2×抖动上限 */
check(
  Math.abs(span - (maxCand - 1) * effGap) <= 2 * effJitter,
  `首末片跨度 ≈ (${maxCand}−1)×${effGap} 秒（±2×抖动 ${effJitter}）`,
  `实际 ${span} 秒`,
);
check(Number(plan.first ?? 0) - Math.floor(nowMs / 1000) >= DTIME_MIN_MARGIN_SEC, `首片距提交 ≥ ${DTIME_MIN_MARGIN_SEC} 秒（硬约束 #4）`, `${Number(plan.first ?? 0) - Math.floor(nowMs / 1000)} 秒`);
console.log(`  预览：首片 ${String(plan.firstText)} → 末片 ${String(plan.lastText)}（${maxCand} 片）`);

console.log(`\n== 4) 8 片时间线（computeDtime + 生效口径） ==`);
const dts: number[] = [];
for (let n = 1; n <= 8; n++) {
  dts.push(computeDtime(nowMs, n, { submitGapSec, clipGapSec: sched.gapSec, jitterSec: effJitter }));
}
let minGap = Number.POSITIVE_INFINITY;
let maxGap = 0;
for (let i = 0; i < dts.length; i++) {
  const d = dts[i]!;
  if (i > 0) {
    const g = d - dts[i - 1]!;
    minGap = Math.min(minGap, g);
    maxGap = Math.max(maxGap, g);
  }
  console.log(`  第 ${i + 1} 片：${fmt(d)}　距提交 +${Math.round((d - nowMs / 1000) / 60)} 分钟${i ? `　距上一片 ${d - dts[i - 1]!} 秒` : ''}`);
}
check(dts.every((d, i) => i === 0 || d > dts[i - 1]!), '严格递增（无排期倒挂）');
check(minGap >= minAdjacent, `相邻间隔 ≥ 生效间隔 − 抖动（${secs(minAdjacent)}）`, `实测 ${minGap}~${maxGap} 秒`);
if (effJitter === 0) check(minGap === sched.gapSec && maxGap === sched.gapSec, '抖动为 0 ⇒ 严格等距', `实测 ${minGap}~${maxGap} 秒`);

console.log('\n== 5) 真实路径：逐片提交（各自上传耗时不同） ==');
/* 线上真实路径：`n` = 24 小时内已提交数 + 1，`submitTimeMs` = **该片自己的**提交时刻，
   所以相邻 dtime 差 = 该片与上一片的提交耗时差 + 间隔（±抖动）。 */
for (const uploadSec of [30, 90, 180, 600]) {
  const real: number[] = [];
  let own = Math.floor(nowMs / 1000);
  for (let n = 1; n <= 8; n++) {
    real.push(computeDtime(own * 1000, n, { submitGapSec, clipGapSec: sched.gapSec, jitterSec: effJitter }));
    own += uploadSec;
  }
  const gaps = real.slice(1).map((d, i) => d - real[i]!);
  const lo = Math.min(...gaps);
  const wantMin = uploadSec + sched.gapSec - effJitter;
  check(lo >= wantMin, `每片上传耗时 ${uploadSec} 秒：相邻间隔 ≥ ${wantMin} 秒`, `实测 ${lo}~${Math.max(...gaps)} 秒`);
  let ownMs = nowMs;
  let worst = Number.POSITIVE_INFINITY;
  for (let n = 1; n <= 8; n++) {
    worst = Math.min(worst, real[n - 1]! - Math.floor(ownMs / 1000));
    ownMs += uploadSec * 1000;
  }
  check(worst >= DTIME_MIN_MARGIN_SEC, `...且每片距**自己**的提交时刻 ≥ ${DTIME_MIN_MARGIN_SEC} 秒`, `最差余量 ${worst} 秒`);
}

console.log('\n== 6) 服务与队列现状 ==');
const mon = (await (await fetch(`${BASE}/api/monitor`)).json()) as {
  queue?: { busy?: boolean; length?: number };
  pipeline?: Array<Record<string, unknown>>;
  uptimeSec?: number;
  roomId?: unknown;
  platform?: unknown;
  recordingNow?: unknown;
  watch?: unknown;
  scheduled?: unknown;
  waiting?: unknown;
  todayPublished?: unknown;
  dailyLimit?: unknown;
  errorsLast24h?: unknown;
  errors?: unknown;
};
const show = (v: unknown, n = 200): string => (v === undefined ? '(无)' : String(JSON.stringify(v)).slice(0, n));
console.log(`  队列：busy=${String(mon.queue?.busy)} length=${String(mon.queue?.length)}`);
console.log(`  值守：roomId=${show(mon.roomId, 40)} platform=${show(mon.platform, 20)} watch=${show(mon.watch, 160)}`);
console.log(`  正在录：${show(mon.recordingNow, 160)}`);
console.log(`  待办：waiting=${show(mon.waiting, 120)} scheduled=${show(mon.scheduled, 160)}`);
console.log(`  今日投稿：${show(mon.todayPublished, 60)} / 每日上限 ${show(mon.dailyLimit, 40)}　近 24h 报错 ${show(mon.errorsLast24h, 60)}`);
const errList = Array.isArray(mon.errors) ? (mon.errors as Array<Record<string, unknown>>) : [];
for (const e of errList.slice(0, 3)) {
  console.log(`    报错：${String(e['at'] ?? e['ts'] ?? '')} ${String(e['stage'] ?? e['scope'] ?? '')} ${String(e['message'] ?? '').slice(0, 120)}`);
}
console.log(`  服务已运行：${String(Math.round(Number(mon.uptimeSec ?? 0) / 60))} 分钟`);
for (const t of mon.pipeline ?? []) console.log(`  流水线：${String(t['id'])} ${String(t['status'])}`);
const tasksRes = (await (await fetch(`${BASE}/api/tasks?limit=8`)).json()) as {
  tasks?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
};
for (const t of tasksRes.tasks ?? tasksRes.items ?? []) {
  console.log(`  任务：${String(t['id']).padEnd(26)} ${String(t['status']).padEnd(12)} ${String(t['title'] ?? '').slice(0, 26)}`);
}
console.log(`  服务版本：${String(boot.version ?? '?')}`);

console.log(`\n${bad === 0 ? '\x1b[32m✅ 全部通过\x1b[0m' : `\x1b[31m❌ ${bad} 项不通过\x1b[0m`}`);
/* 不用 process.exit()：本脚本用过 fetch，退出时 undici 的异步句柄可能还在关闭中，
   硬退出会让 Node 在 Windows 上 fail-fast（实测 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，
   file src\win\async.c，退出码 0xC0000409 —— 全部通过却看起来像崩了）。 */
process.exitCode = bad === 0 ? 0 : 6;
