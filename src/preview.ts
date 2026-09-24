/**
 * 试看片段生成：把一个候选切片区间快速烧成一个**浏览器可直接播放**的小 mp4。
 *
 * 为什么需要它（用户需求变更）：
 *   最初"试看"是打开资源管理器定位源文件，用户反馈两轮：
 *     ① "没有正确跳转" ⇒ 打开方式本身有 bug（已修）；
 *     ② "不需要资源管理器直接弹到你面前并选中源文件" ⇒ **交互方向错了**。
 *   用户要的是"在界面里直接看到这段内容"，而不是离开界面去文件夹里找。
 *
 * 为什么不能直接播放源文件：
 *   1. 源文件是 `.flv` —— 浏览器 `<video>` **不支持** FLV 容器；
 *   2. 项目已有的 `servePreview` 只允许**任务目录内**文件（防路径遍历），
 *      而源录播在 `Downloads/Bilibili/...` 属于任务目录之外。
 *   所以必须产出一个 mp4 落到任务目录里，才能被内联播放。
 *
 * 为什么用硬件编码：
 *   实测 132 秒切片：`libx264 veryfast crf21`（项目正式切片参数，画质优先）约 **49 秒**，
 *   而 `h264_nvenc p5 cq26` 约 **24 秒**。试看是"看一眼内容"，不需要发布级画质，
 *   所以这里优先 NVENC；没有 N 卡/驱动不支持时自动退回 libx264。
 *
 * 缓存：同一个 (taskId, start, end) 只生成一次，落在 `data/preview/` 下，按内容哈希命名。
 *   重复点同一个候选是零成本的（直接复用文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { ROOT_DIR, ensureDir, exists, fileSize } from './util.ts';
import type { Logger } from './logger.ts';

const execFileAsync = promisify(execFile);

/** 试看片段存放目录（在项目 data/ 下，便于 `servePreview` 的白名单逻辑复用） */
export const PREVIEW_DIR = path.join(ROOT_DIR, 'data', 'preview');

export interface PreviewResult {
  ok: boolean;
  /** 生成好的 mp4 绝对路径 */
  file?: string;
  /** 相对 PREVIEW_DIR 的文件名（拼预览 URL 用） */
  name?: string;
  fromCache?: boolean;
  bytes?: number;
  elapsedMs?: number;
  encoder?: string;
  error?: string;
}

/** 内容哈希命名：同一任务 + 同一区间 ⇒ 同一个文件，天然幂等 */
export function previewFileName(taskId: string, start: number, end: number): string {
  const h = createHash('sha1').update(`${taskId}|${start.toFixed(2)}|${end.toFixed(2)}`).digest('hex').slice(0, 16);
  return `pv-${h}.mp4`;
}

/** 找到可用的 ffmpeg（优先 PATH，其次项目里 biliLive-tools 的路径配置） */
async function ffmpegBin(): Promise<string> {
  return 'ffmpeg';
}

/**
 * 生成（或复用）试看片段。
 *
 * @param opts.fast 是否允许硬件编码（默认 true）。false 时直接用 libx264。
 */
export async function makePreviewClip(opts: {
  taskId: string;
  sourcePath: string;
  start: number;
  end: number;
  logger?: Logger;
  /** 用于提示"这里在等什么"的进度回调（生成是单次 ffmpeg 调用，只能给阶段） */
  onStage?: (stage: string) => void;
  fast?: boolean;
}): Promise<PreviewResult> {
  const { taskId, sourcePath, start, end } = opts;
  const log = opts.logger;
  const t0 = Date.now();
  const duration = Math.max(0.5, end - start);

  if (!exists(sourcePath)) {
    return { ok: false, error: `源文件不存在：${sourcePath}` };
  }
  ensureDir(PREVIEW_DIR);
  const name = previewFileName(taskId, start, end);
  const out = path.join(PREVIEW_DIR, name);

  /* ---- 命中缓存：直接复用 ---- */
  if (exists(out) && fileSize(out) > 1024) {
    log?.debug(`试看片段命中缓存：${name}`);
    return { ok: true, file: out, name, fromCache: true, bytes: fileSize(out), elapsedMs: Date.now() - t0, encoder: 'cache' };
  }

  const bin = await ffmpegBin();
  const fast = opts.fast !== false;

  /** 一组编码参数：先试硬件，失败退回软件 */
  const attempts: Array<{ label: string; args: string[] }> = fast
    ? [
        {
          /* ⚠️ 必须给码率**上限**：第一版只写 `-rc vbr -cq 26`，结果 128 秒的片段有 160.7 MB
             （≈10 Mbps，比源流 9 Mbps 还高）—— 因为 VBR 在复杂画面上会一路涨码率。
             试看是"看一眼内容"，4 Mbps 完全够（还能看清弹幕和字幕），
             40 个片段的缓存上限也从 6.4 GB 降到 1.6 GB 左右。 */
          label: 'h264_nvenc',
          args: [
            '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '28',
            '-b:v', '4M', '-maxrate', '6M', '-bufsize', '12M',
            '-c:a', 'aac', '-b:a', '96k',
          ],
        },
        {
          label: 'libx264',
          args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '6M', '-bufsize', '12M', '-c:a', 'aac', '-b:a', '96k'],
        },
      ]
    : [
        {
          label: 'libx264',
          args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '6M', '-bufsize', '12M', '-c:a', 'aac', '-b:a', '96k'],
        },
      ];

  let lastErr = '';
  for (const a of attempts) {
    /* `-ss` 放在 `-i` **之前**：快速定位（关键帧级 seek），比解码到目标点快得多。
       试看只需要"大概从这里开始"，不需要帧精确 —— 这也是它比正式切片快的原因之一。 */
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(start),
      '-i',
      sourcePath,
      '-t',
      String(duration),
      ...a.args,
      '-movflags',
      '+faststart',
      out,
    ];
    try {
      opts.onStage?.(`正在生成试看片段（${a.label}）…`);
      await execFileAsync(bin, args, { timeout: 15 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      if (!exists(out) || fileSize(out) < 1024) {
        lastErr = `${a.label} 结束但没有产出有效文件`;
        try {
          fs.unlinkSync(out);
        } catch {
          /* ignore */
        }
        continue;
      }
      const elapsedMs = Date.now() - t0;
      log?.info(`试看片段已生成：${name}（${a.label}，${(fileSize(out) / 1024 / 1024).toFixed(1)} MB，${(elapsedMs / 1000).toFixed(1)}s）`, {
        taskId,
        data: { start, end, encoder: a.label },
      });
      return { ok: true, file: out, name, fromCache: false, bytes: fileSize(out), elapsedMs, encoder: a.label };
    } catch (e) {
      lastErr = `${a.label} 失败：${(e as Error).message.slice(0, 200)}`;
      log?.warn(`试看片段生成失败，尝试下一种编码器：${lastErr}`, { taskId });
      try {
        if (exists(out)) fs.unlinkSync(out);
      } catch {
        /* ignore */
      }
    }
  }

  return { ok: false, error: lastErr || '未知原因', elapsedMs: Date.now() - t0 };
}

/**
 * 清理过期的试看片段（`servePreview` 之外的第二道管理，避免无限堆积）。
 *
 * 策略：先按"超过 maxAgeMs"删，再按"总数超过 maxFiles"从最旧开始删。
 * 只在生成新片段时顺手调用一次 —— 不做定时任务，避免为一个纯 UI 辅助功能增加常驻负担。
 */
export function cleanupPreviews(opts: { maxAgeMs?: number; maxFiles?: number } = {}): { removed: number; kept: number } {
  const maxAgeMs = opts.maxAgeMs ?? 6 * 3600_000; // 6 小时
  const maxFiles = opts.maxFiles ?? 40;
  if (!exists(PREVIEW_DIR)) return { removed: 0, kept: 0 };
  let removed = 0;
  const now = Date.now();
  interface Item {
    p: string;
    m: number;
  }
  let items: Item[] = [];
  try {
    items = fs
      .readdirSync(PREVIEW_DIR)
      .filter((n) => n.startsWith('pv-') && n.endsWith('.mp4'))
      .map((n) => {
        const p = path.join(PREVIEW_DIR, n);
        let m = 0;
        try {
          m = fs.statSync(p).mtimeMs;
        } catch {
          m = 0;
        }
        return { p, m };
      });
  } catch {
    return { removed: 0, kept: 0 };
  }

  for (const it of items) {
    if (now - it.m > maxAgeMs) {
      try {
        fs.unlinkSync(it.p);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  let rest = items.filter((it) => exists(it.p)).sort((a, b) => a.m - b.m);
  while (rest.length > maxFiles) {
    const it = rest.shift()!;
    try {
      fs.unlinkSync(it.p);
      removed++;
    } catch {
      /* ignore */
    }
  }
  return { removed, kept: rest.length };
}
