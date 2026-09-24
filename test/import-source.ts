/**
 * 导入来源标记自测：**自动导入与手动导入必须分得清**。
 *
 * 背景（用户实测报的缺陷，2026-09-23）：界面上看到
 *   `1 候选　手动导入`
 * 但那场其实是**目录轮询自己捡起来的**。根因：自动导入与手动导入走的是同一个
 * `daemon.importLocal()`，而它把三处身份信息全部写死：
 *   · `manual: true`
 *   · 任务 id 前缀 `manual-`
 *   · 标题后缀「（手动导入）」
 * 于是用户完全分不清一条任务是"我自己点的"还是"它自己捡的"——
 * 这两者的含义完全不同（前者我知道它花了钱，后者是后台自己跑的）。
 *
 * 本测试锁住：
 *   1. `importIdentity()` 按来源给出 id 前缀 / 标题后缀 / manual 标记
 *   2. 显式传入的标题不被加后缀（两种来源都不加）
 *   3. `summarizeTask()` 把来源透出给界面（含旧台账的兼容退化）
 *   4. 轮询那条腿**确实**把 source:'auto' 传下去了（去掉了就等于缺陷复发）
 *   5. 页面与 ui-e2e 的构建标记保持同步（否则界面可能还是旧代码）
 *
 * 运行：node test/import-source.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { importIdentity, summarizeTask } from '../src/daemon.ts';
import { cleanLiveTitle } from '../src/publish.ts';
import type { TaskRecord } from '../src/types.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'C:\\Users\\demo\\Downloads\\Bilibili\\甲主播\\2026-09-23 20-50-00-000 来两下闪身步就好了.mp4';
const NOW = '2026-09-23T12:51:02.675Z';

/* ========================================================================== */
section('① 自动导入：id 前缀 auto-、标题不带人为后缀、manual=false');
{
  const a = importIdentity({ videoPath: FILE, source: 'auto' }, NOW);
  ok('id 前缀是 auto-', a.id.startsWith('auto-'), a.id);
  ok('id 形状合法（前缀-14位时间戳-4位随机）', /^(auto|manual)-\d{14}-[a-z0-9]{4}$/.test(a.id), a.id);
  eq('manual 标记为 false', a.manual, false);
  eq('importSource=auto', a.importSource, 'auto');
  eq('标题就是录制标题本身（不加「（手动导入）」）', a.title, '2026-09-23 20-50-00-000 来两下闪身步就好了');
  ok('标题里不出现「手动导入」', !a.title.includes('手动导入'), a.title);
}

section('② 手动导入（默认）：保持既有行为不变');
{
  const m = importIdentity({ videoPath: FILE }, NOW);
  ok('id 前缀是 manual-', m.id.startsWith('manual-'), m.id);
  eq('manual 标记为 true', m.manual, true);
  eq('importSource=manual', m.importSource, 'manual');
  eq('标题带「（手动导入）」后缀', m.title, '2026-09-23 20-50-00-000 来两下闪身步就好了（手动导入）');
  /* 显式传了 source:'manual' 也一样 */
  eq('显式 manual 与默认一致', importIdentity({ videoPath: FILE, source: 'manual' }, NOW).importSource, 'manual');
}

section('③ 显式标题：两种来源都原样使用，不擅自加后缀');
{
  eq(
    '自动导入 + 显式标题',
    importIdentity({ videoPath: FILE, title: '自定义标题', source: 'auto' }, NOW).title,
    '自定义标题',
  );
  eq(
    '手动导入 + 显式标题',
    importIdentity({ videoPath: FILE, title: '自定义标题', source: 'manual' }, NOW).title,
    '自定义标题',
  );
  eq(
    '标题两端的空白被裁掉',
    importIdentity({ videoPath: FILE, title: '  留白  ', source: 'auto' }, NOW).title,
    '留白',
  );
}

section('④ 兼容性：投稿标题的清洗规则不受影响');
{
  const m = importIdentity({ videoPath: FILE }, NOW);
  const a = importIdentity({ videoPath: FILE, source: 'auto' }, NOW);
  /* 清洗会同时去掉录制器的时间前缀与「（手动导入）」后缀 */
  eq('手动导入的标题清洗后 = 纯直播标题', cleanLiveTitle(m.title), '来两下闪身步就好了');
  eq('自动导入的标题清洗后 = 同一个标题', cleanLiveTitle(a.title), '来两下闪身步就好了');
  eq('两种来源清洗后完全一致（后缀不会漏进投稿标题）', cleanLiveTitle(m.title), cleanLiveTitle(a.title));
  ok('原始标题确实带着后缀（否则上一条断言看不出差别）', m.title.endsWith('（手动导入）'), m.title);
}

/* ========================================================================== */
const CTX = { stageIndex: 3, statusText: '已分析', when: '09-23 20:51' };
function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: 'x',
    roomId: '12345678',
    platform: 'Bilibili',
    title: 'T',
    status: 'ANALYZED',
    stage: 'ANALYZED',
    source: { segments: [], totalDuration: 600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as TaskRecord;
}

section('⑤ 界面拿到的来源（summarizeTask）：三种来源各自可辨');
{
  eq('自动导入 → auto', summarizeTask(task({ importSource: 'auto', manual: false }), CTX).importSource, 'auto');
  eq('手动导入 → manual', summarizeTask(task({ importSource: 'manual', manual: true }), CTX).importSource, 'manual');
  eq('录制触发（无标记）→ recording', summarizeTask(task({}), CTX).importSource, 'recording');
  /* 旧台账：只有 manual 布尔值，那时自动导入也被写成 true → 只能退化为「手动导入」 */
  eq('旧台账（只有 manual:true）→ manual（可接受的退化）', summarizeTask(task({ manual: true }), CTX).importSource, 'manual');
  eq('旧台账（无 manual）→ recording', summarizeTask(task({ manual: false }), CTX).importSource, 'recording');
  eq('manual 字段本身保持向后兼容', summarizeTask(task({ importSource: 'auto', manual: false }), CTX).manual, false);
}

/* ========================================================================== */
section('⑥ 接线：轮询那条腿必须真的传 source:auto（否则缺陷复发）');
{
  const daemonSrc = fs.readFileSync(path.join(ROOT, 'src', 'daemon.ts'), 'utf8').replace(/\s+/g, ' ');
  ok(
    "daemon 里轮询的 importFn 传了 source: 'auto'",
    daemonSrc.includes("this.importLocal({ ...input, source: 'auto' })"),
    '没找到该调用 —— 去掉它就等于「自动导入显示成手动导入」复发',
  );
  ok(
    '轮询只在这一处接 importLocal（不存在漏传的第二条路）',
    (daemonSrc.match(/this\.importLocal\(/g) ?? []).length === 1,
    String((daemonSrc.match(/this\.importLocal\(/g) ?? []).length),
  );

  const ui = fs.readFileSync(path.join(ROOT, 'public', 'ui.html'), 'utf8');
  ok('界面按 importSource 显示「自动导入」', ui.includes("t.importSource === 'auto'") && ui.includes('自动导入'));
  ok('界面保留「手动导入」（含旧台账的 manual 兜底）', ui.includes("else if (t.manual || t.importSource === 'manual')"));
  ok('任务卡片不再只看 t.manual 就打「手动导入」', !ui.includes("if (t.manual) extra.push('手动导入')"));

  /* 页面与 e2e 的构建标记必须一致：否则界面可能还是旧代码而验证却是绿的 */
  const build = /const UI_BUILD = '([^']+)'/.exec(ui)?.[1];
  const expected = /const UI_BUILD_EXPECTED = '([^']+)'/.exec(
    fs.readFileSync(path.join(ROOT, 'tools', 'ui-e2e.ts'), 'utf8'),
  )?.[1];
  ok('ui.html 有构建标记', Boolean(build), String(build));
  eq('ui-e2e 期望的构建标记与页面一致', expected, build);
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
if (fail > 0) process.exitCode = 1;
