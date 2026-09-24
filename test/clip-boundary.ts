/**
 * 切片边界吸附自测（问题来自真实反馈：「唱歌的时候歌词刚唱完，切片就突然结束了」）。
 *
 * 背景：选片 LLM **看不到转写原文**，只拿到「时间窗要点」，所以它给出的 end 是拍脑袋的近似值 ——
 * 实测真实任务的 9 个候选，end 全部落在 1.5 秒网格上（`xxx.5`），结合 bufferSec 后仍有 5 个
 * 切在句子中间（有一个距上一句结束 13.26 秒）。
 *
 * 这里用**构造的转写段落**把这些场景固定下来，避免以后再退化。
 * 运行：node test/clip-boundary.ts
 */
import { sanitizeClips, type SanitizeReport } from '../src/analyze.ts';
import { PromptStore } from '../src/analyze.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/** 一整套接近真实直播的转写：语句连续，句间有 0.2–1.2 秒小间隙 */
const SEGS = [
  { start: 10.0, end: 13.2, text: '欢迎来到直播间' },
  { start: 13.4, end: 18.9, text: '今天我们聊点别的' },
  { start: 19.1, end: 24.5, text: '先回答一下大家的问题' },
  { start: 25.0, end: 31.5, text: '第一个问题是关于行程的' },
  { start: 32.0, end: 40.0, text: '我下周要去朋友的工作室' },
  { start: 41.0, end: 52.0, text: '然后是中秋那天我会播到很晚' },
  { start: 53.0, end: 64.0, text: '最后谢谢大家的礼物' },
  // 唱歌段落：歌词一句接一句，几乎没有空隙（这是"突然结束"最容易暴露的地方）
  { start: 200.0, end: 203.5, text: '月亮代表我的心' },
  { start: 203.6, end: 208.2, text: '轻轻的一个吻' },
  { start: 208.3, end: 213.0, text: '已经打动我的心' },
  { start: 213.1, end: 218.4, text: '深深的一段情' },
  { start: 218.5, end: 224.0, text: '教我思念到如今' },
  { start: 224.1, end: 230.0, text: '你问我爱你有多深' },
];

const BASE = {
  videoDuration: 3600,
  minDurationSec: 30,
  maxDurationSec: 90,
  bufferSec: 1.5,
  maxClips: 6,
  tidWhitelist: { '生活/日常': 21 } as Record<string, number>,
  defaultCategory: '生活/日常',
  defaultTags: ['直播切片'],
  tagSensitiveWords: [] as string[],
  autoSelectScoreFloor: 6,
  /* 默认勾选上限：这些用例的候选数远少于它，不会触发收口（场景 10 单独验证收口） */
  autoSelectTopN: 50,
};

function candidate(start: number, end: number, title = '测试片段', score = 8) {
  return { start, end, title, desc: '简介', tags: ['测试'], category: '生活/日常', score, reason: '理由', cover_ts: start + 1 };
}

function run(
  clips: ReturnType<typeof candidate>[],
  opts: { segs?: boolean; maxSnapAheadSec?: number; partBoundaries?: number[] } = {},
): SanitizeReport {
  return sanitizeClips(clips, {
    ...BASE,
    ...(opts.segs === false ? {} : { transcriptSegments: SEGS, maxSnapAheadSec: opts.maxSnapAheadSec ?? 4 }),
    ...(opts.partBoundaries ? { partBoundaries: opts.partBoundaries } : {}),
  });
}

/** 结尾是否切在某一句话的中间 */
function midSentenceEnd(end: number): { text: string; overflow: number } | undefined {
  for (const s of SEGS) {
    if (end > s.start + 0.05 && end < s.end - 0.05) return { text: s.text, overflow: s.end - end };
  }
  return undefined;
}

/* ============================ 场景 1：结束点吸附 ============================ */
section('场景 1：结尾切在句子中间 → 吸附到句子边界');
{
  // 注意 bufferSec 先于吸附生效：raw end=37.0 → 加 buffer 变成 38.5，
  // 38.5 落在「我下周要去朋友的工作室」(32.0–40.0) 中间，且距该句结束 1.5s。
  // 最近的自然边界是 40.0（距 1.5s）与 41.0（距 2.5s）→ 应吸到 40.0。
  const r = run([candidate(10, 37.0)]);
  const c = r.clips[0]!;
  ok('候选没有被丢弃', r.clips.length === 1, `实际 ${r.clips.length} 个`);
  ok('结尾不再切在句子中间', midSentenceEnd(c.end) === undefined, `end=${c.end}`);
  ok('结尾精确吸附到该句结束时刻 40.0', Math.abs(c.end - 40.0) < 0.05, `end=${c.end}`);
  ok('产生了可读的对齐警告', r.warnings.some((w) => w.includes('自然断句点')), r.warnings.join(' | '));
}

/* ============================ 场景 2：唱歌/歌词连续段 ============================ */
section('场景 2：歌词一句接一句（最典型的"突然结束"）');
{
  // 歌词句之间只有 0.1s 空隙（实测如此），所以"停顿"必须按很小阈值识别 ——
  // 阈值取 0.35/0.12 都会在密集唱歌区段里一个可吸的点都找不到。
  //
  // 这里的核心不变量是：**要么给出不切在歌词句中间的结尾，要么如实丢弃**，
  // 绝不能出现"保留下来但切在半句歌词上"。构造数据的窗口长度会影响保留/丢弃，
  // 所以不断言具体哪一个，只断言不变量。
  for (const [startRaw, endRaw] of [
    [200, 221],
    [195, 221],
    [200, 218],
  ] as const) {
    const r = run([candidate(startRaw, endRaw)]);
    const c = r.clips[0];
    if (c) {
      ok(
        `窗口 ${startRaw}–${endRaw}：保留时结尾不在歌词句中间`,
        midSentenceEnd(c.end) === undefined,
        `end=${c.end} 落在「${midSentenceEnd(c.end)?.text}」内`,
      );
      ok(
        `窗口 ${startRaw}–${endRaw}：时长不越界`,
        c.end - c.start >= 30 * 0.95 - 0.01 && c.end - c.start <= 90 + 0.01,
        `${(c.end - c.start).toFixed(1)}s`,
      );
    } else {
      ok(
        `窗口 ${startRaw}–${endRaw}：丢弃理由是时长（不是切半句）`,
        r.dropped.some((d) => d.reason.includes('时长')),
        r.dropped.map((d) => d.reason).join(' | '),
      );
    }
  }
}

/* ============================ 场景 3：硬约束不能被破坏 ============================ */
section('场景 3：吸附不能破坏时长上下限');
{
  // raw end=88 → buffer 后 89.5，起点 8.5 → 时长 81s。吸附到 90.0 会正好等于上限，必须仍然合法
  const r = run([candidate(10, 88)]);
  const c = r.clips[0];
  ok('候选仍被保留（没有因吸附而丢弃）', Boolean(c), '候选被丢弃了');
  if (c) {
    ok('时长不超过 maxDurationSec=90', c.end - c.start <= 90 + 0.01, `${(c.end - c.start).toFixed(2)}s`);
    ok('时长不低于 minDurationSec=30', c.end - c.start >= 30, `${(c.end - c.start).toFixed(2)}s`);
  }
}

/* ============================ 场景 4：吸附上限与选点策略 ============================ */
section('场景 4：maxSnapAheadSec 控制"最多往前找多久"');
{
  // (a) 落在段间空隙：raw end=68.5 → buffer 后 70.0，落在 (64.0 – 200.0) 这段长空隙里。
  //     "最近的自然断句点"就是上一句说完的 64.0（向后 6s）。向后吸附不受 maxSnapAheadSec 约束，
  //     因为它缩短片段、不会切掉话头，且正合"宁可短而完整"。所以上限大小都该吸到 64.0。
  const tight = run([candidate(10, 68.5)], { maxSnapAheadSec: 1.5 });
  const loose = run([candidate(10, 68.5)], { maxSnapAheadSec: 8 });
  ok('空隙中收尾到上一句说完处 64.0（上限小）', Math.abs(tight.clips[0]!.end - 64.0) < 0.05, `end=${tight.clips[0]!.end}`);
  ok('空隙中收尾到上一句说完处 64.0（上限大）', Math.abs(loose.clips[0]!.end - 64.0) < 0.05, `end=${loose.clips[0]!.end}`);

  // (b) 上限只管"向前硬拽"：raw end=71.5 → 73.0，仍在空隙里，下一句要到 200.0 才开口。
  //     74.0 之上没有任何句子，所以无论如何都不该跳到 200.0（那会凭空多出 127 秒）
  const noJump = run([candidate(10, 71.5)], { maxSnapAheadSec: 8 });
  ok('绝不跳到很远的下下句（不出现 200.0）', noJump.clips[0]!.end < 100, `end=${noJump.clips[0]!.end}`);

  // (c) 两边都可行时取**离 LLM 意图最近**的：raw end=47.5 → 49.0；
  //     落句是 [41.0, 52.0]，候选 = 该句说完 52.0（距 3.0）、句首 41.0（距 8.0）、
  //     上一句说完 40.0（距 9.0）、下一句说完 64.0（距 15.0 > 上限 8 不收）→ 应取 52.0。
  //     注意**不把"下一句开口"53.0 当候选**：那是新句子的开头，不是收尾点。
  const nearest = run([candidate(10, 47.5)], { maxSnapAheadSec: 8 });
  ok('两边都可行时取最近的 52.0（该句说完处）', Math.abs(nearest.clips[0]!.end - 52.0) < 0.05, `end=${nearest.clips[0]!.end}`);
}

/* ============================ 场景 5：向后兼容 ============================ */
section('场景 5：没有转写时退化为旧行为（不能报错、不能丢片）');
{
  const r = run([candidate(10, 37.0)], { segs: false });
  ok('无转写时不报错且保留候选', r.clips.length === 1, `实际 ${r.clips.length}`);
  ok('无转写时不做吸附（end = raw + buffer = 38.5）', Math.abs(r.clips[0]!.end - 38.5) < 0.01, `end=${r.clips[0]!.end}`);
  ok('无转写时不产生吸附警告', !r.warnings.some((w) => w.includes('吸附')), r.warnings.join(' | '));
}

/* ============================ 场景 6：起点只往更早方向挪 ============================ */
section('场景 6：起点吸附方向必须是安全的（不能切掉话头）');
{
  // raw start=11.2 → 减 buffer 变成 9.7，仍在「欢迎来到直播间」(10.0–13.2) 之前 → 不动
  // raw start=12.7 → 减 buffer 变成 11.2，落在该句中间 → 应提前到句首 10.0（而不是推到 13.4）
  const before = run([candidate(11.2, 37.0)]);
  const inside = run([candidate(12.7, 37.0)]);
  ok('起点在首句之前时保持不动（9.7）', Math.abs(before.clips[0]!.start - 9.7) < 0.05, `start=${before.clips[0]!.start}`);
  ok('起点落在句中时提前到句首 10.0', Math.abs(inside.clips[0]!.start - 10.0) < 0.05, `start=${inside.clips[0]!.start}`);
  ok('起点绝不被向后挪（不会切掉话头）', inside.clips[0]!.start <= 11.2, `start=${inside.clips[0]!.start}`);
}

/* ============================ 场景 7：唱歌区段兜底 ============================ */
section('场景 7：结尾落在唱歌区段内 → 顺延到歌结束（用户反馈的"唱着就断"）');
{
  // 唱歌区段 200–230；LLM 给的结尾落在歌里。起点 100 → 顺延到 230 后时长 130s，在上限 90 内？
  // 不 —— 130 > 90，所以这里用更近的起点，让顺延可行。
  const SONG = [{ start: 200, end: 230 }];
  const runWithSong = (clips: ReturnType<typeof candidate>[], songRegions = SONG) =>
    sanitizeClips(clips, { ...BASE, transcriptSegments: SEGS, maxSnapAheadSec: 4, songRegions });

  // 起点 175（buffer 后），结尾 227.5（buffer 后落在歌里 200–230）
  const r = runWithSong([candidate(175, 226)]);
  const c = r.clips[0];
  ok('候选被保留', Boolean(c), '被丢弃了');
  if (c) {
    ok(
      '结尾不再落在歌里（≥ 230 或已避开）',
      c.end >= 230 - 0.05 || c.end <= 200 + 0.05,
      `end=${c.end}，时长=${(c.end - c.start).toFixed(1)}s`,
    );
    ok('时长仍在上限内', c.end - c.start <= BASE.maxDurationSec + 0.01, `${(c.end - c.start).toFixed(1)}s`);
  }
  ok(
    '有可读的说明（顺延到歌结束，或已被断句点对齐到歌外）',
    r.warnings.some((w) => w.includes('唱歌') || w.includes('自然断句点')),
    r.warnings.join(' | '),
  );

  // 顺延会超上限时必须放弃顺延（不能为了避开歌而把片段撑成超长）
  const tooLong = runWithSong([candidate(100, 226)]);
  const c2 = tooLong.clips[0];
  if (c2) {
    ok(
      '顺延会超上限时不硬撑（保持在上限内）',
      c2.end - c2.start <= BASE.maxDurationSec + 0.01,
      `时长=${(c2.end - c2.start).toFixed(1)}s`,
    );
  }
}

/* ============================ 场景 8：prompt 缓存必须随文件改动失效 ============================ */
section('场景 8：prompt 改了要立刻生效（不能等到重启服务）');
{
  // 本项目的 prompt 迭代方式就是直接改 prompts/*.md，而 Analyzer/PromptStore 在
  // Orchestrator 构造时只创建一次、长驻内存。缓存若不校验 mtime，改动就会**直到重启才生效** ——
  // 实测踩过：改完 select.md 跑付费验证，用的仍是旧提示词，白花一轮钱。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prompt-'));
  const file = path.join(dir, 'select.md');
  fs.writeFileSync(file, '版本A', 'utf8');
  const store = new PromptStore(dir);
  ok('首次读取得到内容', store.get('select') === '版本A', store.get('select'));
  ok('重复读取走缓存（值不变）', store.get('select') === '版本A');

  // 模拟用户改写 prompt（间隔一下确保 mtime 变化）
  const t0 = Date.now();
  while (Date.now() - t0 < 20) { /* 等 20ms */ }
  fs.writeFileSync(file, '版本B', 'utf8');
  ok('改写后**立刻**读到新内容（mtime 失效生效）', store.get('select') === '版本B', store.get('select'));

  // 文件被删：走缓存兜底，不抛异常
  fs.rmSync(file);
  let fallback = '';
  try {
    fallback = store.get('select');
  } catch (e) {
    fallback = `抛错：${(e as Error).message}`;
  }
  ok('文件被删时用缓存兜底（不崩）', fallback === '版本B', fallback);

  // clearCache 后文件已删 → 应如实抛错而不是返回错值
  store.clearCache();
  let threw = false;
  try {
    store.get('select');
  } catch {
    threw = true;
  }
  ok('清缓存后文件缺失会如实报错', threw, '没有报错');

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ============================ 场景 9：分P 边界防护 ============================
 * 本场被 biliLive-tools 切成多个分P 上传。跨越分界的切片在 B站 上会被拆到
 * 两个分P（观众只看到一半），所以必须收口到某一侧，收不下就丢弃。
 * 注意：这些用例刻意**只传 transcriptSegments 里存在的句子**，避免吸附把结论搅乱。
 */
section('场景 9：切片不得跨越分P 边界');
{
  const SEG9 = [
    { start: 100, end: 130, text: '边界前的一句（够长，便于吸附）' },
    { start: 131, end: 160, text: '边界前的另一句' },
    { start: 200, end: 230, text: '边界后的一句' },
    { start: 231, end: 260, text: '边界后的另一句' },
    { start: 300, end: 330, text: '更后面的一句' },
  ];
  const B9 = 190; // 分P 边界
  const base9 = {
    ...BASE,
    transcriptSegments: SEG9,
    maxSnapAheadSec: 4,
    partBoundaries: [B9],
  };

  // ① 结尾落在句尾、起点被吸附，结果正好不跨界 → 无需收口，也不该误报警告
  {
    const r = sanitizeClips([candidate(120, 240)], base9);
    ok('吸附后不跨界 → 保留', r.clips.length === 1, `实际 ${r.clips.length} 个`);
    const c = r.clips[0];
    ok('结尾落在分P 边界之内', c !== undefined && c.end <= B9 + 0.01, `end=${c?.end}`);
    ok('没有多余的跨分P 警告（吸附已解决）', !r.warnings.some((w) => /分P 边界/.test(w)), r.warnings.join(' | ').slice(0, 120));
  }

  // ② 起点落在句子中间 → 吸附后仍跨界，且右侧放得下 → 收口并给出警告
  {
    const r = sanitizeClips([candidate(180, 260)], base9);
    ok('跨界片段被保留（改取右侧）', r.clips.length === 1, `实际 ${r.clips.length} 个`);
    const c = r.clips[0];
    ok('起点已推到分P 边界之后', c !== undefined && c.start >= B9 - 0.01, `start=${c?.start}`);
    ok('给出「已收口」警告', r.warnings.some((w) => /分P 边界/.test(w)), r.warnings.join(' | ').slice(0, 120));
  }

  // ③ 两侧都放不下 → 丢弃，且理由点明「跨分P」
  {
    const r = sanitizeClips([candidate(185, 195)], base9); // 仅 10s，两侧都 < minDurationSec(30)
    ok('两侧都放不下时被丢弃', r.clips.length === 0, `实际 ${r.clips.length} 个`);
    ok('丢弃理由说明是跨分P', r.dropped.some((d) => /跨越分P/.test(d.reason)), JSON.stringify(r.dropped.map((d) => d.reason)).slice(0, 140));
  }

  // ④ 不跨界 → 不受影响
  {
    const r = sanitizeClips([candidate(100, 160)], base9);
    ok('不跨界的片段原样保留', r.clips.length === 1 && (r.clips[0]?.end ?? 0) <= 160.5, `end=${r.clips[0]?.end}`);
    ok('不跨界时不产生分P 警告', !r.warnings.some((w) => /分P 边界/.test(w)), r.warnings.join(' | ').slice(0, 100));
  }

  // ⑤ 不传 partBoundaries → 旧行为不变（回归保护）
  {
    const r = sanitizeClips([candidate(120, 240)], { ...BASE, transcriptSegments: SEG9, maxSnapAheadSec: 4 });
    ok('未传分P 边界时不做收口（回归保护）', r.clips.length === 1, `实际 ${r.clips.length} 个`);
  }
}

/* ============================ 场景 10：默认勾选收口 ============================
 * 实测教训：一场 59 分钟直播 LLM 给出 14 个候选、**全部 ≥ 7.0**（最低正好卡在门槛 7.0），
 * 绝对门槛一个都没挡住 ⇒ 14 个全部自动切片并发布。改用「按评分降序取前 N 个」收口。
 */
section('场景 10：默认勾选按相对排名收口（最多 N 个）');
{
  /* 6 个互不重叠的候选，评分故意拉开；门槛设 6 让它们全部"达标" */
  const many = [
    candidate(100, 130, 'A', 9.0),
    candidate(200, 230, 'B', 8.5),
    candidate(300, 330, 'C', 8.0),
    candidate(400, 430, 'D', 7.5),
    candidate(500, 530, 'E', 7.0),
    candidate(600, 630, 'F', 6.5),
  ];
  const base10 = { ...BASE, autoSelectScoreFloor: 6, transcriptSegments: [] };

  // ① 上限 3 → 只勾选评分最高的 3 个
  {
    const r = sanitizeClips(many, { ...base10, autoSelectTopN: 3 });
    const sel = r.clips.filter((c) => c.selected);
    ok('保留全部 6 个候选（不丢信息）', r.clips.length === 6, `实际 ${r.clips.length}`);
    ok('只默认勾选 3 个', sel.length === 3, `实际 ${sel.length}`);
    const scores = sel.map((c) => c.score).sort((a, b) => b - a);
    ok('勾选的是评分最高的 3 个', scores.join(',') === '9,8.5,8', `实际 ${scores.join(',')}`);
    ok('给出了收口警告', r.warnings.some((w) => /默认勾选上限/.test(w)), r.warnings.join(' | ').slice(0, 120));
  }

  // ② 上限大于候选数 → 全部勾选（不误伤）
  {
    const r = sanitizeClips(many, { ...base10, autoSelectTopN: 99 });
    ok('上限足够时不收口', r.clips.filter((c) => c.selected).length === 6, `实际 ${r.clips.filter((c) => c.selected).length}`);
    ok('未产生收口警告', !r.warnings.some((w) => /默认勾选上限/.test(w)));
  }

  // ③ 绝对门槛仍然有效（低于门槛的本就不该勾选）
  {
    const r = sanitizeClips(many, { ...base10, autoSelectScoreFloor: 7.5, autoSelectTopN: 99 });
    const sel = r.clips.filter((c) => c.selected);
    ok('低于绝对门槛的不勾选', sel.every((c) => c.score >= 7.5), sel.map((c) => c.score).join(','));
    ok('绝对门槛下勾选 4 个（9/8.5/8/7.5）', sel.length === 4, `实际 ${sel.length}`);
  }

  // ④ 收口后 index 仍与数组下标一致（UI 用 idx 做 PATCH 目标）
  {
    const r = sanitizeClips(many, { ...base10, autoSelectTopN: 2 });
    const consistent = r.clips.every((c, i) => c.index === i);
    ok('index 与数组下标保持一致', consistent, r.clips.map((c) => c.index).join(','));
  }
}

/* ===================== 场景 11：能量边界修正（不做字幕也要做的那道护栏） =====================
 * 实测事故（2026-09-24）：云 ASR 给出「15 个字占 0→30.9 秒」的假窗口，
 * 而转写吸附是**按 ASR 段边界**做的 —— 于是切片起点正好落在假窗口的开头，
 * 成片前 28 秒只有背景音（响度 −31…−38 dB），观众看到的是空转。
 * 这里用**音频能量**兜一道（不依赖 ASR），验证：该裁的裁、不该动的不动、约束不被破坏。 */
{
  section('场景 11：能量边界修正（开头/结尾没人说话时用音频把人声位置找回来）');

  /** 造一个"只有指定区间有人说话"的假能量剖面 */
  const profileWith = (speech: Array<[number, number]>, durationSec = 600) => {
    const binSec = 0.5;
    const rms: number[] = [];
    for (let t = 0; t < durationSec; t += binSec) {
      const talking = speech.some(([a, b]) => t >= a && t < b);
      rms.push(talking ? 0.25 : 0.008); // 人声 −12 dB vs 背景 −42 dB，余量足够
    }
    return { binSec, rms, durationSec };
  };
  const trimOpts = { boundarySpeechTrimSec: 30, energyProfile: profileWith([[120, 160], [300, 340]]) };

  // ① 开头 28 秒没人说话 → 起点拉到第一个人声位置
  {
    const r = sanitizeClips([candidate(100, 150)], {
      ...BASE,
      transcriptSegments: [{ start: 100, end: 150, text: '一句话' }],
      maxSnapAheadSec: 4,
      ...trimOpts,
    });
    const c = r.clips[0]!;
    ok('开头没人说话 → 起点从 100s 拉到 120s 的人声起点', Math.abs(c.start - 120) < 1, `实际 ${c.start}`);
    ok('并且说明了原因（运维/用户能看到为什么变了）', r.warnings.some((w) => /没人说话/.test(w)), r.warnings.join(' | ').slice(0, 120));
  }

  // ② 正常的开场留白（2.5 秒）不该被动（注意 bufferSec=1.5 会把 100s 变成 98.5s，这是原有行为）
  {
    const r = sanitizeClips([candidate(100, 150)], {
      ...BASE,
      transcriptSegments: [{ start: 100, end: 150, text: '一句话' }],
      maxSnapAheadSec: 4,
      ...trimOpts,
      energyProfile: profileWith([[102.5, 160]]),
    });
    ok('2.5 秒的开场留白保持原样（只受原有 buffer 影响，不被裁到 120s）', Math.abs(r.clips[0]!.start - 98.5) < 0.2, `实际 ${r.clips[0]!.start}`);
  }

  // ③ 结尾没人说话 → 收回最后一个人声位置
  {
    const r = sanitizeClips([candidate(300, 355)], {
      ...BASE,
      transcriptSegments: [{ start: 300, end: 355, text: '一句话' }],
      maxSnapAheadSec: 4,
      ...trimOpts,
      energyProfile: profileWith([[300, 350]]),
    });
    const c = r.clips[0]!;
    ok('结尾没人说话 → 结尾收到 350s（最后一个人声之后）', Math.abs(c.end - 350) <= 1, `实际 ${c.end}`);
  }

  // ④ 裁完不能低于时长下限（宁可不动，也不能产出过短片段）
  {
    const r = sanitizeClips([candidate(100, 140)], {
      ...BASE,
      minDurationSec: 35, // 只要 98.5→120 就只剩 20 秒，必须放弃这次修正
      transcriptSegments: [{ start: 100, end: 140, text: '一句话' }],
      maxSnapAheadSec: 4,
      ...trimOpts,
    });
    const c = r.clips[0]!;
    ok('修正会破坏时长下限时不修正（起点保持 98.5s）', Math.abs(c.start - 98.5) < 0.2, `实际 ${c.start}`);
    ok('片段时长仍然合规', c.end - c.start >= 35, `${(c.end - c.start).toFixed(1)}s`);
  }

  // ⑤ 关闭开关 / 没有剖面 → 行为与旧版完全一致
  {
    const a = sanitizeClips([candidate(100, 150)], {
      ...BASE,
      transcriptSegments: [{ start: 100, end: 150, text: '一句话' }],
      maxSnapAheadSec: 4,
      energyProfile: trimOpts.energyProfile,
      boundarySpeechTrimSec: 0, // ⚠️ 必须放在展开之后，否则会被覆盖（踩过）
    });
    const b = sanitizeClips([candidate(100, 150)], {
      ...BASE,
      transcriptSegments: [{ start: 100, end: 150, text: '一句话' }],
      maxSnapAheadSec: 4,
      boundarySpeechTrimSec: 30, // 开着，但没有剖面
    });
    ok('关掉开关 → 起点不动（可一键回退）', Math.abs(a.clips[0]!.start - 98.5) < 0.2, `实际 ${a.clips[0]!.start}`);
    ok('拿不到剖面 → 同样不动（不阻塞出片）', Math.abs(b.clips[0]!.start - 98.5) < 0.2, `实际 ${b.clips[0]!.start}`);
  }
}

/* ============================ 汇总 ============================ */
console.log('');
if (fail === 0) {
  console.log(`\x1b[32m===== 切片边界吸附自测：PASS=${pass} FAIL=0 =====\x1b[0m`);
  console.log('边界会吸附到自然断句点；时长上下限、无转写退化、起点方向均未被破坏。');
  process.exit(0);
} else {
  console.log(`\x1b[31m===== 切片边界吸附自测：PASS=${pass} FAIL=${fail} =====\x1b[0m`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
