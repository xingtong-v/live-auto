/**
 * 核实续传是否真的追加成功：向 B站 查目标稿件的**分P列表**。
 *
 * 判据：投稿前后分P 数应当增加（原 14 个 → 追加 9 个 ⇒ 23 个）。
 * 只读（走 biliLive-tools 的稿件详情接口，它内部有登录态）。
 *
 * 用法：node --experimental-strip-types tools/verify-append-result.ts <bvid> [期望新增数]
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const bvid = process.argv[2] ?? 'BV13hhE6XEQM';
const expectAdded = Number(process.argv[3] ?? 9);

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

console.log('='.repeat(100));
console.log(`稿件 ${bvid} 的分P 核对`);
console.log('='.repeat(100));

const detail = (await client.biliArchiveDetail(bvid, { retry: 1 })) as unknown as Record<string, unknown>;

/* ⚠️ 分P 列表在 `View.pages`（顶层没有 pages）—— 第一版就是漏了这层，误显示"没有分P 列表" */
const view = (detail['View'] ?? {}) as Record<string, unknown>;
const pages =
  (view['pages'] as Array<Record<string, unknown>> | undefined) ??
  (detail['pages'] as Array<Record<string, unknown>> | undefined);

console.log(`标题     : ${String(view['title'] ?? '')}`);
console.log(`分P 数   : View.videos = ${String(view['videos'] ?? '?')}${pages ? `（pages 数组 ${pages.length} 项）` : ''}`);
console.log(`时长     : ${String(view['duration'] ?? '?')} 秒`);
console.log(`state    : ${String(view['state'] ?? '?')}   仅自见: ${String(view['is_only_self'] ?? '?')}`);

if (pages?.length) {
  console.log('\n序号  时长(秒)  标题');
  console.log('-'.repeat(100));
  pages.forEach((p, i) => {
    const dur = Number(p['duration'] ?? 0);
    const title = String(p['part'] ?? p['title'] ?? '');
    const looksAppended = !/\d{4}\.\d{2}\.\d{2}/.test(title) && !/弹幕版|纯享版/.test(title);
    console.log(
      `${String(i + 1).padStart(3)}  ${String(Math.round(dur)).padStart(7)}  ${title.slice(0, 62)}` +
        (looksAppended ? '   \x1b[36m← 本次追加\x1b[0m' : ''),
    );
  });
  const appended = pages.filter((p) => {
    const t = String(p['part'] ?? p['title'] ?? '');
    return !/\d{4}\.\d{2}\.\d{2}/.test(t) && !/弹幕版|纯享版/.test(t);
  }).length;
  console.log('\n' + '='.repeat(100));
  console.log(`疑似本次追加的分P：${appended} 个（期望 ${expectAdded}）`);
  console.log(
    appended >= expectAdded
      ? '\x1b[32m✓ 续传追加已生效 —— B站 允许对已发布稿件追加分P\x1b[0m'
      : appended > 0
        ? `\x1b[33m部分生效：追加了 ${appended} 个（期望 ${expectAdded}）\x1b[0m`
        : '\x1b[31m✗ 没有看到追加的分P —— 需要查上传任务状态\x1b[0m',
  );
} else {
  console.log('\n详情结构（找分P 列表用）：');
  for (const [k, v] of Object.entries(detail)) {
    const s = typeof v === 'object' ? JSON.stringify(v).slice(0, 90) : String(v).slice(0, 90);
    console.log(`  ${k.padEnd(24)} = ${s}`);
  }
}
