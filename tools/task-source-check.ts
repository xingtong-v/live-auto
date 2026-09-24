/**
 * 查证：某个任务的 source 元数据是否完整（尤其 totalDuration 为什么是 NaN/null）。
 *
 * 背景：界面上显示「时长=NaNs」，而 NaN 会一路传播到排期计算、时间轴显示、
 * ASR 窗口规划与切片范围校验 —— 这类"看起来能跑但数值是坏的"问题必须先定位。
 *
 * 只读。
 *
 * 用法：node tools/task-source-check.ts [taskId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { DATA_DIR, exists, fileSize, fmtBytes, fmtDuration } from '../src/util.ts';

const ledger = new Ledger();
const taskId = process.argv[2] ?? ledger.listTasks({ limit: 20 })[0]?.id;
if (!taskId) {
  console.log('没有任务');
  process.exit(1);
}
const t = ledger.getTask(taskId);
if (!t) {
  console.log(`任务不存在：${taskId}`);
  process.exit(1);
}

console.log(`\x1b[1m任务 source 元数据检查\x1b[0m  ${t.id}`);
console.log('─'.repeat(76));
console.log(`  标题      : ${t.title.slice(0, 60)}`);
console.log(`  状态/阶段 : ${t.status} / ${t.stage}`);
console.log(`  manual    : ${t.manual === true}`);
/* 来源比 manual 布尔值准：自动导入与手动导入走同一个 importLocal()，
   早期两者都被写成 manual:true（旧台账只能退化为 manual，无法区分） */
console.log(`  来源      : ${t.importSource ?? (t.manual ? 'manual（旧台账，分不清自动/手动）' : 'recording')}`);
console.log('');
console.log(`  totalDuration : ${JSON.stringify(t.source.totalDuration)}  ${Number.isFinite(t.source.totalDuration) ? `(${fmtDuration(t.source.totalDuration)})` : '← ⚠ 不是有效数字'}`);
console.log(`  rawFiles      : ${t.source.rawFiles.length} 个`);
for (const f of t.source.rawFiles) {
  const ok = exists(f);
  console.log(`      ${ok ? '\x1b[32m存在\x1b[0m' : '\x1b[31m缺失\x1b[0m'}  ${fmtBytes(fileSize(f)).padStart(10)}  ${f}`);
}
console.log(`  segments      : ${t.source.segments.length} 段`);
for (const s of t.source.segments.slice(0, 6)) {
  console.log(`      ${JSON.stringify(s)}`);
}
console.log(`  fullVideoPath : ${t.source.fullVideoPath ?? '(无)'}`);
console.log(`  danmaXml      : ${t.source.danmaXmlPath ?? '(无)'}  ${t.source.danmaXmlPath ? (exists(t.source.danmaXmlPath) ? '存在' : '缺失') : ''}`);
console.log(`  danmaAss      : ${t.source.danmaAssPath ?? '(无)'}`);
console.log(`  fullVideoHasDanmaku : ${t.source.fullVideoHasDanmaku}`);
console.log('');

/* ---- 直接读台账原文，看 NaN 是"存进去就是 NaN"还是"序列化后变 null" ---- */
const raw = fs.readFileSync(path.join(DATA_DIR, 'ledger.json'), 'utf8');
const idx = raw.indexOf(taskId);
const slice = idx >= 0 ? raw.slice(idx, idx + 2000) : '';
console.log(`  台账原文里的 totalDuration : ${(() => { const m = /"totalDuration"\s*:\s*([^,\n}]+)/.exec(slice); return m && m[1] ? m[1].trim() : '(没找到)'; })()}`);
console.log('  ⚠️ 注意：`/api/task/:id` 的 source 里**没有** totalDuration 字段（只有 segments[].duration）；');
console.log('     调用方要总时长请累加 segments 或取最后一个 globalEnd —— 直接读 totalDuration 会得到 undefined/NaN');

/* ---- 该任务的切片时间范围是否正常（NaN 会污染这里） ---- */
const clips = ledger.getClips(taskId);
console.log(`\n  切片 ${clips.length} 个，时间范围检查：`);
let bad = 0;
for (const c of clips) {
  const dur = c.end - c.start;
  const okNum = Number.isFinite(c.start) && Number.isFinite(c.end) && Number.isFinite(dur);
  if (!okNum) bad++;
  console.log(
    `      #${c.index} ${c.status.padEnd(10)} ${String(c.start).padStart(8)} → ${String(c.end).padStart(8)}  (${Number.isFinite(dur) ? dur.toFixed(0) : 'NaN'}s) ${okNum ? '' : '\x1b[31m← 时间范围含 NaN\x1b[0m'}`,
  );
}
console.log(`\n  小结：${bad === 0 ? '\x1b[32m切片时间范围全部正常\x1b[0m' : `\x1b[31m${bad} 个切片时间范围含 NaN\x1b[0m`}`);
