/**
 * 多分P 续传的**指纹级幂等**自测。
 *
 * 背景（真实事故，2026-09-23 稿件 BV13hhE6XEQM）：
 *   同一个任务对同一个稿件跑了两次续传 —— 09:49 投 9 个切片、11:31 又投 14 个，
 *   其中 9 个是第一批已经投过的。结果 B站 稿件里出现 9 组内容重复的分P，
 *   分P 总数 43 而不同标题只有 28。项目侧的 publish-log 也如实记了 23 条 submit
 *   （9 个标题各出现 2 次），但因为**没人拦**，错误就这么发生了。
 *
 * 当时的防线只有两道，都不够：
 *   1. **标题去重**（fetchExistingPartTitles → 比对分P 标题）：只在
 *      "目标稿件分P 列表已经刷新出来"时才生效。B站 分P 列表有约 20 分钟延迟，
 *      而两次续传只隔了 1 小时 42 分 —— 但那 9 个分P 恰恰是在 11:31 之前刚追加的，
 *      是否可见完全取决于 B站 当时的刷新进度。日志里没有出现「续传去重：跳过 N 个」，
 *      说明那一次标题去重**没能生效**（existing 为 undefined 或列表里还没有那 9 个）。
 *   2. **指纹幂等**（findFingerprint）：此前只写在 `cutAndUploadClip`（单切片路径）里。
 *      多分P 路径 `publishAsMultiPart` **只 register 不 find** —— 它把指纹写进台账，
 *      却从不查台账，所以查了也没用。
 *
 * 本测试锁住修复后的行为：
 *   · 同一任务、同标题、同区间的切片第二次续传时被**指纹**拦下，不再产生第二个批次；
 *   · 被拦下的切片状态被同步成 SUBMITTED/PUBLISHED（UI 不再显示"待投稿"）；
 *   · 部分重复时**只投新增的**（不是整批放弃，也不是整批重投）；
 *   · 全部重复时返回 ok:true + skipped（是"无需投稿"，不是"投稿失败"）。
 *
 * 用**真实** Publisher（不是假替身），只把 client 换成不碰网络的假 client，
 * 这样经过的是线上同一条代码路径。
 *
 * 运行：node --experimental-strip-types test/fingerprint-dedup.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Publisher } from '../src/publish.ts';
import { loadConfig } from '../src/config.ts';
import type { ClipRecord, TaskRecord } from '../src/types.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
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
  ledger: Ledger;
  taskId: string;
  uploads: Array<Record<string, unknown>>;
}

const TASK_ID = 'fp-dedup-0001';

function makeEnv(tmpRoot: string, opts: { resumeAid?: string } = {}): Env {
  const dataDir = path.join(tmpRoot, 'data');
  const taskDir = path.join(dataDir, 'tasks', TASK_ID);
  const clipsDir = path.join(dataDir, 'clips', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(clipsDir, { recursive: true });

  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
  ledger.createTask({
    id: TASK_ID,
    roomId: '12345678',
    title: '指纹去重测试场',
    liveStartTime: Math.floor(Date.now() / 1000) - 7200,
    stage: 'ANALYZED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
    transcriptPath: path.join(taskDir, 'transcript.json'),
    signalsPath: path.join(taskDir, 'signals.json'),
    clipsPath: path.join(taskDir, 'clips.json'),
  });

  /* 3 个切片，各写一个真实的产物占位文件 —— publishAsMultiPart 只收 exists() 的分P */
  const clips: Array<Partial<ClipRecord>> = [0, 1, 2].map((i) => {
    const out = path.join(clipsDir, `0${i + 1}-${String(100 + i * 400).padStart(6, '0')}-切片${i + 1}.mp4`);
    fs.writeFileSync(out, 'x');
    return {
      index: i,
      start: 100 + i * 400,
      end: 250 + i * 400,
      title: `切片${i + 1}`,
      desc: '',
      tags: ['测试'],
      category: '游戏/单机游戏',
      score: 8,
      selected: true,
      status: 'CUT' as const,
      cutOutput: out,
    };
  });
  ledger.setClips(TASK_ID, clips as never);

  const realCfg = loadConfig(path.join(process.cwd(), 'config.json')).config;
  const cfg = {
    ...realCfg,
    publish: { ...realCfg.publish, multiPart: true, resumeAid: opts.resumeAid ?? '' },
  };

  const uploads: Array<Record<string, unknown>> = [];
  const fakeClient = {
    biliArchives: async (): Promise<unknown[]> => [],
    biliUpload: async (p: Record<string, unknown>): Promise<{ taskId: string }> => {
      uploads.push(p);
      return { taskId: `upload-${uploads.length}` };
    },
  };

  const publisher = new Publisher({
    client: fakeClient as never,
    config: cfg,
    ledger,
    logger: silentLog as never,
  });
  return { publisher, ledger, taskId: TASK_ID, uploads };
}

/** 投一次续传，返回结果 + 这次实际投出去的分P 标题 */
async function publishOnce(env: Env): Promise<{ res: Awaited<ReturnType<Publisher['publishAsMultiPart']>>; titles: string[] }> {
  const task = env.ledger.getTask(env.taskId) as TaskRecord;
  const clips = env.ledger.getClips(env.taskId);
  const res = await env.publisher.publishAsMultiPart({
    task,
    uid: 12345,
    clips,
    resumeAid: '117314833877723',
    logger: silentLog as never,
  });
  const titles = res.parts.filter((p) => p.kind === 'clip').map((p) => p.title);
  return { res, titles };
}

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fpdedup-'));

  /* 错误事件流/报告重定向到临时目录，避免污染真实 data/ */
  const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
  setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));
  setErrorReportDir(path.join(tmpRoot, 'error-report'));

  /* ======================================================================
   * 1. 同一批续传跑两次 —— 第二次必须被指纹拦下（这就是 loby 事故的复现）
   * ==================================================================== */
  section('1. 同任务同标题同区间：第二次续传必须被指纹拦下（复现 loby 事故）');
  {
    const env = makeEnv(path.join(tmpRoot, 'a'));
    const first = await publishOnce(env);
    ok('第一次续传投出 3 个切片分P', first.titles.length === 3, `实际 ${first.titles.length}`);
    ok('第一次续传产生 1 次 biliUpload 调用', env.uploads.length === 1, `实际 ${env.uploads.length}`);
    ok('第一次带 vid（走 editMedia 追加，不是新建稿件）', env.uploads[0]?.['vid'] === '117314833877723', `实际 ${String(env.uploads[0]?.['vid'])}`);

    /* 指纹应已落账 —— 这是第二道防线的依据 */
    const regs = env.ledger.getClips(env.taskId).filter((c) => c.fingerprint);
    ok('第一次续传后 3 个切片都登记了指纹', regs.length === 3, `实际 ${regs.length}`);

    const second = await publishOnce(env);
    ok('★ 第二次续传没有再发出任何投稿请求（指纹拦住）', env.uploads.length === 1, `实际 biliUpload 调用 ${env.uploads.length} 次`);
    ok('第二次实际投出 0 个分P', second.titles.length === 0, `实际 ${second.titles.length}`);
    ok('第二次返回 ok=true（是「无需投稿」而不是「投稿失败」）', second.res.ok === true, `ok=${String(second.res.ok)} error=${String(second.res.error)}`);
    ok('第二次带上了 skipped 说明（调用方据此填 submitted=0/skipped=N）', typeof second.res.skipped === 'string' && second.res.skipped.length > 0, `skipped=${String(second.res.skipped)}`);
    ok('第二次 warnings 里出现「指纹去重」', second.res.warnings.some((w) => w.includes('指纹去重')), JSON.stringify(second.res.warnings));
    const statuses = env.ledger.getClips(env.taskId).map((c) => c.status);
    ok('被拦下的切片状态仍是已投（SUBMITTED/PUBLISHED），不会退回待投稿', statuses.every((s) => s === 'SUBMITTED' || s === 'PUBLISHED'), statuses.join(','));
  }

  /* ======================================================================
   * 2. 部分重复：只投新增的（既不能整批重投，也不能整批放弃）
   * ==================================================================== */
  section('2. 部分重复：已投的被跳过，新增的照常投');
  {
    const env = makeEnv(path.join(tmpRoot, 'b'));
    const first = await publishOnce(env);
    ok('第一批投出 3 个', first.titles.length === 3, `实际 ${first.titles.length}`);

    /* 新增第 4 个切片（模拟重跑时 LLM 又选出新片段） */
    const clipsDir = path.join(tmpRoot, 'b', 'data', 'clips', TASK_ID);
    const out4 = path.join(clipsDir, '04-001300-切片4.mp4');
    fs.writeFileSync(out4, 'x');
    const all = env.ledger.getClips(env.taskId);
    env.ledger.setClips(env.taskId, [
      ...(all as never[]),
      { index: 3, start: 1300, end: 1450, title: '切片4', desc: '', tags: ['测试'], category: '游戏/单机游戏', score: 9, selected: true, status: 'CUT', cutOutput: out4 } as never,
    ]);

    const second = await publishOnce(env);
    ok('★ 第二批只投新增的那 1 个', second.titles.length === 1, `实际投 ${second.titles.length} 个：${second.titles.join(' / ')}`);
    ok('新增的那个确实是「切片4」', second.titles[0] === '切片4', String(second.titles[0]));
    ok('第二批确实又发起了投稿（不是整批放弃）', env.uploads.length === 2, `实际 ${env.uploads.length}`);
    const up4 = env.uploads[1]?.['videos'] as Array<{ title: string }> | undefined;
    ok('biliUpload 的 videos 只含 1 个分P', up4?.length === 1, `实际 ${up4?.length}`);
  }

  /* ======================================================================
   * 3. 没有指纹命中时不能误伤（回归保护）
   * ==================================================================== */
  section('3. 回归保护：全新任务（无任何指纹）必须照常全投');
  {
    const env = makeEnv(path.join(tmpRoot, 'c'));
    const r = await publishOnce(env);
    ok('全新任务的 3 个切片全部投出', r.titles.length === 3, `实际 ${r.titles.length}`);
    ok('没有被误判为重复（无「指纹去重」警告）', !r.res.warnings.some((w) => w.includes('指纹去重')), JSON.stringify(r.res.warnings));
    ok('返回值里没有 skipped', r.res.skipped === undefined, String(r.res.skipped));
  }

  console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31m失败项：\x1b[0m');
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

await main();
