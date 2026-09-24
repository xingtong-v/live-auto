/**
 * 成片音视频对齐修复。
 *
 * ## 为什么需要这一层（实测，不是推测）
 *
 * 用户报「字幕和声音对不上」。查下来字幕生成没问题，问题在**切片产物的音视频时间轴**：
 *
 * - 源录播 `2026_9_21 20_50_02 场直播.ts`：视频/音频两条流的起点都是 1.433（同步）；
 * - 切成 30 秒验证片段后：视频起点 4.800，音频起点 1.239 —— **音频比画面早 3.561 秒**；
 * - 用 `-c copy` 原样搬运（不重编码、不改时间戳）同样是 3.560 秒 → **错位来自源录播的 PTS 结构**，
 *   不是 ffmpeg 参数没调好（起点对齐关键帧也修不掉，实测仍是 2.755 秒）；
 * - 16 个历史成片里 7 个错位超过 0.5 秒，最大 3.742 秒 —— 换素材也一样，是系统性的。
 *
 * 为什么表现成"字幕和声音对不上"：`subtitles` 滤镜是按**画面 PTS** 烧的，字幕牢牢跟住画面；
 * 于是声音跑在前面，观众先听到词、过几秒才看到对应的画面与字幕。
 * （实测佐证：成片第 0 秒的声音经包络互相关定位到源第 870.83 秒 = PTS + 869.59，
 *   而成片上烧入的字幕内容 = 输出 PTS + 867.5，两者差 2 秒以上。）
 *
 * ## 修法
 *
 * 切片完成后**重挂一次**（纯流拷贝，不重编码、不损画质，80 MB 约 0.1 秒）：
 * 把起点靠前的那条流整体后移 Δ，使两条流起点一致。画面与已烧好的字幕**一个像素都不动**，
 * 只是让声音回到它该在的位置。
 *
 * 为什么不改 ffmpeg 参数：`-ss/-copyts/-to` 前缀由 biliLive-tools 生成（基础设施只走 HTTP、不改它），
 * 我们能控制的只有 ffmpegOptions，而实测音频重编码、去掉 copyts、起点对齐关键帧都修不掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { findFfprobe } from './media.ts';
import { exists } from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';

export interface StreamStarts {
  /** 视频流第一条包的时间戳（秒） */
  videoStart?: number;
  /** 音频流第一条包的时间戳（秒） */
  audioStart?: number;
}

export interface AvSyncResult {
  /** 检测到的差值（视频起点 − 音频起点）；>0 表示音频跑在前面 */
  deltaSec: number;
  /** 是否执行了修复 */
  repaired: boolean;
  /** 修复后的差值（未修复时为 undefined） */
  deltaAfterSec?: number;
  /** 未能修复时的原因（用于日志，不阻断出片） */
  warning?: string;
}

/** ffmpeg 可执行文件：与 ffprobe 成对安装，优先取同目录 */
export function findFfmpeg(explicit?: string): string {
  if (explicit && exists(explicit)) return explicit;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const probe = findFfprobe();
  if (probe) {
    const sameDir = path.join(path.dirname(probe), exe);
    if (exists(sameDir)) return sameDir;
  }
  return exe;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null;
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * 读出一条视频/音频流的起始时间戳。
 *
 * 不能只看容器的 `start_time`（MP4 会把它填成两条流里较小的那个，正好把错位藏起来），
 * 必须读**每条流自己的 start_time** —— 错位就藏在这个差值里。
 */
export async function probeStreamStarts(
  file: string,
  opts: { ffprobePath?: string; timeoutMs?: number } = {},
): Promise<StreamStarts> {
  const ffprobe = opts.ffprobePath && exists(opts.ffprobePath) ? opts.ffprobePath : (findFfprobe() ?? 'ffprobe');
  const r = await run(
    ffprobe,
    ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'csv=p=0', file],
    opts.timeoutMs ?? 60000,
  );
  if (r.code !== 0) return {};
  const res: StreamStarts = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const [type, st] = line.split(',');
    const v = Number(st);
    if (!Number.isFinite(v)) continue;
    if (type === 'video' && res.videoStart === undefined) res.videoStart = v;
    if (type === 'audio' && res.audioStart === undefined) res.audioStart = v;
  }
  return res;
}

/**
 * 切片完成后校验并修复音视频起点错位。
 *
 * 约定：**永不抛异常**。音画错位是观感问题，修不好也不该挡住出片 ——
 * 但必须留下日志与返回值，让"这一条成片音画错位"可追溯。
 */
export async function ensureAvSync(
  file: string,
  opts: {
    toleranceSec?: number;
    ffmpegPath?: string;
    ffprobePath?: string;
    timeoutMs?: number;
    logger?: Logger;
    enabled?: boolean;
  } = {},
): Promise<AvSyncResult> {
  const log = opts.logger ?? globalLog;
  const tol = opts.toleranceSec ?? 0.15;
  const probeOpts = { ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}) };

  if (opts.enabled === false) return { deltaSec: 0, repaired: false };
  if (!exists(file)) return { deltaSec: 0, repaired: false, warning: '文件不存在，跳过音画校验' };

  const before = await probeStreamStarts(file, probeOpts);
  if (before.videoStart === undefined || before.audioStart === undefined) {
    return { deltaSec: 0, repaired: false, warning: '读不到两条流的时间戳，跳过音画校验' };
  }
  const delta = before.videoStart - before.audioStart;
  if (Math.abs(delta) <= tol) return { deltaSec: delta, repaired: false };

  const ffmpeg = findFfmpeg(opts.ffmpegPath);
  const shift = Math.abs(delta).toFixed(6);
  /* 起点靠前的那条流整体后移：视频起点更晚 → 后移音频；反之亦然。
     两条流来自同一个文件，所以用两次 -i 引同一个文件、只给其中一路加 -itsoffset。 */
  const audioFirst = delta > 0;
  const args = audioFirst
    ? ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', file, '-itsoffset', shift, '-i', file, '-map', '0:v:0', '-map', '1:a:0']
    : ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-itsoffset', shift, '-i', file, '-i', file, '-map', '0:v:0', '-map', '1:a:0'];
  const tmp = `${file}.avsync.mp4`;
  args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', tmp);

  const r = await run(ffmpeg, args, opts.timeoutMs ?? 600000);
  if (r.code !== 0 || !exists(tmp)) {
    if (exists(tmp)) fs.rmSync(tmp, { force: true });
    const warning = `音画错位 ${delta.toFixed(3)}s 修复失败（ffmpeg 退出码 ${r.code}）：${r.stderr.slice(-200)}`;
    log.warn(warning);
    return { deltaSec: delta, repaired: false, warning };
  }

  const after = await probeStreamStarts(tmp, probeOpts);
  const deltaAfter =
    after.videoStart !== undefined && after.audioStart !== undefined ? after.videoStart - after.audioStart : Number.NaN;
  if (!Number.isFinite(deltaAfter) || Math.abs(deltaAfter) > tol) {
    fs.rmSync(tmp, { force: true });
    const shown = Number.isFinite(deltaAfter) ? `${deltaAfter.toFixed(3)}s` : '无法读取';
    const warning = `音画错位 ${delta.toFixed(3)}s 修复后仍未对齐（${shown}），保留原文件`;
    log.warn(warning);
    return { deltaSec: delta, repaired: false, warning };
  }

  // 就地替换：cutOutput 的路径必须保持不变（后续投稿用的是同一个路径）
  fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
  log.info(
    `音画错位已修复：${delta.toFixed(3)}s → ${deltaAfter.toFixed(3)}s（后移${audioFirst ? '音频' : '视频'}，流拷贝不重编码）`,
  );
  return { deltaSec: delta, repaired: true, deltaAfterSec: deltaAfter };
}
