/**
 * 成片字幕核对：从**已经切好并投稿过的那条成片**里抽帧，
 * 与生产 ASS 在对应时间点应该显示的字幕一一对照。
 *
 * 为什么必须看成片：前面每一步（cues → ASS 文本 → ffmpeg 烧录 → 切片时间轴对齐）
 * 都有各自的坑，任何一步错位都表现为"字幕和声音对不上"。
 * 只有把帧抽出来、肉眼看到那一刻的字幕，才算真的验证过。
 *
 * 只读 + 抽帧到 data/subtitle-check/，不投稿、不改动成片。
 *
 * 用法：node tools/clip-subtitle-verify.ts [taskId] [clipIndex]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Ledger } from '../src/ledger.ts';
import { findFfprobe } from '../src/media.ts';
import { exists, ROOT_DIR } from '../src/util.ts';

const OUT_DIR = path.join(ROOT_DIR, 'data', 'subtitle-check');

function findFfmpeg(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const probe = findFfprobe();
  if (probe) {
    const sameDir = path.join(path.dirname(probe), exe);
    if (exists(sameDir)) return sameDir;
  }
  return exe;
}

const ledger = new Ledger();
const taskId = process.argv[2] ?? ledger.listTasks({ limit: 50 })[0]?.id;
const clipIndex = Number(process.argv[3] ?? 0);
if (!taskId) {
  console.log('没有任务');
  process.exit(1);
}
const task = ledger.getTask(taskId);
if (!task) {
  console.log(`任务不存在：${taskId}`);
  process.exit(1);
}
const clip = task.clips?.[clipIndex];
if (!clip) {
  console.log(`没有第 ${clipIndex} 个切片`);
  process.exit(1);
}

/* ---- 找成片文件 ---- */
const clipDir = path.join(ROOT_DIR, 'data', 'clips', taskId);
const mp4s = exists(clipDir) ? fs.readdirSync(clipDir).filter((f) => f.endsWith('.mp4')) : [];
const target = mp4s.find((f) => f.includes(String(clipIndex + 1).padStart(2, '0'))) ?? mp4s[0];
if (!target) {
  console.log(`成片不在 data/clips/${taskId}（可能已被清理）`);
  process.exit(1);
}
const clipPath = path.join(clipDir, target);
console.log(`\x1b[1m成片字幕核对\x1b[0m  ${taskId} #${clipIndex}`);
console.log(`  成片：${target}（${(fs.statSync(clipPath).size / 1024 ** 2).toFixed(1)} MB）`);

/* ---- 成片时长 ---- */
const ffprobe = findFfprobe() ?? 'ffprobe';
const dur = Number(
  execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipPath], { encoding: 'utf8' }).trim(),
);
console.log(`  时长：${dur.toFixed(1)}s`);
if (!Number.isFinite(dur) || dur <= 0) process.exit(1);

/* ---- 读生产 ASS ---- */
const taskDir = ledger.taskDir(taskId);
const assFiles = fs.readdirSync(taskDir).filter((f) => /^subtitle-.*\.ass$/.test(f));
if (assFiles.length === 0) {
  console.log('  目录里没有 ASS，无法核对');
  process.exit(1);
}
const assPath = path.join(taskDir, assFiles.sort().at(-1)!);
const toSec = (t: string): number => {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(t.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : NaN;
};
interface Cue {
  start: number;
  end: number;
  text: string;
}
const cues: Cue[] = [];
for (const line of fs.readFileSync(assPath, 'utf8').split(/\r?\n/)) {
  if (!line.startsWith('Dialogue:')) continue;
  const head = line.slice('Dialogue:'.length).split(',', 10);
  if ((head[3] ?? '').trim() !== 'Subtitle') continue;
  cues.push({ start: toSec(head[1] ?? ''), end: toSec(head[2] ?? ''), text: head[9] ?? '' });
}
/* 成片是从源视频的某个时刻切出来的：ASS 用源时间轴，成片用 0 起的时间轴。
   于是"成片第 t 秒"对应"源视频 offset + t 秒"。offset 从任务的切片记录里取。 */
const offset = Number(clip.start ?? 0);
console.log(`  切片起点：源视频第 ${offset}s（ASS 时间轴）；成片时间轴 = ASS 时间轴 − ${offset}s`);
const inClip = cues.filter((c) => c.end > offset && c.start < offset + dur);
console.log(`  落在成片里的字幕：${inClip.length} 条`);

/* ---- 抽帧：挑几条字幕的"中间时刻"抽，字幕应当正好显示 ---- */
fs.mkdirSync(OUT_DIR, { recursive: true });
const ffmpeg = findFfmpeg();
const picks = [0.15, 0.4, 0.65, 0.88].map((f) => Math.floor(inClip.length * f)).filter((i, k, a) => i < inClip.length && a.indexOf(i) === k);
console.log(`\n\x1b[1m抽帧对照\x1b[0m（帧上的字幕应当与下表一致）：`);
for (const i of picks) {
  const c = inClip[i]!;
  const tClip = (c.start + c.end) / 2 - offset;
  if (tClip <= 0 || tClip >= dur) continue;
  const out = path.join(OUT_DIR, `clip${clipIndex}-frame-${tClip.toFixed(1).replace('.', '_')}s.png`);
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', tClip.toFixed(2), '-i', clipPath, '-frames:v', '1', out], {
      stdio: 'ignore',
      timeout: 60000,
    });
  } catch {
    console.log(`  \x1b[33m⚠ 抽帧失败 @${tClip.toFixed(1)}s\x1b[0m`);
    continue;
  }
  console.log(`  \x1b[90m成片 ${tClip.toFixed(1).padStart(6)}s\x1b[0m（源 ${c.start.toFixed(1)}–${c.end.toFixed(1)}s）→ ${path.relative(ROOT_DIR, out)}`);
  console.log(`      应当显示：\x1b[1m${c.text}\x1b[0m`);
}
console.log('\n打开上面的 PNG 核对：帧上的字幕文字应与「应当显示」完全一致，且能被弹幕压住时仍读得清。');
