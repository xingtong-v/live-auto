/**
 * 选片档模型切换的端到端验证（走项目自身的 LlmClient，不重写 HTTP）
 *
 * 校验四件事：
 *   1) 选片档 / 总结档解析出的模型名是否真的不同（硬约束 #13 的「升级到另一档」才成立）
 *   2) llm.select.maxTokens 是否够推理模型写完正文（8192 会被思维链吃光 → JSON 截断）
 *   3) llm.select.timeoutMs 是否容得下推理模型的实际耗时
 *   4) 契约（selectionSchema）能否通过，选出的片段是否满足 clip.min/maxDurationSec
 *
 * 参数：
 *   --allow-paid   允许真实调用付费 API（默认只做本地检查，不花钱）
 *
 * 用法：
 *   node --experimental-strip-types tools/local-asr/verify-select-slot.ts
 *   node --experimental-strip-types tools/local-asr/verify-select-slot.ts --allow-paid
 */
import fs from 'node:fs';
import { loadConfig } from '../../src/config.ts';
import { LlmClient, LlmError } from '../../src/llm.ts';
import { PromptStore, chunkTranscript, renderDigestsForPrompt, renderSignalsSummary, selectionSchema } from '../../src/analyze.ts';

const allowPaid = process.argv.includes('--allow-paid');
const cfg = loadConfig('config.json').config;
const client = LlmClient.fromConfig(cfg);

let fail = 0;
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(34)} ${detail}`);
};

console.log('='.repeat(84));
console.log('一、两档模型配置（决定硬约束 #13 是否真的能升级）');
console.log('='.repeat(84));
const summaryModel = client.modelOf('summary');
const selectModel = client.modelOf('select');
check(summaryModel.length > 0, '总结档模型已配置', summaryModel);
check(selectModel.length > 0, '选片档模型已配置', selectModel);
check(summaryModel !== selectModel, '两档模型不同（升级有意义）', `${summaryModel} → ${selectModel}`);
check(client.isEscalationMeaningful(), 'isEscalationMeaningful()', String(client.isEscalationMeaningful()));

console.log('\n' + '='.repeat(84));
console.log('二、推理模型的两个上限');
console.log('='.repeat(84));
const mt = cfg.llm.select.maxTokens;
const to = cfg.llm.select.timeoutMs;
// v4-pro 这类推理模型：思维链计入 completion_tokens，实测正文写完需 ~7000-8700 tok
const isReasoning = /v4-pro|flash|reason|r1|think/i.test(selectModel);
check(mt >= 16384 || !isReasoning, 'select.maxTokens 对推理模型足够', `${mt}（推理模型建议 ≥16384；8192 会被思维链吃光）`);
check(to >= 300000 || !isReasoning, 'select.timeoutMs 容得下推理耗时', `${to}ms（实测最慢 69.2s；重试余量建议 ≥300000ms）`);

console.log('\n' + '='.repeat(84));
console.log('三、契约与时长（真实调用）');
console.log('='.repeat(84));
if (!allowPaid) {
  console.log('  跳过真实调用（未加 --allow-paid）—— 硬约束 #14：无明确许可不得调用付费 API');
} else {
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
  const prompts = new PromptStore();
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

  const t0 = Date.now();
  try {
    const r = await client.chatJson('select', {
      system: prompts.get('select'),
      user,
      schema: selectionSchema,
      purpose: '选片档切换验证',
      maxTokens: cfg.llm.select.maxTokens,
    });
    const sec = (Date.now() - t0) / 1000;
    const clips = r.value.clips;
    console.log(`  返回 ${clips.length} 个候选，耗时 ${sec.toFixed(1)}s，completion=${r.usage.completionTokens} tok，cost=¥${r.cost.toFixed(4)}`);
    check(true, 'JSON 契约通过', `selectionSchema ✓`);
    const durs = clips.map((c) => c.end - c.start);
    const durOk = clips.filter((c) => c.end - c.start >= cfg.clip.minDurationSec * 0.95 && c.end - c.start <= cfg.clip.maxDurationSec).length;
    check(clips.length > 0, '候选数 > 0', `${clips.length} 个`);
    check(durOk === clips.length, '片段时长全部合规', `${durOk}/${clips.length}（区间 ${cfg.clip.minDurationSec}-${cfg.clip.maxDurationSec}s，实测 ${Math.min(...durs)}-${Math.max(...durs)}s）`);
    check(r.usage.durationMs < cfg.llm.select.timeoutMs, '耗时未触达 timeoutMs', `${r.usage.durationMs}ms < ${cfg.llm.select.timeoutMs}ms`);
    const bad = clips.filter((c) => /["\\]/.test(String(c.title))).length;
    check(bad === 0, '标题无 ASCII 引号污染', `${bad} 条`);
    for (const c of [...clips].sort((a, b) => a.start - b.start)) {
      console.log(`      ${c.start.toFixed(0).padStart(6)}-${c.end.toFixed(0).padStart(6)}s (${String(c.end - c.start).padStart(3)}s) ${String(c.score ?? '-').padEnd(4)} ${c.title}`);
    }
    const totals = client.drainTotals();
    console.log(`  累计用量：calls=${totals.calls} prompt=${totals.promptTokens} completion=${totals.completionTokens} cost=¥${totals.cost.toFixed(4)}`);
  } catch (e) {
    const err = e instanceof LlmError ? e : new LlmError(String((e as Error).message));
    console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    check(false, '真实调用通过', `${err.type}: ${err.message.slice(0, 200)}`);
  }
}

console.log('\n' + '='.repeat(84));
console.log(fail === 0 ? `全部通过${allowPaid ? '' : '（未做付费调用）'}` : `${fail} 项未通过`);
process.exitCode = fail === 0 ? 0 : 1;
