/**
 * 转写"调用单元"规划（2026-10-11，ASR 独立进程的第一步）。
 *
 * 背景：`Transcriber.transcribe()` 收的 `media` 是**带闭包的对象**（`planCalls` 是函数），
 * 没法直接走 IPC。但读了 `src/daemon.ts:2176-2210` 之后确认：那个闭包是
 * `inputSegments` 的**纯函数** —— 只做"把全局区间按分段边界切开"，不捕获任何运行时状态。
 *
 * 所以把这段逻辑原样抽到这里，好处有两个：
 *   ① ASR 阶段可以整体搬进独立进程（`inputSegments` 天然可 JSON 序列化，worker 侧用同一份逻辑重建）；
 *   ② 规划逻辑可被单元测试直接覆盖（以前它埋在守护进程 3000 行里，测不到）。
 *
 * ⚠️ 这段逻辑的语义是**实测结论**，不要随手改：
 *   · `offset` 恒为 0 —— 见 `asr.ts` 的 WindowCall 注释：全局时间 = 段内时间 + globalStart；
 *   · 区间与分段的重叠 ≤0.5 秒直接跳过（避免为一条缝生成一个转写进程）；
 *   · 全部切不出单元时（ffprobe 不可用 ⇒ 所有分段 duration 为 0）**退化为整文件一次**，
 *     宁可慢也不要静默产出空转写 —— 失败会在 gaps 里显式体现。
 */

export interface MediaSegment {
  path: string;
  globalStart: number;
  globalEnd: number;
  size?: number;
}

export interface WindowCall {
  file: string;
  inFileStart: number;
  inFileEnd: number;
  globalStart: number;
  globalEnd: number;
  offset: number;
  windowIndex: number;
}

export interface MediaPlan {
  calls: WindowCall[];
  /** true = 走了"整文件一次"的兜底（调用方需要记一条 warn，这里不负责打日志） */
  fallback: boolean;
  /** 兜底时被选中的那个分段（用于日志） */
  fallbackSegment?: MediaSegment;
}

/** 把「全局区间」按分段边界切成若干转写调用单元（纯函数，可序列化输入/输出） */
export function planSegmentCalls(segments: MediaSegment[], range: { start: number; end: number }): MediaPlan {
  const calls: WindowCall[] = [];
  for (const seg of segments) {
    const s = Math.max(range.start, seg.globalStart);
    const e = Math.min(range.end, seg.globalEnd);
    if (e - s <= 0.5) continue;
    calls.push({
      file: seg.path,
      inFileStart: Number((s - seg.globalStart).toFixed(3)),
      inFileEnd: Number((e - seg.globalStart).toFixed(3)),
      globalStart: Number(s.toFixed(3)),
      globalEnd: Number(e.toFixed(3)),
      offset: 0,
      windowIndex: 0,
    });
  }
  if (calls.length === 0 && segments.length > 0) {
    const fallback = segments[0]!;
    /* ★★ 2026-10-15 修（真机数据丢失事故）：兜底单元必须**保留区间在全局时间轴上的位置**。
     *
     * 原来写的是 `globalStart: 0, globalEnd: range.end - range.start` —— 拿"区间长度"当全局区间。
     * 对"从 0 开始的单窗口"恰好等价，**对后面的窗口就是错的**：第 2 个窗口（1800–3537）会自称
     * "全局 0–1737"，于是两件坏事同时发生：
     *   ① 它的时间戳与第 1 个窗口重叠（字幕会串到前面去）；
     *   ② 它在 `mergeWindowsPerFile` 里被**并进第一块**（1737 − 0 ≤ 块长上限 1800）——
     *      实测现场（`auto-20261015135916-6rh9`，58:58 的录播）：只转写出前 30 分钟，
     *      后 29 分钟**整段丢失**，而日志只说"把 2 个窗口合并为 1 块"，完全看不出丢了东西。
     *
     * 触发条件很具体：该场 `source.segments[0]` 的 `globalEnd = 0`（导入时文件还在写、探测不到时长），
     * 于是每个窗口都求交为空 ⇒ 走兜底。兜底的前提本来就是"这个文件承载了从 0 开始的整条时间轴"，
     * 所以段内时间 = 全局时间，直接照抄区间即可。
     */
    const gStart = Number(Math.max(0, range.start).toFixed(3));
    const gEnd = Number(Math.max(range.end, gStart + 1).toFixed(3));
    return {
      calls: [
        {
          file: fallback.path,
          inFileStart: gStart,
          /* 至少 1 秒：0 会让下游认为"这段音频是空的"，从而静默产出空转写（正是要避免的事）。 */
          inFileEnd: gEnd,
          globalStart: gStart,
          globalEnd: gEnd,
          offset: 0,
          windowIndex: 0,
        },
      ],
      fallback: true,
      fallbackSegment: fallback,
    };
  }
  return { calls, fallback: false };
}

/**
 * 转写所需的 `media` 适配器（与 `Transcriber` 的入参形状一致）。
 * 注意：返回的对象含函数 ⇒ **不能**直接送进 IPC；跨进程时传 `segments` 本身，
 * worker 侧再调这个函数重建（两边跑的是同一份代码，避免行为漂移）。
 */
export function buildMediaAdapter(segments: MediaSegment[]): {
  planCalls: (range: { start: number; end: number }) => WindowCall[];
  fileStat: (f: string) => { size: number; updatedAt: number };
} {
  return {
    planCalls: (range) => planSegmentCalls(segments, range).calls,
    fileStat: (f: string) => {
      // 这里刻意不 import fs：保持纯函数、可被 worker 与测试复用（调用方传入的 fs 由 Transcriber 处理）
      const st = statSyncSafe(f);
      return { size: st.size, updatedAt: st.updatedAt };
    },
  };
}

/* 单独抽出来便于测试替换；真实实现就是 fs.statSync（保留 mtime 语义：录制还在写时 mtime 会变） */
import fs from 'node:fs';
function statSyncSafe(f: string): { size: number; updatedAt: number } {
  try {
    const st = fs.statSync(f);
    return { size: st.size, updatedAt: Math.round(st.mtimeMs) };
  } catch {
    /* 与原实现一致：读不到就报 -1/0（缓存据此认为"文件不可用"），不要抛 */
    return { size: -1, updatedAt: 0 };
  }
}
