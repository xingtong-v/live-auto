/**
 * 用 **B站 公开接口**核验一个稿件的真实分P 构成（不依赖 biliLive-tools）。
 *
 * 为什么需要这条独立路径：
 *   投稿刚完成时稿件的详情可能还在处理中，biliLive-tools 的
 *   `/bili/user/archive/:bvid` 会返回 500「啥都木有」。这时用 B站 自己的
 *   `x/web-interface/view` 看**观众实际能看到的**分P 列表，是唯一权威依据 ——
 *   也正好回答"一个稿件里到底有没有完整版 + 纯享版 + 切片"。
 *
 * 只读，不需要登录态（公开稿件可见；仅自己可见的稿件也能读到基本字段）。
 *
 * 用法：node --experimental-strip-types tools/verify-archive-parts.ts <bvid> [--retry N]
 */
const bvid = process.argv[2];
if (!bvid || !/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
  console.error('用法：node --experimental-strip-types tools/verify-archive-parts.ts <bvid> [--retry N]');
  process.exit(1);
}
const ri = process.argv.indexOf('--retry');
const maxTry = ri > 0 ? Number(process.argv[ri + 1]) : 6;

interface Page {
  cid?: number;
  page?: number;
  part?: string;
  duration?: number;
  from?: string;
}
interface View {
  bvid?: string;
  aid?: number;
  title?: string;
  state?: number;
  state_desc?: string;
  videos?: number;
  duration?: number;
  copyright?: number;
  attribute?: number;
  is_upower_exclusive?: boolean;
  pages?: Page[];
  rights?: Record<string, number>;
}

const line = (s = ''): void => console.log(s);

async function fetchView(): Promise<View | undefined> {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid!)}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      Referer: `https://www.bilibili.com/video/${bvid}`,
    },
  });
  const t = await r.text();
  try {
    const j = JSON.parse(t) as { code?: number; message?: string; data?: View };
    if (j.code !== 0) {
      line(`  B站 返回 code=${String(j.code)} message=${String(j.message)}`);
      return undefined;
    }
    return j.data;
  } catch {
    line(`  响应不是 JSON：${t.slice(0, 120)}`);
    return undefined;
  }
}

line('='.repeat(96));
line(`B站 侧真实分P 构成核验：${bvid}`);
line('='.repeat(96));

let v: View | undefined;
for (let i = 1; i <= maxTry; i++) {
  v = await fetchView();
  if (v && (v.pages?.length ?? 0) > 0) break;
  if (i < maxTry) {
    line(`  第 ${i} 次未取到分P 列表（稿件可能仍在处理），20s 后重试…`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

if (!v) {
  line('  取不到稿件信息（可能仍在审核/转码，或不可见）。稍后再试。');
  process.exit(1);
}

const pages = v.pages ?? [];
line(`  标题     : ${String(v.title ?? '')}`);
line(`  aid      : ${String(v.aid ?? '')}`);
line(`  state    : ${String(v.state ?? '')} ${v.state === 0 ? '(已过审/正常)' : v.state === -30 ? '(审批中)' : ''}`);
line(`  videos   : ${String(v.videos ?? '')}`);
line(`  分P 数   : ${pages.length}`);
line(`  总时长   : ${Math.round(Number(v.duration ?? 0) / 60)} 分钟`);
line(`  copyright: ${String(v.copyright ?? '')}（1=自制 2=转载）`);
line('');

line('  分P 列表（这是观众/你自己在稿件里看到的顺序）:');
line('  ' + '-'.repeat(92));
line('  序号   时长      标题');
line('  ' + '-'.repeat(92));
let totalSec = 0;
for (let i = 0; i < pages.length; i++) {
  const p = pages[i]!;
  const d = Number(p.duration ?? 0);
  totalSec += d;
  const mm = `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}`;
  line(`  P${String(i + 1).padEnd(5)} ${mm.padStart(8)}  ${String(p.part ?? '').slice(0, 62)}`);
}
line('  ' + '-'.repeat(92));
line(`  合计 ${pages.length} 个分P，时长合计 ${Math.floor(totalSec / 60)} 分钟`);
line('');

/* ---- 自动判定三类分P 是否齐全 ---- */
const titles = pages.map((p) => String(p.part ?? ''));
const hasFull = titles.some((t) => /完整版/.test(t));
const hasPure = titles.some((t) => /纯享版|无弹幕/.test(t));
const clipCount = titles.filter((t) => !/完整版|纯享版|无弹幕/.test(t)).length;
line('='.repeat(96));
line('构成判定');
line('='.repeat(96));
line(`  完整弹幕版分P : ${hasFull ? '\x1b[32m✓ 有\x1b[0m' : '\x1b[31m✗ 缺\x1b[0m'}`);
line(`  纯享版分P     : ${hasPure ? '\x1b[32m✓ 有\x1b[0m' : '\x1b[31m✗ 缺\x1b[0m'}`);
line(`  切片分P       : ${clipCount > 0 ? `\x1b[32m✓ ${clipCount} 个\x1b[0m` : '\x1b[31m✗ 0 个\x1b[0m'}`);
line('');
if (hasFull && hasPure && clipCount > 0) {
  line('  \x1b[32m⇒ 一个稿件里同时含「完整弹幕版 + 纯享版 + 切片」，符合预期。\x1b[0m');
} else {
  line('  \x1b[33m⇒ 构成不完整，见上面缺哪一类。\x1b[0m');
}
line('');
