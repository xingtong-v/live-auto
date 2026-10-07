/**
 * 墓碑自动核对（命令行版）：**查不到的自动解除**。
 *
 * 为什么还要一个命令行版：定时核对在服务里（每日一次，见 `daemon.ts` 的 `perfTick`），
 * 但「服务正在跑任务、不方便重启」时也得能立刻跑一遍；排查时一条条看清楚
 * 「为什么留、为什么解除」也比界面上的汇总更有用。
 *
 * 默认是**预演**（只报告，不动台账）；确认真要解除再加 `--apply`。
 *
 * 用法：
 *   node tools/reconcile-tombstones.ts                 # 预演
 *   node tools/reconcile-tombstones.ts --apply         # 真的解除
 *   node tools/reconcile-tombstones.ts --apply --quiet # 只打印汇总与解除项
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { ledger } from '../src/ledger.ts';
import { log } from '../src/logger.ts';
import { reconcileTombstones } from '../src/tombstone-reconcile.ts';

const apply = process.argv.includes('--apply');
const quiet = process.argv.includes('--quiet');
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

const { config } = loadConfig();
const client = new BiliLiveClient({ baseUrl: config.bililive.baseUrl, passKey: config.bililive.passKey });

const before = ledger.listTombstones();
console.log(bold(`墓碑自动核对${apply ? '（--apply：会真的解除）' : '（预演，不改台账）'}`));
console.log(`  当前墓碑 ${before.length} 条；bvid 已知 ${before.filter((t) => t.bvid).length} 条，未反查到 ${before.filter((t) => !t.bvid).length} 条`);
console.log('');

const r = await reconcileTombstones({ ledger, client, logger: log, dryRun: !apply });

if (!quiet) {
  if (r.keptList.length) {
    console.log(bold(`  保留 ${r.keptList.length} 条：`));
    for (const k of r.keptList) console.log(`    · 「${k.title ?? '(无标题)'}」${k.bvid ? ` ${k.bvid}` : ''} —— ${k.why}`);
  }
}
if (r.releasedList.length) {
  console.log(bold(`  ${apply ? '已解除' : '将解除'} ${r.releasedList.length} 条（查不到旧稿件）：`));
  for (const x of r.releasedList) console.log(`    · 「${x.title ?? '(无标题)'}」${x.bvid ? ` ${x.bvid}` : ''} —— ${x.why}`);
}
for (const n of r.notes) console.log(`  ${n}`);

const after = ledger.listTombstones();
console.log('');
console.log(bold(`结果：核对 ${r.checked} 条 → 保留 ${r.kept}、${apply ? '解除' : '可解除'} ${r.released}、证据不足 ${r.unverified}；台账里墓碑 ${before.length} → ${after.length}`));
if (!apply && r.released > 0) console.log('  要真的解除，加 --apply 再跑一次。');
if (apply && r.released > 0) {
  console.log('  留痕：data/publish-log.jsonl 里有对应的 tombstone-release 记录（写明了解除依据）。');
}
