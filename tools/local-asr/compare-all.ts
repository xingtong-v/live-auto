/**
 * 三条本地 ASR 路线 vs 云端 Fun-ASR 的质量对比（同一段 5 分钟音频）。
 * 复用 compare-asr 的 CER 思路，但直接读已有结果文件，不再重复付费调云端。
 *
 *   云端基准 : data/local-asr-test/cloud-300s.srt        （fun-asr）
 *   本地 A   : data/tasks/<最近任务>/transcript.json      （faster-whisper large-v3-turbo）
 *   本地 B   : data/local-asr-test/funasr-nano-300s.srt   （Fun-ASR-Nano，CPU）
 *   本地 C   : data/local-asr-test/sv-cuda.srt            （SenseVoiceSmall，CUDA）
 */
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
function srtText(p: string): { text: string; cues: number } {
  const raw = fs.readFileSync(p, 'utf8').replace(/\r/g, '');
  let cues = 0;
  const texts: string[] = [];
  for (const b of raw.split(/\n{2,}/)) {
    if (!/-->/.test(b)) continue;
    cues++;
    const t = b.split('\n').filter((l) => !/-->/.test(l) && !/^\d+$/.test(l.trim())).join('');
    if (t.trim()) texts.push(t.trim());
  }
  return { text: texts.join(''), cues };
}

const ref = srtText('data/local-asr-test/cloud-300s.srt');
const refNorm = normalize(ref.text);
console.log(`云端基准（fun-asr）：${ref.cues} 条字幕，归一化 ${refNorm.length} 字\n`);

// 找最近一次本地 whisper 任务
const taskDirs = fs.readdirSync('data/tasks').sort();
let whisper: { text: string; cues: number } | null = null;
for (const d of taskDirs.slice().reverse()) {
  const p = `data/tasks/${d}/transcript.json`;
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { source?: string; segments?: Array<{ text: string }> };
  if (j.source === 'whisper-cpp') {
    whisper = { text: (j.segments ?? []).map((s) => s.text).join(''), cues: (j.segments ?? []).length };
    console.log(`本地 faster-whisper 取自任务 ${d}（${whisper.cues} 条）\n`);
    break;
  }
}

const rows: Array<{ name: string; cues: number; chars: number; cer: number; extra: string }> = [];
function add(name: string, hyp: { text: string; cues: number }, extra: string): void {
  const hn = normalize(hyp.text);
  const d = ed(refNorm, hn);
  rows.push({ name, cues: hyp.cues, chars: hn.length, cer: (d / refNorm.length) * 100, extra });
  console.log(`${name}`);
  console.log(`  ${hyp.cues} 条字幕，${hn.length} 字（云端 ${refNorm.length} 字，差 ${hn.length - refNorm.length >= 0 ? '+' : ''}${hn.length - refNorm.length}）`);
  console.log(`  CER（以云端为基准）= ${((d / refNorm.length) * 100).toFixed(2)}%   编辑距离 ${d}`);
  console.log(`  ${extra}\n`);
}

if (whisper) add('① 本地 faster-whisper large-v3-turbo（GPU）', whisper, '耗时 10.6s / RTF 0.035 / 需 4GB Python 环境');

for (const [name, path, extra] of [
  ['② 本地 Fun-ASR-Nano（CPU）', 'data/local-asr-test/funasr-nano-300s.srt', '耗时 280.8s / RTF 0.936 / 仅 1GB 模型'],
  ['③ 本地 SenseVoiceSmall（CUDA）', 'data/local-asr-test/sv-cuda.srt', '耗时 4.6s / RTF 0.015 / 单文件 exe'],
] as const) {
  if (!fs.existsSync(path)) {
    console.log(`${name} —— 结果文件缺失：${path}\n`);
    continue;
  }
  add(name, srtText(path), extra);
}

console.log('=== 汇总（按 CER 升序 = 越接近云端越好）===');
rows.sort((a, b) => a.cer - b.cer);
console.log('  方案'.padEnd(42) + 'CER'.padEnd(10) + '字数'.padEnd(8) + '字幕条数');
for (const r of rows) {
  console.log('  ' + r.name.padEnd(40) + `${r.cer.toFixed(2)}%`.padEnd(10) + String(r.chars).padEnd(8) + String(r.cues));
}
