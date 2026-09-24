/**
 * 排查（第七步）：那 31 秒的窗口里，"人说话的动静"到底在哪一段？
 *
 * 用 ffmpeg 的 ebur128 取响度剖面（每 100ms 一个瞬时值），按 1 秒汇总打印；
 * 同时把「我们烧进去的字幕」和「ASR 给的段窗口」标在时间轴上，一眼看出错位在哪。
 *
 * 用法：node tools/loudness-profile-probe.mjs [taskId] [clipIndex]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { ROOT_DIR } from '../src/util.ts';

const taskId = process.argv[2] ?? 'auto-20260923175913-qpq8';
const clipIndex = Number(process.argv[3] ?? 1);
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8'));
const clip = (clipsJson.clips ?? []).find((c) => c.index === clipIndex);
if (!clip?.cutOutput) {
  console.error('找不到切片产物');
  process.exit(2);
}

const WINDOW = 40;
/* 自己算 RMS 剖面：ebur128 的逐帧数据在不同 ffmpeg 版本里输出位置不一致（实测 metadata=1 拿不到 t:/M: 行），
   而"解码成 PCM 再算 RMS"是稳定可靠的。 */
const pcmPath = path.join(os.tmpdir(), `loudness-${Date.now()}.pcm`);
spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-t', String(WINDOW), '-i', clip.cutOutput, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '8000', '-y', pcmPath], { encoding: 'utf8' });
const buf = fs.readFileSync(pcmPath);
fs.rmSync(pcmPath, { force: true });
const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
const SEC = 1;
const perBin = new Map();
for (let i = 0; i < samples.length; i++) {
  const t = i / 8000;
  const b = Math.floor(t / SEC);
  let acc = perBin.get(b) ?? { sum: 0, n: 0, peak: 0 };
  acc.sum += samples[i] * samples[i];
  acc.n++;
  acc.peak = Math.max(acc.peak, Math.abs(samples[i]));
  perBin.set(b, acc);
}
const points = [...perBin.entries()].map(([b, a]) => ({ t: b, db: 20 * Math.log10(Math.sqrt(a.sum / Math.max(1, a.n)) || 1e-6) }));
console.log(`（解码 ${(samples.length / 8000).toFixed(1)}s 音频，按 ${SEC}s 汇总 RMS）`);

/* ASR 段与字幕（都以切片内秒数表示） */
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8'));
const segs = (tr.segments ?? [])
  .map((s) => ({ start: Number(s.start) - clip.start, end: Number(s.end) - clip.start, text: String(s.text ?? '') }))
  .filter((s) => s.end > 0 && s.start < WINDOW);

function parseAss(p) {
  const rows = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!/^Dialogue:/.test(line)) continue;
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const toSec = (t) => {
      const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(t.trim());
      return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : 0;
    };
    rows.push({ start: toSec(parts[1]) - clip.start, end: toSec(parts[2]) - clip.start, text: parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').trim() });
  }
  return rows;
}
const cues = [...new Map(fs.readdirSync(taskDir).filter((f) => /^burn-/.test(f)).flatMap((f) => parseAss(path.join(taskDir, f))).map((c) => [`${c.start}|${c.text}`, c])).values()]
  .filter((c) => c.end > 0 && c.start < WINDOW)
  .sort((a, b) => a.start - b.start);

console.log(`clip[${clipIndex}] 前 ${WINDOW} 秒：响度（M，越大越像"有人说话/有动静"）`);
for (let s = 0; s < WINDOW; s++) {
  const v = (points.find((p) => p.t === s) ?? {}).db;
  if (v === undefined) continue;
  const bar = '#'.repeat(Math.max(0, Math.round((v + 45) / 1.5)));
  const marks = [];
  for (const c of cues) if (s >= Math.floor(c.start) && s <= Math.floor(c.end)) marks.push('字幕');
  for (const g of segs) if (s >= Math.floor(g.start) && s <= Math.floor(g.end)) marks.push('ASR窗口');
  console.log(`  ${String(s).padStart(3)}s  ${v.toFixed(1).padStart(7)} dB  ${bar.padEnd(38)} ${[...new Set(marks)].join('+')}`);
}
console.log('\n字幕（切片内）：');
for (const c of cues) console.log(`  ${c.start.toFixed(1)}–${c.end.toFixed(1)}s  ${c.text.slice(0, 40)}`);
console.log('\nASR 段（切片内）：');
for (const g of segs) console.log(`  ${g.start.toFixed(1)}–${g.end.toFixed(1)}s（${(g.end - g.start).toFixed(1)}s）  ${g.text.slice(0, 40)}`);

