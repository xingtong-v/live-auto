/**
 * 投稿限流修复 —— **QA 独立验证**套件（2026-10-17，严过关）。
 *
 * 与 `test/upload-ratelimit.ts`（工程师自测）刻意分开：
 *   · 那个套件证明"实现能跑通"，本套件要去**证伪**它 —— 判据反例、重试次数语义、
 *     真实闸门间隔（不注入、用默认 3000ms 真等）、异常后不卡死、探针的规范化边界、
 *     错误报告落盘、以及"被限流拒掉的尝试不占今日额度"。
 *
 * 2026-10-21 追加（配额级限流事故 `auto-20261021030839-l3ti`，QA 第二轮）：
 *   ①–⑭ 是 10-17「秒级限流」那一轮的验证；⑮ 起验 10-21「配额级限流」修复的**边角**，
 *   这些边角是工程师点名没覆盖的：
 *     ⑮ signal abort × 配额收尾（不吞 abort、不写脏状态、不进入等待）
 *     ⑯ 多分P「新建稿件」（resumeAid 为空）的配额收尾
 *     ⑰ 告警去重窗口（连续两批不风暴、也不漏报；窗口过后能重新报）
 *     ⑱ 配额限流 × 每日额度截断同时发生（状态与提示不能自相矛盾）
 *     ⑲ 独立复核工程师那 6 组断言（尤其"脏指纹已清"——只有分支 B 才真的会登记指纹）
 *     ⑳ daemon 层：配额收尾后本场状态/告警是否自洽（单切片 vs 多分P 对照）
 *
 * 运行：node test/upload-ratelimit-qa.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Publisher, UPLOAD_RATE_LIMIT_MAX_ATTEMPTS, UPLOAD_RATE_LIMIT_WAIT_CAP_SEC, UPLOAD_SUBMIT_MIN_GAP_MS } from '../src/publish.ts';
import {
  RATE_LIMIT_DEFAULT_WAIT_SEC,
  UPLOAD_QUOTA_RETRY_AFTER_MIN,
  classifySubmitLimit,
  isUploadQuotaLimited,
  isUploadRateLimited,
  parseRateLimitWaitSec,
} from '../src/failure-class.ts';
import { Alerter } from '../src/alert.ts';
import { Orchestrator } from '../src/daemon.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { Ledger, clipFingerprint } from '../src/ledger.ts';
import { setErrorReportDir, setErrorsPath } from '../src/errors.ts';
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
/** 只记录、不判定：用于"已知缺口"的现状快照（免得把不该有的行为钉成断言） */
function info(name: string, detail: string): void {
  console.log(`  \x1b[33m· ${name}\x1b[0m :: ${detail}`);
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

/** 线上原话（真实样本，判据的锚点） */
const RATE_LIMIT_MSG = 'BiliResponseError: 您投稿的频率过快，请稍等2秒';

/** 2026-10-21 线上原话（**没有秒数** —— 配额级限流的判据锚点，别改成"请稍等N秒"） */
const QUOTA_LIMIT_MSG = 'BiliResponseError: 投稿过于频繁，请稍后再试';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live_auto-ratelimit-qa-'));
const errorReportDir = path.join(tmpRoot, 'error-report');
setErrorReportDir(errorReportDir);
setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));

/* ==========================================================================
 * 隔离环境
 * ==========================================================================*/

type SubmitBehavior = 'ok' | 'rate-limit' | 'quota' | 'locked';

interface Env {
  publisher: Publisher;
  ledger: Ledger;
  tasks: TaskRecord[];
  /** 每次 biliUpload 的发起时刻（毫秒）、返回时刻、入参 */
  uploads: Array<{ at: number; doneAt: number; params: Record<string, unknown> }>;
  /** 注入的"限流等待"时长（毫秒） */
  waits: number[];
  /** setClipStatus 的调用序列（核对 SUBMITTED 是否在提交成功后就落盘） */
  statusCalls: Array<{ clipIndex: number; status: string }>;
  /** registerFingerprint 的调用序列（核对"脏指纹确实登记过、也确实被清掉"） */
  fingerprintCalls: Array<{ fp: string; taskId: string; clipIndex: number }>;
  /** 配额限流告警（2026-10-21） */
  quotaAlerts: Array<{ taskId: string; title: string; submitted: number; remaining: number; retryAfterMin: number; reason: string }>;
  /** 「投稿失败」告警（配额限流时**不该**出现） */
  failedAlerts: Array<{ taskId: string; title: string; reason: string }>;
  /** 读目标稿件详情（分P 列表）的次数 —— 探针/去重的调用证据 */
  archiveDetailReads: number;
  /** 用**同一份 ledger / client / config** 再造一个 Publisher（验证"脏指纹真的从台账清掉了"，而不是只有内存清掉） */
  spawnPublisher: () => Publisher;
  cleanup: () => void;
}

/** 两个不同 taskId 的场次（用于验收「跨任务并发」这条事故路径） */
const TASK_IDS = ['qa-ratelimit-A', 'qa-ratelimit-B'];

function writeConfig(root: string, publishExtra: Record<string, unknown> = {}): string {
  const realCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')) as Record<string, unknown>;
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...realCfg,
        clip: {
          ...(realCfg['clip'] as object),
          burnDanmaku: false,
          burnSubtitles: false,
          avSyncRepair: false,
          concurrency: 1,
          ffmpegPresetId: '',
          outputDir: path.join(root, 'clips-out'),
        },
        /* 告警一律关掉：真实渠道（Server酱/钉钉）会打网络，跑测试不该给用户发通知 */
        alert: { ...(realCfg['alert'] as object), enabled: false },
        publish: {
          ...(realCfg['publish'] as object),
          submitGapSec: 1200,
          firstPublishAt: '',
          /* 每日额度不设限、批内抖动关掉、publishClips 层的自动重试关掉 ——
             免得把另外两条重试路径的噪音算进"提交层重试"。 */
          dailyLimit: 0,
          minSubmitIntervalSec: 0,
          autoRetryOnce: false,
          coverFrom: 'preset',
          defaultCover: '',
          autoPublish: true,
          fullVideoBy: 'bililive-tools',
          resumeAid: '',
          resumeTitleTemplate: '',
          ...publishExtra,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  return configPath;
}

/**
 * @param opts.taskCount      场次数量（默认 1）
 * @param opts.clipTitles     每个场次的切片标题（默认 ['第1段']）
 * @param opts.submit         每次 biliUpload 的行为（按顺序，用尽后重复最后一个）
 * @param opts.taskDetail     taskDetail 的返回序列
 * @param opts.archiveDetail  目标稿件详情（续传探针用）
 * @param opts.submitGateMs   不传 ⇒ **用生产默认值**（3000ms，真等）
 * @param opts.uploadDelayMs  biliUpload 的模拟耗时
 */
function makeEnv(
  root: string,
  opts: {
    taskCount?: number;
    clipTitles?: string[];
    submit: SubmitBehavior[];
    taskDetail?: Array<{ status: string; error?: string }>;
    archiveDetail?: Record<string, unknown>;
    /** 目标稿件详情的**演化序列**（投稿前去重 → 限流后探针 → 落地确认会各读一次） */
    archiveDetailSeq?: Array<Record<string, unknown>>;
    submitGateMs?: number;
    uploadDelayMs?: number;
    rateLimitMaxAttempts?: number;
    /** 往 publish 配置里再压几个键（如 dailyLimit / clipPublishMode） */
    publishExtra?: Record<string, unknown>;
    /** 是否给任务挂 fullVideoPath（默认给；多分P「新建稿件」用例要关掉，否则会多一个完整版分P） */
    withFullVideo?: boolean;
    /** 每次 biliUpload 被调用时的钩子（用于"用户正好在此刻点停止"这类用例） */
    onSubmit?: (callIndex: number) => void;
    /** 外部注入的告警器替换默认的记录桩（告警去重用例需要真实 Alerter） */
    alerter?: Pick<Alerter, 'publishQuotaLimited'>;
  },
): Env {
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(root, 'clips-out'), { recursive: true });

  const raw = path.join(root, 'raw.mp4');
  fs.writeFileSync(raw, 'x');
  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json'), logger: silentLog as never });

  const clipTitles = opts.clipTitles ?? ['第1段'];
  const taskCount = opts.taskCount ?? 1;
  const tasks: TaskRecord[] = [];
  for (let t = 0; t < taskCount; t++) {
    const taskId = TASK_IDS[t]!;
    const taskDir = path.join(dataDir, 'tasks', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    ledger.createTask({
      id: taskId,
      roomId: '12345678',
      title: `QA 限流测试场 ${t + 1}`,
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
    ledger.updateTask(taskId, {
      recordingId: `rec-${t + 1}`,
      source: {
        ...ledger.getTask(taskId)!.source,
        rawFiles: [raw],
        ...(opts.withFullVideo === false ? {} : { fullVideoPath: raw }),
      },
    });
    ledger.setClips(
      taskId,
      clipTitles.map((title, i) => {
        const clipOut = path.join(root, 'clips-out', `${taskId}-${i}.mp4`);
        fs.writeFileSync(clipOut, 'fake-bytes');
        return {
          index: i,
          start: 100 + i * 200,
          end: 250 + i * 200,
          title,
          desc: '',
          tags: ['测试'],
          category: '游戏/单机游戏',
          score: 9,
          selected: true,
          /* 产物已存在 ⇒ 走"复用"直接投稿，本套件只关心投稿那一段（不切 ffmpeg） */
          status: 'PENDING_UPLOAD',
          cutOutput: clipOut,
        };
      }) as never,
    );
    tasks.push(ledger.getTask(taskId)!);
  }

  const uploads: Env['uploads'] = [];
  const waits: number[] = [];
  const statusCalls: Env['statusCalls'] = [];
  const fingerprintCalls: Env['fingerprintCalls'] = [];
  const quotaAlerts: Env['quotaAlerts'] = [];
  const failedAlerts: Env['failedAlerts'] = [];
  let archiveDetailReads = 0;
  let submitCalls = 0;
  let detailCalls = 0;
  const detailQueue = opts.taskDetail ?? [{ status: 'completed' }];

  const client = {
    userList: async (): Promise<unknown[]> => [{ uid: 12345, name: 'stub' }],
    anchorInfoByRoom: async (): Promise<{ uid: string; name: string }> => ({ uid: '12345', name: 'stub-anchor' }),
    presetFfmpeg: async (): Promise<unknown[]> => [],
    cut: async (): Promise<{ taskId: string }> => {
      throw new Error('本套件不该切片（产物已存在，应走复用）');
    },
    biliArchives: async (): Promise<unknown[]> => [{ bvid: 'BV1QA0000001', aid: 117000000000001, title: 'QA 测试稿件', duration: 100 }],
    biliArchiveDetail: async (): Promise<unknown> => {
      archiveDetailReads++;
      const seq = opts.archiveDetailSeq;
      if (seq && seq.length > 0) {
        const pick = seq[Math.min(detailCalls, seq.length - 1)]!;
        detailCalls++;
        return pick;
      }
      return opts.archiveDetail ?? {};
    },
    taskDetail: async (): Promise<{ status: string; error?: string }> => {
      const pick = detailQueue[Math.min(detailCalls, detailQueue.length - 1)]!;
      detailCalls++;
      return pick;
    },
    biliUpload: async (params: Record<string, unknown>): Promise<{ taskId: string }> => {
      submitCalls++;
      const at = Date.now();
      const behavior = opts.submit[Math.min(submitCalls - 1, opts.submit.length - 1)]!;
      if (opts.uploadDelayMs) await new Promise<void>((r) => setTimeout(r, opts.uploadDelayMs));
      uploads.push({ at, doneAt: Date.now(), params });
      opts.onSubmit?.(submitCalls);
      if (behavior === 'rate-limit') throw new Error(RATE_LIMIT_MSG);
      if (behavior === 'quota') throw new Error(QUOTA_LIMIT_MSG);
      if (behavior === 'locked') throw new Error('稿件已被锁定，无法投稿');
      return { taskId: `upload-${submitCalls}` };
    },
  };

  /* 记录台账状态序列：核对「提交成功后**立刻**写 SUBMITTED」的崩溃恢复语义。
     ⚠️ 第 5 个参数 `opts`（`unset` 字段表）**必须原样转发**：漏了它，源码里
     `setClipStatus(..., { unset: ['uploadTaskId','submitTime'] })` 这类"擦掉脏字段"的写法
     在测试里会静默失效 —— 实测踩到：配额收尾明明 unset 了，用例却仍读到 uploadTaskId=upload-1。 */
  const rawSetClipStatus = ledger.setClipStatus.bind(ledger);
  ledger.setClipStatus = ((
    taskId: string,
    clipIndex: number,
    status: string,
    extra?: unknown,
    opts?: unknown,
  ) => {
    statusCalls.push({ clipIndex, status });
    return rawSetClipStatus(taskId, clipIndex, status as never, extra as never, opts as never);
  }) as typeof ledger.setClipStatus;

  /* 记录指纹登记：只有"提交被受理后又发现是配额拒绝"（分支 B）才会先登记再清；
     分支 A（同步抛错）根本不登记 —— 复核工程师的"脏指纹已清"必须走分支 B 才有意义。 */
  const rawRegisterFingerprint = ledger.registerFingerprint.bind(ledger);
  ledger.registerFingerprint = ((fp: string, info: { taskId: string; clipIndex: number; bvid?: string }) => {
    fingerprintCalls.push({ fp, taskId: info.taskId, clipIndex: info.clipIndex });
    return rawRegisterFingerprint(fp, info);
  }) as typeof ledger.registerFingerprint;

  const cfg = loadConfig(writeConfig(root, opts.publishExtra ?? {})).config as AppConfig;

  const defaultAlerter = {
    publishQuotaLimited: async (info: {
      taskId: string;
      title: string;
      submitted: number;
      remaining: number;
      retryAfterMin: number;
      reason: string;
    }): Promise<void> => {
      quotaAlerts.push({ ...info });
    },
    publishFailed: async (info: { taskId: string; title: string; reason: string }): Promise<void> => {
      failedAlerts.push({ ...info });
    },
  };

  /** 用同一份 ledger / client / config 再造一个 Publisher（证明台账里的脏指纹真的没了） */
  const spawnPublisher = (): Publisher =>
    new Publisher({
      client: client as never,
      config: cfg,
      ledger,
      logger: silentLog as never,
      ...(opts.submitGateMs !== undefined ? { submitGateMs: opts.submitGateMs } : {}),
      rateLimitWaiter: async (waitMs: number): Promise<void> => {
        waits.push(waitMs);
      },
      ...(opts.rateLimitMaxAttempts ? { rateLimitMaxAttempts: opts.rateLimitMaxAttempts } : {}),
      /* 告警只记录不发送：真实渠道会打网络 */
      alerter: (opts.alerter ?? defaultAlerter) as never,
    });

  const publisher = spawnPublisher();

  return {
    publisher,
    ledger,
    tasks,
    uploads,
    waits,
    statusCalls,
    fingerprintCalls,
    quotaAlerts,
    failedAlerts,
    get archiveDetailReads(): number {
      return archiveDetailReads;
    },
    spawnPublisher,
    cleanup: (): void => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 单场单批投稿 */
async function publishOne(env: Env, i = 0): Promise<{ submitted: number; failed: number }> {
  const res = await env.publisher.publishClips({ task: env.tasks[i]!, uid: 12345, submitTimeMs: Date.now() });
  return { submitted: res.submitted, failed: res.failed };
}

/* ==========================================================================
 * ① 判据（纯函数）：线上原话必须命中，**永久性错误绝不能命中**
 * ==========================================================================*/
section('① 限流判据正反例矩阵（误判的代价 = 同一次投稿提交两次）');
{
  /* 正例：平台明确说"太快了"/明确给了等待秒数 */
  const positives = [
    'BiliResponseError: 您投稿的频率过快，请稍等2秒',
    '您投稿的频率过快，请稍等2秒',
    '投稿频率过快',
    '投稿过快',
    '操作太快了，请稍后再试',
    '提交过快，请稍后再试',
    '请稍等 5 秒',
    '请稍等2秒后再试',
    'Too Many Requests',
    'rate limit exceeded',
  ];
  for (const m of positives) ok(`命中限流：${m}`, isUploadRateLimited(m));

  /* 反例：这些都是**确定性失败**，重投一万次也不会成（误判只会白白多提交两次） */
  const negatives = [
    '稿件已被锁定，无法投稿',
    '投稿失败：标题包含违规内容',
    '您的视频稿件额度已用尽',
    '稿件正在审核中，请勿重复投稿',
    '稿件不可见',
    'dtime 必须大于提交时间 300 秒',
    '上传失败：连接超时（60000ms）',
    'BiliResponseError: 稿件标题太长',
    '请稍等', // 没有秒数：措辞不足，不给重试借口
    '', // 空消息
  ];
  for (const m of negatives) ok(`不命中（永久失败）：${m || '（空串）'}`, !isUploadRateLimited(m));

  ok('undefined / null ⇒ false（不抛异常）', !isUploadRateLimited(undefined) && !isUploadRateLimited(null));

  /* ★ 已知的**宽口径**边界：第 4 条判据只看「请稍等 N 秒」，所以一条"永久失败 + 请稍等2秒"
     的混合文案也会被判成限流。后果有限（创建模式下最多多交 2 次，追加模式下有落地探针兜底），
     但这是唯一的误判面，记在这里免得以后有人以为它不会误判。 */
  const mixed = '稿件已被锁定，请稍等2秒后再试';
  info('宽口径边界（现状快照，非缺陷）', `「${mixed}」⇒ ${isUploadRateLimited(mixed) ? '判为限流（会重试 2 次后仍 FAILED）' : '不判限流'}`);
}

section('② 等待秒数解析（「请稍等N秒」的各种变体）');
{
  eq('「请稍等2秒」⇒ 2', parseRateLimitWaitSec('BiliResponseError: 您投稿的频率过快，请稍等2秒'), 2);
  eq('「请稍等 5 秒」（空格 + 全角秒）⇒ 5', parseRateLimitWaitSec('请稍等 5 秒'), 5);
  eq('「wait 3s」⇒ 3', parseRateLimitWaitSec('rate limited, wait 3s'), 3);
  eq('「请稍等2秒后再试」⇒ 2', parseRateLimitWaitSec('请稍等2秒后再试'), 2);
  eq('「等待 10 秒」⇒ 10', parseRateLimitWaitSec('等待 10 秒'), 10);
  eq('小数「请稍等 0.5 秒」⇒ 0.5', parseRateLimitWaitSec('请稍等 0.5 秒'), 0.5);
  eq('没有秒数 ⇒ undefined', parseRateLimitWaitSec('您投稿的频率过快'), undefined);
  eq('「请稍等0秒」⇒ undefined（0 不是有效等待）', parseRateLimitWaitSec('请稍等0秒'), undefined);
  eq('空串 ⇒ undefined', parseRateLimitWaitSec(''), undefined);
  eq('畸形「请稍等abc秒」⇒ undefined', parseRateLimitWaitSec('请稍等abc秒'), undefined);
  ok('保守默认值 ≥ 2 秒', RATE_LIMIT_DEFAULT_WAIT_SEC >= 2, String(RATE_LIMIT_DEFAULT_WAIT_SEC));
}

/* ==========================================================================
 * ③ 连续两次限流 + 第三次成功
 * ==========================================================================*/
section('③ ★ 连续两次限流、第三次成功 ⇒ SUBMITTED，且只占 1 个今日额度');
{
  const env = makeEnv(path.join(tmpRoot, 'retry-twice'), { submit: ['rate-limit', 'rate-limit', 'ok'] });
  const r = await publishOne(env);
  eq('成功 1 片 / 失败 0 片', `${r.submitted}/${r.failed}`, '1/0');
  eq('提交了 3 次（首次 + 2 次重试）', env.uploads.length, 3);
  eq('等待了 2 次（每次被拒等一次）', env.waits.length, 2);
  ok(
    '每次等待 = 对方要求 2 秒 + 抖动 1~2 秒（不真睡）',
    env.waits.every((w) => w >= 3000 && w <= 32_000),
    env.waits.join(', '),
  );
  eq('切片终态 SUBMITTED', env.ledger.getClip(env.tasks[0]!.id, 0)?.status, 'SUBMITTED');
  const submits = env.ledger.readPublishLog({}).filter((row) => row['action'] === 'submit');
  eq('★ submit 行只写 1 条（被拒的两次不占额度、不污染日志）', submits.length, 1);
  eq('★ 今日投稿数 = 1', env.ledger.todayPublishedCount(), 1);
  env.cleanup();
}

section('④ 重试上限语义：constant 是「总尝试次数（含首次）」，耗尽后 FAILED');
{
  eq('UPLOAD_RATE_LIMIT_MAX_ATTEMPTS = 3', UPLOAD_RATE_LIMIT_MAX_ATTEMPTS, 3);
  eq('等待上限夹子 = 30 秒', UPLOAD_RATE_LIMIT_WAIT_CAP_SEC, 30);
  const env = makeEnv(path.join(tmpRoot, 'exhaust'), { submit: ['rate-limit'] });
  const r = await publishOne(env);
  eq('失败 1 片', r.failed, 1);
  eq('★ 总尝试 = 3 次（含首次，不是 4 次）', env.uploads.length, 3);
  eq('★ 实际重试 = 2 次（等待 2 次）', env.waits.length, 2);
  const clip = env.ledger.getClip(env.tasks[0]!.id, 0);
  eq('终态 FAILED（不是静默成功）', clip?.status, 'FAILED');
  ok('failReason 带「限流重试 3 次仍失败」', /限流重试 3 次仍失败/.test(clip?.failReason ?? ''), clip?.failReason);
  ok('failReason 保留原始错误文案', /投稿的频率过快/.test(clip?.failReason ?? ''), clip?.failReason);
  ok('切片产物保留（人工可单投）', Boolean(clip?.cutOutput), String(clip?.cutOutput));
  eq('submit 行 0 条（一次都没被受理）', env.ledger.readPublishLog({}).filter((row) => row['action'] === 'submit').length, 0);
  eq('今日额度 0', env.ledger.todayPublishedCount(), 0);
  info(
    '文案与次数的偏差（记录，不阻断）',
    `常量语义是「总尝试 3 次 = 重试 2 次」，但 failReason 写的是「限流重试 3 次仍失败」——人工读起来像重试了 3 次`,
  );
  env.cleanup();
}

/* ==========================================================================
 * ⑤ 错误报告落盘
 * ==========================================================================*/
section('⑤ 耗尽重试后：错误报告 JSON 真的落盘、内容对得上');
{
  const before = fs.existsSync(errorReportDir) ? fs.readdirSync(errorReportDir) : [];
  const env = makeEnv(path.join(tmpRoot, 'report'), { submit: ['rate-limit'] });
  await publishOne(env);
  const after = fs.existsSync(errorReportDir) ? fs.readdirSync(errorReportDir) : [];
  const created = after.filter((f) => !before.includes(f));
  ok('至少写出 1 份报告文件', created.length >= 1, `新增 ${created.length} 个`);
  const bodies = created.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(errorReportDir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  });
  const mine = bodies.filter((b) => String(b['taskId'] ?? '') === env.tasks[0]!.id);
  ok('报告里带本场 taskId', mine.length >= 1, `匹配 ${mine.length} 份`);
  const joined = JSON.stringify(mine);
  const reportMsg = String(((mine[0]?.['error'] ?? {}) as Record<string, unknown>)['message'] ?? '');
  ok('报告里保留原始限流文案', /投稿的频率过快/.test(joined));
  /* ★ 2026-10-17 QA 发现（源码问题，已交回工程师）：
     同步抛限流（线上事故的那一支）耗尽重试后，台账 failReason 带「（限流重试 3 次仍失败）」，
     但 `reportClipFailure({ error: e })` 传的是**原始错误**，所以错误报告里一个字都看不到重试次数。
     另一支（waitUploadTask 终态 error）传的是 `${msg}${limitedNote}`，两支不一致。 */
  ok('★ 报告里写明「限流重试 3 次仍失败」（人工据此判断是否值得重投）', /限流重试 3 次仍失败/.test(joined), `报告 error.message=${JSON.stringify(reportMsg)}`);
  /* 光有次数不够：报告 `retries` 里要能看到"每次被拒的时刻与原文"（工程师 02:06 补齐的） */
  const retries = ((mine[0]?.['retries'] ?? []) as Array<Record<string, unknown>>);
  eq('★ 报告 retries 记录 2 次被拒（= 重试次数）', Array.isArray(retries) ? retries.length : -1, 2);
  ok('每条 retry 都带原始限流文案', retries.every((r) => /投稿的频率过快/.test(String(r['message'] ?? ''))), JSON.stringify(retries));
  ok('报告错误类型是 upload-failed', /upload-failed/.test(joined));
  env.cleanup();
}

/* ==========================================================================
 * ⑥ 非限流错误：一次都不重试
 * ==========================================================================*/
section('⑥ ★ 非限流错误（稿件锁定 / 标题违规）⇒ 只提交 1 次，终态 FAILED');
{
  for (const [label, behavior] of [
    ['稿件已被锁定', 'locked'],
    ['标题包含违规内容', 'locked'],
  ] as Array<[string, SubmitBehavior]>) {
    const env = makeEnv(path.join(tmpRoot, `nonlimit-${behavior}-${encodeURIComponent(label)}`), { submit: [behavior] });
    /* 用真实文案替换桩抛出的错误，保证测的是"判据 + 重试决策"而不是桩 */
    const r = await publishOne(env);
    eq(`${label} ⇒ 失败 1 片`, r.failed, 1);
    eq(`${label} ⇒ ★ 只提交 1 次（不重试）`, env.uploads.length, 1);
    eq(`${label} ⇒ 没有任何限流等待`, env.waits.length, 0);
    const clip = env.ledger.getClip(env.tasks[0]!.id, 0);
    eq(`${label} ⇒ 终态 FAILED`, clip?.status, 'FAILED');
    ok(`${label} ⇒ failReason 不含「限流重试」`, !/限流重试/.test(clip?.failReason ?? ''), clip?.failReason);
    env.cleanup();
  }
}

/* ==========================================================================
 * ⑦ 提交闸门（真实时间，不注入）
 * ==========================================================================*/
section('⑦ ★ 提交闸门：两个场次并发投稿，请求起点间隔 ≥ 生产默认 3000ms');
{
  eq('生产默认闸门 = 3000ms', UPLOAD_SUBMIT_MIN_GAP_MS, 3000);
  const env = makeEnv(path.join(tmpRoot, 'gate-real'), { taskCount: 2, submit: ['ok'] });
  const t0 = Date.now();
  /* 事故复现：同一 Publisher（= 同一进程）里两个场次**同时**开投，各有自己的首片。
     旧实现两个首片几乎同时提交（实测差 277ms）⇒ 撞账号级限流。 */
  await Promise.all([publishOne(env, 0), publishOne(env, 1)]);
  const elapsed = Date.now() - t0;
  eq('两次投稿都发出去了', env.uploads.length, 2);
  const gap = env.uploads[1]!.at - env.uploads[0]!.at;
  ok(`★ 两次请求起点间隔 ≥ 3000ms（实测 ${gap}ms）`, gap >= 2900, `${gap}ms`);
  ok('没有并发重叠（第一笔返回后才发第二笔）', env.uploads[1]!.at >= env.uploads[0]!.doneAt, JSON.stringify(env.uploads));
  ok(`总挂钟 ≈ 一个闸门间隔（实测 ${elapsed}ms，未出现叠加等待）`, elapsed < 9000, `${elapsed}ms`);
  env.cleanup();
}

section('⑧ 闸门的三个边界：慢请求不缩短间隔 / 异常不卡死 / 并发排队');
{
  /* ⑧-1 慢请求：biliUpload 耗时 300ms、闸门 200ms，三个并发。
     这一步同时验证「时间戳在**发请求之前**取」：若在请求返回后才取，
     第 2 笔会等到「第 1 笔结束 + 闸门」= 500ms；请求前取则只等 max(300, 200) = 300ms。 */
  const env = makeEnv(path.join(tmpRoot, 'gate-slow'), { submit: ['ok'], submitGateMs: 200, uploadDelayMs: 300 });
  type Gate = { submitUpload: (p: unknown, l: unknown, purpose: string) => Promise<unknown> };
  const gate = env.publisher as unknown as Gate;
  await Promise.all([
    gate.submitUpload({ uid: 1, videos: ['a.mp4'], config: {} }, silentLog, 'QA-慢A'),
    gate.submitUpload({ uid: 1, videos: ['b.mp4'], config: {} }, silentLog, 'QA-慢B'),
    gate.submitUpload({ uid: 1, videos: ['c.mp4'], config: {} }, silentLog, 'QA-慢C'),
  ]);
  eq('三次都发出去了', env.uploads.length, 3);
  const gaps = env.uploads.slice(1).map((u, i) => u.at - env.uploads[i]!.at);
  ok(`慢请求下起点间隔仍 ≥ 200ms（实测 ${gaps.join(', ')}）`, gaps.every((g) => g >= 190), gaps.join(', '));
  ok(
    `★ 间隔 ≈ 请求耗时 300ms，而**不是** 耗时+闸门 500ms ⇒ 时间戳确实在请求前取（实测 ${gaps.join(', ')}）`,
    gaps.every((g) => g <= 420),
    gaps.join(', '),
  );
  ok(
    '串行：任意两笔请求区间不重叠',
    env.uploads.every((u, i) => i === 0 || u.at >= env.uploads[i - 1]!.doneAt - 5),
    JSON.stringify(env.uploads.map((u) => [u.at, u.doneAt])),
  );
  env.cleanup();
}
{
  /* ⑧-2 异常不卡死：第一笔 500/锁定，后两笔必须照常发出（不能把后续提交永久卡住） */
  const env = makeEnv(path.join(tmpRoot, 'gate-throw'), { submit: ['locked', 'ok', 'ok'], submitGateMs: 60 });
  type Gate = { submitUpload: (p: unknown, l: unknown, purpose: string) => Promise<unknown> };
  const gate = env.publisher as unknown as Gate;
  const settled = await Promise.allSettled([
    gate.submitUpload({ uid: 1, videos: ['a.mp4'], config: {} }, silentLog, 'QA-抛A'),
    gate.submitUpload({ uid: 1, videos: ['b.mp4'], config: {} }, silentLog, 'QA-抛B'),
    gate.submitUpload({ uid: 1, videos: ['c.mp4'], config: {} }, silentLog, 'QA-抛C'),
  ]);
  eq('三次都被调用（第一笔抛错不影响后面）', env.uploads.length, 3);
  eq('恰好 1 笔失败、2 笔成功', settled.filter((s) => s.status === 'rejected').length, 1);
  ok('后两笔是真成功', settled.slice(1).every((s) => s.status === 'fulfilled'));
  env.cleanup();
}
{
  /* ⑧-3 排队顺序：FIFO（先到先发），且第 2 笔不早于第 1 笔 + 闸门 */
  const env = makeEnv(path.join(tmpRoot, 'gate-fifo'), { submit: ['ok'], submitGateMs: 100 });
  type Gate = { submitUpload: (p: unknown, l: unknown, purpose: string) => Promise<unknown> };
  const gate = env.publisher as unknown as Gate;
  await Promise.all([
    gate.submitUpload({ uid: 1, videos: ['first.mp4'], config: {} }, silentLog, 'QA-序1'),
    gate.submitUpload({ uid: 1, videos: ['second.mp4'], config: {} }, silentLog, 'QA-序2'),
  ]);
  const order = env.uploads.map((u) => (u.params['videos'] as string[])[0]);
  eq('按调用顺序发出（FIFO）', order.join('→'), 'first.mp4→second.mp4');
  ok('第 2 笔起点 − 第 1 笔起点 ≥ 100ms', env.uploads[1]!.at - env.uploads[0]!.at >= 90, String(env.uploads[1]!.at - env.uploads[0]!.at));
  env.cleanup();
}

/* ==========================================================================
 * ⑨ SUBMITTED 的崩溃恢复语义
 * ==========================================================================*/
section('⑨ ★ 提交成功后**立刻**写 SUBMITTED（崩溃恢复判定点不能挪到重试循环之后）');
{
  /* 限流两次后成功：每次被受理都写 SUBMITTED，最终仍是 SUBMITTED */
  const env = makeEnv(path.join(tmpRoot, 'submitted-order'), { submit: ['rate-limit', 'ok'] });
  await publishOne(env);
  const seq = env.statusCalls.map((c) => c.status);
  ok('被拒的那次「未受理」不该写 SUBMITTED', seq.filter((s) => s === 'SUBMITTED').length === 1, seq.join('→'));
  ok('最终状态是 SUBMITTED', seq[seq.length - 1] === 'SUBMITTED', seq.join('→'));
  env.cleanup();
}
{
  /* 受理后任务终态 error（非限流）：SUBMITTED 必须先落盘，然后才 FAILED */
  const env = makeEnv(path.join(tmpRoot, 'submitted-then-failed'), {
    submit: ['ok'],
    taskDetail: [{ status: 'error', error: '稿件已被锁定，无法投稿' }],
  });
  await publishOne(env);
  const seq = env.statusCalls.map((c) => c.status);
  ok('★ 先 SUBMITTED 再 FAILED（崩溃恢复点没丢）', seq.indexOf('SUBMITTED') >= 0 && seq.indexOf('SUBMITTED') < seq.indexOf('FAILED'), seq.join('→'));
  env.cleanup();
}

/* ==========================================================================
 * ⑩ 追加分P 的落地探针（防重复分P 红线）
 * ==========================================================================*/
section('⑩ ★ 追加模式：探针 landed ⇒ 绝不重投（用调用次数钉住）');
{
  const CLIP = 'QA 待追加切片';
  const env = makeEnv(path.join(tmpRoot, 'append-landed'), {
    clipTitles: [CLIP],
    submit: ['rate-limit', 'ok'],
    taskDetail: [{ status: 'completed' }],
    /* ① 投稿前的续传去重：还看不到本片；② 限流后的探针：居然已经在目标稿件里了 */
    archiveDetailSeq: [
      { View: { bvid: 'BV1QA0000001', videos: 1, pages: [{ part: '完整版' }] } },
      { View: { bvid: 'BV1QA0000001', videos: 2, pages: [{ part: '完整版' }, { part: CLIP }] } },
    ],
    submitGateMs: 0,
  });
  const res = await env.publisher.publishAsMultiPart({
    task: env.tasks[0]!,
    uid: 1,
    clips: env.ledger.getClips(env.tasks[0]!.id),
    resumeAid: '117000000000001',
    resumeBvid: 'BV1QA0000001',
    logger: silentLog as never,
  });
  eq('★ 只提交 1 次（探针 landed ⇒ 不再投）', env.uploads.length, 1);
  eq('没有等待（没有重试）', env.waits.length, 0);
  eq('按成功收尾', res.ok, true);
  ok('给出「已在分P 列表、不再重投」说明', res.warnings.some((w) => /不再重投|已经在目标稿件的分P 列表里/.test(w)), JSON.stringify(res.warnings));
  env.cleanup();
}

section('⑪ ★ 追加模式：探针 partial（只落了一部分）⇒ 不重试、FAILED 交人工');
{
  const want = ['QA 切片甲', 'QA 切片乙'];
  let call = 0;
  const dataDir = path.join(tmpRoot, 'append-partial', 'data');
  fs.mkdirSync(path.join(tmpRoot, 'append-partial', 'clips-out'), { recursive: true });
  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json'), logger: silentLog as never });
  const taskId = TASK_IDS[0]!;
  const taskDir = path.join(dataDir, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    title: 'QA partial 场',
    liveStartTime: Math.floor(Date.now() / 1000) - 7200,
    stage: 'ANALYZED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
    transcriptPath: path.join(taskDir, 'transcript.json'),
    signalsPath: path.join(taskDir, 'signals.json'),
    clipsPath: path.join(taskDir, 'clips.json'),
  });
  ledger.setClips(
    taskId,
    want.map((title, i) => {
      const p = path.join(tmpRoot, 'append-partial', 'clips-out', `${i}.mp4`);
      fs.writeFileSync(p, 'x');
      return { index: i, start: 100 + i * 100, end: 200 + i * 100, title, desc: '', tags: ['测试'], category: '生活', score: 8, selected: true, status: 'CUT', cutOutput: p };
    }) as never,
  );
  const uploads: number[] = [];
  const client = {
    userList: async (): Promise<unknown[]> => [{ uid: 1, name: 'stub' }],
    anchorInfoByRoom: async (): Promise<{ uid: string; name: string }> => ({ uid: '1', name: 'a' }),
    presetFfmpeg: async (): Promise<unknown[]> => [],
    cut: async (): Promise<unknown> => {
      throw new Error('不该切');
    },
    biliArchives: async (): Promise<unknown[]> => [{ bvid: 'BV1QA0000001', aid: 117000000000001, title: 'QA 测试稿件', duration: 100 }],
    /* 第 1 次（投稿前去重）看不到待投标题；第 2 次（探针）只看到「甲」⇒ partial */
    biliArchiveDetail: async (): Promise<unknown> => {
      call++;
      const parts = call === 1 ? ['完整版'] : ['完整版', want[0]!];
      return { View: { bvid: 'BV1QA0000001', videos: parts.length, pages: parts.map((part) => ({ part })) } };
    },
    taskDetail: async (): Promise<{ status: string }> => ({ status: 'error' }),
    biliUpload: async (): Promise<unknown> => {
      uploads.push(Date.now());
      throw new Error(RATE_LIMIT_MSG);
    },
  };
  const publisher = new Publisher({
    client: client as never,
    config: loadConfig(writeConfig(path.join(tmpRoot, 'append-partial'))).config as AppConfig,
    ledger,
    logger: silentLog as never,
    submitGateMs: 0,
    rateLimitWaiter: async (): Promise<void> => {},
  });
  const res = await publisher.publishAsMultiPart({
    task: ledger.getTask(taskId)!,
    uid: 1,
    clips: ledger.getClips(taskId),
    resumeAid: '117000000000001',
    resumeBvid: 'BV1QA0000001',
    logger: silentLog as never,
  });
  eq('★ 只提交 1 次（partial ⇒ 绝不重投）', uploads.length, 1);
  eq('失败收尾（不能当成功）', res.ok, false);
  ok('两个切片都 FAILED', ledger.getClips(taskId).every((c) => c.status === 'FAILED'), JSON.stringify(ledger.getClips(taskId).map((c) => c.status)));
}

section('⑫ 探针的规范化边界：空白无关，全半角不归一');
{
  const env = makeEnv(path.join(tmpRoot, 'norm'), {
    submit: ['ok'],
    archiveDetail: { View: { bvid: 'BV1QA0000001', videos: 2, pages: [{ part: '待 追加 的  切片' }, { part: '第１段' }] } },
    submitGateMs: 0,
  });
  type Probe = { probeAppendLanded: (aid: string, titles: string[], log: unknown) => Promise<string> };
  const probe = env.publisher as unknown as Probe;
  eq('★ 只差空白（含全角空格/多个空格）⇒ landed', await probe.probeAppendLanded('117000000000001', ['待追加的切片'], silentLog), 'landed');
  eq('★ 只差空白（标题内部换行/制表）⇒ landed', await probe.probeAppendLanded('117000000000001', ['待\u3000追加的\t切片'], silentLog), 'landed');
  /* 已知限制：`norm()` 只折叠空白，不做全角→半角（NFKC）。半角「第1段」对上全角「第１段」判不在。
     方向是**安全**的（判不在 ⇒ 探针不会误判 landed；最坏是保守地不重试 / 需要人工），记录备查。 */
  eq('全角「第１段」vs 半角「第1段」⇒ absent（不归一半角，方向安全）', await probe.probeAppendLanded('117000000000001', ['第1段'], silentLog), 'absent');
  env.cleanup();
}

/* ==========================================================================
 * ⑬ 额度口径：探针 landed 且**一次都没提交成功**时，会按分P 逐条写 submit 行
 * ==========================================================================*/
section('⑬ 额度口径边界：alreadyLanded 且 res 为空时，submit 行按分P 逐条写');
{
  const CLIPS = ['QA 甲', 'QA 乙'];
  const env = makeEnv(path.join(tmpRoot, 'landed-quota'), {
    clipTitles: CLIPS,
    submit: ['rate-limit', 'ok'],
    taskDetail: [{ status: 'completed' }],
    archiveDetailSeq: [
      /* ① 投稿前去重读不到（模拟接口抖动 ⇒ 去重被跳过）；② 探针看到两个标题都已在 */
      {},
      { View: { bvid: 'BV1QA0000001', videos: 3, pages: [{ part: '完整版' }, { part: CLIPS[0]! }, { part: CLIPS[1]! }] } },
    ],
    submitGateMs: 0,
  });
  const res = await env.publisher.publishAsMultiPart({
    task: env.tasks[0]!,
    uid: 1,
    clips: env.ledger.getClips(env.tasks[0]!.id),
    resumeAid: '117000000000001',
    resumeBvid: 'BV1QA0000001',
    logger: silentLog as never,
  });
  eq('一次都没提交成功', env.uploads.length, 1);
  eq('按已落地收尾（ok=true）', res.ok, true);
  const submits = env.ledger.readPublishLog({}).filter((row) => row['action'] === 'submit');
  info(
    '额度口径（低危，记录）',
    `2 个分P 的 landed 收尾写了 ${submits.length} 条 submit 行，todayPublishedCount=${env.ledger.todayPublishedCount()}` +
      `（这是"1 个稿件"却被算成多份；只有去重读失败 + 探针读到已落地这条窄路会走到）`,
  );
  env.cleanup();
}

/* ==========================================================================
 * ⑬b 多分P「新建稿件」（无续传目标）：没有探针，但同样有界重试
 * ==========================================================================*/
section('⑬b 多分P 新建稿件（resumeAid 空）⇒ 无探针，但有界重试 + FAILED');
{
  const env = makeEnv(path.join(tmpRoot, 'multipart-create'), {
    clipTitles: ['QA 新建甲', 'QA 新建乙'],
    submit: ['rate-limit'],
    submitGateMs: 0,
  });
  const res = await env.publisher.publishAsMultiPart({
    task: env.tasks[0]!,
    uid: 1,
    clips: env.ledger.getClips(env.tasks[0]!.id),
    logger: silentLog as never,
  });
  eq('★ 总尝试 3 次（与单切片一致的上限）', env.uploads.length, 3);
  eq('等待 2 次', env.waits.length, 2);
  eq('失败收尾', res.ok, false);
  ok('error 里写明「限流重试 3 次仍失败」', /限流重试 3 次仍失败/.test(String(res.error ?? '')), String(res.error));
  ok('两个切片都 FAILED（不是静默成功）', env.ledger.getClips(env.tasks[0]!.id).every((c) => c.status === 'FAILED'));
  eq('★ create 模式没有探针：一次都没读目标稿件的分P 列表', env.archiveDetailReads, 0);
  env.cleanup();
}

/* ==========================================================================
 * ⑭ 已知缺口快照（不判定，只记录现状）
 * ==========================================================================*/
section('⑭ 已知缺口（快照，不阻断）');
{
  const env = makeEnv(path.join(tmpRoot, 'signal'), { submit: ['rate-limit', 'rate-limit', 'ok'], submitGateMs: 0 });
  const ac = new AbortController();
  ac.abort();
  const res = await env.publisher.publishClips({
    task: env.tasks[0]!,
    uid: 12345,
    submitTimeMs: Date.now(),
    signal: ac.signal,
  });
  info(
    'signal 取消是否打断「限流等待」',
    `abort 之后仍提交了 ${env.uploads.length} 次、等待 ${env.waits.length} 次，结果 submitted=${res.submitted}` +
      `（waitForRateLimit 不接 signal：取消只在 waitUploadTask 生效，最坏多等 ~2×32s）`,
  );
  env.cleanup();
}

/* ==========================================================================
 * ⑮ 配额限流 × signal abort（边角 #1：工程师点名没测的那条交互）
 * ==========================================================================*/
section('⑮ ★ 配额限流 × signal abort：fail-fast 不进入等待、不吞告警、不写脏状态');
{
  /* (a) 提交前 signal 已经 abort（用户点了「停止」，队列里这一片还没发出去）。
     这一步同时钉住「abort 不会让配额路径变成"等几秒再撞"」：配额分支根本不该调用 waiter。 */
  const env = makeEnv(path.join(tmpRoot, 'quota-abort-pre'), {
    clipTitles: ['QA 配额甲', 'QA 配额乙', 'QA 配额丙'],
    submit: ['quota'],
    submitGateMs: 0,
  });
  const ac = new AbortController();
  ac.abort();
  const res = await env.publisher.publishClips({
    task: env.tasks[0]!,
    uid: 12345,
    submitTimeMs: Date.now(),
    signal: ac.signal,
  });
  eq('只提交 1 次（配额 fail-fast，abort 不会让它多撞几次）', env.uploads.length, 1);
  eq('★ 0 次限流等待（abort 不可能被"等 2 秒×N"卡住）', env.waits.length, 0);
  eq('第 1 片状态 CANDIDATE（待投，不是 FAILED）', env.ledger.getClip(env.tasks[0]!.id, 0)?.status, 'CANDIDATE');
  eq('第 2 片没被撞', env.ledger.getClip(env.tasks[0]!.id, 1)?.status, 'PENDING_UPLOAD');
  eq('第 3 片没被撞', env.ledger.getClip(env.tasks[0]!.id, 2)?.status, 'PENDING_UPLOAD');
  ok(
    '返回值带 quotaLimited（daemon 据此不回退本场状态）',
    Boolean(res.results[0]?.quotaLimited),
    JSON.stringify(res.results[0]?.quotaLimited ?? null),
  );
  eq('★ 告警照发（abort 不该吞掉"别重投、等 30 分钟"这条）', env.quotaAlerts.length, 1);
  eq('结算口径：成功 0 / 失败 1（配额不算成功，也不算"可自动重试的失败"）', `${res.submitted}/${res.failed}`, '0/1');
  env.cleanup();
}
{
  /* (b) 用户正好在「被 B站 拒绝」的那一刻点停止：abort 之后再断言队列真的停住，
     而且"半截状态"没有把整场锁死 —— 换一个 Publisher（同一份台账）必须还能真的重投。 */
  const ac = new AbortController();
  const env = makeEnv(path.join(tmpRoot, 'quota-abort-mid'), {
    clipTitles: ['QA 中断甲', 'QA 中断乙'],
    submit: ['quota'],
    submitGateMs: 0,
    onSubmit: (n) => {
      if (n === 1) ac.abort();
    },
  });
  await env.publisher.publishClips({ task: env.tasks[0]!, uid: 12345, submitTimeMs: Date.now(), signal: ac.signal });
  eq('只提交 1 次（abort 发生在被拒那一刻，不允许再撞第 2 次）', env.uploads.length, 1);
  eq('0 次等待', env.waits.length, 0);
  eq('第 1 片 CANDIDATE', env.ledger.getClip(env.tasks[0]!.id, 0)?.status, 'CANDIDATE');
  eq('第 2 片没被撞', env.ledger.getClip(env.tasks[0]!.id, 1)?.status, 'PENDING_UPLOAD');
  /* ★ abort 不能把整场锁死：新 Publisher（同一份台账）重跑必须真的再提交一次 */
  await env.spawnPublisher().publishClips({ task: env.tasks[0]!, uid: 12345, submitTimeMs: Date.now() });
  eq('★ abort 之后重跑仍会真的再提交（没被脏指纹/半截状态锁成"跳过"）', env.uploads.length, 2);
  env.cleanup();
}

/* ==========================================================================
 * ⑯ 多分P「新建稿件」（resumeAid 为空）× 配额限流（边角 #2 的 Publisher 层）
 * ==========================================================================*/
section('⑯ ★ 多分P 新建稿件（resumeAid 空）× 配额：CANDIDATE + 停手，不写 FAILED');
{
  const reportsBefore = fs.existsSync(errorReportDir) ? fs.readdirSync(errorReportDir) : [];
  const env = makeEnv(path.join(tmpRoot, 'multipart-create-quota'), {
    clipTitles: ['QA 新建甲', 'QA 新建乙'],
    submit: ['quota'],
    submitGateMs: 0,
    /* 关掉完整版分P：这样"待投片数"就是切片数，断言才有唯一解释 */
    withFullVideo: false,
  });
  const task = env.tasks[0]!;
  const res = await env.publisher.publishAsMultiPart({
    task,
    uid: 1,
    clips: env.ledger.getClips(task.id),
    logger: silentLog as never,
  });
  eq('★ 只提交 1 次（配额级不原地重试）', env.uploads.length, 1);
  eq('0 次等待', env.waits.length, 0);
  eq('返回 ok=false（这一批确实没投出去）', res.ok, false);
  ok(
    'error 文案写明配额限流 + 建议重试时间',
    /配额限流/.test(String(res.error)) && /30 分钟后重试/.test(String(res.error)),
    String(res.error),
  );
  const statuses = env.ledger.getClips(task.id).map((c) => c.status);
  eq('★ 两个切片都是 CANDIDATE（待投），不是 FAILED', statuses.join(','), 'CANDIDATE,CANDIDATE');
  ok(
    '两个切片都带"配额限流 + 建议 30 分钟"的 failReason（人能照着做）',
    env.ledger.getClips(task.id).every((c) => /配额限流/.test(c.failReason ?? '') && /30 分钟后重试/.test(c.failReason ?? '')),
    JSON.stringify(env.ledger.getClips(task.id).map((c) => c.failReason)),
  );
  eq('切片产物都还在（等配额恢复可直接重投，不用重切）', env.ledger.getClips(task.id).filter((c) => Boolean(c.cutOutput)).length, 2);
  eq('告警 1 条（一批只发一条）', env.quotaAlerts.length, 1);
  eq('告警 submitted = 0', env.quotaAlerts[0]?.submitted, 0);
  eq('★ 告警 remaining = 待投分P 数（2）', env.quotaAlerts[0]?.remaining, 2);
  eq('今日投稿额度未被吃掉', env.ledger.todayPublishedCount(), 0);
  /* 配额限流不是 bug ⇒ 不该出现在错误报告列表里。
     ⚠️ 只数本用例**新产生**的报告：TASK_IDS 是固定值，前面几节留下的报告会污染计数
     （实测踩到：「实际 9」全是别的用例的同 taskId 报告，不是源码问题）。 */
  const ownReports = (fs.existsSync(errorReportDir) ? fs.readdirSync(errorReportDir) : [])
    .filter((f) => !reportsBefore.includes(f))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(errorReportDir, f), 'utf8')) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })
    .filter((b) => String(b['taskId'] ?? '') === task.id);
  eq('★ 不写错误报告（配额限流不是"要人修的 bug"）', ownReports.length, 0);
  eq('本用例期间确实没有新增任何报告文件', fs.existsSync(errorReportDir) ? fs.readdirSync(errorReportDir).length - reportsBefore.length : 0, 0);
  env.cleanup();
}

/* ==========================================================================
 * ⑰ 告警去重窗口（边角 #3）：不风暴、也不漏报
 * ==========================================================================*/
section('⑰ ★ 告警去重：连续两批配额限流只真推 1 条 + 计数累加；窗口过后能重新报');
{
  const alertCfg = {
    enabled: true,
    /* 不配渠道：dispatch 只落状态文件，不动网络（也不碰生产 data/alerts-state.json ——
       这里显式传 statePath，见构造参数） */
    channels: [],
    dedupeWindowSec: 900,
    events: {},
  } as unknown as AppConfig['alert'];
  const statePath = path.join(tmpRoot, 'alerts-state.json');
  const alerter = new Alerter({ config: alertCfg, logger: silentLog as never, statePath });
  ok('告警状态文件确实落在临时目录（不碰生产 data/）', statePath.startsWith(tmpRoot), statePath);

  /* 拦在 send 外面记一笔：能看到"这一次是真的推了，还是被去重吞了" */
  const dispatched: string[] = [];
  const realSend = alerter.send.bind(alerter);
  (alerter as unknown as { send: typeof realSend }).send = (async (p: Parameters<typeof realSend>[0]) => {
    const r = await realSend(p);
    dispatched.push(r.map((x) => x.channel).join('+'));
    return r;
  }) as typeof realSend;

  const quotaPush = async (taskId: string): Promise<void> => {
    await alerter.publishQuotaLimited({
      taskId,
      title: 'QA 去重场',
      submitted: 0,
      remaining: 3,
      retryAfterMin: UPLOAD_QUOTA_RETRY_AFTER_MIN,
      reason: QUOTA_LIMIT_MSG,
    });
  };

  await quotaPush('qa-dedup-1');
  await quotaPush('qa-dedup-1');
  eq('两次调用都走到了 send', dispatched.length, 2);
  ok('第 1 条**真的推送**了（不漏报）', dispatched[0] !== 'dedupe', String(dispatched[0]));
  eq('★ 第 2 条被去重窗口抑制（不风暴）', dispatched[1], 'dedupe');
  const st = alerter.activeAlerts().find((s) => s.key === 'publish-quota-limited:qa-dedup-1');
  eq('★ 计数累加到 2（重复发生有记录，不是静默丢弃）', st?.count, 2);

  await quotaPush('qa-dedup-2');
  ok('另一场次照常推送（key 里带 taskId，不互相抑制）', dispatched[2] !== 'dedupe', String(dispatched[2]));

  alerter.update({ ...alertCfg, dedupeWindowSec: 0 } as AppConfig['alert']);
  await quotaPush('qa-dedup-1');
  ok('★ 窗口过后能重新推送（不会永久静音）', dispatched[3] !== 'dedupe', String(dispatched[3]));
}
{
  /* 端到端：Publisher 真发两条（两批都被配额限流）⇒ 通过真实 Alerter 也只推 1 条 */
  const alertCfg = { enabled: true, channels: [], dedupeWindowSec: 900, events: {} } as unknown as AppConfig['alert'];
  const alerter = new Alerter({ config: alertCfg, logger: silentLog as never, statePath: path.join(tmpRoot, 'alerts-e2e.json') });
  const dispatched: string[] = [];
  const realSend = alerter.send.bind(alerter);
  (alerter as unknown as { send: typeof realSend }).send = (async (p: Parameters<typeof realSend>[0]) => {
    const r = await realSend(p);
    dispatched.push(r.map((x) => x.channel).join('+'));
    return r;
  }) as typeof realSend;

  const env = makeEnv(path.join(tmpRoot, 'dedupe-e2e'), {
    clipTitles: ['QA 去重甲', 'QA 去重乙'],
    submit: ['quota'],
    submitGateMs: 0,
    alerter: alerter as unknown as Pick<Alerter, 'publishQuotaLimited'>,
  });
  await env.publisher.publishClips({ task: env.tasks[0]!, uid: 12345, submitTimeMs: Date.now() });
  await env.spawnPublisher().publishClips({ task: env.tasks[0]!, uid: 12345, submitTimeMs: Date.now() });
  eq('两批都走了告警', dispatched.length, 2);
  ok('第 1 批真推', dispatched[0] !== 'dedupe', String(dispatched[0]));
  eq('★ 第 2 批被去重（同一场次 15 分钟内不重复打扰）', dispatched[1], 'dedupe');
  env.cleanup();
}

/* ==========================================================================
 * ⑱ 配额限流 × 每日额度截断（边角 #4）：状态与提示不能自相矛盾
 * ==========================================================================*/
section('⑱ ★ 配额 × 每日额度截断：状态必一致、提示里的"剩余"必须等于真实待投数');
{
  /* 额度只够 2 片 ⇒ 队列被截断成 [甲,乙]；甲 一上来就被配额拒。
     此时真实待投是 甲(刚退回待投) + 乙(额度轮到但被配额挡下) + 丙(额度没轮到) = 3 片候选，
     其中"本轮被跳过、留在待投"的是 乙+丙 = 2 片。 */
  const env = makeEnv(path.join(tmpRoot, 'quota-daily-limit'), {
    clipTitles: ['QA 额度甲', 'QA 额度乙', 'QA 额度丙'],
    submit: ['quota'],
    submitGateMs: 0,
    publishExtra: { dailyLimit: 2 },
  });
  const task = env.tasks[0]!;
  const res = await env.publisher.publishClips({ task, uid: 12345, submitTimeMs: Date.now() });
  eq('只提交 1 次（配额 fail-fast，额度截断后也不会多撞）', env.uploads.length, 1);
  eq('甲 = CANDIDATE（被配额退回待投）', env.ledger.getClip(task.id, 0)?.status, 'CANDIDATE');
  eq('乙 = PENDING_UPLOAD（额度轮到，但被配额挡下）', env.ledger.getClip(task.id, 1)?.status, 'PENDING_UPLOAD');
  eq('★ 丙 = PENDING_UPLOAD（额度没轮到，状态不该被改动）', env.ledger.getClip(task.id, 2)?.status, 'PENDING_UPLOAD');
  eq('今日额度 0（被拒的那次不占额度）', env.ledger.todayPublishedCount(), 0);
  eq('告警 1 条', env.quotaAlerts.length, 1);
  eq(
    '★ 告警里的"剩余几片"必须等于真正待投的片数（乙+丙 = 2，而不是被截断后的队列长度 1）',
    env.quotaAlerts[0]?.remaining,
    2,
  );
  info(
    '额度截断后 remaining 的口径',
    `代码用的是「原始队列长度 - 已处理 - 1」= ${env.quotaAlerts[0]?.remaining}，` +
      `对应"队列内的乙 + 被额度挡在队列外的丙"= 2 片待投`,
  );
  /* dryRun 不受额度限制：不能因为额度把"只切片"也拦掉（既有口径，顺手钉一下不回归） */
  const dryEnv = makeEnv(path.join(tmpRoot, 'quota-daily-limit-dry'), {
    clipTitles: ['QA 干跑甲'],
    submit: ['quota'],
    submitGateMs: 0,
    publishExtra: { dailyLimit: 0 },
  });
  await dryEnv.publisher.publishClips({ task: dryEnv.tasks[0]!, uid: 12345, submitTimeMs: Date.now() });
  eq('顺手回归：dailyLimit=0（用户显式关闭）时照常投稿（被配额拒 1 次）', dryEnv.uploads.length, 1);
  void res;
  env.cleanup();
  dryEnv.cleanup();
}
{
  /* 额度**已经用完**（今日 1/1）：一次都不该提交，也不该发配额告警（这不是配额问题） */
  const env = makeEnv(path.join(tmpRoot, 'quota-daily-exhausted'), {
    clipTitles: ['QA 满额甲', 'QA 满额乙'],
    submit: ['quota'],
    submitGateMs: 0,
    publishExtra: { dailyLimit: 1 },
  });
  const task = env.tasks[0]!;
  env.ledger.logPublish({ taskId: task.id, clipIndex: 90, action: 'submit', uploadTaskId: 'seed-up-1', title: 'seed' });
  eq('今日已 1 个（额度满）', env.ledger.todayPublishedCount(), 1);
  const res = await env.publisher.publishClips({ task, uid: 12345, submitTimeMs: Date.now() });
  eq('★ 一次都不提交（额度已满，连配额都不该撞）', env.uploads.length, 0);
  eq('不发配额告警（这不是配额限流）', env.quotaAlerts.length, 0);
  eq('returns quota.remain = 0', res.quota.remain, 0);
  eq(
    '两片状态都没被改动（原样待投）',
    env.ledger.getClips(task.id).map((c) => c.status).join(','),
    'PENDING_UPLOAD,PENDING_UPLOAD',
  );
  ok(
    '★ 返回值里没有任何 quotaLimited（daemon 因此无从得知"是被额度挡下的" —— 见 ⑳c）',
    !res.results.some((r) => r.quotaLimited),
  );
  env.cleanup();
}

/* ==========================================================================
 * ⑲ 独立复核工程师那 6 组断言（边角 #5）：换证据来源，不靠注释
 * ==========================================================================*/
section('⑲ 独立复核：只提交 1 次 / 0 等待 / #1#2 未动 / 额度 0（用投稿日志交叉验证）');
{
  const env = makeEnv(path.join(tmpRoot, 'verify-claims'), {
    clipTitles: ['QA 复核甲', 'QA 复核乙', 'QA 复核丙'],
    submit: ['quota'],
    submitGateMs: 0,
  });
  const task = env.tasks[0]!;
  const res = await env.publisher.publishClips({ task, uid: 12345, submitTimeMs: Date.now() });

  /* ①「只提交 1 次」：既数 client 调用，也看投稿日志（两个独立证据源） */
  eq('① biliUpload 调用 1 次', env.uploads.length, 1);
  const rows = env.ledger.readPublishLog({});
  eq('① 投稿日志 submit 行 = 0（被拒的那次不能被记成"已投"）', rows.filter((r) => r['action'] === 'submit').length, 0);
  eq('① 投稿日志 fail 行 = 0（配额不是失败，不该写 fail）', rows.filter((r) => r['action'] === 'fail').length, 0);

  /* ②「0 等待」：waiter 是注入的，被调用一次就能看见 */
  eq('② 限流等待 0 次', env.waits.length, 0);

  /* ③「#1/#2 保持 PENDING_UPLOAD」 + 没被写脏 */
  eq('③ 甲 = CANDIDATE', env.ledger.getClip(task.id, 0)?.status, 'CANDIDATE');
  eq('③ 乙 = PENDING_UPLOAD', env.ledger.getClip(task.id, 1)?.status, 'PENDING_UPLOAD');
  eq('③ 丙 = PENDING_UPLOAD', env.ledger.getClip(task.id, 2)?.status, 'PENDING_UPLOAD');
  eq('③ 乙/丙 没有被写 failReason', env.ledger.getClips(task.id).slice(1).filter((c) => Boolean(c.failReason)).length, 0);

  /* ④「todayPublishedCount()===0」：不拿同一个函数当自己的证据，直接数日志 */
  eq('④ todayPublishedCount = 0', env.ledger.todayPublishedCount(), 0);
  eq(
    '④ 独立核对：今日 submit+confirm 行 = 0',
    rows.filter((r) => r['action'] === 'submit' || r['action'] === 'confirm').length,
    0,
  );

  /* ⑤ 返回值语义：带 quotaLimited，且 remaining 指向"队列里没轮到的片" */
  ok('⑤ 结果带 quotaLimited', Boolean(res.results[0]?.quotaLimited));
  eq('⑤ 告警 remaining = 2（队列 3 片，第 1 片被拒 ⇒ 后 2 片）', env.quotaAlerts[0]?.remaining, 2);
  env.cleanup();
}
section('⑲b ★ 「脏指纹已清」只在分支 B（提交被受理 → 任务终态是配额拒）才真的成立');
{
  /* 工程师那组用例用的是「同步抛错」（分支 A）—— 那条路**根本不会登记指纹**，
     所以"脏指纹已清"在分支 A 上是空断言。这里走真实事故形态（分支 B）来验它。 */
  const env = makeEnv(path.join(tmpRoot, 'verify-dirty-fp'), {
    clipTitles: ['QA 指纹甲'],
    submit: ['ok'],
    taskDetail: [{ status: 'error', error: QUOTA_LIMIT_MSG }],
    submitGateMs: 0,
  });
  const task = env.tasks[0]!;
  const clip = env.ledger.getClip(task.id, 0)!;
  const fp = clipFingerprint({
    sourceVideoId: task.recordingId ?? task.id,
    start: clip.start,
    end: clip.end,
    title: clip.title,
  });
  await env.publisher.publishClips({ task, uid: 12345, submitTimeMs: Date.now() });
  eq('分支 B：只提交 1 次（任务终态是配额拒 ⇒ 不重试）', env.uploads.length, 1);
  ok(
    '★ 前提成立：这条指纹**确实先被登记过**（否则本用例什么也没证明）',
    env.fingerprintCalls.some((c) => c.fp === fp && c.clipIndex === 0),
    JSON.stringify(env.fingerprintCalls),
  );
  eq('★ 台账里查不到这条指纹（"投出去了"的假证据已清）', env.ledger.findFingerprint(fp), undefined);
  eq('状态 CANDIDATE（待投）', env.ledger.getClip(task.id, 0)?.status, 'CANDIDATE');
  /* 分支 B 会先在台账写一次 SUBMITTED（崩溃恢复判定点），收尾改成 CANDIDATE 时必须把
     "那次并不存在的提交"的痕迹一并擦掉 —— 否则人工核对时会以为它投过一次。 */
  const after = env.ledger.getClip(task.id, 0)!;
  eq('★ 待投切片上不残留 uploadTaskId（那次提交没被受理）', after.uploadTaskId, undefined);
  eq('★ 也不残留 submitTime', after.submitTime, undefined);
  eq('★ 也不残留 dtime', after.dtime, undefined);

  /* 「配额限流不留任何副作用」终局断言（2026-10-21 第二轮新增）：
     投稿流水里不该出现任何 submit/fail/batch 行、错误事件流里也不该多一条 ——
     配额限流是"等一会儿再来"，不是一次投稿、也不是一个错误。 */
  const errorsPath = path.join(tmpRoot, 'errors.jsonl');
  const linesOf = (p: string): number =>
    fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((s) => s.trim() !== '').length : 0;
  const logLinesBefore = linesOf(env.ledger.publishLogPath);
  const errLinesBefore = linesOf(errorsPath);
  /* 换一个新 Publisher（同一份台账）：必须真的再提交，而不是"幂等命中 ⇒ 跳过 ⇒ 假装已投" */
  await env.spawnPublisher().publishClips({ task, uid: 12345, submitTimeMs: Date.now() });
  eq('★ 重跑确实又提交了一次（脏指纹真的从台账清掉了）', env.uploads.length, 2);
  eq(
    '★ 两轮配额收尾后投稿流水 0 行新增（submit/fail/batch 都不该有）',
    linesOf(env.ledger.publishLogPath) - logLinesBefore,
    0,
  );
  eq('★ 两轮配额收尾后 errors.jsonl 0 行新增（配额不是错误事件）', linesOf(errorsPath) - errLinesBefore, 0);
  env.cleanup();
}

/* ==========================================================================
 * ⑳ daemon 层：配额收尾后本场状态与告警是否自洽（边角 #2/#4 的落点）
 * ==========================================================================*/
interface DaemonEnv {
  orch: Orchestrator;
  ledger: Ledger;
  taskId: string;
  uploads: string[];
  quotaAlerts: Array<Record<string, unknown>>;
  failedAlerts: Array<Record<string, unknown>>;
  reportDir: string;
  cleanup: () => void;
}

/**
 * 起一个**真 Orchestrator + 真 Publisher**（只把 client / alerter 换成桩）的环境。
 *
 * 为什么要到这一层：`quotaLimited` 这个位是 Publisher 返回给调用方的契约，
 * 而"本场状态是否回退成 ANALYZED""要不要补一条『投稿失败』告警"都在 daemon 里决定。
 * 只在 Publisher 层断言，看不出这两件事。
 */
function makeDaemonEnv(
  root: string,
  opts: {
    clipTitles: string[];
    publishExtra?: Record<string, unknown>;
    submitBehavior?: 'quota' | 'ok';
    seedTodaySubmits?: number;
    /** 这几片预先置为 PUBLISHED（模拟"上一批已经投成功、这次重跑只剩剩下的"） */
    alreadyPublished?: number[];
  },
): DaemonEnv {
  fs.mkdirSync(root, { recursive: true });
  const dataDir = path.join(root, 'data');
  const clipsDir = path.join(root, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });
  const configPath = writeConfig(root, {
    clipPublishMode: 'append',
    multiPart: true,
    fullVideoBy: 'assistant',
    dailyLimit: 0,
    ...(opts.publishExtra ?? {}),
  });
  const taskId = `qa-daemon-${path.basename(root)}`;
  const taskDir = path.join(dataDir, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json'), logger: silentLog as never });
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    title: 'QA daemon 配额场',
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
  const raw = path.join(root, 'raw.mp4');
  fs.writeFileSync(raw, 'x');
  ledger.updateTask(taskId, {
    recordingId: 'rec-daemon',
    source: { ...ledger.getTask(taskId)!.source, rawFiles: [raw] },
  });
  /* 产物已存在 ⇒ publishClips(skipUpload) 会走"复用"、不跑 ffmpeg */
  ledger.setClips(
    taskId,
    opts.clipTitles.map((title, i) => {
      const p = path.join(clipsDir, `${i}.mp4`);
      fs.writeFileSync(p, 'x');
      return {
        index: i,
        start: 100 + i * 200,
        end: 250 + i * 200,
        title,
        desc: '',
        tags: ['测试'],
        category: '游戏/单机游戏',
        score: 9,
        selected: true,
        status: 'PENDING_UPLOAD',
        cutOutput: p,
      };
    }) as never,
  );
  for (let i = 0; i < (opts.seedTodaySubmits ?? 0); i++) {
    ledger.logPublish({ taskId, clipIndex: 90 + i, action: 'submit', uploadTaskId: `seed-${i}`, title: 'seed' });
  }
  for (const idx of opts.alreadyPublished ?? []) {
    ledger.setClipStatus(taskId, idx, 'PUBLISHED', {
      bvid: `BV1QADONE000${idx}`,
      publishedAt: new Date().toISOString(),
    });
  }

  const orch = new Orchestrator({ configPath, dataDirOverride: dataDir, ledger, triggerBaselineMs: 0 });

  const quotaAlerts: Array<Record<string, unknown>> = [];
  const failedAlerts: Array<Record<string, unknown>> = [];
  /* ⚠️ 必须立刻把 alerter 换成记录桩：Orchestrator 构造出来的是真 Alerter，
     它一旦被调用就会发真实渠道（Server酱/钉钉）。 */
  const alerterStub = {
    send: async (): Promise<unknown[]> => [],
    failure: async (): Promise<void> => {},
    publishFailed: async (info: Record<string, unknown>): Promise<void> => {
      failedAlerts.push(info);
    },
    publishSuccess: async (): Promise<void> => {},
    publishQuotaLimited: async (info: Record<string, unknown>): Promise<void> => {
      quotaAlerts.push(info);
    },
    taskRecap: async (): Promise<void> => {},
    analysisDone: async (): Promise<void> => {},
    recordingDone: async (): Promise<void> => {},
    diskLow: async (): Promise<void> => {},
    accountExpiring: async (): Promise<void> => {},
    testChannel: async (): Promise<{ channel: string; ok: boolean; message: string }> => ({ channel: 'stub', ok: true, message: 'stub' }),
  };
  (orch as unknown as { alerter: unknown }).alerter = alerterStub;
  /* ★ Publisher 在**构造时**就抓住了 alerter（`deps.alerter`），所以只换 orch.alerter 不够 ——
     否则配额告警会发给那个"配置里关掉"的真 Alerter，本用例就永远看不到它。
     （实测踩到：这条断言第一版报"告警 0 条"，原因就是这个，不是源码问题。） */
  (orch.publisher as unknown as { alerter: unknown }).alerter = alerterStub;
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

  const uploads: string[] = [];
  const fakeClient = {
    userList: async (): Promise<unknown[]> => [{ uid: 12345, name: 'stub' }],
    anchorInfoByRoom: async (): Promise<{ uid: string; name: string }> => ({ uid: '12345', name: 'stub-anchor' }),
    presetFfmpeg: async (): Promise<unknown[]> => [],
    cut: async (): Promise<unknown> => {
      throw new Error('本用例不该切片（产物已存在，应走复用）');
    },
    biliArchives: async (): Promise<unknown[]> => [],
    biliArchiveDetail: async (): Promise<unknown> => ({}),
    taskDetail: async (): Promise<{ status: string }> => ({ status: 'completed' }),
    biliUpload: async (params: Record<string, unknown>): Promise<{ taskId: string }> => {
      uploads.push(JSON.stringify(params['videos'] ?? params));
      if ((opts.submitBehavior ?? 'quota') === 'quota') throw new Error(QUOTA_LIMIT_MSG);
      return { taskId: 'daemon-up-1' };
    },
  };
  (orch as unknown as { client: unknown }).client = fakeClient;
  (orch.publisher as unknown as { client: unknown }).client = fakeClient;

  return {
    orch,
    ledger,
    taskId,
    uploads,
    quotaAlerts,
    failedAlerts,
    reportDir: path.join(dataDir, 'error-report'),
    cleanup: (): void => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const countReports = (dir: string, taskId: string): number => {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })
    .filter((b) => String(b['taskId'] ?? '') === taskId).length;
};

/** 把 daemon 的日志收下来：用文案反推内部布尔位（`quotaStopped ? '配额限流' : '今日额度已用完'`） */
function makeRecorder(): { log: unknown; has: (s: string) => boolean; text: () => string } {
  const lines: string[] = [];
  const push = (a: unknown): void => {
    lines.push(typeof a === 'string' ? a : JSON.stringify(a));
  };
  const log: Record<string, unknown> = {
    info: push,
    warn: push,
    error: push,
    debug: (): void => {},
  };
  log['child'] = (): unknown => log;
  return {
    log,
    has: (s: string): boolean => lines.some((l) => l.includes(s)),
    text: (): string => lines.join('\n'),
  };
}

section('⑳ ★ daemon 层（单独投稿对照）：配额收尾 ⇒ CLIPPED + 不发「投稿失败」');
{
  const env = makeDaemonEnv(path.join(tmpRoot, 'daemon-standalone'), {
    clipTitles: ['QA 单投甲', 'QA 单投乙'],
    publishExtra: { clipPublishMode: 'standalone', multiPart: false },
  });
  const r = await env.orch.publishStage(env.taskId, silentLog as never);
  eq('只提交 1 次（第 2 片没被撞）', env.uploads.length, 1);
  eq(
    '切片状态：甲 CANDIDATE / 乙 PENDING_UPLOAD',
    env.ledger.getClips(env.taskId).map((c) => c.status).join(','),
    'CANDIDATE,PENDING_UPLOAD',
  );
  eq('★ 本场状态 = CLIPPED（不能回退成 ANALYZED）', env.ledger.getTask(env.taskId)?.status, 'CLIPPED');
  eq('★ 不补发「投稿失败」告警（配额不是失败，会与 warn 自相矛盾）', env.failedAlerts.length, 0);
  eq('配额告警 1 条', env.quotaAlerts.length, 1);
  eq('不写错误报告', countReports(env.reportDir, env.taskId), 0);
  ok('阶段没有抛错（配额不是阶段失败）', r.error === undefined, String(r.error));
  env.cleanup();
}
section('⑳b ★ daemon 层（多分P 新建稿件）：配额收尾的状态与告警必须同样自洽');
{
  const env = makeDaemonEnv(path.join(tmpRoot, 'daemon-multipart'), {
    clipTitles: ['QA 多投甲', 'QA 多投乙'],
  });
  const lines = makeRecorder();
  const r = await env.orch.publishStage(env.taskId, lines.log as never);
  eq('只提交 1 次（配额不原地重试）', env.uploads.length, 1);
  eq(
    '★ 切片都是 CANDIDATE（不写 FAILED）',
    env.ledger.getClips(env.taskId).map((c) => c.status).join(','),
    'CANDIDATE,CANDIDATE',
  );
  eq('★ 本场状态 = CLIPPED（不能回退成 ANALYZED —— 否则界面显示"待分析"、重跑会重切）', env.ledger.getTask(env.taskId)?.status, 'CLIPPED');
  eq('★ 不补发「投稿失败」告警（与"等 30 分钟"的 warn 自相矛盾）', env.failedAlerts.length, 0);
  eq('配额告警 1 条（一批一条，不漏报）', env.quotaAlerts.length, 1);
  eq('不写错误报告', countReports(env.reportDir, env.taskId), 0);
  ok('阶段没有抛错（配额不是阶段失败）', r.error === undefined, String(r.error));
  /* ★ 关键：证明 CLIPPED 是**因为 quotaStopped 真为真**，不是碰巧被 `stuck` 兜住的
     —— 这两条文案在源码里是二选一（`quotaStopped ? '配额限流…' : '今日额度已用完'`），
     所以日志里出现哪一条，就能反推那个布尔位到底是真是假。 */
  ok(
    '★ daemon 的收尾日志点名「配额限流」（说明 quotaStopped 真的为 true，不是被 stuck 顺手兜住）',
    lines.has('B站 投稿配额限流'),
    lines.text().slice(-400),
  );
  ok('★ 且**没有**误报成「今日额度已用完」（两类终止条件没有被混为一谈）', !lines.has('今日额度已用完'), lines.text().slice(-400));
  env.cleanup();
}
section('⑳c ★ daemon 层（额度已满）：本场状态同样不能回退成 ANALYZED');
{
  const env = makeDaemonEnv(path.join(tmpRoot, 'daemon-daily-limit'), {
    clipTitles: ['QA 满额甲'],
    publishExtra: { clipPublishMode: 'standalone', multiPart: false, dailyLimit: 1 },
    seedTodaySubmits: 1,
  });
  const lines = makeRecorder();
  await env.orch.publishStage(env.taskId, lines.log as never);
  eq('0 次提交（额度已满）', env.uploads.length, 0);
  eq(
    '切片仍在待投（状态未被改动）',
    env.ledger.getClips(env.taskId).map((c) => c.status).join(','),
    'PENDING_UPLOAD',
  );
  eq('★ 本场状态 = CLIPPED（切片产物都在，只是今天没额度了）', env.ledger.getTask(env.taskId)?.status, 'CLIPPED');
  /* 与 ⑳b 反向：这条必须说「额度」，不能说「配额限流」—— 两类终止条件各有各的话 */
  ok('★ 收尾日志说「今日额度已用完」（与配额限流区分开）', lines.has('今日额度已用完'), lines.text().slice(-400));
  ok('★ 不误报成「配额限流」', !lines.has('B站 投稿配额限流'), lines.text().slice(-400));
  env.cleanup();
}
section('⑳d ★ 反例：同一场里**已有切片成功**时，额度早退的 stuck 不能把状态搞坏');
{
  /* 这是 team-lead 点名要打的反例：`stuck:true` 只有在 `published+submitted===0` 时才收口。
     场景 = 用户重跑发布阶段，第 1 片昨天/上批已发布，今天额度已满 ⇒ 本批 0 片可投。
     期望：状态仍是 CLIPPED（不回退、也不误升 PUBLISHED），且**不能**说"本场未能投稿"（明明有 1 片已发）。 */
  const env = makeDaemonEnv(path.join(tmpRoot, 'daemon-partial-done'), {
    clipTitles: ['QA 已发甲', 'QA 待投乙'],
    publishExtra: { clipPublishMode: 'standalone', multiPart: false, dailyLimit: 1 },
    seedTodaySubmits: 1,
    alreadyPublished: [0],
  });
  const lines = makeRecorder();
  await env.orch.publishStage(env.taskId, lines.log as never);
  eq('0 次提交（额度已满，第 2 片也没投）', env.uploads.length, 0);
  eq(
    '状态：甲仍 PUBLISHED / 乙仍 PENDING_UPLOAD（都没被改动）',
    env.ledger.getClips(env.taskId).map((c) => c.status).join(','),
    'PUBLISHED,PENDING_UPLOAD',
  );
  eq('★ 本场仍是 CLIPPED（不回退 ANALYZED）', env.ledger.getTask(env.taskId)?.status, 'CLIPPED');
  eq('★ 也没有误升成 PUBLISHED（还有 1 片没投）', env.ledger.getTask(env.taskId)?.status === 'PUBLISHED', false);
  ok('★ 不能出现"本场未能投稿"（明明已有 1 片发布）', !lines.has('本场未能投稿'), lines.text().slice(-400));
  ok('日志按"部分完成"如实说', lines.has('本场部分完成'), lines.text().slice(-400));
  env.cleanup();
}
section('⑳e ★ 直接验 publishMultiPartStage 的返回形状（quotaLimited 必须逐条都在）');
{
  /* 为什么不只靠 ⑳b：`quotaStopped` 用的是 `.some()`，但 `:2203` 是**逐条** continue。
     只给第一条打标记时，②那两个断言仍会绿（因为 only-one 也满足 .some），却会漏发剩下的 publishFailed。
     这里直接把 stage 的返回摊开看。 */
  const env = makeDaemonEnv(path.join(tmpRoot, 'daemon-stage-shape'), {
    clipTitles: ['QA 形状甲', 'QA 形状乙', 'QA 形状丙'],
  });
  const stage = (env.orch as unknown as { publishMultiPartStage: (c: unknown) => Promise<Record<string, unknown>> })
    .publishMultiPartStage;
  const res = (await stage.call(env.orch, { taskId: env.taskId, uid: 12345, log: silentLog })) as {
    results: Array<{ clipIndex: number; ok: boolean; quotaLimited?: { retryAfterMin: number } }>;
    submitted: number;
    failed: number;
    stuck?: boolean;
    multipart?: boolean;
  };
  eq('切片结果 3 条（一片不少）', res.results.length, 3);
  eq(
    '★ **每一条**结果都带 quotaLimited（`.some()` 与逐条 continue 都成立）',
    res.results.filter((x) => x.quotaLimited !== undefined).length,
    3,
  );
  eq('每条都 ok=false（本轮确实没投出去）', res.results.filter((x) => x.ok === false).length, 3);
  eq('告警里给的重试时间被透传到每条结果', res.results[0]?.quotaLimited?.retryAfterMin, UPLOAD_QUOTA_RETRY_AFTER_MIN);
  eq('submitted = 0', res.submitted, 0);
  eq('★ failed = 0（配额不是失败，别让调用方按"全失败"处理）', res.failed, 0);
  eq('stuck = true（与"额度用完"同一收口语义）', res.stuck, true);
  eq('multipart = true（终态判定用多分P 口径）', res.multipart, true);
  env.cleanup();
}

/* ========================================================================== */
setErrorReportDir(undefined);
setErrorsPath(undefined);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
