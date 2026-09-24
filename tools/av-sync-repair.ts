/**
 * 批量检查/修复已有成片的音画错位。
 *
 * 用途：新切片会自动修（切完就修），但**已经切好/已经投稿过的成片**不会自己变好。
 * 这个工具把存量成片扫一遍：默认只报告，加 --apply 才真的重挂修复。
 *
 * 注意：B站上已经投稿的视频改不了 —— 修好本地文件后需要自己决定是否删掉重投。
 *
 * 用法：
 *   node tools/av-sync-repair.ts                 # 只检查 data/clips
 *   node tools/av-sync-repair.ts --apply         # 检查并修复
 *   node tools/av-sync-repair.ts --dir data/xxx  # 指定目录
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureAvSync, probeStreamStarts } from '../src/av-sync.ts';
import { log } from '../src/logger.ts';
import { ROOT_DIR } from '../src/util.ts';

const apply = process.argv.includes('--apply');
const dirArgIdx = process.argv.indexOf('--dir');
const roots = dirArgIdx >= 0 && process.argv[dirArgIdx + 1]
  ? [path.resolve(process.argv[dirArgIdx + 1]!)]
  : [path.join(ROOT_DIR, 'data', 'clips')];

function collect(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 3 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, out, depth + 1);
    else if (/\.(mp4|mkv)$/i.test(e.name) && !e.name.endsWith('.avsync.mp4')) out.push(full);
  }
  return out;
}

const files = roots.flatMap((r) => collect(r));
console.log(`\x1b[1m成片音画检查\x1b[0m  ${apply ? '\x1b[33m（--apply：会真的修复）\x1b[0m' : '（仅报告，加 --apply 才修复）'}`);
console.log(`目录：${roots.map((r) => path.relative(ROOT_DIR, r)).join(' , ')}  共 ${files.length} 个文件\n`);

let bad = 0;
let fixed = 0;
let failed = 0;
for (const f of files) {
  const rel = path.relative(ROOT_DIR, f);
  const before = await probeStreamStarts(f);
  const d = (before.videoStart ?? 0) - (before.audioStart ?? 0);
  if (Math.abs(d) <= 0.15) {
    console.log(`  \x1b[32m✓\x1b[0m Δ=${d.toFixed(3)}s  ${rel}`);
    continue;
  }
  bad++;
  console.log(`  \x1b[31m✗\x1b[0m Δ=${d.toFixed(3)}s  ${rel}`);
  if (!apply) continue;
  const r = await ensureAvSync(f, { toleranceSec: 0.15, logger: log });
  if (r.repaired) {
    fixed++;
    console.log(`      \x1b[32m已修复 → Δ=${r.deltaAfterSec?.toFixed(3)}s\x1b[0m`);
  } else {
    failed++;
    console.log(`      \x1b[31m修复失败：${r.warning ?? '未知原因'}\x1b[0m`);
  }
}
console.log(
  `\n合计 ${files.length} 个：错位 ${bad} 个，${apply ? `已修复 ${fixed} 个，失败 ${failed} 个` : '（未修改任何文件）'}`,
);
if (bad > 0 && !apply) console.log('加 --apply 执行修复。注意：B站上已投稿的视频不会被改动，需要自己决定是否删掉重投。');
