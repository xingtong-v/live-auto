/**
 * 诊断：为什么 ASR 大面积缺失。
 *
 * 已知事实：transcript.json 里 segments 为空，gaps 记录了
 *   "http-status: biliLive-tools 内部错误（HTTP 500） —— {"error":"Request failed with status code 400"}"
 * 也就是说**请求根本没成功**，而不是"识别出来是空的"。400 是上游（ASR 供应商）返回的，
 * 真实原因只在 biliLive-tools 自己的日志里。
 *
 * 用法：node tools/asr-failure-diagnose.ts [关键词]
 */
import fs from 'node:fs';
import path from 'node:path';
import { BiliLiveClient } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { ROOT_DIR } from '../src/util.ts';

const cfg = loadConfig().config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

const keyword = process.argv[2] ?? '来两下';
/**
 * ⚠️ 优先**直接读 biliLive-tools 的日志文件**，而不是它的 `/common/getLogContent` 接口。
 *
 * 实测教训：接口返回的是一份**旧快照** —— 03:56 的失败在接口里根本看不到（最新只到 02:00），
 * 于是诊断会指向前一次的原因，把人带到完全错误的方向。
 * 真正的日志在 `%APPDATA%\biliLive-tools\logs\main.log`。
 */
const logFile = process.env['APPDATA'] ? path.join(process.env['APPDATA'], 'biliLive-tools', 'logs', 'main.log') : '';
let text: string;
let source: string;
if (logFile && fs.existsSync(logFile)) {
  text = fs.readFileSync(logFile, 'utf8');
  source = logFile;
} else {
  text = await client.getLogContent(2 * 1024 * 1024, { quiet: true });
  source = '/common/getLogContent（接口快照，可能滞后）';
}
const lines = text.split(/\r?\n/);
console.log(`日志来源：${source}`);
console.log(`共 ${lines.length} 行；本机 ASR 相关配置：`);
console.log(`  asr.provider      = ${cfg.asr.provider}`);
console.log(`  asr.model         = ${cfg.asr.modelId ?? '(默认)'}`);
console.log(`  asr.inputSource   = ${cfg.asr.inputSource}`);
console.log(`  asr.segmentMin    = ${cfg.asr.segmentMinutes}`);
console.log(`  asr.unitPrice     = ${cfg.asr.unitPricePerHour} 元/小时\n`);

const hits: string[] = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]!;
  const interesting = /subtitle|asr|whisper|识别|400|500/i.test(l);
  if (!interesting) continue;
  // 关键词（文件名）出现的位置附近也算命中
  const near = keyword ? lines.slice(Math.max(0, i - 8), i + 8).some((x) => x.includes(keyword)) : false;
  if (near || /400|status code 400/.test(l)) hits.push(l);
}
console.log(`命中 ${hits.length} 行，打印最后 30 行：`);
for (const h of hits.slice(-30)) console.log('  ' + h.slice(0, 300));

/* 落盘一份完整日志，便于细看（含上下文的原始文件，不截断） */
const out = path.join(ROOT_DIR, 'data', 'subtitle-check', 'blt-log.txt');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text, 'utf8');
console.log(`\n完整日志已保存：${path.relative(ROOT_DIR, out)}（${(text.length / 1024).toFixed(0)} KB）`);
