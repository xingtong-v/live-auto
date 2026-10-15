/**
 * 转写调用单元规划（`src/media-plan.ts`）——2026-10-11，ASR 独立进程第一步的配套断言。
 *
 * 这个纯函数是"ASR 阶段能搬进独立进程"的前提：跨进程只传可序列化的 `segments`，
 * worker 侧用同一份代码重建 `planCalls`。所以它的语义必须被**逐条锁住** ——
 * 一旦悄悄变了，worker 与主进程就会对同一段音频切出不同的窗口，产出不一致的转写。
 *
 * 锁的四件事（全部来自 `asr.ts` / `daemon.ts` 的既有语义，不是新设计）：
 *   ① 区间与分段求交（不是按区间均分）；
 *   ② 交叠 ≤0.5 秒直接跳过（避免为一条缝起一个转写进程）；
 *   ③ `offset` 恒为 0（全局时间 = 段内时间 + globalStart）；
 *   ④ 一段都切不出时**退化为整文件一次**并如实回报 fallback。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMediaAdapter, planSegmentCalls, type MediaSegment } from '../src/media-plan.ts';
import { mergeWindowsPerFile } from '../src/asr.ts';

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

/* 两个相邻分段：0–1800 与 1800–3540（模拟录制断流后的分片） */
const SEGS: MediaSegment[] = [
  { path: 'F:/tmp/a.ts', globalStart: 0, globalEnd: 1800, size: 100 },
  { path: 'F:/tmp/b.ts', globalStart: 1800, globalEnd: 3540, size: 100 },
];

section('1. 按分段边界求交（不是按区间均分）');
{
  const r = planSegmentCalls(SEGS, { start: 0, end: 3540 });
  eq('跨两个分段 ⇒ 两个调用单元', r.calls.length, 2);
  eq('不是 fallback', r.fallback, false);
  eq('第一段：段内 0–1800，全局 0–1800', [r.calls[0]!.inFileStart, r.calls[0]!.inFileEnd, r.calls[0]!.globalStart, r.calls[0]!.globalEnd], [0, 1800, 0, 1800]);
  eq('第二段：段内 0–1740（全局 1800–3540 落在第二段里）', [r.calls[1]!.inFileStart, r.calls[1]!.inFileEnd, r.calls[1]!.globalStart, r.calls[1]!.globalEnd], [0, 1740, 1800, 3540]);
  eq('文件指向各自的分段', [r.calls[0]!.file, r.calls[1]!.file], ['F:/tmp/a.ts', 'F:/tmp/b.ts']);
  ok('★ offset 恒为 0（全局时间 = 段内时间 + globalStart）', r.calls.every((c) => c.offset === 0));
  ok('windowIndex 恒为 0（由调用方另行编号）', r.calls.every((c) => c.windowIndex === 0));
}

section('2. 区间只覆盖后半段 / 只覆盖一部分');
{
  const onlyB = planSegmentCalls(SEGS, { start: 2000, end: 3000 });
  eq('只落在第二段 ⇒ 一个单元', onlyB.calls.length, 1);
  eq('段内偏移正确（2000-1800=200 → 3000-1800=1200）', [onlyB.calls[0]!.inFileStart, onlyB.calls[0]!.inFileEnd], [200, 1200]);
  const partial = planSegmentCalls(SEGS, { start: 900, end: 2100 });
  eq('横跨边界 ⇒ 仍是两个单元（各取交叠部分）', partial.calls.map((c) => [c.inFileStart, c.inFileEnd]), [[900, 1800], [0, 300]]);
  eq('数值保留 3 位小数（避免浮点噪声进缓存键）', planSegmentCalls([{ path: 'x', globalStart: 0.0001, globalEnd: 10.0004 }], { start: 0.0001, end: 10.0004 }).calls[0]!.globalStart, 0);
}

section('3. ≤0.5 秒的缝直接跳过（不为一条缝起进程）');
{
  /* ⚠️ 第一版这里期望 0 个调用单元 —— 错的。两侧交叠各 0.3 秒确实都被跳过，
     但"切不出任何单元"会触发**整文件兜底**（与 daemon 原实现一致：宁可慢也不空转写），
     所以结果是 1 个 fallback 单元。语义没错，是断言没跟上。 */
  const tiny = planSegmentCalls(SEGS, { start: 1799.7, end: 1800.3 });
  eq('区间整个落在缝里 ⇒ 两侧都跳过，但触发整文件兜底（1 个单元）', tiny.calls.length, 1);
  eq('并且如实标记为 fallback', tiny.fallback, true);
  const justOver = planSegmentCalls(SEGS, { start: 1799.4, end: 1800.7 });
  ok('交叠 0.6 秒 > 0.5 ⇒ 两侧都不跳过（共 2 个单元）', justOver.calls.length === 2 && !justOver.fallback, String(justOver.calls.length));
}

section('4. 切不出单元时退化为「整文件一次」并如实回报');
{
  const zero = planSegmentCalls([{ path: 'only.ts', globalStart: 0, globalEnd: 0 }], { start: 0, end: 100 });
  eq('★ 退化成一个整文件调用（宁可慢，也不静默产出空转写）', zero.calls.length, 1);
  eq('★ 如实回报 fallback', zero.fallback, true);
  eq('兜底用第一个分段', [zero.calls[0]!.file, zero.fallbackSegment?.path], ['only.ts', 'only.ts']);
  eq('★ 兜底单元给的是"整段时长"（至少 1 秒），不是 0 —— 0 会被下游当成空音频', [zero.calls[0]!.inFileStart, zero.calls[0]!.inFileEnd], [0, 100]);
  eq('兜底的 global 也从 0 起算（与原实现一致）', [zero.calls[0]!.globalStart, zero.calls[0]!.globalEnd], [0, 100]);
  const empty = planSegmentCalls([], { start: 0, end: 100 });
  eq('没有分段 ⇒ 没有调用单元，也不谎报 fallback', [empty.calls.length, empty.fallback], [0, false]);
}

section('4b. ★ 兜底单元必须保留区间在全局时间轴上的位置（2026-10-15 真机数据丢失事故）');
{
  /* 现场（任务 auto-20261015135916-6rh9，58:58 的录播）：`source.segments[0]` 是
     `globalStart=0, globalEnd=0` —— 任务是文件**还在写**的时候建的，那一刻探测不到时长。
     于是每个窗口与该分段求交都为空 ⇒ 走兜底。原实现把"区间长度"当全局区间：
     第 2 个窗口（1800–3537）会自称"全局 0–1737" ⇒ ① 时间戳与第 1 个窗口重叠、
     ② 被 mergeWindowsPerFile 并进第一块（1737 − 0 ≤ 块长上限 1800）
     ⇒ **后 29 分钟整段没转**，而日志只说"把 2 个窗口合并为 1 块"。 */
  const badSeg: MediaSegment[] = [{ path: 'growing.ts', globalStart: 0, globalEnd: 0 }];
  const w1 = planSegmentCalls(badSeg, { start: 0, end: 1800 });
  const w2 = planSegmentCalls(badSeg, { start: 1800, end: 3537 });
  eq('窗口 1 的兜底单元：全局 0–1800', [w1.calls[0]!.globalStart, w1.calls[0]!.globalEnd], [0, 1800]);
  eq('★ 窗口 2 的兜底单元：全局 1800–3537（**不是** 0–1737）', [w2.calls[0]!.globalStart, w2.calls[0]!.globalEnd], [1800, 3537]);
  eq('★ 段内区间跟着全局走（兜底的前提：该文件承载从 0 起的整条时间轴）', [w2.calls[0]!.inFileStart, w2.calls[0]!.inFileEnd], [1800, 3537]);
  const merged = mergeWindowsPerFile([...w1.calls, ...w2.calls].map((c, i) => ({ ...c, windowIndex: i })), 1800);
  eq('★ 合并后仍是 2 块（原实现会并成 1 块 ⇒ 后半场丢失）', merged.length, 2);
  eq('两块合起来覆盖整场（不重不漏）', merged.reduce((a, m) => a + (m.globalEnd - m.globalStart), 0), 3537);
  /* 从 0 开始的单窗口必须与历史行为**逐字一致** —— 那是绝大多数场次走的路 */
  const one = planSegmentCalls(badSeg, { start: 0, end: 3537 });
  eq(
    '从 0 开始的单窗口：与历史行为逐字一致',
    [one.calls[0]!.inFileStart, one.calls[0]!.inFileEnd, one.calls[0]!.globalStart, one.calls[0]!.globalEnd],
    [0, 3537, 0, 3537],
  );
}

section('4c. ★ 同一文件的后半块要接着往下读（否则整个文件重转一遍）');
{
  /* 现场（2026-10-15，`auto-20261015141657-r1v4`）：一个 31 分钟的单文件录制，chunkMinutes=30
     ⇒ 切 2 块。第 2 块本该只读文件的 1800–1887.5 秒，却因为 mergeWindowsPerFile 把新块的
     `inFileStart` 归零而变成读 0–1887.5 秒：**整个文件又转一遍**（实测多花约一倍 GPU），
     而且界面上的"总音频"变成 1800+1887.5 = 3688 秒（31 分钟的场次显示 1 小时 1 分）。 */
  const one: MediaSegment[] = [{ path: 'single.ts', globalStart: 0, globalEnd: 1887.5 }];
  const windows = [
    { file: 'single.ts', inFileStart: 0, inFileEnd: 1800, globalStart: 0, globalEnd: 1800, offset: 0, windowIndex: 0 },
    { file: 'single.ts', inFileStart: 1800, inFileEnd: 1887.5, globalStart: 1800, globalEnd: 1887.5, offset: 0, windowIndex: 1 },
  ];
  const merged = mergeWindowsPerFile(windows, 1800);
  eq('切成 2 块（30 分钟上限）', merged.length, 2);
  eq('第 1 块：段内 0–1800', [merged[0]!.inFileStart, merged[0]!.inFileEnd], [0, 1800]);
  eq('★ 第 2 块：段内 1800–1887.5（**不是** 0–1887.5）', [merged[1]!.inFileStart, merged[1]!.inFileEnd], [1800, 1887.5]);
  eq('★ 两块合起来的音频量 = 整场时长（分母不再翻倍）', merged.reduce((a, m) => a + (m.inFileEnd - m.inFileStart), 0), 1887.5);
  eq('全局区间仍然不重不漏', merged.reduce((a, m) => a + (m.globalEnd - m.globalStart), 0), 1887.5);
  void one;
}

section('5. 跨进程可序列化（这是能搬进 worker 的关键）');
{
  const r = planSegmentCalls(SEGS, { start: 0, end: 3540 });
  eq('★ 规划结果过一遍 JSON 往返后完全不变（worker 侧重建等价）', JSON.parse(JSON.stringify(r)), JSON.parse(JSON.stringify(r)));
  eq('★ 输入 segments 本身可序列化（只有 path/数字）', JSON.parse(JSON.stringify(SEGS)), SEGS);
}

section('6. buildMediaAdapter：形状与 Transcriber 入参一致');
{
  const adapter = buildMediaAdapter(SEGS);
  eq('planCalls 委托同一套逻辑', adapter.planCalls({ start: 2000, end: 3000 }).length, 1);
  const tmp = path.join(os.tmpdir(), `mp-${Date.now()}.bin`);
  fs.writeFileSync(tmp, Buffer.alloc(1234));
  const st = adapter.fileStat(tmp);
  eq('fileStat 报出字节数', st.size, 1234);
  ok('fileStat 报出 mtime（录制还在写时它会变，缓存据此判定）', Number.isFinite(st.updatedAt) && st.updatedAt > 0, String(st.updatedAt));
  fs.rmSync(tmp, { force: true });
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
