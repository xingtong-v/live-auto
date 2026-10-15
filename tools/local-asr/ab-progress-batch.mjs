/**
 * 子批大小的 A/B 实测（2026-10-15，配合「精确进度」）。
 *
 * 问题：为了在界面上显示**实测**进度，执行器把一次 `generate()` 切成了若干子批
 * （`progress_batch_sec`，默认 300 秒）。切批会不会把转写拖慢？慢多少？
 * 这件事**只能实测**，而且必须用同一段素材、同参数、只差批大小来比。
 *
 * 用法：`node tools/local-asr/ab-progress-batch.mjs [批秒 …]`
 *   默认跑 `0 60 300`：
 *     · 0   = 一次喂完（历史行为，基准）
 *     · 60  = 300 秒素材切 ~5 批（**批次数量与生产环境相当**：30 分钟一块 ≈ 6 批）
 *     · 300 = 生产默认值（300 秒素材就是 1 批，等价于 0；跑它是为了确认这条路径真的等价）
 *
 * 量三件事：墙钟耗时、执行器自报的推理耗时（`asr_ms`）、字幕文本是否逐字一致。
 * 结果写 `data/local-asr-test/ab-progress-batch.json`。
 *
 * ⚠️ 必须**在没有别的转写/重活跑**的时候测：GPU 被抢时 5% 的差异完全被噪声淹没
 * （本机实测同一段音频两次可以差 2.7 倍）。脚本启动时会打印显卡占用与"检测到别的
 * python 转写进程"提醒 —— 那种数字只能当参考，不能当结论。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/deepseek/live_auto';
const DIR = path.join(ROOT, 'data', 'local-asr-test');
const PY = path.join(ROOT, '.venv-funasr', 'Scripts', 'python.exe');
const SCRIPT = path.join(ROOT, 'tools', 'local-asr', 'transcribe-funasr.py');
const NL = String.fromCharCode(10);
const PREFIX = '##ASR-PROGRESS##';

const batches = process.argv.slice(2).length ? process.argv.slice(2).map((x) => Number(x)) : [0, 60, 300];

function findSample() {
  for (const f of fs.readdirSync(DIR)) if (/^sample-300s\.(flv|mp4|mkv|ts)$/.test(f)) return path.join(DIR, f);
  throw new Error('找不到基准素材 data/local-asr-test/sample-300s.*（先跑 tools/local-asr/timing.ts 生成）');
}

function parseLastJson(text) {
  for (const line of text.split(NL).reverse()) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const j = JSON.parse(s);
      if (j.ok !== undefined) return j;
    } catch {
      /* 继续往前找 */
    }
  }
  return null;
}

function progressTicks(stderr) {
  const out = [];
  for (const line of String(stderr).split(NL)) {
    const at = line.indexOf(PREFIX);
    if (at < 0) continue;
    try {
      out.push(JSON.parse(line.slice(at + PREFIX.length).trim()));
    } catch {
      /* 忽略坏行 */
    }
  }
  return out;
}

function pythonAsrRunning() {
  const r = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
    '-NoProfile',
    '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*transcribe-funasr*' } | Measure-Object).Count",
  ], { encoding: 'utf8' });
  return Number(String(r.stdout || '0').trim()) || 0;
}

function runOnce(tag, file, batchSec) {
  const spec = {
    file,
    start_time: 0,
    end_time: 300,
    offset: 0,
    model: 'FunAudioLLM/Fun-ASR-Nano-2512',
    hub: 'ms',
    language: '中文',
    device: 'cuda',
    engine: 'pytorch',
    max_chars_per_cue: 18,
    min_cue_dur: 0.6,
    timestamps: true,
    llm_dtype: 'bf16',
    progress_batch_sec: batchSec,
  };
  const t0 = Date.now();
  const r = spawnSync(PY, [SCRIPT], {
    input: JSON.stringify(spec),
    encoding: 'utf8',
    timeout: 3600000,
    maxBuffer: 256 * 1024 * 1024,
    cwd: ROOT,
  });
  const wall = (Date.now() - t0) / 1000;
  const ticks = progressTicks(r.stderr);
  const asrTicks = ticks.filter((t) => t.phase === 'asr');
  const j = parseLastJson(String(r.stdout || ''));
  if (!j || j.ok === false) {
    const tail = String(j?.error ?? r.stderr ?? '').slice(-400);
    console.log(`   批=${String(batchSec).padStart(4)}s  失败：${tail}`);
    return { tag, batchSec, wall, ok: false, error: tail };
  }
  const cues = (j.segments || []).map((c) => ({ start: c.start, end: c.end, text: String(c.text || '') }));
  console.log(
    `   批=${String(batchSec).padStart(4)}s  墙钟 ${wall.toFixed(1)}s（推理 ${((j.asr_ms || 0) / 1000).toFixed(1)}s）` +
      `  实际批数 ${j.progress?.batches ?? '—'}  进度行 ${asrTicks.length} 条  速度 ${j.progress?.asr_speed ?? '—'}` +
      `  字幕 ${cues.length} 条  峰值显存 ${j.gpu_peak_mb ?? '—'} MB`,
  );
  return {
    tag,
    batchSec,
    wall,
    ok: true,
    asrSec: (j.asr_ms || 0) / 1000,
    batches: j.progress?.batches ?? null,
    tickCount: asrTicks.length,
    speed: j.progress?.asr_speed ?? null,
    peakMB: j.gpu_peak_mb ?? null,
    cues,
    tickSample: asrTicks.map((t) => ({ done: t.done_sec, speed: t.speed, seg: `${t.seg_done}/${t.seg_total}` })),
  };
}

const file = findSample();
const gpu = spawnSync('C:/Windows/System32/nvidia-smi.exe', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader'], { encoding: 'utf8' }).stdout.trim();
const others = pythonAsrRunning();
console.log(`  基准素材：${path.basename(file)}  ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
console.log(`  开始前显卡：${gpu}`);
console.log(`  同机其它转写进程：${others} 个${others > 0 ? '  ⚠️ 有并发转写在跑 —— 耗时只能当参考，别当结论' : ''}${NL}`);

const runs = [];
for (const b of batches) runs.push(runOnce(`batch-${b}`, file, b));

const base = runs.find((r) => r.ok && r.batchSec === 0) ?? runs.find((r) => r.ok);
if (base && runs.some((r) => r.ok)) {
  console.log(NL + '  ── 对比（同一段 300 秒素材，只差子批大小）──');
  const refCues = base.cues;
  for (const r of runs) {
    if (!r.ok) continue;
    const dBatch = r.asrSec - base.asrSec;
    const pct = base.asrSec ? (dBatch / base.asrSec) * 100 : 0;
    let same = 0;
    let diff = 0;
    for (let i = 0; i < Math.max(refCues.length, r.cues.length); i++) {
      const a = refCues[i];
      const b = r.cues[i];
      if (a && b && a.text === b.text) same++;
      else diff++;
    }
    console.log(
      `   批=${String(r.batchSec).padStart(4)}s  推理 ${r.asrSec.toFixed(1)}s（相对基准 ${dBatch >= 0 ? '+' : ''}${dBatch.toFixed(1)}s / ${pct.toFixed(1)}%）` +
        `  字幕 ${r.cues.length} 条（与基准逐字相同 ${same} / 不同 ${diff}）`,
    );
  }
  fs.writeFileSync(
    path.join(DIR, 'ab-progress-batch.json'),
    JSON.stringify({ file, at: new Date().toISOString(), gpuBefore: gpu, concurrentAsr: others, runs }, null, 2),
    'utf8',
  );
  console.log(NL + '   原始结果：data/local-asr-test/ab-progress-batch.json');
}
