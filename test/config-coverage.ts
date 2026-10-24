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

section('6. 「切片投稿方式」开关（追加切片投稿 / 单独投稿）的端到端三件套');
{
  /* 2026-10-16 用户要求：切片投稿要能选「追加切片投稿」（进同一个稿件的分P）或
     「单独投稿」（每片一稿）。这是一个**行为分流**开关，而这个仓库里"开关点了没反应"
     已经出过两次（`multiPart` 在自动流程里从没被读、llm_dtype 传错了位置）——
     两次都是"界面看着开了、链路里没人读"。所以这里钉住五件事。 */
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')) as {
    publish?: Record<string, unknown>;
  };
  const daemonText = fs.readFileSync(path.join(ROOT_DIR, 'src', 'daemon.ts'), 'utf8');
  ok('① 产物里有 #c_clipPublishMode 控件', /id="c_clipPublishMode"/.test(uiHtml));
  ok(
    '② 两个选项都在（追加切片投稿 / 单独投稿）',
    /data-mode="append"[^>]*>追加切片投稿/.test(uiHtml) && /data-mode="standalone"[^>]*>单独投稿/.test(uiHtml),
  );
  ok(
    '③ saveCfg 里真的存它，且 multiPart 由它派生（两个键必须一致，否则配置自相矛盾）',
    /clipPublishMode:\s*clipModeFromForm\(\)/.test(saveText) &&
      /multiPart:\s*clipModeFromForm\(\)\s*===\s*'append'/.test(saveText),
  );
  ok('④ config.json 里真有这个键（不然存了也没人读）', cfg.publish !== undefined && 'clipPublishMode' in cfg.publish);
  ok(
    '⑤ ★ 服务端真的按它分流（daemon 用 resolveClipPublishMode 判定，而不是只看 multiPart）',
    /resolveClipPublishMode\(cfg\.publish\)/.test(daemonText) && /clipMode === 'append'/.test(daemonText),
  );
  ok(
    '⑥ 两个模式的差别在界面上写清楚了（等不等完整版稿件 / 占几个额度 / 能不能错峰）',
    /等完整版稿件/.test(uiHtml) && /每片占 1 个每日额度/.test(uiHtml) && /错峰/.test(uiHtml),
  );
}

section('7. 「单独投稿 ⇒ 定时投稿 + 片间隔/抖动按设置生效」的端到端门禁');
{
  /* 2026-10-16 用户要求：「选择单独投稿后，切片会默认以定时投稿的方式、每个投稿 5 分钟的间隔进行投稿」。
     这条规则有两层：口径（resolveClipPublishSchedule）与**送达**（真正发给 B站 的 dtime）。
     口径有纯函数测试（dtime-schedule）与真 payload 测试（standalone-schedule）盯着，
     这里只钉"接线没断"：常量在、切片路径真的调它、界面与 bootstrap 都跟着这个口径走。 */
  const cfgText = fs.readFileSync(path.join(ROOT_DIR, 'src', 'config.ts'), 'utf8');
  const pubText = fs.readFileSync(path.join(ROOT_DIR, 'src', 'publish.ts'), 'utf8');
  const serverText = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.ts'), 'utf8');
  const steps = fs.readFileSync(path.join(ROOT_DIR, 'verify.steps.json'), 'utf8');

  ok('① 常量就是 300 秒（5 分钟）', /export const STANDALONE_CLIP_GAP_SEC = 300;/.test(cfgText));
  ok(
    '② 切片投稿路径真的调 resolveClipPublishSchedule(cfg.publish)（而不是自己读 immediatePublish）',
    /const sched = resolveClipPublishSchedule\(cfg\.publish\);/.test(pubText),
  );
  ok(
    '③ ★ 单切片路径不再直接读 config 的立即发布（那正是"改了口径但链路没读"的事故形态）',
    !/let immediate = cfg\.publish\.immediatePublish === true;/.test(pubText),
  );
  ok(
    '④ bootstrap 把生效口径下发（界面四处「错峰 X」不再各自读 config.publish.clipGapSec）',
    /publishSchedule: \(\(\) => \{/.test(serverText) && /resolveClipPublishSchedule\(liveCfg\.publish\)/.test(serverText),
  );
  ok(
    '⑤ 界面用下发的口径渲染（publishSchedule() 在模块里被调用）',
    /<span>\$\{sched\.scheduled \? `错峰 \$\{fmtSpan\(sched\.gapSec\)\}`/.test(uiHtml) && /function publishSchedule\(\)/.test(moduleText),
  );
  ok(
    '⑥ 设置面板写明「单独投稿固定定时投稿 + 片间隔/抖动按设置生效（300 保底、抖动<间隔）」，且旧红字已删',
    /固定走定时投稿/.test(uiHtml) &&
      /低于 300 会被抬到 300/.test(uiHtml) &&
      /hintClipGapUse/.test(uiHtml) &&
      /paintScheduleHints/.test(uiHtml) &&
      /scheduleFormula/.test(uiHtml) &&
      !/对切片都不生效/.test(uiHtml),
    '设置面板里的排期文案没跟上新口径（或旧的"这两项对切片都不生效"红字还在）',
  );
  ok(
    '⑦ 真 payload 测试（standalone-schedule）已接入 verify 清单与 package.json',
    /"standalone-schedule-test"/.test(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) && /standalone-schedule-test/.test(steps),
  );
  /* ★ 2026-10-17 口径（用户要求「这里改成对定时投稿也生效」）：单独投稿分支必须真的**用**
     clipGapSec / jitterSec，而不是像 2026-10-16 那样把它们钉死成 300 / 0。
     这两行字符串就是那条口径：间隔取 max(平台底线, 用户值)、抖动走同一道夹子。
     它们被改坏时的表现极其隐蔽 —— 配置页写着 500/120，排期仍是每 5 分钟等距。 */
  ok(
    '⑧ ★ 单独投稿分支真的用 clipGapSec（间隔 = max(300, 用户值)，不再钉死常量）',
    /Math\.max\(STANDALONE_CLIP_GAP_SEC, rawGap\)/.test(cfgText),
    'src/config.ts 的 resolveClipPublishSchedule 里找不到 `Math.max(STANDALONE_CLIP_GAP_SEC, rawGap)`',
  );
  ok(
    '⑨ ★ 单独投稿分支的抖动走同一道夹子（effectiveJitterSec，防排期倒挂）',
    /effectiveJitterSec\(rawJitter, gapSec\)/.test(cfgText),
    'src/config.ts 里找不到 `effectiveJitterSec(rawJitter, gapSec)`',
  );
  ok(
    '⑩ effectiveJitterSec 定义在 config.ts（避免 publish→config→publish 循环依赖），publish 侧仍导出同名',
    /export function effectiveJitterSec/.test(cfgText) && /export \{ effectiveJitterSec \}/.test(pubText),
  );
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
