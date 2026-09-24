/**
 * 真实素材验证「字幕烧录」：用真源视频 + 真弹幕 + 真转写做一次真切片，再抽帧给人眼看。
 *
 * 为什么必须做这一步：单元测试只能证明 ASS 文本拼对了，证明不了
 * 「ffmpeg 真能把中文字幕烧进画面」—— 字体缺字、字号太小、位置被弹幕压住，
 * 这些都只有看到画面才知道。
 *
 * **不投稿**：只调 biliLive-tools 的 `/task/cut` 出一条本地成片，绝不碰 `/bili/upload`。
 * 走的是与生产完全相同的 API 客户端与同一份 ffmpeg 预设，因此切片行为一致。
 *
 * 用法：node tools/subtitle-burn-check.ts [taskId] [开始秒] [时长秒]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Ledger } from '../src/ledger.ts';
import { loadConfig } from '../src/config.ts';
import { buildFfmpegOptions, pickSourceForCut } from '../src/publish.ts';
import { buildBurnAss, widthOfText } from '../src/subtitle-ass.ts';
import { convertDanmakuToAss, findDanmakuFactory } from '../src/danmaku-ass.ts';
import { BiliLiveClient } from '../src/api.ts';
import { findFfprobe } from '../src/media.ts';
import { ensureDir, exists, readJson, sleep, ROOT_DIR } from '../src/util.ts';
import { log } from '../src/logger.ts';
import type { FfmpegPreset, Transcript } from '../src/types.ts';

const OUT_DIR = path.join(ROOT_DIR, 'data', 'subtitle-check');

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string, extra?: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${extra ? `  ${extra}` : ''}`);
}

/** 找 ffmpeg：优先 ffprobe 的同目录（本项目 ffmpeg/ffprobe 成对安装），否则交给 PATH */
function findFfmpeg(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const probe = findFfprobe();
  if (probe) {
    const sameDir = path.join(path.dirname(probe), exe);
    if (exists(sameDir)) return sameDir;
    for (const up of [1, 2]) {
      const parts = path.dirname(probe).split(path.sep);
      const cand = path.join(parts.slice(0, parts.length - up).join(path.sep), 'bin', exe);
      if (exists(cand)) return cand;
    }
  }
  return 'ffmpeg';
}

async function main(): Promise<void> {
  console.log('\x1b[1m字幕烧录 —— 真实素材验证\x1b[0m（只切片，不投稿，零费用）');
  console.log('─'.repeat(70));

  const ledger = new Ledger();
  const cfg = loadConfig().config;
  const client = BiliLiveClient.fromConfig(cfg, log);

  const taskId = process.argv[2] ?? ledger.listTasks({ limit: 50 })[0]?.id;
  if (!taskId) {
    console.log('  没有可用的任务');
    process.exit(1);
  }
  const task = ledger.getTask(taskId);
  if (!task) {
    console.log(`  任务不存在：${taskId}`);
    process.exit(1);
  }
  console.log(`  任务：${task.id}（${task.title.slice(0, 40)}）`);

  const source = pickSourceForCut(task, cfg);
  if (!source) {
    console.log('  \x1b[31m没有可用的源文件\x1b[0m');
    process.exit(1);
  }
  console.log(`  源文件：${path.basename(source)}（${(fs.statSync(source).size / 1024 ** 2).toFixed(0)} MB）`);
  ok(!task.source.fullVideoHasDanmaku, '源文件未烧弹幕（已烧弹幕时不该再叠 ASS，硬约束 #12）', `fullVideoHasDanmaku=${task.source.fullVideoHasDanmaku}`);

  /* ---- 转写 ---- */
  const transcriptPath = task.transcriptPath ?? path.join(ledger.taskDir(task.id), 'transcript.json');
  if (!exists(transcriptPath)) {
    console.log('  没有 transcript.json，无法验证字幕');
    process.exit(1);
  }
  const transcript = readJson<Transcript>(transcriptPath);
  console.log(`  转写：${transcript.segments.length} 条`);
  if (transcript.glossaryCorrections?.length) {
    console.log(
      `  \x1b[90m术语表纠错命中：${transcript.glossaryCorrections.map((h) => `${h.from}→${h.to}×${h.count}`).join('，')}\x1b[0m`,
    );
  }

  /* ---- 弹幕 ASS：与生产路径同样的取值逻辑（有 ASS 用 ASS，只有 XML 就现场转） ---- */
  let danmakuAss = task.source.danmaAssPath && exists(task.source.danmaAssPath) ? task.source.danmaAssPath : undefined;
  if (!danmakuAss && task.source.danmaXmlPath && exists(task.source.danmaXmlPath)) {
    try {
      const assOut = path.join(OUT_DIR, 'danmaku-from-xml.ass');
      const conv = await convertDanmakuToAss({
        taskId: task.id,
        videoPath: source,
        xmlPath: task.source.danmaXmlPath,
        assOut,
        factoryPath: findDanmakuFactory(cfg.danmaku.factoryPath),
        ...(cfg.danmaku.fontSize ? { fontSize: cfg.danmaku.fontSize } : {}),
        logger: log,
      });
      for (const w of conv.warnings) console.log(`  \x1b[33m⚠ ${w}\x1b[0m`);
      if (conv.assPath && conv.dialogueCount > 0) {
        danmakuAss = conv.assPath;
        console.log(`  弹幕由 XML 现场转换：${conv.dialogueCount}/${conv.xmlCount} 条（方式 ${conv.method}）`);
      }
    } catch (e) {
      console.log(`  \x1b[33m⚠ 弹幕转换失败（本次只验证字幕）：${(e as Error).message}\x1b[0m`);
    }
  }
  console.log(`  弹幕 ASS：${danmakuAss ? path.basename(danmakuAss) : '(无，将只烧字幕)'}`);

  /* ---- 生成合并 ASS ---- */
  const start = Number(process.argv[3] ?? 60) || 0;
  const dur = Number(process.argv[4] ?? 24) || 24;
  const burn = buildBurnAss({
    outDir: path.join(OUT_DIR, 'ass'),
    ...(danmakuAss ? { danmakuAssPath: danmakuAss } : {}),
    segments: transcript.segments,
    videoPath: source,
    render: {
      ...(cfg.clip.subtitle.fontSize ? { fontSize: cfg.clip.subtitle.fontSize } : {}),
      maxCharsPerLine: cfg.clip.subtitle.maxCharsPerLine,
      minDurationSec: cfg.clip.subtitle.minDurationSec,
      readingCharsPerSec: cfg.clip.subtitle.readingCharsPerSec,
      fontName: cfg.clip.subtitle.fontName,
    },
    force: true,
  });
  for (const w of burn.warnings) console.log(`  \x1b[33m⚠ ${w}\x1b[0m`);
  ok(Boolean(burn.assPath), '生成合并 ASS', burn.assPath ? path.basename(burn.assPath) : '(失败)');
  if (!burn.assPath) process.exit(1);

  const assText = fs.readFileSync(burn.assPath, 'utf8');
  const subtitleLines = (assText.match(/^Dialogue:[^,]*,[^,]*,[^,]*,Subtitle,/gm) ?? []).length;
  const danmakuLines = (assText.match(/^Dialogue:/gm) ?? []).length - subtitleLines;
  ok(subtitleLines > 0, `ASS 内含字幕事件 ${subtitleLines} 条`, `（另有弹幕 ${danmakuLines} 条）`);
  ok(!assText.startsWith('\uFEFF'), '无 BOM（带 BOM 会让切片接口 500）');
  ok(/^Style:\s*Subtitle,/m.test(assText), '含独立的 Subtitle 样式（不与弹幕样式混用）');

  /* ------------------------------------------------------------------
   * 成品级断言：直接解析写进 ASS 的每一条字幕。
   * 用户报的两个问题（「字幕和声音对不上」「字幕也没有断句」）都只能在这里证伪：
   * 单元测试断言的是内存里的 cues，而真正烧进画面的是这个文件。
   * ------------------------------------------------------------------ */
  interface ParsedCue {
    start: number;
    end: number;
    text: string;
  }
  const parseAssTime = (t: string): number => {
    const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(t.trim());
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : NaN;
  };
  const parsed: ParsedCue[] = [];
  for (const line of assText.split(/\r?\n/)) {
    if (!line.startsWith('Dialogue:')) continue;
    const f = line.slice('Dialogue:'.length).split(',');
    if ((f[3] ?? '').trim() !== 'Subtitle') continue;
    // Text 是最后一个字段，且内部可能含逗号 → 重新按前 9 个逗号切开
    const head = line.slice('Dialogue:'.length).split(',', 10);
    parsed.push({ start: parseAssTime(head[1] ?? ''), end: parseAssTime(head[2] ?? ''), text: head[9] ?? '' });
  }
  const widths = parsed.map((c) => widthOfText(c.text.replace(/\\N/g, '')));
  const durs = parsed.map((c) => c.end - c.start);
  const wrappedCount = parsed.filter((c) => c.text.includes('\\N')).length;
  ok(parsed.length === subtitleLines, `解析出的字幕条数与 Dialogue 行一致（${parsed.length}）`);
  ok(parsed.every((c) => Number.isFinite(c.start) && Number.isFinite(c.end)), '时间戳都能解析（否则播放器整条丢弃）');
  ok(wrappedCount === 0, `没有一条需要折行（不折行 = 不会把词劈开）`, `折行 ${wrappedCount} 条`);
  ok(
    widths.every((w) => w <= cfg.clip.subtitle.maxCharsPerLine),
    `每条字幕宽度都 ≤ ${cfg.clip.subtitle.maxCharsPerLine}（一行放得下）`,
    `最宽 ${Math.max(...widths).toFixed(1)}`,
  );
  ok(
    durs.every((d) => d > 0.15 && d <= 8),
    '每条字幕时长都在 0.15–8 秒之间（不再有"9 个字挂 8 秒"）',
    `最长 ${Math.max(...durs).toFixed(2)}s，平均 ${(durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(2)}s`,
  );
  const cps = parsed.map((c, i) => widthOfText(c.text.replace(/\\N/g, '')) / durs[i]!);
  ok(
    cps.filter((r) => r > 8).length / parsed.length < 0.02,
    '至少 98% 的字幕阅读速度 ≤8 字/秒（跟得上说话）',
    `平均 ${(cps.reduce((a, b) => a + b, 0) / cps.length).toFixed(1)} 字/秒`,
  );
  // 断句：一段转写被切成多条 → 成品条数必须多于转写段数
  ok(
    parsed.length >= transcript.segments.length * 0.98,
    `字幕条数（${parsed.length}）与转写段数（${transcript.segments.length}）同量级：没有丢句`,
  );

  /* 切片窗口内的字幕逐条打印：与下面抽的帧一一对照，肉眼核对"字幕和声音对得上" */
  console.log(`\n  \x1b[1m切片窗口内会烧进画面的字幕\x1b[0m（${start}s–${start + dur}s）：`);
  const inWindow = parsed.filter((c) => c.end > start && c.start < start + dur);
  for (const c of inWindow.slice(0, 14)) {
    console.log(`    \x1b[90m${c.start.toFixed(2).padStart(9)}–${c.end.toFixed(2).padStart(9)}s\x1b[0m  ${(c.end - c.start).toFixed(1)}s  ${c.text}`);
  }
  if (inWindow.length > 14) console.log(`    \x1b[90m…另有 ${inWindow.length - 14} 条\x1b[0m`);
  ok(inWindow.length > 0, `切片窗口内有 ${inWindow.length} 条字幕（窗口选得不好会抽到空帧）`);

  /* ---- 真切片（不投稿） ---- */
  ensureDir(OUT_DIR);
  const output = path.join(OUT_DIR, `burn-test-${Date.now()}.mp4`);
  const presets = await client.presetFfmpeg().catch((): FfmpegPreset[] => []);
  const built = buildFfmpegOptions(presets, cfg.clip.ffmpegPresetId, { start, end: start + dur }, cfg.clip.ffmpegOptionsOverride);
  for (const w of built.warnings) console.log(`  \x1b[33m⚠ ${w}\x1b[0m`);
  console.log(`  提交切片：${start}s – ${start + dur}s（参数来源 ${built.source}）`);

  const cut = await client.cut({
    videoFilePath: source,
    assFilePath: burn.assPath,
    output,
    ffmpegOptions: built.options,
    saveType: 2,
    savePath: OUT_DIR,
  });
  console.log(`  切片任务：${cut.taskId}`);

  let finalOut: string | undefined;
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const d = await client.taskDetail(cut.taskId);
    if (d.status === 'completed') {
      finalOut = typeof d.output === 'string' && d.output ? d.output : output;
      break;
    }
    if (d.status === 'error') {
      console.log(`  \x1b[31m切片失败：${d.error ?? '未知'}（看 /common/getLogContent）\x1b[0m`);
      process.exit(1);
    }
    await sleep(2000);
  }
  ok(Boolean(finalOut) && exists(finalOut!), '成片已产出', finalOut ? `${path.basename(finalOut)} ${(fs.statSync(finalOut!).size / 1024 ** 2).toFixed(1)} MB` : '超时');
  if (!finalOut) process.exit(1);

  /* ---- 抽帧，给人眼看 ---- */
  const ffmpeg = findFfmpeg();
  const frames: string[] = [];
  for (const frac of [0.2, 0.5, 0.8]) {
    const f = path.join(OUT_DIR, `frame-${Math.round(frac * 100)}.png`);
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', (frac * dur).toFixed(2), '-i', finalOut, '-frames:v', '1', f], {
        stdio: 'ignore',
        timeout: 60000,
      });
      if (exists(f)) frames.push(f);
    } catch {
      /* 单帧失败不影响结论 */
    }
  }
  ok(frames.length > 0, `抽出 ${frames.length} 帧`, frames.map((f) => path.relative(ROOT_DIR, f)).join(' , '));

  console.log('\n' + '─'.repeat(70));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  console.log('请打开上面的帧确认三件事：');
  console.log('  ① 字幕在画面下方、白字黑边清晰可读；');
  console.log('  ② 字幕没有被底部弹幕压住（两者是分开的）；');
  console.log('  ③ 中文字形正常，没有出现方框（缺字）。');
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\x1b[31m验证异常：\x1b[0m', (e as Error).message);
  process.exit(1);
});
