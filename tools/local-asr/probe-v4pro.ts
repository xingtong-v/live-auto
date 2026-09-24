/**
 * 探测二：deepseek-v4-pro 的 max_tokens 上限与截断行为
 *
 * 目的：上一轮 4.3 小时场 v4-pro 输出 8192 tok 恰好等于 max_tokens，
 * JSON 被截断 → 候选 0 个。需要确认：
 *   1) 能否提高 max_tokens（服务端是否接受）；
 *   2) 高上限下 v4-pro 能否完整产出合法 JSON；
 *   3) 实际完成 token 数与耗时/成本。
 *
 * 用法：node --experimental-strip-types tools/local-asr/probe-v4pro.ts
 */
import fs from 'node:fs';
import { loadConfig } from '../../src/config.ts';
import { PromptStore, chunkTranscript, renderDigestsForPrompt, renderSignalsSummary } from '../../src/analyze.ts';

const cfg = loadConfig('config.json').config;
const base = cfg.llm.summary.baseUrl.replace(/\/+$/, '');
const prompts = new PromptStore();
const DIR = 'data/tasks/manual-20260922163052-322f';

const tr = JSON.parse(fs.readFileSync(`${DIR}/transcript.json`, 'utf8')) as {
  segments: Array<{ start: number; end: number; text: string }>;
};
const sig = JSON.parse(fs.readFileSync(`${DIR}/signals.json`, 'utf8'));
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

interface Clip { start: number; end: number; title: string; tags?: string[]; score?: number; desc?: string; reason?: string }
interface Probe { model: string; maxTokens: number; status: number; sec: number; outTok: number; finish: string; jsonOk: boolean; clips: number; err?: string; items?: Clip[] }

async function run(model: string, maxTokens: number): Promise<Probe> {
  const t0 = Date.now();
  let status = 0;
  let outTok = 0;
  let finish = '?';
  let text = '';
  let err: string | undefined;
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.llm.summary.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: cfg.llm.select.temperature ?? 0.4,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    status = r.status;
    const j = (await r.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { completion_tokens?: number };
      error?: { message?: string };
    };
    text = j.choices?.[0]?.message?.content ?? '';
    finish = j.choices?.[0]?.finish_reason ?? '?';
    outTok = j.usage?.completion_tokens ?? 0;
    if (j.error) err = j.error.message;
  } catch (e) {
    err = (e as Error).message;
  }
  const sec = (Date.now() - t0) / 1000;
  let jsonOk = false;
  let clips = 0;
  let items: Clip[] | undefined;
  try {
    const obj = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()) as { clips?: Clip[] };
    if (Array.isArray(obj.clips)) {
      jsonOk = true;
      clips = obj.clips.length;
      items = obj.clips;
    }
  } catch { /* 保持 false */ }
  const out: Probe = { model, maxTokens, status, sec, outTok, finish, jsonOk, clips };
  if (items) out.items = items;
  if (err) out.err = err.slice(0, 120);
  return out;
}

const probes: Probe[] = [];
// 先试服务端是否接受更高上限；再试推理模型在高上限下能否收敛
const plan: Array<[string, number]> = [
  ['deepseek-v4-pro', 16384],
  ['deepseek-v4-pro', 32768],
  ['deepseek-chat', 16384],
];

for (const [m, mt] of plan) {
  process.stdout.write(`  ${m.padEnd(18)} max_tokens=${String(mt).padEnd(7)} `);
  const p = await run(m, mt);
  probes.push(p);
  console.log(
    `${p.status === 200 ? '✓' : '✗'} ${p.sec.toFixed(1)}s  out=${String(p.outTok).padEnd(6)} finish=${p.finish.padEnd(10)} ` +
      `JSON ${p.jsonOk ? '✓' : '✗'}  ${p.clips} 候选${p.err ? `  err=${p.err}` : ''}`,
  );
}

console.log('\n' + '='.repeat(90));
console.log('结论素材：');
for (const p of probes) {
  const trunc = p.finish === 'length' || p.outTok === p.maxTokens;
  console.log(
    `  ${p.model} @ ${p.maxTokens}: ${p.jsonOk ? '完整 JSON' : '未通过'}，` +
      `完成 ${p.outTok} tok / 上限 ${p.maxTokens}${trunc ? '（触及上限，被截断）' : '（未触及上限）'}`,
  );
}

console.log('\n' + '='.repeat(90));
console.log('高上限下的候选明细（用于人工判断选片质量）：');
for (const p of probes) {
  console.log(`\n  ${p.model} @ ${p.maxTokens}  —— ${p.items?.length ?? 0} 个候选`);
  for (const c of [...(p.items ?? [])].sort((a, b) => a.start - b.start)) {
    console.log(`      ${c.start.toFixed(0).padStart(6)}-${c.end.toFixed(0).padStart(6)}s (${String(c.end - c.start).padStart(3)}s) ${String(c.score ?? '-').padEnd(4)} [${[...String(c.title)].length}字] ${c.title}`);
  }
}
fs.writeFileSync('data/local-asr-test/probe-v4pro.json', JSON.stringify(probes, null, 2), 'utf8');
console.log('\n结果已存 data/local-asr-test/probe-v4pro.json');
