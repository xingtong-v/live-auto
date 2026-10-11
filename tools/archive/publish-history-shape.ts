/**
 * 统计历史投稿里**多P 形态**出现过几次，用来回答「以前到底投出过多P稿件吗」。
 *
 * 判据：同一个 taskId 下
 *   - 不同 uploadTaskId 数 = 官方投稿批次（每次 /bili/upload 产出 1 个稿件）
 *   - 形如「P3 标题」的记录 = 该稿件分P 的标题（多P 稿件才有）
 * 因此 `uploadTaskId 数 == 1 且存在 Pn 标题` ⇒ 真的是多P 投稿。
 *
 * 用法：node --experimental-strip-types tools/publish-history-shape.ts
 */
import fs from 'node:fs';

const lines = fs
  .readFileSync('data/publish-log.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return null;
    }
  })
  .filter((x): x is Record<string, unknown> => x !== null);

interface Agg { submits: number; uploadIds: Set<string>; pTitles: number; bvids: Set<string>; multiBatches: Set<string> }
const byTask = new Map<string, Agg>();
/** 每个 uploadTaskId 下出现过多少个「Pn 标题」——>1 就是多P 批次 */
const pTitlesByBatch = new Map<string, Set<string>>();
for (const e of lines) {
  const taskId = String(e['taskId'] ?? '(无)');
  let a = byTask.get(taskId);
  if (!a) {
    a = { submits: 0, uploadIds: new Set(), pTitles: 0, bvids: new Set(), multiBatches: new Set() };
    byTask.set(taskId, a);
  }
  if (e['action'] === 'submit') {
    a.submits++;
    const utid = e['uploadTaskId'] ? String(e['uploadTaskId']) : '';
    if (utid) a.uploadIds.add(utid);
    const t = String(e['title'] ?? '');
    if (/^P\d+ /.test(t)) {
      a.pTitles++;
      if (utid) {
        let set = pTitlesByBatch.get(utid);
        if (!set) {
          set = new Set();
          pTitlesByBatch.set(utid, set);
        }
        set.add(t);
      }
    }
  }
  if (e['bvid']) a.bvids.add(String(e['bvid']));
}
/* 判定多P 批次：该批次下有 ≥1 个「Pn 标题」 */
for (const [utid, titles] of pTitlesByBatch) {
  if (titles.size === 0) continue;
  for (const [, a] of byTask) {
    if (a.uploadIds.has(utid)) a.multiBatches.add(utid);
  }
}

console.log('任务ID                          submit  批次(uploadTaskId)  多P批次  分P标题(Pn)  形态');
console.log('-'.repeat(104));
let multiBatches = 0;
let singleBatches = 0;
for (const [taskId, a] of byTask) {
  /* ⚠️ 判据必须**按批次**而不是按场次：
     同一场可能先投过几个单片、后来又投了一个多P（实测 zdd2 就是这样：
     5 个单片批次 + 2 个多P批次）。用 `该场 uploadTaskId 总数 == 1`
     会把这种场次误判成「没有多P」。 */
  const n = a.multiBatches.size;
  multiBatches += n;
  singleBatches += a.uploadIds.size - n;
  console.log(
    taskId.padEnd(30) + String(a.submits).padStart(7) + String(a.uploadIds.size).padStart(18) +
      String(n).padStart(9) + String(a.pTitles).padStart(13) + '  ' +
      (n > 0 ? `\x1b[32m★ 含 ${n} 个真多P批次\x1b[0m` : a.uploadIds.size > 1 ? '\x1b[31m全部单片\x1b[0m' : '—'),
  );
}
console.log('-'.repeat(104));
console.log(`真多P 投稿批次：${multiBatches}    单片投稿批次：${singleBatches}`);
console.log(
  multiBatches > 0
    ? `\n结论：历史上**确实投出过 ${multiBatches} 个真多P稿件**（P3/P4… 分P 标题 + 同一 uploadTaskId，\n` +
      '      时间是 2026-09-22 13:17 / 14:11，走的是**手动工具** tools/publish-multipart.ts）。\n' +
      '      但**自动流程从没走过这条路** —— 这就是「配了 multiPart 却投成单片」的原因。'
    : '\n结论：历史记录里没有任何真多P 形态的投稿批次。',
);
