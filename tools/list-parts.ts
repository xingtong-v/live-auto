/**
 * 打印一个稿件的**全部分P 列表**（序号 / 标题 / 时长），用于人工核对来源。
 *
 * 用途：`duplicate-parts-report.ts` 只输出重复项，但排查"多出来的分P 从哪来"
 * 需要看到**全量**列表（含 biliLive-tools 投的完整版/纯享版，与项目投的切片）。
 *
 * 用法：node --experimental-strip-types tools/list-parts.ts <bvid>
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const bvid = process.argv[2];
if (!bvid) {
  console.error('用法：node --experimental-strip-types tools/list-parts.ts <bvid>');
  process.exit(1);
}
const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

const detail = (await client.biliArchiveDetail(bvid, { retry: 1 })) as unknown as Record<string, unknown>;
const view = (detail['View'] ?? detail) as Record<string, unknown>;
const pages = ((view['pages'] ?? detail['pages']) ?? []) as Array<Record<string, unknown>>;

console.log('='.repeat(96));
console.log(`${bvid}  「${String(view['title'] ?? '').slice(0, 50)}」`);
console.log(`分P 总数 ${pages.length}；videos=${String(view['videos'] ?? '?')}；state=${String(view['state'] ?? '?')}；duration=${String(view['duration'] ?? '?')}s`);
console.log('='.repeat(96));
console.log('序  时长     标题');
console.log('-'.repeat(96));
for (let i = 0; i < pages.length; i++) {
  const p = pages[i]!;
  const d = Number(p['duration'] ?? 0);
  const mm = `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}`;
  const t = String(p['part'] ?? p['title'] ?? '');
  const tag = /弹幕版|纯享版/.test(t) ? '  ← biliLive-tools（完整版/纯享版）' : '';
  console.log(`${String(i + 1).padStart(2)}  ${mm.padStart(7)}  ${t.slice(0, 60)}${tag}`);
}
console.log('-'.repeat(96));
