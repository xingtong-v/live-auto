/**
 * 探测 biliLive-tools `POST /bili/upload` 是否支持「续传到已有稿件」。
 *
 * 为什么需要探测：官方文档明确写了软件**有**续传功能
 * （"支持对已存在的稿件添加新的分P，续传不会修改原有稿件信息，新分P会添加到最后"），
 * 但 API 文档只公开了 5 个页面、**没有** /bili/upload 的参数说明，
 * 项目的 `biliUpload()` 也只发 videos + config，看不到 aid / sid 之类字段。
 *
 * 探测手法（安全）：**传一个绝不可能存在的 aid**，并把 videos 指向不存在的文件。
 *   - 若接口报「稿件不存在 / aid 无效」 → 说明它**认 aid 这个参数**（可用续传）
 *   - 若报「文件不存在」或参数校验错误 → 说明 aid 不参与，是直传新建
 * 两种情况下都不会产生真实投稿。
 *
 * 用法：node --experimental-strip-types tools/probe-upload-aid.ts
 */
import { loadConfig } from '../src/config.ts';

const cfg = loadConfig('config.json').config;
const base = cfg.bililive.baseUrl.replace(/\/+$/, '');
const bogusAid = 999999999999;

/** 假设的候选续传字段名 —— 覆盖各家实现常见写法 */
const CANDIDATES: Array<[string, unknown]> = [
  ['aid', bogusAid],
  ['sid', bogusAid],
  ['Aid', bogusAid],
  ['archiveId', bogusAid],
  ['bvid', 'BV1xx411c7mD'],
  ['resumeAid', bogusAid],
];

const missing = 'F:\\deepseek\\live_auto\\data\\__definitely_missing__.mp4';
/** 接口要求 uid 必填（第一次探测返回 400 uid required），用本账号真实 uid */
const UID = '1000000000000000';

async function call(label: string, extra: Record<string, unknown>): Promise<void> {
  const body = {
    uid: UID,
    videos: [{ path: missing, title: 'probe' }],
    config: { title: 'probe', tid: 21, tag: ['probe'], copyright: 1, is_only_self: 1 },
    ...extra,
  };
  try {
    const res = await fetch(`${base}/bili/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: cfg.bililive.passKey },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      msg = String(j['error'] ?? j['message'] ?? j['msg'] ?? text.slice(0, 300));
    } catch {
      /* 保持原始文本 */
    }
    console.log(`  ${label.padEnd(22)} HTTP ${res.status}  ${msg.replace(/\s+/g, ' ').slice(0, 150)}`);
  } catch (e) {
    console.log(`  ${label.padEnd(22)} 请求异常：${(e as Error).message.slice(0, 120)}`);
  }
}

console.log('='.repeat(100));
console.log('探测 POST /bili/upload 是否接受续传（aid）参数');
console.log('='.repeat(100));
console.log(`目标：${base}/bili/upload`);
console.log(`videos 指向不存在的文件：${missing}`);
console.log(`伪造 aid：${bogusAid}\n`);

await call('基线（不带任何额外字段）', {});
for (const [k, v] of CANDIDATES) {
  await call(`带 ${k}=${String(v).slice(0, 18)}`, { [k]: v });
}

console.log('\n' + '='.repeat(100));
console.log('判读方式');
console.log('='.repeat(100));
console.log('  · 只有带某个字段时才出现「稿件/aid/archive 不存在」之类的新错误 ⇒ 那个字段就是续传入口');
console.log('  · 所有情况下错误都一样（都是文件不存在/参数错误） ⇒ 该接口不暴露续传，只能直传新建');
console.log('  · 注意：本次探测全程使用不存在的文件 + 伪造 aid，不会产生真实投稿');
