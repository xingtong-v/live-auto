/**
 * 查证：biliLive-tools 的「压制 / 视频处理」预设到底能做哪些事。
 *
 * 用途：用户问「自动获取录播 → 获取经过 biliLive-tools 压制的弹幕版和字幕 → 切片 → 投稿」
 * 是否成立。其中「压制出字幕」这一点必须查实 —— 如果它只能压制（转封装/转码 + 烧弹幕），
 * 那"字幕"其实是本服务自己烧的，用户的模型需要纠正。
 *
 * 只读。
 *
 * 用法：node tools/blt-preset-probe.ts
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { log } from '../src/logger.ts';

const cfg = loadConfig().config;
const client = BiliLiveClient.fromConfig(cfg, log);

console.log('\x1b[1mbiliLive-tools 预设与能力查证\x1b[0m');
console.log('─'.repeat(76));

/* ---- 1. ffmpeg 预设（切片/压制用的参数模板） ---- */
try {
  const presets = (await client.presetFfmpeg()) as Array<Record<string, unknown>>;
  console.log(`\nffmpeg 预设：${presets.length} 个`);
  for (const p of presets.slice(0, 3)) {
    const name = String(p['name'] ?? p['id'] ?? '?');
    const cfgObj = (p['config'] ?? p) as Record<string, unknown>;
    console.log(`  [${name}] 字段：${Object.keys(cfgObj).join(', ')}`);
    for (const key of ['assFilePath', 'srtContent', 'subtitle', 'danmaku', 'watermark', 'preset', 'crf']) {
      if (key in cfgObj) console.log(`      ${key} = ${JSON.stringify(cfgObj[key]).slice(0, 80)}`);
    }
  }
} catch (e) {
  console.log(`\nffmpeg 预设读取失败：${(e as Error).message.slice(0, 100)}`);
}

/* ---- 2. 弹幕预设 ---- */
try {
  const list = (await client.presetDanmu()) as Array<Record<string, unknown>>;
  console.log(`\n弹幕预设：${list.length} 个`);
  for (const p of list.slice(0, 2)) {
    const cfgObj = (p['config'] ?? p) as Record<string, unknown>;
    console.log(`  字段：${Object.keys(cfgObj).slice(0, 18).join(', ')}`);
  }
} catch (e) {
  console.log(`\n弹幕预设读取失败：${(e as Error).message.slice(0, 100)}`);
}

/* ---- 3. /config 里与"压制/字幕"相关的开关 ---- */
const raw = (await client.getConfig()) as Record<string, unknown>;
console.log('\n\x1b[1m配置里与压制/字幕/自动上传相关的开关\x1b[0m');
const interesting = /subtitle|ass|srt|danma|convert2Mp4|flvRepair|autoPartMerge|afterUploadDelet|uploadNoDanmu|uploadToSameMedia|partTitle/i;
function walk(obj: unknown, prefix = '', depth = 0): void {
  if (depth > 5 || !obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      walk(v, key, depth + 1);
      continue;
    }
    if (interesting.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      console.log(`  ${key} = ${JSON.stringify(v)}`);
    }
  }
}
walk(raw);

/* ---- 4. 视频相关端点的实际能力（找出"压制"走哪个接口） ---- */
console.log('\n\x1b[1m可用的视频处理接口（从 api.ts 的实现看）\x1b[0m');
console.log('  POST /task/cut            —— 切割（可带 assFilePath 烧弹幕/字幕）');
console.log('  POST /task/convertXml2Ass —— 弹幕 XML → ASS（实测 v3.21.0 恒 500，本服务不用）');
console.log('  POST /ai/subtitle         —— 语音转写，返回 SRT 文本（**不烧进视频**）');
console.log('  POST /bili/upload         —— 投稿（videos[] 多分P）');
console.log('  （本服务没有调用任何"压制"接口：压制产物由 biliLive-tools 自己的上传流程生成）');
