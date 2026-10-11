/**
 * 预转写的"一轮"逻辑（2026-10-14，优化清单 P1-6 的 B 步）。
 *
 * 定位：`src/pre-transcribe.ts` 负责"这一场的分段怎么转"，本文件负责
 * **"哪些场次现在值得转一轮、怎么把结果存下来"**；定时器本身留在守护进程里
 * （那里已有成熟的 `xxxTick + setTimeout + unref` 模式，不在这里另造一套）。
 *
 * 与既有代码的口径关系（这条最重要）：
 *   · "哪些分段已闭合"**不在这里判断** —— 由调用方的 `discoverSegments` 用
 *     `discoverRecordingFiles(..., { skipFreshWithinSec: RECORDING_WINDOW_SEC })` 决定，
 *     与正式导入**同一个常量、同一个函数**（daemon.ts L3181-3184 明确要求过：
 *     半场数据会让任务总时长、切点、全局时间轴全错）；
 *   · "哪些场次还在录"也由调用方从 `watcher.status().lastOutcomes` 挑（`possiblyRecording`
 *     / `pendingParts`），本文件不重新定义"还在录"。
 *
 * 所以本文件只做三件事：**门控、遍历、持久化**。全部依赖注入 ⇒ 可测。
 */
import type { MediaSegment } from './media-plan.ts';
import { runPreTranscribe, type PreTranscribeResult } from './pre-transcribe.ts';

export interface RecordingCandidateLite {
  videoPath: string;
  title?: string;
  pendingParts?: number;
  possiblyRecording?: boolean;
}

export interface PreTranscribeTickDeps {
  /** 配置门控：false ⇒ **一轮都不跑**（不遍历、不调 discover、不写盘） */
  enabled: boolean;
  /** 列出"可能还在录"的候选（调用方从 watcher.status() 里挑） */
  recordingCandidates: () => RecordingCandidateLite[];
  /** 把候选解析成"已闭合的分段"（调用方复用 discoverRecordingFiles + buildSegmentMap） */
  discoverSegments: (videoPath: string) => MediaSegment[];
  transcribe: (seg: MediaSegment) => Promise<{ cues: number; coveredSec: number }>;
  statOf: (p: string) => { mtimeMs: number } | undefined;
  /** 读该场已做过的分段（避免重复转写）；返回 undefined 表示没做过 */
  loadDone: (videoPath: string) => number[] | undefined;
  /** 保存结果（调用方决定落盘位置） */
  saveState: (videoPath: string, r: PreTranscribeResult) => void;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** "已闭合"的时间判据（默认：当前时刻 − RECORDING_WINDOW_SEC） */
  closedBeforeMs?: () => number;
}

export interface PreTranscribeTickSummary {
  /** 这一轮看了几个候选 */
  scanned: number;
  /** 其中真的做了转写的场次数 */
  worked: number;
  /** 已可合并（全部分段就绪）的场次数 */
  ready: number;
  /** 给人看的说明（进日志） */
  notes: string[];
}

/**
 * 跑一轮。**不抛错**（单场失败记进 notes，不影响其它场、更不影响录制/导入）。
 */
export async function runPreTranscribeTick(deps: PreTranscribeTickDeps): Promise<PreTranscribeTickSummary> {
  const summary: PreTranscribeTickSummary = { scanned: 0, worked: 0, ready: 0, notes: [] };

  /* 门控在最前面：关闭时**什么也不做**（连候选都不列）—— 这条要能被断言看到 */
  if (!deps.enabled) return summary;

  let candidates: RecordingCandidateLite[] = [];
  try {
    candidates = deps.recordingCandidates();
  } catch (e) {
    summary.notes.push(`取候选失败：${(e as Error).message}`);
    return summary;
  }

  const closedBefore = deps.closedBeforeMs ? deps.closedBeforeMs() : Date.now() - 120_000;

  for (const c of candidates) {
    summary.scanned++;
    try {
      const segments = deps.discoverSegments(c.videoPath);
      if (segments.length === 0) {
        summary.notes.push(`${c.title ?? c.videoPath}：目前没有已闭合的分段`);
        continue;
      }
      const r = await runPreTranscribe({
        taskId: c.videoPath,
        segments,
        enabled: true, // 已过外层门控
        closedBeforeMs: closedBefore,
        statOf: deps.statOf,
        transcribe: deps.transcribe,
        ...(deps.loadDone(c.videoPath) ? { alreadyDone: deps.loadDone(c.videoPath) as number[] } : {}),
      });
      if (r.didWork) {
        try {
          deps.saveState(c.videoPath, r);
        } catch (e) {
          summary.notes.push(`${c.title ?? c.videoPath}：状态保存失败（不影响转写结果）：${(e as Error).message}`);
        }
        summary.worked++;
        if (r.readyToMerge) summary.ready++;
        const skipped = r.attempts.filter((a) => !a.ok && /仍在写入/.test(a.reason)).length;
        summary.notes.push(
          `${c.title ?? c.videoPath}：已转 ${r.progress.done}/${r.progress.total} 段` +
            (skipped ? `（${skipped} 段仍在写）` : '') +
            (r.readyToMerge ? ' —— 已可合并' : '') +
            (r.state.mode === 'fallback' ? ` —— 已回退整段路径：${r.state.fallbackReason ?? ''}` : ''),
        );
      }
    } catch (e) {
      summary.notes.push(`${c.title ?? c.videoPath}：本轮出错（已跳过）：${(e as Error).message}`);
    }
  }

  return summary;
}
