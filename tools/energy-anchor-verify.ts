/**
 * 验证「能量锚点」在**真实那一场**上的效果。
 *
 * 拿真实转写 + 真源文件重新生成烧录用 ASS（force），打印：
 *   · 有多少段被重新定位
 *   · 之前贴着窗口起点的那几条现在落在哪
 *   · 两个切片的字幕覆盖率变化
 *
 * 用法：node tools/energy-anchor-verify.ts [taskId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildBurnAss } from '../src/subtitle-ass.ts';
import { log } from '../src/logger.ts';
import { ROOT_DIR } from '../src/util.ts';

log.setConsole(true);

const taskId = process.argv[2] ?? 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'ledger.json'), 'utf8'));
const src = (ledger.tasks?.[taskId]?.source?.rawFiles ?? [])[0];
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8'));
const segments = (tr.segments ?? []).map((s: { start: number; end: number; text: string }) => ({
  start: Number(s.start),
  end: Number(s.end),
  text: String(s.text ?? ''),
}));

const danmakuAss = fs.readdirSync(taskDir).find((f) => f.endsWith('.ass') && !/^burn-|^subtitle-/.test(f));
console.log(`源：${src}`);
console.log(`转写段：${segments.length}；弹幕 ASS：${danmakuAss ?? '(无)'}`);
console.log('正在生成（会解码整场音频算能量剖面，需要几秒）…');
const t0 = Date.now();
const r = buildBurnAss({
  outDir: taskDir,
  ...(danmakuAss ? { danmakuAssPath: path.join(taskDir, danmakuAss) } : {}),
  segments,
  videoPath: src,
  force: true,
  logger: log,
});
console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s；产物：${r.assPath ? path.basename(r.assPath) : '(无)'}；字幕 ${r.subtitleCount} 条`);
for (const w of r.warnings) console.log(`  警告：${w}`);

/* 解析产物，看关键段落落在哪 */
const toSec = (t: string) => {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(t.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : 0;
};
const cues: Array<{ start: number; end: number; text: string }> = [];
if (r.assPath) {
  for (const line of fs.readFileSync(r.assPath, 'utf8').split(/\r?\n/)) {
    if (!/^Dialogue:/.test(line)) continue;
    const parts = line.split(',');
    if (parts.length < 10) continue;
    cues.push({ start: toSec(parts[1]!), end: toSec(parts[2]!), text: parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').trim() });
  }
}
console.log(`\n产物里共 ${cues.length} 条字幕。之前出问题的那几条现在落在：`);
for (const key of ['如', '五雷正法', '研磨', '快忘了你', '我死了']) {
  const hit = cues.find((c) => c.text.includes(key));
  if (hit) console.log(`  「${hit.text.slice(0, 26)}」 ${hit.start.toFixed(1)}s → ${hit.end.toFixed(1)}s`);
}

/* 覆盖率（按切片窗口算） */
const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8'));
for (const c of clipsJson.clips ?? []) {
  const len = c.end - c.start;
  const inWin = cues.filter((x) => x.end > c.start && x.start < c.end).sort((a, b) => a.start - b.start);
  let covered = 0;
  let cursor = c.start;
  let longest = 0;
  for (const x of inWin) {
    const s = Math.max(x.start, c.start);
    const e = Math.min(x.end, c.end);
    if (s > cursor) longest = Math.max(longest, s - cursor);
    covered += Math.max(0, e - Math.max(s, cursor));
    cursor = Math.max(cursor, e);
  }
  longest = Math.max(longest, c.end - cursor);
  console.log(`\nclip[${c.index}] ${c.start.toFixed(1)}→${c.end.toFixed(1)}s：字幕 ${inWin.length} 条，覆盖 ${covered.toFixed(1)}s（${((covered / len) * 100).toFixed(0)}%），最长空档 ${longest.toFixed(1)}s`);
  for (const x of inWin.slice(0, 6)) console.log(`   ${(x.start - c.start).toFixed(1)}s → ${(x.end - c.start).toFixed(1)}s  ${x.text.slice(0, 34)}`);
}
