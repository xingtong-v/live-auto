/**
 * 受控实验：找出「切片后音画错位」到底是哪一步造成的，以及哪种参数组合能修好。
 *
 * 背景（实测）：源文件里音视频起点一致（1.433/1.433），
 * 但成片里视频起点比音频晚 1–3.7 秒 —— 声音比画面快，字幕跟画面走，于是"字幕和声音对不上"。
 * biliLive-tools 生成的命令是：
 *   ffmpeg -ss X -copyts -to Y -i src ... -ss X -c:a copy out.mp4
 * 我们只能控制 ffmpegOptions（预设 + 覆盖），所以要试出"在我们的控制范围内"能修好的组合。
 *
 * 零成本、不投稿：直接用 ffmpeg 切本地文件。
 * 用法：node tools/av-sync-experiment.ts [起点秒] [时长秒]
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findFfprobe } from '../src/media.ts';
import { ensureDir, exists, ROOT_DIR } from '../src/util.ts';

const ffprobe = findFfprobe() ?? 'ffprobe';
/** ffmpeg 与 ffprobe 成对安装：优先取 ffprobe 同目录，否则交给 PATH */
function findFfmpeg(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const probe = findFfprobe();
  if (probe) {
    const sameDir = path.join(path.dirname(probe), exe);
    if (exists(sameDir)) return sameDir;
  }
  return exe;
}
const ffmpeg = findFfmpeg();
const SRC = process.argv[4] ?? 'C:\\Users\\demo\\Downloads\\2026_9_21 20_50_02 场直播.ts';
const start = Number(process.argv[2] ?? 867.5);
const dur = Number(process.argv[3] ?? 20);
const end = start + dur;
const OUT = path.join(ROOT_DIR, 'data', 'subtitle-check', 'synctest');
ensureDir(OUT);

if (!exists(SRC)) {
  console.log(`源文件不在：${SRC}`);
  process.exit(1);
}

function probe(file: string): { vs: number; as: number; dur: number } {
  const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
    timeout: 60000,
  });
  let vs = NaN;
  let as = NaN;
  for (const line of out.split(/\r?\n/)) {
    const [t, v] = line.split(',');
    if (t === 'video' && !Number.isFinite(vs)) vs = Number(v);
    if (t === 'audio' && !Number.isFinite(as)) as = Number(v);
  }
  const d = Number(
    execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim(),
  );
  return { vs, as, dur: d };
}

/** 找离 target 最近的关键帧（前后都要） */
function nearestKeyframes(target: number): { before: number; after: number } {
  try {
    const out = execFileSync(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v',
        '-show_entries', 'packet=pts_time,flags',
        '-of', 'csv=p=0',
        '-read_intervals', `${Math.max(0, target - 12)}%+24`,
        SRC,
      ],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
    );
    const keys: number[] = [];
    for (const line of out.split(/\r?\n/)) {
      const [pts, flags] = line.split(',');
      if (!flags || !flags.includes('K')) continue;
      const t = Number(pts);
      if (Number.isFinite(t) && t > 0) keys.push(t);
    }
    const before = keys.filter((k) => k <= target).at(-1) ?? NaN;
    const after = keys.find((k) => k > target) ?? NaN;
    return { before, after };
  } catch {
    return { before: NaN, after: NaN };
  }
}

interface Variant {
  name: string;
  note: string;
  args: string[];
}

const kf = nearestKeyframes(start);
console.log(`源文件：${path.basename(SRC)}`);
console.log(`请求区间：${start}s – ${end}s（${dur}s）`);
console.log(`该处关键帧：前 ${Number.isFinite(kf.before) ? kf.before.toFixed(3) : '?'}s / 后 ${Number.isFinite(kf.after) ? kf.after.toFixed(3) : '?'}s`);
console.log('（视频只能从关键帧开始解码；音频可以从任意点切 —— 这就是错位的来源）\n');

const common = ['-y', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast'];
const variants: Variant[] = [
  {
    name: 'A 复刻现状',
    note: '-ss X -copyts -to Y + 音频流拷贝（biliLive-tools 现在的做法）',
    args: ['-ss', String(start), '-copyts', '-to', String(end), '-i', SRC, ...common, '-ss', String(start), '-c:a', 'copy'],
  },
  {
    name: 'B 音频重编码',
    note: '同上，但 -c:a aac（让 ffmpeg 重新对齐音频时间戳）',
    args: ['-ss', String(start), '-copyts', '-to', String(end), '-i', SRC, ...common, '-ss', String(start), '-c:a', 'aac', '-b:a', '192k'],
  },
  {
    name: 'C 不用 copyts',
    note: '去掉 -copyts：输出时间轴从 0 开始，两条流同时起（但 ASS 绝对时间戳会失效）',
    args: ['-ss', String(start), '-to', String(end), '-i', SRC, ...common, '-c:a', 'aac', '-b:a', '192k'],
  },
  {
    name: 'D 起点对齐关键帧 + 音频重编码',
    note: Number.isFinite(kf.before) ? `-ss ${kf.before.toFixed(3)}（关键帧）` : '关键帧探测失败，跳过',
    args: Number.isFinite(kf.before)
      ? ['-ss', String(kf.before), '-copyts', '-to', String(end), '-i', SRC, ...common, '-ss', String(kf.before), '-c:a', 'aac', '-b:a', '192k']
      : [],
  },
];

console.log('变体'.padEnd(30) + '视频起点'.padEnd(12) + '音频起点'.padEnd(12) + 'Δ(视频−音频)'.padEnd(16) + '时长');
console.log('─'.repeat(92));
for (const v of variants) {
  if (v.args.length === 0) {
    console.log(`${v.name.padEnd(28)}  跳过（${v.note}）`);
    continue;
  }
  const out = path.join(OUT, `${v.name.slice(0, 1)}-${start}.mp4`);
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-nostdin', ...v.args, out], { stdio: 'ignore', timeout: 600000 });
  } catch (e) {
    console.log(`${v.name.padEnd(28)}  失败：${(e as Error).message.slice(0, 50)}`);
    continue;
  }
  const p = probe(out);
  const delta = p.vs - p.as;
  const verdict = Math.abs(delta) <= 0.15 ? '\x1b[32m同步\x1b[0m' : `\x1b[31m错位 ${delta.toFixed(3)}s\x1b[0m`;
  console.log(
    `${v.name.padEnd(28)}  ${p.vs.toFixed(3).padEnd(12)}${p.as.toFixed(3).padEnd(12)}${delta.toFixed(3).padEnd(10)}  ${p.dur.toFixed(1)}s  ${verdict}`,
  );
  console.log(`\x1b[90m    ${v.note}\x1b[0m`);
}
console.log(`\n产物在 ${path.relative(ROOT_DIR, OUT)}，可直接播放确认听感。`);
