/**
 * QA 独立验收（链路层）：单独投稿下，用户设置的「相邻切片间隔 / 随机抖动」**真的进了发给 B站 的 payload**。
 *
 * ## 为什么还要这一层
 *
 * 纯函数算对 ≠ 链路里有人读。本仓库出过两次「口径改对了但没人读」的事故
 * （`publish.multiPart` 配了没人读、`llm_dtype` 传错位置 ⇒ 静默忽略），
 * 所以验收必须走到 `Publisher.cutAndUploadClip()` 产出的**真实 dtime**。
 *
 * ## 与工程师自测的区别（不是复述他的断言）
 *
 *   · 配置**不从线上 `config.json` 继承一个键**（他的用例 readFileSync 了线上配置取非排期段）；
 *     这里只写要测的键，其余走 `defaults()` —— 结果不随用户改配置而漂移。
 *   · 断言的期望值来自需求，并且用**确定性输入**把"间隔到底是多少"钉死：
 *     `jitterSec=0` 时相邻两片的 dtime 差值必须**恰好**等于用户填的间隔（500 或 300），
 *     不给随机数留任何解释空间。
 *
 * 全程离线：不碰 B站、不跑 ffmpeg（`client.cut` 直接造出产物文件）、只写系统临时目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Publisher } from '../src/publish.ts';
import { DTIME_MIN_MARGIN_SEC, defaults, loadConfig, type AppConfig } from '../src/config.ts';
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
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const silentLog = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
  child: (): unknown => silentLog,
};

const CLIP_COUNT = 5;

interface Env {
  publisher: Publisher;
  task: TaskRecord;
  uploads: Array<Record<string, unknown>>;
}

/**
 * 起一套隔离环境：临时 dataDir（临时 config 只写 publish/clip 两个段，其余 = `defaults()`）+
 * 真 `Publisher` + 假传输层（`cut` / `taskDetail` / `biliUpload` / `biliArchives` / `presetFfmpeg`）。
 */
function makeEnv(root: string, clipGapSec: number, jitterSec: number): Env {
  const dataDir = path.join(root, 'data');
  const taskId = `payload-qa-${clipGapSec}-${jitterSec}`;
  const taskDir = path.join(dataDir, 'tasks', taskId);
  const clipsOut = path.join(root, 'clips-out');
  fs.mkdirSync(path.join(taskDir, 'full'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'clips', taskId), { recursive: true });
  fs.mkdirSync(clipsOut, { recursive: true });

  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json'), logger: silentLog as never });
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    title: '排期口径独立验收场',
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
    recordingId: `rec-${clipGapSec}-${jitterSec}`,
    source: { ...ledger.getTask(taskId)!.source, rawFiles: [raw], fullVideoPath: raw },
  });

  /* 只写要测的键；非排期段一律走 defaults()（= config.example.json + 内置兜底），
     不读线上 config.json —— 用户随时会改它，继承会让本用例的结果跟着漂。 */
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        clip: {
          burnDanmaku: false,
          burnSubtitles: false,
          avSyncRepair: false,
          concurrency: 1,
          ffmpegPresetId: '',
          outputDir: clipsOut,
        },
        publish: {
          clipPublishMode: 'standalone',
          multiPart: false,
          fullVideoBy: 'bililive-tools',
          /* 关键：立即发布开着也不该影响切片（定时投稿是单独投稿的固定行为） */
          immediatePublish: true,
          submitGapSec: DTIME_MIN_MARGIN_SEC,
          firstPublishAt: '',
          dailyLimit: 0,
          minSubmitIntervalSec: 0,
          autoRetryOnce: false,
          defaultCover: '',
          resumeAid: '',
          clipGapSec,
          jitterSec,
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
      cut: async (p: Record<string, unknown>): Promise<{ taskId: string }> => {
        const out = String(p['output']);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, 'x');
        return { taskId: `cut-${path.basename(out)}` };
      },
      taskDetail: async (): Promise<{ status: string; output: string }> => ({ status: 'completed', output: '' }),
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

  return { publisher, task: ledger.getTask(taskId)!, uploads };
}

/** payload 里的 dtime（缺这个字段 = 立即发布） */
function dtimeOf(payload: Record<string, unknown>): number | undefined {
  const cfg = payload['config'] as Record<string, unknown> | undefined;
  const v = cfg?.['dtime'];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-sched-payload-qa-'));
const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));
setErrorReportDir(path.join(tmpRoot, 'error-report'));

/** 跑一批：整批共用一个提交基准时刻（真实链路就是 `publishClips({submitTimeMs})` 传下去的那个） */
async function runBatch(label: string, clipGapSec: number, jitterSec: number): Promise<{ dtimes: number[]; base: number; results: Array<{ ok: boolean; error?: { message: string } }> }> {
  const env = makeEnv(path.join(tmpRoot, label), clipGapSec, jitterSec);
  const base = Date.now();
  const results: Array<{ ok: boolean; error?: { message: string } }> = [];
  for (let i = 0; i < CLIP_COUNT; i++) {
    results.push(await env.publisher.cutAndUploadClip({ task: env.task, uid: 12345, submitTimeMs: base, clipOrdinal: i + 1 }, i));
  }
  const dtimes = env.uploads.map((u) => dtimeOf(u) ?? Number.NaN);
  return { dtimes, base, results };
}

try {
  /* ==========================================================================
   * 1. 用户配置 500 / 120：抖动 0 时差值必须恰好 500
   * ========================================================================== */
  section('1. 单独投稿 + clipGapSec=500 / jitterSec=0 ⇒ 相邻两片恰好 500 秒');
  {
    const { dtimes, base, results } = await runBatch('gap500-jitter0', 500, 0);
    eq(`投出去 ${CLIP_COUNT} 片`, dtimes.length, CLIP_COUNT);
    ok('每片都成功', results.every((r) => r.ok), results.map((r) => r.error?.message ?? 'ok').join(' | '));
    ok('★ 即使 immediatePublish=true，payload 仍带 dtime（单独投稿固定定时投稿）', dtimes.every((d) => Number.isFinite(d)), JSON.stringify(dtimes));
    const gaps = dtimes.slice(1).map((d, i) => d - dtimes[i]!);
    console.log(`      dtime 间隔：${JSON.stringify(gaps)}`);
    ok('★ 四个间隔**恰好**都是 500 秒（用户设置原样生效，不是硬编码的 300）', gaps.every((g) => g === 500), JSON.stringify(gaps));
    ok('严格递增（无排期倒挂）', gaps.every((g) => g > 0), JSON.stringify(gaps));
    ok(
      '★ 每片 dtime 距提交基准 ≥ 300 秒（B站 平台底线）',
      dtimes.every((d) => d - Math.floor(base / 1000) >= 300),
      JSON.stringify(dtimes.map((d) => d - Math.floor(base / 1000))),
    );
  }

  /* ==========================================================================
   * 2. 平台底线：用户填 100 ⇒ payload 里必须是 300
   * ========================================================================== */
  section('2. clipGapSec=100（低于底线）/ jitterSec=0 ⇒ 实际排期 300 秒');
  {
    const { dtimes, results } = await runBatch('gap100-jitter0', 100, 0);
    ok('每片都成功', results.every((r) => r.ok), results.map((r) => r.error?.message ?? 'ok').join(' | '));
    const gaps = dtimes.slice(1).map((d, i) => d - dtimes[i]!);
    console.log(`      dtime 间隔：${JSON.stringify(gaps)}`);
    ok('★ 四个间隔恰好 300 秒（低于底线被抬到平台底线，不是 100）', gaps.every((g) => g === 300), JSON.stringify(gaps));
  }

  /* ==========================================================================
   * 3. 抖动真的进了 payload：120 的上限可观测
   * ========================================================================== */
  section('3. clipGapSec=500 / jitterSec=120 ⇒ 间隔落在 500 ± 抖动（可观测且不倒挂）');
  {
    const { dtimes, results } = await runBatch('gap500-jitter120', 500, 120);
    ok('每片都成功', results.every((r) => r.ok), results.map((r) => r.error?.message ?? 'ok').join(' | '));
    const gaps = dtimes.slice(1).map((d, i) => d - dtimes[i]!);
    console.log(`      dtime 间隔：${JSON.stringify(gaps)}`);
    ok('严格递增（抖动上限 < 间隔 ⇒ 不会倒挂）', gaps.every((g) => g > 0), JSON.stringify(gaps));
    /* 每片抖动 ∈ [0,119] ⇒ 差 ∈ [500-119, 500+119] */
    ok(
      '★ 四个间隔全部落在 [381, 619]（= 500 ± 119，抖动上限 120 真的在起作用）',
      gaps.every((g) => g >= 500 - 119 && g <= 500 + 119),
      JSON.stringify(gaps),
    );
    ok(
      '★ 且不是「等于 300 的等距」老口径（至少有一个间隔 > 350）',
      gaps.some((g) => g > 350),
      JSON.stringify(gaps),
    );
  }
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 占用：留着无害 */
  }
}

console.log('\n' + '─'.repeat(72));
console.log(`\x1b[1m验收集（真实 payload）：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
