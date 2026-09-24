/** 装 CPU 包二进制 + 补下 FSMN-VAD 模型 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = 'F:/deepseek/live_auto/.funasr';
const BIN = path.join(DIR, 'bin');
const DL = path.join(DIR, 'download');
fs.mkdirSync(BIN, { recursive: true });

// 1) CPU 包解压到 bin-cpu（避免覆盖 CUDA 的 sensevoice）
const cpuZip = path.join(DL, 'funasr-llamacpp-windows-x64.zip');
if (!fs.existsSync(cpuZip)) throw new Error(`缺少 ${cpuZip}`);
const BINCPU = path.join(DIR, 'bin-cpu');
fs.rmSync(BINCPU, { recursive: true, force: true });
fs.mkdirSync(BINCPU, { recursive: true });
execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${cpuZip}' -DestinationPath '${BINCPU}' -Force`]);
console.log('=== CPU 包已解压到 .funasr/bin-cpu ===');
for (const f of fs.readdirSync(BINCPU)) console.log(`  ${f}`);

// 2) 补下 FSMN-VAD（正确仓库：FunAudioLLM/fsmn-vad-GGUF）
const vadOut = path.join(DIR, 'models', 'fsmn-vad.gguf');
fs.mkdirSync(path.dirname(vadOut), { recursive: true });
if (!fs.existsSync(vadOut)) {
  const url = 'https://hf-mirror.com/FunAudioLLM/fsmn-vad-GGUF/resolve/main/fsmn-vad.gguf';
  console.log(`\n=== 下载 FSMN-VAD ===\n  ${url}`);
  const r = await fetch(url, { headers: { 'User-Agent': 'node' }, redirect: 'follow' });
  if (!r.ok) {
    console.log(`  ✗ HTTP ${r.status}`);
  } else {
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(vadOut, buf);
    console.log(`  ✓ ${(buf.length / 1024 ** 2).toFixed(1)} MB → ${vadOut}`);
  }
} else {
  console.log(`\n  FSMN-VAD 已存在（${(fs.statSync(vadOut).size / 1024 ** 2).toFixed(1)} MB）`);
}

// 3) 把模型统一放到 .funasr/models 便于引用
const MODELS = path.join(DIR, 'models');
fs.mkdirSync(MODELS, { recursive: true });
for (const f of ['funasr-encoder-f16.gguf', 'qwen3-0.6b-q5km.gguf']) {
  const src = path.join(DL, f);
  const dst = path.join(MODELS, f);
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    fs.copyFileSync(src, dst);
    console.log(`  已放置 ${f}`);
  }
}

console.log('\n=== 最终目录结构 ===');
console.log('  .funasr/bin       (CUDA: sensevoice + cublas)');
console.log('  .funasr/bin-cpu   (CPU: cli/paraformer/sensevoice/vad)');
console.log('  .funasr/models    (gguf 模型)');
for (const f of fs.readdirSync(MODELS)) {
  console.log(`    ${f}  ${(fs.statSync(path.join(MODELS, f)).size / 1024 ** 2).toFixed(1)} MB`);
}
const total = (d: string): number =>
  fs.readdirSync(d, { recursive: true }).reduce((a, x) => {
    const p = path.join(d, String(x));
    try { return a + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); } catch { return a; }
  }, 0);
console.log(`\n  .funasr 总占用: ${(total(DIR) / 1024 ** 2).toFixed(0)} MB`);
