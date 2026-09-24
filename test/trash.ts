/**
 * 「回收站」单元验证（无网络）。
 *
 * 背景是**一次真实事故**：通过界面点「删除任务」后，
 * 222.8 MB 成片 + 任务目录（转写/信号/总结）+ 台账记录被永久删除，
 * 事后除了一行日志没有任何恢复依据。回收站就是为这件事加的，所以它自己必须被验证。
 *
 * 断言的重点不是"能移动文件"，而是三个容易做错的地方：
 *   1. 删除后**原位必须真的没了**（否则用户以为删了，其实还在占空间）；
 *   2. 恢复要能**连台账记录一起写回**（否则文件回来了但系统不认，成了孤儿）；
 *   3. 目标目录已被台账重建时要**合并**而不是跳过（实测踩过：转写/总结永远留在回收站）。
 *
 * 全部在临时目录里跑，不碰真实 data/。
 *
 * 用法：node test/trash.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('─'.repeat(Math.max(20, Math.min(74, t.length * 2 + 8))));
}

/* ---- 回收站根目录指向临时目录：绝不能碰真实 data/trash ----
 * （第一版没传 root，测试直接把空条目写进了真实 data/trash —— 所以 trash.ts 现在支持 root 参数） */
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-trash-'));
const TRASH_ROOT = path.join(tmpData, 'trash');

const { Ledger } = await import('../src/ledger.ts');
const { moveToTrash, listTrash, restoreFromTrash, purgeTrash, trashStats } = await import('../src/trash.ts');
const { nowIso } = await import('../src/util.ts');

console.log('\x1b[1m回收站\x1b[0m（删除可恢复）');
console.log('─'.repeat(74));
console.log(`  \x1b[90m临时数据目录：${tmpData}\x1b[0m`);

const base = path.join(tmpData, 'work');
const taskDir = path.join(base, 'tasks', 'T1');
const clipsDir = path.join(base, 'clips', 'T1');
fs.mkdirSync(path.join(taskDir, 'full'), { recursive: true });
fs.writeFileSync(path.join(taskDir, 'summary.md'), '重要总结内容');
fs.writeFileSync(path.join(taskDir, 'full', 'P1-full.mp4'), Buffer.alloc(4096));
fs.mkdirSync(clipsDir, { recursive: true });
fs.writeFileSync(path.join(clipsDir, '01-clip.mp4'), Buffer.alloc(8192));

const ledger = new Ledger({ path: path.join(tmpData, 'ledger.json') });
const task = {
  id: 'T1',
  roomId: '1',
  platform: 'Bilibili',
  title: '【测试】可恢复的任务',
  status: 'CLIPPED' as const,
  stage: 'CLIPPED' as const,
  source: { segments: [], totalDuration: 60, rawFiles: [], fullVideoHasDanmaku: false },
  fullUpload: 'NOT_APPLICABLE' as const,
  cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: nowIso() },
  createdAt: nowIso(),
  updatedAt: nowIso(),
};
ledger.createTask(task);

/* ================= 1. 移入回收站 ================= */
section('1. 移入回收站');
{
  const r = moveToTrash({ root: TRASH_ROOT,
    taskId: 'T1',
    title: task.title,
    status: task.status,
    paths: [taskDir, clipsDir],
    task: task as never,
    reason: '测试',
  });
  ok('返回了回收站条目 id', Boolean(r.id), r.id);
  ok('两条路径都被移走', r.files.length === 2, JSON.stringify(r.files.map((f) => f.kind)));
  ok('没有警告', r.warnings.length === 0, JSON.stringify(r.warnings));
  ok('任务目录原位已消失（真的删了，不是复制）', !fs.existsSync(taskDir));
  ok('切片目录原位已消失', !fs.existsSync(clipsDir));
  ok('体积统计包含了子目录里的文件', r.bytes >= 4096 + 8192, `${r.bytes} B`);
  ok('回收站目录里能找到这一条', fs.existsSync(path.join(TRASH_ROOT, r.id, 'manifest.json')));
  const entry = listTrash(TRASH_ROOT).find((e) => e.id === r.id);
  ok('清单里存了台账快照（否则无法一键恢复任务）', Boolean(entry?.task), JSON.stringify(entry?.task ? 'has task' : 'no task'));
  ok('清单记录了原始路径', entry?.files.every((f) => f.from.length > 0) === true);
}

/* ================= 2. 恢复：文件 + 台账 ================= */
section('2. 恢复（含台账）');
{
  const entry = listTrash(TRASH_ROOT)[0]!;
  // 模拟真实情况：恢复台账时 createTask 会顺手把任务目录建出来（空目录）
  const r = restoreFromTrash(entry.id, ledger, undefined, TRASH_ROOT);
  ok('恢复成功', r.ok, JSON.stringify(r.warnings));
  ok('切片文件回到原位', fs.existsSync(path.join(clipsDir, '01-clip.mp4')));
  ok('任务目录的总结文件回来了（目录已存在时走合并）', fs.existsSync(path.join(taskDir, 'summary.md')));
  ok('嵌套目录里的文件也回来了', fs.existsSync(path.join(taskDir, 'full', 'P1-full.mp4')));
  ok('台账记录也写回了', Boolean(ledger.getTask('T1')));
  ok('恢复后回收站条目被清理（不留空壳）', listTrash(TRASH_ROOT).length === 0, JSON.stringify(trashStats(TRASH_ROOT)));
}

/* ================= 3. 恢复时的冲突处理 ================= */
section('3. 冲突处理');
{
  // 再删一次，然后在原位放一个同名文件，恢复时应当跳过而不是覆盖
  const r = moveToTrash({ root: TRASH_ROOT, taskId: 'T1', title: task.title, status: task.status, paths: [clipsDir], task: task as never });
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.writeFileSync(path.join(clipsDir, '01-clip.mp4'), '这是新文件，不能被覆盖');
  const res = restoreFromTrash(r.id, ledger, undefined, TRASH_ROOT);
  ok('同名文件存在时给出提示', res.warnings.some((w) => /同名文件.*已存在|已存在同名文件/.test(w)), JSON.stringify(res.warnings));
  const content = fs.readFileSync(path.join(clipsDir, '01-clip.mp4'), 'utf8');
  ok('没有覆盖原位的文件', content.includes('不能被覆盖'), content.slice(0, 40));
}

/* ================= 4. 彻底清空（唯一真正抹掉的入口） ================= */
section('4. 彻底清空');
{
  const r = moveToTrash({ root: TRASH_ROOT, taskId: 'T2', title: '待清空', status: 'CLIPPED', paths: [clipsDir] });
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.writeFileSync(path.join(clipsDir, 'x.mp4'), 'x');
  const r2 = moveToTrash({ root: TRASH_ROOT, taskId: 'T2b', title: '待清空2', status: 'CLIPPED', paths: [clipsDir] });
  ok('回收站里有 2 条', listTrash(TRASH_ROOT).length === 2, JSON.stringify(listTrash(TRASH_ROOT).map((e) => e.id)));

  // 按 id 精确清空
  const p1 = purgeTrash({ ids: [r.id], root: TRASH_ROOT });
  ok('按 id 清空只删指定的那条', p1.purged === 1 && listTrash(TRASH_ROOT).length === 1, JSON.stringify(listTrash(TRASH_ROOT).map((e) => e.id)));

  // 按天数清空：刚删的条目不该被"超过 7 天"的规则清掉
  const p2 = purgeTrash({ olderThanDays: 7, root: TRASH_ROOT });
  ok('保留期内的条目不会被清', p2.purged === 0 && listTrash(TRASH_ROOT).length === 1);
  const p3 = purgeTrash({ root: TRASH_ROOT });
  ok('不带参数 = 全清', p3.purged === 1 && listTrash(TRASH_ROOT).length === 0);
  ok('清空后目录也没了', !fs.existsSync(path.join(TRASH_ROOT, r2.id)));
}

/* ================= 5. 健壮性 ================= */
section('5. 健壮性');
{
  const r = moveToTrash({ root: TRASH_ROOT, taskId: 'T3', title: '不存在的路径', status: 'CLIPPED', paths: [path.join(base, '根本不存在')] });
  ok('不存在的路径被安全跳过（不抛错）', r.files.length === 0 && r.warnings.length === 0, JSON.stringify(r));
  ok('没有文件时也能列出（不产生垃圾条目）', listTrash(TRASH_ROOT).length === 0, JSON.stringify(listTrash(TRASH_ROOT).map((e) => e.id)));

  const bad = restoreFromTrash('不存在-id', ledger, undefined, TRASH_ROOT);
  ok('恢复不存在的条目时返回失败而不是抛错', bad.ok === false && bad.warnings.length > 0);

  // 损坏的清单不能让 listTrash 崩掉
  fs.mkdirSync(path.join(TRASH_ROOT, 'broken-entry'), { recursive: true });
  fs.writeFileSync(path.join(TRASH_ROOT, 'broken-entry', 'manifest.json'), '{ 这不是 JSON');
  ok('清单损坏时跳过该条而不崩', listTrash(TRASH_ROOT).length === 0);
}

fs.rmSync(tmpData, { recursive: true, force: true });

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log('\x1b[32m删除可恢复：移入 → 恢复（含台账）→ 清空，行为符合预期。\x1b[0m');
}
