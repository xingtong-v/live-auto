/**
 * QA 独立验收：单独投稿（`clipPublishMode='standalone'`）下「相邻切片间隔 / 随机抖动」**按用户设置生效**。
 *
 * ## 为什么单独写一份（而不是复用工程师的自测）
 *
 * 工程师的 `test/standalone-schedule.ts` 已经绿了，但验收要证明的是**口径本身**对，
 * 而不是"他写的那几条断言通过"。所以这里的用例**自己列期望值**（来自需求：
 * 间隔 = max(300, 用户值)、抖动 = min(用户值, 生效间隔 − 30)），
 * 并且刻意覆盖三组**工程师没断言过的输入形状**：
 *
 *   · `500 / 120`  —— 完全放行的常规配置（两个键都应该原样生效）；
 *   · `100 / 900`  —— 间隔被抬到平台底线 300、抖动的夹子上限也跟着间隔变（300−30=270）；
 *   · `500 / 900`  —— 间隔放行、抖动被夹（500−30=470）。
 *
 * 中间那一组是关键：抖动的上限**依赖生效间隔**，先抬再夹还是先夹再抬会得到不同答案，
 * 混了顺序就会在 `100 / 900` 上露出「抖动 900」这种会让排期倒挂的脏值。
 *
 * ## 边界（需求的硬约束，不能破）
 *
 *   · 每片 dtime ≥ **该片自己的提交时刻 + 300 秒**（B站平台底线）；
 *   · 片与片严格递增（抖动再大也不能倒挂）；
 *   · `immediatePublish=true` 在单独投稿下仍要提示「对切片不生效」；
 *   · 干净配置（300 / 0）不得产生任何排期相关告警（不许念经）。
 *
 * 纯函数 + 临时配置：不碰网络、不写盘、绝不读线上 `config.json` 的 `publish` 段。
 */
import {
  DTIME_MIN_MARGIN_SEC,
  STANDALONE_CLIP_GAP_SEC,
  defaults,
  describeScheduleOverride,
  effectiveJitterSec,
  resolveClipPublishSchedule,
  validateConfig,
  type AppConfig,
  type ClipPublishMode,
} from '../src/config.ts';
import {
  computeDtime,
  effectiveJitterSec as effectiveJitterSecFromPublish,
} from '../src/publish.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** 被测口径的最小输入（只给判定真正读的键，其余按默认） */
function schedOf(clipGapSec: number, jitterSec: number, extra: Record<string, unknown> = {}) {
  return resolveClipPublishSchedule({
    clipPublishMode: 'standalone' as ClipPublishMode,
    multiPart: false,
    immediatePublish: false,
    clipGapSec,
    jitterSec,
    ...extra,
  } as never);
}

/* ==========================================================================
 * 1. 纯函数口径：`resolveClipPublishSchedule()` 在 standalone 下的生效值
 * ========================================================================== */
section('1. 纯函数口径：standalone ⇒ 设置里的间隔/抖动确实生效');

{
  const s = schedOf(500, 120);
  eq('500 / 120 ⇒ 间隔 500（原样生效，不再写死 300）', s.gapSec, 500);
  eq('500 / 120 ⇒ 抖动 120（原样生效，不再写死 0）', s.jitterSec, 120);
  eq('500 / 120 ⇒ mode=standalone', s.mode, 'standalone');
  eq('500 / 120 ⇒ scheduled=true（单独投稿恒定定时投稿）', s.scheduled, true);
}

{
  const s = schedOf(100, 900);
  eq('100 / 900 ⇒ 间隔被抬到平台底线 300', s.gapSec, STANDALONE_CLIP_GAP_SEC);
  /* 关键：抖动上限取决于**生效间隔**（300 − 30），不是用户填的 100 − 30 */
  eq('100 / 900 ⇒ 抖动夹到 270（= 生效间隔 300 − 30）', s.jitterSec, 270);
  ok(
    '★ 100 / 900 的 note 同时说清「被抬」与「被夹」（两个原因缺一不可）',
    /300/.test(s.note) && /270/.test(s.note) && /(抬|底线)/.test(s.note) && /(压|夹)/.test(s.note),
    s.note,
  );
}

{
  const s = schedOf(500, 900);
  eq('500 / 900 ⇒ 间隔放行 500', s.gapSec, 500);
  eq('500 / 900 ⇒ 抖动夹到 470（= 500 − 30）', s.jitterSec, 470);
}

{
  /* 越界形状：负数 / 0 / NaN 一律回到「没填」的语义，绝不能把脏值放给 computeDtime */
  const zero = schedOf(0, 0);
  eq('0 / 0 ⇒ 间隔回到 300（保底）', zero.gapSec, 300);
  eq('0 / 0 ⇒ 抖动 0（严格等距）', zero.jitterSec, 0);
  const nan = schedOf(Number.NaN, Number.NaN);
  ok('NaN / NaN ⇒ 间隔 300、抖动 0（NaN 不得流进 dtime）', nan.gapSec === 300 && nan.jitterSec === 0, `${nan.gapSec} / ${nan.jitterSec}`);
  const neg = schedOf(-50, -10);
  ok('负数 / 负数 ⇒ 间隔 300、抖动 0', neg.gapSec === 300 && neg.jitterSec === 0, `${neg.gapSec} / ${neg.jitterSec}`);
}

{
  /* 纯函数连乘性质：抖动必须**严格小于**间隔，否则第 N+1 片会抢在第 N 片之前公开 */
  const cases: Array<[number, number]> = [
    [500, 120],
    [100, 900],
    [500, 900],
    [300, 0],
    [300, 270],
    [301, 271],
    [9999, 9999],
  ];
  const bad = cases.filter(([g, j]) => {
    const s = schedOf(g, j);
    return !(s.jitterSec >= 0 && s.jitterSec < s.gapSec);
  });
  ok('★ 七组输入全部满足 0 ≤ 抖动 < 间隔（排期不倒挂的不变量）', bad.length === 0, JSON.stringify(bad));
}

{
  /* `effectiveJitterSec` 从 publish.ts 搬到 config.ts 后必须仍是**同一个函数** */
  ok(
    '★ effectiveJitterSec 在 config.ts / publish.ts 是同一实现（兼容导出没走样）',
    effectiveJitterSec === effectiveJitterSecFromPublish,
    `config=${String(effectiveJitterSec)} publish=${String(effectiveJitterSecFromPublish)}`,
  );
  eq('effectiveJitterSec(120, 500) = 120', effectiveJitterSec(120, 500), 120);
  eq('effectiveJitterSec(900, 300) = 270', effectiveJitterSec(900, 300), 270);
  eq('effectiveJitterSec(0, 500) = 0', effectiveJitterSec(0, 500), 0);
  eq('effectiveJitterSec(10, 20) = 0（间隔 < 30 时夹到 0）', effectiveJitterSec(10, 20), 0);
}

section('1b. 对照组：append 模式逐字沿用 config（本次改动不得波及老行为）');
{
  const s = resolveClipPublishSchedule({
    clipPublishMode: 'append',
    multiPart: true,
    immediatePublish: false,
    clipGapSec: 500,
    jitterSec: 120,
  } as never);
  ok('append ⇒ gap/jitter 原样（500 / 120）', s.gapSec === 500 && s.jitterSec === 120, `${s.gapSec}/${s.jitterSec}`);
  ok('append ⇒ 不套用 300 保底（用户填 100 就是 100）', resolveClipPublishSchedule({
    clipPublishMode: 'append',
    multiPart: true,
    immediatePublish: false,
    clipGapSec: 100,
    jitterSec: 50,
  } as never).gapSec === 100);
}

/* ==========================================================================
 * 2. dtime 公式：严格递增 + 每片都守住「自己的提交时刻 + 300」+ 抖动方向
 * ========================================================================== */
section('2. computeDtime：递增 / 平台底线 / 抖动方向');

/** 秒级对齐的基准时刻（避免毫秒截断带来的 ±1 噪声） */
const T0 = Math.floor(Date.UTC(2026, 10, 1, 4, 0, 0) / 1000) * 1000;
const SUBMIT_GAP = DTIME_MIN_MARGIN_SEC;

const at = (n: number, opts: { clipGapSec: number; jitterSec: number; rng?: () => number }): number =>
  computeDtime(T0, n, { submitGapSec: SUBMIT_GAP, clipGapSec: opts.clipGapSec, jitterSec: opts.jitterSec, ...(opts.rng ? { rng: opts.rng } : {}) });

{
  /* rng 固定 0 ⇒ 抖动恒为 0 ⇒ 严格等距，且步长必须等于**用户填的间隔** */
  const gap = 500;
  const rng = (): number => 0;
  const seq = [1, 2, 3, 4, 5].map((n) => at(n, { clipGapSec: gap, jitterSec: 120, rng }));
  eq('rng=0 ⇒ 第 1 片 = 提交 + 1200 秒', seq[0]! - Math.floor(T0 / 1000), SUBMIT_GAP);
  const steps = seq.slice(1).map((v, i) => v - seq[i]!);
  ok('★ rng=0 ⇒ 每片步长都是 500（用户设的间隔，不是 300）', steps.every((s) => s === gap), JSON.stringify(steps));
  ok('★ rng=0 ⇒ 严格递增', steps.every((s) => s > 0), JSON.stringify(steps));
}

{
  /* rng 固定 0.999 ⇒ 抖动贴近上限（floor(0.999×cap)），且**永不超过**上限 */
  const cap = 120;
  const rng = (): number => 0.999;
  const seq = [1, 2, 3].map((n) => at(n, { clipGapSec: 500, jitterSec: cap, rng }));
  const base1 = Math.floor(T0 / 1000) + SUBMIT_GAP;
  const jitter1 = seq[0]! - base1;
  ok('★ rng=0.999 ⇒ 第 1 片抖动 = floor(0.999×120) = 119（贴近上限）', jitter1 === 119, `实际 ${jitter1}`);
  ok('抖动不超过上限 120', jitter1 <= cap, `实际 ${jitter1}`);
  ok('抖动随间隔变化：步长 = 500（抖动对每片相同 ⇒ 差值仍是 500）', seq[1]! - seq[0]! === 500, `实际 ${seq[1]! - seq[0]!}`);
}

{
  /* 抖动被夹到 270（间隔 300）时，上限必须跟着夹 —— 这条曾是最容易漏的 */
  const rng = (): number => 0.999;
  const d1 = at(1, { clipGapSec: 300, jitterSec: 900, rng });
  const jitter = d1 - (Math.floor(T0 / 1000) + SUBMIT_GAP);
  eq('间隔 300 / 抖动填 900 ⇒ 实际抖动 ≤ 270（floor(0.999×270)=269）', jitter, 269);
}

{
  /* 平台底线：不管排到第几片、抖动取什么，dtime 都必须 ≥ 该片**自己的**提交时刻 + 300 */
  const submits = [0, 120, 240, 360, 480, 600, 720]; // 每片间隔 120 秒提交（minSubmitIntervalSec 口径）
  let worst = Number.POSITIVE_INFINITY;
  for (let i = 0; i < submits.length; i++) {
    const ownSubmitMs = T0 + submits[i]! * 1000;
    const d = computeDtime(ownSubmitMs, i + 1, { submitGapSec: SUBMIT_GAP, clipGapSec: 300, jitterSec: 270, rng: () => 0 });
    worst = Math.min(worst, d - Math.floor(ownSubmitMs / 1000));
  }
  ok('★ 7 片全部满足「距自己的提交时刻 ≥ 300 秒」（B站底线不破）', worst >= 300, `最差余量 ${worst} 秒`);
  ok('且本项目自律余量也够（≥ 1200 秒）', worst >= DTIME_MIN_MARGIN_SEC, `最差余量 ${worst} 秒`);
}

{
  /* 随机抖动下也绝不能倒挂：跑 2000 组随机 rng，逐片比较 */
  let inversions = 0;
  for (let round = 0; round < 2000; round++) {
    let prev = -1;
    for (let n = 1; n <= 6; n++) {
      const d = at(n, { clipGapSec: 500, jitterSec: 470 });
      if (d <= prev) inversions++;
      prev = d;
    }
  }
  eq('★ 2000 组随机抖动的 12000 个 dtime 里没有一次倒挂', inversions, 0);
}

/* ==========================================================================
 * 3. describeScheduleOverride / validateConfig：提示说真话、干净配置不念经
 * ========================================================================== */
section('3. 提示与校验：改动后既不许漏说，也不许乱说');

/** 用 defaults()（= config.example.json + 内置兜底）造一份只改 publish 的配置 */
function cfgWith(publish: Partial<AppConfig['publish']>): AppConfig {
  const base = defaults();
  return { ...base, publish: { ...base.publish, ...publish } };
}

function scheduleIssues(cfg: AppConfig): Array<{ level: string; field: string; message: string }> {
  const fields = new Set(['publish.clipGapSec', 'publish.jitterSec', 'publish.immediatePublish']);
  return validateConfig(cfg).filter((i) => fields.has(i.field));
}

{
  const clean = cfgWith({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 300, jitterSec: 0 });
  const issues = scheduleIssues(clean);
  ok('★ 干净配置（300 / 0）不产生任何排期告警', issues.length === 0, JSON.stringify(issues));
  eq('★ 干净配置的 describeScheduleOverride 返回空串（没话就别念）', describeScheduleOverride(clean.publish), '');
}

{
  const good = cfgWith({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 500, jitterSec: 120 });
  ok('500 / 120 也不该被告警（用户设置被完全尊重）', scheduleIssues(good).length === 0, JSON.stringify(scheduleIssues(good)));
  eq('500 / 120 没有需要说明的偏离', describeScheduleOverride(good.publish), '');
}

{
  const imm = cfgWith({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: true, clipGapSec: 500, jitterSec: 120 });
  const issues = scheduleIssues(imm);
  const target = issues.find((i) => i.field === 'publish.immediatePublish');
  ok('★ immediatePublish=true 仍提示「对切片不生效」', target !== undefined && /不生效/.test(target.message), JSON.stringify(issues));
  ok(
    '★ 该提示说清「为什么」+「完整版仍按它走」（否则用户会以为整个开关坏了）',
    target !== undefined && /定时投稿/.test(target.message) && /完整版/.test(target.message),
    target?.message ?? '(无)',
  );
  ok(
    'describeScheduleOverride 也提到 immediatePublish（界面 ignored 行有来源）',
    /immediatePublish/.test(describeScheduleOverride(imm.publish)),
    describeScheduleOverride(imm.publish),
  );
}

{
  const lowGap = cfgWith({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 100, jitterSec: 0 });
  const issue = scheduleIssues(lowGap).find((i) => i.field === 'publish.clipGapSec');
  ok('★ 间隔 100 被告警为「低于平台底线」', issue !== undefined && /300/.test(issue.message), JSON.stringify(scheduleIssues(lowGap)));
  ok(
    '★ 且说清实际按多少跑（用户填的 100 ⇒ 实际 300）',
    issue !== undefined && /实际按 300/.test(issue.message),
    issue?.message ?? '(无)',
  );
}

{
  const bigJitter = cfgWith({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 500, jitterSec: 900 });
  const issue = scheduleIssues(bigJitter).find((i) => i.field === 'publish.jitterSec');
  ok('★ 抖动 900 + 间隔 500 被告警为「被压到 470」', issue !== undefined && /470/.test(issue.message), JSON.stringify(scheduleIssues(bigJitter)));
}

{
  /* 反例守卫：生效值合法的组合**不得**因为原始值越界而报警（否则就是假告警） */
  const looksBad = cfgWith({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 100, jitterSec: 200 });
  const jitterIssue = scheduleIssues(looksBad).find((i) => i.field === 'publish.jitterSec');
  ok(
    '100 / 200 在单独投稿下实际是 300 / 200（合法）⇒ 不得报抖动告警',
    jitterIssue === undefined,
    JSON.stringify(jitterIssue ?? null),
  );
  ok(
    '但间隔那条仍要报（100 确实被抬到 300）',
    scheduleIssues(looksBad).some((i) => i.field === 'publish.clipGapSec'),
    JSON.stringify(scheduleIssues(looksBad)),
  );
}

/* ==========================================================================
 * 汇总
 * ========================================================================== */
console.log('\n' + '─'.repeat(72));
console.log(`\x1b[1m验收集（纯函数 + 校验）：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
