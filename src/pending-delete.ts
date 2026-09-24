/**
 * 上传确认后的"延迟删除"清单。
 *
 * ## 为什么不是删完就算
 *
 * 用户要的是「上传完成后删掉切片和源文件」，但删除源录播是**不可逆**的，
 * 而且已经出过一次事：源文件没了之后，重跑切片只会得到
 * 「找不到可用于切片的源文件」，整场报废。所以删除必须满足三个条件：
 *
 * 1. **确认点必须硬**：只认 `PUBLISHED` + 经 `GET /bili/archives` 反查到 bvid（硬约束 #17）——
 *    提交成功不等于发出去了，反查不到就等于没发。
 * 2. **本场全部切片都确认完了**才排源文件（用户的明确选择）：任何一条切片失败都还能从源重切。
 * 3. **进清单 ≠ 立刻删**：默认宽限 24 小时，期间界面上能一键取消。
 *
 * ## 删法（按盘符分流，因为跨盘"移动"等于复制）
 *
 * - 成片在 `data/clips/`（本盘）→ 移入回收站：`rename` 是瞬时的，还能恢复 7 天；
 * - 源录播在 `C:`（异盘）→ 回收站也在 `F:`，跨盘"移入回收站"要复制 20 GB，不现实
 *   → 到点直接 `rmSync`，日志里写清楚删了什么、为什么可以删。
 *
 * 到点执行由 `runDueDeletions()` 完成，daemon 定时调用；也可以从界面手动触发一次。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDir, fnv1a, nowIso, readJson, writeJsonAtomic } from './util.ts';
import { TRASH_DIR, moveToTrash } from './trash.ts';
import { log as globalLog, type Logger } from './logger.ts';

const STATE_PATH = path.join(DATA_DIR, 'pending-delete.json');

export type PendingDeleteKind = 'clip' | 'raw' | 'fullVideo';

export interface PendingDeleteEntry {
  id: string;
  /** 要删的绝对路径（文件或目录） */
  path: string;
  kind: PendingDeleteKind;
  taskId: string;
  /** 为什么可以删（给人看的，出问题时要能追） */
  reason: string;
  sizeBytes: number;
  createdAt: string;
  /** 到这个时刻才真删 */
  dueAt: string;
  cancelledAt?: string;
  deletedAt?: string;
  /** 实际用的删法：移入回收站 / 直接删除 */
  deletedBy?: 'trash' | 'rm';
  /**
   * 是**用户手动点了「立即删除」**删掉的（而不是宽限期到点自动删的）。
   *
   * 为什么要记：清理是后台行为，出了"我的文件怎么没了"的疑问时，
   * 必须能一眼分清"到点自动删"和"我自己点的"。界面上也据此显示。
   */
  deletedManually?: boolean;
  /** 删除失败的原因（保留在清单里，下轮重试） */
  error?: string;
}

export interface PendingDeleteState {
  version: 1;
  entries: PendingDeleteEntry[];
}

export interface ScheduleInput {
  path: string;
  kind: PendingDeleteKind;
  taskId: string;
  reason: string;
  sizeBytes?: number;
}

export interface ScheduleResult {
  added: PendingDeleteEntry[];
  /** 已经在清单里（同路径未取消/未删）而跳过的 */
  skipped: Array<{ path: string; existingId: string }>;
}

function load(statePath: string): PendingDeleteState {
  try {
    const s = readJson<PendingDeleteState>(statePath);
    if (s && s.version === 1 && Array.isArray(s.entries)) return s;
  } catch {
    /* 清单坏了就重建：删除这件事宁可漏一轮，也不能因为文件损坏而抛错卡住流水线 */
  }
  return { version: 1, entries: [] };
}

function save(statePath: string, state: PendingDeleteState): void {
  ensureDir(path.dirname(statePath));
  writeJsonAtomic(statePath, state);
}

function entryId(target: string): string {
  return `pd-${fnv1a(target)}`;
}

/** 目标是否与回收站在同一个盘（同盘才能"移入回收站"而不复制字节） */
export function sameVolume(target: string, trashRoot: string = TRASH_DIR): boolean {
  // 空路径无从判断：返回 false（调用方在删之前都会先确认文件存在，所以不会误用这个分支）
  if (!target?.trim() || !trashRoot?.trim()) return false;
  try {
    return path.parse(path.resolve(target)).root.toLowerCase() === path.parse(path.resolve(trashRoot)).root.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 把文件排进待删清单。
 *
 * 幂等：同一路径已在清单里（未取消、未删除）就跳过 ——
 * 反查循环每 5 分钟跑一次，不幂等会堆出成百上千条重复记录。
 */
export function scheduleDelete(
  inputs: ScheduleInput[],
  opts: { graceHours: number; statePath?: string; now?: number; logger?: Logger },
): ScheduleResult {
  const log = opts.logger ?? globalLog;
  const statePath = opts.statePath ?? STATE_PATH;
  const state = load(statePath);
  const now = opts.now ?? Date.now();
  const dueAt = new Date(now + Math.max(0, opts.graceHours) * 3600_000).toISOString();
  const added: PendingDeleteEntry[] = [];
  const skipped: ScheduleResult['skipped'] = [];

  for (const input of inputs) {
    const target = path.resolve(input.path);
    const existing = state.entries.find((e) => e.path === target && !e.cancelledAt && !e.deletedAt);
    if (existing) {
      skipped.push({ path: target, existingId: existing.id });
      continue;
    }
    let sizeBytes = input.sizeBytes ?? 0;
    if (!sizeBytes && fs.existsSync(target)) {
      try {
        const st = fs.statSync(target);
        sizeBytes = st.isDirectory() ? dirSize(target) : st.size;
      } catch {
        /* 拿不到体积不影响删除 */
      }
    }
    const entry: PendingDeleteEntry = {
      id: entryId(target),
      path: target,
      kind: input.kind,
      taskId: input.taskId,
      reason: input.reason,
      sizeBytes,
      createdAt: nowIso(),
      dueAt,
    };
    state.entries.push(entry);
    added.push(entry);
  }

  if (added.length > 0) {
    save(statePath, state);
    const gb = added.reduce((a, e) => a + e.sizeBytes, 0) / 1024 ** 3;
    log.info(
      `已排入待删清单 ${added.length} 项（合计 ${gb.toFixed(2)} GB），` +
        `${opts.graceHours} 小时后自动删除，期间可在界面上取消`,
      { data: { entries: added.map((e) => ({ path: e.path, kind: e.kind, dueAt: e.dueAt })) } },
    );
  }
  return { added, skipped };
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      try {
        if (it.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
  };
  walk(dir);
  return total;
}

export interface PendingDeleteView {
  /** 还没到点、也没被取消的 */
  pending: PendingDeleteViewEntry[];
  /** 已取消的 */
  cancelled: PendingDeleteEntry[];
  /** 已删除的（保留记录，便于追"我的文件去哪了"） */
  deleted: PendingDeleteEntry[];
  stats: {
    pendingCount: number;
    pendingBytes: number;
    /** 最早到点时刻 */
    nextDueAt?: string;
    /** 已到点但还没执行（等待下一次清理） */
    dueNowCount: number;
    deletedBytes: number;
  };
}

/**
 * 清单里的一条 + 两个**算出来的**信息（不落盘）。
 *
 * 界面要在用户点「立即删除」**之前**就把后果说清楚：
 *   - `willTrash`：同盘 → 进回收站（可恢复）；异盘 → 直接删（**不可恢复**）。
 *     这两句提示文案完全不同，不能让用户点下去才发现。
 *   - `existsNow`：文件已经不在了（自己删了/上次删了一半）→ 按钮改成"标记为已删除"。
 */
export interface PendingDeleteViewEntry extends PendingDeleteEntry {
  willTrash: boolean;
  existsNow: boolean;
}

function decorate(entry: PendingDeleteEntry, trashRoot: string): PendingDeleteViewEntry {
  return { ...entry, willTrash: sameVolume(entry.path, trashRoot), existsNow: fs.existsSync(entry.path) };
}

export function listPendingDelete(opts: { statePath?: string; now?: number; trashRoot?: string } = {}): PendingDeleteView {
  const statePath = opts.statePath ?? STATE_PATH;
  const trashRoot = opts.trashRoot ?? TRASH_DIR;
  const now = opts.now ?? Date.now();
  const state = load(statePath);
  const pending = state.entries.filter((e) => !e.cancelledAt && !e.deletedAt);
  const cancelled = state.entries.filter((e) => e.cancelledAt);
  const deleted = state.entries.filter((e) => e.deletedAt);
  const dueNow = pending.filter((e) => Date.parse(e.dueAt) <= now);
  const dueTimes = pending.map((e) => Date.parse(e.dueAt)).filter((t) => Number.isFinite(t));
  return {
    pending: pending.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)).map((e) => decorate(e, trashRoot)),
    cancelled,
    deleted,
    stats: {
      pendingCount: pending.length,
      pendingBytes: pending.reduce((a, e) => a + e.sizeBytes, 0),
      ...(dueTimes.length ? { nextDueAt: new Date(Math.min(...dueTimes)).toISOString() } : {}),
      dueNowCount: dueNow.length,
      deletedBytes: deleted.reduce((a, e) => a + e.sizeBytes, 0),
    },
  };
}

/** 取消一项待删（用户在 24 小时宽限期内反悔） */
export function cancelPendingDelete(id: string, opts: { statePath?: string; logger?: Logger } = {}): { ok: boolean; entry?: PendingDeleteEntry } {
  const log = opts.logger ?? globalLog;
  const statePath = opts.statePath ?? STATE_PATH;
  const state = load(statePath);
  const entry = state.entries.find((e) => e.id === id);
  if (!entry || entry.cancelledAt || entry.deletedAt) return { ok: false };
  entry.cancelledAt = nowIso();
  save(statePath, state);
  log.info(`已取消待删：${entry.path}（不会自动删除）`, { data: { id, taskId: entry.taskId } });
  return { ok: true, entry };
}

export interface RunDueResult {
  deleted: number;
  failed: number;
  bytes: number;
  notes: string[];
}

interface DeleteOutcome {
  by: 'trash' | 'rm';
  /** 实际释放的字节（回收站路径取移动的字节，直接删取目标真实体积） */
  bytes: number;
  note: string;
  trashId?: string;
}

/**
 * 真正执行一条删除。**自动到点删**和**用户手动立即删**共用这一份实现 ——
 * 两条路必须完全一致，否则"手动删"会变成一条绕过所有安全逻辑的野路子。
 *
 * 删法按盘符分流：同盘 → 回收站（可恢复）；异盘 → 直接删（回收站在别的盘，
 * 整份复制 20 GB 不现实）。异盘是**唯一不可逆**的路径，所以调用方必须先把后果告诉用户。
 */
function performDelete(entry: PendingDeleteEntry, opts: { trashRoot: string; log: Logger }): DeleteOutcome {
  if (!fs.existsSync(entry.path)) {
    // 已经不在了（用户自己删了/上次删了一半）→ 记账收工，不再报错
    return { by: 'rm', bytes: 0, note: `${entry.path} 已不存在，标记为已删除` };
  }
  if (sameVolume(entry.path, opts.trashRoot)) {
    const r = moveToTrash({
      taskId: entry.taskId,
      title: path.basename(entry.path),
      status: 'PENDING_DELETE',
      paths: [entry.path],
      reason: entry.reason,
      root: opts.trashRoot,
      logger: opts.log,
    });
    if (r.moved === 0 && fs.existsSync(entry.path)) {
      throw new Error(r.warnings[0] ?? '移入回收站未生效');
    }
    return {
      by: 'trash',
      bytes: r.bytes,
      note: `${entry.path} → 回收站 ${r.id}（${(r.bytes / 1024 ** 2).toFixed(1)} MB，可在回收站恢复）`,
      trashId: r.id,
    };
  }
  /* 跨盘：回收站在别的盘，"移入回收站"要整份复制，20 GB 的源文件不现实 → 直接删。
     这是唯一不可逆的路径，所以它只在"宽限期已过 + 本场全部切片确认"之后、
     或用户**明确点了「立即删除」并看过那句"无法恢复"的提醒**之后才会走到。 */
  const size = entry.sizeBytes || (fs.statSync(entry.path).isDirectory() ? dirSize(entry.path) : fs.statSync(entry.path).size);
  fs.rmSync(entry.path, { recursive: true, force: true });
  if (fs.existsSync(entry.path)) throw new Error('删除后文件仍然存在');
  return { by: 'rm', bytes: size, note: `${entry.path} 已永久删除（${(size / 1024 ** 2).toFixed(1)} MB，跨盘不进回收站）` };
}

/**
 * 执行到点的删除。由 daemon 定时调用。
 *
 * 永远不会因为单个文件删不掉而中断（权限占用、文件被播放器打开都可能失败）——
 * 失败的条目留在清单里，带上 `error`，下一轮继续试。
 */
export function runDueDeletions(
  opts: { statePath?: string; now?: number; logger?: Logger; trashRoot?: string; /** 只处理这些 id（手动触发用） */ onlyIds?: string[] } = {},
): RunDueResult {
  const log = opts.logger ?? globalLog;
  const statePath = opts.statePath ?? STATE_PATH;
  const trashRoot = opts.trashRoot ?? TRASH_DIR;
  const now = opts.now ?? Date.now();
  const state = load(statePath);
  const notes: string[] = [];
  let deleted = 0;
  let failed = 0;
  let bytes = 0;

  for (const entry of state.entries) {
    if (entry.cancelledAt || entry.deletedAt) continue;
    if (opts.onlyIds && !opts.onlyIds.includes(entry.id)) continue;
    if (Date.parse(entry.dueAt) > now) continue;

    try {
      const outcome = performDelete(entry, { trashRoot, log });
      entry.deletedAt = nowIso();
      entry.deletedBy = outcome.by;
      entry.deletedManually = false; // 到点自动删：与"用户手动点删"区分开
      entry.error = undefined;
      deleted++;
      bytes += outcome.bytes;
      notes.push(outcome.note);
      log.info(`已按期删除：${entry.path}（${entry.kind}，${entry.reason}）`, { data: { id: entry.id, taskId: entry.taskId, by: entry.deletedBy } });
    } catch (e) {
      failed++;
      entry.error = (e as Error).message;
      log.warn(`删除失败（保留在清单里，下轮重试）：${entry.path} —— ${entry.error}`, { data: { id: entry.id } });
    }
  }

  save(statePath, state);
  return { deleted, failed, bytes, notes };
}

export interface DeleteNowItem {
  id: string;
  path: string;
  kind: PendingDeleteKind;
  taskId: string;
  by: 'trash' | 'rm';
  bytes: number;
  note: string;
  trashId?: string;
}

export interface DeleteNowResult {
  /** 真删掉的 */
  deleted: DeleteNowItem[];
  /** 删失败的（条目留在清单里，带 error） */
  failed: Array<{ id: string; path: string; error: string }>;
  /** 没动的（id 不存在 / 已取消 / 已删过） */
  skipped: Array<{ id: string; reason: string }>;
  /** 释放的字节合计 */
  bytes: number;
}

/**
 * **立即删除**（不等宽限期）——界面上的「立即删除」按钮走这里。
 *
 * 安全边界（每一条都有理由）：
 *  1. 只能删**清单里已有的条目**：路径来自台账文件，不接受调用方传任意路径 ——
 *     否则这个接口就成了"删任意文件"的通道（硬约束 #2：本地服务也要守边界）。
 *  2. 已取消 / 已删除的条目直接跳过：用户的"反悔"不能被一个手滑覆盖掉。
 *  3. 失败不抛异常：条目留在清单里带 `error`，界面能显示、可以重试。
 *  4. 记录 `deletedManually = true`：事后能分清"到点自动删"和"我自己点的"。
 */
export function deletePendingNow(
  ids: string[],
  opts: { statePath?: string; logger?: Logger; trashRoot?: string } = {},
): DeleteNowResult {
  const log = opts.logger ?? globalLog;
  const statePath = opts.statePath ?? STATE_PATH;
  const trashRoot = opts.trashRoot ?? TRASH_DIR;
  const state = load(statePath);
  const out: DeleteNowResult = { deleted: [], failed: [], skipped: [], bytes: 0 };

  for (const rawId of ids) {
    const id = String(rawId).trim();
    if (!id) continue;
    const entry = state.entries.find((e) => e.id === id);
    if (!entry) {
      out.skipped.push({ id, reason: '清单里没有这个条目（可能已经被清理过）' });
      continue;
    }
    if (entry.cancelledAt) {
      out.skipped.push({ id, reason: '这一条已取消删除，文件不会被删' });
      continue;
    }
    if (entry.deletedAt) {
      out.skipped.push({ id, reason: '这一条已经删过了' });
      continue;
    }
    try {
      const outcome = performDelete(entry, { trashRoot, log });
      entry.deletedAt = nowIso();
      entry.deletedBy = outcome.by;
      entry.deletedManually = true;
      entry.error = undefined;
      out.deleted.push({
        id: entry.id,
        path: entry.path,
        kind: entry.kind,
        taskId: entry.taskId,
        by: outcome.by,
        bytes: outcome.bytes,
        note: outcome.note,
        ...(outcome.trashId ? { trashId: outcome.trashId } : {}),
      });
      out.bytes += outcome.bytes;
      log.info(
        `用户手动立即删除：${entry.path}（${entry.kind}，原计划 ${entry.dueAt} 自动删）` +
          `→ ${outcome.by === 'trash' ? '已移入回收站' : '已永久删除'}`,
        { data: { id: entry.id, taskId: entry.taskId, bytes: outcome.bytes } },
      );
    } catch (e) {
      entry.error = (e as Error).message;
      out.failed.push({ id: entry.id, path: entry.path, error: entry.error });
      log.warn(`手动删除失败（条目保留在清单里）：${entry.path} —— ${entry.error}`, { data: { id: entry.id } });
    }
  }

  save(statePath, state);
  return out;
}

export { STATE_PATH as PENDING_DELETE_STATE_PATH };
