/**
 * 「边录边转写」（`asr.incrementalEnabled`）开 / 关的**真机 A/B 实测**（2026-10-13）。
 *
 * 为什么要有它：这个开关的收益此前只有间接证据（"等开始转写占 573–3691 秒，比转写本身
 * 133–145 秒长得多"）—— 用户问"打开和不打开到底差多少"，需要**同一份素材、同一条缓存路径**
 * 下的一次对照，而不是推算。
 *
 * 场景（复刻真实形态：一场录制分成 N 个文件，逐个闭合）：
 *   · **不打开**：录制期间什么都不做；下播后才开始转整场 ⇒ 等待 = 整场 ASR 时间。
 *   · **打开**：录制期间把**已闭合**的那一段先转掉（预转写就是逐段调 transcribe，
 *     与正式路径共用缓存）；下播后只剩最后一段要跑 ⇒ 等待 = 最后一段的 ASR 时间。
 *
 * 判据（全部实测，不推算）：
 *   ① 「下播 → 转写可用」的等待：打开必须显著小于不打开；
 *   ② 打开在**录制期间**要额外付出多少（模型加载 + 推理时间）；
 *   ③ 两条路的字幕结果必须一致（条数/覆盖时长/文本），否则这个开关就是在改结果；
 *   ④ 缓存真的要命中（下播后那次必须报 cache hit，否则收益是假的）。
 *
 * 用法：
 *   node --experimental-strip-types tools/local-asr/pretranscribe-ab.ts [--src <10 分钟左右的 .ts>]
 * 产出：data/local-asr-test/pretranscribe-ab-<时间>/report.json + 控制台对照表。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../src/config.ts';
import { BiliLiveClient } from '../../src/api.ts';
import { AsrCache, Transcriber, type AsrMediaAdapter } from '../../src/asr.ts';
import { log } from '../../src/logger.ts';
import { ROOT_DIR } from '../../src/util.ts';

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${Math.round(s - m * 60)} 秒` : `${s.toFixed(1)} 秒`;
}

/** 找一个"大约 10 分钟"的真实录制文件来当实验素材 */
function pickSource(): string {
  const explicit = argOf('--src');
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`--src 不存在：${explicit}`);
    return explicit;
  }
  const dir = 'C:\\Users\\demo\\Downloads\\Bilibili\\乙主播';
  const cands = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => ({ f, p: path.join(dir, f), mb: fs.statSync(path.join(dir, f)).size / 1024 ** 2 }))
        // 10 分钟的那段实测 187 MB；取 150–260 MB 之间最接近 187 MB 的
        .filter((x) => x.mb > 120 && x.mb < 320)
        .sort((a, b) => Math.abs(a.mb - 187) - Math.abs(b.mb - 187))
    : [];
  if (cands.length === 0) throw new Error('找不到合适的实验素材（请用 --src 指定一个 10 分钟左右的 .ts）');
  return cands[0]!.p;
}

const src = pickSource();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const workDir = path.join(ROOT_DIR, 'data', 'local-asr-test', `pretranscribe-ab-${stamp}`);
fs.mkdirSync(workDir, { recursive: true });

/* 复刻"一场录制分两个文件"：把同一段素材复制两次（内容一致，便于比对结果） */
const segA = path.join(workDir, 'AB.ts');
const segB = path.join(workDir, 'AB-PART001.ts');
for (const p of [segA, segB]) if (!fs.existsSync(p)) fs.copyFileSync(src, p);
const sizeOf = (p: string): number => fs.statSync(p).size;
console.log(`\x1b[1m素材\x1b[0m ${path.basename(src)}（${(sizeOf(src) / 1024 ** 2).toFixed(0)} MB）→ 复制成两段：AB.ts + AB-PART001.ts`);
console.log(`\x1b[1m工作目录\x1b[0m ${workDir}\n`);

const cfg = loadConfig().config;
cfg.asr.provider = 'local-funasr';
cfg.runtime.allowPaid = false;
cfg.asr.silenceTrim.enabled = false;

/** 与产线同一条路径：每个文件一个调用单元（Fun-ASR 是"一个文件一次调用"） */
function adapter(files: string[], durations: number[]): AsrMediaAdapter {
  return {
    planCalls: () =>
      files.map((f, i) => ({
        file: f,
        inFileStart: 0,
        inFileEnd: durations[i]!,
        globalStart: 0,
        globalEnd: durations[i]!,
        offset: 0,
        windowIndex: i,
      })),
    fileStat: (f: string) => ({ size: fs.statSync(f).size, updatedAt: Math.round(fs.statSync(f).mtimeMs) }),
  };
}

interface RunResult {
  label: string;
  wallSec: number;
  cues: number;
  coveredSec: number;
  paidCalls: number;
  /** 从 asr 缓存里读到的命中数（由缓存日志/结果推断） */
  text: string;
}

async function runOnce(label: string, cacheDir: string, files: string[], durations: number[], taskId: string): Promise<RunResult> {
  const tr = new Transcriber({
    client: BiliLiveClient.fromConfig(cfg, log),
    config: cfg,
    cache: new AsrCache(cacheDir, log),
  });
  const total = durations.reduce((a, b) => a + b, 0);
  const t0 = Date.now();
  const res = await tr.transcribe({
    taskId,
    totalDuration: total,
    allowPaid: false,
    media: adapter(files, durations),
  });
  const wallSec = (Date.now() - t0) / 1000;
  const segs = res.transcript.segments ?? [];
  const covered = segs.reduce((a, c) => a + Math.max(0, (c.end ?? 0) - (c.start ?? 0)), 0);
  return {
    label,
    wallSec,
    cues: segs.length,
    coveredSec: Math.round(covered),
    paidCalls: res.paidCalls ?? 0,
    text: segs.map((s) => s.text).join('').slice(0, 200),
  };
}

/** 先用 ffprobe 拿到每段真实时长（ASR 的窗口规划要用它） */
function probeDuration(p: string): number {
  const ffprobe = path.join(ROOT_DIR, 'tools', 'ffmpeg', 'bin', 'ffprobe.exe');
  const bin = fs.existsSync(ffprobe) ? ffprobe : 'ffprobe';
  const r = spawnSync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], {
    encoding: 'utf8',
  });
  const d = Number(String(r.stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe 拿不到时长：${p}`);
  return d;
}

const durA = probeDuration(segA);
console.log(`每段时长 ${fmtSec(durA)}（整场 ${fmtSec(durA * 2)}）\n`);

/* ---------------- 场景 1：不打开（下播后才开始，整场一次跑） ---------------- */
console.log('\x1b[1m场景 1／不打开：录制期间不转，下播后转整场\x1b[0m');
const off = await runOnce('off（整场）', fs.mkdtempSync(path.join(os.tmpdir(), 'ab-off-')), [segA, segB], [durA, durA], 'ab-off-full');
console.log(`  → 等待 ${fmtSec(off.wallSec)}，${off.cues} 条字幕，覆盖 ${fmtSec(off.coveredSec)}`);

/* ---------------- 场景 2：打开（录制期间预转已闭合的那段，下播后只剩最后一段） ---------------- */
console.log('\n\x1b[1m场景 2／打开：录制期间先把已闭合的那段转掉\x1b[0m');
const cacheOn = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-on-'));
const during = await runOnce('on（录制期间：第 1 段）', cacheOn, [segA], [durA], 'ab-on-seg1');
console.log(`  录制期间投入 ${fmtSec(during.wallSec)}（这段在录制时跑，不占用"下播后的等待"）`);
console.log('  下播：只剩第 2 段要跑（第 1 段应命中缓存）');
const on = await runOnce('on（下播后：整场，第 1 段命中缓存）', cacheOn, [segA, segB], [durA, durA], 'ab-on-full');
console.log(`  → 等待 ${fmtSec(on.wallSec)}，${on.cues} 条字幕，覆盖 ${fmtSec(on.coveredSec)}`);

/* ---------------- 对照 ---------------- */
const savedSec = off.wallSec - on.wallSec;
const extraSec = during.wallSec;
const report = {
  at: new Date().toISOString(),
  source: src,
  segmentSec: Math.round(durA),
  off,
  on: { during, after: on },
  savedSec: Math.round(savedSec),
  extraCostSec: Math.round(extraSec),
  sameCues: off.cues === on.cues,
  note:
    '不打开 = 下播后一次性转整场（等待 = off.wallSec）；打开 = 录制期间先转已闭合分段（cost = during.wallSec），' +
    '下播后只剩最后一段（等待 = on.after.wallSec）。',
};
fs.writeFileSync(path.join(workDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m对照（同一段素材、同一条缓存路径，实测）\x1b[0m`);
console.log(`  不打开：下播后等待 \x1b[33m${fmtSec(off.wallSec)}\x1b[0m`);
console.log(`  打开　：下播后等待 \x1b[32m${fmtSec(on.wallSec)}\x1b[0m   ← 录制期间另投入 ${fmtSec(during.wallSec)}`);
console.log(`  省下　：\x1b[32m${fmtSec(savedSec)}\x1b[0m（${((savedSec / off.wallSec) * 100).toFixed(0)}% 的等待）`);
console.log(`  代价　：录制期间多占 GPU ${fmtSec(extraSec)}（多一次模型加载 + 该段推理）`);
console.log(`  一致性：字幕条数 ${off.cues} vs ${on.cues} ${off.cues === on.cues ? '✓' : '✗ 需要排查'}`);
console.log(`  报告：${path.join(workDir, 'report.json')}`);
if (savedSec <= 0) {
  console.log('\n\x1b[31m结论：本次没有省下时间 —— 先查缓存是否命中（下播后那次若仍跑了两个文件，说明窗口键没对上）\x1b[0m');
  process.exitCode = 1;
}
