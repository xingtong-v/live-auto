/**
 * 查看 biliLive-tools 的 sqlite 库里有什么表 —— 用于找"投稿预设"（含"仅自己可见"开关）。
 *
 * 背景：本次测试要求稿件"仅自己可见"，而链路上有两个上传者：biliLive-tools 投完整版/纯享版、
 * 本项目追加切片。本项目侧已确认 `publish.isOnlySelf=1`；biliLive-tools 侧的控制点在它的
 * **投稿预设**里，而预设既不在 `/config`（appConfig.json）也不在 `/preset/*` HTTP 路由
 * （只有 danmu/ffmpeg/video/subtitle-style），所以只能查它的 sqlite 库。
 *
 * 只读（readOnly 打开），不改任何数据。
 *
 * 用法：
 *   node --experimental-strip-types tools/blt-db-inspect.ts              # 列出所有表
 *   node --experimental-strip-types tools/blt-db-inspect.ts biliUpload   # 看名字含该串的表内容
 */
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(process.env['APPDATA'] ?? '', 'biliLive-tools', 'app.db');
if (!fs.existsSync(DB)) {
  console.error(`找不到数据库：${DB}`);
  process.exit(1);
}

const filter = process.argv[2] ?? '';
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(DB, { readOnly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
console.log('='.repeat(90));
console.log(`app.db 共 ${tables.length} 张表`);
console.log('='.repeat(90));
console.log(tables.map((t) => t.name).join(', '));
console.log('');

for (const { name } of tables) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;
  let cols: Array<{ name: string }> = [];
  try {
    cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
  } catch {
    continue;
  }
  let count = 0;
  try {
    count = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n);
  } catch {
    /* ignore */
  }
  console.log('─'.repeat(90));
  console.log(`表 ${name}（${count} 行）  列：${cols.map((c) => c.name).join(', ')}`);
  if (count === 0) continue;
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = db.prepare(`SELECT * FROM "${name}" LIMIT 5`).all() as Array<Record<string, unknown>>;
  } catch {
    continue;
  }
  for (const r of rows) {
    /* 逐列打印，长值截断；重点字段（含 onlySelf/preset/title）完整显示 */
    const parts: string[] = [];
    for (const [k, v] of Object.entries(r)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      const interesting = /onlyself|preset|title|tid|copyright|id$/i.test(k);
      const max = interesting ? 300 : 60;
      parts.push(`${k}=${s && s.length > max ? `${s.slice(0, max)}…` : s}`);
    }
    console.log('   · ' + parts.join(' | '));
  }
}
db.close();
console.log('');
