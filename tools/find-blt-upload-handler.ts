/**
 * 在 biliLive-tools 的 asar 里定位**服务端路由** `/bili/upload` 的处理器，
 * 确认请求体是否支持「续传到已有稿件」（aid）。
 *
 * 与 extract-blt-source.ts 的区别：那个按关键词抓上下文；
 * 这个专门找路由注册点（形如 `app.post("/bili/upload"` 或 router 注册），
 * 并把处理器函数体整段打印出来。
 *
 * 用法：node tools/find-blt-upload-handler.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');

/** 路由注册的常见写法 */
const PATTERNS = [
  /app\.(?:post|get)\s*\(\s*["'`]\/bili\/upload["'`]/g,
  /router\.(?:post|get)\s*\(\s*["'`]\/bili\/upload["'`]/g,
  /["'`]\/bili\/upload["'`]\s*,\s*(?:async\s*)?\(/g,
  /bili\/upload["'`]/g,
];

const hits: number[] = [];
for (const re of PATTERNS) {
  for (const m of text.matchAll(re)) {
    if (m.index !== undefined) hits.push(m.index);
  }
}

console.log(`找到 ${hits.length} 个候选位置\n`);
const seen = new Set<number>();
for (const idx of hits) {
  const bucket = Math.floor(idx / 200);
  if (seen.has(bucket)) continue;
  seen.add(bucket);
  const seg = text.slice(Math.max(0, idx - 300), idx + 2200);
  console.log('='.repeat(100));
  console.log(`偏移 ${idx}`);
  console.log('='.repeat(100));
  console.log(seg.replace(/\r/g, ''));
  console.log('');
  /* 只打印前 4 段，避免刷屏 */
  if (seen.size >= 4) break;
}

/* 额外：直接搜请求体解构里出现 aid 的地方（判断 aid 是不是上传入参） */
console.log('\n' + '='.repeat(100));
console.log('请求体解构中出现 aid 的片段（`{ ... aid ... } = req.body`）');
console.log('='.repeat(100));
const reAid = /\{\s*[^}]{0,120}\baid\b[^}]{0,120}\}\s*=\s*(?:req|request)\.body/g;
let n = 0;
for (const m of text.matchAll(reAid)) {
  console.log(`  ${m[0].replace(/\s+/g, ' ').slice(0, 170)}`);
  n++;
  if (n >= 15) break;
}
if (n === 0) console.log('  （没有从 req.body 解构 aid 的地方）');
