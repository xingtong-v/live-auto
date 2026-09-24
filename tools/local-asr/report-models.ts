/**
 * 汇总：交叉验证 + 上限探测 → 给出可直接落地的选型结论
 *
 * 读取 data/local-asr-test/llm-cross-validation.json 与 probe-v4pro.json，
 * 把"速度 / 成本 / 合规 / 内容质量"四维拉平到同一张表，并检查
 * ASCII 引号污染、片段时长、互相重叠、标题字数分布。
 *
 * 用法：node --experimental-strip-types tools/local-asr/report-models.ts
 */
import fs from 'node:fs';
import { loadConfig } from '../../src/config.ts';

const cfg = loadConfig('config.json').config;

interface Clip { start: number; end: number; title: string; tags?: string[]; score?: number; reason?: string }
interface Run {
  model: string; dataset: string; sec: number; inTok: number; outTok: number;
  cost: number; jsonOk: boolean; status: number; clips: Clip[]; error?: string;
}
interface Probe { model: string; maxTokens: number; status: number; sec: number; outTok: number; finish: string; jsonOk: boolean; clips: number; err?: string; items?: Clip[] }

const runs = JSON.parse(fs.readFileSync('data/local-asr-test/llm-cross-validation.json', 'utf8')) as Run[];
const probes = JSON.parse(fs.readFileSync('data/local-asr-test/probe-v4pro.json', 'utf8')) as Probe[];

const PRICE_RESULT = 'data/local-asr-test/probe-v4pro.json';
void PRICE_RESULT;

const len = (s: string): number => [...String(s)].length;
const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

console.log('='.repeat(90));
console.log('一、速度与成本（同一 prompt，同一素材）');
console.log('='.repeat(90));
console.log('素材'.padEnd(13) + '模型'.padEnd(17) + '耗时'.padEnd(9) + '输出tok'.padEnd(10) + 'tok/s'.padEnd(8) + '成本'.padEnd(11) + '倍数');
type Agg = { chat: number[]; pro: number[] };
const agg: Record<string, { sec: number[]; out: number[]; cost: number[] }> = {};
for (const r of runs) {
  const k = r.model;
  agg[k] ??= { sec: [], out: [], cost: [] };
  agg[k].sec.push(r.sec);
  agg[k].out.push(r.outTok);
  agg[k].cost.push(r.cost);
  console.log(
    r.dataset.padEnd(11) + r.model.padEnd(17) + `${r.sec.toFixed(1)}s`.padEnd(9) + String(r.outTok).padEnd(10) +
      (r.outTok / r.sec).toFixed(0).padEnd(8) + `¥${r.cost.toFixed(4)}`.padEnd(11) + (r.jsonOk ? '✓' : '✗ 截断'),
  );
}
const chatCost = agg['deepseek-chat']?.cost.reduce((a, b) => a + b, 0) ?? 0;
const proCost = agg['deepseek-v4-pro']?.cost.reduce((a, b) => a + b, 0) ?? 0;
console.log(`\n  合计成本：chat ¥${chatCost.toFixed(4)}   v4-pro ¥${proCost.toFixed(4)}   → v4-pro 是 chat 的 ${(proCost / chatCost).toFixed(2)} 倍`);
console.log(`  中位耗时：chat ${median(agg['deepseek-chat']!.sec).toFixed(1)}s   v4-pro ${median(agg['deepseek-v4-pro']!.sec).toFixed(1)}s`);

console.log('\n' + '='.repeat(90));
console.log('二、输出上限探测（v4-pro 截断问题）');
console.log('='.repeat(90));
console.log('模型'.padEnd(17) + 'max_tokens'.padEnd(12) + '耗时'.padEnd(9) + '实际输出'.padEnd(10) + 'finish'.padEnd(9) + 'JSON'.padEnd(7) + '候选');
for (const p of probes) {
  console.log(
    p.model.padEnd(17) + String(p.maxTokens).padEnd(12) + `${p.sec.toFixed(1)}s`.padEnd(9) + String(p.outTok).padEnd(10) +
      p.finish.padEnd(9) + (p.jsonOk ? '✓' : '✗').padEnd(7) + p.clips,
  );
}
console.log(`\n  项目配置 llm.select.maxTokens = ${cfg.llm.select.maxTokens}`);
console.log('  → v4-pro 是推理模型，思维链计入 completion_tokens；8192 会被思维链吃光，正文 JSON 一个 token 都写不出来。');

console.log('\n' + '='.repeat(90));
console.log('三、合规率');
console.log('='.repeat(90));
console.log('素材'.padEnd(13) + '模型'.padEnd(17) + '条数'.padEnd(6) + '时长合规'.padEnd(10) + '标题≤80'.padEnd(9) + 'tags1-10'.padEnd(10) + 'ASCII引号'.padEnd(10) + '重叠'.padEnd(6) + '标题字数');
for (const r of runs) {
  const n = r.clips.length;
  const durOk = r.clips.filter((c) => c.end - c.start >= cfg.clip.minDurationSec * 0.95 && c.end - c.start <= cfg.clip.maxDurationSec).length;
  const tOk = r.clips.filter((c) => len(c.title) <= 80).length;
  const gOk = r.clips.filter((c) => Array.isArray(c.tags) && c.tags.length >= 1 && c.tags.length <= 10).length;
  const bad = r.clips.filter((c) => /["\\]/.test(String(c.title))).length;
  const sorted = [...r.clips].sort((a, b) => a.start - b.start);
  let ov = false;
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start < sorted[i - 1]!.end) ov = true;
  const lens = r.clips.map((c) => len(c.title));
  console.log(
    r.dataset.padEnd(11) + r.model.padEnd(17) + String(n).padEnd(6) + `${durOk}/${n}`.padEnd(10) + `${tOk}/${n}`.padEnd(9) +
      `${gOk}/${n}`.padEnd(10) + `${bad} 条${bad ? '⚠️' : '  '}`.padEnd(10) + (ov ? '✗有' : '✓无').padEnd(6) +
      (lens.length ? `均值 ${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)}（${Math.min(...lens)}-${Math.max(...lens)}）` : '-'),
  );
}

console.log('\n' + '='.repeat(90));
console.log('四、候选明细（内容质量人工对照用）');
console.log('='.repeat(90));
for (const r of runs) {
  console.log(`\n【${r.dataset}】${r.model}  ${r.clips.length} 个${r.jsonOk ? '' : ' —— JSON 截断，无输出'}`);
  for (const c of [...r.clips].sort((a, b) => a.start - b.start)) {
    console.log(`    ${c.start.toFixed(0).padStart(6)}-${c.end.toFixed(0).padStart(6)}s (${String(c.end - c.start).padStart(3)}s) ${String(c.score ?? '-').padEnd(4)} [${String(len(c.title)).padStart(2)}字] ${c.title}`);
  }
}

console.log('\n' + '='.repeat(90));
console.log('四之二、提高 max_tokens 后的候选明细（4.3 小时场，与上面 chat 的直接对照）');
console.log('='.repeat(90));
for (const p of probes) {
  if (!p.items?.length) continue;
  const lens = p.items.map((c) => len(c.title));
  const bad = p.items.filter((c) => /["\\]/.test(String(c.title))).length;
  console.log(`\n  ${p.model} @ max_tokens=${p.maxTokens}  ${p.items.length} 个候选  标题均值 ${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)} 字  ASCII 引号 ${bad} 条`);
  for (const c of [...p.items].sort((a, b) => a.start - b.start)) {
    console.log(`    ${c.start.toFixed(0).padStart(6)}-${c.end.toFixed(0).padStart(6)}s (${String(c.end - c.start).padStart(3)}s) ${String(c.score ?? '-').padEnd(4)} [${String(len(c.title)).padStart(2)}字] ${c.title}`);
  }
}

console.log('\n' + '='.repeat(90));
console.log('五、结论');
console.log('='.repeat(90));
const proFail = runs.filter((r) => r.model === 'deepseek-v4-pro' && !r.jsonOk).length;
const chatBadQuote = runs.filter((r) => r.model === 'deepseek-chat').flatMap((r) => r.clips).filter((c) => /["\\]/.test(String(c.title))).length;
console.log(`  v4-pro 契约失败            : ${proFail}/${runs.filter((r) => r.model === 'deepseek-v4-pro').length} 次（全部为 8192 上限截断，不是能力问题）`);
console.log(`  v4-pro 提高上限后           : ${probes.filter((p) => p.model === 'deepseek-v4-pro' && p.jsonOk).length}/${probes.filter((p) => p.model === 'deepseek-v4-pro').length} 次通过`);
console.log(`  chat 标题 ASCII 引号污染    : ${chatBadQuote} 条（不稳定，同一模型同一 prompt 会在 0 条与 6 条之间跳）`);
console.log(`  速度差                     : v4-pro 约为 chat 的 ${(median(agg['deepseek-v4-pro']!.sec) / median(agg['deepseek-chat']!.sec)).toFixed(0)} 倍`);
console.log(`  成本差                     : v4-pro 约为 chat 的 ${(proCost / chatCost).toFixed(2)} 倍`);
