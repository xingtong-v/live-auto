/**
 * 切片阶段并发（`publishClips` 的有界流水线）——2026-10-13，优化清单 P0-1。
 *
 * 背景（实测）：切片阶段是唯一还在拖时间的环节 —— 12 片 514 s、20 片 607 s，而日志时间线显示
 * **我方是"提交一个 → 等它完成 → 再提交下一个"**（wp2u 那场两片的提交时刻恰好相隔一片的处理时间）。
 * 改造：在多分P 模式下把这个循环里**只切片**的部分并发跑（上传仍由 publishMultiPart 串行处理）。
 *
 * 这个套件锁四件事（都是"改坏了会真出事"的性质）：
 *   ① **K=1 与历史行为逐字一致**（默认值就是 1 ⇒ 零行为变化）；
 *   ② K=2 时切片**确实重叠**（并发生效），且结果顺序仍按 queue；
 *   ③ **单P 模式绝不并发**（那个模式下循环内含上传，并发会绕过 minSubmitIntervalSec 风控抖动）；
 *   ④ 一片失败不阻塞其它片，且结果条数与队列一致（顺序不乱）。
 *
 * 做法：起一个隔离环境（临时 dataDir + 临时 config），**直接驱动真实的 publishClips**，
 * 只把 `cutAndUploadClip` 这一片打桩（记录进入/离开时刻 + 可控耗时 + 可控失败），不碰网络。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/daemon.ts';
import { Ledger } from '../src/ledger.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(title: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${title}`);
  } else {
    fail++;
    failures.push(`${title}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${title}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(title: string, got: unknown, want: unknown): void {
  ok(title, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface PubLike {
  cfg: { publish: Record<string, unknown>; clip: Record<string, unknown> };
  client: unknown;
  cutAndUploadClip: (opts: unknown, idx: number) => Promise<Record<string, unknown>>;
  publishClips: (opts: Record<string, unknown>) => Promise<{ results: Array<{ clipIndex: number }>; submitted: number; skipped: number; failed: number }>;
}

/** 起一个隔离环境，返回真实 publisher（cutAndUploadClip 由调用方打桩） */
function makePub(tmpRoot: string, multiPart: boolean, concurrency: number, clips = 4): { pub: PubLike; queue: number[] } {
  const dataDir = path.join(tmpRoot, `data-${multiPart ? 'mp' : 'sp'}-${concurrency}-${clips}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
  const taskId = `cut-pipe-${multiPart}-${concurrency}-${clips}`;
  ledger.createTask({
    id: taskId,
    roomId: '1',
    title: '切片并发测试场',
    stage: 'CLIPPED',
    status: 'CLIPPED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  /* ★ 必须真建切片：publishClips 的队列来自"选中且可切"的切片（CANDIDATE/PENDING_UPLOAD/FAILED），
     没有切片 ⇒ 队列为空 ⇒ 循环一次都不跑（第一版就是这么全 0 的）。 */
  ledger.setClips(
    taskId,
    Array.from({ length: clips }, (_, i) => ({
      index: i,
      start: i * 300,
      end: i * 300 + 120,
      title: `并发测试切片 ${i}`,
      desc: '',
      tags: ['测试'],
      category: '生活',
      score: 7,
      selected: true,
      status: 'CANDIDATE',
    })) as never,
  );
  const realCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')) as Record<string, unknown>;  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...realCfg,
        publish: {
          ...(realCfg['publish'] as object),
          multiPart,
          /* ★ 两个键必须**一起**写（界面保存时就是这么写的）：
             只改 multiPart、却把线上配置里的 clipPublishMode 一起带进来，配置就自相矛盾了 ——
             服务端按 clipPublishMode 走（2026-10-16 加了「切片投稿方式」开关之后），
             本用例就会在"单P 模式"里拿到多分P 的并发数。 */
          clipPublishMode: multiPart ? 'append' : 'standalone',
          minSubmitIntervalSec: 0,
          dailyLimit: 0,
          autoRetryOnce: false,
        },
        clip: { ...(realCfg['clip'] as object), concurrency },
      },
      null,
      2,
    ),
    'utf8',
  );
  const orch = new Orchestrator({ configPath, dataDirOverride: dataDir, ledger });
  const pub = (orch as unknown as { publisher: PubLike }).publisher;
  /* 只桩掉网络：biliArchives 在循环之前被调用一次 */
  pub.client = { biliArchives: async () => [] } as never;
  /* ★ publishClips 收的是 opts.task（场次对象，见 publish.ts 里 task.id 的用法），不是 taskId。
     这里包一层把 task 补进去，省得每个用例都手写一遍。 */
  const realPublishClips = pub.publishClips.bind(pub);
  const task = ledger.getTask(taskId)!;
  pub.publishClips = (o: Record<string, unknown>) => realPublishClips({ task, ...o });
  return { pub, queue: Array.from({ length: clips }, (_, i) => i) };
}

/** 打桩：记录并发水位与进出顺序，每个调用耗时 ms，可指定某个 idx 失败 */
function stub(pub: PubLike, opts: { ms: number; failIdx?: number[] }): { maxConcurrent: () => number; order: number[] } {
  let inFlight = 0;
  let max = 0;
  const order: number[] = [];
  pub.cutAndUploadClip = async (_opts: unknown, idx: number) => {
    inFlight++;
    max = Math.max(max, inFlight);
    order.push(idx);
    await sleep(opts.ms);
    inFlight--;
    const shouldFail = (opts.failIdx ?? []).includes(idx);
    return shouldFail
      ? { clipIndex: idx, ok: false, error: { type: 'internal', message: 'stub 失败' }, warnings: [] }
      : { clipIndex: idx, ok: true, output: `fake-${idx}.mp4`, warnings: [] };
  };
  return { maxConcurrent: () => max, order };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cutpipe-'));

try {
  section('1. 默认（clip.concurrency=1）⇒ 与历史行为一致：逐片、不重叠、顺序即队列');
  {
    const { pub, queue } = makePub(tmpRoot, true, 1);
    const s = stub(pub, { ms: 40 });
    const r = await pub.publishClips({ taskId: 'cut-pipe-true-1-4', submitTimeMs: Date.now() });
    eq('★ 最大并发 = 1', s.maxConcurrent(), 1);
    eq('★ 调用顺序 = 队列顺序', s.order, queue);
    eq('结果条数 = 队列长度', r.results.length, queue.length);
    eq('结果顺序 = 队列顺序（并发改造不许打乱顺序）', r.results.map((x) => x.clipIndex), queue);
  }

  section('2. clip.concurrency=2 且多分P ⇒ 切片确实重叠，且顺序不乱');
  {
    const { pub, queue } = makePub(tmpRoot, true, 2);
    const s = stub(pub, { ms: 120 });
    const t0 = Date.now();
    const r = await pub.publishClips({ taskId: 'cut-pipe-true-2-4', submitTimeMs: Date.now() });
    const wall = Date.now() - t0;
    eq('★ 最大并发 = 2（并发真的生效）', s.maxConcurrent(), 2);
    eq('★ 结果仍按队列顺序回填', r.results.map((x) => x.clipIndex), queue);
    ok('★ 墙钟明显短于串行（4 片 ×120ms 串行 ≈480ms）', wall < 380, `实测 ${wall}ms`);
    ok('每个切片都被调用且只调用一次', [...s.order].sort((a, b) => a - b).join(',') === queue.join(','), JSON.stringify(s.order));
  }

  section('3. ★ 单P 模式绝不并发（那个模式下循环内含上传，并发会绕过风控抖动）');
  {
    const { pub, queue } = makePub(tmpRoot, false, 3);
    const s = stub(pub, { ms: 40 });
    const r = await pub.publishClips({ taskId: 'cut-pipe-false-3-4', submitTimeMs: Date.now() });
    eq('★ 即使 clip.concurrency=3，单P 模式的最大并发仍是 1', s.maxConcurrent(), 1);
    eq('顺序不变', s.order, queue);
    eq('结果齐', r.results.length, queue.length);
  }

  section('3b. ★ 转写进行中时强制降到 1（避免 ffmpeg 与本地 Fun-ASR 抢 CPU）');
  {
    const { pub, queue } = makePub(tmpRoot, true, 3);
    /* 信号取自台账：造一个「正在转写」的场次，publishClips 应把 cutK 压到 1。
       台账实例直接从 publisher 上取（它就是同一份台账），不额外起环境。 */
    const led = (pub as unknown as { ledger: Ledger }).ledger;
    led.createTask({
      id: 'cut-pipe-transcribing',
      roomId: '1',
      title: '正在转写的场次',
      stage: 'TRANSCRIBING',
      status: 'TRANSCRIBING',
      source: { segments: [], totalDuration: 600, rawFiles: [], fullVideoHasDanmaku: false },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    const s = stub(pub, { ms: 40 });
    const r = await pub.publishClips({ taskId: 'cut-pipe-true-3-4', submitTimeMs: Date.now() });
    eq('★ 有场次在转写 ⇒ 即使 clip.concurrency=3，并发也压到 1', s.maxConcurrent(), 1);
    eq('顺序不变', s.order, queue);
    eq('结果齐', r.results.length, queue.length);
  }

  section('4. 一片失败不阻塞其它片，结果仍按顺序、条数一致');
  {
    const { pub, queue } = makePub(tmpRoot, true, 2);
    const s = stub(pub, { ms: 60, failIdx: [1] });
    const r = await pub.publishClips({ taskId: 'cut-pipe-true-2-4-fail', submitTimeMs: Date.now() });
    eq('★ 结果条数仍 = 队列长度（失败不吞条目）', r.results.length, queue.length);
    eq('★ 顺序仍是队列顺序', r.results.map((x) => x.clipIndex), queue);
    eq('失败的那片如实计入 failed', r.failed, 1);
    ok('其它片照常完成（merged 后仍有 3 片成功）', r.results.filter((x) => (x as { ok?: boolean }).ok).length === 3, JSON.stringify(r.results.map((x) => (x as { ok?: boolean }).ok)));
    eq('并发水位仍为 2（失败不影响并发）', s.maxConcurrent(), 2);
  }
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
