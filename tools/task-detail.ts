/**
 * 精确查询单个 biliLive-tools 任务的状态与详情（诊断续传"报了成功但 B站 没变"）。
 *
 * 用法：node --experimental-strip-types tools/task-detail.ts <taskId> [port]
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const taskId = process.argv[2];
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/task-detail.ts <taskId>');
  process.exit(2);
}
const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

console.log(`任务 ${taskId}\n`);

/* 1) 任务详情 */
try {
  const d = (await client.taskDetail(taskId, { quiet: true })) as unknown as Record<string, unknown>;
  console.log('=== taskDetail ===');
  for (const [k, v] of Object.entries(d)) {
    const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
    console.log(`  ${k.padEnd(22)} = ${s.slice(0, 400)}`);
  }
} catch (e) {
  console.log(`taskDetail 失败：${(e as Error).message.slice(0, 160)}`);
}

/* 2) 在任务列表里按 id 找（避免列表分页漏掉） */
console.log('\n=== 在列表里查找 ===');
for (const type of ['biliUpload', 'biliMerge', undefined]) {
  try {
    for (let page = 1; page <= 4; page++) {
      const tl = await client.taskList({ ...(type ? { type } : {}), page, pageSize: 50 });
      const hit = (tl.list ?? []).find((t) => t.taskId === taskId);
      if (hit) {
        console.log(`  命中（type=${type ?? '全部'} page=${page}）：${JSON.stringify(hit).slice(0, 500)}`);
        break;
      }
      if ((tl.list ?? []).length === 0) break;
    }
  } catch (e) {
    console.log(`  type=${type ?? '全部'} 查询失败：${(e as Error).message.slice(0, 90)}`);
  }
}
console.log('\n（若列表里找不到，可能是任务记录已被清理，或该 id 只存在于返回值中）');
