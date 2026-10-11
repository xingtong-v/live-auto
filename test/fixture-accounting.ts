/**
 * 「测试夹具」与真实业务的**分账**（2026-10-11）。
 *
 * 背景（实测）：10-06 / 10-08 / 10-10 每天建 **38–45 个任务**，真实直播只有 **2–7 场**，
 * 其余是自动化测试造的夹具（`测试场次` ×22、`【界面测试】固定夹具任务` ×8 …）。
 * 后果：① 任务列表被淹没；② 成本月度汇总被夹具拉偏（数字不再代表真实开销）。
 *
 * 这个套件锁三件事：
 *   1. 识别口径（`isFixtureTask`）——含**反例**：游戏主播真的会播"测试服"，那必须算真实场次；
 *   2. 接口把标记带出去（`tasks[].fixture` + `monthly.fixturesExcluded`）；
 *   3. 成本统计**真的排除**夹具（而且如实报出剔了几个，不许静默改口径）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';
import { isFixtureTask, splitFixtures } from '../src/fixtures.ts';
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
function eq(title: string, got: unknown, want: unknown): void {
  ok(title, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/* ========================================================================== */
section('1. 识别口径：id 前缀 / 标题特征 / 台账显式标记');
{
  ok('显式标记最可靠（新夹具都该写它）', isFixtureTask({ id: 'anything', title: '任意标题', fixture: true }));
  ok('id 前缀 uie2e-', isFixtureTask({ id: 'uie2e-fixture-123', title: '随便' }));
  ok('id 前缀 mon-', isFixtureTask({ id: 'mon-batch-a', title: '随便' }));
  ok('id 前缀 mp-test-', isFixtureTask({ id: 'mp-test-0001', title: '多分P路由测试场' }));
  ok('id 前缀 perf-t / timing- / dbg- / ab-', ['perf-t3-mp', 'timing-180', 'dbg-1', 'ab-trim-1'].every((id) => isFixtureTask({ id })));
  ok('标题「测试场次」', isFixtureTask({ id: 'x1', title: '测试场次' }));
  ok('标题以【界面测试】开头', isFixtureTask({ id: 'x2', title: '【界面测试】固定夹具任务' }));
  ok('标题以【测试】开头', isFixtureTask({ id: 'x3', title: '【测试】可恢复的任务' }));

  /* ★ 反例（比正例更重要）：真实场次绝不能被误判成夹具 */
  ok(
    '★ 反例：游戏主播播「测试服开荒」是真场次，不是夹具',
    !isFixtureTask({ id: 'auto-20261011190000-abcd', title: '【2D】测试服开荒，先测一下新角色' }),
  );
  ok('★ 反例：标题里含"测试"但不在前缀/全名表里 → 真场次', !isFixtureTask({ id: 'auto-20261011190000-efgh', title: '新版本内测体验' }));
  ok('★ 反例：普通场次（含真实 id 形态）', !isFixtureTask({ id: 'auto-20261010140346-ygk1', title: '【电台】和lulu双人棉花糖！' }));
  ok('★ 反例：manual- 开头的**真实**手动导入场次（只有 -test 结尾才算夹具）', !isFixtureTask({ id: 'manual-20261010140346-x1y2', title: '手动导入的一场' }));

  const split = splitFixtures([
    { id: 'auto-1', title: '真实场' },
    { id: 'uie2e-1', title: '夹具' },
    { id: 'auto-2', title: '测试服开荒' },
    { id: 'mon-batch-a', title: '夹具' },
  ]);
  eq('分账把 2 真实 / 2 夹具分开', [split.real.length, split.fixtures.length], [2, 2]);
}

/* ========================================================================== */
section('2. 接口把标记带出去 + 成本统计真的排除夹具');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fixture-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
const orch = new Orchestrator({ ledger, dataDirOverride: dataDir });
orch.logger.setConsole(false);

const mkTask = (id: string, title: string, cost: { asr: number; llm: number }): void => {
  ledger.createTask({
    id,
    roomId: '1',
    title,
    stage: 'PUBLISHED',
    status: 'PUBLISHED',
    source: { segments: [], totalDuration: 100, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: cost.asr, asrAudioSeconds: 3600, llmActual: cost.llm, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 3, updatedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};
mkTask('auto-20261011120000-real1', '【电台】真实场一', { asr: 1.0, llm: 0.2 });
mkTask('auto-20261011130000-real2', '测试服开荒（真场次）', { asr: 2.0, llm: 0.3 });
mkTask('uie2e-fixture-1', '【界面测试】固定夹具任务', { asr: 9.0, llm: 9.0 });
mkTask('mon-batch-a', '测试场次', { asr: 9.0, llm: 9.0 });

const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
/* ⚠️ 必须 await start()：不启动的话 ui.url 指向一个没人监听的端口，fetch 会 EADDRNOTAVAIL
   （第一版就是这么挂的 —— 报错看着像网络问题，其实是忘了起服务）。 */
await ui.start();
try {
  const body = (await (await fetch(`${ui.url}/api/tasks`)).json()) as {
    tasks: Array<{ id: string; fixture?: boolean }>;
    monthly: { total: number; fixturesExcluded?: number; tasks: number };
    fixtureTotal?: number;
  };
  const byId = new Map(body.tasks.map((t) => [t.id, t]));
  ok('★ 真实场次不带 fixture 标记', !byId.get('auto-20261011120000-real1')?.fixture && !byId.get('auto-20261011130000-real2')?.fixture);
  ok('★ 含"测试"字样的真实场次也不会被标记（反例守住）', byId.get('auto-20261011130000-real2')?.fixture !== true);
  ok('★ 夹具带 fixture 标记（界面据此默认隐藏 + 打 🔧 标）', byId.get('uie2e-fixture-1')?.fixture === true && byId.get('mon-batch-a')?.fixture === true);
  eq('接口报出夹具条数', body.fixtureTotal, 2);
  eq('月度成本里如实写明剔了几个夹具', body.monthly.fixturesExcluded, 2);
  eq('★ 成本只算真实场次（1.0+2.0 ASR / 0.2+0.3 LLM）', body.monthly.total, 3.5);
  eq('成本里的场次数也只剩真实场次', body.monthly.tasks, 2);
} finally {
  ui.stop();
  orch.stop();
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ========================================================================== */
section('3. 界面接线（静态核对，防止以后把默认值改回去）');
{
  const html = fs.readFileSync(path.join(ROOT_DIR, 'public', 'ui.html'), 'utf8');
  ok('★ 任务列表默认隐藏夹具', /const shown = showFixtureTasks \? all : all\.filter\(\(t\) => !t\.fixture\)/.test(html));
  ok('★ 有开关且写清藏了几个（不静默）', /显示测试夹具（\$\{fixtures\.length\}）/.test(html));
  ok('夹具行本身也打标（打开开关后认得出）', /🔧 测试夹具/.test(html));
  ok('空列表时说明是"夹具被隐藏"而不是"没有任务"', /另有 \$\{fixtures\.length\} 个测试夹具被隐藏/.test(html));
  /* 2026-10-14：原来是 `个**测试夹具**任务` —— 提示语是原生 HTML，星号会**原样显示**在界面上，
     所以全仓 11 处这类写法统一改成了 <b> 标签；这条断言跟着改成新写法（不是放宽，是改对了）。 */
  ok('成本卡片写明已排除夹具', /已排除 <b>\$\{costData\.monthly\.fixturesExcluded\}<\/b> 个<b>测试夹具<\/b>任务/.test(html));
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.ts'), 'utf8');
  ok('成本统计走 splitFixtures（口径只此一处）', /const \{ real, fixtures \} = splitFixtures\(tasks\)/.test(serverSrc));
  ok('任务摘要里带上 fixture 标记', /fixture: isFixtureTask\(t\)/.test(serverSrc));
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
