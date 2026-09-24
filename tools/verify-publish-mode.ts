/**
 * 核实稿件在 B站 侧的**真实**发布形态：立即发布（已过审/可查）还是定时（未到点查不到）。
 *
 * 为什么要单独核实：项目日志曾经**无条件**打印「定时发布 <dtime>」（payload 其实没传 dtime），
 * UI 的 schedule.dtimeText 也是从那条日志反推的。所以「日志说是定时」并不能证明稿件真是定时的 ——
 * 必须问 B站 自己。
 *
 * 用法：node --experimental-strip-types tools/verify-publish-mode.ts <taskId> [port]
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const taskId = process.argv[2];
const port = Number(process.argv[3] ?? 3000);
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/verify-publish-mode.ts <taskId> [port]');
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

const t = (await (await fetch(`${base}/api/task/${taskId}`)).json()) as {
  title?: string;
  schedule?: Array<{ clipIndex: number; title: string; bvid?: string; status: string; dtimeText?: string }>;
};

console.log(`任务 ${taskId}  《${t.title ?? ''}》`);
console.log(`本场 ${t.schedule?.length ?? 0} 个切片\n`);

/* 拉一次稿件列表，用 bvid 反查真实存在与状态。
   注意：`biliArchives` 已经内部解开 `arc_audits[].Archive`，**直接返回数组**。 */
let archives: Array<Record<string, unknown>> = [];
try {
  archives = (await client.biliArchives({ page: 1, pageSize: 100 })) as unknown as Array<Record<string, unknown>>;
} catch (e) {
  console.log(`读取稿件列表失败：${(e as Error).message.slice(0, 120)}`);
}
const byBvid = new Map<string, Record<string, unknown>>();
for (const a of archives) {
  if (typeof a['bvid'] === 'string') byBvid.set(a['bvid'], a);
}
console.log(`B站 侧共取到 ${archives.length} 个稿件用于比对\n`);

console.log('切片  bvid             日志说的时间            B站侧状态            判定');
console.log('-'.repeat(96));
let nowPublic = 0;
let scheduled = 0;
let unknown = 0;
for (const s of t.schedule ?? []) {
  const a = s.bvid ? byBvid.get(s.bvid) : undefined;
  const st = a ? String(a['state'] ?? a['state_desc'] ?? '(无状态字段)') : '未在稿件列表中找到';
  let verdict: string;
  if (a) {
    // state: 0=开放浏览 1=仅自己可见 …；有 ctime 说明已创建
    const isOpen = String(a['state'] ?? '') === '0';
    const onlySelf = String(a['state'] ?? '') === '1';
    if (isOpen) {
      verdict = '\x1b[32m已公开（立即发布生效）\x1b[0m';
      nowPublic++;
    } else if (onlySelf) {
      verdict = '\x1b[32m已创建·仅自己可见（立即发布生效）\x1b[0m';
      nowPublic++;
    } else {
      verdict = `已创建（state=${String(a['state']) }）`;
      nowPublic++;
    }
  } else if (s.status === 'SUBMITTED') {
    verdict = '待反查确认';
    unknown++;
  } else {
    verdict = '\x1b[33m列表里没有\x1b[0m';
    unknown++;
  }
  if (s.dtimeText) scheduled++;
  console.log(
    `#${String(s.clipIndex).padEnd(4)} ${String(s.bvid ?? '(无)').padEnd(16)} ${String(s.dtimeText ?? '(未记录)').padEnd(22)} ${st.padEnd(20)} ${verdict}`,
  );
}

console.log('\n' + '='.repeat(96));
console.log(`日志里带 dtimeText 的切片：${scheduled} 个（说明日志记录的是「定时」形态）`);
console.log(`B站 侧已可查到、即真实存在的稿件：${nowPublic} 个`);
console.log(`未确认：${unknown} 个`);
console.log(
  nowPublic > 0
    ? '\n\x1b[32m结论：稿件已在 B站 侧创建并可查到 —— 立即发布实际是生效的，"定时发布"只是日志文案的错误。\x1b[0m'
    : '\n\x1b[33m结论：暂未在稿件列表中找到，可能 still 待 B站 侧出现（定时稿件要等 dtime 到点）。\x1b[0m',
);
