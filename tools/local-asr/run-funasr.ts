/** 用二进制方式捕获 FunASR 输出（避免 PowerShell 重定向的 UTF-16 转码） */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const MODELS = 'F:/deepseek/live_auto/.funasr/models';
const WAV = 'F:/deepseek/live_auto/data/local-asr-test/s300.wav';
const OUT = 'F:/deepseek/live_auto/data/local-asr-test';

/** 把可能是 UTF-16 的 buffer 解成字符串 */
function decode(buf: Buffer): string {
  const s = buf.toString('utf8');
  // UTF-8 解码后若出现大量 NUL，说明原数据是 UTF-16
  if (s.includes('\u0000') || (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return s.replace(/^\uFEFF/, '');
}

const runs: Array<{ name: string; exe: string; args: string[]; out: string; note: string }> = [
  {
    name: 'Fun-ASR-Nano (CPU)',
    exe: 'F:/deepseek/live_auto/.funasr/bin-cpu/llama-funasr-cli.exe',
    args: ['--enc', `${MODELS}/funasr-encoder-f16.gguf`, '-m', `${MODELS}/qwen3-0.6b-q5km.gguf`, '--vad', `${MODELS}/fsmn-vad.gguf`, '-a', WAV, '--srt'],
    out: `${OUT}/r-nano.srt`,
    note: 'CPU',
  },
  {
    name: 'SenseVoiceSmall (CUDA)',
    exe: 'F:/deepseek/live_auto/.funasr/bin/llama-funasr-sensevoice.exe',
    args: ['-m', `${MODELS}/sensevoice-small-q8.gguf`, '--vad', `${MODELS}/fsmn-vad.gguf`, '-a', WAV, '--srt', '--backend', 'cuda'],
    out: `${OUT}/r-sensevoice-cuda.srt`,
    note: 'GPU',
  },
  {
    name: 'SenseVoiceSmall (CPU)',
    exe: 'F:/deepseek/live_auto/.funasr/bin-cpu/llama-funasr-sensevoice.exe',
    args: ['-m', `${MODELS}/sensevoice-small-q8.gguf`, '--vad', `${MODELS}/fsmn-vad.gguf`, '-a', WAV, '--srt', '--backend', 'cpu'],
    out: `${OUT}/r-sensevoice-cpu.srt`,
    note: 'CPU',
  },
];

for (const r of runs) {
  const t0 = Date.now();
  try {
    // stderr 里全是模型加载诊断（几百行），这里丢掉；只看 stdout 的 SRT
    const stdout = execFileSync(r.exe, r.args, {
      encoding: 'buffer',
      timeout: 30 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const wall = (Date.now() - t0) / 1000;
    const text = decode(stdout);
    fs.writeFileSync(r.out, text, 'utf8'); // 统一写成 UTF-8
    const cues = text.split('\n').filter((l) => l.includes('-->')).length;
    console.log(`  ${r.name.padEnd(26)} ${wall.toFixed(1).padStart(6)}s  RTF=${(wall / 300).toFixed(3)}  ${String(cues).padStart(3)} 条  已存 ${r.out.split('/').pop()}`);
  } catch (e) {
    const wall = (Date.now() - t0) / 1000;
    const err = e as { stderr?: Buffer; message?: string };
    console.log(`  ${r.name.padEnd(26)} ✗ 失败 ${wall.toFixed(1)}s: ${err.message?.slice(0, 100)}`);
    if (err.stderr) console.log(`      ${decode(err.stderr).slice(-200)}`);
  }
}

console.log('\n=== 抽样检查（SenseVoice CUDA 前 12 条）===');
const sv = fs.readFileSync(`${OUT}/r-sensevoice-cuda.srt`, 'utf8').split(/\r?\n/);
for (const l of sv.slice(0, 20)) if (l.trim() && l !== '\uFEFF') console.log('  ' + l);
