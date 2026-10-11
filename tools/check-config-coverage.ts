/**
 * 配置面一致性检查（2026-10-12，优化第三批 ⑩）。
 *
 * 起因：`config.json` 有 **238 个叶子字段**，而设置面板只暴露 **81 个输入** —— 那么：
 *   · 哪些字段**既没界面、也没校验**（改错了没人拦、也没法在界面改）？
 *   · 哪些界面控件**看起来能改、其实根本没接到保存逻辑**（`saveCfg` 里没有它）？← 这是真 bug 类
 *   · 哪些字段**有校验没界面**（只能手改 config.json，改错会被拦）？
 *
 * 这个工具只报告、不改任何东西（读 config.json、web/src/*.js、src/config.ts）。
 * 用法：node tools/check-config-coverage.ts [--write]
 *   --write 时把报告写到 data/config-coverage.md（便于贴给你看）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const CFG = path.join(ROOT_DIR, 'config.json');
const WEB_SRC = path.join(ROOT_DIR, 'web', 'src');

/** 收集 config.json 的所有叶子路径（a.b.c） */
function leaves(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.push(...leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

const cfgRaw = JSON.parse(fs.readFileSync(CFG, 'utf8')) as Record<string, unknown>;
const cfgLeaves = leaves(cfgRaw).sort();
const cfgRoots = new Set(cfgLeaves.map((p) => p.split('.')[0]!));

/* 界面：所有 #c_xxx 控件 id（openCfg 里生成的）+ saveCfg 里出现的 id */
const uiFiles = fs.readdirSync(WEB_SRC).filter((f) => f.endsWith('.js'));
let uiText = '';
for (const f of uiFiles) uiText += `\n${fs.readFileSync(path.join(WEB_SRC, f), 'utf8')}`;
const allIds = new Set<string>();
/* 只读/禁用的控件：属于展示字段，不该被算成"没接到保存"（实测 #c_uiPort 就是这种） */
const readonlyIds = new Set<string>();
for (const m of uiText.matchAll(/<input[^>]*id="(c_[A-Za-z0-9_]+)"[^>]*>/g)) {
  if (/\s(readonly|disabled)\b/.test(m[0])) readonlyIds.add(m[1]!);
}
for (const m of uiText.matchAll(/id="(c_[A-Za-z0-9_]+)"/g)) allIds.add(m[1]!);
for (const m of uiText.matchAll(/num\('#(c_[A-Za-z0-9_]+)'\)|val\('#(c_[A-Za-z0-9_]+)'\)|bool\('#(c_[A-Za-z0-9_]+)'\)|txt\('#(c_[A-Za-z0-9_]+)'\)/g)) {
  const id = m[1] ?? m[2] ?? m[3] ?? m[4];
  if (id) allIds.add(id);
}
/* saveCfg 的区间：从 function saveCfg 到下一个顶层 function */
/* 取 saveCfg 的**函数体**：用花括号配对，不能用正则（第一版就是被 \n} 提前截断，
   结果报出"81 个控件全部没接到保存"这种一眼假的结论 —— 假警报比没有报告更糟）。 */
function bodyOf(src: string, header: string): string {
  const at = src.indexOf(header);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}
const saveText = bodyOf(uiText, 'async function saveCfg(');
const savedIds = new Set<string>();
for (const m of saveText.matchAll(/c_[A-Za-z0-9_]+/g)) savedIds.add(m[0]);

/* 校验：src/config.ts 里提到的配置路径 */
const cfgTs = fs.readFileSync(path.join(ROOT_DIR, 'src', 'config.ts'), 'utf8');
const validatedPaths = new Set<string>();
for (const m of cfgTs.matchAll(/\b((?:room|asr|llm|publish|clip|analyze|record|cleanup|notify|runtime|bililive|danmaku|schedule|mcp)\.[a-zA-Z0-9_.]+)/g)) {
  validatedPaths.add(m[1]!);
}
const isValidated = (p: string): boolean => {
  if (validatedPaths.has(p)) return true;
  /* ★ 权威来源：校验规则的声明处 = err('path', …) / warn('path', …) 的第一个参数。
     原先只靠"源码里出现过的路径字符串"（外加父级前缀命中），遇到 cfg.cleanup.deleteAfterUpload
     这类解构写法就判不出来 ⇒ 实测假阴性（把已校验字段报成孤儿，192 这个数字因此不可信）。 */
  for (const m of cfgTs.matchAll(/(?:err|warn)\(\s*'([A-Za-z0-9_.]+)'/g)) validatedPaths.add(m[1]!);
  /* 前缀命中也算（validateConfig 常校验父对象） */
  for (const v of validatedPaths) if (p.startsWith(`${v}.`)) return true;
  return false;
};

/* 界面控件 → 是否在 saveCfg 里被保存（"看着能改其实没接"就是这里露出来的） */
const uiNotSaved = [...allIds].filter((id) => !savedIds.has(id) && !readonlyIds.has(id)).sort();

/* 配置字段分类 */
const noUi: string[] = [];
const noValidation: string[] = [];
const orphans: string[] = [];
for (const p of cfgLeaves) {
  const root = p.split('.')[0]!;
  /* 只有"用户可调"的根才关心：internal/meta 之类不算 */
  if (!cfgRoots.has(root)) continue;
  const validated = isValidated(p);
  if (!validated) noValidation.push(p);
  if (!validated && !['version', 'meta'].includes(root)) orphans.push(p);
}

const report = [
  '# 配置面一致性报告',
  '',
  `- config.json 叶子字段：**${cfgLeaves.length}**`,
  `- 设置面板控件（#c_*）：**${allIds.size}**，其中 saveCfg 里真正保存的：**${savedIds.size}**`,
  `- src/config.ts 里被校验到的配置路径（含父级命中）：**${cfgLeaves.filter(isValidated).length}**`,
  '',
  '## ⚠️ 界面控件没接到保存（看着能改、其实改不了）',
  ...(uiNotSaved.length ? uiNotSaved.map((x) => `- \`#${x}\``) : ['- （无）']),
  '',
  '## 有校验但没界面（只能手改 config.json）',
  ...(() => {
    const list = cfgLeaves.filter((p) => isValidated(p) && ![...allIds].some((id) => p.toLowerCase().includes(id.replace(/^c_/, '').toLowerCase())));
    return list.length ? list.slice(0, 60).map((x) => `- \`${x}\``) : ['- （无）'];
  })(),
  '',
  '## 既没校验也没界面（孤儿字段，共 ' + orphans.length + '）',
  ...orphans.slice(0, 60).map((x) => `- \`${x}\``),
  orphans.length > 60 ? `- … 还有 ${orphans.length - 60} 个` : '',
  '',
  '> 说明：这是**只读报告**。孤儿字段不一定是问题（有些是内部状态），但"没校验也没界面"意味着改错没人拦。',
].filter((x) => x !== '');

const text = report.join('\n');
console.log(text);

if (process.argv.includes('--write')) {
  const out = path.join(ROOT_DIR, 'data', 'config-coverage.md');
  fs.writeFileSync(out, text, 'utf8');
  console.log(`\n  已写入 ${path.relative(ROOT_DIR, out)}`);
}
