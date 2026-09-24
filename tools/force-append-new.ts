/**
 * 独立验证：那 5 个"没进去"的切片**能否**追加到目标稿件。
 *
 * 背景（实测事故）：
 *   1) 首次投 9 个切片 → 成功（B站 分P 14 → 23）
 *   2) 重跑投 14 个（含那 9 个重复）→ 任务 completed，但 B站 **静默丢弃整批**（仍 23）
 *   3) 那 5 个新切片因此被误标为 SUBMITTED，项目的 publishClips 从此跳过它们
 * ⇒ 项目流程走不到了。本工具**绕开项目逻辑**，直接调 biliLive-tools 的 /bili/upload
 *   带 vid=aid 只投这 5 个新增切片，用来判定：
 *     · B站 是否真的能追加（分P 23 → 28）
 *     · 还是这批内容本身被 B站 拒绝（那就要另找原因）
 *
 * ⚠️ 会真实投稿到该稿件（aid=117314833877723）。
 * 用法：node --experimental-strip-types tools/force-append-new.ts [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const dryRun = process.argv.includes('--dry-run');
const TASK_ID = 'manual-20260923094131-loby';
const TARGET_AID = '117314833877723';
/** 已被 B站 收录的 9 个（标题）—— 不重投 */
const ALREADY = new Set([
  '甲主播为观众唱生日歌忘词，自嘲好尴尬',
  '甲主播念放假天数每次不一样，自证真人直播',
  '甲主播：我穿了衣服，只有聪明人能看到，看不到的都是笨蛋',
  '甲主播自曝生气都是装的，真生气你们没见过，自称好拿捏',
  '甲主播要把观众介绍去朋友工作室上班，介绍工作名场面',
  '甲主播直播封面正式出炉，自称养成系',
  '甲主播官宣疯狂星期四福利放假，回应中秋直播安排',
  '甲主播解释睡觉戴帽子原因，严正声明没有秃顶',
  '甲主播花半小时做GIF发出去没人理，发现被卡住后气到删掉',
].map((s) => s.replace(/\s+/g, '')));

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

/* 收集这 5 个新增切片的产物路径。
   ⚠️ 必须传**绝对路径**：biliLive-tools 收到相对路径时按**它自己的工作目录**解析
   （实测被解析成 C:\WINDOWS\system32\data\clips\… 然后 ENOENT）。
   项目主流程用的是 absPath()，工具这里不能偷懒。 */
const clipsDir = path.resolve('data', 'clips', TASK_ID);
const files = fs.existsSync(clipsDir) ? fs.readdirSync(clipsDir).filter((f) => f.endsWith('.mp4')).sort() : [];
console.log('='.repeat(94));
console.log('目标：把「未被 B站 收录」的切片追加到稿件');
console.log('='.repeat(94));
console.log(`稿件 aid       : ${TARGET_AID}`);
console.log(`切片目录       : ${clipsDir}（${files.length} 个 mp4）`);

/** 从产物文件名里剥掉 `NN-HHMMSS-` 前缀得到标题 */
const titleOf = (fileName: string): string =>
  fileName.replace(/\.mp4$/i, '').replace(/^\d{1,3}[-_]\d{4,8}[-_]/, '');

const news = files
  .map((f) => ({ file: path.join(clipsDir, f), title: titleOf(f) }))
  .filter((x) => !ALREADY.has(x.title.replace(/\s+/g, '')));

console.log(`\n已收录 ${files.length - news.length} 个，**待追加 ${news.length} 个**：`);
for (const n of news) console.log(`  ${n.title}`);

if (news.length === 0) {
  console.log('\n没有待追加的切片。');
  process.exit(0);
}
if (dryRun) {
  console.log('\n--dry-run：不实际投稿。去掉该参数即会真实追加。');
  process.exit(0);
}

const uid = (await client.primaryUid())?.uid;
if (!uid) {
  console.error('拿不到投稿用 uid');
  process.exit(1);
}

/* 只投这 5 个：videos 带各自标题，config 只放最小必要字段（分P 追加不改稿件信息） */
const config: Record<string, unknown> = {
  title: '甲主播来两下闪身步就好了2026.09.22',
  desc: '',
  tag: ['直播切片'],
  tid: 21,
  copyright: 1,
  is_only_self: 1,
};

console.log(`\n调用 /bili/upload（vid=${TARGET_AID}，videos=${news.length} 个）…`);
const res = await client.biliUpload({
  uid,
  videos: news.map((n) => ({ path: n.file, title: n.title })),
  config,
  vid: TARGET_AID,
});
console.log(`返回 taskId = ${res.taskId}`);

/* 等任务终态（这才是"投稿成功"的真实依据；只看 taskId 会被骗） */
console.log('\n等待任务终态…');
const outcome = await client.taskDetail(res.taskId, { quiet: true }).catch(() => undefined);
let status = String((outcome as Record<string, unknown> | undefined)?.['status'] ?? 'unknown');
for (let i = 0; i < 60 && !['completed', 'error'].includes(status); i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const d = (await client.taskDetail(res.taskId, { quiet: true }).catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  status = String(d?.['status'] ?? status);
}
const detail = (await client.taskDetail(res.taskId, { quiet: true }).catch(() => undefined)) as
  | Record<string, unknown>
  | undefined;
console.log(`任务终态 status=${status}`);
console.log(`  error  = ${String(detail?.['error'] ?? '(空)')}`);
console.log(`  output = ${String(detail?.['output'] ?? '(空)')}`);
console.log('\n接下来请核对 B站 分P 数是否从 23 变为 28：');
console.log(`  node --experimental-strip-types tools/verify-append-result.ts BV13hhE6XEQM 5`);
