/**
 * 本地配置初始化脚本（一次性使用，可重复运行）。
 *
 * 用途：从 biliLive-tools 的 appConfig.json 读取 PassKey 等本机信息，
 * 写入项目目录下的 config.json（已在 .gitignore 中，不会进版本库）。
 *
 * ⚠️ 本脚本**只在生成时读取一次**，运行期服务不依赖 biliLive-tools 的配置文件，
 *    也不读写其中任何 cookie / AccessKey（硬约束 #8）。
 *
 * 用法：node tools/init-config.mjs [--room <房间号>]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appConfigPath = path.join(os.homedir(), 'AppData', 'Roaming', 'biliLive-tools', 'appConfig.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (!fs.existsSync(appConfigPath)) {
  console.error(`找不到 biliLive-tools 配置：${appConfigPath}`);
  console.error('请手动复制 config.example.json 为 config.json，并填写 PassKey。');
  process.exit(1);
}

// 该文件不是严格 JSON（含非法转义），用正则取需要的字段，避免解析失败
const text = fs.readFileSync(appConfigPath, 'utf8');
const pick = (re) => {
  const m = re.exec(text);
  return m ? m[1] : undefined;
};

const passKey = pick(/"passKey"\s*:\s*"([^"]*)"/);
const port = pick(/"port"\s*:\s*(\d+)/) ?? '18010';
const host = pick(/"host"\s*:\s*"([^"]*)"/) ?? '127.0.0.1';
const recorderType = pick(/"recorderType"\s*:\s*"([^"]*)"/) ?? 'builtin';

// 目标直播间：命令行 > 已有 config.json > 默认空
const existingPath = path.join(ROOT, 'config.json');
let roomId = arg('--room', undefined);
if (!roomId && fs.existsSync(existingPath)) {
  try {
    roomId = JSON.parse(fs.readFileSync(existingPath, 'utf8'))?.room?.roomId;
  } catch {
    /* ignore */
  }
}
roomId = roomId || '12345678';

const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
delete example.$comment;

// 合并已有 config.json（保留用户已改的字段），再覆盖本机相关项
let current = {};
if (fs.existsSync(existingPath)) {
  try {
    current = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
  } catch {
    console.warn('已有 config.json 解析失败，将以模板重建');
  }
}

const merged = {
  ...example,
  ...current,
  bililive: { ...example.bililive, ...current.bililive, baseUrl: `http://${host}:${port}`, passKey: passKey ?? current?.bililive?.passKey ?? '' },
  room: { ...example.room, ...current.room, roomId: String(roomId) },
  recorder: { ...example.recorder, ...current.recorder, type: recorderType === 'bililive' ? 'builtin' : recorderType },
};

fs.writeFileSync(existingPath, JSON.stringify(merged, null, 2), 'utf8');

console.log('已生成 config.json：');
console.log(`  bililive.baseUrl  = ${merged.bililive.baseUrl}`);
console.log(`  bililive.passKey  = ${merged.bililive.passKey ? `已写入（长度 ${merged.bililive.passKey.length}，值不打印）` : '⚠️ 为空，需手动填写'}`);
console.log(`  room.roomId       = ${merged.room.roomId}`);
console.log(`  room.platform     = ${merged.room.platform}`);
console.log(`  recorder.type     = ${merged.recorder.type}`);
console.log('');
console.log('下一步：');
console.log('  1) node src/probe.ts --dry-run     # 只读探测，不产生费用');
console.log('  2) 在 config.json 填写 llm.summary.apiKey / llm.select 的 Key 后：node src/probe.ts');
console.log('');
console.log('注意：本文件已在 .gitignore 中，切勿提交或分享。');
