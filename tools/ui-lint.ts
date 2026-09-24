/**
 * 静态检查前端页面：找出「JS 引用了但 HTML 里不存在的元素 id」。
 *
 * 这类问题在浏览器里表现为**一串绑定静默失效** —— 某一个 `$('#x')` 拿到 null，
 * 后面那行 `.onclick = ...` 就抛 TypeError，其后的所有绑定都从没执行过。
 * 界面上看起来就是「按钮点了没反应」，而且控制台不一定有明显线索。
 *
 * 用法：node tools/ui-lint.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const file = path.join(ROOT_DIR, 'public', 'ui.html');
const html = fs.readFileSync(file, 'utf8');

const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!scriptMatch) {
  console.error('找不到 <script> 段');
  process.exit(1);
}
const script = scriptMatch[1]!;
const markup = html.replace(script, '');

/* ---- 1. 收集 HTML 里真实存在的 id ---- */
const htmlIds = new Set<string>();
for (const m of markup.matchAll(/id="([^"]+)"/g)) htmlIds.add(m[1]!);
for (const m of markup.matchAll(/id='([^']+)'/g)) htmlIds.add(m[1]!);
// 模板字符串里动态生成的 id（在 script 内），也算存在
for (const m of script.matchAll(/id="([A-Za-z0-9_-]+)"/g)) htmlIds.add(m[1]!);
for (const m of script.matchAll(/id=\\?"([A-Za-z0-9_-]+)\\?"/g)) htmlIds.add(m[1]!);
for (const m of script.matchAll(/id=[\\]?'([A-Za-z0-9_-]+)'/g)) htmlIds.add(m[1]!);
for (const m of script.matchAll(/\.id\s*=\s*'([^']+)'/g)) htmlIds.add(m[1]!);
for (const m of script.matchAll(/insertAdjacentHTML[\s\S]{0,200}?id="([A-Za-z0-9_-]+)"/g)) htmlIds.add(m[1]!);

/* ---- 2. 收集 JS 里被引用的 id ---- */
const referenced = new Map<string, number[]>();
const lines = script.split('\n');
lines.forEach((line, i) => {
  for (const m of line.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) {
    const id = m[1]!;
    const arr = referenced.get(id) ?? [];
    arr.push(i + 1);
    referenced.set(id, arr);
  }
  for (const m of line.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) {
    const id = m[1]!;
    const arr = referenced.get(id) ?? [];
    arr.push(i + 1);
    referenced.set(id, arr);
  }
});

/* ---- 3. 找出缺失的 ---- */
const missing: Array<{ id: string; lines: number[] }> = [];
for (const [id, lns] of referenced) {
  if (!htmlIds.has(id)) missing.push({ id, lines: lns });
}

console.log('\x1b[1m前端页面静态检查\x1b[0m');
console.log('─'.repeat(64));
console.log(`  页面 id 总数    : ${htmlIds.size}`);
console.log(`  JS 引用的 id 数 : ${referenced.size}`);

if (missing.length === 0) {
  console.log("\n  \x1b[32m✓ 没有悬空引用 —— 所有 $('#x') 都能找到对应元素\x1b[0m");
} else {
  console.log(`\n  \x1b[31m✗ 发现 ${missing.length} 个悬空引用（会导致其后的绑定静默失效）：\x1b[0m`);
  for (const m of missing) {
    console.log(`    #${m.id}  引用于 script 第 ${m.lines.join(', ')} 行`);
  }
  console.log('\n  这类问题的表现：某一处 \'$(\'#x\').onclick = ...\' 拿到 null 抛 TypeError，');
  console.log('  其后的所有事件绑定从未执行 —— 界面上就是「按钮点了没反应」。');
}

/* ---- 4. 额外检查：绑定时未做空值保护的高风险写法 ---- */
const risky: Array<{ line: number; text: string }> = [];
lines.forEach((line, i) => {
  // 形如 $('#x').onclick = ... 且没有 if 保护
  if (/\$\('#[A-Za-z0-9_-]+'\)\.on(click|input|change|contextmenu)\s*=/.test(line)) {
    const id = /\$\('#([A-Za-z0-9_-]+)'\)/.exec(line)?.[1];
    if (id && !htmlIds.has(id)) risky.push({ line: i + 1, text: line.trim().slice(0, 90) });
  }
});
if (risky.length) {
  console.log(`\n  \x1b[33m⚠ 其中 ${risky.length} 处是「未做空值保护的直接绑定」（最容易打断后续代码）：\x1b[0m`);
  for (const r of risky.slice(0, 10)) console.log(`    第 ${r.line} 行: ${r.text}`);
}

/* ---- 5. 把「单个元素当数组用」的误用找出来 ----
 *
 * 这是一个真事故：`$('#retryStages .chip').forEach(...)` ——
 * `$` 是 `document.querySelector`（返回**单个元素**），元素上没有 `.forEach`，
 * 于是抛 TypeError，**整段绑定从不执行**。表现就是用户报的「这里的按键点不了」，
 * 而且不报任何错误（异常被浏览器吞在事件循环里，页面其它功能照常）。
 *
 * 这类错误纯静态可查，代价极低，所以在这里钉死：单 `$` 后面**紧跟**数组方法一律报错。
 *
 * ⚠️ 必须要求"紧跟"：`$('#ovTags').value.split(',').map(...)` 是完全正确的用法
 * （先取 input 的 value，再 split、再 map）。第一版写成"后面出现过数组方法"就误报了 3 处 ——
 * 误报比漏报更糟：检查器一旦不可信，就会被整条跳过。 */
const arrayMethods = /^\s*\.(forEach|map|filter|reduce|some|every|find|findIndex|flatMap|length|push|pop|sort|slice|join)\b/;
const dollarMisuse: Array<{ line: number; text: string }> = [];
lines.forEach((line, i) => {
  // 逐个匹配 `$('...')`，跳过 `$$('...')`
  const re = /(^|[^$])\$\('[^']+'\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const after = line.slice(m.index + m[0].length);
    if (arrayMethods.test(after)) {
      dollarMisuse.push({ line: i + 1, text: line.trim().slice(0, 100) });
      break;
    }
  }
});

if (dollarMisuse.length === 0) {
  console.log('\n  \x1b[32m✓ 没有「把单个元素当数组用」的误用（$ 一律只取单个元素，数组用 $$）\x1b[0m');
} else {
  console.log(`\n  \x1b[31m✗ 发现 ${dollarMisuse.length} 处「$() 当数组用」——会导致该处绑定整段失效：\x1b[0m`);
  for (const d of dollarMisuse) console.log(`    第 ${d.line} 行: ${d.text}`);
  console.log('\n  `$` = document.querySelector（单个元素），`$$` = querySelectorAll（数组）。');
  console.log('  对单个元素调 .forEach/.map/... 会抛 TypeError，其后的绑定代码全部不执行，');
  console.log('  界面上表现为「按钮点了没反应」，且不一定有显眼报错。');
}

console.log('\n' + '─'.repeat(64));
process.exitCode = missing.length > 0 || dollarMisuse.length > 0 ? 1 : 0;
