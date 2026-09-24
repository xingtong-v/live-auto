/**
 * 分析用（不改产品代码）：**纯云端 / 纯本地 / 混合**三种方案的关键指标对比。
 *
 * 素材：切片 clip[1] 开头 40 秒（云端在这段上把一句话拉成 31 秒 —— 用户看到"字幕对不上"的地方）。
 * 三路引擎都在同一段音频上跑过：云端 fun-asr、本地 Fun-ASR-Nano、本地 SenseVoiceSmall（新增第三路）。
 *
 * 指标：
 *   · 屏幕占用率 = 字幕在屏幕上的秒数 / 窗口长度（越高越"糊屏幕"，越低越可能"缺字幕"）
 *   · 人声覆盖 = 响度 ≥ 阈值 的秒数里，有多少秒屏幕上有字幕
 *   · 时间戳偏差 = 每路字幕起点/终点 vs 响度峰值的偏差（以人声段为单位）
 *   · 长句占比 = 跨 > 8 秒（超过单条显示上限）的字幕条数
 *
 * 用法：node tools/hybrid-asr-analysis.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT_DIR } from '../src/util.ts';
import { computeEnergyProfile } from '../src/speech-energy.ts';

const taskId = 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const outDir = path.join(ROOT_DIR, 'data', 'local-asr-test');
const WINDOW = 40;
const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8'));
const clip = (clipsJson.clips ?? []).find((c) => c.index === 1);
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'ledger.json'), 'utf8'));
const src = (ledger.tasks?.[taskId]?.source?.rawFiles ?? [])[0];
const wav = path.join(outDir, `clip1-head${WINDOW}.wav`);

/* ---------- 第三路：本地 SenseVoiceSmall（CPU） ---------- */
const svPath = path.join(outDir, `sensevoice-clip1-head${WINDOW}.srt`);
let svTime = 0;
if (!fs.existsSync(svPath)) {
  const t0 = Date.now();
  const res = spawnSync(
    path.join(ROOT_DIR, '.funasr', 'bin-cpu', 'llama-funasr-sensevoice.exe'),
    [
      '-m', path.join(ROOT_DIR, '.funasr', 'models', 'sensevoice-small-q8.gguf'),
      '--vad', path.join(ROOT_DIR, '.funasr', 'models', 'fsmn-vad.gguf'),
      '-a', wav,
      '--srt',
      '--backend', 'cpu',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 },
  );
  svTime = (Date.now() - t0) / 1000;
  const buf = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(String(res.stdout ?? ''));
  const text = (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
  if (text.includes('-->')) fs.writeFileSync(svPath, text, 'utf8');
  else console.log('SenseVoice 没产出 SRT，stderr 末尾：' + String(res.stderr ?? '').slice(-300));
}

/* ---------- 解析 ---------- */
const toSec = (t) => {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/.exec(String(t));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : 0;
};
const parseSrt = (text) => {
  const rows = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    rows.push({ start: toSec(a), end: toSec(b), text: lines.slice(ti + 1).join(' ').trim() });
  }
  return rows;
};
const cloud = parseSrt(fs.readFileSync(path.join(outDir, `cloud-clip1-head${WINDOW}.srt`), 'utf8'));
const local = parseSrt(fs.readFileSync(path.join(outDir, `local-clip1-head${WINDOW}.srt`), 'utf8'));
const sv = fs.existsSync(svPath) ? parseSrt(fs.readFileSync(svPath, 'utf8')) : [];

/* ---------- 响度真值 ---------- */
const profile = computeEnergyProfile(src, { binSec: 1 });
const loud = [];
for (let t = 0; t < WINDOW; t++) {
  const i = Math.floor((clip.start + t) / profile.binSec);
  loud.push(20 * Math.log10(Math.max(1e-6, profile.rms[i] ?? 0)));
}
const SPEECH_DB = -28; // 实测：-35 上下是背景，-25 以上是人声；-28 取中
const speechSec = loud.map((d, t) => (d >= SPEECH_DB ? t : -1)).filter((t) => t >= 0);

const screenSec = (rows) => rows.reduce((a, r) => a + Math.max(0, Math.min(r.end, WINDOW) - Math.max(r.start, 0)), 0);
const covers = (rows, t) => rows.some((r) => r.start <= t + 0.999 && r.end > t);
const metrics = (name, rows) => {
  const screen = screenSec(rows);
  const hit = speechSec.filter((t) => covers(rows, t)).length;
  const long = rows.filter((r) => r.end - r.start > 8).length;
  const over = rows.filter((r) => r.end - r.start > 8).reduce((a, r) => a + (r.end - r.start), 0);
  return {
    路: name,
    条数: rows.length,
    屏幕占用s: screen.toFixed(1),
    屏幕占用率: ((screen / WINDOW) * 100).toFixed(0) + '%',
    人声覆盖: `${hit}/${speechSec.length}`,
    超8秒条数: long,
    长句占用s: over.toFixed(1),
  };
};

console.log(`切片 clip[1] 开头 ${WINDOW} 秒；人声秒（响度 ≥ ${SPEECH_DB} dB）：${speechSec.join(', ')}`);
console.log(`本地 SenseVoice（CPU）耗时 ${svTime ? svTime.toFixed(1) + 's' : '（复用已有结果）'}\n`);
console.table([metrics('纯云端 fun-asr', cloud), metrics('纯本地 Fun-ASR-Nano', local), metrics('纯本地 SenseVoiceSmall', sv)]);

console.log('\n各路原文：');
for (const [name, rows] of [['云端', cloud], ['本地 Nano', local], ['本地 SenseVoice', sv]]) {
  console.log(`【${name}】`);
  for (const r of rows) console.log(`  ${r.start.toFixed(2)} → ${r.end.toFixed(2)}（${(r.end - r.start).toFixed(2)}s）  ${r.text}`);
}

/* 两路本地引擎的一致性（云端 vs 本地没有共同的时间轴，只能比文字集合） */
const norm = (s) => s.replace(/[\s，。！？、,.!?…~～"'"'（）()《》【】]/g, '');
const setOf = (rows) => new Set(rows.flatMap((r) => norm(r.text).split('')).filter(Boolean));
const inter = (a, b) => [...a].filter((c) => b.has(c)).length;
const cSet = setOf(cloud);
const lSet = setOf(local);
console.log('\n字符集合重叠（只能粗略看"两路说的内容是否一致"）：');
console.log(`  云端 ${cSet.size} 字 ∩ 本地 ${lSet.size} 字 = ${inter(cSet, lSet)} 字（本地独有 ${[...lSet].filter((c) => !cSet.has(c)).join('')}）`);
if (sv.length) {
  const svSet = setOf(sv);
  console.log(`  本地Nano ∩ 本地SenseVoice = ${inter(lSet, svSet)} 字（SenseVoice 独有 ${[...svSet].filter((c) => !lSet.has(c)).join('')}）`);
}
