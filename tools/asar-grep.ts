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
import path from 'node:path';

/* ⚠️ 这里**不能**写死某个用户的绝对路径：本仓库要公开，`tools/sanitize-for-public.ts`
   会把真实用户名替换成 `demo`，写死的路径一脱敏就失效（实测：`C:/Users/demo/...` 找不到文件，
   工具直接 ENOENT 挂掉）。所以按顺序找：
     ① 环境变量 `BLT_ASAR`（换机器/换安装位置时用它）；
     ② 当前用户的桌面（`%USERPROFILE%\Desktop`）；
     ③ 脱敏后的 `demo` 路径（万一在别人机器上就叫 demo）。 */
function findAsar(): { file?: string; tried: string[] } {
  const tried: string[] = [];
  const env = process.env['BLT_ASAR'];
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const candidates = [
    ...(env ? [env] : []),
    ...(home ? [path.join(home, 'Desktop', '新建文件夹 (2)', 'biliLive-tools', 'resources', 'app.asar')] : []),
    'C:/Users/demo/Desktop/新建文件夹 (2)/biliLive-tools/resources/app.asar',
  ];
  for (const c of candidates) {
    tried.push(c);
    if (fs.existsSync(c)) return { file: c, tried };
  }
  return { tried };
}

const needle = process.argv[2];
if (!needle) {
  console.error('用法：node tools/asar-grep.ts <要搜索的字符串> [--ctx N] [--max N]');
  console.error('（找不到 app.asar 时用 BLT_ASAR=<路径> 指定）');
  process.exit(1);
}
const ctxIdx = process.argv.indexOf('--ctx');
const ctx = ctxIdx > 0 ? Number(process.argv[ctxIdx + 1]) : 700;
const maxIdx = process.argv.indexOf('--max');
const maxHits = maxIdx > 0 ? Number(process.argv[maxIdx + 1]) : 4;

const found = findAsar();
if (!found.file) {
  console.error('找不到 biliLive-tools 的 app.asar，试过：');
  for (const t of found.tried) console.error(`  · ${t}`);
  console.error('用 BLT_ASAR=<app.asar 路径> 再跑一次。');
  process.exit(1);
}
console.log(`（读取 ${found.file}）`);
const buf = fs.readFileSync(found.file);
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
