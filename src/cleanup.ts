/**
 * WP6 —— 数据生命周期与磁盘守卫（任务书 §7）。
 *
 * 这一节是**硬性设计约束**，不是建议：
 *
 *  1. 必须关闭 biliLive-tools 的「上传后删除」（`afterUploadDeletAction = none`）。
 *     它的「过审」判定是轮询稿件状态（间隔 600 秒、最多 24 小时），而转写需要 20–40 分钟，
 *     会与切片读文件形成竞态 —— 故障表现还特别分散：转写报错、切片报「输入文件不存在」，
 *     看起来像两个不相关的 bug。而且它的删除走内部引用计数，外部程序**无法为文件加锁**。
 *     → **删除权完全收归本服务**。
 *
 *  2. 判断「能不能删」的依据是**五个需要源文件的环节是否都已完成**，而不是「B站是否过审」：
 *     转写 / 切片 / 补切重切 / 完整版重传 / 封面抽帧（二期）。
 *
 *  3. 分层清理：
 *     - 原始分段文件（flv/ts）：**压制产物校验通过 且 转写完成**后才删（转写直接读它们）
 *     - 压制后的 mp4：**全部切片上传完成 + 完整版上传完成**后，再等缓冲期（默认 7 天）才删
 *
 *  4. 磁盘守卫：剩余空间低于阈值（默认 50GB）时**停止新任务并告警**。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TaskRecord } from './types.ts';
import type { AppConfig } from './config.ts';
import { resolveDataPath } from './config.ts';
import type { Ledger } from './ledger.ts';
import type { Alerter } from './alert.ts';
import { ensureDir, exists, fileSize, fmtBytes, nowIso } from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';

/* ============================================================================
 * 磁盘
 * ========================================================================== */

export interface DiskInfo {
  /** 检查的路径 */
  path: string;
  freeBytes: number;
  totalBytes: number;
  freeGB: number;
  totalGB: number;
  /** 是否低于阈值 */
  low: boolean;
}

/**
 * 查询磁盘剩余空间。
 * 用 `fs.statfs`（Node 18.15+ 稳定支持），失败时返回 undefined 而不是抛异常 ——
 * 磁盘查询失败不该让清理逻辑整个停摆。
 */
export function diskInfo(dir: string): DiskInfo | undefined {
  try {
    const st = fs.statfsSync(dir);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const totalBytes = Number(st.blocks) * Number(st.bsize);
    return {
      path: dir,
      freeBytes,
      totalBytes,
      freeGB: freeBytes / 1024 ** 3,
      totalGB: totalBytes / 1024 ** 3,
      low: false,
    };
  } catch {
    return undefined;
  }
}

/** 检查磁盘并使 low 标记生效 */
export function checkDisk(dir: string, floorGB: number): DiskInfo | undefined {
  const info = diskInfo(dir);
  if (!info) return undefined;
  info.low = info.freeGB < floorGB;
  return info;
}

/* ============================================================================
 * 可删除性判定
 * ========================================================================== */

export interface DeletabilityVerdict {
  /** 原始分段（flv/ts）能否删除 */
  rawDeletable: boolean;
  rawReason: string;
  /** 压制产物 mp4 能否删除 */
  fullVideoDeletable: boolean;
  fullVideoReason: string;
  /** 依据的台账事实，便于 UI 解释「为什么还不能删」 */
  facts: Record<string, unknown>;
}

/**
 * 判定某场素材是否可删。
 *
 * ⚠️ 关键点：**绝不依赖 biliLive-tools 的开关，也不依赖「B站是否过审」**。
 *    依据是台账里的环节完成状态。
 */
export function judgeDeletability(
  task: TaskRecord,
  cfg: AppConfig,
  opts: { now?: number; slicesPublished?: boolean },
): DeletabilityVerdict {
  const now = opts.now ?? Date.now();
  const facts: Record<string, unknown> = {};

  /* ---- 原始分段 ---- */
  // §7.3：**压制产物校验通过 且 转写完成**后才删 —— 转写直接读这些文件，删早了会打断进行中的转写
  const transcribeDone =
    ['TRANSCRIBED', 'ANALYZED', 'CLIPPED', 'PUBLISHED', 'ARCHIVED'].includes(task.status) ||
    ['TRANSCRIBED', 'ANALYZED', 'CLIPPED', 'PUBLISHED'].includes(task.stage);
  const fullVideoReady = Boolean(task.source.fullVideoPath && exists(task.source.fullVideoPath));
  // 「压制产物校验通过」= 完整版可用；若没有压制环节（直接切原始文件），则以「切片环节已完成」为准。
  // ★ 这里用**切片状态**而不是 task.status 判断：切片级状态才是事实来源，
  //   任务级状态可能因为绕过了编排层（手工调用、部分重跑）而滞后。
  const clips = task.clips ?? [];
  // ★ 只看**已勾选**的切片：未勾选的候选永远不会发布（半自动模式下用户没选它们），
  //   若把它们算进来，素材会因为「还有 CANDIDATE」而永远无法清理。
  const selectedClips = clips.filter((c) => c.selected);
  const allClipsSettled =
    clips.length > 0 && selectedClips.length > 0 && selectedClips.every((c) => c.status === 'PUBLISHED' || c.status === 'SKIPPED');
  const cutDone = task.status === 'PUBLISHED' || task.status === 'CLIPPED' || allClipsSettled;
  const rawDeletable = cfg.cleanup.deleteRawAfterTranscribe && transcribeDone && (fullVideoReady || cutDone);
  facts['transcribeDone'] = transcribeDone;
  facts['fullVideoReady'] = fullVideoReady;
  facts['cutDone'] = cutDone;
  facts['allClipsSettled'] = allClipsSettled;
  facts['rawFileCount'] = task.source.rawFiles.length;
  facts['rawTotalGB'] = Number((task.source.rawFiles.reduce((a, f) => a + fileSize(f), 0) / 1024 ** 3).toFixed(2));

  let rawReason: string;
  if (!cfg.cleanup.deleteRawAfterTranscribe) {
    rawReason = '配置关闭了「转写完成后删除原始分段」（cleanup.deleteRawAfterTranscribe=false）';
  } else if (!transcribeDone) {
    rawReason = `转写尚未完成（当前阶段 ${task.stage}）—— 转写直接读原始分段，删早了会打断进行中的转写`;
  } else if (!fullVideoReady && !cutDone) {
    rawReason = '压制产物不可用且切片尚未完成 —— 原始分段仍是切片链路的唯一源文件';
  } else {
    rawReason = '转写已完成，且压制产物可用（或全部切片已完成）—— 符合 §7.3 的原始分段删除条件';
  }

  /* ---- 压制产物 mp4 ---- */
  // §7.3：该场**全部切片上传完成 + 完整版上传完成**后，再等缓冲期（默认 7 天）
  const unsent = task.clips?.filter((c) => c.status !== 'PUBLISHED' && c.status !== 'SKIPPED') ?? [];
  const selectedUnsent = unsent.filter((c) => c.selected);
  const allClipsDone = selectedUnsent.length === 0;
  facts['clipsTotal'] = task.clips?.length ?? 0;
  facts['clipsUnsent'] = unsent.length;
  facts['clipsSelectedUnsent'] = selectedUnsent.length;
  facts['fullUpload'] = task.fullUpload;

  // 缓冲期从「最后一个环节完成」起算：优先用 publishedAt，其次用 updatedAt
  const anchor = task.publishedAt ? Date.parse(task.publishedAt) : Date.parse(task.updatedAt);
  const ageDays = Number.isFinite(anchor) ? (now - anchor) / 86400_000 : 0;
  facts['ageDays'] = Number(ageDays.toFixed(2));
  facts['retentionDays'] = cfg.cleanup.retentionDays;

  const fullUploadOk = task.fullUpload === 'CONFIRMED' || task.fullUpload === 'NOT_APPLICABLE';
  const fullVideoDeletable = allClipsDone && fullUploadOk && ageDays >= cfg.cleanup.retentionDays;

  let fullVideoReason: string;
  if (!allClipsDone) {
    fullVideoReason = `还有 ${selectedUnsent.length} 个已勾选切片未完成投稿（共 ${unsent.length} 个未完成）—— 补切/重切都要读这个文件`;
  } else if (!fullUploadOk) {
    fullVideoReason =
      `完整版上传状态为 ${task.fullUpload}，尚未通过 GET /bili/archives 反查确认（硬约束 #17：未确认完成前不得删除源 mp4）`;
  } else if (ageDays < cfg.cleanup.retentionDays) {
    fullVideoReason =
      `全部切片与完整版都已完成，但距完成仅 ${ageDays.toFixed(1)} 天，未满 ${cfg.cleanup.retentionDays} 天缓冲期` +
      `（缓冲期用于覆盖「事后想加切片 / 标题不合适要重做 / 完整版重传」的场景）`;
  } else {
    fullVideoReason = `全部切片发布完成、完整版已确认，且已过 ${ageDays.toFixed(1)} 天缓冲期（≥ ${cfg.cleanup.retentionDays} 天）`;
  }

  if (cfg.cleanup.keepFullVideoOnFailure && task.status === 'FAILED') {
    fullVideoReason = '该场处于失败态（cleanup.keepFullVideoOnFailure=true），保留素材以便重跑';
    facts['keptOnFailure'] = true;
    return { rawDeletable, rawReason, fullVideoDeletable: false, fullVideoReason, facts };
  }

  void opts.slicesPublished;
  return { rawDeletable, rawReason, fullVideoDeletable, fullVideoReason, facts };
}

/* ============================================================================
 * 删除执行
 * ========================================================================== */

export interface CleanupAction {
  taskId: string;
  kind: 'raw' | 'fullVideo';
  files: string[];
  freedBytes: number;
  ok: boolean;
  error?: string;
  at: string;
}

/** 删除文件并返回实际释放的字节数；单个文件失败不影响其它 */
export function deleteFiles(files: string[], logger?: Logger): { deleted: string[]; freedBytes: number; errors: string[] } {
  const deleted: string[] = [];
  const errors: string[] = [];
  let freedBytes = 0;
  for (const f of files) {
    try {
      if (!exists(f)) {
        deleted.push(f);
        continue;
      }
      const size = fileSize(f);
      fs.unlinkSync(f);
      freedBytes += size;
      deleted.push(f);
    } catch (e) {
      const msg = `${path.basename(f)}: ${(e as Error).message}`;
      errors.push(msg);
      logger?.warn(`删除文件失败（跳过）：${msg}`);
    }
  }
  return { deleted, freedBytes, errors };
}

/** 删除任务目录里的临时产物（转写缓存不在此列 —— 它按内容哈希索引，重跑要复用） */
export function cleanTaskScratch(dir: string): void {
  for (const name of ['publish-report-*.json']) {
    const prefix = name.replace('*', '');
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix.replace(/\*$/, '')) && f.endsWith('.json')) {
          // 只清理过期报告，保留最近一份
          const full = path.join(dir, f);
          if (Date.now() - fs.statSync(full).mtimeMs > 7 * 86400_000) fs.unlinkSync(full);
        }
      }
    } catch {
      /* ignore */
    }
  }
}

/* ============================================================================
 * Cleaner
 * ========================================================================== */

export interface CleanupDeps {
  config: AppConfig;
  ledger: Ledger;
  logger?: Logger;
  alerter?: Alerter;
  /** 磁盘守卫触发时通知编排层暂停新任务 */
  onDiskLow?: (info: DiskInfo) => void;
  onDiskRecovered?: (info: DiskInfo) => void;
}

export interface CleanupReport {
  at: string;
  disk?: DiskInfo;
  actions: CleanupAction[];
  freedBytes: number;
  /** 因磁盘不足而暂停新任务 */
  paused: boolean;
  notes: string[];
}

export class Cleaner {
  private cfg: AppConfig;
  private ledger: Ledger;
  private logger: Logger;
  private alerter?: Alerter;
  private deps: CleanupDeps;
  private diskLow = false;
  private timer?: NodeJS.Timeout;

  constructor(deps: CleanupDeps) {
    this.deps = deps;
    this.cfg = deps.config;
    this.ledger = deps.ledger;
    this.logger = (deps.logger ?? globalLog).child({ mod: 'cleanup' });
    if (deps.alerter) this.alerter = deps.alerter;
  }

  update(cfg: AppConfig): void {
    this.cfg = cfg;
  }

  /**
   * 对外暴露「这一场能不能删」的判定（UI 与端到端测试都要用）。
   * 逻辑同 `judgeDeletability`，只是把配置注入进来，避免调用方自己传 cfg 传错。
   */
  judgeDeletabilityPublic(task: TaskRecord, opts: { now?: number } = {}): DeletabilityVerdict {
    return judgeDeletability(task, this.cfg, opts);
  }

  /** 是否可以开始新任务（磁盘守卫，§7.3） */
  canStartNewTask(): { ok: boolean; reason?: string; disk?: DiskInfo } {
    const dir = this.diskWatchDir();
    const info = checkDisk(dir, this.cfg.cleanup.diskFloorGB);
    if (!info) return { ok: true };
    if (info.low) {
      return {
        ok: false,
        reason:
          `磁盘剩余 ${info.freeGB.toFixed(1)} GB，低于阈值 ${this.cfg.cleanup.diskFloorGB} GB —— 已停止接收新任务（硬性磁盘守卫）。` +
          `请清理空间或调低 cleanup.diskFloorGB 后重试`,
        disk: info,
      };
    }
    return { ok: true, disk: info };
  }

  /** 磁盘检查的路径：优先用切片输出目录所在盘（素材都在这附近） */
  private diskWatchDir(): string {
    // 相对路径按项目根目录解析 —— 否则会跟着启动时的工作目录跑
    const out = resolveDataPath(this.cfg.clip.outputDir);
    try {
      ensureDir(out);
      return out;
    } catch {
      return process.cwd();
    }
  }

  /** 单次清理：按台账状态驱动，逐场判定 */
  async runOnce(opts: { dryRun?: boolean } = {}): Promise<CleanupReport> {
    const at = nowIso();
    const notes: string[] = [];
    const actions: CleanupAction[] = [];
    let freedBytes = 0;

    /* ---- 磁盘守卫 ---- */
    const dir = this.diskWatchDir();
    const info = checkDisk(dir, this.cfg.cleanup.diskFloorGB);
    let paused = false;
    if (info) {
      if (info.low && !this.diskLow) {
        this.diskLow = true;
        paused = true;
        notes.push(`磁盘剩余 ${info.freeGB.toFixed(1)} GB 低于阈值 ${this.cfg.cleanup.diskFloorGB} GB，已停止接收新任务并触发紧急清理`);
        this.logger.error(
          `磁盘空间不足：剩余 ${fmtBytes(info.freeBytes)}（${info.freeGB.toFixed(1)} GB）< 阈值 ${this.cfg.cleanup.diskFloorGB} GB。` +
            `已停止新任务并执行紧急清理。注意：若无法停止 biliLive-tools 的录制，至少请人工介入清理`,
        );
        await this.alerter?.diskLow({ freeGB: info.freeGB, thresholdGB: this.cfg.cleanup.diskFloorGB });
        this.deps.onDiskLow?.(info);
      } else if (!info.low && this.diskLow) {
        this.diskLow = false;
        notes.push(`磁盘剩余已恢复到 ${info.freeGB.toFixed(1)} GB，恢复接收新任务`);
        await this.alerter?.recover('disk-low', `磁盘空间已恢复：剩余 ${info.freeGB.toFixed(1)} GB（阈值 ${this.cfg.cleanup.diskFloorGB} GB）`);
        this.deps.onDiskRecovered?.(info);
      }
    } else {
      notes.push('无法查询磁盘空间（fs.statfs 不可用），已跳过磁盘守卫检查');
    }

    /* ---- 逐场清理 ---- */
    const tasks = this.ledger.listTasks({ limit: 500 });
    // 磁盘告急时优先处理占用最大的场次：按原始素材体积降序
    const ordered = info?.low
      ? [...tasks].sort(
          (a, b) =>
            b.source.rawFiles.reduce((x, f) => x + fileSize(f), 0) - a.source.rawFiles.reduce((x, f) => x + fileSize(f), 0),
        )
      : tasks;

    for (const task of ordered) {
      const verdict = judgeDeletability(task, this.cfg, { now: Date.now() });

      // ---- 原始分段 ----
      if (verdict.rawDeletable) {
        const files = task.source.rawFiles.filter((f) => exists(f));
        if (files.length > 0) {
          if (opts.dryRun) {
            const bytes = files.reduce((a, f) => a + fileSize(f), 0);
            notes.push(`[dry-run] ${task.id}：将删除 ${files.length} 个原始分段（${fmtBytes(bytes)}）—— ${verdict.rawReason}`);
          } else {
            const res = deleteFiles(files, this.logger);
            const action: CleanupAction = {
              taskId: task.id,
              kind: 'raw',
              files: res.deleted,
              freedBytes: res.freedBytes,
              ok: res.errors.length === 0,
              at: nowIso(),
              ...(res.errors.length ? { error: res.errors.join('; ') } : {}),
            };
            actions.push(action);
            freedBytes += res.freedBytes;
            this.ledger.updateTask(task.id, {
              cleaned: { ...(task.cleaned ?? {}), rawDeletedAt: nowIso() },
            });
            this.logger.info(
              `已删除 ${res.deleted.length} 个原始分段，释放 ${fmtBytes(res.freedBytes)}（${task.id}）—— ${verdict.rawReason}`,
            );
          }
        }
      } else if (task.source.rawFiles.some((f) => exists(f))) {
        this.logger.debug(`保留原始分段（${task.id}）：${verdict.rawReason}`, { data: verdict.facts });
      }

      // ---- 压制产物 ----
      const full = task.source.fullVideoPath;
      if (full && exists(full)) {
        if (verdict.fullVideoDeletable) {
          if (opts.dryRun) {
            notes.push(`[dry-run] ${task.id}：将删除压制产物（${fmtBytes(fileSize(full))}）—— ${verdict.fullVideoReason}`);
          } else {
            const res = deleteFiles([full], this.logger);
            actions.push({
              taskId: task.id,
              kind: 'fullVideo',
              files: res.deleted,
              freedBytes: res.freedBytes,
              ok: res.errors.length === 0,
              at: nowIso(),
              ...(res.errors.length ? { error: res.errors.join('; ') } : {}),
            });
            freedBytes += res.freedBytes;
            this.ledger.updateTask(task.id, {
              cleaned: { ...(task.cleaned ?? {}), fullVideoDeletedAt: nowIso() },
              // 源文件已删 → 归档，UI 上不再显示为「处理中」
              ...(task.status === 'PUBLISHED' ? { status: 'ARCHIVED' as const } : {}),
            });
            this.logger.info(`已删除压制产物，释放 ${fmtBytes(res.freedBytes)}（${task.id}）—— ${verdict.fullVideoReason}`);
          }
        } else {
          this.logger.debug(`保留压制产物（${task.id}）：${verdict.fullVideoReason}`, { data: verdict.facts });
        }
      }

      cleanTaskScratch(this.ledger.taskDir(task.id));
    }

    if (freedBytes > 0) {
      const after = checkDisk(dir, this.cfg.cleanup.diskFloorGB);
      this.logger.info(
        `清理完成：释放 ${fmtBytes(freedBytes)}${after ? `，磁盘剩余 ${after.freeGB.toFixed(1)} GB` : ''}`,
      );
      // 恢复通知：清理后空间回到阈值以上
      if (this.diskLow && after && !after.low) {
        this.diskLow = false;
        notes.push(`紧急清理后磁盘恢复到 ${after.freeGB.toFixed(1)} GB，恢复接收新任务`);
        await this.alerter?.recover('disk-low', `紧急清理后磁盘空间已恢复：剩余 ${after.freeGB.toFixed(1)} GB`);
        this.deps.onDiskRecovered?.(after);
      }
    }

    return { at, ...(info ? { disk: info } : {}), actions, freedBytes, paused: paused || this.diskLow, notes };
  }

  /** 素材占用概览（UI 与健康面板用） */
  storageOverview(): {
    tasks: number;
    rawGB: number;
    fullVideoGB: number;
    deletableRawGB: number;
    deletableFullVideoGB: number;
    disk?: DiskInfo;
  } {
    let rawBytes = 0;
    let fullBytes = 0;
    let delRaw = 0;
    let delFull = 0;
    const tasks = this.ledger.listTasks({ limit: 1000 });
    for (const t of tasks) {
      const v = judgeDeletability(t, this.cfg, { now: Date.now() });
      const raw = t.source.rawFiles.reduce((a, f) => a + fileSize(f), 0);
      const full = t.source.fullVideoPath ? fileSize(t.source.fullVideoPath) : 0;
      rawBytes += raw;
      fullBytes += full;
      if (v.rawDeletable) delRaw += raw;
      if (v.fullVideoDeletable) delFull += full;
    }
    return {
      tasks: tasks.length,
      rawGB: rawBytes / 1024 ** 3,
      fullVideoGB: fullBytes / 1024 ** 3,
      deletableRawGB: delRaw / 1024 ** 3,
      deletableFullVideoGB: delFull / 1024 ** 3,
      ...(checkDisk(this.diskWatchDir(), this.cfg.cleanup.diskFloorGB) ? { disk: checkDisk(this.diskWatchDir(), this.cfg.cleanup.diskFloorGB)! } : {}),
    };
  }

  /** 启动周期清理 */
  start(): void {
    const intervalMs = Math.max(60_000, this.cfg.cleanup.checkIntervalMin * 60_000);
    this.logger.info(`素材清理已启用：每 ${this.cfg.cleanup.checkIntervalMin} 分钟检查一次，缓冲期 ${this.cfg.cleanup.retentionDays} 天，磁盘阈值 ${this.cfg.cleanup.diskFloorGB} GB`);
    const tick = async (): Promise<void> => {
      try {
        const r = await this.runOnce();
        if (r.actions.length || r.notes.length) {
          for (const n of r.notes) this.logger.info(n);
        }
      } catch (e) {
        this.logger.error('清理任务异常（下一轮继续）', e);
      }
      this.timer = setTimeout(() => void tick(), intervalMs);
      this.timer.unref?.();
    };
    // 启动后延迟 2 分钟再跑第一轮，避免和启动补漏抢 IO
    this.timer = setTimeout(() => void tick(), 120_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get isDiskLow(): boolean {
    return this.diskLow;
  }
}

/* ============================================================================
 * 日志轮转（§7.3：避免日志自身占满磁盘）
 * ========================================================================== */

/** 清理过期日志与错误报告，返回释放字节 */
export function rotateLogs(opts: { dirs: string[]; keepDays: number; logger?: Logger }): { removed: number; freedBytes: number } {
  const cutoff = Date.now() - opts.keepDays * 86400_000;
  let removed = 0;
  let freedBytes = 0;
  for (const dir of opts.dirs) {
    if (!exists(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          if (st.mtimeMs >= cutoff) continue;
          fs.unlinkSync(full);
          removed++;
          freedBytes += st.size;
        } catch {
          /* 单个文件失败不影响其它 */
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (removed > 0) {
    opts.logger?.info(`日志轮转：清理 ${removed} 个过期文件，释放 ${fmtBytes(freedBytes)}（保留 ${opts.keepDays} 天）`);
  }
  return { removed, freedBytes };
}

/* ============================================================================
 * biliLive-tools 侧开关检查（硬约束 #11）
 * ========================================================================== */

export interface UploadDeleteCheck {
  ok: boolean;
  value?: string;
  message: string;
  /** 可以在 UI 上直接给用户的修复步骤 */
  fix?: string;
}

/**
 * 检查 biliLive-tools 的「上传后删除素材」是否已关闭。
 *
 * ⚠️ 硬约束 #11：必须为 `none`。三档取值的含义：
 *   - `none`：不删（**默认**，我们要的）
 *   - `delete`：上传完成即删
 *   - `deleteAfterCheck`：等稿件**通过审核**后删（审核可能只要几分钟，而转写要 20–40 分钟 → 竞态）
 *
 * 为什么必须关掉：切片流程要在完整版上传**之后**继续读同一个视频文件。
 * 而且它的删除走内部引用计数，**外部程序无法参与、无法为文件加锁**。
 *
 * ⚠️⚠️ 实测踩过的坑：这个开关**可以按房间单独覆盖**（`webhook.rooms.<房间号>.afterUploadDeletAction`）。
 * 原来的实现用 `Object.keys(flat).find(...)` 只取**第一个**匹配键，于是
 * 「全局是 none、某个房间是 deleteAfterCheck」这种配置会被判为"已关闭" —— 自检给出假绿。
 * 现在检查**所有**匹配键，任何一个不是 none 都算不合格，并指名道姓报出是哪个房间。
 */
export function checkAfterUploadDelete(cfg: AppConfig, raw: unknown): UploadDeleteCheck {
  const flat = flattenKeys(raw);
  const hits = Object.entries(flat).filter(([k]) => /afterUploadDeletAction$/i.test(k));
  if (hits.length === 0) {
    return {
      ok: true,
      message:
        '未能从 GET /config 读到 afterUploadDeletAction（该字段可能在不同版本里位置不同）—— ' +
        '请人工在 biliLive-tools「工具 → 上传」里确认「上传后删除素材」为关闭状态',
    };
  }
  /** `webhook.rooms.34567890.afterUploadDeletAction` → 房间 34567890；全局键返回空串 */
  const roomOf = (key: string): string => /\.rooms?\.([^.]*)\./i.exec(key)?.[1] ?? '';
  const offenders = hits
    .map(([key, value]) => ({ key, room: roomOf(key), value: String(value) }))
    .filter((h) => h.value !== 'none');

  if (offenders.length === 0) {
    return {
      ok: true,
      value: 'none',
      message: `✓ biliLive-tools 的「上传后删除素材」已关闭（${hits.length} 处配置全部为 none），符合硬约束 #11`,
    };
  }

  const globalHit = offenders.find((o) => !o.room);
  const roomHits = offenders.filter((o) => o.room);
  const parts: string[] = [];
  if (globalHit) parts.push(`全局为 "${globalHit.value}"`);
  for (const r of roomHits) parts.push(`房间 ${r.room} 单独覆盖为 "${r.value}"`);

  return {
    ok: false,
    value: offenders[0]!.value,
    message:
      `⚠️ biliLive-tools 的「上传后删除素材」**必须全部为 none**（硬约束 #11），当前：${parts.join('；')}。` +
      `否则稿件过审后源视频会被删除，转写与切片会读到不存在的文件 —— 故障表现分散（转写报错 + 切片报「输入文件不存在」），很难定位` +
      (roomHits.length ? `。注意：房间级覆盖会盖住全局设置，必须逐个房间检查` : ''),
    fix:
      offenders[0]!.value === 'deleteAfterCheck'
        ? `在 biliLive-tools 中：设置 → 工具 → 上传 → 把「上传后删除素材」改为关闭${roomHits.length ? `；并到「录制 → 每个直播间」里逐个检查，房间 ${roomHits.map((r) => r.room).join('、')} 各自也开着` : ''}。注意它的删除走内部引用计数，本服务无法为文件加锁`
        : `在 biliLive-tools 中：设置 → 工具 → 上传 → 把「上传后删除素材」改为关闭${roomHits.length ? `；房间 ${roomHits.map((r) => r.room).join('、')} 也要单独改` : ''}`,
  };
  void cfg;
}

/** 把嵌套对象压成 a.b.c 形式的键 */
/**
 * 把嵌套对象压平成 `a.b.c = value` 的键值对。
 *
 * ⚠️ 必须防循环引用：`/config` 正常是 JSON（不可能有环），但这个函数也被
 * 单元测试与诊断工具用任意对象调用 —— 遇到环会无限递归直到栈溢出。
 * 实测踩到过（单测 `test/config-checks.ts` 用带自引用的对象调它）。
 */
export function flattenKeys(v: unknown, prefix = '', seen: WeakSet<object> = new WeakSet()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v === null || typeof v !== 'object') {
    if (prefix) out[prefix] = v;
    return out;
  }
  if (Array.isArray(v)) {
    if (prefix) out[prefix] = `[${v.length} 项]`;
    return out;
  }
  if (seen.has(v)) {
    if (prefix) out[prefix] = '[循环引用]';
    return out;
  }
  seen.add(v);
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) Object.assign(out, flattenKeys(val, key, seen));
    else out[key] = Array.isArray(val) ? `[${val.length} 项]` : val;
  }
  return out;
}
