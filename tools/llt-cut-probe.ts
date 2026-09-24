/**
 * 排查：切片任务的 ffmpeg 参数到底是什么（字幕对不上的关键就在 `-ss/-to/-copyts/ass`）。
 *
 * 两块证据：
 *   ① biliLive-tools 的**任务详情**（GET /task/:id）：它记录了自己的参数与输出；
 *   ② biliLive-tools 的**日志**（GET /log）：ffmpeg 实际命令行会打在里面。
 *
 * 用法：node tools/llt-cut-probe.ts <cutTaskId> [<cutTaskId2> ...]
 */
import { BiliLiveClient } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';

const cfg = loadConfig().config;
const client = BiliLiveClient.fromConfig(cfg);
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('用法：node tools/llt-cut-probe.ts <cutTaskId> [...]');
  process.exit(2);
}

for (const id of ids) {
  console.log(`\n===== 任务 ${id} =====`);
  try {
    const d = (await client.taskDetail(id, { quiet: true })) as unknown as Record<string, unknown>;
    console.log('字段：', Object.keys(d).join(', '));
    for (const k of ['type', 'status', 'name', 'output', 'outputPath', 'pid', 'startTime', 'endTime']) {
      if (d[k] !== undefined) console.log(`  ${k} = ${JSON.stringify(d[k])}`);
    }
    const params = d['params'] ?? d['options'] ?? d['config'];
    if (params) console.log('  参数 =', JSON.stringify(params));
  } catch (e) {
    console.log(`  读任务详情失败：${(e as Error).message}`);
  }
}

console.log('\n===== biliLive-tools 日志里的 ffmpeg 线索 =====');
try {
  const logText = await client.getLogContent(400 * 1024, { quiet: true });
  const lines = String(logText).split(/\r?\n/);
  console.log(`日志 ${lines.length} 行，${(String(logText).length / 1024).toFixed(0)} KB`);
  const hits = lines.filter((l) => ids.some((id) => l.includes(id)) || /-copyts|subtitles=|assFilePath/.test(l));
  for (const l of hits.slice(-25)) console.log('  ' + l.slice(0, 400));
  if (hits.length === 0) console.log('  （日志里没抓到相关行）');
} catch (e) {
  console.log(`  读日志失败：${(e as Error).message}`);
}
