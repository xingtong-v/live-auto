/**
 * 待办闭环：忽略 / 已处理（2026-10-13，优化清单 P0-3）。
 *
 * 为什么需要：统一待办上线后只能"去处理"。看得到、点不走 ⇒ 条目会反复出现，久了就没人看了。
 * 这里给每条待办（按 key）两个动作：
 *   · snooze：忽略 N 小时（默认 24），到点自动重新出现；
 *   · done：已处理，永久隐藏（可用 undismiss 恢复）。
 *
 * 存储：data/todo-dismiss.jsonl（追加写、以最后一行为准，沿用仓库 jsonl 约定）。
 * 只记 key 与时间，不记内容 —— 待办本身是从台账实时算出来的，不需要冗余。
 */
import path from 'node:path';
import { DATA_DIR, appendJsonl, readJsonl } from './util.ts';

export interface DismissRow {
  at: string;
  key: string;
  mode: 'snooze' | 'done' | 'restore';
  until?: string;
  note?: string;
}

function logPath(dataDir?: string): string {
  return path.join(dataDir ?? DATA_DIR, 'todo-dismiss.jsonl');
}

/** 生效中的隐藏项：key → { mode, until } */
export function readDismissals(opts: { dataDir?: string; now?: number } = {}): Map<string, { mode: 'snooze' | 'done'; until?: string }> {
  const now = opts.now ?? Date.now();
  const out = new Map<string, { mode: 'snooze' | 'done'; until?: string }>();
  for (const row of readJsonl<DismissRow>(logPath(opts.dataDir))) {
    if (!row?.key) continue;
    if (row.mode === 'restore') out.delete(row.key);
    else if (row.mode === 'done') out.set(row.key, { mode: 'done' });
    else if (row.mode === 'snooze') {
      const until = row.until ?? '';
      if (until && Date.parse(until) > now) out.set(row.key, { mode: 'snooze', until });
      else out.delete(row.key);
    }
  }
  return out;
}

export function dismissTodo(entry: { key: string; mode: 'snooze' | 'done'; hours?: number; note?: string }, opts: { dataDir?: string } = {}): DismissRow {
  const hours = Math.min(24 * 30, Math.max(1, entry.hours ?? 24));
  const until = entry.mode === 'snooze' ? new Date(Date.now() + hours * 3600_000).toISOString() : undefined;
  const row: DismissRow = { at: new Date().toISOString(), key: entry.key, mode: entry.mode, ...(until ? { until } : {}), ...(entry.note ? { note: entry.note } : {}) };
  appendJsonl(logPath(opts.dataDir), row);
  return row;
}

export function undismissTodo(key: string, opts: { dataDir?: string } = {}): void {
  appendJsonl(logPath(opts.dataDir), { at: new Date().toISOString(), key, mode: 'restore' } satisfies DismissRow);
}
