/**
 * WP5 —— 切片与投稿编排（任务书 §4.3 / §4.4 / §8 WP5）。
 *
 * 推荐主路径是**两步走**，不要依赖 `/task/cut` 自带的自动上传：
 *   1. `POST /task/cut` → 得到 taskId
 *   2. 轮询 `GET /task/:id` 到 `completed`，**从任务对象读取真实的 `task.output`**
 *   3. `POST /bili/upload`（body `{ uid, videos: [task.output], config }`）
 * 理由：产出路径由服务端返回而非调用方猜测，每步可见、可重试、可核对。
 *
 * 幂等的三层保障：
 *   - 本地 `ledger` 指纹（`sourceVideoId + start + end + titleHash`，**只存本地**）
 *   - 投稿前用 `GET /bili/archives` 按标题反查（服务器侧真相）
 *   - 状态机把 `SUBMITTING` 写在提交之前，崩溃后据此恢复而不是盲目重投
 */
import fs from 'node:fs';
import { extractCover, pickCoverSource } from './cover.ts';
import { QuotaGuard, type QuotaGuardStatus } from './quota-guard.ts';
import {
  RATE_LIMIT_DEFAULT_WAIT_SEC,
  UPLOAD_QUOTA_RETRY_AFTER_MIN,
  classifySubmitLimit,
  describeVerdict,
  isUploadRateLimited,
  parseRateLimitWaitSec,
  shouldAutoRetry,
} from './failure-class.ts';
import type { Alerter } from './alert.ts';
import path from 'node:path';
import type {
  ArchiveItem,
  BiliUploadResponse,
  BiliUser,
  ClipRecord,
  ErrorType,
  FfmpegPreset,
  RetryAttempt,
  TaskRecord,
  Transcript,
  TranscriptSegment,
} from './types.ts';
import type { AppConfig, ClipPublishMode } from './config.ts';
import {
  DTIME_MIN_MARGIN_SEC,
  describeScheduleOverride,
  effectiveJitterSec,
  resolveClipPublishMode,
  resolveClipPublishSchedule,
  resolveDataPath,
} from './config.ts';
import { BiliLiveClient, ApiError } from './api.ts';
import type { Ledger } from './ledger.ts';
import { clipFingerprint } from './ledger.ts';
import {
  fillDefaultTags,
  mergeIdentityTags,
  resolveIdentityTags,
  sanitizeDesc,
  sanitizeTags,
  sanitizeTitle,
  TAG_LIMIT,
} from './analyze.ts';
import { convertDanmakuToAss, findDanmakuFactory } from './danmaku-ass.ts';
import { buildBurnAss, buildCues } from './subtitle-ass.ts';
import { ensureAvSync } from './av-sync.ts';
import { checkClipTitles, checkTitle, summarizeTitleIssues } from './title-check.ts';
import { GlossaryStore, type Glossary } from './glossary.ts';
import {
  DATA_DIR,
  TASKS_DIR,
  ensureDir,
  exists,
  fileSize,
  fmtDuration,
  fmtLocal,
  nowIso,
  randomInt,
  readJson,
  sleep,
  writeJsonAtomic,
} from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';
import { writeErrorReport } from './errors.ts';
import { findDuplicateTitles, readOpenBatches, recordBatchOutcome, recordBatchSubmit, recordDuplicateParts, type Batch } from './publish-batches.ts';

/* ============================================================================
 * 投稿提交闸门与「限流」安全重试（2026-10-17 线上事故）
 *
 * 事故：任务 `auto-20261017112152-ap05` 的片段 #1 报
 *   `BiliResponseError: 您投稿的频率过快，请稍等2秒`
 * 并被我们判成 FAILED + 写错误报告，需要人工重投。当时日志显示同一进程里
 * **两个任务在并行投稿**，两次 `upload task end` 只差 1.1 秒 —— B站 的限流是**按账号**的，
 * 而原有的 `publish.minSubmitIntervalSec` 抖动只管「本批第 2 片起」（条件是 `i > 0`），
 * 两个批次的**首片**几乎同时提交，谁也拦不住谁。
 *
 * 两条防线（都刻意做成常量而不是配置键，避免配置面扩散 —— 这几个数不是业务偏好，
 * 而是"B站 说请稍等 2 秒"的直接翻译）：
 *   1. {@link UPLOAD_SUBMIT_MIN_GAP_MS}：进程级**串行**提交闸门，任意两次提交之间至少隔 3 秒；
 *   2. 限流拒绝（提交被拒、B站 侧什么都没创建）时按对方给的秒数等待并重试，最多 3 次。
 *      这与 `shouldAutoRetry` 的「upload-failed 绝不自动重试」**不冲突**：那条守卫防的是
 *      「已经发起过上传、可能已经落地」的重复分P；限流拒绝恰恰是"明确没落地"，可以安全重试。
 * ========================================================================== */

/** 投稿提交闸门：任意两次 `biliUpload` 提交之间的最小间隔（毫秒）。3 秒覆盖 B站 的「请稍等2秒」。 */
export const UPLOAD_SUBMIT_MIN_GAP_MS = 3000;
/** 被限流时最多尝试几次提交（含首次）。耗尽后按失败处理，failReason 里写明重试次数。 */
export const UPLOAD_RATE_LIMIT_MAX_ATTEMPTS = 3;
/** 单次限流等待的**上限**（秒）：对方说 2 秒就等 2 秒，说 600 秒也最多等 30 秒然后按失败处理。 */
export const UPLOAD_RATE_LIMIT_WAIT_CAP_SEC = 30;

/* ============================================================================
 * 配额级限流（账号级投稿配额打满）—— 2026-10-21 线上事故
 *
 * 事故：任务 `auto-20261021030839-l3ti`，切片 #3 在 11:41:31 报
 *   `BiliResponseError: 投稿过于频繁，请稍后再试`（**没有秒数**）。
 * 台账当天 94 分钟提交了 18 次、间隔都 ≥143 秒（`minSubmitIntervalSec=120` 是生效的），
 * 说明撞的不是"两次提交太近"，而是**账号当天的投稿配额**。
 * 当时的行为（publish-log 里 submit 与 fail 落在同一毫秒）：
 *   · 这句话不匹配任何秒级限流措辞 ⇒ 被当成永久失败 ⇒ 这一片直接 FAILED；
 *   · 本批剩下的 #4/#5/#6 继续按 143 秒间隔逐片往上撞 ⇒ 一片不落全撞死；
 *   · 用户要人工逐片重投，而这时配额其实还没恢复。
 *
 * 修法（只动限流这一条路径）：
 *   1. 识别 quota 级（{@link classifySubmitLimit} === 'quota'）⇒ **fail-fast**，
 *      不在同一轮里连撞（配额不可能在 10 秒内恢复，重试只是白挨拒绝）；
 *   2. 该片写 **CANDIDATE（待投）** 而不是 FAILED —— 它是"可重投"，不是"永久失败"，
 *      failReason 里写明原因、今日已投数量与建议重试时间；
 *   3. 本批**立即收手**：后续没投的切片直接跳过（日志记明剩余几片），并走 alerter 发一条 warn。
 * 与秒级限流（`请稍等2秒`）的关系：带秒数的一律仍走原来的短退避重试，**行为不变**。
 * ========================================================================== */

/* ============================================================================
 * 工具：路径、预设、封面、dtime
 * ========================================================================== */

/** 把配置里的相对路径解析成绝对路径（biliLive-tools 要求绝对路径） */
export function absPath(p: string): string {
  return path.isAbsolute(p) ? p : resolveDataPath(p);
}

/**
 * 解析 biliLive-tools 预设里的封面路径。
 * 预设里的相对路径是**相对 biliLive-tools 的进程目录**，我们无从得知，
 * 因此只在「明确相对本项目的 data/ 目录」时才尝试解析，否则原样回传让对方自己解析。
 */
function resolvePresetCover(p: string): string {
  if (path.isAbsolute(p)) return p;
  const candidate = resolveDataPath(p);
  return exists(candidate) ? candidate : p;
}

/** dtime 距提交时刻的安全余量（秒）：见 `config.ts` 中 `DTIME_MIN_MARGIN_SEC` 的口径说明（1200）。 */


/**
 * 抖动上限的**有效值**：必须严格小于片间隔。
 *
 * ★ 2026-10-17：实现已搬到 `config.ts`（`resolveClipPublishSchedule()` 的单独投稿分支也要用同一道
 * 夹子，而 `publish.ts` 已经 import 了 `config.ts` —— 反过来 import 会成环）。
 * 这里**保留同名导出**，因为测试与外部工具（`test/dtime-schedule.ts`、`tools/verify-*.ts`）
 * 一直是 `from '../src/publish.ts'` 取它；签名与语义一字未改，只是搬了个家。
 */
export { effectiveJitterSec };

/**
 * dtime 排期公式（硬约束 #4）：
 *   `dtime = submitTime + submitGapSec + (N - 1) × clipGapSec + random(0, 有效抖动)`，N 从 1 开始
 *   （`有效抖动` = `effectiveJitterSec(jitterSec, clipGapSec)`，见上）
 *
 * ⚠️ 依据说明（别把它误传成平台规则）：B站的硬限制是 **`dtime` 必须晚于「当前时间」300 秒**
 * （投稿页口径「定时发布 ≥5 分钟、≤15 天」），这是相对**提交时刻**的约束，
 * **不是相对上一个切片**。同一次流程里提交的多个切片，
 * 各自满足「大于自己的提交时间 + 300」即全部合法，**相邻间隔多少并不受额外限制** ——
 * 也就是说 `clipGapSec` 是**我们自己的**错峰值（线上 300 秒 = 每片 5 分钟），
 * 调大调小都不违反平台规则，唯一要守的是「抖动 < 间隔」这个顺序不变量。
 *
 * ⚠️ **关于 7200 / DTIME_MIN_MARGIN_SEC**：本项目一度把余量卡在「提交后 7200 秒」并称之为 B站硬限，
 * 两处都错（见 `config.ts` 中 `DTIME_MIN_MARGIN_SEC` 的口径修正）。现在是「平台底线 300 + 自律余量 = 1200」。
 *
 * @param submitTimeMs 该稿件的提交时刻（毫秒）
 * @param n 从 1 开始计数的序号
 * @param opts `daytimeOnly` 为 true 时用 `N × clipGapSec`，让全部切片延后到白天发布
 */
export function computeDtime(
  submitTimeMs: number,
  n: number,
  opts: {
    submitGapSec: number;
    clipGapSec: number;
    jitterSec: number;
    daytimeOnly?: boolean;
    rng?: () => number;
    /**
     * 该片的「不早于」时刻（秒级时间戳）。
     * 用于用户显式指定的首片发布时间 —— dtime 距**本稿件的提交时刻**至少要有 1200 秒，
     * 所以指定时间比这更早时只能推迟到最早合法时间（调用方记录原因）。
     */
    notBeforeSec?: number;
  },
): number {
  const rng = opts.rng ?? Math.random;
  const base = opts.submitGapSec + (opts.daytimeOnly ? n : Math.max(0, n - 1)) * opts.clipGapSec;
  const jitterCap = effectiveJitterSec(opts.jitterSec, opts.clipGapSec);
  const jitter = jitterCap > 0 ? Math.floor(rng() * jitterCap) : 0;
  const auto = Math.floor(submitTimeMs / 1000) + base + jitter;
  // 用户指定了发布时间：取「自动值」与「指定值」的较大者，
  // 既尊重用户意图，又不会突破余量下限。
  return opts.notBeforeSec ? Math.max(auto, opts.notBeforeSec) : auto;
}

/**
 * 校验 dtime 是否满足硬约束（供 UI 实时校验与投稿前自检）
 *
 * 判据：距提交时刻 ≥ `DTIME_MIN_MARGIN_SEC`（1200 秒）。
 * B站平台的底线是 ≥ 300 秒；1200 是「平台底线 + 900 秒自律余量」。
 */
export function validateDtime(dtimeSec: number, submitTimeMs: number): { ok: boolean; marginSec: number; note: string } {
  const marginSec = dtimeSec - Math.floor(submitTimeMs / 1000);
  if (marginSec >= DTIME_MIN_MARGIN_SEC) {
    return { ok: true, marginSec, note: `距提交时刻 ${marginSec} 秒（≥ ${DTIME_MIN_MARGIN_SEC} 秒，合规）` };
  }
  return {
    ok: false,
    marginSec,
    note: `dtime 距提交时刻仅 ${marginSec} 秒，**不满足**本项目硬约束 #4 的「≥ ${DTIME_MIN_MARGIN_SEC} 秒」（B站平台底线是 300 秒），此值投出去会被拒（陷阱 #12）`,
  };
}

/**
 * 提交前的**最后一道合规自检**（硬约束 #4 是按「该稿件**自己的**提交时刻」算的）。
 *
 * 为什么需要它：排期是拿**批次开始时刻**当基准算的（`computeDtime(batchStartMs, n, …)`，
 * 整批共用一个基准，N 片之间才是等距的）；但真正调 B站 接口的时刻是**逐片往后推**的
 * （每片要等切片完成 + 上传，还有 `minSubmitIntervalSec` 的风控间隔）。
 * 上传一慢，靠后的切片就可能出现「它自己的 dtime − 它自己的提交时刻 < 1200」⇒ B站 直接拒稿，
 * 而那时候的报错信息完全看不出是排期问题。
 *
 * 所以提交那一刻再核一次：不够就把发布时间抬到「现在 + 1200」，并把原因写进 warnings。
 * 正常情况（首片 1200 余量 + 逐片 300 秒间隔）永远不会触发 —— 触发即说明提交比排期慢得多。
 */
export function clampDtimeForSubmit(
  dtimeSec: number,
  submitTimeMs: number,
): { dtime: number; bumped: boolean; marginSec: number; note: string } {
  const submitSec = Math.floor(submitTimeMs / 1000);
  const marginSec = dtimeSec - submitSec;
  if (marginSec >= DTIME_MIN_MARGIN_SEC) {
    return { dtime: dtimeSec, bumped: false, marginSec, note: `dtime 距提交时刻 ${marginSec} 秒（≥ ${DTIME_MIN_MARGIN_SEC} 秒，合规）` };
  }
  const floor = submitSec + DTIME_MIN_MARGIN_SEC;
  return {
    dtime: floor,
    bumped: true,
    marginSec,
    note:
      `这一片排的 ${fmtLocal(dtimeSec * 1000)} 距本次提交只剩 ${marginSec} 秒，` +
      `不满足本项目硬约束 #4「dtime 距本稿件提交时刻 ≥ ${DTIME_MIN_MARGIN_SEC} 秒」⇒ 已自动推迟到 ${fmtLocal(floor * 1000)}` +
      `（提交比排期慢：上传/切片耗时把后面的片挤到了下限以内）`,
  };
}

/**
 * 构建 ffmpegOptions：从 `/preset/ffmpeg` 取一条预设的 config 作为基础，叠加 ss/to。
 *
 * 任务书要求「不要手写编码参数：读取用户已配置的预设，叠加 ss/to 即可」。
 * 但预设可能缺少必要字段（实测 default 预设未声明编码器），因此支持配置级覆盖兜底。
 * 无论走哪条路径，`api.ts` 都会拦截 `codec=copy`（硬约束 #5）。
 */
export function buildFfmpegOptions(
  presets: FfmpegPreset[],
  presetId: string,
  range: { start: number; end: number },
  override: Record<string, string> | null,
): { options: Record<string, unknown>; source: string; warnings: string[] } {
  const warnings: string[] = [];
  const preset = presets.find((p) => p.id === presetId) ?? presets[0];
  const base: Record<string, unknown> = { ...((preset?.config as Record<string, unknown>) ?? {}) };
  const source = preset ? `preset:${preset.id ?? 'unknown'}` : 'builtin';

  if (!preset) {
    warnings.push(`未找到 ffmpeg 预设 "${presetId}"，使用内置覆盖参数`);
  }
  // 覆盖项用于补齐预设缺失的字段（或显式指定软编以便离线测试）
  for (const [k, v] of Object.entries(override ?? {})) {
    if (base[k] === undefined || override) base[k] = v;
  }

  // ss / to 必须最后叠加，避免被预设里的同名键覆盖
  base['ss'] = Number(range.start.toFixed(3));
  base['to'] = Number(range.end.toFixed(3));

  /* ⚠️ `encoder` 必须一起查：biliLive-tools 真正认的是它的预设字段 `encoder`，
     写 `c:v` 会被静默忽略（2026-10-13 实测）。只查 c:v/vcodec/codec 会把
     "预设里是 copy" 这种情况漏过去，而 copy 正是硬约束 #5 禁止的。 */
  const enc = base['c:v'] ?? base['vcodec'] ?? base['codec'] ?? base['encoder'];
  if (typeof enc === 'string' && enc.toLowerCase() === 'copy') {
    warnings.push('编码器为 copy —— 硬约束 #5 禁止切片用 stream copy（开头花屏 + 弹幕错位），投稿前会被 api.ts 拒绝');
  }
  return { options: base, source, warnings };
}

/**
 * 封面解析（首版策略，§4.4）：
 * 优先级由 `coverSource` 控制 —— `default`（配置的默认封面）/ `preset`（biliLive-tools 投稿预设）/ `fullVideo`（复用完整版封面）。
 * **默认 `preset`**。若配置的封面路径不存在，回退到下一优先级，并在日志中记录回退原因。
 *
 * 首版不做封面抽帧与封面编辑器，验收只要求「封面字段有值且合规」。
 */
export function resolveCover(
  cfg: AppConfig,
  ctx: {
    /** biliLive-tools 投稿预设里可能带的封面 */
    presetCover?: string;
    /** 完整版稿件反查到的封面 */
    fullVideoCover?: string;
    /**
     * 封面抽帧（P2，2026-10-14）：当 `publish.coverFrom === 'frame'` 时用。
     * 由调用方把"候选切片"传进来（本函数保持纯计算 —— 真正的抽帧由 cover.ts 执行）。
     * 不传 ⇒ 与历史行为完全一致。
     */
    frameCandidates?: Array<{ index: number; score?: number; cutOutput?: string; status?: string }>;
    /** 抽帧输出路径（调用方给，通常放在该场次目录下） */
    frameOutPath?: string;
  },
  logger?: Logger,
): { cover?: string; source: string; attempts: Array<{ source: string; path?: string; ok: boolean; reason: string }> } {
  /* ★ 抽帧优先（只在显式配置 coverFrom='frame' 时）：
     从评分最高的切片里抽一帧 —— 切片本身就是"这场最精彩的几秒"，比完整版里随便抽更有代表性。
     抽帧失败/没有可用切片 ⇒ **静默回退**到下面的老路径（记一条 attempts，日志里能看到原因）。 */
  const attempts: Array<{ source: string; path?: string; ok: boolean; reason: string }> = [];
  if (cfg.publish.coverFrom === 'frame') {
    const src = ctx.frameCandidates ? pickCoverSource(ctx.frameCandidates) : undefined;
    if (!src) {
      attempts.push({ source: 'frame', ok: false, reason: '没有已切好且有产物的切片可用于抽帧' });
    } else if (!ctx.frameOutPath) {
      attempts.push({ source: 'frame', ok: false, reason: '调用方未提供抽帧输出路径' });
    } else {
      const r = extractCover({ inPath: src.path, outPath: ctx.frameOutPath });
      if (r.ok && r.path) {
        attempts.push({ source: 'frame', path: r.path, ok: true, reason: `${r.note}（取自切片 #${src.index}）` });
        return { cover: r.path, source: 'frame', attempts };
      }
      attempts.push({ source: 'frame', ok: false, reason: r.note });
    }
  }

  const order: Array<'default' | 'preset' | 'fullVideo'> =
    cfg.publish.coverSource === 'default'
      ? ['default', 'preset', 'fullVideo']
      : cfg.publish.coverSource === 'fullVideo'
        ? ['fullVideo', 'preset', 'default']
        : ['preset', 'default', 'fullVideo'];

  for (const src of order) {
    if (src === 'default') {
      const p = cfg.publish.defaultCover;
      if (!p) {
        attempts.push({ source: 'default', ok: false, reason: '未配置 publish.defaultCover' });
        continue;
      }
      const abs = absPath(p);
      if (exists(abs)) return { cover: abs, source: 'default', attempts };
      attempts.push({ source: 'default', path: abs, ok: false, reason: `文件不存在：${abs}` });
    } else if (src === 'preset') {
      const p = ctx.presetCover;
      if (!p) {
        attempts.push({ source: 'preset', ok: false, reason: '投稿预设未带封面' });
        continue;
      }
      const abs = resolvePresetCover(p);
      if (exists(abs)) return { cover: abs, source: 'preset', attempts };
      // biliLive-tools 的预设封面可能只是文件名，交给对方解析
      attempts.push({ source: 'preset', path: p, ok: true, reason: '预设封面非绝对路径，交由 biliLive-tools 解析' });
      return { cover: p, source: 'preset', attempts };
    } else {
      const p = ctx.fullVideoCover;
      if (!p) {
        attempts.push({ source: 'fullVideo', ok: false, reason: '完整版稿件没有可用封面' });
        continue;
      }
      attempts.push({ source: 'fullVideo', path: p, ok: true, reason: '复用完整版封面' });
      return { cover: p, source: 'fullVideo', attempts };
    }
  }
  if (attempts.some((a) => !a.ok)) {
    logger?.warn(
      `封面回退：按 coverSource=${cfg.publish.coverSource} 未取到封面。回退过程：` +
        attempts.map((a) => `${a.source}(${a.reason})`).join(' → ') +
        ' —— 将不传封面字段，由 biliLive-tools 投稿预设决定',
    );
  }
  return { source: 'none', attempts };
}


/**
 * 解析「首片发布时间」配置。
 *
 * 接受 datetime-local 的原生格式 `YYYY-MM-DDTHH:mm`，也容忍用空格代替 T。
 * 返回**秒**级时间戳；无法解析、已过去、或超过 90 天时返回 undefined（视为未指定）。
 */
/**
 * 解析用户**手填**的发布时间：`2026-09-24T08:00` / `2026-09-24 08:00` / 秒级或毫秒级时间戳。
 *
 * 与 `parseFirstPublishAt` 的区别：这里**不做**"明显误填"的宽容过滤 ——
 * 用户在看板上手填的时间就是要生效的，合不合规交给 `validateDtime` 判定并**原样告知原因**
 * （悄悄改掉用户填的时间比报错更糟）。
 */
export function parseUserDtime(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const sec = raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw); // 毫秒也认
    return sec > 0 ? sec : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().replace(' ', 'T');
  if (!t) return undefined;
  if (/^\d{10,13}$/.test(t)) return parseUserDtime(Number(t));
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

export function parseFirstPublishAt(s: string | undefined | null): number | undefined {
  if (!s || typeof s !== 'string') return undefined;
  const t = s.trim().replace(' ', 'T');
  if (!t) return undefined;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return undefined;
  const sec = Math.floor(ms / 1000);
  const now = Math.floor(Date.now() / 1000);
  // 只做「明显的误填」过滤：
  //   · 早于 1 小时前 —— 基本是把旧时间粘进来了，无意义
  //   · 晚于 90 天     —— 多半是把毫秒/纳秒当秒写进去了
  // 至于「比 B站下限早」（例如指定 1 小时后），**不能在这里丢弃** ——
  // 那是完全合理的用户意图，应由 describeDtimePlan 推迟到最早合法时间。
  if (sec < now - 3600) return undefined;
  if (sec > now + 90 * 86400) return undefined;
  return sec;
}

/**
 * 秒数 → 人话（`300 ⇒ 5 分钟`、`470 ⇒ 7 分 50 秒`）。
 *
 * 只用于排期文案：`Math.round(gapSec / 60)` 在 470 秒时会说成「8 分钟」（实际 7 分 50 秒），
 * 而排期文案里的数字是用户拿来核对 dtime 的，宁可比"整分钟"啰嗦一点，也不能四舍五入骗人。
 */
function fmtSpanShort(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest} 秒`;
  return rest === 0 ? `${m} 分钟` : `${m} 分 ${rest} 秒`;
}

/**
 * 把排期意图翻成人话，供日志与 UI 使用。
 * 能明确回答「首片什么时候发、最后一片什么时候发、我指定的时间是否被推迟了」。
 *
 * ★ 2026-10-16：可选的模式三件套（`clipPublishMode` / `multiPart` / `immediatePublish`）
 *   一旦给出，就按 `resolveClipPublishSchedule()` 的**生效口径**算 ——
 *   否则界面会拿 config 里那个（可能被抬/被夹的）`clipGapSec` / `jitterSec` 预览出一份
 *   与实际排期不同的时间表。不给这三个键时行为逐字不变
 *   （纯函数测试与老调用点都走这条）。
 */
export function describeDtimePlan(
  submitTimeMs: number,
  cfg: {
    submitGapSec: number;
    clipGapSec: number;
    jitterSec: number;
    firstPublishAt: string;
    clipPublishMode?: ClipPublishMode;
    multiPart?: boolean;
    immediatePublish?: boolean;
  },
  clipCount: number,
): { first: number; last: number; note: string; userSpecified: boolean; earliestAllowed: number; scheduled: boolean; gapSec: number } {
  const hasMode = cfg.clipPublishMode !== undefined || cfg.multiPart !== undefined || cfg.immediatePublish !== undefined;
  const sched = hasMode
    ? resolveClipPublishSchedule({
        ...(cfg.clipPublishMode !== undefined ? { clipPublishMode: cfg.clipPublishMode } : {}),
        multiPart: cfg.multiPart === true,
        immediatePublish: cfg.immediatePublish === true,
        clipGapSec: cfg.clipGapSec,
        jitterSec: cfg.jitterSec,
      })
    : undefined;
  const gapSec = sched ? sched.gapSec : cfg.clipGapSec;
  const jitterSec = sched ? sched.jitterSec : cfg.jitterSec;
  const want = parseFirstPublishAt(cfg.firstPublishAt);
  const mk = (n: number): number =>
    computeDtime(submitTimeMs, n, {
      submitGapSec: cfg.submitGapSec,
      clipGapSec: gapSec,
      jitterSec,
      ...(want !== undefined ? { notBeforeSec: want } : {}),
    });
  const first = mk(1);
  const last = mk(Math.max(1, clipCount));
  // 余量下限：提交时刻 + 1200 秒（= 平台底线 300 + 自律余量 900）
  const earliestAllowed = Math.floor(submitTimeMs / 1000) + DTIME_MIN_MARGIN_SEC;
  const scheduled = sched ? sched.scheduled : true;
  let note = sched && !scheduled
    ? '当前是「立即发布」（不传 dtime）：这几个时间**不会**被使用，稿件过审即公开'
    : sched && sched.mode === 'standalone'
      ? `单独投稿：每片一稿，固定定时投稿、每片相隔 ${gapSec} 秒（${fmtSpanShort(gapSec)}）` +
        (jitterSec > 0 ? `，每片再加 0~${jitterSec} 秒随机抖动` : '等距')
      : '按公式自动排期（错峰发布）';
  if (want !== undefined) {
    const hardFloor = Math.floor(submitTimeMs / 1000) + DTIME_MIN_MARGIN_SEC;
    if (want >= hardFloor) {
      note =
        want >= earliestAllowed
          ? '按你指定的首片时间发布'
          : `你指定的时间距提交不足 ${DTIME_MIN_MARGIN_SEC} 秒（项目自律下限，平台底线是 300 秒），已保留但余量偏小，建议再晚一些`;
    } else {
      // 比下限还早：只能推迟，并明确告知实际会用的时间
      note =
        '你指定的 ' +
        new Date(want * 1000).toLocaleString('zh-CN') +
        ` 早于本项目下限（提交后须 ≥${DTIME_MIN_MARGIN_SEC} 秒），已自动推迟到 ` +
        new Date(Math.max(first, earliestAllowed) * 1000).toLocaleString('zh-CN');
    }
  }
  return { first, last, note, userSpecified: want !== undefined, earliestAllowed, scheduled, gapSec };
}
/* ============================================================================
 * 稿件反查（一查三用：完整版完成确认 / bvid 来源 / 切片幂等）
 * ========================================================================== */

/** 标题归一化，用于服务器侧反查比对（去空白、去标点、全角转半角） */
export function normalizeTitleForMatch(title: string): string {
  return String(title)
    .replace(/[\s\u3000]+/g, '')
    // 标点：ASCII 与全角都要去。全角那几个（`．＿－、·…`）是实测会出现在 B站标题里的
    // ——只去半角时，`2026．09．22` 归一化后全角点还在，与 `2026.09.22` 比不相等，
    // 续传目标就找不着了。全角字符一律用 `\u` 转义写，避免肉眼分不清全角/半角。
    .replace(
      /[【】\[\]（）()《》<>「」『』,，.。\uFF0E!！?？:：;；'"“”‘’~～\-—_/\\|+*#@&$%^\uFF3F\uFF0D、·…]/g,
      '',
    )
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/**
 * 主播名归一化（用于「这一场是谁」的房间匹配）。
 *
 * 为什么要归一：目录名常带平台后缀（`乙主播`），而配置里/接口返回的名字可能写成
 * `乙主播`、`乙主播Official`、`乙主播 official` —— 直接全等会漏配，漏配的代价是简介里挂上**别人的**
 * UP 主（2026-10-17 实测：乙主播的场次写成了 @甲主播）。
 */
export function normStreamerName(name: unknown): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[_\-·.\s\u3000]/g, '')
    .replace(/official$/, '')
    .trim();
}

export interface ArchiveMatch {
  bvid: string;
  /** 稿件 aid —— 续传（`/bili/upload` 带 `vid`）时要用它 */
  aid?: number | string;
  title?: string;
  ctime?: number;
  exact: boolean;
}

/* ----------------------------------------------------------------------------
 * 反查结果的**可信度校验**（实测踩过的错配）
 *
 * 背景：某场直播的多分P 切片稿件，主标题天然等于「直播标题 + 日期」——
 * 而这个标题**和账号里完整版录播稿件的标题一模一样**。
 * 于是按主标题反查时命中了**完整版录播**，把它的 bvid 写到了 6 个切片上，
 * 台账与幂等指纹全部被污染（日志里能看到 6 条 confirm 指向同一个完整版 bvid）。
 *
 * 结论：**命中不等于正确**。写入 bvid 之前必须过三道闸：
 *   1. 必须是精确匹配（`exact`），包含匹配一律不认；
 *   2. 稿件的创建时间必须落在本次提交之后（缺 `ctime` 时**拒绝**，宁可 pending 也不写错）；
 *   3. 命中的标题不能是该场的**完整版录播标题**（那是另一条链路的稿件）。
 * -------------------------------------------------------------------------- */

export interface ArchiveVerifyResult {
  ok: boolean;
  /** 不通过的原因（用于日志与体检报告） */
  reason?: string;
  code?: 'not-exact' | 'no-ctime' | 'too-old' | 'is-full-video';
}

/**
 * 校验一个反查命中是否可信。
 *
 * @param match       matchArchive 的命中项
 * @param expected    我们期望的标题（切片标题，或主标题）
 * @param submitTimeMs 本次投稿的提交时刻（毫秒）；缺失时跳过时间闸（旧数据兼容）
 * @param fullVideoTitles 该场完整版录播可能的标题（用于排除）
 */
export function verifyArchiveMatch(
  match: ArchiveMatch,
  expected: string,
  opts: { submitTimeMs?: number; fullVideoTitles?: string[] } = {},
): ArchiveVerifyResult {
  if (!match.exact) {
    return { ok: false, code: 'not-exact', reason: `只匹配到「包含」关系（命中标题：${match.title ?? '未知'}），不足以确认是我们投的那条` };
  }
  const hit = normalizeTitleForMatch(match.title ?? '');
  // 完整版录播标题：它和切片稿件主标题可能完全相同，必须单独排除
  for (const full of opts.fullVideoTitles ?? []) {
    const f = normalizeTitleForMatch(full);
    if (f && hit === f) {
      return {
        ok: false,
        code: 'is-full-video',
        reason: `命中的是**完整版录播**稿件（标题「${match.title}」），不是本次投的切片稿件`,
      };
    }
  }
  if (opts.submitTimeMs !== undefined) {
    if (typeof match.ctime !== 'number' || !Number.isFinite(match.ctime)) {
      // 缺 ctime 时**不能**只凭标题写 bvid：实测正是这种情形把完整版 bvid 写了进去
      return { ok: false, code: 'no-ctime', reason: '命中稿件没有创建时间（ctime），无法确认它是本次提交产生的' };
    }
    // 允许 5 分钟时钟偏差；再早就不可能是这次投的
    if (match.ctime * 1000 < opts.submitTimeMs - 5 * 60_000) {
      return {
        ok: false,
        code: 'too-old',
        reason: `命中稿件创建于 ${new Date(match.ctime * 1000).toLocaleString()}，早于本次提交 ${new Date(opts.submitTimeMs).toLocaleString()}`,
      };
    }
  }
  void expected;
  return { ok: true };
}

/**
 * 该场「完整版录播」可能用的标题集合。
 *
 * 完整版由 biliLive-tools 或本服务的完整版支线自动上传，标题模板与切片主标题高度重合
 * （实测就是完全相同），所以反查时必须显式排除它。
 */
export function fullVideoTitleCandidates(task: TaskRecord): string[] {
  const out = new Set<string>();
  const live = cleanLiveTitle(task.title);
  const date = taskDateText(task);
  for (const t of [task.title, live, `${live} ${date}`, live.replace(/\s+/g, '')]) {
    if (t && t.trim()) out.add(t.trim());
  }
  return [...out];
}

/**
 * 判断一个接口错误是否**可能是**「稿件已不存在」。
 *
 * 实测两种 500 文案：
 *   `—— 稿件不可见`（稿件被删/下架）
 *   `—— 啥都木有`（稿件查不到：可能是被删，也可能是**审核中/转码中**还没生成详情）
 * 注意 `啥都木有` 有歧义，**不能只凭它下结论**：
 * 刚投出去的稿件处于「审核中」时详情接口同样返回它。
 * 所以调用方必须再确认「该 bvid 已不在稿件列表里」才能标记为消失
 * （见 daemon.refreshPerformance），否则会把正在审核的新稿件误判成已删除。
 */
export function isArchiveGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!msg) return false;
  return /稿件不可见|稿件不存在|已删除|不存在或已被删除|啥都木有|archive not found|-404\b/i.test(msg);
}

/**
 * 「稿件已不存在」的**强证据**：错误文案本身就指明稿件没了。
 *
 * ★ 2026-10-17 事故修复（见 docs/待修问题-墓碑误解除与分页判据-2026-10-17.md）：
 *   `啥都木有` 是 biliLive-tools 的通用「上游没数据」—— 未发布（待审核 arc_audits）、
 *   仅自己可见、接口异常都会返回它，**不能单独作为「已删除」的证据**。
 *   实测它把一个 `state=-1 待发布`、明明还在稿件列表里的稿件判成了已删，
 *   连锁导致 18 条防重复墓碑被误自动解除。
 *   因此**不可逆的自动动作**（墓碑自动解除）只认强证据：
 *   `稿件不可见 / 稿件不存在 / 已删除 / archive not found / -404`；
 *   弱证据（含 `啥都木有`）一律按「说不清」保留待下次（墓碑 7 天后还有 prune 兜底，不会堆积）。
 */
export function isStrongArchiveGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!msg) return false;
  if (/啥都木有/.test(msg)) return false;
  return /稿件不可见|稿件不存在|已删除|不存在或已被删除|archive not found|-404\b/i.test(msg);
}

/**
 * 在已投稿件列表里按标题反查。
 *
 * ⚠️ 为什么必须反查而不是用 taskId：`/bili/upload` 只返回 `taskId`，
 * 而 biliLive-tools 的任务队列在内存中、**进程重启即丢**（陷阱 #11、硬约束 #17）。
 * `/bili/archives` 查的是 B站服务器，是唯一可靠的完成证据。
 */
export function matchArchive(archives: ArchiveItem[], title: string, opts: { sinceMs?: number } = {}): ArchiveMatch[] {
  const want = normalizeTitleForMatch(title);
  const out: ArchiveMatch[] = [];
  for (const a of archives) {
    if (!a.bvid) continue;
    if (opts.sinceMs !== undefined && a.ctime && a.ctime * 1000 < opts.sinceMs) continue;
    const t = normalizeTitleForMatch(a.title ?? '');
    if (!t) continue;
    if (t === want) {
      out.push({
        bvid: a.bvid,
        ...(a['aid'] !== undefined ? { aid: a['aid'] as number | string } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.ctime ? { ctime: a.ctime } : {}),
        exact: true,
      });
    } else if (t.includes(want) || want.includes(t)) {
      out.push({
        bvid: a.bvid,
        ...(a['aid'] !== undefined ? { aid: a['aid'] as number | string } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.ctime ? { ctime: a.ctime } : {}),
        exact: false,
      });
    }
  }
  // 精确匹配优先
  return out.sort((a, b) => Number(b.exact) - Number(a.exact));
}

/* ----------------------------------------------------------------------------
 * 续传目标解析：找「biliLive-tools 已投出的那个稿件」
 *
 * 用户的工作流是「一场直播的分段录播由 biliLive-tools 投成 **1 个稿件的 N 个分P**，
 * 切片助手只把切片追加进同一个稿件」。biliLive-tools 侧我们已从它的源码确认：
 *   - `Live` 模型：10 分钟（`partMergeMinute`）内接着录的分段算**同一场**的 parts；
 *   - `uploadNoDanmu && uploadToSameMedia` 时走 `uploadVideoToSameMedia()`，
 *     有 aid 就 `editMedia`（append 追加分P），没有就新建稿件并把 aid 记在 `live.aid`。
 * 实测账号里 `BV13hhE6XEQM` 就是这种稿件：14 个分P（7 段弹幕版 + 7 段纯享版）。
 *
 * 但那个 `live.aid` **只在内存里**（`app.db` 的 `record_history` 没有 aid 列，已核对），
 * 重启即丢，所以只能反向从「稿件列表」里把它找出来 —— 本函数就是这一步。
 *
 * 实测量到的两个坑（都不是猜的）：
 *   ① `{anchor}` 渲染成空串时永远匹配不上 —— biliLive-tools 的标题模板是
 *      `{{user}}{{title}}{{now}}`，**开头的账号名不能少**；
 *   ② 跨零点/手动导入时日期会对不上 —— 稿件标题里的日期取自**该场第一个分段**的开始时间，
 *      实测导入文件是 `2026-09-18 00-09-09`，而稿件标题是 `…2026.09.17`。
 * 所以分两轮：先连日期一起精确比，再退到「只比 主播名+直播标题」并要求创建时间在容差内，
 * 且**任何一轮命中多于 1 个都拒绝自动选择**（宁可新建稿件，也不把切片挂到别人稿件的分P 里）。
 * -------------------------------------------------------------------------- */

/** 归一化标题去掉尾部日期数字（`2026.09.22` 归一化后是 `20260922`） */
export function stripDateDigits(normalized: string): string {
  return normalized.replace(/\d{8}$/, '');
}

/**
 * 续传落地确认的等待上限（**阻塞**投稿流程的那一段）。
 *
 * 取值依据：实测 B站 分P 列表有延迟 —— 一次追加**约 2 分钟**后在列表里能看到，
 * 但「看全」可能要到 20 分钟后。发布流程不能等那么久，所以这里只做一次「快速看一眼」：
 *   · 看到了 → 直接判 PUBLISHED；
 *   · 没看到 → **不判失败**，记「已提交待确认」，由每 5 分钟一轮的反查（`reconcileAppendedClips`）继续确认。
 *
 * ★ 2026-10-10 从 5 分钟降到 90 秒：那 5 分钟是**纯阻塞**的（同一场的其它切片都得排队），
 *   而它换来的信息与反查完全重合 —— 实测那一场投了 8 次、光确认就白等了几十分钟，
 *   最后还是靠反查把 10/11 个分P 认回来的。真正需要"等"的长尾交给反查，不占着流水线。
 */
const CONFIRM_APPEND_TIMEOUT_MS = 90_000;

export interface ResumeTarget {
  aid: string;
  bvid?: string;
  title?: string;
  /** 实际用于渲染 `{anchor}` 的主播名（命中的那个变体） */
  anchor: string;
  /** `exact` = 连日期一起精确相等；`exact-ignore-date` = 只比主播名+直播标题（日期在容差内） */
  how: 'exact' | 'exact-ignore-date';
}

export interface ResumeResolveResult {
  target?: ResumeTarget;
  /** 试过的标题变体（日志与排查用） */
  tried: string[];
  /** 精确候选个数；> 1 表示有歧义，故意不选 */
  candidates: number;
  reason?: string;
}

/**
 * 从稿件列表里解析续传目标（纯函数，不发请求 —— 便于把实测到的三种情形写成用例）。
 *
 * @param input.anchors 候选主播名，按优先级排列；空串表示「不带主播名」的变体。
 *                      `{anchor}` 在模板里出现却没有候选名时，那个变体渲染出来就是原文。
 */
export function resolveResumeTarget(input: {
  template: string;
  liveTitle: string;
  /** 本场录制日期 `YYYY-MM-DD` */
  dateText: string;
  anchors: string[];
  archives: ArchiveItem[];
  /** 第二轮允许的日期偏差天数（默认 7） */
  dateWindowDays?: number;
}): ResumeResolveResult {
  const tpl = input.template.trim();
  if (!tpl) return { tried: [], candidates: 0, reason: '未配置 resumeTitleTemplate（自动查找已关闭）' };

  const dateDots = input.dateText.replace(/-/g, '.');
  const templateHasDate = tpl.includes('{date}');
  const anchors = [...new Set(input.anchors.map((a) => a.trim()))];
  if (anchors.length === 0) anchors.push('');

  const tried: string[] = [];
  const variants = anchors.map((anchor) => {
    const render = (withDate: boolean): string =>
      tpl
        .split('{anchor}')
        .join(anchor)
        .split('{liveTitle}')
        .join(input.liveTitle)
        .split('{date}')
        .join(withDate ? dateDots : '')
        .trim();
    const want = render(true);
    tried.push(want);
    return {
      anchor,
      want: normalizeTitleForMatch(want),
      wantNoDate: stripDateDigits(normalizeTitleForMatch(render(false))),
    };
  });

  /* ---- 第一轮：连日期一起精确相等 ---- */
  const pickUnique = (
    hits: Array<{ a: ArchiveItem; anchor: string }>,
  ): { hit?: { a: ArchiveItem; anchor: string }; count: number } => {
    const byBvid = new Map<string, { a: ArchiveItem; anchor: string }>();
    for (const h of hits) if (h.a.bvid && !byBvid.has(h.a.bvid)) byBvid.set(h.a.bvid, h);
    const list = [...byBvid.values()];
    return { count: list.length, ...(list.length === 1 ? { hit: list[0]! } : {}) };
  };

  const round1: Array<{ a: ArchiveItem; anchor: string }> = [];
  for (const v of variants) {
    if (!v.want) continue;
    for (const a of input.archives) {
      if (normalizeTitleForMatch(a.title ?? '') === v.want) round1.push({ a, anchor: v.anchor });
    }
  }
  const r1 = pickUnique(round1);
  if (r1.hit) return finish(r1.hit, 'exact', r1.count, tried);
  if (r1.count > 1) {
    return {
      tried,
      candidates: r1.count,
      reason: `有 ${r1.count} 个稿件标题都精确等于「${tried[0] ?? ''}」，无法确定往哪个追加（拒绝自动选择）`,
    };
  }

  /* ---- 第二轮：只比「主播名+直播标题」，日期允许偏差（跨零点/手动导入） ---- */
  const refMs = Date.parse(`${input.dateText}T12:00:00`);
  const windowMs = (input.dateWindowDays ?? 7) * 86_400_000;
  const round2: Array<{ a: ArchiveItem; anchor: string }> = [];
  for (const v of variants) {
    if (!v.wantNoDate) continue;
    for (const a of input.archives) {
      if (stripDateDigits(normalizeTitleForMatch(a.title ?? '')) !== v.wantNoDate) continue;
      /* 少了日期这道闸，就必须用创建时间补上：没有 ctime 的一律不认（同 verifyArchiveMatch 的原则） */
      if (typeof a.ctime !== 'number' || !Number.isFinite(a.ctime)) continue;
      if (!Number.isFinite(refMs)) continue;
      if (Math.abs(a.ctime * 1000 - refMs) > windowMs) continue;
      round2.push({ a, anchor: v.anchor });
    }
  }
  const r2 = pickUnique(round2);
  /* 模板里本来就没有 `{date}` 时，第二轮比较的就是「模板定义的完整标题」——
     那属于精确命中，不该报成「忽略日期」。日期闸门仍然照过（ctime 容差）。 */
  if (r2.hit) return finish(r2.hit, templateHasDate ? 'exact-ignore-date' : 'exact', r2.count, tried);
  if (r2.count > 1) {
    return {
      tried,
      candidates: r2.count,
      reason: `有 ${r2.count} 个稿件标题都等于「${variants[0]?.wantNoDate ?? ''}」（忽略日期），无法确定往哪个追加（拒绝自动选择）`,
    };
  }

  return {
    tried,
    candidates: 0,
    reason: `稿件列表里没有匹配「${tried.join(' / ')}」的稿件`,
  };

  function finish(
    hit: { a: ArchiveItem; anchor: string },
    how: ResumeTarget['how'],
    candidates: number,
    triedList: string[],
  ): ResumeResolveResult {
    const aid = hit.a['aid'];
    if (aid === undefined || aid === null || String(aid).trim() === '') {
      return { tried: triedList, candidates, reason: `命中稿件 ${hit.a.bvid ?? ''} 但没有 aid 字段，无法续传` };
    }
    return {
      candidates,
      tried: triedList,
      target: {
        aid: String(aid),
        ...(hit.a.bvid ? { bvid: hit.a.bvid } : {}),
        ...(hit.a.title ? { title: hit.a.title } : {}),
        anchor: hit.anchor,
        how,
      },
    };
  }
}

/**
 * 从稿件详情里读**分P 数**。
 *
 * `/bili/user/archive/:bvid` 返回的是 B站 view 接口的原始 JSON（外层多包一层），
 * 分P 列表在 `View.pages`（实测 `BV13hhE6XEQM` → 14 个分P，`View.videos=14`）。
 * 这个数字就是续传时切片分P 的编号基准 —— 不读它而用配置里写死的数，
 * 会出现「标题写 P3、实际挂在第 15 个分P」。
 */
export function archivePartCount(detail: unknown): number | undefined {
  if (!detail || typeof detail !== 'object') return undefined;
  const top = detail as Record<string, unknown>;
  const view = (top['View'] && typeof top['View'] === 'object' ? top['View'] : top) as Record<string, unknown>;
  for (const key of ['pages', 'page'] as const) {
    const v = view[key] ?? top[key];
    if (Array.isArray(v)) return v.length;
  }
  for (const key of ['videos'] as const) {
    const v = view[key] ?? top[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  }
  return undefined;
}

/**
 * 从稿件详情里读**已有分P 的标题**（`View.pages[].part`）。
 *
 * 与 {@link archivePartCount} 读的是同一个数组 —— 抽在一起是为了让"分P 数"和
 * "分P 标题"永远来自同一次响应、同一个字段，不会出现一个读到、另一个读不到的矛盾。
 * 返回 `undefined` 表示**查不到列表**（不能当成空数组：那会导致重复投稿）。
 */
export function archivePartTitles(detail: unknown): string[] | undefined {
  if (!detail || typeof detail !== 'object') return undefined;
  const top = detail as Record<string, unknown>;
  const view = (top['View'] && typeof top['View'] === 'object' ? top['View'] : top) as Record<string, unknown>;
  const pages = (view['pages'] ?? top['pages']) as unknown;
  if (!Array.isArray(pages)) return undefined;
  return pages.map((p) => String((p as Record<string, unknown>)['part'] ?? (p as Record<string, unknown>)['title'] ?? '')).filter((s) => s.length > 0);
}

/* ============================================================================
 * 投稿配置构建
 * ========================================================================== */

export interface BiliupConfigInput {
  clip: ClipRecord;
  task: TaskRecord;
  cfg: AppConfig;
  uid: number | string;
  dtime: number;
  cover?: string;
  uploadPresetId: string;
  /** 完整版：自定义标题/简介（不依赖 LLM） */
  overrideTitle?: string;
  overrideDesc?: string;
  overrideTags?: string[];
  isFullVideo?: boolean;
  /**
   * 覆盖 `cfg.publish.immediatePublish`。
   *
   * ⚠️ 必须由**每个调用点显式传入**：这里读 `cfg` 只是兜底。
   * 曾经的 bug —— 单切片路径忘了传，而这个函数的 `immediate` 判断又被写成了
   * 只看 `cfg`，于是 `publishAsMultiPart` 走了立即发布、`publishClips` 却仍在传 `dtime`，
   * 同一份配置在两个投稿路径上行为不一致（实测：开了立即发布，稿件还是定到了 4 天后）。
   */
  immediate?: boolean;
}

/**
 * 把 clips.json 的候选映射为 BiliupConfig（§4.4）。
 *
 * 硬约束 #3：标题 ≤80 / 简介 ≤250 / 标签 1–10 个 —— 这里做最后一道把关。
 * 硬约束 #16：tid 必须来自白名单（由 analyze.ts 的 `mapCategoryToTid` 完成，这里只做兜底校验）。
 */
export function buildBiliupConfig(input: BiliupConfigInput): { config: Record<string, unknown>; warnings: string[] } {
  const { clip, task, cfg, uid, dtime } = input;
  const warnings: string[] = [];

  let title = input.overrideTitle ?? clip.title;
  const st = sanitizeTitle(title, 80);
  if (st.truncated) warnings.push(`标题超过 80 字符，已截断：${title.slice(0, 30)}…`);
  title = st.title;
  if (cfg.publish.defaultTitleSuffix && !title.endsWith(cfg.publish.defaultTitleSuffix)) {
    const withSuffix = sanitizeTitle(`${title}${cfg.publish.defaultTitleSuffix}`, 80);
    title = withSuffix.title;
    if (withSuffix.truncated) warnings.push('追加标题后缀后超过 80 字符，已截断');
  }

  // 简介：LLM 的 desc + 模板段落（模板含 {date} / {liveTitle} / {roomUrl} / {startText} / {endText} / {desc}）
  const roomUrl = `https://live.bilibili.com/${task.anchorRoomId ?? task.roomId}`;
  /* ★ 2026-10-17 修复：手动导入的录播没有 liveStartTime，标题也常是纯直播标题（无日期），
     只靠 liveStartTime 会退化成「今天」——跨零点后日期错一天。真实日期在**录制文件名**
     前缀（`2026-10-16 22-52-18-237 …`）里。优先级：标题日期 → 文件名日期 → 开播时间 → 今天，
     与 daemon.ts 的 resumeDateText 同一口径。 */
  const dateText =
    extractTitleDate(task.title) ??
    extractTitleDate(path.basename(task.source?.segments?.[0]?.path ?? task.source?.rawFiles?.[0] ?? '')) ??
    (task.liveStartTime ? fmtLocal(task.liveStartTime * 1000).slice(0, 10) : fmtLocal().slice(0, 10));
  /* ★ 2026-10-17：时间点显示**录制时的真实时刻**（如 22:52:30），不再是相对偏移（00:00:12）。
     基准 = 录制开始墙钟（recordStartTime 毫秒，最准）→ 开播时间（liveStartTime 秒）→ 都没有就回退相对时长。
     clip.start/end 是整场录像的全局秒偏移，加上基准即真实时刻；跨零点在尾部标「（+N天）」。 */
  const clockBaseMs = task.recordStartTime ?? (task.liveStartTime !== undefined ? task.liveStartTime * 1000 : undefined);
  const clockText = (sec: number): string => {
    if (clockBaseMs === undefined) return fmtDuration(sec);
    const at = new Date(clockBaseMs + sec * 1000);
    const hm = fmtLocal(at).slice(11);
    /* 跨天按**日历日期**比较（本地零点对齐），不能用总时长整除 24h ——
       22:52 开始、次日 00:15 的切片只隔 1.4 小时，但确实跨了零点，必须标注。 */
    const startDay = new Date(clockBaseMs);
    startDay.setHours(0, 0, 0, 0);
    const atDay = new Date(at);
    atDay.setHours(0, 0, 0, 0);
    const days = Math.round((atDay.getTime() - startDay.getTime()) / 86_400_000);
    return days > 0 ? `${hm}（+${days}天）` : hm;
  };
  let desc: string;
  if (input.overrideDesc !== undefined) {
    desc = input.overrideDesc;
  } else {
    const tpl = cfg.publish.descTemplate || '{{desc}}';
    desc = tpl
      .split('{{date}}').join(dateText)
      /* ★ 2026-10-17 修复：{{liveTitle}} 之前直接填 task.title（含录制时间戳前缀的场次原始标题），
         投出去的简介里"直播间"一栏带着 `2026-10-15 21-03-45 ` 这类前缀。分P稿件标题、
         多分P 主标题（本文件 2265/2528 行）都先过 cleanLiveTitle 清洗，这里对齐同一口径。 */
      .split('{{liveTitle}}').join(cleanLiveTitle(task.title) || task.title || '直播回放')
      .split('{{anchorUid}}').join(task.anchorUid || '')
      .split('{{anchorName}}').join(task.anchorName || '')
      .split('{{roomUrl}}').join(roomUrl)
      .split('{{startText}}').join(clockText(clip.start))
      .split('{{endText}}').join(clockText(clip.end))
      .split('{{desc}}').join(clip.desc ?? '');
  }
  /* AI 声明：**必须最后拼、且不参与正文截断**。
     简介上限 250 字符（`sanitizeDesc`），若把声明混在正文里一起截，
     它正好落在尾部 → 一截就没了，等于没写。所以先按"总长 − 声明长度"截断正文，再追加声明。 */
  const noticeRes = sanitizeDesc(String(cfg.publish.aiNotice ?? '').trim(), 250);
  const notice = noticeRes.desc.trim();
  if (notice) {
    const budget = Math.max(0, 250 - notice.length - 1); // 留一个换行
    const body = sanitizeDesc(desc, budget);
    if (body.truncated) {
      warnings.push(`简介正文超过 ${budget} 字符（原始 ${desc.length}），已截断以给「AI 声明」留位置`);
    }
    desc = body.desc.trim() ? `${body.desc.trim()}\n${notice}` : notice;
  } else {
    const sd = sanitizeDesc(desc, 250);
    if (sd.truncated) warnings.push(`简介超过 250 字符（原始 ${desc.length}），已截断`);
    desc = sd.desc;
  }
  if (desc.length > 250) {
    // 兜底自检：两条路径都不该超过上限（硬约束 #3 的简介部分）
    warnings.push(`简介仍超过 250 字符（${desc.length}），已强制截断`);
    desc = sanitizeDesc(desc, 250).desc;
  }

  /* ★ 标签四层（2026-10-17 用户规格后定的最终口径，与 analyze.ts 里 sanitizeClips 同源）：
     ① 必带标签（`config.publish.identityTags`，`{主播}` 占位符 → 本场主播名）：永远在最前、占位优先；
     ② 内容标签（选片 LLM 生成 + 界面手改）：按顺序补满剩余名额，与①去重（大小写不敏感）；
     ③ 默认标签（`defaultTags`）：①② 都空时兜底，否则只补它们用不完的空位；
     ④ 上限 `TAG_LIMIT`=10，超出部分丢弃（必带优先，代价写进 warning）。
     这里再做一次是刻意的：`clips.json` 是**存量数据**（本轮改动之前落的库），重新投稿、手改标签、
     或走 append/多P 分支时都不经过 `sanitizeClips`，必须在这道最终关口再套一次。
     历史（三次反复，别再来回改）：无条件前置追加 → 只兜底 → 内容词在前+默认词补位 → 现在这条。 */
  const identity = resolveIdentityTags(cfg.publish.identityTags, task.streamer, cfg.publish.tagSensitiveWords);
  if (identity.skipped.length) warnings.push(`必带标签跳过：${identity.skipped.join('、')}`);
  const tagRes = sanitizeTags(input.overrideTags ?? clip.tags, {
    sensitive: cfg.publish.tagSensitiveWords,
  });
  if (tagRes.removed.length) warnings.push(`标签被移除：${tagRes.removed.join('、')}`);
  const tagMerge = mergeIdentityTags(identity.tags, tagRes.tags, TAG_LIMIT);
  if (tagMerge.dropped.length) {
    warnings.push(`标签超过 ${TAG_LIMIT} 个上限：必带标签优先，已丢弃内容词 ${tagMerge.dropped.join('、')}`);
  }
  let tags = tagMerge.tags;
  if (tags.length === 0) {
    tags = cfg.publish.defaultTags.length ? [...cfg.publish.defaultTags] : ['直播切片'];
    warnings.push(`清理后没有可用标签，已用默认标签兜底：${tags.join('、')}`);
  } else {
    const filled = fillDefaultTags(tags, cfg.publish.defaultTags, cfg.publish.tagSensitiveWords);
    if (filled.length > tags.length) {
      warnings.push(`已用默认标签补位：${filled.slice(tags.length).join('、')}`);
      tags = filled;
    }
  }
  if (tags.length > TAG_LIMIT) {
    warnings.push(`标签 ${tags.length} 个超过上限 ${TAG_LIMIT}，已截断`);
    tags = tags.slice(0, TAG_LIMIT);
  }

  // tid：只接受白名单里的值（硬约束 #16）
  const wl = cfg.publish.tidWhitelist;
  let tid = wl[clip.category];
  if (tid === undefined) {
    /* 回退口径要和选片那条路（analyze.ts 的 mapCategoryToTid）**一致**：都用 `defaultCategory`。
       这里以前写成「白名单里有 21 就用 21，否则用第一项」——那是把「生活/日常」当隐式默认，
       于是配置里换了默认分区、存量 clips.json（分区名可能已经不在白名单里）却还是悄悄投到 21。
       实测 2026-10-17 就撞上：白名单改版后 13 个存量切片的分区名「虚拟主播/虚拟主播」失效，
       按旧口径全会落到生活/日常，而不是配置里的默认分区。 */
    const fallbackName = Object.prototype.hasOwnProperty.call(wl, cfg.publish.defaultCategory)
      ? cfg.publish.defaultCategory
      : Object.keys(wl)[0];
    const byValue = fallbackName === undefined ? 21 : wl[fallbackName];
    warnings.push(`分区「${clip.category}」不在白名单，回退默认分区「${fallbackName ?? '—'}」tid=${byValue}`);
    tid = byValue ?? 21;
  }

  const immediate = (input.immediate ?? cfg.publish.immediatePublish) === true;
  const config: Record<string, unknown> = {
    title,
    desc,
    tag: tags,
    tid,
    copyright: cfg.publish.copyright,
    // ★ 立即发布：**完全不传 dtime**。
    //   传 `dtime: 0` / `null` 都不算「立即」—— B站只在「传了 dtime」时才校验
    //   「必须 ≥ 提交后 5 分钟」，所以不传这个键才是真正的立即发布。
    //   默认走定时发布（硬约束 #4），由 publish.immediatePublish 显式开启才绕过。
    ...(immediate ? {} : { dtime }),
    is_only_self: cfg.publish.isOnlySelf,
    no_disturbance: cfg.publish.noDisturbance,
    ...(cfg.publish.creationStatement !== -1 ? { creationStatement: cfg.publish.creationStatement } : {}),
    ...(cfg.publish.dynamic ? { dynamic: cfg.publish.dynamic } : {}),
    ...(cfg.publish.copyright === 2 ? { source: roomUrl } : {}),
    ...(input.cover ? { cover: input.cover } : {}),
    // 合集：把同场直播的所有切片归入同一合集（§4.4）
    ...(cfg.publish.seasonId ? { seasonId: cfg.publish.seasonId } : {}),
    ...(cfg.publish.sectionId ? { sectionId: cfg.publish.sectionId } : {}),
  };
  void uid;
  void input.isFullVideo;
  void input.uploadPresetId;

  if (immediate) {
    warnings.push(
      '已启用「立即发布」（immediatePublish=true）：本次投稿**不传 dtime**，稿件过审后直接公开，' +
        `不再满足本项目硬约束 #4 的「> 提交时刻 + ${DTIME_MIN_MARGIN_SEC} 秒」。该约束是防风控的自律措施、非 B站规则（平台底线仅 300 秒）。`,
    );
  } else {
    // dtime 自检（硬约束 #4）
    const dt = validateDtime(dtime, Date.now());
    if (!dt.ok) warnings.push(dt.note);
  }

  return { config, warnings };
}

/**
 * 从录制标题里剥掉「日期 时间」前缀，得到干净的直播标题。
 *
 * 录制器常见的标题模板是 `2026-09-20 00-36-21-040 <直播标题>`，
 * 直接拿它当投稿标题会非常难看。剥掉前缀后再由调用方补上日期。
 */
export function cleanLiveTitle(raw: string): string {
  let t = String(raw ?? '').trim();
  // 去掉 `YYYY-MM-DD HH-mm-ss[-SSS]` 前缀
  t = t.replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}[-:]\d{2}[-:]\d{2}(?:[-.]\d{1,4})?\s*/, '');
  // 去掉结尾的「（手动导入）」这类系统标注
  t = t.replace(/[（(](?:手动导入|离线导入)[）)]\s*$/, '');
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t || String(raw ?? '').trim();
}

/**
 * 从录制标题里提取**录制日期**（`YYYY-MM-DD`）。
 *
 * 为什么不能直接用 `liveStartTime`：手动导入（`importLocal`）的素材没有开播时间，
 * 会被兜底成「今天」，于是投稿标题里的日期会变成操作当天而不是真实直播日
 * （实测差了 2 天）。而录制器写进标题的那个日期是**真实且可靠**的，优先用它。
 */
export function extractTitleDate(raw: string): string | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? ''));
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 本场对应的日期文本：优先取标题里的真实录制日期，否则回落到开播时间/当前时间 */
export function taskDateText(task: { title: string; liveStartTime?: number }): string {
  return (
    extractTitleDate(task.title) ??
    (task.liveStartTime ? fmtLocal(task.liveStartTime * 1000).slice(0, 10) : fmtLocal().slice(0, 10))
  );
}

/* ---------------------------------------------------------------------------
 * 分P标题：完整版 / 纯享版沿用 biliLive-tools 的命名规则
 * ------------------------------------------------------------------------- */

/**
 * 从既有稿件标题里推断主播名。
 *
 * biliLive-tools 的命名模板是 `{{user}}{{title}}{{index}}{{hasDanmaStr}}`，
 * 而台账里只有直播标题、没有主播名，所以从「完整版稿件标题」反推
 * （形如 `甲主播已进入后半夜后悔时代2026.09.20`，开头就是主播名）。
 */
export function guessAnchorName(archives: ArchiveItem[], liveTitle: string): string {
  for (const a of archives) {
    const t = String(a.title ?? '');
    if (!t) continue;
    const idx = liveTitle ? t.indexOf(liveTitle) : -1;
    if (idx > 0) return t.slice(0, idx);
    // 直播标题可能被改过：退一步，去掉结尾日期后再切
    const stripped = t.replace(/\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s*$/, '');
    if (stripped.length > 0 && stripped.length < t.length && liveTitle) {
      const i2 = stripped.indexOf(liveTitle);
      if (i2 > 0) return stripped.slice(0, i2);
    }
  }
  return '';
}

/**
 * 分P 标题模板渲染。
 *
 * 为什么做成模板：切片分P 的标题之前是硬编码的 `P{n} {title}`，
 * 实测在创作中心看到的就是「P3 主播收到飞机礼物…」这种带内部序号的名字 ——
 * 观众视角下这是"机切痕迹"。而不同频道的习惯完全不一样：
 *   - 有的喜欢 `P3 标题`（B站 多分P 的通用习惯）；
 *   - 有的喜欢 `{主播}切片3 标题`；
 *   - 有的想完全不带序号，让分P 顺序自己说话。
 * 所以交给配置，并在投稿前提供预览。
 *
 * 可用变量：`{n}` 分P 序号、`{title}` 分P 自己的标题、`{mainTitle}` 稿件主标题、
 *          `{anchor}` 主播名（从历史稿件标题推断）、`{date}` 录制日期、`{kind}` 类型（切片/完整版/纯享版）。
 *
 * 默认模板 `P{n} {title}` 与历史行为一致 —— 不配置就不会有行为变化。
 */
export function renderPartTitle(
  template: string,
  vars: { n: number; title: string; mainTitle?: string; anchor?: string; date?: string; kind?: string },
): string {
  const map: Record<string, string> = {
    n: String(vars.n),
    title: vars.title,
    mainTitle: vars.mainTitle ?? '',
    anchor: vars.anchor ?? '',
    date: vars.date ?? '',
    kind: vars.kind ?? '切片',
  };
  const rendered = String(template || 'P{n} {title}')
    .replace(/\{(n|title|mainTitle|anchor|date|kind)\}/g, (_, k: string) => map[k] ?? '')
    // 变量为空会留下多余空格，压掉
    .replace(/\s{2,}/g, ' ')
    .trim();
  return rendered;
}

/**
 * 按 biliLive-tools 的 `partTitleTemplate` 生成完整版 / 纯享版的分P标题。
 *
 * 实测其产出形如：
 *   完整版（烧弹幕）→ `甲主播来两下闪身步就好了1弹幕版`
 *   纯享版（无弹幕）→ `甲主播来两下闪身步就好了1纯享版`
 * 即 `{{user}}{{title}}{{index}}{{hasDanmaStr}}`，**各段之间无分隔符**。
 *
 * @param index 该分P序号；传 0 表示不加序号（手动投的单P完整版就是这样）
 */
export function biliPartTitle(input: { user: string; title: string; index: number; withDanmaku: boolean }): string {
  const idxPart = input.index > 0 ? String(input.index) : '';
  const kindPart = input.withDanmaku ? '弹幕版' : '纯享版';
  return `${input.user}${input.title}${idxPart}${kindPart}`.trim();
}

/* ============================================================================
 * Publisher
 * ========================================================================== */

export interface PublishDeps {
  client: BiliLiveClient;
  config: AppConfig;
  ledger: Ledger;
  logger?: Logger;
  /**
   * 提交闸门的最小间隔（毫秒），默认 {@link UPLOAD_SUBMIT_MIN_GAP_MS}。
   * 只为**测试**留口子（真等 3 秒会拖慢套件），生产不要传。
   */
  submitGateMs?: number;
  /** 限流重试的最大尝试次数（含首次），默认 {@link UPLOAD_RATE_LIMIT_MAX_ATTEMPTS}。仅供测试注入。 */
  rateLimitMaxAttempts?: number;
  /** 限流等待的实现（毫秒 → Promise），默认 `sleep`。仅供测试注入（避免真睡 2 秒 × N）。 */
  rateLimitWaiter?: (waitMs: number) => Promise<void>;
  /** 账号受限闸门（默认按台账同目录的 quota-block.json 建）。仅供测试注入。 */
  quotaGuard?: QuotaGuard;
  /**
   * 告警器（可选）。只用于「配额级限流」这一种情形 —— 它不是失败，但用户必须知道
   * "别重投了，等 30 分钟"。测试不传即为空实现（不发任何通知）。
   */
  alerter?: Pick<Alerter, 'publishQuotaLimited'>;
}

/**
 * 「账号级投稿配额限流」的诊断信息（2026-10-21）。
 *
 * 三处共用同一个形状（单切片结果 / 多分P 结果 / 告警），避免各写一份再对不上——
 * 曾经多分P 那条只写了 message+retryAfterMin，daemon 透传时类型对不上。
 */
export interface QuotaLimitedInfo {
  /** B站 的原话 */
  message: string;
  /** 被限时"今日已提交"多少个（判断是不是配额打满的直接依据） */
  todaySubmitted: number;
  /** 建议多少分钟后重试 */
  retryAfterMin: number;
}

/**
 * 账号受限闸门（2026-10-22）：24h 内累计多次配额拒绝 ⇒ 暂停投稿到某个时刻。
 * 与 {@link QuotaLimitedInfo} 的区别：那个是"这一批被拒了"，这个是"**整个账号现在不该再投**"。
 */
export interface QuotaBlockInfo {
  /** 解除时间（ISO） */
  until: string;
  /** 24h 内的拒绝次数 */
  rejections: number;
  /** 给人看的一句话（UI 直接显示） */
  note: string;
}

export interface CutAndUploadResult {
  clipIndex: number;
  ok: boolean;
  /** 跳过原因（幂等命中） */
  skipped?: string;
  cutTaskId?: string;
  output?: string;
  uploadTaskId?: string;
  bvid?: string;
  dtime?: number;
  error?: { type: string; message: string };
  warnings: string[];
  /**
   * 命中「账号级投稿配额限流」时带上（2026-10-21 事故）。
   *
   * 有它就意味着：这一片**什么都没投出去**（B站 拒绝受理）、状态是 CANDIDATE（待投），
   * 且本轮**不应该再投任何一片** —— `publishClips` 据此立即收手并告警。
   */
  quotaLimited?: QuotaLimitedInfo;
}

export interface CutAndUploadOptions {
  task: TaskRecord;
  /** 要处理的切片下标；不传则处理全部 `selected && status==='PENDING_UPLOAD'|'CANDIDATE'` */
  indices?: number[];
  /** 只切片、不投稿（用于「先切出来看看」；调用方的 dryRun 会传到这里） */
  dryRun?: boolean;
  /**
   * 只切片，**即使不是 dry-run 也不投稿**。
   * 用于多分P模式：先把所有切片切出来，再连同完整版一起投进同一个稿件。
   */
  skipUpload?: boolean;
  uid: number | string;
  /** 每个切片提交时刻的基准（同一批共用，便于错峰公式连续） */
  submitTimeMs?: number;
  /**
   * 这一片是**本场第几片**（1 起），供错峰公式 `dtime = 基准 + submitGapSec + (N-1)×间隔` 使用。
   *
   * 为什么必须由调用方给（2026-10-17 线上实测踩到）：这个 N 原先是在 `cutAndUploadClip` 里
   * 用「近 24 小时的投稿条数 + 1」近似的，而那个窗口**跨批次** —— 前一晚投过的切片会一起被数进来。
   * 实测：00:16 开批时 N=28（前 24h 里正好 27 条 submit，全来自 10-16 凌晨那四批切片），
   * 于是整批被推后 (28-1)×300 = 8100 秒，首片从「提交 + 2h10m」的 02:26 变成 **04:41**，
   * 与界面预览（按 N=1 算）差 2 小时 15 分；同一天里 N 还会随**当天提交量**滑动
   * （同一份日志里 10-16 00:00 那一刻 N 高达 59 ⇒ 首片会被排到 7 小时后）。
   *
   * 谁传：`publishClips` 的逐片循环传 `idx + 1`（切片在本场里的序号，重投/断点续投也稳定，
   * 不会让后面的片排到前面的片之前）。
   */
  clipOrdinal?: number;
  /** 完整版源文件（用于推导 coverSource=fullVideo） */
  fullVideoBvid?: string;
  archiveCache?: ArchiveItem[];
  signal?: AbortSignal;
  onProgress?: (p: { current: number; total: number; label: string }) => void;
}

export class Publisher {
  private client: BiliLiveClient;
  private cfg: AppConfig;
  private ledger: Ledger;
  private logger: Logger;
  /** ffmpeg 预设缓存（避免每片都请求一次） */
  private presetCache?: { at: number; list: FfmpegPreset[] };
  /** 转写缓存（烧字幕用），键为 `taskId|mtime` */
  private transcriptCache = new Map<string, TranscriptSegment[]>();
  /**
   * 稿件详情单飞缓存（键 = bvid）；上传成功后必须 clear，否则确认逻辑读到旧快照。
   * 详见 `fetchArchiveDetailCached` 的说明。
   */
  private archiveDetailCache = new Map<string, Record<string, unknown>>();
  /** 术语表（标题体检用）：懒加载，改文件即生效 */
  private glossaryStore?: GlossaryStore;

  /** 提交闸门：任意两次 `biliUpload` 的最小间隔（毫秒）。见 {@link withSubmitGate}。 */
  private readonly submitGateMs: number;
  /** 限流重试的最大尝试次数（含首次） */
  private readonly rateLimitMaxAttempts: number;
  /** 限流等待的实现（测试可注入，避免真睡） */
  private readonly rateLimitWaiter: (waitMs: number) => Promise<void>;
  /** 告警器（可选）：只在「配额级限流」时用，见 {@link finishQuotaLimited} */
  private readonly alerter?: Pick<Alerter, 'publishQuotaLimited'>;
  /** 提交闸门的排队链：后一笔等前一笔 `release()` 后才计算间隔 */
  private submitChain: Promise<void> = Promise.resolve();
  /** 上一次投稿提交的发起时刻（毫秒）；0 = 本进程还没投过 */
  private lastSubmitAtMs = 0;
  /** 账号受限闸门：跨批次、跨进程的"暂停投稿"状态 */
  private readonly quotaGuard: QuotaGuard;

  /** 取术语表（体检用）。文件坏掉/不存在时返回空表，不影响投稿。 */
  private glossaryForCheck(): Glossary {
    try {
      this.glossaryStore ??= new GlossaryStore();
      return this.glossaryStore.load();
    } catch {
      return { version: 1, anchors: [], terms: [], replacements: [] };
    }
  }

  constructor(deps: PublishDeps) {
    this.client = deps.client;
    this.cfg = deps.config;
    this.ledger = deps.ledger;
    this.logger = (deps.logger ?? globalLog).child({ mod: 'publish' });
    this.submitGateMs = Math.max(0, deps.submitGateMs ?? UPLOAD_SUBMIT_MIN_GAP_MS);
    this.rateLimitMaxAttempts = Math.max(1, deps.rateLimitMaxAttempts ?? UPLOAD_RATE_LIMIT_MAX_ATTEMPTS);
    this.rateLimitWaiter = deps.rateLimitWaiter ?? ((waitMs: number) => sleep(waitMs));
    this.quotaGuard =
      deps.quotaGuard ??
      new QuotaGuard({ path: QuotaGuard.pathFor(deps.ledger.publishLogPath), logger: this.logger });
    if (deps.alerter) this.alerter = deps.alerter;
  }

  /* ------------------------------------------------------------------------
   * 投稿提交：进程级串行闸门 + 限流安全重试
   * ---------------------------------------------------------------------- */

  /**
   * 串行化一次「投稿提交」：并发调用会在这里排队，且任意两次之间至少隔 `submitGateMs`。
   *
   * 为什么需要它（2026-10-17 线上事故）：`publishClips` 的批内间隔用 `i > 0` 判首片豁免，
   * 而同一进程里**两个任务的循环各跑各的** —— 两个首片几乎同时提交，直接撞 B站 限流。
   * 频率限制是**按账号**的，所以闸门必须是**进程级**（挂在 Publisher 实例上：一个进程只有一个
   * Publisher），而不是循环内局部变量。
   *
   * 语义边界：闸门只决定**什么时候发**，不改请求内容、不改重试策略，因此不影响幂等性。
   */
  private async withSubmitGate<T>(task: () => Promise<T>): Promise<T> {
    /* 排队：把当前闸门状态串成一条 Promise 链。前一笔失败也**不能**卡死后面的提交
       （用 catch 吞掉链上的拒绝，否则一次 500 就让整个进程再也投不出去）。 */
    const prev = this.submitChain;
    let release: () => void = () => {};
    this.submitChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev.catch(() => undefined);
    try {
      if (this.lastSubmitAtMs > 0) {
        const wait = this.submitGateMs - (Date.now() - this.lastSubmitAtMs);
        if (wait > 0) await sleep(wait);
      }
      /* 时间戳在**发请求之前**取：衡量的是两次提交的间隔，而不是两次上传结束的间隔
         （上传可能耗时几十分钟，若按结束后计时，闸门形同虚设）。 */
      this.lastSubmitAtMs = Date.now();
      return await task();
    } finally {
      release();
    }
  }

  /**
   * 所有投稿提交的**唯一出口**（三个调用点：完整版 / 单切片 / 多分P 追加）。
   * 统一走闸门，保证「任意两次提交至少隔 `UPLOAD_SUBMIT_MIN_GAP_MS`」。
   */
  private async submitUpload(
    params: Parameters<BiliLiveClient['biliUpload']>[0],
    log: Logger,
    purpose: string,
  ): Promise<BiliUploadResponse> {
    return this.withSubmitGate(async () => {
      log.debug(`提交投稿请求（${purpose}）`);
      return this.client.biliUpload(params);
    });
  }

  /**
   * 被限流时的等待：按对方给的秒数等（+1~2 秒抖动），并夹一个上限。
   *
   * 为什么要抖动：两个任务可能同时被限流、同时等 2 秒、然后同时再撞一次
   * （同一次事故里就是"同时提交"引起的）。抖动把它们的重试错开。
   */
  private async waitForRateLimit(message: string, attempt: number, log: Logger): Promise<number> {
    const asked = parseRateLimitWaitSec(message) ?? RATE_LIMIT_DEFAULT_WAIT_SEC;
    const capped = Math.min(UPLOAD_RATE_LIMIT_WAIT_CAP_SEC, Math.max(1, asked));
    const waitMs = capped * 1000 + randomInt(1000, 2000);
    log.warn(
      `B站 限流：第 ${attempt}/${this.rateLimitMaxAttempts} 次提交被拒（${message.slice(0, 120)}）` +
        `—— 等 ${(waitMs / 1000).toFixed(1)} 秒后重试${capped < asked ? `（对方要求 ${asked} 秒，超过上限 ${UPLOAD_RATE_LIMIT_WAIT_CAP_SEC} 秒，只等到上限）` : ''}`,
    );
    await this.rateLimitWaiter(waitMs);
    return waitMs;
  }

  /**
   * 收尾「账号级投稿配额限流」（2026-10-21 线上事故）。
   *
   * 三件事，顺序都不重要但一件都不能少：
   *   ① 台账写 **CANDIDATE（待投）**，不写 FAILED —— 配额限流是"现在不行"，不是"这片坏了"，
   *      写成 FAILED 会让界面显示成永久失败、把用户往"重投"甚至"查代码"上带；
   *   ② failReason 写成一句**能照着做**的话：原因 + 今日已投几个 + 建议多久后重试；
   *   ③ 返回值带上 `quotaLimited`，让调用方（publishClips）立即收手，别继续撞后面的片。
   *
   * 刻意**不写错误报告**（`reportClipFailure`）：错误报告是给"需要人修的问题"用的，
   * 配额限流不是 bug，写进去只会在「错误报告」列表里堆噪音；它该走的是告警频道（alerter）。
   */
  private finishQuotaLimited(input: {
    task: TaskRecord;
    clipIndex: number;
    clip: ClipRecord;
    msg: string;
    log: Logger;
    cutOutput?: string;
    warnings: string[];
  }): CutAndUploadResult {
    const todaySubmitted = this.ledger.todayPublishedCount();
    const reason =
      `B站 投稿配额限流（今日已提交 ${todaySubmitted} 个），建议 ${UPLOAD_QUOTA_RETRY_AFTER_MIN} 分钟后重试` +
      `｜原始错误：${input.msg.slice(0, 160)}`;
    input.log.warn(
      `片段 #${input.clipIndex} 命中**账号级投稿配额**限流，本轮不再重试：${input.msg.slice(0, 160)}` +
        `（今日已提交 ${todaySubmitted} 个，建议 ${UPLOAD_QUOTA_RETRY_AFTER_MIN} 分钟后重试；` +
        `配额不可能在几秒内恢复，原地重试只是白挨拒绝）`,
      { data: { clipIndex: input.clipIndex, todaySubmitted } },
    );
    /* 状态用 CANDIDATE 而不是 FAILED：与"可重投"的既有口径一致（CANDIDATE/PENDING_UPLOAD/FAILED
       三者都会被 publishClips 重新捡起，但只有 CANDIDATE 在界面上不会被当成失败）。 */
    this.ledger.setClipStatus(input.task.id, input.clipIndex, 'CANDIDATE', {
      failReason: reason,
      ...(input.cutOutput ? { cutOutput: input.cutOutput } : {}),
    }, {
      /* 与 daemon 复位「待投」同一口径（QA 2026-10-21 指出口径不一致）：
         分支 B 走到这里时台账已经被写成 SUBMITTED + uploadTaskId，可那次提交实际没被受理，
         留着这些字段就是留着一次"并不存在的提交"（人工核对时又要多绕一圈）。 */
      unset: ['bvid', 'publishedAt', 'dtime', 'submitTime', 'uploadTaskId'] as Array<keyof ClipRecord>,
    });
    input.warnings.push(reason);
    /* 记一笔「账号级拒绝」：24h 内累计到阈值就进入"暂停投稿"（跨批次、跨进程生效）。
       这一步放在返回之前，保证无论调用方怎么处理，闸门都记得住。 */
    const guard = this.quotaGuard.recordRejection(input.msg);
    if (guard.blocked && guard.until) input.warnings.push(guard.note);
    return {
      clipIndex: input.clipIndex,
      ok: false,
      ...(input.cutOutput ? { output: input.cutOutput } : {}),
      error: { type: 'upload-failed', message: reason },
      warnings: input.warnings,
      quotaLimited: { message: input.msg, todaySubmitted, retryAfterMin: UPLOAD_QUOTA_RETRY_AFTER_MIN },
    };
  }

  /** 配额限流告警：一批只发一条（`publishClips` 在 break 前调用）。永不抛异常。 */  private async alertQuotaLimited(info: {
    task: TaskRecord;
    submitted: number;
    remaining: number;
    reason: string;
  }): Promise<void> {
    if (!this.alerter) return;
    try {
      await this.alerter.publishQuotaLimited({
        taskId: info.task.id,
        title: info.task.title,
        submitted: info.submitted,
        remaining: info.remaining,
        retryAfterMin: UPLOAD_QUOTA_RETRY_AFTER_MIN,
        reason: info.reason,
      });
    } catch (e) {
      this.logger.warn(`配额限流告警发送失败（不影响台账）：${(e as Error).message}`);
    }
  }

  /**
   * 账号受限闸门的状态（给 UI / 接口用）。
   * 与 `publishClips` 里的早退判定是**同一个来源**，不会出现"界面说没受限、投稿却被拦"的矛盾。
   */
  quotaGuardStatus(): QuotaGuardStatus {
    return this.quotaGuard.status();
  }

  /** 用户确认 B站 已恢复时手动解除（保留 24h 拒绝计数作参考）。 */
  clearQuotaBlock(reason = 'manual'): QuotaGuardStatus {
    return this.quotaGuard.clear(reason);
  }

  /**
   * 投稿批次账（`src/publish-batches.ts`）的落盘路径 —— **必须跟随台账目录**。
   *
   * 为什么（QA 2026-10-21 实测）：`recordBatchSubmit/recordBatchOutcome` 不传 `logPath` 时会落到
   * `DATA_DIR/publish-log.jsonl`，也就是**生产日志**。于是任何跑到"多分P 提交/落地"的测试都会
   * 往生产 publish-log 里写 `batch-submit`/`batch-landed` 行（实测复跑一次套件多 2 行，
   * taskId 还是测试的 `ratelimit-append-01`）。这不影响每日额度（额度只数 submit/confirm），
   * 但污染生产日志、也让"跑完日志行数不变"这条验收永远不可能成立。
   * 台账本身就是按自己的目录算 `publishLogPath` 的（测试用临时目录），跟着它走即可。
   */
  private batchLog(): { logPath: string } {
    return { logPath: this.ledger.publishLogPath };
  }

  /**
   * 续传（追加分P）重试前的「到底落没落地」探针。
   *
   * 硬要求：追加分P 是往**已有稿件**里加内容，万一上一次"被限流拒绝"的提交其实已经写进去了，
   * 再投一次就是**同一个分P 出现两次**（本项目最不能犯的错）。
   * 所以重试前**必须**用 fresh 的分P 列表核对标题（与 `confirmPublished` 同一套 `norm()` 比较）。
   *
   * 返回值三态刻意分开：
   *   · `landed`   ⇒ 全部标题都已在 ⇒ 视为已落地，**不要再投**；
   *   · `partial`  ⇒ 一部分已在 ⇒ 既不能重投（会重复）也不能当成功（会漏片），按失败交给人；
   *   · `absent`   ⇒ 确认一个都不在 ⇒ 安全重试；
   *   · `unknown`  ⇒ 列表查不到（接口失败/没有分P 字段）⇒ **不重试**（保守，按原逻辑 FAILED）。
   */
  private async probeAppendLanded(
    aid: string,
    wantTitles: string[],
    log: Logger,
  ): Promise<'landed' | 'partial' | 'absent' | 'unknown'> {
    const norm = (s: string): string => s.replace(/\s+/g, '').trim();
    const want = Array.from(new Set(wantTitles.map(norm).filter((s) => s.length > 0)));
    if (want.length === 0) return 'landed';
    /* fresh: true —— 必须看到**最新**分P 列表，缓存里的快照正是"提交前"的，用来判断落地毫无意义 */
    const existing = await this.fetchExistingPartTitles(aid, log, { fresh: true });
    if (!existing) {
      log.warn('限流重试前核对目标分P 失败（查不到分P 列表）—— 为避免重复分P，本次不重试');
      return 'unknown';
    }
    const have = new Set(existing.map(norm));
    const landedCount = want.filter((t) => have.has(t)).length;
    if (landedCount === want.length) return 'landed';
    if (landedCount > 0) {
      log.warn(
        `限流重试前核对：${landedCount}/${want.length} 个标题已在目标稿件的分P 列表里 —— ` +
          `重投会让已在的那几P 再出现一次，因此不重试（交给人工核对）`,
      );
      return 'partial';
    }
    return 'absent';
  }

  /**
   * 片段级失败**也要进错误报告**。
   *
   * 为什么必须补这一步（实测，2026-09-24）：以前这些分支只做 `log.error` + 台账写 `failReason`。
   * 界面上能看到"这个片段失败了"，但 `data/errors.jsonl` 与 `data/error-report/` 里**一条都没有** ——
   * 于是「错误报告」这个功能对真实故障完全无效：用户点进去只看到一堆测试噪音，
   * "近 24h 错误"也永远不反映真正挂掉的那次切片。
   *
   * 报告写失败不影响主流程：`writeErrorReport` 内部对写盘失败只降级（只留 errors.jsonl 那行），
   * 且这里的整段又包了一层 try —— 诊断能力再重要，也不能反过来把投稿搞挂。
   *
   * `retries`（2026-10-17 QA 复核发现）：限流重试耗尽后，台账 `failReason` 写了
   * 「（限流重试 3 次仍失败）」但报告里 `retries: []`，人工点开报告看不出"到底重试过没有、
   * 每次是什么时候被拒的"。所以调用方把每次被限流拒绝的记录传进来，这里透传给 `writeErrorReport`。
   */
  private reportClipFailure(input: {
    taskId: string;
    taskTitle?: string;
    clipIndex: number;
    stage: string;
    error: unknown;
    type: ErrorType;
    cutOutput?: string;
    /** 每次尝试的记录（进报告的 `retries` 字段） */
    retries?: RetryAttempt[];
  }): void {
    try {
      const failReason =
        input.error instanceof Error ? input.error.message : typeof input.error === 'string' ? input.error : '（见日志）';
      writeErrorReport({
        taskId: input.taskId,
        ...(input.taskTitle ? { taskTitle: input.taskTitle } : {}),
        stage: input.stage,
        // 包一层：报告标题/时间线里要一眼看出是**第几个片段**，否则"切片失败"无从定位
        error: new Error(`片段 #${input.clipIndex} ${input.stage} 失败：${failReason}`),
        type: input.type,
        ...(input.retries && input.retries.length > 0 ? { retries: input.retries } : {}),
        client: this.client,
        ledgerEntries: {
          clipIndex: input.clipIndex,
          stage: input.stage,
          failReason,
          ...(input.cutOutput ? { cutOutput: input.cutOutput } : {}),
        },
        taskStatus: this.ledger.getTask(input.taskId)?.status,
        extraEnv: {
          clipIndex: input.clipIndex,
          failReason,
          ...(input.cutOutput ? { cutOutput: input.cutOutput } : {}),
        },
      });
    } catch (e) {
      this.logger.warn(`片段级错误报告写入失败（不影响投稿）：${(e as Error).message}`, {
        data: { taskId: input.taskId, clipIndex: input.clipIndex },
      });
    }
  }

  update(cfg: AppConfig): void {
    this.cfg = cfg;
  }

  /* ------------------------------------------------------------------------
   * 完整版支线（§8 WP5 步骤 1）
   * ---------------------------------------------------------------------- */

  /**
   * 完整版上传支线。
   *
   * 两条路径：
   *   A. biliLive-tools 已自动上传 → 轮询 `GET /task/` 感知（**仅作加速信号**），
   *      **最终以 `GET /bili/archives` 反查到稿件为准**（任务队列重启即丢，硬约束 #17）。
   *   B. 未启用自动上传 → 由本服务调 `/bili/upload` 上传完整版。
   *
   * ⚠️ 无论哪条路径，**都不得阻塞切片流程**：切片的前置条件只有「源文件存在且可用」。
   * 台账记录上传状态的唯一用途是判断「源 mp4 何时可以删」（§7.3）。
   */
  /**
   * 投稿前补全主播 UID（简介模板 `{{anchorUid}}` 用）。
   *
   * 为什么放在投稿入口而不是任务创建时：历史任务、手动导入、以及任何漏网的任务
   * 都没有这个字段，投稿时兜底查一次最稳；查到了回写 ledger，下次投稿不再查。
   * 查不到（房间号失效 / 断网）也照常投稿，简介里那一项留空 —— 可选字段绝不挡投稿。
   *
   * ⚠️ 2026-10-17 修：**房间号变了必须重查**。
   *   目录轮询导入的场次不知道房间号，创建时按 `cfg.room.roomId` 兜底 —— 而配置主房间
   *   不一定是这一场的主播（实测：乙主播的场次兜底成甲主播的房间 23456789，简介写成
   *   「@甲主播」+ 原文链接指向甲主播的直播间，等于给别人的空间导流）。
   *   现在先用 `streamer` 在配置的所有房间里挑出真正的房间（写进 `anchorRoomId`），
   *   且**只有「当初按哪个房间查的」和现在一致时才复用缓存**，否则重查。
   */
  private async ensureAnchorUid(task: TaskRecord): Promise<void> {
    const prevRoom = task.anchorRoomId;
    const roomId = await this.resolveAnchorRoomId(task);
    if (roomId && roomId !== prevRoom) {
      task.anchorRoomId = roomId;
      try {
        this.ledger.updateTask(task.id, { anchorRoomId: roomId });
      } catch {
        /* 回写失败不阻塞投稿 */
      }
    }
    // 同一个房间已经查过 → 复用（批量投稿时每片都会走到这里）
    if (task.anchorUid && prevRoom === roomId) return;
    const info = await this.anchorOf(roomId || task.roomId);
    if (info.uid) {
      task.anchorUid = info.uid;
      if (info.name) task.anchorName = info.name;
      try {
        this.ledger.updateTask(task.id, {
          anchorUid: info.uid,
          ...(info.name ? { anchorName: info.name } : {}),
          anchorRoomId: roomId || task.roomId,
        });
      } catch {
        /* 回写失败不阻塞投稿 */
      }
    }
  }

  /** 房间号 → 主播信息（会话内缓存：同一批投稿会反复问同一个房间） */
  private readonly anchorRoomCache = new Map<string, { uid?: string; name?: string }>();

  private async anchorOf(roomId: string): Promise<{ uid?: string; name?: string }> {
    const key = String(roomId ?? '').trim();
    if (!key) return {};
    const hit = this.anchorRoomCache.get(key);
    if (hit) return hit;
    const info = await this.client.anchorInfoByRoom(key);
    this.anchorRoomCache.set(key, info);
    return info;
  }

  /**
   * 决定「这一场属于哪个房间」：拿 `task.streamer` 去配置的房间里逐个对名字。
   *
   * 顺序：① roomId 本身就对得上 → 用它（最常见）；② 配置里的其它房间（含「添加直播」加的）
   * 哪个对得上 → 用它；③ 都对不上 → **不猜**，保持 roomId。
   * 名字比对做归一化（去 `_Official` 后缀、忽略大小写与分隔符），因为
   * 目录名是 `乙主播` 而配置里的备注可能写 `乙主播`。
   */
  private async resolveAnchorRoomId(task: TaskRecord): Promise<string> {
    const want = normStreamerName(task.streamer);
    const own = String(task.roomId ?? '').trim();
    if (!want) return own;
    const candidates = [...new Set([own, this.cfg.room.roomId, ...(this.cfg.room.roomIds ?? [])].map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (candidates.length === 0) return own;
    if (own && normStreamerName((await this.anchorOf(own)).name) === want) return own;
    for (const room of candidates) {
      if (room === own) continue;
      const info = await this.anchorOf(room);
      if (normStreamerName(info.name) === want) return room;
    }
    return own;
  }

  async ensureFullVideoUpload(opts: {
    task: TaskRecord;
    uid: number | string;
    /** 完整版视频路径（压制产物） */
    videoPath: string;
    /** 用于反查的标题（默认取 task.title） */
    expectedTitle?: string;
    /** 是否由本服务主动上传（biliLive-tools 未启用自动上传时） */
    uploadBySelf?: boolean;
    isFullVideoHasDanmaku?: boolean;
    signal?: AbortSignal;
    noBlock?: boolean;
  }): Promise<{
    status: TaskRecord['fullUpload'];
    bvid?: string;
    taskId?: string;
    matched?: ArchiveMatch;
    note: string;
  }> {
    const { task, uid, videoPath } = opts;
    await this.ensureAnchorUid(task);
    const expectedTitle = opts.expectedTitle ?? task.title;
    const log = this.logger.child({ taskId: task.id });

    if (!exists(videoPath)) {
      const note = `完整版视频不存在：${videoPath} —— 无法确认上传状态`;
      log.warn(note);
      return { status: 'WAITING', note };
    }

    // ---- 先反查（唯一可靠证据）----
    const archives = await this.client.biliArchives({ page: 1, pageSize: 100 });
    const since = task.recordEndTime ? task.recordEndTime - 3600_000 : undefined;
    const matches = matchArchive(archives, expectedTitle, since !== undefined ? { sinceMs: since } : {});
    if (matches.length > 0) {
      const m = matches[0]!;
      log.info(`完整版已通过 /bili/archives 反查确认：bvid=${m.bvid}（${m.exact ? '标题精确匹配' : '标题包含匹配'}）`);
      return {
        status: 'CONFIRMED',
        bvid: m.bvid,
        matched: m,
        note: `反查确认（${m.exact ? '精确' : '模糊'}匹配），标题「${m.title ?? ''}」`,
      };
    }

    if (!opts.uploadBySelf) {
      // ---- 路径 A：感知 biliLive-tools 是否在传（加速信号，不作依据）----
      try {
        const tl = await this.client.taskList({ type: 'biliUpload', pageSize: 20 });
        const running = (tl.list ?? []).filter((t) => t.status === 'running' || t.status === 'pending');
        const related = running.filter((t) => {
          const hay = `${t.name ?? ''} ${t.desc ?? ''} ${t.output ?? ''}`;
          return hay.includes(path.basename(videoPath));
        });
        if (related.length > 0) {
          log.info(`检测到 biliLive-tools 正在上传完整版（任务 ${related.length} 个）—— 仅作加速信号，完成仍以 archives 反查为准`);
          return { status: 'UPLOADING', taskId: related[0]!.taskId, note: 'biliLive-tools 上传中（加速信号，未确认）' };
        }
      } catch {
        /* 任务列表查询失败不影响判定 */
      }
      return {
        status: 'WAITING',
        note: `尚未在 /bili/archives 反查到标题为「${expectedTitle}」的稿件。任务队列重启即丢，不能只靠 taskId，继续等待反查命中`,
      };
    }

    // ---- 路径 B：由本服务上传 ----
    const coverRes = resolveCover(this.cfg, {}, log);
    const { config } = buildBiliupConfig({
      clip: {
        index: -1,
        start: 0,
        end: task.source.totalDuration,
        title: expectedTitle,
        desc: `${task.title}\n\n本场完整录播。`,
        tags: [...this.cfg.publish.defaultTags, '完整录播'],
        category: this.cfg.publish.defaultCategory,
        score: 10,
        reason: '完整版',
        selected: true,
        status: 'PENDING_UPLOAD',
        degraded: false,
      },
      task,
      cfg: this.cfg,
      uid,
      // 完整版同样受 ≥1200 秒约束
      dtime: computeDtime(Date.now(), 1, {
        submitGapSec: this.cfg.publish.submitGapSec,
        clipGapSec: this.cfg.publish.clipGapSec,
        jitterSec: this.cfg.publish.jitterSec,
      }),
      uploadPresetId: this.cfg.publish.uploadPresetId,
      overrideTitle: expectedTitle,
      isFullVideo: true,
      ...(coverRes.cover ? { cover: coverRes.cover } : {}),
    });
    try {
      /* 走提交闸门：完整版与切片可能在同一进程里交替提交，B站 的频率限制是**按账号**的，
         所以「谁先谁后」必须由同一个进程级闸门排队（见 {@link withSubmitGate}）。 */
      const res = await this.submitUpload({ uid, videos: [videoPath], config }, log, '完整版');
      this.ledger.logPublish({ taskId: task.id, clipIndex: -1, action: 'submit', uploadTaskId: res.taskId, title: expectedTitle });
      log.info(`已由本服务提交完整版上传，taskId=${res.taskId}（完成仍以 archives 反查为准）`);
      return { status: 'UPLOADING', taskId: res.taskId, note: '本服务已提交完整版上传' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('完整版上传提交失败', e);
      return { status: 'FAILED', note: `完整版上传提交失败：${msg}` };
    }
  }

  /* ------------------------------------------------------------------------
   * 切片：两步走
   * ---------------------------------------------------------------------- */

  /**
   * 读取本场转写段（烧字幕用）。
   *
   * 按 `taskId + 文件 mtime` 缓存：一次投稿要切 6 个片段，
   * 每次都读一遍几百 KB 的 transcript.json 是白费；
   * 带上 mtime 又能保证「重跑转写后拿到的是新内容」，不需要手写失效逻辑。
   */
  private transcriptOf(task: TaskRecord): TranscriptSegment[] {
    const p = task.transcriptPath ?? path.join(this.ledger.taskDir(task.id), 'transcript.json');
    try {
      if (!exists(p)) return [];
      const mtime = fs.statSync(p).mtimeMs;
      const key = `${task.id}|${mtime}`;
      const hit = this.transcriptCache.get(key);
      if (hit) return hit;
      const t = readJson<Transcript>(p);
      const segments = Array.isArray(t?.segments) ? t.segments : [];
      // 只保留最近几条，避免长时间运行把内存吃掉
      if (this.transcriptCache.size > 8) this.transcriptCache.clear();
      this.transcriptCache.set(key, segments);
      return segments;
    } catch (e) {
      this.logger.warn(`读取转写失败，本片不烧字幕：${(e as Error).message}`, { taskId: task.id });
      return [];
    }
  }

  private async ffmpegPresets(): Promise<FfmpegPreset[]> {
    const now = Date.now();
    if (this.presetCache && now - this.presetCache.at < 300_000) return this.presetCache.list;
    try {
      const list = await this.client.presetFfmpeg();
      this.presetCache = { at: now, list };
      return list;
    } catch (e) {
      this.logger.warn('读取 ffmpeg 预设失败，将使用内置参数', { data: { error: (e as Error).message } });
      return [];
    }
  }

  /**
   * 对单个片段执行「切片 → 轮询 → 投稿」两步走。
   *
   * 幂等：
   *   1. 本地指纹命中 → 直接跳过
   *   2. 提交前用 `/bili/archives` 按标题反查 → 命中则补记指纹并跳过
   *   3. 提交前把状态写成 `SUBMITTING`，崩溃后由 `stuckClips()` 接手核对
   */
  async cutAndUploadClip(opts: CutAndUploadOptions, clipIndex: number): Promise<CutAndUploadResult> {
    const { task, uid } = opts;
    const cfg = this.cfg;
    const warnings: string[] = [];
    const clip = this.ledger.getClip(task.id, clipIndex);
    if (!clip) return { clipIndex, ok: false, error: { type: 'internal', message: `找不到切片 #${clipIndex}` }, warnings };

    const log = this.logger.child({ taskId: task.id, stage: 'CLIPPING' });

    // ---- 幂等 1：本地指纹 ----
    const fp = clipFingerprint({
      sourceVideoId: task.recordingId ?? task.id,
      start: clip.start,
      end: clip.end,
      title: clip.title,
    });
    const known = this.ledger.findFingerprint(fp);
    if (known) {
      const note = `幂等命中：该片段已投过（bvid=${known.bvid ?? '尚未反查到'}，于 ${known.at}），跳过`;
      log.info(note, { data: { clipIndex, fingerprint: fp } });
      this.ledger.setClipStatus(task.id, clipIndex, known.bvid ? 'PUBLISHED' : 'SUBMITTED', {
        fingerprint: fp,
        ...(known.bvid ? { bvid: known.bvid } : {}),
      });
      return { clipIndex, ok: true, skipped: note, ...(known.bvid ? { bvid: known.bvid } : {}), warnings };
    }

    /* ---- 幂等 1b：**墓碑** ----
     * 指纹表里没有，不代表这段内容没投过：用户删掉那个任务/切片时，指纹会退役。
     * 若那次投稿**真的成功过**，退役后的指纹会变成墓碑继续留在台账里 —— 这里就是它的检查点。
     *
     * 为什么不能像以前那样「退役 = 彻底忘掉」：
     *   删任务 → 素材仍在监听目录里 → 重新导入 → 重新分析得到同一区间 → 本地无记录
     *   → B站 上出现第二个内容完全相同的稿件，而 B站 没有删除稿件的开放接口。
     *   这是本项目唯一会污染线上的路径，详见 ledger.ts 的 FingerprintTombstone 注释。 */
    const tomb = this.ledger.findTombstone(fp);
    if (tomb) {
      const note =
        `墓碑拦截：该片段在 ${tomb.retiredAt} 之前已经投过` +
        `（${tomb.bvid ? `bvid=${tomb.bvid}` : '当时未反查到 bvid'}，原任务 ${tomb.taskId} 已被删除），` +
        `为避免在 B站 上产生重复稿件而跳过。若那个稿件确实已经不存在，请在界面上解除墓碑后重跑`;
      log.warn(note, { data: { clipIndex, fingerprint: fp, tombstone: tomb } });
      warnings.push(note);
      this.ledger.setClipStatus(task.id, clipIndex, tomb.bvid ? 'PUBLISHED' : 'SUBMITTED', {
        fingerprint: fp,
        ...(tomb.bvid ? { bvid: tomb.bvid } : {}),
        blockedByTombstone: fp,
      });
      return { clipIndex, ok: true, skipped: note, ...(tomb.bvid ? { bvid: tomb.bvid } : {}), warnings };
    }

    // ---- 幂等 2：服务器侧按标题反查 ----
    let archives = opts.archiveCache;
    if (!archives) {
      archives = await this.client.biliArchives({ page: 1, pageSize: 100 });
    }
    const titleMatches = matchArchive(archives, clip.title, {
      ...(task.recordEndTime ? { sinceMs: task.recordEndTime - 3600_000 } : {}),
    }).filter((m) => m.exact);
    if (titleMatches.length > 0) {
      const m = titleMatches[0]!;
      const note = `服务器侧已存在同名稿件（bvid=${m.bvid}），跳过投稿并补记指纹（避免重复稿件）`;
      log.warn(note, { data: { clipIndex, title: clip.title } });
      this.ledger.registerFingerprint(fp, { taskId: task.id, clipIndex, bvid: m.bvid });
      this.ledger.rememberPublishedTitle(clip.title);
      this.ledger.setClipStatus(task.id, clipIndex, 'PUBLISHED', { fingerprint: fp, bvid: m.bvid });
      this.ledger.logPublish({
        taskId: task.id,
        clipIndex,
        action: 'confirm',
        bvid: m.bvid,
        title: clip.title,
        fingerprint: fp,
        // 幂等命中时本地可能留有上次投稿的 uploadTaskId：带上它，额度统计才能把这条
        // confirm 与上次那条 submit 认成同一个稿件，而不是当成一次新的投稿。
        ...(clip.uploadTaskId ? { uploadTaskId: clip.uploadTaskId } : {}),
      });
      return { clipIndex, ok: true, skipped: note, bvid: m.bvid, warnings };
    }

    // ---- 幂等 3：切片产物已存在 → **不重切**，直接投稿 ----
    //
    // 这是「重新切片与投稿」按钮的语义收口（2026-10-17 用户明确口径）：
    //   · 产物在   ⇒ 重新**投稿**（不再提交一次 ffmpeg——既浪费几分钟又覆盖已有文件）；
    //   · 产物不在 ⇒ 重新**切片**再投稿（走下面的正常切割流程）。
    // 为什么可以放心复用：用户改过时间范围的候选不会误入这里 ——
    // `PATCH /api/task/:id/clip/:idx` 改区间时会把 `cutOutput` 一并 unset，
    // 所以「cutOutput 有值且文件确实存在」⇒ 产物与当前切片区间一致。
    // 已发布的候选到不了这个函数（publishClips 的状态过滤已把它们挡掉），
    // 显式指定重投（approve + includeSubmitted）的场景同样受益：产物在就不重切。
    const reuseOutput =
      typeof clip.cutOutput === 'string' && clip.cutOutput !== '' && exists(clip.cutOutput)
        ? clip.cutOutput
        : undefined;
    let taskOutput: string | undefined;
    if (reuseOutput) {
      taskOutput = reuseOutput;
      log.info(
        `复用已有切片产物（不重切，直接投稿）：${path.basename(reuseOutput)}（${(fileSize(reuseOutput) / 1024 / 1024).toFixed(1)} MB）`,
        { data: { clipIndex } },
      );
    }

    // ---- 源文件校验（复用产物时不需要源文件，跳过）----
    const sourcePath: string = reuseOutput ? '' : (pickSourceForCut(task, cfg) ?? '');
    if (!reuseOutput && !sourcePath) {
      const msg = `找不到可用于切片的源文件。source.rawFiles 与 fullVideoPath 都不可用，无法切片`;
      log.error(msg);
      this.ledger.setClipStatus(task.id, clipIndex, 'FAILED', { failReason: msg });
      this.reportClipFailure({
        taskId: task.id,
        taskTitle: task.title,
        clipIndex,
        stage: 'CLIPPED',
        error: new Error(msg),
        type: 'file-missing',
      });
      return { clipIndex, ok: false, error: { type: 'file-missing', message: msg }, warnings };
    }

    // ---- 弹幕烧录：源版本决定是否传 ASS（陷阱 #8、硬约束 #12）----
    // （复用已有产物时整段跳过：那些 ASS 是**切割时**烧进画面的，现在重建也没人用）
    let assPath: string | undefined;
    if (!reuseOutput && cfg.clip.burnDanmaku) {
      if (task.source.fullVideoHasDanmaku) {
        warnings.push('源文件已烧弹幕（fullVideoHasDanmaku=true），不再传 assFilePath，避免叠双层弹幕');
      } else if (task.source.danmaAssPath && exists(task.source.danmaAssPath)) {
        assPath = task.source.danmaAssPath;
      } else if (task.source.danmaXmlPath && exists(task.source.danmaXmlPath)) {
        // 只有 XML：现场转 ASS。
        //
        // ⚠️ 这里**不能**用 biliLive-tools 的 `/task/convertXml2Ass`
        //    （实测 v3.21.0 恒定报 HTTP 500「保存类型错误」，各种参数组合都无效）。
        //    改走 `danmaku-ass.ts`：DanmakuFactory 直转 → JSON 中转 → 内置兜底，
        //    并在最后统一去掉 BOM（带 BOM 的 ASS 会让切片接口 500）。
        try {
          const assOut = path.join(
            this.ledger.taskDir(task.id),
            `${path.basename(task.source.danmaXmlPath, path.extname(task.source.danmaXmlPath))}.ass`,
          );
          const conv = await convertDanmakuToAss({
            taskId: task.id,
            videoPath: sourcePath,
            xmlPath: task.source.danmaXmlPath,
            assOut,
            factoryPath: findDanmakuFactory(cfg.danmaku.factoryPath),
            ...(cfg.danmaku.fontSize ? { fontSize: cfg.danmaku.fontSize } : {}),
            logger: log,
          });
          for (const w of conv.warnings) warnings.push(w);
          if (conv.assPath && conv.dialogueCount > 0) {
            assPath = conv.assPath;
            log.info(
              `弹幕已转换为 ASS：${conv.dialogueCount}/${conv.xmlCount} 条（方式：${conv.method}）`,
              { data: { clipIndex } },
            );
          } else {
            warnings.push('弹幕转换未产出可用 ASS，本片将不带弹幕');
          }
        } catch (e) {
          warnings.push(`弹幕 XML 转 ASS 失败，本片将不带弹幕：${(e as Error).message}`);
        }
      } else {
        warnings.push('没有可用的弹幕文件（ASS/XML 都不存在），本片将不带弹幕');
      }
    }

    /* ---- 字幕烧录：转写 → ASS，并与弹幕 ASS 合成**一个**文件 ----
     *
     * 为什么必须合并：实测 `POST /task/cut` 的 `files` 只接受一个 `assFilePath`
     * （见 api.ts 的注释），传两份是不可能的。
     *
     * 为什么值得做：转写已经花过 ASR 的钱，不烧字幕等于白花；
     * 静音刷视频和竖屏分发两个场景都离不开字幕。 */
    if (!reuseOutput && cfg.clip.burnSubtitles) {
      const segments = this.transcriptOf(task);
      if (segments.length === 0) {
        warnings.push('没有转写内容（transcript.json 缺失或为空），本片只烧弹幕、不烧字幕');
      } else if (opts.dryRun) {
        // dry-run 不落盘任何产物：只报「会烧多少条」，让用户能预判效果而不产生副作用
        const preview = buildCues(segments, {
          ...(cfg.clip.subtitle.fontSize ? { fontSize: cfg.clip.subtitle.fontSize } : {}),
          maxCharsPerLine: cfg.clip.subtitle.maxCharsPerLine,
          minDurationSec: cfg.clip.subtitle.minDurationSec,
          readingCharsPerSec: cfg.clip.subtitle.readingCharsPerSec,
        });
        log.info(
          `dry-run：将烧入 ${preview.cues.length} 条字幕（跳过 ${preview.droppedNoise} 条噪声行），不生成 ASS 文件`,
          { data: { clipIndex } },
        );
      } else {
        try {
          const burn = buildBurnAss({
            outDir: this.ledger.taskDir(task.id),
            // 源文件本身已带弹幕时不再叠弹幕，但仍要烧字幕（此时没有弹幕 ASS）
            ...(assPath && !task.source.fullVideoHasDanmaku ? { danmakuAssPath: assPath } : {}),
            segments,
            ...(sourcePath ? { videoPath: sourcePath } : {}),
            render: {
              ...(cfg.clip.subtitle.fontSize ? { fontSize: cfg.clip.subtitle.fontSize } : {}),
              ...(cfg.clip.subtitle.marginV ? { marginV: cfg.clip.subtitle.marginV } : {}),
              maxCharsPerLine: cfg.clip.subtitle.maxCharsPerLine,
              minDurationSec: cfg.clip.subtitle.minDurationSec,
              readingCharsPerSec: cfg.clip.subtitle.readingCharsPerSec,
              fontName: cfg.clip.subtitle.fontName,
            },
            logger: log,
          });
          for (const w of burn.warnings) warnings.push(w);
          if (burn.assPath) {
            assPath = burn.assPath;
            log.info(`字幕已并入烧录用 ASS：${burn.subtitleCount} 条（合并弹幕=${burn.merged}）`, { data: { clipIndex } });
          }
        } catch (e) {
          // 字幕只是观感增强，失败不能挡住出片
          warnings.push(`字幕生成失败，本片不带字幕：${(e as Error).message}`);
        }
      }
    } else if (task.source.fullVideoHasDanmaku) {
      warnings.push('字幕烧录已关闭，且源文件已含弹幕，本片将不带任何叠加文字');
    }

    // ---- 输出路径（绝对路径，陷阱 #6）----
    const outDir = absPath(path.join(cfg.clip.outputDir, task.id));
    ensureDir(outDir);
    const output = path.join(
      outDir,
      `${String(clipIndex + 1).padStart(2, '0')}-${fmtDuration(clip.start).replace(/:/g, '')}-${sanitizeTitle(clip.title, 40).title.replace(/[<>:"/\\|?*]/g, '_')}.mp4`,
    );

    // ---- ffmpegOptions ----
    const presets = await this.ffmpegPresets();
    const built = buildFfmpegOptions(presets, cfg.clip.ffmpegPresetId, { start: clip.start, end: clip.end }, cfg.clip.ffmpegOptionsOverride);
    warnings.push(...built.warnings);

    if (opts.dryRun) {
      const note = `dry-run：不执行切片与投稿（将切割 ${fmtDuration(clip.start)}–${fmtDuration(clip.end)} → ${path.basename(output)}）`;
      log.info(note, { data: { clipIndex } });
      return { clipIndex, ok: true, skipped: note, output, warnings };
    }

    // ---- 提交前写 SUBMITTING（崩溃恢复的判定点）----
    this.ledger.setClipStatus(task.id, clipIndex, 'SUBMITTING', { fingerprint: fp });

    // ---- 第一步：切片（产物已复用时整段跳过）----
    let cutTaskId: string | undefined;
    if (reuseOutput) cutTaskId = '(reused)';
    else
      try {
      /* ⚠️ 三个路径**全部**必须绝对路径（陷阱 #6）。
         实测事故（2026-09-23，真实录播验证时抓到）：
           `assFilePath` 漏了 absPath，于是把 `data/tasks/<id>/burn-xxx.ass` 这样的
           **相对路径**发给了 biliLive-tools。它自己不解析这个路径，而是原样塞进 ffmpeg
           的 filter_complex：
             `[0:v]subtitles=data/tasks/.../burn-d8badca8.ass[0:video]`
           ffmpeg 以自己的 cwd 解析 → `No such file or directory` →
           任务失败 `ffmpeg exited with code 4294967294`（即 -2），切片直接不产出。
         为什么以前没暴露：`videoFilePath` 来自录制目录（本来就是绝对路径），
           `output`/`outDir` 已经用了 absPath —— 只有字幕 ASS 这条链**可能**是相对的
           （`clip.outputDir` 默认就是相对的 `data/clips`），所以只有"带字幕烧录"的
           切片会中招。字幕是切片的核心卖点，这条路径必须硬。
         注意还要喂给对方的是**路径本身**：ffmpeg 的 subtitles 滤镜里 `:` 和 `\` 有特殊
           含义，但 biliLive-tools 内部会做转义处理，我们只负责给绝对路径。 */
      const res = await this.client.cut({
        videoFilePath: absPath(sourcePath),
        ...(assPath ? { assFilePath: absPath(assPath) } : {}),
        output,
        ffmpegOptions: built.options,
        saveType: 2,
        savePath: outDir,
      });
      cutTaskId = res.taskId;
      this.ledger.setClipStatus(task.id, clipIndex, 'CUTTING', { cutTaskId });
      log.info(`切片任务已提交：${cutTaskId}（${fmtDuration(clip.start)}–${fmtDuration(clip.end)}，参数来源 ${built.source}）`, {
        data: { clipIndex, ass: Boolean(assPath) },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const type = e instanceof ApiError ? e.type : 'internal';
      log.error(`切片任务提交失败（片段 #${clipIndex}）`, e);
      this.ledger.setClipStatus(task.id, clipIndex, 'FAILED', { failReason: `切片提交失败：${msg}` });
      this.reportClipFailure({
        taskId: task.id,
        taskTitle: task.title,
        clipIndex,
        stage: 'CLIPPED',
        error: e,
        type,
      });
      return { clipIndex, ok: false, error: { type, message: msg }, warnings };
    }

    // ---- 第二步：轮询到 completed，取服务端返回的真实产出路径 ----
    // （产物已复用时整段跳过 —— 文件已经在了，没有任务可轮询）
    if (!reuseOutput)
      try {
        const detail = await this.waitTask(cutTaskId, {
          timeoutSec: cfg.clip.cutTimeoutSec,
          ...(opts.signal ? { signal: opts.signal } : {}),
          onPoll: (d) => log.debug(`切片任务 ${cutTaskId} 状态：${d.status ?? 'unknown'}`),
        });
        taskOutput = typeof detail.output === 'string' && detail.output ? detail.output : output;
      if (taskOutput !== output) {
        log.info(`服务端返回的产出路径与预期不同，以服务端为准：${String(detail.output)}`);
      }
      if (!exists(taskOutput)) {
        throw new Error(`切片任务已完成但产出文件不存在：${taskOutput}`);
      }
      this.ledger.setClipStatus(task.id, clipIndex, 'CUT', { cutOutput: taskOutput });
      log.info(`切片产出完成：${path.basename(taskOutput)}（${(fileSize(taskOutput) / 1024 / 1024).toFixed(1)} MB）`);

      /* ---- 音画对齐修复：实测录播切出来的片段音频会比画面早 1–3.7 秒，
         观众先听到词、过几秒才看到对应画面与字幕 —— 也就是用户报的「字幕和声音对不上」。
         这里做一次流拷贝重挂把两条流对齐（不重编码、画面与已烧字幕不动）。 ---- */
      const sync = await ensureAvSync(taskOutput, {
        enabled: cfg.clip.avSyncRepair,
        toleranceSec: cfg.clip.avSyncToleranceSec,
        logger: log,
      });
      if (!sync.repaired && sync.warning) warnings.push(`音画对齐未能完成：${sync.warning}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`切片任务失败（片段 #${clipIndex}，taskId=${cutTaskId}）`, e);
      this.ledger.setClipStatus(task.id, clipIndex, 'FAILED', { failReason: `切片失败：${msg}` });
      this.reportClipFailure({
        taskId: task.id,
        taskTitle: task.title,
        clipIndex,
        stage: 'CLIPPED',
        error: e,
        type: 'internal',
      });
      return { clipIndex, ok: false, cutTaskId, error: { type: 'internal', message: msg }, warnings };
    }

    // ---- 多分P模式：只切片，投稿由 publishAsMultiPart 统一完成 ----
    if (opts.skipUpload) {
      const note = `已切片，等待与完整版一起投进同一稿件（多分P模式，不单独投稿）`;
      /* taskOutput 到这里必有值：要么来自产物复用，要么来自轮询产出（失败已在上面 return） */
      const cutFile = taskOutput as string;
      this.ledger.setClipStatus(task.id, clipIndex, 'CUT', { cutOutput: cutFile, fingerprint: fp });
      log.info(note, { data: { clipIndex, output: path.basename(cutFile) } });
      return { clipIndex, ok: true, skipped: note, cutTaskId, output: cutFile, warnings };
    }

    // ---- 第三步：投稿 ----
    const submitTimeMs = opts.submitTimeMs ?? Date.now();
    /* 序号 N：**本场第几片**（1 起），由调用方 `publishClips` 传下来（`clipOrdinal: idx + 1`）。
       这里原先自己数：「近 24 小时的 submit 条数 + 1」—— 那个口径**跨批次**，前一晚投过的切片
       会把本批的 N 抬高，整批被推后 (N-1)×间隔（线上实测 2026-10-17：N=28 ⇒ 首片 02:26 变 04:41，
       详见 `CutAndUploadOptions.clipOrdinal`）。缺省 1 = 把这一片当本批首片 ——
       直接调本函数的单片路径（人工重投等）不该再被那个跨批次的近似值推到几小时后。 */
    const n =
      opts.clipOrdinal !== undefined && Number.isFinite(opts.clipOrdinal) && opts.clipOrdinal >= 1
        ? Math.floor(opts.clipOrdinal)
        : 1;
    // 首片允许用户显式指定发布时间；其余按 clipGapSec 递进
    const wantFirst = n === 1 ? parseFirstPublishAt(cfg.publish.firstPublishAt) : undefined;
    if (n === 1 && cfg.publish.firstPublishAt && wantFirst === undefined) {
      warnings.push('publish.firstPublishAt 无法解析或已过期，已回退为自动排期（正确格式如 2026-09-23T08:00）');
    }
    /* 立即发布 / 片间隔：与 buildBiliupConfig 用**同一个**判定，避免「payload 不带 dtime、
       日志却写定时发布」这种自相矛盾（实测踩过）。

       ★ 这里的口径由 `resolveClipPublishSchedule()` 统一给出（2026-10-16 定，2026-10-17 改口径）：
         「单独投稿」⇒ 固定定时投稿 + 「设置里的相邻切片间隔 / 随机抖动」（间隔 300 秒保底、
         抖动受「必须小于间隔」夹取）。`immediatePublish` 仍不参与切片（立即发布不传 dtime）。
         「追加切片投稿」⇒ 逐字沿用 config（这条路径通常不走到这里：它带 skipUpload，
         切完就返回、由 publishAsMultiPart 统一投）。 */
    const sched = resolveClipPublishSchedule(cfg.publish);
    let immediate = !sched.scheduled;
    let dtime = computeDtime(submitTimeMs, n, {
      submitGapSec: cfg.publish.submitGapSec,
      clipGapSec: sched.gapSec,
      jitterSec: sched.jitterSec,
      ...(wantFirst !== undefined ? { notBeforeSec: wantFirst } : {}),
    });
    /* 用户给**这一片**手动指定的发布时间优先于自动排期（`PATCH /api/task/:id/clip/:idx {dtime}`）。
       它甚至盖过全局的「立即发布」——「我就要这一片定时发」是比全局默认更强的意图。
       但硬约束 #4 一步都不能让：不合法就**拒绝使用**并回退自动排期 + 告警
       （既不悄悄改用户填的时间，也不把不合规的时间投出去让 B站 拒稿）。 */
    const userDtime = clip.dtime !== undefined && Number.isFinite(Number(clip.dtime)) ? Number(clip.dtime) : undefined;
    if (userDtime !== undefined) {
      const v = validateDtime(userDtime, submitTimeMs);
      if (v.ok) {
        dtime = userDtime;
        if (immediate) {
          immediate = false;
          warnings.push(`这一片指定了发布时间 ${fmtLocal(userDtime * 1000)}，本次改为**定时发布**（覆盖全局的「立即发布」）`);
        }
      } else {
        warnings.push(
          `这一片指定的发布时间 ${fmtLocal(userDtime * 1000)} 不满足硬约束 #4（${v.note}），已回退为自动排期`,
        );
      }
    }
    /* 提交前的最后一道复核：dtime 是与**批次开始时刻**对齐排的，但真正调接口是现在
       —— 上传慢的时候靠后的片会被挤到「提交后不足 1200 秒」而被 B站 拒稿（见函数注释）。 */
    if (!immediate) {
      const gate = clampDtimeForSubmit(dtime, Date.now());
      if (gate.bumped) {
        warnings.push(gate.note);
        log.warn(`第 ${n} 片发布时间被合规修正：${gate.note}`);
      }
      dtime = gate.dtime;
    }
    const coverRes = resolveCover(this.cfg, {}, log);
    if (coverRes.attempts.length) {
      log.debug(`封面回退过程：${coverRes.attempts.map((a) => `${a.source}(${a.reason})`).join(' → ')}`);
    }
    const { config, warnings: cfgWarnings } = buildBiliupConfig({
      clip,
      task,
      cfg,
      uid,
      dtime,
      uploadPresetId: cfg.publish.uploadPresetId,
      /* ★ 必须显式传入。这个函数自己也会读 cfg，但「传参」才是权威来源 ——
         曾经这里漏传，导致开了立即发布却仍然带 dtime（稿件被定到 4 天后）。 */
      immediate,
      ...(coverRes.cover ? { cover: coverRes.cover } : {}),
    });
    warnings.push(...cfgWarnings);

    /* taskOutput 到这里必有值（复用或轮询二选一），但 TS 推不出来 —— 显式守卫，
       宁可抛内部错误也不把 undefined 塞进投稿载荷（会出现 videos:[undefined] 的 400） */
    if (!taskOutput) {
      throw new Error('内部错误：走到投稿却没有切片产物路径（复用与轮询都没给出 output）');
    }

    /* ---- 第三步：投稿（含「限流」安全重试）----
       B站 的「您投稿的频率过快，请稍等2秒」是**提交被拒**（没有任何稿件/分P 被创建），
       等几秒重交是安全的 —— 见文件顶部 `UPLOAD_RATE_LIMIT_*` 的说明与 2026-10-17 线上事故。
       重试**只发生在提交动作这一层**：`shouldAutoRetry`（publishClips 层）对 upload-failed
       仍然一律不重试，那条守卫防的是"已经上传过、可能已落地"的重复分P，与这里不冲突。

       ★ 2026-10-21：限流分两类，判据统一走 `classifySubmitLimit`，**必须先问 quota**：
           · `quota`（`投稿过于频繁，请稍后再试`，无秒数）⇒ 立刻收手，不重试（见文件顶部说明）；
           · `short`（带秒数）            ⇒ 等对方给的秒数后重交，行为与以前完全一致。 */
    let rateLimitRetries = 0;
    /* 每次"被限流拒绝"的记录，进错误报告（QA 复核要求：人工要知道重试了几次、各在何时） */
    const rateLimitAttempts: RetryAttempt[] = [];
    /** 命中账号级配额限流时的原始错误；非空 ⇒ 跳过后面所有的重试/失败逻辑，统一收尾 */
    let quotaLimitedMsg = '';
    try {
      let res: BiliUploadResponse | undefined;
      let uploadOutcome: { status: string; error?: string } | undefined;
      for (let attempt = 1; attempt <= this.rateLimitMaxAttempts; attempt++) {
        try {
          res = await this.submitUpload({ uid, videos: [taskOutput], config }, log, `片段 #${clipIndex}`);
        } catch (e) {
          /* 分支 A：`/bili/upload` 同步抛错（提交被拒） */
          const msg = e instanceof Error ? e.message : String(e);
          const limitKind = classifySubmitLimit(msg);
          /* 配额级：不可能在几秒内恢复，原地重试只是白挨拒绝 ⇒ 立即收手 */
          if (limitKind === 'quota') {
            quotaLimitedMsg = msg;
            break;
          }
          /* 秒级：等对方给的秒数再交（既有行为） */
          if (limitKind === 'short' && attempt < this.rateLimitMaxAttempts) {
            rateLimitRetries += 1;
            rateLimitAttempts.push({ attempt, at: nowIso(), type: 'upload-failed', message: msg });
            await this.waitForRateLimit(msg, attempt, log);
            continue;
          }
          throw e;
        }
        /* 提交已受理：SUBMITTED 是**崩溃恢复的判定点**，必须立刻落盘（与旧行为一致）。
           若下面发现这次其实被 B站 限流拒了，这个状态会被下一次尝试的新 taskId 覆盖 —— 无害。 */
        const submittedTaskId = res.taskId;
        this.ledger.setClipStatus(task.id, clipIndex, 'SUBMITTED', {
          uploadTaskId: submittedTaskId,
          submitTime: submitTimeMs,
          dtime,
        });
        this.ledger.registerFingerprint(fp, { taskId: task.id, clipIndex });
        this.ledger.rememberPublishedTitle(clip.title);

        // ---- 第四步（可选但重要）：确认上传任务的最终结果 ----
        // `/bili/upload` 只返回 taskId（陷阱 #11），而任务状态才是「投稿到底成没成」的直接证据。
        // 不做这一步的话，上传失败要等到若干天后的 bvid 反查才暴露 —— 期间台账一直显示「已提交」。
        // 注意：**bvid 仍然只能靠 /bili/archives 反查**（任务队列在内存中、重启即丢）。
        uploadOutcome = await this.waitUploadTask(submittedTaskId, {
          timeoutSec: cfg.publish.autoCutTimeoutSec,
          ...(opts.signal ? { signal: opts.signal } : {}),
          onPoll: (d) => log.debug(`上传任务 ${submittedTaskId} 状态：${d.status ?? 'unknown'}`),
        });
        /* 分支 B：任务终态 error。同样是"提交被拒"，但两类限流的处置相反：
           · 线上事故那一支（`您投稿的频率过快，请稍等2秒`）⇒ 秒级，等 N 秒重交；
           · 2026-10-21 那一支（`投稿过于频繁，请稍后再试`）⇒ 配额级，立刻收手。 */
        if (uploadOutcome.status === 'error') {
          const kind = classifySubmitLimit(uploadOutcome.error);
          if (kind === 'quota') {
            quotaLimitedMsg = uploadOutcome.error ?? '投稿过于频繁，请稍后再试';
            break;
          }
          if (kind === 'short' && attempt < this.rateLimitMaxAttempts) {
            rateLimitRetries += 1;
            rateLimitAttempts.push({
              attempt,
              at: nowIso(),
              type: 'upload-failed',
              message: uploadOutcome.error ?? '',
            });
            await this.waitForRateLimit(uploadOutcome.error ?? '', attempt, log);
            continue;
          }
        }
        break;
      }
      /* ---- 配额级限流：本片按「待投」收尾，本轮到此为止 ----
         ⚠️ 必须放在写 `submit` 行**之前**：被配额拒的那一次**什么都没创建**，
            记一条 submit 会让 `todayPublishedCount()` 把额度凭空吃掉（与限流重试同一条理由）。
         ⚠️ 还要清掉刚才登记的指纹：那条指纹是"投出去了"的**假证据**，
            留着的话「重跑投稿阶段」时幂等 1 会命中并把它当成已投过（转成 SUBMITTED），
            于是这一片永远投不出去、也没有任何报错。 */
      if (quotaLimitedMsg) {
        if (!clip.bvid) {
          this.ledger.clearFingerprintsFor([{ taskId: task.id, clipIndex }]);
        }
        return this.finishQuotaLimited({
          task,
          clipIndex,
          clip,
          msg: quotaLimitedMsg,
          log,
          cutOutput: taskOutput,
          warnings,
        });
      }
      if (!res) throw new Error('内部错误：投稿重试循环结束却没有提交结果');

      /* submit 行只写**一次**（放在循环外）：限流被拒的那几次什么都没创建，不该算进
         「今日已投稿」的额度统计，否则重试会把一天的额度凭空吃掉。 */
      this.ledger.logPublish({
        taskId: task.id,
        clipIndex,
        action: 'submit',
        fingerprint: fp,
        uploadTaskId: res.taskId,
        title: clip.title,
        /* ★ 立即发布时**不记 dtime**。以前无条件记，于是日志里出现
           「定时发布 2026-09-27」这种与实际 payload 不符的时间（UI 的 schedule.dtimeText
           也是从这条反推的），排查时把人带偏过一次。没有这个字段才代表「未传 dtime」。 */
        ...(immediate ? {} : { dtime }),
      });
      log.info(
        `已提交投稿：${clip.title}（uploadTaskId=${res.taskId}，` +
          (immediate ? '**立即发布**（未传 dtime，过审即公开）' : `定时发布 ${fmtLocal(dtime * 1000)}`) +
          `，${cfg.publish.isOnlySelf === 1 ? '仅自己可见' : '公开'}` +
          `${rateLimitRetries > 0 ? `；此前被限流拒绝 ${rateLimitRetries} 次，等待后重试成功` : ''}）`,
        { stage: 'PUBLISHED' },
      );
      if (uploadOutcome && uploadOutcome.status === 'error') {
        const msg = uploadOutcome.error ?? '（对方未提供错误信息，请看 /common/getLogContent 的日志片段）';
        /* 耗尽重试仍是限流 ⇒ failReason 必须写清"重试过几次"，否则人工重投前无从判断
           是"B站 真不接受"还是"我们没重试"。 */
        const limitedNote =
          rateLimitRetries > 0 && isUploadRateLimited(msg)
            ? `（限流重试 ${this.rateLimitMaxAttempts} 次仍失败）`
            : '';
        log.error(`投稿任务失败：${msg}${limitedNote} —— 切片产物已保留，可单独重投`, undefined, { data: { clipIndex } });
        this.ledger.setClipStatus(task.id, clipIndex, 'FAILED', {
          failReason: `投稿任务失败：${msg}${limitedNote}`,
          uploadTaskId: res.taskId,
          cutOutput: taskOutput,
        });
        this.ledger.logPublish({ taskId: task.id, clipIndex, action: 'fail', error: msg, title: clip.title });
        this.reportClipFailure({
          taskId: task.id,
          taskTitle: task.title,
          clipIndex,
          stage: 'PUBLISHED',
          error: new Error(`${msg}${limitedNote}`),
          type: 'upload-failed',
          cutOutput: taskOutput,
          ...(rateLimitAttempts.length > 0 ? { retries: rateLimitAttempts } : {}),
        });
        return { clipIndex, ok: false, cutTaskId, output: taskOutput, uploadTaskId: res.taskId, error: { type: 'upload-failed', message: `${msg}${limitedNote}` }, warnings };
      }
      log.debug(`上传任务 ${res.taskId} 已完成（${uploadOutcome?.status ?? 'unknown'}），bvid 待 /bili/archives 反查确认`);

      if (rateLimitRetries > 0) {
        warnings.push(`投稿被 B站 限流拒绝 ${rateLimitRetries} 次，等待后重试成功`);
      }
      return { clipIndex, ok: true, cutTaskId, output: taskOutput, uploadTaskId: res.taskId, dtime, warnings };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      /* 分支 A 耗尽（最后一次仍是同步限流错）也要把次数写进 failReason */
      const limitedNote =
        rateLimitRetries > 0 && isUploadRateLimited(msg)
          ? `（限流重试 ${this.rateLimitMaxAttempts} 次仍失败）`
          : '';
      log.error(`投稿失败（片段 #${clipIndex}）${limitedNote}—— 切片产物已保留，可单独重投`, e);
      this.ledger.setClipStatus(task.id, clipIndex, 'FAILED', { failReason: `投稿失败：${msg}${limitedNote}`, cutOutput: taskOutput });
      this.ledger.logPublish({ taskId: task.id, clipIndex, action: 'fail', error: msg, title: clip.title });
      this.reportClipFailure({
        taskId: task.id,
        taskTitle: task.title,
        clipIndex,
        stage: 'PUBLISHED',
        /* ★ 2026-10-17 QA 复核：这里原来传的是原始错误 `e`，于是「同步抛限流」这一支
           （线上事故那一支）的报告里**一个字都没提重试次数**，与上面 waitUploadTask 那一支
           不一致。统一成 `${msg}${limitedNote}`，报告里也能看到「限流重试 3 次仍失败」。 */
        error: new Error(`${msg}${limitedNote}`),
        type: e instanceof ApiError ? e.type : 'upload-failed',
        cutOutput: taskOutput,
        ...(rateLimitAttempts.length > 0 ? { retries: rateLimitAttempts } : {}),
      });
      return { clipIndex, ok: false, cutTaskId, output: taskOutput, error: { type: 'upload-failed', message: `${msg}${limitedNote}` }, warnings };
    }
  }

  /** 批量处理：场次级串行，逐片提交（§8 WP5 步骤 6） */
  async publishClips(opts: CutAndUploadOptions): Promise<{
    results: CutAndUploadResult[];
    submitted: number;
    skipped: number;
    failed: number;
    /** 每日额度诊断（便于 UI 与测试解释「为什么本批没投」） */
    quota: { todayCount: number; remain: number; requested: number };
    /**
     * 本批**一片都没投出去、且原因是"外部条件没满足"**（今日额度用完）。
     *
     * 为什么要有这个位（QA 2026-10-21 实测）：额度用完时原来只回 `results: []`，
     * 调用方（daemon）拿不到任何信号 ⇒ 本场状态回退成 `ANALYZED`，而切片产物明明都在盘上
     * （界面显示"待分析"，用户点「重新分析」会把已切好的片再切一遍）。
     * 语义与多分P 路径的 `stuck` 一致：**停在"已切片 · 待发布"等条件恢复**，不是失败。
     */
    stuck?: boolean;
    /**
     * 账号受限闸门（2026-10-22）：命中时本批 **0 次提交**，切片原样待投。
     * 与 `stuck` 同时为真 —— 调用方按"已切片·待发布"收，不要当失败。
     */
    quotaBlocked?: QuotaBlockInfo;
  }> {
    const { task } = opts;
    await this.ensureAnchorUid(task);
    const log = this.logger.child({ taskId: task.id, stage: 'PUBLISHING' });
    const all = this.ledger.getClips(task.id);
    const indices =
      opts.indices ??
      all
        .filter((c) => c.selected && (c.status === 'CANDIDATE' || c.status === 'PENDING_UPLOAD' || c.status === 'FAILED'))
        .map((c) => c.index);

    if (indices.length === 0) {
      /* 「重新切片与投稿」点了却"什么都没发生"的实测教训（2026-10-17）：
         对已全部发布的任务重跑，原来只留一句"没有需要投稿的切片（未勾选或已全部处理）"，
         用户看不出是幂等保护还是坏了。按场景说人话：
         · 全部已发布 ⇒ 明说"不会重投、为什么"（防止重复稿件是刻意设计）；
         · 有勾选但状态是 SUBMITTED/SUBMITTING 等 ⇒ 指路 stuckClips 的核对路径；
         · 真没勾选 ⇒ 保持原话。 */
      const sel = all.filter((c) => c.selected);
      const publishedCount = sel.filter((c) => c.status === 'PUBLISHED').length;
      const inFlight = sel.filter((c) => ['SUBMITTED', 'SUBMITTING'].includes(c.status)).length;
      let why: string;
      if (sel.length > 0 && publishedCount === sel.length) {
        why = `本场 ${sel.length} 个切片**已全部发布**，没有需要补投的 —— 已发布的稿件不会被重投（防止 B站 上出现重复稿件）。` +
          `确有一片没在 B站 上时，去「切片库 → 稿件体检」对那一篇点「重新投稿这一片」`;
      } else if (inFlight > 0) {
        why = `没有可投的切片：${inFlight} 个已提交、等待 B站 侧确认（稍后自动反查 bvid）—— 若长时间停在这里，看「监控」页的待办核对`;
      } else {
        why = '没有需要投稿的切片（未勾选或已全部处理）';
      }
      log.info(why);
      return { results: [], submitted: 0, skipped: 0, failed: 0, quota: { todayCount: this.ledger.todayPublishedCount(), remain: -1, requested: 0 } };
    }

    const dryRun = opts.dryRun ?? false;

    /* 账号受限闸门（2026-10-22 用户报「今天 0 次投稿还是被拒」后加）：
       24h 内累计多次配额拒绝 ⇒ 本批 **0 次提交**、切片原样待投。
       为什么放在"每日额度"检查之前：每日额度是我们自己的闸，账号受限是 B站 的闸；
       后者更硬 —— 这时连一次试探都不该发（每次拒绝都在继续给账号扣分）。 */
    if (!dryRun) {
      const guard = this.quotaGuard.status();
      if (guard.blocked && guard.until) {
        log.warn(`${guard.note} —— 本批 0 次提交（切片原样待投；确认 B站 恢复后可手动解除）`);
        return {
          results: [],
          submitted: 0,
          skipped: 0,
          failed: 0,
          quota: { todayCount: this.ledger.todayPublishedCount(), remain: -1, requested: indices.length },
          stuck: true,
          quotaBlocked: { until: guard.until, rejections: guard.rejections, note: guard.note },
        };
      }
    }

    // 每日投稿上限（§8 WP5 步骤 6）。
    // ★ dry-run 只切片、不投稿，因此**不受每日额度限制** ——
    //   否则「先把切片切出来看看」会被额度卡住，而它根本不产生稿件。
    // ★ `dailyLimit === 0` = 用户显式关闭限额，此时整段检查都跳过。
    const quotaOn = this.cfg.publish.dailyLimit > 0;
    let queue = indices;
    if (!dryRun && quotaOn) {
      const today = this.ledger.todayPublishedCount();
      const left = Math.max(0, this.cfg.publish.dailyLimit - today);
      if (left <= 0) {
        log.warn(`今日已投稿 ${today} 个，达到每日上限 ${this.cfg.publish.dailyLimit}，本批暂停（切片产物保留，可明日继续）`);
        return {
          results: [],
          submitted: 0,
          skipped: 0,
          failed: 0,
          quota: { todayCount: today, remain: 0, requested: indices.length },
          /* 一片都没投 + 原因是额度 ⇒ 调用方应按「已切片·待发布」收，不要回退成待分析 */
          stuck: true,
        };
      }
      if (queue.length > left) {
        log.warn(`本批 ${queue.length} 个切片，但今日剩余额度 ${left} 个，只处理前 ${left} 个（其余保留待明日）`);
        queue = queue.slice(0, left);
      }
    } else if (dryRun) {
      log.info(`dry-run：跳过每日投稿额度检查（只切片不投稿，不占用额度）`);
    } else {
      log.info(`每日投稿上限已关闭（publish.dailyLimit=0）：本批 ${queue.length} 个切片全部处理`);
    }
    const todayCount = this.ledger.todayPublishedCount();
    /* remain 用 -1 表示"不限额"（数字型 Infinity 不便展示，且 JSON 会变成 null） */
    const remain = dryRun ? Number.POSITIVE_INFINITY : quotaOn ? Math.max(0, this.cfg.publish.dailyLimit - todayCount) : -1;

    const results: CutAndUploadResult[] = [];
    const submitBase = opts.submitTimeMs ?? Date.now();
    const archives = await this.client.biliArchives({ page: 1, pageSize: 100 }).catch(() => undefined);

    /* 排期口径**一次说清**（不是每片重复一遍）：用户在 config 里改过、但当前模式下不生效的
       那几个键，必须在这里如实点名 —— 否则「改了 clipGapSec 怎么没反应」又要靠猜。 */
    {
      const sched = resolveClipPublishSchedule(this.cfg.publish);
      log.info(`本批切片投稿排期：${sched.note}`);
      const override = describeScheduleOverride(this.cfg.publish);
      if (override) log.info(override);
    }

    /* ★ 切片阶段并发（P0-1，2026-10-13）：**追加切片投稿**模式下这个循环只切片 ——
       cutAndUploadClip 切完就返回（见其内部「已切片，等待与完整版一起投进同一稿件」那条），
       真正的上传发生在后面的 publishMultiPart 里、且保持串行与风控抖动。
       所以这里先把切片**并发**跑掉是安全的：只并行 ffmpeg，不并行投稿。
       ⚠️ 刻意只在「追加」模式放开：单独投稿模式下这个循环**内含上传**，
          并发会绕过 minSubmitIntervalSec 的风控抖动（那条约束就是为投稿频率设的）。
          判据用 resolveClipPublishMode 而不是直接读 multiPart —— 手改 config.json 时
          `clipPublishMode='standalone'` 可能与残留的 `multiPart=true` 并存，那时必须按前者走
          （否则会把"含上传的循环"误判成"只切片的循环"而并发上传）。
       实现上刻意复用同一个 cutAndUploadClip（不是第二套实现），结果按 queue 顺序回填，
       下面的顺序、抖动、额度、自动重试逻辑**一律保持原样**。 */
    const cutK = resolveClipPublishMode(this.cfg.publish) === 'append'
      ? Math.max(
          1,
          Math.min(
            4,
            /* ★ 转写进行中时强制降到 1：本地 Fun-ASR 与 ffmpeg 抢 CPU，
               并发切片会让转写更慢（而转写是出片的关键路径）。信号直接取自台账 ——
               转写阶段会把该场状态置为 TRANSCRIBING，这时任何场次的切片都单线程跑。 */
            this.ledger.listTasks({ limit: 20 }).some((t) => t.status === 'TRANSCRIBING')
              ? 1
              : (this.cfg.clip.concurrency ?? 1),
          ),
        )
      : 1;
    const pre: Array<CutAndUploadResult | undefined> = new Array(queue.length).fill(undefined);
    if (cutK > 1) {
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = cursor++;
          if (i >= queue.length) return;
          const idx = queue[i]!;
          opts.onProgress?.({ current: i, total: queue.length, label: `切片中 ${i}/${queue.length}（并发 ${cutK}）` });
          pre[i] = await this.cutAndUploadClip(
            { ...opts, submitTimeMs: submitBase, clipOrdinal: idx + 1, ...(archives ? { archiveCache: archives } : {}) },
            idx,
          );
        }
      };
      await Promise.all(Array.from({ length: Math.min(cutK, queue.length) }, () => worker()));
    }

    for (let i = 0; i < queue.length; i++) {
      const idx = queue[i]!;
      opts.onProgress?.({ current: i, total: queue.length, label: `切片中 ${i}/${queue.length}` });

      // 提交间隔随机抖动（风控）
      const last = this.ledger.lastSubmitTime();
      if (last && i > 0) {
        const gap = Math.max(0, this.cfg.publish.minSubmitIntervalSec * 1000 + randomInt(0, 30_000) - (Date.now() - last));
        if (gap > 0) {
          log.debug(`投稿间隔抖动：等待 ${Math.round(gap / 1000)} 秒`);
          await sleep(gap);
        }
      }

      /* 并发预切过就直接取结果（避免重复切片）；K=1 时 pre 全为 undefined ⇒ 与历史行为逐字一致 */
      let r =
        pre[i] ??
        (await this.cutAndUploadClip(
          {
            ...opts,
            submitTimeMs: submitBase,
            /* 本场第几片（1 起）——错峰公式的 N，见 CutAndUploadOptions.clipOrdinal。
               用切片下标而不是循环序号 i：重投/断点续投时队列是子集，
               按下标算能保证「后面的片不会排到前面的片之前」。 */
            clipOrdinal: idx + 1,
            ...(archives ? { archiveCache: archives } : {}),
          },
          idx,
        ));
      /* ★ 失败分级自愈（P1-5）：只对**尚未尝试上传**的失败自动重试一次。
         边界很重要：一旦已经发起过上传（error.type === 'upload-failed'），重试就可能导致
         **重复分P** —— 那正是 §40 修过的事故。判据与边界都在 src/failure-class.ts 的 shouldAutoRetry 里。 */
      const verdict = shouldAutoRetry({
        ok: r.ok,
        skipped: r.skipped,
        ...(r.error?.type ? { errorType: r.error.type } : {}),
        ...(r.error?.message ? { message: r.error.message } : {}),
        enabled: this.cfg.publish.autoRetryOnce !== false,
      });
      if (verdict.retry) {
        log.warn(`片段 #${idx} 失败，${describeVerdict(verdict)} —— 20 秒后自动重试一次`);
        await sleep(20_000);
        const retried = await this.cutAndUploadClip(
          {
            ...opts,
            submitTimeMs: submitBase,
            /* 重试必须沿用**同一个** N：否则第二次会排到另一片的位置上（见 clipOrdinal 注释） */
            clipOrdinal: idx + 1,
            ...(archives ? { archiveCache: archives } : {}),
          },
          idx,
        );
        if (retried.ok) {
          log.info(`片段 #${idx} 自动重试成功`);
          retried.warnings.push(`首次失败已自动重试成功（${verdict.why}）`);
        } else {
          log.warn(`片段 #${idx} 自动重试仍失败：${retried.error?.message ?? '未知'}`);
        }
        r = retried;
      }
      results.push(r);
      for (const w of r.warnings) log.debug(`片段 #${idx}：${w}`);

      /* ★ 配额级限流 ⇒ **本轮立即收手**（2026-10-21 事故）。
         为什么不能"继续投下一片"：配额是**账号级**的，后面的片现在投也只会挨同一句拒绝 ——
         事故里 #4/#5/#6 就是这么一片不落地全撞死，三次拒绝除了把日志写花没有任何用处，
         还把本来"等 30 分钟就能投"的切片写成了 FAILED。
         这里不改任何切片状态：没投的片保持 CANDIDATE/PENDING_UPLOAD（就是"待投"），
         切片产物也在，等配额恢复后重跑投稿阶段即可。 */
      if (r.quotaLimited) {
        const doneOk = results.filter((x) => x.ok && !x.skipped).length;
        /* ⚠️ 用 `indices`（**未被每日额度截断**的原始队列）而不是 `queue`（QA 2026-10-21 实测）：
           dailyLimit 小于勾选数时 `queue` 是前缀，拿它算剩余会把"因额度没轮到的那几片"漏掉 ——
           告警就会少报（实测 dailyLimit=2、3 片、首片被拒 ⇒ 报"剩余 1 片"，真实待投 2 片）。 */
        const remaining = indices.length - (i + 1);
        if (remaining > 0) {
          log.warn(
            `因配额限流暂停本轮投稿，剩余 ${remaining} 片待投（本批已成功 ${doneOk} 片）` +
              `—— 建议 ${r.quotaLimited.retryAfterMin} 分钟后重试；现在继续投只会被同一句限流拒绝`,
          );
        }
        await this.alertQuotaLimited({
          task,
          submitted: doneOk,
          remaining,
          reason: r.quotaLimited.message,
        });
        break;
      }
    }
    opts.onProgress?.({ current: queue.length, total: queue.length, label: '投稿完成' });

    const submitted = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.ok).length;
    log.info(`本批投稿结束：成功 ${submitted}，跳过 ${skipped}，失败 ${failed}`);
    return { results, submitted, skipped, failed, quota: { todayCount, remain, requested: indices.length } };
  }

  /* ------------------------------------------------------------------------
   * 任务轮询
   * ---------------------------------------------------------------------- */

  /** 轮询 `GET /task/:id` 直到 completed / error，返回最终任务对象 */
  async waitTask(
    taskId: string,
    opts: { timeoutSec: number; intervalMs?: number; signal?: AbortSignal; onPoll?: (d: { status?: string }) => void },
  ): Promise<{ status?: string; output?: string; error?: string; raw: unknown }> {
    const deadline = Date.now() + opts.timeoutSec * 1000;
    const interval = opts.intervalMs ?? 3000;
    let last: { status?: string; output?: string; error?: string; raw: unknown } = {
      raw: undefined,
      status: 'pending',
    };
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('任务轮询被取消');
      try {
        const d = await this.client.taskDetail(taskId);
        last = {
          status: d.status,
          ...(typeof d.output === 'string' ? { output: d.output } : {}),
          ...(typeof d.error === 'string' ? { error: d.error } : {}),
          raw: d,
        };
        opts.onPoll?.({ ...(d.status ? { status: d.status } : {}) });
        if (d.status === 'completed') return last;
        if (d.status === 'error') {
          throw new Error(`biliLive-tools 任务失败：${d.error ?? '（对方未提供错误信息，请看 /common/getLogContent 的日志片段）'}`);
        }
      } catch (e) {
        // 任务查询本身失败（网络抖动）不立即放弃，继续轮询到超时
        if (e instanceof Error && e.message.startsWith('biliLive-tools 任务失败')) throw e;
      }
      await sleep(interval);
    }
    throw new Error(`任务 ${taskId} 在 ${opts.timeoutSec} 秒内未完成（最后状态：${last.status ?? 'unknown'}）`);
  }

  /* ------------------------------------------------------------------------
   * 多分P投稿：完整版 + 纯享版 + 各切片 → 同一个稿件
   * ---------------------------------------------------------------------- */

  /**
   * 把「完整版 + 纯享版 + 各切片」投进**同一个稿件的多个分P**。
   *
   * 结构为 `2 + N` 个分P：
   *   P1 完整版（烧弹幕）· P2 纯享版（无弹幕原片）· P3…P(2+N) 各切片
   *
   * 为什么这么做：**省每日投稿额度** —— 一次调用只占 1 个额度，
   * 而「每片一稿」模式下 6 个切片要占 6 个。
   *
   * 代价（必须知道）：多P稿件只有一个 `dtime`，**所有分P同一时刻上线**，
   * 原来的「相邻切片错峰」在这种模式下不生效。
   *
   * 幂等：投稿前按**主标题**反查 `/bili/archives`，已存在则直接跳过。
   */
  async publishAsMultiPart(opts: {
    task: TaskRecord;
    uid: number | string;
    /** 参与投稿的切片（按分P顺序，通常是选中的那些） */
    clips: ClipRecord[];
    /** 完整版（P1）；不存在则从 P2 开始 */
    fullVideoPath?: string;
    /** 纯享版（P2，无弹幕原片）；不存在则省略该分P */
    pureVideoPath?: string;
    /** 覆盖主标题 */
    mainTitleOverride?: string;
    /** 覆盖分P标题 [{path,title}] */
    partTitlesOverride?: Array<{ path: string; title?: string }>;
    /** 续传目标稿件已有多少个分P（让追加切片的标题序号接在后面，仅在续传模式生效） */
    clipIndexBase?: number;
    /**
     * **续传目标稿件 aid**（biliLive-tools 已投完整版+纯享版的那个稿件）。
     *
     * 给了它就调 `/bili/upload` 带 `vid`，走 `editMedia` 追加分P
     * （biliLive-tools 的原文：「续传只会增加分p，不会对稿件进行编辑」）；
     * 不给则走 `addMedia` 新建稿件。
     *
     * ⚠️ 续传模式下**不再投完整版/纯享版**：那两P由 biliLive-tools 自己投，
     * 再投一遍就是同一个视频出现两次。
     */
    resumeAid?: string;
    /**
     * 续传目标稿件的 **bvid**（有就写进切片的台账）。
     *
     * 为什么必须写：切片追加进已有稿件后，它们就是那个稿件的**分P** —— 同 bvid、不同 cid。
     * 若不写，切片会一直停在 `SUBMITTED` 且没有 bvid：
     *   ① 周期性 bvid 反查是**按稿件标题**找的，而分P 标题不是稿件标题 → 永远查不到；
     *   ② 于是本场永远到不了 PUBLISHED，`cleanup.deleteAfterUpload`（用完即删）也就永远不触发
     *      —— 实测：一场 20 GB 的录播会一直躺在盘上。
     * 这个 bvid 不是猜出来的：它就是用户/标题匹配确认过的那个目标稿件。
     */
    resumeBvid?: string;
    dryRun?: boolean;
    signal?: AbortSignal;
    logger?: Logger;
  }): Promise<{
    ok: boolean;
    uploadTaskId?: string;
    mainTitle: string;
    parts: Array<{ path: string; title: string; kind: 'full' | 'pure' | 'clip'; clipIndex?: number }>;
    dtime?: number;
    skipped?: string;
    error?: string;
    warnings: string[];
    /** 本次是「续传到已有稿件」还是「新建稿件」 */
    mode?: 'append' | 'create';
    /**
     * 续传**已提交但未在确认窗口内看到落地**。
     *
     * 不是失败：B站 分P 列表有延迟（实测可达 20 分钟），发布流程不可能等那么久。
     * 调用方据此应把它当"待确认"而不是"已确认成功"。
     */
    appendUnconfirmed?: boolean;
    /**
     * 命中「账号级投稿配额限流」（2026-10-21）。
     *
     * ⚠️ **调用方必须透传这个标记**（曾经漏了，QA 2026-10-21 实测）：`publishMultiPartStage`
     * 只看 `ok === false` 就会把它当普通失败 —— 于是 ① 本场状态回退成 ANALYZED（切片明明还在
     * 待投，界面显示"待分析"，用户点「重新分析」会把已切好的片再切一遍）；② 对每条结果补发
     * 「投稿失败」error 告警，与 Publisher 已发的 warn（"等 30 分钟"）自相矛盾。
     */
    quotaLimited?: QuotaLimitedInfo;
  }> {
    const cfg = this.cfg;
    const log = (opts.logger ?? this.logger).child({ taskId: opts.task.id, mod: 'multipart' });
    const warnings: string[] = [];
    const { task, uid, clips } = opts;
    await this.ensureAnchorUid(task);

    // 先拉一次稿件列表：既用于「推断主播名」（分P标题要用），也用于随后的幂等反查。
    // 只查一次，避免重复请求。
    let archivesForName: ArchiveItem[] = [];
    try {
      archivesForName = await this.client.biliArchives({ page: 1, pageSize: 100 });
    } catch (e) {
      warnings.push(`读取已投稿件列表失败（不影响投稿，但分P标题可能缺少主播名）：${(e as Error).message.slice(0, 80)}`);
    }

    /* ---- 1. 组装分P ---- */
    // 完整版 / 纯享版的标题沿用 **biliLive-tools 的命名规则**（{{user}}{{title}}{{index}}{{hasDanmaStr}}），
    // 与它自己上传的完整版保持一致；切片则用 **LLM 自动生成的标题**。
    const anchorName = guessAnchorName(archivesForName, cleanLiveTitle(task.title));
    const liveTitleForPart = cleanLiveTitle(task.title);
    const partTitleOf = (kind: 'full' | 'pure', index: number): string => {
      const auto = biliPartTitle({
        user: anchorName,
        title: liveTitleForPart,
        index,
        withDanmaku: kind === 'full',
      });
      // 拿不到主播名时退回配置里的中文占位名（总比空着或纯标题好）
      if (!anchorName) {
        return kind === 'full'
          ? `${cfg.publish.fullPartTitle || '完整版'}${index ? ` ${index}` : ''}`
          : `${cfg.publish.purePartTitle || '纯享版（无弹幕）'}${index ? ` ${index}` : ''}`;
      }
      return auto;
    };

    const parts: Array<{ path: string; title: string; kind: 'full' | 'pure' | 'clip'; clipIndex?: number }> = [];
    /* 续传模式：目标稿件里的完整版分P 由 biliLive-tools 投过了，这里只追加切片 */
    const resumeAid = (opts.resumeAid ?? '').trim();
    if (resumeAid) {
      /* 不放"追加 N 个分P"这种数字：此刻还不知道有几个候选真能投
         （可能有切片没产出文件、或被每日额度截断）。
         实测踩过：这里写"只追加 14 个切片分P"，实际只追加了 9 个，日志自相矛盾。
         下面 titled 定稿后再补一条带**实际数量**的说明。 */
      warnings.push(
        `续传到已有稿件 aid=${resumeAid}：只追加切片分P，不投完整版/纯享版（那些分P由 biliLive-tools 投）。` +
          `biliLive-tools 的 editMedia(append) 会保留原分P、且把稿件原有的标题/简介/标签原样提交，` +
          `所以稿件信息不会被改；新分P排在最后，因为是追加到已发布的稿件上，**立即生效**（dtime 不适用）`,
      );
      log.info(`续传模式：往稿件 aid=${resumeAid} 追加切片分P（跳过完整版/纯享版）`);
    }
    const fullPath = opts.fullVideoPath ?? task.source.fullVideoPath;
    if (!resumeAid) {
      if (fullPath && exists(fullPath)) {
        parts.push({ path: fullPath, title: partTitleOf('full', 1), kind: 'full' });
      } else {
        warnings.push('没有完整版文件，该稿件将不含「完整版」分P');
      }
      if (opts.pureVideoPath && exists(opts.pureVideoPath)) {
        parts.push({ path: opts.pureVideoPath, title: partTitleOf('pure', 2), kind: 'pure' });
      }
    }
    /* 续传模式下**不给切片标题加 `P{n}` 前缀**。
       原因：目标稿件已有多少个分P由 biliLive-tools 决定，而它是**动态**的 ——
       `SAME_MEDIA_UPLOAD_ORDER = ["handled","raw"]` 意味着「弹幕版全部在前、纯享版在后」，
       所以一场分 Z 段就有 2Z 个分P（4 段 → 8: 弹幕1-4 / 纯享1-4）。
       写死序号必然错位（切片实际落在 P9，标题却写 P3）。
       B站 分P列表本身会标出位置序号，标题里不必再重复一次。 */
    if (!resumeAid && opts.clipIndexBase !== undefined && opts.clipIndexBase > 0) {
      warnings.push(`clipIndexBase=${opts.clipIndexBase} 在新建稿件模式下不生效（仅续传模式曾有偏移语义，现已弃用）`);
    }

    const sortedClips = [...clips].sort((a, b) => a.start - b.start);
    for (const c of sortedClips) {
      const file = c.cutOutput;
      if (!file || !exists(file)) {
        warnings.push(`切片 #${c.index} 没有可用的产出文件（${file ?? '未切片'}），已从分P中排除`);
        continue;
      }
      const idx = parts.length + 1;
      // 切片产物文件名里带 `01-000011-` 这类「序号-起始时间」前缀（便于在磁盘上辨认），
      // 但分P标题不能带它 —— 观众看到的是纯标题。
      const cleanTitle = sanitizeTitle(c.title, 72).title.replace(/^\d{1,3}[-_]\d{4,8}[-_]/, '');
      // 分P 标题走模板（默认 `P{n} {title}`，与历史行为一致；不再硬编码）
      /* ★ 续传模式（resumeAid）下**一律不加 `P{n}` 前缀**：目标稿件已有几个分P 是动态的
         （biliLive-tools 按 `["handled","raw"]` 分组投，一场 Z 段 ⇒ 2Z 个分P），
         写死序号必然与实际位置错位。B站 分P列表自带位置序号，标题里重复一次只会误导。 */
      if (resumeAid) {
        /* 模板里的 `{n}` 同理是未知量：把模板按「无序号」语义渲染（把 {n} 替换成空） */
        const tplNoIndex = cfg.publish.partTitleTemplate.replace(/\{n\}/g, '').replace(/\s{2,}/g, ' ').trim();
        const title = tplNoIndex
          ? renderPartTitle(tplNoIndex, {
              n: 0,
              title: cleanTitle,
              anchor: anchorName,
              date: taskDateText(task),
              kind: '切片',
            })
          : cleanTitle;
        parts.push({ path: file, title, kind: 'clip', clipIndex: c.index });
        continue;
      }
      const title = cfg.publish.partTitleTemplate
        ? renderPartTitle(cfg.publish.partTitleTemplate, {
            n: idx,
            title: cleanTitle,
            anchor: anchorName,
            date: taskDateText(task),
            kind: '切片',
          })
        : cfg.publish.partTitleWithIndex
          ? `P${idx} ${cleanTitle}`
          : cleanTitle;
      parts.push({ path: file, title, kind: 'clip', clipIndex: c.index });
    }

    // 切片补序号前缀（完整版/纯享版已由 biliPartTitle 带好序号，不重复加）
    // ★ 续传模式跳过这一步：序号未知，不写。
    const titledAll = resumeAid
      ? parts
      : parts.map((p, i) => ({
          ...p,
          title:
            cfg.publish.partTitleWithIndex && p.kind === 'clip' && !/^P\d+\s/.test(p.title)
              ? `P${i + 1} ${p.title}`
              : p.title,
        }));

    /* ★★ 续传去重：只投目标稿件里**还没有**的切片。
       为什么必须有这一步（实测事故）：
         首批被截断成 9 个并已追加成功后，重跑时项目把 14 个候选**整批**又投了一遍
         —— 其中 9 个已经在稿件里了。于是在同一个稿件里留下了 9 组内容重复的分P。
       ⚠️ 归因修正（本机实测，别再被误导）：当时把现象解释成"B站 对含重复分P 的整批编辑
       会静默丢弃"，三条证据（分P 数不变、任务 completed、重查列表依旧）都指向它。
       但那是**错的**：B站 分P 列表有约 20 分钟延迟，在延迟窗口内查询必然看不到新分P。
       用带轮询的确认逻辑复测后，那 4 批追加全部成功落地。真实代价不是"投稿被吞"，
       而是"重复分P 留在了稿件里"—— 所以去重仍然必需，只是理由不同。
       所以：先查目标稿件已有的分P 标题，把标题相同的排除掉；一个都不剩就不投。 */
    let titled = titledAll;
    const beforeAll = titled.length;

    /* ★★ 墓碑拦截 —— **不分模式**（续传 / 新建稿件都要查）。
     *
     * 为什么必须在新建稿件模式下也查：
     *   用户删掉一整场任务（含已发布的稿件记录）后，素材往往还在 `import.watch.dirs` 里，
     *   于是被重新导入 → 重新转写/分析 → `publishAsMultiPart` 走的是**新建稿件**分支
     *   （此时 resumeAid 为空，上面那段 `if (resumeAid)` 的指纹去重根本不执行）。
     *   唯一还能拦一下的只剩「按主标题反查 B站」—— 而主标题来自模板，重跑时通常一致，
     *   看似够用，实则依赖 `verifyArchiveMatch` 的一串启发式（要排除完整版录播、
     *   要比创建时间、标题还可能被 sanitize 截断），任何一条不满足就静默放行。
     *   本地墓碑是确定性判据，成本几乎为零，所以对两种模式一视同仁。
     *
     * 与「指纹去重」的区别：那个查的是**台账里仍然生效**的指纹（同一场重跑），
     * 这个查的是**已退役的**指纹（任务被删过，但内容确实投出去过）。 */
    {
      const blocked: string[] = [];
      titled = titled.filter((p) => {
        if (p.kind !== 'clip' || p.clipIndex === undefined) return true;
        const c = this.ledger.getClip(task.id, p.clipIndex);
        if (!c) return true;
        const fp =
          c.fingerprint ??
          clipFingerprint({ sourceVideoId: task.recordingId ?? task.id, start: c.start, end: c.end, title: c.title });
        const tomb = this.ledger.findTombstone(fp);
        if (!tomb) return true;
        blocked.push(
          `#${p.clipIndex}「${c.title}」（${tomb.bvid ? `bvid=${tomb.bvid}` : 'bvid 未反查'}，` +
            `原任务 ${tomb.taskId} 已于 ${tomb.retiredAt} 删除）`,
        );
        /* 状态同步成"已投"而不是"失败"：它确实投过，只是记录随任务一起被删了。
           同时打上 blockedByTombstone 标记，UI 才能解释「为什么这一片没进稿件」。 */
        this.ledger.setClipStatus(task.id, p.clipIndex, tomb.bvid ? 'PUBLISHED' : 'SUBMITTED', {
          fingerprint: fp,
          ...(tomb.bvid ? { bvid: tomb.bvid } : {}),
          blockedByTombstone: fp,
        });
        return false;
      });
      if (blocked.length > 0) {
        const note =
          `墓碑拦截：${blocked.length} 个切片的内容**以前已经投过 B站**（那些任务已被删除），` +
          `已跳过以免产生重复稿件 —— ${blocked.join('、')}。` +
          `若对应稿件确实已不存在，请在界面上解除墓碑后重跑`;
        warnings.push(note);
        log.warn(note);
      }
    }

    /* ★★ 续传二次去重：**指纹级** —— 标题去重拦不住"同一内容换个标题"。
     *
     * 为什么标题够不着（真实缺口）：
     *   指纹 clipFingerprint = hash(源视频 | 起止时间 | 标题归一化)。同一个录制区间、
     *   同一个标题 → 同一个指纹，跨任务、跨天都稳定。而标题是 LLM 每次重新生成的，
     *   同场重跑极易换措辞（"主播收到飞机礼物当场模仿起飞音效" ↦ "飞机礼物让主播当场起飞"），
     *   标题去重于是整条穿透，同一段画面被第二次追加进同一个稿件。
     *
     * 而且指纹此前只在 `cutAndUploadClip`（单切片投稿路径）里被 findFingerprint 查过，
     * 多分P路径 publishAsMultiPart **只 register 不 find** —— 查了也没用：走到这里时
     * `cutAndUploadClip` 早已把指纹写进台账，重复判定的窗口只存在于此。
     * 所以把检查放在这一处（唯一的上传点），两条路径都受益。
     */
    if (resumeAid) {
      const dupFp: string[] = [];
      titled = titled.filter((p) => {
        if (p.kind !== 'clip' || p.clipIndex === undefined) return true;
        const c = this.ledger.getClip(task.id, p.clipIndex);
        if (!c) return true;
        const fp =
          c.fingerprint ??
          clipFingerprint({ sourceVideoId: task.recordingId ?? task.id, start: c.start, end: c.end, title: c.title });
        const known = this.ledger.findFingerprint(fp);
        if (!known) return true;
        dupFp.push(`#${p.clipIndex}（已于 ${known.at} 投过${known.bvid ? ` ${known.bvid}` : ''}）`);
        // 台账状态同步成"已投"：否则 UI 会一直显示"待投稿"，下次重跑还会再算一遍
        this.ledger.setClipStatus(task.id, p.clipIndex, known.bvid ? 'PUBLISHED' : 'SUBMITTED', {
          fingerprint: fp,
          ...(known.bvid ? { bvid: known.bvid } : {}),
        });
        return false;
      });
      if (dupFp.length > 0) {
        warnings.push(`指纹去重：${dupFp.length} 个切片的内容指纹已存在（同一录制区间 + 同一标题），已跳过，不重复追加`);
        log.info(`指纹去重：跳过 ${dupFp.length} 个已投切片 —— ${dupFp.join('、')}`);
      }
    }

    /* 目标稿件 aid（model-b）里已有的分P 标题，是比指纹更弱的一层兜底：
       它能拦住"换个标题但旧标题还在列表里"的情况（比如分P列表还没刷新完就重跑）。 */
    if (resumeAid) {
      /* 去重必须看**最新**的分P 列表：若命中缓存读到追加前的旧快照，
         就会以为目标稿件还是空的，把已经投过的切片再投一遍（这正是要防的事）。 */
      const existing = await this.fetchExistingPartTitles(resumeAid, log, { fresh: true });
      if (existing) {
        const norm = (s: string): string => s.replace(/\s+/g, '').trim();
        const have = new Set([...existing].map(norm));
        const before = beforeAll;
        titled = titled.filter((p) => !have.has(norm(p.title)));
        const dup = before - titled.length;
        if (dup > 0) {
          warnings.push(`续传去重：目标稿件里已有 ${dup} 个标题相同的分P，已跳过，只投新增的 ${titled.length} 个`);
          log.info(`续传去重：跳过 ${dup} 个已存在的分P，本次只投 ${titled.length} 个新增切片`);
        }
        if (titled.length === 0) {
          const note = `目标稿件 aid=${resumeAid} 已包含本场全部 ${before} 个切片分P，无需重复投稿`;
          log.info(note);
          return { ok: true, skipped: note, mainTitle: '', parts: [], warnings, mode: 'append' };
        }
      }
    }

    if (titled.length === 0) {
      /* beforeAll > 0 ⇒ 候选都在、只是全被判重 ⇒ 这是**成功且无需投稿**，不是失败。
         返回 ok:true + skipped：调用方（publishMultiPartStage）据此填 submitted=0、
         skipped=选中数，不会把整批切片误标 FAILED，也不会谎报"投了 N 个"。 */
      if (beforeAll > 0) {
        const note = `本场 ${beforeAll} 个候选分P 全部已投过（指纹或标题命中），无需重复投稿`;
        log.info(note);
        return { ok: true, skipped: note, mainTitle: '', parts: [], warnings };
      }
      const msg = '没有任何可投稿的文件（完整版与切片都不可用）';
      log.error(msg);
      return { ok: false, mainTitle: '', parts: [], error: msg, warnings };
    }

    /* 续传模式补一条**带实际数量**的说明。
       数量只算切片（kind==='clip'），并把"候选里有几个没产出文件"如实说清 ——
       候选数 ≠ 可投数（切片可能失败、也可能被每日额度截断）。 */
    if (resumeAid) {
      const clipParts = titled.filter((p) => p.kind === 'clip').length;
      const missing = Math.max(0, clips.length - clipParts);
      warnings.push(
        `续传稿件 aid=${resumeAid}：本次实际追加 **${clipParts}** 个切片分P` +
          (missing > 0
            ? `（本场共 ${clips.length} 个候选，其中 ${missing} 个没有可用切片产物 —— 多为「每日额度只够处理前 N 个」，其余保留待后续）`
            : ''),
      );
    }

    /* ---- 2. 主标题：直播原标题 + 日期 ---- */
    // ⚠️ 日期必须取**真实录制日**：手动导入的任务没有 liveStartTime（会被兜底成今天），
    //    而录制器写在标题里的日期是可靠的 —— 用 taskDateText 统一处理（实测差过 2 天）。
    const dateText = taskDateText(task);
    const liveTitle = cleanLiveTitle(task.title);
    const mainTitle = sanitizeTitle(
      opts.mainTitleOverride ?? (liveTitle.includes(dateText) ? liveTitle : `${liveTitle} ${dateText}`),
      80,
    ).title;

    /* ---- 2b. 标题体检（主标题 + 每个分P标题）----
     * 分P 标题也显示在观众那侧，同样要过一遍。**只报警不阻断**：
     * 多分P 是"一次投出全部"的形态，因为一条标题不合格而整体不投，代价更大；
     * 真正需要阻断的场景（半自动模式的 approve）在 server.ts 里做硬校验。 */
    {
      const glossary = this.glossaryForCheck();
      const mainCheck = checkTitle(mainTitle, { glossary });
      for (const p of mainCheck.problems) {
        warnings.push(`[标题·主标题${p.level === 'error' ? '必须修' : '建议'}] ${p.message}${p.fix ? `（${p.fix}）` : ''}`);
      }
      const partReports = checkClipTitles(
        titled.map((p, i) => ({ index: i, title: p.title })),
        { glossary },
      );
      for (const e of partReports.errors) {
        warnings.push(`[标题·分P${e.index + 1} 必须修] ${e.problem.message}${e.problem.fix ? `（${e.problem.fix}）` : ''}`);
      }
      for (const w of partReports.warnings) {
        warnings.push(`[标题·分P${w.index + 1} 建议] ${w.problem.message}`);
      }
      const titleIssues = mainCheck.problems.length + partReports.errors.length + partReports.warnings.length;
      if (titleIssues > 0) log.warn(`标题体检：${titleIssues} 项问题（${summarizeTitleIssues(partReports)}）`);
    }

    /* ---- 2c. 重复投稿提醒（不阻断，只提示）----
     * 实测这场的切片被投了 3 次（五次单投 + 两次多分P）。多分P 路径原先不判断
     * "本场是否已经投过"，所以这里至少要说出来，让人有机会在提交前停手。 */
    {
      const known = readPublishLogRows().filter((r) => r['taskId'] === task.id && r['action'] === 'submit');
      const uploadIds = [...new Set(known.map((r) => String(r['uploadTaskId'] ?? '')).filter(Boolean))];
      if (uploadIds.length > 0) {
        const last = known[known.length - 1];
        const at = typeof last?.['at'] === 'string' ? new Date(last['at']).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
        warnings.push(
          `本场已有 ${uploadIds.length} 次投稿记录（最近一次 ${at}）；本次将再投一次 —— ` +
            `若上一次其实已经成功，B站 上会出现重复稿件，请先在创作中心核对`,
        );
      }
    }

    /* ---- 3. 幂等：按主标题反查（⚠️ 必须排除完整版录播）----
     *
     * 实测踩过的坑：多分P 切片稿件的主标题 = 「直播标题 + 日期」，
     * 而**完整版录播稿件的标题一模一样**（同一个模板），于是按主标题反查必然命中完整版，
     * 结果：a) 误判"已投过"直接跳过；b) 把完整版的 bvid 写到了每个切片上。
     * 所以这里必须用 `fullVideoTitleCandidates` 把完整版排除掉，
     * 且要求命中的稿件创建时间晚于本场录制结束（否则同样是历史稿件）。 */
    const archives = archivesForName;
    const fullTitles = fullVideoTitleCandidates(task);
    const dupCandidates = matchArchive(archives, mainTitle, {
      ...(task.recordEndTime ? { sinceMs: task.recordEndTime - 3600_000 } : {}),
    }).filter((m) => m.exact);
    const dup = dupCandidates.find(
      (m) =>
        verifyArchiveMatch(m, mainTitle, {
          ...(task.recordEndTime ? { submitTimeMs: task.recordEndTime } : {}),
          fullVideoTitles: fullTitles,
        }).ok,
    );
    if (dupCandidates.length > 0 && !dup) {
      // 命中了但全都不可信 —— 大声说出来，别静默跳过（静默跳过 = 少投一稿，静默采纳 = 写错 bvid）
      const reasons = dupCandidates
        .map((m) => `${m.bvid}(${m.title ?? '无标题'}): ${verifyArchiveMatch(m, mainTitle, { fullVideoTitles: fullTitles }).reason ?? '通过'}`)
        .join('；');
      warnings.push(
        `按主标题反查到 ${dupCandidates.length} 条同名稿件，但都不可信（多为完整版录播）→ **不跳过**，继续投稿。命中详情：${reasons}`,
      );
      log.warn(warnings[warnings.length - 1]!);
    }
    if (dup) {
      const note = `已有同名稿件（bvid=${dup.bvid}），跳过投稿以避免重复`;
      log.warn(note);
      for (const p of titled) {
        if (p.kind === 'clip' && p.clipIndex !== undefined) {
          this.ledger.setClipStatus(task.id, p.clipIndex, 'PUBLISHED', { bvid: dup.bvid, publishedAt: nowIso() });
        }
      }
      this.ledger.rememberPublishedTitle(mainTitle);
      return { ok: true, skipped: note, mainTitle, parts: titled, warnings };
    }

    /* ---- 4. dtime（多P稿件只有一个发布时间）----
       注意：多P 模式下**所有分P 共用这一个 dtime**，所以「相邻切片间隔 clipGapSec」
       在这里根本不生效（一场直播只有一次发布时刻）。要每片各按 5 分钟错峰，
       必须用「单独投稿」（clipPublishMode='standalone' / multiPart=false）。 */
    const submitTimeMs = Date.now();
    const immediate = cfg.publish.immediatePublish === true;
    /* 立即发布时**根本没有 dtime 这个字段**。
       早先这里用「提交时刻」当占位值返回，结果日志写成「定时发布 <刚提交的时间>」，
       读起来像排期错乱（实测误导过一次排查）。所以立即发布时干脆不产出这个值，
       由调用方按 undefined 走「立即发布」文案。 */
    let dtime = immediate
      ? undefined
      : computeDtime(submitTimeMs, 1, {
          submitGapSec: cfg.publish.submitGapSec,
          clipGapSec: cfg.publish.clipGapSec,
          jitterSec: cfg.publish.jitterSec,
        });

    /* ---- 5. 投稿配置 ---- */
    /* 封面（P2）：coverFrom='frame' 时从**本场评分最高的切片**抽一帧当封面。
       候选与输出路径由调用方给（resolveCover 保持纯计算）；抽帧输出放在切片产物同目录，
       没有可用产物就不传 frameOutPath ⇒ resolveCover 会记一条原因并回退老路径（不抛错）。 */
    const coverCandidateClips = sortedClips.map((c) => ({
      index: c.index,
      ...(c.score !== undefined ? { score: c.score } : {}),
      ...(c.cutOutput ? { cutOutput: c.cutOutput } : {}),
      ...(c.status ? { status: c.status } : {}),
    }));
    const firstCutDir = sortedClips.find((c) => c.cutOutput)?.cutOutput;
    const coverRes = resolveCover(
      this.cfg,
      {
        frameCandidates: coverCandidateClips,
        ...(firstCutDir ? { frameOutPath: `${path.dirname(firstCutDir)}${path.sep}cover-frame.jpg` } : {}),
      },
      log,
    );
    const firstClip = sortedClips[0];
    // 简介要**精简**：B站上限 250 字符，把每个分P名字都列上必然超限被截断。
    // 只列分P序号与时间点，名称交给分P标题本身。
    const clipLines = sortedClips.map(
      (c, i) => `P${i + (fullPath ? 3 : 2)} ${fmtDuration(c.start)}-${fmtDuration(c.end)} ${sanitizeTitle(c.title, 24).title}`,
    );
    const descBody = [
      `${cleanLiveTitle(task.title)} · 共 ${titled.length} 个分P`,
      fullPath ? 'P1 完整版 / P2 纯享版' : '',
      clipLines.join('\n'),
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 240);
    const fakeClip: ClipRecord =
      firstClip ??
      ({
        index: 0,
        start: 0,
        end: task.source.totalDuration,
        title: mainTitle,
        desc: descBody,
        tags: cfg.publish.defaultTags,
        category: cfg.publish.defaultCategory,
        score: 10,
        reason: '完整版',
        selected: true,
        status: 'PENDING_UPLOAD',
        degraded: false,
      } as ClipRecord);

    /* 提交前复核（硬约束 #4）：dtime 是**本函数开头**算的，而真正调接口是在这里 ——
       大文件上传可能耗时几十分钟，靠后的分P 会被挤到「提交后不足 1200 秒」而被拒稿。
       多P 稿件只有一个发布时刻，所以这里只核一次。 */
    if (!immediate && dtime !== undefined) {
      const gate = clampDtimeForSubmit(dtime, Date.now());
      if (gate.bumped) {
        warnings.push(gate.note);
        log.warn(`多P稿件发布时间被合规修正：${gate.note}`);
      }
      dtime = gate.dtime;
    }

    const { config: biliConfig, warnings: cfgWarnings } = buildBiliupConfig({
      clip: fakeClip,
      task,
      cfg,
      uid,
      dtime: dtime ?? Math.floor(submitTimeMs / 1000),
      uploadPresetId: cfg.publish.uploadPresetId,
      ...(coverRes.cover ? { cover: coverRes.cover } : {}),
      overrideTitle: mainTitle,
      overrideDesc: descBody,
      isFullVideo: true,
      immediate,
    });
    warnings.push(...cfgWarnings);
    biliConfig['title'] = mainTitle;

    if (opts.dryRun) {
      const note = immediate
        ? `dry-run：本应投 1 个稿件 / ${titled.length} 个分P（**立即发布**，不传 dtime）`
        : `dry-run：本应投 1 个稿件 / ${titled.length} 个分P（定时 ${fmtLocal((dtime ?? 0) * 1000)}）`;
      log.info(note, { data: { parts: titled.map((p) => p.title) } });
      return { ok: true, skipped: note, mainTitle, parts: titled, ...(dtime !== undefined ? { dtime } : {}), warnings };
    }

    /* ---- 6. 提交（所有分P一次投出）---- */
    const videos = titled.map((p) => ({ path: p.path, title: p.title }));
    for (const p of titled) {
      if (p.kind === 'clip' && p.clipIndex !== undefined) {
        this.ledger.setClipStatus(task.id, p.clipIndex, 'SUBMITTING', {});
      }
    }
    /* 限流重试计数**提到 try 外面**：catch 里的 failReason 也要写清"重试过几次" */
    let multipartLimitedRetries = 0;
    /** 每次"被限流拒绝"的记录，随错误报告落盘（人工据此判断是否值得重投） */
    const multipartRateLimitAttempts: RetryAttempt[] = [];
    try {
      /* ---- 提交（含「限流」安全重试）----
         B站 的「您投稿的频率过快，请稍等2秒」= **提交被拒**（稿件/分P 都没创建），
         等几秒重交是安全的（2026-10-17 线上事故，见文件顶部 UPLOAD_RATE_LIMIT_* 说明）。
         ★ 追加分P（resumeAid 已知）额外守一道：重试前先 fresh 核对目标稿件的分P 标题 ——
           已在 ⇒ 视为已落地、**绝不再投**（重复分P 是本项目最不能犯的错）；查不到 ⇒ 不重试。 */
      let res: BiliUploadResponse | undefined;
      let lastLimitedMsg = '';
      let alreadyLanded = false;
      let st0Status: string | undefined;
      let st0Error: string | undefined;
      let stateText = '';
      for (let attempt = 1; attempt <= this.rateLimitMaxAttempts; attempt++) {
        try {
          res = await this.submitUpload(
            {
              uid,
              videos,
              config: biliConfig,
              /* ★ 有续传目标就带 vid：biliLive-tools 收到 vid 走 editMedia（追加分P），
                 没有则走 addMedia（新建稿件）。这一行就是「切片接进 biliLive-tools 那个稿件」的关键。 */
              ...(resumeAid ? { vid: resumeAid } : {}),
            },
            log,
            `${resumeAid ? '续传追加' : '新建稿件'} ${videos.length} 个分P`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const limitKind = classifySubmitLimit(msg);
          /* ★ 配额级限流（`投稿过于频繁，请稍后再试`）⇒ **不重试**，直接抛给外层按「待投」收尾。
             顺序必须在 `isUploadRateLimited` 之前：那句措辞现在两边都算"限流"，
             若先走秒级分支就会连撞 3 次（10-21 事故的形态）。 */
          if (limitKind === 'quota') throw e;
          if (limitKind !== 'short') throw e;
          lastLimitedMsg = msg;
          multipartRateLimitAttempts.push({ attempt, at: nowIso(), type: 'upload-failed', message: msg });
          if (attempt >= this.rateLimitMaxAttempts) throw e;
          const probe = resumeAid
            ? await this.probeAppendLanded(resumeAid, titled.map((p) => p.title), log)
            : 'absent';
          if (probe === 'landed') {
            alreadyLanded = true;
            multipartLimitedRetries += 1;
            break;
          }
          /* 查不到分P 列表 / 只落了一部分 ⇒ 不重试（重复分P 的代价远大于重投一次） */
          if (probe === 'unknown' || probe === 'partial') throw e;
          multipartLimitedRetries += 1;
          await this.waitForRateLimit(msg, attempt, log);
          continue;
        }

        /* ★ 先**当场问一次** biliLive-tools 的状态（不等待：确认窗口本身已经够长了）。两个作用：
             ① `error` ⇒ 这次追加**真失败**，立刻标 FAILED 返回，不必再花 90 秒等分P 出现
                （旧代码不看这个字段：成功/失败/还在跑都写"任务已完成、B站 侧还没查到"，
                 实测那条真失败的追加就是这么被写成「已提交待确认」、静默躺了半小时）；
             ② 它决定"读不到分P 列表"时该往哪边倒：任务已完成 → 按已落地；还没结束 → 按未确认。 */
        const st0 =
          resumeAid && typeof this.client.taskDetail === 'function'
            ? await this.client.taskDetail(res.taskId).catch(() => undefined)
            : undefined;
        st0Status = typeof st0?.status === 'string' ? st0.status : undefined;
        st0Error = typeof st0?.error === 'string' ? st0.error : undefined;
        stateText =
          st0Status === 'completed'
            ? 'biliLive-tools 侧任务已完成'
            : st0Status === undefined
              ? '查不到 biliLive-tools 的任务状态（队列可能因它重启而丢失）'
              : `biliLive-tools 侧任务尚未结束（状态 ${st0Status}）`;
        /* 「限流拒绝」也会把任务终态变成 error（线上事故就是这一支），必须与「真失败」区分开：
           能被限流说明提交没被受理 —— 但要先用探针确认真的没落地，才允许重交。 */
        const st0Kind = classifySubmitLimit(st0Error);
        /* ★ 配额级（2026-10-21）：**不重试**。但仍要先探一次"有没有偷偷落地"——B站 有过
           「回了错误、分P 却写进去了」的形态，确认落地就按已落地收尾，否则交给外层按「待投」收尾。
           （`probeAppendLanded` 本身一个字没改，这里只是多一个调用点。） */
        if (st0Status === 'error' && st0Kind === 'quota') {
          if (resumeAid) {
            const probeQuota = await this.probeAppendLanded(resumeAid, titled.map((p) => p.title), log);
            if (probeQuota === 'landed') {
              alreadyLanded = true;
              lastLimitedMsg = st0Error ?? '';
              multipartLimitedRetries += 1;
              break;
            }
          }
          throw new Error(st0Error ?? '投稿过于频繁，请稍后再试');
        }
        if (st0Status === 'error' && st0Kind === 'short' && attempt < this.rateLimitMaxAttempts) {
          lastLimitedMsg = st0Error ?? '';
          multipartRateLimitAttempts.push({ attempt, at: nowIso(), type: 'upload-failed', message: lastLimitedMsg });
          const probe = await this.probeAppendLanded(resumeAid, titled.map((p) => p.title), log);
          if (probe === 'landed') {
            alreadyLanded = true;
            multipartLimitedRetries += 1;
            break;
          }
          if (probe === 'unknown' || probe === 'partial') break; // 保守：落到下面的 FAILED 分支
          multipartLimitedRetries += 1;
          await this.waitForRateLimit(lastLimitedMsg, attempt, log);
          continue;
        }
        break;
      }
      /* ⚠️ 顺序要紧：alreadyLanded 时可能**一次都没提交成功**（res 为 undefined），
         所以先处理它，再守卫 res。 */
      if (alreadyLanded) {
        /* 上一次"被限流拒绝"的提交其实已经落到目标稿件里了（B站 回了错误、分P 却写进去了）。
           这时**再投一次就是重复分P**，所以按"已落地"收尾：状态推进 + 批次记账都按成功走。 */
        const note =
          `多分P 提交被 B站 限流（${lastLimitedMsg.slice(0, 90)}），但重试前核对发现这 ${titled.length} 个分P ` +
          `**已经在目标稿件的分P 列表里** —— 不再重投（否则分P 会重复），按已落地处理`;
        log.warn(note);
        warnings.push(note);
        if (res?.taskId) {
          recordBatchOutcome({
            taskId: task.id,
            uploadTaskId: res.taskId,
            kind: resumeAid ? 'append' : 'create',
            status: 'landed',
            ...(resumeAid ? { aid: resumeAid } : {}),
            ...(opts.resumeBvid ? { bvid: opts.resumeBvid } : {}),
            landed: titled.map((p) => p.title),
            note: '限流重试前的落地核对命中',
          }, this.batchLog());
        }
        for (const p of titled) {
          if (p.kind === 'clip' && p.clipIndex !== undefined) {
            const landed = Boolean(resumeAid && opts.resumeBvid);
            this.ledger.setClipStatus(task.id, p.clipIndex, landed ? 'PUBLISHED' : 'SUBMITTED', {
              submitTime: submitTimeMs,
              dtime,
              ...(res?.taskId ? { uploadTaskId: res.taskId } : {}),
              ...(landed && opts.resumeBvid ? { bvid: opts.resumeBvid, publishedAt: nowIso() } : {}),
            });
            let fpOfClip: string | undefined;
            const c = this.ledger.getClip(task.id, p.clipIndex);
            if (c) {
              fpOfClip = c.fingerprint ?? clipFingerprint({ sourceVideoId: task.recordingId ?? task.id, start: c.start, end: c.end, title: c.title });
              this.ledger.registerFingerprint(fpOfClip, { taskId: task.id, clipIndex: p.clipIndex });
            }
            this.ledger.logPublish({
              taskId: task.id,
              clipIndex: p.clipIndex,
              action: 'submit',
              title: p.title,
              ...(res?.taskId ? { uploadTaskId: res.taskId } : {}),
              ...(fpOfClip ? { fingerprint: fpOfClip } : {}),
              dtime,
            });
          }
        }
        this.ledger.rememberPublishedTitle(mainTitle);
        return {
          ok: true,
          ...(res?.taskId ? { uploadTaskId: res.taskId } : {}),
          mainTitle,
          parts: titled,
          ...(dtime !== undefined ? { dtime } : {}),
          warnings,
          mode: resumeAid ? 'append' : 'create',
        };
      }

      if (!res) throw new Error('内部错误：多分P 提交重试循环结束却没有提交结果');

      /* ★ 2026-10-11：把这一批**记下来**（投稿批次账，见 src/publish-batches.ts）。
         为什么要记：确认落地原来只能"逐片按标题模糊匹配"，出了事说不清
         "这次提交本该产生哪几个分P"。记下批次后，对账与告警都能按批次说人话。 */
      const clipPartsOfBatch = titled.filter((p) => p.kind === 'clip' && p.clipIndex !== undefined);
      recordBatchSubmit({
        taskId: task.id,
        uploadTaskId: res.taskId,
        kind: resumeAid ? 'append' : 'create',
        ...(resumeAid ? { aid: resumeAid } : {}),
        ...(opts.resumeBvid ? { bvid: opts.resumeBvid } : {}),
        titles: titled.map((p) => p.title),
        clipIndices: clipPartsOfBatch.map((p) => p.clipIndex!),
      }, this.batchLog());

      /* ★★ 续传必须**反查确认**：任务 completed 只代表 biliLive-tools 提交完了，
          不代表 B站 真的写进去了。实测事故（2026-09-23）：
            同一稿件追加 4 次，任务全部 completed / error 为空 / output 是正确 aid，
            但 B站 分P 数只在第 1 次从 14 涨到 23，之后三次纹丝不动 ——
            「已完成」在 B站 侧什么都没发生，而项目每次都判成 PUBLISHED 并记 SUBMITTED。
          所以这里查一次分P 列表，确认待投标题真的出现了；不出现就如实报失败。 */
      let appendVerified: boolean | undefined;
      if (resumeAid) {
        if (st0Status === 'error') {
          const why = st0Error ?? '对方未提供错误信息';
          const limitedNote =
            multipartLimitedRetries > 0 && isUploadRateLimited(why)
              ? `（限流重试 ${this.rateLimitMaxAttempts} 次仍失败）`
              : '';
          log.error(
            `续传**提交失败**：${stateText}，错误：${why}${limitedNote} —— ` +
              `${titled.length} 个切片已标记为 FAILED，修正原因后重跑投稿阶段即可重投`,
          );
          for (const p of titled) {
            if (p.kind === 'clip' && p.clipIndex !== undefined) {
              this.ledger.setClipStatus(task.id, p.clipIndex, 'FAILED', {
                failReason: `续传提交失败（biliLive-tools 任务报错）：${why.slice(0, 120)}${limitedNote}`,
              });
            }
          }
          recordBatchOutcome({
            taskId: task.id,
            uploadTaskId: res.taskId,
            kind: resumeAid ? 'append' : 'create',
            status: 'failed',
            ...(resumeAid ? { aid: resumeAid } : {}),
            ...(opts.resumeBvid ? { bvid: opts.resumeBvid } : {}),
            missing: titled.map((p) => p.title),
            note: `${stateText}，错误：${why}${limitedNote}`,
          }, this.batchLog());
          return { ok: false, error: `续传提交失败：${why}${limitedNote}`, mainTitle, parts: titled, warnings, mode: 'append' };
        }
        appendVerified = await this.confirmPartTitlesLanded(resumeAid, titled.map((p) => p.title), log, {
          unreadableFallback: st0Status === 'completed' ? 'landed' : 'unconfirmed',
        });
        if (appendVerified) {
          log.info(`续传确认：B站 侧已出现这 ${titled.length} 个分P ✓`);
        } else {
          /* ⚠️ 超时 ≠ 失败。B站 侧有**明显延迟**（实测一次追加约 20 分钟后才在分P 列表里看全），
             而发布流程不可能等那么久。所以这里必须区分：
               · 确认到新分P          → 成功
               · 超时且任务终态 error → 真失败（标 FAILED）
               · 超时且任务终态 ok    → **待确认**：记 SUBMITTED 并明确告知"未在窗口内确认"，
                                      既不像旧代码那样谎报成功，也不武断判失败。
             早期把"超时"直接当失败的写法，会在 B站 慢的时候把成功的追加误报成 FAILED。 */
          const msg =
            `续传**尚未在 B站 侧确认落地**（本次只快速看了 ${Math.round(CONFIRM_APPEND_TIMEOUT_MS / 1000)}s）：` +
            `${stateText}，但目标稿件的分P 列表里还没出现待投标题。` +
            `B站 分P 列表有延迟（实测可达 20 分钟），所以这**不等于失败** —— ` +
            `已把切片记为「已提交待确认」，由每 5 分钟一轮的反查确认；` +
            `**若 60 分钟后仍未出现会自动告警**（到时请到创作中心核对，确认没有可重投）。`;
          log.warn(msg);
          recordBatchOutcome({
            taskId: task.id,
            uploadTaskId: res.taskId,
            kind: resumeAid ? 'append' : 'create',
            status: 'unconfirmed',
            ...(resumeAid ? { aid: resumeAid } : {}),
            ...(opts.resumeBvid ? { bvid: opts.resumeBvid } : {}),
            missing: titled.map((p) => p.title),
            note: stateText,
          }, this.batchLog());
          for (const p of titled) {
            if (p.kind === 'clip' && p.clipIndex !== undefined) {
              this.ledger.setClipStatus(task.id, p.clipIndex, 'SUBMITTED', {
                uploadTaskId: res.taskId,
                submitTime: submitTimeMs,
                dtime,
                /* 同样写上目标稿件的 bvid（理由见下面成功分支的注释）：即便本次没在窗口内确认落地，
                   B站 侧的分P 也已经在写这个稿件了，bvid 是确定的事实而非猜测。 */
                ...(opts.resumeBvid ? { bvid: opts.resumeBvid } : {}),
              });
              this.ledger.logPublish({
                taskId: task.id,
                clipIndex: p.clipIndex,
                action: 'submit',
                uploadTaskId: res.taskId,
                title: p.title,
                dtime,
              });
            }
          }
          return {
            ok: true,
            uploadTaskId: res.taskId,
            mainTitle,
            parts: titled,
            ...(dtime !== undefined ? { dtime } : {}),
            warnings,
            mode: 'append',
            appendUnconfirmed: true,
          };
        }
        /* 落地确认通过 ⇒ 批次记账也标成 landed（与切片状态同一事实） */
        recordBatchOutcome({
          taskId: task.id,
          uploadTaskId: res.taskId,
          kind: 'append',
          status: 'landed',
          ...(resumeAid ? { aid: resumeAid } : {}),
          ...(opts.resumeBvid ? { bvid: opts.resumeBvid } : {}),
          landed: titled.map((p) => p.title),
        }, this.batchLog());
      }

      log.info(
        `${resumeAid ? `已续传到稿件 aid=${resumeAid}` : '已投稿 1 个稿件'} / ${titled.length} 个分P：${mainTitle}（uploadTaskId=${res.taskId}，` +
          (immediate ? '**立即发布**（未传 dtime）' : `定时发布 ${fmtLocal((dtime ?? 0) * 1000)}`) +
          '）',
        { data: { parts: titled.map((p) => `${p.kind}:${p.title}`) } },
      );
      /* ★ 上传成功 ⇒ 稿件详情已变，立刻让单飞缓存失效。
         否则随后的「分P 是否落地」轮询会读到**追加前**的快照，把刚投成功的分P 判成
         "没落地"，白等满 5 分钟确认窗口（实测就是这么误报 appendUnconfirmed 的）。 */
      this.archiveDetailCache.clear();
      for (const p of titled) {
        if (p.kind === 'clip' && p.clipIndex !== undefined) {
          /* ★★ 续传成功 + 目标稿件 bvid 已知 ⇒ 直接记 **PUBLISHED**（2026-10-06 实测修复）。
             这两件事都已经由上面的 confirmPartTitlesLanded 确认：分P 真的出现在了这个稿件里，
             而稿件的 bvid 是确定的。旧写法无论确认与否都只记 SUBMITTED，后果是：
               · 周期性反查是**按稿件标题**找的，分P 标题 ≠ 稿件标题 → 永远反查不到 → 永远停在 SUBMITTED；
               · 表现回流（bvidsNeedingPerformance）与「稿件表现」页面只认 PUBLISHED → 页面永远是空的（实测）；
               · 本场状态也永远到不了 PUBLISHED，`cleanup.deleteAfterUpload`（用完即删）不触发。
             仍然写 bvid（同 bvid、不同 cid，这些切片就是该稿件的分P）。
             没有 resumeAid（新建稿件）时 bvid 尚不可知，保持 SUBMITTED 交给周期性反查。 */
          const landed = Boolean(resumeAid && opts.resumeBvid);
          this.ledger.setClipStatus(task.id, p.clipIndex, landed ? 'PUBLISHED' : 'SUBMITTED', {
            uploadTaskId: res.taskId,
            submitTime: submitTimeMs,
            dtime,
            ...(landed && opts.resumeBvid ? { bvid: opts.resumeBvid, publishedAt: nowIso() } : {}),
          });
          const c = this.ledger.getClip(task.id, p.clipIndex);
          if (c) {
            this.ledger.registerFingerprint(
              c.fingerprint ?? clipFingerprint({ sourceVideoId: task.recordingId ?? task.id, start: c.start, end: c.end, title: c.title }),
              { taskId: task.id, clipIndex: p.clipIndex },
            );
          }
          this.ledger.logPublish({
            taskId: task.id,
            clipIndex: p.clipIndex,
            action: 'submit',
            uploadTaskId: res.taskId,
            title: p.title,
            dtime,
          });
        }
      }
      this.ledger.rememberPublishedTitle(mainTitle);
      return {
        ok: true,
        uploadTaskId: res.taskId,
        mainTitle,
        parts: titled,
        ...(dtime !== undefined ? { dtime } : {}),
        warnings,
        mode: resumeAid ? 'append' : 'create',
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      /* ★ 配额级限流（2026-10-21）：整批一次请求都没被受理 ⇒ 每个切片按 **CANDIDATE（待投）** 收尾，
         **不写 FAILED、不写错误报告**（理由与单切片路径的 `finishQuotaLimited` 完全一致：
         配额限流不是"这片坏了"，写成失败会把用户往查代码/重投上带，而它只需要等 30 分钟）。 */
      if (classifySubmitLimit(msg) === 'quota') {
        const todaySubmitted = this.ledger.todayPublishedCount();
        const reason =
          `B站 投稿配额限流（今日已提交 ${todaySubmitted} 个），` +
          `建议 ${UPLOAD_QUOTA_RETRY_AFTER_MIN} 分钟后重试｜原始错误：${msg.slice(0, 160)}`;
        log.warn(
          `多分P投稿命中**账号级投稿配额**限流，本轮不再重试：${msg.slice(0, 160)}` +
            `（${titled.length} 个切片已留在待投，建议 ${UPLOAD_QUOTA_RETRY_AFTER_MIN} 分钟后重试）`,
        );
        warnings.push(reason);
        for (const p of titled) {
          if (p.kind === 'clip' && p.clipIndex !== undefined) {
            /* 清掉提交侧字段（与 daemon 复位 CANDIDATE 时同一口径，QA 2026-10-21 指出）：
               一次被配额拒的提交什么都没创建，留着 uploadTaskId/submitTime 会让
               「待投」的片上挂着一次并不存在的提交，人工核对时又要多绕一圈。 */
            this.ledger.setClipStatus(task.id, p.clipIndex, 'CANDIDATE', { failReason: reason }, {
              unset: ['bvid', 'publishedAt', 'dtime', 'submitTime', 'uploadTaskId'] as Array<keyof ClipRecord>,
            });
          }
        }
        await this.alertQuotaLimited({ task, submitted: 0, remaining: titled.length, reason: msg });
        /* ★ 必须带 quotaLimited：调用方（daemon）据此把它当"暂停"而不是"失败"，
           否则本场状态回退 ANALYZED + 补发「投稿失败」error 告警（QA 实测的两个症状）。 */
        return {
          ok: false,
          mainTitle,
          parts: titled,
          dtime,
          error: reason,
          warnings,
          quotaLimited: { message: msg, todaySubmitted, retryAfterMin: UPLOAD_QUOTA_RETRY_AFTER_MIN },
        };
      }
      /* 限流耗尽（最后一次仍是限流拒绝）⇒ failReason 必须写明重试次数，人工才知道该不该直接重投 */
      const limitedNote =
        multipartLimitedRetries > 0 && isUploadRateLimited(msg)
          ? `（限流重试 ${this.rateLimitMaxAttempts} 次仍失败）`
          : '';
      log.error(`多分P投稿失败：${msg}${limitedNote}`, e);
      for (const p of titled) {
        if (p.kind === 'clip' && p.clipIndex !== undefined) {
          this.ledger.setClipStatus(task.id, p.clipIndex, 'FAILED', { failReason: `多分P投稿失败：${msg}${limitedNote}` });
          /* 多分P是**整批一个请求**：一个片段失败等于整批都没投出去，
             所以每个切片各写一份报告（带各自的片段号与标题），而不是只写一条含糊的"整批失败"。
             这样界面上点开任何一条失败切片，看到的都是"它自己那一P 为什么没上去"。 */
          this.reportClipFailure({
            taskId: task.id,
            taskTitle: task.title,
            clipIndex: p.clipIndex,
            stage: 'PUBLISHED',
            error: new Error(`${msg}${limitedNote}`),
            type: e instanceof ApiError ? e.type : 'upload-failed',
            ...(multipartRateLimitAttempts.length > 0 ? { retries: multipartRateLimitAttempts } : {}),
          });
        }
      }
      return { ok: false, mainTitle, parts: titled, dtime, error: `${msg}${limitedNote}`, warnings };
    }
  }

  /* ------------------------------------------------------------------------
   * 结果确认：反查 bvid（与完整版共用同一查询）
   * ---------------------------------------------------------------------- */

  /**
   * 等待上传任务出最终状态。
   *
   * 与 `waitTask` 的区别：上传任务可能长时间停在 `running`（B站侧排队 + 分片上传），
   * 而这里只关心「**是否已经明确失败**」。超时不算失败 —— 上传确实可能很慢，
   * 判失败会让本该成功的切片被标成失败并触发重复投稿。
   */
  async waitUploadTask(
    taskId: string,
    opts: { timeoutSec: number; intervalMs?: number; signal?: AbortSignal; onPoll?: (d: { status?: string }) => void },
  ): Promise<{ status: string; error?: string }> {
    const deadline = Date.now() + Math.max(30, opts.timeoutSec) * 1000;
    const interval = opts.intervalMs ?? 3000;
    let last = 'pending';
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) return { status: last };
      try {
        const d = await this.client.taskDetail(taskId);
        last = d.status ?? 'unknown';
        opts.onPoll?.({ ...(d.status ? { status: d.status } : {}) });
        if (d.status === 'completed') return { status: 'completed' };
        if (d.status === 'error') {
          return {
            status: 'error',
            error: typeof d.error === 'string' ? d.error : '（对方未提供错误信息，请看 /common/getLogContent 的日志片段）',
          };
        }
        // 任务已不在队列里：可能被清理，也可能进程重启导致队列丢失 —— 不算失败，交给反查兜底
        if (d.status === undefined && (d as { code?: number }).code === 404) {
          return { status: 'unknown' };
        }
      } catch (e) {
        // 任务查询 404（队列重启即丢）或网络抖动：不算失败
        const msg = e instanceof Error ? e.message : String(e);
        if (/404|不存在/.test(msg)) return { status: 'unknown' };
      }
      await sleep(interval);
    }
    return { status: last === 'unknown' ? 'unknown' : `${last}(超时未确认)` };
  }

  /**
   * 确认「待投的分P 标题」真的出现在目标稿件里（续传的**唯一可信依据**）。
   *
   * 为什么不能只看任务终态：实测同一稿件追加 4 次，biliLive-tools 任务全部 `completed`、
   * `error` 为空、`output` 是正确的 aid，但 B站 侧分P 数只在第 1 次增长过；
   * 后面三次「成功」在 B站 上什么都没发生。调用方的终态判定与台账都会被这种谎报污染。
   *
   * 判定方式：把**追加前**已有的标题集合记下来，然后轮询 —— 只要出现了**不在旧集合里**的
   * 待投标题，就算落地。这样即使同一标题重复投递也能识别（用集合差，不用计数）。
   *
   * @returns `true` 已落地；`false` 超时仍未出现（视为未生效）
   */
  private async confirmPartTitlesLanded(
    aid: string,
    wantTitles: string[],
    log: Logger,
    opts: { timeoutMs?: number; intervalMs?: number; unreadableFallback?: 'landed' | 'unconfirmed' } = {},
  ): Promise<boolean> {
    const norm = (s: string): string => s.replace(/\s+/g, '').trim();
    const want = new Set(wantTitles.map(norm).filter((s) => s.length > 0));
    if (want.size === 0) return true;

    /* 落地确认是**轮询**，每次都必须是新鲜数据 —— 否则整个循环会反复读同一份旧快照，
       "等待新分P 出现"永远等不到，把成功的追加误判成"待确认"。
       （这个坑当场被 test/confirm-append.ts 抓住：查询次数恒为 1。） */
    const fresh = { fresh: true } as const;
    const before = await this.fetchExistingPartTitles(aid, log, fresh);
    if (before === undefined) {
      /* 读不到就只能依据任务终态判定（否则会把成功的也判失败）—— 但要在日志里说明依据变弱了。
         ★ 2026-10-10：往哪边倒由调用方按**任务真实状态**决定（`unreadableFallback`）：
           任务已完成 → 按已落地（默认，保持历史行为）；任务还没结束/查不到 → 按未确认，
           否则一次"读不到列表"就把没跑完的追加写成 PUBLISHED（比"待确认"更糟）。 */
      const assumeLanded = (opts.unreadableFallback ?? 'landed') === 'landed';
      log.warn(
        `续传确认：读不到目标稿件 aid=${aid} 的分P 列表，**只能依据任务终态判定**（依据较弱）：` +
          (assumeLanded ? '按「已落地」处理' : 'biliLive-tools 任务尚未结束 ⇒ 按「未确认」处理，交给反查确认'),
      );
      return assumeLanded;
    }
    const beforeSet = new Set(before.map(norm));

    const deadline = Date.now() + (opts.timeoutMs ?? CONFIRM_APPEND_TIMEOUT_MS);
    const interval = opts.intervalMs ?? 6000;
    let attempt = 0;
    for (;;) {
      attempt++;
      const now = await this.fetchExistingPartTitles(aid, log, fresh);
      if (now !== undefined) {
        const landed = [...want].filter((t) => !beforeSet.has(t) && now.map(norm).includes(t));
        if (landed.length > 0) {
          log.debug(`续传确认：第 ${attempt} 次查询已看到 ${landed.length}/${want.size} 个新分P`);
          return true;
        }
      }
      if (Date.now() >= deadline) {
        log.warn(
          `续传确认：等待 ${Math.round((opts.timeoutMs ?? CONFIRM_APPEND_TIMEOUT_MS) / 1000)}s 后仍未在 B站 侧看到新分P` +
            `（追加前 ${beforeSet.size} 个，现在仍查不到待投标题）`,
        );
        return false;
      }
      await sleep(interval);
    }
  }

  /**
   * 读目标稿件的**分P 数**（切片编号基准）。
   *
   * 走 {@link fetchArchiveDetailCached}，所以与 `fetchExistingPartTitles`（续传去重）
   * 共用同一次 HTTP 响应 —— 两者读的是同一个 `View.pages`，绝不能一个读到一个读不到。
   */
  async readPartCount(bvid: string, log: Logger): Promise<number | undefined> {
    try {
      const detail = await this.fetchArchiveDetailCached(bvid, log);
      const n = archivePartCount(detail);
      if (n === undefined) {
        log.info(`目标稿件 ${bvid} 的详情里没有分P 列表（View.pages），切片编号基准无法确定`);
        return undefined;
      }
      return n;
    } catch (e) {
      log.warn(`读目标稿件 ${bvid} 分P 数失败：${(e as Error).message.slice(0, 120)}`);
      return undefined;
    }
  }

  /**
   * 稿件详情的单飞缓存（键 = bvid），`fresh` 语义由 {@link fetchArchiveDetailCached} 定义。
   *
   * ⚠️ 这个缓存只能服务"**同一次决策内**需要多个派生值"的场景（分P 数 + 分P 标题），
   * 绝不能服务"需要看到变化"的场景 —— 落地确认是轮询，每次都必须重新拉。
   */
  private async fetchArchiveDetailCached(
    bvid: string,
    log: Logger,
    opts: { fresh?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (opts.fresh) {
      this.archiveDetailCache.delete(bvid);
    } else {
      const hit = this.archiveDetailCache.get(bvid);
      if (hit) {
        log.debug(`稿件 ${bvid} 详情命中本次流程缓存（编号基准与去重共用同一次响应，保证一致）`);
        return hit;
      }
    }
    const detail = (await this.client.biliArchiveDetail(bvid, { retry: 0 })) as unknown as Record<string, unknown>;
    this.archiveDetailCache.set(bvid, detail);
    return detail;
  }

  /**
   * 查目标稿件**已有的分P 标题**，用于续传去重 / 落地确认。
   *
   * 实现要点（都是踩过的坑）：
   *  1. 投稿时我们只有 `aid`，而查详情的接口只认 `bvid` ⇒ 先用 `/bili/archives` 列表按 aid 反查 bvid；
   *  2. 分P 列表在详情响应的 **`View.pages`**（`part` 字段），**不在顶层** ——
   *     第一版找的是顶层 `pages`，结果误报"没有分P 列表"；
   *  3. **返回 `undefined` 表示"查不到"，不能返回空数组** —— 两者语义相反：
   *     `undefined` ⇒ 调用方跳过去重（不能因为查不到就以为"稿件是空的"从而重复投稿），
   *     `[]` ⇒ 确认稿件真的没有分P。
   *
   * ★ 与 `findResumeTarget` 共用同一次详情响应（见 `fetchArchiveDetailCached`）。
   *   实测教训：这两处原先各自发一次 `/bili/user/archive/:bvid`，同一秒内一个读到了
   *   14 个分P（编号基准）、另一个却拿不到列表（跳过去重）—— 同一个字段不可能同时
   *   有值又没值，只能是两次调用拿到了不同结果。分享一次响应既消除这种自相矛盾，
   *   也少一次 HTTP 往返。
   *
   * ⚠️ "跳过标题去重"是**安全相关的降级**（代价是可能重复投稿），必须让用户看得见：
   *   所以下面这几条日志用 info 而不是 debug —— 生产日志级别是 info，
   *   用 debug 会导致"去重悄悄没生效"完全无迹可查（这正是 BV13hhE6XEQM 那次
   *   重复追加查不出原因的直接原因）。
   */
  private async fetchExistingPartTitles(
    aid: string,
    log: Logger,
    opts: { fresh?: boolean } = {},
  ): Promise<string[] | undefined> {
    try {
      const archives = (await this.client.biliArchives({ page: 1, pageSize: 100 })) as unknown as Array<
        Record<string, unknown>
      >;
      const hit = archives.find((a) => String(a['aid'] ?? '') === String(aid));
      if (!hit || !hit['bvid']) {
        log.info(
          `续传去重：稿件列表 ${archives.length} 条里没找到 aid=${aid} 对应的 bvid（列表可能有分页或排序变化），` +
            `本次跳过标题去重 —— 若该稿件确实已含本场切片，指纹去重仍会兜住`,
        );
        return undefined;
      }
      const detail = (await this.fetchArchiveDetailCached(String(hit['bvid']), log, opts)) as Record<string, unknown>;
      const titles = archivePartTitles(detail);
      if (!titles) {
        log.info(`续传去重：稿件 ${String(hit['bvid'])} 详情里没有分P 列表（View.pages），本次跳过标题去重`);
        return undefined;
      }
      log.info(`续传去重：目标稿件 ${String(hit['bvid'])} 读到 ${titles.length} 个已有分P，按标题比对本次要投的切片`);
      return titles;
    } catch (e) {
      /* 查不到就不去重（宁可重复投、也不要静默少投），但要留下线索 */
      log.warn(`续传去重：读取目标稿件已有分P 失败（本次不去重，继续按原清单投）：${(e as Error).message.slice(0, 120)}`);
      return undefined;
    }
  }

  /**
   * 为已提交（SUBMITTED）的切片反查 bvid / 确认落地。
   *
   * 两条路，缺一不可：
   *  · **没有 bvid**（新建稿件那条路）：按稿件标题在 `/bili/archives` 里反查 —— 这是 bvid 的唯一来源
   *    （上传接口只返回 taskId，陷阱 #11、硬约束 #17）；
   *  · **已有 bvid**（多分P 续传那条路）：这个切片是**别人稿件的分P**，它的标题永远不会作为
   *    稿件标题出现在 `/bili/archives` 里 —— 按标题反查一辈子也查不到。要确认它落地，
   *    只能读那个稿件的**分P 标题列表**（`View.pages`）。
   *
   * ★★ 第二条是 2026-10-07 用户报「这个怎么一直是 已提交待确认」时补上的（实测 13 个切片就这么卡着）：
   *    续传的落地确认窗口只有 5 分钟，而 B站 分P 列表的可见延迟实测可达 20 分钟 ⇒
   *    窗口内没确认到就记成 SUBMITTED（这是诚实的设计，不能改成谎报成功），
   *    但**之后没人再确认** —— 于是永远停在「已提交待确认」，连带三个后果：
   *      ① 界面永远显示待确认，用户不知道到底投出去没有；
   *      ② `allDone` 永远不成立 ⇒ 场级状态到不了 PUBLISHED ⇒ **「用完即删」不触发，源录播一直占盘**；
   *      ③ 表现回流只认 PUBLISHED ⇒ 这些切片的播放数据永远不回流。
   */
  async confirmPublished(taskId: string, opts: { uid?: number | string } = {}): Promise<{
    confirmed: Array<{ clipIndex: number; bvid: string; title: string }>;
    pending: number[];
    /**
     * 「提交很久了、B站 侧还是没出现」的切片 —— 交回调用方**告警一次**。
     *
     * 为什么要这个出口（2026-10-10 实测）：反查每 5 分钟都会说「10/11 个已确认落地」，
     * 差的那一个就这么静默 pending 着（实测躺了半小时），直到用户自己看出来问「这是投稿了吗」。
     * 确认不了不等于失败，所以不擅自改状态、也不重复投 —— 但**必须有人被通知到**。
     */
    stalled: Array<{ clipIndex: number; title: string; minutes: number; bvid?: string }>;
    /** 按批次对账的一句话结论（供调用方记日志/展示；批次账细节见 src/publish-batches.ts） */
    batches: string[];
  }> {
    const task = this.ledger.getTask(taskId);
    if (!task) return { confirmed: [], pending: [], stalled: [], batches: [] };
    const clips = this.ledger.getClips(taskId).filter((c) => c.status === 'SUBMITTED');
    if (clips.length === 0) return { confirmed: [], pending: [], stalled: [], batches: [] };
    const log = this.logger;
    const confirmed: Array<{ clipIndex: number; bvid: string; title: string }> = [];
    const pending: number[] = [];
    const stalled: Array<{ clipIndex: number; title: string; minutes: number; bvid?: string }> = [];
    /* 这一轮读到的分P 标题（bvid → 规范化标题集合）：既用于逐片判定，也用于**按批次对账** */
    const titleIndex = new Map<string, Set<string>>();
    /* 提交超过这么久还没在 B站 侧看到 → 告警一次（不判失败、不重投，只让人知道） */
    const UNCONFIRMED_ALERT_MS = 60 * 60_000;
    const noteStalled = (clip: { index: number; title: string; submitTime?: number; bvid?: string; unconfirmedAlertAt?: string }): void => {
      if (clip.unconfirmedAlertAt) return; // 已经提醒过，不反复打扰
      if (!clip.submitTime) return;
      const mins = Math.round((Date.now() - clip.submitTime) / 60_000);
      if (Date.now() - clip.submitTime < UNCONFIRMED_ALERT_MS) return;
      this.ledger.setClipStatus(taskId, clip.index, 'SUBMITTED', { unconfirmedAlertAt: nowIso() });
      stalled.push({
        clipIndex: clip.index,
        title: clip.title,
        minutes: mins,
        ...(clip.bvid ? { bvid: clip.bvid } : {}),
      });
    };
    const norm = (s: string): string => s.replace(/\s+/g, '').trim();

    /* ---- 路径一：已经有 bvid（多分P 续传）→ 按**分P 标题**确认落地 ---- */
    const withBvid = clips.filter((c) => Boolean(c.bvid));
    const byBvid = new Map<string, typeof clips>();
    for (const c of withBvid) {
      const key = String(c.bvid);
      byBvid.set(key, [...(byBvid.get(key) ?? []), c]);
    }
    for (const [bvid, list] of byBvid) {
      let titles: string[] | undefined;
      try {
        /* `fresh: true`：必须看到**最新**的分P 列表，命中缓存等于看追加前的快照（那正是要判的东西） */
        const detail = await this.fetchArchiveDetailCached(bvid, log, { fresh: true });
        titles = archivePartTitles(detail);
      } catch (e) {
        log.debug(`续传落地反查：读稿件 ${bvid} 分P 列表失败（下轮再试）：${(e as Error).message.slice(0, 100)}`, { taskId });
      }
      if (!titles) {
        pending.push(...list.map((c) => c.index));
        continue;
      }
      const have = new Set(titles.map(norm));
      titleIndex.set(bvid, have);
      /* ★ 2026-10-11 优化第二批 ①：顺手查一次**重复分P**（同一稿件里标题重名 = 同一段内容被投了两次）。
         实测就是这么发现"修复前那场被跑 8 次投稿"的遗留的（BV1oWpG69Etu 里有一对同名分P）。
         只报告不自动删（B站 没有删单个分P 的开放接口）；记录只在重复集合变化时写，避免每轮刷日志。 */
      {
        const dup = findDuplicateTitles(titles);
        if (dup.length > 0) {
          const wrote = recordDuplicateParts({ bvid, titles: dup.map((d) => `${d.title}（${d.count} 份）`) });
          if (wrote) {
            log.warn(
              `稿件 ${bvid} 有 ${dup.length} 个**重复分P**：${dup.map((d) => `${d.title}×${d.count}`).join('、')} —— ` +
                `已进「健康面板 → 待办」，需要到创作中心删掉多余的（B站 没有删单个分P 的接口）`,
              { taskId },
            );
          }
        }
      }
      for (const clip of list) {
        if (!have.has(norm(clip.title))) {
          pending.push(clip.index);
          noteStalled(clip);
          continue;
        }
        this.ledger.setClipStatus(taskId, clip.index, 'PUBLISHED', { bvid, publishedAt: nowIso() });
        this.ledger.registerFingerprint(
          clip.fingerprint ??
            clipFingerprint({ sourceVideoId: task.recordingId ?? task.id, start: clip.start, end: clip.end, title: clip.title }),
          { taskId, clipIndex: clip.index, bvid },
        );
        this.ledger.logPublish({
          taskId,
          clipIndex: clip.index,
          action: 'confirm',
          bvid,
          title: clip.title,
          ...(clip.uploadTaskId ? { uploadTaskId: clip.uploadTaskId } : {}),
          ...(clip.dtime !== undefined ? { dtime: clip.dtime } : {}),
        });
        confirmed.push({ clipIndex: clip.index, bvid, title: clip.title });
      }
      if (list.length > 0) {
        log.info(
          `续传落地反查：稿件 ${bvid} 现有 ${titles.length} 个分P，其中 ${list.filter((c) => have.has(norm(c.title))).length}/${list.length} ` +
            `个待确认切片已确认落地`,
          { taskId },
        );
      }
    }

    /* ---- 路径一之后：**按批次对账**（2026-10-11，投稿批次账）----
       逐片判定只能回答"某片在不在分P 列表里"；批次账能回答"**这次投稿**整体成没成、少了哪几个"。
       用刚读到的标题集合把每个未结批次判一遍，并把结论写回批次账（供界面对账与事后复盘）。 */
    const batchNotes: string[] = [];
    for (const b of readOpenBatches(taskId, this.batchLog())) {
      const titles = b.bvid ? titleIndex.get(b.bvid) : undefined;
      const missing = titles ? b.titles.filter((t) => !titles.has(norm(t))) : b.titles.slice();
      const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(b.at)) / 60_000));
      if (titles && missing.length === 0) {
        recordBatchOutcome({
          taskId,
          uploadTaskId: b.uploadTaskId,
          kind: b.kind,
          status: 'landed',
          ...(b.aid ? { aid: b.aid } : {}),
          ...(b.bvid ? { bvid: b.bvid } : {}),
          landed: b.titles,
        }, this.batchLog());
        batchNotes.push(`批次 ${b.uploadTaskId.slice(0, 8)}：${b.titles.length} 个分P 全部落地`);
      } else {
        batchNotes.push(
          `批次 ${b.uploadTaskId.slice(0, 8)}：提交 ${ageMin} 分钟，${b.titles.length - missing.length}/${b.titles.length} 个分P 落地` +
            (missing.length ? `，缺：${missing.map((t) => t.slice(0, 18)).join('、')}` : '（分P 列表本轮读不到，下轮再看）'),
        );
      }
    }
    if (batchNotes.length > 0) log.info(`投稿批次对账：${batchNotes.join('；')}`, { taskId });

    /* ---- 路径二：没有 bvid（新建稿件）→ 按稿件标题反查 ---- */
    const noBvid = clips.filter((c) => !c.bvid);
    if (noBvid.length === 0) {
      if (confirmed.length) log.info(`反查确认 ${confirmed.length} 个切片（多分P 续传，按分P 标题确认）`, { taskId });
      return { confirmed, pending, stalled, batches: batchNotes };
    }
    const archives = await this.client.biliArchives({ page: 1, pageSize: 100 });
    for (const clip of noBvid) {
      const m = matchArchive(archives, clip.title, {
        ...(clip.submitTime ? { sinceMs: clip.submitTime - 3600_000 } : {}),
      }).filter((x) => x.exact)[0];
      // ★ 命中 ≠ 可信：过校验闸，避免把完整版录播的 bvid 写到切片上（实测踩过）
      const verdict = m
        ? verifyArchiveMatch(m, clip.title, {
            ...(clip.submitTime ? { submitTimeMs: clip.submitTime } : {}),
            fullVideoTitles: fullVideoTitleCandidates(task),
          })
        : undefined;
      if (m && verdict && !verdict.ok) {
        this.logger.warn(
          `切片 #${clip.index} 反查命中 ${m.bvid} 但**拒绝写入 bvid**：${verdict.reason}。` +
            `该切片保持 SUBMITTED，等下一次反查或人工核对`,
          { taskId, data: { clipIndex: clip.index, bvid: m.bvid, code: verdict.code, hitTitle: m.title } },
        );
        this.ledger.logPublish({
          taskId,
          clipIndex: clip.index,
          action: 'fail',
          error: `反查命中 ${m.bvid} 但被可信度校验拒绝（${verdict.code}）：${verdict.reason}`,
          title: clip.title,
        });
        pending.push(clip.index);
        continue;
      }
      if (m) {
        this.ledger.setClipStatus(taskId, clip.index, 'PUBLISHED', { bvid: m.bvid, publishedAt: nowIso() });
        this.ledger.registerFingerprint(
          clip.fingerprint ??
            clipFingerprint({
              sourceVideoId: task.recordingId ?? task.id,
              start: clip.start,
              end: clip.end,
              title: clip.title,
            }),
          { taskId, clipIndex: clip.index, bvid: m.bvid },
        );
        // confirm 必须带上这次投稿的 uploadTaskId：每日额度统计要把它与对应的 submit 配成一对，
        // 否则只能靠「同桶内时间就近」回退配对。多分P 一次投稿的多个分P 共用同一个 uploadTaskId，
        // 因此同一个 id 会被多条 confirm 复用 —— 这正是「一次投稿」的语义，配对后只算 1 个稿件。
        this.ledger.logPublish({
          taskId,
          clipIndex: clip.index,
          action: 'confirm',
          bvid: m.bvid,
          title: clip.title,
          ...(clip.uploadTaskId ? { uploadTaskId: clip.uploadTaskId } : {}),
          ...(clip.dtime !== undefined ? { dtime: clip.dtime } : {}),
        });
        confirmed.push({ clipIndex: clip.index, bvid: m.bvid, title: clip.title });
      } else {
        pending.push(clip.index);
        noteStalled(clip);
      }
    }
    if (confirmed.length) {
      this.logger.info(`反查确认 ${confirmed.length} 个切片的 bvid：${confirmed.map((c) => c.bvid).join(', ')}`);
    }
    if (pending.length) {
      this.logger.debug(`${pending.length} 个切片尚未在 /bili/archives 反查到（B站侧可能有延迟）`, {
        data: { taskId, pending },
      });
    }
    void opts;
    return { confirmed, pending, stalled, batches: batchNotes };
  }

  /** 崩溃恢复：处理卡在 SUBMITTING 的切片 —— 先反查，再决定是否重投 */
  async recoverStuck(): Promise<{ checked: number; confirmed: number; retried: string[]; notes: string[] }> {
    const stuck = this.ledger.stuckClips();
    const notes: string[] = [];
    let confirmed = 0;
    const retried: string[] = [];
    if (stuck.length === 0) return { checked: 0, confirmed: 0, retried, notes };

    const archives = await this.client.biliArchives({ page: 1, pageSize: 100 }).catch(() => [] as ArchiveItem[]);
    for (const s of stuck) {
      const clip = this.ledger.getClip(s.taskId, s.clipIndex);
      if (!clip) continue;
      const m = matchArchive(archives, clip.title).filter((x) => x.exact)[0];
      if (m) {
        this.ledger.setClipStatus(s.taskId, s.clipIndex, 'PUBLISHED', { bvid: m.bvid, publishedAt: nowIso() });
        confirmed++;
        notes.push(`${s.taskId}#${s.clipIndex} 卡在 ${s.status}，但服务器侧已存在该稿件（${m.bvid}），已补记为 PUBLISHED`);
        continue;
      }
      if (s.status === 'SUBMITTING') {
        // 无 uploadTaskId 又无稿件 → 属于「提交前崩溃」，安全地重置为待投
        this.ledger.setClipStatus(s.taskId, s.clipIndex, 'PENDING_UPLOAD', {});
        retried.push(`${s.taskId}#${s.clipIndex}`);
        notes.push(`${s.taskId}#${s.clipIndex} 卡在 SUBMITTING 且服务器侧无对应稿件 → 判定为提交前崩溃，已重置为 PENDING_UPLOAD 待重投`);
      } else if (s.status === 'CUTTING' && s.uploadTaskId) {
        notes.push(`${s.taskId}#${s.clipIndex} 卡在 CUTTING 且有 uploadTaskId=${s.uploadTaskId}，需人工核对后再决定`);
      }
    }
    return { checked: stuck.length, confirmed, retried, notes };
  }
}

/* ============================================================================
 * 辅助
 * ========================================================================== */

/**
 * 读投稿流水（原始行）。
 *
 * 这里刻意**不**复用 publish-audit.ts 的解析：那个模块要 import 本模块的
 * `fullVideoTitleCandidates`，反向依赖会形成循环。读一行 JSONL 不值得引循环。
 */
function readPublishLogRows(): Array<Record<string, unknown>> {
  const p = path.join(DATA_DIR, 'publish-log.jsonl');
  try {
    if (!exists(p)) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

/**
 * 选择切割用的源文件。
 *
 * ⚠️ 依据台账的 `fullVideoHasDanmaku` 决定用谁（硬约束 #12，不允许运行时猜测）：
 *   - 完整版**已烧弹幕** → 用完整版切且**不传 ASS**（画面里的弹幕本身是正确的）
 *   - 完整版**未烧弹幕** → 用完整版切并传整场 ASS
 *   - 没有完整版 → 用第一段录制原始文件（切片流程的正确性只依赖「源文件存在且可用」）
 *
 * 兜底：原始分段被清理之后（§7.3 允许转写完成后删原始分段），
 * 任务目录里的压制产物还在，但台账的 `fullVideoPath` 未必被写回 ——
 * 实测遇到过「重跑切片」直接报「找不到可用于切片的源文件」，而 `data/tasks/<id>/full/`
 * 里明明躺着可用的 mp4。这里补一层兜底。
 *
 * ⚠️ 兜底**只认文件名里带 `pure` 的产物**：带 `full`/`弹幕` 的那个是已经烧过弹幕的，
 * 再烧一次就是双层弹幕（陷阱 #8），宁可不切也不要切出双弹幕的片子。
 */
export function pickSourceForCut(task: TaskRecord, cfg: AppConfig): string | undefined {
  const full = task.source.fullVideoPath;
  if (full && exists(full)) return full;
  // 没有完整版时用原始分段（此时 ASS 必须传，因为原始录制一定没烧弹幕）
  const raw = task.source.rawFiles.find((f) => exists(f));
  if (raw) return raw;
  // 兜底：任务目录里的「纯享版」压制产物（未烧弹幕，可安全再烧一次）
  const fullDir = path.join(TASKS_DIR, task.id, 'full');
  try {
    if (exists(fullDir)) {
      const cand = fs
        .readdirSync(fullDir)
        .filter((f) => /\.(mp4|mkv|flv|ts)$/i.test(f) && /pure|clean|nodanmaku|no-danmaku/i.test(f))
        .map((f) => path.join(fullDir, f))
        .filter((f) => exists(f) && fileSize(f) > 1024 * 1024)
        .sort((a, b) => fileSize(b) - fileSize(a))[0];
      if (cand) return cand;
    }
  } catch {
    /* 目录读不到就当没有兜底 */
  }
  void cfg;
  return undefined;
}

/** 是否需要传 ASS（供 UI 与日志解释） */
export function shouldPassAss(task: TaskRecord, cfg: AppConfig): { pass: boolean; reason: string } {
  if (!cfg.clip.burnDanmaku) return { pass: false, reason: '配置关闭了烧弹幕（clip.burnDanmaku=false）' };
  if (task.source.fullVideoHasDanmaku) {
    return { pass: false, reason: '源文件已烧弹幕（fullVideoHasDanmaku=true），再传 ASS 会叠双层弹幕' };
  }
  if (!task.source.danmaAssPath && !task.source.danmaXmlPath) return { pass: false, reason: '没有可用的弹幕文件' };
  return { pass: true, reason: task.source.danmaAssPath ? '使用 ASS 弹幕' : '由 XML 现场转换为 ASS' };
}

/** 把切片结果写成可读的投稿记录（供 --inspect 与 UI 展示） */
export function persistPublishReport(dir: string, results: CutAndUploadResult[]): string {
  const p = path.join(dir, `publish-report-${Date.now()}.json`);
  writeJsonAtomic(p, { at: nowIso(), results });
  return p;
}
/** 检查账号有效性并给出可执行结论（§8 WP6 步骤 5） */
export function accountHealth(users: BiliUser[], warnDays: number): {
  ok: boolean;
  message: string;
  uid?: number | string;
  daysLeft?: number;
} {
  if (users.length === 0) {
    return { ok: false, message: 'biliLive-tools 中没有已登录的 B站账号 —— 请在它的界面扫码登录后重试' };
  }
  const u = users[0]!;
  if (!u.expires) {
    return { ok: true, message: `账号 ${u.name ?? u.uid} 未返回 expires 字段，无法判断有效期（可能一直有效）`, uid: u.uid };
  }
  const daysLeft = (u.expires - Date.now()) / 86400_000;
  if (daysLeft <= 0) {
    return {
      ok: false,
      message: `账号 ${u.name ?? u.uid} 的 cookie 已过期（${fmtLocal(u.expires)}）—— 必须人工重新扫码，无法自动续期`,
      uid: u.uid,
      daysLeft,
    };
  }
  if (daysLeft <= warnDays) {
    return {
      ok: true,
      message: `账号 ${u.name ?? u.uid} 的 cookie 将在 ${daysLeft.toFixed(1)} 天后过期（${fmtLocal(u.expires)}），建议尽快重新扫码续期`,
      uid: u.uid,
      daysLeft,
    };
  }
  return { ok: true, message: `账号 ${u.name ?? u.uid} 有效期剩余 ${daysLeft.toFixed(0)} 天`, uid: u.uid, daysLeft };
}
