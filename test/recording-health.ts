/**
 * 录制质量体检（`src/recording-health.ts`）——2026-10-14，优化清单 P2 第一件。
 *
 * 锁住三档判据与它们的边界（都是"判错了会误导人"的地方）：
 *   · 单段/正常多段 ⇒ ok（不无端报警）；
 *   · 相邻段空隙很小（< 90 秒）且出现 ≥2 次 ⇒ fragmented（录制被中断后马上续上）；
 *   · 存在 ≥15 分钟的空档 ⇒ gap（可能停播或录制器掉线）——**优先级高于 fragmented**
 *     （长空档更值得人看一眼）。
 */
import { analyzeRecording } from '../src/recording-health.ts';
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
const seg = (start: number, end: number): MediaSegment => ({ path: `s${start}.flv`, globalStart: start, globalEnd: end });

section('1. 正常情况不报警');
{
  const one = analyzeRecording([seg(0, 3600)]);
  eq('单段 ⇒ ok', one.level, 'ok');
  eq('单段：段数 1、总时长 3600', [one.segments, one.totalSec], [1, 3600]);
  ok('单段的说明是人话', /单段录制（正常）/.test(one.note), one.note);

  const two = analyzeRecording([seg(0, 1800), seg(1800, 3600)]);
  eq('两段紧密相连（空隙 0）⇒ 只有 1 次碎片边界、不到阈值 ⇒ ok', two.level, 'ok');
  eq('碎片边界计数如实', two.fragmentBoundaries, 1);
}

section('2. 碎片：相邻空隙 < 90 秒，出现 ≥2 次');
{
  const frag = analyzeRecording([seg(0, 600), seg(620, 1200), seg(1240, 1800), seg(1860, 2400)]);
  eq('★ 3 次小空隙 ⇒ fragmented', frag.level, 'fragmented');
  eq('碎片边界数 = 3', frag.fragmentBoundaries, 3);
  eq('最长空档 = 60 秒（1860-1800）', frag.longestGapSec, 60);
  ok('说明里写清"助手已把它们并成一场"（不让用户以为没处理）', /已把它们并成一场/.test(frag.note), frag.note);
}

section('3. ★ 长空档优先：≥15 分钟 ⇒ gap（即使也有碎片）');
{
  const gap = analyzeRecording([seg(0, 600), seg(620, 1200), seg(3000, 3600)]);
  eq('★ 存在 30 分钟空档 ⇒ gap', gap.level, 'gap');
  eq('最长空档 = 1800 秒', gap.longestGapSec, 1800);
  ok('说明里提示去查录制器日志', /查一下录制器日志/.test(gap.note), gap.note);
}

section('4. 边界与健壮性');
{
  eq('空分段 ⇒ ok、不炸', analyzeRecording([]).level, 'ok');
  eq('乱序传入也会先排序（最长空档按时间算）', analyzeRecording([seg(3000, 3600), seg(0, 600)]).longestGapSec, 2400);
  const justUnder = analyzeRecording([seg(0, 600), seg(610, 1200), seg(1210, 1800)]);
  eq('空隙 10 秒 < 90 秒 ⇒ 算碎片', justUnder.level, 'fragmented');
  const exactly = analyzeRecording([seg(0, 600), seg(1500, 2000)]);
  eq('空隙 900 秒（15 分钟）⇒ 正好到长空档阈值 ⇒ gap', exactly.level, 'gap');
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
