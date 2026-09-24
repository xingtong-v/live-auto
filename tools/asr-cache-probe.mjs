/**
 * 排查（第六步）：云 ASR 的**原始返回**里有没有词级时间戳？
 *
 * 如果有（words / punctuation+timestamps），字幕就可以按词对齐，而不是被"一句 40 秒"拖歪；
 * 如果没有，就只能换 ASR（本地 Fun-ASR / whisper 词级）这一条路。
 *
 * 用法：node tools/asr-cache-probe.mjs [cacheFile]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const file = process.argv[2] ?? path.join(ROOT_DIR, 'data', 'asr-cache', 'c4be4e19.json');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`缓存文件：${path.basename(file)}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
console.log(`顶层字段：${Object.keys(j).join(', ')}`);

const show = (o, prefix = '', depth = 0) => {
  if (depth > 3 || !o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      console.log(`  ${key}: 数组[${v.length}]${v.length ? ' 首元素字段=' + Object.keys(v[0] ?? {}).join(',') : ''}`);
      if (v.length && typeof v[0] === 'object') show(v[0], `${key}[0]`, depth + 1);
    } else if (v && typeof v === 'object') {
      console.log(`  ${key}: 对象{${Object.keys(v).slice(0, 8).join(',')}}`);
      show(v, key, depth + 1);
    } else {
      const s = String(v);
      console.log(`  ${key} = ${s.length > 90 ? s.slice(0, 90) + '…' : s}`);
    }
  }
};
show(j);

const text = JSON.stringify(j);
console.log('\n是否包含词级/字级时间戳的痕迹：');
for (const k of ['words', 'word', 'Word', 'token', 'char', 'begin_time', 'end_time', 'start_time', 'timestamp']) {
  const n = (text.match(new RegExp(`"${k}`, 'g')) ?? []).length;
  if (n) console.log(`  "${k}" 出现 ${n} 次`);
}
