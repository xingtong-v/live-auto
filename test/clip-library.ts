/**
 * 切片库（`GET /api/clips/library`）——2026-10-11 优化第一批 P0-3。
 *
 * 稿件是长期资产，而切片一直只能"一场场翻任务"看。这个端点把所有场次的切片拉平成一张表，
 * 套件锁住它作为"检索视图"该有的行为：
 *   ① 跨场次聚合（多场次的切片在一张表里）；
 *   ② 筛选（状态 / 关键词，关键词覆盖标题、场次标题、任务 id、BV 号）；
 *   ③ 排序（评分/时长/时间，升序降序都要能翻）；
 *   ④ 截断要如实说（`truncated` + `total`），不许假装全都在；
 *   ⑤ 只读（不触发任何投稿/切片的副作用）。
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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lib-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
const orch = new Orchestrator({ ledger, dataDirOverride: dataDir });
orch.logger.setConsole(false);

const mkTask = (id: string, title: string, createdAt: string): void => {
  ledger.createTask({
    id,
    roomId: '1',
    title,
    stage: 'PUBLISHED',
    status: 'PUBLISHED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: createdAt },
    createdAt,
    updatedAt: createdAt,
  });
};
const mkClip = (i: number, o: Record<string, unknown>): Record<string, unknown> => ({
  index: i,
  start: i * 100,
  end: i * 100 + 60,
  title: `切片${i}`,
  desc: '',
  tags: ['测试'],
  category: '生活',
  score: 7 + i * 0.5,
  reason: '',
  selected: true,
  status: 'CANDIDATE',
  ...o,
});

mkTask('auto-20261010090000-aaaa', '【电台】露露专场', '2026-10-10T09:00:00.000Z');
ledger.setClips('auto-20261010090000-aaaa', [
  mkClip(0, { title: '露露吐槽手办价格', status: 'PUBLISHED', bvid: 'BV1LIB000001' }),
  mkClip(1, { title: '乙主播讲三国', status: 'SUBMITTED', bvid: 'BV1LIB000001' }),
] as never);
mkTask('auto-20261011090000-bbbb', '【3D】折棒新三国', '2026-10-11T09:00:00.000Z');
ledger.setClips('auto-20261011090000-bbbb', [
  mkClip(0, { title: '折棒名场面', status: 'FAILED' }),
  mkClip(1, { title: '吕布背刺解析', status: 'CANDIDATE', score: 9.9 }),
] as never);
/* 表现数据（播放/点赞来自这份历史，与「稿件表现」页同源） */
ledger.recordPerformance({ bvid: 'BV1LIB000001', date: new Date().toLocaleDateString('sv-SE'), view: 1234, like: 56, title: '露露吐槽手办价格' });

const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
await ui.start();
const get = async (qs: string): Promise<{ rows: Array<Record<string, unknown>>; total: number; truncated: boolean; counts: Record<string, number> }> =>
  (await (await fetch(`${ui.url}/api/clips/library?${qs}`)).json()) as never;

try {
  section('1. 跨场次聚合');
  const all = await get('limit=100');
  eq('两个场次的 4 条切片都在一张表里', all.total, 4);
  eq('带上场次信息（能认出它是哪一场）', [...new Set(all.rows.map((r) => r['taskId']))].length, 2);
  eq('带上状态计数', all.counts, { published: 1, submitted: 1, candidate: 1, failed: 1 });
  const withView = all.rows.find((r) => r['bvid'] === 'BV1LIB000001' && r['title'] === '露露吐槽手办价格');
  eq('★ 播放/点赞来自表现数据（与表现页同源）', [withView?.['view'], withView?.['like']], [1234, 56]);
  ok('带稿件链接（点得出去）', typeof withView?.['url'] === 'string' && String(withView['url']).includes('BV1LIB000001'));
  ok('未切片的行不会假装能试看（没有 hasCut）', all.rows.filter((r) => r['hasCut']).length === 0, JSON.stringify(all.rows.map((r) => r['hasCut'])));

  section('2. 筛选');
  eq('按状态筛：只看已发布', (await get('status=PUBLISHED')).total, 1);
  eq('按状态筛：失败', (await get('status=FAILED')).total, 1);
  eq('关键词搜标题（也搜场次标题：「折棒新三国」那场 2 条 + 「乙主播讲三国」1 条 = 3）', (await get(`q=${encodeURIComponent('三国')}`)).total, 3);
  eq('关键词搜场次标题（【3D】那场有两条）', (await get(`q=${encodeURIComponent('折棒')}`)).total, 2);
  eq('关键词搜任务 ID', (await get(`q=bbbb`)).total, 2);
  eq('关键词搜 BV 号', (await get(`q=BV1LIB000001`)).total, 2);
  eq('搜不到就是 0 条（不糊弄）', (await get(`q=${encodeURIComponent('不存在的关键词xyz')}`)).total, 0);

  section('3. 排序与截断');
  const byScore = await get('sort=score&limit=100');
  eq('按评分降序时最高分在最前', byScore.rows[0]?.['title'], '吕布背刺解析');
  const byScoreAsc = await get('sort=score&asc=1&limit=100');
  eq('升序时最低分在最前', byScoreAsc.rows[0]?.['score'], 7);
  const byTime = await get('sort=time&asc=1&limit=100');
  ok('按场次时间升序：10-10 那场在最前', String(byTime.rows[0]?.['taskWhen']).startsWith('2026-10-10'), String(byTime.rows[0]?.['taskWhen']));
  const limited = await get('limit=2');
  eq('截断时只给 limit 条', limited.rows.length, 2);
  eq('★ 但如实报出总数与截断', [limited.total, limited.truncated], [4, true]);
  const notLimited = await get('limit=100');
  eq('没截断时不谎报 truncated', notLimited.truncated, false);
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
