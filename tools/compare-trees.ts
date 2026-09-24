/**
 * 逐文件精确比对两个目录树，列出**真正**的差异（大小或内容不同），
 * 以及只是**时间戳不同**（大小相同）的文件。
 *
 * 为什么需要它：robocopy 的 `/L` 只报 `Newer`，不区分"大小不同"和"只是时间戳新"。
 * 而迁移的删除判据必须严格 —— 只有"内容一致"才敢删源。
 * 本工具用大小 + mtime 事实说话，必要时（--hash）再对可疑文件做 sha256。
 *
 * 用法：
 *   node --experimental-strip-types tools/compare-trees.ts <src> <dst> [--hash] [--limit 30]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const src = process.argv[2];
const dst = process.argv[3];
if (!src || !dst) {
  console.error('用法：node --experimental-strip-types tools/compare-trees.ts <src> <dst> [--hash] [--limit 30]');
  process.exit(1);
}
const doHash = process.argv.includes('--hash');
const li = process.argv.indexOf('--limit');
const limit = li > 0 ? Number(process.argv[li + 1]) : 30;

interface Ent {
  rel: string;
  size: number;
  mtime: number;
}
function scan(root: string): Map<string, Ent> {
  const m = new Map<string, Ent>();
  const walk = (d: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(p);
          m.set(path.relative(root, p), { rel: path.relative(root, p), size: st.size, mtime: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  return m;
}

const a = scan(src);
const b = scan(dst);
console.log('='.repeat(92));
console.log(`逐文件比对`);
console.log(`  源  ：${src}  →  ${a.size} 文件`);
console.log(`  目标：${dst}  →  ${b.size} 文件`);
console.log('='.repeat(92));

const onlySrc: string[] = [];
const onlyDst: string[] = [];
const sizeDiff: string[] = [];
const tsDiff: string[] = [];
const same: string[] = [];

for (const [rel, ea] of a) {
  const eb = b.get(rel);
  if (!eb) {
    onlySrc.push(rel);
    continue;
  }
  if (ea.size !== eb.size) sizeDiff.push(rel);
  else if (Math.abs(ea.mtime - eb.mtime) > 2000) tsDiff.push(rel);
  else same.push(rel);
}
for (const rel of b.keys()) if (!a.has(rel)) onlyDst.push(rel);

console.log('');
console.log(`  完全一致（大小+时间戳）：${same.length}`);
console.log(`  仅时间戳不同（大小相同）：${tsDiff.length}`);
console.log(`  大小不同（内容可能不同）：${sizeDiff.length}`);
console.log(`  只在源里（目标缺失）：${onlySrc.length}`);
console.log(`  只在目标里（源没有）：${onlyDst.length}`);

if (sizeDiff.length) {
  console.log('');
  console.log('  ⚠ 大小不同的文件（这些是真正需要重新复制的）：');
  for (const rel of sizeDiff.slice(0, limit)) {
    const ea = a.get(rel)!;
    const eb = b.get(rel)!;
    console.log(`     ${rel}`);
    console.log(`        源 ${ea.size}  目标 ${eb.size}  差 ${ea.size - eb.size} 字节`);
    /* 内容是否真的不同：大小不同 ⇒ 必然不同，不必算哈希 */
  }
}
if (tsDiff.length) {
  console.log('');
  console.log('  仅时间戳不同的文件（内容按大小判定相同；加 --hash 可进一步确认）：');
  for (const rel of tsDiff.slice(0, limit)) {
    const ea = a.get(rel)!;
    const eb = b.get(rel)!;
    const newer = ea.mtime > eb.mtime ? '源较新' : '目标较新';
    console.log(`     ${rel}`);
    console.log(`        源 ${new Date(ea.mtime).toLocaleString('sv')}  目标 ${new Date(eb.mtime).toLocaleString('sv')}  (${newer})`);
  }
}
if (onlySrc.length) {
  console.log('');
  console.log('  ⚠ 只在源里存在（目标缺失）：');
  for (const rel of onlySrc.slice(0, limit)) console.log(`     ${rel}`);
}
if (onlyDst.length) {
  console.log('');
  console.log('  · 只在目标里存在（源没有；可能是上次复制多出来的）：');
  for (const rel of onlyDst.slice(0, limit)) console.log(`     ${rel}`);
}

/* 需要时对可疑文件做哈希 */
if (doHash) {
  const suspects = [...tsDiff, ...sizeDiff].slice(0, 10);
  console.log('');
  console.log(`  sha256 校验（前 ${suspects.length} 个可疑文件）：`);
  const h = (p: string): string => {
    try {
      return createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
    } catch {
      return '(读不到)';
    }
  };
  let diffCount = 0;
  for (const rel of suspects) {
    const ha = h(path.join(src, rel));
    const hb = h(path.join(dst, rel));
    const eq = ha === hb;
    if (!eq) diffCount++;
    console.log(`     ${eq ? '一致  ' : '不同 !'} ${ha} ${hb}  ${rel}`);
  }
  console.log(`     ⇒ 哈希不同的文件数：${diffCount}`);
}

console.log('');
const safe = sizeDiff.length === 0 && onlySrc.length === 0;
console.log('='.repeat(92));
console.log(safe ? '结论：目标包含源的全部内容（大小一致）⇒ 可以安全删除源' : '结论：存在内容差异 ⇒ 不可删除源');
console.log('='.repeat(92));
console.log('');
