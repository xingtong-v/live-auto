/**
 * 切片标签口径自测。
 *
 * 用户报过两次（都是真实反馈，别再来回改口径）：
 *   1. 「投稿的切片 标签没有带上」—— 当时 `defaultTags` 只做「一个可用标签都没有时」的兜底，
 *      而设置面板的提示写的是「与 LLM 生成的标签合并」，代码与文案对不上。
 *   2. 「必有的标签 虚拟主播、2D、3D、VTuber、vup，还有一个占位符根据主播不同、标签为主播的 ID
 *      （例如 乙主播），其他的为 LLM 生成的，还要有去重」—— 于是有了 `identityTags`（必带标签）。
 *
 * 现在的**四层**口径（`analyze.ts` 的 `resolveIdentityTags` / `mergeIdentityTags` / `fillDefaultTags`，
 * 投稿侧 `publish.ts` 的 `buildBiliupConfig` 再套一次同样的规则，覆盖存量 clips.json）：
 *   ① 必带标签（`publish.identityTags`，`{主播}` → 本场主播名）：永远在最前，占位优先；
 *   ② 内容词（LLM 按内容生成 + 界面手改的 extraTags）：补满剩余名额，与①去重（大小写不敏感）；
 *   ③ 默认标签（`defaultTags`）：①② 都空时兜底，否则只补它们用不完的空位；
 *   ④ 上限 10 个：①优先，被挤掉的是②，且**每个任务只汇总一条**警告（逐片刷屏是当初回退的原因之一）。
 *
 * 纯本地：不联网、不投稿。
 * 运行：node test/clip-tags.ts
 */
import { fillDefaultTags, mapCategoryToTid, mergeIdentityTags, resolveIdentityTags, sanitizeClips, TAG_LIMIT } from '../src/analyze.ts';
import { buildBiliupConfig } from '../src/publish.ts';
import { loadConfig } from '../src/config.ts';
import type { ClipRecord, TaskRecord } from '../src/types.ts';

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
function eqArr(name: string, got: string[], want: string[]): void {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/** 用户真实配的那 7 个（`2D`/`2d` 是刻意的：验证大小写去重） */
const USER_TAGS = ['直播切片', '名场面', '虚拟主播', '2D', '2d', 'vup', 'VTube'];
/** 用户 2026-10-17 要求的必带标签（含主播名占位符） */
const IDENTITY = ['虚拟主播', '2D', '3D', 'VTuber', 'vup', '{主播}'];
const STREAMER = '乙主播';

const cfg = loadConfig().config;
const now = new Date().toISOString();
const task = {
  id: 'clip-tags-test',
  roomId: '12345678',
  platform: 'Bilibili',
  title: '【测试】切片标签口径',
  status: 'CLIPPED',
  stage: 'CLIPPED',
  streamer: STREAMER,
  source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
  fullUpload: 'NOT_APPLICABLE',
  cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
  createdAt: now,
  updatedAt: now,
} as unknown as TaskRecord;

function clip(over: Partial<ClipRecord> = {}): ClipRecord {
  return {
    index: 0,
    start: 100,
    end: 220,
    title: '测试切片标题',
    desc: '这段是 LLM 写的简介正文。',
    tags: ['甲主播', '国安约谈'],
    category: '生活/日常',
    score: 8,
    reason: '测试',
    selected: true,
    status: 'CANDIDATE',
    degraded: false,
    ...over,
  } as ClipRecord;
}

function payloadTags(
  clipOver: Partial<ClipRecord> = {},
  opt: { defaults?: string[]; identity?: string[]; sensitive?: string[]; streamer?: string | undefined } = {},
): string[] {
  const r = buildBiliupConfig({
    clip: clip(clipOver),
    task: { ...task, streamer: opt.streamer === undefined ? STREAMER : opt.streamer } as TaskRecord,
    cfg: {
      ...cfg,
      publish: {
        ...cfg.publish,
        defaultTags: opt.defaults ?? USER_TAGS,
        identityTags: opt.identity ?? IDENTITY,
        tagSensitiveWords: opt.sensitive ?? [],
      },
    },
    uid: 12345,
    dtime: Math.floor(Date.now() / 1000) + 1200,
    uploadPresetId: 'default',
  });
  return (r.config['tag'] ?? []) as string[];
}

/* ============================ ① 必带标签：占位符与配置问题 ============================ */
section('① 必带标签：`{主播}` 换成主播名，配置问题必须报出来');
{
  {
    const r = resolveIdentityTags(IDENTITY, STREAMER);
    eqArr(
      '★ 六个必带标签按配置顺序返回，`{主播}` 换成主播名',
      r.tags,
      ['虚拟主播', '2D', '3D', 'VTuber', 'vup', STREAMER],
    );
    eq('配置没问题时不产 skipped', r.skipped.length, 0);
  }
  eqArr(
    '等价写法 `{主播名}` / `{昵称}` 一样能换（拼接后超 12 字按既有口径截断）',
    resolveIdentityTags(['{主播名}', '{昵称}的猫'], STREAMER).tags,
    [STREAMER, `${STREAMER}的`],
  );
  eq(
    '三个等价写法换成同一个名字时只留一个（去重）',
    resolveIdentityTags(['{主播}', '{主播名}', '{昵称}'], STREAMER).tags.length,
    1,
  );
  {
    const r = resolveIdentityTags(['虚拟主播', '{主播}'], undefined);
    eqArr('没识别出主播名时：带占位符的那条整条跳过', r.tags, ['虚拟主播']);
    ok('并给出可解释的 skipped', r.skipped.some((s) => s.includes('没识别出主播名')), r.skipped.join(' | ') || '（无）');
    ok('不会把 `{主播}` 原样投出去', !r.tags.some((t) => t.includes('{主播')), r.tags.join('/'));
  }
  eqArr('必带标签自身去重（大小写不敏感，`2D`/`2d` 只留先出现的）', resolveIdentityTags(['2D', '2d', 'vup'], STREAMER).tags, [
    '2D',
    'vup',
  ]);
  {
    const r = resolveIdentityTags(['外挂', '123'], STREAMER, ['外挂']);
    eq('命中敏感词的必带标签被丢弃', r.tags.length, 0);
    eq('纯数字必带标签被丢弃', r.skipped.length, 2);
  }
  {
    const many = Array.from({ length: 12 }, (_, i) => `身份${i}`);
    const r = resolveIdentityTags(many, STREAMER);
    eq(`必带标签超过 ${TAG_LIMIT} 个就截住`, r.tags.length, TAG_LIMIT);
    ok('超出部分写进 skipped（配置该瘦身了）', r.skipped.some((s) => s.includes('上限')), r.skipped.join(' | ') || '（无）');
  }
}

/* ============================ ② 合并：必带在前、内容补位、去重、超限丢内容词 ============================ */
section('② 合并必带标签与内容词：必带优先占位，内容词补满并去重');
{
  {
    const r = mergeIdentityTags(['虚拟主播', 'vup'], ['甲主播', '国安约谈'], TAG_LIMIT);
    eqArr('必带在前、内容词接在后面', r.tags, ['虚拟主播', 'vup', '甲主播', '国安约谈']);
    eq('没有丢失内容词', r.dropped.length, 0);
  }
  {
    const r = mergeIdentityTags(['虚拟主播'], ['虚拟主播', '甲主播'], TAG_LIMIT);
    eqArr('内容词与必带词重复时静默去重（LLM 很爱写「虚拟主播」）', r.tags, ['虚拟主播', '甲主播']);
    eq('重复不计入 dropped（那是预期内的）', r.dropped.length, 0);
  }
  {
    const nine = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9'];
    const r = mergeIdentityTags(nine, ['x', 'y', 'z'], TAG_LIMIT);
    eq(`满 ${TAG_LIMIT} 个就停`, r.tags.length, TAG_LIMIT);
    eqArr('被挤掉的是内容词（必带一个都不丢）', r.dropped, ['y', 'z']);
    ok('必带标签全在', nine.every((t) => r.tags.includes(t)), r.tags.join('/'));
  }
}

/* ============================ ③ 默认标签补位（③ 的角色没变，只是现在排在必带+内容之后） ============================ */
section('③ 默认标签只在必带+内容之后补位（不许回到「每片标签一模一样」）');
{
  eqArr(
    '内容词在前，默认词按配置顺序接在后面',
    fillDefaultTags(['甲主播', '国安约谈'], ['直播切片', '名场面', '2D']),
    ['甲主播', '国安约谈', '直播切片', '名场面', '2D'],
  );
  eqArr(
    '默认词与已有标签重复时不再追加',
    fillDefaultTags(['虚拟主播', '甲主播'], ['虚拟主播', '2D']),
    ['虚拟主播', '甲主播', '2D'],
  );
  eqArr(
    '★ 已经满 10 个时，默认词一个都不进（SEO 区分度优先）',
    fillDefaultTags(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'], USER_TAGS),
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'],
  );
  const src = ['甲主播'];
  fillDefaultTags(src, USER_TAGS);
  eqArr('不改动传入的数组（避免影响调用方的 clips.json 内存态）', src, ['甲主播']);
  eqArr('`2D` / `2d` 只留先出现的那个（去重大小写不敏感）', fillDefaultTags([], ['2D', '2d']), ['2D']);
  {
    const got = fillDefaultTags(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], ['d1', 'd2', 'd3']);
    eqArr('补到 10 个上限就停', got, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'd1', 'd2']);
  }
  eqArr('命中 tagSensitiveWords 的默认词静默丢弃（不产 warning）', fillDefaultTags(['甲主播'], ['外挂', 'vup'], ['外挂']), ['甲主播', 'vup']);
  eqArr('纯数字默认词丢弃（B站不接受）', fillDefaultTags(['甲主播'], ['123', 'vup']), ['甲主播', 'vup']);
  eq('超长默认词按 12 字截断', fillDefaultTags([], ['这是一个特别特别特别长的默认标签'])[0]!.length, 12);
}

/* ============================ ④ 选片落库（clips.json）就带必带标签 ============================ */
section('④ 选片落库：clips.json 的 tags 里，必带标签在最前');
{
  const base = {
    videoDuration: 3600,
    minDurationSec: 30,
    maxDurationSec: 90,
    bufferSec: 1.5,
    maxClips: 6,
    tidWhitelist: { 生活日常: 21 },
    defaultCategory: '生活日常',
    defaultTags: USER_TAGS,
    tagSensitiveWords: ['外挂'],
    identityTags: IDENTITY,
    streamerName: STREAMER,
    autoSelectScoreFloor: 7,
    autoSelectTopN: 6,
  };
  const mk = (tags: string[], score = 9) => ({
    start: 100,
    end: 200,
    title: '标题',
    desc: '简介',
    tags,
    category: '生活日常',
    score,
    reason: '理由',
    cover_ts: 150,
  });

  {
    const r = sanitizeClips([mk(['甲主播', '国安约谈'])], base);
    eqArr(
      '★ 顺序 = 必带标签（含主播名）→ 内容词 → 默认词补位',
      r.clips[0]!.tags,
      ['虚拟主播', '2D', '3D', 'VTuber', 'vup', STREAMER, '甲主播', '国安约谈', '直播切片', '名场面'],
    );
    eq(`个数正好是上限 ${TAG_LIMIT}`, r.clips[0]!.tags.length, TAG_LIMIT);
    ok(
      '没有「标签被移除（重复）」这类噪音警告',
      !r.warnings.some((w) => w.includes('标签被移除')),
      r.warnings.filter((w) => w.includes('标签')).join(' | ') || '（无）',
    );
  }

  {
    const r = sanitizeClips([mk(['虚拟主播', '甲主播', '高能', '游戏', '实况', '单机', '通关', '攻略', '干货', '解说', '新手向'])], base);
    const tags = r.clips[0]!.tags;
    eq('内容词再多也不超过上限', tags.length, TAG_LIMIT);
    ok('必带标签一个都没被挤掉', IDENTITY.map((t) => (t === '{主播}' ? STREAMER : t)).every((t) => tags.includes(t)), tags.join('/'));
    ok(
      '被挤掉的内容词汇总成一条警告（不逐片刷屏）',
      r.warnings.filter((w) => w.includes('超过')).length === 1 && r.warnings.some((w) => w.includes('共丢弃')),
      r.warnings.join(' | ') || '（无）',
    );
  }

  {
    const r = sanitizeClips([mk(['甲主播'])], { ...base, streamerName: undefined });
    ok('没识别出主播名时该条跳过并给警告', r.warnings.some((w) => w.includes('必带标签跳过')), r.warnings.join(' | ') || '（无）');
    ok('标签里不会出现 `{主播}` 原文', !r.clips[0]!.tags.some((t) => t.includes('{')), r.clips[0]!.tags.join('/'));
  }

  {
    const r = sanitizeClips([mk([])], base);
    ok('LLM 一个标签都没给出时仍有标签（必带打底）', r.clips[0]!.tags.length >= IDENTITY.length, r.clips[0]!.tags.join('/'));
  }

  {
    // 不传 identityTags 的老调用方：行为与引入必带标签之前一致
    const { identityTags: _i, streamerName: _s, ...old } = base;
    const r = sanitizeClips([mk(['甲主播', '国安约谈'])], old);
    eqArr(
      '不传 identityTags 时退回旧口径（内容词在前 + 默认词补位）',
      r.clips[0]!.tags,
      ['甲主播', '国安约谈', '直播切片', '名场面', '虚拟主播', '2D', 'vup', 'VTube'],
    );
  }
}

/* ============================ ⑤ 投稿载荷：真的带上了（存量任务也要带） ============================ */
section('⑤ 投稿载荷（buildBiliupConfig）：必带标签在最前，存量任务重新投稿也带');
{
  eqArr(
    '★ payload.tag = 必带标签（含主播名）+ 内容词 + 默认词补位',
    payloadTags(),
    ['虚拟主播', '2D', '3D', 'VTuber', 'vup', STREAMER, '甲主播', '国安约谈', '直播切片', '名场面'],
  );
  ok(
    '前 5 个就是用户要求的身份词（顺序固定）',
    JSON.stringify(payloadTags().slice(0, 5)) === JSON.stringify(['虚拟主播', '2D', '3D', 'VTuber', 'vup']),
    payloadTags().slice(0, 5).join('/'),
  );
  ok('主播名作为标签出现在载荷里', payloadTags().includes(STREAMER), payloadTags().join('/'));
  eq('标签个数不超过 10', payloadTags({ tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }).length, TAG_LIMIT);
  ok(
    '没有主播名时不投 `{主播}` 原文（该条跳过）',
    !payloadTags({}, { streamer: undefined }).some((t) => t.includes('{')),
    payloadTags({}, { streamer: undefined }).join('/'),
  );
  ok(
    '关掉必带标签（identityTags 为空）时退回内容词 + 默认词',
    JSON.stringify(payloadTags({}, { identity: [] })) ===
      JSON.stringify(['甲主播', '国安约谈', '直播切片', '名场面', '虚拟主播', '2D', 'vup', 'VTube']),
    payloadTags({}, { identity: [] }).join('/'),
  );
  ok(
    '默认标签为空也不会凭空造标签',
    payloadTags({ tags: ['甲主播'] }, { defaults: [] }).join('/') === `虚拟主播/2D/3D/VTuber/vup/${STREAMER}/甲主播`,
    payloadTags({ tags: ['甲主播'] }, { defaults: [] }).join('/'),
  );
  ok(
    '敏感词在必带标签里也会被挡下（不上载荷）',
    !payloadTags({ tags: ['甲主播'] }, { identity: ['外挂', 'vup'], sensitive: ['外挂'] }).includes('外挂'),
    payloadTags({ tags: ['甲主播'] }, { identity: ['外挂', 'vup'], sensitive: ['外挂'] }).join('/'),
  );
}

/* ============================ ⑥ 分区回退：投稿侧与选片侧同一口径 ============================ */
section('⑥ 投稿分区：白名单命中就用它，没命中按 `defaultCategory` 回退（不再隐式偏向 21）');
{
  const WL: Record<string, number> = { '生活/日常': 21, '娱乐/娱乐粉丝创作': 242, '动画/综合': 27 };
  const build = (category: string, publishOver: Record<string, unknown> = {}) =>
    buildBiliupConfig({
      clip: clip({ category }),
      task,
      cfg: { ...cfg, publish: { ...cfg.publish, tidWhitelist: WL, ...publishOver } },
      uid: 12345,
      dtime: Math.floor(Date.now() / 1000) + 1200,
      uploadPresetId: 'default',
    });

  {
    const r = build('动画/综合', { defaultCategory: '娱乐/娱乐粉丝创作' });
    eq('命中白名单：用该分区自己的 tid', r.config['tid'], 27);
    ok(
      '命中时不产分区警告',
      !r.warnings.some((w) => w.includes('分区')),
      r.warnings.filter((w) => w.includes('分区')).join(' | ') || '（无）',
    );
  }

  {
    /* 存量 clips.json 里 13 个切片的分区名是「虚拟主播/虚拟主播」，白名单改版后它已不存在。
       旧实现写的是「白名单里有 21 就用 21」，会把这些切片悄悄投到生活/日常，而配置里的默认分区
       明明是娱乐/娱乐粉丝创作 —— 实测 2026-10-17 撞到过。 */
    const r = build('虚拟主播/虚拟主播', { defaultCategory: '娱乐/娱乐粉丝创作' });
    eq('★ 分区名失效：回退到 defaultCategory 的 tid（不是白名单里的 21）', r.config['tid'], 242);
    ok(
      '警告里点名回退到了哪个默认分区',
      r.warnings.some((w) => w.includes('分区') && w.includes('娱乐/娱乐粉丝创作')),
      r.warnings.filter((w) => w.includes('分区')).join(' | ') || '（无）',
    );
  }

  {
    const r = build('不存在的分区', { defaultCategory: '也不在白名单里' });
    eq('defaultCategory 自己也不在白名单时：退回白名单第一项', r.config['tid'], 21);
  }

  {
    const cat = mapCategoryToTid('虚拟主播/虚拟主播', WL, '娱乐/娱乐粉丝创作');
    const payload = build('虚拟主播/虚拟主播', { defaultCategory: '娱乐/娱乐粉丝创作' });
    eq(
      '★ 选片侧（mapCategoryToTid）与投稿侧（buildBiliupConfig）回退到同一个 tid',
      payload.config['tid'],
      cat.tid,
    );
    ok('两边都点名了同一个默认分区名', cat.matched === '娱乐/娱乐粉丝创作', cat.matched);
  }
}

/* ============================ 汇总 ============================ */
console.log('');
if (fail === 0) {
  console.log(`\x1b[32m===== 切片标签口径自测：PASS=${pass} FAIL=0 =====\x1b[0m`);
  console.log('必带标签永远在最前（{主播} → 本场主播名），内容词补满剩余名额，默认标签只填空位，重复去重、上限 10 个。');
  process.exit(0);
} else {
  console.log(`\x1b[31m===== 切片标签口径自测：PASS=${pass} FAIL=${fail} =====\x1b[0m`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
