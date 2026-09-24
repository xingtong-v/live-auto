/**
 * 对比 biliLive-tools 日志里**每一次** ASR 调用：参数、结果、以及 400 的响应体。
 *
 * 为什么必须对比：同一个模型/同一套参数"之前能转、现在 400"，只有把历史调用摊开才能看出
 * 是"模型被删了""key 失效了""额度没了"还是"某次改了配置"。
 *
 * 用法：node tools/_tmp-asr-history.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const p = path.join(ROOT_DIR, 'data', 'subtitle-check', 'blt-log.txt');
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);

const ts = (l: string): string => /\[([\d\-: .]+)\]/.exec(l)?.[1] ?? '?';

console.log('每次 ASR 调用的时间 / 模型 / 参数 / 结果');
console.log('─'.repeat(100));
const starts: number[] = [];
for (let i = 0; i < lines.length; i++) if (lines[i]!.includes('开始字幕识别')) starts.push(i);

for (let k = 0; k < starts.length; k++) {
  const i = starts[k]!;
  const end = k + 1 < starts.length ? starts[k + 1]! : lines.length;
  const block = lines.slice(i, Math.min(end, i + 260));
  const text = block.join('\n');
  const model = /modelId:\s*'([^']+)'/.exec(text)?.[1] ?? '?';
  const maxLength = /maxLength:\s*(\d+)/.exec(text)?.[1] ?? '?';
  const offset = /offset:\s*(\d+)/.exec(text)?.[1] ?? '?';
  const file = /file:\s*'([^']+)'/.exec(text)?.[1] ?? '?';
  const uploaded = /文件上传成功/.test(text);
  const err = /提交ASR任务失败|Request failed with status code (\d+)/.exec(text);
  const errCode = /status code (\d+)/.exec(text)?.[1];
  // 响应体（axios 的 response.data 里通常有 code/message/request_id）
  const bodyLines = block.filter((l) => /request_id|"code"|code:|message:|Model|model|InvalidParameter|Arrearage|Throttling|data:/.test(l)).slice(0, 6);
  const okMark = err ? `\x1b[31m失败 ${errCode ?? ''}\x1b[0m` : '\x1b[32m未见错误\x1b[0m';
  console.log(`\n#${k + 1}  ${ts(lines[i]!)}  模型=${model}  maxLength=${maxLength}  offset=${offset}  上传OSS=${uploaded ? '成功' : '无'}  → ${okMark}`);
  console.log(`    文件：${path.basename(file)}`);
  for (const b of bodyLines) console.log(`    \x1b[90m${b.trim().slice(0, 200)}\x1b[0m`);
}
console.log('\n' + '─'.repeat(100));
console.log('（模型 id 在不同调用里是否变化、以及 400 的响应体，是判断"配置被改过/模型被删/key 失效"的关键）');
