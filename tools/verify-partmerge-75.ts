/**
 * 确认 `partMergeMinute` 改成 75 后是否真的生效，并用你的真实录制数据复算分场结果。
 *
 * 三件事：
 *   1. 读 biliLive-tools 当前配置里**全局**与**各房间**的 autoPartMerge / partMergeMinute
 *      （房间级会覆盖全局，只看全局会漏判）
 *   2. 复算 09-22 那场是否归一为 1 场（= 1 个稿件）
 *   3. 复算 09-17 那场是否仍正确分开（不能被错误合并）
 *
 * 用法：node --experimental-strip-types tools/verify-partmerge-75.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

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
console.log('1. 当前配置（改完之后的实际值）');
console.log('='.repeat(96));
const globalMerge = g('webhook.autoPartMerge');
const globalMinute = g('webhook.partMergeMinute');
console.log(`  全局  autoPartMerge = ${String(globalMerge)}   partMergeMinute = ${String(globalMinute)} 分钟`);

/** 房间级覆盖 —— 有覆盖时以房间为准（getRoomSetting 优先取房间值） */
const roomIds: string[] = [];
for (const [k, v] of flat) {
  const m = /^recorders\[(\d+)\]\.channelId$/.exec(k);
  if (m) roomIds.push(String(v));
}
let anyRoomOverride = false;
for (const roomId of roomIds) {
  const prefix = `webhook.rooms.${roomId}.`;
  const rm = g(`${prefix}autoPartMerge`);
  const rmin = g(`${prefix}partMergeMinute`);
  const remark = flat.find(([k]) => k.startsWith(prefix) && k.endsWith('.remark'))?.[1] ?? '';
  if (rm !== undefined || rmin !== undefined) {
    anyRoomOverride = true;
    console.log(`  房间 ${roomId.padEnd(10)} ${String(remark).padEnd(16)} autoPartMerge=${String(rm)}  partMergeMinute=${String(rmin)}`);
  } else {
    console.log(`  房间 ${roomId.padEnd(10)} ${String(remark).padEnd(16)} （无房间级覆盖 → 用全局 ${String(globalMinute)} 分钟）`);
  }
}
/* 另外列一下配置里存在但不在 recorder 列表里的 webhook.rooms.*（历史遗留） */
const extraRooms = new Set<string>();
for (const [k] of flat) {
  const m = /^webhook\.rooms\.([^.]+)\./.exec(k);
  if (m && !roomIds.includes(m[1]!)) extraRooms.add(m[1]!);
}
if (extraRooms.size) {
  for (const r of extraRooms) {
    console.log(
      `  遗留房间 ${r.padEnd(8)} （不在录制器列表里）autoPartMerge=${String(g(`webhook.rooms.${r}.autoPartMerge`))}  ` +
        `partMergeMinute=${String(g(`webhook.rooms.${r}.partMergeMinute`))}`,
    );
  }
}

const effective = Number(globalMinute);
console.log(`\n  ⇒ 生效阈值：${effective} 分钟${anyRoomOverride ? '（存在房间级覆盖，见上）' : ''}`);
if (globalMerge !== true) {
  console.log('  \x1b[31m✗ autoPartMerge 不是 true —— 源码里 `if (!mergePart) partMergeMinute = -1`，阈值设多少都不会合并！\x1b[0m');
} else {
  console.log('  \x1b[32m✓ autoPartMerge = true，阈值生效\x1b[0m');
}

/* ---------------- 2/3. 用真实数据复算 ---------------- */
function parseStamp(fileName: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})-(\d{3})/.exec(fileName);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
}

const WATCH = 'C:\\Users\\demo\\Downloads\\Bilibili';
const MIN_SIZE_MB = 20;
console.log('\n' + '='.repeat(96));
console.log(`2/3. 用生效阈值 ${effective} 分钟复算真实录制（minSize=${MIN_SIZE_MB}MB，与 handleMatchedPair 同序）`);
console.log('='.repeat(96));

for (const sub of fs.readdirSync(WATCH, { withFileTypes: true })) {
  if (!sub.isDirectory()) continue;
  const dir = path.join(WATCH, sub.name);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(flv|mp4|ts|mkv)$/i.test(f) && !/-弹幕版|-纯享版/.test(f))
    .map((f) => ({ f, t: parseStamp(f), size: fs.statSync(path.join(dir, f)).size }))
    .filter((x): x is { f: string; t: Date; size: number } => x.t !== null && x.size / 1048576 >= MIN_SIZE_MB)
    .sort((a, b) => a.t.getTime() - b.t.getTime());

  const byDay = new Map<string, Array<{ f: string; t: Date; size: number }>>();
  for (const x of files) {
    const day = `${x.t.getFullYear()}-${x.t.getMonth() + 1}-${x.t.getDate()}`;
    const arr = byDay.get(day) ?? [];
    arr.push(x);
    byDay.set(day, arr);
  }
  console.log(`\n  ── ${sub.name}`);
  for (const [day, arr] of [...byDay.entries()].sort()) {
    if (arr.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < arr.length; i++) gaps.push((arr[i]!.t.getTime() - arr[i - 1]!.t.getTime()) / 60000);
    const maxGap = Math.max(...gaps);
    const lives = gaps.filter((x) => x > effective).length + 1;
    const mark = lives === 1 ? '\x1b[32m1 场 = 1 个稿件 ✓\x1b[0m' : `\x1b[33m${lives} 场 ⇒ ${lives} 个稿件\x1b[0m`;
    console.log(
      `      【${day}】${arr.length} 个文件  最大间隔 ${maxGap.toFixed(1)} 分钟  →  ${mark}`,
    );
  }
}

console.log('\n' + '='.repeat(96));
console.log('判读');
console.log('='.repeat(96));
console.log('  · 09-22 那场（你确认为「一场直播」）应当显示「1 场 ✓」');
console.log('  · 09-17 那场（6 小时间隔）显示「2 场」是正确的 —— 那确实是两场');
