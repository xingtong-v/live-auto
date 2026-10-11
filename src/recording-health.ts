/**
 * 录制质量体检（2026-10-14，优化清单 P2 第一件）。
 *
 * 背景（用户报过、也修过）：某场直播"几分钟就中断一次录制"，一天下来碎片文件几十个
 * （实测 25–330 MB 不等）。后来的修复是把碎片合并成一场，但**没人能提前看出异常** ——
 * 往往等切片/分P 出问题才发现。所以这里把"碎片程度"量化，异常就进待办。
 *
 * 判据（都来自实测与既有约定）：
 *   · **碎片**：相邻分段之间的空隙很小（< 合并阈值的一部分）说明录制被中断后又续上；
 *   · **长空档**：相邻分段之间有很长的空隙 ⇒ 可能真的停播过，或录制器夜里挂了；
 *   · 只有**多段**才谈碎片（单段录制天然正常）。
 *
 * 纯函数、只读：不做任何清理或修复动作，只回一句人话（给待办与日志用）。
 */
import type { MediaSegment } from './media-plan.ts';

/** 小于这个空隙视为"被中断后马上续上"（碎片迹象） */
const FRAGMENT_GAP_SEC = 90;
/** 大于这个空隙视为"长空档"（可能停播或录制器掉线） */
const LONG_GAP_SEC = 15 * 60;

export interface RecordingHealth {
  segments: number;
  totalSec: number;
  /** 碎片边界数（空隙 < 90 秒的相邻段） */
  fragmentBoundaries: number;
  /** 最长空档（秒） */
  longestGapSec: number;
  /** 分级：ok = 正常；fragmented = 碎片多；gap = 有长空档 */
  level: 'ok' | 'fragmented' | 'gap';
  /** 给待办/日志用的一句话 */
  note: string;
}

export function analyzeRecording(segments: MediaSegment[]): RecordingHealth {
  const sorted = [...segments].sort((a, b) => a.globalStart - b.globalStart);
  const totalSec = sorted.reduce((a, s) => a + Math.max(0, s.globalEnd - s.globalStart), 0);
  let fragmentBoundaries = 0;
  let longestGapSec = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const gap = Math.max(0, cur.globalStart - prev.globalEnd);
    if (gap > longestGapSec) longestGapSec = gap;
    if (gap < FRAGMENT_GAP_SEC) fragmentBoundaries++;
  }
  const mins = (s: number): string => `${Math.round(s / 60)} 分钟`;

  if (longestGapSec >= LONG_GAP_SEC) {
    return {
      segments: sorted.length,
      totalSec,
      fragmentBoundaries,
      longestGapSec,
      level: 'gap',
      note: `录制有 ${mins(longestGapSec)} 的空档（共 ${sorted.length} 段）—— 可能是中途停播，或录制器掉线后重连；若那段时间本该在播，建议查一下录制器日志。`,
    };
  }
  if (sorted.length > 1 && fragmentBoundaries >= 2) {
    return {
      segments: sorted.length,
      totalSec,
      fragmentBoundaries,
      longestGapSec,
      level: 'fragmented',
      note: `录制被中断过 ${fragmentBoundaries} 次（共 ${sorted.length} 段，最长空档 ${mins(longestGapSec)}）—— 助手已把它们并成一场；若频繁发生，多半是网络抖动或录制器与直播间的连接不稳。`,
    };
  }
  return {
    segments: sorted.length,
    totalSec,
    fragmentBoundaries,
    longestGapSec,
    level: 'ok',
    note: sorted.length <= 1 ? '单段录制（正常）' : `录制 ${sorted.length} 段、无异常中断（正常）`,
  };
}
