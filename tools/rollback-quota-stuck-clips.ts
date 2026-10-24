/**
 * 把「被 B站 配额限流打成卡死」的切片复位成待投（2026-10-21 事故专用，按 taskId 通用）。
 *
 * ## 为什么需要这个工具
 *
 * 事故（任务 `auto-20261021030839-l3ti`）：B站 回 `投稿过于频繁，请稍后再试`（**没有秒数**），
 * 旧代码把它当成永久失败，于是：
 *   · 被拒的那几片被写成 **FAILED**；
 *   · 更糟的是被拒时**幂等指纹已经被登记**（提交拿到 taskId 后立刻登记，那时还不知道是被拒），
 *     于是这几片变成"看起来投过、实际什么都没创建"的脏状态。
 *
 * 修好后的代码不会再留下这种脏数据（配额限流 ⇒ fail-fast + 回退 CANDIDATE + 清指纹），
 * 但**事故当时已经写进台账的那几片不会自己好**：
 *   · 状态 SUBMITTED / FAILED —— 都不是"待投"，`publishClips` 要么拾不起来（SUBMITTED），
 *     要么拾起来立刻被幂等 1 命中（"幂等命中 ⇒ 跳过 ⇒ 又写回 SUBMITTED"），重投按钮点了没反应；
 *   · 脏指纹 —— 只要它还在，重投就永远是假动作。
 *
 * 本工具就是把这些片的**脏指纹清掉 + 状态复位成 CANDIDATE**（保留 `cutOutput`，切片不用重切），
 * 之后在界面上点「重跑投稿阶段」或「投稿这一片」就是真的重投。
 *
 * ## 安全边界（都是刻意的）
 *
 * 1. **绝不碰有 bvid 的片**：bvid 是"B站 上真的有这个稿件"的强证据，动它就可能造成重复稿件；
 * 2. **只处理 failReason 里带配额限流字样、或 SUBMITTED 但无 bvid 且 failReason 是配额限流的片**
 *    —— 不认识的失败原因一律跳过（本工具不是"一键重投"）；
 * 3. 默认**预演**，只打印将要做的改动；`--apply` 才真的写盘，且写盘前要求先停服务
 *    （服务进程持有台账内存副本，边跑边写会被它下次 flush 覆盖）。
 *
 * 用法：
 *   node tools/rollback-quota-stuck-clips.ts                                  # 预演（默认事故任务）
 *   node tools/rollback-quota-stuck-clips.ts --task auto-20261021030839-l3ti  # 指定任务
 *   node tools/rollback-quota-stuck-clips.ts --task <id> --apply              # 真的复位（先停服务！）
 */
import { clipFingerprint, ledger } from '../src/ledger.ts';
import type { ClipRecord } from '../src/types.ts';

const apply = process.argv.includes('--apply');
const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** 事故任务（2026-10-21 03:33–04:28 UTC，11:33–12:28 本地） */
const DEFAULT_TASK_ID = 'auto-20261021030839-l3ti';
const taskId = argOf('--task') ?? DEFAULT_TASK_ID;

/** 判据：failReason 里写着"配额限流"或 B站 那句原话 */
const QUOTA_HINT = /配额限流|投稿过于频繁|过于频繁|频率过快/;

/** 这些状态**不该**由本工具动：已发布的有 bvid（强证据），已取消的是人工决定 */
const SKIP_STATUS = new Set(['PUBLISHED', 'SKIPPED']);

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

const task = ledger.getTask(taskId);
if (!task) {
  console.error(`任务不存在：${taskId}（可用 --task <id> 指定）`);
  process.exit(1);
}

const clips = ledger.getClips(taskId);
console.log(bold(`任务 ${taskId}「${task.title}」，状态 ${task.status}/${task.stage}，共 ${clips.length} 片`));
console.log('');

interface Target {
  clip: ClipRecord;
  /** 该片**当前**登记的幂等指纹（按幂等 1 的同一套算法算出来再查；查不到就是空） */
  fingerprints: string[];
  reason: string;
}

const targets: Target[] = [];
for (const c of clips) {
  const failReason = c.failReason ?? '';
  const quotaHit = QUOTA_HINT.test(failReason);
  if (SKIP_STATUS.has(c.status)) continue;
  /* 有 bvid ⇒ 它在 B站 上是真的，绝不碰 */
  if (c.bvid) continue;
  /* 只认"配额限流"这一种失败原因；其余（标题违规、稿件锁定、真上传失败…）不归本工具管 */
  if (!quotaHit) continue;
  /* ★ 用与 `cutAndUploadClip` 幂等 1 **完全同一套**算法：
     sourceVideoId 取 recordingId ?? taskId，区间与标题取当前值。
     主键算得对不上的历史指纹（改过标题/区间）由 `clearFingerprintsFor(taskId, clipIndex)` 兜底清掉，
     这里只用于**显示**"到底有没有脏指纹"。 */
  const fp = clipFingerprint({
    sourceVideoId: task.recordingId ?? task.id,
    start: c.start,
    end: c.end,
    title: c.title,
  });
  const fps = ledger.findFingerprint(fp) ? [fp] : [];
  targets.push({
    clip: c,
    fingerprints: fps,
    reason: `状态 ${c.status}、无 bvid、failReason 命中配额限流`,
  });
}

if (targets.length === 0) {
  console.log('没有需要复位的切片：没有"带配额限流 failReason、无 bvid、非已发布"的片。');
  process.exit(0);
}

console.log(bold(`将要复位 ${targets.length} 片：`));
for (const t of targets) {
  const c = t.clip;
  console.log(
    `  · 片段 #${c.index}「${c.title}」` +
      `\n      现状：${dim(t.reason)}` +
      `\n      产物：${c.cutOutput ? dim('保留（不用重切）') : '\x1b[33m缺失（会被重新切片）\x1b[0m'}` +
      `\n      脏指纹：${t.fingerprints.length > 0 ? t.fingerprints.join(', ') : dim('（无）')}` +
      `\n      动作：清指纹 → 状态置 CANDIDATE（待投），清掉 submitTime/uploadTaskId/dtime`,
  );
}
console.log('');
console.log(
  dim(
    '复位后请在界面上点「重跑投稿阶段」（或对每片点「投稿这一片」）。\n' +
      '⚠️ 先确认 B站 创作中心里这几片**确实不存在**——本工具假定配额限流 = 什么都没创建（B站 的语义就是这样）。',
  ),
);

if (!apply) {
  console.log('');
  console.log(bold('预演结束，未改动任何数据。') + ` 确认无误后加 ${bold('--apply')} 真跑（**先停服务**）。`);
  process.exit(0);
}

/* ---- 真跑 ---- */
let clearedFp = 0;
for (const t of targets) {
  clearedFp += ledger.clearFingerprintsFor([{ taskId, clipIndex: t.clip.index }]);
  ledger.setClipStatus(taskId, t.clip.index, 'CANDIDATE', {}, {
    unset: ['bvid', 'publishedAt', 'dtime', 'submitTime', 'uploadTaskId', 'blockedByTombstone'] as Array<keyof ClipRecord>,
  });
  console.log(`已复位：片段 #${t.clip.index}（清指纹 ${t.fingerprints.length} 条）`);
}
ledger.flush();
console.log('');
console.log(bold(`完成：复位 ${targets.length} 片，清除脏指纹 ${clearedFp} 条。`));
console.log(
  dim(
    '下一步：重启服务 → 打开本场任务 → 点「重跑投稿阶段」。\n' +
      `若 B站 仍在配额窗口内，重跑会被新的配额限流逻辑**立即拦下**（只撞 1 次、留待投、发一条 warn 告警），不会再连撞。`,
  ),
);
