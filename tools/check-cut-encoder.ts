/**
 * 切片编码审计（2026-10-13）：看 biliLive-tools 最近几次切片**实际**用的编码器与参数，并把成片体积按分钟折算。
 *
 * 为什么需要它：切片编码器由**我们的 config.json**（`clip.ffmpegOptionsOverride`）决定 ——
 * 我们把 `ffmpegOptions` 原样传给 `/task/cut`，biliLive-tools 界面上那个 FFmpeg 预设下拉
 * 对"切片助手发起的切片"**不起作用**。所以"到底用的 x264 还是 NVENC"只能从它的日志里核实。
 *
 * 用法：node tools/check-cut-encoder.ts [--last 10]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const lastN = (() => {
  const i = argv.indexOf('--last');
  return i >= 0 ? Math.max(1, Number(argv[i + 1])) : 8;
})();

const logPath = path.join(os.homedir(), 'AppData', 'Roaming', 'biliLive-tools', 'logs', 'main.log');
if (!fs.existsSync(logPath)) {
  console.error(`找不到 biliLive-tools 日志：${logPath}\n（没装/换过路径？可以手动指定：BLT_LOG=<路径> node tools/check-cut-encoder.ts）`);
  process.exit(2);
}
const file = process.env.BLT_LOG || logPath;
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

interface Cut {
  at: string;
  output?: string;
  args?: string;
  encoder?: string;
  params: string[];
}

const cuts: Cut[] = [];
let pendingOutput: string | undefined;
for (const line of lines) {
  const at = /^\[([^\]]+)\]/.exec(line)?.[1] ?? '';
  const out = /Cut function call (.+?)\s*$/.exec(line)?.[1];
  if (out) {
    pendingOutput = out.trim();
    continue;
  }
  const cmd = /command: (.+)$/.exec(line)?.[1];
  if (!cmd || !/-c:v|-vcodec/.test(cmd)) continue;
  const args = cmd.trim();
  const encoder = /-c:v\s+(\S+)/.exec(args)?.[1] ?? /-vcodec\s+(\S+)/.exec(args)?.[1];
  const params: string[] = [];
  for (const key of ['-crf', '-cq', '-rc', '-b:v', '-preset', '-c:a', '-b:a']) {
    const m = new RegExp(`${key}\\s+(\\S+)`).exec(args);
    if (m) params.push(`${key} ${m[1]}`);
  }
  cuts.push({ at, output: pendingOutput, args, encoder, params });
  pendingOutput = undefined;
}

if (cuts.length === 0) {
  console.log('日志里没有找到带 -c:v 的切片命令（可能还没切过片，或日志被轮转过）。');
  process.exit(0);
}

const recent = cuts.slice(-lastN);
console.log(`\n=== 最近 ${recent.length} 次切片（来自 ${file}）===`);
let nvencCount = 0;
const perMinute: number[] = [];
for (const c of recent) {
  const isNvenc = (c.encoder ?? '').includes('nvenc');
  if (isNvenc) nvencCount++;
  let size = '';
  if (c.output && fs.existsSync(c.output)) {
    const mb = fs.statSync(c.output).size / 1024 ** 2;
    /* 从参数里估时长：有 -to/-ss 就算，否则跳过 */
    const to = Number(/-to\s+([\d.]+)/.exec(c.args ?? '')?.[1]);
    const ss = Number(/-ss\s+([\d.]+)/.exec(c.args ?? '')?.[1]);
    const dur = Number.isFinite(to) && Number.isFinite(ss) && to > ss ? (to - ss) / 60 : 0;
    if (dur > 0) perMinute.push(mb / dur);
    size = `${mb.toFixed(0)} MB${dur > 0 ? `（${(mb / dur).toFixed(1)} MB/分钟）` : ''}`;
  } else {
    size = '（文件已不在/被清理）';
  }
  console.log(
    `  ${c.at}  \x1b[${isNvenc ? '32' : '33'}m${(c.encoder ?? '?').padEnd(12)}\x1b[0m ` +
      `${c.params.join(' ').padEnd(52)} ${size}`,
  );
  if (c.output) console.log(`      ${path.basename(c.output)}`);
}

const avg = perMinute.length ? perMinute.reduce((a, b) => a + b, 0) / perMinute.length : 0;
console.log(
  `\n小结：最近 ${recent.length} 次里 NVENC ${nvencCount} 次 / 其它 ${recent.length - nvencCount} 次` +
    (avg ? `；平均 ${avg.toFixed(1)} MB/分钟 ⇒ 8 片 × 3 分钟 ≈ ${((avg * 24) / 1024).toFixed(2)} GB/场` : ''),
);
const latest = recent[recent.length - 1]!;
console.log(
  (latest.encoder ?? '').includes('nvenc')
    ? '\x1b[32m最新一次已经在用 NVENC（硬件编码）✅\x1b[0m'
    : `\x1b[33m最新一次仍是 ${latest.encoder ?? '?'}（软件编码）—— 检查 config.json 的 clip.ffmpegOptionsOverride\x1b[0m`,
);
