/**
 * WP2 —— 弹幕分析。
 *
 * 职责（任务书 §4.2 时间基准统一 / §5.5 降级策略）：
 *  - 解析 biliLive-tools 录制产出的弹幕（XML 为主，ASS / SRT / JSON 兜底）；
 *  - 统一时间基准：弹幕时间戳相对「开播时刻」，转写时间戳相对「视频文件起点」，
 *    两者可能差一个常量 offset —— 本模块负责一次性测出并写进 Signals.danmakuOffset；
 *  - 产出密度曲线、密度峰值、高频词、高能事件（SC / 上舰 / 礼物）；
 *  - LLM 完全不可用时的兜底：直接用密度峰值给出候选切片区间。
 *
 * 硬约束：
 *  - 本模块纯本地计算，**不做网络请求、不调用 LLM**（可反复重跑、可在无网环境自测）。
 *  - 陷阱 #25：XML 里可能根本没有 <sc>/<guard>/<gift> 节点 —— 必须显式判定并降级为
 *    「普通弹幕密度 + 关键词」信号，**绝不允许假设高能事件存在**。
 *  - 大文件保护：几十 MB / 十万级弹幕时一次性把 XML 切成数组会爆内存，
 *    因此用 fast-xml-parser 解析一次后按需遍历，且超限时只读文件头部。
 */

import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { AppConfig } from './config.ts';
import { log } from './logger.ts';
import type { DanmakuEventKind, DanmakuItem, DensityPoint, PeakWindow, Signals } from './types.ts';
import { exists, fmtBytes, fmtDuration, nowIso, toSec } from './util.ts';

/* ============================================================================
 * 常量
 * ========================================================================== */

/** 弹幕原始格式 */
export type DanmakuFormat = 'xml' | 'ass' | 'srt' | 'json';

/** 解析结果 */
export interface ParsedDanmaku {
  items: DanmakuItem[];
  /** 原始条目总数（含被丢弃的） */
  rawCount: number;
  /** 各类型计数 */
  counts: Record<DanmakuEventKind, number>;
  /** XML 里是否真的出现了 SC / 上舰 / 礼物事件（陷阱 #25：不含则必须降级，不能假设有） */
  eventSignalsAvailable: boolean;
  /** 时间戳跨度（原始时间，秒） */
  maxRawTime: number;
  minRawTime: number;
  warnings: string[];
}

/** fast-xml-parser 的属性名前缀约定（默认 @_，这里显式写死，避免版本默认值漂移） */
const ATTR_PREFIX = '@_';
/** fast-xml-parser 的文本节点键名 */
const TEXT_NODE = '#text';
/** 会被当作「一条弹幕/事件」的标签；<danmaku> 之类只可能是容器，故不列入，交给递归下钻 */
const ITEM_TAGS = ['d', 'sc', 'guard', 'gift'] as const;
/** 标签 → 归一化事件类型 */
const TAG_KIND: Record<string, DanmakuEventKind> = {
  d: 'danmaku',
  sc: 'superchat',
  guard: 'guard',
  gift: 'gift',
};
/** 默认文件读取上限：64MB（超限只解析头部，见 loadDanmaku） */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;/** 「同一时间基准」的容忍阈值（秒）：差异小于它视为没有系统性偏移 */
const SAME_BASELINE_TOLERANCE_SEC = 15;
/** 峰值合并的最小间隔（秒）：间隔小于它的两个峰会被并成一个 */
const DEFAULT_MIN_GAP_SEC = 30;
/** 默认峰值强度下限（config.danmaku.peakMinIntensity 会覆盖它） */
const DEFAULT_MIN_INTENSITY = 0.3;
/** 单个峰取多少热词 */
const KEYWORDS_PER_PEAK = 8;
/** 单个峰做词频统计时最多采样多少条弹幕（防 O(峰数 × 全场弹幕) 退化） */
const MAX_ITEMS_PER_PEAK_SCAN = 5000;
/** 停用字/停用词（纯语气词与高频虚词，做关键词时没有区分度） */
const STOP_GRAMS = new Set([
  '哈哈', '呵呵', '嘿嘿', '嘻嘻', '啊啊', '233', '2333', 'emmm', 'emmmm',
  '这个', '那个', '什么', '就是', '一个', '我的', '你的', '不是', '没有',
  '怎么', '可以', '因为', '所以', '但是', '然后', '现在', '时候', '感觉',
  '真的', '好像', '我们', '他们', '自己', '一下', '有点', '也是', '还是',
  '已经', '应该', '可能', '这样', '那样', '如果', '而且', '不过', '于是',
  '直播间', '主播', '弹幕', '老板', '兄弟', '兄弟们',
]);

/* ============================================================================
 * 通用小工具（不导出：避免与其它 WP 的工具函数重名）
 * ========================================================================== */

/** 保留 3 位小数：避免 0.1+0.2 式的浮点毛刺写进 signals.json */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 字符串 → 有限数字；失败返回 undefined（不抛异常） */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** 从若干候选键里取第一个可解析为数字的值 */
function pickNum(attrs: Record<string, string>, keys: string[]): number | undefined {
  for (const k of keys) {
    const n = num(attrs[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** 从若干候选键里取第一个非空字符串 */
function pickStr(attrs: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function emptyCounts(): Record<DanmakuEventKind, number> {
  return { danmaku: 0, superchat: 0, guard: 0, gift: 0 };
}

function emptyParsed(warnings: string[] = []): ParsedDanmaku {
  return {
    items: [],
    rawCount: 0,
    counts: emptyCounts(),
    eventSignalsAvailable: false,
    maxRawTime: 0,
    minRawTime: 0,
    warnings,
  };
}

/** 统一的「无高能事件信号」降级说明（陷阱 #25 要求写明） */
function degradedNote(source: string): string {
  return `${source} 中没有出现 SC/上舰/礼物 事件节点，已降级为普通弹幕密度 + 关键词信号（陷阱 #25：不得假设高能事件存在）`;
}

/** 按时间跨度回填 min/maxRawTime（空数组时归零） */
function fillRange(parsed: ParsedDanmaku): void {
  if (parsed.items.length === 0) {
    parsed.minRawTime = 0;
    parsed.maxRawTime = 0;
    return;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const it of parsed.items) {
    if (it.rawTime < min) min = it.rawTime;
    if (it.rawTime > max) max = it.rawTime;
  }
  parsed.minRawTime = round3(Number.isFinite(min) ? min : 0);
  parsed.maxRawTime = round3(max);
}

/* ============================================================================
 * 格式判定与磁盘读取
 * ========================================================================== */

function extFormat(filePath: string): DanmakuFormat | undefined {
  const ext = path.extname(filePath ?? '').toLowerCase();
  if (ext === '.xml') return 'xml';
  if (ext === '.ass' || ext === '.ssa') return 'ass';
  if (ext === '.srt') return 'srt';
  if (ext === '.json' || ext === '.jsonl') return 'json';
  return undefined;
}

/** 内容嗅探：扩展名不可信（人工改名、无扩展名、.txt 转存）时的兜底 */
function sniffFormat(content: string): DanmakuFormat | undefined {
  const head = content.slice(0, 4096);
  // ASS 的 [Script Info] 与 JSON 的 [ 都以 '[' 开头，必须先判 ASS
  if (/\[Script\s+Info\]/i.test(head) || /^\s*Dialogue\s*:/im.test(head) || /\[\s*V4\+?\s*Styles\s*\]/i.test(head)) {
    return 'ass';
  }
  if (/-->/.test(head)) return 'srt';
  if (/^\s*</.test(head) || /<\?xml/i.test(head) || /<i\s*>/i.test(head)) return 'xml';
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  return undefined;
}

/** 按扩展名与内容自动判格式（内容优先：内容能判出来时以内容为准） */
export function detectFormat(filePath: string, content?: string): DanmakuFormat {
  if (content && content.length > 0) {
    const byContent = sniffFormat(stripBom(content));
    if (byContent) return byContent;
  }
  return extFormat(filePath) ?? 'xml';
}

/** 只读文件头部 maxBytes 字节（大文件保护，避免把 200MB 弹幕读进内存） */
function readHead(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** 截断后的 XML 补一个收尾标签，尽量把完整的记录救回来（仅大文件截断路径使用） */
function repairTruncatedXml(content: string): string {
  if (/<\/i>\s*$/.test(content)) return content;
  const lastD = content.lastIndexOf('</d>');
  if (lastD >= 0) return `${content.slice(0, lastD + 4)}</i>`;
  const lastGt = content.lastIndexOf('>');
  if (lastGt >= 0) return `${content.slice(0, lastGt + 1)}</i>`;
  return content;
}

/**
 * 从磁盘读取并解析。文件不存在 / 超大 / 脏数据一律「空结果 + 警告」，不抛异常：
 * 弹幕是信号来源之一，缺了它整条流水线仍应降级跑完。
 *
 * 内存说明：fast-xml-parser 会把整个 XML 建成对象树（实测约 30 倍于文本体积的 RSS，
 * 8.6MB / 12 万条 → 峰值 RSS 约 320MB），所以 maxBytes 是必要的安全阀：
 * B站一场 6 小时直播的弹幕 XML 通常在 20MB 以内，64MB 足够覆盖极端情况。
 */
export function loadDanmaku(filePath: string, opts: { maxBytes?: number } = {}): ParsedDanmaku {
  const warnings: string[] = [];
  if (!filePath) return emptyParsed(['未提供弹幕文件路径']);

  let size = 0;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return emptyParsed([`弹幕路径不是文件：${filePath}`]);
    size = st.size;
  } catch (err) {
    return emptyParsed([`弹幕文件不存在或无法访问：${filePath}（${errMsg(err)}）`]);
  }
  if (size <= 0) return emptyParsed([`弹幕文件为空：${filePath}`]);

  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const truncated = size > maxBytes;
  let content = '';
  try {
    content = stripBom(truncated ? readHead(filePath, maxBytes) : fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return emptyParsed([`读取弹幕文件失败：${filePath}（${errMsg(err)}）`]);
  }

  if (truncated) {
    warnings.push(
      `弹幕文件 ${fmtBytes(size)} 超过上限 ${fmtBytes(maxBytes)}，仅解析前 ${fmtBytes(maxBytes)}（大文件保护），` +
        '统计结果可能不完整；如需完整信号请调大 maxBytes 或改用更小的弹幕文件',
    );
  }

  const format = detectFormat(filePath, content);
  let payload = content;
  if (truncated && format === 'xml') payload = repairTruncatedXml(content);

  let parsed: ParsedDanmaku;
  try {
    if (format === 'xml') parsed = parseDanmakuXml(payload);
    else if (format === 'ass') parsed = parseDanmakuAss(payload);
    else if (format === 'srt') parsed = parseDanmakuSrt(payload);
    else parsed = parseDanmakuJson(payload);
  } catch (err) {
    return emptyParsed([`弹幕解析失败（${format}）：${filePath}（${errMsg(err)}）`, ...warnings]);
  }

  parsed.warnings = [...warnings, ...parsed.warnings];
  return parsed;
}

/* ============================================================================
 * XML（biliLive-tools 标准产出）
 * ========================================================================== */

/**
 * 递归下钻查找条目节点；<i>/<root>/<danmaku> 之类的包装层不关心名字。
 * 只做深度限制、不记录已访问节点：解析器产出的一定是树（无环），
 * 十万级节点上再维护一个 Set 只是白白增加内存。
 */
function walkItemTags(root: unknown, visit: (tag: string, node: unknown) => void): void {
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (Object.prototype.hasOwnProperty.call(TAG_KIND, key)) visit(key, value);
      else if (value !== null && typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(root, 0);
}

/** 取节点上的属性（剥掉 @_ 前缀）；同时兼容 attributesGroupName 用法 */
function nodeAttrs(node: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.startsWith(ATTR_PREFIX)) {
      const name = k.slice(ATTR_PREFIX.length);
      if (typeof v === 'string') out[name] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') out[name] = String(v);
    }
  }
  return out;
}

/** 补上 fast-xml-parser 不处理的数字字符引用（&#65; / &#x41;）—— 弹幕文本是任意用户输入 */
function decodeNumericRefs(s: string): string {
  if (!s.includes('&#')) return s;
  return s.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (whole, body: string) => {
    const code = body.startsWith('x') ? Number.parseInt(body.slice(1), 16) : Number(body);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
    return String.fromCodePoint(code);
  });
}

/** 取节点文本（fast-xml-parser：纯文本节点是字符串，带属性时挂在 #text 下） */
function nodeText(node: unknown): string {
  if (typeof node === 'string') return decodeNumericRefs(node).trim();
  if (typeof node === 'number') return String(node);
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return '';
  const t = (node as Record<string, unknown>)[TEXT_NODE];
  if (typeof t === 'string') return decodeNumericRefs(t).trim();
  if (typeof t === 'number') return String(t);
  return '';
}

/** `p` 属性 → 字段数组。B站标准 8 段以上，缺失字段不崩（多余的空串由调用方兜底） */
function splitP(p: string | undefined): string[] {
  if (typeof p !== 'string' || !p) return [];
  return p.split(',');
}

/**
 * 时间字段推定：
 *  1) p 的第 0 段（B站标准：相对开播时刻的秒，可能带小数）
 *  2) 显式属性（不同工具产出差异大；time 放最后，因为 SC 的 time 可能是停留时长）
 * 走 toSec 兜住「毫秒时间戳」写法（陷阱 #9）。
 */
function pickRawTime(attrs: Record<string, string>, fields: string[]): number | undefined {
  const fromP = toSec(num(fields[0]));
  if (fromP !== undefined) return round3(fromP);
  for (const key of ['rawTime', 'raw_time', 'timestamp', 'ts', 'stime', 'time']) {
    const v = num(attrs[key]);
    if (v !== undefined) {
      const sec = toSec(v);
      if (sec !== undefined) return round3(sec);
    }
  }
  return undefined;
}

/** 事件附加信息（SC 金额 / 舰长等级 / 礼物名 + 数量） */
function eventExtra(kind: DanmakuEventKind, attrs: Record<string, string>): { extra?: string; value?: number } {
  if (kind === 'superchat') {
    const price = pickNum(attrs, ['price', 'value', 'amount', 'money', 'sc_price', 'price_yuan']);
    return price !== undefined ? { extra: `SC ¥${price}`, value: price } : { extra: 'SC' };
  }
  if (kind === 'guard') {
    const level = pickNum(attrs, ['guard_level', 'guardlevel', 'level', 'role']);
    const price = pickNum(attrs, ['price', 'value', 'amount']);
    const extra = level !== undefined ? `上舰 等级${level}` : '上舰';
    return price !== undefined ? { extra, value: price } : { extra };
  }
  const giftName = pickStr(attrs, ['giftname', 'gift_name', 'gift', 'name']) ?? '礼物';
  const count = pickNum(attrs, ['num', 'count', 'gift_num', 'quantity']) ?? 1;
  const price = pickNum(attrs, ['price', 'value', 'amount', 'total_price']);
  const extra = `${giftName} x${count}`;
  return price !== undefined ? { extra, value: price } : { extra };
}

/**
 * 解析 B站直播弹幕 XML。
 * 元素形如 `<d p="时间秒,模式,字号,颜色,时间戳,池,用户hash,行号,...">文本</d>`；
 * 高能事件为 `<sc>` / `<guard>` / `<gift>`。
 */
export function parseDanmakuXml(content: string, opts: { maxItems?: number } = {}): ParsedDanmaku {
  const warnings: string[] = [];
  const maxItems = opts.maxItems && opts.maxItems > 0 ? opts.maxItems : Number.POSITIVE_INFINITY;
  if (!content || /^\s*$/.test(content)) return emptyParsed(['弹幕 XML 为空']);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR_PREFIX,
    textNodeName: TEXT_NODE,
    // 关闭数值自动转换：弹幕文本 "123" / 用户 hash 前导零不能被 strnum 吃掉
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    allowBooleanAttributes: true,
    isArray: (tagName: string) => (ITEM_TAGS as readonly string[]).includes(tagName),
  });

  let tree: unknown;
  try {
    tree = parser.parse(content);
  } catch (err) {
    return emptyParsed([`弹幕 XML 解析失败：${errMsg(err)}`]);
  }

  const items: DanmakuItem[] = [];
  const counts = emptyCounts();
  let rawCount = 0;
  let dropped = 0;
  let truncatedByMax = 0;
  let sawSuperchat = false;
  let sawGuard = false;
  let sawGift = false;

  walkItemTags(tree, (tag, node) => {
    const nodes = Array.isArray(node) ? node : [node];
    for (const one of nodes) {
      const kind = TAG_KIND[tag];
      if (!kind) continue;
      rawCount++;
      // 事件存在性必须在 maxItems 截断之前判定：文件里有 SC，就不能因为截断而谎报没有
      if (kind === 'superchat') sawSuperchat = true;
      else if (kind === 'guard') sawGuard = true;
      else if (kind === 'gift') sawGift = true;

      const attrs = nodeAttrs(one);
      const fields = splitP(attrs['p']);
      const rawTime = pickRawTime(attrs, fields);
      if (rawTime === undefined) {
        dropped++;
        continue;
      }

      let text = nodeText(one);
      const isEvent = kind !== 'danmaku';
      if (!text && !isEvent) {
        // 空文本弹幕没有任何信号价值
        dropped++;
        continue;
      }

      let extra: string | undefined;
      let value: number | undefined;
      if (isEvent) {
        const e = eventExtra(kind, attrs);
        extra = e.extra;
        value = e.value;
        if (!text) text = extra ?? '';
      }

      const user = isEvent
        ? pickStr(attrs, ['uname', 'user', 'username', 'nickname', 'uid']) ?? fields[6]
        : fields[6];

      if (items.length >= maxItems) {
        truncatedByMax++;
        continue;
      }

      counts[kind]++;
      items.push({
        // 解析阶段 time 先与 rawTime 相同；基准偏移由 applyOffset 统一施加
        time: rawTime,
        rawTime,
        kind,
        text,
        ...(user ? { user } : {}),
        ...(extra !== undefined ? { extra } : {}),
        ...(value !== undefined ? { value } : {}),
      });
    }
  });

  const parsed: ParsedDanmaku = {
    items,
    rawCount,
    counts,
    eventSignalsAvailable: sawSuperchat || sawGuard || sawGift,
    maxRawTime: 0,
    minRawTime: 0,
    warnings,
  };
  fillRange(parsed);

  if (rawCount === 0) warnings.push('弹幕 XML 中没有解析到任何 <d>/<sc>/<guard>/<gift> 节点（文件可能不是 B站弹幕 XML）');
  if (dropped > 0) warnings.push(`有 ${dropped} 条弹幕缺少合法时间戳或文本，已丢弃`);
  if (truncatedByMax > 0) {
    warnings.push(`条目数超过 maxItems=${maxItems}，已按文件顺序只保留前 ${maxItems} 条，丢弃 ${truncatedByMax} 条`);
  }
  if (!parsed.eventSignalsAvailable) warnings.push(degradedNote('弹幕 XML'));
  return parsed;
}

/* ============================================================================
 * ASS / SRT / JSON 兜底
 * ========================================================================== */

/** ASS 时间 `0:00:01.23` → 秒 */
function parseAssTime(raw: string): number {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})[.:,](\d{1,3})\s*$/.exec(raw);
  if (!m) return NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3]);
  const frac = (m[4] ?? '0');
  const ms = Number(frac) / 10 ** frac.length;
  if (!Number.isFinite(h + mi + s + ms)) return NaN;
  return h * 3600 + mi * 60 + s + ms;
}

/** 清掉 ASS 内联标签与换行转义，得到纯文本 */
function cleanAssText(s: string): string {
  return s
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nnh]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按分隔符切出最多 n 段（最后一段保留剩余内容：ASS 的 Text 字段里可能含逗号） */
function splitLimited(payload: string, n: number, sep: string): string[] {
  const out: string[] = [];
  let rest = payload;
  for (let i = 0; i < n - 1; i++) {
    const idx = rest.indexOf(sep);
    if (idx < 0) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  out.push(rest);
  return out;
}

/**
 * 解析 ASS 弹幕（Dialogue 行）。信号分析优先用 XML：
 * ASS 里没有 SC/上舰/礼物的结构化信息，也没有用户 hash，只能当兜底。
 */
export function parseDanmakuAss(content: string, opts: { maxItems?: number } = {}): ParsedDanmaku {
  const maxItems = opts.maxItems && opts.maxItems > 0 ? opts.maxItems : Number.POSITIVE_INFINITY;
  if (!content || /^\s*$/.test(content)) return emptyParsed(['弹幕 ASS 为空']);

  const lines = content.split(/\r?\n/);
  const formatFields: string[] = [];
  let section = '';
  const items: DanmakuItem[] = [];
  const counts = emptyCounts();
  let rawCount = 0;
  let dropped = 0;
  let truncatedByMax = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sec = /^\[(.+?)\]$/.exec(trimmed);
    if (sec) {
      section = (sec[1] ?? '').trim().toLowerCase();
      continue;
    }
    if (!section.startsWith('events')) continue;

    if (/^Format\s*:/i.test(trimmed)) {
      formatFields.length = 0;
      for (const f of trimmed.slice(trimmed.indexOf(':') + 1).split(',')) formatFields.push(f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(trimmed)) continue; // Comment 行不是弹幕

    rawCount++;
    const payload = trimmed.slice(trimmed.indexOf(':') + 1);
    // 标准 10 字段：Layer, Start, End, Style, Name, MarginL/R/V, Effect, Text
    const width = formatFields.length >= 2 ? formatFields.length : 10;
    const parts = splitLimited(payload, width, ',');
    const startIdx = formatFields.indexOf('start');
    const textIdx = formatFields.indexOf('text');
    const start = parseAssTime(parts[startIdx >= 0 ? startIdx : 1] ?? '');
    const text = cleanAssText(parts[textIdx >= 0 ? textIdx : width - 1] ?? '');
    if (!Number.isFinite(start) || !text) {
      dropped++;
      continue;
    }
    if (items.length >= maxItems) {
      truncatedByMax++;
      continue;
    }
    const t = round3(Math.max(0, start));
    counts.danmaku++;
    items.push({ time: t, rawTime: t, kind: 'danmaku', text });
  }

  const parsed: ParsedDanmaku = {
    items,
    rawCount,
    counts,
    eventSignalsAvailable: false, // ASS 不携带高能事件结构，明确降级（陷阱 #25）
    maxRawTime: 0,
    minRawTime: 0,
    warnings: [],
  };
  fillRange(parsed);
  if (rawCount === 0) parsed.warnings.push('弹幕 ASS 中没有解析到 Dialogue 行');
  if (dropped > 0) parsed.warnings.push(`有 ${dropped} 条 ASS 弹幕时间戳或文本非法，已丢弃`);
  if (truncatedByMax > 0) parsed.warnings.push(`条目数超过 maxItems=${maxItems}，已丢弃 ${truncatedByMax} 条`);
  parsed.warnings.push(degradedNote('弹幕 ASS'));
  return parsed;
}

/** SRT 兜底（最差情况下的字幕式弹幕） */
export function parseDanmakuSrt(content: string): ParsedDanmaku {
  if (!content || /^\s*$/.test(content)) return emptyParsed(['弹幕 SRT 为空']);
  const items: DanmakuItem[] = [];
  const counts = emptyCounts();
  let rawCount = 0;
  let dropped = 0;

  const blocks = content.split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    rawCount++;
    const timeLine = lines[timeIdx] ?? '';
    const from = timeLine.slice(0, timeLine.indexOf('-->'));
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(from);
    const text = lines.slice(timeIdx + 1).join(' ').replace(/<[^>]*>/g, '').trim();
    if (!m || !text) {
      dropped++;
      continue;
    }
    const t = round3(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 10 ** (m[4] ?? '').length);
    counts.danmaku++;
    items.push({ time: t, rawTime: t, kind: 'danmaku', text });
  }

  const parsed: ParsedDanmaku = {
    items,
    rawCount,
    counts,
    eventSignalsAvailable: false,
    maxRawTime: 0,
    minRawTime: 0,
    warnings: [],
  };
  fillRange(parsed);
  if (rawCount === 0) parsed.warnings.push('弹幕 SRT 中没有解析到合法字幕块');
  if (dropped > 0) parsed.warnings.push(`有 ${dropped} 条 SRT 条目时间戳或文本非法，已丢弃`);
  parsed.warnings.push(degradedNote('弹幕 SRT'));
  return parsed;
}

/** 事件类型字符串 → 归一化类型 */
function kindFromString(raw: string): DanmakuEventKind {
  const s = raw.toLowerCase();
  if (s.includes('super') || s === 'sc' || s.includes('醒目')) return 'superchat';
  if (s.includes('guard') || s.includes('舰')) return 'guard';
  if (s.includes('gift') || s.includes('礼物')) return 'gift';
  return 'danmaku';
}

/**
 * JSON 兜底（biliLive-tools / 第三方工具导出的 JSON 变体）。
 * 结构差异太大，这里只做「尽力而为」的字段探测，且不做数值假设以外的推断。
 */
function parseDanmakuJson(content: string): ParsedDanmaku {
  if (!content || /^\s*$/.test(content)) return emptyParsed(['弹幕 JSON 为空']);
  let data: unknown;
  try {
    data = JSON.parse(stripBom(content));
  } catch (err) {
    return emptyParsed([`弹幕 JSON 解析失败：${errMsg(err)}`]);
  }

  // 兼容：数组根 / {data:{replies:[]}} / {list|items|danmaku|data:[]}
  const collect = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const key of ['data', 'list', 'items', 'danmaku', 'replies', 'danmakus']) {
        const inner = o[key];
        if (Array.isArray(inner)) return inner;
        if (inner && typeof inner === 'object') {
          const nested = collect(inner);
          if (nested.length) return nested;
        }
      }
    }
    return [];
  };
  const rows = collect(data);
  if (rows.length === 0) return emptyParsed(['弹幕 JSON 中没有找到条目数组（未知结构）']);

  const items: DanmakuItem[] = [];
  const counts = emptyCounts();
  let dropped = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      dropped++;
      continue;
    }
    const r = row as Record<string, unknown>;
    let rawTime: number | undefined;
    for (const key of ['time', 'rawTime', 'raw_time', 'progress', 'ts', 'timestamp']) {
      const sec = toSec(num(r[key]));
      if (sec !== undefined) {
        rawTime = round3(sec);
        break;
      }
    }
    const text = String(r['text'] ?? r['content'] ?? r['msg'] ?? r['message'] ?? '').trim();
    if (rawTime === undefined || !text) {
      dropped++;
      continue;
    }
    const kindRaw = String(r['kind'] ?? r['type'] ?? r['event'] ?? '');
    const kind = kindRaw
      ? kindFromString(kindRaw)
      : (r['giftName'] ?? r['gift_name']) !== undefined
        ? 'gift'
        : 'danmaku';
    const user = r['user'] ?? r['uname'] ?? r['nickname'];
    const userName =
      typeof user === 'string' ? user : user && typeof user === 'object' ? String((user as Record<string, unknown>)['name'] ?? '') : '';
    const price = num(r['price'] ?? r['value'] ?? r['amount']);
    counts[kind]++;
    items.push({
      time: rawTime,
      rawTime,
      kind,
      text,
      ...(userName ? { user: userName } : {}),
      ...(price !== undefined ? { value: price } : {}),
    });
  }

  const eventSignalsAvailable = counts.superchat + counts.guard + counts.gift > 0;
  const parsed: ParsedDanmaku = {
    items,
    rawCount: rows.length,
    counts,
    eventSignalsAvailable,
    maxRawTime: 0,
    minRawTime: 0,
    warnings: [],
  };
  fillRange(parsed);
  if (dropped > 0) parsed.warnings.push(`有 ${dropped} 条 JSON 弹幕字段缺失，已丢弃`);
  if (!eventSignalsAvailable) parsed.warnings.push(degradedNote('弹幕 JSON'));
  return parsed;
}

/* ============================================================================
 * 时间基准统一（任务书 §4.2）
 * ========================================================================== */

/** 把弹幕时间统一到「相对视频起点」：newTime = rawTime - offset（rawTime 原样保留） */
export function applyOffset(items: DanmakuItem[], offsetSec: number): DanmakuItem[] {
  const offset = Number.isFinite(offsetSec) ? offsetSec : 0;
  if (offset === 0) return items.map((it) => ({ ...it, time: round3(it.rawTime) }));
  return items.map((it) => ({ ...it, time: round3(it.rawTime - offset) }));
}

/**
 * 基线偏移推定：offset ≈ maxRawTime - videoDuration。
 *  - |offset| < 15s：视为同一基准（视频起点≈开播时刻），offset 取 0，confidence high；
 *  - offset 显著为正（弹幕比视频长）：取该差值，confidence high；
 *  - 弹幕明显短于视频：无法区分「基准差异」与「弹幕缺失」，返回 0 且 confidence low；
 *  - 配置了固定值时直接用配置值（+ 校准值），不再自动推定。
 */
export function estimateOffset(
  items: DanmakuItem[],
  videoDurationSec: number,
  opts: { configured?: number | 'auto'; calibration?: number } = {},
): { offset: number; confidence: 'high' | 'low'; note: string } {
  const configured = opts.configured ?? 'auto';
  const calibration = Number.isFinite(opts.calibration) ? (opts.calibration as number) : 0;

  if (typeof configured === 'number' && Number.isFinite(configured)) {
    const offset = round3(configured + calibration);
    return {
      offset,
      confidence: 'high',
      note: `使用配置的固定偏移 ${configured}s${calibration ? ` + 校准 ${calibration}s` : ''}，跳过自动推定`,
    };
  }

  let maxRaw = 0;
  for (const it of items) if (it.rawTime > maxRaw) maxRaw = it.rawTime;

  if (items.length === 0) {
    return { offset: round3(calibration), confidence: 'low', note: '弹幕为空，无法比对时间跨度，offset 按校准值处理' };
  }
  if (!(videoDurationSec > 0)) {
    return {
      offset: round3(calibration),
      confidence: 'low',
      note: '视频时长未知或为 0，无法比对弹幕时间跨度，offset 按校准值处理',
    };
  }

  const diff = maxRaw - videoDurationSec;
  if (Math.abs(diff) < SAME_BASELINE_TOLERANCE_SEC) {
    return {
      offset: round3(calibration),
      confidence: 'high',
      note:
        `弹幕最晚时刻 ${round3(maxRaw)}s 与视频时长 ${round3(videoDurationSec)}s 相差 ${round3(diff)}s` +
        `（<${SAME_BASELINE_TOLERANCE_SEC}s），判定为同一时间基准，offset=0`,
    };
  }
  if (diff > 0) {
    return {
      offset: round3(diff + calibration),
      confidence: 'high',
      note:
        `弹幕时间轴比视频长 ${round3(diff)}s（弹幕最晚 ${round3(maxRaw)}s vs 视频 ${round3(videoDurationSec)}s），` +
        `推定 offset=${round3(diff + calibration)}s（转写时间 = 弹幕时间 - offset）`,
    };
  }
  return {
    offset: round3(calibration),
    confidence: 'low',
    note:
      `弹幕最晚时刻（${round3(maxRaw)}s）比视频时长（${round3(videoDurationSec)}s）短 ${round3(-diff)}s，` +
      '无法区分「基准差异」与「弹幕尾部缺失」，保守取 offset=0',
  };
}

/* ============================================================================
 * 密度 / 峰值
 * ========================================================================== */

/** 每 windowSec 秒的弹幕计数曲线（入参时间必须已对齐视频起点） */
export function buildDensity(items: DanmakuItem[], opts: { windowSec: number; videoDuration: number }): DensityPoint[] {
  const windowSec = opts.windowSec > 0 ? opts.windowSec : 10;
  let span = opts.videoDuration > 0 ? opts.videoDuration : 0;
  if (span <= 0) {
    // 视频时长未知时用弹幕最晚时刻兜底，避免产出空曲线（下游仍会拿到可用信号）
    let maxTime = 0;
    for (const it of items) if (it.time > maxTime) maxTime = it.time;
    span = maxTime > 0 ? maxTime + windowSec : 0;
  }
  if (span <= 0) return [];

  const n = Math.max(1, Math.ceil(span / windowSec));
  const points: DensityPoint[] = [];
  for (let i = 0; i < n; i++) {
    points.push({
      start: round3(i * windowSec),
      end: round3(Math.min((i + 1) * windowSec, span)),
      count: 0,
      highEnergy: 0,
    });
  }

  for (const it of items) {
    // 落在视频之外的弹幕不参与统计：时间基准推定错误时，硬塞进首/尾窗口会伪造出一个大峰
    if (it.time < 0 || it.time >= span) continue;
    const idx = Math.min(n - 1, Math.floor(it.time / windowSec));
    const p = points[idx];
    if (!p) continue;
    p.count++;
    if (it.kind !== 'danmaku') p.highEnergy++;
  }
  return points;
}

/** 取窗口区间内的弹幕（可选上限，保护词频统计的开销） */
function itemsInRange(items: DanmakuItem[], start: number, end: number, limit: number): DanmakuItem[] {
  const out: DanmakuItem[] = [];
  for (const it of items) {
    if (it.time < start || it.time >= end) continue;
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 密度峰值 Top-N。
 *  - 先按 minIntensity 归一化阈值挑出「热窗口」，再把间隔小于 minGapSec 的热窗口并成一个峰，
 *    避免同一个高能片段被切成好几个相邻峰（默认 30 秒）；
 *  - count = 峰内弹幕总数；intensity = 峰内最热单窗口 / 全场最热单窗口，天然落在 0–1；
 *  - items 传入时给每个峰附上该时间窗自己的热词（给 LLM 用），不传则为空数组。
 */
export function findPeaks(
  density: DensityPoint[],
  opts: { topN: number; minIntensity?: number; items?: DanmakuItem[]; minGapSec?: number },
): PeakWindow[] {
  return findPeaksWithNoise(density, opts, []);
}

function findPeaksWithNoise(
  density: DensityPoint[],
  opts: { topN: number; minIntensity?: number; items?: DanmakuItem[]; minGapSec?: number },
  noiseWords: string[],
): PeakWindow[] {
  if (density.length === 0 || opts.topN <= 0) return [];
  let maxCount = 0;
  for (const d of density) if (d.count > maxCount) maxCount = d.count;
  if (maxCount <= 0) return [];

  const minGap = opts.minGapSec !== undefined && opts.minGapSec >= 0 ? opts.minGapSec : DEFAULT_MIN_GAP_SEC;
  const minIntensity = opts.minIntensity !== undefined && opts.minIntensity >= 0 ? opts.minIntensity : DEFAULT_MIN_INTENSITY;
  const threshold = Math.max(1, minIntensity * maxCount);

  // 1) 热窗口 + 合并（相邻或间隔 < minGap 即并入同一个峰）
  const groups: DensityPoint[][] = [];
  for (const d of density) {
    if (d.count < threshold) continue;
    const cur = groups[groups.length - 1];
    const last = cur ? cur[cur.length - 1] : undefined;
    if (cur && last && d.start - last.end < minGap) cur.push(d);
    else groups.push([d]);
  }

  const peaks: PeakWindow[] = [];
  for (const g of groups) {
    const first = g[0];
    const last = g[g.length - 1];
    if (!first || !last) continue;
    let count = 0;
    let peakWindowCount = 0;
    for (const d of g) {
      count += d.count;
      if (d.count > peakWindowCount) peakWindowCount = d.count;
    }
    let keywords: string[] = [];
    if (opts.items && opts.items.length > 0) {
      const sub = itemsInRange(opts.items, first.start, last.end, MAX_ITEMS_PER_PEAK_SCAN);
      keywords = extractKeywords(sub, { topN: KEYWORDS_PER_PEAK, noiseWords }).map((k) => k.word);
    }
    peaks.push({
      start: first.start,
      end: last.end,
      count,
      intensity: round3(clamp(peakWindowCount / maxCount, 0, 1)),
      keywords,
    });
  }

  peaks.sort((a, b) => b.count - a.count || a.start - b.start);
  return peaks.slice(0, opts.topN);
}

/* ============================================================================
 * 关键词（纯 JS n-gram，禁止分词依赖）
 * ========================================================================== */

/** 判断一个脚本段属于「CJK」还是「字母数字」 */
function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x3400 && c <= 0x4dbf) || // 扩展 A
    (c >= 0x4e00 && c <= 0x9fff) || // 基本区
    (c >= 0xf900 && c <= 0xfaff) || // 兼容表意
    (c >= 0x3040 && c <= 0x30ff) // 假名（翻唱/日语弹幕常见）
  );
}

function isWordChar(ch: string): boolean {
  return /[0-9A-Za-z]/.test(ch);
}

/**
 * 候选词过滤：
 *  - 单字 / 超过 12 字 / 纯数字 / 纯标点 → 丢弃；
 *  - 命中噪声词表或停用词 → 丢弃；
 *  - 刷屏启发式：同一字符重复（啊啊啊 / 666666）或整串只有 1–2 种字符的长串 → 丢弃。
 */
function isNoiseGram(gram: string, noise: Set<string>): boolean {
  if (gram.length < 2 || gram.length > 12) return true;
  if (/^\d+$/.test(gram)) return true;
  if (/^[\p{P}\p{S}\p{Z}\s]+$/u.test(gram)) return true;
  if (noise.has(gram) || STOP_GRAMS.has(gram)) return true;
  const uniq = new Set(gram).size;
  if (uniq === 1 && gram.length >= 3) return true;
  if (gram.length >= 5 && uniq <= 2) return true;
  return false;
}

/**
 * 高频词：2–4 字 n-gram + 噪声过滤 + **左右邻字熵**去碎片。
 *
 * 不引入分词依赖 —— 中文弹幕短、口语化，n-gram 的召回足够。
 *
 * ★ 为什么需要"邻字熵"（2026-09-23 修复，实测数据驱动）：
 *   真实一批 4502 条弹幕的 top 片段是
 *     `安可(444) Anko(247) 表情(196) 情包(194) 抱抱(183) 可表(102) 动态(89) 可动(87) 态表(87)`
 *   —— `表情包` 被同时产出成 `表情`/`情包`/`可表`，`动态表情` 产出成 `动态`/`可动`/`态表`。
 *   它们**互相不构成包含关系**（`情包` 并不包含 `表情`），所以老的"包含关系去重"一个都拦不住，
 *   白白占掉 top-N 名额，喂给 LLM 的信号里全是假词。
 *
 *   试过但**不可行**的判据：按"出现位置是否被更长的高频 n-gram 完全覆盖"来删。
 *   算术上就不成立 —— 同一句里 `动态表情包` 会同时产出 `动态表情`(位置0) 与 `表情包`(位置2)，
 *   `情包` 每次出现都落在两者之一，但没有任何**单个**更长词的覆盖区间集合能包住它
 *   （`动态表情` 盖 0/4，`表情包` 盖 2/6，4 与 6 各自落空）。要么按"独立出现次数 ≥ 阈值"
 *   硬调参，要么换判据。
 *
 *   最终用**左右邻字熵**（无监督新词发现的经典判据，不需要任何阈值调参）：
 *   一个真正的词，左右两侧出现什么字是**自由**的（`[这]表情包[真]`、`[个]表情包[啊]`），
 *   邻字分布散 ⇒ 熵高；而碎片 `情包` 左边几乎只能是"表"、`可表` 左边只能是"包"，
 *   邻字分布集中 ⇒ 熵低。判据：**两侧邻字熵都必须 > 0**（即左右各至少出现过 2 种不同的邻字）。
 *   这同时天然放过了 `安可`/`Anko` 这类中英混排（它们两侧邻字很自由）。
 */
export function extractKeywords(
  items: DanmakuItem[],
  opts: { topN: number; noiseWords: string[]; timeRange?: { start: number; end: number } },
): Array<{ word: string; count: number }> {
  if (opts.topN <= 0 || items.length === 0) return [];
  const noise = new Set<string>();
  for (const w of opts.noiseWords ?? []) {
    const t = String(w).trim().toLowerCase();
    if (t) noise.add(t);
  }

  const range = opts.timeRange;
  // key 用归一化（小写）形式合并，value 保留首次出现的原样写法
  const counter = new Map<string, number>();
  const display = new Map<string, string>();
  /** 每条弹幕内每个候选只记第一次出现 —— 邻字熵要的是"跨语境"分布，句内重复无信息量 */
  const seenInItem = new Set<string>();
  /** 左/右邻字集合（最多各 MAX_NEIGHBOR 种），用于熵判据 */
  const leftNeighbors = new Map<string, Set<string>>();
  const rightNeighbors = new Map<string, Set<string>>();
  const MAX_NEIGHBOR = 64;

  const add = (raw: string, left: string, right: string): void => {
    const word = raw.trim();
    if (!word) return;
    const key = word.toLowerCase();
    if (isNoiseGram(key, noise)) return;
    const n = counter.get(key) ?? 0;
    counter.set(key, n + 1);
    if (n === 0) display.set(key, word);
    if (seenInItem.has(key)) return;
    seenInItem.add(key);
    let L = leftNeighbors.get(key);
    if (!L) {
      L = new Set();
      leftNeighbors.set(key, L);
    }
    if (L.size < MAX_NEIGHBOR) L.add(left);
    let R = rightNeighbors.get(key);
    if (!R) {
      R = new Set();
      rightNeighbors.set(key, R);
    }
    if (R.size < MAX_NEIGHBOR) R.add(right);
  };

  for (const item of items) {
    if (range && (item.time < range.start || item.time >= range.end)) continue;
    const text = item.text;
    if (!text) continue;
    seenInItem.clear();
    const END = '\u0000'; // 边界标记：位于串首/串尾时，"邻字"是这个哨兵
    // 按字符类别切成「CJK 段」与「字母数字段」，避免跨类别拼出无意义 n-gram
    let i = 0;
    while (i < text.length) {
      const ch = text[i] ?? '';
      if (isCjk(ch)) {
        let j = i;
        while (j < text.length && isCjk(text[j] ?? '')) j++;
        const run = text.slice(i, j);
        // 整段刷屏直接放弃，不让它污染 n-gram：
        //  - 同一个字连打 5 次以上（啊啊啊啊啊）
        //  - 长串但字符种类极少（打卡打卡打卡打卡 / 哈哈哈哈哈）
        if (!/(.)\1{4,}/u.test(run) && !(run.length >= 6 && new Set(run).size <= 3)) {
          for (let n = 2; n <= 4; n++) {
            for (let k = 0; k + n <= run.length; k++) {
              // 邻字取"该段内"的相邻字符；段首/段尾用哨兵（标点/emoji 也算边界）
              const left = k > 0 ? (run[k - 1] ?? END) : END;
              const right = k + n < run.length ? (run[k + n] ?? END) : END;
              add(run.slice(k, k + n), left, right);
            }
          }
        }
        i = j;
        continue;
      }
      if (isWordChar(ch)) {
        let j = i;
        while (j < text.length && isWordChar(text[j] ?? '')) j++;
        add(text.slice(i, j), END, END); // 英文/数字整串：不参与熵过滤
        i = j;
        continue;
      }
      i++; // 标点/emoji/空白：跳过
    }
  }

  /** 左右邻字是否都足够"散"（各至少 2 种）—— 真正的词两侧用字自由，碎片则被夹死 */
  const hasFreeBoundary = (key: string): boolean => {
    const L = leftNeighbors.get(key);
    const R = rightNeighbors.get(key);
    return (L?.size ?? 0) >= 2 && (R?.size ?? 0) >= 2;
  };

  const ranked = [...counter.entries()]
    .map(([key, count]) => ({ word: display.get(key) ?? key, key, count }))
    .sort((a, b) => b.count - a.count || b.word.length - a.word.length || a.word.localeCompare(b.word));

  const picked: Array<{ word: string; count: number }> = [];
  for (const cand of ranked) {
    if (picked.length >= opts.topN) break;
    /* 纯 ASCII（英文/数字）串不判熵：它们本来就是整串切出来的，两侧信息不适用 */
    const pureAscii = /^[\x00-\x7F]+$/.test(cand.key);
    if (!pureAscii && !hasFreeBoundary(cand.key)) continue;
    /* 包含关系去重（老逻辑，作为兜底保留）：`笑死我了` 命中后不再单列 `笑死` */
    if (picked.some((p) => p.word.includes(cand.word) || cand.word.includes(p.word))) continue;
    picked.push({ word: cand.word, count: cand.count });
  }
  return picked;
}

/** 高能事件（SC / 上舰 / 礼物）列表，按时间排序 */
export function highEnergyEvents(items: DanmakuItem[]): DanmakuItem[] {
  return items.filter((it) => it.kind !== 'danmaku').sort((a, b) => a.time - b.time);
}

/* ============================================================================
 * Signals 组装
 * ========================================================================== */

/** 组装 Signals（WP2 的最终产出，写入任务目录 signals.json） */
export function buildSignals(input: {
  taskId: string;
  items: DanmakuItem[];
  videoDuration: number;
  offset: number;
  offsetConfidence?: 'high' | 'low';
  offsetNote?: string;
  parsed: Pick<ParsedDanmaku, 'counts' | 'eventSignalsAvailable' | 'rawCount'>;
  config: AppConfig['danmaku'];
  warnings?: string[];
}): Signals {
  const { taskId, items, videoDuration, offset, config } = input;
  const windowSec = config.densityWindowSec > 0 ? config.densityWindowSec : 10;

  const density = buildDensity(items, { windowSec, videoDuration });
  const peaks = findPeaksWithNoise(
    density,
    {
      topN: config.peakTopN > 0 ? config.peakTopN : 20,
      minIntensity: config.peakMinIntensity,
      minGapSec: DEFAULT_MIN_GAP_SEC,
      items,
    },
    config.noiseWords ?? [],
  );
  const keywords = extractKeywords(items, {
    topN: config.keywordTopN > 0 ? config.keywordTopN : 40,
    noiseWords: config.noiseWords ?? [],
  });

  const warnings = input.warnings ?? [];
  // Signals 结构里没有 warnings 字段（契约固定），因此通过日志出口暴露给运维
  for (const w of warnings) log.warn(w, { mod: 'danmaku', taskId });
  log.debug('弹幕信号组装完成', {
    mod: 'danmaku',
    taskId,
    data: {
      rawCount: input.parsed.rawCount,
      used: items.length,
      eventSignalsAvailable: input.parsed.eventSignalsAvailable,
      eventCounts: input.parsed.counts,
      offset,
      offsetConfidence: input.offsetConfidence ?? 'unknown',
      offsetNote: input.offsetNote,
      windows: density.length,
      peaks: peaks.length,
      keywords: keywords.length,
    },
  });

  return {
    taskId,
    danmakuOffset: round3(offset),
    eventSignalsAvailable: input.parsed.eventSignalsAvailable,
    eventCounts: input.parsed.counts,
    density,
    peaks,
    keywords,
    // 实际参与信号分析的条目数（含高能事件），便于与 rawCount 对照排查丢条
    danmakuTotal: items.length,
    videoDuration: round3(videoDuration > 0 ? videoDuration : 0),
    createdAt: nowIso(),
  };
}

/** 便捷入口：一次跑完「读文件 → 解析 → 偏移对齐 → 密度 → 峰值 → 词频 → Signals」 */
export function analyzeDanmaku(input: {
  taskId: string;
  filePath: string | undefined;
  videoDuration: number;
  config: AppConfig;
}): { signals: Signals; items: DanmakuItem[]; warnings: string[] } {
  const warnings: string[] = [];
  let parsed = emptyParsed();

  if (!input.filePath) {
    warnings.push('未提供弹幕文件路径，本场没有弹幕信号（密度曲线全为 0，选片将只依赖转写）');
  } else {
    parsed = loadDanmaku(input.filePath);
    warnings.push(...parsed.warnings);
  }

  const est = estimateOffset(parsed.items, input.videoDuration, {
    configured: input.config.danmaku.danmakuOffsetSec,
    calibration: input.config.danmaku.offsetCalibrationSeconds,
  });
  if (est.confidence === 'low' && parsed.items.length > 0) {
    warnings.push(`时间基准偏移推定置信度低：${est.note}`);
  }
  if (parsed.items.length > 0 && parsed.rawCount > parsed.items.length) {
    warnings.push(`原始弹幕 ${parsed.rawCount} 条，实际参与分析 ${parsed.items.length} 条（其余为截断或字段非法）`);
  }

  const items = applyOffset(parsed.items, est.offset);
  const signals = buildSignals({
    taskId: input.taskId,
    items,
    videoDuration: input.videoDuration,
    offset: est.offset,
    offsetConfidence: est.confidence,
    offsetNote: est.note,
    parsed,
    config: input.config.danmaku,
    warnings,
  });
  return { signals, items, warnings };
}

/* ============================================================================
 * 给 LLM 的紧凑文本 / 降级兜底
 * ========================================================================== */

/**
 * 把 Signals 压缩成给 LLM 的紧凑文本。
 * 只带 [start, end) 这个时间窗里的信号：区间内的峰（各带自己的热词）+ 由这些峰推导出的热词，
 * 结尾只给聚合的「全场参考」（总条数 / 偏移），不带任何窗口外的时间点，
 * 这样分块喂给 LLM 时每块都是自洽的，且 token 可控。
 */
export function signalsToPromptText(
  signals: Signals,
  range: { start: number; end: number },
  opts: { maxPeaks?: number; maxKeywords?: number } = {},
): string {
  const maxPeaks = opts.maxPeaks && opts.maxPeaks > 0 ? opts.maxPeaks : 5;
  const maxKeywords = opts.maxKeywords && opts.maxKeywords > 0 ? opts.maxKeywords : 12;
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.max(range.start, range.end);

  const inRange = signals.peaks
    .filter((p) => p.end > start && p.start < end)
    .sort((a, b) => b.intensity - a.intensity || b.count - a.count || a.start - b.start)
    .slice(0, maxPeaks);

  // 密度按窗口对齐统计（窗口起点落在区间内即计入；窗口很小时误差可忽略）
  let count = 0;
  let highEnergy = 0;
  for (const d of signals.density) {
    if (d.start >= start && d.start < end) {
      count += d.count;
      highEnergy += d.highEnergy;
    }
  }

  // 只允许本窗口峰的热词进入关键词行，count 取全场词频（没有就不标数字）
  const globalCount = new Map(signals.keywords.map((k) => [k.word, k.count]));
  const words: Array<{ word: string; count: number }> = [];
  const seen = new Set<string>();
  for (const p of inRange) {
    for (const w of p.keywords) {
      if (seen.has(w)) continue;
      seen.add(w);
      words.push({ word: w, count: globalCount.get(w) ?? 0 });
    }
  }
  words.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

  const lines: string[] = [];
  const span = `${fmtDuration(start)}-${fmtDuration(end)}`;
  lines.push(`[弹幕信号 ${span}] 窗口内弹幕 ${count} 条，其中高能事件（SC/上舰/礼物） ${highEnergy} 次`);
  if (inRange.length > 0) {
    for (const p of inRange) {
      const kw = p.keywords.slice(0, 6).join('/') || '无';
      // 与窗口相交的峰只显示相交段，保证输出里出现的时间点都落在本窗口内
      const from = Math.max(p.start, start);
      const to = Math.min(p.end, end);
      lines.push(
        `- 密度峰 ${fmtDuration(from)}-${fmtDuration(to)}：${p.count} 条，强度 ${p.intensity.toFixed(2)}，热词 ${kw}`,
      );
    }
  } else {
    lines.push('- 该窗口内没有显著密度峰值（弹幕稀疏或为平稳段落）');
  }
  if (words.length > 0) {
    lines.push(
      `- 窗口热词：${words
        .slice(0, maxKeywords)
        .map((w) => (w.count > 0 ? `${w.word}(${w.count})` : w.word))
        .join('、')}`,
    );
  }
  if (!signals.eventSignalsAvailable) {
    lines.push('- 提示：本场无 SC/上舰/礼物 事件信号，已降级为普通弹幕密度 + 关键词（陷阱 #25）');
  }
  // 只给聚合元信息，不带全场时长等会跑到窗口外的时间点（调用方在 prompt 头部已有视频时长）
  lines.push(`- 全场参考：本场弹幕共 ${signals.danmakuTotal} 条，时间基准偏移 ${signals.danmakuOffset}s`);
  return lines.join('\n');
}

/** 统计密度曲线上某区间的弹幕数 / 高能事件数 */
function densitySum(density: DensityPoint[], start: number, end: number): { count: number; highEnergy: number } {
  let count = 0;
  let highEnergy = 0;
  for (const d of density) {
    if (d.end <= start || d.start >= end) continue;
    count += d.count;
    highEnergy += d.highEnergy;
  }
  return { count, highEnergy };
}

/** 把 [start,end] 平移进 [0,total]（时长不变；总时长不足时按总时长截断） */
function fitIntoRange(start: number, end: number, dur: number, total: number): { start: number; end: number } {
  const d = Math.min(dur, total);
  let s = start;
  if (s < 0) s = 0;
  if (s + d > total) s = Math.max(0, total - d);
  return { start: s, end: s + d };
}

/** 与已选区间避让：先向右挪，再向左挪，都放不下就放弃（保证互不重叠） */
function placeWithoutOverlap(
  start: number,
  end: number,
  dur: number,
  total: number,
  accepted: Array<{ start: number; end: number }>,
): { start: number; end: number } | null {
  let s = start;
  let e = end;
  for (let guard = 0; guard <= accepted.length + 2; guard++) {
    const hits = accepted.filter((a) => s < a.end && e > a.start);
    if (hits.length === 0) return { start: s, end: e };
    let maxEnd = 0;
    let minStart = Number.POSITIVE_INFINITY;
    for (const h of hits) {
      if (h.end > maxEnd) maxEnd = h.end;
      if (h.start < minStart) minStart = h.start;
    }
    if (maxEnd + dur <= total) {
      s = maxEnd;
      e = s + dur;
      continue;
    }
    if (minStart - dur >= 0) {
      s = minStart - dur;
      e = minStart;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * 降级兜底：LLM 不可用时用密度峰值 Top-N 直接产出候选区间（任务书 §5.5）。
 *  - 以峰为中心、前后各留 bufferSec，时长夹在 [minDurationSec, maxDurationSec]；
 *  - 与已选区间重叠时先右挪再左挪，挪不开就丢弃 → 结果**互不重叠**；
 *  - score 由 intensity 归一化到 0–10，高能事件加成；最终按 score 降序。
 */
export function densityFallbackClips(
  signals: Signals,
  opts: { maxClips: number; minDurationSec: number; maxDurationSec: number; bufferSec: number },
): Array<{ start: number; end: number; score: number; reason: string; keywords: string[] }> {
  const maxClips = Math.max(0, Math.floor(opts.maxClips));
  const buffer = Math.max(0, opts.bufferSec);
  const lastPoint = signals.density[signals.density.length - 1];
  const total = signals.videoDuration > 0 ? signals.videoDuration : (lastPoint?.end ?? 0);
  if (maxClips === 0 || total <= 0 || signals.peaks.length === 0) return [];

  const minDur = clamp(opts.minDurationSec > 0 ? opts.minDurationSec : 1, 1, total);
  const maxDur = clamp(opts.maxDurationSec >= minDur ? opts.maxDurationSec : minDur, minDur, total);

  const accepted: Array<{ start: number; end: number }> = [];
  const out: Array<{ start: number; end: number; score: number; reason: string; keywords: string[] }> = [];

  const peaks = [...signals.peaks].sort((a, b) => b.intensity - a.intensity || b.count - a.count || a.start - b.start);
  for (const peak of peaks) {
    if (out.length >= maxClips) break;
    const span = Math.max(0, peak.end - peak.start);
    const dur = clamp(span + buffer * 2, minDur, maxDur);
    const center = (peak.start + peak.end) / 2;
    const fitted = fitIntoRange(center - dur / 2, center + dur / 2, dur, total);
    const placed = placeWithoutOverlap(fitted.start, fitted.end, dur, total, accepted);
    if (!placed) continue;
    accepted.push(placed);

    const { count, highEnergy } = densitySum(signals.density, peak.start, peak.end);
    const bonus = highEnergy > 0 ? Math.min(0.2, 0.05 * highEnergy) : 0;
    const score = Math.round(clamp(peak.intensity + bonus, 0, 1) * 100) / 10; // 0–10，一位小数

    const heText = highEnergy > 0 ? `，其中高能事件 ${highEnergy} 次` : '';
    const degraded = signals.eventSignalsAvailable ? '' : '（本场无高能事件信号，仅依据弹幕密度与热词）';
    out.push({
      start: round3(placed.start),
      end: round3(placed.end),
      score,
      reason:
        `弹幕密度峰值：${fmtDuration(peak.start)}-${fmtDuration(peak.end)} 共 ${count || peak.count} 条${heText}，` +
        `强度 ${peak.intensity.toFixed(2)}，已前后各留 ${buffer}s 缓冲${degraded}`,
      keywords: peak.keywords.slice(0, 5),
    });
  }

  return out.sort((a, b) => b.score - a.score || a.start - b.start);
}
