/**
 * 核查：为什么「别的主播的录播」没出现在清单里。
 *
 * 已发现的事实：
 *   - 录制目录字段其实是 `recorder.savePath`（= C:\Users\demo\Downloads），
 *     不是我们原来找的 `webhook.recoderFolder` —— 所以那个提取函数一直取不到。
 *   - biliLive-tools 里有两个房间在录：12345678（74 条历史）与 23456789（37 条），
 *     而配置里的 cfg.room.roomId 只有 12345678。
 *
 * 这个脚本核对：这些历史记录指向的文件到底还在不在磁盘上。
 * 只读。
 *
 * 用法：node tools/history-file-check.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { log } from '../src/logger.ts';

const cfg = loadConfig().config;
const client = BiliLiveClient.fromConfig(cfg, log);
const raw = (await client.getConfig()) as Record<string, unknown>;

/** 从配置里挖出所有房间号（virtualRecord.config[].roomId 是实测位置） */
function roomIdsOf(obj: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 7 || !obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (/room_?id$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) out.add(String(v));
    else if (v && typeof v === 'object') roomIdsOf(v, depth + 1, out);
  }
  return out;
}

const rooms = [...roomIdsOf(raw)];
console.log('\x1b[1m各房间录制历史里的文件是否还在磁盘上\x1b[0m');
console.log('─'.repeat(76));

const dirs = new Map<string, number>();
let alive = 0;
let dead = 0;

for (const roomId of [cfg.room.roomId, ...rooms.filter((r) => r !== cfg.room.roomId)]) {
  let list: Awaited<ReturnType<typeof client.recordHistoryList>>;
  try {
    list = await client.recordHistoryList({ roomId, platform: cfg.room.platform, page: 1, pageSize: 100 });
  } catch (e) {
    console.log(`  房间 ${roomId}：查询失败 ${(e as Error).message.slice(0, 70)}`);
    continue;
  }
  console.log(`\n  房间 ${roomId}：${list.total} 条历史`);
  for (const item of list.list.slice(0, 40)) {
    const vf = String(item.video_file ?? '').trim();
    const title = String(item.title ?? '').slice(0, 28);
    if (!vf) {
      console.log(`    \x1b[33m无文件字段\x1b[0m  ${title}`);
      continue;
    }
    const ok = fs.existsSync(vf);
    if (ok) {
      alive++;
      const dir = path.dirname(vf);
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    } else {
      dead++;
    }
    console.log(`    ${ok ? '\x1b[32m在\x1b[0m  ' : '\x1b[31m没了\x1b[0m'}  ${title}  \x1b[90m${path.basename(vf)}\x1b[0m`);
  }
}

console.log(`\n小结：历史文件存在 ${alive} 条，已不在磁盘 ${dead} 条`);
console.log('\n这些文件分布在哪些目录（= 应该扫的目录）：');
for (const [d, n] of [...dirs.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} 条  ${d}`);

console.log('\n\x1b[1m磁盘上真实存在的录播目录（按主播分组）\x1b[0m');
const fsRoots = [...new Set([...dirs.keys()].map((d) => path.dirname(d)))];
for (const root of fsRoots) {
  if (!fs.existsSync(root)) continue;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    let n = 0;
    let bytes = 0;
    const walk = (d: string, depth: number): void => {
      if (depth > 3) return;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const x of ents) {
        const p = path.join(d, x.name);
        if (x.isDirectory()) walk(p, depth + 1);
        else if (/\.(flv|mp4|ts|mkv)$/i.test(x.name)) {
          try {
            const st = fs.statSync(p);
            if (st.size >= 5 * 1024 * 1024) {
              n++;
              bytes += st.size;
            }
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(full, 0);
    if (n > 0) console.log(`  \x1b[33m${String(n).padStart(3)} 个（${(bytes / 1024 ** 3).toFixed(1)} GB）\x1b[0m  ${full}`);
  }
}
