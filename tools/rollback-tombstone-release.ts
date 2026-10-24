/**
 * 回滚**误解除**的墓碑（2026-10-17 事故专用，但按时间窗通用）。
 *
 * ## 事故回顾（docs/待修问题-墓碑误解除与分页判据-2026-10-17.md）
 *
 * 稿件列表分页判据被服务端截断击穿（请求 pageSize=100 实际只回 10 条，旧判据误以为拿全），
 * 自动核对把「旧稿件 BV1nMJy65E92 不在（残缺的）列表里 + 详情报『啥都木有』」当成了
 * 「稿件已删」，4 秒内误解除了 18 条正当事的防重复墓碑 —— 那些片段若重跑/重投，
 * B站 上会真的多出重复稿件。
 *
 * ## 恢复数据从哪来（按优先级）
 *
 * 1. **台账备份快照**：`data/ledger-backup/*.json` 与 `data/backup/<时间戳>/ledger.json` 里
 *    的 `tombstones` 表 —— 字段最全（at/retiredAt/reason/status 都是原始值）；
 * 2. **重建**：运行日志里「指纹转为墓碑」的留痕（taskId/clipIndex/title/bvid/reason/retiredAt）
 *    + publish-log 里同 taskId+clipIndex 的 submit/confirm 记录（at/status）。
 *
 * 只补**当前不存在**的指纹；已在的不动。每条恢复留痕 `tombstone-restore`。
 *
 * ⚠️ **必须先停服务再 --apply**：服务进程持有台账内存副本，边跑边写会被下次 flush 覆盖。
 *    预演（默认）随时可以跑。
 *
 * 用法：
 *   node tools/rollback-tombstone-release.ts                       # 预演（默认事故时间窗）
 *   node tools/rollback-tombstone-release.ts --apply               # 真的恢复（先停服务！）
 *   node tools/rollback-tombstone-release.ts --from <iso> --to <iso> [--apply]  # 自定义时间窗
 */
import fs from 'node:fs';
import path from 'node:path';
import { ledger } from '../src/ledger.ts';
import type { FingerprintTombstone } from '../src/ledger.ts';

const apply = process.argv.includes('--apply');
const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
/** 默认窗口：事故那 4 秒（UTC），留 0.5s 余量 */
const fromIso = argOf('--from') ?? '2026-10-16T16:58:30.000Z';
const toIso = argOf('--to') ?? '2026-10-16T16:58:35.000Z';
const fromMs = Date.parse(fromIso);
const toMs = Date.parse(toIso);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
  console.error('时间窗格式不对（要 ISO，如 2026-10-16T16:58:30.000Z）');
  process.exit(1);
}
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

/* ---- ① 从 publish-log 找出窗口内的 tombstone-release（带 bvid 的） ---- */
const publishLog = ledger.readPublishLog();
const releases = publishLog
  .filter((r) => r['action'] === 'tombstone-release')
  .filter((r) => typeof r['bvid'] === 'string' && String(r['bvid']).length > 0)
  .map((r) => ({ at: Date.parse(String(r['at'])), rec: r }))
  .filter((x) => Number.isFinite(x.at) && x.at >= fromMs && x.at <= toMs);
const targets = new Map<string, { fp: string; taskId: string; clipIndex: number; title?: string; bvid: string; at: string }>();
for (const { rec } of releases) {
  const fp = String(rec['fingerprint'] ?? '');
  if (!fp || targets.has(fp)) continue;
  targets.set(fp, {
    fp,
    taskId: String(rec['taskId'] ?? ''),
    clipIndex: typeof rec['clipIndex'] === 'number' ? rec['clipIndex'] : -1,
    ...(typeof rec['title'] === 'string' && rec['title'] ? { title: rec['title'] } : {}),
    bvid: String(rec['bvid']),
    at: String(rec['at']),
  });
}
console.log(bold(`墓碑误解除回滚${apply ? '（--apply：会真的恢复）' : '（预演，不改台账）'}`));
console.log(`  时间窗 ${fromIso} ~ ${toIso}；窗口内 tombstone-release（带 bvid）共 ${targets.size} 条`);
if (targets.size === 0) {
  console.log('  没有要回滚的记录，结束。');
  process.exit(0);
}

/* ---- ② 恢复来源 1：台账备份快照 ---- */
const baseDir = path.dirname(ledger.path);
const snapshotPaths = [
  ...globFiles(path.join(baseDir, 'ledger-backup'), /\.json$/),
  ...globFiles(path.join(baseDir, 'backup'), /ledger\.json$/),
].sort();
const recovered = new Map<string, FingerprintTombstone>();
const recoveredFrom = new Map<string, string>();
for (const p of snapshotPaths) {
  if (recovered.size === targets.size) break;
  let tomb: Record<string, unknown> = {};
  try {
    tomb = (JSON.parse(fs.readFileSync(p, 'utf8')) as { tombstones?: Record<string, unknown> }).tombstones ?? {};
  } catch {
    continue; // 快照读不动就跳过（可能有半个写坏的历史文件）
  }
  for (const fp of targets.keys()) {
    if (recovered.has(fp)) continue;
    const t = tomb[fp];
    if (!t || typeof t !== 'object') continue;
    const rec = t as Partial<FingerprintTombstone>;
    if (typeof rec.taskId !== 'string' || typeof rec.retiredAt !== 'string' || typeof rec.reason !== 'string') continue;
    recovered.set(fp, rec as FingerprintTombstone);
    recoveredFrom.set(fp, path.relative(baseDir, p));
  }
}

/* ---- ③ 恢复来源 2：日志「指纹转为墓碑」留痕 + publish-log submit/confirm 重建 ----
   缺的按保守值补：at 用 submit 时刻（没有就用墓碑创建时刻）、status 有 confirm 记录就是
   PUBLISHED（有 bvid 说明确实投出去了），否则 SUBMITTED。 */
const missing = [...targets.keys()].filter((fp) => !recovered.has(fp));
/* publish-log 一次性建索引：同 taskId+clipIndex 的最早 submit 时刻 / 是否有 confirm（恢复字段用） */
const submitAtMap = new Map<string, string>();
const confirmSet = new Set<string>();
for (const r of publishLog) {
  const key = `${r['taskId']}#${r['clipIndex']}`;
  if (r['action'] === 'submit') {
    const at = String(r['at'] ?? '');
    if (at && (!submitAtMap.has(key) || at < submitAtMap.get(key)!)) submitAtMap.set(key, at);
  } else if (r['action'] === 'confirm') {
    confirmSet.add(key);
  }
}
if (missing.length > 0) {
  const creationEvents = scanTombstoneCreationLogs(path.join(baseDir, 'logs'), missing);
  for (const fp of missing) {
    const t = targets.get(fp)!;
    const ev = creationEvents.get(fp);
    const key = `${t.taskId}#${t.clipIndex}`;
    recovered.set(fp, {
      taskId: ev?.taskId ?? t.taskId,
      clipIndex: ev?.clipIndex ?? t.clipIndex,
      ...(t.title ? { title: t.title } : {}),
      bvid: t.bvid,
      at: submitAtMap.get(key) ?? ev?.ts ?? t.at,
      retiredAt: ev?.ts ?? t.at,
      reason: (ev?.reason as FingerprintTombstone['reason']) ?? 'task-deleted',
      status: (confirmSet.has(key) ? 'PUBLISHED' : 'SUBMITTED') as FingerprintTombstone['status'],
    });
    recoveredFrom.set(fp, ev?.source ?? 'publish-log 重建');
  }
}

/* ---- ④ 展示 ---- */
const existing = new Set(ledger.listTombstones().map((t) => t.fingerprint));
console.log('');
for (const [fp, t] of recovered) {
  const flag = existing.has(fp) ? '（已在台账，跳过）' : apply ? '→ 将恢复' : '→ 可恢复';
  console.log(`  ${flag} ${fp}`);
  console.log(`      「${t.title ?? '(无标题)'}」 ${t.bvid}  ${t.taskId}#${t.clipIndex}`);
  console.log(`      at=${t.at} retiredAt=${t.retiredAt} reason=${t.reason} status=${t.status}  来源：${recoveredFrom.get(fp)}`);
}
const toRestore = Object.fromEntries([...recovered].filter(([fp]) => !existing.has(fp)));
console.log('');
console.log(bold(`结果：窗口内误解除 ${targets.size} 条，已从备份/日志找回 ${recovered.size} 条，其中待恢复 ${Object.keys(toRestore).length} 条（其余已在台账）`));
if (!apply) {
  if (Object.keys(toRestore).length > 0) console.log('  确认无误后：先停服务，再加 --apply 重新运行。');
  process.exit(0);
}
if (Object.keys(toRestore).length === 0) {
  console.log('  没有需要恢复的，结束。');
  process.exit(0);
}
const r = ledger.restoreTombstones(toRestore, { note: `回滚 2026-10-17 误解除（分页判据击穿事故，见 docs/待修问题-墓碑误解除与分页判据-2026-10-17.md）` });
console.log(bold(`已恢复 ${r.restored.length} 条，跳过（已存在）${r.skipped.length} 条；台账现共 ${ledger.tombstoneCount()} 条墓碑`));
console.log('  留痕：data/publish-log.jsonl 里每条都有 tombstone-restore 记录。');

/* ======================================================================== */

function globFiles(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 3) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (re.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/** 在运行日志里找「指纹转为墓碑」留痕（retiredAt 的来源；含毫秒时间戳） */
function scanTombstoneCreationLogs(logsDir: string, fps: string[]): Map<string, { ts: string; taskId: string; clipIndex: number; reason: string; source: string }> {
  const want = new Set(fps);
  const out = new Map<string, { ts: string; taskId: string; clipIndex: number; reason: string; source: string }>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(logsDir).filter((f) => /^live_auto-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    if (out.size === want.size) break;
    const p = path.join(logsDir, f);
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(p, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('指纹转为墓碑')) continue;
      let e: { ts?: string; taskId?: string; data?: Record<string, unknown> };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const fp = String(e.data?.['fp'] ?? '');
      if (!want.has(fp) || out.has(fp)) continue;
      if (typeof e.ts !== 'string') continue;
      /* ⚠ taskId 在日志条目的**顶层**（logger 的字段布局），不在 data 里 ——
         第一版读错了位置，恢复出来的 9 条 taskId 变成了空串（2026-10-17 实测）。 */
      out.set(fp, {
        ts: e.ts,
        taskId: String(e.taskId ?? ''),
        clipIndex: typeof e.data?.['clipIndex'] === 'number' ? (e.data['clipIndex'] as number) : -1,
        reason: String(e.data?.['reason'] ?? 'task-deleted'),
        source: `logs/${f}`,
      });
    }
  }
  return out;
}
