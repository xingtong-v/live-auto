/**
 * 下载 torch/torchaudio 的 CUDA wheel（可中断、可续传、进度可观测）。
 *
 * ## 为什么单独写一个下载器
 *
 * 实测在这台机器/这条网络上，把 torch 装进本地环境连续踩了三个坑：
 *  ① `pip install --index-url https://download.pytorch.org/whl/cu126` —— 下到一半 ReadTimeoutError；
 *  ② 国内镜像 `mirrors.aliyun.com/pytorch-wheels/cu126/` 是**扁平文件列表**、不是 PEP 503 索引，
 *     必须 `--find-links` 才能被 pip 认出来；
 *  ③ 即便用 find-links 让 pip 去下，pip 自己的下载器仍会**静默停滞**（实测卡在 595 MB 九分钟、无任何报错）；
 *     而 `curl -C - --retry` 组合在后台跑同样会卡在 0 字节。
 *     **朴素 `curl -L -o file url` 反而稳定**（实测 620 KB/s），所以这里就用它 + 轮询续传。
 *
 * 用法：
 *   node tools/local-asr/download-torch.mjs            # 断点续传，直到下完
 *   node tools/local-asr/download-torch.mjs --status   # 只看进度
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'data', 'local-asr-test', 'wheels');
const LOG = path.join(ROOT, 'data', 'local-asr-test', 'download-torch.log');
fs.mkdirSync(DIR, { recursive: true });

const VERSION = '2.9.1'; // torch 与 torchaudio 必须配套；镜像上 2.9.1 两侧都有 cp312/win
const MIRRORS = ['https://mirrors.aliyun.com/pytorch-wheels/cu126', 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu126'];

/** 期望大小（字节）：用于判断"下完了没有"。官方 wheel 大小固定，容差 1%。 */
const EXPECTED = {
  'torch-2.9.1+cu126-cp312-cp312-win_amd64.whl': 2_584_508_946,
  // torchaudio 的 Windows 轮子很小（约 2 MB，主体依赖 torch）—— 一开始用 ">5MB" 判完成，永远判不了
  'torchaudio-2.9.1+cu126-cp312-cp312-win_amd64.whl': 2_050_329,
};

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}

const tasks = ['torch', 'torchaudio'].map((pkg) => {
  const file = path.join(DIR, `${pkg}-${VERSION}+cu126-cp312-cp312-win_amd64.whl`);
  return { pkg, file, expected: EXPECTED[`${pkg}-${VERSION}+cu126-cp312-cp312-win_amd64.whl`] ?? null };
});

function sizeOf(f) {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}
const done = (t) => (t.expected ? sizeOf(t.file) >= t.expected * 0.99 : sizeOf(t.file) > 1024 * 1024);

if (process.argv.includes('--status')) {
  for (const t of tasks) {
    const s = sizeOf(t.file);
    console.log(`${t.pkg.padEnd(12)} ${(s / 1024 ** 2).toFixed(1)} MB${t.expected ? ` / ${(t.expected / 1024 ** 2).toFixed(0)} MB` : ''}${done(t) ? '  ✓ 完成' : ''}`);
  }
  process.exit(0);
}

/* 逐个下：一次一个连接，避免互相抢带宽 */
for (const t of tasks) {
  if (done(t)) {
    log(`${t.pkg} 已就绪（${(sizeOf(t.file) / 1024 ** 2).toFixed(0)} MB），跳过`);
    continue;
  }
  let attempt = 0;
  while (attempt < 40 && !done(t)) {
    attempt++;
    const mirror = MIRRORS[(attempt - 1) % MIRRORS.length];
    const url = `${mirror}/${t.pkg}-${VERSION}%2Bcu126-cp312-cp312-win_amd64.whl`;
    const before = sizeOf(t.file);
    log(`${t.pkg} 第 ${attempt} 次尝试（当前 ${(before / 1024 ** 2).toFixed(1)} MB）← ${mirror}`);
    /* 有半截文件就续传，没有就新下。
       单次命令加 --max-time：卡住时不会永远挂着，交给下一轮循环重试。 */
    const args = ['-L', ...(before > 0 ? ['-C', '-'] : []), '-sS', '--connect-timeout', '30', '--max-time', '1200', '-o', t.file, url];
    spawnSync('curl', args, { stdio: 'ignore', timeout: 1300_000 });
    const after = sizeOf(t.file);
    log(`  → ${(after / 1024 ** 2).toFixed(1)} MB（本次 +${((after - before) / 1024 ** 2).toFixed(1)} MB）`);
    if (after === before) {
      log('  本轮没有增长，5 秒后重试（网络抖动或镜像限速）');
      spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 5'], { stdio: 'ignore' });
    }
  }
  if (!done(t)) {
    log(`✗ ${t.pkg} 下载未完成，请重跑本脚本续传`);
    process.exit(1);
  }
  log(`✓ ${t.pkg} 下载完成：${(sizeOf(t.file) / 1024 ** 2).toFixed(0)} MB`);
}
log('两个 wheel 都已就绪，可以执行：node tools/local-asr/setup-funasr.mjs');
