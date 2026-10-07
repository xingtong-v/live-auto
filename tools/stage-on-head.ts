/**
 * 当同一文件里混着另一路会话的未提交改动、`git apply --cached` 因上下文对不上而失败时，
 * 用「取 HEAD 版本 → 只施加我自己的替换 → 写进索引」的办法精确暂存。
 *
 * 用法：node --experimental-strip-types tools/stage-on-head.ts <文件> <替换对 JSON 文件>
 *   替换对 JSON：[[oldStr, newStr], ...]
 * 结果：索引里变成 HEAD + 我的替换；工作区不动（别人的 WIP 仍在工作区）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [file, pairsFile] = process.argv.slice(2);
if (!file || !pairsFile) {
  console.error('用法：node tools/stage-on-head.ts <文件> <替换对 JSON>');
  process.exit(1);
}
const pairs = JSON.parse(fs.readFileSync(pairsFile, 'utf8')) as Array<[string, string]>;
const head = execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let out = head;
for (const [oldStr, newStr] of pairs) {
  const n = out.split(oldStr).length - 1;
  if (n !== 1) {
    console.error(`替换在 HEAD 版本里出现 ${n} 次（要求恰好 1 次）：${oldStr.slice(0, 60)}`);
    process.exit(1);
  }
  out = out.replace(oldStr, newStr);
}
const tmp = path.join(os.tmpdir(), `head-${Date.now()}-${path.basename(file)}`);
fs.writeFileSync(tmp, out, 'utf8');
const sha = execFileSync('git', ['hash-object', '-w', tmp], { encoding: 'utf8' }).trim();
execFileSync('git', ['update-index', '--cacheinfo', `100644,${sha},${file}`], { stdio: 'inherit' });
fs.rmSync(tmp, { force: true });
console.log(`已把「HEAD + ${pairs.length} 处替换」写进索引：${file}（blob ${sha.slice(0, 10)}）`);
