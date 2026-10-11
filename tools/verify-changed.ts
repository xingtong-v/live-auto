/**
 * 按改动挑套件跑（2026-10-14，优化清单 P2：verify:changed）。
 *
 * 动机：快速链 22 步 / ~29 秒虽然不长，但改一行 CSS 也全跑一遍是浪费；而"自己判断该跑哪些"
 * 又容易漏（漏掉的代价是"以为绿了其实没测"）。
 *
 * 设计原则（安全优先）：
 *   1. **认不出来的一律照跑** —— 只有明确能窄化的步骤才跳过，绝不静默忽略；
 *   2. 改动来源优先用 git（`git status --porcelain`）；仓库没有 git 时退化为"最近 N 分钟被改过的文件"；
 *   3. 再配一条**保底集**：typecheck / encoding-test / check:ui 永远跑（它们便宜且覆盖全局不变量）；
 *   4. 结果打印"为什么选/为什么跳过"，便于人工核对（不黑箱）。
 *
 * 用法：
 *   node tools/verify-changed.ts            # 选出并跑
 *   node tools/verify-changed.ts --list     # 只列出选择结果
 *   node tools/verify-changed.ts --since 30 # 无 git 时按"最近 30 分钟改动"判断
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

interface Step {
  name: string;
  cmd: string;
  fast?: boolean;
  optional?: boolean;
}
const MANIFEST = path.join(ROOT_DIR, 'verify.steps.json');
const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { steps: Step[] };

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const sinceIdx = args.indexOf('--since');
const sinceMin = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) || 15 : 15;

/** 改动集合：优先 git，退化按 mtime */
function changedFiles(): { files: string[]; source: string } {
  try {
    const out = execSync('git status --porcelain', { cwd: ROOT_DIR, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    return { files, source: 'git status' };
  } catch {
    /* 没有 git：按 mtime 找最近改动 */
    const cutoff = Date.now() - sinceMin * 60_000;
    const files: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      for (const e of fs.readdirSync(path.join(ROOT_DIR, dir), { withFileTypes: true })) {
        if (['node_modules', '.git', 'data', 'dist'].includes(e.name) || e.name.startsWith('.')) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(rel, depth + 1);
          continue;
        }
        if (!/\.(ts|js|mjs|json|html|css|md)$/.test(e.name)) continue;
        try {
          if (fs.statSync(path.join(ROOT_DIR, rel)).mtimeMs > cutoff) files.push(rel);
        } catch {
          /* ignore */
        }
      }
    };
    walk('', 0);
    return { files, source: `最近 ${sinceMin} 分钟被改过（无 git）` };
  }
}

/** 保底：这些步骤永远跑（便宜且覆盖全局不变量） */
const ALWAYS = new Set(['typecheck', 'encoding-test', 'check:ui']);

/** 明确可窄化的映射：步骤名关键字 → 触发它的路径片段（命中任一即需要跑） */
const RULES: Array<{ match: (name: string) => boolean; paths: string[]; why: string }> = [
  { match: (n) => n === 'ui-modules-test', paths: ['web/src/', 'web/ui-modules.json', 'public/ui.html', 'tools/ui-modules.ts'], why: 'UI 模块构建' },
  { match: (n) => n === 'monitor-panel-test', paths: ['web/src/', 'src/server.ts', 'src/alert.ts', 'src/daemon.ts'], why: '界面静态断言 + 服务端文案' },
  { match: (n) => n === 'cut-pipeline-test', paths: ['src/publish.ts', 'src/failure-class.ts', 'src/media-plan.ts'], why: '切片流水线' },
  { match: (n) => n === 'multipart-routing-test', paths: ['src/publish.ts', 'src/daemon.ts'], why: '多分P 路由' },
  { match: (n) => n === 'multipart-cut-snapshot-test', paths: ['src/publish.ts'], why: '切片快照' },
  { match: (n) => n === 'confirm-append-test', paths: ['src/publish.ts', 'src/api.ts'], why: '追加投稿落地确认' },
  { match: (n) => n === 'publish-batches-test', paths: ['src/publish-batches.ts', 'src/publish.ts'], why: '投稿批次账' },
  { match: (n) => n === 'failure-class-test', paths: ['src/failure-class.ts', 'src/publish.ts'], why: '失败分级' },
  { match: (n) => n === 'incremental-asr-test', paths: ['src/incremental-asr.ts', 'src/media-plan.ts'], why: '边录边转写状态机' },
  { match: (n) => n === 'recording-health-test', paths: ['src/recording-health.ts', 'src/server.ts'], why: '录制体检' },
  { match: (n) => n === 'clean-artifacts-test', paths: ['src/clean-artifacts.ts', 'tools/clean-artifacts.ts'], why: '产物清理' },
  { match: (n) => n === 'config-baseline-test', paths: ['src/config-baseline.ts', 'src/server.ts'], why: '配置基线' },
  { match: (n) => n === 'todos-test', paths: ['src/todo-dismiss.ts', 'src/server.ts', 'src/recording-health.ts'], why: '统一待办' },
  { match: (n) => n === 'recap-test', paths: ['src/recap.ts', 'src/server.ts'], why: '复盘计算' },
  { match: (n) => n === 'clip-library-test', paths: ['src/server.ts', 'src/ledger.ts'], why: '切片库端点' },
  { match: (n) => n === 'isolation-test', paths: ['src/server.ts', 'src/ledger.ts', 'src/publish-batches.ts', 'src/todo-dismiss.ts'], why: '隔离性（dataDir 跟随）' },
  { match: (n) => n === 'fixture-accounting-test', paths: ['src/fixtures.ts', 'src/server.ts'], why: '夹具分账' },
  { match: (n) => n === 'docs-check', paths: ['docs/'], why: '文档章节号' },
];

const { files, source } = changedFiles();
const fast = man.steps.filter((s) => s.fast || ALWAYS.has(s.name));
const selected: Array<{ step: Step; why: string }> = [];
for (const s of fast) {
  if (ALWAYS.has(s.name)) {
    selected.push({ step: s, why: '保底（覆盖全局不变量）' });
    continue;
  }
  const rule = RULES.find((r) => r.match(s.name));
  if (!rule) {
    selected.push({ step: s, why: '没有窄化规则 ⇒ 照跑（宁可多跑，不可漏测）' });
    continue;
  }
  const hit = files.filter((f) => rule.paths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p || f.endsWith(`/${p}`))));
  if (hit.length) selected.push({ step: s, why: `${rule.why}：${hit.slice(0, 2).join(', ')}${hit.length > 2 ? ` 等 ${hit.length} 个` : ''}` });
  else if (files.length === 0) selected.push({ step: s, why: `${rule.why}：没有检测到改动 ⇒ 略过` });
}

console.log(`\x1b[1m按改动挑套件\x1b[0m（改动来源：${source}；共 ${files.length} 个文件）`);
for (const f of files.slice(0, 8)) console.log(`   · ${f}`);
if (files.length > 8) console.log(`   … 还有 ${files.length - 8} 个`);
console.log(`\n  选中 ${selected.length} / ${fast.length} 步（快速层）`);
for (const s of selected) console.log(`   \x1b[32m✓\x1b[0m ${s.step.name.padEnd(28)} ${s.why}`);
const skipped = fast.filter((s) => !selected.some((x) => x.step.name === s.name));
for (const s of skipped) console.log(`   \x1b[90m—\x1b[0m ${s.name.padEnd(28)} 与本次改动无关（窄化规则判定）`);
if (files.length === 0) console.log('\n  ⚠ 没有检测到改动 —— 若你确实改了东西，可能是 git 索引未刷新或 mtime 超窗（用 --since N 调整）');

if (listOnly) process.exit(0);

console.log(`\n\x1b[1m开始执行\x1b[0m`);
let failed = 0;
const timings: Array<{ name: string; sec: number; ok: boolean }> = [];
for (const s of selected) {
  const t0 = Date.now();
  const r = spawnSync(s.step.cmd, { cwd: ROOT_DIR, shell: true, encoding: 'utf8', timeout: 1800_000 });
  const sec = Number(((Date.now() - t0) / 1000).toFixed(1));
  const ok = r.status === 0;
  if (!ok && !s.step.optional) failed++;
  timings.push({ name: s.step.name, sec, ok });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : s.step.optional ? '\x1b[33m⚠\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${s.step.name.padEnd(28)} ${String(sec).padStart(6)}s`);
}
const total = Number(timings.reduce((a, x) => a + x.sec, 0).toFixed(1));
console.log(`\n\x1b[1m汇总：${timings.length} 步，${total}s\x1b[0m${failed ? `　\x1b[31m失败 ${failed}\x1b[0m` : ''}`);
process.exitCode = failed ? 1 : 0;
