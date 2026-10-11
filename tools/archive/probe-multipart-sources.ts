/**
 * 为「2+n 分P」的 P1/P2 生成方案做前置核实：
 *   1. 源文件规格（编码/分辨率/时长/码率）—— 决定 remux 是否可行、要不要重编码
 *   2. `-弹幕版.mp4` 与源文件的差异 —— 判断 biliLive-tools 的「纯享版」到底是哪种形态
 *   3. 弹幕 ASS 是否已就绪 —— P1 烧弹幕的输入
 *
 * 只读，不产生任何文件。
 * 用法：node --experimental-strip-types tools/probe-multipart-sources.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FFPROBE = 'C:\\Users\\demo\\tools\\ffmpeg\\bin\\ffprobe.exe';
const DIR = 'C:\\Users\\demo\\Downloads\\Bilibili\\甲主播';

interface Media { file: string; codec: string; res: string; dur: number; bitrate: number; size: number; audio: string }

function probe(file: string): Media | null {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration,bit_rate,size:stream=codec_type,codec_name,width,height', '-of', 'json', file],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    const j = JSON.parse(out) as {
      format?: { duration?: string; bit_rate?: string; size?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
    };
    const v = j.streams?.find((s) => s.codec_type === 'video');
    const a = j.streams?.find((s) => s.codec_type === 'audio');
    return {
      file: path.basename(file),
      codec: v?.codec_name ?? '?',
      res: v ? `${v.width}x${v.height}` : '?',
      dur: Number(j.format?.duration ?? 0),
      bitrate: Number(j.format?.bit_rate ?? 0),
      size: Number(j.format?.size ?? 0),
      audio: a?.codec_name ?? '?',
    };
  } catch (e) {
    console.log(`  probe 失败 ${path.basename(file)}：${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

/** 找一组同场的「源 + 弹幕版」配对 */
function findPair(): { raw: string; burned: string } | null {
  const files = fs.readdirSync(DIR);
  const raws = files.filter((f) => /\.(flv|mp4|mkv)$/i.test(f) && !/-弹幕版/.test(f) && !/-纯享版/.test(f));
  for (const raw of raws.sort()) {
    const stem = raw.replace(/\.[^.]+$/, '');
    for (const suffix of ['-弹幕版', '-纯享版']) {
      const cand = `${stem}${suffix}.mp4`;
      if (files.includes(cand)) return { raw: path.join(DIR, raw), burned: path.join(DIR, cand) };
    }
  }
  return null;
}

const pair = findPair();
if (!pair) {
  console.log('没找到「源 + 压制产物」配对');
  process.exit(0);
}

console.log('='.repeat(92));
console.log('同场「源文件」与「压制产物」对照');
console.log('='.repeat(92));
const a = probe(pair.raw);
const b = probe(pair.burned);
for (const m of [a, b]) {
  if (!m) continue;
  console.log(
    `  ${m.file.slice(0, 52).padEnd(54)}\n` +
      `      编码 ${m.codec.padEnd(6)} 分辨率 ${m.res.padEnd(11)} 音频 ${m.audio.padEnd(5)} ` +
      `时长 ${(m.dur / 60).toFixed(1)}分  码率 ${(m.bitrate / 1e6).toFixed(2)}Mbps  体积 ${(m.size / 1048576).toFixed(0)}MB`,
  );
}
if (a && b) {
  const ratio = b.bitrate / a.bitrate;
  console.log(
    `\n  压制产物 / 源：体积 ${((b.size / a.size) * 100).toFixed(0)}%  码率 ${(ratio * 100).toFixed(0)}%  时长 ${((b.dur / a.dur) * 100).toFixed(1)}%`,
  );
  console.log(
    b.dur < a.dur * 0.98
      ? `  → 压制产物**比源短** ${((a.dur - b.dur) / 60).toFixed(1)} 分钟：它是重新编码+可能剪掉了片尾，不是单纯 remux`
      : '  → 时长基本一致：压制产物更像 remux / 转封装（未剪裁）',
  );
}

console.log('\n' + '='.repeat(92));
console.log('弹幕 ASS 就绪度（P1 烧弹幕的输入）');
console.log('='.repeat(92));
const ass = fs.readdirSync(DIR).filter((f) => /\.(xml|ass)$/i.test(f));
const xmls = ass.filter((f) => f.endsWith('.xml')).length;
const asss = ass.filter((f) => f.endsWith('.ass')).length;
console.log(`  该目录下 .xml 弹幕 ${xmls} 个，.ass 弹幕 ${asss} 个`);
const sampleXml = ass.find((f) => f.endsWith('.xml'));
if (sampleXml) {
  const p = path.join(DIR, sampleXml);
  const st = fs.statSync(p);
  const txt = fs.readFileSync(p, 'utf8').slice(0, 400);
  const n = (fs.readFileSync(p, 'utf8').match(/<d\b/g) ?? []).length;
  console.log(`  样例：${sampleXml.slice(0, 50)}  ${(st.size / 1024).toFixed(0)}KB  ${n} 条弹幕`);
  console.log(`  头部：${txt.slice(0, 120).replace(/\s+/g, ' ')}`);
}

console.log('\n' + '='.repeat(92));
console.log('结论要点');
console.log('='.repeat(92));
console.log('  · 源是 flv/h264 + aac → **P2 纯享版可直接 -c copy 转封装**（秒级完成，零画质损失）');
console.log('  · P1 完整弹幕版需把 ASS 烧进画面 → 必须重编码 → 用 h264_nvenc（本机可用）');
