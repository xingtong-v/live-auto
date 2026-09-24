/** 下载 SenseVoiceSmall GGUF（CUDA 版 sensevoice.exe 需要它），并用 GPU 跑同一段素材 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const MODELS = 'F:/deepseek/live_auto/.funasr/models';
fs.mkdirSync(MODELS, { recursive: true });

async function dl(url: string, out: string, label: string): Promise<boolean> {
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
    console.log(`  [跳过] ${label}（${(fs.statSync(out).size / 1024 ** 2).toFixed(1)} MB）`);
    return true;
  }
  const r = await fetch(url, { headers: { 'User-Agent': 'node' }, redirect: 'follow' });
  if (!r.ok) {
    console.log(`  ✗ ${label}: HTTP ${r.status}`);
    return false;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(out, buf);
  console.log(`  ✓ ${label}: ${(buf.length / 1024 ** 2).toFixed(1)} MB`);
  return true;
}

console.log('=== 下载 SenseVoiceSmall GGUF ===');
const HF = 'https://hf-mirror.com/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/main';
let ok = false;
for (const f of ['sensevoice-small-q8.gguf', 'sensevoice-small-f16.gguf']) {
  if (await dl(`${HF}/${f}`, `${MODELS}/${f}`, f)) {
    ok = true;
    break;
  }
}
if (!ok) {
  console.log('\n两个变体都取不到，列出仓库文件清单：');
  const r = await fetch('https://hf-mirror.com/api/models/FunAudioLLM/SenseVoiceSmall-GGUF', { headers: { 'User-Agent': 'node' } });
  const j = (await r.json()) as { siblings?: Array<{ rfilename: string }> };
  for (const s of j.siblings ?? []) console.log(`  ${s.rfilename}`);
  process.exit(1);
}

// 用 CUDA 版跑（该包只有 sensevoice 支持 CUDA）
const exe = 'F:/deepseek/live_auto/.funasr/bin/llama-funasr-sensevoice.exe';
const model = fs.existsSync(`${MODELS}/sensevoice-small-q8.gguf`)
  ? `${MODELS}/sensevoice-small-q8.gguf`
  : `${MODELS}/sensevoice-small-f16.gguf`;

for (const backend of ['cuda', 'cpu']) {
  console.log(`\n=== SenseVoiceSmall  backend=${backend}  （5 分钟素材）===`);
  const outSrt = `F:/deepseek/live_auto/data/local-asr-test/sensevoice-${backend}-300s.srt`;
  const t0 = Date.now();
  try {
    const res = execFileSync(exe, [
      '-m', model,
      '--vad', `${MODELS}/fsmn-vad.gguf`,
      '-a', 'F:/deepseek/live_auto/data/local-asr-test/s300.wav',
      '--srt',
      '--backend', backend,
    ], { encoding: 'buffer', timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    const wall = (Date.now() - t0) / 1000;
    fs.writeFileSync(outSrt, res);
    const cues = String(res).split('\n').filter((l) => l.includes('-->')).length;
    console.log(`  ✓ 墙钟 ${wall.toFixed(1)}s  RTF=${(wall / 300).toFixed(3)}  ${cues} 条字幕`);
  } catch (e) {
    const wall = (Date.now() - t0) / 1000;
    const err = e as { stderr?: Buffer; message?: string };
    console.log(`  ✗ 失败（${wall.toFixed(1)}s）：${err.message?.slice(0, 120)}`);
    if (err.stderr) console.log(`     stderr: ${String(err.stderr).slice(-300)}`);
  }
}
