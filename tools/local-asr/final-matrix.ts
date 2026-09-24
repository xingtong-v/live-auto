import fs from 'node:fs';

function normalize(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）《》【】…—·,.!?;:"'()<>[\]~`\-_/\\|@#$%^&*+=]/g, '')
    .toLowerCase();
}
function ed(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  let cur = new Array<number>(B.length + 1);
  for (let i = 1; i <= A.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[B.length]!;
}
interface Cue { s: number; e: number; t: string }
function readSrt(p: string): Cue[] {
  const raw = fs.readFileSync(p, 'utf8').replace(/\r/g, '').replace(/^\uFEFF/, '');
  const out: Cue[] = [];
  for (const b of raw.split(/\n{2,}/)) {
    const m = /(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)/.exec(b);
    if (!m) continue;
    const toS = (h: string, mi: string, s: string, ms: string): number =>
      Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000;
    const t = b.split('\n').filter((l) => !/-->/.test(l) && !/^\s*\d+\s*$/.test(l)).join(' ').trim();
    out.push({ s: toS(m[1]!, m[2]!, m[3]!, m[4]!), e: toS(m[5]!, m[6]!, m[7]!, m[8]!), t });
  }
  return out;
}

const cloud = readSrt('data/local-asr-test/cloud-300s.srt');
const cloudText = normalize(cloud.map((c) => c.t).join(''));
const cloudCover = (cloud[cloud.length - 1]!.e - cloud[0]!.s);

interface Row { name: string; wall: number; rtf: number; cues: number; cover: number; cer: number; chars: number; note: string }
const rows: Row[] = [];
function add(name: string, wall: number, cues: number, text: string, cover: number, note: string): void {
  const n = normalize(text);
  rows.push({ name, wall, rtf: wall / 300, cues, cover, cer: (ed(cloudText, n) / cloudText.length) * 100, chars: n.length, note });
}

add('① 云端 fun-asr（基准）', 8.9, cloud.length, cloud.map((c) => c.t).join(''), cloudCover, '按量付费 ¥0.066 / 需上传');
// whisper 本地（读独立结果文件，不依赖 data/tasks —— 那会被清理）
{
  const c = readSrt('data/local-asr-test/r-whisper.srt');
  add('② 本地 faster-whisper turbo', 10.6, c.length, c.map((x) => x.t).join(''), c[c.length - 1]!.e - c[0]!.s, '4GB Python 环境 / 时间戳最细');
}
{
  const c = readSrt('data/local-asr-test/r-nano.srt');
  add('③ 本地 Fun-ASR-Nano (CPU)', 263.1, c.length, c.map((x) => x.t).join(''), c[c.length - 1]!.e - c[0]!.s, '1GB 模型 / 单文件 exe / 太慢');
}
{
  const c = readSrt('data/local-asr-test/r-sensevoice-cuda.srt');
  add('④ 本地 SenseVoice (CUDA)', 4.4, c.length, c.map((x) => x.t).join(''), c[c.length - 1]!.e - c[0]!.s, '最快，但**丢首段**');
}
{
  const c = readSrt('data/local-asr-test/r-sensevoice-cpu.srt');
  add('④b 本地 SenseVoice (CPU)', 48.2, c.length, c.map((x) => x.t).join(''), c[c.length - 1]!.e - c[0]!.s, '覆盖完整');
}

console.log(`云端基准：${cloud.length} 条 / ${cloudText.length} 字 / 覆盖 ${cloudCover.toFixed(0)}s\n`);
console.log('方案'.padEnd(30) + '耗时'.padEnd(9) + 'RTF'.padEnd(8) + 'CER'.padEnd(9) + '字数'.padEnd(7) + '覆盖'.padEnd(8) + '备注');
console.log('─'.repeat(112));
for (const r of rows) {
  console.log(
    r.name.padEnd(28) + `${r.wall.toFixed(1)}s`.padEnd(10) + r.rtf.toFixed(3).padEnd(8) +
      `${r.cer.toFixed(2)}%`.padEnd(9) + String(r.chars).padEnd(7) + `${r.cover.toFixed(0)}s`.padEnd(8) + r.note,
  );
}

console.log('\n外推到 4 小时素材（240 分钟）：');
for (const r of rows) {
  const min = (240 * 60 * r.rtf) / 60;
  console.log(`  ${r.name.padEnd(28)} ${min < 60 ? `${min.toFixed(1)} 分钟` : `${(min / 60).toFixed(1)} 小时`}`);
}
