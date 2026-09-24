/**
 * 探查：biliLive-tools 录制历史里，同一场直播的多个分段是否共享 live_id。
 *
 * 为什么查这个：用户问"4 小时的直播被分成 4 个 1 小时文件，能不能只建一个稿件"。
 * 我们的触发器是**按 live_id 聚合**（`groupByLiveId`，注释写着"断流多段属于同一场次"），
 * 所以只要这 4 个文件共享同一个 live_id，它们就会进同一个任务 → 同一个稿件。
 * 这必须用真实数据确认，不能靠注释推断。
 *
 * 用法：node tools/liveid-probe.ts [房间号]
 */
import { BiliLiveClient } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';

const cfg = loadConfig().config;
const client = BiliLiveClient.fromConfig(cfg);
const roomId = process.argv[2] ?? cfg.room.roomId;

const pageSize = 40;
const res = await client.recordHistoryList({ roomId, platform: cfg.room.platform, page: 1, pageSize });
const items = (res as { records?: unknown[]; list?: unknown[]; total?: number }).records ?? (res as { list?: unknown[] }).list ?? [];
console.log(`房间 ${roomId}：录制历史返回 ${items.length} 条`);
console.log('');

interface Row {
  file: string;
  liveId: string;
  start: string;
  end: string;
  size: number;
}
const raw = items as Array<Record<string, unknown>>;
if (raw[0]) {
  /* 字段名必须从真实响应里读出来，不能猜 —— 上一版猜 filePath/fileSize，结果全空 */
  console.log('第一条记录的字段：', Object.keys(raw[0]).join(', '));
  console.log('样本：', JSON.stringify(raw[0]).slice(0, 600));
  console.log('');
}

const rows: Row[] = [];
for (const it of raw) {
  const file = String(it['filePath'] ?? it['file'] ?? it['path'] ?? it['video_file'] ?? '');
  rows.push({
    file: file.split(/[\\/]/).pop() ?? file,
    liveId: String(it['liveId'] ?? it['live_id'] ?? '(无)'),
    start: String(it['startTime'] ?? it['start_time'] ?? ''),
    end: String(it['endTime'] ?? it['end_time'] ?? ''),
    size: Number(it['fileSize'] ?? it['size'] ?? 0),
  });
}

/* 按 live_id 分组，看"一场"里到底有几个文件 */
const byLive = new Map<string, Row[]>();
for (const r of rows) {
  const list = byLive.get(r.liveId) ?? [];
  list.push(r);
  byLive.set(r.liveId, list);
}
console.log(`共 ${byLive.size} 个不同的 live_id：`);
for (const [liveId, list] of [...byLive.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const mb = list.reduce((a, x) => a + x.size, 0) / 1024 ** 2;
  console.log(`\n  live_id=${liveId}  文件 ${list.length} 个  合计 ${mb.toFixed(0)} MB`);
  for (const r of list.slice(0, 8)) console.log(`     ${r.file.slice(0, 60)}  ${r.start} → ${r.end}`);
  if (list.length > 8) console.log(`     …另有 ${list.length - 8} 个`);
}

const multi = [...byLive.values()].filter((l) => l.length > 1);
console.log(
  `\n结论：${multi.length > 0 ? `有 ${multi.length} 场是**多文件分段**（最多一场 ${Math.max(...multi.map((l) => l.length))} 个文件）→ 我们的 live_id 聚合会把它们并成同一个任务、同一个稿件` : '当前历史里没有多文件分段（每个 live_id 只有一个文件）'}`,
);
