/**
 * 预转写的"一轮"逻辑（`src/pre-transcribe-tick.ts`）——2026-10-14，P1-6 B 步。
 *
 * 断言重点（都是"接错会让真实直播出问题"的地方）：
 *   ① **关闭时零动作**：连候选都不列（不然每小时都在读目录）；
 *   ② 单场故障**不影响其它场**（录制期间出问题最忌讳连环失败）；
 *   ③ 状态保存失败**不影响转写结果**（保存是附带的，转写成果不能被它带崩）；
 *   ④ `loadDone` 生效（不重复转写已做过的分段）；
 *   ⑤ 仍在写的分段如实记"仍在写"（不是失败，是等它闭合）。
 */
import { runPreTranscribeTick } from '../src/pre-transcribe-tick.ts';
import type { MediaSegment } from '../src/media-plan.ts';

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

const NOW = Date.now();
const closed = (): { mtimeMs: number } => ({ mtimeMs: NOW - 10 * 60_000 });
const SEGS: MediaSegment[] = [
  { path: 'a.flv', globalStart: 0, globalEnd: 600 },
  { path: 'b.flv', globalStart: 600, globalEnd: 1200 },
];
const noopLog = (): void => undefined;

section('1. ★ 关闭时零动作（连候选都不列）');
{
  let listCalls = 0;
  let discoverCalls = 0;
  let saves = 0;
  const r = await runPreTranscribeTick({
    enabled: false,
    recordingCandidates: () => {
      listCalls++;
      return [{ videoPath: 'x.flv' }];
    },
    discoverSegments: () => {
      discoverCalls++;
      return SEGS;
    },
    transcribe: async () => ({ cues: 1, coveredSec: 1 }),
    statOf: closed,
    loadDone: () => undefined,
    saveState: () => {
      saves++;
    },
    log: noopLog,
  });
  eq('★ 候选一次都没列', listCalls, 0);
  eq('★ 分段一次都没扫', discoverCalls, 0);
  eq('★ 状态一次都没存', saves, 0);
  eq('汇总全 0', [r.scanned, r.worked, r.ready, r.notes.length], [0, 0, 0, 0]);
}

section('2. 没有已闭合分段 ⇒ 只记一句说明，不算做事');
{
  const r = await runPreTranscribeTick({
    enabled: true,
    recordingCandidates: () => [{ videoPath: 'x.flv', title: '某场' }],
    discoverSegments: () => [],
    transcribe: async () => ({ cues: 1, coveredSec: 1 }),
    statOf: closed,
    loadDone: () => undefined,
    saveState: () => undefined,
    log: noopLog,
  });
  eq('扫了 1 个候选', r.scanned, 1);
  eq('没做事', r.worked, 0);
  ok('说明是"目前没有已闭合的分段"', /目前没有已闭合的分段/.test(r.notes.join(' ')), r.notes.join(' '));
}

section('3. 正常一轮：转完、存状态、报告进度');
{
  const saved: string[] = [];
  const r = await runPreTranscribeTick({
    enabled: true,
    recordingCandidates: () => [{ videoPath: 'x.flv', title: '某场', pendingParts: 1 }],
    discoverSegments: () => SEGS,
    transcribe: async () => ({ cues: 20, coveredSec: 600 }),
    statOf: closed,
    loadDone: () => undefined,
    saveState: (vp) => saved.push(vp),
    log: noopLog,
  });
  eq('做了 1 场', r.worked, 1);
  eq('全部就绪 ⇒ ready=1', r.ready, 1);
  eq('状态被保存（按 videoPath）', saved, ['x.flv']);
  ok('说明含进度与"已可合并"', /已转 2\/2 段/.test(r.notes.join(' ')) && /已可合并/.test(r.notes.join(' ')), r.notes.join(' '));
}

section('4. ★ 单场故障不影响其它场');
{
  const okPaths: string[] = [];
  const r = await runPreTranscribeTick({
    enabled: true,
    recordingCandidates: () => [
      { videoPath: '坏.flv', title: '坏的一场' },
      { videoPath: '好.flv', title: '好的一场' },
    ],
    discoverSegments: (vp) => {
      if (vp === '坏.flv') throw new Error('扫描炸了');
      return SEGS;
    },
    transcribe: async () => ({ cues: 5, coveredSec: 500 }),
    statOf: closed,
    loadDone: () => undefined,
    saveState: (vp) => okPaths.push(vp),
    log: noopLog,
  });
  eq('★ 好的一场照常做完', r.worked, 1);
  eq('★ 保存的只有好的一场', okPaths, ['好.flv']);
  ok('★ 坏的一场如实记"本轮出错（已跳过）"', /坏的一场：本轮出错（已跳过）/.test(r.notes.join(' ')), r.notes.join(' '));
  eq('扫描了两个候选', r.scanned, 2);
}

section('5. ★ 保存状态失败不影响转写结果');
{
  const r = await runPreTranscribeTick({
    enabled: true,
    recordingCandidates: () => [{ videoPath: 'x.flv', title: '某场' }],
    discoverSegments: () => SEGS,
    transcribe: async () => ({ cues: 5, coveredSec: 500 }),
    statOf: closed,
    loadDone: () => undefined,
    saveState: () => {
      throw new Error('磁盘满了');
    },
    log: noopLog,
  });
  eq('★ 仍然算"做了事"（转写成果不被保存失败带崩）', r.worked, 1);
  ok('★ 明确说明保存失败不影响结果', /状态保存失败（不影响转写结果）：磁盘满了/.test(r.notes.join(' ')), r.notes.join(' '));
}

section('6. loadDone 生效 + 仍在写的分段如实标注');
{
  /* 6a：全部已做过 / 还在写 ⇒ **本轮无事可做 ⇒ 保持安静**（否则每 2 分钟刷一行"仍在写"）。
     这是刻意的语义：notes 只在"真的做了事"时产出。 */
  const quiet: number[] = [];
  const r0 = await runPreTranscribeTick({
    enabled: true,
    recordingCandidates: () => [{ videoPath: 'x.flv', title: '某场' }],
    discoverSegments: () => SEGS,
    transcribe: async (seg) => {
      quiet.push(seg.globalStart);
      return { cues: 1, coveredSec: 1 };
    },
    statOf: (p) => (p === 'b.flv' ? { mtimeMs: NOW + 60_000 } : closed()),
    loadDone: () => [0],
    saveState: () => undefined,
    log: noopLog,
  });
  eq('★ 已做过的第 1 段没重转、仍在写的第 2 段没转', quiet, []);
  eq('★ 无事可做时不产出说明（保持安静）', r0.notes.length, 0);
  eq('didWork 为假 ⇒ worked=0', r0.worked, 0);

  /* 6b：确实转了东西时，说明里要标出"还有几段仍在写" */
  const txed: number[] = [];
  const r = await runPreTranscribeTick({
    enabled: true,
    recordingCandidates: () => [{ videoPath: 'x.flv', title: '某场' }],
    discoverSegments: () => SEGS,
    transcribe: async (seg) => {
      txed.push(seg.globalStart);
      return { cues: 1, coveredSec: 1 };
    },
    statOf: (p) => (p === 'b.flv' ? { mtimeMs: NOW + 60_000 } : closed()),
    loadDone: () => undefined,
    saveState: () => undefined,
    log: noopLog,
  });
  eq('转了第 1 段（第 2 段仍在写）', txed, [0]);
  ok('说明里标出"1 段仍在写"与进度', /已转 1\/2 段（1 段仍在写）/.test(r.notes.join(' ')), r.notes.join(' '));
  eq('还没全完成 ⇒ ready=0', r.ready, 0);
  eq('算做了事', r.worked, 1);
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
