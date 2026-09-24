/**
 * 澄清：biliLive-tools 的录制落盘目录到底是不是 watch 监控的那个目录。
 *
 * autoflow-check 用字符串前缀判断，`recorder.savePath = C:\Users\demo\Downloads`
 * 与 watch 目录 `…\Downloads\Bilibili` 不同 → 报了警告。
 * 但真实录制文件确实出现在 `…\Downloads\Bilibili\<主播>\` 里，
 * 说明 biliLive-tools 是按「savePath + 主播名」组织目录的。
 * 这里把两边的事实都摊出来，避免把一个不是问题的东西当成问题。
 *
 * 用法：node --experimental-strip-types tools/watch-path-clarify.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { ROOT_DIR } from '../src/util.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

console.log('='.repeat(80));
console.log('watch 监控目录');
console.log('='.repeat(80));
for (const d of cfg.import.watch.dirs) {
  console.log(`  ${d}`);
  if (!fs.existsSync(d)) {
    console.log('    (不存在)');
    continue;
  }
  for (const sub of fs.readdirSync(d, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const full = path.join(d, sub.name);
    const files = fs.readdirSync(full).filter((f) => /\.(flv|mp4|mkv|ts)$/i.test(f));
    let newest: Date | null = null;
    let newestName = '';
    for (const f of files) {
      const st = fs.statSync(path.join(full, f));
      if (!newest || st.mtime > newest) {
        newest = st.mtime;
        newestName = f;
      }
    }
    console.log(
      `    └ ${sub.name.padEnd(20)} ${String(files.length).padStart(3)} 个视频文件` +
        (newest ? `  最新 ${newest.toISOString().slice(0, 16).replace('T', ' ')}  ${newestName}` : ''),
    );
  }
}

console.log('\n' + '='.repeat(80));
console.log('biliLive-tools 侧的录制 / 下载 / 转码目录');
console.log('='.repeat(80));
try {
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
  for (const [k, v] of flat) {
    if (typeof v !== 'string' || !/[\\/]/.test(v)) continue;
    if (!/savePath|outPutPath|outputPath|output|folder|dir/i.test(k)) continue;
    const exists = fs.existsSync(v);
    const under = cfg.import.watch.dirs.some((d) => v.toLowerCase().startsWith(d.toLowerCase()));
    const isPrefix = cfg.import.watch.dirs.some((d) => d.toLowerCase().startsWith(v.toLowerCase()));
    const rel = under ? '在 watch 目录内' : isPrefix ? 'watch 目录是它的子目录（录制按主播分子目录落盘）' : '与 watch 无关';
    console.log(`  ${k}\n      = ${v}${exists ? '' : '   (不存在)'}\n      → ${rel}`);
  }
} catch (e) {
  console.log(`  读取失败：${(e as Error).message.slice(0, 100)}`);
}

console.log('\n' + '='.repeat(80));
console.log('watch 状态文件的取舍逻辑自检');
console.log('='.repeat(80));
const st = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'watch-import-state.json'), 'utf8')) as {
  imported?: Record<string, unknown>;
  baseline?: Record<string, { at: string; sizeBytes: number }>;
};
const baselineEntries = Object.entries(st.baseline ?? {});
console.log(`  基线条目 ${baselineEntries.length} 个；已导入 ${Object.keys(st.imported ?? {}).length} 个`);
const ats = [...new Set(baselineEntries.map(([, v]) => v.at))];
console.log(`  基线写入时刻：${ats.join(', ')}`);
const dir = cfg.import.watch.dirs[0];
if (dir && fs.existsSync(dir)) {
  const all: Array<{ f: string; m: Date }> = [];
  const rec = (d: string, depth: number): void => {
    if (depth > cfg.import.watch.maxDepth) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) rec(full, depth + 1);
      else if (/\.(flv|mp4|mkv|ts)$/i.test(e.name)) all.push({ f: full, m: fs.statSync(full).mtime });
    }
  };
  rec(dir, 1);
  const inBaseline = all.filter((x) => (st.baseline ?? {})[x.f]).length;
  const newer = all.filter((x) => !(st.baseline ?? {})[x.f] && x.m > new Date(ats[0] ?? 0));
  console.log(`  watch 目录内视频文件 ${all.length} 个，其中在基线里 ${inBaseline} 个`);
  console.log(`  不在基线、比基线时刻新的：${newer.length} 个${newer.length ? '' : '  ← 没有新文件，所以 imported 为空是正常的'}`);
  for (const n of newer.slice(0, 10)) console.log(`      ${n.m.toISOString().slice(0, 16)}  ${path.basename(n.f)}`);
}
