/**
 * UI 模块化：把单文件 `public/ui.html` 拆成**有序模块** + 可复现构建（2026-10-11，A6/P2-1）。
 *
 * 为什么这么做而不是"手工拆成 ES module"：
 *   `ui.html` 里那 4000+ 行内联脚本是**一个大作用域**（共享 `state`、工具函数、顺序敏感的 const），
 *   直接切成 ES module 会引入 TDZ/循环依赖一类难查的坑。所以走**有序拼接**这条老路：
 *     模块文件按序 concat → 生成 ui.html（运行时产物仍是单文件，服务端与 e2e 一行都不用改）。
 *
 * 安全保证（这是它能放心做的关键）：
 *   ① 只在**行边界**切分；② 构建严格按 order 拼接、行尾原样保留；
 *   ③ `--check` 断言"模块拼出来 == 当前 ui.html"，所以**改产物不改模块会被立刻发现**，
 *      ④ 拆分后立刻用"重建 == 备份"逐字节比对证明零语义变化。
 *
 * 用法：
 *   node tools/ui-modules.ts --split     # ui.html → web/src/*（首次拆分；会先备份）
 *   node tools/ui-modules.ts --build     # web/src/* → ui.html
 *   node tools/ui-modules.ts --check     # 只校验两者一致（CI/verify 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const HTML = path.join(ROOT_DIR, 'public', 'ui.html');
const MOD_DIR = path.join(ROOT_DIR, 'web', 'src');
const MANIFEST = path.join(ROOT_DIR, 'web', 'ui-modules.json');

interface Manifest {
  /** 说明：这些片段拼起来就是 public/ui.html（顺序即数组顺序） */
  note: string;
  parts: Array<{ file: string; kind: 'shell' | 'css' | 'js'; label: string }>;
}

const slug = (s: string): string =>
  s
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'part';

/** 把一段文本按"顶层横幅注释"切成若干块；切点只在行首的横幅注释处 */
function splitByBanners(lines: string[], fallbackLabel: string): Array<{ label: string; lines: string[] }> {
  const out: Array<{ label: string; lines: string[] }> = [];
  let cur: { label: string; lines: string[] } = { label: fallbackLabel, lines: [] };
  for (const line of lines) {
    const isBanner = /^\/\* ={10,}/.test(line) || /^\/\* -{10,}/.test(line);
    if (isBanner && cur.lines.length > 0) {
      out.push(cur);
      // 横幅本身可能带说明文字，取它当模块名
      const label = line.replace(/^\/\*[-= ]+/, '').replace(/[-= ]*\*\/\s*$/, '').trim() || fallbackLabel;
      cur = { label, lines: [line] };
      continue;
    }
    if (isBanner && cur.lines.length === 0) cur.label = cur.label === fallbackLabel ? line.replace(/^\/\*[-= ]+/, '').replace(/[-= ]*\*\/\s*$/, '').trim() || fallbackLabel : cur.label;
    cur.lines.push(line);
  }
  if (cur.lines.length) out.push(cur);
  return out;
}

function readParts(): Array<{ kind: 'shell' | 'css' | 'js'; label: string; text: string }> {
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
  return man.parts.map((p) => ({
    kind: p.kind,
    label: p.label,
    text: fs.readFileSync(path.join(MOD_DIR, p.file), 'utf8'),
  }));
}

function assemble(parts: Array<{ kind: string; text: string }>): string {
  return parts.map((p) => p.text).join('');
}

function doSplit(): void {
  const src = fs.readFileSync(HTML, 'utf8');
  fs.mkdirSync(MOD_DIR, { recursive: true });
  /* 备份一次，便于事后比对（--split 是破坏性动作，必须留退路） */
  const backup = path.join(ROOT_DIR, 'web', 'ui.html.before-split');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, src, 'utf8');

  /* 三段：<style> 之前是外壳；<style>…</style> 是样式；<script>…</script> 是脚本 */
  const styleStart = src.indexOf('<style>');
  const styleEnd = src.indexOf('</style>');
  /* ⚠️ 主脚本必须从 **</style> 之后**开始找 `<script>`。
     2026-10-16 起 00-shell-head.html 里多了一段「主题引导」内联脚本
     （在 head、<style> 之前，用来在首屏渲染前设好 data-theme，避免深色下闪白）。
     继续用 `indexOf('<script>')` 会切到它，把引导脚本当成主脚本的开头 —— 一拆就坏。 */
  const scriptStart = src.indexOf('<script>', styleEnd);
  const scriptEnd = src.lastIndexOf('</script>');
  if (styleStart < 0 || styleEnd < 0 || scriptStart < 0 || scriptEnd < 0) throw new Error('ui.html 结构不符合预期（找不到 <style>/<script>）');

  const shellHead = src.slice(0, styleStart);
  const shellTail = src.slice(styleEnd + '</style>'.length, scriptStart);
  const shellEnd = src.slice(scriptEnd + '</script>'.length);
  const css = src.slice(styleStart, styleEnd + '</style>'.length);
  /* ⚠️ js 要**连 `<script>` 标签一起**切（第一版从标签之后开始切，重建时就丢了开标签 ——
     重建校验当场拦住，ui.html 已自动还原）。css 同理已含 `<style>` 标签。 */
  const js = src.slice(scriptStart, scriptEnd + '</script>'.length);

  const parts: Manifest['parts'] = [];
  const write = (file: string, kind: 'shell' | 'css' | 'js', label: string, text: string): void => {
    fs.writeFileSync(path.join(MOD_DIR, file), text, 'utf8');
    parts.push({ file, kind, label });
  };

  write('00-shell-head.html', 'shell', 'HTML 外壳（head + 顶栏 + 页签）', shellHead);
  write('10-style.css', 'css', '样式', css);
  write('20-shell-body.html', 'shell', 'HTML 外壳（各页签容器 + 弹窗）', shellTail);
  /* 脚本按顶层横幅注释切块。★ 用**字符偏移**切（不是按行数组 join）——
     这样"所有分块拼起来 === 原文"是**构造上成立**的，不依赖任何换行算术
     （第一版按行拼就踩了 off-by-one，重建校验当场把它拦下来了，ui.html 已自动还原）。 */
  const cuts: number[] = [0];
  const bannerRe = /^\/\* (={10,}|-{10,})/gm;
  for (const m of js.matchAll(bannerRe)) {
    const at = m.index ?? 0;
    if (at > 0) cuts.push(at);
  }
  cuts.push(js.length);
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    const text = js.slice(start, end);
    /* 模块名取横幅块里的**说明行**（原文的横幅长这样：
         /* ======…
          * 其它页签：健康 / 成本 / 表现 / Prompt
          * ======… *​/
       所以看前 3 行里第一个 `* 文字`）。取不到就退回序号，绝不写空名。 */
    const headLines = text.split('\n', 4);
    const descLine = headLines.slice(0, 4).find((l) => /^\s*\*\s*\S/.test(l) && !/^\s*\*?\s*[=/-]{6,}\s*$/.test(l));
    const label = (descLine ?? '').replace(/^\s*\*\s*/, '').replace(/\s*$/, '').trim() || `脚本分块 ${i + 1}`;
    const n = String(30 + i).padStart(2, '0');
    write(`${n}-${slug(label)}.js`, 'js', label, text);
  }
  write('90-shell-end.html', 'shell', 'HTML 外壳（收尾）', shellEnd);

  /* 清理清单外的旧模块：--split 会按横幅重新编号，旧编号文件不清就会留下同名不同排的孤儿
     （实测踩过：目录里同时有 41-设置弹窗.js 与 41-切片库…js，而清单只认后者）。 */
  const keep = new Set(parts.map((p) => p.file));
  for (const f of fs.readdirSync(MOD_DIR)) {
    if (!keep.has(f)) {
      fs.rmSync(path.join(MOD_DIR, f), { recursive: true, force: true });
      console.log(`     清理清单外的旧模块：${f}`);
    }
  }

  fs.writeFileSync(MANIFEST, JSON.stringify({ note: '这些片段按序拼接即 public/ui.html；改 UI 请改模块后跑 npm run build:ui', parts }, null, 2), 'utf8');

  const rebuilt = assemble(readParts());
  if (rebuilt !== src) {
    fs.writeFileSync(HTML, src, 'utf8');
    throw new Error('重建结果与拆分前不一致 —— 已还原 ui.html（拆分逻辑有 bug，模块未生效）');
  }
  console.log(`  ✅ 已拆成 ${parts.length} 个模块（${parts.filter((p) => p.kind === 'js').length} 个 JS 分块），重建与原文逐字节一致`);
  for (const p of parts) console.log(`     ${p.file.padEnd(34)} ${p.kind.padEnd(5)} ${p.label.slice(0, 30)}`);
}

function doBuild(): void {
  const html = assemble(readParts());
  fs.writeFileSync(HTML, html, 'utf8');
  console.log(`  ✅ 已从 ${readParts().length} 个模块重建 public/ui.html（${html.length} 字节）`);
}

function doCheck(): void {
  const html = fs.readFileSync(HTML, 'utf8');
  const rebuilt = assemble(readParts());
  if (html !== rebuilt) {
    const a = html.length;
    const b = rebuilt.length;
    let i = 0;
    while (i < Math.min(a, b) && html[i] === rebuilt[i]) i++;
    throw new Error(
      `ui.html 与模块不一致（产物 ${a} 字节 / 模块拼出 ${b} 字节，首个差异在第 ${i} 字节附近）。` +
        `改 UI 必须改 web/src/* 再跑 npm run build:ui，不能只改产物。`,
    );
  }
  console.log('  ✅ ui.html 与 web/src/* 一致（改 UI 请改模块）');
}

const mode = process.argv[2] ?? '--check';
if (mode === '--split') doSplit();
else if (mode === '--build') doBuild();
else doCheck();
