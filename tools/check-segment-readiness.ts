/**
 * 分段工作流的就绪检查（只读，不调用付费接口）。
 *
 * 用户的实际流程：「我后面会设置每一个小时会自动切割一个小时的素材出来 然后你就要开始处理了」
 * 也就是说 biliLive-tools 会按小时产出分段文件，切片助手要能逐个吃下去。
 * 本工具检查这条链路上每个环节是否都成立：
 *
 *   ① 分段文件的**时长**（是否真按期望切分；用项目的 probeMedia，不猜）
 *   ② 分段边界是否**干净**（首尾时间戳、是否有重叠/缺口）
 *   ③ 项目的**分段识别**（discoverSegments / buildSegmentMap）能否正确排出顺序
 *   ④ **ASR 输入格式**是否支持 —— 项目把文件路径直接交给 biliLive-tools 的
 *      `/ai/subtitle`，它若不支持 ts 容器，整条链会在转写那一步失败（这步必须查清）
 *   ⑤ 当前 watch 配置下，**多久会被导入**（stableSec + intervalSec）
 *
 * 用法：node --experimental-strip-types tools/check-segment-readiness.ts [目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.ts';
import { discoverSegments, probeMedia } from '../src/media.ts';

const dir = process.argv[2] ?? 'C:\\Users\\demo\\Downloads\\Bilibili\\丙主播';
const line = (s = ''): void => console.log(s);

line('='.repeat(94));
line('分段工作流就绪检查');
line('='.repeat(94));
line(`  目录：${dir}`);

const cfg = loadConfig('config.json').config;
const w = cfg.import.watch;
line('');
line('① 当前 watch 配置（决定"多久会被自动导入"）');
line(`     enabled=${String(w.enabled)}  intervalSec=${String(w.intervalSec)}  stableSec=${String(w.stableSec)}  minSizeMB=${String(w.minSizeMB)}`);
line(`     ⇒ 文件停止写入后，最多 ${Number(w.intervalSec) + Number(w.stableSec)} 秒内会被导入（下一轮扫描 + 稳定确认）`);

/* ---- ② 逐个分段的时长与边界 ---- */
line('');
line('② 分段文件实测（项目的 probeMedia）');
const files = fs
  .readdirSync(dir)
  .filter((f) => /\.(ts|flv|mp4)$/i.test(f) && !/弹幕版/.test(f))
  .sort();
interface Row {
  name: string;
  mb: number;
  sec?: number;
  w?: number;
  h?: number;
  hasA?: boolean;
  size: number;
}
const rows: Row[] = [];
for (const f of files) {
  const p = path.join(dir, f);
  const size = fs.statSync(p).size;
  let sec: number | undefined;
  let ww: number | undefined;
  let hh: number | undefined;
  let hasA = false;
  try {
    const m = probeMedia(p) as unknown as Record<string, unknown>;
    const d = m['duration'];
    if (typeof d === 'number' && Number.isFinite(d)) sec = d;
    if (typeof m['width'] === 'number') ww = m['width'] as number;
    if (typeof m['height'] === 'number') hh = m['height'] as number;
    hasA = Boolean(m['hasAudio'] ?? m['audioCodec']);
  } catch (e) {
    line(`     ! ${f} probeMedia 抛错：${(e as Error).message.slice(0, 80)}`);
  }
  rows.push({ name: f, mb: size / 1024 / 1024, ...(sec !== undefined ? { sec } : {}), ...(ww !== undefined ? { w: ww } : {}), ...(hh !== undefined ? { h: hh } : {}), hasA, size });
  const dur = sec !== undefined ? `${(sec / 60).toFixed(2)} 分钟` : '(取不到时长!)';
  line(`     ${f}`);
  line(`        ${dur.padEnd(14)} ${(size / 1024 / 1024).toFixed(1)} MB  ${String(ww ?? '?')}x${String(hh ?? '?')}  音轨=${hasA ? '有' : '无'}`);
}

/* ---- ③ 与期望的分段粒度对比 ---- */
line('');
line('③ 分段粒度 vs 期望');
const rec = JSON.parse(fs.readFileSync(path.join(process.env['APPDATA'] ?? '', 'biliLive-tools', 'appConfig.json'), 'utf8')) as {
  recorder?: { segment?: string };
  recorders?: Array<{ channelId?: string; segment?: string; remarks?: string }>;
};
line(`     biliLive-tools 全局 recorder.segment = ${JSON.stringify(rec.recorder?.segment)}（分钟）`);
for (const r of rec.recorders ?? []) {
  line(`     房间 ${String(r.channelId)} (${String(r.remarks)}) segment = ${JSON.stringify(r.segment)}`);
}
const segs = rows.filter((r) => r.sec !== undefined).map((r) => r.sec! / 60);
if (segs.length > 0) {
  const avg = segs.reduce((a, b) => a + b, 0) / segs.length;
  line(`     实测分段平均 ${avg.toFixed(2)} 分钟（${segs.length} 段）`);
  line('     ⚠ 若你期望的是"每小时一段"，而这里的数字远小于 60，说明该房间的 segment 需要改。');
}

/* ---- ④ 分段识别 ---- */
line('');
line('④ 项目的分段识别（同一场的多个分段能否被正确串起来）');
for (const r of rows.slice(0, 3)) {
  try {
    const segsFound = discoverSegments(path.join(dir, r.name));
    line(`     ${r.name} => discoverSegments 认为有 ${segsFound.length} 段`);
    for (const s of segsFound.slice(0, 4)) line(`        ${path.basename(String(s))}`);
  } catch (e) {
    line(`     ${r.name} => 抛错 ${(e as Error).message.slice(0, 70)}`);
  }
}

/* ---- ⑤ ASR 输入格式支持 ---- */
line('');
line('⑤ ASR 输入格式（这一环决定整条链能否跑通）');
line('     项目把文件路径直接交给 biliLive-tools 的接口，由它去调阿里云：');
line('       POST /ai/subtitle { file, modelId, startTime, endTime, offset, song }');
let asrOk: string;
try {
  /* 看 biliLive-tools 自己的实现里对输入做了什么（是否转码/是否挑扩展名） */
  const asarPath = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
  const s = fs.readFileSync(asarPath).toString('latin1');
  const hints: string[] = [];
  if (/subtitle[\s\S]{0,400}\.flv/.test(s)) hints.push('实现里出现 .flv 相关处理');
  if (/subtitle[\s\S]{0,400}\.ts/.test(s)) hints.push('实现里出现 .ts 相关处理');
  if (/ffmpeg[\s\S]{0,200}subtitle/i.test(s)) hints.push('实现里出现 ffmpeg 与 subtitle 的组合');
  asrOk = hints.length ? hints.join('；') : '（未从 asar 里看出对扩展名的特殊处理 —— 大概率是直接交给上游）';
} catch (e) {
  asrOk = `读取 asar 失败：${(e as Error).message.slice(0, 60)}`;
}
line(`     ${asrOk}`);
line('     ⇒ 若不确定，最可靠的验证是**对一段 ts 真跑一次转写**（见下方建议命令）。');
line('');
line('='.repeat(94));
line('建议');
line('='.repeat(94));
line('  · 要按"每小时一段"产出：把该房间的 segment 改成 60（它现在不是 60）。');
line('  · 想立刻验证 ts 能否被转写（会产生约 ¥0.05/分钟 的费用）：');
const sample = rows.find((r) => r.name.endsWith('.ts'));
if (sample) {
  line(`      node src/cli.ts video "${path.join(dir, sample.name)}" --title "分段素材转写验证"`);
}
line('');
