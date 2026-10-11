/**
 * 封面抽帧（2026-10-14，优化清单 P2 最后一件功能项）。
 *
 * 现状：`publish.coverSource = 'preset'` 且没有预设封面文件时**不传封面** ⇒ 稿件封面完全交给 B站 自动挑。
 * 影响是直接的：同一场次的每个分P 封面都长得差不多，点击率吃亏。
 *
 * 做法：从**切片产物**里抽一帧当封面（切片本身就是"这场最精彩的那几秒"，
 * 比完整版里随便抽一帧更有代表性）。本文件只负责"抽"，不负责"什么时候抽、传给谁"——
 * 后面那两步在 publish 流程里接，且由配置控制（默认保持现状，零行为变化）。
 *
 * 三条刻意的设计：
 *   1. **抽帧点默认取片段中点**（避开头尾的转场/黑帧）；可传 atSec 覆盖；
 *   2. **失败不抛**：返回 `{ok:false, note}`，调用方照旧走"不传封面"的老路（封面是锦上添花）；
 *   3. 尺寸**按 B站 封面习惯**（16:9 1080×608 附近）缩放并限制体积：`-frames:v 1` + `-q:v 3`。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { findFfmpeg } from './av-sync.ts';
import path from 'node:path';

export interface CoverResult {
  ok: boolean;
  /** 抽出来的封面文件（ok=false 时无） */
  path?: string;
  /** 给日志/界面的说明（成功与失败都给） */
  note: string;
  /** 实际抽帧用的时间点（秒） */
  atSec?: number;
}

/**
 * 找 ffmpeg：**用项目统一的解析器**（av-sync 的 findFfmpeg：先看显式路径，
 * 再看 ffprobe 同目录，最后交给 PATH）。这里刻意不硬编码任何本机路径 ——
 * 硬编码会泄露用户名，换台机器也无效（2026-10-14 被 pre-commit 脱敏钩子拦下后改的）。
 */
function defaultFfmpeg(): string {
  return findFfmpeg(process.env['LIVEAUTO_FFMPEG'] ?? undefined);
}

/**
 * 从媒体文件抽一帧当封面。
 * @param inPath  源（建议传**切片产物**，比完整版更有代表性）
 * @param outPath 输出图片路径（.jpg）
 * @param atSec   抽帧时间点（默认取中点；传了就按传的来）
 */
export function extractCover(opts: { inPath: string; outPath: string; atSec?: number; durationSec?: number; ffmpegPath?: string }): CoverResult {
  const ffmpeg = opts.ffmpegPath || defaultFfmpeg();
  if (!fs.existsSync(opts.inPath)) return { ok: false, note: `源文件不存在：${path.basename(opts.inPath)}` };

  const at = opts.atSec ?? Math.max(1, Math.round((opts.durationSec ?? 60) / 2));
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  /* -ss 放在 -i 之前：快速定位（关键帧附近），抽一帧足够用，且不用解码整段 */
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(at),
    '-i',
    opts.inPath,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(1280,iw)':-2",
    '-q:v',
    '3',
    '-y',
    opts.outPath,
  ];
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0 || !fs.existsSync(opts.outPath)) {
    const why = (r.stderr ?? '').split('\n').filter(Boolean).slice(-1)[0] ?? `退出码 ${String(r.status)}`;
    return { ok: false, note: `抽帧失败：${why.slice(0, 120)}`, atSec: at };
  }
  const kb = Math.round(fs.statSync(opts.outPath).size / 1024);
  return { ok: true, path: opts.outPath, note: `已抽封面（第 ${at} 秒，${kb} KB）`, atSec: at };
}

/**
 * 挑一个"最适合当封面"的切片：优先**已切好且有产物**的、评分最高的那个。
 * 返回 undefined 表示没有可用的（调用方就照旧不传封面）。
 */
export function pickCoverSource(clips: Array<{ index: number; score?: number; cutOutput?: string; status?: string }>): { index: number; path: string; durationSec?: number } | undefined {
  const usable = clips
    .filter((c) => Boolean(c.cutOutput) && fs.existsSync(c.cutOutput as string))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = usable[0];
  return best ? { index: best.index, path: best.cutOutput as string } : undefined;
}
