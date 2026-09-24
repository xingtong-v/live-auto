/**
 * 本地 Fun-ASR 的耗时构成：固定成本（模型加载）与推理速率。
 *
 * 为什么要实测而不是拍脑袋：本地 Fun-ASR 的 runner 是**一次性子进程**，
 * 每个进程都要把 0.6B 模型加载一遍（约 90–100 秒）—— 这一块与音频长短**无关**。
 * 于是"3 分钟的片段要多久"这种问题，答案几乎全由这个固定成本决定，
 * 而它只能靠两个不同时长的实测点解出来：
 *
 *     wall = L（加载） + r（每秒音频的推理耗时） × 时长
 *
 * 做法：同一个素材文件、同一台机器、同一份配置，只改窗口长度跑两次，解出 L 与 r，
 * 再外推给常见时长。零费用（本地推理，只占 GPU）。
 *
 * 用法：node tools/local-asr/timing.ts [窗口秒数A] [窗口秒数B]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { BiliLiveClient } from '../../src/api.ts';
import { AsrCache, Transcriber } from '../../src/asr.ts';
import { log } from '../../src/logger.ts';
import { ROOT_DIR } from '../../src/util.ts';

const OUT = path.join(ROOT_DIR, 'data', 'local-asr-test');
const SAMPLE = path.join(OUT, 'sample-300s.flv');
const A = Number(process.argv[2] ?? 180);
const B = Number(process.argv[3] ?? 300);

const cfg = loadConfig().config;
cfg.asr.provider = 'local-funasr';
cfg.runtime.allowPaid = false;

async function timeit(span: number): Promise<{ span: number; ms: number; segments: number }> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `timing-${span}-`));
  const tr = new Transcriber({
    client: BiliLiveClient.fromConfig(cfg, log),
    config: cfg,
    cache: new AsrCache(cacheDir, log),
  });
  const t0 = Date.now();
  const res = await tr.transcribe({
    taskId: `timing-${span}`,
    totalDuration: span,
    media: {
      planCalls: () => [{ file: SAMPLE, inFileStart: 0, inFileEnd: span, offset: 0, globalStart: 0, globalEnd: span, windowIndex: 0 }],
      fileStat: (f) => ({ size: fs.statSync(f).size, updatedAt: Math.round(fs.statSync(f).mtimeMs) }),
    },
    allowPaid: false,
  });
  const ms = Date.now() - t0;
  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log(`  ${span}s 音频 → 墙钟 ${(ms / 1000).toFixed(1)}s，${res.transcript.segments.length} 条字幕`);
  return { span, ms, segments: res.transcript.segments.length };
}

console.log('本地 Fun-ASR 耗时构成实测（同一素材、只改窗口）');
console.log(`素材：${path.relative(ROOT_DIR, SAMPLE)}；设备 auto（CUDA）\n`);
const r1 = await timeit(A);
const r2 = await timeit(B);

const r = (r2.ms - r1.ms) / (r2.span - r1.span); // 每秒音频的推理毫秒
const L = r1.ms - r * r1.span; // 固定成本（加载 + 进程启动 + 音频抽轨）
console.log(`\n解出：固定成本 L ≈ ${(L / 1000).toFixed(1)}s，推理速率 r ≈ ${(r / 1000).toFixed(3)} × 实时的毫秒/秒`);
console.log(`（r = ${(r / 1000).toFixed(3)} 表示 1 秒音频约需 ${r.toFixed(0)}ms 推理）\n`);

const rows: Array<[string, number]> = [
  ['3 分钟（一个切片）', 180],
  ['10 分钟', 600],
  ['30 分钟（一段）', 1800],
  ['1 小时（一段录播）', 3600],
  ['4 小时 15 分（一整场）', 15300],
];
console.log('外推（wall = L + r × 时长）：');
for (const [label, sec] of rows) {
  const total = L + r * sec;
  const ratio = total / 1000 / sec;
  console.log(
    `  ${label.padEnd(22)} ${(total / 1000 / 60).toFixed(1)} 分钟` +
      `（= 实时的 ${ratio.toFixed(2)}×，其中加载占 ${((L / total) * 100).toFixed(0)}%）`,
  );
}
console.log('\n对照：云端 fun-asr 同一段 300 秒实测 ~11s（含转码+上传，无固定成本）。');
