/**
 * 「崩溃后未完成的任务必须被接着处理」回归（无网络、零费用）。
 *
 * 实测背景（2026-10-07 01:17）：服务在处理一场 55 分钟录播时因 Node 堆 OOM **整个进程 abort**。
 * 重启时崩溃恢复把任务从 `TRANSCRIBING` 修回 `RECORDED` —— 但**队列是内存态**，重启后是空的，
 * 于是这一场再也没人处理：面板显示「已导入过（任务 …，状态 RECORDED）」，
 * 看起来像在处理，实际素材白录（ASR / 切片 / 投稿全没发生）。
 *
 * 修法：启动时把「`RECORDED` 且不是用户主动停的」任务重新入队。本套件钉住三条边界：
 *   ① 该捡的捡（`RECORDED`）；
 *   ② 用户主动停过的不捡（`stoppedByUserAt`）——否则会把用户明确不要的场次又跑一遍；
 *   ③ 半自动模式等确认的（`ANALYZED`）和已经有产出的（`TRANSCRIBED`/`CLIPPED`/`PUBLISHED`）不捡。
 *
 * 用法：node test/boot-requeue.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import type { Logger } from '../src/logger.ts';
import { Orchestrator } from '../src/daemon.ts';
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
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-requeue-'));
const now = new Date().toISOString();

/* 错误事件流与报告目录是模块级常量，必须隔离，否则测试制造的失败会写进真实 data/errors.jsonl */
const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
setErrorsPath(path.join(tmp, 'errors.jsonl'));
setErrorReportDir(path.join(tmp, 'error-report'));

/**
 * 静默 logger。
 *
 * 台账默认用**全局** logger，它写的是真实 `data/logs/live_auto-<date>.jsonl` ——
 * 实测踩到：这个套件往真实日志里灌了几十条「新建场次任务」，把线上排障的日志尾部刷掉了
 * （当时正在找 OOM 崩溃前的最后一条流水线日志，结果只看到测试的噪音）。
 * 测试的日志只该留在测试自己的临时目录里。
 */
const silentLogger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  child: (): unknown => silentLogger,
} as unknown as Logger;

function mkTask(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    roomId: '12345678',
    platform: 'Bilibili',
    title: `恢复测试场 ${id}`,
    streamer: '丙主播',
    status: 'RECORDED',
    stage: 'RECORDED',
    importSource: 'auto',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now,
    ...over,
  } as TaskRecord;
}
function mkClip(index: number): ClipRecord {
  return {
    index,
    start: 0,
    end: 60,
    title: `切片 ${index}`,
    desc: '',
    tags: ['切片'],
    category: '游戏/单机游戏',
    score: 8,
    reason: '测试',
    selected: true,
    status: 'CANDIDATE',
    degraded: false,
    createdAt: now,
  } as ClipRecord;
}

console.log('\x1b[1m崩溃后接着处理（启动重新入队）\x1b[0m');
console.log('─'.repeat(66));

/* ========================================================================== */
section('① 候选选择（纯函数）：只挑「录完但什么都没做，且用户没停过」的');
{
  const ledger = new Ledger({ path: path.join(tmp, 'l1', 'ledger.json'), logger: silentLogger });
  fs.mkdirSync(path.join(tmp, 'l1'), { recursive: true });
  ledger.createTask(mkTask('t-recorded'));                                        // ← 该捡
  ledger.createTask(mkTask('t-stopped', { stoppedByUserAt: now }));                // ← 用户停过：不捡
  ledger.createTask(mkTask('t-analyzed', { status: 'ANALYZED', stage: 'ANALYZED' })); // ← 等用户确认：不捡
  ledger.createTask(mkTask('t-transcribed', { status: 'TRANSCRIBED', stage: 'TRANSCRIBED' })); // ← 已有产出：不捡
  ledger.createTask(mkTask('t-clipped', { status: 'CLIPPED', stage: 'CLIPPED' }));
  ledger.createTask(mkTask('t-published', { status: 'PUBLISHED', stage: 'PUBLISHED' }));
  ledger.createTask(mkTask('t-failed', { status: 'FAILED', stage: 'PUBLISHED' }));
  const got = ledger.requeueCandidates().map((c) => c.id);
  eq('★ 只挑 RECORDED 且未被用户停过的（其余 6 种状态一律不碰）', got, ['t-recorded']);

  /* 还有一个更隐蔽的情况：任务被修回 RECORDED 时如果没清掉"用户停过"的标记，
     就会出现「用户停了 → 手动继续跑 → 再崩一次 → 又被跳过」的诡异行为。 */
  ledger.updateTask('t-stopped', {}, { unset: ['stoppedByUserAt'] });
  eq('清掉标记后它重新成为候选（用户手动"继续"就是这条路径）', ledger.requeueCandidates().map((c) => c.id).sort(), ['t-recorded', 't-stopped']);
}

/* ========================================================================== */
section('② Orchestrator 行为：重新入队 / 源素材已删的只警告不入队');
const dataDir = path.join(tmp, 'orch');
/* ⚠️ 必须先建好 logs 目录：Orchestrator 的日志流在启动时就打开
   dataDirOverride/logs/live_auto-<date>.jsonl，目录不存在会先报一次 ENOENT
   （Logger 会降级成仅控制台，但输出里多一行噪音，退出码也会被带成 1）。 */
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json'), logger: silentLogger });
const orch = new Orchestrator({ ledger, dataDirOverride: dataDir });
orch.logger.setConsole(false);

/* 素材真写一个文件（"源素材还在"才能入队） */
const srcFile = path.join(dataDir, 'src.ts');
fs.writeFileSync(srcFile, 'x');
ledger.createTask(mkTask('boot-go', { source: { segments: [{ path: srcFile, duration: 60, globalStart: 0, globalEnd: 60, size: 1 }], totalDuration: 60, rawFiles: [srcFile], fullVideoHasDanmaku: false } }));
ledger.createTask(mkTask('boot-gone', { source: { segments: [], totalDuration: 60, rawFiles: [path.join(dataDir, '已经不存在.ts')], fullVideoHasDanmaku: false } }));
ledger.createTask(mkTask('boot-stopped', { stoppedByUserAt: now }));

/* 把 enqueue 换成探针：这一步只验证"该不该捡"，绝不真的跑流水线 */
const enqueued: string[] = [];
(orch as unknown as { enqueue: (id: string, from?: string) => Promise<void> }).enqueue = async (id: string) => {
  enqueued.push(id);
};
{
  const r = await orch.recoverUnfinishedTasks();
  eq('★ 只有源素材还在的那个被重新入队', enqueued, ['boot-go']);
  eq('返回值如实报出"重新入队/素材缺失/已在队列"', [r.requeued, r.skippedMissing, r.refused], [['boot-go'], ['boot-gone'], []]);
  eq('用户停过的不在返回值里', r.requeued.includes('boot-stopped'), false);
  ok('素材缺失的那个没有被入队（只记 warning）', !enqueued.includes('boot-gone'));
  eq('重新入队会给它计数（供崩溃循环刹车用）', ledger.getTask('boot-go')?.autoResumeCount, 1);
}

/* ========================================================================== */
section('②b 崩溃循环刹车：同一任务自动重跑超过 3 次就停手');
{
  /* 闭环：任务让进程 OOM abort → 看门狗拉起 → 启动恢复重新入队 → 再崩。
     实测每 2 分钟一轮，用户看到的就是"反复重启"。超过上限必须停手并留警告。 */
  const l3 = new Ledger({ path: path.join(tmp, 'l3', 'ledger.json'), logger: silentLogger });
  fs.mkdirSync(path.join(tmp, 'l3'), { recursive: true });
  const src = path.join(dataDir, 'src3.ts');
  fs.writeFileSync(src, 'x');
  const mk = (id: string, over: Partial<TaskRecord> = {}): void => {
    l3.createTask(
      mkTask(id, {
        source: { segments: [{ path: src, duration: 60, globalStart: 0, globalEnd: 60, size: 1 }], totalDuration: 60, rawFiles: [src], fullVideoHasDanmaku: false },
        ...over,
      }),
    );
  };
  mk('crashy');
  mk('ok-task');
  const o3 = new Orchestrator({ ledger: l3, dataDirOverride: dataDir });
  o3.logger.setConsole(false);
  const seen: string[] = [];
  const realEnqueue = o3.enqueue.bind(o3);
  (o3 as unknown as { enqueue: (id: string, from?: string) => Promise<void> }).enqueue = async (id: string) => {
    seen.push(id);
  };
  /* 连续 3 次启动：crashy 每次都被捡起（计数 1→2→3） */
  for (let i = 1; i <= 3; i++) {
    await o3.recoverUnfinishedTasks();
    eq(`第 ${i} 次启动：crashy 仍被重新入队`, l3.getTask('crashy')?.autoResumeCount, i);
  }
  const r4 = await o3.recoverUnfinishedTasks();
  ok('★ 第 4 次启动不再自动重跑（刹车生效）', !r4.requeued.includes('crashy') && r4.blocked.includes('crashy'), JSON.stringify(r4));
  eq('计数停在上限，不再增长', l3.getTask('crashy')?.autoResumeCount, 3);
  eq('另一个正常任务同样在 3 次后停下（上限按任务计）', [r4.requeued.length, l3.getTask('ok-task')?.autoResumeCount], [0, 3]);
  /* 用户手动点「继续处理」= enqueue ⇒ 计数清零（否则修好之后还得手动改台账） */
  (o3 as unknown as { drainQueue: () => Promise<void> }).drainQueue = async () => {};
  await realEnqueue('crashy', 'RECORDED');
  ok('★ 手动入队会把计数清零（修好后能继续自动重跑）', (l3.getTask('crashy')?.autoResumeCount ?? 0) === 0, String(l3.getTask('crashy')?.autoResumeCount));
}

/* ========================================================================== */
section('③ 真实语义：入队会清掉"用户停过"的标记（否则手动继续后又被跳过）');
{
  const l2 = new Ledger({ path: path.join(tmp, 'l2', 'ledger.json'), logger: silentLogger });
  const o2 = new Orchestrator({ ledger: l2, dataDirOverride: dataDir });
  o2.logger.setConsole(false);
  l2.createTask(mkTask('t2', { stoppedByUserAt: now }));
  eq('停止标记在台账里', l2.getTask('t2')?.stoppedByUserAt, now);
  /* 直接调 enqueue（不跑流水线：把 drainQueue 换掉） */
  (o2 as unknown as { drainQueue: () => Promise<void> }).drainQueue = async () => {};
  await o2.enqueue('t2', 'RECORDED');
  eq('★ 入队后标记被清掉（清可选字段必须走 unset，写 undefined 是静默无效的）', l2.getTask('t2')?.stoppedByUserAt, undefined);
  eq('清掉之后它才能被启动恢复捡到', l2.requeueCandidates().map((c) => c.id), ['t2']);
}

/* ========================================================================== */
section('④ 静态接线：启动时真的会调用这一步（不然前面两条都白搭）');
{
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'daemon.ts'), 'utf8');
  ok('★ start() 里调用了 recoverUnfinishedTasks()', /await this\.recoverUnfinishedTasks\(\)/.test(src));
  ok('调用点在上面那个 try/catch 里（失败不阻塞启动）', /try \{\s*await this\.recoverUnfinishedTasks\(\);\s*\} catch/.test(src));
  ok('stopTask 里写 stoppedByUserAt（用户主动停过）', /stoppedByUserAt: nowIso\(\)/.test(src));
  ok('enqueue 里用 unset 清标记与计数（不是 patch: undefined）', /unset: \['stoppedByUserAt', 'autoResumeCount'\]/.test(src));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
