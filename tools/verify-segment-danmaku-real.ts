/**
 * 真实素材验证（**零付费**）：拿当前正在录的那场直播的分段 + 分段弹幕，
 * 走一遍分段识别 → 弹幕配对 → 合并，并用项目自己的解析器读回来核对时间轴。
 *
 * 不调用 ASR / LLM，不创建任务，不改台账。
 * 运行：node --experimental-strip-types tools/verify-segment-danmaku-real.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSegments } from '../src/media.ts';
import {
  listDanmakuCandidates,
  listSegmentDanmaku,
  mergeDanmakuXmlFiles,
  pairSegmentDanmaku,
  toSegmentLikes,
} from '../src/danmaku-merge.ts';
import { parseDanmakuXml } from '../src/danmaku.ts';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const DIR = process.argv[2] ?? 'C:\\Users\\demo\\Downloads\\Bilibili\\丁主播';

const files = fs
  .readdirSync(DIR)
  .filter((f) => /\.(ts|flv|mp4|mkv)$/i.test(f) && !/弹幕版|后处理/.test(f))
  .sort();
if (files.length === 0) {
  console.log('目录里没有可用的视频文件：' + DIR);
  process.exit(1);
}
// 取最近的一场（按名字里的时间戳）
const sample = path.join(DIR, files[files.length - 1]!);
console.log('样本（目录里最新的一段）:', files[files.length - 1]);

console.log('\n=== ① 分段识别 ===');
const segsRaw = discoverSegments(sample);
for (const s of segsRaw) {
  const st = fs.statSync(s);
  console.log('   ', path.basename(s), '|', (st.size / 1048576).toFixed(1), 'MB | mtime', new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false }));
}
console.log('   共', segsRaw.length, '段');

console.log('\n=== ② 弹幕候选（同目录、去时间戳前缀后同标题）===');
const likes = toSegmentLikes(segsRaw);
const cands = listDanmakuCandidates(likes);
for (const c of cands) {
  console.log('   ', path.basename(c.path), '| 文件名时间戳', c.startMs ? new Date(c.startMs).toLocaleString('zh-CN', { hour12: false }) : '(无)');
}
console.log('   清单层看到的分段弹幕数:', listSegmentDanmaku(segsRaw).length);

console.log('\n=== ③ 精确配对（含 biliLive-tools 映射查询）===');
const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });
// 用真实时长算 globalStart 需要探测；这里用规模占比近似不了 —— 直接交给 ffprobe
const { buildSegmentMap, findFfprobe } = await import('../src/media.ts');
const ffprobe = findFfprobe();
const map = buildSegmentMap(segsRaw, { ...(ffprobe ? { ffprobePath: ffprobe } : {}), maxSegments: 50 });
console.log('   分段时长映射：');
for (const s of map.segments) console.log('    第', s.globalStart.toFixed(0).padStart(5), '–', s.globalEnd.toFixed(0).padStart(5), '秒 |', path.basename(s.path));
console.log('   总时长:', map.totalDuration.toFixed(0), '秒');

const paired = await pairSegmentDanmaku(map.segments, {
  lookup: async (p) => {
    try {
      const ref = await client.danmaFileByVideoPath(p);
      const f = String(ref?.danmaFilePath ?? '').trim();
      return f && fs.existsSync(f) ? f : undefined;
    } catch {
      return undefined;
    }
  },
});
for (const m of paired.matches) {
  console.log(
    '   第', String(m.index + 1).padStart(2), '段 ←', path.basename(m.danmakuPath).padEnd(48),
    '偏移', String(Math.round(m.globalStart)).padStart(5), 's | 依据', m.how, m.driftSec !== undefined ? `| 差 ${m.driftSec}s` : '',
  );
}
console.log('   未配上:', paired.missing.length ? paired.missing.map((i) => i + 1).join('、') : '（无）');
for (const w of paired.warnings) console.log('   ⚠', w);

if (paired.matches.length === 0) {
  console.log('\n没有可合并的弹幕，结束（这本身就是结论）。');
  process.exit(0);
}

console.log('\n=== ④ 合并成一条全局时间轴 ===');
const out = path.join(os.tmpdir(), `segdm-real-${Date.now()}.xml`);
const merged = mergeDanmakuXmlFiles(
  paired.matches.map((m) => ({ danmakuPath: m.danmakuPath, offsetSec: m.globalStart })),
  out,
);
console.log('   各段条数:', merged.perPart.join(' / '), '共', merged.count, '条');
console.log('   输出:', out, `(${fs.statSync(out).size} 字节)`);

const parsed = parseDanmakuXml(fs.readFileSync(out, 'utf8'));
console.log('   解析回来:', parsed.items.length, '条 | 警告:', parsed.warnings.join('；') || '（无）');
const times = parsed.items.map((i) => i.time);
if (times.length) {
  const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  console.log('   时间轴范围:', fmt(Math.min(...times)), '→', fmt(Math.max(...times)), `（成片总长 ${fmt(map.totalDuration)}）`);
  const lastSegStart = map.segments[map.segments.length - 1]!.globalStart;
  console.log(
    '   ★ 最晚一条弹幕落在第',
    map.segments.filter((s) => s.globalStart <= Math.max(...times)).length,
    '段内（共', map.segments.length, '段）',
  );
  console.log(
    Math.max(...times) > lastSegStart
      ? '   ★ 结论：**最后一段的弹幕确实进来了**（修复前这一段会完全没有弹幕）'
      : '   ⚠ 结论：弹幕仍集中在靠前的分段，请检查配对',
  );
}

try {
  fs.rmSync(out, { force: true });
} catch {
  /* ignore */
}
