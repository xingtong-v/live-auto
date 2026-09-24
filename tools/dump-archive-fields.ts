/**
 * Dump 本场稿件的**完整字段**，用来判断 B站 侧真实发布形态。
 *
 * 起因：`state=-50` 不在常见的 B站 状态码表里（0=开放 1=仅自见 …），
 * 而"定时发布"这条结论会直接影响用户对「立即发布到底生效没有」的判断，
 * 不能靠猜。这里把 biliLive-tools `/bili/archives` 返回的原始字段摊开看。
 *
 * 用法：node --experimental-strip-types tools/dump-archive-fields.ts <bvid...>
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

const want = new Set(process.argv.slice(2));
const list = (await client.biliArchives({ page: 1, pageSize: 100 })) as unknown as Array<Record<string, unknown>>;
console.log(`稿件列表共 ${list.length} 条`);
if (list.length > 0) {
  console.log('\n=== 列表里第一条的全部字段（字段名参考）===');
  for (const [k, v] of Object.entries(list[0]!)) {
    const s = typeof v === 'object' ? JSON.stringify(v).slice(0, 100) : String(v);
    console.log(`  ${k.padEnd(22)} = ${s}`);
  }
}

const targets = want.size > 0 ? list.filter((a) => want.has(String(a['bvid']))) : list;
console.log(`\n=== 目标稿件 ${targets.length} 条的关键字段 ===`);
for (const a of targets) {
  const pick = (k: string): string => {
    const v = a[k];
    if (v === undefined) return '(无此字段)';
    if (typeof v === 'number' && /time|ctime|mtime|pubdate|dtime/i.test(k) && v > 1e9) {
      return `${v} → ${new Date(v * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    }
    return typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v);
  };
  console.log(`\n  bvid=${String(a['bvid'])}  title=${String(a['title'] ?? '').slice(0, 40)}`);
  for (const k of ['state', 'state_desc', 'ctime', 'pubdate', 'dtime', 'copyright', 'is_only_self', 'attribute', 'duration', 'comment', 'subtitle']) {
    if (a[k] !== undefined) console.log(`      ${k.padEnd(14)} = ${pick(k)}`);
  }
}
