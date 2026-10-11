/**
 * 每场复盘的计算（2026-10-13，优化清单 P1-5 的第一半）。
 *
 * 为什么抽出来：原来这套汇总逻辑写在 `src/server.ts` 的 `GET /api/task/:id/recap` 处理器里，
 * 而 P1-5 要求"场次结束自动推送复盘"。如果推送那边再算一遍，就会出现**两套口径**
 * （这个仓库已经因为"同一件事两处实现"踩过坑：备份、切片规划、批次账都收口过一次）。
 * 所以：计算在这里，服务端与推送都调它。
 *
 * 口径要点（与原实现逐字一致，改动需同步界面文案）：
 *   · 切片按 `status` 计数；评分分布只统计**有 score** 的切片；
 *   · 投稿按**批次账**汇总（投了几次 / 落地 / 失败 / 共缺几个分P）；
 *   · 表现取该场涉及 bvid 的**最新一行**合计（与「稿件表现」页同源）—— 同一稿件多个分P 只计一次；
 *   · 待办只列"需要人处理"的四类；干净时是空数组（不硬凑）。
 */
import type { Ledger } from './ledger.ts';
import { readBatches } from './publish-batches.ts';
import { fmtLocal } from './util.ts';

export interface RecapClip {
  index: number;
  title: string;
  score: number;
  status: string;
}

export interface Recap {
  task: {
    id: string;
    title: string;
    status: string;
    stage: string;
    createdAt: string;
    durationSec: number;
    when: string;
  };
  transcript: { asrAudioSeconds: number; asrEstimate: number; llmActual: number; llmCalls: number };
  clips: {
    total: number;
    byStatus: Record<string, number>;
    avgScore?: number;
    minScore?: number;
    maxScore?: number;
    top: RecapClip[];
  };
  publish: {
    batches: number;
    submitted: number;
    landed: number;
    failed: number;
    missingParts: number;
    detail: Array<{ at: string; kind: string; status: string; parts: number; landed: number; missing: string[] }>;
  };
  performance: { measured: number; view: number; like: number };
  todos: string[];
  note: string;
}

/** 计算一场的复盘（只读台账 + 表现数据；不碰 B站、不写任何东西） */
export function buildRecap(ledger: Ledger, taskId: string): Recap {
  const t = ledger.getTask(taskId);
  if (!t) throw new Error(`任务不存在：${taskId}`);
  const clips = ledger.getClips(taskId);

  const byStatus: Record<string, number> = {};
  for (const c of clips) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

  const scored: RecapClip[] = clips
    .filter((c) => typeof c.score === 'number')
    .map((c) => ({ index: c.index, title: c.title, score: c.score as number, status: c.status }));
  const scores = scored.map((c) => c.score).sort((a, b) => a - b);
  const avg = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : undefined;
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 3);

  const batches = readBatches(taskId, { logPath: ledger.publishLogPath });
  const submittedBatches = batches.filter((b) => b.status !== 'failed');
  const missingParts = batches.reduce((a, b) => a + b.missing.length, 0);

  /* 表现：本场切片涉及的 bvid 的**最新一行**合计（同一稿件只计一次） */
  const bvids = new Set(clips.map((c) => c.bvid).filter((x): x is string => Boolean(x)));
  const latest = new Map<string, { view: number; like: number; date: string }>();
  for (const row of ledger.readPerformance({ sinceMs: Date.now() - 400 * 86400_000 }) as Array<Record<string, unknown>>) {
    const bvid = String(row['bvid'] ?? '');
    if (!bvids.has(bvid)) continue;
    const date = String(row['date'] ?? '');
    const prev = latest.get(bvid);
    if (!prev || date >= prev.date) {
      latest.set(bvid, { view: Number(row['view'] ?? 0), like: Number(row['like'] ?? 0), date });
    }
  }
  let view = 0;
  let like = 0;
  for (const v of latest.values()) {
    view += v.view;
    like += v.like;
  }

  const todos: string[] = [];
  const stuckSub = clips.filter((c) => c.status === 'SUBMITTED');
  if (stuckSub.length) todos.push(`${stuckSub.length} 个切片仍是「已提交待确认」——超过 1 小时请去创作中心核对`);
  if (missingParts) todos.push(`投稿批次共缺 ${missingParts} 个分P（见「投稿批次」）`);
  if (byStatus['FAILED']) todos.push(`${byStatus['FAILED']} 个切片失败，可从失败阶段重跑`);
  if (t.status === 'FAILED') todos.push('整场任务失败：看错误报告后从失败阶段重跑（转写有缓存，重跑便宜）');

  return {
    task: {
      id: t.id,
      title: t.title,
      status: t.status,
      stage: t.stage,
      createdAt: t.createdAt,
      durationSec: t.source.totalDuration,
      when: fmtLocal(Date.parse(t.createdAt)),
    },
    transcript: {
      asrAudioSeconds: t.cost.asrAudioSeconds ?? 0,
      asrEstimate: t.cost.asrEstimate ?? 0,
      llmActual: t.cost.llmActual ?? 0,
      llmCalls: t.cost.llmCalls ?? 0,
    },
    clips: {
      total: clips.length,
      byStatus,
      ...(avg !== undefined ? { avgScore: avg } : {}),
      ...(scores.length ? { minScore: scores[0], maxScore: scores[scores.length - 1] } : {}),
      top,
    },
    publish: {
      batches: batches.length,
      submitted: submittedBatches.length,
      landed: batches.filter((b) => b.status === 'landed').length,
      failed: batches.filter((b) => b.status === 'failed').length,
      missingParts,
      detail: batches.map((b) => ({
        at: b.at,
        kind: b.kind,
        status: b.status,
        parts: b.titles.length,
        landed: b.landed.length,
        missing: b.missing,
      })),
    },
    performance: { measured: latest.size, view, like },
    todos,
    note: '本页只汇总本地台账与表现数据（只读）：切片状态、评分分布、投稿批次、播放点赞、需要你处理的事项。',
  };
}

/** 给推送用的**短版**（一行到三行，不要把人淹没） */
export function recapPushText(r: Recap): string {
  const parts = [
    `【${r.task.title}】`,
    `切片 ${r.clips.total} 个（已发布 ${r.clips.byStatus['PUBLISHED'] ?? 0} / 待确认 ${r.clips.byStatus['SUBMITTED'] ?? 0} / 失败 ${r.clips.byStatus['FAILED'] ?? 0}）`,
    `投稿 ${r.publish.batches} 次批次·落地 ${r.publish.landed}${r.publish.missingParts ? `·缺 ${r.publish.missingParts} 个分P` : ''}`,
  ];
  if (r.performance.measured) parts.push(`播放 ${r.performance.view} / 点赞 ${r.performance.like}`);
  if (r.todos.length) parts.push(`需要你处理 ${r.todos.length} 项`);
  return parts.join('\n');
}
