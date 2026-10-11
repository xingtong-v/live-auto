/**
 * verify 清单驱动运行器（2026-10-12，优化清单 #2）。
 *
 * 起因（我这几轮的真实失误）：verify 原来是一条 **51 步的巨型 `&&` 字符串**，于是：
 *   · 我**两次踩空锚点** —— `recap-test` 写进链里却没注册脚本（链直接红）、
 *     `docs-check` 想插进全量链找不到锚点（最后没能接上）；
 *   · **不知道哪步慢** —— 没法做"该删哪个/该并行哪个"的判断；
 *   · 快速链与全量链的差异藏在两条长字符串里，没人能一眼看出差在哪。
 *
 * 改成读 `verify.steps.json`（一份清单）：逐个跑、**打印每步耗时**、汇总失败、可只跑快速层。
 *
 * 用法：
 *   node tools/verify.ts --fast        # 只跑 fast:true 的步骤（改完随手跑）
 *   node tools/verify.ts --all         # 全部（发布前/夜间）
 *   node tools/verify.ts --only recap  # 只跑名字含 recap 的步骤（调试用）
 *   node tools/verify.ts --list        # 只列出清单与层级
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

interface Step {
  name: string;
  cmd: string;
  fast?: boolean;
  /** 允许失败（用于已知的历史债，例如 docs 章节号撞号）；失败会被标成 ⚠ 而不是 ✗ */
  optional?: boolean;
  timeoutSec?: number;
}

const MANIFEST = path.join(ROOT_DIR, 'verify.steps.json');
if (!fs.existsSync(MANIFEST)) throw new Error(`缺少清单：${MANIFEST}（应由 tools/verify.ts 的生成模式或人工维护）`);
const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { note?: string; steps: Step[] };

const args = process.argv.slice(2);
const mode = args.includes('--all') ? 'all' : args.includes('--list') ? 'list' : args.includes('--fast') ? 'fast' : 'fast';
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '') : '';

if (mode === 'list') {
  console.log(`  清单：${man.steps.length} 步（快速层 ${man.steps.filter((s) => s.fast).length} 步）`);
  for (const s of man.steps) console.log(`   ${s.fast ? '⚡' : '  '} ${s.optional ? '⚠' : ' '} ${s.name.padEnd(28)} ${s.cmd}`);
  process.exit(0);
}

const steps = man.steps.filter((s) => (only ? s.name.includes(only) : mode === 'fast' ? s.fast : true));
console.log(`\x1b[1mverify ${mode}${only ? `（--only ${only}）` : ''}：${steps.length} 步\x1b[0m\n`);

interface Result {
  name: string;
  ok: boolean;
  optional: boolean;
  sec: number;
  tail: string;
}
const results: Result[] = [];
let failed = 0;

for (const s of steps) {
  const t0 = Date.now();
  const r = spawnSync(s.cmd, { cwd: ROOT_DIR, shell: true, encoding: 'utf8', timeout: (s.timeoutSec ?? 1800) * 1000 });
  const sec = Number(((Date.now() - t0) / 1000).toFixed(1));
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ok = r.status === 0;
  if (!ok && !s.optional) failed++;
  const label = ok ? '\x1b[32m✓\x1b[0m' : s.optional ? '\x1b[33m⚠\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${label} ${s.name.padEnd(30)} ${String(sec).padStart(7)}s${ok ? '' : `  (exit ${String(r.status)})`}`);
  /* 失败时只留尾部若干行，便于一眼看到断言/报错，而不是刷屏 */
  const tail = ok ? '' : out.split('\n').filter((l) => l.trim()).slice(-12).join('\n');
  if (tail) console.log(tail.split('\n').map((l) => `      ${l}`).join('\n'));
  results.push({ name: s.name, ok, optional: Boolean(s.optional), sec, tail });
}

const total = Number(results.reduce((a, r) => a + r.sec, 0).toFixed(1));
const slowest = [...results].sort((a, b) => b.sec - a.sec).slice(0, 6);
console.log(`\n\x1b[1m汇总：${results.length} 步，${total}s\x1b[0m`);
console.log('  最慢 6 步：' + slowest.map((r) => `${r.name} ${r.sec}s`).join(' · '));
const warns = results.filter((r) => !r.ok && r.optional);
if (warns.length) console.log(`  ⚠ 允许失败（历史债）：${warns.map((r) => r.name).join(', ')}`);
const bad = results.filter((r) => !r.ok && !r.optional);
if (bad.length) console.log(`  \x1b[31m✗ 失败：${bad.map((r) => r.name).join(', ')}\x1b[0m`);

/* 记一份耗时，便于以后看趋势（也方便判断"哪步变慢了"） */
try {
  const hist = path.join(ROOT_DIR, 'data', 'verify-timing.json');
  const prev = fs.existsSync(hist) ? (JSON.parse(fs.readFileSync(hist, 'utf8')) as unknown[]) : [];
  prev.push({ at: new Date().toISOString(), mode, total, steps: results.map((r) => ({ name: r.name, sec: r.sec, ok: r.ok })) });
  fs.writeFileSync(hist, JSON.stringify(prev.slice(-50), null, 1), 'utf8');
} catch {
  /* 记耗时失败不影响结论 */
}

process.exitCode = failed === 0 ? 0 : 1;
