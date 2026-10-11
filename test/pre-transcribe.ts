/**
 * 录制期间的预转写（`src/pre-transcribe.ts`）——2026-10-14，P1-6 A 步。
 *
 * 这个模块是"边录边转写"里**唯一新增的运行组件**，所以断言重点在"它不会乱来"：
 *   ① **默认关时零动作**（连 stat 都不调）—— 直接证明"默认关 = 零行为变化"；
 *   ② 还在写的分段**不转**（半截素材会得到残缺转写，与 watch-import 的 isStable 同一判据）；
 *   ③ 全部分段闭合并转完 ⇒ readyToMerge（调用方可据此跳过整段转写）；
 *   ④ **一段失败 ⇒ 整场回退，且本轮不再尝试别的段**（回退是终态）；
 *   ⑤ 已经做过的分段不重复转（调用方从持久化状态恢复）。
 *
 * 全部用假转写器 + 假 statOf，不碰真实录像、不调 ffmpeg/ASR。
 */
import { markSegmentFailed, planIncremental } from '../src/incremental-asr.ts';
import { mergeSegmentedTranscript, runPreTranscribe } from '../src/pre-transcribe.ts';
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
const NOW = Date.now();
/** 造一个"全部已闭合"的 statOf */
const closedStat = (): { mtimeMs: number } => ({ mtimeMs: NOW - 10 * 60_000 });

section('1. ★ 默认关：零动作（连 stat 都不调）');
{
  let statCalls = 0;
  let txCalls = 0;
  const r = await runPreTranscribe({
    taskId: 't1',
    segments: SEGS,
    enabled: false,
    closedBeforeMs: NOW,
    statOf: () => {
      statCalls++;
      return closedStat();
    },
    transcribe: async () => {
      txCalls++;
      return { cues: 1, coveredSec: 1 };
    },
  });
  eq('★ stat 一次都没调', statCalls, 0);
  eq('★ 转写一次都没调', txCalls, 0);
  eq('didWork=false', r.didWork, false);
  eq('状态仍是初始（全部 pending）', r.state.segments.map((s) => s.status), ['pending', 'pending', 'pending']);
}

section('2. 还在写的分段不转（其余照转）');
{
  const txed: number[] = [];
  const r = await runPreTranscribe({
    taskId: 't2',
    segments: SEGS,
    enabled: true,
    closedBeforeMs: NOW,
    /* 第二段**还在写**（mtime 晚于判据时刻）；其余已闭合。
       ⚠️ 必须严格晚于：mtime === closedBeforeMs 算"已闭合"（这是模块的语义，不是 bug）。 */
    statOf: (p) => (p === 'b.flv' ? { mtimeMs: NOW + 60_000 } : closedStat()),
    transcribe: async (seg) => {
      txed.push(seg.globalStart);
      return { cues: 10, coveredSec: 590 };
    },
  });
  eq('★ 只转了已闭合的两段（a、c）', txed, [0, 1200]);
  const bAttempt = r.attempts.find((x) => x.index === 1);
  ok('未闭合的那段如实记原因', /仍在写入/.test(bAttempt?.reason ?? ''), JSON.stringify(r.attempts));
  eq('状态：a/c done、b pending', r.state.segments.map((s) => s.status), ['done', 'pending', 'done']);
  eq('★ 还没全完成 ⇒ 不能合并', r.readyToMerge, false);
  eq('进度如实', r.progress, { done: 2, total: 3, remaining: 1 });
}

section('3. 全部闭合且转完 ⇒ readyToMerge（调用方可跳过整段转写）');
{
  const r = await runPreTranscribe({
    taskId: 't3',
    segments: SEGS,
    enabled: true,
    closedBeforeMs: NOW,
    statOf: closedStat,
    transcribe: async () => ({ cues: 42, coveredSec: 600 }),
  });
  eq('三段都 done', r.state.segments.map((s) => s.status), ['done', 'done', 'done']);
  eq('★ readyToMerge=true', r.readyToMerge, true);
  eq('进度 3/3', r.progress, { done: 3, total: 3, remaining: 0 });
  eq('统计被记下', r.state.segments[0]?.cues, 42);
  eq('didWork=true', r.didWork, true);
}

section('4. ★ 一段失败 ⇒ 整场回退，且本轮不再尝试别的段');
{
  const txed: number[] = [];
  const r = await runPreTranscribe({
    taskId: 't4',
    segments: SEGS,
    enabled: true,
    closedBeforeMs: NOW,
    statOf: closedStat,
    transcribe: async (seg) => {
      txed.push(seg.globalStart);
      if (seg.globalStart === 600) throw new Error('模拟转写失败');
      return { cues: 5, coveredSec: 500 };
    },
  });
  eq('★ 失败后没有继续转第三段（回退是终态）', txed, [0, 600]);
  eq('★ 整场切 fallback', r.state.mode, 'fallback');
  ok('回退原因写清是哪一段、为什么', /分段 #1 转写失败：模拟转写失败/.test(r.state.fallbackReason ?? ''), r.state.fallbackReason);
  eq('★ 不能合并（调用方据此走整段路径）', r.readyToMerge, false);
  ok('attempts 里两段都有记录（成功 + 失败）', r.attempts.length === 2 && r.attempts[1]?.ok === false, JSON.stringify(r.attempts));
}

section('5. 已做过的分段不重复转 + 取不到文件信息不致命');
{
  const txed: number[] = [];
  const r = await runPreTranscribe({
    taskId: 't5',
    segments: SEGS,
    enabled: true,
    closedBeforeMs: NOW,
    alreadyDone: [0], // 调用方从持久化状态恢复
    statOf: (p) => (p === 'b.flv' ? undefined : closedStat()), // 第二段取不到信息
    transcribe: async (seg) => {
      txed.push(seg.globalStart);
      return { cues: 3, coveredSec: 300 };
    },
  });
  eq('★ 已做过的第一段没有再转', txed.includes(0), false);
  eq('只转了第三段', txed, [1200]);
  const bAttempt = r.attempts.find((x) => x.index === 1);
  ok('取不到文件信息时如实记原因（不中断）', /取不到文件信息/.test(bAttempt?.reason ?? ''), JSON.stringify(r.attempts));
}

section('6. ★ C 步合并：分段字幕平移到全局时间轴（含拒绝半截结果的判据）');
{
  const st = planIncremental('m1', SEGS);
  /* 两段各自的段内 cue（每段都从 0 开始 ⇒ 必须加 globalStart 才是全局时间） */
  const per = [[{ start: 1, end: 3, text: '甲' }, { start: 5, end: 8, text: '乙' }], [{ start: 0.5, end: 2, text: '丙' }]];
  const m = mergeSegmentedTranscript(SEGS.slice(0, 2), per, st);
  ok('用了分段结果', m.used, m.reason);
  eq('★ 第二段的 cue 被平移到 600 秒之后', m.cues.map((c) => c.start), [1, 5, 600.5]);
  eq('★ 合并后条数 = 各段之和', m.cues.length, 3);
  ok('覆盖时长如实（2+3+1.5=6.5 ⇒ 7）', m.coveredSec === 7, String(m.coveredSec));

  /* 缺一段 ⇒ 拒绝（绝不半截出片） */
  const part = mergeSegmentedTranscript(SEGS.slice(0, 2), [[{ start: 1, end: 2 }], undefined], st);
  ok('★ 有一段没字幕 ⇒ used=false 并说明是哪段', !part.used && /#1/.test(part.reason), part.reason);
  eq('拒绝时不返回任何 cue', part.cues.length, 0);

  /* 已回退 ⇒ 拒绝 */
  const fb = markSegmentFailed(planIncremental('m2', SEGS), 0, '炸了');
  const r2 = mergeSegmentedTranscript(SEGS.slice(0, 2), per, fb);
  ok('★ 已回退整段路径 ⇒ 拒绝使用分段结果', !r2.used && /已回退整段路径/.test(r2.reason), r2.reason);

  /* 空分段 ⇒ 拒绝 */
  ok('没有分段 ⇒ 拒绝', !mergeSegmentedTranscript([], [], st).used);
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
