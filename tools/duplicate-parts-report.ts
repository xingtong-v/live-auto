/**
 * 重复分P 对账报告 —— 告诉用户在创作中心**具体删哪几个**。
 *
 * 为什么需要它：项目曾经重复追加过切片（成因见 docs/implementation-report.md §10.1），
 * 而 B站 **没有提供删除分P 的 API**（只有整体删除稿件 / 编辑稿件元信息），
 * 所以清理只能人工做。人工做就需要一份"保留哪个、删哪个"的清单，
 * 否则 43 个分P 里挑 15 个重复项纯靠肉眼比标题，很容易删错。
 *
 * 数据来源（两路交叉，避免单边误判）：
 *   ① B站 侧：`/bili/user/archive/:bvid` 的 `View.pages`（权威，就是观众看到的分P 列表）
 *   ② 项目侧：`data/publish-log.jsonl` 的 submit 记录（能知道"哪个任务、什么时候投的"）
 *
 * 判定规则：同一个**归一化标题**在 B站 侧出现 N 次（N>1）⇒ 重复 N-1 个。
 * 保留哪一个：按 B站 分P 顺序（`View.pages` 的 page 序）**保留第一个**，
 * 其余标为建议删除 —— 先投的通常是最初选中的那批，后投的是重跑时多出来的。
 *
 * 只读，不打任何写接口。
 *
 * 用法：
 *   node --experimental-strip-types tools/duplicate-parts-report.ts            # 扫描所有稿件
 *   node --experimental-strip-types tools/duplicate-parts-report.ts BV13hhE6XEQM  # 只看一个
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

const norm = (s: string): string => s.replace(/\s+/g, '').trim();
/** 去掉 `P12 ` 这类分P 序号前缀（同一内容可能一次带序号、一次不带） */
const stripIndex = (s: string): string => s.replace(/^P\d+\s*/i, '').trim();

interface SubmitRec {
  taskId?: string;
  clipIndex?: number;
  action?: string;
  at?: string;
  title?: string;
  uploadTaskId?: string;
  bvid?: string;
}

/* ---- 项目侧：publish-log ---- */
const logPath = 'data/publish-log.jsonl';
const subs: SubmitRec[] = [];
if (fs.existsSync(logPath)) {
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SubmitRec;
      if (r.action === 'submit') subs.push(r);
    } catch {
      /* 跳过坏行 */
    }
  }
}
/** 归一化标题 → 项目侧提交记录 */
const subsByTitle = new Map<string, SubmitRec[]>();
for (const s of subs) {
  const k = norm(stripIndex(String(s.title ?? '')));
  if (!k) continue;
  const arr = subsByTitle.get(k) ?? [];
  arr.push(s);
  subsByTitle.set(k, arr);
}

/* ---- B站 侧：稿件列表 ---- */
const only = process.argv[2];
let archives: Array<Record<string, unknown>> = [];
try {
  archives = (await client.biliArchives({ page: 1, pageSize: 100 })) as unknown as Array<Record<string, unknown>>;
} catch (e) {
  console.error(`读取稿件列表失败：${(e as Error).message}`);
  process.exit(1);
}
if (only) archives = archives.filter((a) => String(a['bvid']) === only);

const line = (s = ''): void => console.log(s);
line('='.repeat(104));
line('重复分P 对账报告（只读）');
line('='.repeat(104));
line(`稿件总数：${archives.length}${only ? `（已按 ${only} 过滤）` : ''}`);
line(`publish-log submit 记录：${subs.length} 条`);
line('');

let totalDup = 0;
let affectedArchives = 0;

for (const a of archives) {
  const bvid = String(a['bvid'] ?? '');
  const title = String(a['title'] ?? '');
  if (!bvid) continue;

  let pages: Array<Record<string, unknown>> = [];
  try {
    const detail = (await client.biliArchiveDetail(bvid, { retry: 1 })) as unknown as Record<string, unknown>;
    const view = (detail['View'] ?? detail) as Record<string, unknown>;
    const p = (view['pages'] ?? detail['pages']) as unknown;
    pages = Array.isArray(p) ? (p as Array<Record<string, unknown>>) : [];
  } catch (e) {
    line(`· ${bvid} 读取详情失败：${(e as Error).message.slice(0, 70)}`);
    continue;
  }
  if (pages.length === 0) continue;

  /* 按归一化标题分组，记下每个标题出现的分P 序号（1-based） */
  const groups = new Map<string, Array<{ page: number; raw: string }>>();
  for (let i = 0; i < pages.length; i++) {
    const raw = String(pages[i]!['part'] ?? pages[i]!['title'] ?? '');
    const k = norm(stripIndex(raw));
    if (!k) continue;
    const arr = groups.get(k) ?? [];
    arr.push({ page: i + 1, raw });
    groups.set(k, arr);
  }
  const dups = [...groups.entries()].filter(([, v]) => v.length > 1);
  if (dups.length === 0) continue;

  affectedArchives++;
  const dupCount = dups.reduce((acc, [, v]) => acc + v.length - 1, 0);
  totalDup += dupCount;

  line('─'.repeat(104));
  line(`稿件 ${bvid}  「${title.slice(0, 50)}」`);
  line(`  分P 总数 ${pages.length}，不同标题 ${groups.size}，**重复 ${dupCount} 个**`);
  line('');
  line('  保留   建议删除   标题                                     项目侧投放记录');
  line('  ' + '-'.repeat(100));
  for (const [k, v] of dups) {
    const keep = v[0]!;
    const recs = subsByTitle.get(k) ?? [];
    const recInfo = recs.length
      ? recs
          .map((r) => `${String(r.at ?? '').slice(5, 16)}@${String(r.taskId ?? '').slice(-4)}`)
          .join(' ')
      : '(publish-log 无记录)';
    for (let i = 0; i < v.length; i++) {
      const it = v[i]!;
      const isKeep = i === 0;
      line(
        `  ${(isKeep ? `P${keep.page}` : '     ').padEnd(7)} ${(isKeep ? '          ' : `P${it.page}`).padEnd(10)} ` +
          `${it.raw.slice(0, 42).padEnd(44)} ${isKeep ? '' : recInfo}`,
      );
    }
  }
  line('');
}

line('='.repeat(104));
line('汇总');
line('='.repeat(104));
if (totalDup === 0) {
  line('  ✓ 没有发现重复分P —— 稿件是干净的。');
} else {
  line(`  发现 ${totalDup} 个重复分P，分布在 ${affectedArchives} 个稿件里。`);
  line('');
  line('  处理方式（B站 没有删除分P 的 API，只能手工）：');
  line('    1. 打开创作中心 → 内容管理 → 稿件管理 → 找到对应稿件 → 编辑 → 分P 管理');
  line('    2. 按上表「建议删除」列勾选删除（每个标题保留第一个即可）');
  line('    3. 删除后 B站 分P 列表同样有延迟，不必反复刷新确认');
  line('');
  line('  注意：删除分P **不影响**已投切片的指纹幂等 —— 指纹在项目台账里，');
  line('        删掉重复项后重跑不会再把它们投回来（同内容指纹已登记）。');
}
line('');
