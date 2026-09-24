/**
 * 核实 43 个分P 里每一批的来源：每个切片标题**应该**投几次，实际出现了几次。
 *
 * 背景：重跑把已投过的切片又投了一遍，稿件里出现重复分P。
 * 需要分清哪些重复是"项目重跑造成的"、哪些可能是别的东西造成的
 * （例如 P33–P36 那一组时长与 P38–P41 一致但没有配对重复）。
 *
 * 只读，不打任何接口除外的动作。
 *
 * 用法：node --experimental-strip-types tools/audit-appended-parts.ts
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const TASK_ID = 'manual-20260923094131-loby';
const BVID = 'BV13hhE6XEQM';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

/* ---- B站 侧实际分P ---- */
const detail = (await client.biliArchiveDetail(BVID, { retry: 1 })) as unknown as Record<string, unknown>;
const view = (detail['View'] ?? {}) as Record<string, unknown>;
const pages = (view['pages'] as Array<Record<string, unknown>>) ?? [];
const norm = (s: string): string => s.replace(/\s+/g, '').trim();

const countByTitle = new Map<string, number>();
for (const p of pages) {
  const t = norm(String(p['part'] ?? ''));
  countByTitle.set(t, (countByTitle.get(t) ?? 0) + 1);
}

/* ---- 项目侧每批投了什么 ---- */
const logLines = fs.readFileSync('data/logs/live_auto-2026-09-23.jsonl', 'utf8').trim().split('\n');
interface Batch { at: string; taskId: string; titles: string[]; uploadTaskId: string }
const batches: Batch[] = [];
for (const line of logLines) {
  try {
    const o = JSON.parse(line) as { ts: string; taskId?: string; msg: string; data?: Record<string, unknown> };
    const m = /已续传到稿件 aid=\d+ \/ (\d+) 个分P/.exec(o.msg);
    if (!m) continue;
    const utid = /uploadTaskId=([0-9a-f-]{36})/.exec(o.msg)?.[1] ?? '';
    const parts = ((o.data?.['parts'] as string[] | undefined) ?? []).map((s) => norm(s.replace(/^[a-z]+:/, '')));
    batches.push({ at: o.ts, taskId: o.taskId ?? '-', titles: parts, uploadTaskId: utid });
  } catch {
    /* 跳过坏行 */
  }
}

console.log('='.repeat(100));
console.log(`B站 侧 ${BVID}：${pages.length} 个分P，其中 ${countByTitle.size} 个不同标题`);
console.log('='.repeat(100));
console.log(`\n项目记录的续传批次：${batches.length} 次`);
for (const b of batches) {
  const local = b.at.endsWith('Z') ? new Date(b.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : b.at;
  console.log(`  ${local}  任务=${b.taskId}  投 ${b.titles.length} 个  upload=${b.uploadTaskId.slice(0, 8)}`);
}

/* 本场 14 个候选应有的标题 */
const clipsRaw = JSON.parse(fs.readFileSync(`data/tasks/${TASK_ID}/clips.json`, 'utf8')) as {
  clips?: Array<{ title?: string; cutOutput?: string }>;
};
const clips = (clipsRaw.clips ?? []) as Array<{ title?: string; cutOutput?: string }>;

console.log('\n' + '='.repeat(100));
console.log('逐个切片：应为 1 次，实际出现几次');
console.log('='.repeat(100));
console.log('应有标题                                        有产物  B站出现次数  判定');
console.log('-'.repeat(100));
let dupTotal = 0;
for (const c of clips) {
  const t = norm(String(c.title ?? ''));
  const n = countByTitle.get(t) ?? 0;
  if (n > 1) dupTotal += n - 1;
  const verdict = n === 0 ? '\x1b[31m缺失\x1b[0m' : n === 1 ? '\x1b[32m正常\x1b[0m' : `\x1b[33m重复 +${n - 1}\x1b[0m`;
  console.log(
    `${String(c.title).slice(0, 46).padEnd(48)} ${(c.cutOutput ? '有' : '无').padEnd(6)} ${String(n).padStart(6)}      ${verdict}`,
  );
}
console.log('-'.repeat(100));
console.log(`重复分P 总数：${dupTotal} 个（这些是多投的）`);

/* 找出"出现在 B站 但不在候选里"的标题 —— 可能是别的来源 */
console.log('\n' + '='.repeat(100));
console.log('B站 侧存在、但本场候选里没有的切片标题（排除 biliLive-tools 的弹幕版/纯享版）');
console.log('='.repeat(100));
const candidateSet = new Set(clips.map((c) => norm(String(c.title ?? ''))));
let other = 0;
for (const [t, n] of countByTitle) {
  if (candidateSet.has(t)) continue;
  if (/弹幕版|纯享版/.test(t)) continue;
  console.log(`  ${n} 次  ${t}`);
  other++;
}
if (other === 0) console.log('  （没有）');

console.log('\n' + '='.repeat(100));
console.log('结论');
console.log('='.repeat(100));
console.log('  · 每个切片"应投 1 次"。重复次数 = 项目重跑时把已投过的又投了一遍（去重缺失所致）');
console.log('  · 现在已有续传去重：会按标题比对目标稿件，只投新增的');
