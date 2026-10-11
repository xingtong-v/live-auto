/**
 * 找 `minSize`（最小处理体积，配置 20MB）在流程中的**生效时机**。
 *
 * 为什么关键：它决定「断流碎片」是否会被过滤掉。
 *   - 若在**分场（handleOpenEvent）之前**过滤 ⇒ 碎片不产生 part，也不影响 findRecentLive 的间隔计算
 *   - 若在之后 ⇒ 碎片已经占了 part，分场已经发生，过滤只能省掉上传
 * 本机 09-22 那场有 5 个 1MB 上下的碎片，这个区别直接决定「会不会被拆成 9 个稿件」。
 *
 * 用法：node tools/find-minsize.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');
const lines = text.split('\n');

/* 找所有 `config.minSize` / `minSize` 被比较或参与判断的行 */
console.log('='.repeat(100));
console.log('minSize 的比较/判断点');
console.log('='.repeat(100));
let n = 0;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i]!;
  if (!/minSize/.test(s)) continue;
  /* 只要参与比较/运算的，不要单纯解构或返回 */
  if (!/(<|>|<=|>=|\*|Math\.|Number\(|parseInt)/.test(s)) continue;
  if (/getRoomSetting\(/.test(s)) continue;
  console.log(`\n--- 行 ${i} ---`);
  console.log(lines.slice(Math.max(0, i - 20), Math.min(lines.length, i + 24)).join('\n'));
  if (++n >= 3) break;
}
if (n === 0) console.log('（没有找到比较点）');

/* 找「文件大小」的读取点，看它出现在处理链的哪一环 */
console.log('\n' + '='.repeat(100));
console.log('文件大小读取 / 阈值判定 相关代码');
console.log('='.repeat(100));
n = 0;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i]!;
  if (!/(removeSmallFile|fileSize|size\s*<\s*|size\s*>\s*|小于|忽略)/.test(s)) continue;
  if (/placeholder|createVNode|_cache\[|label:|tooltip/.test(s)) continue;
  if (!/minSize|removeSmallFile|MB|1048576|1e6/.test(s)) continue;
  console.log(`\n--- 行 ${i} ---`);
  console.log(lines.slice(Math.max(0, i - 14), Math.min(lines.length, i + 16)).join('\n'));
  if (++n >= 3) break;
}
if (n === 0) console.log('（没有找到）');
