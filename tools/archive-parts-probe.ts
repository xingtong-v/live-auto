/**
 * 探查：一个稿件的**分P 列表**能不能从 biliLive-tools 的接口里读到。
 *
 * 两个用途：
 *   ① 回答用户的问题 —— biliLive-tools 把 4 段录播投到「同一个稿件」后，那个稿件真的有几个分P？
 *   ② 续传时要给切片分P 编号（P5、P6…），编号基准 = 目标稿件**已有的分P 数**。
 *      现在这个基准是配置里写死的 `publish.resumeClipIndexBase`（默认 2），
 *      如果能读到真实分P 数，就能自动对齐，不会出现「标题写 P3、实际挂在 P5」。
 *
 * 用法：node tools/archive-parts-probe.ts [bvid ...]
 */
import { BiliLiveClient } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';

const cfg = loadConfig().config;
const client = BiliLiveClient.fromConfig(cfg);

const bvids = process.argv.slice(2);
if (bvids.length === 0) bvids.push('BV13hhE6XEQM');

for (const bvid of bvids) {
  console.log(`\n===== ${bvid} =====`);
  try {
    const d = await client.biliArchiveDetail(bvid, { retry: 0 });
    console.log('顶层字段：', Object.keys(d).join(', '));
    /* 实测这层包着 B站 view 接口原始 JSON：分P 在 `View.pages` */
    const view = ((d as Record<string, unknown>)['View'] ?? d) as Record<string, unknown>;
    console.log(`\nView 字段：${Object.keys(view).slice(0, 40).join(', ')}`);
    console.log(`View.title：「${String(view['title'] ?? '')}」`);
    console.log(`View.videos=${String(view['videos'] ?? '?')}  View.duration=${String(view['duration'] ?? '?')}  View.aid=${String(view['aid'] ?? '?')}`);
    /* 分P 数组在不同接口里可能叫 pages / page / videos */
    for (const key of ['pages', 'page', 'parts'] as const) {
      const v = view[key];
      if (Array.isArray(v)) {
        console.log(`\n${key}：${v.length} 个分P`);
        for (const p of v as Array<Record<string, unknown>>) {
          console.log(`   P${String(p['page'] ?? '?')}  cid=${String(p['cid'] ?? '?')}  「${String(p['part'] ?? p['title'] ?? '')}」`);
        }
      } else if (v !== undefined) {
        console.log(`${key}：${JSON.stringify(v).slice(0, 200)}`);
      }
    }
  } catch (e) {
    console.log(`查详情失败：${(e as Error).message.slice(0, 200)}`);
  }
}
