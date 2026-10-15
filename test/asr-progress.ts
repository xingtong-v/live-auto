/**
 * 精确转写进度的**纯逻辑**单测（2026-10-15，用户需求「精确进度」）。
 *
 * 为什么要钉这么细：界面上那两个数字（百分比、剩余时间）是用户**据以做决定**的东西 ——
 * "还要跑 15 分钟就等它"，还是"还要 10 小时就去睡觉"。错一个量级比不显示更糟。
 * 而这类聚合逻辑一旦写歪，表现是"跑了几十分钟才发现数字不对"，用真机验证一次要半小时以上；
 * 这里全部用假的 tick 序列，毫秒级就能把边界钉死。
 *
 * 覆盖的边界（都是真机上真会遇到的）：
 *   ① 只有 asr 阶段推进"已处理音频"——抽音频/切句/加载模型那三段没有细粒度进度，
 *      它们要是也推了进度，界面会在开头就跳到 100%（实测踩过：抽取音频完成时报了整块时长）；
 *   ② 进度**只增不减**（并发两块时上报会交错）；
 *   ③ 末尾静音不会被 VAD 覆盖 ⇒ 必须有"整块完成"的兜底，否则永远停在 99%；
 *   ④ 没测到速度时 `etaSec` 必须是 `null`（界面写"计算中"），**绝不许**拿标称速度冒充；
 *   ⑤ 还没开始的块要算进 ETA 的固定成本（Fun-ASR 每块约 96 秒加载，不算是纯撒谎）。
 */
import {
  AsrProgressTracker,
  DEFAULT_LOAD_SEC,
  fmtSecShort,
  parseAsrProgressLine,
  ASR_PROGRESS_PREFIX,
} from '../src/asr-progress.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(title: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${title}`);
  } else {
    fail++;
    failures.push(`${title}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${title}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(title: string, actual: unknown, want: unknown): void {
  ok(title, Object.is(actual, want), `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(want)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

section('1. 执行器进度行的解析（失败一律返回 undefined，绝不能让观测拖垮转写）');
{
  const line = `${ASR_PROGRESS_PREFIX} {"phase": "asr", "done_sec": 512.5, "total_sec": 1800, "seg_done": 40, "seg_total": 180, "speed": 8.9, "elapsed_ms": 132000}`;
  const t = parseAsrProgressLine(line);
  eq('正常行能解析出阶段', t?.phase, 'asr');
  eq('已推进音频秒', t?.doneSec, 512.5);
  eq('本块总时长', t?.totalSec, 1800);
  eq('句子进度', t?.segDone, 40);
  eq('实测速度', t?.speed, 8.9);
  eq('固定成本（毫秒）', t?.elapsedMs, 132000);

  /* 真机上这一行混在 funasr 自己的日志里（stdout 被改道到 stderr），所以前面有噪声是常态 */
  const noisy = `[funasr] 2026-10-15 INFO loading model... ${ASR_PROGRESS_PREFIX} {"phase":"vad","done_sec":0,"total_sec":60}`;
  eq('前缀前面有噪声也能解析', parseAsrProgressLine(noisy)?.phase, 'vad');

  eq('没有前缀 → undefined', parseAsrProgressLine('[funasr] model loaded'), undefined);
  eq('JSON 坏了 → undefined', parseAsrProgressLine(`${ASR_PROGRESS_PREFIX} {not json}`), undefined);
  eq('没见过的阶段 → undefined', parseAsrProgressLine(`${ASR_PROGRESS_PREFIX} {"phase":"teleport","done_sec":1,"total_sec":2}`), undefined);
  const bare = parseAsrProgressLine(`${ASR_PROGRESS_PREFIX} {"phase":"asr"}`);
  eq('缺数字字段时取 0（不抛）', `${bare?.doneSec}/${bare?.totalSec}`, '0/0');
  eq('速度为 0 时不写进 tick（避免拿 0 当速度去除）', bare?.speed, undefined);
}

section('2. 只有 asr 阶段推进"已处理音频"');
{
  const tr = new AsrProgressTracker([{ audioSec: 1800 }]);
  const snap0 = tr.snapshot();
  eq('刚建好：0%', snap0.pct, 0);
  eq('刚建好：阶段=排队中', snap0.phase, '排队中');
  eq('刚建好：没有速度 ⇒ 剩余时间算不出来（不许猜）', snap0.etaSec, null);

  tr.markStarted(0);
  eq('开始跑：阶段=抽取音频', tr.snapshot().phase, '抽取音频');
  /* 执行器在抽取音频/切句结束时**会**报一行（带整块时长），但那是"阶段播报"，不是"进度" */
  tr.onTick(0, { phase: 'extract', doneSec: 1800, totalSec: 1800 });
  eq('抽音频完成 ≠ 转写完成', tr.snapshot().pct, 0);
  tr.onTick(0, { phase: 'vad', doneSec: 1800, totalSec: 1800 });
  eq('切句完成 ≠ 转写完成', tr.snapshot().pct, 0);
  tr.onTick(0, { phase: 'load', doneSec: 1800, totalSec: 1800, elapsedMs: 95000 });
  eq('加载模型 ≠ 转写完成', tr.snapshot().pct, 0);
  eq('阶段如实显示"加载模型"（用户能看出卡在哪一步）', tr.snapshot().phase, '加载模型');
}

section('3. 实测百分比与剩余时间（本模块存在的理由）');
{
  /* 4 块 × 600 秒 = 2400 秒音频。第 1 块推进到 300 秒，实测速度 10 音频秒/墙上秒。 */
  const tr = new AsrProgressTracker([{ audioSec: 600 }, { audioSec: 600 }, { audioSec: 600 }, { audioSec: 600 }]);
  tr.markStarted(0);
  tr.markStarted(1); // parallel=1 时不会同时开始，但真机上"预转写"与"流水线"可能重叠 ⇒ 必须容错
  const t0 = tr.snapshot(0);
  eq('没有任何实测之前：算不出剩余时间', t0.etaSec, null);

  tr.onTick(0, { phase: 'asr', doneSec: 0, totalSec: 600, segDone: 0, segTotal: 200, speed: 0, elapsedMs: 100000 });
  tr.onTick(0, { phase: 'asr', doneSec: 300, totalSec: 600, segDone: 80, segTotal: 200, speed: 10, elapsedMs: 130000 });
  const s1 = tr.snapshot();
  eq('已处理音频 = 300 秒', s1.audioDoneSec, 300);
  eq('总音频 = 2400 秒', s1.audioTotalSec, 2400);
  eq('百分比 = 300/2400 = 13%', s1.pct, 13);
  eq('实测速度原样带出', s1.speed, 10);
  /* ETA = 剩余 2100 / 10 = 210 秒 + 还没开始的 2 块 × 100 秒（实测固定成本） = 410 */
  eq('剩余时间 = 剩余音频÷实测速度 + 未开始的块×实测固定成本', s1.etaSec, 410);
  eq('块进度如实报出', `${s1.chunksDone}/${s1.chunksTotal}`, '0/4');
  ok('进度文案里同时有百分比与音频量', /转写中 13%/.test(s1.label) && /5 分 0 秒/.test(s1.label), s1.label);
}

section('4. 单调性、并发交错、末尾静音');
{
  const tr = new AsrProgressTracker([{ audioSec: 600 }, { audioSec: 600 }]);
  tr.onTick(0, { phase: 'asr', doneSec: 400, totalSec: 600, speed: 8 });
  const before = tr.snapshot().audioDoneSec ?? 0;
  /* 另一块刚起步、报了个更小的位置 —— 总进度不能因此变小（两块是**相加**的关系） */
  tr.onTick(1, { phase: 'asr', doneSec: 10, totalSec: 600, speed: 8 });
  const after = tr.snapshot().audioDoneSec ?? 0;
  ok('进度只增不减（并发上报交错也不会来回跳）', after >= before, `${before} → ${after}`);

  /* 末尾静音：VAD 覆盖不到，执行器显式报"到末尾" */
  const trEnd = new AsrProgressTracker([{ audioSec: 600 }]);
  trEnd.onTick(0, { phase: 'asr', doneSec: 599.8, totalSec: 600, speed: 8 });
  eq('报"到末尾"即算这一块完成（否则永远停在 99%）', trEnd.snapshot().audioDoneSec, 600);
  eq('该块跑完 ⇒ 100%', trEnd.snapshot().pct, 100);

  /* 命中缓存 / dry-run 跳过：没有 tick，只有 markDone */
  const tr2 = new AsrProgressTracker([{ audioSec: 100 }, { audioSec: 100 }]);
  tr2.markDone(0);
  eq('命中缓存也按整块完成计', tr2.snapshot().pct, 50);
  tr2.markDone(1);
  eq('两块都完成 ⇒ 100%', tr2.snapshot().pct, 100);
  eq('全完成时算出的剩余时间 = 0', tr2.snapshot().etaSec, 0);
  eq('没有音频信息时不算除零（0 秒音频 = 已完成）', new AsrProgressTracker([{ audioSec: 0 }]).snapshot().etaSec, 0);
}

section('5. 没测到速度时**不许**猜（etaSec=null，界面写"计算中"）');
{
  const tr = new AsrProgressTracker([{ audioSec: 900 }]);
  tr.markStarted(0);
  tr.onTick(0, { phase: 'asr', doneSec: 100, totalSec: 900, elapsedMs: 120000 });
  const s = tr.snapshot();
  eq('已处理音频照样精确', s.audioDoneSec, 100);
  eq('百分比照样精确', s.pct, 11);
  eq('剩余时间仍然是 null（还没测到速度）', s.etaSec, null);
  eq('速度字段为 null', s.speed, null);
  ok('默认固定成本只是个兜底常量（有实测就会被覆盖）', DEFAULT_LOAD_SEC > 0, String(DEFAULT_LOAD_SEC));
}

section('6. 时间文案');
{
  eq('秒', fmtSecShort(45), '45 秒');
  eq('分秒', fmtSecShort(6192), '1 小时 43 分');
  eq('短分', fmtSecShort(272), '4 分 32 秒');
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
