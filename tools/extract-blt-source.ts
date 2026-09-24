/**
 * 从 biliLive-tools 的 app.asar（Electron 打包）里提取关键实现的上下文，
 * 用来确定性回答两个问题：
 *   1. `POST /bili/upload` 的请求体里有没有「续传到已有稿件」的字段（aid）
 *   2. `uploadToSameMedia` 到底是什么意思（同一稿件？同一分P？）
 *
 * asar 是未压缩归档，直接按 UTF-8 解码即可搜到其中的 JS 源码文本。
 * 只读，不写任何文件。
 *
 * 用法：node tools/extract-blt-source.ts <关键词> [上下文长度]
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const kw = process.argv[2] ?? '/bili/upload';
const around = Number(process.argv[3] ?? 1400);

const text = fs.readFileSync(ASAR).toString('utf8');
console.log(`asar 文本 ${(text.length / 1048576).toFixed(1)} MB`);

const idxs: number[] = [];
let from = 0;
for (;;) {
  const i = text.indexOf(kw, from);
  if (i < 0) break;
  idxs.push(i);
  from = i + kw.length;
}
console.log(`关键词「${kw}」命中 ${idxs.length} 处\n`);

for (const i of idxs.slice(0, 6)) {
  const start = Math.max(0, i - around);
  const end = Math.min(text.length, i + around);
  console.log('='.repeat(100));
  console.log(`偏移 ${i}`);
  console.log('='.repeat(100));
  const seg = text.slice(start, end).replace(/\r/g, '');
  console.log(seg);
  console.log('');
}
