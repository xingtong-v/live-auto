/**
 * 排查（第五步）：那些"离谱 ASR 窗口"里，**实际有人说话的时间**在哪？
 *
 * 用本地 ffmpeg silencedetect（零费用）把整场切成「有声区间」，然后看：
 *   · 每个异常长的 ASR 窗口里，有声区间在哪、有多长
 *   · 我们当前烧进去的字幕落在哪（对照）
 * 这决定了"按有声区间重排"能不能真的修好字幕。
 *
 * 用法：node tools/speech-run-probe.mjs [taskId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT_DIR } from '../src/util.ts';

const taskId = process.argv[2] ?? 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'ledger.json'), 'utf8'));
const src = (ledger.tasks?.[taskId]?.source?.rawFiles ?? [])[0];
if (!src) {
  console.error('找不到源文件');
  process.exit(2);
}

const NOISE = '-32dB';
const MIN_SIL = '0.6';
console.log(`源：${src}`);
const t0 = Date.now();
const res = spawnSync(
  'ffmpeg',
  ['-hide_banner', '-nostats', '-i', src, '-af', `silencedetect=noise=${NOISE}:d=${MIN_SIL}`, '-f', 'null', '-'],
  { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
);
const err = String(res.stderr ?? '');
console.log(`silencedetect 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，stderr ${(err.length / 1024).toFixed(0)} KB`);

/* 解析 silence_start / silence_end */
const silences = [];
let cur = null;
for (const line of err.split(/\r?\n/)) {
  const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
  if (s) cur = Number(s[1]);
  const e = /silence_end:\s*(\d+(?:\.\d+)?)/.exec(line);
  if (e) {
    const end = Number(e[1]);
    if (cur !== null && end > cur) silences.push({ start: Math.max(0, cur), end });
    cur = null;
  }
}
const durMatch = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/.exec(err);
const totalDur = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) + Number(durMatch[4]) / 100 : 0;
if (cur !== null && totalDur > cur) silences.push({ start: cur, end: totalDur });
console.log(`静音段 ${silences.length} 个，总时长 ${totalDur.toFixed(1)}s，静音合计 ${silences.reduce((a, s) => a + (s.end - s.start), 0).toFixed(1)}s`);

/* 有声区间 = [0,total] 减去静音，且只留 >= 0.25s 的 */
const runs = [];
let cursor = 0;
for (const s of silences) {
  if (s.start > cursor) runs.push({ start: cursor, end: s.start });
  cursor = Math.max(cursor, s.end);
}
if (totalDur > cursor) runs.push({ start: cursor, end: totalDur });
const speech = runs.filter((r) => r.end - r.start >= 0.25);
console.log(`有声区间 ${speech.length} 个，合计 ${speech.reduce((a, r) => a + (r.end - r.start), 0).toFixed(1)}s（占 ${((speech.reduce((a, r) => a + (r.end - r.start), 0) / totalDur) * 100).toFixed(0)}%）`);

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8'));
const segs = (tr.segments ?? []).map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text ?? '') }));

console.log('\n=== 异常长窗口（>15s）里的有声区间 ===');
for (const s of segs.filter((x) => x.end - x.start > 15)) {
  const inside = speech.filter((r) => r.end > s.start && r.start < s.end);
  const speechSec = inside.reduce((a, r) => a + (Math.min(r.end, s.end) - Math.max(r.start, s.start)), 0);
  console.log(`  ${fmt(s.start)} → ${fmt(s.end)}（${(s.end - s.start).toFixed(1)}s，${s.text.length} 字）「${s.text.slice(0, 26)}」`);
  console.log(`     有声 ${speechSec.toFixed(1)}s：${inside.slice(0, 6).map((r) => `${fmt(Math.max(r.start, s.start))}–${fmt(Math.min(r.end, s.end))}`).join(' | ')}`);
}

console.log('\n=== 两个切片窗口：有声区间分布 ===');
const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8'));
for (const c of clipsJson.clips ?? []) {
  const inside = speech.filter((r) => r.end > c.start && r.start < c.end);
  const speechSec = inside.reduce((a, r) => a + (Math.min(r.end, c.end) - Math.max(r.start, c.start)), 0);
  console.log(`  clip[${c.index}] ${fmt(c.start)} → ${fmt(c.end)}（${(c.end - c.start).toFixed(0)}s）：有声 ${inside.length} 段 / ${speechSec.toFixed(1)}s（${((speechSec / (c.end - c.start)) * 100).toFixed(0)}%）`);
  console.log(`     ${inside.slice(0, 10).map((r) => `${(Math.max(r.start, c.start) - c.start).toFixed(0)}–${(Math.min(r.end, c.end) - c.start).toFixed(0)}s`).join(' | ')}`);
}
