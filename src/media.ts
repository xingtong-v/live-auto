/**
 * 源素材探测 + 「分段文件 → 全局时间」映射（任务书 WP3 的前置基础设施）。
 *
 * 为什么单独抽一个模块：
 *  - 转写（WP3）按「窗口」调用 /ai/subtitle，返回的时间戳相对**该次调用的音频片段起点**，
 *    而弹幕、LLM 选片、切片全都使用「本场全局时间轴」。两者之间的换算完全依赖
 *    「分段文件时长 + 累加起点」这一份映射，放在一处实现才不会各处走样。
 *  - 录制器可能按 duration 把一场直播切成多个 flv/ts。单文件场景是它的退化情形（长度 1 的数组），
 *    所以上层只需要写一套代码。
 *
 * 设计原则（编排层的地基，不允许把链路打断）：
 *  - 除了「参数明显非法」（空数组、非正数的窗口长度）之外，一律不抛异常：
 *    要么返回结构化错误（ProbeResult.error），要么返回安全默认值 + warnings。
 *  - 不做网络请求、不读配置文件：ffprobe 路径由调用方（trigger/wizard）从配置里取好传进来，
 *    本模块只做「显式传入 > PATH > 常见安装位置」的兜底查找。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SourceMedia, SourceSegment } from './types.ts';
import { ROOT_DIR, exists, fileSize, fmtBytes, fmtDuration, toMs, toSec } from './util.ts';
import { log } from './logger.ts';

/* ============================================================================
 * 常量
 * ========================================================================== */

/** 读文件头本身是毫秒级操作，卡住基本只有两种原因：网络盘、文件损坏 */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/** 校验 ffprobe 是否可用时的超时（只跑 -version，必须很快） */
const VERSION_TIMEOUT_MS = 5_000;

/** 分段数上限的兜底默认值（与 config.segmented.maxSegments 同量级） */
const DEFAULT_MAX_SEGMENTS = 500;

/** 窗口数上限的兜底默认值：24 小时直播按 30 分钟切也只有 48 个，5000 足够宽裕 */
const DEFAULT_MAX_WINDOWS = 5_000;

/** warnings 是给人看的：同类警告去重，并限制条数，避免 500 段刷屏 */
const MAX_WARNINGS = 20;

/** ffprobe 参数：只要 JSON + format + streams，不要多余输出 */
const FFPROBE_ARGS = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];

/* ============================================================================
 * 类型
 * ========================================================================== */

/** 单个媒体文件的探测结果 */
export interface ProbeResult {
  path: string;
  exists: boolean;
  duration: number; // 秒，探测不到为 0
  size: number; // 字节
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  bitrate?: number; // bps
  error?: string;
}

/** ffprobe -print_format json 的输出子集（只声明我们用得到的字段） */
interface FfprobeStream {
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
  duration?: unknown;
  bit_rate?: unknown;
  disposition?: { attached_pic?: unknown };
}

interface FfprobeFormat {
  duration?: unknown;
  size?: unknown;
  bit_rate?: unknown;
}

interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

/** 从一条录制记录（驼峰或下划线两种风格都能吃）中提取源素材信息 */
export interface RawRecordLike {
  id?: string;
  title?: string;
  live_start_time?: number;
  liveStartTime?: number;
  record_start_time?: number;
  recordStartTime?: number;
  record_end_time?: number;
  recordEndTime?: number;
  video_file?: string;
  videoFilePath?: string;
  video_duration?: number;
  videoDuration?: number;
  danma_num?: number;
  [k: string]: unknown;
}

export interface NormalizedRecord {
  id: string;
  title: string;
  /** 一律转成秒 */
  liveStartTime?: number;
  /** 一律转成毫秒 */
  recordStartTime?: number;
  /** 一律转成毫秒 */
  recordEndTime?: number;
  videoPath?: string;
  videoDurationSec?: number;
  danmaCount?: number;
  /**
   * 原始记录。保留全部字段（含类型里没列出的 live_id 等），
   * 调用方据此判断「同一直播场次被断流拆成多条 record」这类情况。
   */
  raw: RawRecordLike;
}

/* ============================================================================
 * 小工具
 * ========================================================================== */

/** 秒级精度到毫秒即可：避免浮点累加出现 3.0000000000000004 这种脏值写进台账 */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 宽松取数：API 实测里 number 字段偶尔是字符串 */
function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 宽松取字符串（去空白；空串视为未提供） */
function toStr(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? undefined : s;
  }
  return undefined;
}

/** 子进程错误的 stdout/stderr 在 encoding=utf8 时是 string，未指定时是 Buffer */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return '';
}

/** 正则元字符转义（用于按文件名前缀生成匹配式） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ============================================================================
 * ffprobe 定位
 * ========================================================================== */

/**
 * 已确认可用的 ffprobe 缓存。
 * 只缓存**成功**结果：失败（例如用户还没装 ffmpeg）不缓存，
 * 否则用户装好之后不重启进程就再也探测不到了。
 * 缓存的意义在于：批量探测几百个分段时不要每次都去跑 where.exe。
 */
const ffprobeCache = new Map<string, string>();

/** 找一个可用的 ffprobe：显式传入 > PATH > 常见安装位置（Windows）。找不到返回 undefined */
export function findFfprobe(explicit?: string): string | undefined {
  const key = explicit?.trim() ?? '';
  const cached = ffprobeCache.get(key);
  if (cached) return cached;

  const hit = (bin: string): string => {
    ffprobeCache.set(key, bin);
    return bin;
  };

  // 1) 显式传入（来自 config 的 ffprobePath / biliLive-tools /config 的 ffprobePath）
  if (key) {
    const r = resolveCandidate(key);
    if (r) return hit(r);
  }
  // 2) PATH
  const onPath = lookupOnPath();
  if (onPath) return hit(onPath);
  // 3) 常见安装位置
  for (const cand of commonFfprobePaths()) {
    const r = resolveCandidate(cand);
    if (r) return hit(r);
  }
  return undefined;
}

/** 带路径分隔符的候选先看文件在不在，避免无谓地起进程 */
function resolveCandidate(cand: string): string | undefined {
  const looksLikePath = /[\\/]/.test(cand) || /^[a-zA-Z]:/.test(cand);
  if (looksLikePath && !exists(cand)) return undefined;
  return canRunFfprobe(cand) ? cand : undefined;
}

/**
 * 真正跑一次 `-version` 验证。
 * 必须验证而不是只看文件存在：PATH 上可能有同名占位程序，
 * 返回一个「存在但跑不起来」的路径会让后面每一次探测都白等一个超时。
 */
function canRunFfprobe(bin: string): boolean {
  try {
    const out = execFileSync(bin, ['-version'], {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return /ffprobe version/i.test(out);
  } catch {
    return false;
  }
}

/** Windows 上用 where 拿到具体路径（日志里能直接看出用的是哪一个二进制），失败再退回裸名交给 PATH 解析 */
function lookupOnPath(): string | undefined {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const out = execFileSync(finder, ['ffprobe'], {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (first && exists(first) && canRunFfprobe(first)) return first;
  } catch {
    /* 没有 where / PATH 里查不到，继续兜底 */
  }
  return canRunFfprobe('ffprobe') ? 'ffprobe' : undefined;
}

/** 常见安装位置（Windows 为主；顺带给 POSIX 几个标准路径） */
function commonFfprobePaths(): string[] {
  const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  const programData = process.env['ProgramData'] ?? '';
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const candidates = [
    // 项目自带的便携版（部署时把 ffmpeg 解压到 tools/ 下，最省心）
    path.join(ROOT_DIR, 'tools', 'ffmpeg', 'bin', exe),
    path.join(ROOT_DIR, exe),
    'C:\\ffmpeg\\bin\\' + exe,
    path.join(programFiles, 'ffmpeg', 'bin', exe),
    localAppData ? path.join(localAppData, 'Programs', 'ffmpeg', 'bin', exe) : '',
    localAppData ? path.join(localAppData, 'Microsoft', 'WinGet', 'Links', exe) : '',
    home ? path.join(home, 'tools', 'ffmpeg', 'bin', exe) : '',
    home ? path.join(home, 'scoop', 'shims', exe) : '',
    programData ? path.join(programData, 'chocolatey', 'bin', exe) : '',
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/opt/homebrew/bin/ffprobe',
  ];
  return candidates.filter(Boolean);
}

/* ============================================================================
 * 单文件探测
 * ========================================================================== */

/**
 * 用 ffprobe 探测媒体文件。找不到 ffprobe / 文件不存在时返回 exists:false 且 duration:0，不抛异常。
 *
 * 注意 exists 的语义：它表示「探测结果可信」，而不是「文件系统里有没有这个文件」。
 * ffprobe 不可用时同样返回 exists:false（error 里会写明到底是文件缺失还是工具缺失），
 * 这样调用方看到 exists:false 就会去查 error，而不会拿一个 duration=0 的结果当真。
 */
export function probeMedia(filePath: string, opts?: { ffprobePath?: string; timeoutMs?: number }): ProbeResult {
  const result: ProbeResult = {
    path: typeof filePath === 'string' ? filePath : '',
    exists: false,
    duration: 0,
    size: 0,
    hasVideo: false,
    hasAudio: false,
  };

  if (!filePath || typeof filePath !== 'string') {
    result.error = '未提供文件路径';
    return result;
  }
  if (!exists(filePath)) {
    result.error = '文件不存在';
    return result;
  }
  // 大小是本地 stat，不依赖 ffprobe —— 即使探测失败也要带回去（录制完成判定要用）
  result.size = fileSize(filePath);

  const ffprobe = findFfprobe(opts?.ffprobePath);
  if (!ffprobe) {
    result.error = '找不到可用的 ffprobe（文件本身存在，但无法探测时长/编码）';
    return result;
  }

  const timeoutMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  let raw = '';
  try {
    raw = execFileSync(ffprobe, [...FFPROBE_ARGS, filePath], {
      encoding: 'utf8',
      timeout: timeoutMs,
      // 默认 1MB 的 maxBuffer 在多流文件上会 ENOBUFS，这里放大到 16MB
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    result.error = describeExecError(e, timeoutMs);
    return result;
  }

  if (!raw.trim()) {
    result.error = 'ffprobe 没有输出（文件可能仍在写入或已损坏）';
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    result.error = `ffprobe 输出不是合法 JSON：${raw.trim().slice(0, 120)}`;
    return result;
  }

  const out = (parsed ?? {}) as FfprobeOutput;
  const streams = Array.isArray(out.streams) ? out.streams : [];
  let video: FfprobeStream | undefined;
  let audio: FfprobeStream | undefined;
  let maxStreamDuration = 0;

  for (const s of streams) {
    if (!s || typeof s !== 'object') continue;
    const d = toSec(toNumber(s.duration)) ?? 0;
    if (d > maxStreamDuration) maxStreamDuration = d;
    // 封面图也是 codec_type=video，别把它当成视频轨，否则纯音频文件会被误判成有画面
    const isAttachedPic = toNumber(s.disposition?.attached_pic) === 1;
    if (s.codec_type === 'video' && !isAttachedPic) {
      if (!video) video = s;
    } else if (s.codec_type === 'audio') {
      if (!audio) audio = s;
    }
  }

  const fmt = out.format ?? {};
  // 单位为秒的浮点；走 toSec 是防御性的（元数据偶尔被写成毫秒）
  const fmtDuration = toSec(toNumber(fmt.duration));
  const duration = fmtDuration && fmtDuration > 0 ? fmtDuration : maxStreamDuration;

  result.exists = true;
  result.duration = round3(duration);
  result.hasVideo = Boolean(video);
  result.hasAudio = Boolean(audio);
  const vCodec = toStr(video?.codec_name);
  const aCodec = toStr(audio?.codec_name);
  if (vCodec) result.videoCodec = vCodec;
  if (aCodec) result.audioCodec = aCodec;
  const w = toNumber(video?.width);
  const h = toNumber(video?.height);
  if (w && w > 0) result.width = w;
  if (h && h > 0) result.height = h;
  const br = toNumber(fmt.bit_rate) ?? toNumber(video?.bit_rate) ?? toNumber(audio?.bit_rate);
  if (br && br > 0) result.bitrate = Math.round(br);

  if (result.duration <= 0) {
    result.error = '未取得时长（文件可能仍在写入，或容器元数据损坏）';
  }
  return result;
}

/** 把 execFileSync 的异常翻译成人能看懂的一句话（含 stderr 首行，ffprobe 的报错都在那儿） */
function describeExecError(e: unknown, timeoutMs: number): string {
  const err = e as {
    killed?: boolean;
    signal?: string | null;
    code?: string | number | null;
    status?: number | null;
    message?: string;
    stderr?: unknown;
    stdout?: unknown;
  };
  if (err.killed || err.signal === 'SIGTERM') return `ffprobe 超时（>${timeoutMs}ms）`;
  const code = err.code ?? err.status;
  if (code === 'ENOENT') return 'ffprobe 不可执行（ENOENT）';
  if (code === 'ENOBUFS') return 'ffprobe 输出超过缓冲区上限（maxBuffer）';
  const detail = textOf(err.stderr).trim() || textOf(err.stdout).trim();
  const firstLine = detail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0];
  if (firstLine) return `ffprobe 失败（exit=${String(code ?? '?')}）：${firstLine.slice(0, 200)}`;
  return `ffprobe 失败：${(err.message ?? String(e)).slice(0, 200)}`;
}

/* ============================================================================
 * 分段 → 全局时间
 * ========================================================================== */

/**
 * 构建「分段文件 → 全局时间」映射。
 *
 * 累加规则：第 i 段的 globalStart = 前 i 段时长之和，globalEnd = globalStart + duration。
 * 即使某段探测失败也**保留占位**（duration 记 0 或 fallback），
 * 以保证 segments 的下标与入参 files 严格一一对应 —— 上层是按下标回填文件路径的。
 *
 * warnings 数组里是「需要人看」的问题（丢给调用方写日志/告警），本函数不自己打日志，
 * 因为批量场景下调用方更清楚该用什么上下文记录。
 */
export function buildSegmentMap(
  files: string[],
  opts?: { ffprobePath?: string; fallbackDurationSec?: number; maxSegments?: number },
): { segments: SourceSegment[]; totalDuration: number; warnings: string[] } {
  if (!Array.isArray(files) || files.length === 0) {
    // 空数组是调用方的逻辑错误（trigger 应当先判定「本场至少有一个录制文件」），
    // 静默返回空映射会让后面整条流水线在无素材状态下空跑，不如立刻暴露
    throw new Error('buildSegmentMap: files 为空，无法构建分段映射');
  }

  const warnings: string[] = [];
  const warned = new Set<string>();
  let suppressed = 0;
  const warn = (msg: string): void => {
    if (warned.has(msg)) return;
    warned.add(msg);
    if (warnings.length >= MAX_WARNINGS) {
      suppressed++;
      return;
    }
    warnings.push(msg);
  };

  const maxSegments =
    opts?.maxSegments && opts.maxSegments > 0 ? Math.floor(opts.maxSegments) : DEFAULT_MAX_SEGMENTS;
  let list = files;
  if (files.length > maxSegments) {
    // 上限是防呆：glob 出错时可能返回成千上万个文件，真跑下去会把 CPU 和磁盘打满。
    // 截断会破坏时间轴，所以必须留下明确警告而不是静默处理
    warn(`分段数 ${files.length} 超过上限 ${maxSegments}，只处理前 ${maxSegments} 个（全局时间轴不完整，请调大 segmented.maxSegments 或检查录制目录）`);
    list = files.slice(0, maxSegments);
  }

  const rawFallback = opts?.fallbackDurationSec;
  const fallback =
    typeof rawFallback === 'number' && Number.isFinite(rawFallback) && rawFallback > 0 ? round3(rawFallback) : undefined;

  const ffprobe = findFfprobe(opts?.ffprobePath);
  if (!ffprobe) {
    // 这里只警告一次：真正的探测在下面被跳过，否则每一段都会重复同一条错误
    warn(
      fallback !== undefined
        ? `找不到可用的 ffprobe —— 全部 ${list.length} 段的时长按 fallbackDurationSec=${fallback}s 估算（数值可能与实际有偏差）`
        : `找不到可用的 ffprobe，且未提供 fallbackDurationSec —— 所有分段时长记为 0，全局时间轴不可用（请安装 ffmpeg 或配置 ffprobePath）`,
    );
  }

  const segments: SourceSegment[] = [];
  let cursor = 0;
  for (const file of list) {
    let duration = 0;
    let size = 0;
    if (ffprobe) {
      const probe = probeMedia(file, { ffprobePath: ffprobe });
      duration = probe.duration > 0 ? round3(probe.duration) : 0;
      size = probe.size;
      if (duration <= 0) {
        if (fallback !== undefined) {
          duration = fallback;
          warn(`探测不到时长：${file}（${probe.error ?? '未知原因'}）→ 用 fallbackDurationSec=${fallback}s 兜底`);
        } else {
          warn(`探测不到时长：${file}（${probe.error ?? '未知原因'}）→ 记为 0，该段之后的所有全局时间都会偏移`);
        }
      }
    } else {
      size = fileSize(file);
      if (fallback !== undefined) duration = fallback;
    }

    const segment: SourceSegment = {
      path: file,
      duration,
      globalStart: round3(cursor),
      globalEnd: round3(cursor + duration),
    };
    if (size > 0) segment.size = size;
    segments.push(segment);
    cursor = round3(cursor + duration);
  }

  if (suppressed > 0) {
    warnings.push(`另有 ${suppressed} 类警告因超出条数上限被省略（多为同类问题的不同文件）`);
  }
  return { segments, totalDuration: round3(cursor), warnings };
}

/**
 * 全局时间（相对本场视频起点）→ 落在哪个分段、段内偏移多少。
 *
 * 越界一律 clamp 到最近的分段并标记 clamped:true：LLM 给出的时间点偶尔会
 * 超出视频末尾一点点（例如 3599.8 vs 3600），这不是错误，切片时收敛即可。
 * 分段数组为空属于调用方逻辑错误（没有素材就没有时间轴），直接抛。
 */
export function locateGlobalTime(
  segments: SourceSegment[],
  globalSec: number,
): { segment: SourceSegment; index: number; timeInSegment: number; clamped: boolean } {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('locateGlobalTime: segments 为空，无法定位全局时间');
  }

  const finite = Number.isFinite(globalSec);
  // NaN / Infinity 不能让下游拿到（会变成非法的 ffmpeg 参数），按 0 处理并标记 clamped
  const t = finite ? globalSec : 0;

  let index = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (t < s.globalEnd) {
      index = i;
      break;
    }
  }
  let clamped = !finite;
  if (index < 0) {
    // 落在总时长之后（含正好等于末尾）：归到最后一段
    index = segments.length - 1;
    clamped = true;
  }

  const segment = segments[index]!;
  const raw = t - segment.globalStart;
  const timeInSegment = round3(Math.min(Math.max(raw, 0), Math.max(0, segment.duration)));
  if (raw < 0 || raw > segment.duration) clamped = true;
  return { segment, index, timeInSegment, clamped };
}

/**
 * 把一个全局时间区间 [startGlobal, endGlobal) 按分段边界拆成若干调用片段。
 *
 * 这是 WP3 的核心：窗口落在哪个文件就用该文件 + 文件内时间；窗口跨文件就按文件边界拆开，
 * 每片都带回它的全局起点（globalStart）—— 拼回全局时间时用
 *   global = inFileTime + segment.globalStart
 * 这条不变式，而不是再加一次累加（累加容易和偏移量搞混）。
 *
 * 空区间、NaN、完全落在素材之外都返回空数组（安全默认值），不抛。
 * 分段时长全为 0（ffprobe 不可用且没兜底）时也会返回空数组 ——
 * 调用方必须先看 totalDuration，据此降级或报错，而不是把空结果当成「这段没有语音」。
 */
export function splitRangeBySegments(
  segments: SourceSegment[],
  startGlobal: number,
  endGlobal: number,
): Array<{
  file: string;
  segmentIndex: number;
  inFileStart: number;
  inFileEnd: number;
  globalStart: number;
  globalEnd: number;
}> {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('splitRangeBySegments: segments 为空，无法拆分区间');
  }
  const out: Array<{
    file: string;
    segmentIndex: number;
    inFileStart: number;
    inFileEnd: number;
    globalStart: number;
    globalEnd: number;
  }> = [];
  if (!Number.isFinite(startGlobal) || !Number.isFinite(endGlobal) || endGlobal <= startGlobal) return out;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const from = Math.max(startGlobal, s.globalStart);
    const to = Math.min(endGlobal, s.globalEnd);
    // 1e-6 秒的容差：窗口边界与分段边界经常正好相等
    if (to - from <= 1e-6) continue;

    let inFileStart = from - s.globalStart;
    let inFileEnd = to - s.globalStart;
    if (s.duration > 0) {
      inFileStart = Math.min(Math.max(inFileStart, 0), s.duration);
      inFileEnd = Math.min(Math.max(inFileEnd, 0), s.duration);
      if (inFileEnd - inFileStart <= 1e-6) continue;
    }
    inFileStart = round3(inFileStart);
    inFileEnd = round3(inFileEnd);
    out.push({
      file: s.path,
      segmentIndex: i,
      inFileStart,
      inFileEnd,
      // 由段内时间反推全局时间，保证「global = inFile + segment.globalStart」恒成立
      globalStart: round3(s.globalStart + inFileStart),
      globalEnd: round3(s.globalStart + inFileEnd),
    });
  }
  return out;
}

/**
 * 按固定窗口（分钟）切分整个时间轴，可选段间重叠。
 *
 * 重叠的用途：/ai/subtitle 无服务端缓存且按音频时长计费，段间留 5–10 秒重叠可以让
 * 「正好被切断的那句话」在两段里都出现，后处理时按时间戳去重即可。
 * 因此步进 = 段长 - 重叠，窗口本身长度不变（不超时、不涨价）。
 *
 * 末尾会产出一个可能很短的窗口（例如 3600s / 1800s 段 + 8s 重叠 → [3584,3600]）：
 * 这是固定步进的必然结果，成本可以忽略，比「把它并进上一段导致上一次调用超时」划算。
 */
export function planWindows(
  totalDuration: number,
  opts: { segmentMinutes: number; overlapSeconds: number; maxWindows?: number },
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const total = Number.isFinite(totalDuration) ? totalDuration : 0;
  if (total <= 0) return out;

  const segmentMinutes = opts?.segmentMinutes;
  if (!Number.isFinite(segmentMinutes) || segmentMinutes <= 0) {
    // 非正数的段长会让窗口不前进（死循环）或产生无穷多窗口，必须立刻暴露
    throw new Error(`planWindows: segmentMinutes 必须为正数（收到 ${String(segmentMinutes)}）`);
  }
  const segSec = segmentMinutes * 60;
  const rawOverlap = Number.isFinite(opts?.overlapSeconds) ? opts.overlapSeconds : 0;
  // 重叠不得 >= 段长，否则步进 <= 0；这里收敛到段长以内并保证步进至少 1 秒
  const overlap = Math.max(0, Math.min(rawOverlap, segSec - 1));
  const step = Math.max(1, segSec - overlap);

  const maxWindows =
    opts?.maxWindows && opts.maxWindows > 0 ? Math.floor(opts.maxWindows) : DEFAULT_MAX_WINDOWS;

  let start = 0;
  while (start < total) {
    const end = Math.min(start + segSec, total);
    out.push({ start: round3(start), end: round3(end) });
    if (end >= total) break;
    // 上限同时兜住两种意外：totalDuration 被误传成毫秒（1.7e12），以及重叠被配成极端值
    if (out.length >= maxWindows) break;
    start += step;
  }
  return out;
}

/* ============================================================================
 * 录制记录归一化 + 录制完成判定
 * ========================================================================== */

/**
 * ★ 陷阱 #10：list 接口是下划线风格、recent-clips 是驼峰，字段名不一致。
 * 本函数同时兼容两种，并统一时间戳单位（陷阱 #9：秒 / 毫秒混用）。
 * 单位约定：liveStartTime 用秒（B站对外口径），recordStartTime / recordEndTime 用毫秒
 * （录制器给的是毫秒，减出来的时长正好也是毫秒）。
 */
export function normalizeRecord(raw: RawRecordLike): NormalizedRecord {
  const r = (raw ?? {}) as RawRecordLike;
  const rec = r as Record<string, unknown>;

  /** 按候选键取第一个「有效」值（null / undefined / 空串都算未提供） */
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      const v = rec[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };

  const record: NormalizedRecord = {
    // id 缺失时留空串而不抛：调用方（trigger）会用自己的 taskId 兜底，这里不该替它决定
    id: toStr(pick('id', 'record_id', 'recordId')) ?? '',
    title: toStr(pick('title', 'live_title', 'liveTitle', 'name')) ?? '',
    raw: r,
  };

  const liveStartTime = toSec(toNumber(pick('live_start_time', 'liveStartTime')));
  const recordStartTime = toMs(toNumber(pick('record_start_time', 'recordStartTime')));
  const recordEndTime = toMs(toNumber(pick('record_end_time', 'recordEndTime')));
  const videoPath = toStr(pick('video_file', 'videoFilePath', 'video_file_path', 'videoPath'));
  const videoDurationSec = toSec(toNumber(pick('video_duration', 'videoDuration')));
  const danmaCount = toNumber(pick('danma_num', 'danmaCount', 'danmaku_num'));

  if (liveStartTime !== undefined) record.liveStartTime = liveStartTime;
  if (recordStartTime !== undefined) record.recordStartTime = recordStartTime;
  if (recordEndTime !== undefined) record.recordEndTime = recordEndTime;
  if (videoPath !== undefined) record.videoPath = videoPath;
  if (videoDurationSec !== undefined) record.videoDurationSec = videoDurationSec;
  if (danmaCount !== undefined) record.danmaCount = danmaCount;
  return record;
}

/**
 * 判断「录制完成」的静态条件（不含下播确认，下播确认由 trigger.ts 负责）：
 *   1) recordEndTime 有值（录制器已经收了尾）
 *   2) 视频文件存在且大小 > 0
 *   3) 若给了 prevSize，则要求本次 size 与 prevSize 相同（两次采样不再变化 → 确认没在写）
 *
 * 三条都只是「静态证据」。真正判定「人下播了」还需要 trigger 侧的下播确认与
 * danmaku / API 侧的对账，所以这里只返回证据结论，不做任何等待或轮询。
 *
 * 关于 prevSize：只要传了就参与比较（传 0 也算一次真实采样 —— 说明上一次文件是空的，
 * 此时本次 size > 0 必然不相等，结论是「仍在写入」，这正是期望行为）。
 * 不希望参与比较就不要传这个字段，而不是传 0 表示「未知」。
 */
export function isRecordComplete(
  rec: NormalizedRecord,
  opts?: { prevSize?: number; minSizeBytes?: number },
): { complete: boolean; reason: string; size: number; fileExists: boolean } {
  const videoPath = rec?.videoPath;
  // 先做 stat：无论结论如何，size / fileExists 都是调用方要写进日志与 UI 的证据
  const fileExists = Boolean(videoPath) && exists(videoPath!);
  const size = fileExists ? fileSize(videoPath!) : 0;
  const done = (complete: boolean, reason: string): { complete: boolean; reason: string; size: number; fileExists: boolean } => ({
    complete,
    reason,
    size,
    fileExists,
  });

  if (!videoPath) return done(false, '录制记录没有视频文件路径（video_file / videoFilePath 均为空）');
  if (rec.recordEndTime === undefined) return done(false, '录制尚未结束（record_end_time 为空）');
  if (!fileExists) return done(false, `录制文件不存在或尚不可访问：${videoPath}`);
  if (size <= 0) return done(false, '录制文件大小为 0（可能仍在写入，或录制器启动失败）');

  const minSize = opts?.minSizeBytes;
  if (typeof minSize === 'number' && Number.isFinite(minSize) && minSize > 0 && size < minSize) {
    return done(false, `文件只有 ${fmtBytes(size)}，小于下限 ${fmtBytes(minSize)}（疑似录制失败，判为未完成）`);
  }

  const prevSize = opts?.prevSize;
  if (typeof prevSize === 'number' && Number.isFinite(prevSize) && size !== prevSize) {
    return done(false, `文件大小仍在变化（本次 ${fmtBytes(size)}，上次 ${fmtBytes(prevSize)}），可能仍在写入`);
  }
  return done(
    true,
    typeof prevSize === 'number' && Number.isFinite(prevSize)
      ? `录制已完成：${fmtBytes(size)}，两次采样大小一致`
      : `录制已完成：${fmtBytes(size)}`,
  );
}

/* ============================================================================
 * 组装 SourceMedia
 * ========================================================================== */

/** 按扩展名判断弹幕文件类型（.ass/.xml/.srt，大小写不敏感）；也接受裸扩展名（'ass' / '.ass'） */
export function danmaKind(filePath: string | undefined): 'ass' | 'xml' | 'srt' | 'unknown' {
  if (!filePath || typeof filePath !== 'string') return 'unknown';
  const s = filePath.trim().toLowerCase();
  if (!s) return 'unknown';
  const ext = path.extname(s);
  // extname 对裸扩展名（'ass'）与点开头的名字（'.ass'）会返回空，这里统一退化处理
  const token = (ext || s).replace(/^\./, '');
  if (token === 'ass') return 'ass';
  if (token === 'xml') return 'xml';
  if (token === 'srt') return 'srt';
  return 'unknown';
}

/**
 * 组装本场 SourceMedia。
 *
 * 硬约束 #12：fullVideoHasDanmaku **只由调用方传入的配置决定**，本函数不做任何探测或猜测 ——
 * 猜错的后果是「以为弹幕已经烧进画面，于是又叠了一层」或者「以为没烧，实际烧了导致重复」，
 * 两者都会让成片画面错乱，且事后无法从文件本身分辨。
 *
 * 弹幕文件分流：ASS 用于烧录，XML 用于信号分析（SC / 上舰 / 礼物），SRT 两者都不适合，只记警告。
 */
export function buildSourceMedia(input: {
  rawFiles: string[];
  fullVideoPath?: string;
  fullVideoHasDanmaku: boolean;
  danmaFilePath?: string;
  danmaFileExt?: string;
  danmaCount?: number;
  ffprobePath?: string;
  fallbackDurationSec?: number;
}): SourceMedia {
  if (!input || !Array.isArray(input.rawFiles) || input.rawFiles.length === 0) {
    throw new Error('buildSourceMedia: rawFiles 为空，无法组装源素材');
  }

  const { segments, totalDuration, warnings } = buildSegmentMap(input.rawFiles, {
    ffprobePath: input.ffprobePath,
    fallbackDurationSec: input.fallbackDurationSec,
  });
  // SourceMedia 没有 warnings 字段（它是台账结构，不塞进诊断信息），
  // 所以这里借助全局 logger 落地，保证「用兜底时长跑出来的时间轴」在日志里可追溯
  for (const w of warnings) log.warn(w, { mod: 'media' });

  const media: SourceMedia = {
    segments,
    totalDuration,
    rawFiles: [...input.rawFiles],
    fullVideoHasDanmaku: input.fullVideoHasDanmaku === true,
  };

  const fullVideoPath = toStr(input.fullVideoPath);
  if (fullVideoPath) {
    // 压制产物可能还没落盘（异步任务），路径先记下，是否存在由 UI/后续阶段用 exists 判定
    media.fullVideoPath = fullVideoPath;
    if (!exists(fullVideoPath)) log.debug(`压制产物尚未落盘：${fullVideoPath}`, { mod: 'media' });
  }

  const danmaFilePath = toStr(input.danmaFilePath);
  if (danmaFilePath) {
    // 以真实文件名的扩展名为准，接口给的 danmaFileExt 只作为兜底（两者偶有不一致）
    let kind = danmaKind(danmaFilePath);
    if (kind === 'unknown') kind = danmaKind(input.danmaFileExt);
    if (kind === 'ass') {
      media.danmaAssPath = danmaFilePath;
    } else if (kind === 'xml') {
      media.danmaXmlPath = danmaFilePath;
    } else if (kind === 'srt') {
      log.warn(`弹幕文件是 SRT（${danmaFilePath}）：既不能烧录也不能做事件信号分析，已忽略`, { mod: 'media' });
    } else {
      log.warn(`无法识别弹幕文件类型：${danmaFilePath}（接口扩展名=${input.danmaFileExt ?? '未提供'}）`, { mod: 'media' });
    }
    if (!exists(danmaFilePath)) log.warn(`弹幕文件不存在：${danmaFilePath}`, { mod: 'media' });
  } else if (input.danmaFileExt) {
    // 只有扩展名没有路径：拿不到文件就没法用，留一条 debug 便于排查接口返回
    log.debug(`接口返回了弹幕扩展名 ${input.danmaFileExt} 但没有文件路径，已忽略`, { mod: 'media' });
  }

  if (typeof input.danmaCount === 'number' && Number.isFinite(input.danmaCount) && input.danmaCount >= 0) {
    media.danmaCount = input.danmaCount;
  }
  return media;
}

/* ============================================================================
 * 磁盘与分段发现
 * ========================================================================== */

/**
 * 目录剩余空间（字节）。Windows 上用 fs.statfs（Node 18.15+ 支持）。
 *
 * 首启时 data/ 目录可能还不存在，因此沿父目录向上找到最近的存在者再取 ——
 * 直接 statfs 一个不存在的路径在 Windows 上会抛 ENOENT，而「首次运行时磁盘够不够」
 * 恰恰是最需要判断的时刻。
 */
export function diskFreeBytes(dir: string): { free: number; total: number } | undefined {
  if (!dir || typeof dir !== 'string') return undefined;

  let target = dir;
  let guard = 0;
  while (!exists(target) && guard++ < 64) {
    const parent = path.dirname(target);
    if (!parent || parent === target) break;
    target = parent;
  }
  if (!exists(target)) target = process.cwd();

  try {
    const st = fs.statfsSync(target);
    const bsize = toNumber(st.bsize) ?? 0;
    // bavail 是「非特权用户可用块数」，比 bfree 更贴近我们真正能写的量
    const free = (toNumber(st.bavail) ?? 0) * bsize;
    const total = (toNumber(st.blocks) ?? 0) * bsize;
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return undefined;
    return { free: Math.round(free), total: Math.round(total) };
  } catch {
    // 老版本 Node / 不支持 statfs 的文件系统：宁可返回 undefined 让调用方跳过磁盘检查
    return undefined;
  }
}

/** 分段命名模式：能判定「哪些文件名与样本属于同一组」 */
interface SegmentPattern {
  match(name: string): number | undefined;
  /**
   * 「第 0 段还可能叫**基名文件**」时给出那个基名（`X-PART001.ts` → `X.ts`），否则 undefined。
   *
   * 为什么需要它（2026-09-24 实测，丁主播那场）：
   *   biliLive-tools 把一场连续直播按分钟切段时，**第 1 段叫 `X.ts`（没有 PART 后缀）**，
   *   之后才是 `X-PART001.ts` / `X-PART002.ts`。实测 `X.ts` 的 NTFS 创建时间 = 会话开始时刻，
   *   修改时间 = 第 1 段结束时刻，确认它就是第 1 段本体（录到一半时它叫 `X-PART000.ts`，
   *   切段瞬间被改名成基名并继续写）。
   *
   *   只认 `-PART\d+` 的话：`X.ts` 自己一组（1 段），`X-PART001/002` 另成一组（2 段）——
   *   一场直播被切成两个任务，而且**第 1 段（前 20 分钟）在第二组里直接丢失**。
   */
  baseFileName?: string;
}

/**
 * 找出同一场的所有分段并按序返回。
 *
 * 保守策略（宁可少合并，不可错合并）：
 *  - 只认两种命名：`name.part3` 这种显式分段标记，以及 `name-01` / `name_0001` 这种
 *    「分隔符 + 最长 6 位数字」的尾缀；
 *  - 必须同目录、同前缀（区分大小写）、同扩展名（不区分大小写）；
 *  - **只有确实凑到 ≥2 个同类文件时才返回多个**，否则原样返回 [samplePath]；
 *  - 「基名文件 = 第 0 段」只对 **`PART` 标记**形态启用（见 `SegmentPattern.baseFileName`），
 *    不对 `.part1` / `-01` 这类更含糊的形态启用。
 *
 * 为什么保守：录制器常把开播时间写进文件名（`xxx 2024-01-02 20-00-00.flv`），
 * 这类名字天然带 `-数字` 尾缀。激进的前缀剥离会把同一天不同场次的录像合并成一场，
 * 时间轴全错且很难发现；而漏合并的代价只是回到单文件处理（上层仍能用 live_id 聚合）。
 */
export function discoverSegments(samplePath: string): string[] {
  if (!samplePath || typeof samplePath !== 'string') return [];
  const dir = path.dirname(samplePath);
  const base = path.basename(samplePath);
  const pattern = segmentPattern(base);
  if (!pattern) return [samplePath];

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // 目录不可读（尚未创建 / 权限不足）：无法确认同组文件，按单文件处理
    return [samplePath];
  }

  const matched: Array<{ file: string; num: number }> = [];
  for (const name of entries) {
    const num = pattern.match(name);
    if (num === undefined) continue;
    matched.push({ file: path.join(dir, name), num });
  }

  /* ★ 第 0 段补位：录制器把**第 1 段**写成基名 `X.ts`（没有 PART 后缀），
     而正在录的那一段叫 `X-PART{n}.ts` —— 只认后缀会让它们分属两组。
     第 0 段补位后，`X.ts` + `X-PART001.ts`（第 2 段正在录）能拼成一场。

     ⚠️ **只在最小 PART 序号恰好是 1 时补**，这是一个必须守住的边界：
     段一关闭就被改名成「它自己的开始时刻 + 标题」，`-PART` 后缀随之消失。
     所以录到第 5 段时，基名 `X.ts`（= 第 1 段）旁边站着的是 `X-PART004.ts`（第 5 段）——
     此时补位会把第 1 段和第 5 段拼成"一场"，**中间三段被静默丢掉**。
     宁可只返回样本（上层退回单文件处理），也不能拼出一个缺了中间的时间轴。 */
  if (pattern.baseFileName) {
    const minPart = matched.length > 0 ? Math.min(...matched.map((m) => m.num)) : Number.POSITIVE_INFINITY;
    if (minPart === 1 && !matched.some((m) => m.num === 0)) {
      const want = pattern.baseFileName.toLowerCase();
      const hit = entries.find((n) => n.toLowerCase() === want);
      if (hit) matched.push({ file: path.join(dir, hit), num: 0 });
    }
  }

  // 样本自己必须在组里：否则说明前缀推断跑偏了（例如同名不同扩展名），此时不应合并
  if (matched.length < 2 || !matched.some((m) => path.basename(m.file) === base)) return [samplePath];

  // 必须按尾缀**数值**排序：字符串排序会把 name-10 排到 name-2 前面，时间轴顺序就反了
  matched.sort((a, b) => a.num - b.num || a.file.localeCompare(b.file));
  return matched.map((m) => m.file);
}

/** 从样本文件名推断分段编号规则；推断不出返回 undefined */
function segmentPattern(base: string): SegmentPattern | undefined {
  const ext = path.extname(base);
  // 没有扩展名（或形如 .flv 的隐藏文件）时不猜，避免把无关文件圈进来
  if (!ext || ext === base) return undefined;
  const stem = base.slice(0, base.length - ext.length);

  /**
   * 生成「前缀 + 数字 + 原扩展名」的匹配器。
   *
   * ⚠️ 必须带 `i` 标志（大小写不敏感），且前缀也一起不敏感。
   * 实测事故：本函数上面用 `/i` 认出了分段形态（`…_PART000.flv`、`…-PART000.ts`），
   * 但这里生成的匹配器没有 `i` —— 于是**连样本自己都匹配不上**，`matched` 恒为空、
   * `discoverSegments` 永远返回 `[samplePath]`：biliLive-tools 的多分段录播被当成
   * N 场分别导入（N 次转写、N 次选片、N 份投稿），而日志里一切正常。
   * 实测证据：`…来两下闪身步就好了_PART000.flv` + `_PART001.flv`（同一时间戳）返回 1 段。
   */
  const make = (prefix: string, sep: string, marker: string, opts: { baseIsPartZero?: boolean } = {}): SegmentPattern => {
    const re = new RegExp(
      `^${escapeRe(prefix)}${escapeRe(sep)}${marker}(\\d{1,6})(\\.[^.]*)$`,
      'i',
    );
    return {
      match(name: string): number | undefined {
        const m = re.exec(name);
        if (!m) return undefined;
        if ((m[2] ?? '').toLowerCase() !== ext.toLowerCase()) return undefined;
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : undefined;
      },
      ...(opts.baseIsPartZero ? { baseFileName: `${prefix}${ext}` } : {}),
    };
  };

  // 形态 A：显式分段标记（name.part1.flv / name_seg_02.ts / name_PART000.flv），最可靠，优先
  // ⚠️ 分隔符必须**捕获下来传给 `make`**：早先把 `[._\- ]?` 丢在组外、`sep` 传空串，
  //    生成的匹配器就要求「前缀紧接 part」，而真实文件名是 `前缀_PART000` —— 于是永远匹配不上。
  // ⚠️ marker 必须**捕获**（早先是 `(?:...)` 非捕获组）：只有知道具体是哪个词，
  //    才能判断该不该启用「基名文件 = 第 0 段」—— 只对 `PART` 启用，`seg`/`vol` 不启用。
  const partMatch = /^(.*?)([._\- ]?)(part|seg|segment|vol)([._\- ]?)(\d{1,6})$/i.exec(stem);
  if (partMatch) {
    const prefix = partMatch[1] ?? '';
    const sep = partMatch[2] ?? '';
    const marker = (partMatch[3] ?? '').toLowerCase();
    if (prefix) return make(prefix, sep, '(?:part|seg|segment|vol)', { baseIsPartZero: marker === 'part' });
  }

  // 形态 B：分隔符 + 数字尾缀（name-01.flv / name_0001.ts）
  // 惰性量词保证只剥掉**最后**一段数字，`a-1-2` → 前缀 `a-1`
  const tailMatch = /^(.*?)([._\- ])(\d{1,6})$/.exec(stem);
  if (tailMatch) {
    const prefix = tailMatch[1] ?? '';
    const sep = tailMatch[2] ?? '';
    if (prefix) return make(prefix, sep, '');
  }

  /* 形态 C：**样本自己就是基名（= 第 0 段）**。
     `X.ts` 自身不含分段后缀，上面两种形态都识别不了；这时用 `X-PART000.ts` 反推一次，
     如果推出来的 `baseFileName` 正好等于 `base`（大小写不敏感），说明「目录里可能存在
     `X-PART001.ts` 这样的后续分段」——把模式交给 `discoverSegments`，
     由它去目录里确认到底有没有（一个都没有时仍然按单文件返回）。
     这个自校验很重要：否则任何 `abc.ts` 都会得到一个瞎猜的模式。 */
  const probe = `${stem}-PART000${ext}`;
  const viaProbe = segmentPattern(probe);
  if (viaProbe?.baseFileName && viaProbe.baseFileName.toLowerCase() === base.toLowerCase()) return viaProbe;

  return undefined;
}

/** 便于排查时打印分段概览（不含大段代码，仅人读摘要） */
export function describeSegments(segments: SourceSegment[]): string {
  if (!segments || segments.length === 0) return '(无分段)';
  const bad = segments.filter((s) => s.duration <= 0).length;
  const total = segments.reduce((a, s) => a + s.duration, 0);
  return `${segments.length} 段 / 共 ${fmtDuration(total)}${bad ? ` / ⚠ ${bad} 段探测不到时长` : ''}`;
}
