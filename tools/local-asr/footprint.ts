/**
 * 本地 ASR 的**资源占用剖面**（2026-10-11）。
 *
 * 回答的问题：跑我们这套本地识别，到底占多少 —— 显存、内存、启动时间、RTF。
 * 为什么要有它：这些数字此前都是"印象"（"模型加载约 96 秒""python 占两三个 G"），
 * 换引擎 / 换量化 / 换 chunk 之后没人能说清变好还是变差。这里把它变成**可复跑的一行命令**。
 *
 * 用法：
 *   node --experimental-strip-types tools/local-asr/footprint.ts "<媒体文件>" [--minutes 2] [--engine funasr|sensevoice]
 *
 * 口径（写清楚，免得不同人量出不同结论）：
 *   · 显存 = `nvidia-smi` 的整卡已用，**减去开始前的基线**（桌面上本来还占着 1.8 G）；
 *   · 内存 = 所有 `python.exe` 的 WorkingSet 之和（torch 路径的占用全在那个进程里）；
 *   · 启动时间 = 从起进程到**第一条字幕产出**之间的墙钟（torch 路径就是"模型加载"那段固定成本）。
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
const engineArg = (() => {
  const i = argv.indexOf('--engine');
  return i >= 0 ? String(argv[i + 1]) : 'both';
})();
if (!media || !exists(media)) {
  console.error('用法：node --experimental-strip-types tools/local-asr/footprint.ts "<媒体文件>" [--minutes 2] [--engine funasr|sensevoice|both]');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = path.join(ROOT_DIR, 'data', 'local-asr-test', `footprint-${stamp}`);
fs.mkdirSync(runDir, { recursive: true });
const FFMPEG = findFfmpeg();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function gpuUsedMb(): number {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
  const v = Number(String(r.stdout ?? '').trim().split('\n')[0]);
  return Number.isFinite(v) ? v : -1;
}

/**
 * 所有 python.exe 的 WorkingSet 之和（MB）。
 *
 * ⚠️ 必须**减去开始时已存在的 pid**：这台机器上同时跑着产线服务（它自己也会转写），
 * 第一版把别的转写进程的内存也算进来，于是 2 分钟素材量出"python 占 12 GB"这种荒唐数字。
 * 返回 {mb, pids}，把 pid 一并报出来，便于人工核对"到底算进了谁"。
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
  pyMb: number;
  pyPids: number[];
}

/** 采样器：每 2 秒记一次显存/本次新增的 python 内存（采样本身的开销也算在墙钟里，如实说明） */
function startSampler(): { stop: () => Sample[] } {
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
      samples.push({ at: Date.now() - t0, gpuMb: gpuUsedMb(), pyMb: m.mb, pyPids: m.pids });
      await sleep(2000);
    }
  })();
  return {
    stop: () => {
      running = false;
      return samples;
    },
  };
}

function peak(samples: Sample[]): { gpuPeakMb: number; pyPeakMb: number; pyLastMb: number; pids: number[] } {
  let hottest: Sample | undefined;
  for (const s of samples) if (!hottest || s.pyMb > hottest.pyMb) hottest = s;
  return {
    gpuPeakMb: samples.reduce((m, s) => Math.max(m, s.gpuMb), 0),
    pyPeakMb: hottest?.pyMb ?? 0,
    pyLastMb: samples.length ? samples[samples.length - 1]!.pyMb : 0,
    pids: hottest?.pyPids ?? [],
  };
}

/* ---------------------------------------------------------------- 准备素材 */

console.log(`\n\x1b[1m准备：切 ${minutes} 分钟素材\x1b[0m`);
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
  const sampler = startSampler();
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
    gpuPeakMb: p.gpuPeakMb,
    gpuDeltaMb: p.gpuPeakMb - baseGpu,
    pyPeakMb: p.pyPeakMb,
    pyAfterMb: p.pyLastMb,
    pyPids: p.pids,
    firstProgressSec: Number((firstCueAt / 1000).toFixed(1)),
    sample: (res.transcript.segments[0]?.text ?? '').slice(0, 40),
  };
  results.push(out);
  console.log(
    `  墙钟 ${out.wallSec}s（RTF ${out.rtf}）· 字幕 ${cues} 条\n` +
      `  显存 峰值 ${out.gpuPeakMb} MB（基线 ${baseGpu} ⇒ 本进程 +${out.gpuDeltaMb} MB）\n` +
      `  内存 python 峰值 ${out.pyPeakMb} MB / 退出前 ${out.pyAfterMb} MB（pid ${p.pids.join(',')}）`,
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
  const sampler = startSampler();
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
    gpuPeakMb: p.gpuPeakMb,
    gpuDeltaMb: p.gpuPeakMb - baseGpu,
    pyPeakMb: p.pyPeakMb,
    exitCode: code,
    sample: firstText.slice(0, 40),
  };
  results.push(out);
  console.log(
    `  墙钟 ${out.wallSec}s（RTF ${out.rtf}）· 字幕 ${cues} 条 · 退出码 ${String(code)}\n` +
      `  显存 峰值 ${out.gpuPeakMb} MB（基线 ${baseGpu} ⇒ 本进程 +${out.gpuDeltaMb} MB）\n` +
      `  内存 本次新增的 python 峰值 ${out.pyPeakMb} MB（这条路径**不用** python，应为 0；非 0 说明同机还有别的转写在跑）`,
  );
  if (code !== 0) console.log(`  \x1b[33mstderr 尾部：${stderr.slice(-300)}\x1b[0m`);
}

if (engineArg === 'funasr' || engineArg === 'both') await measureFunasr();
if (engineArg === 'sensevoice' || engineArg === 'both') await measureSensevoice();

const report = { at: new Date().toISOString(), media, minutes, runDir, results };
fs.writeFileSync(path.join(runDir, 'footprint.json'), JSON.stringify(report, null, 2));
console.log(`\n\x1b[1m报告：${path.join(runDir, 'footprint.json')}\x1b[0m`);
