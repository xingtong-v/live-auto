/**
 * 用**音频能量**给字幕找"人真正在说话"的位置。
 *
 * ## 为什么需要它（实测事故，2026-09-24）
 *
 * 云 ASR（fun-asr）在游戏直播这种"背景一直有声音"的音频上，会给出离谱的**句子窗口**：
 * 实测一段 15 个字的字幕拿到 30.9 秒的窗口，6 个字拿到 40.5 秒。这些窗口的**起点**往往是错的 ——
 * 真实说话发生在窗口靠后的位置。我们原来把字幕一律**贴着窗口起点**铺（每条最多显示 8 秒），
 * 于是出现两件事：① 没人说话时字幕在屏幕上；② 真说话时屏幕上啥也没有。
 * 用户的原话就是"字幕对不上"。
 *
 * ## 为什么不用 silencedetect
 *
 * 先试过"把字幕铺到静音之间的有声区间"——**在这类音频上完全无效**：
 * 实测整场 1034 秒里静音只有 51.9 秒（5%），两个切片窗口内静音为 0（游戏音效一直在响）。
 * 没有静音可依据，就只能用**能量相对高低**来判断"哪一段更像有人在说话"。
 *
 * 做法：把音频解码成 8kHz 单声道，按 `binSec` 求 RMS；
 * 对于一个"窗口远长于文本所需朗读时间"的转写段，在窗口内滑动寻找**能量最高的一段**作为锚点。
 *
 * 只在"窗口明显不合理"时才动用它（`needsAnchor`），正常段一律保持 ASR 给的时间 ——
 * 实测正常段与单独重识别的时间差在 0.3 秒以内，动它只会更糟。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { exists } from './util.ts';

const statSync = (p: string): fs.Stats => fs.statSync(p);

export interface EnergyProfile {
  /** 每个 bin 的时长（秒） */
  binSec: number;
  /** 每 bin 的 RMS（0–1 之间，静音接近 0） */
  rms: number[];
  durationSec: number;
}

export interface EnergyOptions {
  binSec?: number;
  sampleRate?: number;
  ffmpegPath?: string;
  timeoutMs?: number;
}

const DEFAULT_BIN_SEC = 0.2;
const DEFAULT_SR = 8000;

/**
 * 从 PCM（f32le 单声道）样本算 RMS 剖面 —— **纯函数**，便于单测。
 */
export function rmsProfile(samples: Float32Array, sampleRate: number, binSec: number): EnergyProfile {
  const perBin = Math.max(1, Math.round(sampleRate * binSec));
  const rms: number[] = [];
  for (let i = 0; i < samples.length; i += perBin) {
    const end = Math.min(samples.length, i + perBin);
    let sum = 0;
    for (let j = i; j < end; j++) sum += samples[j]! * samples[j]!;
    rms.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  return { binSec: perBin / sampleRate, rms, durationSec: samples.length / sampleRate };
}

/**
 * 解码音频并算能量剖面。失败返回 undefined —— 这只是"让字幕更准"的增强，
 * 拿不到就退回原来的做法，绝不能因为它挡住出片。
 */
export function computeEnergyProfile(videoPath: string, opts: EnergyOptions = {}): EnergyProfile | undefined {
  if (!videoPath || !exists(videoPath)) return undefined;
  const sr = opts.sampleRate ?? DEFAULT_SR;
  const binSec = opts.binSec ?? DEFAULT_BIN_SEC;
  const ffmpeg = opts.ffmpegPath && opts.ffmpegPath.trim() ? opts.ffmpegPath.trim() : 'ffmpeg';
  try {
    const res = spawnSync(
      ffmpeg,
      ['-hide_banner', '-v', 'error', '-i', videoPath, '-vn', '-f', 'f32le', '-ac', '1', '-ar', String(sr), '-'],
      { maxBuffer: 512 * 1024 * 1024, timeout: opts.timeoutMs ?? 15 * 60_000 },
    );
    const out = res.stdout;
    if (!out || out.length < sr * 4) return undefined; // 不到 1 秒音频：没有意义
    const samples = new Float32Array(out.buffer, out.byteOffset, Math.floor(out.length / 4));
    return rmsProfile(samples, sr, binSec);
  } catch {
    return undefined;
  }
}

/** 某个时间段内的平均能量（无数据时为 0） */
export function meanEnergy(profile: EnergyProfile, from: number, to: number): number {
  if (!(to > from)) return 0;
  const i0 = Math.max(0, Math.floor(from / profile.binSec));
  const i1 = Math.min(profile.rms.length, Math.ceil(to / profile.binSec));
  if (i1 <= i0) return 0;
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += profile.rms[i] ?? 0;
  return sum / (i1 - i0);
}

/**
 * 在 `[from, to]` 里挑一个"这段时间有人在说话"的起点。
 *
 * ## 为什么是"最大峰值 + 严格余量"，而不是"最响的一段"
 *
 * 第一版用"滑动窗口平均能量最高的位置"，实测**在游戏直播上会选错**：
 * 背景音效/音乐有周期性峰值（实测每 5 秒一个 -25 dB 的鼓点），
 * 于是它把一个 40 秒窗口里的字幕挪到了游戏爆炸声上 —— 比不动更糟。
 *
 * 改成：先做 3 点中值平滑（滤掉单点咔哒声），取**最大峰值**，
 * 并要求它比该窗口的中位能量高出 `marginDb`（默认 8 dB）才认账。
 * 拿不准就返回 undefined —— 保守地"保持原样"，因为原样至少不会把字幕搬到音乐上。
 *
 * 实测两个真实案例（同一场直播）：
 *   · 修好的：窗口 0→30.9s，背景 -35 dB，29–31s 有一个 -10.5 dB 的人声 → 峰值余量 24 dB ✓ 认账，字幕挪到 29.6s
 *   · 不动的：窗口 351.9→392.4s，背景 -33 dB，最响的是 352.0s 的 -23.7 dB（正好是窗口开头）
 *     → 即便认账，选出来的位置≈窗口起点，等于没动（代码里 `picked > segStart + 0.05` 会跳过）
 */
export function bestAnchor(profile: EnergyProfile | undefined, from: number, to: number, needSec: number, opts: { marginDb?: number } = {}): number | undefined {
  if (!profile || profile.rms.length === 0) return undefined;
  const span = to - from;
  const need = Math.max(profile.binSec, Math.min(needSec, span));
  if (!(span > need)) return undefined;
  const i0 = Math.max(0, Math.floor(from / profile.binSec));
  const i1 = Math.min(profile.rms.length, Math.ceil(to / profile.binSec));
  if (i1 - i0 < 3) return undefined;

  /* 3 点中值平滑：单点尖峰（脚步、咔哒）不该被当成"有人在说话" */
  const smoothed: number[] = [];
  for (let i = i0; i < i1; i++) {
    const a = profile.rms[i - 1] ?? profile.rms[i] ?? 0;
    const b = profile.rms[i] ?? 0;
    const c = profile.rms[i + 1] ?? profile.rms[i] ?? 0;
    smoothed.push([a, b, c].sort((x, y) => x - y)[1]!);
  }
  const sorted = [...smoothed].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  let peakIdx = 0;
  for (let i = 1; i < smoothed.length; i++) if (smoothed[i]! > smoothed[peakIdx]!) peakIdx = i;
  const peak = smoothed[peakIdx]!;
  const marginDb = opts.marginDb ?? 8;
  const quiet = Math.max(1e-6, median) * 10 ** (marginDb / 20);
  if (peak < quiet) return undefined;

  const peakT = from + peakIdx * profile.binSec;
  /* 锚点落在峰值略前一点：人说话通常从峰值起音，字幕早 0.4 秒比晚 0.4 秒自然 */
  const start = Math.min(Math.max(from, peakT - 0.4), to - need);
  return Number(start.toFixed(3));
}

/**
 * 判据：这个转写段的窗口是不是"明显不合理"，需要重新锚定？
 *
 * 依据是"文本所需朗读时间"与"窗口长度"的比值。实测数据：
 *   · 正常段：2.4→4.0s 装 6 个字（需 ≈1.0s）→ 比值 1.6
 *   · 离谱段：0→30.9s 装 15 个字（需 ≈2.5s）→ 比值 12.4；另有 6 字占 40.5s（比值 40）
 * 取 2.5 倍作为分界：正常段一律不动（它们的起点本来就准，实测误差 < 0.3s）。
 */
export function needsAnchor(windowSec: number, needSec: number, maxDurationSec: number): boolean {
  const need = Math.max(0.5, needSec);
  return windowSec > Math.max(maxDurationSec * 2, need * 2.5);
}

/* ============================================================================
 * 切片边界用：找"人开始说话 / 说完话"的位置
 * ========================================================================== */

/**
 * 判"这里有人在说话"的能量阈值（dBFS）。
 * 实测本机素材：背景（音乐/游戏音效）在 −31…−38 dB，人声在 −10…−28 dB。
 * 取 −28 dB 作为分界，与 `tools/no-subtitle-impact.ts` 里的口径一致。
 */
export const SPEECH_DB = -28;

/** 峰值判据的余量：峰值必须比该区间**背景电平**高这么多 dB 才算"有人在说话" */
const PEAK_MARGIN_DB = 6;

/**
 * 背景电平的估计：取区间能量的 **20 分位**，而不是中位数。
 *
 * 实测踩过：找一个 30 秒窗口的"最后一句人声"时，窗口里大部分时间**本来就是人声**，
 * 中位数直接变成人声电平 → 阈值被抬到人声之上 → 什么也找不到（结尾修正静默失效）。
 * 20 分位更能代表"没有人在说话时的底噪/音乐"。
 */
function backgroundLevel(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor((sorted.length - 1) * 0.2));
  return sorted[idx] ?? 0;
}

function speechThreshold(values: number[]): number {
  return Math.max(backgroundLevel(values) * 10 ** (PEAK_MARGIN_DB / 20), 10 ** (SPEECH_DB / 20));
}

/** 从 `from` 往后找第一个"有人说话"的时刻；找不到（或超出 maxSearchSec）返回 undefined */
export function findSpeechOnset(profile: EnergyProfile | undefined, from: number, maxSearchSec: number): number | undefined {
  if (!profile || maxSearchSec <= 0) return undefined;
  const i0 = Math.max(0, Math.ceil(from / profile.binSec));
  const i1 = Math.min(profile.rms.length - 1, Math.floor((from + maxSearchSec) / profile.binSec));
  if (i1 <= i0) return undefined;
  const window: number[] = [];
  for (let i = i0; i <= i1; i++) window.push(profile.rms[i] ?? 0);
  const threshold = speechThreshold(window);
  for (let i = i0; i <= i1; i++) {
    if ((profile.rms[i] ?? 0) >= threshold) return Number((i * profile.binSec).toFixed(3));
  }
  return undefined;
}

/** 从 `to` 往前找最后一个"有人说话"的时刻（返回该时刻**之后**的静音起点，便于直接当结尾用） */
export function findSpeechOffset(profile: EnergyProfile | undefined, to: number, maxSearchSec: number): number | undefined {
  if (!profile || maxSearchSec <= 0) return undefined;
  const i1 = Math.min(profile.rms.length - 1, Math.floor(to / profile.binSec));
  const i0 = Math.max(0, Math.ceil((to - maxSearchSec) / profile.binSec));
  if (i1 < i0) return undefined;
  const window: number[] = [];
  for (let i = i0; i <= i1; i++) window.push(profile.rms[i] ?? 0);
  const threshold = speechThreshold(window);
  for (let i = i1; i >= i0; i--) {
    if ((profile.rms[i] ?? 0) >= threshold) return Number(((i + 1) * profile.binSec).toFixed(3));
  }
  return undefined;
}

/* ============================================================================
 * 剖面缓存（字幕与切片边界共用）
 * ========================================================================== */

const energyCache = new Map<string, EnergyProfile | undefined>();
const ENERGY_CACHE_MAX = 4;

/**
 * 带缓存的剖面获取。键里带 size + mtime：文件被改名/追写后不会拿到旧剖面。
 * 不传 logger 就不打日志（测试/探针里不需要）。
 */
export function energyProfileCached(videoPath: string | undefined, log?: { debug: (msg: string, meta?: unknown) => void }): EnergyProfile | undefined {
  if (!videoPath || !exists(videoPath)) return undefined;
  let key = videoPath;
  try {
    const st = statSync(videoPath);
    key = `${videoPath}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    /* 拿不到 stat 就用路径当键 */
  }
  if (energyCache.has(key)) return energyCache.get(key);
  const t0 = Date.now();
  const profile = computeEnergyProfile(videoPath);
  if (energyCache.size >= ENERGY_CACHE_MAX) {
    const first = energyCache.keys().next().value;
    if (first !== undefined) energyCache.delete(first);
  }
  energyCache.set(key, profile);
  log?.debug(
    profile
      ? `能量剖面已就绪：${profile.rms.length} 个 ${profile.binSec}s 的 bin，覆盖 ${profile.durationSec.toFixed(0)}s（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
      : '能量剖面不可用（拿不到音频或 ffmpeg 失败）',
  );
  return profile;
}
