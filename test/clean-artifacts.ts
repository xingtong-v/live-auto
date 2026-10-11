/**
 * 验证产物清理（`src/clean-artifacts.ts`）——2026-10-14，优化清单 P2。
 *
 * 这是**破坏性操作**，所以断言的重点不是"能删"，而是"**绝不会删错**"：
 *   ① 保护清单（trash / logs / backup / asr-cache / tasks / *.jsonl）一个都不能少；
 *   ② 只删超过保留期的；保留期内的新文件必须留着（否则今天刚做的验收截图就没了）；
 *   ③ `sample-300s.flv` 必须留（tools/local-asr/timing.ts 真正读的基准素材）；
 *   ④ dry-run 一个文件都不许删；
 *   ⑤ 出错返回 error 而不是抛（调用方是每日 tick，不能因为清理失败就中断）。
 *
 * 全部在临时目录里做，不碰真实 data/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runArtifactCleanup, summarizeCleanup } from '../src/clean-artifacts.ts';

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

/** 造一个假 data/ 目录：老文件（8 天前）/ 新文件 / 保护目录 / 基准素材 */
function makeFixture(): { dir: string; old: string; fresh: string; sample: string; protectedFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clean-'));
  const mk = (rel: string, bytes: number, ageDays: number): string => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(Math.max(1, bytes)));
    const t = (Date.now() - ageDays * 86400_000) / 1000;
    fs.utimesSync(p, t, t);
    return p;
  };
  const old = mk(path.join('local-asr-test', 'sample-1800s.flv'), 2048, 8);
  const fresh = mk(path.join('local-asr-test', 'today-probe.wav'), 1024, 0);
  const sample = mk(path.join('local-asr-test', 'sample-300s.flv'), 512, 30);
  const protectedFile = mk(path.join('backup', '2026-01-01_00-00-00', 'ledger.json'), 256, 30);
  mk(path.join('subtitle-check', 'old.json'), 128, 30);
  mk(path.join('trash', 'user-clip.mp4'), 4096, 30);
  mk(path.join('logs', 'live_auto-old.jsonl'), 64, 30);
  mk(path.join('_framecheck', 'frame.png'), 32, 0); // 不按天数 ⇒ 新文件也删
  return { dir, old, fresh, sample, protectedFile };
}

section('1. dry-run：只报不删');
{
  const f = makeFixture();
  const r = runArtifactCleanup({ dataDir: f.dir, keepDays: 7, dryRun: true });
  ok('dry-run 不动文件：老文件还在', fs.existsSync(f.old));
  ok('dry-run 也如实报出"会删几个"', r.removed >= 2, String(r.removed));
  eq('dryRun 标记正确', r.dryRun, true);
  fs.rmSync(f.dir, { recursive: true, force: true });
}

section('2. ★ 保护清单：一个都不能被删');
{
  const f = makeFixture();
  const r = runArtifactCleanup({ dataDir: f.dir, keepDays: 7 });
  ok('★ backup 目录被保护（备份没被清理工具删掉）', fs.existsSync(f.protectedFile), f.protectedFile);
  ok('★ trash 目录被保护（用户回收站不动）', fs.existsSync(path.join(f.dir, 'trash', 'user-clip.mp4')));
  ok('★ logs 目录被保护', fs.existsSync(path.join(f.dir, 'logs', 'live_auto-old.jsonl')));
  eq('清理没有报错', r.error, undefined);
  fs.rmSync(f.dir, { recursive: true, force: true });
}

section('3. 保留期与白名单');
{
  const f = makeFixture();
  const r = runArtifactCleanup({ dataDir: f.dir, keepDays: 7 });
  ok('★ 超过 7 天的素材被删（sample-1800s.flv）', !fs.existsSync(f.old));
  ok('★ 保留期内的新文件留着（today-probe.wav）', fs.existsSync(f.fresh));
  ok('★ 基准素材 sample-300s.flv 必须留（timing.ts 会读它）', fs.existsSync(f.sample));
  ok('不按天数的目录（_framecheck）新文件也删', !fs.existsSync(path.join(f.dir, '_framecheck', 'frame.png')));
  ok('按目录统计如实', (r.byTarget['local-asr-test']?.n ?? 0) >= 1, JSON.stringify(r.byTarget));
  ok('摘要是一句人话（含删除数与跳过数）', /删除 \d+ 个文件/.test(summarizeCleanup(r)) && /跳过 \d+ 个新文件/.test(summarizeCleanup(r)), summarizeCleanup(r));
  fs.rmSync(f.dir, { recursive: true, force: true });
}

section('4. 出错返回 error 而不是抛（调用方是每日 tick）');
{
  const f = makeFixture();
  /* 传一个不存在的目录：不应抛，且应如实返回"没东西可清" */
  const r = runArtifactCleanup({ dataDir: path.join(f.dir, '不存在的目录'), keepDays: 7 });
  eq('目录不存在 ⇒ 不抛、removed=0、无 error', [r.removed, r.error], [0, undefined]);
  eq('keepDays 会被夹到非负', runArtifactCleanup({ dataDir: f.dir, keepDays: -5, dryRun: true }).keepDays, 0);
  fs.rmSync(f.dir, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
