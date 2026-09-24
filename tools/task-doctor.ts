/**
 * 诊断：列出所有任务及其真实状态，并检查是否有卡住的运行态。
 * 用法：node tools/task-doctor.ts [--tasks <taskId1,taskId2>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { exists, fileSize, fmtBytes, fmtLocal } from '../src/util.ts';

const onlyIdx = process.argv.indexOf('--tasks');
const only = onlyIdx >= 0 && process.argv[onlyIdx + 1] ? new Set(process.argv[onlyIdx + 1]!.split(',')) : undefined;

const ledger = new Ledger();
const tasks = ledger.listTasks({ limit: 200 });

console.log(`\x1b[1m任务台账体检\x1b[0m  共 ${tasks.length} 个任务`);
console.log('─'.repeat(78));

const byTitle = new Map<string, typeof tasks>();
for (const t of tasks) {
  const key = t.title.replace(/（手动导入）$/, '');
  const arr = byTitle.get(key) ?? [];
  arr.push(t);
  byTitle.set(key, arr);
}

for (const t of tasks) {
  if (only && !only.has(t.id)) continue;
  const clips = ledger.getClips(t.id);
  const selected = clips.filter((c) => c.selected);
  const published = clips.filter((c) => c.status === 'PUBLISHED');
  const submitted = clips.filter((c) => c.status === 'SUBMITTED');
  const failed = clips.filter((c) => c.status === 'FAILED');

  console.log(`\n\x1b[1m${t.id}\x1b[0m`);
  console.log(`  标题    : ${t.title}`);
  console.log(`  状态    : \x1b[36m${t.status}\x1b[0m  阶段: ${t.stage}`);
  if (t.error) console.log(`  \x1b[31m错误    : [${t.error.stage}] ${t.error.message.slice(0, 100)}\x1b[0m`);
  if (t.progress) console.log(`  进度    : ${t.progress.label} ${t.progress.current}/${t.progress.total}`);
  console.log(`  时间    : 创建 ${fmtLocal(Date.parse(t.createdAt))}  更新 ${fmtLocal(Date.parse(t.updatedAt))}`);
  console.log(`  切片    : 共 ${clips.length}，勾选 ${selected.length}，已发布 ${published.length}，已提交 ${submitted.length}，失败 ${failed.length}`);
  if (clips.length) {
    console.log(`  明细    : ${clips.map((c) => `${c.index}:${c.status}${c.selected ? '*' : ''}${c.degraded ? '(降级)' : ''}`).join(' ')}`);
  }
  const raw = t.source.rawFiles.filter((f) => exists(f));
  const full = t.source.fullVideoPath && exists(t.source.fullVideoPath) ? t.source.fullVideoPath : undefined;
  const rawBytes = raw.reduce((a, f) => a + fileSize(f), 0);
  console.log(`  素材    : 原始 ${raw.length}/${t.source.rawFiles.length} 个存在（${fmtBytes(rawBytes)}）${full ? `，压制产物存在` : ''}`);
  console.log(`  清理    : ${t.cleaned?.rawDeletedAt ? `原始已删 ${fmtLocal(Date.parse(t.cleaned.rawDeletedAt))}` : '未清理'}${t.cleaned?.fullVideoDeletedAt ? `，产物已删` : ''}`);
  console.log(`  成本    : ASR ¥${t.cost.asrEstimate.toFixed(2)}（估算） + LLM ¥${t.cost.llmActual.toFixed(4)}`);
  const dir = ledger.taskDir(t.id);
  const files = exists(dir) ? fs.readdirSync(dir) : [];
  console.log(`  产物    : ${files.length ? files.join(', ') : '(无)'}`);
}

console.log('\n' + '─'.repeat(78));
console.log('\x1b[1m同名任务（可能是重复导入造成）\x1b[0m');
let dupCount = 0;
for (const [title, arr] of byTitle) {
  if (arr.length > 1) {
    dupCount++;
    console.log(`  「${title}」有 ${arr.length} 个：`);
    for (const t of arr) console.log(`    ${t.id}  ${t.status}  ${fmtLocal(Date.parse(t.createdAt))}`);
  }
}
if (dupCount === 0) console.log('  无');

console.log('\n\x1b[1m可清理的素材占用\x1b[0m');
let total = 0;
for (const t of tasks) {
  const bytes = t.source.rawFiles.filter((f) => exists(f)).reduce((a, f) => a + fileSize(f), 0);
  if (bytes > 0) {
    total += bytes;
    console.log(`  ${t.id.padEnd(34)} ${fmtBytes(bytes).padStart(10)}  ${t.status}`);
  }
}
console.log(`  合计 ${fmtBytes(total)}`);
void path;
