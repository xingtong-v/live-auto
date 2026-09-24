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
import path from 'node:path';
import type {
  ArchiveItem,
  BiliUser,
  ClipRecord,
  FfmpegPreset,
  TaskRecord,
  Transcript,
  TranscriptSegment,
} from './types.ts';
import type { AppConfig } from './config.ts';
import { resolveDataPath } from './config.ts';
import { BiliLiveClient, ApiError } from './api.ts';
import type { Ledger } from './ledger.ts';
import { clipFingerprint } from './ledger.ts';
import { sanitizeDesc, sanitizeTags, sanitizeTitle } from './analyze.ts';
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

/**
 * dtime 排期公式（硬约束 #4）：
 *   `dtime = submitTime + 7800 + (N - 1) × 7500 + random(0, 1800)`，N 从 1 开始
 *
 * ⚠️ 依据说明（别把它误传成平台规则）：B站的硬限制是 **`dtime` 必须晚于「该稿件自身的提交时间」7200 秒**，
 * 这是相对提交时刻的约束，**不是相对上一个切片**。同一次流程里提交的多个切片，
 * 各自满足「大于提交时间 + 7200」即全部合法，相邻间隔多少并不受额外限制。
 * 取 7500 只是留冗余。
 *
 * @param submitTimeMs 该稿件的提交时刻（毫秒）
 * @param n 从 1 开始计数的序号
 * @param opts `daytimeOnly` 为 true 时用 `N × 7500`，让全部切片延后到白天发布
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
     * 用于用户显式指定的首片发布时间 —— B站要求 dtime 距**本稿件的提交时刻** >7200 秒，
     * 所以指定时间比这更早时只能推迟到最早合法时间（调用方记录原因）。
     */
    notBeforeSec?: number;
  },
): number {
  const rng = opts.rng ?? Math.random;
  const base = opts.submitGapSec + (opts.daytimeOnly ? n : Math.max(0, n - 1)) * opts.clipGapSec;
  const jitter = opts.jitterSec > 0 ? Math.floor(rng() * opts.jitterSec) : 0;
  const auto = Math.floor(submitTimeMs / 1000) + base + jitter;
  // 用户指定了发布时间：取「自动值」与「指定值」的较大者，
  // 既尊重用户意图，又不会突破 B站的 7200 秒下限。
  return opts.notBeforeSec ? Math.max(auto, opts.notBeforeSec) : auto;
}

/** 校验 dtime 是否满足硬约束（供 UI 实时校验与投稿前自检） */
export function validateDtime(dtimeSec: number, submitTimeMs: number): { ok: boolean; marginSec: number; note: string } {
  const marginSec = dtimeSec - Math.floor(submitTimeMs / 1000);
  if (marginSec > 7200) {
    return { ok: true, marginSec, note: `距提交时刻 ${marginSec} 秒（> 7200 秒，合规）` };
  }
  return {
    ok: false,
    marginSec,
    note: `dtime 距提交时刻仅 ${marginSec} 秒，**不满足** B站「必须晚于提交时间 7200 秒」的要求，投稿会被拒（陷阱 #12）`,
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

  const enc = base['c:v'] ?? base['vcodec'] ?? base['codec'];
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
  },
  logger?: Logger,
): { cover?: string; source: string; attempts: Array<{ source: string; path?: string; ok: boolean; reason: string }> } {
  const order: Array<'default' | 'preset' | 'fullVideo'> =
    cfg.publish.coverSource === 'default'
      ? ['default', 'preset', 'fullVideo']
      : cfg.publish.coverSource === 'fullVideo'
        ? ['fullVideo', 'preset', 'default']
        : ['preset', 'default', 'fullVideo'];

  const attempts: Array<{ source: string; path?: string; ok: boolean; reason: string }> = [];
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
 * 把排期意图翻成人话，供日志与 UI 使用。
 * 能明确回答「首片什么时候发、最后一片什么时候发、我指定的时间是否被推迟了」。
 */
export function describeDtimePlan(
  submitTimeMs: number,
  cfg: { submitGapSec: number; clipGapSec: number; jitterSec: number; firstPublishAt: string },
  clipCount: number,
): { first: number; last: number; note: string; userSpecified: boolean; earliestAllowed: number } {
  const want = parseFirstPublishAt(cfg.firstPublishAt);
  const mk = (n: number): number =>
    computeDtime(submitTimeMs, n, {
      submitGapSec: cfg.submitGapSec,
      clipGapSec: cfg.clipGapSec,
      jitterSec: cfg.jitterSec,
      ...(want !== undefined ? { notBeforeSec: want } : {}),
    });
  const first = mk(1);
  const last = mk(Math.max(1, clipCount));
  // B站下限：提交时刻 + 7200 秒（留 10 分钟余量便于展示）
  const earliestAllowed = Math.floor(submitTimeMs / 1000) + 7200 + 600;
  let note = '按公式自动排期（错峰发布）';
  if (want !== undefined) {
    const hardFloor = Math.floor(submitTimeMs / 1000) + 7200;
    if (want >= hardFloor) {
      note =
        want >= earliestAllowed
          ? '按你指定的首片时间发布'
          : '你指定的时间距提交不足 7800 秒（B站硬限是 7200 秒），已保留但余量偏小，建议再晚一些';
    } else {
      // 比 B站硬限还早：只能推迟，并明确告知实际会用的时间
      note =
        '你指定的 ' +
        new Date(want * 1000).toLocaleString('zh-CN') +
        ' 早于 B站下限（提交后须 >7200 秒），已自动推迟到 ' +
        new Date(Math.max(first, earliestAllowed) * 1000).toLocaleString('zh-CN');
    }
  }
  return { first, last, note, userSpecified: want !== undefined, earliestAllowed };
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
 * 续传落地确认的等待上限。
 *
 * 取值依据：实测 B站 分P 列表有延迟 —— 一次追加**约 2 分钟**后在列表里能看到，
 * 但「看全」可能要到 20 分钟后。发布流程不能等那么久，所以这里取 5 分钟：
 *   · 大多数情况够确认成功
 *   · 超时也**不判失败**（记「已提交待确认」），避免把慢当成错
 */
const CONFIRM_APPEND_TIMEOUT_MS = 5 * 60_000;

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
  const roomUrl = `https://live.bilibili.com/${task.roomId}`;
  const dateText = task.liveStartTime ? fmtLocal(task.liveStartTime * 1000).slice(0, 10) : fmtLocal().slice(0, 10);
  let desc: string;
  if (input.overrideDesc !== undefined) {
    desc = input.overrideDesc;
  } else {
    const tpl = cfg.publish.descTemplate || '{{desc}}';
    desc = tpl
      .split('{{date}}').join(dateText)
      .split('{{liveTitle}}').join(task.title || '直播回放')
      .split('{{roomUrl}}').join(roomUrl)
      .split('{{startText}}').join(fmtDuration(clip.start))
      .split('{{endText}}').join(fmtDuration(clip.end))
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

  // 标签：**不追加 defaultTags**。切片标签是「选片阶段 LLM 按内容生成的」+「用户在界面上
  // 手动加的」两类，一旦在这里再拼上全局默认标签，所有稿件的标签就会长得一模一样。
  // 这里只做清理（去重/截断/敏感词）与上限约束（硬约束 #3）。
  const tagRes = sanitizeTags(input.overrideTags ?? clip.tags, {
    sensitive: cfg.publish.tagSensitiveWords,
  });
  if (tagRes.removed.length) warnings.push(`标签被移除：${tagRes.removed.join('、')}`);
  let tags = tagRes.tags;
  if (tags.length === 0) {
    tags = cfg.publish.defaultTags.length ? [...cfg.publish.defaultTags] : ['直播切片'];
    warnings.push(`清理后没有可用标签，已用默认标签兜底：${tags.join('、')}`);
  }
  if (tags.length > 10) {
    warnings.push(`标签 ${tags.length} 个超过上限 10，已截断`);
    tags = tags.slice(0, 10);
  }

  // tid：只接受白名单里的值（硬约束 #16）
  const wl = cfg.publish.tidWhitelist;
  let tid = wl[clip.category];
  if (tid === undefined) {
    const byValue = Object.values(wl).includes(21) ? 21 : Object.values(wl)[0];
    warnings.push(`分区「${clip.category}」不在白名单，回退默认分区 tid=${byValue}`);
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
    //   「必须 ≥ 提交后 2 小时」，所以不传这个键才是真正的立即发布。
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
        '不再满足任务书硬约束 #4 的「> 提交时刻 + 7200 秒」。该约束是防风控的自律措施、非 B站规则。',
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
      // 完整版同样受 >7200 秒约束
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
      const res = await this.client.biliUpload({ uid, videos: [videoPath], config });
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

    // ---- 源文件校验 ----
    const sourcePath = pickSourceForCut(task, cfg);
    if (!sourcePath) {
      const msg = `找不到可用于切片的源文件。source.rawFiles 与 fullVideoPath 都不可用，无法切片`;
      log.error(msg);
      this.ledger.setClipStatus(task.id, clipIndex, 'FAILED', { failReason: msg });
      return { clipIndex, ok: false, error: { type: 'file-missing', message: msg }, warnings };
    }

    // ---- 弹幕烧录：源版本决定是否传 ASS（陷阱 #8、硬约束 #12）----
    let assPath: string | undefined;
    if (cfg.clip.burnDanmaku) {
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
    if (cfg.clip.burnSubtitles) {
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

    // ---- 第一步：切片 ----
    let cutTaskId: string;
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
      return { clipIndex, ok: false, error: { type, message: msg }, warnings };
    }

    // ---- 第二步：轮询到 completed，取服务端返回的真实产出路径 ----
    let taskOutput: string | undefined;
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
      return { clipIndex, ok: false, cutTaskId, error: { type: 'internal', message: msg }, warnings };
    }

    // ---- 多分P模式：只切片，投稿由 publishAsMultiPart 统一完成 ----
    if (opts.skipUpload) {
      const note = `已切片，等待与完整版一起投进同一稿件（多分P模式，不单独投稿）`;
      this.ledger.setClipStatus(task.id, clipIndex, 'CUT', { cutOutput: taskOutput, fingerprint: fp });
      log.info(note, { data: { clipIndex, output: path.basename(taskOutput) } });
      return { clipIndex, ok: true, skipped: note, cutTaskId, output: taskOutput, warnings };
    }

    // ---- 第三步：投稿 ----
    const submitTimeMs = opts.submitTimeMs ?? Date.now();
    // 序号 N：同一批里的第几片（用已提交数 + 1）
    const n = this.ledger.readPublishLog({ sinceMs: submitTimeMs - 86400_000 }).filter((r) => r['action'] === 'submit').length + 1;
    // 首片允许用户显式指定发布时间；其余按 clipGapSec 递进
    const wantFirst = n === 1 ? parseFirstPublishAt(cfg.publish.firstPublishAt) : undefined;
    if (n === 1 && cfg.publish.firstPublishAt && wantFirst === undefined) {
      warnings.push('publish.firstPublishAt 无法解析或已过期，已回退为自动排期（正确格式如 2026-09-23T08:00）');
    }
    /* 立即发布：与 buildBiliupConfig 用**同一个**判定，避免「payload 不带 dtime、
       日志却写定时发布」这种自相矛盾（实测踩过）。 */
    let immediate = cfg.publish.immediatePublish === true;
    let dtime = computeDtime(submitTimeMs, n, {
      submitGapSec: cfg.publish.submitGapSec,
      clipGapSec: cfg.publish.clipGapSec,
      jitterSec: cfg.publish.jitterSec,
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

    try {
      const res = await this.client.biliUpload({ uid, videos: [taskOutput], config });
      this.ledger.setClipStatus(task.id, clipIndex, 'SUBMITTED', {
        uploadTaskId: res.taskId,
        submitTime: submitTimeMs,
        dtime,
      });
      this.ledger.registerFingerprint(fp, { taskId: task.id, clipIndex });
      this.ledger.rememberPublishedTitle(clip.title);
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
          `，${cfg.publish.isOnlySelf === 1 ? '仅自己可见' : '公开'}）`,
        { stage: 'PUBLISHED' },
      );

      // ---- 第四步（可选但重要）：确认上传任务的最终结果 ----
      // `/bili/upload` 只返回 taskId（陷阱 #11），而任务状态才是「投稿到底成没成」的直接证据。
      // 不做这一步的话，上传失败要等到若干天后的 bvid 反查才暴露 —— 期间台账一直显示「已提交」。
      // 注意：**bvid 仍然只能靠 /bili/archives 反查**（任务队列在内存中、重启即丢）。
      const uploadOutcome = await this.waitUploadTask(res.taskId, {
        timeoutSec: cfg.publish.autoCutTimeoutSec,
        ...(opts.signal ? { signal: opts.signal } : {}),
        onPoll: (d) => log.debug(`上传任务 ${res.taskId} 状态：${d.status ?? 'unknown'}`),
      });
      if (uploadOutcome.status === 'error') {
        const msg = uploadOutcome.error ?? '（对方未提供错误信息，请看 /common/getLogContent 的日志片段）';
        log.error(`投稿任务失败：${msg} —— 切片产物已保留，可单独重投`, undefined, { data: { clipIndex } });
        this.ledger.setClipStatus(task.id, clipIndex, 'FAILED', {
          failReason: `投稿任务失败：${msg}`,
          uploadTaskId: res.taskId,
          cutOutput: taskOutput,
        });
        this.ledger.logPublish({ taskId: task.id, clipIndex, action: 'fail', error: msg, title: clip.title });
        return { clipIndex, ok: false, cutTaskId, output: taskOutput, uploadTaskId: res.taskId, error: { type: 'upload-failed', message: msg }, warnings };
      }
      log.debug(`上传任务 ${res.taskId} 已完成（${uploadOutcome.status}），bvid 待 /bili/archives 反查确认`);

      return { clipIndex, ok: true, cutTaskId, output: taskOutput, uploadTaskId: res.taskId, dtime, warnings };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`投稿失败（片段 #${clipIndex}）—— 切片产物已保留，可单独重投`, e);
      this.ledger.setClipStatus(task.id, clipIndex, 'FAILED', { failReason: `投稿失败：${msg}`, cutOutput: taskOutput });
      this.ledger.logPublish({ taskId: task.id, clipIndex, action: 'fail', error: msg, title: clip.title });
      return { clipIndex, ok: false, cutTaskId, output: taskOutput, error: { type: 'upload-failed', message: msg }, warnings };
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
  }> {
    const { task } = opts;
    const log = this.logger.child({ taskId: task.id, stage: 'PUBLISHING' });
    const all = this.ledger.getClips(task.id);
    const indices =
      opts.indices ??
      all
        .filter((c) => c.selected && (c.status === 'CANDIDATE' || c.status === 'PENDING_UPLOAD' || c.status === 'FAILED'))
        .map((c) => c.index);

    if (indices.length === 0) {
      log.info('没有需要投稿的切片（未勾选或已全部处理）');
      return { results: [], submitted: 0, skipped: 0, failed: 0, quota: { todayCount: this.ledger.todayPublishedCount(), remain: -1, requested: 0 } };
    }

    const dryRun = opts.dryRun ?? false;

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
        return { results: [], submitted: 0, skipped: 0, failed: 0, quota: { todayCount: today, remain: 0, requested: indices.length } };
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

      const r = await this.cutAndUploadClip(
        {
          ...opts,
          submitTimeMs: submitBase,
          ...(archives ? { archiveCache: archives } : {}),
        },
        idx,
      );
      results.push(r);
      for (const w of r.warnings) log.debug(`片段 #${idx}：${w}`);
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
  }> {
    const cfg = this.cfg;
    const log = (opts.logger ?? this.logger).child({ taskId: opts.task.id, mod: 'multipart' });
    const warnings: string[] = [];
    const { task, uid, clips } = opts;

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

    /* ---- 4. dtime（多P稿件只有一个发布时间）---- */
    const submitTimeMs = Date.now();
    const immediate = cfg.publish.immediatePublish === true;
    /* 立即发布时**根本没有 dtime 这个字段**。
       早先这里用「提交时刻」当占位值返回，结果日志写成「定时发布 <刚提交的时间>」，
       读起来像排期错乱（实测误导过一次排查）。所以立即发布时干脆不产出这个值，
       由调用方按 undefined 走「立即发布」文案。 */
    const dtime = immediate
      ? undefined
      : computeDtime(submitTimeMs, 1, {
          submitGapSec: cfg.publish.submitGapSec,
          clipGapSec: cfg.publish.clipGapSec,
          jitterSec: cfg.publish.jitterSec,
        });
    if (!immediate && dtime !== undefined) {
      const dt = validateDtime(dtime, submitTimeMs);
      if (!dt.ok) warnings.push(dt.note);
    }

    /* ---- 5. 投稿配置 ---- */
    const coverRes = resolveCover(this.cfg, {}, log);
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
    try {
      const res = await this.client.biliUpload({
        uid,
        videos,
        config: biliConfig,
        /* ★ 有续传目标就带 vid：biliLive-tools 收到 vid 走 editMedia（追加分P），
           没有则走 addMedia（新建稿件）。这一行就是「切片接进 biliLive-tools 那个稿件」的关键。 */
        ...(resumeAid ? { vid: resumeAid } : {}),
      });

      /* ★★ 续传必须**反查确认**：任务 completed 只代表 biliLive-tools 提交完了，
          不代表 B站 真的写进去了。实测事故（2026-09-23）：
            同一稿件追加 4 次，任务全部 completed / error 为空 / output 是正确 aid，
            但 B站 分P 数只在第 1 次从 14 涨到 23，之后三次纹丝不动 ——
            「已完成」在 B站 侧什么都没发生，而项目每次都判成 PUBLISHED 并记 SUBMITTED。
          所以这里查一次分P 列表，确认待投标题真的出现了；不出现就如实报失败。 */
      let appendVerified: boolean | undefined;
      if (resumeAid) {
        appendVerified = await this.confirmPartTitlesLanded(resumeAid, titled.map((p) => p.title), log);
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
            `续传到稿件 aid=${resumeAid} **未在 ${Math.round(CONFIRM_APPEND_TIMEOUT_MS / 1000)}s 内确认落地**：` +
            `biliLive-tools 任务已完成（uploadTaskId=${res.taskId}），但 B站 侧还没查到新分P。` +
            `已知 B站 分P 列表有延迟（实测可达 20 分钟），所以这**不等于失败** —— ` +
            `已把切片记为「已提交待确认」，请稍后在创作中心核对；若确实没出现，可改用「新建稿件」方式重投`;
          log.warn(msg);
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
          this.ledger.setClipStatus(task.id, p.clipIndex, 'SUBMITTED', {
            uploadTaskId: res.taskId,
            submitTime: submitTimeMs,
            dtime,
            /* ★ 续传：这些切片就是目标稿件的分P（同 bvid、不同 cid），所以直接把该稿件的 bvid 写进台账。
               不写的话它们会永远停在 SUBMITTED 且无 bvid —— 周期性反查是**按稿件标题**找的，
               而分P 标题不是稿件标题，永远找不到；于是本场到不了 PUBLISHED，
               `cleanup.deleteAfterUpload`（用完即删）也就永远不触发（实测一场 20 GB 录播会一直留着）。 */
            ...(resumeAid && opts.resumeBvid ? { bvid: opts.resumeBvid, publishedAt: nowIso() } : {}),
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
      log.error(`多分P投稿失败：${msg}`, e);
      for (const p of titled) {
        if (p.kind === 'clip' && p.clipIndex !== undefined) {
          this.ledger.setClipStatus(task.id, p.clipIndex, 'FAILED', { failReason: `多分P投稿失败：${msg}` });
        }
      }
      return { ok: false, mainTitle, parts: titled, dtime, error: msg, warnings };
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
    opts: { timeoutMs?: number; intervalMs?: number } = {},
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
      /* 读不到就只能相信任务终态（否则会把成功的也判失败）—— 但要在日志里说明依据变弱了 */
      log.warn(`续传确认：读不到目标稿件 aid=${aid} 的分P 列表，**只能依据任务终态判定**（依据较弱）`);
      return true;
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
   * 为已提交（SUBMITTED）的切片反查 bvid。
   * 这是 SUBMITTED → PUBLISHED 的唯一合法依据（上传接口只返回 taskId）。
   */
  async confirmPublished(taskId: string, opts: { uid?: number | string } = {}): Promise<{
    confirmed: Array<{ clipIndex: number; bvid: string; title: string }>;
    pending: number[];
  }> {
    const task = this.ledger.getTask(taskId);
    if (!task) return { confirmed: [], pending: [] };
    const clips = this.ledger.getClips(taskId).filter((c) => c.status === 'SUBMITTED');
    if (clips.length === 0) return { confirmed: [], pending: [] };

    const archives = await this.client.biliArchives({ page: 1, pageSize: 100 });
    const confirmed: Array<{ clipIndex: number; bvid: string; title: string }> = [];
    const pending: number[] = [];

    for (const clip of clips) {
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
    return { confirmed, pending };
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
