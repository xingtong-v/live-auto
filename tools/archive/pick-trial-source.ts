/**
 * 挑一个「便宜又完整」的试跑素材：有同名弹幕、非烧弹幕版、体积适中。
 *
 * 为什么需要挑：用户的录播是 biliLive-tools 按分段落的
 * （一场 4 小时直播会拆成几十个几分钟的片段），
 * 直接拿最大的跑一场要 ¥3-8 的 ASR 费、几小时时长。
 * 拿一个 30-60 分钟的完整片段，能完整体验链路而成本最低。
 *
 * 用法：node --experimental-strip-types tools/pick-trial-source.ts [最小MB] [最大MB]
 */
import fs from 'node:fs';
import path from 'node:path';

const MIN = Number(process.argv[2] ?? 5);
const MAX = Number(process.argv[3] ?? 400);
const ROOT = 'C:\\Users\\demo\\Downloads\\Bilibili';

interface Cand {
  file: string;
  mb: number;
  danma: string;
  burned: boolean;
  mtime: Date;
}

const all: Cand[] = [];
const rec = (dir: string, depth: number): void => {
  if (depth > 3) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      rec(full, depth + 1);
      continue;
    }
    if (!/\.(flv|mp4|mkv)$/i.test(e.name)) continue;
    const st = fs.statSync(full);
    const stem = full.replace(/\.[^.]+$/, '');
    const danma = fs.existsSync(`${stem}.xml`) ? '.xml' : fs.existsSync(`${stem}.ass`) ? '.ass' : '';
    all.push({ file: full, mb: st.size / 1048576, danma, burned: /-弹幕版/.test(e.name), mtime: st.mtime });
  }
};
rec(ROOT, 1);

const good = all.filter((c) => c.mb >= MIN && !c.burned && c.danma).sort((a, b) => a.mb - b.mb);
console.log(`扫描 ${ROOT}：共 ${all.length} 个视频文件`);
console.log(`其中有弹幕配对、非烧弹幕版、≥${MIN}MB：${good.length} 个\n`);

console.log('体积(MB)  弹幕   修改时间          文件');
for (const c of good) {
  console.log(
    `${c.mb.toFixed(0).padStart(8)}  ${c.danma.padEnd(5)}  ${c.mtime.toISOString().slice(0, 16).replace('T', ' ')}  ${path.basename(c.file)}`,
  );
}

const inRange = good.filter((c) => c.mb >= MIN && c.mb <= MAX);
console.log(`\n落在 ${MIN}-${MAX}MB 区间的 ${inRange.length} 个。`);
if (inRange.length > 0) {
  // 取体积最接近区间中点的一个：既完整又不会太贵
  const mid = (MIN + MAX) / 2;
  const best = [...inRange].sort((a, b) => Math.abs(a.mb - mid) - Math.abs(b.mb - mid))[0]!;
  console.log(`\n推荐试跑素材（最接近 ${mid.toFixed(0)}MB）：`);
  console.log(`  ${best.file}`);
  console.log(`  ${best.mb.toFixed(1)} MB   弹幕 ${path.basename(best.file).replace(/\.[^.]+$/, '')}${best.danma}`);
}
