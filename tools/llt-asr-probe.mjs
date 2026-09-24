/**
 * 打印 biliLive-tools 侧"用哪个 ASR"（云端还是本地、哪个模型）。
 * 用法：node tools/llt-asr-probe.mjs
 */
import { BiliLiveClient } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';

const client = BiliLiveClient.fromConfig(loadConfig().config);
const cfg = await client.getConfig();
const text = JSON.stringify(cfg);
const pick = (re) => [...new Set((text.match(re) ?? []).map((s) => s))];

console.log('=== biliLive-tools 配置里与 ASR 有关的键 ===');
const walk = (v, prefix = '') => {
  if (!v || typeof v !== 'object') return;
  for (const [k, val] of Object.entries(v)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (/asr|whisper|funasr|subtitle|transcri/i.test(key)) {
      console.log(`  ${key} = ${JSON.stringify(val)?.slice(0, 220)}`);
    }
    if (val && typeof val === 'object') walk(val, key);
  }
};
walk(cfg);
console.log('\n=== 可能的模型 id ===');
console.log('  ' + pick(/"modelId"\s*:\s*"[^"]+"/g).join('\n  '));

/* 模型清单：把 id 映射到"人读的名字"，才能回答"云端还是本地" */
console.log('\n=== ai.models 清单（id → 名字/提供方） ===');
const models = cfg?.ai?.models;
if (Array.isArray(models)) {
  for (const m of models.slice(0, 40)) {
    console.log('  keys=' + Object.keys(m).join(','));
    console.log('   ' + JSON.stringify(m).slice(0, 320));
  }
} else {
  console.log('  （没有 ai.models 数组，原始：' + JSON.stringify(models)?.slice(0, 400) + '）');
}
console.log('\n=== 正在用哪个模型做字幕识别 ===');
console.log('  ai.subtitleRecognize = ' + JSON.stringify(cfg?.ai?.subtitleRecognize));
const used = models?.find?.((m) => m.id === cfg?.ai?.subtitleRecognize?.modelId);
console.log('  → ' + JSON.stringify(used ?? null));
