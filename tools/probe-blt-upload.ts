/**
 * 查 biliLive-tools 的上传/压制相关配置：
 *   1. 它是否会自动上传（录制完成后）—— 决定「完整版由它投」这条链路能不能成立
 *   2. 它的上传预设（uploadPresetId）里有没有 aid / 分P 相关字段
 *   3. 它的压制（转码）配置 —— 决定 -弹幕版.mp4 会不会自动产生
 *
 * 用法：node --experimental-strip-types tools/probe-blt-upload.ts
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

const raw = (await client.getConfig()) as Record<string, unknown>;

/* 扁平化，只看与上传/压制/录制后动作相关的键 */
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

const KEY = /upload|bili|aid|part|preset|compress|transcode|convert|danmaku|ass|record|auto/i;
console.log('='.repeat(96));
console.log('biliLive-tools 配置里与「上传 / 压制 / 自动动作」相关的键');
console.log('='.repeat(96));
let n = 0;
for (const [k, v] of flat) {
  if (!KEY.test(k)) continue;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined || s === 'null' || s === '""' || s === '[]' || s === '{}' || s === 'false' || s === '0') continue;
  if (s.length > 90) continue;
  console.log(`  ${k.padEnd(46)} = ${s}`);
  n++;
}
if (n === 0) console.log('  （没有找到相关的非空配置项）');

console.log('\n' + '='.repeat(96));
console.log('上传预设（/preset/video）的字段');
console.log('='.repeat(96));
try {
  const presets = (await client.presetVideo()) as unknown as Array<Record<string, unknown>>;
  console.log(`共 ${presets.length} 个预设`);
  for (const p of presets) {
    console.log(`\n  ── ${String(p['id'] ?? '(无id)')}  ${String(p['name'] ?? '')}`);
    const c = (p['config'] ?? p) as Record<string, unknown>;
    for (const [k, v] of Object.entries(c)) {
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (s === 'null' || s === '""' || s === '[]' || s === '{}') continue;
      console.log(`       ${k.padEnd(32)} = ${s.slice(0, 70)}`);
    }
  }
} catch (e) {
  console.log(`  读取失败：${(e as Error).message.slice(0, 100)}`);
}
