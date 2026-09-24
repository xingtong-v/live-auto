/**
 * 验证能量锚点选的位置对不对：把出问题那个窗口（351.9→392.4s）的响度剖面打出来，
 * 标上"窗口起点"和"锚点选中的位置"。
 *
 * 用法：node tools/anchor-window-probe.ts <from> <to> [taskId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeEnergyProfile } from '../src/speech-energy.ts';
import { ROOT_DIR } from '../src/util.ts';

const from = Number(process.argv[2] ?? 345);
const to = Number(process.argv[3] ?? 395);
const taskId = process.argv[4] ?? 'auto-20260923175913-qpq8';
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'ledger.json'), 'utf8'));
const src = (ledger.tasks?.[taskId]?.source?.rawFiles ?? [])[0];
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8'));
const segs = (tr.segments ?? []).map((s: { start: number; end: number; text: string }) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text) }));

const p = computeEnergyProfile(src, { binSec: 0.5 });
if (!p) {
  console.error('拿不到能量剖面');
  process.exit(2);
}
const db = (v: number) => 20 * Math.log10(Math.max(1e-6, v));
const bin = (t: number) => Math.floor(t / p.binSec);

console.log(`窗口 ${from}–${to}s 的响度剖面（每 ${p.binSec}s 一个点）：`);
for (let t = from; t < to; t += p.binSec) {
  const v = p.rms[bin(t)] ?? 0;
  const d = db(v);
  const marks: string[] = [];
  for (const s of segs) if (t >= s.start && t < s.end) marks.push(`ASR「${s.text.slice(0, 12)}」`);
  console.log(`  ${t.toFixed(1).padStart(6)}s ${d.toFixed(1).padStart(7)} dB ${'#'.repeat(Math.max(0, Math.round((d + 45) / 1.5))).padEnd(34)} ${[...new Set(marks)].join('+')}`);
}
