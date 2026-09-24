/**
 * 盯着一个任务跑完：轮询 /api/task/:id，把阶段时间线、切片数、状态变化打出来。
 *
 * 用法：node --experimental-strip-types tools/watch-task.ts <taskId> [timeoutMin]
 */
import fs from 'node:fs';

const taskId = process.argv[2] ?? fs.readFileSync('data/local-asr-test/trial-task-id.txt', 'utf8').trim();
const timeoutMin = Number(process.argv[3] ?? 90);
const BASE = 'http://127.0.0.1:3000';

interface TimelineItem { at: string; step: string; ok: boolean; model?: string; detail?: string; elapsedMs?: number }
interface ClipRec { index: number; title?: string; start?: number; end?: number; score?: number; selected?: boolean; publishedBvid?: string; cutOutput?: string; status?: string }
interface TaskDetail {
  id: string;
  status: string;
  title?: string;
  source?: { totalDuration?: number };
  durationSec?: number;
  clips?: ClipRec[];
  timeline?: TimelineItem[];
  cost?: { asr?: number; llm?: number; total?: number };
  error?: string;
}

const t0 = Date.now();
let lastStatus = '';
const seen = new Set<string>();

const show = (t: TaskDetail): void => {
  const dur = t.source?.totalDuration ?? 0;
  console.log(
    `\n[${new Date().toISOString().slice(11, 19)}] status=\x1b[1m${t.status}\x1b[0m  ` +
      `素材 ${(dur / 60).toFixed(1)} 分钟  ${(t.clips ?? []).length} 个切片` +
      (t.cost ? `  累计费用 ¥${(t.cost.total ?? 0).toFixed(4)}` : ''),
  );
  for (const it of t.timeline ?? []) {
    const key = `${it.at}|${it.step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mark = it.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const model = it.model ? ` \x1b[90m[${it.model}]\x1b[0m` : '';
    const ms = it.elapsedMs ? ` \x1b[90m${(it.elapsedMs / 1000).toFixed(1)}s\x1b[0m` : '';
    console.log(`   ${mark} ${it.step}${model}${ms}`);
    if (it.detail) console.log(`      \x1b[90m${it.detail.slice(0, 200)}\x1b[0m`);
  }
};

console.log(`监控任务 ${taskId}（最长 ${timeoutMin} 分钟）`);
let done = false;
while (!done && (Date.now() - t0) / 60000 < timeoutMin) {
  try {
    const res = await fetch(`${BASE}/api/task/${taskId}`);
    if (res.status !== 200) {
      console.log(`  查询失败 HTTP ${res.status}`);
    } else {
      const t = (await res.json()) as TaskDetail;
      if (t.status !== lastStatus || (t.timeline ?? []).length > seen.size) {
        lastStatus = t.status;
        show(t);
      }

      /* 判定是否真的"还在跑"。
         ⚠️ 不能只等 PUBLISHED/FAILED —— 实测踩过：
         每日额度把这一批截断时（勾选 14 个、只有 9 个有产出），任务会**合理地**
         停在 CLIPPED（因为确实还有切片等后续），但本轮的投稿动作已经全部做完。
         旧脚本因此死等到超时，误报"任务仍在跑"。
         正确判据：所有**有切片产物**的切片都已有终局状态（SUBMITTED/PUBLISHED/FAILED）
         ⇒ 本轮结束（剩余的是额度问题，不是流程没走完）。 */
      const clips = t.clips ?? [];
      const withOutput = clips.filter((c) => c.selected && c.cutOutput);
      const settled = withOutput.filter((c) => ['SUBMITTED', 'PUBLISHED', 'FAILED'].includes(String(c.status)));
      const roundFinished = withOutput.length > 0 && settled.length >= withOutput.length;

      if (['PUBLISHED', 'FAILED'].includes(t.status) || (t.status === 'CLIPPED' && roundFinished)) {
        const quotaPending = clips.filter((c) => c.selected && !c.cutOutput).length;
        console.log(
          `\n\x1b[1m本轮结束：${t.status}\x1b[0m` +
            (t.status === 'CLIPPED'
              ? `（已投 ${settled.length} 个；另有 ${quotaPending} 个勾选切片无产出文件 —— 多为每日额度截断，非流程卡住）`
              : ''),
        );
        if (t.error) console.log(`\x1b[31m错误：${t.error}\x1b[0m`);
        console.log('\n最终切片：');
        for (const c of clips) {
          console.log(
            `  #${String(c.index).padStart(2)}  ${String(c.start?.toFixed(0)).padStart(6)}-${String(c.end?.toFixed(0)).padStart(6)}s  ` +
              `score=${String(c.score ?? '-').padEnd(4)} ${String(c.status ?? '-').padEnd(10)} ` +
              `sel=${c.selected ? 'Y' : 'N'}  bvid=${c.publishedBvid ?? '-'}  ${c.title ?? ''}`,
          );
        }
        done = true;
      }
    }
  } catch (e) {
    console.log(`  查询异常：${(e as Error).message.slice(0, 80)}`);
  }
  if (!done) await new Promise((r) => setTimeout(r, 20000));
}
if (!done) console.log(`\n监控超时（${timeoutMin} 分钟）—— 任务仍在跑，可重新执行本脚本继续看`);
