/**
 * 「一场直播 = 1 个稿件 / 2+n 个分P」链路的**端到端体检**。
 *
 * 目标结构（用户确认的方案）：
 *   P1 完整弹幕版   ← biliLive-tools 投
 *   P2 完整纯享版   ← biliLive-tools 投（uploadNoDanmu + uploadToSameMedia）
 *   P3..P(2+n) 切片 ← 切片助手**续传**进同一个稿件（/bili/upload 带 vid）
 *
 * 这条链路横跨两个软件，任何一环没配好都会静默退化成「两个独立稿件」或「每片一稿」。
 * 本工具把每一环的**当前实际状态**摊出来，并指出断在哪。
 *
 * 只读：不建任务、不投稿、不改配置。
 * 用法：node --experimental-strip-types tools/check-2plusn-chain.ts
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

let blockers = 0;
const step = (n: string, title: string): void => {
  console.log(`\n\x1b[1m${n} ${title}\x1b[0m`);
  console.log('  ' + '─'.repeat(88));
};
const ok = (cond: boolean, label: string, detail: string, fatal = true): void => {
  if (!cond && fatal) blockers++;
  const mark = cond ? '\x1b[32m✓\x1b[0m' : fatal ? '\x1b[31m✗\x1b[0m' : '\x1b[33m⚠\x1b[0m';
  console.log(`  ${mark} ${label.padEnd(34)} ${detail}`);
};

console.log('='.repeat(92));
console.log('链路体检：一场直播 → 1 个稿件 / 2+n 个分P');
console.log('='.repeat(92));

/* ============================ 环节 1：biliLive-tools 侧 ============================ */
step('环节 1', 'biliLive-tools 负责投 P1 完整弹幕版 + P2 纯享版');

const flat: Array<[string, unknown]> = [];
try {
  const raw = (await client.getConfig()) as Record<string, unknown>;
  const walk = (v: unknown, p: string): void => {
    if (v === null || typeof v !== 'object') {
      if (p) flat.push([p, v]);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, p ? `${p}.${k}` : k);
  };
  walk(raw, '');
} catch (e) {
  console.log(`  \x1b[31m✗\x1b[0m 读取 biliLive-tools /config 失败：${(e as Error).message.slice(0, 80)}`);
  blockers++;
}
const g = (k: string): unknown => flat.find(([kk]) => kk === k)?.[1];

if (flat.length > 0) {
  ok(g('webhook.open') === true, 'webhook 总开关', String(g('webhook.open')));
  ok(g('webhook.danmu') === true, '压制弹幕（生成 P1）', String(g('webhook.danmu')));
  ok(g('webhook.uploadNoDanmu') === true, '额外投无弹幕版（P2）', String(g('webhook.uploadNoDanmu')));
  ok(g('webhook.uploadToSameMedia') === true, '两个版本投同一稿件', String(g('webhook.uploadToSameMedia')));
  ok(g('webhook.autoPartMerge') === true, '分段自动合并成一场', String(g('webhook.autoPartMerge')));
  ok(g('webhook.afterUploadDeletAction') === 'none', '上传后不删素材（硬约束 #11）', String(g('webhook.afterUploadDeletAction')));

  const sendRooms: string[] = [];
  for (const [k, v] of flat) {
    const m = /^recorders\[(\d+)\]\.(channelId|sendToWebhook|remarks)$/.exec(k);
    if (m) {
      const idx = m[1]!;
      if (m[2] === 'channelId') sendRooms.push(`${String(v)}(${String(g(`recorders[${idx}].remarks`) ?? '')})`);
    }
  }
  const anySend = flat.some(([k, v]) => /^recorders\[\d+\]\.sendToWebhook$/.test(k) && v === true);
  ok(anySend, '至少一个房间推送 webhook', sendRooms.join('、'), false);
  console.log(`  \x1b[90m· 关键组合：uploadNoDanmu && uploadToSameMedia = ${
    g('webhook.uploadNoDanmu') === true && g('webhook.uploadToSameMedia') === true ? 'true（会生成 弹幕版+纯享版 两分P）' : 'false'
  }\x1b[0m`);
}

/* ============================ 环节 2：B站 侧的完整版稿件 ============================ */
step('环节 2', 'B站 侧是否已有「完整版+纯享版」稿件（续传目标）');

let archives: Array<Record<string, unknown>> = [];
try {
  archives = (await client.biliArchives({ page: 1, pageSize: 100 })) as unknown as Array<Record<string, unknown>>;
} catch (e) {
  console.log(`  \x1b[31m✗\x1b[0m 读取稿件列表失败：${(e as Error).message.slice(0, 80)}`);
  blockers++;
}

/** biliLive-tools 投的完整版稿件：标题里带日期点号形态，且时长通常 > 30 分钟 */
const looksLikeFull = archives.filter((a) => {
  const t = String(a['title'] ?? '');
  const dur = Number(a['duration'] ?? 0);
  return dur > 1800 && /\d{4}\.\d{2}\.\d{2}/.test(t);
});
console.log(`  稿件列表 ${archives.length} 条；疑似 biliLive-tools 完整版（时长>30分 且标题含 YYYY.MM.DD）${looksLikeFull.length} 条`);
for (const a of looksLikeFull.slice(0, 6)) {
  console.log(`    aid=${String(a['aid']).padEnd(16)} bvid=${String(a['bvid']).padEnd(15)} ${String(Math.round(Number(a['duration']) / 60))}分  ${String(a['title']).slice(0, 40)}`);
}
ok(
  looksLikeFull.length > 0,
  '已存在可续传的完整版稿件',
  looksLikeFull.length > 0 ? '有 → 切片可以追加进去' : '没有 → biliLive-tools 还没投过完整版（或都没公开）',
  false,
);

/* ============================ 环节 3：切片助手侧 ============================ */
step('环节 3', '切片助手负责把切片续传进同一稿件');

ok(cfg.publish.multiPart === true, 'multiPart 已开（走多分P路由）', String(cfg.publish.multiPart));
ok(Boolean(cfg.publish.resumeAid.trim()) || Boolean(cfg.publish.resumeTitleTemplate.trim()), '续传目标已配置', cfg.publish.resumeAid.trim() ? `resumeAid=${cfg.publish.resumeAid}` : `按标题模板「${cfg.publish.resumeTitleTemplate}」自动查找`);
ok(cfg.publish.resumeClipIndexBase >= 1, '已有分P数（序号偏移）', `${cfg.publish.resumeClipIndexBase} → 追加的切片从 P${cfg.publish.resumeClipIndexBase + 1} 起`);

/* ============================ 代码能力检查 ============================ */
step('环节 4', '代码能力（防止「配置对了但代码没接」）');

const apiSrc = fs.readFileSync('src/api.ts', 'utf8');
const pubSrc = fs.readFileSync('src/publish.ts', 'utf8');
const daeSrc = fs.readFileSync('src/daemon.ts', 'utf8');
ok(/vid\?:/.test(apiSrc) && /params\.vid/.test(apiSrc), 'api.ts 支持 vid 参数', 'biliUpload 会把 vid 发给 /bili/upload');
ok(/resumeAid/.test(pubSrc) && /vid: resumeAid/.test(pubSrc), 'publish.ts 会传 vid', '续传时带 vid → editMedia');
ok(/publishMultiPartStage/.test(daeSrc) && /findResumeTarget/.test(daeSrc), 'daemon.ts 已接多分P路由与目标查找', 'publishStage 分流 + findResumeTarget');

/* ============================ 汇总 ============================ */
console.log('\n' + '='.repeat(92));
if (blockers === 0) {
  console.log('\x1b[32m阻断项 0 个 —— 链路已具备「2+n 同一稿件」的能力。\x1b[0m');
  console.log('下一场直播会自动走：biliLive-tools 投 P1/P2 → 切片助手找到该稿件 → 追加 P3..P(2+n)。');
} else {
  console.log(`\x1b[31m阻断项 ${blockers} 个\x1b[0m —— 见上面标 ✗ 的行。`);
}
console.log('='.repeat(92));

/* 提示：真正的端到端验证只能等一场真实直播 */
console.log('\n\x1b[90m注意：B站 是否允许对「已发布」稿件追加分P 尚未实测（biliLive-tools 的 UI 写的是');
console.log('「续传只会增加分p，不会对稿件进行编辑」）。首次真实跑时请留意日志里的「已续传到稿件 aid=…」。\x1b[0m');
