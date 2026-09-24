/**
 * 分段录播的**弹幕配对与合并**。
 *
 * ## 为什么需要这个模块（2026-09-24 实测发现）
 *
 * biliLive-tools 把一场连续直播按分钟切段时：
 *
 * | 产物 | 命名规则 |
 * |---|---|
 * | 视频分段 | **会话开始时刻** + `-PART{n}`：`X.ts`、`X-PART001.ts`、`X-PART002.ts` |
 * | 弹幕 XML | **该段自己的开始时刻**：`X.xml`、`<第二段开始时刻>.xml`、`<第三段开始时刻>.xml` |
 *
 * 也就是说**弹幕文件的前缀和视频分段的前缀对不上**（实测：视频是
 * `2026-09-24 01-51-37-332 (⊙o⊙)？-PART001.ts`，而它那一段的弹幕叫
 * `2026-09-24 02-11-32-593 (⊙o⊙)？.xml`）。后果有两层：
 *
 *  1. `POST /record-history/danma-file` 对 `-PART001.ts` 返回**无映射**；
 *  2. 同名回退（`findSiblingDanmaku`）也找不到 —— 压根没有 `…-PART001.xml` 这个文件。
 *
 * 于是第 2 段及以后的任务全都**没有弹幕信号**：密度曲线/峰值/热词/highEnergy 全空，
 * 选片静默降级成语音密度兜底，而日志里只有一句"未找到同名弹幕文件"。
 *
 * ## 配对依据
 *
 * 视频文件名里就带着**会话开始时刻**，而每段的全局起点由 `buildSegmentMap` 的累计时长给出：
 *
 * ```
 * absStart[0] = parseTimestamp(basename(segments[0]))     // 会话开始
 * absStart[k] = absStart[0] + globalStart[k] * 1000       // 累计时长偏移
 * ```
 *
 * 而每个弹幕 XML 的文件名里也带着**它那一段的开始时刻**，两者应当吻合（实测误差 < 1 秒）。
 * 所以配对规则是「按时间就近匹配 + 容差校验」，天然能跳过中途失败重录产生的多余 XML
 * （实测目录里就有一个 0.7 MB 的 `…01-51-23-040….xml` 是重启瞬间的碎片）。
 *
 * ## 合并
 *
 * 合并成**一条全局时间轴**的 XML：第 k 段的每条弹幕时间 += `globalStart[k]`。
 * 这样下游（`danmaku.ts` 的密度曲线、`danmaku-ass.ts` 烧弹幕）拿到的是与成片对齐的一条时间轴，
 * 不需要任何分段感知 —— 与「分段文件 → 全局时间」的既有约定一致。
 *
 * 本模块不做任何网络请求（biliLive-tools 的映射查询由调用方注入），只做纯计算 + 读写文件。
 */
import fs from 'node:fs';
import path from 'node:path';

import { ensureDir, exists, nowIso } from './util.ts';

/** 录制器/弹幕器文件名里的时间戳前缀：`2026-09-24 01-51-37-332 ` / `2026_9_21 20_50_02 ` */
const TS_PREFIX = /^\d{4}[-_]\d{1,2}[-_]\d{1,2}[ _]+\d{1,2}[-_]\d{2}[-_]\d{2}(?:[-_]\d{1,3})?[ _]*/;

/** 配对容差：弹幕器与录制器的启动时刻允许差这么久（实测 < 1 秒，留足余量给慢启动） */
export const PAIR_TOLERANCE_SEC = 180;

export interface SegmentDanmakuMatch {
  /** 分段序号（0 基） */
  index: number;
  segmentPath: string;
  danmakuPath: string;
  /** 该分段在成片里的全局起始秒（= 合并时的偏移量） */
  globalStart: number;
  /** 判定依据 */
  how: 'bililive-tools' | 'timestamp';
  /** 弹幕文件时间戳与该分段起点的差值（秒）；`bililive-tools` 映射时无此值 */
  driftSec?: number;
}

export interface PairResult {
  matches: SegmentDanmakuMatch[];
  /** 没配上弹幕的分段序号 */
  missing: number[];
  warnings: string[];
}

/** 分段的最小形状（与 `SourceSegment` 兼容，但不依赖它，便于单测直接构造） */
export interface SegmentLike {
  path: string;
  /** 段内时长（秒）；未知传 0 */
  duration: number;
  /** 该段在成片里的全局起始秒（合并时的偏移量） */
  globalStart: number;
  globalEnd: number;
}

/**
 * 把「有序的文件路径」变成 `SegmentLike`。
 *
 * 有了 `durations` 才能算出每段的 `globalStart`（配对与合并都依赖它）；
 * 拿不到时长时全部填 0 —— 此时**不要**用 `pairSegmentDanmaku`（起点锚不上），
 * 但可以安全地用 `listSegmentDanmaku` 判断「这场有没有分段弹幕」。
 */
export function toSegmentLikes(paths: readonly string[], durations?: readonly number[]): SegmentLike[] {
  let acc = 0;
  return paths.map((p, i) => {
    const d = durations?.[i];
    const duration = typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0;
    const globalStart = acc;
    acc += duration;
    return { path: p, duration, globalStart, globalEnd: acc };
  });
}

/**
 * 「这场有没有分段弹幕」——给**不需要精确配对**的地方用（录播清单 / 导入预览）。
 *
 * 判据只有一条：同目录下存在「去掉时间戳前缀后与本场同标题」的 `.xml`/`.ass`。
 * 精确到哪一段属于哪一段的配对放在导入时做（那里才有每段的时长与全局起点）。
 */
export function listSegmentDanmaku(segments: readonly string[] | readonly SegmentLike[]): DanmakuCandidate[] {
  const paths = typeof segments[0] === 'string'
    ? (segments as readonly string[])
    : (segments as readonly SegmentLike[]).map((s) => s.path);
  if (paths.length < 2) return [];
  return listDanmakuCandidates(toSegmentLikes(paths));
}

/* ============================================================================
 * 文件名时间戳
 * ========================================================================== */

/** 去掉文件名里的时间戳前缀，剩下的就是「场次标题」（用于判断两个文件是不是同一场） */
export function stripTimestampPrefix(stem: string): string {
  return stem.replace(TS_PREFIX, '').trim();
}

/**
 * 从文件名解析出录制/弹幕的**开始时刻**（毫秒）。
 *
 * 录制器写的是**本地时间**，所以用 `new Date(y, m-1, d, ...)` 构造（不能 `Date.parse` 字符串，
 * 那会按 UTC 解释，得到的结果整体偏移时区）。
 */
export function parseTimestampFromName(stem: string): number | undefined {
  const m = /^(\d{4})[-_](\d{1,2})[-_](\d{1,2})[ _]+(\d{1,2})[-_](\d{2})[-_](\d{2})(?:[-_](\d{1,3}))?/.exec(stem);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  if (![y, mo, d, h, mi, s].every(Number.isFinite)) return undefined;
  const t = new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/** 该分段在**挂钟时间**上的起点（毫秒） */
export function segmentStartMs(segments: SegmentLike[]): Array<number | undefined> {
  if (segments.length === 0) return [];
  const first = segments[0]!;
  let anchor = parseTimestampFromName(path.basename(first.path, path.extname(first.path)));
  if (anchor === undefined) {
    // 文件名没有时间戳（手工改名过）→ 退回文件系统时间：创建时间 ≈ 分段起点
    try {
      const st = fs.statSync(first.path);
      if (st.birthtimeMs > 0) anchor = st.birthtimeMs;
      else if (st.mtimeMs > 0 && first.duration > 0) anchor = st.mtimeMs - first.duration * 1000;
    } catch {
      /* 读不到就算了 */
    }
  }
  if (anchor === undefined) return segments.map(() => undefined);
  return segments.map((s) => anchor! + s.globalStart * 1000);
}

/* ============================================================================
 * 候选弹幕文件
 * ========================================================================== */

export interface DanmakuCandidate {
  path: string;
  /** 文件名里的开始时刻（毫秒）；解析不出为 undefined */
  startMs?: number;
}

/**
 * 找出「属于同一场」的所有弹幕文件候选。
 *
 * 判据：同目录、扩展名 `.xml`/`.ass`、**去掉时间戳前缀后与视频分段同标题**。
 * 这正是弹幕器「每段一个文件、各自用自己的开始时刻命名」的形态。
 */
export function listDanmakuCandidates(segments: SegmentLike[], dir?: string): DanmakuCandidate[] {
  if (segments.length === 0) return [];
  const first = segments[0]!;
  const baseDir = dir ?? path.dirname(first.path);
  const ext = path.extname(first.path);
  const title = stripTimestampPrefix(path.basename(first.path, ext));

  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return [];
  }

  const out: DanmakuCandidate[] = [];
  for (const name of entries) {
    const e = path.extname(name).toLowerCase();
    if (e !== '.xml' && e !== '.ass') continue;
    const stem = name.slice(0, name.length - e.length);
    if (stripTimestampPrefix(stem) !== title) continue;
    const startMs = parseTimestampFromName(stem);
    out.push({ path: path.join(baseDir, name), ...(startMs !== undefined ? { startMs } : {}) });
  }
  return out;
}

/* ============================================================================
 * 配对
 * ========================================================================== */

/**
 * **只按文件名时间戳**配对（同步、纯本地）。
 *
 * 给不能用 async 的调用点（录播清单 `listRecordingsDetailed` 要在一轮同步循环里判定
 * 每个候选有没有弹幕）以及单测用。`pairSegmentDanmaku` 在查完 biliLive-tools 之后也走这里。
 */
export function pairSegmentDanmakuByTimestamp(
  segments: SegmentLike[],
  opts: { dir?: string; candidates?: DanmakuCandidate[]; skip?: ReadonlySet<string>; skipIndexes?: ReadonlySet<number> } = {},
): PairResult {
  const warnings: string[] = [];
  if (segments.length < 2) return { matches: [], missing: [], warnings: ['少于 2 个分段，不需要按段配对'] };

  const absStarts = segmentStartMs(segments);
  const cands = (opts.candidates ?? listDanmakuCandidates(segments, opts.dir)).filter((c) => exists(c.path));
  const used = new Set<string>(opts.skip ?? []);
  const taken = new Set<number>(opts.skipIndexes ?? []);
  const matches: SegmentDanmakuMatch[] = [];

  const byTimestamp = cands.filter((c) => c.startMs !== undefined && !used.has(c.path));
  for (let i = 0; i < segments.length; i++) {
    /* 已经被别的依据（biliLive-tools 映射）认领过的分段跳过 —— 否则同一个分段会配到两份弹幕，
       合并时那一段的弹幕被算两遍（实测：第 1 段既命中映射又命中时间戳，偏移 0 的两份叠在一起）。 */
    if (taken.has(i)) continue;
    const anchor = absStarts[i];
    if (anchor === undefined) continue;
    let best: { c: DanmakuCandidate; drift: number } | undefined;
    for (const c of byTimestamp) {
      if (used.has(c.path)) continue;
      const drift = Math.abs(c.startMs! - anchor) / 1000;
      if (drift > PAIR_TOLERANCE_SEC) continue;
      if (!best || drift < best.drift) best = { c, drift };
    }
    if (!best) continue;
    used.add(best.c.path);
    taken.add(i);
    matches.push({
      index: i,
      segmentPath: segments[i]!.path,
      danmakuPath: best.c.path,
      globalStart: segments[i]!.globalStart,
      how: 'timestamp',
      driftSec: Math.round(best.drift * 10) / 10,
    });
  }

  matches.sort((a, b) => a.index - b.index);
  return { matches, missing: missingIndexes(segments.length, matches), warnings: pairWarnings(segments.length, matches, cands) };
}

function missingIndexes(total: number, matches: SegmentDanmakuMatch[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < total; i++) if (!matches.some((m) => m.index === i)) out.push(i);
  return out;
}

/** 配对结果的诊断信息（同步/异步两条路共用，避免措辞漂移） */
function pairWarnings(total: number, matches: SegmentDanmakuMatch[], cands: DanmakuCandidate[]): string[] {
  const warnings: string[] = [];
  const missing = missingIndexes(total, matches);
  if (missing.length > 0) {
    warnings.push(
      `${total} 个分段里有 ${missing.length} 段没配上弹幕（第 ${missing.map((i) => i + 1).join('、')} 段）—— ` +
        `这几段将没有弹幕信号。目录里找到 ${cands.length} 个候选弹幕文件，` +
        `已用 ${matches.length} 个${cands.length > matches.length ? `，剩下的时间戳都对不上（容差 ${PAIR_TOLERANCE_SEC} 秒）` : ''}`,
    );
  }
  if (cands.length === 0) {
    warnings.push(
      '一个候选弹幕文件都没找到：弹幕文件必须与视频分段**同目录**、且去掉时间戳前缀后同标题。' +
        '若录制器把弹幕存在别处，请手动指定。',
    );
  }
  return warnings;
}

/**
 * 把每个分段配到它那一段的弹幕文件。
 *
 * 两种依据，按可靠性排序：
 *  1. `lookup`（可选）—— 调 biliLive-tools 的 `/record-history/danma-file`，它自己的映射最权威；
 *  2. **文件名时间戳就近匹配** —— `absStart[k]` 与弹幕文件名时间戳之差在 `PAIR_TOLERANCE_SEC` 内。
 *
 * 第 1 种对 `-PART00n` 实测返回空，所以第 2 种才是主力；第 1 种留着是因为它对
 * 「文件名被改过 / 弹幕放在别的目录」仍然有效。
 *
 * 一个弹幕文件只会被用一次（就近且互斥），所以中途失败重录产生的多余 XML 会被自然跳过。
 */
export async function pairSegmentDanmaku(
  segments: SegmentLike[],
  opts: {
    lookup?: (segmentPath: string) => Promise<string | undefined>;
    dir?: string;
    candidates?: DanmakuCandidate[];
  } = {},
): Promise<PairResult> {
  const warnings: string[] = [];
  if (segments.length === 0) return { matches: [], missing: [], warnings };
  if (segments.length === 1) {
    // 单文件沿用既有路径（同名弹幕 / biliLive-tools 映射），不需要配对
    return { matches: [], missing: [], warnings: ['只有 1 个分段，按单文件处理'] };
  }

  const viaLookup: SegmentDanmakuMatch[] = [];
  const used = new Set<string>();
  const taken = new Set<number>();
  if (opts.lookup) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      let p: string | undefined;
      try {
        p = await opts.lookup(seg.path);
      } catch {
        p = undefined;
      }
      if (!p || !exists(p) || used.has(p)) continue;
      used.add(p);
      taken.add(i);
      viaLookup.push({ index: i, segmentPath: seg.path, danmakuPath: p, globalStart: seg.globalStart, how: 'bililive-tools' });
    }
  }

  const byTs = pairSegmentDanmakuByTimestamp(segments, {
    ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
    ...(opts.candidates !== undefined ? { candidates: opts.candidates } : {}),
    skip: used,
    skipIndexes: taken,
  });
  const cands = opts.candidates ?? listDanmakuCandidates(segments, opts.dir);
  const matches = [...viaLookup, ...byTs.matches].sort((a, b) => a.index - b.index);
  return { matches, missing: missingIndexes(segments.length, matches), warnings: pairWarnings(segments.length, matches, cands) };
}

/* ============================================================================
 * 选哪一份弹幕
 * ========================================================================== */

export interface DanmakuChoice {
  path?: string;
  from: 'merged-segments' | 'explicit' | 'sibling' | 'none';
  note: string;
}

/**
 * 决定一场录播最终用哪一份弹幕文件。**优先级是这里唯一说了算的地方。**
 *
 * ⚠️ 顺序踩过坑：最初写成「显式 → 同名 → 按段合并」，看着合理，实际有一条隐蔽的失效路径 ——
 *   目录轮询会把清单里选中的那**一个**弹幕文件当 `explicitPath` 传进来，
 *   于是它恒为真，**按段合并永远走不到**：多分段录播照旧只用第 1 段的弹幕
 *   （第 2 段之后全空），而界面上还显示"有弹幕"，完全看不出问题。
 *
 *   一份 XML 只覆盖一个分段，合并结果是覆盖整场的超集 —— 所以只要合并成功就必须用它，
 *   哪怕调用方显式给了一份。合并失败（配不上任何一段 / 目录里没有分段弹幕）才退回显式与同名。
 *
 * 抽成纯函数是为了能被单测直接钉住：它是"第 2 段以后有没有弹幕"的唯一开关。
 */
export function chooseDanmaku(opts: {
  /** 本场识别出几个视频分段 */
  segmentCount: number;
  /** 按段配对 + 合并后的产物（`resolveMergedDanmaku` 的结果） */
  mergedPath?: string;
  /** 调用方显式传入的弹幕（CLI `--danma` / 目录轮询选中的那一个） */
  explicitPath?: string;
  /** 与视频同名的 `.xml`/`.ass` */
  siblingPath?: string;
}): DanmakuChoice {
  if (opts.segmentCount > 1 && opts.mergedPath) {
    const overridden = opts.explicitPath && opts.explicitPath !== opts.mergedPath
      ? `（覆盖了单份的 ${path.basename(opts.explicitPath)}：单个弹幕文件只覆盖其中一段）`
      : '';
    return {
      path: opts.mergedPath,
      from: 'merged-segments',
      note: `本场 ${opts.segmentCount} 个分段，已按段合并弹幕${overridden}`,
    };
  }
  if (opts.explicitPath) return { path: opts.explicitPath, from: 'explicit', note: '使用显式指定的弹幕文件' };
  if (opts.siblingPath) return { path: opts.siblingPath, from: 'sibling', note: '使用与视频同名的弹幕文件' };
  return { from: 'none', note: '没有找到任何弹幕文件' };
}

/* ============================================================================
 * 合并
 * ========================================================================== */

/** 一条弹幕：`<d p="...">文本</d>` 的全部内容（p 原样保留，只有首字段被平移） */
interface RawItem {
  p: string;
  /** `p` 之外的其它属性原样保留（实测真实文件带 `user` / `uid` / `timestamp`） */
  extraAttrs: string;
  text: string;
}

/**
 * 抽出 XML 里所有 `<d p="…" …>…</d>`。文本与额外属性都原样保留（XML 实体已在文件里转义好）。
 *
 * ⚠️ 属性部分**不能**写成 `<d\s+p="([^"]*)"\s*>` —— 实测 biliLive-tools 产出的弹幕是：
 *
 * ```xml
 * <d p="21.743,1,25,16777215,1790185919651,0,30487487,30487487,0" user="偷懒羊" uid="30487487" timestamp="1790185919651">装备介绍…</d>
 * ```
 *
 * 也就是 `p` 后面还有属性。要求 `p` 之后紧跟 `>` 会**一条都抽不到**（实测合并出 0 条），
 * 而文件本身完全正常 —— 这种"正则太严 → 静默产出空结果"最难发现。
 */
export function extractDanmakuItems(xml: string): RawItem[] {
  const out: RawItem[] = [];
  const re = /<d\s+p="([^"]*)"([^>]*)>([\s\S]*?)<\/d>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push({ p: m[1] ?? '', extraAttrs: m[2] ?? '', text: m[3] ?? '' });
  return out;
}

/** 把 `p` 的首字段（相对本段的秒数）平移 `offsetSec` */
function shiftItem(item: RawItem, offsetSec: number): RawItem {
  if (offsetSec === 0) return item;
  const parts = item.p.split(',');
  const t = Number(parts[0]);
  if (!Number.isFinite(t)) return item;
  parts[0] = (t + offsetSec).toFixed(3);
  return { p: parts.join(','), extraAttrs: item.extraAttrs, text: item.text };
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface MergePart {
  danmakuPath: string;
  /** 该段在成片里的全局起始秒 */
  offsetSec: number;
}

export interface MergeResult {
  outPath: string;
  /** 合并后的弹幕条数 */
  count: number;
  /** 每个来源各贡献多少条 */
  perPart: number[];
  /** 解析失败的来源 */
  failed: Array<{ path: string; error: string }>;
}

/**
 * 把**按段切分**的弹幕合并成一条全局时间轴的 XML。
 *
 * 输出格式与 B站 弹幕 XML 一致（下游 `parseDanmakuXml` 直接吃），只把每段的
 * `p` 首字段平移该段的 `globalStart`。段与段之间天然按时间递增，不需要额外排序
 * （`parts` 必须已按分段顺序传入）。
 */
export function mergeDanmakuXmlFiles(parts: MergePart[], outPath: string): MergeResult {
  const failed: MergeResult['failed'] = [];
  const perPart: number[] = [];
  const all: RawItem[] = [];

  for (const part of parts) {
    let xml = '';
    try {
      xml = fs.readFileSync(part.danmakuPath, 'utf8');
    } catch (e) {
      failed.push({ path: part.danmakuPath, error: e instanceof Error ? e.message : String(e) });
      perPart.push(0);
      continue;
    }
    const items = extractDanmakuItems(xml);
    perPart.push(items.length);
    for (const it of items) all.push(shiftItem(it, part.offsetSec));
  }

  const lines = all.map((it) => `  <d p="${it.p}"${it.extraAttrs}>${it.text}</d>`);
  const doc = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<i>',
    '  <chatserver>chat.bilibili.com</chatserver>',
    '  <chatid>0</chatid>',
    '  <mission>0</mission>',
    '  <maxlimit>99999</maxlimit>',
    '  <state>0</state>',
    '  <real_name>0</real_name>',
    '  <source>live_auto-merged</source>',
    // 留个可追溯的锚点：谁合并的、几段、各段多少条
    `  <live_auto merged_at="${nowIso()}" parts="${parts.length}" counts="${perPart.join('/')}"/>`,
    ...lines,
    '</i>',
    '',
  ].join('\n');

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, doc, 'utf8');
  return { outPath, count: all.length, perPart, failed };
}
