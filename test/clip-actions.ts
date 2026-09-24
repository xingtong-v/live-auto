/**
 * 排期栏逐片操作自测：**删除切片** 与 **改发布时间**。
 *
 * 背景（用户在看板上提的需求）：「这里我希望可以进行切片的操作，如删除和修改投稿的设置」
 * —— 发布排期栏原来只是只读列表，看到不想要的一片只能去左边详情页，删除则根本没有入口。
 *
 * 本测试锁住四条语义（每条都对应一个会真出事的坑）：
 *   1. 删掉一条切片**不能重排其它切片的 index** —— index 是台账/decisions/幂等指纹共用的稳定标识；
 *   2. 删掉切片要**连带清掉它的幂等指纹** —— 不清的话重新分析出同一区间会被判成"已投过"而静默跳过；
 *   3. 逐片指定的发布时间必须过硬约束 #4（> 提交时刻 + 7200 秒），不合法就拒绝而不是照投；
 *   4. `parseUserDtime` 认 `YYYY-MM-DDTHH:mm` / `YYYY-MM-DD HH:mm` / 秒级 / 毫秒级时间戳。
 *
 * 纯本地：真台账（临时目录）+ 纯函数，不联网、不投稿。
 * 运行：node test/clip-actions.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { parseUserDtime, validateDtime } from '../src/publish.ts';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-clipact-'));
const now = new Date().toISOString();

function mkClip(index: number, over: Partial<ClipRecord> = {}): ClipRecord {
  return {
    index,
    start: index * 100,
    end: index * 100 + 60,
    title: `切片 ${index}`,
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

function makeLedger(withFingerprint = true): { ledger: Ledger; taskId: string } {
  const taskId = `clipact-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const ledger = new Ledger({ path: path.join(tmp, `${taskId}.json`) });
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    platform: 'Bilibili',
    title: '逐片操作测试',
    status: 'CLIPPED',
    stage: 'CLIPPED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now,
  });
  ledger.setClips(taskId, [mkClip(0), mkClip(1), mkClip(2), mkClip(3)]);
  if (withFingerprint) {
    ledger.registerFingerprint('fp-of-clip-1', { taskId, clipIndex: 1 });
    ledger.registerFingerprint('fp-of-clip-2', { taskId, clipIndex: 2 });
  }
  return { ledger, taskId };
}

/* ========================================================================== */
section('① 删除切片：只摘掉那一条，其它 index 原样保留');
{
  const { ledger, taskId } = makeLedger();
  const before = ledger.getClips(taskId).map((c) => c.index);
  eq('删除前有 4 条', before.length, 4);

  const r = ledger.deleteClip(taskId, 1);
  ok('返回被删掉的那条', r?.deleted.index === 1 && r.deleted.title === '切片 1', JSON.stringify(r?.deleted));

  const after = ledger.getClips(taskId).map((c) => c.index);
  eq('剩 3 条', after.length, 3);
  eq('**index 不重排**（0,2,3 而不是 0,1,2）', JSON.stringify(after), JSON.stringify([0, 2, 3]));
  ok('被删的那条真的没了', !after.includes(1));

  const again = ledger.deleteClip(taskId, 1);
  ok('再删同一条 → undefined（不抛错、不误删别的）', again === undefined);
  eq('条数没变', ledger.getClips(taskId).length, 3);
}

section('② 删除切片要连带清掉它的幂等指纹（否则重切会被静默跳过）');
{
  const { ledger, taskId } = makeLedger();
  ok('删之前指纹在', ledger.findFingerprint('fp-of-clip-1') !== undefined);
  const r = ledger.deleteClip(taskId, 1);
  eq('清掉 1 条指纹', r?.fingerprintsRemoved, 1);
  eq('该切片的指纹已移除', ledger.findFingerprint('fp-of-clip-1'), undefined);
  ok('别的切片的指纹**不能**被误删', ledger.findFingerprint('fp-of-clip-2') !== undefined);

  /* 删除是否落盘（崩溃后不该"复活"） */
  const reopened = new Ledger({ path: path.join(tmp, `${taskId}.json`) });
  eq('重开台账后仍是 3 条', reopened.getClips(taskId).length, 3);
  eq('index 仍是 0,2,3', JSON.stringify(reopened.getClips(taskId).map((c) => c.index)), JSON.stringify([0, 2, 3]));
}

section('③ 清空逐片排期：setClipStatus 的 unset 能真的删掉可选字段');
{
  const { ledger, taskId } = makeLedger();
  ledger.setClipStatus(taskId, 0, 'CANDIDATE', { dtime: 1_800_000_000 });
  eq('dtime 写入成功', ledger.getClip(taskId, 0)?.dtime, 1_800_000_000);
  ledger.setClipStatus(taskId, 0, 'CANDIDATE', {}, { unset: ['dtime'] });
  eq('dtime 被清空（回到自动排期）', ledger.getClip(taskId, 0)?.dtime, undefined);
  ok('字段真的不存在了（不是留了个 undefined）', !('dtime' in (ledger.getClip(taskId, 0) as object)));
}

/* ========================================================================== */
section('④ 逐片发布时间：解析 + 硬约束 #4 校验');
{
  const base = Date.parse('2026-09-23T12:00:00'); // 本地时间
  eq('YYYY-MM-DDTHH:mm', parseUserDtime('2026-09-24T08:00'), Math.floor(Date.parse('2026-09-24T08:00') / 1000));
  eq('空格分隔也能认', parseUserDtime('2026-09-24 08:00'), Math.floor(Date.parse('2026-09-24T08:00') / 1000));
  eq('秒级时间戳原样', parseUserDtime(1_800_000_000), 1_800_000_000);
  eq('毫秒级时间戳会自动降级到秒', parseUserDtime(1_800_000_000_000), 1_800_000_000);
  eq('数字字符串也认', parseUserDtime('1800000000'), 1_800_000_000);
  eq('空串 → undefined（调用方按"清空"处理）', parseUserDtime(''), undefined);
  eq('乱填 → undefined（不猜）', parseUserDtime('明天早上'), undefined);
  eq('对象 → undefined', parseUserDtime({ a: 1 }), undefined);

  const tooEarly = Math.floor(base / 1000) + 3600; // 只留 1 小时
  const vBad = validateDtime(tooEarly, base);
  eq('只留 1 小时 → 不合法（硬约束 #4）', vBad.ok, false);
  ok('给出人话原因', vBad.note.includes('7200'), vBad.note);

  const okTime = Math.floor(base / 1000) + 7300;
  ok('留 7300 秒 → 合法', validateDtime(okTime, base).ok);
  eq('边界 7200 秒整 → **不合法**（要求 > 7200）', validateDtime(Math.floor(base / 1000) + 7200, base).ok, false);
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}
if (fail > 0) process.exitCode = 1;
