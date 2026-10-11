/**
 * 多会话协作看板（2026-10-12，优化第三批 ③）。
 *
 * 起因（真实撞车）：我准备实现「ASR 独立进程」，写完第一步才发现
 * `src/asr-worker.ts` / `src/asr-worker-client.ts` **已经存在**（另一个会话建的，时间戳 10-11 11:32/11:34），
 * 而且已接进 `daemon.ts` 与 verify。再往前还有 docs 章节号重复（两个 §37/§38/§40）、
 * `package.json` 被写入 BOM。同一个仓库上跑多个会话（或人和 agent 混跑）时，缺的不是能力，是**占位与可见性**。
 *
 * 这个工具就干一件事：把"谁在改什么、改了哪些文件"记在一个纯文本文件里，并在动手前能查冲突。
 *
 * 约定（写进 WORKLOG.md 开头，人和 agent 都照做）：
 *   1. 开工前 `npm run worklog -- claim "任务一句话" --files a.ts,b.ts`；
 *   2. 改完（或放弃）`npm run worklog -- done "任务一句话"`；
 *   3. 动手前可 `npm run worklog -- check a.ts,b.ts` —— 被未完成条目占用就非零退出。
 *
 * 存储：仓库根 `WORKLOG.md`（人可读；每行一条，格式固定以便机器解析）。
 * 行格式：- [ ] 2026-10-12T01:23Z | 会话/人 | 任务 | 文件：a.ts, b.ts
 *         - [x] 同上（x = 已完成）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const LOG = path.join(ROOT_DIR, 'WORKLOG.md');
const header = `# 工作看板（多会话协作）

> 同一个仓库上可能同时有多个会话/人在改代码。**开工前占位、改完销账**，避免两份实现撞车
> （2026-10-12 真实发生过：ASR 独立进程被两个会话各写了一份）。
>
> 用法（都在仓库根跑）：
>
> - 占位：\`npm run worklog -- claim "任务一句话" --files src/a.ts,src/b.ts\`
> - 销账：\`npm run worklog -- done "任务一句话"\`
> - 查看：\`npm run worklog -- list\`
> - 查冲突：\`npm run worklog -- check src/a.ts\`（被未完成条目占用则非零退出）
>
> 条目格式（机器可解析，别手改格式）：
> \`- [ ] 2026-10-12T01:23Z | 会话 | 任务 | 文件：a.ts, b.ts\`

`;

interface Entry {
  done: boolean;
  at: string;
  who: string;
  task: string;
  files: string[];
  raw: string;
}

function readEntries(): { lines: string[]; entries: Entry[] } {
  if (!fs.existsSync(LOG)) return { lines: [], entries: [] };
  const lines = fs.readFileSync(LOG, 'utf8').split('\n');
  const entries: Entry[] = [];
  for (const line of lines) {
    const m = /^- \[([ x])\] (\S+) \| ([^|]+) \| ([^|]+) \| 文件：(.*)$/.exec(line);
    if (!m) continue;
    entries.push({
      done: m[1] === 'x',
      at: m[2]!,
      who: m[3]!.trim(),
      task: m[4]!.trim(),
      files: m[5]!
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      raw: line,
    });
  }
  return { lines, entries };
}

function writeAll(lines: string[]): void {
  const body = lines.filter((l) => l !== undefined).join('\n');
  fs.writeFileSync(LOG, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}

function ensureFile(): string[] {
  if (!fs.existsSync(LOG)) {
    fs.writeFileSync(LOG, header, 'utf8');
    return header.split('\n');
  }
  return fs.readFileSync(LOG, 'utf8').split('\n');
}

/* 记录者标识：优先 --who，其次会话 id 的**尾部**（前缀是 'session-' 这种公共部分，截前 8 位等于没标识），
   最后退回主机名。 */
const whoArg = args2Who(process.argv.slice(2));
const sid = process.env['DSH_SESSION_ID'] ?? '';
const who = whoArg || (sid ? `session:${sid.replace(/^session-/, '').slice(0, 12)}` : (process.env['COMPUTERNAME'] ?? 'unknown'));
function args2Who(a: string[]): string {
  const i = a.indexOf('--who');
  return i >= 0 ? (a[i + 1] ?? '') : '';
}
const args = process.argv.slice(2);
const cmd = args[0] ?? 'list';
const rest = args.slice(1);
const filesIdx = rest.indexOf('--files');
const task = rest.filter((a, i) => !a.startsWith('--') && (filesIdx < 0 || i < filesIdx)).join(' ');
const files = filesIdx >= 0 ? (rest[filesIdx + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean) : [];

if (cmd === 'claim') {
  if (!task) throw new Error('用法：npm run worklog -- claim "任务一句话" --files a.ts,b.ts');
  const lines = ensureFile();
  /* 先查冲突：这些文件是否已被"未完成"的条目占用 */
  const { entries } = readEntries();
  const busy = entries.filter((e) => !e.done && e.files.some((f) => files.includes(f)));
  const line = `- [ ] ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} | ${who} | ${task} | 文件：${files.join(', ')}`;
  lines.push(line);
  writeAll(lines);
  console.log(`  ✅ 已占位：${task}${files.length ? `（${files.length} 个文件）` : ''}`);
  if (busy.length) {
    console.log(`  ⚠️ 注意：这些文件已被以下未完成条目占用 ——`);
    for (const b of busy) console.log(`     · ${b.who} | ${b.task} | ${b.files.join(', ')}`);
  }
} else if (cmd === 'done') {
  const { lines, entries } = readEntries();
  const hit = entries.find((e) => !e.done && (e.task === task || e.task.includes(task) || task === ''));
  if (!hit) {
    console.log(`  ⚠️ 没找到匹配的未完成条目（${task || '未给任务名'}）—— 用 list 看看`);
    process.exitCode = 1;
  } else {
    const idx = lines.indexOf(hit.raw);
    lines[idx] = hit.raw.replace('- [ ]', '- [x]');
    writeAll(lines);
    console.log(`  ✅ 已销账：${hit.task}`);
  }
} else if (cmd === 'check') {
  const want = (files.length ? files : task.split(',')).map((x) => x.trim()).filter(Boolean);
  const { entries } = readEntries();
  const busy = entries.filter((e) => !e.done && e.files.some((f) => want.includes(f)));
  if (busy.length === 0) {
    console.log(`  ✓ 没有未完成条目占用：${want.join(', ') || '(未指定文件)'}`);
  } else {
    console.log(`  ⚠️ 以下未完成条目正占用这些文件：`);
    for (const b of busy) console.log(`     · ${b.who} | ${b.task} | ${b.files.filter((f) => want.includes(f)).join(', ')}`);
    process.exitCode = 1;
  }
} else {
  const { entries } = readEntries();
  const open = entries.filter((e) => !e.done);
  console.log(`  看板：${entries.length} 条记录，未完成 ${open.length} 条${fs.existsSync(LOG) ? '' : '（WORKLOG.md 还没建）'}`);
  for (const e of entries.slice(-20)) {
    console.log(`   ${e.done ? '✅' : '⏳'} ${e.at} | ${e.who} | ${e.task}${e.files.length ? ` | ${e.files.join(', ')}` : ''}`);
  }
}
