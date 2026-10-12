/**
 * 自动投稿取头部（`src/analyze.ts` 的 `splitAutoPublish`）—— 2026-10-12 语义调整的断言。
 *
 * 背景（用户实测反馈）：原先 `clip.autoSelectTopN` 的语义是"**默认勾选**项数上限"，
 * 实现成"按排名把达标的候选改回未勾选"，而且是**静默**的：
 * 一场 8 个候选全部 ≥6.9（9.7…8.0…7.0），第 7 名（8.0）与第 8 名被取消勾选，
 * 解释只进了内存里的 warnings（不落盘、不进日志、界面看不到）
 * ⇒ 用户"不知道为什么 8.0 没被选中"，只能手动补勾。
 *
 * 现在拆开：**勾选**只看分数门槛；"自动投多少"由本函数分类，调用方负责留痕。
 * 本套件钉住分类本身的性质（纯函数，不涉及台账与网络）。
 */
import { splitAutoPublish } from '../src/analyze.ts';

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

/** 造出用户那场的真实分数（8 个候选，全部 ≥6.9） */
const userCase = [8.0, 7.0, 9.7, 9.6, 9.2, 8.9, 8.6, 8.3].map((score, i) => ({ index: i, score }));

section('1. 用户那场的真实案例（上限 6 时，8.0 应落在"需手动"一侧）');
{
  const r = splitAutoPublish(userCase, 6);
  eq('自动投 6 个', r.auto.length, 6);
  eq('需手动 2 个', r.manual.length, 2);
  eq('自动投的是分数最高的 6 个', r.auto.map((c) => c.score), [9.7, 9.6, 9.2, 8.9, 8.6, 8.3]);
  eq('★ 需手动的是 8.0 与 7.0（正是用户报的那两个）', r.manual.map((c) => c.score), [8.0, 7.0]);
}

section('2. 上限足够大 = 达标全自动（用户当前取值 99）');
{
  const r = splitAutoPublish(userCase, 99);
  eq('全部自动投', r.auto.length, 8);
  eq('没有需手动的', r.manual.length, 0);
}

section('3. 边界与健壮性');
{
  eq('上限 1 只自动投最高分那个', splitAutoPublish(userCase, 1).auto.map((c) => c.score), [9.7]);
  eq('空集合不炸', splitAutoPublish([], 5).auto.length, 0);
  eq('上限 0 会被夹到 1（不允许"一个都不自动投"这种静默停摆）', splitAutoPublish(userCase, 0).auto.length, 1);
  eq('上限为小数时向下取整', splitAutoPublish(userCase, 2.9).auto.length, 2);
  eq('分数缺失按 0 处理（排序不炸）', splitAutoPublish([{ index: 0 }, { index: 1, score: 5 }], 1).auto.map((c) => c.index), [1]);
  const scores = userCase.map((c) => c.score);
  splitAutoPublish(userCase, 3);
  eq('不改动入参顺序（纯函数）', userCase.map((c) => c.score), scores);
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
