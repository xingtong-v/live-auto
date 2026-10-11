/**
 * 边录边转写的状态机（2026-10-13，优化清单 P1-6 的第一步）。
 *
 * 目标：录制期间**分段闭合就立即转写**，录完时只剩最后一段要跑 —— 把端到端从"录完 +17 分钟"
 * 压到"录完即出"（实测"等开始转写"占 573–3691 秒，比转写本身 133–145 秒长得多）。
 *
 * 为什么先写这一层：它要动录制监听与任务状态机（主链），而**可行性只证明了质量**
 * （分段 vs 整段：字幕条数差 0.06%、覆盖时长差 0.01%、边界时间戳连续 1769.15 → 1770.12）。
 * 所以先把"推进 / 合并 / 回退"三条性质钉成纯函数 —— 接入主链时出错，有断言兜着。
 *
 * 设计原则（刻意的保守）：
 *   1. **纯函数**：所有转移都返回新状态、不改入参（调用方能放心把它丢进日志/台账）；
 *   2. **一票回退**：任何一段失败 ⇒ 整场切 fallback（回退到"录完整段转写"的老路径），
 *      不做"部分成功就用部分"的聪明事 —— 半截转写会让切片边界与字幕错位，代价远大于重跑；
 *   3. 回退是**终态**：一旦 fallback，后续的成功/失败都不再改变它（避免"回退到一半又切回来"）。
 */
import type { MediaSegment } from './media-plan.ts';

export type SegmentStatus = 'pending' | 'transcribing' | 'done' | 'failed';

export interface SegmentState {
  path: string;
  globalStart: number;
  globalEnd: number;
  status: SegmentStatus;
  /** 该段转写完成后的统计（便于进度上报与事后核对） */
  cues?: number;
  coveredSec?: number;
  /** 失败原因（进日志与台账 note） */
  error?: string;
}

export interface IncrementalState {
  taskId: string;
  /** incremental = 正在走分段路径；fallback = 已回退整段路径（终态） */
  mode: 'incremental' | 'fallback';
  /** 回退原因（mode=fallback 时有值） */
  fallbackReason?: string;
  segments: SegmentState[];
}

/** 初始状态：全部分段 pending，走分段路径 */
export function planIncremental(taskId: string, segments: MediaSegment[]): IncrementalState {
  return {
    taskId,
    mode: 'incremental',
    segments: segments.map((s) => ({
      path: s.path,
      globalStart: s.globalStart,
      globalEnd: s.globalEnd,
      status: 'pending',
    })),
  };
}

/** 标记某段开始转写（进度展示用；失败/回退语义不受它影响） */
export function markSegmentTranscribing(state: IncrementalState, index: number): IncrementalState {
  if (state.mode === 'fallback') return state;
  const seg = state.segments[index];
  if (!seg || seg.status === 'done') return state;
  return replaceSegment(state, index, { ...seg, status: 'transcribing' });
}

/** 某段转写完成 */
export function markSegmentDone(
  state: IncrementalState,
  index: number,
  stats: { cues: number; coveredSec: number },
): IncrementalState {
  if (state.mode === 'fallback') return state;
  const seg = state.segments[index];
  if (!seg) return state;
  return replaceSegment(state, index, {
    ...seg,
    status: 'done',
    cues: stats.cues,
    coveredSec: Number(stats.coveredSec.toFixed(1)),
  });
}

/**
 * 某段失败 ⇒ **整场回退**（终态）。
 * 刻意不保留"已成功的段"：半截转写会让切片边界与字幕错位，重跑整段（有缓存，很便宜）更靠谱。
 */
export function markSegmentFailed(state: IncrementalState, index: number, reason: string): IncrementalState {
  if (state.mode === 'fallback') return state;
  const seg = state.segments[index];
  const next = seg ? replaceSegment(state, index, { ...seg, status: 'failed', error: reason }) : state;
  return { ...next, mode: 'fallback', fallbackReason: `分段 #${index} 转写失败：${reason}` };
}

/** 全部段落完成 ⇒ 可以合并成整段等价的结果 */
export function readyToMerge(state: IncrementalState): boolean {
  return state.mode === 'incremental' && state.segments.length > 0 && state.segments.every((s) => s.status === 'done');
}

/** 还剩几段没完成（进度上报：`已转写 x/y 段`） */
export function progress(state: IncrementalState): { done: number; total: number; remaining: number } {
  const total = state.segments.length;
  const done = state.segments.filter((s) => s.status === 'done').length;
  return { done, total, remaining: total - done };
}

/**
 * 合并阶段的输入决策（给调用方用，本身不执行转写）：
 *   · 全 done ⇒ 用分段结果按 offset 拼；
 *   · 否则 ⇒ 回退：给出 MediaSegment[] 让调用方走**现有整段路径**。
 */
export function mergePlan(state: IncrementalState): { mode: 'segments'; segments: MediaSegment[] } | { mode: 'fallback'; reason: string } {
  if (readyToMerge(state)) {
    return {
      mode: 'segments',
      segments: state.segments.map((s) => ({ path: s.path, globalStart: s.globalStart, globalEnd: s.globalEnd })),
    };
  }
  return { mode: 'fallback', reason: state.fallbackReason ?? '分段尚未全部完成（或已回退）' };
}

/** 不可变替换（纯函数的实现细节；刻意不碰入参对象） */
function replaceSegment(state: IncrementalState, index: number, seg: SegmentState): IncrementalState {
  const segments = state.segments.map((s, i) => (i === index ? seg : s));
  return { ...state, segments };
}
