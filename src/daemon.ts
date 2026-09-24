/**
 * WP6 —— 常驻服务与编排（任务书 §8 WP6）。
 *
 * 状态机：`IDLE → RECORDED → TRANSCRIBED → ANALYZED → CLIPPED → PUBLISHED`
 * 每个阶段产出落盘，支持 `--from-stage=<阶段>` 重跑（半自动模式下人工改完标题后重跑也走这里）。
 *
 * 几条贯穿全局的硬性要求，在本文件里集中落实：
 *  - **完整版上传与转写/分析并行**，不是串行（§1）。上传吃带宽、转写吃算力，互不冲突。
 *    先等上传完成再转写会把出片时间从 1.5–3.5 小时变成 3–5 小时。
 *  - **切片流程不等待完整版上传**：切片的前置条件只有「源文件存在且可用」。
 *  - **场次级串行**：同一时间只处理一场直播（§8 WP5 步骤 6）。两场同时压制 + 转写会把
 *    CPU / GPU / 上行全部吃满，双方都变慢，还容易超时失败。
 *  - **压制与 ASR 的并行策略按 ASR 类型区分**（硬约束 #6）：本地 Whisper 必须串行（争 GPU），云 ASR 可并行。
 *  - `--dry-run` 默认不得调用付费 ASR/LLM（硬约束 #14）。
 *  - 每个任务目录保留全链路可追溯的日志与产出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BiliLiveClient } from './api.ts';
import type { AppConfig } from './config.ts';
import { ConfigStore, resolveDataPath } from './config.ts';
import type { Ledger } from './ledger.ts';
import { ledger as defaultLedger } from './ledger.ts';
import type { Alerter } from './alert.ts';
import { Alerter as DefaultAlerter } from './alert.ts';
import { Analyzer, persistAnalysis, PromptStore } from './analyze.ts';
import { AsrCache, Transcriber, isDryRunPaymentRejection, type AsrMediaAdapter } from './asr.ts';
import { Cleaner, checkAfterUploadDelete, judgeDeletability, rotateLogs } from './cleanup.ts';
import { writeErrorReport, setErrorReportDir, type ErrorReportInput } from './errors.ts';
import { LlmClient } from './llm.ts';
import {
  Publisher,
  absPath,
  archivePartCount,
  cleanLiveTitle,
  extractTitleDate,
  guessAnchorName,
  isArchiveGoneError,
  resolveResumeTarget,
  taskDateText,
} from './publish.ts';
import type { CutAndUploadResult } from './publish.ts';
import { Trigger, WebhookRelay } from './trigger.ts';
import { WatchImporter } from './watch-import.ts';
import { detectStreamer } from './streamer.ts';
import { runDueDeletions, scheduleDelete } from './pending-delete.ts';
import {
  buildSegmentMap,
  buildSourceMedia,
  danmaKind,
  discoverSegments,
  findFfprobe,
  normalizeRecord,
  probeMedia,
} from './media.ts';
import { analyzeDanmaku } from './danmaku.ts';
import { mergeDanmakuXmlFiles, pairSegmentDanmaku, chooseDanmaku } from './danmaku-merge.ts';
import { findSiblingDanmaku } from './recordings.ts';
import { GlossaryStore, correctTranscript } from './glossary.ts';
import { TRASH_DIR, listTrash, moveToTrash, purgeTrash, restoreFromTrash, trashStats } from './trash.ts';
import type {
  ArchiveItem,
  ClipRecord,
  ErrorType,
  Signals,
  SourceSegment,
  Stage,
  TaskCost,
  TaskRecord,
  TaskStatus,
  Transcript,
} from './types.ts';
import { buildLlcContent } from './analyze.ts';
import {
  DATA_DIR,
  ERRORS_PATH,
  ERROR_REPORT_DIR,
  LOGS_DIR,
  CLIPS_DIR,
  appendJsonl,
  ensureDir,
  exists,
  fileSize,
  fmtBytes,
  fmtDuration,
  fmtHuman,
  fmtLocal,
  nowIso,
  readJson,
  sleep,
  writeJsonAtomic,
} from './util.ts';
import { Logger, log as globalLog } from './logger.ts';
import type { TriggerDecision } from './trigger.ts';

/* ============================================================================
 * 编排参数
 * ========================================================================== */

export interface OrchestratorOptions {
  /** CLI 覆盖：目标直播间 */
  roomId?: string;
  /** 只跑这一条录制（按 recordingId 精确指定） */
  recordingId?: string;
  /** 离线模式：直接对指定视频文件跑一遍（可附带弹幕与标题） */
  video?: { path: string; danmaPath?: string; title?: string };
  /** 只到 clips.json + 摘要，不切片不投稿 */
  dryRun?: boolean;
  /** 显式允许产生费用 */
  allowPaid?: boolean;
  /** 从指定阶段重跑 */
  fromStage?: Stage;
  /** UI 的「立即检查」等一次性动作 */
  once?: boolean;
  /** 是否启动常驻轮询（CLI run 时为 true） */
  startPolling?: boolean;
  /** 指定 taskId（用于重跑某一场） */
  taskId?: string;
  /**
   * 配置文件路径。默认 config.json。
   * 端到端测试用它指向临时配置，避免污染真实凭据与 data/。
   */
  configPath?: string;
  /**
   * 台账实例。默认全局单例（data/ledger.json）。
   * 端到端测试注入指向临时目录的实例，实现完全隔离。
   */
  ledger?: Ledger;
  /** 状态与日志的输出目录覆盖（默认跟着 data/） */
  dataDirOverride?: string;
  /**
   * 触发器的「自动处理基线」覆盖（毫秒）。
   *
   * - 不传：生产默认 —— 首次运行取当前时刻为基线，只自动处理之后结束的录制（不回头补跑历史）；
   * - 传 0：关闭基线。**离线端到端测试必须传它** —— mock 造出来的录制时间早于当前时刻，
   *   建立基线后对账会把它们全部过滤掉，测试就永远触发不了（实测就是这么挂的）。
   */
  triggerBaselineMs?: number;
  /**
   * 本次运行的 ASR provider 覆盖（CLI `--local-asr`）。
   * 只影响本进程，不写配置 —— 便于"试一次本地识别"再决定要不要长期切换。
   */
  asrProvider?: 'bililive-tools' | 'whisper-cpp';
}

/* ============================================================================
 * 编排器
 * ========================================================================== */

export class Orchestrator {
  readonly store: ConfigStore;
  readonly ledger: Ledger;
  readonly client: BiliLiveClient;
  readonly llm: LlmClient;
  readonly analyzer: Analyzer;
  readonly transcriber: Transcriber;
  readonly publisher: Publisher;
  readonly cleaner: Cleaner;
  readonly alerter: Alerter;
  readonly trigger: Trigger;
  /** 目录轮询自动导入（「把录播丢进目录就自动跑完」） */
  readonly watcher: WatchImporter;
  readonly relay: WebhookRelay;
  readonly prompts: PromptStore;
  /** 术语表（主播名 / 专有名词 / ASR 纠错规则），UI 可编辑，热加载 */
  readonly glossary: GlossaryStore;
  readonly logger: Logger;

  private opts: OrchestratorOptions;
  private bootedAt = nowIso();
  /** 运行期目录覆盖（端到端测试用，避免污染真实 data/） */
  private dataDir: string;
  /** 各任务的进度（供 UI 读取细粒度进度，如「转写中 12/24」） */
  readonly progress = new Map<string, { label: string; current: number; total: number }>();
  /** 正在处理的任务（场次级串行） */
  private busy = false;
  private queue: Array<{ taskId: string; fromStage?: Stage }> = [];
  private paused = false;
  private lastErrorCount = 0;
  /** bvid 反查循环定时器 */
  private confirmTimer?: NodeJS.Timeout;
  /** 「等 biliLive-tools 投完整版」的重查定时器 */
  private waitTimer?: NodeJS.Timeout;
  /** 稿件表现数据回流定时器 */
  private perfTimer?: NodeJS.Timeout;
  /** 配置文件变更监听定时器 */
  private cfgTimer?: NodeJS.Timeout;
  /** 「用完即删」的执行循环（每 10 分钟检查待删清单） */
  private pendingDeleteTimer?: NodeJS.Timeout;

  constructor(opts: OrchestratorOptions = {}) {
    this.opts = opts;
    this.store = new ConfigStore(opts.configPath);
    const cfg = this.store.config;
    // 应用 CLI 覆盖（不落盘）
    if (opts.roomId) cfg.room.roomId = opts.roomId;

    const level = cfg.runtime.logLevel;
    this.logger = new Logger({ level, file: true, color: true });
    globalLog.setLevel(level);

    this.ledger = opts.ledger ?? defaultLedger;
    this.dataDir = opts.dataDirOverride ?? DATA_DIR;
    // 错误报告目录跟随 dataDir 覆盖 —— 否则端到端测试会把报告写进真实 data/
    if (opts.dataDirOverride) setErrorReportDir(path.join(opts.dataDirOverride, 'error-report'));
    this.client = BiliLiveClient.fromConfig(cfg, this.logger);
    this.llm = LlmClient.fromConfig(cfg, this.logger);
    this.prompts = new PromptStore();
    // 术语表文件跟随 dataDir 覆盖（端到端测试不该写用户的真实术语表）
    this.glossary = new GlossaryStore(path.join(this.dataDir, 'glossary.json'), this.logger);
    this.analyzer = new Analyzer({ llm: this.llm, config: cfg, logger: this.logger, prompts: this.prompts });
    this.transcriber = new Transcriber({
      client: this.client,
      config: cfg,
      logger: this.logger,
      // ★ 缓存目录必须解析成绝对路径：相对路径会跟着启动时的工作目录跑，
      //   换个位置启动就找不到旧缓存 → 已付过费的转写被重跑一遍（直接关系到钱）。
      cache: new AsrCache(resolveDataPath(cfg.asr.cacheDir), this.logger),
      // CLI --local-asr：本次运行强制走本地识别（不改配置、不留副作用）
      ...(this.opts.asrProvider ? { provider: this.opts.asrProvider } : {}),
    });
    this.publisher = new Publisher({ client: this.client, config: cfg, ledger: this.ledger, logger: this.logger });
    this.alerter = new DefaultAlerter({ config: cfg.alert, logger: this.logger });
    this.cleaner = new Cleaner({
      config: cfg,
      ledger: this.ledger,
      logger: this.logger,
      alerter: this.alerter,
      onDiskLow: () => {
        this.paused = true;
      },
      onDiskRecovered: () => {
        this.paused = false;
      },
    });
    /* 目录轮询导入：与上面的 trigger 是两条独立的腿 ——
       trigger 轮 biliLive-tools 的录制历史接口（房间没记录时返回空），
       这里直接盯目录（文件在那里就一定能被发现）。 */
    this.watcher = new WatchImporter({
      config: cfg,
      ledger: this.ledger,
      logger: this.logger,
      client: this.client,
      importFn: async (input) => {
        /* ★ 必须显式传 source:'auto'：否则这条自动导入的任务会被标成「手动导入」，
           界面上与用户自己点「导入录播」建的任务长得一模一样（实测缺陷）。 */
        const r = await this.importLocal({ ...input, source: 'auto' });
        return { id: r.id };
      },
    });
    this.trigger = new Trigger({
      client: this.client,
      config: cfg,
      logger: this.logger,
      statePath: path.join(this.dataDir, 'trigger-state.json'),
      processedIdsProvider: () => {
        const set = new Set<string>();
        for (const t of this.ledger.listTasks({ limit: 2000 })) {
          if (t.recordingId) set.add(t.recordingId);
        }
        return set;
      },
      onTrigger: (d) => this.onTriggered(d),
      // 离线端到端测试要传 0 关掉基线（mock 造的录制时间早于当前时刻，否则永远触发不了）
      ...(this.opts.triggerBaselineMs !== undefined ? { baselineMs: this.opts.triggerBaselineMs } : {}),
    });
    this.relay = new WebhookRelay({ client: this.client, config: cfg, logger: this.logger });

    // 配置热加载：所有组件同步更新
    this.store.onChange((c) => {
      this.client.update({
        baseUrl: c.bililive.baseUrl,
        passKey: c.bililive.passKey,
        timeoutMs: c.bililive.timeoutMs,
        asrTimeoutMs: c.bililive.asrTimeoutMs,
        retry: c.bililive.retry,
      });
      this.llm.update(c.llm);
      this.analyzer.update(c);
      this.transcriber.update(c);
      this.publisher.update(c);
      this.cleaner.update(c);
      this.alerter.update(c.alert);
      this.logger.setLevel(c.runtime.logLevel);
      globalLog.setLevel(c.runtime.logLevel);
      this.logger.info('配置已热加载，新配置对后续步骤生效');
    });
  }

  get config(): AppConfig {
    return this.store.config;
  }

  /* ------------------------------------------------------------------------
   * 启动自检
   * ---------------------------------------------------------------------- */

  /**
   * 启动自检：把「会导致整条链路静默失效」的前提逐条验一遍，并给出可执行结论。
   *
   * 覆盖的陷阱：#1 platform、#2 streamer 表、#5 ASR 模型、#11 上传后删除、#14 dry-run 付费、版本漂移。
   */
  async selfCheck(): Promise<Array<{ ok: boolean; item: string; detail: string; fix?: string }>> {
    const cfg = this.config;
    const out: Array<{ ok: boolean; item: string; detail: string; fix?: string }> = [];
    const push = (ok: boolean, item: string, detail: string, fix?: string): void => {
      out.push(fix ? { ok, item, detail, fix } : { ok, item, detail });
    };

    // 配置硬约束
    const cfgErrors = this.store.errors;
    push(
      cfgErrors.length === 0,
      '配置文件硬约束校验',
      cfgErrors.length === 0 ? '通过' : cfgErrors.map((e) => `[${e.field}] ${e.message}`).join('；'),
      cfgErrors.length ? cfgErrors.map((e) => e.fix).filter(Boolean).join('；') : undefined,
    );

    // 连通性 + 版本
    try {
      const v = await this.client.version();
      const drift = await this.client.checkVersionDrift(cfg.bililive.versionExpected);
      push(
        !(drift?.drift ?? false),
        'biliLive-tools 连通性与版本',
        drift ? drift.note : `连上 ${cfg.bililive.baseUrl}，版本 ${v}`,
        drift?.drift ? '跑一次 node src/probe.ts 复核接口字段是否变动' : undefined,
      );
      if (drift?.drift) {
        await this.alerter.versionDrift({ actual: drift.actual, expected: drift.expected, note: drift.note });
      }
    } catch (e) {
      push(
        false,
        'biliLive-tools 连通性',
        `无法访问 ${cfg.bililive.baseUrl}：${(e as Error).message}`,
        '确认 biliLive-tools 桌面版已启动，且 config.json 的 bililive.passKey 与它「设置 → 服务」中的 PassKey 一致（401 就是这个问题）',
      );
    }

    // 账号与 uid
    try {
      const users = await this.client.userList();
      if (users.length === 0) {
        push(false, 'B站账号', '没有已登录账号', '在 biliLive-tools 中扫码登录');
      } else {
        const u = users[0]!;
        const days = u.expires ? (u.expires - Date.now()) / 86400_000 : undefined;
        const expired = days !== undefined && days <= 0;
        push(
          !expired,
          'B站账号有效期',
          `uid=${u.uid} ${u.name ?? ''}${days !== undefined ? `，剩余 ${days.toFixed(0)} 天` : '（无 expires 字段）'}`,
          expired ? 'cookie 已过期，必须人工重新扫码（无法自动续期）' : undefined,
        );
        if (days !== undefined && days <= cfg.alert.accountExpireWarnDays) {
          await this.alerter.accountExpiring({ uid: u.uid, ...(u.name ? { name: u.name } : {}), ...(u.expires ? { expires: u.expires } : {}), daysLeft: days, expired });
        }
      }
    } catch (e) {
      push(false, 'B站账号', `查询失败：${(e as Error).message}`);
    }

    // 目标直播间是否有录制记录（陷阱 #1 / #2：这两个原因都会静默返回空数组）
    try {
      const recent = await this.client.recentClips(cfg.room.roomId, cfg.room.platform, this.logger);
      if (recent.length === 0) {
        const hist = await this.client.recordHistoryList({ roomId: cfg.room.roomId, platform: cfg.room.platform, page: 1, pageSize: 5 });
        if (hist.total === 0) {
          push(
            false,
            '目标直播间录制记录',
            `直播间 ${cfg.room.roomId} 在 record-history 中没有任何记录 —— recent-clips 会**静默返回空数组**，触发逻辑永不生效（陷阱 #2）`,
            `在 biliLive-tools 中为直播间 ${cfg.room.roomId} 添加录制任务并至少完成一次录制；platform 必须为 "Bilibili"（首字母大写，陷阱 #1）`,
          );
        } else {
          push(true, '目标直播间录制记录', `recent-clips 为空但历史有 ${hist.total} 条记录（可能是历史较久），触发链路可用`);
        }
      } else {
        push(true, '目标直播间录制记录', `recent-clips 返回 ${recent.length} 条，触发链路可用`);
      }
    } catch (e) {
      push(false, '目标直播间录制记录', `查询失败：${(e as Error).message}`);
    }

    // ASR 模型是否配置（陷阱 #5：未配置会直接抛错）
    try {
      const cfgRaw = await this.client.getConfig();
      const flat = flattenForCheck(cfgRaw);
      /* ⚠️ 必须连**值**一起校验，不能只看键名是否存在。
         实测：biliLive-tools 的 `ai.subtitleRecognize.modelId` 是空串时，
         键名照样存在，旧写法会报「已配置」——是假绿。
         而空模型名会让 /ai/subtitle 直接报「请先在配置中设置字幕识别ASR模型」，
         自检的意义恰恰是在跑之前把这种情况指出来。 */
      const asrEntry = Object.entries(flat).find(([k]) => /subtitleRecognize/i.test(k));
      const asrValue = asrEntry ? asrEntry[1] : undefined;
      const asrConfigured = typeof asrValue === 'string' ? asrValue.trim() !== '' : asrValue !== undefined && asrValue !== null;
      push(
        asrConfigured,
        'ASR 字幕识别模型',
        !asrEntry
          ? '未能从 /config 确认字幕识别模型'
          : asrConfigured
            ? `已配置（${asrEntry[0]} = ${typeof asrValue === 'string' ? asrValue : JSON.stringify(asrValue)}）`
            : `${asrEntry[0]} 是空的 —— 调用 /ai/subtitle 会直接报「请先在配置中设置字幕识别ASR模型」`,
        asrConfigured ? undefined : '设置 → AI 配置 → 模型 → 给「字幕识别」指定一个**勾选了 ASR 标签**的模型',
      );
      // 硬约束 #11
      const del = checkAfterUploadDelete(cfg, cfgRaw);
      push(del.ok, '「上传后删除素材」已关闭', del.message, del.fix);
    } catch (e) {
      push(true, 'biliLive-tools 配置检查', `跳过（/config 不可读：${(e as Error).message}）`);
    }

    // 磁盘
    const disk = this.cleaner.canStartNewTask();
    push(
      disk.ok,
      '磁盘空间',
      disk.disk ? `剩余 ${disk.disk.freeGB.toFixed(1)} GB / 总 ${disk.disk.totalGB.toFixed(0)} GB（阈值 ${cfg.cleanup.diskFloorGB} GB）` : '无法查询（fs.statfs 不可用）',
      disk.ok ? undefined : disk.reason,
    );

    // ffmpeg / whisper（本地方案的前提，不阻塞主线）
    const ffprobe = findFfprobe();
    push(
      Boolean(ffprobe),
      'ffprobe 可用性',
      ffprobe ? `找到 ${ffprobe}` : '未找到 ffprobe —— 「分段文件 → 全局时间」映射将退化为按录制时长估算（多分段场景会不准）',
      ffprobe ? undefined : '把 ffprobe 加入 PATH，或在 config.json 的 asr.silenceTrim.ffmpegPath 指明 ffmpeg 目录',
    );

    // 合集（陷阱 #19）
    push(
      cfg.publish.seasonId > 0,
      '合集 ID（seasonId）',
      cfg.publish.seasonId > 0
        ? `已配置 seasonId=${cfg.publish.seasonId}，同场切片会归入同一合集`
        : '未配置 seasonId —— **没有任何接口能创建合集**，切片会照常投稿但无法归入同一合集',
      cfg.publish.seasonId > 0 ? undefined : '在 B站创作中心手动建一个合集，把 ID 填进 config.json 的 publish.seasonId',
    );

    // 付费开关提示
    push(
      !(this.opts.dryRun && !this.opts.allowPaid),
      'dry-run 付费保护',
      this.opts.dryRun && !this.opts.allowPaid
        ? 'dry-run 且未传 --allow-paid：不会调用付费 ASR/LLM（硬约束 #14）'
        : '允许产生费用',
    );

    const failed = out.filter((o) => !o.ok);
    this.logger.info(`启动自检完成：${out.length - failed.length}/${out.length} 项通过`);
    return out;
  }

  /* ------------------------------------------------------------------------
   * 生命周期
   * ---------------------------------------------------------------------- */

  /** 启动常驻服务 */
  async start(opts: { polling?: boolean } = {}): Promise<void> {
    const cfg = this.config;
    ensureDir(DATA_DIR);
    ensureDir(LOGS_DIR);
    ensureDir(ERROR_REPORT_DIR);

    this.logger.info(
      `live_auto 启动：房间 ${cfg.room.roomId}，模式 ${cfg.publish.autoPublish ? '全自动' : '半自动（需确认后发布）'}` +
        `${this.opts.dryRun ? '，dry-run' : ''}${this.opts.allowPaid ? '，allow-paid' : ''}`,
    );

    // 崩溃恢复：先处理上次卡住的状态（§8 WP5 步骤 5）
    try {
      const rec = await this.publisher.recoverStuck();
      if (rec.checked) this.logger.info(`崩溃恢复：检查 ${rec.checked} 个卡住的切片，确认 ${rec.confirmed} 个已发布`, { data: rec.notes });
    } catch (e) {
      this.logger.warn('崩溃恢复检查失败（不阻塞启动）', { data: { error: (e as Error).message } });
    }

    // webhook 补投（§4.1）
    try {
      const rp = await this.relay.replayPending();
      if (rp.total) this.logger.info(`webhook 补投：${rp.replayed}/${rp.total} 成功`);
    } catch {
      /* ignore */
    }

    // 清理与日志轮转
    this.cleaner.start();
    try {
      rotateLogs({ dirs: [LOGS_DIR, ERROR_REPORT_DIR], keepDays: cfg.runtime.logKeepDays, logger: this.logger });
    } catch {
      /* ignore */
    }

    // 配置文件变更监听：**外部**改了 config.json（手工编辑、别处写入、
    // 或 passKey 被工具修复）时，必须让运行中的服务自动跟上 ——
    // 否则服务会一直用启动时读到的旧凭据，表现为「文件里已经修好了，但接口还一直 401」。
    const cfgTick = (): void => {
      try {
        if (this.store.reloadIfChanged()) {
          this.logger.info('检测到 config.json 变更，已热加载（凭据/模型/策略均已更新）');
        }
      } catch (e) {
        this.logger.warn('配置热加载失败（保留原配置继续运行）', { data: { error: (e as Error).message } });
      }
      this.cfgTimer = setTimeout(cfgTick, 5000);
      this.cfgTimer.unref?.();
    };
    this.cfgTimer = setTimeout(cfgTick, 5000);
    this.cfgTimer.unref?.();

    // bvid 反查循环：每 5 分钟一次，直到所有已提交切片都拿到 bvid
    const confirmTick = async (): Promise<void> => {
      try {
        await this.confirmPendingPublished();
      } catch (e) {
        this.logger.warn('bvid 反查循环异常（下轮继续）', { data: { error: (e as Error).message } });
      }
      this.confirmTimer = setTimeout(() => void confirmTick(), 5 * 60_000);
      this.confirmTimer.unref?.();
    };
    this.confirmTimer = setTimeout(() => void confirmTick(), 30_000);
    this.confirmTimer.unref?.();

    /* 等待完整版稿件的重查循环：每 5 分钟一次。
     *
     * 为什么必须有它：默认规则是「完整版由 biliLive-tools 投，切片助手只追加切片分P」，
     * 而它的压制+上传是异步的（实测录制结束后 13–15 分钟才出弹幕版），我们切片完成得更早。
     * 没有这个循环，本场就会**永远停在"已切片"**，等用户自己想起来去点重新发布。
     * 找到它的稿件就立即走一次发布阶段（只追加切片分P）。 */
    const waitTick = async (): Promise<void> => {
      try {
        await this.retryWaitingPublishes();
      } catch (e) {
        this.logger.warn('等待完整版稿件的重查异常（下轮继续）', { data: { error: (e as Error).message } });
      }
      this.waitTimer = setTimeout(() => void waitTick(), 5 * 60_000);
      this.waitTimer.unref?.();
    };
    this.waitTimer = setTimeout(() => void waitTick(), 60_000);
    this.waitTimer.unref?.();

    // 稿件表现数据回流：每日一次（低频率、只读接口，无风控压力）
    const perfTick = async (): Promise<void> => {
      try {
        await this.refreshPerformance({ days: 30 });
      } catch (e) {
        this.logger.warn('稿件表现数据回流异常（明日再试）', { data: { error: (e as Error).message } });
      }
      // 顺带清理过期的回收站条目：唯一会真正抹掉数据的地方，必须自动化但有明确期限
      try {
        const days = this.cfg.cleanup.trashDays;
        if (days > 0) {
          const r = purgeTrash({ olderThanDays: days, logger: this.logger });
          if (r.purged > 0) this.logger.info(`回收站已清理 ${r.purged} 项过期条目（保留 ${days} 天）`, { mod: 'trash' });
        }
      } catch (e) {
        this.logger.warn('回收站清理异常（下次再试）', { data: { error: (e as Error).message } });
      }
      this.perfTimer = setTimeout(() => void perfTick(), 24 * 3600_000);
      this.perfTimer.unref?.();
    };
    this.perfTimer = setTimeout(() => void perfTick(), 10 * 60_000);
    this.perfTimer.unref?.();

    /* 「用完即删」的执行循环：每 10 分钟看一次待删清单，到点的才删。
       单独一个循环（而不是塞进每日的 perfTick）：宽限期按小时算，10 分钟的检查粒度足够了，
       而且用户取消删除之后，清单变化能很快反映到界面上。 */
    const pendingDeleteTick = (): void => {
      try {
        if (this.cfg.cleanup.deleteAfterUpload.enabled) {
          const r = runDueDeletions({ logger: this.logger });
          if (r.deleted > 0) {
            this.logger.info(`待删清单执行：删除 ${r.deleted} 项（${(r.bytes / 1024 ** 3).toFixed(2)} GB）` + (r.failed ? `，失败 ${r.failed} 项` : ''));
          }
        }
      } catch (e) {
        this.logger.warn('待删清单执行异常（下轮继续）', { data: { error: (e as Error).message } });
      }
      this.pendingDeleteTimer = setTimeout(pendingDeleteTick, 10 * 60_000);
      this.pendingDeleteTimer.unref?.();
    };
    this.pendingDeleteTimer = setTimeout(pendingDeleteTick, 60_000);
    this.pendingDeleteTimer.unref?.();

    if (opts.polling ?? true) {
      await this.trigger.start();
      // 目录轮询：启动立刻扫一轮（用户的期望是"打开助手就开始干活"），之后按 intervalSec
      this.watcher.start();
    }
  }

  stop(): void {
    this.trigger.stop();
    this.watcher.stop();
    this.cleaner.stop();
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    if (this.perfTimer) clearTimeout(this.perfTimer);
    if (this.pendingDeleteTimer) clearTimeout(this.pendingDeleteTimer);
    if (this.cfgTimer) clearTimeout(this.cfgTimer);
    this.ledger.flush();
    this.logger.close();
  }

  /* ------------------------------------------------------------------------
   * 触发 → 建任务
   * ---------------------------------------------------------------------- */

  /** 触发回调：把一场录制变成一条任务并推进流水线 */
  private async onTriggered(decision: TriggerDecision): Promise<void> {
    const cfg = this.config;
    const records = decision.records;
    if (records.length === 0) return;

    const first = records[0]!;
    const taskId = makeTaskId(records);
    const existing = this.ledger.getTask(taskId);
    if (existing && ['PUBLISHED', 'ANALYZED', 'CLIPPED', 'ARCHIVED'].includes(existing.status)) {
      this.logger.info(`任务 ${taskId} 已存在且状态为 ${existing.status}，跳过重复触发`);
      return;
    }

    // 源素材：优先用原始分段（转写读它们），并探测「分段文件 → 全局时间」映射
    const rawFiles = records
      .map((r) => r.videoPath)
      .filter((p): p is string => Boolean(p))
      .flatMap((p) => {
        // 录制引擎按 duration 分段时，一条 record 可能对应多个物理文件
        const segs = discoverSegments(p);
        return segs.length > 1 ? segs : [p];
      });
    const uniqueRaw = [...new Set(rawFiles)];
    const ffprobePath = findFfprobe();
    const map = buildSegmentMap(uniqueRaw, {
      ...(ffprobePath ? { ffprobePath } : {}),
      maxSegments: cfg.segmented.maxSegments,
      ...(first.videoDurationSec ? { fallbackDurationSec: first.videoDurationSec } : {}),
    });
    for (const w of map.warnings) this.logger.warn(`分段映射：${w}`);

    // 弹幕文件
    let danmaPath: string | undefined;
    try {
      for (const rec of records) {
        if (!rec.videoPath) continue;
        const ref = await this.client.danmaFileByVideoPath(rec.videoPath);
        if (ref.danmaFilePath) {
          danmaPath = ref.danmaFilePath;
          break;
        }
      }
    } catch (e) {
      this.logger.warn('查询弹幕文件失败（该场将无弹幕信号）', { data: { error: (e as Error).message } });
    }
    const kind = danmaKind(danmaPath);

    const source = buildSourceMedia({
      rawFiles: uniqueRaw,
      fullVideoHasDanmaku: cfg.clip.fullVideoHasDanmaku,
      ...(danmaPath ? { danmaFilePath: danmaPath, danmaFileExt: kind === 'unknown' ? 'xml' : kind } : {}),
      ...(ffprobePath ? { ffprobePath } : {}),
      ...(map.totalDuration > 0 ? { fallbackDurationSec: map.totalDuration } : {}),
    });
    // buildSourceMedia 内部会自行探测；用显式映射覆盖，保证与上面的 warnings 一致
    source.segments = map.segments;
    source.totalDuration = map.totalDuration || source.totalDuration;

    const rec: TaskRecord = {
      id: taskId,
      ...(first.id ? { recordingId: first.id } : {}),
      roomId: cfg.room.roomId,
      platform: cfg.room.platform,
      title: first.title || `${fmtLocal().slice(0, 16)} 直播录像`,
      ...(first.liveStartTime !== undefined ? { liveStartTime: first.liveStartTime } : {}),
      ...(first.recordStartTime !== undefined ? { recordStartTime: first.recordStartTime } : {}),
      ...(first.recordEndTime !== undefined ? { recordEndTime: first.recordEndTime } : {}),
      ...(decision.liveId ? { liveId: decision.liveId } : {}),
      status: 'RECORDED',
      stage: 'RECORDED',
      source,
      fullUpload: 'NOT_APPLICABLE',
      ...(cfg.publish.seasonId ? { seasonId: cfg.publish.seasonId } : {}),
      ...(cfg.publish.sectionId ? { sectionId: cfg.publish.sectionId } : {}),
      cost: emptyCost(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const { record, created } = this.ledger.createTask(rec);
    if (!created) this.logger.info(`任务 ${taskId} 已存在，继续推进而非重建`);

    // 落盘触发证据，便于事后复盘「为什么这一刻判定结束」
    writeJsonAtomic(path.join(this.ledger.taskDir(taskId), 'trigger.json'), {
      at: nowIso(),
      reason: decision.reason,
      liveId: decision.liveId,
      diagnostics: decision.diagnostics,
      records: records.map((r) => ({
        id: r.id,
        title: r.title,
        recordStartTime: r.recordStartTime,
        recordEndTime: r.recordEndTime,
        videoPath: r.videoPath,
        videoDurationSec: r.videoDurationSec,
      })),
      segments: map.segments.map((s) => ({ path: s.path, duration: s.duration, globalStart: s.globalStart, globalEnd: s.globalEnd })),
    });

    await this.alerter.recordingDone({
      taskId,
      title: record.title,
      durationSec: source.totalDuration,
      roomId: cfg.room.roomId,
    });

    this.logger.info(
      `已创建本场任务 ${taskId}：${record.title}（${records.length} 个录制段，${map.segments.length} 个媒体文件，总时长 ${fmtDuration(source.totalDuration)}）`,
      { data: { reason: decision.reason } },
    );

    await this.enqueue(taskId, 'RECORDED');
  }

  /* ------------------------------------------------------------------------
   * 队列（场次级串行）
   * ---------------------------------------------------------------------- */

  /** 入队并异步推进；同一时间只处理一场 */
  async enqueue(taskId: string, fromStage?: Stage): Promise<void> {
    this.queue.push(fromStage ? { taskId, fromStage } : { taskId });
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        if (this.paused) {
          this.logger.warn(`磁盘空间不足，任务 ${item.taskId} 暂缓执行（已放回队列）`);
          this.queue.unshift(item);
          await sleep(60_000);
          continue;
        }
        try {
          await this.runPipeline(item.taskId, item.fromStage ?? 'RECORDED');
        } catch (e) {
          this.logger.error(`任务 ${item.taskId} 流水线异常终止`, e);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /* ------------------------------------------------------------------------
   * 流水线
   * ---------------------------------------------------------------------- */

  private setProgress(taskId: string, label: string, current: number, total: number): void {
    this.progress.set(taskId, { label, current, total });
    this.ledger.updateTask(taskId, { progress: { label, current, total } });
  }

  private clearProgress(taskId: string): void {
    this.progress.delete(taskId);
  }

  /**
   * 推进一场直播的流水线。
   *
   * `fromStage` 语义：**从该阶段开始执行**（之前的阶段视为已完成，不重复付费）。
   */
  async runPipeline(taskId: string, fromStage: Stage = 'RECORDED'): Promise<{ ok: boolean; stoppedAt: Stage; error?: string }> {
    const cfg = this.config;
    const task = this.ledger.getTask(taskId);
    if (!task) {
      this.logger.error(`任务 ${taskId} 不存在，无法推进`);
      return { ok: false, stoppedAt: fromStage, error: '任务不存在' };
    }
    const dir = this.ledger.taskDir(taskId);
    const log = this.logger.child({ taskId, mod: 'pipeline' });
    const order: Stage[] = ['IDLE', 'RECORDED', 'TRANSCRIBED', 'ANALYZED', 'CLIPPED', 'PUBLISHED'];
    const startIdx = Math.max(0, order.indexOf(fromStage));

    // 判断每个阶段是否需要执行（阶段顺序 + 产出是否已存在）
    const need = (stage: Stage): boolean => order.indexOf(stage) >= startIdx;

    try {
      /* ================= 阶段 1：RECORDED（源素材校验） ================= */
      if (need('RECORDED')) {
        this.ledger.setStatus(taskId, 'RECORDED', { stage: 'RECORDED' });
        const check = this.verifySource(task);
        if (!check.ok) throw new StageError('RECORDED', check.reason, 'file-missing');
        log.info(`源素材校验通过：${check.detail}`, { stage: 'RECORDED' });
      }

      /* ================= 阶段 2：TRANSCRIBED（转写） ================= */
      let transcript: Transcript | undefined;
      const transcriptPath = this.ledger.taskFile(taskId, 'transcript.json');
      if (need('TRANSCRIBED') || !exists(transcriptPath)) {
        if (!need('TRANSCRIBED') && !exists(transcriptPath)) {
          log.warn(`阶段 ${fromStage} 之后的转写产出缺失，自动补跑转写`);
        }
        this.ledger.setStatus(taskId, 'TRANSCRIBING', { stage: 'RECORDED' });
        const res = await this.runTranscribe(task, dir);
        transcript = res;
        this.ledger.setStatus(taskId, 'TRANSCRIBED', { stage: 'TRANSCRIBED' });
        // 成本记账：ASR 是**估算值**（拿不到 biliLive-tools 的账单），LLM 是实际 usage
        this.ledger.addCost(taskId, {
          asrEstimate: transcript.costEstimate ?? 0,
          asrAudioSeconds: transcript.audioSeconds ?? 0,
        });
        this.ledger.updateTask(taskId, { transcriptPath });
        this.clearProgress(taskId);
        // §7.3：转写完成 + 压制产物可用 → 原始分段可删（交给 Cleaner 的周期检查，这里不即时删）
      } else {
        transcript = readJson<Transcript>(transcriptPath);
        log.info(`复用已有转写结果：${transcript.segments.length} 条字幕（不重复计费）`);
      }

      /* ---- 转写为空 = 上游失败，必须停下来，不能悄悄降级 ----
       *
       * 实测事故：biliLive-tools 里的语音识别模型被换成一个 Qwen Omni 对话模型，
       * 它不支持异步文件转写接口，每次提交都被上游拒（400），于是 26.5 分钟的录播
       * 转写结果为空（`gaps` 里记着整段失败原因）。而流水线**继续往下跑**：
       * 用弹幕密度兜底出片、还生成了一份"本场总结"，总结里只有一句"语音识别大面积缺失" ——
       * 用户是在总结里才发现没转写，前面已经白跑了一整套。
       *
       * 没转写意味着：没有字幕（烧进画面的字幕就是空的）、选片只能靠弹幕密度、
       * 标题描述也只能靠弹幕关键词 —— 这不是"降级出的片"，是"不该出的片"。
       * 所以默认**直接失败**并给出可执行的排查方向；确实想要弹幕兜底的人，
       * 显式打开 `asr.allowEmptyTranscriptFallback`。
       */
      if (transcript.segments.length === 0) {
        const gaps = transcript.gaps ?? [];
        const covered = gaps.reduce((a, g) => a + Math.max(0, g.end - g.start), 0);
        const total = task.source.totalDuration || 0;
        const reasons = [...new Set(gaps.map((g) => g.reason))].slice(0, 3);
        const detail = reasons.length ? reasons.join('；') : '没有给出失败原因';

        /* ---- 情形 A：空转写的**唯一**原因是「dry-run 按硬约束 #14 拒绝付费」----
         *
         * 这不是故障，是 dry-run 预检按设计走到了终点：进程没有 --allow-paid，
         * 所有窗口都被 asr.ts 的安全阀拦下（gaps.reason 前缀 `contract: dry-run`）。
         *
         * 实测事故：20:51 一个 dry-run 服务实例对两个手动导入的预检任务（2.0 / 4.7 分钟）
         * 各抛一次下面的"语音识别没有产出任何字幕"，被 catch 归为 `type: 'internal'`
         * 写进 data/errors.jsonl —— 于是「近 24h 错误」里混进了设计内的安全拦截，
         * 真正的故障被淹没。统计要能区分「安全阀拦住了」和「跑挂了」。
         *
         * 所以这里**优雅停在 TRANSCRIBED**：不抛异常、不生成错误报告、不触发告警，
         * 只用 info 说清"要花钱请开 --allow-paid"。用户开了付费之后从该阶段重跑即可，
         * 因为没有发生任何付费调用，重跑不会重复花钱。
         */
        const onlyDryRunRejections = isDryRunPaymentRejection(transcript);
        if (onlyDryRunRejections) {
          log.info(
            `dry-run 预检：${gaps.length} 个转写窗口全部因未授权付费被安全阀拦下（硬约束 #14），流程正常终止于此。` +
              `本次未产生任何费用；如需真实转写请以 --allow-paid（或配置 runtime.allowPaid=true）重跑，` +
              `缓存命中的窗口不会重复计费。`,
          );
          this.ledger.setStatus(taskId, 'TRANSCRIBED', { stage: 'TRANSCRIBED' });
          this.clearProgress(taskId);
          return { ok: true, stoppedAt: 'TRANSCRIBED' };
        }

        if (!cfg.asr.allowEmptyTranscriptFallback) {
          throw new Error(
            `语音识别没有产出任何字幕${covered > 0 && total > 0 ? `（失败区间覆盖 ${(covered / 60).toFixed(1)}/${(total / 60).toFixed(1)} 分钟）` : ''}：${detail}\n` +
              `这不是"识别出来是空的"，而是转写请求失败了。常见原因：\n` +
              `  ① biliLive-tools 里选的语音识别模型不支持"录音文件转写"（例如选成了 Qwen Omni 之类的对话模型）；\n` +
              `  ② 阿里云 DashScope 的 Key 失效/欠费，或该模型没有开通；\n` +
              `  ③ 音频本身异常（本次已确认源文件有正常音轨，可排除）。\n` +
              `处理：去 biliLive-tools 的「设置 → 语音识别」把模型换回可用的录音文件识别模型，` +
              `然后在本任务上「从某阶段重跑 → TRANSCRIBED」（失败的那次没有计费，重跑不会重复花钱）。`,
          );
        }
        log.warn(
          `语音识别没有任何产出，但已开启 asr.allowEmptyTranscriptFallback —— 继续用弹幕信号兜底（本场不会有字幕）：${detail}`,
        );
      }

      /* 完整版（弹幕版 + 纯享版）归谁投 —— 默认规则是 **biliLive-tools 投**，本服务只追加切片分P。
         `kickFullVideoUpload` 是"我们自己把完整版投出去"，只有显式例外时才允许：
           · `publish.fullVideoBy="assistant"`，或任务级 `overrides.fullVideoBy="assistant"`；
           · 且不是多分P 模式（多分P 时完整版作为 P1 与切片一起投，不能单独再投一次）。 */
      const fullVideoOwner = this.fullVideoOwner(task);
      if (fullVideoOwner === 'bililive-tools') {
        log.info(
          '完整版（弹幕版 + 纯享版）由 biliLive-tools 自己投 —— 本服务只把切片追加进它那个稿件（同一个稿件）',
        );
      } else if (this.config.publish.multiPart === true) {
        log.info('多分P模式（例外：切片助手投完整版）：完整版将作为该稿件的 P1 与切片一并投递，不单独上传');
      } else {
        this.kickFullVideoUpload(task).catch((e) => log.warn('完整版上传支线异常（不影响切片流程）', { data: { error: (e as Error).message } }));
      }

      /* ================= 阶段 3：ANALYZED（信号 + LLM） ================= */
      let signals: Signals;
      const signalsPath = this.ledger.taskFile(taskId, 'signals.json');
      if (exists(signalsPath)) {
        signals = readJson<Signals>(signalsPath);
        log.info(`复用已有弹幕信号：${signals.danmakuTotal} 条弹幕，${signals.peaks.length} 个峰值窗口`);
      } else {
        const res = analyzeDanmaku({
          taskId,
          filePath: task.source.danmaXmlPath ?? task.source.danmaAssPath,
          videoDuration: task.source.totalDuration,
          config: cfg,
        });
        signals = res.signals;
        for (const w of res.warnings) log.warn(`弹幕信号：${w}`);
        writeJsonAtomic(signalsPath, signals);
        // 把实测偏移写回 transcript，保证下游看到统一基准
        if (transcript) {
          transcript.danmakuOffset = signals.danmakuOffset;
          writeJsonAtomic(transcriptPath, transcript);
        }
      }
      this.ledger.updateTask(taskId, { signalsPath });

      let decision;
      const clipsPath = this.ledger.taskFile(taskId, 'clips.json');
      if (need('ANALYZED') || !exists(clipsPath)) {
        this.ledger.setStatus(taskId, 'ANALYZING', { stage: 'TRANSCRIBED' });
        /* ---- 本场主播识别 ----
         * 术语表是**跨主播**的全局词表（用户既看乙主播也看甲主播）。以前提示词把它渲染成
         * 「本场主播：乙主播、甲主播」，模型就照着把甲主播的直播总结成了乙主播的。
         * 所以每场都要先用三类证据（目录名 / 弹幕热词 / 转写正文）判定本场是谁，
         * 判不出来就**不注入**，绝不猜。 */
        const glossaryForRun = this.glossary.load();
        const guess = detectStreamer({
          sourcePaths: [...task.source.rawFiles, ...task.source.segments.map((s) => s.path)],
          anchors: glossaryForRun.anchors,
          transcriptText: transcript!.segments.map((s) => s.text).join(''),
          danmakuKeywords: signals.keywords,
          title: task.title,
        });
        if (guess.name) {
          log.info(`本场主播识别：${guess.name}（置信度 ${guess.confidence}）—— ${guess.evidence.join('；')}`, {
            taskId,
            data: { streamer: guess.name, confidence: guess.confidence },
          });
        } else {
          log.warn(`本场主播未能识别（不注入主播信息，模型只依据转写内容）：${guess.evidence.join('；')}`, { taskId });
        }
        this.ledger.updateTask(taskId, { streamer: guess.name ?? '' });

        /* 分P 边界（全局秒）：每个录制分段文件的结束时刻就是一个分界点。
           为什么能这样对应：biliLive-tools 按 `segment` 参数分段落盘，并把每个分段文件
           投成一个分P（`uploadNoDanmu` 时再多一份纯享版），所以分段边界 = 分P 边界。
           ⚠️ 若该场只有一个分段文件（不分段录制），这里就是空数组，边界防护自然不生效 ——
           此时整场本就是一个分P，无需防护。 */
        const partBoundaries = [
          ...new Set(
            task.source.segments
              .map((s) => s.globalEnd)
              .filter((b) => Number.isFinite(b) && b > 1 && b < task.source.totalDuration - 1),
          ),
        ].sort((a, b) => a - b);
        if (partBoundaries.length) {
          log.info(
            `本场有 ${partBoundaries.length} 个分P 边界（${partBoundaries.length + 1} 个分P）—— ` +
              `选片将避开这些分界点，避免切片被拆到两个分P`,
            { taskId, data: { partBoundaries } },
          );
        } else if (task.source.segments.length <= 1) {
          log.debug('本场为单文件录制（无分P 边界），跳过分P 跨界防护', { taskId });
        }

        const result = await this.analyzer.analyze({
          taskId,
          transcript: transcript!,
          signals,
          videoDuration: task.source.totalDuration,
          /* 源文件路径：切片边界要用音频能量做修正（起点/终点落在没人说话的地方时拉回有人说话的位置）。
             多分段场次用第一段即可 —— 单文件场次就是它本身。 */
          ...(task.source.segments[0]?.path ? { videoPath: task.source.segments[0].path } : {}),
          /* 分P 边界：本场被 biliLive-tools 按录制分段切成多个分P 上传，
             切片跨越边界会被拆到两个分P（观众只看到一半）。
             这里把每个分段文件的结束时刻（全局秒）作为分界点传下去，
             选片 prompt 会告知模型避开，后处理再做确定性兜底。 */
          ...(partBoundaries.length ? { partBoundaries } : {}),
          // 术语表：让选片与起标题的模型知道哪些词是专有名词（不要改写、不要"纠正"）
          glossary: glossaryForRun,
          streamer: guess,
          ...(this.opts.dryRun !== undefined ? { dryRun: this.opts.dryRun } : {}),
          ...(this.opts.allowPaid !== undefined ? { allowPaid: this.opts.allowPaid } : {}),
          onProgress: (p) => this.setProgress(taskId, p.label, p.current, p.total),
          ...(task.overrides?.maxClips !== undefined ? { maxClipsOverride: task.overrides.maxClips } : {}),
          ...(task.overrides?.extraTags ? { extraTags: task.overrides.extraTags } : {}),
        });
        const paths = persistAnalysis(dir, result);
        decision = result.decision;

        // 成本记账（LLM 是实际 usage，ASR 是估算值）
        this.ledger.addCost(taskId, {
          llmActual: result.cost.cost,
          llmPromptTokens: result.cost.promptTokens,
          llmCompletionTokens: result.cost.completionTokens,
          llmCalls: result.cost.calls,
        });
        this.ledger.updateTask(taskId, {
          clipsPath: paths.clipsPath,
          summaryPath: paths.summaryPath,
          status: 'ANALYZED',
          stage: 'ANALYZED',
          clips: decision.clips,
        });

        // .llc 供人工精修（§4.7 / §8 WP7 关键交互）
        try {
          const srcForLlc = task.source.fullVideoPath ?? task.source.rawFiles[0] ?? 'video.mp4';
          const llc = buildLlcContent(srcForLlc, decision.clips);
          const llcPath = path.join(dir, `${path.basename(srcForLlc, path.extname(srcForLlc))}-proj.llc`);
          await this.client.writeLLC(llcPath, llc);
          log.info(`已写出 .llc 项目文件（可在 biliLive-tools 切片界面打开精修）：${path.basename(llcPath)}`);
        } catch (e) {
          log.debug(`写出 .llc 失败（不阻塞流程）：${(e as Error).message}`);
        }

        // 选片决策记录（§8 WP4 步骤 8，默认开启）
        if (cfg.runtime.recordDecisions) {
          for (const c of decision.clips) {
            this.ledger.recordDecision({
              taskId,
              clipIndex: c.index,
              llm: {
                start: c.llmOriginal?.start ?? c.start,
                end: c.llmOriginal?.end ?? c.end,
                title: c.llmOriginal?.title ?? c.title,
                tags: c.llmOriginal?.tags ?? c.tags,
                score: c.score,
                reason: c.reason,
                category: c.category,
                degraded: c.degraded,
              },
              selected: c.selected,
              final: { start: c.start, end: c.end, title: c.title, tags: c.tags },
            });
          }
        }

        await this.alerter.analysisDone({
          taskId,
          title: task.title,
          clipCount: decision.clips.length,
          degraded: decision.degraded,
          ...(result.summary ? { summaryHead: result.summary.slice(0, 120) } : {}),
        });
        this.clearProgress(taskId);

        if (decision.degraded) {
          log.warn(`本场为**降级产出**（${decision.escalationNote ?? 'LLM 不可用'}）：${decision.clips.length} 个候选由弹幕密度选出，标题需人工填写`);
        } else {
          log.info(
            `分析完成：${decision.clips.length} 个候选切片，默认勾选 ${decision.clips.filter((c) => c.selected).length} 个` +
              `${decision.escalated ? '（契约校验失败后已升级模型重跑）' : ''}`,
          );
        }
      } else {
        const clipsFile = readJson<{ clips: ClipRecord[] }>(clipsPath);
        decision = {
          taskId,
          clips: clipsFile.clips,
          degraded: clipsFile.clips.some((c) => c.degraded),
          modelUsed: 'cached',
          escalated: false,
          createdAt: nowIso(),
        };
        log.info(`复用已有分析结果：${decision.clips.length} 个候选`);
      }

      /* ================= dry-run 到此为止 ================= */
      if (this.opts.dryRun) {
        log.info(
          `dry-run：已产出 clips.json 与 summary.md，不执行切片与投稿。` +
            `候选 ${decision.clips.length} 个${this.opts.allowPaid ? '' : '（未允许付费，未调用付费 AI）'}`,
        );
        this.ledger.setStatus(taskId, 'ANALYZED', { stage: 'ANALYZED' });
        return { ok: true, stoppedAt: 'ANALYZED' };
      }

      /* ================= 半自动：等人工确认 ================= */
      const autoPublish = cfg.publish.autoPublish && !task.overrides?.skipAutoPublish;
      const selected = decision.clips.filter((c) => c.selected);
      if (!autoPublish) {
        // 半自动：分析完成后推通知并在 UI 中待审，人工勾选确认后才发布
        if (selected.length === 0) {
          this.ledger.setStatus(taskId, 'ANALYZED', { stage: 'ANALYZED' });
          log.info('半自动模式：已产出候选切片，等待你在 UI 中勾选确认后发布');
        } else {
          this.ledger.setStatus(taskId, 'ANALYZED', { stage: 'ANALYZED' });
          log.info(
            `半自动模式：已产出 ${decision.clips.length} 个候选（默认勾选 ${selected.length} 个），等待你在 UI 中确认发布`,
          );
        }
        return { ok: true, stoppedAt: 'ANALYZED' };
      }

      /* ================= 阶段 4/5：CLIPPED → PUBLISHED ================= */
      return await this.publishStage(taskId, log);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const stage = e instanceof StageError ? e.stage : 'UNKNOWN';
      const type: ErrorType = e instanceof StageError ? e.type : 'internal';
      await this.reportError({
        taskId,
        taskTitle: task.title,
        stage,
        error: e,
        type,
        taskStatus: this.ledger.getTask(taskId)?.status,
      });
      this.ledger.setStatus(taskId, 'FAILED', {});
      this.clearProgress(taskId);
      this.logger.error(`任务 ${taskId} 在阶段 ${stage} 失败`, err, { taskId });
      await this.alerter.failure({ taskId, stage, message: err.message });
      return { ok: false, stoppedAt: stage as Stage, error: err.message };
    }
  }

  /** 切片 + 投稿阶段（供半自动确认与全自动共用） */
  async publishStage(taskId: string, logger?: Logger): Promise<{ ok: boolean; stoppedAt: Stage; error?: string }> {
    const log = (logger ?? this.logger).child({ taskId, mod: 'pipeline' });
    const cfg = this.config;
    const task = this.ledger.getTask(taskId)!;

    // 磁盘守卫（硬约束方向：磁盘不足时停止新任务）
    const disk = this.cleaner.canStartNewTask();
    if (!disk.ok) {
      this.ledger.setStatus(taskId, 'ANALYZED', {});
      log.error(`磁盘空间不足，暂不执行切片：${disk.reason}`);
      throw new StageError('CLIPPED', disk.reason ?? '磁盘空间不足', 'disk');
    }

    // uid
    let uid: number | string;
    try {
      const users = await this.client.userList();
      if (users.length === 0) throw new Error('没有已登录账号');
      uid = users[0]!.uid;
    } catch (e) {
      throw new StageError('CLIPPED', `无法获取投稿用 uid：${(e as Error).message}`, 'auth');
    }

    this.ledger.setStatus(taskId, 'CLIPPING', { stage: 'ANALYZED' });

    /* ★ 多分P模式（publish.multiPart）必须在这里分流。
       曾经的缺陷：`publish.multiPart` 这个配置项**在自动流程里完全没被读取** ——
       `publishAsMultiPart()` 只有手动工具 `tools/publish-multipart.ts` 会调，
       于是配了 multiPart=true 的场次仍然「一个切片一个稿件」：
       8 个切片 = 8 个独立稿件 = 占 8 个每日额度，而多分P只需 1 个。
       实测就是这样把一场 8 个切片全投成了单片。 */
    const useMultiPart = cfg.publish.multiPart === true;
    /* 默认规则（完整版由 biliLive-tools 投、切片追加进同一个稿件）只能通过多分P 续传实现。
       单切片一稿模式下每个切片是**独立稿件**，与完整版不在同一个稿件里 —— 直接拦住，
       不要让配置错位悄悄投出一堆单片（那种错误事后要人工去 B站 一个个删）。 */
    if (!useMultiPart && this.fullVideoOwner(task) === 'bililive-tools') {
      throw new StageError(
        'CLIPPED',
        '按当前规则「完整版由 biliLive-tools 投、切片助手只追加切片分P 到同一个稿件」，必须开启 publish.multiPart=true；' +
          '当前 multiPart=false 会把每个切片投成独立稿件（与完整版不在同一个稿件）。' +
          '如确实要一个切片一个稿件，请显式设 publish.fullVideoBy="assistant" 表示由切片助手自行投稿。',
        'contract',
      );
    }
    const res = useMultiPart
      ? await this.publishMultiPartStage({ taskId, uid, log })
      : await this.publisher.publishClips({
          task: this.ledger.getTask(taskId)!,
          uid,
          submitTimeMs: Date.now(),
          onProgress: (p) => this.setProgress(taskId, p.label, p.current, p.total),
        });
    this.clearProgress(taskId);

    // 重新读取以拿到最新切片状态
    const after = this.ledger.getTask(taskId)!;
    const clips = this.ledger.getClips(taskId);
    const published = clips.filter((c) => c.status === 'PUBLISHED').length;
    const submitted = clips.filter((c) => c.status === 'SUBMITTED').length;
    const failed = clips.filter((c) => c.status === 'FAILED').length;
    const selectedCount = clips.filter((c) => c.selected).length;

    this.ledger.setStatus(taskId, published + submitted > 0 ? 'CLIPPED' : 'ANALYZED', { stage: 'CLIPPED' });

    for (const r of res.results) {
      if (r.ok && !r.skipped) {
        await this.alerter.publishSuccess({
          taskId,
          title: clips[r.clipIndex]?.title ?? '',
          ...(r.bvid ? { bvid: r.bvid } : {}),
          ...(r.dtime ? { dtime: r.dtime } : {}),
          isOnlySelf: cfg.publish.isOnlySelf === 1,
        });
      } else if (!r.ok) {
        await this.alerter.publishFailed({
          taskId,
          title: clips[r.clipIndex]?.title ?? '',
          reason: r.error?.message ?? '未知原因',
        });
      }
    }

    if (failed > 0 && published + submitted === 0) {
      throw new StageError('CLIPPED', `${failed} 个切片全部失败`, 'internal');
    }

    /* 终态判定。
       ⚠️ 口径陷阱（实测把任务永久卡在 CLIPPED 过）：
         `submitted` 是**已投出去**的切片数，而 `selectedCount` 是**勾选**的切片数。
         两者不总是相等 —— 每日额度把这一批截断时，勾选了 14 个但只切/投了 9 个，
         剩下 5 个状态仍是 CANDIDATE（既非 SUBMITTED 也非 FAILED）。
         于是 `submitted >= selectedCount` 永远不成立，任务一直显示"已切片 · 待发布"。
       正确口径：只要求「**有产出文件的那部分**都处理完了」。
         没产出文件的是"额度没轮到"，不是"没做完"，不该阻塞本场终态。 */
    const withOutput = clips.filter((c) => c.selected && c.cutOutput).length;
    const processed = published + submitted + failed;
    /* 多分P 路径与单切片路径的"应处理数"口径不同：前者是"有产出的"，后者是"勾选的" */
    const multi = (res as { multipart?: boolean }).multipart === true;
    const stuck = (res as { stuck?: boolean }).stuck === true;
    const waiting = (res as { waiting?: boolean }).waiting === true;
    const allDone = multi ? processed >= withOutput : processed >= selectedCount;

    if (waiting) {
      /* 默认规则下的正常中间态：等 biliLive-tools 把完整版稿件投出来，再追加切片。
         停在 CLIPPED（不是 FAILED，也不是 PUBLISHED）——等待循环会定期重查。 */
      this.ledger.setStatus(taskId, 'CLIPPED', { stage: 'CLIPPED' });
      log.info(
        `本场切片已就绪但**暂不投稿**：${res.skipped} 个切片在等 biliLive-tools 的完整版稿件` +
          `（默认规则：完整版由它投，切片助手只追加切片分P 到同一个稿件）—— 等它投出后自动追加`,
      );
    } else if (stuck && published + submitted === 0) {
      /* 无可投（额度用完 / 切片全失败）：本场到此为止，如实说明，不谎报成功也不挂着 */
      this.ledger.setStatus(taskId, 'CLIPPED', { stage: 'CLIPPED' });
      log.warn(
        `本场未能投稿：${res.failed > 0 ? `${res.failed} 个切片切片失败` : '今日额度已用完'}` +
          `（勾选 ${selectedCount} 个，已有切片产物 ${withOutput} 个）—— 等额度恢复后可重跑发布阶段`,
      );
    } else if (allDone && withOutput > 0) {
      this.ledger.setStatus(taskId, 'PUBLISHED', { stage: 'PUBLISHED', publishedAt: nowIso() });
      const pendingByQuota = Math.max(0, selectedCount - withOutput);
      log.info(
        `本场切片投稿流程完成：已发布 ${published}，已提交待确认 ${submitted}，失败 ${failed}` +
          (pendingByQuota > 0
            ? `（另有 ${pendingByQuota} 个勾选切片因每日额度未处理，保留待后续）`
            : ''),
      );
    } else {
      log.info(
        `本场部分完成：已发布 ${published}，已提交 ${submitted}，失败 ${failed}` +
          `（本轮可投 ${withOutput} 个 / 勾选 ${selectedCount} 个，未勾选 ${clips.length - selectedCount} 个）`,
      );
    }
    void after;
    return { ok: true, stoppedAt: 'PUBLISHED' };
  }

  /**
   * 本场的「完整版归谁投」。
   *
   * 规则（用户定）：默认由 biliLive-tools 投完整版（弹幕版 + 纯享版），切片助手只追加切片分P；
   * **只有明确说明**时才由切片助手自己投完整版 —— 说明方式两种，任务级优先：
   *   1. `task.overrides.fullVideoBy = 'assistant'`（只影响这一场）
   *   2. `publish.fullVideoBy = 'assistant'`（全局开关）
   */
  fullVideoOwner(task: TaskRecord): 'bililive-tools' | 'assistant' {
    if (task.overrides?.fullVideoBy === 'assistant') return 'assistant';
    return this.config.publish.fullVideoBy === 'assistant' ? 'assistant' : 'bililive-tools';
  }

  /**
   * 记一次「等 biliLive-tools 投完整版」并返回给调用方的说明。
   *
   * 台账里写 `publishWait`（起始时刻 + 截止时刻 + 原因），界面据此显示"在等什么"，
   * 等待循环据此决定还要不要重查。重复进入时**保留首次的 since**（那才是真正的等待起点）。
   */
  private beginPublishWait(task: TaskRecord, log: Logger): { reason: string; until: number; first: boolean } {
    const cfg = this.config;
    const until = Date.now() + Math.max(1, cfg.publish.resumeWaitMin) * 60_000;
    const prev = task.publishWait;
    const first = !prev;
    const since = prev?.since ?? nowIso();
    const expired = prev !== undefined && Date.parse(prev.until) <= Date.now();
    const reason =
      `等待 biliLive-tools 投出本场的完整版稿件（弹幕版 + 纯享版）后再追加切片 —— ` +
      `当前规则是「完整版由 biliLive-tools 投，切片助手只追加切片分P」，` +
      `它还没投出来时切片助手**不会**自己投完整版（那会变成同内容两个稿件）。` +
      `已等待 ${Math.round((Date.now() - Date.parse(since)) / 60_000)} 分钟，` +
      `最多等到 ${fmtLocal(until)}（publish.resumeWaitMin=${cfg.publish.resumeWaitMin}）`;
    this.ledger.updateTask(task.id, {
      publishWait: { since, until: new Date(until).toISOString(), reason, attempts: (prev?.attempts ?? 0) + 1 },
    });
    if (first) {
      log.warn(
        `${reason}\n  若这场本来就该由切片助手投完整版（例外情况），把它显式打开：` +
          `config.json 的 publish.fullVideoBy="assistant"，或该任务 overrides.fullVideoBy="assistant"。`,
        { taskId: task.id, data: { until: new Date(until).toISOString() } },
      );
      void this.alerter
        .send({
          level: 'warn',
          key: `publish-waiting:${task.id}`,
          title: `等待完整版稿件：${task.title}`,
          body: reason,
          taskId: task.id,
          at: nowIso(),
        })
        .catch(() => undefined);
    } else if (!expired) {
      log.info(`仍在等待 biliLive-tools 的完整版稿件（第 ${(prev?.attempts ?? 0) + 1} 次重查）：${reason}`, { taskId: task.id });
    } else {
      log.warn(
        `等待超时：已等 ${Math.round((Date.now() - Date.parse(since)) / 60_000)} 分钟仍未等到 biliLive-tools 的完整版稿件 —— ` +
          `本场停在「已切片」，切片不会投出去。请人工确认：① 该房间在 biliLive-tools 的 webhook 房间配置里有压制预设` +
          `（ffmpegPreset/danmuPreset）；② 这场是它自己的录制器录的；③ 它那边的压制/上传有没有报错。` +
          `确认后可在详情页「重新发布」，或显式改为 publish.fullVideoBy="assistant" 让切片助手自己投。`,
        { taskId: task.id },
      );
    }
    return { reason, until, first };
  }

  /** 清掉等待标记（找到目标、或本场不再需要等待时调用） */  private clearPublishWait(taskId: string): void {
    const cur = this.ledger.getTask(taskId);
    /* 必须用 `unset`：`updateTask({publishWait: undefined})` 会被 assignDefined 跳过（静默无效） */
    if (cur?.publishWait) this.ledger.updateTask(taskId, {}, { unset: ['publishWait'] });
  }

  /**
   * 重查「在等 biliLive-tools 完整版稿件」的场次，等到了就走一次发布（只追加切片分P）。
   *
   * 只处理**带等待标记且状态是 CLIPPED**的任务：这保证不会去动用户正在编辑的场次，
   * 也不会重投已经投过的场次（投过之后 `clearPublishWait` 会把标记清掉）。
   * 超过 `until` 的任务不再自动重试（只在 `beginPublishWait` 里告警一次），
   * 避免无限重试把日志刷满 —— 那种情况需要人去看 biliLive-tools 那边到底怎么了。
   */
  async retryWaitingPublishes(): Promise<{ checked: number; retried: number; appended: number }> {
    const cfg = this.config;
    if (cfg.publish.fullVideoBy === 'assistant') return { checked: 0, retried: 0, appended: 0 };
    const now = Date.now();
    const waiting = this.ledger
      .listTasks({ limit: 200 })
      .filter((t) => t.publishWait !== undefined && t.status === 'CLIPPED' && t.overrides?.fullVideoBy !== 'assistant');
    if (waiting.length === 0) return { checked: 0, retried: 0, appended: 0 };

    let retried = 0;
    let appended = 0;
    for (const t of waiting) {
      if (Date.parse(t.publishWait!.until) <= now) continue; // 超时：交给人工
      retried++;
      try {
        const r = await this.publishStage(t.id);
        const after = this.ledger.getTask(t.id);
        // 追加成功 → 等待标记已被 clearPublishWait 清掉
        if (after && after.publishWait === undefined) {
          appended++;
          this.logger.info(`等到完整版稿件，切片已追加进同一稿件：${t.title}`, { taskId: t.id });
        } else if (!r.ok) {
          this.logger.warn(`等待重查时发布阶段报错：${r.error ?? '未知原因'}`, { taskId: t.id });
        }
      } catch (e) {
        this.logger.warn('等待重查失败（下轮继续）', { taskId: t.id, data: { error: (e as Error).message } });
      }
    }
    this.logger.debug(`等待完整版稿件：${waiting.length} 个场次在等，本轮重查 ${retried} 个，追加成功 ${appended} 个`);
    return { checked: waiting.length, retried, appended };
  }

  /**
   * 找「biliLive-tools 已投出的那个稿件」，用于把切片**续传**进同一个稿件。
   *
   * 用户的工作流：biliLive-tools 把一场直播的分段录播投成**一个稿件的 N 个分P**
   * （它自己的 `uploadToSameMedia` + `editMedia`），切片助手只追加切片分P。
   * 那个稿件的 aid 只存在 biliLive-tools 的内存里（`app.db` 无 aid 列，已核对），
   * 所以只能从稿件列表反查。两条路：
   *   1. `publish.resumeAid` 显式指定（最可靠，用户可直接从创作中心复制 aid）；
   *   2. 用 `publish.resumeTitleTemplate` 渲染标题去 `/bili/archives` 里精确匹配。
   *
   * 路径 2 之前有实测缺陷：`{anchor}` 传的是**空数组**去反推主播名，永远渲染成空串，
   * 而 biliLive-tools 的标题是 `{{user}}{{title}}{{now}}`（开头就是账号名）→
   * 精确命中 0 个，于是每次都新建稿件。现在主播名优先从稿件列表里反推
   * （`guessAnchorName`），再用台账里识别到的主播名兜底。
   */
  private async findResumeTarget(
    task: TaskRecord,
    log: Logger,
  ): Promise<{
    aid: string;
    /** 目标稿件的 bvid（有就写进切片台账：切片是它的分P，同 bvid 不同 cid） */
    bvid?: string;
    partCount?: number;
    how: 'config' | 'exact' | 'exact-ignore-date';
    anchor?: string;
  } | undefined> {
    const cfg = this.config;
    const archives = await this.fetchArchivesForResume(task, log);
    const liveTitle = cleanLiveTitle(task.title);

    /* 路径 0：**本场显式指定的 aid** —— 最确定的一条路。
       什么时候用它：biliLive-tools 的稿件标题不可信时（实测它经"文件夹监控导入"进来的场次
       标题是「未知主播未知标题2026.09.23」，与标题模板永远匹配不上 → 本场会一直等到超时）。
       此时用户把创作中心里的 aid 贴进「本场设置」，就立刻能追加。 */
    const taskAid = String(task.overrides?.resumeAid ?? '').trim();
    if (taskAid) {
      const bvid = archives.find((a) => String(a['aid'] ?? '') === taskAid)?.bvid;
      const partCount = bvid ? await this.readArchivePartCount(bvid, log) : undefined;
      log.info(
        `使用**本场指定**的续传目标 aid=${taskAid}${bvid ? `（${bvid}）` : '（稿件列表里没找到它，仍按你指定的投）'}` +
          `${partCount !== undefined ? `，该稿件已有 ${partCount} 个分P` : ''}`,
        { taskId: task.id, data: { aid: taskAid, source: 'task-override' } },
      );
      return { aid: taskAid, how: 'config', ...(bvid ? { bvid } : {}), ...(partCount !== undefined ? { partCount } : {}) };
    }

    /* 路径 1：显式配置优先（仍然尽量读一次分P 数，编号基准才对得上） */
    const explicit = cfg.publish.resumeAid.trim();
    if (explicit) {
      const bvid = archives.find((a) => String(a['aid'] ?? '') === explicit)?.bvid;
      const partCount = bvid ? await this.readArchivePartCount(bvid, log) : undefined;
      return { aid: explicit, how: 'config', ...(bvid ? { bvid } : {}), ...(partCount !== undefined ? { partCount } : {}) };
    }

    const tpl = cfg.publish.resumeTitleTemplate.trim();
    if (!tpl) return undefined;

    /* 路径 2：按标题反查。主播名按可靠性排序：稿件列表反推 > 台账识别结果 */
    const anchors = [guessAnchorName(archives, liveTitle) ?? '', task.streamer ?? ''];
    const r = resolveResumeTarget({
      template: tpl,
      liveTitle,
      /* 日期优先取**录制文件名里的日期**：目录轮询导入的任务标题常常就是「哈喽」这种纯直播标题
         （没有日期），`liveStartTime` 也缺失 —— 那时 `taskDateText` 会退化成"**调用时刻**的日期"，
         于是跨零点之后渲染出来的日期会差一天，标题就永远匹配不上（实测 BV1Ymhb6QEeL 那场）。
         文件名是录制器写的，日期是真实的。 */
      dateText: resumeDateText(task),
      anchors,
      archives,
    });

    if (!r.target) {
      log.warn(
        `续传目标未命中：${r.reason ?? '未知原因'}（试过 ${r.tried.join(' / ') || '（无）'}）—— ` +
          `biliLive-tools 的标题模板是 {{user}}{{title}}{{now}}，可核对 publish.resumeTitleTemplate / publish.resumeAid`,
        { taskId: task.id, data: { candidates: r.candidates } },
      );
      return undefined;
    }

    const t = r.target;
    const partCount = t.bvid ? await this.readArchivePartCount(t.bvid, log) : undefined;
    log.info(
      `按标题命中续传目标稿件：${t.bvid ?? '(无bvid)'}（aid=${t.aid}）「${t.title ?? ''}」` +
        `—— 匹配方式 ${t.how === 'exact' ? '标题精确匹配' : '标题匹配（日期按容差）'}，主播名「${t.anchor || '(空)'}」` +
        `${partCount !== undefined ? `，该稿件已有 ${partCount} 个分P` : ''}`,
      { taskId: task.id, data: { aid: t.aid, how: t.how, partCount } },
    );
    return { aid: t.aid, how: t.how, anchor: t.anchor, ...(t.bvid ? { bvid: t.bvid } : {}), ...(partCount !== undefined ? { partCount } : {}) };
  }

  /**
   * 翻页取稿件列表。
   *
   * 为什么要翻页：实测 `/bili/archives` **单页只给 10 条**（请求 `ps=50` 也被截到 10），
   * 而账号里已有几十条稿件；只取第一页会「看不到更早的完整版稿件」而误判未命中。
   * 命中项一定是最近投的（biliLive-tools 在录制结束后就投完整版），
   * 所以按 `ctime` 早于「录制日 - 8 天」就停止翻页，不会白翻几十页。
   */
  private async fetchArchivesForResume(task: TaskRecord, log: Logger): Promise<ArchiveItem[]> {
    const maxPages = 8;
    const sinceMs = (task.liveStartTime ? task.liveStartTime * 1000 : Date.now()) - 8 * 86_400_000;
    const out: ArchiveItem[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      let one: ArchiveItem[];
      try {
        one = await this.client.biliArchives({ page, pageSize: 50 });
      } catch (e) {
        log.warn(`取稿件列表第 ${page} 页失败（不影响新建稿件）：${(e as Error).message.slice(0, 120)}`, { taskId: task.id });
        break;
      }
      const fresh = one.filter((a) => a.bvid && !seen.has(a.bvid));
      if (fresh.length === 0) break;
      for (const a of fresh) seen.add(a.bvid!);
      out.push(...fresh);
      const times = fresh.map((a) => (typeof a.ctime === 'number' ? a.ctime * 1000 : Number.POSITIVE_INFINITY));
      if (Math.min(...times) < sinceMs) break;
    }
    return out;
  }

  /** 读目标稿件的分P 数（切片分P 的编号基准）；读不到就返回 undefined，由调用方回落到配置 */
  private async readArchivePartCount(bvid: string, log: Logger): Promise<number | undefined> {
    /* 交给 Publisher 读：它内部有稿件详情单飞缓存，与「续传去重读分P 标题」
       共用同一次响应。原先这里自己发一次请求，导致同一秒里"读到 23 个分P"
       与"读不到分P 列表、跳过去重"同时出现 —— 同一个字段不可能同时有值又没值。
       ⚠️ 容错：测试会注入只实现 publishClips/publishAsMultiPart 的假 publisher，
       没有 readPartCount。缺失时退化为"读不到"（编号基准回落），不能让整条流程崩。 */
    const rd = (this.publisher as unknown as { readPartCount?: (b: string, l: Logger) => Promise<number | undefined> })
      .readPartCount;
    if (typeof rd !== 'function') {
      log.debug('当前 publisher 未提供 readPartCount（测试替身），分P 数按"未知"处理');
      return undefined;
    }
    return await rd.call(this.publisher, bvid, log);
  }

  /**
   * 多分P 模式：先切片（不单独投稿），再把所有分P一次投进同一个稿件。
   *
   * 分P 构成按用户确认的方案：**P1 完整版 + P2 纯享版 + P3..P(2+n) 各切片**，
   * 一次投稿只占 **1** 个每日额度（而每片一稿要占 n 个）。
   *
   * 返回值与 `publishClips` 保持同形，这样后面的告警、状态统计、终态判定都不用改。
   */
  private async publishMultiPartStage(ctx: {
    taskId: string;
    uid: number | string;
    log: Logger;
  }): Promise<{
    results: CutAndUploadResult[];
    submitted: number;
    skipped: number;
    failed: number;
    /**
     * `true` = **本场已无可投切片**（额度用完 / 切片全失败）。
     *
     * 为什么要单独标一个位，而不是让调用方拿数字去减：
     * 「切片全失败」与「额度用完」在数字上都是 `submitted=0`，但语义完全不同 ——
     * 前者该终止（做不出来，重跑也一样），后者只是没轮到。
     * 早期用 `submitted + unprocessed >= total` 这种算式判定，会把"全失败"也算成完成，
     * 于是任务被标成 PUBLISHED 但实际一个稿件都没投出去；反过来又会让正常被额度
     * 截断的场次永远卡在 CLIPPED。所以这里用显式的布尔位表达意图，别让调用方猜。
     */
    stuck?: boolean;
    /** 标记走的是多分P 路径（终态判定口径不同） */
    multipart?: boolean;
    /**
     * `true` = 本场在**等 biliLive-tools 投出完整版稿件**（默认规则下的正常中间态）。
     *
     * 此时切片已经切好但**一个都没投**，也没有自己投完整版 —— 既不算成功也不算失败，
     * 所以任务保持 CLIPPED，由等待循环重查。终态判定必须把它与"部分完成"区分开，
     * 否则会误判成 PUBLISHED（历史事故：谎报成功）。
     */
    waiting?: boolean;
  }> {
    const { taskId, uid, log } = ctx;
    const cfg = this.config;
    const task = this.ledger.getTask(taskId)!;
    const clips = this.ledger.getClips(taskId);
    const selected = clips.filter((c) => c.selected && c.status !== 'SKIPPED').sort((a, b) => a.start - b.start);

    if (selected.length === 0) {
      log.info('多分P：没有选中的切片，跳过投稿');
      return { results: [], submitted: 0, skipped: 0, failed: 0, multipart: true };
    }

    /* ---- 额度检查：多分P 只占 1 个额度 ----
       `dailyLimit === 0` 表示**用户显式关闭了限额**，此时跳过检查。
       关闭后自动发布的数量由 `clip.autoSelectTopN`（选片收口）决定，不再是额度。 */
    const quotaOn = cfg.publish.dailyLimit > 0;
    const today = this.ledger.todayPublishedCount();
    if (quotaOn && today >= cfg.publish.dailyLimit) {
      const note = `今日额度已用完（${today}/${cfg.publish.dailyLimit}），本场不投稿`;
      log.warn(note);
      return {
        results: selected.map((c) => ({ clipIndex: c.index, ok: false, skipped: note, warnings: [note] })),
        submitted: 0,
        skipped: selected.length,
        failed: 0,
        stuck: true, // 无可投：本场就此终止，等额度恢复再重跑
        multipart: true,
      };
    }

    /* ---- 第一步：切片，但**不单独投稿**（skipUpload） ---- */
    log.info(`多分P模式：先切 ${selected.length} 个分P，再与完整版一起投进同一个稿件`);
    const cutRes = await this.publisher.publishClips({
      task,
      uid,
      skipUpload: true,
      signal: undefined,
      onProgress: (p) => this.setProgress(taskId, p.label, p.current, p.total),
    });

    const cutOk = cutRes.results.filter((r) => r.ok && r.output);
    const cutFailed = cutRes.results.filter((r) => !r.ok);
    for (const f of cutFailed) {
      log.error(`分P 切片失败（片段 #${f.clipIndex}）：${f.error?.message ?? '未知原因'}`);
    }

    /* ★★ 必须**逐个重读**切片：`selected` 是切片之前取的数组，里面的对象可能**已经过期**。
     *
     * 真实事故（2026-09-23，30 分钟录播全流程验证）：
     *   6 个切片全部切片成功（日志"切片产出完成"6 条、台账 status=CUT、mp4 都在磁盘上），
     *   但紧接着 `publishAsMultiPart` 报「没有任何可投稿的文件（完整版与切片都不可用）」
     *   —— 一个分P 都没投出去。原因是它收到的是切片前的 `selected`，其中每个 clip 都还**没有
     *   `cutOutput`**；于是 `parts` 构造时全部被"没有可用的产出文件"排除掉。
     *
     * 为什么 `selected` 会过期（不是简单的引用问题）：ledger 的 `clipsArray()` 会在
     *   「clips.json 的 mtime 比我们自己上次写它的时间新」时**重新读取该文件并重建整个切片数组**
     *   （设计意图：analyze.ts 会绕过 ledger 直接重写 clips.json，必须让内存跟上）。
     *   切片过程会写 clips.json，一旦这个重建被触发，之前拿到的对象引用就与台账脱钩了 ——
     *   现象就是"台账里明明有 cutOutput，传进去的那份却没有"。
     *
     * 修法用 `getClip(taskId, index)` **逐个按 index 取**：它是台账的权威入口，
     * 不受任何数组级快照/重建的影响，语义上没有歧义（不依赖"重读一次数组就够了"这种假设）。 */
    const selectedAfterCut = selected
      .map((c) => this.ledger.getClip(taskId, c.index))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    const withOutputBefore = selected.filter((c) => c.cutOutput).length;
    const withOutputAfter = selectedAfterCut.filter((c) => c.cutOutput).length;
    if (withOutputAfter !== withOutputBefore) {
      log.info(
        `重读切片：带产物的分P 从 ${withOutputBefore} 个补正为 ${withOutputAfter} 个` +
          `（切片前的快照不含 cutOutput —— 若不重读，多分P 会误报"没有任何可投稿的文件"）`,
        { taskId, data: { selected: selected.length, withOutputAfter } },
      );
    }

    if (cutOk.length === 0) {
      /* 切片全失败：做不出来，重跑也一样 ⇒ 标记 stuck 让本场终止，
         而不是让任务永远卡在 CLIPPED（更不是标成 PUBLISHED 谎报成功）。 */
      return {
        results: cutRes.results,
        submitted: 0,
        skipped: 0,
        failed: cutFailed.length,
        stuck: true,
        multipart: true,
      };
    }

    /* ---- 第二步：确定 P1 完整版 / P2 纯享版 ----
       完整版来自 biliLive-tools 的压制产物（`source.fullVideoPath`）。
       纯享版是 remux 出来的无弹幕原片，落在任务目录 `full/` 下（对齐 tools/publish-multipart.ts 的查找规则）。 */
    const fullVideoPath =
      task.source.fullVideoPath && exists(task.source.fullVideoPath) ? task.source.fullVideoPath : undefined;
    const fullDir = path.join(this.ledger.taskDir(taskId), 'full');
    const findInFull = (kw: string): string | undefined => {
      if (!exists(fullDir)) return undefined;
      const f = fs.readdirSync(fullDir).find((n) => n.toLowerCase().includes(kw) && n.endsWith('.mp4'));
      return f ? path.join(fullDir, f) : undefined;
    };
    const pureVideoPath =
      cfg.publish.pureSource === 'none' ? undefined : findInFull('p2') ?? findInFull('pure');

    if (!fullVideoPath) {
      log.warn('没有找到完整版压制产物（source.fullVideoPath 不存在）—— 本稿件只含切片分P，P1 从第一个切片开始');
    }
    if (!pureVideoPath && cfg.publish.pureSource !== 'none') {
      log.warn('没有找到纯享版产物（full/ 下无 p2/pure 命名的 mp4）—— 本稿件不含纯享版分P');
    }

    /* ---- 第二步半：找 biliLive-tools 已投的完整版稿件，把切片**续传**进去 ----
       用户的工作流：biliLive-tools 投「一场直播 = 1 个稿件的 N 个分P」，切片助手只追加切片分P。
       biliLive-tools 的 `/bili/upload` 带 `vid` 时走 `editMedia`（append：保留原分P、只加新的），
       不带则走 `addMedia`（新建稿件）——所以要拿到那个稿件的 aid。
       ⚠️ append 是安全的：`editMediaWebApi` 会把稿件**原有**的标题/简介/标签原样 POST 回去
       （`{...archiveData, ...{aid}}`），我们的 config 不会覆盖稿件信息，只贡献新的分P 标题。 */
    const resumeTarget = await this.findResumeTarget(task, log);
    const resumeAid = resumeTarget?.aid;
    const owner = this.fullVideoOwner(task);
    if (resumeAid) {
      /* 切片标题**不写 P 序号**（用户选定的方案）：目标稿件已有几个分P 由 biliLive-tools
         按 `SAME_MEDIA_UPLOAD_ORDER = ["handled","raw"]` 分组投出，一场 Z 段 ⇒ 2Z 个分P，
         是动态量；B站 分P列表自带位置序号，标题里再写一次只会错位。
         这里仍把探测到的 partCount 打进日志，便于人工核对顺序是否符合预期。 */
      log.info(
        `找到续传目标稿件 aid=${resumeAid} —— 切片将追加进该稿件` +
          `（该稿件已有 ${resumeTarget?.partCount ?? '未知'} 个分P 由 biliLive-tools 提供，` +
          `切片追加在最后；切片标题不带 P 序号，位置由 B站 分P列表标出）`,
        { taskId, data: { aid: resumeAid, how: resumeTarget?.how, partCount: resumeTarget?.partCount } },
      );
      this.clearPublishWait(taskId);
    } else if (owner === 'assistant') {
      log.warn(
        '未找到可续传的 biliLive-tools 稿件，但本场被**显式指定**由切片助手投完整版' +
          `（${task.overrides?.fullVideoBy === 'assistant' ? '任务级 overrides.fullVideoBy' : 'publish.fullVideoBy=assistant'}）` +
          ' —— 将新建 2+N 稿件（P1 完整版 · P2 纯享版 · P3… 切片）',
        { taskId },
      );
    } else {
      /* ★ 默认规则（用户定的）：完整版弹幕版 + 纯享版由 **biliLive-tools** 投，切片助手只追加切片分P。
         它的压制 + 上传是异步的（实测录制结束后 13–15 分钟才出弹幕版），而我们切片完成得更早，
         所以此刻查不到它那个稿件是**正常中间态**。这时：
           · 不许自己上（自己投 P1/P2 会变成两个稿件，同内容重复）；
           · 不许把切片投成独立稿件（违背"同一场 = 同一个稿件"）；
           · 本场停在 CLIPPED **等待**，由等待循环定期重查（见 `retryWaitingPublishes`）。
         超时（publish.resumeWaitMin）后停在 CLIPPED 并告警，要求人工确认 biliLive-tools 那边的情况。 */
      const wait = this.beginPublishWait(task, log);
      return {
        results: selectedAfterCut.map((c) => ({
          clipIndex: c.index,
          ok: false,
          skipped: wait.reason,
          warnings: [wait.reason],
        })),
        submitted: 0,
        skipped: selectedAfterCut.length,
        failed: 0,
        multipart: true,
        waiting: true,
      };
    }

    /* ---- 第三步：一次投出所有分P ---- */
    this.setProgress(taskId, `投稿中（多分P）`, 0, 1);
    const r = await this.publisher.publishAsMultiPart({
      task,
      uid,
      /* ★ 用**切片后重读**的列表（含 cutOutput），不是切片前的 selected —— 见上面那段说明 */
      clips: selectedAfterCut,
      ...(fullVideoPath ? { fullVideoPath } : {}),
      ...(pureVideoPath ? { pureVideoPath } : {}),
      ...(resumeAid ? { resumeAid } : {}),
      /* 目标稿件的 bvid：切片追加进去后就是它的分P，台账要照实记（否则永远停在 SUBMITTED、用完即删不触发） */
      ...(resumeAid && resumeTarget?.bvid ? { resumeBvid: resumeTarget.bvid } : {}),
      /* 不传 clipIndexBase：切片标题不带序号（序号由 B站 分P列表标出），
         目标稿件已有分P 数只用于日志核对。 */
      logger: log,
    });
    this.clearProgress(taskId);

    if (!r.ok) {
      log.error(`多分P投稿失败：${r.error ?? '未知原因'}`);
      return {
        results: cutRes.results.map((c) => (c.ok ? { ...c, ok: false, error: { type: 'internal', message: r.error ?? '多分P投稿失败' } } : c)),
        submitted: 0,
        skipped: 0,
        failed: cutOk.length,
      };
    }

    log.info(
      `多分P投稿完成：1 个稿件 / ${r.parts.length} 个分P（${r.parts.filter((p) => p.kind === 'full').length} 完整版 + ` +
        `${r.parts.filter((p) => p.kind === 'pure').length} 纯享版 + ${r.parts.filter((p) => p.kind === 'clip').length} 切片）` +
        `${r.skipped ? ` —— ${r.skipped}` : ''}`,
    );
    for (const w of r.warnings) log.warn(`多分P：${w}`);

    /* 切片状态由 publishAsMultiPart 内部写回（SUBMITTED + uploadTaskId）；
       bvid 与单切片路径一样只能靠周期性反查 `/bili/archives` 拿到（陷阱 #11）。
       ⚠️ `submitted` 必须是**真正投出去**的切片数 —— 用 `r.parts`（实际投稿的分P 列表）
          而不是 `selected.length`（含"勾选了但根本没产出文件"的切片）。
          填错会让调用方的终态判定永远不成立（实测任务卡在 CLIPPED）。 */
    const clipParts = r.parts.filter((p) => p.kind === 'clip').length;
    return {
      results: cutRes.results,
      submitted: r.skipped ? 0 : clipParts,
      skipped: r.skipped ? selected.length : 0,
      failed: cutFailed.length,
      multipart: true,
    };
  }

  /* ------------------------------------------------------------------------
   * 子步骤
   * ---------------------------------------------------------------------- */

  /** 源素材校验：切片的唯一前置条件是「源文件存在且可用」 */
  private verifySource(task: TaskRecord): { ok: boolean; reason: string; detail: string } {
    const usable = task.source.rawFiles.filter((f) => exists(f));
    const full = task.source.fullVideoPath && exists(task.source.fullVideoPath) ? task.source.fullVideoPath : undefined;
    if (usable.length === 0 && !full) {
      return {
        ok: false,
        reason:
          `源文件不可用：rawFiles（${task.source.rawFiles.length} 个）与 fullVideoPath（${task.source.fullVideoPath ?? '未设置'}）都不存在。` +
          `若 biliLive-tools 开启了「上传后删除素材」，文件可能已被它删掉（硬约束 #11 要求关闭该开关）`,
        detail: '',
      };
    }
    const totalGB = usable.reduce((a, f) => a + (fs.statSync(f).size || 0), 0) / 1024 ** 3;
    return {
      ok: true,
      reason: '',
      detail: `${usable.length} 个原始文件（${fmtBytes(totalGB * 1024 ** 3)}）${full ? `，压制产物 ${path.basename(full)}` : '，无压制产物'}`,
    };
  }

  /** 转写：把 media.ts 的分段映射适配成 asr.ts 需要的 adapter */
  private async runTranscribe(task: TaskRecord, dir: string): Promise<Transcript> {
    const cfg = this.config;
    const log = this.logger.child({ taskId: task.id, mod: 'asr' });
    const segments = task.source.segments.length
      ? task.source.segments
      : buildSegmentMap(task.source.rawFiles, {
          ...(findFfprobe() ? { ffprobePath: findFfprobe()! } : {}),
          fallbackDurationSec: task.source.totalDuration,
        }).segments;

    // 输入源选择（§8 WP3 步骤 1）：默认读**录制原始文件**，这样转写才能与压制并行
    let inputSegments = segments;
    if (cfg.asr.inputSource === 'full' && task.source.fullVideoPath && exists(task.source.fullVideoPath)) {
      const p = probeMedia(task.source.fullVideoPath);
      inputSegments = [
        {
          path: task.source.fullVideoPath,
          duration: p.duration > 0 ? p.duration : task.source.totalDuration,
          globalStart: 0,
          globalEnd: p.duration > 0 ? p.duration : task.source.totalDuration,
          size: p.size,
        },
      ];
      log.info('按配置从**压制产物**转写（asr.inputSource=full）');
    } else {
      log.info(`从**录制原始文件**转写：${inputSegments.length} 个分段（与压制并行，互不阻塞）`);
    }

    const adapter = {
      planCalls: (range: { start: number; end: number }) => {
        const out: Array<{
          file: string;
          inFileStart: number;
          inFileEnd: number;
          globalStart: number;
          globalEnd: number;
          offset: number;
          windowIndex: number;
        }> = [];
        for (const seg of inputSegments) {
          const s = Math.max(range.start, seg.globalStart);
          const e = Math.min(range.end, seg.globalEnd);
          if (e - s <= 0.5) continue;
          out.push({
            file: seg.path,
            inFileStart: Number((s - seg.globalStart).toFixed(3)),
            inFileEnd: Number((e - seg.globalStart).toFixed(3)),
            globalStart: Number(s.toFixed(3)),
            globalEnd: Number(e.toFixed(3)),
            // offset 语义实测结论见 asr.ts 的 WindowCall 注释：全局时间 = 段内时间 + globalStart
            offset: 0,
            windowIndex: 0,
          });
        }
        // 降级兜底：ffprobe 不可用时所有分段的 duration 都是 0，
        // 按分段边界切不出任何调用单元 —— 此时退化为「整文件一次」，
        // 总比静默产出空转写要好（转写失败会在 gaps 里显式体现）。
        if (out.length === 0 && inputSegments.length > 0) {
          const fallback = inputSegments[0]!;
          log.warn(
            `分段时长探测失败（ffprobe 不可用？），无法按分段边界规划转写窗口 —— ` +
              `已退化为「对 ${path.basename(fallback.path)} 整文件调用一次」。` +
              `若该场是多分段录制，转写时间戳可能与视频时间轴不一致，请检查 ffprobe 是否可用`,
          );
          out.push({
            file: fallback.path,
            inFileStart: 0,
            inFileEnd: Math.max(range.end - range.start, 1),
            globalStart: 0,
            globalEnd: Math.max(range.end - range.start, 1),
            offset: 0,
            windowIndex: 0,
          });
        }
        return out;
      },
      fileStat: (file: string) => {
        try {
          const st = fs.statSync(file);
          return { size: st.size, updatedAt: Math.round(st.mtimeMs) };
        } catch {
          return { size: -1, updatedAt: 0 };
        }
      },
    };

    const pre = this.transcriber.preflight(adapter, task.source.totalDuration);
    log.info(
      `转写预检：${pre.windows.length} 个调用单元，缓存命中 ${pre.cacheHits}，需付费 ${pre.toPay}，` +
        `音频合计 ${fmtDuration(pre.audioSeconds)}，估算费用 ¥${pre.estimatedCost.toFixed(2)}（ASR 为**估算值**）`,
    );

    const res = await this.transcriber.transcribe({
      taskId: task.id,
      media: adapter,
      totalDuration: task.source.totalDuration,
      ...(this.opts.dryRun !== undefined ? { dryRun: this.opts.dryRun } : {}),
      ...(this.opts.allowPaid !== undefined ? { allowPaid: this.opts.allowPaid } : {}),
      onProgress: (p) => this.setProgress(task.id, p.label, p.current, p.total),
    });
    for (const w of res.warnings) log.warn(w);

    /* ---- 术语表纠错：转写之后再落盘，缓存里始终保留 ASR 原样输出 ----
     * 放在这里而不是 asr.ts 内部，是为了让「ASR 缓存」与「术语表」解耦：
     * 改一次术语表不需要重新花钱转写，缓存永远复用。 */
    const glossary = this.glossary.load();
    if (glossary.replacements.length > 0) {
      const corrected = correctTranscript(res.transcript.segments, glossary);
      if (corrected.summary.replaced > 0) {
        res.transcript.segments = corrected.segments;
        res.transcript.glossaryCorrections = corrected.summary.hits.slice(0, 20);
        log.info(
          `术语表纠错：${corrected.summary.replaced} 处（${corrected.summary.hits
            .slice(0, 5)
            .map((h) => `${h.from}→${h.to}×${h.count}`)
            .join('，')}${corrected.summary.hits.length > 5 ? ' 等' : ''}）`,
        );
      } else {
        log.debug('术语表纠错：本次没有命中任何规则', { mod: 'glossary' });
      }
    }

    writeJsonAtomic(path.join(dir, 'transcript.json'), res.transcript);
    log.info(
      `转写落盘：${res.transcript.segments.length} 条字幕，gaps ${res.transcript.gaps.length} 处，` +
        `付费调用 ${res.paidCalls} 次（估算 ¥${(res.transcript.costEstimate ?? 0).toFixed(2)}）`,
    );
    return res.transcript;
  }

  /** 完整版上传支线（不阻塞切片流程） */
  private async kickFullVideoUpload(task: TaskRecord): Promise<void> {
    const cfg = this.config;
    // 每 3 分钟检查一次，最多跟踪 6 小时（§7.1 提到对方默认最多跟踪 24 小时）
    const deadline = Date.now() + 6 * 3600_000;
    let attempt = 0;
    while (Date.now() < deadline) {
      const cur = this.ledger.getTask(task.id);
      if (!cur) return;
      if (cur.fullUpload === 'CONFIRMED') {
        this.logger.info(`完整版已确认（bvid=${cur.fullVideoBvid}），停止跟踪`, { taskId: task.id });
        return;
      }
      attempt++;
      if (cur.source.fullVideoPath && exists(cur.source.fullVideoPath)) {
        try {
          const r = await this.publisher.ensureFullVideoUpload({
            task: cur,
            uid: (await this.client.primaryUid())?.uid ?? '',
            videoPath: cur.source.fullVideoPath,
          });
          this.ledger.updateTask(task.id, {
            fullUpload: r.status,
            ...(r.taskId ? { fullUploadTaskId: r.taskId } : {}),
            ...(r.bvid ? { fullVideoBvid: r.bvid } : {}),
          });
          if (r.status === 'CONFIRMED') {
            this.logger.info(`完整版上传完成并已反查确认：${r.note}`, { taskId: task.id });
            return;
          }
          this.logger.debug(`完整版上传跟踪（第 ${attempt} 次）：${r.note}`, { taskId: task.id });
        } catch (e) {
          this.logger.warn('完整版上传跟踪失败（下轮重试）', { taskId: task.id, data: { error: (e as Error).message } });
        }
      } else {
        this.logger.debug(`完整版压制产物尚未出现，继续等待（第 ${attempt} 次）`, { taskId: task.id });
      }
      await sleep(180_000);
    }
    this.logger.warn(`完整版上传跟踪超时（6 小时未确认），切片流程不受影响，但源 mp4 不会进入清理流程`, { taskId: task.id });
  }

  /**
   * 反查并确认「已提交但未拿到 bvid」的切片（SUBMITTED → PUBLISHED）。
   *
   * 为什么需要周期跑：
   *  - `/bili/upload` 只返回 `taskId`，**bvid 只能靠 `GET /bili/archives` 反查**（陷阱 #11、硬约束 #17）；
   *  - 定时发布的稿件（dtime 可能在 2 小时之后）要等 B站侧出现才会被查到；
   *  - 所以这是一件「必须反复做、直到查到」的事，而不是投完立刻能拿到结果。
   */
  async confirmPendingPublished(): Promise<{ scanned: number; confirmed: number; pending: number }> {
    const tasks = this.ledger.listTasks({ limit: 200 });
    let scanned = 0;
    let confirmed = 0;
    let pending = 0;
    for (const t of tasks) {
      const need = this.ledger.getClips(t.id).filter((c) => c.status === 'SUBMITTED');
      if (need.length > 0) {
        scanned += need.length;
        try {
          const r = await this.publisher.confirmPublished(t.id);
          confirmed += r.confirmed.length;
          pending += r.pending.length;
        } catch (e) {
          this.logger.debug(`bvid 反查失败（下轮重试）：${(e as Error).message}`, { taskId: t.id });
          continue;
        }
      }

      /* ★ 下面这段**不能**放进 `need.length > 0` 里面（曾经的写法就是放在 `continue` 之后）。
         真实事故（2026-09-24）：切片已经全部 PUBLISHED 的场次（例如状态被外部对齐过、
         或服务恰好在"确认完了但还没排期"之间重启）在下一轮里 `need.length === 0` →
         整个场次被 `continue` 跳过 → **永远排不进待删清单**，「用完即删」静默失效，
         源录播就一直留在盘上。所以"本场是否已完成"必须**每轮都检查**，与有没有待确认切片无关。

         `scheduleDeleteAfterUpload` 按路径去重（幂等），所以每 5 分钟调一次不会堆重复项。 */
      const clips = this.ledger.getClips(t.id);
      const selected = clips.filter((c) => c.selected);
      const allDone = selected.length > 0 && selected.every((c) => c.status === 'PUBLISHED');
      // 反查是「发布完成」的最终确认点：所有已勾选切片都拿到 bvid 后，把场级状态推进到 PUBLISHED。
      // 不推进的话，任务会永远停在 CLIPPED/ANALYZED —— UI 显示不对，
      // 素材清理的判定也会因为「切片尚未完成」而一直拒绝删除。
      if (allDone && t.status !== 'PUBLISHED' && t.status !== 'ARCHIVED') {
        this.ledger.setStatus(t.id, 'PUBLISHED', { stage: 'PUBLISHED', publishedAt: nowIso() });
        this.logger.info(`本场全部 ${selected.length} 个切片均已反查到 bvid，任务状态推进为 PUBLISHED`, { taskId: t.id });
      }
      /* 「用完即删」：本场**全部**切片都反查到 bvid 之后，才把成片与源录播排进待删清单。
         用户要的是"上传完成后删掉切片和源文件"，但删源不可逆 —— 所以：
         ① 只有全部确认完才排（任何一条还没确认就不动源，还能从源重切）；
         ② 进清单后宽限 graceHours 小时，期间界面上能取消。 */
      if (allDone) {
        try {
          this.scheduleDeleteAfterUpload(t.id);
        } catch (e) {
          this.logger.warn(`排入待删清单失败（不阻塞流程）：${(e as Error).message}`, { taskId: t.id });
        }
      }
    }
    if (confirmed > 0) {
      this.logger.info(`bvid 反查：本次确认 ${confirmed} 个切片，仍有 ${pending} 个待 B站侧出现`);
    }
    return { scanned, confirmed, pending };
  }

  /**
   * 把"本场已全部确认投稿成功"的成片与源录播排进待删清单（用户要的「用完即删」）。
   *
   * 三个前提缺一不可，任一不满足就**什么都不做**（宁可留着占盘，也不能删错）：
   *  1. `cleanup.deleteAfterUpload.enabled` 打开；
   *  2. 任务状态是 PUBLISHED（= 本场全部选中切片都反查到 bvid，硬约束 #17）；
   *  3. 源文件确实属于本任务记录的路径（不猜、不扫目录，只删台账里记着的）。
   *
   * 幂等：`scheduleDelete` 按路径去重，反查循环每 5 分钟跑一次也不会堆重复项。
   */
  scheduleDeleteAfterUpload(taskId: string): { scheduled: number; skipped: number; reason?: string } {
    const cfg = this.config;
    const d = cfg.cleanup.deleteAfterUpload;
    if (!d.enabled) return { scheduled: 0, skipped: 0, reason: '未开启 cleanup.deleteAfterUpload' };
    const task = this.ledger.getTask(taskId);
    if (!task) return { scheduled: 0, skipped: 0, reason: '任务不存在' };
    if (task.status !== 'PUBLISHED') {
      return { scheduled: 0, skipped: 0, reason: `任务状态是 ${task.status}，还没到"全部切片确认投稿成功"` };
    }

    const inputs: Array<{ path: string; kind: 'clip' | 'raw' | 'fullVideo'; taskId: string; reason: string; sizeBytes?: number }> = [];
    const clips = this.ledger.getClips(taskId).filter((c) => c.selected && c.status === 'PUBLISHED');
    const bvids = clips.map((c) => c.bvid).filter(Boolean);
    const why = `本场 ${clips.length} 个切片均已反查到 bvid（${bvids.slice(0, 3).join('、')}${bvids.length > 3 ? ' 等' : ''}）`;

    if (d.deleteClips) {
      for (const c of clips) {
        if (c.cutOutput && exists(c.cutOutput)) {
          inputs.push({ path: c.cutOutput, kind: 'clip', taskId, reason: why, sizeBytes: fileSize(c.cutOutput) });
        }
      }
      // 成片目录（切片可能已被移走，目录还在）——一并排上，避免留空壳
      const clipDir = path.join(CLIPS_DIR, taskId);
      if (exists(clipDir)) {
        inputs.push({ path: clipDir, kind: 'clip', taskId, reason: `${why}；清理本场成片目录` });
      }
    }
    if (d.deleteRaw) {
      for (const p of [...task.source.rawFiles, ...task.source.segments.map((s) => s.path)]) {
        if (p && exists(p)) {
          inputs.push({ path: p, kind: 'raw', taskId, reason: why, sizeBytes: fileSize(p) });
        }
      }
    }
    /* ⚠️ 这一段**目前不会执行**，而且是**故意的**（2026-09-24 与用户确认过）。
     *
     * `task.source.fullVideoPath` 实测永远是 undefined —— 完整版是**录制结束之后**才由
     * biliLive-tools 压出来的，而任务在「录制文件稳定」那一刻就导入了，那时产物还不存在，
     * 台账不会事后回填（`fullVideoBvid` 同理）。所以 `exists(...)` 恒为 false。
     *
     * 现场其实能按命名约定找到它（`recordings.ts` 的 `findVideoProducts()`，
     * 实时监控的「已投稿文件」那块就是这么列的）。但用户明确选择
     * **让完整版留在盘上、自己在监控面板里手动删** —— 所以这里**不要**顺手改成
     * "现场找出来再删"：那是每场约 3 GB 的源文件。真要改就先问。
     *
     * 连带后果：`config.json` 里的 `deleteAfterUpload.deleteFullVideo: true` 现在是个**空开关**。
     * 若哪天有人把 `fullVideoPath` 回填上了，这一段会立刻开始生效、把完整版删掉 ——
     * 那时要保留完整版的话，必须同时把那个配置改成 false。 */
    if (d.deleteFullVideo && task.source.fullVideoPath && exists(task.source.fullVideoPath)) {
      inputs.push({
        path: task.source.fullVideoPath,
        kind: 'fullVideo',
        taskId,
        reason: `完整版已上传确认（${task.fullUpload}）`,
        sizeBytes: fileSize(task.source.fullVideoPath),
      });
    }

    if (inputs.length === 0) return { scheduled: 0, skipped: 0, reason: '没有需要删除的文件' };
    const r = scheduleDelete(inputs, { graceHours: d.graceHours, logger: this.logger });
    if (r.added.length > 0) {
      this.logger.info(`「用完即删」：本场排入待删 ${r.added.length} 项（宽限 ${d.graceHours} 小时，界面可取消）`, {
        taskId,
        data: { added: r.added.length, skipped: r.skipped.length },
      });
    }
    return { scheduled: r.added.length, skipped: r.skipped.length };
  }

  /* ------------------------------------------------------------------------
   * 错误报告
   * ---------------------------------------------------------------------- */

  async reportError(input: Omit<ErrorReportInput, 'client' | 'appVersion'>): Promise<{ reportPath: string; reportId: string }> {
    const res = writeErrorReport({
      ...input,
      client: this.client,
      appVersion: APP_VERSION,
    });
    // 同时写回台账，UI 的失败态要能直接拿到报告入口
    if (input.taskId) {
      this.ledger.setError(input.taskId, res.brief);
    }
    this.logger.error(`已生成错误报告：${res.reportPath}`, undefined, { taskId: input.taskId });
    return { reportPath: res.reportPath, reportId: res.brief.reportId };
  }

  /* ------------------------------------------------------------------------
   * 稿件表现数据回流（§8 WP6 步骤 11）
   * ---------------------------------------------------------------------- */

  /* ------------------------------------------------------------------------
   * 任务管理：删除 / 停止 / 状态修复（UI 入口）
   * ---------------------------------------------------------------------- */

  /**
   * 预览删除一个任务会释放什么。
   *
   * 之所以先「预览」再「执行」：删除是不可逆的，用户需要先看清
   * 「删掉哪些文件、释放多少空间」，尤其是源素材可能被**别的任务共享**的情况。
   */
  inspectDeletion(taskId: string): {
    title: string;
    clipsDir?: string;
    clipsBytes: number;
    clipsFiles: number;
    taskDir: string;
    taskBytes: number;
    /** 任务目录里 full/ 子目录的字节数（压制产物：弹幕版 + 纯净版） */
    taskFullBytes: number;
    taskFullFiles: number;
    rawFiles: Array<{ path: string; size: number; sharedWith: string[] }>;
    rawBytes: number;
    fullVideo?: { path: string; size: number };
    publishedClips: number;
  } {
    const t = this.ledger.getTask(taskId);
    if (!t) throw new Error(`任务不存在：${taskId}`);
    const dir = this.ledger.taskDir(taskId);
    const clips = this.ledger.getClips(taskId);

    /** 目录内所有文件的字节数（递归） */
    const dirSize = (d: string): { bytes: number; files: number } => {
      let bytes = 0;
      let files = 0;
      const walk = (x: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(x, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = path.join(x, e.name);
          if (e.isDirectory()) walk(full);
          else {
            files++;
            bytes += fileSize(full);
          }
        }
      };
      walk(d);
      return { bytes, files };
    };

    // 源素材是否被别的任务也用着 —— 共享时不能删
    const others = this.ledger.listTasks({ limit: 500 }).filter((x) => x.id !== taskId);
    const rawFiles = t.source.rawFiles.map((f) => ({
      path: f,
      size: exists(f) ? fileSize(f) : 0,
      sharedWith: others.filter((o) => o.source.rawFiles.includes(f)).map((o) => o.id),
    }));

    const clipsDirAbs = absPath(path.join(this.cfg.clip.outputDir, taskId));
    const clipsInfo = exists(clipsDirAbs) ? dirSize(clipsDirAbs) : { bytes: 0, files: 0 };
    const taskInfo = dirSize(dir);
    // 任务目录里的大头通常是 full/ 下的压制产物（弹幕版 + 纯净版，动辄几个 GB），
    // 而转写/信号/总结这些「中间产物」其实很小。删除预览要把这两块分开说，
    // 否则用户看到「任务目录 2932 MB」会以为转写文本占了 3 个 G。
    const fullDirAbs = path.join(dir, 'full');
    const fullInfo = exists(fullDirAbs) ? dirSize(fullDirAbs) : { bytes: 0, files: 0 };

    return {
      title: t.title,
      ...(exists(clipsDirAbs) ? { clipsDir: clipsDirAbs } : {}),
      clipsBytes: clipsInfo.bytes,
      clipsFiles: clipsInfo.files,
      taskDir: dir,
      taskBytes: taskInfo.bytes,
      taskFullBytes: fullInfo.bytes,
      taskFullFiles: fullInfo.files,
      rawFiles,
      rawBytes: rawFiles.reduce((a, f) => a + f.size, 0),
      ...(t.source.fullVideoPath && exists(t.source.fullVideoPath)
        ? { fullVideo: { path: t.source.fullVideoPath, size: fileSize(t.source.fullVideoPath) } }
        : {}),
      publishedClips: clips.filter((c) => c.status === 'PUBLISHED' || c.status === 'SUBMITTED').length,
    };
  }

  private get cfg(): AppConfig {
    return this.store.config;
  }

  /**
   * 删除一个任务（台账记录 + 可选的文件）。
   *
   * 语义分层，避免误删：
   *   - `deleteClips`：删切片产物目录（通常只想删这个，它最占地方且可重切）
   *   - `deleteRaw`  ：删录制源文件（**若被别的任务共享则跳过**，并说明原因）
   *   - `deleteTaskDir`：删任务目录（转写/信号/总结/clips.json 等中间产物）
   *
   * 永远不做的事：不碰 B站上已投稿件。**已投稿的稿件必须去 B站创作中心删**，
   * 本地删记录不会撤回投稿 —— 这一点会在返回值与日志里明确说明。
   */
  async deleteTask(
    taskId: string,
    opts: { deleteClips?: boolean; deleteRaw?: boolean; deleteTaskDir?: boolean } = {},
  ): Promise<{
    ok: boolean;
    freedBytes: number;
    removed: string[];
    skipped: Array<{ path: string; reason: string }>;
    note: string;
    /** 移入回收站时的条目 id（可据此恢复） */
    trashId?: string;
  }> {
    const t = this.ledger.getTask(taskId);
    if (!t) throw new Error(`任务不存在：${taskId}`);

    // 正在处理的任务先停下来，否则删到一半又被流水线写回
    if (this.busy && this.queue.some((q) => q.taskId === taskId)) {
      this.queue = this.queue.filter((q) => q.taskId !== taskId);
      this.logger.warn(`任务 ${taskId} 在队列中，已移出队列后再删除`);
    }

    const plan = this.inspectDeletion(taskId);
    const removed: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let freed = 0;

    /* ---- 删除前先备份台账 ----
     * 实测教训：一次界面误点把 222.8 MB 成片 + 任务目录 + 台账记录一起永久删掉了，
     * 事后除了日志里一行「已删除任务」没有任何恢复依据。
     * 现在**任何删除都先留一份台账快照**，多花几 KB，换的是"能查回来"。 */
    const ledgerBackup = this.backupLedgerBefore(taskId);

    /* ---- 回收站 ----
     * 删除不再 `rmSync`，而是**移动**到 `data/trash/<时间>-<taskId>/` 并写下清单
     * （清单里带完整台账快照，所以能一键连任务一起恢复）。
     * 只有用户在界面上点「清空回收站」才会真正抹掉。 */
    const useTrash = this.cfg.cleanup.trashDays !== 0;
    const trashPaths: string[] = [];
    if (opts.deleteClips && plan.clipsDir) trashPaths.push(plan.clipsDir);
    if (opts.deleteTaskDir) trashPaths.push(plan.taskDir);
    if (opts.deleteRaw) for (const f of plan.rawFiles) if (exists(f.path) && f.sharedWith.length === 0) trashPaths.push(f.path);

    if (useTrash && trashPaths.length > 0) {
      const res = moveToTrash({
        taskId,
        title: t.title,
        status: t.status,
        paths: trashPaths,
        task: t,
        reason: '界面删除',
        logger: this.logger,
      });
      for (const w of res.warnings) skipped.push({ path: '(回收站)', reason: w });
      // 记录实际移走了哪些、释放多少（用户看到的数字必须与真实发生的一致）
      for (const f of res.files ?? []) {
        removed.push(f.from);
        freed += f.bytes;
      }
      if (res.id) {
        // ★ 只有把「任务目录」也删掉才算整体删除任务。
        //   曾经这里无条件 `this.ledger.deleteTask(taskId)` —— 于是用户在界面上
        //   只勾了「切片产物」（文案写着"默认只删切片产物（最占地方且随时可重切）"），
        //   整条任务却从列表里消失了，转写/信号/总结/投稿记录全都没了。
        //   切了还能重切，任务没了就什么都没了。
        const dropRecord = opts.deleteTaskDir === true;
        const tomb0 = dropRecord ? this.ledger.deleteTask(taskId) : undefined;
        /* 兜底：把可能被"顺手重建"的空目录也清掉。
           实测事故：勾了「任务目录」后它还是在那里 —— 因为删除流程里任何一个**只读**动作
           只要走了 `ledger.taskDir()`（它会 ensureDir）就会把刚移走的目录重建出来。
           现在读路径已改成不创建，这里再兜一层，**只在目录为空时**移除：
           绝不动还有内容的目录（那可能是别的东西写进去的）。 */
        if (dropRecord) {
          try {
            const leftover = this.ledger.taskDirPath(taskId);
            if (exists(leftover) && fs.readdirSync(leftover).length === 0) {
              fs.rmdirSync(leftover);
              this.logger.debug?.(`已清掉删除后残留的空任务目录：${leftover}`);
            }
          } catch (e) {
            skipped.push({ path: '(任务目录残留)', reason: (e as Error).message });
          }
        }
        const notes0: string[] = [];
        if (plan.publishedClips > 0) {
          notes0.push(
            `⚠️ 该任务有 ${plan.publishedClips} 个切片已投稿到 B站 —— 本次删除**只影响本地记录与文件，不会撤回投稿**；` +
              `如需撤下请到 B站创作中心操作`,
          );
        }
        /* 已投过的指纹退役成墓碑而不是丢弃：同一份素材若被重新导入并分析出同一区间，
           会在 B站 上投出第二个内容相同的稿件。把这件事明说出来，用户才知道
           「为什么重跑后那几片没投」以及去哪里解除。 */
        if (tomb0 && tomb0.tombstonedFingerprints > 0) {
          notes0.push(
            `🪦 ${tomb0.tombstonedFingerprints} 个已投稿切片的指纹已转为**墓碑**：` +
              `同一录制区间以后不会再被重复投稿（B站 上的旧稿件仍然存在，本地删除不会撤回它）。` +
              `若确认旧稿件已不存在，可在健康面板解除墓碑`,
          );
        }
        notes0.push(`已移入回收站（${fmtBytes(freed)}），可随时恢复`);
        notes0.push(
          dropRecord
            ? '任务记录已一并移除'
            : '**任务记录已保留**：转写、弹幕信号、总结与投稿记录都还在，只是切片文件进了回收站，可随时重切',
        );
        if (ledgerBackup) notes0.push(`台账快照：${path.basename(ledgerBackup)}`);
        this.logger.info(`已把任务 ${taskId} 移入回收站 ${res.id}：${removed.length} 项，${fmtBytes(freed)}`, {
          taskId,
          data: { trashId: res.id, dropRecord },
        });
        return { ok: true, freedBytes: freed, removed, skipped, note: notes0.join('；'), trashId: res.id };
      }
      // 回收站建立失败（已在 warnings 里说明）→ 落到下面的永久删除路径，但台账已备份
      this.logger.warn(`回收站不可用，将按永久删除处理（台账已备份：${ledgerBackup ?? '无'}）`, { taskId });
      removed.length = 0;
      freed = 0;
    }

    const rmDir = (d: string): void => {
      if (!exists(d)) return;
      try {
        const size = plan.taskBytes; // 仅用于日志的量级参考
        fs.rmSync(d, { recursive: true, force: true });
        removed.push(d);
        freed += d === plan.taskDir ? 0 : size;
      } catch (e) {
        skipped.push({ path: d, reason: (e as Error).message });
      }
    };

    // 1) 切片产物
    if (opts.deleteClips && plan.clipsDir) {
      try {
        fs.rmSync(plan.clipsDir, { recursive: true, force: true });
        removed.push(plan.clipsDir);
        freed += plan.clipsBytes;
        this.logger.info(`已删除切片产物：${plan.clipsDir}（释放 ${fmtBytes(plan.clipsBytes)}）`, { taskId });
      } catch (e) {
        skipped.push({ path: plan.clipsDir, reason: (e as Error).message });
      }
    }

    // 2) 源素材（共享时跳过）
    if (opts.deleteRaw) {
      for (const f of plan.rawFiles) {
        if (!exists(f.path)) continue;
        if (f.sharedWith.length > 0) {
          skipped.push({
            path: f.path,
            reason: `被其它任务共享（${f.sharedWith.join(', ')}），已保留以免破坏那些任务的重跑能力`,
          });
          continue;
        }
        try {
          fs.unlinkSync(f.path);
          removed.push(f.path);
          freed += f.size;
        } catch (e) {
          skipped.push({ path: f.path, reason: (e as Error).message });
        }
      }
    }

    // 3) 任务目录（放在最后：前面的「已删除」记录仍在内存里，日志才有意义）
    if (opts.deleteTaskDir) {
      rmDir(plan.taskDir);
    }

    // 4) 台账记录：与回收站路径同一规则 —— 只有删了「任务目录」才算整体删除任务，
    //    否则保留记录（转写/信号/总结/投稿历史都还在，切片删了还能重切）。
    const dropRecord = opts.deleteTaskDir === true;
    const del = dropRecord
      ? this.ledger.deleteTask(taskId)
      : { deleted: false, freedFingerprints: 0, tombstonedFingerprints: 0, title: '' };

    const notes: string[] = [];
    if (plan.publishedClips > 0) {
      notes.push(
        `⚠️ 该任务有 ${plan.publishedClips} 个切片已投稿到 B站 —— 本次删除**只影响本地记录与文件，不会撤回投稿**；` +
          `如需撤下请到 B站创作中心操作`,
      );
    }
    if (del.deleted && del.tombstonedFingerprints > 0) {
      notes.push(
        `🪦 ${del.tombstonedFingerprints} 个已投稿切片的指纹已转为**墓碑**：` +
          `同一录制区间以后不会再被重复投稿（旧稿件仍在 B站，本地删除不会撤回它）。` +
          `若确认旧稿件已不存在，可在健康面板解除墓碑`,
      );
    }
    if (skipped.length) notes.push(`${skipped.length} 项被跳过（详见 skipped 字段）`);
    notes.push(`已释放 ${fmtBytes(freed)}`);
    notes.push(
      dropRecord
        ? '任务记录已一并移除'
        : '**任务记录已保留**：转写、弹幕信号、总结与投稿记录都还在，可随时重切切片',
    );

    this.logger.info(
      `已删除任务 ${taskId}：删除 ${removed.length} 项，跳过 ${skipped.length} 项，` +
        `释放 ${fmtBytes(freed)}${dropRecord ? '，任务记录已移除' : '，任务记录保留'}`,
      { taskId },
    );
    return { ok: true, freedBytes: freed, removed, skipped, note: notes.join('；') };
  }

  /**
   * 停止一个正在处理 / 卡住的任务，把它放回可操作的状态。
   *
   * 能做的与不能做的（必须说清楚，否则用户会以为切片被取消了）：
   *   - 能：把它移出待处理队列；把台账从运行态修回稳定状态；清掉进度显示
   *   - 不能：中断 biliLive-tools 里**已经在跑**的 ffmpeg 任务 ——
   *     那是对方进程内的事，本地删掉记录不会让它停下
   */
  async stopTask(taskId: string): Promise<{ ok: boolean; from: string; to: string; reason: string; note: string }> {
    const t = this.ledger.getTask(taskId);
    if (!t) throw new Error(`任务不存在：${taskId}`);

    const removedFromQueue = this.queue.some((q) => q.taskId === taskId);
    this.queue = this.queue.filter((q) => q.taskId !== taskId);
    this.progress.delete(taskId);

    const repair = this.ledger.repairStuckTask(taskId);
    const note = removedFromQueue
      ? '已移出待处理队列，并修复了台账状态'
      : repair.from === repair.to
        ? '该任务不在处理中，台账状态无需修复'
        : '已修复台账状态（若 biliLive-tools 里仍有 ffmpeg 在跑，它会自己跑完，不影响后续操作）';
    return { ok: true, from: repair.from, to: repair.to, reason: repair.reason, note };
  }

  /**
   * 拉取近 30 天已发布切片的表现数据，追加写入 `performance.jsonl`。
   *
   * 设计取舍（原文依据）：每日一次、**只读接口**、无风控压力。
   * 本版只做**拉取与存储**，不做任何自动调整阈值/模型（那是附录 B 的二期功能）。
   */
  async refreshPerformance(opts: { days?: number } = {}): Promise<{
    checked: number;
    updated: number;
    failed: Array<{ bvid: string; error: string }>;
    notes: string[];
  }> {
    const days = opts.days ?? 30;
    const notes: string[] = [];
    const pending = this.ledger.bvidsNeedingPerformance(days);
    const failed: Array<{ bvid: string; error: string }> = [];
    let updated = 0;

    if (pending.length === 0) {
      notes.push(`近 ${days} 天没有需要拉取表现数据的切片（可能都已拉过，或还没有已发布且反查到 bvid 的切片）`);
      return { checked: 0, updated: 0, failed, notes };
    }

    this.logger.info(`开始拉取稿件表现数据：${pending.length} 个切片（每日一次，只读接口）`);
    const today = fmtLocal().slice(0, 10);

    for (const item of pending) {
      try {
        const detail = await this.client.biliArchiveDetail(item.bvid);
        const stat = (detail.stat ?? {}) as Record<string, number | undefined>;
        this.ledger.recordPerformance({
          bvid: item.bvid,
          taskId: item.taskId,
          clipIndex: item.clipIndex,
          date: today,
          view: stat['view'] ?? 0,
          like: stat['like'] ?? 0,
          coin: stat['coin'] ?? 0,
          favorite: stat['favorite'] ?? 0,
          danmaku: stat['danmaku'] ?? 0,
          reply: stat['reply'] ?? 0,
          share: stat['share'] ?? 0,
        });
        updated++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push({ bvid: item.bvid, error: msg });
        // 单个稿件查询失败不影响其它（可能是稿件被删或接口限流）
        if (isArchiveGoneError(msg)) {
          // 错误文案有歧义（「啥都木有」在**审核中/转码中**也会出现），必须再确认一次：
          // 该 bvid 是否已从稿件列表里消失。列表里还在 → 只是详情暂时取不到，不算消失。
          let stillListed = false;
          try {
            const archives = await this.client.biliArchives({ page: 1, pageSize: 100 });
            stillListed = archives.some((a) => a.bvid === item.bvid);
          } catch {
            stillListed = true; // 列表都查不到时**宁可当作还在**，避免误标记
          }
          if (stillListed) {
            this.logger.debug(`稿件 ${item.bvid} 详情暂不可用但仍在稿件列表中（审核/转码中？），保留后续重试`);
          } else {
            // 确认消失（用户删稿 / 被下架）：重试没有意义，
            // 记下来，之后不再对它发起请求，否则每天都会重试 3 次并刷一条 ERROR。
            this.ledger.setClipStatus(item.taskId, item.clipIndex, 'PUBLISHED', { archiveGoneAt: nowIso() });
            notes.push(`稿件 ${item.bvid} 已不在稿件列表（被删或下架），已标记并停止拉取表现数据`);
            this.logger.warn(`稿件 ${item.bvid} 已确认消失，标记 archiveGoneAt 后不再重试`);
          }
        } else {
          this.logger.debug(`拉取 ${item.bvid} 表现数据失败：${msg}`);
        }
      }
    }
    notes.push(
      `已更新 ${updated}/${pending.length} 个切片的表现数据到 performance.jsonl；` +
        `与 decisions.jsonl 按 taskId 关联后可在 UI 查看「LLM 评分 vs 实际表现」`,
    );
    this.logger.info(notes[notes.length - 1]!);
    return { checked: pending.length, updated, failed, notes };
  }

  /** 每月费用汇总（使用期辅助功能：成本月度汇总） */
  monthlySummary(): {
    month: string;
    tasks: number;
    asrEstimate: number;
    llmActual: number;
    total: number;
    byDay: Record<string, { asr: number; llm: number }>;
    disclaimer: string;
  } {
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let asr = 0;
    let llm = 0;
    let tasks = 0;
    const byDay: Record<string, { asr: number; llm: number }> = {};
    for (const t of this.ledger.listTasks({ limit: 1000 })) {
      const d = new Date(Date.parse(t.createdAt));
      if (`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` !== key) continue;
      tasks++;
      asr += t.cost.asrEstimate ?? 0;
      llm += t.cost.llmActual ?? 0;
      const day = String(d.getDate()).padStart(2, '0');
      byDay[day] = byDay[day] ?? { asr: 0, llm: 0 };
      byDay[day]!.asr += t.cost.asrEstimate ?? 0;
      byDay[day]!.llm += t.cost.llmActual ?? 0;
    }
    return {
      month: key,
      tasks,
      asrEstimate: Number(asr.toFixed(2)),
      llmActual: Number(llm.toFixed(4)),
      total: Number((asr + llm).toFixed(2)),
      byDay,
      disclaimer: 'ASR 为**估算值**（按自研服务提交的音频时长 × 配置单价），LLM 为 API 响应 usage 计算的**实际值**',
    };
  }

  /* ------------------------------------------------------------------------
   * 手动导入录播（§8 WP7 使用期辅助功能）
   * ---------------------------------------------------------------------- */

  /**
   * 手动/自动导入一条本地录播，跑完整链路。
   * 用途：补跑漏掉的场次、测试新 prompt、处理其他渠道获得的录播。
   * 目录轮询（`WatchImporter`）也走这里，靠 `input.source` 区分 —— 见 `importIdentity`。
   *
   * 弹幕文件有两个来源：显式传入，或**自动查找同名文件**（`.xml` 优先于 `.ass`）——
   * 录制器产出的弹幕与视频同名同目录，手工导入时让用户再填一次路径纯属多余，
   * 而漏掉弹幕会让选片丢掉最有效的信号（密度/峰值/高能事件全部为空）。
   *
   * ★ 多分段时还有第三条路：**按段配对 + 合并**。biliLive-tools 的弹幕文件是按「段自己的开始时刻」
   *   命名的（`…-PART001.ts` 那一段的弹幕叫 `<第二段开始时刻> ….xml`），所以「同名查找」和
   *   biliLive-tools 的映射接口**都找不到它**。详见 `danmaku-merge.ts` 的说明。
   */
  async importLocal(input: {
    videoPath: string;
    danmaPath?: string;
    title?: string;
    roomId?: string;
    hasDanmakuInPicture?: boolean;
    /**
     * 导入来源。默认 `manual`（UI/CLI/MCP 都是人工点的）；
     * 目录轮询必须显式传 `auto` —— 否则任务会被标成「手动导入」，用户分不清谁建的。
     */
    source?: 'manual' | 'auto';
  }): Promise<TaskRecord> {
    const cfg = this.config;
    if (!exists(input.videoPath)) {
      throw new Error(`文件不存在：${input.videoPath}`);
    }

    const ident = importIdentity(input, nowIso());
    const { title, id } = ident;

    // 手动导入的视频可能是一个目录里的多个分段
    const segs = discoverSegments(input.videoPath);
    const ffprobe = findFfprobe();
    const map = buildSegmentMap(segs, {
      ...(ffprobe ? { ffprobePath: ffprobe } : {}),
      maxSegments: cfg.segmented.maxSegments,
    });

    /* ---- 弹幕：多分段「按段合并」优先 → 显式/同名文件兜底 ----
     *
     * ⚠️ 顺序很关键，而且**只在 `chooseDanmaku` 里定义**（那是单测钉住的地方）。
     *   一份 XML 只覆盖一个分段，合并结果是覆盖整场的超集，所以只要合并成功就该用它。
     *   详见 `danmaku-merge.ts` 的 `chooseDanmaku` 注释 —— 最初写成「显式优先」时，
     *   目录轮询传进来的单份弹幕会让合并那条路永远走不到，多分段照旧只有第 1 段有弹幕。 */
    const mergedPath = map.segments.length > 1 ? await this.resolveMergedDanmaku(id, map.segments) : undefined;
    const sibling = findSiblingDanmaku(input.videoPath);
    const choice = chooseDanmaku({
      segmentCount: map.segments.length,
      ...(mergedPath ? { mergedPath } : {}),
      ...(input.danmaPath ? { explicitPath: input.danmaPath } : {}),
      ...(sibling ? { siblingPath: sibling.path } : {}),
    });
    let danmaPath = choice.path;
    if (danmaPath && !exists(danmaPath)) {
      this.logger.warn(`弹幕文件不存在（${danmaPath}），本场将没有弹幕信号`);
      danmaPath = undefined;
    }
    if (choice.from === 'merged-segments') this.logger.info(choice.note);
    else if (danmaPath && choice.from === 'sibling') this.logger.info(`自动发现同名弹幕文件：${path.basename(danmaPath)}`);
    if (!danmaPath) {
      this.logger.warn(
        `未找到配套弹幕文件（尝试过按段合并、显式指定、同名 ${path.basename(input.videoPath, path.extname(input.videoPath))}.xml/.ass）` +
          `—— 本场将没有弹幕信号，选片只能依赖转写`,
      );
    }

    const kind = danmaKind(danmaPath);
    const source = buildSourceMedia({
      rawFiles: segs,
      // 源文件是否已烧弹幕：显式传入优先（用户在导入清单里选的就是「-弹幕版」），
      // 否则用全局配置。硬约束 #12 要求这个值有明确依据，不能运行时猜。
      fullVideoHasDanmaku: input.hasDanmakuInPicture ?? cfg.clip.fullVideoHasDanmaku,
      ...(danmaPath ? { danmaFilePath: danmaPath, danmaFileExt: kind === 'unknown' ? 'xml' : kind } : {}),
      ...(ffprobe ? { ffprobePath: ffprobe } : {}),
    });
    source.segments = map.segments;
    source.totalDuration = map.totalDuration || source.totalDuration;

    const rec: TaskRecord = {
      id,
      roomId: input.roomId ?? cfg.room.roomId,
      platform: cfg.room.platform,
      title,
      manual: ident.manual,
      importSource: ident.importSource,
      status: 'RECORDED',
      stage: 'RECORDED',
      source,
      fullUpload: 'NOT_APPLICABLE',
      cost: emptyCost(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const { record } = this.ledger.createTask(rec);
    this.logger.info(
      `已创建${ident.importSource === 'auto' ? '自动' : '手动'}导入任务 ${id}：${title}（${map.segments.length} 个文件，总时长 ${fmtDuration(source.totalDuration)}）`,
    );
    await this.enqueue(id, 'RECORDED');
    return record;
  }

  /**
   * 多分段录播的弹幕：**按段配对 + 合并成一条全局时间轴**。
   *
   * 背景（详见 `danmaku-merge.ts`）：biliLive-tools 的视频分段用「会话开始时刻」+ `-PART{n}` 命名，
   * 而弹幕 XML 用「**该段自己的开始时刻**」命名 —— 前缀对不上，于是
   * 「同名查找」和 `/record-history/danma-file` **都拿不到第 2 段及以后的弹幕**。
   * 结果是那些分段静默失去弹幕信号（密度/峰值/热词全空），选片降级成语音兜底。
   *
   * 返回合并后的 XML 路径；配不上任何一段时返回 undefined，让调用方退回原有逻辑。
   */
  private async resolveMergedDanmaku(taskId: string, segments: SourceSegment[]): Promise<string | undefined> {
    if (segments.length < 2) return undefined;
    try {
      const paired = await pairSegmentDanmaku(segments, {
        lookup: async (p) => {
          const ref = await this.client.danmaFileByVideoPath(p);
          const f = String(ref?.danmaFilePath ?? '').trim();
          return f && exists(f) ? f : undefined;
        },
        dir: path.dirname(segments[0]!.path),
      });
      for (const w of paired.warnings) this.logger.warn(`分段弹幕：${w}`);
      if (paired.matches.length === 0) return undefined;

      const outPath = path.join(this.ledger.taskDir(taskId), 'danmaku-merged.xml');
      const merged = mergeDanmakuXmlFiles(
        paired.matches.map((m) => ({ danmakuPath: m.danmakuPath, offsetSec: m.globalStart })),
        outPath,
      );
      const detail = paired.matches
        .map((m) => `第${m.index + 1}段 ← ${path.basename(m.danmakuPath)}（偏移 ${Math.round(m.globalStart)}s，依据 ${m.how}${m.driftSec !== undefined ? `，差 ${m.driftSec}s` : ''}）`)
        .join('；');
      if (merged.failed.length > 0) {
        this.logger.error(
          `分段弹幕合并：${merged.failed.length} 个来源读取失败（${merged.failed.map((f) => path.basename(f.path)).join('、')}）`,
          undefined,
          { taskId, mod: 'pipeline' },
        );
      }
      this.logger.info(
        `分段弹幕已合并：${paired.matches.length}/${segments.length} 段共 ${merged.count} 条 ` +
          `（各段 ${merged.perPart.join('/')}）→ ${outPath}；${detail}`,
        { taskId, mod: 'pipeline' },
      );
      if (paired.missing.length > 0) {
        this.logger.warn(
          `第 ${paired.missing.map((i) => i + 1).join('、')} 段没有弹幕，合并结果只覆盖其余分段 —— ` +
            `这几段的弹幕密度/峰值会偏低，选片时请注意`,
          { taskId, mod: 'pipeline' },
        );
      }
      return outPath;
    } catch (e) {
      this.logger.warn(`分段弹幕配对失败，退回单文件逻辑：${(e as Error).message}`, { taskId, mod: 'pipeline' });
      return undefined;
    }
  }

  /* ------------------------------------------------------------------------
   * 录播清单辅助：给「导入录播」算 ASR 窗口数与缓存命中
   * ---------------------------------------------------------------------- */

  /**
   * 对某个文件跑一次 ASR 预检（不花钱）。
   *
   * 复用 `Transcriber.preflight` 而不是自己算缓存键：缓存键的组成
   * （文件大小 + mtime + 模型 + 起止 + offset + 剪静音参数）改动过好几次，
   * 自己重算极易漂移 —— 结果就是界面显示「已缓存」而实际仍然付费。
   */
  preflightAsr(videoPath: string, durationSec: number): { windows: number; cacheHits: number; estCost: number } {
    const adapter: AsrMediaAdapter = {
      planCalls: (range) => [
        {
          file: videoPath,
          inFileStart: range.start,
          inFileEnd: range.end,
          globalStart: range.start,
          globalEnd: range.end,
          offset: 0,
          windowIndex: 0,
        },
      ],
      fileStat: (file: string) => {
        try {
          const st = fs.statSync(file);
          return { size: st.size, updatedAt: Math.round(st.mtimeMs) };
        } catch {
          return { size: -1, updatedAt: 0 };
        }
      },
    };
    const pre = this.transcriber.preflight(adapter, durationSec);
    return { windows: pre.windows.length, cacheHits: pre.cacheHits, estCost: pre.estimatedCost };
  }

  /* ------------------------------------------------------------------------
   * 回收站与台账快照
   * ---------------------------------------------------------------------- */

  /**
   * 删除前把台账整份复制一份到 `data/ledger-backup/`。
   *
   * 为什么整份复制而不是只存这一个任务：删除可能是"连错好几个"，
   * 而且台账里还有指纹表与标题索引 —— 只存任务记录不足以复原幂等状态。
   * 只保留最近 20 份，避免无限增长。
   */
  private backupLedgerBefore(taskId: string): string | undefined {
    try {
      const src = (this.ledger as unknown as { ledgerPath?: string }).ledgerPath;
      if (!src || !exists(src)) return undefined;
      const dir = path.join(this.dataDir, 'ledger-backup');
      ensureDir(dir);
      const p = (n: number): string => String(n).padStart(2, '0');
      const d = new Date();
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const dest = path.join(dir, `${stamp}-${taskId.replace(/[^\w.-]/g, '_').slice(0, 50)}.json`);
      fs.copyFileSync(src, dest);
      // 只留最近 20 份
      const all = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
      for (const old of all.slice(0, Math.max(0, all.length - 20))) {
        try {
          fs.unlinkSync(path.join(dir, old));
        } catch {
          /* ignore */
        }
      }
      return dest;
    } catch (e) {
      this.logger.warn(`台账快照失败（不影响删除，但少了一层兜底）：${(e as Error).message}`);
      return undefined;
    }
  }

  /** 回收站内容（界面用） */
  trash() {
    return { entries: listTrash(), stats: trashStats(), dir: TRASH_DIR };
  }

  /** 从回收站恢复一个任务 */
  restoreFromTrash(id: string): { ok: boolean; restored: string[]; warnings: string[] } {
    return restoreFromTrash(id, this.ledger, this.logger);
  }

  /** 清空回收站（olderThanDays 缺省表示全清） */
  purgeTrash(opts: { olderThanDays?: number; ids?: string[] } = {}): { purged: number; bytes: number } {
    return purgeTrash({ ...opts, logger: this.logger });
  }

  /* ------------------------------------------------------------------------
   * 健康快照（§8 WP7 健康面板）
   * ---------------------------------------------------------------------- */

  async health(): Promise<{
    bililive: { ok: boolean; version?: string; expected: string; drift: boolean; baseUrl: string; message: string };
    account?: { uid: number | string; name?: string; daysLeft?: number; expired: boolean; message: string };
    disk?: { freeGB: number; totalGB: number; thresholdGB: number; low: boolean };
    todayPublished: number;
    dailyLimit: number;
    errorsLast24h: number;
    queue: { busy: boolean; length: number; paused: boolean };
    storage: ReturnType<Cleaner['storageOverview']>;
    trigger: ReturnType<Trigger['stateSnapshot']>;
    /** 生效中的墓碑数（已删除任务的、曾经投出去过的指纹）。>0 表示有内容被保护性拦下 */
    tombstones: number;
    version: string;
    uptimeSec: number;
    mode: { autoPublish: boolean; isOnlySelf: boolean; dryRun: boolean; allowPaid: boolean };
    prompts: ReturnType<PromptStore['list']>;
  }> {
    const cfg = this.config;
    const out: Awaited<ReturnType<Orchestrator['health']>> = {
      bililive: { ok: false, expected: cfg.bililive.versionExpected, drift: false, baseUrl: cfg.bililive.baseUrl, message: '未连接' },
      todayPublished: this.ledger.todayPublishedCount(),
      dailyLimit: cfg.publish.dailyLimit,
      errorsLast24h: 0,
      queue: { busy: this.busy, length: this.queue.length, paused: this.paused },
      storage: this.cleaner.storageOverview(),
      trigger: this.trigger.stateSnapshot(),
      tombstones: this.ledger.tombstoneCount(),
      version: APP_VERSION,
      uptimeSec: Math.round((Date.now() - Date.parse(this.bootedAt)) / 1000),
      mode: {
        autoPublish: cfg.publish.autoPublish,
        isOnlySelf: cfg.publish.isOnlySelf === 1,
        dryRun: Boolean(this.opts.dryRun),
        allowPaid: Boolean(this.opts.allowPaid) || cfg.runtime.allowPaid,
      },
      prompts: this.prompts.list(),
    };

    try {
      const v = await this.client.version();
      const drift = await this.client.checkVersionDrift(cfg.bililive.versionExpected);
      out.bililive = {
        ok: true,
        version: v,
        expected: cfg.bililive.versionExpected,
        drift: drift?.drift ?? false,
        baseUrl: cfg.bililive.baseUrl,
        message: drift?.note ?? `已连接（${v}）`,
      };
    } catch (e) {
      out.bililive.message = `连接失败：${(e as Error).message}`;
    }

    try {
      const users = await this.client.userList();
      if (users.length) {
        const u = users[0]!;
        const daysLeft = u.expires ? (u.expires - Date.now()) / 86400_000 : undefined;
        out.account = {
          uid: u.uid,
          ...(u.name ? { name: u.name } : {}),
          ...(daysLeft !== undefined ? { daysLeft } : {}),
          expired: daysLeft !== undefined && daysLeft <= 0,
          message:
            daysLeft === undefined
              ? '未返回有效期'
              : daysLeft <= 0
                ? 'cookie 已过期，必须人工重新扫码'
                : `剩余 ${daysLeft.toFixed(0)} 天`,
        };
      } else {
        out.account = { uid: '', expired: true, message: '没有已登录账号' };
      }
    } catch {
      /* 健康面板缺一项不影响其它 */
    }

    const disk = this.cleaner.canStartNewTask();
    if (disk.disk) {
      out.disk = {
        freeGB: disk.disk.freeGB,
        totalGB: disk.disk.totalGB,
        thresholdGB: cfg.cleanup.diskFloorGB,
        low: disk.disk.low,
      };
    }

    try {
      const { errorCountLastHours } = await import('./errors.ts');
      out.errorsLast24h = errorCountLastHours(24);
    } catch {
      /* ignore */
    }
    void ERRORS_PATH;
    return out;
  }

  /** 一键自检（UI 的「一键自检」按钮） */
  async runSelfCheck(): Promise<Awaited<ReturnType<Orchestrator['selfCheck']>>> {
    return this.selfCheck();
  }
}

/* ============================================================================
 * 辅助
 * ========================================================================== */

/** 应用版本（写入错误报告，便于对照） */
export const APP_VERSION = '1.0.0';

/** 带阶段信息的错误，用于精确定位失败阶段 */
export class StageError extends Error {
  override readonly name = 'StageError';
  readonly stage: string;
  readonly type: ErrorType;
  constructor(stage: string, message: string, type: ErrorType = 'internal') {
    super(message);
    this.stage = stage;
    this.type = type;
  }
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

/** 累加成本（ASR 是估算值，LLM 是实际 usage） */
export function addCost(base: TaskCost, delta: Partial<TaskCost>): TaskCost {
  return {
    asrEstimate: Number(((base.asrEstimate ?? 0) + (delta.asrEstimate ?? 0)).toFixed(4)),
    asrAudioSeconds: (base.asrAudioSeconds ?? 0) + (delta.asrAudioSeconds ?? 0),
    llmActual: Number(((base.llmActual ?? 0) + (delta.llmActual ?? 0)).toFixed(6)),
    llmPromptTokens: (base.llmPromptTokens ?? 0) + (delta.llmPromptTokens ?? 0),
    llmCompletionTokens: (base.llmCompletionTokens ?? 0) + (delta.llmCompletionTokens ?? 0),
    llmCalls: (base.llmCalls ?? 0) + (delta.llmCalls ?? 0),
    updatedAt: nowIso(),
  };
}
/** 由一组录制段生成稳定的任务 id */
export function makeTaskId(records: Array<{ id: string; recordStartTime?: number }>): string {
  const first = records[0];
  if (first) {
    const stamp = first.recordStartTime ? new Date(first.recordStartTime) : new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}-${first.id.slice(0, 8)}`;
  }
  return `task-${Date.now()}`;
}

/** 供 selfCheck 读取 /config 的扁平化（本地实现，避免与 cleanup 的循环依赖） */
function flattenForCheck(v: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v === null || typeof v !== 'object') {
    if (prefix) out[prefix] = v;
    return out;
  }
  if (Array.isArray(v)) {
    if (prefix) out[prefix] = `[${v.length} 项]`;
    return out;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) Object.assign(out, flattenForCheck(val, key));
    else out[key] = Array.isArray(val) ? `[${val.length} 项]` : val;
  }
  return out;
}

/**
 * 导入任务的「身份」：id / 标题 / 来源标记。抽成纯函数是为了能直接测。
 *
 * 实测缺陷（用户报的，2026-09-23）：自动导入与手动导入走的是同一个 `importLocal()`，
 * 而它把 `manual: true`、id 前缀 `manual-`、标题后缀「（手动导入）」**全部写死**，
 * 于是目录轮询自动捡起来的任务在界面上也显示「手动导入」——
 * 界面上看到「1 候选　手动导入」，根本分不清这是自己点的还是它自己捡的。
 */
export function importIdentity(
  input: { videoPath: string; title?: string; source?: 'manual' | 'auto' },
  nowIsoText: string,
): { id: string; title: string; manual: boolean; importSource: 'manual' | 'auto' } {
  const isAuto = input.source === 'auto';
  const base = path.basename(input.videoPath, path.extname(input.videoPath));
  /* 「（手动导入）」后缀只给手动导入加：它同时是人工介入的标记，
     而 `cleanLiveTitle` 会在生成投稿标题时把它去掉（`publish.ts`）。
     自动导入的标题就用录制标题本身 —— 那本来就是"正常一场录播"。 */
  const title = input.title?.trim() || (isAuto ? base : `${base}（手动导入）`);
  const stamp = nowIsoText.replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return {
    id: `${isAuto ? 'auto' : 'manual'}-${stamp}-${rand}`,
    title,
    manual: !isAuto,
    importSource: isAuto ? 'auto' : 'manual',
  };
}

/**
 * 续传匹配用的日期文本（`YYYY-MM-DD`）。
 *
 * 为什么不能直接用 `taskDateText`：目录轮询导入的任务标题常常就是**纯直播标题**（例如「哈喽」），
 * 既没有日期、也没有 `liveStartTime` —— 此时 `taskDateText` 会退化成"**调用时刻**的日期"。
 * 跨零点之后渲染出来的日期就差了整整一天，标题**永远匹配不上**：
 * 实测 2026-09-24 00:0x，biliLive-tools 的稿件是 `丙主播哈喽2026.09.23`，
 * 我们却渲染成 `丙主播哈喽2026.09.24`。
 *
 * 录制文件名（`2026-09-23 21-53-17-917 哈喽.flv`）里的日期是录制器写的，真实且稳定 —— 优先用它。
 */
export function resumeDateText(task: TaskRecord): string {
  const fromTitle = extractTitleDate(task.title);
  if (fromTitle) return fromTitle;
  const src = task.source?.rawFiles?.[0] ?? task.source?.segments?.[0]?.path;
  const fromFile = src ? extractTitleDate(path.basename(src)) : undefined;
  if (fromFile) return fromFile;
  return taskDateText(task); // 最后兜底：开播时间，再不然就是今天
}

/** 把任务列表整理成 UI 需要的摘要（供 server.ts 复用） */
export function summarizeTask(  t: TaskRecord,
  ctx: { stageIndex: number; statusText: string; when: string },
): {
  id: string;
  title: string;
  roomId: string;
  when: string;
  durationSec: number;
  status: TaskStatus;
  statusText: string;
  stageIndex: number;
  clipCount: number;
  publishedCount: number;
  selectedCount: number;
  degradedCount: number;
  manual: boolean;
  /** 任务来源：录制触发 / 目录自动导入 / 人工导入。界面按它显示标记 */
  importSource: 'recording' | 'auto' | 'manual';
  /** 正在等 biliLive-tools 投出完整版稿件（默认规则下的正常中间态，界面要显示出来） */
  publishWaiting: boolean;
  hasError: boolean;
  createdAt: string;
} {
  const clips = t.clips ?? [];
  return {
    id: t.id,
    title: t.title,
    roomId: t.roomId,
    when: ctx.when,
    durationSec: t.source.totalDuration,
    status: t.status,
    statusText: ctx.statusText,
    stageIndex: ctx.stageIndex,
    clipCount: clips.length,
    // 有 bvid 就说明服务器侧已存在该稿件 —— 即便状态因重启/回退停在 SUBMITTED，
    // 列表上的「已发布」也不该显示成 0
    publishedCount: clips.filter((c) => c.status === 'PUBLISHED' || (c.status === 'SUBMITTED' && Boolean(c.bvid))).length,
    selectedCount: clips.filter((c) => c.selected).length,
    degradedCount: clips.filter((c) => c.degraded).length,
    manual: Boolean(t.manual),
    /* 旧台账只有 `manual` 布尔值：那时自动导入也被写成 true，
       所以无法回溯区分 —— 退化为 `manual` 即可（界面会显示「手动导入」）。
       新任务都带 importSource，自动导入的就是「自动导入」。 */
    importSource: t.importSource ?? (t.manual ? 'manual' : 'recording'),
    publishWaiting: t.publishWait !== undefined,
    hasError: Boolean(t.error),
    createdAt: t.createdAt,
  };
}

/** 追加一条通用流水（供 UI 显示事件日志） */
export function appendTaskLog(dir: string, entry: { at: string; level: string; msg: string; data?: unknown }): void {
  try {
    appendJsonl(path.join(dir, 'events.jsonl'), entry);
  } catch {
    /* 日志写失败不影响业务 */
  }
}

/** 素材保留说明（UI 右栏「素材」区） */
export function retentionNote(task: TaskRecord, cfg: AppConfig): { keep: boolean; note: string } {
  const v = judgeDeletability(task, cfg, { now: Date.now() });
  if (v.fullVideoDeletable) return { keep: false, note: `素材可清理：${v.fullVideoReason}` };
  return { keep: true, note: `源素材保留中：${v.fullVideoReason}` };
}
