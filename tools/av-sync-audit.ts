/**
 * 成片音视频起点的系统性检查。
 *
 * 为什么单独查这个：字幕是按**视频帧的 PTS** 烧的，画面比声音晚多少，字幕就跟着晚多少。
 * 用户报「字幕和声音对不上」，最可能的根因不是字幕生成，而是切片那一步把音视频错开了。
 * 容器里的 start_time 是权威证据：两条流的起点必须一致（源文件里就是一致的）。
 *
 * 只读。用法：node tools/av-sync-audit.ts [目录...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findFfprobe } from '../src/media.ts';
import { ROOT_DIR } from '../src/util.ts';

const ffprobe = findFfprobe() ?? 'ffprobe';

interface Row {
  file: string;
  vs: number;
  as: number;
  delta: number;
  dur: number;
}

function probeStart(file: string): { vs: number; as: number } {
  const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
    timeout: 60000,
  });
  let vs = NaN;
  let as = NaN;
  for (const line of out.split(/\r?\n/)) {
    const [type, st] = line.split(',');
    if (type === 'video' && !Number.isFinite(vs)) vs = Number(st);
    if (type === 'audio' && !Number.isFinite(as)) as = Number(st);
  }
  return { vs, as };
}

function probeDuration(file: string): number {
  try {
    return Number(
      execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
        encoding: 'utf8',
        timeout: 60000,
      }).trim(),
    );
  } catch {
    return NaN;
  }
}

/** 递归收集 mp4/ts/flv，跳过源录播（只关心我们切出来的成片） */
function collect(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, out, depth + 1);
    else if (/\.(mp4|mkv|flv)$/i.test(e.name)) out.push(full);
  }
  return out;
}

const roots = process.argv.slice(2);
const searchDirs = roots.length
  ? roots
  : [path.join(ROOT_DIR, 'data', 'clips'), path.join(ROOT_DIR, 'data', 'trash'), path.join(ROOT_DIR, 'data', 'subtitle-check')];

const files: string[] = [];
for (const d of searchDirs) collect(d, files);
console.log(`\x1b[1m成片音视频起点审计\x1b[0m  共 ${files.length} 个文件`);
console.log('（播放器按 PTS 对齐两条流：音频起点比视频早 Δ 秒，就是"声音比画面快 Δ 秒"）\n');

const rows: Row[] = [];
for (const f of files) {
  try {
    const { vs, as } = probeStart(f);
    if (!Number.isFinite(vs) || !Number.isFinite(as)) continue;
    rows.push({ file: path.relative(ROOT_DIR, f), vs, as, delta: vs - as, dur: probeDuration(f) });
  } catch {
    /* 单文件探测失败不影响整体结论 */
  }
}

rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
let bad = 0;
for (const r of rows) {
  const flag = Math.abs(r.delta) > 0.5 ? '\x1b[31m✗ 音画错位\x1b[0m' : '\x1b[32m✓ 同步\x1b[0m';
  if (Math.abs(r.delta) > 0.5) bad++;
  const name = r.file.length > 58 ? '…' + r.file.slice(-57) : r.file;
  console.log(`  ${flag}  Δ=${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(3)}s  (视频 ${r.vs.toFixed(3)} / 音频 ${r.as.toFixed(3)}, 时长 ${Number.isFinite(r.dur) ? r.dur.toFixed(1) : '?'}s)  ${name}`);
}
console.log(`\n合计：${rows.length} 个成片，其中 \x1b[1m${bad}\x1b[0m 个音画错位超过 0.5 秒`);
if (rows.length && bad === rows.length) {
  console.log('\x1b[33m全部错位 → 是切片命令的系统性问题（-c:a copy + 关键帧吸附），不是个别素材的问题。\x1b[0m');
}
