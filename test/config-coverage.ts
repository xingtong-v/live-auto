/**
 * 配置面覆盖的静态门禁（2026-10-14 补写）。
 *
 * 背景：package.json 里声明了 `config-coverage-test` → `node test/config-coverage.ts`，
 * 但这个文件**一直不存在**（而我这一段工作之前它也没进 verify 清单，所以没人发现）。
 * 补成真测试，钉住三条"改坏了就会让界面骗人"的性质：
 *
 *   ① **界面上能改的，必须真的存得下去**：`public/ui.html` 里每个 `#c_*` 控件，
 *      要么在设置模块的 saveCfg 里被读走，要么是 `readonly`/`disabled` 的展示字段。
 *      少了这一步，就会出现"点了保存、看着成功、其实没生效"（这个项目踩过）。
 *   ② 反过来：saveCfg 里读的 `#c_*`，控件必须真的存在（否则是永远取到 undefined 的死代码）。
 *   ③ 新增开关的**端到端三件套**：控件存在 + 存盘引用了它 + config.json 里真有这个键
 *      （只有前两件叫"界面上能点"，第三件才叫"真能生效"）。
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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const uiDir = path.join(ROOT_DIR, 'web', 'src');
const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'ui.html'), 'utf8');
/* 界面源码 = web/src/*.js 全量（saveCfg 可能被拆到任意模块里） */
const moduleText = fs
  .readdirSync(uiDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => fs.readFileSync(path.join(uiDir, f), 'utf8'))
  .join('\n');
/* saveCfg 那一段（从 async function saveCfg 到下一个顶层函数） */
const saveStart = moduleText.indexOf('async function saveCfg');
const saveText = saveStart >= 0 ? moduleText.slice(saveStart, saveStart + 20000) : '';

section('1. 界面上能改的，必须真的存得下去');
{
  const allIds = new Set<string>();
  const readonlyIds = new Set<string>();
  for (const m of uiHtml.matchAll(/<input[^>]*id="(c_[A-Za-z0-9_]+)"[^>]*>/g)) {
    allIds.add(m[1]!);
    if (/\s(readonly|disabled)\b/.test(m[0])) readonlyIds.add(m[1]!);
  }
  for (const m of uiHtml.matchAll(/<select[^>]*id="(c_[A-Za-z0-9_]+)"[^>]*>/g)) allIds.add(m[1]!);
  for (const m of uiHtml.matchAll(/<button[^>]*id="(c_[A-Za-z0-9_]+)"[^>]*>/g)) allIds.add(m[1]!);
  ok('产物里能扫到一批 #c_* 控件', allIds.size > 50, String(allIds.size));

  const saved = new Set<string>();
  for (const m of saveText.matchAll(/c_[A-Za-z0-9_]+/g)) saved.add(m[0]);
  const unsaved = [...allIds].filter((id) => !saved.has(id) && !readonlyIds.has(id)).sort();
  ok(
    '★ 没有"看着能改其实改不了"的控件（只读展示字段不算）',
    unsaved.length === 0,
    unsaved.length ? `未接到保存：${unsaved.join(', ')}` : '',
  );
  ok('只读控件确实被识别出来了（否则上一条会假绿）', readonlyIds.size >= 2, `readonly=${readonlyIds.size}`);
}

section('2. 反过来：saveCfg 读的控件必须真的存在');
{
  const declared = new Set<string>();
  for (const m of uiHtml.matchAll(/id="(c_[A-Za-z0-9_]+)"/g)) declared.add(m[1]!);
  const read = new Set<string>();
  for (const m of saveText.matchAll(/['"]#(c_[A-Za-z0-9_]+)['"]/g)) read.add(m[1]!);
  const ghosts = [...read].filter((id) => !declared.has(id)).sort();
  ok('★ saveCfg 里没有"读了但控件不存在"的死引用', ghosts.length === 0, ghosts.join(', '));
}

section('3b. 解码器精度开关（bf16）的端到端三件套');
{
  /* 2026-10-13 加。这个开关踩过一次"看着开了其实没生效"：
     llm_dtype 曾传在 generate() 里、而 funasr 只在构造模型时读它 ⇒ 静默忽略。
     所以这里钉住四件事：控件在、saveCfg 存它、config.json 有它、
     且**旁边写清实测数字**（省 33% 显存、推理 +10%）——否则用户没法做取舍。 */
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')) as {
    asr?: { localFunasr?: Record<string, unknown> };
  };
  ok('① 产物里有 #c_funasrBf16 开关', /id="c_funasrBf16"/.test(uiHtml));
  ok('② saveCfg 里真的存它（asr.localFunasr.llmDtype，关掉时回写空串）', /llmDtype:\s*on\('#c_funasrBf16'\)\s*\?\s*'bf16'\s*:\s*''/.test(saveText));
  ok(
    '③ config.json 里真有这个键（不然存了也没人读）',
    cfg.asr?.localFunasr !== undefined && 'llmDtype' in (cfg.asr.localFunasr as object),
  );
  ok(
    '④ 开关旁边写了实测取舍（−33% 显存 / +10% 推理）',
    /id="c_funasrBf16"[\s\S]{0,900}?−33%/.test(uiHtml) && /id="c_funasrBf16"[\s\S]{0,900}?\+10%/.test(uiHtml),
  );
}

section('3. 新增开关的端到端三件套（以边录边转写为例）');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')) as { asr?: Record<string, unknown> };
  ok('① 产物里有 #c_incrementalEnabled 控件', /id="c_incrementalEnabled"/.test(uiHtml));
  ok('② saveCfg 里真的存它（asr.incrementalEnabled）', /incrementalEnabled:\s*on\('#c_incrementalEnabled'\)/.test(saveText), saveText.slice(0, 0) || '');
  ok('③ config.json 里真有这个键（不然存了也没人读）', cfg.asr !== undefined && 'incrementalEnabled' in cfg.asr);
  ok(
    '④ 控件旁边写清了"要重启服务才生效"（这是本项最容易误解的地方）',
    /id="c_incrementalEnabled"[\s\S]{0,1600}?(需要重启服务|需重启服务)/.test(uiHtml),
  );
}

section('4. 提示文案必须是原生 HTML（`**x**` 在界面上会原样显示成星号）');
{
  /* 实测缺陷（2026-10-14，用户截图）：提示语写成 `**已闭合**` —— hintline 是原生 HTML，
     不经过 markdown 渲染 ⇒ 屏幕上就是两个星号。全仓原本有 11 处这种写法（含我新加的那处）。 */
  const bad = [...uiHtml.matchAll(/class="hintline"[^>]*>([^<]*\*\*[^<]*)/g)].map((m) => m[1]!.slice(0, 60));
  ok('★ 提示文案里没有未渲染的 ** 星号（要用 <b> 就用标签）', bad.length === 0, bad.join(' ｜ '));
}

section('5. 被实测证伪/待验证的开关，必须在界面上写明结论（否则用户会凭直觉乱开）');
{
  ok('★ 静音裁剪写明「只省 12 秒、不建议开」', /只省 12 秒/.test(uiHtml) && /不建议开/.test(uiHtml));
  ok('★ 转写独立进程写明「慢约 18%、换崩溃隔离」', /慢约 18%/.test(uiHtml) && /崩溃隔离/.test(uiHtml));
  ok('★ whisper-cpp 标明「已被 Fun-ASR 压过，不推荐」', /不推荐/.test(uiHtml) && /差一倍/.test(uiHtml));
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
