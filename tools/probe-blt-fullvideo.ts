/**
 * 核实「biliLive-tools 先投完整版+纯享版，切片助手追同一稿件」这条链路的前置事实：
 *
 *   1. B站 侧是否**已经存在**由 biliLive-tools 投出的完整版稿件（含多个分P）
 *   2. 这些稿件的 aid / bvid、分P 标题、发布形态（自见/定时/公开）
 *   3. 项目台账里有没有记录过这些稿件（`fullVideoBvid` / `fullUpload`）
 *
 * 背景：用户的实际工作流是「biliLive-tools 上传弹幕完整版 + 纯享完整版 → 切片助手上传切片，
 * 都进同一个稿件」。要往已有稿件追加分P，B站 的投稿需要带 `aid`（而不是新建稿件）。
 * 先确认前半段有没有真的发生，再决定后半段怎么写。
 *
 * 用法：node --experimental-strip-types tools/probe-blt-fullvideo.ts
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

console.log('='.repeat(96));
console.log('B站 侧稿件列表（本账号）');
console.log('='.repeat(96));
const list = (await client.biliArchives({ page: 1, pageSize: 100 })) as unknown as Array<Record<string, unknown>>;
console.log(`共 ${list.length} 条\n`);

const kindOf = (t: string): string => {
  if (/完整版|弹幕版/.test(t)) return '\x1b[36m完整版?\x1b[0m';
  if (/纯享版/.test(t)) return '\x1b[35m纯享版?\x1b[0m';
  return '';
};

console.log('ctime              时长   state  is_self  标题');
console.log('-'.repeat(96));
for (const a of list) {
  const t = String(a['title'] ?? '');
  const ct = Number(a['ctime'] ?? 0);
  const ctText = ct > 1e9 ? new Date(ct * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
  console.log(
    `${ctText.padEnd(19)} ${String(a['duration'] ?? '-').padStart(5)}s ${String(a['state'] ?? '-').padStart(6)} ` +
      `${String(a['is_only_self'] ?? '-').padStart(7)}  ${t.slice(0, 42).padEnd(44)} ${kindOf(t)}`,
  );
}

/* 台账里是否记过完整版 */
console.log('\n' + '='.repeat(96));
console.log('项目台账里的完整版记录');
console.log('='.repeat(96));
try {
  const led = JSON.parse(fs.readFileSync('data/ledger.json', 'utf8')) as {
    tasks?: Record<string, { fullUpload?: string; fullVideoBvid?: string; title?: string }>;
  };
  const tasks = Object.values(led.tasks ?? {});
  console.log(`台账任务数：${tasks.length}`);
  const withFull = tasks.filter((t) => t.fullVideoBvid || (t.fullUpload && t.fullUpload !== 'NOT_APPLICABLE'));
  if (withFull.length === 0) {
    console.log('  \x1b[33m没有任何任务记录过完整版 bvid 或上传状态\x1b[0m');
  }
  for (const t of withFull) {
    console.log(`  ${String(t.title).slice(0, 34).padEnd(36)} fullUpload=${t.fullUpload} bvid=${t.fullVideoBvid ?? '-'}`);
  }
} catch (e) {
  console.log(`  读取台账失败：${(e as Error).message.slice(0, 80)}`);
}

/* 可疑：多P稿件（列表里看不到分P数，但标题带 P 序号的是多P稿件的分P残留） */
console.log('\n' + '='.repeat(96));
console.log('判定');
console.log('='.repeat(96));
const fullish = list.filter((a) => /完整版|弹幕版|纯享版/.test(String(a['title'] ?? '')));
if (fullish.length === 0) {
  console.log('\x1b[33mB站 侧没有标题含「完整版/弹幕版/纯享版」的稿件。\x1b[0m');
  console.log('  ⇒ 说明 biliLive-tools 目前**并没有**把完整版投到 B站（或它的标题不含这些词）。');
  console.log('  ⇒ 若要走「同稿件追加分P」，需要先让 biliLive-tools 那侧真的投出完整版稿件。');
} else {
  console.log(`发现 ${fullish.length} 条疑似完整版稿件：`);
  for (const a of fullish) {
    console.log(`  bvid=${String(a['bvid'])} aid=${String(a['aid'])} 《${String(a['title']).slice(0, 50)}》`);
  }
}
