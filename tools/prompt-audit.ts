/**
 * 「选片 prompt 该根据什么优化」——把手上已有的信号做成**可复跑的体检**（只读、零费用、零网络）。
 *
 * ## 为什么需要它
 * UI 上那张 Prompt 卡片写着「验收标准是抽检 10 个候选 ≥6 个值得发布，需要 2–3 轮迭代」，
 * 但**没有任何地方在算这个数** —— 迭代全靠感觉。这个工具把信号算成数字，让"改 prompt"变成
 * 可对比的前后测量：改之前跑一次、改之后再跑一次。
 *
 * ## 五类信号（按权威性排序）
 *  ① **人工勾选**（`decisions.jsonl` 的 `selected`）：最权威的标签 —— 你勾了哪些、没勾哪些；
 *  ② **分数区分度**：LLM 有没有真的做取舍（全挤在 7–8 分 = 没有排序信息）；
 *  ③ **降级兜底占比**：多少条根本没有 LLM 判断（按弹幕/语音密度凑的）—— 链路体检，不是 prompt 问题；
 *  ④ **发布后真实表现**（`performance.jsonl`）：播放/点赞 vs LLM 评分（样本够了才算得准）；
 *  ⑤ 你自己的抽检（人看几条）—— 工具算不了，但其它四项能告诉你"该看哪几条"。
 *
 * 用法：node tools/prompt-audit.ts [--json] [--all]
 *   · 默认**排除测试夹具**（taskId 形如 uie2e-* / tomb* / perf-* / mon-* / prompt-iter-*），
 *     否则"界面测试夹具"那 89 条会把统计带偏（实测就是这个数）；
 *   · `--all` 连夹具一起算（只在排查工具本身时用）。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const JSON_ONLY = args.includes('--json');
const INCLUDE_FIXTURES = args.includes('--all');

const readJsonl = (p: string): Array<Record<string, unknown>> => {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null);
};

/** 测试夹具的 taskId 前缀（这些行的 selected/score 都是脚本写死的，不能当人工偏好） */
const FIXTURE_RE = /^(uie2e-|tombui-|tomb-|perf-|mon-|prompt-iter-|e2e-|smoke-|test-)/;

interface Row {
  taskId: string;
  at: string;
  score: number;
  title: string;
  reason: string;
  degraded: boolean;
  selected: boolean;
}

const rows: Row[] = [];
let skippedFixtures = 0;
for (const d of readJsonl(path.join('data', 'decisions.jsonl'))) {
  const taskId = String(d['taskId'] ?? '');
  const llm = (d['llm'] ?? {}) as Record<string, unknown>;
  const score = typeof llm['score'] === 'number' ? llm['score'] : undefined;
  if (score === undefined) continue;
  if (!INCLUDE_FIXTURES && FIXTURE_RE.test(taskId)) {
    skippedFixtures++;
    continue;
  }
  const reason = typeof llm['reason'] === 'string' ? llm['reason'] : '';
  rows.push({
    taskId,
    at: String(d['at'] ?? ''),
    score,
    title: typeof llm['title'] === 'string' ? llm['title'] : '',
    reason,
    degraded: llm['degraded'] === true || /降级兜底/.test(reason),
    selected: d['selected'] === true,
  });
}

const sel = rows.filter((r) => r.selected);
const no = rows.filter((r) => !r.selected);
const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');

/* ② 区分度：直方图 + ≥8 占比 + 归一化熵（越接近 1 越分散） */
const bands: Array<[string, (s: number) => boolean]> = [
  ['<5', (s) => s < 5],
  ['5–6', (s) => s >= 5 && s < 6],
  ['6–7', (s) => s >= 6 && s < 7],
  ['7–8', (s) => s >= 7 && s < 8],
  ['8–9', (s) => s >= 8 && s < 9],
  ['9–10', (s) => s >= 9],
];
const hist = bands.map(([label, f]) => ({ label, n: rows.filter((r) => f(r.score)).length }));
const ge8 = rows.filter((r) => r.score >= 8).length;
const ge7 = rows.filter((r) => r.score >= 7).length;
const probs = hist.map((h) => h.n / Math.max(1, rows.length)).filter((p) => p > 0);
const entropy = probs.length > 1 ? -probs.reduce((a, p) => a + p * Math.log2(p), 0) / Math.log2(bands.length) : 0;

/* ③ 降级兜底 */
const degraded = rows.filter((r) => r.degraded).length;

/* ④ 表现相关性（performance.jsonl 里字段名是 score） */
const perf = readJsonl(path.join('data', 'performance.jsonl'))
  .map((p) => ({
    bvid: String(p['bvid'] ?? ''),
    view: typeof p['view'] === 'number' ? p['view'] : undefined,
    like: typeof p['like'] === 'number' ? p['like'] : 0,
    score: typeof p['score'] === 'number' ? p['score'] : undefined,
    parts: typeof p['parts'] === 'number' ? p['parts'] : 1,
  }))
  .filter((p) => p.view !== undefined && p.score !== undefined && p.view > 0);
let rho: number | undefined;
if (perf.length >= 8) {
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(arr.length);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r;
  };
  const n = perf.length;
  const rx = rank(perf.map((p) => p.score!));
  const ry = rank(perf.map((p) => p.view!));
  const mx = avg(rx);
  const my = avg(ry);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i]! - mx) * (ry[i]! - my);
    vx += (rx[i]! - mx) ** 2;
    vy += (ry[i]! - my) ** 2;
  }
  rho = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : undefined;
}

/* ---- 结论（阈值都写在这里，改 prompt 前后好对照） ---- */
const verdicts: Array<{ item: string; ok: boolean; note: string }> = [];
verdicts.push({
  item: '人工偏好方向',
  ok: rows.length === 0 || avg(sel.map((r) => r.score)) > avg(no.map((r) => r.score)),
  note: `勾选均分 ${avg(sel.map((r) => r.score)).toFixed(2)} vs 未勾 ${avg(no.map((r) => r.score)).toFixed(2)}（应更高）`,
});
verdicts.push({
  item: '分数区分度',
  ok: rows.length === 0 || ge8 / rows.length <= 0.5,
  note: `≥8 分占 ${pct(ge8, rows.length)}、≥7 分占 ${pct(ge7, rows.length)}、熵 ${entropy.toFixed(2)}（≥8 应 ≤50%、熵越高越分散）`,
});
verdicts.push({
  item: '降级兜底比例',
  ok: rows.length === 0 || degraded / rows.length <= 0.05,
  note: `${degraded}/${rows.length}（${pct(degraded, rows.length)}，>5% 说明信号缺失/LLM 没跑）`,
});
verdicts.push({
  item: '表现相关性样本量',
  ok: perf.length >= 30,
  note: `有播放+评分的稿件 ${perf.length} 条（<30 条不谈相关性）${rho !== undefined ? `，当前 ρ=${rho.toFixed(2)}` : ''}`,
});

if (JSON_ONLY) {
  console.log(
    JSON.stringify(
      {
        samples: rows.length,
        skippedFixtures,
        selected: sel.length,
        notSelected: no.length,
        avgSelected: Number(avg(sel.map((r) => r.score)).toFixed(2)),
        avgNotSelected: Number(avg(no.map((r) => r.score)).toFixed(2)),
        hist,
        ge8,
        ge7,
        entropy: Number(entropy.toFixed(3)),
        degraded,
        perfWithScore: perf.length,
        rho,
        verdicts,
      },
      null,
      2,
    ),
  );
} else {
  console.log('\x1b[1m选片 prompt 体检\x1b[0m（只读、零费用）');
  console.log('─'.repeat(74));
  console.log(`样本：${rows.length} 条 LLM 判决${skippedFixtures ? `（已排除 ${skippedFixtures} 条测试夹具）` : ''}`);
  console.log(`范围：${rows[0]?.at.slice(0, 16) ?? '—'} ~ ${rows[rows.length - 1]?.at.slice(0, 16) ?? '—'}`);

  console.log('\n① 人工偏好（最权威的标签）');
  console.log(`   勾选 ${sel.length} / 未勾选 ${no.length}`);
  console.log(`   平均分：勾选 ${avg(sel.map((r) => r.score)).toFixed(2)}，未勾选 ${avg(no.map((r) => r.score)).toFixed(2)}`);

  const highNotSel = rows.filter((r) => r.score >= 8 && !r.selected);
  const lowSel = rows.filter((r) => r.score <= 6 && r.selected);
  console.log(`\n   ★ LLM ≥8 分但你**没勾**：${highNotSel.length} 个（${pct(highNotSel.length, Math.max(1, rows.filter((r) => r.score >= 8).length))} of 高分）`);
  for (const r of highNotSel.slice(0, 6)) console.log(`      · ${r.score} 分「${r.title.slice(0, 26)}」${r.degraded ? '（降级兜底）' : ''}｜${r.reason.slice(0, 50)}`);
  console.log(`   ★ LLM ≤6 分但你**勾了**：${lowSel.length} 个（低分误杀）`);
  for (const r of lowSel.slice(0, 6)) console.log(`      · ${r.score} 分「${r.title.slice(0, 26)}」｜${r.reason.slice(0, 50)}`);

  console.log('\n② 分数区分度（prompt 第 55 行要求"不要扎堆"，看它做没做到）');
  for (const h of hist) {
    const bar = '█'.repeat(Math.round((h.n / Math.max(1, rows.length)) * 40));
    console.log(`   ${h.label.padEnd(5)} ${String(h.n).padStart(4)}  ${bar}`);
  }
  console.log(`   ≥8 分 ${pct(ge8, rows.length)}｜≥7 分 ${pct(ge7, rows.length)}｜归一化熵 ${entropy.toFixed(2)}（1=最分散）`);

  console.log('\n③ 降级兜底（没有 LLM 判断、按弹幕/语音密度凑的行）');
  console.log(`   ${degraded}/${rows.length}（${pct(degraded, rows.length)}）`);

  console.log('\n④ 发布后的真实表现');
  console.log(`   performance.jsonl 里有播放且有评分的：${perf.length} 条`);
  if (rho !== undefined) console.log(`   Spearman ρ(评分, 播放) = ${rho.toFixed(3)}（n=${perf.length}，|ρ|<0.3 基本等于没关系）`);
  else console.log('   样本不足 8 条，先不算相关性（现在最多只能当弱信号看）');
  const multi = perf.filter((p) => p.parts > 1).length;
  if (multi) console.log(`   注意：其中 ${multi} 条是多分P 稿件 —— 分P 共享稿件总播放，会污染相关性`);

  console.log('\n' + '─'.repeat(74));
  console.log('\x1b[1m结论\x1b[0m');
  for (const v of verdicts) console.log(`   ${v.ok ? '\x1b[32m✅\x1b[0m' : '\x1b[31m⚠️ \x1b[0m'} ${v.item}：${v.note}`);
  const bad = verdicts.filter((v) => !v.ok).map((v) => v.item);
  console.log(
    bad.length === 0
      ? '\x1b[32m四项都达标 —— 该动的是"你自己的抽检"（人看几条），别再改判据。\x1b[0m'
      : `\x1b[33m需要处理：${bad.join('、')}。改完 prompt 再跑一次这个工具对比。\x1b[0m`,
  );
}
