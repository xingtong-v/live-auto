/**
 * 清理"验证/调试产物"（2026-10-14，优化清单 P2）。
 *
 * 背景（实测）：data/ 一度 17.45 GB / 807 文件，其中约 3.1 GB 是可再生成的验证/调试产物
 * （ASR 标定素材、字幕检查输出、试看临时转码副本、抽帧、验收截图…）。这些**不是用户数据**
 * （切片、录像、回收站里的东西才是）。
 *
 * 本文件是**唯一实现**：CLI（`tools/clean-artifacts.ts` / `npm run clean:artifacts`）与
 * 守护进程的每日 tick 都调它 —— 避免"CLI 与定时任务各写一套清理逻辑"（备份那次踩过同一个坑）。
 *
 * 安全设计（宁可不删，不许误删）：
 *   1. 每个目标目录有**显式规则**（扩展名白/黑名单 + 是否按天数），不搞通配删除；
 *   2. 明确保护：trash（用户回收站）、logs、backup（备份！）、asr-cache、tasks、*.jsonl 台账；
 *   3. 只删"超过 N 天"的（默认 7 天）—— 今天的验收截图还留着；
 *   4. `local-asr-test` 里只保留 `sample-300s.*`（tools/local-asr/timing.ts 真正读的基准素材）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './util.ts';

interface Target {
  /** 相对 data/ 的目录 */
  dir: string;
  /** 只删这些扩展名（空数组 = 全部） */
  exts: string[];
  /** 需要超过 keepDays 才删 */
  aged: boolean;
  why: string;
}

const TARGETS: Target[] = [
  { dir: 'local-asr-test', exts: [], aged: true, why: 'ASR 标定/探针的中间素材（含大体积 flv）' },
  { dir: 'fixed-clips', exts: [], aged: true, why: '切片校验的固定夹具产物' },
  { dir: 'subtitle-check', exts: [], aged: true, why: '字幕检查输出' },
  { dir: 'preview', exts: [], aged: true, why: '试看用的临时转码副本' },
  { dir: 'ui-shots', exts: [], aged: true, why: '界面截图（验收用）' },
  { dir: 'verify-shots', exts: [], aged: true, why: '验收截图（验收用）' },
  { dir: '_framecheck', exts: [], aged: false, why: '抽帧调试产物（一律可删）' },
];

/** 明确保护，永不进入清理范围（写在这里以便 review） */
const PROTECTED = ['trash', 'logs', 'asr-cache', 'tasks', 'glossary.json', 'backup'];

export interface CleanupResult {
  removed: number;
  bytes: number;
  byTarget: Record<string, { n: number; b: number }>;
  /** 因为"还在保留期内"而跳过的文件数 */
  skippedRecent: number;
  dryRun: boolean;
  keepDays: number;
  error?: string;
}

/** 执行一次清理（默认 dry-run；失败不抛，由调用方决定怎么记日志） */
export function runArtifactCleanup(opts: { dataDir?: string; keepDays?: number; dryRun?: boolean } = {}): CleanupResult {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const keepDays = Math.max(0, opts.keepDays ?? 7);
  const dryRun = Boolean(opts.dryRun);
  const cutoff = Date.now() - keepDays * 86400_000;
  const out: CleanupResult = { removed: 0, bytes: 0, byTarget: {}, skippedRecent: 0, dryRun, keepDays };

  try {
    const plan: Array<{ abs: string; size: number; target: string }> = [];
    for (const t of TARGETS) {
      if (PROTECTED.includes(t.dir)) continue;
      const root = path.join(dataDir, t.dir);
      if (!fs.existsSync(root)) continue;
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(full);
            continue;
          }
          /* 只保留 timing.ts 真正读的基准素材（白名单写成完整文件名，不是扩展名） */
          if (e.name === 'sample-300s.flv' || e.name === 'sample-300s.json') continue;
          const ext = path.extname(e.name).toLowerCase();
          if (t.exts.length > 0 && !t.exts.includes(ext)) continue;
          const st = fs.statSync(full);
          if (t.aged && st.mtimeMs > cutoff) {
            out.skippedRecent++;
            continue;
          }
          plan.push({ abs: full, size: st.size, target: t.dir });
        }
      };
      walk(root);
    }

    for (const p of plan) {
      const g = (out.byTarget[p.target] = out.byTarget[p.target] ?? { n: 0, b: 0 });
      g.n++;
      g.b += p.size;
      out.bytes += p.size;
    }
    if (dryRun) {
      out.removed = plan.length;
      return out;
    }

    for (const p of plan) {
      try {
        fs.rmSync(p.abs, { force: true });
        out.removed++;
      } catch {
        /* 单个文件删不掉（占用等）不影响其它 */
      }
      /* 顺手清掉删空了的目录（只删这一层，不递归） */
      try {
        const parent = path.dirname(p.abs);
        if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      } catch {
        /* ignore */
      }
    }
    return out;
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }
}

/** 给日志用的一句话摘要 */
export function summarizeCleanup(r: CleanupResult): string {
  if (r.error) return `验证产物清理失败：${r.error}`;
  const mb = (r.bytes / 1024 ** 2).toFixed(1);
  if (r.removed === 0) return `验证产物清理：没有超过 ${r.keepDays} 天的文件可清（跳过 ${r.skippedRecent} 个新文件）`;
  const detail = Object.entries(r.byTarget)
    .map(([k, v]) => `${k} ${v.n}`)
    .join('、');
  return `验证产物清理${r.dryRun ? '（dry-run）' : ''}：删除 ${r.removed} 个文件 / ${mb} MB（${detail}）；跳过 ${r.skippedRecent} 个新文件`;
}
