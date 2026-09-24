/**
 * 真机 A/B：**热词到底有没有生效**（本地 Fun-ASR，零费用）。
 *
 * 为什么要这个：接线是单测能证明的（spec 里有没有 `hotwords` 字段），
 * 但"模型有没有因此改口"只有真跑才知道 —— 而这恰恰是用户唯一在乎的事
 * （他改了 `data/glossary.json`，转写结果到底变没变）。
 *
 * 设计：
 *  - 走**真实的 Transcriber**（provider=local-funasr），也就是流水线用的那条路，
 *    不另写一套 spec 组装（否则测的是探针，不是产品）；
 *  - 每次用**独立的临时缓存目录**：ASR 缓存键现在含热词指纹，
 *    但两次跑用同一个缓存目录仍要小心，独立目录最干净、也最能证明"真的重新推理了"；
 *  - 样本用项目里现成的 300 秒素材，基准用同窗口的**云端 fun-asr 输出**
 *    （`cloud-300s.srt`）—— 它就是本项目判定 ASR 好坏的那个参照。
 *
 * 观察点：目标词（钢蹦：云端 7 次、本地 09-23 只有 2 次）在 A/B 两次里的次数，
 * 以及两次相对云端的 CER（升还是降）。
 *
 * 零费用（本地推理），但占 GPU：约 2×2.5 分钟。
 *
 * 用法：node tools/local-asr/hotwords-ab.ts [--span 300] [目标词...]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { BiliLiveClient } from '../../src/api.ts';
import { AsrCache, Transcriber } from '../../src/asr.ts';
import { log as globalLog } from '../../src/logger.ts';
import { ROOT_DIR } from '../../src/util.ts';
import { cer } from './compare-asr.ts';

const ROOT = ROOT_DIR;
const OUT = path.join(ROOT, 'data', 'local-asr-test');
const spanArg = process.argv.indexOf('--span');
const SPAN = spanArg >= 0 ? Number(process.argv[spanArg + 1] ?? 300) : 300;
/* 样本与基准按窗口长度取名：项目里现成的是 300 秒那一对 */
const SAMPLE = path.join(OUT, `sample-${SPAN}s.flv`);
const REF = path.join(OUT, `cloud-${SPAN}s.srt`);
const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (TARGETS.length === 0) TARGETS.push('钢蹦');

const cfg = loadConfig().config;
cfg.asr.provider = 'local-funasr';
cfg.runtime.allowPaid = false;

/** 极简 SRT 解析（只取正文，用于 CER 与词频统计） */
function srtText(p: string): string {
  if (!fs.existsSync(p)) return '';
  return (fs.readFileSync(p, 'utf8').match(/^\d{2}:\d{2}:\d{2},\d{3} --> .*$/gm) ?? []).length >= 0
    ? fs
        .readFileSync(p, 'utf8')
        .split(/\r?\n\r?\n/)
        .map((b) => b.split(/\r?\n/).slice(2).join(''))
        .join('')
    : '';
}
const plain = (s: string): string => s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
const hits = (text: string, words: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const w of words) out[w] = (text.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
  return out;
};

const segmentsToSrt = (segs: Array<{ start: number; end: number; text: string }>): string =>
  segs
    .map((s, i) => {
      const t = (x: number): string => {
        const ms = Math.max(0, Math.round(x * 1000));
        const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
        const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
        const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`;
      };
      return `${i + 1}\n${t(s.start)} --> ${t(s.end)}\n${s.text}\n`;
    })
    .join('\n');

async function run(label: string, hotwords: string[]): Promise<{ srt: string; text: string; ms: number }> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `hw-ab-${label}-`));
  const client = BiliLiveClient.fromConfig(cfg, globalLog);
  const tr = new Transcriber({
    client,
    config: cfg,
    cache: new AsrCache(cacheDir, globalLog),
    hotwords: () => hotwords,
  });
  const t0 = Date.now();
  const res = await tr.transcribe({
    taskId: `hw-ab-${label}`,
    totalDuration: SPAN,
    media: {
      planCalls: () => [{ file: SAMPLE, inFileStart: 0, inFileEnd: SPAN, offset: 0, globalStart: 0, globalEnd: SPAN, windowIndex: 0 }],
      fileStat: (f) => ({ size: fs.statSync(f).size, updatedAt: Math.round(fs.statSync(f).mtimeMs) }),
    },
    allowPaid: false,
  });
  const ms = Date.now() - t0;
  const srt = segmentsToSrt(res.transcript.segments);
  fs.writeFileSync(path.join(OUT, `hw-${label}.srt`), srt, 'utf8');
  fs.rmSync(cacheDir, { recursive: true, force: true });
  return { srt, text: plain(srtText(path.join(OUT, `hw-${label}.srt`))), ms };
}

console.log('热词 A/B（本地 Fun-ASR，零费用）');
console.log(`样本：${path.relative(ROOT, SAMPLE)}  0–${SPAN}s`);
console.log(`目标词：${TARGETS.join('、')}`);
console.log(`基准：${path.relative(ROOT, REF)}（云端 fun-asr 同窗口输出）\n`);

const refText = plain(srtText(REF));
console.log(`基准云端文字 ${refText.length} 字；目标词命中 ${JSON.stringify(hits(refText, TARGETS))}\n`);

const A = await run('A-none', []);
console.log(`A 不带热词：${A.ms}ms，${A.text.length} 字，命中 ${JSON.stringify(hits(A.text, TARGETS))}`);
const B = await run('B-hot', TARGETS);
console.log(`B 带热词  ：${B.ms}ms，${B.text.length} 字，命中 ${JSON.stringify(hits(B.text, TARGETS))}\n`);

const cA = cer(refText, A.text).cer;
const cB = cer(refText, B.text).cer;
console.log('相对云端基准的 CER：');
console.log(`  A 不带热词：${(cA * 100).toFixed(2)}%`);
console.log(`  B 带热词  ：${(cB * 100).toFixed(2)}%   ${cB < cA ? '（更接近基准 ✓）' : cB > cA ? '（更远离基准 ✗）' : '（一样）'}`);
const sameText = A.text === B.text;
console.log(`\n两次输出是否完全一致：${sameText ? '是（热词没起作用！）' : '否（模型确实改口了）'}`);
const hA = hits(A.text, TARGETS);
const hB = hits(B.text, TARGETS);
console.log(`目标词命中数 A→B：${TARGETS.map((w) => `${w} ${hA[w]}→${hB[w]}`).join('，')}`);
