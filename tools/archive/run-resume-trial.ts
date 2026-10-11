/**
 * 验证「续传投稿」：导入 09-22 那场的一个片段，切片后**追加到 09-22 的已有稿件**。
 *
 * 目标稿件：aid=117314833877723 / bvid=BV13hhE6XEQM
 *           《甲主播来两下闪身步就好了2026.09.22》370 分钟，state=0（公开）
 *
 * ⚠️ 会产生真实费用与真实投稿：
 *   - 云端 ASR：59 分钟素材，约 ¥0.8（按实际单价 ¥0.79/小时）
 *   - 投稿：往**已公开的正式稿件**追加切片分P（isOnlySelf 对追加无意义，沿用原稿件的可见性）
 *
 * 用法：node --experimental-strip-types tools/run-resume-trial.ts [port]
 */
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] ?? 3000);
const base = `http://127.0.0.1:${port}`;

const VIDEO =
  'C:\\Users\\demo\\Downloads\\Bilibili\\甲主播\\2026-09-22 20-08-55-173 来两下闪身步就好了.flv';
const DANMA = VIDEO.replace(/\.[^.]+$/, '.xml');
const TARGET_AID = '117314833877723';

if (!fs.existsSync(VIDEO)) {
  console.error(`源文件不存在：${VIDEO}`);
  process.exit(2);
}

const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
  csrf: string;
  config: { publish: { multiPart: boolean; resumeAid: string; immediatePublish: boolean; isOnlySelf: number } };
};
console.log('='.repeat(92));
console.log('续传投稿验证');
console.log('='.repeat(92));
console.log(`目标稿件 aid   : ${TARGET_AID}（BV13hhE6XEQM，370 分钟，公开）`);
console.log(`配置 resumeAid : "${boot.config.publish.resumeAid}"${boot.config.publish.resumeAid === TARGET_AID ? '  \x1b[32m✓ 与目标一致\x1b[0m' : '  \x1b[31m✗ 不一致，请先改配置\x1b[0m'}`);
console.log(`multiPart      : ${boot.config.publish.multiPart}`);
console.log(`源素材         : ${path.basename(VIDEO)}（${(fs.statSync(VIDEO).size / 1048576).toFixed(0)} MB）`);
console.log(`弹幕           : ${fs.existsSync(DANMA) ? path.basename(DANMA) : '(无)'}`);

if (boot.config.publish.resumeAid !== TARGET_AID) {
  console.error('\n配置未生效（可能服务需热加载或未保存），已中止。');
  process.exit(1);
}

const res = await fetch(`${base}/api/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf },
  body: JSON.stringify({ videoPath: VIDEO, ...(fs.existsSync(DANMA) ? { danmaPath: DANMA } : {}) }),
});
const data = (await res.json()) as { taskId?: string; error?: string; durationSec?: number };
if (res.status !== 200 || !data.taskId) {
  console.error(`导入失败 HTTP ${res.status}：${data.error ?? ''}`);
  process.exit(1);
}
fs.writeFileSync('data/local-asr-test/resume-trial-task-id.txt', data.taskId, 'utf8');
console.log(`\n任务已创建：${data.taskId}（${Math.round((data.durationSec ?? 0) / 60)} 分钟素材）`);
console.log('流程：转写 → 选片 → 切片 → **带 vid=${aid} 追加进目标稿件**');
console.log(`\n关键日志（成功会打印）：已续传到稿件 aid=${TARGET_AID} / N 个分P`);
