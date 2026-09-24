/**
 * 字幕烧录（转写 → ASS，并与弹幕 ASS 合并成一个文件）。
 *
 * ## 为什么需要
 *
 * 成片原来只烧弹幕、**没有字幕**。静音刷视频的人占很大比例，竖屏分发更是离了字幕就没法看；
 * 而转写结果本来就在手上（`transcript.json`），不烧字幕等于白花 ASR 的钱。
 *
 * ## 为什么是「合并」而不是「传两个 ASS」
 *
 * 实测 `POST /task/cut` 的 `files` 只接受**一个** `assFilePath`：
 *
 * ```js
 * const files = { videoFilePath };  if (assFilePath) files['assFilePath'] = assFilePath;
 * ```
 *
 * 所以字幕和弹幕必须合成一个 ASS 再交出去。合并点选在**弹幕 ASS 之上**：
 * 它已经有正确的 `PlayResX/PlayResY`（与视频分辨率一致）、`WrapStyle`、
 * 以及 DanmakuFactory 调好的样式表 —— 继承它比自己新建一份更不容易错位。
 *
 * ## 对齐与踩坑
 *
 *  1. **时间轴基准一致**：`transcript.json` 的时间是相对**整场视频**的秒（与弹幕 XML、
 *     切片 `ffmpegOptions` 的 ss/to 同基准），所以字幕事件直接写整场时间，
 *     由 ffmpeg 在 `ss/to` 里裁 —— 与整场弹幕 ASS 的处理方式完全相同。
 *  2. **必须无 BOM**：带 BOM 的 ASS 交给 biliLive-tools 切片接口会 `HTTP 500`（踩过三次），
 *     因此统一用 `finalizeAss` 落盘。
 *  3. **不覆盖用户的弹幕 ASS**：合并结果写到任务目录下另一个文件，原文件保持原样
 *     （它可能来自录制器，属于别人的产物）。
 *  4. **字幕样式不能照抄弹幕样式**：弹幕是描边+无背景+可能半透明，
 *     字幕需要更大的字号、更靠下的位置和更实的描边，否则两种文字糊在一起分不清。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TranscriptSegment } from './types.ts';
import { ensureDir, exists, hashKey } from './util.ts';
import { findFfprobe } from './media.ts';
import { stripBom } from './danmaku-ass.ts';
import { looksLikeNoise } from './asr.ts';
import { bestAnchor, energyProfileCached, needsAnchor, type EnergyProfile } from './speech-energy.ts';
import { log as globalLog, type Logger } from './logger.ts';

/* ============================================================================
 * 时间与文本处理
 * ========================================================================== */

/** 一个字符占几个"字宽"：CJK/全角按 1，其余（ASCII、半角）按 0.5 —— 否则一行英文会把行撑爆 */
export function charWidth(ch: string): number {
  return /[\u2E80-\u9FFF\uFF00-\uFF60\u3000-\u303F]/.test(ch) ? 1 : 0.5;
}

/** 整串的显示宽度（字宽） */
export function widthOfText(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** 是否属于 ASCII 单词/数字的一部分（切句时不能从中间下刀） */
function isAsciiWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9'’]/.test(ch);
}

/** 秒 → ASS 时间戳 `H:MM:SS.cc`（厘秒，1 位小时，不补零） */
export function toAssTime(sec: number): string {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  // 四舍五入到 100 厘秒时进位，否则会写出 `:100`
  const carry = cs === 100 ? 1 : 0;
  const sFinal = s + carry;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  if (sFinal >= 60) return `${h}:${p2(m + 1)}:00.${p2(0)}`;
  return `${h}:${p2(m)}:${p2(sFinal)}.${p2(cs === 100 ? 0 : cs)}`;
}

/**
 * 中文友好的折行。
 *
 * 中日韩字符按 1 个字宽算，ASCII 按 0.5 算 —— 否则一行英文会把行撑爆。
 * 最多两行；超出部分丢弃并在末尾加省略号（宁可少字，不要字号缩到看不见）。
 *
 * ⚠️ **优先在标点处断行**（实测教训）：按字数硬折会把词劈开，
 * 例如「…掉下去了你你们你 / 们你们游戏画面的」——"你们"被切成"你/们"，
 * 用户的原话就是「字幕也没有断句」。ASR 的文本里本来就有「，。？！、；：」，
 * 断在这些符号后面既符合语义、观感也自然。
 */
export function wrapCjk(text: string, maxUnitsPerLine: number, maxLines = 2): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const widthOf = charWidth;
  const totalWidth = widthOfText(clean);
  // 一行装得下就直接返回，不折腾
  if (totalWidth <= maxUnitsPerLine || maxLines <= 1) return [clean];

  /** 在 [1, max] 字宽内找**最后一个标点位置**作为断点；找不到返回 undefined */
  const breakAt = (s: string, max: number): number | undefined => {
    let w = 0;
    let lastPunct = -1;
    let lastSpace = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      w += widthOf(ch);
      if (/[，。！？、；：,.!?;:]/.test(ch)) lastPunct = i + 1; // 标点留在上一行
      else if (ch === ' ') lastSpace = i;
      if (w > max) break;
    }
    // 标点不能太靠前（否则第一行太短、看着别扭）：至少占满 55% 宽度
    if (lastPunct > 0 && widthOfText(s.slice(0, lastPunct)) >= max * 0.55) return lastPunct;
    if (lastSpace > 0 && widthOfText(s.slice(0, lastSpace)) >= max * 0.55) return lastSpace;
    return undefined;
  };

  const lines: string[] = [];
  let rest = clean;
  while (rest && lines.length < maxLines) {
    const isLast = lines.length === maxLines - 1;
    if (isLast) {
      // 末行也要守宽度：放不下就截断加省略号（宁可少字，也不要字号缩到看不见）。
      // 不截断的话第二行会明显超宽 —— 实测教训：旧版漏了这一步，长句末行直接顶出画面。
      let w = 0;
      let cut = 0;
      for (let i = 0; i < rest.length; i++) {
        w += widthOf(rest[i]!);
        if (w > maxUnitsPerLine) break;
        cut = i + 1;
      }
      lines.push(cut >= rest.length ? rest : `${rest.slice(0, Math.max(1, cut - 1))}…`);
      rest = '';
      break;
    }
    const rw = [...rest].reduce((a, c) => a + widthOf(c), 0);
    if (rw <= maxUnitsPerLine) {
      lines.push(rest);
      rest = '';
      break;
    }
    // 先按标点/空格断；没有合适的位置再按字数硬折
    const at = breakAt(rest, maxUnitsPerLine);
    if (at !== undefined) {
      lines.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
      continue;
    }
    let w = 0;
    let cut = 0;
    for (let i = 0; i < rest.length; i++) {
      w += widthOf(rest[i]!);
      if (w > maxUnitsPerLine) break;
      cut = i + 1;
    }
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  // 还有没放下的内容 → 末行加省略号（上面的末行分支已经处理，这里是兜底）
  if (rest && lines.length === maxLines) {
    const last = lines[maxLines - 1]!;
    lines[maxLines - 1] = `${last.slice(0, Math.max(1, last.length - 1))}…`;
  }
  return lines;
}

/** ASS 文本转义：`{}` 会被当成特效块，`\N` 是换行符 */
export function escapeAssText(s: string): string {
  return s.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, ' ');
}

/* ============================================================================
 * 字幕事件生成
 * ========================================================================== */

export interface SubtitleRenderOptions {
  /** 字号，0/缺省 → 按分辨率推算 */
  fontSize?: number;
  /** 距画面底部的边距（像素），缺省 → 按分辨率推算 */
  marginV?: number;
  /** 每行最大字宽（中日韩字符按 1 算） */
  maxCharsPerLine?: number;
  /** 单条字幕最短/最长显示时长（秒） */
  minDurationSec?: number;
  maxDurationSec?: number;
  /**
   * 阅读速度（字/秒），用于按字数估算字幕该显示多久。
   *
   * 中文直播语速实测约 3–6 字/秒，取 4 略微偏快一点，
   * 让字幕**跟着说话走**而不是赖在屏幕上（实测踩过：9 个字挂 8 秒 → 用户报"和声音对不上"）。
   */
  readingCharsPerSec?: number;
  /** 超过多少个字就按标点切成多条字幕（避免一整块文字糊在屏幕上） */
  splitAtChars?: number;
  /** 字体 */
  fontName?: string;
  /** 画面分辨率（用于推算字号与边距） */
  resolution?: { width: number; height: number };
}

interface ResolvedOptions {
  fontSize: number;
  marginV: number;
  maxCharsPerLine: number;
  minDurationSec: number;
  maxDurationSec: number;
  readingCharsPerSec: number;
  splitAtChars: number;
  fontName: string;
  width: number;
  height: number;
}

const DEFAULT_RESOLUTION = { width: 1920, height: 1080 };

function resolveOptions(o: SubtitleRenderOptions = {}): ResolvedOptions {
  const width = o.resolution?.width && o.resolution.width > 0 ? o.resolution.width : DEFAULT_RESOLUTION.width;
  const height = o.resolution?.height && o.resolution.height > 0 ? o.resolution.height : DEFAULT_RESOLUTION.height;
  return {
    // 弹幕字号默认 height/27（≈1080p 下 40px）；字幕要比它大一号才读得清
    fontSize: o.fontSize && o.fontSize > 0 ? o.fontSize : Math.round(height / 22),
    marginV: o.marginV && o.marginV > 0 ? o.marginV : Math.round(height * 0.035),
    maxCharsPerLine: o.maxCharsPerLine && o.maxCharsPerLine > 0 ? o.maxCharsPerLine : 18,
    minDurationSec: o.minDurationSec && o.minDurationSec > 0 ? o.minDurationSec : 0.8,
    maxDurationSec: o.maxDurationSec && o.maxDurationSec > 0 ? o.maxDurationSec : 8,
    readingCharsPerSec: o.readingCharsPerSec && o.readingCharsPerSec > 0 ? o.readingCharsPerSec : 4,
    // 等于"一行装得下的字数"：切出来的句子必定一行放得下，于是**不需要折行**，
    // 也就不会出现"按字数硬折把词劈开"。超过这个长度只可能是无标点的连珠炮，
    // 由 splitIntoSentences 的均分兜底处理。
    splitAtChars: o.splitAtChars && o.splitAtChars > 0 ? o.splitAtChars : (o.maxCharsPerLine && o.maxCharsPerLine > 0 ? o.maxCharsPerLine : 18),
    fontName: o.fontName?.trim() || 'Microsoft YaHei',
    width,
    height,
  };
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/** 字幕断句用的标点（中英文都要，ASR 两种都会给） */
const SENTENCE_PUNCT = /[，。！？、；：,.!?;:]/;

/**
 * 把一段过长的文本按**显示宽度**均分（没有标点可用时的最后手段）。
 *
 * 两条实测教训决定了它的写法：
 *  1. 按"第 N 个字符"硬切会把英文单词劈开 —— `…就是个enter的…` 切成 `…就是个ente` + `r的…`；
 *  2. 按"每块塞满"切会让最后一块明显短一截；均分（29 字 → 15+14）读起来更稳。
 *
 * 于是：先按总宽算块数，再在**安全切点**（不落在 ASCII 单词/数字内部）里挑最接近均分位置的那个；
 * 某块因此可能超宽时退回按宽度硬切，保证任何一块都能一行放下（不折行 = 不劈词）。
 */
function balancedSplit(s: string, maxWidth: number): string[] {
  const chars = [...s];
  /** prefix[i] = chars[0..i) 的显示宽度 */
  const prefix: number[] = [0];
  for (const c of chars) prefix.push(prefix[prefix.length - 1]! + charWidth(c));
  const total = prefix[chars.length]!;
  const n = Math.max(2, Math.ceil(total / maxWidth));
  const target = total / n;
  const safeCuts: number[] = [];
  for (let i = 1; i < chars.length; i++) {
    if (isAsciiWordChar(chars[i - 1]) && isAsciiWordChar(chars[i])) continue;
    safeCuts.push(i);
  }
  const out: string[] = [];
  let start = 0;
  for (let k = 1; k < n; k++) {
    const want = target * k;
    let best = -1;
    let bestScore = Infinity;
    for (const c of safeCuts) {
      if (c <= start) continue;
      const w = prefix[c]! - prefix[start]!;
      if (w > maxWidth) break; // safeCuts 递增，再往后只会更宽
      const score = Math.abs(prefix[c]! - want);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best < 0) {
      // 一个安全切点都没有（整块都是英文单词）：只能按宽度硬切
      let w = 0;
      let cut = start;
      while (cut < chars.length && w + charWidth(chars[cut]!) <= maxWidth) {
        w += charWidth(chars[cut]!);
        cut++;
      }
      best = cut > start ? cut : Math.min(start + 1, chars.length);
    }
    out.push(chars.slice(start, best).join(''));
    start = best;
  }
  if (start < chars.length) {
    const restStr = chars.slice(start).join('');
    out.push(...(widthOfText(restStr) > maxWidth ? balancedSplit(restStr, maxWidth) : [restStr]));
  }
  return out.filter((x) => x.length > 0);
}

/**
 * 按标点把一个 ASR 段落切成若干**句子**（标点保留在句尾）。
 *
 * 为什么要切：一个 ASR 段落经常包含好几句话（实测 33% 的段落 10–36 字）。
 * 整段作为一条字幕显示，观众看到的就是"一大块文字"，用户的原话是「字幕也没有断句」。
 * 切成逐句显示，才能有"跟着说话一句句出现"的节奏。
 *
 * 贪心合并：相邻句子合起来仍不超过 maxChars 就合并 —— 避免切得过碎
 * （"嗯。""对。"这种一两个字的碎片单独成条反而更难看）。
 */
export function splitIntoSentences(text: string, maxChars: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts: string[] = [];
  let buf = '';
  for (const ch of clean) {
    buf += ch;
    if (SENTENCE_PUNCT.test(ch)) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) parts.push(buf);

  // 没有标点可断的长句，按显示宽度**均分**兜底。
  // 直播里这种情况不少（口播连珠炮：「你你你你是直播间你是直播间的那个推流设置…」29 字无标点），
  // 不兜底的话它只能作为一条字幕折成两行，而按字数硬折必然把词劈开 —— 用户看到的就是「没有断句」。
  // 均分而不是"每块塞满 maxChars"：29 字切成 18+11 会让第二条明显短一截，15+14 读起来更稳。
  const sized: string[] = [];
  for (const p of parts) {
    if (widthOfText(p) <= maxChars) sized.push(p);
    else sized.push(...balancedSplit(p, maxChars));
  }

  // 贪心合并相邻短句
  const merged: string[] = [];
  for (const p of sized) {
    const last = merged[merged.length - 1];
    if (last && [...last, ...p].length <= maxChars) merged[merged.length - 1] = last + p;
    else merged.push(p);
  }
  return merged;
}

/**
 * 把转写段整理成适合显示的字幕条目。
 *
 * ## 时长怎么定（这里踩过一个明显的坑）
 *
 * 第一版用的是 `min(ASR结束, 起点 + 8秒)`，结果**9 个字也硬挂 8 秒** ——
 * 因为 ASR 会把「说一句话 + 之后长时间静音」算成一段（实测有个 6 字的段落标了 33.1 秒）。
 * 字幕挂在屏幕上一动不动，声音早说到下一句了，用户的原话就是「字幕和声音对不上」。
 * 实测数据：123 条顶到 8 秒上限、1038 条显示时长超过按字数所需、217 条异常段落**多占 988 秒**。
 *
 * 现在的规则（按"读字幕需要的时长"来定，而不是按 ASR 的段落边界）：
 *
 * ```
 * 目标时长 = max(最短显示时长, 字数 ÷ 阅读速度)      // 中文直播约 4 字/秒
 * 实际时长 = min(目标时长, ASR 段落剩余时间)          // 不能凭空超出实际说话区间
 * ```
 *
 * 于是：9 字 → 2.25 秒（而不是 8 秒）；说完了字幕就消失，剩下的静音**不显示字幕** ——
 * 这正是观众期望的行为。按标点切成的多条句子，时间**按字数比例**分配（语速大体均匀）。
 *
 * 另外三件事也照旧做，每条都对应一类真实的观感问题：
 *  - 丢掉噪声行（音乐/掌声被识别成的乱码），它们出现在画面上非常出戏；
 *  - 补最短显示时长：ASR 常给出 0.2 秒的碎片，人眼根本来不及看；
 *  - 消除重叠：相邻两条首尾相接时前一条压到后一条之前，否则 ASS 会两条同时出现。
 */
export function buildCues(
  segments: TranscriptSegment[],
  o: SubtitleRenderOptions = {},
  isNoise?: (text: string) => boolean,
  /**
   * 「能量锚点」：当某个转写段的窗口明显长于文本所需朗读时间时（云 ASR 会给出这种离谱窗口），
   * 用它把这段字幕挪到**窗口内真正有人说话**的位置。
   *
   * 只传一个**取点函数**而不是整个剖面 —— 这样单测不需要音频文件，也把"要不要动"的判断留在本函数里。
   */
  anchor?: AnchorPicker,
): { cues: SubtitleCue[]; droppedNoise: number; clamped: number; anchored: number } {
  const opt = resolveOptions(o);
  const usable = segments
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .filter((s) => s.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);

  let droppedNoise = 0;
  const kept: TranscriptSegment[] = [];
  for (const s of usable) {
    if (isNoise?.(s.text)) {
      droppedNoise++;
      continue;
    }
    kept.push(s);
  }

  let clamped = 0;
  let anchored = 0;
  const cues: SubtitleCue[] = [];
  // ASS 的最小时间单位是厘秒，先归整：既让输出与实际显示一致，
  // 也避免 "6.8 - 6 = 0.7999…" 这类浮点误差把最短时长判断弄歪。
  const round2 = (n: number): number => Math.round(n * 100) / 100;

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i]!;
    const next = kept[i + 1];
    const segStart = round2(s.start);
    const segEnd = round2(s.end);
    const segDur = segEnd - segStart;

    // 一个段落切成若干句；按字数比例分配这个段落的时间
    const sentences = splitIntoSentences(s.text, opt.splitAtChars);
    const totalChars = sentences.reduce((a, x) => a + [...x].length, 0) || 1;
    /* 「文本需要多久朗读」的估算：每条至少 minDurationSec，其余按 readingCharsPerSec。
       它同时是"这个窗口是不是离谱"的判据，以及重新锚定时要占多长。 */
    const needTotal = sentences.reduce((a, x) => a + Math.max(opt.minDurationSec, [...x].length / opt.readingCharsPerSec), 0);
    let cursor = segStart;
    /* 窗口离谱（远长于朗读所需）时，把整段挪到窗口内能量最高的位置 ——
       实测案例：「如。萌啊！你都怎么突然追上来了」（15 字）拿到 0→30.9s 的窗口，
       而真正的说话声在 29–33s；贴窗口起点铺的结果就是"字幕对不上"。 */
    if (anchor && needsAnchor(segDur, needTotal, opt.maxDurationSec)) {
      const picked = anchor.pick(segStart, segEnd, Math.min(needTotal, segDur));
      if (picked !== undefined && picked > segStart + 0.05) {
        cursor = round2(Math.min(picked, segEnd - 0.05));
        anchored++;
      }
    }
    let idx = 0;

    for (const sentence of sentences) {
      const chars = [...sentence].length;
      // 该句按字数分到的时间
      const share = (segDur * chars) / totalChars;
      const need = Math.max(opt.minDurationSec, chars / opt.readingCharsPerSec);
      const isLast = idx === sentences.length - 1;
      // 最后一句可以吃掉段落剩余时间（同一段内的连续语音，不必留空）
      const budget = isLast ? Math.max(share, segEnd - cursor) : share;
      const dur = Math.min(need, budget, opt.maxDurationSec);
      let end = round2(Math.min(cursor + dur, segEnd, cursor + opt.maxDurationSec));
      /* 补最短显示时长：**允许越过 ASR 段落边界**。
         实测教训：ASR 常给出 0.1–0.3 秒的碎片（「嗯」单独成段），
         如果被段落边界夹住，最短时长就永远补不上，观众只看到一闪。
         越过一点点的代价（最多 0.8 秒）远小于看不清，且绝不越过下一段。 */
      if (end - cursor < opt.minDurationSec) {
        end = round2(
          Math.min(cursor + opt.minDurationSec, cursor + opt.maxDurationSec, next ? next.start : Number.POSITIVE_INFINITY),
        );
        clamped++;
      }
      // 与下一条转写段落重叠时让位（否则两条字幕会同时显示）
      if (next && end > next.start) {
        end = round2(Math.max(cursor + 0.2, next.start));
        clamped++;
      }
      if (end <= cursor) {
        // 时间被压没了（段落间挤得太紧）→ 跳过这一句，不要产出零长字幕
        clamped++;
        idx++;
        continue;
      }
      const text = wrapCjk(sentence, opt.maxCharsPerLine).join('\\N');
      if (text) cues.push({ start: cursor, end, text });
      cursor = end;
      idx++;
      if (cursor >= segEnd) break;
    }
  }
  return { cues, droppedNoise, clamped, anchored };
}

/* ============================================================================
 * ASS 解析与合并
 * ========================================================================== */

interface AssLayout {
  /** `[V4+ Styles]` 的 Format 字段顺序 */
  styleFormat: string[];
  /** `[Events]` 的 Format 字段顺序 */
  eventFormat: string[];
  width: number;
  height: number;
  /** 样式段的行（不含 Format 行），用于挑选参考样式 */
  styleLines: string[];
  /** 事件段已有内容 */
  eventLines: string[];
  /** `[V4+ Styles]` 段头（含 Format 行） */
  stylesHeader: string[];
  /** `[Events]` 段头（含 Format 行） */
  eventsHeader: string[];
  /** 除样式与事件以外的段落（原样保留） */
  otherSections: string[];
}

const DEFAULT_STYLE_FORMAT = [
  'Name',
  'Fontname',
  'Fontsize',
  'PrimaryColour',
  'SecondaryColour',
  'OutlineColour',
  'BackColour',
  'Bold',
  'Italic',
  'Underline',
  'StrikeOut',
  'ScaleX',
  'ScaleY',
  'Spacing',
  'Angle',
  'BorderStyle',
  'Outline',
  'Shadow',
  'Alignment',
  'MarginL',
  'MarginR',
  'MarginV',
  'Encoding',
];

const DEFAULT_EVENT_FORMAT = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];

/** 解析一份 ASS 的结构（字段顺序 + 分辨率 + 现有样式/事件） */
export function parseAssLayout(text: string): AssLayout | undefined {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n');
  const layout: AssLayout = {
    styleFormat: [],
    eventFormat: [],
    width: 0,
    height: 0,
    styleLines: [],
    eventLines: [],
    stylesHeader: [],
    eventsHeader: [],
    otherSections: [],
  };
  let section = '';
  for (const raw of lines) {
    const line = raw.trimEnd();
    const header = /^\[(.+?)\]\s*$/.exec(line.trim());
    if (header) {
      section = header[1]!.toLowerCase();
      if (section.startsWith('v4+ styles') || section.startsWith('v4 styles')) layout.stylesHeader.push(line);
      else if (section === 'events') layout.eventsHeader.push(line);
      else layout.otherSections.push(line);
      continue;
    }
    if (section.startsWith('v4+ styles') || section.startsWith('v4 styles')) {
      if (/^Format\s*:/i.test(line)) {
        layout.styleFormat = line.replace(/^Format\s*:/i, '').split(',').map((x) => x.trim());
        layout.stylesHeader = layout.stylesHeader.filter((l) => !/^Format\s*:/i.test(l));
        layout.stylesHeader.push(line);
      } else if (/^Style\s*:/i.test(line)) {
        layout.styleLines.push(line);
      } else if (line.trim()) {
        layout.stylesHeader.push(line);
      }
    } else if (section === 'events') {
      if (/^Format\s*:/i.test(line)) {
        layout.eventFormat = line.replace(/^Format\s*:/i, '').split(',').map((x) => x.trim());
        layout.eventsHeader = layout.eventsHeader.filter((l) => !/^Format\s*:/i.test(l));
        layout.eventsHeader.push(line);
      } else if (/^(Dialogue|Comment)\s*:/i.test(line)) {
        layout.eventLines.push(line);
      } else if (line.trim()) {
        layout.eventsHeader.push(line);
      }
    } else {
      // ★ 其余段落（[Script Info] / [Aegisub Project Garbage] 等）必须**整段原样保留**：
      //   这里踩过一次坑 —— 只把段头推进 otherSections、内容行只解析 PlayRes，
      //   结果合并后 ScriptType / WrapStyle / ScaledBorderAndShadow 全丢了，
      //   播放器按默认 384×288 渲染，字幕大得离谱。凡是"看起来无关"的行都要留住。
      //
      //   只在**已经进入某个段落**之后才收集：段落头之前的空行属于噪声，
      //   收进去会让「有没有 Script Info」的判断失真（空输入会变成"有内容"）。
      if (section) layout.otherSections.push(line);
      const rx = /^PlayResX\s*:\s*(\d+)/i.exec(line.trim());
      const ry = /^PlayResY\s*:\s*(\d+)/i.exec(line.trim());
      if (rx) layout.width = Number(rx[1]);
      if (ry) layout.height = Number(ry[1]);
    }
  }
  return layout;
}

/** 取一条现有样式作为「参考」（拿字体的抗锯齿/编码等无关字段的合理缺省） */
function pickReferenceStyle(layout: AssLayout | undefined): Record<string, string> {
  if (!layout) return {};
  const fmt = layout.styleFormat.length ? layout.styleFormat : DEFAULT_STYLE_FORMAT;
  const fields = layout.styleLines[0]?.replace(/^Style\s*:/i, '').split(',') ?? [];
  const out: Record<string, string> = {};
  fmt.forEach((name, i) => {
    if (fields[i] !== undefined) out[name] = fields[i]!.trim();
  });
  return out;
}

/**
 * 构造字幕样式行。
 *
 * 关键差异（不是随便调色）：
 *  - `Alignment=2`：底部居中（弹幕的 Bottom 样式也是 2，但字幕要更大的 MarginV 躲开它）；
 *  - `BorderStyle=1` + `Outline=3`：实描边。烧在花哨的直播画面上，没有描边的白字基本读不出来；
 *  - `Shadow=1`：轻微投影，进一步拉开与背景的层次；
 *  - `MarginV` 比弹幕底部样式更大：弹幕底部评论也占着最下面，两者叠在一起会互相污染。
 */
function buildSubtitleStyleLine(layout: AssLayout | undefined, opt: ResolvedOptions): string {
  const fmt = layout?.styleFormat.length ? layout.styleFormat : DEFAULT_STYLE_FORMAT;
  const ref = pickReferenceStyle(layout);
  const values: Record<string, string> = {
    ...ref,
    Name: 'Subtitle',
    Fontname: opt.fontName,
    Fontsize: String(opt.fontSize),
    PrimaryColour: '&H00FFFFFF', // 白字
    SecondaryColour: '&H00FFFFFF',
    OutlineColour: '&H00000000', // 黑描边
    BackColour: '&H80000000',
    Bold: '-1',
    Italic: '0',
    Underline: '0',
    StrikeOut: '0',
    ScaleX: '100',
    ScaleY: '100',
    Spacing: '0',
    Angle: '0',
    BorderStyle: '1',
    Outline: '3',
    Shadow: '1',
    Alignment: '2',
    MarginL: '40',
    MarginR: '40',
    MarginV: String(opt.marginV + Math.round(opt.fontSize * 1.6)), // 躲开底部弹幕
    Encoding: ref['Encoding'] ?? '1',
  };
  return `Style: ${fmt.map((name) => values[name] ?? '0').join(',')}`;
}

/** 构造字幕事件行（按既有 Events 的 Format 顺序） */
function buildSubtitleEventLines(layout: AssLayout | undefined, cues: SubtitleCue[]): string[] {
  const fmt = layout?.eventFormat.length ? layout.eventFormat : DEFAULT_EVENT_FORMAT;
  return cues.map((c) => {
    const values: Record<string, string> = {
      Layer: '1', // 弹幕在 Layer 0；字幕放上层，避免被弹幕压住
      Start: toAssTime(c.start),
      End: toAssTime(c.end),
      Style: 'Subtitle',
      Name: '',
      MarginL: '0',
      MarginR: '0',
      MarginV: '0',
      Effect: '',
      Text: c.text,
    };
    return `Dialogue: ${fmt.map((name) => values[name] ?? '').join(',')}`;
  });
}

/** 把字幕合并进一份已有的 ASS（通常是弹幕 ASS）：继承它的分辨率与样式表 */
export function mergeSubtitleIntoAss(danmakuAssText: string, cues: SubtitleCue[], render: SubtitleRenderOptions = {}): string {
  const layout = parseAssLayout(danmakuAssText);
  const opt = resolveOptions({
    ...render,
    resolution: render.resolution ?? (layout && layout.width && layout.height ? { width: layout.width, height: layout.height } : undefined),
  });
  const head = layout && layout.otherSections.length
    ? [...layout.otherSections]
    : ['[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes'];
  // 分辨率必须以 layout 解析结果为准补写：原文件里若没有 PlayRes，播放器会用 384×288
  if (!head.some((l) => /^PlayResX\s*:/i.test(l.trim()))) head.push(`PlayResX: ${opt.width}`);
  if (!head.some((l) => /^PlayResY\s*:/i.test(l.trim()))) head.push(`PlayResY: ${opt.height}`);
  const stylesHeader = layout?.stylesHeader.length
    ? layout.stylesHeader
    : [
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      ];
  const eventsHeader = layout?.eventsHeader.length
    ? layout.eventsHeader
    : ['[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const styleLines = [...(layout?.styleLines ?? []), buildSubtitleStyleLine(layout, opt)];
  const eventLines = [...(layout?.eventLines ?? []), ...buildSubtitleEventLines(layout, cues)];
  return [...head, '', ...stylesHeader, ...styleLines, '', ...eventsHeader, ...eventLines, ''].join('\n');
}

/** 没有弹幕 ASS 时：独立生成一份只带字幕的 ASS */
export function buildSubtitleOnlyAss(cues: SubtitleCue[], render: SubtitleRenderOptions = {}): string {
  const opt = resolveOptions(render);
  return mergeSubtitleIntoAss('', cues, { ...render, resolution: { width: opt.width, height: opt.height } });
}

/* ============================================================================
 * 分辨率探测
 * ========================================================================== */

/** 用 ffprobe 读视频分辨率；失败返回 undefined（调用方退化为 1920×1080） */
export function probeResolution(videoPath: string, ffprobePath?: string): { width: number; height: number } | undefined {
  const bin = findFfprobe(ffprobePath);
  if (!bin) return undefined;
  try {
    const json = execFileSync(
      bin,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', videoPath],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed = JSON.parse(json) as { streams?: Array<{ width?: number; height?: number }> };
    const s = parsed.streams?.[0];
    if (s?.width && s.height) return { width: s.width, height: s.height };
  } catch {
    /* 探测失败不是错误：字幕照样能烧，只是分辨率用默认值 */
  }
  return undefined;
}

/* ============================================================================
 * 对外主入口
 * ========================================================================== */

/**
 * 给 `buildCues` 用的取点函数：在 `[from, to]` 里挑一个"这段时间有人在说话"的起点。
 * 抽成接口是为了让单测不必碰音频文件（传一个假的即可）。
 */
export interface AnchorPicker {
  pick(from: number, to: number, needSec: number): number | undefined;
}

/**
 * 能量剖面的缓存现在在 `speech-energy.ts`（切片边界也要用同一份剖面，不能各缓存一份）。
 * 这里只保留"把剖面包装成取点函数"的薄封装。
 */
function energyProfileFor(videoPath: string | undefined, log: Logger): EnergyProfile | undefined {
  return energyProfileCached(videoPath, { debug: (msg) => log.debug(msg, { mod: 'subtitle' }) });
}

/** 把能量剖面包装成 `buildCues` 要的取点函数 */
function energyAnchorFor(videoPath: string | undefined, log: Logger): AnchorPicker | undefined {
  const profile = energyProfileFor(videoPath, log);
  if (!profile) return undefined;
  return {
    pick: (from, to, needSec) => bestAnchor(profile, from, to, needSec),
  };
}

export interface BuildBurnAssOptions {  /** 任务目录（合并结果写在这里） */
  outDir: string;
  /** 弹幕 ASS（可为空：此时只烧字幕） */
  danmakuAssPath?: string;
  /** 转写段（整场时间轴） */
  segments: TranscriptSegment[];
  /** 视频路径，仅在需要探测分辨率时使用 */
  videoPath?: string;
  ffprobePath?: string;
  render?: SubtitleRenderOptions;
  /**
   * 噪声判定（默认用 `asr.ts` 的 `looksLikeNoise`）。
   *
   * 默认开启是刻意的：ASR 会把音乐、掌声、纯笑声识别成 "♪♪" 或单字乱码，
   * 这些字烧在画面上非常出戏，宁可少一行也不要有。
   * 传 `false` 可完全关闭过滤。
   */
  isNoise?: ((text: string) => boolean) | false;
  logger?: Logger;
  /** 强制重建（忽略同参数的已有产物） */
  force?: boolean;
  /**
   * 是否启用「能量锚点」（默认启用）。关掉它 = 回到"贴着 ASR 窗口起点铺字幕"的旧行为。
   * 它只在**窗口明显不合理**的段落上生效，正常段落一律不动。
   */
  energyAnchor?: boolean;
  /** ffmpeg 路径（默认用 PATH 里的 ffmpeg） */
  ffmpegPath?: string;
}

export interface BuildBurnAssResult {
  /** 交给切片接口的 ASS 路径（弹幕+字幕合并；无字幕需求时等于弹幕 ASS） */
  assPath?: string;
  /** 实际写入的字幕条数 */
  subtitleCount: number;
  /** 是否与弹幕合并 */
  merged: boolean;
  droppedNoise: number;
  warnings: string[];
}

/**
 * 生成「弹幕 + 字幕」合并 ASS。
 *
 * 产物文件名带内容指纹（弹幕 ASS 的 mtime + 字幕条数 + 关键渲染参数），
 * 因此同一场重复切片会复用同一个文件；换一场或改了转写自然会生成新文件，
 * 不需要额外的失效逻辑 —— 没有缓存失效逻辑就没有缓存不失效的 bug。
 */
export function buildBurnAss(opts: BuildBurnAssOptions): BuildBurnAssResult {
  const log = opts.logger ?? globalLog;
  const warnings: string[] = [];
  const danmakuPath = opts.danmakuAssPath && exists(opts.danmakuAssPath) ? opts.danmakuAssPath : undefined;

  if (opts.segments.length === 0) {
    return { ...(danmakuPath ? { assPath: danmakuPath } : {}), subtitleCount: 0, merged: false, droppedNoise: 0, warnings: ['没有转写内容，本片只烧弹幕（不烧字幕）'] };
  }

  let danmakuText = '';
  let danmakuStat = 'none';
  if (danmakuPath) {
    try {
      danmakuText = fs.readFileSync(danmakuPath, 'utf8');
      danmakuStat = String(fs.statSync(danmakuPath).mtimeMs);
    } catch (e) {
      warnings.push(`读取弹幕 ASS 失败（将只烧字幕）：${(e as Error).message}`);
      danmakuText = '';
    }
  }

  /* ---- 能量锚点：给"窗口明显不合理"的段落找真正有人说话的位置（见 speech-energy.ts） ---- */
  const anchorPicker = opts.energyAnchor === false ? undefined : energyAnchorFor(opts.videoPath, log);

  const { cues, droppedNoise, clamped, anchored } = buildCues(
    opts.segments,
    opts.render,
    opts.isNoise === false ? undefined : (opts.isNoise ?? looksLikeNoise),
    anchorPicker,
  );
  if (anchored > 0) {
    warnings.push(`${anchored} 条转写的时间窗口明显不合理，已按音频能量重新定位（云 ASR 会给出"15 个字占 31 秒"这类窗口）`);
  }
  if (cues.length === 0) {
    return { ...(danmakuPath ? { assPath: danmakuPath } : {}), subtitleCount: 0, merged: false, droppedNoise, warnings };
  }
  if (clamped > 0) warnings.push(`${clamped} 条字幕的显示时长被调整（过短/与下一条重叠）`);
  if (droppedNoise > 0) warnings.push(`已跳过 ${droppedNoise} 条疑似噪声的字幕行`);

  // 分辨率：优先继承弹幕 ASS，其次 ffprobe，最后 1920×1080
  const layout = danmakuText ? parseAssLayout(danmakuText) : undefined;
  let resolution = layout?.width && layout.height ? { width: layout.width, height: layout.height } : undefined;
  if (!resolution && opts.videoPath) resolution = probeResolution(opts.videoPath, opts.ffprobePath);
  const render: SubtitleRenderOptions = { ...opts.render, ...(resolution ? { resolution } : {}) };

  const text = danmakuText
    ? mergeSubtitleIntoAss(danmakuText, cues, render)
    : buildSubtitleOnlyAss(cues, render);

  ensureDir(opts.outDir);
  // ⚠️ 指纹里必须带**算法版本**：产物文件名是按内容指纹缓存的，
  //    如果只把「弹幕 mtime + 字幕条数 + 分辨率 + 参数」算进去，
  //    改了字幕生成逻辑（断句、时长规则）而条数碰巧相同，就会**复用旧 ASS**，
  //    表现是"改了代码但成片没变化"，极难排查。改过一次就 bump 一次。
  const ASS_ALGO_VERSION = 'sub-v4-energy-anchor';
  const fingerprint = hashKey([
    ASS_ALGO_VERSION,
    danmakuStat,
    String(cues.length),
    String(resolution?.width ?? 0),
    String(resolution?.height ?? 0),
    String(render.fontSize ?? 0),
    String(render.maxCharsPerLine ?? 0),
    String(render.readingCharsPerSec ?? 0),
  ]).slice(0, 10);
  const outPath = path.join(opts.outDir, danmakuPath ? `burn-${fingerprint}.ass` : `subtitle-${fingerprint}.ass`);

  if (!opts.force && exists(outPath)) {
    return { assPath: outPath, subtitleCount: cues.length, merged: Boolean(danmakuPath), droppedNoise, warnings };
  }

  try {
    // Node 写文本默认不带 BOM；stripBom 只是最后一道保险（BOM 会让切片接口 500）
    fs.writeFileSync(outPath, text, 'utf8');
  } catch (e) {
    warnings.push(`字幕 ASS 写盘失败：${(e as Error).message}`);
    return { ...(danmakuPath ? { assPath: danmakuPath } : {}), subtitleCount: 0, merged: false, droppedNoise, warnings };
  }
  // 兜底：某些写入路径可能仍带上 BOM（踩过三次的坑），统一再剥一次
  stripBom(outPath);

  log.info(
    `已生成「弹幕+字幕」合并 ASS：${path.basename(outPath)}（字幕 ${cues.length} 条${danmakuPath ? `，弹幕文件 ${path.basename(danmakuPath)}` : '，无弹幕'}）`,
    { mod: 'subtitle', data: { outPath, cues: cues.length, merged: Boolean(danmakuPath) } },
  );
  return { assPath: outPath, subtitleCount: cues.length, merged: Boolean(danmakuPath), droppedNoise, warnings };
}
