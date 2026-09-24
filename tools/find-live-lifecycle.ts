/**
 * 查 `Live` 何时被**结束/移除** —— 这决定「同一场直播的多个分段」会不会被误判成多场。
 *
 * 背景矛盾：
 *   09-22 那场相邻大文件间隔 59.1 / 20.8 / 22.4 分钟，都 > partMergeMinute(10)。
 *   若这些文件属于同一场直播（分段 + 断流恢复），却被判成 7 场 ⇒ 7 个稿件，那 2+n 就废了。
 *   但也可能它们本来就是不同的直播场次（主播下播又开播）—— 那就没问题。
 *
 * 判据：findRecentLive 用的是 `live.getMaxEndTime()`。如果「同一场直播的后续分段」发生时
 *   前一个 part 的 endTime 已被写入，且间隔 > 10 分钟，就会 new Live()。
 *   所以要看：part 的 endTime 何时写入、Live 何时从 liveManager 移除、
 *   以及是否有别的机制（如"下播才结束一场"）阻止这种误判。
 *
 * 用法：node tools/find-live-lifecycle.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');
const lines = text.split('\n');

function show(label: string, re: RegExp, exclude: RegExp, before = 14, after = 26, max = 3): void {
  console.log('\n' + '='.repeat(100));
  console.log(label);
  console.log('='.repeat(100));
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!;
    if (!re.test(s) || exclude.test(s)) continue;
    console.log(`\n--- 行 ${i} ---`);
    console.log(lines.slice(Math.max(0, i - before), Math.min(lines.length, i + after)).join('\n'));
    if (++n >= max) break;
  }
  if (n === 0) console.log('（没有命中）');
}

/* part 的 endTime 何时被写入 —— 决定 getMaxEndTime 会不会推进 */
show(
  'A. part.endTime / updateEndTime 的写入点',
  /endTime\s*=|updateEndTime|setEndTime|\.endTime\b/,
  /^\s*\*|getMaxEndTime\(\)\s*\{|placeholder|createVNode/,
  14,
  24,
  3,
);

/* Live 何时从管理器移除 */
show(
  'B. removeLive / live 结束 的调用点',
  /removeLive|\.endTime\s*=|closeLive|finishLive/,
  /^\s*\*|removeLive\(live\)\s*\{/,
  16,
  26,
  3,
);

/* getMaxEndTime 的实现 */
show(
  'C. getMaxEndTime 实现',
  /getMaxEndTime\s*\(\)\s*\{/,
  /^\s*\*/,
  4,
  18,
  2,
);
