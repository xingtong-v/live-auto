/**
 * 同一段音频，**云端 vs 本地**的字幕时间戳对照（可复现）。
 *
 * 材料：本场（丁主播 (⊙o⊙)？）第二个切片的开头 40 秒 —— 云端在这段上给出了"一句话占 31 秒"的窗口，
 * 也就是用户看到"字幕对不上"的地方。
 *
 * 三方对照：
 *   ① 云端 fun-asr（整场转写里的对应行，来自 transcript.json）
 *   ② 云端 fun-asr（把这段单独送去的识别结果 —— 排除"整场太长导致"的可能）
 *   ③ 本地 Fun-ASR-Nano（GGUF / CPU）
 * 再加一列**响度真值**（每秒 RMS，本地 ffmpeg 算）：哪里真的有人在说话。
 *
 * 用法：node tools/asr-timestamp-compare.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BiliLiveClient } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { computeEnergyProfile } from '../src/speech-energy.ts';
import { ROOT_DIR } from '../src/util.ts';

const taskId = 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const WINDOW = 40;
const outDir = path.join(ROOT_DIR, 'data', 'local-asr-test');

const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8')) as {
  clips?: Array<{ index: number; start: number; end: number; cutOutput?: string }>;
};
const clip = (clipsJson.clips ?? []).find((c) => c.index === 1);
if (!clip?.cutOutput) throw new Error('找不到 clip[1] 的产物');
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8')) as {
  segments?: Array<{ start: number; end: number; text: string }>;
};
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'ledger.json'), 'utf8')) as {
  tasks?: Record<string, { source?: { rawFiles?: string[] } }>;
};
const src = (ledger.tasks?.[taskId]?.source?.rawFiles ?? [])[0];

const fmt = (s: number): string => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
};
const rel = (abs: number): number => abs - clip.start; // 转成"切片内秒数"

/* ---------- ① 云端（整场转写）在这 40 秒里的行 ---------- */
const cloudFull = (tr.segments ?? [])
  .map((s) => ({ start: rel(Number(s.start)), end: rel(Number(s.end)), text: String(s.text) }))
  .filter((s) => s.end > 0 && s.start < WINDOW);

/* ---------- ② 云端对"这 40 秒"的单独识别 ---------- */
fs.mkdirSync(outDir, { recursive: true });
const cloudSrtPath = path.join(outDir, `cloud-clip1-head${WINDOW}.srt`);
let cloudSrt = '';
try {
  const srt = await BiliLiveClient.fromConfig(loadConfig().config).subtitle({
    file: clip.cutOutput,
    startTime: 0,
    endTime: WINDOW,
    offset: 0,
    song: false,
    timeoutMs: 300000,
  });
  cloudSrt = String(srt);
  fs.writeFileSync(cloudSrtPath, cloudSrt, 'utf8');
  console.log(`② 云端单独识别已存：${path.relative(ROOT_DIR, cloudSrtPath)}（本次调用约 ¥${((WINDOW / 3600) * 0.79).toFixed(4)}）`);
} catch (e) {
  console.log(`② 云端单独识别失败（不重试，避免重复付费）：${(e as Error).message}`);
  if (fs.existsSync(cloudSrtPath)) cloudSrt = fs.readFileSync(cloudSrtPath, 'utf8');
}

/* ---------- ③ 本地 Fun-ASR-Nano ---------- */
const wav = path.join(outDir, `clip1-head${WINDOW}.wav`);
if (!fs.existsSync(wav)) {
  spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-t', String(WINDOW), '-i', clip.cutOutput, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav]);
}
const localSrtPath = path.join(outDir, `local-clip1-head${WINDOW}.srt`);
let localSrt = '';
{
  const t0 = Date.now();
  const res = spawnSync(
    path.join(ROOT_DIR, '.funasr', 'bin-cpu', 'llama-funasr-cli.exe'),
    [
      '--enc', path.join(ROOT_DIR, '.funasr', 'models', 'funasr-encoder-f16.gguf'),
      '-m', path.join(ROOT_DIR, '.funasr', 'models', 'qwen3-0.6b-q5km.gguf'),
      '--vad', path.join(ROOT_DIR, '.funasr', 'models', 'fsmn-vad.gguf'),
      '-a', wav,
      '--srt',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 },
  );
  const buf = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(String(res.stdout ?? ''));
  const text = (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
  localSrt = text;
  fs.writeFileSync(localSrtPath, text, 'utf8');
  console.log(`③ 本地 Fun-ASR-Nano 已存：${path.relative(ROOT_DIR, localSrtPath)}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s / ${WINDOW}s 音频）`);
}

/* ---------- ④ 响度真值（源文件，绝对时间） ---------- */
const profile = computeEnergyProfile(src ?? '', { binSec: 1 });
const loud = (t: number): number => {
  if (!profile) return 0;
  const i = Math.floor((clip.start + t) / profile.binSec);
  const v = profile.rms[i] ?? 0;
  return 20 * Math.log10(Math.max(1e-6, v));
};

/* ---------- 解析 SRT ---------- */
function parseSrt(text: string): Array<{ start: number; end: number; text: string }> {
  const toSec = (t: string): number => {
    const m = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/.exec(t);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : 0;
  };
  const rows: Array<{ start: number; end: number; text: string }> = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti]!.split('-->');
    rows.push({ start: toSec(a ?? ''), end: toSec(b ?? ''), text: lines.slice(ti + 1).join(' ').trim() });
  }
  return rows;
}
const cloudWin = parseSrt(cloudSrt);
const local = parseSrt(localSrt);

/* ---------- 打印对照 ---------- */
console.log(`\n切片 clip[1] 的开头 ${WINDOW} 秒（整场 ${fmt(clip.start)} → ${fmt(clip.start + WINDOW)}）\n`);
const table = (title: string, rows: Array<{ start: number; end: number; text: string }>): void => {
  console.log(`【${title}】`);
  if (rows.length === 0) {
    console.log('  （空）');
    return;
  }
  for (const r of rows) {
    const dur = (r.end - r.start).toFixed(2);
    console.log(`  ${fmt(r.start)} → ${fmt(r.end)}  跨 ${dur.padStart(6)}s  ${r.text}`);
  }
  console.log('');
};
table('① 云端（整场转写里的对应行）', cloudFull);
table('② 云端（只把这段 40 秒送去识别）', cloudWin);
table('③ 本地 Fun-ASR-Nano（GGUF/CPU）', local);

console.log('【④ 响度真值（每秒 RMS，dB）—— 人真正在说话的时段】');
let strip = '';
for (let t = 0; t < WINDOW; t++) {
  const d = loud(t);
  strip += `${String(t).padStart(2)}s:${d.toFixed(0).padStart(4)}  `;
  if (t % 5 === 4) strip += '\n';
}
console.log(strip);
console.log('说明：-35 dB 上下是背景（音乐/游戏音效），-25 dB 以上基本就是人声。');
