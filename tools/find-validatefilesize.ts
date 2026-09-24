/**
 * 找 `validateFileSize` 的调用点 —— 确认「小于 minSize 的碎片」在流程中的位置。
 *
 * 这决定我们先前那个模拟（09-22 拆成 9 场）是否成立：
 *   · 若 validateFileSize 在**建 part / 分场之前**返回 false 并中断 ⇒ 碎片的 part 被跳过，
 *     但它**仍然可能已经被 handleOpenEvent 记入**（FileOpening 先到），需要看代码顺序；
 *   · 更关键：minSize 过滤发生在**上传前**，那么 1MB 碎片虽占 part，却会被标成 skip 而不上传。
 *
 * 用法：node tools/find-validatefilesize.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');
const lines = text.split('\n');

console.log('='.repeat(100));
console.log('validateFileSize 的调用点');
console.log('='.repeat(100));
let n = 0;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i]!;
  if (!/validateFileSize/.test(s)) continue;
  if (/^\s*\*|async validateFileSize/.test(s)) continue;
  console.log(`\n--- 行 ${i} ---`);
  console.log(lines.slice(Math.max(0, i - 34), Math.min(lines.length, i + 12)).join('\n'));
  if (++n >= 2) break;
}
if (n === 0) console.log('（没有找到调用点）');

/* 找 FileClosed 的处理入口，看整体顺序 */
console.log('\n' + '='.repeat(100));
console.log('FileClosed 处理入口（整体顺序）');
console.log('='.repeat(100));
n = 0;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i]!;
  if (!/async handleFileClosed|handleCloseEvent|onFileClosed|processEvent\s*=/.test(s)) continue;
  console.log(`\n--- 行 ${i} ---`);
  console.log(lines.slice(Math.max(0, i - 6), Math.min(lines.length, i + 40)).join('\n'));
  if (++n >= 2) break;
}
if (n === 0) console.log('（没有找到）');
