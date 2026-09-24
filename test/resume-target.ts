/**
 * 续传目标解析自测：切片要追加进 **biliLive-tools 已投出的那个稿件**（同一个稿件）。
 *
 * 背景（真实数据）：biliLive-tools 把一场直播的分段录播投成**一个稿件的 N 个分P**
 * （实测 `BV13hhE6XEQM` 有 14 个分P：7 段弹幕版 + 7 段纯享版；
 * `BV1sqhq6hEZ2` 10 个、`BV1Abh66eEuh` 4 个）。它自己的 `live.aid` 只在内存里，
 * 所以只能从稿件列表反查 —— 而旧实现把 `{anchor}` 渲染成**空串**
 * （`guessAnchorName([], …)` 传的是空数组），导致标题永远差一个账号名前缀：
 * 实测「精确命中 0 个」→ 每次都新建稿件，切片进不了同一个稿件。
 *
 * 本测试锁住六件事：
 *   1. 主播名候选缺失（空串变体）→ 不命中（回归旧缺陷）
 *   2. 用稿件列表反推的主播名 → 精确命中，且 aid 正确
 *   3. 跨零点/手动导入的日期差 → 退一步只比「主播名+直播标题」，并要求 ctime 在容差内
 *   4. 少了日期这道闸时，ctime 缺失 / 超出容差 / 命中多于 1 个 → **拒绝**（宁可新建稿件）
 *   5. 分P 数（编号基准）能从稿件详情的 `View.pages` / `View.videos` 读出来
 *   6. 命中但不带 aid → 拒绝并给出原因
 *
 * 运行：node test/resume-target.ts
 */
import { archivePartCount, resolveResumeTarget, stripDateDigits } from '../src/publish.ts';
import type { ArchiveItem } from '../src/types.ts';

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
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/* ---- 真实数据（取自账号稿件列表的实测值） ---- */
const LIVE_TITLE = '来两下闪身步就好了';
const DATE = '2026-09-22';
const TPL = '{anchor}{liveTitle}{date}';

/** 实测稿件：`甲主播来两下闪身步就好了2026.09.22`，14 个分P，ctime 2026-09-22 21:08 */
const FULL: ArchiveItem = {
  bvid: 'BV13hhE6XEQM',
  aid: 117314833877723,
  title: '甲主播来两下闪身步就好了2026.09.22',
  ctime: Math.floor(Date.parse('2026-09-22T21:08:43+08:00') / 1000),
};
/** 实测稿件：跨零点那场，标题日期是 2026.09.17 而导入文件是 2026-09-18 00:09 */
const CROSS_MIDNIGHT: ArchiveItem = {
  bvid: 'BV1aRe664Ei9',
  aid: 117287252134949,
  title: '甲主播电台汤圆人，太劲爆了2026.09.17',
  ctime: Math.floor(Date.parse('2026-09-18T00:11:17+08:00') / 1000),
};
/** 我们自己的切片稿件（标题是 LLM 生成的，不该被认成完整版） */
const CLIP: ArchiveItem = {
  bvid: 'BV1Xsht6mERD',
  aid: 117319464388916,
  title: '弹幕说鬼武者比黑神话简单，甲主播反问：黑神话很简单吗？',
  ctime: Math.floor(Date.parse('2026-09-23T16:43:32+08:00') / 1000),
};

const ANCHOR = '甲主播';

/* ========================================================================== */
section('① 回归：没有主播名就匹配不上（旧实现的真实缺陷）');
{
  const r = resolveResumeTarget({
    template: TPL,
    liveTitle: LIVE_TITLE,
    dateText: DATE,
    anchors: [''], // 旧实现：guessAnchorName([], …) 永远是空串
    archives: [FULL, CLIP],
  });
  ok('空主播名 → 不命中', r.target === undefined);
  eq('试过的标题就是缺主播名的那个', r.tried[0], '来两下闪身步就好了2026.09.22');
  ok('给出未命中原因', Boolean(r.reason), r.reason);
}

section('② 用稿件列表反推的主播名 → 精确命中');
{
  const r = resolveResumeTarget({
    template: TPL,
    liveTitle: LIVE_TITLE,
    dateText: DATE,
    anchors: [ANCHOR, '甲主播'],
    archives: [CLIP, FULL],
  });
  ok('命中', Boolean(r.target), r.reason);
  eq('aid 正确（就是这个稿件的 aid）', r.target?.aid, String(FULL.aid));
  eq('bvid 正确', r.target?.bvid, 'BV13hhE6XEQM');
  eq('匹配方式是 exact', r.target?.how, 'exact');
  eq('带上了命中的主播名', r.target?.anchor, ANCHOR);
  eq('候选唯一（不是有歧义）', r.candidates, 1);
  eq('切片稿件不会被误判', r.target?.bvid === CLIP.bvid, false);
}

section('③ 标题规范化：全角/空格/标点差异仍算精确命中');
{
  // 实测稿件标题里同时出现过全角**数字/标点**（`２０２６．０９．２２`）和多余空格
  const messy: ArchiveItem = { ...FULL, title: '甲主播 来两下闪身步就好了 ２０２６．０９．２２' };
  const r = resolveResumeTarget({
    template: TPL,
    liveTitle: LIVE_TITLE,
    dateText: DATE,
    anchors: [ANCHOR],
    archives: [messy],
  });
  eq('全角+空格变体命中同一个稿件', r.target?.bvid, 'BV13hhE6XEQM');

  // 全角**字母**也要能命中（主播名里带 ASCII 时才会走到这条路径；真实稿件标题里
  // 确实出现过「全角字母 + 全角下划线」的写法，`normalizeTitleForMatch` 必须吃得下）
  const messyLetters: ArchiveItem = { ...FULL, title: 'Ｄｅｍｏ主播 来两下闪身步就好了 ２０２６．０９．２２' };
  const rLetter = resolveResumeTarget({
    template: TPL,
    liveTitle: LIVE_TITLE,
    dateText: DATE,
    anchors: ['demo主播'],
    archives: [messyLetters],
  });
  eq('全角字母（含大小写）也命中', rLetter.target?.bvid, 'BV13hhE6XEQM');
}

section('④ 跨零点/手动导入：日期差一天 → 只比「主播名+直播标题」');
{
  const r = resolveResumeTarget({
    template: TPL,
    liveTitle: '电台汤圆人，太劲爆了',
    dateText: '2026-09-18', // 导入文件是 2026-09-18 00-09-09
    anchors: [ANCHOR],
    archives: [CROSS_MIDNIGHT, CLIP],
  });
  ok('命中', Boolean(r.target), r.reason);
  eq('匹配方式退化为 exact-ignore-date', r.target?.how, 'exact-ignore-date');
  eq('aid 正确', r.target?.aid, String(CROSS_MIDNIGHT.aid));
}

section('⑤ 少了日期这道闸，就必须更严：ctime 缺失 / 超容差 / 多个候选一律拒绝');
{
  const noCtime: ArchiveItem = { bvid: 'BV1noCtime000', aid: 1, title: CROSS_MIDNIGHT.title };
  const r1 = resolveResumeTarget({
    template: TPL,
    liveTitle: '电台汤圆人，太劲爆了',
    dateText: '2026-09-18',
    anchors: [ANCHOR],
    archives: [noCtime],
  });
  ok('没有 ctime → 拒绝（不猜）', r1.target === undefined, r1.reason);

  const farCtime: ArchiveItem = {
    ...CROSS_MIDNIGHT,
    bvid: 'BV1far000000',
    aid: 2,
    ctime: Math.floor(Date.parse('2026-08-01T00:00:00+08:00') / 1000),
  };
  const r2 = resolveResumeTarget({
    template: TPL,
    liveTitle: '电台汤圆人，太劲爆了',
    dateText: '2026-09-18',
    anchors: [ANCHOR],
    archives: [farCtime],
  });
  ok('创建时间超出 ±7 天 → 拒绝', r2.target === undefined, r2.reason);

  /* 两个候选都要**避开第一轮的日期精确命中**，才能验到第二轮的歧义拒绝：
     本场 dateText 是 2026-09-18，所以两个候选的标题日期取 09.17 / 09.16 */
  const twinA: ArchiveItem = { ...CROSS_MIDNIGHT, bvid: 'BV1twinA0000', aid: 3, title: '甲主播电台汤圆人，太劲爆了2026.09.17' };
  const twinB: ArchiveItem = { ...CROSS_MIDNIGHT, bvid: 'BV1twinB0000', aid: 4, title: '甲主播电台汤圆人，太劲爆了2026.09.16' };
  const r3 = resolveResumeTarget({
    template: TPL,
    liveTitle: '电台汤圆人，太劲爆了',
    dateText: '2026-09-18',
    anchors: [ANCHOR],
    archives: [twinA, twinB], // 日期不同 → 第一轮 0 个，第二轮 2 个
  });
  ok('两个候选 → 拒绝自动选择', r3.target === undefined, r3.reason);
  eq('把候选个数报出来', r3.candidates, 2);

  const sameTwice: ArchiveItem[] = [FULL, { ...FULL }];
  const r4 = resolveResumeTarget({ template: TPL, liveTitle: LIVE_TITLE, dateText: DATE, anchors: [ANCHOR], archives: sameTwice });
  eq('同一 bvid 重复出现不算歧义（按 bvid 去重）', r4.target?.bvid, 'BV13hhE6XEQM');
}

section('⑥ 包含关系不算命中（防「把别的稿件认成本场的」）');
{
  const partial: ArchiveItem = { bvid: 'BV1partial00', aid: 9, title: `甲主播${LIVE_TITLE}2026.09.22 加长版`, ctime: FULL.ctime };
  const r = resolveResumeTarget({ template: TPL, liveTitle: LIVE_TITLE, dateText: DATE, anchors: [ANCHOR], archives: [partial] });
  ok('只包含不算命中', r.target === undefined, r.reason);
}

section('⑦ 命中但没有 aid → 拒绝并说明原因');
{
  const noAid: ArchiveItem = { bvid: 'BV1noAid0000', title: FULL.title, ctime: FULL.ctime };
  const r = resolveResumeTarget({ template: TPL, liveTitle: LIVE_TITLE, dateText: DATE, anchors: [ANCHOR], archives: [noAid] });
  ok('没有 aid 不续传', r.target === undefined);
  ok('原因里点出「没有 aid 字段」', Boolean(r.reason?.includes('aid')), r.reason);
}

section('⑧ 模板里没有 {anchor} / 模板为空');
{
  const r1 = resolveResumeTarget({
    template: '{liveTitle}{date}',
    liveTitle: LIVE_TITLE,
    dateText: DATE,
    anchors: [ANCHOR],
    archives: [FULL],
  });
  ok('不带主播名的模板照旧不命中（模板由用户负责）', r1.target === undefined, r1.reason);
  eq('变体只有一条', r1.tried.length, 1);

  const r2 = resolveResumeTarget({ template: '   ', liveTitle: LIVE_TITLE, dateText: DATE, anchors: [ANCHOR], archives: [FULL] });
  ok('空模板 → 明确关闭自动查找', r2.target === undefined && Boolean(r2.reason?.includes('resumeTitleTemplate')), r2.reason);

  const r3 = resolveResumeTarget({
    template: '{anchor}{liveTitle}',
    liveTitle: LIVE_TITLE,
    dateText: DATE,
    anchors: [ANCHOR],
    archives: [FULL],
  });
  ok('模板少日期时也算精确命中', r3.target?.how === 'exact', r3.reason);
}

section('⑨ 分P 数（切片编号基准）读取');
{
  eq('View.pages 数组长度', archivePartCount({ View: { pages: new Array(14).fill({}) } }), 14);
  eq('View.videos 数字', archivePartCount({ View: { videos: 4 } }), 4);
  eq('View.videos 字符串', archivePartCount({ View: { videos: '10' } }), 10);
  eq('没有外层 View 也能读', archivePartCount({ pages: new Array(2).fill({}) }), 2);
  eq('读不到 → undefined（调用方回落配置）', archivePartCount({ View: { title: 'x' } }), undefined);
  eq('非对象 → undefined', archivePartCount(null), undefined);
  eq('真实响应形状（BV13hhE6XEQM 实测 14 个分P）', archivePartCount({ View: { videos: 14, pages: new Array(14).fill({}) }, Card: {} }), 14);
}

section('⑩ stripDateDigits');
{
  eq('去掉归一化后的尾日期', stripDateDigits('甲主播来两下闪身步就好了20260922'), '甲主播来两下闪身步就好了');
  eq('日期不在结尾时不动', stripDateDigits('20260922甲主播'), '20260922甲主播');
  eq('没有日期时原样返回', stripDateDigits('甲主播'), '甲主播');
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
if (fail > 0) process.exitCode = 1;
