/**
 * 验证「立即发布」修复：小片段试跑，确认稿件**不带 dtime**。
 *
 * 背景：第一次真实试跑用的是修复前启动的服务，8 个切片全被定到了 4 天后
 * （dtime=2026-09-26 23:35 … 09-27 14:16），尽管 publish.immediatePublish=true。
 * 根因是 `buildBiliupConfig` 读的是 `cfg` 而单切片路径没传 `immediate`，
 * 现在已修（显式传参），需要真跑一次确认。
 *
 * 用法：node --experimental-strip-types tools/run-trial2.ts <视频路径>
 */
import fs from 'node:fs';
import path from 'node:path';

const port = 3000;
const base = `http://127.0.0.1:${port}`;
const video = process.argv[2];
if (!video) {
  console.error('用法：node --experimental-strip-types tools/run-trial2.ts <视频绝对路径>');
  process.exit(2);
}
if (!fs.existsSync(video)) {
  console.error(`文件不存在：${video}`);
  process.exit(2);
}
const danma = video.replace(/\.[^.]+$/, '.xml');

const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
  csrf: string;
  config: { publish: { immediatePublish: boolean; multiPart: boolean; isOnlySelf: number; dailyLimit: number } };
};
console.log(`immediatePublish = ${boot.config.publish.immediatePublish}`);
console.log(`multiPart        = ${boot.config.publish.multiPart}`);
console.log(`isOnlySelf       = ${boot.config.publish.isOnlySelf}`);
console.log(`导入：${path.basename(video)}  (${(fs.statSync(video).size / 1048576).toFixed(0)} MB)`);

const res = await fetch(`${base}/api/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf },
  body: JSON.stringify({ videoPath: video, ...(fs.existsSync(danma) ? { danmaPath: danma } : {}) }),
});
const data = (await res.json()) as { taskId?: string; error?: string };
if (res.status !== 200 || !data.taskId) {
  console.error(`导入失败 HTTP ${res.status}：${data.error ?? ''}`);
  process.exit(1);
}
fs.writeFileSync('data/local-asr-test/trial2-task-id.txt', data.taskId, 'utf8');
console.log(`\n任务已创建：${data.taskId}（写入 data/local-asr-test/trial2-task-id.txt）`);
