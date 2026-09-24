/**
 * 音视频对齐修复的单元验证（用真 ffmpeg，零网络、零费用）。
 *
 * 为什么不能只 mock：这个功能的价值全在"真的把文件改成对齐了"。
 * 所以这里用 ffmpeg 造一个**故意错位**的小文件（视频在后、音频在前），
 * 跑 ensureAvSync，再用 ffprobe 独立断言两条流的起点确实对齐了。
 *
 * 覆盖四个真实场景：
 *  1. 音频在前（实测最常见：录播切片 Δ≈+3.5s）→ 应修复；
 *  2. 视频在前（反向）→ 也应修复；
 *  3. 本来就同步 → 不应改动文件（不能白重挂，否则每次切片都多一次拷贝）；
 *  4. 只有视频没有音频 → 跳过而不是报错（无声素材不该挡住出片）。
 *
 * 用法：node test/av-sync.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureAvSync, findFfmpeg, probeStreamStarts } from '../src/av-sync.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string, extra?: string): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
  }
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}
function eq<T>(msg: string, actual: T, expected: T): void {
  ok(actual === expected, msg, actual === expected ? undefined : `期望 ${String(expected)}，实际 ${String(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const ffmpeg = findFfmpeg();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-avsync-'));

function ff(args: string[]): void {
  execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args], { stdio: 'ignore', timeout: 120000 });
}

/** 造一段 4 秒的测试素材（视频 + 正弦音频），两条流起点一致 */
function makeBase(out: string): void {
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
  ]);
}

/**
 * 造出"音频比画面早 sec 秒"的素材 —— 也就是**实测录播切片的方向**。
 * 做法：把视频整体后移 sec 秒，于是 videoStart − audioStart = +sec。
 */
function makeAudioEarlier(src: string, out: string, sec: number): void {
  ff([
    '-itsoffset', String(sec), '-i', src,
    '-i', src,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy', '-avoid_negative_ts', 'make_zero', out,
  ]);
}

/** 反向：把音频整体后移 sec 秒 → Δ = videoStart − audioStart = −sec */
function makeVideoEarlier(src: string, out: string, sec: number): void {
  ff([
    '-i', src,
    '-itsoffset', String(sec), '-i', src,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy', '-avoid_negative_ts', 'make_zero', out,
  ]);
}

async function main(): Promise<void> {
  console.log('\x1b[1m音画对齐修复验证\x1b[0m（真 ffmpeg，零网络、零费用）');
  console.log('─'.repeat(74));

  const base = path.join(tmpRoot, 'base.mp4');
  makeBase(base);
  const baseStarts = await probeStreamStarts(base);
  section('0. 基准素材');
  ok(baseStarts.videoStart !== undefined && baseStarts.audioStart !== undefined, '造出带视频+音频的素材', JSON.stringify(baseStarts));
  ok(
    Math.abs((baseStarts.videoStart ?? 0) - (baseStarts.audioStart ?? 0)) <= 0.15,
    '基准素材本身是同步的',
    `Δ=${((baseStarts.videoStart ?? 0) - (baseStarts.audioStart ?? 0)).toFixed(3)}s`,
  );

  /* ---- 1. 音频在前：实测场景 ---- */
  section('1. 音频比画面早（实测录播切片就是这个方向：Δ=+3.561s）');
  const aFirst = path.join(tmpRoot, 'audio-first.mp4');
  makeAudioEarlier(base, aFirst, 3.5);
  const s1 = await probeStreamStarts(aFirst);
  const d1 = (s1.videoStart ?? 0) - (s1.audioStart ?? 0);
  ok(d1 > 3 && d1 < 4, '构造出音频在前的错位素材', `Δ=${d1.toFixed(3)}s`);
  const r1 = await ensureAvSync(aFirst, { toleranceSec: 0.15 });
  ok(r1.repaired, '识别并修复了错位', JSON.stringify({ delta: r1.deltaSec, after: r1.deltaAfterSec }));
  const a1 = await probeStreamStarts(aFirst);
  const d1b = (a1.videoStart ?? 0) - (a1.audioStart ?? 0);
  ok(Math.abs(d1b) <= 0.15, '修复后两条流起点对齐', `Δ=${d1b.toFixed(3)}s`);
  ok(fs.existsSync(aFirst) && fs.statSync(aFirst).size > 0, '成片仍在原路径（投稿用的是这个路径）');
  ok(!fs.existsSync(`${aFirst}.avsync.mp4`), '临时文件已清理');
  /* 画面必须一个像素都没动：视频流时长变化应当在 1 帧以内 */
  const durOf = (f: string): number =>
    Number(execFileSync(ffmpeg.includes(path.sep) ? `${path.join(path.dirname(ffmpeg), 'ffprobe.exe')}` : 'ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=duration', '-of', 'csv=p=0', f], { encoding: 'utf8', timeout: 60000 }).trim());
  ok(Math.abs(durOf(aFirst) - durOf(base)) < 0.2, '修复没有改变视频流时长（纯重挂，不重编码）', `${durOf(base).toFixed(2)}s → ${durOf(aFirst).toFixed(2)}s`);

  /* ---- 2. 视频在前 ---- */
  section('2. 反向：画面比声音早');
  const vFirst = path.join(tmpRoot, 'video-first.mp4');
  makeVideoEarlier(base, vFirst, 2.0);
  const s2 = await probeStreamStarts(vFirst);
  const d2 = (s2.videoStart ?? 0) - (s2.audioStart ?? 0);
  ok(d2 < -1, '构造出反向错位素材', `Δ=${d2.toFixed(3)}s`);
  const r2 = await ensureAvSync(vFirst, { toleranceSec: 0.15 });
  ok(r2.repaired, '反向错位同样被修复');
  const s2b = await probeStreamStarts(vFirst);
  ok(Math.abs((s2b.videoStart ?? 0) - (s2b.audioStart ?? 0)) <= 0.15, '修复后对齐', `Δ=${((s2b.videoStart ?? 0) - (s2b.audioStart ?? 0)).toFixed(3)}s`);

  /* ---- 3. 本来就同步：不能白改 ---- */
  section('3. 本来就同步的文件');
  const good = path.join(tmpRoot, 'good.mp4');
  fs.copyFileSync(base, good);
  const beforeSize = fs.statSync(good).size;
  const beforeMtime = fs.statSync(good).mtimeMs;
  const r3 = await ensureAvSync(good, { toleranceSec: 0.15 });
  ok(!r3.repaired, '没有执行修复（避免每次切片白拷一份）', `Δ=${r3.deltaSec.toFixed(3)}s`);
  ok(fs.statSync(good).size === beforeSize && fs.statSync(good).mtimeMs === beforeMtime, '文件未被改动（大小与修改时间都没变）');

  /* ---- 4. 关掉开关 ---- */
  section('4. 配置关闭时');
  const off = path.join(tmpRoot, 'off.mp4');
  makeAudioEarlier(base, off, 3.5);
  const r4 = await ensureAvSync(off, { enabled: false });
  eq('开关关闭时不修复', r4.repaired, false);
  const s4 = await probeStreamStarts(off);
  ok(Math.abs((s4.videoStart ?? 0) - (s4.audioStart ?? 0)) > 3, '文件保持原样');

  /* ---- 5. 无声素材：跳过而不是报错 ---- */
  section('5. 只有视频没有音频');
  const silent = path.join(tmpRoot, 'silent.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent]);
  const r5 = await ensureAvSync(silent, { toleranceSec: 0.15 });
  ok(!r5.repaired && Boolean(r5.warning), '跳过并给出原因，不抛异常', r5.warning);

  /* ---- 6. 容差 ---- */
  section('6. 容差边界');
  const small = path.join(tmpRoot, 'small.mp4');
  makeAudioEarlier(base, small, 0.08);
  const r6 = await ensureAvSync(small, { toleranceSec: 0.15 });
  ok(!r6.repaired, '小于容差的抖动不做修复', `Δ=${r6.deltaSec.toFixed(3)}s`);

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\x1b[31m验证异常：\x1b[0m', e instanceof Error ? e.message : e);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
