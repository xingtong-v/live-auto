/**
 * 字幕生成效果预览：用**真实转写**生成 ASS，把条目与断句结果打出来给人核对。
 *
 * 为什么需要它：字幕的两个问题（时长、断句）都是**观感问题**，
 * 只有把"某一句实际会显示成什么样"摊开看，才能判断改得对不对。
 * 诊断工具负责量化，这个工具负责"人眼可核对"。
 *
 * 只读（不写 ASS 文件，只在内存里生成）。
 *
 * 用法：node tools/subtitle-preview.ts [taskId] [样本条数]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { loadConfig } from '../src/config.ts';
import { readJson } from '../src/util.ts';
import { buildCues, buildSubtitleOnlyAss, widthOfText } from '../src/subtitle-ass.ts';
import { looksLikeNoise } from '../src/asr.ts';
import type { Transcript } from '../src/types.ts';

const cfg = loadConfig().config;
const ledger = new Ledger();
const taskId = process.argv[2] ?? ledger.listTasks({ limit: 20 })[0]?.id;
const sampleCount = Number(process.argv[3] ?? 12) || 12;
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

const render = {
  maxCharsPerLine: cfg.clip.subtitle.maxCharsPerLine,
  minDurationSec: cfg.clip.subtitle.minDurationSec,
  ...(cfg.clip.subtitle.readingCharsPerSec ? { readingCharsPerSec: cfg.clip.subtitle.readingCharsPerSec } : {}),
};
const { cues, droppedNoise, clamped } = buildCues(tr.segments, render, looksLikeNoise);

console.log(`\x1b[1m字幕生成效果\x1b[0m  ${taskId}`);
console.log(`  转写 ${tr.segments.length} 段 → 字幕 \x1b[1m${cues.length}\x1b[0m 条（丢噪声 ${droppedNoise}，调整时长 ${clamped}）`);
console.log('─'.repeat(84));

/* ---- 量化指标 ---- */
const durs = cues.map((c) => c.end - c.start);
const chars = cues.map((c) => c.text.replace(/\\N/g, '').length);
const cps = cues.map((c, i) => (durs[i]! > 0 ? chars[i]! / durs[i]! : 0));
const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / (a.length || 1);

console.log('\n\x1b[1m① 关键指标\x1b[0m');
console.log(`  展示时长  平均 ${avg(durs).toFixed(2)}s   最短 ${Math.min(...durs).toFixed(2)}s   最长 ${Math.max(...durs).toFixed(2)}s`);
console.log(`  每条字数  平均 ${avg(chars).toFixed(1)} 字   最多 ${Math.max(...chars)} 字`);
console.log(`  阅读速度  平均 ${avg(cps).toFixed(1)} 字/秒（目标 ≈4；越接近说明字幕越跟得上说话）`);
const stuck = cues.filter((c, i) => durs[i]! > 6 && chars[i]! < 12).length;
console.log(`  挂屏过久（>6s 但不足 12 字）：\x1b[${stuck === 0 ? '32' : '31'}m${stuck} 条\x1b[0m`);
const singleChar = cues.filter((c) => c.text.replace(/\\N/g, '').length <= 1).length;
console.log(`  单字字幕：${singleChar} 条`);
// 说话密集时"最短显示时长"会被下一条挤掉，闪一下的字幕人眼抓不住 → 单独统计
const flash = cues.filter((c) => c.end - c.start < 0.5).length;
console.log(`  闪一下（<0.5s）：\x1b[${flash / cues.length < 0.02 ? '32' : '33'}m${flash} 条\x1b[0m（${((flash / cues.length) * 100).toFixed(1)}%）`);

/* ---- 断句：是否还需要折行 ---- */
const wrapped = cues.filter((c) => c.text.includes('\\N'));
const oneLine = cues.length - wrapped.length;
console.log('\n\x1b[1m② 断句\x1b[0m');
console.log(`  一行放得下：${oneLine}/${cues.length} 条（${((oneLine / cues.length) * 100).toFixed(1)}%）`);
console.log(`  需要折成两行：\x1b[${wrapped.length / cues.length < 0.02 ? '32' : '33'}m${wrapped.length} 条\x1b[0m`);
const usable = tr.segments.filter((s) => !looksLikeNoise(s.text)).length;
console.log(`  切句放大：${usable} 个 ASR 段落 → ${cues.length} 条字幕（×${(cues.length / (usable || 1)).toFixed(2)}，越大于 1 说明"整块文字"被切成了逐句出现）`);
const big = cues.filter((c) => c.text.replace(/\\N/g, '').length > 20).length;
console.log(`  超过 20 字的长条：${big} 条（折行与劈词的主要来源）`);

/* ---- 人眼核对：相邻 12 条连续字幕 ---- */
console.log(`\n\x1b[1m③ 连续 ${sampleCount} 条（看节奏与断句）\x1b[0m`);
const startIdx = Math.floor(cues.length / 3); // 从中间取一段，避开开场白
for (const c of cues.slice(startIdx, startIdx + sampleCount)) {
  const chars = c.text.replace(/\\N/g, '').length;
  const dur = c.end - c.start;
  console.log(
    `  \x1b[90m${c.start.toFixed(1).padStart(8)}–${c.end.toFixed(1).padStart(8)}s\x1b[0m  ${dur.toFixed(1)}s  ${String(chars).padStart(2)} 字`,
  );
  for (const line of c.text.split('\\N')) console.log(`      │ ${line}`);
}

/* ---- 长段落被切成多条的例子 ---- */
console.log('\n\x1b[1m④ 原段落 → 切成的多条字幕（证明"没有断句"已修）\x1b[0m');
const longSegs = [...tr.segments].filter((s) => [...s.text].length >= 22).sort((a, b) => [...b.text].length - [...a.text].length).slice(0, 3);
for (const s of longSegs) {
  console.log(`\n  原文（${s.start.toFixed(1)}–${s.end.toFixed(1)}s，${[...s.text].length} 字）：${s.text}`);
  const mine = cues.filter((c) => c.start >= s.start - 0.05 && c.end <= s.end + 0.05);
  for (const c of mine) {
    console.log(`      ${c.start.toFixed(1)}–${c.end.toFixed(1)}s (${(c.end - c.start).toFixed(1)}s)  ${c.text.replace(/\\N/g, ' ⏎ ')}`);
  }
  if (mine.length === 0) console.log('      （这段被丢弃或与相邻条重叠）');
}

/* ---- 生成 ASS 的自检（保证能被播放器正确渲染） ---- */
const ass = buildSubtitleOnlyAss(cues, { resolution: { width: 1080, height: 1920 } });
console.log('\n\x1b[1m⑤ ASS 自检\x1b[0m');
console.log(`  含 Script Info：${ass.includes('[Script Info]')}   含 Events：${ass.includes('[Events]')}`);
console.log(`  Dialogue 条数：${(ass.match(/^Dialogue:/gm) ?? []).length}（应等于 ${cues.length}）`);
console.log(`  无 BOM：${!ass.startsWith('\uFEFF')}   分辨率：${/PlayResX: (\d+)/.exec(ass)?.[1]}×${/PlayResY: (\d+)/.exec(ass)?.[1]}`);

/* ---- 生产 ASS 成品核对（如果这个任务已经切过片，磁盘上就有真烧进去的那份） ---- */
const files = fs.readdirSync(ledger.taskDir(taskId)).filter((f) => /^subtitle-.*\.ass$/.test(f));
if (files.length === 0) {
  console.log('\n\x1b[1m⑥ 生产 ASS\x1b[0m  还没切片，磁盘上没有成品（上面的②③④是内存里的预测）');
} else {
  for (const f of files) {
    const p = path.join(ledger.taskDir(taskId), f);
    const raw = fs.readFileSync(p, 'utf8');
    const rows: { start: number; end: number; text: string }[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('Dialogue:')) continue;
      const head = line.slice('Dialogue:'.length).split(',', 10);
      if ((head[3] ?? '').trim() !== 'Subtitle') continue;
      const toSec = (t: string): number => {
        const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec((t ?? '').trim());
        return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : NaN;
      };
      rows.push({ start: toSec(head[1] ?? ''), end: toSec(head[2] ?? ''), text: head[9] ?? '' });
    }
    const ws = rows.map((c) => widthOfText(c.text.replace(/\\N/g, '')));
    const ds = rows.map((c) => c.end - c.start);
    const wrap = rows.filter((c) => c.text.includes('\\N')).length;
    console.log(`\n\x1b[1m⑥ 生产 ASS 成品\x1b[0m  ${f}（${(fs.statSync(p).size / 1024).toFixed(0)} KB）`);
    console.log(`  字幕条数：${rows.length}`);
    console.log(`  时间戳可解析：${rows.every((c) => Number.isFinite(c.start) && Number.isFinite(c.end))}`);
    console.log(`  折行条数：\x1b[${wrap === 0 ? '32' : '31'}m${wrap}\x1b[0m`);
    console.log(`  最宽一行：${Math.max(...ws).toFixed(1)} 字宽（上限 ${cfg.clip.subtitle.maxCharsPerLine}）`);
    console.log(`  时长：平均 ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(2)}s  最长 ${Math.max(...ds).toFixed(2)}s  超 8s 的 ${ds.filter((d) => d > 8).length} 条`);
    const badW = ws.filter((w) => w > cfg.clip.subtitle.maxCharsPerLine).length;
    console.log(`  超宽条数：\x1b[${badW === 0 ? '32' : '31'}m${badW}\x1b[0m`);
  }
}
console.log('');
