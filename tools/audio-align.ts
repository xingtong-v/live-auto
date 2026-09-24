/**
 * 用音频包络互相关，测出"成片某一时刻的**声音**实际来自源的第几秒"。
 *
 * 为什么非做这一步：容器里的 start_time 只说明两条流的 PTS 差，
 * 说不清内容是否同步。画面内容可以用墙上时钟定标，声音只能靠波形比对。
 * 两者一比，才能判断"字幕/画面 与 声音"到底差多少 —— 这正是用户报的问题。
 *
 * 做法：把两段音频解码成低采样率单声道 PCM，取短时能量包络，
 * 在候选位移上做互相关，取相关性最高的位移（包络对语音的音节/停顿很敏感，±20ms 量级可用）。
 *
 * 只读。
 * 用法：node tools/audio-align.ts <源文件> <成片> <源起点秒> <成片起点秒> <窗长秒>
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findFfprobe } from '../src/media.ts';
import { exists } from '../src/util.ts';

const probeDir = findFfprobe() ? path.dirname(findFfprobe()!) : '';
const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const ffmpeg = probeDir && exists(path.join(probeDir, exe)) ? path.join(probeDir, exe) : exe;

const SRC = process.argv[2]!;
const CLIP = process.argv[3]!;
const srcFrom = Number(process.argv[4] ?? 860);
const clipFrom = Number(process.argv[5] ?? 0);
const span = Number(process.argv[6] ?? 30);

/** 解码成 8kHz 单声道 PCM（一帧 0.125ms，够定位） */
function pcm(file: string, from: number, dur: number): Float32Array {
  const buf = execFileSync(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(from), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
    { timeout: 300000, maxBuffer: 256 * 1024 * 1024 },
  );
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** 短时能量包络：每 hop 个采样算一个 RMS */
function envelope(x: Float32Array, hop: number): Float64Array {
  const n = Math.floor(x.length / hop);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < hop; j++) {
      const v = x[i * hop + j] ?? 0;
      s += v * v;
    }
    e[i] = Math.sqrt(s / hop);
  }
  // 去均值，让互相关只看"变化"
  let m = 0;
  for (const v of e) m += v;
  m /= n || 1;
  for (let i = 0; i < n; i++) e[i] = e[i]! - m;
  return e;
}

const HOP = 80; // 8000/80 = 100 帧/秒 → 10ms 分辨率
const src = envelope(pcm(SRC, srcFrom, span + 12), HOP);
const clip = envelope(pcm(CLIP, clipFrom, span), HOP);
console.log(`源 ${path.basename(SRC)} @${srcFrom}s：包络 ${src.length} 帧`);
console.log(`成片 ${path.basename(CLIP)} @${clipFrom}s：包络 ${clip.length} 帧\n`);

/** 归一化互相关 */
function corr(a: Float64Array, b: Float64Array, lag: number): { score: number; n: number } {
  let num = 0;
  let da = 0;
  let db = 0;
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    const av = a[i + lag];
    if (av === undefined) break;
    const bv = b[i]!;
    num += av * bv;
    da += av * av;
    db += bv * bv;
    n++;
  }
  if (n < b.length * 0.6 || da === 0 || db === 0) return { score: -1, n };
  return { score: num / Math.sqrt(da * db), n };
}

let best = { lag: 0, score: -1 };
const results: Array<{ lag: number; score: number }> = [];
for (let lag = 0; lag <= src.length - clip.length; lag++) {
  const r = corr(src, clip, lag);
  results.push({ lag, score: r.score });
  if (r.score > best.score) best = { lag, score: r.score };
}
results.sort((a, b) => b.score - a.score);
console.log('前 5 个最佳位移（位移 = 成片第 0 秒对应的源内偏移）：');
for (const r of results.slice(0, 5)) {
  console.log(`  源 +${(srcFrom + r.lag / 100).toFixed(2)}s  相关 ${r.score.toFixed(4)}`);
}
console.log(
  `\n\x1b[1m结论：成片 ${clipFrom}s 处的声音 = 源第 ${(srcFrom + best.lag / 100).toFixed(2)}s\x1b[0m（相关性 ${best.score.toFixed(3)}）`,
);
