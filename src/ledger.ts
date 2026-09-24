/**
 * 幂等台账（ledger）—— 「重复运行不产生重复稿件」这条验收标准的唯一依据。
 *
 * 设计要点（对应任务书 §8 WP2/WP4/WP5/WP6）：
 *  - **单一写入者**：data/ledger.json、data/decisions.jsonl、data/publish-log.jsonl、
 *    data/performance.jsonl、data/tasks/<taskId>/ 全部由本模块独占写入，其它模块只读。
 *  - **双依据去重**：`/bili/upload` 只返回 taskId 且任务队列在内存中（进程重启即丢），
 *    因此去重必须同时依赖「指纹」（clipFingerprint）与「标题」（publishedTitles），
 *    并保留 uploadTaskId → bvid 的映射。
 *  - **墓碑（tombstones）**：删除任务/切片时，**已经投出去过**的指纹不再直接丢弃，
 *    而是转成「墓碑」永久留在台账里继续拦重复投稿。见下方 `FingerprintTombstone` 的注释
 *    —— 这是「重复运行不产生重复稿件」在**用户主动删任务**这条路径上的最后一道防线。
 *  - **崩溃安全**：所有落盘走 writeJsonAtomic；ledger.json 解析失败时隔离成
 *    `ledger.json.corrupt-<时间戳>` 并以空台账继续，绝不抛异常炸掉服务。
 *  - **写盘节流**：updateTask / setClipStatus 这类高频调用只打脏标记，300ms 内合并为一次
 *    原子写；createTask / registerFingerprint / setClipStatus('SUBMITTING'|'SUBMITTED'|'PUBLISHED')
 *    等关键点立即同步写盘（可在投稿前保证「已提交」标记已经落地）。
 *
 * 说明：本模块不做任何网络请求，也不 import ./api.ts。
 */
import fs from 'node:fs';
import path from 'node:path';

import { log as defaultLogger } from './logger.ts';
import type { Logger } from './logger.ts';
import { STAGES } from './types.ts';
import type {
  ClipDecision,
  ClipRecord,
  ClipStatus,
  SourceMedia,
  Stage,
  TaskCost,
  TaskErrorBrief,
  TaskRecord,
  TaskStatus,
} from './types.ts';
import {
  DATA_DIR,
  DECISIONS_PATH,
  LEDGER_PATH,
  PERFORMANCE_PATH,
  appendJsonl,
  ensureDir,
  exists,
  fmtDate,
  fmtLocal,
  fnv1a,
  hashKey,
  nowIso,
  readJson,
  readJsonl,
  safeFileName,
  toMs,
  toPosixPath,
  writeJsonAtomic,
} from './util.ts';

/* ============================================================================
 * 路径与常量
 * ========================================================================== */

/** 投稿动作流水路径（util.ts 未定义，按 data/ 约定收在本模块） */
export const PUBLISH_LOG_PATH = path.join(DATA_DIR, 'publish-log.jsonl');

/** 每场任务目录下的固定文件名（目录由 ledger 创建，其它模块按此约定读写） */
export const TASK_FILES = {
  signals: 'signals.json',
  transcript: 'transcript.json',
  clips: 'clips.json',
  summary: 'summary.md',
  log: 'log.txt',
} as const;

/** 高频写盘的合并窗口（毫秒）：300ms 内的多次 update 合并成一次原子写 */
const FLUSH_DEBOUNCE_MS = 300;

/** 时间量化精度：0.1 秒（浮点抖动 1e-5 不应产生第二个指纹） */
const TIME_QUANTUM = 10;

/** publishedTitles 上限（超出按 FIFO 丢弃最旧的，避免台账无限膨胀） */
const PUBLISHED_TITLES_LIMIT = 2000;

/**
 * 墓碑数量的**告警**阈值（不是上限）。
 *
 * 刻意不设硬上限：墓碑的作用就是「永远记住这段内容投过」，一旦按 FIFO 丢掉最旧的，
 * 丢掉的那条恰好被重新投出去就是重复稿件 —— 这正是墓碑要防的事。
 * 单条墓碑约 200 字节，5000 条约 1 MB，对 ledger.json 完全可接受；
 * 真到了这个量级说明删了很多已投稿件，值得在日志里说出来。
 */
const TOMBSTONE_WARN_THRESHOLD = 5000;

/** lastSubmitTime 只回扫流水尾部这么多行，避免每次投稿都全量读文件 */
const SUBMIT_TAIL_SCAN = 500;

/** 切片级「关键点」：这些状态下必须立即同步落盘（崩溃恢复的判定点） */
const CLIP_CRITICAL_STATUSES: readonly ClipStatus[] = ['SUBMITTING', 'SUBMITTED', 'PUBLISHED'];

/* ============================================================================
 * 类型
 * ========================================================================== */

/** 立碑原因（谁把这条指纹退役的） */
export type TombstoneReason = 'task-deleted' | 'clip-deleted';

/**
 * 幂等指纹的**墓碑**。
 *
 * ## 为什么必须有它（真实漏洞，2026-09-24 分析发现）
 *
 * 去重的唯一本地依据是 `fingerprints` 表，而 `deleteTask()` / `deleteClip()` 原本会
 * **直接删掉**相关条目，理由是「避免以后重跑被误判为已投过而静默少投一稿」。
 * 这个理由对**没投出去过**的切片完全成立，但对**已经投出去过**的切片是致命的：
 *
 *   1. 用户删掉一个已投稿件的任务（`deleteTaskDir=true`）→ 指纹与标题一起被清掉；
 *   2. 同一份录播素材仍躺在 `import.watch.dirs` 里（或用户手动重新导入）→ 被当成新素材；
 *   3. 重新转写 + 重新分析，LLM 极可能给出**同样的时间区间**；
 *   4. `findFingerprint` 查不到 → 本地去重整条穿透；
 *   5. B站侧那道「按标题反查」也拦不住 —— 切片标题是 LLM 每次重新生成的，
 *      换个措辞就穿透（`publishAsMultiPart` 的注释里已记录过同类事故）。
 *
 *   结果：**B站 上出现第二个内容完全相同的稿件**。而 B站 没有删除稿件的开放接口，
 *   用户只能去创作中心手工处理 —— 这是本项目唯一会「污染线上」的漏洞。
 *
 * ## 语义
 *
 * - 只有**真的投出去过**的指纹才立碑。判据见 `wasSubmitted()`：指纹表里已有 bvid，
 *   或该切片当时的台账状态是 SUBMITTING / SUBMITTED / PUBLISHED。
 *   `SUBMITTING`（已发出请求、还没拿到 taskId 就崩了）算「投出去过」是**故意保守** ——
 *   无法确定那一次到底成没成，宁可少投也不能重复投。
 * - 没投出去过的指纹仍然像以前一样**直接删掉**，保证「删掉不满意的候选、重跑后还能投」。
 * - 墓碑**没有自动过期**，只能由人工显式解除（`releaseTombstone()`，UI 上有按钮）。
 *   解除前请先在创作中心确认那个稿件确实已经不存在了。
 */
export interface FingerprintTombstone {
  /** 退役前挂在哪个任务上 */
  taskId: string;
  clipIndex: number;
  /** 退役前的切片标题（人工辨认用；也是「为什么这段不能重投」的直观说明） */
  title?: string;
  /** 已经反查到的稿件号（有的话，UI 可以直接给出核对入口） */
  bvid?: string;
  /** 原登记时间 */
  at: string;
  /** 立碑时间 */
  retiredAt: string;
  reason: TombstoneReason;
  /** 立碑时该切片的台账状态（说明「投到哪一步」） */
  status: ClipStatus;
}

/** 墓碑 + 它自己的指纹（listTombstones 的返回形状，便于 UI 直接渲染） */
export interface TombstoneEntry extends FingerprintTombstone {
  fingerprint: string;
}

export interface LedgerFile {
  version: 1;
  updatedAt: string;
  tasks: Record<string, TaskRecord>;
  fingerprints: Record<string, { taskId: string; clipIndex: number; bvid?: string; at: string }>;
  /** 近期已用过的标题（投稿前按标题去重的本地依据） */
  publishedTitles: string[];
  /**
   * 已退役但**继续生效**的指纹（曾经投出去过，见 `FingerprintTombstone`）。
   *
   * 可选字段：老版本 ledger.json 里没有这一项，`normalizeLedgerFile` 会补成 `{}`。
   */
  tombstones?: Record<string, FingerprintTombstone>;
}

/**
 * 台账内的任务记录 = 共享类型 TaskRecord + ledger 追加的 clips 字段。
 *
 * 为什么把切片塞进台账：getClip / setClipStatus / stuckClips / bvidsNeedingPerformance
 * 都是按切片读取的，若只落 clips.json 则每次调用都要做 N 次文件 IO；同时「提交前先写
 * SUBMITTING」这一崩溃判定点也因此只需要一次原子写。
 * clips.json 仍然照写（流水线产物 / UI 展示），两者由本模块的 flush() 统一维护。
 */
export interface LedgerTaskRecord extends TaskRecord {
  clips?: ClipRecord[];
}

/** 选片决策的逐字段 diff（recordDecision 自动计算） */
export interface DecisionDiff {
  titleChanged: boolean;
  rangeChanged: boolean;
  tagsChanged: boolean;
  titleDiff: { from: string; to: string };
  rangeDiff: { fromStart: number; fromEnd: number; toStart: number; toEnd: number };
  tagsDiff: { added: string[]; removed: string[] };
}

export interface DecisionLlm {
  start: number;
  end: number;
  title: string;
  tags: string[];
  score: number;
  reason: string;
  category: string;
  degraded: boolean;
}

export interface DecisionFinal {
  start: number;
  end: number;
  title: string;
  tags: string[];
}

export interface DecisionInput {
  taskId: string;
  at?: string;
  clipIndex: number;
  llm: DecisionLlm;
  selected: boolean;
  final: DecisionFinal;
}

export interface DecisionEntry extends DecisionInput {
  at: string;
  /** 由 recordDecision 自动计算：final 与 llm 的逐字段 diff */
  diff: DecisionDiff;
}

export interface LedgerOptions {
  path?: string;
  decisionsPath?: string;
  publishLogPath?: string;
  performancePath?: string;
  logger?: Logger;
}

/* ============================================================================
 * 通用小工具
 * ========================================================================== */

/** 时间量化：四舍五入到 0.1 秒，吸收 LLM 重跑 / 浮点误差带来的抖动 */
function quantizeTime(sec: number): number {
  if (!Number.isFinite(sec)) return 0;
  return Math.round(sec * TIME_QUANTUM) / TIME_QUANTUM;
}

/** 标题归一化（用于 diff 与标题去重）：折叠空白 + 去首尾空格 */
function normalizeTitle(title: string | undefined): string {
  return (title ?? '').replace(/\s+/g, ' ').trim();
}

/** 标题去重键：在归一化基础上忽略大小写 */
function normalizeTitleKey(title: string | undefined): string {
  return normalizeTitle(title).toLowerCase();
}

/** 标签归一化 */
function normalizeTag(tag: string): string {
  return (tag ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 只覆盖「显式给出」的键：patch 里值为 undefined 视为「不修改」 */
function assignDefined<T extends object>(target: T, patch: Partial<T>): T {
  const dst = target as unknown as Record<string, unknown>;
  const src = patch as unknown as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const value = src[key];
    if (value !== undefined) dst[key] = value;
  }
  return target;
}

/** taskId 片段安全化（目录名不能带分隔符/通配符） */
function safeSegment(raw: string | number | undefined, maxLen = 48): string {
  const s = safeFileName(String(raw ?? '').replace(/\s+/g, '_'), maxLen);
  return s === 'untitled' ? '' : s;
}

/** 毫秒 → 本地 YYYYMMDD-HHmmss（人眼可读且排序友好） */
function stampLocal(ms: number): string {
  return fmtLocal(ms).replace(/[-:]/g, '').replace(' ', '-');
}

/** ISO 字符串 → 毫秒（失败返回 undefined） */
function parseIsoMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** 文件 mtime（毫秒），文件不存在返回 -1 */
function fileMtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

/** 任务的时间基准：recordStartTime（毫秒化）优先，缺失时退到 createdAt */
function taskTimeMs(rec: TaskRecord): number {
  return toMs(rec.recordStartTime) ?? parseIsoMs(rec.createdAt) ?? 0;
}

function emptyCost(): TaskCost {
  return {
    asrEstimate: 0,
    asrAudioSeconds: 0,
    llmActual: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    llmCalls: 0,
    updatedAt: nowIso(),
  };
}

function emptySource(): SourceMedia {
  return { segments: [], totalDuration: 0, rawFiles: [], fullVideoHasDanmaku: false };
}

function emptyLedger(): LedgerFile {
  return { version: 1, updatedAt: nowIso(), tasks: {}, fingerprints: {}, publishedTitles: [], tombstones: {} };
}

/**
 * 这条切片是否**真的投出去过** —— 决定删任务/删切片时「直接丢弃」还是「立碑」。
 *
 * 保守取向：三种状态都算「投出去过」。
 *  - `PUBLISHED` 已反查到 bvid，无疑问；
 *  - `SUBMITTED` 已拿到 upload taskId，B站 侧多半已经在处理；
 *  - `SUBMITTING` 是崩溃判定点 —— 请求可能已经发出去而我们没看到响应，
 *    无法确定成没成。此时若判成「没投过」并放行重投，最坏结果是重复稿件；
 *    判成「投过」并立碑，最坏结果是少投一稿且**界面上明确显示为什么**、可一键解除。
 *    两害相权，选后者（与 `setClipStatus` 里「宁可不投，不可重复投」一致）。
 */
function wasSubmitted(clip: { status?: ClipStatus; bvid?: string } | undefined, fpInfo?: { bvid?: string }): boolean {
  if (fpInfo?.bvid) return true;
  if (!clip) return false;
  if (clip.bvid) return true;
  return clip.status === 'SUBMITTING' || clip.status === 'SUBMITTED' || clip.status === 'PUBLISHED';
}

function round6(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(6)) : 0;
}

/* ============================================================================
 * 状态机（场级 / 切片级两级并存）
 * ========================================================================== */

/** 场级 stage 序（只用于判断「是否倒退」） */
const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s, i])) as Record<Stage, number>;

/** 场级 status 推进序：运行态夹在完成态之间 */
const TASK_RANK: Record<TaskStatus, number> = {
  PENDING: 0,
  RECORDED: 1,
  TRANSCRIBING: 2,
  TRANSCRIBED: 3,
  ANALYZING: 4,
  ANALYZED: 5,
  CLIPPING: 6,
  CLIPPED: 7,
  PUBLISHING: 8,
  PUBLISHED: 9,
  ARCHIVED: 10,
  FAILED: -1,
  CANCELED: -1,
};

/** status → 应同步推进到的 stage（运行态不推进 stage） */
const STAGE_FOR_STATUS: Partial<Record<TaskStatus, Stage>> = {
  RECORDED: 'RECORDED',
  TRANSCRIBED: 'TRANSCRIBED',
  ANALYZED: 'ANALYZED',
  CLIPPED: 'CLIPPED',
  PUBLISHED: 'PUBLISHED',
};

/** 场级迁移合法性：非法只 warn，仍然执行（人工重跑 / 降级兜底都需要） */
function isTaskTransitionLegal(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  // 任意状态都可以失败 / 取消 / 归档
  if (to === 'FAILED' || to === 'CANCELED' || to === 'ARCHIVED') return true;
  // 失败 / 取消后允许从失败阶段重跑
  if (from === 'FAILED' || from === 'CANCELED') return true;
  // 归档是终态
  if (from === 'ARCHIVED') return false;
  return TASK_RANK[to] > TASK_RANK[from];
}

/** 切片级迁移表（PENDING_UPLOAD → SUBMITTING → SUBMITTED → PUBLISHED） */
const CLIP_TRANSITIONS: Record<ClipStatus, ClipStatus[]> = {
  // CANDIDATE → SUBMITTING：全自动模式未勾选也直接投（publish.ts 的实际路径）
  CANDIDATE: ['PENDING_UPLOAD', 'SUBMITTING', 'SKIPPED', 'FAILED'],
  PENDING_UPLOAD: ['CUTTING', 'SUBMITTING', 'SKIPPED', 'FAILED'],
  // 切片失败允许回到待切重跑
  CUTTING: ['CUT', 'PENDING_UPLOAD', 'FAILED'],
  // CUT → SUBMITTED：投稿成功后直接进入已提交（publish.ts 的真实路径）
  CUT: ['SUBMITTING', 'SUBMITTED', 'SKIPPED', 'FAILED'],
  // 崩溃恢复：SUBMITTING 是判定点，允许回退到 CUT / PENDING_UPLOAD 或直接确认 SUBMITTED。
  // 也允许推进到 CUTTING —— publish.ts 是「先写 SUBMITTING（提交前落盘），再提交切片任务，成功后转 CUTTING」。
  SUBMITTING: ['CUTTING', 'CUT', 'SUBMITTED', 'PUBLISHED', 'PENDING_UPLOAD', 'FAILED'],
  SUBMITTED: ['PUBLISHED', 'SUBMITTING', 'FAILED'],
  PUBLISHED: ['FAILED'],
  FAILED: ['PENDING_UPLOAD', 'CUTTING', 'CUT', 'SUBMITTING', 'SUBMITTED', 'PUBLISHED', 'SKIPPED'],
  SKIPPED: ['CANDIDATE', 'PENDING_UPLOAD'],
};

function isClipTransitionLegal(from: ClipStatus, to: ClipStatus): boolean {
  if (from === to) return true;
  return CLIP_TRANSITIONS[from].includes(to);
}

/* ============================================================================
 * 幂等指纹与 taskId（纯函数，导出给流水线复用）
 * ========================================================================== */

/**
 * 幂等指纹：sourceVideoId + start + end + titleHash。
 *
 * ★ 只记录在本地 ledger 中，**绝不能**写进 `dynamic` / `desc` —— 这两个字段公开可见，
 *   把 fingerprint 塞进去等于把内部去重逻辑暴露给观众。
 *
 * 取整策略：start / end 先量化到 **0.1 秒**（保留一位小数后参与哈希），标题做
 * 「折叠空白 + 去首尾空格 + 忽略大小写」归一化。这样 LLM 重跑、JSON 往返、
 * 浮点累加造成的 1.50001 vs 1.5 抖动不会产生第二个指纹；而 100ms 以上的差异
 * （真正的不同片段）仍然区分得开。
 *
 * 返回值由两个独立 FNV-1a 拼接（64 位），把「指纹碰撞 → 漏发一个片段」的概率压到可忽略。
 */
export function clipFingerprint(input: { sourceVideoId: string; start: number; end: number; title: string }): string {
  const source = String(input.sourceVideoId ?? '').trim();
  const start = quantizeTime(input.start).toFixed(1);
  const end = quantizeTime(input.end).toFixed(1);
  const titleHash = fnv1a(normalizeTitleKey(input.title));
  const parts = `${source}|${start}|${end}|${titleHash}`;
  return `fp${hashKey([source, start, end, titleHash])}${fnv1a(`#${parts}#`)}`;
}

/**
 * 场级 taskId 生成：**优先用录制 id**，保证同一条录制被重复发现时得到同一个 taskId
 * （幂等的基础：createTask 才能识别「已经见过」）。
 *
 * 兜底顺序：recordingId → recordStartTime（秒/毫秒自适应）→ 录播文件路径。
 * 三段都缺失时退化为 `t_<roomId>_manual_<hash>`，此时只能靠房间号区分，**不可用于多场次**，
 * 调用方必须在手动导入场景显式传入 videoPath。
 *
 * 尾部 6 位哈希保证「不同原始键经文件名安全化后撞名」也不会互相覆盖。
 */
export function makeTaskId(input: {
  recordingId?: string;
  roomId: string;
  recordStartTime?: number;
  videoPath?: string;
}): string {
  const room = safeSegment(input.roomId, 24) || 'room';
  const recordingId = input.recordingId === undefined || input.recordingId === null ? '' : String(input.recordingId).trim();
  if (recordingId) {
    const key = `${room}|rec|${recordingId}`;
    return `t_${room}_${safeSegment(recordingId, 40) || 'rec'}_${fnv1a(key).slice(0, 6)}`;
  }
  const startMs = toMs(input.recordStartTime);
  if (startMs !== undefined) {
    const key = `${room}|start|${startMs}`;
    return `t_${room}_${stampLocal(startMs)}_${fnv1a(key).slice(0, 6)}`;
  }
  const videoKey = toPosixPath(String(input.videoPath ?? '')).toLowerCase();
  const key = `${room}|file|${videoKey}`;
  return `t_${room}_manual_${fnv1a(key).slice(0, 6)}`;
}

/**
 * 计算 final 相对 llm 的逐字段 diff（§8 WP4 步骤 8：用户编辑后的最终结果要可追溯）。
 * 时间同样按 0.1 秒量化，避免「看起来没改却报 rangeChanged」。
 */
export function diffDecision(llm: { start: number; end: number; title: string; tags: string[] }, final: { start: number; end: number; title: string; tags: string[] }): DecisionDiff {
  const fromTitle = normalizeTitle(llm.title);
  const toTitle = normalizeTitle(final.title);
  const fromStart = quantizeTime(llm.start);
  const fromEnd = quantizeTime(llm.end);
  const toStart = quantizeTime(final.start);
  const toEnd = quantizeTime(final.end);
  const fromTags = Array.isArray(llm.tags) ? llm.tags : [];
  const toTags = Array.isArray(final.tags) ? final.tags : [];
  const fromSet = new Set(fromTags.map(normalizeTag));
  const toSet = new Set(toTags.map(normalizeTag));
  const added = toTags.filter((t) => !fromSet.has(normalizeTag(t)));
  const removed = fromTags.filter((t) => !toSet.has(normalizeTag(t)));
  return {
    titleChanged: fromTitle !== toTitle,
    rangeChanged: fromStart !== toStart || fromEnd !== toEnd,
    tagsChanged: added.length > 0 || removed.length > 0 || fromTags.length !== toTags.length,
    titleDiff: { from: fromTitle, to: toTitle },
    rangeDiff: { fromStart, fromEnd, toStart, toEnd },
    tagsDiff: { added, removed },
  };
}

/* ============================================================================
 * 退出兜底：保证进程退出前把脏数据 flush 掉
 * ========================================================================== */

const LIVE_LEDGERS = new Set<WeakRef<Ledger>>();
let exitHookInstalled = false;

function registerExitHook(instance: Ledger): void {
  LIVE_LEDGERS.add(new WeakRef(instance));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const flushAll = (): void => {
    for (const ref of LIVE_LEDGERS) {
      const target = ref.deref();
      if (!target) continue;
      try {
        target.flush();
      } catch {
        /* 退出阶段不再抛错 */
      }
    }
  };
  // exit 钩子必须同步完成（writeJsonAtomic 是同步写），beforeExit 覆盖正常退出路径
  process.on('exit', flushAll);
  process.on('beforeExit', flushAll);
}

/* ============================================================================
 * Ledger
 * ========================================================================== */

export class Ledger {
  private readonly ledgerPath: string;
  private readonly decisionsPath: string;
  private readonly publishLogPath: string;
  private readonly performancePath: string;
  private readonly logger: Logger;

  private data: LedgerFile = emptyLedger();
  private loaded = false;
  /** 最近一次读/写后记录的磁盘状态，用于「外部改动则重载」 */
  private knownMtimeMs = -1;
  /**
   * taskId → 我们自己最后一次写 clips.json 的 mtime。
   * 只在「文件比这个时间还新」时才认为 clips.json 被外部（analyze.ts）改写过。
   */
  private selfWroteClipsMtime = new Map<string, number>();
  private knownSize = -1;

  private dirtyLedger = false;
  private readonly dirtyClipTasks = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  private titleIndex: Set<string> | null = null;
  private lastWriteErrorValue: string | undefined;
  private corruptBackup: string | null = null;

  /** 注意：不使用 TS 构造函数参数属性（erasableSyntaxOnly 不支持） */
  constructor(opts: LedgerOptions = {}) {
    this.ledgerPath = opts.path ?? LEDGER_PATH;
    // ★ 三个流水文件默认**跟随 ledger.json 所在目录推导**，而不是写死到全局 data/。
    //   否则「把 ledger 指到别处」（端到端测试、多实例、迁移数据目录）时，
    //   台账隔离了但 decisions/publish-log/performance 仍写到原处 ——
    //   表现为「今日投稿数」被上一次运行的历史数据污染，甚至误触每日上限。
    const baseDir = path.dirname(this.ledgerPath);
    this.decisionsPath = opts.decisionsPath ?? path.join(baseDir, 'decisions.jsonl');
    this.publishLogPath = opts.publishLogPath ?? path.join(baseDir, 'publish-log.jsonl');
    this.performancePath = opts.performancePath ?? path.join(baseDir, 'performance.jsonl');
    this.logger = opts.logger ?? defaultLogger;
    registerExitHook(this);
    // 首次构造时确保台账文件存在（哪怕只是空骨架）：
    // 否则「本进程还没有任务」与「台账文件被误删」在磁盘上无法区分，
    // 事后排查会缺少版本号与生成时间这两个锚点。
    if (!exists(this.ledgerPath)) {
      try {
        this.writeEmptyLedger();
      } catch {
        /* 写不进去不阻塞启动：第一次 createTask 还会再试 */
      }
    }
  }

  /** 落一份空台账骨架 */
  private writeEmptyLedger(): void {
    writeJsonAtomic(this.ledgerPath, {
      version: 1,
      updatedAt: nowIso(),
      tasks: {},
      fingerprints: {},
      publishedTitles: [],
      tombstones: {},
    } satisfies LedgerFile);
  }

  /** 台账文件绝对路径（其它模块只读时用它） */
  get path(): string {
    return this.ledgerPath;
  }

  /** 最近一次写盘失败原因（未恢复时为 undefined）；投稿前可用它做「台账不健康就别投」的判断 */
  get lastWriteError(): string | undefined {
    return this.lastWriteErrorValue;
  }

  /** 最近一次台账损坏隔离产生的备份路径 */
  get lastCorruptBackup(): string | null {
    return this.corruptBackup;
  }

  /* -------------------------------------------------------------------------
   * 读 / 写
   * ----------------------------------------------------------------------- */

  private stat(): { mtimeMs: number; size: number } | null {
    try {
      const st = fs.statSync(this.ledgerPath);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  /** 读全部（带缓存；文件被外部改动时按 mtime + size 重载） */
  load(): LedgerFile {
    const st = this.stat();
    const changed = st === null
      ? this.loaded && (this.knownMtimeMs !== 0 || this.knownSize !== 0)
      : !this.loaded || st.mtimeMs !== this.knownMtimeMs || st.size !== this.knownSize;
    if (!changed) return this.data;
    if (this.loaded && (this.dirtyLedger || this.dirtyClipTasks.size > 0)) {
      // ledger.ts 是独占写入者；外部改动通常意味着人工修复 / 另一个进程在写
      this.logger.warn('台账文件被外部改动，内存中未落盘的变更将被磁盘版本覆盖', {
        mod: 'ledger',
        data: { path: this.ledgerPath },
      });
    }
    this.readFromDisk();
    return this.data;
  }

  private readFromDisk(): void {
    const st = this.stat();
    if (!st) {
      // 文件不存在（首次运行 / 被手工删除）：以空台账继续
      this.data = emptyLedger();
      this.titleIndex = null;
      this.loaded = true;
      this.knownMtimeMs = 0;
      this.knownSize = 0;
      return;
    }
    let raw: unknown = null;
    let failure: string | null = null;
    try {
      raw = readJson<unknown>(this.ledgerPath);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (failure === null && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
      failure = '顶层不是 JSON 对象';
    }
    if (failure !== null) {
      // 损坏文件不得炸服务：隔离备份 + 空台账继续
      this.corruptBackup = this.quarantineCorrupt(failure);
      this.data = emptyLedger();
      this.titleIndex = null;
      this.loaded = true;
      this.knownMtimeMs = 0;
      this.knownSize = 0;
      return;
    }
    this.data = normalizeLedgerFile(raw as Partial<LedgerFile>);
    this.titleIndex = null;
    this.loaded = true;
    this.knownMtimeMs = st.mtimeMs;
    this.knownSize = st.size;
  }

  /** 把损坏的台账重命名成 ledger.json.corrupt-<时间戳>，返回备份路径 */
  private quarantineCorrupt(reason: string): string | null {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${this.ledgerPath}.corrupt-${stamp}`;
    try {
      fs.renameSync(this.ledgerPath, backup);
    } catch (err) {
      this.logger.error('台账已损坏且备份重命名失败，将以空台账继续', err, {
        mod: 'ledger',
        data: { path: this.ledgerPath, reason },
      });
      return null;
    }
    this.logger.error(`台账文件损坏（${reason}），已隔离备份并以空台账继续`, undefined, {
      mod: 'ledger',
      data: { path: this.ledgerPath, backup },
    });
    return backup;
  }

  /** 原子写回（严格模式：写失败会抛错，调用方据此决定是否中止后续动作） */
  save(): void {
    this.persistStrict();
  }

  /**
   * 立即写盘（宽松模式：写失败只记日志并保留脏标记，等下次重试）。
   * 退出钩子、节流到期、flush() 都走这里，保证不会把异常抛到进程退出流程里。
   */
  flush(): void {
    if (!this.dirtyLedger && this.dirtyClipTasks.size === 0) return;
    try {
      this.persistStrict();
    } catch {
      /* persistStrict 已记录日志；脏标记保留，下次 flush 重试 */
    }
  }

  private persistStrict(): void {
    this.clearTimer();
    try {
      // 先写切片明细，再写台账索引：崩溃时优先保留「已提交」这类判定点
      if (this.dirtyClipTasks.size > 0) {
        for (const taskId of [...this.dirtyClipTasks]) {
          this.writeClipsFile(taskId);
          this.dirtyClipTasks.delete(taskId);
        }
      }
      this.data.updatedAt = nowIso();
      writeJsonAtomic(this.ledgerPath, this.data);
      this.dirtyLedger = false;
      this.lastWriteErrorValue = undefined;
      const st = this.stat();
      if (st) {
        this.knownMtimeMs = st.mtimeMs;
        this.knownSize = st.size;
      }
    } catch (err) {
      this.lastWriteErrorValue = err instanceof Error ? err.message : String(err);
      this.logger.error('台账写盘失败', err, { mod: 'ledger', data: { path: this.ledgerPath } });
      throw err;
    }
  }

  private markDirty(taskId?: string): void {
    this.dirtyLedger = true;
    if (taskId) this.dirtyClipTasks.add(taskId);
    if (this.timer) return;
    // 刻意不 unref：300ms 内必然落盘；进程退出时另有 exit/beforeExit 兜底
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /* -------------------------------------------------------------------------
   * 任务目录
   * ----------------------------------------------------------------------- */

  /**
   * 任务目录的**路径**（不创建）。
   *
   * ⚠️ 只读路径必须用它，绝不能用 `taskDir()` —— 那个会 `ensureDir`。
   * 实测事故：删除任务时 `deleteTask()` 内部要读 clips.json → 走到 `taskFile()` →
   * `taskDir()` 把目录**又建了回来**，于是"任务目录已移入回收站"之后原地冒出一个空目录，
   * 用户在界面上勾了「任务目录」却发现它还在（界面上那个 ✗「任务目录也被真的删掉了」就是这么来的）。
   */
  taskDirPath(taskId: string): string {
    return path.join(path.dirname(this.ledgerPath), 'tasks', safeFileName(taskId, 96));
  }

  /**
   * 任务目录（不存在则创建）：<ledger 所在目录>/tasks/<taskId>。
   * 默认路径下即 util.ts 的 data/tasks —— 从 ledger 路径推导是为了让测试指向临时目录时
   * 任务目录也跟着走，不会污染真实 data/。
   */
  taskDir(taskId: string): string {
    const dir = this.taskDirPath(taskId);
    ensureDir(dir);
    return dir;
  }

  /** 任务目录下某文件的绝对路径 */
  taskFile(taskId: string, name: string): string {
    return path.join(this.taskDir(taskId), safeFileName(name, 64));
  }

  /** 任务目录下某文件的绝对路径（**不创建目录**，只读用） */
  taskFileReadonly(taskId: string, name: string): string {
    return path.join(this.taskDirPath(taskId), safeFileName(name, 64));
  }

  /* -------------------------------------------------------------------------
   * 场级
   * ----------------------------------------------------------------------- */

  private task(taskId: string): LedgerTaskRecord | undefined {
    return this.data.tasks[taskId] as LedgerTaskRecord | undefined;
  }

  private taskOrThrow(taskId: string): LedgerTaskRecord {
    const rec = this.task(taskId);
    if (rec) return rec;
    this.logger.error('台账中不存在该任务', undefined, { mod: 'ledger', data: { taskId } });
    throw new Error(`台账中不存在该任务：${taskId}`);
  }

  getTask(taskId: string): TaskRecord | undefined {
    this.load();
    return this.task(taskId);
  }

  listTasks(opts: { status?: TaskStatus[]; limit?: number; sinceMs?: number; search?: string } = {}): TaskRecord[] {
    this.load();
    let rows: TaskRecord[] = Object.values(this.data.tasks);
    const status = opts.status;
    if (status && status.length > 0) rows = rows.filter((t) => status.includes(t.status));
    const sinceMs = opts.sinceMs;
    if (typeof sinceMs === 'number' && Number.isFinite(sinceMs)) rows = rows.filter((t) => taskTimeMs(t) >= sinceMs);
    const search = opts.search;
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((t) =>
        [t.id, t.title, t.roomId, t.recordingId ?? ''].some((v) => String(v ?? '').toLowerCase().includes(q)),
      );
    }
    // 新的在前（recordStartTime 优先，缺失时退到 createdAt）
    rows = [...rows].sort((a, b) => taskTimeMs(b) - taskTimeMs(a));
    const limit = opts.limit;
    return typeof limit === 'number' && limit > 0 ? rows.slice(0, limit) : rows;
  }

  /** 新建任务（已存在则返回既有记录，不覆盖 —— 幂等） */
  createTask(rec: Partial<TaskRecord> & { id: string; roomId: string }): { record: TaskRecord; created: boolean } {
    this.load();
    const existing = this.task(rec.id);
    if (existing) {
      this.logger.debug('任务已存在，复用既有记录（幂等，不覆盖状态）', { taskId: rec.id, mod: 'ledger' });
      return { record: existing, created: false };
    }
    const now = nowIso();
    const record: LedgerTaskRecord = {
      id: rec.id,
      roomId: rec.roomId,
      platform: 'Bilibili',
      title: `${rec.roomId} 的直播场次`,
      status: 'PENDING',
      stage: 'IDLE',
      source: emptySource(),
      fullUpload: 'NOT_APPLICABLE',
      cost: emptyCost(),
      createdAt: now,
      updatedAt: now,
    };
    assignDefined(record, rec);
    // 主键与创建时间不可被 patch 改掉
    record.id = rec.id;
    record.createdAt = record.createdAt || now;
    record.updatedAt = now;
    this.data.tasks[record.id] = record;
    this.markDirty();
    // 新建即落盘：taskId 复用（幂等）依赖它
    this.persistStrict();
    this.taskDir(record.id);
    this.logger.info('新建场次任务', { taskId: record.id, stage: record.stage, mod: 'ledger', data: { roomId: record.roomId, title: record.title } });
    return { record, created: true };
  }

  /**
   * 局部更新并落盘。会自动刷新 updatedAt。
   * patch 中值为 undefined 的键视为「不修改」；任务不存在时抛错（调用方 bug，不静默造数据）。
   *
   * 注意：本方法只打脏标记（300ms 合并写），关键点请改用会立即落盘的方法或在之后调 flush()。
   */
  updateTask(
    taskId: string,
    patch: Partial<TaskRecord>,
    /**
     * 要**删除**的字段。`patch` 只能赋值（`assignDefined` 会跳过 undefined），
     * 所以"清掉某个可选字段"必须走这里 —— 例如等待标记 `publishWait`。
     * 写成 `{ publishWait: undefined }` 是**静默无效**的，实测踩过：
     * 标记清不掉 → 等待循环每 5 分钟把已经追加成功的场次又重投一次。
     */
    opts?: { unset?: Array<keyof TaskRecord> },
  ): TaskRecord {
    this.load();
    const rec = this.taskOrThrow(taskId);
    const before = rec.status;
    assignDefined(rec, patch);
    for (const key of opts?.unset ?? []) delete (rec as unknown as Record<string, unknown>)[key];
    rec.id = taskId;
    rec.updatedAt = nowIso();
    if (patch.status !== undefined && patch.status !== before && !isTaskTransitionLegal(before, patch.status)) {
      this.logger.warn(`任务状态非法迁移（仍执行）：${before} → ${patch.status}`, {
        taskId,
        mod: 'ledger',
        data: { from: before, to: patch.status },
      });
    }
    this.markDirty();
    return rec;
  }

  /** 状态迁移（含 stage 推进），非法迁移要 warn 但仍执行 */
  setStatus(taskId: string, status: TaskStatus, patch?: Partial<TaskRecord>): TaskRecord {
    this.load();
    const rec = this.taskOrThrow(taskId);
    const before = rec.status;
    if (before !== status && !isTaskTransitionLegal(before, status)) {
      this.logger.warn(`任务状态非法迁移（仍执行）：${before} → ${status}`, {
        taskId,
        mod: 'ledger',
        data: { from: before, to: status },
      });
    }
    rec.status = status;
    if (patch) {
      assignDefined(rec, patch);
      rec.id = taskId;
    }
    const stage = STAGE_FOR_STATUS[status];
    if (stage) this.advanceStage(rec, stage);
    if (status === 'PUBLISHED' && !rec.publishedAt) rec.publishedAt = nowIso();
    rec.updatedAt = nowIso();
    this.markDirty();
    // 终态属于关键点：立即落盘
    if (status === 'PUBLISHED' || status === 'FAILED' || status === 'ARCHIVED' || status === 'CANCELED') this.flush();
    return rec;
  }

  /** stage 推进：只允许向前（可重复设为同一 stage），倒退时 warn 但仍执行（--from-stage 重跑需要） */
  setStage(taskId: string, stage: Stage, patch?: Partial<TaskRecord>): TaskRecord {
    this.load();
    const rec = this.taskOrThrow(taskId);
    this.advanceStage(rec, stage);
    if (patch) {
      assignDefined(rec, patch);
      rec.id = taskId;
    }
    rec.updatedAt = nowIso();
    this.markDirty();
    this.flush();
    return rec;
  }

  private advanceStage(rec: LedgerTaskRecord, stage: Stage): void {
    const from = rec.stage;
    if (STAGE_INDEX[stage] < STAGE_INDEX[from]) {
      this.logger.warn(`stage 倒退（仍执行）：${from} → ${stage}`, {
        taskId: rec.id,
        mod: 'ledger',
        data: { from, to: stage },
      });
    }
    rec.stage = stage;
  }

  /** 记录失败（同时把 TaskErrorBrief 写进 task.error，并把状态置为 FAILED） */
  setError(taskId: string, err: TaskErrorBrief): TaskRecord {
    this.load();
    const rec = this.taskOrThrow(taskId);
    rec.error = { ...err };
    rec.status = 'FAILED';
    rec.updatedAt = nowIso();
    this.markDirty();
    this.flush();
    this.logger.debug('已记录失败摘要', {
      taskId,
      stage: err.stage,
      mod: 'ledger',
      data: { type: err.type, reportId: err.reportId, retries: err.retries },
    });
    return rec;
  }

  clearError(taskId: string): TaskRecord {
    this.load();
    const rec = this.taskOrThrow(taskId);
    delete rec.error;
    rec.updatedAt = nowIso();
    this.markDirty();
    return rec;
  }

  /** 累加本场成本（ASR 估算 / LLM 实际） */
  addCost(taskId: string, delta: Partial<TaskCost>): TaskRecord {
    this.load();
    const rec = this.taskOrThrow(taskId);
    const cur = rec.cost ?? emptyCost();
    rec.cost = {
      asrEstimate: round6((cur.asrEstimate ?? 0) + (delta.asrEstimate ?? 0)),
      asrAudioSeconds: round6((cur.asrAudioSeconds ?? 0) + (delta.asrAudioSeconds ?? 0)),
      llmActual: round6((cur.llmActual ?? 0) + (delta.llmActual ?? 0)),
      llmPromptTokens: Math.round((cur.llmPromptTokens ?? 0) + (delta.llmPromptTokens ?? 0)),
      llmCompletionTokens: Math.round((cur.llmCompletionTokens ?? 0) + (delta.llmCompletionTokens ?? 0)),
      llmCalls: Math.round((cur.llmCalls ?? 0) + (delta.llmCalls ?? 0)),
      updatedAt: nowIso(),
    };
    rec.updatedAt = nowIso();
    this.markDirty();
    return rec;
  }

  /* -------------------------------------------------------------------------
   * 幂等
   * ----------------------------------------------------------------------- */

  /** 该指纹是否已经投过（返回已有记录，便于日志说明「跳过重复」） */
  findFingerprint(fp: string): { taskId: string; clipIndex: number; bvid?: string; at: string } | undefined {
    this.load();
    return this.data.fingerprints[fp];
  }

  /** 登记指纹（幂等依据必须立刻落盘） */
  registerFingerprint(fp: string, info: { taskId: string; clipIndex: number; bvid?: string }): void {
    this.load();
    /* 墓碑存在的意义就是「这条指纹不该再被登记」。真走到这里说明**去重被绕过了**
       （典型：直接调 API 或跑了 tools/ 下的手工脚本），必须大声说出来 ——
       静默通过会让墓碑形同虚设，而后果是线上多一个重复稿件。 */
    const tomb = this.tombstoneMap()[fp];
    if (tomb) {
      this.logger.warn('⚠️ 正在登记一条**已立碑**的指纹：说明某条去重防线被绕过了，请核对 B站 上是否已出现重复稿件', {
        taskId: info.taskId,
        mod: 'ledger',
        data: { fp, clipIndex: info.clipIndex, tombstone: tomb },
      });
    }
    const prev = this.data.fingerprints[fp];
    if (prev) {
      if (prev.taskId !== info.taskId || prev.clipIndex !== info.clipIndex) {
        this.logger.warn('同一指纹被不同切片重复登记，保留首次登记（首次为准）', {
          taskId: info.taskId,
          mod: 'ledger',
          data: { fp, first: prev, next: info },
        });
      }
      if (info.bvid && !prev.bvid) prev.bvid = info.bvid;
    } else {
      this.data.fingerprints[fp] = {
        taskId: info.taskId,
        clipIndex: info.clipIndex,
        ...(info.bvid ? { bvid: info.bvid } : {}),
        at: nowIso(),
      };
    }
    // 顺手把切片自身的 fingerprint 字段补齐，避免两处不一致
    const rec = this.task(info.taskId);
    if (rec) {
      const clip = this.clipsArray(rec).find((c) => c.index === info.clipIndex);
      if (clip && !clip.fingerprint) clip.fingerprint = fp;
    }
    this.markDirty();
    this.flush();
    this.logger.debug('登记幂等指纹', {
      taskId: info.taskId,
      mod: 'ledger',
      data: { fp, clipIndex: info.clipIndex, bvid: info.bvid },
    });
  }

  /** 按标题反查本地已投稿记录（配合 GET /bili/archives 做双重去重） */
  hasPublishedTitle(title: string): boolean {
    this.load();
    const key = normalizeTitleKey(title);
    if (!key) return false;
    return this.titleSet().has(key);
  }

  rememberPublishedTitle(title: string): void {
    this.load();
    const raw = normalizeTitle(title);
    if (!raw) return;
    const key = normalizeTitleKey(raw);
    const set = this.titleSet();
    if (set.has(key)) return;
    set.add(key);
    this.data.publishedTitles.push(raw);
    if (this.data.publishedTitles.length > PUBLISHED_TITLES_LIMIT) {
      this.data.publishedTitles.splice(0, this.data.publishedTitles.length - PUBLISHED_TITLES_LIMIT);
      this.titleIndex = null;
    }
    this.markDirty();
    this.flush();
  }

  private titleSet(): Set<string> {
    if (!this.titleIndex) this.titleIndex = new Set(this.data.publishedTitles.map((t) => normalizeTitleKey(t)));
    return this.titleIndex;
  }

  /* -------------------------------------------------------------------------
   * 切片级
   * ----------------------------------------------------------------------- */

  /** 取任务下的切片数组；台账里没有 / clips.json 被**外部**改动时以该文件为准 */
  private clipsArray(rec: LedgerTaskRecord): ClipRecord[] {
    /* ⚠️ 这里必须是**只读**路径：`taskFile()` 会 ensureDir，而 deleteTask 也会走到本函数 ——
       已经移进回收站的任务目录会被它原地重建（实测）。 */
    const file = rec.clipsPath ?? this.taskFileReadonly(rec.id, TASK_FILES.clips);
    const mtime = fileMtimeMs(file);
    // analyze.ts 会直接重写 clips.json（不经过 ledger）；只有「文件比我们自己上次写它的时间还新」
    // 才算外部改动。用文件系统时间戳比较时必须留 1ms 容差 —— writeJsonAtomic 的
    // write+rename 在快速连续调用时可能拿到同一个 mtime。
    const selfWrote = this.selfWroteClipsMtime.get(rec.id) ?? -1;
    const external = mtime >= 0 && mtime > selfWrote + 1;
    if (Array.isArray(rec.clips) && !external) return rec.clips;
    if (mtime < 0) return Array.isArray(rec.clips) ? rec.clips : [];
    const doc = readJson<Partial<ClipDecision>>(file, {});
    const rows = doc && typeof doc === 'object' && Array.isArray(doc.clips) ? doc.clips : [];
    const clips: ClipRecord[] = rows.map((c, i) => ({ ...c, index: typeof c.index === 'number' ? c.index : i }));
    rec.clips = clips;
    rec.clipsPath = file;
    // 记录已接管这份文件的这个版本，避免重复读取把内存状态再覆盖一次
    this.selfWroteClipsMtime.set(rec.id, mtime);
    // 让 ledger.json 逐步收敛成「自包含」的台账（崩溃恢复时不必依赖 clips.json 是否还在）
    this.markDirty(rec.id);
    return clips;
  }

  /** 台账内的切片列表（getClips 的别名，导出给 UI / 流水线只读使用） */
  listClips(taskId: string): ClipRecord[] {
    return this.getClips(taskId);
  }

  /** 任务下的全部切片（台账里没有时从 clips.json 读入） */
  getClips(taskId: string): ClipRecord[] {
    this.load();
    const rec = this.task(taskId);
    return rec ? this.clipsArray(rec) : [];
  }

  getClip(taskId: string, clipIndex: number): ClipRecord | undefined {
    this.load();
    const rec = this.task(taskId);
    if (!rec) return undefined;
    return this.clipsArray(rec).find((c) => c.index === clipIndex);
  }

  /**
   * 切片级状态迁移。
   * SUBMITTING 是崩溃恢复的判定点：**调用方必须先写它再发起投稿**，
   * 因此这三种状态（SUBMITTING / SUBMITTED / PUBLISHED）会立即同步落盘。
   */
  setClipStatus(
    taskId: string,
    clipIndex: number,
    status: ClipStatus,
    patch?: Partial<ClipRecord>,
    /**
     * 要**删除**的字段。`patch` 只能赋值（`assignDefined` 会跳过 undefined），
     * 所以"清空某个可选字段"必须走这里 —— 例如用户把逐片排期时间清掉、改回自动排期。
     */
    opts?: { unset?: Array<keyof ClipRecord> },
  ): ClipRecord | undefined {
    this.load();
    const rec = this.task(taskId);
    if (!rec) {
      this.logger.warn('切片状态更新失败：任务不存在', { taskId, mod: 'ledger', data: { clipIndex, status } });
      return undefined;
    }
    const clip = this.clipsArray(rec).find((c) => c.index === clipIndex);
    if (!clip) {
      this.logger.warn('切片状态更新失败：切片不存在', { taskId, mod: 'ledger', data: { clipIndex, status } });
      return undefined;
    }
    const before = clip.status;
    if (before !== status && !isClipTransitionLegal(before, status)) {
      this.logger.warn(`切片状态非法迁移（仍执行）：${before} → ${status}`, {
        taskId,
        mod: 'ledger',
        data: { clipIndex, from: before, to: status },
      });
    }
    if (patch) assignDefined(clip, patch);
    for (const key of opts?.unset ?? []) delete (clip as unknown as Record<string, unknown>)[key];
    clip.index = clipIndex;
    clip.status = status;
    if (status === 'SUBMITTING' && !clip.submitTime) clip.submitTime = Date.now();
    if (status === 'PUBLISHED' && clip.bvid) this.syncFingerprint(clip, taskId, clipIndex);
    rec.updatedAt = nowIso();
    this.markDirty(taskId);
    /* ★ 立即落盘的两种情形：
     *   1. 关键状态（SUBMITTING / SUBMITTED / PUBLISHED）—— 崩溃恢复的判定点，
     *      写失败必须抛错让调用方中止（宁可不投，不可重复投）；
     *   2. **本次写入了 `cutOutput`**（切片产物路径）—— 真实事故（2026-09-23，30 分钟录播）：
     *      `CUT` 不在关键状态里，于是 `cutOutput` 只 `markDirty`（延迟 300ms 合并落盘）。
     *      而 `clipsArray()` 有一条「clips.json 的 mtime 比我们上次写它的时间新 ⇒ 重新读文件
     *      并**重建整个切片数组**」的规则（本意是跟上 analyze.ts 绕过 ledger 直接改文件）。
     *      这 300ms 窗口里只要该规则被触发，`cutOutput` 就随重建一起消失 ——
     *      现象是多分P 投稿报「没有任何可投稿的文件（完整版与切片都不可用）」，
     *      而日志里 6 个切片明明都"切片产出完成"了，一个分P 都投不出去。
     *      产物路径是"投出去"的唯一依据，必须和关键状态一样立刻固化。 */
    const wroteCutOutput = patch !== undefined && (patch as Partial<ClipRecord>).cutOutput !== undefined;
    if (CLIP_CRITICAL_STATUSES.includes(status) || wroteCutOutput) {
      // 写失败会抛错，调用方应据此中止投稿
      this.persistStrict();
    }
    this.logger.debug(`切片状态 → ${status}`, {
      taskId,
      mod: 'ledger',
      data: { clipIndex, from: before, bvid: clip.bvid, uploadTaskId: clip.uploadTaskId },
    });
    return clip;
  }

  /** 补全指纹表里的 bvid / 指纹（PUBLISHED 时调用） */
  private syncFingerprint(clip: ClipRecord, taskId: string, clipIndex: number): void {
    if (!clip.fingerprint) return;
    const entry = this.data.fingerprints[clip.fingerprint];
    if (!entry) {
      this.data.fingerprints[clip.fingerprint] = {
        taskId,
        clipIndex,
        ...(clip.bvid ? { bvid: clip.bvid } : {}),
        at: nowIso(),
      };
      return;
    }
    if (clip.bvid && !entry.bvid) entry.bvid = clip.bvid;
  }

  /**
   * 删除单条切片（用户在看板上直接删掉不想要的候选）。
   *
   * 三个刻意的设计：
   *  1. **不重排其它切片的 index**。`index` 是台账/decisions.jsonl/幂等指纹/UI 共同引用的稳定标识，
   *     删一条就把后面的号全挪一遍，会让已经写下的记录指向错误的切片（历史上就是这么踩的）。
   *     所以只从数组里摘掉那一条，其它 index 原样保留。
   *  2. **没投出去过的切片，连带清掉它的幂等指纹**。不清的话，用户删掉一条切片后重新分析
   *     又得到同一区间，会被指纹判成"已投过"而静默跳过（少投一稿且没有任何提示）。
   *  3. **投出去过的切片，指纹转成墓碑而不是丢弃** —— 见 `FingerprintTombstone`。
   *     用户删掉一个已经发布到 B站 的切片，稿件本身还在线上；此时若把指纹丢掉，
   *     重跑时会**再投一次同样的内容**，产生重复稿件。墓碑继续拦着，并在 UI 上说明原因、
   *     提供人工解除入口。
   */
  deleteClip(
    taskId: string,
    clipIndex: number,
  ): { deleted: ClipRecord; fingerprintsRemoved: number; fingerprintsTombstoned: number } | undefined {
    this.load();
    const rec = this.task(taskId);
    if (!rec) {
      this.logger.warn('删除切片失败：任务不存在', { taskId, mod: 'ledger', data: { clipIndex } });
      return undefined;
    }
    const all = this.clipsArray(rec);
    const at = all.findIndex((c) => c.index === clipIndex);
    if (at < 0) {
      this.logger.warn('删除切片失败：切片不存在', { taskId, mod: 'ledger', data: { clipIndex } });
      return undefined;
    }
    const [deleted] = all.splice(at, 1);
    let fingerprintsRemoved = 0;
    let fingerprintsTombstoned = 0;
    for (const [fp, info] of Object.entries(this.data.fingerprints)) {
      if (info.taskId !== taskId || info.clipIndex !== clipIndex) continue;
      delete this.data.fingerprints[fp];
      if (wasSubmitted(deleted, info)) {
        this.retireFingerprint(fp, info, {
          reason: 'clip-deleted',
          status: deleted?.status ?? 'PUBLISHED',
          ...(deleted?.title ? { title: deleted.title } : {}),
        });
        fingerprintsTombstoned++;
      } else {
        fingerprintsRemoved++;
      }
    }
    rec.updatedAt = nowIso();
    this.markDirty(taskId);
    this.flush();
    this.logger.info(
      `已删除切片 #${clipIndex}（「${deleted?.title ?? ''}」）：丢弃 ${fingerprintsRemoved} 条未投过的指纹` +
        (fingerprintsTombstoned > 0
          ? `，**${fingerprintsTombstoned} 条已投过的指纹转为墓碑**（同一区间不会再被投稿，如需重投请先在界面上解除）`
          : ''),
      { taskId, mod: 'ledger', data: { clipIndex, fingerprintsRemoved, fingerprintsTombstoned, remaining: all.length } },
    );
    return deleted ? { deleted, fingerprintsRemoved, fingerprintsTombstoned } : undefined;
  }

  /** 写入/覆盖整份切片列表（分析完成后落 clips.json 并同步进台账） */
  setClips(taskId: string, clips: ClipRecord[]): TaskRecord {
    this.load();
    const rec = this.taskOrThrow(taskId);
    rec.clips = clips.map((c, i) => ({ ...c, index: i, createdAt: c.createdAt ?? nowIso() }));
    rec.clipsPath = this.taskFile(taskId, TASK_FILES.clips);
    rec.updatedAt = nowIso();
    this.markDirty(taskId);
    // 分析产出是关键产物（重跑成本高），直接落盘
    this.flush();
    this.logger.info('切片列表已落账', {
      taskId,
      mod: 'ledger',
      data: { count: clips.length, selected: clips.filter((c) => c.selected).length },
    });
    return rec;
  }

  /** 把台账内的切片写回 clips.json（保留分析阶段写入的 modelUsed 等元信息） */
  private writeClipsFile(taskId: string): void {
    const rec = this.task(taskId);
    if (!rec) return;
    const clips = this.clipsArray(rec);
    const file = this.taskFile(taskId, TASK_FILES.clips);
    const rawPrev = exists(file) ? readJson<unknown>(file, {}) : {};
    const prev: Partial<ClipDecision> =
      rawPrev && typeof rawPrev === 'object' && !Array.isArray(rawPrev) ? (rawPrev as Partial<ClipDecision>) : {};
    const doc: ClipDecision = {
      taskId,
      clips,
      degraded: prev.degraded ?? clips.some((c) => c.degraded),
      modelUsed: prev.modelUsed ?? 'unknown',
      escalated: prev.escalated ?? false,
      createdAt: prev.createdAt ?? nowIso(),
    };
    if (prev.escalationNote !== undefined) doc.escalationNote = prev.escalationNote;
    writeJsonAtomic(file, doc);
    rec.clipsPath = file;
    // ★ 记下「这份文件是我们刚写的」。否则下一次 clipsArray 会看到 mtime 变新、
    //   误判成「外部改了 clips.json」，于是用文件内容覆盖内存里更新的切片状态 ——
    //   表现为状态推进丢失（切片已 PUBLISHED 但台账里仍是旧状态），
    //   进而让「全部切片发布完成后才可删素材」这类判定永远不成立。
    this.selfWroteClipsMtime.set(taskId, fileMtimeMs(file));
  }

  /* -------------------------------------------------------------------------
   * 任务删除与状态修复（UI 的任务管理入口）
   * ----------------------------------------------------------------------- */

  /**
   * 从台账中**彻底删除**一个任务。
   *
   * 只动台账，不碰文件系统 —— 文件由调用方（Orchestrator.deleteTask）按用户选择处理，
   * 这样「删记录但留素材」与「连素材一起删」两种语义不会混在一起。
   *
   * 指纹分两种处理（**这是「重复稿件」漏洞的堵点**）：
   *  - **没投出去过**：直接丢弃。这样用户删掉一场不想留的任务后，同一份素材重跑还能正常投。
   *  - **投出去过**：转成墓碑保留（见 `FingerprintTombstone`）。稿件还在 B站 线上，
   *    丢掉指纹等于给「重新导入同一份素材 → 重新分析 → 同一区间再投一次」开了绿灯。
   *
   * 标题同理：只有当**没有任何切片投出去过**时才从 `publishedTitles` 里移除。
   * 已发布的稿件标题在 B站 上仍然占着，本地把它忘掉只会削弱按标题反查这道防线。
   */
  deleteTask(taskId: string): {
    deleted: boolean;
    freedFingerprints: number;
    tombstonedFingerprints: number;
    title: string;
  } {
    this.load();
    const rec = this.task(taskId);
    if (!rec) return { deleted: false, freedFingerprints: 0, tombstonedFingerprints: 0, title: '' };
    const title = rec.title;

    /* 先判断本场有没有真的投出去过 —— 必须在 delete this.data.tasks 之前读切片。
       clipsArray 会顺带处理「clips.json 比台账新」的情况，所以这里拿到的是最终状态。 */
    const clips = this.clipsArray(rec);
    const clipByIndex = new Map(clips.map((c) => [c.index, c]));
    const anySubmitted = clips.some((c) => wasSubmitted(c));

    let freed = 0;
    let tombstoned = 0;
    for (const [fp, info] of Object.entries(this.data.fingerprints)) {
      if (info.taskId !== taskId) continue;
      delete this.data.fingerprints[fp];
      const clip = clipByIndex.get(info.clipIndex);
      if (wasSubmitted(clip, info)) {
        this.retireFingerprint(fp, info, {
          reason: 'task-deleted',
          status: clip?.status ?? 'PUBLISHED',
          ...(clip?.title ? { title: clip.title } : {}),
        });
        tombstoned++;
      } else {
        freed++;
      }
    }
    delete this.data.tasks[taskId];
    // 标题索引：只有在没有别的任务还用这个标题、且本场确实没投出去过时才移除
    const stillUsed = Object.values(this.data.tasks).some((t) => t.title === title);
    if (!stillUsed && !anySubmitted) {
      this.data.publishedTitles = this.data.publishedTitles.filter((t) => t !== title);
      this.titleIndex = null;
    }
    // 立即同步落盘：删除是不可逆操作，不能只打脏标记等 300ms 合并
    this.persistStrict();
    this.logger.info(
      `已从台账删除任务 ${taskId}（丢弃 ${freed} 条未投过的幂等指纹` +
        (tombstoned > 0 ? `，**${tombstoned} 条已投过的转为墓碑**，标题继续占用以免重复投稿` : '') +
        '）',
      { taskId, mod: 'ledger', data: { freedFingerprints: freed, tombstonedFingerprints: tombstoned, titleKept: anySubmitted } },
    );
    return { deleted: true, freedFingerprints: freed, tombstonedFingerprints: tombstoned, title };
  }

  /* -------------------------------------------------------------------------
   * 墓碑（已退役但继续生效的幂等指纹）
   * ----------------------------------------------------------------------- */

  /** 墓碑表（懒初始化：老 ledger.json 里没有 tombstones 字段） */
  private tombstoneMap(): Record<string, FingerprintTombstone> {
    if (!this.data.tombstones || typeof this.data.tombstones !== 'object') this.data.tombstones = {};
    return this.data.tombstones;
  }

  /**
   * 把一条指纹从「生效」转为「墓碑」。
   *
   * 只在 `deleteClip` / `deleteTask` 里调用，且只对**投出去过**的指纹调用。
   * 同一指纹若已有墓碑，保留**最早**的那一条（首次投稿的记录才是真正需要拦的依据），
   * 但补上这次新拿到的 bvid / 标题，便于人工核对。
   */
  private retireFingerprint(
    fp: string,
    info: { taskId: string; clipIndex: number; bvid?: string; at: string },
    extra: { reason: TombstoneReason; status: ClipStatus; title?: string },
  ): void {
    const map = this.tombstoneMap();
    const prev = map[fp];
    const next: FingerprintTombstone = {
      taskId: prev?.taskId ?? info.taskId,
      clipIndex: prev?.clipIndex ?? info.clipIndex,
      ...((prev?.title ?? extra.title) ? { title: prev?.title ?? extra.title } : {}),
      ...((prev?.bvid ?? info.bvid) ? { bvid: prev?.bvid ?? info.bvid } : {}),
      at: prev?.at ?? info.at,
      retiredAt: nowIso(),
      reason: prev?.reason ?? extra.reason,
      status: prev?.status ?? extra.status,
    };
    map[fp] = next;
    const n = Object.keys(map).length;
    if (n === TOMBSTONE_WARN_THRESHOLD || (n > TOMBSTONE_WARN_THRESHOLD && n % TOMBSTONE_WARN_THRESHOLD === 0)) {
      this.logger.warn(`墓碑数量已达 ${n} 条（ledger.json 会随之变大，但不影响正确性）`, {
        mod: 'ledger',
        data: { count: n },
      });
    }
    this.logger.info('指纹转为墓碑：同一录制区间不会再被投稿', {
      taskId: next.taskId,
      mod: 'ledger',
      data: { fp, clipIndex: next.clipIndex, title: next.title, bvid: next.bvid, reason: next.reason },
    });
  }

  /** 该指纹是否是墓碑（投稿前的最后一道本地防线） */
  findTombstone(fp: string): FingerprintTombstone | undefined {
    this.load();
    return this.tombstoneMap()[fp];
  }

  /** 全部墓碑（UI 列表 / 人工核对用），按立碑时间倒序 */
  listTombstones(): TombstoneEntry[] {
    this.load();
    const map = this.tombstoneMap();
    return Object.entries(map)
      .map(([fingerprint, t]) => ({ fingerprint, ...t }))
      .sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));
  }

  tombstoneCount(): number {
    this.load();
    return Object.keys(this.tombstoneMap()).length;
  }

  /**
   * **人工解除**墓碑 —— 允许同一区间重新投稿。
   *
   * 只在用户确认「B站 上那个稿件确实已经不存在了」之后才该调用。
   * 解除后会追加一条 `publish-log.jsonl` 流水留痕（action='tombstone-release'），
   * 这样「为什么当初又投了一遍」在事后永远查得到。
   */
  releaseTombstone(fp: string, opts: { note?: string } = {}): { ok: boolean; released?: FingerprintTombstone; error?: string; clearedClips?: number } {
    this.load();
    const map = this.tombstoneMap();
    const t = map[fp];
    if (!t) return { ok: false, error: '该指纹没有墓碑（可能已被解除，或从未投出去过）' };
    delete map[fp];
    /* ★ 同时把切片上的 `blockedByTombstone` 标记摘掉。
       不摘的话墓碑已经解除、界面却还挂着「🪦 墓碑拦截」的说明和按钮 ——
       用户会以为解除没生效（实测就是这个现象）。
       标记要连 clips.json 一起改，所以走 markDirty(taskId) 让 flush 写回文件。 */
    let clearedClips = 0;
    for (const [taskId, rec] of Object.entries(this.data.tasks)) {
      const clips = this.clipsArray(rec as LedgerTaskRecord);
      let hit = false;
      for (const c of clips) {
        if (c.blockedByTombstone !== fp) continue;
        delete c.blockedByTombstone;
        hit = true;
        clearedClips++;
      }
      if (hit) {
        rec.updatedAt = nowIso();
        this.markDirty(taskId);
      }
    }
    this.persistStrict();
    this.logger.warn(`已人工解除墓碑（该录制区间现在可以重新投稿）：${t.title ?? '(无标题)'}`, {
      taskId: t.taskId,
      mod: 'ledger',
      data: { fp, bvid: t.bvid, retiredAt: t.retiredAt, note: opts.note, clearedClips },
    });
    /* 留痕走 publish-log（与投稿流水同一份文件，事后按 taskId 串起来看很方便）。
       logPublish 的 action 是联合类型，这里显式扩一个值而不是复用 'confirm'
       —— 复用会让「本场投过几次」的统计把解除墓碑也算成一次投稿。 */
    this.logPublish({
      taskId: t.taskId,
      clipIndex: t.clipIndex,
      action: 'tombstone-release',
      title: t.title ?? '',
      fingerprint: fp,
      ...(t.bvid ? { bvid: t.bvid } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    });
    return { ok: true, released: t, clearedClips };
  }

  /**
   * 把任务从「运行态」修回一个稳定状态。
   *
   * 用途：进程被强杀（任务管理器结束、断电）后，台账会永久停在
   * `CLIPPING` / `TRANSCRIBING` 这类中间态，UI 上既不像失败也没有进度，
   * 重跑按钮也不会出现 —— 用户唯一的出路就是手改 json。
   * 这里按切片实际状态推断一个合理的落点。
   */
  repairStuckTask(taskId: string): { from: TaskStatus; to: TaskStatus; reason: string } {
    this.load();
    const rec = this.taskOrThrow(taskId);
    const from = rec.status;
    const clips = this.clipsArray(rec);
    const running: TaskStatus[] = ['TRANSCRIBING', 'ANALYZING', 'CLIPPING', 'PUBLISHING', 'PENDING', 'TRANSCRIBED', 'RECORDED'];
    if (!running.includes(from)) {
      return { from, to: from, reason: `状态 ${from} 不属于运行态，无需修复` };
    }

    let to: TaskStatus;
    let reason: string;
    const publishedCount = clips.filter((c) => c.status === 'PUBLISHED').length;
    if (['TRANSCRIBING', 'RECORDED', 'PENDING'].includes(from)) {
      to = 'RECORDED';
      reason = '转写未完成，回到 RECORDED（重跑会复用已缓存的分段，不会重复计费）';
    } else if (from === 'TRANSCRIBED' || from === 'ANALYZING') {
      to = 'TRANSCRIBED';
      reason = '分析未完成，回到 TRANSCRIBED';
    } else if (publishedCount > 0) {
      to = 'CLIPPED';
      reason = `已有 ${publishedCount} 个切片发布，回到 CLIPPED 以便继续处理剩余切片`;
    } else if (clips.length > 0) {
      to = 'ANALYZED';
      reason = '切片未完成，回到 ANALYZED（候选保留，可重新勾选发布）';
    } else {
      to = 'TRANSCRIBED';
      reason = '没有切片产出，回到 TRANSCRIBED';
    }

    rec.status = to;
    rec.progress = undefined;
    rec.updatedAt = nowIso();
    this.markDirty(taskId);
    this.persistStrict();
    this.logger.warn(`已修复卡住的任务状态：${from} → ${to}（${reason}）`, { taskId, mod: 'ledger' });
    return { from, to, reason };
  }

  /* -------------------------------------------------------------------------
   * 流水：选片决策 / 投稿动作 / 表现回流
   * ----------------------------------------------------------------------- */

  /** 选片决策记录（§8 WP4 步骤 8）：候选 + LLM 评分理由 + 是否勾选 + 用户编辑后的最终值 */
  recordDecision(entry: DecisionInput): void {
    const llm: DecisionLlm = { ...entry.llm, tags: [...(entry.llm.tags ?? [])] };
    const final: DecisionFinal = { ...entry.final, tags: [...(entry.final.tags ?? [])] };
    const row: DecisionEntry = {
      taskId: entry.taskId,
      at: entry.at ?? nowIso(),
      clipIndex: entry.clipIndex,
      llm,
      selected: entry.selected,
      final,
      // 自动计算：final 与 llm 的逐字段 diff
      diff: diffDecision(llm, final),
    };
    appendJsonl(this.decisionsPath, row);
    this.logger.debug('选片决策已记录', {
      taskId: entry.taskId,
      mod: 'ledger',
      data: {
        clipIndex: entry.clipIndex,
        selected: entry.selected,
        diff: row.diff,
      },
    });
  }

  readDecisions(opts: { taskId?: string; limit?: number } = {}): unknown[] {
    let rows = readJsonl<DecisionEntry>(this.decisionsPath);
    const taskId = opts.taskId;
    if (taskId) rows = rows.filter((r) => r && r.taskId === taskId);
    const limit = opts.limit;
    return typeof limit === 'number' && limit > 0 ? rows.slice(-limit) : rows;
  }

  /**
   * 投稿动作流水（崩溃恢复 + 每日计数），同步追加，保证崩溃前最后一条不丢。
   *
   * `action` 额外支持 `'tombstone-release'`（人工解除墓碑）。它**不是一次投稿**，
   * 所以绝不能复用 `'confirm'` —— 复用会让 `publishAsMultiPart` 里
   * 「本场已有 N 次投稿记录」的提醒把解除墓碑也算进去。
   */
  logPublish(entry: {
    taskId: string;
    clipIndex: number;
    action: 'submit' | 'confirm' | 'fail' | 'tombstone-release';
    at?: string;
    fingerprint?: string;
    uploadTaskId?: string;
    bvid?: string;
    title?: string;
    dtime?: number;
    error?: string;
    note?: string;
  }): void {
    const row: Record<string, unknown> = {
      taskId: entry.taskId,
      clipIndex: entry.clipIndex,
      action: entry.action,
      at: entry.at ?? nowIso(),
    };
    const optional = ['fingerprint', 'uploadTaskId', 'bvid', 'title', 'dtime', 'error', 'note'] as const;
    for (const key of optional) {
      const value = entry[key];
      if (value !== undefined) row[key] = value;
    }
    appendJsonl(this.publishLogPath, row);
    this.logger.debug(`投稿动作 ${entry.action}`, {
      taskId: entry.taskId,
      mod: 'ledger',
      data: { clipIndex: entry.clipIndex, bvid: entry.bvid, uploadTaskId: entry.uploadTaskId, error: entry.error },
    });
  }

  readPublishLog(opts: { sinceMs?: number; limit?: number } = {}): Array<Record<string, unknown>> {
    let rows = readJsonl<Record<string, unknown>>(this.publishLogPath);
    const sinceMs = opts.sinceMs;
    if (typeof sinceMs === 'number' && Number.isFinite(sinceMs)) {
      rows = rows.filter((r) => {
        const at = typeof r['at'] === 'string' ? Date.parse(r['at']) : Number.NaN;
        return Number.isFinite(at) && at >= sinceMs;
      });
    }
    const limit = opts.limit;
    return typeof limit === 'number' && limit > 0 ? rows.slice(-limit) : rows;
  }

  /**
   * 今日已投稿件数（投递成功口径，用于每日上限，§8 WP5 步骤 6）。
   *
   * 这里的去重必须同时满足两个互相拉扯的要求，两个方向都实测踩过坑：
   *   a) 同一稿件会写两条日志（submit 拿不到 bvid，confirm 才反查到）→ 必须折叠成 1，
   *      否则每日上限提前耗尽；
   *   b) 同一切片**确实可以投多次**（删稿重投、或先单投再并成多分P）→ 不能折叠。
   *      实测台账：同一天先单投 5 个切片，随后又把同样 5 个切片并成 1 个 6 分P 稿件，
   *      日志里 `(taskId, clipIndex)` 完全重复，正确值是 11 个稿件。
   *
   * 试过两种单键，都会错，记录在此以免回退：
   *   `${taskId}#${clipIndex}` → 把上面两批折叠成 6，**漏算**（11 算成 6，限流自律失效）；
   *   `bvid ?? uploadTaskId+clipIndex` → submit 行没有 bvid，与 confirm 配不上对，**过算**（11 算成 16）。
   *
   * 正确做法：按 `(taskId, clipIndex)` 分桶，**以「能唯一标识一次投稿的主键」计数**：
   *   submit 行 → `uploadTaskId`（一次投稿一个；旧日志缺它则退回 `dtime`，同批分P 相同）；
   *   confirm 行 → 只有**确实没有对应 submit** 时才计数（幂等命中：服务器已有同名稿件、
   *     本地没有 submit 行）。判断依据是跨桶的全局事实：一个 bvid 只要在 POST 之后反查到，
   *     本次运行必然为它写过一条 submit；因此「已被反查到的 bvid」一律视为已有归属，不再计数。
   *     ⚠️ 不能按「本桶内有没有对得上的 uploadTaskId」判断 —— 多分P 投稿时，每个分P 都写了
   *     submit 行，而反查用的是**主标题**（不是分P 标题），命中的那条稿件不属于任何一个分P 桶，
   *     按桶内判断会把它当成 6 个孤儿，实测 11 算成 16。
   *   两者都缺的畸形旧日志 → 按该桶「submit 行数与 confirm 行数的较大者」保守计数
   *   （宁可多算不漏算，每日上限偏保守是安全方向）。
   *
   * 走过的弯路（都实测出错，别再回去）：
   *   `max(submits行数, dtimes.size, uploads.size)` → submit 行数是「分P 个数」不是「稿件数」，
   *     6 分P 直接放大成 6（e2e 场景 17 抓到：11 算成 16）；
   *   `uploadTaskId ∪ bvid` 并集 → 两者是**同一次投稿的两个 id**，并集等于当成两次，
   *     5 个单投算成 10（同样被场景 17 抓到）；
   *   「桶内 confirm 按时间就近配对」→ 真实日志里 12:47 那次单投的 confirm（12:48:20）
   *     比 13:17 那次多分P 的 submit 更早，两批 (taskId, clipIndex) 又完全相同，
   *     配对必然错位，结果 11 算成 6；
   *   只按 `(taskId, clipIndex)` 折叠 → 删稿重投被吞掉，11 算成 6，每日上限失效。
   */
  todayPublishedCount(now: Date = new Date()): number {
    const today = fmtDate(now);
    type Row = { upload?: string; bvid?: string; dtime?: string };
    const buckets = new Map<string, { submits: Row[]; confirms: Row[] }>();
    const confirmedBvids = new Set<string>();
    for (const row of this.readPublishLog({ limit: PUBLISHED_TITLES_LIMIT })) {
      const action = String(row['action'] ?? '');
      if (action !== 'submit' && action !== 'confirm') continue;
      const at = typeof row['at'] === 'string' ? Date.parse(row['at']) : Number.NaN;
      if (!Number.isFinite(at) || fmtDate(new Date(at)) !== today) continue;
      const key = `${String(row['taskId'] ?? '')}#${String(row['clipIndex'] ?? '')}`;
      let b = buckets.get(key);
      if (!b) {
        b = { submits: [], confirms: [] };
        buckets.set(key, b);
      }
      const entry: Row = {};
      const upload = String(row['uploadTaskId'] ?? '');
      if (upload) entry.upload = upload;
      const bvid = String(row['bvid'] ?? '');
      if (bvid) entry.bvid = bvid;
      const dtime = row['dtime'];
      if (dtime !== undefined && dtime !== null && dtime !== '') entry.dtime = String(dtime);
      if (action === 'submit') {
        b.submits.push(entry);
      } else {
        b.confirms.push(entry);
        if (bvid) confirmedBvids.add(bvid);
      }
    }

    // 一个 bvid 最多被一个桶认领（防止同一条反查结果被多个分P 桶各扣一次）。
    const claimed = new Set<string>();
    let total = 0;
    for (const b of buckets.values()) {
      // 每条 submit 贡献一个投稿主键；同批多分P 共享 uploadTaskId / dtime，自动折成 1
      const keys = new Set<string>();
      for (const s of b.submits) {
        if (s.upload) keys.add(`up:${s.upload}`);
        else if (s.dtime !== undefined) keys.add(`dtime:${s.dtime}`);
      }
      // confirm 在三种情况下不额外计数：
      //   1) 显式带着本桶某条 submit 的 uploadTaskId → 就是同一次投稿；
      //   2) 它的 bvid 已被本桶（或更早的桶）认领过 → 同一次投稿的重复确认；
      //   3) 本桶有 submit 行，且该 bvid 能被某个有 submit 的桶认领
      //      （多分P 反查用**主标题**，命中的稿件不落在任何分P 桶，必须允许跨桶认领）。
      // 只有「谁也认领不了」的 confirm（幂等命中：服务器已有同名稿件、本地没有 submit 行）
      // 才是真实的额外稿件。
      const uploads = new Set(b.submits.map((s) => s.upload).filter((u): u is string => Boolean(u)));
      // 只有当**本桶确实投过稿**（有 submit 行）时，丢失的 confirm 才可能被本桶认领 ——
      // 幂等命中所在桶没有 submit，它的 bvid 不能被别人认领走。
      const canClaim = b.submits.length > 0;
      let extraConfirms = 0;
      for (const c of b.confirms) {
        if (c.upload && uploads.has(c.upload)) continue;
        if (c.bvid && claimed.has(c.bvid)) continue;
        if (c.bvid && canClaim) {
          claimed.add(c.bvid);
          continue;
        }
        extraConfirms += 1;
      }
      // 主键缺失的畸形旧日志：该桶按 submit/confirm 行数的较大者保守计数
      const keyless = Math.max(
        b.submits.filter((s) => !s.upload && s.dtime === undefined).length,
        b.confirms.filter((c) => !c.bvid && !c.upload).length,
      );
      total += keys.size + extraConfirms + keyless;
    }
    return total;
  }

  /** 最近一次投稿提交时刻（毫秒），用于「提交间隔随机抖动」 */
  lastSubmitTime(): number | undefined {
    const rows = readJsonl<Record<string, unknown>>(this.publishLogPath, SUBMIT_TAIL_SCAN);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row) continue;
      const action = String(row['action'] ?? '');
      if (action !== 'submit' && action !== 'confirm') continue;
      const at = typeof row['at'] === 'string' ? Date.parse(row['at']) : Number.NaN;
      if (Number.isFinite(at)) return at;
    }
    return undefined;
  }

  /** 稿件表现数据回流写入（§8 WP6 步骤 11） */
  recordPerformance(entry: {
    bvid: string;
    taskId?: string;
    clipIndex?: number;
    date: string;
    view?: number;
    like?: number;
    coin?: number;
    favorite?: number;
    danmaku?: number;
    reply?: number;
    share?: number;
  }): void {
    const row: Record<string, unknown> = {
      bvid: entry.bvid,
      date: entry.date,
      at: nowIso(),
    };
    const optional = ['taskId', 'clipIndex', 'view', 'like', 'coin', 'favorite', 'danmaku', 'reply', 'share'] as const;
    for (const key of optional) {
      const value = entry[key];
      if (value !== undefined) row[key] = value;
    }
    appendJsonl(this.performancePath, row);
    this.logger.debug('表现数据已回流', { taskId: entry.taskId, mod: 'ledger', data: { bvid: entry.bvid, date: entry.date, view: entry.view } });
  }

  readPerformance(opts: { sinceMs?: number; bvid?: string; limit?: number } = {}): unknown[] {
    let rows = readJsonl<Record<string, unknown>>(this.performancePath);
    const sinceMs = opts.sinceMs;
    if (typeof sinceMs === 'number' && Number.isFinite(sinceMs)) {
      // date 是本地日期（YYYY-MM-DD），按天粒度比较
      const from = fmtDate(sinceMs);
      rows = rows.filter((r) => String(r['date'] ?? '') >= from);
    }
    const bvid = opts.bvid;
    if (bvid) rows = rows.filter((r) => r['bvid'] === bvid);
    const limit = opts.limit;
    return typeof limit === 'number' && limit > 0 ? rows.slice(-limit) : rows;
  }

  /** 近 N 天已发布且尚未拉过数据的 bvid 列表（供 WP6 步骤 11 每日回流） */
  bvidsNeedingPerformance(days: number, now: Date = new Date()): Array<{ bvid: string; taskId: string; clipIndex: number }> {
    this.load();
    const windowDays = Number.isFinite(days) && days > 0 ? days : 1;
    const sinceMs = now.getTime() - windowDays * 86400_000;
    const today = fmtDate(now);
    // 当天已有回流记录的 bvid 直接跳过（每天只拉一次）
    const pulledToday = new Set<string>();
    for (const row of readJsonl<Record<string, unknown>>(this.performancePath)) {
      const bvid = typeof row['bvid'] === 'string' ? row['bvid'] : '';
      if (bvid && String(row['date'] ?? '') === today) pulledToday.add(bvid);
    }
    const out: Array<{ bvid: string; taskId: string; clipIndex: number }> = [];
    const seen = new Set<string>();
    for (const [taskId, taskRecord] of Object.entries(this.data.tasks)) {
      const rec = taskRecord as LedgerTaskRecord;
      for (const clip of this.clipsArray(rec)) {
        if (clip.status !== 'PUBLISHED' || !clip.bvid) continue;
        if (clip.archiveGoneAt) continue; // 已判定稿件不存在（被删/下架），不再反复请求
        if (seen.has(clip.bvid) || pulledToday.has(clip.bvid)) continue;
        const when = clip.submitTime ?? parseIsoMs(taskRecord.publishedAt) ?? parseIsoMs(taskRecord.updatedAt);
        if (when !== undefined && when < sinceMs) continue;
        seen.add(clip.bvid);
        out.push({ bvid: clip.bvid, taskId, clipIndex: clip.index });
      }
    }
    return out;
  }

  /* -------------------------------------------------------------------------
   * 对账 / 崩溃恢复
   * ----------------------------------------------------------------------- */

  /**
   * 周期对账（§8 WP2 步骤 2）：把「录制历史里发现但本地没有推进过」的记录挑出来。
   *
   * 判定：该 recordingId 对应的任务存在且已经离开 IDLE（或已进入终态）→ processed；
   * 否则（压根没建过任务，或建了仍停在 IDLE/PENDING）→ unprocessed。
   * 后者即使被重复返回也安全：createTask 幂等 + 指纹/标题双重去重保证不会重复投稿。
   */
  reconcile(input: { discoveredIds: string[] }): { unprocessed: string[]; processed: string[] } {
    this.load();
    const byRecordingId = new Map<string, TaskRecord>();
    for (const rec of Object.values(this.data.tasks)) {
      if (rec.recordingId === undefined || rec.recordingId === null) continue;
      byRecordingId.set(String(rec.recordingId), rec);
    }
    const unprocessed: string[] = [];
    const processed: string[] = [];
    const seen = new Set<string>();
    for (const raw of input.discoveredIds ?? []) {
      const id = String(raw ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const rec = byRecordingId.get(id);
      if (rec && this.isHandled(rec)) processed.push(id);
      else unprocessed.push(id);
    }
    this.logger.debug('周期对账完成', {
      mod: 'ledger',
      data: { discovered: seen.size, unprocessed: unprocessed.length, processed: processed.length },
    });
    return { unprocessed, processed };
  }

  private isHandled(rec: TaskRecord): boolean {
    if (rec.stage !== 'IDLE') return true;
    return rec.status === 'FAILED' || rec.status === 'ARCHIVED' || rec.status === 'CANCELED';
  }

  /** 崩溃恢复：找出卡在 SUBMITTING / CUTTING 的切片（§8 WP5 步骤 5） */
  stuckClips(): Array<{ taskId: string; clipIndex: number; status: ClipStatus; fingerprint?: string; uploadTaskId?: string }> {
    this.load();
    const out: Array<{ taskId: string; clipIndex: number; status: ClipStatus; fingerprint?: string; uploadTaskId?: string }> = [];
    for (const [taskId, taskRecord] of Object.entries(this.data.tasks)) {
      const rec = taskRecord as LedgerTaskRecord;
      for (const clip of this.clipsArray(rec)) {
        if (clip.status !== 'SUBMITTING' && clip.status !== 'CUTTING') continue;
        out.push({
          taskId,
          clipIndex: clip.index,
          status: clip.status,
          fingerprint: clip.fingerprint,
          uploadTaskId: clip.uploadTaskId,
        });
      }
    }
    return out.sort((a, b) => (a.taskId === b.taskId ? a.clipIndex - b.clipIndex : a.taskId.localeCompare(b.taskId)));
  }
}

/* ============================================================================
 * 台账文件归一化
 * ========================================================================== */

function normalizeLedgerFile(raw: Partial<LedgerFile>): LedgerFile {
  const tasks: Record<string, TaskRecord> = {};
  const rawTasks = raw.tasks;
  if (rawTasks && typeof rawTasks === 'object') {
    for (const [id, rec] of Object.entries(rawTasks)) {
      if (!rec || typeof rec !== 'object') continue;
      tasks[id] = rec;
    }
  }
  const fingerprints: LedgerFile['fingerprints'] = {};
  const rawFp = raw.fingerprints;
  if (rawFp && typeof rawFp === 'object') {
    for (const [fp, info] of Object.entries(rawFp)) {
      if (!info || typeof info !== 'object') continue;
      fingerprints[fp] = info;
    }
  }
  const publishedTitles = Array.isArray(raw.publishedTitles)
    ? raw.publishedTitles.filter((t): t is string => typeof t === 'string')
    : [];
  /* 墓碑：老版本 ledger.json 完全没有这一项 —— 必须容忍缺失，
     否则升级后第一次 load() 就会把已有台账判成损坏并隔离掉。 */
  const tombstones: Record<string, FingerprintTombstone> = {};
  const rawTomb = raw.tombstones;
  if (rawTomb && typeof rawTomb === 'object' && !Array.isArray(rawTomb)) {
    for (const [fp, info] of Object.entries(rawTomb)) {
      if (!info || typeof info !== 'object') continue;
      const t = info as Partial<FingerprintTombstone>;
      // 缺 taskId / retiredAt 的脏条目直接丢弃：留着也无法向用户解释它是谁
      if (typeof t.taskId !== 'string' || typeof t.retiredAt !== 'string') continue;
      tombstones[fp] = {
        taskId: t.taskId,
        clipIndex: typeof t.clipIndex === 'number' ? t.clipIndex : -1,
        ...(typeof t.title === 'string' ? { title: t.title } : {}),
        ...(typeof t.bvid === 'string' ? { bvid: t.bvid } : {}),
        at: typeof t.at === 'string' ? t.at : t.retiredAt,
        retiredAt: t.retiredAt,
        reason: t.reason === 'clip-deleted' ? 'clip-deleted' : 'task-deleted',
        status: (t.status ?? 'PUBLISHED') as ClipStatus,
      };
    }
  }
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    tasks,
    fingerprints,
    publishedTitles,
    tombstones,
  };
}

/** 全局单例（daemon / CLI 用），路径取 util.ts 的默认值 */
export const ledger = new Ledger();
