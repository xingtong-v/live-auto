/**
 * P 系列性能修复的回归测试（2026-10-16）。
 *
 * 这些改动都动在"热路径"上，而且**行为等价性**是它们的全部意义，所以必须有机检：
 *   ① **日志轮转**（`src/logger.ts`）：判据从"每行 statSync"换成内存字节计数。
 *      附带修掉一个既存 bug —— 旧实现 `stream.end()` 之后立刻 `renameSync` 在 Windows 上
 *      必然 EPERM，于是"每行 stat 一次却从未真正轮转过"。现在改成**切到新文件**而不是改名。
 *      断言：真会轮转、不丢行、不产生坏行、单文件不超限太多。
 *   ② **readJsonl 尾部回读**（`src/util.ts`）：`limit` / `sinceMs` 不再"整读再切片"。
 *      断言：与旧算法（整读 + 过滤 + 切片）**逐字节等价**，含 UTF-8 跨块边界、
 *      超长单行、无尾换行、坏行、空文件、回读上限兜底。
 *   ③ **台账进度降频**（`src/ledger.ts`）：progress-only 更新不再每 300ms 全量重写台账。
 *      断言：5 秒窗口内不写盘、内存视图仍最新、其它字段照旧立即落盘、flush 能带上进度。
 *   ④ **ASR 缓存索引上限**（`src/asr.ts`）：索引改为 LRU 有界，`stats()` 改扫目录。
 *      断言：超限被淘汰、被淘汰的条目仍能从磁盘读回、LRU 保住热条目、stats 不受淘汰影响。
 *
 * 全部在临时目录里做，不碰真实 data/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Logger } from '../src/logger.ts';
import { readJsonl } from '../src/util.ts';
import { Ledger } from '../src/ledger.ts';
import { AsrCache } from '../src/asr.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(title: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${title}`);
  } else {
    fail++;
    failures.push(`${title}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${title}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(title: string, got: unknown, want: unknown): void {
  ok(title, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p-series-'));

/* ==========================================================================
 * ① 日志轮转：内存计数判据 + 切文件轮转
 * ======================================================================== */
section('① 日志轮转（内存字节计数 + 切文件，不再 rename）');
{
  const dir = path.join(tmpRoot, 'logs');
  const maxBytes = 400;
  const log = new Logger({ dir, file: true, console: false, maxBytes, keepDays: 14 });
  const lines = 60;
  for (let i = 0; i < lines; i++) log.info(`第 ${i} 条日志 —— 中文也算字节`, { mod: 'test', data: { i, pad: 'x'.repeat(20) } });
  log.close();
  await sleep(300);

  const files = fs.readdirSync(dir);
  const rotated = files.filter((f) => !/^live_auto-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  const current = files.find((f) => /^live_auto-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  const curSize = current ? fs.statSync(path.join(dir, current)).size : -1;
  let parsed = 0;
  let badLines = 0;
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        JSON.parse(l);
        parsed++;
      } catch {
        badLines++;
      }
    }
  }
  ok('真的发生了轮转（Windows 上旧实现从不轮转）', rotated.length >= 1, `轮转文件数=${rotated.length}`);
  ok('轮转文件仍以 live_auto- 开头（pruneOld / 日志接口按此前缀匹配）', rotated.every((f) => f.startsWith('live_auto-') && f.endsWith('.jsonl')));
  ok('不丢行', parsed === lines, `落盘 ${parsed} 行 / 写入 ${lines} 行`);
  ok('没有坏行（轮转切文件不会写出半行）', badLines === 0, `坏行 ${badLines}`);
  ok('当前文件只在单条日志的粒度上超限', curSize > 0 && curSize <= maxBytes + 1024, `curSize=${curSize}`);

  /* 跨天/换目录后仍能重新建流（setDir 会清 dayKey，重开必须走 ensureDir + 新建） */
  const dir2 = path.join(tmpRoot, 'logs2');
  log.setDir(dir2);
  log.info('换目录后仍可写入');
  log.close();
  await sleep(200);
  ok('setDir 后能在新目录建流', fs.existsSync(dir2) && fs.readdirSync(dir2).some((f) => f.endsWith('.jsonl')));
}

/* ==========================================================================
 * ② readJsonl：尾部回读与旧算法逐字节等价
 * ======================================================================== */
section('② readJsonl 尾部回读 ≡ 旧算法（整读 + 过滤 + 切片）');
{
  /** 旧实现（对照组） */
  const legacy = <T,>(p: string, limit?: number): T[] => {
    if (!fs.existsSync(p)) return [];
    const ls = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    const slice = limit && ls.length > limit ? ls.slice(-limit) : ls;
    const out: T[] = [];
    for (const l of slice) {
      try {
        out.push(JSON.parse(l) as T);
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  };
  const legacySince = (p: string, sinceMs: number, limit?: number): unknown[] => {
    let rows = legacy<Record<string, unknown>>(p);
    rows = rows.filter((r) => {
      const t = typeof r['at'] === 'string' ? Date.parse(r['at'] as string) : Number.NaN;
      return Number.isFinite(t) && t >= sinceMs;
    });
    return limit && limit > 0 && rows.length > limit ? rows.slice(-limit) : rows;
  };

  /* 大文件（> 512KB 门槛 ⇒ 真的走回读路径）+ 中文长行（跨 UTF-8 块边界） */
  const big = path.join(tmpRoot, 'big.jsonl');
  const N = 20000;
  const t0 = Date.parse('2026-10-15T00:00:00.000Z');
  const out: string[] = [];
  for (let i = 0; i < N; i++) out.push(JSON.stringify({ at: new Date(t0 + i * 1000).toISOString(), i, text: '中文弹幕内容'.repeat(20) }));
  fs.writeFileSync(big, out.join('\n') + '\n', 'utf8');
  ok('对照组文件确实超过回读门槛（512KB）', fs.statSync(big).size > 512 * 1024, `${(fs.statSync(big).size / 1048576).toFixed(2)} MB`);

  eq('limit=5 与旧语义一致', readJsonl(big, 5), legacy(big, 5));
  eq('limit=1 与旧语义一致', readJsonl(big, 1), legacy(big, 1));
  eq('limit 超过总行数 → 全量一致（触到回读上限必须退回整读）', readJsonl(big, 99999), legacy(big, 99999));
  eq('无 limit → 全量一致', readJsonl(big), legacy(big));
  const cut = t0 + (N - 300) * 1000;
  eq('sinceMs 与旧语义一致', readJsonl(big, { sinceMs: cut }), legacySince(big, cut));
  eq('sinceMs + limit 一致', readJsonl(big, { sinceMs: cut, limit: 10 }), legacySince(big, cut, 10));
  eq('sinceMs 早于全部 → 一致', readJsonl(big, { sinceMs: t0 - 10_000, limit: 3 }), legacySince(big, t0 - 10_000, 3));
  eq('sinceMs 晚于全部 → 空', readJsonl(big, { sinceMs: t0 + N * 1000 + 1000 }), []);

  /* 中等文件：刚过门槛，覆盖"回读窗口包含整个文件"的分支 */
  const mid = path.join(tmpRoot, 'mid.jsonl');
  const M = 1500;
  const mlines: string[] = [];
  for (let i = 0; i < M; i++) mlines.push(JSON.stringify({ at: new Date(t0 + i * 1000).toISOString(), i, t: '中等文件'.repeat(30) }));
  fs.writeFileSync(mid, mlines.join('\n') + '\n', 'utf8');
  const mSince = t0 + (M - 40) * 1000;
  eq('中等文件 limit 一致', readJsonl(mid, 7), legacy(mid, 7));
  eq('中等文件 sinceMs 一致', readJsonl(mid, { sinceMs: mSince }), legacySince(mid, mSince));
  eq('中等文件 sinceMs+limit 一致', readJsonl(mid, { sinceMs: mSince, limit: 5 }), legacySince(mid, mSince, 5));

  /* 超长单行（大于一个回读块 256KB） */
  const huge = path.join(tmpRoot, 'huge.jsonl');
  fs.writeFileSync(
    huge,
    JSON.stringify({ at: new Date(t0).toISOString(), pad: 'x'.repeat(500_000) }) + '\n' + JSON.stringify({ at: new Date(t0 + 1000).toISOString(), n: 2 }) + '\n',
    'utf8',
  );
  eq('超长单行 + 尾行一致', readJsonl(huge, 2), legacy(huge, 2));

  /* 边界：空文件 / 无尾换行 / 坏行与空行 / 不存在 */
  const empty = path.join(tmpRoot, 'empty.jsonl');
  fs.writeFileSync(empty, '', 'utf8');
  eq('空文件（带 limit）→ []', readJsonl(empty, 5), []);
  eq('空文件（无 limit）→ []', readJsonl(empty), []);
  const noeol = path.join(tmpRoot, 'noeol.jsonl');
  fs.writeFileSync(noeol, '{"at":"2026-10-15T00:00:00.000Z","a":1}\n{"at":"2026-10-15T00:00:01.000Z","a":2}', 'utf8');
  eq('无尾换行一致', readJsonl(noeol, 2), legacy(noeol, 2));
  const corrupt = path.join(tmpRoot, 'corrupt.jsonl');
  fs.writeFileSync(corrupt, '{"a":1}\n坏行{{{\n{"a":2}\n\n{"a":3}\n', 'utf8');
  eq('坏行 / 空行一致（跳过坏行）', readJsonl(corrupt, 2), legacy(corrupt, 2));
  eq('文件不存在 → []', readJsonl(path.join(tmpRoot, 'nope.jsonl'), 5), []);
}

/* ==========================================================================
 * ③ 台账：progress-only 更新降频落盘
 * ======================================================================== */
section('③ 台账 progress 降频落盘（转写期不再每 300ms 全量重写）');
{
  const dir = path.join(tmpRoot, 'ledger');
  const p = path.join(dir, 'ledger.json');
  const ledger = new Ledger({ path: p });
  ledger.createTask({ id: 't1', roomId: '123' });
  const read = (): Record<string, { progress?: { current: number }; title?: string }> =>
    (JSON.parse(fs.readFileSync(p, 'utf8')) as { tasks: Record<string, { progress?: { current: number }; title?: string }> }).tasks;

  ledger.updateTask('t1', { progress: { label: '转写中', current: 1, total: 10 } } as never);
  await sleep(600);
  eq('首次 progress 会落盘', read()['t1']?.progress?.current, 1);
  const m1 = fs.statSync(p).mtimeMs;

  for (let i = 2; i <= 201; i++) ledger.updateTask('t1', { progress: { label: '转写中', current: i, total: 10 } } as never);
  await sleep(700);
  eq('5 秒窗口内 200 次进度更新不再写盘', read()['t1']?.progress?.current, 1);
  ok('文件 mtime 未变（确实没写）', fs.statSync(p).mtimeMs === m1);
  eq('内存视图仍是最新（界面不受影响）', ledger.getTask('t1')?.progress?.current, 201);

  ledger.updateTask('t1', { title: '关键字段' });
  await sleep(600);
  eq('非 progress 字段立即落盘', read()['t1']?.title, '关键字段');
  eq('顺带把当时的进度一起写进去', read()['t1']?.progress?.current, 201);

  ledger.updateTask('t1', { progress: { label: '切片中', current: 1000, total: 10 } } as never);
  ledger.flush();
  eq('flush() 立刻落盘（退出钩子依赖）', read()['t1']?.progress?.current, 1000);
}

/* ==========================================================================
 * ④ ASR 缓存：索引有界（LRU）+ stats 扫目录
 * ======================================================================== */
section('④ ASR 缓存索引上限（LRU 淘汰，淘汰后仍可读盘回落）');
{
  const dir = path.join(tmpRoot, 'asr-cache');
  const cache = new AsrCache(dir);
  const idxOf = (c: AsrCache): Map<string, unknown> => (c as unknown as { index: Map<string, unknown> }).index;
  const N = 320; // 略超上限 300，确保触发淘汰
  for (let i = 0; i < N; i++) {
    cache.set({ key: `k${String(i).padStart(3, '0')}`, audioSeconds: 10, segments: [{ start: 0, end: 1, text: 'x'.repeat(200) }] } as never);
  }
  ok('索引被限制在上限内', idxOf(cache).size <= 300, `size=${idxOf(cache).size}`);
  eq('stats() 仍等于落盘条目数（不受淘汰影响）', cache.stats().count, N);
  eq('stats().audioSeconds 正确', cache.stats().audioSeconds, N * 10);
  ok('被淘汰的条目仍能从磁盘读回（语义不变）', Boolean(cache.get('k000')));

  cache.get('k010'); // 触碰成"最近使用"
  cache.set({ key: 'k999', audioSeconds: 5, segments: [] } as never);
  ok('LRU：被触碰的条目未被淘汰', idxOf(cache).has('k010'));
  ok('LRU：队首（最久未用）被淘汰', !idxOf(cache).has('k011'));

  const fresh = new AsrCache(dir);
  ok('新进程重建索引也受上限约束', idxOf(fresh).size <= 300, `size=${idxOf(fresh).size}`);
  eq('重开后 stats 仍准确', fresh.stats().count, N + 1);
}

/* ========================================================================== */
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('\n' + '─'.repeat(74));
console.log(`结果：PASS=${pass} FAIL=${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('P 系列性能修复的等价性与边界行为均符合预期。');
