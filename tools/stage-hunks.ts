/**
 * 只把**我自己的 hunk** 放进暂存区（同一文件里还有另一路会话未提交的改动，整文件 add 会把它们带走）。
 *
 * 用法：node --experimental-strip-types tools/stage-hunks.ts <文件> <oldStart> [<oldStart>...]
 *   · 参数里的 oldStart 是 `git diff` 的 `@@ -<oldStart>,...` 那个数字；
 *   · 只保留命中这些 oldStart 的 hunk，其余丢弃；
 *   · 结果写进临时 patch，用 `git apply --cached --recount` 落到索引上。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [file, ...starts] = process.argv.slice(2);
if (!file || starts.length === 0) {
  console.error('用法：node tools/stage-hunks.ts <文件> <oldStart>...');
  process.exit(1);
}
const want = new Set(starts.map((s) => Number(s)));
const diff = execFileSync('git', ['diff', '--', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lines = diff.split(/\r?\n/);
const header: string[] = [];
const hunks: Array<{ start: number; lines: string[] }> = [];
let cur: { start: number; lines: string[] } | null = null;
for (const l of lines) {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
  if (m) {
    if (cur) hunks.push(cur);
    cur = { start: Number(m[1]), lines: [l] };
    continue;
  }
  if (cur) cur.lines.push(l);
  else header.push(l);
}
if (cur) hunks.push(cur);

const kept = hunks.filter((h) => want.has(h.start));
const dropped = hunks.filter((h) => !want.has(h.start));
if (kept.length === 0) {
  console.error(`没有匹配的 hunk（文件里现有 hunk 的 oldStart：${hunks.map((h) => h.start).join(', ')}）`);
  process.exit(1);
}
const out = [...header, ...kept.flatMap((h) => h.lines), ''].join('\n');
const tmp = path.join(os.tmpdir(), `stage-${Date.now()}.patch`);
fs.writeFileSync(tmp, out, 'utf8');
try {
  execFileSync('git', ['apply', '--cached', '--recount', tmp], { stdio: 'inherit' });
} finally {
  fs.rmSync(tmp, { force: true });
}
console.log(
  `已暂存 ${file} 的 ${kept.length} 个 hunk（oldStart=${kept.map((h) => h.start).join(', ')}）；` +
    `丢弃 ${dropped.length} 个（另一路会话的：${dropped.map((h) => h.start).join(', ') || '无'}）`,
);
