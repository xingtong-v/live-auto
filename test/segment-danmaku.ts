/**
 * **分段录播**的两件事：① 分段识别；② 分段弹幕的配对与合并。
 *
 * ## 起因（2026-09-24 真实直播中发现的漏洞）
 *
 * 用户在界面上看到「上一轮对每个文件的结论」里只有两个文件，其中一个显示
 * 「正在录制，等写完」，而**直播已经录到第三个 20 分钟了**。查下去发现两件事：
 *
 * ### ① 第 1 段会丢（`discoverSegments`）
 *
 * biliLive-tools 切段时的实际命名（实测 `丁主播` 那场）：
 *
 * ```
 * 2026-09-24 01-51-37-332 (⊙o⊙)？.ts            ← 第 1 段：**没有 PART 后缀**
 * 2026-09-24 01-51-37-332 (⊙o⊙)？-PART001.ts    ← 第 2 段
 * 2026-09-24 01-51-37-332 (⊙o⊙)？-PART002.ts    ← 第 3 段
 * ```
 *
 * 而 `discoverSegments` 只认 `-PART\d+`，于是：
 *   `discoverSegments('X.ts')` → **1 段**（看不见 PART001/002）
 *   `discoverSegments('X-PART001.ts')` → **2 段**（PART001+PART002，**第 1 段凭空消失**）
 *
 * 后果：一场 3×20 分钟的直播会变成两个任务，而且其中一个**从第 20 分钟才开始** ——
 * 前 20 分钟无声无息地丢掉，日志里一切"正常"。
 * （实测证据：`X.ts` 的 NTFS 创建时间 = 01:51:37 = 会话开始，修改时间 = 02:11:32 = 第 1 段结束，
 * 确认它就是第 1 段本体。）
 *
 * ### ② 第 2 段及以后没有弹幕（`danmaku-merge`）
 *
 * 录制器给**每一段单独存一个弹幕文件**，用的是「**该段自己的开始时刻**」：
 *
 * | 视频 | 弹幕 |
 * |---|---|
 * | `…01-51-37-332 (⊙o⊙)？.ts` | `…01-51-37-332 (⊙o⊙)？.xml` |
 * | `…01-51-37-332 (⊙o⊙)？-PART001.ts` | `…02-11-32-593 (⊙o⊙)？.xml` ← 前缀完全不同 |
 *
 * 所以「同名查找」和 `POST /record-history/danma-file`（实测对 `-PART001.ts` 返回**空**）
 * 都拿不到它。那些分段于是静默失去弹幕信号，选片降级成语音密度兜底。
 *
 * 运行：node --experimental-strip-types test/segment-danmaku.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSegments } from '../src/media.ts';
import {
  PAIR_TOLERANCE_SEC,
  chooseDanmaku,
  extractDanmakuItems,
  listDanmakuCandidates,
  listSegmentDanmaku,
  mergeDanmakuXmlFiles,
  pairSegmentDanmaku,
  pairSegmentDanmakuByTimestamp,
  parseTimestampFromName,
  segmentStartMs,
  stripTimestampPrefix,
  toSegmentLikes,
} from '../src/danmaku-merge.ts';
import { parseDanmakuXml } from '../src/danmaku.ts';

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
  ok(name, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-segdm-'));

/** 造一个目录并写入给定文件名（内容可选） */
function mkdirWith(names: Array<string | [string, string]>): string {
  const d = fs.mkdtempSync(path.join(tmp, 'd-'));
  for (const n of names) {
    const [name, content] = typeof n === 'string' ? [n, 'x'] : n;
    fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), content, 'utf8');
  }
  return d;
}

/** 一段弹幕 XML（时间相对本段起点） */
function xmlOf(chatid: string, rows: Array<[number, string]>): string {
  const ds = rows.map(([t, text]) => `  <d p="${t.toFixed(3)},1,25,16777215,1790000000000,0,user1,100,0">${text}</d>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<i>\n  <chatserver>chat.bilibili.com</chatserver>\n  <chatid>${chatid}</chatid>\n${ds}\n</i>\n`;
}

/* ========================================================================== */
section('① 分段识别：biliLive-tools 的第 1 段没有 PART 后缀（本次修复的核心）');
{
  const T = '2026-09-24 01-51-37-332 (⊙o⊙)？';
  const d = mkdirWith([
    `${T}.ts`,
    `${T}-PART001.ts`,
    `${T}-PART002.ts`,
    `${T}-弹幕版.mp4`,
    `${T}.xml`,
    '2026-09-24 02-11-32-593 (⊙o⊙)？.xml',
  ]);
  const want = [`${T}.ts`, `${T}-PART001.ts`, `${T}-PART002.ts`];

  for (const sample of [0, 1, 2]) {
    const segs = discoverSegments(path.join(d, want[sample]!));
    eq(`样本「${want[sample]!.slice(30)}」→ 3 段`, segs.map((s) => path.basename(s)), want);
  }
  ok('★ 第 1 段（基名文件）确实在组里', discoverSegments(path.join(d, want[0]!)).some((s) => path.basename(s) === want[0]!));
  ok(
    '★ 以 -PART001 为样本时第 1 段没有被丢掉（修复前这里只有 2 段）',
    discoverSegments(path.join(d, want[1]!)).length === 3,
    String(discoverSegments(path.join(d, want[1]!)).length),
  );
  ok(
    '弹幕文件（.xml）与压制产物（-弹幕版.mp4）都不会被算成分段',
    discoverSegments(path.join(d, want[0]!)).every((s) => s.endsWith('.ts')),
  );
  fs.rmSync(d, { recursive: true, force: true });
}

/* ========================================================================== */
section('② 分段识别：回归保护（老形态 / 单文件 / 不同场次 / 数值排序）');
{
  // 老形态：首段也带 _PART000
  const d1 = mkdirWith(['哈喽-PART000.ts', '哈喽-PART001.ts', '哈喽-PART002.ts']);
  eq(
    '老形态 `_PART000` 仍然合成 3 段',
    discoverSegments(path.join(d1, '哈喽-PART001.ts')).map((s) => path.basename(s)),
    ['哈喽-PART000.ts', '哈喽-PART001.ts', '哈喽-PART002.ts'],
  );
  fs.rmSync(d1, { recursive: true, force: true });

  // 单文件：不能被误合并
  const d2 = mkdirWith(['2026-09-24 01-34-08-285 (⊙o⊙)？.ts', '2026-09-24 01-34-08-285 (⊙o⊙)？.xml', '2026-09-24 01-34-08-285 (⊙o⊙)？-弹幕版.mp4']);
  eq('单文件仍然是 1 段（不能因为有了基名形态就乱合并）', discoverSegments(path.join(d2, '2026-09-24 01-34-08-285 (⊙o⊙)？.ts')).length, 1);
  fs.rmSync(d2, { recursive: true, force: true });

  // 同一天两场不同直播
  const d3 = mkdirWith(['2026-09-24 01-34-08-285 (⊙o⊙)？.ts', '2026-09-24 18-00-00-000 (⊙o⊙)？.ts']);
  eq('同一天两场不同直播各自 1 段（时间戳不同 → 不同场）', discoverSegments(path.join(d3, '2026-09-24 01-34-08-285 (⊙o⊙)？.ts')).length, 1);
  eq('第二场也是 1 段', discoverSegments(path.join(d3, '2026-09-24 18-00-00-000 (⊙o⊙)？.ts')).length, 1);
  fs.rmSync(d3, { recursive: true, force: true });

  // 数值排序
  const d4 = mkdirWith(['X-PART001.ts', 'X-PART002.ts', 'X-PART010.ts', 'X.ts']);
  eq(
    '分段按**数值**排序（PART002 在 PART010 之前）',
    discoverSegments(path.join(d4, 'X-PART010.ts')).map((s) => path.basename(s)),
    ['X.ts', 'X-PART001.ts', 'X-PART002.ts', 'X-PART010.ts'],
  );
  fs.rmSync(d4, { recursive: true, force: true });
}

/* ========================================================================== */
section('③ 文件名时间戳：解析与去前缀');
{
  eq('去前缀后剩下的就是场次标题', stripTimestampPrefix('2026-09-24 01-51-37-332 (⊙o⊙)？'), '(⊙o⊙)？');
  eq('另一种分隔符形态也要认', stripTimestampPrefix('2026_9_21 20_50_02 场直播'), '场直播');
  eq('没有时间戳时原样返回', stripTimestampPrefix('手改过的名字'), '手改过的名字');

  const t = parseTimestampFromName('2026-09-24 01-51-37-332 (⊙o⊙)？');
  ok('解析出毫秒时间戳', typeof t === 'number' && Number.isFinite(t));
  eq(
    '按**本地时间**解释（不是 UTC）',
    t !== undefined ? new Date(t).getHours() * 60 + new Date(t).getMinutes() : -1,
    1 * 60 + 51,
  );
  eq('毫秒部分也对', t !== undefined ? new Date(t).getMilliseconds() : -1, 332);
  eq('没有时间戳返回 undefined', parseTimestampFromName('手改过的名字'), undefined);
}

/* ========================================================================== */
section('④ 每段的挂钟起点：会话开始 + 累计时长');
{
  const T = '2026-09-24 01-51-37-332 (⊙o⊙)？';
  const d = mkdirWith([`${T}.ts`, `${T}-PART001.ts`]);
  // 第 1 段实测 19 分 55 秒（01:51:37 → 02:11:32）
  const segs = toSegmentLikes([path.join(d, `${T}.ts`), path.join(d, `${T}-PART001.ts`)], [1195, 1200]);
  const starts = segmentStartMs(segs);
  const d0 = new Date(starts[0]!);
  const d1 = new Date(starts[1]!);
  eq('第 1 段起点 = 会话开始（01:51:37.332）', `${d0.getHours()}:${String(d0.getMinutes()).padStart(2, '0')}:${String(d0.getSeconds()).padStart(2, '0')}.${d0.getMilliseconds()}`, '1:51:37.332');
  eq('第 2 段起点 = 起点 + 第 1 段时长（02:11:32.332）', `${d1.getHours()}:${String(d1.getMinutes()).padStart(2, '0')}:${String(d1.getSeconds()).padStart(2, '0')}.${d1.getMilliseconds()}`, '2:11:32.332');
  eq('第 2 段的 globalStart 是 1195 秒', segs[1]!.globalStart, 1195);
  fs.rmSync(d, { recursive: true, force: true });
}

/* ========================================================================== */
section('⑤ 弹幕配对：实测的那个目录形态');
{
  const T = '2026-09-24 01-51-37-332 (⊙o⊙)？';
  const d = mkdirWith([
    `${T}.ts`,
    `${T}-PART001.ts`,
    // 第 1 段的弹幕：前缀与会话开始一致
    [`${T}.xml`, xmlOf('1', [[1, '第一段弹幕A'], [10, '第一段弹幕B']])],
    // 第 2 段的弹幕：前缀是**第 2 段自己的开始时刻**
    [`2026-09-24 02-11-32-593 (⊙o⊙)？.xml`, xmlOf('2', [[2, '第二段弹幕A']])],
    // 中途失败重录留下的碎片（0.7MB 那种），必须被跳过而不是占位
    [`2026-09-24 01-51-23-040 (⊙o⊙)？.xml`, xmlOf('0', [[1, '碎片']])],
  ]);
  const segs = toSegmentLikes([path.join(d, `${T}.ts`), path.join(d, `${T}-PART001.ts`)], [1195, 1200]);

  const cands = listDanmakuCandidates(segs);
  eq('候选弹幕文件识别出 3 个（含那个碎片）', cands.length, 3);

  const paired = pairSegmentDanmakuByTimestamp(segs);
  eq('两个分段各配上 1 个', paired.matches.length, 2);
  eq('没有漏配', paired.missing, []);
  eq('第 1 段配到会话开始那份', paired.matches[0]!.danmakuPath.endsWith(`${T}.xml`), true);
  eq(
    '★ 第 2 段配到 02-11-32-593 那份（前缀与视频完全不同）',
    path.basename(paired.matches[1]!.danmakuPath),
    '2026-09-24 02-11-32-593 (⊙o⊙)？.xml',
  );
  ok('配对依据是时间戳', paired.matches.every((m) => m.how === 'timestamp'));
  ok('偏移量正确（第 2 段 = 1195 秒）', paired.matches[1]!.globalStart === 1195, String(paired.matches[1]!.globalStart));
  ok('配对漂移在 1 秒内（说明时间基准真的对得上）', (paired.matches[1]!.driftSec ?? 99) < 1, String(paired.matches[1]!.driftSec));
  ok(
    '★ 那个中断碎片没有被用上（否则第 1 段会配到错的弹幕）',
    !paired.matches.some((m) => m.danmakuPath.includes('01-51-23-040')),
  );
  fs.rmSync(d, { recursive: true, force: true });
}

/* ========================================================================== */
section('⑥ 弹幕配对：容差与退化情形');
{
  const T = '2026-09-24 01-51-37-332 (⊙o⊙)？';
  // 第 2 段的弹幕时间戳偏离 10 分钟 → 超出容差，不配
  const d = mkdirWith([
    `${T}.ts`,
    `${T}-PART001.ts`,
    [`${T}.xml`, xmlOf('1', [[1, 'a']])],
    [`2026-09-24 02-21-32-593 (⊙o⊙)？.xml`, xmlOf('2', [[1, 'b']])],
  ]);
  const segs = toSegmentLikes([path.join(d, `${T}.ts`), path.join(d, `${T}-PART001.ts`)], [1195, 1200]);
  const paired = pairSegmentDanmakuByTimestamp(segs);
  eq('超出容差的弹幕不会被硬配上', paired.matches.length, 1);
  eq('如实报告第 2 段没配上', paired.missing, [1]);
  ok('并且给出警告', paired.warnings.some((w) => w.includes('没配上弹幕')), paired.warnings.join(' | '));
  ok(`容差是 ${PAIR_TOLERANCE_SEC} 秒`, PAIR_TOLERANCE_SEC === 180);
  fs.rmSync(d, { recursive: true, force: true });

  // 单分段：不进入配对流程
  const d2 = mkdirWith([`${T}.ts`, [`${T}.xml`, xmlOf('1', [[1, 'a']])]]);
  const one = pairSegmentDanmakuByTimestamp(toSegmentLikes([path.join(d2, `${T}.ts`)], [100]));
  eq('只有 1 个分段时不配对（沿用既有的同名查找）', one.matches.length, 0);
  fs.rmSync(d2, { recursive: true, force: true });

  // 完全没有弹幕
  const d3 = mkdirWith([`${T}.ts`, `${T}-PART001.ts`]);
  const none = listDanmakuCandidates(toSegmentLikes([path.join(d3, `${T}.ts`), path.join(d3, `${T}-PART001.ts`)], [10, 10]));
  eq('一个弹幕文件都没有时返回空', none.length, 0);
  const np = await pairSegmentDanmaku(toSegmentLikes([path.join(d3, `${T}.ts`), path.join(d3, `${T}-PART001.ts`)], [10, 10]));
  ok('并且明确警告"一个候选都没找到"', np.warnings.some((w) => w.includes('一个候选弹幕文件都没找到')), np.warnings.join(' | '));
  fs.rmSync(d3, { recursive: true, force: true });

  // biliLive-tools 映射优先：lookup 给了就直接用
  const d4 = mkdirWith([`${T}.ts`, `${T}-PART001.ts`, [`${T}.xml`, xmlOf('1', [[1, 'a']])], [`2026-09-24 02-11-32-593 (⊙o⊙)？.xml`, xmlOf('2', [[1, 'b']])]]);
  const segs4 = toSegmentLikes([path.join(d4, `${T}.ts`), path.join(d4, `${T}-PART001.ts`)], [1195, 1200]);
  const viaLookup = await pairSegmentDanmaku(segs4, {
    lookup: async (p) => (p.endsWith('-PART001.ts') ? path.join(d4, '2026-09-24 02-11-32-593 (⊙o⊙)？.xml') : undefined),
  });
  eq('lookup 给出的映射被采纳', viaLookup.matches[1]?.how, 'bililive-tools');
  eq('第 1 段仍由时间戳补上', viaLookup.matches[0]?.how, 'timestamp');
  eq('两段都配上了', viaLookup.matches.length, 2);
  fs.rmSync(d4, { recursive: true, force: true });
}

/* ========================================================================== */
section('⑦ 合并：把分段弹幕拼成一条全局时间轴');
{
  const a = path.join(tmp, 'seg0.xml');
  const b = path.join(tmp, 'seg1.xml');
  fs.writeFileSync(a, xmlOf('1', [[1, 'A1'], [10, 'A2'], [1190, 'A3']]), 'utf8');
  fs.writeFileSync(b, xmlOf('2', [[2, 'B1'], [30, 'B2']]), 'utf8');

  const out = path.join(tmp, 'merged.xml');
  const r = mergeDanmakuXmlFiles(
    [
      { danmakuPath: a, offsetSec: 0 },
      { danmakuPath: b, offsetSec: 1195 },
    ],
    out,
  );
  eq('总条数 = 各段之和', r.count, 5);
  eq('各段贡献数量如实记录', r.perPart, [3, 2]);
  ok('没有读取失败', r.failed.length === 0);
  ok('文件写出来了', fs.existsSync(out));

  const reparsed = parseDanmakuXml(fs.readFileSync(out, 'utf8'));
  eq('★ 合并结果能被项目自己的解析器读回来', reparsed.items.length, 5);
  ok(
    '合并结果没有**解析失败**类警告（只有"没有 SC/上舰/礼物 → 降级"这类正常提示）',
    reparsed.warnings.every((w) => !/解析失败|不是 B站弹幕 XML|为空/.test(w)),
    reparsed.warnings.join(' | '),
  );
  const times = reparsed.items.map((i) => Math.round(i.time));
  eq('时间轴按段平移（1,10,1190 然后 1197,1225）', times, [1, 10, 1190, 1197, 1225]);
  ok('时间整体递增（段序正确，不需要额外排序）', times.every((t, i) => i === 0 || t >= times[i - 1]!));
  const texts = reparsed.items.map((i) => i.text);
  eq('文本原样保留', texts, ['A1', 'A2', 'A3', 'B1', 'B2']);

  // 抽取函数本身
  eq('extractDanmakuItems 能正确计数', extractDanmakuItems(fs.readFileSync(a, 'utf8')).length, 3);
  const withEntity = xmlOf('9', [[1, '&lt;test&gt; &amp; more']]);
  eq('XML 实体原样带过去（不二次转义）', extractDanmakuItems(withEntity)[0]!.text, '&lt;test&gt; &amp; more');

  // 坏源不炸
  const r2 = mergeDanmakuXmlFiles(
    [
      { danmakuPath: path.join(tmp, 'not-exist.xml'), offsetSec: 0 },
      { danmakuPath: b, offsetSec: 100 },
    ],
    path.join(tmp, 'merged2.xml'),
  );
  eq('一个源读不到时只算它 0 条', r2.perPart, [0, 2]);
  eq('失败被如实报告', r2.failed.length, 1);
  eq('另一个源照常合并', r2.count, 2);
}

/* ========================================================================== */
section('⑧ 端到端：真目录 + 真文件 + 真合并，最后能被解析器读出全局时间');
{
  const T = '2026-09-24 01-51-37-332 (⊙o⊙)？';
  const d = mkdirWith([
    [`${T}.ts`, 'v0'],
    [`${T}-PART001.ts`, 'v1'],
    [`${T}.xml`, xmlOf('1', [[5, '开场'], [600, '第十分钟']])],
    [`2026-09-24 02-11-32-593 (⊙o⊙)？.xml`, xmlOf('2', [[5, '第二段开场']])],
  ]);
  const video0 = path.join(d, `${T}.ts`);
  const video1 = path.join(d, `${T}-PART001.ts`);

  // 1) 分段识别
  eq('分段识别出 2 段且顺序正确', discoverSegments(video1).map((s) => path.basename(s)), [`${T}.ts`, `${T}-PART001.ts`]);
  // 2) 清单层只判断"有没有"
  eq('清单层能看出这场有分段弹幕', listSegmentDanmaku(discoverSegments(video1)).length, 2);
  // 3) 导入层的精确配对
  const segs = toSegmentLikes(discoverSegments(video1), [1195, 1200]);
  const paired = await pairSegmentDanmaku(segs);
  eq('两段都配上', paired.matches.length, 2);
  // 4) 合并
  const out = path.join(tmp, 'e2e-merged.xml');
  const merged = mergeDanmakuXmlFiles(
    paired.matches.map((m) => ({ danmakuPath: m.danmakuPath, offsetSec: m.globalStart })),
    out,
  );
  eq('合并 3 条', merged.count, 3);
  const parsed = parseDanmakuXml(fs.readFileSync(out, 'utf8'));
  eq(
    '★ 全局时间轴正确：第 2 段的 5 秒变成 1200 秒',
    parsed.items.map((i) => Math.round(i.time)),
    [5, 600, 1200],
  );
  eq('文本顺序也对', parsed.items.map((i) => i.text), ['开场', '第十分钟', '第二段开场']);

  // 5) 密度曲线：整场 2400 秒都应该有覆盖（修复前只有前 20 分钟有弹幕）
  ok('总时长 2395 秒', Math.round(segs[1]!.globalEnd) === 2395 || Math.round(segs[1]!.globalEnd) === 2395, String(segs[1]!.globalEnd));
  ok(
    '★ 最晚一条弹幕落在后半段（说明第 2 段的弹幕真的进来了）',
    Math.max(...parsed.items.map((i) => i.time)) > segs[0]!.duration,
    `最晚 ${Math.max(...parsed.items.map((i) => i.time))} vs 第1段时长 ${segs[0]!.duration}`,
  );
  fs.rmSync(d, { recursive: true, force: true });
}

/* ========================================================================== */
section('⑨ 真实 XML 形态：`p` 后面还有属性（实测踩到的静默归零）');
{
  /* biliLive-tools 产出的弹幕长这样：
     `<d p="21.743,1,25,…" user="偷懒羊" uid="30487487" timestamp="1790185919651">文本</d>`
     —— `p` 后面还有属性。早先的正则要求 `p` 之后紧跟 `>`，结果**一条都抽不到**，
     合并出来是个空文件，而所有输入文件都完全正常。这类"正则太严 → 静默产出空结果"最难发现。 */
  const real =
    '<?xml version="1.0" encoding="utf-8"?>\n<?xml-stylesheet type="text/xsl" href="#s"?>\n<i>\n<metadata><title>t</title></metadata>\n' +
    '<d p="21.743,1,25,16777215,1790185919651,0,30487487,30487487,0" user="偷懒羊" uid="30487487" timestamp="1790185919651">装备介绍下面有个强化</d>\n' +
    '<d p="67.215,1,25,16777215,1790185965123,0,545261950,545261950,0" user="某人" uid="545261950" timestamp="1790185965123">第二条</d>\n' +
    '</i>\n';
  const items = extractDanmakuItems(real);
  eq('★ 带额外属性的 <d> 也能被抽出来（修复前这里是 0）', items.length, 2);
  eq('p 原样保留', items[0]!.p, '21.743,1,25,16777215,1790185919651,0,30487487,30487487,0');
  ok('额外属性被捕获', items[0]!.extraAttrs.includes('user="偷懒羊"'), items[0]!.extraAttrs);
  eq('文本正确', items[0]!.text, '装备介绍下面有个强化');

  const a = path.join(tmp, 'real0.xml');
  const b = path.join(tmp, 'real1.xml');
  fs.writeFileSync(a, real, 'utf8');
  fs.writeFileSync(b, real.replace(/21\.743/g, '2.000'), 'utf8');
  const out = path.join(tmp, 'real-merged.xml');
  const r = mergeDanmakuXmlFiles(
    [
      { danmakuPath: a, offsetSec: 0 },
      { danmakuPath: b, offsetSec: 1200 },
    ],
    out,
  );
  eq('合并 4 条（不是 0 条）', r.count, 4);
  const txt = fs.readFileSync(out, 'utf8');
  ok('★ 额外属性被保留（user / uid / timestamp 不能丢）', txt.includes('user="偷懒羊"') && txt.includes('timestamp="1790185919651"'), txt.slice(0, 200));
  const parsed = parseDanmakuXml(txt);
  eq('解析回来 4 条', parsed.items.length, 4);
  eq('第 2 段的时间被平移', parsed.items.map((i) => Math.round(i.time)), [22, 67, 1202, 1267]);
  fs.rmSync(a, { force: true });
  fs.rmSync(b, { force: true });
  fs.rmSync(out, { force: true });
}

/* ========================================================================== */
section('⑩ 一个分段只能配一份弹幕（映射与时间戳不能各配一次）');
{
  const T = '2026-09-24 01-51-37-332 (⊙o⊙)？';
  const d = mkdirWith([
    `${T}.ts`,
    `${T}-PART001.ts`,
    [`${T}.xml`, xmlOf('1', [[1, 'A']])],
    [`2026-09-24 02-11-32-593 (⊙o⊙)？.xml`, xmlOf('2', [[1, 'B']])],
  ]);
  const segs = toSegmentLikes([path.join(d, `${T}.ts`), path.join(d, `${T}-PART001.ts`)], [1195, 1200]);

  /* 让 lookup 对**两段**都返回第 1 段那份弹幕 —— 第 1 段走映射，
     第 2 段必须继续走时间戳配对，而不是也去蹭第 1 段的（那会把第 1 段的弹幕算两遍）。 */
  const both = await pairSegmentDanmaku(segs, {
    lookup: async (p) => (p.endsWith(`${T}.ts`) ? path.join(d, `${T}.xml`) : undefined),
  });
  eq('两段各一份，共 2 条匹配', both.matches.length, 2);
  eq('分段序号不重复', both.matches.map((m) => m.index), [0, 1]);
  eq('弹幕文件也不重复', new Set(both.matches.map((m) => m.danmakuPath)).size, 2);

  /* lookup 覆盖了两段时，时间戳那一路必须完全不插手（skipIndexes） */
  const allViaLookup = await pairSegmentDanmaku(segs, {
    lookup: async (p) => (p.endsWith(`${T}.ts`) ? path.join(d, `${T}.xml`) : path.join(d, '2026-09-24 02-11-32-593 (⊙o⊙)？.xml')),
  });
  eq('全部由映射认领时也是 2 条', allViaLookup.matches.length, 2);
  ok('且全部标为 bililive-tools 依据', allViaLookup.matches.every((m) => m.how === 'bililive-tools'));
  eq('没有漏配', allViaLookup.missing, []);
  fs.rmSync(d, { recursive: true, force: true });
}

/* ========================================================================== */
section('⑪ 选哪一份弹幕：合并结果必须压过"调用方显式传进来的单份"');
{
  /* 这条优先级是"第 2 段以后有没有弹幕"的唯一开关，踩过一次隐蔽的坑：
     目录轮询会把清单里选中的**那一个**弹幕文件当 explicitPath 传进来，
     于是「显式优先」的写法让**按段合并永远走不到** —— 多分段照旧只有第 1 段有弹幕，
     而界面上显示"有弹幕"，完全看不出问题。 */
  const merged = 'C:/t/merged.xml';
  const one = 'C:/t/seg1.xml';

  const c1 = chooseDanmaku({ segmentCount: 3, mergedPath: merged, explicitPath: one });
  eq('★ 多分段 + 合并成功 → 用合并结果（压过显式传进来的单份）', c1.path, merged);
  eq('来源标记正确', c1.from, 'merged-segments');
  ok('说明里点出了被覆盖的那一份', c1.note.includes('seg1.xml'), c1.note);

  const c2 = chooseDanmaku({ segmentCount: 3, explicitPath: one });
  eq('多分段但合并失败 → 退回显式指定的', c2.path, one);
  eq('来源是 explicit', c2.from, 'explicit');

  const c3 = chooseDanmaku({ segmentCount: 1, mergedPath: merged, explicitPath: one });
  eq('单分段不该用合并结果（根本不该产生它）', c3.path, one);

  const c4 = chooseDanmaku({ segmentCount: 3, siblingPath: one });
  eq('没有合并也没有显式 → 用同名文件', c4.path, one);
  eq('来源是 sibling', c4.from, 'sibling');

  const c5 = chooseDanmaku({ segmentCount: 3 });
  eq('什么都没有 → 没有弹幕', c5.path, undefined);
  eq('来源是 none', c5.from, 'none');
  ok('给出可读说明', c5.note.length > 0, c5.note);

  const c6 = chooseDanmaku({ segmentCount: 2, mergedPath: merged });
  eq('多分段 + 合并成功、没有显式时也走合并', c6.from, 'merged-segments');
  ok('没有多余的"覆盖"说明', !c6.note.includes('覆盖'), c6.note);
}

console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
process.exitCode = fail === 0 ? 0 : 1;
