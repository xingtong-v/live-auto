/**
 * 公开仓库前的**脱敏**工具（把真实身份信息换成合成值）。
 *
 * 为什么需要它：`npm run audit` 证明**没有凭据泄露**（passKey / API key / SendKey 都没进交付文件），
 * 但代码注释、文档、测试 fixture 里有大量**真实身份信息**：Windows 用户名、房间号、
 * 常看的主播名、账号 uid 与昵称。私有仓库无所谓，**公开仓库**等于把这些一起公开。
 *
 * 做法：按仓库根目录 `.sanitize-map.json`（**gitignore，绝不提交**）里的映射表替换，
 * **保留文件原有 BOM 状态**（`.ps1` 必须带 BOM、其它禁止带），并且只处理会被提交的那批文件
 * （`data/`、`node_modules/`、两个 venv、`.funasr/`、`config.json` 一律不碰）。
 *
 * 两个真实弹幕 fixture（`test/fixtures/danmaku-sample*.xml`）走特殊路径：
 * 只把 `<d p="...">正文</d>` 的**正文**换成 `测试弹幕N`，时间戳/模式等属性一个字不动 ——
 * 结构、条数、可解析性都不变，e2e 的断言（条数/密度）照旧成立，而观众的弹幕内容不再外泄。
 *
 * 用法：
 *   copy tools\sanitize-map.example.json .sanitize-map.json   # 首次：填真实值（该文件不提交）
 *   node tools/sanitize-for-public.ts --dry-run     # 只报告会改什么
 *   node tools/sanitize-for-public.ts               # 真正改写
 *   node tools/sanitize-for-public.ts --check       # 只查有没有漏网（含全角/空格/大小写变体），有则退 1
 *
 * 四个吃过的亏，都已经写进实现里：
 *   1. **映射表不能写在本文件里**。它左边那列就是真名，写死在这里等于"脱敏工具自己把要藏的
 *      东西印在封面上"——而且看起来像已经处理过了，比不脱敏更危险。现在表在 gitignore 的文件里，
 *      本文件只在替换时读它，自己永远不含真值。
 *   2. **本文件必须跳过自己**。表在文件里的时候，第一次跑完把 `from` 也换成了 `to`，
 *      整张表退化成恒等映射 —— 之后再跑就永远改不动任何东西。
 *   3. 字面替换**认不出全角写法**。真实稿件标题里出现过全角名字写法，半角规则一条都不命中，
 *      于是它留在了测试 fixture 里（既泄露、又把断言搞挂）。所以 `--check` 走 `NFKC` 归一化 +
 *      去空格 + 转小写三路比对，而不是简单的 `includes`。
 *   4. **绝不能碰 `.gitignore` 里的运行期文件**。第一版把 `config.json` 也脱敏了，
 *      而那是本机正在跑的配置：房间号、监听目录、DanmakuFactory 路径全变成假值，
 *      守护进程立刻热加载了假配置（自动导入/录制/烧弹幕静默失效）。见 `SKIP_PATHS`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const DRY = process.argv.includes('--dry-run');
const CHECK = process.argv.includes('--check');
const SELF = path.resolve(import.meta.filename);

/**
 * 替换表**不在这个文件里**，而是仓库根目录的 `.sanitize-map.json`（`.gitignore` 里，绝不提交）。
 *
 * 为什么：映射表左边那列**就是真名本身**。第一版把它写死在这里，于是"脱敏工具"一提交
 * 就等于把要藏的东西印在封面上 —— 那比不脱敏更糟，因为它看起来像已经处理过了。
 * 现在提交的是 `tools/sanitize-map.example.json`（模板），本机那份真表是 gitignore 的。
 *
 * 顺序敏感：长的、带后缀的先替换；`to` 为空串表示直接删掉该片段。
 */
const MAP_PATH = path.join(ROOT_DIR, '.sanitize-map.json');

function loadRules(): Array<{ from: string; to: string; note: string }> {
  if (!fs.existsSync(MAP_PATH)) {
    console.error(
      `\x1b[31m缺少映射表：${MAP_PATH}\x1b[0m\n` +
        `  复制模板后填入真实的房间号/主播名/用户名：\n` +
        `    copy tools\\sanitize-map.example.json .sanitize-map.json\n` +
        `  （该文件已在 .gitignore 中，不会被提交）`,
    );
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')) as {
    rules?: Array<{ from?: unknown; to?: unknown; note?: unknown }>;
  };
  const rules = (raw.rules ?? [])
    .filter((r) => typeof r.from === 'string' && r.from.length > 0 && typeof r.to === 'string')
    .map((r) => ({ from: r.from as string, to: r.to as string, note: typeof r.note === 'string' ? r.note : '' }));
  if (!rules.length) {
    console.error(`\x1b[31m映射表里没有有效规则：${MAP_PATH}\x1b[0m`);
    process.exit(2);
  }
  return rules;
}

const RULES = loadRules();

const SKIP_DIRS = /[\\/](data|node_modules|\.venv-asr|\.venv-funasr|\.funasr|\.git|\.sanitize-backup|logs|tasks|transcripts|cache|error-report)[\\/]/i;
/**
 * **绝对不许碰**的文件：它们是 `.gitignore` 里的运行期/凭据文件，压根不会进仓库，
 * 却是**本机正在跑的那份配置**。第一版没排除 `config.json`，跑完之后：
 * `room.roomId` 变成假的（守护进程去轮询一个不存在的直播间）、
 * `import.watch.dirs` 指向 `C:\Users\demo\Downloads\Bilibili`（目录不存在，自动导入静默失效）、
 * `danmaku.factoryPath` 指向不存在的 DanmakuFactory.exe（烧弹幕必失败）。
 * 脱敏的目标是"要提交的那批文件"，凡是 ignore 的一律跳过 —— 这条规则比新增一个文件名可靠。
 * 注意必须**按仓库内相对路径**匹配：`test/fixtures/config.json` 是真的要提交的 fixture，
 * 不能因为同名一起跳过（跳过它等于放着一份真房间号不脱敏）。
 */
const SKIP_PATHS = new Set([
  'config.json',
  'config.local.json',
  '.sanitize-map.json',
  'ledger.json',
  'ledger.json.tmp',
  'decisions.jsonl',
  'errors.jsonl',
  'performance.jsonl',
]);
const TEXT_EXT = /\.(ts|mjs|js|json|md|html|css|cmd|bat|ps1|xml|ass|srt|txt|yml|yaml|example)$/i;
/** 弹幕 fixture：只换正文 */
const DANMAKU_FIXTURES = ['test/fixtures/danmaku-sample.xml', 'test/fixtures/danmaku-sample-plain.xml'];

const skippedFiles: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (SKIP_DIRS.test(full + path.sep)) continue;
    if (e.isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(e.name)) {
      const rel = path.relative(ROOT_DIR, full).replace(/\\/g, '/');
      if (SKIP_PATHS.has(rel) || /\.(log|llc)$/i.test(e.name)) {
        skippedFiles.push(rel);
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

/** 三种写法：原样 / NFKC 归一化（全角→半角）/ NFKC 再去空白 */
function variants(text: string): Array<{ kind: string; text: string }> {
  const nfkc = text.normalize('NFKC');
  return [
    { kind: 'raw', text: text.toLowerCase() },
    { kind: 'nfkc', text: nfkc.toLowerCase() },
    { kind: 'nfkc-去空格', text: nfkc.replace(/[\s\u3000]+/g, '').toLowerCase() },
  ];
}

const files = walk(ROOT_DIR);
if (skippedFiles.length) {
  console.log(`\x1b[33m跳过 ${skippedFiles.length} 个运行期/凭据文件（.gitignore 里的，不进仓库也不该脱敏）：\x1b[0m`);
  console.log(`  ${skippedFiles.join('  ')}\n`);
}

/* ==========================================================================
 * --check：只查漏网，不改任何文件
 * ======================================================================== */
if (CHECK) {
  let leaks = 0;
  let scanned = 0;
  for (const file of files) {
    if (path.resolve(file) === SELF) continue;
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.includes('\u0000')) continue;
    scanned++;
    const vs = variants(raw);
    for (const r of RULES) {
      const probe = [r.from.normalize('NFKC').toLowerCase(), r.from.toLowerCase()].filter(
        (s, i, a) => s && a.indexOf(s) === i,
      );
      for (const v of vs) {
        const hit = probe.find((p) => v.text.includes(p));
        if (!hit) continue;
        leaks++;
        const i = v.text.indexOf(hit);
        const ctx = v.text.slice(Math.max(0, i - 40), i + hit.length + 40).replace(/\s+/g, ' ');
        console.log(`\x1b[31m✗\x1b[0m ${path.relative(ROOT_DIR, file)}  [${v.kind}]  ${r.from}`);
        console.log(`    …${ctx}…`);
        break;
      }
    }
  }
  console.log(
    leaks
      ? `\n\x1b[31m发现 ${leaks} 处漏网（扫了 ${scanned} 个文件）\x1b[0m`
      : `\n\x1b[32m✓ 无漏网：${scanned} 个文件里查不到任何真实身份信息（含全角/空格/大小写变体）\x1b[0m`,
  );
  process.exit(leaks ? 1 : 0);
}

/* ==========================================================================
 * 替换
 * ======================================================================== */
const perToken = new Map<string, number>();
const perFile = new Map<string, number>();
let changedFiles = 0;
let skippedSelf = 0;

for (const file of files) {
  const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
  if (path.resolve(file) === SELF) {
    skippedSelf = 1; // 见文件头「吃过的亏 1」
    continue;
  }
  const buf = fs.readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text = (hasBom ? buf.subarray(3) : buf).toString('utf8');
  const before = text;
  let hits = 0;

  if (DANMAKU_FIXTURES.includes(rel)) {
    // 只换弹幕正文，保留 p 属性
    text = text.replace(/(<d p="[^"]*">)([^<]*)(<\/d>)/g, (_m, a: string, body: string, c: string) => {
      if (!body.trim()) return `${a}${body}${c}`;
      hits++;
      return `${a}测试弹幕${hits}${c}`;
    });
  } else {
    for (const r of RULES) {
      const n = text.split(r.from).length - 1;
      if (n > 0) {
        text = text.split(r.from).join(r.to);
        hits += n;
        perToken.set(r.from, (perToken.get(r.from) ?? 0) + n);
      }
    }
  }

  if (text !== before) {
    changedFiles++;
    perFile.set(rel, hits);
    if (!DRY) {
      fs.writeFileSync(file, hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8'));
    }
  }
}

console.log(`${DRY ? '[dry-run] 将会修改' : '[已写入] 修改了'} ${changedFiles} / ${files.length} 个文件\n`);
console.log('按替换项统计：');
for (const r of RULES) {
  const n = perToken.get(r.from) ?? 0;
  if (n > 0) console.log(`  ${r.from.padEnd(22)} → ${(r.to || '(删除)').padEnd(20)} ${String(n).padStart(4)} 处   （${r.note}）`);
}
console.log('\n改动最多的 15 个文件：');
for (const [f, n] of [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(n).padStart(4)} 处  ${f}`);
}
console.log(`\n合计 ${[...perFile.values()].reduce((a, b) => a + b, 0)} 处替换${DRY ? '（未写盘；去掉 --dry-run 才会真改）' : ''}`);
if (skippedSelf) console.log('（已跳过本工具自身，映射表不会被自己改写；改完用 --check 复核）');
