/**
 * 每场复盘报告（`GET /api/task/:id/recap`）——2026-10-11 优化第三批 ⑧。
 *
 * 以前回答"这场产出如何"要自己拼三个页面的数字。这个端点把一场所需的汇总一次给全。
 * 套件锁住它的**口径**（数字必须来自台账/表现数据本身，不能是页面自己另算一套）：
 *   ① 切片按状态计数 + 评分分布（均/最小/最大）与最佳三条；
 *   ② 投稿批次汇总（投了几次、落地几次、失败几次、共缺几个分P）；
 *   ③ 表现按 bvid 取**最新一行**合计（与「稿件表现」页同源）；
 *   ④ 成本取自 task.cost（ASR 估算 / LLM 实际）；
 *   ⑤ 需要人处理的事项（未确认投稿 / 缺分P / 失败切片 / 整场失败）如实列出，没有就是空数组；
 *   ⑥ 只读：跑两次台账状态不变。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';

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

interface Recap {
  task: { id: string; title: string; status: string; durationSec: number };
  transcript: { asrAudioSeconds: number; asrEstimate: number; llmActual: number; llmCalls: number };
  clips: { total: number; byStatus: Record<string, number>; avgScore?: number; minScore?: number; maxScore?: number; top: Array<{ score: number; title: string }> };
  publish: { batches: number; landed: number; failed: number; missingParts: number; detail: Array<{ status: string; parts: number; landed: number }> };
  performance: { measured: number; view: number; like: number };
  todos: string[];
  note: string;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recap-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
const orch = new Orchestrator({ ledger, dataDirOverride: dataDir });
orch.logger.setConsole(false);

const T = 'auto-20261011010000-recap';
const now = new Date().toISOString();
ledger.createTask({
  id: T,
  roomId: '1',
  title: '【电台】复盘验证场',
  stage: 'PUBLISHED',
  status: 'PUBLISHED',
  source: { segments: [], totalDuration: 3540, rawFiles: [], fullVideoHasDanmaku: false },
  fullUpload: 'NOT_APPLICABLE',
  cost: { asrEstimate: 1.25, asrAudioSeconds: 3540, llmActual: 0.0312, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 7, updatedAt: now },
  createdAt: now,
  updatedAt: now,
} as never);
ledger.setClips(T, [
  { index: 0, start: 0, end: 60, title: '最佳的一条', desc: '', tags: ['测试'], category: '生活', score: 9.2, selected: true, status: 'PUBLISHED', bvid: 'BV1RECAP00001', submitTime: Date.now() - 3600_000 },
  { index: 1, start: 60, end: 120, title: '中间的一条', desc: '', tags: ['测试'], category: '生活', score: 6.4, selected: true, status: 'SUBMITTED', bvid: 'BV1RECAP00001', submitTime: Date.now() - 5400_000 },
  { index: 2, start: 120, end: 180, title: '失败的一条', desc: '', tags: ['测试'], category: '生活', score: 4.1, selected: true, status: 'FAILED' },
] as never);
/* 表现数据：同一 bvid 两行，只有最新一行该被算进去（与表现页同源的口径） */
ledger.recordPerformance({ bvid: 'BV1RECAP00001', date: '2026-10-10', view: 10, like: 1, title: '旧数据' });
ledger.recordPerformance({ bvid: 'BV1RECAP00001', date: '2026-10-11', view: 500, like: 42, title: '新数据' });
/* 投稿批次：一次落地、一次缺分P */
const batchLog = path.join(dataDir, 'publish-log.jsonl');
fs.writeFileSync(
  batchLog,
  [
    { at: '2026-10-11T01:00:00.000Z', action: 'batch-submit', taskId: T, uploadTaskId: 'up-a', kind: 'append', titles: ['最佳的一条'], clipIndices: [0] },
    { at: '2026-10-11T01:05:00.000Z', action: 'batch-landed', taskId: T, uploadTaskId: 'up-a', kind: 'append', landed: ['最佳的一条'] },
    { at: '2026-10-11T01:10:00.000Z', action: 'batch-submit', taskId: T, uploadTaskId: 'up-b', kind: 'append', titles: ['中间的一条'], clipIndices: [1] },
    { at: '2026-10-11T01:15:00.000Z', action: 'batch-unconfirmed', taskId: T, uploadTaskId: 'up-b', kind: 'append', missing: ['中间的一条'], note: 'B站 分P 列表还没出现' },
  ]
    .map((x) => JSON.stringify(x))
    .join('\n') + '\n',
  'utf8',
);

const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
await ui.start();
const recap = async (): Promise<Recap> => (await (await fetch(`${ui.url}/api/task/${T}/recap`)).json()) as Recap;

try {
  const r = await recap();
  eq('① 切片总数', r.clips.total, 3);
  eq('① 状态计数', r.clips.byStatus, { PUBLISHED: 1, SUBMITTED: 1, FAILED: 1 });
  eq('① 评分分布（均/最小/最大）', [r.clips.avgScore, r.clips.minScore, r.clips.maxScore], [6.57, 4.1, 9.2]);
  eq('① 最佳三条按分数降序', r.clips.top.map((x) => x.title), ['最佳的一条', '中间的一条', '失败的一条']);
  eq('② 投稿批次汇总', [r.publish.batches, r.publish.landed, r.publish.failed, r.publish.missingParts], [2, 1, 0, 1]);
  eq('② 明细里能看出哪一批没落地', r.publish.detail.map((x) => x.status), ['landed', 'unconfirmed']);
  eq('③ 表现只算最新一行（不是两行相加）', [r.performance.measured, r.performance.view, r.performance.like], [1, 500, 42]);
  eq('④ 成本取自 task.cost', [r.transcript.asrEstimate, r.transcript.llmActual, r.transcript.llmCalls, r.transcript.asrAudioSeconds], [1.25, 0.0312, 7, 3540]);
  ok('⑤ 需要处理的事项如实列出（未确认 + 缺分P + 失败切片）', r.todos.length >= 3 && r.todos.some((x) => /已提交待确认/.test(x)) && r.todos.some((x) => /缺 1 个分P/.test(x)), JSON.stringify(r.todos));
  ok('⑤ 说明写清了这是本地汇总（不是另算一套）', /只汇总本地台账与表现数据/.test(r.note), r.note);

  const before = ledger.listTasks({ limit: 10 }).map((x) => `${x.id}:${x.status}`).join('|');
  await recap();
  const after = ledger.listTasks({ limit: 10 }).map((x) => `${x.id}:${x.status}`).join('|');
  eq('⑥ 只读：跑两次台账不变', after, before);

  /* 干净的一场：没有待办事项时给空数组（不硬凑） */
  const T2 = 'auto-20261011020000-clean';
  ledger.createTask({
    id: T2, roomId: '1', title: '干净场', stage: 'PUBLISHED', status: 'PUBLISHED',
    source: { segments: [], totalDuration: 600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
    createdAt: now, updatedAt: now,
  } as never);
  const r2 = (await (await fetch(`${ui.url}/api/task/${T2}/recap`)).json()) as Recap;
  eq('⑤ 干净场：待办为空数组', r2.todos, []);
  eq('干净场：没有切片时 total=0', r2.clips.total, 0);
  eq('干净场：没有表现数据时 measured=0', r2.performance.measured, 0);
} finally {
  ui.stop();
  orch.stop();
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
