/**
 * 分析：**形态 A（只对要投出去的切片窗口用本地重识别做字幕）**到底带来什么提升。
 *
 * 用用户刚投稿的**真实两片**做对照，两路都过一遍我们**真实的显示规则**（`buildCues`：每条 0.8–8 秒），
 * 再拿切片音频的响度剖面当"人到底在不在说话"的参照：
 *
 *   指标              含义
 *   ─────────────────────────────────────────────────────────────
 *   字幕条数 / 屏幕占用   观众实际看到多少字、占屏多久（越高越糊屏，越低越可能缺字）
 *   超 8 秒长句          被显示规则截断后留下空档的根源
 *   最长空档             屏幕上完全没字幕的最长一段
 *   人声覆盖             响度 ≥ 阈值的秒里有多少秒有字幕
 *   对不上人的时长        有字幕但没人说话的秒数（"字幕挂在没说话的时候"）
 *   位置被挪动的条数      与云端相比，起点移动 > 5 秒的字幕条数（= 真正被修好的部分）
 *
 * 用法：node tools/form-a-improvement.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCues } from '../src/subtitle-ass.ts';
import { computeEnergyProfile } from '../src/speech-energy.ts';
import { ROOT_DIR } from '../src/util.ts';

const taskId = 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const outDir = path.join(ROOT_DIR, 'data', 'local-asr-test');
fs.mkdirSync(outDir, { recursive: true });

const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8')) as {
  clips?: Array<{ index: number; start: number; end: number; cutOutput?: string }>;
};
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8')) as { segments?: Array<{ start: number; end: number; text: string }> };
const allSegs = (tr.segments ?? []).map((s) => ({
  start: Number(s.start),
  end: Number(s.end),
  text: String(s.text ?? ''),
}));

const toSec = (t: string): number => {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/.exec(String(t));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : 0;
};
function parseSrt(text: string): Array<{ start: number; end: number; text: string }> {
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

/** 本地引擎跑整片音频（CPU）。engine: nano=Fun-ASR-Nano(0.6B) / sv=SenseVoiceSmall */
function localAsr(clipPath: string, seconds: number, tag: string, engine: 'nano' | 'sv'): { rows: Array<{ start: number; end: number; text: string }>; wallSec: number } {
  const wav = path.join(outDir, `formA-${tag}.wav`);
  const srt = path.join(outDir, `formA-${tag}-${engine}.srt`);
  if (!fs.existsSync(wav)) {
    spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-t', String(Math.ceil(seconds)), '-i', clipPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav]);
  }
  if (!fs.existsSync(srt)) {
    const t0 = Date.now();
    const args =
      engine === 'nano'
        ? [
            '--enc', path.join(ROOT_DIR, '.funasr', 'models', 'funasr-encoder-f16.gguf'),
            '-m', path.join(ROOT_DIR, '.funasr', 'models', 'qwen3-0.6b-q5km.gguf'),
            '--vad', path.join(ROOT_DIR, '.funasr', 'models', 'fsmn-vad.gguf'),
            '-a', wav,
            '--srt',
          ]
        : ['-m', path.join(ROOT_DIR, '.funasr', 'models', 'sensevoice-small-q8.gguf'), '--vad', path.join(ROOT_DIR, '.funasr', 'models', 'fsmn-vad.gguf'), '-a', wav, '--srt', '--backend', 'cpu'];
    const exe = engine === 'nano' ? path.join(ROOT_DIR, '.funasr', 'bin-cpu', 'llama-funasr-cli.exe') : path.join(ROOT_DIR, '.funasr', 'bin-cpu', 'llama-funasr-sensevoice.exe');
    const res = spawnSync(exe, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
    const buf = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(String(res.stdout ?? ''));
    const text = (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
    fs.writeFileSync(srt, text, 'utf8');
    return { rows: parseSrt(text), wallSec: (Date.now() - t0) / 1000 };
  }
  return { rows: parseSrt(fs.readFileSync(srt, 'utf8')), wallSec: 0 };
}

const SPEECH_DB = -28;
interface M {
  name: string;
  cues: number;
  screenSec: number;
  screenPct: number;
  longCues: number;
  longestCue: number;
  longestHole: number;
  speechTotal: number;
  speechCovered: number;
  wrongTimeSec: number;
}

for (const clip of clipsJson.clips ?? []) {
  const len = clip.end - clip.start;
  console.log(`\n================ clip[${clip.index}] ${clip.start.toFixed(1)} → ${clip.end.toFixed(1)}（${len.toFixed(0)}s）================`);

  /* 云端：整场转写落在该窗口里的段落（转成切片内秒数） */
  const cloudSegs = allSegs
    .filter((s) => s.end > clip.start && s.start < clip.end)
    .map((s) => ({ start: Math.max(0, s.start - clip.start), end: Math.min(len, s.end - clip.start), text: s.text }));

  /* 本地：整片重识别（两个引擎各跑一遍） */
  const clipPath = clip.cutOutput!;
  const nanoRun = localAsr(clipPath, len, `clip${clip.index}`, 'nano');
  const localRun = localAsr(clipPath, len, `clip${clip.index}`, 'sv');
  const localSegs = localRun.rows.map((r) => ({ start: Math.max(0, r.start), end: Math.min(len, r.end), text: r.text }));
  const nanoSegs = nanoRun.rows.map((r) => ({ start: Math.max(0, r.start), end: Math.min(len, r.end), text: r.text }));

  /* 显示规则（与线上一致） */
  const display = (segs: Array<{ start: number; end: number; text: string }>) =>
    buildCues(segs, { maxCharsPerLine: 18, minDurationSec: 0.8, maxDurationSec: 8 }).cues;

  const cloudCues = display(cloudSegs);
  const localCues = display(localSegs);

  /* 响度剖面（以切片音频为准） */
  const profile = computeEnergyProfile(clipPath, { binSec: 1 });
  const isSpeech: boolean[] = [];
  for (let t = 0; t < Math.ceil(len); t++) {
    const i = Math.floor(t / (profile?.binSec ?? 1));
    const v = profile?.rms[i] ?? 0;
    isSpeech.push(20 * Math.log10(Math.max(1e-6, v)) >= SPEECH_DB);
  }

  const measure = (name: string, cues: Array<{ start: number; end: number; text: string }>): M => {
    const sorted = [...cues].sort((a, b) => a.start - b.start);
    const screen = sorted.reduce((a, c) => a + (c.end - c.start), 0);
    let longestHole = 0;
    let cursor = 0;
    for (const c of sorted) {
      if (c.start > cursor) longestHole = Math.max(longestHole, c.start - cursor);
      cursor = Math.max(cursor, c.end);
    }
    longestHole = Math.max(longestHole, len - cursor);
    const speech = isSpeech.map((v, t) => (v ? t : -1)).filter((t) => t >= 0);
    const covered = speech.filter((t) => sorted.some((c) => c.start <= t + 0.999 && c.end > t)).length;
    const wrongTime = isSpeech.map((v, t) => (!v && sorted.some((c) => c.start <= t + 0.999 && c.end > t) ? t : -1)).filter((t) => t >= 0).length;
    return {
      name,
      cues: sorted.length,
      screenSec: Number(screen.toFixed(1)),
      screenPct: Math.round((screen / len) * 100),
      longCues: sorted.filter((c) => c.end - c.start > 8 - 1e-6).length,
      longestCue: Number(Math.max(0, ...sorted.map((c) => c.end - c.start)).toFixed(1)),
      longestHole: Number(longestHole.toFixed(1)),
      speechTotal: speech.length,
      speechCovered: covered,
      wrongTimeSec: wrongTime,
    };
  };

  const mc = measure('纯云端', cloudCues);
  const ml = measure('形态A·本地SenseVoice', localCues);
  const mn = measure('形态A·本地Nano', display(nanoSegs));
  console.table([mc, ml, mn]);

  /* 位置被挪动的条数：把云端每条字幕按文本去本地结果里找同一个说话内容，比起点 */
  const norm = (s: string) => s.replace(/[\s，。！？、,.!?…~～"'"'（）()《》【】]/g, '');
  let moved = 0;
  const movedSamples: string[] = [];
  for (const c of cloudCues) {
    const key = norm(c.text).slice(0, 4);
    if (key.length < 2) continue;
    const hit = localCues.find((l) => norm(l.text).includes(key));
    if (!hit) continue;
    const d = hit.start - c.start;
    if (Math.abs(d) > 5) {
      moved++;
      if (movedSamples.length < 4) movedSamples.push(`「${c.text.slice(0, 18)}」${c.start.toFixed(0)}s → ${hit.start.toFixed(0)}s（挪 ${d > 0 ? '+' : ''}${d.toFixed(0)}s）`);
    }
  }
  console.log(`位置被明显挪动（>5s）的字幕：${moved} / ${cloudCues.length} 条`);
  for (const s of movedSamples) console.log(`   ${s}`);
  console.log(`本地整片重识别耗时：Nano ${nanoRun.wallSec ? nanoRun.wallSec.toFixed(1) + 's' : '(复用)'} / SenseVoice ${localRun.wallSec ? localRun.wallSec.toFixed(1) + 's' : '(复用)'} —— 音频 ${len.toFixed(0)}s`);

  /* 两路本地的"疑似幻觉"：非中文字符占比（音乐/噪音上本地模型会吐外语碎片） */
  for (const [nm, rows] of [
    ['SenseVoice', localSegs],
    ['Nano', nanoSegs],
  ] as const) {
    const all = rows.map((r) => r.text).join('');
    const cjk = (all.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const nonCjk = all.length - cjk;
    console.log(`  ${nm}：${all.length} 字，其中非中日韩字符 ${nonCjk} 个（${((nonCjk / Math.max(1, all.length)) * 100).toFixed(0)}%）`);
  }
}
