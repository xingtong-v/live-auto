/**
 * 从我们自己的 ASR 缓存里导出一段云端结果当基准。
 *
 * 为什么：云端 ASR 按小时计费，同一段素材没必要重复付钱；而且上游模型被换错时会 400，
 * 基准就跑不出来。缓存里的 `srt` 是**真实付费拿到**的 fun-asr 输出，用它当基准既省钱又稳定。
 *
 * 用法：node tools/local-asr/export-cached-srt.ts <cache.json> <startSec> <endSec> <out.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../../src/util.ts';

const [cacheFile, startArg, endArg, outArg] = process.argv.slice(2);
if (!cacheFile) {
  console.log('用法：node tools/local-asr/export-cached-srt.ts <cache.json> <start> <end> <out.json>');
  process.exit(1);
}
const start = Number(startArg ?? 0);
const end = Number(endArg ?? 300);
const out = outArg ?? path.join(ROOT_DIR, 'data', 'local-asr-test', 'ref-cached.json');

const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
  key?: string;
  parts?: unknown;
  srt?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  createdAt?: string;
};
const segs = (raw.segments ?? []).filter((s) => s.end > start && s.start < end);
console.log(`缓存条目：${path.basename(cacheFile)}`);
console.log(`  写入时间：${raw.createdAt ?? '?'}   段落总数：${raw.segments?.length ?? 0}`);
console.log(`  parts：${JSON.stringify(raw.parts)?.slice(0, 200)}`);
console.log(`  窗口 ${start}–${end}s 内段落：${segs.length}`);

fs.writeFileSync(out, JSON.stringify({ segments: segs, modelId: 'fun-asr（来自 ASR 缓存，已付费）', source: cacheFile }, null, 1), 'utf8');
console.log(`已写出基准：${path.relative(ROOT_DIR, out)}`);
console.log(`前 3 条：${segs.slice(0, 3).map((s) => `${s.start.toFixed(1)}s ${s.text}`).join(' | ')}`);
