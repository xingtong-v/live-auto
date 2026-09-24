/**
 * 确认 biliLive-tools 的 webhook 自动处理链是否真的会「压制弹幕 + 自动上传」。
 *
 * 已确认的配置（本机实测）：
 *   webhook.uploadNoDanmu=true, uploadToSameMedia=true, autoPartMerge=true
 *   webhook.rooms.34567890.* 同上
 * 但「配置开着」不等于「真的会跑」——还要看：
 *   1. 录制房间的 sendToWebhook 是否为 true（否则 webhook 根本不触发）
 *   2. webhook 处理逻辑里 burn（压制弹幕）/ autoUpload 的判定
 *   3. rooms 里是否包含 23456789（甲主播，实际在录的那个房间）
 *
 * 用法：node --experimental-strip-types tools/probe-blt-webhook-chain.ts
 */
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

const get = (k: string): unknown => flat.find(([kk]) => kk === k)?.[1];

console.log('='.repeat(94));
console.log('1. webhook 全局开关与自动化步骤');
console.log('='.repeat(94));
for (const k of [
  'webhook.open',
  'webhook.convert2Mp4',
  'webhook.danmu',
  'webhook.hotProgress',
  'webhook.autoPartMerge',
  'webhook.partMergeMinute',
  'webhook.uploadNoDanmu',
  'webhook.uploadToSameMedia',
  'webhook.uploadHandleTime[0]',
  'webhook.uploadHandleTime[1]',
  'webhook.limitUploadTime',
  'webhook.afterUploadDeletAction',
  'webhook.minSize',
  'webhook.partTitleTemplate',
]) {
  const v = get(k);
  console.log(`  ${k.padEnd(34)} = ${v === undefined ? '(未设置)' : JSON.stringify(v)}`);
}

console.log('\n' + '='.repeat(94));
console.log('2. 各房间是否启用了 webhook 推送（sendToWebhook）+ 该房间的 webhook 级设置');
console.log('='.repeat(94));
const roomIds: string[] = [];
for (const [k, v] of flat) {
  const m = /^recorders\[(\d+)\]\.channelId$/.exec(k);
  if (m && v !== undefined) {
    const idx = m[1]!;
    const remarks = get(`recorders[${idx}].remarks`);
    const send = get(`recorders[${idx}].sendToWebhook`);
    const seg = get(`recorders[${idx}].segment`);
    console.log(`  房间 ${String(v).padEnd(10)} ${String(remarks ?? '').padEnd(16)} sendToWebhook=${String(send)}  segment=${String(seg)}s`);
    roomIds.push(String(v));
  }
}
console.log(`\n  已配置房间：${roomIds.join(', ')}`);

console.log('\n' + '='.repeat(94));
console.log('3. 每个房间的 webhook 级覆盖设置（webhook.rooms.<id>.*）');
console.log('='.repeat(94));
const roomKeys = new Set<string>();
for (const [k] of flat) {
  const m = /^webhook\.rooms\.([^.]+)\./.exec(k);
  if (m) roomKeys.add(m[1]!);
}
if (roomKeys.size === 0) {
  console.log('  （没有房间级覆盖 —— 全部走全局配置）');
} else {
  for (const r of roomKeys) {
    console.log(`\n  ── 房间 ${r}`);
    for (const [k, v] of flat) {
      if (k.startsWith(`webhook.rooms.${r}.`)) {
        console.log(`       ${k.replace(`webhook.rooms.${r}.`, '').padEnd(26)} = ${JSON.stringify(v)}`);
      }
    }
  }
}

console.log('\n' + '='.repeat(94));
console.log('4. 判定：这套配置会不会真的「压制+上传完整版」');
console.log('='.repeat(94));
const open = get('webhook.open');
const uploadToSame = get('webhook.uploadToSameMedia');
const noDanmu = get('webhook.uploadNoDanmu');
const sendAny = flat.some(([k, v]) => /^recorders\[\d+\]\.sendToWebhook$/.test(k) && v === true);
console.log(`  webhook.open=${String(open)}（若 false，biliLive-tools 不会走 webhook 自动处理）`);
console.log(`  任一房间 sendToWebhook=true：${sendAny ? '是' : '否'}`);
console.log(`  uploadNoDanmu=${String(noDanmu)} && uploadToSameMedia=${String(uploadToSame)} ⇒ 无弹幕版进同一稿件：${
  noDanmu && uploadToSame ? '\x1b[32m会\x1b[0m' : '\x1b[31m不会\x1b[0m'
}`);
console.log(`  实际在录的房间（甲主播 23456789）是否有房间级覆盖：${roomKeys.has('23456789') ? '有' : '没有（走全局）'}`);
