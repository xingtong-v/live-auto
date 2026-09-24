/**
 * 从 biliLive-tools 的 app.asar 里提取指定路由的实现片段（只读分析，不改对方代码）。
 *
 * 用途：接口的入参形状猜不出来时，直接看它自己的实现 —— 比反复试错快且准。
 * 本工具只读取本地文件并打印片段，不发任何请求。
 *
 * 用法：
 *   node tools/asar-grep.ts /config/set
 *   node tools/asar-grep.ts "key and value is required" --ctx 900
 */
import fs from 'node:fs';

const ASAR = process.argv[2] && process.argv[2].startsWith('/') ? undefined : undefined;
const DEFAULT_ASAR = 'C:/Users/demo/Desktop/新建文件夹 (2)/biliLive-tools/resources/app.asar';
const needle = process.argv[2];
if (!needle) {
  console.error('用法：node tools/asar-grep.ts <要搜索的字符串> [--ctx N] [--max N]');
  process.exit(1);
}
const ctxIdx = process.argv.indexOf('--ctx');
const ctx = ctxIdx > 0 ? Number(process.argv[ctxIdx + 1]) : 700;
const maxIdx = process.argv.indexOf('--max');
const maxHits = maxIdx > 0 ? Number(process.argv[maxIdx + 1]) : 4;
void ASAR;

const buf = fs.readFileSync(DEFAULT_ASAR);
const s = buf.toString('latin1');

let from = 0;
let hits = 0;
while (hits < maxHits) {
  const i = s.indexOf(needle, from);
  if (i < 0) break;
  hits++;
  const a = Math.max(0, i - ctx);
  const b = Math.min(s.length, i + needle.length + ctx);
  console.log('='.repeat(100));
  console.log(`命中 #${hits} @ 偏移 ${i}`);
  console.log('='.repeat(100));
  /* 原文是压缩过的 JS，按可读性做最小换行处理：分号/大括号后断行 */
  const frag = s.slice(a, b).replace(/;/g, ';\n').replace(/\{/g, '{\n').replace(/\}/g, '\n}');
  console.log(frag);
  console.log('');
  from = i + needle.length;
}
if (hits === 0) console.log(`未找到：${needle}`);
