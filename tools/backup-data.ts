/**
 * 数据备份 CLI（P0-2）。实现已抽到 src/backup.ts —— 守护进程的每日 tick 调**同一份**，
 * 避免"CLI 与定时任务各写一套备份逻辑"。
 *
 * 用法：npm run backup:data [-- --keep 30] [-- --dry-run]
 */
import { runDataBackup, summarizeBackup } from '../src/backup.ts';

const args = process.argv.slice(2);
const keepIdx = args.indexOf('--keep');
const keep = keepIdx >= 0 ? Math.max(1, Number(args[keepIdx + 1]) || 14) : 14;
const dryRun = args.includes('--dry-run');

const r = runDataBackup({ keep, dryRun });
for (const f of r.files) console.log(`  ${f.name.padEnd(22)} ${(f.size / 1024).toFixed(1).padStart(9)} KB  sha256:${f.sha}`);
for (const s of r.skippedLarge) console.log(`  跳过（超过 32 MB，媒体类不备份）：${s}`);
console.log(summarizeBackup(r));
for (const x of r.rotated) console.log(`  轮转删除旧备份：${x}`);
process.exitCode = r.error ? 1 : 0;
