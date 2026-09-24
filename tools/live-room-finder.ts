/**
 * 从 biliLive-tools 的 `app.db` 里取出 B站 登录态，用于查"当前正在直播的房间"。
 *
 * 为什么需要它：B站 的直播列表接口有风控（`second/getList` 直接调返回 `-352`），
 * 匿名请求拿不到数据。而 biliLive-tools 已经登录过（它的 `/bili/archives` 能正常返回），
 * 说明它的库里存着有效凭证 —— 借它的登录态发一次只读查询即可。
 *
 * ⚠️ 凭证处理：**只在本进程内存中使用，绝不打印**。输出里只会出现 `SESSDATA` 是否存在、
 *    长度多少。这是硬约束 #8（日志中不得出现凭据）的同一条纪律。
 *
 * 用法：node --experimental-strip-types tools/live-room-finder.ts [关键词]
 */
import fs from 'node:fs';
import path from 'node:path';

const DB = path.join(process.env['APPDATA'] ?? '', 'biliLive-tools', 'app.db');
if (!fs.existsSync(DB)) {
  console.error(`找不到 biliLive-tools 数据库：${DB}`);
  process.exit(1);
}

/* ---- 1) 从 sqlite 里找 B站 cookie ---- */
interface Found {
  table: string;
  column: string;
  value: string;
}
const found: Found[] = [];
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  for (const { name } of tables) {
    let cols: string[] = [];
    try {
      cols = (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((c) => c.name);
    } catch {
      continue;
    }
    for (const col of cols) {
      try {
        const rows = db.prepare(`SELECT "${col}" AS v FROM "${name}" WHERE "${col}" LIKE '%SESSDATA%' LIMIT 5`).all() as Array<{
          v: unknown;
        }>;
        for (const r of rows) {
          const s = typeof r.v === 'string' ? r.v : String(r.v ?? '');
          if (s.includes('SESSDATA')) found.push({ table: name, column: col, value: s });
        }
      } catch {
        /* 该列不是文本或不支持 LIKE，跳过 */
      }
    }
  }
  db.close();
} catch (e) {
  console.error(`读取 app.db 失败：${(e as Error).message}`);
}

console.log('='.repeat(90));
console.log('biliLive-tools 登录态探测');
console.log('='.repeat(90));
if (found.length === 0) {
  console.log('未在 app.db 里找到含 SESSDATA 的字段。');
  console.log('（可能它把 cookie 放在别处，或当前未登录 B站 —— 那就只能手工提供房间号）');
  process.exit(0);
}
for (const f of found) {
  console.log(`  表 ${f.table}.${f.column}：长度 ${f.value.length}，含 SESSDATA=${f.value.includes('SESSDATA')}`);
  console.log(`    其他键：${f.value
    .split(';')
    .map((s) => s.split('=')[0]?.trim())
    .filter(Boolean)
    .join(', ')}`);
}

/* ---- 2) 借登录态查当前直播列表 ---- */
const cookie = found[0]!.value;
const H: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Referer: 'https://live.bilibili.com/',
  Origin: 'https://live.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  Cookie: cookie,
};

async function getJson(url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return { __raw: t.slice(0, 200) };
  }
}

console.log('');
console.log('='.repeat(90));
console.log('当前正在直播的房间（按人气排序）');
console.log('='.repeat(90));

interface Room {
  roomid?: number;
  room_id?: number;
  uname?: string;
  name?: string;
  title?: string;
  online?: number;
  area_name?: string;
  live_status?: number;
}
const kw = process.argv[2] ?? '';
const listUrls = [
  'https://api.live.bilibili.com/xlive/web-interface/v1/second/getList?platform=web&parent_area_id=1&area_id=0&sort_type=online&page=1',
  'https://api.live.bilibili.com/xlive/web-interface/v1/second/getList?platform=web&parent_area_id=9&area_id=0&sort_type=online&page=1',
];
const rooms: Room[] = [];
for (const u of listUrls) {
  const j = await getJson(u);
  const code = j['code'];
  const data = j['data'] as Record<string, unknown> | undefined;
  const list = (data?.['list'] ?? []) as Room[];
  console.log(`  ${u.includes('parent_area_id=1') ? '娱乐/虚拟' : '游戏'}区：code=${String(code)} 返回 ${list.length} 条`);
  if (Array.isArray(list)) rooms.push(...list);
}
if (rooms.length === 0) {
  console.log('');
  console.log('  仍拿不到列表（风控或登录态不足）。改用「已知房间号逐个探活」的方式：');
  console.log('  请直接告诉我要测的房间号。');
  process.exit(0);
}
rooms.sort((a, b) => (b.online ?? 0) - (a.online ?? 0));
console.log('');
console.log('  房间号      主播                 人气      分区             标题');
console.log('  ' + '-'.repeat(86));
let n = 0;
for (const r of rooms) {
  const id = String(r.roomid ?? r.room_id ?? '');
  const title = String(r.title ?? '');
  if (kw && !title.includes(kw) && !String(r.uname ?? '').includes(kw)) continue;
  if (!id) continue;
  console.log(
    `  ${id.padEnd(11)} ${String(r.uname ?? '').slice(0, 16).padEnd(18)} ${String(r.online ?? 0).padStart(8)}  ` +
      `${String(r.area_name ?? '').slice(0, 12).padEnd(14)} ${title.slice(0, 30)}`,
  );
  if (++n >= 25) break;
}
console.log('');
