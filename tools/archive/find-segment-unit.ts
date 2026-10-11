/**
 * 确认 biliLive-tools 的 `recorders[].segment` **单位**（秒 还是 分钟）。
 *
 * 为什么必须查清：我先前把它当成「秒」（乙主播 59s / 甲主播 300s），据此建议改成 3600；
 * 若实际单位是「分钟」，59 就是 59 分钟、300 就是 300 分钟（5 小时），
 * 那么「改成 3600」会把分段拉成 60 小时（等于永不分段），是**错误建议**。
 *
 * 手法：定位 segment 的消费点（录制器参数装配处），看它被乘了什么系数、
 * 以及传给底层时字段名叫什么（`splitSeconds` / `segmentTime` / `fileSize` …）。
 *
 * 用法：node tools/find-segment-unit.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');

/** 找「segment 被读取/传递」的代码行（排除 UI 表单与 schema 噪音） */
const lines = text.split('\n');
const hits: Array<{ i: number; s: string }> = [];
for (let i = 0; i < lines.length; i++) {
  const s = lines[i]!;
  if (!/segment/i.test(s)) continue;
  /* 只保留像"逻辑"的行：赋值、传参、乘法、单位换算 */
  if (!/(\*|splitSeconds|segmentTime|segmentSize|segment\s*[:=]|segment\s*\*|Math\.|Number\(|parseInt|\?\?)/.test(s)) continue;
  /* 排除明显的 UI/表单/schema 噪音 */
  if (/placeholder|label|tooltip|<\w|h\(|createVNode|props:|defineProps/.test(s)) continue;
  hits.push({ i, s: s.trim() });
}

console.log(`命中 ${hits.length} 行（疑似逻辑消费点）\n`);
for (const h of hits.slice(0, 40)) {
  console.log(`  ${String(h.i).padStart(7)}  ${h.s.slice(0, 150)}`);
}

/* 专门看 "60" 与 segment 同现的行 —— 秒/分换算最直接的痕迹 */
console.log('\n=== 含 segment 且含 60 的行（换算痕迹）===');
let n = 0;
for (const h of hits) {
  if (!/\b60\b/.test(h.s)) continue;
  console.log(`  ${String(h.i).padStart(7)}  ${h.s.slice(0, 150)}`);
  if (++n >= 15) break;
}
if (n === 0) console.log('  （没有）');

/* 找录播姬/内置录制器的分段字段名——这些字段名本身就说明单位 */
console.log('\n=== 底层录制器的分段字段名 ===');
for (const kw of ['splitSeconds', 'segmentTime', 'segmentSize', 'fileSize', 'splitTime', 'split_size']) {
  const c = (text.match(new RegExp(kw, 'g')) ?? []).length;
  if (c > 0) console.log(`  ${kw.padEnd(16)} 出现 ${c} 次`);
}
