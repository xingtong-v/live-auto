/**
 * 投稿限流（B站「您投稿的频率过快，请稍等2秒」）安全重试自测 —— 2026-10-17。
 *
 * 背景（真实线上事故，任务 `auto-20261017112152-ap05`）：
 *   同一进程里两个任务在并行投稿，两次提交只差 1.1 秒，B站 回了
 *   `BiliResponseError: 您投稿的频率过快，请稍等2秒`（biliLive-tools 的
 *   `BiliAddVideoTask.submit` 抛的），而我们把这条**临时拒绝**当成永久失败：
 *   台账 FAILED + 错误报告，需要人工重投。
 *
 * 本套件用「真 Publisher + 假传输层」钉住五件事（纯离线，不碰 B站、不切 ffmpeg）：
 *   ① 同步抛限流错 ⇒ 等到上限后重交 ⇒ 最终 SUBMITTED，且**不写** FAILED；
 *   ② 上传任务终态 error 且错误是限流 ⇒ 同样重交 ⇒ SUBMITTED；
 *   ③ 一直限流 ⇒ 有界重试（3 次）后 FAILED，failReason 写明「限流重试 3 次仍失败」；
 *   ④ 非限流错误（稿件锁定）⇒ **一次都不重试**，行为与以前完全一致；
 *   ⑤ 提交闸门：并发两次提交会串行排队，且间隔 ≥ submitGateMs；
 *   ⑥ 追加分P 的落地探针：已在 ⇒ landed（不重投）/ 不在 ⇒ absent / 查不到 ⇒ unknown（不重试）。
 *
 * 运行：node test/upload-ratelimit.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Publisher } from '../src/publish.ts';
import { UPLOAD_QUOTA_RETRY_AFTER_MIN, classifySubmitLimit, isUploadQuotaLimited, isUploadRateLimited } from '../src/failure-class.ts';
import { nextBlockUntil } from '../src/quota-guard.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { setErrorsPath, setErrorReportDir } from '../src/errors.ts';
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

/** 线上原话（真实样本，别改：这是重试判据的锚点） */
const RATE_LIMIT_MSG = 'BiliResponseError: 您投稿的频率过快，请稍等2秒';

/** 2026-10-21 线上原话（**没有秒数** —— 这是配额级限流的判据锚点） */
const QUOTA_LIMIT_MSG = 'BiliResponseError: 投稿过于频繁，请稍后再试';

/** 混合措辞（既像配额级、又给了秒数）⇒ 按秒级处理，行为必须与限流重试一致 */
const MIXED_LIMIT_MSG = 'BiliResponseError: 投稿过于频繁，请稍等2秒';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live_auto-ratelimit-'));
/* 错误报告与错误事件流必须重定向到临时目录：否则内建测试会污染真实的
   `data/errors.jsonl`（2026-09-23 实测过：健康面板「近 24h 错误」83 条里 67 条是测试噪音） */
setErrorReportDir(path.join(tmpRoot, 'error-report'));
setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));

type SubmitBehavior = 'ok' | 'rate-limit' | 'quota' | 'quota-with-sec' | 'locked';

interface Env {
  publisher: Publisher;
  task: TaskRecord;
  ledger: Ledger;
  /** 每次 biliUpload 的调用时刻（毫秒）与入参 */
  uploads: Array<{ at: number; params: Record<string, unknown> }>;
  /** 被注入的"限流等待"时长（毫秒）——用来断言真的等了对方要求的秒数，又没真睡 */
  waits: number[];
  /** 配额限流告警（2026-10-21）：断言"发了、且带够了信息" */
  quotaAlerts: Array<{ taskId: string; submitted: number; remaining: number; retryAfterMin: number; reason: string }>;
  cleanup: () => void;
}

/**
 * 起一个隔离环境。
 * `submit`：每次 `biliUpload` 的行为（按顺序取，用尽后重复最后一个）。
 * `taskDetail`：每次 `taskDetail` 的行为（同上）；默认 `completed`。
 */
function makeEnv(
  root: string,
  opts: {
    submit: SubmitBehavior[];
    taskDetail?: Array<{ status: string; error?: string }>;
    submitGateMs?: number;
    rateLimitMaxAttempts?: number;
    /** 目标稿件详情（追加分P 探针用）；不传则不实现该方法 */
    archiveDetail?: Record<string, unknown>;
    archives?: unknown[];
    /** 本批要投几片（默认 1）。配额限流用例需要多片来断言"后面几片被跳过" */
    clipCount?: number;
  },
): Env {
  const dataDir = path.join(root, 'data');
  /* taskId 必须**每个环境唯一**（用目录名派生）：错误报告是按 taskId 过滤统计的，
     共用同一个 id 会让"本用例没写报告"这类断言被上一个用例的报告污染。 */
  const taskId = `ratelimit-test-${path.basename(root)}`;
  const taskDir = path.join(dataDir, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'clips-out'), { recursive: true });

  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json'), logger: silentLog as never });
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    title: '限流重试测试场',
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

  const clipOut = path.join(root, 'clips-out', '01.mp4');
  fs.writeFileSync(clipOut, 'fake-bytes');
  const clipCount = Math.max(1, opts.clipCount ?? 1);
  ledger.setClips(taskId, [
    ...Array.from({ length: clipCount }, (_, i) => {
      /* 多片时每片一份产物 + 不同的时间区间（指纹按区间+标题算，必须各不相同） */
      const out = i === 0 ? clipOut : path.join(root, 'clips-out', `0${i + 1}.mp4`);
      if (i > 0) fs.writeFileSync(out, `fake-bytes-${i}`);
      return {
        index: i,
        start: 100 + i * 200,
        end: 250 + i * 200,
        title: i === 0 ? '第1段' : `第${i + 1}段`,
        desc: '',
        tags: ['测试'],
        category: '游戏/单机游戏',
        score: 9,
        selected: true,
        /* 产物已存在 ⇒ 走"复用"直接投稿，不切 ffmpeg（本套件只关心投稿这一段） */
        status: 'PENDING_UPLOAD',
        cutOutput: out,
      };
    }),
  ] as never);

  const raw = path.join(root, 'raw.mp4');
  fs.writeFileSync(raw, 'x');
  ledger.updateTask(taskId, {
    recordingId: 'rec-1',
    source: { ...ledger.getTask(taskId)!.source, rawFiles: [raw], fullVideoPath: raw },
  });

  /* 配置从真实 config.json 派生（只读它，绝不改它），覆盖成"不限额、不抖动、不自动重试"
     —— 自动重试那条路（publishClips 层）与本套件要测的"提交层重试"是两件事，别混在一起。 */
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
        publish: {
          ...(realCfg['publish'] as object),
          submitGapSec: 1200,
          firstPublishAt: '',
          dailyLimit: 0,
          minSubmitIntervalSec: 0,
          autoRetryOnce: false,
          coverFrom: 'preset',
          defaultCover: '',
          autoPublish: true,
          fullVideoBy: 'bililive-tools',
          resumeAid: '',
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const uploads: Array<{ at: number; params: Record<string, unknown> }> = [];
  const waits: number[] = [];
  const quotaAlerts: Env['quotaAlerts'] = [];
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
    biliArchives: async (): Promise<unknown[]> => opts.archives ?? [],
    ...(opts.archiveDetail ? { biliArchiveDetail: async (): Promise<unknown> => opts.archiveDetail } : {}),
    taskDetail: async (): Promise<{ status: string; error?: string }> => {
      const pick = detailQueue[Math.min(detailCalls, detailQueue.length - 1)]!;
      detailCalls++;
      return pick;
    },
    biliUpload: async (params: Record<string, unknown>): Promise<{ taskId: string }> => {
      submitCalls++;
      const behavior = opts.submit[Math.min(submitCalls - 1, opts.submit.length - 1)]!;
      uploads.push({ at: Date.now(), params });
      if (behavior === 'rate-limit') throw new Error(RATE_LIMIT_MSG);
      if (behavior === 'quota') throw new Error(QUOTA_LIMIT_MSG);
      if (behavior === 'quota-with-sec') throw new Error(MIXED_LIMIT_MSG);
      if (behavior === 'locked') throw new Error('稿件已被锁定，无法投稿');
      return { taskId: `upload-${submitCalls}` };
    },
  };

  const publisher = new Publisher({
    client: client as never,
    config: loadConfig(configPath).config as AppConfig,
    ledger,
    logger: silentLog as never,
    /* ★ 注入：真等 2 秒 × N 会让套件变得没意义；这里只记下"它要求等多久" */
    submitGateMs: opts.submitGateMs ?? 0,
    rateLimitWaiter: async (waitMs: number): Promise<void> => {
      waits.push(waitMs);
    },
    ...(opts.rateLimitMaxAttempts ? { rateLimitMaxAttempts: opts.rateLimitMaxAttempts } : {}),
    /* 告警只记录不发送（真实 alerter 会打网络） */
    alerter: {
      publishQuotaLimited: async (info): Promise<void> => {
        quotaAlerts.push({ ...info });
      },
    },
  });

  return {
    publisher,
    task: ledger.getTask(taskId)!,
    ledger,
    uploads,
    waits,
    quotaAlerts,
    cleanup: (): void => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function publish(env: Env): Promise<{ submitted: number; failed: number }> {
  const res = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
  return { submitted: res.submitted, failed: res.failed };
}

/* ==========================================================================
 * 续传（追加分P）用的隔离环境
 * ==========================================================================*/

/** 待追加切片的标题（探针/落地确认都按它比对，注意 `norm()` 会去掉空白） */
const CLIP_TITLE = '待追加的切片';

interface AppendEnv {
  publisher: Publisher;
  task: TaskRecord;
  ledger: Ledger;
  uploads: Array<{ at: number; params: Record<string, unknown> }>;
  waits: number[];
  cleanup: () => void;
}

/**
 * 起一个"续传到已有稿件"的环境。
 * `partTitles`：每次读目标稿件分P 列表时返回的标题（按顺序取，用尽后重复最后一个）。
 */
function makeAppendEnv(
  root: string,
  opts: {
    submit: SubmitBehavior[];
    taskDetail: Array<{ status: string; error?: string }>;
    partTitles: string[][];
  },
): AppendEnv {
  const dataDir = path.join(root, 'data');
  const taskId = 'ratelimit-append-01';
  const taskDir = path.join(dataDir, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'clips-out'), { recursive: true });

  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json'), logger: silentLog as never });
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    title: '续传限流测试场',
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

  const clipOut = path.join(root, 'clips-out', '10.mp4');
  fs.writeFileSync(clipOut, 'fake-bytes');
  ledger.setClips(taskId, [
    {
      index: 0,
      start: 400,
      end: 550,
      title: CLIP_TITLE,
      desc: '',
      tags: ['测试'],
      category: '生活',
      score: 8,
      selected: true,
      status: 'CUT',
      cutOutput: clipOut,
    },
  ] as never);

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
        publish: {
          ...(realCfg['publish'] as object),
          submitGapSec: 1200,
          firstPublishAt: '',
          dailyLimit: 0,
          minSubmitIntervalSec: 0,
          autoRetryOnce: false,
          coverFrom: 'preset',
          defaultCover: '',
          autoPublish: true,
          fullVideoBy: 'bililive-tools',
          resumeAid: '',
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const uploads: Array<{ at: number; params: Record<string, unknown> }> = [];
  const waits: number[] = [];
  let submitCalls = 0;
  let detailCalls = 0;
  let taskDetailCalls = 0;

  const client = {
    userList: async (): Promise<unknown[]> => [{ uid: 1, name: 'stub' }],
    anchorInfoByRoom: async (): Promise<{ uid: string; name: string }> => ({ uid: '1', name: '测试主播' }),
    presetFfmpeg: async (): Promise<unknown[]> => [],
    cut: async (): Promise<{ taskId: string }> => {
      throw new Error('本套件不该切片（产物已存在）');
    },
    /* 续传去重/探针/落地确认都靠它把 aid 映射到 bvid */
    biliArchives: async (): Promise<unknown[]> => [{ bvid: 'BV1APPEND01', aid: 117000000000001, title: '测试稿件', duration: 100 }],
    biliArchiveDetail: async (): Promise<unknown> => {
      const titles = opts.partTitles[Math.min(detailCalls, opts.partTitles.length - 1)]!;
      detailCalls++;
      return {
        View: { bvid: 'BV1APPEND01', videos: titles.length, pages: titles.map((part) => ({ part, duration: 100 })) },
      };
    },
    taskDetail: async (): Promise<{ status: string; error?: string }> => {
      const pick = opts.taskDetail[Math.min(taskDetailCalls, opts.taskDetail.length - 1)]!;
      taskDetailCalls++;
      return pick;
    },
    biliUpload: async (params: Record<string, unknown>): Promise<{ taskId: string }> => {
      submitCalls++;
      const behavior = opts.submit[Math.min(submitCalls - 1, opts.submit.length - 1)]!;
      uploads.push({ at: Date.now(), params });
      if (behavior === 'rate-limit') throw new Error(RATE_LIMIT_MSG);
      if (behavior === 'quota') throw new Error(QUOTA_LIMIT_MSG);
      if (behavior === 'quota-with-sec') throw new Error(MIXED_LIMIT_MSG);
      if (behavior === 'locked') throw new Error('稿件已被锁定，无法投稿');
      return { taskId: `up-${submitCalls}` };
    },
  };

  const publisher = new Publisher({
    client: client as never,
    config: loadConfig(configPath).config as AppConfig,
    ledger,
    logger: silentLog as never,
    submitGateMs: 0,
    rateLimitWaiter: async (waitMs: number): Promise<void> => {
      waits.push(waitMs);
    },
  });

  return {
    publisher,
    task: ledger.getTask(taskId)!,
    ledger,
    uploads,
    waits,
    cleanup: (): void => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/* ========================================================================== */
section('① 同步抛限流错 ⇒ 等待后重交 ⇒ SUBMITTED（不再 FAILED）');
{
  const env = makeEnv(path.join(tmpRoot, 'a'), { submit: ['rate-limit', 'ok'] });
  const r = await publish(env);
  eq('本批成功 1 片', r.submitted, 1);
  eq('失败 0 片（旧代码这里是 1）', r.failed, 0);
  eq('提交了 2 次（首次被拒 + 重试）', env.uploads.length, 2);
  eq('等待了 1 次', env.waits.length, 1);
  ok(
    '按对方要求等（「请稍等2秒」⇒ ≥2000ms，且夹了上限 30 秒）',
    (env.waits[0] ?? 0) >= 2000 && (env.waits[0] ?? 0) <= 32_000,
    `实际 ${env.waits[0]}ms`,
  );
  eq('切片状态推进到 SUBMITTED', env.ledger.getClip(env.task.id, 0)?.status, 'SUBMITTED');
  eq('没有 failReason', env.ledger.getClip(env.task.id, 0)?.failReason, undefined);
  eq('★ 额度只算 1 次投稿（被拒的那次不该占额度）', env.ledger.todayPublishedCount(), 1);
  env.cleanup();
}

/* ========================================================================== */
section('② 上传任务终态 error 且错误是限流 ⇒ 同样重交（线上事故正是这一支）');
{
  const env = makeEnv(path.join(tmpRoot, 'b'), {
    submit: ['ok'],
    taskDetail: [{ status: 'error', error: RATE_LIMIT_MSG }, { status: 'completed' }],
  });
  const r = await publish(env);
  eq('本批成功 1 片', r.submitted, 1);
  eq('失败 0 片', r.failed, 0);
  eq('提交了 2 次', env.uploads.length, 2);
  eq('等待了 1 次', env.waits.length, 1);
  eq('切片状态推进到 SUBMITTED', env.ledger.getClip(env.task.id, 0)?.status, 'SUBMITTED');
  eq('★ 额度只算 1 次投稿', env.ledger.todayPublishedCount(), 1);
  env.cleanup();
}

/* ========================================================================== */
section('③ 一直限流 ⇒ 有界重试后 FAILED，且 failReason 写明重试次数');
{
  const env = makeEnv(path.join(tmpRoot, 'c'), { submit: ['rate-limit'] });
  const r = await publish(env);
  eq('本批失败 1 片', r.failed, 1);
  eq('★ 只尝试 3 次（不是无限重试）', env.uploads.length, 3);
  eq('等待了 2 次', env.waits.length, 2);
  const clip = env.ledger.getClip(env.task.id, 0);
  eq('切片状态 FAILED', clip?.status, 'FAILED');
  ok('failReason 写明「限流重试 3 次仍失败」', /限流重试 3 次仍失败/.test(clip?.failReason ?? ''), clip?.failReason);
  ok('failReason 保留原始错误（人工据此判断）', /投稿的频率过快/.test(clip?.failReason ?? ''), clip?.failReason);
  ok('切片产物仍保留（可单独重投）', Boolean(clip?.cutOutput), String(clip?.cutOutput));

  /* ★ 2026-10-17 QA 复核补：错误报告里也必须看得见"重试过几次"
     （台账有、报告没有 ⇒ 人工点开报告不知道要不要直接重投）。 */
  const reportDir = path.join(tmpRoot, 'error-report');
  const reports = fs.existsSync(reportDir) ? fs.readdirSync(reportDir) : [];
  const bodies = reports
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(reportDir, f), 'utf8')) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })
    .filter((b) => String(b['taskId'] ?? '') === env.task.id);
  const body = bodies[bodies.length - 1];
  const errorMessage = String(((body?.['error'] ?? {}) as Record<string, unknown>)['message'] ?? '');
  ok('★ 错误报告的 error.message 里写明「限流重试 3 次仍失败」', /限流重试 3 次仍失败/.test(errorMessage), errorMessage);
  ok('★ 错误报告带 retries 记录（不是空数组）', Array.isArray(body?.['retries']) && (body['retries'] as unknown[]).length >= 1, JSON.stringify(body?.['retries']));
  eq('retries 条数 = 实际被拒次数（2）', (body?.['retries'] as unknown[] | undefined)?.length, 2);
  env.cleanup();
}

/* ========================================================================== */
section('④ 非限流错误（稿件锁定）⇒ 一次都不重试，行为与以前一致');
{
  const env = makeEnv(path.join(tmpRoot, 'd'), { submit: ['locked'] });
  const r = await publish(env);
  eq('本批失败 1 片', r.failed, 1);
  eq('★ 只提交 1 次（不重试）', env.uploads.length, 1);
  eq('没有任何等待', env.waits.length, 0);
  const clip = env.ledger.getClip(env.task.id, 0);
  eq('切片状态 FAILED', clip?.status, 'FAILED');
  ok('failReason 里不该出现「限流重试」', !/限流重试/.test(clip?.failReason ?? ''), clip?.failReason);
  env.cleanup();
}

/* ========================================================================== */
section('⑤ 提交闸门：并发提交串行排队，且间隔 ≥ submitGateMs');
{
  const GATE = 80;
  const env = makeEnv(path.join(tmpRoot, 'e'), { submit: ['ok'], submitGateMs: GATE });
  interface Gate {
    submitUpload: (p: unknown, l: unknown, purpose: string) => Promise<unknown>;
  }
  const gate = env.publisher as unknown as Gate;
  await Promise.all([
    gate.submitUpload({ uid: 1, videos: ['a.mp4'], config: {} }, silentLog, '并发A'),
    gate.submitUpload({ uid: 1, videos: ['b.mp4'], config: {} }, silentLog, '并发B'),
    gate.submitUpload({ uid: 1, videos: ['c.mp4'], config: {} }, silentLog, '并发C'),
  ]);
  eq('三次提交都发出去了', env.uploads.length, 3);
  const gaps = env.uploads.slice(1).map((u, i) => u.at - env.uploads[i]!.at);
  ok(
    `★ 相邻两次提交间隔 ≥ ${GATE}ms（闸门生效）`,
    gaps.every((g) => g >= GATE - 15),
    `实际 ${gaps.join(', ')}ms`,
  );
  env.cleanup();
}

/* ========================================================================== */
section('⑥ 追加分P 的落地探针：已在/不在/查不到 三态必须分得清');
{
  const base = {
    View: {
      bvid: 'BV1FAKE00001',
      videos: 2,
      pages: [
        { part: '完整版', duration: 100 },
        { part: '第1段', duration: 150 },
      ],
    },
  };
  const env = makeEnv(path.join(tmpRoot, 'f'), {
    submit: ['ok'],
    archives: [{ bvid: 'BV1FAKE00001', aid: 999, title: '测试稿件', duration: 100 }],
    archiveDetail: base,
  });
  interface Probe {
    probeAppendLanded: (aid: string, titles: string[], log: unknown) => Promise<string>;
  }
  const probe = env.publisher as unknown as Probe;
  eq('标题已在分P 列表 ⇒ landed（不重投）', await probe.probeAppendLanded('999', ['第1段'], silentLog), 'landed');
  eq('标题不在 ⇒ absent（可安全重试）', await probe.probeAppendLanded('999', ['第2段'], silentLog), 'absent');
  eq(
    '部分在 ⇒ partial（既不重投也不当成功）',
    await probe.probeAppendLanded('999', ['第1段', '第2段'], silentLog),
    'partial',
  );
  env.cleanup();
}
{
  /* 详情里没有 View.pages（例如仅自己可见稿件接口不返回）⇒ unknown ⇒ 不重试（保守） */
  const env = makeEnv(path.join(tmpRoot, 'g'), {
    submit: ['ok'],
    archives: [{ bvid: 'BV1FAKE00001', aid: 999, title: '测试稿件', duration: 100 }],
    archiveDetail: { View: { bvid: 'BV1FAKE00001', videos: 1 } },
  });
  interface Probe {
    probeAppendLanded: (aid: string, titles: string[], log: unknown) => Promise<string>;
  }
  const probe = env.publisher as unknown as Probe;
  eq(
    '查不到分P 列表 ⇒ unknown（不重试，避免重复分P）',
    await probe.probeAppendLanded('999', ['第1段'], silentLog),
    'unknown',
  );
  env.cleanup();
}

/* ========================================================================== */
section('⑦ 追加分P 端到端：限流 ⇒ 探针确认没落地 ⇒ 重投 ⇒ 落地确认');
{
  /* 目标稿件「已有分P」的演化（顺序即真实调用顺序）：
       ① 投稿前的**续传去重**（fetchExistingPartTitles）—— 此时还没有待投标题
       ② 被限流后的**落地探针** —— 仍然没有（⇒ 确认没落地，可以重投）
       ③ 落地确认的 **before 快照** —— 还是没有
       ④ 落地确认的**轮询** —— 出现了（⇒ 算落地） */
  const existingWithout = [{ part: '完整版', duration: 100 }];
  const existingWith = [{ part: '完整版', duration: 100 }, { part: CLIP_TITLE, duration: 150 }];
  const env = makeAppendEnv(path.join(tmpRoot, 'h'), {
    submit: ['rate-limit', 'ok'],
    taskDetail: [{ status: 'completed' }],
    partTitles: [
      existingWithout.map((p) => p.part),
      existingWithout.map((p) => p.part),
      existingWithout.map((p) => p.part),
      existingWith.map((p) => p.part),
    ],
  });
  const res = await env.publisher.publishAsMultiPart({
    task: env.task,
    uid: 1,
    clips: env.ledger.getClips(env.task.id),
    resumeAid: '117000000000001',
    resumeBvid: 'BV1APPEND01',
    logger: silentLog as never,
  });
  eq('投稿成功（ok=true）', res.ok, true);
  eq('模式是 append（续传）', res.mode, 'append');
  eq('★ 提交了 2 次（首次被限流拒 + 重试）', env.uploads.length, 2);
  eq('等待了 1 次', env.waits.length, 1);
  eq('★ 探针确认没落地后才重投，最终 PUBLISHED', env.ledger.getClip(env.task.id, 0)?.status, 'PUBLISHED');
  eq('不是「待确认」', res.appendUnconfirmed, undefined);
  env.cleanup();
}

/* ========================================================================== */
section('⑧ ★ 追加分P：被限流但**其实已落地** ⇒ 绝不再投（防重复分P）');
{
  const env = makeAppendEnv(path.join(tmpRoot, 'i'), {
    submit: ['rate-limit', 'ok'],
    taskDetail: [{ status: 'completed' }],
    /* ① 投稿前的续传去重：还看不到待投标题；② 限流后的探针：居然已经在列表里了 */
    partTitles: [[], [CLIP_TITLE]],
  });
  const res = await env.publisher.publishAsMultiPart({
    task: env.task,
    uid: 1,
    clips: env.ledger.getClips(env.task.id),
    resumeAid: '117000000000001',
    resumeBvid: 'BV1APPEND01',
    logger: silentLog as never,
  });
  eq('★ 只提交了 1 次（发现已落地 ⇒ 不再投，否则分P 重复）', env.uploads.length, 1);
  eq('没有等待（不需要重试）', env.waits.length, 0);
  eq('按成功处理（ok=true）', res.ok, true);
  ok('没有报错信息（不该把它当失败）', res.error === undefined, String(res.error ?? ''));
  eq('切片记为 PUBLISHED（bvid 已知）', env.ledger.getClip(env.task.id, 0)?.status, 'PUBLISHED');
  ok('给出"已在分P 列表里、不再重投"的说明', res.warnings.some((w) => /已经在目标稿件的分P 列表里/.test(w)), JSON.stringify(res.warnings));
  env.cleanup();
}

/* ========================================================================== */
section('⑨ 判据纯函数：配额级 vs 秒级（2026-10-21 事故的锚点）');
{
  eq('「投稿过于频繁，请稍后再试」（无秒数）⇒ quota', classifySubmitLimit(QUOTA_LIMIT_MSG), 'quota');
  eq('「您投稿的频率过快，请稍等2秒」⇒ short（行为不变）', classifySubmitLimit(RATE_LIMIT_MSG), 'short');
  eq('★ 混合措辞「投稿过于频繁，请稍等2秒」⇒ short（有秒数就按秒级走）', classifySubmitLimit(MIXED_LIMIT_MSG), 'short');
  eq('「稿件已被锁定」⇒ none（不是限流）', classifySubmitLimit('稿件已被锁定，无法投稿'), 'none');
  eq('空消息 ⇒ none', classifySubmitLimit(''), 'none');
  ok('quota 也算"限流"（isUploadRateLimited 为 true，便于口径一致）', isUploadRateLimited(QUOTA_LIMIT_MSG));
  ok('★ quota 不算秒级可等待（isUploadQuotaLimited 与 isUploadRateLimited 必须能区分）', isUploadQuotaLimited(QUOTA_LIMIT_MSG));
  ok('★ 带秒数的混合措辞不是 quota（不会被误判成"停止整批"）', !isUploadQuotaLimited(MIXED_LIMIT_MSG));
}

/* ========================================================================== */
section('⑩ ★ 配额限流（无秒数）⇒ 不原地重试 + 本片待投 + 整批立即停手 + 告警一条');
{
  /* 3 片，第一片就被配额拒 —— 事故事实：后面 3 片继续按 143 秒间隔逐片撞死。 */
  const env = makeEnv(path.join(tmpRoot, 'j'), { submit: ['quota'], clipCount: 3 });
  const r = await publish(env);
  eq('★ 只提交 1 次（不在同一轮里连撞 3 次）', env.uploads.length, 1);
  eq('★ 一次都没等（配额不可能几秒内恢复，等也没用）', env.waits.length, 0);
  eq('本批成功 0 片', r.submitted, 0);
  const clip0 = env.ledger.getClip(env.task.id, 0);
  eq('★ 状态是 CANDIDATE（待投），**不是** FAILED', clip0?.status, 'CANDIDATE');
  ok('failReason 说清是配额限流 + 今日已提交数 + 建议重试时间', /配额限流/.test(clip0?.failReason ?? '') && /今日已提交 \d+ 个/.test(clip0?.failReason ?? '') && /30 分钟后重试/.test(clip0?.failReason ?? ''), clip0?.failReason);
  ok('failReason 保留 B站 原话（人工可核对）', /投稿过于频繁/.test(clip0?.failReason ?? ''), clip0?.failReason);
  ok('切片产物仍保留（等配额恢复可直接重投，不用重切）', Boolean(clip0?.cutOutput), String(clip0?.cutOutput));
  eq('★ 后面两片没被撞（状态仍是 PENDING_UPLOAD）', env.ledger.getClip(env.task.id, 1)?.status, 'PENDING_UPLOAD');
  eq('第 3 片同样没被撞', env.ledger.getClip(env.task.id, 2)?.status, 'PENDING_UPLOAD');
  eq('★ 被配额拒的那次不该占「今日投稿额度」', env.ledger.todayPublishedCount(), 0);
  eq('★ 发了一条告警', env.quotaAlerts.length, 1);
  const alert = env.quotaAlerts[0]!;
  eq('告警里写明本批已投成功数', alert.submitted, 0);
  eq('★ 告警里写明剩余几片待投', alert.remaining, 2);
  eq('告警里给出建议重试时间', alert.retryAfterMin, UPLOAD_QUOTA_RETRY_AFTER_MIN);
  ok('告警带 B站 原话', /投稿过于频繁/.test(alert.reason), alert.reason);
  /* 配额限流不是 bug ⇒ 不写错误报告（错误报告列表里不该堆这种噪音） */
  const reportDirQuota = path.join(tmpRoot, 'error-report');
  const quotaReports = (fs.existsSync(reportDirQuota) ? fs.readdirSync(reportDirQuota) : [])
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(reportDirQuota, f), 'utf8')) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })
    .filter((b) => String(b['taskId'] ?? '') === env.task.id);
  eq('★ 不写错误报告（配额限流不是"要人修的 bug"）', quotaReports.length, 0);
  env.cleanup();
}

/* ========================================================================== */
section('⑪ ★ 配额限流不写脏指纹：重跑投稿阶段必须真的重投，而不是被"幂等命中"跳过');
{
  const env = makeEnv(path.join(tmpRoot, 'k'), { submit: ['quota'], clipCount: 2 });
  await publish(env);
  eq('第一次：只提交 1 次', env.uploads.length, 1);
  /* 关键在于：B站 已经回了 taskId（分支 B 那一路）时我们会先登记幂等指纹；
     配额拒绝意味着"什么都没创建"，那条指纹必须被清掉，否则下次会「幂等命中 ⇒ 跳过 ⇒ 假装已提交」 */
  await publish(env);
  eq('★ 第二次重跑确实又提交了一次（没有被幂等指纹拦成"跳过")', env.uploads.length, 2);
  eq('状态仍是 CANDIDATE（可重投）', env.ledger.getClip(env.task.id, 0)?.status, 'CANDIDATE');
  env.cleanup();
}

/* ========================================================================== */
section('⑫ ★ 配额限流经由"上传任务终态 error"这一支（事故事实）也按待投收尾');
{
  const env = makeEnv(path.join(tmpRoot, 'l'), {
    submit: ['ok'],
    taskDetail: [{ status: 'error', error: QUOTA_LIMIT_MSG }],
    clipCount: 2,
  });
  const r = await publish(env);
  eq('★ 只提交 1 次（不重试）', env.uploads.length, 1);
  eq('★ 没有等待', env.waits.length, 0);
  eq('本批成功 0 片', r.submitted, 0);
  const clip0 = env.ledger.getClip(env.task.id, 0);
  eq('★ 状态 CANDIDATE（分支 B 也要回写成待投，不能停在 SUBMITTED）', clip0?.status, 'CANDIDATE');
  ok('failReason 写明配额限流', /配额限流/.test(clip0?.failReason ?? ''), clip0?.failReason);
  /* ★ 分支 B 会先在台账写一次 SUBMITTED + uploadTaskId（崩溃恢复判定点），
     收尾改成 CANDIDATE 时必须把这些"并不存在的提交"字段清掉，
     否则「待投」的片上挂着一个 taskId，人工核对时又要多绕一圈（QA 2026-10-21 指出口径不一致）。 */
  eq('★ 不留 uploadTaskId（那次提交实际没被受理）', clip0?.uploadTaskId, undefined);
  eq('★ 不留 submitTime', clip0?.submitTime, undefined);
  eq('后一片没被撞', env.ledger.getClip(env.task.id, 1)?.status, 'PENDING_UPLOAD');
  eq('告警发了一条', env.quotaAlerts.length, 1);
  env.cleanup();
}

/* ========================================================================== */
section('⑬ ★ 混合措辞（带秒数）仍按秒级短退避重试，行为与以前一致');
{
  const env = makeEnv(path.join(tmpRoot, 'm'), { submit: ['quota-with-sec', 'ok'], clipCount: 2 });
  const r = await publish(env);
  /* 3 次 = 第 1 片被拒 + 第 1 片重交 + 第 2 片正常投（**没有**停整批，这与配额级相反） */
  eq('★ 提交了 3 次（被拒后重交，且第 2 片照常投）', env.uploads.length, 3);
  eq('等待了 1 次（按对方给的 2 秒）', env.waits.length, 1);
  eq('本批成功 2 片（第二片继续正常投）', r.submitted, 2);
  eq('切片状态推进到 SUBMITTED', env.ledger.getClip(env.task.id, 0)?.status, 'SUBMITTED');
  eq('没有发配额告警（它不是配额级）', env.quotaAlerts.length, 0);
  env.cleanup();
}

/* ========================================================================== */
section('⑭ ★ 多分P（追加）路径：配额限流同样不重试、按待投收尾');
{
  const env = makeAppendEnv(path.join(tmpRoot, 'n'), {
    submit: ['quota'],
    taskDetail: [{ status: 'completed' }],
    /* 探针只会在"配额级 + 续传"时被调一次：返回"没落地"，于是按待投收尾 */
    partTitles: [[]],
  });
  const res = await env.publisher.publishAsMultiPart({
    task: env.task,
    uid: 1,
    clips: env.ledger.getClips(env.task.id),
    resumeAid: '117000000000001',
    resumeBvid: 'BV1APPEND01',
    logger: silentLog as never,
  });
  eq('★ 只提交 1 次（配额级不原地重试）', env.uploads.length, 1);
  eq('没有等待', env.waits.length, 0);
  eq('按失败返回（ok=false，但下面看状态）', res.ok, false);
  ok('错误里写明配额限流 + 建议重试时间', /配额限流/.test(res.error ?? '') && /30 分钟后重试/.test(res.error ?? ''), res.error);
  eq('★ 切片是 CANDIDATE（待投），不是 FAILED', env.ledger.getClip(env.task.id, 0)?.status, 'CANDIDATE');
  env.cleanup();
}

/* ========================================================================== */
section('⑮ ★ 账号受限闸门（2026-10-22）：24h 内 2 次配额拒绝 ⇒ 之后一次都不再试探');
{
  /* 用户实际场景：10-21 撞配额 → 10-22 明明 0 次投稿，点「重新投稿」仍被拒。
     闸门要保证：第 2 次拒绝之后，`publishClips` **连一次 biliUpload 都不发**。 */
  const env = makeEnv(path.join(tmpRoot, 'quota-guard'), { submit: ['quota'], clipCount: 1 });

  const r1 = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
  eq('⑮a 第 1 次：只提交 1 次', env.uploads.length, 1);
  ok('⑮a 第 1 次：还没到阈值，闸门未关', env.publisher.quotaGuardStatus().blocked === false);
  eq('⑮a 第 1 次：切片留待投', env.ledger.getClip(env.task.id, 0)?.status, 'CANDIDATE');
  void r1;

  const r2 = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
  eq('⑮b 第 2 次：仍提交 1 次（共 2 次）', env.uploads.length, 2);
  const st2 = env.publisher.quotaGuardStatus();
  ok('⑮b 第 2 次：闸门关上', st2.blocked === true, JSON.stringify(st2));
  ok('⑮b 有明确解除时间', Boolean(st2.until), JSON.stringify(st2.until));
  ok('⑮b 文案说清是账号受限', /账号受限/.test(st2.note), st2.note);
  void r2;

  const r3 = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
  eq('⑮c ★ 受限期间 0 次提交（连试探都不发）', env.uploads.length, 2);
  ok('⑮c 返回 stuck（不是失败，切片产物都还在）', r3.stuck === true, JSON.stringify(r3.stuck));
  ok('⑮c 返回 quotaBlocked 供 UI 展示', Boolean(r3.quotaBlocked?.until), JSON.stringify(r3.quotaBlocked));
  ok('⑮c results 为空（没投任何一片）', r3.results.length === 0, String(r3.results.length));
  eq('⑮c 切片仍待投', env.ledger.getClip(env.task.id, 0)?.status, 'CANDIDATE');

  /* 隔离性：闸门文件必须落在**本用例的临时台账目录**，不能写生产 data/ */
  ok(
    '⑮d 闸门状态落在临时台账目录（不污染生产）',
    fs.existsSync(path.join(path.dirname(env.ledger.publishLogPath), 'quota-block.json')),
    path.dirname(env.ledger.publishLogPath),
  );

  env.publisher.clearQuotaBlock('test');
  const st3 = env.publisher.quotaGuardStatus();
  ok('⑮e 手动解除后不再受限', st3.blocked === false, st3.note);
  eq('⑮e 解除后仍保留 24h 拒绝计数（供参考）', st3.rejections, 2);

  const r4 = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
  eq('⑮f 解除后可以重新尝试（又提交 1 次）', env.uploads.length, 3);
  void r4;
  env.cleanup();
}

/* ========================================================================== */
section('⑯ 闸门的时间规则：默认解到"次日 0 点"，临近午夜改用 6 小时兜底');
{
  const near = nextBlockUntil(Date.parse('2026-10-22T18:00:00+08:00'));
  ok('⑯a 18:00 判定 ⇒ 次日 0 点', new Date(near).getHours() === 0 && new Date(near).getDate() === 23, new Date(near).toString());
  const lateNight = nextBlockUntil(Date.parse('2026-10-22T23:30:00+08:00'));
  const hours = (lateNight - Date.parse('2026-10-22T23:30:00+08:00')) / 3600000;
  ok('⑯b 23:30 判定 ⇒ 改用 6 小时兜底（避免几分钟后就自动解封）', Math.abs(hours - 6) < 0.01, String(hours));
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
