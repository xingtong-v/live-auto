/**
 * 补充核对：形态A 的"条数变少"到底是**漏识别**还是**合并成一条**？
 * （clip[0] 上云端 26 条、本地 19 条，必须分清这两种情况才能说清提升/退步）
 *
 * 只看：总字数、互相覆盖不到的条数、以及本地结果的前若干条原文。
 *
 * 用法：node tools/form-a-detail.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const taskId = 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const outDir = path.join(ROOT_DIR, 'data', 'local-asr-test');
interface ClipRow {
  index: number;
  start: number;
  end: number;
  cutOutput?: string;
}
interface SrtRow {
  start: number;
  end: number;
  text: string;
}
const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8')) as { clips?: ClipRow[] };
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8')) as { segments?: Array<{ start: number; end: number; text: string }> };
const allSegs: SrtRow[] = (tr.segments ?? []).map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text ?? '') }));

const toSec = (t: string | undefined): number => {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/.exec(String(t));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : 0;
};
const parseSrt = (text: string): SrtRow[] => {
  const rows: SrtRow[] = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti]!.split('-->');
    rows.push({ start: toSec(a ?? ''), end: toSec(b ?? ''), text: lines.slice(ti + 1).join(' ').trim() });
  }
  return rows;
};
const norm = (s: string) => s.replace(/[\s，。！？、,.!?…~～"'"'（）()《》【】]/g, '');

for (const clip of clipsJson.clips ?? []) {
  const len = clip.end - clip.start;
  const cloud = allSegs.filter((s) => s.end > clip.start && s.start < clip.end).map((s) => ({ start: s.start - clip.start, end: s.end - clip.start, text: s.text }));
  const srtPath = path.join(outDir, `formA-clip${clip.index}.srt`);
  if (!fs.existsSync(srtPath)) {
    console.log(`clip[${clip.index}]：没有本地结果（先跑 tools/form-a-improvement.ts）`);
    continue;
  }
  const local = parseSrt(fs.readFileSync(srtPath, 'utf8'));

  const cc = cloud.reduce((a, r) => a + norm(r.text).length, 0);
  const lc = local.reduce((a, r) => a + norm(r.text).length, 0);
  console.log(`\n===== clip[${clip.index}]（${len.toFixed(0)}s）=====`);
  console.log(`云端：${cloud.length} 条 / ${cc} 字    本地：${local.length} 条 / ${lc} 字    字差 ${lc - cc > 0 ? '+' : ''}${lc - cc}`);

  /* 互相覆盖：把某一方的每条，按"前 3 字"去对方找 */
  const orphan = (a: SrtRow[], b: SrtRow[], label: string): void => {
    const miss: string[] = [];
    for (const r of a) {
      const k = norm(r.text).slice(0, 3);
      if (k.length < 2) continue;
      if (!b.some((x) => norm(x.text).includes(k))) miss.push(`${r.start.toFixed(1)}s 「${r.text.slice(0, 26)}」`);
    }
    console.log(`  ${label}：${miss.length} 条在对方那边找不到`);
    for (const m of miss.slice(0, 8)) console.log(`     ${m}`);
  };
  orphan(cloud, local, '云端有、本地没有');
  orphan(local, cloud, '本地有、云端没有');

  console.log('  本地前 12 条：');
  for (const r of local.slice(0, 12)) console.log(`     ${r.start.toFixed(1)}–${r.end.toFixed(1)}s  ${r.text.slice(0, 40)}`);
}

