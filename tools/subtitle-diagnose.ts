/**
 * 字幕诊断：拿**真实转写**跑一遍字幕生成，量化「时间轴」与「断句」两个问题。
 *
 * 背景：用户反馈「字幕和声音对不上」「字幕也没有断句」。这两点都必须用数据说话 ——
 * 抽帧只能证明"字幕能显示、样式对"，**证明不了时间轴与断句**（静态帧看不出来）。
 *
 * 输出三类证据：
 *   1. ASR 段落的时长分布 → 有多少条会被 maxDurationSec 截断（截断 = 声音还在说、字幕已消失）
 *   2. 段落文本长度分布 → 有多少条超过折行容量被丢字
 *   3. 逐条对比原段落与生成的字幕条目（时间轴偏差、丢了多少字）
 *
 * 只读，不写任何文件。
 *
 * 用法：node tools/subtitle-diagnose.ts [taskId]
 */
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { loadConfig } from '../src/config.ts';
import { readJson } from '../src/util.ts';
import { buildCues } from '../src/subtitle-ass.ts';
import { looksLikeNoise } from '../src/asr.ts';
import type { Transcript } from '../src/types.ts';

const cfg = loadConfig().config;
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
const transcriptPath = t.transcriptPath ?? path.join(ledger.taskDir(taskId), 'transcript.json');
const tr = readJson<Transcript>(transcriptPath);
if (!tr?.segments?.length) {
  console.log(`读不到转写：${transcriptPath}`);
  process.exit(1);
}

console.log(`\x1b[1m字幕诊断\x1b[0m  ${taskId}`);
console.log(`  转写：${tr.segments.length} 条，来源 ${tr.source}，模型 ${tr.modelId ?? '-'}`);
console.log(`  字幕参数：每行 ${cfg.clip.subtitle.maxCharsPerLine} 字 / 最长显示 8s（硬件编码在 buildCues 内）`);
console.log('─'.repeat(78));

/* ---- 1. 段落时长分布 ---- */
const durs = tr.segments.map((s) => s.end - s.start);
const buckets = [
  ['< 1s', (d: number) => d < 1],
  ['1–3s', (d: number) => d >= 1 && d < 3],
  ['3–8s', (d: number) => d >= 3 && d < 8],
  ['8–15s', (d: number) => d >= 8 && d < 15],
  ['> 15s', (d: number) => d >= 15],
] as const;
console.log('\n\x1b[1m① ASR 段落时长分布\x1b[0m（> 8s 的会被 maxDurationSec 截断 → 声音还在说、字幕已消失）');
for (const [name, f] of buckets) {
  const n = durs.filter(f).length;
  const pct = ((n / durs.length) * 100).toFixed(1);
  const bar = '█'.repeat(Math.round((n / durs.length) * 40));
  console.log(`  ${name.padEnd(7)} ${String(n).padStart(4)} 条  ${pct.padStart(5)}%  ${bar}`);
}
const long = tr.segments.filter((s) => s.end - s.start > 8);
console.log(`  → 会被截断的段落：\x1b[31m${long.length} 条\x1b[0m（占 ${((long.length / durs.length) * 100).toFixed(1)}%）`);
if (long.length) {
  const avgLost = long.reduce((a, s) => a + (s.end - s.start - 8), 0) / long.length;
  console.log(`     平均每条丢 ${avgLost.toFixed(1)} 秒的字幕显示时间`);
}

/* ---- 2. 文本长度分布 ---- */
const lens = tr.segments.map((s) => [...s.text].length);
const cap = cfg.clip.subtitle.maxCharsPerLine * 2; // 折 2 行的容量
console.log(`\n\x1b[1m② 段落文本长度分布\x1b[0m（折 ${cfg.clip.subtitle.maxCharsPerLine} 字 × 2 行 = 容量 ${cap} 字，超出部分会被丢弃）`);
const textBuckets = [
  [`< 10 字`, (n: number) => n < 10],
  [`10–${cap} 字`, (n: number) => n >= 10 && n <= cap],
  [`> ${cap} 字`, (n: number) => n > cap],
] as const;
for (const [name, f] of textBuckets) {
  const n = lens.filter(f).length;
  const bar = '█'.repeat(Math.round((n / lens.length) * 40));
  console.log(`  ${name.padEnd(10)} ${String(n).padStart(4)} 条  ${((n / lens.length) * 100).toFixed(1).padStart(5)}%  ${bar}`);
}
const overflow = tr.segments.filter((s) => [...s.text].length > cap);
console.log(`  → 会被丢字的段落：\x1b[31m${overflow.length} 条\x1b[0m`);
if (overflow.length) {
  const lostChars = overflow.reduce((a, s) => a + ([...s.text].length - cap), 0);
  console.log(`     合计丢失约 ${lostChars} 个字（观众看到的是被截断的半句话）`);
}
console.log(`  平均每条 ${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)} 字；最长 ${Math.max(...lens)} 字`);

/* ---- 3. 实际生成结果对比 ---- */
const { cues, droppedNoise, clamped } = buildCues(
  tr.segments,
  {
    maxCharsPerLine: cfg.clip.subtitle.maxCharsPerLine,
    minDurationSec: cfg.clip.subtitle.minDurationSec,
  },
  looksLikeNoise,
);
console.log('\n\x1b[1m③ 实际生成的字幕\x1b[0m');
console.log(`  段落 ${tr.segments.length} 条 → 字幕 ${cues.length} 条（丢噪声 ${droppedNoise}，调整时长 ${clamped}）`);
const cueDur = cues.map((c) => c.end - c.start);
console.log(`  字幕时长：平均 ${(cueDur.reduce((a, b) => a + b, 0) / cueDur.length).toFixed(1)}s，最长 ${Math.max(...cueDur).toFixed(1)}s`);

// 时间轴覆盖率：字幕覆盖的秒数 / 转写覆盖的秒数
const trSpan = tr.segments.reduce((a, s) => a + (s.end - s.start), 0);
const cueSpan = cues.reduce((a, c) => a + (c.end - c.start), 0);
console.log(`  转写覆盖 ${trSpan.toFixed(0)}s，字幕覆盖 ${cueSpan.toFixed(0)}s → \x1b[33m字幕只覆盖了 ${((cueSpan / trSpan) * 100).toFixed(1)}% 的说话时间\x1b[0m`);

console.log('\n\x1b[1m④ 具体例子（原段落 → 生成的字幕）\x1b[0m');
// 挑 2 条最长的和 2 条被截断最多的
const samples = [
  ...[...tr.segments].sort((a, b) => [...b.text].length - [...a.text].length).slice(0, 2),
  ...[...tr.segments].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 2),
];
const seen = new Set<string>();
for (const s of samples) {
  const key = `${s.start}-${s.end}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const cue = cues.find((c) => Math.abs(c.start - s.start) < 0.02);
  console.log(`\n  原段落 ${s.start.toFixed(1)}–${s.end.toFixed(1)}s（${(s.end - s.start).toFixed(1)}s，${[...s.text].length} 字）：`);
  console.log(`    ${s.text}`);
  if (cue) {
    console.log(`  生成字幕 ${cue.start.toFixed(1)}–${cue.end.toFixed(1)}s（${(cue.end - cue.start).toFixed(1)}s）：`);
    for (const line of cue.text.split('\\N')) console.log(`    │ ${line}`);
    const lostChars = [...s.text].length - cue.text.replace(/\\N/g, '').replace(/…$/, '').length;
    if (lostChars > 0) console.log(`    \x1b[31m→ 丢了约 ${lostChars} 个字\x1b[0m`);
    if (s.end - s.start - (cue.end - cue.start) > 0.5) {
      console.log(`    \x1b[31m→ 显示时长缩短 ${(s.end - s.start - (cue.end - cue.start)).toFixed(1)}s（这段语音的后半段没有字幕）\x1b[0m`);
    }
  } else {
    console.log('  \x1b[33m（这条被当作噪声丢弃了）\x1b[0m');
  }
}
console.log('');
