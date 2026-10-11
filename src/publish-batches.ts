/**
 * 投稿**批次账**：把"一次投稿"当成一个有身份的对象记下来（2026-10-11，优化第一批 P1-1）。
 *
 * 为什么需要它（实测教训）：原来确认一次投稿有没有落地，靠的是**逐片按标题模糊匹配**
 * 目标稿件的分P 列表（`confirmPublished`）—— 这条链路上出过好几次事故：
 *   · 2026-09-23：同一稿件追加 4 次，biliLive-tools 全部回 `completed`，B站 侧只涨了第 1 次；
 *   · 2026-10-10：一场被跑了 8 次投稿，其中一片被投两次（两个 uploadTaskId）而 B站 侧一条没落地；
 *   · 反复出现的「已提交待确认」卡住，根因都是"我们不知道这次提交**本该**产生哪几个分P"。
 *
 * 记下批次之后能做三件原来做不到的事：
 *   ① 确认时直接按批次对账（这批该有哪几个标题、投到了哪个 aid），不用再靠猜；
 *   ② 出问题时能说清"**这一批** 3 个分P 只落地 2 个"，而不是笼统的"某片没出现"；
 *   ③ 事后复盘（投稿体检 / 界面）有据可查：谁在什么时候往哪个稿件投了什么。
 *
 * 存储：**复用 `data/publish-log.jsonl`**（与 submit/confirm 同一份流水，按 taskId 串起来看最方便），
 * 用独立的 action 名区分，老的读法（publish-audit）只认 submit/confirm/fail，不会被这些行干扰。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './util.ts';
import { appendJsonl, readJsonl } from './util.ts';
import { nowIso } from './util.ts';

export type BatchKind = 'append' | 'create' | 'single';

export interface BatchRow {
  at: string;
  action: 'batch-submit' | 'batch-landed' | 'batch-failed' | 'batch-unconfirmed';
  taskId: string;
  /** biliLive-tools 的上传任务 id —— 它就是**批次的身份**（一次上传 = 一个 id） */
  uploadTaskId: string;
  kind: BatchKind;
  /** 目标稿件（续传时有；新建稿件时只有 bvid 要等反查） */
  aid?: string;
  bvid?: string;
  /** 这批**本该**产生哪些分P（对账的依据） */
  titles?: string[];
  clipIndices?: number[];
  /** 结果行专用 */
  landed?: string[];
  missing?: string[];
  note?: string;
}

/** 一个批次的当前状态（把同 uploadTaskId 的多行归并成一条，以最后一行为准） */
export interface Batch {
  uploadTaskId: string;
  taskId: string;
  kind: BatchKind;
  at: string;
  aid?: string;
  bvid?: string;
  titles: string[];
  clipIndices: number[];
  status: 'submitted' | 'landed' | 'failed' | 'unconfirmed';
  landed: string[];
  missing: string[];
  note?: string;
  /** 最近一次状态更新的时刻（用来算"提交多久了还没落地"） */
  updatedAt: string;
}

function logPath(opts: { logPath?: string } = {}): string {
  return opts.logPath ?? path.join(DATA_DIR, 'publish-log.jsonl');
}

function write(row: Omit<BatchRow, 'at'> & { at?: string }, opts: { logPath?: string } = {}): void {
  const full: BatchRow = { ...row, at: row.at ?? nowIso() } as BatchRow;
  appendJsonl(logPath(opts), full);
}

/** 记录"刚提交了一批"（在 biliUpload 成功之后立刻写） */
export function recordBatchSubmit(
  entry: {
    taskId: string;
    uploadTaskId: string;
    kind: BatchKind;
    aid?: string;
    bvid?: string;
    titles: string[];
    clipIndices: number[];
  },
  opts: { logPath?: string } = {},
): void {
  write(
    {
      action: 'batch-submit',
      taskId: entry.taskId,
      uploadTaskId: entry.uploadTaskId,
      kind: entry.kind,
      ...(entry.aid ? { aid: entry.aid } : {}),
      ...(entry.bvid ? { bvid: entry.bvid } : {}),
      titles: entry.titles,
      clipIndices: entry.clipIndices,
    },
    opts,
  );
}

/** 记录这一批的结果（落地 / 失败 / 未确认）——**追加**一行，读取时以最后一行为准 */
export function recordBatchOutcome(
  entry: {
    taskId: string;
    uploadTaskId: string;
    kind: BatchKind;
    status: 'landed' | 'failed' | 'unconfirmed';
    aid?: string;
    bvid?: string;
    landed?: string[];
    missing?: string[];
    note?: string;
  },
  opts: { logPath?: string } = {},
): void {
  write(
    {
      action: entry.status === 'landed' ? 'batch-landed' : entry.status === 'failed' ? 'batch-failed' : 'batch-unconfirmed',
      taskId: entry.taskId,
      uploadTaskId: entry.uploadTaskId,
      kind: entry.kind,
      ...(entry.aid ? { aid: entry.aid } : {}),
      ...(entry.bvid ? { bvid: entry.bvid } : {}),
      ...(entry.landed ? { landed: entry.landed } : {}),
      ...(entry.missing ? { missing: entry.missing } : {}),
      ...(entry.note ? { note: entry.note.slice(0, 300) } : {}),
    },
    opts,
  );
}

/** 读出所有批次（按 uploadTaskId 归并，最后一行为准）。可按任务过滤。 */
export function readBatches(taskId?: string, opts: { logPath?: string } = {}): Batch[] {
  const rows = readJsonl<BatchRow>(logPath(opts)).filter((r) => typeof r?.action === 'string' && r.action.startsWith('batch-'));
  const byId = new Map<string, Batch>();
  for (const r of rows) {
    if (taskId && r.taskId !== taskId) continue;
    const id = String(r.uploadTaskId ?? '');
    if (!id) continue;
    const prev = byId.get(id);
    const base: Batch =
      prev ??
      ({
        uploadTaskId: id,
        taskId: r.taskId,
        kind: r.kind,
        at: r.at,
        titles: r.titles ?? [],
        clipIndices: r.clipIndices ?? [],
        status: 'submitted',
        landed: [],
        missing: [],
        updatedAt: r.at,
      } satisfies Batch);
    if (r.aid) base.aid = r.aid;
    if (r.bvid) base.bvid = r.bvid;
    if (r.titles?.length) base.titles = r.titles;
    if (r.clipIndices?.length) base.clipIndices = r.clipIndices;
    if (r.action === 'batch-landed') {
      base.status = 'landed';
      base.landed = r.landed ?? base.titles;
      base.missing = r.missing ?? [];
    } else if (r.action === 'batch-failed') {
      base.status = 'failed';
      base.missing = r.missing ?? base.titles;
    } else if (r.action === 'batch-unconfirmed') {
      base.status = 'unconfirmed';
      base.landed = r.landed ?? [];
      base.missing = r.missing ?? [];
    }
    if (r.note) base.note = r.note;
    base.updatedAt = r.at;
    byId.set(id, base);
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** 还没落地、也没明确失败的批次（反查要盯的就是这些） */
export function readOpenBatches(taskId?: string, opts: { logPath?: string } = {}): Batch[] {
  return readBatches(taskId, opts).filter((b) => b.status === 'submitted' || b.status === 'unconfirmed');
}

/** 批次年龄（分钟）：用来判断"提交多久了还没落地，该不该告警" */
export function batchAgeMinutes(b: Batch, now: number = Date.now()): number {
  const t = Date.parse(b.at);
  return Number.isFinite(t) ? Math.round((now - t) / 60_000) : 0;
}

/* ============================================================================
 * 重复分P 检测（2026-10-11 优化第二批 ①）
 *
 * 实测教训：稿件 `BV1oWpG69Etu` 里有一对**标题完全相同的分P**（同一段内容被投了两次），
 * 是修复前"一场被跑 8 次投稿"的遗留 —— 只能靠人眼看出来。这里把判据固定下来：
 * 同一稿件里**规范化标题重复**即视为重复分P（规范化 = 去空白，与落地确认同一口径）。
 *
 * 只报告、不自动删（B站 没有开放接口能删单个分P），也不影响任何投稿决策。
 * ========================================================================== */

/** 在同一稿件的分P 标题里找出重复项（返回规范化标题 → 出现次数） */
export function findDuplicateTitles(titles: string[]): Array<{ title: string; count: number }> {
  const count = new Map<string, { title: string; count: number }>();
  for (const raw of titles) {
    const norm = String(raw ?? '').replace(/\s+/g, '').trim();
    if (!norm) continue;
    const cur = count.get(norm);
    if (cur) cur.count++;
    else count.set(norm, { title: String(raw), count: 1 });
  }
  return [...count.values()].filter((x) => x.count > 1).sort((a, b) => b.count - a.count);
}

export interface DuplicatePartsFinding {
  at: string;
  bvid: string;
  titles: string[];
  /** 这个稿件上一次被发现重复的时刻（用来判断"新发现"还是"老问题"） */
  firstSeenAt?: string;
}

/**
 * 记下"这个稿件有重复分P"。**只在重复集合变化时写**（否则每 5 分钟一轮反查会刷爆日志）。
 * 返回 true = 这次真的写了新记录。
 */
export function recordDuplicateParts(
  entry: { bvid: string; titles: string[] },
  opts: { logPath?: string } = {},
): boolean {
  const prev = readRecentDuplicateParts(opts).get(entry.bvid);
  const same =
    prev && prev.titles.length === entry.titles.length && prev.titles.every((t, i) => t === entry.titles[i]);
  if (same) return false;
  write(
    {
      action: 'duplicate-parts' as never,
      taskId: '',
      uploadTaskId: entry.bvid,
      kind: 'append' as never,
      note: entry.titles.join(' ｜ ').slice(0, 300),
      ...(prev ? { missing: undefined } : {}),
    } as never,
    opts,
  );
  return true;
}

/** 读最近的重复分P 记录（每个 bvid 取最后一次） */
export function readRecentDuplicateParts(opts: { logPath?: string; sinceMs?: number } = {}): Map<string, DuplicatePartsFinding> {
  const since = opts.sinceMs ?? Date.now() - 7 * 86400_000;
  const out = new Map<string, DuplicatePartsFinding>();
  for (const row of readJsonl<Record<string, unknown>>(logPath(opts))) {
    if (row['action'] !== 'duplicate-parts') continue;
    const bvid = String(row['uploadTaskId'] ?? '');
    const at = String(row['at'] ?? '');
    if (!bvid || Date.parse(at) < since) continue;
    const titles = String(row['note'] ?? '')
      .split('｜')
      .map((s) => s.trim())
      .filter(Boolean);
    const prev = out.get(bvid);
    out.set(bvid, { at, bvid, titles, ...(prev?.firstSeenAt ? { firstSeenAt: prev.firstSeenAt } : { firstSeenAt: at }) });
  }
  return out;
}

/** 供测试/工具清空（只删 batch- 行，不动 submit/confirm 流水） */export function pruneBatchRows(opts: { logPath?: string } = {}): number {
  const p = logPath(opts);
  if (!fs.existsSync(p)) return 0;
  const keep = fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.includes('"action":"batch-'))
  fs.writeFileSync(p, keep.length ? `${keep.join('\n')}\n` : '', 'utf8');
  return keep.length;
}
