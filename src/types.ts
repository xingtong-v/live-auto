/**
 * 全项目共享类型定义。
 *
 * 设计约束（见任务书 §3.4）：
 *  - 不使用 enum / namespace / 参数属性（Node 原生类型擦除是「仅可擦除语法」；
 *    enum 等会产出运行时代码的语法在 noEmit + erasableSyntaxOnly 下被禁止）。
 *  - 常量一律用 `as const` 对象 + 字面量联合类型表达。
 */

/* ============================================================================
 * 场级 / 切片级状态机（任务书 §8 WP6 步骤 1、WP5 步骤 5）
 * ========================================================================== */

/** 场级状态机：IDLE → RECORDED → TRANSCRIBED → ANALYZED → CLIPPED → PUBLISHED */
export const STAGES = ['IDLE', 'RECORDED', 'TRANSCRIBED', 'ANALYZED', 'CLIPPED', 'PUBLISHED'] as const;
export type Stage = (typeof STAGES)[number];

/** 场级状态 —— 在 STAGES 基础上叠加运行态与失败态 */
export type TaskStatus =
  | 'PENDING'      // 已发现，等待处理
  | 'RECORDED'     // 录制完成已确认（含下播确认）
  | 'TRANSCRIBING' // 转写中
  | 'TRANSCRIBED'  // 转写完成
  | 'ANALYZING'    // LLM 分析中
  | 'ANALYZED'     // 分析完成，等待人工确认（半自动）或自动排期
  | 'CLIPPING'     // 切片中
  | 'CLIPPED'      // 切片完成，等待投稿
  | 'PUBLISHING'   // 投稿中
  | 'PUBLISHED'    // 全部切片投稿完成（含完整版）
  | 'FAILED'       // 失败，可从失败阶段重跑
  | 'ARCHIVED'     // 归档（素材已清理）
  | 'CANCELED';    // 人工取消

/** 切片级子状态机（与场级并存） */
export type ClipStatus =
  | 'CANDIDATE'         // 仅候选，未勾选
  | 'PENDING_UPLOAD'    // 已确认发布，等待切片
  | 'CUTTING'           // 切片任务执行中
  | 'CUT'               // 切片产出完成
  | 'SUBMITTING'        // 已提交投稿，等待 taskId 落账（崩溃恢复的判定点）
  | 'SUBMITTED'         // 拿到 upload taskId
  | 'PUBLISHED'         // 反查到 bvid
  | 'FAILED'            // 失败
  | 'SKIPPED';          // 人工取消

/** 完整版上传状态（硬约束 #17：完成确认以 /bili/archives 反查为准） */
export type FullUploadStatus =
  | 'NOT_APPLICABLE'  // 未启用（由 biliLive-tools 自动上传）
  | 'WAITING'         // 等待压制产物
  | 'UPLOADING'       // 上传中（taskId 已拿到，仅作加速信号）
  | 'CONFIRMED'       // 已通过 /bili/archives 反查确认
  | 'FAILED';

/* ============================================================================
 * biliLive-tools API 原始响应（任务书 §4，字段名以实测为准）
 * ========================================================================== */

/** GET /record-history/recent-clips —— 驼峰字段 */
export interface RecentClip {
  id: string;
  title?: string;
  liveStartTime?: number;   // 秒
  recordStartTime?: number; // 毫秒
  recordEndTime?: number;   // 毫秒
  videoDuration?: number;   // 秒
  videoFilePath?: string;
  videoFileId?: string;
  videoFileExt?: string;
  videoFileSize?: number;
  videoFileUpdatedAt?: number;
}

/** GET /record-history/list —— 下划线字段（陷阱 #10：不要与驼峰混用） */
export interface RecordHistoryListItem {
  id: string;
  title?: string;
  live_start_time?: number;   // 秒
  record_start_time?: number; // 毫秒
  record_end_time?: number;   // 毫秒
  video_file?: string;
  video_duration?: number;
  danma_file?: string;
  danma_num?: number;
  interact_num?: number;
  danma_density?: number;
  live_id?: string | number;
}

/** GET /record-history/file/:id */
export interface RecordHistoryFile {
  videoFilePath?: string;
  videoFileExt?: string;
  videoFileSize?: number;
  videoFileUpdatedAt?: number;
  danmaFilePath?: string;
  danmaFileId?: string;
  danmaFileExt?: string;
}

/** POST /record-history/danma-file */
export interface DanmaFileRef {
  danmaFilePath?: string;
  danmaFileId?: string;
  danmaFileExt?: string;
}

/** GET /task/ 列表项 */
export interface TaskListItem {
  taskId: string;
  type?: string;
  status?: string;
  name?: string;
  desc?: string;
  output?: string;
  startTime?: number;
  endTime?: number;
  [k: string]: unknown;
}

/** GET /task/ 响应 */
export interface TaskListResponse {
  list?: TaskListItem[];
  runningTaskNum?: number;
  [k: string]: unknown;
}

/** 单任务状态（/task/:id） */
export interface TaskDetail {
  taskId: string;
  type?: string;
  status?: 'pending' | 'running' | 'completed' | 'error' | string;
  output?: string;
  output2?: string;
  error?: string;
  /** 任务自身的进度信息（不同任务类型字段不同） */
  progress?: number;
  [k: string]: unknown;
}

/** POST /bili/upload 返回：只有 taskId，没有稿件 id（陷阱 #11） */
export interface BiliUploadResponse {
  taskId: string;
}

/** GET /bili/archives 稿件列表项（幂等校验与 bvid 反查的唯一可靠来源） */
export interface ArchiveItem {
  bvid?: string;
  title?: string;
  desc?: string;
  ctime?: number;   // 秒
  pubtime?: number; // 秒
  state?: number;
  stat?: {
    view?: number;
    like?: number;
    coin?: number;
    favorite?: number;
    danmaku?: number;
    reply?: number;
    share?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** GET /bili/user/archive/:bvid 稿件详情（数据回流来源） */
export interface ArchiveDetail extends ArchiveItem {
  stat?: ArchiveItem['stat'];
}

/** GET /user/list 账号（文档写数组，实测可能是对象，两种都要兼容） */
export interface BiliUser {
  uid: number | string;
  name?: string;
  face?: string;
  expires?: number; // 毫秒
}

/** GET /preset/ffmpeg 预设项 */
export interface FfmpegPreset {
  id?: string;
  name?: string;
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

/** GET /preset/video 投稿预设 */
export interface VideoPreset {
  id?: string;
  name?: string;
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

/** GET /preset/danmu 弹幕预设 */
export interface DanmuPreset {
  id?: string;
  name?: string;
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

/* ============================================================================
 * 业务域模型
 * ========================================================================== */

/** 一个源视频分段（录制引擎可能按 duration 切成多个 flv） */
export interface SourceSegment {
  /** 绝对路径 */
  path: string;
  /** 该分段自身时长（秒），由 ffprobe 测得 */
  duration: number;
  /** 该分段在「本场全局时间轴」上的起始秒（按录制顺序累加得到） */
  globalStart: number;
  /** 该分段在全局时间轴上的结束秒 */
  globalEnd: number;
  size?: number;
}

/** 场次的源素材信息 */
export interface SourceMedia {
  /** 分段列表（单文件场景长度为 1） */
  segments: SourceSegment[];
  /** 全局总时长（秒） */
  totalDuration: number;
  /** 录制原始文件路径列表（flv/ts），转写与压缩前校验都读它们 */
  rawFiles: string[];
  /** 压制 / 转封装产物 mp4（可能不存在） */
  fullVideoPath?: string;
  /** 源 mp4 是否已烧弹幕（硬约束 #12，不允许运行时猜测） */
  fullVideoHasDanmaku: boolean;
  /** 弹幕 ASS（烧进画面用） */
  danmaAssPath?: string;
  /** 弹幕 XML（信号分析用） */
  danmaXmlPath?: string;
  danmaCount?: number;
}

/** 转写片段 */
export interface TranscriptSegment {
  start: number; // 相对视频起点的全局秒
  end: number;
  text: string;
}

/** 转写缺失区间 */
export interface TranscriptGap {
  start: number;
  end: number;
  reason: string;
}

/** POST /ai/subtitle 的分段缓存条目 */
export interface AsrCacheEntry {
  key: string;
  /** 缓存键组成成分，便于排查 */
  parts: {
    videoFilePath: string;
    videoFileSize: number;
    videoFileUpdatedAt: number;
    modelId: string;
    startTime: number;
    endTime: number;
    offset: number;
  };
  srt: string;
  segments: TranscriptSegment[];
  createdAt: string;
  /** 本次调用估算的音频时长（秒），用于成本估算 */
  audioSeconds: number;
}

/** transcript.json */
export interface Transcript {
  taskId: string;
  segments: TranscriptSegment[];
  gaps: TranscriptGap[];
  /** 转写来源，便于切换实现（§5.2 路径保持输出同构） */
  source: 'bililive-tools' | 'whisper-cpp' | 'local-funasr' | 'mock';
  modelId?: string;
  /** 弹幕时间基准偏移：弹幕时间 - 转写时间（§4.2 时间基准统一） */
  danmakuOffset?: number;
  /**
   * 术语表纠错命中明细（转写后的确定性替换）。
   *
   * 留痕的目的：用户改完术语表要知道"到底改没改到东西"，而不是凭感觉。
   * 只保留命中前 20 条，避免把 transcript.json 撑大。
   */
  glossaryCorrections?: Array<{ from: string; to: string; count: number }>;
  audioSeconds?: number;
  costEstimate?: number;
  createdAt: string;
}

/** 弹幕事件类型 */
export type DanmakuEventKind = 'danmaku' | 'superchat' | 'guard' | 'gift';

/** 归一化后的单条弹幕 */
export interface DanmakuItem {
  /** 相对视频起点的秒（已应用基准偏移） */
  time: number;
  /** 原始时间（相对开播时刻的秒） */
  rawTime: number;
  kind: DanmakuEventKind;
  text: string;
  user?: string;
  /** 高能事件的附加信息：价格 / 舰长等级 / 礼物名 */
  extra?: string;
  /** 数值权重（SC 金额、礼物价值） */
  value?: number;
}

/** 弹幕密度曲线上的一个采样点 */
export interface DensityPoint {
  start: number;
  end: number;
  count: number;
  /** 其中高能事件计数 */
  highEnergy: number;
}

/** 峰值窗口 */
export interface PeakWindow {
  start: number;
  end: number;
  count: number;
  /** 归一化强度 0–1 */
  intensity: number;
  /** 该窗口的热词 */
  keywords: string[];
}

/** signals.json —— WP2 的产出 */
export interface Signals {
  taskId: string;
  /** 弹幕与转写之间的基准偏移（秒）：转写时间 = 弹幕时间 - offset */
  danmakuOffset: number;
  /** XML 是否含 SC / 上舰 / 礼物事件（陷阱 #25） */
  eventSignalsAvailable: boolean;
  /** 事件类型统计 */
  eventCounts: Record<DanmakuEventKind, number>;
  density: DensityPoint[];
  peaks: PeakWindow[];
  /** 高频词（已剔除噪声词表） */
  keywords: Array<{ word: string; count: number }>;
  danmakuTotal: number;
  /** 视频总时长（秒），用于校验切片区间 */
  videoDuration: number;
  createdAt: string;
}

/** LLM 产出的候选切片（注意：没有 tid，只有分区文字） */
export interface ClipCandidate {
  start: number;
  end: number;
  title: string;
  desc: string;
  tags: string[];
  /** 分区文字描述，如「游戏/单机游戏」；由自研服务映射白名单 tid */
  category: string;
  score: number;
  reason: string;
  cover_ts?: number;
}

/** 落盘后的切片（含流水线状态） */
export interface ClipRecord extends ClipCandidate {
  index: number;
  /** 勾选状态（半自动模式由人工确认） */
  selected: boolean;
  status: ClipStatus;
  /** 降级产出（弹幕密度兜底） */
  degraded: boolean;
  /** 用户是否编辑过标题/时间/标签 */
  edited?: boolean;
  /** LLM 原始输出，用于 diff 与 prompt 迭代 */
  llmOriginal?: Pick<ClipCandidate, 'title' | 'start' | 'end' | 'tags'>;
  cutTaskId?: string;
  cutOutput?: string;
  uploadTaskId?: string;
  bvid?: string;
  /** 反查到 bvid 的时刻（ISO），用于「稿件表现数据回流」的近 N 天窗口判定 */
  publishedAt?: string;
  /**
   * 稿件已被删除 / 不可见（B站侧查不到）的判定时刻（ISO）。
   *
   * 为什么需要它：切片的 bvid 一旦记录就会长期留在台账里，用户删稿（或稿件被下架）后
   * 若不记住这个事实，每日的「表现数据回流」会对同一个已删 bvid 反复重试
   * （biliLive-tools 返回 HTTP 500 稿件不可见，还会按 retry 次数放大成 3 次请求），
   * 既刷屏又白费请求。记下来之后直接跳过。
   */
  archiveGoneAt?: string;
  /** 实际提交投稿的时刻（毫秒），dtime 的相对基准 */
  submitTime?: number;
  dtime?: number;
  /** 幂等指纹：sourceVideoId + start + end + titleHash（只记录在本地 ledger） */
  fingerprint?: string;
  /**
   * 被**墓碑**拦下的指纹（见 `ledger.ts` 的 `FingerprintTombstone`）。
   *
   * 语义：这个片段的内容以前已经投到 B站 过，而那次投稿所在的任务/切片已被用户删除。
   * 删除任务时会顺手清掉幂等指纹，于是「重新导入同一份素材 → 重新分析 → 同一区间」就会
   * 再投一次、在 B站 上变成重复稿件。墓碑就是拦这件事的：指纹退役后仍留在台账里继续生效。
   *
   * 有值 ⇒ 本次**故意没有投稿**（不是失败）。UI 要据此显示原因，并提供「解除墓碑」入口
   * （用户在创作中心确认那个稿件确实没了之后再解除）。
   */
  blockedByTombstone?: string;
  failReason?: string;
  createdAt?: string;
}

/** clips.json */
export interface ClipDecision {
  taskId: string;
  clips: ClipRecord[];
  /** LLM 完全不可用时的降级标记 */
  degraded: boolean;
  /** 选片使用的模型槽位 */
  modelUsed: string;
  /** 是否经历过契约校验失败后的升级重跑 */
  escalated: boolean;
  escalationNote?: string;
  createdAt: string;
}

/** 本场成本（ASR 为估算值，LLM 为实际 usage） */
export interface TaskCost {
  /** ASR 估算（元）—— 必须标注「估算值」 */
  asrEstimate: number;
  asrAudioSeconds: number;
  /** LLM 实际成本（元），由 usage 计算 */
  llmActual: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  llmCalls: number;
  updatedAt: string;
}

/** 场次任务台账 */
export interface TaskRecord {
  id: string;
  /** 录制 id（biliLive-tools 的 record-history id） */
  recordingId?: string;
  roomId: string;
  platform: string;
  title: string;
  /**
   * 本场主播名（分析阶段由 `detectStreamer` 识别，三类证据：录制目录名 / 弹幕热词 / 转写正文）。
   *
   * 为什么要有这个字段：术语表是跨主播的全局词表，提示词却是"本场"；
   * 不按场判定就会出现「甲主播的直播被总结成乙主播」这类错。识别不出来时为空字符串
   * （空 = 没有证据，界面与提示词都不注入，绝不猜）。
   */
  streamer?: string;
  /** 开播时刻（秒级时间戳） */
  liveStartTime?: number;
  recordStartTime?: number;
  recordEndTime?: number;
  /** 直播场次 id，用于把断流多段聚合为同一场（陷阱 #29） */
  liveId?: string;
  /**
   * 「在等 biliLive-tools 投出本场的完整版稿件」的等待标记。
   *
   * 为什么需要它：默认规则是「完整版由 biliLive-tools 投，切片助手只追加切片分P」，
   * 而它的压制 + 上传是异步的（实测录制结束后 13–15 分钟才出弹幕版），我们切片完成得更早。
   * 这期间本场停在 CLIPPED，等待循环每 5 分钟重查一次它的稿件；界面据此显示"在等什么"。
   */
  publishWait?: {
    since: string;
    until: string;
    reason: string;
    attempts: number;
  };
  /**
   * 任务是怎么来的：
   *   `recording` —— 轮询录制历史触发的（正常直播场次，UI 不打标记）
   *   `auto`      —— 目录轮询自动导入的（把录播丢进 watch 目录）
   *   `manual`    —— 人工导入的（UI「导入录播文件」/ CLI / MCP）
   *
   * 为什么要单列一个字段：自动导入与手动导入**走的是同一个 `importLocal()`**，
   * 早期只在里面写死 `manual: true`，于是界面上自动导入的任务也显示「手动导入」——
   * 用户根本分不清这条任务是"我自己点的"还是"它自己捡的"。
   */
  importSource?: 'recording' | 'auto' | 'manual';
  /**
   * 手动导入的任务（UI「导入录播文件」）。
   *
   * ⚠️ 历史字段，保留是为了读旧台账。**新代码请判断 `importSource`**：
   * 自动导入的任务同样走 `importLocal()`，早期实现把它也写成了 `manual: true`。
   */
  manual?: boolean;
  status: TaskStatus;
  /** 已完成的最高阶段，供 --from-stage 重跑使用 */
  stage: Stage;
  source: SourceMedia;
  /** 切片清单（与 clips.json 同步，便于台账单点读取；分析完成后写入） */
  clips?: ClipRecord[];
  transcriptPath?: string;
  signalsPath?: string;
  summaryPath?: string;
  clipsPath?: string;
  /** 完整版上传支线状态 */
  fullUpload: FullUploadStatus;
  fullUploadTaskId?: string;
  fullVideoBvid?: string;
  /** 合集 */
  seasonId?: number;
  sectionId?: number;
  cost: TaskCost;
  /** 当前阶段的细粒度进度，如「转写中 12/24」 */
  progress?: { label: string; current: number; total: number };
  /** 失败信息（同时写入 error-report） */
  error?: TaskErrorBrief;
  /** 本场覆盖设置（UI 的「本场设置」） */
  overrides?: {
    maxClips?: number;
    skipAutoPublish?: boolean;
    extraTags?: string[];
    /**
     * 逐任务例外：本场的完整版由**切片助手**投（自己烧弹幕版 + remux 纯享版，新建 2+N 稿件）。
     *
     * 默认（不设）走全局规则：完整版由 biliLive-tools 投，切片助手只把切片追加进它那个稿件。
     * 只有用户**明确说明**"这一场我来投"时才设成本字段。
     */
    fullVideoBy?: 'assistant';
    /**
     * 逐任务指定**续传目标稿件 aid**（本场的切片追加进哪个稿件）。
     *
     * 什么时候必须用它：biliLive-tools 投出的稿件标题不可信时 ——
     * 实测（2026-09-23 丙主播 场）它经「文件夹监控导入」进来的场次，稿件标题是
     * 「未知主播未知标题2026.09.23」，与我们的 `resumeTitleTemplate` 永远匹配不上，
     * 于是本场会一直等到超时。这时把创作中心里那个稿件的 aid 贴进来即可（确定性、不靠猜）。
     */
    resumeAid?: string;
  };
  /** 素材清理状态 */
  cleaned?: {
    rawDeletedAt?: string;
    fullVideoDeletedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

/** 台账里保存的失败摘要（完整报告在 error-report/ 目录） */
export interface TaskErrorBrief {
  reportId: string;
  stage: string;
  type: string;
  message: string;
  at: string;
  retries: number;
}

/* ============================================================================
 * 错误报告（任务书 §8 WP6 步骤 10）
 * ========================================================================== */

export type ErrorType =
  | 'network'
  | 'http-status'
  | 'timeout'
  | 'contract'
  | 'file-missing'
  | 'llm-unavailable'
  | 'asr-failed'
  | 'upload-failed'
  | 'disk'
  | 'auth'
  | 'config'
  | 'internal';

/** 单次重试记录 */
export interface RetryAttempt {
  attempt: number;
  at: string;
  type: ErrorType;
  message: string;
  /** 本次尝试使用的模型 / 端点，便于判断是否已升级 */
  model?: string;
}

/** 脱敏后的请求上下文 */
export interface RequestContext {
  method: string;
  url: string;
  /** 已脱敏的参数 */
  params?: unknown;
  status?: number;
  /** 响应体（>4KB 截断并记录原始长度） */
  responseBody?: string;
  responseTruncated?: boolean;
  responseOriginalLength?: number;
  durationMs?: number;
}

/** 环境快照 */
export interface EnvSnapshot {
  diskFreeBytes?: number;
  diskFreeGB?: number;
  diskTotalGB?: number;
  bililiveToolsVersion?: string;
  /** biliLive-tools 侧日志片段（切片/压制失败的真正原因在那边） */
  biliLiveToolsLogTail?: string;
  taskStatus?: string;
  stage?: string;
  ledgerEntries?: unknown;
  nodeVersion?: string;
  appVersion?: string;
  platform?: string;
  cwd?: string;
  /**
   * 片段级失败时带上是第几个片段。
   *
   * 为什么单独列出来：一场直播会切很多片，光看"切片失败"不知道是哪一个；
   * 而报告的时间线里`片段 #N`是复查时第一眼要找的东西。
   */
  clipIndex?: number;
  /** 片段级失败的台账原因（failReason 原文） */
  failReason?: string;
  /** 片段产物路径（便于直接去看那个文件还在不在） */
  cutOutput?: string;
}

/** 完整错误报告 */
export interface ErrorReport {
  reportId: string;
  taskId?: string;
  taskTitle?: string;
  stage: string;
  at: string;
  appVersion: string;
  bililiveToolsVersion?: string;

  error: {
    type: ErrorType;
    message: string;
    stack?: string;
    cause?: string;
  };

  request?: RequestContext;
  retries: RetryAttempt[];
  env: EnvSnapshot;

  /** 面向人工阅读的时间线（步骤 → 错误 → 重试） */
  timeline: Array<{
    at: string;
    step: string;
    ok: boolean;
    detail?: string;
    model?: string;
    elapsedMs?: number;
  }>;

  /**
   * 这份报告是**从 `errors.jsonl` 的事件行合成**的（原始报告文件已不存在）。
   *
   * 为什么需要它：报告文件会被清理、也可能写盘失败而没落盘，而事件行还在（事件行是
   * 同步追加的、最不容易丢）。界面若因此打不开就只剩一句"找不到报告"——等于把用户
   * 挡在门外。合成报告只含事件行里有的东西（时间/阶段/类型/消息/重试次数/应有路径），
   * 这个标记用来如实说明"细节没了，这不是原始报告"。
   */
  reportFileMissing?: boolean;
}

/* ============================================================================
 * LLM 契约（任务书 §5.5）
 * ========================================================================== */

/** 分块要点 */
export interface ChunkDigest {
  start: number;
  end: number;
  topics: string[];
  highlights: Array<{ time: number; what: string; why: string }>;
  /** 该时间段转写缺失的说明 */
  gapsNote?: string;
}

/** 选片 + 起标题的 LLM 原始输出契约 */
export interface SelectionOutput {
  summary: string;
  clips: ClipCandidate[];
}

/** LLM 调用计量 */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 命中缓存的输入 token（DeepSeek prompt caching） */
  cachedPromptTokens?: number;
  model: string;
  durationMs: number;
}

/** 模型槽位标识 */
export type ModelSlot = 'summary' | 'select';

/* ============================================================================
 * 通知 / 告警
 * ========================================================================== */

export type AlertLevel = 'info' | 'warn' | 'error' | 'recover';

export interface AlertPayload {
  level: AlertLevel;
  /** 告警键，用于去重与恢复通知配对 */
  key: string;
  title: string;
  body: string;
  taskId?: string;
  at: string;
  /** 附加字段（UI 可直接展示） */
  fields?: Record<string, string | number>;
}

/* ============================================================================
 * UI API 传输结构
 * ========================================================================== */

export interface ApiTaskSummary {
  id: string;
  title: string;
  roomId: string;
  when: string;
  durationSec: number;
  status: TaskStatus;
  statusText: string;
  stageIndex: number;
  progress?: { label: string; current: number; total: number };
  clipCount: number;
  publishedCount: number;
  selectedCount: number;
  degradedCount: number;
  cost: TaskCost;
  manual?: boolean;
  hasError: boolean;
  createdAt: string;
}

export interface ApiTaskDetail extends ApiTaskSummary {
  stage: Stage;
  stages: Array<'done' | 'active' | 'todo' | 'fail'>;
  summary?: string;
  signals?: Signals;
  transcriptPreview?: Array<{ time: string; text: string }>;
  clips: ClipRecord[];
  error?: TaskErrorBrief;
  errorReportPath?: string;
  source: {
    rawCount: number;
    rawTotalGB: number;
    fullVideoPath?: string;
    fullVideoExists: boolean;
    fullVideoHasDanmaku: boolean;
    danmaAss: boolean;
    danmaXml: boolean;
    diskNote?: string;
  };
  fullUpload: FullUploadStatus;
  fullVideoBvid?: string;
  seasonId?: number;
  schedule: Array<{
    clipIndex: number;
    title: string;
    dtime?: number;
    bvid?: string;
    status: ClipStatus;
  }>;
}
