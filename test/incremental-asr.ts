/**
 * 边录边转写的状态机（`src/incremental-asr.ts`）——2026-10-13，优化清单 P1-6 第一步。
 *
 * 锁三条性质（都是"接主链时出错会真出事"的）：
 *   ① **推进**：分段依序完成，进度如实；全 done 才允许合并；
 *   ② **一票回退**：任何一段失败 ⇒ 整场切 fallback（回退到现有整段路径），且回退是**终态**
 *      （后续的成功/失败都不再改变它）；
 *   ③ **纯函数**：所有转移都不改入参（调用方会把它丢进日志/台账，改入参会造成难查的串状态）。
 *
 * 为什么先测这个而不是先接主链：可行性只证明了**质量**（分段 vs 整段字幕差 0.06%、覆盖差 0.01%），
 * 而它要动的是录制监听与任务状态机 —— 先把性质钉住，接错时有断言兜着。
 */
import { markSegmentDone, markSegmentFailed, markSegmentTranscribing, mergePlan, planIncremental, progress, readyToMerge } from '../src/incremental-asr.ts';
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

const SEGS: MediaSegment[] = [
  { path: 'a.flv', globalStart: 0, globalEnd: 600 },
  { path: 'b.flv', globalStart: 600, globalEnd: 1200 },
  { path: 'c.flv', globalStart: 1200, globalEnd: 1800 },
];

section('1. 初始状态与推进');
{
  const s0 = planIncremental('t1', SEGS);
  eq('初始：3 段全 pending', s0.segments.map((x) => x.status), ['pending', 'pending', 'pending']);
  eq('初始：走分段路径', s0.mode, 'incremental');
  eq('初始：进度 0/3', progress(s0), { done: 0, total: 3, remaining: 3 });
  ok('初始：还不能合并', !readyToMerge(s0));

  const s1 = markSegmentDone(markSegmentTranscribing(s0, 0), 0, { cues: 100, coveredSec: 540.25 });
  eq('第 1 段完成后状态', s1.segments[0]!.status, 'done');
  eq('统计被记下（覆盖秒数保留 1 位）', [s1.segments[0]!.cues, s1.segments[0]!.coveredSec], [100, 540.3]);
  eq('进度 1/3', progress(s1), { done: 1, total: 3, remaining: 2 });
  ok('还没全完成 ⇒ 不能合并', !readyToMerge(s1));

  const s2 = markSegmentDone(markSegmentDone(s1, 1, { cues: 90, coveredSec: 500 }), 2, { cues: 80, coveredSec: 480 });
  ok('3 段全完成 ⇒ 可以合并', readyToMerge(s2));
  eq('进度 3/3', progress(s2), { done: 3, total: 3, remaining: 0 });
  const plan = mergePlan(s2);
  eq('合并输入 = 分段列表（按原顺序）', plan.mode === 'segments' ? plan.segments.map((x) => x.path) : [], ['a.flv', 'b.flv', 'c.flv']);
}

section('2. ★ 一票回退：任何一段失败 ⇒ 整场回退，且回退是终态');
{
  const base = markSegmentDone(planIncremental('t2', SEGS), 0, { cues: 100, coveredSec: 540 });
  const failed = markSegmentFailed(base, 1, '连接超时');
  eq('失败后 mode = fallback', failed.mode, 'fallback');
  ok('回退原因写清了是哪一段、为什么', /分段 #1 转写失败：连接超时/.test(failed.fallbackReason ?? ''), failed.fallbackReason);
  eq('失败段被标记', failed.segments[1]!.status, 'failed');

  /* 终态：后续 done/failed/transcribing 都不改变 mode */
  const after = markSegmentDone(markSegmentFailed(markSegmentTranscribing(failed, 2), 2, '又失败了'), 0, { cues: 1, coveredSec: 1 });
  eq('★ 回退是终态（后续事件不改变 mode）', after.mode, 'fallback');
  ok('★ 也不允许再合并', !readyToMerge(after));
  eq('★ mergePlan 给出回退指令（调用方据此走整段路径）', mergePlan(after).mode, 'fallback');
}

section('3. ★ 纯函数：所有转移都不改入参');
{
  const s0 = planIncremental('t3', SEGS);
  const snapshot = JSON.stringify(s0);
  markSegmentTranscribing(s0, 0);
  markSegmentDone(s0, 0, { cues: 1, coveredSec: 1 });
  markSegmentFailed(s0, 1, 'boom');
  eq('★ 调完三个转移后，入参一字未改', JSON.stringify(s0), snapshot);
}

section('4. 边界：空分段 / 越界索引 / 重复完成');
{
  const empty = planIncremental('t4', []);
  ok('空分段 ⇒ 不能合并（不假装成功）', !readyToMerge(empty));
  eq('空分段的合并决策是回退', mergePlan(empty).mode, 'fallback');

  const s = planIncremental('t5', SEGS);
  eq('越界索引不炸（返回原状态）', markSegmentDone(s, 99, { cues: 1, coveredSec: 1 }), s);
  const twice = markSegmentDone(markSegmentDone(s, 0, { cues: 10, coveredSec: 10 }), 0, { cues: 20, coveredSec: 20 });
  eq('重复完成以最后一次为准（不累加）', twice.segments[0]!.cues, 20);
  eq('已完成标记为 transcribing 不倒退', markSegmentTranscribing(twice, 0).segments[0]!.status, 'done');
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
