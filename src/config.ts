/**
 * 配置加载 / 校验 / 热加载。
 *
 * - 单一事实来源：config.json（含凭据，已 gitignore）+ config.example.json（模板，无凭据）
 * - 环境变量覆盖：LIVE_AUTO_* 前缀（供启动脚本在不落盘的情况下注入 passkey）
 * - 热加载：mtime 变化即重载（§8 WP6 步骤 9）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_EXAMPLE_PATH, CONFIG_PATH, ROOT_DIR, clone, exists } from './util.ts';
import { log as globalLog } from './logger.ts';

/* ---------------------------------------------------------------------------
 * 配置结构
 * ------------------------------------------------------------------------- */

export interface BililiveConfig {
  baseUrl: string;
  passKey: string;
  versionExpected: string;
  versionDriftWarn: boolean;
  timeoutMs: number;
  asrTimeoutMs: number;
  retry: number;
}

export interface RoomConfig {
  roomId: string;
  platform: string;
  pollIntervalSec: number;
  reconcileIntervalMin: number;
  liveCheckIntervalSec: number;
  offlineConfirmSec: number;
  registerStreamerHint: boolean;
}

export type RecorderType = 'builtin' | 'bililiverecorder' | 'blrec' | 'ddtv' | 'oneliverec' | 'custom';

export interface RecorderConfig {
  type: RecorderType;
  webhookTargets: string[];
  forwardTo: string;
  eventLogPath: string;
  recentClipsWindow: number;
  recordHistoryPageSize: number;
}

export interface DanmakuConfig {
  densityWindowSec: number;
  peakTopN: number;
  peakMinIntensity: number;
  keywordTopN: number;
  noiseWords: string[];
  danmakuOffsetSec: number | 'auto';
  offsetCalibrationSeconds: number;
  /**
   * DanmakuFactory.exe 路径（biliLive-tools 自带）。
   *
   * 用于把弹幕 XML 转成可烧录的 ASS。留空时会自动探测
   * biliLive-tools 安装目录下的 `resources/app.asar.unpacked/resources/bin/DanmakuFactory.exe`；
   * 都找不到时退化为内置的朴素转换实现（链路不断，但样式简单）。
   *
   * ⚠️ 实测：DanmakuFactory 的 XML→ASS 直转会丢内容（891 条只出 115 条），
   * 必须走 JSON 中转；`src/danmaku-ass.ts` 已自动处理这个回退。
   */
  factoryPath: string;
  /** 烧进画面的弹幕字号（不传则按分辨率推算） */
  fontSize: number;
}

export interface SilenceTrimConfig {
  enabled: boolean;
  noiseDb: number;
  minSilenceSec: number;
  paddingSec: number;
  ffmpegPath: string;
}

export interface AsrConfig {
  /**
   * 转写提供方：
   *  - `bililive-tools`：走 biliLive-tools 的 `/ai/subtitle`（云端 DashScope，**按小时计费**，默认）；
   *  - `whisper-cpp`：本地 faster-whisper（免费；同素材实测 CER ≈16.7%）；
   *  - `local-funasr`：本地阿里云开源 **Fun-ASR-Nano**（免费；同素材实测 CER ≈8.8%、
   *    时间戳偏差 ±0.2s，代价是慢约 5 倍）。部署：`node tools/local-asr/setup-funasr.mjs`。
   */
  provider: 'bililive-tools' | 'whisper-cpp' | 'local-funasr';
  segmentMinutes: number;
  overlapSeconds: number;
  /**
   * 转写结果为空时是否继续（默认 **false**）。
   *
   * 实测事故：biliLive-tools 里换了语音识别模型导致上游一直 400，26.5 分钟的录播转写为空，
   * 而流水线继续用弹幕密度兜底出片 —— 没字幕、选片也不可信，等于出了"不该出的片"。
   * 所以默认直接失败并给出排查方向；确实只想靠弹幕出片的人再显式打开。
   */
  allowEmptyTranscriptFallback: boolean;
  concurrency: number;
  maxRetries: number;
  modelId: string;
  cacheDir: string;
  /**
   * ASR 计费单价（元/小时），仅用于**估算**展示与台账记账（服务端不给账单）。
   *
   * 实测校准（2026-09-23）：biliLive-tools 走的是阿里云 DashScope，模型 `fun-asr`，
   * 实际单价约 **¥0.00022/秒 = ¥0.79/小时**。项目原先默认 2.0 是**高估 2.5 倍**，
   * 会让界面上的"预计花费"和台账 ASR 费用明显偏大（一场 4 小时直播虚高约 ¥5）。
   * 若将来换了更贵的模型（如录音文件识别极速版），按新单价改这里即可。
   */
  unitPricePerHour: number;
  inputSource: 'raw' | 'full';
  silenceTrim: SilenceTrimConfig;
  whisperCpp: {
    /** Python 解释器路径（本地执行器是 Python 脚本）。留空 = 用项目内 .venv-asr */
    binaryPath: string;
    /** 模型缓存目录（HuggingFace 缓存目录，不是单个模型文件）。留空 = 用项目内 .venv-asr/models */
    modelPath: string;
    /** 模型名（HuggingFace 上的 CTranslate2 仓库名） */
    model: string;
    language: string;
    threads: number;
    extraArgs: string[];
    /** auto = 先试 CUDA（失败退 CPU）| cuda | cpu */
    device: string;
    /** auto | float16 | int8_float16 | int8 —— CPU 上只能用 int8/float32 */
    computeType: string;
    /** 束搜索宽度：越大越准也越慢（实测 4 小时素材在 beam=5 下约 7 分钟） */
    beamSize: number;
    /** 是否启用 VAD 去静音（能显著减少长音频里的复读式幻觉） */
    vadFilter: boolean;
  };
  /**
   * 本地 Fun-ASR-Nano（阿里云开源）参数。`provider='local-funasr'` 时生效。
   *
   * 与 whisper 分开一块而不是塞进 `whisperCpp`：两者的模型/依赖/参数含义完全不同
   * （whisper 是 CTranslate2 + HF 缓存目录，Fun-ASR 是 ModelScope 仓库 + 独立 venv）。
   */
  localFunasr: {
    /** Python 解释器路径。留空 = 项目内 `.venv-funasr`（由 setup-funasr.mjs 创建） */
    pythonPath: string;
    /** ModelScope 模型 id */
    model: string;
    /** ms = ModelScope（国内快）| hf */
    hub: string;
    /** auto = 有 CUDA 就用 | cuda | cpu */
    device: string;
    /** auto（优先 vLLM，失败退 PyTorch）| vllm | pytorch */
    engine: string;
    /** 每条字幕最多几个字（按标点切句时的上限，与字幕排版保持一致） */
    maxCharsPerCue: number;
    /** 每条字幕最短显示时长（秒） */
    minCueDur: number;
    /** 是否要字级时间戳（关掉会退化成 VAD 段粒度，时间戳偏差从 ±0.2s 恶化到 ±2s） */
    timestamps: boolean;
    /**
     * 是否把**术语表**当热词喂给 Fun-ASR（它原生支持 `hotwords`，其它 provider 不具备）。
     *
     * 为什么默认开：转写错字的两个消费者（选片 LLM、标题/标签生成）里，
     * 专有名词错得最扎眼；而热词是**零新依赖、零显存、零幻觉风险**的一档提升 ——
     * 不改模型、不改流程，只是把用户已经在维护的词表顺路带过去
     * （此前 `tools/local-asr/transcribe-funasr.py` 一直收得到这个字段，
     * 而 TS 侧从来没传过：能力在，线没接）。
     */
    hotwordsEnabled: boolean;
    /** 最多传多少个热词（热词不是越多越好：太多会把解码带偏，且拖慢） */
    hotwordsMax: number;
    /**
     * 每块多长（分钟）。Fun-ASR 的模型加载约 96 秒是**固定成本**，所以默认取很大的值
     * （360 = 6 小时，普通录播一场就是**一块**），避免重复加载。
     */
    chunkMinutes: number;
    /**
     * 同时跑几个进程。**默认 1（单块不并行）** —— 这是实测结论，不是保守取值：
     *
     * | 配置 | 1800 秒音频总耗时 |
     * | --- | --- |
     * | 单进程整块 | ≈ 396 秒（96 秒加载 + 300 秒推理） |
     * | 3 块 × 2 路并行 | ≈ 700 秒以上（更慢） |
     *
     * 原因：① 每个进程都要自己加载一遍模型；② 两个进程抢**同一块 GPU**，
     * 各自都变慢，净收益为负。只有在多张显卡（每进程绑不同卡）时并行才有意义。
     */
    parallel: number;
    /** 单次调用超时（秒）—— 4 小时素材在 PyTorch 路径下约 43 分钟，给足余量 */
    timeoutSec: number;
  };
}

export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export interface LlmConfig {
  preset: 'deepseek' | 'aliyun' | 'zhipu' | 'ollama' | 'custom';
  summary: LlmEndpoint;
  select: LlmEndpoint;
  chunkMinutes: number;
  chunkConcurrency: number;
  consecutiveFailureThreshold: number;
  pricing: {
    currency: string;
    summary: { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion: number };
    select: { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion: number };
  };
  recordRawResponses: boolean;
}

/** 字幕烧录样式（仅影响观感，不影响硬约束） */
export interface SubtitleConfig {
  /** 字号，0 = 按分辨率自动推算 */
  fontSize: number;
  /** 距画面底部边距（像素），0 = 自动 */
  marginV: number;
  /** 每行最大字宽（中文按 1 算） */
  maxCharsPerLine: number;
  /** 单条字幕最短显示时长（秒），防止 ASR 碎片一闪而过 */
  minDurationSec: number;
  /**
   * 阅读速度（字/秒）：单条字幕的展示时长按"这句话要读多久"来定。
   * 这是「字幕和声音对不上」的根治点 —— 时长跟着字数走，
   * 而不是让 ASR 的大段落（几十个字）硬占满整段时间。
   */
  readingCharsPerSec: number;
  /** 字体 */
  fontName: string;
}

/** 手动导入录播的扫描设置 */
export interface ImportConfig {
  /**
   * 额外扫描目录（会自动叠加 biliLive-tools 自己的录制目录与 `~/Downloads/Bilibili`）。
   *
   * 支持 `~` 开头（按用户主目录展开）—— 让用户能直接写 `~/Videos/bili` 这种形式。
   */
  scanDirs: string[];
  /** 递归深度上限（防止误扫整个磁盘） */
  maxDepth: number;
  /** 小于该体积的视频忽略（MB） */
  minSizeMB: number;
  /**
   * 目录轮询自动导入：把录播丢进目录就自动跑完整个流程，不用在界面上手动导入。
   *
   * 与 `trigger`（轮 biliLive-tools 的录制历史接口）是**两条独立的腿**：
   * 实测 `recent-clips` 会返回空数组（房间不在 biliLive-tools 的 streamer 表里时），
   * 而盘上的文件是真实存在的 —— 盯目录就一定能发现。
   */
  watch: WatchImportConfig;
}

export interface WatchImportConfig {
  enabled: boolean;
  /**
   * 要盯的目录（递归）。支持 `~` 展开。
   *
   * 与 `scanDirs` 分开：`scanDirs` 是"手动导入时能挑到哪些"，这里是"自动导入盯哪里"，
   * 后者必须收敛（每 60 秒扫一次，扫太多等于每轮都在读一堆无关文件的文件头）。
   */
  dirs: string[];
  /** 轮询间隔（秒），最小 10 */
  intervalSec: number;
  /**
   * 体积连续不变多久才认为"录制已结束"（秒）。
   *
   * 录制工具边录边写：读到一半的 flv 时长是错的、尾帧是残缺的，
   * 导入它会得到一场"看起来正常但内容不全"的任务，非常难排查。默认 30 秒。
   */
  stableSec: number;
  /** 是否要求必须有同名弹幕文件（.xml/.ass）才导入。默认 false：没弹幕也能靠转写选片 */
  requireDanmaku: boolean;
  /**
   * 是否也自动导入"启用之前就已经躺在目录里"的历史录播。**默认 false**。
   *
   * 实测用户的录播目录里积压 28 个文件 / 32 GB：开启轮询时若全部导入，
   * 等于一次排 28 场转写（≈¥238）并占满队列好几天。历史积压请在界面上按需手动导入。
   */
  importExisting: boolean;
  /** 递归深度上限 */
  maxDepth: number;
  /** 小于该体积的文件忽略（MB） */
  minSizeMB: number;
}

export interface ClipConfig {
  maxCandidates: number;
  autoSelectScoreFloor: number;
  /**
   * **默认勾选项数上限** —— 自动发布/自动切片只处理评分最高的这 N 个。
   *
   * 为什么必须有它（实测教训）：原先只靠 `autoSelectScoreFloor` 决定默认勾选，
   * 而实测一场 59 分钟直播 LLM 给出 14 个候选、**全部 ≥ 7.0**（最低正好卡在门槛上，
   * 均值 7.4）⇒ 门槛一个都没挡住 ⇒ 14 个候选全部自动切片并发布。
   * 门槛失效的根因是"绝对分"本身不可跨场比较（LLM 会贴着门槛给分）。
   *
   * 所以这里改用**相对排名**：按评分降序，只有前 N 个默认勾选，其余仍会呈现给用户、
   * 只是默认不勾（可在界面手动补勾）。「少而精」比「多而平」更适合自动发布。
   */
  autoSelectTopN: number;
  minDurationSec: number;
  maxDurationSec: number;
  bufferSec: number;
  /**
   * 切片结尾向前吸附到自然断句点的上限（秒）。
   *
   * 选片 LLM 看不到转写原文，只拿到时间窗要点，所以它给的 end 是近似值 ——
   * 实测 9 个候选的 end 全落在 1.5 秒网格上（`xxx.5`），其中 8 个切在句子中间，
   * 表现为"歌词/话还没唱完就断了"。本项控制"最多往前找多久的下一句结束时刻"：
   *   太小 → 吸附不到，等于没做；太大 → 会把结尾硬拽很远，偏离 LLM 的判断。
   * 4 秒覆盖绝大多数句内停顿；设为 0 即关闭吸附。
   */
  boundarySnapAheadSec: number;
  /**
   * **能量边界修正**的上限（秒）：起点/终点落在"没人说话"的地方时，最多移动多远去找人声。
   *
   * 为什么需要：`boundarySnapAheadSec` 那套吸附是**按转写段边界**做的，而云 ASR 的段窗口
   * 本身可能离谱（实测 2026-09-24：「如。萌啊…」15 个字占 0→30.9 秒）。于是切片起点
   * 正好落在那条假窗口的开头，成片前 28 秒只有背景音 —— 观众看到的是空转。
   * 这里用**音频能量**（本地 ffmpeg 算 RMS，零费用、与 ASR 无关）兜一道。
   *
   * 只在死气超过 4 秒时才动（正常的开场留白实测 2.5 秒，不该裁），且保证裁完不低于时长下限。
   * 默认 30 秒；设为 0 即关闭。
   */
  boundarySpeechTrimSec: number;
  ffmpegPresetId: string;
  burnDanmaku: boolean;
  /**
   * 是否把转写烧成字幕。
   *
   * 与 burnDanmaku 相互独立：字幕来自 `transcript.json`（已经花过 ASR 的钱），
   * 弹幕来自 XML/ASS。两者会被合并成一个 ASS 交给切片接口
   * （实测 `POST /task/cut` 只接受一个 assFilePath）。
   */
  burnSubtitles: boolean;
  subtitle: SubtitleConfig;
  ffmpegOptionsOverride: Record<string, string> | null;
  fullVideoHasDanmaku: boolean;
  outputDir: string;
  cutTimeoutSec: number;
  /**
   * 切完片后自动修复音视频起点错位（默认开）。
   * 实测录播切出来的片段音频比画面早 1–3.7 秒（源录播 PTS 结构导致，改 ffmpeg 参数修不掉），
   * 表现为「字幕和声音对不上」。修法是流拷贝重挂一次，不重编码、不损画质，约 0.1 秒。
   */
  avSyncRepair: boolean;
  /** 音画起点差值超过多少秒才修（默认 0.15） */
  avSyncToleranceSec: number;
}

export type CoverSource = 'default' | 'preset' | 'fullVideo';

export interface PublishConfig {
  autoPublish: boolean;
  isOnlySelf: 0 | 1;
  submitGapSec: number;
  clipGapSec: number;
  jitterSec: number;
  /**
   * 首片发布时间（本地时间，格式 `YYYY-MM-DDTHH:mm`）。留空则按公式自动算。
   *
   * 用途：想「今晚 23:30 开始发」或「明早 8 点开始发」时直接指定，
   * 比调 submitGapSec 秒数直观得多。
   *
   * 约束：**不得早于「提交时刻 + 7200 秒」**（B站硬限制）。若指定时间太早，
   * 会自动推迟到最早合法时间并在日志与 UI 上说明原因，而不是让投稿被拒。
   */
  firstPublishAt: string;
  /**
   * 每日投稿上限（个/天）。
   *
   * **`0` = 不限额**（既不做额度检查，也不显示"剩余额度"）。
   *
   * 注意：取消额度后，**自动发布的数量完全由 `clip.autoSelectTopN` 决定** ——
   * 那是唯一剩下的闸门（它把"勾选"收口到评分最高的 N 个）。
   * 若两个都不设（`dailyLimit=0` 且 `autoSelectTopN` 很大），
   * 一场直播有多少候选就会全投出去，投稿频率会明显上升，风控角度不推荐。
   */
  dailyLimit: number;
  minSubmitIntervalSec: number;
  maxConcurrentUploads: number;
  copyright: 1 | 2 | 3;
  creationStatement: -1 | 1 | 2 | 3 | 4;
  dynamic: string;
  noDisturbance: 0 | 1;
  defaultCover: string;
  coverSource: CoverSource;
  uploadPresetId: string;
  seasonId: number;
  sectionId: number;
  defaultCategory: string;
  tidWhitelist: Record<string, number>;
  defaultTags: string[];
  tagSensitiveWords: string[];
  defaultTitleSuffix: string;
  descTemplate: string;
  autoCutTimeoutSec: number;

  /* ------------------------------------------------------------------------
   * 多分P投稿（把完整版 + 纯享版 + 各切片投进同一个稿件）
   * ---------------------------------------------------------------------- */

  /**
   * 是否用「多分P单稿件」替代「每片一稿」。
   *
   * 开启后结构为 `2 + N` 个分P：
   *   P1 完整版（烧弹幕）· P2 纯享版（无弹幕原片）· P3…P(2+N) 各切片
   *
   * **主要收益是省额度**：一次投稿只占 1 个每日投稿数（`dailyLimit`）。
   * **代价是失去错峰**：多P稿件只有一个 `dtime`，所有分P同一时刻上线
   * （原来的「相邻切片间隔 clipGapSec」在这种模式下不生效）。
   */
  multiPart: boolean;
  /** P1 完整版的分P标题 */
  fullPartTitle: string;
  /** P2 纯享版的分P标题 */
  purePartTitle: string;
  /**
   * 纯享版（无弹幕原片）的生成方式：
   *   `remux` —— 转封装（秒级、不重编码、画质无损；推荐）
   *   `none`  —— 不生成纯享版，结构退化为 `1 + N`
   */
  pureSource: 'remux' | 'none';
  /**
   * **续传目标稿件**（biliLive-tools 先投完整版时，往哪个稿件追加切片分P）。
   *
   * 背景：用户的工作流是「biliLive-tools 把一场直播的分段录播投成 **1 个稿件的 N 个分P**
   * （`uploadToSameMedia`）→ 切片助手只把切片追加进同一个稿件」。
   * biliLive-tools 的 `POST /bili/upload` 支持这个能力：
   * 带 `vid` 走 `editMedia`（`append`：**保留原分P、只加新的**，且会把稿件原有的
   * 标题/简介/标签原样 POST 回去，我们的 config 覆盖不到稿件信息），
   * 不带 `vid` 走 `addMedia`（新建稿件）。
   *
   * 取值：稿件 **aid**（数字字符串）。留空 = 不显式指定，改用 `resumeTitleTemplate` 自动找；
   * 两者都留空 = 切片自己新建稿件。
   */
  resumeAid: string;
  /**
   * 自动查找续传目标时，用来匹配 biliLive-tools 所投稿件的标题模板。
   *
   * 可用变量：`{anchor}` 主播名、`{liveTitle}` 直播标题、`{date}` 录制日期（YYYY.MM.DD）。
   * 默认对齐 biliLive-tools webhook / 投稿预设的 `title = {{user}}{{title}}{{now}}`。
   *
   * `{anchor}` 的取值顺序：先从稿件列表里反推账号名（`guessAnchorName`，最可靠 ——
   * 标题形如 `甲主播<直播标题><日期>`），再用台账里识别到的主播名兜底。
   * ⚠️ 这里**不能**只传空串：实测空主播名时精确命中 0 个，切片永远进不了同一个稿件。
   *
   * 匹配分两轮：① 连日期一起精确相等；② 退一步只比「主播名+直播标题」，
   * 此时必须有 `ctime` 且落在录制日 ±7 天内。任何一轮命中多于 1 个都拒绝自动选择。
   * 留空 = 关闭自动查找（只能用 `resumeAid` 显式指定）。
   */
  resumeTitleTemplate: string;
  /**
   * 【当前不生效，保留兼容】续传时切片分P 的编号基准。
   *
   * 现状：切片标题**不写 `P{n}` 序号**（用户选定的方案）。理由 —— 目标稿件已有多少分P
   * 由 biliLive-tools 决定且是动态量：`SAME_MEDIA_UPLOAD_ORDER = ["handled","raw"]`
   * 意味着「弹幕版全部在前、纯享版在后」，一场分 Z 段就有 2Z 个分P（4 段 → 8）。
   * B站 分P列表本身会标出位置序号，标题里再写一次只会在段数变化时错位。
   *
   * 注：`daemon` 已能读到目标稿件的**实际**分P 数（`biliArchiveDetail` → `View.pages`，
   * 仅用于日志核对）。将来若确实要标题带序号，应基于那个动态值生成，而不是这个写死值。
   */
  resumeClipIndexBase: number;
  /**
   * **完整版（弹幕版 + 纯享版）由谁投稿** —— 这条是用户定的规则，不是实现细节。
   *
   *   `'bililive-tools'`（**默认**）—— 由 biliLive-tools 自己压制并投出（它录的场次走
   *       webhook 流水线：压制 → `uploadToSameMedia` → 一个稿件带 2Z 个分P，Z = 分段数）。
   *       切片助手**只投切片**，并通过 `vid` 追加进它那个稿件 —— 也就是"同一场 = 同一个稿件"。
   *       找不到它的稿件时**不允许自己上**：本场停在 CLIPPED 等待（最多 `resumeWaitMin` 分钟）。
   *   `'assistant'` —— 只有用户**明确指定**时才用：切片助手自己烧弹幕版 + remux 纯享版，
   *       新建 `2+N` 稿件（P1 完整版 · P2 纯享版 · P3… 切片）。
   *
   * 逐任务例外见 `TaskRecord.overrides.fullVideoBy`（一次性的"这一场我来投"）。
   */
  fullVideoBy: 'bililive-tools' | 'assistant';
  /**
   * 等 biliLive-tools 把完整版稿件投出来的最长时间（分钟，默认 90）。
   *
   * 为什么需要等待：它的压制 + 上传是异步的（实测录制结束后 13–15 分钟才出弹幕版），
   * 而我们切片完成得更早。此期间**不能自己投完整版**（会变成两个稿件、重复内容），
   * 也不能把切片投成独立稿件（违背"同一个稿件"）。超时后停在 CLIPPED 并告警要求人工确认。
   */
  resumeWaitMin: number;
  /** 分P标题是否带「P3 / P4」序号前缀（仅当 partTitleTemplate 为空时生效） */
  partTitleWithIndex: boolean;
  /**
   * **投稿简介末尾的 AI 声明**（默认写出来，留空则不加）。
   *
   * 为什么要有它：切片是 LLM 选段 + AI 生成标题/字幕后**自动投稿**的，观众与平台都该看得见这件事。
   * 实现上有两处必须做对（见 `buildBiliupConfig`）：
   *   1. 声明是**最后拼、不参与截断**的 —— 简介上限 250 字符，若和正文一起截，
   *      声明正好会被截掉，等于没写；
   *   2. 拼在**所有路径**之后 —— 切片、多分P 稿件、我们上传的完整版都带上。
   */
  aiNotice: string;
  /**
   * 多分P 稿件里「切片分P」的标题模板。留空 = 沿用 `partTitleWithIndex` 的旧行为（`P3 标题`）。
   *
   * 可用变量：`{n}` 分P 序号、`{title}` 切片自己的标题、`{mainTitle}` 稿件主标题、
   * `{anchor}` 主播名、`{date}` 录制日期、`{kind}` 类型。
   * 例如 `{anchor}切片{n} {title}` → `甲主播切片3 有人中了20次红包？主播直呼搞不懂`。
   */
  partTitleTemplate: string;
  /**
   * **立即发布**（不传 `dtime`）。
   *
   * 默认 `false`：走定时发布（`submitGapSec + (N-1)×clipGapSec + 抖动`），
   * 满足任务书硬约束 #4「dtime 必须 > 提交时刻 + 7200 秒」。
   *
   * 置 `true` 时投稿**不带 `dtime`**，稿件通过审核后直接公开。
   * ⚠️ 它会绕过上述硬约束（那是任务书为降低风控风险设的自律措施，**不是 B站规则**：
   * B站只在「传了 dtime」时才要求它 ≥ 提交后 2 小时）。
   * 代价与风险见 README；试跑期建议保持 `false`。
   */
  immediatePublish: boolean;
}

export interface CleanupConfig {  retentionDays: number;
  diskFloorGB: number;
  deleteRawAfterTranscribe: boolean;
  /**
   * 回收站保留天数。**设为 0 表示关闭回收站**（删除直接永久生效）。
   *
   * 默认 7 天：界面上误点一次「删除任务」的代价是 200 MB 成片 + 转写 + 总结一起消失，
   * 而删除实现曾是 `fs.rmSync`，事后无法恢复。现在删除改为移动到 `data/trash/`，
   * 超过这个天数的条目才会被真正抹掉。
   */
  trashDays: number;
  checkIntervalMin: number;
  keepFullVideoOnFailure: boolean;
  /** 上传确认后的延迟删除（"用完即删"，但先给 24 小时反悔窗口） */
  deleteAfterUpload: DeleteAfterUploadConfig;
}

export interface DeleteAfterUploadConfig {
  /**
   * 是否启用「本场全部切片确认投稿成功后，自动删除成片与源录播」。**默认 false**。
   *
   * 删除源录播不可逆（20 GB 的录播删了就重录），所以必须显式开启 ——
   * 但一旦开启就必须做对三件事（见 `src/pending-delete.ts`）：
   * ① 只认反查到 bvid 的 `PUBLISHED`（硬约束 #17）；② 本场全部切片确认完才排源；
   * ③ 进清单后宽限 `graceHours` 小时，期间界面可取消。
   */
  enabled: boolean;
  /** 宽限小时数（默认 24）：排入清单后等这么久才真删 */
  graceHours: number;
  /** 是否删成片（默认 true；成片在本盘，走回收站可恢复 7 天） */
  deleteClips: boolean;
  /** 是否删源录播（默认 true；异盘，到点直接永久删除） */
  deleteRaw: boolean;
  /** 是否连完整版压制产物一起删（默认 true） */
  deleteFullVideo: boolean;
}

/**
 * MCP（Model Context Protocol）接口：让 Agent（Claude Code / Codex / Cursor / 本机助手）
 * 用自然语言驱动整条切片流水线。
 *
 * 为什么单独发一个 token 而不是复用页面的 CSRF：MCP 客户端不是浏览器，拿不到页面里注入的
 * CSRF token、也不带 Origin 头。token 为空时服务不会挂载 /mcp。
 */
export interface McpConfig {
  enabled: boolean;
  /** 长期 token（首次启用时自动生成并写回 config.json）。为空 = 未配对 */
  token: string;
}

export interface AlertConfig {
  enabled: boolean;
  channels: Array<'serverchan' | 'dingtalk' | 'telegram' | 'webhook'>;
  events: Record<string, boolean>;
  dedupeWindowSec: number;
  accountExpireWarnDays: number;
  serverchan: { sendKey: string };
  dingtalk: { webhook: string; secret: string };
  telegram: { botToken: string; chatId: string };
  webhook: { url: string };
}

export interface UiConfig {
  enabled: boolean;
  host: string;
  port: number;
  openBrowser: boolean;
}

export interface RuntimeConfig {
  dataDir: string;
  timezone: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logKeepDays: number;
  recordDecisions: boolean;
  allowPaid: boolean;
  maxParallelTasks: number;
  stageTimeoutSec: number;
}

export interface AppConfig {
  bililive: BililiveConfig;
  room: RoomConfig;
  recorder: RecorderConfig;
  segmented: { autoProbe: boolean; maxSegments: number };
  /** 手动导入录播的扫描设置 */
  import: ImportConfig;
  danmaku: DanmakuConfig;
  asr: AsrConfig;
  llm: LlmConfig;
  clip: ClipConfig;
  publish: PublishConfig;
  cleanup: CleanupConfig;
  mcp: McpConfig;
  alert: AlertConfig;
  ui: UiConfig;
  runtime: RuntimeConfig;
}

/* ---------------------------------------------------------------------------
 * 默认值（与 config.example.json 保持一致；example 缺失时也能跑起来）
 * ------------------------------------------------------------------------- */

function defaults(): AppConfig {
  // 示例文件优先（它同时充当「可读的默认值文档」），但**必须用下面的内置字面量兜底**。
  // 曾经这里写成 `return raw as AppConfig`（直接返回示例文件、不合并）——
  // 结果是示例文件里漏掉任何一个键，该键在运行时就是 undefined，
  // validateConfig 紧随其后读 cfg.clip.subtitle.maxCharsPerLine 会直接抛 TypeError，
  // 表现为**服务完全无法启动**（连空配置都加载失败），且报错点离真正原因很远。
  // 合并之后：示例文件写歪了只会退回内置值，不会再让整个程序起不来。
  if (exists(CONFIG_EXAMPLE_PATH)) {
    try {
      // 注释键要**递归剥离**：示例文件是「可读的默认值文档」，里面大量用 `$comment*` 写说明，
      // 只删顶层 `$comment` 的话，段内注释（如 `publish.$comment_defaultTags`）会经 deepMerge
      // 进入运行时配置对象。见 stripCommentKeys 的注释。
      const raw = stripCommentKeys(
        JSON.parse(fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf8')) as Record<string, unknown>,
      );
      return deepMerge(builtinDefaults(), raw);
    } catch {
      /* 示例文件损坏：落到内置默认 */
    }
  }
  return builtinDefaults();
}

/** 内置默认值（config.example.json 缺失/损坏时的唯一真相） */
function builtinDefaults(): AppConfig {
  return {
    bililive: {
      baseUrl: 'http://127.0.0.1:18010',
      passKey: '',
      versionExpected: '3.22.1',
      versionDriftWarn: true,
      timeoutMs: 30000,
      asrTimeoutMs: 1800000,
      retry: 3,
    },
    room: {
      roomId: '',
      platform: 'Bilibili',
      pollIntervalSec: 60,
      reconcileIntervalMin: 60,
      liveCheckIntervalSec: 60,
      offlineConfirmSec: 600,
      registerStreamerHint: true,
    },
    recorder: {
      type: 'builtin',
      webhookTargets: [],
      forwardTo: '/webhook/custom',
      eventLogPath: 'data/webhook-events.jsonl',
      recentClipsWindow: 5,
      recordHistoryPageSize: 50,
    },
    segmented: { autoProbe: true, maxSegments: 500 },
    import: {
      scanDirs: [],
      maxDepth: 3,
      minSizeMB: 5,
      watch: {
        enabled: true,
        // 录播默认落在 biliLive-tools 的录制目录下（按主播分子目录）—— 最通用的默认值
        dirs: ['~/Downloads/Bilibili'],
        intervalSec: 60,
        stableSec: 30,
        requireDanmaku: false,
        importExisting: false,
        maxDepth: 3,
        minSizeMB: 5,
      },
    },
    danmaku: {
      densityWindowSec: 10,
      peakTopN: 20,
      peakMinIntensity: 0.35,
      keywordTopN: 40,
      noiseWords: [],
      danmakuOffsetSec: 'auto',
      offsetCalibrationSeconds: 0,
      factoryPath: '',
      fontSize: 0,
    },
    asr: {
      provider: 'bililive-tools',
      segmentMinutes: 30,
      overlapSeconds: 8,
      allowEmptyTranscriptFallback: false,
      concurrency: 1,
      maxRetries: 3,
      modelId: '',
      cacheDir: 'data/asr-cache',
      /* 对齐阿里云 fun-asr 实测单价 ¥0.00022/秒 ≈ ¥0.79/小时（原默认 2.0 高估 2.5×） */
      unitPricePerHour: 0.79,
      inputSource: 'raw',
      silenceTrim: { enabled: false, noiseDb: -32, minSilenceSec: 2, paddingSec: 0.4, ffmpegPath: '' },
      whisperCpp: {
        binaryPath: '',
        modelPath: '',
        // 实测：large-v3-turbo 在 RTX 4070 SUPER 上处理 30 分钟音频只要 50 秒（RTF 0.028），
        // 4 小时素材约 7 分钟；这是精度/速度最均衡的一档。
        model: 'dropbox-dash/faster-whisper-large-v3-turbo',
        language: 'zh',
        threads: 8,
        extraArgs: [],
        device: 'auto',
        computeType: 'auto',
        beamSize: 5,
        vadFilter: true,
      },
      // 本地 Fun-ASR-Nano：实测同素材 CER 8.8%（whisper 16.7%）、时间戳中位偏差 +0.18s、
      // 推理 RTF 0.168（4h15m 约 43 分钟）+ 约 96 秒冷启动。零费用。
      localFunasr: {
        pythonPath: '',
        model: 'FunAudioLLM/Fun-ASR-Nano-2512',
        hub: 'ms',
        device: 'auto',
        engine: 'auto',
        maxCharsPerCue: 18,
        minCueDur: 0.6,
        timestamps: true,
        // 术语表 → ASR 热词：能力一直在执行器里，TS 侧此前没接线（见 asr.ts）
        hotwordsEnabled: true,
        hotwordsMax: 80,
        chunkMinutes: 360,
        parallel: 1,
        timeoutSec: 4 * 3600,
      },
    },
    llm: {
      preset: 'deepseek',
      summary: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        model: 'deepseek-chat',
        maxTokens: 4096,
        temperature: 0.3,
        timeoutMs: 120000,
      },
      select: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        model: '',
        maxTokens: 8192,
        temperature: 0.4,
        timeoutMs: 180000,
      },
      chunkMinutes: 12,
      chunkConcurrency: 2,
      consecutiveFailureThreshold: 3,
      pricing: {
        currency: 'CNY',
        summary: { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.2 },
        select: { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.2 },
      },
      recordRawResponses: false,
    },
    clip: {
      maxCandidates: 6,
      autoSelectScoreFloor: 7,
      /* 默认最多自动勾选 6 个（评分最高的那些）；其余仍列出，需手动勾选 */
      autoSelectTopN: 6,
      minDurationSec: 30,
      maxDurationSec: 90,
      bufferSec: 1.5,
      boundarySnapAheadSec: 4,
      boundarySpeechTrimSec: 30,
      ffmpegPresetId: 'default',
      burnDanmaku: true,
      burnSubtitles: true,
      subtitle: {
        fontSize: 0,
        marginV: 0,
        maxCharsPerLine: 18,
        minDurationSec: 0.8,
        readingCharsPerSec: 4,
        fontName: 'Microsoft YaHei',
      },
      ffmpegOptionsOverride: { 'c:v': 'libx264', preset: 'veryfast', crf: '21', 'c:a': 'aac', 'b:a': '192k' },
      fullVideoHasDanmaku: false,
      outputDir: 'data/clips',
      cutTimeoutSec: 3600,
      avSyncRepair: true,
      avSyncToleranceSec: 0.15,
    },
    publish: {
      autoPublish: false,
      isOnlySelf: 1,
      submitGapSec: 7800,
      clipGapSec: 7500,
      jitterSec: 1800,
      firstPublishAt: '',
      dailyLimit: 5,
      minSubmitIntervalSec: 120,
      maxConcurrentUploads: 2,
      copyright: 1,
      creationStatement: -1,
      dynamic: '',
      noDisturbance: 0,
      defaultCover: '',
      coverSource: 'preset',
      uploadPresetId: 'default',
      seasonId: 0,
      sectionId: 0,
      defaultCategory: '游戏/单机游戏',
      tidWhitelist: { '游戏/单机游戏': 17, '游戏/网络游戏': 65, 生活: 21, 综合: 21 },
      defaultTags: ['直播切片', '名场面'],
      tagSensitiveWords: [],
      defaultTitleSuffix: '',
      descTemplate: '本片段来自 {{date}} 的直播《{{liveTitle}}\n原直播：{{roomUrl}}\n{{desc}}',
      autoCutTimeoutSec: 1800,
      /* 默认 true：规则是「一场直播 = 一个稿件（完整版 + 切片）」，只有多分P 续传能做到。
         关掉它会退化成「一个切片一个稿件」，与完整版不在同一个稿件里。 */
      multiPart: true,
      fullPartTitle: '完整版',
      purePartTitle: '纯享版（无弹幕）',
      pureSource: 'remux',
      resumeAid: '',
      /* 对齐 biliLive-tools webhook 的 title 模板（本机实测值：{{user}}{{title}}{{now}}） */
      resumeTitleTemplate: '{anchor}{liveTitle}{date}',
      /* 默认 2：biliLive-tools 的 uploadNoDanmu 会投「弹幕版 + 无弹幕版」两个分P */
      resumeClipIndexBase: 2,
      /* 规则默认：完整版（弹幕版+纯享版）由 biliLive-tools 投，切片助手只追加切片分P。
         要让切片助手自己投完整版（例外），显式改成 'assistant'。 */
      fullVideoBy: 'bililive-tools',
      resumeWaitMin: 90,
      aiNotice:
        '本视频由 AI 完成选段、字幕与自动投稿，内容来自直播回放，发布前未经人工确认\n如果够弱智 请给我点个赞吧！！！！！！！！！！',
      partTitleWithIndex: true,
      partTitleTemplate: '',
      immediatePublish: false,
    },
    cleanup: {
      retentionDays: 7,
      diskFloorGB: 50,
      deleteRawAfterTranscribe: true,
      trashDays: 7,
      checkIntervalMin: 30,
      keepFullVideoOnFailure: true,
      // 默认关闭：删除不可逆，必须用户显式开启（本项目的用户在 config.json 里开启）
      deleteAfterUpload: {
        enabled: false,
        graceHours: 24,
        deleteClips: true,
        deleteRaw: true,
        deleteFullVideo: true,
      },
    },
    // MCP 接口默认开启：只监听回环地址 + 需要 token，本地 Agent 可直接接上
    mcp: { enabled: true, token: '' },
    alert: {
      enabled: true,
      channels: [],      events: {},
      dedupeWindowSec: 900,
      accountExpireWarnDays: 7,
      serverchan: { sendKey: '' },
      dingtalk: { webhook: '', secret: '' },
      telegram: { botToken: '', chatId: '' },
      webhook: { url: '' },
    },
    ui: { enabled: true, host: '127.0.0.1', port: 3000, openBrowser: false },
    runtime: {
      dataDir: 'data',
      timezone: 'Asia/Shanghai',
      logLevel: 'info',
      logKeepDays: 14,
      recordDecisions: true,
      allowPaid: false,
      maxParallelTasks: 1,
      stageTimeoutSec: 7200,
    },
  };
}

/* ---------------------------------------------------------------------------
 * 环境变量覆盖
 * ------------------------------------------------------------------------- */

function applyEnvOverrides(cfg: AppConfig): AppConfig {
  const env = process.env;
  const setPath = (obj: Record<string, unknown>, dotted: string, raw: string): void => {
    const parts = dotted.split('.');
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
      cur = cur[key] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1]!;
    // 保持原有类型
    const prev = cur[last];
    if (typeof prev === 'number') cur[last] = Number(raw);
    else if (typeof prev === 'boolean') cur[last] = raw === 'true' || raw === '1';
    else cur[last] = raw;
  };

  const mapping: Record<string, string> = {
    LIVE_AUTO_BILILIVE_URL: 'bililive.baseUrl',
    LIVE_AUTO_BILILIVE_PASSKEY: 'bililive.passKey',
    BILILIVE_TOOLS_PASSKEY: 'bililive.passKey',
    LIVE_AUTO_ROOM_ID: 'room.roomId',
    LIVE_AUTO_LLM_KEY: 'llm.summary.apiKey',
    LIVE_AUTO_LLM_SELECT_KEY: 'llm.select.apiKey',
    LIVE_AUTO_LLM_URL: 'llm.summary.baseUrl',
    LIVE_AUTO_LLM_MODEL: 'llm.summary.model',
    LIVE_AUTO_AUTO_PUBLISH: 'publish.autoPublish',
    LIVE_AUTO_IS_ONLY_SELF: 'publish.isOnlySelf',
    LIVE_AUTO_UI_PORT: 'ui.port',
    LIVE_AUTO_LOG_LEVEL: 'runtime.logLevel',
    LIVE_AUTO_ALLOW_PAID: 'runtime.allowPaid',
  };
  for (const [envKey, dotted] of Object.entries(mapping)) {
    const v = env[envKey];
    if (v !== undefined && v !== '') setPath(cfg as unknown as Record<string, unknown>, dotted, v);
  }
  return cfg;
}

/* ---------------------------------------------------------------------------
 * 校验（硬约束的前置检查）
 * ------------------------------------------------------------------------- */

export interface ConfigIssue {
  level: 'error' | 'warn';
  field: string;
  message: string;
  /** 可执行的修复建议 */
  fix?: string;
}

export function validateConfig(cfg: AppConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const err = (field: string, message: string, fix?: string): void => {
    issues.push(fix ? { level: 'error', field, message, fix } : { level: 'error', field, message });
  };
  const warn = (field: string, message: string, fix?: string): void => {
    issues.push(fix ? { level: 'warn', field, message, fix } : { level: 'warn', field, message });
  };

  // 硬约束 #2：只监听 127.0.0.1
  if (cfg.ui.host !== '127.0.0.1' && cfg.ui.host !== 'localhost' && cfg.ui.host !== '::1') {
    err('ui.host', `Web UI 必须只监听回环地址，当前为 ${cfg.ui.host}`, '改为 127.0.0.1');
  }
  try {
    const u = new URL(cfg.bililive.baseUrl);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) {
      warn('bililive.baseUrl', `biliLive-tools 地址不是回环地址（${u.hostname}），请确认这是有意为之`);
    }
  } catch {
    err('bililive.baseUrl', `不是合法的 URL：${cfg.bililive.baseUrl}`);
  }

  if (!cfg.bililive.passKey || /在此填写|your[-_ ]?passkey|xxx/i.test(cfg.bililive.passKey)) {
    err(
      'bililive.passKey',
      '未设置 PassKey',
      '在 config.json 填写 biliLive-tools 的 PassKey，或运行 `node tools/init-config.mjs` 自动读取',
    );
  } else if (cfg.bililive.passKey.length < 10) {
    // 实测踩过两次：passKey 被意外写短（真实值 13 位），结果所有接口 401，
    // 而错误信息只说「鉴权失败」，很难联想到「值被截断了」。
    err(
      'bililive.passKey',
      `PassKey 长度只有 ${cfg.bililive.passKey.length} 位，疑似被截断或误写（biliLive-tools 生成的通常是 10 位以上）`,
      '运行 `node tools/init-config.mjs` 从 biliLive-tools 配置重新读取，或手动复制「设置 → 服务」里的完整 PassKey',
    );
  }
  if (cfg.llm.summary.apiKey && cfg.llm.summary.apiKey.length > 0 && cfg.llm.summary.apiKey.length < 20 && !/在此填写/.test(cfg.llm.summary.apiKey)) {
    warn(
      'llm.summary.apiKey',
      `API Key 只有 ${cfg.llm.summary.apiKey.length} 位，疑似不完整（DeepSeek 的 Key 通常 30 位以上）`,
      '检查是否漏复制了字符；也可在设置页用「测试」按钮验证连通性',
    );
  }
  if (!cfg.room.roomId || /^123456$/.test(cfg.room.roomId)) {
    err('room.roomId', '未设置目标直播间房间号', '填写真实房间号（例如 12345678）');
  }
  // 陷阱 #1：platform 必须首字母大写
  if (cfg.room.platform !== 'Bilibili') {
    err('room.platform', `platform 必须为 "Bilibili"（当前 "${cfg.room.platform}"）`, '改为 Bilibili；传错会静默返回空数组');
  }

  // 硬约束 #4：dtime 余量
  if (cfg.publish.submitGapSec <= 7200) {
    err('publish.submitGapSec', `首片提交余量必须 > 7200 秒（当前 ${cfg.publish.submitGapSec}）`, '建议 7800');
  }
  if (cfg.publish.clipGapSec < 7200) {
    warn('publish.clipGapSec', `相邻切片间距 ${cfg.publish.clipGapSec} 秒偏小；B站要求是相对各稿件提交时刻 >7200，取 7500 属保守余量`);
  }
  if (cfg.clip.minDurationSec <= 0 || cfg.clip.maxDurationSec <= cfg.clip.minDurationSec) {
    err('clip.minDurationSec', '片段时长范围不合法', '确保 0 < minDurationSec < maxDurationSec');
  }

  /* 完整版（弹幕版 + 纯享版）的归属：默认由 biliLive-tools 投，切片助手只追加切片分P。
     这条规则要求「切片与完整版在同一个稿件」，而只有多分P 续传（`vid` → editMedia）能做到 ——
     单切片一稿模式下每个切片是独立稿件，天然满足不了。所以这里必须拦住。 */
  if (cfg.publish.fullVideoBy !== 'assistant' && cfg.publish.multiPart !== true) {
    err(
      'publish.multiPart',
      '默认规则是「完整版由 biliLive-tools 投、切片助手只追加切片分P 到同一个稿件」，' +
        '这要求 publish.multiPart=true（多分P 续传）；当前 multiPart=false 会把每个切片投成独立稿件',
      '把 publish.multiPart 设为 true；若确实要让切片助手自己投完整版，显式设 publish.fullVideoBy="assistant"',
    );
  }
  if (cfg.publish.fullVideoBy === 'assistant') {
    warn(
      'publish.fullVideoBy',
      '已开启「完整版由切片助手投」：切片助手会自己压制弹幕版 + remux 纯享版并新建 2+N 稿件，' +
        'biliLive-tools 的完整版链路不再参与（这是**例外**，默认应为 bililive-tools）',
    );
  }
  if (cfg.publish.resumeWaitMin < 1 || cfg.publish.resumeWaitMin > 24 * 60) {
    warn('publish.resumeWaitMin', `等待 biliLive-tools 投出完整版的时长 ${cfg.publish.resumeWaitMin} 分钟不合理`, '建议 30–360');
  }
  // 字幕样式：只做范围提示（写歪了不至于报错，但会明显难看/读不清）
  if (cfg.clip.subtitle.maxCharsPerLine < 8 || cfg.clip.subtitle.maxCharsPerLine > 40) {
    warn(
      'clip.subtitle.maxCharsPerLine',
      `每行 ${cfg.clip.subtitle.maxCharsPerLine} 个字的折行宽度不合理`,
      '中文直播建议 14–20（默认 18）',
    );
  }
  if (cfg.clip.subtitle.minDurationSec < 0.4 || cfg.clip.subtitle.minDurationSec > 3) {
    warn(
      'clip.subtitle.minDurationSec',
      `字幕最短显示时长 ${cfg.clip.subtitle.minDurationSec} 秒不合理`,
      '建议 0.6–1.2（默认 0.8）：太短看不清，太长会拖到下一句',
    );
  }
  if (cfg.clip.subtitle.readingCharsPerSec < 1.5 || cfg.clip.subtitle.readingCharsPerSec > 12) {
    warn(
      'clip.subtitle.readingCharsPerSec',
      `字幕阅读速度 ${cfg.clip.subtitle.readingCharsPerSec} 字/秒超出常识范围`,
      '中文口播建议 3–6（默认 4）：偏小=字幕停留更久，偏大=切得更碎',
    );
  }
  // 音画对齐：容差太小会把正常的时间戳抖动也当成错位去重挂一次；太大则放过真实的错位
  if (cfg.clip.avSyncToleranceSec < 0.05 || cfg.clip.avSyncToleranceSec > 1) {
    warn(
      'clip.avSyncToleranceSec',
      `音画对齐容差 ${cfg.clip.avSyncToleranceSec} 秒不合理`,
      '建议 0.1–0.3（默认 0.15）：小于 0.05 会频繁无意义重挂，大于 1 会放过真实错位',
    );
  }
  if (cfg.clip.subtitle.fontSize < 0) {
    err('clip.subtitle.fontSize', '字幕字号不能为负', '0 表示按分辨率自动推算');
  }
  // 边界吸附：0 = 关闭；过大等于让结尾乱跑，失去"吸附"的意义
  if (cfg.clip.boundarySnapAheadSec < 0) {
    err('clip.boundarySnapAheadSec', '结尾吸附上限不能为负', '0 表示关闭吸附');
  } else if (cfg.clip.boundarySnapAheadSec > 15) {
    warn(
      'clip.boundarySnapAheadSec',
      `结尾吸附上限 ${cfg.clip.boundarySnapAheadSec} 秒偏大`,
      '建议 2–8（默认 4）：太大会把结尾硬拽到很远的下一句，偏离选片模型的判断',
    );
  }
  // 能量边界修正：0 = 关闭；过大意味着允许把起点/终点移动很远（会明显改变切片内容）
  if (cfg.clip.boundarySpeechTrimSec < 0) {
    err('clip.boundarySpeechTrimSec', '能量边界修正上限不能为负', '0 表示关闭');
  } else if (cfg.clip.boundarySpeechTrimSec > 120) {
    warn(
      'clip.boundarySpeechTrimSec',
      `能量边界修正上限 ${cfg.clip.boundarySpeechTrimSec} 秒偏大`,
      '建议 15–60（默认 30）：它只在开头/结尾"没人说话"时生效，超过一分钟的静默通常意味着选段本身有问题',
    );
  }
  if (cfg.llm.select.model && cfg.llm.select.model === cfg.llm.summary.model) {
    warn(
      'llm.select.model',
      '选片档与总结档配置为同一模型，「契约校验失败升级重跑」会退化为同模型重试一次',
      '选片档建议配置更强的模型（§5.3）',
    );
  }
  if (!cfg.llm.summary.apiKey) {
    warn('llm.summary.apiKey', '未配置 LLM API Key，分析阶段将走降级兜底（弹幕密度 Top-N）');
  }
  if (cfg.publish.dailyLimit === 0) {
    /* 不限额是用户的明确选择，这里只作提示 —— 但要提醒"闸门只剩 autoSelectTopN" */
    warn(
      'publish.dailyLimit',
      '每日投稿上限已关闭（0 = 不限额）—— 自动发布数量改由 clip.autoSelectTopN 决定',
      `当前 autoSelectTopN=${cfg.clip.autoSelectTopN}：每场最多自动投这么多。` +
        `若它也设得很大，一场直播的全部候选都会被投出去，投稿频率上升，风控角度不推荐`,
    );
  } else if (cfg.publish.dailyLimit > 10) {
    warn('publish.dailyLimit', `每日投稿上限 ${cfg.publish.dailyLimit} 偏高，风控角度建议 2–5`);
  }
  if (cfg.publish.isOnlySelf !== 1) {
    warn('publish.isOnlySelf', '试跑期应保持 isOnlySelf=1（仅自己可见，硬约束 #10）');
  }
  if (cfg.asr.provider === 'bililive-tools' && cfg.asr.segmentMinutes > 40) {
    warn('asr.segmentMinutes', `单段 ${cfg.asr.segmentMinutes} 分钟偏长，/ai/subtitle 是同步阻塞接口，建议 30 分钟`);
  }
  if (cfg.asr.overlapSeconds < 5 || cfg.asr.overlapSeconds > 10) {
    warn('asr.overlapSeconds', `段间重叠 ${cfg.asr.overlapSeconds} 秒不在建议的 5–10 秒区间`);
  }
  if (cfg.cleanup.retentionDays < 1) {
    warn('cleanup.retentionDays', '缓冲期小于 1 天，事后补切/重传将无法读取源文件');
  }
  if (cfg.asr.provider === 'whisper-cpp') {
    // 本地执行器是一个 Python 脚本（faster-whisper / CTranslate2）。
    // 之所以不是"whisper.cpp 可执行文件"：项目硬约束不引入需要编译的依赖，
    // 所以本地识别做成**可选外部执行器**，主项目只 spawn 它。
    const py = cfg.asr.whisperCpp.binaryPath || path.join(ROOT_DIR, '.venv-asr', 'Scripts', 'python.exe');
    if (!exists(py)) {
      err(
        'asr.whisperCpp.binaryPath',
        `本地 ASR 需要 Python 解释器，但找不到：${py}`,
        '在项目根目录执行：python -m venv .venv-asr ；再 .venv-asr\\Scripts\\pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12',
      );
    }
    const script = path.join(ROOT_DIR, 'tools', 'local-asr', 'transcribe.py');
    if (!exists(script)) {
      err('asr.whisperCpp.binaryPath', `本地 ASR 执行脚本缺失：${script}`, '该文件属于本仓库，请检查是否被删除');
    }
    const dev = String(cfg.asr.whisperCpp.device || 'auto').toLowerCase();
    if (!['auto', 'cuda', 'cpu'].includes(dev)) {
      warn('asr.whisperCpp.device', `device 取值 ${dev} 不常见`, '建议 auto（先试 CUDA，失败自动退 CPU）');
    }
    const ct = String(cfg.asr.whisperCpp.computeType || 'auto').toLowerCase();
    if (!['auto', 'float16', 'int8_float16', 'int8', 'float32'].includes(ct)) {
      warn('asr.whisperCpp.computeType', `compute_type 取值 ${ct} 不常见`, '建议 auto；CPU 上只能用 int8/float32');
    }
    if (cfg.asr.whisperCpp.beamSize > 10) {
      warn('asr.whisperCpp.beamSize', `beamSize=${cfg.asr.whisperCpp.beamSize} 偏大，会明显变慢`, '实测 beam=5 已足够；追求速度可设 1');
    }
  }
  // 「用完即删」：删源不可逆，危险组合必须提前说清楚
  {
    const d = cfg.cleanup.deleteAfterUpload;
    if (d.enabled) {
      if (d.deleteRaw && d.graceHours < 1) {
        warn(
          'cleanup.deleteAfterUpload.graceHours',
          '开启了自动删源且宽限时间不足 1 小时 —— 等于上传一确认就永久删除录播',
          '源录播在别的盘、删了不进回收站，建议保留 24 小时（默认值）',
        );
      }
      if (d.graceHours > 168) {
        warn('cleanup.deleteAfterUpload.graceHours', `宽限 ${d.graceHours} 小时偏长`, '超过 7 天基本等于没在用这个功能');
      }
      if (d.deleteRaw && cfg.cleanup.deleteRawAfterTranscribe) {
        // 这两个配置同时开着时，源文件在转写后就被删了，"上传确认后再删"根本轮不到执行
        warn(
          'cleanup.deleteRawAfterTranscribe',
          '「转写后即删源」与「上传确认后删源」同时开启：源文件会在转写完成时就被删掉',
          '想用"上传确认 + 宽限期"这套，就把 cleanup.deleteRawAfterTranscribe 设为 false',
        );
      }
    }
  }
  if (cfg.alert.enabled && cfg.alert.channels.length === 0) {
    warn('alert.channels', '已开启告警但未配置任何渠道，告警将只写日志');
  }
  // 目录轮询导入：查得出的问题都提前说出来（真跑起来才发现就是每 60 秒刷一条错误）
  if (cfg.import.watch.enabled) {
    if (cfg.import.watch.dirs.length === 0) {
      err(
        'import.watch.dirs',
        '目录轮询导入已启用但没有配置任何目录',
        '填一个录播目录（如 "~/Downloads/Bilibili"），或把 import.watch.enabled 设为 false',
      );
    }
    if (cfg.import.watch.intervalSec < 10) {
      warn('import.watch.intervalSec', `轮询间隔 ${cfg.import.watch.intervalSec} 秒过短`, '建议 30–120（默认 60）');
    }
    if (cfg.import.watch.stableSec < 15) {
      warn(
        'import.watch.stableSec',
        `判定"录制已结束"的稳定时间只有 ${cfg.import.watch.stableSec} 秒`,
        '建议不小于 30：录制工具边录边写，稳定时间太短会把半场素材当成录完的导入',
      );
    }
    if (cfg.import.watch.maxDepth > 5) {
      warn('import.watch.maxDepth', `递归深度 ${cfg.import.watch.maxDepth} 偏大`, '每轮扫描都会走一遍，建议不超过 4');
    }
  }
  for (const [label, ep] of [
    ['llm.summary', cfg.llm.summary],
    ['llm.select', cfg.llm.select],
  ] as const) {
    if (ep.apiKey && !ep.baseUrl) err(`${label}.baseUrl`, '配置了 API Key 但未填接口地址');
  }
  return issues;
}

/* ---------------------------------------------------------------------------
 * 掩码值防护
 * ------------------------------------------------------------------------- */

/**
 * 判定一个值是否是「UI 显示的掩码串」而不是真实凭据。
 *
 * 为什么必须有这道防线：
 *   `safeSnapshot()` 会把凭据打码成 `abc***yz(len=26)` 才能安全地发给 UI。
 *   如果 UI 原样回传整个 config 对象，`save()` 就会**用打码串覆盖真实凭据** ——
 *   用户会静默丢失自己的 Key，而且后续请求会把掩码串当凭据发出去
 *   （含非 ASCII 时甚至触发 `Cannot convert argument to a ByteString`）。
 *   这是「显示层的数据污染了持久层」，必须在写入前挡住。
 */
export function looksMasked(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0) return false;
  // 本项目 maskValue 的形态：前 3 位 + *** + 后 2 位 + (len=N)
  if (/\*\*\*/.test(v)) return true;
  if (/\(len=\d+\)\s*$/.test(v)) return true;
  // 其它常见打码形态，一并挡住
  if (/^[*•·]+$/.test(v)) return true;
  if (/^(未设置|已设置|已配置|已隐藏|hidden|redacted|unchanged)$/i.test(v.trim())) return true;
  return false;
}

/** 递归剔除补丁里所有「掩码形态」的字符串（视为「本次不修改」） */
function stripMasked<T>(value: T, path = '', removed: string[] = []): T {
  if (typeof value === 'string') {
    if (looksMasked(value)) {
      removed.push(path);
      return undefined as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => stripMasked(v, `${path}[${i}]`, removed)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripMasked(v, path ? `${path}.${k}` : k, removed);
      if (stripped !== undefined) out[k] = stripped;
    }
    return out as unknown as T;
  }
  return value;
}

/* ---------------------------------------------------------------------------
 * 加载与热加载
 * ------------------------------------------------------------------------- */

export interface LoadedConfig {
  config: AppConfig;
  path: string;
  exists: boolean;
  issues: ConfigIssue[];
  loadedAt: number;
}

/**
 * 递归剥离所有 `$` 开头的注释键。
 *
 * JSON 没有注释语法，所以约定用 `$comment_xxx` 之类的键写说明（config.example.json 全文都靠它）。
 * 剥离必须是**递归**的：只删顶层的话，写在段内的注释（例如 `publish.$comment_defaultTags`）
 * 会被 deepMerge 原样带进运行时配置对象，既污染内存里的 config，也会被 UI 快照回显出来。
 * `$` 前缀不会与任何真实配置键冲突（代码里没有以 `$` 开头的字段名）。
 */
function stripCommentKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripCommentKeys(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('$')) continue;
      out[k] = stripCommentKeys(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** 深度合并：用户配置覆盖默认值（缺失键用默认补齐） */
function deepMerge<T>(base: T, over: unknown): T {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over as T;
  if (typeof base === 'object' && base !== null && typeof over === 'object') {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      out[k] = k in out ? deepMerge((base as Record<string, unknown>)[k], v) : v;
    }
    return out as T;
  }
  return over as T;
}

export function loadConfig(configPath = CONFIG_PATH): LoadedConfig {
  const base = defaults();
  const has = exists(configPath);
  let merged = base;
  if (has) {
    // 递归剥离 `$comment*` 注释键（顶层与段内都要剥，见 stripCommentKeys 注释）
    const raw = stripCommentKeys(JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>);
    merged = deepMerge(base, raw);
  }
  merged = applyEnvOverrides(merged);
  return { config: merged, path: configPath, exists: has, issues: validateConfig(merged), loadedAt: Date.now() };
}

/** 相对路径按项目根目录解析 */
export function resolveDataPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

/**
 * 配置管理器：支持热加载。
 * UI 保存配置 → 重新加载 → 通知订阅者（无需重启，§8 WP6 步骤 9）。
 */
/**
 * 配置文件的内容版本号（sha1 前 16 位）。
 *
 * 为什么不用 mtime：NTFS 的 mtimeMs 精度有限，同一毫秒内的两次写入会得到相同值，
 * 于是「界面拿着旧表单回存、把外部刚改的配置覆盖掉」这种真实事故就检测不出来。
 * 内容哈希对任何字节级改动都敏感，且与写入顺序无关。
 */
function configFileVersion(filePath: string): string {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

/**
 * 逐段比较两个配置对象，收集所有值不同的路径（用于告诉用户「哪几项被别的程序改过」）。
 *
 * `$` 开头的键是 `$comment_*` 这类**注释**，不参与运行、也没有任何行为，
 * 却会因为「外部用编辑器改过、界面回存时格式不同」而出现在差异里，
 * 把真正重要的字段名淹没掉。所以这里直接跳过它们。
 */
function collectChangedPaths(a: unknown, b: unknown, prefix = ''): string[] {
  const bothPlain =
    a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b);
  if (bothPlain) {
    const out: string[] = [];
    const keys = new Set([...Object.keys(a as Record<string, unknown>), ...Object.keys(b as Record<string, unknown>)]);
    for (const k of keys) {
      if (k.startsWith('$')) continue;
      out.push(...collectChangedPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || '(root)'];
}

/** save() 的返回：写入结果 + 版本号；冲突时 conflict 有值且**未写入任何字节** */
export interface ConfigSaveResult {
  issues: ConfigIssue[];
  maskedIgnored: string[];
  version: string;
  conflict?: {
    expected: string;
    actual: string;
    /** 外部（手工编辑 / 别的程序）改过的字段路径 */
    changedPaths: string[];
    /** 客户端表单里与磁盘现状不同的字段路径 */
    stalePaths: string[];
  };
}

export class ConfigStore {
  private current: LoadedConfig;
  private listeners = new Set<(c: AppConfig) => void>();
  /** 上次读/写后算出的内容版本号；mtime 只用来当「有没有变」的廉价前置判断 */
  private version = '';
  private mtime = 0;
  private configPath: string;

  /** 注意：不使用 TS 参数属性（erasableSyntaxOnly / Node 类型擦除不支持） */
  constructor(configPath: string = CONFIG_PATH) {
    this.configPath = configPath;
    this.current = loadConfig(configPath);
    this.mtime = this.readMtime();
    this.version = configFileVersion(configPath);
  }

  private readMtime(): number {
    try {
      return fs.statSync(this.configPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** 磁盘上配置的当前内容版本号（外部改动后随之变化） */
  get fileVersion(): string {
    return this.version;
  }

  get config(): AppConfig {
    return this.current.config;
  }

  get issues(): ConfigIssue[] {
    return this.current.issues;
  }

  get path(): string {
    return this.configPath;
  }

  /** 配置文件是否真实存在（不存在时全部为默认值） */
  get exists(): boolean {
    return exists(this.configPath);
  }

  get errors(): ConfigIssue[] {
    return this.current.issues.filter((i) => i.level === 'error');
  }

  /** 有文件变更则重载（mtime 作为廉价前置判断，再比内容版本，避免同毫秒写入漏检） */
  reloadIfChanged(): boolean {
    const m = this.readMtime();
    if (m === this.mtime) return false;
    this.mtime = m;
    this.version = configFileVersion(this.configPath);
    this.current = loadConfig(this.configPath);
    for (const fn of this.listeners) {
      try {
        fn(this.current.config);
      } catch {
        /* 订阅者异常不影响其它订阅者 */
      }
    }
    return true;
  }

  /** 强制重载（UI 保存配置后调用） */
  reload(): void {
    this.mtime = this.readMtime();
    this.version = configFileVersion(this.configPath);
    this.current = loadConfig(this.configPath);
    for (const fn of this.listeners) fn(this.current.config);
  }

  /**
   * 写入配置并热加载（保留未知键，便于人工手改的字段不丢失）。
   *
   * ⚠️ 安全阀 1：**掩码形态的值一律视为「不修改」**。
   * UI 拿到的是 `safeSnapshot()` 的打码串，如果它把整个 config 回传，
   * 这里必须挡住，否则会用打码串覆盖真实凭据（用户静默丢失 Key）。
   *
   * ⚠️ 安全阀 2：**乐观锁**。界面上的表单是「打开设置面板那一刻」的快照，
   * 如果期间外部改了 config.json（手工编辑、别的程序写回、启动脚本注入），
   * 界面保存会把那些改动**静默覆盖**掉。实测就这样丢过 `llm.select.model`
   * （表单里是空串，一回存就把外部刚配好的选片档模型清成了空）。
   * 因此调用方可以传 `expectVersion`；与磁盘现状不符时**一个字节都不写**，
   * 把冲突原样返回，由用户决定是「重新加载」还是「强制覆盖」。
   */
  save(patch: Partial<AppConfig>, expectVersion?: string): ConfigSaveResult {
    const maskedIgnored: string[] = [];
    const safePatch = stripMasked(patch as unknown, '', maskedIgnored) as Partial<AppConfig>;

    const diskRaw = exists(this.configPath)
      ? (JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Record<string, unknown>)
      : {};
    const onDiskVersion = configFileVersion(this.configPath);

    // 乐观锁：只在调用方明确提供了版本号时才校验（内部调用如生成 MCP token 不带）
    if (expectVersion !== undefined && expectVersion !== onDiskVersion) {
      const currentRaw = JSON.parse(JSON.stringify(this.current.config)) as Record<string, unknown>;
      return {
        issues: this.current.issues,
        maskedIgnored,
        version: onDiskVersion,
        conflict: {
          expected: expectVersion,
          actual: onDiskVersion,
          changedPaths: collectChangedPaths(currentRaw, diskRaw),
          stalePaths: collectChangedPaths(diskRaw, deepMerge(diskRaw, safePatch as Record<string, unknown>)),
        },
      };
    }

    const merged = deepMerge(deepMerge(defaults(), diskRaw), safePatch);
    const tmp = `${this.configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, this.configPath);
    this.reload();
    if (maskedIgnored.length) {
      for (const p of maskedIgnored) {
        globalLog.warn(`配置项 ${p} 收到的是界面掩码值，已忽略（保留原值）—— 如需修改请填入完整的新值`, { mod: 'config' });
      }
    }
    return { issues: this.current.issues, maskedIgnored, version: this.version };
  }

  onChange(fn: (c: AppConfig) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 导出可安全展示的配置（凭据遮蔽） */
  safeSnapshot(): AppConfig {
    const c = clone(this.current.config);
    const mask = (s: string): string => (s ? `${s.slice(0, 3)}***${s.slice(-2)}` : '');
    c.bililive.passKey = mask(c.bililive.passKey);
    c.llm.summary.apiKey = mask(c.llm.summary.apiKey);
    c.llm.select.apiKey = mask(c.llm.select.apiKey);
    c.alert.serverchan.sendKey = mask(c.alert.serverchan.sendKey);
    c.alert.dingtalk.secret = mask(c.alert.dingtalk.secret);
    c.alert.telegram.botToken = mask(c.alert.telegram.botToken);
    return c;
  }
}
