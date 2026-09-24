/**
 * WP4 —— LLM 决策器（任务书 §5.3 / §5.5 / §8 WP4）。
 *
 * 流程：分块 map（便宜档）→ reduce 全局总结（便宜档）→ 选片与起标题（选片专用档）
 *
 * 三条不可违背的处理原则：
 *  1. **契约校验必做**（zod），不信任模型自称的 JSON 合规性 —— 「格式合法 ≠ 内容正确」（§5.5）。
 *  2. **校验失败要升级模型重跑**，而不是在便宜模型上原地重试（§5.5、硬约束 #13）。
 *  3. **LLM 完全不可用时降级**为「弹幕密度 Top-N 窗口 + 占位标题」，
 *     且产出必须标记 `degraded: true`，UI 显式提示，避免在不知情的情况下发布低质量切片。
 *
 * 另外：LLM **不产出 `tid`** —— 它只给分区文字描述，由本模块映射白名单（陷阱 #20）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  ChunkDigest,
  ClipCandidate,
  ClipDecision,
  ClipRecord,
  ModelSlot,
  SelectionOutput,
  Signals,
  Transcript,
  TranscriptSegment,
} from './types.ts';
import type { AppConfig } from './config.ts';
import { renderGlossaryForPrompt, type Glossary } from './glossary.ts';
import { streamerPromptLine, type StreamerGuess } from './streamer.ts';
import { LlmClient, LlmError, chatJsonBatch } from './llm.ts';
import { densityFallbackClips, signalsToPromptText } from './danmaku.ts';
import { ROOT_DIR, fmtDuration, nowIso, safeFileName, writeJsonAtomic } from './util.ts';
import { SPEECH_DB, energyProfileCached, findSpeechOffset, findSpeechOnset, type EnergyProfile } from './speech-energy.ts';
import { log as globalLog, type Logger } from './logger.ts';

/* ============================================================================
 * 契约（zod schema）
 * ========================================================================== */

/**
 * 候选切片契约。
 *
 * 校验项（§5.5 要求「至少包含」）：
 *   title ≤ 80、desc ≤ 250、tags 去重后 1–10 个、start < end、
 *   起止在视频时长内、片段不重叠、category 能映射到白名单 tid。
 *
 * 注意：范围/重叠/时长属于**跨字段**约束，zod 的字段级 schema 无法单独表达，
 * 由 `sanitizeClips` 统一处理（丢弃越界与重叠项，并记录原因）。
 */
export const clipCandidateSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
  title: z.string().min(1).max(80),
  desc: z.string().max(250).default(''),
  tags: z.array(z.string().min(1).max(24)).min(1).max(10),
  category: z.string().min(1).max(40),
  score: z.number().min(0).max(10),
  reason: z.string().max(200).default(''),
  cover_ts: z.number().finite().nonnegative().optional(),
});

export const selectionSchema = z.object({
  summary: z.string().min(1),
  clips: z.array(clipCandidateSchema).min(1),
});

export const retitleSchema = z.object({
  titles: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        title: z.string().min(1).max(80),
        desc: z.string().max(250).default(''),
        tags: z.array(z.string().min(1).max(24)).min(1).max(10).default([]),
      }),
    )
    .min(1),
});

export const chunkDigestSchema = z.object({
  topics: z.array(z.string().min(1).max(60)).max(8).default([]),
  highlights: z
    .array(
      z.object({
        time: z.number().finite(),
        what: z.string().min(1).max(120),
        why: z.string().max(120).default(''),
      }),
    )
    .max(10)
    .default([]),
});

export const chunkOutputSchema = z.object({
  topics: z.array(z.string().min(1).max(60)).max(8).default([]),
  highlights: z
    .array(
      z.object({
        time: z.number().finite(),
        what: z.string().min(1).max(120),
        why: z.string().max(120).default(''),
      }),
    )
    .max(10)
    .default([]),
});

/* ============================================================================
 * prompt 加载
 * ========================================================================== */

/**
 * prompt 文件加载器。
 *
 * ⚠️ §5.4 的省钱前提：**各请求的 system prompt 必须字节级一致**，
 * 分块内容只能放 user 消息里。因此 chunk.md 的内容会被原样当作 system 使用 ——
 * **绝不允许**在 system 里插入任何变量（时间、任务 id、片段内容都不行），
 * 否则 DeepSeek 的 prompt 缓存不命中，输入价从 0.2 元/百万回到 2 元/百万。
 */
export class PromptStore {
  private dir: string;
  /** 缓存：name → { 原文, 读取时的 mtimeMs } */
  private cache = new Map<string, { text: string; mtimeMs: number }>();

  constructor(dir = path.join(ROOT_DIR, 'prompts')) {
    this.dir = dir;
  }

  /**
   * 读取 prompt 原文（带 **mtime 失效** 的缓存）。
   *
   * ⚠️ 缓存必须校验 mtime，不能用"取过一次就永远返回缓存"：
   *   本项目的 prompt 迭代方式就是**直接改 `prompts/*.md`**（界面上的 Prompt 页只是只读展示），
   *   而 `Analyzer` 在 `Orchestrator` 构造时只创建一次、`PromptStore` 也随之长驻。
   *   旧实现 `if (hit) return hit` 会让改动**直到服务重启才生效** ——
   *   实测我自己改完 select.md 后跑验证，用的仍是旧提示词，白跑一轮付费调用。
   *   校验 mtime 之后才是真正的"改完下次分析即生效"。
   */
  get(name: 'chunk' | 'summary' | 'select' | 'retitle'): string {
    const file = path.join(this.dir, `${name}.md`);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      // 文件读不到（被删/权限）→ 尝试用缓存兜底；没有缓存则抛出，由调用方处理
      const hit = this.cache.get(name);
      if (hit) return hit.text;
      throw new Error(`prompt 文件不存在或不可读：${file}`);
    }
    const hit = this.cache.get(name);
    if (hit && hit.mtimeMs === mtimeMs) return hit.text;
    const text = fs.readFileSync(file, 'utf8').trim();
    this.cache.set(name, { text, mtimeMs });
    return text;
  }

  /** 清空缓存（配置热加载 / 手动重载时调用；正常路径不需要，get 会自己校验 mtime） */
  clearCache(): void {
    this.cache.clear();
  }

  /** 带插值的读取（仅用于非 system 场景，例如 retitle 的问题描述） */
  render(name: 'chunk' | 'summary' | 'select' | 'retitle', vars: Record<string, string>): string {
    let text = this.get(name);
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{{${k}}}`).join(v);
    }
    return text;
  }

  /** 供 UI 展示与排障：列出已加载的 prompt 与其指纹 */
  list(): Array<{ name: string; bytes: number; head: string }> {
    const out: Array<{ name: string; bytes: number; head: string }> = [];
    for (const name of ['chunk', 'summary', 'select', 'retitle'] as const) {
      try {
        const t = this.get(name);
        out.push({ name, bytes: Buffer.byteLength(t, 'utf8'), head: t.slice(0, 60).replace(/\n/g, ' ') });
      } catch {
        out.push({ name, bytes: 0, head: '(缺失)' });
      }
    }
    return out;
  }
}

/* ============================================================================
 * 后处理：tid 映射、标签清理、区间规范化
 * ========================================================================== */

/**
 * 分区文字 → 白名单 tid。
 *
 * ⚠️ 陷阱 #20：**LLM 不直接产出 tid**。它不知道 B站分区 ID，硬让它输出数字必然出错。
 * 因此由本服务做映射；映射失败回退配置的默认分区，绝不使用模型给的数字。
 *
 * 匹配策略（容错优先，但要可解释）：
 *   1. 精确匹配
 *   2. 归一化匹配（去空格、统一分隔符 `/`、去「区」后缀、大小写不敏感）
 *   3. 末段匹配（如「单机游戏」→「游戏/单机游戏」）
 *   4. 包含匹配（取白名单中键包含该文字且最短的一个，避免「游戏」命中过宽的项）
 */
export function mapCategoryToTid(
  category: string,
  whitelist: Record<string, number>,
  defaultCategory: string,
): { tid: number; matched: string; method: 'exact' | 'normalized' | 'suffix' | 'contains' | 'default'; note?: string } {
  const norm = (s: string): string =>
    s
      .replace(/\s+/g, '')
      .replace(/[·•・>＞\-—_]/g, '/')
      .replace(/区$/, '')
      .replace(/频道$/, '')
      .toLowerCase();
  const want = norm(category);
  const entries = Object.entries(whitelist);

  // 1. 精确
  if (whitelist[category] !== undefined) {
    return { tid: whitelist[category], matched: category, method: 'exact' };
  }
  // 2. 归一化
  for (const [name, tid] of entries) {
    if (norm(name) === want) return { tid, matched: name, method: 'normalized' };
  }
  // 3. 末段匹配
  const wantLast = want.split('/').filter(Boolean).pop() ?? want;
  const suffixHits = entries.filter(([name]) => (norm(name).split('/').filter(Boolean).pop() ?? '') === wantLast);
  if (suffixHits.length === 1) return { tid: suffixHits[0]![1], matched: suffixHits[0]![0], method: 'suffix' };

  // 4. 包含匹配：取键最短的（最具体）一个
  const containsHits = entries
    .filter(([name]) => {
      const n = norm(name);
      return n.includes(want) || want.includes(n);
    })
    .sort((a, b) => a[0].length - b[0].length);
  if (containsHits.length >= 1) {
    return { tid: containsHits[0]![1], matched: containsHits[0]![0], method: 'contains' };
  }

  const fallback = whitelist[defaultCategory] ?? entries[0]?.[1] ?? 21;
  return {
    tid: fallback,
    matched: whitelist[defaultCategory] !== undefined ? defaultCategory : (entries[0]?.[0] ?? '综合'),
    method: 'default',
    note: `分区「${category}」不在白名单中，已回退到默认分区「${defaultCategory}」`,
  };
}

/** 标签去重、截断、过滤敏感词，并保证 1–10 个（硬约束 #3 / #16） */
export function sanitizeTags(
  tags: string[],
  opts: { extra?: string[]; sensitive?: string[]; max?: number; maxLen?: number },
): { tags: string[]; removed: string[] } {
  const max = opts.max ?? 10;
  const maxLen = opts.maxLen ?? 12;
  const sensitive = (opts.sensitive ?? []).map((s) => s.toLowerCase());
  const removed: string[] = [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of [...tags, ...(opts.extra ?? [])]) {
    let t = String(raw)
      .replace(/[#＃]/g, '')
      .replace(/[\r\n\t]/g, '')
      .trim();
    if (!t) continue;
    if (/\s/.test(t)) t = t.replace(/\s+/g, '');
    if (t.length > maxLen) t = t.slice(0, maxLen);
    const lower = t.toLowerCase();
    if (sensitive.some((s) => s && lower.includes(s))) {
      removed.push(`${t}（命中敏感词）`);
      continue;
    }
    if (/^\d+$/.test(t)) {
      removed.push(`${t}（纯数字）`);
      continue;
    }
    if (seen.has(lower)) {
      removed.push(`${t}（重复）`);
      continue;
    }
    if (out.length >= max) {
      removed.push(`${t}（超出 ${max} 个上限）`);
      continue;
    }
    seen.add(lower);
    out.push(t);
  }
  return { tags: out, removed };
}

/** 标题后处理：去换行、去多余空白、截断到 80 字符 */
export function sanitizeTitle(title: string, max = 80): { title: string; truncated: boolean } {
  const t = String(title)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (t.length <= max) return { title: t, truncated: false };
  return { title: t.slice(0, max), truncated: true };
}

/** 简介后处理：截断到 250 字符 */
export function sanitizeDesc(desc: string, max = 250): { desc: string; truncated: boolean } {
  const d = String(desc).replace(/\r/g, '').trim();
  if (d.length <= max) return { desc: d, truncated: false };
  return { desc: d.slice(0, max), truncated: true };
}

export interface SanitizeReport {
  clips: ClipRecord[];
  dropped: Array<{ index: number; reason: string; clip: Partial<ClipCandidate> }>;
  warnings: string[];
}

/**
 * 从转写里粗略识别「唱歌区段」。
 *
 * 为什么需要（用户报的第二个问题：「唱歌的时候歌词刚唱完，切片就突然结束了」）：
 *   选片 LLM 看不到转写原文，而唱歌这件事在**时间窗要点**里几乎不会体现
 *   （要点写的是"某时刻回怼XX"这类内容摘要）。于是模型完全不知道那是首歌，
 *   切点自然就卡在两句歌词之间 —— 实测真实任务的候选 #0 结尾 381.5s，上下文是：
 *       355.6–360.0 祝你幸福永远幸福永远        ← 唱歌
 *       388.8–391.0 我在这边唱一首啊            ← 下一首刚要开始
 *   切在"两首歌之间"。
 *
 * 注意：ASR 会**过滤音乐**（`asr` 调用里 `song: false` 是有意为之），
 *   所以歌词段落常常识别不出来，我们不能依赖歌词内容 —— 改为看"唱/歌"这类词的出现位置，
 *   再把邻近的命中合并成区段。这只是给 LLM 的**参考提示**，不是硬边界。
 */
export function detectSongRegions(
  segments: ReadonlyArray<{ start: number; end: number; text: string }>,
  opts: { mergeGapSec?: number; contextSec?: number; maxRegions?: number } = {},
): Array<{ start: number; end: number }> {
  const mergeGap = opts.mergeGapSec ?? 90;
  const ctx = opts.contextSec ?? 20;
  const maxRegions = opts.maxRegions ?? 30;
  const re = /唱|歌|哼|旋律|点歌|献丑|啦啦|music/i;

  const hits = segments.filter((s) => re.test(s.text));
  if (!hits.length) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const h of hits) {
    const s = Math.max(0, h.start - ctx);
    const e = h.end + ctx;
    const last = ranges[ranges.length - 1];
    if (last && s - last.end <= mergeGap) last.end = Math.max(last.end, e);
    else ranges.push({ start: s, end: e });
  }
  // 太短的区段多半是误报（例如只是提了一嘴"歌"）
  return ranges.filter((r) => r.end - r.start >= 10).slice(0, maxRegions);
}

/**
 * 求"包含 t 或紧邻 t 的那个静音空隙"。
 *
 * ⚠️ 关键教训（都被真实数据打过脸）：
 *  1. **不能用 ASR 段边界当停顿**：实测真实转写的句子间隙**中位数 = 0.00s**、平均段长 2.69s，
 *     段落是连续拼接的（为了不让字幕断档），段边界只是切分点，不代表说话人停了。
 *     照段边界对齐等于没对齐（该数据上 7/8 个切片结尾仍落在句子内部）。
 *  2. **不能累计静音**：从录音开头一路累加的话，长录音里到处都是"停顿"（实测 40 秒处就攒到 1.6s），
 *     判定完全失效。停顿是**局部**概念。
 *  3. 正确模型：停顿 = 一段**静音空隙**（前一句说完 → 后一句开口），
 *     它有两个可用端点：`start`（话音落下）与 `end`（再次开口）。
 *     两端都合法，取离 LLM 意图近的那个 —— 这样 41.0 处的 1.0s 空隙既能收在 40.0 也能收在 41.0。
 */
function findSilenceGap(
  t: number,
  segs: ReadonlyArray<{ start: number; end: number }>,
  minQuiet: number,
): { start: number; end: number } | undefined {
  for (let i = 0; i < segs.length; i++) {
    const cur = segs[i]!;
    if (t >= cur.start && t <= cur.end) return undefined; // 落在说话中间，不是停顿
    const next = segs[i + 1];
    const gapStart = cur.end;
    const gapEnd = next ? next.start : Number.POSITIVE_INFINITY;
    if (t >= gapStart && t <= gapEnd) {
      // 录音末尾的"开口"未知，用 t 本身当右端点，避免吸到无穷远
      const ge = Number.isFinite(gapEnd) ? gapEnd : t;
      if (ge - gapStart < minQuiet) return undefined; // 空隙太短，不算停顿
      return { start: gapStart, end: ge };
    }
    if (t < cur.start) return undefined;
  }
  return undefined;
}

/**
 * 决定切片结尾该落在哪里：对齐到**真正的停顿**（静音），并保证不超时长上限。
 *
 * 为什么需要它（真实故障，用户报的「唱歌时歌词刚唱完，切片就突然结束了」）：
 *   选片 LLM **看不到转写原文**，只拿到「各时间窗要点」（形如 `- 00:12:38 回怼裸睡戴帽子…`），
 *   所以它给的 start/end 只能是拍脑袋的近似值 —— 实测两组真实数据：
 *   end 全部落在 1.5 秒网格上（`xxx.5`），且 6/9、7/8 都切在句子内部。
 *   旧实现唯一的收尾处理是 `bufferSec`（前后各留 1.5s），它不看转写，救不了这个问题。
 *
 * 判定顺序：
 *   1. 先就地找停顿：向前最多 maxSnapAheadSec、向后最多 maxBackwardSnapSec 范围内的最近停顿；
 *   2. 找不到（说明中间是长段连续说话）→ 退到**当前这段连续语音的起点**，宁可短而完整；
 *   3. 再不行（时长会越界）→ 保持原样，由调用方按上限硬裁并告警。
 */
function resolveClipEnd(
  idealEnd: number,
  start: number,
  segs: ReadonlyArray<{ start: number; end: number; text: string }>,
  opts: {
    minDurationSec: number;
    maxDurationSec: number;
    maxSnapAheadSec: number;
    minPauseSec?: number;
    maxBackwardSnapSec: number;
  },
): { end: number; snapped: boolean } {
  const hi = start + opts.maxDurationSec;
  if (!segs.length) {
    return idealEnd > hi ? { end: hi, snapped: false } : { end: idealEnd, snapped: false };
  }
  // 0.05s：停顿阈值刻意取很小。理由：ASR 的字/词之间天然有 20–100ms 微间隙，
  // 而歌词"一句 ↔ 下一句"之间实测只有 ~0.1s —— 50ms 以上的间歇人耳已等同于停顿。
  // 阈值取 0.35/0.12 都会把这种正常换句当成"没停"，在密集唱歌区段里直接导致吸不到任何点。
  const minPause = opts.minPauseSec ?? 0.05;
  const lo = start + opts.minDurationSec;
  // 下限给一点容差：把结尾提前到停顿处常常只差零点几秒就够到 minDurationSec
  // （实测 29.0s vs 下限 30s），为这 1 秒整条丢掉一个完整候选不值得 ——
  // 选片标准本身就写着"宁可短而完整"。上限**不给容差**（那是平台/观感硬边界）。
  const loTol = Math.max(0, Math.min(2, opts.minDurationSec * 0.05));
  const fits = (e: number): boolean => e >= lo - loTol - 0.001 && e <= hi + 0.001;
  const consider = (v: number, best: { v?: number; d: number }): void => {
    if (!fits(v)) return;
    const d = Math.abs(v - idealEnd);
    if (d < best.d) {
      best.d = d;
      best.v = v;
    }
  };

  const best: { v?: number; d: number } = { d: Number.POSITIVE_INFINITY };
  // 先用 t 本身所在/紧邻的空隙：把两个端点都作为候选，取离意图近的
  const own = findSilenceGap(idealEnd, segs, minPause);
  if (own) {
    consider(own.start, best);
    consider(own.end, best);
  }
  // 再向前后扫一步之内的其它空隙（向前受限 maxSnapAheadSec，向后可用 maxBackwardSnapSec）
  const scan = (from: number, to: number, step: number): void => {
    if (step > 0) {
      for (let t = from; t <= to + 1e-6; t += step) {
        const g = findSilenceGap(t, segs, minPause);
        if (g) {
          consider(g.start, best);
          consider(g.end, best);
        }
      }
    } else {
      for (let t = from; t >= to - 1e-6; t += step) {
        const g = findSilenceGap(t, segs, minPause);
        if (g) {
          consider(g.start, best);
          consider(g.end, best);
        }
      }
    }
  };
  scan(idealEnd, Math.min(idealEnd + opts.maxSnapAheadSec, hi), 0.25);
  scan(idealEnd, Math.max(0, idealEnd - opts.maxBackwardSnapSec), -0.25);
  if (best.v !== undefined) return { end: best.v, snapped: Math.abs(best.v - idealEnd) > 0.05 };

  // ③ 周围没有停顿 → 退到当前这段连续语音的起点（切在"这一整段话"之前，而不是切在半句上）
  const runStart = startOfSpeechRun(idealEnd, segs, minPause);
  if (runStart !== undefined && fits(runStart) && runStart < idealEnd) return { end: runStart, snapped: true };

  return { end: Math.min(idealEnd, hi), snapped: false };
}

/**
 * 求包含 t（或紧邻 t 之前）的那一段**连续语音**的起点。
 * 用途：结尾落在长段连续说话中间、附近又没有停顿可吸时，
 * 退到"这一整段话开始之前"收尾，而不是硬切在半句上（宁可短而完整）。
 */
function startOfSpeechRun(
  t: number,
  segs: ReadonlyArray<{ start: number; end: number }>,
  minPause: number,
): number | undefined {
  const inside = segs.find((s) => t >= s.start && t <= s.end);
  const firstAfter = segs.find((s) => s.start > t);
  let runStart = inside?.start ?? firstAfter?.start;
  if (runStart === undefined) return undefined;
  let prevEnd: number | undefined;
  for (const s of segs) {
    if (s.start > t) break;
    if (prevEnd !== undefined && s.start - prevEnd >= minPause) runStart = s.start; // 这里起是新的一段
    prevEnd = Math.max(prevEnd ?? 0, s.end);
  }
  return runStart;
}

/**
 * 把切片起点吸附到自然断句点。
 *
 * 与结尾不同，起点**只能往更早方向挪**：往后挪会把话头切掉（前 3 秒钩子就没了）。
 * 所以只有当 idealStart 落在某句中间时，才把它提前到该句开头。
 */
function snapStartToSpeechBoundary(
  idealStart: number,
  segs: ReadonlyArray<{ start: number; end: number; text: string }>,
): number {
  if (!segs.length || idealStart <= 0) return idealStart;
  for (const s of segs) {
    if (s.start > idealStart) break;
    if (idealStart > s.start && idealStart < s.end) {
      // 落在这一句中间 → 提前到句首（更早是安全方向）
      return s.start;
    }
  }
  return idealStart;
}

/**
 * 规范化候选切片：过滤越界、时长不合规、相互重叠的项，并补齐 UI 需要的状态字段。
 *
 * 重叠处理规则：按 score 降序保留，后到的重叠项被丢弃并记录原因 ——
 * 这样高分的片段一定留下，符合「默认勾选评分最高的 N 个」的交互设计。
 */
export function sanitizeClips(
  candidates: ClipCandidate[],
  opts: {
    videoDuration: number;
    minDurationSec: number;
    maxDurationSec: number;
    bufferSec: number;
    maxClips: number;
    tidWhitelist: Record<string, number>;
    defaultCategory: string;
    defaultTags: string[];
    tagSensitiveWords: string[];
    extraTags?: string[];
    autoSelectScoreFloor: number;
    /** 默认勾选项数上限（按评分降序取头部）。见 config 里 autoSelectTopN 的说明。 */
    autoSelectTopN: number;
    /**
     * 转写段落（用于把切片边界吸附到自然断句点）。
     * 不传时退化为旧行为（只按 bufferSec 处理）—— 没有转写就没法判断句子边界。
     */
    transcriptSegments?: ReadonlyArray<{ start: number; end: number; text: string }>;
    /** 结尾向前吸附的上限（秒）。超过这个距离就不算"吸附"，宁可不动。默认 4 秒。 */
    maxSnapAheadSec?: number;
    /**
     * 疑似唱歌区段。结尾落在区段内部时会顺延到区段结束（只要不超时长上限），
     * 避免"歌词刚唱完/正唱着就断"。不传则不启用该兜底。
     */
    songRegions?: ReadonlyArray<{ start: number; end: number }>;
    /**
     * **分P 边界时间点**（秒，升序）。切片不得跨越这些点。
     *
     * 背景：biliLive-tools 把一场直播按 `segment` 参数切成多个文件、每个文件投成一个分P
     * （`uploadNoDanmu` 时还会再投一份纯享版）。观众在分P 边界处会换集，
     * 一个跨越边界的切片等于"这条切片在两个分P 里各有一半"，看不完整。
     *
     * LLM 看不到这层信息，所以除了在 prompt 里告知（`buildSelectPrompt`），
     * 这里再做一道**确定性兜底**：能收进单侧就收，收不下且短于下限就丢弃。
     */
    partBoundaries?: ReadonlyArray<number>;
    /**
     * 源视频路径。给了它就启用**能量边界修正**（见下方 `clipBoundarySpeechTrimSec`）：
     * 起点/终点落在"没人说话"的地方时，用音频能量把它拉到有人说话的位置。
     *
     * 为什么需要（实测事故 2026-09-24）：转写吸附是**按 ASR 段边界**做的，
     * 而 ASR 的段窗口本身可能离谱（实测「如。萌啊…」15 个字占 0→30.9s）。
     * 于是 clip[1] 的起点 746.69s 正好落在那条假窗口的开头 ——
     * 成片前 28 秒只有背景音（响度 −31…−38 dB），观众看到的是空转。
     */
    videoPath?: string;
    /** 允许为"去掉没人的开头/结尾"而移动边界的上限（秒），0 = 关闭。默认 30。 */
    boundarySpeechTrimSec?: number;
    /** 直接注入剖面（测试用；不传则按 `videoPath` 现算） */
    energyProfile?: EnergyProfile;
  },
): SanitizeReport {
  const dropped: SanitizeReport['dropped'] = [];
  const warnings: string[] = [];
  const kept: ClipRecord[] = [];
  // 按 start 升序（snap* 的搜索依赖有序），并剔除时间非法的段
  const segs = [...(opts.transcriptSegments ?? [])]
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const songs = [...(opts.songRegions ?? [])]
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  /* 分P 边界：去重、排序、丢掉首尾（0 与总时长不是"切口"） */
  const boundaries = [...new Set((opts.partBoundaries ?? []).filter((b) => Number.isFinite(b) && b > 1))]
    .filter((b) => opts.videoDuration <= 0 || b < opts.videoDuration - 1)
    .sort((a, b) => a - b);
  const maxSnapAheadSec = opts.maxSnapAheadSec ?? 4;
  /* 能量边界修正：只在配置开启**且**拿到剖面时生效（拿不到就退回纯转写吸附，行为不变） */
  const trimSec = opts.boundarySpeechTrimSec ?? 0;
  const profile = trimSec > 0 ? (opts.energyProfile ?? energyProfileCached(opts.videoPath)) : undefined;
  /** 死气比这个还短就不动 —— 正常的开场留白（实测 clip[0] 是 2.5 秒）不该被裁 */
  const MIN_DEAD_SEC = 4;

  const sorted = [...candidates]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.score - a.c.score)
    .slice(0, Math.max(1, opts.maxClips));

  for (const { c, i } of sorted) {
    // 前后各留 buffer（§8 WP4 步骤 4）
    let start = Math.max(0, c.start - opts.bufferSec);
    let end = Math.min(opts.videoDuration > 0 ? opts.videoDuration : c.end + opts.bufferSec, c.end + opts.bufferSec);
    if (!(end > start)) {
      dropped.push({ index: i, reason: `起止时间非法（start=${c.start} end=${c.end}）`, clip: c });
      continue;
    }

    // ★ 决定结尾：吸附到自然断句点，并保证不超时长上限。
    //   必须在「时长裁剪」之前 —— 裁剪是纯算术（start + maxDurationSec），
    //   那个位置必定落在句子中间，正是"突然结束"的主因；
    //   交给 resolveClipEnd 在合法区间内挑一个自然断句点，就不会切在半句话上。
    const snappedStart = segs.length ? snapStartToSpeechBoundary(start, segs) : start;
    const resolved = resolveClipEnd(end, snappedStart, segs, {
      minDurationSec: opts.minDurationSec,
      maxDurationSec: opts.maxDurationSec,
      maxSnapAheadSec,
      // 向后是安全方向（片段变短、不会切掉话头），可以找得远一些
      maxBackwardSnapSec: Math.min(20, opts.maxDurationSec / 4),
    });
    const snappedEnd = resolved.end;
    const dStart = snappedStart - start;
    const dEnd = snappedEnd - end;
    if (Math.abs(dStart) > 0.05 || Math.abs(dEnd) > 0.05) {
      warnings.push(
        `片段 ${i} 结尾对齐到自然断句点：${start.toFixed(1)}–${end.toFixed(1)}s → ` +
          `${snappedStart.toFixed(1)}–${snappedEnd.toFixed(1)}s（起点 ${dStart >= 0 ? '+' : ''}${dStart.toFixed(1)}s，` +
          `结尾 ${dEnd >= 0 ? '+' : ''}${dEnd.toFixed(1)}s）`,
      );
    }
    start = snappedStart;
    end = snappedEnd;

    /* ★ 能量边界修正：把"没人的开头/结尾"裁掉。
       转写吸附只能吸到 ASR 给的句子边界上 —— ASR 的窗口错，它就跟着错。
       这里用**音频本身**（RMS 剖面）兜一道，且只在死气超过 MIN_DEAD_SEC 时才动，
       并保证裁完仍不低于时长下限（宁可不裁，也不产出一个过短的片段）。 */
    if (profile) {
      if (start > 0) {
        const onset = findSpeechOnset(profile, start, trimSec);
        if (onset !== undefined && onset - start >= MIN_DEAD_SEC && end - onset >= opts.minDurationSec) {
          warnings.push(
            `片段 ${i} 开头 ${(onset - start).toFixed(1)}s 没人说话（响度低于 ${SPEECH_DB} dB），` +
              `起点已从 ${start.toFixed(1)}s 拉到 ${onset.toFixed(1)}s（避免成片空转）`,
          );
          start = onset;
        }
      }
      const offset = findSpeechOffset(profile, end, trimSec);
      if (offset !== undefined && end - offset >= MIN_DEAD_SEC && offset - start >= opts.minDurationSec) {
        warnings.push(`片段 ${i} 结尾 ${(end - offset).toFixed(1)}s 没人说话，结尾已从 ${end.toFixed(1)}s 收到 ${offset.toFixed(1)}s`);
        end = offset;
      }
    }

    // 唱歌区段兜底：LLM 可能仍把结尾落在歌里（它本来就看不到转写）。
    // 若把结尾推到该区段结束之后仍在上限内，就推过去 —— 用户明确反馈过"歌词刚唱完就断"。
    const song = songs.find((r) => end > r.start + 0.5 && end < r.end - 0.5);
    if (song && song.end - start <= opts.maxDurationSec) {
      warnings.push(
        `片段 ${i} 结尾落在疑似唱歌区段内（${song.start.toFixed(1)}–${song.end.toFixed(1)}s），` +
          `已顺延到该区段结束 ${song.end.toFixed(1)}s，避免"唱着就断"`,
      );
      end = song.end;
    }

    /* ★ 分P 边界防护：切片不得跨越分P。
       跨越的切片在 B站 上会被拆到两个分P 里，观众看不完整（一条切片只看到一半）。
       LLM 不知道分P 结构，所以这里做确定性收口：
         ① 把结尾收到边界前 —— 只要收完仍不低于时长下限；
         ② 收不下就把起点推到边界后 —— 只要推完仍不低于时长下限；
         ③ 都不行则丢弃（宁可少一条，也不产出跨集切片）。 */
    if (boundaries.length) {
      const cross = boundaries.filter((b) => b > start + 0.5 && b < end - 0.5);
      if (cross.length > 0) {
        const first = cross[0]!;
        if (first - start >= opts.minDurationSec) {
          warnings.push(
            `片段 ${i} 跨越分P 边界 ${first.toFixed(1)}s（原 ${start.toFixed(1)}–${end.toFixed(1)}s），` +
              `已把结尾收到 ${first.toFixed(1)}s，避免切片被拆到两个分P`,
          );
          end = first;
        } else {
          const last = cross[cross.length - 1]!;
          if (end - last >= opts.minDurationSec) {
            warnings.push(
              `片段 ${i} 跨越分P 边界 ${last.toFixed(1)}s（原 ${start.toFixed(1)}–${end.toFixed(1)}s），` +
                `已把起点推到 ${last.toFixed(1)}s，避免切片被拆到两个分P`,
            );
            start = last;
          } else {
            dropped.push({
              index: i,
              reason:
                `跨越分P 边界（${cross.map((b) => b.toFixed(1)).join(', ')}s）且两侧都放不下 ` +
                `${opts.minDurationSec}s 的完整片段 —— 跨集切片观感不完整，已丢弃`,
              clip: c,
            });
            continue;
          }
        }
      }
    }

    // 兜底裁剪：仅当上面没能把结尾收进合法区间时才会命中（例如完全没有可用的句子边界）
    let duration = end - start;
    if (duration > opts.maxDurationSec) {
      end = start + opts.maxDurationSec;
      duration = opts.maxDurationSec;
      warnings.push(
        `片段 ${i} 原始区间 ${(c.end - c.start).toFixed(1)}s 超过上限 ${opts.maxDurationSec}s，` +
          `且附近没有可用的句子边界，已硬裁到 ${opts.maxDurationSec}s（可能切在半句话上）`,
      );
    }
    if (duration < opts.minDurationSec) {
      dropped.push({
        index: i,
        reason: `时长 ${duration.toFixed(1)}s 短于下限 ${opts.minDurationSec}s，且无法在不越界的前提下扩展`,
        clip: c,
      });
      continue;
    }
    // 越界检查（videoDuration 未知时跳过）
    if (opts.videoDuration > 0 && (start < 0 || end > opts.videoDuration + 1)) {
      dropped.push({
        index: i,
        reason: `区间超出视频时长（${start.toFixed(1)}–${end.toFixed(1)} vs 总时长 ${opts.videoDuration.toFixed(1)}）`,
        clip: c,
      });
      continue;
    }
    // 与已保留项重叠
    const overlap = kept.find((k) => start < k.end && end > k.start);
    if (overlap) {
      dropped.push({
        index: i,
        reason: `与已选片段 #${overlap.index}（${overlap.start.toFixed(1)}–${overlap.end.toFixed(1)}s，评分 ${overlap.score}）时间重叠`,
        clip: c,
      });
      continue;
    }

    const title = sanitizeTitle(c.title);
    if (title.truncated) warnings.push(`片段 ${i} 标题超过 80 字符，已截断`);
    const desc = sanitizeDesc(c.desc ?? '');
    if (desc.truncated) warnings.push(`片段 ${i} 简介超过 250 字符，已截断`);

    const cat = mapCategoryToTid(c.category, opts.tidWhitelist, opts.defaultCategory);
    if (cat.note) warnings.push(cat.note);

    // ★ 标签**只信 LLM 给的那几个**，绝不把 defaultTags 强制追加到每个切片上。
    //   曾经写成 `extra: [...opts.defaultTags, ...extraTags]`，后果是每个候选都被塞进
    //   同样的两个词（实测 9/9 个候选的标签完全一致），观众侧 SEO 零区分度，
    //   而且每个切片都会刷一条「标签被移除：直播切片（重复）、名场面（重复）」的噪音警告
    //   （LLM 本来就会学着写这两个词，于是必然重复）。
    //   defaultTags 的定位改为**只在 LLM 一个标签都没给出时的兜底**，见下面 tags.length === 0 分支。
    //   extraTags 是 UI「本场设置」的手动覆盖，属于人工显式意图，保留追加语义。
    const tagRes = sanitizeTags(c.tags, {
      ...(opts.extraTags?.length ? { extra: opts.extraTags } : {}),
      sensitive: opts.tagSensitiveWords,
    });
    if (tagRes.removed.length) warnings.push(`片段 ${i} 标签被移除：${tagRes.removed.join('、')}`);
    let tags = tagRes.tags;
    if (tags.length === 0) {
      // 兜底：LLM 没给出任何可用标签时才动用 defaultTags
      tags = sanitizeTags(opts.defaultTags.length ? opts.defaultTags : ['直播切片'], { sensitive: opts.tagSensitiveWords }).tags;
      warnings.push(`片段 ${i} LLM 未给出可用标签，已用配置的默认标签兜底：${tags.join('、')}`);
    }

    const coverTs =
      c.cover_ts !== undefined && c.cover_ts >= start && c.cover_ts <= end ? c.cover_ts : Number(((start + end) / 2).toFixed(1));

    kept.push({
      index: kept.length,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      title: title.title,
      desc: desc.desc,
      tags,
      category: cat.matched,
      score: c.score,
      reason: c.reason ?? '',
      cover_ts: coverTs,
      /* 默认勾选先按**绝对门槛**给一个初值，循环结束后再按**相对排名**收一次口。
         （绝对门槛单独用不住：实测 LLM 会给出一堆贴着门槛的分数，14 个候选全部 ≥7.0。） */
      selected: c.score >= opts.autoSelectScoreFloor,
      status: 'CANDIDATE',
      degraded: false,
      llmOriginal: { title: c.title, start: c.start, end: c.end, tags: c.tags },
      createdAt: nowIso(),
    });
  }

  /* ★ 默认勾选收口：最多 N 个，按评分降序取头部。
     为什么用相对排名而不是绝对分：绝对分跨场不可比，实测一场 14 个候选**全部** ≥7.0
     （最低正好等于门槛 7.0、均值 7.4）⇒ 门槛一个都没挡住 ⇒ 14 个全被自动切、自动投。
     相对排名保证"自动处理的是这场最值得的几个"，其余仍保留在 clips.json 里，
     用户可在界面手动补勾（不丢信息，只是默认不选）。 */
  const topN = Math.max(1, opts.autoSelectTopN);
  const byScore = [...kept].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const autoKeep = new Set(byScore.slice(0, topN).map((c) => c.index));
  let unselectedByRank = 0;
  for (const c of kept) {
    if (c.selected && !autoKeep.has(c.index)) {
      c.selected = false;
      unselectedByRank++;
    }
  }
  if (unselectedByRank > 0) {
    warnings.push(
      `默认勾选上限 ${topN} 个：另有 ${unselectedByRank} 个候选评分达标但超出上限，已改为**不默认勾选**` +
        `（仍保留在候选列表里，可在界面上手动勾选后再投）`,
    );
  }

  kept.sort((a, b) => a.start - b.start);
  // 重排 index 以保持与数组下标一致（UI 用 idx 做 PATCH 目标）
  kept.forEach((k, i) => {
    k.index = i;
  });

  return { clips: kept, dropped, warnings };
}

/* ============================================================================
 * 分块
 * ========================================================================== */

export interface TimeChunk {
  index: number;
  start: number;
  end: number;
  segments: TranscriptSegment[];
  /** 该块内是否有转写缺失区间 */
  gaps: Array<{ start: number; end: number }>;
}

/** 按 chunkMinutes 把转写切成块，并标注每块内的缺失区间 */
export function chunkTranscript(
  transcript: Transcript,
  chunkMinutes: number,
  videoDuration: number,
): TimeChunk[] {
  const total = videoDuration > 0 ? videoDuration : Math.max(0, ...transcript.segments.map((s) => s.end), 0);
  const size = Math.max(60, chunkMinutes * 60);
  const chunks: TimeChunk[] = [];
  for (let start = 0, i = 0; start < Math.max(total, 1); start += size, i++) {
    const end = Math.min(total || start + size, start + size);
    const segments = transcript.segments.filter((s) => s.end > start && s.start < end);
    const gaps = transcript.gaps
      .filter((g) => g.end > start && g.start < end)
      .map((g) => ({ start: Math.max(g.start, start), end: Math.min(g.end, end) }));
    chunks.push({ index: i, start, end, segments, gaps });
  }
  return chunks;
}

/** 供 LLM 阅读的转写文本（带 [秒] 前缀，便于模型定位 highlight 时间） */
export function renderChunkTranscript(chunk: TimeChunk, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 12000;
  const lines: string[] = [];
  for (const s of chunk.segments) {
    const rel = Math.max(0, s.start - chunk.start);
    lines.push(`[${Math.round(rel)}s] ${s.text}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) {
    // 超长时均匀降采样而不是直接截断尾巴 —— 免得模型只看到前半段
    const keep = Math.floor(maxChars / 240);
    const step = Math.max(1, Math.ceil(lines.length / Math.max(1, keep)));
    const sampled: string[] = [];
    for (let i = 0; i < lines.length; i += step) sampled.push(lines[i]!);
    text = `${sampled.join('\n')}\n（注：本段转写过长，已按 ${step}:1 抽样呈现）`;
  }
  if (chunk.gaps.length) {
    const gapText = chunk.gaps.map((g) => `${Math.round(g.start - chunk.start)}s–${Math.round(g.end - chunk.start)}s`).join('、');
    text += `\n\n（注：本时间窗内 ${gapText} 区间语音识别缺失，请勿编造该段内容）`;
  }
  return text || '（本时间窗内没有可用的转写文本）';
}

/* ============================================================================
 * 主流程
 * ========================================================================== */

export interface AnalyzeDeps {
  llm: LlmClient;
  config: AppConfig;
  logger?: Logger;
  prompts?: PromptStore;
}

export interface AnalyzeOptions {
  taskId: string;
  transcript: Transcript;
  signals: Signals;
  videoDuration: number;
  /**
   * 源视频路径（第一段即可）。给了它，切片边界就能用**音频能量**做修正 ——
   * 起点/终点落在没人说话的地方时自动拉回有人说话的位置（见 `sanitizeClips`）。
   */
  videoPath?: string;
  /**
   * 术语表（主播名 / 专有名词）。
   *
   * 作用：告诉模型这些词是**正确写法**，不要改写、不要当成错别字"纠正"。
   * 不注入的话，模型会把「闪身步」自作聪明改成「闪身部」，把对的改错。
   */
  glossary?: Glossary;
  /**
   * 本场主播识别结果（`detectStreamer` 的产出）。
   *
   * 为什么必须按场传：术语表是**跨主播**的全局词表，而提示词是"本场"。
   * 以前把词表里的主播整行当成"本场主播"，模型就会把甲主播的直播总结成乙主播的。
   */
  streamer?: StreamerGuess;
  /** dry-run：不调用付费 LLM（返回降级结果由调用方处理） */
  dryRun?: boolean;
  allowPaid?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: { current: number; total: number; label: string }) => void;
  /** 本场覆盖：最多候选数（UI「本场设置」） */
  maxClipsOverride?: number;
  /** 本场覆盖：追加标签（追加到全局标签之后） */
  extraTags?: string[];
  /**
   * **分P 边界时间点**（秒）。本场被 biliLive-tools 按录制分段切成了多个分P，
   * 切片不能跨越这些点（跨界的切片在 B站 上会被拆到两个分P，观众只看到一半）。
   * 由调用方按 `task.source.segments` 的 globalEnd 计算传入。
   */
  partBoundaries?: ReadonlyArray<number>;
}

export interface AnalyzeResult {
  summary: string;
  decision: ClipDecision;
  digests: ChunkDigest[];
  warnings: string[];
  /** 时间线（写入错误报告） */
  timeline: Array<{ at: string; step: string; ok: boolean; detail?: string; model?: string; elapsedMs?: number }>;
  cost: { promptTokens: number; completionTokens: number; calls: number; cost: number };
}

export class Analyzer {
  private llm: LlmClient;
  private cfg: AppConfig;
  private logger: Logger;
  private prompts: PromptStore;

  constructor(deps: AnalyzeDeps) {
    this.llm = deps.llm;
    this.cfg = deps.config;
    this.logger = (deps.logger ?? globalLog).child({ mod: 'analyze' });
    this.prompts = deps.prompts ?? new PromptStore();
  }

  update(cfg: AppConfig): void {
    this.cfg = cfg;
  }

  /** 分块要点提炼（便宜档，约 20 次调用，占绝大部分 token） */
  private async digestChunks(
    chunks: TimeChunk[],
    signals: Signals,
    opts: AnalyzeOptions,
    timeline: AnalyzeResult['timeline'],
  ): Promise<{ digests: ChunkDigest[]; warnings: string[] }> {
    const warnings: string[] = [];
    const digestMap = new Map<number, ChunkDigest>();

    // ★ system 必须字节级一致（§5.4）：chunk.md 原文直接用作 system，块内容全部放 user
    const system = this.prompts.get('chunk');
    // 术语表放在 user 消息最前面：它在所有分块里完全相同，形成可复用的前缀，
    // 不至于让每次调用的前缀都不同而吃掉服务端的提示词缓存收益。
    const glossaryText = opts.glossary ? renderGlossaryForPrompt(opts.glossary, opts.streamer?.name ? { streamer: opts.streamer.name } : {}) : '';
    const streamerLine = opts.streamer ? streamerPromptLine(opts.streamer) : '';

    const results = await chatJsonBatch(
      this.llm,
      'summary',
      chunks.map((c) => ({
        system,
        user: [
          ...(glossaryText ? [glossaryText, ''] : []),
          ...(streamerLine ? [streamerLine, ''] : []),
          `本时间窗：第 ${c.index + 1} / ${chunks.length} 块，绝对时间 ${fmtDuration(c.start)} – ${fmtDuration(c.end)}（时长 ${Math.round(c.end - c.start)} 秒）`,
          '',
          '## 转写文本',
          renderChunkTranscript(c),
          '',
          '## 弹幕信号（同一时间窗）',
          signalsToPromptText(signals, { start: c.start, end: c.end }, { maxPeaks: 5, maxKeywords: 12 }),
        ].join('\n'),
        schema: chunkOutputSchema,
        purpose: `分块要点 ${c.index + 1}/${chunks.length}`,
      })),
      { concurrency: Math.max(1, this.cfg.llm.chunkConcurrency), ...(opts.signal ? { signal: opts.signal } : {}) },
    );

    results.forEach((r, i) => {
      const chunk = chunks[i]!;
      const t0 = nowIso();
      if (r.ok) {
        digestMap.set(chunk.index, {
          start: chunk.start,
          end: chunk.end,
          topics: r.value.topics,
          highlights: r.value.highlights.map((h) => ({
            // 模型给的是**块内相对秒**，这里换回全局绝对秒
            time: Number((chunk.start + Math.max(0, Math.min(h.time, chunk.end - chunk.start))).toFixed(1)),
            what: h.what,
            why: h.why,
          })),
          ...(chunk.gaps.length ? { gapsNote: `该时间段转写缺失 ${chunk.gaps.length} 处` } : {}),
        });
        timeline.push({ at: t0, step: `分块要点 ${chunk.index + 1}/${chunks.length}`, ok: true, model: this.llm.modelOf('summary') });
      } else {
        const msg = r.error.message;
        warnings.push(`第 ${chunk.index + 1} 块要点提炼失败（${r.error.type}）：${msg}`);
        timeline.push({
          at: t0,
          step: `分块要点 ${chunk.index + 1}/${chunks.length}`,
          ok: false,
          detail: `${r.error.type}: ${msg}`,
          model: this.llm.modelOf('summary'),
        });
        // 单块失败不阻塞整条链路：写入 gaps 说明，让后续总结知道这段缺内容（§4.2 同类处理原则）
        digestMap.set(chunk.index, {
          start: chunk.start,
          end: chunk.end,
          topics: [],
          highlights: [],
          gapsNote: `该时间窗要点提炼失败：${msg}`,
        });
      }
    });

    const digests = chunks.map((c) => digestMap.get(c.index)!).filter(Boolean);
    return { digests, warnings };
  }

  /** reduce：合并各块要点 → 本场总结（便宜档） */
  private async reduceSummary(
    digests: ChunkDigest[],
    warningOut: string[],
    timeline: AnalyzeResult['timeline'],
    opts: AnalyzeOptions = {} as AnalyzeOptions,
  ): Promise<string | undefined> {
    const text = renderDigestsForPrompt(digests);
    /* 主播名必须在这一步就给：本场总结是**最容易被写错主播**的产物 ——
       它只有要点、没有原始转写，模型很容易顺着词表里的其他主播名编。 */
    const streamerLine = opts.streamer ? streamerPromptLine(opts.streamer) : '';
    try {
      const res = await this.llm.chat('summary', {
        // system 同样保持字节级一致
        system: this.prompts.get('summary'),
        user: [streamerLine ? `## 本场主播\n${streamerLine}` : '', streamerLine ? '' : '', text].filter(Boolean).join('\n'),
        purpose: '全局总结',
        temperature: this.cfg.llm.summary.temperature,
      });
      timeline.push({ at: nowIso(), step: '全局总结', ok: true, model: this.llm.modelOf('summary'), elapsedMs: res.usage.durationMs });
      return res.text.trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warningOut.push(`全局总结失败：${msg}`);
      timeline.push({ at: nowIso(), step: '全局总结', ok: false, detail: msg, model: this.llm.modelOf('summary') });
      return undefined;
    }
  }

  /** 选片：选片专用档；契约失败**升级模型重跑**（§5.5） */
  private async selectClips(
    digests: ChunkDigest[],
    signals: Signals,
    opts: AnalyzeOptions,
    timeline: AnalyzeResult['timeline'],
  ): Promise<{ output?: SelectionOutput; escalated: boolean; escalationNote?: string; failure?: LlmError; fallbackSummary?: string }> {
    const userText = this.buildSelectPrompt(digests, signals, opts, opts.glossary);
    const system = this.prompts.get('select');
    const slot: ModelSlot = 'select';

    try {
      const r = await this.llm.chatJson(slot, {
        system,
        user: userText,
        schema: selectionSchema,
        purpose: '选片与起标题',
        maxTokens: this.cfg.llm.select.maxTokens,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      timeline.push({ at: nowIso(), step: '选片与起标题', ok: true, model: this.llm.modelOf(slot), elapsedMs: r.usage.durationMs });
      return { output: r.value as SelectionOutput, escalated: false };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError(String((e as Error).message));
      const meaningful = this.llm.isEscalationMeaningful();

      // ---- 契约校验失败 → 升级到**另一档**模型重跑（硬约束 #13）----
      if (err.type === 'contract') {
        timeline.push({
          at: nowIso(),
          step: '选片与起标题',
          ok: false,
          detail: `契约校验失败：${err.message}`,
          model: err.model || this.llm.modelOf(slot),
        });
        if (!meaningful) {
          // 两档配成同一模型时，升级退化为同模型重试一次；仍失败则直接降级，不做第三次（§5.3）
          this.logger.warn(
            '两档模型配置相同，「升级模型重跑」退化为同模型重试一次。建议把选片档配成更强的模型（§5.3）',
          );
        }
        // ★ 升级必须真的换一个模型：取**另一档**的模型名。
        //   若与刚失败的模型相同（两档同配置），说明无法真正升级 —— 仍重跑一次，
        //   但如实记录「未换模型」，避免看起来像做了升级却其实没有（§5.3 的退化情形）。
        const otherSlot: ModelSlot = slot === 'select' ? 'summary' : 'select';
        const upgraded = this.llm.modelOf(otherSlot);
        const reallyChanged = upgraded !== (err.model || this.llm.modelOf(slot));
        this.logger.info(
          reallyChanged
            ? `契约校验失败，升级到另一档模型 "${upgraded}" 重跑选片（不在原模型上原地重试）`
            : `契约校验失败，但两档模型相同（"${upgraded}"）—— 无法真正升级，按 §5.3 同模型重试一次后即降级`,
        );
        try {
          const r2 = await this.llm.chatJson(slot, {
            system,
            user: userText,
            schema: selectionSchema,
            purpose: '选片与起标题（契约失败后升级重跑）',
            maxTokens: this.cfg.llm.select.maxTokens,
            modelOverride: upgraded,
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
          timeline.push({
            at: nowIso(),
            step: '选片与起标题（升级重跑）',
            ok: true,
            model: upgraded,
            detail: `原失败原因：${err.message}`,
            elapsedMs: r2.usage.durationMs,
          });
          return {
            output: r2.value as SelectionOutput,
            escalated: true,
            escalationNote: reallyChanged
              ? `契约校验失败后升级到另一档模型 "${upgraded}" 重跑成功。原失败：${err.message}`
              : `契约校验失败；两档模型相同（"${upgraded}"），按 §5.3 同模型重试一次后成功。原失败：${err.message}`,
          };
        } catch (e2) {
          const err2 = e2 instanceof LlmError ? e2 : new LlmError(String((e2 as Error).message));
          timeline.push({
            at: nowIso(),
            step: '选片与起标题（升级重跑）',
            ok: false,
            detail: `${err2.type}: ${err2.message}`,
            model: upgraded,
          });
          return {
            escalated: true,
            escalationNote: reallyChanged
              ? `升级到另一档模型 "${upgraded}" 重跑仍失败：${err2.message}`
              : `两档模型相同（"${upgraded}"），同模型重试一次仍失败：${err2.message}`,
            failure: err2,
          };
        }
      }

      timeline.push({
        at: nowIso(),
        step: '选片与起标题',
        ok: false,
        detail: `${err.type}: ${err.message}`,
        model: this.llm.modelOf(slot),
      });
      return { escalated: false, failure: err };
    }
  }

  /** 构建选片 prompt 的 user 部分（所有可变内容都放这里，system 保持恒定） */
  private buildSelectPrompt(digests: ChunkDigest[], signals: Signals, opts: AnalyzeOptions, glossary?: Glossary): string {
    const maxClips = opts.dryRun ? this.cfg.clip.maxCandidates : this.cfg.clip.maxCandidates;
    const lines: string[] = [];
    const glossaryText = glossary
      ? renderGlossaryForPrompt(glossary, opts.streamer?.name ? { streamer: opts.streamer.name } : {})
      : '';
    if (glossaryText) {
      lines.push(glossaryText);
      lines.push('');
    }
    const streamerLine = opts.streamer ? streamerPromptLine(opts.streamer) : '';
    if (streamerLine) {
      lines.push(`## 本场主播`);
      lines.push(streamerLine);
      lines.push('');
    }
    lines.push(`## 视频总时长`);
    lines.push(`${Math.round(opts.videoDuration)} 秒（${fmtDuration(opts.videoDuration)}）`);
    lines.push('');
    lines.push(`## 选片参数`);
    lines.push(`- 候选数量上限：${maxClips} 个`);
    lines.push(`- 片段时长范围：${this.cfg.clip.minDurationSec}–${this.cfg.clip.maxDurationSec} 秒`);
    lines.push(`- 评分低于 ${this.cfg.clip.autoSelectScoreFloor} 的不要输出`);
    lines.push('');
    lines.push(`## 各时间窗要点`);
    lines.push(renderDigestsForPrompt(digests));
    lines.push('');
    // 唱歌区段：LLM 从要点里看不出"这里在唱歌"，于是切点会卡在两句歌词之间。
    // 显式标注出来，并在 system 里要求"不要在唱歌区段内收尾"。
    const songRegions = detectSongRegions(opts.transcript.segments);
    if (songRegions.length) {
      lines.push(`## 疑似唱歌区段（重要）`);
      lines.push(
        `以下时间段内主播在唱歌（由转写里的"唱/歌/哼"等词推断，可能不精确）。` +
          `这些区段**内部不要作为片段结尾** —— 否则会出现"歌词刚唱完就断"的观感。` +
          `如果确实要切唱歌内容，请让 end 落在该区段的**结束之后**，或整体避开。`,
      );
      for (const r of songRegions) lines.push(`- ${fmtDuration(r.start)} – ${fmtDuration(r.end)}`);
      lines.push('');
    }
    /* 分P 边界：这场直播被 biliLive-tools 按录制分段切成了多个分P。
       跨越边界的切片在 B站 上会被拆到两个分P（观众只看到一半），必须在选片阶段就避开。
       后处理（sanitizeClips）还有一道确定性兜底，但让它一开始就不选跨界的片段更好。 */
    const boundaries = [...new Set((opts.partBoundaries ?? []).filter((b) => Number.isFinite(b) && b > 1))]
      .filter((b) => opts.videoDuration <= 0 || b < opts.videoDuration - 1)
      .sort((a, b) => a - b);
    if (boundaries.length) {
      lines.push(`## 分P 边界（硬约束）`);
      lines.push(
        `本场直播被切成 ${boundaries.length + 1} 个分P 上传，分界点如下。` +
          `**片段的 start 与 end 必须落在同一个分P 内，绝对不能跨越这些分界点** —— ` +
          `跨越的切片在 B站 上会被拆到两个分P 里，观众只能看到一半。` +
          `如果你的候选素材横跨了分界点，请只取分界点**某一侧**的完整内容（宁可短一点）。`,
      );
      let prev = 0;
      for (let i = 0; i < boundaries.length; i++) {
        lines.push(`- 分P ${i + 1}：${fmtDuration(prev)} – ${fmtDuration(boundaries[i]!)}`);
        prev = boundaries[i]!;
      }
      lines.push(`- 分P ${boundaries.length + 1}：${fmtDuration(prev)} – ${fmtDuration(opts.videoDuration)}`);
      lines.push('');
    }
    lines.push(`## 弹幕信号摘要（全场）`);
    lines.push(renderSignalsSummary(signals));
    lines.push('');
    lines.push(`## 可选分区（白名单，写文字描述即可，不要写数字 ID）`);
    lines.push(Object.keys(this.cfg.publish.tidWhitelist).slice(0, 60).join('、'));
    return lines.join('\n');
  }

  /** 完整分析流程 */
  async analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
    const started = Date.now();
    const warnings: string[] = [];
    const timeline: AnalyzeResult['timeline'] = [];
    const log = this.logger.child({ taskId: opts.taskId, stage: 'ANALYZING' });

    // 硬约束 #14：dry-run 默认不得调用付费 LLM。
    // ★ 判断必须基于本次调用的 opts，而不是 cfg.runtime.allowPaid ——
    //   配置里 allowPaid=true 是「常驻服务允许付费」，不能替 `--dry-run` 破例。
    //   `--dry-run --allow-paid` 是显式许可，此时才允许付费。
    if (opts.dryRun && !opts.allowPaid) {
      const decision = this.degradedDecision(opts, 'dry-run 模式且未传 --allow-paid：不调用付费 LLM（硬约束 #14）', []);
      return {
        summary: '（dry-run：未调用 LLM）',
        decision,
        digests: [],
        warnings: ['dry-run 且未允许付费：跳过 LLM 分析，产出降级候选'],
        timeline: [{ at: nowIso(), step: 'LLM 分析', ok: false, detail: 'dry-run 跳过（硬约束 #14）' }],
        cost: { promptTokens: 0, completionTokens: 0, calls: 0, cost: 0 },
      };
    }

    /* ---- 1. 分块 map ---- */
    // 唱歌区段检测一次、复用（提示词与边界兜底都要用）
    const songRegions = detectSongRegions(opts.transcript.segments);
    const chunks = chunkTranscript(opts.transcript, this.cfg.llm.chunkMinutes, opts.videoDuration);
    log.info(`开始分析：${chunks.length} 个时间窗（每窗 ${this.cfg.llm.chunkMinutes} 分钟）`, {
      data: {
        summaryModel: this.llm.modelOf('summary'),
        selectModel: this.llm.modelOf('select'),
        escalationMeaningful: this.llm.isEscalationMeaningful(),
      },
    });
    opts.onProgress?.({ current: 0, total: chunks.length + 2, label: `分析中 0/${chunks.length}` });

    const { digests, warnings: digestWarnings } = await this.digestChunks(chunks, opts.signals, opts, timeline);
    warnings.push(...digestWarnings);
    opts.onProgress?.({ current: chunks.length, total: chunks.length + 2, label: `总结中` });

    /* ---- 2. reduce 全局总结 ---- */
    let summary = await this.reduceSummary(digests, warnings, timeline, opts);

    /* ---- 3. 选片 ---- */
    opts.onProgress?.({ current: chunks.length + 1, total: chunks.length + 2, label: `选片中` });
    const sel = await this.selectClips(digests, opts.signals, opts, timeline);

    if (!sel.output) {
      const reason = sel.failure
        ? `LLM 选片失败（${sel.failure.type}）：${sel.failure.message}`
        : 'LLM 选片未返回可用结果';
      warnings.push(`${reason} —— 已降级为「弹幕密度 Top-N 窗口」兜底`);
      const decision = this.degradedDecision(opts, reason, warnings);
      return {
        summary: summary ?? this.degradedSummary(reason),
        decision,
        digests,
        warnings,
        timeline,
        cost: this.takeCost(),
      };
    }

    /* ---- 4. 规范化 + 契约后处理 ---- */
    if (sel.escalationNote) warnings.push(sel.escalationNote);
    const clean = sanitizeClips(sel.output.clips, {
      videoDuration: opts.videoDuration,
      minDurationSec: this.cfg.clip.minDurationSec,
      maxDurationSec: this.cfg.clip.maxDurationSec,
      bufferSec: this.cfg.clip.bufferSec,
      maxClips: opts.maxClipsOverride ?? this.cfg.clip.maxCandidates,
      tidWhitelist: this.cfg.publish.tidWhitelist,
      defaultCategory: this.cfg.publish.defaultCategory,
      defaultTags: this.cfg.publish.defaultTags,
      tagSensitiveWords: this.cfg.publish.tagSensitiveWords,
      ...(opts.extraTags ? { extraTags: opts.extraTags } : {}),
      autoSelectScoreFloor: this.cfg.clip.autoSelectScoreFloor,
      autoSelectTopN: this.cfg.clip.autoSelectTopN,
      // 把转写传进去，让边界能吸附到自然断句点（否则 LLM 的近似秒数会切在句子/歌词中间）
      ...(opts.transcript.segments.length ? { transcriptSegments: opts.transcript.segments } : {}),
      maxSnapAheadSec: this.cfg.clip.boundarySnapAheadSec,
      // 能量边界修正：起点/终点落在"没人说话"的地方时，用音频能量拉回有人说话的位置
      boundarySpeechTrimSec: this.cfg.clip.boundarySpeechTrimSec,
      ...(opts.videoPath ? { videoPath: opts.videoPath } : {}),
      // 唱歌区段兜底：结尾落在歌里就顺延到歌结束
      ...(songRegions.length ? { songRegions } : {}),
      // 分P 边界兜底：跨界的切片会被拆到两个分P，观众只看到一半
      ...(opts.partBoundaries?.length ? { partBoundaries: opts.partBoundaries } : {}),
    });
    warnings.push(...clean.warnings);
    for (const d of clean.dropped) warnings.push(`候选 ${d.index} 被丢弃：${d.reason}`);

    if (clean.clips.length === 0) {
      warnings.push('所有候选切片都被后处理丢弃 —— 已降级为「弹幕密度 Top-N 窗口」兜底');
      const decision = this.degradedDecision(opts, '候选切片全部不合规', warnings);
      return { summary: summary ?? this.degradedSummary('候选切片全部不合规'), decision, digests, warnings, timeline, cost: this.takeCost() };
    }

    // LLM 给的 summary 优先；没有就用 reduce 的结果，再没有就用降级文案
    summary = (sel.output.summary?.trim() || summary || this.degradedSummary('LLM 未返回总结')).trim();

    const decision: ClipDecision = {
      taskId: opts.taskId,
      clips: clean.clips,
      degraded: false,
      modelUsed: this.llm.modelOf('select'),
      escalated: sel.escalated,
      ...(sel.escalationNote ? { escalationNote: sel.escalationNote } : {}),
      createdAt: nowIso(),
    };

    log.info(
      `分析完成：候选 ${clean.clips.length} 个（丢弃 ${clean.dropped.length}），默认勾选 ${clean.clips.filter((c) => c.selected).length} 个，` +
        `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s${sel.escalated ? '（发生过契约校验升级重跑）' : ''}`,
      { stage: 'ANALYZED' },
    );

    return { summary, decision, digests, warnings, timeline, cost: this.takeCost() };
  }

  private takeCost(): AnalyzeResult['cost'] {
    const t = this.llm.drainTotals();
    return { promptTokens: t.promptTokens, completionTokens: t.completionTokens, calls: t.calls, cost: t.cost };
  }

  /** 降级兜底：弹幕密度 Top-N 窗口 + 占位标题（§5.5） */
  private degradedDecision(opts: AnalyzeOptions, reason: string, warnings: string[]): ClipDecision {
    let fb = densityFallbackClips(opts.signals, {
      maxClips: opts.maxClipsOverride ?? this.cfg.clip.maxCandidates,
      minDurationSec: this.cfg.clip.minDurationSec,
      maxDurationSec: this.cfg.clip.maxDurationSec,
      bufferSec: this.cfg.clip.bufferSec,
    });
    let fbSource = '弹幕密度';

    // ★ 最后一层兜底：没有弹幕信号时（例如该场录制未抓弹幕），弹幕密度兜底会产出 0 个候选，
    //   链路表面上「成功」但实际没有任何可发布内容。此时用**转写语音密度**兜底 ——
    //   话说得密集的地方通常就是有内容的段落，虽然不如弹幕信号准，但比「零产出」有用得多。
    if (fb.length === 0) {
      const speech = speechDensityFallbackClips(opts.transcript, {
        maxClips: opts.maxClipsOverride ?? this.cfg.clip.maxCandidates,
        minDurationSec: this.cfg.clip.minDurationSec,
        maxDurationSec: this.cfg.clip.maxDurationSec,
        bufferSec: this.cfg.clip.bufferSec,
        windowSec: this.cfg.danmaku.densityWindowSec,
      });
      if (speech.length > 0) {
        fb = speech;
        fbSource = '转写语音密度';
        warnings.push(
          `弹幕信号不可用（${opts.signals.danmakuTotal} 条弹幕），已改用**转写语音密度**兜底选出 ${speech.length} 个候选`,
        );
      }
    }

    if (fb.length === 0) {
      warnings.push(
        '降级兜底也未能产出候选：既没有弹幕信号，转写内容也不足以定位高能片段。' +
          '请检查该场是否真的抓到了弹幕与语音（`data/tasks/<id>/signals.json` 与 `transcript.json`）',
      );
    }

    const clips: ClipRecord[] = fb.map((f, i) => ({
      index: i,
      start: f.start,
      end: f.end,
      // 占位标题：降级产出必须让人一眼看出需要人工填写（§8 WP7 降级态）
      title: `（待填写）${fmtDuration(f.start)} 高能片段`,
      desc: `该片段由${fbSource}降级选出（${f.reason}）。LLM 分析不可用，标题与简介需人工填写后再决定是否发布。`,
      tags: sanitizeTags(['降级产出', ...f.keywords.slice(0, 4)], { sensitive: this.cfg.publish.tagSensitiveWords }).tags,
      category: this.cfg.publish.defaultCategory,
      score: f.score,
      reason: `降级兜底（${fbSource}）：${f.reason}`,
      cover_ts: Number(((f.start + f.end) / 2).toFixed(1)),
      selected: false, // 降级产出默认不勾选，必须人工确认
      status: 'CANDIDATE',
      degraded: true,
      createdAt: nowIso(),
    }));
    warnings.push(`降级产出 ${clips.length} 个片段（来源：${fbSource}，标记 degraded=true，默认不勾选，标题需人工填写）`);
    this.logger.warn(`进入降级兜底（${fbSource}）：${reason}`, { data: { taskId: opts.taskId, clips: clips.length } });
    return {
      taskId: opts.taskId,
      clips,
      degraded: true,
      modelUsed: `degraded:${fbSource === '弹幕密度' ? 'density-fallback' : 'speech-fallback'}`,
      escalated: false,
      escalationNote: reason,
      createdAt: nowIso(),
    };
  }

  private degradedSummary(reason: string): string {
    return [
      '## 本场总结不可用（降级）',
      '',
      `内容分析未能完成：${reason}`,
      '',
      '切片候选由**弹幕密度 Top-N 窗口**降级选出，标题与简介需要人工填写后再决定是否发布。',
    ].join('\n');
  }
}

/* ============================================================================
 * 降级判断：连续失败阈值（§5.5）
 * ========================================================================== */

/**
 * 最后一层兜底：用**转写语音密度**选片段。
 *
 * 适用场景：弹幕信号不可用（该场未抓弹幕、或弹幕文件丢失）且 LLM 不可用。
 * 此时「弹幕密度 Top-N」会产出 0 个候选 —— 链路表面成功、实际无内容可发。
 *
 * 判据：话说得密集的地方通常就是有内容的段落（讲解、官宣、情绪输出）。
 * 比弹幕信号弱，但显著优于零产出。
 */
export function speechDensityFallbackClips(
  transcript: Transcript,
  opts: { maxClips: number; minDurationSec: number; maxDurationSec: number; bufferSec: number; windowSec?: number },
): Array<{ start: number; end: number; score: number; reason: string; keywords: string[] }> {
  const segs = transcript.segments.filter((s) => s.text.trim().length > 0);
  if (segs.length === 0) return [];

  const windowSec = Math.max(5, opts.windowSec ?? 10);
  const total = Math.max(...segs.map((s) => s.end), 0);
  if (total <= 0) return [];

  // 每个窗口内「说了多少字」（按时间占比折算，避免长句跨窗时被整段计入）
  const buckets = new Map<number, { chars: number; texts: string[] }>();
  for (const s of segs) {
    const from = Math.floor(s.start / windowSec);
    const to = Math.floor(s.end / windowSec);
    const span = Math.max(0.001, s.end - s.start);
    for (let b = from; b <= to; b++) {
      const winStart = b * windowSec;
      const winEnd = winStart + windowSec;
      const overlap = Math.min(s.end, winEnd) - Math.max(s.start, winStart);
      if (overlap <= 0) continue;
      const cur = buckets.get(b) ?? { chars: 0, texts: [] };
      cur.chars += (s.text.length * overlap) / span;
      if (s.text.length > 4) cur.texts.push(s.text);
      buckets.set(b, cur);
    }
  }
  if (buckets.size === 0) return [];

  const maxChars = Math.max(...[...buckets.values()].map((v) => v.chars));
  if (maxChars <= 0) return [];

  // 按字符数降序取候选窗口
  const ranked = [...buckets.entries()]
    .map(([b, v]) => ({ start: b * windowSec, chars: v.chars, texts: v.texts }))
    .sort((a, b) => b.chars - a.chars);

  const out: Array<{ start: number; end: number; score: number; reason: string; keywords: string[] }> = [];
  const dur = Math.min(opts.maxDurationSec, Math.max(opts.minDurationSec, 62));

  for (const r of ranked) {
    if (out.length >= opts.maxClips) break;
    const start = Math.max(0, r.start - opts.bufferSec);
    const end = Math.min(total, start + dur);
    if (end - start < opts.minDurationSec) continue;
    if (out.some((o) => start < o.end && end > o.start)) continue;

    // 从该窗口及其邻近窗口的文本里取几个短词做标签线索
    const near = ranked
      .filter((x) => Math.abs(x.start - r.start) <= windowSec * 6)
      .flatMap((x) => x.texts)
      .join(' ');
    const keywords = topNgrams(near, 5);

    const intensity = r.chars / maxChars;
    out.push({
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      // 换算到 0–10 分：语音密度最高的窗口给 6.5（低于默认勾选阈值 7，必须人工确认）
      score: Number((4 + intensity * 2.5).toFixed(1)),
      reason: `该 ${Math.round(dur)} 秒内语音密度为全场前 ${Math.max(1, Math.round((1 - intensity) * 100))}%（约 ${Math.round(r.chars)} 字/窗口）`,
      keywords,
    });
  }
  return out;
}

/** 极简 n-gram 词频（供语音兜底生成标签线索，不引入分词依赖） */
function topNgrams(text: string, topN: number): string[] {
  const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
  const counts = new Map<string, number>();
  const stop = new Set(['这个', '那个', '就是', '然后', '我们', '你们', '他们', '什么', '怎么', '因为', '所以', '可以', '没有', '这样', '那样', '一下', '一个', '不是', '还是']);
  for (const chunk of clean.split(/\s+/)) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= chunk.length; i++) {
        const g = chunk.slice(i, i + n);
        if (/^\d+$/.test(g)) continue;
        if (stop.has(g)) continue;
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, topN)
    .map(([w]) => w);
}

/**
 * 「完全不可用」的判定：**连续 3 次调用失败（含升级模型后的重试）且失败原因非契约校验**
 * （如网络、鉴权、限流）。单次失败不触发降级，先走升级模型重跑。
 */
export class FailureTracker {
  private consecutive = 0;
  private threshold: number;
  constructor(threshold: number) {
    this.threshold = Math.max(1, threshold);
  }
  /** 记一次失败，返回是否达到降级阈值 */
  fail(type: string): boolean {
    if (type === 'contract') {
      // 契约失败不算「不可用」，它有自己的升级重跑路径
      return false;
    }
    this.consecutive++;
    return this.consecutive >= this.threshold;
  }
  success(): void {
    this.consecutive = 0;
  }
  get count(): number {
    return this.consecutive;
  }
}

/* ============================================================================
 * 渲染辅助
 * ========================================================================== */

/** 把各块要点渲染成给 LLM 的文本（同时用于 reduce 与选片） */
export function renderDigestsForPrompt(digests: ChunkDigest[]): string {
  const lines: string[] = [];
  for (const d of digests) {
    lines.push(`### ${fmtDuration(d.start)} – ${fmtDuration(d.end)}`);
    if (d.topics.length) lines.push(`主题：${d.topics.join('；')}`);
    else lines.push('主题：（无）');
    if (d.highlights.length) {
      lines.push('亮点：');
      for (const h of d.highlights) {
        lines.push(`- ${fmtDuration(h.time)} ${h.what}${h.why ? ` —— ${h.why}` : ''}`);
      }
    }
    if (d.gapsNote) lines.push(`⚠️ ${d.gapsNote}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 全场弹幕信号摘要 */
export function renderSignalsSummary(signals: Signals): string {
  const lines: string[] = [];

  /* ★ 绝对量先摆出来，并判断这场的信号**哪些可信**。
     为什么必须给绝对量：`intensity` 是**相对归一化**的（最高窗口恒为 100%），
     实测见过"强度 100%"却只有 **4 条弹幕**的窗口 —— 拿它当"观众认为这里高能"的依据
     会误导选片。所以这里明确告诉模型：密度信号是否可用、什么信号更可靠。 */
  const segs = signals.peaks;
  const spanSec = segs.length ? Math.max(1, segs[segs.length - 1]!.end - segs[0]!.start) : 0;
  const perMinute = spanSec > 0 ? (signals.danmakuTotal / spanSec) * 60 : 0;
  /** 峰值窗口里最多有多少条 —— 判断"峰值"有没有实际区分度的关键指标 */
  const peakMax = signals.peaks.reduce((m, p) => Math.max(m, p.count), 0);
  /* ⚠️ 判断稀疏时**必须把高能事件算进去**：一场弹幕少但有 30 条 SC 的直播，
     观众的热情体现在"花钱"上而不是"刷屏"上，笼统说"弹幕稀疏、别信弹幕"会丢掉真信号。 */
  const energyTotal =
    (signals.eventCounts.superchat ?? 0) + (signals.eventCounts.guard ?? 0) + (signals.eventCounts.gift ?? 0);
  const sparse = signals.danmakuTotal > 0 && (perMinute < 12 || peakMax <= 6) && energyTotal === 0;
  const densityWeak = signals.danmakuTotal > 0 && (perMinute < 12 || peakMax <= 6);

  lines.push(
    `弹幕总数 ${signals.danmakuTotal}${spanSec > 0 ? `（约 ${perMinute.toFixed(1)} 条/分钟）` : ''}；` +
      `高能事件：SuperChat ${signals.eventCounts.superchat ?? 0}、` +
      `上舰 ${signals.eventCounts.guard ?? 0}、礼物 ${signals.eventCounts.gift ?? 0}` +
      (signals.eventSignalsAvailable ? '' : '（该录制不含这类事件，已降级为普通弹幕信号）'),
  );
  if (sparse) {
    lines.push(
      `⚠️ **本场弹幕偏稀疏**（最高密度窗口也只有 ${peakMax} 条，且无高能事件）。` +
        `下面的「强度」百分比是**全场相对值**，不代表观众真的在刷屏。` +
        `**不要把密度峰值当作"这里很精彩"的依据** —— ` +
        `请主要依据转写内容本身（话题完整度、情绪、笑点/信息量）来选片，弹幕只作很弱的参考。`,
    );
  } else if (densityWeak) {
    lines.push(
      `ℹ️ 本场**弹幕条数不多**（最高密度窗口 ${peakMax} 条），但**有 ${energyTotal} 个高能事件**（SC/上舰/礼物）——` +
        `这些事件是比刷屏更硬的信号：观众愿意为这里付费。密度峰值本身参考价值有限（"强度"是相对值）。`,
    );
  }

  const peak = signals.peaks[0];
  if (peak) {
    lines.push(
      `密度峰值出现在 ${fmtDuration(peak.start)}（${peak.count} 条/${Math.round(peak.end - peak.start)}秒，` +
        `相对强度 ${(peak.intensity * 100).toFixed(0)}%）`,
    );
  }
  /* 高能事件的时间点：这是本场最可靠的"观众用钱投票"信号，值得单独列出来 */
  if (energyTotal > 0 && signals.density.length) {
    const evWindows = signals.density
      .filter((d) => (d.highEnergy ?? 0) > 0)
      .sort((a, b) => (b.highEnergy ?? 0) - (a.highEnergy ?? 0))
      .slice(0, 12);
    if (evWindows.length) {
      lines.push(
        `高能事件时间点（**优先级最高的信号** —— 观众在此付费：SC/上舰/礼物）：` +
          evWindows.map((d) => `${fmtDuration(d.start)}(${d.highEnergy} 个)`).join('、'),
      );
    }
  }
  if (signals.peaks.length) {
    lines.push('密度 Top 窗口（括号内为**绝对条数**，注意绝对量）：');
    for (const p of signals.peaks.slice(0, 12)) {
      lines.push(
        `- ${fmtDuration(p.start)} – ${fmtDuration(p.end)}：${p.count} 条` +
          `${p.keywords.length ? `，热词 ${p.keywords.slice(0, 4).join('/')}` : ''}`,
      );
    }
  }
  if (signals.keywords.length) {
    /* 热词是这场景里更可靠的信号（实测：弹幕密度没区分度时，热词能反映真实话题） */
    lines.push(
      `全场高频词（**比密度更可靠**，能反映观众真正在聊什么）：` +
        `${signals.keywords.slice(0, 20).map((k) => `${k.word}(${k.count})`).join('、')}`,
    );
  }
  return lines.join('\n');
}

/** 写出 summary.md 与 clips.json（任务目录内） */
export function persistAnalysis(
  dir: string,
  result: Pick<AnalyzeResult, 'summary' | 'decision' | 'digests' | 'warnings'>,
): { summaryPath: string; clipsPath: string } {
  const summaryPath = path.join(dir, 'summary.md');
  const clipsPath = path.join(dir, 'clips.json');
  const header = [
    `<!-- 由 live_auto 生成于 ${nowIso()} -->`,
    result.decision.degraded
      ? `> ⚠️ **本场为降级产出**：${result.decision.escalationNote ?? 'LLM 不可用'}`
      : '',
    result.decision.escalated ? `> ℹ️ 选片经历过契约校验失败后的升级重跑：${result.decision.escalationNote ?? ''}` : '',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  fs.writeFileSync(summaryPath, `${header}\n${result.summary}\n`, 'utf8');
  writeJsonAtomic(clipsPath, {
    taskId: result.decision.taskId,
    degraded: result.decision.degraded,
    modelUsed: result.decision.modelUsed,
    escalated: result.decision.escalated,
    escalationNote: result.decision.escalationNote,
    warnings: result.warnings,
    digests: result.digests,
    clips: result.decision.clips,
    createdAt: result.decision.createdAt,
  });
  return { summaryPath, clipsPath };
}

/** 生成 .llc 项目文件内容（§4.7）—— 供人工在 biliLive-tools 切片界面精修 */
export function buildLlcContent(
  videoFileName: string,
  clips: Array<{ start: number; end: number; title: string }>,
  subtitles?: Array<{ index: number; content: string }>,
): { version: 1; mediaFileName: string; subtitles?: Array<{ index: number; content: string }>; cutSegments: Array<{ start: number; end: number; name: string; tags: Record<string, string> }> } {
  const out: {
    version: 1;
    mediaFileName: string;
    subtitles?: Array<{ index: number; content: string }>;
    cutSegments: Array<{ start: number; end: number; name: string; tags: Record<string, string> }>;
  } = {
    version: 1,
    mediaFileName: path.basename(videoFileName),
    cutSegments: clips.map((c) => ({
      start: Number(c.start.toFixed(2)),
      end: Number(c.end.toFixed(2)),
      name: safeFileName(c.title, 80),
      tags: {},
    })),
  };
  if (subtitles?.length) out.subtitles = subtitles;
  return out;
}

/** 供 UI 展示的转写预览（前 N 条） */
export function transcriptPreview(transcript: Transcript, limit = 40): Array<{ time: string; text: string }> {
  return transcript.segments.slice(0, limit).map((s) => ({ time: fmtDuration(s.start), text: s.text }));
}
