/**
 * 按 bvid 直接体检稿件的分P（2026-10-11，优化第二批 ① 的补齐）。
 *
 * 为什么需要它：自动检测只在**反查**时跑，而反查只覆盖"台账里还有切片"的稿件 ——
 * 场次被删掉之后，那个稿件的重复分P 就再也扫不到了（用户稿件 `BV1oWpG69Etu` 正是这种情况）。
 * 这个工具绕开台账，直接读稿件分P 列表，所以能查**任何** bvid。
 *
 * 用法：
 *   node tools/check-parts.ts BV1oWpG69Etu              # 只报告重复
 *   node tools/check-parts.ts BV1oWpG69Etu --all        # 连全部分P 列表一起打
 *   node tools/check-parts.ts BV1oWpG69Etu --record     # 把结果记进 publish-log（进「待办」）
 * 只读 B站 +（可选）写一条本地记录，不触发任何投稿动作。
 */
import { loadConfig } from '../../src/config.ts';
import { BiliLiveClient } from '../../src/api.ts';
import { findDuplicateTitles, recordDuplicateParts } from '../../src/publish-batches.ts';
import { log } from '../../src/logger.ts';

const args = process.argv.slice(2);
const bvids = args.filter((a) => a.startsWith('BV'));
const wantAll = args.includes('--all');
const wantRecord = args.includes('--record');
if (bvids.length === 0) throw new Error('用法：node tools/check-parts.ts <bvid…> [--all] [--record]');

const { config } = loadConfig();
const client = new BiliLiveClient({ baseUrl: config.bililive.baseUrl, passKey: config.bililive.passKey });

let totalIssues = 0;
for (const bvid of bvids) {
  try {
    const detail = await client.biliArchiveDetail(bvid);
    const view = (detail.View ?? detail) as { title?: string; pages?: Array<{ page?: number; part?: string; duration?: number }> };
    const pages = view.pages ?? [];
    const titles = pages.map((p) => String(p.part ?? ''));
    const dup = findDuplicateTitles(titles);
    console.log(`\n  ${bvid}  《${String(view.title ?? '').slice(0, 40)}》  ${pages.length} 个分P`);
    if (wantAll) for (const p of pages) console.log(`    P${String(p.page ?? '?').padStart(2)}  ${String(p.duration ?? '').padStart(4)}s  ${String(p.part ?? '').slice(0, 48)}`);
    if (dup.length === 0) {
      console.log('    ✅ 没有重复分P');
    } else {
      totalIssues += dup.length;
      for (const d of dup) {
        console.log(`    ⚠ 重复分P：${d.title}（${d.count} 份）—— 需要到创作中心删掉多余的，B站 没有删单个分P 的接口`);
        const at = pages.filter((p) => String(p.part ?? '').replace(/\s+/g, '').trim() === d.title.replace(/\s+/g, '').trim());
        console.log(`      位置：${at.map((p) => `P${p.page}`).join(' / ')}`);
      }
      if (wantRecord) {
        const wrote = recordDuplicateParts({ bvid, titles: dup.map((d) => `${d.title}（${d.count} 份）`) });
        console.log(`      ${wrote ? '已记入 publish-log（会出现在健康面板「待办」里）' : '记录已存在且未变化，未重复写'}`);
      }
    }
    void log;
  } catch (e) {
    console.log(`\n  ${bvid}  ❌ 读取失败：${(e as Error).message}`);
    totalIssues++;
  }
}
console.log(`\n  结果：${bvids.length} 个稿件，发现 ${totalIssues} 处问题。`);
process.exitCode = totalIssues === 0 ? 0 : 1;
