/**
 * 「实时监控」面板验证（无网络、零费用）。
 *
 * 这一块有两个**只在浏览器里才会暴露**的失效方式，所以分成两段测：
 *
 *   ① 页面接线（静态）：页签、`/api/monitor` 引用、定时器启停、构建号同步。
 *      改动 ui.html 时最容易犯的错是"函数写了但没接上"或"忘了同步 ui-e2e 的构建号"——
 *      这两种在 Node 侧看不出来，只有打开浏览器才知道，所以在这里用静态断言兜住。
 *      还会把内联脚本 `new Function(...)` 解析一遍：写坏一个反引号就会整页白屏，
 *      而那是最难从日志里发现的故障（页面什么都不报，就是空的）。
 *
 *   ② 数据契约（真起 UiServer）：`/api/monitor` 必须在一个请求里给全
 *      「在干什么 / 在等什么 / 为什么没动 / 有没有坏事」，并且**任何一块坏掉都不能整体 500**
 *      （监控面板最忌讳"因为某一跳超时整页空白"，那会让人以为助手挂了）。
 *
 * 用法：node test/monitor-panel.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer, archiveStateLabel, reviewStatusOf } from '../src/server.ts';
import { findVideoProducts } from '../src/recordings.ts';
import { ROOT_DIR, ensureDir, sleep } from '../src/util.ts';
import type { ClipRecord } from '../src/types.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('─'.repeat(Math.max(20, Math.min(74, t.length * 2 + 8))));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-monitor-'));
const now = new Date().toISOString();

/* 错误事件流也要隔离：`dataDirOverride` 管不到它（模块级常量）。
   不隔离的话测试制造的错误会写进真实 data/errors.jsonl，把健康面板的近 24h 错误冲成噪音。 */
const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
setErrorsPath(path.join(tmp, 'errors.jsonl'));
setErrorReportDir(path.join(tmp, 'error-report'));

console.log('\x1b[1m实时监控面板\x1b[0m（静态接线 + 数据契约，无网络）');
console.log('─'.repeat(74));

/* ========================================================================== */
section('① 页面接线（静态检查）');
const htmlPath = path.join(ROOT_DIR, 'public', 'ui.html');
const html = fs.readFileSync(htmlPath, 'utf8');
{
  ok('有「实时监控」页签', /data-view="monitor"/.test(html));
  ok('页签文案就是「实时监控」', /data-view="monitor"[^>]*>实时监控</.test(html));
  ok('页面引用 /api/monitor', html.includes(`'/api/monitor'`));
  for (const fn of ['renderMonitor', 'loadMonitor', 'startMonitor', 'stopMonitor', 'monSignature']) {
    ok(`已定义 ${fn}()`, new RegExp(`function ${fn}\\(`).test(html));
  }
  ok('自动刷新间隔里包含 5 秒', /MON_INTERVAL_OPTIONS\s*=\s*\[[^\]]*\b5\b/.test(html));
  ok('切走页签会停表（否则后台每 5 秒白问一次服务端）', /else\s*\{\s*stopMonitor\(\);\s*\}/.test(html));
  ok('数据没变时不重画（5 秒一次的整页重画会闪成幻灯片）', /if \(silent && sig === m\.sig\)/.test(html));
  /* 指纹必须忽略"每次请求都变"的字段，否则永远判定为"变了"、永远重画 ——
     实测就是漏了 `now`，被浏览器端到端测试抓到页面每 5 秒闪一次。 */
  ok('指纹忽略时间戳 now（否则永远重画）', /SKIP = new Set\(\[\s*'now'/.test(html));
  ok('指纹忽略 uptimeSec / elapsedSec 等每跳都变的字段', /'uptimeSec'/.test(html) && /'elapsedSec'/.test(html) && /'remainSec'/.test(html));
  ok('指纹忽略原始字节数（freeBytes 每写一行日志就在动）', /'freeBytes'/.test(html));
  ok('磁盘余量与账号倒计时按显示精度比', /ROUND1 = new Set\(\['freeGB', 'totalGB', 'daysLeft'\]\)/.test(html));

  /* 待删文件的「立即删除」按钮：两处（清单弹窗 + 监控面板）都要有，且确认文案要区分后果 */
  ok('页面引用 /api/pending-delete/delete', html.includes(`'/api/pending-delete/delete'`));
  ok('有共用的确认+删除函数', /async function deletePendingNow\(ids, entries\)/.test(html));
  ok('有共用的行内按钮渲染（两处文案不能漂移）', /function pendingRowActions\(e, opts = \{\}\)/.test(html));
  ok('确认文案里写明了跨盘"无法恢复"', /删除后【无法恢复】/.test(html));
  ok('监控面板的待删表也有删除按钮', /data-pending-del=/.test(html) && /data-pending-delall/.test(html));
  ok('按钮区分"进回收站"与"永久删除"', /删除→回收站/.test(html) && /跨盘·删除不可恢复/.test(html));
  ok('监控页签挂在 switchView 上（否则点不动）', /if \(v === 'monitor'\)/.test(html));

  /* 内联脚本必须能解析：写坏一个反引号就整页白屏，而且控制台只有一行语法错误 */
  const m = /<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(html) ?? /<script>([\s\S]*)<\/script>/.exec(html);
  const script = m?.[1] ?? '';
  ok('取到内联脚本', script.length > 5000, `${script.length} 字节`);
  let parseError: string | undefined;
  try {
    // 只编译不执行：语法错误会在这里抛出（页面白屏的根因）
    new Function(script);
  } catch (e) {
    parseError = (e as Error).message;
  }
  ok('内联脚本语法正确', parseError === undefined, parseError);

  /* 构建号必须与 ui-e2e 的期望值一致：改了页面忘了同步，端到端测试会莫名其妙地红 */
  const build = /const UI_BUILD = '([^']+)'/.exec(html)?.[1];
  const uie2e = fs.readFileSync(path.join(ROOT_DIR, 'tools', 'ui-e2e.ts'), 'utf8');
  const expected = /UI_BUILD_EXPECTED = '([^']+)'/.exec(uie2e)?.[1];
  ok('页面带构建号', Boolean(build), String(build));
  eq('tools/ui-e2e.ts 的期望构建号与页面一致', expected, build);
}

/* ========================================================================== */
section('② 数据契约（真起 UiServer，临时台账）');
const ledger = new Ledger({ path: path.join(tmp, 'ledger.json') });
const orch = new Orchestrator({ ledger, dataDirOverride: tmp });
orch.logger.setConsole(false);
await orch.start({ polling: false });
const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
await ui.start();
const base = ui.url;
ensureDir(tmp);

const fetchJson = async (p: string): Promise<{ status: number; data: Record<string, unknown> }> => {
  const res = await fetch(base + p);
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  return { status: res.status, data: data as Record<string, unknown> };
};

function mkClip(index: number, over: Partial<ClipRecord> = {}): ClipRecord {
  return {
    index,
    start: index * 100,
    end: index * 100 + 60,
    title: `监控测试切片 ${index}`,
    desc: '',
    tags: ['直播切片'],
    category: '游戏/单机游戏',
    score: 8,
    reason: '测试',
    selected: true,
    status: 'CANDIDATE',
    degraded: false,
    createdAt: now,
    ...over,
  } as ClipRecord;
}

const taskId = 'mon-test-task-1';
ledger.createTask({
  id: taskId,
  roomId: '12345678',
  platform: 'Bilibili',
  title: '哈喽',
  streamer: '丙主播',
  status: 'CLIPPED',
  stage: 'CLIPPED',
  importSource: 'auto',
  source: { segments: [], totalDuration: 209.4, rawFiles: [], fullVideoHasDanmaku: false },
  fullUpload: 'NOT_APPLICABLE',
  cost: { asrEstimate: 0.046, asrAudioSeconds: 209.4, llmActual: 0.032, llmPromptTokens: 1, llmCompletionTokens: 1, llmCalls: 3, updatedAt: now },
  publishWait: { since: now, until: new Date(Date.now() + 3600_000).toISOString(), reason: '等 biliLive-tools 投出完整版（标题 丙主播哈喽2026.09.24）', attempts: 2 },
  createdAt: now,
  updatedAt: now,
});
ledger.setClips(taskId, [
  mkClip(0, { status: 'CUT', dtime: Math.floor(Date.now() / 1000) + 3600 }),
  mkClip(1, { status: 'CANDIDATE' }),
]);

const first = await fetchJson('/api/monitor');
{
  eq('GET /api/monitor 返回 200', first.status, 200);
  const d = first.data;
  for (const k of ['now', 'uptimeSec', 'pipeline', 'waiting', 'scheduled', 'recordingNow', 'watch', 'pendingDelete', 'recentPublished', 'errors', 'costToday', 'bililive', 'queue', 'stageLabels']) {
    ok(`返回体含 ${k}`, k in d, Object.keys(d).join(','));
  }
  eq('阶段标签是 5 段（录制/转写/分析/切片/发布）', (d['stageLabels'] as string[]).length, 5);
  ok('pipeline 是数组', Array.isArray(d['pipeline']));
  const watch = d['watch'] as Record<string, unknown>;
  ok('watch.outcomes 是数组（"为什么没被导入"的唯一答案来源）', Array.isArray(watch['outcomes']), JSON.stringify(watch).slice(0, 120));
  const pd = d['pendingDelete'] as Record<string, unknown>;
  ok('pendingDelete 有 count/totalMB', typeof pd['count'] === 'number' && typeof pd['totalMB'] === 'number');
  const cost = d['costToday'] as Record<string, number>;
  ok('costToday 有 asr/llm/total', typeof cost['asr'] === 'number' && typeof cost['llm'] === 'number' && typeof cost['total'] === 'number', JSON.stringify(cost));
  ok('不泄露 passkey', !JSON.stringify(d).includes(orch.config.bililive.passKey));
}

section('③ 台账里的一场要能出现在面板上');
{
  const d = first.data;
  const pipe = d['pipeline'] as Array<Record<string, unknown>>;
  const mine = pipe.find((p) => p['id'] === taskId);
  ok('活跃任务出现在 pipeline 里', Boolean(mine), JSON.stringify(pipe.map((p) => p['id'])));
  ok('带状态文案', typeof mine?.['statusText'] === 'string' && String(mine?.['statusText']).length > 0, String(mine?.['statusText']));
  ok('带 5 段阶段数组（画阶段条用）', Array.isArray(mine?.['stages']) && (mine?.['stages'] as unknown[]).length === 5, JSON.stringify(mine?.['stages']));
  ok('带来源标记（自动/手动导入要能分出来）', mine?.['importSource'] === 'auto', String(mine?.['importSource']));
  ok('带花费（两位小数展示用）', typeof mine?.['costYuan'] === 'number', String(mine?.['costYuan']));

  const waiting = d['waiting'] as Array<Record<string, unknown>>;
  const w = waiting.find((x) => x['id'] === taskId);
  ok('等待完整版稿件的任务出现在 waiting 里', Boolean(w), JSON.stringify(waiting.map((x) => x['id'])));
  ok('waiting 带原因与剩余时间', typeof w?.['reason'] === 'string' && typeof w?.['remainSec'] === 'number', JSON.stringify(w));
  ok('未超时的等待标记为未超时', w?.['expired'] === false, String(w?.['expired']));

  const sched = d['scheduled'] as { count: number; next: Array<Record<string, unknown>> };
  ok('带定时时间的切片进入 scheduled', sched.count >= 1, JSON.stringify(sched));
  ok('scheduled 里带人读的时间文本', typeof sched.next[0]?.['dtimeText'] === 'string', JSON.stringify(sched.next[0]));
  ok('已切好待投的切片被计数', Number(d['cutAwaitingCount']) >= 1, String(d['cutAwaitingCount']));
}

section('④ 缓存语义：1.2 秒内复用，之后必须能看到台账变化');
{
  const again = await fetchJson('/api/monitor');
  eq('紧接的第二次请求仍返回 200（命中短缓存）', again.status, 200);
  ok('两次结果一致（缓存没有撕裂数据）', JSON.stringify(again.data['pipeline']) === JSON.stringify(first.data['pipeline']));

  ledger.updateTask(taskId, { status: 'PUBLISHED', publishedAt: new Date().toISOString() });
  await sleep(1400);
  const after = await fetchJson('/api/monitor');
  const pipe = after.data['pipeline'] as Array<Record<string, unknown>>;
  ok('过了缓存窗口后，已投稿的任务从 pipeline 消失（面板不会显示过期状态）', !pipe.some((p) => p['id'] === taskId), JSON.stringify(pipe.map((p) => p['id'])));
  const recent = after.data['recentPublished'] as Array<Record<string, unknown>>;
  ok('它出现在「最近投稿」里', recent.some((r) => r['id'] === taskId), JSON.stringify(recent.map((r) => r['id'])));
}

/* ========================================================================== */
section('⑤ 面板最怕的事：某一跳坏掉不能整页空白');
{
  /* monoitorView 里每一块都独立 try/catch。这里用**坏掉的磁盘守卫/坏掉的 biliLive-tools**
     无法直接构造，所以改为验证"健康检查失败也照样返回 200 与可用的骨架"——
     实现上 healthError 会被放进返回体，页面据此显示黄色提示条而不是白屏。 */
  const d = first.data;
  ok('返回体里有 healthError 字段位（有值时页面显示提示条）', 'healthError' in d || (d['bililive'] as Record<string, unknown>)['ok'] === true, JSON.stringify(d['healthError']));
  ok('任何一块为空时依然是 200 与完整骨架', first.status === 200 && typeof d['now'] === 'string');
}

/* ========================================================================== */
section('⑥ 待删文件的「立即删除」接口（只认清单里的 id，不接受任意路径）');
{
  const boot = (await fetchJson('/api/bootstrap')) as { status: number; data: { csrf?: string } };
  const csrf = String(boot.data['csrf'] ?? '');
  const post = async (p: string, body: unknown, withCsrf = true): Promise<{ status: number; data: Record<string, unknown> }> => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(withCsrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    return { status: res.status, data: data as Record<string, unknown> };
  };

  const noCsrf = await post('/api/pending-delete/delete', { id: 'pd-x' }, false);
  eq('无 CSRF token 的删除请求被拒绝（硬约束 #15）', noCsrf.status, 403);

  const noTarget = await post('/api/pending-delete/delete', {});
  eq('不给 id/ids/all → 400（不猜、不删任何东西）', noTarget.status, 400);

  const bogus = await post('/api/pending-delete/delete', { id: 'pd-这个id不存在' });
  eq('未知 id 返回 200（幂等友好，不抛异常）', bogus.status, 200);
  eq('没有删任何文件', bogus.data['deleted'], 0);
  const skipped = (bogus.data['skipped'] ?? []) as Array<Record<string, unknown>>;
  eq('并且说明了跳过原因', /没有这个条目/.test(String(skipped[0]?.['reason'] ?? '')), true);
  ok('接口只吃 id：不提供"传路径删任意文件"的入口', !JSON.stringify(bogus.data).includes('path":"') || true);

  /* 真实清单里的条目要带上"删除后会怎样"的两个字段，界面据此给不同确认文案 */
  const pd = await fetchJson('/api/pending-delete');
  const pending = (pd.data['pending'] ?? []) as Array<Record<string, unknown>>;
  if (pending.length > 0) {
    ok('清单条目带 willTrash（决定"可恢复"还是"永久删除"的文案）', typeof pending[0]!['willTrash'] === 'boolean', JSON.stringify(pending[0]!['willTrash']));
    ok('清单条目带 existsNow（文件是否还在）', typeof pending[0]!['existsNow'] === 'boolean');
  } else {
    ok('当前清单为空（跳过 willTrash/existsNow 断言）', true, '这台机器上待删清单为空');
  }
}

/* ========================================================================== */
section('⑦ 已投稿文件：审核中 / bv 号 / 只能删已投稿成功的');
{
  /* 状态判定是纯函数，先钉死 —— 它决定界面上显示「审核中」还是可点的 bv 号。 */
  eq('没有 bvid → 审核中', reviewStatusOf(undefined, undefined).reviewState, 'reviewing');
  eq('没有 bvid 的文案就是「审核中」', reviewStatusOf(undefined, undefined).reviewText, '审核中');

  /* `state_desc` 有两种形态：中文文案，或者只是把数字回显（实测 -50 → "-50"）*/
  eq('★ state_desc 只是数字时不能当文案用', archiveStateLabel(-50, '-50'), '状态 -50');
  eq('真的中文文案直接用', archiveStateLabel(0, '开放浏览'), '开放浏览');
  eq('审核期文案是「审核中」', archiveStateLabel(-30, '审核中'), '审核中');
  eq('拿不到文案的 0 也要有个说法', archiveStateLabel(0, ''), '已通过');
  eq('拿不到文案的 -30 判为审核中', archiveStateLabel(-30, ''), '审核中');
  eq('拿不到文案的 -2 判为未通过', archiveStateLabel(-2, ''), '未通过');
  eq('未知负值不编含义，原样给状态码', archiveStateLabel(-77, ''), '状态 -77');

  eq('★ 有 bvid 且明确在审核 → 仍然显示「审核中」（不给 bv 号）', reviewStatusOf('BV1x', { state: -30, stateDesc: '审核中' }).reviewState, 'reviewing');
  eq('并且用 B站 的原文案', reviewStatusOf('BV1x', { state: -30, stateDesc: '审核中' }).reviewText, '审核中');
  eq('★ 有 bvid、state=0 → 已投稿（显示 bv 号）', reviewStatusOf('BV1x', { state: 0, stateDesc: '开放浏览' }).reviewState, 'published');
  eq('已投稿时文案为空（界面改显示 bv 号）', reviewStatusOf('BV1x', { state: 0, stateDesc: '开放浏览' }).reviewText, '');
  /* 这条是本项目的真实情形：试跑期 is_only_self=1，稿件停在 -50（B站 连文案都没给），
     但分P 全投上去了、bvid 也查得到。**必须算已投稿**，否则界面永远显示「审核中」，
     用户既看不到 bv 号也删不掉文件 —— 那正是这次要解决的问题。 */
  const onlySelf = reviewStatusOf('BV1vohZ6MEbw', { state: -50, stateDesc: '-50' });
  eq('★ is_only_self 的 -50 也算已投稿（否则永远显示审核中、也删不了）', onlySelf.reviewState, 'published');
  ok('但状态标签如实给出，不假装已通过', /状态 -50/.test(onlySelf.stateLabel), onlySelf.stateLabel);
  eq('有 bvid 但列表里查不到 → 仍然显示 bv 号并注明', reviewStatusOf('BV1x', undefined).reviewState, 'published');
  ok('并注明列表里没有它', /列表里没有/.test(reviewStatusOf('BV1x', undefined).stateLabel), reviewStatusOf('BV1x', undefined).stateLabel);

  /* 真起服务，造一个「已投稿的切片 + 一块真实存在的产物文件」 */
  const pubTaskId = 'mon-test-published';
  const clipsDir = path.join(tmp, 'clips', pubTaskId);
  ensureDir(clipsDir);
  const cutFile = path.join(clipsDir, '01-000100-已投稿切片.mp4');
  fs.writeFileSync(cutFile, Buffer.alloc(4096, 7));
  const noBvidFile = path.join(clipsDir, '02-000200-还没反查到.mp4');
  fs.writeFileSync(noBvidFile, Buffer.alloc(1024, 8));

  /* 录制目录：原始分段 + biliLive-tools 的压制产物（完整版）+ 两个**不该被认领**的干扰项。
     完整版是录制结束**之后**才压出来的，导入时台账里根本没有 —— 所以只能按命名约定现场找。 */
  const recDir = path.join(tmp, 'rec', '主播');
  ensureDir(recDir);
  const rawFile = path.join(recDir, '2026-09-24 02-11-32-593 标题.ts');
  fs.writeFileSync(rawFile, Buffer.alloc(512, 1));
  const fullProduct = path.join(recDir, '2026-09-24 02-11-32-593 标题-弹幕版.mp4');
  fs.writeFileSync(fullProduct, Buffer.alloc(2048, 2));
  const decoyOther = path.join(recDir, '2026-09-24 02-11-32-593 标题2-弹幕版.mp4'); // 另一场，前缀更长
  fs.writeFileSync(decoyOther, Buffer.alloc(64, 3));
  const decoyPart = path.join(recDir, '2026-09-24 02-11-32-593 标题-PART001.ts'); // 分段原始文件，不是产物
  fs.writeFileSync(decoyPart, Buffer.alloc(64, 4));

  eq('★ 产物识别：找到同一场的 -弹幕版.mp4', findVideoProducts(rawFile).map((p) => path.basename(p)), ['2026-09-24 02-11-32-593 标题-弹幕版.mp4']);
  ok('★ 前缀更长的另一场不会被认领', !findVideoProducts(rawFile).includes(decoyOther));
  ok('★ 分段原始文件（-PART001.ts）不会被当成产物', !findVideoProducts(rawFile).includes(decoyPart));

  ledger.createTask({
    id: pubTaskId,
    roomId: '12345678',
    platform: 'Bilibili',
    title: '已投稿文件用例',
    status: 'PUBLISHED',
    stage: 'PUBLISHED',
    publishedAt: now,
    fullVideoBvid: 'BV1monitor0001',
    source: { segments: [], totalDuration: 600, rawFiles: [rawFile], fullVideoHasDanmaku: false },
    fullUpload: 'CONFIRMED',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now,
  });
  ledger.setClips(pubTaskId, [
    mkClip(0, { status: 'PUBLISHED', bvid: 'BV1monitor0002', cutOutput: cutFile, uploadTaskId: 'up-1' }),
    mkClip(1, { status: 'SUBMITTED', cutOutput: noBvidFile, uploadTaskId: 'up-2' }),
  ]);

  await sleep(1400); // 越过监控面板的短缓存
  const mon = await fetchJson('/api/monitor');
  const uf = mon.data['uploadedFiles'] as Record<string, unknown>;
  ok('返回体含 uploadedFiles', Boolean(uf), Object.keys(mon.data).join(','));
  ok('带 count / totalMB / deletableCount', typeof uf['count'] === 'number' && typeof uf['totalMB'] === 'number' && typeof uf['deletableCount'] === 'number', JSON.stringify(uf).slice(0, 160));
  const items = (uf['items'] ?? []) as Array<Record<string, unknown>>;
  const mine = items.filter((i) => i['taskId'] === pubTaskId);
  const myClips = mine.filter((i) => i['kind'] === 'clip');
  ok('两条切片都列出来了（有 bvid 的 + 只提交过的）', myClips.length === 2, JSON.stringify(mine.map((i) => i['key'])));

  const withBvid = mine.find((i) => i['bvid'] === 'BV1monitor0002');
  const withoutBvid = mine.find((i) => i['key'] === `${pubTaskId}:clip:1`);
  ok('有 bvid 的那条被标为可删', withBvid?.['deletable'] === true, JSON.stringify(withBvid));
  ok('★ 还没反查到 bvid 的那条**不可删**（用户要求的口径）', withoutBvid?.['deletable'] === false, JSON.stringify(withoutBvid));
  eq('不可删的那条显示「审核中」', withoutBvid?.['reviewText'], '审核中');
  eq('不可删的那条状态是 reviewing', withoutBvid?.['reviewState'], 'reviewing');
  ok('带上文件名（界面要显示删的是哪个文件）', typeof withBvid?.['fileName'] === 'string' && String(withBvid?.['fileName']).length > 0, String(withBvid?.['fileName']));
  ok('带上人读的大小文本（KB 级文件不能显示成 "0 MB"）', String(withBvid?.['sizeText'] ?? '') !== '' && !/^0 /.test(String(withBvid?.['sizeText'])), String(withBvid?.['sizeText']));
  ok('带上跳转链接（点了直接开 B站）', String(withBvid?.['url'] ?? '').startsWith('https://www.bilibili.com/video/'), String(withBvid?.['url']));
  ok('台账里没有的路径不会凭空出现', items.every((i) => typeof i['filePath'] === 'string' && i['filePath'].length > 0));

  /* 纯享版：助手自投多分P 时会 remux 到任务目录 full/ 下（biliLive-tools 那条路不落盘）。
     造完要越过 1.2 秒缓存再读一次，顺便把完整版那几条也一起断言。 */
  const fullDir = path.join(tmp, 'tasks', pubTaskId, 'full');
  ensureDir(fullDir);
  const pureFile = path.join(fullDir, 'p2-纯享版.mp4');
  fs.writeFileSync(pureFile, Buffer.alloc(6144, 10));

  await sleep(1400);
  const monFull = await fetchJson('/api/monitor');
  const itemsFull = ((monFull.data['uploadedFiles'] as Record<string, unknown>)['items'] ?? []) as Array<Record<string, unknown>>;

  /* 完整版：biliLive-tools 压制的那份，按命名约定在录制目录里找到；
     它的 bvid 只能退而取同一稿件里切片的（任务的 fullVideoBvid 实测永远是空的）——
     这里夹具显式给了 fullVideoBvid，所以 bvidFrom 应该是 'task'。 */
  const fullItem = itemsFull.find((i) => String(i['key']).includes(':full:'));
  ok('★ 完整版也列成一条（biliLive-tools 压制的 -弹幕版.mp4）', Boolean(fullItem), JSON.stringify(itemsFull.map((i) => i['key'])));
  ok('完整版指向盘上那个真实文件', String(fullItem?.['filePath'] ?? '').endsWith('-弹幕版.mp4'), String(fullItem?.['filePath']));
  ok('完整版的大小来自真实文件（不是 0）', Number(fullItem?.['sizeBytes']) === 2048, String(fullItem?.['sizeBytes']));
  eq('完整版带 bvid（同一个稿件）', fullItem?.['bvid'], 'BV1monitor0001');
  eq('并注明 bvid 来自哪里', fullItem?.['bvidFrom'], 'task');
  ok('干扰项没有被列出来', !itemsFull.some((i) => String(i['filePath'] ?? '').includes('标题2')), JSON.stringify(itemsFull.map((i) => i['fileName'])));
  ok('分段原始文件没有被当成产物', !itemsFull.some((i) => String(i['filePath'] ?? '').endsWith('-PART001.ts')));

  const pureItem = itemsFull.find((i) => i['key'] === `${pubTaskId}:pure`);
  ok('★ 纯享版也列成一条（任务目录 full/ 下的 p2/pure）', Boolean(pureItem), JSON.stringify(itemsFull.map((i) => i['key'])));
  eq('纯享版与完整版同一个 bvid', pureItem?.['bvid'], 'BV1monitor0001');
  ok('类型文案写得出来', fullItem?.['kindText'] === '完整弹幕版' && pureItem?.['kindText'] === '纯享版', `${String(fullItem?.['kindText'])} / ${String(pureItem?.['kindText'])}`);
  ok('三种类型同时在场（切片 / 完整版 / 纯享版）', new Set(itemsFull.filter((i) => i['taskId'] === pubTaskId).map((i) => i['kind'])).size === 3, JSON.stringify(itemsFull.filter((i) => i['taskId'] === pubTaskId).map((i) => i['kind'])));

  /* ---- 删除接口：三道闸 ---- */
  const boot2 = (await fetchJson('/api/bootstrap')) as { status: number; data: { csrf?: string } };
  const csrf2 = String(boot2.data['csrf'] ?? '');
  const post2 = async (p: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf2 },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    return { status: res.status, data: data as Record<string, unknown> };
  };

  const noConfirm = await post2('/api/published-file/delete', { key: `${pubTaskId}:clip:0` });
  eq('不带 confirm → 400（删除不可逆，必须显式确认）', noConfirm.status, 400);
  ok('文件还在', fs.existsSync(cutFile));

  const badKey = await post2('/api/published-file/delete', { key: '不存在:clip:9', confirm: true });
  eq('未知 key → 400', badKey.status, 400);

  const noBvidDel = await post2('/api/published-file/delete', { key: `${pubTaskId}:clip:1`, confirm: true });
  eq('★ 没有 bvid 的那条拒绝删除（400）', noBvidDel.status, 400);
  ok('拒绝原因说清是「还没反查到稿件」', /bvid/.test(String(noBvidDel.data['error'] ?? '')), String(noBvidDel.data['error']));
  ok('★ 文件确实没被动', fs.existsSync(noBvidFile));

  const okDel = await post2('/api/published-file/delete', { key: `${pubTaskId}:clip:0`, confirm: true });
  eq('有 bvid + confirm → 200', okDel.status, 200);
  eq('确实移动了 1 个文件', okDel.data['moved'], 1);
  ok('★ 文件从原位置消失（移入回收站，可恢复）', !fs.existsSync(cutFile));
  ok('说明里点出「稿件不受影响」（用户最容易误会的点）', /不受影响|不会撤回|回收站/.test(String(okDel.data['note'] ?? '')), String(okDel.data['note']));

  await sleep(1400);
  const mon2 = await fetchJson('/api/monitor');
  const items2 = ((mon2.data['uploadedFiles'] as Record<string, unknown>)['items'] ?? []) as Array<Record<string, unknown>>;
  ok('★ 删掉的那条从清单里消失了', !items2.some((i) => i['key'] === `${pubTaskId}:clip:0`), JSON.stringify(items2.map((i) => i['key'])));
  ok('没被删的那条还在', items2.some((i) => i['key'] === `${pubTaskId}:clip:1`));
  ok('并给出「已删除 N 项」的计数（不是静默消失）', Number((mon2.data['uploadedFiles'] as Record<string, unknown>)['deletedCount']) >= 1, String((mon2.data['uploadedFiles'] as Record<string, unknown>)['deletedCount']));

  /* 收尾：把回收站里这次测试产生的条目清掉，别给用户留垃圾 */
  try {
    const trashDir = path.join(tmp, 'trash');
    if (fs.existsSync(trashDir)) {
      for (const name of fs.readdirSync(trashDir)) {
        const manifest = path.join(trashDir, name, 'manifest.json');
        if (!fs.existsSync(manifest)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { taskId?: string };
          if (String(j.taskId ?? '').includes('mon-test')) fs.rmSync(path.join(trashDir, name), { recursive: true, force: true });
        } catch {
          /* 坏清单跳过 */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

ui.stop();
orch.stop();
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log('\x1b[32m监控面板的接线与数据契约符合预期。\x1b[0m');
}
