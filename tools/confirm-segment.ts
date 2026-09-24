/**
 * 再次确认「分段时间」——三路交叉验证，不靠单一来源。
 *
 * 1. **配置值**：读 biliLive-tools `/config` 里每个房间的 `segment`（单位：分钟）
 * 2. **代码依据**：在它的 asar 里重新读一遍换算行，确认 ×60
 * 3. **实测证据**：直接量 watch 目录里真实录制文件的时间跨度 ——
 *    同一场直播的相邻文件，起始时间差应当约等于 segment（分钟）。
 *    这是最终裁决：配置说得再好，也要看落盘文件的实际间隔。
 *
 * 用法：node --experimental-strip-types tools/confirm-segment.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

/* ---------------- 1. 配置值 ---------------- */
const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });
const raw = (await client.getConfig()) as Record<string, unknown>;

const flat: Array<[string, unknown]> = [];
const walk = (v: unknown, p: string): void => {
  if (v === null || typeof v !== 'object') {
    if (p) flat.push([p, v]);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => walk(x, `${p}[${i}]`));
    return;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, p ? `${p}.${k}` : k);
};
walk(raw, '');
const g = (k: string): unknown => flat.find(([kk]) => kk === k)?.[1];

console.log('='.repeat(96));
console.log('1. biliLive-tools 配置里的 segment（单位：分钟）');
console.log('='.repeat(96));
const rooms: Array<{ idx: string; roomId: string; remark: string; segment: string }> = [];
for (const [k, v] of flat) {
  const m = /^recorders\[(\d+)\]\.channelId$/.exec(k);
  if (!m) continue;
  const idx = m[1]!;
  const seg = String(g(`recorders[${idx}].segment`) ?? '?');
  const remark = String(g(`recorders[${idx}].remarks`) ?? '');
  rooms.push({ idx, roomId: String(v), remark, segment: seg });
  console.log(
    `  房间 ${String(v).padEnd(10)} ${remark.padEnd(16)} segment = ${seg.padStart(4)} 分钟` +
      `  → 即 ${(Number(seg) * 60 / 3600).toFixed(2)} 小时` +
      `  → 4 小时直播会切成 ${Math.max(1, Math.ceil(240 / Number(seg)))} 段`,
  );
}
console.log(`\n  对照：biliLive-tools 自带默认值 —— B站 "90" 分钟、斗鱼 "60" 分钟`);

/* ---------------- 2. 代码依据 ---------------- */
console.log('\n' + '='.repeat(96));
console.log('2. 代码依据（asar 里的换算行）');
console.log('='.repeat(96));
try {
  const asar = fs.readFileSync(
    'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar',
    'utf8',
  );
  for (const re of [/inputOptions\.push\("-d",\s*`\$\{this\.segment \* 60\}s`\)/g, /"-segment_time",\s*String\(this\.segment \* 60\)/g]) {
    for (const m of asar.matchAll(re)) {
      console.log(`  ✓ 命中：${m[0]}`);
    }
  }
  console.log('  → segment(分钟) × 60 = 秒，再交给 ffmpeg 的 -segment_time');
} catch (e) {
  console.log(`  读取 asar 失败：${(e as Error).message.slice(0, 80)}（不影响结论：配置文件与落盘证据已足够）`);
}

/* ---------------- 3. 实测证据：真实文件的起始时间差 ---------------- */
console.log('\n' + '='.repeat(96));
console.log('3. 实测证据：watch 目录里真实录制文件的起始时间间隔');
console.log('='.repeat(96));

/** 从文件名解析 `2026-09-22 21-07-58-627 标题.flv` 的时间戳 */
function parseStamp(fileName: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})-(\d{3})/.exec(fileName);
  if (!m) return null;
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]),
  );
}

const WATCH = 'C:\\Users\\demo\\Downloads\\Bilibili';
for (const sub of fs.readdirSync(WATCH, { withFileTypes: true })) {
  if (!sub.isDirectory()) continue;
  const dir = path.join(WATCH, sub.name);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(flv|mp4|ts|mkv)$/i.test(f) && !/-弹幕版|-纯享版/.test(f))
    .map((f) => ({ f, t: parseStamp(f) }))
    .filter((x): x is { f: string; t: Date } => x.t !== null)
    .sort((a, b) => a.t.getTime() - b.t.getTime());
  if (files.length < 2) {
    console.log(`\n  ── ${sub.name}：${files.length} 个可解析文件（不足以看间隔）`);
    continue;
  }
  /* ⚠️ 必须**按天分组**：目录里混着多天的录制，跨天的间隔（动辄几千分钟）
     会把统计彻底带偏 —— 第一版就是没分组，算出"中位数 21.6 分钟"这种无意义结论。 */
  const byDay = new Map<string, Array<{ f: string; t: Date }>>();
  for (const x of files) {
    const day = `${x.t.getFullYear()}-${x.t.getMonth() + 1}-${x.t.getDate()}`;
    const arr = byDay.get(day) ?? [];
    arr.push(x);
    byDay.set(day, arr);
  }
  console.log(`\n  ── ${sub.name}（${files.length} 个文件，跨 ${byDay.size} 天）`);
  const gaps: number[] = [];
  for (const [day, arr] of [...byDay.entries()].sort()) {
    if (arr.length < 2) continue;
    console.log(`      【${day}】${arr.length} 个文件`);
    for (let i = 1; i < arr.length; i++) {
      const gapMin = (arr[i]!.t.getTime() - arr[i - 1]!.t.getTime()) / 60000;
      gaps.push(gapMin);
      console.log(
        `        ${arr[i - 1]!.t.toTimeString().slice(0, 8)} → ${arr[i]!.t.toTimeString().slice(0, 8)}` +
          `   间隔 ${gapMin.toFixed(1)} 分钟`,
      );
    }
  }
  if (gaps.length) {
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const configured = rooms.find((r) => sub.name.includes(r.remark.slice(0, 2)) || r.remark.includes(sub.name.slice(0, 2)));
    console.log(
      `      \x1b[1m同日间隔 中位数 ${median.toFixed(1)} 分钟\x1b[0m（样本 ${gaps.length}）` +
        (configured ? `，该房间配置 segment=${configured.segment} 分钟` : '') +
        `  → ${configured && Math.abs(median - Number(configured.segment)) <= 8 ? '\x1b[32m与配置一致 ✓\x1b[0m' : '\x1b[33m与配置有差距，见下\x1b[0m'}`,
    );
  }
}

/* 文件本身的时长：分段时长的最直接证据（用 ffprobe 量，不猜） */
console.log('\n' + '='.repeat(96));
console.log('3b. 真实录制文件的**单体时长**（最直接的证据）');
console.log('='.repeat(96));
const FFPROBE = 'C:\\Users\\demo\\tools\\ffmpeg\\bin\\ffprobe.exe';
const { execFileSync } = await import('node:child_process');
for (const sub of fs.readdirSync(WATCH, { withFileTypes: true })) {
  if (!sub.isDirectory()) continue;
  const dir = path.join(WATCH, sub.name);
  const vids = fs
    .readdirSync(dir)
    .filter((f) => /\.(flv|mp4|ts|mkv)$/i.test(f) && !/-弹幕版|-纯享版/.test(f))
    .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .filter((x) => x.size > 20 * 1048576) // 太小的多半是断流碎片
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);
  if (vids.length === 0) {
    console.log(`\n  ── ${sub.name}：没有 >20MB 的文件可测`);
    continue;
  }
  console.log(`\n  ── ${sub.name}（按体积取前 ${vids.length} 个）`);
  for (const v of vids) {
    try {
      const out = execFileSync(
        FFPROBE,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path.join(dir, v.f)],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      );
      const sec = Number(out.trim());
      console.log(
        `      ${(sec / 60).toFixed(1).padStart(7)} 分钟  ${(v.size / 1048576).toFixed(0).padStart(5)} MB  ${v.f.slice(0, 46)}`,
      );
    } catch {
      console.log(`      (probe 失败)  ${v.f.slice(0, 46)}`);
    }
  }
}

console.log('\n' + '='.repeat(96));
console.log('结论');
console.log('='.repeat(96));
for (const r of rooms) {
  const seg = Number(r.segment);
  /* 4 小时按分段长度切：最后一段不足也算一段 */
  const per4h = Math.max(1, Math.ceil(240 / seg));
  console.log(
    `  ${r.remark.padEnd(16)} segment=${String(r.segment).padStart(4)} 分钟（≈${(seg / 60).toFixed(2)} 小时）` +
      ` ⇒ 4 小时直播约 ${per4h} 段；uploadNoDanmu 下最终约 ${per4h * 2} 个分P（弹幕版 ${per4h} + 纯享版 ${per4h}）`,
  );
}
