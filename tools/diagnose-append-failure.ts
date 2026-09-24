/**
 * 诊断：重跑声称"已续传 14 个分P"，但 B站 侧分P 数没变（仍 23）。
 *
 * 要查清是哪种情况：
 *   A. 上传任务其实失败了（biliLive-tools 侧 task 状态 error）
 *   B. 上传成功了但被 B站 判为重复内容而丢弃
 *   C. 上传任务还在跑（只是慢）
 *   D. 项目误报成功（把"任务已创建"当成了"投稿成功"）
 *
 * 手法：拉 biliLive-tools 的任务列表，找那个 uploadTaskId 的真实状态与输出。
 *
 * 用法：node --experimental-strip-types tools/diagnose-append-failure.ts [uploadTaskId]
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const wantTaskId = process.argv[2] ?? '';
const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

console.log('='.repeat(100));
console.log('biliLive-tools 上传任务列表（biliUpload 类型）');
console.log('='.repeat(100));

for (const type of ['biliUpload', undefined]) {
  try {
    const tl = await client.taskList({ ...(type ? { type } : {}), pageSize: 30 });
    const list = tl.list ?? [];
    console.log(`\n── type=${type ?? '(全部)'}：${list.length} 个任务`);
    for (const t of list.slice(0, 12)) {
      const mark = wantTaskId && t.taskId === wantTaskId ? '  \x1b[36m← 本次续传任务\x1b[0m' : '';
      console.log(
        `  ${String(t.taskId).slice(0, 12)}…  status=${String(t.status).padEnd(10)} ` +
          `progress=${t.progress !== undefined ? `${t.progress}%` : '-'}  ${String(t.name ?? '').slice(0, 34)}${mark}`,
      );
      if (wantTaskId && t.taskId === wantTaskId) {
        console.log(`      完整对象：${JSON.stringify(t).slice(0, 600)}`);
        /* 详情可能带 error / output */
        try {
          const d = (await client.taskDetail(t.taskId, { quiet: true })) as unknown as Record<string, unknown>;
          console.log(`      详情：${JSON.stringify(d).slice(0, 900)}`);
        } catch (e) {
          console.log(`      详情读取失败：${(e as Error).message.slice(0, 100)}`);
        }
      }
    }
    if (list.length === 0) console.log('  （空）');
  } catch (e) {
    console.log(`  查询失败（type=${type ?? '全部'}）：${(e as Error).message.slice(0, 120)}`);
  }
}

console.log('\n' + '='.repeat(100));
console.log('判读');
console.log('='.repeat(100));
console.log('  · 若本次任务 status=error ⇒ 上传失败，项目却报了成功（需修：等任务终态再判定）');
console.log('  · 若 status=completed 但 B站 没变 ⇒ B站 丢弃了这批分P（可能判重或超上限）');
console.log('  · 若 status=running ⇒ 只是还没传完，稍后再看');
