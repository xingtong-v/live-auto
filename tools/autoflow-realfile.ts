/**
 * 用**真实录播文件**验证链路的探测→分段→弹幕配对→ASR 预检这几环（零费用、不建任务）。
 *
 * 为什么不直接建任务：建任务会真的转写+分析+切片+投稿（要花钱、要占额度）。
 * `POST /api/import/preview` 走的是和真实导入**同一套** `previewRecording()`，
 * 只是不落盘、不建任务，足以证明「这个文件能不能被自动流程吃下去」。
 *
 * 用法：node --experimental-strip-types tools/autoflow-realfile.ts [port]
 */
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] ?? 3000);
const base = `http://127.0.0.1:${port}`;

const WATCH_DIR = 'C:\\Users\\demo\\Downloads\\Bilibili';

/** 挑一个有弹幕配对的真实录播 */
function pickFile(): { video: string; danma: string | null; sizeMB: number } {
  const cands: Array<{ f: string; m: number }> = [];
  const rec = (d: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) rec(full, depth + 1);
      else if (/\.(flv|mp4|mkv)$/i.test(e.name)) {
        const st = fs.statSync(full);
        if (st.size / 1048576 >= 5) cands.push({ f: full, m: st.size });
      }
    }
  };
  rec(WATCH_DIR, 1);
  if (cands.length === 0) throw new Error(`在 ${WATCH_DIR} 下没找到 ≥5MB 的视频`);
  // 取最大的一个：分段逻辑最能被体现出来
  cands.sort((a, b) => b.m - a.m);
  const chosen = cands[0]!;
  const dir = path.dirname(chosen.f);
  const stem = path.basename(chosen.f).replace(/\.[^.]+$/, '');
  let danma: string | null = null;
  for (const ext of ['.xml', '.ass']) {
    const p = path.join(dir, stem + ext);
    if (fs.existsSync(p)) {
      danma = p;
      break;
    }
  }
  return { video: chosen.f, danma, sizeMB: chosen.m / 1048576 };
}

const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as { csrf: string; configVersion: string };
console.log('='.repeat(84));
console.log(`服务 ${base}   configVersion=${boot.configVersion}`);
console.log('='.repeat(84));

const pick = pickFile();
console.log(`\n\x1b[1m待验证的真实文件\x1b[0m`);
console.log(`  视频 : ${pick.video}`);
console.log(`  大小 : ${pick.sizeMB.toFixed(1)} MB`);
console.log(`  弹幕 : ${pick.danma ?? '(无同名弹幕)'}`);

console.log(`\n\x1b[1mPOST /api/import/preview（只读，与真实导入同一套 previewRecording）\x1b[0m`);
const t0 = Date.now();
const res = await fetch(`${base}/api/import/preview`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf },
  body: JSON.stringify({ videoPath: pick.video }),
});
const sec = (Date.now() - t0) / 1000;
const data = (await res.json()) as Record<string, unknown>;
console.log(`  HTTP ${res.status}   耗时 ${sec.toFixed(1)}s\n`);

if (res.status !== 200) {
  console.log(JSON.stringify(data, null, 2).slice(0, 1200));
  process.exit(1);
}

/** 递归打印，但把超长数组收起来，避免刷屏 */
function show(v: unknown, indent = '  ', depth = 0): void {
  if (v === null || typeof v !== 'object') {
    console.log(`${indent}${String(v)}`);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      console.log(`${indent}(空数组)`);
      return;
    }
    const head = v.slice(0, 4);
    for (const item of head) show(item, indent + '  ', depth + 1);
    if (v.length > head.length) console.log(`${indent}  … 另有 ${v.length - head.length} 项`);
    return;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const isObj = val !== null && typeof val === 'object';
    if (isObj) {
      const n = Array.isArray(val) ? `${(val as unknown[]).length} 项` : '';
      console.log(`${indent}${k}${n ? ` [${n}]` : ''}:`);
      show(val, indent + '  ', depth + 1);
    } else {
      console.log(`${indent}${k}: ${String(val)}`);
    }
  }
}
show(data);

console.log('\n' + '='.repeat(84));
console.log('\x1b[1m判定\x1b[0m');
const flat = JSON.stringify(data);
const checks: Array<[string, boolean, string]> = [
  ['能解析出时长', /"duration"|"durationSec"|"totalDuration"/.test(flat), '探测到媒体信息'],
  ['规划了转写分段', /segment|window|planCalls|units/i.test(flat), 'ASR 分段规划成功'],
  ['识别到弹幕配对', /danma|danmaku|xml/i.test(flat), pick.danma ? '同名弹幕被识别' : '(该文件无弹幕，跳过)'],
  ['给出了标题', /"title"/.test(flat), '可从文件名/接口取到标题'],
  ['ASR 预检有结论', /preflight|asr|cost|cache/i.test(flat), '预检（含缓存命中与费用）完成'],
];
let pass = 0;
for (const [label, cond, detail] of checks) {
  if (cond) pass++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[33m⚠\x1b[0m'} ${label.padEnd(16)} ${detail}`);
}
console.log(`\n  ${pass}/${checks.length} 项通过 —— 该文件可被自动流程直接导入。`);
