/**
 * 为一个**手头已有的录播文件**生成「完整弹幕版」—— 把弹幕 + 字幕烧进整段视频。
 *
 * 为什么需要它：项目的「完整版」本应由 biliLive-tools 的 webhook 流水线产出
 * （`source.fullVideoPath`），但 `webhook.open=false` 时那条流水线不会跑，
 * 于是只有一个裸 flv + 一个 xml。而"一场直播 = 一个稿件 = 完整弹幕版 + 纯享版 + N 个切片"
 * 这个交付形态要求 P1 是**带弹幕的完整版**。
 *
 * 本工具复用项目自己的两条链路，保证与切片烧录**同一套渲染逻辑**（不是另写一份）：
 *   1. `convertDanmakuToAss()` —— xml → ASS（与切片用的是同一个函数）
 *   2. `buildBurnAss()`      —— 弹幕 ASS + 转写字幕 → 合并成一个 ASS
 *   3. ffmpeg `subtitles=` 滤镜 + **硬件编码**（h264_nvenc，30 分钟 1080p60 几分钟就能烧完）
 *
 * 产物固定放到 `<任务目录>/full/p1-<名字>-弹幕版.mp4`，这样
 * `publishMultiPartStage` 的 `findInFull()` / `task.source.fullVideoPath` 能直接捡到。
 *
 * 用法：
 *   node --experimental-strip-types tools/make-full-danmaku.ts <taskId> [--encoder h264_nvenc|libx264]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { convertDanmakuToAss, findDanmakuFactory } from '../src/danmaku-ass.ts';
import { buildBurnAss } from '../src/subtitle-ass.ts';
import { log as globalLog } from '../src/logger.ts';
import { fmtBytes, fmtDuration, readJson } from '../src/util.ts';
import type { Transcript } from '../src/types.ts';

const taskId = process.argv[2];
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/make-full-danmaku.ts <taskId> [--encoder h264_nvenc]');
  process.exit(1);
}
const encIdx = process.argv.indexOf('--encoder');
const encoder = encIdx > 0 ? String(process.argv[encIdx + 1]) : 'h264_nvenc';

const cfg = loadConfig('config.json').config;
const ledger = new Ledger({ path: path.join('data', 'ledger.json'), logger: globalLog });
const task = ledger.getTask(taskId);
if (!task) {
  console.error(`任务不存在：${taskId}`);
  process.exit(1);
}

const src = task.source.rawFiles[0];
if (!src || !fs.existsSync(src)) {
  console.error(`源文件不存在：${String(src)}`);
  process.exit(1);
}
const xml = task.source.danmaXmlPath;
const taskDir = ledger.taskDir(taskId);
const fullDir = path.join(taskDir, 'full');
fs.mkdirSync(fullDir, { recursive: true });

console.log('='.repeat(92));
console.log('生成「完整弹幕版」');
console.log('='.repeat(92));
console.log(`  任务   : ${taskId}`);
console.log(`  源文件 : ${path.basename(src)}（${fmtBytes(fs.statSync(src).size)}）`);
console.log(`  弹幕   : ${xml && fs.existsSync(xml) ? path.basename(xml) : '(无 → 只烧字幕)'}`);
console.log(`  编码器 : ${encoder}`);
console.log('');

/* ---- 1) 弹幕 XML → ASS ---- */
let danmakuAss: string | undefined;
if (xml && fs.existsSync(xml)) {
  const assOut = path.join(taskDir, 'full-danmaku.ass');
  const conv = await convertDanmakuToAss({
    taskId,
    videoPath: src,
    xmlPath: xml,
    assOut,
    factoryPath: findDanmakuFactory(cfg.danmaku.factoryPath),
    ...(cfg.danmaku.fontSize ? { fontSize: cfg.danmaku.fontSize } : {}),
    logger: globalLog,
  });
  for (const w of conv.warnings) console.log(`  ⚠ ${w}`);
  if (conv.assPath && conv.dialogueCount > 0) {
    danmakuAss = conv.assPath;
    console.log(`  ① 弹幕 ASS：${conv.dialogueCount}/${conv.xmlCount} 条（方式 ${conv.method}）`);
  } else {
    console.log('  ① 弹幕 ASS 未产出，将只烧字幕');
  }
} else {
  console.log('  ① 无弹幕文件，跳过弹幕 ASS');
}

/* ---- 2) 合并转写字幕 ---- */
const transcriptPath = ledger.taskFile(taskId, 'transcript.json');
let mergedAss: string | undefined;
if (fs.existsSync(transcriptPath)) {
  const transcript = readJson<Transcript>(transcriptPath);
  const burn = buildBurnAss({
    outDir: taskDir,
    ...(danmakuAss ? { danmakuAssPath: danmakuAss } : {}),
    segments: transcript.segments,
    videoPath: src,
    render: {
      ...(cfg.clip.subtitle.fontSize ? { fontSize: cfg.clip.subtitle.fontSize } : {}),
      ...(cfg.clip.subtitle.marginV ? { marginV: cfg.clip.subtitle.marginV } : {}),
      maxCharsPerLine: cfg.clip.subtitle.maxCharsPerLine,
      minDurationSec: cfg.clip.subtitle.minDurationSec,
      readingCharsPerSec: cfg.clip.subtitle.readingCharsPerSec,
      fontName: cfg.clip.subtitle.fontName,
    },
    logger: globalLog,
  });
  for (const w of burn.warnings) console.log(`  ⚠ ${w}`);
  if (burn.assPath) {
    mergedAss = burn.assPath;
    console.log(`  ② 合并 ASS：${transcript.segments.length} 条字幕${danmakuAss ? ' + 弹幕' : ''}`);
  }
} else {
  console.log(`  ② 没有 transcript.json（先跑转写才有字幕）—— 本片只烧弹幕`);
  mergedAss = danmakuAss;
}

if (!mergedAss || !fs.existsSync(mergedAss)) {
  console.error('没有可烧录的 ASS，退出。');
  process.exit(1);
}

/* ---- 3) ffmpeg 烧录整段（硬件编码）---- */
const safeName = path.basename(src, path.extname(src)).replace(/[<>:"/\\|?*]/g, '_');
const outPath = path.join(fullDir, `p1-${safeName}-弹幕版.mp4`);

/* subtitles 滤镜里路径要转义：Windows 反斜杠 + 冒号在 filter 语法里有特殊含义。
   标准做法：反斜杠写成 `/`、盘符冒号写成 `\:`，整体用单引号包住。 */
const filterPath = mergedAss.replace(/\\/g, '/').replace(/:/g, '\\:');
const vf = `subtitles='${filterPath}'`;

const vCodecArgs =
  encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];

console.log('');
console.log(`  ③ ffmpeg 烧录 → ${path.basename(outPath)}`);
console.log(`     vf = ${vf.slice(0, 120)}`);
const t0 = Date.now();
try {
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-stats', '-y', '-i', src, '-vf', vf, ...vCodecArgs, '-c:a', 'copy', '-movflags', '+faststart', outPath],
    { stdio: 'inherit' },
  );
} catch (e) {
  console.error(`ffmpeg 失败：${(e as Error).message}`);
  process.exit(1);
}
const elapsed = (Date.now() - t0) / 1000;
if (!fs.existsSync(outPath)) {
  console.error('ffmpeg 结束但没有产出文件');
  process.exit(1);
}
console.log(`  ✓ 完成：${path.basename(outPath)}（${fmtBytes(fs.statSync(outPath).size)}，耗时 ${elapsed.toFixed(0)}s）`);

/* ---- 4) 同时准备纯享版（无弹幕原片，流拷贝快速封装成 mp4）---- */
const purePath = path.join(fullDir, 'p2-纯享版.mp4');
console.log('');
console.log(`  ④ 纯享版（流拷贝）→ ${path.basename(purePath)}`);
try {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c', 'copy', '-movflags', '+faststart', purePath], {
    stdio: 'inherit',
  });
  console.log(`  ✓ 完成：${path.basename(purePath)}（${fmtBytes(fs.statSync(purePath).size)}）`);
} catch (e) {
  console.log(`  ⚠ 纯享版封装失败（不影响弹幕版）：${(e as Error).message.slice(0, 80)}`);
}

console.log('');
console.log('='.repeat(92));
console.log('产物（publishMultiPartStage 会从这里捡 P1/P2）');
console.log('='.repeat(92));
for (const f of fs.readdirSync(fullDir)) {
  const p = path.join(fullDir, f);
  console.log(`  ${f}  ${fmtBytes(fs.statSync(p).size)}`);
}
console.log(`  目录：${fullDir}`);
console.log('');
console.log(`  提示：把 P1 写回台账后，项目投多分P 时会自动带上它：`);
console.log(`    ledger.updateTask('${taskId}', { source: { ...source, fullVideoPath: '${outPath.replace(/\\/g, '\\\\')}' } })`);
console.log(`  总时长参考：源 ${fs.existsSync(src) ? fmtDuration(0) : ''}`);
