/**
 * 对照实验：单独追加**一个**明确不同的视频，观察 B站 分P 数是否 +1。
 *
 * 为什么要做这个：已知
 *   · 第 1 次追加 9 个新切片 → **成功**（分P 14 → 23）
 *   · 第 2 次追加 14 个（含 9 个重复）→ 任务 completed，但分P 仍 23
 *   · 第 3 次追加 5 个（**全新增、零重复**）→ 任务 completed，但分P 仍 23
 * 第 3 次排除了"重复导致丢弃"的解释。剩下要区分的是：
 *   A. B站 对该稿件已不再接受追加（分P 上限 / 编辑次数 / 时间窗）
 *   B. 那 5 个切片本身有问题（时长偏短？内容被判重？）
 * 所以换一个**明显不同**的文件（14.5MB 的那个，标题也完全不同）单投一个。
 *   · 若 +1 ⇒ 是"批量/内容"的问题（B 类）
 *   · 若仍不变 ⇒ 是该稿件不再接受追加（A 类）
 *
 * ⚠️ 会真实投稿。用法：node --experimental-strip-types tools/append-one-probe.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const TARGET_AID = '117314833877723';
/** 只投这一个：目录里体积最大的（14.5MB） */
const PICK = /14-005057/;

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

const dir = path.resolve('data', 'clips', 'manual-20260923094131-loby');
const file = fs.readdirSync(dir).find((f) => PICK.test(f));
if (!file) {
  console.error(`没找到匹配 ${PICK} 的切片文件`);
  process.exit(1);
}
const full = path.join(dir, file);
const title = file.replace(/\.mp4$/i, '').replace(/^\d{1,3}[-_]\d{4,8}[-_]/, '');
console.log('='.repeat(90));
console.log('对照实验：追加单个不同的视频');
console.log('='.repeat(90));
console.log(`目标稿件 aid : ${TARGET_AID}`);
console.log(`文件         : ${file}（${(fs.statSync(full).size / 1048576).toFixed(1)} MB）`);
console.log(`标题         : ${title}`);

const uid = (await client.primaryUid())?.uid;
if (!uid) process.exit(1);

const res = await client.biliUpload({
  uid,
  videos: [{ path: full, title }],
  config: { title: '甲主播来两下闪身步就好了2026.09.22', desc: '', tag: ['直播切片'], tid: 21, copyright: 1, is_only_self: 1 },
  vid: TARGET_AID,
});
console.log(`\ntaskId = ${res.taskId}`);

let status = 'unknown';
for (let i = 0; i < 60 && !['completed', 'error'].includes(status); i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const d = (await client.taskDetail(res.taskId, { quiet: true }).catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  status = String(d?.['status'] ?? status);
}
const d = (await client.taskDetail(res.taskId, { quiet: true }).catch(() => undefined)) as
  | Record<string, unknown>
  | undefined;
console.log(`终态 status=${status}  error=${String(d?.['error'] ?? '(空)')}  output=${String(d?.['output'] ?? '(空)')}`);
console.log('\n请核对分P 数（期望从 23 变 24）：');
console.log('  node --experimental-strip-types tools/verify-append-result.ts BV13hhE6XEQM 1');
