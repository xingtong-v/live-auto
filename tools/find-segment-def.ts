/**
 * 精确定位 biliLive-tools 录制器 `segment` 的**默认值定义**与**消费点**，判定单位。
 *
 * 与 find-segment-unit.ts 的区别：那个按关键词全库扫（命中大量 glob / TS 分片噪音）；
 * 这个只找 `segment:` 出现在录制器配置/参数组装上下文里的位置，
 * 并把它周围的若干行一起打印，从而看出「分钟 → 秒」的换算是否存在。
 *
 * 用法：node tools/find-segment-def.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');

/** 候选上下文关键词：命中其一才认为是「录制器分段」语义 */
const CTX = /recorder|recorders|savePath|savePathFormat|channelId|quality|split|直播|录制|分段/i;

console.log('='.repeat(100));
console.log('A. `segment:` 定义/赋值点（带上下文判定）');
console.log('='.repeat(100));
const reA = /\bsegment\s*:\s*([^,\n}]{1,40})/g;
let shown = 0;
for (const m of text.matchAll(reA)) {
  const i = m.index ?? 0;
  const before = text.slice(Math.max(0, i - 400), i);
  const after = text.slice(i, i + 260);
  if (!CTX.test(before) && !CTX.test(after)) continue;
  console.log(`\n--- 偏移 ${i} 值=${m[1]!.trim()} ---`);
  console.log(before.split('\n').slice(-8).join('\n'));
  console.log('>>> ' + after.split('\n').slice(0, 6).join('\n'));
  if (++shown >= 6) break;
}
if (shown === 0) console.log('（没有命中）');

console.log('\n' + '='.repeat(100));
console.log('B. segment 被传给底层 / 参与换算的行');
console.log('='.repeat(100));
const lines = text.split('\n');
let n = 0;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i]!;
  /* 只要「读取 segment 并做运算/传参」的行，且不带 UI 特征 */
  if (!/\bsegment\b/.test(s)) continue;
  if (!/(\*\s*60|\/\s*60|\*60|\* 1e3|1000|toSeconds|minutes|seconds|splitSeconds|segmentDuration)/i.test(s)) continue;
  if (/placeholder|createVNode|defineProps|label:|tooltip/i.test(s)) continue;
  console.log(`  ${String(i).padStart(7)}  ${s.trim().slice(0, 160)}`);
  if (++n >= 25) break;
}
if (n === 0) console.log('  （没有找到换算行 —— 说明单位就是它传给底层的原值）');

console.log('\n' + '='.repeat(100));
console.log('C. 内置录制器（bililive）的分段参数名');
console.log('='.repeat(100));
for (const kw of ['splitSeconds', 'segmentSeconds', 'segmentMinute', 'splitMinute', 'split_time', 'segment_time', 'maxFileSize', 'fileSizeLimit']) {
  const c = (text.match(new RegExp(kw, 'g')) ?? []).length;
  if (c > 0) console.log(`  ${kw.padEnd(18)} 出现 ${c} 次`);
}
