/**
 * 切片发布排期（`computeDtime` / `effectiveJitterSec` / `clampDtimeForSubmit`）—— 2026-10-16 加。
 *
 * 背景（用户口径变更）：「我的定时发布后续定为每个切片间隔 5 分钟发布」⇒ `clipGapSec = 300`。
 * 这个改动同时暴露了两个**必须用断言钉住**的性质（都不是文案问题）：
 *
 *   1. **抖动必须严格小于片间隔**，否则排期倒挂：抖动是每片独立随机的，
 *      间隔 300 + 抖动上限 1800 时，第 1 片能抽到 +1799、第 2 片抽到 +0
 *      ⇒ 第 2 片比第 1 片先公开（观众看到的顺序是乱的）。原来间隔 7500 > 抖动 1800
 *      时这个 bug 被掩盖着，间隔一改小就现形。`effectiveJitterSec()` 是那道夹子。
 *   2. **硬约束 #4 是按「该稿件自己的提交时刻」算的**：排期拿的是批次开始时刻，
 *      而真正调接口是逐片往后推的。上传一慢，靠后的片就可能「提交后不足 1200 秒」被拒稿。
 *      `clampDtimeForSubmit()` 是提交前的最后一道复核。
 *
 * 纯函数测试：不碰网络、不写盘、不看真实 config.json（口令值一律显式给）。
 */
import {
  clampDtimeForSubmit,
  computeDtime,
  describeDtimePlan,
  effectiveJitterSec,
  validateDtime,
} from '../src/publish.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  DTIME_MIN_MARGIN_SEC,
  defaults,
  describeScheduleOverride,
  loadConfig,
  resolveClipPublishSchedule,
  validateConfig,
  type AppConfig,
} from '../src/config.ts';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

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
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/** 固定基准时刻（秒级对齐，避免毫秒截断带来的 ±1 噪声） */
const T0 = Math.floor(Date.UTC(2026, 9, 16, 4, 0, 0) / 1000) * 1000;
const CFG_5MIN = { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: 300, jitterSec: 0 };
const at = (n: number, cfg = CFG_5MIN): number => computeDtime(T0, n, cfg);

section('1. 每片 5 分钟（用户口径）：严格等距 + 首片余量合规');
{
  eq('首片 = 提交 + 1200 秒', at(1) - T0 / 1000, DTIME_MIN_MARGIN_SEC);
  eq('第 2 片 = 首片 + 300 秒', at(2) - at(1), 300);
  eq('第 3 片 = 首片 + 600 秒', at(3) - at(1), 600);
  eq('第 10 片 = 首片 + 2700 秒（整场 45 分钟发完）', at(10) - at(1), 2700);
  const head = validateDtime(at(1), T0);
  ok('★ 首片距提交 1200 秒 ⇒ 合规（≥ 1200）', head.ok, head.note);
  // 逐片复核：第 N 片的 dtime − 它自己的提交时刻（按 minSubmitIntervalSec=120 递推）仍 ≥ 1200
  let worst = Number.POSITIVE_INFINITY;
  for (let n = 1; n <= 10; n++) {
    const ownSubmitMs = T0 + (n - 1) * 120_000;
    worst = Math.min(worst, at(n) - Math.floor(ownSubmitMs / 1000));
  }
  ok('★ 10 片全部满足「距自己的提交时刻 ≥ 1200 秒」（最差那片也够）', worst >= DTIME_MIN_MARGIN_SEC, `最差余量 ${worst} 秒`);
}

section('2. 抖动夹子：抖动 ≥ 片间隔时排期会倒挂（这就是那个 bug）');
{
  eq('间隔 300 + 抖动 1800 ⇒ 有效抖动被压到 270', effectiveJitterSec(1800, 300), 270);
  eq('抖动 0 ⇒ 保持 0（严格等距）', effectiveJitterSec(0, 300), 0);
  eq('抖动 60 < 间隔 300 ⇒ 原样保留', effectiveJitterSec(60, 300), 60);
  eq('间隔 7500（老值）+ 抖动 1800 ⇒ 不做任何改动（向后兼容）', effectiveJitterSec(1800, 7500), 1800);
  eq('间隔小到 20 秒 ⇒ 夹到 0（不给负值）', effectiveJitterSec(600, 20), 0);

  // 最坏情形：第 1 片抽到最大抖动、第 2 片抽到最小 —— 夹子生效时必须仍严格递增
  const worstCase = { ...CFG_5MIN, jitterSec: 1800, rng: undefined as undefined | (() => number) };
  const first = computeDtime(T0, 1, { ...worstCase, rng: () => 0.999999 });
  const second = computeDtime(T0, 2, { ...worstCase, rng: () => 0 });
  ok('★ 最坏情形下第 2 片仍晚于第 1 片（不倒挂）', second > first, `第1片 +${first - T0 / 1000}s，第2片 +${second - T0 / 1000}s`);

  // 100 组随机抖动：任意组合都必须严格递增（单调性是不变量，不是"通常成立"）
  let inversions = 0;
  for (let i = 0; i < 100; i++) {
    const r = (): number => Math.random();
    const seq = [1, 2, 3, 4, 5].map((n) => computeDtime(T0, n, { ...worstCase, rng: r }));
    for (let k = 1; k < seq.length; k++) if (!(seq[k]! > seq[k - 1]!)) inversions++;
  }
  eq('★ 500 次随机抽样：逆序 0 次', inversions, 0);
}

section('3. 提交前复核（clampDtimeForSubmit）：慢上传不会把片挤到拒稿区');
{
  const legal = clampDtimeForSubmit(at(1), T0);
  ok('余量够 ⇒ 不动它', legal.bumped === false && legal.dtime === at(1), JSON.stringify(legal));

  // 上传比排期慢了 10 分钟：这一片自己的提交时刻已经贴上 dtime
  const lateSubmitMs = at(1) * 1000 - 600_000;
  const g = clampDtimeForSubmit(at(1), lateSubmitMs);
  ok('★ 余量只剩 600 秒 ⇒ 触发修正', g.bumped === true, JSON.stringify(g));
  eq('修正到「提交时刻 + 1200」', g.dtime, Math.floor(lateSubmitMs / 1000) + DTIME_MIN_MARGIN_SEC);
  ok('★ 修正后的时间本身合规', validateDtime(g.dtime, lateSubmitMs).ok, validateDtime(g.dtime, lateSubmitMs).note);
  ok('修正说明是人话（点出 1200 与提交比排期慢）', /1200/.test(g.note) && /提交/.test(g.note), g.note);

  // 边界：正好 1200 秒 —— 判据是 **≥**（含等号），所以放行
  const exactly = clampDtimeForSubmit(Math.floor(T0 / 1000) + DTIME_MIN_MARGIN_SEC, T0);
  ok('★ 正好 1200 秒 ⇒ 放行（要求 ≥ 1200，含等号）', exactly.bumped === false, JSON.stringify(exactly));
  // 差一秒就不行
  const justUnder = clampDtimeForSubmit(Math.floor(T0 / 1000) + DTIME_MIN_MARGIN_SEC - 1, T0);
  ok('★ 1199 秒 ⇒ 判定不合规并修正', justUnder.bumped === true, JSON.stringify(justUnder));
}

section('4. 说明文案（describeDtimePlan）：首末片时间与「被推迟」原因');
{
  const plan = describeDtimePlan(T0, { ...CFG_5MIN, firstPublishAt: '' }, 6);
  eq('首片 = 提交 + 1200 秒', plan.first - T0 / 1000, DTIME_MIN_MARGIN_SEC);
  eq('末片（6 片）= 首片 + 1500 秒', plan.last - plan.first, 1500);
  eq('用户没指定时间 ⇒ userSpecified=false', plan.userSpecified, false);
  /* 注意：`firstPublishAt` 走 `parseFirstPublishAt()`，那里会丢掉「早于当前 1 小时前」的值
     （防用户把旧时间粘进来）。所以这里必须用**相对当前时刻**构造指定时间，
     不能用固定 T0 基准 —— 否则今天跑测试时 T0 已是过去，值被悄悄丢掉，
     `want` 恒为 undefined，断言就会退化成"默认文案也匹配"的假通过。 */
  const now = Date.now();
  const want = Math.floor(now / 1000) + 600; // 比下限早 600 秒
  const pad = (n: number): string => String(n).padStart(2, '0');
  const d = new Date(want * 1000);
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const plan2 = describeDtimePlan(now, { ...CFG_5MIN, firstPublishAt: local }, 2);
  ok('指定时间早于下限 ⇒ 会被推迟（文案说明原因）', /推迟/.test(plan2.note) && /1200/.test(plan2.note), plan2.note);
  eq('推迟后落点是下限（提交 + 1200）', plan2.first - Math.floor(now / 1000), DTIME_MIN_MARGIN_SEC);
}

section('5. 配置门禁：假告警去掉、真不变量保留');
{
  const mk = (patch: Record<string, unknown>): AppConfig => {
    const c = loadConfig().config;
    return { ...c, publish: { ...c.publish, ...patch } } as AppConfig;
  };
  const issues = (c: AppConfig) => validateConfig(c);
  const fields = (c: AppConfig, level: string): string[] =>
    issues(c)
      .filter((i) => i.level === level)
      .map((i) => i.field);

  const fiveMin = mk({ clipGapSec: 300, jitterSec: 0 });
  ok('★ 300 秒（5 分钟）不再产生任何告警 —— 这是我们的错峰值，不是平台规则', !fields(fiveMin, 'warn').includes('publish.clipGapSec'), fields(fiveMin, 'warn').join(','));
  ok('★ 也不再产生错误', !fields(fiveMin, 'error').includes('publish.clipGapSec'));

  const tiny = mk({ clipGapSec: 10, jitterSec: 0 });
  ok('间隔 10 秒（≈同时发布）仍会告警', fields(tiny, 'warn').includes('publish.clipGapSec'), fields(tiny, 'warn').join(','));

  const jittery = mk({ clipGapSec: 300, jitterSec: 1800 });
  ok('★ 抖动 ≥ 间隔 ⇒ 告警「可能倒挂」并说明会自动压小', fields(jittery, 'warn').includes('publish.jitterSec'), fields(jittery, 'warn').join(','));

  const badSubmit = mk({ submitGapSec: DTIME_MIN_MARGIN_SEC - 1 });
  ok(`submitGapSec = ${DTIME_MIN_MARGIN_SEC - 1} 仍是硬错误（要求 ≥ ${DTIME_MIN_MARGIN_SEC}）`, fields(badSubmit, 'error').includes('publish.submitGapSec'), fields(badSubmit, 'error').join(','));
}

section('6. 默认值口径（新装 = 每片 5 分钟等距）');
{
  // 断言的是**代码默认**（与用户那份 config.json 无关）：`loadConfig()` 会把用户文件合并上来，
  // 用它断言默认值会被用户改动带跑（实测踩过：期望 300 实际 7500 的假失败）。
  const d = defaults();
  eq('publish.clipGapSec 默认 300', d.publish.clipGapSec, 300);
  eq('publish.jitterSec 默认 0（等距）', d.publish.jitterSec, 0);
  eq(`publish.submitGapSec 默认 ${DTIME_MIN_MARGIN_SEC}（= 平台底线 300 + 自律余量）`, d.publish.submitGapSec, DTIME_MIN_MARGIN_SEC);

  // 模板文件也要跟上（新装用户抄的是它）
  const ex = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.example.json'), 'utf8')) as {
    publish: { clipGapSec: number; jitterSec: number };
  };
  eq('config.example.json 的 clipGapSec 也是 300', ex.publish.clipGapSec, 300);
  eq('config.example.json 的 jitterSec 也是 0', ex.publish.jitterSec, 0);

  /* 线上口径自检（**只提示、不判失败**）：片间隔只有在「定时发布 + 单独投稿」下才逐片生效。
     立即发布不传 dtime（没有发布时间可排）；多分P 稿件只有一个 dtime（所有分P 同时上线）。

     ★ 2026-10-17：判定收口到 `resolveClipPublishSchedule()` —— 单独投稿下间隔/抖动
       **就是设置里那两个值**（间隔 300 保底、抖动 < 间隔）。这里要是自己再判一次，
       就会与真实链路各说一套。 */
  const live = loadConfig().config;
  const sched = resolveClipPublishSchedule(live.publish);
  if (sched.mode === 'standalone') {
    console.log(
      `  \x1b[32m✓\x1b[0m 线上配置：单独投稿 ⇒ 固定定时投稿、每片 ${sched.gapSec} 秒` +
        `${sched.jitterSec > 0 ? ` + 0~${sched.jitterSec} 秒抖动` : '（无抖动）'}` +
        `（= 设置里的 clipGapSec=${live.publish.clipGapSec} / jitterSec=${live.publish.jitterSec}；` +
        `immediatePublish=${String(live.publish.immediatePublish)} 对切片不参与）`,
    );
  } else if (sched.scheduled) {
    console.log(
      `  \x1b[32m✓\x1b[0m 线上配置：追加切片投稿 + 定时发布（多分P 只有一个发布时间，片间隔 ${live.publish.clipGapSec} 秒不逐片生效）`,
    );
  } else {
    console.log(
      `  \x1b[33m⚠\x1b[0m 线上配置：追加切片投稿 + 立即发布（不传 dtime）⇒ clipGapSec=${live.publish.clipGapSec} 秒不生效。` +
        `要每片错峰需：切片投稿方式改成「单独投稿」（那时片间隔按 clipGapSec 生效、最低 300 秒）`,
    );
  }
}

section('7. 生效口径表：resolveClipPublishSchedule（单独投稿 ⇒ 定时投稿 + 设置里的间隔/抖动）');
{
  /* 2026-10-16 用户要求：「选择单独投稿后，切片会默认以定时投稿的方式、每个投稿 5 分钟的间隔进行投稿」；
     2026-10-17 用户改口径（原话「这里改成对定时投稿也生效」）：**相邻切片间隔 / 随机抖动在单独投稿下
     确实生效**，只有两条硬边界 —— ① 间隔不得低于平台底线 300 秒；② 抖动必须小于间隔（防倒挂）。
     唯一仍不参与的是 immediatePublish（不传 dtime 就没有「按间隔发」）。 */
  const s = (p: Record<string, unknown>): ReturnType<typeof resolveClipPublishSchedule> =>
    resolveClipPublishSchedule({
      multiPart: false,
      immediatePublish: false,
      clipGapSec: 300,
      jitterSec: 0,
      ...p,
    } as never);

  const so = s({ clipPublishMode: 'standalone' });
  eq('单独投稿：mode', so.mode, 'standalone');
  eq('★ 单独投稿：固定定时投稿（scheduled=true）', so.scheduled, true);
  eq('★ 单独投稿：间隔就是 clipGapSec（默认 300）', so.gapSec, 300);
  eq('★ 单独投稿：抖动就是 jitterSec（默认 0 ⇒ 严格等距）', so.jitterSec, 0);

  eq(
    '★ 单独投稿：config 的 immediatePublish=true 不参与（依旧定时）',
    s({ clipPublishMode: 'standalone', immediatePublish: true }).scheduled,
    true,
  );
  eq(
    '★ 单独投稿：clipGapSec=500 ⇒ 真的按 500 排（2026-10-17 起不再钉死 300）',
    s({ clipPublishMode: 'standalone', clipGapSec: 500 }).gapSec,
    500,
  );
  eq(
    '★ 单独投稿：clipGapSec=100（低于平台底线）⇒ 抬到 300',
    s({ clipPublishMode: 'standalone', clipGapSec: 100 }).gapSec,
    300,
  );
  eq(
    '★ 单独投稿：jitterSec=120 + 间隔 500 ⇒ 抖动 120 生效',
    s({ clipPublishMode: 'standalone', clipGapSec: 500, jitterSec: 120 }).jitterSec,
    120,
  );
  eq(
    '★ 单独投稿：jitterSec=1800 + 间隔 300 ⇒ 抖动夹到 270（防排期倒挂）',
    s({ clipPublishMode: 'standalone', jitterSec: 1800 }).jitterSec,
    270,
  );

  const ap = s({ clipPublishMode: 'append', clipGapSec: 7500, jitterSec: 1800, immediatePublish: true });
  eq('追加切片投稿 + 立即发布：scheduled=false（老行为一字未改）', ap.scheduled, false);
  eq('追加切片投稿：间隔/抖动一路沿用 config', `${ap.gapSec}/${ap.jitterSec}`, '7500/1800');
  eq('老配置（没设 clipPublishMode）+ multiPart=false ⇒ 按单独投稿处理', s({ multiPart: false }).mode, 'standalone');

  /* describeScheduleOverride：只在该说的时候说（确实不参与的键 / 被抬被夹而没完全生效的键） */
  ok(
    '★ 单独投稿 + immediatePublish=true ⇒ 只点名它不参与（clipGapSec/jitterSec 现在**是生效的**，不该被冤枉）',
    (() => {
      const t = describeScheduleOverride({
        clipPublishMode: 'standalone',
        multiPart: false,
        immediatePublish: true,
        clipGapSec: 500,
        jitterSec: 120,
      });
      return /immediatePublish/.test(t) && !/clipGapSec/.test(t) && !/jitterSec/.test(t);
    })(),
    describeScheduleOverride({
      clipPublishMode: 'standalone',
      multiPart: false,
      immediatePublish: true,
      clipGapSec: 500,
      jitterSec: 120,
    }),
  );
  ok(
    '★ 单独投稿 + 抖动被夹（900 ⇒ 470）⇒ 明确说清压到了多少（"改了没完全生效"必须说明）',
    /jitterSec=900/.test(
      describeScheduleOverride({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 500, jitterSec: 900 }),
    ) &&
      /470/.test(
        describeScheduleOverride({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 500, jitterSec: 900 }),
      ),
    describeScheduleOverride({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 500, jitterSec: 900 }),
  );
  eq(
    '单独投稿 + 干净配置（300/0/false）⇒ 无需说明（别刷无意义日志）',
    describeScheduleOverride({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 300, jitterSec: 0 }),
    '',
  );
  eq(
    '单独投稿 + 用户那组值（500/120/false）⇒ 也不需要说明（全都完全生效）',
    describeScheduleOverride({ clipPublishMode: 'standalone', multiPart: false, immediatePublish: false, clipGapSec: 500, jitterSec: 120 }),
    '',
  );
  eq(
    '追加切片投稿 ⇒ 永不产生"不生效"说明（它的键全都生效）',
    describeScheduleOverride({ clipPublishMode: 'append', multiPart: true, immediatePublish: true, clipGapSec: 7500, jitterSec: 1800 }),
    '',
  );

  /* validateConfig 必须如实说：越界的值会被抬/压（否则用户改了半天以为原值生效了） */
  const mkCfg = (patch: Record<string, unknown>): AppConfig => {
    const c = loadConfig().config;
    return { ...c, publish: { ...c.publish, clipPublishMode: 'standalone', multiPart: false, ...patch } } as AppConfig;
  };
  const warned = (c: AppConfig): string[] => validateConfig(c).filter((i) => i.level === 'warn').map((i) => i.field);
  ok(
    '★ 单独投稿 + immediatePublish=true ⇒ 有一条 warn 说它对切片不生效',
    warned(mkCfg({ immediatePublish: true, clipGapSec: 500, jitterSec: 120 })).includes('publish.immediatePublish'),
    warned(mkCfg({ immediatePublish: true, clipGapSec: 500, jitterSec: 120 })).join(','),
  );
  ok(
    '★ 单独投稿 + clipGapSec=100（低于平台底线）⇒ warn 指出实际按 300',
    warned(mkCfg({ immediatePublish: false, clipGapSec: 100, jitterSec: 0 })).includes('publish.clipGapSec'),
    warned(mkCfg({ immediatePublish: false, clipGapSec: 100, jitterSec: 0 })).join(','),
  );
  ok(
    '★ 单独投稿 + jitterSec=900 > 间隔−30 ⇒ warn 指出抖动被压（不能静默）',
    warned(mkCfg({ immediatePublish: false, clipGapSec: 500, jitterSec: 900 })).includes('publish.jitterSec'),
    warned(mkCfg({ immediatePublish: false, clipGapSec: 500, jitterSec: 900 })).join(','),
  );
  ok(
    '★ 单独投稿 + 用户那组值（500/120/false）⇒ 不告警（全都合法生效，不该被念）',
    !warned(mkCfg({ immediatePublish: false, clipGapSec: 500, jitterSec: 120 })).includes('publish.immediatePublish') &&
      !warned(mkCfg({ immediatePublish: false, clipGapSec: 500, jitterSec: 120 })).includes('publish.clipGapSec') &&
      !warned(mkCfg({ immediatePublish: false, clipGapSec: 500, jitterSec: 120 })).includes('publish.jitterSec'),
    warned(mkCfg({ immediatePublish: false, clipGapSec: 500, jitterSec: 120 })).join(','),
  );

  /* 排期预览也必须按生效口径算：界面「首片/末片」预览不能拿 config 的原始值算。
     ⚠️ 带抖动时 last−first 是随机的（每片独立 random），所以预览断言用 jitterSec=0 求精确值，
     带抖动的那条只断言区间。 */
  const pv = describeDtimePlan(
    T0,
    { ...CFG_5MIN, clipGapSec: 500, jitterSec: 0, firstPublishAt: '', clipPublishMode: 'standalone', multiPart: false, immediatePublish: true },
    8,
  );
  eq('★ 排期预览（单独投稿 500 秒、无抖动，8 片）：末片 = 首片 + 7×500 秒', pv.last - pv.first, 3500);
  eq('★ 排期预览：scheduled=true（忽略 config 的立即发布）', pv.scheduled, true);
  const pvJ = describeDtimePlan(
    T0,
    { ...CFG_5MIN, clipGapSec: 500, jitterSec: 120, firstPublishAt: '', clipPublishMode: 'standalone', multiPart: false, immediatePublish: false },
    8,
  );
  ok(
    '★ 排期预览（带 120 秒抖动）：末片 − 首片 落在 [7×500 − 120, 7×500 + 120]',
    pvJ.last - pvJ.first >= 3500 - 120 && pvJ.last - pvJ.first <= 3500 + 120,
    `实际 ${pvJ.last - pvJ.first}`,
  );
  ok('...且文案写明「再加 0~120 秒随机抖动」而不是谎称"等距"', /抖动/.test(pvJ.note), pvJ.note);
  const pv2 = describeDtimePlan(T0, { ...CFG_5MIN, firstPublishAt: '', clipPublishMode: 'append', multiPart: true, immediatePublish: true }, 8);
  eq('排期预览（追加 + 立即发布）：scheduled=false', pv2.scheduled, false);
  ok('...且文案明说这些时间不会被使用', /不会/.test(pv2.note), pv2.note);
  const pv3 = describeDtimePlan(T0, { ...CFG_5MIN, firstPublishAt: '' }, 6);
  eq('不给模式三件套 ⇒ 逐字沿用老口径（6 片 × 300 秒）', pv3.last - pv3.first, 1500);
}

section('8. 线上真实路径：逐片提交（各自上传耗时不同）⇒ 每片都守住余量，间隔 ≥ 生效间隔 − 抖动量');
{
  /* 为什么要写这一节：复核线上排期时我（AI）自己手搓过一份公式，算完报「间隔 270~342 秒，
     期望 300~360」——那是**模型错**，不是产品错。两处错：
       1. 没走 `resolveClipPublishSchedule()`：拿 config 的原始值算，而不是生效口径；
       2. 把「抖动只往后推」当成「相邻间隔 ∈ [gap, gap+cap]」，实际是 [gap−cap, gap+cap]。
     所以这里用**生产口径**复刻真实路径，把「手搓公式」这类错误钉死在测试里。
     ★ 2026-10-17：单独投稿下抖动**是生效的**（用户要求），所以"间隔严格 300"不再是性质，
       真正的不变量是「每片距自己的提交时刻 ≥ 1200 秒」与「抖动 < 间隔 ⇒ 不倒挂」。 */
  const so = resolveClipPublishSchedule({
    clipPublishMode: 'standalone',
    multiPart: false,
    immediatePublish: false,
    clipGapSec: 500,
    jitterSec: 120, // 用户那组值（截图：间隔 500 / 抖动 120）
  } as never);
  eq('喂进 computeDtime 的口径 = 生效口径（500/120），不是 config 的原始值', `${so.gapSec}/${so.jitterSec}`, '500/120');

  /* 真实路径：`n` = 本场第几片，`submitTimeMs` = **该片自己的**提交时刻
     （每片切完 + 上传完才投稿，所以逐片往后推）。 */
  for (const uploadSec of [30, 90, 180, 600]) {
    const dts: number[] = [];
    let own = T0;
    for (let n = 1; n <= 8; n++) {
      dts.push(computeDtime(own, n, { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: so.gapSec, jitterSec: so.jitterSec }));
      own += uploadSec * 1000;
    }
    const gaps = dts.slice(1).map((d, i) => d - dts[i]!);
    const minGap = Math.min(...gaps);
    ok(
      `★ 每片上传耗时 ${uploadSec} 秒：相邻间隔 ≥ 380 秒（= 500 − 120，抖动的理论上限）`,
      minGap >= 500 - 120,
      `实测最小 ${minGap} 秒`,
    );
    ok(`...且严格递增（抖动 < 间隔 ⇒ 不会排期倒挂）`, gaps.every((g) => g > 0), JSON.stringify(gaps));
    let worst = Number.POSITIVE_INFINITY;
    let ownMs = T0;
    for (let n = 1; n <= 8; n++) {
      worst = Math.min(worst, dts[n - 1]! - Math.floor(ownMs / 1000));
      ownMs += uploadSec * 1000;
    }
    ok(`...且每片距**自己**的提交时刻 ≥ ${DTIME_MIN_MARGIN_SEC} 秒`, worst >= DTIME_MIN_MARGIN_SEC, `最差余量 ${worst} 秒`);
  }

  /* 抖动的**算术**（别再把区间写错）：
     抖动每片独立 ⇒ 相邻间隔 = 间隔 + (抖动_{n+1} − 抖动_n)。
     抖动 = `Math.floor(rng() × cap)` ⇒ 取值范围是 [0, cap−1]（**取不到 cap**，别写成 ±cap），
     所以 cap=60 时间隔的极值范围是 [300−59, 300+59] = [241, 359]。
     ★ 这不是 bug 而是用户要的"看不出来是机器排的"：上限由夹子保证 < 间隔，所以永不为负。 */
  const worstGap =
    computeDtime(T0, 2, { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: 300, jitterSec: 60, rng: () => 0 }) -
    computeDtime(T0, 1, { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: 300, jitterSec: 60, rng: () => 0.999999 });
  eq('抖动 60 + 间隔 300 ⇒ 最窄相邻间隔 241 秒（间隔 − 59，这是抖动的正常算术）', worstGap, 241);
  const bestGap =
    computeDtime(T0, 2, { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: 300, jitterSec: 60, rng: () => 0.999999 }) -
    computeDtime(T0, 1, { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: 300, jitterSec: 60, rng: () => 0 });
  eq('...最宽 359 秒（所以带抖动时真实范围是「间隔−59 ~ 间隔+59」，别再写成 ±60）', bestGap, 359);
  ok(
    '★ 夹子兜住底线：无论怎么抽，间隔 − 抖动上限 > 0 ⇒ 相邻两片永不同时/倒挂',
    effectiveJitterSec(60, 300) < 300 && effectiveJitterSec(900, 500) < 500,
    `${effectiveJitterSec(60, 300)} / ${effectiveJitterSec(900, 500)}`,
  );
}

console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  // 用 exitCode 而不是 process.exit()：见 tools/verify-clip-gap-ui.ts 的同类注释
  process.exitCode = 1;
}
