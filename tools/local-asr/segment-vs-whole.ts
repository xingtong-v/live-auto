/**
 * 「边录边转写」可行性验证（2026-10-11，优化第二批 ④ 的第一步）。
 *
 * 要回答的问题（先证明再改主链）：
 *   ① **等价性**：把一段素材切成两半分别转写、再按偏移拼起来，与"整段一起转写"相比，
 *      字幕条数 / 覆盖语音时长 / 首末时间戳是否一致？（不一致的话，边录边转写会改变出片质量）
 *   ② **缓存**：分段转写与整段转写的缓存键是否不同（不同 ⇒ 增量路径是"替代"整段路径，
 *      不会出现同一段音频被转两遍、也不会命中半截缓存）。
 *
 * 做法：不动主链、不碰台账。用 ffmpeg 把同一素材切成两半（-c copy，无重编码），
 * 三次转写（整段 / 前半 / 后半）各用独立临时缓存，最后只比数字。
 *
 * 用法：node tools/local-asr/segment-vs-whole.ts "<媒体文件>" [--minutes N] [--at 秒]
 */
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from '../../src/av-sync.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { BiliLiveClient } from '../../src/api.ts';
import { AsrCache, Transcriber } from '../../src/asr.ts';
import { log } from '../../src/logger.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) throw new Error('用法：node tools/local-asr/segment-vs-whole.ts "<媒体文件>" [--minutes N] [--at 秒]');
const minutes = (() => {
  const i = args.indexOf('--minutes');
  return i >= 0 ? Number(args[i + 1]) : 59;
})();
const span = minutes! * 60;
const at = (() => {
  const i = args.indexOf('--at');
  return i >= 0 ? Number(args[i + 1]) : Math.round(span / 2);
})();

/* 用项目统一解析器（不硬编码本机路径：会泄露用户名且换机器失效） */
const FFMPEG = findFfmpeg(process.env['LIVEAUTO_FFMPEG'] ?? undefined);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seg-'));
const partA = path.join(tmp, 'a.ts');
const partB = path.join(tmp, 'b.ts');
console.log(`  切分：${path.basename(file)} → 0–${at}s / ${at}–${span}s（-c copy，无重编码）`);
for (const [out, ss, t] of [
  [partA, 0, at],
  [partB, at, span - at],
] as Array<[string, number, number]>) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file, '-t', String(t), '-c', 'copy', '-y', out], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg 切分失败（退出码 ${String(r.status)}）`);
}

const cfg = loadConfig().config;
cfg.asr.provider = 'local-funasr';
cfg.runtime.allowPaid = false;
cfg.asr.silenceTrim.enabled = false;
cfg.asr.localFunasr.chunkMinutes = 360;

async function run(label: string, media: string, dur: number, offset: number): Promise<{ label: string; wallSec: number; cues: number; covered: number; first: number; last: number }> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'segcache-'));
  const tr = new Transcriber({
    client: BiliLiveClient.fromConfig(cfg, log),
    config: cfg,
    cache: new AsrCache(cacheDir, log),
  });
  const t0 = Date.now();
  const res = await tr.transcribe({
    taskId: `seg-${label}-${Date.now()}`,
    totalDuration: dur,
    media: {
      planCalls: () => [{ file: media, inFileStart: 0, inFileEnd: dur, offset, globalStart: offset, globalEnd: offset + dur, windowIndex: 0 }],
      fileStat: (f: string) => ({ size: fs.statSync(f).size, updatedAt: Math.round(fs.statSync(f).mtimeMs) }),
    },
    allowPaid: false,
  });
  const segs = res.transcript.segments ?? [];
  const covered = segs.reduce((a, s) => a + Math.max(0, (s.end ?? 0) - (s.start ?? 0)), 0);
  const out = {
    label,
    wallSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    cues: segs.length,
    covered: Number(covered.toFixed(1)),
    first: segs[0]?.start ?? -1,
    last: segs[segs.length - 1]?.start ?? -1,
  };
  console.log(`  ${label}：墙钟 ${out.wallSec}s，${out.cues} 条字幕，覆盖 ${out.covered}s，首 ${out.first.toFixed(1)} / 末 ${out.last.toFixed(1)}`);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  return out;
}

const whole = await run('整段', file, span, 0);
const a = await run('前半', partA, at, 0);
const b = await run('后半', partB, span - at, at);

const sumCues = a.cues + b.cues;
const sumCovered = Number((a.covered + b.covered).toFixed(1));
const cueDelta = sumCues === 0 ? 1 : Math.abs(sumCues - whole.cues) / whole.cues;
const covDelta = whole.covered === 0 ? 1 : Math.abs(sumCovered - whole.covered) / whole.covered;
console.log('\n=== 结论 ===');
console.log(JSON.stringify({
  whole,
  parts: [a, b],
  sumCues,
  sumCovered,
  cueDeltaPct: Number((cueDelta * 100).toFixed(2)),
  coveredDeltaPct: Number((covDelta * 100).toFixed(2)),
  verdict:
    cueDelta <= 0.05 && covDelta <= 0.05
      ? '分段与整段等价（差异 ≤5%）⇒ 边录边转写可行'
      : '分段与整段差异明显 ⇒ 需要先查清差异来源再谈边录边转写',
}));
fs.rmSync(tmp, { recursive: true, force: true });
