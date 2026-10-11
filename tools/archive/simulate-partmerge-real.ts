/**
 * 修正版分场模拟：用**真实文件时长**算出 `findRecentLive` 真正用的「间隙」。
 *
 * ## 我此前错在哪
 * `findRecentLive` 的判据是：
 *     (currentTime - live.getMaxEndTime()) / 60000 < maxTimeDiffMinutes
 * 其中 `live.getMaxEndTime()` 是**前一个分段结束写入的时刻**（≈ 前段开始 + 前段时长）。
 * 所以我该算的是「前段**结束** → 新段**开始**」的间隙，
 * 而我却用了「前段**开始** → 新段**开始**」的间隔（≈ 59 分钟 = 一个分段长度），
 * 把「文件时长」也算成了「间隙」，于是凭空得出「被劈成 7 个稿件」的错误结论。
 *
 * 对本机 09-22 那场：段1 是 59.0 分钟的文件，20:08:55 开始 ⇒ 21:07:55 结束，
 * 而段2 21:07:58 开始 ⇒ **真实间隙只有约 3 秒**，远小于阈值 ⇒ 正确归为同一场。
 * 这与 B站 侧事实一致（那场只有 1 个稿件，370 分钟）。
 *
 * 用法：node --experimental-strip-types tools/simulate-partmerge-real.ts [阈值分钟...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FFPROBE = 'C:\\Users\\demo\\tools\\ffmpeg\\bin\\ffprobe.exe';
const WATCH = 'C:\\Users\\demo\\Downloads\\Bilibili';
const MIN_SIZE_MB = 20;
const LIST = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const THRESHOLDS = LIST.length ? LIST : [10, 30, 75];

function parseStamp(fileName: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})-(\d{3})/.exec(fileName);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
}

function durationSec(file: string): number {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

for (const sub of fs.readdirSync(WATCH, { withFileTypes: true })) {
  if (!sub.isDirectory()) continue;
  const dir = path.join(WATCH, sub.name);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(flv|mp4|ts|mkv)$/i.test(f) && !/-弹幕版|-纯享版/.test(f))
    .map((f) => ({ f, t: parseStamp(f), size: fs.statSync(path.join(dir, f)).size }))
    .filter((x): x is { f: string; t: Date; size: number } => x.t !== null && x.size / 1048576 >= MIN_SIZE_MB)
    .sort((a, b) => a.t.getTime() - b.t.getTime());
  if (files.length < 2) continue;

  const byDay = new Map<string, Array<{ f: string; t: Date; size: number }>>();
  for (const x of files) {
    const day = `${x.t.getFullYear()}-${x.t.getMonth() + 1}-${x.t.getDate()}`;
    const arr = byDay.get(day) ?? [];
    arr.push(x);
    byDay.set(day, arr);
  }

  console.log('\n' + '='.repeat(100));
  console.log(`${sub.name}（minSize=${MIN_SIZE_MB}MB 过滤后 ${files.length} 个文件）`);
  console.log('='.repeat(100));

  for (const [day, arr] of [...byDay.entries()].sort()) {
    if (arr.length < 2) continue;
    console.log(`\n  【${day}】${arr.length} 个文件`);
    /* 真实间隙 = 新段开始 - 前段结束（前段结束 = 开始 + 时长） */
    const gaps: number[] = [];
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]!;
      const cur = arr[i]!;
      const prevDur = durationSec(path.join(dir, prev.f));
      const prevEnd = prev.t.getTime() + prevDur * 1000;
      const gapMin = (cur.t.getTime() - prevEnd) / 60000;
      gaps.push(gapMin);
      /* 同时给出"开始→开始"的间隔，好和错误算法对照 */
      const naive = (cur.t.getTime() - prev.t.getTime()) / 60000;
      console.log(
        `      前段 ${(prevDur / 60).toFixed(1).padStart(6)} 分钟  ${prev.t.toTimeString().slice(0, 8)}→` +
          `${new Date(prevEnd).toTimeString().slice(0, 8)}   新段 ${cur.t.toTimeString().slice(0, 8)}` +
          `   真实间隙 ${gapMin.toFixed(1).padStart(7)} 分钟   （开始→开始 ${naive.toFixed(1)} 分钟）`,
      );
    }
    console.log('      ' + '-'.repeat(86));
    for (const th of THRESHOLDS) {
      const lives = gaps.filter((g) => g > th).length + 1;
      const mark = lives === 1 ? '\x1b[32m1 场 = 1 个稿件 ✓\x1b[0m' : `\x1b[33m${lives} 场 ⇒ ${lives} 个稿件\x1b[0m`;
      console.log(`      阈值 ${String(th).padStart(3)} 分钟 → ${lives} 场   ${mark}`);
    }
  }
}

console.log('\n' + '='.repeat(100));
console.log('对照 B站 侧事实');
console.log('='.repeat(100));
console.log('  09-22 那场实际只有 **1 个稿件**（aid=117314833877723，370 分钟，公开）');
console.log('  ⇒ 真实间隙都远小于阈值，biliLive-tools 的合并逻辑一直是正常的');
console.log('  ⇒ 我此前用「开始→开始」的间隔（≈59 分钟）当间隙，才误判成 7 个稿件');
