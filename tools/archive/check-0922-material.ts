/**
 * 检查 2026-09-22 那场直播的本地素材完整性 —— 决定「能否用它验证续传投稿」。
 *
 * 已知：B站 侧那场是 1 个稿件 aid=117314833877723（bvid=BV13hhE6XEQM），
 *       标题《甲主播来两下闪身步就好了2026.09.22》，**时长 370 分钟**。
 * 要往它追加切片，需要本地有该场的录制文件 + 弹幕 XML。
 *
 * 本工具只读：列出该场文件、量时长、算总长，并与稿件时长（370 分钟）对照。
 *
 * 用法：node --experimental-strip-types tools/check-0922-material.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FFPROBE = 'C:\\Users\\demo\\tools\\ffmpeg\\bin\\ffprobe.exe';
const WATCH = 'C:\\Users\\demo\\Downloads\\Bilibili';
/** 稿件的权威时长（分钟），来自 B站 侧 /bili/archives */
const ARCHIVE_MINUTES = 370;

const KEY = /来两下闪身步就好了/;

function dur(file: string): number {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

interface Row { file: string; sec: number; mb: number; hasXml: boolean; burned: boolean; mtime: Date }
const rows: Row[] = [];
for (const sub of fs.readdirSync(WATCH, { withFileTypes: true })) {
  if (!sub.isDirectory()) continue;
  const dir = path.join(WATCH, sub.name);
  for (const f of fs.readdirSync(dir)) {
    if (!KEY.test(f)) continue;
    if (!/\.(flv|mp4|ts|mkv)$/i.test(f)) continue;
    const full = path.join(dir, f);
    const st = fs.statSync(full);
    const stem = f.replace(/\.[^.]+$/, '');
    rows.push({
      file: full,
      sec: dur(full),
      mb: st.size / 1048576,
      hasXml: fs.existsSync(path.join(dir, `${stem}.xml`)),
      burned: /-弹幕版|-纯享版/.test(f),
      mtime: st.mtime,
    });
  }
}

console.log('='.repeat(104));
console.log('2026-09-22 那场（《来两下闪身步就好了》）的本地文件');
console.log('='.repeat(104));
console.log('时长(分)  体积(MB)  弹幕  类型        起始时间(文件名)              文件名');
console.log('-'.repeat(104));

rows.sort((a, b) => a.file.localeCompare(b.file));
let rawSec = 0;
let burnedSec = 0;
let withXml = 0;
for (const r of rows) {
  const base = path.basename(r.file);
  const stamp = /^(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2})/.exec(base)?.[1] ?? '';
  const kind = r.burned ? (/纯享版/.test(base) ? '纯享版' : '弹幕版(已烧)') : '原始录制';
  if (!r.burned) {
    rawSec += r.sec;
    if (r.hasXml) withXml++;
  } else {
    burnedSec += r.sec;
  }
  console.log(
    `${(r.sec / 60).toFixed(1).padStart(8)} ${r.mb.toFixed(0).padStart(9)}  ${(r.hasXml ? '有' : '  ').padEnd(4)} ` +
      `${kind.padEnd(12)} ${stamp.padEnd(28)} ${base.slice(0, 40)}`,
  );
}

const rawMin = rawSec / 60;
console.log('-'.repeat(104));
console.log(`原始录制（未烧弹幕，切片可用作源）：${rows.filter((r) => !r.burned).length} 个，合计 ${rawMin.toFixed(1)} 分钟，其中 ${withXml} 个有同名弹幕 XML`);
console.log(`已烧弹幕产物：${rows.filter((r) => r.burned).length} 个，合计 ${(burnedSec / 60).toFixed(1)} 分钟`);

console.log('\n' + '='.repeat(104));
console.log('与 B站 侧稿件对照');
console.log('='.repeat(104));
console.log(`  稿件时长（B站 侧权威值）：${ARCHIVE_MINUTES} 分钟`);
console.log(`  本地原始录制合计        ：${rawMin.toFixed(1)} 分钟`);
const diff = ARCHIVE_MINUTES - rawMin;
console.log(`  差额                    ：${diff > 0 ? `缺 ${diff.toFixed(1)} 分钟` : `多 ${(-diff).toFixed(1)} 分钟`}`);
if (Math.abs(diff) <= 10) {
  console.log('  \x1b[32m✓ 素材基本完整，可用于验证续传投稿\x1b[0m');
} else if (diff > 0) {
  console.log('  \x1b[33m⚠ 本地素材少于稿件时长 —— 可能有文件被删（清理策略）或分段未落盘\x1b[0m');
  console.log('     影响：切片只能覆盖本地这部分，但"追加投稿到同一稿件"这个动作仍可验证');
} else {
  console.log('  \x1b[32m✓ 本地素材充足（含分段重叠，正常）\x1b[0m');
}

console.log('\n' + '='.repeat(104));
console.log('验证续传需要什么');
console.log('='.repeat(104));
console.log('  1. 一个有弹幕的源文件（上面标"有"的行）');
console.log('  2. 该稿件的 aid = 117314833877723（bvid=BV13hhE6XEQM）');
console.log('  3. config.json 里 publish.multiPart=true（已开）、publish.resumeAid 指向该 aid');
console.log('  4. 跑一次导入 → 它会在切片完成后带 vid 调 /bili/upload，把切片追加到那个稿件');
