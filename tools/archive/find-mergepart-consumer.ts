/**
 * 找 `partMergeMinute` 的**最终消费点**（决定碎片文件是否并回同一个 part）。
 *
 * 已知：
 *   getConfig() 里 `if (!mergePart) partMergeMinute = -1;`，随后随 config 一起返回；
 *   LiveManager.findRecentLive(roomId, software, maxTimeDiffMinutes, currentTime)
 *   用 `(currentTime - live.getMaxEndTime())/60000 < maxTimeDiffMinutes` 判断是否复用同一场。
 * 还需确认：谁把 config.partMergeMinute 传给 findRecentLive、以及「复用同一场」之后
 * 碎片是**同一个 part**（物理合并/同一分P）还是**同一场的多个 part**（多个分P）。
 *
 * 用法：node tools/find-mergepart-consumer.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');
const lines = text.split('\n');

/** 通用：打印包含某个正则的行及其上下文，可排除噪音 */
function show(label: string, re: RegExp, exclude: RegExp, before = 16, after = 20, max = 4): void {
  console.log('\n' + '='.repeat(100));
  console.log(label);
  console.log('='.repeat(100));
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!;
    if (!re.test(s) || exclude.test(s)) continue;
    console.log(`\n--- 行 ${i} ---`);
    console.log(lines.slice(Math.max(0, i - before), Math.min(lines.length, i + after)).join('\n'));
    if (++n >= max) return;
  }
  if (n === 0) console.log('（没有命中）');
}

show(
  'A. 调用 findRecentLive 的地方（谁传入 partMergeMinute）',
  /findRecentLive/,
  /^\s*\*\s|findRecentLive\(roomId, software, maxTimeDiffMinutes, currentTime\)/,
  18,
  30,
  3,
);

show(
  'B. 新 part 的创建点（addPart / createPart / parts.push）',
  /\.parts\.push\(|addPart\(|createPart\(|new Part\(/,
  /^\s*\/\//,
  16,
  22,
  4,
);

show(
  'C. 处理 FileClosed 后决定「新建 part or 复用」的地方',
  /mergePart|partMergeMinute/,
  /getRoomSetting|_cache\[|createVNode|placeholder|partMergeMinute:\s*10|if \(!mergePart\)/,
  18,
  26,
  4,
);
