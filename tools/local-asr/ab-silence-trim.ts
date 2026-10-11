/**
 * A/B 实测：剪静音（`asr.silenceTrim`）到底能省多少时间、会不会伤内容。
 *
 * 为什么要实测：本机是**本地 Fun-ASR**（CPU/GPU 都吃），而成本 ∝ **VAD 段数**而不是音频时长
 * （实测 11.7 s/段）⇒ 静音少送一段就省一段。但"省"必须用同一素材、同一台机器、同一份配置量出来，
 * 而且必须验证两件事：① 字幕条数与覆盖时长不能被削掉；② 时间戳映射仍然对得上
 * （剪静音最容易出的错是"内容对了、时间戳整体前移"，那会直接毁掉字幕/弹幕对齐）。
 *
 * 用法：
 *   node tools/local-asr/ab-silence-trim.ts "<媒体文件>" [--minutes N] [--trim]
 * 输出：一行 JSON（便于两次运行比对）+ 前 5 条字幕样例。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { BiliLiveClient } from '../../src/api.ts';
import { AsrCache, Transcriber } from '../../src/asr.ts';
import { log } from '../../src/logger.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) throw new Error('用法：node tools/local-asr/ab-silence-trim.ts "<媒体文件>" [--minutes N] [--trim]');
const minutes = (() => {
  const i = args.indexOf('--minutes');
  return i >= 0 ? Number(args[i + 1]) : undefined;
})();
const trim = args.includes('--trim');

const cfg = loadConfig().config;
cfg.asr.provider = 'local-funasr';
cfg.runtime.allowPaid = false;
cfg.asr.silenceTrim.enabled = trim;
/* 单块：这样 A/B 的差别就**只有剪静音**，不会掺进分块/并行的影响 */
cfg.asr.localFunasr.chunkMinutes = 360;

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `ab-trim-${trim ? 'on' : 'off'}-`));
const tr = new Transcriber({
  client: BiliLiveClient.fromConfig(cfg, log),
  config: cfg,
  cache: new AsrCache(cacheDir, log),
});

const span = (minutes ? minutes * 60 : 3600) as number;
const t0 = Date.now();
const res = await tr.transcribe({
  taskId: `ab-${trim ? 'trim' : 'plain'}-${Date.now()}`,
  totalDuration: span,
  media: {
    planCalls: () => [
      { file, inFileStart: 0, inFileEnd: span, offset: 0, globalStart: 0, globalEnd: span, windowIndex: 0 },
    ],
    fileStat: (f: string) => ({ size: fs.statSync(f).size, updatedAt: Math.round(fs.statSync(f).mtimeMs) }),
  },
  allowPaid: false,
});
const wallSec = Number(((Date.now() - t0) / 1000).toFixed(1));

const segs = res.transcript.segments ?? [];
const covered = segs.reduce((a, s) => a + Math.max(0, (s.end ?? 0) - (s.start ?? 0)), 0);
const summary = {
  file: path.basename(file),
  trim,
  requestSec: span,
  wallSec,
      cues: segs.length,
  coveredSec: Number(covered.toFixed(1)),
  firstCue: segs[0] ? { start: segs[0].start, text: String(segs[0].text ?? '').slice(0, 24) } : null,
  lastCue: segs.length ? { start: segs[segs.length - 1]!.start, text: String(segs[segs.length - 1]!.text ?? '').slice(0, 24) } : null,
  cacheHit: Boolean((res as { cached?: boolean }).cached),
};
console.log('\n=== AB RESULT ===');
console.log(JSON.stringify(summary));
console.log('前 5 条字幕：');
for (const s of segs.slice(0, 5)) console.log(`  [${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${String(s.text ?? '').slice(0, 40)}`);
fs.rmSync(cacheDir, { recursive: true, force: true });
