/**
 * 真实端到端：让 **流水线的转写阶段** 走本地 Fun-ASR（不建任务、不投稿、不碰线上数据）。
 *
 * 为什么不能只靠单测：单测只覆盖 spec 组装与输出解析这些纯逻辑；
 * 「Transcriber 选对 provider → 起 Python 子进程 → 拿回带全局时间戳的段落 → 写进 transcript」
 * 这条链只有真跑一次才算数。而真跑一次要 ~2.5 分钟（模型加载 + 推理），
 * 所以做成工具而不是进 `npm run verify`。
 *
 * 用法：node tools/local-asr/provider-e2e.ts [样本路径] [秒数]
 */
import path from 'node:path';
import fs from 'node:fs';
import { Transcriber, AsrCache } from '../../src/asr.ts';
import { loadConfig } from '../../src/config.ts';
import { BiliLiveClient } from '../../src/api.ts';
import { log } from '../../src/logger.ts';
import { ROOT_DIR } from '../../src/util.ts';

const sample = process.argv[2] ?? path.join(ROOT_DIR, 'data', 'local-asr-test', 'known-300s.flv');
const seconds = Number(process.argv[3] ?? 300);

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string, extra?: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}

const store = loadConfig();
const cfg = store.config;
// 临时切到本地 provider（不改 config.json）
cfg.asr.provider = 'local-funasr';
cfg.asr.localFunasr.engine = 'pytorch'; // 明确走 PyTorch，避免 vLLM 探测的噪声
/* 把块长压到 15 分钟：配 30 分钟样本刚好切成 2 块，用来真实验证"大块 + 并行"这条链路
   （生产默认是 120 分钟/块、2 路并行；短素材只会得到 1 块，验证不了并行）。
   用法示例：node tools/local-asr/provider-e2e.ts data/local-asr-test/sample-1800s.flv 1800 */
cfg.asr.localFunasr.chunkMinutes = Number(process.env['E2E_CHUNK_MIN'] ?? 15);
cfg.asr.localFunasr.parallel = 2;
cfg.asr.concurrency = 2;

const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });
const cache = new AsrCache(path.join(ROOT_DIR, 'data', 'asr-cache'), log);
const tr = new Transcriber({ client, config: cfg, logger: log, cache });

const media = {
  segments: [{ path: sample, duration: seconds, globalStart: 0, globalEnd: seconds }],
  planCalls: (range: { start: number; end: number }) => [
    { file: sample, inFileStart: range.start, inFileEnd: range.end, globalStart: range.start, globalEnd: range.end, offset: 0, windowIndex: 0 },
  ],
};

console.log('\x1b[1m流水线转写阶段 × 本地 Fun-ASR\x1b[0m（真实子进程，零云端费用）');
console.log('─'.repeat(74));
console.log(`样本：${path.relative(ROOT_DIR, sample)}（${(fs.statSync(sample).size / 1024 ** 2).toFixed(1)} MB，${seconds} 秒）`);

const r = await tr.transcribe({
  taskId: 'local-funasr-e2e',
  media: media as never,
  totalDuration: seconds,
  force: true, // 忽略缓存，真的跑一遍
  onProgress: (p) => process.stdout.write(`\r  ${p.label}          `),
});
process.stdout.write('\n');

const segs = r.transcript.segments;
ok(r.transcript.source === 'local-funasr', '来源标记为 local-funasr（下游据此展示）', r.transcript.source);
ok(segs.length > 20, `拿到 ${segs.length} 条带时间戳的字幕`);
ok(r.paidCalls === 0, '**没有产生任何付费调用**', `paidCalls=${r.paidCalls}`);
ok((r.transcript.costEstimate ?? -1) === 0, '费用估算为 0（不会显示假的 ¥8.5）', String(r.transcript.costEstimate));
ok((r.transcript.audioSeconds ?? -1) === 0, '计费音频为 0 秒');

const sorted = segs.every((s, i) => i === 0 || s.start >= segs[i - 1]!.start);
ok(sorted, '按时间递增排列');
const inRange = segs.every((s) => s.start >= 0 && s.end <= seconds + 2 && s.end > s.start);
ok(inRange, `时间戳都落在 [0, ${seconds}] 内（否则整场错位）`);
const withPunct = segs.filter((s) => /[，。！？、；：]/.test(s.text)).length;
ok(withPunct > segs.length * 0.3, `自带标点的条目 ${withPunct}/${segs.length}（Fun-ASR 的优势，利于字幕断句）`);
const avgDur = segs.reduce((a, s) => a + (s.end - s.start), 0) / (segs.length || 1);
ok(avgDur > 0.3 && avgDur < 8, `平均时长 ${avgDur.toFixed(2)}s（既不一闪而过，也不挂屏）`);

console.log('\n  前 6 条：');
for (const s of segs.slice(0, 6)) console.log(`    ${s.start.toFixed(2).padStart(7)}–${s.end.toFixed(2).padStart(7)}s  ${s.text}`);
console.log(`\n  墙钟：${(r.durationMs / 1000).toFixed(1)}s（含模型加载）`);
if (r.warnings.length) {
  console.log('  警告：');
  for (const w of r.warnings) console.log(`    - ${w}`);
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (fail > 0) process.exitCode = 1;
