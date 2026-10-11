/**
 * 录制期间的分段预转写（2026-10-14，优化清单 P1-6 的 A 步）。
 *
 * 目标：录制进行中，把**已经闭合的分段**先转掉，录完时只剩最后一段要跑 ——
 * 把端到端从"录完 +17 分钟"压到"录完即出"（实测"等开始转写"占 573–3691 秒，比转写本身 133–145 秒长得多）。
 *
 * 本模块的边界（刻意划清）：
 *   · **只读录像**：不写、不改、不删任何媒体文件；
 *   · **不做持久化**：状态由调用方保存/读取（这样本模块完全可测，也便于回退）；
 *   · **不做调度**：什么时候跑由调用方决定（守护进程的轮询循环）；本模块只回答"这一轮能转哪些、结果如何"；
 *   · **转写器注入**：真实现走 `Transcriber`（与整段路径**同一套**缓存键，见 media-plan），测试用假实现。
 *
 * 状态推进复用 `src/incremental-asr.ts`（已 23 项断言）：**任何一段失败 ⇒ 整场回退**，
 * 且回退是终态 —— 半截转写会让切片边界与字幕错位，重跑整段（有缓存，很便宜）更靠谱。
 */
import type { MediaSegment } from './media-plan.ts';
import { markSegmentDone, markSegmentFailed, planIncremental, progress, readyToMerge, type IncrementalState } from './incremental-asr.ts';

/* ===================== C 步：把分段结果合并成整段等价的字幕（2026-10-14） ===================== */

/** 与 ASR 的 cue 形状对齐（只取合并需要的字段，避免耦合） */
export interface CueLike {
  start: number;
  end: number;
  text?: string;
}

export interface MergedTranscript {
  cues: Array<CueLike & { start: number; end: number }>;
  /** 是否真的用了分段结果（false = 调用方应走整段路径） */
  used: boolean;
  reason: string;
  /** 覆盖时长（用于与整段结果对照） */
  coveredSec: number;
}

/**
 * 合并分段字幕到**全局时间轴**。
 *
 * 为什么这样设计（重要）：
 *   · 分段的 cue 时间戳是**段内相对**的（每段从 0 开始），必须加上 `globalStart` 才是全局时间；
 *   · 分段**不需要另存 cue** —— 它们本来就在 ASR 缓存里（按 media+range 键控），
 *     消费时"按同样的分段再调一次转写"会**命中缓存**（秒回），因此这里只负责**平移与拼接**；
 *   · `state.mode === 'fallback'` 或分段不全 ⇒ `used=false`，调用方照旧走整段路径（**绝不半截出片**）。
 *
 * @param segments  本场分段（顺序即时间顺序；调用方保证与预转写时**同一批**）
 * @param perSeg    每段的 cue（下标与 segments 对齐；缺失的段视为未转写）
 */
export function mergeSegmentedTranscript(
  segments: MediaSegment[],
  perSeg: Array<CueLike[] | undefined>,
  state: IncrementalState,
): MergedTranscript {
  if (state.mode === 'fallback') {
    return { cues: [], used: false, reason: `已回退整段路径：${state.fallbackReason ?? '（未说明）'}`, coveredSec: 0 };
  }
  if (segments.length === 0) {
    return { cues: [], used: false, reason: '没有分段', coveredSec: 0 };
  }
  const missing = segments.map((_, i) => i).filter((i) => !perSeg[i] || perSeg[i]!.length === 0);
  if (missing.length > 0) {
    return { cues: [], used: false, reason: `还有 ${missing.length} 段没有字幕（#${missing.slice(0, 3).join('、#')}）`, coveredSec: 0 };
  }

  const cues: Array<CueLike & { start: number; end: number }> = [];
  for (let i = 0; i < segments.length; i++) {
    const off = segments[i]!.globalStart;
    for (const c of perSeg[i]!) {
      cues.push({ ...c, start: Number((c.start + off).toFixed(3)), end: Number((c.end + off).toFixed(3)) });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  const covered = cues.reduce((a, c) => a + Math.max(0, c.end - c.start), 0);
  /* 边界自检：合并后必须**单调**（分段顺序错/时间轴错会立刻暴露出来，而不是等到切片错位） */
  for (let i = 1; i < cues.length; i++) {
    if (cues[i]!.start < cues[i - 1]!.start) {
      return { cues: [], used: false, reason: `合并后时间轴非单调（第 ${i} 条），拒绝使用分段结果`, coveredSec: 0 };
    }
  }
  return { cues, used: true, reason: `用 ${segments.length} 段拼成 ${cues.length} 条字幕`, coveredSec: Math.round(covered) };
}

/* ===================== C 步：转写阶段消费分段结果（2026-10-14） ===================== */

export interface UsePreTranscribedDeps {
  /** 配置门控（false ⇒ 不读任何文件） */
  enabled: boolean;
  /** 状态文件路径（录像同目录的 .pre-transcribe.json） */
  stateFile: string;
  /** 本场分段（必须与预转写时同一批：都来自 discoverRecordingFiles + buildSegmentMap） */
  segments: MediaSegment[];
  /** 逐段取字幕（真实现会命中 ASR 缓存 ⇒ 秒回；注入以便测试） */
  transcribeSeg: (seg: MediaSegment) => Promise<CueLike[]>;
  log?: (msg: string, level?: 'debug' | 'info' | 'warn') => void;
  /** 读状态文件（注入以便测试；默认 fs 读） */
  readState?: (file: string) => { done?: number[]; mode?: string } | undefined;
}

/**
 * 尝试用"录制期间的分段预转写"替代整段转写。
 *
 * 返回 undefined = **走整段路径**（调用方原样继续），并已写清原因：
 *   未开启 / 没有状态文件 / 已回退 / 分段没全就绪 / 逐段取字幕失败 / 合并被拒 / 任何异常。
 *
 * 只有"全部分段就绪且非回退"才会返回结果 —— 因为调用方下一行就是
 * 「转写为空 ⇒ 直接失败」的判定，绝不能让它拿到空转写。
 */
export async function usePreTranscribed(
  deps: UsePreTranscribedDeps,
): Promise<{ cues: CueLike[]; coveredSec: number; reason: string } | undefined> {
  const say = (m: string, lv: 'debug' | 'info' | 'warn' = 'debug'): void => deps.log?.(m, lv);
  if (!deps.enabled) return undefined; // 默认关 ⇒ 连文件都不读

  const read = deps.readState ?? defaultReadState;
  const st = read(deps.stateFile);
  if (!st) {
    say('预转写：没有状态文件 ⇒ 走整段转写');
    return undefined;
  }
  if (st.mode === 'fallback') {
    say('预转写：该场已回退整段路径 ⇒ 走整段转写', 'info');
    return undefined;
  }
  if (deps.segments.length === 0) {
    say('预转写：本场没有分段 ⇒ 走整段转写');
    return undefined;
  }
  const done = new Set<number>(Array.isArray(st.done) ? st.done : []);
  const missing = deps.segments.map((_, i) => i).filter((i) => !done.has(i));
  if (missing.length > 0) {
    say(`预转写：只完成 ${deps.segments.length - missing.length}/${deps.segments.length} 段 ⇒ 走整段转写`, 'info');
    return undefined;
  }

  try {
    const per: Array<CueLike[] | undefined> = [];
    for (const seg of deps.segments) per.push(await deps.transcribeSeg(seg));
    /* 状态由"全就绪"这一事实构造（此刻 done 覆盖全部段） */
    const state: IncrementalState = {
      taskId: 'pre',
      mode: 'incremental',
      segments: deps.segments.map((s) => ({ path: s.path, globalStart: s.globalStart, globalEnd: s.globalEnd, status: 'done' as const })),
    };
    const merged = mergeSegmentedTranscript(deps.segments, per, state);
    if (!merged.used) {
      say(`预转写：合并被拒（${merged.reason}）⇒ 走整段转写`, 'warn');
      return undefined;
    }
    say(`预转写命中：${merged.reason}（按分段取字幕走的是 ASR 缓存，不重复计费）`, 'info');
    return { cues: merged.cues, coveredSec: merged.coveredSec, reason: merged.reason };
  } catch (e) {
    say(`预转写：使用失败（${(e as Error).message}）⇒ 走整段转写`, 'warn');
    return undefined;
  }
}

function defaultReadState(file: string): { done?: number[]; mode?: string } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { done?: number[]; mode?: string };
  } catch {
    return undefined;
  }
}

export interface PreTranscribeDeps {
  taskId: string;
  /** 本场的分段（由调用方从录像目录扫描得到；只读） */
  segments: MediaSegment[];
  /** 配置门控：false ⇒ **完全不做事**（连 stat 都不调） */
  enabled: boolean;
  /** "已闭合"的判据：分段末次修改早于此刻才算写完（调用方传 Date.now() 或更保守的值） */
  closedBeforeMs: number;
  /** 取文件信息（注入以便测试；真实现用 fs.statSync） */
  statOf: (path: string) => { mtimeMs: number } | undefined;
  /** 转写一个分段（注入；真实现会带上与整段一致的缓存键） */
  transcribe: (seg: MediaSegment) => Promise<{ cues: number; coveredSec: number }>;
  /** 已经做过的分段（调用方从持久化状态里恢复；避免重复转写） */
  alreadyDone?: number[];
}

export interface PreTranscribeAttempt {
  index: number;
  ok: boolean;
  reason: string;
}

export interface PreTranscribeResult {
  state: IncrementalState;
  attempts: PreTranscribeAttempt[];
  /** 这一轮是否真的做了事（用于日志与"要不要保存状态"的判断） */
  didWork: boolean;
  progress: { done: number; total: number; remaining: number };
  readyToMerge: boolean;
}

/**
 * 跑一轮预转写。**不抛错**（失败体现在 state.mode='fallback' 与 attempts 里）。
 */
export async function runPreTranscribe(deps: PreTranscribeDeps): Promise<PreTranscribeResult> {
  let state = planIncremental(deps.taskId, deps.segments);
  const attempts: PreTranscribeAttempt[] = [];

  /* 配置关闭 ⇒ 完全不做事（不 stat、不转写）—— 这条要能被断言看到 */
  if (!deps.enabled) {
    return { state, attempts, didWork: false, progress: progress(state), readyToMerge: false };
  }

  /* 恢复"已做过"的分段（调用方从持久化状态给），避免重复转写 */
  for (const i of deps.alreadyDone ?? []) {
    state = markSegmentDone(state, i, { cues: 0, coveredSec: 0 });
  }

  let didWork = false;
  for (let i = 0; i < deps.segments.length; i++) {
    const seg = deps.segments[i]!;
    if (state.mode === 'fallback') break; // 已回退：本轮不再尝试（终态）
    if (state.segments[i]?.status === 'done') continue;

    /* 还在写的分段不能转：录到一半的素材会得到残缺转写（与 watch-import 的 isStable 同一判据） */
    const st = deps.statOf(seg.path);
    if (!st) {
      attempts.push({ index: i, ok: false, reason: '取不到文件信息（可能已被移走）' });
      continue;
    }
    if (st.mtimeMs > deps.closedBeforeMs) {
      attempts.push({ index: i, ok: false, reason: '仍在写入（等它闭合后再转）' });
      continue;
    }

    try {
      const r = await deps.transcribe(seg);
      state = markSegmentDone(state, i, { cues: r.cues, coveredSec: r.coveredSec });
      attempts.push({ index: i, ok: true, reason: `已转写（${r.cues} 条字幕）` });
      didWork = true;
    } catch (e) {
      const why = (e as Error).message;
      state = markSegmentFailed(state, i, why);
      attempts.push({ index: i, ok: false, reason: `转写失败：${why}` });
      didWork = true;
    }
  }

  return { state, attempts, didWork, progress: progress(state), readyToMerge: readyToMerge(state) };
}
