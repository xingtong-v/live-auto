/**
 * 侦察 biliLive-tools 的配置结构：找它自己的录制目录与房间列表。
 *
 * 背景：`GET /config` 返回的对象里挖不到 `recoderFolder`（我们的提取函数返回 undefined），
 * 而配置里确实出现过别的房间号。这里把相关段落原样打出来，确认字段名与结构。
 *
 * 只读。
 *
 * 用法：node tools/blt-config-probe.ts
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { log } from '../src/logger.ts';

const cfg = loadConfig().config;
const client = BiliLiveClient.fromConfig(cfg, log);

const raw = (await client.getConfig()) as Record<string, unknown>;
console.log('\x1b[1mbiliLive-tools /config 顶层键\x1b[0m');
console.log('  ' + Object.keys(raw).join(', '));

/** 深度查找所有像路径的字符串字段 */
function findPathLike(obj: unknown, prefix = '', depth = 0, out: Array<{ k: string; v: string }> = []): Array<{ k: string; v: string }> {
  if (depth > 6 || !obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' && /^[A-Za-z]:[\\/]|^\\\\|^\//.test(v)) {
      if (/folder|path|dir|dirs/i.test(k)) out.push({ k: key, v });
    } else if (v && typeof v === 'object') {
      findPathLike(v, key, depth + 1, out);
    }
  }
  return out;
}

console.log('\n\x1b[1m看起来像「目录」的配置项\x1b[0m');
for (const f of findPathLike(raw)) console.log(`  ${f.k}\n      = ${f.v}`);

/** 深度查找房间号 */
function findRoomIds(obj: unknown, prefix = '', depth = 0, out: Array<{ k: string; v: string }> = []): Array<{ k: string; v: string }> {
  if (depth > 7 || !obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (/room_?id$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      out.push({ k: key, v: String(v) });
    } else if (v && typeof v === 'object') {
      findRoomIds(v, key, depth + 1, out);
    }
  }
  return out;
}

console.log('\n\x1b[1m配置里出现的房间号\x1b[0m');
const rooms = findRoomIds(raw);
const uniq = [...new Set(rooms.map((r) => r.v))];
for (const id of uniq) {
  const where = [...new Set(rooms.filter((r) => r.v === id).map((r) => r.k))];
  console.log(`  ${id}   ← ${where.slice(0, 3).join(', ')}`);
}
if (uniq.length === 0) console.log('  （没找到）');

/* ---- 挨个房间查录制历史，看有没有别的场次 ---- */
console.log('\n\x1b[1m各房间的录制历史\x1b[0m');
const toCheck = [...new Set([cfg.room.roomId, ...uniq])].filter(Boolean);
for (const roomId of toCheck) {
  try {
    const r = await client.recordHistoryList({ roomId, platform: cfg.room.platform, page: 1, pageSize: 50 });
    console.log(`  房间 ${roomId}：${r.total} 条记录`);
    for (const item of r.list.slice(0, 3)) {
      const vf = String(item.video_file ?? '');
      console.log(`      ${String(item.title ?? '').slice(0, 30)}  ${vf ? (vf.split(/[\\/]/).pop() ?? '') : '(无文件)'}`);
    }
  } catch (e) {
    console.log(`  房间 ${roomId}：查询失败 ${(e as Error).message.slice(0, 80)}`);
  }
}
