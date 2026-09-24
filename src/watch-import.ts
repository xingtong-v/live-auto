/**
 * 目录轮询自动导入 —— 「打开切片助手就开始干活」。
 *
 * ## 为什么不用现成的触发轮询
 *
 * 现有的 `trigger.ts` 轮的是 biliLive-tools 的 `recent-clips` 接口：它依赖
 * ①录制历史库里**有**这场录制、②房间号对得上。实测 `recent-clips` 会返回空数组
 * （房间在 biliLive-tools 的 streamer 表里没记录时就是这样），而**盘上的文件是真实存在的**。
 * 所以「盯目录」是更可靠的第二条腿：文件在那里，就一定能被发现。
 *
 * ## 三个必须做对的判定（每一个都对应一类真实事故）
 *
 * 1. **文件是不是写完了**：录制工具边录边写，读到一半的 flv 时长/尾帧都是错的。
 *    判定用两层：`possiblyRecording`（biliLive-tools 口径：最近 120 秒内被写过）
 *    + 本模块自己的「体积连续两轮不变且稳定超过 stableSec」。
 * 2. **会不会重复导入**：同一场录制会产出多个文件（原始 flv、`-弹幕版.mp4`、`_PART000.flv`）。
 *    `listRecordingsDetailed` 已按「场」归并并优先给原始未烧弹幕的那个，且会用台账标出
 *    `importedBy` —— 这里再叠加一份状态文件，用于记录"导入失败要退避"。
 * 3. **导入失败不能每轮都重试**：失败的文件在退避窗口内跳过（默认 10 分钟），
 *    否则一个坏文件会每 60 秒刷一条错误、并且反复建任务。
 *
 * ## 导入之后发生什么
 *
 * 调 `daemon.importLocal()` → 建任务 → 入队。队列是**串行**的（`drainQueue` 一次只跑一个
 * 任务），所以一次发现多个录播不会并发转写、不会撞额度。
 */

import path from 'node:path';
import { listRecordingsDetailed, type RecordingCandidate } from './recordings.ts';
import type { AppConfig } from './config.ts';
import type { Ledger } from './ledger.ts';
import type { BiliLiveClient } from './api.ts';
import { log as globalLog, type Logger } from './logger.ts';
import { DATA_DIR, ensureDir, nowIso, readJson, writeJsonAtomic } from './util.ts';

const STATE_PATH = path.join(DATA_DIR, 'watch-import-state.json');
/** 导入失败后的退避（毫秒）：一个坏文件不该每轮都刷屏、也不该反复建任务 */
const FAIL_BACKOFF_MS = 10 * 60_000;

export interface WatchImportState {
  version: 1;
  lastScanAt?: string;
  /** videoPath → 导入记录（状态文件只做审计与退避，判重主要靠台账的 importedBy） */
  imported: Record<string, { at: string; taskId: string; title: string }>;
  /**
   * 首次启用时目录里**已经存在**的录播（基线），不会被自动导入。
   *
   * 为什么必须有这个：用户的录播目录里通常已经积压了几十场（实测 28 个文件 / 32 GB）。
   * 第一次开启轮询时若把它们全导入，等于一次性排 28 场转写（≈¥238）并把队列占满好几天 ——
   * 而用户的期望是"以后新录的自动跑"。所以首次扫描只登记基线、不导入。
   * 想导入历史积压：界面手动导入，或把 `import.watch.importExisting` 设成 true。
   */
  baseline?: Record<string, { at: string; sizeBytes: number }>;
  /**
   * 首次扫描时刻（ISO）。**基线判定的真正依据**。
   *
   * 为什么不只靠 `baseline` 快照：基线的可信度取决于**当次扫描范围是否正确**。
   * 实测事故（2026-09-23）：`extraDirs` 没被读 → 轮询那一路扫描根全空、只拿到录制历史，
   * 于是基线只登记了 13 个历史条目；修好扫描范围后，盘上**所有**历史文件（09-13、09-20 的）
   * 都变成"没见过的候选"，被当成新录播导入了 —— 正是 `importExisting=false` 想避免的事。
   * 所以再加一条与扫描范围无关的判据：**mtime 早于首次扫描时刻的文件，一律按"启用前已存在"处理**。
   */
  startedAt?: string;
  /**
   * 上一次实际扫到的目录集合（小写、排序后拼接）。
   *
   * 范围一变，基线就等于作废（新范围里的老文件会被误判成新文件），
   * 所以此时**重新登记基线**并明确告知，而不是把整个新目录的积压导一遍。
   */
  lastScanRoots?: string;
}

export interface WatchImportOutcome {
  videoPath: string;
  fileName: string;
  title: string;
  sizeMB: number;
  danmaPath?: string;
  /** 成功建任务后的任务 id */
  taskId?: string;
  /** 未导入时的原因（给人看的） */
  skipped?: string;
}

export interface WatchImporterDeps {
  config: AppConfig;
  ledger: Ledger;
  logger?: Logger;
  /** biliLive-tools 客户端（用于识别录制目录与弹幕映射；不传只扫盘） */
  client?: BiliLiveClient;
  /** 导入实现。生产是 `daemon.importLocal`；测试注入假的 */
  importFn: (input: { videoPath: string; danmaPath?: string; title?: string }) => Promise<{ id: string }>;
  /** 扫描实现。默认 `listRecordingsDetailed`；测试注入假的 */
  listFn?: typeof listRecordingsDetailed;
  /** 便于测试注入时钟 */
  now?: () => number;
  /**
   * 状态文件路径。默认 `data/watch-import-state.json`。
   *
   * 必须可注入：单元测试若写真实状态文件，就会污染生产状态、并且测试之间互相影响 ——
   * 这个坑在回收站那一次已经踩过（测试往真实 `data/trash` 里塞了条目）。
   */
  statePath?: string;
}

export interface WatchImporterStatus {
  enabled: boolean;
  dirs: string[];
  intervalSec: number;
  lastScanAt?: string;
  lastScanAgoSec?: number;
  importedTotal: number;
  /** 最近一轮的每个候选与结论 */
  lastOutcomes: WatchImportOutcome[];
  lastError?: string;
  /** 正在扫描 */
  scanning: boolean;
  /** 退避中的文件数 */
  backoffCount: number;
}

export class WatchImporter {
  private readonly cfg: AppConfig;
  private readonly ledger: Ledger;
  private readonly log: Logger;
  private readonly client: BiliLiveClient | undefined;
  private readonly importFn: WatchImporterDeps['importFn'];
  private readonly list: typeof listRecordingsDetailed;
  private readonly now: () => number;
  private readonly statePath: string;

  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private state: WatchImportState;
  /** videoPath → 该体积第一次被看到的时刻（稳定性判定） */
  private readonly sizeSince = new Map<string, { size: number; since: number }>();
  /** videoPath → 允许再次尝试导入的时刻 */
  private readonly backoffUntil = new Map<string, number>();
  private lastOutcomes: WatchImportOutcome[] = [];
  private lastError: string | undefined;

  constructor(deps: WatchImporterDeps) {
    this.cfg = deps.config;
    this.ledger = deps.ledger;
    this.log = deps.logger ?? globalLog;
    this.client = deps.client;
    this.importFn = deps.importFn;
    this.list = deps.listFn ?? listRecordingsDetailed;
    this.now = deps.now ?? (() => Date.now());
    this.statePath = deps.statePath ?? STATE_PATH;
    this.state = this.loadState();
  }

  private loadState(): WatchImportState {
    try {
      const s = readJson<WatchImportState>(this.statePath);
      if (s && s.version === 1 && s.imported) return s;
    } catch {
      /* 状态文件坏了不影响功能：判重的主路径是台账 */
    }
    return { version: 1, imported: {} };
  }

  private saveState(): void {
    try {
      ensureDir(path.dirname(this.statePath));
      writeJsonAtomic(this.statePath, this.state);
    } catch (e) {
      this.log.warn('轮询导入状态保存失败（不影响本轮结果）', { data: { error: (e as Error).message } });
    }
  }

  /** 本轮是否启用 */
  private get watch(): AppConfig['import']['watch'] {
    return this.cfg.import.watch;
  }

  start(): void {
    const w = this.watch;
    if (!w.enabled) {
      this.log.info(
        `目录轮询导入已关闭（config.json 的 import.watch.enabled=false）。` +
          `打开它就能"把录播丢进目录后全自动跑完"`,
      );
      return;
    }
    if (w.dirs.length === 0) {
      this.log.warn('目录轮询导入已启用但没有配置目录（import.watch.dirs 为空），本轮不扫');
      return;
    }
    this.log.info(
      `目录轮询导入已启用：每 ${w.intervalSec} 秒扫一次 ${w.dirs.join(' , ')}（递归 ${w.maxDepth} 层，` +
        `小于 ${w.minSizeMB}MB 忽略，${w.requireDanmaku ? '必须' : '不要求'}有同名弹幕）`,
    );
    // 启动先扫一轮：用户"打开助手"的期望就是立刻开始，而不是等一个轮询周期
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (!this.watch.enabled) return;
    const ms = Math.max(10, this.watch.intervalSec) * 1000;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const outcomes = await this.scanOnce();
      const imported = outcomes.filter((o) => o.taskId);
      if (imported.length === 0) {
        // 没东西可导入时保持安静（每 60 秒一条"无事发生"会把日志淹掉）
        const blocked = outcomes.filter((o) => o.skipped);
        if (blocked.length > 0) {
          this.log.debug(`目录轮询：${blocked.length} 个候选被跳过（${blocked.map((b) => `${b.fileName}:${b.skipped}`).join('；')}）`);
        }
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log.warn('目录轮询导入异常（下一轮继续）', { data: { error: this.lastError } });
    } finally {
      this.schedule();
    }
  }

  /**
   * 扫一轮并导入该导入的。返回每个候选的结论（含被跳过的原因），供界面/CLI 展示。
   * 抽成公开方法是为了测试能直接调，也为了界面上「立即扫描」按钮能复用。
   */
  async scanOnce(): Promise<WatchImportOutcome[]> {
    if (this.scanning) return this.lastOutcomes;
    const w = this.watch;
    const now = this.now();
    const out: WatchImportOutcome[] = [];
    this.scanning = true;
    try {
      const res = await this.list(this.cfg, {
        ...(this.client ? { client: this.client } : {}),
        ledger: this.ledger,
        extraDirs: w.dirs,
        // 只扫用户指定的目录：轮询每 60 秒跑一次，不能顺手把别处的几百个文件也 ffprobe 一遍
        includeFallbackDirs: false,
        maxDepth: w.maxDepth,
        minSizeMB: w.minSizeMB,
        // 轮询阶段不做 ffprobe/ASR 预检（导入时还会再探一次），否则每轮都要读大文件头
        probe: false,
        logger: this.log,
      });
      const candidates = res.candidates ?? [];

      /* 「轮询启用时刻」：基线判定的依据。老状态文件里没有这个字段时，
         用最早一条基线的时间兜底（那是首次扫描写下的），再不行用上次扫描时间。 */
      const startedAtMs = this.resolveStartedAtMs(now);
      if (this.state.startedAt === undefined) {
        this.state.startedAt = new Date(startedAtMs).toISOString();
      }

      /* 扫描范围变了（例如刚把 extraDirs 修好、或用户改了 import.watch.dirs）：
         旧基线对新范围无效，**重新登记基线**，把整个新范围当成"启用前就已存在"。
         否则修一次扫描范围就会把用户几十场历史积压全导一遍。 */
      const rootsKey = [...res.scanRoots].map((r) => r.toLowerCase()).sort().join('|');
      const rootsChanged = this.state.lastScanRoots !== undefined && this.state.lastScanRoots !== rootsKey;
      if (rootsChanged && !this.watch.importExisting) {
        const baseline = (this.state.baseline ??= {});
        const at = nowIso();
        let added = 0;
        for (const c of candidates) {
          if (!baseline[c.videoPath]) {
            baseline[c.videoPath] = { at, sizeBytes: c.sizeBytes };
            added++;
          }
        }
        this.state.lastScanRoots = rootsKey;
        this.state.lastScanAt = at;
        this.saveState();
        this.log.warn(
          `目录轮询：扫描范围发生变化（新范围：${res.scanRoots.join(' | ') || '(空)'}）—— ` +
            `已把范围内的 ${candidates.length} 个录播（其中新登记 ${added} 个）当作「启用前已存在」，` +
            `本轮不导入。之后再出现的新录播才会自动跑；要处理现有积压请在界面手动导入。`,
          { data: { scanRoots: res.scanRoots, added } },
        );
        this.lastOutcomes = candidates.map((c) => ({
          videoPath: c.videoPath,
          fileName: c.fileName,
          title: c.title,
          sizeMB: Math.round((c.sizeBytes / 1024 ** 2) * 10) / 10,
          skipped: '扫描范围变化后重新登记基线（不自动导入现有文件）',
        }));
        return this.lastOutcomes;
      }
      this.state.lastScanRoots = rootsKey;

      /* 首次扫描（从未有过任何一轮记录）→ 只登记基线，不导入。
         否则用户一打开助手，几十场历史录播会被一次性排进队列（实测目录里积压 28 个 / 32 GB）。 */
      const firstEverScan = this.state.lastScanAt === undefined;
      if (firstEverScan && !this.watch.importExisting) {
        const baseline = (this.state.baseline ??= {});
        const at = nowIso();
        let added = 0;
        for (const c of candidates) {
          if (!baseline[c.videoPath]) {
            baseline[c.videoPath] = { at, sizeBytes: c.sizeBytes };
            added++;
          }
        }
        this.state.lastScanAt = at;
        this.state.lastScanRoots = rootsKey;
        this.saveState();
        this.log.info(
          `目录轮询首次扫描：目录里已有 ${candidates.length} 个录播（新登记 ${added} 个）—— ` +
            `按 import.watch.importExisting=false，**这些历史文件不会自动导入**，` +
            `之后新出现的录播才会自动跑。要处理历史积压请在界面上手动导入。`,
          { data: { dirs: w.dirs, existing: candidates.length, added } },
        );
        this.lastOutcomes = candidates.map((c) => ({
          videoPath: c.videoPath,
          fileName: c.fileName,
          title: c.title,
          sizeMB: Math.round((c.sizeBytes / 1024 ** 2) * 10) / 10,
          skipped: '首次启用时已存在（历史积压不自动导入）',
        }));
        return this.lastOutcomes;
      }

      for (const c of candidates) {
        const base: WatchImportOutcome = {
          videoPath: c.videoPath,
          fileName: c.fileName,
          title: c.title,
          sizeMB: Math.round((c.sizeBytes / 1024 ** 2) * 10) / 10,
          ...(c.danmaPath ? { danmaPath: c.danmaPath } : {}),
        };

        const skip = (reason: string): void => {
          out.push({ ...base, skipped: reason });
        };

        // ①b 首次启用时的历史积压：登记为基线，不自动导入
        const base0 = this.state.baseline?.[c.videoPath];
        if (!this.watch.importExisting && base0 && base0.sizeBytes === c.sizeBytes) {
          skip('首次启用时已存在（历史积压不会自动导入；需要就跑界面手动导入）');
          continue;
        }
        /* ①c 与扫描范围无关的第二道闸：**修改时间早于「轮询启用时刻」的文件一律算历史积压**。
           只靠 ①b 的基线快照不够 —— 基线是「某一次扫描」建立的，那次扫描如果扫漏了
           （实测：extraDirs 没被读 → 扫描根全空 → 基线里只有录制历史那 13 条），
           修好扫描范围后盘上的老文件就会被当成新录播导进去。mtime 不依赖扫描是否正确。 */
        const mtimeMs = Math.max(0, ...c.variants.map((v) => v.mtimeMs));
        if (!this.watch.importExisting && mtimeMs > 0 && mtimeMs < startedAtMs) {
          (this.state.baseline ??= {})[c.videoPath] = { at: nowIso(), sizeBytes: c.sizeBytes };
          skip(
            `轮询启用之前就已存在（文件修改时间 ${new Date(mtimeMs).toLocaleString()} 早于启用时刻 ` +
              `${new Date(startedAtMs).toLocaleString()}；历史积压不自动导入）`,
          );
          continue;
        }
        // ① 已导入过 —— 两道依据，**缺一不可**
        //
        // 依据 A：台账里的 `importedBy`（跨重启有效，最权威）
        // 依据 B：本模块状态文件里的 `imported` 记录
        //
        // 为什么要有 B（实测事故，2026-09-24 凌晨）：
        //   用户删掉了刚导入的任务（那场他不想要），6 分钟后**同一个文件又被导入了一遍** ——
        //   因为判重只认台账，而删任务会把台账里的记录一起删掉，`importedBy` 变成 undefined，
        //   于是文件被当成全新的。代价是白跑一次 ASR + LLM（实测那段 9.6 分钟素材约 ¥0.13+¥0.03），
        //   一小时的录播就是 ¥0.8+，而且是**在用户明确表达"我不要这个"之后**又花的钱。
        //
        // 语义定调：**自动流程不应该跟用户的手动删除对着干**。
        //   用户手动删掉一个自动导入的任务，意图是"这个不要了"；
        //   状态文件里留一条"已导入过"的记录，足以避免自动流程把同一个文件再捡回来。
        //   真想要这一场，界面上「导入录播」是显式动作，不受此限制（那条路不经过本模块）。
        //
        // B 只在"状态文件里确实记过这个文件"时生效，所以不会误拦从未导入过的新文件。
        if (c.importedBy) {
          skip(`已导入过（任务 ${c.importedBy.taskId}，状态 ${c.importedBy.status}）`);
          continue;
        }
        {
          const prev = this.state.imported[c.videoPath];
          if (prev?.taskId) {
            skip(
              `已导入过（任务 ${prev.taskId}，于 ${new Date(prev.at).toLocaleString()}）—— ` +
                `该任务已从台账删除；如确实要重跑，请用界面「导入录播」手动导入`,
            );
            continue;
          }
        }
        // ② 文件本身不可用
        if (!c.usable) {
          skip(`文件不可用：${c.brokenReason ?? '未知原因'}`);
          continue;
        }
        // ③ 可能还在写：录制工具边录边写，导入半场素材会得到错误的时长与残缺的转写
        if (c.possiblyRecording) {
          skip('文件仍在写入（录制可能未结束）');
          continue;
        }
        // ④ 稳定性：体积连续两轮一样才算写完
        if (!this.isStable(c, now)) {
          skip(`首次发现，等下一轮确认写完（稳定 ${w.stableSec} 秒）`);
          continue;
        }
        // ⑤ 弹幕：按配置决定是否强制
        if (w.requireDanmaku && !c.danmaPath) {
          skip('没找到同名弹幕文件（.xml/.ass），而配置要求必须有弹幕');
          continue;
        }
        // ⑥ 失败退避
        const until = this.backoffUntil.get(c.videoPath) ?? 0;
        if (now < until) {
          skip(`上次导入失败，退避中（还有 ${Math.ceil((until - now) / 1000)} 秒）`);
          continue;
        }

        // ⑥.5 跳过 biliLive-tools 的**压制产物**（`-弹幕版` / `-纯享版` / `-danmaku`）
        //
        // 为什么要跳过（用户确认的分工，2026-09-24）：
        //   biliLive-tools 的职责是「压制弹幕版 + 纯享版 + 把这两个分P 投到同一个稿件」；
        //   切片助手的职责是「从**原始录制**里选片、切片、把切片追加进那个稿件」。
        //   压制产物是对方的中间产物，切片助手再去处理它有两个坏处：
        //     ① 白花钱：同一段素材被转写两次（实测那个 3 分钟的 `-弹幕版.mp4` 又跑了
        //        ¥0.046 ASR + ¥0.032 LLM，而它的原始 `.ts` 已经处理过一遍了）；
        //     ② 可能重复投稿：同一场素材产出两条切片，标题不同、指纹不同，去重拦不住。
        //   画面上还已经烧了一层弹幕，拿它当源再烧字幕虽然不会双层弹幕，
        //   但切片成品与「原始录制」那条线并不一致。
        //
        // 安全性：只在**同场确实存在原始录制**时才跳过。若盘上只剩压制产物
        //   （原始文件被「用完即删」清掉了），仍然允许导入 —— 有源总比没源好。
        if (c.hasDanmakuInPicture) {
          /* 配对要**从严**：只认「同目录 + 同分段号」的未烧弹幕候选。
             宁可漏配（退回旧行为：允许导入压制产物），也不要误配 ——
             误配会把本该导入的原始录制一起跳过，那才是真的丢素材。
             注意 `partIndex === undefined` 时两侧都必须 undefined（同一场同一个文件，
             只是各自被解析出的分段号都是空），不做"空配任意"的宽松匹配。 */
          const rawSibling = candidates.find(
            (o) =>
              o.videoPath !== c.videoPath &&
              !o.hasDanmakuInPicture &&
              o.partIndex === c.partIndex &&
              path.dirname(o.videoPath) === path.dirname(c.videoPath),
          );
          if (rawSibling) {
            this.log.info(
              `目录轮询：跳过压制产物 ${c.fileName} —— 它是 biliLive-tools 的产物（画布已烧弹幕）；` +
                `完整版/纯享版由它负责投，切片助手只处理原始录制 ${rawSibling.fileName}`,
              { data: { videoPath: c.videoPath, rawSibling: rawSibling.videoPath } },
            );
            skip('压制产物（-弹幕版/-纯享版）：完整版由 biliLive-tools 投，切片助手只处理原始录制');
            continue;
          }
          this.log.warn(
            `目录轮询：${c.fileName} 是压制产物，但**同目录下没有找到未烧弹幕的原始录制** —— 仍按源文件导入` +
              `（画面已烧弹幕，本场不会另叠弹幕 ASS）`,
            { data: { videoPath: c.videoPath } },
          );
        }

        // ⑦ 导入
        try {
          const r = await this.importFn({
            videoPath: c.videoPath,
            ...(c.danmaPath ? { danmaPath: c.danmaPath } : {}),
            title: c.title,
          });
          this.state.imported[c.videoPath] = { at: nowIso(), taskId: r.id, title: c.title };
          this.saveState();
          const danmaNote = c.danmaPath ? `弹幕 ${path.basename(c.danmaPath)}` : '无弹幕';
          this.log.info(`目录轮询：自动导入 ${c.fileName}（${base.sizeMB}MB，${danmaNote}）→ 任务 ${r.id}`, {
            data: { videoPath: c.videoPath, taskId: r.id, danmaPath: c.danmaPath },
          });
          out.push({ ...base, taskId: r.id });
        } catch (e) {
          const msg = (e as Error).message;
          this.backoffUntil.set(c.videoPath, now + FAIL_BACKOFF_MS);
          this.log.warn(`目录轮询：导入失败（${Math.round(FAIL_BACKOFF_MS / 60000)} 分钟内不再重试）：${c.fileName} —— ${msg}`, {
            data: { videoPath: c.videoPath },
          });
          skip(`导入失败：${msg}`);
        }
      }
      this.lastOutcomes = out;
      this.lastError = undefined;
      this.state.lastScanAt = nowIso();
      this.state.lastScanRoots = rootsKey;
      this.saveState();
      return out;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * 「轮询启用时刻」（毫秒）—— 判断文件算不算历史积压的依据。
   *
   * 优先用状态里记下的 `startedAt`；老状态文件没有这个字段时退回到**最早一条基线的时间**
   * （那是首次扫描写下的，等价于启用时刻）；再退到上次扫描时间；都没有就是现在。
   * ⚠️ 不能拿 `lastScanAt` 单独当依据 —— 它每轮都被刷新，等于"一分钟前"，
   * 会把所有历史文件都判成新文件（那正是本次事故的另一半）。
   */
  private resolveStartedAtMs(now: number): number {
    const explicit = this.state.startedAt ? Date.parse(this.state.startedAt) : Number.NaN;
    if (Number.isFinite(explicit)) return explicit;
    const baseTimes = Object.values(this.state.baseline ?? {})
      .map((b) => Date.parse(b.at))
      .filter((t) => Number.isFinite(t));
    if (baseTimes.length > 0) return Math.min(...baseTimes);
    const last = this.state.lastScanAt ? Date.parse(this.state.lastScanAt) : Number.NaN;
    return Number.isFinite(last) ? last : now;
  }

  /** 体积连续两轮不变、且稳定时间达到 stableSec 才算写完 */
  private isStable(c: RecordingCandidate, now: number): boolean {
    const prev = this.sizeSince.get(c.videoPath);
    if (!prev || prev.size !== c.sizeBytes) {
      this.sizeSince.set(c.videoPath, { size: c.sizeBytes, since: now });
      return false;
    }
    return now - prev.since >= this.watch.stableSec * 1000;
  }

  status(): WatchImporterStatus {
    const last = this.state.lastScanAt ? Date.parse(this.state.lastScanAt) : undefined;
    return {
      enabled: this.watch.enabled,
      dirs: this.watch.dirs,
      intervalSec: this.watch.intervalSec,
      ...(this.state.lastScanAt ? { lastScanAt: this.state.lastScanAt } : {}),
      ...(last ? { lastScanAgoSec: Math.round((this.now() - last) / 1000) } : {}),
      importedTotal: Object.keys(this.state.imported).length,
      lastOutcomes: this.lastOutcomes,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      scanning: this.scanning,
      backoffCount: [...this.backoffUntil.values()].filter((t) => t > this.now()).length,
    };
  }
}
