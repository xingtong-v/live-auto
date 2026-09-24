/**
 * 真实试跑：把一场历史录播导入，跑完整链路（转写 → 分析 → 切片 → 投稿）。
 *
 * ⚠️ 会产生真实费用与真实投稿：
 *   - 云端 ASR：32.5 分钟素材，实际约 ¥0.43
 *   - 投稿：isOnlySelf=1，仅自己可见
 * 用户已明确授权本次真实运行。
 *
 * 用法：node --experimental-strip-types tools/run-trial.ts [port]
 */
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] ?? 3000);
const base = `http://127.0.0.1:${port}`;

const VIDEO = 'C:\\Users\\demo\\Downloads\\Bilibili\\甲主播\\2026-09-18 00-09-09-432 电台汤圆人，太劲爆了.flv';
const DANMA = VIDEO.replace(/\.[^.]+$/, '.xml');

const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as { csrf: string };
console.log(`导入：${path.basename(VIDEO)}`);
console.log(`弹幕：${fs.existsSync(DANMA) ? path.basename(DANMA) : '(无)'}`);

const res = await fetch(`${base}/api/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf },
  body: JSON.stringify({
    videoPath: VIDEO,
    ...(fs.existsSync(DANMA) ? { danmaPath: DANMA } : {}),
  }),
});
const data = (await res.json()) as Record<string, unknown>;
console.log(`\nHTTP ${res.status}`);
console.log(JSON.stringify(data, null, 2));

if (res.status !== 200) process.exit(1);
const taskId = String(data['taskId']);
fs.writeFileSync('data/local-asr-test/trial-task-id.txt', taskId, 'utf8');
console.log(`\n任务已创建：${taskId}（已写入 data/local-asr-test/trial-task-id.txt）`);
console.log('接下来它会自动：转写 → 弹幕信号 → LLM 选片 → 切片 → 多分P 投稿（仅自己可见）');
