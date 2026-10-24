/**
 * 投稿批次账（`src/publish-batches.ts`）——2026-10-11，优化第一批 P1-1「投稿确认的单一事实源」。
 *
 * 锁四件事：
 *   ① 提交/结果行的读写（同一 uploadTaskId 多行 → 以最后一行为准）；
 *   ② `readOpenBatches` 只吐"还没落地、也没失败"的批次（反查要盯的就是这些）；
 *   ③ 批次行不会污染既有流水：`publish-audit` 与「本场已有 N 次投稿」都只看 submit/confirm/fail；
 *   ④ 一次投稿的多个分P 共用一个 uploadTaskId ⇒ 批次天然是"一次上传"的粒度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { batchAgeMinutes, findDuplicateTitles, pruneBatchRows, readBatches, readOpenBatches, readRecentDuplicateParts, recordBatchOutcome, recordBatchSubmit, recordDuplicateParts } from '../src/publish-batches.ts';
import { readJsonl } from '../src/util.ts';
import { ROOT_DIR } from '../src/util.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(title: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${title}`);
  } else {
    fail++;
    failures.push(`${title}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${title}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(title: string, got: unknown, want: unknown): void {
  ok(title, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-batch-'));
const logPath = path.join(dir, 'publish-log.jsonl');
const T = 'auto-20261011010000-aaaa';

section('1. 记一次提交 + 逐片流水（两者写同一份文件，互不干扰）');
{
  recordBatchSubmit(
    {
      taskId: T,
      uploadTaskId: 'up-1',
      kind: 'append',
      aid: '117416973566248',
      bvid: 'BV1oWpG69Etu',
      titles: ['切片甲', '切片乙', '切片丙'],
      clipIndices: [0, 1, 2],
    },
    { logPath },
  );
  /* 老流水照旧（submit 逐片） —— 批次账必须与它共存，不能把 publish-audit 的输入搞乱 */
  fs.appendFileSync(logPath, `${JSON.stringify({ taskId: T, clipIndex: 0, action: 'submit', uploadTaskId: 'up-1', title: '切片甲' })}\n`, 'utf8');

  const all = readBatches(T, { logPath });
  eq('读到一个批次', all.length, 1);
  eq('批次身份就是 uploadTaskId', all[0]?.uploadTaskId, 'up-1');
  eq('记录了这批本该产生的 3 个分P', all[0]?.titles.length, 3);
  eq('记录了对应的切片序号', all[0]?.clipIndices, [0, 1, 2]);
  eq('带着目标稿件（续传）', [all[0]?.aid, all[0]?.bvid], ['117416973566248', 'BV1oWpG69Etu']);
  eq('刚提交时状态是 submitted', all[0]?.status, 'submitted');
  eq('它就是"未结批次"（反查要盯的）', readOpenBatches(T, { logPath }).length, 1);
}

section('2. 结果行覆盖状态：落地 / 部分缺失 / 失败');
{
  recordBatchOutcome({ taskId: T, uploadTaskId: 'up-1', kind: 'append', status: 'unconfirmed', missing: ['切片甲', '切片乙', '切片丙'], note: 'biliLive-tools 侧任务已完成' }, { logPath });
  eq('未确认 ⇒ 仍在未结列表里（要继续盯）', readOpenBatches(T, { logPath }).length, 1);
  eq('未确认的原因被记下', readBatches(T, { logPath })[0]?.note, 'biliLive-tools 侧任务已完成');

  recordBatchOutcome({ taskId: T, uploadTaskId: 'up-1', kind: 'append', status: 'landed', landed: ['切片甲', '切片乙', '切片丙'] }, { logPath });
  eq('落地 ⇒ 从未结列表里移出', readOpenBatches(T, { logPath }).length, 0);
  eq('状态是 landed', readBatches(T, { logPath })[0]?.status, 'landed');
  eq('以最后一行为准（同 id 多行归并成一条）', readBatches(T, { logPath }).length, 1);

  recordBatchSubmit({ taskId: T, uploadTaskId: 'up-2', kind: 'append', aid: '117', bvid: 'BV1oWpG69Etu', titles: ['切片丁'], clipIndices: [3] }, { logPath });
  recordBatchOutcome({ taskId: T, uploadTaskId: 'up-2', kind: 'append', status: 'failed', missing: ['切片丁'], note: '稿件已被锁定' }, { logPath });
  eq('失败的批次不进未结列表（失败要人处理，不是等）', readOpenBatches(T, { logPath }).length, 0);
  eq('失败原因留着（事后可查）', readBatches(T, { logPath }).find((b) => b.uploadTaskId === 'up-2')?.note, '稿件已被锁定');

  recordBatchSubmit({ taskId: 'auto-other-bbbb', uploadTaskId: 'up-3', kind: 'create', titles: ['别的场次'], clipIndices: [0] }, { logPath });
  eq('按任务过滤：up-3 属于另一场，不混进来', readBatches(T, { logPath }).length, 2);
  eq('另一场的批次自己能读到', readOpenBatches('auto-other-bbbb', { logPath }).length, 1);
}

section('3. 批次年龄与清理');
{
  /* ⚠️ up-3 属于**另一场**（auto-other-bbbb），必须按它自己的 taskId 取 —— 第一版按 T 取，
     拿到 undefined 直接崩在 batchAgeMinutes 里（测试自己的错，不是实现的错）。 */
  const b = readBatches('auto-other-bbbb', { logPath })[0]!;
  ok('刚写的批次年龄 < 2 分钟', batchAgeMinutes(b) < 2, String(batchAgeMinutes(b)));
  ok('年龄可以按给定时间算（同一份数据、不同时刻）', batchAgeMinutes(b, Date.parse(b.at) + 90 * 60_000) === 90, String(batchAgeMinutes(b, Date.parse(b.at) + 90 * 60_000)));

  const kept = pruneBatchRows({ logPath });
  eq('清理后只剩逐片流水那一行', kept, 1);
  eq('批次行清干净了', readBatches(T, { logPath }).length, 0);
  eq('逐片流水没被动（publish-audit 的输入还在）', readJsonl<{ action?: string }>(logPath).filter((r) => r.action === 'submit').length, 1);
}

section('3b. 重复分P 检测（2026-10-11 优化第二批 ①）');
{
  eq('规范化后同名的分P 被认出来（去空白）', findDuplicateTitles(['切片甲', '切片 甲', '切片乙']), [{ title: '切片甲', count: 2 }]);
  eq('没有重复就是空数组', findDuplicateTitles(['甲', '乙']), []);
  eq('三份也算（次数如实报）', findDuplicateTitles(['甲', '甲', '甲'])[0]?.count, 3);
  const dupLog = path.join(dir, 'dup.jsonl');
  ok('第一次发现会写记录', recordDuplicateParts({ bvid: 'BV1DUP00001', titles: ['切片甲（2 份）'] }, { logPath: dupLog }) === true);
  ok('★ 重复集合没变就**不再写**（否则每 5 分钟一轮反查会刷爆日志）', recordDuplicateParts({ bvid: 'BV1DUP00001', titles: ['切片甲（2 份）'] }, { logPath: dupLog }) === false);
  eq('读回来能拿到（供待办展示）', readRecentDuplicateParts({ logPath: dupLog }).get('BV1DUP00001')?.titles, ['切片甲（2 份）']);
}

section('4. 接线静态核对（防止以后把批次账摘掉）');
{
  const src = fs.readFileSync(path.join(ROOT_DIR, 'src', 'publish.ts'), 'utf8');
  ok('提交成功后就记批次', /recordBatchSubmit\(\{[\s\S]{0,400}uploadTaskId: res\.taskId/.test(src));
  ok('落地确认通过 ⇒ 批次标 landed', /status: 'landed',[\s\S]{0,200}landed: titled\.map/.test(src));
  /* `note` 末尾现在还可能带「（限流重试 N 次仍失败）」（2026-10-17 限流修复），
     所以只匹配到 `${why}` 为止 —— 断言意图是"失败原因写全了"，不是"格式一字不差" */
  ok('biliLive-tools 报错 ⇒ 批次标 failed（不是含糊成待确认）', /status: 'failed',[\s\S]{0,300}note: `\$\{stateText\}，错误：\$\{why\}/.test(src));
  ok('未确认 ⇒ 批次标 unconfirmed 并记下缺失标题', /status: 'unconfirmed',[\s\S]{0,300}missing: titled\.map/.test(src));
  /* 2026-10-21：`readOpenBatches` 现在还要带 logPath（见下面那条新断言），
     所以这里只认「按 taskId 读未结批次」这个意图，不再卡死参数列表。 */
  ok('反查里按批次对账（读未结批次 + 写结论）', /readOpenBatches\(taskId[,)]/.test(src) && /batchNotes\.push/.test(src));
  /* ★ 2026-10-21 QA 实测的隔离漏洞：`recordBatchSubmit/Outcome`、`readOpenBatches` 不传 `logPath`
     时会落到 `DATA_DIR/publish-log.jsonl`，也就是**生产日志** —— 内建测试跑一遍就往生产日志里写
     `batch-submit`/`batch-landed` 行（实测多 2 行，taskId 还是测试的）。所以每个调用点都必须带上
     `this.batchLog()`（它 = `ledger.publishLogPath`，跟着台账目录走）。
     用"调用点数 == 带 logPath 数"来钉，以后新增调用点漏传就会红。 */
  const callSites = [...src.matchAll(/recordBatch(?:Submit|Outcome)\(|readOpenBatches\(/g)].length;
  const withLogPath = [...src.matchAll(/this\.batchLog\(\)/g)].length;
  ok(
    '★ 每个批次账调用点都传了台账目录下的 logPath（否则测试会写进生产 publish-log）',
    callSites > 0 && withLogPath === callSites,
    `调用点 ${callSites} 个，带 logPath ${withLogPath} 个`,
  );
  ok('批次行不参与「本场已有 N 次投稿」提醒（那条只看 submit）', /filter\(\(r\) => r\['taskId'\] === task\.id && r\['action'\] === 'submit'\)/.test(src));
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail === 0 ? 0 : 1;
