/**
 * 汇总一次任务的**全链路分析数据**：ASR / LLM / 选片策略 / 切片 / 投稿。
 *
 * 数据来源全部是真实落盘与真实台账，不做推断：
 *   · data/tasks/<id>/transcript.json  —— 字幕条数、时间覆盖率、gaps
 *   · data/tasks/<id>/signals.json     —— 弹幕密度峰值与热词
 *   · data/tasks/<id>/clips.json       —— 候选（时间/评分/标题/理由/标签）
 *   · api/task/<id>                    —— 状态、费用、时间线、发布排期
 *   · data/logs/*.jsonl                —— 各阶段真实耗时
 *   · data/clips/<id>/                 —— 切片产物体积
 *
 * 用法：node --experimental-strip-types tools/analyze-run.ts <taskId> [port]
 */
import fs from 'node:fs';
import path from 'node:path';

const taskId = process.argv[2];
const port = Number(process.argv[3] ?? 3000);
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/analyze-run.ts <taskId> [port]');
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
const taskDir = path.join('data', 'tasks', taskId);
const readJson = <T>(p: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return undefined;
  }
};
const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const num = (n: number, d = 1): string => n.toFixed(d);

/* ============================ 1. 任务概览 ============================ */
const t = (await (await fetch(`${base}/api/task/${taskId}`)).json()) as Record<string, unknown>;
const src = (t['source'] ?? {}) as Record<string, unknown>;
const cost = (t['cost'] ?? {}) as Record<string, number>;
const schedule = (t['schedule'] ?? []) as Array<Record<string, unknown>>;
/* ⚠️ 时长在**顶层** `durationSec`；`source` 里只有 rawCount / segments[]，没有 totalDuration。
   （第一版读 source.totalDuration 得到 0，于是算出"8417 字/分钟""237738% 语音占比"这种荒谬值。） */
const DUR = Number(t['durationSec'] ?? 0) || Number((src['segments'] as Array<{ duration?: number }> | undefined)?.[0]?.duration ?? 0);

console.log('='.repeat(100));
console.log(`任务分析：${taskId}`);
console.log('='.repeat(100));
console.log(`标题      : ${String(t['title'] ?? '')}`);
console.log(`状态      : ${String(t['status'] ?? '')}    素材时长: ${num(DUR / 60)} 分钟（${num(DUR)}s）`);
console.log(`原始文件  : ${String(src['rawCount'] ?? 0)} 个，合计 ${num(Number(src['rawTotalGB'] ?? 0), 2)} GB`);
console.log(`分段      : ${(src['segments'] as unknown[] | undefined)?.length ?? 1} 个   弹幕 XML: ${src['danmaXml'] === true ? '有' : '无'}`);
console.log(`创建时间  : ${String(t['createdAt'] ?? '')}`);

/* ============================ 2. ASR 转写 ============================ */
console.log('\n' + '='.repeat(100));
console.log('① ASR 转写');
console.log('='.repeat(100));
interface Tr { segments: Array<{ start: number; end: number; text: string }>; gaps?: Array<{ start: number; end: number }>; costEstimate?: number; audioSeconds?: number }
const tr = readJson<Tr>(path.join(taskDir, 'transcript.json'));
if (tr) {
  const segs = tr.segments;
  const chars = segs.reduce((a, s) => a + s.text.length, 0);
  const span = segs.length ? segs[segs.length - 1]!.end - segs[0]!.start : 0;
  const speech = segs.reduce((a, s) => a + (s.end - s.start), 0);
  const dur = DUR;
  console.log(`字幕条数      : ${segs.length}`);
  console.log(`总字数        : ${chars}（约 ${num(chars / Math.max(1, dur / 60))} 字/分钟）`);
  console.log(`覆盖区间      : ${num(segs[0]?.start ?? 0)}s – ${num(segs[segs.length - 1]?.end ?? 0)}s（跨度 ${num(span / 60)} 分钟 / 素材 ${num(dur / 60)} 分钟）`);
  console.log(`语音占比      : ${num((speech / Math.max(1, dur)) * 100)}%（说话时间 / 总时长）`);
  console.log(`gaps（缺失）  : ${tr.gaps?.length ?? 0} 处`);
  console.log(`计费音频      : ${num((cost['asrAudioSeconds'] ?? 0) / 60)} 分钟`);
  console.log(`估算费用      : ¥${num(cost['asrEstimate'] ?? 0, 2)}（项目口径 ¥2/小时；阿里云 fun-asr 实际约 ¥0.79/小时 ⇒ 真实约 ¥${num(((cost['asrAudioSeconds'] ?? 0) / 3600) * 0.79, 2)}）`);

  /* 从日志取真实转写耗时 */
  const logs = fs.readFileSync('data/logs/live_auto-2026-09-23.jsonl', 'utf8').trim().split('\n');
  let asrStart = '';
  let asrEnd = '';
  for (const line of logs) {
    try {
      const o = JSON.parse(line) as { ts: string; taskId?: string; msg: string };
      if (o.taskId !== taskId) continue;
      if (/开始转写/.test(o.msg)) asrStart = o.ts;
      if (/转写完成/.test(o.msg)) asrEnd = o.ts;
    } catch { /* 跳过坏行 */ }
  }
  if (asrStart && asrEnd) {
    const sec = (new Date(asrEnd).getTime() - new Date(asrStart).getTime()) / 1000;
    console.log(`转写墙钟耗时  : ${num(sec)}s = ${num(sec / 60)} 分钟   RTF = ${num(sec / Math.max(1, dur), 3)}`);
  }
} else {
  console.log('（读不到 transcript.json）');
}

/* ============================ 3. 弹幕信号 ============================ */
console.log('\n' + '='.repeat(100));
console.log('② 弹幕信号（选片的重要输入）');
console.log('='.repeat(100));
interface Sig { danmakuTotal?: number; peaks?: Array<{ start: number; end: number; count: number; intensity?: number }>; keywords?: Array<{ word: string; count: number }>; highEnergy?: unknown[] }
const sig = readJson<Sig>(path.join(taskDir, 'signals.json'));
if (sig) {
  console.log(`弹幕总数      : ${sig.danmakuTotal ?? 0}`);
  console.log(`密度峰值窗口  : ${sig.peaks?.length ?? 0} 个`);
  const top = [...(sig.peaks ?? [])].sort((a, b) => b.count - a.count).slice(0, 5);
  for (const p of top) console.log(`    ${num(p.start)}–${num(p.end)}s  ${p.count} 条  强度 ${num((p.intensity ?? 0) * 100, 0)}%`);
  const kw = [...(sig.keywords ?? [])].sort((a, b) => b.count - a.count).slice(0, 12);
  console.log(`高频热词      : ${kw.map((k) => `${k.word}(${k.count})`).join('、')}`);
  console.log(`高能事件      : ${sig.highEnergy?.length ?? 0} 个`);
} else {
  console.log('（读不到 signals.json）');
}

/* ============================ 4. 选片结果 ============================ */
console.log('\n' + '='.repeat(100));
console.log('③ 选片结果（LLM 决策）');
console.log('='.repeat(100));
interface Clip { index: number; start: number; end: number; title: string; desc?: string; tags?: string[]; category?: string; score?: number; reason?: string; selected?: boolean; status?: string; cutOutput?: string }
const clipsRaw = readJson<Clip[] | { clips: Clip[] }>(path.join(taskDir, 'clips.json'));
const clips: Clip[] = Array.isArray(clipsRaw) ? clipsRaw : (clipsRaw?.clips ?? []);
if (clips.length) {
  const durs = clips.map((c) => c.end - c.start);
  const scores = clips.map((c) => c.score ?? 0);
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  console.log(`候选数        : ${clips.length}    勾选: ${clips.filter((c) => c.selected).length}`);
  console.log(`时长分布      : ${num(Math.min(...durs))}–${num(Math.max(...durs))}s   均值 ${num(avg(durs))}s`);
  console.log(`评分布局      : 最低 ${num(Math.min(...scores))}  最高 ${num(Math.max(...scores))}  均值 ${num(avg(scores))}`);
  /* 覆盖整场的均匀度：把整场分 6 段，看候选落在哪几段 */
  const dur = DUR;
  const buckets = new Array(6).fill(0) as number[];
  for (const c of clips) buckets[Math.min(5, Math.floor((c.start / Math.max(1, dur)) * 6))]!++;
  console.log(`时间覆盖      : 按时间轴 6 等分 → [${buckets.join(', ')}] 个候选/段`);
  const firstStart = Math.min(...clips.map((c) => c.start));
  const lastEnd = Math.max(...clips.map((c) => c.end));
  console.log(`候选跨度      : ${num(firstStart / 60)} – ${num(lastEnd / 60)} 分钟（占整场 ${num(((lastEnd - firstStart) / Math.max(1, dur)) * 100, 0)}%）`);

  console.log('\n序号  区间(s)          时长   评分  标题');
  console.log('-'.repeat(100));
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    const out = c.cutOutput ? '✓' : '·';
    console.log(
      `${String(c.index).padStart(3)}  ${pad(num(c.start), 8)}–${pad(num(c.end), 8)} ${String(Math.round(c.end - c.start)).padStart(4)}s ${num(c.score ?? 0).padStart(5)} ${out}  ${c.title.slice(0, 52)}`,
    );
  }
  console.log('\n（✓ = 已切片产物，· = 未处理）');
  console.log('\nLLM 给的选片理由（抽样）：');
  for (const c of [...clips].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5)) {
    console.log(`  [${num(c.score ?? 0)}] ${c.title.slice(0, 40)}`);
    console.log(`        ${(c.reason ?? '').slice(0, 90)}`);
    console.log(`        标签: ${(c.tags ?? []).join('、')}   分区: ${c.category ?? '-'}`);
  }
} else {
  console.log('（读不到 clips.json）');
}

/* ============================ 5. LLM 成本 ============================ */
console.log('\n' + '='.repeat(100));
console.log('④ LLM 调用与成本');
console.log('='.repeat(100));
console.log(`调用次数      : ${cost['llmCalls'] ?? 0}`);
console.log(`输入 tokens   : ${cost['llmPromptTokens'] ?? 0}`);
console.log(`输出 tokens   : ${cost['llmCompletionTokens'] ?? 0}`);
console.log(`实际费用      : ¥${num(cost['llmActual'] ?? 0, 4)}`);
const tot = (cost['asrEstimate'] ?? 0) + (cost['llmActual'] ?? 0);
console.log(`合计（项目口径）: ¥${num(tot, 2)}   其中 ASR 占 ${num(((cost['asrEstimate'] ?? 0) / Math.max(0.01, tot)) * 100, 0)}%`);

/* ============================ 6. 切片产物 ============================ */
console.log('\n' + '='.repeat(100));
console.log('⑤ 切片产物');
console.log('='.repeat(100));
const clipsDir = path.join('data', 'clips', taskId);
if (fs.existsSync(clipsDir)) {
  const files = fs.readdirSync(clipsDir).filter((f) => f.endsWith('.mp4'));
  let total = 0;
  for (const f of files.sort()) {
    const sz = fs.statSync(path.join(clipsDir, f)).size;
    total += sz;
    console.log(`  ${(sz / 1048576).toFixed(1).padStart(6)} MB  ${f.slice(0, 70)}`);
  }
  console.log(`  ${'-'.repeat(80)}`);
  console.log(`  共 ${files.length} 个，合计 ${(total / 1048576).toFixed(0)} MB`);
} else {
  console.log('（没有切片目录）');
}

/* ============================ 7. 投稿结果 ============================ */
console.log('\n' + '='.repeat(100));
console.log('⑥ 投稿结果');
console.log('='.repeat(100));
const pubLog = fs.readFileSync('data/publish-log.jsonl', 'utf8').trim().split('\n');
const mine = pubLog
  .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
  .filter((x): x is Record<string, unknown> => x !== null && x['taskId'] === taskId);
console.log(`本场投稿事件  : ${mine.length} 条`);
for (const e of mine.slice(-12)) {
  const tm = String(e['at'] ?? '').slice(11, 19);
  console.log(`  ${tm}  ${pad(String(e['action']), 8)} clip#${pad(String(e['clipIndex'] ?? '-'), 3)} ${e['bvid'] ? `bvid=${e['bvid']}` : ''} ${String(e['title'] ?? '').slice(0, 40)}`);
}
console.log(`\n排期条目      : ${schedule.length}`);
