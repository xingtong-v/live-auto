/**
 * 排查（收尾）：把问题量化到**用户真正看的那两个切片**里。
 *
 * 对每个切片窗口统计：
 *   · 窗口内有多少条烧进去的字幕、覆盖率多少（字幕在屏幕上的秒数 / 切片时长）
 *   · 最长的一次"没有字幕"是多久
 *   · 有没有「一句话被分配了 8 秒上限、但 ASR 给它的窗口长达几十秒」这种错位
 *
 * 用法：node tools/clip-subtitle-coverage-probe.mjs [taskId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const taskId = process.argv[2] ?? 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8'));
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8'));
const segs = (tr.segments ?? []).map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text ?? '') }));

function parseAss(p) {
  const rows = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!/^Dialogue:/.test(line)) continue;
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const toSec = (t) => {
      const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(t.trim());
      return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : 0;
    };
    rows.push({ start: toSec(parts[1]), end: toSec(parts[2]), text: parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').trim() });
  }
  return rows;
}
const burnFiles = fs.readdirSync(taskDir).filter((x) => /^burn-.*\.ass$/.test(x));
const all = burnFiles.flatMap((f) => parseAss(path.join(taskDir, f)));
/* 两个切片共用同一份整场 ASS，内容相同 —— 去重后按时间排序即可 */
const cues = [...new Map(all.map((c) => [`${c.start}|${c.text}`, c])).values()].sort((a, b) => a.start - b.start);

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
console.log(`任务 ${taskId}；烧录用 ASS 里的去重字幕 ${cues.length} 条（来自 ${burnFiles.length} 个 burn-*.ass，内容相同：两个切片共用整场字幕 + -copyts）`);

for (const c of clipsJson.clips ?? []) {
  const len = c.end - c.start;
  const inWin = cues.filter((x) => x.end > c.start && x.start < c.end);
  /* 覆盖率：字幕在屏幕上的并集时长（窗口内） */
  let covered = 0;
  let cursor = c.start;
  let longestGap = 0;
  let gapAt = 0;
  for (const x of inWin) {
    const s = Math.max(x.start, c.start);
    const e = Math.min(x.end, c.end);
    if (s > cursor) {
      const gap = s - cursor;
      if (gap > longestGap) {
        longestGap = gap;
        gapAt = cursor;
      }
    }
    covered += Math.max(0, e - Math.max(s, cursor));
    cursor = Math.max(cursor, e);
  }
  const tail = c.end - cursor;
  if (tail > longestGap) {
    longestGap = tail;
    gapAt = cursor;
  }
  console.log(`\nclip[${c.index}] ${fmt(c.start)} → ${fmt(c.end)}（${len.toFixed(1)}s）`);
  console.log(`  字幕 ${inWin.length} 条；覆盖 ${covered.toFixed(1)}s / ${len.toFixed(1)}s = ${((covered / len) * 100).toFixed(0)}%`);
  console.log(`  最长空档 ${longestGap.toFixed(1)}s（出现在 ${fmt(gapAt)}，即切片内第 ${(gapAt - c.start).toFixed(0)} 秒）`);
  const segInWin = segs.filter((s) => s.end > c.start && s.start < c.end);
  const long = segInWin.filter((s) => s.end - s.start > 12);
  console.log(`  窗口内 ASR 段 ${segInWin.length} 条，其中「时间戳明显离谱」的 ${long.length} 条：`);
  for (const s of long.slice(0, 5)) {
    console.log(`    ${fmt(s.start)} → ${fmt(s.end)}（${(s.end - s.start).toFixed(1)}s，只有 ${s.text.length} 个字）「${s.text.slice(0, 30)}」`);
  }
  console.log('  切片内前 8 条字幕（相对切片的秒数）：');
  for (const x of inWin.slice(0, 8)) {
    console.log(`    ${(x.start - c.start).toFixed(1)}s → ${(x.end - c.start).toFixed(1)}s  ${x.text.slice(0, 34)}`);
  }
}
