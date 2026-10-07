/**
 * 墓碑**自动核对**自测 —— 锁住「查不到的自动解除，证据不足的一律保留」（2026-10-07 用户要求）。
 *
 * ## 为什么要有这道核对
 *
 * 墓碑是「这段内容以前投过 B站、而当时的任务被删了」的防重复保险，但它**没有自动过期**，
 * 只能人工逐条解除。实测健康面板上挂了 **118 条**，其中 112 条连 bvid 都没反查到（当年只走到「已提交」），
 * 用户只能一条条去创作中心翻 —— 于是要求「查不到的 自动解除」。
 *
 * ## 判定表（本测试逐条锁住）
 *
 * | 情形 | 结论 |
 * |---|---|
 * | 有 bvid，且它还在我的稿件列表里 | 保留 |
 * | 有 bvid，列表拿全了却没有它，且详情明确报「不存在」 | **解除** |
 * | 有 bvid，列表没拿全 / 详情报的是别的错 | 保留（证据不足） |
 * | 没有 bvid，但按分P 标题在某份稿件里找到了同一段内容 | 保留，并**补记 bvid** |
 * | 没有 bvid，可能相关的稿件都读到了、都没有这一段 | **解除** |
 * | 没有 bvid，可能相关的那份稿件 B站 侧已锁定/读不到 | **解除**，但单独计数、依据里写明是哪份稿件 |
 * | 没有 bvid，可能相关的**公开**稿件这次没拉到（限流/超时） | 保留（下次再试，不用残缺证据放行） |
 * | 稿件列表可能被截断（返回条数 == 一页） | 一律不解除 |
 * | dryRun | 只报告，台账一条都不动 |
 *
 * 另外两条**必须**成立的安全性质：
 *   ① 解除一定留痕（`publish-log.jsonl` 里 `tombstone-release`，写明依据）；
 *   ② 与立碑时间无关的稿件（±24h 以外）读不到，不算拦路石 —— 否则那两份「已锁定」的稿件
 *      会让 58 条永远停在"证据不足"（第一版实测就是这样，一条都放不掉）。
 *
 * 运行：node test/tombstone-reconcile.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { reconcileTombstones, TOMBSTONE_LIST_PAGE_SIZE } from '../src/tombstone-reconcile.ts';
import type { ClipRecord } from '../src/types.ts';

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
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-tomb-reconcile-'));
const now = new Date().toISOString();
const nowSec = Math.floor(Date.now() / 1000);

type Archive = { bvid: string; title?: string; ctime?: number; state?: number };
type DetailSpec = { parts?: string[]; error?: string };
interface Mock extends Record<string, unknown> {
  biliArchives(params: { page?: number; pageSize?: number }): Promise<Archive[]>;
  biliArchiveDetail(bvid: string, opts?: { retry?: number }): Promise<Record<string, unknown>>;
}
/** 一份可控的假 client：稿件列表 + 每份稿件的详情（可以给 parts、也可以给错误） */
function mockClient(archives: Archive[], details: Record<string, DetailSpec>): Mock {
  return {
    biliArchives: async (p) => archives.slice(0, p.pageSize ?? TOMBSTONE_LIST_PAGE_SIZE),
    biliArchiveDetail: async (bvid) => {
      const d = details[bvid];
      if (!d) throw new Error('稿件不存在或已被删除');
      if (d.error) throw new Error(d.error);
      return { View: { bvid, videos: (d.parts ?? []).length, pages: (d.parts ?? []).map((part) => ({ part, duration: 60 })) } };
    },
  };
}

function mkClip(index: number, over: Partial<ClipRecord> = {}): ClipRecord {
  return {
    index,
    start: 0,
    end: 60,
    title: `切片 ${index}`,
    desc: '',
    tags: [],
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

let seq = 0;
/** 造一个只带**一条**墓碑的台账（已投出去过 → 删任务 → 立碑） */
function tombLedger(opts: { title: string; bvid?: string }): { ledger: Ledger; fp: string; taskId: string } {
  const dir = path.join(tmp, `l${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const ledger = new Ledger({ path: path.join(dir, 'ledger.json') });
  const taskId = `auto-2026100712000${seq}-test`;
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    platform: 'Bilibili',
    title: '测试场次',
    status: 'CLIPPED',
    stage: 'CLIPPED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now,
  } as never);
  const bvid = opts.bvid;
  ledger.setClips(taskId, [
    mkClip(0, { title: opts.title, status: bvid ? 'PUBLISHED' : 'SUBMITTED', ...(bvid ? { bvid } : {}) }),
  ]);
  const fp = `fp-${seq}-${opts.title.slice(0, 6)}`;
  ledger.registerFingerprint(fp, { taskId, clipIndex: 0, ...(bvid ? { bvid } : {}) });
  ledger.deleteTask(taskId);
  return { ledger, fp, taskId };
}

/* ========================================================================== */
section('① 有 bvid：在列表里 = 保留；列表没有 + 详情说没了 = 解除');
{
  const a = tombLedger({ title: '旧稿件还在的切片', bvid: 'BV1KEEP00001' });
  const r1 = await reconcileTombstones({
    ledger: a.ledger,
    client: mockClient([{ bvid: 'BV1KEEP00001', title: '那场的完整版', ctime: nowSec - 600, state: 0 }], {}),
    logger: silentLog as never,
    paceMs: 0,
  });
  eq('还在列表里 ⇒ 保留', r1.kept, 1);
  eq('一条都没解除', r1.released, 0);
  eq('理由说清了"旧稿件还在"', r1.keptList[0]?.why.includes('还在我的稿件列表'), true);
  eq('台账里墓碑还在', a.ledger.tombstoneCount(), 1);

  const b = tombLedger({ title: '旧稿件已经删了的切片', bvid: 'BV1GONE00001' });
  const r2 = await reconcileTombstones({
    ledger: b.ledger,
    // 列表拿全（只有 1 条 < 一页），没有 BV1GONE00001；详情抛「不存在」
    client: mockClient([{ bvid: 'BV1OTHER0001', title: '别的稿件', ctime: nowSec - 600, state: 0 }], {
      BV1OTHER0001: { parts: ['无关分P'] },
    }),
    logger: silentLog as never,
    paceMs: 0,
  });
  eq('★ 列表没有 + 详情报不存在 ⇒ 解除', r2.released, 1);
  eq('不是"锁定读不到"那一类', r2.inaccessibleReleases, 0);
  eq('台账里墓碑没了', b.ledger.tombstoneCount(), 0);
  const log = fs.readFileSync(path.join(path.dirname(b.ledger.path), 'publish-log.jsonl'), 'utf8');
  ok('★ 解除留痕（publish-log 里写了解除依据）', log.includes('tombstone-release') && log.includes('自动核对解除'), log.slice(0, 200));
}

/* ========================================================================== */
section('② 有 bvid：详情报的是别的错（限流/500 且没锁定）⇒ 保留，不用残缺证据放行');
{
  const c = tombLedger({ title: '详情这次拉不动的切片', bvid: 'BV1FLAKY0001' });
  const r = await reconcileTombstones({
    ledger: c.ledger,
    client: mockClient([{ bvid: 'BV1OTHER0002', title: '别的稿件', ctime: nowSec - 600, state: 0 }], {
      BV1OTHER0002: { parts: ['无关分P'] },
      // 该墓碑的旧稿件不在列表里，但详情报的是**限流**而不是"不存在" ⇒ 不能当成已删
      BV1FLAKY0001: { error: '接口限流（HTTP 429）' },
    }),
    logger: silentLog as never,
    paceMs: 0,
  });
  eq('保留（证据不足）', r.unverified, 1);
  eq('没解除', r.released, 0);
  eq('台账里墓碑还在', c.ledger.tombstoneCount(), 1);
}

/* ========================================================================== */
section('③ 没有 bvid：按分P 标题找到 = 保留并补记 bvid（面板不再显示"未反查到"）');
{
  const d = tombLedger({ title: '甲主播清唱《虚拟》走调自嘲' });
  const r = await reconcileTombstones({
    ledger: d.ledger,
    client: mockClient([{ bvid: 'BV1FOUND0001', title: '那场的完整版', ctime: nowSec - 600, state: 0 }], {
      BV1FOUND0001: { parts: ['完整版', '甲主播清唱《虚拟》走调自嘲'] },
    }),
    logger: silentLog as never,
    paceMs: 0,
  });
  eq('保留', r.kept, 1);
  eq('没解除', r.released, 0);
  eq('按分P 标题找到了那份稿件', r.keptList[0]?.bvid, 'BV1FOUND0001');
  const t = d.ledger.listTombstones()[0];
  eq('★ 顺手补记了 bvid（这是"未反查到"变可核对的关键）', t?.bvid, 'BV1FOUND0001');
}

/* ========================================================================== */
section('④ 没有 bvid：可能相关的稿件都读到了、都没有这一段 ⇒ 解除');
{
  const e = tombLedger({ title: '哪儿都找不到的老切片' });
  const r = await reconcileTombstones({
    ledger: e.ledger,
    client: mockClient(
      [
        { bvid: 'BV1READ00001', title: '九月的完整版', ctime: nowSec - 600, state: 0 },
        { bvid: 'BV1READ00002', title: '十月的完整版', ctime: nowSec - 3600, state: 0 },
      ],
      { BV1READ00001: { parts: ['完整版', '别的切片'] }, BV1READ00002: { parts: ['纯享版'] } },
    ),
    logger: silentLog as never,
    paceMs: 0,
  });
  eq('★ 扫遍都没有 ⇒ 解除', r.released, 1);
  eq('这不算"锁定读不到"那一类', r.inaccessibleReleases, 0);
  eq('依据里写明扫了几份详情', r.releasedList[0]?.why.includes('读完 2 份详情'), true);
  eq('台账里墓碑没了', e.ledger.tombstoneCount(), 0);
}

/* ========================================================================== */
section('⑤ 没有 bvid + 可能相关的稿件已锁定读不到 ⇒ 解除，但要单独计数、依据写明是哪份');
{
  const f = tombLedger({ title: '乙主播吐槽新三国许攸田丰人设互换' });
  const r = await reconcileTombstones({
    ledger: f.ledger,
    client: mockClient(
      [{ bvid: 'BV1LOCKED001', title: '【2D】新三国36开始', ctime: nowSec - 600, state: -4 }],
      // B站 对已锁定稿件：公开接口 -404、详情 HTTP 500「啥都木有」—— 不能当成"稿件没了"
      { BV1LOCKED001: { error: 'biliLive-tools 内部错误（HTTP 500） —— 啥都木有' } },
    ),
    logger: silentLog as never,
    paceMs: 0,
  });
  eq('★ 解除', r.released, 1);
  eq('★ 单独计入"旧稿件已锁定/读不到"', r.inaccessibleReleases, 1);
  eq('依据里点名了那份锁定稿件', r.releasedList[0]?.why.includes('BV1LOCKED001'), true);
  ok('依据里没有谎称"扫遍都读到了"', !r.releasedList[0]!.why.includes('所有可能与它相关的稿件都读到了'), r.releasedList[0]!.why);
}

/* ========================================================================== */
section('⑥ 没有 bvid + 可能相关的**公开**稿件这次没拉到 ⇒ 保留（下次再试）');
{
  const g = tombLedger({ title: '这份公开稿件限流了' });
  const r = await reconcileTombstones({
    ledger: g.ledger,
    client: mockClient([{ bvid: 'BV1PUBLIC001', title: '那场的完整版', ctime: nowSec - 600, state: 0 }], {
      BV1PUBLIC001: { error: '接口限流（HTTP 429）' },
    }),
    logger: silentLog as never,
    paceMs: 0,
  });
  eq('保留（证据不足）', r.unverified, 1);
  eq('没解除', r.released, 0);
  eq('台账里墓碑还在', g.ledger.tombstoneCount(), 1);
}

/* ========================================================================== */
section('⑦ 与立碑时间无关的稿件读不到，不算拦路石（否则永远放不掉）');
{
  const h = tombLedger({ title: '跟那份锁定稿件毫无关系' });
  const r = await reconcileTombstones({
    ledger: h.ledger,
    client: mockClient(
      [
        // 这份已锁定稿件是 5 天前的另一场 ⇒ 不可能是这条墓碑的归宿
        { bvid: 'BV1OLDLOCK01', title: '五天前那场', ctime: nowSec - 5 * 86400, state: -4 },
        { bvid: 'BV1SAME00001', title: '本场完整版', ctime: nowSec - 600, state: 0 },
      ],
      { BV1OLDLOCK01: { error: '啥都木有' }, BV1SAME00001: { parts: ['完整版', '纯本场切片'] } },
    ),
    logger: silentLog as never,
    paceMs: 0,
  });
  eq('★ 无关的锁定稿件不挡路 ⇒ 解除', r.released, 1);
  eq('也不算"锁定读不到"那一类', r.inaccessibleReleases, 0);
}

/* ========================================================================== */
section('⑧ 稿件列表可能被截断（返回条数 == 一页）⇒ 一律不解除');
{
  const many: Archive[] = Array.from({ length: TOMBSTONE_LIST_PAGE_SIZE }, (_, i) => ({
    bvid: `BV1PAGE${String(i).padStart(5, '0')}`,
    title: `第 ${i} 个稿件`,
    ctime: nowSec - 600,
    state: 0,
  }));
  const i = tombLedger({ title: '列表可能被截断时的切片' });
  const r = await reconcileTombstones({
    ledger: i.ledger,
    client: mockClient(many, {}),
    logger: silentLog as never,
    paceMs: 0,
    detailCap: 3, // 详情调用受限 ⇒ 更不可能扫全
  });
  eq('一条都不解除', r.released, 0);
  eq('保留待下次', r.unverified + r.kept, 1);
  eq('台账里墓碑还在', i.ledger.tombstoneCount(), 1);
  ok('说明里点出列表可能被截断', r.notes.some((n) => n.includes('列表可能被截断')), JSON.stringify(r.notes).slice(0, 200));
}

/* ========================================================================== */
section('⑨ dryRun：只报告，台账一条都不动');
{
  const j = tombLedger({ title: '预演用的切片', bvid: 'BV1DRYRUN001' });
  const before = j.ledger.tombstoneCount();
  const r = await reconcileTombstones({
    ledger: j.ledger,
    client: mockClient([{ bvid: 'BV1OTHERDRY1', title: '别的稿件', ctime: nowSec - 600, state: 0 }], {}),
    logger: silentLog as never,
    paceMs: 0,
    dryRun: true,
  });
  eq('报告里说"会解除"', r.released, 1);
  eq('dryRun 标记为真', r.dryRun, true);
  eq('★ 台账里墓碑一条没少', j.ledger.tombstoneCount(), before);
  ok('说明里标了"预演"', r.notes.some((n) => n.includes('预演')), JSON.stringify(r.notes).slice(0, 160));
}

/* ========================================================================== */
section('⑩ 没有墓碑：不做任何请求');
{
  const dir = path.join(tmp, 'empty');
  fs.mkdirSync(dir, { recursive: true });
  const ledger = new Ledger({ path: path.join(dir, 'ledger.json') });
  let calls = 0;
  const r = await reconcileTombstones({
    ledger,
    client: {
      biliArchives: async () => {
        calls++;
        return [];
      },
      biliArchiveDetail: async () => {
        calls++;
        return {};
      },
    },
    logger: silentLog as never,
    paceMs: 0,
  });
  eq('核对 0 条', r.checked, 0);
  eq('一次接口都没打', calls, 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
