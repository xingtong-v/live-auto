/**
 * 「稿件表现」链路自测（无网络、零费用）。
 *
 * 背景（真实故障，2026-10-06 用户在界面上报「稿件表现 这里现在没办法工作 修复他」）：
 *   页面上两段永远全是 0 / 空。查下来是**三个**独立缺陷叠在一起：
 *     ① 回流候选只认 `PUBLISHED`，而多分P 续传后的切片停在 `SUBMITTED`（有 bvid 但没人翻状态）
 *        → `POST /api/performance/refresh` 恒返回 `checked=0`；
 *     ② 统计数字读错了层级：biliLive-tools 把数字放在 `View.stat`，旧代码读顶层 `stat`
 *        → 每次都写 `view: 0`（线上 performance.jsonl 里 11 行全是 0）；
 *     ③ 页面行是从**台账**拼的：用户当天批量删掉十几个任务，一删这些稿件就从页面上消失了，
 *        可稿件还在 B站 上、数据还在变。
 *
 * 本测试覆盖：
 *   ① 候选判据与三个来源（台账 / performance 历史 / 我的稿件列表）；
 *   ② 真 Publisher 的续传成功分支：目标稿件 bvid 已知 ⇒ 切片直接记 PUBLISHED；
 *   ③ 真起 UiServer 的端到端：回流 → `/api/performance` 出得来行、分档、多分P 去重、
 *      锁定/已删/未拉取三种「没有数字」的情况不写成 0；
 *   ④ 台账清空后页面照样有数据（历史来源兜住）。
 *
 * 运行：node test/performance-reflux.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';
import { Publisher } from '../src/publish.ts';
import { loadConfig } from '../src/config.ts';
import { ROOT_DIR } from '../src/util.ts';
import type { ClipRecord, TaskRecord } from '../src/types.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const silentLog = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
  child: (): unknown => silentLog,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-perf-'));
/** 每本测试台账都放进自己的子目录：`performance.jsonl` 默认与 ledger 同目录，挤在一个目录会互相污染 */
const mkDir = (name: string): string => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const cfg = loadConfig('config.json').config;
const now = new Date().toISOString();
const nowMs = Date.now();
const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（与台账 fmtDate 同口径）
/** 稿件发布时间（unix 秒）：2026-09-24 20:00 本地（固定值，断言好写）。真实 B站 详情里有 `View.pubdate`。 */
const PUBDATE = Math.floor(Date.parse('2026-09-24T20:00:00+08:00') / 1000);
/** 让它返回的详情**不带** pubdate（复现"老记录缺这个字段"的一次性补齐） */
let omitPubdateBvid = '';
const yesterday = new Date(Date.now() - 86400_000).toLocaleDateString('sv-SE');
const longAgo = new Date(Date.now() - 40 * 86400_000).toLocaleDateString('sv-SE');

/* 错误事件流与报告目录是模块级常量，dataDirOverride 管不到，必须显式隔离，
   否则测试制造的失败会把真实 data/errors.jsonl 冲成噪音。 */
const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
setErrorsPath(path.join(tmp, 'errors.jsonl'));
setErrorReportDir(path.join(tmp, 'error-report'));

function mkClip(index: number, over: Partial<ClipRecord> = {}): ClipRecord {
  return {
    index,
    start: index * 100,
    end: index * 100 + 60,
    title: `表现测试切片 ${index}`,
    desc: '测试',
    tags: ['直播切片'],
    category: '游戏/单机游戏',
    score: 8,
    reason: '测试',
    selected: true,
    status: 'CANDIDATE',
    degraded: false,
    createdAt: now,
    ...over,
  } as ClipRecord;
}

function mkTask(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    roomId: '12345678',
    platform: 'Bilibili',
    title: '表现测试场',
    streamer: '丙主播',
    status: 'PUBLISHED',
    stage: 'PUBLISHED',
    importSource: 'auto',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now,
    ...over,
  } as TaskRecord;
}

console.log('\x1b[1m稿件表现回流链路\x1b[0m（候选来源 + 状态落账 + 页面契约，无网络）');
console.log('─'.repeat(74));

/* ========================================================================== */
section('① 回流候选判据：只要「投出去了且知道 bvid」就该拉');
{
  const ledger = new Ledger({ path: path.join(mkDir('l1'), 'ledger.json') });
  const t = 'perf-t1';
  ledger.createTask(mkTask(t));
  ledger.setClips(t, [
    mkClip(0, { status: 'PUBLISHED', bvid: 'BV1PERF00001', submitTime: nowMs, publishedAt: now }),
    /* ★ 本次修复的核心：多分P 续传后的常态就是「SUBMITTED + 有 bvid」 */
    mkClip(1, { status: 'SUBMITTED', bvid: 'BV1PERF00002', submitTime: nowMs }),
    mkClip(2, { status: 'SUBMITTING' }), // 还没有 bvid
    mkClip(3, { status: 'CUT', cutOutput: path.join(tmp, 'x.mp4') }),
    mkClip(4, { status: 'PUBLISHED', bvid: 'BV1PERF00003', submitTime: nowMs, archiveGoneAt: now }),
    mkClip(5, { status: 'PUBLISHED', bvid: 'BV1PERF00001', submitTime: nowMs }), // 同稿件第二个分P
    mkClip(6, { status: 'PUBLISHED', bvid: 'BV1PERF00009', submitTime: nowMs - 40 * 86400_000 }),
  ]);
  const got = ledger.bvidsNeedingPerformance(30).map((x) => x.bvid);
  eq('候选 = 两个「有 bvid 且在窗口内」的稿件（按分P 顺序、同 bvid 去重）', got, ['BV1PERF00001', 'BV1PERF00002']);
  ok(
    '★ SUBMITTED + 有 bvid 也算候选（旧判据只认 PUBLISHED，导致线上恒为 checked=0）',
    got.includes('BV1PERF00002'),
    JSON.stringify(got),
  );
  ok('没有 bvid 的 SUBMITTING 不算候选', !got.includes('BV1PERF00003'), JSON.stringify(got));
  ok('同稿件多个分P 只出一次（否则同一个 bvid 会重复请求）', got.filter((b) => b === 'BV1PERF00001').length === 1, JSON.stringify(got));
  ok('已判定稿件不存在（archiveGoneAt）的跳过', !got.includes('BV1PERF00003'), JSON.stringify(got));
  ok('超出近 30 天窗口的不拉', !got.includes('BV1PERF00009'), JSON.stringify(got));

  /* 当天已拉过的 bvid 不再拉（每天一次，只读接口也要省着打）。
     ★ 记录要写**完整**（带上 pubdate）：从 2026-10-08 起"今天拉过但缺 pubdate"的行允许再拉一次
     （新增字段的一次性补齐，见 ledger.bvidsNeedingPerformance），缺字段的记录不算"拉过"。 */
  ledger.recordPerformance({ bvid: 'BV1PERF00001', date: today, view: 111, pubdate: PUBDATE });
  eq('当天已回流过的 bvid 被跳过', ledger.bvidsNeedingPerformance(30).map((x) => x.bvid), ['BV1PERF00002']);
  /* 反过来：今天拉过、但**缺 pubdate** 的记录要被再拉一次（否则表现页的「发布时间」会一直空到明天） */
  ledger.recordPerformance({ bvid: 'BV1PERF00002', date: today, view: 222 });
  eq(
    '★ 缺 pubdate 的当日记录会被再拉一次（一次性补齐）',
    ledger.bvidsNeedingPerformance(30).map((x) => x.bvid),
    ['BV1PERF00002'],
  );
  /* 已消失（gone）/ 已锁定（unavailable）的稿件不参与补齐：它们本来就没有可见的发布时间，
     免得天天白拉。写一条 gone 记录，它照旧被"已判定不存在"这条规则跳过。 */
  ledger.recordPerformance({ bvid: 'BV1PERF00002', date: today, gone: true });
  eq(
    '已消失的稿件不因为"缺 pubdate"而反复重拉',
    ledger.bvidsNeedingPerformance(30).map((x) => x.bvid),
    [],
  );

  /* 历史行不该挡住今天的回流：换一本干净台账，只写一条很早以前的记录 */
  const ledgerHist = new Ledger({ path: path.join(mkDir('l1b'), 'ledger.json') });
  ledgerHist.createTask(mkTask('perf-hist'));
  ledgerHist.setClips('perf-hist', [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1PERFHIST1', submitTime: nowMs })]);
  ledgerHist.recordPerformance({ bvid: 'BV1PERFHIST1', date: '1970-01-01', view: 1 });
  eq('只有当天那条会挡住回流（历史行不影响）', ledgerHist.bvidsNeedingPerformance(30).map((x) => x.bvid), ['BV1PERFHIST1']);
}

/* ========================================================================== */
section('①b 候选的三个来源：台账 / 历史（任务被删也继续跟）/ 我的稿件列表');
{
  const l = new Ledger({ path: path.join(mkDir('l1c'), 'ledger.json') });
  l.createTask(mkTask('perf-src'));
  l.setClips('perf-src', [
    mkClip(0, { status: 'PUBLISHED', bvid: 'BV1SRC000001', submitTime: nowMs, score: 8.8, title: '台账里的切片' }),
  ]);
  /* 历史里有、台账里没有的两个：一个在窗口内、一个在窗口外 */
  l.recordPerformance({ bvid: 'BV1SRC000002', date: yesterday, view: 5, title: '历史跟踪的稿件', score: 7.1, parts: 4 });
  l.recordPerformance({ bvid: 'BV1SRC000099', date: longAgo, view: 5, title: '很久以前的稿件', score: 7.1 });

  const c1 = l.bvidsNeedingPerformance(30);
  const bv1 = c1.map((x) => x.bvid);
  ok('台账来源在候选里', bv1.includes('BV1SRC000001'), JSON.stringify(bv1));
  ok('★ 历史来源：台账里已经没有这个稿件的任务了，仍然继续跟踪', bv1.includes('BV1SRC000002'), JSON.stringify(bv1));
  const hist = c1.find((x) => x.bvid === 'BV1SRC000002')!;
  eq('历史行里的标题被沿用（否则任务删掉后页面就没标题了）', hist.title, '历史跟踪的稿件');
  eq('历史行里的评分被沿用（相关性表的横轴）', hist.score, 7.1);
  eq('历史行里的分P 数被沿用', hist.parts, 4);
  ok('超出窗口的历史行不再拉', !bv1.includes('BV1SRC000099'), JSON.stringify(bv1));
  const fromLedger = c1.find((x) => x.bvid === 'BV1SRC000001')!;
  eq('台账来源带上评分与分P 数', [fromLedger.score, fromLedger.parts, fromLedger.title], [8.8, 1, '台账里的切片']);

  /* 第三个来源：biliLive-tools 的「我的稿件列表」——完整版由它投的稿件本地没有任务 */
  const c2 = l.bvidsNeedingPerformance(30, new Date(), [
    { bvid: 'BV1SRC000003', title: '完整版稿件（本地无任务）', ctime: Math.floor(Date.now() / 1000) },
  ]);
  const list1 = c2.find((x) => x.bvid === 'BV1SRC000003')!;
  eq('★ 稿件列表来源也被纳入候选', list1.title, '完整版稿件（本地无任务）');

  /* 任务被真删掉之后，历史来源照样把稿件留在候选里（用户当天批量删任务就是这种） */
  const l2 = new Ledger({ path: path.join(mkDir('l1d'), 'ledger.json') });
  l2.createTask(mkTask('perf-del'));
  l2.setClips('perf-del', [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1DEL000001', submitTime: nowMs, score: 9.1 })]);
  l2.recordPerformance({ bvid: 'BV1DEL000001', date: yesterday, view: 12, title: '删掉任务后的稿件', score: 9.1, parts: 6 });
  eq('删任务前：候选来自台账', l2.bvidsNeedingPerformance(30).map((x) => x.bvid), ['BV1DEL000001']);
  l2.deleteTask('perf-del');
  const after = l2.bvidsNeedingPerformance(30);
  eq('★ 删任务后：候选仍来自历史（页面不会因为本地清理而失忆）', after.map((x) => x.bvid), ['BV1DEL000001']);
  eq('删任务后仍能拿到标题/评分/分P', [after[0]?.title, after[0]?.score, after[0]?.parts], ['删掉任务后的稿件', 9.1, 6]);

  /* 已确认「稿件不存在」的历史行不再当候选（否则每天都要为一批删掉的稿件白打接口） */
  const l3 = new Ledger({ path: path.join(mkDir('l1e'), 'ledger.json') });
  l3.recordPerformance({ bvid: 'BV1GONE000001', date: yesterday, view: 3, title: '已被删的稿件' });
  eq('删掉前的历史行仍会跟踪', l3.bvidsNeedingPerformance(30).map((x) => x.bvid), ['BV1GONE000001']);
  l3.recordPerformance({ bvid: 'BV1GONE000001', date: yesterday, gone: true, title: '已被删的稿件' });
  eq('★ 最近一次记录说「已不存在」⇒ 不再当候选（不再反复请求）', l3.bvidsNeedingPerformance(30).length, 0);
  eq(
    '★ 但它重新出现在稿件列表里（用户恢复/重新可见）时又会被跟踪',
    l3
      .bvidsNeedingPerformance(30, new Date(), [{ bvid: 'BV1GONE000001', title: '又被列出来了', ctime: Math.floor(Date.now() / 1000) }])
      .map((x) => x.bvid),
    ['BV1GONE000001'],
  );
  /* 反转也要成立：后来的行说它又在了 → 标记撤销（否则一次误判会永久屏蔽这个稿件） */
  l3.recordPerformance({ bvid: 'BV1GONE000001', date: yesterday, view: 9, title: '又回来了' });
  eq('后来的一次成功回流会撤销「已不存在」的标记', l3.bvidsNeedingPerformance(30).map((x) => x.bvid), ['BV1GONE000001']);
}

/* ========================================================================== */
section('② 真 Publisher：续传成功 ⇒ 切片记 PUBLISHED（否则回流永远看不到它）');
{
  const dir = mkDir('pub');
  const clipFiles: string[] = [];
  for (const i of [0, 1]) {
    const p = path.join(dir, `clip-${i}.mp4`);
    fs.writeFileSync(p, 'x');
    clipFiles.push(p);
  }
  /** 造真 Publisher + mock client：分P 列表在第二次查询时出现新标题（模拟续传落地） */
  const makePub = (ledger: Ledger, tag: string): Publisher => {
    let detailCalls = 0;
    const client = {
      biliArchives: async () => [] as unknown[],
      biliUpload: async () => ({ taskId: `fake-upload-${tag}` }),
      biliArchiveDetail: async () => {
        detailCalls++;
        const base = [{ part: '完整版', duration: 100 }, { part: '纯享版', duration: 100 }];
        const parts = detailCalls === 1 ? base : [...base, { part: '表现测试切片 0', duration: 60 }, { part: '表现测试切片 1', duration: 60 }];
        /* 真实详情里带 `View.pubdate`（稿件发布时间）：表现页的「发布时间」列靠它，
           桩也要给 —— 不给的话这条记录会被判成"缺字段"，下次回流又拉一遍（见 ledger 的补齐规则）。 */
        return { View: { bvid: 'BV1RESUME001', videos: parts.length, pages: parts, pubdate: PUBDATE } };
      },
    };
    return new Publisher({ client: client as never, config: cfg, ledger, logger: silentLog as never });
  };

  const ledgerA = new Ledger({ path: path.join(mkDir('l2a'), 'ledger.json') });
  const tA = 'perf-t2a';
  ledgerA.createTask(mkTask(tA, { status: 'CLIPPED', stage: 'CLIPPED' }));
  ledgerA.setClips(tA, [
    mkClip(0, { status: 'CUT', cutOutput: clipFiles[0]! }),
    mkClip(1, { status: 'CUT', cutOutput: clipFiles[1]! }),
  ]);
  const resA = await makePub(ledgerA, 'a').publishAsMultiPart({
    task: ledgerA.getTask(tA)!,
    uid: 12345,
    clips: ledgerA.getClips(tA),
    resumeAid: '999',
    resumeBvid: 'BV1RESUME001',
    logger: silentLog as never,
  });
  ok('续传投稿返回 ok', resA.ok === true, JSON.stringify(resA).slice(0, 200));
  eq('模式是 append（续传，不是新建稿件）', resA.mode, 'append');
  const afterA = ledgerA.getClips(tA);
  eq('★ 续传落地确认后切片状态 = PUBLISHED', afterA.map((c) => c.status), ['PUBLISHED', 'PUBLISHED']);
  eq('切片写上了目标稿件的 bvid', afterA.map((c) => c.bvid), ['BV1RESUME001', 'BV1RESUME001']);
  ok('写了 publishedAt（表现页要显示发布时间）', Boolean(afterA[0]?.publishedAt), JSON.stringify(afterA[0]?.publishedAt));
  eq('闭环：这一场立刻成为回流候选', ledgerA.bvidsNeedingPerformance(30).map((x) => x.bvid), ['BV1RESUME001']);

  /* 新建稿件（resumeAid 为空）：此刻 bvid 还不知道，必须记 SUBMITTED 等反查，不许谎报 */
  const ledgerB = new Ledger({ path: path.join(mkDir('l2b'), 'ledger.json') });
  const tB = 'perf-t2b';
  ledgerB.createTask(mkTask(tB, { status: 'CLIPPED', stage: 'CLIPPED' }));
  ledgerB.setClips(tB, [mkClip(0, { status: 'CUT', cutOutput: clipFiles[0]! })]);
  const resB = await makePub(ledgerB, 'b').publishAsMultiPart({
    task: ledgerB.getTask(tB)!,
    uid: 12345,
    clips: ledgerB.getClips(tB),
    logger: silentLog as never,
  });
  eq('新建稿件模式是 create', resB.mode, 'create');
  eq('新建稿件（bvid 未知）仍记 SUBMITTED，不谎报 PUBLISHED', ledgerB.getClips(tB).map((c) => c.status), ['SUBMITTED']);
  ok('新建稿件模式下不写 bvid（bvid 未知，交给周期性反查）', ledgerB.getClips(tB)[0]?.bvid === undefined, String(ledgerB.getClips(tB)[0]?.bvid));
  eq('没有 bvid ⇒ 不进回流候选（不会拿着猜测的 bvid 去打接口）', ledgerB.bvidsNeedingPerformance(30).length, 0);
}

/* ========================================================================== */
section('③ 真起 UiServer：回流能写入，页面能出稿件的行与分档');
const dataDir = mkDir('ui');
const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
const orch = new Orchestrator({ ledger, dataDirOverride: dataDir });
orch.logger.setConsole(false);
await orch.start({ polling: false });

/* 台账：一场多分P（6 个分P 同 bvid，分数不同）+ 单P 场 + 顶层 stat 兼容场 + 锁定场 + 已消失场
   + 一个「40 天前、超出回流窗口」的场（页面要显示成「未拉取」而不是消失） */
const tMP = 'perf-t3-mp';
ledger.createTask(mkTask(tMP, { title: '多分P场', publishedAt: now }));
ledger.setClips(
  tMP,
  [9.3, 9.0, 8.7, 8.3, 7.8, 7.2].map((score, i) =>
    mkClip(i, { status: 'SUBMITTED', bvid: 'BV1PERFMP001', submitTime: nowMs, score, title: `多分P切片 ${i}` }),
  ),
);
ledger.createTask(mkTask('perf-t3-single', { title: '单P场', publishedAt: now }));
ledger.setClips('perf-t3-single', [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1PERFSG001', submitTime: nowMs, score: 6.5, title: '单P切片' })]);
ledger.createTask(mkTask('perf-t3-top', { title: '顶层stat场', publishedAt: now }));
ledger.setClips('perf-t3-top', [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1PERFTOP01', submitTime: nowMs, score: 8.2, title: '顶层stat切片' })]);
ledger.createTask(mkTask('perf-t3-lock', { title: '锁定场', publishedAt: now }));
ledger.setClips('perf-t3-lock', [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1PERFLOCK1', submitTime: nowMs, score: 9.9, title: '锁定切片' })]);
ledger.createTask(mkTask('perf-t3-gone', { title: '已删场', publishedAt: now }));
ledger.setClips('perf-t3-gone', [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1PERFGONE1', submitTime: nowMs, score: 8.0, title: '已删切片' })]);
ledger.createTask(mkTask('perf-t3-old', { title: '很久以前', publishedAt: now }));
ledger.setClips('perf-t3-old', [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1PERFOLD01', submitTime: nowMs - 40 * 86400_000, score: 8.5, title: '很久以前的切片' })]);

/* 只替换客户端。★ 详情接口的**真实形状**是数字在 `View.stat`：
   旧代码读顶层 `stat` 拿到 undefined → 每次都写 view:0（线上 11 行全是 0，页面全是 0）。
   这里刻意按真实形状返回，只要有人再读错层级，本套件立刻红。 */
let detailCalls = 0;
const MP_STAT = { view: 12345, like: 678, coin: 90, favorite: 123, danmaku: 45, reply: 6, share: 7 };
(orch as unknown as { client: unknown }).client = {
  biliArchives: async () => [
    { bvid: 'BV1PERFMP001', title: '多分P场 稿件', ctime: Math.floor(Date.now() / 1000), state: 0, state_desc: '开放浏览' },
    { bvid: 'BV1PERFSG001', title: '单P场 稿件', ctime: Math.floor(Date.now() / 1000), state: 0, state_desc: '开放浏览' },
    { bvid: 'BV1PERFTOP01', title: '顶层stat场 稿件', ctime: Math.floor(Date.now() / 1000), state: 0, state_desc: '开放浏览' },
    /* 实测：-4 = 已锁定，公开接口取不到统计，但它并没有被删 */
    { bvid: 'BV1PERFLOCK1', title: '锁定场 稿件', ctime: Math.floor(Date.now() / 1000), state: -4, state_desc: '已锁定' },
    /* 只在稿件列表里、本地台账没有任务（完整版由 biliLive-tools 自己投的稿件） */
    { bvid: 'BV1PERFLIST1', title: '完整版稿件（本地无任务）', ctime: Math.floor(Date.now() / 1000), state: 0, state_desc: '开放浏览' },
  ],
  biliArchiveDetail: async (bvid: string) => {
    detailCalls++;
    if (bvid === 'BV1PERFLOCK1' || bvid === 'BV1PERFGONE1') {
      throw new Error('biliLive-tools 内部错误（HTTP 500） —— 啥都木有');
    }
    if (bvid === 'BV1PERFTOP01') {
      // 兼容路径：万一某个版本把统计挪回顶层，也得能读出来（pubdate 同样要给，理由见下）
      return { stat: { view: 777, like: 7, coin: 0, favorite: 0, danmaku: 0, reply: 0, share: 0 }, View: { bvid, pubdate: PUBDATE } };
    }
    const stat = bvid === 'BV1PERFMP001' ? MP_STAT : { view: 500, like: 10, coin: 1, favorite: 2, danmaku: 3, reply: 1, share: 0 };
    const title = bvid === 'BV1PERFMP001' ? '多分P场 稿件标题' : `稿件 ${bvid}`;
    /* 真实 B站 详情里**有** `View.pubdate`（稿件发布时间）—— 表现页的「发布时间」列靠它，
       所以桩也要给；`omitPubdateBvid` 用来复现"老记录缺这个字段"的一次性补齐。 */
    const pubRaw = bvid === omitPubdateBvid ? undefined : PUBDATE;
    return { View: { bvid, videos: bvid === 'BV1PERFMP001' ? 6 : 2, title, stat, ...(pubRaw ? { pubdate: pubRaw } : {}) } };
  },
};

const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
await ui.start();
const base = ui.url;
/* 写接口有 CSRF 闸（防跨站误触发）：先取 bootstrap 里的 token 再带着头调，跟页面走的是同一条路 */
const boot = (await (await fetch(base + '/api/bootstrap')).json()) as { csrf?: string };
const csrf = String(boot.csrf ?? '');
const post = async (p: string): Promise<Record<string, unknown>> => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrf },
    body: '{}',
  });
  return (await r.json()) as Record<string, unknown>;
};
const get = async (p: string): Promise<Record<string, unknown>> => {
  const r = await fetch(base + p);
  return (await r.json()) as Record<string, unknown>;
};

{
  const before = await get('/api/performance');
  eq('回流之前：页面已经知道有 6 个稿件（不是「没稿件」，而是「没数据」）', before['archiveTotal'], 6);
  const rowsBefore = before['rows'] as Array<Record<string, unknown>>;
  eq('★ 没数据的稿件也在页面里（显示「未拉取」，而不是整页空白）', rowsBefore.length, 6);
  eq('回流前一个统计都没有', before['pulledTotal'], 0);
  ok('回流前每行都没有统计值', rowsBefore.every((r) => r['view'] === undefined), JSON.stringify(rowsBefore[0]));

  const r1 = await post('/api/performance/refresh');
  eq('★ 回流取到 6 个稿件（旧代码这里是 checked=0 —— 线上故障就是这样）', r1['checked'], 6);
  eq('4 个正常拉到、1 个锁定取不到、1 个已消失', r1['updated'], 4);
  eq('失败项 2 个（锁定 + 已消失），都带原因', (r1['failed'] as unknown[]).length, 2);
  eq('详情接口按候选各调一次', detailCalls, 6);
  ok(
    '说明里报出「取不到统计」，不静默',
    String((r1['notes'] as string[]).join(' ')).includes('取不到统计'),
    JSON.stringify(r1['notes']),
  );

  const after = await get('/api/performance');
  const rows = after['rows'] as Array<Record<string, unknown>>;
  eq('★ 多分P 稿件按 bvid 去重：6 个分P 只出一行（共 7 个稿件 = 6 台账 + 1 列表来源）', rows.length, 7);
  eq('拉到了 4 个稿件的统计', after['pulledTotal'], 4);
  eq('分P 总数：多分P6 + 单P2 + 顶层stat1（详情没给 videos，按台账数）+ 锁定1 + 已删1 + 未拉取1 + 列表2 = 13', after['partTotal'], 13);
  const mp = rows.find((x) => x['bvid'] === 'BV1PERFMP001')!;
  eq('多分P 那一行带分P 数 6', mp['partCount'], 6);
  eq('★ 播放数来自 View.stat（旧代码读顶层 stat → 恒为 0）', mp['view'], 12345);
  eq('★ 代表片段取该稿件内最高分的那一P（9.3）', mp['llmScore'], 9.3);
  eq('点赞/投币/收藏/弹幕都落到行里', [mp['like'], mp['coin'], mp['favorite'], mp['danmaku']], [678, 90, 123, 45]);
  eq('统计日期 = 今天', mp['statDate'], today);
  eq('标题优先用台账里的切片标题', mp['title'], '多分P切片 0');
  eq(
    '按播放降序：多分P 稿件在最前，未拉取/异常的排在后面',
    rows.map((x) => x['bvid']).slice(0, 4),
    ['BV1PERFMP001', 'BV1PERFTOP01', 'BV1PERFSG001', 'BV1PERFLIST1'],
  );
  eq(
    '顶层 stat 的兼容路径也读得出来（版本差异不至于又打成 0）',
    rows.find((x) => x['bvid'] === 'BV1PERFTOP01')?.['view'],
    777,
  );
  const listOnly = rows.find((x) => x['bvid'] === 'BV1PERFLIST1')!;
  eq('★ 稿件列表来源的稿件（本地没有任务）也进了页面', listOnly['view'], 500);
  eq('它的标题来自稿件详情/列表', listOnly['title'], '稿件 BV1PERFLIST1');
  ok('它没有台账评分（相关性表里不参与，但列表里照样能看到）', listOnly['llmScore'] === undefined, String(listOnly['llmScore']));

  const lock = rows.find((x) => x['bvid'] === 'BV1PERFLOCK1')!;
  eq('★ 已锁定的稿件标成「不可用」，不写 0 冒充数据', lock['unavailable'], '已锁定');
  ok('已锁定稿件没有统计值、也没有数据日期', lock['view'] === undefined && lock['statDate'] === undefined, JSON.stringify(lock));
  const gone = rows.find((x) => x['bvid'] === 'BV1PERFGONE1')!;
  eq('★ 确实没了的稿件标成 gone（页面显示「稿件已不存在」）', gone['gone'], true);
  const old = rows.find((x) => x['bvid'] === 'BV1PERFOLD01')!;
  ok('超出窗口、没拉过数据的稿件显示为未拉取（视图里仍在）', old['view'] === undefined && !old['gone'], JSON.stringify(old));

  const corr = after['correlation'] as Array<Record<string, unknown>>;
  eq('分档计数是「稿件数」而不是分P 数：≥9.0 只有 1 个稿件', corr.find((c) => c['bucket'] === '≥9.0')?.['count'], 1);
  eq('<7.0 档 1 个稿件（单P 那场 6.5 分）', corr.find((c) => c['bucket'] === '<7.0')?.['count'], 1);
  eq('8.0–9.0 档 1 个稿件（顶层 stat 那场 8.2 分）', corr.find((c) => c['bucket'] === '8.0–9.0')?.['count'], 1);
  eq('≥9.0 档平均播放 = 该稿件播放', corr.find((c) => c['bucket'] === '≥9.0')?.['avgView'], 12345);
  eq(
    '相关性只统计「既有评分又有播放」的稿件（列表来源那 1 个没有评分，不计入）',
    corr.reduce((a, c) => a + Number(c['count']), 0),
    3,
  );
  ok('说明里点明了「按稿件去重、评分取最高分分P」', String(after['note']).includes('按稿件（bvid）去重'), String(after['note']));
  ok('说明里点明了锁定稿件不写 0', String(after['note']).includes('不写 0'), String(after['note']));

  const r2 = await post('/api/performance/refresh');
  eq('★ 同一天再回流：不再重复打接口（候选为 0）', r2['checked'], 0);
  ok('给出原因说明而不是静默 empty', String((r2['notes'] as string[]).join(' ')).includes('已拉过'), JSON.stringify(r2['notes']));
  eq('详情接口调用次数没有增加（确实没打网络）', detailCalls, 6);

  const jsonl = fs.readFileSync(path.join(dataDir, 'performance.jsonl'), 'utf8').trim().split('\n');
  eq('performance.jsonl 落了 6 行（每个候选一行：4 正常 + 1 锁定 + 1 已消失）', jsonl.length, 6);
  ok('落盘行里带 bvid 与播放数', jsonl.some((l) => l.includes('BV1PERFMP001') && l.includes('12345')), jsonl.join(' | ').slice(0, 200));
  ok('落盘行里带标题（任务删掉后页面仍有标题可显示）', jsonl.some((l) => l.includes('多分P场 稿件标题')), jsonl.join(' | ').slice(0, 300));
  ok(
    '锁定稿件落的是 unavailable 而不是 view:0',
    jsonl.some((l) => l.includes('BV1PERFLOCK1') && l.includes('unavailable') && !l.includes('"view"')),
    jsonl.join(' | ').slice(0, 400),
  );
  ok('消失稿件落的是 gone:true', jsonl.some((l) => l.includes('BV1PERFGONE1') && l.includes('"gone":true')), jsonl.join(' | ').slice(0, 400));
  /* ★ 2026-10-08 用户报「发布时间时 没有正确排序」：根因是这一列**在接口里恒为空**
     （旧代码只从台账切片取，而任务一删切片记录就没了）。修法：把 B站 的稿件发布时间
     随统计一起落进 performance.jsonl。 */
  ok('★ 落盘行带上了稿件发布时间 pubdate', jsonl.some((l) => l.includes('BV1PERFMP001') && l.includes('"pubdate"')), jsonl.join(' | ').slice(0, 300));
  ok('页面行也给出可排序的 publishedAt（本地时间串）', typeof rows.find((x) => x['bvid'] === 'BV1PERFMP001')?.['publishedAt'] === 'string', JSON.stringify(rows[0]).slice(0, 200));

  /* ★ 一次性自愈：**当天已拉过、但缺 pubdate** 的正常稿件允许再拉一次
     （新增字段要补齐，否则"发布时间"会一直空到明天）。
     模拟方式：直接写一条**老格式**的当日记录（没有 pubdate）—— 判据看的是落盘记录，不是桩。 */
  ledger.recordPerformance({ bvid: 'BV1PERFSG001', date: today, view: 1 });
  const rBackfill = await post('/api/performance/refresh');
  eq('★ 缺 pubdate 的当日记录会被再拉一次（不是被"今天拉过"挡住）', rBackfill['checked'], 1);
  eq('它确实打了一次详情接口', detailCalls, 7);
  const afterBackfill = await get('/api/performance');
  const sg = (afterBackfill['rows'] as Array<Record<string, unknown>>).find((x) => x['bvid'] === 'BV1PERFSG001');
  ok('★ 补齐后这一行就有发布时间可排序了', typeof sg?.['publishedAt'] === 'string', JSON.stringify(sg).slice(0, 200));
  const rBackfill2 = await post('/api/performance/refresh');
  eq('补齐后立刻回到"当天不再重复拉"', rBackfill2['checked'], 0);

  /* ★ 台账被清空之后，页面仍然出得来（这就是用户当天批量删任务后的场景） */
  for (const t of ['perf-t3-mp', 'perf-t3-single', 'perf-t3-top', 'perf-t3-lock', 'perf-t3-gone', 'perf-t3-old']) {
    ledger.deleteTask(t);
  }
  const afterDelete = await get('/api/performance');
  const rowsDelete = afterDelete['rows'] as Array<Record<string, unknown>>;
  eq('★ 把任务全删掉后页面照样有 6 个稿件（历史来源兜住）', rowsDelete.length, 6);
  eq('播放数据仍在（来自 performance.jsonl，不是台账）', rowsDelete.find((x) => x['bvid'] === 'BV1PERFMP001')?.['view'], 12345);
  eq('标题也仍在（落账时一起存了）', rowsDelete.find((x) => x['bvid'] === 'BV1PERFMP001')?.['title'], '多分P场 稿件标题');
  eq('评分也仍在（相关性表不至于因为删任务而空掉）', rowsDelete.find((x) => x['bvid'] === 'BV1PERFMP001')?.['llmScore'], 9.3);
  const r3 = await post('/api/performance/refresh');
  eq('删任务后同一天不重复拉：候选仍为 0', r3['checked'], 0);
}

/* ★ 2026-10-07 用户要求「已删除的文件 不进行显示」：B站 上已不存在的稿件默认不出现在表现列表里。
   为什么在无浏览器的自测里也断言一次：这条规则是**纯前端**的（服务端照旧返回那些行，
   好让 MCP 等消费者仍拿得到），而真浏览器脚本要开 Edge、改页面时最容易漏掉它。 */
{
  const ui = fs.readFileSync(path.join(ROOT_DIR, 'public', 'ui.html'), 'utf8');
  ok('★ 表现页按 gone 过滤：默认不显示「稿件已不存在」的行', /const live = p\.rows\.filter\(\(r\) => !r\.gone\)/.test(ui));
  ok('默认是隐藏，不是默认展开', /let perfShowGone = false;/.test(ui));
  ok(
    '表格渲染的是过滤后的行（不再直接用 p.rows）',
    /\$\{shown\.map\(\(r\) =>/.test(ui) && !/\$\{p\.rows\.map\(/.test(ui),
  );
  ok('给出「已隐藏 N 个」的计数，不静默吞掉', /已隐藏 \$\{goneRows\.length\} 个/.test(ui));
  ok('展开时计数文案跟着变（不写「已隐藏」却把行摆出来）', /含 \$\{goneRows\.length\} 个已删除/.test(ui));
  ok(
    '提供「显示它们」按钮并可切回',
    /id="perfGoneToggle"/.test(ui) && /perfShowGone = !perfShowGone; renderPerf\(box\)/.test(ui),
  );
  ok('卡片计数改用在库稿件数（列表与计数不打架）', /个在库稿件/.test(ui));
  /* 隐藏只发生在显示层：服务端照旧把 gone 行交给接口（上面的行为断言已经验过一遍） */
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.ts'), 'utf8');
  ok('服务端照旧返回 gone 行（不是靠删数据来隐藏）', /p\?\.gone \? \{ gone: true \}/.test(serverSrc));
}

ui.stop();
orch.stop();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
