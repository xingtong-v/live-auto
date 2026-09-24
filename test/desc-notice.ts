/**
 * 投稿简介里的 **AI 声明**自测。
 *
 * 用户要求：投稿简介里要写明这是 AI 切片后投稿的（观众与平台都该看得见）。
 *
 * 实现上有两个坑，本测试逐条钉住：
 *   1. 简介上限 **250 字符**（硬约束 #3）。若把声明和正文混在一起截断，声明正好在尾部 →
 *      一截就没了，等于没写。所以声明必须**最后拼、不参与正文截断**。
 *   2. 拼在**所有路径之后**：单切片、多分P 稿件、以及我们自己上传的完整版（走 `overrideDesc`）
 *      都必须带上 —— 漏掉任何一条，那一类稿件就等于没声明。
 *
 * 纯本地：直接调 `buildBiliupConfig`，不联网、不投稿。
 * 运行：node test/desc-notice.ts
 */
import { buildBiliupConfig } from '../src/publish.ts';
import { loadConfig } from '../src/config.ts';
import type { AppConfig } from '../src/config.ts';
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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const cfg = loadConfig().config;
const now = new Date().toISOString();
const task = {
  id: 'desc-notice-test',
  roomId: '12345678',
  platform: 'Bilibili',
  title: '【测试】简介声明',
  status: 'CLIPPED',
  stage: 'CLIPPED',
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
    tags: ['直播切片'],
    category: '游戏/单机游戏',
    score: 8,
    reason: '测试',
    selected: true,
    status: 'CANDIDATE',
    degraded: false,
    ...over,
  } as ClipRecord;
}

function build(over: Partial<ClipRecord> = {}, cfgOver: Partial<AppConfig['publish']> = {}, overrideDesc?: string): string {
  const r = buildBiliupConfig({
    clip: clip(over),
    task,
    cfg: { ...cfg, publish: { ...cfg.publish, ...cfgOver } },
    uid: 12345,
    dtime: Math.floor(Date.now() / 1000) + 7800,
    uploadPresetId: 'default',
    ...(overrideDesc !== undefined ? { overrideDesc } : {}),
  });
  return String(r.config['desc'] ?? '');
}

const NOTICE = String(cfg.publish.aiNotice ?? '').trim();

section('① 默认配置就带 AI 声明（不是靠用户记得打开）');
{
  ok('默认配置里有 aiNotice', NOTICE.length > 0, JSON.stringify(cfg.publish.aiNotice));
  ok('默认文案说明了「AI 完成选段/字幕」与「自动投稿」', /AI/.test(NOTICE) && /选段|切片/.test(NOTICE) && /投稿/.test(NOTICE), NOTICE);
  ok('默认文案说明了「内容来自直播回放」', /直播回放/.test(NOTICE), NOTICE);
  ok('默认文案含「未经人工确认」这类风险提示', /未经人工确认|经人工确认/.test(NOTICE), NOTICE);
  ok('默认文案还带一句求赞 CTA（用户要求，与声明分开成行）', /点个赞|点赞|求赞/.test(NOTICE) && NOTICE.includes('\n'), JSON.stringify(NOTICE));
  /* 声明 + 求赞必须**足够短**：它们占用的额度直接从正文预算里扣 */
  ok('声明整体不超过 100 字符（给正文留足额度）', NOTICE.length <= 100, String(NOTICE.length));
  const desc = build();
  ok('单切片投稿的简介末尾带上声明', desc.endsWith(NOTICE), desc);
  ok('声明单独成段（不和正文粘在一起）', desc.includes(`\n${NOTICE}`), JSON.stringify(desc));
  ok('正文也还在（没有被声明顶掉）', desc.includes('LLM 写的简介正文'), desc);
}

section('② 所有路径都要带：多分P 稿件 / 我们上传的完整版（overrideDesc）');
{
  const mp = build({}, {}, '多分P 稿件的简介正文（P1 完整版 + P2 纯享版 + 切片）');
  ok('多分P 稿件（走 overrideDesc）带声明', mp.endsWith(NOTICE), mp);
  ok('overrideDesc 的正文也在', mp.includes('多分P 稿件的简介正文'), mp);

  const full = build({}, {}, '完整版录播（biliLive-tools 压制产物）');
  ok('完整版上传带声明', full.endsWith(NOTICE), full);
}

section('③ 声明必须活过 250 字符截断（这是最容易写错的一点）');
{
  const long = '很长的简介正文。'.repeat(60); // 600 字符
  ok('构造的正文确实超长', long.length > 250, String(long.length));
  const desc = build({ desc: long }, { descTemplate: '{{desc}}' });
  ok('超长正文被截断到 ≤250', desc.length <= 250, String(desc.length));
  ok('**声明仍在末尾**（没有被一起截掉）', desc.endsWith(NOTICE), JSON.stringify(desc.slice(-60)));
  ok('正文给声明让了位置', desc.length <= 250 && desc.includes(NOTICE));

  /* 极端：正文 + 声明几乎占满，仍不能超 250 */
  const huge = build({ desc: '长'.repeat(400) }, { descTemplate: '{{desc}}' });
  ok('极端超长也 ≤250 字符', huge.length <= 250, String(huge.length));
  ok('极端超长时声明依然完整', huge.endsWith(NOTICE), JSON.stringify(huge.slice(-40)));
}

section('④ 关掉声明：aiNotice 留空 → 简介里不出现');
{
  const desc = build({}, { aiNotice: '' });
  ok('留空时不追加任何声明', !desc.includes('AI'), desc);
  ok('正文照常保留', desc.includes('LLM 写的简介正文'), desc);
  const longNoNotice = build({ desc: '长'.repeat(400) }, { aiNotice: '', descTemplate: '{{desc}}' });
  ok('关掉声明后仍受 250 上限约束', longNoNotice.length <= 250, String(longNoNotice.length));
}

section('⑤ 文案可自定义，且首尾空白会被裁掉');
{
  const custom = build({}, { aiNotice: '  本视频由 AI 生成并自动投稿（含 AI 字幕）  ' });
  ok('自定义文案生效', custom.endsWith('本视频由 AI 生成并自动投稿（含 AI 字幕）'), JSON.stringify(custom.slice(-40)));
  ok('没有引入多余空行', !custom.endsWith('\n') && !custom.includes('\n\n本视频'), JSON.stringify(custom));

  /* 多行声明（声明 + 求赞）要逐字保留，不能被压成一行 */
  const multi = build({}, { aiNotice: '第一行：AI 声明\n第二行：求赞' });
  ok('多行声明逐字保留（换行没被吞）', multi.endsWith('第一行：AI 声明\n第二行：求赞'), JSON.stringify(multi.slice(-30)));
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
if (fail > 0) process.exitCode = 1;
