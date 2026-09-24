/**
 * 多分P投稿工具：把「完整版 + 纯享版 + 各切片」投进**同一个稿件**。
 *
 * 结构：`2 + N` 个分P
 *   P1 完整版（烧弹幕）· P2 纯享版（无弹幕原片）· P3…P(2+N) 各切片
 *
 * ## 为什么用这个而不是「每片一稿」
 *
 * **省每日投稿额度**：一次调用只占 1 个 `publish.dailyLimit` 额度，
 * 而每片一稿模式下 6 个切片要占 6 个。
 *
 * ## 代价（用之前必须知道）
 *
 * 多P稿件只有**一个** `dtime`，所有分P同一时刻上线 ——
 * 原来的「相邻切片错峰（clipGapSec）」在这种模式下不生效。
 *
 * ## 用法
 *
 *   # 预检：只检查素材/额度/幂等，不投稿
 *   node tools/publish-multipart.ts <taskId> --dry-run
 *
 *   # 实际投稿
 *   node tools/publish-multipart.ts <taskId>
 *
 *   # 指定主标题或发布时间
 *   node tools/publish-multipart.ts <taskId> --title "自定义标题" --first-publish "2026-09-23T09:00"
 *
 *   # 续传：把切片追加进 biliLive-tools 已投出的那个稿件（同一个稿件），而不是新建稿件
 *   node tools/publish-multipart.ts <taskId> --aid 117314833877723 --dry-run
 *   node tools/publish-multipart.ts <taskId> --no-resume        # 强制新建稿件
 */
import fs from 'node:fs';
import path from 'node:path';
import { Orchestrator } from '../src/daemon.ts';
import { absPath, archivePartCount, cleanLiveTitle, taskDateText } from '../src/publish.ts';
import { exists, fileSize, fmtBytes, fmtDuration, fmtLocal } from '../src/util.ts';

interface Args {
  taskId: string;
  dryRun: boolean;
  title?: string;
  firstPublish?: string;
  verbose: boolean;
  /** 续传目标稿件 aid（不给则用 config 的 publish.resumeAid；`--no-resume` 强制新建） */
  aid?: string;
  noResume: boolean;
}

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  for (const a of argv) if (!a.startsWith('--')) pos.push(a);
  const first = pos.find((p) => !/^-/.test(p));
  return {
    taskId: first ?? '',
    dryRun: argv.includes('--dry-run'),
    ...(get('--title') ? { title: get('--title')! } : {}),
    ...(get('--first-publish') ? { firstPublish: get('--first-publish')! } : {}),
    ...(get('--aid') ? { aid: get('--aid')! } : {}),
    noResume: argv.includes('--no-resume'),
    verbose: argv.includes('--verbose'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.taskId) {
    console.error(
      '用法: node tools/publish-multipart.ts <taskId> [--dry-run] [--title "..."] [--first-publish "YYYY-MM-DDTHH:mm"] [--aid <稿件aid>] [--no-resume]',
    );
    console.error('\n可用任务:');
    const o = new Orchestrator();
    o.logger.setConsole(false);
    for (const t of o.ledger.listTasks({ limit: 12 })) {
      console.error(`  ${t.id}  ${String(t.status).padEnd(11)} ${String(t.title).slice(0, 40)}`);
    }
    o.stop();
    process.exit(2);
  }

  const orch = new Orchestrator();
  orch.logger.setConsole(args.verbose);
  const cfg = orch.config;
  const task = orch.ledger.getTask(args.taskId);
  if (!task) {
    console.error(`找不到任务 ${args.taskId}`);
    process.exit(1);
  }

  console.log(`\x1b[1m多分P投稿${args.dryRun ? '（dry-run 预检）' : ''}\x1b[0m`);
  console.log('-'.repeat(66));
  console.log(`任务    : ${task.id}`);
  console.log(`标题    : ${cleanLiveTitle(task.title)}`);
  console.log(`模式    : multiPart=${cfg.publish.multiPart}  isOnlySelf=${cfg.publish.isOnlySelf}`);

  /* ---- 0. 先定投稿形态：续传（追加进 biliLive-tools 那个稿件）还是新建稿件 ----
     必须在**素材检查之前**定下来 —— 续传模式下 P1 完整版/P2 纯享版由目标稿件提供，
     本机没有它们的产物是正常的，不能因此判定「素材缺失」。 */
  const resumeAid = args.noResume ? '' : (args.aid ?? cfg.publish.resumeAid.trim());
  let clipIndexBase: number | undefined;
  let targetNote = '投稿形态: 新建稿件（完整版 + 纯享版 + 切片）';
  if (resumeAid) {
    targetNote = `投稿形态: 续传到已有稿件 aid=${resumeAid}（只追加切片分P）`;
    try {
      const archives = await orch.client.biliArchives({ page: 1, pageSize: 50 });
      const hit = archives.find((a) => String(a['aid'] ?? '') === String(resumeAid));
      if (hit?.bvid) {
        const n = archivePartCount(await orch.client.biliArchiveDetail(hit.bvid, { retry: 0 }));
        if (n !== undefined) clipIndexBase = n;
        targetNote += `\n         目标: ${hit.bvid}「${hit.title ?? ''}」已有 ${n ?? '?'} 个分P → 切片从 P${(n ?? cfg.publish.resumeClipIndexBase) + 1} 起编号`;
      } else {
        targetNote += `\n         稿件列表里没找到这个 aid，分P 编号基准用配置的 ${cfg.publish.resumeClipIndexBase}`;
      }
    } catch (e) {
      targetNote += `\n         读分P 数失败（编号基准用配置的 ${cfg.publish.resumeClipIndexBase}）：${(e as Error).message.slice(0, 80)}`;
    }
  }
  console.log(targetNote);

  /* ---- 1. 素材就绪检查 ---- */
  const clips = orch.ledger
    .getClips(task.id)
    .filter((c) => c.selected && c.status !== 'SKIPPED')
    .sort((a, b) => a.start - b.start);

  const fullPath = task.source.fullVideoPath;
  // 完整版候选：任务台账里的 fullVideoPath，或任务目录下 full/ 里的产物
  const fullDir = path.join(orch.ledger.taskDir(task.id), 'full');
  const findInFull = (kw: string): string | undefined => {
    if (!exists(fullDir)) return undefined;
    const f = fs.readdirSync(fullDir).find((n) => n.toLowerCase().includes(kw) && n.endsWith('.mp4'));
    return f ? path.join(fullDir, f) : undefined;
  };
  const p1 = fullPath && exists(fullPath) ? fullPath : findInFull('p1');
  const p2 = findInFull('p2') ?? findInFull('pure');

  console.log('');
  console.log('\x1b[1m素材清单\x1b[0m');
  const rows: Array<{ kind: string; label: string; file?: string }> = [];
  if (resumeAid) {
    console.log(`  \x1b[90m· 完整版/纯享版由目标稿件的既有分P 提供，本次不上传\x1b[0m`);
  } else {
    rows.push({ kind: 'P1 完整版', label: cfg.publish.fullPartTitle, ...(p1 ? { file: p1 } : {}) });
    if (cfg.publish.pureSource !== 'none') {
      rows.push({ kind: 'P2 纯享版', label: cfg.publish.purePartTitle, ...(p2 ? { file: p2 } : {}) });
    }
  }
  const base = resumeAid ? (clipIndexBase ?? cfg.publish.resumeClipIndexBase) : rows.length;
  clips.forEach((c, i) => rows.push({ kind: `P${base + i + 1} 切片`, label: c.title, file: c.cutOutput }));

  let totalBytes = 0;
  let missing = 0;
  for (const r of rows) {
    if (r.file && exists(r.file)) {
      const size = fileSize(r.file);
      totalBytes += size;
      console.log(`  ✓ ${r.kind.padEnd(10)} ${fmtBytes(size).padStart(9)}  ${String(r.label).slice(0, 34)}`);
    } else {
      missing++;
      console.log(`  \x1b[31m✗ ${r.kind.padEnd(10)} ${'缺失'.padStart(9)}  ${String(r.label).slice(0, 34)}\x1b[0m`);
    }
  }
  console.log(`  ${'合计'.padEnd(12)} ${fmtBytes(totalBytes).padStart(9)}  共 ${rows.length} 个分P`);
  if (missing > 0) {
    console.log(`\n\x1b[31m有 ${missing} 个分P素材缺失，无法投稿。\x1b[0m`);
    console.log('先补素材：完整版用 ffmpeg 压制（烧弹幕用 data/tasks/<id>/danmaku.ass），切片用 publisher.publishClips({skipUpload:true})');
    orch.stop();
    process.exit(1);
  }

  /* ---- 2. 额度检查 ----
   *
   * ⚠️ `dailyLimit === 0` 表示用户**显式关闭了每日上限**（见 config.ts 的说明），
   *    **不是**"上限为 0 个"。本工具第一版按 `dailyLimit - todayCount` 直接算，
   *    于是 `0 - 54 = -54` ⇒ 判定"额度不足"并拒绝投稿 —— 明明是不限额却被拦住。
   *    `src/publish.ts` 的 `publishClips` 早就处理了这种语义（`quotaOn = dailyLimit > 0`），
   *    这里必须对齐，否则"手动工具能不能投"与"自动流程能不能投"会给出相反答案。 */
  const todayCount = orch.ledger.todayPublishedCount();
  const quotaOn = cfg.publish.dailyLimit > 0;
  const remain = quotaOn ? cfg.publish.dailyLimit - todayCount : Number.POSITIVE_INFINITY;
  console.log('');
  console.log(
    `今日额度: 已用 ${todayCount} / 上限 ${quotaOn ? cfg.publish.dailyLimit : '不限'}   ` +
      `剩余 ${quotaOn ? Math.max(0, remain) : '不限'}（多分P 只占 1 个额度）`,
  );
  if (quotaOn && remain < 1 && !args.dryRun) {
    console.log(`\x1b[31m额度不足，无法投稿。\x1b[0m 可在界面「设置 → 发布策略 → 每日投稿上限」调高（或设为 0 表示不限），或等明天。`);
    orch.stop();
    process.exit(1);
  }

  /* ---- 3. 主标题 ---- */
  const mainTitle = args.title ?? `${cleanLiveTitle(task.title)} ${taskDateText(task)}`;
  console.log('');
  console.log(`主标题  : ${mainTitle}（${mainTitle.length} / 80 字符）`);

  /* ---- 4. 投稿 ---- */
  const uid = (await orch.client.primaryUid())?.uid;
  if (!uid) {
    console.error('\x1b[31m拿不到投稿用 uid（biliLive-tools 里没有已登录账号）\x1b[0m');
    orch.stop();
    process.exit(1);
  }

  const r = await orch.publisher.publishAsMultiPart({
    task,
    uid,
    clips,
    ...(resumeAid ? { resumeAid } : {}),
    ...(resumeAid && clipIndexBase !== undefined ? { clipIndexBase } : {}),
    ...(!resumeAid && p1 ? { fullVideoPath: p1 } : {}),
    ...(!resumeAid && p2 ? { pureVideoPath: p2 } : {}),
    mainTitleOverride: mainTitle,
    dryRun: args.dryRun,
    logger: orch.logger,
  });

  console.log('');
  if (r.warnings.length) {
    console.log('\x1b[33m警告：\x1b[0m');
    for (const w of r.warnings) console.log(`  · ${w}`);
  }
  if (!r.ok) {
    console.log(`\x1b[31m投稿失败：${r.error}\x1b[0m`);
    orch.stop();
    process.exit(1);
  }
  if (r.skipped) {
    console.log(`\x1b[33m${r.skipped}\x1b[0m`);
  } else {
    console.log('\x1b[32m✓ 投稿已提交\x1b[0m');
    console.log(`  稿件    : ${r.mainTitle}`);
    console.log(`  分P     : ${r.parts.length} 个`);
    for (const p of r.parts) console.log(`    ${p.title}`);
    if (r.dtime) console.log(`  定时发布: ${fmtLocal(r.dtime * 1000)}（距现在 ${fmtDuration(r.dtime - Math.floor(Date.now() / 1000))}）`);
    console.log(`  可见性  : ${cfg.publish.isOnlySelf === 1 ? '仅自己可见' : '公开'}`);
    console.log(`\n  bvid 会在 B站侧出现后由反查循环自动写回台账（也可以手动跑 confirmPendingPublished）。`);
  }
  orch.stop();
}

main().catch((e) => {
  console.error('\x1b[31m执行失败：\x1b[0m', (e as Error).message);
  if ((e as Error).stack) console.error((e as Error).stack!.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});

void absPath;
