/**
 * 回收站：把「删除」从不可逆改成可恢复。
 *
 * ## 为什么要做
 *
 * 实测发生过一次真实事故：通过界面点「删除任务」后，
 * **222.8 MB 成片 + 任务目录（转写/信号/总结）+ 台账记录一起被永久删除**，
 * 而删除实现是 `fs.rmSync`（不进系统回收站）。日志只留下一行「已删除任务」，
 * 想恢复没有任何途径 —— 对于"点错一下"这种最常见的失误，代价完全不成比例。
 *
 * 所以删除改成**移入回收站**：
 *   - 文件（切片产物、任务目录）**移动到** `data/trash/<时间>-<taskId>/`，不复制（同盘 mv 是瞬时的）；
 *   - 同时写一份 `manifest.json`：被删任务的完整台账记录 + 每个文件的原始绝对路径；
 *   - 恢复 = 把文件移回原位 + 把台账记录写回（所以清单里必须存整条记录，不能只存路径）。
 *
 * ## 保留策略
 *
 * 默认保留 7 天（`cleanup.trashDays`），由 Cleaner 的周期检查顺带清理，
 * 也可以在界面上手动清空。**只有显式清空才会真正 `rmSync`** ——
 * 换句话说：唯一能不可逆删数据的路径，是用户明确要求的那一次。
 *
 * ## 为什么不用系统回收站
 *
 * Windows 的回收站需要通过 Shell API（`SHFileOperation`）操作，Node 没有内置支持，
 * 且沙箱/无桌面会话下不可靠。自己做一层回收站反而可控：能连台账记录一起存、
 * 能在界面上列出来、能精确恢复。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Ledger } from './ledger.ts';
import type { TaskRecord } from './types.ts';
import { DATA_DIR, exists, fileSize, fmtBytes, nowIso } from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';

export const TRASH_DIR = path.join(DATA_DIR, 'trash');

export interface TrashEntryFile {
  /** 原始绝对路径 */
  from: string;
  /** 相对回收站目录的存放位置 */
  stored: string;
  /** 文件或目录 */
  kind: 'file' | 'dir';
  bytes: number;
}

export interface TrashEntry {
  id: string;
  taskId: string;
  title: string;
  deletedAt: string;
  /** 删除时的任务状态（恢复后能对上） */
  status: string;
  /** 被删文件的原始路径与体积 */
  files: TrashEntryFile[];
  totalBytes: number;
  /** 被删任务的完整台账记录 —— 恢复时写回它，缺了这条就只能恢复文件 */
  task?: TaskRecord;
  /** 删除原因（界面点击 / 测试 / 清理策略） */
  reason?: string;
}

function entryDir(id: string, root: string = TRASH_DIR): string {
  return path.join(root, id);
}

/** 递归统计目录体积（用于清单里显示"释放了多少空间"） */
function dirBytes(p: string): number {
  let total = 0;
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
      else total += fileSize(full);
    }
  };
  walk(p);
  return total;
}

/** 生成一个不会撞车的回收站 id：`20260922-230832-manual-2026...` */
function makeId(taskId: string, root: string = TRASH_DIR, at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const safe = taskId.replace(/[^\w.-]/g, '_').slice(0, 60);
  let id = `${stamp}-${safe}`;
  let n = 2;
  while (exists(entryDir(id, root))) id = `${stamp}-${safe}-${n++}`;
  return id;
}

export interface MoveToTrashInput {
  taskId: string;
  title: string;
  status: string;
  /** 要移入回收站的文件或目录（绝对路径；不存在的会被跳过并记录） */
  paths: string[];
  /** 任务台账记录（有它才能一键恢复任务） */
  task?: TaskRecord;
  reason?: string;
  /**
   * 回收站根目录，默认 `data/trash`。
   *
   * 之所以做成参数：单元测试必须能在临时目录里跑完整流程 ——
   * 一开始没这个参数，测试直接把空条目写进了**真实** `data/trash/`（已修正）。
   */
  root?: string;
  logger?: Logger;
}

/**
 * 把文件/目录移入回收站。
 *
 * 同盘 `rename` 是即时的（不复制字节）；跨盘或权限问题导致 rename 失败时
 * **退回复制再删**，保证"移入回收站"这件事本身不会因为盘符不同而失败。
 * 任何一步失败都不抛错到调用方 —— 删除流程宁可少回收一点，也不能卡住。
 */
export function moveToTrash(input: MoveToTrashInput): { id: string; moved: number; bytes: number; files: TrashEntryFile[]; warnings: string[] } {
  const logger = input.logger ?? globalLog;
  const warnings: string[] = [];
  const root = input.root ?? TRASH_DIR;
  const id = makeId(input.taskId, root);
  const dir = entryDir(id, root);
  const files: TrashEntryFile[] = [];
  let bytes = 0;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    warnings.push(`回收站目录创建失败，将按原样删除：${(e as Error).message}`);
    return { id: '', moved: 0, bytes: 0, files: [], warnings };
  }

  let seq = 0;
  for (const p of input.paths) {
    if (!p || !exists(p)) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(p).isDirectory();
    } catch {
      continue;
    }
    const size = isDir ? dirBytes(p) : fileSize(p);
    const stored = path.join(`${String(++seq).padStart(2, '0')}-${path.basename(p)}`);
    const dest = path.join(dir, stored);
    try {
      try {
        fs.renameSync(p, dest);
      } catch {
        // 跨盘等情况：复制后再删
        fs.cpSync(p, dest, { recursive: true });
        fs.rmSync(p, { recursive: true, force: true });
      }
      files.push({ from: p, stored, kind: isDir ? 'dir' : 'file', bytes: size });
      bytes += size;
    } catch (e) {
      warnings.push(`移入回收站失败（该路径未删除）：${p} —— ${(e as Error).message}`);
    }
  }

  const entry: TrashEntry = {
    id,
    taskId: input.taskId,
    title: input.title,
    deletedAt: nowIso(),
    status: input.status,
    files,
    totalBytes: bytes,
    ...(input.task ? { task: input.task } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };

  // 一个文件都没移走（路径全不存在 / 全失败）→ 不要留下空条目，
  // 否则回收站里会出现一串"0 项 0 B"的垃圾，用户根本分不清哪些值得看
  if (files.length === 0) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { id: '', moved: 0, bytes: 0, files: [], warnings };
  }

  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(entry, null, 2), 'utf8');
  } catch (e) {
    warnings.push(`回收站清单写入失败（文件仍在，但无法一键恢复）：${(e as Error).message}`);
  }

  logger.info(`已移入回收站：${input.title}（${files.length} 项，${fmtBytes(bytes)}，id=${id}）`, {
    mod: 'trash',
    data: { taskId: input.taskId, entryId: id },
  });
  return { id, moved: files.length, bytes, files, warnings };
}

/** 列出回收站里的条目（按删除时间倒序） */
export function listTrash(root: string = TRASH_DIR): TrashEntry[] {
  const out: TrashEntry[] = [];
  if (!exists(root)) return out;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const m = path.join(root, d, 'manifest.json');
    if (!exists(m)) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(m, 'utf8')) as TrashEntry;
      out.push({ ...entry, id: entry.id || d });
    } catch {
      /* 坏清单跳过 */
    }
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/**
 * 从回收站恢复。
 *
 * 恢复顺序：**先写回台账记录，再搬文件** —— 反过来的话，文件搬回去了但台账没写成功，
 * 那些文件就成了谁都认不出的孤儿（占用空间又不会被清理）。
 */
export function restoreFromTrash(
  id: string,
  ledger: Ledger,
  logger: Logger = globalLog,
  root: string = TRASH_DIR,
): { ok: boolean; restored: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const dir = entryDir(id, root);
  const manifest = path.join(dir, 'manifest.json');
  if (!exists(manifest)) return { ok: false, restored: [], warnings: [`回收站里没有这条记录：${id}`] };

  let entry: TrashEntry;
  try {
    entry = JSON.parse(fs.readFileSync(manifest, 'utf8')) as TrashEntry;
  } catch (e) {
    return { ok: false, restored: [], warnings: [`清单读取失败：${(e as Error).message}`] };
  }

  const restored: string[] = [];
  // 1) 先恢复台账（任务已存在就跳过，避免覆盖现有记录的进度）
  if (entry.task) {
    try {
      if (!ledger.getTask(entry.taskId)) {
        ledger.createTask(entry.task);
        restored.push(`台账记录 ${entry.taskId}`);
      } else {
        warnings.push(`台账里已存在任务 ${entry.taskId}，只恢复文件、不覆盖记录`);
      }
    } catch (e) {
      warnings.push(`台账恢复失败（文件仍会恢复）：${(e as Error).message}`);
    }
  } else {
    warnings.push('这条回收站记录里没有台账快照，只能恢复文件');
  }

  // 2) 再搬文件
  for (const f of entry.files) {
    const src = path.join(dir, f.stored);
    if (!exists(src)) {
      warnings.push(`回收站里缺少文件：${f.stored}`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(f.from), { recursive: true });

      /* ⚠️ 目标已存在时的处理（实测踩过）：
       * 恢复台账记录时 `createTask` 会**顺手把任务目录建出来**（空目录），
       * 于是搬目录那一步就撞上"已存在"。如果直接跳过，转写/总结就永远留在回收站里。
       * 所以：目标是目录就**逐项合并**进去（不覆盖已存在的同名文件），目标是文件才跳过。 */
      if (exists(f.from)) {
        const destIsDir = ((): boolean => {
          try {
            return fs.statSync(f.from).isDirectory();
          } catch {
            return false;
          }
        })();
        if (f.kind === 'dir' && destIsDir) {
          let merged = 0;
          let conflicted = 0;
          const mergeInto = (from: string, to: string): void => {
            for (const child of fs.readdirSync(from, { withFileTypes: true })) {
              const s = path.join(from, child.name);
              const d = path.join(to, child.name);
              if (child.isDirectory()) {
                fs.mkdirSync(d, { recursive: true });
                mergeInto(s, d);
                continue;
              }
              if (exists(d)) {
                conflicted++;
                continue;
              }
              fs.mkdirSync(path.dirname(d), { recursive: true });
              fs.renameSync(s, d);
              merged++;
            }
          };
          mergeInto(src, f.from);
          fs.rmSync(src, { recursive: true, force: true });
          restored.push(`${f.from}（合并 ${merged} 项）`);
          if (conflicted > 0) warnings.push(`${f.from}：${conflicted} 个同名文件已存在，保留现有版本`);
          continue;
        }
        warnings.push(`原位置已存在同名文件，跳过：${f.from}`);
        continue;
      }

      try {
        fs.renameSync(src, f.from);
      } catch {
        fs.cpSync(src, f.from, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
      }
      restored.push(f.from);
    } catch (e) {
      warnings.push(`恢复失败：${f.from} —— ${(e as Error).message}`);
    }
  }

  // 3) 全部搬空才删掉回收站条目；否则留着让人能再试
  try {
    const left = fs.readdirSync(dir).filter((x) => x !== 'manifest.json');
    if (left.length === 0) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  logger.info(`已从回收站恢复 ${entry.taskId}：${restored.length} 项`, {
    mod: 'trash',
    data: { entryId: id, warnings: warnings.length },
  });
  return { ok: restored.length > 0, restored, warnings };
}

/** 彻底清空回收站（或只清超过 N 天的）—— 唯一会真正 rmSync 的地方 */
export function purgeTrash(opts: { olderThanDays?: number; ids?: string[]; logger?: Logger; root?: string } = {}): { purged: number; bytes: number } {
  const logger = opts.logger ?? globalLog;
  const cutoff = opts.olderThanDays && opts.olderThanDays > 0 ? Date.now() - opts.olderThanDays * 86400_000 : undefined;
  let purged = 0;
  let bytes = 0;
  for (const e of listTrash(opts.root)) {
    if (opts.ids && !opts.ids.includes(e.id)) continue;
    if (cutoff !== undefined && Date.parse(e.deletedAt) > cutoff) continue;
    try {
      fs.rmSync(entryDir(e.id, opts.root), { recursive: true, force: true });
      purged++;
      bytes += e.totalBytes;
    } catch (err) {
      logger.warn(`清空回收站条目失败：${e.id} —— ${(err as Error).message}`, { mod: 'trash' });
    }
  }
  if (purged > 0) logger.info(`已清空回收站 ${purged} 项，释放 ${fmtBytes(bytes)}`, { mod: 'trash' });
  return { purged, bytes };
}

/** 回收站占用 */
export function trashStats(root: string = TRASH_DIR): { entries: number; bytes: number } {
  const list = listTrash(root);
  return { entries: list.length, bytes: list.reduce((a, e) => a + e.totalBytes, 0) };
}
