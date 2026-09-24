/**
 * 排查（第二步）：烧进视频的字幕，和转写的时间轴到底差多少？
 *
 * 做法：把 burn-*.ass 的每条字幕文本，去 transcript.json 里找**文本相同的那一段**，
 * 比较「ASS 里的时间」与「转写里的时间」的差 —— 这个差的分布就是答案：
 *   差 ≈ 0        → ASS 与转写一致（问题在上游：ASR 时间轴 或 源文件时间基准）
 *   差 = 常数 X   → 合并/切片时整体偏移了 X
 *   差 与 clip 起点有关 → 回退到"整场 ASS 直接烧"这类基准错误
 *
 * 用法：node tools/subtitle-offset-probe.mjs [taskId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const taskId = process.argv[2] ?? 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

const tr = readJson(path.join(taskDir, 'transcript.json'));
const segs = (tr?.segments ?? []).map((s) => ({
  start: Number(s.start ?? s.begin ?? s.startTime),
  end: Number(s.end ?? s.finish ?? s.endTime),
  text: String(s.text ?? '').trim(),
}));
console.log('===== 转写 =====');
console.log(`段数=${segs.length}  时长=${tr?.audioSeconds ?? '?'}s  弹幕偏移=${tr?.danmakuOffset ?? '?'}`);
console.log(`source=${JSON.stringify(tr?.source ?? null)}`);
console.log(`gaps=${JSON.stringify(tr?.gaps ?? null)?.slice(0, 200)}`);

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

/** 在转写里找与给定文本最相近的一段（按公共子串长度粗匹配），返回其起止 */
const norm = (s) => s.replace(/[\s，。！？、,.!?…~～"'"'（）()《》【】]/g, '');
function findSeg(text) {
  const t = norm(text);
  if (t.length < 3) return null;
  let best = null;
  for (const s of segs) {
    const n = norm(s.text);
    if (!n) continue;
    // 命中：任一方向包含，或前缀 6 字相同
    const hit = n.includes(t) || t.includes(n) || (n.length >= 6 && t.length >= 6 && n.slice(0, 6) === t.slice(0, 6));
    if (!hit) continue;
    const score = Math.min(n.length, t.length);
    if (!best || score > best.score) best = { ...s, score };
  }
  return best;
}

for (const f of fs.readdirSync(taskDir).filter((x) => /^burn-.*\.ass$/.test(x))) {
  const rows = parseAss(path.join(taskDir, f));
  const diffs = [];
  const samples = [];
  for (const r of rows) {
    const hit = findSeg(r.text);
    if (!hit) continue;
    const d = Number((r.start - hit.start).toFixed(2));
    diffs.push(d);
    if (samples.length < 6) samples.push({ ass: r.start, tr: hit.start, d, text: r.text.slice(0, 24) });
  }
  console.log(`\n===== ${f} =====`);
  console.log(`字幕条数=${rows.length}  能在转写里对上的=${diffs.length}`);
  if (diffs.length) {
    const sorted = [...diffs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const uniq = [...new Set(diffs)];
    console.log(`时间差：中位数=${median}s  最小=${sorted[0]}  最大=${sorted[sorted.length - 1]}  不同取值=${uniq.length}`);
    console.log(`差值分布（前 12 个不同值）：${uniq.slice(0, 12).join(', ')}`);
    console.log('样例：');
    for (const s of samples) console.log(`  ASS ${s.ass.toFixed(2)}s  转写 ${s.tr.toFixed(2)}s  差 ${s.d}s  「${s.text}」`);
  }
}
