/**
 * 编码卫生闸（2026-10-11，优化第三批 ⑤）。
 *
 * 为什么需要：这一轮我自己就踩了 —— 用 PowerShell `Set-Content -Encoding UTF8` 重写 `package.json`，
 * 结果文件带上 UTF-8 BOM（`EF BB BF`）。npm 能容忍，但 `JSON.parse` 直接抛
 * `SyntaxError: Unexpected token ''`，于是一个新写的测试莫名其妙地红。事后一扫，
 * 仓库里有 **7 个** 文件带 BOM（`package.json`、`public/ui.html`、`src/publish.ts`、`src/server.ts`、
 * `test/publish-batches.ts`、`test/todos.ts`、`tools/ui-e2e.ts`、`web/src/31-基础.js` 等）。
 *
 * 规则（两条，方向相反，都来自本仓库的真实约定）：
 *   ① `.ts/.js/.mjs/.json/.html/.css/.md` —— **不得**带 BOM（Node/JSON.parse/浏览器虽然大多能忍，
 *      但 BOM 会让"逐字节比对"（如 UI 模块构建、产物校验）出现假失败）；
 *   ② `.ps1` —— **必须**带 BOM（PowerShell 5.1 不认无 BOM 的 UTF-8，中文会乱码，实测过）。
 *
 * 用法：node tools/check-encoding.ts        # 违规即非零退出（已接入 npm run verify）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', 'build', '.venv-asr', '.venv-funasr', '.cache']);
const NO_BOM_EXT = ['.ts', '.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md'];
const MUST_BOM_EXT = ['.ps1'];
const MAX_DEPTH = 6;

interface Finding {
  rel: string;
  kind: 'has-bom' | 'missing-bom';
}

const findings: Finding[] = [];
let scanned = 0;

function walk(dir: string, depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    const noBom = NO_BOM_EXT.includes(ext);
    const mustBom = MUST_BOM_EXT.includes(ext);
    if (!noBom && !mustBom) continue;
    const full = path.join(dir, e.name);
    const buf = fs.readFileSync(full);
    const has = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    scanned++;
    const rel = path.relative(ROOT_DIR, full).replace(/\\/g, '/');
    if (noBom && has) findings.push({ rel, kind: 'has-bom' });
    if (mustBom && !has) findings.push({ rel, kind: 'missing-bom' });
  }
}

walk(ROOT_DIR, 0);

const hasBom = findings.filter((f) => f.kind === 'has-bom');
const missingBom = findings.filter((f) => f.kind === 'missing-bom');

if (findings.length === 0) {
  console.log(`  \x1b[32m✓\x1b[0m 编码卫生：扫描 ${scanned} 个文件，没有 BOM 违规`);
  console.log(`    （规则：.ts/.js/.json/.html/.css/.md 不得带 BOM；.ps1 必须带 BOM）`);
  process.exit(0);
}

console.log(`  \x1b[31m✗\x1b[0m 编码卫生：扫描 ${scanned} 个文件，发现 ${findings.length} 处违规`);
for (const f of hasBom) printfix(f, '不应带 BOM，请去掉开头的 3 个字节（EF BB BF）');
for (const f of missingBom) printfix(f, 'PowerShell 5.1 需要 BOM，请把该文件另存为「带 BOM 的 UTF-8」');
console.log('\n  提示：写仓库文件请用 node 的 fs.writeFileSync(..., "utf8")，不要用 PowerShell 的 Set-Content/Out-File。');
process.exit(1);

function printfix(f: Finding, hint: string): void {
  console.log(`     · ${f.rel} —— ${hint}`);
}
