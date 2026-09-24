/**
 * 用**真实录制文件**推演 `partMergeMinute`（默认 10 分钟）会把一场直播切成几"场"。
 *
 * 依据（biliLive-tools 源码 handleMatchedPair / handleOpenEvent）：
 *   async handleMatchedPair(pair) {
 *     if (!await this.validateFileSize(config2, pair.close)) { warn; return; }  // ① 先按 minSize 过滤
 *     this.handleOpenEvent(pair.open, config2.partMergeMinute);                 // ② 再分场
 *     ...
 *   }
 *   findRecentLive(...) → (timestamp - live.getMaxEndTime())/60000 < partMergeMinute 则复用同一场
 *
 * ⚠️ 关键：**minSize 过滤在分场之前**。小于 minSize（配置 20MB）的碎片既不建 part、
 *    也不参与间隔计算，所以它们**不会**把一场直播劈成多个稿件。
 *    第一版模拟忽略了这一点，把 1MB 碎片也算进去，得出"拆成 9 场"的错误结论。
 *
 * 用法：node --experimental-strip-types tools/simulate-partmerge.ts [minSizeMB] [阈值分钟...]
 */
import fs from 'node:fs';
import path from 'node:path';

const WATCH = 'C:\\Users\\demo\\Downloads\\Bilibili';
const args = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const MIN_SIZE_MB = args[0] ?? 20;
const LIST = args.length > 1 ? args.slice(1) : [10, 15, 30, 59, 90];

function parseStamp(fileName: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})-(\d{3})/.exec(fileName);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
}

for (const sub of fs.readdirSync(WATCH, { withFileTypes: true })) {
  if (!sub.isDirectory()) continue;
  const dir = path.join(WATCH, sub.name);
  const allFiles = fs
    .readdirSync(dir)
    .filter((f) => /\.(flv|mp4|ts|mkv)$/i.test(f) && !/-弹幕版|-纯享版/.test(f))
    .map((f) => ({ f, t: parseStamp(f), size: fs.statSync(path.join(dir, f)).size }))
    .filter((x): x is { f: string; t: Date; size: number } => x.t !== null)
    .sort((a, b) => a.t.getTime() - b.t.getTime());
  /* ★ 先按 minSize 过滤 —— 与 biliLive-tools 的 handleMatchedPair 同序 */
  const files = allFiles.filter((x) => x.size / 1048576 >= MIN_SIZE_MB);
  const dropped = allFiles.length - files.length;
  if (files.length < 2) continue;

  /* 按天分组：不同天的肯定不同场 */
  const byDay = new Map<string, Array<{ f: string; t: Date; size: number }>>();
  for (const x of files) {
    const day = `${x.t.getFullYear()}-${x.t.getMonth() + 1}-${x.t.getDate()}`;
    const arr = byDay.get(day) ?? [];
    arr.push(x);
    byDay.set(day, arr);
  }

  console.log('\n' + '='.repeat(98));
  console.log(
    `${sub.name}：${allFiles.length} 个文件，按 minSize=${MIN_SIZE_MB}MB 过滤掉 ${dropped} 个碎片，` +
      `剩 ${files.length} 个参与分场；跨 ${byDay.size} 天`,
  );
  console.log('='.repeat(98));

  for (const [day, arr] of [...byDay.entries()].sort()) {
    if (arr.length < 2) continue;
    console.log(`\n  【${day}】${arr.length} 个文件`);
    const gaps: number[] = [];
    for (let i = 1; i < arr.length; i++) {
      const gap = (arr[i]!.t.getTime() - arr[i - 1]!.t.getTime()) / 60000;
      gaps.push(gap);
      const mb = arr[i]!.size / 1048576;
      const flag = gap > 10 ? '  \x1b[33m← >10 分钟（默认阈值下会另起一场/稿件）\x1b[0m' : '';
      console.log(
        `      ${arr[i - 1]!.t.toTimeString().slice(0, 8)} → ${arr[i]!.t.toTimeString().slice(0, 8)}` +
          `  间隔 ${gap.toFixed(1).padStart(7)} 分钟   新文件 ${mb.toFixed(0).padStart(5)} MB${flag}`,
      );
    }
    console.log('      ' + '-'.repeat(70));
    for (const th of LIST) {
      const splitCount = gaps.filter((g) => g > th).length;
      const liveCount = splitCount + 1;
      const verdict =
        liveCount === 1
          ? '\x1b[32m1 场 = 1 个稿件 ✓\x1b[0m'
          : `\x1b[31m${liveCount} 场 ⇒ ${liveCount} 个稿件（碎片被劈开）\x1b[0m`;
      console.log(`      阈值 ${String(th).padStart(3)} 分钟 → 拆成 ${liveCount} 场   ${verdict}`);
    }
  }
}

console.log('\n' + '='.repeat(98));
console.log('判读');
console.log('='.repeat(98));
console.log('  · 分段（59 分钟一段）**不会**劈场：分段文件是同一场内的多个 part（即多个分P）');
console.log('  · 只有「相邻文件间隔 > partMergeMinute」才会劈场 —— 那意味着 biliLive-tools 认为是两场直播');
console.log('  · 因此断流恢复如果超过阈值，同一场直播会被拆成两个稿件（2+n 结构被破坏）');
