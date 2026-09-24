/**
 * 本场主播识别的单元验证。
 *
 * 事故背景：术语表是**跨主播**的全局词表（用户既看乙主播也看甲主播），
 * 提示词却写成「本场专有名词 / 主播：乙主播、甲主播」，
 * 于是甲主播的直播被总结成了乙主播的 —— 素材没错、转写没错，错在把全局词表当成了本场信息。
 *
 * 这里钉住四件事：
 *  1. 目录名命中就认目录名（最硬，用户自己起的名字）；
 *  2. 没有目录证据时用弹幕热词 + 转写正文投票，且**弹幕权重更高**（转写里提到别的主播往往是"在聊别人"）；
 *  3. 票数接近时**不猜**（宁可空着让模型只依据转写，也不要写错主播）；
 *  4. 渲染出来的提示词里，其他主播必须被显式标注"不是本场主播"。
 *
 * 用法：node test/streamer.ts
 */
import { detectStreamer, folderNameOf, streamerPromptLine } from '../src/streamer.ts';
import { renderGlossaryForPrompt } from '../src/glossary.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string, extra?: string): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
  }
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}
function eq<T>(msg: string, actual: T, expected: T): void {
  ok(actual === expected, msg, actual === expected ? undefined : `期望 ${String(expected)}，实际 ${String(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const ANCHORS = ['乙主播', '甲主播'];
const TU_TUI = 'C:\\Users\\demo\\Downloads\\Bilibili\\甲主播\\2026-09-22 22-49-42-277 来两下闪身步就好了.flv';
const XING_TONG = 'C:\\Users\\demo\\Downloads\\Bilibili\\乙主播\\2026-09-21 20-50-02 场直播.ts';

console.log('\x1b[1m本场主播识别验证\x1b[0m（零网络、零费用）');
console.log('─'.repeat(74));

/* ================= 1. 目录名 ================= */
section('1. 录制目录名（最硬的证据）');
{
  eq('从路径取出上层目录名', folderNameOf(TU_TUI), '甲主播');
  const g = detectStreamer({ sourcePaths: [TU_TUI], anchors: ANCHORS });
  eq('目录名命中词表主播 → 用词表规范写法', g.name, '甲主播');
  eq('置信度 high', g.confidence, 'high');
  ok(g.evidence.some((e) => e.includes('甲主播')), '证据里写清了是哪个目录', g.evidence[0]);

  const g2 = detectStreamer({ sourcePaths: [XING_TONG], anchors: ANCHORS });
  eq('另一个主播的目录同样识别正确', g2.name, '乙主播');

  // 目录名不在词表里（用户自己命名的目录）→ 按目录名用，而不是猜词表里的主播
  const g3 = detectStreamer({ sourcePaths: ['D:\\录播\\某新人主播\\xxx.flv'], anchors: ANCHORS });
  eq('目录名不在词表 → 用目录名', g3.name, '某新人主播');
  eq('仍然是 high（目录名是用户自己写的）', g3.confidence, 'high');

  // 通用目录名不能当主播名
  eq('通用目录名不算主播名', folderNameOf('C:\\Users\\demo\\Downloads\\Bilibili\\x.flv'), undefined);
  eq('Downloads 也不算', folderNameOf('C:\\Users\\demo\\Downloads\\x.flv'), undefined);

  // 目录名优先于弹幕/转写（弹幕里全是别的主播名也不能翻盘）
  const g4 = detectStreamer({
    sourcePaths: [TU_TUI],
    anchors: ANCHORS,
    danmakuKeywords: [
      { word: '乙主播', count: 500 },
      { word: '甲主播', count: 1 },
    ],
    transcriptText: '乙主播乙主播乙主播乙主播',
  });
  eq('目录名命中时不受弹幕影响（目录名最硬）', g4.name, '甲主播');
}

/* ================= 2. 弹幕 / 转写投票 ================= */
section('2. 没有目录证据时：弹幕热词 + 转写投票');
{
  const g = detectStreamer({
    sourcePaths: ['C:\\Users\\demo\\Downloads\\x.flv'], // 通用目录，给不出证据
    anchors: ANCHORS,
    danmakuKeywords: [
      { word: '腿宝', count: 40 },
      { word: '甲主播', count: 60 },
      { word: '乙主播', count: 2 },
    ],
    transcriptText: '今天给大家唱首歌',
    title: '来两下闪身步就好了',
  });
  eq('弹幕多数指向甲主播', g.name, '甲主播');
  eq('置信度 medium（不是目录名那种硬证据）', g.confidence, 'medium');
  ok(g.evidence.some((e) => e.includes('弹幕提及')), '证据里给出了票数', g.evidence[0]);

  /* 弹幕权重高于转写：主播在直播里聊别的主播是常态 */
  const g2 = detectStreamer({
    sourcePaths: ['C:\\Users\\demo\\Downloads\\x.flv'],
    anchors: ANCHORS,
    danmakuKeywords: [
      { word: '甲主播', count: 30 },
      { word: '乙主播', count: 1 },
    ],
    // 转写里主播反复提到乙主播（在聊别人），但本场是甲主播
    transcriptText: '乙主播'.repeat(20),
  });
  eq('转写里狂提别的主播也不翻盘（弹幕权重更高）', g2.name, '甲主播');
}

/* ================= 3. 判不出来就不猜 ================= */
section('3. 证据不足 → 不猜（宁可空着）');
{
  const g = detectStreamer({
    sourcePaths: ['C:\\Users\\demo\\Downloads\\x.flv'],
    anchors: ANCHORS,
    danmakuKeywords: [
      { word: '乙主播', count: 10 },
      { word: '甲主播', count: 10 },
    ],
  });
  eq('两个主播票数接近 → 不识别', g.name, undefined);
  eq('置信度 none', g.confidence, 'none');
  ok(g.evidence.some((e) => e.includes('接近')), '说明了为什么不猜', g.evidence.at(-1));

  const g2 = detectStreamer({ sourcePaths: ['C:\\Users\\demo\\Downloads\\x.flv'], anchors: ANCHORS });
  eq('完全没有证据 → 不识别', g2.name, undefined);
  ok(streamerPromptLine(g2) === '', '不注入空的主播行（不占 token、不给模型错觉）');

  const g3 = detectStreamer({ sourcePaths: [], anchors: [] });
  eq('词表为空也不崩', g3.name, undefined);
}

/* ================= 4. 提示词注入 ================= */
section('4. 提示词里怎么说（这是事故的直接原因）');
{
  const g = detectStreamer({ sourcePaths: [TU_TUI], anchors: ANCHORS });
  const line = streamerPromptLine(g);
  ok(line.includes('甲主播'), '写明了本场主播是甲主播', line.slice(0, 40));
  ok(/只能用这个名字/.test(line), '明确要求"提到主播只能用这个名字"');
  ok(!line.includes('乙主播'), '不会把其他主播写进"本场主播"那句');

  const glossary = {
    version: 1 as const,
    anchors: ANCHORS,
    terms: ['后半夜后悔时代', '闪身步'],
    replacements: [],
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
  const rendered = renderGlossaryForPrompt(glossary, { streamer: '甲主播' });
  ok(/本场主播：甲主播/.test(rendered), '术语表里本场主播单独一行', rendered.split('\n')[1]);
  ok(
    /其他主播.*不是本场主播.*乙主播/.test(rendered.replace(/\n/g, ' ')),
    '其他主播被显式标注"不是本场主播"',
    rendered.split('\n')[2],
  );
  /* 旧写法是「主播 / 常驻嘉宾：乙主播、甲主播」—— 正是它让模型以为乙主播是本场主播 */
  ok(!/主播 \/ 常驻嘉宾：乙主播、甲主播/.test(rendered), '不再出现「主播 / 常驻嘉宾：乙主播、甲主播」这种把全局词表当本场的写法');

  const unknown = renderGlossaryForPrompt(glossary);
  ok(/未确认/.test(unknown), '识别不出主播时，词表里也标明"本场具体是谁未确认"', unknown.split('\n')[1]);
  ok(!/本场主播：/.test(unknown), '识别不出时不会硬指定一个本场主播');
}

/* ================= 5. 真实场景回归 ================= */
section('5. 真实场景：用户同时看乙主播和甲主播');
{
  // 甲主播那场的真实素材
  const tu = detectStreamer({
    sourcePaths: ['C:\\Users\\demo\\Downloads\\Bilibili\\甲主播\\2026-09-22 22-49-42-277 来两下闪身步就好了.flv'],
    anchors: ANCHORS,
    transcriptText: '我开了一下小风扇感谢改名不知道取什么的钢蹦啊腿宝晚安啦',
    danmakuKeywords: [{ word: '腿宝', count: 12 }, { word: '乙主播', count: 1 }],
    title: '来两下闪身步就好了',
  });
  eq('甲主播的素材 → 甲主播（不会再写成乙主播）', tu.name, '甲主播');

  // 乙主播那场（同目录下的另一场）
  const xt = detectStreamer({
    sourcePaths: ['C:\\Users\\demo\\Downloads\\2026_9_21 20_50_02 场直播.ts'],
    anchors: ANCHORS,
    transcriptText: '乙主播乙主播这个盲文是几',
    danmakuKeywords: [{ word: '乙主播', count: 88 }],
    title: '场直播',
  });
  eq('乙主播的素材 → 乙主播', xt.name, '乙主播');
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
if (fail > 0) process.exitCode = 1;
