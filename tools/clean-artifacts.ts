/**
 * 清理验证/调试产物 CLI（P2）。实现已抽到 src/clean-artifacts.ts —— 守护进程的每日 tick 调**同一份**，
 * 避免"CLI 与定时任务各写一套清理逻辑"（备份那次踩过同一个坑）。
 *
 * 用法：npm run clean:artifacts [-- --apply] [-- --days 14]
 */
import { runArtifactCleanup, summarizeCleanup } from '../src/clean-artifacts.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const di = args.indexOf('--days');
const keepDays = di >= 0 ? Math.max(0, Number(args[di + 1]) || 7) : 7;

const r = runArtifactCleanup({ keepDays, dryRun: !apply });
for (const [d, g] of Object.entries(r.byTarget)) console.log(`  ${d.padEnd(18)} ${String(g.n).padStart(4)} 个文件  ${(g.b / 1024 ** 2).toFixed(1).padStart(8)} MB`);
console.log(summarizeCleanup(r));
if (!apply) console.log('\n  这是 dry-run。确认后加 --apply 真删。');
process.exitCode = r.error ? 1 : 0;
