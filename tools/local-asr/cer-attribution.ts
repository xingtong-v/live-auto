/**
 * CER 归因：把 8.16% 的差异拆开看，区分三类
 *   ① 真·同音/近音错字（有↔又、天↔点）
 *   ② 云端保留语气词与重复、本地省略（哎呀/哎/诶、忘忘词、永远幸福永远）
 *   ③ 分段粒度不同导致的边界归属差异
 *
 * 判定方式：去掉语气词与重复字后重算 CER；并逐条打印"只剩真错字"的对照。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SRT = 'data/local-asr-test/cloud-300s.srt';
const TR = 'data/tasks/manual-20260922191230-5ymu/transcript.json';

function normalize(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）《》【】…—·,.!?;:"'()<>[\]~`\-_/\\|@#$%^&*+=]/g, '')
    .toLowerCase();
}

/** 去掉语气词/填充词/叠字重复，只留实义内容 */
function stripFillers(s: string): string {
  return normalize(s)
    .replace(/(哎呀|哎|诶|唉|啊|哦|呃|嗯|那个|这个|就是|等等)+/g, '')
    .replace(/(.)\1+/g, '$1'); // 叠字压缩：忘忘词 → 忘词
}

function ed(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  let cur = new Array<number>(B.length + 1);
  for (let i = 1; i <= A.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[B.length]!;
}

// 云端 SRT
const srt = fs.readFileSync(SRT, 'utf8').replace(/\r/g, '');
const cloud: string[] = [];
for (const b of srt.split(/\n{2,}/)) {
  const m = /-->/.exec(b);
  if (!m) continue;
  const text = b.split('\n').filter((l) => !/-->/.test(l) && !/^\d+$/.test(l.trim())).join('');
  if (text.trim()) cloud.push(text.trim());
}
// 本地
const local = (JSON.parse(fs.readFileSync(TR, 'utf8')) as { segments: Array<{ text: string }> }).segments.map((s) => s.text.trim());

const cloudRaw = cloud.join('');
const localRaw = local.join('');
const cloudStrip = stripFillers(cloudRaw);
const localStrip = stripFillers(localRaw);

console.log('=== 差异归因 ===\n');
const dRaw = ed(normalize(cloudRaw), normalize(localRaw));
const dStrip = ed(cloudStrip, localStrip);
const refRaw = normalize(cloudRaw).length;
const refStrip = cloudStrip.length;
console.log(`  ① 原始 CER（含语气词/分段差异）  : ${((dRaw / refRaw) * 100).toFixed(2)}%   （${dRaw} / ${refRaw} 字）`);
console.log(`  ② 去掉语气词与叠字后的 CER       : ${((dStrip / refStrip) * 100).toFixed(2)}%   （${dStrip} / ${refStrip} 字）`);
console.log(`  ③ 字数差异：云端 ${refRaw} 字，本地 ${normalize(localRaw).length} 字，本地少 ${refRaw - normalize(localRaw).length} 字`);

// 逐条对齐后，只列"去了语气词仍然不同"的组
console.log('\n=== 去掉语气词后仍然不一致的组（这些才是真差异）===\n');
interface Cue { start: number; end: number; text: string }
const srtCues: Cue[] = [];
for (const b of srt.split(/\n{2,}/)) {
  const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(b);
  if (!m) continue;
  const toS = (h: string, mi: string, s: string, ms: string): number =>
    Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / (ms.length === 3 ? 1000 : 100);
  const text = b.split('\n').filter((l) => !/-->/.test(l) && !/^\d+$/.test(l.trim())).join('');
  srtCues.push({ start: toS(m[1]!, m[2]!, m[3]!, m[4]!), end: toS(m[5]!, m[6]!, m[7]!, m[8]!), text: text.trim() });
}
const trCues = (JSON.parse(fs.readFileSync(TR, 'utf8')) as { segments: Cue[] }).segments;

let realDiffs = 0;
for (const c of srtCues) {
  let best: Cue | undefined;
  let ov = 0;
  for (const l of trCues) {
    const o = Math.max(0, Math.min(c.end, l.end) - Math.max(c.start, l.start));
    if (o > ov) { ov = o; best = l; }
  }
  if (!best) continue;
  const a = stripFillers(c.text);
  const b = stripFillers(best.text);
  if (a === b) continue;
  const d = ed(a, b);
  if (d === 0) continue;
  realDiffs++;
  if (realDiffs <= 14) {
    console.log(`  [${c.start.toFixed(1)}s]`);
    console.log(`      云端: ${c.text}`);
    console.log(`      本地: ${best.text}`);
    console.log(`      去语气词后: 「${a}」 vs 「${b}」  编辑距离 ${d}`);
  }
}
console.log(`\n  共 ${realDiffs} 组存在实质差异（其余均为语气词/分段差异）`);
