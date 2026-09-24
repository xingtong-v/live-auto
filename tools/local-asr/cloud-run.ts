import fs from 'node:fs';
import { loadConfig } from '../../src/config.ts';
import { BiliLiveClient } from '../../src/api.ts';

const lc = loadConfig('config.json');
const client = BiliLiveClient.fromConfig(lc.config);

// 1) 当前模型配置
const raw = (await client.getConfig()) as Record<string, unknown>;
const ai = (raw['ai'] ?? {}) as Record<string, unknown>;
const sub = ai['subtitleRecognize'] as { modelId?: string } | undefined;
const models = (ai['models'] ?? []) as Array<{ modelId?: string; modelName?: string }>;
const nameOf = (id?: string): string => models.find((m) => m.modelId === id)?.modelName ?? '(未知)';
console.log(`  识别模型: ${nameOf(sub?.modelId)}  (${sub?.modelId ?? '未设置'})`);

// 2) 用同一份 5 分钟素材实测一次云端调用
const file = 'F:/deepseek/live_auto/data/local-asr-test/sample-300s.flv';
console.log(`\n=== 云端单次调用实测（5 分钟素材）===`);
const t0 = Date.now();
try {
  const srt = await client.subtitle({ file, startTime: 0, endTime: 300, offset: 0, retry: 0 });
  const ms = Date.now() - t0;
  const cues = srt.split(/\r?\n/).filter((l) => /-->/.test(l)).length;
  fs.writeFileSync('data/local-asr-test/cloud-300s.srt', srt, 'utf8');
  console.log(`  ✓ 成功  耗时 ${(ms / 1000).toFixed(1)}s  RTF=${(ms / 1000 / 300).toFixed(4)}  字幕 ${cues} 条`);
  console.log(`  已保存 data/local-asr-test/cloud-300s.srt`);
  console.log(`\n  前 10 条：`);
  const blocks = srt.split(/\r?\n\r?\n/).filter(Boolean).slice(0, 10);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter(Boolean);
    const text = lines.slice(2).join(' ');
    console.log(`    ${lines[1]}  ${text}`);
  }
} catch (e) {
  console.log(`  ✗ 仍然失败：${(e as Error).message.slice(0, 200)}`);
  process.exit(1);
}
