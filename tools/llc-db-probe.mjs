/**
 * 只读探查 biliLive-tools 的 SQLite（app.db），回答两个问题：
 *   ① Live（一场直播）→ parts（分段）→ aid（稿件）的映射有没有落库？
 *   ② webhook 事件缓冲区（EventBufferManager 持久化）存了哪些字段？
 *
 * 为什么查：用户问「biliLive-tools 建的稿件和切片助手的稿件能不能是同一个」。
 * 我们已确认 biliLive-tools 内存里 `live.aid` 就是那个稿件 id（performNewUploadForSameMedia 里赋值），
 * 但内存态重启即丢；要判断「能不能稳定地拿到那个 aid」，必须看它是否落库。
 *
 * ⚠️ 严格只读（readOnly: true），绝不写入 —— 硬约束：不改基建。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath =
  process.argv[2] ?? path.join(process.env['APPDATA'] ?? '', 'biliLive-tools', 'app.db');
if (!fs.existsSync(dbPath)) {
  console.error(`找不到 app.db：${dbPath}`);
  process.exit(1);
}
console.log(`库文件：${dbPath}（${(fs.statSync(dbPath).size / 1024).toFixed(0)} KB）\n`);

const db = new DatabaseSync(dbPath, { readOnly: true });
const tables = db.prepare("select name, sql from sqlite_master where type='table' order by name").all();
console.log(`表 ${tables.length} 个：`);
for (const t of tables) {
  const name = String(t['name']);
  const sql = String(t['sql'] ?? '').replace(/\s+/g, ' ');
  let count = '?';
  try {
    count = String(db.prepare(`select count(*) as c from "${name}"`).get()['c']);
  } catch {
    /* 视图/虚拟表可能查不动，忽略 */
  }
  console.log(`\n  [${name}]  ${count} 行`);
  console.log(`    ${sql.slice(0, 300)}`);
}

/* record_history 是「录制历史」表，逐列打印，确认它有没有记「投到哪个稿件」 */
const rh = db.prepare('pragma table_info("record_history")').all();
console.log('\n\n=== record_history 全部列 ===');
for (const c of rh) console.log(`  ${String(c['name'])}  ${String(c['type'])}`);

/* 找带 aid / live / part 字样的列，判断是否有「场次 → 稿件」的持久映射 */
console.log('\n\n=== 含 aid / live / part 字样的列 ===');
for (const t of tables) {
  const name = String(t['name']);
  let cols;
  try {
    cols = db.prepare(`pragma table_info("${name}")`).all();
  } catch {
    continue;
  }
  const hit = cols.filter((c) => /aid|live|part|media/i.test(String(c['name'])));
  if (hit.length === 0) continue;
  console.log(`  [${name}] ${hit.map((c) => String(c['name'])).join(', ')}`);
}
db.close();
