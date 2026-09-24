/**
 * 交叉验证：deepseek-chat vs deepseek-v4-pro
 *
 * 在**多场素材**上跑同一 prompt，对比：
 *   速度   —— 墙钟、输出 tok/秒
 *   合规   —— JSON 契约、片段时长是否落在配置区间、标题长度是否 ≤80、tags 数量
 *   一致性 —— 两个模型选出的时间区间重叠度（Jaccard）→ 判断"选片分歧有多大"
 *   质量   —— 候选数、标题长度分布、是否含 ASCII 引号等污染
 *
 * 用法：node --experimental-strip-types tools/local-asr/compare-models-cross.ts
 */
import fs from 'node:fs';
import { loadConfig } from '../../src/config.ts';
import { PromptStore, chunkTranscript, renderDigestsForPrompt, renderSignalsSummary } from '../../src/analyze.ts';

const cfg = loadConfig('config.json').config;
const base = cfg.llm.summary.baseUrl.replace(/\/+$/, '');
const prompts = new PromptStore();

interface Clip { start: number; end: number; title: string; tags?: string[]; score?: number; desc?: string; reason?: string }
interface Run {
  model: string;
  dataset: string;
  sec: number;
  inTok: number;
  outTok: number;
  cost: number;
  jsonOk: boolean;
  status: number;
  clips: Clip[];
  error?: string;
}

/** 用真实数据构造与项目一致的 prompt */
function buildPrompt(dir: string): { system: string; user: string; duration: number; windows: number } {
  const tr = JSON.parse(fs.readFileSync(`${dir}/transcript.json`, 'utf8')) as {
    segments: Array<{ start: number; end: number; text: string }>;
  };
  const sig = JSON.parse(fs.readFileSync(`${dir}/signals.json`, 'utf8'));
  const duration = tr.segments[tr.segments.length - 1]!.end;
  const chunks = chunkTranscript(tr as never, cfg.llm.chunkMinutes, duration);
  const digests = chunks.map((c, i) => ({
    start: c.start,
    end: c.end,
    topics: [`时间窗 ${i + 1}`],
    highlights: c.segments.slice(0, 6).map((s) => ({ time: s.start, what: s.text.slice(0, 40), why: '' })),
  }));
  const system = prompts.get('select');
  const user = [
    '## 视频总时长',
    `${Math.round(duration)} 秒`,
    '',
    '## 选片参数',
    `- 候选数量上限：${cfg.clip.maxCandidates} 个`,
    `- 片段时长范围：${cfg.clip.minDurationSec}–${cfg.clip.maxDurationSec} 秒`,
    `- 评分低于 ${cfg.clip.autoSelectScoreFloor} 的不要输出`,
    '',
    '## 各时间窗要点',
    renderDigestsForPrompt(digests as never),
    '',
    '## 弹幕信号摘要（全场）',
    renderSignalsSummary(sig as never),
    '',
    '## 可选分区（白名单，写文字描述即可，不要写数字 ID）',
    Object.keys(cfg.publish.tidWhitelist).slice(0, 60).join('、'),
  ].join('\n');
  return { system, user, duration, windows: chunks.length };
}

async function callModel(model: string, system: string, user: string): Promise<Omit<Run, 'dataset' | 'model'>> {
  const t0 = Date.now();
  let status = 0;
  let text = '';
  let inTok = 0;
  let outTok = 0;
  let error: string | undefined;
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.llm.summary.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: cfg.llm.select.temperature ?? 0.4,
        max_tokens: cfg.llm.select.maxTokens ?? 8192,
        response_format: { type: 'json_object' },
      }),
    });
    status = r.status;
    const j = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    text = j.choices?.[0]?.message?.content ?? '';
    inTok = j.usage?.prompt_tokens ?? 0;
    outTok = j.usage?.completion_tokens ?? 0;
    if (j.error) error = j.error.message;
  } catch (e) {
    error = (e as Error).message;
  }
  const sec = (Date.now() - t0) / 1000;
  let clips: Clip[] = [];
  let jsonOk = false;
  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const obj = JSON.parse(clean) as { clips?: Clip[] };
    if (Array.isArray(obj.clips)) {
      clips = obj.clips;
      jsonOk = true;
    }
  } catch { /* jsonOk 保持 false */ }
  const cost =
    (inTok / 1e6) * cfg.llm.pricing.summary.inputPerMillion + (outTok / 1e6) * cfg.llm.pricing.summary.outputPerMillion;
  const out: Omit<Run, 'dataset' | 'model'> = { sec, inTok, outTok, cost, jsonOk, status, clips };
  if (error) out.error = error;
  return out;
}

/** 两个模型选出的区间重叠度 */
function jaccard(a: Clip[], b: Clip[]): number {
  const setOf = (c: Clip): Set<number> => {
    const s = new Set<number>();
    for (let t = Math.floor(c.start); t <= Math.ceil(c.end); t++) s.add(t);
    return s;
  };
  const A = new Set<number>();
  const B = new Set<number>();
  for (const c of a) for (const t of setOf(c)) A.add(t);
  for (const c of b) for (const t of setOf(c)) B.add(t);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

const DATASETS = [
  { name: '59 分钟场', dir: 'data/tasks/manual-20260922160813-grre' },
  { name: '4.3 小时场', dir: 'data/tasks/manual-20260922163052-322f' },
].filter((d) => fs.existsSync(`${d.dir}/transcript.json`) && fs.existsSync(`${d.dir}/signals.json`));

const MODELS = ['deepseek-chat', 'deepseek-v4-pro'];
const runs: Run[] = [];

for (const ds of DATASETS) {
  const { system, user, duration, windows } = buildPrompt(ds.dir);
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${ds.name}   音频 ${Math.round(duration)}s（${(duration / 60).toFixed(0)} 分钟）   ${windows} 个时间窗`);
  console.log(`prompt: system ${system.length} 字符 + user ${user.length} 字符`);
  console.log('='.repeat(78));
  for (const model of MODELS) {
    process.stdout.write(`  ${model.padEnd(18)} `);
    const r = await callModel(model, system, user);
    const run: Run = { model, dataset: ds.name, ...r };
    runs.push(run);
    const tps = r.sec > 0 ? (r.outTok / r.sec).toFixed(0) : '0';
    console.log(
      `${r.status === 200 ? '✓' : '✗'} ${r.sec.toFixed(1)}s  ${r.inTok}/${r.outTok} tok (${tps} tok/s)  ¥${r.cost.toFixed(4)}  ` +
        `${r.clips.length} 候选  JSON ${r.jsonOk ? '✓' : '✗'}${r.error ? `  err=${r.error.slice(0, 50)}` : ''}`,
    );
  }
}

/* ---------------- 汇总 ---------------- */
console.log(`\n\n${'='.repeat(78)}`);
console.log('汇总一：速度与成本');
console.log('='.repeat(78));
console.log('素材'.padEnd(14) + '模型'.padEnd(18) + '耗时'.padEnd(9) + '输出tok'.padEnd(10) + 'tok/s'.padEnd(8) + '成本');
for (const r of runs) {
  console.log(
    r.dataset.padEnd(12) + r.model.padEnd(18) + `${r.sec.toFixed(1)}s`.padEnd(9) +
      String(r.outTok).padEnd(10) + (r.outTok / r.sec).toFixed(0).padEnd(8) + `¥${r.cost.toFixed(4)}`,
  );
}

console.log(`\n${'='.repeat(78)}`);
console.log('汇总二：合规率（对照项目硬性要求）');
console.log('='.repeat(78));
for (const ds of DATASETS) {
  const rs = runs.filter((r) => r.dataset === ds.name);
  console.log(`\n【${ds.name}】`);
  for (const r of rs) {
    const durOk = r.clips.filter((c) => c.end - c.start >= cfg.clip.minDurationSec * 0.95 && c.end - c.start <= cfg.clip.maxDurationSec).length;
    const titleOk = r.clips.filter((c) => [...String(c.title)].length <= 80).length;
    const tagOk = r.clips.filter((c) => Array.isArray(c.tags) && c.tags.length >= 1 && c.tags.length <= 10).length;
    const asciiQuote = r.clips.filter((c) => /["\\]/.test(String(c.title))).length;
    const overlapViolation = (() => {
      const sorted = [...r.clips].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start < sorted[i - 1]!.end) return true;
      return false;
    })();
    console.log(`  ${r.model}`);
    console.log(`      JSON 契约      : ${r.jsonOk ? '✓ 通过' : '✗ 失败'}`);
    console.log(`      时长合规       : ${durOk}/${r.clips.length}（区间 ${cfg.clip.minDurationSec}-${cfg.clip.maxDurationSec}s）`);
    console.log(`      标题 ≤80 字符  : ${titleOk}/${r.clips.length}`);
    console.log(`      tags 1-10 个   : ${tagOk}/${r.clips.length}`);
    console.log(`      标题含 ASCII 引号/反斜杠 : ${asciiQuote} 条${asciiQuote ? ' ⚠️' : ''}`);
    console.log(`      片段互相重叠   : ${overlapViolation ? '✗ 有重叠（违反硬性约束）' : '✓ 无重叠'}`);
    const lens = r.clips.map((c) => [...String(c.title)].length);
    if (lens.length) {
      const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
      console.log(`      标题长度       : 均值 ${avg.toFixed(1)} 字，范围 ${Math.min(...lens)}-${Math.max(...lens)} 字（移动端约 20 字折行）`);
    }
  }
  // 一致性
  const [a, b] = rs;
  if (a && b) {
    const j = jaccard(a.clips, b.clips);
    console.log(`\n  两模型选片一致性（时间区间 Jaccard）: ${(j * 100).toFixed(1)}%`);
    console.log(`      → ${j > 0.7 ? '高度一致（分歧小，换模型风险低）' : j > 0.4 ? '中等一致（各有偏好）' : '分歧较大（两个模型关注点不同）'}`);
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log('汇总三：候选明细对照');
console.log('='.repeat(78));
for (const ds of DATASETS) {
  console.log(`\n【${ds.name}】`);
  for (const r of runs.filter((x) => x.dataset === ds.name)) {
    console.log(`  ${r.model}（${r.clips.length} 个）`);
    for (const c of r.clips) {
      console.log(`      ${c.start.toFixed(0).padStart(6)}-${c.end.toFixed(0).padStart(6)}s (${(c.end - c.start).toFixed(0)}s) ${String(c.score ?? '-').padEnd(4)} [${[...String(c.title)].length}字] ${c.title}`);
    }
  }
}

fs.writeFileSync('data/local-asr-test/llm-cross-validation.json', JSON.stringify(runs, null, 2), 'utf8');
console.log('\n结果已存 data/local-asr-test/llm-cross-validation.json');
