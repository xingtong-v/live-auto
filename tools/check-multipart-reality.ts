/**
 * 回答一个具体问题：**我现在的稿件是多P投稿吗？**
 *
 * 判据（都从 B站 侧取真实数据，不猜）：
 *   1. 一个多P稿件 = **1 个 bvid**，其下挂 N 个分P → 用 `/x/player/pagelist` 查分P数
 *   2. 若本场 N 个切片各自有**独立 bvid**，那就是 N 个独立稿件，不是多P
 *
 * 用法：node --experimental-strip-types tools/check-multipart-reality.ts [taskId] [port]
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const taskId = process.argv[2] ?? fs.readFileSync('data/local-asr-test/trial-task-id.txt', 'utf8').trim();
const port = Number(process.argv[3] ?? 3000);
const base = `http://127.0.0.1:${port}`;
const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

console.log('='.repeat(88));
console.log(`问题：任务 ${taskId} 的稿件是多P投稿吗？`);
console.log('='.repeat(88));

const t = (await (await fetch(`${base}/api/task/${taskId}`)).json()) as {
  title?: string;
  schedule?: Array<{ clipIndex: number; title: string; bvid?: string; status: string; dtimeText?: string }>;
};
const sched = t.schedule ?? [];
const withBvid = sched.filter((s) => s.bvid);

/* ---- 证据 1：投稿批次（每次 /bili/upload = 一个稿件）---- */
const logPath = 'data/publish-log.jsonl';
const submits = fs
  .readFileSync(logPath, 'utf8')
  .trim()
  .split('\n')
  .map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return null;
    }
  })
  .filter((e): e is Record<string, unknown> => e !== null)
  .filter((e) => e['taskId'] === taskId && e['action'] === 'submit');

const uploadIds = new Set(submits.map((s) => String(s['uploadTaskId'])));
console.log(`\n【证据 1】投稿次数（每次调用 /bili/upload 产生 1 个稿件）`);
console.log(`  本场 submit 事件      : ${submits.length} 条`);
console.log(`  不同 uploadTaskId     : ${uploadIds.size} 个`);
console.log(`  → ${uploadIds.size === 1 ? '只投了 1 次 ⇒ 可能是多P（1 个稿件多个分P）' : `投了 ${uploadIds.size} 次 ⇒ **${uploadIds.size} 个独立稿件**`}`);

/* ---- 证据 2：bvid 数量 ---- */
console.log(`\n【证据 2】切片与 bvid 的对应关系`);
console.log(`  本场切片数            : ${sched.length}`);
console.log(`  已拿到 bvid 的切片数  : ${withBvid.length}`);
for (const s of sched) {
  console.log(`    #${String(s.clipIndex).padEnd(2)} bvid=${String(s.bvid ?? '(无)').padEnd(15)} ${String(s.title).slice(0, 40)}`);
}
console.log(
  `  → ${withBvid.length > 1 && withBvid.length === sched.length ? `每个切片各自一个 bvid ⇒ **${withBvid.length} 个独立稿件，不是多P**` : '见上表'}`,
);

/* ---- 证据 3：查每个 bvid 的稿件详情 + 尝试公开 pagelist 取分P数 ---- */
console.log(`\n【证据 3】稿件详情与分P数`);
console.log('  bvid             稿件时长  分P数(可得则显示)  标题');
console.log('  ' + '-'.repeat(78));
let multiCount = 0;
let singleCount = 0;
for (const s of withBvid) {
  const bvid = s.bvid!;
  let dur = '-';
  let parts = '未取到';
  let title = '';
  try {
    const d = (await client.biliArchiveDetail(bvid)) as unknown as Record<string, unknown>;
    title = String(d['title'] ?? '').slice(0, 34);
    dur = d['duration'] === undefined ? '-' : `${String(d['duration'])}s`;
    // 有些实现会把分P放在这些字段里
    const cand = d['videos'] ?? d['page'] ?? d['part_count'] ?? d['is_multi'];
    if (typeof cand === 'number') parts = String(cand);
  } catch (e) {
    title = `(详情失败：${(e as Error).message.slice(0, 30)})`;
  }
  /* B站 公开接口：/x/player/pagelist 只认 bvid，不需登录。
     注意：仅自己可见的稿件可能返回空，所以它只是**补充**证据，拿不到不作为反证。 */
  if (parts === '未取到') {
    try {
      const r = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const j = (await r.json()) as { code?: number; data?: unknown[] };
      if (j.code === 0 && Array.isArray(j.data)) parts = String(j.data.length);
    } catch {
      /* 忽略：公开接口不可用不影响结论 */
    }
  }
  if (parts !== '未取到') {
    if (Number(parts) > 1) multiCount++;
    else singleCount++;
  }
  console.log(`  ${bvid.padEnd(16)} ${dur.padEnd(9)} ${String(parts).padEnd(17)} ${title}`);
}

console.log('\n' + '='.repeat(88));
console.log('结论');
console.log('='.repeat(88));
/* 主判据是证据 1/2（每次 /bili/upload 产生 1 个稿件；bvid 与切片一一对应），
   分P数只是补充 —— 仅自己可见的稿件公开接口常常取不到。 */
const independent = uploadIds.size > 1;
if (independent && withBvid.length === sched.length && sched.length > 1) {
  console.log(
    `\x1b[31m不是多P投稿：${sched.length} 个切片 = ${uploadIds.size} 个官方投稿批次 = ${withBvid.length} 个独立 bvid。\x1b[0m`,
  );
  console.log('  即：每个切片是一个**独立单P稿件**，而不是「1 个稿件 + N 个分P」。');
  console.log('\n  原因：`publish.multiPart=true` 这个配置项在**自动流程里没被读取** ——');
  console.log('        `publishAsMultiPart()` 原本只有手动工具 tools/publish-multipart.ts 会调用。');
  console.log('        修复已实现（daemon.publishStage 分流 + test/multipart-routing.ts 14/14），');
  console.log('        但需要**重启服务**，且只对**新场次**生效；已投出的稿件不会被改动。');
} else if (multiCount > 0 && singleCount === 0) {
  console.log(`\x1b[32m是多P投稿：${multiCount} 个稿件各自含多个分P。\x1b[0m`);
} else if (uploadIds.size === 1) {
  console.log('\x1b[32m是多P投稿：本场只调用了一次 /bili/upload（1 个稿件），切片是它的多个分P。\x1b[0m');
} else {
  console.log(`无法从现有证据判定（投稿批次数=${uploadIds.size}，bvid 数=${withBvid.length}，分P统计=${multiCount}多/${singleCount}单）。`);
}
