/**
 * 定位 biliLive-tools 的 `autoPartMerge` / `partMergeMinute` 实际逻辑：
 * 「断流碎片文件」到底会不会各自变成一个分P，还是会被并回同一个 part。
 *
 * 这直接决定两件事：
 *   1. 一场 4 小时直播最终会有几个分P（会不会因断流碎片而失控）
 *   2. 项目「分P 跨界防护」该按什么粒度对齐（按文件？还是按合并后的场？）
 *
 * 用法：node tools/find-autopartmerge.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');

/* 支持按行号区间直接打印：node tools/find-autopartmerge.ts <from> <to> */
const fromArg = Number(process.argv[2] ?? '');
const toArg = Number(process.argv[3] ?? '');
if (Number.isFinite(fromArg) && Number.isFinite(toArg) && toArg > fromArg) {
  const lines = text.split('\n');
  console.log(lines.slice(fromArg, Math.min(toArg, lines.length)).join('\n'));
  process.exit(0);
}

/** 抓 mergePart **变量的消费点**（不是配置读取，而是真正决定 part 归属的地方） */
console.log('='.repeat(100));
console.log('mergePart(s) 变量的消费点');
console.log('='.repeat(100));
const lines = text.split('\n');
let shown = 0;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i]!;
  /* 只挑"用它做判断/传参"的行，排除 getRoomSetting 读取与 UI */
  if (!/\bmergeParts?\b/.test(s)) continue;
  if (/getRoomSetting|placeholder|_cache\[|createVNode/.test(s)) continue;
  const from = Math.max(0, i - 14);
  const to = Math.min(lines.length, i + 14);
  console.log(`\n--- 行 ${i} ---`);
  console.log(lines.slice(from, to).join('\n'));
  if (++shown >= 4) break;
}
if (shown === 0) console.log('（没有找到消费点）');

/** 再找 partMergeMinute 的消费点 */
console.log('\n' + '='.repeat(100));
console.log('partMergeMinute 的消费点');
console.log('='.repeat(100));
shown = 0;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i]!;
  if (!/partMergeMinute/.test(s)) continue;
  if (/getRoomSetting|placeholder|_cache\[|createVNode|partMergeMinute:\s*10/.test(s)) continue;
  const from = Math.max(0, i - 12);
  const to = Math.min(lines.length, i + 16);
  console.log(`\n--- 行 ${i} ---`);
  console.log(lines.slice(from, to).join('\n'));
  if (++shown >= 4) break;
}
if (shown === 0) console.log('（没有找到消费点）');
