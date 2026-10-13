/**
 * bf16 A/B 实测（一次性工具，不进 verify 链）：`node tools/local-asr/ab-llm-dtype.mjs`
 *
 * 同一段基准素材，用同参数分别跑 fp32（默认）与 bf16，量四件事：
 *   ① 显存峰值（取自执行器的 torch 计数器，见 transcribe-funasr.py 的 gpu_peak_mb）
 *   ② 墙钟耗时与推理耗时   ③ 字幕条数   ④ 文本差异与时间戳偏移
 *
 * 结果写到 data/local-asr-test/ab-llm-dtype.json，控制台打对比表。
 *
 * ⚠️ 走过的弯路（留作教训）：
 *   第一版用 `spawnSync('pwsh', …)` 在 Node 里再起一层 pwsh、由那层 Start-Process 起 python 并
 *   采样 GPU 性能计数器 —— 结果两层都"安静地失败"：函数返回 0 秒 / 0 条字幕，看起来像"测到了零"。
 *   现在改成 Node 直接同步调 python（spec 走 stdin，读 stdout 的 JSON），显存由 python 自己报，
 *   既少一层、又不会被同机运行的游戏干扰。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/deepseek/live_auto';
const DIR = path.join(ROOT, 'data', 'local-asr-test');
const PY = path.join(ROOT, '.venv-funasr', 'Scripts', 'python.exe');
const SCRIPT = path.join(ROOT, 'tools', 'local-asr', 'transcribe-funasr.py');
const NL = String.fromCharCode(10);

function findSample() {
  for (const f of fs.readdirSync(DIR)) if (/^sample-300s\.(flv|mp4|mkv|ts)$/.test(f)) return path.join(DIR, f);
  throw new Error('找不到基准素材 data/local-asr-test/sample-300s.*');
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

function runOnce(tag, file, llmDtype) {
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
    ...(llmDtype ? { llm_dtype: llmDtype } : {}),
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
  fs.writeFileSync(path.join(DIR, `out-${tag}.raw.txt`), String(r.stdout || ''), 'utf8');
  fs.writeFileSync(path.join(DIR, `err-${tag}.log`), String(r.stderr || ''), 'utf8');
  const j = parseLastJson(String(r.stdout || ''));
  if (!j) {
    const tail = String(r.stderr || '').slice(-500);
    console.log(`   ${tag.padEnd(5)} 失败：没解析到结果 JSON。stderr 末尾：${tail}`);
    return { tag, wall, ok: false, cues: [], error: tail };
  }
  if (j.ok === false) {
    console.log(`   ${tag.padEnd(5)} 失败：${String(j.error).slice(0, 200)}`);
    return { tag, wall, ok: false, cues: [], error: String(j.error) };
  }
  const cues = (j.segments || []).map((c) => ({ start: c.start, end: c.end, text: String(c.text || '') }));
  console.log(
    `   ${tag.padEnd(5)} 墙钟 ${wall.toFixed(1)}s（推理 ${((j.asr_ms || 0) / 1000).toFixed(1)}s）` +
      `  峰值显存 ${j.gpu_peak_mb ?? '—'} MB（池 ${j.gpu_reserved_mb ?? '—'}）  字幕 ${cues.length} 条  精度 ${j.llm_dtype ?? '—'}`,
  );
  return { tag, wall, ok: true, asrSec: (j.asr_ms || 0) / 1000, peakMB: j.gpu_peak_mb, reservedMB: j.gpu_reserved_mb, dtype: j.llm_dtype, scrubbed: j.text_scrubbed ?? 0, cues };
}

function compare(a, b) {
  const n = Math.max(a.cues.length, b.cues.length);
  let same = 0,
    changed = 0,
    onlyA = 0,
    onlyB = 0,
    charTotal = 0,
    charDiff = 0,
    maxStartDiff = 0;
  const samples = [];
  for (let i = 0; i < n; i++) {
    const x = a.cues[i];
    const y = b.cues[i];
    if (x && !y) { onlyA++; continue; }
    if (!x && y) { onlyB++; continue; }
    if (!x || !y) continue;
    if (x.text === y.text) same++;
    else {
      changed++;
      if (samples.length < 6) samples.push({ i, start: x.start, fp32: x.text, bf16: y.text });
    }
    maxStartDiff = Math.max(maxStartDiff, Math.abs((x.start ?? 0) - (y.start ?? 0)));
    charTotal += Math.max(x.text.length, y.text.length);
    let d = Math.abs(x.text.length - y.text.length);
    for (let k = 0; k < Math.min(x.text.length, y.text.length); k++) if (x.text[k] !== y.text[k]) d++;
    charDiff += d;
  }
  return { same, changed, onlyA, onlyB, charDiffRate: charTotal ? charDiff / charTotal : 0, maxStartDiff, samples };
}

const file = findSample();
const gpuBefore = spawnSync('C:/Windows/System32/nvidia-smi.exe', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader'], { encoding: 'utf8' }).stdout.trim();
console.log(`  基准素材：${path.basename(file)}  ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
console.log(`  开始前显卡：${gpuBefore}${/^9\d|^8\d/.test(gpuBefore) ? '  ⚠️ 有别的重负载在跑（游戏），耗时仅供参考' : ''}${NL}`);
const fp32 = runOnce('fp32', file, '');
const bf16 = runOnce('bf16', file, 'bf16');
if (fp32.ok && bf16.ok) {
  const c = compare(fp32, bf16);
  console.log(NL + '  ── 对比（同一段 300 秒素材、同参数，只差解码器精度）──');
  console.log(`   峰值显存：fp32 ${fp32.peakMB} MB  →  bf16 ${bf16.peakMB} MB${fp32.peakMB && bf16.peakMB ? `   （降 ${(((fp32.peakMB - bf16.peakMB) / fp32.peakMB) * 100).toFixed(0)}%）` : ''}`);
  console.log(`   墙钟耗时：fp32 ${fp32.wall.toFixed(1)}s  →  bf16 ${bf16.wall.toFixed(1)}s${fp32.wall ? `   （${(((fp32.wall - bf16.wall) / fp32.wall) * 100).toFixed(0)}% 变化）` : ''}`);
  console.log(`   推理耗时：fp32 ${fp32.asrSec.toFixed(1)}s  →  bf16 ${bf16.asrSec.toFixed(1)}s`);
  console.log(`   字幕条数：fp32 ${fp32.cues.length}  →  bf16 ${bf16.cues.length}`);
  console.log(`   文本对比：完全相同 ${c.same} 条 / 有差异 ${c.changed} 条（字符差异率 ${(c.charDiffRate * 100).toFixed(2)}%）`);
  console.log(`   时间戳最大偏移：${c.maxStartDiff.toFixed(3)} 秒`);
  if (fp32.scrubbed || bf16.scrubbed) console.log(`   非法字符擦除：fp32 ${fp32.scrubbed} 处 / bf16 ${bf16.scrubbed} 处`);
  if (c.samples.length) {
    console.log('   差异样例：');
    for (const s of c.samples) console.log(`     #${s.i} @${s.start}s  fp32「${s.fp32}」  bf16「${s.bf16}」`);
  }
  fs.writeFileSync(path.join(DIR, 'ab-llm-dtype.json'), JSON.stringify({ file, at: new Date().toISOString(), gpuBefore, fp32, bf16, cmp: c }, null, 2), 'utf8');
  console.log(NL + '   原始结果：data/local-asr-test/ab-llm-dtype.json');
} else {
  console.log(NL + '   有一次没跑通，未做对比（看上面的失败原因）。');
}
