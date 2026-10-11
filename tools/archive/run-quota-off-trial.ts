/**
 * 验证「关闭每日额度」：把 09-22 那场从 CLIPPED 阶段重跑，看剩下的 5 个切片能否补投。
 *
 * 背景：上一轮该任务因 `dailyLimit=40` 被截断 ——
 *   「本批 14 个切片，但今日剩余额度 9 个，只处理前 9 个（其余保留待明日）」
 * 现在 `dailyLimit=0`（不限额），重跑应当处理**全部 14 个**候选，
 * 把新增的切片继续追加进同一个稿件（aid=117314833877723）。
 *
 * 费用：ASR 命中缓存（¥0）；`clips.json` 已存在 ⇒ 复用选片结果，不再调 LLM。
 *       只有切片（本地 ffmpeg）与上传（B站）动作。
 *
 * 用法：node --experimental-strip-types tools/run-quota-off-trial.ts [port]
 */
const taskId = 'manual-20260923094131-loby';
const port = Number(process.argv[2] ?? 3000);
const base = `http://127.0.0.1:${port}`;

const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
  csrf: string;
  config: { publish: { dailyLimit: number }; clip: { autoSelectTopN: number } };
};
console.log('='.repeat(92));
console.log('关闭额度后的补投验证');
console.log('='.repeat(92));
console.log(`任务              : ${taskId}`);
console.log(`publish.dailyLimit: ${boot.config.publish.dailyLimit}${boot.config.publish.dailyLimit === 0 ? '  ← 不限额' : ''}`);
console.log(`clip.autoSelectTopN: ${boot.config.clip.autoSelectTopN}`);
if (boot.config.publish.dailyLimit !== 0) {
  console.error('\n额度未关闭，先改 config.json 再跑。');
  process.exit(1);
}

const res = await fetch(`${base}/api/task/${taskId}/retry`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf },
  body: JSON.stringify({ fromStage: 'CLIPPED' }),
});
const data = (await res.json()) as Record<string, unknown>;
console.log(`\nHTTP ${res.status}`);
console.log(JSON.stringify(data, null, 2));
if (res.status !== 200) process.exit(1);
console.log('\n预期日志：不会再出现「今日剩余额度 N 个，只处理前 N 个」');
console.log('预期结果：剩余切片补齐后追加进稿件 aid=117314833877723');
