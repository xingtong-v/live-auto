/**
 * 错误报告自测：**点得开、看得见、真实故障一定在里面**。
 *
 * 背景（用户报的「错误报告 目前没有任何效果」）：真浏览器里点「报告」按钮，弹窗
 * 根本不出现。查出来是三件事叠在一起：
 *
 *  1. `GET /api/error-report/:id` **只认报告文件**。报告文件会被清理、也可能当初写盘失败，
 *     而 `errors.jsonl` 的事件行（同步追加）还在 —— 实测 86 条事件里 74 条没有报告文件，
 *     点下去全是 404，界面只弹一个转瞬即逝的 toast，看起来就是"点了没反应"。
 *  2. 事件流本身被测试噪音占据（74/86 是 mock 测试的，且报告文件根本不在临时目录之外），
 *     真实错误反而看不见。
 *  3. **片段级失败压根不写错误报告**：`publish.ts` 里切/投失败只 `log.error` + 台账写
 *     `failReason`，`errors.jsonl` 一条都没有 —— 于是"错了却没有报告"。
 *
 * 本文件把这三条都钉住。全程临时目录隔离（错误事件流 / 报告目录 / 台账都指到 tmp）。
 *
 * 运行：node test/error-report.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/daemon.ts';
import { Ledger } from '../src/ledger.ts';
import { Publisher } from '../src/publish.ts';
import type { BiliLiveClient } from '../src/api.ts';
import type { AppConfig } from '../src/config.ts';
import { ROOT_DIR, ensureDir } from '../src/util.ts';
import { log as globalLog } from '../src/logger.ts';
import {
  findErrorEvent,
  loadErrorReportOrEvent,
  readErrorEvents,
  renderErrorTimeline,
  reportFromEvent,
  reportPathOf,
  setErrorReportDir,
  setErrorsPath,
  writeErrorReport,
  type ErrorEvent,
} from '../src/errors.ts';

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
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, actual === expected, actual === expected ? undefined : `期望 ${String(expected)}，实际 ${String(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-errrep-'));
ensureDir(tmp);
/* 三样都要隔离：事件流、报告目录、台账。它们都是模块级常量/单例，不隔离就会写进真实 data/ */
setErrorsPath(path.join(tmp, 'errors.jsonl'));
setErrorReportDir(path.join(tmp, 'error-report'));

console.log('\x1b[1m错误报告：点得开、看得见、真实故障一定在里面\x1b[0m');
console.log('─'.repeat(74));

/* ========================================================================== */
section('① 事件行 → 合成报告（报告文件没了也要能看）');
{
  const ev: ErrorEvent = {
    reportId: '2026-09-24T00-09-19-843Z-auto-test-0001',
    at: '2026-09-24T00:09:19.843Z',
    taskId: 'auto-test-0001',
    stage: 'CLIPPED',
    type: 'http-status',
    message: '切片任务提交失败：POST /task/cut 返回 500',
    retries: 2,
    endpoint: 'POST /task/cut',
    httpStatus: 500,
    reportPath: 'F:\\deepseek\\live_auto\\data\\error-report\\2026-09-24T00-09-19-843Z-auto-test-0001.json',
  };
  const r = reportFromEvent(ev);
  eq('reportId 原样带过来', r.reportId, ev.reportId);
  eq('时间原样带过来（时间线要对得上日志）', r.at, ev.at);
  eq('阶段带过来', r.stage, 'CLIPPED');
  eq('错误类型带过来', r.error.type, 'http-status');
  eq('错误消息带过来', r.error.message, ev.message);
  eq('任务号带过来（能跳回那一场）', r.taskId, 'auto-test-0001');
  eq('标记为"报告文件已不存在"', r.reportFileMissing, true);
  eq('时间线有 1 步', r.timeline.length, 1);
  ok('时间线说明"只保留了事件记录"', /只保留了错误事件记录/.test(r.timeline[0]!.step), r.timeline[0]!.step);
  ok('时间线里给出原始报告的应有路径（复查时能去找）', r.timeline[0]!.detail!.includes(ev.reportPath!), r.timeline[0]!.detail);
  ok('时间线里带上重试次数与接口', /重试 2 次/.test(r.timeline[0]!.detail!) && /\/task\/cut/.test(r.timeline[0]!.detail!), r.timeline[0]!.detail);
  eq('env.stage 有值（渲染器要用）', r.env.stage, 'CLIPPED');

  /* 坏数据不能把报告渲染搞崩：类型不认识 → 退回 internal；没有 reportPath → 自己算一个 */
  const weird = reportFromEvent({ ...ev, type: 'no-such-type' as ErrorEvent['type'], reportPath: '', retries: 0 });
  eq('未知错误类型退回 internal', weird.error.type, 'internal');
  eq('reportPath 缺失时按 reportId 现算', weird.timeline[0]!.detail!.includes(reportPathOf(ev.reportId)), true);

  const text = renderErrorTimeline(r);
  ok('渲染出的时间线含报告 ID', text.includes(ev.reportId));
  ok('渲染出的时间线含错误消息', text.includes('POST /task/cut 返回 500'));
  ok('渲染出的时间线写明"报告文件已不存在"', /只保留了错误事件记录/.test(text));
  ok('渲染器不因缺 request/env.tail 而抛错', text.length > 100, `${text.length} 字符`);
}

/* ========================================================================== */
section('② 降级链：先原始报告，再事件行，都没有才认输');
{
  /* 造一条真事件 + 真报告文件 */
  const res = writeErrorReport({
    taskId: 'errrep-1',
    stage: 'ANALYZING',
    error: new Error('测试用故障：调用失败'),
    type: 'http-status',
  });
  ok('写盘后报告文件存在', fs.existsSync(res.reportPath), res.reportPath);
  ok('写盘后事件流里有这条', readErrorEvents({}).some((e) => e.reportId === res.brief.reportId));

  const both = loadErrorReportOrEvent(res.brief.reportId);
  ok('有报告文件时取到原始报告', both?.synthesized === false);
  eq('原始报告不带降级标记', both?.report.reportFileMissing, undefined);

  /* 把报告文件删掉（模拟"被清理"）—— 事件行还在 */
  fs.rmSync(res.reportPath, { force: true });
  const onlyEvent = loadErrorReportOrEvent(res.brief.reportId);
  ok('报告文件没了仍能取到（合成件）', onlyEvent !== undefined);
  eq('并且标记为合成', onlyEvent?.synthesized, true);
  eq('合成件也带降级标记', onlyEvent?.report.reportFileMissing, true);
  ok('合成件的消息与原始一致', onlyEvent?.report.error.message.includes('测试用故障') === true, onlyEvent?.report.error.message);

  eq('reportId 不存在 → undefined（调用方据此 404）', loadErrorReportOrEvent('no-such-report-id'), undefined);
  eq('findErrorEvent 能按 reportId 找到事件', findErrorEvent(res.brief.reportId)?.reportId, res.brief.reportId);
  eq('findErrorEvent 找不到时返回 undefined', findErrorEvent('no-such-report-id'), undefined);
}

/* ========================================================================== */
section('③ HTTP 契约：GET /api/error-report/:id 不再 404（真起 UiServer）');
const ledger = new Ledger({ path: path.join(tmp, 'ledger.json') });
const orch = new Orchestrator({ ledger, dataDirOverride: tmp });
orch.logger.setConsole(false);
await orch.start({ polling: false });
const { UiServer } = await import('../src/server.ts');
const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
await ui.start();
const base = ui.url;

const getJson = async (p: string): Promise<{ status: number; data: Record<string, unknown> }> => {
  const res = await fetch(base + p);
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data: data as Record<string, unknown> };
};

{
  /* 3a. 只有事件行（报告文件不存在）→ 必须 200 + 合成件 + 有内容的时间线 */
  const orphan = writeErrorReport({ taskId: 'errrep-orphan', stage: 'CLIPPED', error: new Error('孤儿事件：报告文件会被删掉'), type: 'internal' });
  fs.rmSync(orphan.reportPath, { force: true });
  const r = await getJson(`/api/error-report/${encodeURIComponent(orphan.brief.reportId)}`);
  eq('报告文件不在但事件在 → HTTP 200（以前是 404）', r.status, 200);
  eq('响应标记 reportFileMissing', r.data['reportFileMissing'], true);
  ok('响应带非空 timeline（弹窗里能看到东西）', typeof r.data['timeline'] === 'string' && (r.data['timeline'] as string).length > 80, String(r.data['timeline']).slice(0, 60));
  const rep = r.data['report'] as { reportFileMissing?: boolean; error?: { message?: string }; timeline?: unknown[] } | undefined;
  eq('report.reportFileMissing 也是 true', rep?.reportFileMissing, true);
  ok('report.error.message 是原始消息', rep?.error?.message?.includes('孤儿事件') === true, rep?.error?.message);
  eq('report.timeline 非空', Array.isArray(rep?.timeline) && rep!.timeline!.length > 0, true);

  /* 3b. 报告文件在 → 原始报告，且不带降级标记 */
  const real = writeErrorReport({ taskId: 'errrep-real', stage: 'PUBLISHED', error: new Error('真实报告仍在盘上'), type: 'upload-failed' });
  const r2 = await getJson(`/api/error-report/${encodeURIComponent(real.brief.reportId)}`);
  eq('报告文件在 → 200', r2.status, 200);
  eq('不标记为降级', r2.data['reportFileMissing'], false);
  const rep2 = r2.data['report'] as { reportFileMissing?: boolean } | undefined;
  eq('原始报告不带 reportFileMissing', rep2?.reportFileMissing, undefined);

  /* 3c. text 格式（「一键复制」用）也要能拿到降级内容 */
  const t = await fetch(`${base}/api/error-report/${encodeURIComponent(orphan.brief.reportId)}?format=text`);
  const tText = await t.text();
  eq('format=text 也是 200', t.status, 200);
  ok('纯文本里写明报告文件已不存在', /只保留了错误事件记录/.test(tText), tText.slice(0, 80));

  /* 3d. 两边都没有 → 404，且带上可用报告清单（便于人工挑一个） */
  const r3 = await getJson('/api/error-report/definitely-not-a-report-id');
  eq('未知 reportId → 404', r3.status, 404);
  ok('404 里带 available 列表（指明去哪儿找）', Array.isArray(r3.data['available']), JSON.stringify(r3.data).slice(0, 120));
}

/* ========================================================================== */
section('④ 片段级失败必须进错误流（以前只写日志，错误报告里一条都没有）');
{
  const realCfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')) as AppConfig;
  /* 桩 client：只实现被断言用到的方法，其余用一个 Proxy 兜底（真调到了会抛错并暴露出来） */
  const client = new Proxy(
    // getLogContent 给空串：报告写盘后会异步补一次"对方侧日志"，拿不到不影响报告主体
    { getLogContent: async () => '', cut: async () => { throw new Error('不该走到这里'); } },
    {
      get(t, k) {
        if (k in t) return (t as Record<string, unknown>)[k as string];
        return async () => {
          throw new Error(`桩 client 未实现 ${String(k)}（测试不该调它）`);
        };
      },
    },
  ) as unknown as BiliLiveClient;

  const pub = new Publisher({ client, config: realCfg, ledger });
  /* 直接调私有方法：这些分支的**触发点**已经在源码里逐个接上（下面 4d 静态核对），
     这里验证的是"接上之后写出来的报告对不对"。 */
  const reportClipFailure = (pub as unknown as { reportClipFailure(i: Record<string, unknown>): void }).reportClipFailure.bind(pub);

  const before = readErrorEvents({}).length;
  reportClipFailure({
    taskId: 'errrep-clip',
    taskTitle: '错误报告测试场',
    clipIndex: 3,
    stage: 'CLIPPED',
    error: new Error('切片任务提交失败：POST /task/cut 500'),
    type: 'http-status',
  });
  const after = readErrorEvents({});
  eq('事件流多了 1 条', after.length, before + 1);
  const ev = after[after.length - 1]!;
  eq('事件挂在正确的任务上', ev.taskId, 'errrep-clip');
  eq('事件类型来自调用方', ev.type, 'http-status');
  eq('事件阶段是切片', ev.stage, 'CLIPPED');
  ok('消息里带片段号（否则"切片失败"无从定位）', /片段 #3/.test(ev.message), ev.message);
  ok('消息里带原始错误', /task\/cut 500/.test(ev.message), ev.message);

  const loaded = loadErrorReportOrEvent(ev.reportId);
  ok('完整报告也落盘了（不只是事件行）', loaded?.synthesized === false);
  eq('报告里记了 clipIndex', (loaded?.report.env.clipIndex as number | undefined), 3);
  eq('报告里记了 failReason', loaded?.report.env.failReason, '切片任务提交失败：POST /task/cut 500');
  eq('报告带任务标题', loaded?.report.taskTitle, '错误报告测试场');
  ok('报告的 ledgerEntries 里有片段号', JSON.stringify(loaded?.report.env.ledgerEntries ?? {}).includes('"clipIndex":3'), JSON.stringify(loaded?.report.env.ledgerEntries));
}

section('④b 发布路径的每个失败分支都接上了（静态核对，防止以后改漏）');
{
  const src = fs.readFileSync(path.join(ROOT_DIR, 'src', 'publish.ts'), 'utf8');
  const calls = src.match(/this\.reportClipFailure\(/g) ?? [];
  /* 6 处：源文件缺失 / 切片提交失败 / 切片任务失败 / 投稿任务失败 / 投稿抛错 / 多分P整批失败 */
  eq('publish.ts 里有 6 个片段级失败上报点', calls.length, 6);
  ok('切片提交失败分支已接上', /切片任务提交失败（片段 #\$\{clipIndex\}）[\s\S]{0,600}?this\.reportClipFailure\(/.test(src));
  ok('切片任务失败分支已接上', /切片任务失败（片段 #\$\{clipIndex\}[\s\S]{0,600}?this\.reportClipFailure\(/.test(src));
  ok('投稿失败分支已接上', /投稿失败（片段 #\$\{clipIndex\}[\s\S]{0,800}?this\.reportClipFailure\(/.test(src));
  ok('源文件缺失分支已接上（file-missing）', /找不到可用于切片的源文件[\s\S]{0,600}?this\.reportClipFailure\(/.test(src));
  ok('多分P整批失败逐个片段上报', /多分P投稿失败[\s\S]{0,900}?this\.reportClipFailure\(/.test(src));
  ok('上报失败不影响主流程（try/catch 包住）', /private reportClipFailure[\s\S]{0,400}?try \{/.test(src));
}

section('④c 端到端：源文件缺失这一分支真跑一遍（不需要任何桩）');
{
  const ledger2 = new Ledger({ path: path.join(tmp, 'ledger2.json') });
  const ID = 'errrep-nosource';
  ledger2.createTask({
    id: ID,
    roomId: '12345678',
    platform: 'Bilibili',
    title: '错误报告端到端场次',
    status: 'ANALYZED',
    stage: 'ANALYZED',
    source: { segments: [], totalDuration: 60, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
  });
  ledger2.setClips(ID, [
    {
      index: 0,
      start: 0,
      end: 30,
      title: '端到端切片',
      reason: '测试',
      score: 1,
      selected: true,
      status: 'CANDIDATE',
      degraded: false,
    },
  ] as Parameters<typeof ledger2.setClips>[1]);

  const realCfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')) as AppConfig;
  const client = new Proxy(
    {
      // 这两条是切片前的必经调用：报告补日志（拿不到就降级）与"按标题反查是否已投过"（空列表 = 没投过）
      getLogContent: async () => '',
      biliArchives: async () => [],
    },
    { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : async () => { throw new Error('不该调用 client'); }) },
  ) as unknown as BiliLiveClient;
  const pub = new Publisher({ client, config: realCfg, ledger: ledger2 });
  const before = readErrorEvents({}).length;
  const task = ledger2.getTask(ID)!;
  const r = await pub.cutAndUploadClip({ task, uid: 1 }, 0);
  eq('切片失败（没有源文件）', r.ok, false);
  eq('失败类型是 file-missing', r.error?.type, 'file-missing');
  const evs = readErrorEvents({});
  eq('错误流里多了 1 条（以前这里是 0）', evs.length, before + 1);
  const last = evs[evs.length - 1]!;
  eq('这条挂在端到端任务上', last.taskId, ID);
  eq('阶段是 CLIPPED', last.stage, 'CLIPPED');
  ok('消息里带片段号 #0', /片段 #0/.test(last.message), last.message);
  const loaded = loadErrorReportOrEvent(last.reportId);
  ok('对应报告文件也写出来了', loaded?.synthesized === false, `synthesized=${String(loaded?.synthesized)}`);
  eq('台账里切片被标为失败', ledger2.getClip(ID, 0)?.status, 'FAILED');
}

ui.stop();
orch.stop();
/* ⚠️ 先关日志再删临时目录：本测试把模块级 `log` 的目录也换到了 tmp 里（见上面的隔离说明），
   写入流若还指着被删掉的目录，异步写会以 ENOENT 收尾并让 node 以 1 退出 ——
   表现是"PASS 全绿但退出码 1"，很容易被误当成测试失败。 */
globalLog.close();
await new Promise((r) => setTimeout(r, 80));
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log('\x1b[32m错误报告点得开、内容看得见，真实故障会进错误流。\x1b[0m');
}
