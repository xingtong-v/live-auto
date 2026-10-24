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
/* 类型 + 默认值都从 recordings 借：碎片合并的判定与默认值只该有一处定义
   （`DEFAULT_STITCH`），配置层重新写一遍必然漂移。 */
import { DEFAULT_STITCH, type StitchConfig } from './recordings.ts';
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
  /**
   * 附加直播间（**不含** roomId 本身）。
   *
   * 为什么不是把 `roomId` 直接改成数组：它被十几处只读代码引用（启动日志、告警、自检、
   * 导入默认值、CLI…），改类型会波及一片；而"要多覆盖几个房间"的真实需求只落在
   * **开播触发 / 补漏对账的轮询范围**上 —— 那个口径统一由 `Trigger.resolveRoomIds()` 取并集，
   * 所以主房间留原字段、其余放这里，改动面最小。
   */
  roomIds: string[];
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
    /**
     * 解码器精度：留空 = funasr 默认（**fp32**）| `bf16`（40 系卡推荐）。
     *
     * 为什么值得开：Fun-ASR-Nano 的 0.6B 解码器默认用 fp32 跑 —— 官方在 vLLM 路径里强制 bf16，
     * 执行器注释也把它标成"最大的一档提速"。实测（2026-10-13，同素材 A/B）见 docs 报告；
     * 效果是**显存约减半 + 更快**，代价是字幕文本可能出现极小差异（ASR 本身不确定）。
     *
     * ⚠️ 它**已纳入转写缓存键**（条件追加）：换了精度不会命中旧缓存 ——
     * 否则会出现"改了设置却毫无变化"的静默失效（热词当初踩过同一个坑）。
     * ⚠️ 别填 fp16：执行器注释明确说 fp16 会产生退化重复输出。
     */
    llmDtype?: string;
    /**
     * 进度子批大小（音频秒），默认 300；**0 = 关掉分批**（回到"一次喂完"）。
     *
     * 为什么会有这个旋钮（2026-10-15，用户要"精确进度"）：执行器一次 `generate()` 是个黑盒，
     * 30 分钟一块要跑几分钟到十几分钟、期间零输出 ⇒ 界面上的百分比只能靠猜（实测显示 1%，
     * 而真实已跑 16 分钟）。把它切成若干子批、每批上报"已推进到音频第几秒 + 实测速度"，
     * 界面上的进度与剩余时间就都是**量出来的**。
     *
     * 取值怎么定：批太小会把前端/编码器开销重复 N 次（实测逐段调用比批量慢一个量级），
     * 批太大又看不到推进 —— 300 秒音频约合 33 秒墙上时间（本机 RTF ≈0.11），两边都照顾到。
     * 配 0 是给"怀疑分批拖慢了"时做对照用的（行为与历史逐字一致）。
     */
    progressBatchSec?: number;
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
  /**
   * ASR 拆独立进程（2026-10-11）。**默认关** —— 关着时转写走原来的进程内路径，
   * 行为与接线前逐字一致；打开后转写跑在 `src/asr-worker.ts` 这个独立子进程里。
   *
   * 这一项**不提速**（模型本来就跑在一次性子进程里），换的是"ASR 出问题不拖垮主链"：
   * 转写 OOM/崩溃只死 worker，守护进程与看门狗不受影响，任务自动重试或原地降级。
   */
  worker: {
    /** 是否用独立进程跑 ASR（默认 false；OOM/崩溃只死 worker，不动主链） */
    enabled: boolean;
    maxOldSpaceMb: number;
  };
  /**
   * 边录边转写（P1-6）：分段在录制期间闭合后立即转写，录完时只剩最后一段要跑。
   * 默认 false —— 它改的是录制监听与状态机，先证明再默认开（可行性已实测：分段与整段
   * 的字幕条数差 0.06%、覆盖时长差 0.01%、边界时间戳连续）。
   */
  incrementalEnabled?: boolean;
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
  /**
   * 碎片合并：同一场直播被 CDN 断成多个文件时，把它们当成**一场**导入。
   *
   * 实测背景（2026-10-06 晚）：「我的 biliLive-tools 为啥几分钟就中断一次录制」——
   * 不是它主动停，是拉流被 CDN 那头关掉，它随即换一个地址重连，于是同一场直播落成
   * 23-25-18-143、23-28-41-546、23-34-10-158… 好几个文件。不合并 = 一场直播拆成
   * N 个任务、N 次转写、N 组切片、往同一个稿件投 N 批分P。
   *
   * 只在「同目录 + 同标题 + 开录时刻紧接上一段结束」时合并；同基名的分段
   * （`X.ts` + `X-PART001.ts`）不受影响，走原有逻辑。
   */
  stitch: StitchConfig;
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
   * **自动投稿数量上限** —— 自动流程只投"评分最高的这 N 个"；勾选状态不受它影响。
   *
   * ⚠️ 2026-10-12 语义调整（用户实测反馈）：这一项**原先**是"默认勾选项数上限"，
   * 实现方式是"按排名把达标的候选改回未勾选"。后果是**静默**的：实测一场 8 个候选全部 ≥6.9
   * （9.7…8.0…7.0），第 7 名（8.0）与第 8 名被取消勾选，而解释只进了内存里的 warnings ——
   * 既不落盘也不进日志、界面看不到 ⇒ 用户"不知道为什么 8.0 没被选中"，只能手动补勾。
   *
   * 现在拆成两件事：
   *   · **勾选** = 只看 `autoSelectScoreFloor`（达标即勾，语义单一）；
   *   · **自动投稿** = 在此之上按评分降序取前 N 个（`src/analyze.ts` 的 `splitAutoPublish`）。
   * 超出 N 的那部分由发布阶段**临时摘掉再原样恢复**，并写一条含分数的日志，
   * 界面上始终显示为"已勾选"。
   *
   * 为什么仍需要它（保留旧教训）：绝对分不可跨场比较，LLM 常贴着门槛给分 ——
   * 实测一场 14 个候选全部 ≥7.0 ⇒ 门槛一个都没挡住。想"少而精"就把 N 调小；
   * 想"达标就全投"就调大（当前用户取 99 = 实质不设限）。
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
  /** 切片阶段并发（有界流水线）：1 = 与历史行为逐字一致；>1 只并行 ffmpeg 切片，上传仍串行且保留风控抖动 */
  concurrency?: number;
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
  /**
   * 覆盖 ffmpeg 预设里的字段（切片编码参数）。
   *
   * ⚠️ **必须用 biliLive-tools 的"预设字段名"，不能写 ffmpeg 原始开关**（2026-10-13 实测踩到）：
   * 它的 `genFfmpegParams()` 只认这几个键 ——
   * `encoder`（→ `-c:v`）、`bitrateControl`（CRF/VBR/CQ/ICQ）、`crf`、`bitrate`（→ `-b:v <n>k`）、
   * `preset`（x264 用 veryfast 之类；NVENC 用 p1–p7）、`audioCodec`（→ `-c:a`）、`extraOptions`。
   * 写 `c:v` / `b:v` / `c:a` 这类原始键会被**静默忽略**（历史配置里那几条就是这么失效的：
   * 真正的编码器一直来自预设自带的 `encoder`）。
   *
   * 切硬件编码的写法（本机 4070 SUPER 实测：CPU 78%→33%，同画质体积 ×2.8）：
   * `{ "encoder": "h264_nvenc", "bitrateControl": "VBR", "bitrate": "8000", "preset": "p3", "audioCodec": "copy" }`
   * 想体积与 x264 crf21 持平就用 `bitrateControl: "CQ"` + `crf: "32"`（→ `-rc vbr -cq 32`）。
   */
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

/**
 * **切片投稿去向**（用户级二选一开关，2026-10-16 用户要求）：
 *
 *   `'append'`     —— **追加切片投稿**：切片作为「同一个稿件」的分P。
 *                     完整版由 biliLive-tools 投时，切片追加进**它那个稿件**（多分P 续传）；
 *                     完整版由切片助手投时，切片与完整版/纯享版合成一个 2+N 稿件。
 *   `'standalone'` —— **单独投稿**：每个切片各自一个稿件（各带自己的标题/简介/标签），
 *                     不等 biliLive-tools 的完整版稿件、不追加进任何已有稿件。
 *
 * 与 `multiPart` 的关系：这个开关是**用户口径**，`multiPart` 是**实现口径**（多分P 机制）。
 * 两者一一对应（append ⇔ multiPart=true），新建/保存配置时由界面同步写；手改 config.json
 * 只写了一个时，以 `resolveClipPublishMode()` 为准（`clipPublishMode` 优先，见该函数）。
 */
export type ClipPublishMode = 'append' | 'standalone';

/**
 * dtime 距提交时刻的余量下限（秒）。
 *
 * **口径修正（2026-10-17）**：这里此前是 7200，且注释把它写成「B站硬限」——**那是错的**。
 * B站投稿页的底线是「定时发布晚于当前 ≥5 分钟、且不晚于 15 天」；
 * 7200 秒来自本项目任务书的「硬约束 #4」，性质是**防风控的自律措施**。
 *
 * 现在取 1200 = 平台底线 300 秒 + 900 秒余量：既满足平台规则，
 * 首片也不必再干等 2 小时以上（1200 秒 = 20 分钟）。
 * ⚠️ 它是「**下限**」而不是「必须等于」——想更保守就把 `publish.submitGapSec` 调大。
 */
export const DTIME_MIN_MARGIN_SEC = 1200;

export interface PublishConfig {
  autoPublish: boolean;
  isOnlySelf: 0 | 1;
  /**
   * 首片发布余量（秒）：首片 dtime = 提交时刻 + 本值。
   * **必须 ≥ 1200**（≥ `DTIME_MIN_MARGIN_SEC`）——那是**本项目**的硬约束 #4 自律下限，
   * 不是平台规则：B站只要求 dtime 晚于当前 300 秒（投稿页口径「定时发布 ≥5 分钟」）。
   * 默认 1200 = 平台底线 300 + 900 秒余量。想更保守就调大。
   */
  submitGapSec: number;
  /**
   * **相邻切片之间的发布时间间隔（秒）** —— 默认 `300` = 每片 5 分钟。
   *
   * ⚠️ 这是**我们自己的**错峰值，不是平台规则：B站 只要求「每片的 dtime 晚于**它自己**的提交时刻
   * 300 秒」（投稿页口径「≥5 分钟」），与上一个切片无关 ⇒ 调大调小都合法。
   *
   * **两个模式都生效**（2026-10-17 更正口径）：
   *   · 「单独投稿」（`clipPublishMode='standalone'`）⇒ 就是每片一稿之间的实际间隔，
   *     **下限 = `STANDALONE_CLIP_GAP_SEC`（300 秒）**：填得比 300 小会被抬到 300
   *     （B站 要求每片 dtime 晚于**它自己**的提交时刻 300 秒，低于这条线就是对不齐平台底线），
   *     填得更大则**照用**（想每片 8 分钟就填 480）。
   *   · 「追加切片投稿」（`clipPublishMode='append'`）⇒ 多分P 稿件只有一个 dtime，
   *     片之间排不开，本键**不逐片生效**（只影响批量排期）。
   *
   * ⚠️ 2026-10-16 曾把单独投稿下的本键**钉死**为 300（用户当时口径是「每片 5 分钟」）；
   * 2026-10-17 用户明确要求「这里改成对定时投稿也生效」⇒ 改为「以本键为准、300 保底」。
   * 生效口径的唯一判定见 `resolveClipPublishSchedule()`，别在别处再算一遍。
   *
   * 与 `jitterSec` 的关系：抖动必须严格小于本值，否则第 N 片的随机抖动会越过第 N+1 片的最小值
   * ⇒ 排期倒挂（第 2 片比第 1 片先公开）。系统会自动把抖动压到 `生效间隔 - 30` 以内
   * （见 `effectiveJitterSec`）。
   */
  clipGapSec: number;
  /**
   * dtime 的随机抖动上限（秒）。**`0` = 等距**（严格按 `clipGapSec` 间隔发布，默认值）。
   *
   * 想要「看不太出来是机器排的」就填 60–120 秒；填大于等于 `clipGapSec` 的值没有意义，
   * 会被自动压到 `clipGapSec - 30`（见 `effectiveJitterSec`）。
   * 注意：**投稿提交**的间隔抖动是另一个键（`minSubmitIntervalSec`），与本键无关。
   *
   * ⚠️ 与 `clipGapSec` 一样**两个模式都生效**（2026-10-17 更正口径）：单独投稿下就是每片
   * dtime 的随机抖动上限；唯一的夹取是「必须小于生效片间隔」——
   * 生效抖动 = `min(本值, max(0, 生效间隔 - 30))`（见 `effectiveJitterSec`）。
   * 2026-10-16 曾把它在单独投稿下钉死为 0，2026-10-17 用户要求「随机抖动对定时投稿也生效」。
   */
  jitterSec: number;
  /**
   * 首片发布时间（本地时间，格式 `YYYY-MM-DDTHH:mm`）。留空则按公式自动算。
   *
   * 用途：想「今晚 23:30 开始发」或「明早 8 点开始发」时直接指定，
   * 比调 submitGapSec 秒数直观得多。
   *
   * 约束：**不得早于「提交时刻 + 1200 秒」**（本项目硬约束 #4 的自律下限）。
   * 若指定时间太早，会自动推迟到最早合法时间并在日志与 UI 上说明原因，而不是让投稿被拒。
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
  /**
   * **必带标签**：所有切片稿件的标签列表里**永远排在最前面**，占位优先于内容词。
   *
   * 支持占位符 `{主播}`（`{主播名}` / `{主播昵称}` / `{昵称}` 同义）—— 投稿时替换成**本场主播名**
   * （例如 `乙主播`）；该场没识别出主播名时，带占位符的那一条**整条跳过**并在任务警告里说明。
   *
   * 与 `defaultTags` 的分工（2026-10-17 用户规格「必有的标签 虚拟主播、2D、3D、VTuber、vup，
   * 还有一个占位符根据主播不同、标签为主播的 ID，其他的为 LLM 生成的，还要有去重」）：
   *   - 这里 = 账号身份标签，**必带**，不会被内容词挤掉；
   *   - `defaultTags` = 可选的补充词，只在必带 + 内容词没用满 10 个时补位。
   * 大小写不敏感去重（`2D` / `2d` 只留先出现的），去重、敏感词过滤与 10 个上限见 `sanitizeTags`。
   */
  identityTags: string[];
  tagSensitiveWords: string[];
  defaultTitleSuffix: string;
  descTemplate: string;
  autoCutTimeoutSec: number;

  /* ------------------------------------------------------------------------
   * 多分P投稿（把完整版 + 纯享版 + 各切片投进同一个稿件）
   * ---------------------------------------------------------------------- */

  /**
   * **切片投稿去向** —— 见 `ClipPublishMode` 的说明。界面上的「切片投稿方式」二选一开关就是它。
   *
   * 留空（老配置手改时可能没有这一项）时按 `multiPart` 反推，行为与加入这个键之前逐字一致。
   */
  clipPublishMode?: ClipPublishMode;
  /**
   * 是否用「多分P单稿件」替代「每片一稿」。
   *
   * 开启后结构为 `2 + N` 个分P：
   *   P1 完整版（烧弹幕）· P2 纯享版（无弹幕原片）· P3…P(2+N) 各切片
   *
   * **主要收益是省额度**：一次投稿只占 1 个每日投稿数（`dailyLimit`）。
   * **代价是失去错峰**：多P稿件只有一个 `dtime`，所有分P同一时刻上线
   * （原来的「相邻切片间隔 clipGapSec」在这种模式下不生效）。
   *
   * ⚠️ 界面已不再单独暴露这个开关：它就是 `clipPublishMode` 的实现口径
   * （`append` ⇒ true · `standalone` ⇒ false），保存时由界面同步写入。
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
   * 满足本项目硬约束 #4「dtime 必须 ≥ 提交时刻 + 1200 秒」。
   *
   * 置 `true` 时投稿**不带 `dtime`**，稿件通过审核后直接公开。
   * ⚠️ 它会绕过上述硬约束（那是任务书为降低风控风险设的自律措施，**不是 B站规则**：
   * B站只在「传了 dtime」时才要求它 ≥ 提交后 5 分钟）。
   * 代价与风险见 README；试跑期建议保持 `false`。
   *
   * ⚠️ **对「单独投稿」的切片不生效**（2026-10-16 定，2026-10-17 复核仍成立）：那个模式下切片
   * 固定走定时投稿 —— 否则「每片按间隔发」根本无从谈起（立即发布压根不传 dtime）。
   * 注意这与 `clipGapSec` / `jitterSec` 不同：那两个键在单独投稿下**是生效的**
   * （间隔 300 保底、抖动受「小于间隔」夹取），本键是唯一真正不参与的旋钮。
   * 它仍然管**完整版**（`fullVideoBy='assistant'` 时由本服务投）—— 那个语义是
   * 「别等定时、过审即公开」，不该因为切片换了去向就一起改掉。判定见 `resolveClipPublishSchedule()`。
   */
  immediatePublish: boolean;
  /** 失败自动重试一次（仅限判据认为是临时性的失败，见 src/failure-class.ts）；失败仍如实上报 */
  autoRetryOnce?: boolean;
  /**
   * 封面来源：preset = 用预设封面（现状，没预设就不传）；frame = 从评分最高的切片里抽一帧。
   * 默认 preset ⇒ 与历史行为逐字一致（抽帧失败也会自动回退成"不传封面"）。
   */
  coverFrom?: 'preset' | 'frame';
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
  /** 场次结束自动推送一份复盘摘要（切片数/投稿落地/待办项数）；推送失败绝不影响主流程 */
  recapEnabled?: boolean;
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
  /**
   * 「跑完自动关机」（2026-10-14 用户需求）：**开关打开**且六条条件全部满足时关机。
   * 判定逻辑在 `src/auto-shutdown.ts`（纯函数，逐条单测钉死），这里只是参数。
   * 默认**关**；参数都可自定义（用户原话：「时间我可以自定义」）。
   */
  shutdownWhenIdle: {
    /** 开关（界面上那个「跑完自动关机」）。默认 false */
    enabled: boolean;
    /** 条件要**连续**满足多久才关（分钟）—— 防"直播刚断线重连"的假空闲 */
    minIdleMinutes: number;
    /** 允许关机的时段（本地时间 HH:MM）；`windowFrom` > `windowTo` 视为跨午夜；两个都留空 = 不限时段 */
    windowFrom: string;
    windowTo: string;
    /** 关机倒计时秒数（期间可取消：`shutdown /a`） */
    graceSeconds: number;
    /** 只写日志不真关机（想先看它会不会误判时打开） */
    dryRun: boolean;
  };
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

/** 全量默认配置（`loadConfig` 拿它当底，用户 config.json 覆盖上去）。导出供测试断言默认口径。 */
export function defaults(): AppConfig {
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
      roomIds: [],
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
      /* 碎片合并默认开：实测一场直播被 CDN 断成 5 段的形态很常见
         （biliLive-tools 历史里 38% 的录制短于 15 分钟）。 */
      stitch: { ...DEFAULT_STITCH },
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
        /* 进度子批（音频秒）：300 秒 ≈ 33 秒墙上时间 ⇒ 界面每半分钟能看到一次**真实**推进。
           想关掉分批（对照实验）就改成 0。 */
        progressBatchSec: 300,
      },
      // ASR 独立进程：默认关（关着 = 与接线前逐字一致的行为）
      worker: { enabled: false, maxOldSpaceMb: 2048 },
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
      /* 默认=软件编码（任何机器都能跑）。要换硬件编码看上面 `ffmpegOptionsOverride` 的说明 ——
         ⚠️ 必须用预设字段名（encoder/bitrateControl/crf/bitrate/preset/audioCodec），
         原始开关（c:v/b:v…）会被 biliLive-tools 静默忽略。 */
      ffmpegOptionsOverride: { encoder: 'libx264', bitrateControl: 'CRF', crf: '21', preset: 'veryfast', audioCodec: 'copy' },
      fullVideoHasDanmaku: false,
      outputDir: 'data/clips',
      cutTimeoutSec: 3600,
      avSyncRepair: true,
      avSyncToleranceSec: 0.15,
    },
    publish: {
      autoPublish: false,
      isOnlySelf: 1,
      submitGapSec: 1200,
      /* 每片 5 分钟（用户口径）。这是错峰值、非平台规则，见 PublishConfig.clipGapSec 注释 */
      clipGapSec: 300,
      /* 默认等距：用户要的是「每片正好 5 分钟」。想要扰动就填 60–120（会被夹到 < clipGapSec） */
      jitterSec: 0,
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
      /* 出厂白名单：tid 必须和官方分区表一致（2026-10-17 逐条校对过）。
         B站 现在**没有**「虚拟主播」分区，旧的 145 已从示例与线上配置里删掉；
         defaultCategory 必须自己也在白名单里，否则 mapCategoryToTid 会回退到白名单第一项。 */
      tidWhitelist: { '游戏/单机游戏': 17, '游戏/网络游戏': 65, '生活/日常': 21, '娱乐/娱乐粉丝创作': 242 },
      defaultTags: ['直播切片', '名场面'],
      /* 必带标签的出厂默认：用户 2026-10-17 明确要求的五个身份词 + 主播名占位符。
         `{主播}` 替换成本场主播名；识别不出主播名时那条会跳过（并在任务警告里写清楚），其余照常。 */
      identityTags: ['虚拟主播', '2D', '3D', 'VTuber', 'vup', '{主播}'],
      tagSensitiveWords: [],
      defaultTitleSuffix: '',
      descTemplate: '欢迎关注 👉 @{{anchorName}} https://space.bilibili.com/{{anchorUid}}\n本片段来自 {{date}} 的直播《{{liveTitle}}》\n原直播：{{roomUrl}}\n{{desc}}',
      autoCutTimeoutSec: 1800,
      /* 默认 true：规则是「一场直播 = 一个稿件（完整版 + 切片）」，只有多分P 续传能做到。
         关掉它会退化成「一个切片一个稿件」，与完整版不在同一个稿件里。 */
      multiPart: true,
      /* ⚠️ 这里**刻意不给 `clipPublishMode` 默认值**（2026-10-16）：
         这个键一旦由默认值补齐，"用户没动过开关"与"用户显式选了追加"就再也分不出来 ——
         而 `multiPart=false` + 没动开关是**配置错位**（必须拦住，否则投出一堆单片），
         `multiPart=false` + 显式选了单独投稿才是**意图**（必须放行）。
         没有默认值时：键缺失 ⇒ resolveClipPublishMode 按 multiPart 反推 ⇒ 老配置行为逐字不变；
         界面读不到这个键时用 clipModeOf() 反推出同一个结论，用户一保存就写成显式值。 */
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
      /* 跑完自动关机：默认**关**（新功能，先让用户自己打开）。
         默认时段 22:00–08:00、冷静期 15 分钟、倒计时 300 秒 —— 都可在 config.json 里改。 */
      shutdownWhenIdle: {
        enabled: false,
        minIdleMinutes: 15,
        windowFrom: '22:00',
        windowTo: '08:00',
        graceSeconds: 300,
        dryRun: false,
      },
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
  /* 附加直播间走单独一条：roomIds 是数组，上面那个通用 setPath 只会写字符串
     （`typeof prev === 'number'/'boolean'` 之外的都落到 else，写进去会变成 "a,b" 这种脏值）。 */
  const extraRooms = env['LIVE_AUTO_ROOM_IDS'];
  if (extraRooms !== undefined && extraRooms.trim() !== '') {
    cfg.room.roomIds = extraRooms
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
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

/**
 * 把「切片投稿方式」解析成唯一口径 —— **全仓只此一处判定**，daemon / 校验 / 界面提示都调它。
 *
 * 优先级（2026-10-16 加）：
 *   1. 显式设了 `clipPublishMode` → 以它为准（`'append'` / `'standalone'` 都认）；
 *   2. 没设（手改 config.json 的老配置）→ 按 `multiPart` 反推：true ⇒ append、false ⇒ standalone。
 *
 * 为什么要留第 2 条：加入这个键之前，`multiPart` 是唯一的判据，既有配置里可能只有它。
 * 让老配置继续按 multiPart 走，行为与加键之前逐字一致（不需要用户改配置）。
 */
export function resolveClipPublishMode(publish: Pick<PublishConfig, 'clipPublishMode' | 'multiPart'>): ClipPublishMode {
  if (publish.clipPublishMode === 'standalone') return 'standalone';
  if (publish.clipPublishMode === 'append') return 'append';
  return publish.multiPart === true ? 'append' : 'standalone';
}

/**
 * 用户是否**显式**动过「切片投稿方式」这个开关（而不是靠 multiPart 反推出来的）。
 *
 * 用途：老规则下「multiPart=false 且完整版归 biliLive-tools」是**配置错位**，必须拦住；
 * 而用户显式选「单独投稿」是**明确意图**，不该拦。两者只能靠这个函数区分。
 */
export function isClipPublishModeExplicit(publish: Pick<PublishConfig, 'clipPublishMode'>): boolean {
  return publish.clipPublishMode === 'append' || publish.clipPublishMode === 'standalone';
}

/**
 * 「单独投稿」下相邻稿件发布间隔的**下限**（秒）= B站 平台底线 300 秒（投稿页口径「定时发布 ≥5 分钟」）。
 *
 * ★ 2026-10-17 口径更正（用户原话：「这里改成对定时投稿也生效」，指的是设置里的
 *   「相邻切片间隔 / 随机抖动」两个旋钮）：单独投稿**不再把片间隔钉死在 300**，
 *   而是「以 `publish.clipGapSec` 为准、300 保底」——
 *     生效间隔 = `max(STANDALONE_CLIP_GAP_SEC, clipGapSec)`
 *   为什么**只能往上调、不能往下**：B站 要求每一片的 dtime 都晚于**它自己**的提交时刻
 *   300 秒。填 100 时若真按 100 排，第 N+1 片会与第 N 片挤在 100 秒内，而提交是逐片往后推的
 *   ⇒ 靠后的片会撞上平台底线，只能靠 `clampDtimeForSubmit` 事后抬时间（排期形同虚设，
 *   且日志里会出现一串「被合规修正」）。所以这里**当场抬到 300**，并在 note / 校验 / 界面
 *   三处都如实说明「你填的值低于平台底线，实际按 300」。
 *
 * 历史（别再改回去）：2026-10-16 曾把单独投稿的片间隔**钉死**成这个常量，理由是当时
 * `clipGapSec` 在追加模式下完全不起作用（多分P 只有一个 dtime），担心用户为追加模式调过的
 * 老值（线上曾是 7500 秒 = 125 分钟）在切到单独投稿时突然生效、把 8 个切片摊成 16 小时。
 * 现在的做法是「尊重用户的数、但不许低于平台底线」——用户既然把「相邻切片间隔 / 随机抖动」
 * 摆出来给定时投稿用，就该按他填的走，而不是替他锁死。
 */
export const STANDALONE_CLIP_GAP_SEC = 300;

/**
 * 抖动上限的**有效值**：必须严格小于片间隔。
 *
 * 为什么必须有这道夹子（实测会踩）：抖动是**每片独立**随机的，
 * 第 N 片的 dtime = 基准 + (N-1)×间隔 + random(0, 抖动上限)。
 * 抖动 ≥ 间隔时，第 N 片的最大值会越过第 N+1 片的最小值 ⇒ **排期倒挂**
 * （第 2 片比第 1 片先公开，观众看到的顺序是乱的）。
 * 30 秒是安全带：保证「第 N 片最晚」仍早于「第 N+1 片最早」。
 *
 * 例：片间隔 300 秒（每片 5 分钟）+ 抖动上限 1800 ⇒ 实际抖动被压到 270 秒。
 *
 * ★ 放在 `config.ts` 而不是 `publish.ts`（2026-10-17）：`resolveClipPublishSchedule()`
 *   在单独投稿分支里也要用同一道夹子，而 `publish.ts` 已经 import 了 `config.ts` ——
 *   反过来 import 会成环。纯函数放这里，`publish.ts` 再导出一次同名符号（老调用点不变）。
 */
export function effectiveJitterSec(jitterSec: number, clipGapSec: number): number {
  if (!(jitterSec > 0)) return 0;
  return Math.min(jitterSec, Math.max(0, clipGapSec - 30));
}

/** 单个切片投稿时的**实际生效**排期口径（由 `resolveClipPublishSchedule` 算出） */
export interface ClipPublishSchedule {
  /** 当次生效的「切片投稿方式」 */
  mode: ClipPublishMode;
  /** `true` = 定时投稿（payload 带 `dtime`）；`false` = 立即发布（不传 `dtime`） */
  scheduled: boolean;
  /** 相邻切片稿件的发布时间间隔（秒） */
  gapSec: number;
  /** dtime 随机抖动上限（秒）；`0` = 严格等距 */
  jitterSec: number;
  /** 一句话说明这个口径是怎么来的（日志与界面直接用，避免两端各写一遍文案） */
  note: string;
}

/**
 * 切片排期的**唯一判定**：把「切片投稿方式」翻译成实际生效的
 * 「定时/立即 + 间隔 + 抖动」三件套。
 *
 * 规则：
 *
 *   · `standalone`（单独投稿）⇒ **固定定时投稿**（`scheduled` 恒为 true），
 *     间隔 = `max(STANDALONE_CLIP_GAP_SEC, clipGapSec)`、抖动 = `effectiveJitterSec(jitterSec, 间隔)`。
 *     也就是**设置里的「相邻切片间隔 / 随机抖动」在单独投稿下确实生效**（2026-10-17 用户要求），
 *     只有两条硬边界：① 间隔不得低于 B站 平台底线 300 秒；② 抖动必须小于间隔（防排期倒挂）。
 *     唯一**不参与**的是 `immediatePublish` —— 立即发布压根不传 dtime，
 *     「每片按间隔发」就无从谈起，所以单独投稿恒定走定时投稿（见 `describeScheduleOverride`）。
 *   · `append`（追加切片投稿）⇒ 逐字沿用 config 口径（`immediatePublish` /
 *     `clipGapSec` / `jitterSec`）—— 老行为一字未改。
 *
 * ⚠️ 只影响**切片**投稿。完整版（`fullVideoBy='assistant'` 时由本服务投）仍按
 * `immediatePublish` 走：用户那个开关的语义是「别等定时、过审即公开」，
 * 没有理由因为切片换了去向就把它一起改掉。
 */
export function resolveClipPublishSchedule(
  publish: Pick<PublishConfig, 'clipPublishMode' | 'multiPart' | 'immediatePublish' | 'clipGapSec' | 'jitterSec'>,
): ClipPublishSchedule {
  const mode = resolveClipPublishMode(publish);
  if (mode === 'standalone') {
    /* 非数字 / 负数一律回到「没填」的语义（0 ⇒ 保底到 300），绝不让 NaN 流进 computeDtime
       （NaN 会让 dtime 变 NaN，payload 里就是脏数据，B站 只回一个看不懂的 400）。 */
    const wantGap = Number(publish.clipGapSec);
    const rawGap = Number.isFinite(wantGap) && wantGap > 0 ? Math.floor(wantGap) : STANDALONE_CLIP_GAP_SEC;
    const gapSec = Math.max(STANDALONE_CLIP_GAP_SEC, rawGap);
    const wantJitter = Number(publish.jitterSec);
    const rawJitter = Number.isFinite(wantJitter) && wantJitter > 0 ? Math.floor(wantJitter) : 0;
    const jitterSec = effectiveJitterSec(rawJitter, gapSec);
    /* note 必须说真话 —— 它同时进日志、设置面板与任务详情页。
       用户改过的值**没完全生效**时（低于底线 / 抖动被夹），要在这里就说清被改成了多少，
       否则"我明明填了 100，怎么还是 5 分钟"就是下一轮困惑。 */
    const parts: string[] = [];
    if (rawGap < STANDALONE_CLIP_GAP_SEC) {
      parts.push(`间隔按平台底线抬到 ${gapSec} 秒（你填的 ${publish.clipGapSec} 低于 B站 要求的 300 秒）`);
    }
    if (rawJitter > jitterSec) {
      parts.push(`抖动压到 ${jitterSec} 秒（你填的 ${publish.jitterSec} 必须小于片间隔 ${gapSec}，否则排期倒挂）`);
    }
    return {
      mode,
      scheduled: true,
      gapSec,
      jitterSec,
      note:
        `单独投稿：每片一稿、固定定时投稿，相邻稿件间隔 ${gapSec} 秒（${fmtMinutes(gapSec)}）` +
        (jitterSec > 0 ? `，每片再加 0~${jitterSec} 秒随机抖动` : '等距（抖动 0）') +
        '（口径 = 设置里的「相邻切片间隔 / 随机抖动」）' +
        (parts.length ? `；但 ${parts.join('；')}` : ''),
    };
  }
  return {
    mode,
    scheduled: publish.immediatePublish !== true,
    gapSec: publish.clipGapSec,
    jitterSec: publish.jitterSec,
    note:
      publish.immediatePublish === true
        ? '追加切片投稿：所有分P 共用一次投稿（立即发布，不传 dtime）'
        : `追加切片投稿：所有分P 共用一次投稿（定时发布，间隔 ${publish.clipGapSec} 秒只影响批量排期）`,
  };
}

/** 把秒数说成人话（只在 note 里用；`300 ⇒ 5 分钟`、`470 ⇒ 7 分 50 秒`） */
function fmtMinutes(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest} 秒`;
  return rest === 0 ? `${m} 分钟` : `${m} 分 ${rest} 秒`;
}

/**
 * 把 config 里那些**已改实、但当前模式下不生效 / 只部分生效**的排期键列出来，供日志与界面如实说明。
 *
 * 为什么要专门写一句：这类"我改了配置但没反应"的困惑，本仓库已经踩过两次
 * （`multiPart` 配了没人读、`llm_dtype` 传错位置）。第三种形态是「改了、但没有完全生效」
 * （间隔低于平台底线被抬、抖动大于片间隔被夹）—— 那比完全不生效更容易让人抓狂，
 * 所以这里也必须**说清被改成了多少**，而不是静默。
 *
 * 返回空字符串 = 没有需要说明的项（干净配置不该被念）。
 */
export function describeScheduleOverride(
  publish: Pick<PublishConfig, 'clipPublishMode' | 'multiPart' | 'immediatePublish' | 'clipGapSec' | 'jitterSec'>,
): string {
  const s = resolveClipPublishSchedule(publish);
  if (s.mode !== 'standalone') return '';
  const notes: string[] = [];
  /* ① 确实不参与：立即发布。单独投稿恒定走定时投稿（不传 dtime 就没有「每片按间隔发」）。 */
  if (publish.immediatePublish === true) {
    notes.push('publish.immediatePublish=true 对切片不生效（单独投稿固定走定时投稿；由本服务投完整版时仍按它走）');
  }
  /* ② 生效但被抬：间隔低于 B站 平台底线。 */
  if (Number(publish.clipGapSec) < STANDALONE_CLIP_GAP_SEC) {
    notes.push(
      `publish.clipGapSec=${publish.clipGapSec} 低于 B站 平台底线，实际按 ${s.gapSec} 秒排期（只能往上调、不能往下）`,
    );
  }
  /* ③ 生效但被夹：抖动必须小于片间隔，否则排期倒挂。 */
  const wantJitter = Number(publish.jitterSec) > 0 ? Number(publish.jitterSec) : 0;
  if (wantJitter > s.jitterSec) {
    notes.push(
      `publish.jitterSec=${publish.jitterSec} 已压到 ${s.jitterSec} 秒（抖动必须小于片间隔 ${s.gapSec}，否则排期倒挂）`,
    );
  }
  if (notes.length === 0) return '';
  return `单独投稿排期：${notes.join('；')}`;
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

  /* 本地 Fun-ASR 的解码器精度：只认 funasr `dtype_map` 里的三个键。
     ⚠️ 2026-10-13 实测教训：这个值曾经被传给 `generate()` 而 funasr 只在**构造模型**时读它
     ⇒ 静默忽略，用户以为开了 bf16 其实还是 fp32（显存一模一样）。所以这里只做"值合法性"校验；
     "到底生没生效"由转写体检行里的实际精度 + 显存峰值来证明。 */
  if (cfg.asr.localFunasr.llmDtype) {
    const dt = String(cfg.asr.localFunasr.llmDtype).toLowerCase();
    if (!['bf16', 'fp16', 'fp32'].includes(dt)) {
      err(
        'asr.localFunasr.llmDtype',
        `不认识的值：${cfg.asr.localFunasr.llmDtype}（funasr 只支持 bf16 / fp16 / fp32）`,
        '填 bf16（40 系卡推荐）或删掉这一项回到 fp32 默认值',
      );
    } else if (dt === 'fp16') {
      warn(
        'asr.localFunasr.llmDtype',
        'fp16 会产生退化重复输出（funasr 官方在 vLLM 路径也强制用 bf16），不建议',
        '改成 bf16；或删掉这一项用默认 fp32',
      );
    }
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
  /* 附加直播间（设置页的「添加直播」）：可为空；填了就必须是"能用的房间号"，且不能与主房间重复。
     不在这里去重/纠正 —— 校验只报告，改由用户改（与其它字段口径一致）。 */
  if (!Array.isArray(cfg.room.roomIds)) {
    err('room.roomIds', 'roomIds 必须是字符串数组', '在设置页用「添加直播」维护；手改请写成 ["12345678"]');
  } else {
    const seenRooms = new Set<string>([String(cfg.room.roomId ?? '').trim()]);
    cfg.room.roomIds.forEach((raw, i) => {
      const v = String(raw ?? '').trim();
      if (!v) {
        err(`room.roomIds[${i}]`, '附加直播间房间号为空', '删掉这一行，或填真实房间号（例如 23456789）');
        return;
      }
      if (!/^\d+$/.test(v)) {
        warn(`room.roomIds[${i}]`, `房间号「${v}」不是纯数字`, 'B站 房间号通常是数字；写成别的会让 recent-clips 静默返回空数组');
      }
      if (seenRooms.has(v)) {
        err(`room.roomIds[${i}]`, `房间号重复：${v}`, '主直播间与附加直播间不能重复，否则同一份录制历史会被拉两遍');
      }
      seenRooms.add(v);
    });
  }
  // 陷阱 #1：platform 必须首字母大写
  if (cfg.room.platform !== 'Bilibili') {
    err('room.platform', `platform 必须为 "Bilibili"（当前 "${cfg.room.platform}"）`, '改为 Bilibili；传错会静默返回空数组');
  }

  // 硬约束 #4：dtime 余量（**本项目**的自律下限，不是平台规则；平台底线仅 300 秒）
  if (cfg.publish.submitGapSec < DTIME_MIN_MARGIN_SEC) {
    err(
      'publish.submitGapSec',
      `首片提交余量必须 ≥ ${DTIME_MIN_MARGIN_SEC} 秒（当前 ${cfg.publish.submitGapSec}）；B站平台底线只有 300 秒，多出来的是本项目防风控的自律余量`,
      `建议 ${DTIME_MIN_MARGIN_SEC} 或更大`,
    );
  }
  /* 片间隔（`clipGapSec`）是**我们自己的**错峰值，不是平台要求：
     平台规则是「每片的 dtime 必须晚于**它自己**的提交时刻 300 秒」（投稿页口径「≥5 分钟」），与上一个切片无关
     ⇒ 早先这里「< 7200 就告警」的写法会把我们自己的保守取值说成平台规则，
     用户按 5 分钟间隔排期时会被这条假告警反复干扰（实测误导）。现在只守真正的不变量：
     ① 间隔别小到等于同时发布；② 抖动必须小于间隔，否则排期倒挂。

     ★ 2026-10-17：两条都用**生效值**（`resolveClipPublishSchedule`）判，不用 config 的原始值 ——
     单独投稿下间隔会被抬到 300、抖动会被夹到「间隔−30」，拿原始值判会把"其实没事"的配置
     报成告警（`clipGapSec=100 + jitterSec=200` 在单独投稿下实际是 300/200，完全合法）。
     越界本身由下面 standalone 那一段逐键说明「实际跑成了多少」。 */
  const schedForCheck = resolveClipPublishSchedule(cfg.publish);
  if (schedForCheck.gapSec < 60) {
    warn(
      'publish.clipGapSec',
      `生效的相邻切片间隔只有 ${schedForCheck.gapSec} 秒，实际等于同时发布`,
      '按分钟级错峰才有意义，建议 ≥300（每片 5 分钟）',
    );
  }
  if (schedForCheck.jitterSec >= schedForCheck.gapSec && schedForCheck.gapSec > 0) {
    const capped = Math.max(0, schedForCheck.gapSec - 30);
    warn(
      'publish.jitterSec',
      `生效抖动 ${schedForCheck.jitterSec} 秒 ≥ 生效片间隔 ${schedForCheck.gapSec} 秒，排期可能倒挂（第 2 片比第 1 片先公开）`,
      `已自动压到 ${capped} 秒；要严格等距就把 jitterSec 设为 0`,
    );
  }
  /* 切片阶段并发（有界流水线）：默认 1 = 与历史行为逐字一致 */
  const cutConc = cfg.clip.concurrency ?? 1;
  if (!Number.isInteger(cutConc) || cutConc < 1 || cutConc > 4) {
    err('clip.concurrency', '切片并发必须是 1–4 的整数', '并发只并行 ffmpeg 切片；上传仍串行并保留风控抖动');
  } else if (cutConc >= 3) {
    warn('clip.concurrency', `切片并发 ${cutConc} 较高`, '本地 Fun-ASR 与 ffmpeg 会抢 CPU；转写期间系统会自动降到 1');
  }
  /* LLM 输出上限（P2 配置面收尾：这是孤儿字段里唯一真正缺校验的高价值项 ——
     太小会让选片结果被截断，表现为"候选数异常少"，很难往配置上想）。 */
  if (!Number.isInteger(cfg.llm.select.maxTokens) || cfg.llm.select.maxTokens < 256) {
    err('llm.select.maxTokens', 'LLM 输出上限太小', '低于 256 会让选片结果被截断，表现为候选数异常少');
  } else if (cfg.llm.select.maxTokens > 32000) {
    warn('llm.select.maxTokens', `LLM 输出上限 ${cfg.llm.select.maxTokens} 偏大`, '选片输出通常用不到这么多，白烧 token');
  }
  if (cfg.clip.minDurationSec <= 0 || cfg.clip.maxDurationSec <= cfg.clip.minDurationSec) {
    err('clip.minDurationSec', '片段时长范围不合法', '确保 0 < minDurationSec < maxDurationSec');
  }

  /* 完整版（弹幕版 + 纯享版）的归属：默认由 biliLive-tools 投，切片助手只追加切片分P。
     这条规则要求「切片与完整版在同一个稿件」，而只有多分P 续传（`vid` → editMedia）能做到 ——
     单切片一稿模式下每个切片是独立稿件，天然满足不了。所以这里必须拦住。
     ⚠️ 例外：用户**显式**选了「单独投稿」（`clipPublishMode='standalone'`）—— 那是明确意图，
     不是配置错位，此时不该拦（拦了就等于这个开关点了没反应）。 */
  if (cfg.publish.clipPublishMode !== 'standalone' && cfg.publish.fullVideoBy !== 'assistant' && cfg.publish.multiPart !== true) {
    err(
      'publish.multiPart',
      '默认规则是「完整版由 biliLive-tools 投、切片助手只追加切片分P 到同一个稿件」，' +
        '这要求 publish.multiPart=true（多分P 续传）；当前 multiPart=false 会把每个切片投成独立稿件',
      '把 publish.multiPart 设为 true；确实要让每个切片单独投稿时，在设置里把「切片投稿方式」改成「单独投稿」' +
        '（等价于 publish.clipPublishMode="standalone"）',
    );
  }
  /* 两个口径打架时以「切片投稿方式」为准，并如实说明 —— 不能静默按其中一个跑。
     典型来路：手改 config.json 只改了一个键，或界面保存的是旧版本。 */
  if (cfg.publish.clipPublishMode === 'append' && cfg.publish.multiPart !== true) {
    err(
      'publish.multiPart',
      '「切片投稿方式 = 追加切片投稿」要求 publish.multiPart=true（多分P 续传是唯一的追加手段），当前为 false',
      '把 publish.multiPart 设为 true；或把「切片投稿方式」改成「单独投稿」',
    );
  }
  if (cfg.publish.clipPublishMode === 'standalone' && cfg.publish.multiPart === true) {
    warn(
      'publish.clipPublishMode',
      '「切片投稿方式 = 单独投稿」会忽略 publish.multiPart=true：本场切片各自一个稿件，不追加进完整版稿件',
      '要追加进同一个稿件就把「切片投稿方式」改回「追加切片投稿」（界面保存时会同步两个键）',
    );
  }
  /* 单独投稿下的排期：片间隔/抖动**确实生效**（2026-10-17 起），但有两条硬边界 ——
     ① 间隔不得低于 B站 平台底线 300 秒；② 抖动必须小于片间隔（防排期倒挂）。
     用户填了越界的值时，实际值会被抬/压，所以必须**逐个键**如实说清「你填的 X 实际跑成了 Y」
     （逐键而不是一句话打包：界面按 field 显示与定位，打包成一条就看不出是哪个键了）。
     仅 `immediatePublish` 在单独投稿下对切片不参与（固定定时投稿）。 */
  if (cfg.publish.clipPublishMode === 'standalone') {
    const sched = resolveClipPublishSchedule(cfg.publish);
    if (cfg.publish.immediatePublish === true) {
      warn(
        'publish.immediatePublish',
        `单独投稿固定走「定时投稿」（不传 dtime 就没有「每片按间隔发」），publish.immediatePublish=true 对切片不生效` +
          '（由本服务投完整版时仍按它走：过审即公开）',
        '要让切片过审即公开就切回「追加切片投稿」；否则把这一项关掉',
      );
    }
    if (Number(cfg.publish.clipGapSec) < STANDALONE_CLIP_GAP_SEC) {
      warn(
        'publish.clipGapSec',
        `publish.clipGapSec=${cfg.publish.clipGapSec} 低于 B站 平台底线 ${STANDALONE_CLIP_GAP_SEC} 秒` +
          `（每片 dtime 必须晚于它自己的提交时刻 300 秒），实际按 ${sched.gapSec} 秒排期`,
        `改成 ≥ ${STANDALONE_CLIP_GAP_SEC}（想每片 5 分钟就填 300，想更散就填更大）`,
      );
    }
    if (Number(cfg.publish.jitterSec) > sched.jitterSec) {
      warn(
        'publish.jitterSec',
        `publish.jitterSec=${cfg.publish.jitterSec} 大于「片间隔 − 30」，实际压到 ${sched.jitterSec} 秒` +
          `（抖动 ≥ 片间隔会让第 N+1 片抢在第 N 片之前公开 ⇒ 排期倒挂）`,
        `改成 ≤ ${sched.jitterSec}；或把「相邻切片间隔」调大`,
      );
    }
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
  /* ★ 2026-10-06：用户**明确选择公开可见**（`publish.isOnlySelf = 0`），
     所以这里不再把"必须是 1"当告警 —— 那是试跑期的临时约定，不是配置错误。
     现在只拦真正的错值（不是 0/1，例如被写成字符串或 true）：
     可见性是个**用户决定**，不该每次加载都跳一条"你应该改回去"的提示；
     但也不能让它悄悄漂移，所以冒烟测试每次会把当前可见性作为"环境项"报一次
     （`test/smoke.ts` 硬约束 #10 已按此改写）。 */
  if (cfg.publish.isOnlySelf !== 0 && cfg.publish.isOnlySelf !== 1) {
    warn('publish.isOnlySelf', `取值必须是 0（公开）或 1（仅自己可见），当前是 ${JSON.stringify(cfg.publish.isOnlySelf)}`);
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
  /* 回收站保留天数（2026-10-11 用户要求「添加只保留几天的设置 超长时间的自动删除」）：
     这个值直接决定"误删之后还有没有后悔药"，两个方向都要说清楚 ——
     0 不是"立刻清理"，而是**不用回收站**（删任务直接永久删），属于更危险的一侧。 */
  if (!Number.isFinite(cfg.cleanup.trashDays) || !Number.isInteger(cfg.cleanup.trashDays) || cfg.cleanup.trashDays < 0) {
    err(
      'cleanup.trashDays',
      `回收站保留天数必须是不小于 0 的整数（当前 ${String(cfg.cleanup.trashDays)}）`,
      '例如 7；0 = 不用回收站（删除任务直接永久删除）',
    );
  } else if (cfg.cleanup.trashDays === 0) {
    warn(
      'cleanup.trashDays',
      '回收站已关闭（0）：删除任务会**直接永久删除**，误点了也恢复不了',
      '想保留反悔机会就设成 7（默认）',
    );
  } else if (cfg.cleanup.trashDays < 1) {
    warn('cleanup.trashDays', '回收站保留不足 1 天，过夜就可能被自动清理掉');
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
