/**
 * WP3 —— 转写接入（任务书 §4.2 / §5.1 / §5.2 / §8 WP3）。
 *
 * 本模块是项目里**唯一花钱**的地方（云 ASR 按音频时长计费），因此正确性周边全是硬约束：
 *
 *  1. 输入是**录制原始文件（flv）**，不是压制后的 mp4 —— 这样转写才能与压制并行（§4.2）。
 *  2. 原始文件通常是**分段的**，因此必须先建「分段文件 → 全局时间」映射，
 *     窗口落在哪个文件就用该文件 + **文件内时间**；跨文件按边界拆分（陷阱 #30）。
 *  3. `/ai/subtitle` 是同步阻塞接口，**必须分段调用**且 `startTime`/`endTime` 成对（硬约束 #7）。
 *  4. 该接口在源码里 `disableCache: true` —— **重复调试重复计费**（陷阱 #3），
 *     所以必须本地落盘缓存；缓存键**不得使用 `videoFileId`**（它在 biliLive-tools 重启后会变，陷阱 #31）。
 *  5. 断点续跑直接关系到钱：进程中断后必须从第一个未完成的段继续（§8 WP3 步骤 5）。
 *  6. `--dry-run` 默认复用缓存；无缓存时**不得自动调用付费 ASR**，必须显式 `--allow-paid`（硬约束 #14）。
 *  7. 单段失败重试 3 次后跳过并记录，在 `transcript.json` 中写入 `gaps`。
 *  8. 接口保持可替换：换成 whisper.cpp 独立程序时，`transcript.json` 的结构不变（§5.2）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import type { AsrCacheEntry, RequestContext, Transcript, TranscriptGap, TranscriptSegment } from './types.ts';
import type { AppConfig } from './config.ts';
import { BiliLiveClient, ApiError } from './api.ts';
import type { ErrorType, RetryAttempt } from './types.ts';
import {
  ASR_CACHE_DIR,
  ROOT_DIR,
  backoffMs,
  createLimiter,
  ensureDir,
  exists,
  fileSize,
  fmtDuration,
  hashKey,
  nowIso,
  parseSrtTime,
  readJson,
  sleep,
  writeJsonAtomic,
} from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';

/* ============================================================================
 * 本地 ASR 执行器（provider = 'whisper-cpp'）
 * ========================================================================== */

/** 本地执行器的返回结构（与 tools/local-asr/transcribe.py 的 stdout 契约一致） */
interface LocalAsrResult {
  ok: boolean;
  error?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  language?: string;
  duration?: number;
  device?: string;
  compute_type?: string;
  elapsed_ms?: number;
}

/** 本地 ASR 的执行参数（由配置组装） */
interface LocalAsrOptions {
  /** 执行器引擎：whisper（faster-whisper）或 funasr（阿里云开源 Fun-ASR-Nano） */
  engine: 'whisper' | 'funasr';
  pythonPath: string;
  scriptPath: string;
  model: string;
  modelDir: string;
  language: string;
  device: string;
  computeType: string;
  beamSize: number;
  vadFilter: boolean;
  timeoutMs: number;
  /* ---- Fun-ASR 专有 ---- */
  hub?: string;
  enginePreference?: string;
  maxCharsPerCue?: number;
  minCueDur?: number;
  timestamps?: boolean;
  /**
   * 热词（只有 **Fun-ASR** 支持；whisper 的 `initial_prompt` 与云端 DashScope 定制热词
   * 都还没接）。它是"零新依赖、零显存、零幻觉风险"的一档提升：不改模型也不改流程，
   * 只是把用户已经在维护的术语表顺路带给模型 —— 而这条线此前一直没接。
   */
  hotwords?: string[];
}

/**
 * 调用本地 ASR 执行器（子进程 + stdin JSON 协议）。
 *
 * 为什么走子进程而不是内置实现：本地识别依赖 CTranslate2（原生扩展），
 * 而本项目硬约束是**不引入需要编译的依赖**。所以本地识别作为**可选外部执行器**存在，
 * 主项目只 spawn 它 —— 这样 `npm run verify` 在任何机器上都不受影响。
 *
 * ⚠️ 超时必须显式给：whisper 在 CPU 上处理长音频可能几十分钟，
 *    但**卡死**（例如 CUDA 库加载失败后的重试）也必须能被打断。
 */
function runLocalAsr(args: {
  opts: LocalAsrOptions;
  file: string;
  startTime: number;
  endTime: number;
  offset: number;
}): Promise<LocalAsrResult> {
  const { opts } = args;
  const spec = buildLocalAsrSpec(opts, args);
  return new Promise<LocalAsrResult>((resolve, reject) => {
    const child = execFile(
      opts.pythonPath,
      [opts.scriptPath],
      {
        timeout: opts.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        /* Python 在 Windows 往管道写 stdout 默认用控制台代码页（GBK），
           调用方按 UTF-8 解码就是一堆乱码且**不报错**。
           实测代价：本地 Fun-ASR 的 CER 被算成 169%，看着像"模型完全不行"。
           runner 自己也 reconfigure 了，这里是第二层保险。 */
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`本地 ASR 执行失败：${err.message}${stderr ? `（stderr 尾部：${String(stderr).slice(-300)}）` : ''}`));
          return;
        }
        try {
          resolve(parseLocalAsrOutput(String(stdout)));
        } catch (e) {
          reject(new Error(`${(e as Error).message}；stderr 尾部：${String(stderr).slice(-300)}`));
        }
      },
    );
    child.stdin?.end(JSON.stringify(spec), 'utf8');
  });
}

/**
 * 组装本地 ASR 的 spec（**whisper 与 Fun-ASR 两套字段，按 engine 分叉**）。
 *
 * 单独抽成导出函数是为了能单测：解析/组装这类纯逻辑一旦写歪，
 * 表现是"跑了几十分钟才失败"，而单测能在毫秒级抓住。
 */
export function buildLocalAsrSpec(
  opts: LocalAsrOptions,
  args: { file: string; startTime: number; endTime: number; offset: number },
): Record<string, unknown> {
  if (opts.engine === 'funasr') {
    return {
      file: args.file,
      start_time: args.startTime,
      end_time: args.endTime,
      offset: args.offset,
      model: opts.model,
      hub: opts.hub ?? 'ms',
      language: '中文',
      device: opts.device || 'auto',
      engine: opts.enginePreference ?? 'auto',
      max_chars_per_cue: opts.maxCharsPerCue ?? 18,
      min_cue_dur: opts.minCueDur ?? 0.6,
      timestamps: opts.timestamps !== false,
      /* 热词为空时**不写这个字段**：让 spec 干净，也便于在日志/测试里一眼看出
         "这次到底带没带热词"（执行器那边 `spec.get("hotwords") or []` 本来就容错）。 */
      ...(opts.hotwords && opts.hotwords.length > 0 ? { hotwords: opts.hotwords } : {}),
    };
  }
  return {
    file: args.file,
    start_time: args.startTime,
    end_time: args.endTime,
    offset: args.offset,
    model: opts.model,
    model_dir: opts.modelDir || undefined,
    language: opts.language || 'zh',
    device: opts.device || 'auto',
    compute_type: opts.computeType || 'auto',
    beam_size: opts.beamSize,
    vad_filter: opts.vadFilter,
  };
}

/**
 * 解析本地执行器的 stdout。
 *
 * ⚠️ 不能直接 `JSON.parse(stdout)`：第三方库（funasr）在 import 时会往 stdout 打版本横幅，
 * 模型加载与推理也会打进度。runner 已经把库输出改道 stderr，但这里再兜一层 ——
 * 取**最后一个**带 `ok` 字段的 JSON 行。
 */
export function parseLocalAsrOutput(stdout: string): LocalAsrResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as LocalAsrResult;
      if (parsed && typeof parsed.ok === 'boolean') return parsed;
    } catch {
      /* 试下一行 */
    }
  }
  throw new Error(`本地 ASR 输出里找不到结果 JSON（前 200 字：${stdout.slice(0, 200)}）`);
}

/* ============================================================================
 * 对外契约
 * ========================================================================== */

/** 一个「窗口 × 文件」调用单元：全局时间区间落在哪个文件、文件内起止是多少 */
export interface WindowCall {
  /** 要提交给 /ai/subtitle 的文件绝对路径 */
  file: string;
  /** 相对该文件起点的秒 */
  inFileStart: number;
  /** 相对该文件起点的秒 */
  inFileEnd: number;
  /** 该单元对应的全局时间起点（秒）—— 用于把段内时间戳拼回全局 */
  globalStart: number;
  globalEnd: number;
  /**
   * 传给接口的 offset。
   * 实测结论：offset=0 时 SRT 时间戳相对**本次提交的音频片段起点**，
   * 因此全局时间 = 段内时间戳 + globalStart。offset 保留为可覆盖项以便兼容行为差异。
   */
  offset: number;
  /** 片段索引（用于日志与缓存键的可读性） */
  windowIndex: number;
}

/** 媒体访问适配器：把「分段映射」与「文件属性」从 media.ts 注入，避免循环依赖 */
export interface AsrMediaAdapter {
  /** 把全局时间区间拆成若干个「文件 + 文件内区间」调用单元 */
  planCalls(range: { start: number; end: number }): WindowCall[];
  /** 文件大小与修改时间（缓存键成员，替代不稳定的 videoFileId） */
  fileStat(file: string): { size: number; updatedAt: number };
  /** 可选：本地 ffprobe 路径（剪静音时用来抽音频） */
  ffprobePath?: string;
}

export interface TranscribeOptions {
  taskId: string;
  /** 媒体适配器（由 media.ts 构建） */
  media: AsrMediaAdapter;
  /** 视频全局总时长（秒） */
  totalDuration: number;
  /** 强制重新转写（忽略缓存） */
  force?: boolean;
  /** dry-run：只复用缓存，缺缓存则报错而非付费 */
  dryRun?: boolean;
  /** 显式允许产生费用（dry-run 下必须显式开启才允许付费调用） */
  allowPaid?: boolean;
  signal?: AbortSignal;
  /** 进度回调：用于 UI 的「转写中 12/24」 */
  onProgress?: (p: { current: number; total: number; label: string }) => void;
}

export interface TranscribeResult {
  transcript: Transcript;
  /** 本次实际发生的付费调用次数（用于成本与自检） */
  paidCalls: number;
  /** 命中缓存的段数 */
  cacheHits: number;
  /** 失败并被跳过的段 */
  failedWindows: number;
  warnings: string[];
  durationMs: number;
}

/* ============================================================================
 * dry-run 安全阀的语义判定
 * ========================================================================== */

/**
 * dry-run 安全阀写入 `gaps[].reason` 的**完整**前缀。
 *
 * 这是 **asr 层与编排层之间的一道字符串契约**：asr 在被安全阀拦下时用它标记原因，
 * 编排层（daemon）据此判断"空转写"到底是"设计内的安全拦截"还是"真的跑挂了"。
 * 抽成常量而不是两处各写一遍字面量，就是为了让这个契约不会随文案改动而悄悄断掉。
 *
 * 格式必须是 `contract: dry-run`（**含 type**）—— 因为 gaps 的组装处是
 * ``reason: `${r.failed.type}: ${r.failed.message}` ``，type 已经拼在前面了。
 * 所以 asr 写 message 时必须用 {@link DRY_RUN_REJECT_PREFIX_NOUN}（不含 type），
 * 否则会变成 `contract: contract: dry-run ...`，前缀判定永远不匹配（实测踩过）。
 */
export const DRY_RUN_REJECT_PREFIX = 'contract: dry-run';

/**
 * 只表示"这是一次 dry-run 付费拦截"的**名词短语**，不含 `contract: ` 前缀。
 * asr 层写 `failed.message` 用它；gaps 组装处会自动在前面补上 `type`。
 */
export const DRY_RUN_REJECT_PREFIX_NOUN = 'dry-run';

/**
 * 空转写是否**完全**由「dry-run 按硬约束 #14 拒绝付费」造成。
 *
 * 实测事故（2026-09-23 20:51）：dry-run 的服务实例对两个手动导入的预检任务
 * （2.0 / 4.7 分钟）各抛一次"语音识别没有产出任何字幕"的 Error，被编排层的 catch
 * 归为 `type: 'internal'` 写进 `data/errors.jsonl`。于是「近 24h 错误」里混进了
 * 设计内的安全拦截，真正的故障被淹没 —— 统计必须能区分这两者。
 *
 * 判据（三个条件同时成立才算）：
 *   1. `segments` 为空（否则不是"空转写"）；
 *   2. `gaps` 非空（否则连失败原因都没有，不能假设是安全阀拦的）；
 *   3. 每个 gap 的原因都以 {@link DRY_RUN_REJECT_PREFIX} 开头 —— **全部**窗口
 *      都是被安全阀拦下的。只要有一个窗口是真实失败（网络/上游 5xx/模型不支持），
 *      就必须照常报错，不能拿"没付费"当挡箭牌把真故障吞掉。
 */
export function isDryRunPaymentRejection(t: { segments: unknown[]; gaps?: Array<{ reason?: string }> }): boolean {
  if (t.segments.length > 0) return false;
  const gaps = t.gaps ?? [];
  if (gaps.length === 0) return false;
  return gaps.every((g) => (g.reason ?? '').startsWith(DRY_RUN_REJECT_PREFIX));
}

/* ============================================================================
 * SRT 解析
 * ========================================================================== */

/**
 * 解析 SRT 为 `[{start, end, text}]`。
 * 容错点：BOM、CRLF、序号缺失、时间行前后有空格、`-->` 两侧空格不规范、
 * 一条字幕多行文本（合并为一行，用空格连接）。
 */
export function parseSrt(content: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const m = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/.exec(lines[timeIdx]!);
    if (!m) continue;
    const start = parseSrtTime(m[1]!);
    const end = parseSrtTime(m[2]!);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const body = lines
      .slice(timeIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '') // 去掉 <i> 之类的样式标签
      .trim();
    if (!body) continue;
    out.push({ start, end: Math.max(end, start), text: body });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/* ============================================================================
 * 缓存
 * ========================================================================== */

/**
 * 缓存键：`hash(videoFilePath + videoFileSize + videoFileUpdatedAt + modelId + startTime + endTime + offset)`
 *
 * ⚠️ 陷阱 #31：**不要用 `videoFileId`** —— 它来自 biliLive-tools 内存中的 fileCache
 * （24 小时过期、进程重启即清空），重启后同一文件会拿到新 id，导致本地缓存全部失效、重跑时重复计费。
 */
export function asrCacheKey(parts: {
  videoFilePath: string;
  videoFileSize: number;
  videoFileUpdatedAt: number;
  modelId: string;
  startTime: number;
  endTime: number;
  offset: number;
  /** 剪静音开启时把音频时间轴参数也纳入，避免与未剪静音的缓存混用 */
  trim?: string;
  /**
   * 热词指纹（只有本地 Fun-ASR 有）。
   *
   * ⚠️ 必须进键：热词会**实质改变输出**。不进键的话"打开/修改热词后重跑"会直接命中
   * 旧缓存，用户看到的是"我改了设置却毫无变化" —— 本项目最忌讳的那种静默失效。
   *
   * ⚠️ 用**条件追加**而不是固定位置：固定加一个空槽位会让 hashKey 的输入数组变长，
   * 于是**所有既有缓存键一起失效**（云端按小时计费，那是真金白银的重跑）。
   * 这里只在有热词时追加，没热词时键与从前逐字节相同。
   */
  hotwords?: string;
}): string {
  const base = [
    parts.videoFilePath,
    parts.videoFileSize,
    parts.videoFileUpdatedAt,
    parts.modelId || 'default',
    parts.startTime.toFixed(3),
    parts.endTime.toFixed(3),
    parts.offset.toFixed(3),
    parts.trim ?? '',
  ];
  if (parts.hotwords) base.push(`hw:${parts.hotwords}`);
  return hashKey(base);
}

export class AsrCache {
  private dir: string;
  private logger: Logger;
  /** 会话内索引，避免每次都读盘 */
  private index = new Map<string, AsrCacheEntry>();

  constructor(dir: string = ASR_CACHE_DIR, logger: Logger = globalLog) {
    this.dir = dir;
    this.logger = logger;
    ensureDir(this.dir);
    this.loadIndex();
  }

  private fileOf(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  private loadIndex(): void {
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const entry = readJson<AsrCacheEntry>(path.join(this.dir, f));
          if (entry?.key) this.index.set(entry.key, entry);
        } catch {
          /* 单条坏缓存不影响其它 */
        }
      }
    } catch {
      /* 目录不存在等 */
    }
  }

  get(key: string): AsrCacheEntry | undefined {
    const mem = this.index.get(key);
    if (mem) return mem;
    const f = this.fileOf(key);
    if (!exists(f)) return undefined;
    try {
      const entry = readJson<AsrCacheEntry>(f);
      this.index.set(key, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  set(entry: AsrCacheEntry): void {
    this.index.set(entry.key, entry);
    try {
      writeJsonAtomic(this.fileOf(entry.key), entry);
    } catch (e) {
      // 缓存写不进去只是浪费钱，不能打断链路
      this.logger.warn('ASR 缓存写盘失败（不影响本次结果，但下次可能重复计费）', { mod: 'asr', data: { key: entry.key, error: (e as Error).message } });
    }
  }

  /** 已有缓存的段数（用于 dry-run 预检「能跑几段、要花几段」） */
  stats(): { count: number; audioSeconds: number } {
    let audioSeconds = 0;
    for (const e of this.index.values()) audioSeconds += e.audioSeconds ?? 0;
    return { count: this.index.size, audioSeconds };
  }

  /** 缓存目录占用（数量与字节） */
  sizeInfo(): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.json')) continue;
        files++;
        bytes += fileSize(path.join(this.dir, f));
      }
    } catch {
      /* ignore */
    }
    return { files, bytes };
  }
}

/* ============================================================================
 * 段间重叠与合并（§4.2）
 * ========================================================================== */

/**
 * 合并相邻段，**优先信任后一段**。
 *
 * 理由（原文）：重叠内容落在后段的**开头**而非结尾 —— 前段的结尾处容易被截断，
 * 后段的开头有完整上下文，被切坏的风险更低。
 *
 * ⚠️ **不要按文本比对去重**：同一段话两次识别的断句可能不同，文本比对会误判。
 * 因此这里只做**时间区间**取舍。
 *
 * @param parts 按时间顺序排列的各段结果，每段带自己的全局区间
 * @param overlapSeconds 用于日志说明的期望重叠量
 */
export function mergeSegments(
  parts: Array<{ globalStart: number; globalEnd: number; segments: TranscriptSegment[] }>,
  overlapSeconds: number,
): { segments: TranscriptSegment[]; overlapsApplied: number } {
  if (parts.length === 0) return { segments: [], overlapsApplied: 0 };
  const sorted = [...parts].sort((a, b) => a.globalStart - b.globalStart);
  const out: TranscriptSegment[] = [];
  let overlapsApplied = 0;

  for (let i = 0; i < sorted.length; i++) {
    const part = sorted[i]!;
    const next = sorted[i + 1];
    // 本段的有效上界：若与下一段重叠，则让位给下一段（丢弃本段末尾的重叠区间）
    const effectiveEnd = next ? Math.min(part.globalEnd, next.globalStart) : part.globalEnd;
    if (next && next.globalStart < part.globalEnd) overlapsApplied++;

    for (const seg of part.segments) {
      // 段内时间戳（相对本段音频起点）已经由调用方加上了 globalStart
      const start = seg.start;
      const end = Math.min(seg.end, effectiveEnd);
      if (end <= start) {
        // 整条都落在让位区间里 → 丢弃（后一段会有更完整的版本）
        continue;
      }
      out.push({ start, end, text: seg.text });
    }
  }

  // 兜底去重：完全相同时间区间 + 相同文本的重复项（同一段被两次调用完整覆盖的情况）
  const deduped: TranscriptSegment[] = [];
  const seen = new Set<string>();
  for (const s of out) {
    const k = `${s.start.toFixed(2)}|${s.end.toFixed(2)}|${s.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(s);
  }
  deduped.sort((a, b) => a.start - b.start);
  void overlapSeconds;
  return { segments: deduped, overlapsApplied };
}

/**
 * 相邻段重叠 5–10 秒（§4.2）。
 *
 * 做法：把每个窗口（除第一个）的**起点前移** overlapSeconds —— 这样相邻窗口在时间轴上
 * 形成一段重叠，被切断的句子能在后一段里拿到完整上下文。
 * 只有单个窗口时不做任何调整（否则窗口会超出 0 下界或视频时长）。
 */
export function withOverlap(
  windows: Array<{ start: number; end: number }>,
  overlapSeconds: number,
): Array<{ start: number; end: number }> {
  if (windows.length <= 1 || overlapSeconds <= 0) return windows.map((w) => ({ ...w }));
  return windows.map((w, i) => (i === 0 ? { ...w } : { start: Math.max(0, w.start - overlapSeconds), end: w.end }));
}

/* ============================================================================
 * 本地剪静音（§4.2 成本削减，默认关闭）
 * ========================================================================== */

export interface SilenceSegment {
  start: number;
  end: number;
}

/**
 * 用 ffmpeg 的 `silencedetect` 找出长静音段。
 *
 * ⚠️ 实现要点（原文）：剪静音后必须维护「音频时间 → 视频时间」的映射表，
 * 记录每段有声片段的偏移量，否则转写时间戳会整体错位。
 * 因此本函数只负责**找出静音**，映射由 `buildSpeechPlan` 负责。
 */
export function detectSilence(
  file: string,
  opts: { ffmpegPath: string; noiseDb: number; minSilenceSec: number; timeoutMs?: number },
): { silences: SilenceSegment[]; duration: number; error?: string } {
  try {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-i', file,
      '-af', `silencedetect=noise=${opts.noiseDb}dB:d=${opts.minSilenceSec}`,
      '-f', 'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    ];
    // silencedetect 把结果写到 stderr
    const out = execFileSync(opts.ffmpegPath, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 600000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return parseSilenceOutput(String(out));
  } catch (e) {
    // execFileSync 非零退出时 stderr 在 error.stderr 里；ffmpeg 没有音频流等情况也会走到这里
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? String(err.stderr) : '';
    const parsed = stderr ? parseSilenceOutput(stderr) : { silences: [], duration: 0 };
    if (parsed.silences.length) return parsed;
    return { silences: [], duration: 0, error: err.message ?? 'silencedetect 失败' };
  }
}

/** 解析 ffmpeg silencedetect 的 stderr 输出 */
export function parseSilenceOutput(text: string): { silences: SilenceSegment[]; duration: number } {
  const silences: SilenceSegment[] = [];
  let start: number | undefined;
  let duration = 0;
  const durRe = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/;
  const dm = durRe.exec(text);
  if (dm) duration = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]);

  for (const line of text.split('\n')) {
    const sm = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (sm) {
      start = Math.max(0, Number(sm[1]));
      continue;
    }
    const em = /silence_end:\s*(\d+(?:\.\d+)?)/.exec(line);
    if (em && start !== undefined) {
      const end = Number(em[1]);
      if (end > start) silences.push({ start, end });
      start = undefined;
    }
  }
  // 结尾未闭合的静音段
  if (start !== undefined && duration > start) silences.push({ start, end: duration });
  return { silences, duration };
}

export interface SpeechChunk {
  /** 有声片段在**原视频时间轴**上的区间 */
  start: number;
  end: number;
}

/**
 * 由静音段反推「有声片段」列表，并保留两侧 padding。
 * 这是「音频时间 → 视频时间」映射的载体：每个 chunk 独立提交给 ASR
 * （实现上通过 startTime/endTime 让服务端自己抽这一段音频），
 * 因此时间戳天然落在原视频轴上，不需要额外重映射 —— 这是比「先拼音频再映射」更稳的做法。
 */
export function buildSpeechPlan(
  duration: number,
  silences: SilenceSegment[],
  opts: { paddingSec: number; minChunkSec?: number; maxChunkSec?: number },
): SpeechChunk[] {
  const minChunk = opts.minChunkSec ?? 5;
  const maxChunk = opts.maxChunkSec ?? 600;
  const chunks: SpeechChunk[] = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const end = Math.max(0, s.start + opts.paddingSec);
    if (end - cursor >= minChunk) chunks.push({ start: cursor, end });
    cursor = Math.max(cursor, s.end - opts.paddingSec);
  }
  if (duration - cursor >= minChunk) chunks.push({ start: cursor, end: duration });

  // 过长的有声段再按 maxChunk 切开，避免单次同步调用挂太久
  const split: SpeechChunk[] = [];
  for (const c of chunks) {
    let s = c.start;
    while (c.end - s > maxChunk) {
      split.push({ start: s, end: s + maxChunk });
      s += maxChunk;
    }
    if (c.end - s > 0) split.push({ start: s, end: c.end });
  }
  return split;
}

/* ============================================================================
 * 主流程
 * ========================================================================== */

export interface TranscribeDeps {
  client: BiliLiveClient;
  config: AppConfig;
  logger?: Logger;
  cache?: AsrCache;
  /** 本次运行的 provider 覆盖（CLI `--local-asr`），不改配置、只影响本进程 */
  provider?: AppConfig['asr']['provider'];
  /**
   * 热词来源（**惰性**：每次组装本地 ASR 参数时才调一次）。
   *
   * 为什么是函数不是数组：术语表是可热改的文件（用户改完 `data/glossary.json`
   * 下一场就该生效），而 Transcriber 是常驻对象 —— 传数组会把"启动那一刻的词表"冻住。
   * 由调用方（Orchestrator）注入 `() => hotWordList(this.glossary.load()).words`，
   * 这样读表、清洗、截断的口径只有一处。
   */
  hotwords?: () => string[];
}

export class Transcriber {
  private client: BiliLiveClient;
  private cfg: AppConfig;
  private logger: Logger;
  private cache: AsrCache;
  /**
   * 本次运行的 provider 覆盖（CLI `--local-asr` 用）。
   * 不改配置、不改文件，只影响这一个进程 —— 便于"试一次本地识别"而不留下副作用。
   */
  private providerOverride?: AppConfig['asr']['provider'];
  /** 热词来源（惰性取值，见 TranscribeDeps.hotwords） */
  private hotwordProvider?: () => string[];

  constructor(deps: TranscribeDeps) {
    this.client = deps.client;
    this.cfg = deps.config;
    this.logger = deps.logger ?? globalLog;
    this.cache = deps.cache ?? new AsrCache(deps.config.asr.cacheDir, this.logger);
    if (deps.provider) this.providerOverride = deps.provider;
    if (deps.hotwords) this.hotwordProvider = deps.hotwords;
  }

  /** 配置热加载 */
  update(cfg: AppConfig): void {
    this.cfg = cfg;
  }

  /** 实际生效的 provider（覆盖优先于配置） */
  private get provider(): AppConfig['asr']['provider'] {
    return this.providerOverride ?? this.cfg.asr.provider;
  }

  get cacheStore(): AsrCache {
    return this.cache;
  }

  /**
   * 预检：要跑多少段、其中多少段命中缓存、预计音频时长与估算费用。
   * 供 `--dry-run` 与 UI 在真正花钱前给出结论。
   */
  preflight(media: AsrMediaAdapter, totalDuration: number): {
    windows: WindowCall[];
    cacheHits: number;
    toPay: number;
    audioSeconds: number;
    estimatedCost: number;
  } {
    const windows = this.planWindows(media, totalDuration);
    let cacheHits = 0;
    let audioSeconds = 0;
    for (const w of windows) {
      const key = this.keyFor(w);
      const hit = this.cache.get(key);
      if (hit) cacheHits++;
      audioSeconds += w.inFileEnd - w.inFileStart;
    }
    /* 本地 provider（whisper / local-funasr）**不产生云端费用**，估算必须是 0 ——
       否则界面会显示一个假的"预计花费 ¥8.5"，把用户吓回去用云端。 */
    const localProvider = this.provider !== 'bililive-tools';
    const estimatedCost = localProvider ? 0 : (audioSeconds / 3600) * this.cfg.asr.unitPricePerHour;
    return {
      windows,
      cacheHits,
      toPay: windows.length - cacheHits,
      audioSeconds,
      estimatedCost,
      ...(localProvider ? { localProvider: this.provider } : {}),
    };
  }

  /** 按窗口规划调用单元（含段间重叠），再落到具体分段文件上。`windowSecOverride` 供本地引擎改块长 */
  private planWindows(media: AsrMediaAdapter, totalDuration: number, windowSecOverride?: number): WindowCall[] {
    const { segmentMinutes, overlapSeconds } = this.cfg.asr;
    /* 本地 Fun-ASR 按自己的**块长**规划窗口（默认 120 分钟），而不是沿用云端的 30 分钟：
       它的模型加载约 96 秒是固定成本，块越大越省；同时块数 > 1 才能并行。
       （之前的写法只"合并"云端窗口，遇到短素材就只有 1 块，并行根本没发生 —— 实测发现。） */
    const windowSec = Math.max(60, (windowSecOverride ?? segmentMinutes * 60));
    if (totalDuration <= 0) {
      // 时长未知时退化为「整文件一次」，但仍保证 startTime/endTime 成对
      return media.planCalls({ start: 0, end: Math.max(1, windowSec) });
    }

    // ★ 重叠的正确实现：**步进** = 窗口长度 − 重叠量，而不是把窗口起点前移。
    //   前移会扩大窗口长度（可能触发单次调用超时），且在「起始边界正好等于窗口末尾」
    //   的场景下会产出一个与首个窗口完全重复的调用单元 —— 白白浪费一次付费请求
    //   （ASR 按音频时长计费，重复调用就是重复花钱）。
    const overlap = Math.min(Math.max(0, overlapSeconds), Math.floor(windowSec / 4));
    const step = Math.max(1, windowSec - overlap);

    const raw: Array<{ start: number; end: number }> = [];
    for (let s = 0; s < totalDuration; s += step) {
      const end = Math.min(totalDuration, s + windowSec);
      raw.push({ start: s, end });
      if (end >= totalDuration) break;
    }
    return raw.flatMap((w, i) => media.planCalls(w).map((c) => ({ ...c, windowIndex: i })));
  }

  private keyFor(w: WindowCall): string {
    const st = this.statOf(w.file);
    /* 只有**真正会用热词的 provider** 才把指纹纳入键：
       否则光是把术语表填上就会让云端/whisper 的既有缓存全部失配（那些缓存是花过钱的）。 */
    const hw = this.provider === 'local-funasr' ? this.hotwordsFingerprint() : undefined;
    return asrCacheKey({
      videoFilePath: w.file,
      videoFileSize: st.size,
      videoFileUpdatedAt: st.updatedAt,
      modelId: this.cfg.asr.modelId,
      startTime: w.inFileStart,
      endTime: w.inFileEnd,
      offset: w.offset,
      trim: this.cfg.asr.silenceTrim.enabled ? `trim:${this.cfg.asr.silenceTrim.noiseDb}/${this.cfg.asr.silenceTrim.minSilenceSec}` : '',
      ...(hw ? { hotwords: hw } : {}),
    });
  }

  /** 当前生效的热词指纹（排序后拼接，顺序变化不该导致缓存失效）；没热词时 undefined */
  private hotwordsFingerprint(): string | undefined {
    const words = this.resolveHotwords();
    if (words.length === 0) return undefined;
    return [...words].sort().join('|');
  }

  /** 文件属性缓存（同一文件多次查询只 stat 一次） */
  private statCache = new Map<string, { size: number; updatedAt: number }>();
  private statOf(file: string): { size: number; updatedAt: number } {
    const hit = this.statCache.get(file);
    if (hit) return hit;
    let v: { size: number; updatedAt: number };
    try {
      const st = fs.statSync(file);
      v = { size: st.size, updatedAt: Math.round(st.mtimeMs) };
    } catch {
      // 文件不可读时给一个稳定但不可能与真实文件相同的值，
      // 保证缓存键可复现（否则每次调用都会生成新键、无意义地重复计费）
      v = { size: -1, updatedAt: 0 };
    }
    this.statCache.set(file, v);
    return v;
  }

  private statOfPublic(file: string): { size: number; updatedAt: number } {
    return this.statOf(file);
  }

  /**
   * 组装本地 ASR 的执行参数（provider='whisper-cpp' 时使用）。
   *
   * 配置项复用已有的 `asr.whisperCpp.*`，含义按实际执行方式对齐：
   *   - `binaryPath` → **Python 解释器**路径（默认取项目内 `.venv-asr`，实测已装 faster-whisper）
   *   - `modelPath`  → **模型缓存目录**（HuggingFace 下载缓存，不是单个文件）
   *   - `model`（新增）→ 模型名，默认 `dropbox-dash/faster-whisper-large-v3-turbo`
   *   - `device` / `computeType`（新增）→ 默认 `auto`（先试 CUDA，失败退 CPU）
   *
   * 执行脚本固定为项目内 `tools/local-asr/transcribe.py`：它是本仓库的一部分，
   * 不随用户配置漂移，避免"配置指向了别处的脚本"这种难排查的问题。
   */
  private resolveLocalAsrOptions(): LocalAsrOptions {
    if (this.provider === 'local-funasr') return this.resolveFunasrOptions();
    const w = this.cfg.asr.whisperCpp;
    const pythonPath = w.binaryPath || path.join(ROOT_DIR, '.venv-asr', 'Scripts', 'python.exe');
    const scriptPath = path.join(ROOT_DIR, 'tools', 'local-asr', 'transcribe.py');
    if (!exists(pythonPath)) {
      throw new Error(
        `本地 ASR 已启用（asr.provider='whisper-cpp'）但找不到 Python 解释器：${pythonPath}\n` +
          `  修复：在项目根目录执行  python -m venv .venv-asr  &&  .venv-asr\\Scripts\\pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12\n` +
          `  或在 config.json 里把 asr.whisperCpp.binaryPath 指向可用的 python.exe`,
      );
    }
    if (!exists(scriptPath)) {
      throw new Error(`本地 ASR 执行脚本缺失：${scriptPath}`);
    }
    return {
      engine: 'whisper',
      pythonPath,
      scriptPath,
      model: w.model || 'dropbox-dash/faster-whisper-large-v3-turbo',
      modelDir: w.modelPath || path.join(ROOT_DIR, '.venv-asr', 'models'),
      language: w.language || 'zh',
      device: w.device || 'auto',
      computeType: w.computeType || 'auto',
      beamSize: w.beamSize ?? 5,
      vadFilter: w.vadFilter !== false,
      // 本地没有网络往返，但 CPU 跑长音频可能很久；给足 4 小时上限
      timeoutMs: 4 * 3600_000,
    };
  }

  /**
   * 本地 Fun-ASR-Nano（阿里云开源）的执行参数。
   *
   * 与 whisper 的关键差异：它**必须整体一次调用** —— 模型加载要 ~96 秒，
   * 若按 30 分钟窗口切 9 段就会白等 15 分钟。所以 `transcribe()` 对它只规划**一个窗口**
   * （见 transcribe() 里的 singleWindow 分支）。
   */
  private resolveFunasrOptions(): LocalAsrOptions {
    const f = this.cfg.asr.localFunasr;
    const pythonPath = f.pythonPath || path.join(ROOT_DIR, '.venv-funasr', 'Scripts', 'python.exe');
    const scriptPath = path.join(ROOT_DIR, 'tools', 'local-asr', 'transcribe-funasr.py');
    if (!exists(pythonPath)) {
      throw new Error(
        `本地 Fun-ASR 已启用（asr.provider='local-funasr'）但找不到 Python 解释器：${pythonPath}\n` +
          `  修复：在项目根目录执行  node tools/local-asr/setup-funasr.mjs\n` +
          `  （它会建独立 .venv-funasr 并装 torch/funasr/modelscope；不要与 .venv-asr 混装）\n` +
          `  或在 config.json 里把 asr.localFunasr.pythonPath 指向可用的 python.exe`,
      );
    }
    if (!exists(scriptPath)) throw new Error(`本地 ASR 执行脚本缺失：${scriptPath}`);
    const hotwords = this.resolveHotwords();
    return {
      engine: 'funasr',
      pythonPath,
      scriptPath,
      model: f.model || 'FunAudioLLM/Fun-ASR-Nano-2512',
      modelDir: '',
      language: '中文',
      device: f.device || 'auto',
      computeType: 'n/a',
      beamSize: 0,
      vadFilter: true,
      hub: f.hub || 'ms',
      enginePreference: f.engine || 'auto',
      maxCharsPerCue: f.maxCharsPerCue ?? 18,
      minCueDur: f.minCueDur ?? 0.6,
      timestamps: f.timestamps !== false,
      ...(hotwords.length > 0 ? { hotwords } : {}),
      timeoutMs: Math.max(600, f.timeoutSec ?? 4 * 3600) * 1000,
    };
  }

  /**
   * 取本次要用的热词（只有本地 Fun-ASR 用得上）。
   *
   * 三重保险，任何一步出问题都只是"这次没热词"，绝不能让转写因为热词而失败：
   *  1. 配置关掉（`asr.localFunasr.hotwordsEnabled=false`）→ 空；
   *  2. 没注入来源（例如单测/工具直接 new Transcriber）→ 空；
   *  3. 读术语表抛错（文件被写坏）→ 空，并记一条 warn。
   */
  private resolveHotwords(): string[] {
    if (this.cfg.asr.localFunasr.hotwordsEnabled === false) return [];
    if (!this.hotwordProvider) return [];
    try {
      return this.hotwordProvider();
    } catch (e) {
      this.logger.warn(`读取热词失败，本次不带热词：${(e as Error).message}`);
      return [];
    }
  }

  /**
   * 主入口：转写整场。
   *
   * 断点续跑（§8 WP3 步骤 5）：逐段先查缓存，命中即跳过 —— 已花的钱不再花第二遍。
   */
  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const started = Date.now();
    const { taskId, media, totalDuration } = opts;
    const warnings: string[] = [];
    const gaps: TranscriptGap[] = [];
    const log = this.logger.child({ taskId, mod: 'asr' });

    /* 本地 Fun-ASR 直接用**块长**规划窗口（默认 120 分钟）：既摊薄 96 秒的模型加载，
       又保证块数 > 1 从而能并行。云端与 whisper 仍按 segmentMinutes 规划。 */
    const localChunkSec =
      this.provider === 'local-funasr' ? Math.max(300, (this.cfg.asr.localFunasr.chunkMinutes ?? 120) * 60) : undefined;
    const windows = this.planWindows(media, totalDuration, localChunkSec);
    if (windows.length === 0) {
      warnings.push('没有可转写的窗口（源文件可能不存在或时长为 0）');
    }

    const dryRun = opts.dryRun ?? false;
    const allowPaid = opts.allowPaid ?? this.cfg.runtime.allowPaid;

    // ---- 本地 ASR 判定 ----
    // provider='whisper-cpp' 时走本地执行器；此时**完全不调用付费接口**，
    // 所以 dry-run 的付费闸门对本地路径不适用（本地不产生费用）。
    const useLocalAsr = this.provider === 'whisper-cpp' || this.provider === 'local-funasr';
    const localOpts = useLocalAsr ? this.resolveLocalAsrOptions() : undefined;
    if (localOpts) {
      log.info(
        `本地 ASR 已启用：引擎 ${localOpts.engine}，模型 ${localOpts.model}，设备 ${localOpts.device}` +
          `${localOpts.engine === 'funasr' ? `，字级时间戳 ${localOpts.timestamps !== false ? '开' : '关'}` : ''}（不产生云端费用）`,
        { stage: 'TRANSCRIBING' },
      );
      /* 热词要留痕：用户改完术语表最想知道的一件事就是"这次到底带没带进去"。
         只报条数与前若干个，避免把整张词表刷进日志。 */
      if (localOpts.hotwords?.length) {
        const head = localOpts.hotwords.slice(0, 8).join('、');
        log.info(`热词已注入（${localOpts.hotwords.length} 条，来自术语表）：${head}${localOpts.hotwords.length > 8 ? ' 等' : ''}`, {
          stage: 'TRANSCRIBING',
          data: { hotwords: localOpts.hotwords.length },
        });
      }
    }

    /* 并发：云端最多 2（对上游要克制）；本地 Fun-ASR 由实测决定 ——
       **单 GPU 上并行无益**（每进程都要加载一遍模型，且两进程抢同一块卡），
       所以默认 `parallel=1`；只有在多卡机器上把它调大才有意义。 */
    const maxParallel = localOpts?.engine === 'funasr' ? Math.max(1, this.cfg.asr.localFunasr.parallel ?? 1) : 2;
    const concurrency = Math.max(1, Math.min(maxParallel, this.cfg.asr.concurrency));
    const limit = createLimiter(concurrency);

    /* Fun-ASR 走**整场一次调用**。
       为什么：它的模型加载要 ~96 秒，按 30 分钟窗口切 9 段就会白等 15 分钟；
       而它是本地进程、没有云端那些单次时长限制，一次吃完整个文件最划算。
       whisper 保持原有的窗口化（模型只有几秒加载，窗口化能带来更细的缓存粒度）。 */
    /* Fun-ASR 走"大块 + 并行"。
       它的模型加载约 96 秒是固定成本：沿用云端 30 分钟窗口会白等 15 分钟，
       整文件一次又没法并行 —— 所以按 `localFunasr.chunkMinutes`（默认 120 分钟）分块，
       用 `localFunasr.parallel`（默认 2）个进程同时跑。实测 4 小时录播 43 分钟 → 约 23 分钟。
       ⚠️ 必须**按文件分组**合并：多分段任务里每个文件只承载一部分全局时间。 */
    const singleWindow = localOpts?.engine === 'funasr';
    const chunkSec = Math.max(300, (this.cfg.asr.localFunasr.chunkMinutes ?? 120) * 60);
    const effectiveWindows = singleWindow ? mergeWindowsPerFile(windows, chunkSec) : windows;
    if (singleWindow && effectiveWindows.length < windows.length) {
      log.info(
        `本地 Fun-ASR：把 ${windows.length} 个窗口合并为 ${effectiveWindows.length} 块` +
          `（每块上限 ${Math.round(chunkSec / 60)} 分钟，并发 ${concurrency}）—— 避免重复加载模型 ~96 秒/次`,
        { stage: 'TRANSCRIBING' },
      );
    }

    log.info(`开始转写：${effectiveWindows.length} 个调用单元，总时长 ${fmtDuration(totalDuration)}，并发 ${concurrency}`, {
      stage: 'TRANSCRIBING',
      data: { segmentMinutes: this.cfg.asr.segmentMinutes, overlapSeconds: this.cfg.asr.overlapSeconds, dryRun, allowPaid },
    });

    interface UnitResult {
      window: WindowCall;
      fromCache: boolean;
      segments: TranscriptSegment[];
      audioSeconds: number;
      paid: boolean;
      failed?: { type: ErrorType; message: string; attempts: RetryAttempt[]; request?: RequestContext };
    }

    let done = 0;
    /* 热词指纹在整场里取一次：它既进缓存键，也写进缓存条目（见下）。
       同一场里热词不会变，逐窗口重复读术语表是白费。 */
    const hwFingerprint = this.provider === 'local-funasr' ? this.hotwordsFingerprint() : undefined;
    const results = await Promise.all(
      effectiveWindows.map((w) =>
        limit(async (): Promise<UnitResult> => {
          const key = this.keyFor(w);
          const audioSeconds = Math.max(0, w.inFileEnd - w.inFileStart);
          const cached = !opts.force ? this.cache.get(key) : undefined;

          // ---- 命中缓存：直接跳过，绝不重复付费（陷阱 #3）----
          if (cached) {
            done++;
            opts.onProgress?.({ current: done, total: effectiveWindows.length, label: `转写中 ${done}/${effectiveWindows.length}（缓存）` });
            log.debug(`段 ${w.windowIndex + 1} 命中缓存，跳过付费调用`, { data: { file: path.basename(w.file), inFileStart: w.inFileStart } });
            return { window: w, fromCache: true, segments: cached.segments, audioSeconds, paid: false };
          }

          // ---- dry-run 且无缓存：不得自动付费（硬约束 #14）----
          if (dryRun && !allowPaid) {
            done++;
            opts.onProgress?.({ current: done, total: effectiveWindows.length, label: `转写中 ${done}/${effectiveWindows.length}（dry-run 跳过）` });
            return {
              window: w,
              fromCache: false,
              segments: [],
              audioSeconds,
              paid: false,
              failed: {
                type: 'contract',
                /* ⚠️ 这里**不要**再拼 `contract:` —— `type` 已经由 gaps 的组装处
                   （`reason: \`${r.failed.type}: ${r.failed.message}\``）加过一次。
                   本行第一版写成 `${DRY_RUN_REJECT_PREFIX} 且无缓存：...`，
                   而 DRY_RUN_REJECT_PREFIX 本身就含 `contract: `，于是实际落地成
                   `contract: contract: dry-run 且无缓存：...` —— 前缀判定永远不匹配，
                   dry-run 分支成了死代码。e2e 的契约断言当场抓到了它。 */
                message: `${DRY_RUN_REJECT_PREFIX_NOUN} 且无缓存：拒绝调用付费 ASR（段 ${w.windowIndex + 1}）。如需产生费用请显式传 --allow-paid（硬约束 #14）`,
                attempts: [],
              },
            };
          }

          // ---- 真实调用：单段失败重试 N 次后跳过 ----
          const maxRetries = Math.max(0, this.cfg.asr.maxRetries);
          const attempts: RetryAttempt[] = [];
          const purpose = `段 ${w.windowIndex + 1} ${fmtDuration(w.globalStart)}–${fmtDuration(w.globalEnd)}`;

          for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
              // ★ 按 provider 分叉。两条路产出的是**同一个** {start,end,text} 结构
              //   （全局时间戳），所以缓存、分段映射、下游分析完全不用改。
              let segments: TranscriptSegment[];
              let cacheSrt = '';
              if (useLocalAsr) {
                const local = await runLocalAsr({
                  opts: localOpts!,
                  file: w.file,
                  startTime: w.inFileStart,
                  endTime: w.inFileEnd,
                  offset: w.globalStart,
                });
                if (!local.ok) throw new Error(`本地 ASR 失败：${local.error ?? '未知错误'}`);
                // 本地执行器已经加过 offset（= 该单元的全局起点），无需再加
                segments = (local.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
                cacheSrt = JSON.stringify(local.segments ?? []);
                log.debug(
                  `${purpose} 本地转写完成：${segments.length} 条（设备 ${local.device}/${local.compute_type}，` +
                    `${((local.elapsed_ms ?? 0) / 1000).toFixed(1)}s）`,
                );
              } else {
                const srt = await this.client.subtitle({
                  file: w.file,
                  modelId: this.cfg.asr.modelId || undefined,
                  // ⚠️ 必须成对提供（硬约束 #7）；api.ts 里另有断言兜底
                  startTime: w.inFileStart,
                  endTime: w.inFileEnd,
                  offset: w.offset,
                  song: false,
                  timeoutMs: this.cfg.bililive.asrTimeoutMs,
                  retry: 0, // 重试逻辑在此处统一管理，便于记录重试历史
                  ...(opts.signal ? {} : {}),
                });
                cacheSrt = srt;
                segments = parseSrt(srt).map((s) => ({
                  // 全局时间 = 段内时间戳 + 该单元的全局起点（实测语义，见 WindowCall.offset 注释）
                  start: s.start + w.globalStart,
                  end: s.end + w.globalStart,
                  text: s.text,
                }));
              }
              this.cache.set({
                key,
                parts: {
                  videoFilePath: w.file,
                  videoFileSize: this.statOf(w.file).size,
                  videoFileUpdatedAt: this.statOf(w.file).updatedAt,
                  modelId: this.cfg.asr.modelId,
                  startTime: w.inFileStart,
                  endTime: w.inFileEnd,
                  offset: w.offset,
                  // 留痕：这条缓存是带热词跑出来的（键里也有它，见 asrCacheKey）
                  ...(hwFingerprint ? { hotwords: hwFingerprint } : {}),
                },
                srt: cacheSrt,
                segments,
                createdAt: nowIso(),
                audioSeconds,
              });
              done++;
              opts.onProgress?.({ current: done, total: effectiveWindows.length, label: `转写中 ${done}/${effectiveWindows.length}` });
              log.info(`${purpose} 完成：${segments.length} 条字幕`, { data: { attempt, paid: !useLocalAsr } });
              /* ⚠️ `paid` 决定"实际计费音频"的累计口径（→ 台账 ASR 费用、界面"预计花费"）。
                 本地 provider（whisper / local-funasr）是**零成本**的，写成 true 会让
                 本地跑的场次在成本统计里凭空多出 ¥8.5/场 —— 实测就是被这条 e2e 抓到的。 */
              return { window: w, fromCache: false, segments, audioSeconds, paid: !useLocalAsr };
            } catch (e) {
              const type: ErrorType = e instanceof ApiError ? e.type : 'internal';
              const message = e instanceof Error ? e.message : String(e);
              /* 把**请求上下文**一起留下来（ApiError 自带）：ASR 失败的表象是"没有字幕"，
                 真因在那次 HTTP 调用里。不带上去，错误报告只能写"失败不发生在 HTTP 调用上"——
                 实测用户贴回来的第一份报告就是这样，而它其实是一次 500 → 上游 400。 */
              const request = e instanceof ApiError ? e.request : undefined;
              attempts.push({ attempt, at: nowIso(), type, message });
              // 一次都没成功过的尝试才算「付费」；这里保守地不重复计费，由 paidCalls 在成功时计
              if (attempt <= maxRetries) {
                const wait = backoffMs(attempt, 2000, 30000);
                log.warn(`${purpose} 第 ${attempt} 次失败，${wait}ms 后重试：${message}`, { data: { type } });
                await sleep(wait);
                continue;
              }
              done++;
              opts.onProgress?.({ current: done, total: effectiveWindows.length, label: `转写中 ${done}/${effectiveWindows.length}（跳过）` });
              log.error(`${purpose} 重试 ${maxRetries} 次后跳过`, e, { data: { type } });
              return {
                window: w,
                fromCache: false,
                segments: [],
                audioSeconds,
                paid: false,
                failed: { type, message, attempts, ...(request ? { request } : {}) },
              };
            }
          }
          // 理论不可达
          return { window: w, fromCache: false, segments: [], audioSeconds, paid: false };
        }),
      ),
    );

    /* ---- 合并（优先信任后一段，按时间区间取舍）---- */
    const merged = mergeSegments(
      results.map((r) => ({ globalStart: r.window.globalStart, globalEnd: r.window.globalEnd, segments: r.segments })),
      this.cfg.asr.overlapSeconds,
    );

    /* ---- gaps：单段失败跳过后写入缺失区间（§4.2）---- */
    for (const r of results) {
      if (r.failed) {
        gaps.push({ start: r.window.globalStart, end: r.window.globalEnd, reason: `${r.failed.type}: ${r.failed.message}` });
      }
    }
    gaps.sort((a, b) => a.start - b.start);

    /* ---- 覆盖率自检：转写文本稀疏的窗口也提示（可能是纯游戏操作）---- */
    const covered = merged.segments.reduce((acc, s) => acc + (s.end - s.start), 0);
    if (totalDuration > 0 && covered / totalDuration < 0.05 && merged.segments.length > 0) {
      warnings.push(
        `转写覆盖率仅 ${((covered / totalDuration) * 100).toFixed(1)}%（${merged.segments.length} 条）—— 该场可能长时间没有语音，选片会更多依赖弹幕信号`,
      );
    }

    const paidCalls = results.filter((r) => r.paid).length;
    const cacheHits = results.filter((r) => r.fromCache).length;
    const failedWindows = results.filter((r) => r.failed).length;
    const paidAudioSeconds = results.filter((r) => r.paid).reduce((a, r) => a + r.audioSeconds, 0);

    if (failedWindows > 0) {
      warnings.push(`${failedWindows} 个窗口转写失败已被跳过，transcript.json 的 gaps 中已记录缺失区间`);
    }

    const transcript: Transcript = {
      taskId,
      segments: merged.segments,
      gaps,
      source: this.provider === 'whisper-cpp' ? 'whisper-cpp' : this.provider === 'local-funasr' ? 'local-funasr' : 'bililive-tools',
      modelId: this.cfg.asr.modelId || 'default',
      audioSeconds: paidAudioSeconds,
      costEstimate: (paidAudioSeconds / 3600) * this.cfg.asr.unitPricePerHour,
      createdAt: nowIso(),
    };

    /* 把"最像根因"的那次失败留给编排层写错误报告：
       优先取**带请求上下文**的那条（有状态码与响应体），没有就取第一条失败。
       这样报告里才可能出现「POST /ai/subtitle → HTTP 500，响应体 …」而不是"无请求上下文"。 */
    const failure =
      results.find((r) => r.failed?.request) ?? results.find((r) => r.failed);
    if (failure?.failed) {
      transcript.lastFailure = {
        type: failure.failed.type,
        message: failure.failed.message,
        ...(failure.failed.request ? { request: failure.failed.request } : {}),
      };
    }

    log.info(
      `转写完成：${merged.segments.length} 条字幕，付费段 ${paidCalls}，缓存命中 ${cacheHits}，失败 ${failedWindows}，` +
        `实际计费音频 ${fmtDuration(paidAudioSeconds)}（估算 ¥${(transcript.costEstimate ?? 0).toFixed(2)}）`,
      { stage: 'TRANSCRIBED', data: { overlapsApplied: merged.overlapsApplied, elapsedMs: Date.now() - started } },
    );

    return {
      transcript,
      paidCalls,
      cacheHits,
      failedWindows,
      warnings,
      durationMs: Date.now() - started,
    };
  }

  /** 暴露给 daemon 用于构建 adapter 时查文件属性 */
  fileStat(file: string): { size: number; updatedAt: number } {
    return this.statOfPublic(file);
  }
}

/**
 * 把**同一个文件**的多个窗口合并成若干大块（本地 Fun-ASR 用）。
 *
 * 为什么要合并：Fun-ASR 的模型加载约 96 秒是**固定成本**，沿用云端的 30 分钟窗口
 * 会把 4 小时录播切成 9 块 → 白等 15 分钟。合并成 120 分钟的大块后只剩 2-3 次加载。
 *
 * 为什么又要**限制块长**（`maxChunkSec`）而不是整文件一次：
 * 整文件一次没法并行；切成 2-3 块就能同时跑两个进程（实测 43 分钟 → 约 23 分钟）。
 *
 * ⚠️ 必须**按文件分组**：多分段任务里每个文件只承载一部分全局时间，
 * 把 windows[0] 直接拉成 [0, 总时长] 会让后续文件的时间戳整体错位（很难查）。
 */
export function mergeWindowsPerFile(windows: WindowCall[], maxChunkSec = Number.POSITIVE_INFINITY): WindowCall[] {
  const byFile = new Map<string, WindowCall[]>();
  for (const w of windows) {
    const list = byFile.get(w.file) ?? [];
    list.push(w);
    byFile.set(w.file, list);
  }
  const out: WindowCall[] = [];
  for (const list of byFile.values()) {
    list.sort((a, b) => a.globalStart - b.globalStart);
    let cur: WindowCall | undefined;
    for (const w of list) {
      if (!cur) {
        cur = { ...w, inFileStart: 0 };
        continue;
      }
      // 合并后仍在块长上限内就继续吃，否则收尾并开新块
      if (w.globalEnd - cur.globalStart <= maxChunkSec) {
        cur = {
          ...cur,
          inFileEnd: Math.max(cur.inFileEnd, w.inFileEnd),
          globalEnd: Math.max(cur.globalEnd, w.globalEnd),
        };
      } else {
        out.push(cur);
        cur = { ...w, inFileStart: 0 };
      }
    }
    if (cur) out.push(cur);
  }
  return out.sort((a, b) => a.globalStart - b.globalStart).map((w, i) => ({ ...w, windowIndex: i }));
}

/* ============================================================================
 * 本地剪静音路径（可选，默认关闭）
 * ========================================================================== */

/**
 * 剪静音模式下的调用规划：先用 silencedetect 找出静音，再用有声片段代替固定窗口。
 *
 * ⚠️ 与固定窗口模式的关键区别：**仍用 startTime/endTime 提交原文件**，
 * 而不是「先拼出一段裁剪过的音频再提交」。这样时间戳天然落在原视频轴上，
 * 不需要维护「音频时间 → 视频时间」的重映射表 —— 少一张映射表就少一类错位 bug。
 * 代价是服务端仍会对整段区间做处理，省下的是**静音区间的识别开销**
 * （大多数云 ASR 对静音返回空结果，实际计费以服务端口径为准）。
 */
export function planSilenceTrimmedCalls(
  totalDuration: number,
  silences: SilenceSegment[],
  cfg: AppConfig['asr'],
  media: AsrMediaAdapter,
): WindowCall[] {
  const chunks = buildSpeechPlan(totalDuration, silences, {
    paddingSec: cfg.silenceTrim.paddingSec,
    minChunkSec: 5,
    maxChunkSec: Math.max(60, cfg.segmentMinutes * 60),
  });
  return chunks.flatMap((c, i) => media.planCalls({ start: c.start, end: c.end }).map((w) => ({ ...w, windowIndex: i })));
}

/** 判断某条转写文本是否疑似「音乐/噪声被识别成了人声」——供人工抽查时快速筛选 */
export function looksLikeNoise(text: string): boolean {
  const t = text.replace(/\s/g, '');
  if (t.length < 2) return true;
  // 大量重复字符
  if (/(.)\1{4,}/.test(t)) return true;
  // 无中文且无有意义英文单词
  if (!/[\u4e00-\u9fa5]/.test(t) && !/[a-zA-Z]{3,}/.test(t)) return true;
  return false;
}
