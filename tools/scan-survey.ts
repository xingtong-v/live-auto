/**
 * 侦察：录播到底散落在哪些目录。
 *
 * 用途：用户说「我还有别的主播的录播，没有显示」——先看清楚
 * ① biliLive-tools 自己的录制目录在哪；② 我们当前扫了哪些目录；
 * ③ 磁盘上还有哪些目录里躺着录播文件而没被扫到。
 *
 * 只读，不修改任何东西。
 *
 * 用法：node tools/scan-survey.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { listRecordings, recorderFolderFromConfig } from '../src/recordings.ts';
import { log } from '../src/logger.ts';

const cfg = loadConfig().config;
console.log('\x1b[1m录播目录侦察\x1b[0m');
console.log('─'.repeat(76));
console.log(`  import.scanDirs = ${JSON.stringify(cfg.import.scanDirs)}`);
console.log(`  import.maxDepth = ${cfg.import.maxDepth}`);
console.log(`  cfg.room.roomId = ${cfg.room.roomId}（录制历史只查了这一个房间）`);

const client = BiliLiveClient.fromConfig(cfg, log);
let recorderFolder: string | undefined;
try {
  const raw = await client.getConfig();
  recorderFolder = recorderFolderFromConfig(raw);
  console.log(`  biliLive-tools 录制目录 = ${recorderFolder ?? '(取不到)'}`);
  // 它自己的配置里通常还有房间列表
  const text = JSON.stringify(raw);
  const rooms = [...text.matchAll(/"room_?[iI]d"\s*:\s*"?(\d{4,})"?/g)].map((m) => m[1]);
  const uniq = [...new Set(rooms)];
  console.log(`  配置里出现过的房间号：${uniq.length ? uniq.join(', ') : '(无)'}`);
} catch (e) {
  console.log(`  读 biliLive-tools /config 失败：${(e as Error).message.slice(0, 100)}`);
}

console.log('\n当前清单扫到的分组：');
const list = await listRecordings(cfg, { client, probe: false, limit: 200 });
const byGroup = new Map<string, { n: number; dir: string }>();
for (const c of list) {
  const cur = byGroup.get(c.group) ?? { n: 0, dir: path.dirname(c.videoPath) };
  cur.n++;
  byGroup.set(c.group, cur);
}
for (const [g, v] of byGroup) console.log(`  ${g.padEnd(20)} ${String(v.n).padStart(3)} 场   ${v.dir}`);
if (byGroup.size === 0) console.log('  （空）');

/* ---- 磁盘普查：常见位置里有哪些目录装着录播文件 ---- */
const home = os.homedir();
const candidates = [
  path.join(home, 'Downloads'),
  path.join(home, 'Downloads', 'Bilibili'),
  path.join(home, 'Videos'),
  path.join(home, 'Desktop'),
  path.join(home, 'Documents'),
  ...(recorderFolder ? [recorderFolder, path.dirname(recorderFolder)] : []),
  'D:\\',
  'E:\\',
  'F:\\',
];
const VIDEO = /\.(flv|mp4|ts|mkv|m4s)$/i;

interface Found {
  dir: string;
  videos: number;
  newest: number;
  sample: string;
}
const found: Found[] = [];
const seen = new Set<string>();

function scanDir(dir: string, depth: number, maxDepth: number): void {
  const key = dir.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  let videos = 0;
  let newest = 0;
  let sample = '';
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth) scanDir(full, depth + 1, maxDepth);
      continue;
    }
    if (!VIDEO.test(e.name)) continue;
    try {
      const st = fs.statSync(full);
      if (st.size < 20 * 1024 * 1024) continue; // 太小的多半是碎片
      videos++;
      if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
        sample = e.name;
      }
    } catch {
      /* ignore */
    }
  }
  if (videos > 0) found.push({ dir, videos, newest, sample });
}

for (const c of candidates) {
  if (!c || !fs.existsSync(c)) continue;
  scanDir(c, 0, 3);
}

console.log('\n磁盘上装着录播（≥20MB）的目录：');
found.sort((a, b) => b.newest - a.newest);
const scannedPrefixes = [...byGroup.values()].map((v) => v.dir.toLowerCase());
for (const f of found) {
  const covered = scannedPrefixes.some((p) => p.startsWith(f.dir.toLowerCase()) || f.dir.toLowerCase().startsWith(p));
  console.log(
    `  ${covered ? '\x1b[32m已覆盖\x1b[0m' : '\x1b[33m未扫到\x1b[0m'}  ${String(f.videos).padStart(4)} 个  ${new Date(f.newest).toLocaleString('zh-CN', { hour12: false })}  ${f.dir}`,
  );
  if (!covered) console.log(`          \x1b[90m最近一个：${f.sample}\x1b[0m`);
}
console.log('\n提示：把「未扫到」的目录加进 import.scanDirs（界面里也能加），清单就会出现。');
