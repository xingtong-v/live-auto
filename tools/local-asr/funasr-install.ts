/** 下载 FunASR llama.cpp 运行时（Windows CUDA）+ GGUF 模型 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = 'F:/deepseek/live_auto/.funasr';
const DL = path.join(DIR, 'download');
fs.mkdirSync(DL, { recursive: true });

const API = 'https://api.github.com/repos/modelscope/FunASR/releases/latest';

async function dl(url: string, out: string, label: string): Promise<void> {
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
    console.log(`  [跳过] ${label}（已存在 ${(fs.statSync(out).size / 1024 ** 2).toFixed(1)} MB）`);
    return;
  }
  const t0 = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': 'node' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const total = Number(r.headers.get('content-length') ?? 0);
  const chunks: Uint8Array[] = [];
  let got = 0;
  let lastLog = 0;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    got += chunk.length;
    const now = Date.now();
    if (now - lastLog > 3000) {
      lastLog = now;
      const pct = total ? ((got / total) * 100).toFixed(0) : '?';
      process.stdout.write(`\r    ${label}: ${(got / 1024 ** 2).toFixed(1)}/${(total / 1024 ** 2).toFixed(1)} MB (${pct}%)`);
    }
  }
  fs.writeFileSync(out, Buffer.concat(chunks));
  const secs = (Date.now() - t0) / 1000;
  process.stdout.write(`\r    ${label}: ${(got / 1024 ** 2).toFixed(1)} MB 完成，${secs.toFixed(0)}s（${(got / 1024 ** 2 / secs).toFixed(1)} MB/s）\n`);
}

// 1) 运行时
console.log('=== 1) FunASR llama.cpp 运行时（Windows x64 CUDA）===');
const rel = (await (await fetch(API, { headers: { 'User-Agent': 'node' } })).json()) as {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
};
console.log(`  最新版本 ${rel.tag_name}`);
const cuda = rel.assets.find((a) => /windows-x64-cuda\.zip$/i.test(a.name));
if (!cuda) throw new Error(`没找到 CUDA 版 Windows 包；现有：${rel.assets.map((a) => a.name).join(', ')}`);
console.log(`  目标 ${cuda.name}  ${(cuda.size / 1024 ** 2).toFixed(0)} MB`);
const zipPath = path.join(DL, cuda.name);
await dl(cuda.browser_download_url, zipPath, cuda.name);

// 2) 模型（走 hf-mirror）
console.log('\n=== 2) GGUF 模型（走 hf-mirror.com）===');
const HF = 'https://hf-mirror.com/FunAudioLLM/Fun-ASR-Nano-GGUF/resolve/main';
const files: Array<[string, string]> = [
  ['funasr-encoder-f16.gguf', '编码器 470 MB'],
  ['qwen3-0.6b-q5km.gguf', '解码器 LLM（精度最好）551 MB'],
];
for (const [f, desc] of files) {
  console.log(`  ${f} —— ${desc}`);
  await dl(`${HF}/${f}`, path.join(DL, f), f);
}

// 3) VAD 模型（可选，README 里命令行带 --vad）
console.log('\n=== 3) VAD 模型 ===');
for (const cand of ['fsmn-vad.gguf', 'fsmn-vad/final.gguf']) {
  try {
    await dl(`${HF}/${cand}`, path.join(DL, 'fsmn-vad.gguf'), cand);
    break;
  } catch (e) {
    console.log(`    ${cand} 取不到：${(e as Error).message.slice(0, 80)}`);
  }
}

// 4) 解压运行时
console.log('\n=== 4) 解压运行时 ===');
const exeDir = path.join(DIR, 'bin');
fs.mkdirSync(exeDir, { recursive: true });
try {
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${exeDir}' -Force`], { stdio: 'inherit' });
  console.log(`  已解压到 ${exeDir}`);
} catch (e) {
  console.log(`  解压失败：${(e as Error).message}`);
}
console.log('\n  目录内容：');
for (const f of fs.readdirSync(exeDir, { recursive: true })) {
  const p = path.join(exeDir, String(f));
  try {
    if (fs.statSync(p).isFile()) console.log(`    ${f}  ${(fs.statSync(p).size / 1024 ** 2).toFixed(1)} MB`);
  } catch { /* 目录 */ }
}
