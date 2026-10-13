/**
 * 本地 ASR 的**资源占用剖面**（2026-10-11）。
 *
 * 回答的问题：跑我们这套本地识别，到底占多少 —— 显存、内存、GPU 利用率、CPU、启动时间、RTF。
 * 为什么要有它：这些数字此前都是"印象"（"模型加载约 96 秒""python 占两三个 G"），
 * 换引擎 / 换量化 / 改 runner 之后没人能说清变好还是变差；而且"会不会影响打游戏"这种问题，
 * 光看峰值不够 —— 要看 GPU 利用率的**分布**（有多少时间被占住）。这里把它变成一行命令。
 *
 * 用法：
 *   node --experimental-strip-types tools/local-asr/footprint.ts "<媒体文件>" [--minutes 2] [--engine funasr|sensevoice|both] [--sample-ms 1000]
 *
 * 口径（写清楚，免得不同人量出不同结论）：
 *   · 显存 = `nvidia-smi` 的整卡已用，**减去开始前的基线**（桌面上本来就占着 1.6–1.8 G）；
 *   · GPU 利用率 = 采样点上的瞬时值，报平均/p50/p90/峰值 + "≥50%、≥80% 的采样占比"；
 *   · 内存 = 本次**新增**的 python 进程 WorkingSet 之和（开始前就存在的 pid 不计 —— 产线服务
 *     自己也会转写，第一版没排除它们，量出过"python 占 12 GB"这种荒唐数字）；
 *   · CPU = 整机占用率 + 本次 python 的平均核数（ΔCPU 秒 / Δ墙钟）。
 *
 * ⚠️ 要干净数据就先让机器空闲：同机有别的转写在跑时，RTF 与显存峰值都会被抬高（工具会先警告）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { loadConfig } from '../../src/config.ts';
import { BiliLiveClient } from '../../src/api.ts';
import { AsrCache, Transcriber } from '../../src/asr.ts';
import { log } from '../../src/logger.ts';
import { findFfmpeg } from '../../src/av-sync.ts';
import { ROOT_DIR, exists } from '../../src/util.ts';

const argv = process.argv.slice(2);
const media = argv.find((a) => !a.startsWith('--'));
const optOf = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const minutes = optOf('minutes', 2);
/** 采样间隔（毫秒）：量"打游戏会不会掉帧"时用 1000 拿分布；默认 2000 够看峰值 */
const sampleMs = Math.max(250, optOf('sample-ms', 2000));
const engineArg = (() => {
  const i = argv.indexOf('--engine');
  return i >= 0 ? String(argv[i + 1]) : 'both';
})();
if (!media || !exists(media)) {
  console.error('用法：node --experimental-strip-types tools/local-asr/footprint.ts "<媒体文件>" [--minutes 2] [--engine funasr|sensevoice|both] [--sample-ms 2000]');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = path.join(ROOT_DIR, 'data', 'local-asr-test', `footprint-${stamp}`);
fs.mkdirSync(runDir, { recursive: true });
const FFMPEG = findFfmpeg();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一次 nvidia-smi 取回"已用显存 + GPU 利用率"（利用率是"打游戏会不会掉帧"的直接指标） */
function gpuStats(): { usedMb: number; utilPct: number } {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
  const [used, util] = String(r.stdout ?? '').trim().split('\n')[0]!.split(',').map((s) => Number(s.trim()));
  return { usedMb: Number.isFinite(used!) ? used! : -1, utilPct: Number.isFinite(util!) ? util! : -1 };
}

function gpuUsedMb(): number {
  return gpuStats().usedMb;
}

/** 整机 CPU 占用率（%） */
function machineCpuPct(): number {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime"],
    { encoding: 'utf8' },
  );
  const v = Number(String(r.stdout ?? '').trim());
  return Number.isFinite(v) ? v : 0;
}

/**
 * 本次新增的 python 进程：内存（MB）与 pid 列表。
 *
 * ⚠️ 必须**排除开始时已存在的 pid**：这台机器上同时跑着产线服务（它自己也会转写），
 * 第一版把别的转写进程也算进来，于是 2 分钟素材量出"python 占 12 GB"这种荒唐数字。
 */
function pythonMemMb(ignorePids: Set<number>): { mb: number; pids: number[] } {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "Get-Process python -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id) $([int]($_.WorkingSet64/1MB))\" }"],
    { encoding: 'utf8' },
  );
  let mb = 0;
  const pids: number[] = [];
  for (const line of String(r.stdout ?? '').trim().split('\n')) {
    const [idRaw, mbRaw] = line.trim().split(/\s+/);
    const id = Number(idRaw);
    if (!Number.isFinite(id) || ignorePids.has(id)) continue;
    if (!alivePid(id)) continue;
    pids.push(id);
    mb += Number(mbRaw) || 0;
  }
  return { mb, pids };
}

/** 进程是否还活着（用来把"已经退出的旧 pid"排除掉，避免 pid 复用误判） */
function alivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 采样开始时已在运行的 python pid（这些不是本次测量造成的占用） */
function existingPythonPids(): Set<number> {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Process python -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }'], {
    encoding: 'utf8',
  });
  return new Set(
    String(r.stdout ?? '')
      .trim()
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
}

interface Sample {
  at: number;
  gpuMb: number;
  gpuUtilPct: number;
  cpuPct: number;
  pyMb: number;
  pyCpuSec: number;
  pyPids: number[];
}

/** 本次新增 python 进程的累计 CPU 秒（除以墙钟 = 平均占几个核） */
function pythonCpuSec(pids: number[]): number {
  if (pids.length === 0) return 0;
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Measure-Object CPU -Sum | ForEach-Object { $_.Sum }`],
    { encoding: 'utf8' },
  );
  const v = Number(String(r.stdout ?? '').trim());
  return Number.isFinite(v) ? v : 0;
}

/** 采样器：每 `intervalMs` 记一次显存 / GPU 利用率 / 整机 CPU / 本次新增 python 的内存与 CPU */
function startSampler(intervalMs: number): { stop: () => Sample[] } {
  const samples: Sample[] = [];
  const ignore = existingPythonPids();
  if (ignore.size > 0) {
    console.log(
      `  \x1b[33m! 开始前已有 ${ignore.size} 个 python 进程在跑（pid ${[...ignore].join(',')}）—— ` +
        `它们的内存不计入本次测量，但**它们仍会抢 GPU**，RTF/显存峰值会偏高；要干净数据请等机器空闲再量\x1b[0m`,
    );
  }
  let running = true;
  const t0 = Date.now();
  void (async () => {
    while (running) {
      const m = pythonMemMb(ignore);
      const g = gpuStats();
      samples.push({
        at: Date.now() - t0,
        gpuMb: g.usedMb,
        gpuUtilPct: g.utilPct,
        cpuPct: machineCpuPct(),
        pyMb: m.mb,
        pyCpuSec: pythonCpuSec(m.pids),
        pyPids: m.pids,
      });
      await sleep(intervalMs);
    }
  })();
  return {
    stop: () => {
      running = false;
      return samples;
    },
  };
}

function peak(samples: Sample[]): {
  gpuPeakMb: number;
  gpuUtilPeakPct: number;
  gpuUtilAvgPct: number;
  gpuUtilP50Pct: number;
  gpuUtilP90Pct: number;
  gpuBusy50SharePct: number;
  gpuBusy80SharePct: number;
  cpuPeakPct: number;
  cpuAvgPct: number;
  pyPeakMb: number;
  pyLastMb: number;
  pyCores: number;
  pids: number[];
} {
  let hottest: Sample | undefined;
  for (const s of samples) if (!hottest || s.pyMb > hottest.pyMb) hottest = s;
  const n = Math.max(1, samples.length);
  const cpuSec = samples.length ? samples[samples.length - 1]!.pyCpuSec - samples[0]!.pyCpuSec : 0;
  const wallSec = samples.length ? (samples[samples.length - 1]!.at - samples[0]!.at) / 1000 : 0;
  /* GPU 利用率的**分布**比平均值有意义：游戏掉帧看的是"有多少时间被占住" */
  const utils = samples.map((s) => s.gpuUtilPct).filter((v) => v >= 0).sort((a, b) => a - b);
  const q = (p: number): number => (utils.length ? utils[Math.min(utils.length - 1, Math.floor(utils.length * p))]! : 0);
  const share = (min: number): number => (utils.length ? Math.round((utils.filter((v) => v >= min).length / utils.length) * 100) : 0);
  return {
    gpuPeakMb: samples.reduce((m, s) => Math.max(m, s.gpuMb), 0),
    gpuUtilPeakPct: utils.length ? utils[utils.length - 1]! : 0,
    gpuUtilAvgPct: Math.round(utils.reduce((a, v) => a + v, 0) / n),
    gpuUtilP50Pct: q(0.5),
    gpuUtilP90Pct: q(0.9),
    gpuBusy50SharePct: share(50),
    gpuBusy80SharePct: share(80),
    cpuPeakPct: samples.reduce((m, s) => Math.max(m, s.cpuPct), 0),
    cpuAvgPct: Math.round(samples.reduce((a, s) => a + s.cpuPct, 0) / n),
    pyPeakMb: hottest?.pyMb ?? 0,
    pyLastMb: samples.length ? samples[samples.length - 1]!.pyMb : 0,
    pyCores: wallSec > 0 ? Number((cpuSec / wallSec).toFixed(2)) : 0,
    pids: hottest?.pyPids ?? [],
  };
}

/* ---------------------------------------------------------------- 准备素材 */

console.log(`\n\x1b[1m准备：切 ${minutes} 分钟素材（采样间隔 ${sampleMs} ms）\x1b[0m`);
const clip = path.join(runDir, `clip-${minutes}min.ts`);
{
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', '600', '-i', media, '-t', String(minutes * 60), '-c', 'copy', '-y', clip], { stdio: 'inherit' });
  if (r.status !== 0 || !exists(clip)) throw new Error('ffmpeg 切分失败');
  console.log(`  ${clip}（${(fs.statSync(clip).size / 1024 ** 2).toFixed(0)} MB）`);
}
const wav = path.join(runDir, 'clip.wav');
{
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-vn', '-ac', '1', '-ar', '16000', '-y', wav], { stdio: 'inherit' });
  if (r.status !== 0 || !exists(wav)) throw new Error('ffmpeg 抽音频失败');
}

const audioSec = minutes * 60;
const results: Array<Record<string, unknown>> = [];

/* ---------------------------------------------------------------- A. torch 路径（当前产线） */

async function measureFunasr(): Promise<void> {
  console.log(`\n\x1b[1mA. 当前产线：Fun-ASR-Nano（PyTorch + ModelScope）\x1b[0m`);
  const cfg = loadConfig().config;
  cfg.asr.provider = 'local-funasr';
  cfg.runtime.allowPaid = false;
  cfg.asr.silenceTrim.enabled = false;
  const tr = new Transcriber({
    client: BiliLiveClient.fromConfig(cfg, log),
    config: cfg,
    cache: new AsrCache(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-')), log),
  });
  const baseGpu = gpuUsedMb();
  const baseCpu = machineCpuPct();
  const sampler = startSampler(sampleMs);
  const t0 = Date.now();
  let firstCueAt = 0;
  const res = await tr.transcribe({
    taskId: `footprint-funasr-${stamp}`,
    totalDuration: audioSec,
    allowPaid: false,
    onProgress: (p) => {
      if (!firstCueAt && p.current > 0) firstCueAt = Date.now() - t0;
    },
    media: {
      planCalls: () => [{ file: clip, inFileStart: 0, inFileEnd: audioSec, globalStart: 0, globalEnd: audioSec, offset: 0, windowIndex: 0 }],
      fileStat: (f) => ({ size: fs.statSync(f).size, updatedAt: Math.round(fs.statSync(f).mtimeMs) }),
    },
  });
  const wallMs = Date.now() - t0;
  const s = sampler.stop();
  await sleep(2500); // 等采样器最后一次落点
  const p = peak(s);
  const cues = res.transcript.segments.length;
  const out = {
    engine: 'funasr-torch',
    model: 'FunAudioLLM/Fun-ASR-Nano-2512（torch，仓库缓存）',
    audioSec,
    wallSec: Number((wallMs / 1000).toFixed(1)),
    rtf: Number((wallMs / 1000 / audioSec).toFixed(3)),
    cues,
    gpuBaseMb: baseGpu,
    gpuPeakMb: p.gpuPeakMb,
    gpuDeltaMb: p.gpuPeakMb - baseGpu,
    gpuUtilAvgPct: p.gpuUtilAvgPct,
    gpuUtilP50Pct: p.gpuUtilP50Pct,
    gpuUtilP90Pct: p.gpuUtilP90Pct,
    gpuUtilPeakPct: p.gpuUtilPeakPct,
    gpuBusy50SharePct: p.gpuBusy50SharePct,
    gpuBusy80SharePct: p.gpuBusy80SharePct,
    cpuBasePct: baseCpu,
    machineCpuAvgPct: p.cpuAvgPct,
    machineCpuPeakPct: p.cpuPeakPct,
    pyCores: p.pyCores,
    pyPeakMb: p.pyPeakMb,
    pyAfterMb: p.pyLastMb,
    pyPids: p.pids,
    samples: s.length,
    firstProgressSec: Number((firstCueAt / 1000).toFixed(1)),
    sample: (res.transcript.segments[0]?.text ?? '').slice(0, 40),
  };
  results.push(out);
  console.log(
    `  墙钟 ${out.wallSec}s（RTF ${out.rtf}）· 字幕 ${cues} 条\n` +
      `  显存 峰值 ${out.gpuPeakMb} MB（基线 ${baseGpu} ⇒ 本进程 +${out.gpuDeltaMb} MB）\n` +
      `  GPU 利用率 平均 ${out.gpuUtilAvgPct}% / p50 ${out.gpuUtilP50Pct}% / p90 ${out.gpuUtilP90Pct}% / 峰值 ${out.gpuUtilPeakPct}%` +
      `（≥50% 的采样占 ${out.gpuBusy50SharePct}%、≥80% 占 ${out.gpuBusy80SharePct}%）\n` +
      `  整机 CPU 平均 ${out.machineCpuAvgPct}% / 峰值 ${out.machineCpuPeakPct}%（基线 ${baseCpu}%；其中 python 占 ${out.pyCores} 个核）\n` +
      `  内存 python 峰值 ${out.pyPeakMb} MB / 退出前 ${out.pyAfterMb} MB（pid ${p.pids.join(',')}，共 ${s.length} 个采样点）`,
  );
}

/* ---------------------------------------------------------------- B. llama.cpp / GGUF 路径 */

async function measureSensevoice(): Promise<void> {
  console.log(`\n\x1b[1mB. 备选：SenseVoice-Small（llama.cpp + CUDA，量化 q8_0）\x1b[0m`);
  const exe = path.join(ROOT_DIR, '.funasr', 'bin', 'llama-funasr-sensevoice.exe');
  const model = path.join(ROOT_DIR, '.funasr', 'models', 'sensevoice-small-q8.gguf');
  const vad = path.join(ROOT_DIR, '.funasr', 'models', 'fsmn-vad.gguf');
  if (!exists(exe) || !exists(model)) {
    console.log('  \x1b[33m缺可执行文件或模型，跳过\x1b[0m');
    return;
  }
  const outSrt = path.join(runDir, 'sensevoice.srt');
  const baseGpu = gpuUsedMb();
  const sampler = startSampler(sampleMs);
  const t0 = Date.now();
  const child: ChildProcess = spawn(exe, ['-m', model, '--vad', vad, '-a', wav, '--srt', '--backend', 'cuda'], {
    cwd: path.dirname(exe),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => (stdout += String(d)));
  child.stderr?.on('data', (d) => (stderr += String(d)));
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  const wallMs = Date.now() - t0;
  const s = sampler.stop();
  await sleep(2500);
  const p = peak(s);
  fs.writeFileSync(outSrt, stdout);
  const cues = (stdout.match(/^\d+$/gm) ?? []).length;
  const firstText = (stdout.split('\n').find((l) => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes('-->')) ?? '').trim();
  const out = {
    engine: 'sensevoice-cuda',
    model: 'SenseVoiceSmall q8_0（GGUF / llama.cpp）',
    audioSec,
    wallSec: Number((wallMs / 1000).toFixed(1)),
    rtf: Number((wallMs / 1000 / audioSec).toFixed(3)),
    cues,
    gpuBaseMb: baseGpu,
    gpuPeakMb: p.gpuPeakMb,
    gpuDeltaMb: p.gpuPeakMb - baseGpu,
    gpuUtilAvgPct: p.gpuUtilAvgPct,
    gpuUtilPeakPct: p.gpuUtilPeakPct,
    pyPeakMb: p.pyPeakMb,
    exitCode: code,
    sample: firstText.slice(0, 40),
  };
  results.push(out);
  console.log(
    `  墙钟 ${out.wallSec}s（RTF ${out.rtf}）· 字幕 ${cues} 条 · 退出码 ${String(code)}\n` +
      `  显存 峰值 ${out.gpuPeakMb} MB（基线 ${baseGpu} ⇒ 本进程 +${out.gpuDeltaMb} MB）\n` +
      `  GPU 利用率 平均 ${out.gpuUtilAvgPct}% / 峰值 ${out.gpuUtilPeakPct}%\n` +
      `  内存 本次新增的 python 峰值 ${out.pyPeakMb} MB（这条路径**不用** python，应为 0；非 0 说明同机还有别的转写在跑）`,
  );
  if (code !== 0) console.log(`  \x1b[33mstderr 尾部：${stderr.slice(-300)}\x1b[0m`);
}

if (engineArg === 'funasr' || engineArg === 'both') await measureFunasr();
if (engineArg === 'sensevoice' || engineArg === 'both') await measureSensevoice();

const report = { at: new Date().toISOString(), media, minutes, sampleMs, runDir, results };
fs.writeFileSync(path.join(runDir, 'footprint.json'), JSON.stringify(report, null, 2));
console.log(`\n\x1b[1m报告：${path.join(runDir, 'footprint.json')}\x1b[0m`);
