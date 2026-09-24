/**
 * 投稿体检：把「这场直播到底投了几次、每次用什么标题、有没有重复与错配」摆到台面上。
 *
 * ## 为什么需要
 *
 * 实测踩到过：同一场直播在 1.5 小时内被投了 **3 次** ——
 *   20:47–20:58 五次单投（每片一个稿件）→ 21:17 一次 6 分P → 22:11 又一次 6 分P，
 * 而且最后一次反查到的 bvid 是**完整版录播**的（标题与多分P 主标题逐字相同）。
 * 这些在界面上完全看不出来：任务卡只显示「已发布 N」。
 *
 * 体检报告回答五个问题：
 *   1. 本场有几次上传任务（uploadTaskId），各自什么形态、什么时间、什么标题；
 *   2. 有没有**同一批切片被投了多次**（重复稿件）；
 *   3. 台账里的 bvid 是否可信（是否被多个切片共享、是否其实指向完整版）；
 *   4. 标题有没有硬伤（长度/占位/术语表错词/无意义标记/同场重名）；
 *   5. 稿件在 B站 侧是否可见（定时未到点的稿件查不到详情，这是正常的，不是失败）。
 *
 * 只读：不改变任何状态，也不提交任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Ledger } from './ledger.ts';
import type { AppConfig } from './config.ts';
import type { TaskRecord } from './types.ts';
import type { BiliLiveClient } from './api.ts';
import { GlossaryStore } from './glossary.ts';
import { checkClipTitles, type TitleProblem } from './title-check.ts';
import { fullVideoTitleCandidates, isArchiveGoneError, normalizeTitleForMatch } from './publish.ts';
import { DATA_DIR } from './util.ts';

export interface PublishSubmissionBatch {
  /** uploadTaskId；缺失时用 `at` 兜底 */
  key: string;
  at: string;
  /** 该批次的形态 */
  kind: 'single' | 'multipart' | 'unknown';
  parts: Array<{ clipIndex: number; title: string }>;
  dtime?: number;
  confirmedBvids: string[];
  /**
   * 该批次确认到的 bvid 是否其实指向**完整版录播**。
   *
   * 实测：多分P 稿件的主标题与完整版录播标题逐字相同，按主标题反查必然命中完整版，
   * 于是完整版的 bvid 被写到了这一批切片上 —— 报告必须把它标出来，
   * 否则台账里看起来"已确认"，实际那条 bvid 是别的稿件的。
   */
  bvidLooksFullVideo: boolean;
}

export interface PublishAuditReport {
  taskId: string;
  title: string;
  /** 稿件在 B站 侧的存在性与可见性（不可见通常是定时未到点） */
  archives: {
    listed: number;
    checked: Array<{ bvid: string; title?: string; visible: boolean; note?: string }>;
  };
  batches: PublishSubmissionBatch[];
  duplicates: {
    /** 同一 clipIndex 出现在多个批次里 = 重复投稿 */
    repeatedClips: Array<{ clipIndex: number; batches: number; titles: string[] }>;
    /** 一个 bvid 被多个切片共享（单投时说明写错了；多分P 时是正常的） */
    sharedBvids: Array<{ bvid: string; clipIndexes: number[]; likelyFullVideo: boolean; title?: string }>;
    /** 确认到的 bvid 其实指向完整版录播的批次 */
    fullVideoBvidBatches: Array<{ key: string; at: string; bvid: string }>;
    /** 总量：本场一共投出去多少次 */
    submissionCount: number;
  };
  titles: {
    errors: Array<{ index: number; problem: TitleProblem }>;
    warnings: Array<{ index: number; problem: TitleProblem }>;
    finalTitles: Array<{ index: number; title: string; finalTitle: string }>;
  };
  verdict: { level: 'ok' | 'warn' | 'bad'; summary: string; actions: string[] };
}

interface LogRow {
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

function readPublishLog(): LogRow[] {
  const p = path.join(DATA_DIR, 'publish-log.jsonl');
  try {
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as LogRow;
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

/**
 * 把投稿流水按 uploadTaskId 归组成批次。
 *
 * ⚠️ 老日志里 confirm 行**没有** uploadTaskId（只有 bvid），如果让它们各自成组，
 * 报告会从 7 个批次膨胀成 12 个，而且"投了几次"会被算错。
 * 所以这里把「无 uploadTaskId 的 confirm」就近并回**它之前那条包含同一 clipIndex
 * 且还没有 bvid 的 submit 批次** —— 这正是它语义上的归属。
 */
export function buildBatches(rows: LogRow[], taskId: string, fullVideoTitles: string[] = []): PublishSubmissionBatch[] {
  const fullNorm = new Set(fullVideoTitles.map(normalizeTitleForMatch).filter(Boolean));
  const mine = rows.filter((r) => r.taskId === taskId);

  const submitGroups = new Map<string, LogRow[]>();
  const orphanConfirms: LogRow[] = [];
  for (const r of mine) {
    if (r.action === 'submit') {
      const key = r.uploadTaskId ?? `submit:${r.at ?? ''}`;
      submitGroups.set(key, [...(submitGroups.get(key) ?? []), r]);
    } else if (r.action === 'confirm') {
      if (r.uploadTaskId) {
        submitGroups.set(r.uploadTaskId, [...(submitGroups.get(r.uploadTaskId) ?? []), r]);
      } else {
        orphanConfirms.push(r);
      }
    }
  }

  // 无 uploadTaskId 的 confirm：就近并入同 clipIndex 的 submit 批次
  const consumed = new Set<LogRow>();
  const ordered: Array<[string, LogRow[]]> = [...submitGroups.entries()].sort((a, b) =>
    String(a[1][0]?.at ?? '').localeCompare(String(b[1][0]?.at ?? '')),
  );
  for (const conf of orphanConfirms.sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const idx = conf.clipIndex;
    const target = ordered.find(([, list]) => {
      const hasSubmit = list.some((r) => r.action === 'submit' && r.clipIndex === idx);
      const notYetConfirmed = !list.some((r) => r.action === 'confirm');
      const isEarlier = String(list[0]?.at ?? '') <= String(conf.at ?? '');
      return hasSubmit && notYetConfirmed && isEarlier;
    });
    if (target) {
      target[1].push(conf);
      consumed.add(conf);
    }
  }

  const out: PublishSubmissionBatch[] = [];
  for (const [key, list] of submitGroups) {
    const submits = list.filter((r) => r.action === 'submit');
    const confirms = list.filter((r) => r.action === 'confirm');
    const at = list
      .map((r) => r.at ?? '')
      .filter(Boolean)
      .sort()[0];
    if (!at) continue;
    const parts = (submits.length ? submits : confirms).map((r) => ({
      clipIndex: typeof r.clipIndex === 'number' ? r.clipIndex : -1,
      title: r.title ?? '',
    }));
    const dtimes = [...new Set(submits.map((s) => s.dtime).filter((d): d is number => typeof d === 'number'))];
    // 确认标题若与完整版录播标题一致 → 这条 bvid 其实是完整版的
    const bvidLooksFullVideo = confirms.some((c) => fullNorm.has(normalizeTitleForMatch(c.title ?? '')));
    out.push({
      key,
      at,
      kind: submits.length === 0 ? 'unknown' : submits.length > 1 ? 'multipart' : 'single',
      parts,
      ...(dtimes[0] !== undefined ? { dtime: dtimes[0] } : {}),
      confirmedBvids: [...new Set(confirms.map((c) => c.bvid).filter((b): b is string => Boolean(b)))],
      bvidLooksFullVideo,
    });
  }
  // 完全没归组的 confirm（历史上没有对应 submit 的）也要露出来，不能吞掉
  for (const conf of orphanConfirms) {
    if (consumed.has(conf)) continue;
    out.push({
      key: `confirm:${conf.bvid ?? 'unknown'}`,
      at: conf.at ?? '',
      kind: 'unknown',
      parts: [{ clipIndex: typeof conf.clipIndex === 'number' ? conf.clipIndex : -1, title: conf.title ?? '' }],
      confirmedBvids: conf.bvid ? [conf.bvid] : [],
      bvidLooksFullVideo: fullNorm.has(normalizeTitleForMatch(conf.title ?? '')),
    });
  }
  return out.filter((b) => b.at).sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * 生成体检报告。
 *
 * `client` 可选：传了就去 B站 核对每个 bvid 的可见性与线上标题；
 * 不传则只做本地分析（离线可用）。
 */
export async function auditPublish(
  task: TaskRecord,
  ledger: Ledger,
  cfg: AppConfig,
  opts: { client?: BiliLiveClient; glossaryPath?: string } = {},
): Promise<PublishAuditReport> {
  const clips = ledger.getClips(task.id).sort((a, b) => a.index - b.index);
  const rows = readPublishLog();
  const batches = buildBatches(rows, task.id, fullVideoTitleCandidates(task));

  /* ---- 标题体检 ---- */
  const glossary = new GlossaryStore(opts.glossaryPath).load();
  const titleReport = checkClipTitles(
    clips.map((c) => ({ index: c.index, title: c.title, ...(c.degraded !== undefined ? { degraded: c.degraded } : {}) })),
    { glossary, ...(cfg.publish.defaultTitleSuffix ? { suffix: cfg.publish.defaultTitleSuffix } : {}) },
  );

  /* ---- 重复投稿：同一 clipIndex 出现在多个 submit 批次里 ---- */
  const submittedBatches = batches.filter((b) => b.kind !== 'unknown');
  const perClip = new Map<number, PublishSubmissionBatch[]>();
  for (const b of submittedBatches) {
    for (const p of b.parts) {
      if (p.clipIndex < 0) continue;
      perClip.set(p.clipIndex, [...(perClip.get(p.clipIndex) ?? []), b]);
    }
  }
  const repeatedClips = [...perClip.entries()]
    .filter(([, bs]) => bs.length > 1)
    .map(([clipIndex, bs]) => ({ clipIndex, batches: bs.length, titles: bs.map((b) => b.parts.find((p) => p.clipIndex === clipIndex)?.title ?? '') }))
    .sort((a, b) => a.clipIndex - b.clipIndex);

  /* ---- 共享 bvid：一个 bvid 挂到多个切片上 ---- */
  const byBvid = new Map<string, number[]>();
  for (const c of clips) {
    if (!c.bvid) continue;
    byBvid.set(c.bvid, [...(byBvid.get(c.bvid) ?? []), c.index]);
  }
  const fullTitles = new Set(fullVideoTitleCandidates(task).map(normalizeTitleForMatch));
  const suspiciousBatches = batches.filter((b) => b.bvidLooksFullVideo);
  const sharedBvids: PublishAuditReport['duplicates']['sharedBvids'] = [];
  for (const [bvid, idxs] of byBvid) {
    if (idxs.length < 2) continue;
    const titled = batches.flatMap((b) => (b.confirmedBvids.includes(bvid) ? b.parts.map((p) => p.title) : []));
    const looksFull = titled.some((t) => fullTitles.has(normalizeTitleForMatch(t)));
    sharedBvids.push({
      bvid,
      clipIndexes: idxs,
      likelyFullVideo: looksFull,
      ...(titled[0] ? { title: titled[0] } : {}),
    });
  }

  /* ---- B站 侧核对（可选） ---- */
  const checked: PublishAuditReport['archives']['checked'] = [];
  let listed = 0;
  if (opts.client) {
    try {
      const archives = await opts.client.biliArchives({ page: 1, pageSize: 100 });
      listed = archives.length;
      const known = new Map(archives.map((a) => [String(a.bvid), a]));
      const bvids = [...byBvid.keys()];
      // ⚠️ 必须**并发**查：详情接口对「定时未到点」的稿件会连试 3 次退避再失败，
      //    串行 5 个 bvid 就要 30 秒以上，界面会以为卡死了。
      const results = await Promise.all(
        bvids.map(async (bvid): Promise<PublishAuditReport['archives']['checked'][number]> => {
          const hit = known.get(bvid);
          if (hit) return { bvid, ...(hit.title ? { title: String(hit.title) } : {}), visible: true };
          try {
            // retry:0 —— 定时未到点的稿件必然查不到，退避重试只是白等 30 秒
            const d = await opts.client!.biliArchiveDetail(bvid, { retry: 0 });
            const t = (d as { title?: string }).title;
            return { bvid, ...(t ? { title: String(t) } : {}), visible: true, note: '不在稿件列表里，但详情可读' };
          } catch (e) {
            const msg = (e as Error).message;
            return {
              bvid,
              visible: false,
              note: isArchiveGoneError(e) ? '详情接口返回「不可见」——定时发布未到点或被删除' : `查询失败：${msg.slice(0, 80)}`,
            };
          }
        }),
      );
      checked.push(...results);
    } catch {
      /* B站 侧不可查询时降级为纯本地报告 */
    }
  }

  /* ---- 结论与可执行建议 ---- */
  const actions: string[] = [];
  let level: 'ok' | 'warn' | 'bad' = 'ok';
  if (repeatedClips.length > 0) {
    level = 'bad';
    actions.push(
      `本场有 ${repeatedClips.length} 个切片被投了多次（最多 ${Math.max(...repeatedClips.map((r) => r.batches))} 次）——去 B站 创作中心按投稿时间核对，删掉多余的稿件`,
    );
  }
  if (sharedBvids.some((s) => s.likelyFullVideo) || suspiciousBatches.length > 0) {
    level = 'bad';
    const bvids = [...new Set([...sharedBvids.filter((s) => s.likelyFullVideo).map((s) => s.bvid), ...suspiciousBatches.flatMap((b) => b.confirmedBvids)])];
    actions.push(
      `有批次的 bvid 指向**完整版录播**（${bvids.join('、') || '未知'}）—— 这些切片实际是否投递成功需要人工确认，` +
        `台账里的 bvid 不可信（多分P 主标题与完整版标题相同，按标题反查必然撞车）`,
    );
  }
  for (const s of sharedBvids.filter((x) => !x.likelyFullVideo)) {
    level = level === 'bad' ? 'bad' : 'warn';
    actions.push(`切片 #${s.clipIndexes.join('/')} 共用同一个 bvid ${s.bvid}：若是多分P 投稿则正常（同一稿件的多个分P），否则说明写错了`);
  }
  if (titleReport.errors.length > 0) {
    level = 'bad';
    actions.push(`标题有 ${titleReport.errors.length} 处硬伤，发布前必须修（详见标题体检）`);
  } else if (titleReport.warnings.length > 0) {
    if (level === 'ok') level = 'warn';
    actions.push(`标题有 ${titleReport.warnings.length} 处建议看一眼（截断/编号/重名等）`);
  }
  if (batches.filter((b) => b.kind === 'multipart').length > 1) {
    if (level !== 'bad') level = 'warn';
    actions.push('本场有多次「多分P」投稿记录 —— 多分P 路径目前不会判断本场是否已经投过，容易重复');
  }
  if (checked.some((c) => !c.visible)) {
    actions.push(
      `${checked.filter((c) => !c.visible).length} 个 bvid 在 B站 侧查不到详情（多为定时发布未到点）。这是正常的，等发布后再看`,
    );
  }

  const summary =
    level === 'bad'
      ? `发现 ${repeatedClips.length} 个重复投稿切片、${sharedBvids.length} 个可疑共享 bvid、${titleReport.errors.length} 处标题硬伤`
      : level === 'warn'
        ? `基本正常，但有 ${titleReport.warnings.length + actions.length} 项建议核对`
        : `未发现重复投稿与标题硬伤（本场 ${submittedBatches.length} 次投稿）`;

  return {
    taskId: task.id,
    title: task.title,
    archives: { listed, checked },
    batches,
    duplicates: {
      repeatedClips,
      sharedBvids,
      fullVideoBvidBatches: suspiciousBatches.map((b) => ({ key: b.key, at: b.at, bvid: b.confirmedBvids[0] ?? '' })),
      submissionCount: submittedBatches.length,
    },
    titles: {
      errors: titleReport.errors,
      warnings: titleReport.warnings,
      finalTitles: clips.map((c) => ({
        index: c.index,
        title: c.title,
        finalTitle: titleReport.byIndex.get(c.index)?.finalTitle ?? c.title,
      })),
    },
    verdict: { level, summary, actions },
  };
}

/** 纯文本渲染（CLI / 日志用） */
export function renderPublishAudit(r: PublishAuditReport): string {
  const L: string[] = [];
  L.push(`本场投稿体检：${r.verdict.level === 'bad' ? '不合格' : r.verdict.level === 'warn' ? '需核对' : '正常'}`);
  L.push(r.verdict.summary);
  L.push('');
  L.push(`投稿批次（${r.batches.length}）：`);
  for (const b of r.batches) {
    const when = new Date(b.at).toLocaleString('zh-CN', { hour12: false });
    const kind = b.kind === 'multipart' ? `${b.parts.length} 个分P` : b.kind === 'single' ? '单片' : '仅确认';
    const bvid = b.confirmedBvids.length ? `bvid ${b.confirmedBvids.join(',')}${b.bvidLooksFullVideo ? ' ⚠ 这是完整版录播的 bvid' : ''}` : '未反查到 bvid';
    L.push(`  ${when}  ${kind}  ${bvid}`);
    for (const p of b.parts) L.push(`      #${p.clipIndex}  ${p.title}`);
  }
  if (r.duplicates.repeatedClips.length) {
    L.push('');
    L.push('重复投稿：');
    for (const d of r.duplicates.repeatedClips) L.push(`  切片 #${d.clipIndex} 投了 ${d.batches} 次：${d.titles.join(' | ')}`);
  }
  if (r.duplicates.sharedBvids.length) {
    L.push('');
    L.push('共享 bvid：');
    for (const s of r.duplicates.sharedBvids) {
      L.push(`  ${s.bvid} → 切片 #${s.clipIndexes.join('/')}${s.likelyFullVideo ? '  ⚠ 疑似完整版录播' : ''}`);
    }
  }
  if (r.verdict.actions.length) {
    L.push('');
    L.push('建议：');
    for (const a of r.verdict.actions) L.push(`  · ${a}`);
  }
  return L.join('\n');
}
