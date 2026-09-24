/**
 * 文本编码完整性检查（跑在 `npm run verify` 里）。
 *
 * ## 为什么需要它
 *
 * 这个项目里**编码问题已经真实发生过四次**，每一次都表现为"看起来无关的故障"：
 *
 *   1. DanmakuFactory 生成的 ASS 带 BOM → biliLive-tools 切片接口 HTTP 500；
 *   2. config.json 的 passKey 被 PowerShell 的引号处理截断 → 所有接口 401；
 *   3. PowerShell 的 `Invoke-RestMethod` 按本地代码页编码请求体 → 写进术语表的中文变成 `?`；
 *   4. `Get-Content -Raw`（PS 5.1 按 GBK 解码）+ `Set-Content -Encoding UTF8`（补 BOM）
 *      → 一个测试文件的 115 个中文字符永久丢失、`package.json` 多出 BOM 导致
 *      `tsc` 把整个项目当成 CommonJS。
 *
 * 前三次是运行期才发现的，第四次是改代码时自己踩的。既然规律这么清楚，
 * 就用一个静态检查把它钉死：**任何人（或任何会话）再犯，`npm run verify` 直接红**。
 *
 * ## 规则（对应项目里已验证过的约定）
 *
 * | 文件 | 规则 | 原因 |
 * |---|---|---|
 * | `*.ps1` | **必须**带 BOM | Windows PowerShell 5.1 不带 BOM 会按 ANSI 解析，中文全乱 |
 * | `*.cmd` / `*.bat` | **禁止** BOM、**禁止**非 ASCII、换行必须是 CRLF | cmd.exe 对这三样都不宽容 |
 * | 其它文本文件 | **禁止** BOM | Node/tsc/ffmpeg 各自处理不一致，ASS 带 BOM 直接 500 |
 * | 所有文本文件 | **禁止** U+FFFD 替换字符 | 出现它就说明某次编码转换已经丢过字符 |
 *
 * 用法：node test/text-integrity.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

/**
 * 跳过的目录。
 *
 * ⚠️ 必须把**第三方依赖与虚拟环境**都列进来：实测 `.venv-asr/Scripts/Activate.ps1`
 * （Python 虚拟环境自带的脚本，没带 BOM）被当成"我们的脚本"报错 ——
 * 这类文件我们既不该改、也改不起（重新建虚拟环境就回来了）。
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'data',
  'logs',
  'dist',
  '.venv',
  '.venv-asr',
  'venv',
  'env',
  'site-packages',
  '__pycache__',
  '.next',
  '.cache',
  'coverage',
]);
/** 名称以这些前缀开头的目录一律跳过（虚拟环境常带版本号，如 `.venv-3.12`） */
const SKIP_DIR_PREFIX = ['.venv', 'venv-', '.idea', '.vscode'];
const TEXT_EXT = /\.(ts|js|mjs|cjs|json|md|html|css|cmd|bat|ps1|txt|yml|yaml|ass|srt|example)$/i;
/** 没有扩展名但需要检查的文件 */
const TEXT_NAMES = new Set(['LICENSE', '.gitignore', '.gitattributes']);

interface Problem {
  file: string;
  kind: string;
  detail: string;
}

const problems: Problem[] = [];
let checked = 0;

function rel(p: string): string {
  return path.relative(ROOT_DIR, p).replace(/\\/g, '/');
}

function checkFile(p: string): void {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch {
    return;
  }
  checked++;
  const name = path.basename(p);
  const ext = path.extname(p).toLowerCase();
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8');

  // 1) U+FFFD：任何文件都不该有
  const bad = (text.match(/\uFFFD/g) ?? []).length;
  if (bad > 0) {
    problems.push({ file: rel(p), kind: '替换字符', detail: `${bad} 处 U+FFFD —— 某次编码转换已经丢过字符，必须人工恢复` });
  }

  // 2) .ps1 必须带 BOM
  if (ext === '.ps1') {
    if (!hasBom) {
      problems.push({ file: rel(p), kind: '缺 BOM', detail: 'PowerShell 脚本必须带 UTF-8 BOM，否则 PS 5.1 按 ANSI 解析、中文全乱' });
    }
    return;
  }

  // 3) .cmd / .bat：无 BOM、纯 ASCII、CRLF
  if (ext === '.cmd' || ext === '.bat') {
    if (hasBom) problems.push({ file: rel(p), kind: '多余 BOM', detail: 'cmd.exe 会把 BOM 当命令的一部分，首行直接报错' });
    const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 127);
    if (nonAscii.length) {
      problems.push({
        file: rel(p),
        kind: '非 ASCII',
        detail: `含 ${nonAscii.length} 个非 ASCII 字符（如 ${nonAscii.slice(0, 5).join('')}）—— 批处理必须是纯 ASCII，中文请放进 .ps1 或 JS`,
      });
    }
    if (/\r?\n/.test(text) && !/\r\n/.test(text)) {
      problems.push({ file: rel(p), kind: '换行', detail: '批处理必须用 CRLF 换行' });
    }
    return;
  }

  // 4) 其它文本：禁止 BOM
  if (hasBom) {
    problems.push({
      file: rel(p),
      kind: '多余 BOM',
      detail: 'Node/tsc/ffmpeg 对 BOM 处理不一致（ASS 带 BOM 会让切片接口 500；package.json 带 BOM 会让 tsc 把项目当 CommonJS）',
    });
  }
}

function walk(dir: string, depth = 0): void {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.isDirectory() && SKIP_DIR_PREFIX.some((p) => e.name.startsWith(p))) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, depth + 1);
      continue;
    }
    if (TEXT_EXT.test(e.name) || TEXT_NAMES.has(e.name)) checkFile(full);
  }
}

console.log('\x1b[1m文本编码完整性\x1b[0m（BOM / 替换字符 / 批处理 ASCII 与换行）');
console.log('─'.repeat(72));
walk(ROOT_DIR);

if (problems.length === 0) {
  console.log(`  \x1b[32m✓\x1b[0m 检查 ${checked} 个文本文件，未发现编码问题`);
  console.log('\x1b[32m全部通过\x1b[0m');
} else {
  console.log(`  \x1b[31m✗ 检查 ${checked} 个文件，发现 ${problems.length} 处问题：\x1b[0m`);
  for (const p of problems) console.log(`    ${p.file}  [${p.kind}]  ${p.detail}`);
  console.log('\n  修复提示：把文件重新写成 UTF-8（不带 BOM）即可。');
  console.log('  ⚠️ 不要用 PowerShell 的 Get-Content/Set-Content 做中文文本往返 ——');
  console.log('     PS 5.1 的 Get-Content 默认按 GBK 解码、Set-Content -Encoding UTF8 会补 BOM，');
  console.log('     两者叠加会永久丢失字符（本项目已经因此丢过一个文件里的 115 个字符）。');
  process.exitCode = 1;
}
