/**
 * 排查（第四步）：转写自己的时间轴健康吗？
 *
 * 云 ASR 偶尔会返回"一句话跨越 30 秒"这种离谱时间戳 —— 那会让字幕在画面上**卡住或提前出现**，
 * 表现就是用户说的"字幕对不上"。这一步只看转写本身：时长分布、异常长/短的段、重叠与空洞。
 *
 * 用法：node tools/transcript-health-probe.mjs [taskId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const taskId = process.argv[2] ?? 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8'));
const segs = (tr.segments ?? []).map((s) => ({
  start: Number(s.start ?? s.begin ?? s.startTime),
  end: Number(s.end ?? s.finish ?? s.endTime),
  text: String(s.text ?? '').trim(),
}));
const audio = Number(tr.audioSeconds ?? 0);

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
console.log(`任务 ${taskId}  段数=${segs.length}  ASR 输入时长=${audio}s  弹幕偏移=${tr.danmakuOffset}`);
console.log(`顶层字段：${Object.keys(tr).join(', ')}`);

const durs = segs.map((s) => s.end - s.start);
const sorted = [...durs].sort((a, b) => a - b);
const q = (p) => sorted[Math.floor((sorted.length - 1) * p)];
console.log(`\n单段时长：最短 ${sorted[0].toFixed(2)}s  中位 ${q(0.5).toFixed(2)}s  P90 ${q(0.9).toFixed(2)}s  最长 ${sorted.at(-1).toFixed(2)}s  合计 ${durs.reduce((a, b) => a + b, 0).toFixed(1)}s`);

console.log('\n异常长（>15s，字幕会长时间卡住）：');
for (const s of segs.filter((x) => x.end - x.start > 15)) {
  console.log(`  ${fmt(s.start)} → ${fmt(s.end)}（${(s.end - s.start).toFixed(1)}s）  「${s.text.slice(0, 50)}」`);
}

console.log('\n异常短（<0.35s）：');
for (const s of segs.filter((x) => x.end - x.start < 0.35)) {
  console.log(`  ${fmt(s.start)} → ${fmt(s.end)}（${(s.end - s.start).toFixed(2)}s）  「${s.text.slice(0, 40)}」`);
}

console.log('\n空档（>3s 没字幕）与重叠：');
let prev = null;
let gaps = 0;
let overlaps = 0;
for (const s of segs) {
  if (prev) {
    const gap = s.start - prev.end;
    if (gap > 3) {
      gaps++;
      if (gaps <= 8) console.log(`  空档 ${gap.toFixed(1)}s：${fmt(prev.end)} → ${fmt(s.start)}`);
    }
    if (gap < -0.5) {
      overlaps++;
      if (overlaps <= 5) console.log(`  重叠 ${(-gap).toFixed(1)}s：${fmt(prev.end)} 与 ${fmt(s.start)}`);
    }
  }
  prev = s;
}
console.log(`  合计空档 ${gaps} 处、重叠 ${overlaps} 处`);

console.log('\n时间轴单调性：' + (segs.every((s, i) => i === 0 || s.start >= segs[i - 1].start) ? '递增 ✓' : '❌ 有回退'));
console.log(`覆盖：首段 ${fmt(segs[0]?.start ?? 0)} 末段结束 ${fmt(segs.at(-1)?.end ?? 0)}（音频长 ${audio}s）`);

/* 每 5 分钟的字幕密度：某一区间明显偏少/偏多都可能是"时间轴被压缩/拉伸"的痕迹 */
console.log('\n每 5 分钟的字幕条数与字数：');
const buckets = new Map();
for (const s of segs) {
  const b = Math.floor(s.start / 300);
  const cur = buckets.get(b) ?? { n: 0, chars: 0, audio: 0 };
  cur.n++;
  cur.chars += s.text.length;
  cur.audio += s.end - s.start;
  buckets.set(b, cur);
}
for (const [b, v] of [...buckets.entries()].sort((a, b2) => a[0] - b2[0])) {
  console.log(`  ${String(Math.floor(b * 5)).padStart(2)}–${String(Math.floor(b * 5 + 5)).padStart(2)} 分：${String(v.n).padStart(3)} 条 / ${String(v.chars).padStart(4)} 字 / 覆盖 ${v.audio.toFixed(0)}s`);
}
