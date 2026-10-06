/**
 * 录播素材发现：把「本机能导入哪些录播」这件事做成一份可点选的清单。
 *
 * ## 为什么参考 biliLive-tools 的做法
 *
 * 原来的导入是「粘贴一个绝对路径」——用户得自己去资源管理器复制路径，
 * 还要自己找同名弹幕文件，导错了要到流水线跑失败才发现。biliLive-tools 之所以好用，
 * 是因为它有三样我们原来没用上的东西：
 *
 *   1. **它自己的录制历史**（`GET /record-history/list`）：带标题、开播时间、时长、
 *      弹幕条数，比从文件名猜可靠得多；
 *   2. **它自己维护的「视频 ↔ 弹幕」对应关系**（`POST /record-history/danma-file`）：
 *      文件名对不上时也能找到弹幕；
 *   3. **它自己的录制目录**（`GET /config` → `webhook.recoderFolder`）：默认就在那儿，
 *      不需要用户告诉我们路径。
 *
 * 所以这份清单 = **biliLive-tools 历史** ∪ **扫盘结果**，并叠加我们才知道的三件事：
 *   4. **是否已经导入过**（比对台账的 `source.rawFiles`）——避免重复建任务、重复花 ASR 钱；
 *   5. **ASR 缓存命中与预估费用**（复用 `Transcriber.preflight`，与运行期同一套逻辑）；
 *   6. **文件是否可用**（录制中断的 MP4 没有 moov atom，ffprobe 读不出时长，导入前就该拦下）。
 *
 * ## 文件名里的信息（实测本机 biliLive-tools 的命名）
 *
 * ```
 * 2026-09-20 00-36-21-040 已进入后半夜后悔时代.flv          ← 原始录制
 * 2026-09-22 22-49-42-277 来两下闪身步就好了_PART000.flv     ← 多分段
 * 2026-09-22 22-27-18-350 来两下闪身步就好了-弹幕版.mp4      ← 已烧弹幕的压制产物
 * ```
 *
 * ⚠️ 第三种的画面里**已经有弹幕**了。把它当源文件再烧一次弹幕就是双层弹幕（陷阱 #8），
 * 所以这里从文件名识别出 `-弹幕版` 并标记 `hasDanmakuInPicture`，
 * 由调用方写进 `source.fullVideoHasDanmaku`（硬约束 #12 要求这个值有依据，不能运行时猜）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from './config.ts';
import type { BiliLiveClient } from './api.ts';
import type { Ledger } from './ledger.ts';
import { discoverSegments, probeMedia } from './media.ts';
import { listSegmentDanmaku } from './danmaku-merge.ts';
import { exists, fileSize, fmtBytes, fmtDuration } from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';

/**
 * 「可能仍在录制」的写入时间窗（秒）。
 *
 * 三处必须用同一个值，否则会出现"列表说写完了、导入却说还在写"这种自相矛盾：
 *   · 本文件的清单（判断某场是否还在录 / 哪些分段已经写完）
 *   · `discoverSegments` 的 `skipFreshWithinSec`（拒绝把还在写的分段算进一场）
 *   · `daemon.importLocal` 导入时的分段发现
 */
export const RECORDING_WINDOW_SEC = 120;

/* ============================================================================
 * 文件名解析
 * ========================================================================== */

export interface ParsedRecordingName {
  /** 从文件名里剥出来的直播标题 */
  title: string;
  /** 录制开始时刻（毫秒）；解析不出来则 undefined */
  recordedAt?: number;
  /** 文件名带「-弹幕版」→ 画面里已经烧了弹幕 */
  hasDanmakuInPicture: boolean;
  /** 多分段序号（`_PART000` → 0）；没有则为 undefined */
  partIndex?: number;
}

/**
 * `2026-09-22 22-49-42-277` → 毫秒时间戳（本地时区）。
 *
 * 分隔符放宽：实测还有 `2026_9_21 20_50_02 场直播.ts` 这种
 * 「下划线日期 + 空格分秒」的命名（别的下载工具产物），
 * 早先只认 `-` 分隔，结果整个文件名被当成标题（清单里显示成一长串日期）。
 */
function parseStamp(s: string): number | undefined {
  const m = /^(\d{4})[-_/](\d{1,2})[-_/](\d{1,2})[ _](\d{1,2})[-_:](\d{1,2})[-_:](\d{1,2})(?:[-_.](\d{1,3}))?$/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, sec, ms] = m;
  const t = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec),
    ms ? Number(ms.padEnd(3, '0')) : 0,
  ).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/**
 * biliLive-tools 压制产物的后缀，**含它的「防覆盖 UUID」**。
 *
 * 它的 `burn()` 在二次压制同一分段时（`哈喽-弹幕版.mp4` 已存在）会把产物改名成
 * `哈喽-弹幕版-6e88e7c6-1c78-4827-917b-c7e62ad18fc9.mp4`。我们原先只把产物后缀当
 * **结尾**匹配，于是这种文件同时踩两个坑：
 *   ① 归不进原来那一组 → 目录轮询把它当成**另一场**导入 → 同一分段录两次、转写与分析
 *      各花一遍钱（实测 `auto-20260923165851-y0eu` 就是 `auto-20260923165650-nnxn`
 *      那一场同一段 209 秒素材的弹幕版，两场都跑了 ASR）；
 *   ② `hasDanmakuInPicture` 判成 false → 拿它当源文件会**再烧一层弹幕**（双层弹幕，陷阱 #8）。
 */
const PRODUCT_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PRODUCT_SUFFIX = `(?:-弹幕版|-纯享版|-danmaku|（弹幕版）)(?:[-_]${PRODUCT_UUID})?`;

/**
 * 找出某个原始录制文件对应的**压制产物**（biliLive-tools 烧完弹幕的那份）。
 *
 * 为什么需要它：完整版是 biliLive-tools **录制结束之后**才压制出来的，而任务是在
 * 「录制文件稳定」时导入的 —— 那一刻产物还不存在，于是 `source.fullVideoPath` 一直是
 * undefined（实测 4 个任务全都是），台账里也就永远看不到完整版。
 * 但用户在实时监控里要看「哪些文件已经交出去了、能不能删」，完整版正是最占地方的那个。
 * 所以这里按**命名约定**去盘上找，而不是靠台账。
 *
 * 命名约定与 `parseRecordingFileName` / `PRODUCT_SUFFIX` 同一套（那份是权威定义）：
 *   `X.ts` → `X-弹幕版.mp4`
 *   也容忍产物后缀与分段后缀**任意顺序叠加**、以及防覆盖 UUID：
 *   `X-弹幕版_PART003.mkv`、`X-PART001-弹幕版.mp4`、`X-弹幕版-6e88e7c6-….mp4`
 *
 * 严格匹配「前缀就是 base + 1~2 个后缀」，不做 `startsWith` 模糊匹配 ——
 * 否则同一天另一场的 `X2-弹幕版.mp4` 也会算到这一场头上（而这一列是用来**删文件**的）。
 */
export function findVideoProducts(rawPath: string): string[] {
  const dir = path.dirname(rawPath);
  const ext = path.extname(rawPath);
  const base = path.basename(rawPath, ext);
  if (!base) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffixAny = `(?:${PRODUCT_SUFFIX}|${PART_SUFFIX})`;
  const whole = new RegExp(`^${esc(base)}${suffixAny}{1,2}$`, 'i');
  const isProduct = new RegExp(PRODUCT_SUFFIX, 'i');
  const out: string[] = [];
  for (const n of entries) {
    if (!/\.(mp4|mkv|flv|ts)$/i.test(n)) continue;
    const stem = n.slice(0, n.length - path.extname(n).length);
    if (!stem.startsWith(base)) continue;
    if (!whole.test(stem)) continue;
    // 后缀里必须真的含产物标记：否则 `X-PART001.ts` 这种分段原始文件会被当成产物
    if (!isProduct.test(stem.slice(base.length))) continue;
    out.push(path.join(dir, n));
  }
  return out;
}

/**
 * 分段后缀。
 *
 * ⚠️ 分隔符是 `_` **或** `-`，两种都实测出现过：`…来两下闪身步就好了_PART000.flv`（老形态）与
 * `…哈喽-PART000.ts`（2026-09-24 实测：biliLive-tools 把一场连续直播按分钟切段时用的就是它）。
 * 只认 `_PART` 会让后者的标题残留成 `哈喽-PART000` —— 而这个标题会被拿去匹配稿件
 * （`{liveTitle}` 模板 + 按标题找已有稿件），匹配不上就会**另投一个新稿件**。
 */
const PART_SUFFIX = '[-_.]PART\\d+';

/**
 * 剥掉「压制产物后缀（含防覆盖 UUID）」与「分段后缀」，两种后缀**可叠加出现**，
 * 所以这里循环剥，最多 4 轮。
 *
 * ⚠️ 必须循环剥，不能只按固定顺序各剥一次：实测存在
 * `…来两下闪身步就好了-弹幕版_PART003.mkv`（两个后缀同时出现）与
 * `…哈喽-弹幕版-6e88e7c6-….mp4`（产物后缀 + UUID）两种形态。
 */
export function stripRecordingSuffixes(fileName: string): string {
  let rest = fileName.replace(/\.[^.]+$/, '');
  for (let i = 0; i < 4; i++) {
    const next = rest
      .replace(new RegExp(`${PRODUCT_SUFFIX}$`, 'i'), '')
      .replace(new RegExp(`${PART_SUFFIX}$`, 'i'), '')
      .trim();
    if (next === rest) break;
    rest = next;
  }
  return rest;
}

/**
 * 解析 biliLive-tools 的录播文件名。
 *
 * 容错优先：解析不出来就退回「去扩展名的文件名」，绝不抛错 ——
 * 用户手上可能有各种来源的文件，清单里少一条比整份清单报错糟糕得多。
 */
export function parseRecordingFileName(fileName: string): ParsedRecordingName {
  const base = fileName.replace(/\.[^.]+$/, '');
  /* 产物判定：也允许「产物后缀 + 分段后缀 + 防覆盖 UUID」的形态
     （否则已烧弹幕的文件会被当原始素材，再烧一层就是双层弹幕） */
  const hasDanmakuInPicture = new RegExp(
    `(?:-弹幕版|-danmaku|（弹幕版）)(?:${PART_SUFFIX})?(?:[-_]${PRODUCT_UUID})?$`,
    'i',
  ).test(base);
  const partIndex = ((): number | undefined => {
    const m = new RegExp(`${PART_SUFFIX.replace('\\d+', '(\\d+)')}(?:${PRODUCT_SUFFIX})?$`, 'i').exec(base);
    return m ? Number(m[1]) : undefined;
  })();

  /* 标题里不能残留 `-弹幕版-<uuid>`（不然任务名就是一长串乱码，用户实测截图里就是这样） */
  const rest = stripRecordingSuffixes(fileName);

  // 形如 `2026-09-22 22-49-42-277 标题`；分隔符放宽以兼容别的下载工具的命名
  const stamp = /^(\d{4}[-_/]\d{1,2}[-_/]\d{1,2}[ _]\d{1,2}[-_:]\d{1,2}[-_:]\d{1,2}(?:[-_.]\d{1,3})?)\s+(.*)$/.exec(rest);
  if (stamp) {
    const recordedAt = parseStamp(stamp[1]!);
    const title = (stamp[2] ?? '').trim();
    return {
      title: title || rest,
      ...(recordedAt !== undefined ? { recordedAt } : {}),
      hasDanmakuInPicture,
      ...(partIndex !== undefined ? { partIndex } : {}),
    };
  }
  return { title: rest, hasDanmakuInPicture, ...(partIndex !== undefined ? { partIndex } : {}) };
}

/* ============================================================================
 * 候选清单
 * ========================================================================== */

/** 一个「同一场录制」的文件变体（原始 flv / 已烧弹幕的压制产物 / 分段） */
export interface RecordingVariant {
  videoPath: string;
  fileName: string;
  sizeBytes: number;
  sizeMB: number;
  hasDanmakuInPicture: boolean;
  partIndex?: number;
  /** 修改时间（毫秒） */
  mtimeMs: number;
}

export interface RecordingCandidate {
  videoPath: string;
  fileName: string;
  /** 父目录名（通常是主播名） */
  group: string;
  sizeBytes: number;
  durationSec: number;
  resolution?: string;
  codec?: string;
  /** 配套弹幕 */
  danmaPath?: string;
  danmaKind?: 'xml' | 'ass';
  /** 弹幕是怎么找到的：biliLive-tools 映射 / 同名文件 / 没找到 */
  danmaSource: 'bililive-tools' | 'sibling' | 'segment' | 'none';
  /** 解析出来的标题（来自 biliLive-tools 历史优先，其次文件名） */
  title: string;
  /** 该标题的来源，界面要如实展示，不能让用户以为都是官方记录 */
  titleSource: 'record-history' | 'filename';
  recordedAt?: number;
  roomId?: string;
  /** 画布里已经烧了弹幕（`-弹幕版`） */
  hasDanmakuInPicture: boolean;
  /**
   * 分段序号（`_PART000` / `-PART003` 这类）。
   *
   * 为什么要暴露到候选上：`watch-import` 需要用它把「压制产物」与「同一分段的原始录制」
   * 配对，从而在**确实存在原始录制**时跳过压制产物（用户确认的分工：
   * 弹幕版/纯享版归 biliLive-tools 投，切片助手只处理原始录制）。
   * 没有它就只能按文件名前缀猜，容易把不同分段的文件错配到一起。
   */
  partIndex?: number;
  /** 文件是否可解析（损坏文件会被标出来而不是悄悄列进去） */
  usable: boolean;
  brokenReason?: string;
  /** 已经导入过（同一文件已属于某个任务） */
  importedBy?: { taskId: string; status: string };
  /** 多分段：本文件所在的分段组共有几个文件 */
  segmentCount: number;
  /** ASR 预检（usable 才有） */
  asr?: { windows: number; cacheHits: number; estCost: number };
  /** 来源：biliLive-tools 录制历史 / 扫盘 */
  source: 'record-history' | 'scan';
  /**
   * 这场录制的全部文件变体（原始 flv + `-弹幕版` 压制产物 + 各分段）。
   *
   * 为什么按「场」归并而不是一个文件一行：实测同一个直播间一次录制会产生
   * 3–5 个文件（原始 flv、`-弹幕版.mp4`、`_PART000.flv`…），逐行列出来
   * 用户根本分不清该选哪个，而且**很容易错选 `-弹幕版`**（画面已烧弹幕，再烧一次就是双层弹幕）。
   * 归并后默认给「原始、未烧弹幕」的那个，界面再把其它变体作为备选列出来。
   */
  variants: RecordingVariant[];
  /** 可能仍在录制（文件刚被写入过）——导入它会拿到半场素材 */
  possiblyRecording: boolean;
  /**
   * 本场还有几个分段**仍在录制**（已闭合的部分不受影响）。
   *
   * 为什么单独报出来：「一场录制分多段」时，已闭合的那一段现在就能导入，
   * 但用户看到"只导入了第 1 段"会以为漏了 —— 有这个数字界面上才能说清
   * "还有 1 段在录，录完会自动进来"。`possiblyRecording=false` 且它 > 0 就是这种状态。
   */
  pendingParts?: number;
  /**
   * 还在写入的那些分段（文件名 + 体积），给界面如实列出来。
   *
   * 只有 `pendingParts` 一个数字时，界面只能说"还有 1 段在录"，用户没法核对是哪一个；
   * 实测（2026-09-24 晚）改完新鲜度判定后，监控面板的「正在录制」整块消失了 ——
   * 因为那块是从"因仍在写入而被跳过"的候选行拼出来的，而新逻辑下这个候选**已经能导入**、
   * 不再产生那种跳过行。观测性不能因为修 bug 而丢掉，所以这里把名字一起带上。
   */
  pendingFiles?: Array<{ fileName: string; sizeMB: number }>;
  /**
   * 本场是由几个「相邻碎片」拼起来的（>1 表示合并过；见文件顶部「碎片合并」一节）。
   */
  fragmentCount?: number;
  /**
   * **还在等后续碎片**：现在导入会把这一场拆成多个任务，所以先不动。
   *
   * 判定 = 合并过（fragmentCount > 1）且最新写入距今 < `import.stitch.quietSec` 且跨度还没到
   * `import.stitch.maxMinutes`。跨度到顶就 `capped=true`、不再等（否则一场断一整晚就永远不导入）。
   */
  stitchWaiting?: boolean;
  /** 碎片合并的细节，给界面如实展示（等多久、跨多久、是不是被上限打断） */
  stitch?: {
    fragmentCount: number;
    spanSec: number;
    quietSec: number;
    newestAgeSec: number;
    gapSec: number;
    capped: boolean;
  };
  /**
   * 合并场次里已经导过几段（`covered < total` 时这一场仍然可导入：剩下那几段会被导进来，
   * 已导过的不会重复转写）。界面据此解释"为什么这场没标已导入但也不是全新的"。
   */
  importedParts?: { covered: number; total: number };
}

/**
 * 「同一场录制」的归并键：去掉压制/分段后缀与扩展名。
 *
 * ⚠️ 走 `stripRecordingSuffixes`（循环剥、且认防覆盖 UUID），不要在这里另写一套正则：
 * 早先这里只剥**结尾**的产物后缀，于是 `…哈喽-弹幕版-<uuid>.mp4` 归出一个**新组**，
 * 目录轮询把它当成另一场导入了同一段素材（重复花 ASR 钱，且有重复投稿风险）。
 */
export function recordingGroupKey(fileName: string): string {
  return stripRecordingSuffixes(fileName).toLowerCase();
}

/* ============================================================================
 * 碎片合并（同一场直播被 CDN 断成多个文件）
 * ==========================================================================
 *
 * 实测背景（2026-10-06 晚，用户问「为啥几分钟就中断一次录制」）：
 *   biliLive-tools 那边每隔几分钟就 `record end, reason: ["finished"]` ——
 *   **不是它主动停**，是这一条 FLV 拉流被 CDN 那头关掉了（ffmpeg 正常退出、
 *   随即用一个新的 CDN 地址重连），于是同一场直播落成好几个文件：
 *     23-25-18-143 好冷好冷！电台一下.ts   （3.3 分钟）
 *     23-28-41-546 好冷好冷！电台一下.ts   （5.4 分钟）
 *     23-34-10-158 …、23-39-27-041 …、23-46-05-978 …
 *   每个文件自带一份弹幕 xml、一份封面 jpg、一份压制产物。
 *
 * 不合并的代价：一场直播被切成 N 个任务 → N 次转写、N 组切片、往同一个稿件里
 * 投 N 批分P（用户看到的就是"几分钟一段、投了一堆"）。
 *
 * ## 与「同一文件的分段」（`X.ts` + `X-PART001.ts`）的区别 —— 这条边界必须守住
 *
 *   · 同分段：**基名相同**（`stripRecordingSuffixes` 之后一模一样），只是被录制器切成了
 *     PART000/PART001…。已有逻辑允许"已闭合的那段先导入"，并报出「另有 N 段仍在写入」——
 *     这是 2026-09-24 用户报「录播为什么没有导入」之后专门修好的，**不能因为本次改动退回**。
 *   · 碎片：**基名不同**（开录时刻不同），是同一场直播的多次续录。
 *   所以下面只合并"基名不同、标题相同、开录时刻相邻"的文件，同基名的一律不碰。
 *
 * ## 为什么「相邻」要卡得这么死
 *
 *   录制器会把开播时刻写进文件名，同一天不同场次的录播天然长得很像；
 *   激进地按标题合并会把两场拼成一场（时间轴全错且极难发现）。
 *   这里要求：同目录 + 标题**完全相同** + 紧接着上一段结束（间隔 ≤ `gapSec`，
 *   默认 120 秒 —— 实测重连只隔 1～21 秒）。
 */

/** 一个碎片（= 一次续录）的身份 */
export interface FragmentIdentity {
  /** 目录（小写，用于比较） */
  dir: string;
  /** 标题（原样，仅去首尾空白）。空标题不参与合并 */
  title: string;
  /** 开录时刻（毫秒）；解析不出来就不参与合并 */
  startMs?: number;
  /**
   * 去后缀后的基名（小写）。
   * **基名相同 = 同一个文件被切成多段**（不是碎片），调用方据此区分两类。
   */
  baseKey: string;
  /** 压制产物（`-弹幕版` / `-纯享版` / `-danmaku`）：不算碎片 */
  product: boolean;
}

/** 解析一个文件属于哪个碎片 */
export function fragmentIdentityOf(filePath: string): FragmentIdentity {
  const fileName = path.basename(filePath);
  const parsed = parseRecordingFileName(fileName);
  /* ⚠️ 产物判定要看**原始基名**：`stripRecordingSuffixes` 存在的意义就是把
     `-弹幕版`/`-纯享版` 剥掉，拿剥完的字符串去测 PRODUCT_SUFFIX 永远为 false
     （第一版就是这么写的，`-纯享版` 直接被当成碎片）。 */
  const rawStem = fileName.replace(/\.[^.]+$/, '');
  const product = new RegExp(PRODUCT_SUFFIX, 'i').test(rawStem) || parsed.hasDanmakuInPicture;
  return {
    dir: path.dirname(filePath).toLowerCase(),
    title: parsed.title.trim(),
    ...(parsed.recordedAt !== undefined ? { startMs: parsed.recordedAt } : {}),
    baseKey: recordingGroupKey(fileName),
    product,
  };
}

export interface StitchConfig {
  /** 关掉就完全退回单文件行为 */
  enabled: boolean;
  /** 相邻碎片的最大间隔（秒）：上一段写完到下一段开录 */
  gapSec: number;
  /** 「安静」多久才认为这场不会再续录了（秒） */
  quietSec: number;
  /** 单次合并的时间跨度上限（分钟）：防止一整晚都断的时候永远不导入 */
  maxMinutes: number;
}

export const DEFAULT_STITCH: StitchConfig = { enabled: true, gapSec: 120, quietSec: 180, maxMinutes: 30 };

/** 一次「相邻碎片」串（run）：按开录时刻排好序、且两两相邻 */
export interface FragmentRun {
  /** 本串里所有碎片的文件（含同基名的分段），按 (开录时刻, 分段号, 路径) 排好序 */
  files: string[];
  /** 不同开录时刻的个数（= 碎片数）。1 表示没有可合并的对象 */
  fragmentCount: number;
  /** 首个碎片开录时刻 */
  startMs?: number;
  /** 本串最新的写入时刻（文件 mtime 的最大值） */
  newestMtimeMs: number;
  /** 时间跨度（秒）：从首个碎片开录到最新写入 */
  spanSec: number;
  /** 是否已经超过 maxMinutes（超了就"必须导入"，不再等） */
  capped: boolean;
}

/**
 * 找出样本文件所属的「相邻碎片串」。
 *
 * 返回 undefined 表示：样本的文件名解析不出开录时刻（那就不猜，按单文件处理）。
 */
export function stitchRunOf(
  samplePath: string,
  opts: { gapSec?: number; maxMinutes?: number; now?: number } = {},
): FragmentRun | undefined {
  const gapSec = opts.gapSec ?? DEFAULT_STITCH.gapSec;
  const maxMinutes = opts.maxMinutes ?? DEFAULT_STITCH.maxMinutes;
  const me = fragmentIdentityOf(samplePath);
  if (!me.title || me.startMs === undefined) return undefined;

  let entries: string[];
  try {
    entries = fs.readdirSync(path.dirname(samplePath));
  } catch {
    return undefined;
  }
  const dir = path.dirname(samplePath);
  interface Frag {
    startMs: number;
    endMs: number;
    files: string[];
  }
  /* 先按「开录时刻」归并成碎片：同一时刻的多个文件（`X.ts` + `X-PART001.ts`）算同一个碎片，
     碎片的结束时刻取它们 mtime 的最大值。 */
  const byStart = new Map<number, Frag>();
  for (const name of entries) {
    if (!VIDEO_EXT.test(name)) continue;
    const full = path.join(dir, name);
    const id = fragmentIdentityOf(full);
    if (id.product) continue;
    if (id.dir !== me.dir || id.title !== me.title || id.startMs === undefined) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const cur = byStart.get(id.startMs) ?? { startMs: id.startMs, endMs: 0, files: [] };
    cur.files.push(full);
    cur.endMs = Math.max(cur.endMs, mtimeMs);
    byStart.set(id.startMs, cur);
  }
  if (byStart.size < 2) return undefined;

  const frags = [...byStart.values()].sort((a, b) => a.startMs - b.startMs);
  /* 从样本所在碎片**先退到串头**，再从串头往前扩。为什么必须以串头为锚：
     上限（maxMinutes）会在中间截断，如果每个样本各自"以自己为中心"截，
     同一条串会被切成互相重叠的两段（实测：A→D 一段、D→E 又一段，D 落在两段里 ——
     两个候选都会来导它，同一段素材被转写两次）。锚定串头之后，
     一条串只可能出现在一个候选里，要么整条、要么从串头开始的前缀。 */
  const idx = frags.findIndex((f) => f.startMs === me.startMs);
  if (idx < 0) return undefined;
  const adjacent = (a: Frag, b: Frag): boolean => b.startMs >= a.startMs && b.startMs - a.endMs <= gapSec * 1000;

  let lo = idx;
  while (lo > 0 && adjacent(frags[lo - 1]!, frags[lo]!)) lo--;
  const capMs = Math.max(1, maxMinutes) * 60_000;
  const spanTo = (end: number): number => frags[end]!.endMs - frags[lo]!.startMs;
  let hi = lo;
  while (hi < frags.length - 1 && adjacent(frags[hi]!, frags[hi + 1]!) && spanTo(hi + 1) <= capMs) hi++;
  /* 上限把串截在样本之前 → 样本不属于这条串，交给调用方按单文件处理 */
  if (idx > hi) return undefined;

  const run = frags.slice(lo, hi + 1);
  const files = run
    .flatMap((f) => f.files)
    .sort((a, b) => {
      const ai = fragmentIdentityOf(a);
      const bi = fragmentIdentityOf(b);
      return (ai.startMs ?? 0) - (bi.startMs ?? 0) || (parseRecordingFileName(path.basename(a)).partIndex ?? 0) - (parseRecordingFileName(path.basename(b)).partIndex ?? 0) || a.localeCompare(b);
    });
  const newestMtimeMs = Math.max(...run.map((f) => f.endMs));
  const startMs = run[0]!.startMs;
  const spanSec = Number(((newestMtimeMs - startMs) / 1000).toFixed(1));
  return {
    files,
    fragmentCount: run.length,
    startMs,
    newestMtimeMs,
    spanSec,
    capped: spanSec * 1000 >= capMs,
  };
}

/**
 * 导入时用：把「同基名的分段」与「相邻碎片」合成一份有序文件表。
 *
 * 与 `discoverSegments` 的关系：先跑它（同基名分段，含第 0 段补位与"仍在写入"排除），
 * 再用碎片串补充**其它开录时刻**的文件。两边都尊重 `skipFreshWithinSec`
 * （仍在写的文件不进来，样本自己除外）。
 */
export function discoverRecordingFiles(
  samplePath: string,
  opts: { skipFreshWithinSec?: number; stitch?: Partial<StitchConfig>; now?: number } = {},
): { files: string[]; fragmentCount: number; skippedFresh: string[]; notes: string[] } {
  const stitch: StitchConfig = { ...DEFAULT_STITCH, ...(opts.stitch ?? {}) };
  const notes: string[] = [];
  const now = opts.now ?? Date.now();
  const parts = discoverSegments(samplePath, {
    ...(opts.skipFreshWithinSec !== undefined ? { skipFreshWithinSec: opts.skipFreshWithinSec } : {}),
    now,
  });
  if (!stitch.enabled || stitch.gapSec <= 0) return { files: parts, fragmentCount: 1, skippedFresh: [], notes };

  const run = stitchRunOf(samplePath, { gapSec: stitch.gapSec, maxMinutes: stitch.maxMinutes, now });
  if (!run || run.fragmentCount < 2) return { files: parts, fragmentCount: 1, skippedFresh: [], notes };

  const windowSec = Math.max(0, opts.skipFreshWithinSec ?? 0);
  const isFresh = (p: string): boolean => {
    if (windowSec <= 0 || p === samplePath) return false;
    try {
      return now - fs.statSync(p).mtimeMs < windowSec * 1000;
    } catch {
      return false;
    }
  };
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const f of [...parts, ...run.files]) {
    const key = f.toLowerCase();
    if (seen.has(key) || isFresh(f)) continue;
    seen.add(key);
    merged.push(f);
  }
  const freshSkipped = [...new Set([...parts, ...run.files])].filter((f) => isFresh(f));
  if (merged.length < 2) return { files: parts, fragmentCount: 1, skippedFresh: freshSkipped, notes };

  notes.push(
    `把 ${run.fragmentCount} 段相邻碎片当成一场（间隔 ≤ ${stitch.gapSec} 秒，跨度 ${Math.round(run.spanSec / 60)} 分钟）：` +
      run.files.map((f) => path.basename(f)).join('、'),
  );
  return { files: merged, fragmentCount: run.fragmentCount, skippedFresh: freshSkipped, notes };
}

export interface ListRecordingsOptions {
  /** biliLive-tools 客户端；不传就只扫盘 */
  client?: BiliLiveClient;
  /** 台账：用于判断「已导入过」 */
  ledger?: Ledger;
  /**
   * 额外扫描目录。**调用方自己的**目录（`listRecordingsDetailed` 会把它并入扫描根，
   * 与 `cfg.import.scanDirs` 等价叠加）。
   *
   * 轮询导入（`WatchImporter`）就是用它把 `import.watch.dirs` 传进来的 ——
   * 所以这个字段**必须真的被读**，只声明不读会让模块化的第一条腿（盯目录）静默失效。
   */
  extraDirs?: string[];
  /** 递归深度上限 */
  maxDepth?: number;
  /**
   * 碎片合并配置（见文件顶部「碎片合并」一节）。缺省用 `DEFAULT_STITCH`。
   * 调用方一般直接传 `cfg.import.stitch`。
   */
  stitch?: Partial<StitchConfig>;
  /** 小于该体积的文件直接忽略（默认 5MB） */
  minSizeMB?: number;
  limit?: number;
  /** 认为「可能仍在录制」的写入时间窗（秒），默认 120 */
  recordingWindowSec?: number;
  /** 是否做 ffprobe 探测与 ASR 预检（清单接口关掉它可以更快） */
  probe?: boolean;
  /** ASR 预检回调（传入文件与时长，返回窗口数/缓存命中/预估费用） */
  asrPreflight?: (videoPath: string, durationSec: number) => { windows: number; cacheHits: number; estCost: number };
  /** 由本函数填回：从 biliLive-tools 配置里探测到的保存目录（供界面展示） */
  detectedDirs?: string[];
  /**
   * 是否叠加兜底目录（biliLive-tools 的保存目录 + `~/Downloads/Bilibili`）。
   *
   * 默认 true（生产要的就是"尽量都能扫到"）；单元测试传 false，
   * 否则会把**真实**的录播目录也扫进来，断言就没法写了。
   */
  includeFallbackDirs?: boolean;
  logger?: Logger;
}

/** 用户主目录（`~` 展开用） */
function homeDir(): string {
  return process.env['USERPROFILE'] ?? process.env['HOME'] ?? os.homedir();
}

const VIDEO_EXT = /\.(flv|ts|mp4|mkv|m4s)$/i;
/**
 * 扫盘时**必须跳过**的目录名。
 *
 * 实测踩到过：把扫描根放宽到 `~/Downloads` 之后，回收站目录 `$RECYCLE.BIN` 里的
 * 文件也被列了出来（那是用户删掉的东西）—— 清单里混进这些非常困惑。
 */
const SKIP_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.git',
  'windows',
  'appdata',
  'program files',
  'program files (x86)',
  'programdata',
  '$windows.~bt',
  '$windows.~ws',
  'temp',
  'cache',
]);
/** 压制产物 / 分段：清单里默认只列「适合当源文件」的，但都保留可见 */
const COMPRESSED_HINT = new RegExp(`${PRODUCT_SUFFIX}$`, 'i');

/** 递归收集视频文件（用 realpath 去重，避免父子目录重复扫同一批） */
function scanVideos(roots: string[], maxDepth: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string): void => {
    let key: string;
    try {
      key = fs.realpathSync.native(p);
    } catch {
      key = path.resolve(p);
    }
    key = key.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const root of roots) {
    if (!root || !exists(root)) continue;
    const walk = (d: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
          walk(full, depth + 1);
        } else if (VIDEO_EXT.test(e.name)) add(full);
      }
    };
    walk(root, 0);
  }
  return out;
}

/** 找同名弹幕（.xml 优先于 .ass，与 §4.1 的信令口径一致） */
export function findSiblingDanmaku(videoPath: string): { path: string; kind: 'xml' | 'ass' } | undefined {
  const base = path.join(path.dirname(videoPath), path.basename(videoPath, path.extname(videoPath)));
  for (const ext of ['.xml', '.ass'] as const) {
    if (exists(base + ext)) return { path: base + ext, kind: ext.slice(1) as 'xml' | 'ass' };
  }
  return undefined;
}

/**
 * 从 biliLive-tools 的 `/config` 里挖出它自己的**保存目录**（可能有多个）。
 *
 * ⚠️ 字段名实测是 `recorder.savePath` / `video.subSavePath` / `tool.download.savePath`，
 * 而**不是** `webhook.recoderFolder` —— 一开始只找后者，结果永远返回 undefined，
 * 于是扫描范围退化成硬编码的 `~/Downloads/Bilibili`，
 * 用户放在 `Downloads\抖音\<主播>` 的录播就完全扫不到。
 * 所以这里按候选字段名逐个找，并把找到的**全部**返回（B站与抖音可能分开存）。
 */
export function recorderFoldersFromConfig(raw: unknown): string[] {
  // 允许带前缀：实测 `recorder.savePath` / `video.subSavePath` / `tool.download.savePath`，
  // 老版本可能在 `webhook.recoderFolder` —— 所以按「任意前缀 + 这些后缀」匹配。
  const wanted = /(^|\.)(recorder\.savePath|video\.subSavePath|tool\.download\.savePath|recoderFolder|recorderFolder|recordFolder)$/i;
  const out: string[] = [];
  const seen = new Set<unknown>();

  const walk = (v: unknown, prefix: string, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 6 || seen.has(v)) return;
    seen.add(v);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof val === 'string' && val.trim() && wanted.test(key)) {
        const p = val.trim();
        if (!out.includes(p)) out.push(p);
        continue;
      }
      if (val && typeof val === 'object') walk(val, key, depth + 1);
    }
  };
  walk(raw, '', 0);
  return out;
}

/** 兼容旧签名（单值版本）：返回第一个找到的目录 */
export function recorderFolderFromConfig(raw: unknown): string | undefined {
  return recorderFoldersFromConfig(raw)[0];
}

/**
 * 从 `/config` 里挖出**它正在录制的所有房间号**。
 *
 * 实测位置是 `virtualRecord.config[].roomId`；只查配置里那一个房间号的话，
 * 别的主播的录制历史就进不了清单（用户明确反馈过"我还有别的主播的录播，没有显示"）。
 *
 * ★ 补上 `recorders[].channelId`（2026-09-23 实测发现的漏读）：
 *   biliLive-tools 有三处放房间号，语义**不同**：
 *     ① `recorders[].channelId` —— **真正的直播录制**（"它在录谁"就是这个）；
 *     ② `virtualRecord.config[].roomId` —— 文件夹监听（把落盘文件当录播导入）；
 *     ③ `webhook.rooms` —— webhook 回调的房间级覆盖，**可能是遗留项**。
 *   本函数此前只读 ②，于是"正在录制的房间"漏掉了一半：实测 `recorders` 里是
 *   `12345678`(乙主播) + `23456789`(甲主播)，而 ② 里只有 `34567890` + `23456789` ——
 *   乙主播完全不在监控清单里，只是靠 `room.roomId` 恰好也等于 12345678 才被兜住；
 *   一旦配置里的默认房间号改成别的，乙主播的新录播就再也不会被自动处理。
 *   三处都读，去重后返回，才能保证"在录的都监控到"。
 */
export function roomIdsFromConfig(raw: unknown): string[] {
  const out = new Set<string>();
  const seen = new Set<unknown>();

  const push = (v: unknown): void => {
    if (typeof v !== 'string' && typeof v !== 'number') return;
    const s = String(v).trim();
    if (/^\d{2,}$/.test(s)) out.add(s);
  };

  /* ① 显式且语义明确：真正在录制的房间（优先，最多 2 层，避免误抓嵌套业务对象） */
  const doc = ((raw && typeof raw === 'object' && 'data' in (raw as object)
    ? (raw as { data?: unknown }).data
    : raw) ?? {}) as Record<string, unknown>;
  const recorders = doc['recorders'];
  if (Array.isArray(recorders)) {
    for (const r of recorders as Array<Record<string, unknown>>) {
      if (!r || typeof r !== 'object') continue;
      push(r['channelId'] ?? r['channel_id'] ?? r['roomId'] ?? r['room_id']);
    }
  }

  /* ②③ 兜底：全树遍历任意 `room_id` / `roomId` 键（覆盖 virtualRecord / webhook.rooms 等） */
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 7 || seen.has(v)) return;
    seen.add(v);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/room_?id$/i.test(k) && (typeof val === 'string' || typeof val === 'number')) {
        push(val);
      } else if (val && typeof val === 'object') {
        walk(val, depth + 1);
      }
    }
  };
  walk(raw, 0);
  return [...out];
}

/**
 * 列出可导入的录播。
 *
 * 合并两个来源：biliLive-tools 的录制历史（权威：有标题与弹幕对应关系）+ 扫盘（兜底：历史里没有的老文件）。
 * 同一条视频以历史为准（标题、房间号、弹幕都更可靠）。
 */
export async function listRecordings(cfg: AppConfig, opts: ListRecordingsOptions = {}): Promise<RecordingCandidate[]> {
  return (await listRecordingsDetailed(cfg, opts)).candidates;
}

export interface ListRecordingsResult {
  candidates: RecordingCandidate[];
  /** 这次**实际**扫了哪些目录（不是配置里写了什么）—— 界面要如实展示 */
  scanRoots: string[];
  /** 从 biliLive-tools 配置里探测到的保存目录 */
  detectedDirs: string[];
  /** 这次查了哪些房间的录制历史 */
  roomIds: string[];
  /** biliLive-tools 录制历史里的条目总数（含文件已不在磁盘的） */
  historyTotal: number;
  /** 历史里文件已不在磁盘的条数（用于提示"历史有 N 条但文件没了"） */
  historyMissing: number;
}

/** 完整版：除清单外还给出扫描范围与历史统计（界面用） */
export async function listRecordingsDetailed(cfg: AppConfig, opts: ListRecordingsOptions = {}): Promise<ListRecordingsResult> {
  const logger = opts.logger ?? globalLog;
  const maxDepth = opts.maxDepth ?? cfg.import.maxDepth;
  const minBytes = Math.max(0, (opts.minSizeMB ?? cfg.import.minSizeMB) * 1024 * 1024);
  const limit = opts.limit ?? 60;
  /* 碎片合并配置从**配置**取（调用方不必各自传一遍）：漏传会让清单说"1 段"
     而导入进来 5 个文件 —— 这类"两处口径不一致"的坑本项目踩过好几次。 */
  opts = { ...opts, stitch: opts.stitch ?? cfg.import.stitch };

  /* ---- 1. 来源一：biliLive-tools 录制历史 ---- */
  interface HistoryEntry {
    video_file?: string;
    danma_file?: string;
    title?: string;
    live_start_time?: number;
    record_start_time?: number;
    video_duration?: number;
    danma_num?: number;
    room_id?: string | number;
    live_id?: string | number;
  }
  const history = new Map<string, HistoryEntry>();
  /** 这次实际扫了哪些目录（界面要如实展示，用户才知道为什么有些录播没出现） */
  const scanRoots: string[] = [];
  /** 查过哪些房间、历史里有多少条、其中多少条文件已不在磁盘 */
  const checkedRooms: string[] = [];
  let historyTotal = 0;
  let historyMissing = 0;
  const detectedDirs: string[] = [];
  if (opts.client) {
    /* 房间号：配置里的那个**加上** biliLive-tools 自己在录的所有房间。
     * 只查一个房间的话，别的主播的录制历史永远进不来（用户反馈过这个问题）。 */
    const roomIds = new Set<string>([cfg.room.roomId].filter(Boolean));
    try {
      const raw = await opts.client.getConfig();
      for (const id of roomIdsFromConfig(raw)) roomIds.add(id);
      for (const d of recorderFoldersFromConfig(raw)) detectedDirs.push(d);
    } catch (e) {
      logger.debug(`读取 biliLive-tools 配置失败（房间列表与保存目录将退化）：${(e as Error).message}`);
    }
    for (const roomId of roomIds) {
      checkedRooms.push(roomId);
      try {
        const r = await opts.client.recordHistoryList({ roomId, platform: cfg.room.platform, page: 1, pageSize: 100 });
        historyTotal += r.list.length;
        for (const item of r.list) {
          const vf = String(item.video_file ?? '').trim();
          if (vf && exists(vf)) history.set(vf.toLowerCase(), item as HistoryEntry);
          else if (vf) historyMissing++;
        }
      } catch (e) {
        logger.debug(`读取 biliLive-tools 录制历史失败（不影响扫盘兜底）：${(e as Error).message}`);
      }
    }
  }

  /* ---- 2. 来源二：扫盘 ----
   *
   * 扫描根按优先级叠加（用户配的 > biliLive-tools 的保存目录 > 兜底）：
   *   1. `import.scanDirs`（界面可增删）；
   *   2. **biliLive-tools 自己的保存目录**（实测 `recorder.savePath` = `~/Downloads`，
   *      B站录播在 `Downloads\Bilibili\<主播>`、抖音录播在 `Downloads\抖音\<主播>`，
   *      所以扫它的保存目录才能覆盖"别的主播"；写死 `Downloads\Bilibili` 会漏掉一大半）；
   *   3. `~/Downloads/Bilibili`（老版本的默认位置，保留兼容）。
   */
  const roots = new Set<string>();
  const addRoot = (d: string | undefined): void => {
    const t = d?.trim();
    if (!t) return;
    // 支持 ~ 开头
    const expanded = t.startsWith('~') ? path.join(homeDir(), t.slice(1).replace(/^[\\/]/, '')) : t;
    if (exists(expanded)) roots.add(expanded);
  };
  for (const d of cfg.import.scanDirs) addRoot(d);
  /* `import.watch.dirs` 是通过 `extraDirs` 传进来的：**两个入口、同一份语义**。
     轮询导入只认自己那份配置（它传 `includeFallbackDirs: false`，免得每 60 秒把兜底目录里
     几百个文件也扫一遍），所以这里必须把 `extraDirs` 也加进扫描根 ——
     否则 `scanDirs` 为空时 roots 彻底为空、**扫盘一步都不做**。
     实测事故：丢进 `import.watch.dirs` 的新录播永远发现不了，
     轮询退化成了「只轮 biliLive-tools 录制历史」，而配置里写着"盯目录"。
     回归用例见 `test/recordings.ts` 的「extraDirs 必须真的参与扫盘」。 */
  for (const d of opts.extraDirs ?? []) addRoot(d);
  // ⚠️ 用局部变量 detectedDirs（本次从配置里探测到的结果），不要读 opts.detectedDirs ——
  //    那是"调用方传入"的语义；重构时曾写成 opts.detectedDirs，结果这里永远是空数组，
  //    扫描范围静默退回硬编码的 Downloads\Bilibili，别的主播的录播又看不见了。
  if (opts.includeFallbackDirs !== false) {
    for (const d of detectedDirs) addRoot(d);
    addRoot(path.join(homeDir(), 'Downloads', 'Bilibili'));
  }
  // B站录播的父目录（`~/Downloads/Bilibili`）常常就是保存目录的子目录，
  // 有保存目录时只留保存目录（父目录递归已覆盖），避免同一个文件被扫两遍
  const rootList = [...roots].filter((r) => ![...roots].some((o) => o !== r && r.toLowerCase().startsWith(o.toLowerCase() + path.sep)));
  for (const r of rootList) scanRoots.push(r);
  const scanned = scanVideos(rootList, maxDepth);
  logger.debug(`录播清单：扫盘 ${scanned.length} 个文件，历史 ${history.size} 条，目录 ${rootList.join(' | ')}`);

  /* ---- 3. 已导入过：比对台账所有任务的 rawFiles ---- */
  const importedBy = new Map<string, { taskId: string; status: string }>();
  /**
   * 「这一**场**已经导入过」：用与清单同一套归并键（目录 + 去后缀文件名）索引台账。
   *
   * 为什么还需要它：投稿完成后清理会把源文件删掉（`deleteAfterUpload`），
   * 盘上可能只剩同一场的**另一个变体**（例如 biliLive-tools 的弹幕版产物）。
   * 只按路径判重的话，那个变体会被当成一场新录播重新导入 —— 重新转写、
   * 重新选片、投出重复稿件，而日志里一切正常。
   */
  const importedGroups = new Map<string, { taskId: string; status: string }>();
  if (opts.ledger) {
    for (const t of opts.ledger.listTasks({ limit: 500 })) {
      const rec = { taskId: t.id, status: t.status };
      for (const f of t.source.rawFiles ?? []) {
        importedBy.set(f.toLowerCase(), rec);
        const gk = `${path.dirname(f).toLowerCase()}|${recordingGroupKey(path.basename(f))}`;
        if (!importedGroups.has(gk)) importedGroups.set(gk, rec);
      }
    }
  }

  /* ---- 4. 合并 + 探测 ---- */
  const byPath = new Map<string, { video: string; fromHistory?: HistoryEntry }>();
  for (const v of scanned) byPath.set(v.toLowerCase(), { video: v });
  for (const [key, h] of history) {
    const cur = byPath.get(key);
    if (cur) cur.fromHistory = h;
    else byPath.set(key, { video: String(h.video_file), fromHistory: h });
  }

  const out: RecordingCandidate[] = [];
  const now = Date.now();
  const recWindowMs = (opts.recordingWindowSec ?? RECORDING_WINDOW_SEC) * 1000;
  const doProbe = opts.probe !== false;
  const stitchCfg: StitchConfig = { ...DEFAULT_STITCH, ...(opts.stitch ?? {}) };

  /* ---- 4a. 先按「场」归并文件 ---- */
  interface Group {
    key: string;
    files: RecordingVariant[];
    fromHistory?: HistoryEntry;
  }
  const groups = new Map<string, Group>();
  for (const { video, fromHistory } of byPath.values()) {
    const size = fileSize(video);
    if (size < minBytes) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(video).mtimeMs;
    } catch {
      /* 读不到就按 0 处理 */
    }
    const fileName = path.basename(video);
    const parsed = parseRecordingFileName(fileName);
    const variant: RecordingVariant = {
      videoPath: video,
      fileName,
      sizeBytes: size,
      sizeMB: Number((size / 1024 ** 2).toFixed(1)),
      hasDanmakuInPicture: parsed.hasDanmakuInPicture,
      ...(parsed.partIndex !== undefined ? { partIndex: parsed.partIndex } : {}),
      mtimeMs,
    };
    const key = `${path.dirname(video).toLowerCase()}|${recordingGroupKey(fileName)}`;
    const g = groups.get(key) ?? { key, files: [] };
    g.files.push(variant);
    if (fromHistory && !g.fromHistory) g.fromHistory = fromHistory;
    groups.set(key, g);
  }

  /* ---- 4b. 每组选一个「首选源文件」----
   * 优先级：原始（未烧弹幕）的分段 → 原始单文件 → 已烧弹幕的压制产物。
   * 之所以把未烧弹幕的排前面：`fullVideoHasDanmaku` 一旦为 true，切片就不再传 ASS，
   * 画面里弹幕的样式/密度就完全由 biliLive-tools 那次压制决定了，我们改不了。 */
  const pickPreferred = (files: RecordingVariant[]): RecordingVariant => {
    const score = (f: RecordingVariant): number => {
      let s = 0;
      if (f.hasDanmakuInPicture) s += 100; // 已烧弹幕的最不想要
      if (f.partIndex !== undefined) s -= 5; // 分段文件更接近原始
      const ext = path.extname(f.fileName).toLowerCase();
      if (ext === '.flv') s -= 3;
      if (ext === '.ts') s -= 2;
      return s;
    };
    return [...files].sort((a, b) => score(a) - score(b) || (a.partIndex ?? 0) - (b.partIndex ?? 0))[0]!;
  };

  /* ---- 4a-2. 把「相邻碎片」并进同一场（见文件顶部「碎片合并」） ----
   *
   * 归并键里带开录时刻，所以今晚那种「一场直播断成 5 个文件」在 4a 之后是 5 个组。
   * 这里把「同目录 + 同标题 + 开录时刻紧接上一段结束（≤ gapSec）」的组串成一场。
   *
   * ⚠️ 只并**基名不同**的组：同基名 = 同一个文件被切成多段（`X.ts` + `X-PART001.ts`），
   *    那是 4b 里"已闭合的先导入 + pendingParts"那套逻辑的地盘，合并会把它搞乱。 */
  interface StitchMeta {
    fragmentCount: number;
    startMs?: number;
    newestMtimeMs: number;
    spanSec: number;
    capped: boolean;
  }
  const mergedEntries: Array<{ g: Group; meta?: StitchMeta; waiting?: boolean; newestAgeSec?: number }> = [];
  if (stitchCfg.enabled && stitchCfg.gapSec > 0 && groups.size > 0) {
    interface Chain {
      key: string;
      dir: string;
      title: string;
      baseKey: string;
      startMs: number;
      endMs: number;
      files: RecordingVariant[];
      fromHistory?: HistoryEntry;
      fragments: number;
    }
    const chains: Chain[] = [];
    for (const g of groups.values()) {
      const first = g.files[0];
      if (!first) continue;
      const id = fragmentIdentityOf(first.videoPath);
      const starts = g.files
        .map((f) => parseRecordingFileName(f.fileName).recordedAt)
        .filter((t): t is number => typeof t === 'number');
      if (!id.title || starts.length === 0) {
        // 解析不出开录时刻/标题：不参与合并，原样出去
        mergedEntries.push({ g });
        continue;
      }
      chains.push({
        key: g.key,
        dir: id.dir,
        title: id.title,
        baseKey: id.baseKey,
        startMs: Math.min(...starts),
        endMs: Math.max(...g.files.map((f) => f.mtimeMs)),
        files: [...g.files],
        ...(g.fromHistory ? { fromHistory: g.fromHistory } : {}),
        fragments: 1,
      });
    }
    chains.sort((a, b) => a.dir.localeCompare(b.dir) || a.title.localeCompare(b.title) || a.startMs - b.startMs);
    const capMs = Math.max(1, stitchCfg.maxMinutes) * 60_000;
    const used = new Set<number>();
    for (let i = 0; i < chains.length; i++) {
      if (used.has(i)) continue;
      const head = chains[i]!;
      const run: Chain[] = [head];
      used.add(i);
      let j = i + 1;
      while (j < chains.length) {
        const prev = run[run.length - 1]!;
        const next = chains[j]!;
        const sameSession = next.dir === prev.dir && next.title === prev.title && next.baseKey !== prev.baseKey;
        if (!sameSession) break;
        // 只看"紧挨着"的那一个：中间有别的场次时链就断了（宁可少并，不可错并）
        const gapMs = next.startMs - prev.endMs;
        if (gapMs > stitchCfg.gapSec * 1000) break;
        if (next.endMs - head.startMs > capMs) break;
        run.push(next);
        used.add(j);
        j++;
      }
      if (run.length === 1) {
        mergedEntries.push({ g: { key: head.key, files: head.files, ...(head.fromHistory ? { fromHistory: head.fromHistory } : {}) } });
        continue;
      }
      const files = run.flatMap((c) => c.files);
      const newestMtimeMs = Math.max(...run.map((c) => c.endMs));
      const startMs = run[0]!.startMs;
      const spanSec = Number(((newestMtimeMs - startMs) / 1000).toFixed(1));
      const capped = newestMtimeMs - startMs >= capMs;
      const newestAgeSec = Math.max(0, Number(((now - newestMtimeMs) / 1000).toFixed(1)));
      /* 还在等：最新写入距今还不够久（说明这场还会续录），且跨度没到上限。
         跨度到顶就必须导入，否则一整晚都在断的时候这一场永远进不来。 */
      const waiting = newestAgeSec < stitchCfg.quietSec && !capped;
      mergedEntries.push({
        g: {
          key: head.key,
          files,
          ...(run.find((c) => c.fromHistory)?.fromHistory
            ? { fromHistory: run.find((c) => c.fromHistory)!.fromHistory }
            : {}),
        },
        meta: { fragmentCount: run.length, startMs, newestMtimeMs, spanSec, capped },
        waiting,
        newestAgeSec,
      });
      logger.debug(
        `录播清单：把 ${run.length} 个相邻碎片并成一场「${head.title}」（${run.map((c) => path.basename(c.files[0]!.fileName)).join('、')}）` +
          `；最新写入 ${Math.round(newestAgeSec)} 秒前，跨度 ${Math.round(spanSec / 60)} 分钟${waiting ? '，先等它安静' : ''}`,
      );
    }
  } else {
    for (const g of groups.values()) mergedEntries.push({ g });
  }

  for (const entry of mergedEntries) {
    const g = entry.g;
    /* ★ 按**单个文件**的写入时间判断"还在录"，而不是整组一刀切。
     *
     * 实测事故（2026-09-24，用户问「录播为什么没有导入」）：甲主播那场是「一场录制分多段」的
     * 命名 —— 第 1 段闭合后叫 `18-00-41-946 …！.ts`（2.7 GB，18:59 写完），
     * 而正在录的第 2 段叫 `18-00-41-946 …！-PART001.ts`（**同一个归并键**，还在长）。
     * 旧实现取「组内最晚 mtime」→ 整组判为"仍在录制" → 目录轮询**整场跳过**，
     * 已闭合的第 1 段（整整一小时素材）一直进不来，要等整场直播结束才有机会。
     *
     * 现在的规则：组内**只要有一个文件已经写完**，就用写完的那些组成候选，
     * 把还在写的分段排除在外，并用 `pendingParts` 报出还有几段在录；
     * 整组都还在写时才保持原来的"仍在录制"判定。 */
    const isFresh = (f: { mtimeMs: number }): boolean => f.mtimeMs > 0 && now - f.mtimeMs < recWindowMs;
    const settled = g.files.filter((f) => !isFresh(f));
    const freshFiles = g.files.filter(isFresh);
    const usableFiles = settled.length > 0 ? settled : g.files;
    const possiblyRecording = settled.length === 0;

    const preferred = pickPreferred(usableFiles);
    const video = preferred.videoPath;
    const parsed = parseRecordingFileName(preferred.fileName);
    const sibling = findSiblingDanmaku(video);
    const historyDanma = g.fromHistory?.danma_file && exists(String(g.fromHistory.danma_file)) ? String(g.fromHistory.danma_file) : undefined;

    const probe = doProbe ? probeMedia(video) : { exists: true, duration: 0, error: undefined } as { exists: boolean; duration: number; error?: string; width?: number; height?: number; videoCodec?: string; audioCodec?: string };
    const usable = doProbe ? probe.exists && probe.duration > 0 : true;
    /* 列表阶段即使 ffprobe 也不能把"还在写的分段"算进来 —— 与导入时的规则保持一致，
       否则清单上写的分段数会比真正导入的多一段。 */
    /* 分段表：同基名的分段 **+ 相邻碎片**（见文件顶部「碎片合并」一节）。
       清单上显示的段数/弹幕有无必须与真正导入的东西一致 —— 否则用户看到"1 段"，
       导入进来却是 5 个文件（今晚这种"几分钟断一次"的场次就是这种形态）。 */
    const segs =
      usable && doProbe
        ? discoverRecordingFiles(video, {
            skipFreshWithinSec: Math.round(recWindowMs / 1000),
            stitch: stitchCfg,
            now,
          }).files
        : [video];

    /* 多段（同基名分段 / 相邻碎片）时，界面上的「时长」「体积」必须是**整场**的：
       只报首选文件那一段会让 21 分钟的一场显示成 3 分 20 秒，ASR 预估也跟着少算 6 倍
       （`asrPreflight(videoPath, durationSec)` 就是按这个值算窗口数的）。 */
    let durationSec = doProbe ? probe.duration : 0;
    let sizeBytes = preferred.sizeBytes;
    if (doProbe && segs.length > 1) {
      let durSum = 0;
      let sizeSum = 0;
      let probed = 0;
      for (const f of segs) {
        const p = probeMedia(f);
        if (p.duration > 0) {
          durSum += p.duration;
          probed++;
        }
        sizeSum += fileSize(f);
      }
      if (probed > 0) durationSec = Number(durSum.toFixed(3));
      if (sizeSum > 0) sizeBytes = sizeSum;
      if (probed < segs.length) {
        logger.debug(`录播清单：${path.basename(video)} 有 ${segs.length - probed} 段探测不到时长，整场时长偏小`);
      }
    }

    const danmaPath0 = historyDanma ?? sibling?.path;
    /* ★ 多分段录播：弹幕文件是按「**该段自己的开始时刻**」命名的，与视频分段的前缀对不上，
       所以「同名查找」与 biliLive-tools 的映射都拿不到第 2 段及以后。这里只判断
       「这场有没有分段弹幕」（精确配对要每段时长，导入时才有），让清单如实显示"有弹幕"，
       而不是显示成没有。 */
    const segCands = !danmaPath0 && segs.length > 1 ? listSegmentDanmaku(segs) : [];
    const danmaPath = danmaPath0 ?? segCands[0]?.path;
    const danmaKind = danmaPath ? ((path.extname(danmaPath).slice(1).toLowerCase() as 'xml' | 'ass') ?? 'xml') : undefined;

    const historyTitle = String(g.fromHistory?.title ?? '').trim();
    const title = historyTitle || parsed.title;

    /* 「这场是否已经导入过」要看**整组变体**，不能只看首选文件。
       实测事故的后续形态：原始 `.ts` 投稿完成后被清理删掉，盘上只剩它的弹幕版产物，
       此时首选文件变成弹幕版 → 只查首选文件就查不到「已导入」→ 同一段素材被第二次导入、
       第二次转写、第二次投稿。所以整组里任何一个文件命中台账、或**整场的归并键**命中台账，
       这一场都算已导入。回归用例见 `test/recordings.ts` 的 4d。

       顺序很重要：先认首选文件自己的任务（消息里报出的是"这一场的源文件属于谁"），
       再退到同组其它变体，最后才用归并键兜底 —— 否则报出来的任务号会随机漂移。

       ⚠️ **碎片合并之后要多判一层**（2026-10-06 实测的过渡态）：一场直播的碎片可能
       被陆续导入过一部分（今晚 B、C 就各自成了一个任务）。如果还按"任一文件命中就算已导入"，
       那么 A、C、D 会被 B 的导入记录整体挡住、再也不会被导入（素材静默丢失）。
       所以合并场次要按**碎片**逐个判：每个碎片用自己的归并键（目录 + 去后缀基名）比台账，
       **全部覆盖**才算这一场已导入；没覆盖的那些会在导入时被 `importLocal` 按台账过滤掉
       （两个机制合起来：已导过的碎片不重复转写，没导过的碎片不丢）。 */
    const fragmentKeys = new Set(g.files.map((f) => `${path.dirname(f.videoPath).toLowerCase()}|${recordingGroupKey(f.fileName)}`));
    const coveredFragments = [...fragmentKeys].filter((k) => importedGroups.has(k)).length;
    const allFragmentsCovered = fragmentKeys.size > 1 && coveredFragments === fragmentKeys.size;
    const importedHit = g.files.find((f) => importedBy.has(f.videoPath.toLowerCase()));
    const anyHit = importedBy.get(video.toLowerCase()) ?? (importedHit ? importedBy.get(importedHit.videoPath.toLowerCase()) : undefined);
    const importedRec =
      fragmentKeys.size > 1
        ? allFragmentsCovered
          ? (anyHit ?? importedGroups.get(g.key))
          : undefined
        : (anyHit ?? importedGroups.get(g.key));

    out.push({
      videoPath: video,
      fileName: preferred.fileName,
      group: path.basename(path.dirname(video)),
      sizeBytes,
      durationSec,
      ...(probe.width && probe.height ? { resolution: `${probe.width}x${probe.height}` } : {}),
      ...(probe.videoCodec ? { codec: `${probe.videoCodec}/${probe.audioCodec ?? '?'}` } : {}),
      ...(danmaPath ? { danmaPath } : {}),
      ...(danmaKind ? { danmaKind } : {}),
      danmaSource: historyDanma ? 'bililive-tools' : sibling ? 'sibling' : segCands.length ? 'segment' : 'none',
      title,
      titleSource: historyTitle ? 'record-history' : 'filename',
      ...(parsed.recordedAt !== undefined
        ? { recordedAt: parsed.recordedAt }
        : typeof g.fromHistory?.live_start_time === 'number'
          ? { recordedAt: g.fromHistory.live_start_time * 1000 }
          : {}),
      ...(typeof g.fromHistory?.room_id === 'string' || typeof g.fromHistory?.room_id === 'number'
        ? { roomId: String(g.fromHistory.room_id) }
        : {}),
      hasDanmakuInPicture: preferred.hasDanmakuInPicture,
      usable,
      ...(usable ? {} : { brokenReason: (probe.error ?? '无法解析').split('\n')[0]!.slice(0, 80) }),
      ...(importedRec ? { importedBy: importedRec } : {}),
      segmentCount: segs.length,
      source: g.fromHistory ? 'record-history' : 'scan',
      /* variants 只给**已经写完**的文件：目录轮询用它们做稳定性/基线判断，
         把还在写的分段混进去会让整场继续被跳过（就是本次修的那个 bug）。 */
      variants: [...usableFiles].sort((a, b) => (a.partIndex ?? -1) - (b.partIndex ?? -1)),
      possiblyRecording,
      ...(freshFiles.length > 0 && settled.length > 0
        ? {
            pendingParts: freshFiles.length,
            pendingFiles: freshFiles.map((f) => ({ fileName: f.fileName, sizeMB: f.sizeMB })),
          }
        : {}),
      ...(entry.meta
        ? {
            fragmentCount: entry.meta.fragmentCount,
            stitch: {
              fragmentCount: entry.meta.fragmentCount,
              spanSec: entry.meta.spanSec,
              quietSec: stitchCfg.quietSec,
              newestAgeSec: entry.newestAgeSec ?? 0,
              gapSec: stitchCfg.gapSec,
              capped: entry.meta.capped,
            },
            ...(entry.waiting ? { stitchWaiting: true } : {}),
            /* 合并场次里已导过几段：一部分导过时仍要放出剩下的（否则素材静默丢失） */
            ...(fragmentKeys.size > 1 && coveredFragments > 0
              ? { importedParts: { covered: coveredFragments, total: fragmentKeys.size } }
              : {}),
          }
        : {}),
    });
  }

  /* ---- 5. 排序：可用优先 → 未导入优先 → 时间倒序 ---- */
  out.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    const ai = a.importedBy ? 1 : 0;
    const bi = b.importedBy ? 1 : 0;
    if (ai !== bi) return ai - bi;
    const at = a.recordedAt ?? 0;
    const bt = b.recordedAt ?? 0;
    if (at !== bt) return bt - at;
    return b.sizeBytes - a.sizeBytes;
  });

  /* ---- 6. ASR 预检（只对要返回的那些做，避免给 50 个文件都算一遍） ---- */
  const shown = out.slice(0, limit);
  if (doProbe && opts.asrPreflight) {
    for (const c of shown) {
      if (!c.usable || c.durationSec <= 0) continue;
      try {
        c.asr = opts.asrPreflight(c.videoPath, c.durationSec);
      } catch {
        /* 预检失败不影响清单 */
      }
    }
  }
  return {
    candidates: shown,
    scanRoots,
    detectedDirs,
    roomIds: checkedRooms,
    historyTotal,
    historyMissing,
  };
}

/** 给界面用的一行摘要（避免界面自己算格式） */
export function describeCandidate(c: RecordingCandidate): string {
  const parts = [
    c.durationSec > 0 ? fmtDuration(c.durationSec) : '时长未知',
    fmtBytes(c.sizeBytes),
    c.danmaPath ? `弹幕 ${c.danmaKind}` : '无弹幕',
    `${c.segmentCount} 段`,
  ];
  if (c.variants.length > 1) parts.push(`${c.variants.length} 个版本`);
  if (c.hasDanmakuInPicture) parts.push('画面已烧弹幕');
  if (c.possiblyRecording) parts.push('可能仍在录制');
  /* ★ 本场还有分段在写入时必须**说出来**。
     2026-09-24 的修复把"整组是否还在录"改成按文件判定之后，已闭合的分段变得可导入了，
     但界面上"可能仍在录制"也跟着消失 —— 用户会以为系统不知道还在录。
     两个事实要同时讲清：这一段已经写完（可处理），本场还有 N 段在写（录完会自动进来）。 */
  if (c.pendingFiles?.length) parts.push(`本场另有 ${c.pendingFiles.length} 段仍在写入`);
  /* 碎片合并的状态也要说出来：用户看到"3.3 分钟的一场"会以为录短了，
     实际是它还在等后续碎片（CDN 每隔几分钟断一次），合并后才是整场。 */
  if (c.stitch && c.stitch.fragmentCount > 1) {
    const wait = c.stitchWaiting
      ? `，等安静 ${Math.max(0, Math.round(c.stitch.quietSec - c.stitch.newestAgeSec))} 秒后整场导入`
      : c.stitch.capped
        ? `（跨度已达上限，先导这一段）`
        : '';
    parts.push(`已拼 ${c.stitch.fragmentCount} 段相邻碎片${wait}`);
  }
  if (c.importedBy) parts.push(`已导入(${c.importedBy.status})`);
  if (!c.usable) parts.push('文件不可用');
  return parts.join(' · ');
}

/* ============================================================================
 * 导入预览
 * ========================================================================== */

export interface RecordingPreview {
  videoPath: string;
  fileName: string;
  title: string;
  titleSource: 'record-history' | 'filename';
  danmaPath?: string;
  danmaKind?: 'xml' | 'ass';
  /** 弹幕来源：biliLive-tools 的对应关系 / 同名文件 / 没找到 */
  danmaSource: 'bililive-tools' | 'sibling' | 'segment' | 'none';
  durationSec: number;
  sizeBytes: number;
  sizeMB: number;
  resolution?: string;
  codec?: string;
  segmentCount: number;
  /** 本场这一组文件的所有变体（供界面让用户换源） */
  variants: RecordingVariant[];
  hasDanmakuInPicture: boolean;
  possiblyRecording: boolean;
  importedBy?: { taskId: string; status: string };
  usable: boolean;
  brokenReason?: string;
  asr?: { windows: number; cacheHits: number; estCost: number };
  /** 给用户看的提示（不是错误，但每一条都对应一个实测踩过的坑） */
  warnings: string[];
}

/**
 * 导入前预览一个文件。
 *
 * 与清单的区别：这里只针对**一个**文件做完整检查，并且会去问 biliLive-tools
 * 「这个视频对应的弹幕文件是哪个」（`POST /record-history/danma-file`）——
 * 它自己的对应关系比"同名文件"可靠（文件名被改过、弹幕在别的目录都能找到）。
 */
export async function previewRecording(
  videoPath: string,
  cfg: AppConfig,
  opts: { client?: BiliLiveClient; ledger?: Ledger; asrPreflight?: (p: string, d: number) => { windows: number; cacheHits: number; estCost: number }; logger?: Logger } = {},
): Promise<RecordingPreview> {
  const warnings: string[] = [];
  if (!exists(videoPath)) throw new Error(`文件不存在：${videoPath}`);

  const fileName = path.basename(videoPath);
  const parsed = parseRecordingFileName(fileName);

  /* ---- 探测（分段列表要早于弹幕解析：多分段弹幕是「按段配对」的）---- */
  const probe = probeMedia(videoPath);
  const usable = probe.exists && probe.duration > 0;
  const segs = usable ? discoverSegments(videoPath) : [videoPath];

  /* ---- 弹幕：先问 biliLive-tools，再退回同名文件，最后按分段配对 ---- */
  let danmaPath: string | undefined;
  let danmaKind: 'xml' | 'ass' | undefined;
  let danmaSource: RecordingPreview['danmaSource'] = 'none';
  let segCands: ReturnType<typeof listSegmentDanmaku> = [];
  if (opts.client) {
    try {
      const ref = await opts.client.danmaFileByVideoPath(videoPath);
      const p = String(ref?.danmaFilePath ?? '').trim();
      if (p && exists(p)) {
        danmaPath = p;
        const ext = path.extname(p).slice(1).toLowerCase();
        danmaKind = ext === 'ass' ? 'ass' : 'xml';
        danmaSource = 'bililive-tools';
      }
    } catch (e) {
      opts.logger?.debug(`向 biliLive-tools 查询弹幕对应关系失败，改用同名文件：${(e as Error).message}`);
    }
  }
  if (!danmaPath) {
    const sib = findSiblingDanmaku(videoPath);
    if (sib) {
      danmaPath = sib.path;
      danmaKind = sib.kind;
      danmaSource = 'sibling';
    }
  }
  /* ★ 多分段：录制器给**每一段单独存一个弹幕文件**，用的是「该段自己的开始时刻」，
     与视频分段的前缀（会话开始时刻 + `-PART{n}`）对不上 —— 所以上面两条路都拿不到它。
     这里只判断「有没有」；精确到段的配对与合并放在导入时做（那里才有每段时长）。 */
  if (!danmaPath && segs.length > 1) {
    segCands = listSegmentDanmaku(segs);
    const first = segCands[0];
    if (first) {
      danmaPath = first.path;
      danmaKind = path.extname(first.path).toLowerCase() === '.ass' ? 'ass' : 'xml';
      danmaSource = 'segment';
    }
  }

  const size = fileSize(videoPath);

  /* ---- 已导入过 ---- */
  let importedBy: { taskId: string; status: string } | undefined;
  let importedByVariant: { fileName: string; taskId: string; status: string } | undefined;
  if (opts.ledger) {
    const lower = videoPath.toLowerCase();
    for (const t of opts.ledger.listTasks({ limit: 500 })) {
      if ((t.source.rawFiles ?? []).some((f) => f.toLowerCase() === lower)) {
        importedBy = { taskId: t.id, status: t.status };
        break;
      }
    }
  }

  /* ---- 同一场的其它变体 ---- */
  const dir = path.dirname(videoPath);
  const key = recordingGroupKey(fileName);
  const variants: RecordingVariant[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!VIDEO_EXT.test(f)) continue;
      if (recordingGroupKey(f) !== key) continue;
      const full = path.join(dir, f);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      const p = parseRecordingFileName(f);
      variants.push({
        videoPath: full,
        fileName: f,
        sizeBytes: fileSize(full),
        sizeMB: Number((fileSize(full) / 1024 ** 2).toFixed(1)),
        hasDanmakuInPicture: p.hasDanmakuInPicture,
        ...(p.partIndex !== undefined ? { partIndex: p.partIndex } : {}),
        mtimeMs,
      });
    }
  } catch {
    /* 目录读不到就只列当前文件 */
  }
  if (variants.length === 0) {
    variants.push({
      videoPath,
      fileName,
      sizeBytes: size,
      sizeMB: Number((size / 1024 ** 2).toFixed(1)),
      hasDanmakuInPicture: parsed.hasDanmakuInPicture,
      ...(parsed.partIndex !== undefined ? { partIndex: parsed.partIndex } : {}),
      mtimeMs: 0,
    });
  }

  const latestMtime = Math.max(0, ...variants.map((v) => v.mtimeMs));
  const possiblyRecording = latestMtime > 0 && Date.now() - latestMtime < RECORDING_WINDOW_SEC * 1000;

  /* 变体级判重：如果**同一场的另一个文件**已经导入过，这一场就已经有任务了 ——
     再导一次会新建一场、重新花 ASR 钱，而且会投出重复稿件。
     先按路径精确比，再按「场的归并键」比（覆盖源文件已被清理、只剩变体的情形）。 */
  if (!importedBy && opts.ledger) {
    const taskOf = new Map<string, { taskId: string; status: string }>();
    const taskOfGroup = new Map<string, { taskId: string; status: string }>();
    for (const t of opts.ledger.listTasks({ limit: 500 })) {
      const rec = { taskId: t.id, status: t.status };
      for (const f of t.source.rawFiles ?? []) {
        taskOf.set(f.toLowerCase(), rec);
        const gk = `${path.dirname(f).toLowerCase()}|${recordingGroupKey(path.basename(f))}`;
        if (!taskOfGroup.has(gk)) taskOfGroup.set(gk, rec);
      }
    }
    for (const v of variants) {
      const hit = taskOf.get(v.videoPath.toLowerCase());
      if (hit) {
        importedByVariant = { fileName: v.fileName, ...hit };
        break;
      }
    }
    if (!importedByVariant) {
      const hit = taskOfGroup.get(`${dir.toLowerCase()}|${key}`);
      if (hit) importedByVariant = { fileName: `同一场的「${key}」`, ...hit };
    }
  }

  /* ---- 提示（每条都对应一个实测踩过的坑） ---- */
  if (!usable) {
    warnings.push(`文件无法解析：${(probe.error ?? '未知原因').split('\n')[0]} —— 录制中断的文件（MP4 缺 moov atom）不能作为源`);
  }
  if (possiblyRecording) {
    warnings.push('文件刚被写入过，**可能仍在录制**：现在导入会拿到半场素材，建议等这场结束后再导入');
  }
  if (importedBy) {
    warnings.push(`这个文件已经属于任务 ${importedBy.taskId}（${importedBy.status}）—— 再次导入会新建一场并**重新花 ASR 费用**`);
  } else if (importedByVariant) {
    warnings.push(
      `**这一场已经导入过**了：同一场的「${importedByVariant.fileName}」属于任务 ${importedByVariant.taskId}` +
        `（${importedByVariant.status}）—— 同一段素材再导一次会重新花 ASR 费用，并可能投出重复稿件`,
    );
  }
  if (!danmaPath) {
    warnings.push('没有找到配套弹幕文件：本场没有弹幕信号，选片只能依赖转写');
  } else if (danmaSource === 'sibling') {
    warnings.push(`弹幕是按同名文件找到的（${path.basename(danmaPath)}）—— 若不对请在导入时手动指定`);
  } else if (danmaSource === 'segment') {
    warnings.push(
      `弹幕是**按分段逐段配对**的（录制器给每一段单独存了一个弹幕文件，前缀与视频分段不同）：` +
        `${segs.length} 段共找到 ${segCands.length} 个弹幕文件，导入时会合并成一条与成片对齐的时间轴`,
    );
  }
  if (parsed.hasDanmakuInPicture) {
    warnings.push('这是**已烧弹幕**的压制产物：导入后切片不会再传 ASS（避免双层弹幕），画面弹幕样式由那次压制决定');
  }
  if (segs.length > 1) {
    warnings.push(`检测到 ${segs.length} 个分段文件，将按时间顺序合并为一场（分段：${segs.map((s) => path.basename(s)).join('、')}）`);
  }
  if (variants.length > 1 && !parsed.hasDanmakuInPicture) {
    const burned = variants.filter((v) => v.hasDanmakuInPicture);
    if (burned.length) warnings.push(`同一场还有已烧弹幕的版本（${burned.map((v) => v.fileName).join('、')}），如果要用它请在上方切换`);
  }

  const out: RecordingPreview = {
    videoPath,
    fileName,
    title: parsed.title,
    titleSource: 'filename',
    ...(danmaPath ? { danmaPath } : {}),
    ...(danmaKind ? { danmaKind } : {}),
    danmaSource,
    durationSec: probe.duration,
    sizeBytes: size,
    sizeMB: Number((size / 1024 ** 2).toFixed(1)),
    ...(probe.width && probe.height ? { resolution: `${probe.width}x${probe.height}` } : {}),
    ...(probe.videoCodec ? { codec: `${probe.videoCodec}/${probe.audioCodec ?? '?'}` } : {}),
    segmentCount: segs.length,
    variants,
    hasDanmakuInPicture: parsed.hasDanmakuInPicture,
    /* 分段序号要透传到候选上：watch-import 靠它把「压制产物」与「同一分段的原始录制」
       配对，从而在确实存在原始录制时跳过压制产物（见 RecordingCandidate.partIndex 的说明）。 */
    ...(parsed.partIndex !== undefined ? { partIndex: parsed.partIndex } : {}),
    possiblyRecording,
    ...(importedBy ? { importedBy } : {}),
    usable,
    ...(usable ? {} : { brokenReason: (probe.error ?? '无法解析').split('\n')[0]!.slice(0, 80) }),
    warnings,
  };
  if (opts.asrPreflight && usable && probe.duration > 0) {
    try {
      out.asr = opts.asrPreflight(videoPath, probe.duration);
    } catch {
      /* 预检失败不影响预览 */
    }
  }
  void cfg;
  return out;
}
