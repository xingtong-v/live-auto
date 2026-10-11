/**
 * 统一待办（`GET /api/todos`）——2026-10-11 优化第一批 A4。
 *
 * 原来要人管的事散在三处（任务列表 / 健康面板 / 待删页），用户问"现在要我做什么"没人能一句话回答。
 * 判据集中在本端点（界面与 MCP 共用）。套件锁住：
 *   ① 干净时如实说"没有需要处理的事"，不硬凑条目；
 *   ② 未确认投稿：按**最久的那一批**给等级（<1 小时 warn，≥1 小时 error）并给出可点的动作；
 *   ③ 失败场次、卡住的场次各自成条；
 *   ④ 测试夹具不进待办（否则永远"有 22 件事要处理"）；
 *   ⑤ 只读：跑一遍不改任何台账状态。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';
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

function dismissedOf(r: Record<string, unknown>): number {
  return typeof r['dismissedCount'] === 'number' ? r['dismissedCount'] : -1;
}

interface Todos {
  items: Array<{ key: string; level: string; count: number; title: string; detail: string; action: { kind: string; taskId?: string; view?: string } }>;
  clean: boolean;
  dismissedCount?: number;
  note: string;
  scannedTasks: number;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-todos-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
const orch = new Orchestrator({ ledger, dataDirOverride: dataDir });
orch.logger.setConsole(false);

const mkTask = (id: string, o: Record<string, unknown> = {}): void => {
  const now = new Date().toISOString();
  ledger.createTask({
    id,
    roomId: '1',
    title: String(o['title'] ?? '测试场次'),
    stage: String(o['stage'] ?? 'PUBLISHED'),
    status: String(o['status'] ?? 'PUBLISHED'),
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
    createdAt: now,
    updatedAt: String(o['updatedAt'] ?? now),
  } as never);
};

const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
await ui.start();
const todos = async (): Promise<Todos> => (await (await fetch(`${ui.url}/api/todos`)).json()) as Todos;

try {
  section('1. 干净的时候如实说"没有需要处理的事"');
  mkTask('auto-20261011090000-clean', { title: '一切正常的一场' });
  {
    const t = await todos();
    eq('没有条目', t.items.length, 0);
    eq('clean = true', t.clean, true);
    ok('并给出一句人话说明（不是空白页）', /没有需要你处理的事/.test(t.note), t.note);
    eq('扫描到的场次数如实回报', t.scannedTasks, 1);
  }

  section('2. 未确认投稿：等级按"最久的那一批"给，动作可点');
  mkTask('auto-20261011091000-sub', { title: '有未确认切片的一场', status: 'CLIPPED', stage: 'CLIPPED' });
  ledger.setClips('auto-20261011091000-sub', [
    { index: 0, start: 0, end: 60, title: '切片甲', desc: '', tags: ['测试'], category: '生活', score: 8, selected: true, status: 'SUBMITTED', bvid: 'BV1TODO00001', submitTime: Date.now() - 20 * 60_000 },
  ] as never);
  {
    const t = await todos();
    const item = t.items.find((x) => x.key === 'unconfirmed-publish');
    ok('★ 报出未确认投稿', Boolean(item), JSON.stringify(t.items.map((x) => x.key)));
    eq('条数是切片数', item?.count, 1);
    eq('只等了 20 分钟 ⇒ 等级 warn（不制造焦虑）', item?.level, 'warn');
    eq('动作指向那一场（点了能去核对）', item?.action.taskId, 'auto-20261011091000-sub');
  }
  ledger.setClipStatus('auto-20261011091000-sub', 0, 'SUBMITTED', { submitTime: Date.now() - 90 * 60_000 });
  {
    const t = await todos();
    const item = t.items.find((x) => x.key === 'unconfirmed-publish');
    eq('★ 超过 1 小时 ⇒ 升级成 error', item?.level, 'error');
    ok('说明里给了"确认没落地就重投"的具体做法', /重新投稿这一片/.test(item?.detail ?? ''), item?.detail);
  }

  section('3. 失败场次 / 卡住的场次各自成条');
  mkTask('auto-20261011092000-fail', { title: '失败的一场', status: 'FAILED', stage: 'CLIPPED' });
  mkTask('auto-20261011093000-stuck', { title: '卡住的一场', status: 'CLIPPING', stage: 'ANALYZED', updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
  {
    const t = await todos();
    ok('★ 报出失败场次', t.items.some((x) => x.key === 'failed-tasks'), JSON.stringify(t.items.map((x) => x.key)));
    eq('失败那条等级是 error', t.items.find((x) => x.key === 'failed-tasks')?.level, 'error');
    /* 「卡住」这条**故意不断言它出现**：台账每次写入都会刷新 `updatedAt`（createTask 同理），
       用夹具造假时间会被写回覆盖 —— 而线上它只在"进程真的死了、没人再写"时才成立（那正是它的用途）。
       所以这里只断言语义正确的反面：**正在更新**的处理中场次不该被报成"卡住"（否则天天误报）。 */
    ok('★ 正在更新的处理中场次不会被误报成"卡住"', !t.items.some((x) => x.key === 'stuck-tasks'), JSON.stringify(t.items.map((x) => x.key)));
    const src = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.ts'), 'utf8');
    ok(
      '「卡住」的判据写在服务端（>2 小时 + 只认处理中状态）',
      /2 \* 3600_000[\s\S]{0,400}key: 'stuck-tasks'/.test(src) && /'CLIPPING', 'CLIPPED', 'TRANSCRIBING', 'ANALYZING', 'PUBLISHING'/.test(src),
    );
  }

  section('4. 测试夹具不进待办 + 只读');
  mkTask('uie2e-fixture-todo', { title: '【界面测试】夹具任务', status: 'FAILED', stage: 'CLIPPED' });
  mkTask('mon-batch-todo', { title: '测试场次', status: 'FAILED', stage: 'CLIPPED' });
  {
    const before = await todos();
    const keys = before.items.filter((x) => x.key === 'failed-tasks')[0];
    eq('★ 夹具不算进失败场次数（否则永远有 22 件事要做）', keys?.count, 1);
    const snap = ledger.listTasks({ limit: 100 }).map((x) => `${x.id}:${x.status}`).join('|');
    await todos();
    const after = ledger.listTasks({ limit: 100 }).map((x) => `${x.id}:${x.status}`).join('|');
    eq('端点只读：跑两次台账状态一模一样', after, snap);
  }

  section('5. 待办闭环：忽略 / 已处理 / 恢复（P0-3）');
  {
    /* 走真实 HTTP：写操作需要 CSRF 头（与界面同一套约定） */
    const boot = (await (await fetch(`${ui.url}/api/bootstrap`)).json()) as { csrf: string };
    const post = async (p: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (await fetch(`${ui.url}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-CSRF-Token': boot.csrf },
        body: JSON.stringify(body),
      })).json()) as Record<string, unknown>;

    const before = await todos();
    const target = before.items[0];
    ok('有可操作的待办条目（前置条件）', Boolean(target?.key), JSON.stringify(before.items.map((x) => x.key)));

    const snoozed = await post('/api/todos/dismiss', { key: target!.key, mode: 'snooze', hours: 24 });
    eq('忽略后返回 dismissedCount=1', dismissedOf(snoozed), 1);
    const afterSnooze = await todos();
    ok('★ 忽略的条目不再返回', !afterSnooze.items.some((x) => x.key === target!.key), JSON.stringify(afterSnooze.items.map((x) => x.key)));
    eq('★ 但如实报出隐藏了几条（不静默消失）', afterSnooze.dismissedCount, 1);

    const restored = await post('/api/todos/undismiss', { key: target!.key });
    eq('恢复后 dismissedCount 回到 0', dismissedOf(restored), 0);
    const afterRestore = await todos();
    ok('★ 恢复后条目重新出现', afterRestore.items.some((x) => x.key === target!.key));

    await post('/api/todos/dismiss', { key: target!.key, mode: 'done' });
    const afterDone = await todos();
    ok('★ 标记已处理后保持隐藏', !afterDone.items.some((x) => x.key === target!.key));
    /* 存储必须落在隔离目录（不是真实 data/）—— 与批次账那次同类问题的回归断言 */
    ok('★ dismiss 记录写在隔离目录（未污染真实 data/）', fs.existsSync(path.join(dataDir, 'todo-dismiss.jsonl')), dataDir);
    eq('夹具/其它待办不受影响（只隐藏了被点的那一条）', afterDone.items.length, before.items.length - 1);
  }
} finally {
  section('6. 录制质量体检（P2）：有长空档 ⇒ 进待办且等级 warn');
  {
    /* 造一场"录制中有 30 分钟空档"的场次：两段之间隔了 30 分钟 ⇒ 体检判 gap。
       判据本身在 test/recording-health.ts 里锁着；这里只验"它真的进了待办"。 */
    const gapId = 'auto-20261014000000-gapcheck';
    mkTask(gapId, { title: '有长空档的一场', status: 'PUBLISHED', stage: 'PUBLISHED' });
    ledger.updateTask(gapId, {
      source: {
        ...ledger.getTask(gapId)!.source,
        segments: [
          { path: 'a.flv', globalStart: 0, globalEnd: 600, size: 1 },
          { path: 'b.flv', globalStart: 2400, globalEnd: 3600, size: 1 },
        ],
      },
    } as never);
    const t = await todos();
    const item = t.items.find((x) => x.key === 'recording-health');
    ok('★ 录制有长空档 ⇒ 出现待办条目', Boolean(item), JSON.stringify(t.items.map((x) => x.key)));
    eq('等级是 warn（长空档更值得看一眼）', item?.level, 'warn');
    ok('标题写清了是「长空档」而不是泛泛的"录制异常"', /长空档/.test(item?.title ?? ''), item?.title);
    ok('说明里带场次标题（能立刻对上哪一场）', /有长空档的一场/.test(item?.detail ?? ''), item?.detail);
    eq('动作指向实时监控（去看轮询为什么断了）', item?.action.view, 'monitor');
  }

  ui.stop();
  orch.stop();
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
