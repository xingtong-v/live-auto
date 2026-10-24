/**
 * 稿件表现接口「安全上限 / 三口径计数 / 新稿件可见性」的独立验收（QA，2026-10-24）。
 *
 * 背景：用户报「为什么只能获取 2 个」。根因是 `performanceView()` 在**按播放降序**之后
 * `.slice(0, 100)` —— 当天新投的低播放稿件排在 100 名之外，整行被切掉；头部「N 个在库稿件」
 * 又用返回行数算，271 被显示成 100。
 *
 * `test/performance-reflux.ts` 的第 ④ 段已经验过「141 而行全部返回」这条主干。
 * 这个套件只补它**没覆盖**的三类极端情形（避免把 115 条断言的那套再抄一遍）：
 *   ① 真触发 `MAX_PERF_ROWS`（5000）时，被丢掉的是**最旧的**，不是播放最低的；
 *   ② 无发布时间（无法判断新旧）的行在上限分支里排最后（行为记录，防止有人误以为"保新"失效）；
 *   ③ 271 行量级下的新稿件可见性、前端按发布时间排序的效果、以及响应字节数；
 *      外加 `archiveTotal / liveTotal / livePartTotal / partTotal` 四个口径的手算核对。
 *
 * 三条硬约束（与 isolation.ts 同一套要求）：
 *   · 用临时目录起 UiServer（不碰真实 data/、不重启用户正在跑的服务、不调网络）；
 *   · 前端逻辑从 `public/ui.html`（构建产物）里**原样摘出来执行**，不抄一份"我以为的实现"；
 *   · 跑完断言真实 `data/` 一个字节没动。
 *
 * 运行：node test/performance-cap.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';
import { ROOT_DIR } from '../src/util.ts';

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
  ok(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/* ── 真实 data/ 快照：本套件只读接口，必须一个字节都不动 ─────────────────── */
const REAL_DATA = path.join(ROOT_DIR, 'data');
const EXCLUDE = new Set(['logs', 'verify-shots', 'trash']);
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(REAL_DATA)) return out;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(REAL_DATA, full).replace(/\\/g, '/');
      if (rel.split('/').some((seg) => EXCLUDE.has(seg))) continue;
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const st = fs.statSync(full);
      out.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`);
    }
  };
  walk(REAL_DATA);
  return out;
}

const realBefore = snapshot();

/** 探测本机端口是否有人监听（用来判断"用户的实时服务此刻是否在写 data/"）。
 *  只连回环、300ms 超时，不发任何请求。 */
async function isPortOpen(port: number): Promise<boolean> {
  const net = await import('node:net');
  return await new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean): void => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(300);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/* ── 隔离环境：临时目录 + 真 UiServer（不 start 流水线，避免任何副作用） ─────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-perf-cap-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const perfPath = path.join(dataDir, 'performance.jsonl');
const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
const orch = new Orchestrator({ ledger, dataDirOverride: dataDir });
orch.logger.setConsole(false);
const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
await ui.start();
const BASE = ui.url;

const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD，与台账 fmtDate 同口径
const nowSec = Math.floor(Date.now() / 1000);

type PerfLine = {
  bvid: string;
  date: string;
  at: string;
  view?: number;
  title?: string;
  score?: number;
  parts?: number;
  pubdate?: number;
  gone?: boolean;
  unavailable?: string;
};

/** 直接按 performance.jsonl 的真实行格式落盘（和 ledger.recordPerformance 写出的一样；
 *  这里一次写完整文件而不是逐条 appendJsonl —— 5000+ 条逐个开关文件的代价没有必要）。 */
function writePerf(rows: PerfLine[]): void {
  fs.writeFileSync(perfPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

async function getPerf(): Promise<{ body: Record<string, unknown>; bytes: number; rows: Array<Record<string, unknown>> }> {
  const r = await fetch(BASE + '/api/performance');
  const txt = await r.text();
  const body = JSON.parse(txt) as Record<string, unknown>;
  return { body, bytes: Buffer.byteLength(txt), rows: (body['rows'] ?? []) as Array<Record<string, unknown>> };
}

/** 服务端 `publishedAt` 是本地时间串（`YYYY-MM-DD HH:mm:ss`），按它取毫秒 */
function timeOf(row: Record<string, unknown>): number {
  const s = String(row['publishedAt'] ?? '');
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : Number.NaN;
}

console.log('\x1b[1m稿件表现接口：安全上限 / 三口径 / 新稿件可见性\x1b[0m（无网络、不碰真实 data/）');
console.log('─'.repeat(78));
console.log(`  隔离目录：${dataDir}`);

/* ========================================================================== */
section('① 真触发上限（5000）：丢掉的是**最旧的**，不是播放最低的');
/* 造 5100 行：最旧 150 行的播放**最高**（999999 起），最新 4950 行播放只有 1。
   旧实现按播放降序截断 ⇒ 丢的是"播放最低"（＝最新的 100 行，正是用户想要的稿件）；
   新实现按发布时间降序截断 ⇒ 丢的是最旧的 100 行，哪怕它们是播放冠军。 */
{
  const OLD = 150;
  const NEW = 4950;
  const lines: PerfLine[] = [];
  for (let i = 0; i < OLD; i++) {
    lines.push({
      bvid: `BV1CAPOLD${String(i).padStart(5, '0')}`,
      date: today,
      at: new Date().toISOString(),
      view: 999999 + i,
      title: `很旧但播放很高 ${i}`,
      parts: 1,
      pubdate: nowSec - 200 * 86400 + i,
    });
  }
  for (let i = 0; i < NEW; i++) {
    lines.push({
      bvid: `BV1CAPNEW${String(i).padStart(5, '0')}`,
      date: today,
      at: new Date().toISOString(),
      view: 1,
      title: `很新但没播放 ${i}`,
      parts: 1,
      pubdate: nowSec - i,
    });
  }
  writePerf(lines);

  const { body, rows, bytes } = await getPerf();
  eq('归档口径 archiveTotal = 5100（全量，不受截断影响）', body['archiveTotal'], OLD + NEW);
  eq('★ 返回行数被安全上限截到 5000', rows.length, 5000);
  eq('★ 超出上限时如实给 truncated=true（不静默丢行）', body['truncated'], true);
  ok('说明里点明「按发布时间保留」而不是按播放', String(body['note']).includes('按**发布时间**保留最新的 5000 行'), String(body['note']).slice(-120));

  const keptBvids = new Set(rows.map((r) => String(r['bvid'])));
  const droppedOld = lines
    .slice(0, OLD)
    .map((l) => l.bvid)
    .filter((b) => !keptBvids.has(b));
  const keptNew = lines.slice(OLD).filter((l) => keptBvids.has(l.bvid));
  eq('★ 最新 4950 行一个不丢', keptNew.length, NEW);
  eq('★ 被丢掉的正好是最旧的 100 行', droppedOld.length, 100);
  eq(
    '★ 被丢掉的确实是最旧的那 100 个（不含任何一个较新的旧行）',
    droppedOld.sort(),
    lines
      .slice(0, OLD)
      .map((l) => l.bvid)
      .sort()
      .slice(0, 100),
  );
  /* 关键对照：新稿件那 4950 行的播放全是 1（全场最低），被丢的 100 行播放都是 999999+。
     如果截断看的是播放，被丢的必然是最低的那 100 行（＝新稿件）—— 断言正好相反，
     才能证明判据真的是发布时间。 */
  const droppedViews = lines
    .slice(0, OLD)
    .filter((l) => !keptBvids.has(l.bvid))
    .map((l) => Number(l.view));
  const keptNewViews = lines
    .slice(OLD)
    .filter((l) => keptBvids.has(l.bvid))
    .map((l) => Number(l.view));
  ok('夹具成立：旧稿件播放全部高于新稿件', Math.min(...lines.slice(0, OLD).map((l) => Number(l.view))) > Math.max(...lines.slice(OLD).map((l) => Number(l.view))));
  ok(
    '★ 截断没有看播放：被丢的 100 行播放 ≥ 999999，而保留下来的 4950 行新稿件播放只有 1',
    droppedViews.length === 100 && keptNewViews.length === NEW && Math.min(...droppedViews) > Math.max(...keptNewViews),
    `被丢最小播放=${Math.min(...droppedViews)}，保留新稿件最大播放=${Math.max(...keptNewViews)}`,
  );
  /* 截断分支的返回顺序是发布时间降序（前端会按用户选的字段重排，这里只锁"最新在最前"） */
  const times = rows.map(timeOf);
  ok(
    '截断分支按发布时间降序返回（最新的一行在最前）',
    times.every((t, i) => i === 0 || (times[i - 1] ?? 0) >= t),
    JSON.stringify(times.slice(0, 3)),
  );
  ok(`5100 行时响应 ${bytes} 字节（本机可接受）`, bytes > 0 && bytes < 4 * 1024 * 1024, String(bytes));
}

/* ========================================================================== */
section('② 上限分支里「没有发布时间」的行排最后（拿不到新旧就先丢，行为记录）');
/* 5000 行有发布时间 + 5 行没有：5 行拿不到发布时间 ⇒ 排序键 0 ⇒ 沉底被丢。
   这不是 bug（代码里写明了判据），但必须**锁住**，免得将来有人改成"随机丢"却没人发现：
   锁的方式是"被丢的正好是没有发布时间的那 5 行"。 */
{
  const lines: PerfLine[] = [];
  for (let i = 0; i < 5000; i++) {
    lines.push({ bvid: `BV1CAPT${String(i).padStart(6, '0')}`, date: today, at: new Date().toISOString(), view: 10, pubdate: nowSec - i });
  }
  const noPub = [0, 1, 2, 3, 4].map((i) => `BV1CAPNOPUB${i}`);
  for (const bvid of noPub) {
    // 播放很高、但 performance.jsonl 里没有 pubdate（老记录 / 台账也没有切片时取不到）
    lines.push({ bvid, date: today, at: new Date().toISOString(), view: 888888 });
  }
  writePerf(lines);

  const { body, rows } = await getPerf();
  eq('archiveTotal 仍是 5005', body['archiveTotal'], 5005);
  eq('返回 5000 行', rows.length, 5000);
  const kept = new Set(rows.map((r) => String(r['bvid'])));
  eq(
    '★ 被丢掉的正好是 5 行「没有发布时间」的（播放高也保不住 —— 判据是发布时间，不是播放）',
    noPub.filter((b) => !kept.has(b)),
    noPub,
  );
}

/* ========================================================================== */
section('③ 四个计数口径手算核对（archiveTotal / liveTotal / livePartTotal / partTotal）');
/* 手算表（5 行，2 行是 B站 上已不存在的 gone）：
 *   A view=100 parts=3               → 在库
 *   B view=50  parts=1 gone=true     → 已不存在（不进 live）
 *   C 没有 view（未拉取）parts=1      → 在库
 *   D view=20  parts=2 gone=true     → 已不存在（不进 live）
 *   E view=10  parts=1               → 在库（没有发布时间）
 * archiveTotal = 5（含 gone，语义与旧版一致）
 * liveTotal    = 5 - 2 = 3
 * livePartTotal= 3 + 1 + 1 = 5（只算 A/C/E）
 * partTotal    = 3+1+1+2+1 = 8（全量，含 gone）
 * pulledTotal  = 4（A/B/D/E 都有 view；C 是"未拉取"）
 */
{
  const lines: PerfLine[] = [
    { bvid: 'BV1CAPCNT0001', date: today, at: new Date().toISOString(), view: 100, parts: 3, title: 'A', pubdate: nowSec - 10 },
    { bvid: 'BV1CAPCNT0002', date: today, at: new Date().toISOString(), view: 50, parts: 1, title: 'B', gone: true, pubdate: nowSec - 20 },
    { bvid: 'BV1CAPCNT0003', date: today, at: new Date().toISOString(), parts: 1, title: 'C', pubdate: nowSec - 30 },
    { bvid: 'BV1CAPCNT0004', date: today, at: new Date().toISOString(), view: 20, parts: 2, title: 'D', gone: true, pubdate: nowSec - 40 },
    { bvid: 'BV1CAPCNT0005', date: today, at: new Date().toISOString(), view: 10, parts: 1, title: 'E' },
  ];
  writePerf(lines);

  const { body, rows } = await getPerf();
  eq('返回行数 = 5（全量，gone 行也照旧交给前端，由前端决定隐藏）', rows.length, 5);
  eq('truncated=false（没触上限）', body['truncated'], false);
  eq('★ archiveTotal = 5（含 gone，语义与旧版一致）', body['archiveTotal'], 5);
  eq('★ liveTotal = 3（= archiveTotal - 2 个 gone）', body['liveTotal'], 3);
  eq('★ livePartTotal = 5（只算 A3+C1+E1，不含 gone 的 B1/D2）', body['livePartTotal'], 5);
  eq('partTotal = 8（全量含 gone）', body['partTotal'], 8);
  eq('pulledTotal = 4（A/B/D/E 都有播放数字，C 是未拉取）', body['pulledTotal'], 4);
  ok(
    '三个口径互相自洽：liveTotal = 非 gone 行数，livePartTotal 只对非 gone 行求和',
    body['liveTotal'] === rows.filter((r) => r['gone'] !== true).length &&
      body['livePartTotal'] ===
        rows.filter((r) => r['gone'] !== true).reduce((a, r) => a + Number(r['partCount'] ?? 1), 0),
    JSON.stringify({ liveTotal: body['liveTotal'], livePartTotal: body['livePartTotal'] }),
  );
  eq('gone 行仍然带 publishedAt（它能被排序、不会沉底到看不见）', typeof rows.find((r) => r['bvid'] === 'BV1CAPCNT0002')?.['publishedAt'], 'string');
}

/* ========================================================================== */
section('④ 271 行量级：新稿件可见 + 前端按发布时间排序真的排到最前 + 响应字节数');
/* 250 个「60 天前投的、播放高」+ 21 个「今天投的、播放 0~2」。
   用户看到的现象：按发布时间降序，这 21 个必须全在最前面 —— 一条都不能因为播放低被藏起来。 */
const fixture271: Array<Record<string, unknown>> = [];
{
  const OLD = 250;
  const FRESH = 21;
  const lines: PerfLine[] = [];
  for (let i = 0; i < OLD; i++) {
    lines.push({
      bvid: `BV1CAPD${String(i).padStart(6, '0')}`,
      date: today,
      at: new Date().toISOString(),
      view: 5000 - i,
      title: `60 天前投的 ${i}`,
      score: 8,
      parts: 1,
      pubdate: nowSec - 60 * 86400 + i,
    });
  }
  const freshBvids: string[] = [];
  for (let i = 0; i < FRESH; i++) {
    const bvid = `BV1CAPFRESH${String(i).padStart(3, '0')}`;
    freshBvids.push(bvid);
    lines.push({
      bvid,
      date: today,
      at: new Date().toISOString(),
      view: i % 3, // 0 / 1 / 2 —— 播放几乎垫底，正是旧实现被切掉的那批
      title: `今天新投的 ${i}`,
      score: 9,
      parts: 1,
      pubdate: nowSec - i,
    });
  }
  writePerf(lines);

  const { body, rows, bytes } = await getPerf();
  eq('271 行：返回行数 = archiveTotal = 271', [rows.length, body['archiveTotal']], [271, 271]);
  eq('truncated=false', body['truncated'], false);
  eq('liveTotal = 271（没有 gone）', body['liveTotal'], 271);
  console.log(`  \x1b[90m· 271 行的 /api/performance 响应体积 = ${bytes} 字节（${(bytes / 1024).toFixed(1)} KB）\x1b[0m`);
  ok('响应体积在本机可以接受（< 1 MB）', bytes < 1024 * 1024, String(bytes));

  const kept = new Set(rows.map((r) => String(r['bvid'])));
  eq('★ 21 个新稿件一个不少（旧实现按播放截断会丢掉播放 0/1/2 的）', freshBvids.filter((b) => !kept.has(b)), []);
  for (const bvid of freshBvids) {
    const row = rows.find((r) => r['bvid'] === bvid)!;
    eq(`${bvid} 的播放是真实数字（0 也是数字，不是"没拉取"）`, typeof row['view'], 'number');
    eq(`${bvid} 带发布时间`, typeof row['publishedAt'], 'string');
  }

  for (const r of rows) fixture271.push(r);
}

/* ── 前端逻辑：从构建产物 public/ui.html 里原样摘出来执行 ──────────────────── */
const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'ui.html'), 'utf8');

function extractFunction(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`public/ui.html 里找不到 ${marker}（构建产物过期？先跑 npm run build:ui）`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${marker} 的大括号不配对`);
}

/** 按行剥掉注释，用于"代码里是否还残留某个写法"的检查。
 *
 *  为什么需要剥注释：本次修复的说明注释里**原样引用了旧代码** ``[...scored, ...].slice(0, 100)``，
 *  直接正则匹配源码会把"讲解旧 bug 的注释"误判成"bug 还在"。
 *
 *  为什么用按行扫描而不是完整词法分析：`performanceView` 体内既没有含 `/*` 的字符串、
 *  也没有跨行字符串，按行数 `/* ... *\/` 就够准；而完整词法分析一旦被模板字符串里的嵌套反引号
 *  带偏，反而会静默把代码当注释丢掉（更危险）。含 `//` 的字符串（B站链接）会被多剥一点，
 *  但那次检查只是"辅助证据"，真正的判据是 ① 段的行为断言（5100 行 → 5000 行）。 */
function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let code = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) {
          i = line.length;
          break;
        }
        inBlock = false;
        i = end + 2;
        continue;
      }
      const open = line.indexOf('/*', i);
      const lineCmt = line.indexOf('//', i);
      if (lineCmt >= 0 && (open < 0 || lineCmt < open)) {
        code += line.slice(i, lineCmt);
        break;
      }
      if (open < 0) {
        code += line.slice(i);
        break;
      }
      code += line.slice(i, open);
      inBlock = true;
      i = open + 2;
    }
    out.push(code);
  }
  return out.join('\n');
}

const perfTimeMsSrc = extractFunction(uiHtml, 'function perfTimeMs(');
const sortPerfRowsSrc = extractFunction(uiHtml, 'function sortPerfRows(');
/** 用**页面自己的** sortPerfRows（含它的沉底规则与同值兜底），不是测试里另写一份 */
function makeSorter(key: string, asc: boolean): (rs: Array<Record<string, unknown>>) => Array<Record<string, unknown>> {
  const factory = new Function('perfSort', 'perfSortAsc', `${perfTimeMsSrc}\n${sortPerfRowsSrc}\nreturn sortPerfRows;`);
  return factory(key, asc) as (rs: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
}

section('⑤ 前端：按发布时间降序，今天新投的 21 个必须排在最前（用页面自己的 sortPerfRows）');
{
  const byTimeDesc = makeSorter('publishedAt', false)(fixture271);
  eq('排序后仍然是 271 行（排序不丢行）', byTimeDesc.length, 271);
  const top21 = byTimeDesc.slice(0, 21).map((r) => String(r['bvid']));
  const freshSet = new Set(fixture271.filter((r) => String(r['bvid']).startsWith('BV1CAPFRESH')).map((r) => String(r['bvid'])));
  eq('★ 前 21 行正好是今天新投的那 21 个（一条不多一条不少）', top21.filter((b) => freshSet.has(b)).length, 21);
  ok('★ 前 21 行里没有混进 60 天前的老稿件', !top21.some((b) => b.startsWith('BV1CAPD')), top21.slice(0, 5).join(','));
  const times = byTimeDesc.map(timeOf);
  ok(
    '整表按发布时间降序（服务端返回的顺序被前端重排了，这才是用户看到的）',
    times.every((t, i) => i === 0 || (times[i - 1] ?? 0) >= t),
    JSON.stringify(times.slice(0, 3)),
  );

  /* 反证：如果按**播放**降序（旧实现的默认视图），这 21 个一定排在最后 —— 这就是旧 bug 的观感 */
  const byViewDesc = makeSorter('view', false)(fixture271);
  const tail21 = byViewDesc.slice(-21).map((r) => String(r['bvid']));
  eq('★ 反证：按播放降序时这 21 个全在最后 21 行（旧实现截断 100 条 ⇒ 整行消失）', tail21.filter((b) => freshSet.has(b)).length, 21);

  /* 折叠：表格只渲染前 20 条（用户 2026-10-17 的要求），但「展开」后 271 条都在手里 */
  ok('页面仍是「默认折叠 20 条」的口径（PERF_PAGE = 20）', /const PERF_PAGE = 20;/.test(uiHtml));
  ok('展开后能拿到全部 271 行（前端不再被接口截断）', byTimeDesc.length > 20);
}

section('⑥ 前端头部计数：新字段优先，老服务端（没有 liveTotal）回退本地求和');
{
  const startIdx = uiHtml.indexOf('const liveTotal =');
  const endIdx = uiHtml.indexOf('box.innerHTML', startIdx);
  ok('能在构建产物里定位到头部计数那两行', startIdx > 0 && endIdx > startIdx, `${startIdx}/${endIdx}`);
  const countSrc = startIdx > 0 && endIdx > startIdx ? uiHtml.slice(startIdx, endIdx) : '';
  const makeCounts = (p: Record<string, unknown>, live: Array<Record<string, unknown>>) => {
    const factory = new Function('p', 'live', `${countSrc}\nreturn { liveTotal, livePartTotal };`);
    return factory(p, live) as { liveTotal: number; livePartTotal: number };
  };

  /* 新服务端：直接信服务端的全量口径（271 个在库、512 个分P） */
  const fresh = makeCounts({ liveTotal: 271, livePartTotal: 512 }, []);
  eq('★ 新响应：头部用服务端的 liveTotal（271，不是"返回行数"）', fresh.liveTotal, 271);
  eq('★ 新响应：头部用服务端的 livePartTotal（512）', fresh.livePartTotal, 512);

  /* 老服务端：没有这两个字段 ⇒ 退回对"前端拿到的行"求和，不许崩也不许变成 NaN/0 */
  const oldLive = [
    { partCount: 3 },
    { partCount: undefined }, // 缺字段按 1 算
    { partCount: 2 },
  ];
  const legacy = makeCounts({ archiveTotal: 3, rows: oldLive }, oldLive);
  eq('老响应（无 liveTotal）：回退成"行数"', legacy.liveTotal, 3);
  eq('老响应（无 livePartTotal）：回退成"按行求和，缺字段当 1"', legacy.livePartTotal, 6);

  /* 只给了一半（比如灰度/中间版本）：有值的用服务端，缺的回退 */
  const half = makeCounts({ liveTotal: 271 }, [{ partCount: 2 }]);
  eq('半新半旧：liveTotal 用服务端的', half.liveTotal, 271);
  eq('半新半旧：livePartTotal 回退本地求和', half.livePartTotal, 2);

  /* 截断时页面必须说出来（不静默） */
  ok('★ 截断说明写在卡片头上（"仅显示最新 N 个"）', /仅显示最新 \$\{p\.rows\.length\} 个/.test(uiHtml));
  ok('确实只有一份 /api/performance 的读取点（没有别处硬依赖 ≤100 行）', (uiHtml.match(/api\('\/api\/performance'\)/g) ?? []).length === 1);

  /* 服务端实现层：确认"按播放截断"没有残留，且上限分支的排序键是发布时间。
     ⚠️ 必须先剥掉注释再查 —— 修复说明里**原样引用了**旧代码 `slice(0, 100)`，
     直接正则匹配源码会把"讲解旧 bug 的注释"当成"bug 还在"。 */
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.ts'), 'utf8');
  const serverCode = stripComments(serverSrc);
  ok(
    '剥注释后仍能找到 performanceView（确认剥注释没把代码剥没了）',
    /private performanceView\(\): Record<string, unknown>/.test(serverCode),
  );
  ok(
    '★ 服务端**代码**里没有 slice(0, 100) 残留（注释里那段引用不算）',
    !/slice\(0,\s*100\)/.test(serverCode),
    (serverCode.match(/.{0,60}slice\(0,\s*100\).{0,40}/) ?? [''])[0],
  );
  ok('★ 服务端上限常量是 5000', /const MAX_PERF_ROWS = 5000;/.test(serverCode));
  ok(
    '★ 上限分支按 publishedAt 排序后保留（不是按 view）',
    /sort\(\(a, b\) => timeOf\(b\) - timeOf\(a\)\)\.slice\(0, MAX_PERF_ROWS\)/.test(serverCode),
    'timeOf 排序缺失',
  );
  ok('★ performanceView 里对 rows 只做了一次"按播放降序"排序（给相关性表与默认顺序用，不再据此截断）', (serverCode.match(/Number\(b\['view'\] \?\? 0\) - Number\(a\['view'\] \?\? 0\)/g) ?? []).length === 1);
}

/* ========================================================================== */
section('⑦ 收尾：真实 data/ 没被本套件动过');
{
  /* 为什么要分两档：用户此刻可能**正在跑实时服务**（127.0.0.1:3000），流水线会持续往
     `data/clips/**` 写切片 mp4、往 `data/performance.jsonl` 追加回流记录
     （实测跑这一套件的同时有一个 118 MB 的 mp4 在增长、performance.jsonl 也在长）。
     那是外部进程的正常产出，与本套件无关 —— 所以先探测 3000 端口：
       · 没人监听 → 硬断言 data/ 一个字节没动（这才是"测试污染真实数据"的判据，CI 上有效）；
       · 有实时服务在跑 → 变化无法归因于本套件，降级为提示 + 打印变化清单，绝不假装通过。 */
  const liveRunning = await isPortOpen(3000);
  const realAfter = snapshot();
  const rootLevel = (rel: string): boolean => !rel.includes('/');
  const changedRoot: string[] = [];
  const changedOther: string[] = [];
  for (const [k, v] of realAfter) {
    if (!realBefore.has(k)) changedRoot.push(`+${k}`);
    else if (realBefore.get(k) !== v) changedRoot.push(`~${k}`);
  }
  for (const k of realBefore.keys()) if (!realAfter.has(k)) changedRoot.push(`-${k}`);
  for (const k of realBefore.keys()) {
    const after = realAfter.get(k);
    if (after !== undefined && after !== realBefore.get(k) && !rootLevel(k)) changedOther.push(`~${k}`);
  }
  for (const k of realAfter.keys()) if (!realBefore.has(k) && !rootLevel(k)) changedOther.push(`+${k}`);

  if (liveRunning) {
    console.log('  \x1b[90m· 检测到 127.0.0.1:3000 上有实时服务在跑：data/ 的变化无法归因于本套件，隔离断言降级为提示\x1b[0m');
    if (changedRoot.length) console.log(`  \x1b[90m  data/ 一级变化：${changedRoot.slice(0, 8).join(', ')}\x1b[0m`);
    ok('（隔离断言跳过：实时服务在跑）本套件仅用临时目录 + 只读接口，未指向真实 data/', true);
  } else {
    ok(
      '★ 真实 data/ 的一级文件（ledger.json / performance.jsonl / config.json…）一个字节没动',
      changedRoot.length === 0,
      changedRoot.slice(0, 8).join(', '),
    );
  }
  const unexpected = changedOther.filter((k) => !k.includes('clips/'));
  ok(
    '除 data/clips/（实时服务正在切片）外没有其它文件变化' + (liveRunning ? '（同上：仅提示口径）' : ''),
    liveRunning || unexpected.length === 0,
    `实时服务=${liveRunning}；变化=${unexpected.slice(0, 8).join(', ')}`,
  );
  const external = changedOther.filter((k) => k.includes('clips/'));
  if (external.length) {
    console.log(`  \x1b[90m· 已知外部噪声：${external.length} 个 data/clips/ 下的 mp4 在变（端口 3000 的实时服务在写，非本套件）\x1b[0m`);
  }
}

ui.stop();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
