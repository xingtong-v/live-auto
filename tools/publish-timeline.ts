/**
 * 投稿流水时间线（只读）：把 publish-log.jsonl 按任务铺开成"每次投稿一行"，
 * 用来回答「这场到底投了几次、每次用的什么标题、有没有重复投」。
 *
 * 用法：node tools/publish-timeline.ts [taskId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/util.ts';

interface Row {
  taskId?: string;
  clipIndex?: number;
  action?: string;
  at?: string;
  uploadTaskId?: string;
  bvid?: string;
  title?: string;
  dtime?: number;
  error?: string;
}

const p = path.join(DATA_DIR, 'publish-log.jsonl');
if (!fs.existsSync(p)) {
  console.log('没有 publish-log.jsonl');
  process.exit(0);
}
const rows: Row[] = fs
  .readFileSync(p, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l) as Row;
    } catch {
      return {};
    }
  });

const taskId = process.argv[2];
const mine = rows.filter((r) => (taskId ? r.taskId === taskId : true));
console.log(`\x1b[1m投稿流水\x1b[0m  共 ${mine.length} 行${taskId ? `（taskId=${taskId}）` : '（全部任务）'}`);
console.log('─'.repeat(100));

const local = (iso?: string): string => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-');

// 按 uploadTaskId 归组：一次投稿必然是同一个 uploadTaskId 下的一组 submit
const groups = new Map<string, Row[]>();
for (const r of mine) {
  const key = r.uploadTaskId ?? (r.bvid ? `confirm:${r.bvid}` : `other:${r.action}:${r.at}`);
  groups.set(key, [...(groups.get(key) ?? []), r]);
}

for (const [key, list] of [...groups.entries()].sort((a, b) => String(a[1][0]?.at).localeCompare(String(b[1][0]?.at)))) {
  const submits = list.filter((r) => r.action === 'submit');
  const confirms = list.filter((r) => r.action === 'confirm');
  const fails = list.filter((r) => r.action === 'fail');
  const first = list[0]!;
  const dtimes = [...new Set(submits.map((s) => s.dtime).filter((d): d is number => typeof d === 'number'))];
  const label = submits.length
    ? `${submits.length} 个分P 一次投稿`
    : confirms.length
      ? `${confirms.length} 条确认`
      : fails.length
        ? `${fails.length} 条失败`
        : '其它';
  console.log(`\n\x1b[36m${local(first.at)}\x1b[0m  ${label}  \x1b[90m${key.slice(0, 40)}\x1b[0m`);
  if (dtimes.length) {
    console.log(`  定时发布：${dtimes.map((d) => new Date(d * 1000).toLocaleString('zh-CN', { hour12: false })).join(' , ')}`);
  }
  for (const s of submits) console.log(`    submit  #${s.clipIndex}  ${s.title ?? ''}`);
  for (const c of confirms) console.log(`    confirm #${c.clipIndex}  ${c.bvid}  ${c.title ?? ''}`);
  for (const f of fails) console.log(`    \x1b[31mfail    #${f.clipIndex}  ${f.error ?? ''}\x1b[0m`);
}

const uniqueUploads = new Set(mine.filter((r) => r.uploadTaskId).map((r) => r.uploadTaskId));
console.log(`\n\x1b[1m小结\x1b[0m：共 ${uniqueUploads.size} 次上传任务；` +
  `确认到 bvid 的切片 ${new Set(mine.filter((r) => r.bvid).map((r) => r.bvid)).size} 个；` +
  `失败 ${mine.filter((r) => r.action === 'fail').length} 条`);
