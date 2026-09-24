/**
 * 实测 DeepSeek 各模型的选片表现：用**真实的选片 prompt**（含真实要点与信号）
 * 各跑一次，对比 速度 / token / 成本 / JSON 合规 / 选片质量线索。
 *
 * 成本：每次调用约 ¥0.05，跑 3 个模型约 ¥0.15
 */
import fs from 'node:fs';
import { loadConfig } from '../../src/config.ts';
import { PromptStore, renderDigestsForPrompt, renderSignalsSummary } from '../../src/analyze.ts';

const cfg = loadConfig('config.json').config;

// 用最近一次有产物任务的数据构造真实 prompt
const dirs = fs.readdirSync('data/tasks').sort();
let task = '';
for (const d of dirs.reverse()) {
  if (fs.existsSync(`data/tasks/${d}/signals.json`) && fs.existsSync(`data/tasks/${d}/transcript.json`)) {
    task = d;
    break;
  }
}
const tr = JSON.parse(fs.readFileSync(`data/tasks/${task}/transcript.json`, 'utf8')) as {
  segments: Array<{ start: number; end: number; text: string }>;
};
const sig = JSON.parse(fs.readFileSync(`data/tasks/${task}/signals.json`, 'utf8'));
const totalDuration = tr.segments[tr.segments.length - 1]!.end;

// 用项目自己的分块逻辑生成 digests（保持与真实流程一致）
const m = await import('../../src/analyze.ts');
const chunks = m.chunkTranscript(tr as never, cfg.llm.chunkMinutes, totalDuration);

// 简化：直接把每个 chunk 的原始转写当 digest（等价于"要点"，信息量不低于真实流程）
const digests = chunks.map((c, i) => ({
  start: c.start,
  end: c.end,
  topics: [`时间窗 ${i + 1}`],
  highlights: c.segments.slice(0, 6).map((s) => ({
    time: s.start,
    what: s.text.slice(0, 40),
    why: '',
  })),
}));

const prompts = new PromptStore();
const system = prompts.get('select');
const user = [
  '## 视频总时长',
  `${Math.round(totalDuration)} 秒（${Math.floor(totalDuration / 60)} 分 ${Math.round(totalDuration % 60)} 秒）`,
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

console.log(`数据取自任务 ${task}`);
console.log(`音频 ${Math.round(totalDuration)}s，${chunks.length} 个时间窗`);
console.log(`system prompt ${system.length} 字符，user prompt ${user.length} 字符\n`);

const MODELS = ['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro'];
const base = cfg.llm.summary.baseUrl.replace(/\/+$/, '');

interface Result {
  model: string;
  ok: boolean;
  status: number;
  sec: number;
  inTok: number;
  outTok: number;
  cost: number;
  clips: number;
  jsonOk: boolean;
  titles: string[];
  scores: number[];
  error?: string;
}

const results: Result[] = [];

for (const model of MODELS) {
  process.stdout.write(`调用 ${model.padEnd(16)} ... `);
  const t0 = Date.now();
  let status = 0;
  let text = '';
  let inTok = 0;
  let outTok = 0;
  let err = '';
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.llm.summary.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: cfg.llm.select.maxTokens ?? 4096,
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
    if (j.error) err = j.error.message ?? '';
  } catch (e) {
    err = (e as Error).message;
  }
  const sec = (Date.now() - t0) / 1000;

  // 解析
  let clips: Array<{ title?: string; score?: number }> = [];
  let jsonOk = false;
  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const obj = JSON.parse(clean) as { clips?: Array<{ title?: string; score?: number }> };
    if (Array.isArray(obj.clips)) {
      clips = obj.clips;
      jsonOk = true;
    }
  } catch {
    jsonOk = false;
  }

  const cost = (inTok / 1e6) * cfg.llm.pricing.summary.inputPerMillion + (outTok / 1e6) * cfg.llm.pricing.summary.outputPerMillion;
  const res: Result = {
    model,
    ok: status === 200 && jsonOk,
    status,
    sec,
    inTok,
    outTok,
    cost,
    clips: clips.length,
    jsonOk,
    titles: clips.map((c) => String(c.title ?? '')),
    scores: clips.map((c) => Number(c.score ?? 0)),
  };
  if (err) res.error = err;
  results.push(res);
  console.log(`${res.ok ? '✓' : '✗'} ${sec.toFixed(1)}s  ${inTok}/${outTok} tok  ¥${cost.toFixed(4)}  ${clips.length} 个候选${err ? `  err=${err.slice(0, 60)}` : ''}`);
}

console.log('\n=== 汇总 ===');
console.log('模型'.padEnd(18) + '状态'.padEnd(8) + '耗时'.padEnd(10) + '输入'.padEnd(9) + '输出'.padEnd(8) + '成本'.padEnd(11) + '候选  JSON');
for (const r of results) {
  console.log(
    r.model.padEnd(16) + String(r.status).padEnd(8) + `${r.sec.toFixed(1)}s`.padEnd(10) +
      String(r.inTok).padEnd(9) + String(r.outTok).padEnd(8) + `¥${r.cost.toFixed(4)}`.padEnd(11) +
      String(r.clips).padEnd(6) + (r.jsonOk ? '✓' : '✗'),
  );
}

console.log('\n=== 各模型的候选标题（看质量差异）===');
for (const r of results) {
  console.log(`\n--- ${r.model}（${r.clips} 个，分数 ${r.scores.join('/') || '-'}）---`);
  for (const t of r.titles) console.log(`    [${[...t].length} 字] ${t}`);
}

fs.writeFileSync('data/local-asr-test/llm-model-compare.json', JSON.stringify(results, null, 2), 'utf8');
console.log('\n结果已存 data/local-asr-test/llm-model-compare.json');
