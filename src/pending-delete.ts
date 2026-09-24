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
 * ## 删法（按**真实卷**分流，因为跨卷"移动"等于复制）
 *
 * - 与回收站**同一个真实卷**（本机上就是 `D:`，`data/` 和源录播目录都是指向它的 junction）
 *   → 移入回收站：`rename` 是瞬时的，还能恢复 7 天；
 * - 真的不同卷 → "移入回收站"要整份复制（20 GB 的源录播不现实）→ 到点直接 `rmSync`，
 *   日志里写清楚删了什么、为什么可以删。**这是唯一不可逆的路径**。
 *
 * ⚠️ 判断"同一个卷"必须解析 junction/符号链接，见 `sameVolume()` ——
 * 只比盘符会把 junction 路径误判成异盘，把可恢复的删除变成永久删除。
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
  /**
   * 这个路径**用户取消过** → 默认不再自动排回（`reviveCancelled: true` 才会复活）。
   *
   * 为什么要有这一栏：反查循环每 5 分钟对每个已完成场次调一次 `scheduleDelete`，
   * 如果取消后又被自动排回去，用户点的「取消」就是假的 ——
   * 头上悬着一把刀，5 分钟后重新架好，而界面那一刻显示的还是"已取消"。
   * 所以"取消"必须真的生效，重新排入必须是**显式**动作。
   */
  heldCancelled: Array<{ path: string; existingId: string; cancelledAt: string }>;
  /** 被原地复活的（只有 `reviveCancelled: true` 时才会有） */
  revived: PendingDeleteEntry[];
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

/**
 * 把一个路径归约到它**物理上真正所在**的卷根。
 *
 * 为什么不能只取盘符：junction（目录联接）和符号链接会让"看起来在 C: 的路径"
 * 实际落在 D: 上。本项目正好整套目录都是 junction：
 *
 *   C:\Users\demo\Downloads\Bilibili  → junction → D:\live_auto_media\Bilibili
 *   F:\deepseek\live_auto\data          → junction → D:\live_auto_media\data
 *
 * 两者物理上都在 D:，`rename` 是瞬时的（进回收站可恢复）；但按路径字符串比盘符
 * 会判成"跨盘"，于是本该进回收站的文件走了 `rmSync` —— **不可恢复地删掉**。
 * 这不是理论风险：2026-09-24 排进清单的 13 个文件（5.84 GB）界面上显示的就是
 * 「跨盘·删除不可恢复」，全靠用户及时叫停才没删。
 *
 * 所以先逐级向上找到**第一个真实存在的祖先**再 `realpath`：目标本身可能还不存在
 * （待删目录、还没建的回收站），不能直接对整条路径求 realpath。
 */
export function volumeRoot(target: string, opts: { realpath?: (p: string) => string } = {}): string | undefined {
  if (!target?.trim()) return undefined;
  const realpath = opts.realpath ?? ((p: string) => fs.realpathSync.native(p));
  let probe = path.resolve(target);
  for (;;) {
    try {
      // realpath 在 Windows 上可能回 `\\?\D:\…` 这种设备路径，取盘符前先去掉前缀
      const real = realpath(probe).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
      const root = path.parse(real).root;
      return root ? root.toLowerCase() : undefined;
    } catch {
      /* 不存在 / 解析不了 → 换上一层再试 */
    }
    const parent = path.dirname(probe);
    if (parent === probe) return undefined; // 已经到根（驱动器根 / UNC 根）还是解析不了
    probe = parent;
  }
}

/**
 * 目标是否与回收站在同一个盘（同盘才能"移入回收站"而不复制字节）。
 *
 * **必须解析 junction/符号链接**，理由见 `volumeRoot` 的注释 —— 这里的判断结果
 * 直接决定文件是"进回收站（可恢复）"还是"永久删除"。
 */
export function sameVolume(target: string, trashRoot: string = TRASH_DIR, opts: { realpath?: (p: string) => string } = {}): boolean {
  // 空路径无从判断：返回 false（调用方在删之前都会先确认文件存在，所以不会误用这个分支）
  if (!target?.trim() || !trashRoot?.trim()) return false;
  const a = volumeRoot(target, opts);
  const b = volumeRoot(trashRoot, opts);
  if (a && b) return a === b;
  // 两边都解析不出真实祖先（路径整条都不存在）→ 退回盘符比较，不比以前更差
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
  opts: {
    graceHours: number;
    statePath?: string;
    now?: number;
    logger?: Logger;
    /**
     * 复活这条路径上**用户取消过**的条目（原地复用同一条记录）。
     *
     * 默认 `false`：取消必须是真的，自动循环不能把用户的「取消」抹掉，见 `heldCancelled`。
     * 只有**显式的重新排期**（人工要求清理某批文件）才该传 `true`。
     */
    reviveCancelled?: boolean;
  },
): ScheduleResult {
  const log = opts.logger ?? globalLog;
  const statePath = opts.statePath ?? STATE_PATH;
  const state = load(statePath);
  const now = opts.now ?? Date.now();
  const dueAt = new Date(now + Math.max(0, opts.graceHours) * 3600_000).toISOString();
  const added: PendingDeleteEntry[] = [];
  const skipped: ScheduleResult['skipped'] = [];
  const heldCancelled: ScheduleResult['heldCancelled'] = [];
  const revived: PendingDeleteEntry[] = [];

  for (const input of inputs) {
    const target = path.resolve(input.path);
    const existing = state.entries.find((e) => e.path === target && !e.cancelledAt && !e.deletedAt);
    if (existing) {
      skipped.push({ path: target, existingId: existing.id });
      continue;
    }
    /* 用户取消过的路径：默认**不**偷偷排回去。
       而且复活是**原地**的 —— id 由路径派生（`pd-<hash>`），
       追加一条同 id 的新记录会让 "取消 / 立即删除" 按 id 查到旧的那条（已取消）而拒绝生效，
       文件就变成"界面点不掉、到点却会删"。 */
    const cancelled = state.entries.find((e) => e.path === target && e.cancelledAt && !e.deletedAt);
    if (cancelled) {
      if (!opts.reviveCancelled) {
        heldCancelled.push({ path: target, existingId: cancelled.id, cancelledAt: cancelled.cancelledAt ?? '' });
        continue;
      }
      cancelled.cancelledAt = undefined;
      cancelled.dueAt = dueAt;
      cancelled.kind = input.kind;
      cancelled.taskId = input.taskId;
      cancelled.reason = input.reason;
      cancelled.createdAt = nowIso();
      cancelled.error = undefined;
      cancelled.deletedAt = undefined;
      cancelled.deletedBy = undefined;
      cancelled.deletedManually = undefined;
      if (input.sizeBytes) cancelled.sizeBytes = input.sizeBytes;
      revived.push(cancelled);
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

  if (added.length > 0 || revived.length > 0) {
    save(statePath, state);
    const fresh = [...added, ...revived];
    const gb = fresh.reduce((a, e) => a + e.sizeBytes, 0) / 1024 ** 3;
    const what = revived.length > 0 ? `新排 ${added.length} 项、重新排入（复活已取消）${revived.length} 项` : `已排入待删清单 ${added.length} 项`;
    log.info(`${what}（合计 ${gb.toFixed(2)} GB），${opts.graceHours} 小时后自动删除，期间可在界面上取消`, {
      data: { entries: fresh.map((e) => ({ path: e.path, kind: e.kind, dueAt: e.dueAt })) },
    });
  }
  return { added, skipped, heldCancelled, revived };
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
 *   - `willTrash`：与回收站**同一个真实卷**（已解析 junction）→ 进回收站（可恢复）；
 *     真的不同卷 → 直接删（**不可恢复**）。
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

/**
 * 按 id 找**当前有效**的那一条。
 *
 * id 由路径派生（`pd-<hash>`），同一条路径被"取消 → 重新排入"过就会有多条同 id 记录。
 * 若直接 `find(e => e.id === id)`，命中的可能是**旧的已取消那条**，于是
 * 「取消」永远返回 ok:false、「立即删除」永远被当作"已取消"跳过 —— 界面上按钮点了没反应，
 * 而文件到点照样被自动删掉。所以统一先找活的，找不到再退回首条（好给出准确的跳过原因）。
 */
function findLiveEntry(state: PendingDeleteState, id: string): { live?: PendingDeleteEntry; any?: PendingDeleteEntry } {
  const matches = state.entries.filter((e) => e.id === id);
  const live = matches.find((e) => !e.cancelledAt && !e.deletedAt);
  const any = matches[matches.length - 1];
  return { ...(live ? { live } : {}), ...(any ? { any } : {}) };
}

/** 取消一项待删（用户在宽限期内反悔）。**必须是永久的**：自动循环不得把它排回来。 */
export function cancelPendingDelete(id: string, opts: { statePath?: string; logger?: Logger } = {}): { ok: boolean; entry?: PendingDeleteEntry } {
  const log = opts.logger ?? globalLog;
  const statePath = opts.statePath ?? STATE_PATH;
  const state = load(statePath);
  const { live } = findLiveEntry(state, id);
  if (!live) return { ok: false };
  live.cancelledAt = nowIso();
  save(statePath, state);
  log.info(`已取消待删：${live.path}（不会自动删除；自动清理循环不会把它重新排进来）`, { data: { id, taskId: live.taskId } });
  return { ok: true, entry: live };
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
  /* 真的跨卷：回收站在别的卷，"移入回收站"要整份复制，20 GB 的源文件不现实 → 直接删。
     这是唯一不可逆的路径，所以它只在"宽限期已过 + 本场全部切片确认"之后、
     或用户**明确点了「立即删除」并看过那句"无法恢复"的提醒**之后才会走到。

     ⚠️ 走到这里之前 `sameVolume()` 已经解析过 junction/符号链接：本机上
     `C:\…\Downloads\Bilibili` 与 `data\trash` 都落在 D:，会走上面的回收站分支。
     如果哪天这里被频繁命中，先怀疑"真实卷判断"又退化了，而不是"用户真的跨盘"。 */
  const size = entry.sizeBytes || (fs.statSync(entry.path).isDirectory() ? dirSize(entry.path) : fs.statSync(entry.path).size);
  fs.rmSync(entry.path, { recursive: true, force: true });
  if (fs.existsSync(entry.path)) throw new Error('删除后文件仍然存在');
  return { by: 'rm', bytes: size, note: `${entry.path} 已永久删除（${(size / 1024 ** 2).toFixed(1)} MB，与回收站不同卷，不进回收站）` };
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
    const { live, any } = findLiveEntry(state, id);
    if (!live) {
      out.skipped.push({
        id,
        reason: !any
          ? '清单里没有这个条目（可能已经被清理过）'
          : any.cancelledAt
            ? '这一条已取消删除，文件不会被删'
            : '这一条已经删过了',
      });
      continue;
    }
    const entry = live;
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
