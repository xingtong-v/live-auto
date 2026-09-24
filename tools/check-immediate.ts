/**
 * 直接验证 `buildBiliupConfig` 产出的投稿配置里到底有没有 `dtime`。
 *
 * 背景：试跑 2 在「已修复 + 已重启」的服务上跑，日志**仍然**打印「定时发布 2026-09-27」，
 * 说明「立即发布」链路还有别的地方在传 dtime。这里绕过整条流水线，
 * 只对纯函数做体检，把问题钉死在具体分支上。
 *
 * 用法：node --experimental-strip-types tools/check-immediate.ts
 */
import { buildBiliupConfig } from '../src/publish.ts';
import { loadConfig } from '../src/config.ts';
import type { AppConfig } from '../src/config.ts';

const cfg = loadConfig('config.json').config as AppConfig;
console.log('config.json 里 publish.immediatePublish =', cfg.publish.immediatePublish);
console.log('config.json 里 publish.multiPart       =', cfg.publish.multiPart);
console.log('');

const task = {
  id: 'probe',
  roomId: '12345678',
  title: '测试场',
  liveStartTime: Math.floor(Date.now() / 1000),
  stage: 'ANALYZED',
  source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
  fullUpload: 'NOT_APPLICABLE',
  cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
} as never;

const clip = {
  index: 0, start: 0, end: 150, title: '测试切片', desc: '测试', tags: ['测试'],
  category: '游戏/单机游戏', score: 8, selected: true, status: 'CANDIDATE',
} as never;

const DTIME = Math.floor(Date.now() / 1000) + 3 * 86400; // 明显的未来时间

console.log('='.repeat(72));
console.log('A. 不传 immediate（应回落到 cfg.publish.immediatePublish = true）');
const a = buildBiliupConfig({ clip, task, cfg, uid: 1, dtime: DTIME, uploadPresetId: 'default' });
console.log(`   config 里有 dtime 吗：${'dtime' in a.config ? `有 = ${String(a.config['dtime'])}` : '没有 ✓（立即发布）'}`);
console.log(`   警告：${a.warnings.filter((w) => /dtime|立即/.test(w)).join(' | ') || '(无)'}`);

console.log('\n' + '='.repeat(72));
console.log('B. 显式传 immediate=true（应忽略 dtime）');
const b = buildBiliupConfig({ clip, task, cfg, uid: 1, dtime: DTIME, uploadPresetId: 'default', immediate: true });
console.log(`   config 里有 dtime 吗：${'dtime' in b.config ? `有 = ${String(b.config['dtime'])}` : '没有 ✓（立即发布）'}`);

console.log('\n' + '='.repeat(72));
console.log('C. 显式传 immediate=false（应带 dtime，硬约束 #4）');
const c = buildBiliupConfig({ clip, task, cfg, uid: 1, dtime: DTIME, uploadPresetId: 'default', immediate: false });
console.log(`   config 里有 dtime 吗：${'dtime' in c.config ? `有 = ${String(c.config['dtime'])} ✓（定时发布）` : '没有'}`);

console.log('\n' + '='.repeat(72));
console.log('D. 临时把 cfg 改成 immediatePublish=false（验证传参优先）');
const cfgOff = JSON.parse(JSON.stringify(cfg)) as AppConfig;
cfgOff.publish.immediatePublish = false;
const d = buildBiliupConfig({ clip, task, cfg: cfgOff, uid: 1, dtime: DTIME, uploadPresetId: 'default', immediate: true });
console.log(`   cfg=false 但传 immediate=true → ${'dtime' in d.config ? '仍带 dtime ✗（传参没生效）' : '没有 dtime ✓（传参优先）'}`);

console.log('\n' + '='.repeat(72));
const allOk = !('dtime' in a.config) && !('dtime' in b.config) && 'dtime' in c.config && !('dtime' in d.config);
console.log(allOk ? '\x1b[32m纯函数行为全部正确 —— 问题出在别处（调用方或运行中的进程）\x1b[0m' : '\x1b[31m纯函数本身有问题\x1b[0m');
process.exitCode = allOk ? 0 : 1;
