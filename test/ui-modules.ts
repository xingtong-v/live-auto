/**
 * UI 模块化（A6/P2-1）——2026-10-11。
 *
 * 拆模块的价值全在**一条不变量**上：`web/src/*` 按清单顺序拼起来必须与 `public/ui.html` 逐字节相同。
 * 不变量一旦破了，就会出现"改了产物没改模块"（或反之）—— 下一次 build 会静默覆盖掉对方的工作。
 * 这个套件守它（verify 链里另有 `check:ui` 做早失败）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

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

const manifestPath = path.join(ROOT_DIR, 'web', 'ui-modules.json');
const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
  parts: Array<{ file: string; kind: string; label: string }>;
};
const html = fs.readFileSync(path.join(ROOT_DIR, 'public', 'ui.html'), 'utf8');
const assembled = man.parts
  .map((p) => fs.readFileSync(path.join(ROOT_DIR, 'web', 'src', p.file), 'utf8'))
  .join('');

ok('清单存在且非空', man.parts.length > 0, String(man.parts.length));
const kinds = new Set(man.parts.map((p) => p.kind));
ok('三类片段齐全（外壳 / 样式 / 脚本）', kinds.has('shell') && kinds.has('css') && kinds.has('js'), JSON.stringify([...kinds]));
const jsParts = man.parts.filter((p) => p.kind === 'js').length;
ok('脚本分了多块（否则等于没拆）', jsParts >= 8, String(jsParts));
ok('每个模块都有说明名（不是空标签）', man.parts.every((p) => p.label.trim().length > 0));
const missing = man.parts.filter((p) => !fs.existsSync(path.join(ROOT_DIR, 'web', 'src', p.file)));
ok('清单里每个文件都在磁盘上', missing.length === 0, missing.map((m) => m.file).join(','));
ok('★ 按序拼接 === public/ui.html（逐字节）', assembled === html, `模块拼出 ${assembled.length} 字节 / 产物 ${html.length} 字节`);
ok('产物里只有一份 <script>（拼接没切坏标签）', (html.match(/<script>/g) ?? []).length === 1, String((html.match(/<script>/g) ?? []).length));
ok('产物里只有一份 <style>', (html.match(/<style>/g) ?? []).length === 1);

const tool = fs.readFileSync(path.join(ROOT_DIR, 'tools', 'ui-modules.ts'), 'utf8');
ok('工具提供 --split/--build/--check 三个入口', tool.includes("'--split'") && tool.includes("'--build'") && tool.includes("'--check'"));
ok('★ --split 会先备份，并在重建不一致时自动还原', /before-split/.test(tool) && /已还原 ui.html/.test(tool));

/* 读配置统一去掉 BOM：PowerShell 写的文件可能带 BOM，JSON.parse 会直接抛异常（踩过） */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) as { scripts: Record<string, string> };
ok('npm 脚本暴露 build:ui / check:ui', Boolean(pkg.scripts['build:ui']) && Boolean(pkg.scripts['check:ui']));
/* verify 已改为清单驱动（tools/verify.ts + verify.steps.json）：链里有没有 check:ui
   要去清单里问 —— 旧断言在 package.json 的长字符串里找，链一改成运行器就假红。 */
/* 变量名不能叫 man：本文件上面已经用它指向 UI 模块清单了（撞名直接编译失败） */
const verifyMan = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'verify.steps.json'), 'utf8')) as { steps: Array<{ name: string; fast?: boolean }> };
ok('★ verify 清单里有 check:ui（只改产物不改模块会被拦住）', verifyMan.steps.some((s) => s.name === 'check:ui'));
ok('★ verify 已交给清单运行器（两层都在调 tools/verify.ts）', /tools\/verify\.ts --(all|fast)/.test(String(pkg.scripts['verify']) + String(pkg.scripts['verify:fast'])));

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
