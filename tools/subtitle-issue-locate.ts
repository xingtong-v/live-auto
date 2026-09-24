/**
 * 字幕问题定位：找出「字幕挂太久」与「折行断在词中间」的具体数据。
 *
 * 用户反馈：「字幕和声音对不上」「字幕也没有断句」。
 * offset 语义已单独验证过（正确），所以往这两处查：
 *
 *   a) **字幕挂太久**：ASR 把「说一句话 + 之后长时间静音」算成一段，
 *      于是 end 远大于实际说话结束时间。我原来的实现是 `min(asrEnd, start+8)`，
 *      结果短句也硬挂 8 秒 —— 观众看到的就是"字幕和声音对不上"（字幕滞后/赖着不走）。
 *      判据：**字数 ÷ 时长** 明显偏低（正常中文直播 3–6 字/秒）。
 *
 *   b) **断句**：折行是按字数硬折的，会在词中间断开（"…那个推流 / 设置有问题…"）。
 *      ASR 文本里其实带标点（，。？！），优先在标点处断行就能明显改善观感。
 *      判据：有标点的段落占比、以及硬折位置落在标点上的比例。
 *
 * 只读。
 *
 * 用法：node tools/subtitle-issue-locate.ts [taskId]
 */
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { loadConfig } from '../src/config.ts';
import { readJson } from '../src/util.ts';
import { buildCues, wrapCjk } from '../src/subtitle-ass.ts';
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
const tr = readJson<Transcript>(t.transcriptPath ?? path.join(ledger.taskDir(taskId), 'transcript.json'));
if (!tr?.segments?.length) {
  console.log('读不到转写');
  process.exit(1);
}

console.log(`\x1b[1m字幕问题定位\x1b[0m  ${taskId}（${tr.segments.length} 段）`);
console.log('─'.repeat(80));

/* ================= a) 字幕挂太久 ================= */
console.log('\n\x1b[1m① 说话速度分布\x1b[0m（字数 ÷ 时长；正常中文直播 3–6 字/秒）');
const speeds = tr.segments
  .map((s) => {
    const chars = [...s.text].length;
    const dur = s.end - s.start;
    return { s, chars, dur, cps: dur > 0 ? chars / dur : 999 };
  })
  .filter((x) => x.chars > 0);
const slowBuckets = [
  ['< 1 字/秒（几乎肯定是把静音算进去了）', (x: number) => x < 1],
  ['1–2 字/秒（偏慢）', (x: number) => x >= 1 && x < 2],
  ['2–3 字/秒（略慢）', (x: number) => x >= 2 && x < 3],
  ['3–6 字/秒（正常）', (x: number) => x >= 3 && x <= 6],
  ['> 6 字/秒（说话很快或文本缺失）', (x: number) => x > 6],
] as const;
for (const [name, f] of slowBuckets) {
  const n = speeds.filter((x) => f(x.cps)).length;
  const bar = '█'.repeat(Math.round((n / speeds.length) * 36));
  console.log(`  ${name.padEnd(34)} ${String(n).padStart(4)}  ${((n / speeds.length) * 100).toFixed(1).padStart(5)}%  ${bar}`);
}
const farTooSlow = speeds.filter((x) => x.cps < 2 && x.dur > 4);
console.log(`\n  → **时长明显偏长**（<2 字/秒 且 >4 秒）的段落：\x1b[31m${farTooSlow.length} 条\x1b[0m`);
if (farTooSlow.length) {
  const wasted = farTooSlow.reduce((a, x) => a + (x.dur - x.chars / 4), 0);
  console.log(`     按 4 字/秒 估算，这些段落合计多占了 \x1b[31m${wasted.toFixed(0)} 秒\x1b[0m 屏幕时间（字幕赖着不走）`);
  console.log('\n     最严重的 5 条：');
  for (const x of farTooSlow.sort((a, b) => b.dur - a.dur).slice(0, 5)) {
    console.log(`     ${x.dur.toFixed(1)}s / ${x.chars} 字 = ${x.cps.toFixed(2)} 字/秒   ${x.s.start.toFixed(0)}s  「${x.s.text.slice(0, 34)}」`);
  }
}

/* ================= b) 断句 / 折行 ================= */
console.log('\n\x1b[1m② 标点与折行\x1b[0m');
const hasPunct = tr.segments.filter((s) => /[，。！？、；：]/.test(s.text)).length;
console.log(`  含标点的段落：${hasPunct} / ${tr.segments.length}（${((hasPunct / tr.segments.length) * 100).toFixed(1)}%）`);
console.log('  注：ASR 会给出「，。？」，所以折行应当**优先在标点处断**，而不是按字数硬折。');

const cap = cfg.clip.subtitle.maxCharsPerLine;
const wrapBad = tr.segments.filter((s) => {
  const lines = wrapCjk(s.text, cap);
  if (lines.length < 2) return false;
  // 硬折点恰好落在标点后面 → 断得漂亮；否则是"词中间断开"
  const first = lines[0]!;
  return !/[，。！？、；：,.]$/.test(first);
});
console.log(`\n  需要折行的段落：${tr.segments.filter((s) => wrapCjk(s.text, cap).length >= 2).length} 条`);
console.log(`  其中**断点不在标点上**（词中间断开）：\x1b[31m${wrapBad.length} 条\x1b[0m`);
console.log('\n  最典型的 5 条（当前硬折 vs 按标点断）：');
for (const s of wrapBad.slice(0, 5)) {
  const hard = wrapCjk(s.text, cap);
  // 按标点优先断的示意
  const m = /^(.*?[，。！？、；：])(.+)$/.exec(s.text);
  const soft = m && [...m[1]!].length <= cap + 4 ? [m[1]!, m[2]!] : null;
  console.log(`    原文：${s.text}`);
  console.log(`      硬折：${hard.join('  /  ')}`);
  if (soft) console.log(`      \x1b[32m标点优先：${soft.join('  /  ')}\x1b[0m`);
  else console.log('      （该段没有可用的标点，只能硬折）');
}

/* ================= 当前实现会挂多久 ================= */
console.log('\n\x1b[1m③ 当前实现（min(asrEnd, start+8)）的实际展示时长\x1b[0m');
const { cues } = buildCues(tr.segments, { maxCharsPerLine: cap, minDurationSec: cfg.clip.subtitle.minDurationSec }, looksLikeNoise);
const hit8 = cues.filter((c) => c.end - c.start >= 7.99).length;
console.log(`  字幕 ${cues.length} 条；其中 **顶到 8 秒上限** 的：\x1b[31m${hit8} 条\x1b[0m（这些就是"挂着不走"的）`);
const tooLongForText = cues.filter((c) => {
  const chars = c.text.replace(/\\N/g, '').length;
  return c.end - c.start > Math.max(1.2, chars / 3);
});
console.log(`  展示时长 > 按字数所需（3 字/秒）的：\x1b[31m${tooLongForText.length} 条\x1b[0m`);
console.log('\n  例子（当前显示时长 → 按 4 字/秒该显示多久）：');
for (const c of tooLongForText.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 5)) {
  const chars = c.text.replace(/\\N/g, '').length;
  console.log(`    ${(c.end - c.start).toFixed(1)}s → ${Math.max(0.8, chars / 4).toFixed(1)}s   ${chars} 字  「${c.text.replace(/\\N/g, ' ').slice(0, 30)}」`);
}
console.log('');
