/**
 * 精确提取 `SAME_MEDIA_UPLOAD_ORDER` 的**定义**（不是使用处）。
 *
 * 它决定 biliLive-tools 在「uploadNoDanmu + uploadToSameMedia」模式下的分P顺序：
 * 若 `["handled","raw"]` ⇒ 所有弹幕版在前、纯享版在后；
 * 若逐段交替 ⇒ 弹幕版1/纯享版1/弹幕版2/纯享版2。
 * 这直接决定 4 小时分 4 段时的最终排序，必须看准。
 *
 * 用法：node tools/find-same-media-order.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');

/* 定义形态可能有多种：const/let/var、对象属性、或 "handled"/"raw" 的写死数组 */
const PATTERNS: Array<[string, RegExp]> = [
  ['const/let/var 定义', /(?:const|let|var)\s+SAME_MEDIA_UPLOAD_ORDER\s*=\s*[^;]{0,120}/g],
  ['直接赋值', /SAME_MEDIA_UPLOAD_ORDER\s*=\s*\[[^\]]{0,80}\]/g],
  ['handled/raw 数组', /\[[^\]]{0,40}["'`]handled["'`][^\]]{0,40}["'`]raw["'`][^\]]{0,40}\]/g],
  ['raw/handled 数组', /\[[^\]]{0,40}["'`]raw["'`][^\]]{0,40}["'`]handled["'`][^\]]{0,40}\]/g],
];

for (const [label, re] of PATTERNS) {
  const hits = [...text.matchAll(re)];
  console.log(`\n=== ${label}：${hits.length} 处 ===`);
  for (const m of hits.slice(0, 8)) {
    console.log(`  offset ${m.index}: ${m[0].replace(/\s+/g, ' ').slice(0, 150)}`);
  }
}

/* 同时把 include 语句也找出来（可能从别的模块 import） */
console.log('\n=== 可能的来源（import/export 语句）===');
for (const m of text.matchAll(/[^\n]{0,120}SAME_MEDIA_UPLOAD_ORDER[^\n]{0,80}/g)) {
  const s = m[0].trim();
  if (/import|export|require/.test(s)) console.log(`  ${s.slice(0, 170)}`);
}
