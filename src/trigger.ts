/**
 * WP2 —— 触发与信号聚合（任务书 §4.1 / §8 WP2）。
 *
 * 这个模块承担两类职责：
 *   A. **触发**：感知「录制完成」，并且必须叠加**下播确认**，防止断流误触发（硬约束 #19）。
 *   B. **webhook**：接收录制器事件（可选路径）。注意方向 —— `/webhook/*` 在
 *      biliLive-tools 侧是**入站接口**，自研服务不能从那里「订阅」事件（陷阱 #26）。
 *      正确做法是让录制器把本服务当成**第二个 webhook 目标**；只有在录制器只支持
 *      单目标时才由本服务转发，且必须：匹配端点的录制器类型（陷阱 #27）、
 *      **原样即时转发、不缓冲不合并**、**先落盘再转发**、**落盘失败不得阻塞转发**（硬约束 #18）。
 *
 * 触发可靠性设计（为什么这么绕）：
 *   - `recent-clips` 只返回 5 条，跨场次会漏 → 必须用 `record-history/list` 分页补漏与周期对账（陷阱 #18）。
 *   - 直播中途断流时，第一段也会满足「有新 id + recordEndTime 有值 + 文件大小稳定」，
 *     若立刻触发就会对半场素材转写+分析，恢复后又触发一次 → 重复计费 + 产出半场总结（陷阱 #29）。
 *   - 因此判定条件叠加三层：① 静态条件（文件稳定）② **同一场次（live_id）的所有录制段都已关闭**
 *     ③ **持续非直播 ≥ 续传窗口**（或无法查询开播状态时，record_end_time 已过去 ≥ 窗口）。
 */
import path from 'node:path';
import { BiliLiveClient } from './api.ts';
import type { AppConfig } from './config.ts';
import type { NormalizedRecord, RawRecordLike } from './media.ts';
import { normalizeRecord } from './media.ts';
import {
  appendJsonl,
  ensureDir,
  exists,
  fileSize,
  fmtHuman,
  nowIso,
  readJson,
  readJsonl,
  sleep,
  writeJsonAtomic,
} from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';
import { roomIdsFromConfig } from './recordings.ts';

/* ============================================================================
 * 类型
 * ========================================================================== */

/** 触发判定结果 */
export interface TriggerDecision {
  /** 是否判定本场录制已结束 */
  fire: boolean;
  /** 人读原因（日志与 UI 都要用，避免「为什么没触发」变成猜谜） */
  reason: string;
  /** 判定所依据的录制段（同一场次的全部段，按时间排序） */
  records: NormalizedRecord[];
  /** 直播场次 id */
  liveId?: string;
  /** 本场全局总时长（各段时长之和；未知时为 undefined） */
  totalDurationSec?: number;
  /** 诊断细节，写入日志便于复盘 */
  diagnostics: Record<string, unknown>;
}

/** 采集到的证据快照（用于「两次采样不再变化」的比较） */
interface RecordSnapshot {
  id: string;
  size: number;
  at: number;
  /** 采样次数 */
  samples: number;
}

/** 采样快照的「陈旧」阈值：录制结束已超过该时长时，文件大小必然稳定，无需两次采样 */
const STALE_END_MS = 5 * 60 * 1000;

/** 持久化的触发状态（重启后不重复触发、也不丢失待观察项） */
export interface TriggerState {
  version: 1;
  /** 已处理过的录制段 id（永远不重复触发） */
  processedRecordIds: string[];
  /** 已触发过的场次 live_id（同一场次只触发一次） */
  firedLiveIds: string[];
  /** 文件大小采样快照：recordId → 快照 */
  snapshots: Record<string, RecordSnapshot>;
  /** live_id → 首次观察到「疑似结束」的时刻（毫秒）；用于持续非直播≥窗口的判定 */
  firstOfflineSeen: Record<string, number>;
  /** live_id → 最近一次确认「仍在直播」的时刻（毫秒） */
  lastLiveSeen: Record<string, number>;
  lastReconcileAt?: number;
  /**
   * 最近一次成功轮询 `recent-clips` 的时刻（毫秒）。
   *
   * 为什么单独记它：从前只记 `lastReconcileAt`，于是"轮询到底有没有在工作"看不出来 ——
   * 实测排查"新录播为什么没自动进来"时，状态文件里只有对账时间，
   * 完全无法区分「轮询在跑但没东西」和「轮询压根没跑」。
   */
  lastPollAt?: number;
  /**
   * 自动处理的时间基线（毫秒）：**早于它结束的录制不自动处理**。
   *
   * 首次启动时取当前时刻，于是"只从现在开始自动跑新的"成为默认行为 ——
   * 否则一改房间配置，回补范围内的历史录播会被一次性全部认领，
   * 每场都要花 ASR 的钱（实测本机有 37 条历史、多场已完结）。
   * 需要补跑历史时，由 CLI 的 `import`/`video` 显式导入，或手动调小这个值。
   */
  baselineMs?: number;
  updatedAt: string;
}

export interface TriggerDeps {
  client: BiliLiveClient;
  config: AppConfig;
  logger?: Logger;
  /** 状态文件路径 */
  statePath?: string;
  /** 判定触发后的回调（由编排层写台账 → 创建任务） */
  onTrigger: (decision: TriggerDecision) => Promise<void>;
  /**
   * 已处理的录制 id 查询器（由 ledger 提供，避免重复处理）。
   * 传 undefined 时只用本模块自身的 state 记录。
   */
  processedIdsProvider?: () => Set<string>;
  /** 当前开播状态查询器；返回 undefined 表示无法查询（此时退化为时间窗口判定） */
  liveStatusProvider?: (roomId: string) => Promise<boolean | undefined>;
  /**
   * 自动处理基线（毫秒）：早于它结束的录制不自动处理。
   *
   * - 不传：沿用状态文件里已记录的基线；从未记录过则取**当前时刻**并落盘
   *   （这是生产默认 —— 只从现在开始自动跑新录的，不回头补跑历史）；
   * - 传 0：**关闭基线限制**（离线端到端测试要用它 —— mock 造的录制时间早于当前时刻，
   *   若建立基线，对账会把它们全部过滤掉，测试就永远触发不了）；
   * - 传具体时刻：只用它（不落盘）。
   */
  baselineMs?: number;
}

/* ============================================================================
 * 轮询触发器
 * ========================================================================== */

export class Trigger {
  private client: BiliLiveClient;
  private cfg: AppConfig;
  private logger: Logger;
  private statePath: string;
  private state: TriggerState;
  private deps: TriggerDeps;
  private running = false;
  private timer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  /** 判定成功后短暂抑制，避免同一条记录在状态落盘前被重复处理 */
  private inFlight = new Set<string>();

  constructor(deps: TriggerDeps) {
    this.deps = deps;
    this.client = deps.client;
    this.cfg = deps.config;
    this.logger = (deps.logger ?? globalLog).child({ mod: 'trigger' });
    this.statePath = deps.statePath ?? path.join(this.cfg.runtime.dataDir, 'trigger-state.json');
    this.state = this.loadState();
    // 基线：显式传入优先（测试传 0 即关闭限制）；否则沿用已记录的；从未记录过才建立。
    // ⚠️ 已存在时**绝不能重置** —— 否则每次重启都把起点往后推，新录播永远等不到。
    if (deps.baselineMs !== undefined) {
      this.state.baselineMs = deps.baselineMs;
    } else if (this.state.baselineMs === undefined) {
      this.state.baselineMs = Date.now();
      this.logger.info(
        `已建立自动处理基线：早于 ${new Date(this.state.baselineMs).toLocaleString('zh-CN')} 结束的录制不会被自动处理` +
          `（只自动跑新录的；要补跑历史请用「导入录播」手动导入）`,
      );
      this.saveState();
    }
  }

  private loadState(): TriggerState {
    const empty: TriggerState = {
      version: 1,
      processedRecordIds: [],
      firedLiveIds: [],
      snapshots: {},
      firstOfflineSeen: {},
      lastLiveSeen: {},
      updatedAt: nowIso(),
    };
    if (!exists(this.statePath)) return empty;
    try {
      const s = readJson<TriggerState>(this.statePath);
      return {
        ...empty,
        ...s,
        processedRecordIds: s.processedRecordIds ?? [],
        firedLiveIds: s.firedLiveIds ?? [],
        snapshots: s.snapshots ?? {},
        firstOfflineSeen: s.firstOfflineSeen ?? {},
        lastLiveSeen: s.lastLiveSeen ?? {},
      };
    } catch {
      this.logger.warn('触发状态文件损坏，已重置（可能重复处理最近一场，台账幂等会兜住）', { data: { path: this.statePath } });
      return empty;
    }
  }

  private saveState(): void {
    try {
      // 列表类字段做长度上限，避免无限增长
      this.state.processedRecordIds = this.state.processedRecordIds.slice(-2000);
      this.state.firedLiveIds = this.state.firedLiveIds.slice(-500);
      this.state.updatedAt = nowIso();
      writeJsonAtomic(this.statePath, this.state);
    } catch (e) {
      this.logger.warn('触发状态落盘失败（不影响本次判定）', { data: { error: (e as Error).message } });
    }
  }

  /** 已处理的录制 id 集合（合并自有状态与外部台账） */
  private processedIds(): Set<string> {
    const set = new Set(this.state.processedRecordIds);
    const ext = this.deps.processedIdsProvider?.();
    if (ext) for (const id of ext) set.add(id);
    return set;
  }

  /**
   * 要轮询的房间号列表。
   *
   * ⚠️ 为什么不能只轮询 `cfg.room.roomId`：本项目配置里只有**一个** `room.roomId`，
   *   而 biliLive-tools 可以同时录多个主播。实测踩到的真实故障：
   *   配置写的是 `12345678`（乙主播），实际在录的是 `23456789`（甲主播）——
   *   于是触发每 60 秒都在问一个没有新文件的房间，新录播永远不进来，
   *   而"导入录播"清单（`recordings.ts` 会读 biliLive-tools 配置里所有房间）
   *   却能看到它们。两处范围不一致，表现为「清单里看得见、却永远不自动跑」。
   *
   * 房间来源：配置里的那个（保底）+ biliLive-tools 配置里所有被录制的房间。
   * 读不到对方配置时退化为只轮询配置里的房间，并给出可执行提示。
   */
  private async resolveRoomIds(): Promise<string[]> {
    const ids = new Set<string>([this.cfg.room.roomId].filter(Boolean));
    try {
      const raw = await this.client.getConfig();
      for (const id of roomIdsFromConfig(raw)) ids.add(id);
      this.roomIdsCache = [...ids];
      this.roomIdsWarned = false;
    } catch (e) {
      if (!this.roomIdsWarned) {
        this.roomIdsWarned = true;
        this.logger.warn(
          `读取 biliLive-tools 配置失败，本轮只轮询配置里的房间 ${this.cfg.room.roomId}。` +
            `若还有别的主播在录，他们的新录播不会自动进来 —— 检查 biliLive-tools 是否在线`,
          { data: { error: (e as Error).message } },
        );
      }
    }
    return this.roomIdsCache.length ? this.roomIdsCache : [...ids];
  }

  private roomIdsCache: string[] = [];
  private roomIdsWarned = false;

  /* ------------------------------------------------------------------------
   * 单次轮询
   * ---------------------------------------------------------------------- */

  /** 一次轮询：拉取最近录制并做判定。返回本次的判定结果（可能为空数组） */
  async pollOnce(): Promise<TriggerDecision[]> {
    if (!this.cfg.room.roomId) {
      this.logger.warn('未配置 room.roomId，无法轮询录制历史');
      return [];
    }

    const decisions: TriggerDecision[] = [];

    // 主路径：recent-clips（最多 5 条），**逐个房间拉取后合并**。
    // 失败时不抛，交给下一轮。
    const roomIds = await this.resolveRoomIds();
    const recent: RawRecordLike[] = [];
    const seenRecordIds = new Set<string>();
    let okRooms = 0;
    for (const roomId of roomIds) {
      try {
        const clips = (await this.client.recentClips(roomId, this.cfg.room.platform, this.logger)) as unknown as RawRecordLike[];
        okRooms++;
        for (const c of clips) {
          const id = String((c as { id?: unknown }).id ?? '');
          if (id && seenRecordIds.has(id)) continue; // 同一条录制可能被两个房间视图返回
          if (id) seenRecordIds.add(id);
          recent.push(c);
        }
      } catch (e) {
        this.logger.warn(`拉取 recent-clips 失败（房间 ${roomId}），跳过该房间`, { data: { error: (e as Error).message } });
      }
    }
    if (okRooms === 0) {
      this.logger.warn('所有房间的 recent-clips 都拉取失败，本轮跳过');
      return [];
    }

    if (recent.length === 0) {
      // 陷阱 #1 / #2：空数组不报错。首轮给出可执行提示，避免长时间静默无效
      if (!this.warnedEmpty) {
        this.warnedEmpty = true;
        this.logger.warn(
          `recent-clips 返回空数组（已查房间 ${roomIds.join(', ')}）。两种已知原因且都不会报错：` +
            `① platform 必须为 "Bilibili"（当前 "${this.cfg.room.platform}"）；` +
            `② 这些直播间在 biliLive-tools 的 streamer 表中没有记录（即从未录制过）。若确实从未录制，这是正常的。`,
          { data: { roomIds, platform: this.cfg.room.platform } },
        );
      }
      this.state.lastPollAt = Date.now();
      this.saveState();
      return [];
    }
    this.warnedEmpty = false;
    this.state.lastPollAt = Date.now();
    this.saveState();

    const records = recent.map(normalizeRecord);
    // 按 live_id 聚合（断流多段属于同一场次）
    const groups = groupByLiveId(records);

    for (const [liveId, group] of groups) {
      // 基线之前就结束的录制不自动处理（"只从现在开始跑新的"）
      const base = this.state.baselineMs;
      if (base !== undefined) {
        const ends = group.map((g) => g.recordEndTime ?? 0).filter((t) => t > 0);
        if (ends.length && Math.max(...ends) < base) continue;
      }
      const decision = await this.evaluateGroup(liveId, group);
      if (!decision.fire) continue;
      if (this.inFlight.has(liveId)) continue;
      this.inFlight.add(liveId);
      try {
        await this.deps.onTrigger(decision);
        // 只有回调成功才标记为已处理
        for (const r of decision.records) {
          if (!this.state.processedRecordIds.includes(r.id)) this.state.processedRecordIds.push(r.id);
        }
        if (liveId && !this.state.firedLiveIds.includes(liveId)) this.state.firedLiveIds.push(liveId);
        this.state.firstOfflineSeen[liveId] = 0;
        this.saveState();
        decisions.push(decision);
      } catch (e) {
        this.logger.error('触发回调失败，将在下一轮重试', e, { data: { liveId } });
      } finally {
        this.inFlight.delete(liveId);
      }
    }
    return decisions;
  }

  private warnedEmpty = false;

  /**
   * 对「同一场次的一组录制段」做结束判定。
   *
   * 三层条件（缺一不可）：
   *   ① 静态：每个段都有 recordEndTime、文件存在且大小 > 0、大小与上次采样一致
   *   ② 聚合：同 live_id 的所有段都满足 ①（避免对半场素材动手）
   *   ③ 下播：持续非直播 ≥ offlineConfirmSec；无法查询开播状态时，
   *      要求「最近一段 record_end_time 距今 ≥ offlineConfirmSec」
   */
  private async evaluateGroup(liveId: string | undefined, group: NormalizedRecord[]): Promise<TriggerDecision> {
    const diagnostics: Record<string, unknown> = {};
    const key = liveId ?? group.map((g) => g.id).join('+');
    const processed = this.processedIds();
    const unprocessed = group.filter((g) => !processed.has(g.id));

    if (unprocessed.length === 0) {
      return {
        fire: false,
        reason: '该场次的所有录制段都已处理过',
        records: group,
        ...(liveId ? { liveId } : {}),
        diagnostics: { reason: 'already-processed' },
      };
    }

    // ---- 条件 ①：逐段静态条件 ----
    let running = false;
    for (const rec of group) {
      const prev = this.state.snapshots[rec.id];
      const size = rec.videoPath ? fileSize(rec.videoPath) : 0;
      const fileExists = rec.videoPath ? exists(rec.videoPath) : false;

      // 采样更新（每轮都做，这样「两次采样」才有意义）
      this.state.snapshots[rec.id] = {
        id: rec.id,
        size,
        at: Date.now(),
        samples: (prev?.samples ?? 0) + 1,
      };

      const static1 = await this.checkComplete(rec, prev?.size);
      if (!static1.complete) {
        running = true;
        diagnostics[rec.id] = {
          stage: 'static',
          reason: static1.reason,
          size,
          prevSize: prev?.size,
          fileExists,
          recordEndTime: rec.recordEndTime,
        };
        return {
          fire: false,
          reason: `仍有录制段未结束：${static1.reason}`,
          records: group,
          ...(liveId ? { liveId } : {}),
          diagnostics,
        };
      }
      diagnostics[rec.id] = { stage: 'static-ok', size, samples: this.state.snapshots[rec.id]!.samples };
    }
    void running;

    // ---- 条件 ③：下播确认 ----
    const lastEndMs = Math.max(...group.map((g) => g.recordEndTime ?? 0));
    const sinceEndSec = lastEndMs > 0 ? (Date.now() - lastEndMs) / 1000 : 0;
    const windowSec = this.cfg.room.offlineConfirmSec;
    diagnostics['sinceEndSec'] = Math.round(sinceEndSec);
    diagnostics['offlineConfirmSec'] = windowSec;

    let live: boolean | undefined;
    if (this.deps.liveStatusProvider) {
      try {
        live = await this.deps.liveStatusProvider(this.cfg.room.roomId);
      } catch {
        live = undefined;
      }
    } else {
      try {
        const r = await this.client.liveStatus(this.cfg.room.roomId);
        live = r?.live;
      } catch {
        live = undefined;
      }
    }
    diagnostics['liveStatus'] = live === undefined ? 'unknown' : live ? 'live' : 'offline';

    if (live === true) {
      // 确认仍在直播 → 明确不触发（这是断流场景的关键判据）
      this.state.lastLiveSeen[key] = Date.now();
      this.state.firstOfflineSeen[key] = 0;
      this.saveState();
      return {
        fire: false,
        reason: '直播间仍在直播中（断流后已恢复，等待本场真正结束）',
        records: group,
        ...(liveId ? { liveId } : {}),
        diagnostics,
      };
    }

    if (live === false) {
      // 确认非直播 → 需要「持续」非直播 ≥ 窗口
      const first = this.state.firstOfflineSeen[key] ?? 0;
      if (!first) {
        this.state.firstOfflineSeen[key] = Date.now();
        this.saveState();
        return {
          fire: false,
          reason: `首次观察到非直播，开始计时（需持续 ${fmtHuman(windowSec)} 才判定本场结束）`,
          records: group,
          ...(liveId ? { liveId } : {}),
          diagnostics,
        };
      }
      const offlineSec = (Date.now() - first) / 1000;
      diagnostics['offlineSec'] = Math.round(offlineSec);
      if (offlineSec < windowSec) {
        return {
          fire: false,
          reason: `非直播仅持续 ${Math.round(offlineSec)} 秒，未达续传窗口 ${fmtHuman(windowSec)}（防止断流误触发）`,
          records: group,
          ...(liveId ? { liveId } : {}),
          diagnostics,
        };
      }
    } else {
      // 无法查询开播状态 → 退化为时间窗口判定
      if (sinceEndSec < windowSec) {
        return {
          fire: false,
          reason: `无法查询开播状态，退化为时间窗口判定：距最后一段结束仅 ${Math.round(sinceEndSec)} 秒，未达 ${fmtHuman(windowSec)}`,
          records: group,
          ...(liveId ? { liveId } : {}),
          diagnostics,
        };
      }
    }

    // ---- 全部满足 ----
    const totalDurationSec = group.reduce((a, g) => a + (g.videoDurationSec ?? 0), 0) || undefined;
    const sorted = [...group].sort((a, b) => (a.recordStartTime ?? 0) - (b.recordStartTime ?? 0));
    return {
      fire: true,
      reason:
        `本场录制结束确认：${sorted.length} 个录制段全部关闭，` +
        (live === false
          ? `且已持续非直播 ${Math.round((Date.now() - (this.state.firstOfflineSeen[key] ?? Date.now())) / 1000)} 秒（≥ ${Math.round(windowSec)} 秒窗口）`
          : `且距最后一段结束已 ${Math.round(sinceEndSec)} 秒（≥ ${Math.round(windowSec)} 秒窗口，开播状态不可查）`),
      records: sorted,
      ...(liveId ? { liveId } : {}),
      ...(totalDurationSec ? { totalDurationSec } : {}),
      diagnostics,
    };
  }

  /**
   * 静态完成条件：recordEndTime 有值 + 文件存在且 > 0 + 文件大小已稳定。
   *
   * 关于「两次采样」的一个必要放宽：
   *   录制刚结束时文件可能仍在写入（ffmpeg 收尾、弹幕文件落盘），因此需要两次采样确认大小不变。
   *   但如果 `recordEndTime` 已经过去很久（超过 `STALE_END_MS`），文件不可能还在写 ——
   *   此时**不必**等第二次采样。否则服务重启后做启动补漏时，对几天前的历史录制
   *   也要白等一个轮询周期才触发（reconcile 每轮只跑一次，等于延迟一小时）。
   */
  private async checkComplete(rec: NormalizedRecord, prevSize?: number): Promise<{ complete: boolean; reason: string }> {
    if (!rec.recordEndTime) return { complete: false, reason: `recordEndTime 尚未出现（录制进行中）` };
    if (!rec.videoPath) return { complete: false, reason: `录制记录没有 video_file 字段` };
    if (!exists(rec.videoPath)) return { complete: false, reason: `视频文件不存在：${path.basename(rec.videoPath)}` };
    const size = fileSize(rec.videoPath);
    const minSize = 1024 * 1024; // 1MB 以下视为还在写入
    if (size < minSize) return { complete: false, reason: `文件仅 ${size} 字节，疑似仍在写入` };

    const sinceEndMs = Date.now() - rec.recordEndTime;
    if (sinceEndMs >= STALE_END_MS) {
      return {
        complete: true,
        reason: `录制已于 ${Math.round(sinceEndMs / 60000)} 分钟前结束（≥ ${STALE_END_MS / 60000} 分钟），文件大小视为已稳定（${size} 字节），无需等待第二次采样`,
      };
    }
    if (prevSize === undefined) {
      return { complete: false, reason: `录制刚结束（${Math.round(sinceEndMs / 1000)} 秒前），首次采样（大小 ${size} 字节），等待下一次采样确认不再变化` };
    }
    if (prevSize !== size) return { complete: false, reason: `文件大小仍在变化（${prevSize} → ${size}），录制尚未结束` };
    return { complete: true, reason: `文件大小连续两次采样不变（${size} 字节）` };
  }

  /* ------------------------------------------------------------------------
   * 启动补漏与周期对账
   * ---------------------------------------------------------------------- */

  /**
   * 启动补漏：用 `record-history/list` 分页对齐，找出「未处理且已完成」的录制。
   *
   * ⚠️ 为什么必须做：`recent-clips` 最多返回 5 条，服务重启期间跨过的场次会全部漏掉（陷阱 #18）。
   * ⚠️ 陷阱 #32：`startTime` / `endTime` 过滤参数单位是**毫秒**。
   */
  async reconcile(opts: { sinceMs?: number; maxPages?: number; lookbackHours?: number } = {}): Promise<TriggerDecision[]> {
    const pageSize = Math.max(10, Math.min(200, this.cfg.recorder.recordHistoryPageSize));
    const maxPages = opts.maxPages ?? 10;
    // 时间窗口取「默认回溯窗口」与「自动处理基线」中**较晚**的那个：
    // 基线之后才需要自动处理，多扫的历史既没用又容易误认领（每场都要花 ASR 的钱）。
    const defaultSince = Date.now() - (opts.lookbackHours ?? 72) * 3600_000;
    const since = opts.sinceMs ?? Math.max(defaultSince, this.state.baselineMs ?? 0);
    const processed = this.processedIds();
    const decisions: TriggerDecision[] = [];
    const collected: NormalizedRecord[] = [];

    // ★ 逐个房间对账（同 pollOnce 的理由：项目配置只有一个 roomId，而对方可能录多个主播）
    const roomIds = await this.resolveRoomIds();
    for (const roomId of roomIds) {
      for (let page = 1; page <= maxPages; page++) {
        let list: RawRecordLike[];
        try {
          const res = await this.client.recordHistoryList({
            roomId,
            platform: this.cfg.room.platform,
            page,
            pageSize,
            // ★ 毫秒（陷阱 #32）
            startTime: since,
          });
          list = res.list as unknown as RawRecordLike[];
          if (list.length === 0) break;
          this.logger.debug(`补漏对账：房间 ${roomId} 第 ${page} 页 ${list.length} 条（total=${res.total}）`);
          if (page === 1 && res.total > maxPages * pageSize) {
            this.logger.warn(
              `房间 ${roomId} 的录制历史共 ${res.total} 条，本次只扫描前 ${maxPages * pageSize} 条。` +
                `如需回补更早场次，请调大 reconcile 的 maxPages 或指定 sinceMs`,
            );
          }
        } catch (e) {
          this.logger.warn(`补漏对账失败（房间 ${roomId} 第 ${page} 页）`, { data: { error: (e as Error).message } });
          break;
        }
        for (const raw of list) collected.push(normalizeRecord(raw));
        if (list.length < pageSize) break;
      }
    }

    this.state.lastReconcileAt = Date.now();

    // 只保留「已完成 + 未处理 + 在基线之后结束」的段，并按 live_id 聚合
    const baseline = this.state.baselineMs ?? 0;
    const candidates = collected.filter((r) => {
      if (processed.has(r.id)) return false;
      if (!r.recordEndTime) return false;
      if (r.recordEndTime < baseline) return false; // 基线之前的历史不自动补跑
      if (!r.videoPath || !exists(r.videoPath)) return false;
      return true;
    });

    if (candidates.length === 0) {
      this.logger.debug(`补漏对账完成：${collected.length} 条历史中无未处理的已完成录制`);
      this.saveState();
      return [];
    }

    // 按 live_id 聚合后逐组判定（复用同一套下播确认逻辑）
    const groups = groupByLiveId(candidates);
    for (const [liveId, group] of groups) {
      const decision = await this.evaluateGroup(liveId, group);
      if (!decision.fire) {
        this.logger.info(`补漏发现待处理场次 ${liveId ?? group[0]?.id}，但未通过结束判定：${decision.reason}`);
        continue;
      }
      if (this.inFlight.has(liveId ?? group[0]!.id)) continue;
      this.inFlight.add(liveId ?? group[0]!.id);
      try {
        await this.deps.onTrigger(decision);
        for (const r of decision.records) if (!this.state.processedRecordIds.includes(r.id)) this.state.processedRecordIds.push(r.id);
        if (liveId && !this.state.firedLiveIds.includes(liveId)) this.state.firedLiveIds.push(liveId);
        this.saveState();
        decisions.push(decision);
      } catch (e) {
        this.logger.error('补漏触发回调失败', e, { data: { liveId } });
      } finally {
        this.inFlight.delete(liveId ?? group[0]!.id);
      }
    }
    this.saveState();
    this.logger.info(
      `补漏对账完成：扫描 ${collected.length} 条，候选 ${candidates.length} 段 / ${groups.size} 场，触发 ${decisions.length} 场`,
    );
    return decisions;
  }

  /* ------------------------------------------------------------------------
   * 常驻循环
   * ---------------------------------------------------------------------- */

  /** 启动常驻轮询。**轮询在任何情况下都保留** —— 它是可靠兜底（§4.1）。 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // 房间范围要如实打出来：从前只看配置里的一个房间，导致"实际在录的那个房间没被监控"
    // 这种故障完全看不出来（日志里只会说"检查 recent-clips"，不说检查谁）。
    const roomIds = await this.resolveRoomIds();
    const base = this.state.baselineMs;
    this.logger.info(
      `触发轮询启动：每 ${this.cfg.room.pollIntervalSec} 秒检查一次 recent-clips；` +
        `每 ${this.cfg.room.reconcileIntervalMin} 分钟用 record-history/list 对账一次；` +
        `下播确认窗口 ${Math.round(this.cfg.room.offlineConfirmSec / 60)} 分钟`,
    );
    this.logger.info(
      `监控房间（${roomIds.length} 个）：${roomIds.join('、')}` +
        (base !== undefined ? `；只自动处理 ${new Date(base).toLocaleString('zh-CN')} 之后结束的录制` : ''),
    );

    // 启动先补漏（陷阱 #18）
    try {
      await this.reconcile({});
    } catch (e) {
      this.logger.error('启动补漏失败（不影响后续轮询）', e);
    }

    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        const decisions = await this.pollOnce();
        for (const d of decisions) this.logger.info(`已触发本场处理：${d.reason}`, { data: { liveId: d.liveId } });
      } catch (e) {
        this.logger.error('轮询异常（下一轮继续）', e);
      }
      if (this.running) {
        this.timer = setTimeout(() => void tick(), this.cfg.room.pollIntervalSec * 1000);
        this.timer.unref?.();
      }
    };
    void tick();

    const reconcileTick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        const ds = await this.reconcile({});
        for (const d of ds) this.logger.info(`周期对账触发本场处理：${d.reason}`, { data: { liveId: d.liveId } });
      } catch (e) {
        this.logger.error('周期对账异常', e);
      }
      if (this.running) {
        this.reconcileTimer = setTimeout(() => void reconcileTick(), this.cfg.room.reconcileIntervalMin * 60_000);
        this.reconcileTimer.unref?.();
      }
    };
    this.reconcileTimer = setTimeout(() => void reconcileTick(), this.cfg.room.reconcileIntervalMin * 60_000);
    this.reconcileTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.saveState();
    this.logger.info('触发轮询已停止');
  }

  /** 「立即检查」按钮用：跑一次轮询 + 对账 */
  async checkNow(): Promise<{ polled: TriggerDecision[]; reconciled: TriggerDecision[] }> {
    const polled = await this.pollOnce();
    const reconciled = await this.reconcile({ lookbackHours: 24 });
    return { polled, reconciled };
  }

  /** 供健康面板展示 */
  stateSnapshot(): {
    processedCount: number;
    firedCount: number;
    lastReconcileAt?: number;
    pending: Array<{ liveId: string; since: string; reason: string }>;
  } {
    const pending: Array<{ liveId: string; since: string; reason: string }> = [];
    for (const [liveId, ts] of Object.entries(this.state.firstOfflineSeen)) {
      if (ts > 0) pending.push({ liveId, since: new Date(ts).toISOString(), reason: '已观察非直播，计时中' });
    }
    return {
      processedCount: this.state.processedRecordIds.length,
      firedCount: this.state.firedLiveIds.length,
      ...(this.state.lastReconcileAt ? { lastReconcileAt: this.state.lastReconcileAt } : {}),
      pending,
    };
  }
}

/* ============================================================================
 * webhook 接收与转发（§4.1）
 * ========================================================================== */

/** 录制器事件（各录制器的字段语义不同，这里只做「原样转发」的搬运工） */
export interface RecorderEvent {
  receivedAt: string;
  /** 录制器类型对应的端点，例如 /webhook/bililiverecorder */
  path: string;
  /** 原始请求体（**不做任何字段转换**，原样转发才不需要担心映射错误） */
  body: unknown;
  /** 请求头中的关键信息（仅保留转发所需的） */
  headers: Record<string, string>;
}

export interface WebhookForwardResult {
  /** 是否已落盘（落盘失败不影响转发） */
  persisted: boolean;
  /** 是否已转发成功 */
  forwarded: boolean;
  /** 转发到哪里 */
  target?: string;
  error?: string;
  durationMs: number;
}

/**
 * 录制器事件接收与转发。
 *
 * 硬约束 #18 的三条要求逐条落实：
 *   1. **原样即时**：不缓冲、不合并 —— 缓冲会破坏 biliLive-tools 的断播续传时序
 *      （它依赖「FileClosed 之后在限定间隔内出现 FileOpening」）。
 *   2. **先落盘再转发**：重启后可从 jsonl 补投，否则重启窗口内的事件永久丢失。
 *   3. **落盘失败不得阻塞转发**：磁盘满 / IO 拥塞时优先保证转发（转发是业务本身，落盘只是记录）。
 */
export class WebhookRelay {
  private logPath: string;
  private logger: Logger;
  private forwardBase: string;
  private enabled: boolean;
  private forwardPath: string;

  constructor(opts: { client: BiliLiveClient; config: AppConfig; logger?: Logger; logPath?: string; enabled?: boolean }) {
    this.logPath = opts.logPath ?? opts.config.recorder.eventLogPath;
    this.logger = (opts.logger ?? globalLog).child({ mod: 'webhook' });
    // 转发目标就是 biliLive-tools 自己 —— 这里直接用它自己的地址
    this.forwardBase = opts.client.baseUrl;
    this.forwardPath = opts.config.recorder.forwardTo;
    // 只有「录制器与本服务分离、且录制器只支持单 webhook 目标」时才由本服务转发。
    // 首选方案是让录制器直接配置两个目标（零转发、零单点故障）。
    this.enabled = opts.enabled ?? opts.config.recorder.webhookTargets.length > 0;
  }

  /** 端点必须匹配录制器类型（陷阱 #27：发错端点等于没转发） */
  static endpointFor(recorderType: AppConfig['recorder']['type']): string {
    const map: Record<string, string> = {
      bililiverecorder: '/webhook/bililiverecorder',
      blrec: '/webhook/blrec',
      ddtv: '/webhook/ddtv',
      oneliverec: '/webhook/oneliverec',
      custom: '/webhook/custom',
    };
    return map[recorderType] ?? '/webhook/custom';
  }

  /**
   * 校验转发端点是否与录制器类型匹配。
   *
   * ⚠️ 陷阱 #27：biliLive-tools 是**按录制器分端点**的，各自有独立解析器。
   * 录播姬的原始事件发给 `/webhook/custom` 会解析失败或丢字段，
   * 断播续传的 `FileOpening` / `FileClosed` 判断直接失效。
   * 因此「原样转发」的前提是**端点选对了才不需要做任何字段转换**。
   */
  validateEndpoint(cfg: AppConfig): { ok: boolean; expected: string; configured: string; note: string } {
    const expected = WebhookRelay.endpointFor(cfg.recorder.type);
    const configured = cfg.recorder.forwardTo;
    const ok = expected === configured;
    return {
      ok,
      expected,
      configured,
      note: ok
        ? `转发端点 ${configured} 与录制器类型 ${cfg.recorder.type} 匹配 ✓`
        : `转发端点配置为 ${configured}，但录制器类型 ${cfg.recorder.type} 应使用 ${expected} —— 发错端点等于没转发，字段对不上会解析失败（陷阱 #27）`,
    };
  }

  /** 接收一个录制器事件：先落盘，再原样转发 */
  async handle(event: RecorderEvent): Promise<WebhookForwardResult> {
    const started = Date.now();
    let persisted = false;

    // ① 先落盘（同步写，保证重启后可补投）
    try {
      ensureDir(path.dirname(this.logPath));
      appendJsonl(this.logPath, { ...event, forwarded: false });
      persisted = true;
    } catch (e) {
      // ② 落盘失败**不得阻塞转发**：宁可丢一条日志记录，也不能让 biliLive-tools 收不到事件
      this.logger.error('webhook 事件落盘失败 —— 按硬约束 #18 继续转发，不阻塞业务', e);
    }

    // ③ 原样即时转发（不缓冲、不合并）
    if (!this.enabled) {
      return { persisted, forwarded: false, durationMs: Date.now() - started };
    }
    return this.forward(event, persisted, started);
  }

  private async forward(event: RecorderEvent, persisted: boolean, started: number): Promise<WebhookForwardResult> {
    const target = `${this.forwardBase}${this.forwardPath}`;
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...event.headers },
        body: JSON.stringify(event.body),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn(`webhook 转发被拒：HTTP ${res.status} ${text.slice(0, 200)}`, { data: { target } });
      }
      // 转发成功后在流水里补一条标记，补投时据此跳过
      if (res.ok) {
        try {
          appendJsonl(this.logPath, { ...event, forwarded: true, forwardedAt: nowIso() });
        } catch {
          /* 标记写不进去最多导致一次重复补投，biliLive-tools 侧会幂等处理 */
        }
      }
      return {
        persisted,
        forwarded: res.ok,
        target,
        durationMs: Date.now() - started,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      };
    } catch (e) {
      const error = (e as Error).message;
      // 转发失败：事件已落盘，由补投机制兜底
      this.logger.error(`webhook 转发失败（事件已落盘，将补投）：${error}`, undefined, { data: { target } });
      return { persisted, forwarded: false, target, error, durationMs: Date.now() - started };
    }
  }

  /**
   * 补投未成功转发的事件（服务重启后调用）。
   *
   * 顺序敏感：录播姬的断播续传依赖「FileClosed 之后在限定间隔内出现 FileOpening」，
   * 因此补投必须**保持原有顺序、且串行**，不能并发。
   */
  async replayPending(): Promise<{ total: number; replayed: number; failed: number }> {
    if (!exists(this.logPath)) return { total: 0, replayed: 0, failed: 0 };
    const events = readJsonl<RecorderEvent & { forwarded?: boolean }>(this.logPath);
    // 按「事件身份」判断最终是否转发过：同一事件可能既有一条 forwarded:false 又有一条 forwarded:true
    const keyOf = (e: RecorderEvent): string => `${e.receivedAt}|${JSON.stringify(e.body ?? {})}`;
    const forwardedKeys = new Set(events.filter((e) => e.forwarded === true).map(keyOf));
    const pendingEvents: RecorderEvent[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      if (e.forwarded === true) continue;
      const k = keyOf(e);
      if (forwardedKeys.has(k) || seen.has(k)) continue;
      seen.add(k);
      pendingEvents.push(e);
    }
    if (pendingEvents.length === 0) return { total: 0, replayed: 0, failed: 0 };

    let replayed = 0;
    let failed = 0;
    // 只补投最近 200 条，避免积压过多时把对方打爆
    for (const e of pendingEvents.slice(-200)) {
      const r = await this.forward({ ...e, receivedAt: e.receivedAt ?? nowIso() }, true, Date.now());
      if (r.forwarded) replayed++;
      else failed++;
      await sleep(50); // 保持顺序，不要并发补投（时序敏感）
    }
    this.logger.info(`webhook 补投完成：待补 ${pendingEvents.length}，成功 ${replayed}，失败 ${failed}`);
    return { total: pendingEvents.length, replayed, failed };
  }
}

/* ============================================================================
 * 工具
 * ========================================================================== */

/**
 * 按直播场次聚合录制段。
 *
 * 为什么要聚合：录制引擎按 duration 分段，一次直播会产生多条 record；
 * 断流续传还会产生多段。同一 `live_id` 的段属于同一场，**必须等全部关闭再处理**，
 * 否则会对半场素材转写+分析，恢复后又重复触发（陷阱 #29）。
 */
export function groupByLiveId(records: NormalizedRecord[]): Map<string, NormalizedRecord[]> {
  const map = new Map<string, NormalizedRecord[]>();
  for (const r of records) {
    // live_id 可能缺失；缺失时用「同一天 + 同一房间」退化分组，避免把无关场次混在一起
    const raw = r.raw as Record<string, unknown>;
    const lid =
      (typeof raw['live_id'] === 'string' || typeof raw['live_id'] === 'number' ? String(raw['live_id']) : undefined) ??
      (r.liveStartTime ? `live-start-${r.liveStartTime}` : `record-${r.id}`);
    const arr = map.get(lid);
    if (arr) arr.push(r);
    else map.set(lid, [r]);
  }
  // 每组内部按录制起点排序
  for (const arr of map.values()) arr.sort((a, b) => (a.recordStartTime ?? 0) - (b.recordStartTime ?? 0));
  return map;
}

/** 供离线验证：给定一组录制记录，直接算出「是否已结束」而不占用真实状态文件 */
export function evaluateOffline(
  group: NormalizedRecord[],
  opts: { now?: number; offlineConfirmSec: number; liveStatus?: boolean },
): { fire: boolean; reason: string } {
  const now = opts.now ?? Date.now();
  for (const rec of group) {
    if (!rec.recordEndTime) return { fire: false, reason: `段 ${rec.id} 尚未结束（无 recordEndTime）` };
    if (!rec.videoPath || !exists(rec.videoPath)) return { fire: false, reason: `段 ${rec.id} 的视频文件不存在` };
  }
  if (opts.liveStatus === true) return { fire: false, reason: '直播间仍在直播中' };
  const lastEnd = Math.max(...group.map((g) => g.recordEndTime ?? 0));
  const sinceEnd = (now - lastEnd) / 1000;
  if (sinceEnd < opts.offlineConfirmSec) {
    return {
      fire: false,
      reason: `距最后一段结束仅 ${Math.round(sinceEnd)} 秒，未达续传窗口 ${Math.round(opts.offlineConfirmSec)} 秒`,
    };
  }
  return { fire: true, reason: `${group.length} 段全部关闭，且距最后一段结束 ${Math.round(sinceEnd)} 秒 ≥ 窗口` };
}
