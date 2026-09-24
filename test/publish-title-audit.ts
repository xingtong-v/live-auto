/**
 * 「投稿标题体检 + bvid 可信度校验 + 投稿批次分析」单元验证。
 *
 * 这三块都是**事后很难发现**的类型：
 *  - 标题体检漏判 → 一条占位/错词标题就这么发出去了，观众先看到；
 *  - bvid 校验漏判 → 完整版录播的 bvid 被写到切片上，台账看起来"已确认"其实完全错；
 *  - 批次分析算错 → 「本场投了几次」这个数字直接决定用户去不去创作中心清理。
 *
 * 全部用**真实日志形态**做输入（含实测踩到的那些畸形组合），不联网。
 *
 * 用法：node test/publish-title-audit.ts
 */
import type { Glossary } from '../src/glossary.ts';
import { checkClipTitles, checkTitle, normalizeForCompare } from '../src/title-check.ts';
import { buildBatches } from '../src/publish-audit.ts';
import { renderPartTitle } from '../src/publish.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('─'.repeat(Math.max(20, Math.min(74, t.length * 2 + 8))));
}

const glossary: Glossary = {
  version: 1,
  anchors: ['甲主播'],
  terms: ['后半夜后悔时代', '闪身步'],
  replacements: [{ from: '闪身部', to: '闪身步' }],
};

console.log('\x1b[1m投稿标题体检 + bvid 校验 + 批次分析\x1b[0m（无网络）');
console.log('─'.repeat(74));

/* ================= 1. 标题体检 ================= */
section('1. 标题体检');
{
  const good = checkTitle('有人中了20次红包？主播直呼搞不懂', { glossary });
  ok('正常标题通过', good.ok && good.problems.length === 0, JSON.stringify(good.problems));
  eq('最终标题与原文一致', good.finalTitle, '有人中了20次红包？主播直呼搞不懂');

  const empty = checkTitle('   ', {});
  ok('空标题是 error', !empty.ok && empty.problems.some((p) => p.code === 'empty'));

  const placeholder = checkTitle('（待填写）主播说了什么', {});
  ok('占位标题是 error', !placeholder.ok && placeholder.problems.some((p) => p.code === 'placeholder'));

  const wrongWord = checkTitle('他今天闪身部用得不错', { glossary });
  ok('术语表错词残留是 error', !wrongWord.ok && wrongWord.problems.some((p) => p.code === 'glossary-wrong-word'), JSON.stringify(wrongWord.problems));
  ok('错词提示里给出了正确写法', wrongWord.problems.some((p) => p.message.includes('闪身步')));

  const regexGlossary: Glossary = { version: 1, anchors: [], terms: [], replacements: [{ from: '\\d+次红包', to: '很多次红包', regex: true }] };
  ok('正则规则同样能查出错词', !checkTitle('中了20次红包', { glossary: regexGlossary }).ok);

  const long = checkTitle('标'.repeat(95), {});
  ok('超长标题给出 warn 且报告截断后长度', long.problems.some((p) => p.code === 'truncated'));
  eq('截断后正好 80 字符', [...long.finalTitle].length, 80);
  ok('截断不算 error（平台会截，不是拒）', long.ok);

  const withSuffix = checkTitle('标'.repeat(78), { suffix: '【切片】' });
  ok('「加后缀之后才超长」也能查出来', withSuffix.problems.some((p) => p.code === 'truncated'), withSuffix.finalTitle);
  ok('76 字 + 4 字后缀 = 正好 80，不算截断（边界值）', !checkTitle('标'.repeat(76), { suffix: '【切片】' }).problems.some((p) => p.code === 'truncated'));

  // 短标题分档：2 字以内是硬伤，6 字以内只是提醒 —— 5 个字的标题是成立的
  ok('2 个字的标题是 error', !checkTitle('哈哈', {}).ok);
  ok('5 个字的标题不算硬伤（只提醒）', checkTitle('正常标题一', {}).ok);
  ok('5 个字的标题会给出 very-short 提醒', checkTitle('正常标题一', {}).problems.some((p) => p.code === 'very-short'));

  const hashTitle = checkTitle('主播收到礼物 a3f9c2d81b4e6f0a 当场破防', {});
  ok('疑似哈希给出 warn', hashTitle.problems.some((p) => p.code === 'hash-like'));

  const indexed = checkTitle('片段3 主播笑到打鸣', {});
  ok('内部编号给出 warn', indexed.problems.some((p) => p.code === 'internal-index'));

  const partPrefix = checkTitle('P3 主播收到飞机礼物', {});
  ok('分P 前缀给出 warn（单片不该带）', partPrefix.problems.some((p) => p.code === 'part-prefix'));

  const symbolic = checkTitle('！！！？？？', {});
  ok('纯符号是 error', !symbolic.ok && symbolic.problems.some((p) => p.code === 'no-word'));

  const newline = checkTitle('第一行\n第二行', {});
  ok('含换行是 error', !newline.ok && newline.problems.some((p) => p.code === 'newline'));

  const dupSibling = checkTitle('有人中了20次红包？主播直呼搞不懂', { siblings: ['有人中了 20 次红包？主播直呼搞不懂'] });
  ok('与同场标题重复（忽略空格/标点差异）给出 warn', dupSibling.problems.some((p) => p.code === 'duplicate-sibling'));

  const report = checkClipTitles(
    [
      { index: 0, title: '正常标题一' },
      { index: 1, title: '（待填写）' },
      { index: 2, title: '含错词闪身部' },
    ],
    { glossary },
  );
  eq('整场统计到 2 处 error', report.errors.length, 2);
  ok('整场 ok=false', !report.ok);
  eq('归一化会忽略全角/半角差异', normalizeForCompare('ＡＢＣ １２３'), normalizeForCompare('abc123'));
}

/* ================= 2. bvid 可信度校验 ================= */
section('2. bvid 可信度校验（实测错配的复现）');
{
  const { verifyArchiveMatch, fullVideoTitleCandidates } = await import('../src/publish.ts');
  const task = {
    id: 't1',
    roomId: '1',
    platform: 'Bilibili',
    title: '2026-09-20 00-36-21-040 已进入后半夜后悔时代（手动导入）',
    status: 'CLIPPED',
    stage: 'CLIPPED',
    source: { segments: [], totalDuration: 1400, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: '' },
    createdAt: '',
    updatedAt: '',
  } as never;

  const fullTitles = fullVideoTitleCandidates(task);
  ok('能推出完整版录播的候选标题', fullTitles.some((t) => t.includes('已进入后半夜后悔时代')), fullTitles.join(' | '));

  const submitMs = Date.parse('2026-09-22T14:11:54.000Z');
  // 实测：命中完整版录播（标题逐字相同）
  const hitFull = verifyArchiveMatch(
    { bvid: 'BV11thH6HERA', title: '已进入后半夜后悔时代 2026-09-20', ctime: Math.floor(submitMs / 1000) + 60, exact: true },
    '已进入后半夜后悔时代 2026-09-20',
    { submitTimeMs: submitMs, fullVideoTitles: fullTitles },
  );
  ok('命中完整版录播时拒绝写入', !hitFull.ok, JSON.stringify(hitFull));
  eq('拒绝原因是 is-full-video', hitFull.code, 'is-full-video');

  ok(
    '包含匹配一律拒绝',
    !verifyArchiveMatch({ bvid: 'BVx', title: '已进入后半夜后悔时代 2026-09-20 加长版', exact: false }, 'x').ok,
  );
  ok(
    '缺 ctime 时拒绝（不能只凭标题写 bvid）',
    verifyArchiveMatch({ bvid: 'BVx', title: '某切片标题', exact: true }, '某切片标题', { submitTimeMs: submitMs }).code === 'no-ctime',
  );
  ok(
    '创建时间早于本次提交时拒绝',
    verifyArchiveMatch({ bvid: 'BVx', title: '某切片标题', ctime: Math.floor(submitMs / 1000) - 86400, exact: true }, '某切片标题', { submitTimeMs: submitMs }).code === 'too-old',
  );
  ok(
    '精确匹配 + 新 ctime + 非完整版 → 通过',
    verifyArchiveMatch(
      { bvid: 'BVgood', title: '有人中了20次红包？主播直呼搞不懂', ctime: Math.floor(submitMs / 1000) + 30, exact: true },
      '有人中了20次红包？主播直呼搞不懂',
      { submitTimeMs: submitMs, fullVideoTitles: fullTitles },
    ).ok,
  );
  ok(
    '时钟偏差 4 分钟内仍认可（本地与服务器时间不可能完全一致）',
    verifyArchiveMatch({ bvid: 'BVx', title: '切片标题', ctime: Math.floor((submitMs - 4 * 60_000) / 1000), exact: true }, '切片标题', { submitTimeMs: submitMs }).ok,
  );
}

/* ================= 3. 投稿批次分析 ================= */
section('3. 投稿批次分析（按真实现场日志形态）');
{
  const rows = [
    // 20:47 单片投稿 + 20:48 confirm（老日志没有 uploadTaskId）
    { taskId: 'T', clipIndex: 0, action: 'submit', at: '2026-09-22T12:47:24.000Z', uploadTaskId: 'u1', title: '切片一' },
    { taskId: 'T', clipIndex: 0, action: 'confirm', at: '2026-09-22T12:48:20.000Z', bvid: 'BV1', title: '切片一' },
    { taskId: 'T', clipIndex: 1, action: 'submit', at: '2026-09-22T12:48:36.000Z', uploadTaskId: 'u2', title: '切片二' },
    { taskId: 'T', clipIndex: 1, action: 'confirm', at: '2026-09-22T12:53:01.000Z', bvid: 'BV2', title: '切片二' },
    // 21:17 六个分P 一次投稿（无 confirm）
    ...Array.from({ length: 6 }, (_, i) => ({
      taskId: 'T',
      clipIndex: i,
      action: 'submit',
      at: '2026-09-22T13:17:32.000Z',
      uploadTaskId: 'multi1',
      title: `P${i + 3} 切片${i + 1}`,
    })),
    // 22:11 又一次多分P，且 confirm 反查到了完整版录播
    ...Array.from({ length: 6 }, (_, i) => ({
      taskId: 'T',
      clipIndex: i,
      action: 'submit',
      at: '2026-09-22T14:11:54.000Z',
      uploadTaskId: 'multi2',
      title: `P${i + 3} 切片${i + 1}`,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      taskId: 'T',
      clipIndex: i,
      action: 'confirm',
      at: '2026-09-22T14:21:21.000Z',
      bvid: 'BVFULL',
      title: '已进入后半夜后悔时代 2026-09-20',
      uploadTaskId: 'multi2',
    })),
    // 别的任务的日志不能混进来
    { taskId: 'OTHER', clipIndex: 0, action: 'submit', at: '2026-09-22T14:00:00.000Z', uploadTaskId: 'x', title: '别的场' },
  ];

  const batches = buildBatches(rows, 'T', ['已进入后半夜后悔时代 2026-09-20']);
  eq('只统计本任务；confirm 并回对应批次 → 4 个批次', batches.length, 4);
  eq('不是 12 个碎片批次', batches.filter((b) => b.kind === 'unknown').length, 0);
  eq('两次多分P 被识别出来', batches.filter((b) => b.kind === 'multipart').length, 2);
  ok('单片批次带上了各自的 bvid', batches[0]?.confirmedBvids.includes('BV1') === true, JSON.stringify(batches[0]));
  const multi2 = batches.find((b) => b.key === 'multi2');
  ok('22:11 那批的 bvid 被标为「其实是完整版录播」', multi2?.bvidLooksFullVideo === true);
  ok('21:17 那批没有被误标', batches.find((b) => b.key === 'multi1')?.bvidLooksFullVideo === false);
  eq('该批次 6 个分P 都在', multi2?.parts.length, 6);
}

/* ================= 4. 分P 标题模板 ================= */
section('4. 分P 标题模板');
{
  eq('默认形态（与历史行为一致）', renderPartTitle('P{n} {title}', { n: 3, title: '有人中了20次红包' }), 'P3 有人中了20次红包');
  eq(
    '带主播名与类型',
    renderPartTitle('{anchor}切片{n} {title}', { n: 3, title: '有人中了20次红包', anchor: '甲主播' }),
    '甲主播切片3 有人中了20次红包',
  );
  eq('变量为空时不留下多余空格', renderPartTitle('{anchor} {title}', { n: 1, title: '标题', anchor: '' }), '标题');
  eq('未知变量原样保留（便于用户自己发现拼错）', renderPartTitle('{n} {unknown} {title}', { n: 1, title: 'T' }), '1 {unknown} T');
  eq('空模板回退默认', renderPartTitle('', { n: 2, title: 'T' }), 'P2 T');
  eq('日期与主标题变量可用', renderPartTitle('{date} {mainTitle}', { n: 1, title: 'T', date: '2026-09-20', mainTitle: '本场主标题' }), '2026-09-20 本场主标题');
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log('\x1b[32m标题体检、bvid 校验与批次分析行为符合预期。\x1b[0m');
}
