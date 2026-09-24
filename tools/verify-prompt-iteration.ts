/**
 * 提示词迭代验证：用**新提示词**重新选片，对比边界质量。
 * 复用已有转写与信号（不重跑 ASR，不产生 ASR 费用），只调用 LLM。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Analyzer, PromptStore, sanitizeClips } from '../src/analyze.ts';
import { LlmClient } from '../src/llm.ts';
import { loadConfig } from '../src/config.ts';
import type { ClipRecord, Signals, Transcript } from '../src/types.ts';

const DIR = process.argv[2] ?? 'data/tasks/manual-20260922163052-322f';
const lc = loadConfig('config.json');
const cfg = lc.config;

const transcript = JSON.parse(fs.readFileSync(path.join(DIR, 'transcript.json'), 'utf8')) as Transcript;
const signals = JSON.parse(fs.readFileSync(path.join(DIR, 'signals.json'), 'utf8')) as Signals;
const oldClips = (JSON.parse(fs.readFileSync(path.join(DIR, 'clips.json'), 'utf8')) as { clips?: ClipRecord[] }).clips ?? [];
const segs = (transcript.segments ?? [])
  .map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text ?? '') }))
  .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
  .sort((a, b) => a.start - b.start);
const videoDuration = segs[segs.length - 1]?.end ?? 0;

console.log(`数据集: ${DIR}`);
console.log(`转写 ${segs.length} 段，时长 ${(videoDuration / 60).toFixed(0)} 分钟`);
console.log(`基线（旧提示词）${oldClips.length} 个候选\n`);

const llm = LlmClient.fromConfig(cfg);
const analyzer = new Analyzer({ config: cfg, llm, prompts: new PromptStore() });
console.log('调用 LLM（分块要点 → 全局总结 → 选片）...');
const t0 = Date.now();
const res = await analyzer.analyze({
  taskId: `prompt-iter-${Date.now()}`,
  transcript,
  signals,
  videoDuration,
  allowPaid: true,
  onProgress: (p) => process.stdout.write(`\r  ${p.label} (${p.current}/${p.total})        `),
});
console.log(`\n完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`LLM 成本：¥${res.cost.cost.toFixed(4)}（${res.cost.calls} 次调用，${res.cost.promptTokens} in / ${res.cost.completionTokens} out）`);
if (res.warnings.length) {
  console.log(`\n警告 ${res.warnings.length} 条：`);
  for (const w of res.warnings.slice(0, 12)) console.log(`  - ${w}`);
}

const inside = (e: number): boolean => segs.some((s) => e > s.start + 0.05 && e < s.end - 0.05);
const newClips = res.decision.clips;

console.log(`\n=== 边界质量对比 ===`);
const bad = (list: ClipRecord[]): number => list.filter((c) => inside(c.end)).length;
console.log(`  切在说话中间：旧提示词产出 ${bad(oldClips)}/${oldClips.length}  →  新提示词产出 ${bad(newClips)}/${newClips.length}`);

console.log(`\n=== 新提示词产出的候选 ===`);
for (const c of newClips) {
  console.log(`  #${c.index} ${c.start.toFixed(1)}–${c.end.toFixed(1)}s (${(c.end - c.start).toFixed(0)}s) score=${c.score} ${inside(c.end) ? '✗ 说话中' : '✓ 停顿处'}`);
  console.log(`      ${c.title}`);
  console.log(`      tags: ${JSON.stringify(c.tags)}`);
}
console.log(`\n=== 旧提示词产出的候选（基线）===`);
for (const c of oldClips) {
  console.log(`  #${c.index} ${c.start.toFixed(1)}–${c.end.toFixed(1)}s (${(c.end - c.start).toFixed(0)}s) score=${c.score} ${inside(c.end) ? '✗ 说话中' : '✓ 停顿处'}`);
  console.log(`      ${c.title}`);
}
