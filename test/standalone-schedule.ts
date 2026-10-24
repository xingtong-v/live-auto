/**
 * 「单独投稿」的切片排期 —— **口径 + 真实 payload** 测试。
 *
 * ## 口径（2026-10-17 用户要求：「这里改成对定时投稿也生效」）
 *
 * 用户指的是设置面板「发布排期」区里的两个旋钮：**相邻切片间隔**（`clipGapSec`）与
 * **随机抖动上限**（`jitterSec`）。在此之前单独投稿把它们钉死成 `300 / 0`（2026-10-16 的
 * 「每片 5 分钟等距」口径），界面上还挂着红字说「这两项对切片都不生效」。现在改为：
 *
 *   生效间隔 = `max(300, clipGapSec)`      ← 300 是 **B站 平台底线**，只能往上调不能往下
 *   生效抖动 = `min(jitterSec, max(0, 间隔 - 30))`  ← 与追加模式同一道夹子（防排期倒挂）
 *   `scheduled` 恒为 true                  ← 立即发布仍不参与切片（不传 dtime 就没有「按间隔发」）
 *
 * ## 为什么不能只测那个纯函数（`test/dtime-schedule.ts` 已经测了 `resolveClipPublishSchedule`）
 *
 * 这个仓库出过两次「配置/口径改对了，但链路里没人读」的事故 ——
 *   · `publish.multiPart` 配了却**在自动流程里从没被读**，一场 8 个切片投成 8 个独立稿件；
 *   · `llm_dtype` 传在了 `generate()` 上，而 funasr 只在**构造模型**时读它 ⇒ 静默忽略。
 * 两次的形态完全一样：判定算对了，但**真正发给对方的那份 payload** 用的是另一套值。
 *
 * 所以下面第 3/4/5 节跑**真的 `Publisher.cutAndUploadClip`**（真指纹、真台账、真 `computeDtime`、
 * 真 `buildBiliupConfig`），只把传输层换成假的（`client.cut` / `taskDetail` / `biliUpload` /
 * `biliArchives`），然后断言**实际发给 B站 的那份 config**。
 *
 * 全程离线：不碰 B站、不切 ffmpeg（`client.cut` 直接造出"产物"文件）、不写仓库目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Publisher, computeDtime, effectiveJitterSec } from '../src/publish.ts';
import {
  DTIME_MIN_MARGIN_SEC,
  STANDALONE_CLIP_GAP_SEC,
  effectiveJitterSec as effectiveJitterSecFromConfig,
  describeScheduleOverride,
  loadConfig,
  resolveClipPublishSchedule,
  type AppConfig,
} from '../src/config.ts';
import type { TaskRecord } from '../src/types.ts';

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

const silentLog = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
  child: (): unknown => silentLog,
};

interface Env {
  publisher: Publisher;
  task: TaskRecord;
  /** 每次 `biliUpload` 收到的 payload（真实 buildBiliupConfig 产物） */
  uploads: Array<Record<string, unknown>>;
  cleanup: () => void;
}

const CLIP_COUNT = 5;

/**
 * 起一个隔离环境：临时 dataDir + 真 Publisher + 假传输层。
 *
 * `publishPatch` 覆盖 publish 段，用来摆出「单独投稿 / 追加切片投稿」×「config 里那几个键是什么值」。
 */
function makeEnv(root: string, publishPatch: Record<string, unknown>): Env {
  const dataDir = path.join(root, 'data');
  const taskId = 'sa-sched-0001';
  const taskDir = path.join(dataDir, 'tasks', taskId);
  const clipsDir = path.join(dataDir, 'clips', taskId);
  fs.mkdirSync(path.join(taskDir, 'full'), { recursive: true });
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'clips-out'), { recursive: true });

  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json'), logger: silentLog as never });
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    title: '单独投稿排期测试场',
    liveStartTime: Math.floor(Date.now() / 1000) - 7200,
    stage: 'ANALYZED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: {
      asrEstimate: 0,
      asrAudioSeconds: 0,
      llmActual: 0,
      llmPromptTokens: 0,
      llmCompletionTokens: 0,
      llmCalls: 0,
      updatedAt: new Date().toISOString(),
    },
    transcriptPath: path.join(taskDir, 'transcript.json'),
    signalsPath: path.join(taskDir, 'signals.json'),
    clipsPath: path.join(taskDir, 'clips.json'),
  });
  ledger.setClips(
    taskId,
    Array.from({ length: CLIP_COUNT }, (_, i) => ({
      index: i,
      start: 100 + i * 400,
      end: 250 + i * 400,
      title: `第${i + 1}段`,
      desc: '',
      tags: ['测试'],
      category: '游戏/单机游戏',
      score: 9 - i * 0.1,
      selected: true,
      status: 'CANDIDATE',
    })) as never,
  );

  /* 真实链路要的源文件（不存在会在切片前就报"源文件不存在"） */
  const raw = path.join(root, 'raw.mp4');
  fs.writeFileSync(raw, 'x');
  ledger.updateTask(taskId, {
    recordingId: 'rec-1',
    source: { ...ledger.getTask(taskId)!.source, rawFiles: [raw], fullVideoPath: raw },
  });

  /* 配置：与本用例相关的键**一律显式给值**，绝不从线上 config.json 继承 ——
     线上配置会被用户与别的会话随时改动，继承会让结果随它漂移（本仓库实测踩过）。
     只保留"非排期"的部分（口令/模型/路径），排期相关全在下面对齐。 */
  const realCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')) as Record<string, unknown>;
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...realCfg,
        clip: {
          ...(realCfg['clip'] as object),
          /* 不烧任何东西、不做音画修复、不并发：本用例只关心"发出去的 dtime" */
          burnDanmaku: false,
          burnSubtitles: false,
          avSyncRepair: false,
          concurrency: 1,
          ffmpegPresetId: '',
          outputDir: path.join(root, 'clips-out'),
        },
        publish: {
          ...(realCfg['publish'] as object),
          submitGapSec: DTIME_MIN_MARGIN_SEC,
          firstPublishAt: '',
          dailyLimit: 0,
          minSubmitIntervalSec: 0,
          autoRetryOnce: false,
          coverFrom: 'preset',
          defaultCover: '',
          autoPublish: true,
          fullVideoBy: 'bililive-tools',
          resumeAid: '',
          ...publishPatch,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const uploads: Array<Record<string, unknown>> = [];
  const publisher = new Publisher({
    client: {
      userList: async (): Promise<unknown[]> => [{ uid: 12345, name: 'stub' }],
      /* 切片交给"对方"，但它会立刻完成并产出文件（真实链路会在 waitTask 里轮询到 completed） */
      cut: async (p: Record<string, unknown>): Promise<{ taskId: string }> => {
        const out = String(p['output']);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, 'x');
        return { taskId: `cut-${path.basename(out)}` };
      },
      taskDetail: async (): Promise<{ status: string; output: string }> => ({ status: 'completed', output: '' }),
      /* `publishClips()` 入口会先 `ensureAnchorUid()`（简介模板里的 {{anchorUid}} 用），
         走的是 `client.anchorInfoByRoom`。第 1 节的 `cutAndUploadClip` 不经过它，
         所以只补这一处就够第 7 节跑起来。 */
      anchorInfoByRoom: async (): Promise<{ uid: string; name: string }> => ({ uid: '12345', name: 'stub-anchor' }),
      presetFfmpeg: async (): Promise<unknown[]> => [],
      biliArchives: async (): Promise<unknown[]> => [],
      biliUpload: async (p: Record<string, unknown>): Promise<{ taskId: string }> => {
        uploads.push(p);
        return { taskId: `upload-${uploads.length}` };
      },
    } as never,
    config: loadConfig(configPath).config as AppConfig,
    ledger,
    logger: silentLog as never,
  });

  return {
    publisher,
    task: ledger.getTask(taskId)!,
    uploads,
    cleanup: (): void => {},
  };
}

/** 取一份 payload 里的 dtime（真实 payload 里没有这个字段 = 立即发布） */
function dtimeOf(config: Record<string, unknown>): number | undefined {
  const v = config['dtime'];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** `resolveClipPublishSchedule` 的简写构造（只关心排期五个键） */
function sched(patch: Record<string, unknown>): ReturnType<typeof resolveClipPublishSchedule> {
  return resolveClipPublishSchedule({
    clipPublishMode: 'standalone',
    multiPart: false,
    immediatePublish: false,
    clipGapSec: 300,
    jitterSec: 0,
    ...patch,
  } as never);
}

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sa-sched-'));
  const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
  setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));
  setErrorReportDir(path.join(tmpRoot, 'error-report'));

  /* ==========================================================================
   * 一、口径：单独投稿下「相邻切片间隔 / 随机抖动」**确实生效**（2026-10-17 用户要求）
   * ======================================================================== */
  section('1. 口径：单独投稿 ⇒ 间隔 = max(300, clipGapSec)、抖动 = min(jitterSec, 间隔−30)');
  {
    /* 用户截图里那组值：间隔 500、抖动 120 */
    const s1 = sched({ clipGapSec: 500, jitterSec: 120 });
    eq('★ 用户配置 500/120 ⇒ 生效间隔 500', s1.gapSec, 500);
    eq('★ ...生效抖动 120（不再被钉成 0）', s1.jitterSec, 120);
    eq('★ 依旧固定定时投稿（scheduled=true）', s1.scheduled, true);
    ok('★ note 说真话：写明「与设置里的相邻切片间隔 / 随机抖动一致」', /相邻切片间隔/.test(s1.note) && /抖动/.test(s1.note), s1.note);

    /* 底线：填 100 只能被抬到 300（B站 要求每片 dtime 晚于它自己的提交时刻 300 秒） */
    const s2 = sched({ clipGapSec: 100, jitterSec: 0 });
    eq('★ clipGapSec=100（低于平台底线）⇒ 间隔保底 300', s2.gapSec, STANDALONE_CLIP_GAP_SEC);
    eq('...常量就是 300', STANDALONE_CLIP_GAP_SEC, 300);
    ok('★ note 如实说明「你填的 100 低于 B站 要求的 300」', /100/.test(s2.note) && /300/.test(s2.note), s2.note);

    /* 夹子：抖动必须小于片间隔，否则第 N+1 片会抢在第 N 片之前公开 */
    const s3 = sched({ clipGapSec: 500, jitterSec: 900 });
    eq('★ jitterSec=900 + 间隔 500 ⇒ 抖动压到 470（500−30）', s3.jitterSec, 470);
    eq('...间隔本身不受影响', s3.gapSec, 500);
    ok('★ note 说明抖动被压在 470（不能静默）', /470/.test(s3.note), s3.note);

    /* 抖动正好等于间隔-30 时不该被"压"（边界） */
    eq('抖动 470 + 间隔 500 ⇒ 原样保留（边界不越界）', sched({ clipGapSec: 500, jitterSec: 470 }).jitterSec, 470);
    /* 抖动 0 = 严格等距（老配置不受影响） */
    eq('抖动 0 ⇒ 严格等距', sched({ clipGapSec: 500, jitterSec: 0 }).jitterSec, 0);
    /* 非法值不许把 NaN 带进 computeDtime（NaN 会让 dtime 变 NaN ⇒ B站 400，且报错看不懂） */
    eq('clipGapSec=0（脏值）⇒ 保底 300', sched({ clipGapSec: 0, jitterSec: 0 }).gapSec, 300);
    eq('jitterSec=-5（脏值）⇒ 当 0', sched({ clipGapSec: 500, jitterSec: -5 }).jitterSec, 0);

    /* 唯一真正不参与的还是「立即发布」：不传 dtime 就没有「按间隔发」 */
    eq('★ 单独投稿 + immediatePublish=true ⇒ 仍是定时投稿', sched({ immediatePublish: true }).scheduled, true);

    /* 追加模式（老行为一字未改） */
    const ap = sched({ clipPublishMode: 'append', multiPart: true, immediatePublish: false, clipGapSec: 7500, jitterSec: 1800 });
    eq('追加切片投稿：间隔/抖动一路沿用 config（没被新口径改到）', `${ap.gapSec}/${ap.jitterSec}`, '7500/1800');

    /* `effectiveJitterSec` 搬到 config.ts 后，publish.ts 的老导出名必须还在（测试/工具在用） */
    ok(
      '★ publish.ts 仍导出 effectiveJitterSec（搬到 config 后老调用点不用改）',
      typeof effectiveJitterSec === 'function' && effectiveJitterSec(1800, 300) === 270 && effectiveJitterSec === effectiveJitterSecFromConfig,
      `${String(effectiveJitterSec(1800, 300))} / same=${String(effectiveJitterSec === effectiveJitterSecFromConfig)}`,
    );
  }

  /* ==========================================================================
   * 二、公式：严格递增 + 每片都守住 B站 底线 + 抖动上限真的取得到
   * ======================================================================== */
  section('2. computeDtime（单独投稿口径）：严格递增、每片 ≥ 提交+300、抖动上限确实生效');
  {
    const T0 = Math.floor(Date.UTC(2026, 9, 17, 4, 0, 0) / 1000) * 1000;
    const s = sched({ clipGapSec: 500, jitterSec: 120 });
    const rng = Math.random;
    const dts = Array.from({ length: 8 }, (_, i) =>
      computeDtime(T0, i + 1, { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: s.gapSec, jitterSec: s.jitterSec, rng }),
    );
    const gaps = dts.slice(1).map((d, i) => d - dts[i]!);
    ok('★ 8 片严格递增（抖动 < 间隔 ⇒ 不会排期倒挂）', gaps.every((g) => g > 0), JSON.stringify(gaps));
    ok(
      `★ 每个间隔都落在 [500−120, 500+120] 内（抖动上限 120 真的在起作用）`,
      gaps.every((g) => g >= 500 - 120 && g <= 500 + 120),
      JSON.stringify(gaps),
    );
    ok(
      '★ 每片 dtime 都 ≥ 提交时刻 + 300 秒（B站 平台底线，不是靠事后 clamp 兜的）',
      dts.every((d) => d - Math.floor(T0 / 1000) >= 300),
      JSON.stringify(dts.map((d) => d - Math.floor(T0 / 1000))),
    );

    /* 抖动上限的**确定性**验证：rng 固定 0.999 ⇒ floor(0.999×cap) 落在上限附近。
       这条是"上限真的生效"的硬证据 —— 只测区间会被"根本没加抖动"蒙混过去。 */
    const hi = computeDtime(T0, 1, { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: s.gapSec, jitterSec: s.jitterSec, rng: () => 0.999 });
    const lo = computeDtime(T0, 1, { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: s.gapSec, jitterSec: s.jitterSec, rng: () => 0 });
    eq('rng=0.999 ⇒ 第 1 片取到抖动上限附近（119 秒）', hi - Math.floor(T0 / 1000) - DTIME_MIN_MARGIN_SEC, 119);
    eq('rng=0 ⇒ 第 1 片没有抖动', lo - Math.floor(T0 / 1000) - DTIME_MIN_MARGIN_SEC, 0);

    /* 被夹取后同样要保住"不越界"：900 ⇒ 470 */
    const capped = sched({ clipGapSec: 500, jitterSec: 900 });
    const hiC = computeDtime(T0, 1, { submitGapSec: DTIME_MIN_MARGIN_SEC, clipGapSec: capped.gapSec, jitterSec: capped.jitterSec, rng: () => 0.999 });
    eq('★ 抖动画成 470 后：rng=0.999 只加 469 秒（不是 900）', hiC - Math.floor(T0 / 1000) - DTIME_MIN_MARGIN_SEC, 469);
  }

  /* ==========================================================================
   * 三、真实 payload：用户那组值（500 / 120）必须真的发出去
   * ======================================================================== */
  section('3. 单独投稿 + clipGapSec=500 / jitterSec=120 ⇒ 每片带 dtime、间隔≈500±120');
  {
    const env = makeEnv(path.join(tmpRoot, 'standalone-500'), {
      clipPublishMode: 'standalone',
      multiPart: false,
      fullVideoBy: 'bililive-tools',
      /* 老口径下这三个键里有两个"不参与"：现在只该剩 immediatePublish 一个 */
      immediatePublish: true,
      clipGapSec: 500,
      jitterSec: 120,
    });
    /* 整批共用一个基准时刻（真实链路就是 `publishClips({submitTimeMs})` 传下来的那个），
       `clipOrdinal` 也必须与真实链路一致（`publishClips` 传 `idx + 1`）——
       否则这里会因为缺省 N=1 而让每一片拿到同一个 dtime。 */
    const base = Date.now();
    const results = [];
    for (let i = 0; i < CLIP_COUNT; i++) {
      results.push(await env.publisher.cutAndUploadClip({ task: env.task, uid: 12345, submitTimeMs: base, clipOrdinal: i + 1 }, i));
    }

    eq(`投出去 ${CLIP_COUNT} 片`, env.uploads.length, CLIP_COUNT);
    ok('每片都成功', results.every((r) => r.ok), results.map((r) => r.error?.message ?? 'ok').join(' | '));

    const dtimes = env.uploads.map((u) => dtimeOf((u['config'] as Record<string, unknown>) ?? {}));
    ok(
      `★ ${CLIP_COUNT} 片的 payload **全都带 dtime**（定时投稿 —— config 里的立即发布没有生效）`,
      dtimes.every((d) => typeof d === 'number'),
      JSON.stringify(dtimes),
    );
    const gaps: number[] = [];
    for (let i = 1; i < dtimes.length; i++) gaps.push((dtimes[i] as number) - (dtimes[i - 1] as number));
    ok('★ 相邻两片严格递增（没有排期倒挂）', gaps.every((g) => g > 0), JSON.stringify(gaps));
    ok(
      '★ 间隔落在 [380, 620]（= 500±120）—— 500 与 120 都真的进了 payload',
      gaps.every((g) => g >= 500 - 120 && g <= 500 + 120),
      JSON.stringify(gaps),
    );
    ok(
      '★ 首片 = 提交时刻 + 1200 + 抖动（余量 ≥ 1200，硬约束 #4）',
      (dtimes[0] as number) - Math.floor(base / 1000) >= DTIME_MIN_MARGIN_SEC &&
        (dtimes[0] as number) - Math.floor(base / 1000) <= DTIME_MIN_MARGIN_SEC + 120,
      `余量 ${(dtimes[0] as number) - Math.floor(base / 1000)} 秒`,
    );

    /* 反过来也要钉住：payload 里 dtime 就是唯一的发布时间来源，
       而 publish 日志里记的 dtime 必须与 payload 一致（曾经出现过"日志写定时、payload 不带"那种自相矛盾）。 */
    const logged = (env.publisher as unknown as { ledger: Ledger }).ledger.readPublishLog({ sinceMs: base - 86400_000 });
    const submits = logged.filter((r) => r['action'] === 'submit');
    eq('台账里记了 5 条投稿', submits.length, CLIP_COUNT);
    ok(
      '★ 台账记的 dtime 与 payload 完全一致（不是"日志写定时、请求不带"）',
      submits.every((r, i) => r['dtime'] === dtimes[i]),
      `${JSON.stringify(submits.map((r) => r['dtime']))} vs ${JSON.stringify(dtimes)}`,
    );

    /* describeScheduleOverride 的文案：不该再把 clipGapSec / jitterSec 说成"不参与" */
    const over = describeScheduleOverride({
      clipPublishMode: 'standalone',
      multiPart: false,
      immediatePublish: true,
      clipGapSec: 500,
      jitterSec: 120,
    });
    ok('★ 日志/界面说明只点名 immediatePublish 不参与，不再冤枉那两个键', /immediatePublish/.test(over) && !/clipGapSec/.test(over) && !/jitterSec/.test(over), over);
    env.cleanup();
  }

  /* ==========================================================================
   * 四、底线保底：clipGapSec 低于 300 时真实 payload 仍按 300 排
   * ======================================================================== */
  section('4. 单独投稿 + clipGapSec=100（低于平台底线）⇒ 真实 payload 间隔正好 300 秒');
  {
    const env = makeEnv(path.join(tmpRoot, 'standalone-floor'), {
      clipPublishMode: 'standalone',
      multiPart: false,
      fullVideoBy: 'bililive-tools',
      immediatePublish: false,
      clipGapSec: 100,
      jitterSec: 0,
    });
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await env.publisher.cutAndUploadClip({ task: env.task, uid: 12345, submitTimeMs: base, clipOrdinal: i + 1 }, i);
    }
    const dtimes = env.uploads.map((u) => dtimeOf((u['config'] as Record<string, unknown>) ?? {}));
    const gaps = dtimes.slice(1).map((d, i) => (d as number) - (dtimes[i] as number));
    eq('★ 填 100 也不会真的按 100 排（平台底线保底 300）', `${gaps[0]}/${gaps[1]}`, '300/300');
    ok(
      '★ 每片都满足「距提交 ≥ 300 秒」（B站 底线，不需要事后 clamp）',
      dtimes.every((d) => (d as number) - Math.floor(base / 1000) >= 300),
      JSON.stringify(dtimes.map((d) => (d as number) - Math.floor(base / 1000))),
    );
    /* 界面/日志要能说清"你填的 100 实际跑成了 300"，否则用户以为 100 生效了 */
    const over = describeScheduleOverride({
      clipPublishMode: 'standalone',
      multiPart: false,
      immediatePublish: false,
      clipGapSec: 100,
      jitterSec: 0,
    });
    ok('★ 说明里点明 "clipGapSec=100 低于平台底线、实际按 300"', /clipGapSec=100/.test(over) && /300/.test(over), over);
    env.cleanup();
  }

  /* ==========================================================================
   * 五、夹取：jitterSec=900 + 间隔 500 ⇒ 真实 payload 的抖动只有 0~469
   * ======================================================================== */
  section('5. 单独投稿 + clipGapSec=500 / jitterSec=900 ⇒ 抖动被压到 470（不会排期倒挂）');
  {
    const env = makeEnv(path.join(tmpRoot, 'standalone-capped'), {
      clipPublishMode: 'standalone',
      multiPart: false,
      fullVideoBy: 'bililive-tools',
      immediatePublish: false,
      clipGapSec: 500,
      jitterSec: 900,
    });
    const base = Date.now();
    for (let i = 0; i < CLIP_COUNT; i++) {
      await env.publisher.cutAndUploadClip({ task: env.task, uid: 12345, submitTimeMs: base, clipOrdinal: i + 1 }, i);
    }
    const dtimes = env.uploads.map((u) => dtimeOf((u['config'] as Record<string, unknown>) ?? {}));
    const firstMargin = (dtimes[0] as number) - Math.floor(base / 1000);
    ok(
      '★ 首片余量落在 [1200, 1669]（抖动上限 470，不是配置里的 900）',
      firstMargin >= DTIME_MIN_MARGIN_SEC && firstMargin <= DTIME_MIN_MARGIN_SEC + 469,
      `余量 ${firstMargin} 秒`,
    );
    const gaps = dtimes.slice(1).map((d, i) => (d as number) - (dtimes[i] as number));
    ok('★ 相邻间隔始终 > 0（夹子的意义：不允许倒挂）', gaps.every((g) => g > 0), JSON.stringify(gaps));
    ok('★ 最坏间隔 ≥ 500−470 = 30 秒（夹取后的理论上限）', gaps.every((g) => g >= 500 - 470), JSON.stringify(gaps));
    const over = describeScheduleOverride({
      clipPublishMode: 'standalone',
      multiPart: false,
      immediatePublish: false,
      clipGapSec: 500,
      jitterSec: 900,
    });
    ok('★ 说明里点明 "jitterSec=900 已压到 470"', /jitterSec=900/.test(over) && /470/.test(over), over);
    env.cleanup();
  }

  /* ==========================================================================
   * 六、追加切片投稿：老行为一字未改（配置说什么就是什么）
   * ======================================================================== */
  section('6. 追加切片投稿 + immediatePublish=true ⇒ payload 不带 dtime（老行为一字未改）');
  {
    const env = makeEnv(path.join(tmpRoot, 'append'), {
      clipPublishMode: 'append',
      multiPart: true,
      fullVideoBy: 'assistant',
      immediatePublish: true,
      clipGapSec: 7500,
      jitterSec: 1800,
    });
    const base = Date.now();
    /* ⚠️ 直接调 cutAndUploadClip（不传 skipUpload）：追加模式下 publishClips 会给它传 skipUpload=true，
       那时它在切片后就直接返回、由 publishAsMultiPart 统一投。这里要验的是"如果它真的投了，
       payload 用哪个口径" —— 也就是这条路径本身不认识"单独投稿"那套值。 */
    const r0 = await env.publisher.cutAndUploadClip({ task: env.task, uid: 12345, submitTimeMs: base }, 0);
    ok('第一片投出去了', r0.ok && env.uploads.length === 1, r0.error?.message ?? `uploads=${env.uploads.length}`);
    const cfg0 = (env.uploads[0]!['config'] ?? {}) as Record<string, unknown>;
    ok('★ 追加模式 + 立即发布 ⇒ payload 里**没有 dtime**（逐字沿用 config）', dtimeOf(cfg0) === undefined, JSON.stringify(cfg0['dtime']));
    env.cleanup();
  }

  section('7. 追加切片投稿 + immediatePublish=false ⇒ 仍按 config 的 7500 秒排期（不套用单独投稿口径）');
  {
    const env = makeEnv(path.join(tmpRoot, 'append-sched'), {
      clipPublishMode: 'append',
      multiPart: true,
      fullVideoBy: 'assistant',
      immediatePublish: false,
      clipGapSec: 7500,
      jitterSec: 0,
    });
    const base = Date.now();
    for (let i = 0; i < 2; i++) {
      await env.publisher.cutAndUploadClip({ task: env.task, uid: 12345, submitTimeMs: base, clipOrdinal: i + 1 }, i);
    }
    const d0 = dtimeOf((env.uploads[0]!['config'] ?? {}) as Record<string, unknown>);
    const d1 = dtimeOf((env.uploads[1]!['config'] ?? {}) as Record<string, unknown>);
    ok('两片都带 dtime', typeof d0 === 'number' && typeof d1 === 'number', `${String(d0)} / ${String(d1)}`);
    eq('★ 片间隔沿用 config 的 7500 秒', (d1 as number) - (d0 as number), 7500);
    env.cleanup();
  }

  /* ==========================================================================
   * 八、回归：2026-10-17 线上事故「整批被推后 (N-1)×间隔 秒」
   * ========================================================================
   * 当时 N 是 `cutAndUploadClip` 自己数的「近 24h 台账里的 submit 条数 + 1」——
   * 那个窗口**跨批次**，前一晚投过的切片会被算进本批：
   *   00:16 开批时 N=28（前 24h 里正好 27 条 submit）⇒ 首片被推后 (28-1)×间隔。
   * 修法：N 改由 `publishClips` 传「本场第几片」。这一节伪造「台账里已有别的批次的提交」，
   * 断言本批首片**不再被那些历史提交推后**。
   * ======================================================================== */
  section('8. 台账里已有 3 条别的批次的 submit ⇒ 本批首片仍是「提交 + 1200 秒」');
  {
    const env = makeEnv(path.join(tmpRoot, 'history'), {
      clipPublishMode: 'standalone',
      multiPart: false,
      fullVideoBy: 'bililive-tools',
      immediatePublish: false,
      clipGapSec: 300,
      jitterSec: 0,
      /* 风控间隔取负数：`minSubmitIntervalSec*1000 + randomInt(0,30s)` 恒为负 ⇒ 不等待。
         这条抖动只是节流、不是被测行为，否则本节要白等最多 30 秒。 */
      minSubmitIntervalSec: -60,
    });
    /* 伪造"前一晚那几批"：3 条落在 24h 窗口内的 submit（旧口径会把它们算进 N ⇒ 首片被推后 3×间隔） */
    const ledger = (env.publisher as unknown as { ledger: Ledger }).ledger;
    for (let i = 0; i < 3; i++) {
      ledger.logPublish({
        taskId: 'other-batch',
        clipIndex: i,
        action: 'submit',
        at: new Date(Date.now() - 3600_000).toISOString(),
        title: `历史批次第${i + 1}片`,
      });
    }
    const before = Date.now();
    const res = await env.publisher.publishClips({ task: env.task, uid: 12345, indices: [0, 1] });
    const after = Date.now();
    ok('两片都投出去了', res.submitted === 2, `submitted=${res.submitted} failed=${res.failed}`);
    const dtimes = env.uploads.map((u) => dtimeOf((u['config'] as Record<string, unknown>) ?? {}));
    /* 基准 = 提交那一刻（publishClips 内部取 Date.now()），所以给一个 [before, after] 的闭区间 */
    const lower = Math.floor(before / 1000) + DTIME_MIN_MARGIN_SEC;
    const upper = Math.floor(after / 1000) + DTIME_MIN_MARGIN_SEC;
    const d0 = dtimes[0];
    const d1 = dtimes[1];
    ok(
      '★ 首片 = 提交基准 + 1200 秒（没被前 24h 那 3 条历史提交推后）',
      typeof d0 === 'number' && d0 >= lower && d0 <= upper,
      `实际 ${String(d0)}，应落在 [${lower}, ${upper}]`,
    );
    eq('★ 第二片 = 首片 + 300 秒（本场序号递进；jitterSec=0 时严格等距）', typeof d1 === 'number' && typeof d0 === 'number' ? d1 - d0 : 0, 300);
    /* 这行断言防的是"只改了 cutAndUploadClip 的缺省值、publishClips 却没把序号传下去"——
       那样每一片都会拿到 N=1、整批排到同一个时刻。 */
    const src = fs.readFileSync(path.join(process.cwd(), 'src/publish.ts'), 'utf8');
    ok(
      '★ publishClips 真的把「本场第几片」传下去了（不是只在 cutAndUploadClip 里改缺省值）',
      /clipOrdinal: idx \+ 1/.test(src),
      'src/publish.ts 里找不到 `clipOrdinal: idx + 1`',
    );
    env.cleanup();
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  \x1b[31m·\x1b[0m ' + f);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\x1b[31m测试脚本自身出错：\x1b[0m' + (e as Error).message);
  process.exit(1);
});
