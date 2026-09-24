/**
 * 投稿体检报告（CLI）：把某场直播的投稿批次、重复项、bvid 可信度、标题硬伤一次打出来。
 *
 * 用法：
 *   node tools/publish-audit.ts [taskId]            只做本地分析
 *   node tools/publish-audit.ts [taskId] --remote   额外去 B站 核对 bvid 可见性与线上标题
 */
import { Ledger } from '../src/ledger.ts';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { auditPublish, renderPublishAudit } from '../src/publish-audit.ts';
import { log } from '../src/logger.ts';

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const taskIdArg = args.find((a) => !a.startsWith('--'));

const ledger = new Ledger();
const cfg = loadConfig().config;
const taskId = taskIdArg ?? ledger.listTasks({ limit: 50 })[0]?.id;
if (!taskId) {
  console.log('没有任务');
  process.exit(1);
}
const task = ledger.getTask(taskId);
if (!task) {
  console.log(`任务不存在：${taskId}`);
  process.exit(1);
}

const client = remote ? BiliLiveClient.fromConfig(cfg, log) : undefined;
const report = await auditPublish(task, ledger, cfg, { ...(client ? { client } : {}) });

console.log('\x1b[1m投稿体检\x1b[0m');
console.log('─'.repeat(96));
console.log(renderPublishAudit(report));

if (report.titles.errors.length || report.titles.warnings.length) {
  console.log('\n标题逐条：');
  for (const t of report.titles.finalTitles) {
    const errs = report.titles.errors.filter((e) => e.index === t.index);
    const warns = report.titles.warnings.filter((w) => w.index === t.index);
    const mark = errs.length ? '\x1b[31m✗\x1b[0m' : warns.length ? '\x1b[33m!\x1b[0m' : '\x1b[32m✓\x1b[0m';
    console.log(`  ${mark} #${t.index}  ${[...t.title].length}/80  ${t.title}`);
    if (t.finalTitle !== t.title) console.log(`        提交时会变成：${t.finalTitle}`);
    for (const e of errs) console.log(`        \x1b[31m必须修：${e.problem.message}\x1b[0m`);
    for (const w of warns) console.log(`        \x1b[33m建议看：${w.problem.message}\x1b[0m`);
  }
}

if (report.archives.checked.length) {
  console.log('\nB站 侧可见性：');
  for (const c of report.archives.checked) {
    console.log(`  ${c.visible ? '\x1b[32m可见\x1b[0m' : '\x1b[33m不可见\x1b[0m'}  ${c.bvid}  ${c.title ?? ''}  ${c.note ?? ''}`);
  }
}

process.exitCode = report.verdict.level === 'bad' ? 1 : 0;
