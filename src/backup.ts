/**
 * 数据备份（2026-10-12，优化清单 P0-2 / F6）。
 *
 * 风险背景：`data/ledger.json` 是**唯一真相来源** —— 场次、切片、**指纹**（防重复投稿）、
 * **墓碑**（防重投已删内容）、已发布标题都在里面。它只做了原子写（防写坏），原本**没有备份**
 * （不防误删、磁盘故障、或某次改动的逻辑错误）。一旦损坏：重复投稿的两道防线与历史统计同时归零。
 *
 * 本文件是**唯一实现**：CLI（`tools/backup-data.ts` / `npm run backup:data`）与守护进程的每日 tick
 * 都调它，避免"两个地方各写一份备份逻辑"（那正是这个仓库踩过的坑）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './util.ts';

/** 只备份这些（存在才备）：台账 + 各类流水 + 小配置。媒体类永不进备份。 */
const FILES = [
  'ledger.json',
  'decisions.jsonl',
  'publish-log.jsonl',
  'performance.jsonl',
  'errors.jsonl',
  'pending-delete.json',
  'glossary.json',
  'trash.json',
];
const MAX_BYTES = 32 * 1024 * 1024;

export interface BackupResult {
  /** 备份目录（dryRun 时为"将要写入"的路径） */
  dir: string;
  files: Array<{ name: string; size: number; sha: string }>;
  bytes: number;
  /** 本次轮转删除的旧备份目录名 */
  rotated: string[];
  /** 当前保留份数（dryRun 时不统计） */
  kept: number;
  skippedLarge: string[];
  dryRun: boolean;
  error?: string;
}

/**
 * 备份一次并轮转。
 * - `keep`：保留最近多少份（默认 14）；
 * - `dryRun`：只算不写（CLI 的默认是写，dry-run 由参数开启）；
 * - 任何异常都被吞成 `error` 字段：**备份失败不许影响调用方**（尤其是每日 tick）。
 */
export function runDataBackup(opts: { dataDir?: string; keep?: number; dryRun?: boolean; now?: Date } = {}): BackupResult {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const keep = Math.max(1, opts.keep ?? 14);
  const dryRun = Boolean(opts.dryRun);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupDir = path.join(dataDir, 'backup');
  const dir = path.join(backupDir, stamp);
  const out: BackupResult = { dir, files: [], bytes: 0, rotated: [], kept: 0, skippedLarge: [], dryRun };

  try {
    for (const name of FILES) {
      const src = path.join(dataDir, name);
      if (!fs.existsSync(src)) continue;
      const st = fs.statSync(src);
      if (!st.isFile()) continue;
      if (st.size > MAX_BYTES) {
        out.skippedLarge.push(name);
        continue;
      }
      const buf = fs.readFileSync(src);
      out.files.push({ name, size: st.size, sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) });
      out.bytes += st.size;
    }
    if (out.files.length === 0) return out;
    if (dryRun) return out;

    fs.mkdirSync(dir, { recursive: true });
    for (const f of out.files) fs.copyFileSync(path.join(dataDir, f.name), path.join(dir, f.name));
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ at: new Date().toISOString(), host: process.env['COMPUTERNAME'] ?? '', files: out.files }, null, 1),
      'utf8',
    );

    /* 轮转：目录名就是 ISO 时间戳，字典序即时间序 */
    const dirs = fs
      .readdirSync(backupDir)
      .filter((d) => {
        try {
          return fs.statSync(path.join(backupDir, d)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      fs.rmSync(path.join(backupDir, d), { recursive: true, force: true });
      out.rotated.push(d);
    }
    out.kept = fs.readdirSync(backupDir).filter((d) => fs.statSync(path.join(backupDir, d)).isDirectory()).length;
    return out;
  } catch (e) {
    /* 备份失败不抛：调用方（每日 tick / CLI）自己决定怎么记日志 */
    out.error = (e as Error).message;
    return out;
  }
}

/** 给日志用的一句话摘要 */
export function summarizeBackup(r: BackupResult): string {
  if (r.error) return `数据备份失败：${r.error}`;
  if (r.files.length === 0) return '数据备份：没有可备份的文件（首次运行？）';
  const mb = (r.bytes / 1024).toFixed(1);
  if (r.dryRun) return `数据备份（dry-run）：将备份 ${r.files.length} 个文件 / ${mb} KB → ${path.basename(r.dir)}`;
  return (
    `数据备份完成：${r.files.length} 个文件 / ${mb} KB → ${path.basename(r.dir)}` +
    (r.rotated.length ? `；轮转删除 ${r.rotated.length} 份旧备份` : '') +
    `；当前保留 ${r.kept} 份`
  );
}
