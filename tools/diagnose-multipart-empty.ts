/**
 * 诊断「多分P 投稿为什么说没有任何可投稿的文件」。
 *
 * 背景：30 分钟真实录播跑完后，6 个切片**全部切片成功**（台账 status=CUT、cutOutput 存在、
 * 文件在磁盘上），但 `publishAsMultiPart` 报「没有任何可投稿的文件（完整版与切片都不可用）」。
 * 也就是说：`parts` 数组是空的。
 *
 * 本工具不走 Orchestrator，直接把**真实台账里的切片**喂给 `publishAsMultiPart`，
 * 复现它的 parts 构造过程，把每一步的判定都打出来。
 *
 * 只读（dryRun=true，不会真的投稿）。
 *
 * 用法：node --experimental-strip-types tools/diagnose-multipart-empty.ts <taskId>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { Ledger } from '../src/ledger.ts';
import { Publisher } from '../src/publish.ts';
import { log as globalLog } from '../src/logger.ts';

const taskId = process.argv[2];
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/diagnose-multipart-empty.ts <taskId>');
  process.exit(1);
}
const line = (s = ''): void => console.log(s);

const cfg = loadConfig('config.json').config;
const ledger = new Ledger({ path: path.join('data', 'ledger.json'), logger: globalLog });
const task = ledger.getTask(taskId);
if (!task) {
  console.error(`任务不存在：${taskId}`);
  process.exit(1);
}

line('='.repeat(94));
line(`诊断多分P 投稿：${taskId}`);
line('='.repeat(94));
line(`  task.title = ${task.title}`);
line(`  task.status = ${task.status}`);
line(`  source.fullVideoPath = ${JSON.stringify(task.source.fullVideoPath)}`);
line('');

/* ---- 完全复刻 publishMultiPartStage 的 selected 取法 ---- */
const clips = ledger.getClips(taskId);
const selected = clips.filter((c) => c.selected && c.status !== 'SKIPPED').sort((a, b) => a.start - b.start);
line(`  clips=${clips.length}  selected=${selected.length}`);
line('');
line('  逐个切片（这就是传给 publishAsMultiPart 的 clips）：');
for (const c of selected) {
  const out = c.cutOutput;
  const ok = out ? fs.existsSync(out) : false;
  line(
    `    #${String(c.index).padStart(2)} status=${String(c.status).padEnd(10)} ` +
      `cutOutput=${out ? path.basename(out) : '\x1b[31m(无)\x1b[0m'} ${out ? (ok ? '✓存在' : '\x1b[31m✗文件不存在\x1b[0m') : ''}`,
  );
}
line('');

/* ---- 复刻 publishAsMultiPart 的 parts 构造 ---- */
line('  复刻 publishAsMultiPart 的 parts 构造：');
const parts: Array<{ kind: string; file: string }> = [];
const fullPath = task.source.fullVideoPath;
if (fullPath && fs.existsSync(fullPath)) {
  parts.push({ kind: 'full', file: fullPath });
  line(`    + full  ← ${path.basename(fullPath)}`);
} else {
  line(`    - 没有完整版（source.fullVideoPath ${fullPath ? '存在但文件不在' : '为空'}）`);
}
const fullDir = path.join(ledger.taskDir(taskId), 'full');
const findInFull = (kw: string): string | undefined => {
  if (!fs.existsSync(fullDir)) return undefined;
  const f = fs.readdirSync(fullDir).find((n) => n.toLowerCase().includes(kw) && n.endsWith('.mp4'));
  return f ? path.join(fullDir, f) : undefined;
};
const pure = findInFull('p2') ?? findInFull('pure');
if (pure) {
  parts.push({ kind: 'pure', file: pure });
  line(`    + pure  ← ${path.basename(pure)}`);
} else {
  line(`    - 没有纯享版（${fullDir} ${fs.existsSync(fullDir) ? '里的文件：' + fs.readdirSync(fullDir).join(', ') : '目录不存在'}）`);
}
for (const c of selected) {
  const file = c.cutOutput;
  if (!file || !fs.existsSync(file)) {
    line(`    - 切片 #${c.index} 被排除：${file ? '文件不存在 → ' + file : '没有 cutOutput'}`);
    continue;
  }
  parts.push({ kind: 'clip', file });
  line(`    + clip#${c.index} ← ${path.basename(file)}`);
}
line('');
line(`  ⇒ parts 共 ${parts.length} 个：${parts.map((p) => p.kind).join(', ') || '(空)'}`);
line('');

if (parts.length === 0) {
  line('  \x1b[31m结论：parts 为空 ⇒ publishAsMultiPart 必然报"没有任何可投稿的文件"\x1b[0m');
  line('  上面逐条列出了每个分P 被排除的原因，据此定位。');
  process.exit(0);
}

/* ---- parts 非空：说明当前状态已可投，跑一次 dryRun 确认 ---- */
line('  parts 非空。用 dryRun 走一次真实 publishAsMultiPart（不投稿）：');
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });
const publisher = new Publisher({ client, config: cfg, ledger, logger: globalLog });
let uid: number | string = '';
try {
  const u = await client.primaryUid();
  if (u) uid = u.uid;
} catch {
  /* ignore */
}
const res = await publisher.publishAsMultiPart({
  task,
  uid,
  clips: selected,
  dryRun: true,
  logger: globalLog,
});
line('');
line(`  ok=${String(res.ok)} mode=${String(res.mode)} parts=${res.parts.length} skipped=${String(res.skipped)}`);
line(`  warnings: ${res.warnings.join(' | ').slice(0, 300)}`);
line(`  error: ${String(res.error ?? '(无)').slice(0, 200)}`);
line('');
